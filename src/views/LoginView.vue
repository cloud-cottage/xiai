
<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth } from '../services/index.js'
import { currentUser } from '../data/session.js'

const route = useRoute()
const router = useRouter()

const phone = ref('')
const code = ref('')
const codeSent = ref(false)
const feedback = ref('')

/* **兩條登入路並存**（人類已定：演示碼入口一字不動地保留）：`code` = 手機號 + 驗證碼（演示碼）；
   `password` = 手機號 + 密碼（平台原生身份）。兩者共用同一個手機號輸入值。 */
const mode = ref('code')
const password = ref('')
/* 平台原生登入成功後取到的**平台會話 uid**（供後續寫面使用；本單只需能取到並可見）。 */
const platformUid = ref('')

const user = computed(() => currentUser())

/* 验证码提示由服务层给出（演示環境共用演示碼；按鈕點下即自動填入 ⇒ 提示只说这一步，不自稱取值）。 */
const codeHint = auth.loginCodeHint()

function switchMode(next) {
  mode.value = next === 'password' ? 'password' : 'code'
  feedback.value = ''
}

function sendCode() {
  const result = auth.requestCode(phone.value)
  codeSent.value = result.ok
  feedback.value = result.message
  /* 同 jiazu 登录页做法：取碼成功后把演示碼**自動填入**驗證碼欄（免手輸，直接可登錄）。 */
  if (result.ok && result.code) {
    code.value = result.code
  }
}

async function submit() {
  /* 写面 Phase A：`auth.login` 改为 `async`（**先服务端验证并拿到用户令牌，再写 session**）⇒ 本处 `await`。 */
  const result = await auth.login(phone.value, code.value)
  if (!result.ok) {
    feedback.value = result.message
    return
  }
  feedback.value = `歡迎回來，${result.user.nickname}`
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  router.replace(redirect || { name: 'square' })
}

/* **手機號 + 密碼（平台原生身份）**：本單只做「能登入 ＋ 能取到平台會話 uid」——
   成功不寫本機 session（那是演示碼那條路的職責）。失敗一律上屏可見文案。 */
async function submitPassword() {
  const result = await auth.loginWithPassword(phone.value, password.value)
  if (!result.ok) {
    platformUid.value = ''
    feedback.value = result.message
    return
  }
  platformUid.value = result.uid
  feedback.value = `已登入平台（手機號 ${phone.value.trim()}）`
}

function signOut() {
  auth.logout()
  phone.value = ''
  code.value = ''
  codeSent.value = false
  feedback.value = '已退出登錄'
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

      <div v-if="user" class="login__signed">
        <p class="login__signed-who">{{ user.nickname }} · {{ user.phone }}</p>
        <p class="login__signed-role">{{ user.role === 'admin' ? '管理員賬號' : '普通用戶賬號' }}</p>
        <div class="login__signed-foot">
          <button class="btn btn--ghost" type="button" @click="signOut">退出登錄</button>
          <router-link class="btn btn--primary" :to="{ name: 'square' }">返回璽印匯類</router-link>
        </div>
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
              <input id="login-code" v-model="code" type="text" inputmode="numeric" maxlength="6" placeholder="請輸入驗證碼" />
              <button class="btn btn--ghost" type="button" @click="sendCode">獲取驗證碼</button>
            </div>
            <span class="field__hint">{{ codeHint }}</span>
          </div>

          <button class="btn btn--primary login__submit" type="submit">登錄</button>
        </form>

        <form v-else class="login__form" @submit.prevent="submitPassword">
          <div class="field">
            <label for="login-phone-password">手機號</label>
            <input id="login-phone-password" v-model="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="請輸入 11 位手機號" />
          </div>

          <div class="field">
            <label for="login-password">密碼</label>
            <input id="login-password" v-model="password" type="password" autocomplete="current-password" placeholder="請輸入密碼" />
          </div>

          <button class="btn btn--primary login__submit" type="submit">登錄</button>
        </form>
      </template>

      <p v-if="feedback" class="login__feedback">{{ feedback }}</p>
      <p v-if="codeSent" class="login__sent">驗證碼已自動填入，請直接點「登錄」。</p>
      <p v-if="platformUid" class="login__sent" data-platform-uid>平台會話 UID：{{ platformUid }}</p>
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

.login__submit {
  width: 100%;
  margin-top: var(--s-2);
}

.login__feedback {
  margin-top: var(--s-4);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
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
