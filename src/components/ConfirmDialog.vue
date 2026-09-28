
<script setup>
defineProps({
  title: { type: String, required: true },
  message: { type: String, default: '' },
  detail: { type: String, default: '' },
  hint: { type: String, default: '' },
  confirmText: { type: String, default: '確定' },
  cancelText: { type: String, default: '取消' }
})

const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <div class="confirm-mask" role="dialog" aria-modal="true" :aria-label="title">
    <div class="confirm-box">
      <h3 class="confirm-box__title">{{ title }}</h3>
      <p v-if="message" class="confirm-box__message">{{ message }}</p>
      <p v-if="detail" class="confirm-box__detail">{{ detail }}</p>
      <p v-if="hint" class="confirm-box__hint">{{ hint }}</p>
      <div class="confirm-box__foot">
        <button class="btn btn--ghost" type="button" @click="emit('cancel')">{{ cancelText }}</button>
        <button class="btn btn--primary" type="button" @click="emit('confirm')">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
}

.confirm-box {
  width: 100%;
  max-width: 420px;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.confirm-box__title {
  margin-bottom: var(--s-3);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.confirm-box__message {
  color: var(--c-text);
  font-size: var(--t-md);
}

.confirm-box__detail {
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.confirm-box__hint {
  margin-top: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.confirm-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-5);
}
</style>
