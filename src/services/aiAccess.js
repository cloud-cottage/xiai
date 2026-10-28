/**
 * 玺爱 · **「我的 AI」門面（唯一業務入口）**（本單新增）
 * ============================================================================
 * 包裝雲函數 `xiai-user-token` 的 **7 個 op**（鍵面與 `cloudfunctions/xiai-user-token/lib/ops.js`
 * **逐字一致**）：
 *   · 用戶面 5 個（走既有登錄令牌門）：`issueAiKey` / `listAiKeys` / `revokeAiKey` /
 *     `updateAiKeyLimits` / `getAiUsage`；
 *   · 管理員面 2 個（服務端 `adminWhitelistDenial` 判權）：`getAiUpstream` / `setAiUpstream`。
 *
 * **通道（唯一、不另造第二條）**：`userWrite.js::userWriteGate` → `token.js::userGate` →
 * `data/cloudbaseFn.js::callCloudFunction('xiai-user-token', …)` —— 與勘誤 / 採信 / 展示件等
 * 既有寫面**同一條**用戶令牌通道（含「刷新後靜默補簽」自愈）。本文件**不直連** `callCloudFunction`、
 * **不自建**第二套装载；回包讀數面經 `gate()` 的 `options.readoutKeys` **additive 透傳**声明取得。
 *
 * 硬口徑（逐條）：
 *  ① **失敗原樣透傳**：服務端結構化拒絕的 `{ok:false, reason, message}` **一字不改寫**
 *     （本層不吞真因、不造兜底文案覆蓋服務端判定）；前置檢查的拒絕（未登錄 / 非管理員）
 *     用**獨立字面值** `LOGIN_REQUIRED` / `NOT_ADMIN` / `INVALID_INPUT`，並在文案裡如實標明
 *     是**前端前置**（與 `feicui.js` 同族做法；**不是**服務端授權面）。
 *  ② **明文零落盤**：`issueAiKey` 的回包含**唯一一次明文**（`key`）—— 本層原樣上拋給門面頁，
 *     **不寫 localStorage / sessionStorage、不進日誌、不缓存**（頁面負責「僅顯示一次」呈現）。
 *     上游金鑰（`setAiUpstream` 的 `key`）同理：只經載荷上送，**不回顯、不留存**。
 *  ③ **值域鏡像只作前置提示**：日限 1〜1000（預設 20）、分鐘限 1〜120（預設 5）、
 *     `timeout_ms` ∈ [1000, 120000]（預設 60000）—— 與服務端 `lib/aiKeys.js` / `lib/aiUpstream.js`
 *     同值；**服務端仍是唯一判據**（越界由服務端 `INVALID_VALUE` 裁決，本層不靜默夾取）。
 *  ④ 組件 / 視圖**只經本文件**；`op` 名字面值**全倉只在此處**（含腳本自檢的判據面）。
 */

import { isAdmin, isLoggedIn } from '../data/session.js'
import { userWriteGate } from './userWrite.js'

/** 雲函數名（與 `token.js::USER_TOKEN_FUNCTION` 同一函數；本文件只引用、不另立常量面）。 */
export const AI_FUNCTION_NAME = 'xiai-user-token'

/**
 * **7 個 op 名（鍵面逐字；全倉唯一出現處）** —— 與 `lib/ops.js` 的 `OPS`（5 個用戶面）
 * ＋ `ADMIN_OPS`（2 個管理員面）注冊面逐字一致。
 */
export const AI_OPS = Object.freeze({
  issueAiKey: 'issueAiKey',
  listAiKeys: 'listAiKeys',
  revokeAiKey: 'revokeAiKey',
  updateAiKeyLimits: 'updateAiKeyLimits',
  getAiUsage: 'getAiUsage',
  getAiUpstream: 'getAiUpstream',
  setAiUpstream: 'setAiUpstream'
})

/**
 * 各 op 的**回包讀數鍵面**（與雲函數 `index.js` 的按 op 收窄透傳逐字同集）：
 *   · `issueAiKey`          → `{key_id, key, key_prefix, label, day_limit, minute_limit, created_at}`
 *                             （`key` ＝ **唯一一次明文**）；
 *   · `listAiKeys`          → `{rows, count}`（`rows` 逐行恰 8 鍵，**零 hash、零明文**）；
 *   · `revokeAiKey`         → `{key_id, status, revoked_at, already}`；
 *   · `updateAiKeyLimits`   → `{key_id, day_limit, minute_limit, updated_at}`；
 *   · `getAiUsage`          → `{points, today, minute}`（`today` / `minute` 各為 `{used, limit}`）；
 *   · `getAiUpstream` / `setAiUpstream` → `{base_url, model, key_mask, timeout_ms, updated_at}`
 *                             （**只回遮罩**，零明文、零密文）。
 */
const READOUT_KEYS = Object.freeze({
  issueAiKey: Object.freeze(['key_id', 'key', 'key_prefix', 'label', 'day_limit', 'minute_limit', 'created_at']),
  listAiKeys: Object.freeze(['rows', 'count']),
  revokeAiKey: Object.freeze(['key_id', 'status', 'revoked_at', 'already']),
  updateAiKeyLimits: Object.freeze(['key_id', 'day_limit', 'minute_limit', 'updated_at']),
  getAiUsage: Object.freeze(['points', 'today', 'minute']),
  getAiUpstream: Object.freeze(['base_url', 'model', 'key_mask', 'timeout_ms', 'updated_at']),
  setAiUpstream: Object.freeze(['base_url', 'model', 'key_mask', 'timeout_ms', 'updated_at'])
})

/** 前置拦截的 reason（**本層判定，零網路；不是服務端的授權面**；與 `feicui.js` 同族）。 */
export const LOGIN_REQUIRED = 'LOGIN_REQUIRED'
export const NOT_ADMIN = 'NOT_ADMIN'
export const INVALID_INPUT = 'INVALID_INPUT'

/** 服務端 reason → 可讀繁體提示（**只作提示前綴；服務端 message 恆原樣並列上屏**）。 */
export const AI_REASON_HINTS = Object.freeze({
  INSUFFICIENT_POINTS: '金不足：餘額不足以支付本次 AI 用量。',
  LIMIT_DAY: '日限滿：本日用量已達上限，請明日再試或調高日限。',
  LIMIT_MINUTE: '分鐘限滿：本分鐘用量已達上限，請稍後再試。',
  KEY_INVALID: '金鑰失效：金鑰不存在、已註銷或校驗不通過。',
  CONFIG_MISSING: '配置缺失：AI 上游尚未配置（管理員需先完成【上游配置】）。',
  FORBIDDEN: '權限不足：該操作需要本人（管理員操作需管理員身份）。',
  INVALID_VALUE: '數值不合法：請檢查限額 / 地址 / 超時是否在允許範圍內。',
  INVALID_FIELD: '欄位不合法：載荷含服務端不接受的欄位。',
  MISSING_REQUIRED: '缺少必填欄位：請補齊後重試。',
  STORAGE_UNAVAILABLE: '雲端或上游暫時不可用，請稍後再試。'
})

/** 值域鏡像（與服務端同值；**只作前置提示，服務端才是判據**）。 */
export const AI_LIMIT_RANGES = Object.freeze({
  day: Object.freeze({ min: 1, max: 1000, def: 20 }),
  minute: Object.freeze({ min: 1, max: 120, def: 5 }),
  timeoutMs: Object.freeze({ min: 1000, max: 120000, def: 60000 }),
  labelMax: 40
})

function denial(reason, message) {
  return { ok: false, reason, message }
}

/** 整數限額歸一（空 ⇒ 預設值；越界 / 非整數 ⇒ `null`，由調用方報錯，**不靜默夾取**）。 */
function intLimit(value, range) {
  if (value === undefined || value === null || String(value).trim() === '') return range.def
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) return null
  return parsed
}

/**
 * 唯一調用縫：過用戶寫面門（含補簽自愈）＋ 按 op 聲明讀數鍵面。
 * 失敗（前置 / 補簽 / 服務端拒絕 / 傳輸）⇒ **原樣透傳** `{ok:false, reason, message}`。
 * @param {string} op op 名（取自 `AI_OPS`）
 * @param {object} payload 載荷（鍵面由服務端封閉裁決）
 */
async function call(op, payload) {
  const gate = await userWriteGate(op, payload, { readoutKeys: READOUT_KEYS[op] })
  if (!gate || gate.ok !== true) {
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || 'AI 服務暫時不可用，請稍後再試。'
    }
  }
  if (gate.dev === true) {
    /* dev / 離線形態：門放行但**未經雲端** ⇒ 如實結構化拒絕（不編造金鑰 / 用量假讀數）。 */
    return denial('STORAGE_UNAVAILABLE', 'dev / 離線形態：未經雲端驗證，AI 金鑰面不可用（非正式路徑）。')
  }
  const out = { ok: true }
  for (const key of READOUT_KEYS[op]) out[key] = gate[key]
  return out
}

/* ---------------------------------------------------------------------------
   用戶面（5 個；未登錄 ⇒ 前置拒絕、零請求）
   --------------------------------------------------------------------------- */

/**
 * 簽發一枚 AI 金鑰（`label` / `day_limit` / `minute_limit`；後兩者預設 20 / 5）。
 * 成功回包的 `key` 是**唯一一次明文** —— 調用方（門面頁）只許在「僅顯示一次」區塊呈現，
 * **不落任何存儲、不進日誌、關閉即清**。
 * @param {{label?:string, day_limit?:number|string, minute_limit?:number|string}} input
 * @returns {Promise<{ok:true, key_id:string, key:string, key_prefix:string, label:string,
 *          day_limit:number, minute_limit:number, created_at:string}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function issueKey(input) {
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再生成 AI 金鑰（前端前置；未發出任何請求）。')
  }
  const options = input || {}
  const label = String(options.label === undefined || options.label === null ? '' : options.label).trim()
  if (label.length > AI_LIMIT_RANGES.labelMax) {
    return denial(INVALID_INPUT, `金鑰備註（label）最多 ${AI_LIMIT_RANGES.labelMax} 字。`)
  }
  const day = intLimit(options.day_limit, AI_LIMIT_RANGES.day)
  const minute = intLimit(options.minute_limit, AI_LIMIT_RANGES.minute)
  if (day === null) {
    return denial(INVALID_INPUT, `日限（day_limit）須為 ${AI_LIMIT_RANGES.day.min}〜${AI_LIMIT_RANGES.day.max} 的整數。`)
  }
  if (minute === null) {
    return denial(
      INVALID_INPUT,
      `分鐘限（minute_limit）須為 ${AI_LIMIT_RANGES.minute.min}〜${AI_LIMIT_RANGES.minute.max} 的整數。`
    )
  }
  return call(AI_OPS.issueAiKey, { label, day_limit: day, minute_limit: minute })
}

/**
 * 本人金鑰清單（含已註銷；逐行**零 hash、零明文** —— 只有 `key_prefix`）。
 * @returns {Promise<{ok:true, rows:Array<object>, count:number}|{ok:false, reason:string, message:string}>}
 */
export async function listKeys() {
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再查看 AI 金鑰（前端前置；未發出任何請求）。')
  }
  return call(AI_OPS.listAiKeys, {})
}

/**
 * 註銷一枚金鑰（只許本人；服務端冪等：已註銷回 `already:true`）。
 * @param {string} keyId 金鑰標識
 * @returns {Promise<{ok:true, key_id:string, status:string, revoked_at:string, already:boolean}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function revokeKey(keyId) {
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再註銷 AI 金鑰（前端前置；未發出任何請求）。')
  }
  const id = String(keyId === undefined || keyId === null ? '' : keyId).trim()
  if (!id) return denial(INVALID_INPUT, '缺少金鑰標識（key_id）。')
  return call(AI_OPS.revokeAiKey, { key_id: id })
}

/**
 * 改寫一枚金鑰的限額（`key_id` ＋ **兩個限額都須給**；服務端值域裁決）。
 * @param {{key_id:string, day_limit:number|string, minute_limit:number|string}} input
 * @returns {Promise<{ok:true, key_id:string, day_limit:number, minute_limit:number, updated_at:string}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function updateKeyLimits(input) {
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再改寫金鑰限額（前端前置；未發出任何請求）。')
  }
  const options = input || {}
  const id = String(options.key_id === undefined || options.key_id === null ? '' : options.key_id).trim()
  if (!id) return denial(INVALID_INPUT, '缺少金鑰標識（key_id）。')
  const day = intLimit(options.day_limit, AI_LIMIT_RANGES.day)
  const minute = intLimit(options.minute_limit, AI_LIMIT_RANGES.minute)
  if (day === null) {
    return denial(INVALID_INPUT, `日限（day_limit）須為 ${AI_LIMIT_RANGES.day.min}〜${AI_LIMIT_RANGES.day.max} 的整數。`)
  }
  if (minute === null) {
    return denial(
      INVALID_INPUT,
      `分鐘限（minute_limit）須為 ${AI_LIMIT_RANGES.minute.min}〜${AI_LIMIT_RANGES.minute.max} 的整數。`
    )
  }
  return call(AI_OPS.updateAiKeyLimits, { key_id: id, day_limit: day, minute_limit: minute })
}

/**
 * 本人餘額 ＋ 用量窗口（**三組讀數**：`points`（金）/ `today` / `minute`，各窗口 `{used, limit}`）。
 * @returns {Promise<{ok:true, points:number, today:{used:number, limit:number},
 *          minute:{used:number, limit:number}}|{ok:false, reason:string, message:string}>}
 */
export async function readUsage() {
  if (!isLoggedIn.value) {
    return denial(LOGIN_REQUIRED, '請先登錄後再查看 AI 餘額與用量（前端前置；未發出任何請求）。')
  }
  return call(AI_OPS.getAiUsage, {})
}

/* ---------------------------------------------------------------------------
   管理員面（2 個；非管理員 ⇒ 前置拒絕、零請求；服務端另有獨立管理員門）
   --------------------------------------------------------------------------- */

/**
 * 讀 AI 上游配置（**只回 `key_mask` 遮罩**；零明文、零密文）。
 * @returns {Promise<{ok:true, base_url:string, model:string, key_mask:string,
 *          timeout_ms:number, updated_at:string}|{ok:false, reason:string, message:string}>}
 */
export async function readUpstream() {
  if (!isLoggedIn.value || !isAdmin.value) {
    return denial(NOT_ADMIN, '僅管理員可以讀取 AI 上游配置（前端前置；未發出任何請求）。')
  }
  return call(AI_OPS.getAiUpstream, {})
}

/**
 * 寫 AI 上游配置（`key` **可選**：留空 ⇒ 服務端沿用既有密文；保存後回**寫後公共面**）。
 * 金鑰明文只經載荷上送一次，**不回顯、不落任何存儲**。
 * @param {{base_url:string, model:string, key?:string, timeout_ms?:number|string}} input
 * @returns {Promise<{ok:true, base_url:string, model:string, key_mask:string,
 *          timeout_ms:number, updated_at:string}|{ok:false, reason:string, message:string}>}
 */
export async function writeUpstream(input) {
  if (!isLoggedIn.value || !isAdmin.value) {
    return denial(NOT_ADMIN, '僅管理員可以配置 AI 上游（前端前置；未發出任何請求）。')
  }
  const options = input || {}
  const baseUrl = String(options.base_url === undefined || options.base_url === null ? '' : options.base_url).trim()
  const model = String(options.model === undefined || options.model === null ? '' : options.model).trim()
  const key = String(options.key === undefined || options.key === null ? '' : options.key).trim()
  const timeout = intLimit(options.timeout_ms, AI_LIMIT_RANGES.timeoutMs)
  if (!baseUrl || !model) {
    return denial(INVALID_INPUT, '上游地址（base_url）與模型名（model）為必填。')
  }
  if (timeout === null) {
    return denial(
      INVALID_INPUT,
      `超時（timeout_ms）須為 ${AI_LIMIT_RANGES.timeoutMs.min}〜${AI_LIMIT_RANGES.timeoutMs.max} 的整數毫秒。`
    )
  }
  const payload = { base_url: baseUrl, model, timeout_ms: timeout }
  /* `key` 留空 ⇒ **不傳該鍵** ⇒ 服務端沿用既有密文（「留空表示沿用既有」）。 */
  if (key) payload.key = key
  return call(AI_OPS.setAiUpstream, payload)
}
