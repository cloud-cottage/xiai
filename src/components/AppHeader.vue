
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { currentUser, goldBalance, isLoggedIn } from '../data/session.js'
import { auth } from '../services/index.js'
/* **頁頭單框雙態搜索**（交互重構單）：普通關鍵詞框 ＋ 識別編碼 OTP（首字符判型），
   全站唯一搜索入口；`SquareView` 不再另設獨立 OTP 控件。 */
import HeaderSearch from '../components/HeaderSearch.vue'

const router = useRouter()
const route = useRoute()

/* 只在掛載時帶入一次當前關鍵詞（原行為同此；不與路由做後續雙向同步）。 */
const initialQuery = typeof route.query.q === 'string' ? route.query.q : ''
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

/** 關鍵詞提交（普通態按回車）：維持原 `{ q }` 口徑。 */
function submitKeyword(keyword) {
  router.push({ name: 'square', query: keyword ? { q: keyword } : {} })
}

/** 識別編碼提交（OTP 填滿 / 回車）：**只帶 `code`**（不帶 `q`），由 SquareView 精確查。 */
function submitCode(code) {
  router.push({ name: 'square', query: { code } })
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
      <!-- 單框雙態：普通態＝關鍵詞輸入框；首字符為數字 / 22 字母 ⇒ 就地變 OTP 格。 -->
      <HeaderSearch
        :initial-query="initialQuery"
        @submit-keyword="submitKeyword"
        @submit-code="submitCode"
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
            <!-- **本单改造**：斐萃令牌（管理员签发；入口对已登录用户可见，页内与**服务端**双重判管理员）。 -->
            <button type="button" data-entry="connect-feicui" @click="go('connect-feicui')">斐萃令牌</button>
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
