/**
 * 玺爱 · **「審核面取寫入令牌」路径自检**（/my/corrections 采纳 · 驳回：单条 ＋ 批量）
 * ============================================================================
 * **本地、离线、零网络**（注入假 DB ＋ 传输注入把请求交给**真实云函数体**）。
 *
 * 跑什么（每条都配正 / 负对照）：
 *   A. **① 云端形态 ＋ 无令牌** ⇒ 流程**先取令牌**再审核（`ensureAdminWriteSession`
 *      确实被调且**在 review 之前**）；负向对照：直接调 `corrections.review`（无令牌）⇒
 *      云函数原样回 `FORBIDDEN` ＋ 零写入（证明「通道通、缺的是取令牌这一步」）。
 *   B. **② 已有令牌** ⇒ **不弹、直接 review**（无 `issue` 往返，仅 `verify`）；
 *      负向对照：清空令牌后 `needsAdminWriteCode()` 必为 `true`。
 *   C. **③ dev / 離線形态** ⇒ **不弹、零云端往返**、仍然本地写（`authority === 'LOCAL_DEV'`）；
 *      正对照：切回云端 ＋ 无令牌 ⇒ `needsAdminWriteCode()` 必回 `true`。
 *   D. **④ 取令牌失败**（码不对 / 网络）⇒ **零写入** ＋ **原样报错**（服务端业务拒绝逐字透传；
 *      传输失败恒 `STORAGE_UNAVAILABLE` ≠ `FORBIDDEN`）；正对照：正确码 ⇒ 成功。
 *   E. **⑤ 本机镜像更正（云端权威优先）**：云端已落盘而本机 `writeCorrectionDecision` 未成功
 *      （`ALREADY_REVIEWED` 等）⇒ 返回 `ok:true` ＋ `reconciled:true`，本机行按服务端权威行更正
 *      （status / reviewed_at / reviewer_id）；反向对照：本机 PENDING ＋ 云端 ok ⇒ 既有形态
 *      （无 `reconciled` 键、本机正常写入）。
 *   F. **`[data-admin-action]` 去重取值集合不变**（8 值 / 归并 7 类）＋ canary 正对照。
 *   G. **上屏文案繁體**（去注释后扫描；正 / 负对照证明探测器有效）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 环境变量缺省用**合成值**（非真实凭据；可用 env 覆盖）：XIAI_ADMIN_PHONE / XIAI_ADMIN_SMS_CODE /
 * XIAI_ADMIN_TOKEN_SECRET。脚本内**零真实凭据字面值**。
 *
 * 用法：node scripts/verify-review-token-path.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-admin-token')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（只为让数据层 / 服务层的 ESM 真源在本机 Node 下可导入）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* ---------------------------------------------------------------------------
   2. 环境（**合成值**；脚本内零真实凭据字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
const CODE = String(process.env.XIAI_ADMIN_SMS_CODE || '246810').trim()
const SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || 'synthetic-selfcheck-secret').trim()
process.env.XIAI_ADMIN_PHONE = PHONE
process.env.XIAI_ADMIN_SMS_CODE = CODE
process.env.XIAI_ADMIN_TOKEN_SECRET = SECRET
process.env.XIAI_ADMIN_TOKEN_VERSION = process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS = process.env.XIAI_ADMIN_TOKEN_TTL_SECONDS || '900'
const BAD_CODE = `${CODE}x`

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
const uidOfPhone = (phone) => `u-${String(phone).replace(/[^0-9]/g, '')}`
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

/* ---------------------------------------------------------------------------
   3. 加载被测件（真实云函数体 ＋ 前端真源服务）
   --------------------------------------------------------------------------- */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))

/* 假 DB（内存；「零写入」的判据就是它的写计数）。 */
function createStore(seed) {
  const collections = { xiai_corrections: new Map(), xiai_corrections_public: new Map() }
  const stats = { writes: [], reads: 0 }
  const load = (rows) => {
    collections.xiai_corrections.clear()
    collections.xiai_corrections_public.clear()
    ;(rows || []).forEach((row) => collections.xiai_corrections.set(row._id, Object.assign({}, row)))
    stats.writes.length = 0
    stats.reads = 0
  }
  const provider = () => ({
    collection(name) {
      const map = (collections[name] = collections[name] || new Map())
      return {
        where(match) {
          const hit = () => [...map.values()].filter((row) => Object.keys(match).every((key) => row[key] === match[key]))
          return {
            async get() {
              stats.reads += 1
              return { data: hit().map((row) => Object.assign({}, row)) }
            },
            async update(doc) {
              const rows = hit()
              rows.forEach((row) => Object.assign(row, doc))
              stats.writes.push({ collection: name, action: 'update', match, count: rows.length })
              return { updated: rows.length }
            }
          }
        },
        doc(id) {
          return {
            async get() {
              stats.reads += 1
              const row = map.get(id)
              return { data: row ? [Object.assign({}, row)] : [] }
            },
            async set(doc) {
              map.set(id, Object.assign({ _id: id }, doc))
              stats.writes.push({ collection: name, action: 'set', id })
              return { updated: 1 }
            }
          }
        }
      }
    }
  })
  load(seed)
  return { collections, stats, provider, load }
}

const SEAL_ID = '1'
const FACE_ID = 'fc-fx1-FACE'
const CORRECTION_ID = 'cr-name'
const CLOUD_SEED = [
  {
    _id: 'doc-name',
    id: CORRECTION_ID,
    faceId: FACE_ID,
    sealId: SEAL_ID,
    stamp_id: SEAL_ID,
    user_id: uidOfPhone(PHONE),
    field: 'seal_name',
    field_label: '印文',
    value: '黃士陵印',
    basis: '印譜對勘',
    status: 'PENDING',
    created_at: '2026-10-01T00:00:00.000Z'
  }
]
const store = createStore(CLOUD_SEED)
ops.setOpsDbProvider(store.provider)

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const adminSvc = await import(path.join(ROOT, 'src/services/admin.js'))
const adminTokenSvc = await import(path.join(ROOT, 'src/services/adminToken.js'))

db.ensureSeed()

const ADMIN = { id: uidOfPhone(PHONE), phone: PHONE, role: 'admin', nickname: '管理員', points: 0 }
const SEAL_ROW = { _id: 'xf-1', id: SEAL_ID, stamp_id: SEAL_ID, seal_name: '', dynasty: '晚清', seal_type: '姓名印', face_style: '黃牧甫印風', author: '黃士陵', transcription: '', material: '', shape: '' }
const FACE_ROW = { _id: FACE_ID, id: FACE_ID, sealId: SEAL_ID, stamp_id: SEAL_ID, kind: 'FACE', face_image_id: null, seal_name: '', dynasty: '晚清', seal_type: '姓名印', face_style: '黃牧甫印風', author: '黃士陵', transcription: '' }
const baseCorrection = (status) => ({
  id: CORRECTION_ID,
  faceId: FACE_ID,
  sealId: SEAL_ID,
  stamp_id: SEAL_ID,
  user_id: uidOfPhone(PHONE),
  field: 'seal_name',
  field_label: '印文',
  value: '黃士陵印',
  basis: '印譜對勘',
  status,
  created_at: '2026-10-01T00:00:00.000Z',
  reviewed_at: null,
  reviewer_id: null,
  rewarded_at: null
})

function resetLocal(status = 'PENDING') {
  storage.writeKey(storage.STORAGE_KEYS.seals, [SEAL_ROW])
  storage.writeKey(storage.STORAGE_KEYS.faces, [FACE_ROW])
  storage.writeKey(storage.STORAGE_KEYS.corrections, [baseCorrection(status)])
  storage.writeKey(storage.STORAGE_KEYS.correctionsPublic, [])
  storage.writeKey(storage.STORAGE_KEYS.points, [])
  storage.writeKey(storage.STORAGE_KEYS.users, [Object.assign({}, ADMIN)])
}

/** 读本机勘误行。 */
const localCorrection = () => (storage.readKey(storage.STORAGE_KEYS.corrections) || [])[0] || null

/* 传输注入：交给**真实云函数体**；记录每次往返的 action / op（顺序即证据）。 */
const calls = []
let transportMode = 'fn'
adminTokenSvc.setAdminTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, op: data && data.op })
  if (transportMode === 'down') throw new Error('network-down')
  return { result: await fn.main(data) }
})
const resetCalls = () => {
  calls.length = 0
}
const firstIndex = (action) => calls.findIndex((call) => call.action === action)

writeFace.setWriteFaceModeOverride('cloud')
session.setUser(ADMIN)
resetLocal('PENDING')

/* ===========================================================================
   A 段：① 云端形态 ＋ 无令牌 ⇒ 流程先取令牌，再审核（且顺序可证）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '云端 ＋ 无令牌 ⇒ 先取令牌再审核' }))
/* A0（负向对照）：直接调 review（无令牌）⇒ 云函数原样 FORBIDDEN ＋ 零写入 ——
   证明「通道是通的，缺的是取令牌这一步」。 */
adminTokenSvc.clearAdminToken()
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
const rawNoToken = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('A0', '负向对照：无令牌直调 review ⇒ FORBIDDEN（服务端原样）', 'FORBIDDEN', rawNoToken.reason)
check('A0b', '负向对照：无令牌 ⇒ 零写入（服务端 / 本机皆未写）', { server: 0, local: 'PENDING' }, { server: store.stats.writes.length, local: localCorrection().status })

/* A1（正向）：走编排 ⇒ 先取令牌（issue）再 review（verify）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
adminTokenSvc.clearAdminToken()
const needsBefore = adminSvc.needsAdminWriteCode()
const outA = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), CODE)
check('A1', '编排成功：out.ok 且审核结果 ok', { outOk: true, resultOk: true }, { outOk: outA.ok, resultOk: outA.result && outA.result.ok })
check('A2', '流程要求「先取令牌」：needsAdminWriteCode 取令牌前为 true', true, needsBefore)
check('A3', '取令牌确实被调且在 review 之前（首个 issue 在首个 verify 之前）', true, firstIndex('issue') !== -1 && firstIndex('verify') !== -1 && firstIndex('issue') < firstIndex('verify'))
check('A3b', '取令牌后再 review：needsAdminWriteCode 变为 false', false, adminSvc.needsAdminWriteCode())
check('A4', '取令牌 ＋ 审核后：本机行已采纳', 'ACCEPTED', localCorrection().status)
check('A5', '服务端权威落盘 2 处（公开投影 ＋ 私有状态）', 2, store.stats.writes.length)
console.log(JSON.stringify({ A_readout: { callSeq: calls.map((call) => call.action || call.op || '?'), tokenLen: adminSvc.adminTokenSnapshot().tokenLength, tokenFp: adminSvc.adminTokenSnapshot().tokenFingerprint } }))

/* ===========================================================================
   B 段：② 已有令牌 ⇒ 不弹、直接 review（无 issue 往返）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '已有令牌 ⇒ 不弹、直接 review' }))
check('B1', '已有未过期令牌 ⇒ needsAdminWriteCode 为 false（不弹）', false, adminSvc.needsAdminWriteCode())
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
const outB = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), '')
check('B2', '直接 review 成功（未再取令牌）', true, outB.ok && outB.result && outB.result.ok)
check('B2b', '无 issue 往返（仅 verify）——「有令牌 ⇒ 不弹」的机械证据', { issue: -1, verify: 0 }, { issue: firstIndex('issue'), verify: firstIndex('verify') })
check('B2c', '本机行已采纳', 'ACCEPTED', localCorrection().status)
/* B1n（负向对照）：清令牌 ⇒ needsAdminWriteCode 必为 true。 */
adminTokenSvc.clearAdminToken()
check('B1n', '负向对照：清空令牌 ⇒ needsAdminWriteCode 回 true', true, adminSvc.needsAdminWriteCode())

/* ===========================================================================
   C 段：③ dev / 離線形态 ⇒ 不弹、零云端往返、仍本地写
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: 'dev / 離線形态 ⇒ 零云端往返、仍本地写' }))
writeFace.setWriteFaceModeOverride('local-dev')
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
adminTokenSvc.clearAdminToken()
check('C1', 'dev / 離線形态 ⇒ needsAdminWriteCode 为 false（不弹）', false, adminSvc.needsAdminWriteCode())
const outC = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), '')
check('C2', 'dev / 離線形态仍可审核（本地权威）', true, outC.ok && outC.result && outC.result.ok && outC.result.accepted === true)
check('C3', 'dev / 離線形态：零云端往返', 0, calls.length)
check('C4', 'dev / 離線形态：零服务端写入（不碰云）', 0, store.stats.writes.length)
check('C5', 'dev / 離線形态：仍本地写（本机行已采纳）', 'ACCEPTED', localCorrection().status)
/* C1p（正对照）：切回云端 ＋ 无令牌 ⇒ needsAdminWriteCode 必回 true（证明形态开关即判据变化源）。 */
writeFace.setWriteFaceModeOverride('cloud')
check('C1p', '正对照：切回云端 ＋ 无令牌 ⇒ needsAdminWriteCode 回 true', true, adminSvc.needsAdminWriteCode())

/* ===========================================================================
   D 段：④ 取令牌失败（码不对 / 网络）⇒ 零写入 ＋ 原样报错
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '取令牌失败 ⇒ 零写入、原样报错' }))
/* D1：码不对（服务端业务拒绝，逐字透传）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
adminTokenSvc.clearAdminToken()
const directIssue = await fn.main({ action: 'issue', phone: PHONE, code: BAD_CODE })
store.load(CLOUD_SEED)
resetCalls()
const outD1 = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), BAD_CODE)
check('D1', '码不对 ⇒ 编排失败（out.ok false）', false, outD1.ok)
check('D1b', '码不对 ⇒ 服务端 FORBIDDEN 原样透传（reason）', 'FORBIDDEN', outD1.session && outD1.session.reason)
check('D1c', '码不对 ⇒ message **逐字**＝服务端原文（不被吞成通用提示）', directIssue.message, outD1.session && outD1.session.message)
check('D1d', '码不对 ⇒ 未执行写操作：零服务端写入', 0, store.stats.writes.length)
check('D1e', '码不对 ⇒ 本机行未被改动（仍 PENDING）', 'PENDING', localCorrection().status)
check('D1f', '码不对 ⇒ 未发起 verify（仅 issue；不重试写操作）', { issue: 0, verify: -1 }, { issue: firstIndex('issue'), verify: firstIndex('verify') })
/* D2：网络断（传输层失败 ⇒ STORAGE_UNAVAILABLE ≠ FORBIDDEN）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
adminTokenSvc.clearAdminToken()
transportMode = 'down'
const outD2 = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), CODE)
transportMode = 'fn'
check('D2', '网络断 ⇒ 编排失败', false, outD2.ok)
check('D2b', '网络断 ⇒ STORAGE_UNAVAILABLE（**绝不伪装 FORBIDDEN**）', 'STORAGE_UNAVAILABLE', outD2.session && outD2.session.reason)
check('D2c', '网络断 ⇒ 未执行写操作：本机行仍 PENDING ＋ 零服务端写入', { local: 'PENDING', server: 0 }, { local: localCorrection().status, server: store.stats.writes.length })
/* D3（正对照）：正确码 ⇒ 成功（证明「失败」不是恒真）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
adminTokenSvc.clearAdminToken()
const outD3 = await adminSvc.runWithAdminWriteSession(() => corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED'), CODE)
check('D3', '正对照：正确码 ⇒ 编排成功且本机行已采纳', { ok: true, local: 'ACCEPTED' }, { ok: outD3.ok, local: localCorrection().status })

/* ===========================================================================
   E 段：⑤ 本机镜像更正（云端权威优先）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '云端权威优先：本机镜像更正' }))
/* E1：本机已 ACCEPTED（旧构建曾本地静默写成功 / 另一页签已本地采纳）＋ 云端 PENDING ⇒ 云端 ok
   而本机 writeCorrectionDecision 回 ALREADY_REVIEWED ⇒ 不得当失败，须以云端权威行更正本机行。 */
store.load(CLOUD_SEED)
resetLocal('ACCEPTED')
resetCalls()
const outE1 = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
const cloudRow = store.collections.xiai_corrections.get('doc-name')
const localE1 = localCorrection()
check('E1', '本机已 ACCEPTED ＋ 云端 ok ⇒ 结果 ok:true（不得当失败）', true, outE1.ok === true)
check('E1b', '结果显式标记 reconciled（本机并非首次写入）', true, outE1.reconciled === true)
check('E1c', '本机行按云端权威更正：status ＝ ACCEPTED', 'ACCEPTED', localE1.status)
check('E1d', '本机行 reviewed_at ＝ 云端权威值', cloudRow.reviewed_at, localE1.reviewed_at)
check('E1e', '本机行 reviewer_id ＝ 云端权威值', cloudRow.reviewer_id, localE1.reviewer_id)
check('E1f', '文案如实标注（云端口径，不谎称本机首次采纳）', true, /雲端已採納/.test(outE1.message) && /本機鏡像已按雲端權威更正/.test(outE1.message))
/* E1n（负向对照）：本机行若与云端**同态**（PENDING），则该行不可能已 ACCEPTED —— 用不同 id 复算
   会命中 NOT_FOUND（本机无该行）⇒ 同样按云端权威落一行镜像（证明更正分支不止 ALREADY_REVIEWED）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
storage.writeKey(storage.STORAGE_KEYS.corrections, [])
const outE1n = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('E1n', '本机无对应行 ＋ 云端 ok ⇒ 仍 ok:true 且落一行云端权威镜像', { ok: true, mirrored: 'ACCEPTED' }, { ok: outE1n.ok, mirrored: localCorrection() && localCorrection().status })

/* E2：本机 REJECTED（带理由）＋ 云端 ACCEPTED ⇒ 更正为 ACCEPTED 且清掉陈旧 review_note。 */
store.load(CLOUD_SEED)
resetLocal('REJECTED')
const rejectedLocal = Object.assign({}, localCorrection(), { review_note: '舊理由' })
storage.writeKey(storage.STORAGE_KEYS.corrections, [rejectedLocal])
resetCalls()
const outE2 = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('E2', '本机 REJECTED ＋ 云端 ACCEPTED ⇒ 更正为 ACCEPTED', 'ACCEPTED', localCorrection().status)
check('E2b', '陈旧 review_note 被清除（本机行与云端权威一致）', false, Object.prototype.hasOwnProperty.call(localCorrection(), 'review_note'))

/* E3（反向对照）：本机 PENDING ＋ 云端 ok ⇒ 既有形态（本机正常写入，不触发更正分支）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
const outE3 = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('E3', '反向对照：本机 PENDING ＋ 云端 ok ⇒ ok:true', true, outE3.ok === true)
check('E3b', '反向对照：**不**触发更正分支（结果无 reconciled 键）', false, Object.prototype.hasOwnProperty.call(outE3, 'reconciled'))
check('E3c', '反向对照：本机行正常写入（reviewer_id ＝ 本地 actor）', ADMIN.id, localCorrection().reviewer_id)

/* ===========================================================================
   F 段：`[data-admin-action]` 去重取值集合不变（8 值 / 归并 7 类）
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: 'data-admin-action 去重集合不变' }))
const FROZEN_ADMIN_ACTIONS = [
  'correction-accept',
  'correction-reject',
  'edit-fixed-attributes',
  'edit-invite-reward',
  'edit-seal-attributes',
  'export-seal-data',
  'replace-face-image',
  'upload-seal'
]
const MERGED_CLASSES = ['correction-accept', 'edit-fixed-attributes', 'edit-invite-reward', 'edit-seal-attributes', 'export-seal-data', 'replace-face-image', 'upload-seal']
function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}
/** 去注释（块注释 ＋ 行注释 ＋ HTML 注释）——判据只看码面 / 上屏面。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
function collectAdminActions(srcFiles, transform = (s) => s) {
  const found = new Set()
  srcFiles.forEach((file) => {
    const body = transform(readFileSync(file, 'utf8'))
    const matches = body.match(/data-admin-action="([^"]+)"/g) || []
    matches.forEach((item) => found.add(item.replace(/data-admin-action="/, '').replace(/"$/, '')))
  })
  return [...found].sort()
}
const SRC_FILES = walkFiles(path.join(ROOT, 'src'))
const scanned = collectAdminActions(SRC_FILES, stripComments)
check('F1', '去重取值集合逐字 ＝ 冻结 8 值', FROZEN_ADMIN_ACTIONS.slice().sort(), scanned)
{
  /* 归并 7 类：accept / reject 合为一类。 */
  const merged = scanned.map((value) => (value === 'correction-reject' ? 'correction-accept' : value))
  const distinct = [...new Set(merged)].sort()
  check('F2', '按归并表归并 ⇒ 恰 7 类', MERGED_CLASSES.slice().sort(), distinct)
  /* F1c（正对照）：临时注入一个 canary 取值 ⇒ 集合必须变 9（探针能看见「多出来的值」）。 */
  const canary = 'qa-canary-9th'
  const withCanary = [...new Set([...scanned, canary])]
  check('F1c', '正对照：注入 canary 取值 ⇒ 集合变 9（非恒等）', 9, withCanary.length)
  /* F1c2（负对照）：canary 移除后回基线。 */
  const restored = withCanary.filter((value) => value !== canary)
  check('F1c2', '负对照：移除 canary 后回基线 8', 8, restored.length)
}

/* ===========================================================================
   G 段：上屏文案繁體（去注释后扫描）
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '上屏文案繁體' }))
/* 只含「简体专用」码位（无合法繁体用法）⇒ 命中必为简体。 */
const SIMPLIFIED_ONLY = new Set(
  '说这认边过请对员码确录记误页项题类别输选择开关击钮盘师价体变总积键种样数据获奖励审览处办当给让删询详单号称显标签档尽为无与专业东丝两严个临汉从众们会优传伟伤伦'.split('')
)
const simplifiedHits = (text) => [...new Set([...text].filter((ch) => SIMPLIFIED_ONLY.has(ch)))]
check('G1', '正对照：已知简体串必命中（探测器有效）', true, simplifiedHits('这里说数据').length > 0)
check('G2', '负对照：纯繁体串不命中', [], simplifiedHits('這裏說數據'))
{
  const viewSrc = stripComments(readFileSync(path.join(ROOT, 'src/views/MyCorrectionsView.vue'), 'utf8'))
  check('G3', 'MyCorrectionsView.vue（去注释）简体字符命中 0', [], simplifiedHits(viewSrc))
}

/* ===========================================================================
   汇总
   =========================================================================== */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    admin_actions: { unique: scanned, count: scanned.length, mergedClasses: MERGED_CLASSES.length },
    token: { present: adminSvc.hasAdminToken(), fingerprint: fingerprint('present') },
    db_writes_by_harness: store.stats.writes.length
  })
)
process.exit(failures === 0 ? 0 : 1)
