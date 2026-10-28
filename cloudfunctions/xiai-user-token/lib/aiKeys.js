'use strict'
/**
 * 玺爱 · **AI 金鑰**（`sk-xiai-…`）**唯一實現點**
 * ============================================================================
 * 职责（本单范围）：金鑰的**签发 / 列表 / 吊销 / 限额改写 / 服务端校验**五件事**只在此落地**；
 * 调用方（`lib/ops.js` 的 `issueAiKey` / `listAiKeys` / `revokeAiKey` / `updateAiKeyLimits`
 * 与后续中转面 `api/**` 的校验）一律经本文件走，**不自写第二套**。
 *
 * 集合（**服务端专属私有**；参照 `xiai_balances` 先例：**不进** `lib/ops.js` 的 `COLLECTIONS`
 * 读写面登记表、**更不进**前端 `src/data/cloudbase.js` 的 `CLOUD_COLLECTIONS` /
 * `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL` ⇒ **客户端零读面**；单一读写点＝本文件
 * ⇒ 单点即审计点）：
 *   · `xiai_ai_keys` ＝ 金鑰行；`_id` ＝ `ak-` 拼 `key_id`；**键面恰 12 键**
 *     `{_id, uid, key_id, key_hash, key_prefix, label, status, created_at, revoked_at,
 *       day_limit, minute_limit, updated_at}`。
 *
 * 硬口径（逐条）：
 *  ① **明文只出现一次**：`issueAiKey` 的回包带明文（`key`），**库内零明文** ——
 *     只落 `key_hash`（`sha256(key).hex` 前 **16** 位）＋ `key_prefix`（明文前 **8** 位）；
 *     `listAiKeys` 逐行投影为**恰 8 键**（`{key_id, key_prefix, label, status, created_at,
 *       revoked_at, day_limit, minute_limit}`）⇒ **零 hash、零明文**。
 *  ② **金鑰形态**：`sk-xiai-` 拼 **32 位十六进制**（`crypto.randomBytes(16).toString('hex')`）；
 *     `key_id` ＝ 另外 **16 位十六进制**；`key_prefix` ＝ 明文**前 8 位**（逐字＝ `sk-xiai-`，
 *     仍按契约取「明文前 8 位」，不另行定义前缀常量语义）。
 *  ③ **只許本人**：`revokeAiKey` / `updateAiKeyLimits` 的 `uid` 一律取**服务端派生**值；
 *     行不属本人（或 `key_id` 不存在）⇒ 结构化拒绝 `FORBIDDEN` ＋ **零写入** ——
 *     **两种情形同一 reason ⇒ 不洩露「該鍵是否存在」**（防枚举）。
 *  ④ **幂等吊销**：已 `REVOKED` ⇒ `ok:true` ＋ `already:true` ＋ 原 `revoked_at`，**行不新增、
 *     一字不改**；首次吊销走 `where({_id, status:'ACTIVE'}).update(…)` 单文档条件更新（乐观锁）
 *     ⇒ 并发下恰一路生效，另一路重读回 `already:true`。
 *  ⑤ **每人 ACTIVE 上限 10 枚**（**只数 ACTIVE**；已吊销行不占额度）；超限 ⇒ `INVALID_VALUE`
 *     ＋ 零写入（契约原字面值 `LIMIT_EXCEEDED` **不在配置面冻结表** ⇒ 按派单方指示**不自行新增**、
 *     回落既有字面值，并在交付报告登记该愿望值）。
 *  ⑥ **值域门全部在写之前**：`label` 可空、≤ 40 字（超出 ⇒ `INVALID_VALUE`）；`day_limit`
 *     缺省 20 ∈ [1,1000]、`minute_limit` 缺省 5 ∈ [1,120]；越界 / 非整数 ⇒ `INVALID_VALUE`
 *     ＋ **零写入**（不静默夹取、不静默取整）。
 *  ⑦ **拒绝形态恒为恰 3 键** `{ok:false, reason, message}`；`reason` 只用 `lib/config.js::REASONS`
 *     冻结表字面值 —— 本文件不写字面量，只引用常量。
 *  ⑧ **零明文的另一面**：本文件**不打印、不日志、不回显**任何明文或 hash 全文；
 *     `resolveAiKey` 只回 `key_id` / `uid` / 两个限额，**不回 hash、不回前缀**。
 *  ⑨ **不做分钟行清理**（登记为已知项）：吊销只是改行状态，`xiai_ai_keys` 行数只增不减；
 *     清理归运维另一单。
 */

const crypto = require('crypto')
const { REASONS, deny } = require('./config.js')

/* ---------------------------------------------------------------------------
  常量面（封闭）
  --------------------------------------------------------------------------- */

/** 集合名（**服务端专属私有**；不进 `COLLECTIONS`、不进任何前端云读面）。 */
const AI_KEYS_COLLECTION = 'xiai_ai_keys'

/** 文档键前缀（`ak-` 拼 `key_id`）。 */
const KEY_ID_PREFIX = 'ak-'

/** 金鑰明文前缀（8 字元；`sk-xiai-`）。 */
const KEY_PLAIN_PREFIX = 'sk-xiai-'

/** 明文尾部十六进制位数（32 位 ＝ `randomBytes(16)`）。 */
const KEY_HEX_LENGTH = 32

/** `key_id` 十六进制位数（16 位 ＝ `randomBytes(8)`）。 */
const KEY_ID_HEX_LENGTH = 16

/** `key_hash` 位数（`sha256(key).hex` 前 16 位；**不落完整 hash**）。 */
const KEY_HASH_LENGTH = 16

/** `key_prefix` 位数（明文前 8 位）。 */
const KEY_PREFIX_LENGTH = 8

/** 状态枚举（封闭）。 */
const KEY_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' })
const KEY_STATUS_VALUES = Object.freeze(['ACTIVE', 'REVOKED'])

/** 每人 ACTIVE 金鑰上限（超限 ⇒ `INVALID_VALUE`；**只数 ACTIVE**）。 */
const ACTIVE_KEY_LIMIT_PER_USER = 10

/** `label` 上限（可空；超出 ⇒ `INVALID_VALUE`，不静默截断）。 */
const LABEL_MAX_LENGTH = 40

/** 日限 / 分鐘限：缺省值与值域（越界 / 非整数 ⇒ `INVALID_VALUE`，零写入）。 */
const DAY_LIMIT_DEFAULT = 20
const DAY_LIMIT_MIN = 1
const DAY_LIMIT_MAX = 1000
const MINUTE_LIMIT_DEFAULT = 5
const MINUTE_LIMIT_MIN = 1
const MINUTE_LIMIT_MAX = 120

/** 金鑰行存储键面（恰 12 键）。 */
const KEY_ROW_KEYS = Object.freeze([
  '_id',
  'uid',
  'key_id',
  'key_hash',
  'key_prefix',
  'label',
  'status',
  'created_at',
  'revoked_at',
  'day_limit',
  'minute_limit',
  'updated_at'
])

/** 列表回包逐行投影键面（恰 8 键；**零 `key_hash`、零明文**）。 */
const KEY_LIST_PROJECTION_KEYS = Object.freeze([
  'key_id',
  'key_prefix',
  'label',
  'status',
  'created_at',
  'revoked_at',
  'day_limit',
  'minute_limit'
])

/** CAS（单文档条件更新）重试上限；超限 ⇒ 结构化拒绝（同参重放可自愈）。 */
const CAS_MAX_ATTEMPTS = 16

/* ---------------------------------------------------------------------------
  DB 句柄缝（离线自检注入用；生产不注入 ⇒ 经 `lib/ops.js::resolveAiStore` 取真句柄）
  —— 静态纪律（守既有静态门）：**取集合句柄与取库句柄的调用字面只允许落在 `lib/ops.js`**，
  本文件只持有**已取到的句柄**。
  --------------------------------------------------------------------------- */

let storeProvider = null

/**
 * 注入金鑰存储实现（`() => {keys}`；传非函数 ⇒ 清除注入）。**仅供离线自检 / 宿主**。
 * @param {null|function():object} fn
 */
function setAiKeyStoreProvider(fn) {
  storeProvider = typeof fn === 'function' ? fn : null
}

/** 存储缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function aiKeyStoreInjected() {
  return storeProvider !== null
}

/**
 * 取金鑰存储句柄。
 * 顺序：① 注入缝（离线自检）→ ② `lib/ops.js::resolveAiStore`（生产单点；懒加载避免装载期循环）。
 * 两路都拿不到 ⇒ 抛错 ⇒ 由调用方转结构化拒绝（**绝不伪装 `FORBIDDEN`**）。
 */
function resolveStore() {
  if (storeProvider) return storeProvider()
  const ops = require('./ops.js')
  const store = ops && typeof ops.resolveAiStore === 'function' ? ops.resolveAiStore() : null
  if (!store || !store.keys) throw new Error('AI_KEY_STORE_UNAVAILABLE')
  return store
}

/* ---------------------------------------------------------------------------
  小工具
  --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 归一化一行读回（兼容 `{data:[…]}` / `{data:{…}}` / 裸数组；认不出 ⇒ `[]`，明确空集、不猜）。 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.data)) return result.data
  if (result && result.data && typeof result.data === 'object') return [result.data]
  return []
}

/** 归一化 `where(...).update(...)` 的「受影响行数」（读不出 ⇒ `null` ⇒ 一律按失败重试）。 */
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

/** 整数判定（`typeof number && Number.isInteger`；字符串数字一律不算 ⇒ 不做隐式转换）。 */
function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 金鑰行文档键（`ak-` 拼 `key_id`）。 */
function keyDocIdOf(keyId) {
  return `${KEY_ID_PREFIX}${text(keyId)}`
}

/** 金鑰摘要（`sha256(key).hex` 前 16 位；**只用于服务端比对，不下发**）。 */
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, KEY_HASH_LENGTH)
}

/** 铸造一枚明文（`sk-xiai-` ＋ 32 位十六进制）。 */
function mintKey() {
  return `${KEY_PLAIN_PREFIX}${crypto.randomBytes(16).toString('hex')}`
}

/** 铸造一个 `key_id`（16 位十六进制）。 */
function mintKeyId() {
  return crypto.randomBytes(KEY_ID_HEX_LENGTH / 2).toString('hex')
}

/** 列表行投影（**恰 8 键；零 `key_hash`、零明文**）。 */
function projectKeyRow(row) {
  const source = row && typeof row === 'object' ? row : {}
  return {
    key_id: text(source.key_id),
    key_prefix: text(source.key_prefix),
    label: text(source.label),
    status: text(source.status),
    created_at: text(source.created_at),
    revoked_at: source.revoked_at === undefined || source.revoked_at === null ? null : text(source.revoked_at),
    day_limit: Number(source.day_limit),
    minute_limit: Number(source.minute_limit)
  }
}

/**
 * 限额值域门（**判定在任何写之前**）。
 * @param {*} value 待判值（`undefined` / `null` ⇒ 取缺省）
 * @param {{def:number, min:number, max:number}} policy
 * @returns {{ok:true, value:number}|{ok:false, field:string, given:*}}
 */
function limitOf(value, policy) {
  const raw = value === undefined || value === null ? policy.def : value
  if (!isInteger(raw) || raw < policy.min || raw > policy.max) {
    return { ok: false, field: '', given: value }
  }
  return { ok: true, value: raw }
}

/* ---------------------------------------------------------------------------
  读点（**只读，不写**）
  --------------------------------------------------------------------------- */

/** 按确定性文档键读一行金鑰（无行 ⇒ `null`）。 */
async function readKeyRow(keyId) {
  const store = resolveStore()
  const rows = rowsOf(await store.keys.doc(keyDocIdOf(keyId)).get())
  return rows.length > 0 ? rows[0] : null
}

/** 读某 uid 的**全部**金鑰行（含已吊销；服务端内部读，不下发）。 */
async function readUserKeyRows(uid) {
  const store = resolveStore()
  return rowsOf(await store.keys.where({ uid: text(uid) }).get())
}

/** 读某 uid 的 **ACTIVE** 行（用于 10 枚额度计数与限额取值）。 */
async function readActiveKeyRows(uid) {
  const store = resolveStore()
  return rowsOf(await store.keys.where({ uid: text(uid), status: KEY_STATUS.ACTIVE }).get())
}

/* ---------------------------------------------------------------------------
  对外：签发（明文只回一次）
  --------------------------------------------------------------------------- */

/**
 * **签发一枚 AI 金鑰**（回包**含明文一次**；库内零明文、零完整 hash）。
 * 顺序（**全部判定在任何写入之前**）：① `uid` 非空 → ② `label` ≤ 40 字 → ③ 限额值域
 * → ④ ACTIVE 额度 ≤ 10 枚 → ⑤ 铸造并插入（`_id` ＝ `ak-` 拼 `key_id`）。
 * @param {{uid:string, label?:string, day_limit?:number, minute_limit?:number}} params
 * @returns {Promise<{ok:true, key_id:string, key:string, key_prefix:string, label:string,
 *          day_limit:number, minute_limit:number, created_at:string}
 *          |{ok:false, reason:string, message:string}>}
 */
async function issueAiKey(params) {
  const input = params && typeof params === 'object' ? params : {}
  const uid = text(input.uid)
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const label = input.label === undefined || input.label === null ? '' : String(input.label)
  if (label.length > LABEL_MAX_LENGTH) {
    return deny(REASONS.INVALID_VALUE, `金鑰備註（label）超出上限（${LABEL_MAX_LENGTH} 字）；本次零寫入。`)
  }
  const day = limitOf(input.day_limit, { def: DAY_LIMIT_DEFAULT, min: DAY_LIMIT_MIN, max: DAY_LIMIT_MAX })
  if (!day.ok) {
    return deny(
      REASONS.INVALID_VALUE,
      `日限額（day_limit）必須是 ${DAY_LIMIT_MIN} 〜 ${DAY_LIMIT_MAX} 之間的整數；本次零寫入。`
    )
  }
  const minute = limitOf(input.minute_limit, { def: MINUTE_LIMIT_DEFAULT, min: MINUTE_LIMIT_MIN, max: MINUTE_LIMIT_MAX })
  if (!minute.ok) {
    return deny(
      REASONS.INVALID_VALUE,
      `分鐘限額（minute_limit）必須是 ${MINUTE_LIMIT_MIN} 〜 ${MINUTE_LIMIT_MAX} 之間的整數；本次零寫入。`
    )
  }
  const active = await readActiveKeyRows(uid)
  if (active.length >= ACTIVE_KEY_LIMIT_PER_USER) {
    /* 【登記】契約原字面值 `LIMIT_EXCEEDED` 不在冻结表 ⇒ 按派单方指示回落既有字面值。 */
    return deny(
      REASONS.INVALID_VALUE,
      `每人最多同時持有 ${ACTIVE_KEY_LIMIT_PER_USER} 枚有效（ACTIVE）金鑰（當前 ${active.length} 枚）；` +
        '請先吊銷不用的金鑰再簽發；本次零寫入。'
    )
  }
  const key = mintKey()
  const keyId = mintKeyId()
  const at = nowIso()
  const row = {
    _id: keyDocIdOf(keyId),
    uid,
    key_id: keyId,
    key_hash: hashKey(key),
    key_prefix: key.slice(0, KEY_PREFIX_LENGTH),
    label,
    status: KEY_STATUS.ACTIVE,
    created_at: at,
    revoked_at: null,
    day_limit: day.value,
    minute_limit: minute.value,
    updated_at: at
  }
  const store = resolveStore()
  try {
    await store.keys.add(row)
  } catch (error) {
    /* `_id` 冲突（同一 `key_id` 撞号，概率趋零）⇒ 如实报内部不可用；**不覆盖既有行**。 */
    return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 金鑰簽發未確認（鍵標識衝突）；請重試本次操作。')
  }
  return {
    ok: true,
    key_id: keyId,
    key, // **唯一一次明文**
    key_prefix: row.key_prefix,
    label,
    day_limit: day.value,
    minute_limit: minute.value,
    created_at: at
  }
}

/* ---------------------------------------------------------------------------
  对外：清单（逐行零 hash、零明文）
  --------------------------------------------------------------------------- */

/**
 * **本人金鑰清单**（含已吊销；按 `created_at` 倒序；逐行投影为**恰 8 键**）。
 * @param {{uid:string}} params
 * @returns {Promise<{ok:true, rows:Array<object>, count:number}
 *          |{ok:false, reason:string, message:string}>}
 */
async function listAiKeys(params) {
  const uid = text(params && typeof params === 'object' ? params.uid : '')
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const rows = await readUserKeyRows(uid)
  const projected = rows
    .slice()
    .sort((a, b) => text(b && b.created_at).localeCompare(text(a && a.created_at)))
    .map(projectKeyRow)
  return { ok: true, rows: projected, count: projected.length }
}

/* ---------------------------------------------------------------------------
  对外：吊销（只許本人；幂等）
  --------------------------------------------------------------------------- */

/**
 * **吊销一枚金鑰**（只許本人；已吊销 ⇒ `ok:true` ＋ `already:true`，**行不新增、一字不改**）。
 * 判定顺序：① 载荷形态 → ② 读行 → ③ **行属本人**（不存在 / 非本人同判 `FORBIDDEN` ＋ 零写入）
 * → ④ 已吊销短路返回 → ⑤ 单文档条件更新（乐观锁）。
 * @param {{uid:string, key_id:string}} params
 * @returns {Promise<{ok:true, key_id:string, status:string, revoked_at:string, already:boolean}
 *          |{ok:false, reason:string, message:string}>}
 */
async function revokeAiKey(params) {
  const input = params && typeof params === 'object' ? params : {}
  const uid = text(input.uid)
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const keyId = text(input.key_id)
  if (!keyId) return deny(REASONS.MISSING_REQUIRED, '缺少金鑰標識（key_id）；本次零寫入。')
  const row = await readKeyRow(keyId)
  if (!row || text(row.uid) !== uid) {
    /* 【口径】不存在 / 非本人 ⇒ **同一 reason** ⇒ 不洩露該鍵是否存在（防枚举）。 */
    return deny(REASONS.FORBIDDEN, '僅金鑰本人可以吊銷該金鑰；本次零寫入。')
  }
  if (text(row.status) === KEY_STATUS.REVOKED) {
    return {
      ok: true,
      key_id: keyId,
      status: KEY_STATUS.REVOKED,
      revoked_at: text(row.revoked_at),
      already: true
    }
  }
  const at = nowIso()
  const store = resolveStore()
  const reply = await store.keys
    .where({ _id: row._id, status: KEY_STATUS.ACTIVE })
    .update({ status: KEY_STATUS.REVOKED, revoked_at: at, updated_at: at })
  const updated = updatedCountOf(reply)
  if (updated === 1) return { ok: true, key_id: keyId, status: KEY_STATUS.REVOKED, revoked_at: at, already: false }
  /* `0` ＝ 并发抢先（另一路已吊销）；`null` ＝ 计数读不出 ⇒ 重读按已吊销返回（行状态为唯一真相）。 */
  const raced = await readKeyRow(keyId)
  if (raced && text(raced.status) === KEY_STATUS.REVOKED) {
    return {
      ok: true,
      key_id: keyId,
      status: KEY_STATUS.REVOKED,
      revoked_at: text(raced.revoked_at),
      already: true
    }
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 金鑰吊銷未確認；請以同一金鑰標識重試（重試不會重複吊銷）。')
}

/* ---------------------------------------------------------------------------
  对外：限额改写（只許本人）
  --------------------------------------------------------------------------- */

/**
 * **改写一枚金鑰的日 / 分鐘限**（只許本人；**两个限额都必须给**，不静默取缺省）。
 * 判定顺序：① 载荷形态 → ② 读行 → ③ 行属本人（不存在 / 非本人 ⇒ `FORBIDDEN` ＋ 零写入）
 * → ④ 限额值域（缺字段 ⇒ `MISSING_REQUIRED`；越界 / 非整数 ⇒ `INVALID_VALUE`，零写入）
 * → ⑤ 单文档条件更新（乐观锁）。
 * @param {{uid:string, key_id:string, day_limit:number, minute_limit:number}} params
 * @returns {Promise<{ok:true, key_id:string, day_limit:number, minute_limit:number, updated_at:string}
 *          |{ok:false, reason:string, message:string}>}
 */
async function updateAiKeyLimits(params) {
  const input = params && typeof params === 'object' ? params : {}
  const uid = text(input.uid)
  if (!uid) return deny(REASONS.MISSING_REQUIRED, '缺少用戶標識（uid）；本次零寫入。')
  const keyId = text(input.key_id)
  if (!keyId) return deny(REASONS.MISSING_REQUIRED, '缺少金鑰標識（key_id）；本次零寫入。')
  const row = await readKeyRow(keyId)
  if (!row || text(row.uid) !== uid) {
    return deny(REASONS.FORBIDDEN, '僅金鑰本人可以修改該金鑰的限額；本次零寫入。')
  }
  if (input.day_limit === undefined || input.day_limit === null || input.minute_limit === undefined || input.minute_limit === null) {
    return deny(REASONS.MISSING_REQUIRED, '改寫限額必須同時給出 day_limit 與 minute_limit；本次零寫入。')
  }
  const day = limitOf(input.day_limit, { def: DAY_LIMIT_DEFAULT, min: DAY_LIMIT_MIN, max: DAY_LIMIT_MAX })
  if (!day.ok) {
    return deny(
      REASONS.INVALID_VALUE,
      `日限額（day_limit）必須是 ${DAY_LIMIT_MIN} 〜 ${DAY_LIMIT_MAX} 之間的整數；本次零寫入。`
    )
  }
  const minute = limitOf(input.minute_limit, { def: MINUTE_LIMIT_DEFAULT, min: MINUTE_LIMIT_MIN, max: MINUTE_LIMIT_MAX })
  if (!minute.ok) {
    return deny(
      REASONS.INVALID_VALUE,
      `分鐘限額（minute_limit）必須是 ${MINUTE_LIMIT_MIN} 〜 ${MINUTE_LIMIT_MAX} 之間的整數；本次零寫入。`
    )
  }
  const at = nowIso()
  const store = resolveStore()
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await readKeyRow(keyId)
    if (!current || text(current.uid) !== uid) {
      return deny(REASONS.FORBIDDEN, '僅金鑰本人可以修改該金鑰的限額；本次零寫入。')
    }
    const reply = await store.keys
      .where({ _id: current._id, day_limit: Number(current.day_limit), minute_limit: Number(current.minute_limit) })
      .update({ day_limit: day.value, minute_limit: minute.value, updated_at: at })
    const updated = updatedCountOf(reply)
    if (updated === 1) {
      return { ok: true, key_id: keyId, day_limit: day.value, minute_limit: minute.value, updated_at: at }
    }
    /* `0` ＝ 并发抢先；`null` ＝ 计数读不出 ⇒ 重读重试（锁在两个限额的旧值上）。 */
  }
  return deny(REASONS.STORAGE_UNAVAILABLE, 'AI 金鑰限額更新競爭超時；請重試本次操作。')
}

/* ---------------------------------------------------------------------------
  对外：服务端校验（中转面用；**不下发 hash / 前缀**）
  --------------------------------------------------------------------------- */

/**
 * **服务端校验一枚明文金鑰**（供中转面 `api/**` 用；**只读、零写入**）。
 * 归一：按 `sha256(key).hex` 前 16 位检索 ⇒ 命中且 `status === ACTIVE` ⇒ 回
 * `{ok:true, key_id, uid, day_limit, minute_limit}`；否则一律 **`KEY_INVALID`**（不存在 /
 * 已吊销 / 摘要不匹配**同一 reason** ⇒ 防枚举）。
 * @param {string} key 明文金鑰（`sk-xiai-…`）
 * @returns {Promise<{ok:true, key_id:string, uid:string, day_limit:number, minute_limit:number}
 *          |{ok:false, reason:string, message:string}>}
 */
async function resolveAiKey(key) {
  const plain = typeof key === 'string' ? key.trim() : ''
  if (!plain) return deny(REASONS.KEY_INVALID, 'AI 金鑰無效或已失效；請重新簽發後再試。')
  const store = resolveStore()
  const rows = rowsOf(await store.keys.where({ key_hash: hashKey(plain) }).get())
  const row = rows.find((item) => text(item && item.key_hash) === hashKey(plain)) || null
  if (!row || text(row.status) !== KEY_STATUS.ACTIVE) {
    return deny(REASONS.KEY_INVALID, 'AI 金鑰無效或已失效；請重新簽發後再試。')
  }
  return {
    ok: true,
    key_id: text(row.key_id),
    uid: text(row.uid),
    day_limit: Number(row.day_limit),
    minute_limit: Number(row.minute_limit)
  }
}

module.exports = {
  AI_KEYS_COLLECTION,
  KEY_ID_PREFIX,
  KEY_PLAIN_PREFIX,
  KEY_HEX_LENGTH,
  KEY_ID_HEX_LENGTH,
  KEY_HASH_LENGTH,
  KEY_PREFIX_LENGTH,
  KEY_STATUS,
  KEY_STATUS_VALUES,
  ACTIVE_KEY_LIMIT_PER_USER,
  LABEL_MAX_LENGTH,
  DAY_LIMIT_DEFAULT,
  DAY_LIMIT_MIN,
  DAY_LIMIT_MAX,
  MINUTE_LIMIT_DEFAULT,
  MINUTE_LIMIT_MIN,
  MINUTE_LIMIT_MAX,
  KEY_ROW_KEYS,
  KEY_LIST_PROJECTION_KEYS,
  CAS_MAX_ATTEMPTS,
  keyDocIdOf,
  hashKey,
  mintKey,
  mintKeyId,
  projectKeyRow,
  readKeyRow,
  readUserKeyRows,
  readActiveKeyRows,
  setAiKeyStoreProvider,
  aiKeyStoreInjected,
  issueAiKey,
  listAiKeys,
  revokeAiKey,
  updateAiKeyLimits,
  resolveAiKey
}
