"""File storage for PDFs and comparison results.

S3Storage hands the browser presigned POST / GET URLs so PDFs go straight to S3
and never pass through the web container. LocalStorage imitates that with
signed URLs served by the local FastAPI app.
"""
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
from urllib.parse import urlencode


def user_prefix(user_id):
    return f'users/{user_id}/'


def job_key(user_id, job_id, name):
    return f'{user_prefix(user_id)}{job_id}/{name}'


class S3Storage:
    def __init__(self, bucket, region, client=None, upload_seconds=900, download_seconds=3600):
        import boto3
        from botocore.config import Config
        self.bucket = bucket
        self.upload_seconds, self.download_seconds = upload_seconds, download_seconds
        # Regional virtual-hosted URLs, so browsers are not redirected (which breaks CORS).
        self.client = client or boto3.client(
            's3', region_name=region,
            config=Config(signature_version='s3v4', s3={'addressing_style': 'virtual'}))

    def upload_form(self, key, max_bytes):
        form = self.client.generate_presigned_post(
            self.bucket, key, Fields={'Content-Type': 'application/pdf'},
            Conditions=[{'Content-Type': 'application/pdf'}, ['content-length-range', 1, max_bytes]],
            ExpiresIn=self.upload_seconds)
        return {'url': form['url'], 'fields': form['fields']}

    def download_url(self, key):
        return self.client.generate_presigned_url(
            'get_object', Params={'Bucket': self.bucket, 'Key': key}, ExpiresIn=self.download_seconds)

    def size(self, key):
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)['ContentLength']
        except self.client.exceptions.ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
                return None
            raise

    def read(self, key, first_bytes=None):
        kwargs = {'Bucket': self.bucket, 'Key': key}
        if first_bytes:
            kwargs['Range'] = f'bytes=0-{first_bytes - 1}'
        return self.client.get_object(**kwargs)['Body'].read()

    def put(self, key, data, content_type):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_prefix(self, prefix):
        deleted = 0
        for page in self.client.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=prefix):
            objects = [{'Key': o['Key']} for o in page.get('Contents', [])]
            if objects:
                self.client.delete_objects(Bucket=self.bucket, Delete={'Objects': objects, 'Quiet': True})
                deleted += len(objects)
        return deleted


class LocalStorage:
    """Files in a temporary folder; URLs are signed and expire like presigned S3 URLs."""

    def __init__(self, root=None, upload_seconds=900, download_seconds=3600):
        self.root = Path(root or tempfile.mkdtemp(prefix='redline-diff-'))
        self.secret = secrets.token_bytes(32)
        self.upload_seconds, self.download_seconds = upload_seconds, download_seconds

    def _path(self, key):
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError('invalid key')
        return path

    def sign(self, *parts):
        message = '\n'.join(map(str, parts)).encode()
        return hmac.new(self.secret, message, hashlib.sha256).hexdigest()

    def verify(self, token, expires, *parts):
        return int(expires) >= time.time() and hmac.compare_digest(token, self.sign(int(expires), *parts))

    def upload_form(self, key, max_bytes):
        expires = int(time.time()) + self.upload_seconds
        return {'url': '/local-storage/upload', 'fields': {
            'key': key, 'max_bytes': str(max_bytes), 'expires': str(expires),
            'token': self.sign(expires, 'upload', key, max_bytes)}}

    def download_url(self, key):
        expires = int(time.time()) + self.download_seconds
        query = urlencode({'key': key, 'expires': expires, 'token': self.sign(expires, 'download', key)})
        return '/local-storage/object?' + query

    def size(self, key):
        path = self._path(key)
        return path.stat().st_size if path.is_file() else None

    def read(self, key, first_bytes=None):
        with self._path(key).open('rb') as f:
            return f.read(first_bytes) if first_bytes else f.read()

    def put(self, key, data, content_type=None):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + '.part')
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def delete(self, key):
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix):
        path = self._path(prefix.rstrip('/'))
        count = sum(1 for p in path.rglob('*') if p.is_file()) if path.is_dir() else 0
        shutil.rmtree(path, ignore_errors=True)
        return count
