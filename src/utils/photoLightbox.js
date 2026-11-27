/**
 * 实物照片大图（lightbox）的**纯函数边界件** —— 零 DOM / 零 Vue / 零服务依赖。
 * ------------------------------------------------------------------------------
 * 视图层（`components/PhotoLightbox.vue`）与离线自检（`scripts/verify-photo-lightbox.mjs`）
 * **共用同一份实现**：边界口径只此一处，不许在模板里另写一份算式（两处必然漂移）。
 *
 * 口径（本单选定，见回件）：**首尾不循环** —— 首张再「上一张」、末张再「下一张」
 * 一律返回 `-1`（调用方据此禁用按钮 / 忽略方向键），**不回卷**。
 */

/**
 * 求「上一张 / 下一张」的目标下标。
 *
 * @param {number} current 当前下标（0 起；不合法 ⇒ -1）
 * @param {number} total   总张数（<= 0 ⇒ -1）
 * @param {number} step    步长（-1 上一张 / +1 下一张；0 或非整数 ⇒ -1）
 * @returns {number} 合法的下一张下标；**越界（不循环）⇒ -1**
 */
export function neighborIndex(current, total, step) {
  if (!Number.isInteger(total) || total <= 0) return -1
  if (!Number.isInteger(current) || current < 0 || current >= total) return -1
  if (!Number.isInteger(step) || step === 0) return -1
  const next = current + step
  if (next < 0 || next >= total) return -1
  return next
}
