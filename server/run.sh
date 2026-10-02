#!/bin/sh
# xiai-api · 手动启动（**已登记入 ctrl `services` 表**：sid `xiai-api` / port 5191 / group xiai，
#   由面板托管（面板优雅重启后随 `/api/startAll` 一并拉起）；本脚本仅供手动启动）
#
# 用法：  ./run.sh            # 前台运行（PID ＝ 本进程）
#         PORT=5191 ./run.sh
#
# 纪律：
#   · 绑定 **127.0.0.1**（地址族按站实测 —— 与书写形态一致；AC-156）；
#   · **不使用** `--reload`（避免 reloader 子进程 ⇒ 收尾可按精确 PID 停服务）；
#   · 端口数值仅作**本机手动启动**用；端口唯一真源仍是 ctrl/PORTS.md（本服务的登记行已落地于
#     ctrl/index.js 的 `services` 表，见上）。
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT="${XIAI_API_PORT:-5191}"
exec "$DIR/.venv/bin/python" -m uvicorn app.main:app \
  --app-dir "$DIR" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --log-level info
