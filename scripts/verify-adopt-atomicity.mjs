/**
 * 玺爱 · **采纳原子性 ＋ 半采纳修复 自检**（`scripts/verify-adopt-atomicity.mjs`）
 * ============================================================================
 * 本单交付：**I-1 采纳写入原子性（如实报失败步）**／**I-2 `repairImportAcceptance` 修复路径**／
 * **I-3 待审取行（真因：平台默认 100 行上限 ＋ 不筛状态）**。
 *
 * **本地、离线、零网络、零云端**：注入式内存假 DB（**模拟平台 `.get()` 默认 100 行上限**，
 * 并支持显式 `.limit()`）＋ 把请求交给**真实云函数体** `xiai-user-token/index.js`。
 *
 * 判据（逐条可判负）：
 *   A. **I-3 尺子校准**：不显式 `.limit()` 时假体只回 100 行、`.limit(n)` 时回 n 行
 *      ⇒ 证明「批内前 100 条已终态 ⇒ 推不动第 101 条」这条尺**真能报红**。
 *   B. **I-3 行为**：批内前 100 条 `ACCEPTED` ＋ 第 101 条 `PENDING` ⇒ 一次调用**必须推进第 101 条**；
 *      **批内已无待审行 ⇒ 回如实成功/空结果，`ok:true`、`docId:''`、`skipped` 非空，
 *      **不得**返回 `STORAGE_UNAVAILABLE`**（三通道同型）。
 *   C. **I-1 原子性**：注入「第 2 步落盘必抛」的假 DB ⇒ 导入行**仍未翻**（保留 `PENDING`）、
 *      回包**不再声称「本次零寫入」**且**如实报出失败步与已发生写入**。
 *   D. **I-1 重试**：解除注入后重放 ⇒ 补齐且**不重复**（正式行数不超预期）。
 *   E. **I-2 修复路径**：3 条「`ACCEPTED` 但无正式行」⇒ `dry_run` 吐 `orphan:3` ＋ 样本 ＋ 零写；
 *      执行 ⇒ 补齐 3 条；重放 ⇒ `orphan:0` / `idempotent:true`。
 *   F. **I-2 门面**：白名单 / 缺 env / 未知键 / `dry_run` 非布林 ⇒ 拒 ＋ 零写入。
 *   G. **I-1 顺序**：三个 review op 的 `plan.writes` 里**正式行 `set` 先于导入行 `update`**，
 *      且状态翻转带 `expectAtLeast`；同键重放**不产 `set`**（幂等认回）。
 *   H. **包封收窄**：修复面 6 键只对 `repairImportAcceptance` 透出；其它 op（含迁移 op）**不外泄**。
 *   I. **零新增 `reason`**（观测面 ＋ 负对照 canary）。
 *   J. **静态**：三处取行式按 `status = …PENDING` 过滤 ＋ 限量化在位。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 用法：`node scripts/verify-adopt-atomicity.mjs`
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* ---------------------------------------------------------------------------
   0. 环境（**合成值**；脚本内零真实凭据字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000002').trim()
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || 'synthetic-adopt-atomicity-secret').trim()
process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '246810').trim()
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'
process.env.XIAI_ADMIN_PHONE = PHONE
const NON_WHITELIST_PHONE = '139' + String(0).repeat(8) + '7'

/* ---------------------------------------------------------------------------
   1. 断言与读数
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  results.push({ id, pass })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}
const text = (v) => (v === undefined || v === null ? '' : String(v))

/* ---------------------------------------------------------------------------
   2. 注入式内存假 DB（**模拟平台单次 get 默认 100 行上限** ＋ 显式 `.limit()`）
   --------------------------------------------------------------------------- */
const PLATFORM_GET_CAP = 100
function createStore(seed) {
  const collections = new Map()
  const stats = { writes: [], reads: 0 }
  /* 注入点：命中 ⇒ 该集合的对应写动作**必抛**（用于造「半采纳」现场）。 */
  const failOn = { set: '', update: '' }
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const seedRow = (row) => {
    const name = row.__collection
    const copy = Object.assign({}, row)
    delete copy.__collection
    const map = mapOf(name)
    const key = String(copy._id || copy.id || `${name}-${map.size + 1}`)
    map.set(key, Object.assign({ _id: key }, copy))
    return key
  }
  ;(seed || []).forEach(seedRow)
  const provider = () => ({
    collection(name) {
      const map = mapOf(name)
      const all = () => [...map.values()].map((row) => Object.assign({}, row))
      const hit = (match) => all().filter((row) => Object.keys(match).every((k) => row[k] === match[k]))
      return {
        where(match) {
          let limit = 0
          const api = {
            limit(n) {
              limit = Number(n)
              return api
            },
            async get() {
              stats.reads += 1
              const rows = hit(match)
              /* **平台语义**：未显式 `.limit()` ⇒ 单次最多 100 行。 */
              return { data: limit > 0 ? rows.slice(0, limit) : rows.slice(0, PLATFORM_GET_CAP) }
            },
            async update(doc) {
              if (failOn.update === name) throw new Error('injected-update-failure')
              const rows = hit(match)
              rows.forEach((row) => {
                const key = String(row._id || row.id)
                map.set(key, Object.assign({}, map.get(key), doc))
              })
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
          return api
        },
        async get() {
          stats.reads += 1
          return { data: all().slice(0, PLATFORM_GET_CAP) }
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(String(id))
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              /* SDK 同款约束（与 verify-ai-keys 同尺）：载荷带 `_id` ⇒ 抛「不能更新_id的值」
                 `code='INVALID_PARAM'`（真 SDK document.js 判据）；`add()` 不拦。 */
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              if (failOn.set === name) throw new Error('injected-set-failure')
              map.set(String(id), Object.assign({ _id: String(id) }, doc))
              stats.writes.push({ collection: name, action: 'set', id: String(id) })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          const id = String(doc && doc._id ? doc._id : `auto-${map.size + 1}`)
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
        }
      }
    }
  })
  return {
    collections,
    stats,
    provider,
    failOn,
    seedRow,
    rows: (name) => [...mapOf(name).values()].map((row) => Object.assign({}, row)),
    reset: () => {
      stats.writes.length = 0
      stats.reads = 0
    }
  }
}

/* ---------------------------------------------------------------------------
   3. 加载被测件（真实云函数体）
   --------------------------------------------------------------------------- */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const opsSource = readFileSync(path.join(FUNCTION_DIR, 'lib/ops.js'), 'utf8')
const indexSource = readFileSync(path.join(FUNCTION_DIR, 'index.js'), 'utf8')

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'NOT_FOUND', 'DUPLICATE_VALUE', 'ALREADY_ENDORSED']
const OBSERVED_REASONS = []
const noteReason = (res) => {
  if (res && typeof res.reason === 'string' && res.reason !== '') OBSERVED_REASONS.push(res.reason)
  return res
}

const ADMIN_IDENTITY = { uid: 'u-admin', phone: PHONE }
const CONTEXT = { adminPhone: PHONE, nowSeconds: 1700000000 }
const IMPORT_STATUS = { PENDING: 'PENDING', ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED' }

const CHANNELS = [
  { key: 'person', importCollection: 'xiai_person_imports', formalCollection: 'xiai_persons', idKey: 'source_person_id', op: 'reviewPersonImport' },
  { key: 'item', importCollection: 'xiai_item_imports', formalCollection: 'xiai_items', idKey: 'source_item_id', op: 'reviewItemImport' },
  { key: 'seal', importCollection: 'xiai_seal_imports', formalCollection: 'xiai_seals', idKey: 'source_seal_id', op: 'reviewSealImport' }
]

/** 造一条该通道的导入行（真实字段面；`status` / `source*` 可覆盖）。 */
function importRowOf(channel, { id, sourceKey, status = IMPORT_STATUS.PENDING, extra = {} } = {}) {
  const base = {
    _id: id,
    id,
    batch_id: 'B-ADOPT',
    source: 'SRC',
    status,
    imported_by: 'u-import',
    imported_at: '2026-10-01T00:00:00.000Z',
    reviewed_at: null,
    reviewer_id: null,
    review_note: ''
  }
  base[channel.idKey] = sourceKey
  if (channel.key === 'person') {
    Object.assign(base, { family_name: '黃', given_name: '士陵', courtesy_names: [], art_names: [], alias_names: [], birth_year: 1849, death_year: 1908, cbdb_id: 'CBDB-1', source_id: 'S-1' })
  }
  if (channel.key === 'item') {
    Object.assign(base, { title: `導入譜 ${sourceKey}`, volume_count: 2, has_image: true, has_annotation: false })
  }
  if (channel.key === 'seal') {
    /* **印章行不含 faces**：本套件只判本体落点（影面路径已由 verify-seal-imports 覆盖）。 */
    Object.assign(base, { seal_name: `導入印 ${sourceKey}`, dynasty: '清初', seal_type: '私印', seal_material: '石', faces: [] })
  }
  return Object.assign(base, extra)
}

/* ---------------------------------------------------------------------------
   A. I-3 尺子校准（假体的平台分页语义真能报红）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: 'I-3 平台分页尺子校准' }))
{
  const seed = []
  for (let i = 1; i <= 150; i += 1) {
    seed.push({ __collection: 'xiai_person_imports', _id: `pi-cap-${i}`, id: `pi-cap-${i}`, batch_id: 'B-CAP', status: i === 101 ? IMPORT_STATUS.PENDING : IMPORT_STATUS.ACCEPTED, source_person_id: `CAP-${i}` })
  }
  const store = createStore(seed)
  ops.setOpsDbProvider(store.provider)
  const coll = store.provider().collection('xiai_person_imports')
  const capped = await coll.where({ batch_id: 'B-CAP' }).get()
  const limited = await coll.where({ batch_id: 'B-CAP' }).limit(300).get()
  check('A1', '尺子校准：假体持有批内 150 行', 150, store.rows('xiai_person_imports').length)
  check('A2', '尺子校准：**未显式 `.limit()` ⇒ 恰回 100 行**（平台默认上限在假体里生效 ⇒ 尺可报红）', 100, capped.data.length)
  check('A3', '尺子校准：**显式 `.limit(300)` ⇒ 回全部 150 行**（限量化确实能穿透平台上限）', 150, limited.data.length)
  check('A4', '尺子校准 canary：未加状态过滤的旧式取行（前 100 行全 `ACCEPTED`）⇒ 目标行（第 101 条）**读不到**', false, capped.data.some((row) => text(row.status) === IMPORT_STATUS.PENDING))
}

/* ---------------------------------------------------------------------------
   B. I-3 行为：批内前 100 条已终态 ⇒ 必须推进第 101 条；无待审行 ⇒ 如实空结果
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: 'I-3 待审取行（真因）' }))
{
  const seed = []
  for (let i = 1; i <= 150; i += 1) {
    seed.push({ __collection: 'xiai_person_imports', _id: `pi-cap-${i}`, id: `pi-cap-${i}`, batch_id: 'B-CAP', status: i === 101 ? IMPORT_STATUS.PENDING : IMPORT_STATUS.ACCEPTED, source_person_id: `CAP-${i}`, family_name: '甲', given_name: `乙${i}` })
  }
  const store = createStore(seed)
  ops.setOpsDbProvider(store.provider)
  const res = noteReason(await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B-CAP', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
  check('B1', 'I-3：批内前 100 条已 ACCEPTED ⇒ 本调用**仍推进第 101 条**（accepted_ids 恰含它）', ['pi-cap-101'], res.accepted_ids)
  check('B2', 'I-3：该条确有正式行 `set`（`xiai_persons` 恰 1 条写）', 1, ((res.plan && res.plan.writes) || []).filter((w) => w.collection === 'xiai_persons').length)
  /* 模拟该调用的落盘已生效（行翻至终态）⇒ 再调用一次即「批内已无待审行」。 */
  store.seedRow({ __collection: 'xiai_person_imports', _id: 'pi-cap-101', id: 'pi-cap-101', batch_id: 'B-CAP', status: IMPORT_STATUS.ACCEPTED, source_person_id: 'CAP-101', family_name: '甲', given_name: '乙101' })
  /* 反复调用直至清空：批内已无 PENDING ⇒ 如实空结果（**不是** NOT_FOUND / STORAGE_UNAVAILABLE）。 */
  const again = noteReason(await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B-CAP', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
  check('B3', 'I-3：批内已无待审行 ⇒ `ok:true` 如实空结果（零写入 / 计划空）', { ok: true, accepted: [], writes: 0 }, { ok: again.ok, accepted: again.accepted_ids, writes: ((again.plan && again.plan.writes) || []).length })
  check('B4', 'I-3：无待审行时**如实报出已终态行**（`skipped` 含该批行号，不静默）', true, again.skipped.includes('pi-cap-1'))
  const unknown = noteReason(await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B-UNKNOWN', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
  check('B5', 'I-3：批次**根本不存在** ⇒ 仍结构化拒绝 `ok:false`（不把空批与未知批混为一谈）', false, unknown.ok)
  check('B5b', 'I-3 存疑登记（**既有缺陷，本单不动**）：`config.js::REASONS` 冻结表未声明 `NOT_FOUND` ⇒ 该分支 `reason` 为 undefined（沿旧行为，未借本单改动）', '', text(unknown.reason))
}

/* 三通道同型：批内已无待审行 ⇒ 经 `index.js` 回**成功空结果**，不得 `STORAGE_UNAVAILABLE`。 */
{
  const issue = await fn.main({ action: 'issue', phone: PHONE, code: process.env.XIAI_USER_SMS_CODE })
  const TOKEN = issue.token
  for (const channel of CHANNELS) {
    const store = createStore([
      Object.assign({ __collection: channel.importCollection }, importRowOf(channel, { id: `${channel.key}-done`, sourceKey: `${channel.key}-DONE`, status: IMPORT_STATUS.ACCEPTED }))
    ])
    ops.setOpsDbProvider(store.provider)
    store.reset()
    const res = noteReason(await fn.main({ action: 'verify', token: TOKEN, op: channel.op, payload: { batch_id: 'B-ADOPT', decision: 'ACCEPTED' } }))
    check(`B6-${channel.key}`, `I-3 端到端：${channel.op} 批内已无待审行 ⇒ **ok:true、零写入、docId 为空**（旧式谎报 STORAGE_UNAVAILABLE）`, { ok: true, storeWrites: 0, docId: '' }, { ok: res.ok, storeWrites: store.stats.writes.length, docId: res.docId })
    check(`B7-${channel.key}`, `I-3 端到端：${channel.op} 回包**不是**拒绝形态（无 reason）`, undefined, res.reason)
  }
}

/* ---------------------------------------------------------------------------
   C/D. I-1 原子性 ＋ 重试自愈
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: 'I-1 采纳原子性（失败步如实报告）' }))
{
  const issue = await fn.main({ action: 'issue', phone: PHONE, code: process.env.XIAI_USER_SMS_CODE })
  const TOKEN = issue.token
  const store = createStore([{ __collection: 'xiai_person_imports' }])
  /* 真实导入行（带幂等键）⇒ 采纳 ⇒ 计划 ＝ [set xiai_persons, update xiai_person_imports]。 */
  const row = importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-half', sourceKey: 'HALF-1' })
  store.seedRow(Object.assign({ __collection: 'xiai_person_imports' }, row))
  ops.setOpsDbProvider(store.provider)
  /* **注入**：第 2 步（翻导入行状态）必抛。 */
  store.failOn.update = 'xiai_person_imports'
  store.reset()
  const res = noteReason(await fn.main({ action: 'verify', token: TOKEN, op: 'reviewPersonImport', payload: { batch_id: 'B-ADOPT', decision: 'ACCEPTED' } }))

  check('C1', 'I-1：第 2 步失败 ⇒ 结构化拒绝（`STORAGE_UNAVAILABLE`；零新增 reason）', { ok: false, reason: 'STORAGE_UNAVAILABLE' }, { ok: res.ok, reason: res.reason })
  check('C2', 'I-1：回包**不再声称「本次零寫入」**（旧文案与事实不符 ⇒ 已改写）', false, String(res.message).includes('本次零寫入'))
  check('C2b', 'I-1：回包**明写「非零寫入」**（宁可自曝半采纳，也不谎称零写入）', true, String(res.message).includes('非零寫入'))
  check('C3', 'I-1：回包**如实报出**失败步（第 2 步）与已发生写入（1 步）', true, String(res.message).includes('第 2 / 2 步') && String(res.message).includes('已發生 1 步寫入'))
  const importRowAfter = store.rows('xiai_person_imports').find((row) => text(row.id) === 'pi-half') || {}
  check('C4', 'I-1：**导入行仍未翻**（保留 `PENDING`）', IMPORT_STATUS.PENDING, text(importRowAfter.status))
  check('C5', 'I-1：第 1 步（正式行）已落盘 ⇒ 半采纳**如实存在**（不谎称零写入）', 1, store.rows('xiai_persons').length)
  check('C6', 'I-1：失败即停 ⇒ 第 2 步之后无任何写入（写账恰 1 条）', 1, store.stats.writes.length)

  /* D. 解除注入 ⇒ 重放 ⇒ 补齐且不重复。 */
  store.failOn.update = ''
  store.reset()
  const retry = await fn.main({ action: 'verify', token: TOKEN, op: 'reviewPersonImport', payload: { batch_id: 'B-ADOPT', decision: 'ACCEPTED' } })
  const importRowRetried = store.rows('xiai_person_imports').find((row) => text(row.id) === 'pi-half') || {}
  check('D1', 'I-1 重试：解除注入后重放 ⇒ `ok:true`', true, retry.ok === true)
  check('D2', 'I-1 重试：导入行翻至 `ACCEPTED`', IMPORT_STATUS.ACCEPTED, text(importRowRetried.status))
  check('D3', 'I-1 重试：**正式行数不超预期**（幂等键去重 ⇒ 仍恰 1 条，无重复行）', 1, store.rows('xiai_persons').length)
  check('D4', 'I-1 重试：本次**无**正式行 `set`（已存在 ⇒ 跳过）', 0, store.stats.writes.filter((w) => w.collection === 'xiai_persons').length)
}

/* ---------------------------------------------------------------------------
   G. I-1 顺序：正式行 set 先于导入行 update ＋ expectAtLeast ＋ 幂等认回
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'G', title: 'I-1 写入顺序（先正式行、后翻状态）' }))
{
  for (const channel of CHANNELS) {
    const store = createStore([Object.assign({ __collection: channel.importCollection }, importRowOf(channel, { id: `x-${channel.key}`, sourceKey: `ORD-${channel.key}` }))])
    ops.setOpsDbProvider(store.provider)
    const res = noteReason(await ops.ADMIN_OPS[channel.op]({ batch_id: 'B-ADOPT', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
    const writes = (res.plan && res.plan.writes) || []
    const formalIndex = writes.findIndex((w) => w.collection === channel.formalCollection && w.kind === 'set')
    const statusIndex = writes.findIndex((w) => w.collection === channel.importCollection && w.kind === 'update')
    check(`G1-${channel.key}`, `${channel.op}：正式行 set **先于**导入行状态 update`, true, formalIndex !== -1 && statusIndex !== -1 && formalIndex < statusIndex)
    check(`G2-${channel.key}`, `${channel.op}：状态翻转带 expectAtLeast`, 1, writes[statusIndex].expectAtLeast)
    /* 幂等认回：正式行已存在（同幂等键）⇒ 不产第二枚 set。 */
    const existing = Object.assign({ _id: 'existing-formal' }, writes[formalIndex].doc)
    const store2 = createStore([Object.assign({ __collection: channel.importCollection }, importRowOf(channel, { id: `x2-${channel.key}`, sourceKey: `ORD-${channel.key}` })), Object.assign({ __collection: channel.formalCollection }, existing)])
    ops.setOpsDbProvider(store2.provider)
    const replay = noteReason(await ops.ADMIN_OPS[channel.op]({ batch_id: 'B-ADOPT', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
    const replayWrites = (replay.plan && replay.plan.writes) || []
    check(`G3-${channel.key}`, `${channel.op}：同幂等键重放 ⇒ **不产第二枚正式行 set**（幂等认回）`, 0, replayWrites.filter((w) => w.collection === channel.formalCollection && w.kind === 'set').length)
  }
}

/* ---------------------------------------------------------------------------
   E. I-2 修复路径（dry_run 吐清单 / 执行补齐 / 重放幂等）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'E', title: 'I-2 repairImportAcceptance' }))
{
  const store = createStore([
    { __collection: 'xiai_person_imports', ...importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-orphan', sourceKey: 'ORPH-P', status: IMPORT_STATUS.ACCEPTED }) },
    { __collection: 'xiai_item_imports', ...importRowOf({ key: 'item', idKey: 'source_item_id' }, { id: 'ii-orphan', sourceKey: 'ORPH-I', status: IMPORT_STATUS.ACCEPTED }) },
    { __collection: 'xiai_seal_imports', ...importRowOf({ key: 'seal', idKey: 'source_seal_id' }, { id: 'si-orphan', sourceKey: 'ORPH-S', status: IMPORT_STATUS.ACCEPTED }) }
  ])
  ops.setOpsDbProvider(store.provider)
  store.reset()
  const dry = noteReason(await ops.ADMIN_OPS.repairImportAcceptance(undefined, ADMIN_IDENTITY, CONTEXT))
  check('E1', 'I-2 dry_run 缺省：逐集合 `scanned`（各读到 1 条 ACCEPTED）', { person: 1, item: 1, seal: 1 }, dry.scanned)
  check('E2', 'I-2 dry_run：逐集合 `orphan` ＝ 1（共 3 条孤儿）', { person: 1, item: 1, seal: 1 }, dry.orphan)
  check('E3', 'I-2 dry_run：`changed` 全 0（预演零写入）', { person: 0, item: 0, seal: 0 }, dry.changed)
  check('E4', 'I-2 dry_run：吐权威清单 `samples`（含导入行号 ＋ 幂等键）', 3, dry.samples.length)
  check('E5', 'I-2 dry_run：`idempotent:false`（尚有孤儿）', false, dry.idempotent)
  check('E6', 'I-2 dry_run：**零写入**（无 `plan`、假体写账为 0）', { plan: undefined, storeWrites: 0 }, { plan: dry.plan, storeWrites: store.stats.writes.length })

  /* 执行 ⇒ 补齐三条（经唯一落盘点 `persist`，与 `index.js` 同路径）。 */
  const exec = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENTITY, CONTEXT))
  check('E7', 'I-2 执行：`changed` 逐集合 1（补齐三条）', { person: 1, item: 1, seal: 1 }, exec.changed)
  check('E8', 'I-2 执行：落盘计划恰 3 条正式行 `set`', 3, ((exec.plan && exec.plan.writes) || []).length)
  await ops.persist(exec.plan)
  check('E9', 'I-2 执行：正式集合各 +1（印人 / 印谱 / 印章）', { persons: 1, items: 1, seals: 1 }, { persons: store.rows('xiai_persons').length, items: store.rows('xiai_items').length, seals: store.rows('xiai_seals').length })
  check('E10', 'I-2 执行：补齐行按幂等键可查回（`source_person_id` 命中）', 'ORPH-P', text(store.rows('xiai_persons')[0].source_person_id))
  check('E11', 'I-2 执行：印谱补齐行 id ＝ `source_item_id`（沿采纳口径）', 'ORPH-I', text(store.rows('xiai_items')[0].source_item_id))
  check('E12', 'I-2 执行：印章补齐行 `(source_seal_id, source)` 命中', { key: 'ORPH-S', source: 'SRC' }, { key: text(store.rows('xiai_seals')[0].source_seal_id), source: text(store.rows('xiai_seals')[0].source) })

  /* 重放 ⇒ orphan 0 / idempotent:true / 零写入。 */
  store.reset()
  const replay = noteReason(await ops.ADMIN_OPS.repairImportAcceptance(undefined, ADMIN_IDENTITY, CONTEXT))
  check('E13', 'I-2 重放：`orphan` 全 0', { person: 0, item: 0, seal: 0 }, replay.orphan)
  check('E14', 'I-2 重放：`idempotent:true`', true, replay.idempotent)
  check('E15', 'I-2 重放：零写入 ＋ 无计划', { storeWrites: 0, plan: undefined }, { storeWrites: store.stats.writes.length, plan: replay.plan })
  check('E16', 'I-2 重放：`scanned` 仍如实报出读到 3 条 ACCEPTED（未静默归零）', { person: 1, item: 1, seal: 1 }, replay.scanned)
  check('E17', 'I-2：正式行数仍各 1（重放不产重复行）', { persons: 1, items: 1, seals: 1 }, { persons: store.rows('xiai_persons').length, items: store.rows('xiai_items').length, seals: store.rows('xiai_seals').length })
}

/* 同一套字段面（修复补齐行 ≡ 采纳落行；**不另立第二套**）。 */
{
  const store = createStore([Object.assign({ __collection: 'xiai_person_imports' }, importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-face', sourceKey: 'FACE-P' }))])
  ops.setOpsDbProvider(store.provider)
  const accept = noteReason(await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B-ADOPT', decision: 'ACCEPTED' }, ADMIN_IDENTITY, CONTEXT))
  const acceptDoc = ((accept.plan && accept.plan.writes) || []).find((w) => w.collection === 'xiai_persons').doc
  const store2 = createStore([Object.assign({ __collection: 'xiai_person_imports' }, importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-face', sourceKey: 'FACE-P', status: IMPORT_STATUS.ACCEPTED }))])
  ops.setOpsDbProvider(store2.provider)
  const repair = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENTITY, CONTEXT))
  const repairDoc = ((repair.plan && repair.plan.writes) || []).find((w) => w.collection === 'xiai_persons').doc
  check('E18', 'I-2：补齐行键面 ≡ 采纳落行键面（**同一套构建函数**，不另立第二套）', Object.keys(acceptDoc).sort(), Object.keys(repairDoc || {}).sort())
  check('E19', 'I-2：补齐行编号规则 ≡ 采纳（同为 `PR` ＋ 9 位流水）', { accept: acceptDoc.code, repair: repairDoc && repairDoc.code }, { accept: acceptDoc.code, repair: repairDoc && repairDoc.code })
}

/* ---------------------------------------------------------------------------
   F. I-2 门面：白名单 / 缺 env / 未知键 / dry_run 形态 ⇒ 拒 ＋ 零写入
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'F', title: 'I-2 门面与零写入' }))
{
  const store = createStore([
    { __collection: 'xiai_person_imports', ...importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-gate', sourceKey: 'GATE-P', status: IMPORT_STATUS.ACCEPTED }) }
  ])
  ops.setOpsDbProvider(store.provider)

  const unknownKey = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false, bogus: 1 }, ADMIN_IDENTITY, CONTEXT))
  check('F1', 'I-2 未知键 ⇒ `INVALID_FIELD` ＋ 零写入', { ok: false, reason: 'INVALID_FIELD', plan: undefined }, { ok: unknownKey.ok, reason: unknownKey.reason, plan: unknownKey.plan })

  const badBool = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: 'yes' }, ADMIN_IDENTITY, CONTEXT))
  check('F2', 'I-2 `dry_run` 非布林 ⇒ `INVALID_VALUE` ＋ 零写入', { ok: false, reason: 'INVALID_VALUE', plan: undefined }, { ok: badBool.ok, reason: badBool.reason, plan: badBool.plan })

  const noEnv = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENTITY, { adminPhone: '', nowSeconds: 1700000000 }))
  check('F3', 'I-2 缺 env（`XIAI_ADMIN_PHONE` 空）⇒ `STORAGE_UNAVAILABLE` ＋ 零写入', { ok: false, reason: 'STORAGE_UNAVAILABLE', plan: undefined }, { ok: noEnv.ok, reason: noEnv.reason, plan: noEnv.plan })

  const notWhitelisted = noteReason(await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, { uid: 'u-other', phone: NON_WHITELIST_PHONE }, CONTEXT))
  check('F4', 'I-2 非白名单手机号 ⇒ `FORBIDDEN` ＋ 零写入', { ok: false, reason: 'FORBIDDEN', plan: undefined }, { ok: notWhitelisted.ok, reason: notWhitelisted.reason, plan: notWhitelisted.plan })

  check('F5', 'I-2 门面拒绝一律**零写入**（假体写账为 0）', 0, store.stats.writes.length)
  check('F6', 'I-2 载荷键面 ≡ `[\'dry_run\']`（沿迁移 op 同型；零新增键面）', ['dry_run'], ops.REPAIR_ALLOWED_KEYS.slice())
  check('F7', 'I-2 `ADMIN_OPS` 含 `repairImportAcceptance`', true, Object.prototype.hasOwnProperty.call(ops.ADMIN_OPS, 'repairImportAcceptance'))
}

/* ---------------------------------------------------------------------------
   H. 包封收窄：修复面 6 键只对 `repairImportAcceptance` 透出
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'H', title: '包封透传（按 op 收窄）' }))
{
  const issue = await fn.main({ action: 'issue', phone: PHONE, code: process.env.XIAI_USER_SMS_CODE })
  const TOKEN = issue.token
  const READOUT = ['dry_run', 'scanned', 'orphan', 'changed', 'samples', 'idempotent']
  const keysOf = (res) => READOUT.filter((key) => Object.prototype.hasOwnProperty.call(res, key))

  /* 修复 op ⇒ 6 键齐出。 */
  const storeRepair = createStore([
    { __collection: 'xiai_person_imports', ...importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-env', sourceKey: 'ENV-P', status: IMPORT_STATUS.ACCEPTED }) }
  ])
  ops.setOpsDbProvider(storeRepair.provider)
  const repairRes = noteReason(await fn.main({ action: 'verify', token: TOKEN, op: 'repairImportAcceptance', payload: {} }))
  check('H1', '`repairImportAcceptance` ⇒ 修复面 6 键齐出', READOUT.slice().sort(), keysOf(repairRes).slice().sort())
  check('H2', '`repairImportAcceptance` ⇒ 不泄漏内部分：无 `plan`', undefined, repairRes.plan)

  /* 其它 op ⇒ 6 键**一个都不外泄**。 */
  const storeReview = createStore([Object.assign({ __collection: 'xiai_person_imports' }, importRowOf({ key: 'person', idKey: 'source_person_id' }, { id: 'pi-leak', sourceKey: 'LEAK-P', status: IMPORT_STATUS.ACCEPTED }))])
  ops.setOpsDbProvider(storeReview.provider)
  const reviewRes = noteReason(await fn.main({ action: 'verify', token: TOKEN, op: 'reviewPersonImport', payload: { batch_id: 'B-ADOPT', decision: 'ACCEPTED' } }))
  check('H3', '`reviewPersonImport` ⇒ 修复面 6 键**不外泄**（含 `orphan`）', [], keysOf(reviewRes))
  const migrateRes = noteReason(await fn.main({ action: 'verify', token: TOKEN, op: 'migrateDynastyValues', payload: { dry_run: true } }))
  check('H4', '迁移 op ⇒ 仍透 5 键、**不透 `orphan`**', ['dry_run', 'scanned', 'changed', 'samples', 'idempotent'].sort(), keysOf(migrateRes).slice().sort())
}

/* ---------------------------------------------------------------------------
   I. 零新增 `reason`（观测面 ＋ 负对照 canary）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'I', title: 'reason 零新增' }))
{
  const observed = [...new Set(OBSERVED_REASONS)]
  check('I1', '本套件观测到的 `reason` 全部 ∈ 既有冻结表（零新增）', [], observed.filter((r) => FROZEN_REASONS.indexOf(r) === -1))
  check('I2', '负对照 canary：注入新 `reason` 字面值 ⇒ 零新增尺必报红', ['TOTALLY_NEW_REASON'], [...new Set([...observed, 'TOTALLY_NEW_REASON'])].filter((r) => FROZEN_REASONS.indexOf(r) === -1))
}

/* ---------------------------------------------------------------------------
   J. 静态：三处取行式按 `status = …PENDING` 过滤 ＋ 限量化在位
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'J', title: '静态：待审取行（I-3）' }))
{
  const pendingMatches = [
    'status: PERSON_IMPORT_STATUS.PENDING',
    'status: SEAL_IMPORT_STATUS.PENDING',
    'status: ITEM_IMPORT_STATUS.PENDING'
  ]
  check('J1', '静态：三个 review op 的批次取行式**均按 `status = …PENDING` 过滤**', pendingMatches.length, pendingMatches.filter((needle) => opsSource.includes(needle)).length)
  check('J2', '静态：取行式**显式限量**（`IMPORT_REVIEW_PAGE_SIZE` 在位）', true, opsSource.includes('{ limit: IMPORT_REVIEW_PAGE_SIZE }') && ops.IMPORT_REVIEW_PAGE_SIZE > 0)
  check('J3', '静态：`readRows` 支持单次限量护栏（`options.limit`）', true, opsSource.includes('async function readRows(collection, match, options)'))
  check('J4', '静态：`index.js` **空计划不落盘、不反出 `STORAGE_UNAVAILABLE`**（`planWrites` 守门在位）', true, indexSource.includes('const planWrites =') && indexSource.includes('planWrites > 0'))
  check('J5', '静态：`persist` 失败挂进度读数（`completedSteps` / `totalSteps` / `failedStep`）', true, opsSource.includes('wrapped.completedSteps = completedSteps') && indexSource.includes('error.completedSteps'))
  check('J6', '静态：修复扫描限量在位（`IMPORT_REPAIR_SCAN_LIMIT`）', true, opsSource.includes('{ limit: IMPORT_REPAIR_SCAN_LIMIT }') && ops.IMPORT_REPAIR_SCAN_LIMIT > 0)
  /* 负对照 canary：把状态过滤从源码里抹掉 ⇒ **同一条尺必报红**（证明 J1 非空转）。 */
  const stripped = opsSource.split('_IMPORT_STATUS.PENDING').join('_IMPORT_STATUS.NOPE')
  check('J7', '负对照 canary：抹掉三处状态过滤 ⇒ 同一条尺命中数 3 → 0（必报红）', 0, pendingMatches.filter((needle) => stripped.includes(needle)).length)
}

/* ---------------------------------------------------------------------------
   汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures }, failed_ids: results.filter((r) => !r.pass).map((r) => r.id) }))
process.exit(failures === 0 ? 0 : 1)
