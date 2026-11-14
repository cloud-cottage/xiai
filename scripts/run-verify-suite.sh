#!/usr/bin/env bash
# 玺爱 · 离线校验套件**串行**跑手（工作区 ↔ 基线副本 逐条对拍用）
# ============================================================================
# 用途：对一个仓库根目录（工作区或其 `git worktree` 基线副本）**串行**跑全部
#       `scripts/verify-*.mjs`，把每个套件的 `failed_ids` 收成一份 JSON，
#       供两份读数**逐条对拍**（基线已知红不算本单红）。
#
# 用法：
#   bash scripts/run-verify-suite.sh <repo-root> <out-json> [only-pattern]
#
#   <repo-root>     要跑的仓库根（工作区 / 基线副本），脚本按该根下的
#                   `scripts/verify-*.mjs` 枚举 —— 副本自带自己的套件集。
#   <out-json>      读数落盘路径（JSON：`{root, commit, scripts[], failed_ids[], ...}`）。
#   [only-pattern]  可选；给则只跑文件名含该子串的套件（不参与「全量」判定）。
#
# 纪律（硬）：
#   · **禁连生产**：`env -u CARD_API_KEY -u CARD_API_URL -u CARD_CLIENT_ID
#     -u CARD_CLIENT_SECRET` ⇒ 真密钥永不出现在被跑进程的环境里；
#     另置哨兵 `XIAI_NO_REAL_CARD=1`（沿 `scripts/README-test-net.md` 防线 1）。
#   · **串行**：一个套件跑完再跑下一个（并发会让端口 / 临时目录 / 全局假件互相踩）。
#   · 单个套件崩溃（非 0 退出且无 JSON 行）⇒ 记 `crashed:true`，不静默跳过。
#   · 只读：不写被测仓库任何文件（读数只落 <out-json>）。
set -u

ROOT_ARG="${1:-}"
OUT_ARG="${2:-}"
ONLY="${3:-}"

if [ -z "$ROOT_ARG" ] || [ -z "$OUT_ARG" ]; then
  echo "usage: bash scripts/run-verify-suite.sh <repo-root> <out-json> [only-pattern]" >&2
  exit 2
fi

ROOT="$(cd "$ROOT_ARG" && pwd -P)"
OUT="$OUT_ARG"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac

if [ ! -d "$ROOT/scripts" ]; then
  echo "not a repo root (no scripts/): $ROOT" >&2
  exit 2
fi

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

TMPDIR_RUN="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RUN"' EXIT

: > "$TMPDIR_RUN/all.jsonl"
i=0
total_scripts=0
failed_scripts=0
crashed_scripts=0

for f in "$ROOT"/scripts/verify-*.mjs; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ -n "$ONLY" ]; then
    case "$name" in *"$ONLY"*) ;; *) continue ;; esac
  fi
  total_scripts=$((total_scripts + 1))
  i=$((i + 1))
  log="$TMPDIR_RUN/$name.log"
  # 串行：前台阻塞跑完再看下一条。**真密钥先从环境里摘掉**（`env -u`）。
  env -u CARD_API_KEY -u CARD_API_URL -u CARD_CLIENT_ID -u CARD_CLIENT_SECRET \
      XIAI_NO_REAL_CARD=1 NODE_ENV=test \
      node "$f" >"$log" 2>&1
  code=$?

  # 失败判据 id：套件里每条 `check()` 打一行 JSONL（`{"id":…,"pass":false,…}`）；
  # 老套件的汇总行形态不一（`{summary:{…}}` / `{"pass":42,"fail":0}` /
  # `{"section":"SUMMARY","failures":0}`）⇒ 三种都认，老形态也一律记 `summary`（不误报 crashed）。
  # 用 node 解析（避免 grep 正则把描述里的引号吃坏）。
  node -e '
    const fs = require("fs")
    const [logPath, name, code, commit] = process.argv.slice(1)
    const raw = fs.readFileSync(logPath, "utf8")
    const ids = []
    let summary = null
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t.startsWith("{")) continue
      let row
      try { row = JSON.parse(t) } catch { continue }
      if (row.summary && typeof row.summary === "object") summary = row.summary
      else if (typeof row.fail === "number" && typeof row.pass === "number") summary = { passed: row.pass, failed: row.fail }
      else if (row.section === "SUMMARY" && typeof row.failures === "number") summary = { failed: row.failures }
      if (row.id && row.pass === false) ids.push(row.id)
    }
    // 无 JSON 汇总时的兜底：非 JSON 的 `FAIL xx` 行也收（老套件）。
    if (!summary) {
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*(?:FAIL|✗|×)\s+([A-Za-z0-9._-]+)/)
        if (m) ids.push(m[1])
      }
    }
    process.stdout.write(JSON.stringify({
      script: name,
      commit,
      exit_code: Number(code),
      summary,
      failed_ids: ids,
      crashed: !summary && ids.length === 0
    }) + "\n")
  ' "$log" "$name" "$code" "$COMMIT" >> "$TMPDIR_RUN/all.jsonl"

  if [ "$code" -ne 0 ]; then failed_scripts=$((failed_scripts + 1)); fi
  printf '%-46s exit=%-3s failed=%s\n' "$name" "$code" \
    "$(node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(x=>x.trim().startsWith("{"));let n=0;for(const x of l){try{const r=JSON.parse(x);if(r.id&&r.pass===false)n++}catch{}}process.stdout.write(String(n))' "$log")"
done

node -e '
  const fs = require("fs")
  const [src, out, root, commit, only] = process.argv.slice(1)
  const rows = fs.readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const failedById = {}
  for (const r of rows) {
    for (const id of r.failed_ids) {
      const key = `${r.script}::${id}`
      failedById[key] = failedById[key] || 0
      failedById[key] += 1
    }
  }
  const payload = {
    root,
    commit,
    only: only || null,
    scripts: rows.length,
    failed_scripts: rows.filter((r) => r.exit_code !== 0).length,
    crashed_scripts: rows.filter((r) => r.crashed).map((r) => r.script),
    failed_ids: Object.keys(failedById).sort(),
    per_script: rows.map((r) => ({
      script: r.script,
      exit_code: r.exit_code,
      summary: r.summary,
      failed_ids: r.failed_ids
    }))
  }
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n")
  console.log(`\n== ${root} @ ${commit} ==`)
  console.log(`scripts=${payload.scripts} failed_scripts=${payload.failed_scripts} crashed=${payload.crashed_scripts.length} failed_ids=${payload.failed_ids.length}`)
  for (const k of payload.failed_ids) console.log(`  RED ${k}`)
' "$TMPDIR_RUN/all.jsonl" "$OUT" "$ROOT" "$COMMIT" "$ONLY"
