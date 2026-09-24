/**
 * 统一异步态（loading / empty / error / ready）—— 供 §1.6「三态」要求复用。
 * 所有数据读取都必须经适配层方法，因此统一走这里发起。
 */
import { computed, ref, shallowRef } from 'vue'

export function useAsync(loader, options = {}) {
  const data = shallowRef(null)
  const loading = ref(false)
  const error = ref(null)
  let runId = 0

  async function run(...args) {
    const id = ++runId
    loading.value = true
    error.value = null
    try {
      const result = await loader(...args)
      if (id === runId) data.value = result
      return result
    } catch (e) {
      if (id === runId) {
        error.value = e
        data.value = null
      }
      return null
    } finally {
      if (id === runId) loading.value = false
    }
  }

  const state = computed(() => {
    if (loading.value) return 'loading'
    if (error.value) return 'error'
    const value = data.value
    if (value === null || value === undefined) return 'empty'
    if (Array.isArray(value) && value.length === 0) return 'empty'
    if (typeof value === 'object' && 'items' in value && Array.isArray(value.items) && value.items.length === 0) return 'empty'
    return 'ready'
  })

  if (options.immediate) run()

  return { data, loading, error, run, state }
}
