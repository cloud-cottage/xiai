
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { currentUser, goldBalance, isLoggedIn } from '../data/session.js'
/* **徽號上屏名的单点派生**（本單）：页头昵称一律经 `services.profile.displayNicknameOf(user)`
   （回落链全仓唯一处），模板不写 `user.nickname`、也不自造第二套回落。 */
import { services } from '../services/index.js'
/* **退出登錄三態**（進行中 / 成功 / 失敗）與提示條：與登錄頁共用同一份壳与同一份文案。 */
import { useLogout } from '../utils/useLogout.js'
/* **頁頭單框雙態搜索**（交互重構單）：普通關鍵詞框 ＋ 識別編碼 OTP（首字符判型），
   全站唯一搜索入口；`SquareView` 不再另設獨立 OTP 控件。 */
import HeaderSearch from '../components/HeaderSearch.vue'
/* **身份标记**（徽号那一行，昵称之后、手机号 `·` 之前）：`admin` / `sub-admin` 才渲染，
   普通用户**零渲染**；只做展示，不参与任何判定。 */
import RoleMark from '../components/RoleMark.vue'
/* **【掌書記引】上屏名的单点取字**（本單）：字面在 `data/roleLabels.js`（身份词单一真源），
   页头**零字面复制** —— 模板一律插值 `ADMIN_GUIDE_LABEL`。 */
import { ADMIN_GUIDE_LABEL } from '../data/roleLabels.js'

const router = useRouter()
const route = useRoute()

/* 只在掛載時帶入一次當前關鍵詞（原行為同此；不與路由做後續雙向同步）。 */
const initialQuery = typeof route.query.q === 'string' ? route.query.q : ''
const menuOpen = ref(false)
/* 【掌書記引】下拉态：**与头像菜单各自独立**（互不共用 ref），点开一个必关另一个。 */
const guideOpen = ref(false)
const userRef = ref(null)
const guideRef = ref(null)

/* 頁頭 logo 在 `public/assets/` 下（**不是** import 的資源）：模板裡寫死的絕對 src
   不會被 Vite 改寫（`@vitejs/plugin-vue` 的 `transformAssetUrls.includeAbsolute` 恒 false）
   ⇒ 子路径下必须手工补 `BASE_URL`（`/xiai/`，与 `vite.config.js::base` 同源）。 */
const logoUrl = `${import.meta.env.BASE_URL}assets/xiai-logo.svg`

const user = computed(() => currentUser())
const logged = isLoggedIn
const gold = goldBalance
/**
 * **徽號上屏名的单点派生**：只在这里取一次，模板里不再调用、也不写第二套回落。
 *
 * 服务层 `displayNicknameOf()` 读的是**模块级缓存**（非响应式）⇒ 云端读数回来时本
 * computed 不会自动重算，故用一个只读信号 `profileTick` 触发（**只触发重算，
 * 不参与回落**）：登录后 / 保存后 `loadMyProfile()` 完成时 +1。
 */
const profileTick = ref(0)
const displayName = computed(() => {
  void profileTick.value
  return services.profile.displayNicknameOf(user.value)
})
/* 退出的三态：`logoutView.label`（`退出登錄` / `正在退出…`）、`logoutView.disabled`、
   `logoutError`（`退出失敗：…`，就地显示在菜单里）。 */
const {
  error: logoutError,
  view: logoutView,
  signOut: runLogout
} = useLogout()
const avatarGlyph = computed(() => {
  const u = user.value
  if (!u) return '客'
  return u.role === 'admin' ? '守' : '友'
})
/* **【掌書記引】入口的可见性（单点）**：判定收在服务层 `services.admin.isAdminSession()`
   （掌書記使＝`admin`），页头**不自写任何角色字面**；非掌書記使 / 无会话 ⇒ `false`
   （该图标与下拉**零渲染、不占位**，与铃铛 / 金同一形态）。 */
const adminGuide = computed(() => services.admin.isAdminSession())

/** 關鍵詞提交（普通態按回車）：維持原 `{ q }` 口徑。 */
function submitKeyword(keyword) {
  router.push({ name: 'square', query: keyword ? { q: keyword } : {} })
}

/** 識別編碼提交（OTP 填滿 / 回車）：**只帶 `code`**（不帶 `q`），由 SquareView 精確查。 */
/**
 * 頁頭 OTP 提交（2026-11-15 起兩類）：
 *   · **9 位純數字 ⇒ 印人號**（CARD 人物號，如 `100000159`）⇒ 直跳印人詳情 `/persons/:code`；
 *   · 其餘（5 位印章碼 / 8 位面碼）⇒ 走 `square` 頁的 `?code=` 精確查（既有鏈路不變）。
 * 不存在的印人號不在這裡攔：詳情頁按 CARD 主庫查，查無即由該頁明示「查無此人」（不編造假頁）。
 */
function submitCode(code) {
  const raw = String(code === undefined || code === null ? '' : code).trim()
  if (/^\d{9}$/.test(raw)) {
    router.push({ name: 'personDetail', params: { code: raw } })
    return
  }
  router.push({ name: 'square', query: { code: raw } })
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  /* 两菜单**互斥**：点开头像菜单 ⇒ 同步关掉【掌書記引】下拉（各自独立、互不干扰）。 */
  if (menuOpen.value) guideOpen.value = false
}

function closeMenu() {
  menuOpen.value = false
}

function toggleGuide() {
  guideOpen.value = !guideOpen.value
  if (guideOpen.value) menuOpen.value = false
}

function closeGuide() {
  guideOpen.value = false
}

function go(name) {
  /* 切路由 ⇒ 两个下拉一并关（与原头像菜单同款：导航即收）。 */
  closeMenu()
  closeGuide()
  router.push({ name })
}

function signOut() {
  /* **三态退出**（`utils/useLogout.js` 单点）：进行中换字禁用 → 成功上屏「已退出登錄」
     ＋ 关菜单 ＋ 回广场（未登錄态：头像/菜单/管理员入口全部随 `session.js` 回到游客）→
     失败保留会话、就地上屏原因并可重试。 */
  return runLogout({
    onSignedOut: () => {
      closeMenu()
      closeGuide()
      return router.push({ name: 'square' })
    }
  })
}

function onDocClick(event) {
  /* 两个下拉各自判「点在外面」：点头像菜单区域 ⇒ 只关自己，不碰【掌書記引】（反之亦然）。 */
  if (menuOpen.value && userRef.value && !userRef.value.contains(event.target)) closeMenu()
  if (guideOpen.value && guideRef.value && !guideRef.value.contains(event.target)) closeGuide()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  /* **登录后补读一次云端徽号**（只一次；`AppHeader` 全站只挂载一次）：失败静默、
     不阻塞渲染、不弹错误 —— 取不到只等于走第 2 / 3 级回落（`displayNicknameOf`）。 */
  if (logged.value) {
    services.profile
      .loadMyProfile()
      .then(() => {
        profileTick.value += 1
      })
      .catch(() => {})
  }
})
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <header class="app-header">
    <router-link class="app-header__brand" :to="{ name: 'square' }">
      <span class="app-header__logo-mark">
        <img class="app-header__logo-img" :src="logoUrl" alt="璽愛" />
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
      <!-- 【掌書記引】（本單新增）：圆形 icon-btn（与铃铛同形制、单字 glyph `引`、不画 SVG）；
           仅掌書記使（`services.admin.isAdminSession()`）渲染 ⇒ 非掌書記使 / 游客零占位。 -->
      <div v-if="adminGuide" ref="guideRef" class="app-header__guide">
        <button
          class="app-header__icon-btn"
          type="button"
          :aria-label="ADMIN_GUIDE_LABEL"
          :title="ADMIN_GUIDE_LABEL"
          data-admin-guide
          :aria-expanded="guideOpen"
          @click="toggleGuide"
        >引</button>
        <!-- 下拉：复用页头既有菜单视觉类 `.app-header__menu`（同一套变量，不新建色值）；
             **恰一项**「梓行匯溯」。 -->
        <div v-if="guideOpen" class="app-header__menu" data-admin-guide-menu>
          <button type="button" @click="go('publishers')">梓行匯溯</button>
        </div>
      </div>

      <button class="app-header__icon-btn" type="button" aria-label="消息通知" @click="go('points')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
          <path d="M10 18a2 2 0 0 0 4 0" />
        </svg>
      </button>

      <!-- 金：原不可点 `span` 改为**可点**（同一圆角外观、同一 `{{ gold }}金` 文本与字号），
           指向積分中心；`v-if="logged"` 保留。 -->
      <button
        v-if="logged"
        type="button"
        class="app-header__gold"
        aria-label="積分中心"
        data-header-gold
        @click="go('points')"
      >
        <b>{{ gold }}</b><span>金</span>
      </button>

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
          <!-- who 行（本單改可点）：登录 ⇒ 指向【我的名刺】`/me`（原侧栏入口移至此处）；
               未登錄 ⇒ 仍是不可点的静态「尚未登錄」行。 -->
          <div class="app-header__menu-who">
            <button v-if="logged" type="button" data-menu-who @click="go('me')">
              {{ displayName }}<RoleMark :role="user.role" /> · {{ user.phone }}
            </button>
            <template v-else>尚未登錄</template>
          </div>
          <button v-if="!logged" type="button" @click="go('login')">登錄 / 註冊</button>
          <template v-else>
            <button type="button" @click="go('my-corrections')">我的勘誤記錄</button>
            <button type="button" @click="go('my-photos')">我的實物照片</button>
            <button type="button" @click="go('points')">積分中心</button>
            <button
              type="button"
              data-logout
              :disabled="logoutView.disabled"
              :aria-busy="logoutView.tone === 'running' ? 'true' : 'false'"
              @click="signOut"
            >{{ logoutView.label }}</button>
            <!-- 失敗就地可見（菜單保持打開；原會話未被動過 ⇒ 可原地重試） -->
            <p v-if="logoutError" class="app-header__menu-error" role="alert" data-logout-error>{{ logoutError }}</p>
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

/* 【掌書記引】容器：与 `.app-header__user` 同一手法（`position: relative` 作下拉的定位上下文），
   不新建任何色值 —— 下拉本体走既有 `.app-header__menu`。 */
.app-header__guide {
  position: relative;
}

/* 单字 glyph `引`（不画 SVG）：沿页头图标按钮同一形制，只补字面排布。
   选择器走容器类（`.app-header__guide`），不把 `data-*` 钩子写进样式表 —— 钩子只留给验收。 */
.app-header__guide .app-header__icon-btn {
  font-family: var(--font-serif);
  font-size: var(--t-md);
  line-height: 1;
}

/* 金：由不可点 `span` 改为可点 `button`（同一类、同一观感）—— 只补按钮缺的字体继承与指针，
   外观（底色 / 描边 / 圆角 / 字号）全部沿 `base.css` 的 `.app-header__gold`，不改成描边按钮。 */
.app-header__gold {
  font-family: inherit;
  cursor: pointer;
}

/* who 行改可点（指向 `me`）：内层按钮沿用 `.app-header__menu-who` 原排版 —— 不叠菜单按钮的
   padding / 底色（否则双层内距、行高被撑）；hover 只沿既有令牌换字色，零新色值。 */
.app-header__menu .app-header__menu-who button {
  padding: 0;
  background: none;
  border-radius: 0;
  text-align: inherit;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.app-header__menu .app-header__menu-who button:hover {
  background: none;
  color: var(--slot-sidebar-item-active-text);
}

/* 退出進行中：按鈕禁用但不「消失」（仍可讀「正在退出…」），指針不給可用暗示。 */
.app-header__menu button:disabled {
  opacity: 0.62;
  cursor: default;
}

.app-header__menu button:disabled:hover {
  background: none;
  color: var(--slot-panel-head-text);
}

/* 退出失敗就地上屏（菜單內）：與菜單同欄、左側紅線；文案由服務層給（`退出失敗：…`）。 */
.app-header__menu-error {
  margin: var(--s-1) 0 0;
  padding: var(--s-2) var(--s-3);
  border-left: 2px solid var(--c-danger);
  color: var(--c-danger);
  font-size: var(--t-xs);
  line-height: 1.45;
}
</style>
