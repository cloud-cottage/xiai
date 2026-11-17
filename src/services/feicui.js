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

/**
 * **斐萃桌面授权**（设备令牌）op 名 —— 与 `lib/ops.js::OPS` 注册面逐字一致
 * （跨仓契约 §13.2：admin only、TTL 30 天、回包恰 3 键 `{ok, token, expires_at}`）。
 * 全 `src/**` 只在本文件出现（组件一律经下面的 `issueDeviceToken()` 动詞函数）。
 */
export const FEICUI_DEVICE_OP = 'issueFeicuiDeviceToken'

/** 转发路由前缀（斐萃侧带 `Authorization: Feicui <token>` 打的就是它）。
 *  子路径迁移后对外公开的路由＝网关 `api/xiai` 下的 `/api/feicui/v1/*`（服务端内部
 *  路由段一字未改，前缀由 `cloudfunctions/xiai-web-api` 挂载时剥掉）。 */
export const FEICUI_FORWARD_PREFIX = '/api/xiai/feicui/v1'

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

/* ---------------------------------------------------------------------------
   **斐萃桌面授權（設備令牌）** —— 跨仓契约 `dispatch-zang.md` §13（管理员入口）
   ---------------------------------------------------------------------------
   通道与 `issueToken` **同一条**（`xiai-user-token` 的 `action:'verify'` 信封），
   入口契约逐字 `{action:'verify', op, payload}` —— **不是**把 op 名当 `action`。
   硬口径（逐条）：
     ① 载荷**封闭键面**：缺省 `{}`（不收集任何字段）；**本单新增**可选 `ttl_seconds`
        （整数秒 ∈ `[300, 43200]`；页面「為斐翠桌面簽發 8 小時會話」传 28800）。
        未给 ⇒ 载荷逐字仍是 `{}`（服务端走 30 天缺省，既有行为不变）；
     ② 回包**恰 3 键** `{ok, token, expires_at}` —— 本层只挑这三键，**不多不少**；
     ③ 失败原样透传服务端的 `{ok:false, reason, message}`（`FORBIDDEN` 就是
        `FORBIDDEN`，不伪装成传输故障、不造兜底文案覆盖判定）；`ttl_seconds` 形态不合
        ⇒ 本层前置 `INVALID_VALUE` ＋ **零往返**（与服务端同一 reason 字面值）；
     ④ **本层零持久化**：不写本地存儲 / 會話存儲 / 瀏覽器資料庫 / cookie，
        不進網址，不打日誌 —— 令牌只沿返回值上抛给调用方（组件内存持有）。
*/

/** 設備令牌有效期面（服务端 `FEICUI_DEVICE_TOKEN_*` 的同值镜像；缺省 30 天）。 */
export const FEICUI_DEVICE_TTL = Object.freeze({
  defaultSeconds: 30 * 24 * 60 * 60,
  /** 斐萃桌面版「登錄即授權」通道：8 小時。 */
  sessionSeconds: 8 * 60 * 60,
  minSeconds: 5 * 60,
  maxSeconds: 12 * 60 * 60
})

/** 前置拦截的取值 reason（与服务端 `REASONS.INVALID_VALUE` 同一字面值）。 */
export const INVALID_VALUE = 'INVALID_VALUE'

/**
 * 前置换算 `ttlSeconds`（**越界 / 非整数 ⇒ `null`**，由调用方报错，不静默夹取）。
 * 缺省（未给 / `null`）⇒ 30 天。
 * @param {*} value
 * @returns {number|null}
 */
export function deviceTtlSecondsOf(value) {
  if (value === undefined || value === null) return FEICUI_DEVICE_TTL.defaultSeconds
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < FEICUI_DEVICE_TTL.minSeconds || value > FEICUI_DEVICE_TTL.maxSeconds) return null
  return value
}

/**
 * 宿主橋探测（**桌面版必需**；只读、无副作用）：pywebview → wails → 通用全局函数。
 * 返回 `(token, meta) => Promise|void` 的薄包；无桥 ⇒ `null`（调用方回退一键複製）。
 * @param {object} [host] 宿主对象（缺省取 `window`；自检可注入假体）
 * @returns {((token:string, meta:{expires_at:string, ttl_seconds:number}) => *)|null}
 */
export function feicuiHostBridgeOf(host) {
  const scope = host === undefined ? (typeof window === 'undefined' ? null : window) : host
  if (!scope) return null
  const pywebviewApi = scope.pywebview && scope.pywebview.api
  if (pywebviewApi && typeof pywebviewApi.receive_feicui_token === 'function') {
    return (token, meta) => pywebviewApi.receive_feicui_token(token, meta)
  }
  const wails = scope.wails
  if (wails && typeof wails.receive_feicui_token === 'function') {
    return (token, meta) => wails.receive_feicui_token(token, meta)
  }
  if (typeof scope.receive_feicui_token === 'function') {
    return (token, meta) => scope.receive_feicui_token(token, meta)
  }
  return null
}

/**
 * 把令牌交给宿主（**令牌只经函数参数过一遍**，本层不落盘、不打日志、不进网址）。
 * 桥抛错 ⇒ 结构化 `{delivered:false, reason:'BRIDGE_FAILED'}`，**令牌原样留在调用方**
 * （回退一键複製，不丢令牌）。
 * @param {string} token 令牌明文
 * @param {{expires_at?:string, ttl_seconds?:number}} [meta] 交付元数据
 * @param {object} [host] 宿主对象（缺省 `window`；自检注入假体）
 * @returns {Promise<{delivered:boolean, reason:string}>}
 */
export async function deliverTokenToHost(token, meta, host) {
  const plaintext = String(token === undefined || token === null ? '' : token).trim()
  if (plaintext === '') return { delivered: false, reason: 'NO_TOKEN' }
  const bridge = feicuiHostBridgeOf(host)
  if (!bridge) return { delivered: false, reason: 'BRIDGE_ABSENT' }
  const options = meta || {}
  try {
    await bridge(plaintext, {
      expires_at: String(options.expires_at === undefined || options.expires_at === null ? '' : options.expires_at),
      ttl_seconds: Number(options.ttl_seconds) || 0
    })
    return { delivered: true, reason: 'DELIVERED' }
  } catch {
    return { delivered: false, reason: 'BRIDGE_FAILED' }
  }
}

export async function issueDeviceToken(input) {
  const options = input || {}
  if (!isLoggedIn.value) {
    return { ok: false, reason: LOGIN_REQUIRED, message: '請先以管理員賬號登錄（未找到登錄會話）。' }
  }
  if (!isAdmin.value) {
    return { ok: false, reason: NOT_ADMIN, message: '僅管理員可以簽發斐萃桌面授權。' }
  }
  /* **可选有效期**：未给 ⇒ 载荷逐字 `{}`（服务端 30 天缺省）；给了 ⇒ 整数 `[300, 43200]`。 */
  const ttlGiven = options.ttlSeconds !== undefined && options.ttlSeconds !== null
  const ttlSeconds = deviceTtlSecondsOf(options.ttlSeconds)
  if (ttlSeconds === null) {
    return {
      ok: false,
      reason: INVALID_VALUE,
      message: `有效期（ttl_seconds）必須是 ${FEICUI_DEVICE_TTL.minSeconds}〜${FEICUI_DEVICE_TTL.maxSeconds} 的整數秒。`
    }
  }
  const reply = await callCloudFunction(FEICUI_FUNCTION_NAME, {
    action: 'verify',
    op: FEICUI_DEVICE_OP,
    payload: ttlGiven ? { ttl_seconds: ttlSeconds } : {}
  })
  /* 传输层失败（超时 / SDK / 网络）⇒ `STORAGE_UNAVAILABLE`，**绝不伪装成 FORBIDDEN**。 */
  if (!reply.ok) {
    return {
      ok: false,
      reason: reply.reason || 'STORAGE_UNAVAILABLE',
      message: reply.message || '斐萃桌面授權服務暫時不可用，請稍後再試。'
    }
  }
  const result = reply.result || {}
  if (result.ok !== true) {
    return {
      ok: false,
      reason: typeof result.reason === 'string' && result.reason !== '' ? result.reason : 'STORAGE_UNAVAILABLE',
      message: typeof result.message === 'string' && result.message !== '' ? result.message : '斐萃桌面授權簽發被拒絕。'
    }
  }
  const token = String(result.token === undefined || result.token === null ? '' : result.token).trim()
  if (token === '') {
    /* 形状不可辨識（无令牌）⇒ 结构化拒绝；**不編造令牌**、调用方零上屏。 */
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '簽發回傳形狀不可辨識（無令牌）；請重試。' }
  }
  return {
    ok: true,
    token,
    expires_at: String(result.expires_at === undefined || result.expires_at === null ? '' : result.expires_at)
  }
}
