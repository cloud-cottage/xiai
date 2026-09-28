<template>
  <div v-if="state === 'loading'" class="state-block" aria-busy="true">
    <span class="spinner" aria-hidden="true"></span>
    <b>加载中…</b>
    <span>{{ loadingText }}</span>
  </div>

  <div v-else-if="state === 'error'" class="state-block error" role="alert">
    <b>{{ errorTitle }}</b>
    <span>{{ errorText }}</span>
    <div v-if="retryLabel" class="modal-acts" style="justify-content:center;">
      <button type="button" @click="$emit('retry')">{{ retryLabel }}</button>
    </div>
  </div>

  <div v-else-if="state === 'empty'" class="state-block">
    <b>{{ emptyTitle }}</b>
    <span>{{ emptyText }}</span>
  </div>

  <slot v-else />
</template>

<script setup>
defineProps({
  /** loading | empty | error | ready */
  state: { type: String, default: 'ready' },
  loadingText: { type: String, default: '正在读取数据…' },
  emptyTitle: { type: String, default: '暂无数据' },
  emptyText: { type: String, default: '' },
  errorTitle: { type: String, default: '读取失败' },
  errorText: { type: String, default: '演示环境：数据源不可用' },
  retryLabel: { type: String, default: '重试' },
})

defineEmits(['retry'])
</script>
