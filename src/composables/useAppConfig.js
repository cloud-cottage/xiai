/**
 * 站点配置（模块级缓存，含注册开关等配置位；R2：开关态来自配置，页面不得硬编码）。
 */
import { computed, ref } from 'vue'
import { getAppConfig } from '@/data'

const EMPTY_FLAGS = Object.freeze({})

const config = ref(null)
const loading = ref(false)
const error = ref(null)
let promise = null

export function loadAppConfig() {
  if (!promise) {
    loading.value = true
    promise = getAppConfig()
      .then((c) => {
        config.value = c
        return c
      })
      .catch((e) => {
        error.value = e
        return null
      })
      .finally(() => {
        loading.value = false
      })
  }
  return promise
}

export function useAppConfig() {
  return {
    config,
    loading,
    error,
    loadAppConfig,
    featureFlags: computed(() => config.value?.featureFlags || EMPTY_FLAGS),
    site: computed(() => config.value?.site || null),
    demo: computed(() => config.value?.demo || null),
    apiKeyLimit: computed(() => config.value?.apiKeyLimit ?? null),
    notConnectedNotice: computed(() => config.value?.notConnectedNotice || '演示环境：该功能未接入'),
  }
}
