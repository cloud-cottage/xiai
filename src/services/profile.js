/**
 * 玺爱 · **徽號（用戶暱稱）云端服务层**（本單｜方案 B；**零页面 UI**）
 * ============================================================================
 * 背景：徽號此前只是建号时写进本机 `localStorage` 的系统默认值
 * （`seed.js::ADMIN_NICKNAME='庫守'` / `印友<后四位>`）—— 不在云端、不可编辑、不跨设备。
 * 本单把它升为**云端真源**：新集合 `xiai_user_profiles`（`_id` ＝ 用户 uid，行面封闭 6 键，
 * **不落手机号**、ACL ＝ PRIVATE ⇒ 客户端永不直读）＋ 云函数 `xiai-user-token` 的两个
 * **用户令牌** op（`getProfile` / `updateNickname`）。本文件是**唯一**的业务入口。
 *
 * 硬口径（逐条）：
 *   ① **读写都经既有用户令牌通道**（`userToken.js::userGate` / `userWrite.js::userWriteGate`）
 *      —— 零新鉴权、零新路由；`uid` 由服务端从令牌派生，**前端不发、也不采信任何身份键**；
 *   ② `loadMyProfile()` **失败 / 无行一律不抛错**：失败 ⇒ `{ok:false}`（带服务端原话
 *      `reason` / `message`，形状同仓内降级习惯）；无行 ⇒ `{ok:true, profile:null}`；
 *   ③ `saveMyNickname()` 回包形状同仓内写面习惯：成功 `{ok:true, profile}`、
 *      失败 `{ok:false, reason, message}`（**不自造文案、不新增 reason**）；
 *   ④ `displayNicknameOf(user)` ＝ **徽號上屏名的单点回落链**（页头与将来的账户页**都调它**，
 *      不得两处各写一套）：**云端 `profile.nickname` → 本机 `users` 行 `nickname` → 系统默认**
 *      （`ADMIN_PHONE` ⇒ `ADMIN_NICKNAME`，否则 `印友<后四位>`）；
 *   ⑤ 本机 `users` 行**继续保留**（登录态 / 金 / role 都靠它）—— 云端 profile **只作昵称真源**，
 *      **不得**把 `nickname` 从本机行删掉（回落要用）；本文件对本机行**零写入**。
 */
import { userGate } from './userToken.js'
import { userWriteGate } from './userWrite.js'
import { isLoggedIn } from '../data/session.js'
import { ADMIN_PHONE, ADMIN_NICKNAME } from '../data/seed.js'

/** 服务端 op 名（须与云函数 `cloudfunctions/xiai-user-token/lib/ops.js::OPS` 注册面逐字一致）。 */
export const GET_PROFILE_OP = 'getProfile'

/** 服务端 op 名（同上；**载荷恰一键 `nickname`**）。 */
export const UPDATE_NICKNAME_OP = 'updateNickname'

/**
 * **回包读数键面**（经 `userGate` 第三参 `readoutKeys` 的 additive 通道原样上抛；
 * 与云函数 `index.js` 的按 op 收窄透传真源同字面 —— 服务端未回 ⇒ 本键缺席、不编造）。
 */
export const PROFILE_READOUT_KEYS = Object.freeze(['profile'])

/**
 * **云端徽号缓存（模块级单点）**：只由 `loadMyProfile()` / `saveMyNickname()` 写入；
 * `displayNicknameOf()` 只读它。取不到时**保持原值**（失败不清缓存 —— 「未知」≠「没有」）。
 * @type {{nickname:string, version:number, created_at:string, updated_at:string}|null}
 */
let cachedProfile = null

/**
 * **回包 `profile` 归一**（纯函数）：服务端契约 ＝ `null`（无行）或恰 4 键投影；
 * 形状不可辨（缺席 / 非对象 / `nickname` 非字符串）一律当「无行」⇒ **不编造徽号**。
 * @param {*} value `reply.profile`
 * @returns {{nickname:string, version:number, created_at:string, updated_at:string}|null}
 */
function normalizeProfile(value) {
  if (value === null || typeof value !== 'object') return null
  const nickname = typeof value.nickname === 'string' ? value.nickname : ''
  if (nickname === '') return null
  const version = Number(value.version)
  return {
    nickname,
    version: Number.isFinite(version) ? version : 0,
    created_at: typeof value.created_at === 'string' ? value.created_at : '',
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : ''
  }
}

/** 本机 / 云端两侧同一条「非空文字」判据（回落链只吃真正可上屏的值）。 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * **读云端徽号**（`getProfile`；只读、零写入）。
 *
 * 未登录 ⇒ **不发请求**、回 `{ok:false}`（没有会话就没有可问的身份）；
 * 传输失败 / 服务端结构化拒绝 ⇒ `{ok:false}`（原样带 `reason` / `message`）；
 * 成功 ⇒ `{ok:true, profile}`，`profile` 为 `null`（无行）或恰 4 键 —— **两种都不抛错**。
 * 成功时顺手更新模块缓存（`displayNicknameOf` 的第 1 级来源）。
 * @returns {Promise<{ok:true, profile:object|null}|{ok:false, reason?:string, message?:string}>}
 */
export async function loadMyProfile() {
  if (!isLoggedIn.value) return { ok: false, reason: 'FORBIDDEN', message: '未登錄，無法讀取雲端徽號。' }
  let reply = null
  try {
    /* 载荷**封闭零键**（服务端 `PROFILE_VIEW_ALLOWED_KEYS === []`；身份只从令牌 / 会话派生）。 */
    reply = await userGate(GET_PROFILE_OP, {}, { readoutKeys: PROFILE_READOUT_KEYS })
  } catch {
    /* 传输层异常同样是「没取到」—— 不抛给页面、不动登录态、不清既有缓存。 */
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端徽號暫不可用；本次未讀取。' }
  }
  if (!reply || reply.ok !== true) {
    return {
      ok: false,
      reason: reply && typeof reply.reason === 'string' ? reply.reason : 'STORAGE_UNAVAILABLE',
      message: reply && typeof reply.message === 'string' ? reply.message : '雲端徽號讀取失敗。'
    }
  }
  const profile = normalizeProfile(reply.profile)
  cachedProfile = profile
  return { ok: true, profile }
}

/**
 * **改云端徽号**（`updateNickname`；upsert，服务端 `version` 自增）。
 *
 * 回包形状同仓内写面习惯：成功 `{ok:true, profile}`（服务端回的 4 键投影）；
 * 失败 `{ok:false, reason, message}`（**服务端原话透传，本文件不改写、不新增 reason**）；
 * 传输异常 ⇒ `{ok:false, reason:'STORAGE_UNAVAILABLE', …}`（**绝不伪装 `FORBIDDEN`**）。
 * 成功即更新模块缓存 ⇒ 下一次 `displayNicknameOf` 直接上屏新徽号。
 * @param {string} nickname 新徽号（值域由**服务端**判定：2〜12 字符、零控制字符、无 `<` `>` / `javascript:`）
 * @returns {Promise<{ok:true, profile:object}|{ok:false, reason:string, message:string}>}
 */
export async function saveMyNickname(nickname) {
  let reply = null
  try {
    /* 写面走统一门 `userWriteGate`（先保证有一枚可携带的令牌，再过云端门）。 */
    reply = await userWriteGate(UPDATE_NICKNAME_OP, { nickname }, { readoutKeys: PROFILE_READOUT_KEYS })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端徽號保存失敗；本次未寫入。' }
  }
  if (!reply || reply.ok !== true) {
    return {
      ok: false,
      reason: reply && typeof reply.reason === 'string' ? reply.reason : 'STORAGE_UNAVAILABLE',
      message: reply && typeof reply.message === 'string' ? reply.message : '雲端徽號保存失敗；本次未寫入。'
    }
  }
  const profile = normalizeProfile(reply.profile)
  cachedProfile = profile
  return { ok: true, profile }
}

/**
 * **徽號上屏名的单点回落链**（页头与将来的账户页**都调它**；同步、零网络、绝不抛错）：
 *
 *   ① 云端 `profile.nickname`（`loadMyProfile()` / `saveMyNickname()` 已缓存的真源）；
 *   ② 本机 `users` 行 `nickname`（**继续保留**，作回落；登录态 / 金 / role 仍靠它）；
 *   ③ 系统默认 —— `ADMIN_PHONE` ⇒ `ADMIN_NICKNAME`（`'庫守'`），否则 `印友<后四位>`。
 *
 * 空串 / 纯空白一律视为「没有值」⇒ 逐级下落（**不编造、不返回 `undefined`**）。
 * @param {{nickname?:string, phone?:string}|null} user 本机 `users` 行（`currentUser()`）
 * @returns {string} 上屏名（恒非空）
 */
export function displayNicknameOf(user) {
  const cloud = cachedProfile ? textOf(cachedProfile.nickname) : ''
  if (cloud !== '') return cloud
  const local = user ? textOf(user.nickname) : ''
  if (local !== '') return local
  const phone = user && typeof user.phone === 'string' ? user.phone : ''
  if (phone !== '' && phone === ADMIN_PHONE) return ADMIN_NICKNAME
  return `印友${phone.slice(-4)}`
}

/**
 * **读当前缓存的云端徽号**（只读；供页头等**同步**场景在 `loadMyProfile()` 之后取值）。
 * @returns {{nickname:string, version:number, created_at:string, updated_at:string}|null}
 */
export function myProfile() {
  return cachedProfile
}

/**
 * **fire-and-forget 包装**（登录收尾 / 启动引导用）：失败静默、永不 reject ——
 * 与 `roles.js::refreshMyRole` 同口径（取不到只等于「走第 2 / 3 级回落」）。
 * @returns {Promise<void>}
 */
export function refreshMyProfile() {
  return loadMyProfile()
    .then(() => undefined)
    .catch(() => undefined)
}
