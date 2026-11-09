#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# xiai-api 构建包装配器（deploy/cloudrun/package.sh）
#
# 为什么需要它：docker 只认**构建上下文根**的 `.dockerignore`，而本仓的单一真源
# 在 `deploy/cloudrun/.dockerignore`；且云托管「本地上传」要的是 zip 根带 Dockerfile。
# 本脚本把仓库根按排除表 rsync 成一个自洽的构建包，并把 Dockerfile / .dockerignore
# 放到包根 ⇒ 同一份产物既能 `docker build`，也能直接丢控制台。
#
# 用法：
#   ./package.sh stage        # 生成 out/buildctx/（可复跑，先清后建）
#   ./package.sh build [tag]  # stage ＋ docker build -t <tag 默认 xiai-api:local>
#   ./package.sh zip          # stage ＋ 打 out/xiai-api-<时间戳>.zip（控制台上传用）
#   ./package.sh clean        # 删 out/
# ═══════════════════════════════════════════════════════════════════════════
set -eu

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)   # deploy/cloudrun
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)       # 仓库根（xiai/）
OUT="$HERE/out"
STAGE="$OUT/buildctx"
IGNORE="$HERE/.dockerignore"

[ -f "$IGNORE" ] || { echo "[FATAL] 缺少 $IGNORE" >&2; exit 2; }
[ -f "$HERE/Dockerfile" ] || { echo "[FATAL] 缺少 $HERE/Dockerfile" >&2; exit 2; }

stage() {
  echo "[stage] root=$ROOT"
  echo "[stage] dst=$STAGE"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  # rsync 的 exclude-from 与 .dockerignore 语法同族（根锚定 `/x`、任意层级裸名）
  rsync -a --exclude-from="$IGNORE" "$ROOT/" "$STAGE/"
  # 包根放一份（docker / 控制台 zip 只看得到这里）
  cp "$IGNORE" "$STAGE/.dockerignore"
  cp "$HERE/Dockerfile" "$STAGE/Dockerfile"
  echo "[stage] 件数=$(find "$STAGE" -type f | wc -l | tr -d ' ') 体量=$(du -sh "$STAGE" | awk '{print $1}')"
  echo "[stage] 顶层：$(ls -A "$STAGE" | tr '\n' ' ')"
}

case "${1:-stage}" in
  stage)
    stage
    ;;
  build)
    stage
    TAG="${2:-xiai-api:local}"
    echo "[build] tag=$TAG"
    docker build -t "$TAG" "$STAGE"
    ;;
  zip)
    stage
    TS=$(date +%Y%m%d-%H%M%S)
    ZIP="$OUT/xiai-api-$TS.zip"
    (cd "$STAGE" && zip -qry "$ZIP" .)
    echo "[zip] $ZIP（zip 根即构建上下文根：含 Dockerfile / .dockerignore / start.sh）"
    echo "[zip] 体量=$(du -h "$ZIP" | awk '{print $1}')"
    ;;
  clean)
    rm -rf "$OUT"
    echo "[clean] 已删 $OUT"
    ;;
  *)
    echo "用法: $0 {stage|build [tag]|zip|clean}" >&2
    exit 2
    ;;
esac
