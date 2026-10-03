'use strict'
/**
 * 玺爱 · 管理员令牌云函数 · **配置面（环境变量唯一真源）**
 * ----------------------------------------------------------------------------
 * 口径（逐条）：
 *   ① **本文件不写任何密钥 / 手机号 / 验证码字面值** ✗ —— 一律从环境变量读；
 *      `ADMIN_PHONE` 的**工程真源**仍是 `src/data/seed.js:39`，本处是**同一真源的注入点**（非第二处定义点）。
 *   ② **配置缺失 ⇒ 拒绝、不静默降级**：缺 `XIAI_ADMIN_PHONE` / `XIAI_ADMIN_SMS_CODE` / `XIAI_ADMIN_TOKEN_SECRET`
 *      一律返回结构化拒绝，`reason` 取**既有冻结字面值** `STORAGE_UNAVAILABLE`
 *      （语义 ＝ 权威存储 / 内部不可用；**属「内部不可用」，不是「越权」⇒ 不得用 `FORBIDDEN` 冒充**）。
 *   ③ **本文件不打印任何密钥 / 令牌**；`fingerprint()` 只给不可逆摘要前 12 位（诊断用）。
 */

const crypto = require('crypto')

/** 对外的 reason 取值面 ＝ **既有冻结表的子集**（本单**不新增**任何 reason 字面值）。 */
const REASONS = Object.freeze({
  FORBIDDEN: 'FORBIDDEN',
  INVALID_VALUE: 'INVALID_VALUE',
  INVALID_FIELD: 'INVALID_FIELD',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE'
})

/** 环境变量名（唯一一处定义点）。 */
const ENV_NAMES = Object.freeze({
  PHONE: 'XIAI_ADMIN_PHONE',
  SMS_CODE: 'XIAI_ADMIN_SMS_CODE',
  SECRET: 'XIAI_ADMIN_TOKEN_SECRET',
  VERSION: 'XIAI_ADMIN_TOKEN_VERSION',
  TTL_SECONDS: 'XIAI_ADMIN_TOKEN_TTL_SECONDS',
  LEEWAY_SECONDS: 'XIAI_ADMIN_TOKEN_LEEWAY_SECONDS'
})

/** TTL 默认 15 分钟（Kevin 已定）；可用环境变量覆盖（**覆盖只改 TTL，不改判定顺序**）。 */
const DEFAULT_TTL_SECONDS = 900

/** 跨实例时钟余量默认 60 秒（只作容差，**不作放宽**）。 */
const DEFAULT_LEEWAY_SECONDS = 60

/** 生产**默认卡死**的兜底版本号（撤销面：改环境变量即全体旧令牌失效）。 */
const DEFAULT_VERSION = '1'

/** 手机号形态（与 `src/services/auth.js::isPhoneLike` / 用户函数 `lib/config.js` **逐字同正则**）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/** uid 前缀（与前端 `auth.js` 的 `u-${phone}` / 用户函数 `uidOf` **同一约定**）。 */
const UID_PREFIX = 'u-'

/**
 * 环境 Id 的三个候选环境变量（**运行期注入**；与用户函数 `lib/config.js` / liwu 既有函数同一读法；
 * 工程纪律「envId 不在代码里写死」照旧成立）。
 */
const ENV_ID_NAMES = Object.freeze(['TCB_ENV', 'SCF_NAMESPACE', 'CLOUDBASE_ENV_ID'])

/**
 * 结构化拒绝（**恰 3 键**：`{ok:false, reason, message}` —— 与工程既有拒绝形态同形，不加旁路字段）。
 * @param {string} reason 冻结字面值（取值面见 `REASONS`）
 * @param {string} message 繁體、如实、不泄漏内部标识
 */
function deny(reason, message) {
  return { ok: false, reason, message }
}

function readString(env, name) {
  const raw = env ? env[name] : undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

function readInteger(env, name, fallback) {
  const raw = readString(env, name)
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/** 手机号归一（只留数字）：比对前先归一，**不猜格式、不做模糊匹配**。 */
function normalizePhone(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
}

/** 不可逆诊断指纹（sha256 前 12 位十六进制）；**绝不用于任何判定**。 */
function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
}

/** 手机号展示形态（`166****1656`）；**只用于上屏 / 日志**，不参与判定。 */
function maskedPhone(value) {
  const digits = normalizePhone(value)
  if (digits.length < 7) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 手机号形态判定（归一后逐个匹配；**不猜格式**）。 */
function isPhoneLike(value) {
  return PHONE_PATTERN.test(normalizePhone(value))
}

/**
 * **服务端唯一的 reviewer_id 派生**：`u-<11 位手机号>`。
 * 明文：审核人身份**不以客户端自称为准**，一律由已验签令牌声明里的手机号派生
 * （与用户写面 `uid = u-<手机号>` **同一约定**）⇒ 前端无法自称审核人。
 */
function uidOf(value) {
  const digits = normalizePhone(value)
  return isPhoneLike(digits) ? `${UID_PREFIX}${digits}` : ''
}

/** 运行期环境 Id（缺位 ⇒ 空串 ⇒ 由 SDK 走「当前环境」语义；**不写死**）。 */
function readEnvId(env) {
  const source = env || process.env
  for (const name of ENV_ID_NAMES) {
    const value = readString(source, name)
    if (value) return value
  }
  return ''
}

/**
 * 读配置。
 * @param {object} [env] 环境（缺省 `process.env`；测试可注入）
 * @returns {{ready:true, phone:string, smsCode:string, secret:string, version:string,
 *            ttlSeconds:number, leewaySeconds:number}
 *          |{ready:false, reason:string, message:string}}
 */
function readConfig(env) {
  const source = env || process.env
  const phone = normalizePhone(readString(source, ENV_NAMES.PHONE))
  const smsCode = readString(source, ENV_NAMES.SMS_CODE)
  const secret = readString(source, ENV_NAMES.SECRET)
  const missing = []
  if (!phone) missing.push(ENV_NAMES.PHONE)
  if (!smsCode) missing.push(ENV_NAMES.SMS_CODE)
  if (!secret) missing.push(ENV_NAMES.SECRET)
  if (missing.length > 0) {
    return {
      ready: false,
      reason: REASONS.STORAGE_UNAVAILABLE,
      /* 只报**缺失项的环境变量名**（不是密钥值）⇒ 可排障、不泄密。 */
      message: `管理員令牌服務未配置（缺環境變量：${missing.join('、')}）⇒ 拒絕所有令牌操作；本次零寫入。`
    }
  }
  return {
    ready: true,
    phone,
    smsCode,
    secret,
    version: readString(source, ENV_NAMES.VERSION) || DEFAULT_VERSION,
    ttlSeconds: readInteger(source, ENV_NAMES.TTL_SECONDS, DEFAULT_TTL_SECONDS),
    leewaySeconds: readInteger(source, ENV_NAMES.LEEWAY_SECONDS, DEFAULT_LEEWAY_SECONDS),
    envId: readEnvId(source)
  }
}

module.exports = {
  REASONS,
  ENV_NAMES,
  ENV_ID_NAMES,
  DEFAULT_TTL_SECONDS,
  DEFAULT_LEEWAY_SECONDS,
  DEFAULT_VERSION,
  PHONE_PATTERN,
  UID_PREFIX,
  deny,
  normalizePhone,
  isPhoneLike,
  uidOf,
  readEnvId,
  fingerprint,
  maskedPhone,
  readConfig
}
