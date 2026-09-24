<template>
  <div class="container" style="padding-top:80px;padding-bottom:80px;text-align:center;">
    <p class="eyebrow">404</p>
    <h1 style="font-size:32px;letter-spacing:2px;margin-bottom:10px;">页面不存在</h1>
    <p class="note" style="margin-bottom:22px;">
      未匹配到路由 <code class="mono">{{ route.fullPath }}</code>
    </p>
    <div class="modal-acts" style="justify-content:center;">
      <!-- 本页被两个入口的路由表共用：EntryLink 按当前入口 meta.entry 自动选 SPA / 整页跳转（D1） -->
      <EntryLink class="btn sm" to="/">回首页</EntryLink>
      <EntryLink class="btn ghost sm" to="/console/overview">去控制台</EntryLink>
      <EntryLink class="btn ghost sm" to="/pricing">计费规则</EntryLink>
    </div>
  </div>
</template>

<script setup>
import { useRoute } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'

const route = useRoute()
</script>
