# ═══════════════════════════════════════════════════════════════════════════
# xiai-api（server/ · Python 3.11 / FastAPI 影像切片服務）容器鏡像
#
# ★ 構建上下文 ＝ **倉庫根**（`xiai/`）——鏡像必須同時拿到三樣東西：
#     `server/`（服務本體）＋ `src/tilesplicer/**`（切分內核，真源恰 1 處）
#     ＋ 根 `package.json`（`"type": "module"`，geom 薄橋動態 import ESM 用）。
#   ⇒ 構建命令（**必須帶 `-f`，且上下文是根**）：
#       docker build -f server/Dockerfile -t xiai-api:local .
#   ⚠ docker 只認**上下文根**的 `.dockerignore` ⇒ 請勿手敲上面這行；
#     走 `server/deploy-cloudrun.sh build`（它會按 `server/.dockerignore`
#     裝配一個自洽的構建上下文，排除表才真正生效）。
#
# 與 `server/run.sh` 的唯一差異 ＝ 綁定地址（本機 127.0.0.1 / 容器 0.0.0.0）；
# **`run.sh` 一字未改**（它是 ctrl 面板登記的手動啟動面）。
# 容器入口單獨寫在 `server/container-entrypoint.sh`（Dockerfile CMD 只負責 exec 它）。
# ═══════════════════════════════════════════════════════════════════════════
FROM python:3.11-slim

# HOST / PORT 一律從環境變量讀（雲托管注入 `PORT`；未注入時回落 8000）
# XIAI_STORE_BACKEND 缺省 `local`；上雲切 `cos` 由部署面注入（缺 `COS_*` ⇒ 啟動即失敗）
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    XIAI_STORE_BACKEND=local

# node ＝ 切分薄橋的運行時（`server/app/slicer.py` 經 subprocess 跑
#        `server/tools/geom.mjs` → 讀同一份 `src/tilesplicer/**` 內核；
#        缺 node ⇒ `/api/tilesplicer/**` 與 `/api/image/slices` 一律結構化 500）
# curl ＝ HEALTHCHECK 與運維自測
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── ① 依賴：先拷 requirements.txt ⇒ 改代碼不重建依賴層 ────────────────────────
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# ── ② 運行時代碼（排除表見 server/.dockerignore：只帶 package.json ＋ server/ ＋ src/）
#      package.json 拷到 /app 是**為了它的 `"type": "module"`**。
COPY package.json package.json
COPY server/ server/
COPY src/ src/
RUN chmod +x server/container-entrypoint.sh

# 服務端口（雲托管控制台的服務端口須與之同值；健康檢查走既有 GET /api/health）
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/api/health" >/dev/null || exit 1

# 入口：`--host ${HOST} --port ${PORT}`，**單進程**（不加多 worker / 不加 --reload，
# 與 run.sh 同口徑；並發由 uvicorn[standard] 的 uvloop + 事件循環承擔）
CMD ["server/container-entrypoint.sh"]
