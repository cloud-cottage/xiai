/**
 * 玺爱 · **V3 管理员写面（登录令牌 ＋ 手机号白名单）自检**
 * ============================================================================
 * **本地、离线、零网络**（注入假 DB ＋ 传输注入把请求交给**真实云函数体** `xiai-user-token`）。
 *
 * 本单（V3：管理员写面从 `xiai-admin-token` 收敛到「一枚登录令牌 ＋ 服务端手机号白名单」）逐条断言：
 *   ① 白名单手机号 ⇒ `reviewCorrection` **落盘两处**（**先**公开脱敏投影 `cp-<单号>`、**后**私有
 *      `status` / `reviewed_at` / `reviewer_id`）且**公开行零身份字段**；
 *   ② 非白名单手机号 ⇒ `FORBIDDEN` ＋ **零写入**（白名单是真授权判据，不是恒放行）；
 *   ③ **缺 `XIAI_ADMIN_PHONE` ⇒ 管理员类 op 全拒（`STORAGE_UNAVAILABLE`）＋ 零写入**，而**普通用户
 *      写面（`submitCorrection` / `endorseCorrection`）不受影响仍可用**（关键安全默认 ＋ 不误伤）；
 *   ④ **自愈**：无令牌 ＋ 有会话 ⇒ 先 `issue` 后 `verify`；无令牌 ＋ 无会话 ⇒ 拒 ＋ 零写入 ＋ 零往返；
 *   ⑤ **机械检索**：审核页 / PointsView **无校驗碼输入位**（`data-review-write-code` / `寫入校驗碼`
 *      在 src **码面**（去注释）命中 0）；
 *   ⑥ `[data-admin-action]` 去重集合现实值 **10 值 / 归并 9 类**（v1.54 新增 `person-import-review`；＋ canary 正 / 负对照）；
 *   ⑦ 上屏文案**繁體**（正 / 负对照证明探测器有效）；
 *   ⑧ 客户端对 `xiai-admin-token` **零业务引用**（`src/services/**` / `src/views/**` 无
 *      `adminGate(` / `ensureAdminWriteSession(` 调用点；`token.js` 管道本体与 `adminToken.js`
 *      转口**不算违规但要如实登记**）。
 * 另加：服务端 `ADMIN_OPS` 口径副本与 `xiai-admin-token/lib/ops.js` **逐字对账**（不让副本静默漂移）。
 * ⑨ `migrateDynastyValues` 一次性朝代值迁移（§3.53.5）：预演（零写入）/ 执行（只改点名值）/ 重放
 *    （零改动 ＋ 幂等）三态 ＋ 相邻值不动 ＋ 白名单门（非白名单 FORBIDDEN / 缺 env 安全拒，均零写入）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 环境变量缺省用**合成值**（非真实凭据；可用 env 覆盖）：XIAI_ADMIN_PHONE / XIAI_ADMIN_TOKEN_SECRET。
 *
 * 用法：node scripts/verify-admin-write-via-login.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const USER_FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const ADMIN_FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-admin-token')

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
const SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || randomBytes(32).toString('hex')).trim()
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
   3. 加载被测件（用户函数 ＋ 管理员函数口径 ＋ 前端真源服务）
   --------------------------------------------------------------------------- */
const fn = require(path.join(USER_FN_DIR, 'index.js'))
const ops = require(path.join(USER_FN_DIR, 'lib/ops.js'))
const userLib = require(path.join(USER_FN_DIR, 'lib/token.js'))
const adminOps = require(path.join(ADMIN_FN_DIR, 'lib/ops.js'))

function createStore(seed) {
  const collections = { xiai_corrections: new Map(), xiai_corrections_public: new Map(), xiai_endorsements: new Map(), xiai_correction_summaries: new Map() }
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
          const hit = () => [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
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
    __collection: 'xiai_corrections',
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
const storage = await import(path.join(ROOT, 'src/data/storage.js'))
const authSvc = await import(path.join(ROOT, 'src/services/auth.js'))
const adminSvc = await import(path.join(ROOT, 'src/services/admin.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const userWriteSvc = await import(path.join(ROOT, 'src/services/userWrite.js'))

const USER_CODE = authSvc.DEMO_SMS_CODE
process.env.XIAI_USER_SMS_CODE = USER_CODE

const tokenFor = (phone) =>
  userLib.issueToken({ sub: phone, secret: SECRET, nowSeconds: nowS(), ttlSeconds: 900, version: '1', role: 'user' }).token

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
const REWARD_KEY = storage.STORAGE_KEYS.inviteReward
const readReward = () => storage.readKey(REWARD_KEY)

writeFace.setWriteFaceModeOverride('cloud')
session.setUser({ id: uidOfPhone(PHONE), phone: PHONE, role: 'admin', nickname: '管理員' })

/* ===========================================================================
   A 段：口径副本对账 ＋ op 注册面
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: 'ADMIN_OPS 口径副本对账 ＋ op 注册面' }))
check('A1', '`ADMIN_OPS` 恰含 {migrateDynastyValues, reviewCorrection, reviewPersonImport, reviewPersonProposal, reviewSealImport, setInviteReward}（新增一次性朝代值遷移 op）', ['migrateDynastyValues', 'reviewCorrection', 'reviewPersonImport', 'reviewPersonProposal', 'reviewSealImport', 'setInviteReward'], sorted(Object.keys(ops.ADMIN_OPS)))
check('A1b', '`reviewCorrection` 亦未混入用户写面 `OPS`', false, Object.prototype.hasOwnProperty.call(ops.OPS, 'reviewCorrection'))
check('A2', '审核载荷键面逐字 ＝ 管理员函数 `ALLOWED_KEYS`', sorted(adminOps.ALLOWED_KEYS), sorted(ops.REVIEW_ALLOWED_KEYS))
check('A3', '邀请奖励键面 ＝ [value]', ['value'], ops.REWARD_ALLOWED_KEYS.slice())
check('A4', '三态枚举逐字 ＝ 管理员函数', adminOps.CORRECTION_STATUS, ops.CORRECTION_STATUS)
check('A5', '终端决定枚举逐字 ＝ 管理员函数', adminOps.DECISIONS, ops.DECISIONS)
check('A6', '旧决定字面映射逐字 ＝ 管理员函数', adminOps.LEGACY_DECISION, ops.LEGACY_DECISION)
check('A7', '三张值域真源逐字 ＝ 管理员函数（dynasty / seal_type / face_style）', {
  dynasty: adminOps.DYNASTY_OPTIONS,
  seal_type: adminOps.FACE_CONTENT_OPTIONS,
  face_style: adminOps.FACE_STYLE_OPTIONS
}, {
  dynasty: ops.DYNASTY_OPTIONS,
  seal_type: ops.FACE_CONTENT_OPTIONS,
  face_style: ops.FACE_STYLE_OPTIONS
})
check('A8', '公开投影键面 / schema / 文档键前缀逐字 ＝ 管理员函数', {
  keys: adminOps.PUBLIC_PROJECTION_KEYS,
  schema: adminOps.PUBLIC_SCHEMA,
  prefix: adminOps.PUBLIC_ID_PREFIX
}, {
  keys: ops.PUBLIC_PROJECTION_KEYS,
  schema: ops.PUBLIC_SCHEMA,
  prefix: ops.PUBLIC_ID_PREFIX
})
check('A9', '身份投影禁键面逐字 ＝ 管理员函数', adminOps.IDENTITY_PROJECTION_KEYS, ops.IDENTITY_PROJECTION_KEYS)
check('A10', '上限常量逐字 ＝ 管理员函数（note / id）', { note: adminOps.MAX_NOTE_LENGTH, id: adminOps.MAX_ID_LENGTH }, { note: ops.MAX_NOTE_LENGTH, id: ops.MAX_ID_LENGTH })
check('A11', '公开投影键面与身份 / 私密键面交集为空', [], ops.PUBLIC_PROJECTION_KEYS.filter((key) => ops.IDENTITY_PROJECTION_KEYS.indexOf(key) !== -1))

/* ===========================================================================
   B 段：① 白名单手机号 ⇒ 两处落盘（先公开投影、后私有状态）＋ 公开行零身份字段
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '① 白名单 ⇒ reviewCorrection 两处落盘' }))
store.load(CLOUD_SEED)
const reviewed = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
check('B1', '白名单手机号 ⇒ ok:true', true, reviewed.ok === true)
check('B2', '恰落盘 3 处（公开投影 ＋ 私有状态 ＋ 值级公开摘要）', 3, store.stats.writes.length)
check('B3', '落盘顺序：**先**公开投影、**次**私有状态、**末**值级公开摘要', ['xiai_corrections_public', 'xiai_corrections', 'xiai_correction_summaries'], store.stats.writes.map((w) => w.collection))
check('B3b', '公开投影落 `doc(cp-<单号>).set(…)`（确定性键 ⇒ 幂等）', { id: 'cp-' + CORRECTION_ID, action: 'set' }, { id: store.stats.writes[0].id, action: store.stats.writes[0].action })
check('B3c', '私有状态落 `where(match).update(…)`', 'update', store.stats.writes[1].action)
const pub = store.collections.xiai_corrections_public.get('cp-' + CORRECTION_ID) || {}
check('B4', '公开投影文档键面恰 ＝ PUBLIC_PROJECTION_KEYS（`_id` 为文档键，不在表内）', sorted(ops.PUBLIC_PROJECTION_KEYS), sorted(Object.keys(pub).filter((k) => k !== '_id')))
check('B4b', '**公开行零身份字段**', [], Object.keys(pub).filter((k) => ops.IDENTITY_PROJECTION_KEYS.indexOf(k) !== -1))
check('B4c', '公开投影自述 schema / 状态', { schema: ops.PUBLIC_SCHEMA, status: 'ACCEPTED' }, { schema: pub.schema, status: pub.status })
const privateDoc = store.collections.xiai_corrections.get('doc-name') || {}
check('B5', '私有行 status / reviewed_at / reviewer_id 三键齐落', true, privateDoc.status === 'ACCEPTED' && typeof privateDoc.reviewed_at === 'string' && privateDoc.reviewed_at !== '' && privateDoc.reviewer_id === uidOfPhone(PHONE))
check('B5b', '回包权威行 status ＝ ACCEPTED', 'ACCEPTED', reviewed.row && reviewed.row.status)
check('B5c', '采纳理由不落 `review_note`（采纳 / 空理由不出现该键）', false, Object.prototype.hasOwnProperty.call(privateDoc, 'review_note'))

/* ===========================================================================
   C 段：② 非白名单 ⇒ FORBIDDEN ＋ 零写入
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '② 非白名单 ⇒ FORBIDDEN ＋ 零写入' }))
store.load(CLOUD_SEED)
const foreign = await fn.main({ action: 'verify', token: tokenFor(NON_WHITELIST_PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
check('C1', '非白名单 ⇒ FORBIDDEN（恰 3 键）', true, isDenial(foreign) && foreign.reason === 'FORBIDDEN')
check('C1b', '非白名单 ⇒ 零写入', 0, store.stats.writes.length)
check('C1c', '非白名单的私有行未被改动（仍 PENDING）', 'PENDING', (store.collections.xiai_corrections.get('doc-name') || {}).status)
{
  const rewardDeny = await fn.main({ action: 'verify', token: tokenFor(NON_WHITELIST_PHONE), op: 'setInviteReward', payload: { value: 5 } })
  check('C2', '非白名单 ⇒ `setInviteReward` 同样 FORBIDDEN', true, isDenial(rewardDeny) && rewardDeny.reason === 'FORBIDDEN')
}

/* ===========================================================================
   D 段：③ 缺 XIAI_ADMIN_PHONE ⇒ 管理员类 op 全拒；普通用户写面不受影响
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '③ 缺 env 安全拒 ＋ 不误伤普通用户写面' }))
const savedAdminPhone = process.env.XIAI_ADMIN_PHONE
delete process.env.XIAI_ADMIN_PHONE
{
  /* 管理员类 op 全拒（STORAGE_UNAVAILABLE，非 FORBIDDEN —— 「内部不可用」≠「越权」）＋ 零写入。 */
  store.load(CLOUD_SEED)
  const denyReview = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'reviewCorrection', payload: { correction_id: CORRECTION_ID, decision: 'ACCEPTED' } })
  check('D1', '缺 env ⇒ `reviewCorrection` 安全拒（STORAGE_UNAVAILABLE）', true, isDenial(denyReview) && denyReview.reason === 'STORAGE_UNAVAILABLE')
  check('D1b', '缺 env ⇒ 错误 ≠ FORBIDDEN（未配置不是「越权」）', true, denyReview.reason !== 'FORBIDDEN')
  check('D1c', '缺 env ⇒ 零写入', 0, store.stats.writes.length)
  const denyReward = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'setInviteReward', payload: { value: 5 } })
  check('D2', '缺 env ⇒ `setInviteReward` 同样安全拒（STORAGE_UNAVAILABLE）', true, isDenial(denyReward) && denyReward.reason === 'STORAGE_UNAVAILABLE')
  check('D2b', '缺 env ⇒ 管理员类 op 全部落 zero-write（本段累计写入仍 0）', 0, store.stats.writes.length)
  /* **不误伤**：普通用户写面（提交 / 采信）在缺 env 下仍可用且落盘。 */
  store.load(CLOUD_SEED)
  const submitOk = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'submitCorrection', payload: { faceId: 'fc-env-safe', sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: '缺 env 仍可提交', basis: '' } })
  check('D3', '缺 env ⇒ 普通用户 `submitCorrection` **仍可用**（ok:true）', true, submitOk.ok === true)
  check('D3b', '缺 env ⇒ 普通用户提交确有落盘（不误伤；提交 ＝ 2 处：勘误行 ＋ 值级公开摘要）', 2, store.stats.writes.length)
  store.load(CLOUD_SEED)
  const endorsePayload = { faceId: 'fc-env-safe', sealId: SEAL_ID, stampId: SEAL_ID, field: 'author', value: '甲值' }
  await fn.main({ action: 'verify', token: tokenFor(NON_WHITELIST_PHONE), op: 'submitCorrection', payload: { ...endorsePayload, basis: '' } })
  const writeCountBeforeEndorse = store.stats.writes.length
  const endorseOk = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'endorseCorrection', payload: endorsePayload })
  check('D4', '缺 env ⇒ 普通用户 `endorseCorrection` **仍可用**（ok:true）', true, endorseOk.ok === true)
  check('D4b', '缺 env ⇒ 采信仍两处落盘（不误伤）', 2, store.stats.writes.length - writeCountBeforeEndorse)
}
process.env.XIAI_ADMIN_PHONE = savedAdminPhone

/* ===========================================================================
   E 段：④ 自愈（有会话先补签、无会话则拒）
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '④ 自愈：有会话先 issue 后 verify；无会话拒' }))
/* E1：无令牌 ＋ 有会话 ⇒ 先 issue 补签、后 verify 成功。 */
userTokenSvc.clearUserToken()
session.setUser({ id: uidOfPhone(PHONE), phone: PHONE, role: 'admin', nickname: '管理員' })
resetCalls()
const beforeE1 = readReward()
const healed = await adminSvc.setInviteReward(null, 11)
check('E1', '无令牌 ＋ **有会话** ⇒ 写成功（ok:true）', true, healed.ok === true && healed.value === 11)
check('E1b', '自愈写落盘（站点配置键 ＝ 11）', { invite_reward: 11 }, readReward())
check('E1c', '自愈顺序：**先 issue 补签、后 verify**', true, firstIndex('issue') !== -1 && firstIndex('verify') !== -1 && firstIndex('issue') < firstIndex('verify'))
check('E1d', '自愈后令牌已入内存（present＝true）', true, userTokenSvc.userTokenSnapshot().present === true)
/* E2（负向）：无令牌 ＋ 无会话 ⇒ 结构化拒绝 ＋ 零写入 ＋ 零往返。 */
userTokenSvc.clearUserToken()
session.setUser(null)
resetCalls()
const beforeE2 = readReward()
const denied = await adminSvc.setInviteReward(null, 12)
check('E2', '无令牌 ＋ **无会话** ⇒ 结构化拒绝（ok:false ＋ reason）', true, denied.ok === false && typeof denied.reason === 'string' && denied.reason.length > 0)
check('E2b', '无会话 ⇒ 零写入（站点配置键未变）', beforeE2, readReward())
check('E2c', '无会话 ⇒ 零往返（连补签 request 都不发）', 0, calls.length)
/* E2d：直接对 userWriteGate 再取一次读数，与上面的服务层结论一致。 */
const gate = await userWriteSvc.ensureUserTokenForWrite()
check('E2d', '无会话 ⇒ `ensureUserTokenForWrite` 结构化拒绝', true, gate.ok === false && typeof gate.reason === 'string')
session.setUser({ id: uidOfPhone(PHONE), phone: PHONE, role: 'admin', nickname: '管理員' })

/* ===========================================================================
   F 段：⑤ 校驗碼输入位机械检索（审核页 / PointsView，去注释）
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: '⑤ 无校驗碼输入位（去注释检索）' }))
function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
const CODEFIELD_RE = /data-review-write-code|寫入校驗碼/
check('F1p', '正对照：含校驗碼输入位钩子的样本必须命中', true, CODEFIELD_RE.test('x data-review-write-code y 寫入校驗碼 z'))
check('F1n', '负对照：不含钩子的样本不命中', false, CODEFIELD_RE.test('純繁體文案：請先登錄後再執行此操作'))
{
  const my = stripComments(readFileSync(path.join(ROOT, 'src/views/MyCorrectionsView.vue'), 'utf8'))
  const pt = stripComments(readFileSync(path.join(ROOT, 'src/views/PointsView.vue'), 'utf8'))
  check('F2', '审核页（去注释）无校驗碼输入位', false, CODEFIELD_RE.test(my))
  check('F2b', 'PointsView（去注释）无校驗碼输入位', false, CODEFIELD_RE.test(pt))
  const srcHits = walkFiles(path.join(ROOT, 'src')).filter((file) => CODEFIELD_RE.test(stripComments(readFileSync(file, 'utf8'))))
  check('F2c', '`src/**` 码面（去注释）「校驗碼输入位」命中 **0**', [], srcHits.map((f) => path.relative(ROOT, f)))
}

/* ===========================================================================
   G 段：⑥ `[data-admin-action]` 去重集合 10 值 / 归并 9 类 ＋ canary
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '⑥ data-admin-action 去重集合 10 值 / 9 类' }))
const FROZEN_ADMIN_ACTIONS = [
  'correction-accept',
  'correction-reject',
  'edit-fixed-attributes',
  'edit-invite-reward',
  'edit-seal-attributes',
  'export-seal-data',
  'person-proposal-review',
  'person-import-review',
  'replace-face-image',
  'upload-seal'
]
const MERGED_CLASSES = ['correction-accept', 'edit-fixed-attributes', 'edit-invite-reward', 'edit-seal-attributes', 'export-seal-data', 'person-proposal-review', 'person-import-review', 'replace-face-image', 'upload-seal']
{
  const found = new Set()
  walkFiles(path.join(ROOT, 'src')).forEach((file) => {
    const body = stripComments(readFileSync(file, 'utf8'))
    const matches = body.match(/data-admin-action="([^"]+)"/g) || []
    matches.forEach((m) => found.add(m.replace(/data-admin-action="/, '').replace(/"$/, '')))
  })
  const scanned = [...found].sort()
  check('G1', '去重取值集合逐字 ＝ 冻结 10 值（v1.54）', FROZEN_ADMIN_ACTIONS.slice().sort(), scanned)
  const merged = scanned.map((v) => (v === 'correction-reject' ? 'correction-accept' : v))
  check('G2', '按归并表归并 ⇒ 恰 9 类（v1.54：person-import-review 自成一类）', MERGED_CLASSES.slice().sort(), [...new Set(merged)].sort())
  const canary = 'qa-canary-9th'
  const withCanary = [...new Set([...scanned, canary])]
  check('G1c', '正对照：注入 canary 取值 ⇒ 集合变 11（非恒等；v1.54 基线 10）', 11, withCanary.length)
  check('G1c2', '负对照：移除 canary 后回基线 10', 10, withCanary.filter((v) => v !== canary).length)
}

/* ===========================================================================
   H 段：⑦ 上屏文案繁體（正 / 负对照）
   =========================================================================== */
console.log(JSON.stringify({ section: 'H', title: '⑦ 上屏文案繁體' }))
const SIMPLIFIED_ONLY = new Set(
  '说这认边过请对员码确录记误页项题类别输选择开关击钮盘师价体变总积键种样数据获奖励审览处办当给让删询详单号称显标签档尽为无与专业东丝两严个临汉从众们会优传伟伤伦'.split('')
)
const hasSimplified = (text) => [...new Set([...text].filter((ch) => SIMPLIFIED_ONLY.has(ch)))]
check('H1', '正对照：已知简体串必命中（探测器有效）', true, hasSimplified('这里说数据').length > 0)
check('H2', '负对照：纯繁体串不命中', [], hasSimplified('這裏說數據'))
{
  const targets = [
    'src/services/admin.js',
    'src/services/corrections.js',
    'src/services/endorsements.js',
    'src/services/userWrite.js',
    'src/views/MyCorrectionsView.vue',
    'src/views/PointsView.vue',
    'cloudfunctions/xiai-user-token/index.js',
    'cloudfunctions/xiai-user-token/lib/ops.js',
    'cloudfunctions/xiai-user-token/lib/config.js'
  ]
  const hits = targets.filter((rel) => hasSimplified(stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))).length > 0)
  check('H3', '本单触及文件（去注释）上屏文案无简化字', [], hits)
}

/* ===========================================================================
   I 段：⑧ 客户端对 xiai-admin-token 零业务引用（如实登记转口 / 管道本体）
   =========================================================================== */
console.log(JSON.stringify({ section: 'I', title: '⑧ 客户端对 xiai-admin-token 零业务引用' }))
{
  const serviceFiles = walkFiles(path.join(ROOT, 'src/services'))
  const viewFiles = walkFiles(path.join(ROOT, 'src/views'))
  const scope = [...serviceFiles, ...viewFiles].map((f) => path.relative(ROOT, f)).sort()
  const CALL_RE = /\badminGate\s*\(|\bensureAdminWriteSession\s*\(/
  const callHits = scope.filter((rel) => CALL_RE.test(readFileSync(path.join(ROOT, rel), 'utf8')))
  /* 管道本体 `token.js`（定义两条兼容 API）以外的**调用点**必须为 0。 */
  check('I1', '`src/services/**` ＋ `src/views/**` 除 `token.js` 外无 `adminGate(` / `ensureAdminWriteSession(` 调用点', [], callHits.filter((rel) => rel !== 'src/services/token.js'))
  check('I1b', '如实登记：命中恰为管道本体 `token.js`（定义 2 处）', { file: 'src/services/token.js', count: 2 }, { file: callHits[0] || '', count: (readFileSync(path.join(ROOT, 'src/services/token.js'), 'utf8').match(/\badminGate\s*\(|\bensureAdminWriteSession\s*\(/g) || []).length })
  /* 业务导入面：除 `adminToken.js` 自身外，无任何 services / views 文件 import 它。 */
  const IMPORT_RE = /from\s+['"][^'"]*adminToken\.js['"]/
  const importHits = scope.filter((rel) => rel !== 'src/services/adminToken.js' && IMPORT_RE.test(readFileSync(path.join(ROOT, rel), 'utf8')))
  check('I2', '无任何 services / views 文件 import `adminToken.js`（零业务引用）', [], importHits)
  /* 如实登记：`adminToken.js` 已退化为纯转口（不再自带实现）。 */
  const facade = readFileSync(path.join(ROOT, 'src/services/adminToken.js'), 'utf8')
  check('I3', '如实登记：`adminToken.js` 为兼容转口（`export * from ./token.js`，无状态、无判定）', true, /export\s+\*\s+from\s+'\.\/token\.js'/.test(facade) && !/function\s+\w+\s*\(/.test(facade))
  /* 业务写面确认走用户通道（正对照：review/setInviteReward 的服务实现 import 的是 userWrite）。 */
  const correctionsSrc = readFileSync(path.join(ROOT, 'src/services/corrections.js'), 'utf8')
  const adminSrc = readFileSync(path.join(ROOT, 'src/services/admin.js'), 'utf8')
  check('I3b', '正对照：`corrections.js` / `admin.js` 的业务写面经 `./userWrite.js`（不是 adminToken）', { c: true, a: true }, {
    c: /from\s+'\.\/userWrite\.js'/.test(correctionsSrc),
    a: /from\s+'\.\/userWrite\.js'/.test(adminSrc)
  })
}

/* ===========================================================================
   J 段：⑨ migrateDynastyValues 一次性朝代值迁移（§3.53.5）
   =========================================================================== */
console.log(JSON.stringify({ section: 'J', title: '⑨ 一次性朝代值迁移：预演 / 执行 / 重放' }))
const ADMIN_IDENTITY = { uid: uidOfPhone(PHONE), phone: PHONE, identity_source: 'SERVER_TOKEN' }
const ADMIN_CTX = { adminPhone: PHONE, nowSeconds: nowS() }
/* 种子：seals 6 行（2 命中 ＋ 4 相邻/新值域/空值不动）＋ faces 3 行（2 命中 ＋ 1 新值域不动）。 */
const DYN_SEED = [
  { __collection: 'xiai_seals', _id: 's1', id: 's1', stamp_id: 'XAI-1', seal_name: '甲', dynasty: '战国' },
  { __collection: 'xiai_seals', _id: 's2', id: 's2', stamp_id: 'XAI-2', seal_name: '乙', dynasty: '秦汉' },
  { __collection: 'xiai_seals', _id: 's3', id: 's3', stamp_id: 'XAI-3', seal_name: '丙', dynasty: '明' },
  { __collection: 'xiai_seals', _id: 's4', id: 's4', stamp_id: 'XAI-4', seal_name: '丁', dynasty: '清' },
  { __collection: 'xiai_seals', _id: 's5', id: 's5', stamp_id: 'XAI-5', seal_name: '戊', dynasty: '明早中期' },
  { __collection: 'xiai_seals', _id: 's6', id: 's6', stamp_id: 'XAI-6', seal_name: '己', dynasty: '' },
  { __collection: 'xiai_faces', _id: 'f1', id: 'f1', sealId: 's1', dynasty: '战国' },
  { __collection: 'xiai_faces', _id: 'f2', id: 'f2', sealId: 's2', dynasty: '秦汉' },
  { __collection: 'xiai_faces', _id: 'f3', id: 'f3', sealId: 's3', dynasty: '民國' }
]
const findRow = (collection, id) => store.collections[collection].get(id) || {}
/* J1：预演（dry_run:true，缺省）⇒ 零写入 ＋ 计数正确 ＋ 抽样。 */
store.load(DYN_SEED)
const dry = await ops.ADMIN_OPS.migrateDynastyValues({ dry_run: true }, ADMIN_IDENTITY, ADMIN_CTX)
if (dry.plan) await ops.persist(dry.plan)
check('J1', '预演 ⇒ ok ＋ op ＋ dry_run:true', { ok: true, op: 'migrateDynastyValues', dry_run: true }, { ok: dry.ok, op: dry.op, dry_run: dry.dry_run })
check('J1b', '预演 ⇒ scanned ＝ 逐集合读取行数', { seals: 6, faces: 3 }, dry.scanned)
check('J1c', '预演 ⇒ changed ＝ 逐集合目标值命中数', { seals: 2, faces: 2 }, dry.changed)
check('J1d', '预演 ⇒ **零写入**（无落盘计划）', 0, store.stats.writes.length)
check('J1e', '预演 ⇒ idempotent:false（库内有残留）', false, dry.idempotent)
check('J1f', '抽样给出 from/to（战国⇒戰國 / 秦汉⇒空）', true, dry.samples.some((s) => s.from === '战国' && s.to === '戰國') && dry.samples.some((s) => s.from === '秦汉' && s.to === ''))
/* J2：执行（dry_run:false）⇒ 只改点名值；相邻值逐字不动。 */
store.load(DYN_SEED)
const run = await ops.ADMIN_OPS.migrateDynastyValues({ dry_run: false }, ADMIN_IDENTITY, ADMIN_CTX)
if (run.plan) await ops.persist(run.plan)
check('J2', '执行 ⇒ changed 命中数不变', { seals: 2, faces: 2 }, run.changed)
check('J2b', '执行 ⇒ 只改点名值：战国 ⇒ 戰國', '戰國', findRow('xiai_seals', 's1').dynasty)
check('J2c', '执行 ⇒ 只改点名值：秦汉 ⇒ 置空', '', findRow('xiai_seals', 's2').dynasty)
check('J2d', '⑤ 相邻值不动（seals：明 / 清 / 明早中期 / 空）', ['明', '清', '明早中期', ''], ['s3', 's4', 's5', 's6'].map((id) => findRow('xiai_seals', id).dynasty))
check('J2e', '⑤ 相邻值不动（faces：新值域值 民國）', '民國', findRow('xiai_faces', 'f3').dynasty)
check('J2f', '执行 ⇒ 落盘数 ＝ 命中数（4 处 update）', 4, store.stats.writes.length)
/* J3：重放（无残留）⇒ changed 全 0 ＋ 幂等 ＋ 零写入。 */
const beforeReplay = store.stats.writes.length
const replay = await ops.ADMIN_OPS.migrateDynastyValues({ dry_run: false }, ADMIN_IDENTITY, ADMIN_CTX)
if (replay.plan) await ops.persist(replay.plan)
check('J3', '重放 ⇒ changed 全 0（无残留）', { seals: 0, faces: 0 }, replay.changed)
check('J3b', '重放 ⇒ idempotent:true', true, replay.idempotent)
check('J3c', '重放 ⇒ **零写入**', 0, store.stats.writes.length - beforeReplay)
/* J4：非白名单 ⇒ FORBIDDEN ＋ 零写入。 */
store.load(DYN_SEED)
const foreignMig = await ops.ADMIN_OPS.migrateDynastyValues({ dry_run: false }, { uid: 'u-x', phone: NON_WHITELIST_PHONE, identity_source: 'SERVER_TOKEN' }, ADMIN_CTX)
check('J4', '非白名单 ⇒ FORBIDDEN（恰 3 键）', true, isDenial(foreignMig) && foreignMig.reason === 'FORBIDDEN')
check('J4b', '非白名单 ⇒ 零写入', 0, store.stats.writes.length)
/* J5：缺 env ⇒ STORAGE_UNAVAILABLE ＋ 零写入。 */
const noEnvMig = await ops.ADMIN_OPS.migrateDynastyValues({ dry_run: false }, ADMIN_IDENTITY, { adminPhone: '', nowSeconds: nowS() })
check('J5', '缺 env ⇒ STORAGE_UNAVAILABLE（非 FORBIDDEN）', true, isDenial(noEnvMig) && noEnvMig.reason === 'STORAGE_UNAVAILABLE')
check('J5b', '缺 env ⇒ 零写入', 0, store.stats.writes.length)
/* J6：契约面（封闭键面 / 两值映射 / 未知键门）。 */
check('J6', '载荷封闭键面 ＝ [dry_run]', ['dry_run'], ops.MIGRATE_ALLOWED_KEYS.slice())
check('J6b', '迁移映射恰两值（战国⇒戰國 / 秦汉⇒空）', { '战国': '戰國', '秦汉': '' }, Object.assign({}, ops.DYNASTY_MIGRATION))
const badKey = await ops.ADMIN_OPS.migrateDynastyValues({ nope: 1 }, ADMIN_IDENTITY, ADMIN_CTX)
check('J6c', '未知载荷键 ⇒ INVALID_FIELD ＋ 零写入', true, isDenial(badKey) && badKey.reason === 'INVALID_FIELD' && store.stats.writes.length === 0)
/* J7：真实入口（fn.main）预演 ⇒ ok:true ＋ 零写入。 */
const viaMain = await fn.main({ action: 'verify', token: tokenFor(PHONE), op: 'migrateDynastyValues', payload: { dry_run: true } })
check('J7', '真实入口（fn.main）预演 ⇒ ok:true ＋ 零写入', true, viaMain.ok === true && store.stats.writes.length === 0)

/* ===========================================================================
   汇总
   =========================================================================== */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    db_writes_by_harness: store.stats.writes.length,
    wire_calls: calls.length,
    token: { present: userTokenSvc.userTokenSnapshot().present, fingerprint: fingerprint('present') }
  })
)
process.exit(failures === 0 ? 0 : 1)
