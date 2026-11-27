"""Web API, job runner, logout cleanup and Cognito token checks (no AWS needed)."""
import io
import json
import os
import tempfile
import time
import unittest
from unittest import mock

import boto3
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from moto import mock_aws
from reportlab.pdfgen import canvas

from atco_service.app import create_app
from atco_service.auth import AuthError, CognitoVerifier
from atco_service.config import Settings
from atco_service.jobs import run_job
from atco_service.storage import LocalStorage, S3Storage, job_key
from atco_service.store import DynamoJobStore, MemoryJobStore


def pdf(text):
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=(300, 200))
    c.drawString(20, 170, text)
    c.showPage()
    c.save()
    return out.getvalue()


class InlineQueue:
    """Records jobs; tests decide when the worker runs."""

    def __init__(self):
        self.sent = []

    def send(self, user_id, job_id):
        self.sent.append((user_id, job_id))


class LocalApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store, self.storage, self.queue = MemoryJobStore(), LocalStorage(self.dir.name), InlineQueue()
        self.app = create_app(Settings(mode='local'), self.store, self.storage, self.queue)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.dir.cleanup()

    def upload(self, before=None, after=None):
        response = self.client.post('/api/uploads')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        for side, content in (('before', before or pdf('hello')), ('after', after or pdf('hallo'))):
            form = data['uploads'][side]
            r = self.client.post(form['url'], data=form['fields'],
                                 files={'file': (side + '.pdf', content, 'application/pdf')})
            self.assertEqual(r.status_code, 204, r.text)
        return data['job_id']

    def start(self, **kwargs):
        job_id = self.upload(**kwargs)
        r = self.client.post('/api/jobs', json={'job_id': job_id, 'filenames': {'before': 'a.pdf', 'after': 'b.pdf'}})
        self.assertEqual(r.status_code, 202, r.text)
        return job_id

    def work(self):
        return [run_job(self.store, self.storage, *job) for job in self.queue.sent]

    def test_full_flow_and_restore(self):
        job_id = self.start()
        self.assertEqual(self.client.get(f'/api/jobs/{job_id}').json()['status'], 'pending')
        self.assertEqual(self.work(), ['done'])
        job = self.client.get(f'/api/jobs/{job_id}').json()
        self.assertEqual(job['status'], 'done')
        self.assertEqual(job['filenames'], {'before': 'a.pdf', 'after': 'b.pdf'})
        result = self.client.get(job['result_url']).json()
        self.assertTrue(any(o.get('text') == 'hallo' for o in result['pages'][0]['after']['changes']))
        self.assertEqual(self.client.get(job['before_url']).content[:5], b'%PDF-')
        self.assertEqual(self.client.get('/api/me/last-result').json()['job_id'], job_id)

    def test_rejects_missing_and_invalid_files(self):
        job_id = self.client.post('/api/uploads').json()['job_id']
        self.assertEqual(self.client.post('/api/jobs', json={'job_id': job_id}).status_code, 400)
        self.assertEqual(self.client.post('/api/jobs', json={'job_id': '../x'}).status_code, 400)
        job_id = self.upload(before=b'not a pdf at all')
        r = self.client.post('/api/jobs', json={'job_id': job_id})
        self.assertEqual(r.status_code, 400)
        self.assertIn('PDF', r.json()['error'])

    def test_upload_url_is_signed(self):
        form = self.client.post('/api/uploads').json()['uploads']['before']
        fields = dict(form['fields'], key='users/someone-else/x/before.pdf')
        r = self.client.post(form['url'], data=fields, files={'file': ('a.pdf', pdf('x'), 'application/pdf')})
        self.assertEqual(r.status_code, 403)

    def test_bad_pdf_marks_job_failed(self):
        job_id = self.start(before=b'%PDF-1.4 broken')
        self.assertEqual(self.work(), ['failed'])
        job = self.client.get(f'/api/jobs/{job_id}').json()
        self.assertEqual(job['status'], 'failed')
        self.assertTrue(job['error'])
        self.assertNotIn('result_url', job)

    def test_logout_deletes_everything(self):
        job_id = self.start()
        self.work()
        self.assertEqual(self.client.post('/api/logout').status_code, 204)
        self.assertEqual(self.client.get(f'/api/jobs/{job_id}').status_code, 404)
        self.assertEqual(self.client.get('/api/me/last-result').status_code, 204)
        self.assertFalse(any(p.is_file() for p in (self.storage.root / 'users').rglob('*')))

    def test_logout_while_running_discards_result(self):
        job_id = self.start()

        def compare_then_logout(before, after):
            self.client.post('/api/logout')  # user logs out mid-comparison
            return {'pages': []}

        self.assertEqual(run_job(self.store, self.storage, 'local', job_id, compare=compare_then_logout), 'discarded')
        self.assertIsNone(self.storage.size(job_key('local', job_id, 'result.json')))
        self.assertIsNone(self.store.get_job('local', job_id))

    def test_duplicate_delivery_runs_once(self):
        job_id = self.start()
        self.work()
        self.assertEqual(run_job(self.store, self.storage, 'local', job_id), 'discarded')

    def test_stale_running_job_reports_failure(self):
        job_id = self.start()
        self.store.start_job('local', job_id, now=time.time() - 2000)
        job = self.client.get(f'/api/jobs/{job_id}').json()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(run_job(self.store, self.storage, 'local', job_id), 'discarded')

    def test_static_and_config(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/auth.js').status_code, 200)
        self.assertIsNone(self.client.get('/api/config').json()['auth'])
        self.assertEqual(self.client.get('/pdfjs/build/..%2F..%2Fpackage.json').status_code, 404)
        r = self.client.post('/api/uploads', headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(r.status_code, 403)


class FakeJwks:
    def __init__(self, key):
        self.key = key

    def get_signing_key_from_jwt(self, token):
        return mock.Mock(key=self.key)


class CognitoTests(unittest.TestCase):
    def setUp(self):
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.verifier = CognitoVerifier('ca-central-1', 'pool', 'client', jwks_client=FakeJwks(self.private.public_key()))
        self.iss = 'https://cognito-idp.ca-central-1.amazonaws.com/pool'

    def token(self, **overrides):
        now = int(time.time())
        claims = {'sub': 'a1b2c3d4-0000-1111-2222-333344445555', 'iss': self.iss, 'token_use': 'access',
                  'client_id': 'client', 'iat': now, 'exp': now + 3600, 'username': 'a1b2'}
        claims.update(overrides)
        return 'Bearer ' + jwt.encode(claims, self.private, algorithm='RS256')

    def test_valid_access_token(self):
        self.assertEqual(self.verifier.verify(self.token()).id, 'a1b2c3d4-0000-1111-2222-333344445555')

    def test_rejections(self):
        for bad in (self.token(exp=int(time.time()) - 120), self.token(token_use='id'),
                    self.token(client_id='other'), self.token(iss='https://evil'), self.token(sub='../x'),
                    None, 'Bearer junk'):
            with self.assertRaises(AuthError):
                self.verifier.verify(bad)

    def test_api_requires_token_in_aws_mode(self):
        settings = Settings(mode='aws', cognito_domain='https://x.auth', cognito_client_id='client',
                            site_url='https://inceptionai.example.ts.net')
        client = TestClient(create_app(settings, MemoryJobStore(), LocalStorage(tempfile.mkdtemp()),
                                       InlineQueue(), self.verifier))
        self.assertEqual(client.post('/api/uploads').status_code, 401)
        self.assertEqual(client.post('/api/uploads', headers={'Authorization': self.token()}).status_code, 200)
        self.assertEqual(client.get('/api/config').json()['auth']['redirectUri'], 'https://inceptionai.example.ts.net/')


@mock_aws
class AwsBackendTests(unittest.TestCase):
    def setUp(self):
        os.environ.update(AWS_ACCESS_KEY_ID='x', AWS_SECRET_ACCESS_KEY='x', AWS_DEFAULT_REGION='ca-central-1')
        region = 'ca-central-1'
        s3 = boto3.client('s3', region_name=region)
        s3.create_bucket(Bucket='atco-test', CreateBucketConfiguration={'LocationConstraint': region})
        ddb = boto3.client('dynamodb', region_name=region)
        ddb.create_table(TableName='atco-test', BillingMode='PAY_PER_REQUEST',
                         KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                         AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                               {'AttributeName': 'sk', 'AttributeType': 'S'}])
        self.store = DynamoJobStore('atco-test', region)
        self.storage = S3Storage('atco-test', region)

    def test_job_lifecycle_and_logout(self):
        user, job_id = 'u1', 'a' * 32
        keys = {side: job_key(user, job_id, side + '.pdf') for side in ('before', 'after')}
        self.storage.put(keys['before'], pdf('hello'), 'application/pdf')
        self.storage.put(keys['after'], pdf('hallo'), 'application/pdf')
        self.assertTrue(self.store.create_job(user, job_id, keys['before'], keys['after'], {'before': 'a', 'after': 'b'}))
        self.assertFalse(self.store.create_job(user, job_id, keys['before'], keys['after'], {}))
        self.assertEqual(self.store.latest_job_id(user), job_id)
        self.assertEqual(run_job(self.store, self.storage, user, job_id), 'done')
        job = self.store.get_job(user, job_id)
        self.assertEqual((job['status'], job['attempts']), ('done', 1))
        self.assertIn('"pages"', self.storage.read(job['result_key']).decode())
        self.assertIsNone(self.store.get_job('someone-else', job_id))
        self.assertIn('X-Amz-Signature', self.storage.download_url(job['result_key']))
        form = self.storage.upload_form(keys['before'], 10)
        self.assertIn('policy', form['fields'])

        self.assertEqual(self.store.cancel_and_delete_user(user), 2)
        self.assertEqual(self.storage.delete_prefix(f'users/{user}/'), 3)
        self.assertIsNone(self.store.get_job(user, job_id))
        self.assertIsNone(self.storage.size(keys['before']))

    def test_cancelled_job_is_not_started(self):
        user, job_id = 'u2', 'b' * 32
        self.store.create_job(user, job_id, 'k1', 'k2', {})
        self.store.cancel_and_delete_user(user)
        self.assertFalse(self.store.start_job(user, job_id))

    def test_lambda_handler(self):
        user, job_id = 'u3', 'c' * 32
        keys = [job_key(user, job_id, n) for n in ('before.pdf', 'after.pdf')]
        for key in keys:
            self.storage.put(key, pdf('same'), 'application/pdf')
        self.store.create_job(user, job_id, *keys, {})
        with mock.patch.dict(os.environ, {'ATCO_TABLE': 'atco-test', 'ATCO_BUCKET': 'atco-test',
                                          'AWS_REGION': 'ca-central-1'}):
            import importlib
            import atco_service.lambda_handler as handler
            importlib.reload(handler)
            out = handler.handler({'Records': [{'body': json.dumps({'user_id': user, 'job_id': job_id})}]}, None)
        self.assertEqual(out, {'outcomes': ['done']})


if __name__ == '__main__':
    unittest.main()
