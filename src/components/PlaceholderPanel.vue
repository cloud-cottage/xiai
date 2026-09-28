
<script setup>
defineProps({
  glyph: { type: String, default: '印' },
  title: { type: String, required: true },
  desc: { type: String, default: '' }
})
</script>

<template>
  <div class="empty-note">
    <span class="empty-note__mark">{{ glyph }}</span>
    <p class="empty-note__title">{{ title }}</p>
    <p v-if="desc">{{ desc }}</p>
    <slot />
  </div>
</template>
