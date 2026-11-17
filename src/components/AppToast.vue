<script setup>
/**
 * 全站提示条容器（`utils/appToast.js` 的唯一渲染点；在 `App.vue` 挂一次）。
 *
 * 无障碍口径：容器 `role="status"` ＋ `aria-live="polite"` ⇒ 屏幕阅读器会念出
 * 「已退出登錄」这类结果，不依赖视觉留意；`error` 语气另加 `role="alert"`。
 * 渲染层只消费文本，不改字（文案真源在各业务模块）。
 */
import { toastItems, dismissToast } from '../utils/appToast.js'

const items = toastItems()
</script>

<template>
  <div class="app-toast" aria-live="polite" aria-atomic="false" data-app-toast>
    <div
      v-for="item in items"
      :key="item.id"
      class="app-toast__item"
      :class="`app-toast__item--${item.tone}`"
      :role="item.tone === 'error' ? 'alert' : 'status'"
      :data-toast-tone="item.tone"
    >
      <span class="app-toast__text">{{ item.text }}</span>
      <button
        class="app-toast__close"
        type="button"
        aria-label="關閉提示"
        @click="dismissToast(item.id)"
      >×</button>
    </div>
  </div>
</template>

<style scoped>
.app-toast {
  position: fixed;
  left: 50%;
  bottom: var(--s-6);
  z-index: 60; /* 高于路由级失败面（40）与弹窗遮罩，提示条永远压在最上 */
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  width: min(92vw, 420px);
  transform: translateX(-50%);
  pointer-events: none;
}

.app-toast__item {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-3);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-left: 3px solid var(--c-brand);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-2);
  color: var(--c-text);
  font-size: var(--t-sm);
  pointer-events: auto;
}

.app-toast__item--ok {
  border-left-color: var(--c-ok);
}

.app-toast__item--error {
  border-left-color: var(--c-danger);
}

.app-toast__text {
  flex: 1 1 auto;
  white-space: pre-line;
}

.app-toast__close {
  flex: 0 0 auto;
  padding: 0 var(--s-1);
  background: none;
  border: 0;
  color: var(--c-text-muted);
  font-size: var(--t-md);
  line-height: 1;
  cursor: pointer;
}
</style>
