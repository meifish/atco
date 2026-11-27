"""Job state: pending -> running -> done | failed, and cancelled on logout.

Items are keyed by (user id, "JOB#<job id>"), so a user can only ever address
their own jobs. "LATEST" points at the user's most recent job for refresh
restore. Every item carries a 24 h TTL as a fallback; logout deletes them first.
"""
import copy
import threading
import time

from .config import DATA_TTL_SECONDS

ACTIVE = ('pending', 'running')
LATEST = 'LATEST'


def job_sk(job_id):
    return 'JOB#' + job_id


def _public(item):
    if item is None:
        return None
    job = {k: v for k, v in item.items() if k not in ('pk', 'sk')}
    job['job_id'] = item['sk'][4:]
    for key in ('created_at', 'started_at', 'finished_at', 'attempts', 'expires_at'):
        if key in job:
            job[key] = int(job[key])
    return job


class MemoryJobStore:
    """In-process store for local mode and tests, same semantics as DynamoDB."""

    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def _get(self, user_id, sk, now=None):
        item = self.items.get((user_id, sk))
        if item and item['expires_at'] < (now or time.time()):
            return None
        return item

    def create_job(self, user_id, job_id, before_key, after_key, filenames, now=None):
        now = int(now or time.time())
        with self.lock:
            if (user_id, job_sk(job_id)) in self.items:
                return False
            self.items[(user_id, job_sk(job_id))] = {
                'pk': user_id, 'sk': job_sk(job_id), 'status': 'pending',
                'before_key': before_key, 'after_key': after_key, 'filenames': dict(filenames),
                'created_at': now, 'attempts': 0, 'expires_at': now + DATA_TTL_SECONDS}
            self.items[(user_id, LATEST)] = {'pk': user_id, 'sk': LATEST, 'job_id': job_id,
                                             'expires_at': now + DATA_TTL_SECONDS}
            return True

    def get_job(self, user_id, job_id):
        with self.lock:
            return _public(copy.deepcopy(self._get(user_id, job_sk(job_id))))

    def latest_job_id(self, user_id):
        with self.lock:
            item = self._get(user_id, LATEST)
            return item and item['job_id']

    def start_job(self, user_id, job_id, now=None):
        now = int(now or time.time())
        with self.lock:
            item = self._get(user_id, job_sk(job_id), now)
            if not item or item['status'] not in ACTIVE:
                return False
            item.update(status='running', started_at=now, attempts=item['attempts'] + 1)
            return True

    def finish_job(self, user_id, job_id, status, result_key=None, error=None,
                   expect_started_at=None, now=None):
        now = int(now or time.time())
        with self.lock:
            item = self._get(user_id, job_sk(job_id), now)
            if not item or item['status'] != 'running':
                return False
            if expect_started_at is not None and item.get('started_at') != expect_started_at:
                return False
            item.update(status=status, finished_at=now)
            if result_key:
                item['result_key'] = result_key
            if error:
                item['error'] = error
            return True

    def cancel_and_delete_user(self, user_id):
        with self.lock:
            keys = [k for k in self.items if k[0] == user_id]
            for key in keys:  # cancelled first, so a running worker sees it either way
                if self.items[key].get('status') in ACTIVE:
                    self.items[key]['status'] = 'cancelled'
            for key in keys:
                del self.items[key]
            return len(keys)


class DynamoJobStore:
    def __init__(self, table_name, region, client=None):
        import boto3
        self.table_name = table_name
        self.client = client or boto3.client('dynamodb', region_name=region)
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
        self._ser, self._de = TypeSerializer(), TypeDeserializer()

    def _item(self, values):
        return {k: self._ser.serialize(v) for k, v in values.items()}

    def _load(self, raw, now=None):
        if not raw:
            return None
        item = {k: self._de.deserialize(v) for k, v in raw.items()}
        if int(item.get('expires_at', 0)) < (now or time.time()):
            return None  # DynamoDB TTL deletion is lazy; hide expired items
        return item

    def _key(self, user_id, sk):
        return {'pk': {'S': user_id}, 'sk': {'S': sk}}

    def _conditional(self, **kwargs):
        try:
            self.client.update_item(TableName=self.table_name, **kwargs)
            return True
        except self.client.exceptions.ConditionalCheckFailedException:
            return False

    def create_job(self, user_id, job_id, before_key, after_key, filenames, now=None):
        now = int(now or time.time())
        expires = now + DATA_TTL_SECONDS
        job = {'pk': user_id, 'sk': job_sk(job_id), 'status': 'pending',
               'before_key': before_key, 'after_key': after_key, 'filenames': dict(filenames),
               'created_at': now, 'attempts': 0, 'expires_at': expires}
        try:
            self.client.put_item(TableName=self.table_name, Item=self._item(job),
                                 ConditionExpression='attribute_not_exists(pk)')
        except self.client.exceptions.ConditionalCheckFailedException:
            return False
        self.client.put_item(TableName=self.table_name, Item=self._item(
            {'pk': user_id, 'sk': LATEST, 'job_id': job_id, 'expires_at': expires}))
        return True

    def get_job(self, user_id, job_id):
        raw = self.client.get_item(TableName=self.table_name, Key=self._key(user_id, job_sk(job_id)),
                                   ConsistentRead=True).get('Item')
        return _public(self._load(raw))

    def latest_job_id(self, user_id):
        raw = self.client.get_item(TableName=self.table_name, Key=self._key(user_id, LATEST),
                                   ConsistentRead=True).get('Item')
        item = self._load(raw)
        return item and item['job_id']

    def start_job(self, user_id, job_id, now=None):
        now = int(now or time.time())
        return self._conditional(
            Key=self._key(user_id, job_sk(job_id)),
            UpdateExpression='SET #s = :running, started_at = :now ADD attempts :one',
            ConditionExpression='attribute_exists(pk) AND #s IN (:pending, :running) AND expires_at > :now',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':running': {'S': 'running'}, ':pending': {'S': 'pending'},
                                       ':now': {'N': str(now)}, ':one': {'N': '1'}})

    def finish_job(self, user_id, job_id, status, result_key=None, error=None,
                   expect_started_at=None, now=None):
        now = int(now or time.time())
        sets = ['#s = :status', 'finished_at = :now']
        values = {':status': {'S': status}, ':running': {'S': 'running'}, ':now': {'N': str(now)}}
        condition = 'attribute_exists(pk) AND #s = :running'
        if result_key:
            sets.append('result_key = :result')
            values[':result'] = {'S': result_key}
        if error:
            sets.append('#e = :error')
            values[':error'] = {'S': error}
        if expect_started_at is not None:
            condition += ' AND started_at = :started'
            values[':started'] = {'N': str(expect_started_at)}
        names = {'#s': 'status'}
        if error:
            names['#e'] = 'error'
        return self._conditional(
            Key=self._key(user_id, job_sk(job_id)), UpdateExpression='SET ' + ', '.join(sets),
            ConditionExpression=condition, ExpressionAttributeNames=names,
            ExpressionAttributeValues=values)

    def _user_keys(self, user_id):
        keys, start = [], None
        while True:
            kwargs = {'TableName': self.table_name, 'KeyConditionExpression': 'pk = :pk',
                      'ExpressionAttributeValues': {':pk': {'S': user_id}},
                      'ProjectionExpression': 'pk, sk, #s', 'ExpressionAttributeNames': {'#s': 'status'}}
            if start:
                kwargs['ExclusiveStartKey'] = start
            page = self.client.query(**kwargs)
            keys += page['Items']
            start = page.get('LastEvaluatedKey')
            if not start:
                return keys

    def cancel_and_delete_user(self, user_id):
        items = self._user_keys(user_id)
        for item in items:
            if item.get('status', {}).get('S') in ACTIVE:
                self._conditional(
                    Key={'pk': item['pk'], 'sk': item['sk']}, UpdateExpression='SET #s = :cancelled',
                    ConditionExpression='#s IN (:pending, :running)',
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':cancelled': {'S': 'cancelled'},
                                               ':pending': {'S': 'pending'}, ':running': {'S': 'running'}})
        for i in range(0, len(items), 25):
            requests = [{'DeleteRequest': {'Key': {'pk': it['pk'], 'sk': it['sk']}}} for it in items[i:i + 25]]
            pending = {self.table_name: requests}
            while pending:
                pending = self.client.batch_write_item(RequestItems=pending).get('UnprocessedItems') or None
        return len(items)
