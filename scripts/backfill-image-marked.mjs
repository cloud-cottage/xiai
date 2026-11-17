#!/usr/bin/env node
/**
 * 玺爱 · **影像准入 `marked` 一次性存量回填**（Kevin 2026-11-17 裁定）
 * ============================================================================
 * 背景（**为什么必须回填，且必须是 `true`**）：
 *   `xiai_images` 现有 **6444 条 `storage: 'server'`（TIFF 原图 / 精修件）行 + 1 条
 *   `storage: 'bundled'` 哨兵行**，两条计数都在**上线前**取得（见本脚本 `--dry-run` 读数）。
 *   读面口径（`src/data/cloudbase.js::filterImageRowsForViewer`）是「非管理员只拿
 *   `marked === true`，缺键一律当 `false`」 ⇒ 若存量行不带 `marked`，**上线瞬间全站图片消失**。
 *   ⇒ 本脚本把**存量行一律置 `marked: true`**（`marked_by: 'backfill-2026-11-17'`）——
 *   即「存量视为已通过历史审核」，把审核门留给**此后新增**的影像。
 *
 * 硬口径（逐条）：
 *   · **哨兵行不动**：`storage === 'bundled'`（`img-placeholder-seal-no-image`）**不写** ——
 *     它本来就恒视为已标记（读面豁免），写它等于给兜底图伪造审核记录；
 *   · **只填缺**：条件写 `marked: { $ne: true }` ⇒ **幂等可重放**（重跑 `marked` 恒 0 条待改），
 *     且**绝不改写**已有 `marked` 值的行（含 `false` 之外的一切已裁行 ⇒ 二次审核结果不被覆盖）；
 *   · **默认就是 dry-run**：不带 `--apply` 一律**零写入**（只读三读数：总数 / bundled / 待回填）；
 *   · **写后四件套回读**：总数不变 ／ 待回填归零 ／ `bundled` 行仍**无** `marked` ／ 抽样行逐字；
 *   · **不删任何行、不改任何其它字段**；`$set` 只碰 `marked` / `marked_by` / `marked_at` 三键。
 *
 * 通道：`@cloudbase/cli@3` 的 `db nosql execute`（**只它**：不需要密钥、不需要 cloudbaserc.json，
 *   带 `-e <envId>` 即可；命令形态照本仓 `scripts/cb-nosql.py` 的实测口径 —— 入参必须是
 *   **MgoCommands 数组**，元素是 `{TableName, CommandType, Command}` 且 `Command` 是**字符串化
 *   JSON**，数值回包是 MongoDB 扩展 JSON）。
 *
 * 用法：
 *   node scripts/backfill-image-marked.mjs                # 只读预演（默认）
 *   node scripts/backfill-image-marked.mjs --dry-run      # 同上（显式）
 *   node scripts/backfill-image-marked.mjs --apply        # 真写（**只有 Zang 执行**）
 *   node scripts/backfill-image-marked.mjs --env <envId>  # 覆盖环境（默认取工程 .env.production）
 *
 * 环境解析顺序（**唯一真源纪律**：不在代码里写死 envId）：`--env` → `XIAI_CB_ENV_ID` →
 *   工程 `.env.production` 的 `VITE_XIAI_CB_ENV_ID` → `.env.local` 同键。取不到 ⇒ 停手报错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')

/** 目标集合（`xiai_` 前缀；读面唯一集合）。 */
const COLLECTION = 'xiai_images'
/** 回填写者标识（**不透明串**，非 uid —— 它表示「一次性存量迁移」，不是某个人）。 */
const BACKFILL_BY = 'backfill-2026-11-17'
/** 回填时刻（**定值**：可重放、可复算、与运行时钟无关；ISO 形态）。 */
const BACKFILL_AT = '2026-11-17T00:00:00.000Z'
/** 哨兵行的存储取值（**恒跳过**）。 */
const BUNDLED = 'bundled'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
}
const APPLY = hasFlag('--apply')
const DRY_RUN = !APPLY

/* ---------------------------------------------------------------- 环境解析 */
function envIdFromDotEnv(fileName) {
  const file = path.join(ROOT, fileName)
  if (!fs.existsSync(file)) return ''
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((row) => /^\s*VITE_XIAI_CB_ENV_ID\s*=/.test(row))
  return line ? line.replace(/^\s*VITE_XIAI_CB_ENV_ID\s*=\s*/, '').trim().replace(/^["']|["']$/g, '') : ''
}

const ENV_ID = (() => {
  const explicit = flagValue('--env')
  if (explicit) return { envId: explicit, source: '--env' }
  if (process.env.XIAI_CB_ENV_ID) return { envId: String(process.env.XIAI_CB_ENV_ID).trim(), source: 'XIAI_CB_ENV_ID' }
  const prod = envIdFromDotEnv('.env.production')
  if (prod) return { envId: prod, source: '.env.production:VITE_XIAI_CB_ENV_ID' }
  const local = envIdFromDotEnv('.env.local')
  if (local) return { envId: local, source: '.env.local:VITE_XIAI_CB_ENV_ID' }
  return { envId: '', source: 'NOT_FOUND' }
})()

if (ENV_ID.envId === '') {
  console.error(JSON.stringify({ ok: false, reason: 'ENV_ID_NOT_FOUND', message: '取不到 envId（--env / XIAI_CB_ENV_ID / .env.production / .env.local 全空）；**零写入**。' }))
  process.exit(2)
}

/* ------------------------------------------------------------- CLI 通道封装 */
/** 解 MongoDB 扩展 JSON 数值（`{"$numberInt":"79"}` / `$numberLong` / 裸值）。 */
function num(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value) || 0
  if (typeof value === 'object') {
    for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return Number(value[key]) || 0
    }
  }
  return 0
}

/**
 * 下发一条命令（单条原子命令最可靠：一次往返、结果可预测）。
 * @param {'COMMAND'|'UPDATE'} commandType
 * @param {object} command 命令体（会被**字符串化**后塞进 `Command`）
 * @returns {object} `data.results[0][0]`
 */
function execute(commandType, command) {
  const payload = JSON.stringify([{ TableName: COLLECTION, CommandType: commandType, Command: JSON.stringify(command) }])
  const args = ['-y', '-p', '@cloudbase/cli@3', 'cloudbase', 'db', 'nosql', 'execute', '-e', ENV_ID.envId, '--json', '--command', payload]
  let stdout = ''
  try {
    stdout = execFileSync('npx', args, { encoding: 'utf8', timeout: 280000, maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    const captured = `${(error && error.stdout) || ''}${(error && error.stderr) || ''}`
    throw new Error(`CLI_FAILED: ${String(captured).slice(-600) || (error && error.message)}`)
  }
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error(`NO_JSON: ${stdout.slice(-400)}`)
  const data = JSON.parse(stdout.slice(start))
  const results = data && data.data ? data.data.results : null
  /* 解析不到 ⇒ **停手**（不得当 0；否则会把「查不了」伪装成「已回填完」）。 */
  if (!Array.isArray(results)) throw new Error(`NO_RESULTS: ${JSON.stringify(data).slice(0, 600)}`)
  const first = Array.isArray(results[0]) ? results[0][0] : results[0]
  if (!first) throw new Error('NO_RESULT_ROW')
  return first
}

/** 计数（`count` 走 `COMMAND` ＋ `{count, query}`）。 */
function countOf(query) {
  const row = execute('COMMAND', { count: COLLECTION, query })
  return num(row.n)
}

/* ---------------------------------------------------------------- 读数与判定 */
const QUERY = Object.freeze({
  total: {},
  /** 存量待回填：不是哨兵行、且 `marked` 不是布尔 `true`（含缺键）。 */
  eligible: { storage: { $ne: BUNDLED }, marked: { $ne: true } },
  bundled: { storage: BUNDLED },
  markedTrue: { marked: true },
  markedFalse: { marked: false },
  markedMissing: { marked: { $exists: false } }
})

function snapshot() {
  return {
    total: countOf(QUERY.total),
    bundled: countOf(QUERY.bundled),
    eligible: countOf(QUERY.eligible),
    marked_true: countOf(QUERY.markedTrue),
    marked_false: countOf(QUERY.markedFalse),
    marked_missing: countOf(QUERY.markedMissing)
  }
}

const before = snapshot()

/* 安全闸：库为空 / bundled 行数异常 ⇒ 停手（宁可挂起，也不在可疑读数上写生产数据）。 */
const anomalies = []
if (before.total === 0) anomalies.push('TOTAL_ZERO')
if (before.bundled !== 1) anomalies.push(`BUNDLED_EXPECTED_1_GOT_${before.bundled}`)

const summary = {
  mode: DRY_RUN ? 'dry-run' : 'apply',
  env: ENV_ID.envId,
  env_source: ENV_ID.source,
  collection: COLLECTION,
  backfill_by: BACKFILL_BY,
  backfill_at: BACKFILL_AT,
  before,
  anomalies
}

if (DRY_RUN) {
  summary.plan = {
    will_mark: before.eligible,
    will_skip_bundled: before.bundled,
    query: QUERY.eligible,
    set: { marked: true, marked_by: BACKFILL_BY, marked_at: BACKFILL_AT }
  }
  summary.wrote = { rows: 0, note: 'dry-run：零写入（未下发 UPDATE）' }
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2))
  process.exit(0)
}

/* ------------------------------------------------------------------ 真写（--apply） */
if (anomalies.length > 0) {
  console.log(JSON.stringify({ ok: false, reason: 'PREFLIGHT_ANOMALY', ...summary }, null, 2))
  process.exit(3)
}

const updateReply = execute('UPDATE', {
  update: COLLECTION,
  /* `multi: true` **必写**：缺它默认只改第一条（回包仍报 ok:1，看着像成功）。 */
  updates: [
    {
      q: QUERY.eligible,
      u: { $set: { marked: true, marked_by: BACKFILL_BY, marked_at: BACKFILL_AT } },
      multi: true
    }
  ]
})

const after = snapshot()
const rollbackOf = null /* 统一回滚 = 把本次写的三键删掉（见 summary.rollback） */

summary.update_reply = { n: num(updateReply.n), nModified: num(updateReply.nModified) }
summary.after = after
summary.verification = {
  total_unchanged: after.total === before.total,
  eligible_now_zero: after.eligible === 0,
  bundled_still_unmarked: after.bundled === before.bundled,
  marked_true_equals_before_total_minus_bundled: after.marked_true === before.total - before.bundled
}
summary.rollback = {
  note: '统一回滚（**仅在本轮刚写完且确认要撤回时**执行；生成但默认不执行）：把本轮写的三键删除',
  command: {
    update: COLLECTION,
    updates: [
      {
        q: { marked_by: BACKFILL_BY, marked_at: BACKFILL_AT },
        u: { $unset: { marked: '', marked_by: '', marked_at: '' } },
        multi: true
      }
    ]
  },
  rollback_unused: rollbackOf
}
const verified =
  summary.verification.total_unchanged &&
  summary.verification.eligible_now_zero &&
  summary.verification.bundled_still_unmarked &&
  summary.verification.marked_true_equals_before_total_minus_bundled
console.log(JSON.stringify({ ok: verified, ...summary }, null, 2))
process.exit(verified ? 0 : 4)
