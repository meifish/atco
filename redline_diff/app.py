"""FastAPI web service: static site, job API, and (local mode) file storage.

Run in AWS:   uvicorn --factory redline_diff.app:create_app --host 0.0.0.0 --port 8000
Run locally:  python server.py
"""
import logging
from pathlib import Path
import re
import time
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .auth import AuthError, CognitoVerifier, LocalVerifier
from .config import MAX_PAGES, MAX_TOTAL_BYTES, load_settings
from .jobs import LocalQueue, SqsQueue
from .storage import LocalStorage, S3Storage, job_key, user_prefix
from .store import DynamoJobStore, MemoryJobStore

log = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / 'static'
PDFJS = ROOT / 'node_modules' / 'pdfjs-dist'
PDFJS_ASSETS = {
    'build': {'.mjs': 'text/javascript; charset=utf-8'},
    'cmaps': {'.bcmap': 'application/octet-stream'},
    'iccs': {'.icc': 'application/octet-stream'},
    'standard_fonts': {'.pfb': 'application/octet-stream', '.ttf': 'application/octet-stream'},
    'wasm': {'.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8',
             '.js': 'text/javascript; charset=utf-8'},
}
STATIC_ROUTES = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/auth.js': ('auth.js', 'text/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
    '/viewer.mjs': ('viewer.mjs', 'text/javascript; charset=utf-8'),
    '/viewer-layout.mjs': ('viewer-layout.mjs', 'text/javascript; charset=utf-8'),
}
JOB_ID = re.compile(r'^[0-9a-f]{32}$')
PENDING_STALE_SECONDS = 3600
SIDES = ('before', 'after')


def error(status, message):
    return JSONResponse({'error': message}, status_code=status)


def create_app(settings=None, store=None, storage=None, queue=None, verifier=None):
    settings = settings or load_settings()
    if settings.aws:
        store = store or DynamoJobStore(settings.table, settings.region)
        storage = storage or S3Storage(settings.bucket, settings.region,
                                       upload_seconds=settings.upload_url_seconds,
                                       download_seconds=settings.download_url_seconds)
        queue = queue or SqsQueue(settings.queue_url, settings.region)
        verifier = verifier or CognitoVerifier(settings.region, settings.cognito_user_pool_id,
                                               settings.cognito_client_id)
    else:
        store = store or MemoryJobStore()
        storage = storage or LocalStorage(settings.local_dir or None)
        queue = queue or LocalQueue(store, storage)
        verifier = verifier or LocalVerifier()

    app = FastAPI(title='Redline Diff', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.storage, app.state.queue = store, storage, queue

    @app.middleware('http')
    async def headers(request: Request, call_next):
        if request.method == 'POST' and request.headers.get('sec-fetch-site') == 'cross-site':
            return error(403, '不允許跨站請求。')
        response = await call_next(request)
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        return response

    def current_user(request: Request):
        try:
            return verifier.verify(request.headers.get('authorization'))
        except AuthError:
            raise HTTPException(401, '登入已過期，請重新登入。')

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error(exc.status_code, exc.detail if isinstance(exc.detail, str) else '請求失敗')

    # ---- static site -------------------------------------------------------
    def static_route(path, name, kind):
        async def serve():
            return FileResponse(STATIC / name, media_type=kind)
        app.add_api_route(path, serve, methods=['GET'], include_in_schema=False)

    for path, (name, kind) in STATIC_ROUTES.items():
        static_route(path, name, kind)

    @app.get('/pdfjs/{directory}/{name}', include_in_schema=False)
    async def pdfjs(directory: str, name: str):
        kind = PDFJS_ASSETS.get(directory, {}).get(Path(name).suffix)
        asset = PDFJS / directory / name
        if not kind or '/' in name or name.startswith('.') or not asset.is_file():
            return Response('Not found', status_code=404, media_type='text/plain')
        return FileResponse(asset, media_type=kind)

    @app.get('/healthz', include_in_schema=False)
    async def health():
        return {'ok': True}

    # ---- API ---------------------------------------------------------------
    @app.get('/api/config')
    async def config():
        auth = None
        if settings.aws:
            auth = {'domain': settings.cognito_domain, 'clientId': settings.cognito_client_id,
                    'redirectUri': settings.site_url + '/', 'logoutUri': settings.site_url + '/',
                    'scopes': 'openid email profile'}
        return {'mode': settings.mode, 'auth': auth,
                'limits': {'maxPages': MAX_PAGES, 'maxTotalBytes': MAX_TOTAL_BYTES}}

    @app.post('/api/uploads')
    def create_uploads(user=Depends(current_user)):
        job_id = uuid.uuid4().hex
        return {'job_id': job_id, 'uploads': {
            side: storage.upload_form(job_key(user.id, job_id, side + '.pdf'), MAX_TOTAL_BYTES)
            for side in SIDES}}

    @app.post('/api/jobs', status_code=202)
    async def create_job(request: Request, user=Depends(current_user)):
        try:
            body = await request.json()
            job_id = body['job_id']
            names = body.get('filenames') or {}
            filenames = {side: str(names.get(side) or side + '.pdf')[:255] for side in SIDES}
        except Exception:
            return error(400, '請求格式錯誤。')
        if not isinstance(job_id, str) or not JOB_ID.match(job_id):
            return error(400, '請求格式錯誤。')
        keys = {side: job_key(user.id, job_id, side + '.pdf') for side in SIDES}
        sizes = [storage.size(keys[side]) for side in SIDES]
        if not all(sizes):
            return error(400, '請先上傳兩份 PDF。')
        if sum(sizes) > MAX_TOTAL_BYTES:
            return error(400, '請選擇兩份 PDF，合計大小不可超過 80 MB。')
        if not all(b'%PDF-' in storage.read(keys[side], 1024) for side in SIDES):
            return error(400, '檔案格式不是有效的 PDF。')
        if not store.create_job(user.id, job_id, keys['before'], keys['after'], filenames):
            return error(409, '這個比對工作已經建立。')
        queue.send(user.id, job_id)
        return {'job_id': job_id, 'status': 'pending'}

    def job_view(user, job):
        now = time.time()
        if job['status'] == 'running' and now - job.get('started_at', now) > settings.job_stale_seconds:
            message = '比對超過執行時間或記憶體上限。請拆分檔案後再試。'
            if store.finish_job(user.id, job['job_id'], 'failed', error=message,
                                expect_started_at=job['started_at']):
                job = dict(job, status='failed', error=message)
        elif job['status'] == 'pending' and now - job['created_at'] > PENDING_STALE_SECONDS:
            job = dict(job, status='failed', error='比對工作排隊逾時，請重新送出。')
        view = {k: job.get(k) for k in ('job_id', 'status', 'error', 'filenames', 'created_at')}
        if job['status'] == 'done':
            view['result_url'] = storage.download_url(job['result_key'])
            view['before_url'] = storage.download_url(job['before_key'])
            view['after_url'] = storage.download_url(job['after_key'])
        return view

    @app.get('/api/jobs/{job_id}')
    def get_job(job_id: str, user=Depends(current_user)):
        job = JOB_ID.match(job_id) and store.get_job(user.id, job_id)
        if not job:
            return error(404, '找不到這個比對工作，可能已過期或已登出清除。')
        return job_view(user, job)

    @app.get('/api/me/last-result')
    def last_result(user=Depends(current_user)):
        job_id = store.latest_job_id(user.id)
        job = job_id and store.get_job(user.id, job_id)
        if not job:
            return Response(status_code=204)
        return job_view(user, job)

    @app.post('/api/logout', status_code=204)
    def logout(user=Depends(current_user)):
        store.cancel_and_delete_user(user.id)  # marks in-flight jobs cancelled, then deletes
        storage.delete_prefix(user_prefix(user.id))
        return Response(status_code=204)

    # ---- local-mode stand-ins for S3 presigned URLs --------------------------
    if isinstance(storage, LocalStorage):
        @app.post('/local-storage/upload', include_in_schema=False)
        async def local_upload(request: Request):
            async with request.form() as form:
                key, max_bytes = str(form.get('key', '')), str(form.get('max_bytes', '0'))
                expires, token = str(form.get('expires', '0')), str(form.get('token', ''))
                upload = form.get('file')
                if not storage.verify(token, expires, 'upload', key, max_bytes) or upload is None:
                    return error(403, '上傳網址無效或已過期。')
                data = await upload.read()
            if not 0 < len(data) <= int(max_bytes):
                return error(400, '檔案大小超過上限。')
            storage.put(key, data, 'application/pdf')
            return Response(status_code=204)

        @app.get('/local-storage/object', include_in_schema=False)
        async def local_object(key: str, expires: str, token: str):
            if not storage.verify(token, expires, 'download', key) or storage.size(key) is None:
                return error(403, '下載網址無效或已過期。')
            kind = 'application/pdf' if key.endswith('.pdf') else 'application/json'
            return FileResponse(storage._path(key), media_type=kind)

    return app
