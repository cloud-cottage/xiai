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

export const goldBalance = computed(() => (state.user ? state.user.points : 0))

export function setUser(user) {
  state.user = user
  if (user) writeKey(STORAGE_KEYS.session, { userId: user.id })
  else removeKey(STORAGE_KEYS.session)
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
