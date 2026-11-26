#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# xiai-api 容器入口（**與 `server/run.sh` 同口徑，唯一差異 ＝ 綁定地址**）
#
#   run.sh（本機手動啟動 / ctrl 面板登記）   ：--host 127.0.0.1 --port ${XIAI_API_PORT:-5191}
#   本腳本（容器 / 雲托管）                  ：--host ${HOST:-0.0.0.0} --port ${PORT:-8000}
#
# 紀律：
#   · `HOST` / `PORT` 一律從環境變量讀（雲托管注入 `PORT`；Dockerfile 已 `ENV` 兜底）；
#   · **單進程**（`--workers 1`；不加 `--reload` ⇒ 無 reloader 子進程，收尾按精確 PID）；
#   · `exec` ⇒ uvicorn 即 PID 1，SIGTERM 直達（優雅退出、不留殭屍子進程）；
#   · `XIAI_STORE_BACKEND=cos` 且缺 `COS_*` ⇒ 這裡 import 即失敗、
#     日誌直接是缺失變量名 —— **啟動即失敗，絕不靜默回落 local**。
#
# 用法（容器內；宿主側請用 `docker run -e … -p …`）：
#   HOST=0.0.0.0 PORT=8000 ./container-entrypoint.sh
# ═══════════════════════════════════════════════════════════════════════════
set -eu

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
XIAI_APP_DIR="${XIAI_APP_DIR:-/app/server}"
BACKEND="${XIAI_STORE_BACKEND:-local}"

echo "[xiai-api] bind=${HOST} port=${PORT} store_backend=${BACKEND} app_dir=${XIAI_APP_DIR}"

# 不加 --reload：reloader 會多一層子進程，收尾無法按精確 PID 停服務（與 run.sh 同紀律）
exec python -m uvicorn app.main:app \
  --app-dir "$XIAI_APP_DIR" \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1 \
  --log-level info
