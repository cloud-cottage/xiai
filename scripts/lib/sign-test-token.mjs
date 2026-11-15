/**
 * 玺爱 · 自检脚本「**本地现签令牌注入**」单点（Zang 裁定 **R-L3′**）
 * ============================================================================
 * 背景：登录已从「固定演示码」改为**真短讯 OTP** —— 云函数 `action:'issue'` 的入参改为
 * `{ phone, platformAccessToken }`（服务端拿平台 `access_token` 打 `/auth/v1/user/me` 验签取号）。
 * 自检脚本**不得**依赖真短讯，**不得**在生产留固定码后门 ⇒ 统一改为「**本地现签令牌注入**」：
 *   · 令牌签发算法**唯一真源** ＝ `cloudfunctions/xiai-user-token/lib/token.js::issueToken`
 *     （与 `xiai-admin-token/lib/token.js` 逐字节同源；`scripts/verify-userwrite-pa.mjs` 的 D1
 *     断言两副本 sha256 恒等）——**本模块只 `require` 它，绝不复制一份签发实现**（避免两处漂移）；
 *   · **密钥只从当前 shell 环境变量读**（`process.env`）：用户令牌 `XIAI_USER_TOKEN_SECRET`，
 *     管理员令牌 `XIAI_ADMIN_TOKEN_SECRET`（可选 `XIAI_*_TOKEN_VERSION`，缺省 `'1'`）；
 *     本模块**不落盘、不写进脚本、不打印**任何密钥 / 令牌原文（回包只给令牌本体给调用方内存用）；
 *   · **缺密钥 ⇒ 抛可识别的 SKIP 标记**（`TestTokenSkip`），由脚本顶层交给
 *     `handleTestTokenSkip()` ⇒ 打印 `SKIP（缺 <VAR>，本脚本未验证）` 并 **exit 0**
 *     （**不假绿、不报红、不伪造任何断言通过**）。
 *
 * 用法（脚本侧，最小改动）：
 * ```js
 * import { signUserToken, signAdminToken, handleTestTokenSkip, issueReplyOf } from './lib/sign-test-token.mjs'
 * let USER_TOKEN
 * try { USER_TOKEN = signUserToken({ phone: PHONE }) } catch (error) { handleTestTokenSkip(error) }
 * // 需要把令牌交给客户端通道（`src/services/token.js` 的闭包）时：经**传输缝**注入现签回包
 * userTokenSvc.setUserTokenTransport(async (name, data) => {
 *   if (data && data.action === 'issue') return { result: issueReplyOf(USER_TOKEN) }
 *   return { result: await fn.main(data) }
 * })
 * ```
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const USER_FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')
const ADMIN_FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-admin-token')

/* **签发真源**（不复制实现）：用户函数侧的 `lib/token.js`。 */
const tokenLib = require(path.join(USER_FN_DIR, 'lib/token.js'))
/* uid / 手机号掩码的**同源纯函数**（服务端与客户端同一算法；这里只借来生成「签发回包」的读数）。 */
const configLib = require(path.join(USER_FN_DIR, 'lib/config.js'))

/** 用户令牌密钥的环境变量名（**唯一读取点**）。 */
export const USER_SECRET_ENV = 'XIAI_USER_TOKEN_SECRET'
/** 管理员令牌密钥的环境变量名（**唯一读取点**）。 */
export const ADMIN_SECRET_ENV = 'XIAI_ADMIN_TOKEN_SECRET'
/** 令牌默认 TTL（与云函数 `DEFAULT_TTL_SECONDS` 同值 900 s）。 */
export const DEFAULT_TTL_SECONDS = configLib.DEFAULT_TTL_SECONDS

/**
 * **可识别的 SKIP 标记**：缺密钥时由此异常承载「缺哪个变量」。
 * 脚本顶层捕获后打印一行 `SKIP（缺 <VAR>，本脚本未验证）` 并以 **exit 0** 退出。
 */
export class TestTokenSkip extends Error {
  /**
   * @param {string[]} missing 缺失的环境变量名（**只有变量名，绝不含取值**）
   */
  constructor(missing) {
    const names = Array.isArray(missing) ? missing.filter((name) => typeof name === 'string' && name !== '') : []
    super(`TEST_TOKEN_SKIP: ${names.join(',')}`)
    this.name = 'TestTokenSkip'
    this.missing = names
  }
}

/**
 * 读一个密钥环境变量；**缺失 / 空白 ⇒ 抛 SKIP 标记**（绝不回退任何内置 / 合成值）。
 * @param {string} name 环境变量名（如 `XIAI_USER_TOKEN_SECRET`）
 * @returns {string} 已 trim 的密钥（**调用方不得打印 / 落盘**）
 */
export function requireSecretOrSkip(name) {
  const value = String(process.env[name] === undefined || process.env[name] === null ? '' : process.env[name]).trim()
  if (value === '') throw new TestTokenSkip([name])
  return value
}

/** 版本号读法（与云函数 `readConfig()` 同口径：`XIAI_*_TOKEN_VERSION`，缺省 `'1'`）。 */
function versionOf(envName) {
  const raw = String(process.env[envName] === undefined || process.env[envName] === null ? '' : process.env[envName]).trim()
  return raw === '' ? String(configLib.DEFAULT_VERSION) : raw
}

/** TTL 读法（缺省 `DEFAULT_TTL_SECONDS`；显式入参优先）。 */
function ttlOf(explicit, envName) {
  if (Number.isFinite(Number(explicit)) && Number(explicit) > 0) return Math.floor(Number(explicit))
  const raw = Number(process.env[envName])
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return DEFAULT_TTL_SECONDS
}

/**
 * **本地现签一枚用户令牌**（`role:'user'`，`sub` ＝ 测试手机号，TTL 缺省 900 s）。
 *
 * 硬口径：
 *  · 密钥只从 `XIAI_USER_TOKEN_SECRET` 读（缺 ⇒ `TestTokenSkip`）；
 *  · 签发调用**云函数同一份 `issueToken`**（不复制实现、不改判定口径）；
 *  · 返回体含令牌原文 ⇒ **只允许在进程内存里用**（脚本不得打印 / 不得落盘）。
 * @param {{phone:string, ttlSeconds?:number, nowSeconds?:number, version?:string}} input
 * @returns {{ok:true, token:string, claims:object}}
 */
export function signUserToken(input = {}) {
  const secret = requireSecretOrSkip(USER_SECRET_ENV)
  const phone = String(input && input.phone !== undefined && input.phone !== null ? input.phone : '').trim()
  const version = input.version !== undefined && input.version !== null && String(input.version).trim() !== ''
    ? String(input.version).trim()
    : versionOf('XIAI_USER_TOKEN_VERSION')
  const nowSeconds = Number.isFinite(Number(input.nowSeconds)) ? Math.floor(Number(input.nowSeconds)) : Math.floor(Date.now() / 1000)
  const issued = tokenLib.issueToken({
    sub: phone,
    secret,
    nowSeconds,
    ttlSeconds: ttlOf(input.ttlSeconds, 'XIAI_USER_TOKEN_TTL_SECONDS'),
    version,
    role: 'user'
  })
  /* 不发散：签发失败只回内部判别码（不含密钥、不含令牌）。 */
  if (!issued || issued.ok !== true) throw new Error(`signUserToken failed: ${(issued && issued.detail) || 'unknown'}`)
  return { ok: true, token: issued.token, claims: issued.claims }
}

/**
 * **本地现签一枚管理员令牌**（`role:'admin'`；须 `XIAI_ADMIN_TOKEN_SECRET` ＋ 白名单手机号
 * `XIAI_ADMIN_PHONE`，与 `xiai-admin-token` 的 config 同口径）。
 * @param {{phone?:string, ttlSeconds?:number, nowSeconds?:number, version?:string}} [input]
 * @returns {{ok:true, token:string, claims:object}}
 */
export function signAdminToken(input = {}) {
  const secret = requireSecretOrSkip(ADMIN_SECRET_ENV)
  const rawPhone = input && input.phone !== undefined && input.phone !== null && String(input.phone).trim() !== ''
    ? input.phone
    : process.env.XIAI_ADMIN_PHONE
  const phone = String(rawPhone === undefined || rawPhone === null ? '' : rawPhone).trim()
  if (phone === '') throw new TestTokenSkip(['XIAI_ADMIN_PHONE'])
  const version = input.version !== undefined && input.version !== null && String(input.version).trim() !== ''
    ? String(input.version).trim()
    : versionOf('XIAI_ADMIN_TOKEN_VERSION')
  const nowSeconds = Number.isFinite(Number(input.nowSeconds)) ? Math.floor(Number(input.nowSeconds)) : Math.floor(Date.now() / 1000)
  const issued = tokenLib.issueToken({
    sub: phone,
    secret,
    nowSeconds,
    ttlSeconds: ttlOf(input.ttlSeconds, 'XIAI_ADMIN_TOKEN_TTL_SECONDS'),
    version,
    role: 'admin'
  })
  if (!issued || issued.ok !== true) throw new Error(`signAdminToken failed: ${(issued && issued.detail) || 'unknown'}`)
  return { ok: true, token: issued.token, claims: issued.claims }
}

/**
 * 把现签令牌包成**云函数 `action:'issue'` 的成功回包形状**（键面与
 * `xiai-user-token/index.js::handleIssue` / `xiai-admin-token/index.js::handleIssue` 一致）。
 *
 * 用途：脚本把客户端通道（`src/services/token.js` 的闭包状态）当作**传输缝**注入点 ——
 * 通道只认「服务端签发回包」，而不是自己造一个令牌；注入的令牌本体仍由**真源算法**签出。
 * @param {{token:string, claims:object}} signed `signUserToken` / `signAdminToken` 的返回值
 * @returns {{ok:true, token:string, sub:string, uid:string, issuedAt:number, expiresAt:number,
 *            ttlSeconds:number, ver:string, serverNow:number}}
 */
export function issueReplyOf(signed) {
  const claims = (signed && signed.claims) || {}
  let uid = ''
  try {
    uid = configLib.uidOf(String(claims.sub))
  } catch {
    uid = ''
  }
  let sub = ''
  try {
    sub = configLib.maskedPhone(String(claims.sub))
  } catch {
    sub = ''
  }
  return {
    ok: true,
    token: String(signed.token),
    sub,
    uid,
    issuedAt: Number(claims.iat) || 0,
    expiresAt: Number(claims.exp) || 0,
    ttlSeconds: Number(claims.exp) - Number(claims.iat) || 0,
    ver: String(claims.ver === undefined ? '' : claims.ver),
    serverNow: Math.floor(Date.now() / 1000)
  }
}

/**
 * **SKIP 出口**（脚本顶层调）：`TestTokenSkip` ⇒ 打印 `SKIP（缺 <VAR>，本脚本未验证）` 并 exit 0；
 * 其它异常 ⇒ **原样抛**（真缺陷不得被吞成 SKIP）。
 * @param {*} error 捕获到的异常
 * @returns {never} 两条路都不返回（SKIP 走 exit 0，其它走抛出）
 */
export function handleTestTokenSkip(error) {
  if (!(error instanceof TestTokenSkip)) throw error
  const missing = Array.isArray(error.missing) && error.missing.length > 0 ? error.missing.join('、') : '(unknown)'
  console.log(`SKIP（缺 ${missing}，本脚本未验证）`)
  process.exit(0)
}

/**
 * 便捷包装：跑一段「需要令牌」的初始化，缺密钥则 SKIP（其余异常照常抛）。
 * @template T
 * @param {() => T} fn 需要令牌的同步初始化
 * @returns {T}
 */
export function withTestTokenSkip(fn) {
  try {
    return fn()
  } catch (error) {
    handleTestTokenSkip(error)
  }
}
