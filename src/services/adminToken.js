/**
 * 玺爱 · **管理员令牌客户端管道**（写面 Phase 1 新增）
 * ============================================================================
 * 唯一职责：**取票 → 缓存 → 携带 → 滑动续期 → 失败形态**。**它自己不是判据**。
 *
 * Zang 裁定落成（R-WF1 / R-WF2）：
 *   · **服务端验签是唯一判据** ✓：本文件从不产出「可以写」的结论 ——
 *     每一次写操作都拿云函数的回传当判据；本地 `role` **不参与**任何放行判定。
 *   · **前端永不下发写权限判据** ✓：密钥 / 白名单手机号 / 签名算法**一概不在前端**；
 *     前端只负责**携带**令牌（`token` 字段）与**呈现**拒绝文案。
 *   · **网络失败不得伪装成 `FORBIDDEN`** ✓：传输层失败一律 `STORAGE_UNAVAILABLE`（见 `data/cloudbaseFn.js`）；
 *     **服务端的业务拒绝原样透传**（本文件不改写 `reason` / `message`）。
 *
 * 存储位置：**只在内存**（模块级变量）。
 *   理由（本单口径，与设计单 §2.1 的「内存 + `sessionStorage`」有一处**登记在案的收窄**）：
 *   本工程 `src/data/storage.js` 是全工程**唯一**允许直接触碰浏览器存储的模块，
 *   而令牌**不进 `localStorage`** 是硬约束（减少 XSS 长期驻留面）⇒ Phase 1 **不新增存储底座**、
 *   不写 `sessionStorage`（页面刷新即重新取票）。⇒ 已登记为「未覆盖项」（Phase 2 再定持久化面）。
 *
 * 时钟：**不在客户端判时效**（本地时间只用于「要不要先取票」的体验判断，不作判据）；
 *   令牌是否过期**一律以云函数回传为准**（过期 ⇒ 服务端 `FORBIDDEN` + 明确文案）。
 */

import { callCloudFunction, setCloudFunctionTransport } from '../data/cloudbaseFn.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { currentUser } from '../data/session.js'

/** 云函数名（唯一一处定义点）。 */
export const ADMIN_TOKEN_FUNCTION = 'xiai-admin-token'

/** 动作字面值（与云函数 `index.js` 的 `action` 逐字一致）。 */
export const ADMIN_TOKEN_ACTIONS = Object.freeze({ ISSUE: 'issue', VERIFY: 'verify' })

/** 形态标注（上屏 / 报告用）。 */
export const ADMIN_TOKEN_MODES = Object.freeze({ CLOUD: 'cloud', LOCAL_DEV: 'local-dev' })

/** 令牌缓存（**内存**；`token` 不对外暴露原文）。 */
const state = {
  token: '',
  expiresAt: 0,
  ver: '',
  sub: '',
  issuedAt: 0,
  renewals: 0,
  lastReason: ''
}

/**
 * 传输注入缝（离线自检 / 宿主；**生产不注入** ⇒ 走 `data/cloudbaseFn.js` 的真实 SDK 调用）。
 * @param {null|function} fn
 */
export function setAdminTokenTransport(fn) {
  setCloudFunctionTransport(fn)
}

/** 不可逆诊断指纹（FNV-1a 32 位十六进制）；**只用于读数，绝不用于判定**。 */
function fingerprint(value) {
  let hash = 0x811c9dc5
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/** 令牌读数（**不含令牌原文**；只有长度与指纹 ⇒ 可直接进报告 / 日志）。 */
export function adminTokenSnapshot() {
  const remaining = state.token ? Math.max(0, state.expiresAt - nowSeconds()) : 0
  return {
    mode: writeFaceMode(),
    present: state.token !== '',
    /* 体验层判断（**不是判据**）：本地时间粗算的剩余秒数。 */
    remainingSeconds: remaining,
    expiresAt: state.expiresAt,
    issuedAt: state.issuedAt,
    ver: state.ver,
    sub: state.sub,
    tokenLength: state.token.length,
    tokenFingerprint: state.token ? fingerprint(state.token) : '',
    slidingRenewals: state.renewals,
    lastReason: state.lastReason
  }
}

export function hasAdminToken() {
  return state.token !== ''
}

/** 清空缓存令牌（登出 / 授权判定失败时调用）。 */
export function clearAdminToken() {
  state.token = ''
  state.expiresAt = 0
  state.ver = ''
  state.sub = ''
  state.issuedAt = 0
  return adminTokenSnapshot()
}

/** 传输层 / 协议层失败（**不得伪装 `FORBIDDEN`**；沿用既有冻结字面值）。 */
function shapeDenial() {
  return {
    ok: false,
    reason: 'STORAGE_UNAVAILABLE',
    message: '雲端校驗回傳形狀不可辨識，無法確認寫入權限；本次零寫入。'
  }
}

/* ---------------------------------------------------------------------------
   1. 取票（低频；仅管理员）＋ 滑动续期
   --------------------------------------------------------------------------- */

/**
 * 取票：手机号 + 验证码 ⇒ 短期令牌（**服务端验签是唯一判据 ⇒ 这里只做携带**）。
 * @param {string} phone 手机号（服务端再判白名单）
 * @param {string} code 验证码（服务端判；**不得**在前端硬编码）
 * @returns {Promise<{ok:true, expiresAt:number, ttlSeconds:number, sub:string, ver:string, serverNow:number}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function requestAdminToken(phone, code) {
  const reply = await callCloudFunction(ADMIN_TOKEN_FUNCTION, {
    action: ADMIN_TOKEN_ACTIONS.ISSUE,
    phone: String(phone === undefined || phone === null ? '' : phone).trim(),
    code: String(code === undefined || code === null ? '' : code).trim()
  })
  /* 传输层失败 ⇒ 原样（`STORAGE_UNAVAILABLE`）；业务拒绝 ⇒ 原样透传。 */
  if (!reply.ok) return reply
  const result = reply.result
  if (!result || result.ok !== true || typeof result.token !== 'string' || result.token === '') return shapeDenial()
  state.token = result.token
  state.expiresAt = Number(result.expiresAt) || 0
  state.issuedAt = Number(result.issuedAt) || 0
  state.ver = typeof result.ver === 'string' ? result.ver : ''
  state.sub = typeof result.sub === 'string' ? result.sub : ''
  state.renewals = 0
  state.lastReason = ''
  return {
    ok: true,
    /* **不回吐令牌原文**（调用方无需它；减少误打印面）。 */
    expiresAt: state.expiresAt,
    ttlSeconds: Number(result.ttlSeconds) || 0,
    sub: state.sub,
    ver: state.ver,
    serverNow: Number(result.serverNow) || 0,
    tokenLength: state.token.length,
    tokenFingerprint: fingerprint(state.token)
  }
}

/**
 * 保证「本次写操作有一枚可携带的令牌」——给页面用的最小入口（云端模式下才需要）。
 * @param {string} code 验证码（**必要时**才需要：已有未过期令牌 ⇒ 直接复用、不用码）
 * @param {string} [phone] 手机号（缺省取当前登录用户的 `phone`）
 * @returns {Promise<{ok:true, mode:string, reused:boolean, expiresAt:number, message:string}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function ensureAdminWriteSession(code, phone) {
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    return {
      ok: true,
      mode: ADMIN_TOKEN_MODES.LOCAL_DEV,
      reused: false,
      expiresAt: 0,
      message: 'dev / 離線形態：未經雲端驗簽（**非正式寫入路徑**）。'
    }
  }
  if (state.token !== '' && state.expiresAt - nowSeconds() > 0) {
    return {
      ok: true,
      mode: ADMIN_TOKEN_MODES.CLOUD,
      reused: true,
      expiresAt: state.expiresAt,
      message: '沿用既有令牌（未過期）。'
    }
  }
  const user = currentUser()
  const target = String(phone || (user && user.phone) || '').trim()
  const issued = await requestAdminToken(target, code)
  if (!issued.ok) return issued
  return {
    ok: true,
    mode: ADMIN_TOKEN_MODES.CLOUD,
    reused: false,
    expiresAt: issued.expiresAt,
    message: '已取得寫入令牌。'
  }
}

/* ---------------------------------------------------------------------------
   2. 写门（**服务端验签是唯一判据**）
   --------------------------------------------------------------------------- */

/**
 * 写操作的服务端门：**云端形态下必须由 `xiai-admin-token` 回 `ok:true` 才算过门**。
 * @param {string} op 写操作名（须在云函数的 `OPS` 注册面内）
 * @param {object} payload 载荷
 * @returns {Promise<{ok:true, mode:string, value?:any, expiresAt?:number, dev?:boolean, message?:string}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function adminGate(op, payload) {
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    /* dev / 离线形态：**没有服务端** ⇒ 本门放行「到服务层自己的判定」为止；
       **明文：这条分支不算授权** —— 调用方（`services/admin.js`）仍须跑它自己的本地角色门，
       且本形态**明确标注为非正式写入路径**（见 `writeFaceModeLabel()`）。 */
    return { ok: true, mode: ADMIN_TOKEN_MODES.LOCAL_DEV, dev: true, message: 'dev / 離線形態：未經雲端驗簽。' }
  }
  /* 云端形态：**不预判、不短路** —— 一律把请求交给云函数（前端不产出授权结论）。 */
  const reply = await callCloudFunction(ADMIN_TOKEN_FUNCTION, {
    action: ADMIN_TOKEN_ACTIONS.VERIFY,
    token: state.token,
    op: String(op || ''),
    payload: payload === undefined ? null : payload
  })
  if (!reply.ok) {
    /* 传输层失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）；令牌**不清**（「未知」≠「无效」）。 */
    state.lastReason = reply.reason
    return reply
  }
  const result = reply.result
  if (result && result.ok === true) {
    /* **滑动续期**：服务端每次校验通过都回吐新令牌 ⇒ 覆盖缓存（只延长时效，不改变权限面）。 */
    if (typeof result.renewedToken === 'string' && result.renewedToken !== '') {
      state.token = result.renewedToken
      state.expiresAt = Number(result.renewedExpiresAt) || state.expiresAt
      state.ver = typeof result.ver === 'string' ? result.ver : state.ver
      state.renewals += 1
    }
    state.lastReason = ''
    return {
      ok: true,
      mode: ADMIN_TOKEN_MODES.CLOUD,
      op: typeof result.op === 'string' ? result.op : String(op || ''),
      value: result.value,
      expiresAt: state.expiresAt,
      serverNow: Number(result.serverNow) || 0,
      renewals: state.renewals,
      message: ''
    }
  }
  if (result && result.ok === false && typeof result.reason === 'string' && typeof result.message === 'string') {
    /* **服务端结构化拒绝原样透传**（`reason` / `message` 一个都不改写）。 */
    state.lastReason = result.reason
    if (result.reason === 'FORBIDDEN') clearAdminToken()
    return { ok: false, reason: result.reason, message: result.message }
  }
  return shapeDenial()
}

/** 诊断读数（**不含密钥 / 不含令牌原文**）。 */
export function adminTokenStatus() {
  return {
    functionName: ADMIN_TOKEN_FUNCTION,
    mode: writeFaceMode(),
    snapshot: adminTokenSnapshot()
  }
}
