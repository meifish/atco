#!/bin/bash
# Local mode: one user, no login, everything on this computer (http://127.0.0.1:8765).
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -q -r requirements-web.txt
if [ ! -f node_modules/pdfjs-dist/build/pdf.mjs ]; then
  npm ci --omit=dev
fi
exec .venv/bin/python server.py
