
<script setup>
import { accountLabel } from '../data/roleLabels.js'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth } from '../services/index.js'
import { currentUser } from '../data/session.js'
/* **服务端角色读面**：登录成功后向服务端确认「我是谁」（`sub-admin` 掌書記 是服务端授予的
   真实身份）；取不到 ⇒ 保持原值，**绝不**默认成管理员。 */
import { refreshMyRole } from '../services/roles.js'
/* **退出登錄三態**：與頁頭共用同一份壳与同一份文案（進行中 / 已退出登錄 / 退出失敗）。 */
import { useLogout } from '../utils/useLogout.js'

const route = useRoute()
const router = useRouter()

const phone = ref('')
const code = ref('')
/* 取碼成功（＝短訊已下發）後為 true；**只用來提示「請查收短訊」，不含任何碼值**。 */
const codeSent = ref(false)
/* 取碼請求在飛（防連點；與冷卻倒計時是兩件事）。 */
const sending = ref(false)
/* 重發冷卻剩餘秒數（0 ＝ 可再取）；頻控時按平台回的 `retryAfter` 設定。 */
const cooldown = ref(0)
const feedback = ref('')
let cooldownTimer = null

/* **兩條登入路並存**：`code` = 手機號 + 短訊驗證碼（真發短訊）；`password` = 手機號 + 密碼。
   兩者共用同一個手機號輸入值。 */
const mode = ref('code')
const password = ref('')
/* 密碼模式下的兩個階段：`login`（登入）／`reset`（忘記密碼 ⇒ 短訊驗證 ⇒ 重設）。
   **重置走的是同一條取碼通道**（`auth.requestCode`）⇒ 60s 冷卻與頻控原文兩處一致。 */
const passwordStage = ref('login')
const resetCode = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const resetting = ref(false)
/* 新密碼規則的一句人話（與服務層判據同源 ⇒ 不會出現「提示說 8 位、校驗卻要 10 位」）。 */
const passwordHint = auth.passwordRuleHint()

const user = computed(() => currentUser())

/* 退出三態（單点壳）：`logoutView.label` = `退出登錄` / `正在退出…`；
   `notice` = 成功頁內提示（`已退出登錄`，重新登入後清掉）；`logoutError` = `退出失敗：…`。 */
const {
  error: logoutError,
  notice: logoutNotice,
  view: logoutView,
  signOut: runLogout
} = useLogout()

/* 重新登入成功后不留「已退出登錄」的旧提示（否则与「歡迎回來」自相矛盾）。
   同时向服务端确认角色（fire-and-forget：失败静默、**不默认任何角色**）。 */
watch(user, (next) => {
  if (next) {
    logoutNotice.value = ''
    refreshMyRole()
  }
})

/* 驗證碼提示由服務層給出（真短訊 / 有頻控 / 有每日上限 ⇒ 如實說明，不自稱任何取值）。 */
const codeHint = auth.loginCodeHint()

/* 按鈕文案：冷卻中標剩餘秒數（**冷卻期間禁用**，避免「點了沒反應」）。 */
const codeButtonLabel = computed(() => {
  if (cooldown.value > 0) return `重新獲取（${cooldown.value}s）`
  if (sending.value) return '發送中…'
  return '獲取驗證碼'
})
const codeButtonDisabled = computed(() => sending.value || cooldown.value > 0)

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
}

/** 進入冷卻（秒數取平台建議值或前端預設 60s；**只是體驗層，真正的頻控在平台側**）。 */
function startCooldown(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60
  cooldown.value = Math.min(total, 3600)
  stopCooldown()
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) {
      cooldown.value = 0
      stopCooldown()
    }
  }, 1000)
}

onUnmounted(stopCooldown)

function switchMode(next) {
  mode.value = next === 'password' ? 'password' : 'code'
  passwordStage.value = 'login'
  feedback.value = ''
}

/** 進入「忘記密碼」：手機號沿用當前輸入值；**不在頁面上保留任何已輸入的密碼**。 */
function openReset() {
  passwordStage.value = 'reset'
  password.value = ''
  resetCode.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  feedback.value = ''
}

function leaveReset() {
  passwordStage.value = 'login'
  resetCode.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  feedback.value = ''
}

/**
 * 取碼：**真發短訊**（服務層調平台 `getVerification`）。
 *
 * 兩個硬點：
 *   ① 回包**不含任何碼值** ⇒ 這裡不可能、也不允許把碼填進輸入框（舊版「取碼即回填」的做法已刪）；
 *   ② 失敗時**平台原文上屏**（頻控 `RATE_LIMITED` 帶 `retryAfter` 時，按它設冷卻）。
 */
async function sendCode() {
  if (codeButtonDisabled.value) return
  sending.value = true
  try {
    const result = await auth.requestCode(phone.value)
    codeSent.value = result.ok === true
    feedback.value = result.message || ''
    if (result.ok) {
      startCooldown(result.cooldownSeconds || 60)
      return
    }
    /* 頻控：按平台建議秒數進冷卻（文案已在 `result.message` 原文上屏）。 */
    if (result.retryAfter) startCooldown(result.retryAfter)
  } finally {
    sending.value = false
  }
}

async function submit() {
  /* 写面 Phase A：`auth.login` 已 `async`，且順序為「平台驗碼 → 換 xiai 令牌 → 才落本地」。 */
  const result = await auth.login(phone.value, code.value)
  if (!result.ok) {
    feedback.value = result.message
    return
  }
  feedback.value = `歡迎回來，${result.user.nickname}`
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  router.replace(redirect || { name: 'square' })
}

/* **手機號 + 密碼（平台原生身份）**：完整鏈路（平台登入 ⇒ 取 access_token ⇒ 換 xiai 令牌 ⇒
   共用收尾建號/初始金/邀請結算/寫 session）。失敗一律上屏可見文案（平台原文透傳）。 */
async function submitPassword() {
  if (submitting.value) return
  submitting.value = true
  try {
    const result = await auth.loginWithPassword(phone.value, password.value)
    if (!result.ok) {
      feedback.value = result.message
      return
    }
    password.value = ''
    feedback.value = `歡迎回來，${result.user.nickname}`
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    router.replace(redirect || { name: 'square' })
  } finally {
    submitting.value = false
  }
}

/**
 * 重置密碼（忘記密碼流程的提交）：驗證碼 + 新密碼（兩次一致）。
 *
 * 服務層保證**零副作用**：密碼不合規 / 碼錯 / 碼過期 / 平台拒 ⇒ 舊密碼一字不動、
 * 不建本地賬號行、不寫 session、不發金。本函數只負責把結果**如實上屏**。
 */
async function submitReset() {
  if (resetting.value) return
  if (newPassword.value !== confirmPassword.value) {
    feedback.value = '兩次輸入的新密碼不一致，請重新輸入。'
    return
  }
  resetting.value = true
  try {
    const result = await auth.resetPasswordByOtp(phone.value, resetCode.value, newPassword.value)
    feedback.value = result.message || ''
    if (!result.ok) return
    /* 成功：先把敏感輸入清掉（不留在 DOM / 組件狀態裡）。 */
    resetCode.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    password.value = ''
    if (result.loggedIn && result.user) {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
      router.replace(redirect || { name: 'square' })
      return
    }
    /* 密碼已重設但自動登錄未成 ⇒ 回到登入態，讓用戶用新密碼登入（文案已上屏）。 */
    passwordStage.value = 'login'
  } finally {
    resetting.value = false
  }
}

function signOut() {
  /* **三態退出**（與頁頭同一份壳 `utils/useLogout.js`）：進行中按鈕換字禁用；
     成功 ⇒ 上屏「已退出登錄」（頁內提示條 ＋ 全站 toast）並清掉頁面上的敏感輸入；
     失敗 ⇒ 原因就地顯示、原會話保留、按鈕恢復可重試。 */
  return runLogout({
    onSignedOut: () => {
      phone.value = ''
      code.value = ''
      codeSent.value = false
      cooldown.value = 0
      password.value = ''
      resetCode.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
      passwordStage.value = 'login'
      stopCooldown()
      feedback.value = ''
    }
  })
}
</script>

<template>
  <div class="login">
    <section class="panel login__card">
      <div class="login__brand">
        <span class="login__mark">印</span>
        <h1>登錄璽愛</h1>
      </div>
      <p class="login__lede">登錄後可提交勘誤、上傳實物照片，並以金兌換高清印面資料。</p>

      <!-- 退出成功的**頁內**留痕（toast 會自動消失；頁面本身也要能讀到結論） -->
      <p v-if="logoutNotice" class="login__notice" role="status" data-logout-done>{{ logoutNotice }}</p>

      <div v-if="user" class="login__signed">
        <p class="login__signed-who">{{ user.nickname }} · {{ user.phone }}</p>
        <p class="login__signed-role" :data-role="user.role">{{ accountLabel(user.role) }}</p>
        <div class="login__signed-foot">
          <button
            class="btn btn--ghost"
            type="button"
            data-logout
            :disabled="logoutView.disabled"
            :aria-busy="logoutView.tone === 'running' ? 'true' : 'false'"
            @click="signOut"
          >{{ logoutView.label }}</button>
          <router-link class="btn btn--primary" :to="{ name: 'square' }">返回璽印匯類</router-link>
        </div>
        <!-- 失敗不得靜默：原因就地上屏；原會話保留（按鈕已恢復可點 ⇒ 可直接重試） -->
        <p v-if="logoutError" class="login__logout-error" role="alert" data-logout-error>{{ logoutError }}</p>
      </div>

      <template v-else>
        <div class="login__modes">
          <button
            type="button"
            class="login__mode"
            :class="{ 'login__mode--on': mode === 'code' }"
            :aria-pressed="mode === 'code' ? 'true' : 'false'"
            data-login-mode="code"
            @click="switchMode('code')"
          >手機號 + 驗證碼</button>
          <button
            type="button"
            class="login__mode"
            :class="{ 'login__mode--on': mode === 'password' }"
            :aria-pressed="mode === 'password' ? 'true' : 'false'"
            data-login-mode="password"
            @click="switchMode('password')"
          >手機號 + 密碼</button>
        </div>

        <form v-if="mode === 'code'" class="login__form" @submit.prevent="submit">
          <div class="field">
            <label for="login-phone">手機號</label>
            <input id="login-phone" v-model="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="請輸入 11 位手機號" />
          </div>

          <div class="field">
            <label for="login-code">驗證碼</label>
            <div class="login__code-row">
              <input id="login-code" v-model="code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="請輸入短訊驗證碼" />
              <button
                class="btn btn--ghost login__code-btn"
                type="button"
                :disabled="codeButtonDisabled"
                :aria-disabled="codeButtonDisabled ? 'true' : 'false'"
                data-code-cooldown
                @click="sendCode"
              >{{ codeButtonLabel }}</button>
            </div>
            <span class="field__hint">{{ codeHint }}</span>
          </div>

          <button class="btn btn--primary login__submit" type="submit">登錄</button>
        </form>

        <form v-else-if="passwordStage === 'login'" class="login__form" @submit.prevent="submitPassword">
          <div class="field">
            <label for="login-phone-password">手機號</label>
            <input id="login-phone-password" v-model="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="請輸入 11 位手機號" />
          </div>

          <div class="field">
            <label for="login-password">密碼</label>
            <input id="login-password" v-model="password" type="password" autocomplete="current-password" placeholder="請輸入密碼" />
          </div>

          <button class="btn btn--primary login__submit" type="submit" :disabled="submitting">登錄</button>
          <button class="login__link" type="button" data-login-forgot @click="openReset">忘記密碼？</button>
        </form>

        <form v-else class="login__form" @submit.prevent="submitReset">
          <p class="login__reset-lede">用短訊驗證碼確認是本機主，然後設定新密碼。</p>

          <div class="field">
            <label for="reset-phone">手機號</label>
            <input id="reset-phone" v-model="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="請輸入 11 位手機號" />
          </div>

          <div class="field">
            <label for="reset-code">驗證碼</label>
            <div class="login__code-row">
              <input id="reset-code" v-model="resetCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="請輸入短訊驗證碼" />
              <button
                class="btn btn--ghost login__code-btn"
                type="button"
                :disabled="codeButtonDisabled"
                :aria-disabled="codeButtonDisabled ? 'true' : 'false'"
                data-reset-code-cooldown
                @click="sendCode"
              >{{ codeButtonLabel }}</button>
            </div>
            <span class="field__hint">{{ codeHint }}</span>
          </div>

          <div class="field">
            <label for="reset-password">新密碼</label>
            <input id="reset-password" v-model="newPassword" type="password" autocomplete="new-password" placeholder="請輸入新密碼" />
            <span class="field__hint">{{ passwordHint }}</span>
          </div>

          <div class="field">
            <label for="reset-password-confirm">確認新密碼</label>
            <input id="reset-password-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" placeholder="請再次輸入新密碼" />
          </div>

          <button class="btn btn--primary login__submit" type="submit" :disabled="resetting" data-reset-submit>重設密碼</button>
          <button class="login__link" type="button" data-reset-back @click="leaveReset">返回登錄</button>
        </form>
      </template>

      <p v-if="feedback" class="login__feedback">{{ feedback }}</p>
      <p v-if="codeSent" class="login__sent">短訊已發送，請查收後填寫驗證碼；如未收到，請待倒計時結束後重新獲取。</p>
    </section>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--s-4);
}

.login__card {
  width: 100%;
  max-width: 420px;
}

.login__brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-3);
}

.login__mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1.5px solid var(--c-brand);
  border-radius: var(--r-sm);
  color: var(--c-brand);
  font-family: var(--font-seal);
  font-size: var(--t-lg);
  line-height: 1;
}

.login__lede {
  margin-bottom: var(--s-5);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.login__form {
  display: block;
}

/* 兩條登入路的切換（並存；文案繁體，與既有登入頁同口型）。 */
.login__modes {
  display: flex;
  gap: var(--s-2);
  margin-bottom: var(--s-4);
}

.login__mode {
  flex: 1 1 0;
  padding: var(--s-2) var(--s-3);
  background: transparent;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  cursor: pointer;
}

.login__mode--on {
  border-color: var(--c-brand);
  color: var(--c-brand);
}

.login__code-row {
  display: flex;
  gap: var(--s-2);
}

.login__code-row input {
  flex: 1 1 auto;
}

/* 取碼鈕：冷卻期間禁用（**不只變灰**：disabled ＋ aria-disabled ＋ 文案帶剩餘秒數）。 */
.login__code-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.login__code-btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}

.login__submit {
  width: 100%;
  margin-top: var(--s-2);
}

/* 形式上的次级入口（忘記密碼／返回登錄）：**不是**主按鈕，但可键盘聚焦、看得见。 */
.login__link {
  display: block;
  margin: var(--s-3) auto 0;
  padding: 0;
  background: none;
  border: 0;
  color: var(--c-brand);
  font-size: var(--t-sm);
  text-decoration: underline;
  cursor: pointer;
}

.login__reset-lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.login__feedback {
  margin-top: var(--s-4);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
  white-space: pre-line;
}

/* 退出成功的頁內提示條（`已退出登錄`）：與 toast 同文案，綠線標示「這是結果，不是錯誤」。 */
.login__notice {
  margin-bottom: var(--s-4);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-left: 3px solid var(--c-ok);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

/* 退出失敗的頁內提示（`退出失敗：…`）：紅線 ＋ 紅字，與成功條明顯不同。 */
.login__logout-error {
  margin-top: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-left: 3px solid var(--c-danger);
  border-radius: var(--r-md);
  color: var(--c-danger);
  font-size: var(--t-sm);
  white-space: pre-line;
}

.login__sent {
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.login__signed-who {
  color: var(--c-text);
  font-size: var(--t-md);
}

.login__signed-role {
  margin-top: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.login__signed-foot {
  display: flex;
  gap: var(--s-2);
  margin-top: var(--s-5);
}
</style>
