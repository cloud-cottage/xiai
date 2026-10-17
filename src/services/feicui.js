/**
 * 玺爱 · **「連接斐萃」门面**（本单新增）
 * ============================================================================
 * 只在**已登錄**时向云函数 `xiai-user-token` 的 op `issueFeicuiCode` 换一枚**一次性授權碼**：
 *   · 身份由服务端经 **auth API 通道**派生（本层**不传**任何 uid / 手机号 / 角色）；
 *   · 载荷**空**（`payload: {}`；服务端 op 的封闭键面恰为空集 ⇒ 多一个键就被 `INVALID_FIELD` 拒）；
 *   · 回包只有 `{code, issued_at, expires_at, ttl_seconds}` —— **没有 uid、没有令牌**。
 *
 * 为什么不经 `userWriteGate`：那个门是「写面令牌」路径（V3）；本 op 走 **V6 平台会话身份**
 * （浏览器已登录 CloudBase 会话即够，无需再补签令牌）⇒ 直接 `callCloudFunction` 更贴合口径，
 * 也避免把「待退的 V3 令牌」当成第二条换身份通道。
 *
 * 纪律：页面 / 组件**只经本门面**（不直接 import `../data/*`）；本层不打印任何码原文。
 */

import { callCloudFunction } from '../data/cloudbaseFn.js'
import { isLoggedIn } from '../data/session.js'

/** 云函数名 / op 名（与 `cloudfunctions/xiai-user-token/lib/ops.js::OPS` 逐字一致）。 */
export const FEICUI_FUNCTION_NAME = 'xiai-user-token'
export const FEICUI_ISSUE_OP = 'issueFeicuiCode'

/** 未登录（本层判定，零网络）。 */
export const LOGIN_REQUIRED = 'LOGIN_REQUIRED'

/** 服务端换身份的核销路由（斐萃服务端打它；本站只作展示文案，不自己调）。 */
export const FEICUI_EXCHANGE_PATH = '/api/auth/feicui-exchange'

/**
 * 申请一枚一次性授权码。
 * @returns {Promise<
 *   {ok:true, code:string, issued_at:string, expires_at:string, ttl_seconds:number} |
 *   {ok:false, reason:string, message:string}>}
 */
export async function issueCode() {
  if (!isLoggedIn.value) {
    return {
      ok: false,
      reason: LOGIN_REQUIRED,
      message: '請先登錄後再產生授權碼（未找到登錄會話）。'
    }
  }
  const reply = await callCloudFunction(FEICUI_FUNCTION_NAME, {
    action: 'verify',
    op: FEICUI_ISSUE_OP,
    payload: {}
  })
  /* 传输层失败（超时 / SDK / 网络）⇒ `STORAGE_UNAVAILABLE`，**绝不伪装成 FORBIDDEN**。 */
  if (!reply.ok) {
    return { ok: false, reason: reply.reason || 'STORAGE_UNAVAILABLE', message: reply.message || '授權碼服務暫時不可用，請稍後再試。' }
  }
  const result = reply.result || {}
  if (result.ok !== true) {
    return {
      ok: false,
      reason: typeof result.reason === 'string' ? result.reason : 'STORAGE_UNAVAILABLE',
      message: typeof result.message === 'string' && result.message ? result.message : '授權碼簽發被拒絕。'
    }
  }
  const row = result.row || {}
  const code = String(row.code || '').trim().toUpperCase()
  if (!code) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '授權碼回包形狀不可辨識（無碼）；請重試。' }
  }
  return {
    ok: true,
    code,
    issued_at: String(row.issued_at || ''),
    expires_at: String(row.expires_at || ''),
    ttl_seconds: Number(row.ttl_seconds) || 0
  }
}

/** 剩余秒数（`expires_at` 与服务端时钟无关地按本地时钟估算，只用于**展示**，不参与判定）。 */
export function remainingSeconds(expiresAt, nowMs) {
  const target = Date.parse(String(expiresAt || ''))
  if (!Number.isFinite(target)) return 0
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  return Math.max(0, Math.round((target - now) / 1000))
}
