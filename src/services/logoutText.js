/**
 * 玺爱 · **退出登錄（登出）三态文案与按钮判据的单点**
 * ============================================================================
 * 为什么单独一个文件：登出发生在**两个入口**（頁頭 `AppHeader.vue`、登錄頁
 * `LoginView.vue::signOut`），而「進行中 / 成功 / 失敗」三段文案与按钮的
 * `disabled` / `aria-busy` 判据必须**同一把尺子** —— 否则两处会漂成两套说法
 * （一处说「正在退出…」、另一处还在原地不动）。
 *
 * 三态（逐字凍結，繁體，本文件是全仓唯一真源）：
 *   · 進行中：`LOGOUT_RUNNING_TEXT`（按鈕 immediate 換字 ＋ 禁用，防重複點）
 *   · 成功：  `LOGOUT_DONE_TEXT`（清會話與路由重置**之後**才上屏）
 *   · 失敗：  `LOGOUT_FAIL_PREFIX ＋ <簡短原因>`（**不得靜默**；原會話保留、可重試）
 *
 * 本文件**零依賴**（不 import vue / 不碰 DOM / 不碰存儲）⇒ 可被 `scripts/verify-*.mjs`
 * 直接 import 做純函數自檢（node 直跑，無需打包）。
 */

/** 空閒態按鈕文案（與既有頁頭 / 登錄頁同字面，不另造說法）。 */
export const LOGOUT_IDLE_TEXT = '退出登錄'

/** 進行中態按鈕文案（immediate 換字；`…` 用全角省略號，與全站其他「⋯中」同口型）。 */
export const LOGOUT_RUNNING_TEXT = '正在退出…'

/** 成功態文案（繁體：`錄`；全仓唯一真源）。 */
export const LOGOUT_DONE_TEXT = '已退出登錄'

/** 失敗態前綴（後面接**簡短原因**；原因不得為空、不得帶堆棧）。 */
export const LOGOUT_FAIL_PREFIX = '退出失敗：'

/** 失敗原因的最大字數（超出即截斷 —— 上屏要「簡短」，不是複印整條異常）。 */
export const LOGOUT_REASON_MAX = 40

/**
 * 把任意錯誤對象 / 字串壓成**一行、簡短、無堆棧**的原因文本。
 *
 * 硬口徑：
 *   · 只取第一行（堆棧 / 多行細節一律丟掉）；
 *   · 空白歸一，去首尾；
 *   · 超長截斷並補 `…`（不靜默丟字，看得出被截過）；
 *   · 取不到任何可讀文本 ⇒ `''`（由調用方給「請稍後重試」兜底，**不回 `undefined`**）。
 * @param {unknown} error
 * @returns {string}
 */
export function shortReason(error) {
  let raw = ''
  if (typeof error === 'string') raw = error
  else if (error && typeof error === 'object') {
    raw = String(error.message || error.errMsg || error.reason || '')
  }
  const firstLine = String(raw || '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (firstLine === '') return ''
  return firstLine.length > LOGOUT_REASON_MAX ? `${firstLine.slice(0, LOGOUT_REASON_MAX)}…` : firstLine
}

/**
 * 失敗態上屏文案（**冪等**：餵進已帶前綴的文本也不會出現「退出失敗：退出失敗：…」）。
 * @param {unknown} reason 錯誤對象 / 字串 / 已格式化的失敗文案
 * @returns {string} 恆非空、恆帶前綴
 */
export function logoutFailureText(reason) {
  let text = shortReason(reason)
  if (text.startsWith(LOGOUT_FAIL_PREFIX)) text = text.slice(LOGOUT_FAIL_PREFIX.length).trim()
  return text === '' ? `${LOGOUT_FAIL_PREFIX}請稍後重試。` : `${LOGOUT_FAIL_PREFIX}${text}`
}

/**
 * 按鈕 / 提示條的三態投影（純函數：同輸入恆同輸出，供兩入口與自檢共用）。
 * @param {{running?: boolean, error?: string}} [input]
 * @returns {{tone:'running'|'error'|'idle', label:string, disabled:boolean, message:string}}
 */
export function logoutView(input) {
  const running = Boolean(input && input.running)
  const error = String((input && input.error) || '').trim()
  if (running) {
    return { tone: 'running', label: LOGOUT_RUNNING_TEXT, disabled: true, message: '' }
  }
  if (error !== '') {
    return { tone: 'error', label: LOGOUT_IDLE_TEXT, disabled: false, message: logoutFailureText(error) }
  }
  return { tone: 'idle', label: LOGOUT_IDLE_TEXT, disabled: false, message: '' }
}

/**
 * 登出結果 → 上屏結論（**只認 `ok === false` 為失敗**：缺欄位不冒充失敗）。
 * @param {unknown} result 服務層 `logout()` 的回包
 * @returns {{ok:boolean, already:boolean, message:string}}
 */
export function logoutOutcome(result) {
  if (result && result.ok === false) {
    return { ok: false, already: false, message: logoutFailureText(result.message || result.reason) }
  }
  return { ok: true, already: Boolean(result && result.already === true), message: LOGOUT_DONE_TEXT }
}
