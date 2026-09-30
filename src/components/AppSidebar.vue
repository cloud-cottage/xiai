
<script setup>
import { computed } from 'vue'
import { isLoggedIn } from '../data/session.js'

/**
 * 侧边菜单 —— **5 项**（璽印匯類 / 我的勘误记录 / 我的实物照片 / 积分中心 / **我的雲盤**）。
 * 第 5 项【我的雲盤】为 v1.21 新增（规范 §3.21.2 / §8.3 收口注（v1.21 追加））：label 逐字
 * 「我的雲盤」、glyph 逐字单字「盤」（既有约定是单字，不画 SVG）、`to` 指向 `/my/drive`。
 * **前 4 项的 label 与顺序逐字未改**。
 *
 * 管理员与普通用户看到**同一套**菜单：管理员的差异体现在页面内的「管理员专属按钮」，
 * 不体现为独立入口（故本组件无需任何角色判断）。
 * 【我的雲盤】是**普通用户能力入口**（不是管理员按钮）⇒ **三态（未登錄 / 普通 / 管理员）
 * 一律渲染**；未登錄点击该项由路由守门重定向 `/login`（带 `redirect`），不静默失败。
 *
 * 页脚文案随登录态切换：登录态按工程既有模式取（`data/session.js` 的 `isLoggedIn`，
 * 与 AppHeader / SquareView / SealDetailView 同一取法，**不另造第三种取法**）。
 */
const logged = isLoggedIn

const items = computed(() => [
  { key: 'square', to: { name: 'square' }, glyph: '廣', label: '璽印匯類' },
  { key: 'my-corrections', to: { name: 'my-corrections' }, glyph: '勘', label: '我的勘誤記錄' },
  { key: 'my-photos', to: { name: 'my-photos' }, glyph: '影', label: '我的實物照片' },
  { key: 'points', to: { name: 'points' }, glyph: '金', label: '積分中心' },
  { key: 'my-drive', to: { name: 'my-drive' }, glyph: '盤', label: '我的雲盤' }
])
</script>

<template>
  <aside class="app-sidebar">
    <div class="app-sidebar__title">覽冊</div>
    <nav class="app-sidebar__nav">
      <router-link
        v-for="item in items"
        :key="item.key"
        class="app-sidebar__item"
        :to="item.to"
        active-class="is-active"
        :exact-active-class="item.key === 'square' ? 'is-active' : ''"
      >
        <span class="app-sidebar__glyph">{{ item.glyph }}</span>
        <span>{{ item.label }}</span>
      </router-link>
    </nav>
    <div class="app-sidebar__foot">
      <p v-if="logged">已登錄｜可提交勘誤、上傳實物照片。</p>
      <p v-else>登錄後可提交勘誤、上傳實物照片；遊客可自由瀏覽印章與印面。</p>
    </div>
  </aside>
</template>
