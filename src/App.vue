<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import AppSidebar from './components/AppSidebar.vue'

const route = useRoute()
const isBare = computed(() => route.meta.bare === true)
</script>

<template>
  <div v-if="isBare" class="app-shell">
    <main class="app-body">
      <router-view />
    </main>
  </div>

  <div v-else class="app-shell">
    <AppHeader />
    <div class="app-body">
      <AppSidebar />
      <main class="app-main">
        <div class="app-main__inner">
          <router-view />
        </div>
      </main>
    </div>
  </div>
</template>
