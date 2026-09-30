/**
 * 玺爱 · **用户令牌客户端管道（转口）**（写面 Phase A 新增）
 * ============================================================================
 * 管道本体在 `src/services/token.js`（**与管理员通道共用同一份实现**：同一形态令牌、
 * 同一 TTL、同一滑动续期、同一失败形态）；本文件只做**用户通道的绑定与转口**，
 * **不复制任何判定逻辑**（复制必然漂移 —— 泛化的全部理由见 `token.js` 文件头）。
 *
 * 与管理员侧的差别（只有两处，且都在服务端）：
 *   ① 函数名 `xiai-user-token`（另一把密钥 ⇒ 令牌不跨函数通用）；
 *   ② 没有手机号白名单（普通用户写面本来就是「任何已登录用户」）。
 * 失败形态、拒绝形状（恰 3 键）、`STORAGE_UNAVAILABLE` vs `FORBIDDEN` 的边界**逐字相同**。
 */

import {
  USER_TOKEN_FUNCTION,
  TOKEN_ACTIONS,
  TOKEN_MODES,
  userTokenChannel,
  setUserTokenTransport,
  userTokenSnapshot,
  hasUserToken,
  clearUserToken,
  requestUserToken,
  ensureUserWriteSession,
  userGate,
  userTokenStatus
} from './token.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'

export {
  USER_TOKEN_FUNCTION,
  TOKEN_ACTIONS as USER_TOKEN_ACTIONS,
  TOKEN_MODES as USER_TOKEN_MODES,
  userTokenChannel,
  setUserTokenTransport,
  userTokenSnapshot,
  hasUserToken,
  clearUserToken,
  requestUserToken,
  ensureUserWriteSession,
  userGate,
  userTokenStatus
}

/**
 * **登录用的取票入口**（Phase A 的核心：登录不再只写本机 session）。
 *
 * 语义与 `ensureWriteSession` **不同**：登录**必须**由服务端验证这一次（**不复用缓存令牌**），
 * 否则「先服务端验证再写 session」就退化成了「沿用旧令牌」。
 * @param {string} phone 手机号（服务端判形态）
 * @param {string} code 验证码（**服务端判**；前端不硬编码）
 * @returns {Promise<{ok:true, mode:string, expiresAt:number, uid:string, sub:string, message:string}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function ensureUserLoginToken(phone, code) {
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    return {
      ok: true,
      mode: TOKEN_MODES.LOCAL_DEV,
      expiresAt: 0,
      uid: '',
      sub: '',
      message: 'dev / 離線形態：未經雲端驗證（**非正式登錄路徑**）。'
    }
  }
  const issued = await requestUserToken(phone, code)
  if (!issued.ok) return issued
  return {
    ok: true,
    mode: TOKEN_MODES.CLOUD,
    expiresAt: issued.expiresAt,
    uid: issued.uid,
    sub: issued.sub,
    message: '已通過雲端驗證。'
  }
}
