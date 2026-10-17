
<script setup>
/**
 * 連接斐萃（`/connect`）—— **本单新增**（斐萃桌面端换身份 · 站内取码页）。
 *
 * 用途：斐萃本地电脑版要调 yinyuan2026 的读面 API，密钥只在**斐萃服务端**；本站负责证明
 * 「你是璽愛的哪位用户」⇒ 发一枚**一次性**授权码（10 分钟、用一次即失效）。用户把码交给
 * 斐萃客户端，斐萃服务端再拿它调 `POST /api/auth/feicui-exchange` 换回 uid。
 *
 * 硬口径：
 *   · 页内**不显示 uid**（用户无需知道；码才是交给斐萃的那一件东西）；
 *   · 未登錄 ⇒ 只给登录引导（**不发请求**，服务端也有独立拒绝面）；
 *   · 每按一次「產生」都会签发**新码**（旧码不因此失效，各自 10 分钟、各自一次性）；
 *   · 剩余时间只用于**展示**（服务端时钟才是判据）。
 */
import { computed, onUnmounted, ref } from 'vue'
import { isLoggedIn } from '../data/session.js'
import { FEICUI_EXCHANGE_PATH, issueCode, remainingSeconds } from '../services/feicui.js'
import { formatDateTime } from '../utils/format.js'

const logged = isLoggedIn
const busy = ref(false)
const code = ref('')
const expiresAt = ref('')
const nowTick = ref(Date.now())
const error = ref('')
const copied = ref(false)
let timer = null

const remaining = computed(() => remainingSeconds(expiresAt.value, nowTick.value))
const remainingLabel = computed(() => {
  if (!code.value) return ''
  const total = remaining.value
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
const expired = computed(() => code.value !== '' && remaining.value <= 0)

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
  code.value = ''
  expiresAt.value = ''
  const result = await issueCode()
  busy.value = false
  if (!result.ok) {
    error.value = result.message || '授權碼簽發失敗，請稍後再試。'
    return
  }
  code.value = result.code
  expiresAt.value = result.expires_at
  startTimer()
}

async function onCopy() {
  if (!code.value) return
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(code.value)
    }
    copied.value = true
  } catch {
    /* 剪貼板不可用 ⇒ 如實提示手動選取（不假裝已複製）。 */
    copied.value = false
    error.value = '無法自動複製，請手動選取上方授權碼。'
  }
}

onUnmounted(stopTimer)
</script>

<template>
  <section>
    <div class="page-head">
      <h1>連接斐萃</h1>
      <p>為斐萃桌面版產生一枚一次性授權碼；十分鐘內有效，用過即失效。</p>
    </div>

    <section v-if="!logged" class="panel">
      <div class="panel__head">
        <h2>請先登錄</h2>
      </div>
      <div class="panel__body">
        <p class="hint">授權碼與你的帳號綁定，因此必须先登錄才能產生。</p>
        <router-link class="btn" :to="{ name: 'login', query: { redirect: '/connect' } }">前往登錄</router-link>
      </div>
    </section>

    <section v-else class="panel">
      <div class="panel__head">
        <h2>一次性授權碼</h2>
        <button class="btn" type="button" :disabled="busy" @click="onIssue">
          {{ busy ? '產生中…' : code ? '重新產生' : '產生授權碼' }}
        </button>
      </div>
      <div class="panel__body">
        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <div v-if="code" class="code-box">
          <div class="code-box__code" data-feicui-code>{{ code }}</div>
          <div class="code-box__meta">
            <span v-if="!expired">剩餘有效時間 <strong>{{ remainingLabel }}</strong></span>
            <span v-else class="expired">已過期，請重新產生</span>
            <span v-if="expiresAt">有效至 {{ formatDateTime(expiresAt) }}</span>
          </div>
          <button class="btn btn--ghost" type="button" :disabled="expired" @click="onCopy">
            {{ copied ? '已複製' : '複製授權碼' }}
          </button>
        </div>

        <p v-else-if="!busy" class="hint">按上方按鈕產生授權碼。</p>

        <ol class="steps">
          <li>在斐萃桌面版選擇「連接玺愛」，粘貼這枚授權碼。</li>
          <li>斐萃服務端會用本站核銷接口（<code>{{ FEICUI_EXCHANGE_PATH }}</code>）換回你的帳號標識。</li>
          <li>授權碼<b>只能使用一次</b>；遺失或過期請重新產生。</li>
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

.code-box {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  align-items: flex-start;
  padding: var(--s-4);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  margin-bottom: var(--s-4);
}

.code-box__code {
  font-family: var(--font-serif);
  font-size: var(--t-3xl);
  letter-spacing: 0.3em;
  color: var(--c-gold-strong);
}

.code-box__meta {
  display: flex;
  gap: var(--s-4);
  flex-wrap: wrap;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.expired,
.error {
  color: var(--c-danger, #b4342a);
}

.error {
  font-size: var(--t-sm);
  margin: 0 0 var(--s-3);
}

.steps {
  margin: 0;
  padding-left: var(--s-5);
  font-size: var(--t-sm);
  color: var(--c-text-muted);
  line-height: 1.8;
}

.steps code {
  font-family: var(--font-mono, monospace);
}
</style>
