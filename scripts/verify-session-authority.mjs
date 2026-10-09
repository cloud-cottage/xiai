/**
 * 玺爱 · **V6-a 自检：调用者平台会话身份判权**（additive、零停机）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络**（会话身份注入 ＋ 假 DB ＋ 直接调用两个写面云函数的真实函数体）。
 *
 * 跑什么（逐条对应本单契约）：
 *   A. **判权内核**（`lib/sessionAuthority.js`，两函数**逐字节同份**）：归一化 / 开关 /
 *      角色取值 / 常量面；两副本 sha256 恒等。
 *   B. **管理员写面（`xiai-admin-token`）**：会话在场 ⇒ **优先**取会话身份查 `xiai_roles`
 *      判权（要求 admin）；**fail-closed**（无行 / 角色不合 / 读失败 ⇒ 结构化拒绝 ＋ 零写入）；
 *      **拿不到会话 ⇒ 回落既有令牌路**（`identity_source` 逐字沿用 `SERVER_TOKEN`）。
 *   C. **用户写面（`xiai-user-token`）**：会话在场 ⇒ 会话路（`submitCorrection` 落
 *      `identity_source:'SESSION'`）；admin op 在会话角色不足时拒；同样可回落令牌路。
 *   D. **静态扫描**：`sessionAuthority.js` 两副本逐字节同份 ＋ 零 SDK / 零句柄 / 零 fs ＋
 *      集合句柄调用仍**只**出现在 `lib/ops.js`（两个函数各判一次）。
 *   **V6-a 加固（只增不减）**：开关**惰性缺省 off**（A11 / A11b / A11c / A11d、B8）、
 *      只读诊断 op `sessionProbe`（A17 / A18、B9 / B9c、C7）——**修订**：探针从「全零信封」
 *      改为 **context 形状诊断**（**布尔-only ＋ 零值回显**：候选容器存在性 / uidPresent /
 *      uidKind / anonymousMarker / mode）；A18 / B9 / B9c / C7 的期望值随新契约更新
 *      （**检查条目只增不减**），新增 A18b / A18c / A18d / A18e / A18f / A18g、
 *      B9d / B9e / B9f / B9g、C7c / C7d、
 *      角色行形状对账 `role` 单值 / `roles` 数组 ＋ 大小写不敏感（A10b / A10c）。
 *
 * 纪律：不打印任何密钥 / 验证码 / 令牌原文（只给长度与指纹）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 */

import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 断言与读数
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
   1. 环境（**密钥 / 验证码只从环境变量来；缺省合成一次性假环境，绝不写进仓**）
   --------------------------------------------------------------------------- */
const ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '16600001656').trim()
const ADMIN_CODE = String(process.env.XIAI_ADMIN_SMS_CODE || '729341')
const ADMIN_SECRET = String(process.env.XIAI_ADMIN_TOKEN_SECRET || randomBytes(32).toString('hex'))

const authForCode = await import(path.join(ROOT, 'src/services/auth.js'))
const USER_CODE = String(authForCode.DEMO_SMS_CODE)
const USER_PHONE = String(process.env.XIAI_USER_PHONE || '13800000001').trim()
const USER_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || randomBytes(32).toString('hex'))

process.env.XIAI_ADMIN_PHONE = ADMIN_PHONE
process.env.XIAI_ADMIN_SMS_CODE = ADMIN_CODE
process.env.XIAI_ADMIN_TOKEN_SECRET = ADMIN_SECRET
process.env.XIAI_ADMIN_TOKEN_VERSION = process.env.XIAI_ADMIN_TOKEN_VERSION || '1'
process.env.XIAI_USER_SMS_CODE = USER_CODE
process.env.XIAI_USER_TOKEN_SECRET = USER_SECRET
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'

/* **V6-a 加固**：会话判权开关**惰性缺省 off** ⇒ 本自检的 B / C 段**显式置 `prefer`** 以覆盖会话路；
   缺省 off 的断言另见 A 段（A11 / A11b / A11c / A11d）与 B8 / B9c。 */
process.env.XIAI_SESSION_AUTHORITY = 'prefer'

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_FIELD', 'INVALID_VALUE', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE']
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1

/* ---------------------------------------------------------------------------
   2. 加载被测件（两个云函数本体 ＋ 判权内核 ＋ 集合面）
   --------------------------------------------------------------------------- */
const USER_FN_DIR = 'cloudfunctions/xiai-user-token'
const ADMIN_FN_DIR = 'cloudfunctions/xiai-admin-token'

const userFn = require(path.join(ROOT, USER_FN_DIR, 'index.js'))
const adminFn = require(path.join(ROOT, ADMIN_FN_DIR, 'index.js'))
const userOps = require(path.join(ROOT, USER_FN_DIR, 'lib/ops.js'))
const adminOps = require(path.join(ROOT, ADMIN_FN_DIR, 'lib/ops.js'))
const userSaPath = path.join(ROOT, USER_FN_DIR, 'lib/sessionAuthority.js')
const adminSaPath = path.join(ROOT, ADMIN_FN_DIR, 'lib/sessionAuthority.js')
const userSa = require(userSaPath)
const adminSa = require(adminSaPath)

/* ---------------------------------------------------------------------------
   3. 假 DB（记录写；支持 where/doc/add/update；可注入「角色读失败」）
   --------------------------------------------------------------------------- */
const store = { writes: [], maps: new Map(), failRoleRead: false }
function mapOf(name) {
  if (!store.maps.has(name)) store.maps.set(name, new Map())
  return store.maps.get(name)
}
function fakeDbProvider() {
  return {
    collection(name) {
      const map = mapOf(name)
      const guard = () => {
        if (name === 'xiai_roles' && store.failRoleRead) throw new Error('injected-role-read-failure')
      }
      return {
        where(match) {
          const hit = () =>
            [...map.values()].filter((row) => Object.keys(match).every((key) => String(row[key]) === String(match[key])))
          return {
            async get() {
              guard()
              return { data: hit().map((row) => Object.assign({}, row)) }
            },
            async update(patch) {
              guard()
              const rows = hit()
              rows.forEach((row) => Object.assign(row, patch))
              store.writes.push({ collection: name, kind: 'update', match, doc: patch, updated: rows.length })
              return { updated: rows.length }
            }
          }
        },
        doc(id) {
          return {
            async get() {
              guard()
              const row = map.get(id)
              return row ? { data: [Object.assign({}, row)] } : { data: [] }
            },
            async set(doc) {
              guard()
              map.set(id, Object.assign({ _id: id }, doc))
              store.writes.push({ collection: name, kind: 'set', id, doc })
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          guard()
          const id = `doc-${store.writes.length + 1}`
          map.set(id, Object.assign({ _id: id }, doc))
          store.writes.push({ collection: name, kind: 'add', doc })
          return { id }
        }
      }
    }
  }
}

userOps.setOpsDbProvider(fakeDbProvider)
adminOps.setOpsDbProvider(fakeDbProvider)

/* 会话身份注入缝：可变 `currentSession`（两个函数的 `sessionAuthority` **各一份实例**，两处都注入）。 */
let currentSession = null
const sessionProvider = () => currentSession
userSa.setSessionIdentityProvider(sessionProvider)
adminSa.setSessionIdentityProvider(sessionProvider)

/* 角色行种子：会话 uid → 角色（`_id` ＝ uid；另有 `uid` 字段供等值检索）。 */
const ADMIN_UID = 'plat-admin-uid'
const USER_UID = 'plat-user-uid'
const ORPHAN_UID = 'plat-orphan-uid'
function seedRoles() {
  const roles = mapOf('xiai_roles')
  roles.clear()
  roles.set(ADMIN_UID, { _id: ADMIN_UID, uid: ADMIN_UID, role: 'admin', schema: 'xiai-roles-v1' })
  roles.set(USER_UID, { _id: USER_UID, uid: USER_UID, role: 'user', schema: 'xiai-roles-v1' })
}
function seedCorrection() {
  const rows = mapOf('xiai_corrections')
  rows.clear()
  rows.set('doc-pend', {
    _id: 'doc-pend',
    id: 'cr-pend',
    faceId: 'fc-1',
    sealId: 'XA000000001',
    stamp_id: 'XA000000001',
    field: 'author',
    value: '測試作者',
    status: 'PENDING'
  })
}
function resetWorld() {
  store.writes = []
  store.failRoleRead = false
  currentSession = null
  seedRoles()
  seedCorrection()
}
const nowS = () => Math.floor(Date.now() / 1000)

/* ===========================================================================
   A 段：判权内核（`lib/sessionAuthority.js`）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '判权内核 sessionAuthority.js' }))

const sha256 = (file) => createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex')
check('A1', '两函数 `lib/sessionAuthority.js` **逐字节同份**（sha256 恒等）', sha256(userSaPath), sha256(adminSaPath))
check('A2', '角色集合名恒为 `xiai_roles`（两副本）', ['xiai_roles', 'xiai_roles'], [userSa.ROLES_COLLECTION, adminSa.ROLES_COLLECTION])
check('A3', '集合白名单已登记 `xiai_roles`（两 ops）', ['xiai_roles', 'xiai_roles'], [userOps.COLLECTIONS.roles, adminOps.COLLECTIONS.roles])
check('A4', '身份来源标记面（additive）', { SESSION: 'SESSION', SERVER_TOKEN: 'SERVER_TOKEN' }, userSa.IDENTITY_SOURCES)
check('A5', '角色取值面（封闭二值）', ['admin', 'user'], userSa.KNOWN_ROLES.slice().sort())
check('A6', '归一化：合法 uid ⇒ present:true', { present: true, uid: 'x', anonymous: false }, userSa.normalizeSessionIdentity({ uid: 'x' }))
check('A7', '归一化：匿名 ⇒ present:false（回落信号，非失败）', { present: false, uid: '', anonymous: true }, userSa.normalizeSessionIdentity({ uid: 'x', isAnonymous: true }))
check('A8', '归一化：空 uid ⇒ present:false', { present: false, uid: '', anonymous: false }, userSa.normalizeSessionIdentity({}))
check('A9', '归一化：null ⇒ present:false', { present: false, uid: '', anonymous: false }, userSa.normalizeSessionIdentity(null))
check('A10', '角色取值：认得出 / 认不出', ['admin', '', ''], [userSa.roleFromRow({ role: 'admin' }), userSa.roleFromRow({ role: 'x' }), userSa.roleFromRow(null)])
check('A10b', '角色行形状对账：`roles` 数组**也认** ＋ **大小写不敏感**', ['admin', 'user'], [userSa.roleFromRow({ roles: ['ADMIN'] }), userSa.roleFromRow({ roles: ['User'] })])
check('A10c', '角色行形状对账：`role` 优先、`roles` 兜底、认不出 ⇒ 空串', ['admin', 'admin', 'user', '', ''], [userSa.roleFromRow({ role: 'admin', roles: ['user'] }), userSa.roleFromRow({ roles: ['admin', 'USER'] }), userSa.roleFromRow({ role: '', roles: ['user'] }), userSa.roleFromRow({ roles: [] }), userSa.roleFromRow({ roles: ['x'] })])
check('A11', '开关**惰性缺省** ⇒ off（不显式开就不启用）', 'off', userSa.readMode({}))
check('A11b', '开关显式 `prefer` ⇒ prefer（唯一启用路径）', 'prefer', userSa.readMode({ XIAI_SESSION_AUTHORITY: 'prefer' }))
check('A11c', '开关**大小写不敏感**：`PREFER` ⇒ prefer', 'prefer', userSa.readMode({ XIAI_SESSION_AUTHORITY: 'PREFER' }))
check('A11d', '开关其它值（`on` / 空串 / 空白）⇒ off（非显式 prefer 一律停用）', ['off', 'off', 'off'], [userSa.readMode({ XIAI_SESSION_AUTHORITY: 'on' }), userSa.readMode({ XIAI_SESSION_AUTHORITY: '' }), userSa.readMode({ XIAI_SESSION_AUTHORITY: '  ' })])
check('A12', '开关 `off` ⇒ off（回滚开关）', 'off', userSa.readMode({ XIAI_SESSION_AUTHORITY: 'off' }))
check('A13', '身份标记判定：会话 / 令牌 / 空', [true, false, false], [userSa.isSessionIdentity({ identity_source: 'SESSION' }), userSa.isSessionIdentity({ identity_source: 'SERVER_TOKEN' }), userSa.isSessionIdentity(null)])
check('A14', '标记取值回落：认不出 ⇒ 既有令牌值', 'SERVER_TOKEN', userSa.identitySourceOf({ uid: 'x' }))
check('A15', '身份可用判据：令牌路需手机号、会话路可缺', [true, false, true], [userSa.identityUsable({ uid: 'u', phone: '16600' }), userSa.identityUsable({ uid: 'u' }), userSa.identityUsable({ uid: 'u', identity_source: 'SESSION' })])
check('A16', '注入缝可见性', true, userSa.sessionIdentityInjected() && adminSa.sessionIdentityInjected())
check('A17', '诊断 op 名 ＋ 判定（去空白后逐字比对、大小写敏感）', ['sessionProbe', true, true, false], [userSa.SESSION_PROBE_OP, userSa.isSessionProbe('sessionProbe'), userSa.isSessionProbe(' sessionProbe '), userSa.isSessionProbe('verify')])
check('A18', '诊断探针 `sessionProbe`：**context 形状诊断**（无 context ⇒ **全零回显**）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: false }, uidPresent: false, uidKind: '', anonymousMarker: false, mode: '' }, userSa.sessionProbe())
check('A18b', '诊断探针：两副本同一 context ⇒ 回包**逐键恒等**', userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }), adminSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }))
check('A18c', '诊断探针：候选容器存在性 ＋ `UID` 键形 ⇒ uidPresent（**如实布尔**）', { ok: true, candidates: { userInfo: false, user: true, auth: false, context: true }, uidPresent: true, uidKind: '', anonymousMarker: false, mode: '' }, userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }))
check('A18d', '诊断探针：匿名标记**在场即真**（不看取值；承载 uid 的容器）／无标记 ⇒ false', [true, false], [userSa.sessionProbe({ userInfo: { uid: 'probe-uid', isAnonymous: false } }).anonymousMarker, userSa.sessionProbe({ userInfo: { uid: 'probe-uid' } }).anonymousMarker])
check('A18e', '诊断探针：`uidKind` / `mode` **恒零值回显**（真实 uid 键形 / 开关态不回吐）', ['', ''], [userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }).uidKind, userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }).mode])
check('A18f', '诊断探针：**布尔-only** —— 键形状冻结 ＋ 回包不含任何 uid 值', true, ((probe) => !JSON.stringify(probe).includes('probe-secret-uid') && shapeOf(probe) === 'anonymousMarker,candidates,mode,ok,uidKind,uidPresent' && shapeOf(probe.candidates) === 'auth,context,user,userInfo')(userSa.sessionProbe({ userInfo: { uid: 'probe-secret-uid' } })))
check('A18g', '诊断探针：context 缺省 / null / 非对象 ⇒ **同一全零回显**（不炸）', [true, true], [JSON.stringify(userSa.sessionProbe()) === JSON.stringify(userSa.sessionProbe(null)), JSON.stringify(userSa.sessionProbe()) === JSON.stringify(userSa.sessionProbe('非对象'))])

/* ===========================================================================
   B 段：管理员写面（xiai-admin-token）
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '管理员写面：会话优先 + fail-closed + 回落' }))

/* B0：无会话 ⇒ 回落令牌路（先签发管理员令牌） */
resetWorld()
const adminIssued = await adminFn.main({ action: 'issue', phone: ADMIN_PHONE, code: ADMIN_CODE })
const adminToken = adminIssued.token
check('B0', '令牌路签发成功（回落基线）', true, adminIssued.ok === true)

/* B1：会话在场（admin 角色）⇒ **无令牌**也成功 */
resetWorld()
currentSession = { uid: ADMIN_UID }
const beforeB1 = store.writes.length
const b1 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B1', '会话路（admin）**无令牌** ⇒ 采纳成功（ok:true）', true, b1.ok === true)
check('B1b', '回包身份来源标记 ＝ SESSION（additive）', 'SESSION', b1.identity_source)
check('B1c', '回包 `identity.identity_source` ＝ SESSION', 'SESSION', b1.identity && b1.identity.identity_source)
check('B1d', '会话路身份 uid ＝ 平台会话 uid', ADMIN_UID, b1.identity && b1.identity.uid)
check('B1e', '会话路回包**不含**令牌续期（会话路无令牌可续）', true, !('renewedToken' in b1))
check('B1f', '私有行 reviewer_id ＝ 平台会话 uid（服务端落盘）', ADMIN_UID, mapOf('xiai_corrections').get('doc-pend').reviewer_id)
check('B1g', '归一化：会话路确有两处写（公开投影 ＋ 私有状态）', 2, store.writes.length - beforeB1)

/* B2：fail-closed —— 会话在场但**角色表无行** ⇒ FORBIDDEN ＋ 零写入（**不回落令牌**） */
resetWorld()
currentSession = { uid: ORPHAN_UID }
const beforeB2 = store.writes.length
const b2 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B2', '会话无角色行 ⇒ FORBIDDEN（fail-closed）', 'FORBIDDEN', b2.reason)
check('B2b', '拒绝形状恰 3 键 ∈ 冻结表', true, isDenial(b2))
check('B2c', '零写入', beforeB2, store.writes.length)

/* B3：fail-closed —— 会话角色 ≠ admin ⇒ FORBIDDEN（管理员函数要求 admin） */
resetWorld()
currentSession = { uid: USER_UID }
const beforeB3 = store.writes.length
const b3 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B3', '会话角色 user 调管理员函数 ⇒ FORBIDDEN', 'FORBIDDEN', b3.reason)
check('B3b', '零写入', beforeB3, store.writes.length)

/* B4：fail-closed —— 角色读失败 ⇒ STORAGE_UNAVAILABLE（**不伪装 FORBIDDEN**）＋ 零写入 */
resetWorld()
currentSession = { uid: ADMIN_UID }
store.failRoleRead = true
const beforeB4 = store.writes.length
const b4 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
store.failRoleRead = false
check('B4', '角色存储不可用 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', 'STORAGE_UNAVAILABLE', b4.reason)
check('B4b', '拒绝形状恰 3 键 ∈ 冻结表', true, isDenial(b4))
check('B4c', '零写入', beforeB4, store.writes.length)

/* B5：拿不到会话（provider 返回匿名）⇒ 回落令牌路（令牌仍有效 ⇒ 成功） */
resetWorld()
currentSession = { uid: ADMIN_UID, isAnonymous: true }
const b5 = await adminFn.main({ action: 'verify', token: adminToken, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B5', '匿名会话 ⇒ 视为「拿不到会话」⇒ 回落令牌路成功', true, b5.ok === true)
check('B5b', '回落令牌路的身份来源标记 ＝ SERVER_TOKEN（既有值逐字不变）', 'SERVER_TOKEN', b5.identity_source)

/* B6：开关 `off` ⇒ 即使会话在场也回落令牌路 */
resetWorld()
process.env.XIAI_SESSION_AUTHORITY = 'off'
currentSession = { uid: ADMIN_UID }
const b6 = await adminFn.main({ action: 'verify', token: adminToken, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
process.env.XIAI_SESSION_AUTHORITY = 'prefer'
check('B6', '开关 off ⇒ 会话路整体停用（回落令牌路）', 'SERVER_TOKEN', b6.identity_source)

/* B7：无令牌 ＋ 无会话 ⇒ FORBIDDEN（回落令牌路的负向仍在） */
resetWorld()
const b7 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B7', '无令牌 ＋ 无会话 ⇒ FORBIDDEN（既有负向不因本单放宽）', 'FORBIDDEN', b7.reason)

/* B8：**惰性缺省 off** —— 未显式开（env 缺省）时，即使会话在场也**回落令牌路** ⇒ 无令牌 ⇒ FORBIDDEN。 */
resetWorld()
delete process.env.XIAI_SESSION_AUTHORITY
currentSession = { uid: ADMIN_UID }
const b8 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B8', '缺省（未显式 prefer）⇒ 会话路停用 ⇒ 无令牌 ⇒ FORBIDDEN', 'FORBIDDEN', b8.reason)
check('B8b', '缺省 off 下会话在场亦零写入', 0, store.writes.length)
process.env.XIAI_SESSION_AUTHORITY = 'prefer'

/* B9：诊断 op `sessionProbe` —— **无令牌可调**、**context 形状诊断**（布尔-only ＋ 零值回显）、**零写入**（不受开关影响）。 */
resetWorld()
const beforeB9 = store.writes.length
const b9 = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('B9', 'sessionProbe **无令牌**可调 ⇒ context 形状诊断（空 context：根容器在场、其余全零）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, uidKind: '', anonymousMarker: false, mode: '' }, b9)
check('B9b', 'sessionProbe 零写入', beforeB9, store.writes.length)
/* B9c：`sessionProbe` **与开关解耦**（缺省 off 亦可调、回包形状不变）。 */
resetWorld()
delete process.env.XIAI_SESSION_AUTHORITY
const b9c = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('B9c', '缺省 off 下 sessionProbe 仍可调（诊断与开关解耦；形状不变）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, uidKind: '', anonymousMarker: false, mode: '' }, b9c)
process.env.XIAI_SESSION_AUTHORITY = 'prefer'
/* B9d：**注入缝不参与诊断** —— 会话在场 ⇒ 探针仍只诊断 context 形状、不消费 provider。 */
resetWorld()
currentSession = { uid: ADMIN_UID }
const b9d = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('B9d', '会话在场 ⇒ sessionProbe 仍只回 context 形状（不消费注入缝、形状不变）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, uidKind: '', anonymousMarker: false, mode: '' }, b9d)
check('B9e', 'sessionProbe 回包不含任何 uid 值（**零泄漏**）', true, !JSON.stringify(b9d).includes(ADMIN_UID))
/* B9f：context 形状被**如实诊断**（`user` 容器 ＋ `UID` 键形）且 uid 值不回吐。 */
resetWorld()
const b9f = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, { user: { UID: ADMIN_UID } })
check('B9f', 'context 带 `user.UID` ⇒ candidates.user ＋ uidPresent 如实为真（uidKind / mode 仍零值）', { ok: true, candidates: { userInfo: false, user: true, auth: false, context: true }, uidPresent: true, uidKind: '', anonymousMarker: false, mode: '' }, b9f)
check('B9g', 'context 形状诊断不回吐 uid 值（**零泄漏**）', true, !JSON.stringify(b9f).includes(ADMIN_UID))

/* ===========================================================================
   C 段：用户写面（xiai-user-token）
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '用户写面：会话路 + 角色门 + 回落' }))

const VALID_SUBMIT = { faceId: 'fc-sess', sealId: 'XA000000001', stampId: 'XA000000001', field: 'author', value: '會話路作者', basis: '' }

/* C1：会话（user 角色）⇒ submitCorrection 成功，落 identity_source:'SESSION' */
resetWorld()
currentSession = { uid: USER_UID }
const userIssued = await userFn.main({ action: 'issue', phone: USER_PHONE, code: USER_CODE })
const userToken = userIssued.token
resetWorld()
currentSession = { uid: USER_UID }
const c1 = await userFn.main({ action: 'verify', op: 'submitCorrection', payload: VALID_SUBMIT }, {})
check('C1', '会话路（user）⇒ 提交成功（ok:true）', true, c1.ok === true)
check('C1b', '回包身份来源标记 ＝ SESSION', 'SESSION', c1.identity_source)
check('C1c', '落盘行身份来源标记 ＝ SESSION（additive 新取值）', 'SESSION', c1.row && c1.row.identity_source)
check('C1d', '落盘行 userId ＝ 平台会话 uid', USER_UID, c1.row && c1.row.user_id)
check('C1e', '会话路回包不含令牌续期', true, !('renewedToken' in c1))

/* C2：会话（user）× admin op ⇒ 角色不足 ⇒ FORBIDDEN ＋ 零写入 */
resetWorld()
currentSession = { uid: USER_UID }
const beforeC2 = store.writes.length
const c2 = await userFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('C2', '会话角色 user 调 admin op ⇒ FORBIDDEN（fail-closed）', 'FORBIDDEN', c2.reason)
check('C2b', '零写入', beforeC2, store.writes.length)

/* C3：会话（admin 角色）⇒ 用户函数里的 admin op 放行（角色判据＝xiai_roles） */
resetWorld()
currentSession = { uid: ADMIN_UID }
const c3 = await userFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('C3', '会话（admin）⇒ 用户函数 admin op 放行', true, c3.ok === true)
check('C3b', '私有行 reviewer_id ＝ 平台会话 uid', ADMIN_UID, mapOf('xiai_corrections').get('doc-pend').reviewer_id)

/* C4：拿不到会话 ⇒ 回落令牌路 ⇒ identity_source:'SERVER_TOKEN'（既有值逐字不变） */
resetWorld()
currentSession = null
const c4 = await userFn.main({ action: 'verify', token: userToken, op: 'submitCorrection', payload: VALID_SUBMIT }, {})
check('C4', '无会话 ⇒ 回落令牌路提交成功', true, c4.ok === true)
check('C4b', '回落令牌路身份来源标记 ＝ SERVER_TOKEN', 'SERVER_TOKEN', c4.identity_source)
check('C4c', '回落令牌路落盘行标记仍＝ SERVER_TOKEN（既有断言不破）', 'SERVER_TOKEN', c4.row && c4.row.identity_source)

/* C5：默认平台 context 读法（清注入缝，直接喂 `context.userInfo`） */
resetWorld()
userSa.clearSessionIdentityProvider()
const c5 = await userFn.main({ action: 'verify', op: 'submitCorrection', payload: VALID_SUBMIT }, { userInfo: { uid: USER_UID } })
check('C5', '默认读法：`context.userInfo.uid` ⇒ 会话路（ok:true）', true, c5.ok === true)
check('C5b', '默认读法身份来源标记 ＝ SESSION', 'SESSION', c5.identity_source)
userSa.setSessionIdentityProvider(sessionProvider)

/* C6：会话注入抛错 ⇒ 视为「拿不到会话」⇒ 回落令牌路（不炸） */
resetWorld()
userSa.setSessionIdentityProvider(() => {
  throw new Error('injected-provider-failure')
})
const c6 = await userFn.main({ action: 'verify', token: userToken, op: 'submitCorrection', payload: VALID_SUBMIT }, {})
userSa.setSessionIdentityProvider(sessionProvider)
check('C6', '会话注入抛错 ⇒ 回落令牌路（不抛异常、不炸）', 'SERVER_TOKEN', c6.identity_source)

/* C7：诊断 op `sessionProbe` —— 用户函数同样**无令牌可调**、零写入、context 形状诊断。 */
resetWorld()
const beforeC7 = store.writes.length
const c7 = await userFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('C7', '用户函数 sessionProbe **无令牌**可调 ⇒ context 形状诊断（空 context）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, uidKind: '', anonymousMarker: false, mode: '' }, c7)
check('C7b', 'sessionProbe 零写入', beforeC7, store.writes.length)
/* C7c：context.userInfo 携带 uid ＋ 匿名标记 ⇒ 探针如实报告形状（布尔-only、零值回显、不回吐 uid）。 */
resetWorld()
const c7c = await userFn.main({ action: 'verify', op: 'sessionProbe' }, { userInfo: { uid: USER_UID, isAnonymous: true } })
check('C7c', 'context.userInfo 在场 ⇒ candidates.userInfo ＋ uidPresent ＋ anonymousMarker 如实为真', { ok: true, candidates: { userInfo: true, user: false, auth: false, context: true }, uidPresent: true, uidKind: '', anonymousMarker: true, mode: '' }, c7c)
check('C7d', 'sessionProbe 回包不含任何 uid 值（**零泄漏**）', true, !JSON.stringify(c7c).includes(USER_UID))

/* ===========================================================================
   D 段：静态扫描
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '静态扫描' }))

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}
const FORBIDDEN = /collection\s*\(|database\s*\(|require\(['"]fs['"]\)|writeFile|@cloudbase\/node-sdk|insertOne|updateOne/

for (const dir of [USER_FN_DIR, ADMIN_FN_DIR]) {
  const files = walk(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'))
  const rel = (f) => path.relative(ROOT, f)
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
  const hits = (re) => files.filter((f) => re.test(sources.get(f))).map(rel)
  const tag = dir === USER_FN_DIR ? 'U' : 'A'
  check(`D1${tag}`, `${dir}/…：集合句柄调用（collection(）仍**只**在 lib/ops.js`, [`${dir}/lib/ops.js`], hits(/collection\s*\(/))
  const saSource = sources.get(path.join(ROOT, dir, 'lib/sessionAuthority.js')) || ''
  check(`D2${tag}`, `${dir}/lib/sessionAuthority.js：零 SDK / 零句柄 / 零 fs`, false, FORBIDDEN.test(saSource))
  const eleven = saSource.match(/\b\d{11}\b/g) || []
  check(`D3${tag}`, `${dir}/lib/sessionAuthority.js：零手机号字面值（无 11 位数字）`, [], eleven)
}

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures } }))
process.exit(failures === 0 ? 0 : 1)
