/**
 * 玺爱 · **角色读面（服务端真源）**
 * ============================================================================
 * 背景（Kevin 2026-11-18 裁定）：`sub-admin`（掌書記）是 xiai 侧的**真实身份** —— 它既不是
 * 「普通用户」，也不是 admin 的变体；真源是服务端 `xiai_roles` 行，不是浏览器里的本地镜像。
 *
 * 本文件只做一件事：**问服务端「我是谁」**，把答案并进登录态（只覆盖 `role`）。
 *
 * 硬口径（逐条）：
 *   ① **未登录 ⇒ 不发请求、回 `null`**（没有会话就没有可问的身份）；
 *   ② **失败 / 取不到 ⇒ 回 `null`**（传输失败、`FORBIDDEN`、回包形状不可辨、载荷无角色 …）
 *      —— **绝不在取不到时默认成管理员**，也绝不用手机号在浏览器里自行推断；
 *   ③ **只认服务端已解析的三值**：`admin` / `sub-admin` / `user`；其余一律当「没取到」；
 *   ④ 合法值经数据层 `data/session.js::mergeServerRole` 合并（只改 `role`，不写 localStorage）；
 *   ⑤ **授权零行为**：本文件不判权、不放宽任何门 —— `isAdmin` 仍是逐字 `role === 'admin'`
 *      ⇒ `sub-admin` 拿到的仍是普通用户界面（只是身份文案不同）。
 */
import { userGate } from './userToken.js'
import { isLoggedIn, currentUser, mergeServerRole } from '../data/session.js'

/** 服务端 op 名（`cloudfunctions/xiai-user-token/lib/ops.js::OPS.myRole`，只读、零写入）。 */
export const MY_ROLE_OP = 'myRole'

/** 客户端认得的角色三值（与 `data/roleLabels.js` 的键面同源；表外值一律当「没取到」）。 */
const KNOWN_ROLES = Object.freeze(['admin', 'sub-admin', 'user'])

/**
 * **取当前登录用户在服务端的角色**。
 *
 * 调用前提：已登录（有本机会话且已换取写令牌）。返回的合法值**已经**并进登录态，
 * 调用方通常只需用它做条件渲染；不需要再手动合并。
 *
 * @returns {Promise<'admin'|'sub-admin'|'user'|null>} 取不到 / 未登录 ⇒ `null`
 */
export async function fetchMyRole() {
  /* ① 未登录：零网络、零副作用（**不默认 admin**）。 */
  if (!isLoggedIn.value || !currentUser()) return null
  let reply = null
  try {
    /* 载荷**封闭零键**（服务端 `MY_ROLE_ALLOWED_KEYS === []`；身份只从令牌 / 会话派生）。 */
    reply = await userGate(MY_ROLE_OP, {})
  } catch {
    /* 传输层异常同样是「没取到」——不抛给页面、不影响登录态其余字段。 */
    return null
  }
  /* ② 失败回包（结构化拒绝 / 形状不可辨）⇒ `null`。 */
  if (!reply || reply.ok !== true) return null
  const value = reply.value
  const role = value && typeof value === 'object' ? value.role : ''
  const resolved = typeof role === 'string' ? role.trim() : ''
  /* ③ 表外值 / 空值 ⇒ 当「没取到」，**绝不**回落成 `admin`。 */
  if (KNOWN_ROLES.indexOf(resolved) === -1) return null
  /* ④ 只覆盖 `role`（其余字段逐字保留、不持久化）。 */
  mergeServerRole(resolved)
  return resolved
}

/**
 * **fire-and-forget 包装**（登录收尾 / 启动引导用）：失败静默、永不 reject。
 * 角色到位后由响应式登录态驱动页面重算（组件无需自行轮询）。
 * @returns {Promise<void>}
 */
export function refreshMyRole() {
  return fetchMyRole()
    .then(() => undefined)
    .catch(() => undefined)
}
