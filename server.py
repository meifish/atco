"""Local mode: one user, no login, jobs on background threads, bound to 127.0.0.1.

The AWS deployment runs the same FastAPI app on ECS (see Dockerfile and infra/).
"""
import argparse
import os
import socket

import uvicorn

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    os.environ.setdefault('REDLINE_MODE', 'local')
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', args.port))
    sock.listen(128)  # accept connections as soon as the URL is printed
    print(f'Redline Diff → http://127.0.0.1:{sock.getsockname()[1]}', flush=True)
    config = uvicorn.Config('redline_diff.app:create_app', factory=True, log_level='warning')
    uvicorn.Server(config).run(sockets=[sock])
