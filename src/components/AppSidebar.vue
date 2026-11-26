
<script setup>
import { computed } from 'vue'
import { isAdmin, isLoggedIn } from '../data/session.js'

/**
 * 侧边菜单 —— `璽印匯類` / `印風匯覽` / `印家匯徵` → **（管理员）`印譜匯觀`** → `我的名刺` → `我的雲盤`。
 * 顺序**逐字**：`璽印匯類`（`square`）→ `印風匯覽`（`styles`）→ `印家匯徵`（`persons`）
 * → `我的名刺`（`me`，**三态一律渲染**，本單新增）→ `我的雲盤`（`my-drive`）。glyph 沿用**单字**约定（**不画 SVG**）：`匯` / `風` / `家` / `譜` / `刺` / `盤`。
 *
 * 【印譜匯觀】（2026-11-14 裁定｜`docs/book-catalog-ruling-2026-11-14.md` §二）
 *   · 该条**仅管理员可见**：非管理员 / 未登录 ⇒ **整条不渲染**（`items` 里根本没有这一项
 *     ⇒ DOM 零命中；**不得** `disabled` / CSS 隐藏 / 空链接冒充）。判定取法与 AppHeader /
 *     SquareView 同一处（`data/session.js` 的 `isAdmin` 计算属性），不另造第三种取法。
 *   · 位置**在 `my-drive` 之前**（菜单第 4 项）。
 *
 * 【Slice M1 改版】侧边栏原有四项；删去原 `我的勘誤記錄` / `我的實物照片` / `積分中心`
 * **三个侧边栏条目**，但**三条路由**（`/my/corrections` / `/my/photos` / `/points`）
 * **与三个视图文件一律保留**——顶部弹出菜单（`AppHeader.vue` 的 `go('my-corrections')` /
 * `go('my-photos')` / `go('points')`）仍在用它们。**删入口 ≠ 删路由 / 删页面**。
 *
 * 除【印譜匯觀】与【梓行匯溯】（本單新增，**两条皆管理员专属**）外，管理员与普通用户看到
 * **同一套**菜单：管理员的差异主要体现在页面内的「管理员专属按钮」，不体现为独立入口。
 * 该管理员入口的可见性**只**作用于它自己这一项。
 * 【我的雲盤】是**普通用户能力入口**（不是管理员按钮）⇒ **三态（未登錄 / 普通 / 管理员）
 * 一律渲染**；未登錄点击该项由路由守门重定向 `/login`（带 `redirect`），不静默失败。
 *
 * 页脚文案随登录态切换：登录态按工程既有模式取（`data/session.js` 的 `isLoggedIn`，
 * 与 AppHeader / SquareView / SealDetailView 同一取法，**不另造第三种取法**）。
 */
const logged = isLoggedIn

const items = computed(() => {
  const list = [
    { key: 'square', to: { name: 'square' }, glyph: '匯', label: '璽印匯類' },
    { key: 'styles', to: { name: 'styles' }, glyph: '風', label: '印風匯覽' },
    { key: 'persons', to: { name: 'persons' }, glyph: '家', label: '印家匯徵' }
  ]
  /* 【印譜匯觀】（管理员专属）：非管理员 / 未登录 ⇒ push 不执行 ⇒ 该项**零渲染**。 */
  if (isAdmin.value) {
    list.push({ key: 'books', to: { name: 'books' }, glyph: '譜', label: '印譜匯觀' })
    /* 【梓行匯溯】（本單｜xiai.spec §3.107）：同样**仅管理员可见**，判定取法仍是同一处
       `data/session.js` 的 `isAdmin`（**不另造第二种取法**）；位置在 `books` 之后、`my-drive` 之前。
       **条件 push（不在上面的基础数组里）** ⇒ 基础四项的结构面一字不动。 */
    list.push({ key: 'publishers', to: { name: 'publishers' }, glyph: '梓', label: '梓行匯溯' })
  }
  /* 【我的名刺】（本單｜`/me`）：**普通用户能力入口**（徽號是用户自己的东西，不是管理员
     专属）⇒ 三态一律渲染，**不进上面的 `isAdmin` 块**；位置在 `my-drive` 之前。 */
  list.push({ key: 'me', to: { name: 'me' }, glyph: '刺', label: '我的名刺' })
  list.push({ key: 'my-drive', to: { name: 'my-drive' }, glyph: '盤', label: '我的雲盤' })
  return list
})
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
