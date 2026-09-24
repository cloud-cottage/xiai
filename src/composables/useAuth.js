/**
 * 会话状态（模块级单例，两个入口各自独立；会话经适配层 sessionStorage 持久化，可跨入口共享）。
 * 页面不得直接 import mock：只经 '@/data' 的 A2/A3/A4 方法。
 */
import { computed, ref } from 'vue'
import { getSession, login as adapterLogin, logout as adapterLogout, register as adapterRegister } from '@/data'

const EMPTY_FLAGS = Object.freeze({})

const user = ref(null)
const loading = ref(false)
const initialized = ref(false)
let bootPromise = null

/** 首次导航前解析一次会话（含 §8.3-4 的人工延迟），后续复用同一 Promise。 */
export function ensureSession(force = false) {
  if (force || !bootPromise) {
    loading.value = true
    bootPromise = getSession()
      .then((u) => {
        user.value = u
        return u
      })
      .catch(() => {
        user.value = null
        return null
      })
      .finally(() => {
        initialized.value = true
        loading.value = false
      })
  }
  return bootPromise
}

export function useAuth() {
  return {
    user,
    loading,
    initialized,
    isAuthenticated: computed(() => !!user.value),
    planId: computed(() => user.value?.planId || null),
    featureFlags: computed(() => user.value?.featureFlags || EMPTY_FLAGS),
    ensureSession,
    async signIn(account, password) {
      const result = await adapterLogin(account, password)
      user.value = result.user
      bootPromise = Promise.resolve(result.user)
      initialized.value = true
      return result
    },
    async signUp(input) {
      const result = await adapterRegister(input)
      user.value = result.user
      bootPromise = Promise.resolve(result.user)
      initialized.value = true
      return result
    },
    async signOut() {
      await adapterLogout()
      user.value = null
      bootPromise = Promise.resolve(null)
    },
  }
}
