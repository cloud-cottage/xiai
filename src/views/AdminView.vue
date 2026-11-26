<script setup>
/**
 * 【管理後台】（`/admin`）—— **纯静态导航卡片页：零数据请求、零写入**。
 *
 * 本页只做三件事，且**全部在客户端内存里完成**：
 *   ① 读 `data/session.js` 的会话态（游客 / 已登录）—— **不读云端集合、不发任何请求**；
 *   ② 两个**只读**判定（都收在 `services/admin.js`，本页不自写任何角色字面）：
 *      · 进入资格（管理层）＝服务层的管理层会话判定（与页头二级菜单入口**同一个单点**）；
 *      · 卡片可见（真实写门）＝服务层的管理员会话判定（既有 `role === 'admin'` 门的出口，
 *        **一字未放宽**）；
 *   ③ 四张卡都是 `router-link` ⇒ 只是跳到既有页（`/publishers`、`/books`、`/connect`、`/points`），
 *      **本页不新建任何功能、不调任何写 op**。
 *
 * 三态（均**不重定向**、页内自述；卡片只在第 ③ 态渲染）：
 *   ① 游客 ⇒ `請先登錄，再進入管理後台。` ＋ 去 `/login` 的链接；
 *   ② 已登录但非管理层 ⇒ `權限不足（僅…及以上可進入）；本頁不做任何讀寫。`；
 *   ③ 管理层 ⇒ 四张卡各带真实门；一张都不命中（可进后台但无任何写门的身份）⇒ **诚实空态**
 *      （`data-admin-empty`：不置灰、不占位、不拿假卡充数）。
 *
 * 样式：卡片本体**不是按钮**（是导航链接）⇒ 不套管理员按钮的虚线样式、不挂角标组件；
 * 颜色一律取仓内既有槽位令牌（卡片族 / 金底），零新增色值。
 */
import { computed } from 'vue'
/* 身份上屏文案一律经 `roleLabels.js` 取值（禁硬编码身份文案）。 */
import { ADMIN_LABEL, SUB_ADMIN_LABEL } from '../data/roleLabels.js'
/* 只读会话态（游客判定）；本页**不**从这里取任何资料集合。 */
import { isLoggedIn } from '../data/session.js'
/* 两个只读判定的唯一出口（页头菜单同样只调这个模块）。 */
import * as adminService from '../services/admin.js'

/** ① 游客（无会话）：页内给登录引导，**不重定向**、零卡片、零请求。 */
const guest = computed(() => !isLoggedIn.value)
/** ② 进入资格（管理层）：服务层**单点**判定，页头与本页共用、不各写角色字面。 */
const management = computed(() => adminService.isManagementSession())
/** ③ 卡片真实门：四张卡共用既有管理员门（服务层单点；模板里不写任何角色字面）。 */
const canManage = computed(() => adminService.isAdminSession())
</script>

<template>
  <div class="page-head">
    <h1>管理後台</h1>
    <!-- 副题：身份词一律经 `roleLabels.js` 取值（禁硬编码身份文案）。 -->
    <p>{{ SUB_ADMIN_LABEL }}及以上身份可進入；每項功能另按其真實權限顯示。</p>
  </div>

  <!-- ① 游客：页内引导 ＋ `/login` 链接（不重定向、零卡片、零请求）。 -->
  <div v-if="guest" class="notice" data-admin-guest>
    <span>請先登錄，再進入管理後台。</span>
    <router-link class="btn btn--ghost" :to="{ name: 'login' }">前往登錄</router-link>
  </div>

  <!-- ② 已登录但非管理层：页内拒绝（不重定向、零卡片、零请求）。 -->
  <div v-else-if="!management" class="notice" data-admin-denied>
    <span>權限不足（僅{{ ADMIN_LABEL }}及以上可進入）；本頁不做任何讀寫。</span>
  </div>

  <!-- ③ 管理层：按真实门渲染卡片；一张都不命中 ⇒ 诚实空态。 -->
  <template v-else>
    <div v-if="canManage" class="admin-cards">
      <router-link
        v-if="canManage"
        class="admin-card"
        :to="{ name: 'publishers' }"
      >
        <span class="admin-card__title">梓行匯溯（出版社）</span>
        <span class="admin-card__go">前往 →</span>
      </router-link>

      <router-link
        v-if="canManage"
        class="admin-card"
        :to="{ name: 'books' }"
      >
        <span class="admin-card__title">印譜匯觀（新建 / 編輯印譜）</span>
        <span class="admin-card__go">前往 →</span>
      </router-link>

      <router-link
        v-if="canManage"
        class="admin-card"
        :to="{ name: 'connect-feicui' }"
      >
        <span class="admin-card__title">斐萃令牌（簽發管理權令牌）</span>
        <span class="admin-card__go">前往 →</span>
      </router-link>

      <router-link
        v-if="canManage"
        class="admin-card"
        :to="{ name: 'points' }"
      >
        <span class="admin-card__title">積分中心（邀請獎勵設置）</span>
        <span class="admin-card__go">前往 →</span>
      </router-link>
    </div>

    <!-- 诚实空态：可进后台、但四张卡的真实门一张都不命中（不置灰、不占位、不造假卡）。 -->
    <div v-if="!canManage" class="panel" data-admin-empty>
      <div class="empty-note">
        <span class="empty-note__title">當前身份可進入後台，尚無可操作的管理功能。</span>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* 卡片网格：只用既有槽位令牌（卡片族）＋ 既有间距 / 圆角，零新增色值。 */
.admin-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--s-4);
}

/* 卡片本体是**导航**（`router-link`），不是按钮 ⇒ 不套管理员按钮样式、不挂角标。 */
.admin-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-4) var(--s-5);
  background: var(--slot-card-bg);
  border: 1px solid var(--slot-card-line);
  border-radius: var(--r-lg);
  color: var(--slot-card-title-text);
}

/* 可点反馈：金底沿用次按钮 `:hover` 的同一既有令牌（不自创主题色）。 */
.admin-card:hover {
  background: var(--slot-gold-bg);
}

.admin-card__title {
  font-family: var(--font-serif);
  font-size: var(--t-lg);
}

.admin-card__go {
  color: var(--slot-card-meta-text);
  font-size: var(--t-sm);
  white-space: nowrap;
}
</style>
