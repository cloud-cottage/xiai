<template>
  <header class="site">
    <div class="container header-wrap">
      <div>
        <router-link to="/" class="logo">{{ site.name }}</router-link>
        <div class="brand-line">{{ site.tagline }}</div>
      </div>

      <nav class="site-nav" aria-label="主导航">
        <router-link v-for="anchor in anchors" :key="anchor.hash" :to="{ path: '/', hash: anchor.hash }">
          {{ anchor.label }}
        </router-link>
        <router-link v-if="featureFlags.apiDocsOpen !== false" to="/docs">API 文档</router-link>
        <!-- M2 / M3 页面入口：以「即将开放」标记承载，导航结构后续不再变更 -->
        <router-link
          v-for="pending in pendingRoutes"
          :key="pending.to"
          :to="pending.to"
          class="nav-pending"
        >{{ pending.label }}<i>即将开放</i></router-link>

        <!-- 跨入口（营销 → 控制台）：必须整页跳转，见 EntryLink.vue（验收 D1） -->
        <EntryLink to="/console/login" class="acct">机构登录</EntryLink>
        <EntryLink v-if="featureFlags.registerOpen" to="/console/register" class="acct">免费开通</EntryLink>
        <router-link v-else to="/demo" class="acct">申请演示</router-link>
      </nav>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue'
import EntryLink from '@/components/EntryLink.vue'
import { useAppConfig } from '@/composables/useAppConfig.js'

const { config, featureFlags } = useAppConfig()

/** §2.3-5 锚点约定 + 官网既有区块（#1.3 P-M1-01 01-1） */
const anchors = [
  { hash: '#resources', label: '资源总览' },
  { hash: '#tech', label: '图像技术' },
  { hash: '#api', label: 'API 服务' },
  { hash: '#seals', label: '玺印样例' },
  { hash: '#contact', label: '联系咨询' },
]

/** M2/M3 路由入口（占位，AC-02） */
const pendingRoutes = computed(() => {
  const flags = featureFlags.value
  const list = []
  if (flags.orgProfileOpen !== false) list.push({ to: '/org', label: '机构资料' })
  list.push({ to: '/demo', label: '申请演示' })
  if (flags.helpOpen !== false) list.push({ to: '/help', label: '帮助中心' })
  return list
})

const site = computed(() => config.value?.site || { name: '印源', tagline: '兆级玺印数字引擎' })
</script>
