#!/usr/bin/env node
/**
 * 玺爱 · 两份 `run-verify-suite.sh` 读数的**逐条对拍**（基线副本 ↔ 工作区）
 * ============================================================================
 * 用法：node scripts/compare-verify-runs.mjs <base.json> <ws.json>
 *
 * 判读口径（**只看集合差**）：
 *   · `introduced` ＝ 工作区有、基线无的 `script::id` ⇒ **本单引入的红**（本单该修）。
 *   · `fixed`      ＝ 基线有、工作区无 ⇒ 本单顺带翻绿（须核是否「被疑似真缺陷翻绿」）。
 *   · `common`     ＝ 两边都在 ⇒ 基线已知红（**不计入本单红**）。
 *   · `totalsDrift` / `exitDrift`：逐套件的 `summary` 与退出码是否与基线逐字相同
 *     —— 防「failed_ids 没多、但用例总数被悄悄减掉」（删断言的形态）。
 *
 * 退出码：`introduced` 非空或出现 `shapeDrift` ⇒ 1（判负），否则 0。
 *
 * 纪律：**本脚本不派生子进程、不发网络请求**（只读两份 JSON 读数）⇒ 「禁连生产」按构造成立；
 *   仍与 `run-verify-suite.sh` 同一哨兵口径置 `XIAI_NO_REAL_CARD=1`（凡在**本进程**里被间接
 *   import 的转换件 / 工具件也拿不到真卡片入口）。真密钥的 `env -u` 摘除在**跑手**侧做
 *   （`run-verify-suite.sh` 第 64 行：`env -u CARD_API_KEY -u CARD_API_URL …`）—— 本脚本不跑套件，
 *   故不需要也不得自带 `env -u`（它没有任何被跑的子进程环境）。
 */
process.env.XIAI_NO_REAL_CARD = '1'

import { readFileSync } from 'node:fs'

const [, , basePath, wsPath] = process.argv
if (!basePath || !wsPath) {
  console.error('usage: node scripts/compare-verify-runs.mjs <base.json> <ws.json>')
  process.exit(2)
}
const base = JSON.parse(readFileSync(basePath, 'utf8'))
const ws = JSON.parse(readFileSync(wsPath, 'utf8'))

const toSet = (run) => new Set(run.failed_ids)
const baseSet = toSet(base)
const wsSet = toSet(ws)

const introduced = [...wsSet].filter((k) => !baseSet.has(k)).sort()
const fixed = [...baseSet].filter((k) => !wsSet.has(k)).sort()
const common = [...wsSet].filter((k) => baseSet.has(k)).sort()

const byScript = (run) => new Map(run.per_script.map((r) => [r.script, r]))
const baseMap = byScript(base)
const wsMap = byScript(ws)

const totalDrift = []
const exitDrift = []
const onlyBase = []
const onlyWs = []
for (const [name, b] of baseMap) {
  const w = wsMap.get(name)
  if (!w) {
    onlyBase.push(name)
    continue
  }
  const bt = b.summary && typeof b.summary.total === 'number' ? b.summary.total : null
  const wt = w.summary && typeof w.summary.total === 'number' ? w.summary.total : null
  if (bt !== null || wt !== null) {
    if (bt !== wt) totalDrift.push({ script: name, base: bt, ws: wt })
  }
  if (b.exit_code !== w.exit_code) exitDrift.push({ script: name, base: b.exit_code, ws: w.exit_code })
}
for (const name of wsMap.keys()) if (!baseMap.has(name)) onlyWs.push(name)

const report = {
  base: { root: base.root, commit: base.commit, scripts: base.scripts, failed_ids: base.failed_ids.length },
  ws: { root: ws.root, commit: ws.commit, scripts: ws.scripts, failed_ids: ws.failed_ids.length },
  introduced,
  fixed,
  common,
  totalsDrift: totalDrift,
  exitDrift,
  scriptsOnlyInBase: onlyBase.sort(),
  scriptsOnlyInWs: onlyWs.sort()
}
console.log(JSON.stringify(report, null, 2))
process.exit(introduced.length || totalDrift.length || exitDrift.length ? 1 : 0)
