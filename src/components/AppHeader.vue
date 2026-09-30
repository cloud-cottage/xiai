
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { currentUser, goldBalance, isLoggedIn } from '../data/session.js'
import { auth } from '../services/index.js'

const router = useRouter()
const route = useRoute()

const keyword = ref(typeof route.query.q === 'string' ? route.query.q : '')
const menuOpen = ref(false)
const userRef = ref(null)

const user = computed(() => currentUser())
const logged = isLoggedIn
const gold = goldBalance
const avatarGlyph = computed(() => {
  const u = user.value
  if (!u) return '客'
  return u.role === 'admin' ? '守' : '友'
})

function submitSearch() {
  router.push({ name: 'square', query: keyword.value ? { q: keyword.value } : {} })
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function closeMenu() {
  menuOpen.value = false
}

function go(name) {
  closeMenu()
  router.push({ name })
}

function signOut() {
  auth.logout()
  closeMenu()
  router.push({ name: 'square' })
}

function onDocClick(event) {
  if (!menuOpen.value) return
  if (userRef.value && !userRef.value.contains(event.target)) closeMenu()
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <header class="app-header">
    <router-link class="app-header__brand" :to="{ name: 'square' }">
      <span class="app-header__logo-mark">
        <img class="app-header__logo-img" src="/assets/xiai-logo.svg" alt="璽愛" />
      </span>
      <span class="app-header__logo-text">璽愛</span>
    </router-link>

    <div class="app-header__search">
      <input
        v-model="keyword"
        type="search"
        placeholder="搜索印文、作者或藏品編號"
        aria-label="全局搜索"
        @keyup.enter="submitSearch"
      />
    </div>

    <div class="app-header__actions">
      <button class="app-header__icon-btn" type="button" aria-label="消息通知" @click="go('points')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
          <path d="M10 18a2 2 0 0 0 4 0" />
        </svg>
      </button>

      <span v-if="logged" class="app-header__gold">
        <b>{{ gold }}</b><span>金</span>
      </span>

      <div ref="userRef" class="app-header__user">
        <button
          class="app-header__avatar"
          type="button"
          :aria-label="logged ? '賬號菜單' : '登錄'"
          :aria-expanded="menuOpen"
          @click="toggleMenu"
        >
          {{ avatarGlyph }}
        </button>

        <div v-if="menuOpen" class="app-header__menu">
          <div class="app-header__menu-who">
            <template v-if="logged">{{ user.nickname }} · {{ user.phone }}</template>
            <template v-else>尚未登錄</template>
          </div>
          <button v-if="!logged" type="button" @click="go('login')">登錄 / 註冊</button>
          <template v-else>
            <button type="button" @click="go('my-corrections')">我的勘誤記錄</button>
            <button type="button" @click="go('my-photos')">我的實物照片</button>
            <button type="button" @click="go('points')">積分中心</button>
            <button type="button" @click="signOut">退出登錄</button>
          </template>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* 字标位放整张横版 logo（640×400）：取消全局那条 30×30 方形徽章盒约束，改为按高度定尺、宽度自适应。
   仅覆盖尺寸/描边，不碰任何色值或主题变量。 */
.app-header__logo-mark {
  display: block;
  width: auto;
  height: 30px;
  border: 0;
  border-radius: 0;
}

.app-header__logo-img {
  display: block;
  height: 100%;
  width: auto;
}

.app-header__icon-btn {
  color: var(--slot-header-text);
}
</style>
