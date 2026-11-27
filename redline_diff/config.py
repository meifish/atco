"""Settings read from environment variables.

REDLINE_MODE=local (default) keeps everything in this process: no login, files in a
temporary folder, jobs run on a thread. REDLINE_MODE=aws uses Cognito, S3, DynamoDB
and SQS, which is how the ECS web service and the comparison Lambda run.
"""
from dataclasses import dataclass, field
import os

MAX_PAGES = 30
MAX_TOTAL_BYTES = 80 * 1024 * 1024
DATA_TTL_SECONDS = 24 * 60 * 60  # fallback cleanup; logout deletes data first


def _int(name, default):
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    mode: str = 'local'
    region: str = ''
    bucket: str = ''
    table: str = ''
    queue_url: str = ''
    cognito_user_pool_id: str = ''
    cognito_client_id: str = ''
    cognito_domain: str = ''  # https://<prefix>.auth.<region>.amazoncognito.com
    site_url: str = ''        # https://redline-diff.<tailnet>.ts.net
    # A job still "running" after this long has exceeded the Lambda limit
    # (timeout or memory) and is reported as failed.
    job_stale_seconds: int = 960
    upload_url_seconds: int = 900
    download_url_seconds: int = 3600
    local_dir: str = field(default='')

    @property
    def aws(self):
        return self.mode == 'aws'


def load_settings():
    mode = os.environ.get('REDLINE_MODE', 'local')
    if mode not in ('local', 'aws'):
        raise RuntimeError('REDLINE_MODE must be "local" or "aws"')
    settings = Settings(
        mode=mode,
        region=os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', '')),
        bucket=os.environ.get('REDLINE_BUCKET', ''),
        table=os.environ.get('REDLINE_TABLE', ''),
        queue_url=os.environ.get('REDLINE_QUEUE_URL', ''),
        cognito_user_pool_id=os.environ.get('REDLINE_COGNITO_USER_POOL_ID', ''),
        cognito_client_id=os.environ.get('REDLINE_COGNITO_CLIENT_ID', ''),
        cognito_domain=os.environ.get('REDLINE_COGNITO_DOMAIN', '').rstrip('/'),
        site_url=os.environ.get('REDLINE_SITE_URL', '').rstrip('/'),
        job_stale_seconds=_int('REDLINE_JOB_STALE_SECONDS', 960),
        local_dir=os.environ.get('REDLINE_LOCAL_DIR', ''),
    )
    if settings.aws:
        required = {
            'AWS_REGION': settings.region, 'REDLINE_BUCKET': settings.bucket,
            'REDLINE_TABLE': settings.table, 'REDLINE_QUEUE_URL': settings.queue_url,
            'REDLINE_COGNITO_USER_POOL_ID': settings.cognito_user_pool_id,
            'REDLINE_COGNITO_CLIENT_ID': settings.cognito_client_id,
            'REDLINE_COGNITO_DOMAIN': settings.cognito_domain, 'REDLINE_SITE_URL': settings.site_url,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError('Missing settings for REDLINE_MODE=aws: ' + ', '.join(missing))
    return settings
