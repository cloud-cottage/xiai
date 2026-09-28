<template>
  <div>
    <div
      v-for="item in items"
      :key="item.id"
      class="toast show"
      role="status"
      aria-live="polite"
    >{{ item.message }}</div>
  </div>
</template>

<script setup>
import { useToast } from '@/composables/useToast.js'

const { items } = useToast()
</script>
