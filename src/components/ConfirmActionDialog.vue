<script setup>
/**
 * 一次性確認彈窗（**帶提交中禁用**）—— 詳情頁兩處管理員寫面（整枚印章圖刪除 / 切換 base face）共用。
 *
 * 為什麼另立一個（而不是改 `ConfirmDialog`）：`ConfirmDialog` 是**凍結形態**的既有共用件
 * （本單寫集不含它），而這兩處寫面要求「提交中禁用」＋「一次性提交守衛」 ⇒ 另立一個**只增不改**的
 * 小彈窗：`role="dialog"` ＋ `aria-label` 形態與 `ConfirmDialog` 同款，按鈕只用 `data-action`
 * （**不掛** `data-admin-action`，該族取值集合已凍結）。
 *
 * 守衛分工：
 *   · 本組件只負責**視覺 / 可用態**（`busy` ⇒ 兩鈕皆 `disabled`、確認文案切換為 `busyText`）；
 *   · **一次性提交守衛**在調用方的 `confirm` 處理裡（`if (busy) return`）—— 這是唯一可靠的位置
 *     （按鈕 `disabled` 不是原子門）。
 */
defineProps({
  title: { type: String, required: true },
  /* 無障礙名（缺省回落 `title`）：`aria-label` 必須是完整可讀的動作名。 */
  ariaLabel: { type: String, default: '' },
  message: { type: String, default: '' },
  detail: { type: String, default: '' },
  hint: { type: String, default: '' },
  confirmText: { type: String, default: '確定' },
  cancelText: { type: String, default: '取消' },
  /* 提交中確認鈕文案（缺省 ⇒ 沿用 `confirmText`）。 */
  busyText: { type: String, default: '' },
  /* 可选：确认 / 取消按钮的 `data-action` 取证钩子（缺省 ⇒ 不渲染该属性）。 */
  confirmAction: { type: String, default: '' },
  cancelAction: { type: String, default: '' },
  /* 提交中 ⇒ 兩鈕皆禁用（防重複提交；文案切到 `busyText`）。 */
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <div class="confirm-action-mask" role="dialog" aria-modal="true" :aria-label="ariaLabel || title">
    <div class="confirm-action-box">
      <h3 class="confirm-action-box__title">{{ title }}</h3>
      <p v-if="message" class="confirm-action-box__message">{{ message }}</p>
      <p v-if="detail" class="confirm-action-box__detail">{{ detail }}</p>
      <p v-if="hint" class="confirm-action-box__hint">{{ hint }}</p>
      <slot />
      <div class="confirm-action-box__foot">
        <button
          class="btn btn--ghost"
          type="button"
          :disabled="busy"
          :data-action="cancelAction || null"
          @click="emit('cancel')"
        >
          {{ cancelText }}
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="busy"
          :data-action="confirmAction || null"
          @click="emit('confirm')"
        >
          {{ busy && busyText ? busyText : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-action-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
}

.confirm-action-box {
  width: 100%;
  max-width: 460px;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.confirm-action-box__title {
  margin-bottom: var(--s-3);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.confirm-action-box__message {
  color: var(--c-text);
  font-size: var(--t-md);
}

.confirm-action-box__detail {
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.confirm-action-box__hint {
  margin-top: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.confirm-action-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-5);
}
</style>
