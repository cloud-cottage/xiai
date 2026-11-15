/**
 * 玺爱 · **平台原生短訊驗證碼（OTP）登入的 SDK 裝配單點**
 * ============================================================================
 * 為什麼要**單獨一個 app 實例**（而不是復用 `cloudbaseFn.js` / `cloudbase.js` 那兩個）：
 *
 *   · 讀面（`cloudbase.js`）與寫面（`cloudbaseFn.js`）各有一個 app 實例，兩者的
 *     auth 實例都是 `persistence: 'local'` ⇒ **會話落在 `window.localStorage`**（SDK 的
 *     `credentials_<clientId>` 一類鍵，同 env 同鍵）。
 *   · 若在**同一個** auth 實例上做短訊登入，`signIn` 會把「**匿名會話**」原地覆蓋成
 *     「正式用戶會話」⇒ **讀面的身份被連帶換掉**（讀面是匿名可讀的形態），且兩個 app
 *     實例共用同一份持久化鍵時會互相踩（誰最後寫誰生效）。
 *   · ⇒ 本文件另起**第三個 app 實例**，並且只給它 `persistence: 'none'`：
 *     SDK 的 `persistenceTag` 在 Web 適配器下就等於傳入值（Web 適配器沒有
 *     `primaryStorage` 覆寫），`'none'` 走的是**內存存儲**（`root.tcbCacheObject`），
 *     **不寫 localStorage** ⇒ OTP 會話與匿名會話**物理上不共鍵**。
 *
 * 由此得到的行為（逐條可核）：
 *   ① 讀面 / 寫面那兩個 app 實例的匿名會話**一字不動**（本文件不讀不寫它們的鍵）；
 *   ② 短訊登入後的平台會話**只活在本次頁面會話的內存裡** ⇒ 刷新即失效
 *      （令牌持久化 30 天屬 P3，另行處理；本輪**刻意**不落盤）；
 *   ③ 本文件**只**負責「拿到平台會話憑證（`access_token`）」，不做任何業務寫入、
 *      不建本地賬號行、不發金 —— 那些仍由 `services/auth.js` 在全部步驟成功後才做。
 *
 * 殘留（**如實登記**）：SDK 另有一個 **按 env 命名**的用戶資料緩存鍵
 * `user_info_<envId>`（`at()` 內建、強制 `persistence:'local'`，本 SDK 不對外開放關閉或改名）。
 * 它只存「用戶資料快照」，**不存 access token**，且讀面的權限判據看的是會話憑證與集合安全規則
 * ⇒ 不影響讀面可讀性；本文件不主動讀它。真要徹底消除，得等 P3 換持久化方案時一併收口。
 *
 * 失敗一律**結構化**：取不到 SDK / 未配置 / init 拋錯 ⇒ `null`（**不拋錯**），
 * 由調用方（`services/auth.js`）給可讀的繁體拒絕文案。
 */

import { loadCloudBaseSdk } from './cloudbaseSdk.js'
import { cloudBaseConfig, cloudBaseConfigured } from './cloudbase.js'

/**
 * OTP auth 實例的持久化形態（**封閉單值**）：`'none'` ＝ 內存。
 *
 * **不得改成 `'local'`** —— 那會讓短訊登入覆蓋讀面的匿名會話（見檔案頭）。
 */
export const OTP_AUTH_PERSISTENCE = 'none'

/** 本實例的 SDK app 級超時（與寫面同量級：單次往返，不是長任務）。 */
export const OTP_AUTH_TIMEOUT_MS = 20000

/** SDK app 实例（惰性建立、并发去重；失败即作废，下次可重试）。 */
let appPromise = null

/**
 * **auth 实例注入缝**（离线自检 / 宿主显式提供，同族于 `cloudbaseSdk.js::setCloudBaseSdkProvider`）。
 *
 * 为什么需要它：密码登錄与重置密码的判据全在平台侧（`signInWithPassword` / `verify` /
 * `resetPassword`），自检若不能注入假 auth 就只能「真打平台 + 真发短訊」—— 那是联调，不是自检。
 * 它**只改「auth 实例从哪来」**：注入后本文件的其余口径（`persistence:'none'`、失败回 `null`
 * 不抛错、只负责取凭证不做业务写入）**一字不变**；生产路径不注入 ⇒ 走下面的真实装配。
 * 传非函数 ⇒ 清除注入。
 */
let authProvider = null

export function setOtpAuthProvider(fn) {
  authProvider = typeof fn === 'function' ? fn : null
  authInstance = null
}

/** auth 實例（**同一 app 上只建一次**；`verify` → `signIn` 必須落在同一個實例上）。 */
let authInstance = null

async function resolveApp() {
  if (!cloudBaseConfigured()) return null
  const config = cloudBaseConfig()
  if (!config.envId) return null
  let sdk = null
  try {
    sdk = await loadCloudBaseSdk()
  } catch {
    return null
  }
  if (!sdk || typeof sdk.init !== 'function') return null
  try {
    return sdk.init({
      env: config.envId,
      timeout: OTP_AUTH_TIMEOUT_MS,
      ...(config.region ? { region: config.region } : {})
    })
  } catch {
    return null
  }
}

function appOrNull() {
  if (!appPromise) appPromise = resolveApp().catch(() => null)
  return appPromise
}

/**
 * 取 OTP 用的 auth 實例（**內存持久化**；與讀面 / 寫面的匿名會話互不覆蓋）。
 * @returns {Promise<object|null>} 取不到 ⇒ `null`（**不拋錯**；調用方必須給結構化拒絕）
 */
export async function otpAuth() {
  /* 注入缝优先（自检 / 宿主）；**不缓存注入结果** —— 由注入方自己管生命周期。 */
  if (authProvider) {
    try {
      return await authProvider()
    } catch {
      return null
    }
  }
  if (authInstance) return authInstance
  const app = await appOrNull()
  if (!app || typeof app.auth !== 'function') return null
  let auth = null
  try {
    auth = app.auth({ persistence: OTP_AUTH_PERSISTENCE })
  } catch {
    return null
  }
  if (!auth) return null
  authInstance = auth
  return authInstance
}

/** 作廢緩存（自檢 / 排障 / 登出後重建用；不影響讀面與寫面的 app 實例）。 */
export function resetOtpAuth() {
  authInstance = null
  appPromise = null
}

/** 是否具備短訊驗證的前提（未配置雲端 ⇒ `false`；讀數用，不作判據）。 */
export function otpAuthConfigured() {
  return cloudBaseConfigured()
}

/**
 * 取**當前登入會話**的平台 `access_token`（供管理面換取寫入令牌用）。
 *
 * 為什麼要有這個出口：`xiai-admin-token` 的 `action:'issue'`（P1c 起）與用戶面**同構** ——
 * 只認平台簽發的 `access_token`（服務端拿去驗簽取號），前端**不持有、不生成**任何固定碼。
 * 因此管理通道必須能就地讀出「本人本會話」的憑證；讀不到 ⇒ 回 `''`，由調用方給
 * **結構化拒絕 ＋ 重新登入引導**（**不得**回退任何固定碼 / 常量憑據）。
 *
 * 硬口徑：
 *  · **只走 OTP 實例**（`otpAuth()`；`persistence:'none'`）—— 不讀寫面 / 讀面的匿名會話；
 *  · **憑證不回包給上層以外的任何面**：本函數只 `return` 字串，**不打印、不落盤、不上屏**；
 *  · **絕不自拋**：取不到（未配置 / 未登入 / SDK 異常）⇒ `''`。
 * @returns {Promise<string>} 平台 `access_token`；取不到 ⇒ `''`
 */
export async function otpSessionAccessToken() {
  const auth = await otpAuth()
  if (!auth) return ''
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
    /* 取不到 ⇒ 空串（調用方給結構化拒絕 ＋ 重新登入引導） */
  }
  return ''
}
