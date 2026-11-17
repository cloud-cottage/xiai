/**
 * 玺爱 · **全站轻量提示条（toast）的单点**
 * ============================================================================
 * 为什么要它：退出登錄的**成功反馈必须明确可见** —— 成功后弹出菜单立刻收起、
 * 页头也回到「尚未登錄」，如果只在原按钮处换字，用户看不到任何确认（Kevin 报的
 * 「点了退出，页面没有已经退出的操作反馈」正是这个缺口）。
 *
 * 只做一件事：把一条文本 × 一个语气（`ok` / `error` / `info`）挂到全局队列，
 * 由 `components/AppToast.vue` 渲染。**不引入任何依赖、不写存储、不打日志。**
 *
 * 硬口径：
 *   · 空文本 ⇒ 不入队（不制造空白提示条）；
 *   · 同文本连点 ⇒ 复用同一条（不刷屏；比的是**文本 + 语气**）；
 *   · 队列上限 `TOAST_MAX` 条，超出挤掉最早的；
 *   · 自动关闭由 `TOAST_TIMEOUT_MS` 决定，也可点关闭 / `dismissToast(id)`。
 */

import { reactive } from 'vue'

/** 持续可见时长（毫秒）：够读完一句「已退出登錄」，又不至于挡着页面。 */
export const TOAST_TIMEOUT_MS = 3600

/** 同时在屏的最大条数（超出挤掉最早的）。 */
export const TOAST_MAX = 3

/** 封闭语气取值（渲染只认这三个；未知值按 `info`）。 */
export const TOAST_TONES = ['ok', 'error', 'info']

const state = reactive({ items: [] })
let seq = 0

/** 当前提示条（只读视图；组件 v-for 直接消费）。 */
export function toastItems() {
  return state.items
}

/**
 * 关闭一条（不存在 ⇒ 静默，幂等）。
 * @param {string} id
 */
export function dismissToast(id) {
  const index = state.items.findIndex((item) => item.id === id)
  if (index >= 0) state.items.splice(index, 1)
}

/** 清空（自检 / 路由级重置用）。 */
export function clearToasts() {
  state.items.splice(0, state.items.length)
}

/**
 * 推一条提示。
 * @param {string} message 上屏文本（调用方负责文案，本模块不改字）
 * @param {'ok'|'error'|'info'} [tone]
 * @param {{timeoutMs?: number}} [options]
 * @returns {string} 该条 id；空文本 ⇒ `''`（不入队）
 */
export function pushToast(message, tone = 'info', options = {}) {
  const text = String(message === undefined || message === null ? '' : message).trim()
  if (text === '') return ''
  const kind = TOAST_TONES.includes(tone) ? tone : 'info'
  const existing = state.items.find((item) => item.text === text && item.tone === kind)
  if (existing) return existing.id
  const id = `toast-${++seq}`
  state.items.push({ id, text, tone: kind })
  if (state.items.length > TOAST_MAX) state.items.splice(0, state.items.length - TOAST_MAX)
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TOAST_TIMEOUT_MS
  if (typeof setTimeout === 'function') {
    const timer = setTimeout(() => dismissToast(id), timeoutMs)
    /* node（自检）下别让定时器吊住进程；浏览器里没有 `unref`，走原样。 */
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  return id
}
