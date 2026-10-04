/**
 * 玺爱 · **登录令牌写面门（含令牌自愈）**（V3 新增）
 * ============================================================================
 * 背景（人类 Kevin 的架构裁定 V3，逐条）：
 *   ① **管理员写面收敛为一枚登录令牌**：服务端接受**登录令牌**（云函数
 *      `xiai-user-token` 的 `action:'verify'`）＋ 手机号 ∈ **管理员白名单**
 *      ⇒ 采纳 / 驳回、改邀请奖励**永不需要第二个码、零弹窗**；
 *   ② 令牌**只存内存**（`src/services/token.js` 的通道闭包）⇒ **刷新页面即丢**，
 *      而本地会话只持久化 `{userId}`（形如 `u-<16 位十六进制>`，**不可反推手机号**）⇒ 刷新后直接写会被服务端
 *      以「未攜帶有效令牌」拒（**既有缺陷**）。
 *
 * 本文件把这两件事收口到**单点**：
 *   · `userWriteGate(op, payload)` —— 发起任何经用户令牌通道的写**之前**，若内存无令牌
 *     但本地**有登录会话** ⇒ 先**静默补签**一次（`issue`），成功即继续原写；
 *     **无会话 或 补签失败 ⇒ 原样结构化拒绝 ＋ 可读引导（不得静默）**。
 *   · 它是**编排**，不是判据：过门之后 `userGate` 仍把请求交给云函数，
 *     **服务端验签 / 白名单 / 值域才是唯一判据**（本文件从不产出「可以写」的结论）。
 *
 * 补签的手机号**从本人本地会话的 `user.phone` 取**（**不得**从 uid 反推 —— uid 是单向派生）；
 * 验证码用**公开演示常量** `DEMO_SMS_CODE`（它随前端包公开，不是一个秘密 —— 见 `auth.js` 文件头）。
 *
 * 失败形状恒为 `{ok:false, reason, message}`（`reason` ∈ 既有冻结表），
 * 与 `token.js` / 云函数的拒绝形态**同形**；传输失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）。
 */

import { currentUser } from '../data/session.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { hasUserToken, ensureUserWriteSession, userGate } from './userToken.js'
/* **公开演示常量**（唯一真源见 `auth.js` 文件头）：它随前端包公开 ⇒ **不是秘密**；
   仅用于「刷新后静默补签」这一条体验路径，绝不替代服务端验签。 */
import { DEMO_SMS_CODE } from './auth.js'

/** 手机号形态（与 `auth.js::isPhoneLike` / 云函数 `lib/config.js` 逐字同正则）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/** 无登录会话时的对外 reason（沿用既有冻结字面值；`FORBIDDEN` 只用于真正的授权判定）。 */
const LOGIN_REQUIRED = 'FORBIDDEN'

/**
 * 从登录会话取手机号：**只从本人本地会话的 `user.phone` 取**。
 *
 * **不得**再从 `user.id`（uid）反推 —— uid 已改为**单向派生**（`u-` ＋ sha256(手机号) 前 16 位，
 * 不可反推手机号）；手机号只允许从**本人本地会话**读（人类口径 ④），**绝不从数据行读**。
 * 取不到（游客 / 形态不符）⇒ 空串（调用方据此判定「无可补签的会话」）。
 * @param {{id?:string, phone?:string}|null} [user]
 * @returns {string}
 */
export function sessionPhoneOf(user) {
  const source = user || currentUser()
  if (!source) return ''
  const direct = String(source.phone || '').replace(/[^0-9]/g, '')
  return PHONE_PATTERN.test(direct) ? direct : ''
}

/**
 * 保证「本次写有一枚可携带的令牌」。
 *
 * - **dev / 離線形態**：无云端 ⇒ 直接放行标记（**非正式写入路径**，与既有口径一致）；
 * - **已有令牌**：不补签（零往返）；
 * - **云端 ＋ 无令牌 ＋ 有会话**：静默 `issue` 补签一次（手机号由会话派生、演示码）；
 * - **云端 ＋ 无令牌 ＋ 无会话**：结构化拒绝 ＋ 登录引导（**零写入，不得静默**）；
 * - **补签失败**：**原样**透传失败 `reason` / `message`（不吞成通用提示），零写入。
 * @returns {Promise<{ok:true, mode:string, healed:boolean}|{ok:false, reason:string, message:string}>}
 */
export async function ensureUserTokenForWrite() {
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    return { ok: true, mode: WRITE_FACE_MODES.LOCAL_DEV, healed: false }
  }
  if (hasUserToken()) return { ok: true, mode: 'cloud', healed: false }
  const phone = sessionPhoneOf(currentUser())
  if (!phone) {
    /* 无会话 ⇒ 结构化拒绝 ＋ 可读引导（提示先登录），**零写入**。 */
    return {
      ok: false,
      reason: LOGIN_REQUIRED,
      message: '請先登錄後再執行此操作（未找到可補簽的登錄會話）；本次零寫入。'
    }
  }
  const session = await ensureUserWriteSession(DEMO_SMS_CODE, phone)
  if (!session.ok) {
    /* 补签失败 ⇒ **原样**透传（`reason` / `message` 一个都不改写），**零写入**。 */
    return { ok: false, reason: session.reason || LOGIN_REQUIRED, message: session.message || '登錄態已失效，請重新登錄；本次零寫入。' }
  }
  return { ok: true, mode: 'cloud', healed: true }
}

/**
 * **写入口统一门**（`corrections.js::review/reviewBatch/submitCorrection`、
 * `endorsements.js::endorseCorrection`、`admin.js::setInviteReward` 一律经本函数）。
 *
 * 语义：**先保证有一枚可携带的令牌（必要时静默补签），再过云端门**。
 * 不过门（无会话 / 补签失败 / 服务端结构化拒绝 / 传输失败）⇒ **原样透传** ＋ 零写入。
 * @param {string} op 写操作名（须在云函数 `OPS` / `ADMIN_OPS` 注册面内）
 * @param {object} payload 载荷（身份类键由服务端拒）
 * @returns {Promise<object>} `userGate` 的返回（成功含 `mode` / `row` / `projection` / `docId` …）
 */
export async function userWriteGate(op, payload) {
  const guaranteed = await ensureUserTokenForWrite()
  if (!guaranteed.ok) return guaranteed
  return userGate(op, payload)
}
