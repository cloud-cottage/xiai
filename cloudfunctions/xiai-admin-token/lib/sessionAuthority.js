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
 *   ③ **读失败 ≠ 越权**：`readRole` 抛错（网络 / 内部）⇒ `STORAGE_UNAVAILABLE`
 *      （**不伪装 `FORBIDDEN`**，与工程 R-WF2 同口径）。
 *   ④ **认不出即「没有会话」**：匿名会话 / 空 uid ⇒ `present:false`（回落），
 *      不把匿名身份当成可判权身份。
 *   ⑤ **本文件零 SDK / 零句柄 / 零 fs**：角色行的读由调用方注入（`lib/ops.js` 的
 *      `readRoleRow`）⇒ 集合 / 数据库句柄调用仍只出现在 `lib/ops.js`（静态判据不变）。
 *   ⑥ **开关（惰性缺省 off）**：**仅当**环境变量 `XIAI_SESSION_AUTHORITY` **显式置为**
 *      `prefer`（大小写不敏感）时本路才启用（会话优先）；**缺省 / 其它值 / `off`** ⇒
 *      本路整体停用（纯令牌路）——**缺省即安全**，启用须显式。
 *   ⑦ **只读诊断 op**：`sessionProbe`（**无令牌可调**、**context 形状诊断**——**布尔-only ＋
 *      零值回显**：候选容器存在性 / uidPresent / uidKind / anonymousMarker / mode、
 *      **零库读零写入**；由调用方在**鉴权之前**短路，见 `isSessionProbe` / `sessionProbe`）。
 *   ⑧ **角色行形状对账**：`role` 单值 / `roles` 数组**都认**、**大小写不敏感**
 *      （`roleFromRow`）。
 *
 * 注入缝（离线自检 / 宿主用）：`setSessionIdentityProvider(fn)`。
 *   形状：`(context) => {uid, isAnonymous} | null`。
 *   生产不注入 ⇒ 走「从函数 context 取平台身份」的默认读法。
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

/** 取「可用会话身份」：优先注入缝，其次平台 context 默认读法（注入抛错 ⇒ 视为无会话）。 */
function sessionIdentityFromContext(context) {
  let raw = null
  if (sessionIdentityProvider) {
    try {
      raw = sessionIdentityProvider(context)
    } catch {
      raw = null
    }
  } else {
    raw = platformIdentityFromContext(context)
  }
  return normalizeSessionIdentity(raw)
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
 * 判权（**fail-closed**）。见文件头硬口径 ①②③④。
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
  const session = sessionIdentityFromContext(input && input.context)
  if (!session.present) {
    return { ok: true, obtained: false, source: IDENTITY_SOURCES.SERVER_TOKEN, mode }
  }
  const required = Array.isArray(input && input.requiredRoles) ? input.requiredRoles : KNOWN_ROLES
  const readRole = input && input.readRole
  let row = null
  try {
    row = typeof readRole === 'function' ? await readRole(session.uid) : null
  } catch {
    return deny(REASONS.STORAGE_UNAVAILABLE, '平台會話判權的權威存儲不可用；本次零寫入。')
  }
  const role = roleFromRow(row)
  if (!role || required.indexOf(role) === -1) {
    return deny(REASONS.FORBIDDEN, '平台會話身份未獲授權執行此操作；本次零寫入。')
  }
  return { ok: true, obtained: true, source: IDENTITY_SOURCES.SESSION, uid: session.uid, role, mode }
}

/**
 * 只读诊断 op **`sessionProbe`**（**V6-a 加固修订**：全零信封 → **context 形状诊断**）：
 * **无令牌即可调**，对调用方递入的函数第二参 `context` 只做**形状**诊断、**布尔-only ＋ 零值回显**——
 *   · `candidates`：候选容器存在性（`userInfo` / `user` / `auth` / 根 `context`，与
 *     `platformIdentityFromContext` 的候选序同源）——**如实布尔**；
 *   · `uidPresent`：是否**有候选容器**携带 uid（`uid` / `UID` 键形都认，与既有读法同源）——**如实布尔**；
 *   · `anonymousMarker`：**承载 uid 的那个候选容器**上是否存在匿名标记（`isAnonymous` / `anonymous`
 *     键**在场即真**、不看取值；无 uid ⇒ 恒 `false`）——**如实布尔**；
 *   · `uidKind` / `mode`：**恒回零值空串**（真实 uid 键形 / 真实开关态**一律不回吐**——零值回显，
 *     键形状为后续诊断预留）。
 * **绝不**回吐真实 uid / 角色 / 令牌 / 开关态 / 任何身份**值**；**零库读、零写入、不碰注入缝**
 * （不查 `xiai_roles`、不调 `sessionIdentityProvider`、不产生任何写）。
 * `context` 缺省 / 非对象 ⇒ **全零回显**（全 false ＋ 空串，不炸）。外层 `ok` 恒 `true`
 * 仅表示**探针本身应答成功**（**不是**「恰 3 键」的失败形态，两者不可混淆）。
 * @param {object} [context] 函数第二参（CloudBase 平台注入的调用者上下文）。
 * @returns {{ok: boolean, candidates: {userInfo: boolean, user: boolean, auth: boolean, context: boolean},
 *   uidPresent: boolean, uidKind: string, anonymousMarker: boolean, mode: string}}
 */
function sessionProbe(context) {
  const root = context && typeof context === 'object' ? context : null
  const exists = (value) => !!(value && typeof value === 'object')
  const holder = platformIdentityFromContext(root)
  return {
    ok: true,
    candidates: {
      userInfo: exists(root && root.userInfo),
      user: exists(root && root.user),
      auth: exists(root && root.auth),
      context: root !== null
    },
    uidPresent: holder !== null,
    uidKind: '',
    anonymousMarker: !!holder && (holder.isAnonymous !== undefined || holder.anonymous !== undefined),
    mode: ''
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
