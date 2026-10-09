/**
 * 玺爱 · **V3 登录令牌写面自检**（采纳 / 驳回：登录令牌直通、零弹窗、白名单门、缺 env 安全拒、自愈）
 * ============================================================================
 * **本地、离线、零网络**（注入假 DB ＋ 传输注入把请求交给**真实云函数体** `xiai-user-token`）。
 *
 * 本文件为 **V3 重写**（取代改前「弹校驗碼 / `ensureAdminWriteSession` 编排」的断言面 ——
 * 那套编排已随 V3 架构整体撤除，旧判据与现状矛盾）。逐条对应人类裁定 V3：
 *   A. **登录令牌直通（零第二码 / 零弹窗）**：云端形态 ＋ 内存已有登录令牌 ⇒ 采纳**只发生 verify 一次**
 *      （无 `issue` 往返），服务端权威落盘两处（先公开投影、后私有状态），本机镜像随权威更正；
 *      并机械断言「弹校驗碼」编排**已不存在**（`admin.js` 不再导出 `needsAdminWriteCode` /
 *      `runWithAdminWriteSession` / `isCloudWriteFace`）。
 *   B. **白名单门**：合法签名但手机号 **不在** `XIAI_ADMIN_PHONE` 的用户令牌 ⇒ `FORBIDDEN` ＋ 零写入；
 *      白名单手机号（正对照）⇒ 放行且确有落盘。
 *   C. **缺 env 安全拒（关键安全默认 ＋ 不误伤）**：缺 `XIAI_ADMIN_PHONE` ⇒ **管理员类 op 全拒**
 *      （`STORAGE_UNAVAILABLE`）＋ 零写入；而**普通用户写面（`submitCorrection`）不受影响仍可用**。
 *   D. **自愈**：无令牌 ＋ **有会话** ⇒ 流程**先 issue 补签、后 verify**，最终 ok；
 *      无令牌 ＋ **无会话** ⇒ 结构化拒绝 ＋ 零写入（且**零往返**，连补签都不发）。
 *   E. **本机镜像更正（云端权威优先）**：云端已落盘而本机 `writeCorrectionDecision` 未成功
 *      （`ALREADY_REVIEWED` 等）⇒ 返回 `ok:true` ＋ `reconciled:true`，本机行按服务端权威行更正。
 *   F. **`[data-admin-action]` 去重取值集合不变**（8 值 / 归并 7 类）＋ canary 正 / 负对照。
 *   G. **上屏文案繁體**（去注释后扫描；正 / 负对照证明探测器有效）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 环境变量缺省用**合成值**（非真实凭据；可用 env 覆盖）：XIAI_ADMIN_PHONE / XIAI_ADMIN_TOKEN_SECRET。
 * 用户（登录）令牌的验证码取**公开演示码** `DEMO_SMS_CODE`（自愈路径需要它与服务端一致；生产不变量）。
 *
 * 用法：node scripts/verify-review-token-path.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

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

const sorted = (list) => (Array.isArray(list) ? list.slice().sort() : list)

/* ---------------------------------------------------------------------------
   2. 环境（**合成值**；脚本内零真实凭据字面值）
   --------------------------------------------------------------------------- */
const PHONE = String(process.env.XIAI_ADMIN_PHONE || '13000000001').trim()
const SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || 'synthetic-selfcheck-secret').trim()
const NON_WHITELIST_PHONE = '139' + String(0).repeat(8) + '1' // 合成「非白名单」号；不写成 11 位字面值
process.env.XIAI_ADMIN_PHONE = PHONE
process.env.XIAI_USER_TOKEN_SECRET = SECRET
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
/* **uid 派生单点**：客户端 `src/data/uid.js::uidOf`（`u-` ＋ sha256(手机号) 前 16 位，不可反推手机号）。
   自检用**客户端实现**算，再与服务端 `config.uidOf` 逐字比对 ⇒ 机械证明「两侧同值」。 */
const uidUtil = await import(path.join(ROOT, 'src/data/uid.js'))
const uidOfPhone = (phone) => uidUtil.uidOf(phone)
const nowS = () => Math.floor(Date.now() / 1000)
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) =>
  value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

/* ---------------------------------------------------------------------------
   3. 加载被测件（真实云函数体 ＋ 前端真源服务）
   --------------------------------------------------------------------------- */
const fn = require(path.join(FUNCTION_DIR, 'index.js'))
const ops = require(path.join(FUNCTION_DIR, 'lib/ops.js'))
const userLib = require(path.join(FUNCTION_DIR, 'lib/token.js'))

/* 假 DB（内存；「零写入」的判据就是它的写计数）。 */
function createStore(seed) {
  const collections = { xiai_corrections: new Map(), xiai_corrections_public: new Map() }
  const stats = { writes: [], reads: 0 }
  const load = (rows) => {
    Object.keys(collections).forEach((name) => collections[name].clear())
    ;(rows || []).forEach((row) => {
      const name = row.__collection || 'xiai_corrections'
      ;(collections[name] = collections[name] || new Map()).set(row._id, Object.assign({}, row))
    })
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
        },
        async add(doc) {
          const id = doc && doc._id ? String(doc._id) : `auto-${map.size + 1}`
          map.set(id, Object.assign({ _id: id }, doc))
          stats.writes.push({ collection: name, action: 'add', id })
          return { id }
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
  },
  /* **本单修正（person-model §4.1 / §4.2）**：`author` 引用型 ⇒ 既有 author 用例载荷值须指向既有印人；
     按 `id` 补种印人行（仅新增种子，未改既有断言）。 */
  { __collection: 'xiai_persons', _id: 'p-env', id: '缺 env 仍可提交', code: 'PR000000001', display_name: '印人缺env' },
  { __collection: 'xiai_persons', _id: 'p-jia', id: '甲值', code: 'PR000000002', display_name: '印人甲' }
]
const store = createStore(CLOUD_SEED)
ops.setOpsDbProvider(store.provider)

const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const authSvc = await import(path.join(ROOT, 'src/services/auth.js'))
const corrections = await import(path.join(ROOT, 'src/services/corrections.js'))
const adminSvc = await import(path.join(ROOT, 'src/services/admin.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const userWriteSvc = await import(path.join(ROOT, 'src/services/userWrite.js'))

/* 用户函数验证码：取公开演示码（自愈路径与生产不变量一致）。 */
const USER_CODE = authSvc.DEMO_SMS_CODE
process.env.XIAI_USER_SMS_CODE = USER_CODE

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

/* 传输注入：交给**真实云函数体**（用户函数）；记录每次往返的 action / op（顺序即证据）。 */
const calls = []
let transportMode = 'fn'
userTokenSvc.setUserTokenTransport(async (name, data) => {
  calls.push({ name, action: data && data.action, op: data && data.op })
  if (transportMode === 'down') throw new Error('network-down')
  return { result: await fn.main(data) }
})
const resetCalls = () => {
  calls.length = 0
}
const firstIndex = (action) => calls.findIndex((call) => call.action === action)

const tokenFor = (phone) =>
  userLib.issueToken({ sub: phone, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token

writeFace.setWriteFaceModeOverride('cloud')
session.setUser(ADMIN)
resetLocal('PENDING')

/* ===========================================================================
   A 段：登录令牌直通（零第二码 / 零弹窗）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '登录令牌直通：零第二码、零弹窗、两处落盘' }))
/* A0：登录令牌预取（模拟登录已换令牌；本段不测取票，只测直通）。 */
userTokenSvc.clearUserToken()
const login = await userTokenSvc.ensureUserWriteSession(USER_CODE, PHONE)
check('A0', '登录令牌已入内存（登录已过服务端验证）', true, login.ok === true && userTokenSvc.userTokenSnapshot().present === true)
check('A0b', '令牌读数只给长度 / 指纹（无原文）', true, userTokenSvc.userTokenSnapshot().tokenLength > 0 && userTokenSvc.userTokenSnapshot().tokenFingerprint.length === 8)

/* A1：直通采纳（**只发生 verify，无 issue** —— 不再需要第二个码）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
resetCalls()
const accepted = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('A1', '登录令牌直通采纳成功（ok:true / accepted:true / status ACCEPTED）', { ok: true, accepted: true, status: 'ACCEPTED' }, { ok: accepted.ok, accepted: accepted.accepted, status: accepted.status })
const actionsA1 = calls.map((call) => call.action)
check('A2', '**零第二码**：全程只 verify 一次、无 issue（机械证据）', { verify: 1, issue: 0 }, { verify: actionsA1.filter((a) => a === 'verify').length, issue: actionsA1.filter((a) => a === 'issue').length })
check('A2b', '服务端权威落盘恰 3 处（公开投影 ＋ 私有状态 ＋ 值级公开摘要）', 3, store.stats.writes.length)
check('A2c', '落盘顺序：先公开脱敏投影、次私有状态、末值级公开摘要', ['xiai_corrections_public', 'xiai_corrections', 'xiai_correction_summaries'], store.stats.writes.map((w) => w.collection))
check('A2d', '公开投影文档键 `cp-cr-name` 且零身份字段', { id: 'cp-cr-name', identity: [] }, (() => {
  const pub = store.collections.xiai_corrections_public.get('cp-cr-name') || {}
  return { id: (store.stats.writes.find((w) => w.collection === 'xiai_corrections_public') || {}).id, identity: Object.keys(pub).filter((k) => ops.IDENTITY_PROJECTION_KEYS.indexOf(k) !== -1) }
})())
check('A3', '本机行已采纳（权威值镜像）', 'ACCEPTED', localCorrection().status)

/* A3b：**零弹窗**机械判据 —— V3 已整体撤除「弹校驗碼」编排。 */
check('A3b', '「弹校驗碼」编排已撤除：`needsAdminWriteCode` 不再导出', 'undefined', typeof adminSvc.needsAdminWriteCode)
check('A3c', '「弹校驗碼」编排已撤除：`runWithAdminWriteSession` 不再导出', 'undefined', typeof adminSvc.runWithAdminWriteSession)
check('A3d', '「弹校驗碼」编排已撤除：`isCloudWriteFace` 不再导出', 'undefined', typeof adminSvc.isCloudWriteFace)
console.log(JSON.stringify({ A_readout: { callSeq: actionsA1, tokenLen: userTokenSvc.userTokenSnapshot().tokenLength, tokenFp: userTokenSvc.userTokenSnapshot().tokenFingerprint } }))

/* ===========================================================================
   B 段：白名单门（服务端唯一授权判据）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '白名单门：非白名单拒、白名单放行' }))
/* B0（负向）：合法签名但手机号非白名单 ⇒ FORBIDDEN ＋ 零写入。 */
store.load(CLOUD_SEED)
const foreign = await fn.main({ action: 'verify', token: tokenFor(NON_WHITELIST_PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
check('B0', '非白名单手机号 ⇒ FORBIDDEN（恰 3 键）', true, isDenial(foreign) && foreign.reason === 'FORBIDDEN')
check('B0b', '非白名单 ⇒ 零写入', 0, store.stats.writes.length)
/* B0c（负向）：白名单手机号的**管理员角色**令牌（另一把密钥签）在用户函数不可用——本函数只认 user 角色。 */
/* B1（正向）：白名单手机号 ⇒ 放行且确有落盘（证明 B0 不是「恒拒」）。 */
store.load(CLOUD_SEED)
const whitelisted = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
check('B1', '白名单手机号 ⇒ 放行（ok:true）', true, whitelisted.ok === true)
check('B1b', '正向对照确有落盘（恰 3 处：公开投影 ＋ 私有状态 ＋ 值级公开摘要）', 3, store.stats.writes.length)
check('B1c', '回包带服务端权威行（status ACCEPTED）与公开投影', { status: 'ACCEPTED', hasProjection: true }, { status: whitelisted.row && whitelisted.row.status, hasProjection: !!whitelisted.projection })
check('B1d', '公开投影零身份字段（服务端下发面）', [], Object.keys(whitelisted.projection || {}).filter((k) => ops.IDENTITY_PROJECTION_KEYS.indexOf(k) !== -1))

/* ===========================================================================
   C 段：缺 env 安全拒（管理员类 op 全拒）＋ **不误伤**普通用户写面
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '缺 XIAI_ADMIN_PHONE ⇒ 管理员类 op 全拒；普通用户写面不受影响' }))
const savedAdminPhone = process.env.XIAI_ADMIN_PHONE
delete process.env.XIAI_ADMIN_PHONE
{
  /* C0：缺 env ⇒ 采纳安全拒（STORAGE_UNAVAILABLE，非 FORBIDDEN —— 「内部不可用」≠「越权」）＋ 零写入。 */
  store.load(CLOUD_SEED)
  const denied = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
  check('C0', '缺 env ⇒ 采纳被拒（STORAGE_UNAVAILABLE）', true, isDenial(denied) && denied.reason === 'STORAGE_UNAVAILABLE')
  check('C0b', '缺 env ⇒ 错误 ≠ FORBIDDEN（未配置不是「越权」）', true, denied.reason !== 'FORBIDDEN')
  check('C0c', '缺 env ⇒ 零写入', 0, store.stats.writes.length)
  /* C0d：另一管理员类 op 同样安全拒。 */
  const denyReward = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'setInviteReward', payload: { value: 5 } })
  check('C0d', '缺 env ⇒ `setInviteReward` 同样安全拒（STORAGE_UNAVAILABLE）', true, isDenial(denyReward) && denyReward.reason === 'STORAGE_UNAVAILABLE')
  /* C1（关键不误伤）：**普通用户写面不受影响** —— 提交勘误仍可用且落盘。 */
  store.load(CLOUD_SEED)
  const submitOk = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'submitCorrection', payload: { faceId: 'fc-env-safe', sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: '缺 env 仍可提交', basis: '' } })
  check('C1', '缺 env ⇒ 普通用户提交勘误**仍可用**（ok:true）', true, submitOk.ok === true)
  check('C1b', '缺 env ⇒ 普通用户写面确有落盘（不误伤；提交 ＝ 2 处：勘误行 ＋ 值级公开摘要）', 2, store.stats.writes.length)
  /* C1c：负向对照 —— 采信（另一普通用户 op）在缺 env 下同样不受影响。 */
  store.load(CLOUD_SEED)
  const endorsePayload = { faceId: 'fc-env-safe', sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: '甲值' }
  await fn.main({ action: 'verify', token: tokenFor(NON_WHITELIST_PHONE), op: 'submitCorrection', payload: { ...endorsePayload, basis: '' } })
  const endorseOk = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'endorseCorrection', payload: endorsePayload })
  check('C1c', '缺 env ⇒ 普通用户采信也仍可用（ok:true）', true, endorseOk.ok === true)
}
process.env.XIAI_ADMIN_PHONE = savedAdminPhone

/* ===========================================================================
   D 段：自愈（刷新后令牌即丢 ⇒ 有会话则静默补签；无会话则拒）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '自愈：有会话先补签、无会话则拒' }))
/* D0：清令牌 ＋ 有会话 ⇒ 先 issue 后 verify，最终 ok。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
userTokenSvc.clearUserToken()
session.setUser(ADMIN)
resetCalls()
const healed = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('D0', '清令牌 ＋ **有会话** ⇒ 采纳成功（ok:true）', true, healed.ok === true && healed.accepted === true)
check('D0b', '自愈顺序：**先 issue 补签、后 verify**', true, firstIndex('issue') !== -1 && firstIndex('verify') !== -1 && firstIndex('issue') < firstIndex('verify'))
check('D0c', '自愈后令牌已入内存（present＝true）', true, userTokenSvc.userTokenSnapshot().present === true)
check('D0d', '自愈写：服务端恰落盘 3 处（公开投影 ＋ 私有状态 ＋ 值级公开摘要）', 3, store.stats.writes.length)
/* D1（负向）：清令牌 ＋ 无会话 ⇒ 结构化拒绝 ＋ 零写入 ＋ 零往返。 */
userTokenSvc.clearUserToken()
session.setUser(null)
resetCalls()
const beforeD1 = store.stats.writes.length
const noSession = await userWriteSvc.ensureUserTokenForWrite()
check('D1', '清令牌 ＋ **无会话** ⇒ userWriteGate 结构化拒绝（ok:false ＋ reason）', true, noSession.ok === false && typeof noSession.reason === 'string' && noSession.reason.length > 0)
check('D1b', '无会话 ⇒ 零往返（连补签 request 都不发）', 0, calls.length)
check('D1c', '无会话 ⇒ 零写入', beforeD1, store.stats.writes.length)
/* D1d：云端口经服务层（review）无会话 ⇒ 结构化拒绝 ＋ 零写入。 */
resetLocal('PENDING')
const reviewedNoSession = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('D1d', '无会话 ⇒ 经服务层采纳也被拒（ok:false）', false, reviewedNoSession.ok)
check('D1e', '无会话 ⇒ 本机行未被改动（仍 PENDING）', 'PENDING', localCorrection().status)
session.setUser(ADMIN)

/* ===========================================================================
   E 段：本机镜像更正（云端权威优先）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '云端权威优先：本机镜像更正' }))
/* E0：预置登录令牌（E 段走直通，避免自愈干扰计数）。 */
await userTokenSvc.ensureUserWriteSession(USER_CODE, PHONE)
/* E1：本机已 ACCEPTED ＋ 云端 PENDING ⇒ 云端 ok 而本机 writeCorrectionDecision 回 ALREADY_REVIEWED。 */
store.load(CLOUD_SEED)
resetLocal('ACCEPTED')
resetCalls()
const outE1 = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
const cloudRow = store.collections.xiai_corrections.get('doc-name')
check('E1', '本机已 ACCEPTED ＋ 云端 ok ⇒ 结果 ok:true（不得当失败）', true, outE1.ok === true)
check('E1b', '结果显式标记 reconciled（本机并非首次写入）', true, outE1.reconciled === true)
check('E1c', '本机行按云端权威更正：status ＝ ACCEPTED', 'ACCEPTED', localCorrection().status)
check('E1d', '本机行 reviewed_at ＝ 云端权威值', cloudRow.reviewed_at, localCorrection().reviewed_at)
check('E1e', '本机行 reviewer_id ＝ 云端权威值', cloudRow.reviewer_id, localCorrection().reviewer_id)
check('E1f', '文案如实标注（不谎称本机首次采纳）', true, /雲端已採納/.test(outE1.message) && /本機鏡像已按雲端權威更正/.test(outE1.message))
/* E2：本机 REJECTED（带理由）＋ 云端 ACCEPTED ⇒ 更正为 ACCEPTED 且清掉陈旧 review_note。 */
store.load(CLOUD_SEED)
resetLocal('REJECTED')
storage.writeKey(storage.STORAGE_KEYS.corrections, [Object.assign({}, localCorrection(), { review_note: '舊理由' })])
const outE2 = await corrections.review(ADMIN, CORRECTION_ID, 'ACCEPTED')
check('E2', '本机 REJECTED ＋ 云端 ACCEPTED ⇒ 更正为 ACCEPTED', 'ACCEPTED', localCorrection().status)
check('E2b', '陈旧 review_note 被清除', false, Object.prototype.hasOwnProperty.call(localCorrection(), 'review_note'))
/* E3（反向对照）：本机 PENDING ＋ 云端 ok ⇒ 既有形态（不触发更正分支）。 */
store.load(CLOUD_SEED)
resetLocal('PENDING')
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
  const merged = scanned.map((value) => (value === 'correction-reject' ? 'correction-accept' : value))
  const distinct = [...new Set(merged)].sort()
  check('F2', '按归并表归并 ⇒ 恰 7 类', MERGED_CLASSES.slice().sort(), distinct)
  const canary = 'qa-canary-9th'
  const withCanary = [...new Set([...scanned, canary])]
  check('F1c', '正对照：注入 canary 取值 ⇒ 集合变 9（非恒等）', 9, withCanary.length)
  check('F1c2', '负对照：移除 canary 后回基线 8', 8, withCanary.filter((value) => value !== canary).length)
}

/* ===========================================================================
   G 段：上屏文案繁體（去注释后扫描）＋ 校驗碼输入位机械检索
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '上屏文案繁體 ＋ 校驗碼输入位检索' }))
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
  const pointsSrc = stripComments(readFileSync(path.join(ROOT, 'src/views/PointsView.vue'), 'utf8'))
  check('G3b', 'PointsView.vue（去注释）简体字符命中 0', [], simplifiedHits(pointsSrc))
}
/* 校驗碼输入位机械检索（去注释后）：审核页 / PointsView 不得再出现输入位钩子。 */
{
  const hookRe = /data-review-write-code|寫入校驗碼/
  const mySrc = stripComments(readFileSync(path.join(ROOT, 'src/views/MyCorrectionsView.vue'), 'utf8'))
  const ptSrc = stripComments(readFileSync(path.join(ROOT, 'src/views/PointsView.vue'), 'utf8'))
  check('G4', '审核页（去注释）无校驗碼输入位（`data-review-write-code` / `寫入校驗碼` 命中 0）', { my: false, points: false }, { my: hookRe.test(mySrc), points: hookRe.test(ptSrc) })
  check('G4p', '检索判据正对照（含钩子的样本必须命中）', true, hookRe.test('x data-review-write-code y 寫入校驗碼'))
}

/* ===========================================================================
   H 段：gate() 回包白名单透传 `display` 分组（正 / 负对照；注入缝直测本文件 gate）
   =========================================================================== */
console.log(JSON.stringify({ section: 'H', title: 'gate 回包白名单：display 分组透传（正 / 负对照）' }))
/* 与第 3 段同一真实传输缝（H 段结束后原样还原；H 段内用 stub 只替 display 回包形状）。 */
const realTransport = async (name, data) => ({ result: await fn.main(data) })
/* H0：前置 —— 内存有登录令牌（cloud 形态 gate 可直测；复用 / 补签同一机制）。 */
await userTokenSvc.ensureUserWriteSession(USER_CODE, PHONE)
check('H0', '前置：内存有登录令牌（cloud 形态 gate 可直测）', true, userTokenSvc.userTokenSnapshot().present === true)
/* H1（正向）：注入**带 display 分组**的服务端回包 ⇒ gate 逐字透传（与注入回包同构）。 */
const injectedDisplay = { sha256: 'f'.repeat(64), displayKey: 'display/xiai/fx/fx-display.webp', bytesLength: 1234, width: 320, height: 240 }
const stubServerReply = { ok: true, op: 'ensureDisplayArtifact', serverNow: nowS() }
userTokenSvc.setUserTokenTransport(async () => ({ result: Object.assign({}, stubServerReply, { display: injectedDisplay }) }))
const outH1 = await userTokenSvc.userGate('ensureDisplayArtifact', {})
check('H1', 'gate 回包含 display 分组且与注入的服务端回包逐字同构', injectedDisplay, outH1.display)
check('H1b', 'display 分组键面 ＝ 服务端五键（sha256/displayKey/bytesLength/width/height）', ['bytesLength', 'displayKey', 'height', 'sha256', 'width'], Object.keys(outH1.display || {}).sort())
check('H1c', 'gate 未改写注入的服务端对象（权威读数原样，逐字同构旁证）', { sha256: 'f'.repeat(64), displayKey: 'display/xiai/fx/fx-display.webp', bytesLength: 1234, width: 320, height: 240 }, injectedDisplay)
/* H2（负向）：注入**无 display** 的服务端回包 ⇒ 客户端不编造、不产生假读数。 */
userTokenSvc.setUserTokenTransport(async () => ({ result: Object.assign({}, stubServerReply) }))
const outH2 = await userTokenSvc.userGate('ensureDisplayArtifact', {})
check('H2', '服务端回包无 display ⇒ gate 回包 display ＝ undefined（不编造分组）', undefined, outH2.display)
check('H2b', '负对照：gate 顶层不产生假读数（无 width/height/bytesLength/displayKey/sha256 扁平键）', [], Object.keys(outH2).filter((k) => ['sha256', 'displayKey', 'bytesLength', 'width', 'height'].indexOf(k) !== -1))
/* 还原真实传输缝（H 段之后不再发起云端往返；防御性还原）。 */
userTokenSvc.setUserTokenTransport(realTransport)

/* ===========================================================================
   汇总
   =========================================================================== */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    admin_actions: { unique: scanned, count: scanned.length, mergedClasses: MERGED_CLASSES.length },
    db_writes_by_harness: store.stats.writes.length,
    token: { present: userTokenSvc.userTokenSnapshot().present, fingerprint: fingerprint('present') }
  })
)
process.exit(failures === 0 ? 0 : 1)
