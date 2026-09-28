/**
 * 轻量 toast（模块级单例，由各入口的 <ToastHost /> 渲染）。
 * 对应 v1 的 .toast 样式；未接入后端的功能统一提示见 APP_CONFIG.notConnectedNotice。
 */
import { ref } from 'vue'

const items = ref([])
let seq = 0
let timer = null

export function toast(message, options = {}) {
  if (!message) return null
  const id = ++seq
  items.value = [{ id, message, variant: options.variant || 'default' }]
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    items.value = []
  }, options.duration || 2600)
  return id
}

/** 未接入后端的操作统一提示（spec §1.3 交互 3 / AC-07）。 */
export function toastNotConnected(message) {
  return toast(message || '演示环境：该功能未接入')
}

export function clearToast() {
  items.value = []
}

export function useToast() {
  return { items, toast, toastNotConnected, clearToast }
}
