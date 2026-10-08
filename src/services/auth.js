/**
 * 玺爱 · 登录服务（手机号 + 验证码）
 *
 * 演示（固定）验证码的**唯一取值真源** = 部署云函数 `xiai-user-token` 的环境变量
 * `XIAI_USER_SMS_CODE`（W-43 已接受风险：固定值，暂缓）。客户端按「同型做法」
 * （jiazu 登录页：点「获取验证码」后把服务端演示码 `dev_code` 直接写进验证码栏）
 * 在点击「獲取驗證碼」后**自动填入**该演示码。
 * 零后端（dev / 離線形態）：登录只在本机 localStorage 内完成，不发起任何外部请求。
 */

import { listUserRows, saveUserRows } from '../data/db.js'
import { setUser, restoreSession } from '../data/session.js'
import { ADMIN_PHONE, ADMIN_NICKNAME } from '../data/seed.js'
/* **身份标识（uid）单点**：`u-` ＋ sha256(手机号) 前 16 位（不可反推手机号 ⇒ 可公开）。
   与云函数 `xiai-user-token` / `xiai-admin-token` 的 `uidOf` **同一算法 ⇒ 同值**。 */
import { uidOf } from '../data/uid.js'
import { grantInitialGold, settleInviteReward } from './points.js'
/* **写面 Phase A（用户写面）**：登录改为「**先服务端验证并拿到用户令牌，再写 session**」——
   云端形态下身份判据在服务端（`xiai-user-token` 的 `action:'issue'`），本地只落 `userId` 镜像。
   dev / 离线形态（无云写入面）仍走改前的本地形态，并明确标注为非正式路径。 */
import { ensureUserLoginToken } from './userToken.js'
/* **平台原生身份（手機號 ＋ 密碼）**：复用**仓内既有的 SDK 装载缝** —— `data/cloudbaseFn.js::cloudBaseApp()`
   （它与读面共用 `cloudbaseSdk.js::loadCloudBaseSdk()`、同一份构建期配置、同一条匿名登录，
   `persistence:'local'` 的 auth 实例也由该缝建立）⇒ **不新开初始化路径、不新增第二套 SDK 装配**。 */
import { cloudBaseApp } from '../data/cloudbaseFn.js'

/* **演示碼常量**：值 = 部署雲函數 `xiai-user-token` 環境變量 `XIAI_USER_SMS_CODE` 的**現值**
   （唯一真源見檔案頭；本處只是它的**鏡像**）。
   ⚠️ **它實際上是公開的** ✗ —— 隨前端包（`dist/assets/*.js`）一併下發，任何訪客都讀得到 ⇒
   它**不是**機密，也不得當機密用：把它公開發布，效果 ＝ **任何人可登錄任意手機號（含管理員手機號）**。
   值指紋（sha256 前 12 位；僅用於與環境變量核對「是否漂移」，不可逆）＝ '4ef5c38bac71'。
   改環境變量後**必須同步改此處**，否則登錄會被服務端以 `FORBIDDEN`（手機號或驗證碼不正確）拒絕。 */
export const DEMO_SMS_CODE = '729341'
/** 兼容既有引用點（本地碼門沿用舊名）。 */
export const DEV_SMS_CODE = DEMO_SMS_CODE
export const GOLD_INITIAL = 50

export function isPhoneLike(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || '').trim())
}

/**
 * 演示态取码：不发送任何真实短信，把共用演示码交给调用方（登录页据此**自动填入**验证码栏）。
 * @returns {{ok:boolean, message:string, code?:string}} `code` 仅在取码成功时出现
 */
export function requestCode(phone) {
  if (!isPhoneLike(phone)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  return { ok: true, message: loginCodeHint(), code: DEMO_SMS_CODE }
}

/**
 * 验证码提示（**形态如实，不得静默 / 不得假称**）：演示環境下验证码为**共用演示码**，且
 * 点「獲取驗證碼」后**自動填入**驗證碼欄（同 jiazu 登录页做法）⇒ 提示如实说明这一步。
 * **明文**：本函数**不**回传、**不**内嵌验证码取值（值只经 `DEMO_SMS_CODE` / `requestCode().code` 出去）。
 * @returns {string} 上屏提示（繁體）
 */
export function loginCodeHint() {
  return '當前爲演示環境：點「獲取驗證碼」即自動填入演示碼。'
}
/**
 * 登录（＝註冊成功路径的**唯一入口**：老账号登录 / 新账号建号 + 初始赠送）。
 *
 * **邀请结算钩（v1.21 新增｜§5.1 ⑦）**：触发时点**恰为「被邀请人註冊成功」** ——
 * 即本函数**新建账号**那一次；调用方可经 `options.inviterId` 提供邀请人用户 id
 * （邀请入口 / 邀请码的形态属 §11 W-23 待裁 ⇒ 本单**只接结算钩、不新增任何邀请入口形态**）。
 * 老账号登录**不触发**结算（不以「邀请人登录」等其它条件触发）。
 *
 * @param {string} phone 手机号
 * @param {string} code 验证码（**云端形态下由服务端判**；dev / 離線形態仍走本機演示碼門）
 * @param {{inviterId?:string}} [options]
 * @returns {Promise<{ok:boolean, user?:object, message?:string, invite?:object, reason?:string}>}
 *
 * **写面 Phase A（2026-09-30）**：本入口由**同步**改为 **`async`**，判定顺序改为：
 *   ① **服务端验证登录（云端形态下的唯一身份判据）**：`ensureUserLoginToken(phone, code)`
 *      ⇒ 云函数 `xiai-user-token` 的 `action:'issue'`（手机号形态 → 验证码 → 签发短 TTL 用户令牌）；
 *      不过门 ⇒ **原样透传结构化拒绝（恰 3 键）＋ 零半成品**（**不建本地账号行、不写 session、不发初始金**）；
 *   ② **dev / 离线形态**（无云写入面）：沿用改前的本地验证码门，**明确标注为非正式路径**；
 *   ③ 过门后才落本地：账号行 / 初始金 / session（**本地库是镜像面**：身份真源在服务端）。
 */
export async function login(phone, code, options = {}) {
  const normalized = String(phone || '').trim()
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  /* ① 服务端验证登录（**云端形态下这是唯一身份判据**；dev / 離線形態返回放行标记 ＋ `mode`）。 */
  const verified = await ensureUserLoginToken(normalized, code)
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, message: verified.message }
  }
  /* ② dev / 離線形態：沿用改前的本地验证码门（**不得**当作正式登录路径）。 */
  if (verified.mode === 'local-dev' && String(code || '').trim() !== DEV_SMS_CODE) {
    return { ok: false, message: '驗證碼不正確' }
  }

  const users = listUserRows()
  let user = users.find((u) => u.phone === normalized)
  let registered = false
  if (!user) {
    /* 管理员手机号（数据层唯一真源 ADMIN_PHONE）建号即为 admin；其余一律普通用户。
       正常路径下数据层引导已按同一常量建好管理员账号，此处仅作兜底。 */
    const isAdminPhone = normalized === ADMIN_PHONE
    user = {
      id: uidOf(normalized),
      phone: normalized,
      nickname: isAdminPhone ? ADMIN_NICKNAME : `印友${normalized.slice(-4)}`,
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
 * **手機號 ＋ 密碼登入（平台原生身份；與演示碼登入**並存**）**
 * ----------------------------------------------------------------------------
 * 形态：用户名 = 用户填的 **11 位手機號**（過渡賬號由人類在控制台手動建立，密碼由人類設定）
 * ⇒ 調平台原生 `auth.signInWithPassword({ username, password })`。
 *
 * **SDK 實例與持久化沿用既有裝載縫**：`cloudBaseApp()` 回的是**读面/写面同一個** app 實例
 * （`persistence:'local'`），本函數只在其上取 auth ⇒ 不新開 `init` 路徑。
 *
 * ⚠️ **該版 SDK 的 auth 方法不拋異常、統一返回 `{data, error}`** ⇒ 判成敗**必須檢查 `error`**
 * （用 try/catch 判成功會得到假綠：`persistence:'local'` 裡殘留的**匿名會話**會被當成登入成功）。
 * 故：`error` 為真 ⇒ 失敗；`error` 為假**且**取到 uid ⇒ 才報成功。
 *
 * 本函數**只做到「能登入 ＋ 能取到平台會話 uid」**：不寫本機 session、不建業務行、不發金
 * （那是演示碼那條路的職責；寫面另開單）。
 *
 * @param {string} phone 手機號（＝用戶名）
 * @param {string} password 密碼
 * @returns {Promise<{ok:boolean, uid?:string, message:string, code?:string}>}
 *          失敗一律回**可見**的繁體 `message`（沿用登入頁既有口型）；
 *          **不新增 reason 字面值**（`code` 只是平台原樣讀數，供排障，非判據）。
 */
export async function loginWithPassword(phone, password) {
  const normalized = String(phone || '').trim()
  const secret = String(password || '')
  if (!isPhoneLike(normalized)) {
    return { ok: false, message: '請輸入 11 位手機號' }
  }
  if (secret === '') {
    return { ok: false, message: '請輸入密碼' }
  }
  const app = await cloudBaseApp()
  if (!app || typeof app.auth !== 'function') {
    return { ok: false, message: '雲端登入暫不可用（未配置資料源），請改用演示碼登入。' }
  }
  const auth = app.auth({ persistence: 'local' })
  if (!auth || typeof auth.signInWithPassword !== 'function') {
    return { ok: false, message: '雲端登入暫不可用（SDK 不支援密碼登入）。' }
  }
  let reply = null
  try {
    reply = await auth.signInWithPassword({ username: normalized, password: secret })
  } catch (error) {
    /* 契約上不該走到這裡（該版 SDK 不拋）——留作最後一道結構化失敗，不讓異常外逸。 */
    return { ok: false, message: '網絡異常，登入失敗，請稍後再試。', code: String((error && error.code) || '') }
  }
  const error = reply && reply.error
  if (error) {
    return { ok: false, ...passwordLoginFailure(error) }
  }
  const uid = String(
    (reply && reply.data && reply.data.user && reply.data.user.uid) ||
      (auth.currentUser && auth.currentUser.uid) ||
      ''
  ).trim()
  if (!uid) {
    return { ok: false, message: '登入未取得平台會話，請稍後再試。' }
  }
  return { ok: true, uid, message: '' }
}

/** 平台登入失敗 ⇒ 可見繁體文案（**不新增工程 reason 字面值**；`code` 只作原樣讀數）。 */
function passwordLoginFailure(error) {
  const code = String((error && (error.code || error.error_code)) || '').trim()
  if (code === 'invalid_username_or_password') {
    return { message: '手機號或密碼不正確', code }
  }
  return { message: '登入失敗，請稍後再試。', code }
}

export function logout() {
  setUser(null)
  return { ok: true }
}

export function bootstrapSession() {
  return restoreSession((id) => listUserRows().find((u) => u.id === id) || null)
}

export function findUserById(id) {
  return listUserRows().find((u) => u.id === id) || null
}
