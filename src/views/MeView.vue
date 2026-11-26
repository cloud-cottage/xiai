<script setup>
/**
 * 我的名刺（`/me`）—— 登录用户**自己的**账户名刺页。
 * ====================================================================
 * 本页**不是管理员页**（徽號是用户自己的东西）：零管理员按钮样式 / 零管理员角标组件
 * / 零权限判定、零 `roleLabels` 硬编码身份文案。
 *
 * 页内五块（全部只读上屏 ＋ **仅徽號一处可编辑**）：
 *   ① 徽號 —— 上屏值**单点取自** `services.profile.displayNicknameOf(user)`
 *      （云端 profile.nickname → 本机 users.nickname → 系统默认；回落链全仓唯一处，
 *      本页**不另写**任何 `|| '…'` 回落）；行内编辑（输入框＋【儲存】）走
 *      `services.profile.saveMyNickname()`：
 *        · 失败（含服务端 `INVALID_VALUE`）⇒ **就地显示服务端原文** `message`，
 *          **不自造第二套文案**；
 *        · 成功 ⇒ 就地一行成功提示 ＋ 上屏立即刷新（更新服务层缓存读数）；
 *        · 提交中 `busy` 禁双击；空 / 未修改**不提交**。
 *   ② 手機號 —— 打码（`166****1656` 形态）只读，**无修改入口**。
 *   ③ 註冊時間 —— 本机 `users` 行 `created_at`，按仓内既有形态 `utils/format.js::formatDateTime`。
 *   ④ 金 —— 当前余额（经 `services.points.displayPoints()`，与页头 / 積分中心同一回落链）＋ 指向 `/points` 的链接。
 *   ⑤ 登出 —— **复用仓内既有单点** `utils/useLogout.js`（页头 `AppHeader.vue`、
 *      登录页 `LoginView.vue` 同一份壳：三态文案 / 防重复点 / toast 全在那边），
 *      本页**不重写**登出逻辑、不另造文案。
 *
 * **未登录态**：页内给引导（請先登錄 ＋ 去 `/login` 的链接）—— **不重定向**、不报错、
 * **不请求 profile**（`onMounted` 先判登录态再发读）。路由因此**不设 `requiresAuth`**。
 */
import { computed, ref, onMounted } from 'vue'
/* 页面一律经 services 门面取业务数据（profile / points 只在此取，不直碰 services/profile.js）。 */
import { services } from '../services/index.js'
/* 登录态 / 本机 `users` 行（手机号、注册时间、徽号回落第 2 级）：与 PublisherIndexView /
   MyDriveView 等既有页面**同一取法**（`data/session.js` 的只读会话状态）。 */
import { currentUser, isLoggedIn } from '../data/session.js'
/* 注册时间上屏形态：仓内既有单点（`YYYY-MM-DD HH:mm`；空 / 非法 ⇒ `—`）。 */
import { formatDateTime } from '../utils/format.js'
/* 登出单点壳（与 AppHeader / LoginView 同一份）。 */
import { useLogout } from '../utils/useLogout.js'

/** 本机 `users` 行；未登录 ⇒ `null`。 */
const user = computed(() => currentUser())
const logged = isLoggedIn

/**
 * 云端徽号读数的**重算信号**：`displayNicknameOf()` 读的是服务层**模块缓存**
 * （非响应式）⇒ 每次读 / 写完成后 +1，令上屏名立即刷新。
 * **只负责触发重算，不参与回落**（回落链一字不动）。
 */
const profileTick = ref(0)

/** 徽號上屏名（**本页唯一取值点**，经服务层单点回落链）。 */
const nickname = computed(() => {
  void profileTick.value
  return services.profile.displayNicknameOf(user.value)
})

/* ------------------------------------------------------------------ ① 徽號行内编辑 */
const editing = ref(false)
const draft = ref('')
/** 提交中：禁双击（与按钮 `disabled` / `aria-busy` 同源判据）。 */
const busy = ref(false)
/** 失败提示：**服务端原文**（`INVALID_VALUE` 等一律透传，本页不改写、不新增文案）。 */
const feedback = ref('')
/** 成功提示：就地一行可见反馈。 */
const savedNote = ref('')

/** 空 / 未修改 ⇒ 不提交（按钮同时禁用）。 */
const canSave = computed(() => {
  const raw = draft.value.trim()
  return raw !== '' && raw !== nickname.value
})

function startEdit() {
  feedback.value = ''
  savedNote.value = ''
  draft.value = nickname.value
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  feedback.value = ''
  savedNote.value = ''
}

async function saveNickname() {
  if (busy.value) return
  const raw = draft.value.trim()
  if (raw === '' || raw === nickname.value) return
  busy.value = true
  feedback.value = ''
  savedNote.value = ''
  try {
    const result = await services.profile.saveMyNickname(raw)
    if (!result || result.ok !== true) {
      /* 服务端原文就地上屏（值域错等一律原文，不编第二套文案）。 */
      feedback.value = result && typeof result.message === 'string' ? result.message : ''
      return
    }
    /* 成功：可见反馈 ＋ 上屏立即刷新（服务层缓存已写入；+1 令 computed 重算），
       再 fire-and-forget 复读一次云端确认（失败静默，不影响已保存的上屏）。 */
    savedNote.value = '徽號已更新。'
    editing.value = false
    profileTick.value += 1
    services.profile
      .refreshMyProfile()
      .then(() => {
        profileTick.value += 1
      })
      .catch(() => {})
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------------------------ ② 手機號（打码只读） */
/** 手機號打码（`166****1656` 形态）：前三 ＋ `****` ＋ 后四；**不提供修改入口**。 */
const phoneMasked = computed(() => {
  const raw = user.value && typeof user.value.phone === 'string' ? user.value.phone.trim() : ''
  if (raw === '') return '—'
  if (raw.length <= 7) return raw
  return `${raw.slice(0, 3)}****${raw.slice(-4)}`
})

/* ------------------------------------------------------------------ ③ 註冊時間 */
/** 本机 `users` 行 `created_at`，按仓内既有时间形态上屏（无值 ⇒ `—`）。 */
const createdAt = computed(() => formatDateTime(user.value ? user.value.created_at : ''))

/* ------------------------------------------------------------------ ④ 金 */
/**
 * 当前余额（**本單**：经门面 `services.points.displayPoints()`，与页头 / 積分中心
 * **同一取法、同一回落链** —— 云端权威账本优先，取不到回落本机并带标注；
 * 不再读本机账本的余额读数函数，避免出现第二套余额展示）。 */
const goldView = computed(() => services.points.displayPoints())
const gold = computed(() => goldView.value.points)

/* ------------------------------------------------------------------ ⑤ 登出（复用单点） */
/* 退出三态（进行中 / 成功 / 失败）：与页头 `AppHeader.vue`、登录页 `LoginView.vue`
   **共用同一份壳** `utils/useLogout.js`（文案单点在 `services/logoutText.js`）——
   本页只挂按钮，不重写登出逻辑、不另造文案。 */
const { error: logoutError, view: logoutView, signOut: runLogout } = useLogout()

function signOut() {
  /* 成功 ⇒ 全站 toast「已退出登錄」＋ 本页随登录态翻回「未登錄」引导（不重定向）。 */
  return runLogout()
}

/* ------------------------------------------------------------------ 首读 */
onMounted(() => {
  /* 未登录 ⇒ **零 profile 请求**（页内只给引导；不重定向、不报错）。 */
  if (!logged.value) return
  /* 读一次云端徽号（`loadMyProfile` 自身不抛；这里再兜一层，失败静默、不阻塞渲染）。 */
  services.profile
    .loadMyProfile()
    .then(() => {
      profileTick.value += 1
    })
    .catch(() => {})
})
</script>

<template>
  <section>
    <div class="page-head">
      <h1>我的名刺</h1>
      <p>這裏是你的名刺：徽號、手機號、註冊時間與金。</p>
    </div>

    <!-- 未登录：只给引导（**不重定向 / 不报错 / 不请求 profile**）＋ 一个去登录的链接。 -->
    <section v-if="!logged" class="panel me-guest" data-me-guest>
      <p class="me-guest__text">請先登錄，再查看我的名刺。</p>
      <router-link class="btn btn--primary" :to="{ name: 'login' }">去登錄</router-link>
    </section>

    <template v-else>
      <!-- ① 徽號：只读上屏 ＋ **唯一**一处行内可编辑。 -->
      <section class="panel">
        <div class="panel__head">
          <h2>徽號</h2>
          <button
            v-if="!editing"
            class="btn btn--ghost"
            type="button"
            data-me-nickname-edit
            @click="startEdit"
          >
            修改
          </button>
        </div>
        <div class="panel__body">
          <p class="me-nickname" data-me-nickname>{{ nickname }}</p>

          <div v-if="editing" class="me-edit">
            <div class="field">
              <label for="me-nickname-input">徽號</label>
              <input
                id="me-nickname-input"
                v-model="draft"
                type="text"
                autocomplete="off"
                data-me-nickname-input
                @keydown.enter.prevent="saveNickname"
              />
              <span class="field__hint">2〜12 個字；以服務端判定為準。</span>
            </div>
            <div class="me-edit__foot">
              <button
                class="btn btn--primary"
                type="button"
                data-me-nickname-save
                :disabled="!canSave || busy"
                :aria-busy="busy ? 'true' : 'false'"
                @click="saveNickname"
              >
                儲存
              </button>
              <button
                class="btn btn--ghost"
                type="button"
                data-me-nickname-cancel
                :disabled="busy"
                @click="cancelEdit"
              >
                取消
              </button>
            </div>
          </div>

          <!-- 失败：服务端原文就地可见（不改写）。 -->
          <p v-if="feedback" class="me-feedback me-feedback--error" role="alert" data-me-nickname-error>
            {{ feedback }}
          </p>
          <!-- 成功：就地一行可见反馈。 -->
          <p v-if="savedNote" class="me-feedback me-feedback--ok" role="status" data-me-nickname-ok>
            {{ savedNote }}
          </p>
        </div>
      </section>

      <!-- ② 手機號（打码只读）③ 註冊時間 ④ 金（链接到积分中心）。 -->
      <section class="panel">
        <div class="panel__head">
          <h2>資料</h2>
        </div>
        <div class="panel__body">
          <dl class="me-rows">
            <div class="me-row">
              <dt>手機號</dt>
              <dd data-me-phone>{{ phoneMasked }}</dd>
            </div>
            <div class="me-row">
              <dt>註冊時間</dt>
              <dd data-me-created>{{ createdAt }}</dd>
            </div>
            <div class="me-row">
              <dt>金</dt>
              <dd data-me-gold :title="goldView.note || null">
                <b class="me-gold__num">{{ gold }}</b>
                <span class="me-gold__unit">金</span>
                <router-link class="me-gold__link" :to="{ name: 'points' }">積分中心</router-link>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- ⑤ 登出：复用仓内既有单点 `utils/useLogout.js`（页头 / 登录页同一份壳）。 -->
      <section class="panel">
        <div class="panel__head">
          <h2>登錄狀態</h2>
        </div>
        <div class="panel__body me-logout">
          <button
            class="btn btn--ghost"
            type="button"
            data-me-logout
            :disabled="logoutView.disabled"
            :aria-busy="logoutView.tone === 'running' ? 'true' : 'false'"
            @click="signOut"
          >
            {{ logoutView.label }}
          </button>
          <!-- 失败就地可见（会话原样保留 ⇒ 可原地重试）。 -->
          <p v-if="logoutError" class="me-feedback me-feedback--error" role="alert" data-me-logout-error>
            {{ logoutError }}
          </p>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
/* 未登录引导 */
.me-guest__text {
  margin: 0 0 var(--s-4);
  color: var(--slot-panel-body-text);
}

/* 徽號上屏 */
.me-nickname {
  margin: 0 0 var(--s-3);
  font-family: var(--font-serif);
  font-size: var(--t-xl);
  color: var(--slot-panel-head-text);
}

.me-edit__foot {
  display: flex;
  gap: var(--s-3);
  flex-wrap: wrap;
}

/* 就地反馈（成功 / 失败各一行；左侧色线与页头错误条同形态） */
.me-feedback {
  margin: var(--s-3) 0 0;
  padding-left: var(--s-3);
  border-left: 2px solid var(--c-line);
  font-size: var(--t-sm);
  line-height: 1.45;
}

.me-feedback--error {
  border-left-color: var(--c-danger);
  color: var(--c-danger);
}

.me-feedback--ok {
  border-left-color: var(--c-ok);
  color: var(--c-ok);
}

/* 资料行 */
.me-rows {
  margin: 0;
}

.me-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3) 0;
  border-bottom: 1px solid var(--c-line);
}

.me-row:last-child {
  border-bottom: 0;
}

.me-row dt {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.me-row dd {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  margin: 0;
}

.me-gold__num {
  font-family: var(--font-serif);
  font-size: var(--t-lg);
  color: var(--c-gold-strong);
}

.me-gold__unit {
  color: var(--c-gold-strong);
  font-size: var(--t-sm);
}

.me-gold__link {
  font-size: var(--t-sm);
}

/* 登出 */
.me-logout {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-3);
}
</style>
