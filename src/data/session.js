/**
 * 玺爱 · 登录态（内存响应式 + localStorage 持久化）
 *
 * 组件只读这里的状态；所有写入必须经 services 层。
 */

import { reactive, computed } from 'vue'
import { readKey, writeKey, removeKey, STORAGE_KEYS } from './storage.js'

const state = reactive({
  user: null,
  theme: 'a'
})

export function currentUser() {
  return state.user
}

export const isLoggedIn = computed(() => state.user !== null)

export const isAdmin = computed(() => state.user !== null && state.user.role === 'admin')

/* **余额上屏不在这里**（本單）：「金」的展示读数单点是 `services/points.js::displayPoints()`
   （云端权威账本优先 ⇒ 取不到回落本机并标注）。本文件**不再导出**任何余额 computed ——
   留一个就等于给全仓开了第二条回落链；本机 `users` 行的 `points` 仍由服务层（登录态 /
   下载计费）读写，本文件只管 `state.user` 本身。 */

export function setUser(user) {
  state.user = user
  if (user) writeKey(STORAGE_KEYS.session, { userId: user.id })
  else removeKey(STORAGE_KEYS.session)
}

/**
 * **把服务端角色并进当前登录态**（只覆盖 `role` 一个字段，其余键逐字不动）。
 *
 * 背景（Kevin 2026-11-18 裁定）：`sub-admin`（掌書記）是服务端授予的真实身份，真源是
 * `xiai_roles` 行 —— 浏览器本地镜像（`users` 行）只是缓存，**不得**当权威。服务层
 * `services/roles.js::fetchMyRole()` 取到服务端角色后经本函数合并。
 *
 * 硬口径：
 *   · **只认三个已解析值**：`admin` / `sub-admin` / `user`；其余（含 `null` / 空串 /
 *     未知串）**一律不写**（返回当前值）—— 取不到角色 ≠ 提权，也 ≠ 降权；
 *   · 未登录（`state.user === null`）⇒ 原样返回 `null`，零副作用；
 *   · **不持久化**：角色随每次登录 / 启动重新问服务端，不写 localStorage（避免本地成为第二真源）。
 * @param {string|null|undefined} role 服务端解析后的角色值
 * @returns {string|null} 合并后（或原样）的当前角色
 */
export function mergeServerRole(role) {
  if (!state.user) return null
  const next = typeof role === 'string' ? role.trim() : ''
  if (next !== 'admin' && next !== 'sub-admin' && next !== 'user') return state.user.role
  if (state.user.role === next) return next
  /* **只覆盖 `role`**：其余字段（id / phone / nickname / points …）逐字保留。 */
  state.user = { ...state.user, role: next }
  return next
}

export function restoreSession(lookupUserById) {
  const saved = readKey(STORAGE_KEYS.session)
  if (!saved || !saved.userId) return null
  const user = lookupUserById(saved.userId)
  state.user = user || null
  if (!user) removeKey(STORAGE_KEYS.session)
  return state.user
}

export function setTheme(theme) {
  state.theme = theme
  writeKey(STORAGE_KEYS.theme, theme)
  applyThemeToDom(theme)
}

export function restoreTheme() {
  const saved = readKey(STORAGE_KEYS.theme)
  const theme = typeof saved === 'string' ? saved : 'a'
  state.theme = theme
  applyThemeToDom(theme)
  return theme
}

function applyThemeToDom(theme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

export { state as sessionState }
