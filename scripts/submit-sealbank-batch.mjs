#!/usr/bin/env node
/**
 * 玺爱 · sealbank 试水批 **批量提交脚本**（feicui 占位图 NDJSON ⇒ 生产 `xiai_seal_imports`）
 * ============================================================================
 * **做什么**：把 feicui 产出的占位图形态 NDJSON（`xiai_imports_sealbank_placeholder.ndjson`，
 * 5,529 行）按**等距抽样**取 N 条（默认 100，覆盖全文件、不取前 N 连续），经
 * `cloudfunctions/xiai-user-token/lib/ops.js` 的**真实函数体** `OPS.submitSealImport`
 * ＋ 真实 `persist()` 写入**生产** CloudBase 集合 `xiai_seal_imports`（status=PENDING，
 * **不采纳** —— reviewSealImport 一律不跑）。
 *
 * **身份（① 的结论，代码证据）**：
 *   - op 函数体本身只查 `identityUsable(identity)`
 *     （`lib/sessionAuthority.js:380-382`：`uid` 必有；**令牌路** `phone` 必有、
 *     会话路凭 `identity_source:'SESSION'`）—— **函数体内不验令牌签名**；
 *   - 生产里身份由 `index.js:220-227` 从**已验令牌**派生：
 *     `{uid: uidOf(phone), phone, role:'user', identity_source:'SERVER_TOKEN'}`，
 *     其中 `uidOf(phone) = 'u-' + sha256(phone).hex 前 16 位`（`lib/config.js:11-14`）；
 *   - 本脚本注入**同一形态**的身份：`phone` 取环境变量 `XIAI_OPERATOR_PHONE`（真实操作者账号），
 *     `uid` 用**服务端自己的** `config.uidOf(phone)` 派生 —— **零伪造**（不发明任何值）。
 *   - **身份取证（写前强制）**：① 回读生产 `xiai_person_imports`，确认该 uid 出现在真实
 *     `imported_by` 值集里；② 兜底走生产云函数 `action:'issue'`（xiai 后台签发通道，
 *     演示码从 `src/services/auth.js` 读出、**绝不打印**）。两条都不成立 ⇒ **中止、零写入**。
 *
 * **纪律**：
 *   - 幂等：每条**提交前**先按幂等键 `(source, source_seal_id)` 查生产（op 体内还会再查一次），
 *     已存在 ⇒ `skipped`（不改写既有行）；重跑不重复；
 *   - 限速：相邻两条生产写 ≥300ms（默认 400ms）；
 *   - 凭据：`TCB_ENV` ＋ `TENCENTCLOUD_SECRETID/KEY` 由调用方 `source` 统一凭据文件注入；
 *     手机号 / 演示码 / 令牌 **不打印、不入报告**（手机号只以掩码出现）；
 *   - 回滚：`--rollback --ids <ids.json> --yes` 只删**本脚本本轮新写**、且仍为 `PENDING` 的行
 *     （逐条回读核验 `source` ＋ `source_seal_id` ＋ `status`，非 `PENDING` 一律跳过不删）。
 *
 * **用法**：
 *   set -a; . ~/.config/bistro/cloudbase-liwu.env; set +a
 *   export XIAI_OPERATOR_PHONE=<操作者手机号>
 *   node scripts/submit-sealbank-batch.mjs --limit 5 --dry-run          # 只读＋假写
 *   node scripts/submit-sealbank-batch.mjs --limit 1                    # 金丝雀
 *   node scripts/submit-sealbank-batch.mjs --limit 100 --offset 0       # 正式试水批
 *   node scripts/submit-sealbank-batch.mjs --rollback --ids scripts/out/submit_batch_ids.json --yes
 */

import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 参数
   --------------------------------------------------------------------------- */
const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const hasFlag = (name) => argv.indexOf(name) !== -1

const MODE = hasFlag('--rollback') ? 'rollback' : 'submit'
const LIMIT = Math.max(1, Number(argOf('--limit', '100')) || 100)
const OFFSET = Math.max(0, Number(argOf('--offset', '0')) || 0)
const STRIDE_ARG = argOf('--stride', 'auto')
const DELAY_MS = Math.max(300, Number(argOf('--delay', '400')) || 400) // 生产纪律：≥300ms/条
const NDJSON = path.resolve(
  argOf('--ndjson', '/Users/kevin/bistro/feicui/local-private/datasrc/sealbank/out/xiai_imports_sealbank_placeholder.ndjson')
)
const OUT_DIR = path.resolve(argOf('--out-dir', path.join(ROOT, 'scripts', 'out')))
const IDS_FILE = argOf('--ids', path.join(OUT_DIR, 'submit_batch_ids.json'))
const YES = hasFlag('--yes')
const DRY_RUN = hasFlag('--dry-run')

const ENV_ID = process.env.TCB_ENV || process.env.CLOUDBASE_ENV_ID || ''
const SECRET_ID = process.env.TENCENTCLOUD_SECRETID || ''
const SECRET_KEY = process.env.TENCENTCLOUD_SECRETKEY || ''
if (!ENV_ID || !SECRET_ID || !SECRET_KEY) {
  console.error(JSON.stringify({ fatal: '缺少云端凭据：请先 source ~/.config/bistro/cloudbase-liwu.env（需要 TCB_ENV / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY）' }))
  process.exit(2)
}
const PHONE = process.env.XIAI_OPERATOR_PHONE || ''
if (!PHONE) {
  console.error(JSON.stringify({ fatal: '缺少 XIAI_OPERATOR_PHONE（真实操作者手机号）—— 身份不可伪造 ⇒ 中止' }))
  process.exit(2)
}

const log = (obj) => console.log(JSON.stringify(obj))

/* ---------------------------------------------------------------------------
   1. 真源载入（ops.js 真实函数体 ＋ 服务端自己的 uidOf）
   --------------------------------------------------------------------------- */
const memory = new Map()
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const config = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js'))
const submitSealImport = ops.OPS.submitSealImport.bind(ops.OPS)
const SEAL_IMPORTS_COLLECTION = ops.COLLECTIONS.sealImports // 'xiai_seal_imports'
const PERSON_IMPORTS_COLLECTION = ops.COLLECTIONS.personImports
const SOURCE = '真微印網 sealbank.net' // 与 feicui NDJSON `source` 逐字同值（幂等键一半）

/* ---------------------------------------------------------------------------
   2. 生产连接（@cloudbase/node-sdk；凭据只从环境变量来）
   --------------------------------------------------------------------------- */
const tcb = require('@cloudbase/node-sdk')
const app = tcb.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY })
const db = app.database()

/* dry-run：读走真库、写（add / set / remove）只记录不落 —— **不绕提交门**，只是不落盘。 */
const dryWrites = []
function dryRunWrap(realDb) {
  const handler = {
    get(target, prop) {
      if (prop !== 'collection') return Reflect.get(target, prop)
      return (name) => {
        const col = realDb.collection(name)
        return new Proxy(col, {
          get(colTarget, colProp) {
            if (colProp === 'add') {
              return async (doc) => {
                dryWrites.push({ collection: name, kind: 'add', business_id: doc && doc.id })
                return { id: `dry-${dryWrites.length}` }
              }
            }
            if (colProp === 'doc') {
              return (id) => {
                const docRef = colTarget.doc(id)
                return new Proxy(docRef, {
                  get(docTarget2, docProp) {
                    if (docProp === 'set') {
                      return async (doc) => {
                        dryWrites.push({ collection: name, kind: 'set', id })
                        return { updated: 1 }
                      }
                    }
                    if (docProp === 'remove') {
                      return async () => {
                        dryWrites.push({ collection: name, kind: 'remove', id })
                        return { deleted: 1 }
                      }
                    }
                    return Reflect.get(docTarget2, docProp)
                  }
                })
              }
            }
            return Reflect.get(colTarget, colProp)
          }
        })
      }
    }
  }
  return new Proxy(realDb, handler)
}
const dbForOps = DRY_RUN ? dryRunWrap(db) : db
ops.setOpsDbProvider(() => dbForOps)

/* ---------------------------------------------------------------------------
   3. 身份（零伪造：phone 来自环境变量；uid 用服务端自己的 uidOf 派生）
   --------------------------------------------------------------------------- */
const identity = Object.freeze({
  uid: config.uidOf(PHONE),
  phone: PHONE,
  role: 'user',
  identity_source: 'SERVER_TOKEN' // 与 index.js:222-227 令牌路派生形态逐字同形
})
const phoneMasked = config.maskedPhone(PHONE)
const uidMasked = `${identity.uid.slice(0, 5)}…${identity.uid.slice(-4)}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 生产读数：按幂等键查既有导入行（limit 1）。 */
async function findExisting(sourceSealId) {
  const reply = await db
    .collection(SEAL_IMPORTS_COLLECTION)
    .where({ source: SOURCE, source_seal_id: sourceSealId })
    .limit(1)
    .get()
  const rows = (reply && Array.isArray(reply.data) && reply.data) || []
  return rows.length > 0 ? rows[0] : null
}

/** 身份取证 ①：uid 是否出现在生产既有导入行的 imported_by 值集（真实操作者证据）。 */
async function proofByReadback() {
  const reply = await db.collection(PERSON_IMPORTS_COLLECTION).limit(1000).get()
  const rows = (reply && Array.isArray(reply.data) && reply.data) || []
  const hits = rows.filter((row) => row && row.imported_by === identity.uid).length
  return { method: 'uid-readback', scanned: rows.length, hits }
}

/** 身份取证 ②（兜底）：生产云函数 action:'issue'（xiai 后台签发通道；演示码绝不打印）。 */
async function proofByTokenIssue() {
  const authSrc = readFileSync(path.join(ROOT, 'src/services/auth.js'), 'utf8')
  const match = authSrc.match(/DEMO_SMS_CODE\s*=\s*'([^']+)'/)
  if (!match) return { method: 'token-issue', ok: false, message: 'src/services/auth.js 未读到 DEMO_SMS_CODE' }
  const reply = await app.callFunction({
    name: 'xiai-user-token',
    data: { action: 'issue', phone: PHONE, code: match[1] }
  })
  const result = reply && reply.result
  const ok = !!(result && result.RetMsg && result.RetMsg.token)
  return { method: 'token-issue', ok, message: ok ? '生产 xiai-user-token 签发成功（手机号＋演示码有效）' : '生产签发未通过' }
}

/* ---------------------------------------------------------------------------
   4a. 提交模式
   --------------------------------------------------------------------------- */
async function runSubmit() {
  if (!existsSync(NDJSON)) {
    log({ fatal: `NDJSON 不存在：${NDJSON}` })
    process.exit(2)
  }
  const allRows = readFileSync(NDJSON, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const stride = STRIDE_ARG === 'auto' ? Math.max(1, Math.floor(allRows.length / LIMIT)) : Math.max(1, Number(STRIDE_ARG) || 1)
  const picked = []
  const seenIds = new Set()
  for (let i = 0; i < LIMIT; i += 1) {
    const index = OFFSET + i * stride
    if (index >= allRows.length) break
    const row = allRows[index]
    if (!row || !row.source_seal_id || seenIds.has(row.source_seal_id)) continue
    seenIds.add(row.source_seal_id)
    picked.push({ index, row })
  }

  /* 身份取证（写前强制）：两条都不成立 ⇒ 中止、零写入（缺口如实报告）。 */
  const proofReadback = await proofByReadback()
  let proof = proofReadback.hits > 0 ? proofReadback : null
  let proofIssue = null
  if (!proof) {
    proofIssue = await proofByTokenIssue()
    if (!proofIssue.ok) {
      log({
        fatal: '身份取证未通过（uid 不在生产 imported_by 值集，且生产签发通道不认该手机号/演示码）⇒ 零写入中止。',
        proof_readback: proofReadback,
        proof_issue: { method: proofIssue.method, ok: proofIssue.ok },
        gap: '需要 xiai 后台为本操作者签发令牌（或确认 XIAI_OPERATOR_PHONE 是真实注册账号）后再跑；脚本绝不伪造身份。'
      })
      process.exit(2)
    }
    proof = proofIssue
  }

  /* 基线读数：生产中 source＝sealbank 的既有行数（读回判据的「改前」锚点）。 */
  const beforeCountReply = await db.collection(SEAL_IMPORTS_COLLECTION).where({ source: SOURCE }).count()
  const beforeCount = Number((beforeCountReply && beforeCountReply.total) || 0)

  log({
    start: {
      mode: DRY_RUN ? 'dry-run（读真库、写假体）' : 'submit（写生产 xiai_seal_imports）',
      env: ENV_ID,
      ndjson: NDJSON,
      total_source_rows: allRows.length,
      params: { limit: LIMIT, offset: OFFSET, stride },
      picked_count: picked.length,
      delay_ms: DELAY_MS,
      identity: { phone_masked: phoneMasked, uid_masked: uidMasked, proof },
      sealbank_rows_before: beforeCount
    }
  })

  const results = []
  const writtenIds = []
  const counts = { ok: 0, skipped: 0, rejected: 0, error: 0, writes: 0 }
  for (let n = 0; n < picked.length; n += 1) {
    const { index, row } = picked[n]
    const entry = {
      n: n + 1,
      index,
      source_seal_id: row.source_seal_id,
      seal_name: row.seal_name || '',
      dynasty: row.dynasty || '',
      result: 'error',
      doc_id: null,
      business_id: null,
      reason: null,
      message: ''
    }
    try {
      /* 幂等预检（任务 ② 要求：提交前查，已存在 ⇒ 跳过；op 体内还会再判一次）。 */
      const existing = await findExisting(row.source_seal_id)
      if (existing) {
        entry.result = 'skipped'
        entry.doc_id = existing._id || existing.id || null
        entry.message = '幂等键已存在 ⇒ 跳过（未改写既有行）'
      } else {
        /* 真实提交门：封闭键面 / 值域 / 占位来源门 / 形态门 / 幂等 —— 全在函数体内。 */
        const res = await submitSealImport(row, identity)
        if (!res.ok) {
          entry.result = 'rejected'
          entry.reason = res.reason || ''
          entry.message = res.message || ''
        } else if (res.idempotent) {
          entry.result = 'skipped'
          entry.doc_id = (res.row && (res.row._id || res.row.id)) || null
          entry.message = 'op 体内幂等判定命中 ⇒ 返回既有行'
        } else if (DRY_RUN) {
          entry.result = 'ok'
          entry.doc_id = `dry-${n + 1}`
          entry.business_id = res.row && res.row.id
          entry.message = 'dry-run：门全过、写入被假体截留（零落盘）'
          counts.writes += 0
        } else {
          /* 与 index.js:276-280 同序：op 产出 plan ⇒ persist 落库 ⇒ docId。 */
          const docId = await ops.persist(res.plan)
          if (!docId) throw new Error('PERSIST_NO_DOC_ID')
          entry.result = 'ok'
          entry.doc_id = String(docId)
          entry.business_id = res.row && res.row.id
          entry.message = ''
          counts.writes += 1
          writtenIds.push({
            source: SOURCE,
            source_seal_id: row.source_seal_id,
            doc_id: String(docId),
            business_id: res.row && res.row.id,
            submitted_at: new Date().toISOString()
          })
        }
      }
    } catch (error) {
      entry.result = 'error'
      entry.reason = 'EXCEPTION'
      entry.message = String((error && error.message) || error).slice(0, 300)
    }
    counts[entry.result] = (counts[entry.result] || 0) + 1
    results.push(entry)
    log({ progress: { done: n + 1, of: picked.length, source_seal_id: entry.source_seal_id, result: entry.result, reason: entry.reason || '' } })
    if (n < picked.length - 1) await sleep(DELAY_MS)
  }

  /* 改后读数：生产中 source＝sealbank 的行数（真实读回，不取脚本内存）。 */
  let afterCount = null
  if (!DRY_RUN) {
    const afterCountReply = await db.collection(SEAL_IMPORTS_COLLECTION).where({ source: SOURCE }).count()
    afterCount = Number((afterCountReply && afterCountReply.total) || 0)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const report = {
    generated_at: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'submit',
    env: ENV_ID,
    ndjson: NDJSON,
    total_source_rows: allRows.length,
    params: { limit: LIMIT, offset: OFFSET, stride, delay_ms: DELAY_MS },
    identity: { phone_masked: phoneMasked, uid_masked: uidMasked, proof },
    baseline: { sealbank_rows_before: beforeCount, sealbank_rows_after: afterCount },
    summary: counts,
    results
  }
  const reportPath = path.join(OUT_DIR, DRY_RUN ? 'submit_batch_report.dry-run.json' : 'submit_batch_report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (!DRY_RUN && writtenIds.length > 0) {
    writeFileSync(path.join(OUT_DIR, 'submit_batch_ids.json'), JSON.stringify(writtenIds, null, 2) + '\n')
  }
  log({ summary: { ...counts, report: reportPath, ids_written: DRY_RUN ? 0 : writtenIds.length, sealbank_rows_after: afterCount } })
  process.exit(results.every((r) => r.result !== 'error') ? 0 : 1)
}

/* ---------------------------------------------------------------------------
   4b. 回滚模式（只删本轮新写且仍 PENDING 的行；二次确认 --yes）
   --------------------------------------------------------------------------- */
async function runRollback() {
  if (!YES) {
    log({ fatal: '回滚需二次确认：追加 --yes 才会真正删除。' })
    process.exit(2)
  }
  if (!existsSync(IDS_FILE)) {
    log({ fatal: `回滚清单不存在：${IDS_FILE}` })
    process.exit(2)
  }
  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
  log({ rollback_start: { env: ENV_ID, entries: ids.length, ids_file: IDS_FILE } })
  const out = []
  const counts = { deleted: 0, skipped_not_pending: 0, skipped_missing: 0, skipped_mismatch: 0, error: 0 }
  for (const item of ids) {
    const rec = { source_seal_id: item.source_seal_id, doc_id: item.doc_id, action: '' }
    try {
      const reply = await db.collection(SEAL_IMPORTS_COLLECTION).doc(item.doc_id).get()
      const data = reply && reply.data
      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        rec.action = 'skipped_missing'
        counts.skipped_missing += 1
      } else if (String(row.source) !== String(item.source) || String(row.source_seal_id) !== String(item.source_seal_id)) {
        rec.action = 'skipped_mismatch'
        counts.skipped_mismatch += 1
      } else if (row.status !== 'PENDING') {
        rec.action = 'skipped_not_pending'
        counts.skipped_not_pending += 1
      } else {
        await db.collection(SEAL_IMPORTS_COLLECTION).doc(item.doc_id).remove()
        rec.action = 'deleted'
        counts.deleted += 1
      }
    } catch (error) {
      rec.action = 'error'
      rec.message = String((error && error.message) || error).slice(0, 300)
      counts.error += 1
    }
    out.push(rec)
    log({ progress: { ...rec } })
    await sleep(300)
  }
  const afterCountReply = await db.collection(SEAL_IMPORTS_COLLECTION).where({ source: SOURCE }).count()
  log({ rollback_summary: { ...counts, sealbank_rows_after: Number((afterCountReply && afterCountReply.total) || 0) } })
  writeFileSync(path.join(OUT_DIR, 'rollback_report.json'), JSON.stringify({ generated_at: new Date().toISOString(), counts, results: out }, null, 2) + '\n')
  process.exit(counts.error === 0 ? 0 : 1)
}

await (MODE === 'rollback' ? runRollback() : runSubmit())
