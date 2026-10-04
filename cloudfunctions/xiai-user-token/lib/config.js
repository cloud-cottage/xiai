'use strict'
/**
 * 玺爱 · 用户令牌云函数 · **配置面（环境变量唯一真源）**（写面 Phase A）
 * ----------------------------------------------------------------------------
 * 口径（逐条，与管理员令牌函数 `xiai-admin-token/lib/config.js` **同形**）：
 *   ① **本文件不写任何密钥 / 手机号 / 验证码字面值** ✗ —— 一律从环境变量读；
 *   ② **配置缺失 ⇒ 拒绝、不静默降级**：缺 `XIAI_USER_SMS_CODE` / `XIAI_USER_TOKEN_SECRET`
 *      一律返回结构化拒绝，`reason` 取**既有冻结字面值** `STORAGE_UNAVAILABLE`
 *      （语义 ＝ 权威存储 / 内部不可用；**属「内部不可用」，不是「越权」⇒ 不得用 `FORBIDDEN` 冒充**）；
 *   ③ **本文件不打印任何密钥 / 令牌**；`fingerprint()` 只给不可逆摘要前 12 位（诊断用）；
 *   ④ **uid 由服务端确定性派生、且不可反推手机号**（`uidOf(phone)` ＝
 *      `u-` ＋ `sha256(手机号).hex` 前 16 位；与前端 `src/data/uid.js::uidOf`
 *      **同一算法 ⇒ 同值**）⇒ **前端无法自称 uid**
 *      （若把 uid 塞进令牌由客户端在签发时自选，等于把身份交回客户端 ⇒ 本单显式不那样做）。
 *      明文：uid **不是密码学保密**（单向、可复算）—— 它的作用只是**不把手机号写进数据行 /
 *      不直接露出**；手机号只活在**服务端环境变量**与**本人本地会话**里。
 */

const crypto = require('crypto')

/**
 * 对外的 reason 取值面。
 *
 * 前 5 个＝**既有冻结表**（Phase A 沿用）。后 2 个＝**本单（採信）新增的待规范单确认字面值**：
 *   · `ALREADY_ENDORSED` —— 幂等：同 `(faceId, field, value, user_id)` 已有采信行 ⇒ 零写入；
 *   · `DUPLICATE_VALUE`  —— 提交侧防重：同 `(faceId, field, value)` 已有提交行 ⇒ 零写入
 *     （同一段文字只允许一人提交，第二人应改用【採信】）。
 * 二者**逐字登记在此**，便于规范侧确认后改名（改名只需改这两处 ＋ `ops.js` 的引用常量）。
 */
const REASONS = Object.freeze({
  FORBIDDEN: 'FORBIDDEN',
  INVALID_VALUE: 'INVALID_VALUE',
  INVALID_FIELD: 'INVALID_FIELD',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  ALREADY_ENDORSED: 'ALREADY_ENDORSED',
  DUPLICATE_VALUE: 'DUPLICATE_VALUE'
})

/** 环境变量名（唯一一处定义点；**与管理员函数的环境变量名不重名** ⇒ 令牌不跨函数通用）。
 *  **V3 追加**：`ADMIN_PHONE` ＝ 管理员白名单真源（挂在**本函数**上）；缺 / 空 ⇒
 *  所有管理员类 op 一律结构化拒绝 ＋ 零写入（**不因未配置而放行**）。 */
const ENV_NAMES = Object.freeze({
  SMS_CODE: 'XIAI_USER_SMS_CODE',
  SECRET: 'XIAI_USER_TOKEN_SECRET',
  VERSION: 'XIAI_USER_TOKEN_VERSION',
  TTL_SECONDS: 'XIAI_USER_TOKEN_TTL_SECONDS',
  LEEWAY_SECONDS: 'XIAI_USER_TOKEN_LEEWAY_SECONDS',
  ADMIN_PHONE: 'XIAI_ADMIN_PHONE'
})

/** 环境 Id 的三个候选环境变量（**运行期注入**，与 liwu 既有函数 `fortuneDailySettlement` 同一读法；
 *  工程纪律「envId 不在代码里写死」照旧成立）。 */
const ENV_ID_NAMES = Object.freeze(['TCB_ENV', 'SCF_NAMESPACE', 'CLOUDBASE_ENV_ID'])

/** TTL 默认 15 分钟（**与管理员令牌同值**）；可用环境变量覆盖（只改 TTL，不改判定顺序）。 */
const DEFAULT_TTL_SECONDS = 900

/** 跨实例时钟余量默认 60 秒（只作容差，**不作放宽**）。 */
const DEFAULT_LEEWAY_SECONDS = 60

/** 生产**默认卡死**的兜底版本号（撤销面：改环境变量即全体旧令牌失效）。 */
const DEFAULT_VERSION = '1'

/** 手机号形态（与前端 `auth.js::isPhoneLike` 逐字同正则）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/** uid 前缀（与前端 `src/data/uid.js` / 管理员函数 `uidOf` **同一约定**）。 */
const UID_PREFIX = 'u-'

/** 摘要十六进制取前多少位（与前端 `src/data/uid.js::UID_HEX_LENGTH` 逐字同值）。 */
const UID_HEX_LENGTH = 16

/** 令牌里 `role` 的取值（**本函数只认 `user`**；管理员令牌由另一个函数签、另一把密钥）。 */
const USER_ROLE = 'user'

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

/** 手机号形态判定（归一后逐个匹配；**不猜格式**）。 */
function isPhoneLike(value) {
  return PHONE_PATTERN.test(normalizePhone(value))
}

/**
 * **服务端唯一的 uid 派生**：`u-` ＋ `sha256(手机号).hex` 前 16 位（**单向、不可反推手机号**）。
 * 与前端 `src/data/uid.js::uidOf` / 管理员函数 `uidOf` **同一算法 ⇒ 同值**（自检机械断言）。
 * 明文：uid **不是密码学保密** —— 作用只是不把手机号写进数据行 / 不直接露出。
 * 明文：uid **不由客户端提供**（既不在载荷里读、也不在令牌里由客户端自选）⇒
 * 「创建者 uid」是服务端按已通过验证码校验的手机号**确定性算出**的。
 */
function uidOf(value) {
  const digits = normalizePhone(value)
  if (!isPhoneLike(digits)) return ''
  return `${UID_PREFIX}${crypto.createHash('sha256').update(digits, 'utf8').digest('hex').slice(0, UID_HEX_LENGTH)}`
}

/** 运行期环境 Id（缺位 ⇒ 空串 ⇒ 由 node-sdk 走「当前环境」语义；**不写死**）。 */
function readEnvId(env) {
  const source = env || process.env
  for (const name of ENV_ID_NAMES) {
    const value = readString(source, name)
    if (value) return value
  }
  return ''
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

/**
 * 读配置。
 * @param {object} [env] 环境（缺省 `process.env`；测试可注入）
 * @returns {{ready:true, smsCode:string, secret:string, version:string, ttlSeconds:number,
 *            leewaySeconds:number, envId:string, adminPhone:string}
 *          |{ready:false, reason:string, message:string}}
 */
function readConfig(env) {
  const source = env || process.env
  const smsCode = readString(source, ENV_NAMES.SMS_CODE)
  const secret = readString(source, ENV_NAMES.SECRET)
  const missing = []
  if (!smsCode) missing.push(ENV_NAMES.SMS_CODE)
  if (!secret) missing.push(ENV_NAMES.SECRET)
  if (missing.length > 0) {
    return {
      ready: false,
      reason: REASONS.STORAGE_UNAVAILABLE,
      /* 只报**缺失项的环境变量名**（不是密钥值）⇒ 可排障、不泄密。 */
      message: `用戶令牌服務未配置（缺環境變量：${missing.join('、')}）⇒ 拒絕所有令牌操作；本次零寫入。`
    }
  }
  return {
    ready: true,
    smsCode,
    secret,
    version: readString(source, ENV_NAMES.VERSION) || DEFAULT_VERSION,
    ttlSeconds: readInteger(source, ENV_NAMES.TTL_SECONDS, DEFAULT_TTL_SECONDS),
    leewaySeconds: readInteger(source, ENV_NAMES.LEEWAY_SECONDS, DEFAULT_LEEWAY_SECONDS),
    envId: readEnvId(source),
    /* **管理员白名单真源**：缺 / 空 ⇒ 空串 ⇒ 所有管理员类 op 结构化拒绝（安全默认）。
       它**不参与** `ready` 判定 —— 缺它时普通用户写面（提交 / 采信）仍应可用。 */
    adminPhone: normalizePhone(readString(source, ENV_NAMES.ADMIN_PHONE))
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
  UID_HEX_LENGTH,
  USER_ROLE,
  deny,
  normalizePhone,
  isPhoneLike,
  uidOf,
  readEnvId,
  fingerprint,
  maskedPhone,
  readConfig
}
