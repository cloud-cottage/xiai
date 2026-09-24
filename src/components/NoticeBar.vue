<template>
  <div :class="barClass" :role="role">
    <b v-if="title">{{ title }}</b>
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** banner=常规提示 / status=状态条 / warn=警示 / tip=小贴士 / disclaimer=声明 */
  variant: { type: String, default: 'banner' },
  title: { type: String, default: '' },
})

const barClass = computed(() => {
  const map = { banner: 'banner', status: 'statusbar', warn: 'warn-line', tip: 'tip', disclaimer: 'disclaimer' }
  return map[props.variant] || 'banner'
})

const role = computed(() => (props.variant === 'warn' ? 'alert' : null))
</script>
