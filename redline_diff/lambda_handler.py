"""Comparison Lambda, triggered by SQS with batch size 1 (one job per invocation).

Runs outside the VPC and talks to S3 and DynamoDB directly. Every error is
recorded on the job, so the message is never retried for a bad PDF; only a
timeout or crash makes SQS deliver it again.
"""
import json
import logging
import os

from .jobs import run_job
from .storage import S3Storage
from .store import DynamoJobStore

logging.getLogger().setLevel(logging.INFO)
_region = os.environ.get('AWS_REGION', '')
store = DynamoJobStore(os.environ.get('REDLINE_TABLE', ''), _region)
storage = S3Storage(os.environ.get('REDLINE_BUCKET', ''), _region)


def handler(event, context):
    outcomes = []
    for record in event.get('Records', []):
        message = json.loads(record['body'])
        outcome = run_job(store, storage, message['user_id'], message['job_id'])
        logging.info('job %s: %s', message['job_id'], outcome)
        outcomes.append(outcome)
    return {'outcomes': outcomes}
