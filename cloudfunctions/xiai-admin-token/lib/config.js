'use strict'
/**
 * 玺爱 · 管理员令牌云函数 · **配置面（环境变量唯一真源）**
 * ----------------------------------------------------------------------------
 * 口径（逐条）：
 *   ① **本文件不写任何密钥 / 手机号 / 验证码字面值** ✗ —— 一律从环境变量读；
 *      `ADMIN_PHONE` 的**工程真源**仍是 `src/data/seed.js:39`，本处是**同一真源的注入点**（非第二处定义点）。
 *   ② **配置缺失 ⇒ 拒绝、不静默降级**：缺 `XIAI_ADMIN_PHONE` / `XIAI_ADMIN_TOKEN_SECRET`
 *      一律返回结构化拒绝，`reason` 取**既有冻结字面值** `STORAGE_UNAVAILABLE`
 *      （语义 ＝ 权威存储 / 内部不可用；**属「内部不可用」，不是「越权」⇒ 不得用 `FORBIDDEN` 冒充**）。
 *      **P1c（管理面收口，2026-11-15）**：`XIAI_ADMIN_SMS_CODE` **已退出 `ready` 必填集** —— 全站固定码
 *      不再参与任何授权判定（改由 `lib/platformAuth.js` 拿平台 `access_token` 换手机号）；环境变量本身
 *      **仍然保留**（运维排障 / 其它引用），但**不得再用于任何授权判定**，故本文件只读出「是否仍配置」
 *      这个布尔读数（`legacySmsCodeConfigured`），**不回传其值**。
 *      `XIAI_ADMIN_TOKEN_SECRET` **仍必填**；`XIAI_ADMIN_PHONE` **仍必填**（白名单真源：缺 / 空 ⇒
 *      结构化拒绝 ＋ 零写入，**不得因未配置而放行**）。
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
  /**
   * **已下线的全站固定码**（W-43 ⇒ P1c 收口，2026-11-15）：起**不再参与授权判定**，
   * 也**不在 `ready` 必填集**里。变量名保留（其它代码可能引用 / 运维排障需要），
   * 本文件只读「是否仍配置」的布尔读数，**绝不用其值判权**。逐字值不再是任何授权依据。
   */
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

/** uid 前缀（与前端 `src/data/uid.js` / 用户函数 `uidOf` **同一约定**）。 */
const UID_PREFIX = 'u-'

/** 摘要十六进制取前多少位（与前端 `src/data/uid.js::UID_HEX_LENGTH` 逐字同值）。 */
const UID_HEX_LENGTH = 16

/**
 * 环境 Id 的三个候选环境变量（**运行期注入**；与用户函数 `lib/config.js` / liwu 既有函数同一读法；
 * 工程纪律「envId 不在代码里写死」照旧成立）。
 */
const ENV_ID_NAMES = Object.freeze(['TCB_ENV', 'SCF_NAMESPACE', 'CLOUDBASE_ENV_ID'])

/**
 * **平台 auth 区域参数化（R-L9，2026-11-15）** —— 与 `lib/platformAuth.js` 的区域常量**同值同序**；
 * 本文件是「配置面唯一真源」，`platformAuth.js` 只在**没收到显式 `region` 参数**时才自行读环境
 * （`index.js` 恒显式传入 `readConfig().authRegion` ⇒ 生产只有这一条取值路）。
 * 区域**不是判定输入**（只决定打到哪个区域的 auth 端点）⇒ 它**不参与 `ready` 判定**。
 */
const AUTH_REGION_NAMES = Object.freeze(['XIAI_AUTH_REGION', 'TCB_REGION'])

/** 区域默认值（＝参数化之前硬编码的生产区域 ⇒ 不配环境变量时行为逐字等价）。 */
const DEFAULT_AUTH_REGION = 'ap-shanghai'

/** 区域形态（小写字母 / 数字 / 连字符；**不含点与斜杠** ⇒ 拼不出别的域）。 */
const AUTH_REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 读区域（`XIAI_AUTH_REGION` → 回退 `TCB_REGION` → 默认 `ap-shanghai`）。
 * 形态不成立 ⇒ **跳过该候选**，最终回落默认值（绝不把不合格串拼进 host）。
 * @param {object} [env] 环境（缺省 `process.env`）
 * @returns {string} 区域（恒非空、形态成立）
 */
function readAuthRegion(env) {
  const source = env || process.env
  for (const name of AUTH_REGION_NAMES) {
    const value = readString(source, name).toLowerCase()
    if (value === '') continue
    if (AUTH_REGION_PATTERN.test(value)) return value
  }
  return DEFAULT_AUTH_REGION
}

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
 * **服务端唯一的 reviewer_id 派生**：`u-` ＋ `sha256(手机号).hex` 前 16 位
 * （**单向、不可反推手机号**；与用户函数 `uidOf` / 前端 `src/data/uid.js::uidOf`
 * **同一算法 ⇒ 同值**）。
 * 明文：审核人身份**不以客户端自称为准**，一律由已验签令牌声明里的手机号派生
 * ⇒ 前端无法自称审核人；**管理员手机号只活在服务端环境变量**，绝不进任何数据行。
 */
function uidOf(value) {
  const digits = normalizePhone(value)
  if (!isPhoneLike(digits)) return ''
  return `${UID_PREFIX}${crypto.createHash('sha256').update(digits, 'utf8').digest('hex').slice(0, UID_HEX_LENGTH)}`
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
 *
 * **P1c（管理面收口，2026-11-15）**：`ready` 必填集**只剩 `XIAI_ADMIN_PHONE` ＋ `XIAI_ADMIN_TOKEN_SECRET`**。
 * `XIAI_ADMIN_SMS_CODE` 已下线（不再参与签发判定）⇒ 缺它**不得**让整个函数 `STORAGE_UNAVAILABLE`
 * （否则变量一下线管理员就再也签不出令牌）；但仍读出「是否仍配置」的布尔读数，供运维在日志里看到
 * 「遗留变量还在」这一事实 —— **不回传其值、不作任何判定输入**。
 * @param {object} [env] 环境（缺省 `process.env`；测试可注入）
 * @returns {{ready:true, phone:string, legacySmsCodeConfigured:boolean, secret:string, version:string,
 *            ttlSeconds:number, leewaySeconds:number, envId:string, authRegion:string}
 *          |{ready:false, reason:string, message:string}}
 */
function readConfig(env) {
  const source = env || process.env
  const phone = normalizePhone(readString(source, ENV_NAMES.PHONE))
  /* 遗留全站固定码：**只读存在性**（布尔），值既不回传也不参与判定。 */
  const legacySmsCodeConfigured = readString(source, ENV_NAMES.SMS_CODE) !== ''
  const secret = readString(source, ENV_NAMES.SECRET)
  const missing = []
  if (!phone) missing.push(ENV_NAMES.PHONE)
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
    legacySmsCodeConfigured,
    secret,
    version: readString(source, ENV_NAMES.VERSION) || DEFAULT_VERSION,
    ttlSeconds: readInteger(source, ENV_NAMES.TTL_SECONDS, DEFAULT_TTL_SECONDS),
    leewaySeconds: readInteger(source, ENV_NAMES.LEEWAY_SECONDS, DEFAULT_LEEWAY_SECONDS),
    envId: readEnvId(source),
    /* **R-L9**：平台 auth 区域（显式交给 `verifyPlatformSession` 的唯一取值路）。 */
    authRegion: readAuthRegion(source)
  }
}

/**
 * **「文档不存在」类错误判据**（供各 `doc(id).get()` 读点安全包裹用）。
 *
 * **与 user-token 侧 `xiai-user-token/lib/config.js::isDocNotExistError` 逐字同义**；
 * 因**部署单元独立**（两函数分目录、逐目录部署，跨函数 `require` 会在逐目录部署下断）
 * 而**各存一份**。语义（命中其一即判「不存在」；只看错误码 / errCode，绝不做 message 文本匹配）：
 *   · `error.code === 404`（数字）—— CloudBase 服務端 SDK 生产实测抛错形态（HTTP not-found）；
 *   · `error.code === 'DATABASE_QUERY_DOC_NONEXIST' | 'DOCUMENT_NOT_EXIST' | 'RESOURCE_NOT_FOUND'`；
 *   · `error.errCode === -502005` —— wx-server-sdk 家族「database.document not exist」。
 * 其余任何错误（连接 / 超时 / 权限 / 非 404 的 5xx …）一律**判否** ⇒ 调用方**照旧上抛**，
 * 绝不吞成「无行」（守「真存储故障不得伪装成空」这条硬口径）。
 * @param {any} error 捕获到的错误
 * @returns {boolean} 是否属「文档不存在」类
 */
function isDocNotExistError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.code === 404) return true
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'DATABASE_QUERY_DOC_NONEXIST' || code === 'DOCUMENT_NOT_EXIST' || code === 'RESOURCE_NOT_FOUND') return true
  if (error.errCode === -502005) return true
  return false
}

module.exports = {
  REASONS,
  ENV_NAMES,
  ENV_ID_NAMES,
  AUTH_REGION_NAMES,
  DEFAULT_AUTH_REGION,
  AUTH_REGION_PATTERN,
  DEFAULT_TTL_SECONDS,
  DEFAULT_LEEWAY_SECONDS,
  DEFAULT_VERSION,
  PHONE_PATTERN,
  UID_PREFIX,
  UID_HEX_LENGTH,
  deny,
  normalizePhone,
  isPhoneLike,
  uidOf,
  readEnvId,
  readAuthRegion,
  fingerprint,
  maskedPhone,
  isDocNotExistError,
  readConfig
}
