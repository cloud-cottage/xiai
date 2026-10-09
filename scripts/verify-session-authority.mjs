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
 *   **V6-a 追加**：`sessionProbe` 再**追加** node-sdk auth API 通道三读数（`authApiPresent` /
 *      `callerUidViaAuthApi`（**3s 超时护栏**）/ `eventIdentityKeyNames`（**键名-only、排序、≤32**、
 *      绝不回吐任何值））——**布尔-only ＋ 零值回显 ＋ 零值泄漏 ＋ 判权隔离**；探针随之**改为异步**
 *      （契约 ⑨）。检查条目只增不减，新增 A19–A32、B10–B11、C8–C9、D4–D6。
 *   **本单修正**：通道读取器（延迟 require `@cloudbase/node-sdk`）**落点在两 `lib/ops.js`**（两 `index.js`
 *      保持零 SDK 字面）——D4 / D5 / D6 据此指向 `lib/ops.js`（恢复 C3 / C6 / A15 三条静态门；探针语义不变）。
 *   **本单追加②**：`sessionProbe` 再扩**四个诊断位**——两个**零值回显**预留键 `loginTypeValue` /
 *      `eventUidKind`；`callerUidViaAuthApi` 由布尔**改封闭枚举**（`string` / `non-string` / `absent` /
 *      `throw` / `timeout`，只报类型不报值）；**★ 冒充判别** `eventUidMatchesAuthApi`
 *      （`match` / `mismatch` / `unknown`，事件自称 uid ⨯ 通道权威 uid，只报关系不报值）。
 *      A33–A42、B10d、C8b 为新增断言。
 *   **本单追加③（V6-a² 瘦身）**：探针**去掉三个死位**——`uidKind`（uid 键形）／`loginTypeValue`
 *      （登录类型）／`eventUidKind`（事件 uid 键形）三个**恒零值占位**一律删除（键不存在，非「回零值」）；
 *      保留 `mode`（开关态零值回显）。⇒ 探针回包由 12 键收缩为**恰 9 键**（键形冻结 A18f / B10d / A43）。
 *      A18e / A33 / C8b 的期望值随新契约更新为「断言该死位**键不存在**」；**检查条目只增不减**
 *      （新增 A43「恰 9 键、零死位」）。
 *   **本单追加④（V6-a³：带上层裁定）**：**授权身份源改为 auth API 通道**（无注入时；`context` /
 *      `event` 自填 uid **不再**作判权源）；判权改**三重分支**（有行且角色足 ⇒ SESSION／有行但角色
 *      不足 ⇒ 拒／无行 · 匿名 · 取数错 ⇒ **兜底回落令牌路**）；旧注释保留 ＋ **取代注**；探针**收尾到
 *      恰 8 键**（删除恒零值死位 `mode`）；**新增冒充模拟**（伪造 `context` / `event` uid ⇒ 必须
 *      仍被拒）＋ 三重分支断言（A44–A52、B2d、B4d、B12、C10）。检查条目只增不减。
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

/* **V6-a 追加**：node-sdk auth API 通道注入缝夹具（契约 ⑨）。
   `NULL_CHANNEL_PROVIDER` 模拟生产离线形态（`lib/ops.js` 懒解析 `@cloudbase/node-sdk` 失败 ⇒ 通道 null）。 */
const NULL_CHANNEL_PROVIDER = () => null
const setAuthChannel = (provider) => {
  userSa.setAuthApiChannelProvider(provider)
  adminSa.setAuthApiChannelProvider(provider)
}
const authThree = (probe) => ({
  authApiPresent: probe.authApiPresent,
  callerUidViaAuthApi: probe.callerUidViaAuthApi,
  eventIdentityKeyNames: probe.eventIdentityKeyNames
})
const AUTH3_ABSENT = { authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [] }
const AUTH3_PRESENT_ABSENT = { authApiPresent: true, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [] }
const AUTH3_PRESENT_NONSTRING = { authApiPresent: true, callerUidViaAuthApi: 'non-string', eventIdentityKeyNames: [] }
const AUTH3_PRESENT_THROW = { authApiPresent: true, callerUidViaAuthApi: 'throw', eventIdentityKeyNames: [] }
const AUTH3_PRESENT_TIMEOUT = { authApiPresent: true, callerUidViaAuthApi: 'timeout', eventIdentityKeyNames: [] }

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
  /* **本单修正（person-model §4.1 / §4.2）**：`author` 自本模型起为**引用型**（载荷值 ＝
     `author_person_id`）⇒ 既有 author 用例的载荷值须指向**既有印人**。按 `id` 补种印人行，
     使其成为**合法引用**（`readPersonRow` 按 `id` 命中）；仅新增种子，未改任何既有断言。 */
  const persons = mapOf('xiai_persons')
  persons.set('會話路作者', { _id: '會話路作者', id: '會話路作者', code: 'PR000000001', display_name: '會話路作者' })
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
check('A18', '诊断探针 `sessionProbe`：**context 形状诊断**（无 context ⇒ **全零回显**）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: false }, uidPresent: false, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, await userSa.sessionProbe())
check('A18b', '诊断探针：两副本同一 context ⇒ 回包**逐键恒等**', await userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }), await adminSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }))
check('A18c', '诊断探针：候选容器存在性 ＋ `UID` 键形 ⇒ uidPresent（**如实布尔**）', { ok: true, candidates: { userInfo: false, user: true, auth: false, context: true }, uidPresent: true, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, await userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } }))
check('A18d', '诊断探针：匿名标记**在场即真**（不看取值；承载 uid 的容器）／无标记 ⇒ false', [true, false], [(await userSa.sessionProbe({ userInfo: { uid: 'probe-uid', isAnonymous: false } })).anonymousMarker, (await userSa.sessionProbe({ userInfo: { uid: 'probe-uid' } })).anonymousMarker])
const a18eProbe = await userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } })
check('A18e', '探针收尾：`uidKind` / `mode` **死位皆已删**（无该键）', [false, false], ['uidKind' in a18eProbe, 'mode' in a18eProbe])
const a18fProbe = await userSa.sessionProbe({ userInfo: { uid: 'probe-secret-uid' } })
check('A18f', '诊断探针：**布尔-only** —— 键形状冻结 ＋ 回包不含任何 uid 值', true, !JSON.stringify(a18fProbe).includes('probe-secret-uid') && shapeOf(a18fProbe) === 'anonymousMarker,authApiPresent,callerUidViaAuthApi,candidates,eventIdentityKeyNames,eventUidMatchesAuthApi,ok,uidPresent' && shapeOf(a18fProbe.candidates) === 'auth,context,user,userInfo')
const a18gBase = JSON.stringify(await userSa.sessionProbe())
check('A18g', '诊断探针：context 缺省 / null / 非对象 ⇒ **同一全零回显**（不炸）', [true, true], [a18gBase === JSON.stringify(await userSa.sessionProbe(null)), a18gBase === JSON.stringify(await userSa.sessionProbe('非对象'))])

/* ---- **V6-a 追加**：node-sdk auth API 通道三读数（契约 ⑨）——超时护栏 / 注入缝 / 零值回显 / 零泄漏 / 判权隔离 ---- */
check('A19', '通道超时护栏常量 ＝ 3000ms（两副本同值）', [3000, 3000], [userSa.AUTH_API_PROBE_TIMEOUT_MS, adminSa.AUTH_API_PROBE_TIMEOUT_MS])
check('A20', '通道注入缝完整 ＋ `lib/ops.js` 加载后已注入（set / injected / clear 皆为函数）', ['function', 'function', 'function', true], [typeof userSa.setAuthApiChannelProvider, typeof userSa.authApiChannelInjected, typeof userSa.clearAuthApiChannelProvider, userSa.authApiChannelInjected()])
setAuthChannel(null)
check('A21', '通道缺席（未注入）⇒ 三读数零值（present:false / absent / []）', AUTH3_ABSENT, authThree(await userSa.sessionProbe({ userInfo: { uid: 'probe-uid' } })))
setAuthChannel(() => ({ getAuthContext: async () => ({ uid: 'auth-api-uid', loginType: 'PASSWORD', appId: 'wx-app' }) }))
check('A22', '通道在场 ＋ 结果含非空 uid ⇒ present:true / callerUidViaAuthApi:string / 键名升序回显', { authApiPresent: true, callerUidViaAuthApi: 'string', eventIdentityKeyNames: ['appId', 'loginType', 'uid'] }, authThree(await userSa.sessionProbe()))
setAuthChannel(() => ({ getAuthContext: async () => ({ loginType: 'ANONYMOUS' }) }))
check('A23', '通道在场但结果无 uid ⇒ present:true / callerUidViaAuthApi:absent / 键名回显', { authApiPresent: true, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: ['loginType'] }, authThree(await userSa.sessionProbe()))
setAuthChannel(() => ({ getAuthContext: async () => 'not-an-object' }))
const a24String = authThree(await userSa.sessionProbe())
setAuthChannel(() => ({ getAuthContext: async () => null }))
const a24Null = authThree(await userSa.sessionProbe())
check('A24', '通道在场但结果非对象（字符串 / null）⇒ present:true / non-string / []', [AUTH3_PRESENT_NONSTRING, AUTH3_PRESENT_NONSTRING], [a24String, a24Null])
setAuthChannel(() => ({ getAuthContext: () => { throw new Error('injected-auth-api-failure') } }))
check('A25', '通道 getAuthContext 抛错 ⇒ present:true / throw / []（只报失败类型、不炸）', AUTH3_PRESENT_THROW, authThree(await userSa.sessionProbe()))
setAuthChannel(() => { throw new Error('injected-auth-channel-provider-failure') })
check('A26', '通道读取器抛错 ⇒ 三读数零值（present:false / absent / []）', AUTH3_ABSENT, authThree(await userSa.sessionProbe()))
setAuthChannel(() => ({}))
check('A27', '通道形状不合（对象无 `getAuthContext`）⇒ 三读数零值（absent）', AUTH3_ABSENT, authThree(await userSa.sessionProbe()))
setAuthChannel(() => 'not-a-channel')
check('A28', '通道读取器返回非对象 ⇒ 三读数零值（absent）', AUTH3_ABSENT, authThree(await userSa.sessionProbe()))
setAuthChannel(() => ({ getAuthContext: async () => ({ zeta: 1, alpha: 'SECRET-AUTH-VALUE', uid: 'auth-api-uid' }) }))
const a29 = await userSa.sessionProbe()
check('A29', '通道结果键名回显：升序回显 ＋ 绝不回吐任何值（**零值泄漏**）', true, !JSON.stringify(a29).includes('SECRET-AUTH-VALUE') && JSON.stringify(a29.eventIdentityKeyNames) === JSON.stringify(['alpha', 'uid', 'zeta']))
const a30Keys = {}
for (let i = 0; i < 40; i += 1) a30Keys[`k${String(i).padStart(2, '0')}`] = i
setAuthChannel(() => ({ getAuthContext: async () => a30Keys }))
check('A30', '通道结果键名回显上限 32', 32, (await userSa.sessionProbe()).eventIdentityKeyNames.length)
setAuthChannel(() => ({ getAuthContext: () => new Promise(() => {}) }))
const a31Start = Date.now()
const a31 = await userSa.sessionProbe()
const a31Elapsed = Date.now() - a31Start
check('A31', '通道 getAuthContext 永不 resolve ⇒ 3s 超时护栏落到 timeout（present:true / timeout / []）', AUTH3_PRESENT_TIMEOUT, authThree(a31))
check('A31b', '超时护栏实测耗时 ∈ [2900ms, 6000ms]', true, a31Elapsed >= 2900 && a31Elapsed <= 6000)
let authApiCalls = 0
currentSession = { uid: ADMIN_UID }
setAuthChannel(() => ({ getAuthContext: async () => { authApiCalls += 1; return { uid: 'should-not-be-read' } } }))
const a32 = await userSa.resolveSessionAuthority({ context: { userInfo: { uid: ADMIN_UID } }, readRole: async () => ({ role: 'admin' }), requiredRoles: ['admin'], env: { XIAI_SESSION_AUTHORITY: 'prefer' } })
check('A32', '注入缝在场 ⇒ 判权走注入缝、**不消费通道**（生产无注入时才走通道）；调用次数 0', [true, true, 0], [a32.ok === true, a32.obtained === true, authApiCalls])
currentSession = null

/* ---- **本单追加②**：两个预留零值键 ＋ `callerUidViaAuthApi` 封闭枚举 ＋ **★ 冒充判别** ---- */
const a33Probe = await userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } })
check('A33', '探针收尾：四个死位 `uidKind` / `loginTypeValue` / `eventUidKind` / `mode` **已删**（无该键）', [false, false, false, false], ['uidKind' in a33Probe, 'loginTypeValue' in a33Probe, 'eventUidKind' in a33Probe, 'mode' in a33Probe])
const a43Keys = Object.keys(await userSa.sessionProbe({ user: { UID: 'probe-kind-uid' } })).sort().join(',')
check('A43', '探针收尾冻结键形（恰 8 键、零死位；键集合逐字冻结）', 'anonymousMarker,authApiPresent,callerUidViaAuthApi,candidates,eventIdentityKeyNames,eventUidMatchesAuthApi,ok,uidPresent', a43Keys)
check('A34', '`callerUidViaAuthApi` 封闭枚举面（五值冻结、两副本同值）', ['absent', 'non-string', 'string', 'throw', 'timeout'], Object.values(userSa.CALLER_UID_VIA_AUTH_API).slice().sort())
check('A35', '`EVENT_UID_MATCH` 封闭枚举面（三值冻结、两副本同值）', ['match', 'mismatch', 'unknown'], Object.values(userSa.EVENT_UID_MATCH).slice().sort())
setAuthChannel(() => ({ getAuthContext: async () => ({ uid: 'auth-uid-x' }) }))
check('A36', '★ 冒充判别：事件自称 uid ＝ 通道权威 uid ⇒ match', 'match', (await userSa.sessionProbe({ userInfo: { uid: 'auth-uid-x' } })).eventUidMatchesAuthApi)
check('A37', '★ 冒充判别：事件自称 uid ≠ 通道权威 uid ⇒ mismatch（**冒充嫌疑**）', 'mismatch', (await userSa.sessionProbe({ userInfo: { uid: 'forged-uid' } })).eventUidMatchesAuthApi)
check('A38', '★ 冒充判别：事件侧无可用 uid（通道在场）⇒ unknown（零值回显，绝不据缺失判不等）', ['unknown', 'unknown'], [(await userSa.sessionProbe()).eventUidMatchesAuthApi, (await userSa.sessionProbe({ userInfo: { uid: '' } })).eventUidMatchesAuthApi])
setAuthChannel(NULL_CHANNEL_PROVIDER)
check('A39', '★ 冒充判别：通道缺席（事件侧有 uid）⇒ unknown（零值回显）', 'unknown', (await userSa.sessionProbe({ userInfo: { uid: 'auth-uid-x' } })).eventUidMatchesAuthApi)
setAuthChannel(() => ({ getAuthContext: async () => { throw new Error('injected-match-probe-failure') } }))
check('A40', '★ 冒充判别：通道抛错 ⇒ unknown（读不到权威 uid 不判冒充）', 'unknown', (await userSa.sessionProbe({ userInfo: { uid: 'auth-uid-x' } })).eventUidMatchesAuthApi)
setAuthChannel(() => ({ getAuthContext: async () => ({ uid: 'SECRET-AUTHORITY-UID', loginType: 'PASSWORD' }) }))
const a41 = await userSa.sessionProbe({ userInfo: { uid: 'SECRET-EVENT-UID' } })
check('A41', '★ 冒充判别 ＋ 通道读数**零泄漏**（事件 uid / 权威 uid / 登录类型值皆不回吐）', true, !JSON.stringify(a41).includes('SECRET-AUTHORITY-UID') && !JSON.stringify(a41).includes('SECRET-EVENT-UID') && !JSON.stringify(a41).includes('PASSWORD'))
check('A42', '★ 冒充判别 × 通道读数联动：事件 uid ≠ 权威 uid ⇒ mismatch ＋ 通道 kind=string ＋ 键名回显', { eventUidMatchesAuthApi: 'mismatch', callerUidViaAuthApi: 'string', authApiPresent: true, eventIdentityKeyNames: ['loginType', 'uid'] }, { eventUidMatchesAuthApi: a41.eventUidMatchesAuthApi, callerUidViaAuthApi: a41.callerUidViaAuthApi, authApiPresent: a41.authApiPresent, eventIdentityKeyNames: a41.eventIdentityKeyNames })
/* ---- **本单追加④（V6-a³）**：**授权身份源 ＝ auth API** ＋ **三重分支** ＋ **冒充模拟** ---- */
const RB = async (uid) => (uid === 'impl-admin' ? { role: 'admin' } : uid === 'impl-user' ? { role: 'user' } : null)
const RB_ENV = { XIAI_SESSION_AUTHORITY: 'prefer' }
setAuthChannel(NULL_CHANNEL_PROVIDER)

/* A44–A47：**三重分支**（身份经**注入缝**喂入；判权内核直调）。 */
currentSession = { uid: 'impl-admin' }
const a44 = await userSa.resolveSessionAuthority({ context: {}, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A44', '三重分支：**有行且角色足 ⇒ 认**（obtained / SESSION）', { ok: true, obtained: true, source: 'SESSION', uid: 'impl-admin', role: 'admin' }, { ok: a44.ok, obtained: a44.obtained, source: a44.source, uid: a44.uid, role: a44.role })
currentSession = { uid: 'impl-user' }
const a45 = await userSa.resolveSessionAuthority({ context: {}, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A45', '三重分支：**有行但角色不足 ⇒ 拒**（FORBIDDEN，fail-closed、不回落）', { ok: false, reason: 'FORBIDDEN' }, { ok: a45.ok, reason: a45.reason })
currentSession = { uid: 'impl-orphan' }
const a46 = await userSa.resolveSessionAuthority({ context: {}, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A46', '三重分支：**无行 ⇒ 兜底**（obtained:false / SERVER_TOKEN；**取代旧 FORBIDDEN**）', { ok: true, obtained: false, source: 'SERVER_TOKEN' }, { ok: a46.ok, obtained: a46.obtained, source: a46.source })
currentSession = { uid: 'impl-admin' }
const a47 = await userSa.resolveSessionAuthority({ context: {}, readRole: async () => { throw new Error('injected-role-read-failure') }, requiredRoles: ['admin'], env: RB_ENV })
check('A47', '三重分支：**取数错 ⇒ 兜底**（obtained:false；**取代旧 STORAGE_UNAVAILABLE**）', { ok: true, obtained: false, source: 'SERVER_TOKEN' }, { ok: a47.ok, obtained: a47.obtained, source: a47.source })

/* A48–A52：**身份源 ＝ auth API 通道**（清注入缝，只喂通道）＋ **冒充模拟**。 */
currentSession = null
userSa.clearSessionIdentityProvider()
setAuthChannel(() => ({ getAuthContext: async () => ({ uid: 'impl-admin' }) }))
const a48 = await userSa.resolveSessionAuthority({ context: {}, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A48', '★ 身份源＝auth API：清注入缝、通道给 uid ⇒ 判权走通道（SESSION）', { ok: true, obtained: true, source: 'SESSION', uid: 'impl-admin', role: 'admin' }, { ok: a48.ok, obtained: a48.obtained, source: a48.source, uid: a48.uid, role: a48.role })
let a49SawUid = ''
setAuthChannel(() => ({ getAuthContext: async () => ({ uid: 'impl-user' }) }))
const a49 = await userSa.resolveSessionAuthority({ context: { userInfo: { uid: 'impl-admin' } }, readRole: async (uid) => { a49SawUid = uid; return RB(uid) }, requiredRoles: ['admin'], env: RB_ENV })
check('A49', '★ 冒充模拟：context 自填 admin 但通道权威 uid ＝ user ⇒ 按通道判权 ⇒ FORBIDDEN', 'FORBIDDEN', a49.reason)
check('A49b', '★ 冒充模拟：readRole 收到的是**通道权威 uid**（非 context 自填 uid）', 'impl-user', a49SawUid)
setAuthChannel(() => ({ getAuthContext: async () => ({}) }))
const a50 = await userSa.resolveSessionAuthority({ context: { userInfo: { uid: 'impl-admin' } }, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A50', '通道无 uid（匿名形态）⇒ 兜底（不据 context 自称）', { ok: true, obtained: false, source: 'SERVER_TOKEN' }, { ok: a50.ok, obtained: a50.obtained, source: a50.source })
setAuthChannel(() => ({ getAuthContext: async () => { throw new Error('injected-auth-api-failure') } }))
const a51 = await userSa.resolveSessionAuthority({ context: { userInfo: { uid: 'impl-admin' } }, readRole: RB, requiredRoles: ['admin'], env: RB_ENV })
check('A51', '通道抛错（异常）⇒ 兜底', { ok: true, obtained: false, source: 'SERVER_TOKEN' }, { ok: a51.ok, obtained: a51.obtained, source: a51.source })
setAuthChannel(NULL_CHANNEL_PROVIDER)
const a52 = await userSa.resolveSessionAuthority({ context: { userInfo: { uid: 'impl-admin' } }, readRole: RB, requiredRoles: ['admin'], env: { XIAI_SESSION_AUTHORITY: 'off' } })
check('A52', '开关 off ⇒ 兜底（不查身份、不消费通道）', { ok: true, obtained: false, source: 'SERVER_TOKEN' }, { ok: a52.ok, obtained: a52.obtained, source: a52.source })
userSa.setSessionIdentityProvider(sessionProvider)
currentSession = null

setAuthChannel(NULL_CHANNEL_PROVIDER)
/* 恢复「无通道」形态（＝生产离线：`index.js` 懒解析得 null）留给 B / C 段。 */
setAuthChannel(NULL_CHANNEL_PROVIDER)

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

/* B2：**V6-a³ 取代旧「无行 ⇒ fail-closed 直接拒」** —— 无行 ⇒ **兜底回落令牌路**。此处无令牌 ⇒
   令牌路拒（结果仍 FORBIDDEN，但**路径已变**）；带令牌的对照见 B2d。 */
resetWorld()
currentSession = { uid: ORPHAN_UID }
const beforeB2 = store.writes.length
const b2 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B2', '会话无角色行 ⇒ **兜底** ⇒ 无令牌 ⇒ FORBIDDEN（**取代旧 fail-closed 直接拒**）', 'FORBIDDEN', b2.reason)
check('B2b', '拒绝形状恰 3 键 ∈ 冻结表', true, isDenial(b2))
check('B2c', '零写入', beforeB2, store.writes.length)
resetWorld()
currentSession = { uid: ORPHAN_UID }
const b2d = await adminFn.main({ action: 'verify', token: adminToken, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B2d', '无行 ＋ 有效令牌 ⇒ 兜底令牌路**放行**（identity_source:SERVER_TOKEN；证「无行 ⇒ 兜底」）', ['SERVER_TOKEN', true], [b2d.identity_source, b2d.ok === true])

/* B3：fail-closed —— 会话角色 ≠ admin ⇒ FORBIDDEN（管理员函数要求 admin） */
resetWorld()
currentSession = { uid: USER_UID }
const beforeB3 = store.writes.length
const b3 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B3', '会话角色 user 调管理员函数 ⇒ FORBIDDEN', 'FORBIDDEN', b3.reason)
check('B3b', '零写入', beforeB3, store.writes.length)

/* B4：**V6-a³ 取代旧「取数错 ⇒ STORAGE_UNAVAILABLE」** —— 角色读失败（取数错）⇒ **兜底回落令牌路**。
   两臂各取一次读数：① 无令牌 ⇒ 令牌路拒（FORBIDDEN）；② 带有效令牌 ⇒ 令牌路放行（SERVER_TOKEN）。 */
resetWorld()
currentSession = { uid: ADMIN_UID }
store.failRoleRead = true
const beforeB4 = store.writes.length
const b4 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B4', '取数错 ⇒ **兜底**（无令牌 ⇒ FORBIDDEN；**不再 STORAGE_UNAVAILABLE**）', 'FORBIDDEN', b4.reason)
check('B4b', '拒绝形状恰 3 键 ∈ 冻结表', true, isDenial(b4))
check('B4c', '零写入', beforeB4, store.writes.length)
resetWorld()
currentSession = { uid: ADMIN_UID }
store.failRoleRead = true
const b4d = await adminFn.main({ action: 'verify', token: adminToken, op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
store.failRoleRead = false
check('B4d', '取数错 ＋ 有效令牌 ⇒ 兜底令牌路放行（identity_source:SERVER_TOKEN）', ['SERVER_TOKEN', true], [b4d.identity_source, b4d.ok === true])

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
check('B9', 'sessionProbe **无令牌**可调 ⇒ context 形状诊断（空 context：根容器在场、其余全零）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, b9)
check('B9b', 'sessionProbe 零写入', beforeB9, store.writes.length)
/* B9c：`sessionProbe` **与开关解耦**（缺省 off 亦可调、回包形状不变）。 */
resetWorld()
delete process.env.XIAI_SESSION_AUTHORITY
const b9c = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('B9c', '缺省 off 下 sessionProbe 仍可调（诊断与开关解耦；形状不变）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, b9c)
process.env.XIAI_SESSION_AUTHORITY = 'prefer'
/* B9d：**注入缝不参与诊断** —— 会话在场 ⇒ 探针仍只诊断 context 形状、不消费 provider。 */
resetWorld()
currentSession = { uid: ADMIN_UID }
const b9d = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('B9d', '会话在场 ⇒ sessionProbe 仍只回 context 形状（不消费注入缝、形状不变）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, b9d)
check('B9e', 'sessionProbe 回包不含任何 uid 值（**零泄漏**）', true, !JSON.stringify(b9d).includes(ADMIN_UID))
/* B9f：context 形状被**如实诊断**（`user` 容器 ＋ `UID` 键形）且 uid 值不回吐。 */
resetWorld()
const b9f = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, { user: { UID: ADMIN_UID } })
check('B9f', 'context 带 `user.UID` ⇒ candidates.user ＋ uidPresent 如实为真（`mode` 仍零值；`uidKind` 死位已删）', { ok: true, candidates: { userInfo: false, user: true, auth: false, context: true }, uidPresent: true, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, b9f)
check('B9g', 'context 形状诊断不回吐 uid 值（**零泄漏**）', true, !JSON.stringify(b9f).includes(ADMIN_UID))

/* B10：通道经**函数回包**（`index.js` 把函数第二参 `callContext` 递入探针）。 */
resetWorld()
let b10Seen = null
let b10Calls = 0
adminSa.setAuthApiChannelProvider(() => ({
  getAuthContext: async (ctx) => {
    b10Calls += 1
    b10Seen = ctx
    return { uid: 'adm-auth-api-uid', loginType: 'PWD' }
  }
}))
const b10Ctx = { user: { UID: ADMIN_UID } }
const b10 = await adminFn.main({ action: 'verify', op: 'sessionProbe' }, b10Ctx)
check('B10', 'admin 函数 sessionProbe 经注入通道回通道读数 ＋ **★ 冒充判别**（present / kind:string / 键名升序 / 事件 ADMIN_UID ≠ 权威 uid ⇒ mismatch）', { authApiPresent: true, callerUidViaAuthApi: 'string', eventIdentityKeyNames: ['loginType', 'uid'], eventUidMatchesAuthApi: 'mismatch' }, { authApiPresent: b10.authApiPresent, callerUidViaAuthApi: b10.callerUidViaAuthApi, eventIdentityKeyNames: b10.eventIdentityKeyNames, eventUidMatchesAuthApi: b10.eventUidMatchesAuthApi })
check('B10b', '通道 getAuthContext 收到函数第二参 callContext（同对象）＋ 恰调一次', [true, 1], [b10Seen === b10Ctx, b10Calls])
check('B10c', 'sessionProbe 回包仍不含任何 uid 值（**零泄漏**）', true, !JSON.stringify(b10).includes(ADMIN_UID) && !JSON.stringify(b10).includes('adm-auth-api-uid'))
check('B10d', '探针回包键形冻结（**恰 9 键**：含 callerUidViaAuthApi / eventUidMatchesAuthApi；三个死位已删）', 'anonymousMarker,authApiPresent,callerUidViaAuthApi,candidates,eventIdentityKeyNames,eventUidMatchesAuthApi,ok,uidPresent', shapeOf(b10))
/* B11：通道只进探针 —— 会话路判权（`reviewCorrection`）不消费通道。 */
resetWorld()
currentSession = { uid: ADMIN_UID }
const beforeB11 = b10Calls
const b11 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, {})
check('B11', '会话路判权（reviewCorrection）成功', true, b11.ok === true)
check('B11b', '注入缝在场 ⇒ 会话路判权不消费通道（次数不增；生产无注入时才走通道）', beforeB11, b10Calls)
/* B12：★ **冒充模拟（函数级）** —— 通道权威 uid ＝ user，但 `context` 自称 admin ⇒ 判权按通道 ⇒ 拒。 */
resetWorld()
currentSession = null
adminSa.clearSessionIdentityProvider()
adminSa.setAuthApiChannelProvider(() => ({ getAuthContext: async () => ({ uid: USER_UID }) }))
const beforeB12 = store.writes.length
const b12 = await adminFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, { userInfo: { uid: ADMIN_UID } })
adminSa.setAuthApiChannelProvider(NULL_CHANNEL_PROVIDER)
adminSa.setSessionIdentityProvider(sessionProvider)
check('B12', '★ 冒充模拟（管理员函数）：通道权威 uid ＝ user ＋ context 自称 admin ⇒ FORBIDDEN', 'FORBIDDEN', b12.reason)
check('B12b', '冒充拒 ＋ 零写入', [true, beforeB12], [isDenial(b12), store.writes.length])
/* 恢复「无通道」离线形态。 */
adminSa.setAuthApiChannelProvider(NULL_CHANNEL_PROVIDER)

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

/* C1n（本单新增，person-model §4.2）：**作者引用型负例** —— 会话路提交引用**不存在**的印人
   ⇒ `INVALID_VALUE` ＋ **零写入**（正例 ＝ C1 引用既有印人 ⇒ 成功）。 */
resetWorld()
currentSession = { uid: USER_UID }
{
  const beforeC1n = store.writes.length
  const c1n = await userFn.main({ action: 'verify', op: 'submitCorrection', payload: { ...VALID_SUBMIT, value: 'PR999999999' } }, {})
  check('C1n', '**作者引用型负例**：引用不存在的印人 ⇒ INVALID_VALUE', 'INVALID_VALUE', c1n.reason)
  check('C1n2', '作者引用型负例 ⇒ 零写入', beforeC1n, store.writes.length)
}

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

/* C5：**V6-a³ 取代旧「默认 context 读法」** —— 清注入缝后，判权身份源改走 **auth API 通道**（此处
   通道为 null ⇒ 拿不到可用身份）；喂 `context.userInfo.uid`（**可伪造自称**）**不再**作判权源 ⇒
   **兜底** ⇒ 无令牌 ⇒ 令牌路拒。**冒充模拟（身份级）**：context 自填身份不产生任何授权。 */
resetWorld()
userSa.clearSessionIdentityProvider()
const c5 = await userFn.main({ action: 'verify', op: 'submitCorrection', payload: VALID_SUBMIT }, { userInfo: { uid: USER_UID } })
check('C5', '★ 冒充模拟：`context.userInfo.uid`（可伪造自称）**不再**作判权源 ⇒ 兜底 ⇒ 无令牌 ⇒ FORBIDDEN', 'FORBIDDEN', c5.reason)
check('C5b', '冒充拒形状恰 3 键 ∈ 冻结表 ＋ 零写入', [true, 0], [isDenial(c5), store.writes.length])
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
check('C7', '用户函数 sessionProbe **无令牌**可调 ⇒ context 形状诊断（空 context）', { ok: true, candidates: { userInfo: false, user: false, auth: false, context: true }, uidPresent: false, anonymousMarker: false, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, c7)
check('C7b', 'sessionProbe 零写入', beforeC7, store.writes.length)
/* C7c：context.userInfo 携带 uid ＋ 匿名标记 ⇒ 探针如实报告形状（布尔-only、零值回显、不回吐 uid）。 */
resetWorld()
const c7c = await userFn.main({ action: 'verify', op: 'sessionProbe' }, { userInfo: { uid: USER_UID, isAnonymous: true } })
check('C7c', 'context.userInfo 在场 ⇒ candidates.userInfo ＋ uidPresent ＋ anonymousMarker 如实为真', { ok: true, candidates: { userInfo: true, user: false, auth: false, context: true }, uidPresent: true, anonymousMarker: true, authApiPresent: false, callerUidViaAuthApi: 'absent', eventIdentityKeyNames: [], eventUidMatchesAuthApi: 'unknown' }, c7c)
check('C7d', 'sessionProbe 回包不含任何 uid 值（**零泄漏**）', true, !JSON.stringify(c7c).includes(USER_UID))

/* C8：通道经用户函数回包（`index.js` 递入 `callContext`）。 */
resetWorld()
let c8Calls = 0
userSa.setAuthApiChannelProvider(() => ({
  getAuthContext: async () => {
    c8Calls += 1
    return { uid: 'usr-auth-api-uid', type: 'WECHAT' }
  }
}))
const c8 = await userFn.main({ action: 'verify', op: 'sessionProbe' }, {})
check('C8', 'user 函数 sessionProbe 经注入通道回通道读数（present / kind:string / 键名升序 / 事件侧无 uid ⇒ unknown）', { authApiPresent: true, callerUidViaAuthApi: 'string', eventIdentityKeyNames: ['type', 'uid'], eventUidMatchesAuthApi: 'unknown' }, { authApiPresent: c8.authApiPresent, callerUidViaAuthApi: c8.callerUidViaAuthApi, eventIdentityKeyNames: c8.eventIdentityKeyNames, eventUidMatchesAuthApi: c8.eventUidMatchesAuthApi })
check('C8b', 'user 函数 sessionProbe 回包含新诊断位（死位 `loginTypeValue` / `eventUidKind` 已删 / 封闭枚举 / ★ 冒充判别）', { deadAbsent: [false, false], callerUidViaAuthApi: 'string', eventUidMatchesAuthApi: 'unknown' }, { deadAbsent: ['loginTypeValue' in c8, 'eventUidKind' in c8], callerUidViaAuthApi: c8.callerUidViaAuthApi, eventUidMatchesAuthApi: c8.eventUidMatchesAuthApi })
/* C9：通道只进探针 —— 用户会话路提交不消费通道。 */
resetWorld()
currentSession = { uid: USER_UID }
const beforeC9 = c8Calls
const c9 = await userFn.main({ action: 'verify', op: 'submitCorrection', payload: VALID_SUBMIT }, {})
check('C9', '用户会话路提交成功', true, c9.ok === true)
check('C9b', '注入缝在场 ⇒ 用户写路不消费通道（次数不增；生产无注入时才走通道）', beforeC9, c8Calls)
/* C10：★ **冒充模拟（用户函数）** —— 通道权威 uid ＝ user，`context` 自称 admin（想提权调 admin op）⇒ 仍拒。 */
resetWorld()
currentSession = null
userSa.clearSessionIdentityProvider()
userSa.setAuthApiChannelProvider(() => ({ getAuthContext: async () => ({ uid: USER_UID }) }))
const beforeC10 = store.writes.length
const c10 = await userFn.main({ action: 'verify', op: 'reviewCorrection', payload: { correction_id: 'cr-pend', decision: 'ACCEPTED' } }, { userInfo: { uid: ADMIN_UID } })
userSa.setAuthApiChannelProvider(NULL_CHANNEL_PROVIDER)
userSa.setSessionIdentityProvider(sessionProvider)
check('C10', '★ 冒充模拟（用户函数）：通道权威 uid ＝ user ＋ context 自称 admin ⇒ admin op 仍 FORBIDDEN', 'FORBIDDEN', c10.reason)
check('C10b', '冒充拒 ＋ 零写入', [true, beforeC10], [isDenial(c10), store.writes.length])
/* 恢复「无通道」离线形态。 */
userSa.setAuthApiChannelProvider(NULL_CHANNEL_PROVIDER)

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
  const opsSource = sources.get(path.join(ROOT, dir, 'lib/ops.js')) || ''
  const indexSource = sources.get(path.join(ROOT, dir, 'index.js')) || ''
  check(`D4${tag}`, `${dir}/lib/sessionAuthority.js：零 SDK 字面值（\`@cloudbase/node-sdk\` 只出现在 lib/ops.js）`, false, /@cloudbase\/node-sdk/.test(saSource))
  check(`D5${tag}`, `${dir}/lib/ops.js：注入 auth API 通道读取器（\`setAuthApiChannelProvider\` 调用点）`, true, /setAuthApiChannelProvider\s*\(/.test(opsSource))
  check(`D6${tag}`, `${dir}/index.js：零 SDK 字面值（通道读取器已迁回 lib/ops.js；恢复 C3 / C6 / A15）`, false, /@cloudbase\/node-sdk/.test(indexSource))
}

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures } }))
process.exit(failures === 0 ? 0 : 1)
