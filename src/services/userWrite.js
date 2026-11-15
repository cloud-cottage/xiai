/**
 * 玺爱 · **登录令牌写面门（含令牌自愈）**（V3 新增｜P1b 收口）
 * ============================================================================
 * 背景（人类 Kevin 的架构裁定 V3，逐条）：
 *   ① **管理员写面收敛为一枚登录令牌**：服务端接受**登录令牌**（云函数
 *      `xiai-user-token` 的 `action:'verify'`）＋ 手机号 ∈ **管理员白名单**
 *      ⇒ 采纳 / 驳回、改邀请奖励**永不需要第二个码、零弹窗**；
 *   ② 令牌**只存内存**（`src/services/token.js` 的通道闭包）⇒ **刷新页面即丢**，
 *      而本地会话只持久化 `{userId}`（形如 `u-<16 位十六进制>`，**不可反推手机号**）⇒ 刷新后直接写会被服务端
 *      以「未攜帶有效令牌」拒。
 *
 * 本文件把这两件事收口到**单点**：
 *   · `userWriteGate(op, payload)` —— 发起任何经用户令牌通道的写**之前**，若内存无令牌
 *     但本地**有登录会话** ⇒ 先**保证有一枚令牌**，成功即继续原写；
 *     **无会话 / 无令牌 ⇒ 原样结构化拒绝 ＋ 可读引导（不得静默）**。
 *   · 它是**编排**，不是判据：过门之后 `userGate` 仍把请求交给云函数，
 *     **服务端验签 / 白名单 / 值域才是唯一判据**（本文件从不产出「可以写」的结论）。
 *
 * **P1b 起不再有「固定短訊碼静默补签」这条路**（上一版的固定码常量已整体删除）：
 *   验证码现在只在平台侧（`services/auth.js` 的 `getVerification` → `verify` → `signIn`）验一次，
 *   补签所需的凭据是**平台会話憑證**，不是任何常量。
 *
 * **P3（R-L10，2026-11-15）已落地令牌持久化**：`token.js` 的 `present()` 会先尝试读回
 *   `xiai:v1:user-token`（校验形态与未过期）⇒ **刷新页面后写面零提示、零重新登录**。
 *   本文件的口径**逐字不变**：这里的拒绝只在「确实没有可用令牌」时发生 ——
 *   过期 / 被撤销 / 被登出清空 / 持久化坏了 ⇒ 仍是**结构化拒绝 ＋ 可读引导**，
 *   绝不拿任何常量去「假装补签」。
 *
 * 失败形状恒为 `{ok:false, reason, message}`（`reason` ∈ 既有冻结表），
 * 与 `token.js` / 云函数的拒绝形态**同形**；传输失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不伪装 `FORBIDDEN`**）。
 */

import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { hasUserToken, userGate } from './userToken.js'

/** 无登录会话（或会话已无可用令牌）时的对外 reason（沿用既有冻结字面值）。 */
const LOGIN_REQUIRED = 'FORBIDDEN'

/**
 * 保证「本次写有一枚可携带的令牌」。
 *
 * - **dev / 離線形態**：无云端 ⇒ 直接放行标记（**非正式写入路径**，与既有口径一致）；
 * - **已有令牌**：零往返（不补签）；
 * - **云端 ＋ 无令牌**：**结构化拒绝 ＋ 重新登录引导**（P1b 起不再静默补签；令牌持久化属 P3）
 *   —— 零写入，且**不得**用任何常量凭据补签（那等于把验证码做成公开秘密）。
 * @returns {Promise<{ok:true, mode:string, healed:boolean}|{ok:false, reason:string, message:string}>}
 */
export async function ensureUserTokenForWrite() {
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    return { ok: true, mode: WRITE_FACE_MODES.LOCAL_DEV, healed: false }
  }
  if (hasUserToken()) return { ok: true, mode: 'cloud', healed: false }
  /* 云端 ＋ 无令牌：**不补签**（无凭据可补）⇒ 结构化拒绝 ＋ 引导；**零写入**。 */
  return {
    ok: false,
    reason: LOGIN_REQUIRED,
    message: '本次登錄的寫入憑證已失效（刷新後需重新登錄）；請重新登錄後再執行此操作；本次零寫入。'
  }
}

/**
 * **写入口统一门**（`corrections.js::review/reviewBatch/submitCorrection`、
 * `endorsements.js::endorseCorrection`、`admin.js::setInviteReward` 一律经本函数）。
 *
 * 语义：**先保证有一枚可携带的令牌（必要时按云端门取证），再过云端门**。
 * 不过门（无令牌 / 服务端结构化拒绝 / 传输失败）⇒ **原样透传** ＋ 零写入。
 * @param {string} op 写操作名（须在云函数 `OPS` / `ADMIN_OPS` 注册面内）
 * @param {object} payload 载荷（身份类键由服务端拒）
 * @param {{readoutKeys?:Array<string>}} [options] **additive 透传声明**（原样转交 `userGate` 第三参；
 *   键面真源 ＝ `aiAccess.js`，本文件零 op 名字面值、零键名字面值）
 * @returns {Promise<object>} `userGate` 的返回（成功含 `mode` / `row` / `projection` / `docId` …）
 */
export async function userWriteGate(op, payload, options) {
  const guaranteed = await ensureUserTokenForWrite()
  if (!guaranteed.ok) return guaranteed
  return userGate(op, payload, options)
}
