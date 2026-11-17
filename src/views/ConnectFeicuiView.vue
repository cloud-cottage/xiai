<script setup>
/**
 * 連接斐萃（`/connect`）—— 斐萃令牌（管理員簽發）＋ **我的 API（本單新增）**
 *
 * 用途一（既有）：斐萃（本地電腦版）要調 yinyuan2026 的讀面 API，而 `YINYUAN_API_KEY` **只許待在 xiai 側**。
 * 斐萃改為持有一枚**璽愛簽發的 HMAC 令牌**（`v1.<payload>.<sig>`），打到本站的轉發路由
 * `/api/feicui/v1/<dynasties|authors|inscriptions>`；本站驗簽即確權，再帶**自己的** key 去取數。
 *
 * 用途二（本單新增）：「我的 API」—— 已登錄用戶自助管理 **AI 金鑰**（簽發 / 改限額 / 註銷）
 * 與 **餘額 / 用量窗口**；管理員另獲一張 **【上游配置】** 卡片（管理員動作鈎子值 `edit-ai-upstream`）。
 *
 * 本页硬口径：
 *   · **AI 用戶區對已登錄用戶開放**；未登錄 ⇒ 只顯示說明與登錄引導，**不發任何請求**；
 *   · **管理員能力 ＝ 普通頁面內多出的卡片**（`v-if="admin"` 條件渲染，非 CSS 隱藏）；
 *     服務端另有獨立管理員門（`adminWhitelistDenial`），前端前置**不是判據**；
 *   · 服務層**唯一入口** ＝ `src/services/aiAccess.js`（7 個 op 鍵面逐字；組件不直連雲函數）；
 *   · 金鑰明文**只在簽發回包裡出現一次**：本頁不落 localStorage / sessionStorage、不進日誌、
 *     不回填輸入框；關閉「僅顯示一次」區塊即從記憶體清除，**此後無法再取回**；
 *   · 金鑰是**憑證**：頁面明確提示「勿入版本庫、勿貼群」；
 *   · 斐萃令牌區（管理員簽發）**逐字沿用**改前三態（未登錄 / 非管理員 / 管理員簽發）。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { isAdmin, isLoggedIn } from '../data/session.js'
import { otpAuth, otpSessionAccessToken } from '../data/cloudbaseAuth.js'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import {
  FEICUI_DEVICE_TTL,
  FEICUI_FORWARD_PREFIX,
  FEICUI_RESOURCES,
  FEICUI_ROLES,
  FEICUI_TTL,
  FEICUI_TTL_OPTIONS,
  deliverTokenToHost,
  issueDeviceToken,
  issueToken,
  remainingSeconds
} from '../services/feicui.js'
/* **「我的 AI」唯一業務入口（本單新增）**：7 個 op 鍵面逐字在 `aiAccess.js`；
   本視圖只調它的**動詞函數**（`issueKey` / `listKeys` / …），不接觸任何 `op` 名字面值。 */
import * as aiAccess from '../services/aiAccess.js'
/* **內嵌登錄复用既有登錄服務**（本單新增）：取碼 / 登錄都走 `services/auth.js` 的**同一份**實現 ——
   視圖內不自造驗證碼路徑、不持有任何碼常量。`login` 別名為 `loginWithCode` 以免與本地 ref 同名。 */
import {
  CODE_RESEND_SECONDS,
  isPhoneLike,
  login as loginWithCode,
  loginCodeHint,
  requestCode
} from '../services/auth.js'
import { formatDateTime } from '../utils/format.js'

const logged = isLoggedIn
const admin = isAdmin

/* ===========================================================================
   ① 斐萃令牌（既有；逐字未動）
   =========================================================================== */
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

/* ===========================================================================
   ② 我的 API —— 用戶區（本單新增；所有已登錄用戶）
   =========================================================================== */
const aiBusy = ref(false)
const aiError = ref('')
/** 餘額 ＋ 用量窗口（取 `getAiUsage` 回包鍵 `points` / `today` / `minute`）。 */
const usage = ref(null)
/** 本人金鑰清單（`listAiKeys` 回包 `rows`；逐行零明文 —— 只有 `key_prefix`）。 */
const keys = ref([])

/* 生成新金鑰表單（預設 20 / 5，與服務端缺省同值）。 */
const issueOpen = ref(false)
const issueLabel = ref('')
const issueDay = ref(20)
const issueMinute = ref(5)
const issuing = ref(false)

/**
 * **一次性明文（唯一持有處）**：簽發成功後明文只進這一個 ref，並只在「僅顯示一次」區塊上屏；
 * `closeIssuedKey()` 置 `null` 即從記憶體清除 —— **不落任何存儲、不進日誌、不回填輸入框**，
 * 關閉後**無法再取回**（服務端庫內零明文，`listKeys` 亦只回前綴）。
 */
const issuedKey = ref(null)
const keyCopied = ref(false)

/* 改限額（行內編輯）。 */
const editingKeyId = ref('')
const editDay = ref(20)
const editMinute = ref(5)
const limitsBusy = ref(false)

/* 註銷二次確認（沿用倉內既有 `ConfirmDialog`）。 */
const revokeTarget = ref(null)
const revokeBusy = ref(false)

/** 服務端 reason → 可讀繁體提示（提示前綴；服務端 message 恆原樣並列上屏）。 */
const REASON_HINTS = aiAccess.AI_REASON_HINTS

function aiErrorText(reply) {
  const reason = String((reply && reply.reason) || '')
  const hint = REASON_HINTS[reason] || ''
  const message = String((reply && reply.message) || '').trim()
  if (hint && message) return `${hint}（服務端：${message}）`
  if (hint) return hint
  if (message) return `${reason ? `（${reason}）` : ''}${message}`
  return '操作失敗（未取得可讀原因）；請稍後再試。'
}

function statusLabel(status) {
  return status === 'ACTIVE' ? '有效' : '已註銷'
}

/** 用戶區唯一讀入口（**未登錄零請求**：本函數守衛在先；請求函數只從這裡 / 各守衛後進入）。 */
async function refreshAiPanel() {
  if (!logged.value) return
  aiBusy.value = true
  aiError.value = ''
  const usageReply = await aiAccess.readUsage()
  const keysReply = await aiAccess.listKeys()
  if (usageReply.ok) {
    usage.value = { points: usageReply.points, today: usageReply.today, minute: usageReply.minute }
  }
  if (keysReply.ok) keys.value = Array.isArray(keysReply.rows) ? keysReply.rows : []
  const failed = !usageReply.ok ? usageReply : !keysReply.ok ? keysReply : null
  if (failed) aiError.value = aiErrorText(failed)
  aiBusy.value = false
  if (admin.value) loadUpstream()
}

/* 登錄態變化（含掛載即已登錄）⇒ 才拉取；未登錄**永不觸發**任何請求。 */
watch(logged, (value) => {
  if (value) refreshAiPanel()
}, { immediate: true })

function toggleIssueForm() {
  issueOpen.value = !issueOpen.value
}

async function onGenerateKey() {
  if (!logged.value) return
  if (issuing.value) return
  issuing.value = true
  aiError.value = ''
  const reply = await aiAccess.issueKey({
    label: issueLabel.value,
    day_limit: issueDay.value,
    minute_limit: issueMinute.value
  })
  issuing.value = false
  if (!reply.ok) {
    aiError.value = aiErrorText(reply)
    return
  }
  /* 明文只進一次性區塊（唯一上屏處）；表單收起、備註欄清空（明文**不回填**任何輸入框）。 */
  issuedKey.value = {
    key: reply.key,
    key_id: reply.key_id,
    key_prefix: reply.key_prefix,
    label: reply.label,
    day_limit: reply.day_limit,
    minute_limit: reply.minute_limit,
    created_at: reply.created_at
  }
  keyCopied.value = false
  issueOpen.value = false
  issueLabel.value = ''
  refreshAiPanel()
}

async function onCopyIssuedKey() {
  if (!issuedKey.value) return
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(issuedKey.value.key)
    }
    keyCopied.value = true
  } catch {
    keyCopied.value = false
    aiError.value = '無法自動複製，請在上方文字框內全選後手動複製。'
  }
}

/** 一次性明文的**唯一清除點**：關閉即置 `null`（記憶體引用一併釋放；不落任何存儲）。 */
function closeIssuedKey() {
  issuedKey.value = null
  keyCopied.value = false
}

function startEditLimits(row) {
  editingKeyId.value = row.key_id
  editDay.value = row.day_limit
  editMinute.value = row.minute_limit
  aiError.value = ''
}

function cancelEditLimits() {
  editingKeyId.value = ''
}

async function onSaveLimits() {
  if (!logged.value) return
  if (limitsBusy.value) return
  const keyId = editingKeyId.value
  if (!keyId) return
  limitsBusy.value = true
  const reply = await aiAccess.updateKeyLimits({
    key_id: keyId,
    day_limit: editDay.value,
    minute_limit: editMinute.value
  })
  limitsBusy.value = false
  if (!reply.ok) {
    aiError.value = aiErrorText(reply)
    return
  }
  editingKeyId.value = ''
  refreshAiPanel()
}

const revokeMessage = computed(() => {
  const row = revokeTarget.value
  if (!row) return ''
  return `確定註銷 ${row.key_prefix}…（${row.label || '無備註'}）？註銷後立即失效，且不可撤回。`
})

function askRevoke(row) {
  revokeTarget.value = row
  aiError.value = ''
}

function cancelRevoke() {
  revokeTarget.value = null
}

async function confirmRevoke() {
  if (!logged.value) return
  const row = revokeTarget.value
  if (!row || revokeBusy.value) return
  revokeBusy.value = true
  const reply = await aiAccess.revokeKey(row.key_id)
  revokeBusy.value = false
  revokeTarget.value = null
  if (!reply.ok) {
    aiError.value = aiErrorText(reply)
    return
  }
  refreshAiPanel()
}

/* ===========================================================================
   ③ 管理員區 —— 【上游配置】卡片（條件渲染；本需求唯一新增的管理員動作取值）
   =========================================================================== */
const upstreamBusy = ref(false)
const upstreamError = ref('')
const upstreamNotice = ref('')
/** 讀取面（`getAiUpstream`；**只回 `key_mask`**）。 */
const upstreamView = ref(null)
const upstreamForm = reactive({ base_url: '', model: '', key: '', timeout_ms: 60000 })

async function loadUpstream() {
  if (!admin.value) return
  upstreamError.value = ''
  const reply = await aiAccess.readUpstream()
  if (!reply.ok) {
    upstreamError.value = aiErrorText(reply)
    return
  }
  upstreamView.value = {
    base_url: reply.base_url,
    model: reply.model,
    key_mask: reply.key_mask,
    timeout_ms: reply.timeout_ms,
    updated_at: reply.updated_at
  }
  /* 回填表單（**金鑰欄永不同填** —— 服務端只回遮罩，明文不可取回）。 */
  upstreamForm.base_url = reply.base_url || ''
  upstreamForm.model = reply.model || ''
  upstreamForm.timeout_ms = reply.timeout_ms || aiAccess.AI_LIMIT_RANGES.timeoutMs.def
  upstreamForm.key = ''
}

async function onSaveUpstream() {
  if (!admin.value) return
  if (upstreamBusy.value) return
  upstreamBusy.value = true
  upstreamError.value = ''
  upstreamNotice.value = ''
  const reply = await aiAccess.writeUpstream({
    base_url: upstreamForm.base_url,
    model: upstreamForm.model,
    key: upstreamForm.key,
    timeout_ms: upstreamForm.timeout_ms
  })
  if (!reply.ok) {
    upstreamBusy.value = false
    upstreamError.value = aiErrorText(reply)
    return
  }
  /* 金鑰明文用後即清（不留在輸入框）。 */
  upstreamForm.key = ''
  upstreamNotice.value = '已保存；正在重讀配置…'
  /* **保存後重讀一次**，並上屏服務端回的遮罩。 */
  const fresh = await aiAccess.readUpstream()
  upstreamBusy.value = false
  if (!fresh.ok) {
    upstreamError.value = aiErrorText(fresh)
    return
  }
  upstreamView.value = {
    base_url: fresh.base_url,
    model: fresh.model,
    key_mask: fresh.key_mask,
    timeout_ms: fresh.timeout_ms,
    updated_at: fresh.updated_at
  }
  upstreamForm.base_url = fresh.base_url || ''
  upstreamForm.model = fresh.model || ''
  upstreamForm.timeout_ms = fresh.timeout_ms || aiAccess.AI_LIMIT_RANGES.timeoutMs.def
  upstreamNotice.value = `已保存；服務端回報的金鑰遮罩：${fresh.key_mask || '（空）'}`
}

/* ===========================================================================
   ④ 管理員區 —— 【斐萃桌面授權】卡片（跨倉契約 §13.2；條件渲染，非 CSS 隱藏）
   ---------------------------------------------------------------------------
   兩條簽發路（**並存**；本單新增第二條）：
     · 【簽發設備令牌】＝ 30 天（服務端缺省），令牌一次性顯示，由人複製後在**本機**寫入授權文件；
     · 【為斐翠桌面簽發 8 小時會話】＝ `ttl_seconds ＝ 28800`（**登錄即授權**）：
       簽發成功 ⇒ 先探宿主橋（pywebview → wails → 通用），有橋就**當場交付**給 App
       （`receive_feicui_token(token, {expires_at, ttl_seconds})`）並**立刻清掉 DOM 裡的明文**；
       無橋 / 橋拋錯 ⇒ 回退到與 30 天路同一套「一次性顯示 ＋ 一鍵複製」（**令牌不丟**）。

   安全硬約束（逐條）：
     · 令牌**只保存在本組件的一個 ref**（`deviceToken`）—— 不落任何前端持久層
       （本地存儲 / 會話存儲 / 瀏覽器資料庫 / cookie）、不進網址（query / hash）、
       不打日誌；頁面重新整理即重新申請（服務端零落盤，舊令牌只能被新令牌覆寫）；
     · 每次請求**先清舊值**再發 ⇒ 失敗路徑**零令牌上屏**（不會殘留上一枚）；
     · 非管理員：入口本身不渲染（`v-if="admin"`），並在動作首行前置短路、零請求；
     · **為何必須與登錄同一頁面加載**：`/connect` 的 OTP 登錄用 `persistence:'none'`
       （第三個 app 實例）⇒ 手機號會話**只在頁面記憶體**、刷新即丟；故簽發必須在
       登錄後的同一次頁面加載內完成 —— 頁面文案已寫明「若刷新本頁需重新登錄後再簽」。
   =========================================================================== */
const deviceBusy = ref(false)
const deviceError = ref('')
const deviceCopied = ref(false)
/** **令牌唯一持有處**：`{token, expires_at}`（成功回包恰 3 鍵，`ok` 不外存）。 */
const deviceToken = ref(null)
/** 8 小時會話的 TTL（服务端 clamp 上界的同值镜像：`FEICUI_DEVICE_TTL.sessionSeconds`）。 */
const DEVICE_SESSION_TTL_SECONDS = FEICUI_DEVICE_TTL.sessionSeconds
/** 宿主橋已交付（令牌明文**已從 DOM 清掉**；此後頁面只顯示「已交付」）。 */
const deviceDelivered = ref(false)

/** 服務端 reason → 可讀繁體提示（**只作前綴；服務端 message 恆原樣並列上屏**）。 */
const DEVICE_REASON_HINTS = Object.freeze({
  FORBIDDEN: '權限不足：僅管理員可以簽發斐萃桌面授權。',
  NOT_ADMIN: '僅管理員可以簽發斐萃桌面授權。',
  LOGIN_REQUIRED: '請先登錄後再申請桌面授權。',
  STORAGE_UNAVAILABLE: '雲端暫時不可用，請稍後再試。',
  INVALID_VALUE: '有效期（ttl_seconds）不合法（需 300〜43200 的整數秒）。',
  TIMEOUT: '請求逾時，請稍後再試。'
})

/** 失敗文案：hint ＋ 服務端 message（**不含任何令牌片段**；內部細節只到 reason / message）。 */
function deviceErrorText(reply) {
  const reason = String((reply && reply.reason) || '')
  const hint = DEVICE_REASON_HINTS[reason] || ''
  const message = String((reply && reply.message) || '').trim()
  if (hint && message) return `${hint}（服務端：${message}）`
  if (hint) return hint
  if (message) return message
  return '簽發失敗（未取得可讀原因）；請稍後再試。'
}

async function onIssueDeviceToken() {
  if (!admin.value) return /* 非管理員：零請求（前端前置；服務端另有獨立門） */
  if (deviceBusy.value) return
  deviceBusy.value = true
  deviceError.value = ''
  deviceCopied.value = false
  deviceDelivered.value = false /* 交付態只屬於 8 小時會話路；30 天路簽發時一併收起 */
  deviceToken.value = null /* **先清** ⇒ 任何失敗路徑都不殘留舊令牌 */
  const reply = await issueDeviceToken()
  deviceBusy.value = false
  if (!reply.ok) {
    deviceError.value = deviceErrorText(reply)
    /* **失败即自愈**（真机复现后加）：把内嵌登录表单放出来，并允许登录后再签一次。
       原因：判据「otpSessionAccessToken() 非空 且 logged」会被「匿名平台会话 ＋ 持久化的
       App 登录态」同时满足 ⇒ 跳过表单直接签发 ⇒ 服务端必然回「未攜帶有效令牌」；
       而失败后原先不再给表单，用户就卡死在这条路上（点了也只会重复报错）。 */
    otpSessionPresent.value = false
    loginRequired.value = true
    autoIssueAttempted.value = false
    return
  }
  deviceToken.value = { token: reply.token, expires_at: reply.expires_at }
}

/** `renewal_source` 的**封闭枚举**（诊断用，不作判据、不上屏）。 */
const RENEWAL_SOURCES = Object.freeze({
  session: 'session',
  loginState: 'loginState',
  fallback: 'fallback',
  none: 'none'
})

/**
 * **续签凭据（三源尝试｜本单修订）**：`refresh_token` / `phone` 本来就在当前 OTP 会话里，
 * 但不同 SDK 版本 / 不同登录路径把它暴露在不同的读数面上 ⇒ 按优先级逐源尝试，**任一得手即用**：
 *   ① `otpAuth().getSession()` → `data.session.refresh_token`（初版唯一读法；真机取不到）；
 *   ② `otpAuth().getLoginState()` → `credentials.refresh_token`；
 *   ③ **同一 auth 实例**再 `getSession()` 一次，按**备用形状**读（`reply.session` /
 *      `reply.data` 本体 / `reply.currentSession`）—— 不新建实例、不新建会话。
 * 三源全空 ⇒ 空串，**不阻断交付**（桌面端按无凭据降级成「每次登录」并自己说明）。
 *
 * 硬口径（逐条，与本单前一致）：
 *   · **不上屏**：不进任何 ref / 模板 / 错误文案（只在交付那一刻随 `meta` 离开）；
 *   · **不落任何持久层**：不写本地 / 会话存储、IndexedDB、cookie，不进 url，不打日志；
 *   · 手动复制回退路径不带它（`onCopyDeviceToken` 只复制设备令牌）。
 * `phone` 同样多源（`session.user.phone_number` → `loginState.user.phone`），只作钥匙串上的标签，
 * **不是判据**（服务端一律用平台验签后的手机号）。
 * `renewal_source` 只描述「这次从哪个源命中」：`session` / `loginState` / `fallback` / `none`
 * —— **诊断枚举而已，不据此放行、不据此拒绝、不上屏**。
 * @returns {Promise<{refresh_token:string, phone:string, renewal_source:string}>}
 */
async function sessionRenewalMeta() {
  const out = { refresh_token: '', phone: '', renewal_source: RENEWAL_SOURCES.none }
  /* 一个读数面 → `{refresh_token, phone}`（形状归一；phone 只认 11 位大陆号）。 */
  const pairOf = (holder) => {
    const source = holder && typeof holder === 'object' ? holder : {}
    const refresh = String(source.refresh_token || source.refreshToken || '').trim()
    const user = source.user && typeof source.user === 'object' ? source.user : source
    const rawPhone = (user && (user.phone_number || user.phone || user.phoneNumber)) || ''
    const phone = String(rawPhone).trim()
    return { refresh_token: refresh, phone: isPhoneLike(phone) ? phone : '' }
  }

  let auth = null
  try {
    auth = await otpAuth()
  } catch {
    auth = null
  }
  if (!auth || typeof auth !== 'object') return out

  /* ① 会话面（初版读法）：`reply.data.session` */
  let sessionReply = null
  if (typeof auth.getSession === 'function') {
    try {
      sessionReply = await auth.getSession()
    } catch {
      sessionReply = null
    }
  }
  let loginState = null
  let loginStateTried = false
  /* ② 登录状态面（惰性读一次；phone 也复用它）。 */
  const loginPair = async () => {
    if (loginStateTried) {
      return pairOf(loginState && (loginState.credentials || loginState))
    }
    loginStateTried = true
    if (typeof auth.getLoginState !== 'function') return pairOf(null)
    try {
      loginState = await auth.getLoginState()
    } catch {
      loginState = null
    }
    return pairOf(loginState && (loginState.credentials || loginState))
  }

  const fromSession = pairOf(sessionReply && sessionReply.data ? sessionReply.data.session : null)
  if (fromSession.refresh_token !== '') {
    out.refresh_token = fromSession.refresh_token
    out.phone = fromSession.phone || (await loginPair()).phone
    out.renewal_source = RENEWAL_SOURCES.session
    return out
  }

  const fromLogin = await loginPair()
  if (fromLogin.refresh_token !== '') {
    out.refresh_token = fromLogin.refresh_token
    out.phone = fromLogin.phone || fromSession.phone
    out.renewal_source = RENEWAL_SOURCES.loginState
    return out
  }

  /* ③ 兜底：**同一实例**再取一次会话，按备用形状读（不新建 auth、不重新登录）。 */
  let retryReply = sessionReply
  if (typeof auth.getSession === 'function') {
    try {
      retryReply = await auth.getSession()
    } catch {
      retryReply = sessionReply
    }
  }
  const fallbackHolder =
    (retryReply && (retryReply.session || retryReply.currentSession)) ||
    (retryReply && retryReply.data && !retryReply.data.session ? retryReply.data : null) ||
    (auth.currentSession && typeof auth.currentSession === 'object' ? auth.currentSession : null) ||
    null
  const fromFallback = pairOf(fallbackHolder)
  if (fromFallback.refresh_token !== '') {
    out.refresh_token = fromFallback.refresh_token
    out.phone = fromFallback.phone || fromSession.phone || fromLogin.phone
    out.renewal_source = RENEWAL_SOURCES.fallback
  }
  return out
}

/**
 * **8 小時會話（登錄即授權｜本單新增）**：簽發 → 交付宿主橋 → **清掉頁面明文**。
 *
 * 順序（每步都可被判據釘住）：
 *   ① 首行 admin 守衛 ＋ 在途去重（非管理員零請求）；
 *   ② **先清**上一次的令牌 / 交付態 / 錯誤（失敗路徑零殘留）；
 *   ③ 簽發 `ttl_seconds ＝ 28800`（服務端 clamp `[300, 43200]`）；
 *   ④ 成功 ⇒ 令牌進唯一持有處 `deviceToken`（與 30 天路同一文本域，仍是**唯一上屏處**）；
 *   ⑤ `deliverTokenToHost()`：pywebview → wails → 通用，有橋就交付
 *      `(token, {expires_at, ttl_seconds, refresh_token, phone, renewal_source})` ——
 *      **後三键是续签凭据 ＋ 诊断枚举**（取自当前 OTP 会话，见 `sessionRenewalMeta`；
 *      空串键不下发 ⇒ 桌面端自行降级；`renewal_source` 只作运维诊断，不参与判定）；
 *      **無橋 / 橋拋錯 ⇒ 不動令牌**，回退一鍵複製；
 *   ⑥ 交付成功 ⇒ `deviceDelivered = true` 並 `clearDeviceToken()` —— **DOM 不再含令牌明文**。
 */
async function onIssueSessionToken() {
  if (!admin.value) return
  if (deviceBusy.value) return
  /* **幂等门（本单新增）**：本页加载内已经签过（已交付 / 令牌在手）⇒ 不再签第二枚。
     自动（挂载 / 登录成功）与手动按钮**共用这一道门** ⇒ 两者不会各签一枚。 */
  if (deviceDelivered.value || deviceToken.value !== null) return
  deviceBusy.value = true
  deviceError.value = ''
  deviceCopied.value = false
  deviceDelivered.value = false
  clearDeviceToken()
  const reply = await issueDeviceToken({ ttlSeconds: DEVICE_SESSION_TTL_SECONDS })
  deviceBusy.value = false
  if (!reply.ok) {
    deviceError.value = deviceErrorText(reply)
    return
  }
  /* 与 30 天路同一持有形状 `{token, expires_at}`（複用同一張只讀文本域 ⇒ 上屏處仍恰 1 處）。 */
  deviceToken.value = { token: String(reply.token), expires_at: String(reply.expires_at) }
  /* **续签凭据（本单新增）**：只进桥 `meta`；三源全空 ⇒ 空串（不阻断交付，降级为纯 8 小时会话）。 */
  let renewal = { refresh_token: '', phone: '', renewal_source: RENEWAL_SOURCES.none }
  try {
    renewal = await sessionRenewalMeta()
  } catch {
    renewal = { refresh_token: '', phone: '', renewal_source: RENEWAL_SOURCES.none }
  }
  const delivery = await deliverTokenToHost(reply.token, {
    expires_at: reply.expires_at,
    ttl_seconds: DEVICE_SESSION_TTL_SECONDS,
    refresh_token: renewal.refresh_token,
    phone: renewal.phone,
    /* 诊断枚举：**不参与判定**，只让运维知道这次凭据从哪个源命中（桌面端不回显、不上屏）。 */
    renewal_source: renewal.renewal_source || RENEWAL_SOURCES.none
  })
  /* 無橋 / 橋拋錯 ⇒ **不改令牌**，落回「一次性顯示 ＋ 一鍵複製」（令牌不丟）。 */
  if (!delivery.delivered) return
  deviceDelivered.value = true
  /* **交付即清**：令牌已交宿主，頁面不留明文（DOM 由 `v-if="deviceToken"` 整塊收掉）。 */
  clearDeviceToken()
}

async function onCopyDeviceToken() {
  if (!deviceToken.value) return
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(deviceToken.value.token)
    }
    deviceCopied.value = true
  } catch {
    /* 剪貼板不可用 ⇒ 如實提示手動選取（不假裝已複製） */
    deviceCopied.value = false
    deviceError.value = '無法自動複製，請在上方文字框內全選後手動複製。'
  }
}

/** 令牌**唯一清除點**：置 `null` 即從記憶體釋放。 */
function clearDeviceToken() {
  deviceToken.value = null
  deviceCopied.value = false
}

/* 離開頁面亦清（記憶體釋放；不影響任何持久層）。 */
onUnmounted(clearDeviceToken)

/* ===========================================================================
   ⑤ 登錄即授權 —— **內嵌登錄 ＋ 掛載即自動簽發**（本單新增：零第二下點擊）
   ---------------------------------------------------------------------------
   触发条件（恰好两处，且**互相幂等**）：
     · **挂载**：`bootstrapDesktopAuthorization()` 取 `otpSessionAccessToken()`
         - 非空（本页内存里确有有效 OTP 会话）⇒ 立即 `autoIssueOnce()` ⇒ 签发
           `ttl_seconds = 28800`，有宿主桥即**当场交付**并清掉 DOM 明文；
         - 空 ⇒ `loginRequired = true` ⇒ 渲染内嵌登录表单（**不签发、零请求**）。
     · **内嵌登录成功**：`onInlineLogin()` 在**同一次页面加载内**直接 `autoIssueOnce()`
       —— 不跳转、不需第二下点击。
   幂等：`onIssueSessionToken()` 的「已交付 / 令牌在手 ⇒ 早退」门 ＋ `autoIssueAttempted`
   旗标 ⇒ 自动与手动**不会各签一枚**；手动按钮保留作回退（会话取不到 / 签发失败时重试）。

   硬约束（与 ④ 同一套，逐条）：
     · 手机号 / 验证码 / 令牌**只在内存**：不写本地存儲 / 會話存儲 / 浏览器数据库 / cookie，
       不进网址，不打日志；登录成功后**立刻清空表单明文**（验证码是一次性凭据）；
     · 失败**不静默**：取码 / 登录 / 签发三条路径各自把可见文案落到 `loginError` /
       `deviceError`（服务端 `message` 原样并列上屏）；
     · 本视图**不自造验证码路径**：取码 / 登录一律走 `services/auth.js` 的同一份实现。
   =========================================================================== */
const autoIssueAttempted = ref(false)
const sessionProbing = ref(true)
const otpSessionPresent = ref(false)
const loginRequired = ref(false)
const loginPhone = ref('')
const loginCode = ref('')
const loginBusy = ref(false)
const loginError = ref('')
const loginNotice = ref('')
const codeBusy = ref(false)
const codeCooldown = ref(0)
let codeTimer = null
const loginCodeHintText = loginCodeHint()

/** 取码冷却的唯一启停点（前端体验层；**不是**服务端频控判据）。 */
function stopCooldown() {
  if (codeTimer !== null) {
    clearInterval(codeTimer)
    codeTimer = null
  }
}

function startCooldown(seconds) {
  stopCooldown()
  const total = Math.floor(Number(seconds) || 0)
  codeCooldown.value = total > 0 ? total : 0
  if (codeCooldown.value <= 0) return
  codeTimer = setInterval(() => {
    codeCooldown.value -= 1
    if (codeCooldown.value <= 0) {
      codeCooldown.value = 0
      stopCooldown()
    }
  }, 1000)
}

const codeButtonLabel = computed(() => {
  if (codeBusy.value) return '發送中…'
  if (codeCooldown.value > 0) return `${codeCooldown.value} 秒後可重發`
  return '獲取驗證碼'
})

/** 取短訊驗證碼（复用 `auth.requestCode`；失败原文上屏，频控带 `retryAfter` 起冷却）。 */
async function onRequestLoginCode() {
  if (codeBusy.value || codeCooldown.value > 0) return
  loginError.value = ''
  loginNotice.value = ''
  if (!isPhoneLike(loginPhone.value)) {
    loginError.value = '請輸入 11 位手機號。'
    return
  }
  codeBusy.value = true
  const reply = await requestCode(loginPhone.value)
  codeBusy.value = false
  if (!reply.ok) {
    loginError.value = reply.message || '驗證碼發送失敗，請稍後再試。'
    if (reply.retryAfter) startCooldown(reply.retryAfter)
    return
  }
  loginNotice.value = reply.message || '驗證碼已發送至你填寫的手機號，請查收短訊。'
  startCooldown(reply.cooldownSeconds || CODE_RESEND_SECONDS)
}

/**
 * **自动签发**的唯一调用点（幂等：本页加载内只跑一次）。
 * 供两条触发路径共用：挂载探测命中 / 内嵌登录成功。
 */
async function autoIssueOnce() {
  if (autoIssueAttempted.value) return
  autoIssueAttempted.value = true
  await onIssueSessionToken()
}

/**
 * 内嵌登录（`/connect` 页内完成，**不跳转**）。
 *
 * 顺序固定：① 形态校验（就地拒、零请求）② 复用 `auth.login`（平台判）
 * ③ 成功 ⇒ **清空表单明文** ＋ 收起表单（`loginRequired = false`）
 * ④ `autoIssueOnce()` ⇒ 同一页面加载内自动签发并交付（无需第二下点击）。
 */
async function onInlineLogin() {
  if (loginBusy.value) return
  loginError.value = ''
  if (!isPhoneLike(loginPhone.value)) {
    loginError.value = '請輸入 11 位手機號。'
    return
  }
  if (String(loginCode.value).trim() === '') {
    loginError.value = '請輸入短訊驗證碼。'
    return
  }
  loginBusy.value = true
  const reply = await loginWithCode(loginPhone.value, loginCode.value)
  loginBusy.value = false
  if (!reply.ok) {
    loginError.value = reply.message || '登錄失敗，請重新獲取驗證碼後再試。'
    return
  }
  /* 登录成功：表单明文立刻清空（验证码一次性；手机号同样不留在 DOM）。 */
  loginCode.value = ''
  loginPhone.value = ''
  loginNotice.value = ''
  stopCooldown()
  otpSessionPresent.value = true
  loginRequired.value = false
  /* 登录成功后必须**允许再签一次**：挂载那次尝试可能已经把 autoIssueAttempted 置 true（并失败）。 */
  autoIssueAttempted.value = false
  await autoIssueOnce()
}

/**
 * **挂载即判**（自动签发的唯一挂载触发点；本页只绑在 `onMounted` 恰 1 处）。
 *
 * 读取的是**当前页面内存里的 OTP 会话**（`persistence:'none'`）：取不到 ⇒ 只显示内嵌登录表单，
 * **零签发请求**；取到 ⇒ 立即自动签发（`ttl_seconds = 28800`）。
 *
 * **两个条件取「与」（实测踩过）**：`otpSessionAccessToken()` 非空 **且** 本页确实是登录态
 * （`logged`）。只判非空会把**匿名平台会话**当成已登录 —— SDK 的匿名会话同样给出一枚
 * `access_token`（读面登录匿名后浏览器里就有），症状是「登录表单不出现、也没签发」的空白页。
 * @returns {Promise<{session:boolean, issued:boolean}>} 结构化读数（自检用；不上屏、不含令牌）
 */
async function bootstrapDesktopAuthorization() {
  sessionProbing.value = true
  const present = (await otpSessionAccessToken()) !== '' && logged.value
  sessionProbing.value = false
  otpSessionPresent.value = present
  loginRequired.value = !present
  if (!present) return { session: false, issued: false }
  await autoIssueOnce()
  return { session: true, issued: true }
}

onMounted(bootstrapDesktopAuthorization)
onUnmounted(stopCooldown)
</script>

<template>
  <section>
    <div class="page-head">
      <h1>斐萃令牌</h1>
      <p>
        為斐萃桌面版簽發一枚令牌；斐萃拿它調本機轉發接口，<b>上游密鑰始終不離開璽愛</b>。
        本頁同時提供「我的 API」：自助管理 AI 金鑰、金餘額與用量（管理員另可配置上游）。
      </p>
    </div>

    <!-- ================= 登錄即授權：無 OTP 會話時顯示**內嵌登錄**（登錄成功即在同一頁面自動簽發） ================= -->
    <section v-if="loginRequired || sessionProbing" class="panel" data-feicui-login-gate>
      <div class="panel__head">
        <h2>登錄即授權（斐翠桌面）</h2>
      </div>
      <div class="panel__body">
        <p class="hint">
          在本頁登錄後，系統會<b>自動為斐翠桌面簽發一枚 8 小時會話並直接交付</b>，不需要再按任何按鈕。
          <b>登錄後將自動簽發並交付桌面版；刷新本頁需重新登錄</b>
          （本頁的登錄會話只存在頁面記憶體，不落任何本地存儲）。
        </p>
        <p v-if="sessionProbing" class="hint" data-feicui-login-probing>正在檢查本頁的登錄會話…</p>
        <form v-else class="form" data-feicui-login-form @submit.prevent="onInlineLogin">
          <label class="field">
            <span class="field__label">手機號（11 位）</span>
            <input v-model.trim="loginPhone" class="field__input" type="tel" inputmode="numeric"
              autocomplete="off" spellcheck="false" placeholder="13800000000" data-feicui-login-phone />
          </label>
          <label class="field">
            <span class="field__label">短訊驗證碼（6 位數字）</span>
            <input v-model.trim="loginCode" class="field__input" type="text" inputmode="numeric"
              autocomplete="one-time-code" spellcheck="false" placeholder="6 位數字" data-feicui-login-code />
          </label>
          <p class="hint">{{ loginCodeHintText }}</p>
          <div class="ai-head-actions">
            <button class="btn btn--ghost" type="button" data-action="feicui-login-code"
              :disabled="codeBusy || codeCooldown > 0" @click="onRequestLoginCode">
              {{ codeButtonLabel }}
            </button>
            <button class="btn" type="submit" data-action="feicui-login-submit" :disabled="loginBusy">
              {{ loginBusy ? '登錄中…' : '登錄並自動簽發' }}
            </button>
          </div>
        </form>
        <p v-if="loginNotice" class="hint" data-feicui-login-notice>{{ loginNotice }}</p>
        <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
      </div>
    </section>

    <!-- ================= 未登錄：AI 區塊只顯示說明 ＋ 登錄引導（**零請求**） ================= -->
    <section v-if="!logged" class="panel" data-ai-anon-panel>
      <div class="panel__head">
        <h2>我的 API</h2>
      </div>
      <div class="panel__body">
        <p class="hint">
          「我的 API」讓你自助簽發 <b>AI 金鑰</b>（<code>sk-xiai-…</code>）、查看金餘額與用量窗口；
          金鑰是<b>憑證</b>，簽發明文只顯示一次。斐萃令牌另由管理員簽發。
        </p>
        <p class="hint">請先登錄；本頁在未登錄狀態<b>不會發出任何請求</b>。</p>
        <router-link class="btn" :to="{ name: 'login', query: { redirect: '/connect' } }">前往登錄</router-link>
      </div>
    </section>

    <template v-else>
      <!-- ================= 已登錄 · 我的 API 用戶區（與斐萃令牌區塊並列；二級標題分隔） ================= -->
      <section class="panel" data-ai-user-panel>
        <div class="panel__head">
          <h2>我的 API（金鑰 / 餘額 / 用量）</h2>
          <div class="ai-head-actions">
            <button class="btn btn--ghost" type="button" data-action="ai-refresh" :disabled="aiBusy" @click="refreshAiPanel">
              {{ aiBusy ? '讀取中…' : '重新讀取' }}
            </button>
            <button class="btn" type="button" data-action="ai-issue-toggle" :disabled="aiBusy" @click="toggleIssueForm">
              {{ issueOpen ? '收起' : '生成新金鑰' }}
            </button>
          </div>
        </div>
        <div class="panel__body">
          <!-- 餘額（金）＋ 今日用量與日限 ＋ 分鐘用量與分鐘限（取 getAiUsage 回包鍵） -->
          <dl v-if="usage" class="usage" data-ai-usage>
            <div class="usage__cell">
              <dt>餘額（金）</dt>
              <dd class="usage__gold">{{ usage.points }}</dd>
            </div>
            <div class="usage__cell">
              <dt>今日用量 / 日限</dt>
              <dd>{{ usage.today.used }} / {{ usage.today.limit }}</dd>
            </div>
            <div class="usage__cell">
              <dt>分鐘用量 / 分鐘限</dt>
              <dd>{{ usage.minute.used }} / {{ usage.minute.limit }}</dd>
            </div>
          </dl>
          <p v-else-if="!aiError" class="hint">正在讀取餘額與用量…</p>

          <!-- 一次性明文區塊（**唯一上屏處**；關閉即清，此後無法取回） -->
          <div v-if="issuedKey" class="token-box" data-ai-key-once>
            <div class="token-box__head">
              <span class="token-box__title">金鑰（只顯示這一次）</span>
              <button class="btn btn--ghost" type="button" data-action="ai-key-copy" @click="onCopyIssuedKey">
                {{ keyCopied ? '已複製' : '複製金鑰' }}
              </button>
            </div>
            <textarea class="token-box__token" data-ai-key-plaintext readonly rows="3" :value="issuedKey.key"></textarea>
            <dl class="token-box__meta">
              <div><dt>金鑰標識</dt><dd class="mono">{{ issuedKey.key_id }}</dd></div>
              <div><dt>前綴</dt><dd class="mono">{{ issuedKey.key_prefix }}</dd></div>
              <div><dt>備註</dt><dd>{{ issuedKey.label || '（無）' }}</dd></div>
              <div><dt>日限 / 分鐘限</dt><dd>{{ issuedKey.day_limit }} / {{ issuedKey.minute_limit }}</dd></div>
              <div><dt>建立時間</dt><dd>{{ formatDateTime(issuedKey.created_at) }}</dd></div>
            </dl>
            <p class="warn">
              這是<b>憑證</b>：<b>只顯示這一次</b>，關閉後無法再取回（服務端只存雜湊）。
              請立即粘進你的調用端，<b>勿入版本庫、勿貼群、勿截圖外傳</b>。
            </p>
            <div class="token-box__head">
              <button class="btn" type="button" data-action="ai-key-once-close" @click="closeIssuedKey">我已保存，關閉</button>
            </div>
          </div>

          <!-- 生成新金鑰表單（label / 日限 / 分鐘限；預設 20 / 5） -->
          <div v-if="issueOpen" class="form" data-ai-issue-form>
            <label class="field">
              <span class="field__label">備註 label（可空，最多 40 字）</span>
              <input v-model.trim="issueLabel" class="field__input" type="text" autocomplete="off" spellcheck="false"
                placeholder="例如：本機畫像站" />
            </label>
            <label class="field">
              <span class="field__label">日限（次 / 日；1〜1000，預設 20）</span>
              <input v-model.number="issueDay" class="field__input" type="number" min="1" max="1000" step="1" />
            </label>
            <label class="field">
              <span class="field__label">分鐘限（次 / 分鐘；1〜120，預設 5）</span>
              <input v-model.number="issueMinute" class="field__input" type="number" min="1" max="120" step="1" />
            </label>
            <div>
              <button class="btn" type="button" data-action="ai-issue-submit" :disabled="issuing" @click="onGenerateKey">
                {{ issuing ? '簽發中…' : '生成' }}
              </button>
            </div>
          </div>

          <!-- 金鑰列表（key_prefix / 備註 / 狀態 / 兩個限額 / 建立時間；操作＝改限額 / 註銷） -->
          <ul v-if="keys.length" class="key-list" data-ai-key-list>
            <li v-for="row in keys" :key="row.key_id" class="key-row" :data-ai-key-status="row.status">
              <div class="key-row__main">
                <span class="mono key-row__prefix">{{ row.key_prefix }}…</span>
                <span class="key-row__label">{{ row.label || '（無備註）' }}</span>
                <span class="key-row__status" :class="row.status === 'ACTIVE' ? 'key-row__status--on' : 'key-row__status--off'">
                  {{ statusLabel(row.status) }}
                </span>
                <span class="hint">日限 {{ row.day_limit }} · 分鐘限 {{ row.minute_limit }} · 建立 {{ formatDateTime(row.created_at) }}</span>
              </div>
              <div v-if="row.status === 'ACTIVE'" class="key-row__ops">
                <template v-if="editingKeyId === row.key_id">
                  <label class="key-row__inline">
                    <span class="field__label">日限</span>
                    <input v-model.number="editDay" class="field__input" type="number" min="1" max="1000" step="1" />
                  </label>
                  <label class="key-row__inline">
                    <span class="field__label">分鐘限</span>
                    <input v-model.number="editMinute" class="field__input" type="number" min="1" max="120" step="1" />
                  </label>
                  <button class="btn" type="button" data-action="ai-limits-save" :disabled="limitsBusy" @click="onSaveLimits">
                    {{ limitsBusy ? '儲存中…' : '儲存' }}
                  </button>
                  <button class="btn btn--ghost" type="button" data-action="ai-limits-cancel" @click="cancelEditLimits">取消</button>
                </template>
                <template v-else>
                  <button class="btn btn--ghost" type="button" data-action="ai-limits-edit" @click="startEditLimits(row)">改限額</button>
                  <button class="btn btn--ghost" type="button" data-action="ai-key-revoke" @click="askRevoke(row)">註銷</button>
                </template>
              </div>
            </li>
          </ul>
          <p v-else-if="!aiError" class="hint">尚無 AI 金鑰；按上方【生成新金鑰】自助簽發一枚。</p>

          <p v-if="aiError" class="error" role="alert">{{ aiError }}</p>
        </div>
      </section>

      <!-- ================= 管理員區：【上游配置】卡片（條件渲染，非 CSS 隱藏） ================= -->
      <section v-if="admin" class="panel" data-admin-action="edit-ai-upstream" data-ai-upstream-panel>
        <div class="panel__head">
          <h2>上游配置（管理員）</h2>
          <button class="btn btn--ghost" type="button" data-action="ai-upstream-reload" :disabled="upstreamBusy" @click="loadUpstream">
            {{ upstreamBusy ? '處理中…' : '重新讀取' }}
          </button>
        </div>
        <div class="panel__body">
          <dl v-if="upstreamView" class="token-box__meta" data-ai-upstream-view>
            <div><dt>上游地址</dt><dd class="mono">{{ upstreamView.base_url || '（尚未配置）' }}</dd></div>
            <div><dt>模型</dt><dd>{{ upstreamView.model || '（尚未配置）' }}</dd></div>
            <div><dt>金鑰（遮罩）</dt><dd class="mono">{{ upstreamView.key_mask || '（尚未配置金鑰）' }}</dd></div>
            <div><dt>超時</dt><dd>{{ upstreamView.timeout_ms }} ms</dd></div>
            <div><dt>更新時間</dt><dd>{{ upstreamView.updated_at ? formatDateTime(upstreamView.updated_at) : '—' }}</dd></div>
          </dl>
          <p class="hint">
            讀取只回金鑰<b>遮罩</b>（<code>key_mask</code>）；明文永不回包。金鑰欄<b>留空表示沿用既有</b>；
            保存後會重讀一次並上屏服務端回的遮罩。
          </p>
          <div class="form">
            <label class="field">
              <span class="field__label">上游地址 base_url（https 開頭）</span>
              <input v-model.trim="upstreamForm.base_url" class="field__input" type="text" autocomplete="off" spellcheck="false"
                placeholder="https://api.example.com/v1" />
            </label>
            <label class="field">
              <span class="field__label">模型 model</span>
              <input v-model.trim="upstreamForm.model" class="field__input" type="text" autocomplete="off" spellcheck="false"
                placeholder="gpt-4o-mini" />
            </label>
            <label class="field">
              <span class="field__label">金鑰 key（留空表示沿用既有）</span>
              <input v-model="upstreamForm.key" class="field__input" type="password" autocomplete="new-password" spellcheck="false"
                placeholder="sk-…（留空不改）" />
            </label>
            <label class="field">
              <span class="field__label">超時 timeout_ms（1000〜120000，預設 60000）</span>
              <input v-model.number="upstreamForm.timeout_ms" class="field__input" type="number" min="1000" max="120000" step="1000" />
            </label>
            <div>
              <button class="btn" type="button" data-action="ai-upstream-save" :disabled="upstreamBusy" @click="onSaveUpstream">
                {{ upstreamBusy ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </div>
          <p v-if="upstreamNotice" class="hint" data-ai-upstream-notice>{{ upstreamNotice }}</p>
          <p v-if="upstreamError" class="error" role="alert">{{ upstreamError }}</p>
        </div>
      </section>

      <!-- ================= 管理員區：【斐萃桌面授權】卡片（條件渲染，非 CSS 隱藏） ================= -->
      <section v-if="admin" class="panel" data-feicui-device-panel>
        <div class="panel__head">
          <h2>斐萃桌面授權</h2>
          <div class="ai-head-actions">
            <button class="btn btn--ghost" type="button" data-action="feicui-device-issue-session" :disabled="deviceBusy || deviceDelivered" @click="onIssueSessionToken">
              {{ deviceBusy ? '簽發中…' : '為斐翠桌面簽發 8 小時會話' }}
            </button>
            <button class="btn" type="button" data-action="feicui-device-issue" :disabled="deviceBusy" @click="onIssueDeviceToken">
              {{ deviceBusy ? '簽發中…' : deviceToken ? '重新簽發' : '簽發設備令牌' }}
            </button>
          </div>
        </div>
        <div class="panel__body">
          <p class="hint">
            簽發一枚 <b>30 天</b>的斐萃桌面設備令牌：斐萃桌面版拿它在<b>本機</b>寫入授權文件，
            之後即以你的身份讀寫。令牌<b>只出現在本次頁面的記憶體</b>裡，重新整理即消失（需再簽一次）；
            本頁不寫任何本地存儲、不把令牌放進網址、也不打日誌。
          </p>
          <p class="hint">
            <b>登錄即授權（桌面版）</b>：按右上角【為斐翠桌面簽發 8 小時會話】＝ 簽發一枚 8 小時
            （<code>ttl_seconds = 28800</code>）的會話令牌，若偵測到宿主橋（<code>pywebview</code> →
            <code>wails</code> → 通用）就<b>當場交付給斐萃桌面版</b>（<code>receive_feicui_token</code>），
            交付後<b>頁面不再保留令牌明文</b>；沒有宿主橋（例如用普通瀏覽器打開本頁）則自動回退為
            「一次性顯示 ＋ 一鍵複製」。
            <b>自動簽發：本頁掛載時若偵測到有效的登錄會話，就會自動簽發並交付，不需要再點按鈕</b>
            （上方「登錄即授權」表單登錄成功亦同，同一頁面內完成）；右上角按鈕僅作<b>回退</b>
            （會話取不到或簽發失敗時重試）。
            <b>注意：本頁的登錄會話只存在頁面記憶體 —— 若刷新本頁需重新登錄後再簽。</b>
          </p>

          <!-- 令牌區塊（**唯一上屏處**；`deviceToken` 為 null ⇒ 整塊不渲染） -->
          <div v-if="deviceToken" class="token-box" data-feicui-device-token-box>
            <div class="token-box__head">
              <span class="token-box__title">設備令牌（可選取）</span>
              <button class="btn btn--ghost" type="button" data-action="feicui-device-copy" @click="onCopyDeviceToken">
                {{ deviceCopied ? '已複製' : '複製' }}
              </button>
            </div>
            <textarea class="token-box__token" data-feicui-device-token readonly rows="3" :value="deviceToken.token"></textarea>
            <dl class="token-box__meta">
              <div><dt>到期（本地時間）</dt><dd>{{ formatDateTime(deviceToken.expires_at) }}</dd></div>
            </dl>
            <p class="warn">
              在 feicui 倉執行 <code>ops/feicui-sync-20261115/k-auth/save-token.py</code>（腳本會提示粘貼令牌）。
              令牌是<b>憑證</b>：勿入版本庫、勿貼群、勿截圖外傳。
            </p>
            <div class="token-box__head">
              <button class="btn btn--ghost" type="button" data-action="feicui-device-clear" @click="clearDeviceToken">關閉並清除</button>
            </div>
          </div>
          <p v-else-if="!deviceBusy && !deviceError && !deviceDelivered" class="hint">按右上角【簽發設備令牌】取得令牌；僅管理員可簽發。</p>

          <!-- 已交付宿主（**令牌明文已清**：此區塊不綁任何令牌值，DOM 內零明文） -->
          <div v-if="deviceDelivered" class="token-box" data-feicui-device-delivered>
            <div class="token-box__head">
              <span class="token-box__title">已交付桌面版</span>
            </div>
            <p class="hint">
              這枚 <b>8 小時</b>會話令牌已直接交給斐萃桌面版（宿主橋 <code>receive_feicui_token</code>），
              <b>頁面內不再顯示、也不再保留令牌明文</b>，且未寫入任何本地存儲 / 網址 / 日誌。
              授權由桌面版自己保存；<b>若刷新本頁需重新登錄後再簽</b>。
            </p>
          </div>

          <p v-if="deviceError" class="error" role="alert">{{ deviceError }}</p>
        </div>
      </section>

      <!-- ================= 斐萃令牌區（既有；逐字沿用改前三態） ================= -->
      <section v-if="!admin" class="panel">
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
            <li>斐萃側把令牌放進請求頭 <code>Authorization</code>：scheme 用 <code>Feicui</code>，後接一枚本站簽發的令牌（簽發當下一次性顯示的那串長令牌）；</li>
            <li>讀面轉發：<code>{{ FEICUI_FORWARD_PREFIX }}/{{ FEICUI_RESOURCES[0] }}</code>（白名單恰三路：{{ FEICUI_RESOURCES.join(' / ') }}；query 只收 <code>limit</code> / <code>offset</code>）。</li>
            <li>本站驗簽（簽名 / 到期 / 版本 / kid / 吊銷名單）後，帶<b>本站自己的</b>上游密鑰取數；回應按 path＋query 在服務端緩存。</li>
            <li>禁用方式：<code>jti</code> 進吊銷名單＝單枚失效；輪換密鑰＝全體失效（最遲 90 天內自然到期）。</li>
          </ol>
        </div>
      </section>
    </template>

    <!-- 註銷二次確認（沿用倉內既有 ConfirmDialog；按鈕只用 `data-action`，不掛 `data-admin-action`）。 -->
    <ConfirmDialog
      v-if="revokeTarget"
      title="註銷 AI 金鑰"
      :message="revokeMessage"
      hint="註銷後這枚金鑰立即失效（列表仍保留紀錄，狀態顯示「已註銷」）。"
      confirm-text="確定註銷"
      confirm-action="ai-key-revoke-confirm"
      cancel-action="ai-key-revoke-cancel"
      @confirm="confirmRevoke"
      @cancel="cancelRevoke"
    />
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

.ai-head-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
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

/* 餘額 ＋ 用量三格（getAiUsage 三組讀數）。 */
.usage {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--s-3) var(--s-4);
  margin: 0 0 var(--s-4);
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  background: var(--c-surface);
}

.usage__cell dt {
  font-size: var(--t-xs);
  color: var(--c-text-muted);
}

.usage__cell dd {
  margin: 0;
  font-size: var(--t-md);
  color: var(--c-text);
}

.usage__gold {
  color: var(--c-gold-strong);
  font-weight: 600;
}

/* 金鑰列表。 */
.key-list {
  list-style: none;
  margin: 0 0 var(--s-4);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-3);
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  background: var(--c-surface);
}

.key-row__main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-3);
  font-size: var(--t-sm);
  color: var(--c-text);
}

.key-row__prefix {
  color: var(--c-gold-strong);
}

.key-row__status {
  font-size: var(--t-xs);
  padding: 0 var(--s-2);
  border-radius: var(--r-md);
  border: 1px solid var(--c-line-strong);
}

.key-row__status--on {
  color: var(--c-gold-strong);
  border-color: var(--c-gold-strong);
}

.key-row__status--off {
  color: var(--c-text-muted);
}

.key-row__ops {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.key-row__inline {
  display: flex;
  align-items: center;
  gap: var(--s-1);
}

.key-row__inline .field__input {
  width: 88px;
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
.warn code,
.hint code {
  font-family: var(--font-mono, monospace);
}
</style>
