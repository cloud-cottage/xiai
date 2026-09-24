<template>
  <div class="app-console">
    <router-view />
    <ToastHost />
  </div>
</template>

<script setup>
import ToastHost from '@/components/ToastHost.vue'
</script>
