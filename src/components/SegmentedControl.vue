<template>
  <div :class="wrapClass" role="tablist" :aria-label="ariaLabel || undefined">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="String(opt.value === modelValue)"
      :disabled="!!opt.disabled"
      :class="{ 'is-active': opt.value === modelValue }"
      @click="select(opt)"
    >{{ opt.label }}<i v-if="opt.pending"> 即将开放</i></button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** [{ value, label, disabled?, pending? }] */
  options: { type: Array, required: true },
  modelValue: { type: [String, Number], default: '' },
  /** tab=页内标签 / dim=维度切换 / mini=紧凑段控 / chips=按钮组 */
  variant: { type: String, default: 'tab' },
  ariaLabel: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'change'])

const wrapClass = computed(() => ({
  tab: 'subtabs',
  dim: 'dims',
  mini: 'mini-seg',
  chips: 'chips',
}[props.variant] || 'subtabs'))

function select(opt) {
  if (opt.disabled || opt.value === props.modelValue) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
}
</script>
