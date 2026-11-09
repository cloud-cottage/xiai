#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# xiai-api 容器入口（P1）
#
# 职责（本阶段只做三件事，刻意保持最小）：
#   ① 定存储根：XIAI_AUTHORITY_ROOT（默认 /data/originals，P2 挂 CFS 后即挂载点）；
#   ② 建根目录（空目录可启动；读面取不到件 ⇒ 结构化 NOT_FOUND，不崩服务）；
#   ③ 起 uvicorn：**绑 0.0.0.0**、端口取 ${PORT:-5191}（云托管注入 PORT）、无 --reload。
#
# 纪律：
#   · 与 server/run.sh 同口径，唯一差异＝绑定地址（本地 127.0.0.1 / 容器 0.0.0.0）；
#   · exec ⇒ uvicorn 即 PID 1，SIGTERM 直达（优雅退出 / 不留僵尸子进程）；
#   · P2 的 COS→CFS 原件补齐**未接入**（云托管底座待立项，见 README §6）。
# ═══════════════════════════════════════════════════════════════════════════
set -eu

PORT="${PORT:-5191}"
XIAI_AUTHORITY_ROOT="${XIAI_AUTHORITY_ROOT:-/data/originals}"
XIAI_APP_DIR="${XIAI_APP_DIR:-/app/server}"
export XIAI_AUTHORITY_ROOT

mkdir -p "$XIAI_AUTHORITY_ROOT"

echo "[xiai-api] bind=0.0.0.0 port=$PORT authority_root=$XIAI_AUTHORITY_ROOT app_dir=$XIAI_APP_DIR"

# 不加 --reload：reloader 会多出一层子进程，收尾无法按精确 PID 停服务（与 run.sh 同纪律）
exec python -m uvicorn app.main:app \
  --app-dir "$XIAI_APP_DIR" \
  --host 0.0.0.0 \
  --port "$PORT" \
  --log-level info
