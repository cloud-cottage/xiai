/**
 * 全仓**单点**的「模态框 ESC ＝ 取消」实现（2026-11-14 裁定：模态框内按 ESC ＝ 用户取消输入，可退出）。
 * ---------------------------------------------------------------------------
 * 语义：弹窗打开期间监听 `document` 的 keydown；按 ESC ⇒ 等同「取消」——
 *   **关闭弹窗、丢弃未提交的输入、不发任何写请求**。
 *
 * 三条硬口径（缺一条即为实现缺陷）：
 *   ① **只关最上层**（后开先关）：注册表按「打开序号」排序，ESC 只派发给序号最大的那一层；
 *      嵌套弹窗（如「提交勘誤」里再开「提交印人提案」）一次 ESC 只关一个。
 *   ② **busy / submitting 时 ESC 不生效**，且**不向下穿透** —— 提交中按 ESC 不得把底下的弹窗顺手关掉
 *      （那会留下「上层还在提交、下层已消失」的半提交状态）。
 *   ③ **单点实现**：全仓只有本文件判 `event.key === 'Escape'`；各弹窗一律只调本组合式函数，
 *      不得各自再写一份 keydown 判断（否则嵌套时会重复触发、双关）。
 *
 * 用法（弹窗组件里一次即可；组件随 `v-if` 挂载 ⇒ 缺省 `isActive` 恒真）：
 *   useEscToClose({ onCancel: () => emit('close'), isBusy: () => submitting.value })
 * 常驻组件（弹层按需开，如 `PersonPicker` 的选人浮层）：
 *   useEscToClose({ isActive: () => open.value, onCancel: closePicker })
 *
 * 出栈：`isActive` 变假 / 组件卸载 ⇒ 自动注销（不会残留监听、不会把下级弹窗误判成最上层）。
 * 全局只挂一条 `document` 监听（弹窗数量不影响监听数量）；栈空即摘掉监听。
 */

import { onBeforeUnmount, watch } from 'vue'

/** 打开序号（单调递增）：后开者序号更大 ⇒ 更靠上。 */
let openOrder = 0

/** 打开中的弹窗：`序号 → { isBusy, onCancel }`。 */
const openStack = new Map()

/** `document` 监听是否已挂（全仓共用一条）。 */
let listening = false

/** 把「函数 / ref / 布尔」三种形态统一读成 getter（形态不认识 ⇒ 常量 `fallback`）。 */
function asGetter(value, fallback) {
  if (typeof value === 'function') return value
  if (value && typeof value === 'object' && 'value' in value) return () => value.value
  if (typeof value === 'boolean') return () => value
  return () => fallback
}

/** 当前最上层的那一层（栈空 ⇒ `null`）。 */
function topmost() {
  let top = null
  let topId = -1
  for (const [id, entry] of openStack) {
    if (id > topId) {
      top = entry
      topId = id
    }
  }
  return top
}

/**
 * ESC 派发：只作用于**最上层**；该层忙 ⇒ 本次按键整体作废（一层都不关，也不穿透）。
 * @param {KeyboardEvent} event
 */
function handleEscape(event) {
  const top = topmost()
  if (!top) return
  /* 模态框消费了这次按键 ⇒ 拦掉浏览器默认行为，不让它再作用到页面（全屏退出等）。 */
  event.preventDefault()
  if (top.isBusy()) return
  top.onCancel()
}

function onKeydown(event) {
  if (event.key === 'Escape') handleEscape(event)
}

function listen() {
  if (listening || typeof document === 'undefined') return
  /* 捕获阶段：内层输入框 / 组件即便 `stopPropagation` 也拦不住「取消」这条语义。 */
  document.addEventListener('keydown', onKeydown, true)
  listening = true
}

function unlisten() {
  if (!listening || typeof document === 'undefined') return
  document.removeEventListener('keydown', onKeydown, true)
  listening = false
}

/**
 * 模态框 ESC ⇒ 取消（全仓单点入口）。
 * @param {object} options
 * @param {() => void} options.onCancel 取消回调：关闭弹窗、丢弃未提交输入、零写请求。
 * @param {(() => boolean)|{value:boolean}|boolean} [options.isActive] 是否打开（缺省恒真）。
 * @param {(() => boolean)|{value:boolean}|boolean} [options.isBusy] 提交中判据（真 ⇒ ESC 不生效）。
 * @returns {void}
 */
export function useEscToClose({ onCancel, isActive = true, isBusy = false } = {}) {
  const id = ++openOrder
  const readActive = asGetter(isActive, true)
  const readBusy = asGetter(isBusy, false)
  const entry = {
    isBusy: () => !!readBusy(),
    onCancel: () => {
      if (typeof onCancel === 'function') onCancel()
    }
  }

  function register() {
    if (openStack.has(id)) return
    openStack.set(id, entry)
    listen()
  }

  function unregister() {
    if (!openStack.delete(id)) return
    if (openStack.size === 0) unlisten()
  }

  watch(
    readActive,
    () => {
      if (readActive()) register()
      else unregister()
    },
    { immediate: true }
  )

  onBeforeUnmount(unregister)
}
