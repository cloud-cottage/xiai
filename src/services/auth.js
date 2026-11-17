/**
 * 玺爱 · 登录服务（手機號 + 短訊驗證碼 / 手機號 + 密碼）
 *
 * **短訊驗證碼（本輪 P1b 起的唯一取碼路徑）**：真發短訊，由**雲開發平台原生身份**承擔 ——
 *   · 取碼：`auth.getVerification({ phone_number })` ⇒ 平台下發短訊。**不傳 `target`**：
 *     傳 `'USER'` 只給「已註冊」用戶發碼 ⇒ 新號直接被平台拒
 *     （實測 `FAILED_PRECONDITION / 賬號不存在`），而本平台環境幾乎全是新號 ⇒ 登錄全掛。
 *     也不傳 `'ANY'`（多一個取值就多一份平台語義漂移；不傳已足夠）。
 *     回包帶 `verification_id`（純 11 位手機號由 SDK 自動補 `"+86 "` 前綴）；
 *   · 驗碼：`auth.verify({ verification_id, verification_code })` ⇒ 回包帶 `verification_token`；
 *   · 登入 / 建號：**先判該號是否已有平台賬號，再二選一** ——
 *       老號 `auth.signIn({ username: <+86 形態手機號>, verification_token })`；
 *       新號 `auth.signUp({ phone_number: <+86 形態手機號>, verification_token })`
 *       （SDK 的 `signUp` 內部會 `credentialsClient.setCredentials` ⇒ 會話已落，可直接取 `access_token`）。
 *     **不得拿 token 去「先試 signIn、失敗再 signUp」**：`verification_token` 是一次性憑據，
 *     判別新老號要靠**存在性判據**（回包 `is_user` / `isUsernameRegistered` 探針），不是靠試錯。
 *   · 換令牌：把該平台憑證交後端（凍結契約）`ensureUserLoginToken(phone, platformAccessToken)`。
 *
 * **密碼（P2 起的第二條正式路徑）**：手機號 ＋ 密碼 ⇒ 平台 `signInWithPassword` ⇒ 取 `access_token`
 * ⇒ 同一條 `ensureUserLoginToken` 換令牌 ⇒ **同一個收尾** `finalizeLogin()`（兩條路共用一份）。
 * 忘記密碼 ⇒ `requestCode()` 取碼 ⇒ `verify` ⇒ `resetPassword({phone_number,new_password,verification_token})`
 * ⇒ 重置成功即用新密碼自動登錄（全流程見 `resetPasswordByOtp` 的頭注，含 SDK 源碼位置）。
 *
 * **硬紅線（逐條）**：
 *   ① 本文件**不持有、不產生、不回包任何驗證碼**（沒有固定碼常量、沒有取碼回填、沒有本地碼門）；
 *   ② 任一步失敗 ⇒ **零半成品**：不建本地賬號行、不寫 session、不發初始金、不結算邀請；
 *   ③ 頻控錯誤（`RATE_LIMITED`，錯誤對象帶 `retryAfter`）**原文如實上屏**，不折成通用提示；
 *   ④ 平台會話走**獨立 app 實例 ＋ 內存持久化**（見 `data/cloudbaseAuth.js` 檔案頭），
 *      不覆蓋讀面的匿名會話。
 *
 * dev / 離線形態（本機未配置雲端）：**不得**回退到任何固定碼。僅在 `import.meta.env.DEV`
 * 構建下允許「本地調試登入」這一條**非正式路徑**（不驗碼、也不回包任何碼；生產構建不存在該分支）。
 */

import { listUserRows, saveUserRows } from '../data/db.js'
import { setUser, restoreSession, currentUser } from '../data/session.js'
import { ADMIN_PHONE, ADMIN_NICKNAME } from '../data/seed.js'
/* **身份标识（uid）单点**：`u-` ＋ sha256(手机号) 前 16 位（不可反推手机号 ⇒ 可公开）。
   与云函数 `xiai-user-token` / `xiai-admin-token` 的 `uidOf` **同一算法 ⇒ 同值**。 */
import { uidOf } from '../data/uid.js'
import { grantInitialGold, settleInviteReward } from './points.js'
/* **写面 Phase A（用户写面）**：登录改为「**先服务端验证并拿到用户令牌，再写 session**」——
   云端形态下身份判据在服务端（`xiai-user-token` 的 `action:'issue'`），本地只落 `userId` 镜像。 */
import { ensureUserLoginToken } from './userToken.js'
/* **R-L10（P3）**：登出清持久化令牌（同一份 `token.js` 的 `clear()`；不新建第二套清点）。 */
import { clearUserToken, clearAdminToken } from './token.js'
/* **短訊驗證碼 / 密碼登錄的 SDK 裝配單點**（獨立 app 實例 ＋ 內存持久化 ⇒ 不覆蓋讀面匿名會話）。 */
import { otpAuth, resetOtpAuth, signOutOtpSession } from '../data/cloudbaseAuth.js'
/* **退出登錄三態文案單點**（`已退出登錄` / `退出失敗：…` 全仓唯一真源；純函數、零依賴）。 */
import { LOGOUT_DONE_TEXT, logoutFailureText } from './logoutText.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'

export const GOLD_INITIAL = 50

/** 取碼冷卻秒數（前端體驗層；**不是**服務端頻控判據 —— 真正的頻控以平台回包為準）。 */
export const CODE_RESEND_SECONDS = 60

/** 驗證碼位數（平台固定 6 位；留 4〜8 的容錯窗，不因此放寬任何判據）。 */
const CODE_PATTERN = /^\d{4,8}$/

/* ---------------------------------------------------------------------------
   **密碼規則（P2；預設值，一句話可改）**
   ---------------------------------------------------------------------------
   8–20 位、必須同時含字母與數字。**前端先就地拒**（不合規則不發請求、零副作用），
   但**平台的判據才是最終判據**：平台若回「密碼太弱」一類錯誤，**原文透傳**上屏。
   --------------------------------------------------------------------------- */

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 20

const PASSWORD_LETTER = /[A-Za-z]/
const PASSWORD_DIGIT = /\d/

/** 密碼規則的一句人話（上屏用；與 `passwordPolicyError` 的判據**同源**）。 */
export function passwordRuleHint() {
  return `密碼 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位，且須同時包含字母與數字。`
}

/**
 * 密碼規則校驗（**只回文案、不回包密碼**；空串 ＝ 合規）。
 * @param {string} password
 * @returns {string} 不合規 ⇒ 可讀繁體說明；合規 ⇒ `''`
 */
export function passwordPolicyError(password) {
  const value = String(password === undefined || password === null ? '' : password)
  if (value === '') return '請輸入新密碼。'
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    return `密碼長度應為 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位（當前 ${value.length} 位）。`
  }
  if (!PASSWORD_LETTER.test(value)) return '密碼須包含至少一個字母（A–Z / a–z）。'
  if (!PASSWORD_DIGIT.test(value)) return '密碼須包含至少一個數字（0–9）。'
  return ''
}

/**
 * 是否為 **DEV 構建**（`import.meta.env.DEV`）。
 *
 * 只有它為 `true` 且寫面形態為 `local-dev` 時，才允許「本地調試登入」這條非正式路徑。
 * 生產構建裡此常量恆 `false` ⇒ 那段分支不可達。
 */
const DEV_BUILD = (() => {
  try {
    if (typeof import.meta === 'undefined') return false
    const env = import.meta.env
    return !!(env && env.DEV === true)
  } catch {
    return false
  }
})()

/**
 * 本次會話待驗證的 `verification_id`（模塊內暫存）。
 *
 * **不上屏、不外傳、不落盤**：它只是一個一次性的服務端句柄，值本身不是憑證；
 * 但按「驗證碼不進日誌 / 報告」的紀律，這裡同樣只在內存裡與手機號配對使用。
 */
let pendingVerification = { phone: '', verificationId: '', isUser: null }

export function isPhoneLike(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || '').trim())
}

/** 平台手機號形態（與 SDK `getVerification` 的 `"+86 "` 前綴**逐字同形**）。 */
function platformPhoneOf(phone) {
  return `+86 ${phone}`
}

/**
 * 平台失敗 ⇒ 可讀結果（**發碼路徑專用：原文如實**）。
 *
 * 平台已把技術錯誤歸一化成可讀中文（`Error.message` = `error_description || message`，
 * 見 SDK 的 `AuthError` 構造：`dist/index.esm.js` 偏移 171068 `var i=e.error_description||e.message`），
 * 並在頻控時帶 `retryAfter` ⇒ 本函數**不改寫、不折疊**，只把需要的讀數（`retryAfter`）疊出來。
 *
 * **空 `message` 的口徑（本輪熱修）**：舊版在這裡回一句「短訊驗證服務暫時不可用」——
 * 那等於把平台給的真實原因（`FAILED_PRECONDITION / 賬號不存在`）吞掉，用戶與排障都被騙。
 * 現在：`message` 空 ⇒ 用 `error_description` / `code` / `category` **拼出可讀原因**；
 * 只有平台連 `code` 都沒給（極少見）才回「平台未返回任何錯誤說明」，那句話本身也是事實。
 * @param {*} error 平台拋出的錯誤對象
 * @returns {{ok:false, message:string, retryAfter?:number, category?:string}}
 */
function otpFailureVerbatim(error) {
  const description = String((error && (error.error_description || error.errorDescription)) || '').trim()
  const original = String((error && error.message) || '').trim() || description
  const category = String((error && (error.category || error.code || error.error_code)) || '').trim()
  const retryRaw = Number(error && (error.retryAfter || error.retry_after))
  const retryAfter = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.ceil(retryRaw) : 0
  let message = original
  if (message === '') {
    message = category !== ''
      ? `短訊驗證未完成（平台返回 ${category}，未附文字說明）。`
      : '短訊驗證未完成：平台未返回任何錯誤說明（message / code / error_description 皆空）。'
  }
  if (retryAfter > 0) message = `${message}\n（平台建議等待 ${retryAfter} 秒後重發。）`
  const result = { ok: false, message }
  if (retryAfter > 0) result.retryAfter = retryAfter
  if (category !== '') result.category = category
  return result
}

/**
 * 平台失敗 ⇒ 可讀結果（**驗碼 / 登入路徑專用**）。
 *
 * 這兩步失敗的用戶可處置動作只有一個（重新取碼），因此給**短文案**；
 * 平台的長篇自助說明不適合上屏。`RATE_LIMITED` 等仍走 `otpFailureVerbatim`（原文）。
 * @param {*} error
 * @param {string} fallback
 */
function otpFailureFriendly(error, fallback) {
  const category = String((error && (error.category || error.code || error.error_code)) || '').trim()
  if (category === 'RATE_LIMITED') return otpFailureVerbatim(error)
  const result = { ok: false, message: fallback }
  if (category !== '') result.category = category
  return result
}

/** 只取需要的键（`undefined` 不进返回体，避免上屏出现 `undefined`）。 */
function denialOf(source) {
  const out = { ok: false, message: source && source.message ? source.message : '操作未完成，請稍後重試。' }
  if (source && source.reason) out.reason = source.reason
  if (source && source.retryAfter) out.retryAfter = source.retryAfter
  if (source && source.category) out.category = source.category
  return out
}

/**
 * **取驗證碼（真發短訊）**。
 *
 * 硬紅線：回包**不含任何 code 字段**（不是「沒用到」，而是**不返回**）——
 * 任何「取碼即得碼」的形態都把驗證碼變成公開秘密。
 *
 * @param {string} phone 11 位手機號
 * @returns {Promise<{ok:true, message:string, cooldownSeconds:number}
 *                  |{ok:false, message:string, reason?:string, retryAfter?:number, category?:string}>}
 */
export async function requestCode(phone) {
  const normalized = String(phone || '').trim()
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  const auth = await otpAuth()
  if (!auth || typeof auth.getVerification !== 'function') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '短訊驗證碼暫不可用（未配置雲端資料源）；本次未發送任何短訊。'
    }
  }
  let body = null
  try {
    /* **不傳 `target`**（本輪熱修）：`target:'USER'` 只給「已註冊」用戶發碼 ⇒ 新號被平台拒
       （實測 `FAILED_PRECONDITION / 賬號不存在`）。不傳 target 才是「任意號碼可收碼」的最小面；
       也不傳 `'ANY'`（多一個取值就多一份平台側語義漂移的風險）。 */
    body = await auth.getVerification({ phone_number: normalized })
  } catch (error) {
    /* 頻控 / 風控 / 未開啟短訊登入 ⇒ **平台原文如實上屏**（含 `retryAfter`）。 */
    return otpFailureVerbatim(error)
  }
  const verificationId = String((body && (body.verification_id || body.verificationId)) || '').trim()
  if (verificationId === '') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '短訊發送回包形狀不可辨識，請稍後重試。'
    }
  }
  /* **新老號判據（免試錯）**：平台回包的 `is_user` 就是 SDK 自己 `signUp().verifyOtp` 用的判據
     （`dist/index.esm.js` 偏移 231689：`e.is_user ? signIn({username, verification_token})
     : authApi.signUp({..., verification_token})`）⇒ 有布爾值就當第一判據；沒有就記 `null`，
     驗碼後走 `isUsernameRegistered` 探針。 */
  const isUserHint = body && typeof body.is_user === 'boolean' ? body.is_user : null
  pendingVerification = { phone: normalized, verificationId, isUser: isUserHint }
  return {
    ok: true,
    message: '驗證碼已發送至你填寫的手機號，請查收短訊。',
    cooldownSeconds: CODE_RESEND_SECONDS
  }
}

/**
 * 验证码提示（**形态如实，不得静默 / 不得假称**）：真短訊、有頻控、有每日上限。
 * @returns {string} 上屏提示（繁體）
 */
export function loginCodeHint() {
  return '驗證碼由雲開發平台以短訊下發至你填寫的手機號；同一號碼 60 秒內只能重發一次，平台按號碼設有每日發送上限，超限時會如實提示。'
}

/** 從平台會話取 `access_token`（**只作憑證交後端**；不打印、不落盤、不上屏）。 */
async function platformAccessTokenOf(auth) {
  try {
    if (typeof auth.getSession === 'function') {
      const reply = await auth.getSession()
      const session = reply && reply.data ? reply.data.session : null
      const token = String((session && (session.access_token || session.accessToken)) || '').trim()
      if (token !== '') return token
    }
  } catch {
    /* 落到 `getLoginState()` */
  }
  try {
    if (typeof auth.getLoginState === 'function') {
      const state = await auth.getLoginState()
      const credentials = state && (state.credentials || state)
      const token = String((credentials && (credentials.access_token || credentials.accessToken)) || '').trim()
      if (token !== '') return token
    }
  } catch {
    /* 取不到 ⇒ 空串（調用方給結構化拒絕） */
  }
  return ''
}

/**
 * **本地調試登入**（**非正式路徑**）：僅 `DEV` 構建 ＋ 本機無雲（`local-dev`）時可用。
 *
 * 它**不驗任何驗證碼、也不回包任何碼** —— 本機根本沒有短信通道，任何「碼」都只能是假的；
 * 與其留一個假碼門，不如把這件事標成「本地調試」並只在 DEV 構建裡存在（生產構建不可達）。
 * @returns {boolean}
 */
function localDevLoginAllowed() {
  return DEV_BUILD && writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV
}

/**
 * 平台是否回「該號沒有賬號」（`USER_NOT_FOUND` 一類）。
 *
 * 判據來源：SDK 的 AuthError 分類器把 `FAILED_PRECONDITION` ＋「不存在 / not found / 未注册」
 * 歸到 `category === 'USER_NOT_FOUND'`（`dist/index.esm.js` 偏移 172780）。
 */
function platformAccountMissing(error) {
  const text = `${String((error && error.code) || '')} ${String((error && error.category) || '')} ${String(
    (error && error.message) || ''
  )}`.toLowerCase()
  return (
    text.indexOf('user_not_found') !== -1 ||
    text.indexOf('user_not_exists') !== -1 ||
    text.indexOf('账号不存在') !== -1 ||
    text.indexOf('帳號不存在') !== -1 ||
    text.indexOf('用户不存在') !== -1 ||
    text.indexOf('用戶不存在') !== -1
  )
}

/** 平台是否回「該號已經有賬號」（建號分支判錯 / 競態時，換回登入分支的唯一理由）。 */
function platformAccountTaken(error) {
  const text = `${String((error && error.code) || '')} ${String((error && error.category) || '')} ${String(
    (error && error.message) || ''
  )}`.toLowerCase()
  return (
    text.indexOf('user_already_exists') !== -1 ||
    text.indexOf('already_exists') !== -1 ||
    text.indexOf('already registered') !== -1 ||
    text.indexOf('已注册') !== -1 ||
    text.indexOf('已註冊') !== -1 ||
    text.indexOf('已存在') !== -1 ||
    text.indexOf('duplicate') !== -1
  )
}

/**
 * **存在性探針**（`auth.isUsernameRegistered`）—— 只為「不拿一次性 token 去試錯」。
 *
 * 源碼：`dist/index.esm.js` 偏移 265286 ⇒ `authApi.checkIfUserExist({ username })` ⇒
 * GET `/v1/checkIfUserExist?username=…`（偏移 199104）⇒ 回 `.exist` 布爾。
 * 兩種用戶名形態都探（賬號可能被建成 `138…`，也可能是手機號身份 `+86 138…`）。
 * @returns {Promise<{known:boolean, registered:boolean}>} `known:false` ＝ 探針不可用/拋錯
 */
async function platformAccountRegistered(auth, phone) {
  if (typeof auth.isUsernameRegistered !== 'function') return { known: false, registered: false }
  const forms = [platformPhoneOf(phone), phone]
  try {
    for (let index = 0; index < forms.length; index += 1) {
      /* eslint-disable no-await-in-loop */
      const registered = await auth.isUsernameRegistered(forms[index])
      if (registered === true) return { known: true, registered: true }
    }
  } catch {
    return { known: false, registered: false }
  }
  return { known: true, registered: false }
}

/**
 * **驗碼之後的「登入 or 建號」二選一**（本輪熱修的核心）。
 *
 * 判別順序（**兩個「肯定存在」的判據取「或」**，方向刻意偏保守）：
 *   ① 取碼回包的 `is_user === true`（平台自己給的判據，SDK 的 `signUp().verifyOtp` 同款）⇒ 立刻判老號；
 *   ② 否則 `isUsernameRegistered` 探針（兩種用戶名形態）；
 *   ③ ②不可用（拋錯 / SDK 沒這個方法）***且*** ①沒正面說「存在」⇒ 已知性不足，
 *      才退到「先 signIn，錯誤碼指路後換向 signUp」的降級鏈。
 *
 * 為什麼取「或」而不是「回包優先」：任一判據說「存在」就絕不建號 —— 給老用戶 signUp 是
 * 用戶可見的壞結果，而多打一次探針只是多一次 GET。
 * **① / ② 命中時只發一次登入請求**：`verification_token` 是一次性憑據，不能用來試錯。
 * @returns {Promise<{ok:true, branch:'signIn'|'signUp'}|{ok:false, denial:object}>}
 */
async function establishPlatformSession(auth, phone, verificationToken, isUserHint) {
  const hasSignIn = typeof auth.signIn === 'function'
  const hasSignUp = typeof auth.signUp === 'function'
  if (!hasSignIn && !hasSignUp) {
    return {
      ok: false,
      denial: {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE',
        message: '短訊登入暫不可用（SDK 未提供 signIn / signUp）；本次未登入、零寫入。'
      }
    }
  }
  /* 回包正面說「存在」⇒ 老號，不必再探；否則探針補一刀（探針說存在同樣判老號）。 */
  let known = isUserHint === true
  let registered = known
  if (!known) {
    const probe = await platformAccountRegistered(auth, phone)
    if (probe.known) {
      known = true
      registered = probe.registered
    }
  }
  /* 判據明確 ⇒ 只走一支；判據不足 ⇒ 先試「登入」（不確定時不建號），錯誤碼指路後才換向一次。 */
  const steps = known ? [registered ? 'signIn' : 'signUp'] : ['signIn', 'signUp']
  let lastError = null
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const usable = step === 'signIn' ? hasSignIn : hasSignUp
    if (!usable) {
      if (index + 1 < steps.length) continue
      break
    }
    try {
      const reply =
        step === 'signIn'
          ? await auth.signIn({ username: platformPhoneOf(phone), verification_token: verificationToken })
          : await auth.signUp({ phone_number: platformPhoneOf(phone), verification_token: verificationToken })
      /* 該版 SDK 的 `signIn` / `signUp` 失敗時**拋錯**（`dist/index.esm.js` 偏移 264890 /
         230716，兩處都沒有 `{data,error}` 收口）；仍容忍某些子版本回 `{error}` 的形態。 */
      if (reply && reply.error) throw reply.error
      return { ok: true, branch: step }
    } catch (error) {
      lastError = error
      const switchable = step === 'signIn' ? platformAccountMissing(error) : platformAccountTaken(error)
      if (!switchable || index + 1 >= steps.length) break
    }
  }
  return {
    ok: false,
    denial: otpFailureFriendly(lastError, '登入未完成，請重新獲取驗證碼後再試。')
  }
}

/**
 * 平台驗證（取碼 → 驗碼 → 登入 / 建號 → 平台會話憑證）。
 * @param {string} phone 已歸一的 11 位手機號
 * @param {string} code 用戶輸入的驗證碼
 * @returns {Promise<{ok:true, mode:'cloud'|'local-dev', accessToken:string}
 *                  |{ok:false, message:string, reason?:string, retryAfter?:number, category?:string}>}
 */
async function verifyPlatformOtp(phone, code) {
  if (localDevLoginAllowed()) {
    return { ok: true, mode: WRITE_FACE_MODES.LOCAL_DEV, accessToken: '' }
  }
  const typed = String(code || '').replace(/\s+/g, '')
  if (typed === '') return { ok: false, message: '請輸入短訊驗證碼' }
  if (!CODE_PATTERN.test(typed)) return { ok: false, message: '驗證碼應為 6 位數字' }
  const verificationId =
    pendingVerification && pendingVerification.phone === phone ? pendingVerification.verificationId : ''
  const isUserHint =
    pendingVerification && pendingVerification.phone === phone ? pendingVerification.isUser : null
  if (verificationId === '') {
    return { ok: false, message: '請先點「獲取驗證碼」，收到短訊後再輸入。' }
  }
  const auth = await otpAuth()
  if (!auth || typeof auth.verify !== 'function') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '短訊驗證暫不可用（未配置雲端資料源）；本次未登入、零寫入。'
    }
  }
  let verified = null
  try {
    verified = await auth.verify({ verification_id: verificationId, verification_code: typed })
  } catch (error) {
    return otpFailureFriendly(error, '驗證碼不正確或已過期，請重新獲取驗證碼。')
  }
  const verificationToken = String((verified && verified.verification_token) || '').trim()
  if (verificationToken === '') {
    /* v2 形態的容錯：`verify` 直接把會話簽下來（不給 `verification_token`）⇒ 直接取會話憑證。 */
    const direct = await platformAccessTokenOf(auth)
    if (direct !== '') {
      pendingVerification = { phone: '', verificationId: '', isUser: null }
      return { ok: true, mode: 'cloud', accessToken: direct }
    }
    return { ok: false, message: '驗證回包形狀不可辨識，請重新獲取驗證碼。' }
  }
  /* **老號 signIn / 新號 signUp 二選一**（存在性先行，不拿 token 試錯；見 establishPlatformSession）。 */
  const established = await establishPlatformSession(auth, phone, verificationToken, isUserHint)
  if (!established.ok) return denialOf(established.denial)
  const accessToken = await platformAccessTokenOf(auth)
  if (accessToken === '') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '登入未取得平台會話憑證，請稍後重試；本次未登入、零寫入。'
    }
  }
  /* 一次性：驗過即作廢（重放同一 `verification_id` 沒有意義）。 */
  pendingVerification = { phone: '', verificationId: '', isUser: null }
  return { ok: true, mode: 'cloud', accessToken }
}

/**
 * **登錄收尾（兩條登錄路共用的唯一一份）** —— P2 抽出。
 *
 * 為什麼要抽：短訊驗證碼路（`login`）與密碼路（`loginWithPassword`）在**平台側**是兩套憑據
 * （一個是 `verification_token`，一個是密碼），但**過了「換到 xiai 令牌」這一步之後，
 * 語義必須逐字相同**：老賬號登錄 / 新賬號建號 + 初始金 + 邀請結算 + 寫 session。
 * 兩份實現必然漂移（一邊加了初始金、另一邊漏了邀請結算）⇒ 只留這一份。
 *
 * 硬口徑：**只被「已經通過服務端換票」的調用方調用**（本函數自己不做任何驗證）；
 * 它只寫本地鏡像面（賬號行 / 初始金 / session / 邀請結算），身份真源仍在服務端。
 *
 * @param {string} phone 已歸一的 11 位手機號
 * @param {{inviterId?:string}} [options]
 * @returns {{ok:true, user:object, invite:object, registered:boolean}}
 */
function finalizeLogin(phone, options = {}) {
  const users = listUserRows()
  let user = users.find((u) => u.phone === phone)
  let registered = false
  if (!user) {
    /* 管理员手机号（数据层唯一真源 ADMIN_PHONE）建号即为 admin；其余一律普通用户。
       正常路径下数据层引导已按同一常量建好管理员账号，此处仅作兜底。 */
    const isAdminPhone = phone === ADMIN_PHONE
    user = {
      id: uidOf(phone),
      phone,
      nickname: isAdminPhone ? ADMIN_NICKNAME : `印友${phone.slice(-4)}`,
      role: isAdminPhone ? 'admin' : 'user',
      points: GOLD_INITIAL,
      created_at: new Date().toISOString()
    }
    saveUserRows([...users, user])
    /* 初始赠送**先于**邀请结算落盘：否则被邀请人的「初始贈送（50 金）」会被
       `grantInitialGold` 的「已有任意流水即不再赠送」判据跳过。 */
    grantInitialGold(user)
    registered = true
  }
  setUser(user)

  const inviterId = options && options.inviterId ? String(options.inviterId) : ''
  const invite = registered && inviterId
    ? settleInviteReward(inviterId, user.id)
    : { ok: true, settled: false, reason: registered ? 'NO_INVITER' : 'NOT_A_REGISTRATION', message: '本次未觸發邀請結算。' }

  return { ok: true, user, invite, registered }
}

/**
 * 登录（＝註冊成功路径的**唯一入口**：老账号登录 / 新账号建号 + 初始赠送）。
 *
 * **邀请结算钩（v1.21 新增｜§5.1 ⑦）**：触发时点**恰为「被邀请人註冊成功」** ——
 * 即本函数**新建账号**那一次；调用方可经 `options.inviterId` 提供邀请人用户 id。
 * 老账号登录**不触发**结算（不以「邀请人登录」等其它条件触发）。
 *
 * @param {string} phone 手机号
 * @param {string} code 短訊驗證碼（**平台判**；前端不持有、不生成、不回包）
 * @param {{inviterId?:string}} [options]
 * @returns {Promise<{ok:boolean, user?:object, message?:string, invite?:object, reason?:string}>}
 *
 * 判定顺序（**任一步失敗即整體失敗、零半成品**）：
 *   ① 平台短訊驗證（`getVerification`（**不傳 target**）→ `verify` → 老號 `signIn` / 新號 `signUp`
 *      → `access_token`）；
 *   ② 把平台憑證交後端換 xiai 令牌（凍結契約：`issue` 收 `{phone, platformAccessToken}`）；
 *   ③ 過①②之後才落本地鏡像：賬號行 / 初始金 / session / 邀請結算 —— 走**共用收尾**
 *      `finalizeLogin()`（與密碼登錄**同一份**；既有語義一字不改）。
 */
export async function login(phone, code, options = {}) {
  const normalized = String(phone || '').trim()
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  /* ① 平台短訊驗證（真發碼路徑下的唯一身份判據）。 */
  const platform = await verifyPlatformOtp(normalized, code)
  if (!platform.ok) return denialOf(platform)
  /* ② 平台憑證 ⇒ xiai 令牌（服務端驗的是平台簽發的令牌，前端不自稱身份）。 */
  if (platform.mode === 'cloud') {
    const exchanged = await ensureUserLoginToken(normalized, platform.accessToken)
    if (!exchanged.ok) return denialOf(exchanged)
  }

  /* ③ 共用收尾（本地庫是鏡像面，身份真源在服務端）。 */
  return finalizeLogin(normalized, options)
}

/**
 * **手機號 ＋ 密碼登入（平台原生身份；與短訊驗證碼登入**並存**｜P2 正式化）**
 * ----------------------------------------------------------------------------
 * 形态：用户名 = 用户填的 **11 位手機號**（賬號由人類在雲開發控制台建立，密碼由人類設定）
 * ⇒ 調平台原生 `auth.signInWithPassword({ username, password })`。
 *
 * **SDK 實例**：走 `data/cloudbaseAuth.js::otpAuth()`（**內存持久化** `persistence:'none'`），
 * 與短訊驗證碼路**同一個實例** —— 這不是細節：`persistence:'local'` 上殘留的**匿名會話**
 * 會讓「用 try/catch 判成功」得到假綠（本函數的成敗判據見下）；內存實例天然沒有這份殘留。
 *
 * ⚠️ **該版 SDK 的 `signInWithPassword` 不拋異常、統一返回 `{data, error}`** ⇒ 判成敗
 * **必須檢查 `error`**（源碼位置：`dist/index.esm.js` 偏移 233585，`case 3: return r=i.sent(),
 * (o=new un(r,{method:"signInWithPassword"}))`）。故：`error` 為真 ⇒ 失敗；
 * `error` 為假**且**取到會話/user ⇒ 才報成功；並額外拒 `is_anonymous === true` 的會話。
 *
 * **完整鏈路（與短訊驗證碼路同語義，P2 起）**：
 *   ① 平台 `signInWithPassword`（本函數）；
 *   ② 取平台會話 `access_token`（**只作憑證交後端**；不打印、不落盤、不上屏）；
 *   ③ `ensureUserLoginToken(phone, accessToken)` 換 xiai 令牌（服務端驗簽取號，前端不自稱身份）；
 *   ④ **共用收尾** `finalizeLogin()`：賬號行 / 初始金 / 邀請結算 / session —— **與 `login()` 同一份**。
 * 任一步失敗 ⇒ **零半成品**（不建本地賬號行、不寫 session、不發金、不結算邀請）。
 *
 * @param {string} phone 手機號（＝用戶名）
 * @param {string} password 密碼
 * @param {{inviterId?:string}} [options]
 * @returns {Promise<{ok:true, user:object, invite:object, registered:boolean, mode:string}
 *                  |{ok:false, message:string, reason?:string, code?:string}>}
 *          失敗一律回**可見**的繁體 `message`；**不新增 reason 字面值**（`code` 只是平台原樣讀數）。
 */
export async function loginWithPassword(phone, password, options = {}) {
  const normalized = String(phone || '').trim()
  const secret = String(password || '')
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  if (secret === '') {
    return { ok: false, message: '請輸入密碼' }
  }
  const auth = await otpAuth()
  if (!auth || typeof auth.signInWithPassword !== 'function') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '密碼登錄暫不可用（未配置雲端資料源）；本次未登錄、零寫入，可改用「手機號 + 驗證碼」登錄。'
    }
  }
  /* ① 平台密碼登錄（判據全在平台側）。 */
  const signed = await signInWithPlatformPassword(auth, normalized, secret)
  if (!signed.ok) return signed.denial
  /* ② 平台會話憑證。 */
  const accessToken = await platformAccessTokenOf(auth)
  if (accessToken === '') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '登錄未取得平台會話憑證，請稍後重試；本次未登錄、零寫入。'
    }
  }
  /* ③ 平台憑證 ⇒ xiai 令牌（與短訊驗證碼路**同一判據**）。 */
  const exchanged = await ensureUserLoginToken(normalized, accessToken)
  if (!exchanged.ok) return denialOf(exchanged)
  /* ④ 共用收尾（與 `login()` **同一份**）。 */
  const finalized = finalizeLogin(normalized, options)
  return { ...finalized, mode: exchanged.mode }
}

/**
 * 平台密碼登錄的一次嘗試（**只在「用戶名形態不對」時換形態重試一次**）。
 *
 * 為什麼要有形態重試：控制台建賬號時 `username` 可能填 **11 位號碼**，也可能被建成
 * **手機號身份**（平台內部記為 `"+86 138…"`）。兩者平台都認，但填錯形態會得到
 * 「用戶不存在」—— 那不是密碼錯，不該讓用戶去猜。
 *
 * 硬邊界：
 *   · **只在 `USER_NOT_FOUND` 這一類錯誤時**換形態（密碼錯／頻控／驗證碼 一律**不重試**，
 *     避免把「猜密碼」變成兩次嘗試）；
 *   · 每一次嘗試都**只交本人密碼**給平台，前端不保存、不派生任何憑據。
 *
 * @returns {Promise<{ok:true}|{ok:false, denial:object}>} 失敗 ⇒ `denial` 即可上屏的結構化結果
 */
async function signInWithPlatformPassword(auth, phone, secret) {
  const forms = [phone, platformPhoneOf(phone)]
  let lastError = null
  for (let index = 0; index < forms.length; index += 1) {
    let reply = null
    try {
      reply = await auth.signInWithPassword({ username: forms[index], password: secret })
    } catch (error) {
      /* 契約上不該走到這裡（該版 SDK 不拋）——留作最後一道結構化失敗，不讓異常外逸。 */
      return { ok: false, denial: passwordLoginFailure(error) }
    }
    const error = reply && reply.error
    if (!error) {
      /* `error` 為假仍要驗會話：匿名會話 / 空會話都不算登錄成功。 */
      const session = platformSessionOf(reply)
      if (session.present && !session.anonymous) return { ok: true }
      return {
        ok: false,
        denial: { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '登錄未取得有效的平台會話，請稍後重試；本次未登錄、零寫入。' }
      }
    }
    lastError = error
    if (!platformUserMissing(error)) break
  }
  return { ok: false, denial: passwordLoginFailure(lastError) }
}

/** 平台回包裡的會話讀數（只取「有沒有」與「是不是匿名」，**不取令牌原文**）。 */
function platformSessionOf(reply) {
  const data = reply && reply.data ? reply.data : null
  const session = data && data.session ? data.session : null
  const user = data && data.user ? data.user : null
  const present = !!(session || user)
  const anonymous = !!(session && (session.is_anonymous === true || session.isAnonymous === true))
  return { present, anonymous }
}

/** 平台是否回「用戶不存在」（**只有這一類**才值得換用戶名形態重試）。 */
function platformUserMissing(error) {
  const text = `${String((error && error.code) || '')} ${String((error && error.category) || '')}`.toLowerCase()
  return text.indexOf('user_not_found') !== -1 || text.indexOf('user_not_exists') !== -1
}

/**
 * 平台登入失敗 ⇒ 可見繁體文案（**不新增工程 reason 字面值**；`code` 只作原樣讀數）。
 *
 * 口型：
 *   · 憑據錯（`invalid_username_or_password` 等）⇒ **短文案**「手機號或密碼不正確」
 *     （平台對這兩種錯**故意不區分**，前端也不得替它區分）；
 *   · 頻控 / 未開啟 / 需人機校驗 / 服務異常 ⇒ **平台原文透傳**（`otpFailureVerbatim`），
 *     因為這幾類的可處置動作各不相同，折成通用提示等於把用戶晾在原地；
 *   · 其餘 ⇒ 原文（有 `message` 就用），沒有才回落通用文案。
 */
function passwordLoginFailure(error) {
  const code = String((error && (error.code || error.error_code)) || '').trim().toLowerCase()
  const category = String((error && error.category) || '').trim()
  /* 憑據錯**先判**（平台故意不區分「查無此人」與「密碼錯」；前端也不替它區分，
     更不得把平台的長篇排障說明當成用戶提示）。 */
  if (code === 'invalid_username_or_password' || code === 'invalid_credentials' || code === 'invalid_password') {
    return {
      ok: false,
      message: '手機號或密碼不正確，請重新輸入；如忘記密碼，可點「忘記密碼？」重設。',
      code
    }
  }
  /* 頻控 / 未開啟 / 需人機校驗 / 服務異常 ⇒ **平台原文**（可處置動作各不相同）。 */
  if (
    category === 'RATE_LIMITED' ||
    category === 'PROVIDER_NOT_ENABLED' ||
    category === 'CAPTCHA_REQUIRED' ||
    category === 'MFA_REQUIRED' ||
    code === 'user_not_found'
  ) {
    return otpFailureVerbatim(error)
  }
  const message = String((error && error.message) || '').trim()
  if (message !== '') return { ok: false, message, code }
  return { ok: false, message: '登錄失敗，請稍後再試。', code }
}

/**
 * **忘記密碼 ⇒ 短訊驗證碼驗證 ⇒ 重置密碼（P2 自助流程）**
 * ============================================================================
 * **契約以 SDK 源碼為準（`node_modules/@cloudbase/js-sdk/dist/index.esm.js`，實裝 2.32.0）**：
 *   · `resetPasswordForEmail(emailOrPhone, options)`（偏移 240860）自己就是一條**兩步**通道：
 *     先 `getVerification({phone_number, target:'USER'})`（**自己發碼**）⇒ 回包給
 *     `{data:{updateUser}}`；再 `updateUser({nonce, password})` ⇒ `verify({verification_id,
 *     verification_code:nonce})` ⇒ `oauthInstance.authApi.resetPassword({phone_number,
 *     new_password, verification_token})` ⇒ 自動 `signInWithPassword`。
 *   · 因此**重置 ＝ 先驗碼拿 `verification_token`，再 `resetPassword`**（兩步，缺一不可）；
 *   · `resetPassword(body)`（偏移 269017）＝ `authApi.resetPassword`（偏移 197712）⇒
 *     POST `/auth/v1/reset`，body **原樣上送** ⇒ 必填三鍵
 *     `{ phone_number, new_password, verification_token }`；
 *   · `setPassword(body)`（偏移 265121）⇒ **PATCH** `/auth/v1/user/password`，
 *     要 `{ sudo_token, new_password }`；`sudo({password|verification_token})`（偏移 269359）
 *     ⇒ POST `/auth/v1/user/sudo` 換 `sudo_token`。那是「**已登錄後改密**」的第二形態，
 *     **本流程不用它**（忘記密碼時沒有會話，且它需要另一條 sudo 支路）。
 *
 * **為什麼不用 `resetPasswordForEmail` 一把梭**：它會**自己再發一條短訊**——
 * 那會繞過本頁的 60s 冷卻與頻控原文上屏（同一號碼被兩個入口各發一次 ⇒ 用戶收到兩條、
 * 平台的每日上限被吃掉兩條）。所以本流程用**同一個 `requestCode()` 的 `verification_id`**
 * 去 `verify`，再自己 `resetPassword`：**一步一碼、一碼一用**。
 *
 * **零副作用（逐條）**：密碼不合規 ⇒ 不發請求；碼錯 / 碼過期 ⇒ `verify` 失敗即返回，
 * **`resetPassword` 根本沒被調用** ⇒ 平台上的舊密碼一字不動；`resetPassword` 被平台拒 ⇒
 * 舊密碼同樣不動；本地 session / 賬號行 / 金 / 邀請結算**只在重置成功且重新登錄成功後**
 * 由共用收尾 `finalizeLogin()` 落。
 *
 * @param {string} phone 11 位手機號（**必須與取碼時同一號**）
 * @param {string} code 用戶收到的短訊驗證碼（平台判；前端不持有、不回包）
 * @param {string} newPassword 新密碼（規則見 `passwordPolicyError`）
 * @param {{inviterId?:string}} [options] 重置後自動登錄的邀請人（新賬號場景）
 * @returns {Promise<{ok:true, loggedIn:boolean, message:string, user?:object, invite?:object, registered?:boolean}
 *                  |{ok:false, message:string, reason?:string, retryAfter?:number, category?:string}>}
 */
export async function resetPasswordByOtp(phone, code, newPassword, options = {}) {
  const normalized = String(phone || '').trim()
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  /* ① 新密碼規則：不合規**就地拒**（零請求、零副作用）。 */
  const policyError = passwordPolicyError(newPassword)
  if (policyError !== '') {
    return { ok: false, reason: 'WEAK_PASSWORD', message: policyError }
  }
  /* ② 驗證碼形態：不到位就不發請求。 */
  const typed = String(code || '').replace(/\s+/g, '')
  if (typed === '') return { ok: false, message: '請輸入短訊驗證碼' }
  if (!CODE_PATTERN.test(typed)) return { ok: false, message: '驗證碼應為 6 位數字' }
  const verificationId = pendingVerification && pendingVerification.phone === normalized
    ? pendingVerification.verificationId
    : ''
  if (verificationId === '') {
    return { ok: false, message: '請先點「獲取驗證碼」，收到短訊後再輸入。' }
  }
  const auth = await otpAuth()
  if (
    !auth ||
    typeof auth.verify !== 'function' ||
    typeof auth.resetPassword !== 'function'
  ) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '重置密碼暫不可用（未配置雲端資料源或 SDK 不支援）；本次未改動任何密碼。'
    }
  }
  /* ③ 第一步：驗碼 ⇒ `verification_token`（失敗 ⇒ 原文上屏；**舊密碼未被觸碰**）。 */
  let verified = null
  try {
    verified = await auth.verify({ verification_id: verificationId, verification_code: typed })
  } catch (error) {
    return otpFailureVerbatim(error)
  }
  const verificationToken = String((verified && verified.verification_token) || '').trim()
  if (verificationToken === '') {
    return { ok: false, message: '驗證回包形狀不可辨識，請重新獲取驗證碼；本次未改動任何密碼。' }
  }
  /* ④ 第二步：帶 token 重置（平台錯誤**原文透傳**，不折成通用提示）。 */
  try {
    await auth.resetPassword({
      phone_number: normalized,
      new_password: String(newPassword),
      verification_token: verificationToken
    })
  } catch (error) {
    return otpFailureVerbatim(error)
  }
  /* 一次性句柄：用過即作廢。 */
  pendingVerification = { phone: '', verificationId: '', isUser: null }
  /* ⑤ 重置成功 ⇒ 立刻用新密碼登錄（等於「重設即登入」）。
     這一步失敗**不影響已完成的密碼重設** ⇒ 回 `ok:true, loggedIn:false` 並如實說明。 */
  const relogin = await loginWithPassword(normalized, newPassword, options)
  if (relogin.ok) {
    return {
      ok: true,
      loggedIn: true,
      user: relogin.user,
      invite: relogin.invite,
      registered: relogin.registered,
      message: '密碼已重設，已用新密碼自動登錄。'
    }
  }
  return {
    ok: true,
    loggedIn: false,
    message: `密碼已重設，請用新密碼登錄。${relogin.message ? `（${relogin.message}）` : ''}`
  }
}

/**
 * **退出登錄（登出）—— 三態、全或全無、可重試**。
 *
 * 順序是硬口徑（**不得反**）：
 *   ① **先**等平台側撤銷完成（`signOutOtpSession()`；本函數唯一可能失敗的一步）；
 *   ② 撤銷**成功之後**才清本地（登錄態 ＋ 兩條令牌 ＋ 平台 SDK 實例）；
 *   ③ 收尾自檢：本地登錄態沒清乾淨 ⇒ **如實回失敗**，不假裝成功。
 *
 * 為什麼不能「先清後發請求」：清了本地就沒有憑證可撤，平台會話成了**孤兒**
 * （同一頁面內仍可換票）；而且請求失敗時本地已毀 ⇒ 使用者既沒退出成功、也回不去原狀態。
 *
 * 失敗分支（平台撤銷拋錯 / 本地清不乾淨）：**原會話原樣保留**（不清一半），
 * 回 `{ ok:false, message:'退出失敗：<簡短原因>' }`，由頁面給可見文案並允許重試。
 *
 * 冪等：未登錄時點退出 ⇒ 零網絡、零報錯，直接回「已在未登錄態」。
 * @returns {Promise<{ok:boolean, already?:boolean, message:string}>}
 */
export async function logout() {
  /* **冪等（未登錄 ⇒ 已經是登出態）**：不發請求、不報錯、不改寫任何東西。 */
  if (!currentUser()) {
    return { ok: true, already: true, message: LOGOUT_DONE_TEXT }
  }

  /* ① 平台側撤銷：**先 await 完成**（失敗即回頭，本地一字不動）。 */
  let ended = null
  try {
    ended = await signOutOtpSession()
  } catch (error) {
    ended = { ok: false, reason: error }
  }
  if (!ended || ended.ok === false) {
    return { ok: false, message: logoutFailureText((ended && ended.reason) || '平台會話未能撤銷') }
  }

  /* ② 平台會話已撤銷 ⇒ 才清本地 */
  setUser(null)
  /* **R-L10（P3）**：登出必須**清持久化令牌**（兩條通道各一個键；`clear()` 是唯一清点）。
     顺序：先丢令牌、再丢平台会话 —— 后者作废后无法再换票，故令牌必须此前清掉。 */
  clearUserToken()
  clearAdminToken()
  /* 同時丟掉**平台會話**（`persistence:'none'` ⇒ 只存在內存裡；作廢實例即等於清掉它）。
     不影響讀面 / 寫面那兩個 app 實例的匿名會話。 */
  resetOtpAuth()

  /* ③ 收尾自檢：清不乾淨 ⇒ 如實報失敗（不退化成「看起來退了」） */
  if (currentUser()) {
    return { ok: false, message: logoutFailureText('本地登錄態未能清空，請重試') }
  }
  return { ok: true, already: false, message: LOGOUT_DONE_TEXT }
}

export function bootstrapSession() {
  return restoreSession((id) => listUserRows().find((u) => u.id === id) || null)
}

export function findUserById(id) {
  return listUserRows().find((u) => u.id === id) || null
}
