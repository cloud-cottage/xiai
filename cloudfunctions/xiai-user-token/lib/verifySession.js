'use strict'
/**
 * 玺爱 · **只读会话验签面（`action:'verifySession'`）**（跨仓契约：斐萃影子库服务端代验）
 * ============================================================================
 * 用途：斐萃影子库（`feicui-shadow`）**不持有** xiai 用户令牌密钥（见其
 * `lib/session.js` 文件头「决策 (b) 服务端代验」三条理由）⇒ 由本仓**代验**并回吐**已验签**的
 * `uid` / `role`。它只判「这枚令牌是否成立、属于谁、什么角色」，**不落盘、不签发、不续期**。
 *
 * 契约（逐字冻结；调用面 ＝ 本函数网关 URL，`POST`、`Content-Type: application/json`）：
 *   · 请求 ⇒ `{ action: 'verifySession', token: '<xiai 用户会话令牌>' }`
 *   · 成功 ⇒ `{ ok: true, uid: 'u-<16 hex>', role: 'user' | 'admin' }`（**恰 3 键**）
 *   · 失败 ⇒ `{ ok: false, reason, message }`（**恰 3 键**；`reason` ∈ `TOKEN_INVALID` /
 *     `TOKEN_EXPIRED` —— 两字面值只在此处一处登记，见 `REASONS`）
 *
 * 硬口径（逐条）：
 *   ① **只读**：零落盘、**不签发新令牌**、**不走 `verify` 的滑动续期**（本文件零 `issueToken`
 *      引用 ⇒ 不是「续期代理」；自检以 `issueToken` 计数 0 ＋ 存储读写计数 0 机械断言）。
 *   ② **`uid` 由服务端派生**：取自**已验签**的 `sub`（手机号）⇒ `config.uidOf(phone)`
 *      （`u-` ＋ sha256 前 16 位）。**不回手机号、不回任何令牌片段、不回 `jti` / `sub`**。
 *   ③ **判别码只进日志**：无效 / 篡改 / 密钥不符 / `ver` 不符 ⇒ `TOKEN_INVALID`；
 *      `exp` 过期 ⇒ `TOKEN_EXPIRED`（两字面值**只此一处登记**，与跨仓契约逐字一致）。
 *   ④ **内部不可用不伪装成令牌无效**：缺密钥 / 时钟异常 ⇒ `STORAGE_UNAVAILABLE`
 *      （工程 R-WF2 同口径；把配置故障谎报成「令牌无效」会把用户无故赶下线）。
 *   ⑤ **幂等无副作用**：同一令牌连续调用 ⇒ 同一 `uid`（纯函数，无状态）。
 *   ⑥ **零 SDK / 零 fs / 零网络**（`index.js` 保持零 SDK 字面）；密钥只从环境变量读，
 *      **不新增任何共享密钥面**（只读既有 `ENV_NAMES.SECRET` / `VERSION` / `LEEWAY_SECONDS`）。
 */

const {
  ENV_NAMES,
  REASONS: CONFIG_REASONS,
  DEFAULT_VERSION,
  DEFAULT_LEEWAY_SECONDS,
  UID_PREFIX,
  UID_HEX_LENGTH,
  normalizePhone,
  isPhoneLike,
  uidOf
} = require('./config.js')
const { TOKEN_DETAILS, verifyToken } = require('./token.js')

/** 目标 action（**唯一引用点**；与斐萃 `lib/session.js::VERIFY_ACTION` 逐字同值）。 */
const VERIFY_SESSION_ACTION = 'verifySession'

/** 对外 `reason` 值域（**恰两句**；跨仓契约冻结，不得增补同义值）。 */
const REASONS = Object.freeze({
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED'
})

/** 角色值域（封闭二值；`user` / `admin` —— 令牌必须**已验签**，见 ②）。 */
const ROLES = Object.freeze(['user', 'admin'])

/** 成功回包键面（**恰 3 键**；自检据此判「多一键即红」）。 */
const SUCCESS_KEYS = Object.freeze(['ok', 'uid', 'role'])

/** 失败回包键面（**恰 3 键**；与工程既有拒绝形态同形）。 */
const DENIAL_KEYS = Object.freeze(['ok', 'reason', 'message'])

/** uid 形态（由 `config.js` 的两个常量拼出 ⇒ **不重复登记字面值**）。 */
const UID_PATTERN = new RegExp(`^${UID_PREFIX}[0-9a-f]{${UID_HEX_LENGTH}}$`)

/** 对外文案（**繁體、如实、零身份信息**；无效 / 过期各一条，不泄漏内部判别码）。 */
const MESSAGES = Object.freeze({
  TOKEN_INVALID: '會話令牌無效（無法驗證簽章或形態）；本次零寫入、未續期。',
  TOKEN_EXPIRED: '會話令牌已過期，請重新登錄；本次零寫入、未續期。',
  CONFIG_MISSING: '用戶令牌會話驗證服務未配置；本次零寫入、未續期。',
  CLOCK_UNAVAILABLE: '用戶令牌會話驗證服務時鐘不可用；本次零寫入、未續期。'
})

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function readInteger(env, name, fallback) {
  const raw = text(env ? env[name] : '')
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/**
 * **本面专用的窄配置读**（只读验签需要的三项：密钥 / 版本 / 时钟余量）。
 *
 * 为什么不用 `readConfig()`：那里把**短信验证码**也算进 `ready` 判定（签发面的前置），
 * 而只读验签**不需要**它 —— 让一个只读面因签发面的配置缺项而整体不可用，属于错误连坐。
 * **不新增密钥面**：环境变量名逐字沿用 `ENV_NAMES`（同一把密钥、同一处登记）。
 * @param {object} [env] 环境（缺省 `process.env`；自检注入）
 * @returns {{ready:true, secret:string, version:string, leewaySeconds:number}
 *          |{ready:false, reason:string, message:string}}
 */
function readVerifyConfig(env) {
  const source = env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const secret = text(source[ENV_NAMES.SECRET])
  if (secret === '') {
    /* 内部不可用 ⇒ `STORAGE_UNAVAILABLE`（**绝不**伪装成 `TOKEN_INVALID`，见 ④）。 */
    return { ready: false, reason: CONFIG_REASONS.STORAGE_UNAVAILABLE, message: MESSAGES.CONFIG_MISSING }
  }
  return {
    ready: true,
    secret,
    version: text(source[ENV_NAMES.VERSION]) || DEFAULT_VERSION,
    leewaySeconds: readInteger(source, ENV_NAMES.LEEWAY_SECONDS, DEFAULT_LEEWAY_SECONDS)
  }
}

/**
 * 内部判别码 ⇒ 对外 `reason`（**封闭映射**）：`EXPIRED` ⇒ 过期；其余令牌面判别码 ⇒ 无效；
 * 配置 / 时钟类 ⇒ `STORAGE_UNAVAILABLE`（内部不可用，不冒充令牌判定）。
 * @param {string} detail `lib/token.js::TOKEN_DETAILS` 或其同族字面值
 * @returns {string} 对外 reason
 */
function reasonOfDetail(detail) {
  if (detail === TOKEN_DETAILS.EXPIRED) return REASONS.TOKEN_EXPIRED
  if (detail === 'SECRET_MISSING') return CONFIG_REASONS.STORAGE_UNAVAILABLE
  if (detail === 'CLOCK_UNAVAILABLE') return CONFIG_REASONS.STORAGE_UNAVAILABLE
  return REASONS.TOKEN_INVALID
}

/** 失败回包（恰 3 键；`detail` 是**内部判别码**，只进日志、绝不进回包 —— 由调用方剥离）。 */
function denialOf(detail) {
  const reason = reasonOfDetail(detail)
  const message = reason === REASONS.TOKEN_EXPIRED
    ? MESSAGES.TOKEN_EXPIRED
    : reason === CONFIG_REASONS.STORAGE_UNAVAILABLE
      ? (detail === 'CLOCK_UNAVAILABLE' ? MESSAGES.CLOCK_UNAVAILABLE : MESSAGES.CONFIG_MISSING)
      : MESSAGES.TOKEN_INVALID
  return { ok: false, reason, message, detail: text(detail) || 'UNKNOWN' }
}

/**
 * **只读验签**（纯函数、无 I/O、无状态）。
 *
 * 判定序（**验签先于一切声明解析**）：① 密钥在场 → ② 令牌形态 / 签名 / 格式版本 / `ver`
 * → ③ 有效期（`exp` 过期 ⇒ `TOKEN_EXPIRED`）→ ④ `sub` 须是合法手机号且 `uid`
 * **服务端派生** → ⑤ `role` ∈ 封闭二值。任一环失败 ⇒ 恰 `{ok:false, reason, message}`
 * ＋**内部** `detail`（调用方只把前 3 键回客户端）。
 *
 * **零副作用**：不签发、不续期、不落盘、不读库（同一令牌任意次调用 ⇒ 同一 `uid`）。
 * @param {{token:string, secret:string, nowSeconds:number, version?:string, leewaySeconds?:number}} input
 * @returns {{ok:true, uid:string, role:string}
 *          |{ok:false, reason:string, message:string, detail:string}}
 */
function verifySessionClaims(input) {
  const source = input && typeof input === 'object' ? input : {}
  const secret = text(source.secret)
  if (secret === '') return denialOf('SECRET_MISSING')
  const rawToken = source.token
  /* **类型门**（显式）：非字符串（number / object / array / null / undefined）一律 `TOKEN_INVALID`
     —— 不把奇怪输入喂进解码器，也不给出「形态差异」的旁路。 */
  if (typeof rawToken !== 'string' || rawToken.trim() === '') return denialOf(TOKEN_DETAILS.MISSING)
  const checked = verifyToken({
    token: rawToken,
    secret,
    nowSeconds: source.nowSeconds,
    leewaySeconds: source.leewaySeconds,
    version: source.version
  })
  if (!checked.ok) return denialOf(checked.detail)
  const claims = checked.claims && typeof checked.claims === 'object' ? checked.claims : {}
  /* ④ `uid` **只**由已验签的 `sub` 派生（前端自称的一律不采信；本面也不读载荷里的 `uid`）。 */
  const phone = normalizePhone(claims.sub)
  if (!isPhoneLike(phone)) return denialOf(TOKEN_DETAILS.SUBJECT_MISSING)
  const uid = uidOf(phone)
  if (!UID_PATTERN.test(uid)) return denialOf(TOKEN_DETAILS.SUBJECT_MISSING)
  const role = text(claims.role).toLowerCase()
  if (ROLES.indexOf(role) === -1) return denialOf('ROLE_NOT_ALLOWED')
  return { ok: true, uid, role }
}

/**
 * 是否本面 action（`action` 去空白后逐字等于 `verifySession`）。
 * **位置纪律**：调用方须在**任何** authority / op 值域 / `payload` 判定**之前**短路
 * （与只读诊断 op `sessionProbe` 同位置）—— 本面**不要求 `payload`、不要求 `op`**，
 * 也不查 `xiai_roles`、不看平台会话。
 * @param {string} action 事件顶层 `action`
 * @returns {boolean}
 */
function isVerifySessionAction(action) {
  return text(action) === VERIFY_SESSION_ACTION
}

module.exports = {
  VERIFY_SESSION_ACTION,
  REASONS,
  ROLES,
  SUCCESS_KEYS,
  DENIAL_KEYS,
  UID_PATTERN,
  MESSAGES,
  readVerifyConfig,
  reasonOfDetail,
  verifySessionClaims,
  isVerifySessionAction
}
