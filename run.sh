#!/usr/bin/env bash
# 本地开发启动脚本。生产用 systemd（见 deploy/foodlabel-check.service）。
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d venv ]]; then
  python3 -m venv venv
  ./venv/bin/pip install -q --upgrade pip
  ./venv/bin/pip install -q -r requirements.txt
fi

# 本地若无 foodlabel.env，从示例拷一份（记得填 LLM_API_KEY）
[[ -f foodlabel.env ]] || cp deploy/foodlabel.env.example foodlabel.env
set -a; source foodlabel.env; set +a

exec ./venv/bin/python -m uvicorn server.app:app \
  --host "${FOODLABEL_HOST:-127.0.0.1}" --port "${FOODLABEL_PORT:-8610}" --reload
