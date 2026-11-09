'use strict'
/**
 * 玺爱 · **AI 用量窗口**（唯一用量实现点）
 * ============================================================================
 * 职责（本单范围）：中转面的**日窗口 / 分鐘窗口**计数只在此落地 ——
 * 只读窥视（`peekUsage`）/ 成功后计数（`commitUsage`）/ 只读限额判定（`evaluateGate`）
 * 三件事**只在此实现**，调用方不自写第二套。
 *
 * 集合（**服务端专属私有**；参照 `xiai_balances` 先例：**不进** `lib/ops.js` 的
 * `COLLECTIONS` 读写面登记表、**更不进**前端任何云读面 ⇒ 客户端零读面；单点即审计点）：
 *   · `xiai_ai_usage` ＝ 用量行；`_id` ＝ `au-` 拼 uid 拼 `-d-` 拼 `YYYYMMDD`（**日行**）
 *     或拼 `-m-` 拼 epochMinute（**分鐘行**）；**键面＝契约枚举的 6 项**
 *     `{_id, uid, window, bucket, count, updated_at}`（`window` ∈ {DAY, MINUTE}；
 *     `bucket` 统一落**字符串**：日行 ＝ `YYYYMMDD`、分鐘行 ＝ epochMinute 的十进制串）。
 *     【登记】契约文字写「键集恰 5 键」但随后枚举了 **6 个**键名 ⇒ 本单按**枚举**（逐字 6 键）
 *     实现，并把该计数出入提请派单方裁定。
 *
 * 硬口径（逐条）：
 *  ① **`peekUsage` / `evaluateGate` 只读、零写入**（判定路径一行都不写）；
 *     `commitUsage` 成功后**日行与分鐘行各 +1**（两行各走一次单文档条件更新）。
 *  ② **CAS 乐观锁**（与 `lib/ledger.js` 同裁决机制）：`where({_id, count: 旧值}).update({count: 旧值+1})`
 *     ⇒ 并发下恰一路 `updated === 1`；`0` ＝ 抢先 ⇒ 重读重试；`null` ＝ 计数读不出 ⇒ 按失败重试。
 *     **不用 `db.command.inc`**（本单未实测该算子，按派单方指示不引入）。
 *  ③ **限额来自本人 ACTIVE 金鑰**（`lib/aiKeys.js::readActiveKeyRows`：取各 ACTIVE 行
 *     `day_limit` / `minute_limit` 的**最小值** ＝ 当前真正生效的约束；无 ACTIVE 行 ⇒ 回缺省
 *     20 / 5）。`evaluateGate` 的 `day_limit` / `minute_limit` 由调用方（服务端）从金鑰行带入，
 *     **不采信前端自报**。
 *  ④ **判定语义**：`used >= limit` ⇒ 该窗口额度已耗尽 ⇒ 拒（`LIMIT_DAY` / `LIMIT_MINUTE`）。
 *  ⑤ **【已知项·登记】分鐘行不做自动清理**：每分鐘一行 ⇒ 行数持续增长；本单**不做**自动清理，
 *     清理归运维另一单（日行同理，但增速低三个量级）。
 *  ⑥ **拒绝形态恒为恰 3 键** `{ok:false, reason, message}`；`reason` 只用 `lib/config.js::REASONS`
 *     冻结表字面值（本文件不写字面量，只引用常量）。
 */

const { REASONS, deny, isDocNotExistError } = require('./config.js')
const aiKeys = require('./aiKeys.js')

/* ---------------------------------------------------------------------------
  常量面（封闭）
  --------------------------------------------------------------------------- */

/** 集合名（**服务端专属私有**）。 */
const AI_USAGE_COLLECTION = 'xiai_ai_usage'

/** 用量行键前缀（`au-` 拼 uid 拼窗口拼桶）。 */
const USAGE_ID_PREFIX = 'au-'

/** 窗口枚举（封闭）。 */
const USAGE_WINDOWS = Object.freeze({ DAY: 'DAY', MINUTE: 'MINUTE' })
const USAGE_WINDOW_VALUES = Object.freeze(['DAY', 'MINUTE'])

/** 用量行键面（＝契约枚举的 6 项；契约文字「5 鍵」与枚举不符，已登记）。 */
const USAGE_ROW_KEYS = Object.freeze(['_id', 'uid', 'window', 'bucket', 'count', 'updated_at'])

/** 窗口回包键面（`peekUsage` / `commitUsage` 共用；恰 2 键 × 2 窗口）。 */
const USAGE_WINDOW_KEYS = Object.freeze(['used', 'limit'])

/** CAS 重试上限（与账本同值）。 */
const CAS_MAX_ATTEMPTS = 16

/* ---------------------------------------------------------------------------
  存储缝（离线自检注入用；生产不注入 ⇒ 经 `lib/ops.js::resolveAiStore` 取真句柄）
  —— 取集合句柄的调用字面**只允许落在 `lib/ops.js`**，本文件只持有已取到的句柄。
  --------------------------------------------------------------------------- */

let storeProvider = null

/**
 * 注入用量存储实现（`() => {usage, keys}`；传非函数 ⇒ 清除注入）。
 * `keys` 供限额取值（缺省路径经 `lib/aiKeys.js` 的同一 seam）；`keys` 缺位 ⇒ 限额回缺省值。
 * **仅供离线自检 / 宿主**。
 * @param {null|function():object} fn
 */
function setAiUsageStoreProvider(fn) {
  storeProvider = typeof fn === 'function' ? fn : null
}

/** 存储缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function aiUsageStoreInjected() {
  return storeProvider !== null
}

function resolveStore() {
  if (storeProvider) return storeProvider()
  const ops = require('./ops.js')
  const store = ops && typeof ops.resolveAiStore === 'function' ? ops.resolveAiStore() : null
  if (!store || !store.usage) throw new Error('AI_USAGE_STORE_UNAVAILABLE')
  return store
}

/* ---------------------------------------------------------------------------
  小工具（时间窗口：服务端时钟唯一判据）
  --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

function updatedCountOf(result) {
  if (!result || typeof result !== 'object') return null
  const candidates = [result.updated, result.modified, result.matched, result.data && result.data.updated]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  }
  return null
}

function nowIso() {
  return text(new Date().toISOString())
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 日桶（`YYYYMMDD`，**服务端本地日历日**；与 `_id` 派生同源 ⇒ 一处派生、处处同值）。 */
function dayBucketOf(date) {
  const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
}

/** 分鐘桶（epochMinute ＝ `floor(ms / 60000)` 的十进制串）。 */
function minuteBucketOf(date) {
  const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  return String(Math.floor(at.getTime() / 60000))
}

/** 用量行文档键（`au-` 拼 uid 拼 `-d-` / `-m-` 拼桶）。 */
function usageIdOf(uid, window, bucket) {
  const mark = window === USAGE_WINDOWS.MINUTE ? 'm' : 'd'
  return `${USAGE_ID_PREFIX}${text(uid)}-${mark}-${text(bucket)}`
}

/** 窗口读数投影（恰 2 键 `{used, limit}`）。 */
function projectWindow(used, limit) {
  return { used, limit }
}

/* ---------------------------------------------------------------------------
  读点（**只读，不写**）
  --------------------------------------------------------------------------- */

/**
 * 按确定性文档键读一行用量（无行 ⇒ `null`）。
 *
 * **存在性语义**：`doc(id).get()` 在**文档不存在**时 CloudBase node-sdk 会**抛错**
 * （服务端回 404 ⇒ `TcbError.code === 404`），而不是回 `{data:[]}`。
 * 故这里**不依赖 `doc().get()` 的存在性语义**：`try/catch` 包住，**仅**把「文档不存在」类错误
 * 当空（判据见 `lib/config.js::isDocNotExistError`），**其它错误照旧上抛**（真存储故障绝不吞成「无行」）。
 */
async function readUsageRow(id) {
  const store = resolveStore()
  let rows = []
  try {
    rows = rowsOf(await store.usage.doc(id).get())
  } catch (error) {
    /* 只吞「文档不存在」；其余（连接 / 权限 / 5xx …）照旧上抛。 */
    if (!isDocNotExistError(error)) throw error
  }
  return rows.length > 0 ? rows[0] : null
}

/**
 * **本人生效限额**（`{day_limit, minute_limit}`）：取本人各 ACTIVE 金鑰行的**最小值**
 * （最小 ＝ 最严 ＝ 真正生效的约束）；无 ACTIVE 行 ⇒ 缺省 20 / 5。
 * @param {string} uid
 * @returns {Promise<{day_limit:number, minute_limit:number}>}
 */
async function resolveLimits(uid) {
  try {
    const rows = await aiKeys.readActiveKeyRows(uid)
    let day = aiKeys.DAY_LIMIT_DEFAULT
    let minute = aiKeys.MINUTE_LIMIT_DEFAULT
    let seen = false
    rows.forEach((row) => {
      const d = Number(row && row.day_limit)
      const m = Number(row && row.minute_limit)
      if (isInteger(d) && d > 0) {
        if (!seen || d < day) day = d
      }
      if (isInteger(m) && m > 0) {
        if (!seen || m < minute) minute = m
      }
      seen = true
    })
    return { day_limit: day, minute_limit: minute }
  } catch {
    /* 金鑰面取不到（注入缝缺位等）⇒ 回缺省限额（**不放行成无穷大**）。 */
    return { day_limit: aiKeys.DAY_LIMIT_DEFAULT, minute_limit: aiKeys.MINUTE_LIMIT_DEFAULT }
  }
}

/* ---------------------------------------------------------------------------
  写点（唯一：`casBump`）
  --------------------------------------------------------------------------- */

/**
 * **CAS +1**（窗口计数唯一写点）：无行 ⇒ 幂等建行（`count: 1`，`_id` 冲突 ⇒ 重读重试）；
 * 有行 ⇒ `where({_id, count: 旧值}).update({count: 旧值+1})`（锁在旧值上）。
 * @returns {Promise<{ok:true, count:number}|{ok:false, reason:string, message:string}>}
 */
async function casBump(uid, window, bucket) {
  const id = usageIdOf(uid, window, bucket)
  const store = resolveStore()
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    const row = await readUsageRow(id)
    if (!row) {
      try {
        await store.usage.add({ _id: id, uid: text(uid), window, bucket: text(bucket), count: 1, updated_at: nowIso() })
        return { ok: true, count: 1 }
      } catch {
        continue /* 建行冲突 ⇒ 并发建行 ⇒ 重读重试 */
      }
    }
    const current = Number(row.count)
    if (!isInteger(current) || current < 0) {
      return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 用量計數形態不合法；請稍後重試。')
    }
    const reply = await store.usage
      .where({ _id: id, count: current })
      .update({ count: current + 1, updated_at: nowIso() })
    const updated = updatedCountOf(reply)
    if (updated === 1) return { ok: true, count: current + 1 }
    /* `0` ＝ 并发抢先；`null` ＝ 计数读不出 ⇒ 重读重试。 */
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 用量計數競爭超時；請稍後重試。')
}

/* ---------------------------------------------------------------------------
  对外：窥视（只读）
  --------------------------------------------------------------------------- */

/**
 * **窥视本人用量**（**只读、零写入**；无行 ⇒ `used: 0`）。回**恰 2 键** × 2 窗口：
 * `{day:{used, limit}, minute:{used, limit}}`（**不带 `ok`** —— 「还没用过」不是错误）。
 * @param {{uid:string}} params
 * @returns {Promise<{day:{used:number, limit:number}, minute:{used:number, limit:number}}
 *          |{ok:false, reason:string, message:string}>}
 */
async function peekUsage(params) {
  const uid = text(params && typeof params === 'object' ? params.uid : '')
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const limits = await resolveLimits(uid)
  const dayRow = await readUsageRow(usageIdOf(uid, USAGE_WINDOWS.DAY, dayBucketOf(new Date())))
  const minuteRow = await readUsageRow(usageIdOf(uid, USAGE_WINDOWS.MINUTE, minuteBucketOf(new Date())))
  return {
    day: projectWindow(dayRow ? Number(dayRow.count) || 0 : 0, limits.day_limit),
    minute: projectWindow(minuteRow ? Number(minuteRow.count) || 0 : 0, limits.minute_limit)
  }
}

/* ---------------------------------------------------------------------------
  对外：计数（写）
  --------------------------------------------------------------------------- */

/**
 * **成功后计数**（日行与分鐘行**各 +1**；两行各一次 CAS）。任一行失败 ⇒ 结构化拒绝
 * （**不静默半成功**；先行已 +1 的窗口由同参重放自愈 —— 见交付报告的登记项）。
 * @param {{uid:string}} params
 * @returns {Promise<{ok:true, day:{used:number, limit:number}, minute:{used:number, limit:number}}
 *          |{ok:false, reason:string, message:string}>}
 */
async function commitUsage(params) {
  const uid = text(params && typeof params === 'object' ? params.uid : '')
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const now = new Date()
  const day = await casBump(uid, USAGE_WINDOWS.DAY, dayBucketOf(now))
  if (!day.ok) return day
  const minute = await casBump(uid, USAGE_WINDOWS.MINUTE, minuteBucketOf(now))
  if (!minute.ok) return minute
  const limits = await resolveLimits(uid)
  return { ok: true, day: projectWindow(day.count, limits.day_limit), minute: projectWindow(minute.count, limits.minute_limit) }
}

/* ---------------------------------------------------------------------------
  对外：限额判定（只读）
  --------------------------------------------------------------------------- */

/**
 * **只读限额判定**（**零写入**）：`used >= limit` ⇒ 额度耗尽 ⇒ `LIMIT_DAY` / `LIMIT_MINUTE`。
 * 限额由**服务端**（金鑰行）带入，不采信前端自报。
 * @param {{uid:string, day_limit:number, minute_limit:number}} params
 * @returns {Promise<{ok:true}|{ok:false, reason:string, message:string}>}
 */
async function evaluateGate(params) {
  const input = params && typeof params === 'object' ? params : {}
  const uid = text(input.uid)
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const limits = await resolveLimits(uid)
  const dayLimit = input.day_limit === undefined || input.day_limit === null ? limits.day_limit : input.day_limit
  const minuteLimit = input.minute_limit === undefined || input.minute_limit === null ? limits.minute_limit : input.minute_limit
  if (!isInteger(dayLimit) || dayLimit < 1) {
    return deny(REASONS.INVALID_VALUE, '日限額（day_limit）必須是正整數；本次零寫入。')
  }
  if (!isInteger(minuteLimit) || minuteLimit < 1) {
    return deny(REASONS.INVALID_VALUE, '分鐘限額（minute_limit）必須是正整數；本次零寫入。')
  }
  const now = new Date()
  const dayRow = await readUsageRow(usageIdOf(uid, USAGE_WINDOWS.DAY, dayBucketOf(now)))
  const minuteRow = await readUsageRow(usageIdOf(uid, USAGE_WINDOWS.MINUTE, minuteBucketOf(now)))
  const dayUsed = dayRow ? Number(dayRow.count) || 0 : 0
  const minuteUsed = minuteRow ? Number(minuteRow.count) || 0 : 0
  if (dayUsed >= dayLimit) {
    return deny(REASONS.LIMIT_DAY, `本日 AI 用量已達上限（${dayUsed}/${dayLimit}）；請明日再試。`)
  }
  if (minuteUsed >= minuteLimit) {
    return deny(REASONS.LIMIT_MINUTE, `本分鐘 AI 用量已達上限（${minuteUsed}/${minuteLimit}）；請稍後再試。`)
  }
  return { ok: true }
}

module.exports = {
  AI_USAGE_COLLECTION,
  USAGE_ID_PREFIX,
  USAGE_WINDOWS,
  USAGE_WINDOW_VALUES,
  USAGE_ROW_KEYS,
  USAGE_WINDOW_KEYS,
  CAS_MAX_ATTEMPTS,
  dayBucketOf,
  minuteBucketOf,
  usageIdOf,
  projectWindow,
  readUsageRow,
  resolveLimits,
  setAiUsageStoreProvider,
  aiUsageStoreInjected,
  peekUsage,
  commitUsage,
  evaluateGate
}
