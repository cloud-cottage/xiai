/**
 * 玺爱 · **「連接斐萃」门面 —— 斐萃令牌签发**（本单改造：取代一次性授权码）
 * ============================================================================
 * 只在**管理员**登录时，向云函数 `xiai-user-token` 的 op `issueFeicuiToken` 申请一枚
 * **HMAC 自包含令牌**（`v1.<payload>.<sig>`）：
 *   · 身份 / 角色由**服务端**判（会话路看 `xiai_roles` 的 `role==='admin'`）；本层只做**前置**的
 *     未登录 / 非管理员短路（省一次无意义的网络往返），**绝不代替服务端判定**；
 *   · 载荷**封闭三键**：`target`（11 位手机号或既有 uid）/ `role` / `ttl_seconds`；
 *     身份类键（`uid` / `phone` / `token` / `jti` / `kid` …）**一律不传**（服务端会以 `INVALID_FIELD` 拒）；
 *   · 回包只有令牌与其元数据 —— **没有 plan、零落盘**；
 *   · 本层**不打印令牌原文**，也**不落 localStorage**（令牌只在页面上出现一次，由人复制走）。
 *
 * 纪律：页面 / 组件**只经本门面**；令牌的消费方是斐萃（本仓不存、不回放）。
 */

import { callCloudFunction } from '../data/cloudbaseFn.js'
import { isAdmin, isLoggedIn } from '../data/session.js'

/** 云函数名 / op 名（与 `cloudfunctions/xiai-user-token/lib/ops.js::ADMIN_OPS` 逐字一致）。 */
export const FEICUI_FUNCTION_NAME = 'xiai-user-token'
export const FEICUI_ISSUE_OP = 'issueFeicuiToken'

/** 转发路由前缀（斐萃侧带 `Authorization: Feicui <token>` 打的就是它）。 */
export const FEICUI_FORWARD_PREFIX = '/api/feicui/v1'

/** 转发路由的 path 白名单（与服务端 `api/feicui/v1/[...path].js::ALLOWED_PATHS` 逐字同值）。 */
export const FEICUI_RESOURCES = Object.freeze(['dynasties', 'authors', 'inscriptions'])

/** 角色面（与服务端 `feicuiToken.ROLES` 逐字同值）。 */
export const FEICUI_ROLES = Object.freeze([
  { value: 'user', label: '普通用戶' },
  { value: 'admin', label: '管理員' }
])

/** TTL 选项（天）；默认 30 天（与服务端 `DEFAULT_TTL_SECONDS` 同值）。 */
export const FEICUI_TTL_OPTIONS = Object.freeze([
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天（預設）' },
  { days: 90, label: '90 天（上限）' }
])

export const FEICUI_TTL = Object.freeze({
  defaultDays: 30,
  minSeconds: 300,
  maxSeconds: 90 * 24 * 60 * 60
})

/** 前置拦截的 reason（本层判定，零网络；**不是**服务端的授权面）。 */
export const NOT_ADMIN = 'NOT_ADMIN'
export const LOGIN_REQUIRED = 'LOGIN_REQUIRED'
export const INVALID_INPUT = 'INVALID_INPUT'

/** 前置换算：天 → 秒（越界 ⇒ `null`，由调用方报错，不静默夹取）。 */
export function ttlSecondsOf(days) {
  const value = Number(days)
  if (!Number.isFinite(value) || value <= 0) return null
  const seconds = Math.floor(value * 24 * 60 * 60)
  if (seconds < FEICUI_TTL.minSeconds || seconds > FEICUI_TTL.maxSeconds) return null
  return seconds
}

/**
 * 申请一枚斐萃令牌。
 * @param {{target:string, role?:string, ttlDays?:number}} input
 * @returns {Promise<{ok:true, token:string, uid:string, role:string, kid:string, jti:string,
 *          exp:number, expires_at:string, ttl_seconds:number}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function issueToken(input) {
  const options = input || {}
  if (!isLoggedIn.value) {
    return { ok: false, reason: LOGIN_REQUIRED, message: '請先以管理員賬號登錄（未找到登錄會話）。' }
  }
  if (!isAdmin.value) {
    return { ok: false, reason: NOT_ADMIN, message: '僅管理員可以簽發斐萃令牌。' }
  }
  const target = String(options.target === undefined || options.target === null ? '' : options.target).trim()
  if (!target) {
    return { ok: false, reason: INVALID_INPUT, message: '請填寫目標（11 位手機號或既有 uid）。' }
  }
  const role = String(options.role || 'user').trim()
  if (!FEICUI_ROLES.some((item) => item.value === role)) {
    return { ok: false, reason: INVALID_INPUT, message: '角色不在允許面之內（普通用戶 / 管理員）。' }
  }
  const ttlSeconds = ttlSecondsOf(options.ttlDays === undefined ? FEICUI_TTL.defaultDays : options.ttlDays)
  if (ttlSeconds === null) {
    return { ok: false, reason: INVALID_INPUT, message: 'TTL 超出允許區間（最短 5 分鐘、最長 90 天）。' }
  }
  const reply = await callCloudFunction(FEICUI_FUNCTION_NAME, {
    action: 'verify',
    op: FEICUI_ISSUE_OP,
    payload: { target, role, ttl_seconds: ttlSeconds }
  })
  /* 传输层失败（超时 / SDK / 网络）⇒ `STORAGE_UNAVAILABLE`，**绝不伪装成 FORBIDDEN**。 */
  if (!reply.ok) {
    return {
      ok: false,
      reason: reply.reason || 'STORAGE_UNAVAILABLE',
      message: reply.message || '斐萃令牌服務暫時不可用，請稍後再試。'
    }
  }
  const result = reply.result || {}
  if (result.ok !== true) {
    return {
      ok: false,
      reason: typeof result.reason === 'string' ? result.reason : 'STORAGE_UNAVAILABLE',
      message: typeof result.message === 'string' && result.message ? result.message : '斐萃令牌簽發被拒絕。'
    }
  }
  const row = result.row || {}
  const token = String(row.token || '').trim()
  if (!token) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '簽發回包形狀不可辨識（無令牌）；請重試。' }
  }
  return {
    ok: true,
    token,
    uid: String(row.uid || ''),
    role: String(row.role || ''),
    kid: String(row.kid || ''),
    jti: String(row.jti || ''),
    exp: Number(row.exp) || 0,
    expires_at: String(row.expires_at || ''),
    ttl_seconds: Number(row.ttl_seconds) || 0
  }
}

/** 剩余秒数（**只用于展示**；服务端时钟才是判据）。 */
export function remainingSeconds(expiresAt, nowMs) {
  const target = Date.parse(String(expiresAt || ''))
  if (!Number.isFinite(target)) return 0
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  return Math.max(0, Math.round((target - now) / 1000))
}
