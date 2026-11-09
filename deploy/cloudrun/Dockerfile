# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════
# xiai-api（Python / FastAPI 影像服务）容器镜像 —— CloudBase 云托管（CloudBase Run）
#
# 构建上下文 ＝ 仓库根（xiai/）；排除表单一真源 ＝ deploy/cloudrun/.dockerignore。
# 打包 / 构建请走 deploy/cloudrun/package.sh（它会把 Dockerfile 与 .dockerignore
# 放到上下文根 —— docker 只认上下文根的 .dockerignore）。
#   ./package.sh stage    # 生成 out/buildctx/
#   ./package.sh zip      # 再打 zip（控制台「本地上传」用）
#   ./package.sh build    # stage + docker build -t xiai-api:local
#
# 镜像不含 data/originals（1.2 GB 原件不进镜像；P2 上 CFS 后由挂载点提供）。
# ═══════════════════════════════════════════════════════════════════════════
FROM python:3.11-slim

# XIAI_AUTHORITY_ROOT：权威存储根（store.py 可被环境变量覆盖；容器内指向挂载点）
# PORT：云托管注入的监听端口（未注入时回落 5191）
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    XIAI_AUTHORITY_ROOT=/data/originals \
    PORT=5191

# node  ＝ 切分薄桥的运行时（server/app/slicer.py 经 subprocess 跑
#          server/tools/geom.mjs → 读同一份 src/tilesplicer/** 内核；缺 node ⇒
#          /api/tilesplicer/** 与 /api/image/slices 一律结构化 STORAGE_UNAVAILABLE）
# curl  ＝ HEALTHCHECK 与运维自测（含固定出口 IP 自测）
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── ① Python 依赖：先拷 requirements.txt ⇒ 改代码不重建依赖层 ───────────────
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# ── ② 运行时代码（白名单见 .dockerignore：只带 server/、src/、package.json、deploy/）──
# package.json 拷到 /app 是**为了它的 `"type": "module"`**：src/tilesplicer/*.js 与
# src/data/*.js 是 ESM，geom.mjs 以 file:// 动态 import 它们 ⇒ 真源＝仓库根 package.json。
COPY package.json package.json
COPY server/ server/
COPY src/ src/
COPY deploy/cloudrun/ deploy/cloudrun/
RUN chmod +x deploy/cloudrun/start.sh

# 服务端口（控制台仍须把服务端口配成 5191；两者一致才能过健康检查）
EXPOSE 5191

# 仓库已有健康端点：GET /api/health（只读、幂等、零副作用）⇒ 直接用它，不自创端点
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-5191}/api/health" >/dev/null || exit 1

# start.sh：export XIAI_AUTHORITY_ROOT ⇒ mkdir ⇒ exec uvicorn --host 0.0.0.0 --port ${PORT:-5191}
CMD ["deploy/cloudrun/start.sh"]
