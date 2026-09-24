<template>
  <figure class="seal" :class="[styleClass, sizeClass]">
    <span v-if="badge" class="ph-badge">图占位</span>
    <div class="seal-face">
      <div v-for="(col, ci) in columns" :key="ci" class="seal-col">
        <span v-for="(ch, i) in col" :key="i">{{ ch }}</span>
      </div>
    </div>
  </figure>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** 印面文字，最多 4 个字符（2 列 × 2 行） */
  text: { type: String, default: 'XX之印' },
  /** BAI_WEN 白文（黑字白底） / ZHU_WEN 朱文（红字透明底 + 虚线边） */
  style: { type: String, default: 'BAI_WEN' },
  /** md | tiny */
  size: { type: String, default: 'md' },
  badge: { type: Boolean, default: true },
})

const styleClass = computed(() => (props.style === 'ZHU_WEN' ? 'seal-zhu' : 'seal-bai'))
const sizeClass = computed(() => (props.size === 'tiny' ? 'seal-tiny' : ''))

const columns = computed(() => {
  const chars = [...String(props.text || '')].slice(0, 4)
  if (!chars.length) return [['X']]
  if (chars.length <= 2) return [chars]
  const half = Math.ceil(chars.length / 2)
  return [chars.slice(0, half), chars.slice(half)]
})
</script>
