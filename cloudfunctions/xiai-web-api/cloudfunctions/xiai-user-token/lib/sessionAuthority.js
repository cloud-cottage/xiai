'use strict'
/**
 * 玺爱 · 调用者**平台会话身份** ⇒ 角色判权（V6-a；**additive ＋ 零停机**）
 * ============================================================================
 * 目的（V6 方向）：把写面（两个云函数）的授权判据从「自研 HMAC 令牌」**逐步**迁到
 * **CloudBase 平台注入的调用者身份** —— 调用者先用平台原生身份（用户名＝手机号 ＋
 * 过渡密码）登录，写函数从**函数第二参 `context`** 取该会话的 uid，再查 `xiai_roles`
 * 判定角色。旧令牌路**保留不删**：拿不到会话时**回落**它。
 *
 * 硬口径（逐条）：
 *   ① **additive / 零停机**：本模块只**新增**一条判权路。会话不在场（旧客户端 /
 *      未登录 / 匿名）⇒ 返回 `{ok:true, obtained:false}` ⇒ 调用方**逐字沿用**既有
 *      令牌路（判据、落盘、回包全不变）。既有自检脚本（未注入会话）逐条不受影响。
 *   ② **fail-closed**：会话**在场**却查不到角色行 / 角色不合要求 ⇒ **结构化拒绝 ＋
 *      零写入**，**绝不**回落令牌路（回落只发生在「拿不到会话」时，不发生在
 *      「会话被判负」时）。
 *      【**V6-a³ 取代注**（2026-10-09 上层裁定）】本条**一半被取代**：「**无行** ⇒ 拒绝」
 *      改为「**无行 ⇒ 兜底回落令牌路**」；「**角色不合要求** ⇒ 拒绝」**保留**。见 ⑪。
 *   ③ **读失败 ≠ 越权**：`readRole` 抛错（网络 / 内部）⇒ `STORAGE_UNAVAILABLE`
 *      （**不伪装 `FORBIDDEN`**，与工程 R-WF2 同口径）。
 *      【**V6-a³ 取代注**】取数错 ⇒ **兜底回落令牌路**（不再 `STORAGE_UNAVAILABLE`
 *      拒绝）；「读失败绝不伪装 `FORBIDDEN`」的原则**不变**。见 ⑪。
 *   ④ **认不出即「没有会话」**：匿名会话 / 空 uid ⇒ `present:false`（回落），
 *      不把匿名身份当成可判权身份。
 *   ⑤ **本文件零 SDK / 零句柄 / 零 fs**：角色行的读由调用方注入（`lib/ops.js` 的
 *      `readRoleRow`）⇒ 集合 / 数据库句柄调用仍只出现在 `lib/ops.js`（静态判据不变）。
 *   ⑥ **开关（惰性缺省 off）**：**仅当**环境变量 `XIAI_SESSION_AUTHORITY` **显式置为**
 *      `prefer`（大小写不敏感）时本路才启用（会话优先）；**缺省 / 其它值 / `off`** ⇒
 *      本路整体停用（纯令牌路）——**缺省即安全**，启用须显式。
 *   ⑦ **只读诊断 op**：`sessionProbe`（**无令牌可调**、**context 形状诊断**——**类型-only ＋
 *      零值回显**：候选容器存在性 / uidPresent / anonymousMarker / mode、node-sdk auth API 通道读数
 *      （见 ⑨）、**冒充判别**（见 ⑩）、**零库读零写入**；由调用方在**鉴权之前**短路，
 *      见 `isSessionProbe` / `sessionProbe`）。
 *      【**V6-a³ 收尾**】恒零值死位 `mode` **已删**（键不存在，非「回零值」）⇒ 探针回包
 *      由 9 键**收尾为恰 8 键**（见 ⑪④）。
 *   ⑧ **角色行形状对账**：`role` 单值 / `roles` 数组**都认**、**大小写不敏感**
 *      （`roleFromRow`）。
 *   ⑨ **node-sdk auth API 通道探测（V6-a 追加；additive）**：`sessionProbe` 追加三读数——
 *      `authApiPresent`（通道对象在场且带 `getAuthContext`）/ `callerUidViaAuthApi`
 *      （通道 `getAuthContext(context)` 侧调用者 uid 的**封闭枚举**——**只报类型不报值**：
 *      `'string'` / `'non-string'` / `'absent'` / `'throw'` / `'timeout'`，见
 *      `CALLER_UID_VIA_AUTH_API`；**带 3s 超时护栏** `AUTH_API_PROBE_TIMEOUT_MS`）/
 *      `eventIdentityKeyNames`（通道身份结果的**键名**回显——排序、**只回键名、绝不回吐任何值**）。
 *      **零值回显**：通道缺席 / 形状不合 / 无 uid ⇒ `present:false` ＋ `'absent'` ＋ `[]`；抛错 ⇒
 *      `'throw'`、超时 ⇒ `'timeout'`（皆只报失败**类型**）。通道**只读**（`getAuthContext` 只解析
 *      调用方 context 形状与环境注入，零网络、零写入）、**只进探针、绝不参与判权路径**（判权仍走
 *      ①—⑥ 与 `setSessionIdentityProvider`）。
 *   ⑩ **冒充判别（V6-a 追加；additive）**：`sessionProbe` 回吐 `eventUidMatchesAuthApi`——
 *      **事件自称 uid**（函数第二参 `context` 经 `platformIdentityFromContext` 取到的候选容器 uid）
 *      与**通道权威 uid** 的**关系**，**封闭枚举**（**只报关系不报值**，见 `EVENT_UID_MATCH`）：
 *      `'match'`（两侧皆有非空 uid 且逐字相等）/ `'mismatch'`（★ 两侧皆有非空 uid 却不等 ⇒
 *      **冒充嫌疑**）/ `'unknown'`（任一侧缺可用 uid / 通道非 `'string'` ⇒ **零值回显**，判不出）。
 *   ⑪ **V6-a³ 上层裁定（2026-10-09；取代 ②③ 的无行 / 读错口径）**：
 *      ① **授权身份源改为 auth API** —— 裁决调用者身份时**优先由调用方不可伪造的 node-sdk
 *         auth API 通道**（`getAuthContext`，走请求头派生）取 uid；**不得**据函数第二参
 *         `context` / `event` 里调用方自填的 uid 判权（那两条**只是可伪造的自称**，见技能
 *         「调用者身份的通道」规则一）。注入缝 `setSessionIdentityProvider` 仍**只**供离线
 *         自检 / 宿主用（生产不注入 ⇒ 走 auth API）。通道缺席 / 抛错 / 超时 / 无 uid / 匿名
 *         ⇒ 视为「拿不到可用身份」⇒ 兜底。
 *      ② **判权三重分支（冻结）**：**有行且角色足 ⇒ 认**（`source:'SESSION'`）／
 *         **有行但角色不足 ⇒ 拒**（`FORBIDDEN`，fail-closed，**绝不回落**）／
 *         **无行 · 匿名 · 取数错 ⇒ 兜底**（`{ok:true, obtained:false, source:'SERVER_TOKEN'}`
 *         ⇒ 回落既有令牌路）；「通道缺席 / 异常」并入第三支。
 *      ③ 旧令牌路**保留不删**；其判据 / 落盘 / 回包**逐字不变**（本模块仍是 additive）。
 *      ④ **探针收尾**：`sessionProbe` 删除恒零值死位 `mode` ⇒ 回包**恰 8 键**。
 *
 * 注入缝（离线自检 / 宿主用）：`setSessionIdentityProvider(fn)`。
 *   形状：`(context) => {uid, isAnonymous} | null`。
 *   生产不注入 ⇒ 走「从函数 context 取平台身份」的默认读法。
 * 注入缝（**V6-a 追加**）：`setAuthApiChannelProvider(fn)` —— node-sdk auth API 通道读取器。
 *   形状：`() => channel | null`（**同步**）；`channel` 契约 ＝ 带 `getAuthContext(context) => Promise`。
 *   生产由 `index.js` 延迟 require ＋ 懒解析注入（无 SDK ⇒ null ⇒ 探针零值回显）；本文件**零 SDK**：
 *   只调注入进来的通道对象，**不 require 任何 SDK 模块**（静态判据不变）。
 */

/** 启用开关（环境变量名；**惰性缺省 off** —— 仅显式 `prefer` 启用会话优先）。 */
const SESSION_AUTHORITY_ENV = 'XIAI_SESSION_AUTHORITY'

/** 开关取值。 */
const SESSION_MODE = Object.freeze({ PREFER: 'prefer', OFF: 'off' })

/** 角色集合名（**新增集合，一律 `xiai_` 前缀**）。 */
const ROLES_COLLECTION = 'xiai_roles'

/** 角色行 schema 版本（读面据此判形态）。 */
const ROLES_SCHEMA = 'xiai-roles-v1'

/** 角色取值面（封闭二值，与数据层 `user` / `admin` 同口径）。 */
const ROLE = Object.freeze({ USER: 'user', ADMIN: 'admin' })
const KNOWN_ROLES = Object.freeze([ROLE.USER, ROLE.ADMIN])

/** **身份来源标记（additive）**：会话路 / 既有令牌路（令牌路取值沿用既有的 `SERVER_TOKEN`）。 */
const IDENTITY_SOURCES = Object.freeze({ SESSION: 'SESSION', SERVER_TOKEN: 'SERVER_TOKEN' })

/** 对外 reason（**既有冻结表的子集**；本模块不新增字面值）。 */
const REASONS = Object.freeze({ FORBIDDEN: 'FORBIDDEN', STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE' })

/** **只读诊断 op 名**（`sessionProbe`）：**无令牌可调**、**context 形状诊断**（见 `sessionProbe`）。 */
const SESSION_PROBE_OP = 'sessionProbe'

/**
 * **node-sdk auth API 通道探测的 3s 超时护栏**（毫秒；只护探针自身的通道调用——
 * 到时 ⇒ 该读数落零值，**绝不**波及判权路径）。
 */
const AUTH_API_PROBE_TIMEOUT_MS = 3000

/** 超时护栏的到时标记（模块私有；探针据此把该读数落零值）。 */
const AUTH_API_PROBE_TIMEOUT_MARK = Symbol('AUTH_API_PROBE_TIMEOUT')

/**
 * 调用者 uid 经 node-sdk auth API 通道的**封闭枚举**（**只报类型不报值**；见文件头 ⑨）：
 *   · `string`     —— 通道在场、结果含**非空字符串** uid（**唯一**「拿到权威 uid」形态）；
 *   · `non-string` —— 通道在场、结果**非对象** / uid 键在场但值**非非空字符串**（只报类型）；
 *   · `absent`     —— 通道缺席 / 形状不合 / 结果对象**无 uid 键**（**零值回显**）；
 *   · `throw`      —— 通道 `getAuthContext` 调用**抛错**（只报失败类型）；
 *   · `timeout`    —— 3s 超时护栏到时（只报失败类型）。
 */
const CALLER_UID_VIA_AUTH_API = Object.freeze({
  STRING: 'string',
  NON_STRING: 'non-string',
  ABSENT: 'absent',
  THROW: 'throw',
  TIMEOUT: 'timeout'
})

/**
 * **冒充判别**的封闭枚举（**只报关系不报值**；见文件头 ⑩）：事件自称 uid 与通道权威 uid 的关系。
 *   · `match`    —— 两侧皆有非空 uid 且**逐字相等**；
 *   · `mismatch` —— ★ 两侧皆有非空 uid 却**不等** ⇒ **冒充嫌疑**；
 *   · `unknown`  —— 任一侧缺可用 uid / 通道非 `string` ⇒ **零值回显**（判不出，**绝不**据缺失判「不等」）。
 */
const EVENT_UID_MATCH = Object.freeze({
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown'
})

function deny(reason, message) {
  return { ok: false, reason, message }
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/* ---------------------------------------------------------------------------
   注入缝：会话身份读取（离线自检 / 宿主用；生产不注入）
   --------------------------------------------------------------------------- */

let sessionIdentityProvider = null

/** 注入会话身份读取（传非函数 ⇒ 清除）。形状：`(context) => {uid, isAnonymous} | null`。 */
function setSessionIdentityProvider(fn) {
  sessionIdentityProvider = typeof fn === 'function' ? fn : null
}

/** 是否已注入（诊断用，**不含任何凭据**）。 */
function sessionIdentityInjected() {
  return sessionIdentityProvider !== null
}

/** 清除注入（幂等）。 */
function clearSessionIdentityProvider() {
  sessionIdentityProvider = null
}

/* ---------------------------------------------------------------------------
   注入缝：node-sdk auth API 通道读取（离线自检 / 宿主用；生产由 index.js 注入）
   --------------------------------------------------------------------------- */

let authApiChannelProvider = null

/** 注入 node-sdk auth API 通道读取（传非函数 ⇒ 清除）。形状：`() => channel | null`（**同步**）。 */
function setAuthApiChannelProvider(fn) {
  authApiChannelProvider = typeof fn === 'function' ? fn : null
}

/** 是否已注入通道读取（诊断用，**不含任何凭据**）。 */
function authApiChannelInjected() {
  return authApiChannelProvider !== null
}

/** 清除注入（幂等）。 */
function clearAuthApiChannelProvider() {
  authApiChannelProvider = null
}

/** 通道契约判据：对象且带 `getAuthContext(context) => Promise` 才算「node-sdk auth API 通道在场」。 */
function isAuthApiChannel(channel) {
  return !!(channel && typeof channel === 'object' && typeof channel.getAuthContext === 'function')
}

/** 3s 超时护栏：到时 ⇒ 解析为到时标记（败者的 reject 已被 race 订阅 ⇒ 无未处理拒绝）。 */
function authApiGuarded(promise) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(AUTH_API_PROBE_TIMEOUT_MARK), AUTH_API_PROBE_TIMEOUT_MS)
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/**
 * node-sdk auth API 通道读数（**只报类型不报值**；见文件头 ⑨）。
 * 返回 `{present, callerUidKind, uid, keyNames}`——`uid` 为**仅供内部判别**的权威 uid 字符串
 * （**绝不**写进探针回包；`eventUidMatch` 用它比对冒充）；`callerUidKind` ∈
 * `CALLER_UID_VIA_AUTH_API`（**封闭枚举**）；`keyNames` 仅取结果**键名**（排序、≤32）。
 * **零值回显**：通道缺席 / 形状不合 / 无 uid ⇒ `absent`；抛错 / 超时只报失败**类型**。
 */
async function probeAuthApiChannel(context) {
  if (!authApiChannelProvider) {
    return { present: false, callerUidKind: CALLER_UID_VIA_AUTH_API.ABSENT, uid: '', keyNames: [] }
  }
  let channel = null
  try {
    channel = authApiChannelProvider()
  } catch {
    return { present: false, callerUidKind: CALLER_UID_VIA_AUTH_API.ABSENT, uid: '', keyNames: [] }
  }
  if (!isAuthApiChannel(channel)) {
    return { present: false, callerUidKind: CALLER_UID_VIA_AUTH_API.ABSENT, uid: '', keyNames: [] }
  }
  let outcome = null
  try {
    outcome = await authApiGuarded(Promise.resolve().then(() => channel.getAuthContext(context)))
  } catch {
    return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.THROW, uid: '', keyNames: [] }
  }
  if (outcome === AUTH_API_PROBE_TIMEOUT_MARK) {
    return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.TIMEOUT, uid: '', keyNames: [] }
  }
  if (!outcome || typeof outcome !== 'object') {
    return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.NON_STRING, uid: '', keyNames: [] }
  }
  const keyNames = Object.keys(outcome)
    .filter((key) => typeof key === 'string')
    .sort()
    .slice(0, 32)
  const hasUid = outcome.uid !== undefined || outcome.UID !== undefined
  if (!hasUid) {
    return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.ABSENT, uid: '', keyNames }
  }
  const uid = text(outcome.uid !== undefined ? outcome.uid : outcome.UID)
  if (uid === '') {
    return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.NON_STRING, uid: '', keyNames }
  }
  return { present: true, callerUidKind: CALLER_UID_VIA_AUTH_API.STRING, uid, keyNames }
}

/**
 * **冒充判别**（见文件头 ⑩）：**事件自称 uid** 与**通道权威 uid** 的**关系**（封闭枚举、只报关系不报值）。
 * 任一侧无可用非空 uid（含通道非 `string` 的各种失败形态）⇒ `'unknown'`（**零值回显**，判不出），
 * **绝不**据缺失判「不一致」（避免把「读不到」误报成「冒充」）。
 */
function eventUidMatch(holder, authApi) {
  if (authApi.callerUidKind !== CALLER_UID_VIA_AUTH_API.STRING) return EVENT_UID_MATCH.UNKNOWN
  const eventUid = holder ? text(holder.uid !== undefined ? holder.uid : holder.UID) : ''
  if (eventUid === '') return EVENT_UID_MATCH.UNKNOWN
  return eventUid === authApi.uid ? EVENT_UID_MATCH.MATCH : EVENT_UID_MATCH.MISMATCH
}

/** 从函数第二参 `context` 取平台注入的调用者身份（候选容器顺次取第一个含 uid 的）。 */
function platformIdentityFromContext(context) {
  if (!context || typeof context !== 'object') return null
  const candidates = [context.userInfo, context.user, context.auth, context]
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      (candidate.uid !== undefined || candidate.UID !== undefined)
    ) {
      return candidate
    }
  }
  return null
}

/**
 * 归一化会话身份为 `{present, uid, anonymous}`。
 * 匿名 / 空 uid ⇒ `present:false`（**不是失败**，调用方据此回落令牌路）。
 */
function normalizeSessionIdentity(raw) {
  if (!raw || typeof raw !== 'object') return { present: false, uid: '', anonymous: false }
  const anonymous = raw.isAnonymous === true || raw.anonymous === true
  const uid = text(raw.uid !== undefined ? raw.uid : raw.UID)
  if (anonymous || !uid) return { present: false, uid: '', anonymous }
  return { present: true, uid, anonymous: false }
}

/**
 * **V6-a³（上层裁定；见文件头 ⑪①）**：由 **node-sdk auth API 通道**取调用者身份——
 * **授权身份源**。通道由宿主注入（生产：`lib/ops.js` 延迟 require ＋ 懒解析）；本文件**零 SDK**。
 * 形状容错：结果对象含 `uid`（或 `UID`）键且为**非空字符串** ⇒ 可用；带匿名标记 ⇒ 不可用；
 * 通道缺席 / 形状不合 / 抛错 / 3s 超时 / 无 uid ⇒ `present:false`（**兜底信号**，非失败）。
 * @param {object} [context] 函数第二参（平台注入的调用方上下文）
 * @returns {Promise<{present:boolean, uid:string, anonymous:boolean}>}
 */
async function callerIdentityFromAuthApi(context) {
  if (!authApiChannelProvider) return { present: false, uid: '', anonymous: false }
  let channel = null
  try {
    channel = authApiChannelProvider()
  } catch {
    return { present: false, uid: '', anonymous: false }
  }
  if (!isAuthApiChannel(channel)) return { present: false, uid: '', anonymous: false }
  let outcome = null
  try {
    outcome = await authApiGuarded(Promise.resolve().then(() => channel.getAuthContext(context)))
  } catch {
    return { present: false, uid: '', anonymous: false }
  }
  if (outcome === AUTH_API_PROBE_TIMEOUT_MARK) return { present: false, uid: '', anonymous: false }
  if (!outcome || typeof outcome !== 'object') return { present: false, uid: '', anonymous: false }
  return normalizeSessionIdentity({
    uid: outcome.uid !== undefined ? outcome.uid : outcome.UID,
    isAnonymous: outcome.isAnonymous === true || outcome.anonymous === true
  })
}

/**
 * 取「可用判权身份」（**V6-a³**）——顺序：① 注入缝 `setSessionIdentityProvider`
 * （**离线自检 / 宿主用；生产不注入**）；② 无注入 ⇒ **auth API 通道**（`callerIdentityFromAuthApi`）。
 * 【**取代注**】旧口径在无注入时读**平台 `context`**（`platformIdentityFromContext`）——真机实测
 * `context` **不携带**调用者身份（键集为空）、`event` 里的 uid **可伪造** ⇒ 二者**一并停用**为
 * 判权源（`platformIdentityFromContext` 仅留给只读探针做 context 形状诊断）。
 */
async function sessionIdentityFromContext(context) {
  if (sessionIdentityProvider) {
    let raw = null
    try {
      raw = sessionIdentityProvider(context)
    } catch {
      raw = null
    }
    return normalizeSessionIdentity(raw)
  }
  return await callerIdentityFromAuthApi(context)
}

/** 读开关（**惰性缺省 `off`**；**仅显式 `prefer`**（大小写不敏感）⇒ `prefer`，其余一律 `off`）。 */
function readMode(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : null) || {}
  const raw = text(source[SESSION_AUTHORITY_ENV]).toLowerCase()
  return raw === SESSION_MODE.PREFER ? SESSION_MODE.PREFER : SESSION_MODE.OFF
}

/**
 * 角色行 → 冻结角色值（**形状对账**：`role` 单值 / `roles` 数组**都认**、**大小写不敏感**）。
 * 取值序：先 `role`，后 `roles[]` 逐项；**认出第一个已知角色即返回**；认不出 / 空 ⇒ 空串。
 */
function roleFromRow(row) {
  if (!row || typeof row !== 'object') return ''
  const candidates = []
  if (row.role !== undefined && row.role !== null) candidates.push(row.role)
  if (Array.isArray(row.roles)) candidates.push(...row.roles)
  for (const candidate of candidates) {
    const role = text(candidate).toLowerCase()
    if (KNOWN_ROLES.indexOf(role) !== -1) return role
  }
  return ''
}

/* ---------------------------------------------------------------------------
   身份来源标记的直接判定（**additive**；两个写面函数共用一份定义）
   ---------------------------------------------------------------------------
   · `isSessionIdentity`  —— 身份来自**平台会话**（`identity_source === 'SESSION'`）；
   · `identitySourceOf`   —— 由身份对象取落盘标记（**认不出即回落到既有令牌值**，
     既有调用方逐字不变）；
   · `identityUsable`     —— 身份可用判据：**uid 必有**，手机号在**令牌路必有**、
     会话路可缺（会话 uid 由平台注入、非前端自称）。令牌路逐字＝改前的
     `!identity.uid || !identity.phone`。 */
function isSessionIdentity(identity) {
  return !!(identity && identity.identity_source === IDENTITY_SOURCES.SESSION)
}
function identitySourceOf(identity) {
  return isSessionIdentity(identity) ? IDENTITY_SOURCES.SESSION : IDENTITY_SOURCES.SERVER_TOKEN
}
function identityUsable(identity) {
  return !!(identity && identity.uid && (identity.phone || isSessionIdentity(identity)))
}

/**
 * 判权（**V6-a³ 三重分支**；身份源 ＝ auth API 通道；见文件头 ⑪）。
 * 【**取代注**】旧口径见 ②③（无行 / 取数错 ⇒ **拒绝**）；本版改为**兜底回落令牌路**。
 * 分支（冻结）：有行且角色足 ⇒ 认（`source:'SESSION'`）／有行但角色不足 ⇒ 拒（`FORBIDDEN`，
 * 不回落）／无行 · 匿名 · 取数错 · 通道缺席 / 异常 ⇒ 兜底（`obtained:false` ⇒ 调用方走令牌路）。
 * @param {{context?:object, readRole:function(string):Promise<object|null>,
 *          requiredRoles?:string[], env?:object}} input
 * @returns {Promise<
 *   {ok:true, obtained:false, source:string, mode:string} |
 *   {ok:true, obtained:true, source:string, uid:string, role:string, mode:string} |
 *   {ok:false, reason:string, message:string}>}
 */
async function resolveSessionAuthority(input) {
  const mode = readMode(input && input.env)
  if (mode === SESSION_MODE.OFF) {
    return { ok: true, obtained: false, source: IDENTITY_SOURCES.SERVER_TOKEN, mode }
  }
  /* **V6-a³**：身份源 ＝ auth API 通道（无注入时）；见 ⑪①。 */
  const session = await sessionIdentityFromContext(input && input.context)
  /* 支三入口：**无可用身份**（无 uid / 匿名 / 通道缺席·抛错·超时）⇒ 兜底。 */
  if (!session.present) {
    return { ok: true, obtained: false, source: IDENTITY_SOURCES.SERVER_TOKEN, mode }
  }
  const required = Array.isArray(input && input.requiredRoles) ? input.requiredRoles : KNOWN_ROLES
  const readRole = input && input.readRole
  let row = null
  try {
    row = typeof readRole === 'function' ? await readRole(session.uid) : null
  } catch {
    /* 【V6-a³ 取代注】取数错 ⇒ 兜底（旧口径：`STORAGE_UNAVAILABLE` 拒绝）；见 ⑪②。 */
    return { ok: true, obtained: false, source: IDENTITY_SOURCES.SERVER_TOKEN, mode }
  }
  /* 【V6-a³ 取代注】无行 ⇒ 兜底（旧口径：`FORBIDDEN` 拒绝）；见 ⑪②。 */
  if (row === null || row === undefined) {
    return { ok: true, obtained: false, source: IDENTITY_SOURCES.SERVER_TOKEN, mode }
  }
  const role = roleFromRow(row)
  /* 有行但角色不足（认不出 / 不在要求集）⇒ 拒（fail-closed，**绝不回落**）；见 ⑪②。 */
  if (!role || required.indexOf(role) === -1) {
    return deny(REASONS.FORBIDDEN, '平台會話身份未獲授權執行此操作；本次零寫入。')
  }
  return { ok: true, obtained: true, source: IDENTITY_SOURCES.SESSION, uid: session.uid, role, mode }
}

/**
 * 只读诊断 op **`sessionProbe`**（**V6-a 加固修订**：全零信封 → **context 形状诊断**；**V6-a 追加**：
 * node-sdk auth API 通道读数（见文件头 ⑨）＋ **冒充判别**（见文件头 ⑩））：
 * **无令牌即可调**，对调用方递入的函数第二参 `context` 只做**形状 / 类型**诊断、**类型-only ＋ 零值回显**——
 *   · `candidates`：候选容器存在性（`userInfo` / `user` / `auth` / 根 `context`，与
 *     `platformIdentityFromContext` 的候选序同源）——**如实布尔**；
 *   · `uidPresent`：是否**有候选容器**携带 uid（`uid` / `UID` 键形都认，与既有读法同源）——**如实布尔**；
 *   · `anonymousMarker`：**承载 uid 的那个候选容器**上是否存在匿名标记（`isAnonymous` / `anonymous`
 *     键**在场即真**、不看取值；无 uid ⇒ 恒 `false`）——**如实布尔**；
 *   · `mode`：**恒回零值空串**（真实开关态**一律不回吐**——**零值回显**，键形状为后续诊断预留）；
 *     【**V6-a³ 收尾 取代注**】该死位**已删**（键不存在，非「回零值」）——见文件头 ⑪④；
 *   · `authApiPresent` / `callerUidViaAuthApi` / `eventIdentityKeyNames`：node-sdk auth API 通道三读数
 *     （`callerUidViaAuthApi` 为**封闭枚举** `'string'` / `'non-string'` / `'absent'` / `'throw'` / `'timeout'`
 *     ——**只报类型不报值**；`eventIdentityKeyNames` 为**键名-only**、排序、≤32；**带 3s 超时护栏**）；
 *   · `eventUidMatchesAuthApi`：**★ 冒充判别**——**事件自称 uid** 与**通道权威 uid** 的**关系**，
 *     **封闭枚举** `'match'` / `'mismatch'` / `'unknown'`（**只报关系不报值**；见文件头 ⑩）。
 * **绝不**回吐真实 uid / 角色 / 令牌 / 开关态 / 登录类型 / 任何身份**值**；**零库读、零写入**、**不碰会话
 * 身份注入缝**（不查 `xiai_roles`、不调 `sessionIdentityProvider`、不产生任何写）；通道调用本身**只读**（⑨）。
 * `context` 缺省 / 非对象 ⇒ 形状读数**全零回显**（不炸）。外层 `ok` 恒 `true`
 * 仅表示**探针本身应答成功**（**不是**「恰 3 键」的失败形态，两者不可混淆）。
 * @param {object} [context] 函数第二参（CloudBase 平台注入的调用者上下文）。
 * @returns {Promise<{ok: boolean, candidates: {userInfo: boolean, user: boolean, auth: boolean, context: boolean},
 *   uidPresent: boolean, anonymousMarker: boolean,
 *   authApiPresent: boolean, callerUidViaAuthApi: string, eventIdentityKeyNames: string[],
 *   eventUidMatchesAuthApi: string}>}
 */
async function sessionProbe(context) {
  const root = context && typeof context === 'object' ? context : null
  const exists = (value) => !!(value && typeof value === 'object')
  const holder = platformIdentityFromContext(root)
  const authApi = await probeAuthApiChannel(root)
  return {
    ok: true,
    candidates: {
      userInfo: exists(root && root.userInfo),
      user: exists(root && root.user),
      auth: exists(root && root.auth),
      context: root !== null
    },
    uidPresent: holder !== null,
    anonymousMarker: !!holder && (holder.isAnonymous !== undefined || holder.anonymous !== undefined),
    /* **V6-a 追加**：node-sdk auth API 通道读数（只报类型不报值；见文件头 ⑨）。 */
    authApiPresent: authApi.present,
    callerUidViaAuthApi: authApi.callerUidKind,
    eventIdentityKeyNames: authApi.keyNames,
    /* **V6-a 追加**：**★ 冒充判别**（只报关系不报值；见文件头 ⑩）。 */
    eventUidMatchesAuthApi: eventUidMatch(holder, authApi)
  }
}

/** 是否诊断 op（`op` 去空白后逐字等于 `sessionProbe`）。 */
function isSessionProbe(op) {
  return text(op) === SESSION_PROBE_OP
}

module.exports = {
  SESSION_AUTHORITY_ENV,
  SESSION_MODE,
  SESSION_PROBE_OP,
  AUTH_API_PROBE_TIMEOUT_MS,
  CALLER_UID_VIA_AUTH_API,
  EVENT_UID_MATCH,
  ROLES_COLLECTION,
  ROLES_SCHEMA,
  ROLE,
  KNOWN_ROLES,
  IDENTITY_SOURCES,
  REASONS,
  deny,
  setSessionIdentityProvider,
  sessionIdentityInjected,
  clearSessionIdentityProvider,
  setAuthApiChannelProvider,
  authApiChannelInjected,
  clearAuthApiChannelProvider,
  platformIdentityFromContext,
  normalizeSessionIdentity,
  sessionIdentityFromContext,
  readMode,
  roleFromRow,
  isSessionIdentity,
  identitySourceOf,
  identityUsable,
  resolveSessionAuthority,
  sessionProbe,
  isSessionProbe
}
