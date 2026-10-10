
<script setup>
import { computed } from 'vue'
import { isLoggedIn } from '../data/session.js'

/**
 * 侧边菜单 —— **恰四项**（璽印匯類 / 印風匯覽 / 印家匯徵 / 我的雲盤）。
 * 顺序**逐字**：`璽印匯類`（`square`）→ `印風匯覽`（`styles`）→ `印家匯徵`（`persons`）
 * → `我的雲盤`（`my-drive`）。glyph 沿用**单字**约定（**不画 SVG**）：`匯` / `風` / `家` / `盤`。
 *
 * 【Slice M1 改版】侧边栏**恰四项**；删去原 `我的勘誤記錄` / `我的實物照片` / `積分中心`
 * **三个侧边栏条目**，但**三条路由**（`/my/corrections` / `/my/photos` / `/points`）
 * **与三个视图文件一律保留**——顶部弹出菜单（`AppHeader.vue` 的 `go('my-corrections')` /
 * `go('my-photos')` / `go('points')`）仍在用它们。**删入口 ≠ 删路由 / 删页面**。
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
  { key: 'square', to: { name: 'square' }, glyph: '匯', label: '璽印匯類' },
  { key: 'styles', to: { name: 'styles' }, glyph: '風', label: '印風匯覽' },
  { key: 'persons', to: { name: 'persons' }, glyph: '家', label: '印家匯徵' },
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
