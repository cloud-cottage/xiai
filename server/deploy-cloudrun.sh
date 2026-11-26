#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# xiai-api 上雲部署（CloudBase 云托管 / CloudBase Run）—— `server/deploy-cloudrun.sh`
#
# 用法：
#   ./deploy-cloudrun.sh check            # 只檢查憑據鍵齊不齊（**零副作用**，缺什麼就列什麼）
#   ./deploy-cloudrun.sh build [tag]      # 裝配構建上下文 + docker build（本機驗證用，零憑據）
#   ./deploy-cloudrun.sh push  [tag]      # build + docker login + docker push（需 TCR_*）
#   ./deploy-cloudrun.sh deploy [tag]     # **默認**：push → cloudbase cloudrun deploy（服務名 xiai-api）
#                                         #           → 補寫雲托管環境變量（XIAI_STORE_BACKEND / COS_*）
#   ./deploy-cloudrun.sh env              # 只補寫環境變量到既有服務
#
# ── 憑據紀律（逐條可機械判）────────────────────────────────────────────────────
#   · **值來源** ＝ `~/.config/tencent/cloudbase/xiai.env`（可由 `XIAI_DEPLOY_ENV_FILE` 覆蓋）；
#     本腳本只 `sed -n 's/^KEY=//p'` 取**需要的那幾個鍵**，
#     **不 `echo` 任何值、不列印整個文件、不寫進任何倉庫文件**；
#   · **不落盤**：密鑰只存在本進程的 shell 變量 / 子進程環境裡；唯一會落盤的是
#     `docker login` 交給 Docker 自身的 credential store（`~/.docker/config.json`，
#     屬本機 Docker CLI 的常規口令庫，**不是本腳本寫的文件**）；
#     另：`cloudbase run service:config --envParams` 只能走命令行 ⇒ 執行期間密鑰
#     會短暫出現在本機進程參數裡（該 CLI 無 `--env-file` 形態），**輸出已過遮罩**；
#   · **不入倉**：本腳本與 `server/.dockerignore` 都會把 `.env*` 排除在構建上下文外。
#
# ── 流水線 ─────────────────────────────────────────────────────────────────────
#   ① stage  ：按 `server/.dockerignore` rsync 出自洽上下文（docker 只認**上下文根**的
#              `.dockerignore`，倉庫根不放該文件 —— deploy/cloudrun/README 已明令）；
#   ② build  ：`docker build`（Dockerfile ＝ `server/Dockerfile`，見其頭注的上下文口徑）；
#   ③ push   ：`docker login` + `docker push` 到 TCR（`TCR_REGISTRY/TCR_NAMESPACE/xiai-api:<tag>`）；
#   ④ deploy ：`cloudbase cloudrun deploy --source <stage> --serviceName xiai-api --port 8000`
#              （平台按上下文裡的 Dockerfile 構建；要改用已推鏡像可切
#               `cloudbase run service:deploy --custom_image <URI>`，本腳本不預設）；
#   ⑤ env    ：`cloudbase run service:config --envParams …` 把 `XIAI_STORE_BACKEND=cos`
#              與 `COS_*` 以**雲托管環境變量**寫進服務（`--envParams` 形態 ＝ `k=v&k2=v2`；
#              它可能是**整組覆寫** ⇒ 一次把服務需要的鍵全給；平台注入的 `PORT` 不在此列）。
#              順序 ＝ **先補 env（服務已存在則首啟即帶 cos）→ deploy → 再補一次（冪等）**，
#              避免「新建服務先以 local 起來、寫進容器臨時盤就丟」。
# ═══════════════════════════════════════════════════════════════════════════
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)      # server/
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)                # 倉庫根 xiai/
ENV_FILE="${XIAI_DEPLOY_ENV_FILE:-$HOME/.config/tencent/cloudbase/xiai.env}"
SERVICE_NAME="${XIAI_CLOUDRUN_SERVICE:-xiai-api}"
CONTAINER_PORT="${XIAI_CONTAINER_PORT:-8000}"
REPO_TAG="${XIAI_IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
LOCAL_TAG="xiai-api:${REPO_TAG}"
MODE="${1:-deploy}"

STAGE=""
cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
}
trap cleanup EXIT INT TERM

# ── 讀鍵（只取需要的；**不 echo 值**）──────────────────────────────────────────
env_get() {                                     # $1 ＝ 鍵名；回值（可能空）；永不回非零
  if [ -f "$ENV_FILE" ]; then
    sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"//' -e 's/"$//'
  fi
}

load_key() {                                    # $1 ＝ 鍵名：取值 → shell 變量 → 導出（供遮罩用）
  # shellcheck disable=SC2034
  eval "$1=\$(env_get \"$1\")"
  eval "export $1"
}

require_keys() {                                # 缺鍵 ⇒ 只列**鍵名**後退出（不回顯值）
  _missing=""
  for _k in "$@"; do
    if [ -z "$(env_get "$_k")" ]; then _missing="$_missing $_k"; fi
  done
  if [ -n "$_missing" ]; then
    echo "[FATAL] $ENV_FILE 缺少必需鍵：${_missing}" >&2
    echo "        需求鍵：$*" >&2
        echo "        紀律：本腳本只取需要的鍵、不 echo 任何值；值只留在該 env 文件，**不入倉**。" >&2
    exit 2
  fi
}

# ── 輸出遮罩（任何可能帶密鑰的命令都走這裡：值 → `***`）────────────────────────
MASK_KEYS=""
mask_add() {                                    # $1 ＝ 鍵名（其值已導出）
  case " ${MASK_KEYS} " in
    *" $1 "*) ;;
    *) MASK_KEYS="${MASK_KEYS} $1" ;;
  esac
}

run_masked() {                                  # 執行 $@；stdout+stderr 過遮罩再落屏
  if ! command -v python3 >/dev/null 2>&1; then
    "$@"
    return $?
  fi
  _log=$(mktemp "${TMPDIR:-/tmp}/xiai-deploy-log.XXXXXX")
  _rc=0
  "$@" >"$_log" 2>&1 || _rc=$?
  XIAI_MASK_LOG="$_log" XIAI_MASK_KEYS="$MASK_KEYS" python3 - <<'PY' >&2 || cat "$_log" >&2
import os, sys
path = os.environ.get("XIAI_MASK_LOG", "")
try:
    text = open(path, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)
for key in os.environ.get("XIAI_MASK_KEYS", "").split():
    value = os.environ.get(key, "")
    if value:
        text = text.replace(value, "***")
sys.stderr.write(text)
PY
  rm -f "$_log"
  return $_rc
}

# ── ① 裝配構建上下文 ───────────────────────────────────────────────────────────
stage() {
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/xiai-api-ctx.XXXXXX")
  rsync -a --exclude-from="$HERE/.dockerignore" "$ROOT/" "$STAGE/"
  cp "$HERE/.dockerignore" "$STAGE/.dockerignore"     # docker 只認上下文根的這份
  cp "$HERE/Dockerfile" "$STAGE/Dockerfile"
  echo "[stage] $STAGE 件数=$(find "$STAGE" -type f | wc -l | tr -d ' ') 体量=$(du -sh "$STAGE" | awk '{print $1}')"
}

# ── ② 構建 ─────────────────────────────────────────────────────────────────────
do_build() {
  command -v docker >/dev/null 2>&1 || { echo "[FATAL] 沒有 docker" >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo "[FATAL] Docker daemon 沒起來（本機 colima：`colima start`）" >&2; exit 2; }
  stage
  echo "[build] tag=$LOCAL_TAG"
  docker build -t "$LOCAL_TAG" "$STAGE"
}

# ── ③ 推送 ─────────────────────────────────────────────────────────────────────
IMAGE_URI=""
do_push() {
  require_keys TCR_REGISTRY TCR_NAMESPACE TCR_USERNAME TCR_PASSWORD
  load_key TCR_REGISTRY; load_key TCR_NAMESPACE; load_key TCR_USERNAME; load_key TCR_PASSWORD
  mask_add TCR_PASSWORD
  IMAGE_URI="${XIAI_IMAGE_URI:-$TCR_REGISTRY/$TCR_NAMESPACE/xiai-api:${REPO_TAG}}"
  echo "[push] $IMAGE_URI"
  printf '%s' "$TCR_PASSWORD" | docker login "$TCR_REGISTRY" -u "$TCR_USERNAME" --password-stdin
  docker tag "$LOCAL_TAG" "$IMAGE_URI"
  docker push "$IMAGE_URI"
}

# ── ④ / ⑤ 部署 ＋ 環境變量 ────────────────────────────────────────────────────
COS_PARAMS=""
do_env_params() {                               # 組 `k=v&k2=v2`（值不落屏）
  require_keys COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION
  load_key COS_SECRET_ID; load_key COS_SECRET_KEY; load_key COS_BUCKET; load_key COS_REGION
  load_key CLOUDBASE_ENV_ID
  mask_add COS_SECRET_ID; mask_add COS_SECRET_KEY; mask_add CLOUDBASE_ENV_ID
  COS_PARAMS="XIAI_STORE_BACKEND=cos"
  for _k in COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION; do
    eval "_v=\$$_k"
    if [ -n "$_v" ]; then COS_PARAMS="$COS_PARAMS&$_k=$_v"; fi
  done
  # 可選的臨時憑證（STS）：有才給
  COS_SESSION_TOKEN=$(env_get COS_SESSION_TOKEN || true)
  export COS_SESSION_TOKEN
  if [ -n "$COS_SESSION_TOKEN" ]; then
    mask_add COS_SESSION_TOKEN
    COS_PARAMS="$COS_PARAMS&COS_SESSION_TOKEN=$COS_SESSION_TOKEN"
  fi
}

set_service_env() {
  do_env_params
  echo "[env] $SERVICE_NAME ← XIAI_STORE_BACKEND=cos ＋ COS_*（值不回顯）"
  run_masked cloudbase -e "$CLOUDBASE_ENV_ID" run service:config \
    --serviceName "$SERVICE_NAME" --envParams "$COS_PARAMS"
}

do_deploy() {
  command -v cloudbase >/dev/null 2>&1 || { echo "[FATAL] 沒有 cloudbase CLI" >&2; exit 2; }
  # 先補 env（服務已存在 ⇒ 首啟即帶 cos；不存在 ⇒ 這步會失敗，忽略並在 deploy 後補）
  set_service_env || echo "[warn] 部署前補 env 失敗（服務可能尚不存在），deploy 之後會再補一次" >&2
  echo "[deploy] service=$SERVICE_NAME port=$CONTAINER_PORT source=$STAGE"
  run_masked cloudbase -e "$CLOUDBASE_ENV_ID" cloudrun deploy \
    --source "$STAGE" --serviceName "$SERVICE_NAME" --port "$CONTAINER_PORT" --force
  set_service_env || { echo "[FATAL] 環境變量沒補上（服務會以 local 後端起，寫進容器臨時盤即丟）" >&2; exit 3; }
  echo "[deploy] 完成：service=$SERVICE_NAME image=$IMAGE_URI"
}

# ── 分發 ───────────────────────────────────────────────────────────────────────
case "$MODE" in
  check)
    echo "[check] 憑據文件：$ENV_FILE"
    if [ ! -f "$ENV_FILE" ]; then echo "[FATAL] 文件不存在" >&2; exit 2; fi
    _missing=""
    for _k in CLOUDBASE_ENV_ID CLOUDBASE_API_KEY TCR_REGISTRY TCR_NAMESPACE \
              TCR_USERNAME TCR_PASSWORD COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION; do
      if [ -z "$(env_get "$_k")" ]; then _missing="$_missing $_k"; fi
    done
    if [ -n "$_missing" ]; then
      echo "[check] 缺：${_missing}" >&2
      echo "[check] 可選：COS_SESSION_TOKEN（STS 臨時憑證）" >&2
      exit 2
    fi
    echo "[check] 必需鍵齊（不回顯值）"
    ;;
  build)
    do_build
    ;;
  push)
    do_build
    do_push
    ;;
  deploy)
    # 一次把全部必需鍵查齊 ⇒ **缺什麼就先停**（零半途副作用），再進流水線
    require_keys CLOUDBASE_ENV_ID CLOUDBASE_API_KEY \
                 TCR_REGISTRY TCR_NAMESPACE TCR_USERNAME TCR_PASSWORD \
                 COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION
    load_key CLOUDBASE_API_KEY; mask_add CLOUDBASE_API_KEY
    do_build
    do_push
    do_deploy
    ;;
  env)
    require_keys CLOUDBASE_ENV_ID
    set_service_env
    ;;
  *)
    echo "用法: $0 {check|build|push|deploy|env} [tag]" >&2
    exit 2
    ;;
esac
