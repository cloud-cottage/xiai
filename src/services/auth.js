/**
 * 玺爱 · 登录服务（手机号 + 验证码）
 *
 * 开发登录约定沿用本工作台既有口径：验证码固定 1234。
 * 零后端：登录只在本机 localStorage 内完成，不发起任何外部请求。
 */

import { listUserRows, saveUserRows } from '../data/db.js'
import { setUser, restoreSession } from '../data/session.js'
import { ADMIN_PHONE, ADMIN_NICKNAME } from '../data/seed.js'
import { grantInitialGold, settleInviteReward } from './points.js'
/* **写面 Phase A（用户写面）**：登录改为「**先服务端验证并拿到用户令牌，再写 session**」——
   云端形态下身份判据在服务端（`xiai-user-token` 的 `action:'issue'`），本地只落 `userId` 镜像。
   dev / 离线形态（无云写入面）仍走改前的本地形态，并明确标注为非正式路径。 */
import { ensureUserLoginToken } from './userToken.js'

export const DEV_SMS_CODE = '1234'
export const GOLD_INITIAL = 50

export function isPhoneLike(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || '').trim())
}

/** 开发态取码：不发送任何真实短信，直接约定为 1234。 */
export function requestCode(phone) {
  if (!isPhoneLike(phone)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  return { ok: true, message: '驗證碼已發送（開發環境固定爲 1234）' }
}

/**
 * 登录（＝註冊成功路径的**唯一入口**：老账号登录 / 新账号建号 + 初始赠送）。
 *
 * **邀请结算钩（v1.21 新增｜§5.1 ⑦）**：触发时点**恰为「被邀请人註冊成功」** ——
 * 即本函数**新建账号**那一次；调用方可经 `options.inviterId` 提供邀请人用户 id
 * （邀请入口 / 邀请码的形态属 §11 W-23 待裁 ⇒ 本单**只接结算钩、不新增任何邀请入口形态**）。
 * 老账号登录**不触发**结算（不以「邀请人登录」等其它条件触发）。
 *
 * @param {string} phone 手机号
 * @param {string} code 验证码（**云端形态下由服务端判**；dev / 离线形态仍固定 1234）
 * @param {{inviterId?:string}} [options]
 * @returns {Promise<{ok:boolean, user?:object, message?:string, invite?:object, reason?:string}>}
 *
 * **写面 Phase A（2026-09-30）**：本入口由**同步**改为 **`async`**，判定顺序改为：
 *   ① **服务端验证登录（云端形态下的唯一身份判据）**：`ensureUserLoginToken(phone, code)`
 *      ⇒ 云函数 `xiai-user-token` 的 `action:'issue'`（手机号形态 → 验证码 → 签发短 TTL 用户令牌）；
 *      不过门 ⇒ **原样透传结构化拒绝（恰 3 键）＋ 零半成品**（**不建本地账号行、不写 session、不发初始金**）；
 *   ② **dev / 离线形态**（无云写入面）：沿用改前的本地验证码门，**明确标注为非正式路径**；
 *   ③ 过门后才落本地：账号行 / 初始金 / session（**本地库是镜像面**：身份真源在服务端）。
 */
export async function login(phone, code, options = {}) {
  const normalized = String(phone || '').trim()
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  /* ① 服务端验证登录（**云端形态下这是唯一身份判据**；dev / 離線形態返回放行标记 ＋ `mode`）。 */
  const verified = await ensureUserLoginToken(normalized, code)
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, message: verified.message }
  }
  /* ② dev / 離線形態：沿用改前的本地验证码门（**不得**当作正式登录路径）。 */
  if (verified.mode === 'local-dev' && String(code || '').trim() !== DEV_SMS_CODE) {
    return { ok: false, message: '驗證碼不正確' }
  }

  const users = listUserRows()
  let user = users.find((u) => u.phone === normalized)
  let registered = false
  if (!user) {
    /* 管理员手机号（数据层唯一真源 ADMIN_PHONE）建号即为 admin；其余一律普通用户。
       正常路径下数据层引导已按同一常量建好管理员账号，此处仅作兜底。 */
    const isAdminPhone = normalized === ADMIN_PHONE
    user = {
      id: `u-${normalized}`,
      phone: normalized,
      nickname: isAdminPhone ? ADMIN_NICKNAME : `印友${normalized.slice(-4)}`,
      role: isAdminPhone ? 'admin' : 'user',
      points: GOLD_INITIAL,
      created_at: new Date().toISOString()
    }
    saveUserRows([...users, user])
    /* 初始赠送**先于**邀请结算落盘：否则被邀请人的「初始贈送（50 金）」会被
       `grantInitialGold` 的「已有任意流水即不再赠送」判据跳过。 */
    grantInitialGold(user)
    registered = true
  }
  setUser(user)

  const inviterId = options && options.inviterId ? String(options.inviterId) : ''
  const invite = registered && inviterId
    ? settleInviteReward(inviterId, user.id)
    : { ok: true, settled: false, reason: registered ? 'NO_INVITER' : 'NOT_A_REGISTRATION', message: '本次未觸發邀請結算。' }

  return { ok: true, user, invite, registered }
}

export function logout() {
  setUser(null)
  return { ok: true }
}

export function bootstrapSession() {
  return restoreSession((id) => listUserRows().find((u) => u.id === id) || null)
}

export function findUserById(id) {
  return listUserRows().find((u) => u.id === id) || null
}
