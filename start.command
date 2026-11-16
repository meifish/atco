#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
fi
if [ ! -f node_modules/pdfjs-dist/build/pdf.mjs ]; then
  npm ci --omit=dev
fi
exec .venv/bin/python server.py
