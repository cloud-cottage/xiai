<template>
  <div class="app-marketing">
    <MarketingHeader />
    <main>
      <router-view />
    </main>
    <MarketingFooter />
    <ToastHost />
  </div>
</template>

<script setup>
import MarketingHeader from '@/components/MarketingHeader.vue'
import MarketingFooter from '@/components/MarketingFooter.vue'
import ToastHost from '@/components/ToastHost.vue'
</script>
