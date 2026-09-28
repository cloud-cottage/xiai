<template>
  <a v-if="crossEntry" :href="href" rel="noopener"><slot /></a>
  <router-link v-else :to="to"><slot /></router-link>
</template>

<script setup>
/**
 * 跨入口导航链接（spec §2.3-6 / §2.3-8 / §8.5-1）。
 *
 * 根因（M1-P1 验收 D1）：两个入口各有一份 `vue-router` 路由表，互不包含对方前缀
 * （营销入口无 `/console/**`，控制台入口无 `/`、`/pricing`、`/demo`…）。
 * 用 `<router-link>` 跳对方入口的路径时：营销侧被自己的 catch-all 吞掉 → 渲染营销 404 页；
 * 控制台侧干脆无匹配 → 渲染空视图（纯白页）。
 *
 * 纪律：**同入口 → SPA 路由跳转**（保留 history 语义）；**跨入口 → 普通 `<a href>` 整页跳转**
 * （与 §8.5-1 控制台侧栏 `/docs`、`/help` 同域整页跳转同一纪律）。
 * 生产部署需在网关做同构改写（`/console/**` → console.html，其余 → index.html），见 README。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const props = defineProps({
  /** 目标路径：字符串（可含 `?query#hash`）或 vue-router 的 location 对象。 */
  to: { type: [String, Object], required: true },
})

const route = useRoute()

const targetPath = computed(() => (typeof props.to === 'string' ? props.to : props.to.path || '/'))

/** 当前入口由路由 meta.entry 决定（营销路由表 → marketing，控制台路由表 → console）。 */
const currentEntry = computed(() => (route.meta?.entry === 'console' ? 'console' : 'marketing'))
const targetEntry = computed(() => (targetPath.value.startsWith('/console') ? 'console' : 'marketing'))

/** 跨入口（目标前缀不属于本入口）→ 必须整页跳转，否则被本入口 catch-all 吞掉。 */
const crossEntry = computed(() => targetEntry.value !== currentEntry.value)

const href = computed(() => {
  const t = props.to
  if (typeof t === 'string') return t
  const query = t.query && Object.keys(t.query).length
    ? '?' + new URLSearchParams(t.query).toString()
    : ''
  return `${t.path || '/'}${query}${t.hash || ''}`
})
</script>
