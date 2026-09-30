/**
 * 玺爱 · **云函数调用缝**（写面 Phase 1 新增｜唯一一处知道「怎么调云函数」的地方）
 * ----------------------------------------------------------------------------
 * 为什么单独一个文件：`data/cloudbase.js` 只管**读面**（分页拉全量）；写面需要的是
 * **`app.callFunction`**。两者共用同一套「SDK 从哪来」的装载缝（`cloudbaseSdk.js`）与同一份
 * 构建期配置（`cloudbase.js` 的 `cloudBaseConfig()` / `cloudBaseConfigured()`），
 * 但**不互相改对方的文件**（本文件是纯新增，读面一行未动）。
 *
 * 与读面**逐条对齐**的口径：
 *   ① **envId 不在代码里写死**（读面 §「envId 不在代码里写死」同族纪律）——只从构建期变量取；
 *   ② **未配置 ⇒ 结构化拒绝**（`STORAGE_UNAVAILABLE`），**不**回落成「假装成功」；
 *   ③ **网络失败 / 超时 / SDK 不可用 ⋯ 一律不得伪装成 `FORBIDDEN`**（R-WF2）——
 *      「未知」与「越权」是两回事 ⇒ 本文件的全部传输层失败**只用** `STORAGE_UNAVAILABLE`
 *      （工程既有冻结字面值，语义 ＝ 权威存储 / 内部不可用；**本单不新增任何 reason**）；
 *   ④ **不抛未捕获异常**（§3.12.10(e)⑥ 同族）：一切失败都是结构化拒绝；
 *   ⑤ **本文件不打印 / 不缓存任何密钥**；函数返回值原样透传，本文件不改写服务端判定。
 *
 * 注入缝（沿用 `cloudbaseSdk.js::setCloudBaseSdkProvider` 的同族做法）：
 * `setCloudFunctionTransport(fn)` ⇒ 离线自检 / 宿主注入用；传非函数 ⇒ 清除注入。
 */

import { loadCloudBaseSdk } from './cloudbaseSdk.js'
import { cloudBaseConfig, cloudBaseConfigured, ensureAnonymousLogin, CLOUD_HYDRATE_TIMEOUT_MS } from './cloudbase.js'

/** 单次云函数调用的总预算（毫秒）。读面的总预算是 `CLOUD_HYDRATE_TIMEOUT_MS`（20 s）——
 *  写面是**单次往返**，用同一量级的下界，避免「写操作卡住不返回」。 */
export const CLOUD_FUNCTION_TIMEOUT_MS = 15000

/** 传输层失败的**唯一** reason（工程既有冻结字面值；**不是** `FORBIDDEN`）。 */
export const CLOUD_FUNCTION_UNAVAILABLE = 'STORAGE_UNAVAILABLE'

/** 传输层失败文案（繁體、如实、不泄漏内部标识）。 */
const TRANSPORT_MESSAGES = Object.freeze({
  NOT_CONFIGURED: '未配置雲端寫入面（VITE_XIAI_DATA_SOURCE / VITE_XIAI_CB_ENV_ID 缺位）；本次零寫入。',
  SDK_UNAVAILABLE: '雲端 SDK 不可用，無法校驗寫入令牌；本次零寫入。',
  INIT_FAILED: '雲端初始化失敗，無法校驗寫入令牌；本次零寫入。',
  LOGIN_FAILED: '雲端登錄態不可用，無法校驗寫入令牌；本次零寫入。',
  TIMEOUT: `雲端校驗逾時（超過 ${CLOUD_FUNCTION_TIMEOUT_MS} ms），本次未寫入。`,
  CALL_FAILED: '雲端校驗請求失敗（網路異常），本次未寫入。',
  BAD_REPLY: '雲端校驗回傳形狀不可辨識，本次未寫入。'
})

function transportDenial(kind) {
  return { ok: false, reason: CLOUD_FUNCTION_UNAVAILABLE, message: TRANSPORT_MESSAGES[kind] || TRANSPORT_MESSAGES.CALL_FAILED }
}

/* ---------------------------------------------------------------------------
   1. 注入缝（离线自检 / 宿主显式注入）
   --------------------------------------------------------------------------- */

let transportOverride = null

/**
 * 注入传输实现（**仅供离线自检 / 宿主**）。
 * @param {null|function(string, object, object): Promise<{ok:boolean, result?:any, reason?:string, message?:string}>} fn
 */
export function setCloudFunctionTransport(fn) {
  transportOverride = typeof fn === 'function' ? fn : null
}

export function cloudFunctionInjected() {
  return transportOverride !== null
}

/** 是否已配置云端写面（与读面同一判据：开关打开 **且** envId 非空）。 */
export function cloudFunctionConfigured() {
  return cloudBaseConfigured()
}

/* ---------------------------------------------------------------------------
   2. app 实例（惰性、并发去重；失败即作废，下次可重试）
   --------------------------------------------------------------------------- */

let appPromise = null

async function resolveApp() {
  const config = cloudBaseConfig()
  if (!cloudBaseConfigured()) return { ok: false, kind: 'NOT_CONFIGURED' }
  let sdk = null
  try {
    sdk = await loadCloudBaseSdk()
  } catch {
    sdk = null
  }
  if (!sdk || typeof sdk.init !== 'function') return { ok: false, kind: 'SDK_UNAVAILABLE' }
  let app = null
  try {
    app = sdk.init({ env: config.envId, ...(config.region ? { region: config.region } : {}) })
  } catch {
    return { ok: false, kind: 'INIT_FAILED' }
  }
  const auth = app && typeof app.auth === 'function' ? app.auth({ persistence: 'local' }) : null
  if (auth) {
    try {
      const user = await ensureAnonymousLogin(auth)
      if (!user) return { ok: false, kind: 'LOGIN_FAILED' }
    } catch {
      return { ok: false, kind: 'LOGIN_FAILED' }
    }
  }
  if (typeof app.callFunction !== 'function') return { ok: false, kind: 'SDK_UNAVAILABLE' }
  return { ok: true, app }
}

function appOrNull() {
  if (!appPromise) {
    appPromise = resolveApp().catch(() => ({ ok: false, kind: 'SDK_UNAVAILABLE' }))
  }
  return appPromise
}

/** 作废 app 缓存（自检 / 排障用；不影响读面状态机）。 */
export function resetCloudFunctionApp() {
  appPromise = null
}

/* ---------------------------------------------------------------------------
   3. 调用
   --------------------------------------------------------------------------- */

function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ __timeout: true })
    }, ms)
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(settle, (error) => settle({ __error: error }))
  })
}

/**
 * 拆函数回传（js-sdk 的 `callFunction` 回传形态在不同版本下可能是 `{result}` 或裸结果）。
 * @returns {{ok:true, result:any}|{ok:false}}
 */
export function unpackFunctionReply(reply) {
  if (reply === undefined || reply === null) return { ok: false }
  if (typeof reply === 'object' && Object.prototype.hasOwnProperty.call(reply, 'result')) {
    const inner = reply.result
    if (inner === undefined || inner === null) return { ok: false }
    /* 函数体可能返回 JSON 字符串（视平台设置）⇒ 是可解析的 JSON 就解析。 */
    if (typeof inner === 'string') {
      try {
        const parsed = JSON.parse(inner)
        return parsed && typeof parsed === 'object' ? { ok: true, result: parsed } : { ok: false }
      } catch {
        return { ok: false }
      }
    }
    return typeof inner === 'object' ? { ok: true, result: inner } : { ok: false }
  }
  return typeof reply === 'object' ? { ok: true, result: reply } : { ok: false }
}

/**
 * 调云函数。
 * @param {string} name 函数名
 * @param {object} data 载荷（事件对象）
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:true, result:object}|{ok:false, reason:string, message:string}>}
 *          传输层失败 ⇒ `STORAGE_UNAVAILABLE`（**绝不 `FORBIDDEN`**）；
 *          业务层拒绝 ⇒ **原样透传**服务端的 `{ok:false, reason, message}`（本文件不改写判定）。
 */
export async function callCloudFunction(name, data, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.round(options.timeoutMs) : CLOUD_FUNCTION_TIMEOUT_MS
  if (transportOverride) {
    try {
      const reply = await transportOverride(name, data, { timeoutMs })
      if (!reply || typeof reply !== 'object') return transportDenial('BAD_REPLY')
      if (reply.ok === false && typeof reply.reason === 'string') return reply
      const unpacked = unpackFunctionReply(reply)
      if (!unpacked.ok) return transportDenial('BAD_REPLY')
      return unpacked
    } catch {
      return transportDenial('CALL_FAILED')
    }
  }
  const resolved = await withTimeout(appOrNull(), timeoutMs)
  if (resolved && resolved.__timeout) return transportDenial('TIMEOUT')
  if (!resolved || resolved.ok !== true) return transportDenial((resolved && resolved.kind) || 'SDK_UNAVAILABLE')
  let raw = null
  try {
    raw = await withTimeout(Promise.resolve(resolved.app.callFunction({ name, data })), timeoutMs)
  } catch {
    raw = { __error: true }
  }
  if (raw && raw.__timeout) return transportDenial('TIMEOUT')
  if (raw && raw.__error) return transportDenial('CALL_FAILED')
  const unpacked = unpackFunctionReply(raw)
  if (!unpacked.ok) return transportDenial('BAD_REPLY')
  return unpacked
}

/** 诊断读数（**不含任何密钥 / 令牌**）。 */
export function cloudFunctionStatus() {
  const config = cloudBaseConfig()
  return {
    configured: cloudBaseConfigured(),
    injected: transportOverride !== null,
    envIdPresent: config.envId !== '',
    timeoutMs: CLOUD_FUNCTION_TIMEOUT_MS
  }
}
