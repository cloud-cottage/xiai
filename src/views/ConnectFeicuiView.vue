<script setup>
/**
 * 連接斐萃（`/connect`）—— **本单改造：斐萃令牌（管理员签发）**
 *
 * 用途：斐萃（本地電腦版）要調 yinyuan2026 的讀面 API，而 `YINYUAN_API_KEY` **只許待在 xiai 側**。
 * 斐萃改為持有一枚**璽愛簽發的 HMAC 令牌**（`v1.<payload>.<sig>`），打到本站的轉發路由
 * `/api/feicui/v1/<dynasties|authors|inscriptions>`；本站驗簽即確權，再帶**自己的** key 去取數。
 *
 * 本页硬口径：
 *   · **仅管理员可操作**（服务端才是判据：`ADMIN_OPS.issueFeicuiToken` 走 `adminWhitelistDenial`）；
 *     普通用户 / 未登录只看到说明文案，**不发任何请求**；
 *   · 令牌**只在签发回包里出现一次**：本页不落 localStorage、不进日志、不发往任何第三方；
 *   · 令牌是**凭据**：页面明确提示「勿入库、勿贴群」；
 *   · 展示 `jti` / `kid`：禁用某枚令牌＝把 `jti` 写进 `config/feicui-token-revoked.json` 重新部署；
 *     全体失效＝轮换 `FEICUI_TOKEN_SECRET` / `FEICUI_TOKEN_KID`；
 *   · 剩余时间只用于**展示**（服务端时钟才是判据）。
 */
import { computed, onUnmounted, ref } from 'vue'
import { isAdmin, isLoggedIn } from '../data/session.js'
import {
  FEICUI_FORWARD_PREFIX,
  FEICUI_RESOURCES,
  FEICUI_ROLES,
  FEICUI_TTL,
  FEICUI_TTL_OPTIONS,
  issueToken,
  remainingSeconds
} from '../services/feicui.js'
import { formatDateTime } from '../utils/format.js'

const logged = isLoggedIn
const admin = isAdmin

const busy = ref(false)
const target = ref('')
const role = ref('user')
const ttlDays = ref(FEICUI_TTL.defaultDays)
const error = ref('')
const copied = ref(false)
const issued = ref(null)
const nowTick = ref(Date.now())
let timer = null

const remaining = computed(() => (issued.value ? remainingSeconds(issued.value.expires_at, nowTick.value) : 0))
const expired = computed(() => issued.value !== null && remaining.value <= 0)
const remainingLabel = computed(() => {
  const total = remaining.value
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  if (days > 0) return `${days} 天 ${hours} 小時`
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
})

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  nowTick.value = Date.now()
  timer = setInterval(() => {
    nowTick.value = Date.now()
    if (expired.value) stopTimer()
  }, 1000)
}

async function onIssue() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  copied.value = false
  issued.value = null
  const result = await issueToken({ target: target.value, role: role.value, ttlDays: ttlDays.value })
  busy.value = false
  if (!result.ok) {
    error.value = result.message || '斐萃令牌簽發失敗，請稍後再試。'
    return
  }
  issued.value = result
  startTimer()
}

async function onCopy() {
  if (!issued.value) return
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(issued.value.token)
    }
    copied.value = true
  } catch {
    /* 剪貼板不可用 ⇒ 如實提示手動選取（不假裝已複製）。 */
    copied.value = false
    error.value = '無法自動複製，請在上方文字框內全選後手動複製。'
  }
}

onUnmounted(stopTimer)
</script>

<template>
  <section>
    <div class="page-head">
      <h1>斐萃令牌</h1>
      <p>為斐萃桌面版簽發一枚令牌；斐萃拿它調本機轉發接口，<b>上游密鑰始終不離開璽愛</b>。</p>
    </div>

    <section v-if="!logged" class="panel">
      <div class="panel__head">
        <h2>請先登錄</h2>
      </div>
      <div class="panel__body">
        <p class="hint">斐萃令牌只由管理員簽發；請先用管理員賬號登錄。</p>
        <router-link class="btn" :to="{ name: 'login', query: { redirect: '/connect' } }">前往登錄</router-link>
      </div>
    </section>

    <section v-else-if="!admin" class="panel">
      <div class="panel__head">
        <h2>僅管理員可簽發</h2>
      </div>
      <div class="panel__body">
        <p class="hint">
          斐萃令牌是<b>憑證</b>：持有它就能以你的身份讀取印譜讀面（朝代 / 印人 / 印譜）。
          因此本頁只對管理員開放；需要令牌請聯繫管理員。
        </p>
        <p class="hint">你現在登錄的是普通用戶賬號，本頁不會發出任何簽發請求。</p>
      </div>
    </section>

    <section v-else class="panel">
      <div class="panel__head">
        <h2>簽發令牌</h2>
        <button class="btn" type="button" :disabled="busy" @click="onIssue">
          {{ busy ? '簽發中…' : issued ? '再簽一枚' : '簽發' }}
        </button>
      </div>
      <div class="panel__body">
        <div class="form">
          <label class="field">
            <span class="field__label">目標（11 位手機號或既有 uid）</span>
            <input v-model.trim="target" class="field__input" type="text" autocomplete="off" spellcheck="false"
              placeholder="13800000000 或 u-0123456789abcdef" />
            <span class="field__hint">手機號由服務端按倉內既有口徑派生 uid（`u-` ＋ sha256 前 16 位）；手機號本身不落庫。</span>
          </label>
          <label class="field">
            <span class="field__label">角色</span>
            <select v-model="role" class="field__input">
              <option v-for="item in FEICUI_ROLES" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">有效期</span>
            <select v-model.number="ttlDays" class="field__input">
              <option v-for="item in FEICUI_TTL_OPTIONS" :key="item.days" :value="item.days">{{ item.label }}</option>
            </select>
            <span class="field__hint">最長 90 天；到期後斐萃需重新申請（服務端不存令牌狀態，無法續期）。</span>
          </label>
        </div>

        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <div v-if="issued" class="token-box">
          <div class="token-box__head">
            <span class="token-box__title">令牌（只顯示這一次）</span>
            <button class="btn btn--ghost" type="button" @click="onCopy">{{ copied ? '已複製' : '複製令牌' }}</button>
          </div>
          <textarea class="token-box__token" data-feicui-token readonly rows="3" :value="issued.token"></textarea>
          <dl class="token-box__meta">
            <div><dt>目標 uid</dt><dd>{{ issued.uid }}</dd></div>
            <div><dt>角色</dt><dd>{{ issued.role }}</dd></div>
            <div><dt>到期</dt><dd>{{ formatDateTime(issued.expires_at) }}</dd></div>
            <div>
              <dt>剩餘</dt>
              <dd>
                <span v-if="!expired">{{ remainingLabel }}</span>
                <span v-else class="expired">已過期（請重新簽發）</span>
              </dd>
            </div>
            <div><dt>jti（禁用時用）</dt><dd class="mono">{{ issued.jti }}</dd></div>
            <div><dt>kid</dt><dd class="mono">{{ issued.kid }}</dd></div>
          </dl>
          <p class="warn">
            這是<b>憑證</b>：請直接粘進斐萃的設定裡，<b>勿入代碼庫、勿貼群、勿截圖外傳</b>。
            遺失或疑似洩露 ⇒ 把上面的 <code>jti</code> 加進 <code>config/feicui-token-revoked.json</code> 後重新部署。
          </p>
        </div>
        <p v-else-if="!busy" class="hint">填寫目標與有效期後按「簽發」。</p>

        <ol class="steps">
          <li>斐萃側把令牌放進請求頭：<code>Authorization: Feicui &lt;token&gt;</code>。</li>
          <li>讀面轉發：<code>{{ FEICUI_FORWARD_PREFIX }}/{{ FEICUI_RESOURCES[0] }}</code>（白名單恰三路：{{ FEICUI_RESOURCES.join(' / ') }}；query 只收 <code>limit</code> / <code>offset</code>）。</li>
          <li>本站驗簽（簽名 / 到期 / 版本 / kid / 吊銷名單）後，帶<b>本站自己的</b>上游密鑰取數；回應按 path＋query 在服務端緩存。</li>
          <li>禁用方式：<code>jti</code> 進吊銷名單＝單枚失效；輪換密鑰＝全體失效（最遲 90 天內自然到期）。</li>
        </ol>
      </div>
    </section>
  </section>
</template>

<style scoped>
.page-head p,
.hint {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  margin-bottom: var(--s-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.field__label {
  font-size: var(--t-sm);
  color: var(--c-text);
}

.field__input {
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  background: var(--c-surface);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.field__hint {
  font-size: var(--t-xs);
  color: var(--c-text-muted);
}

.token-box {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  margin-bottom: var(--s-4);
}

.token-box__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}

.token-box__title {
  font-size: var(--t-sm);
  color: var(--c-text);
}

.token-box__token {
  width: 100%;
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
  line-height: 1.6;
  color: var(--c-gold-strong);
  background: transparent;
  border: 1px dashed var(--c-line-strong);
  border-radius: var(--r-md);
  padding: var(--s-2);
  resize: vertical;
  word-break: break-all;
}

.token-box__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-2) var(--s-4);
  margin: 0;
  font-size: var(--t-xs);
}

.token-box__meta dt {
  color: var(--c-text-muted);
}

.token-box__meta dd {
  margin: 0;
  color: var(--c-text);
}

.mono {
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}

.expired,
.error {
  color: var(--c-danger, #b4342a);
}

.error {
  font-size: var(--t-sm);
  margin: 0 0 var(--s-3);
}

.warn {
  margin: 0;
  font-size: var(--t-xs);
  line-height: 1.7;
  color: var(--c-text-muted);
  border-left: 2px solid var(--c-gold-strong);
  padding-left: var(--s-3);
}

.steps {
  margin: 0;
  padding-left: var(--s-5);
  font-size: var(--t-sm);
  color: var(--c-text-muted);
  line-height: 1.8;
}

.steps code,
.warn code {
  font-family: var(--font-mono, monospace);
}
</style>
