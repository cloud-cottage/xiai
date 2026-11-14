<script setup>
/**
 * 管理员角标（唯一实现）—— 裁定件 docs/admin-button-styling-ruling-2026-11-14.md。
 *
 * 用途：只挂在「`v-if` 门来自管理员判定」的按钮上（配合 `.btn--admin` 的虚线边框），
 * 让管理员专属入口与普通用户按钮**从形状上**（虚线轮廓 ＋ 锁形符号）区分开。
 *
 * 硬约束（照裁定件逐条）：
 *   · `position: absolute` 于右上角（出界 `-4px`）⇒ **不进盒模型**：按钮宽高 / 内边距 /
 *     圆角逐像素不变（父元素 `.btn--admin` 提供 `position: relative`）；
 *   · 内容为内联 SVG 小锁（约 10–12px），`aria-hidden="true"`（语义交给按钮的
 *     `title` / `aria-label` 承担，读屏不会把「圖」念进按钮名）；
 *   · 颜色一律取既有令牌（描边用 `currentColor` ⇒ 跟随按钮文字色；底用 `--c-surface`），
 *     不引入任何新颜色字面量 ⇒ 三套主题（a/b/c）自适应；
 *   · 无交互：`pointer-events: none`（角标不吃点击，按钮可点区域不变）。
 */
</script>

<template>
  <span class="admin-badge" aria-hidden="true">
    <svg class="admin-badge__icon" viewBox="0 0 12 12" fill="none" focusable="false">
      <!-- 锁梁 -->
      <path
        d="M4.1 5.05V3.85a1.9 1.9 0 0 1 3.8 0v1.2"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
      <!-- 锁身 -->
      <rect
        x="2.6"
        y="5.05"
        width="6.8"
        height="4.6"
        rx="1"
        stroke="currentColor"
        stroke-width="1.3"
      />
    </svg>
  </span>
</template>

<style scoped>
.admin-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: var(--r-round);
  background: var(--c-surface);
  color: var(--slot-btn-ghost-text);
  line-height: 0;
  pointer-events: none;
}

.admin-badge__icon {
  display: block;
  width: 10px;
  height: 10px;
}
</style>
