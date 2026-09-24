<template>
  <footer class="site">
    <div class="container">
      <div>{{ site.footerLine || '印源 © 2026 兆级玺印数字引擎｜文博玺印 API 图像服务平台' }}</div>
      <div class="footer-links">
        <!-- 统一走 EntryLink：同入口 → SPA 路由跳转，跨入口（如 /console/login）→ 整页跳转（验收 D1） -->
        <EntryLink v-for="link in links" :key="link.to" :to="link.to">{{ link.label }}</EntryLink>
      </div>
      <div class="disclaimer" style="margin-top:8px;">
        {{ disclaimer }} · 时间均为北京时间（CST）
      </div>
    </div>
  </footer>
</template>

<script setup>
import { computed } from 'vue'
import EntryLink from '@/components/EntryLink.vue'
import { useAppConfig } from '@/composables/useAppConfig.js'
import { PRICING } from '@/config/pricing.js'

const { config } = useAppConfig()
const site = computed(() => config.value?.site || {})
/** 全站声明文案的唯一来源（spec §1.6 全局声明条 / §4.3）。 */
const disclaimer = PRICING.disclaimer

const links = [
  { to: '/pricing', label: '计费规则' },
  { to: '/docs', label: 'API 文档' },
  { to: '/org', label: '机构资料' },
  { to: '/demo', label: '申请演示' },
  { to: '/help', label: '帮助中心' },
  { to: '/console/login', label: '机构登录' },
]
</script>
