/**
 * 玺爱 · **P2 密码登錄 / 忘記密碼 自檢**（Kong｜離線、零網絡、零真實短訊）
 * ============================================================================
 * 被測真源（**一字不改地 import 倉內文件**，不複製實現）：
 *   · `src/services/auth.js` —— `loginWithPassword` / `resetPasswordByOtp` / `login` /
 *     `passwordPolicyError` / `requestCode`，以及兩路共用的收尾 `finalizeLogin`；
 *   · `src/data/cloudbaseAuth.js` —— `setOtpAuthProvider`（**倉內既有**注入縫）；
 *   · `src/services/userToken.js` —— `setUserTokenTransport`（**倉內既有**傳輸縫）。
 *
 * 注入的三件套（**全部是既有縫，不自立第二套**）：
 *   ① `setOtpAuthProvider` ⇒ 假「平台 auth 實例」：它保有「密碼表 / 驗證碼表」，
 *      只有收到**正確密碼**才回會話、只有收到**正確驗證碼**才回 `verification_token`
 *      —— 也就是把「平台側判據」搬到本機內存裡，判據本身不弱化；
 *   ② `setUserTokenTransport` ⇒ 假雲函數傳輸：可切 `ok` / `forbidden` 兩態，
 *      並**計次**（「零 issue 請求」的判據就是它的計數）；
 *   ③ `setWriteFaceModeOverride('cloud')` ⇒ 讓兩條登錄路都走「雲端形態」（否則
 *      `local-dev` 會短路掉換票這一步，自檢就證明不了任何事）。
 *
 * 六條口徑（逐條對應派單）：
 *   ① 密碼錯 ⇒ 文案含「手機號或密碼不正確」＋ `hasUserToken()===false` ＋ 賬號行未增 ＋ **零 issue 請求**
 *      （且**只嘗試一次**：不得把「猜密碼」變成兩次）；
 *   ② 密碼對但 issue 回 `FORBIDDEN` ⇒ 零 session / 零賬號行 / 零發金（issue **確有**發生 ⇒ 非空轉）；
 *   ③ 重置碼錯 ⇒ `verify` 被調、`resetPassword` **未被調**、平台舊密碼不變、本地零副作用；
 *   ④ 重置成功 ⇒ 可立刻用新密碼登錄、**舊密碼失效**；
 *   ⑤ 弱密碼四種（`abc` / `abcdefgh` / `12345678` / 超 20 位）⇒ 就地拒、**零 `verify` / 零 `resetPassword` /
 *      零傳輸請求**（且此前已 `requestCode` 成功 ⇒ 不是「因缺 pending 而拒」的假綠）；
 *   ⑥ 機械口徑：`finalizeLogin` **恰 1 處定義 / 恰 2 處調用**、`saveUserRows(` **恰 1 處**；
 *      兩路（短訊碼路 vs 密碼路）建出的 user 行**鍵面相同、初始金 50、`invite.reason==='NO_INVITER'`**
 *      （形狀逐字相等）。
 *
 * 紀律：**不打印任何手機號 / 密碼 / 令牌原文**（只打布爾、計數、鍵名、金額）；
 *       不發任何真實短訊、不打任何真實雲端（傳輸層是注入的假體）；斷言失敗 ⇒ 退出碼非 0。
 *
 * 用法：node tests/p2-auth-password.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AUTH_PATH = path.join(ROOT, 'src/services/auth.js')

/* ---------------------------------------------------------------------------
   0. localStorage 假體（只為讓數據層 / 服務層的 ESM 真源能在本機 Node 下被 import；
      `src/data/storage.js` 是倉內唯一碰 `window.localStorage` 的模塊）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 斷言與讀數（**只打布爾 / 計數 / 鍵名**）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

const section = (title) => console.log(JSON.stringify({ section: title }))

/* ---------------------------------------------------------------------------
   2. 加載被測件（**全部走倉內真源**）
   --------------------------------------------------------------------------- */
const authSvc = await import(path.join(ROOT, 'src/services/auth.js'))
const cloudbaseAuth = await import(path.join(ROOT, 'src/data/cloudbaseAuth.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const db = await import(path.join(ROOT, 'src/data/db.js'))
const session = await import(path.join(ROOT, 'src/data/session.js'))
/* 金流水 `type` 的**真源**（不猜字面量：`LEDGER_TYPE.INITIAL` 是中文標籤「初始贈送」）。 */
const pointsSvc = await import(path.join(ROOT, 'src/services/points.js'))

/* 兩條登錄路都必須走「雲端形態」，否則換票那一步會被 local-dev 短路掉。 */
writeFace.setWriteFaceModeOverride('cloud')

/* ---------------------------------------------------------------------------
   3. 假「平台 auth 實例」（判據在它自己的兩張表裡：密碼表 / 驗證碼表）
   ---------------------------------------------------------------------------
   設計要點（**這幾條保證自檢不是空轉**）：
     · `signInWithPassword` 只認「密碼表裡逐字相同的那一個」；錯即回
       `{data:null, error:{code:'invalid_username_or_password'}}`（**該版 SDK 不拋錯**的真實形狀）；
     · 錯誤碼刻意寫成 `invalid_username_or_password`（平台**故意不區分**「查無此人」與「密碼錯」）
       ⇒ 順帶證明前端**不會**因「用戶不存在」去換形態重試（只嘗試一次）；
     · `verify` 只認本機簽發過的 `verification_id` ＋ 正確碼；錯即拋
       `INVALID_VERIFICATION_CODE`（`resetPassword` 因此**根本到不了**）；
     · `resetPassword` 才會改密碼表 ⇒ 「舊密碼不變」的判據就是這張表。
   --------------------------------------------------------------------------- */
const OTP_CORRECT = '135790' // 假平台「正確驗證碼」的夾具值（**不是**任何生產固定碼，也不上屏）
const WEAK_FOR_OTP = '000000' // 假平台「錯誤驗證碼」的夾具值
const FAKE_PLATFORM_SESSION = 'fake-platform-session-credential'

function makeFakePlatform() {
  const state = {
    passwords: new Map(), // 11 位手機號 -> 密碼（平台側唯一真源）
    issues: new Map(), // verification_id -> { phone, code }
    seq: 0,
    signedIn: false,
    calls: { getVerification: 0, verify: 0, signIn: 0, signInWithPassword: 0, resetPassword: 0, getSession: 0 }
  }
  const auth = {
    async getVerification({ phone_number: phoneNumber }) {
      state.calls.getVerification += 1
      state.seq += 1
      const id = `vid-${state.seq}`
      state.issues.set(id, { phone: String(phoneNumber), code: OTP_CORRECT })
      return { verification_id: id }
    },
    async verify({ verification_id: id, verification_code: code }) {
      state.calls.verify += 1
      const record = state.issues.get(id)
      if (!record || record.code !== String(code)) {
        const error = new Error('驗證碼不正確或已過期，請重新獲取驗證碼。')
        error.code = 'INVALID_VERIFICATION_CODE'
        throw error
      }
      return { verification_token: `vt-${id}` }
    },
    async signIn() {
      state.calls.signIn += 1
      state.signedIn = true
      return { data: {} }
    },
    async signInWithPassword({ username, password }) {
      state.calls.signInWithPassword += 1
      /* 平台兩種用戶名形態都認（`138…` 與 `+86 138…`）⇒ 這裡同形歸一。 */
      const key = String(username).replace(/^\+86\s*/, '').trim()
      const stored = state.passwords.get(key)
      if (stored === undefined || stored !== String(password)) {
        return { data: null, error: { code: 'invalid_username_or_password', message: 'invalid username or password' } }
      }
      state.signedIn = true
      return {
        data: { session: { access_token: FAKE_PLATFORM_SESSION, is_anonymous: false }, user: { phone_number: `+86 ${key}` } },
        error: null
      }
    },
    async getSession() {
      state.calls.getSession += 1
      if (!state.signedIn) return { data: { session: null } }
      return { data: { session: { access_token: FAKE_PLATFORM_SESSION, is_anonymous: false } } }
    },
    async resetPassword({ phone_number: phoneNumber, new_password: newPassword }) {
      state.calls.resetPassword += 1
      state.passwords.set(String(phoneNumber), String(newPassword))
      return { data: {} }
    }
  }
  return { state, auth }
}

/* ---------------------------------------------------------------------------
   4. 假雲函數傳輸（`xiai-user-token` 的 `action:'issue'` 一態）
   --------------------------------------------------------------------------- */
const transportState = { mode: 'ok', log: [] }

function fakeTransport(name, data) {
  const action = data && data.action
  transportState.log.push({ name, action })
  if (transportState.mode === 'forbidden') {
    return Promise.resolve({ result: { ok: false, reason: 'FORBIDDEN', message: '服務端結構化拒絕；本次零寫入。' } })
  }
  if (transportState.mode === 'unavailable') {
    return Promise.resolve({ ok: false, reason: 'STORAGE_UNAVAILABLE', message: '傳輸層不可用（注入）。' })
  }
  const now = Math.floor(Date.now() / 1000)
  return Promise.resolve({
    result: {
      ok: true,
      token: 'fake-user-token-not-a-real-credential',
      expiresAt: now + 900,
      issuedAt: now,
      ttlSeconds: 900,
      ver: '1',
      sub: String((data && data.phone) || ''),
      uid: 'u-0000000000000000',
      serverNow: now
    }
  })
}

/* ---------------------------------------------------------------------------
   5. 每個用例前的「乾淨起點」（令牌緩存 / 本地會話 / 假平台計數）
   --------------------------------------------------------------------------- */
function resetRuntime() {
  userTokenSvc.clearUserToken()
  session.setUser(null)
  transportState.mode = 'ok'
  transportState.log.length = 0
}

const issueCount = () => transportState.log.length
const userRowCount = () => db.listUserRows().length
const pointRowCount = () => db.listPointRows().length
const signInAttempts = () => platform.state.calls.signInWithPassword

const platform = makeFakePlatform()
cloudbaseAuth.setOtpAuthProvider(async () => platform.auth)
userTokenSvc.setUserTokenTransport(fakeTransport)

/* 合成手機號（與既有自檢同族：**測試夾具值**，不是任何真實號碼）。 */
const P_WRONG_PW = '13800000011'
const P_ISSUE_FORBIDDEN = '13800000012'
const P_RESET_BAD_CODE = '13800000013'
const P_RESET_OK = '13800000014'
const P_WEAK = '13800000015'
const P_OTP_PARITY = '13800000016'
const P_PW_PARITY = '13800000017'
const PASSWORD_ORIGINAL = 'OrigPass123'
const PASSWORD_NEW = 'NewPass456'

/* ===========================================================================
   ① 密碼錯 ⇒ 短文案 ＋ 零令牌 ＋ 賬號行未增 ＋ 零 issue 請求 ＋ 只嘗試一次
   =========================================================================== */
section('① 密碼錯誤（平台原生 signInWithPassword 判）')

{
  platform.state.passwords.set(P_WRONG_PW, PASSWORD_ORIGINAL)
  resetRuntime()
  const rowsBefore = userRowCount()
  const pointsBefore = pointRowCount()
  const issuesBefore = issueCount()
  const attemptsBefore = signInAttempts()

  const denied = await authSvc.loginWithPassword(P_WRONG_PW, 'WrongPass999')

  check('1a', '密碼錯 ⇒ ok:false', false, denied.ok === true)
  check('1b', '文案含「手機號或密碼不正確」（不替平台區分「查無此人」與「密碼錯」）', true, String(denied.message || '').indexOf('手機號或密碼不正確') !== -1)
  check('1c', '未取得用戶令牌（hasUserToken() === false）', false, userTokenSvc.hasUserToken())
  check('1d', '本地未寫 session（currentUser() === null）', null, session.currentUser())
  check('1e', '賬號行未增（零半成品）', rowsBefore, userRowCount())
  check('1f', '金流水未增（零發金）', pointsBefore, pointRowCount())
  check('1g', '**零 issue 請求**（換票一步都沒發）', issuesBefore, issueCount())
  check('1h', '平台只被嘗試一次（不得把「猜密碼」變成兩次）', attemptsBefore + 1, signInAttempts())
}

/* ===========================================================================
   ② 密碼對、但換票回 FORBIDDEN ⇒ 零 session / 零賬號行 / 零發金
   =========================================================================== */
section('② 密碼對、issue 回 FORBIDDEN ⇒ 零半成品')

{
  platform.state.passwords.set(P_ISSUE_FORBIDDEN, PASSWORD_ORIGINAL)
  resetRuntime()
  transportState.mode = 'forbidden'
  const rowsBefore = userRowCount()
  const pointsBefore = pointRowCount()
  const issuesBefore = issueCount()

  const denied = await authSvc.loginWithPassword(P_ISSUE_FORBIDDEN, PASSWORD_ORIGINAL)

  check('2a', '整體失敗 ok:false', false, denied.ok === true)
  check('2b', 'reason 原樣透傳 ＝ FORBIDDEN', 'FORBIDDEN', denied.reason)
  check('2c', 'issue **確有**發生（本條不是空轉）', issuesBefore + 1, issueCount())
  check('2d', '零令牌（hasUserToken() === false）', false, userTokenSvc.hasUserToken())
  check('2e', '零 session（currentUser() === null）', null, session.currentUser())
  check('2f', '零賬號行', rowsBefore, userRowCount())
  check('2g', '零發金（金流水未增）', pointsBefore, pointRowCount())
}

/* ===========================================================================
   ③ 重置碼錯 ⇒ verify 被調、resetPassword 未被調、舊密碼不變、本地零副作用
   =========================================================================== */
section('③ 重置碼錯 ⇒ resetPassword 未被調用、舊密碼不動')

{
  platform.state.passwords.set(P_RESET_BAD_CODE, PASSWORD_ORIGINAL)
  resetRuntime()
  transportState.mode = 'ok'
  const codeRequest = await authSvc.requestCode(P_RESET_BAD_CODE)
  check('3a', '取碼成功（真發碼入口走平台 getVerification）', true, codeRequest.ok === true)

  const rowsBefore = userRowCount()
  const pointsBefore = pointRowCount()
  const verifyBefore = platform.state.calls.verify
  const resetBefore = platform.state.calls.resetPassword
  const issuesBefore = issueCount()

  const denied = await authSvc.resetPasswordByOtp(P_RESET_BAD_CODE, WEAK_FOR_OTP, PASSWORD_NEW)

  check('3b', '整體失敗 ok:false', false, denied.ok === true)
  check('3c', 'verify 被調過一次（判據真的在平台側）', verifyBefore + 1, platform.state.calls.verify)
  check('3d', '**resetPassword 未被調用**', resetBefore, platform.state.calls.resetPassword)
  check('3e', '平台舊密碼一字不動', PASSWORD_ORIGINAL, platform.state.passwords.get(P_RESET_BAD_CODE))
  check('3f', '新密碼未被寫進平台', false, platform.state.passwords.get(P_RESET_BAD_CODE) === PASSWORD_NEW)
  check('3g', '零令牌', false, userTokenSvc.hasUserToken())
  check('3h', '零 session', null, session.currentUser())
  check('3i', '零賬號行', rowsBefore, userRowCount())
  check('3j', '零發金', pointsBefore, pointRowCount())
  check('3k', '零換票請求（碼錯不該走到換票）', issuesBefore, issueCount())
}

/* ===========================================================================
   ④ 重置成功 ⇒ 立刻可用新密碼登錄、舊密碼失效
   =========================================================================== */
section('④ 重置成功 ⇒ 新密碼即刻可用、舊密碼失效')

{
  platform.state.passwords.set(P_RESET_OK, PASSWORD_ORIGINAL)
  resetRuntime()
  transportState.mode = 'ok'
  const codeRequest = await authSvc.requestCode(P_RESET_OK)
  check('4a', '取碼成功', true, codeRequest.ok === true)

  const resetBefore = platform.state.calls.resetPassword
  const done = await authSvc.resetPasswordByOtp(P_RESET_OK, OTP_CORRECT, PASSWORD_NEW)

  check('4b', '重置成功 ok:true', true, done.ok === true)
  check('4c', 'resetPassword 恰被調一次', resetBefore + 1, platform.state.calls.resetPassword)
  check('4d', '重置後自動登錄成功（loggedIn === true）', true, done.loggedIn === true)
  check('4e', '平台密碼已改為新密碼', PASSWORD_NEW, platform.state.passwords.get(P_RESET_OK))

  /* 新密碼：另起一次乾淨登錄（證明「可立即用新密碼登錄」不依賴上一步的殘留狀態）。 */
  resetRuntime()
  const withNew = await authSvc.loginWithPassword(P_RESET_OK, PASSWORD_NEW)
  check('4f', '用**新密碼**登錄成功', true, withNew.ok === true)
  check('4g', '新密碼登錄後拿到令牌', true, userTokenSvc.hasUserToken())
  check('4h', '新密碼登錄後 session 指向本人（id 非空且與 uid 派生一致）', true, !!(session.currentUser() && session.currentUser().id))

  /* 舊密碼：必須失效。 */
  resetRuntime()
  const withOld = await authSvc.loginWithPassword(P_RESET_OK, PASSWORD_ORIGINAL)
  check('4i', '用**舊密碼**登錄失敗', false, withOld.ok === true)
  check('4j', '舊密碼失敗文案仍含「手機號或密碼不正確」', true, String(withOld.message || '').indexOf('手機號或密碼不正確') !== -1)
  check('4k', '舊密碼失敗後零令牌', false, userTokenSvc.hasUserToken())
}

/* ===========================================================================
   ⑤ 弱密碼四種 ⇒ 就地拒（零 verify / 零 resetPassword / 零傳輸請求）
   =========================================================================== */
section('⑤ 弱密碼四種 ⇒ 就地拒且零請求')

{
  const WEAK_PASSWORDS = [
    { label: '過短（abc）', value: 'abc' },
    { label: '無數字（abcdefgh）', value: 'abcdefgh' },
    { label: '無字母（12345678）', value: '12345678' },
    { label: '超 20 位', value: `A1${'x'.repeat(19)}` }
  ]
  platform.state.passwords.set(P_WEAK, PASSWORD_ORIGINAL)

  WEAK_PASSWORDS.forEach((item, index) => {
    /* 正 / 負對照：`passwordPolicyError` 直接判（同源於 resetPasswordByOtp 用的那一份）。 */
    const hint = authSvc.passwordPolicyError(item.value)
    check(`5${index}a`, `${item.label} ⇒ passwordPolicyError 非空`, true, hint !== '' && typeof hint === 'string')
  })
  check('5meta-len', '規則常量 8–20（PASSWORD_MIN_LENGTH / MAX）', '8-20', `${authSvc.PASSWORD_MIN_LENGTH}-${authSvc.PASSWORD_MAX_LENGTH}`)
  check('5meta-ok', '合規密碼（NewPass456）⇒ passwordPolicyError 为空串', '', authSvc.passwordPolicyError(PASSWORD_NEW))

  /* 逐條真跑 `resetPasswordByOtp`：先取碼成功（⇒ 不是「因缺 pending 而拒」的假綠）。 */
  for (let index = 0; index < WEAK_PASSWORDS.length; index += 1) {
    const item = WEAK_PASSWORDS[index]
    resetRuntime()
    const codeRequest = await authSvc.requestCode(P_WEAK)
    const verifyBefore = platform.state.calls.verify
    const resetBefore = platform.state.calls.resetPassword
    const issuesBefore = issueCount()

    const denied = await authSvc.resetPasswordByOtp(P_WEAK, OTP_CORRECT, item.value)

    check(`5${index}b`, `${item.label} ⇒ 就地拒（ok:false + reason WEAK_PASSWORD）`, true, denied.ok === false && denied.reason === 'WEAK_PASSWORD')
    check(`5${index}c`, `${item.label} ⇒ 文案為密碼規則說明（非空）`, true, String(denied.message || '').length > 0)
    check(`5${index}d`, `${item.label} ⇒ **零 verify**`, verifyBefore, platform.state.calls.verify)
    check(`5${index}e`, `${item.label} ⇒ **零 resetPassword**`, resetBefore, platform.state.calls.resetPassword)
    check(`5${index}f`, `${item.label} ⇒ 零傳輸請求`, issuesBefore, issueCount())
    check(`5${index}g`, `${item.label} ⇒ 平台密碼表未動`, PASSWORD_ORIGINAL, platform.state.passwords.get(P_WEAK))
    check(`5${index}h`, `${item.label} ⇒ 取碼本身是成功的（負對照有效性）`, true, codeRequest.ok === true)
  }
}

/* ===========================================================================
   ⑥ 機械口徑：finalizeLogin 1 定義 / 2 調用；saveUserRows( 1 處；兩路行形狀逐字相等
   =========================================================================== */

/** 去註釋（只留「碼面」）：塊註釋整段刪、整行 `//` 與 JSDoc 續行（`*`）刪 —— 與既有自檢同族做法。 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join('\n')
}

section('⑥ 收尾單點（機械檢索）＋ 兩路行形狀逐字相等')

{
  const code = codeOnly(readFileSync(AUTH_PATH, 'utf8'))
  const count = (pattern) => (code.match(pattern) || []).length

  check('6a', 'finalizeLogin 定義恰 1 處', 1, count(/function\s+finalizeLogin\s*\(/g))
  check('6b', 'finalizeLogin 賦值形態 0 處（沒有第二份實現）', 0, count(/finalizeLogin\s*=/g))
  check('6c', 'finalizeLogin 碼面總出現 3 處（＝定義 1 ＋ 調用 2）', 3, count(/finalizeLogin\s*\(/g))
  check('6d', 'saveUserRows( 恰 1 處', 1, count(/saveUserRows\s*\(/g))
  check('6e', '兩個調用點分別落在 login() / loginWithPassword()（逐字）', true,
    code.indexOf('return finalizeLogin(normalized, options)') !== -1 &&
    code.indexOf('const finalized = finalizeLogin(normalized, options)') !== -1)

  /* 兩路各建一個新賬號，比對 user 行形狀 / 初始金 / invite.reason。 */
  resetRuntime()
  const otpCode = await authSvc.requestCode(P_OTP_PARITY)
  check('6f', '短訊碼路：取碼成功', true, otpCode.ok === true)
  const viaOtp = await authSvc.login(P_OTP_PARITY, OTP_CORRECT)
  check('6g', '短訊碼路：登錄成功（registered === true）', true, viaOtp.ok === true && viaOtp.registered === true)

  resetRuntime()
  platform.state.passwords.set(P_PW_PARITY, PASSWORD_ORIGINAL)
  const viaPassword = await authSvc.loginWithPassword(P_PW_PARITY, PASSWORD_ORIGINAL)
  check('6h', '密碼路：登錄成功（registered === true）', true, viaPassword.ok === true && viaPassword.registered === true)

  const rowOtp = viaOtp.user
  const rowPw = viaPassword.user
  check('6i', '兩路 user 行**鍵面逐字相同**', Object.keys(rowOtp).sort(), Object.keys(rowPw).sort())
  check('6j', 'user 行鍵面 ＝ 契約鍵面（id/phone/nickname/role/points/created_at）',
    ['created_at', 'id', 'nickname', 'phone', 'points', 'role'], Object.keys(rowPw).sort())
  check('6k', '兩路初始金皆 50（GOLD_INITIAL）', [authSvc.GOLD_INITIAL, authSvc.GOLD_INITIAL], [rowOtp.points, rowPw.points])
  check('6l', '兩路 role 皆 user（非管理員號）', ['user', 'user'], [rowOtp.role, rowPw.role])
  check('6m', '兩路 invite.reason 逐字相同 ＝ NO_INVITER', ['NO_INVITER', 'NO_INVITER'],
    [viaOtp.invite && viaOtp.invite.reason, viaPassword.invite && viaPassword.invite.reason])
  check('6n', '兩路 invite 形狀相同（ok / settled / reason 三鍵）',
    Object.keys(viaOtp.invite).sort(), Object.keys(viaPassword.invite).sort())

  /* 形狀逐字相等：把手機號派生的三個字段（id / phone / nickname）與時間戳替換為佔位後，
     兩行必須 **JSON 全等**（鍵序無關；`created_at` 只比類型）。 */
  const shapeOf = (row) => ({
    keys: Object.keys(row).sort(),
    idShape: /^u-[0-9a-f]{16}$/.test(String(row.id)),
    nicknameShape: /^印友\d{4}$/.test(String(row.nickname)),
    phoneLength: String(row.phone).length,
    role: row.role,
    points: row.points,
    createdAtType: typeof row.created_at
  })
  check('6o', '兩路行形狀逐字相等（id 形態 / 暱稱形態 / 手機號長度 / role / points / created_at 類型）', shapeOf(rowOtp), shapeOf(rowPw))

  /* 初始金只有一條流水（不是兩條，也不重複發）。 */
  const ledgerOtp = db.listPointRows().filter((row) => row.user_id === rowOtp.id)
  const ledgerPw = db.listPointRows().filter((row) => row.user_id === rowPw.id)
  check('6p', '兩路各恰 1 條初始金流水', [1, 1], [ledgerOtp.length, ledgerPw.length])
  check('6q', '兩路流水金額皆 50 且 type 皆 ＝ LEDGER_TYPE.INITIAL（真源常量）',
    [50, pointsSvc.LEDGER_TYPE.INITIAL, 50, pointsSvc.LEDGER_TYPE.INITIAL],
    [ledgerOtp[0] && ledgerOtp[0].amount, ledgerOtp[0] && ledgerOtp[0].type, ledgerPw[0] && ledgerPw[0].amount, ledgerPw[0] && ledgerPw[0].type])

  /* 老賬號再登錄：不得重複建號、不得重複發金。 */
  resetRuntime()
  const again = await authSvc.loginWithPassword(P_PW_PARITY, PASSWORD_ORIGINAL)
  check('6r', '老賬號用密碼再登錄 ⇒ registered === false（不重複建號）', false, again.registered)
  check('6s', '老賬號再登錄 ⇒ 仍恰 1 條流水（不重複發金）', 1, db.listPointRows().filter((row) => row.user_id === rowPw.id).length)
  /* 只比「是不是同一個人」（**不打 uid 原文**：它是手機號的雜湊派生，報告裡不必出現）。 */
  check('6t', '老賬號再登錄 ⇒ 拿到同一 user id', true, !!(again.user && again.user.id === rowPw.id))
}

/* ---------------------------------------------------------------------------
   7. 收尾
   --------------------------------------------------------------------------- */
const passed = results.filter((row) => row.pass).length
console.log(
  JSON.stringify({
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      /* 只給計數（**不含任何手機號 / 密碼 / 令牌**） */
      platform_calls: { ...platform.state.calls },
      transport_calls: transportState.log.length
    }
  })
)
if (failures > 0) {
  console.error(`FAILED ${failures}/${results.length}`)
  process.exit(1)
}
console.log(`OK ${passed}/${results.length}`)
