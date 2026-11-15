'use strict'
/**
 * 玺爱 · **结构化日志单点**（`P2-8`；本仓 `console.*` 的唯一落点）
 * ============================================================================
 * 口径（逐条）：
 *  · **单点**：本仓只有本文件出现 `console.*`；`lib/*.js` 与 `index.js` 一律调
 *    `log.info / log.warn / log.error`（静态可验：`grep -rc 'console\.' lib/*.js index.js`
 *    ⇒ 仅本文件非零）。
 *  · **一条日志 ＝ 一行 JSON**：`{tag, level, event, ...fields}`（扁平；`tag` 恒
 *    `xiai-user-token`）—— 既有 `audit()` 的扁平记录面**逐键保留**（只增 `level` / `event`
 *    两个非敏感键 ⇒ 语义不变、条数不变）。
 *  · **`event` 命名**：`域.动作`（如 `correction.accept.denied`、`repairPrimaryFace.row.notApplied`）。
 *  · **敏感字段硬黑名单**：键名**包含** `phone / token / secret / key / password / code /
 *    env / conn / dsn` 之一者 ⇒ **只打印键名 ＋ `<redacted>`，绝不打印值**（宁误伤长串、
 *    不漏真值；嵌套对象逐层同尺，`stack` 一律**整键丢弃**——栈里可能夹带实参值）。
 *  · **`error()` 只打 `error.message`**（截断 200 字）＋ `error.name`；**不打 `stack`**。
 *  · **绝不反噬主路**：`JSON.stringify` / 取值任何一步抛错 ⇒ 静默吞掉（日志失败不得影响判定）。
 *  · **零 SDK 依赖**（纯 JS；`index.js` 保持零 SDK 字面）。
 */

/** 日志行标签（与既有审计日志同一 tag，便于平台按 tag 过滤）。 */
const TAG = 'xiai-user-token'
/** 慢调用阈值（ms）：单 `op` 超过此值 ⇒ 走 `warn`（`op.slow`），否则 `info`（`op.done`）。 */
const LOG_SLOW_MS = 3000
/** 敏感值的统一替身（**只出键名**）。 */
const REDACTED = '<redacted>'
/** 普通字符串字段的截断上限（防整行回显大载荷）。 */
const MAX_TEXT = 300
/** `error.message` 的截断上限（本单口径：200 字）。 */
const MAX_ERROR_TEXT = 200
/** 数组字段最多展开的条数。 */
const MAX_ARRAY_ITEMS = 5
/** 嵌套展开层数上限（超出 ⇒ 压成截断字符串）。 */
const MAX_DEPTH = 2

/**
 * **敏感键片段（硬黑名单，供静态校验）**：键名（忽略大小写与 `_` / `-`）**包含**其中之一
 * ⇒ 值一律替成 `REDACTED`。`code` 指短信验证码（**故意从宽**：`code_id` 之类业务编号
 * 亦被误伤 —— 宁误伤、不漏值）。
 */
const REDACTED_KEYS = Object.freeze([
  'phone',
  'token',
  'secret',
  'key',
  'password',
  'code',
  'env',
  'conn',
  'dsn'
])

/**
 * **非敏感字段白名单（命名纪律，供静态校验与评审）**：新增埋点应只从中取名；
 * 例外是既有 `audit()` 记录面（`action / outcome / stage / docId / jti / exp / ver /
 * serverNow / detail / failedStep / totalSteps / completedSteps / identitySource / role`
 * 等）—— 那些键必须**逐键保留**（语义不变），故本表亦把它们登记在册。
 * **硬闸不是白名单而是黑名单**：未登记键不会被丢弃（丢弃会改变既有日志语义）。
 */
const ALLOWED_FIELDS = Object.freeze([
  'event',
  'level',
  'tag',
  'message',
  'op',
  'uid',
  'faceId',
  'sealId',
  'imageId',
  'bookId',
  'taskId',
  'durationMs',
  'reason',
  'count',
  'mode',
  'code',
  'status',
  'ok',
  'errorName',
  'errorMessage',
  /* —— 既有 `audit()` 记录面（逐键保留） —— */
  'action',
  'outcome',
  'stage',
  'detail',
  'docId',
  'jti',
  'exp',
  'ver',
  'serverNow',
  'role',
  'identitySource',
  'failedStep',
  'totalSteps',
  'completedSteps',
  /* —— 分批降级告警的定位键（非敏感） —— */
  'collection',
  'label',
  'rowId',
  'personId',
  'sha256',
  'written',
  'scanned',
  'attempted',
  'failed',
  'kind',
  'id'
])

/** 归一化键名：小写 ＋ 去掉 `_` / `-`（`masked_phone` / `maskedPhone` 同判）。 */
function normalizeKeyOf(key) {
  return String(key === undefined || key === null ? '' : key)
    .toLowerCase()
    .replace(/[_-]/g, '')
}

/** 键名是否命中敏感黑名单（含即算；`stack` 亦按敏感处理 —— 栈可能夹带实参值）。 */
function isSensitiveKey(key) {
  const normalized = normalizeKeyOf(key)
  if (normalized === '') return false
  if (normalized.includes('stack')) return true
  for (const fragment of REDACTED_KEYS) {
    if (normalized.includes(fragment)) return true
  }
  return false
}

/** 任意值 ⇒ 文本（**绝不自抛**）。 */
function toTextOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Error) return typeof value.message === 'string' && value.message !== '' ? value.message : String(value.name || 'error')
  try {
    const json = JSON.stringify(value)
    return typeof json === 'string' ? json : String(value)
  } catch {
    return '[unserializable]'
  }
}

/** 截断（**先脱敏、后截长** —— 避免半截 JSON）。 */
function clipOf(text, max) {
  const source = typeof text === 'string' ? text : toTextOf(text)
  return source.length > max ? `${source.slice(0, max)}…` : source
}

/**
 * **值级兜底脱敏**（键名看不见的真值泄漏面）：截断前先把三类**形态可识**的真值抹掉 ——
 *  ① 手机号形态 `1[3-9]` ＋ 9 位数字；
 *  ② 连接串里的账号口令 `://user:pass@`；
 *  ③ `Bearer …` / `Basic …` 令牌。
 * 纯函数、绝不自抛（正则替换失败 ⇒ 原串返回）。
 * @param {string} text 原串
 * @returns {string} 抹后的串
 */
function scrubTextOf(text) {
  if (typeof text !== 'string' || text === '') return text
  try {
    return text
      .replace(/(^|[^\d])1[3-9]\d{9}(?![\d])/g, `$1${REDACTED}`)
      .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, `://${REDACTED}@`)
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g, `$1 ${REDACTED}`)
  } catch {
    return text
  }
}

/** 截断 ＋ 值级兜底脱敏（字符串统一走这里）。 */
function safeTextOf(text, max) {
  return clipOf(scrubTextOf(toTextOf(text)), max)
}

/** 标量 / Error / 嵌套对象的脱敏收敛（**键名判据逐层同尺**）。 */
function sanitizeValueOf(key, value, depth) {
  if (isSensitiveKey(key)) return REDACTED
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (value instanceof Error) return safeTextOf(value.message || value.name || 'error', MAX_ERROR_TEXT)
  if (typeof value === 'string') return safeTextOf(value, MAX_TEXT)
  if (typeof value !== 'object') return safeTextOf(value, MAX_TEXT)
  if (depth >= MAX_DEPTH) return safeTextOf(value, MAX_TEXT)
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => {
      const sanitized = sanitizeFieldsOf(item, depth + 1)
      return sanitized === null ? safeTextOf(item, MAX_TEXT) : sanitized
    })
  }
  const nested = sanitizeFieldsOf(value, depth + 1)
  return nested === null ? safeTextOf(value, MAX_TEXT) : nested
}

/**
 * 字段表脱敏（导出供静态 / 离线校验）。
 * @param {object|null} fields 待打的字段
 * @param {number} [depth] 嵌套层（内部用）
 * @returns {object|null} 脱敏后的字段（键名 ∈ 黑名单 ⇒ 值为 `REDACTED`）
 */
function sanitizeFieldsOf(fields, depth) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  const out = {}
  for (const key of Object.keys(fields)) {
    const sanitized = sanitizeValueOf(key, fields[key], typeof depth === 'number' ? depth : 0)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

/** 导出形态（外部用；内部递归走 `sanitizeFieldsOf`）。 */
function sanitizeFields(fields) {
  const clean = sanitizeFieldsOf(fields, 0)
  return clean === null ? {} : clean
}

/** 单行落盘（**唯一出现 `console.*` 的地方**；自身绝不自抛）。 */
function emitOf(level, event, fields) {
  try {
    const record = { tag: TAG, level, event: clipOf(toTextOf(event), 80) }
    const clean = sanitizeFields(fields)
    for (const key of Object.keys(clean)) {
      /* 已由 `sanitizeFields` 判过黑名单；此处再兜一层（`level` / `event` 被字段覆盖的写法一律不许）。 */
      if (key === 'tag' || key === 'level' || key === 'event') continue
      record[key] = clean[key]
    }
    const line = JSON.stringify(record)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } catch {
    /* 日志失败不得影响判定结果 */
  }
}

/**
 * 常规信息（**成功路径 / 审计记录**）。
 * @param {string} event `域.动作`
 * @param {object} [fields] 非敏感字段（敏感键 ⇒ 值替 `<redacted>`）
 */
function info(event, fields) {
  emitOf('info', event, fields)
}

/**
 * 降级 / 慢调用（**不中断主路**的如实告警）。
 * @param {string} event `域.动作`
 * @param {object} [fields] 非敏感字段
 */
function warn(event, fields) {
  emitOf('warn', event, fields)
}

/**
 * 故障（**只打 `error.message`（≤200 字）＋ `error.name`**；**不打 `stack`**）。
 * @param {string} event `域.动作`
 * @param {object} [fields] 非敏感字段；`fields.error` 若为异常对象 ⇒ 收敛成 `errorName` / `errorMessage`
 */
function error(event, fields) {
  const source = fields && typeof fields === 'object' ? fields : {}
  const merged = {}
  for (const key of Object.keys(source)) {
    if (normalizeKeyOf(key) === 'error') continue
    merged[key] = source[key]
  }
  const thrown = source.error
  if (thrown !== undefined && thrown !== null) {
    const isError = thrown instanceof Error
    merged.errorName = isError && typeof thrown.name === 'string' ? thrown.name : typeof thrown
    merged.errorMessage = safeTextOf(
      isError ? thrown.message || thrown.name || 'error' : thrown,
      MAX_ERROR_TEXT
    )
  }
  emitOf('error', event, merged)
}

module.exports = {
  TAG,
  LOG_SLOW_MS,
  REDACTED,
  REDACTED_KEYS,
  ALLOWED_FIELDS,
  MAX_TEXT,
  MAX_ERROR_TEXT,
  isSensitiveKey,
  sanitizeFields,
  info,
  warn,
  error
}
