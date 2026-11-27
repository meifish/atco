"""Comparison job runner shared by the Lambda worker and local mode."""
from concurrent.futures import ThreadPoolExecutor
import json
import logging

from .storage import job_key

log = logging.getLogger(__name__)

PARSE_ERROR = '無法解析此 PDF。檔案可能損壞或包含不支援的內容，請重新匯出後再試。'
MEMORY_ERROR = '比對所需記憶體超過上限，請拆分檔案或聯絡管理員調整設定。'


def run_job(store, storage, user_id, job_id, compare=None):
    """Run one job. Returns 'done', 'failed' or 'discarded' (cancelled / gone / duplicate)."""
    if compare is None:
        from compare import compare
    if not store.start_job(user_id, job_id):
        log.info('job %s is not pending; discarded', job_id)
        return 'discarded'
    job = store.get_job(user_id, job_id)
    if not job:
        return 'discarded'
    started = job['started_at']

    def fail(message):
        store.finish_job(user_id, job_id, 'failed', error=message, expect_started_at=started)
        return 'failed'

    try:
        result = compare(storage.read(job['before_key']), storage.read(job['after_key']))
        data = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()
    except ValueError as error:
        return fail(str(error))
    except MemoryError:
        log.exception('job %s ran out of memory', job_id)
        return fail(MEMORY_ERROR)
    except Exception:
        log.exception('job %s failed', job_id)
        return fail(PARSE_ERROR)

    # The user may have logged out while we were comparing: then the job is
    # cancelled (or already deleted) and the result must not be stored.
    current = store.get_job(user_id, job_id)
    if not current or current['status'] != 'running' or current.get('started_at') != started:
        log.info('job %s was cancelled; result discarded', job_id)
        return 'discarded'
    key = job_key(user_id, job_id, 'result.json')
    storage.put(key, data, 'application/json')
    if not store.finish_job(user_id, job_id, 'done', result_key=key, expect_started_at=started):
        storage.delete(key)  # cancelled between the check and the write
        log.info('job %s was cancelled; result discarded', job_id)
        return 'discarded'
    return 'done'


class SqsQueue:
    def __init__(self, queue_url, region, client=None):
        import boto3
        self.queue_url = queue_url
        self.client = client or boto3.client('sqs', region_name=region)

    def send(self, user_id, job_id):
        self.client.send_message(QueueUrl=self.queue_url,
                                 MessageBody=json.dumps({'user_id': user_id, 'job_id': job_id}))


class LocalQueue:
    """Runs jobs on background threads in this process (local mode)."""

    def __init__(self, store, storage, workers=2):
        self.store, self.storage = store, storage
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='atco-job')

    def send(self, user_id, job_id):
        return self.pool.submit(run_job, self.store, self.storage, user_id, job_id)
