/**
 * 玺爱 · 「我的雲盤」数据层（資料夾 / 引用行 / 分享行 / 邀请行 / 站点配置）
 *
 * 依据（规范 v1.22 §4.1.8 〜 §4.1.13 ＋ 增量件 §5.1 ②）：
 *   - 本文件**只新增四条集合的集合级读写 ＋ 一条配置键读写**，**沿用既有集合读写形态**（整集合
 *     读 / 整集合写，与 `db.js` 的 `readCollection` / `writeCollection` 同族）；
 *   - **一切读写只经 `data/storage.js`**（该文件是全工程唯一直接触碰 `localStorage` 的模块）；
 *   - **元数据进 `localStorage`、二进制仍进 IndexedDB**（本文件不碰二进制，一枚影像字节都不写）；
 *   - 新增 5 键的登记在 `storage.js` 的 `STORAGE_KEYS`（`seallists` / `seallist-items` /
 *     `shares` / `invites` / `invite-reward`），**既有 13 键一字未动**。
 *
 * 两道门（**R-49 / §3.15.11 / §3.12.10 的既冻结字面值，本文件不新增任何 reason**）：
 *   - **键面**：行内出现「不属于该实体」的键 ⇒ `INVALID_FIELD`（不得静默丢弃）；
 *   - **值域面**：键合法但值不在值域（编号形态 / 时间戳 / 金额 / 引用行唯一键 / 分享短码…）⇒ `INVALID_VALUE`；
 *   - **必填面**：该给的没给 ⇒ `MISSING_REQUIRED`；
 *   - **两道门一律在「任何写入之前」判定，整个调用零写入**（不得部分写入 —— 集合级写只落一次
 *     `writeKey`，判定全部前置 ⇒ 天然无中间态）。
 *
 * 读入口纪律（本单硬约束）：**一律不抛异常**；**不得以空值 / 空数组冒充成功** ——
 * 「缺键」（首次使用）与「已写入但 0 行」（空集）**必须可分辨**，两种都带可读文案返回；
 * 「集合名不存在」「存值型别不是行数组」「行不是物件」一律给**结构化可读拒绝**。
 */

import { STORAGE_KEYS, readKey, writeKey } from './storage.js'
/* 用户行的整集合写入口复用既有数据层实现（`db.js` 的 `saveUserRows` ⇒ 仍只经 `storage.js`）；
   本文件**不重写**用户行写口径，只在它前面加一道「邀请键」门（见本文件第 8 段）。 */
import { saveUserRows } from './db.js'

/* ============================================================================
   1. 四条集合 ＋ 一条配置键的登记面（键名一律取自 `storage.js` 的登记表，
      本文件**不复制键字面值** ⇒ 单一真源，不可能与登记表漂移）
   ============================================================================ */

/** 集合名 ⇒ 存储键（登记名 ⇒ 字面值，真源仍是 `storage.js`）。 */
const COLLECTION_KEYS = Object.freeze({
  seallists: STORAGE_KEYS.seallists,
  seallistItems: STORAGE_KEYS.seallistItems,
  shares: STORAGE_KEYS.shares,
  invites: STORAGE_KEYS.invites
})

/** 站點配置键（可改数值的落点；§4.1.12）。 */
export const DRIVE_SETTING_KEY = STORAGE_KEYS.inviteReward

/** 資料夾编号形态（§4.1.8：`SL` 大写 ASCII ＋ 恰 9 位零填充）。 */
const SEALLIST_CODE_PATTERN = /^SL\d{9}$/

/** 分享短碼形态（§4.1.10：恰 8 位小写 ASCII 字母或数字）。 */
const SHARE_CODE_PATTERN = /^[0-9a-z]{8}$/

/** 配置键的值形态（§4.1.12：`{ invite_reward: <number> }`）。 */
export const INVITE_REWARD_FIELDS = Object.freeze(['invite_reward'])

/* ============================================================================
   2. 每张表的字段面（字段清单 ＝ §4.1.8 〜 §4.1.11 的表内字段，**逐字**）
      - `fields` ＝ 该实体**真正会写的键**（白名单；能收下却不写的键不得留在白名单里）；
      - `required` ＝ 必有键；
      - `label` ＝ 出错文案里的中文名。
   ============================================================================ */

const TABLE_SPECS = Object.freeze({
  seallists: {
    key: COLLECTION_KEYS.seallists,
    label: '資料夾行',
    fields: ['id', 'code', 'owner_user_id', 'name', 'created_at', 'updated_at'],
    required: ['id', 'code', 'owner_user_id', 'name', 'created_at', 'updated_at']
  },
  seallistItems: {
    key: COLLECTION_KEYS.seallistItems,
    label: '資料夾引用行',
    fields: ['id', 'seallist_id', 'seal_id', 'added_at'],
    required: ['id', 'seallist_id', 'seal_id', 'added_at']
  },
  shares: {
    key: COLLECTION_KEYS.shares,
    label: '分享連結行',
    fields: ['id', 'seallist_id', 'code', 'owner_user_id', 'created_at', 'expires_at', 'revoked_at'],
    required: ['id', 'seallist_id', 'code', 'owner_user_id', 'created_at', 'expires_at', 'revoked_at']
  },
  invites: {
    key: COLLECTION_KEYS.invites,
    label: '邀請行',
    fields: ['id', 'inviter_user_id', 'invitee_user_id', 'reward', 'created_at', 'settled_at'],
    required: ['id', 'inviter_user_id', 'invitee_user_id', 'reward', 'created_at', 'settled_at']
  }
})

/* ============================================================================
   3. 判定小工具（一律纯函数、不触碰存储）
   ============================================================================ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFilledText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** ISO 字符串判定（可解析为时间戳 ⇒ 算合规；「看着像」不算）。 */
function isTimestampText(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

function isNullableTimestamp(value) {
  return value === null || isTimestampText(value)
}

function missing(reasonLabel, key) {
  return {
    ok: false,
    reason: 'MISSING_REQUIRED',
    message: `${reasonLabel}缺少必有鍵「${key}」；本次未寫入任何一行。`
  }
}

function badValue(reasonLabel, detail) {
  return {
    ok: false,
    reason: 'INVALID_VALUE',
    message: `${reasonLabel}${detail}；本次未寫入任何一行。`
  }
}

/* ============================================================================
   4. 逐表值域（写入口的「值域面」门；判定时点一律早于任何写入）
   ============================================================================ */

/**
 * 单行值域判定。
 * @returns {null|{ok:false, reason:string, message:string}} 合规 ⇒ `null`（放行）
 */
function rowValueDenial(name, row, index) {
  const spec = TABLE_SPECS[name]
  const at = `第 ${index + 1} 行`

  if (name === 'seallists') {
    if (!SEALLIST_CODE_PATTERN.test(row.code)) {
      return badValue(`${spec.label}（${at}）`, `的編號「${row.code}」不匹配 /^SL\\d{9}$/（SL 大寫 ＋ 恰 9 位零填充）`)
    }
    if (!isFilledText(row.name)) return badValue(`${spec.label}（${at}）`, '的名稱去首尾空白後為空')
    if (!isTimestampText(row.created_at) || !isTimestampText(row.updated_at)) {
      return badValue(`${spec.label}（${at}）`, '的時間戳不是可解析的 ISO 字串')
    }
    return null
  }

  if (name === 'seallistItems') {
    if (!isFilledText(row.seallist_id) || !isFilledText(row.seal_id)) {
      return badValue(`${spec.label}（${at}）`, '的資料夾標識或印章標識為空（引用式要求兩者都必有）')
    }
    if (!isTimestampText(row.added_at)) return badValue(`${spec.label}（${at}）`, '的加入時間不是可解析的 ISO 字串')
    return null
  }

  if (name === 'shares') {
    if (!SHARE_CODE_PATTERN.test(row.code)) {
      return badValue(`${spec.label}（${at}）`, `的短碼「${row.code}」不匹配 /^[0-9a-z]{8}$/（恰 8 位小寫 ASCII）`)
    }
    if (!isTimestampText(row.created_at) || !isTimestampText(row.expires_at)) {
      return badValue(`${spec.label}（${at}）`, '的生成時間或到期時間不是可解析的 ISO 字串')
    }
    if (!isNullableTimestamp(row.revoked_at)) {
      return badValue(`${spec.label}（${at}）`, '的作廢時間既不是 ISO 字串也不是 null')
    }
    return null
  }

  /* invites */
  if (!isFilledText(row.inviter_user_id)) return badValue(`${spec.label}（${at}）`, '缺邀請人標識')
  if (row.invitee_user_id !== null && !isFilledText(row.invitee_user_id)) {
    return badValue(`${spec.label}（${at}）`, '的被邀請人標識既不是用戶標識也不是 null')
  }
  if (!Number.isInteger(row.reward) || row.reward < 0) {
    return badValue(`${spec.label}（${at}）`, '的發放金額不是非負整數')
  }
  if (!isTimestampText(row.created_at)) return badValue(`${spec.label}（${at}）`, '的建立時間不是可解析的 ISO 字串')
  if (!isNullableTimestamp(row.settled_at)) {
    return badValue(`${spec.label}（${at}）`, '的結算時間既不是 ISO 字串也不是 null')
  }
  return null
}

/**
 * 全表判定（键面 ＋ 必填面 ＋ 值域面 ＋ 唯一键面），**全部前置** ⇒ 拒绝时零写入。
 * @returns {null|{ok:false, reason:string, message:string}} 合规 ⇒ `null`（放行）
 */
function tableDenial(name, rows) {
  const spec = TABLE_SPECS[name]
  const seenIds = new Set()
  const seenPairs = new Set()
  const seenCodes = new Set()
  const activeSharesByList = new Map()
  const settledPairs = new Set()

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!isPlainObject(row)) return badValue(`${spec.label}（第 ${index + 1} 行）`, '不是物件（行形態應是普通物件）')

    const unknown = Object.keys(row).filter((key) => !spec.fields.includes(key))
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: 'INVALID_FIELD',
        message: `${spec.label}之外的欄位不可通過此入口寫入：${unknown.join('、')}；本次未寫入任何一行。`
      }
    }
    const absent = spec.required.filter((key) => !Object.prototype.hasOwnProperty.call(row, key))
    if (absent.length > 0) return missing(spec.label, absent[0])

    const denial = rowValueDenial(name, row, index)
    if (denial) return denial

    if (seenIds.has(row.id)) return badValue(spec.label, `的行主鍵「${row.id}」重複（行主鍵須唯一）`)
    seenIds.add(row.id)

    if (name === 'seallists' && seenCodes.has(row.code)) {
      return badValue(spec.label, `的編號「${row.code}」重複（編號須全局唯一）`)
    }
    if (name === 'seallists') seenCodes.add(row.code)

    if (name === 'seallistItems') {
      const pair = `${row.seallist_id}\u0000${row.seal_id}`
      if (seenPairs.has(pair)) {
        return badValue(spec.label, `出現重複的（資料夾, 印章）組合「${row.seallist_id} / ${row.seal_id}」（同一夾同一印章恰 1 行）`)
      }
      seenPairs.add(pair)
    }

    if (name === 'shares') {
      if (seenCodes.has(row.code)) return badValue(spec.label, `的短碼「${row.code}」重複（短碼須全局唯一）`)
      seenCodes.add(row.code)
      if (row.revoked_at === null) {
        const count = (activeSharesByList.get(row.seallist_id) || 0) + 1
        activeSharesByList.set(row.seallist_id, count)
        if (count > 1) {
          return badValue(spec.label, `使資料夾「${row.seallist_id}」同時出現兩條未作廢的分享行（同一資料夾任一時刻恰 ≤ 1 條有效分享）`)
        }
      }
    }

    if (name === 'invites' && row.invitee_user_id !== null && row.settled_at !== null) {
      const pair = `${row.inviter_user_id}\u0000${row.invitee_user_id}`
      if (settledPairs.has(pair)) {
        return badValue(spec.label, `使同一邀請關係「${row.inviter_user_id} → ${row.invitee_user_id}」出現兩條已結算行（同一關係只結算一次）`)
      }
      settledPairs.add(pair)
    }
  }
  return null
}

/* ============================================================================
   5. 集合级读入口（**不抛异常**；缺键 / 空集 / 型别不符三态可分辨）
   ============================================================================ */

/**
 * 集合级读。
 * @param {'seallists'|'seallistItems'|'shares'|'invites'} collection
 * @returns {{ok:true, collection:string, key:string, rows:Array<object>, count:number,
 *            present:boolean, empty:boolean, message:string}
 *          |{ok:false, reason:string, message:string}}
 */
export function readDriveRows(collection) {
  const spec = TABLE_SPECS[collection]
  if (!spec) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `沒有名爲「${collection}」的集合；本單登記的集合只有：${Object.keys(TABLE_SPECS).join('、')}。`
    }
  }

  let raw = null
  try {
    raw = readKey(spec.key)
  } catch (error) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `讀取本地存儲失敗（${spec.label}／鍵 ${spec.key}）：${error && error.message ? error.message : '未知錯誤'}。`
    }
  }

  if (raw === null || raw === undefined) {
    return {
      ok: true,
      collection,
      key: spec.key,
      rows: [],
      count: 0,
      present: false,
      empty: true,
      message: `${spec.label}的存儲鍵尚未寫入（首次使用）⇒ 本次讀回 0 行；這不是「已寫入的空集」。`
    }
  }

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `${spec.label}的存儲鍵值不是行陣列（型別不符，實測爲 ${typeof raw}）⇒ 拒絕按空集處理。`
    }
  }

  const bad = raw.findIndex((row) => !isPlainObject(row))
  if (bad >= 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `${spec.label}的第 ${bad + 1} 行不是物件（型別不符）⇒ 拒絕按空集處理。`
    }
  }
  const unknownAt = raw.findIndex((row) => Object.keys(row).some((key) => !spec.fields.includes(key)))
  if (unknownAt >= 0) {
    const keys = Object.keys(raw[unknownAt]).filter((key) => !spec.fields.includes(key))
    return {
      ok: false,
      reason: 'INVALID_FIELD',
      message: `${spec.label}的第 ${unknownAt + 1} 行含本實體之外的欄位：${keys.join('、')}（如實報回，不靜默丟鍵）。`
    }
  }

  return {
    ok: true,
    collection,
    key: spec.key,
    rows: raw,
    count: raw.length,
    present: true,
    empty: raw.length === 0,
    message: raw.length === 0 ? `${spec.label}已寫入，目前 0 行。` : `${spec.label}共 ${raw.length} 行。`
  }
}

/* ============================================================================
   6. 集合级写入口（两道门前置 ＋ 零写入 ＋ 不得静默丢键）
   ============================================================================ */

/**
 * 集合级写（**整集合覆盖写**，与既有集合读写形态同族）。
 * @param {'seallists'|'seallistItems'|'shares'|'invites'} collection
 * @param {Array<object>} rows 目标行集合（＝写入后的完整状态）
 * @returns {{ok:true, collection:string, key:string, rows:Array<object>, count:number}
 *          |{ok:false, reason:string, message:string}}
 */
export function writeDriveRows(collection, rows) {
  const spec = TABLE_SPECS[collection]
  if (!spec) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `沒有名爲「${collection}」的集合；本單登記的集合只有：${Object.keys(TABLE_SPECS).join('、')}。`
    }
  }
  if (!Array.isArray(rows)) {
    return badValue(`${spec.label}的寫入載荷`, '不是行陣列（整集合寫要求給出完整的行陣列）')
  }

  const denial = tableDenial(collection, rows)
  if (denial) return denial

  let written = false
  try {
    written = writeKey(spec.key, rows) === true
  } catch (error) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `寫入本地存儲失敗（${spec.label}／鍵 ${spec.key}）：${error && error.message ? error.message : '未知錯誤'}；整集合鍵單次覆蓋 ⇒ 未留部分寫入。`
    }
  }
  if (!written) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `寫入本地存儲失敗（${spec.label}／鍵 ${spec.key}）：存儲不可用（含配額不足）；整集合鍵單次覆蓋 ⇒ 未留部分寫入。`
    }
  }
  return { ok: true, collection, key: spec.key, rows, count: rows.length }
}

/** 資料夾行读（转口，同一实现）。 */
export function readSeallists() {
  return readDriveRows('seallists')
}

/** 資料夾行写（转口，同一实现）。 */
export function writeSeallistRows(rows) {
  return writeDriveRows('seallists', rows)
}

/** 資料夾引用行读。 */
export function readSeallistItems() {
  return readDriveRows('seallistItems')
}

/** 資料夾引用行写。 */
export function writeSeallistItemRows(rows) {
  return writeDriveRows('seallistItems', rows)
}

/** 分享行读。 */
export function readShares() {
  return readDriveRows('shares')
}

/** 分享行写。 */
export function writeShareRows(rows) {
  return writeDriveRows('shares', rows)
}

/** 邀请行读。 */
export function readInvites() {
  return readDriveRows('invites')
}

/** 邀请行写。 */
export function writeInviteRows(rows) {
  return writeDriveRows('invites', rows)
}

/* ============================================================================
   7. 站點配置键（§4.1.12）：读（不抛）＋ 写（非负整数门）
   ============================================================================ */

/**
 * 读站點配置键（`invite-reward`）。
 * 「尚未写入」与「值型别不对」**必须可分辨** ⇒ 分别给 `present:false` 与结构化拒绝。
 * @returns {{ok:true, present:boolean, value:number|null, message:string}
 *          |{ok:false, reason:string, message:string}}
 */
export function readInviteRewardSetting() {
  let raw = null
  try {
    raw = readKey(DRIVE_SETTING_KEY)
  } catch (error) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `讀取站點配置鍵（${DRIVE_SETTING_KEY}）失敗：${error && error.message ? error.message : '未知錯誤'}。`
    }
  }

  if (raw === null || raw === undefined) {
    return {
      ok: true,
      present: false,
      value: null,
      message: `站點配置鍵（${DRIVE_SETTING_KEY}）尚未寫入 ⇒ 目前沒有可改值，結算按規範 §5.1 的預設值。`
    }
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `站點配置鍵（${DRIVE_SETTING_KEY}）的值應爲物件 {invite_reward:<number>}，實測爲 ${typeof raw} ⇒ 讀取失敗（不猜、不回落）。`
    }
  }
  const unknown = Object.keys(raw).filter((key) => !INVITE_REWARD_FIELDS.includes(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: 'INVALID_FIELD',
      message: `站點配置鍵（${DRIVE_SETTING_KEY}）含未知欄位：${unknown.join('、')}（如實報回，不靜默丟鍵）。`
    }
  }
  const value = raw.invite_reward
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `站點配置鍵（${DRIVE_SETTING_KEY}）的 invite_reward 不是非負整數（實測 ${JSON.stringify(value)}）⇒ 讀取失敗（不猜、不回落）。`
    }
  }
  return { ok: true, present: true, value, message: `站點配置鍵（${DRIVE_SETTING_KEY}）現行值 ＝ ${value}。` }
}

/**
 * 写站點配置键（§4.1.12 ③：非整数 / 负数 ⇒ `INVALID_VALUE` ＋ 零写入）。
 * 本入口**只管值域面**；「谁有权写」（管理员门）在服务层（`services/admin.js`）判定，
 * 两道判定都必须早于任何写入。
 * @returns {{ok:true, key:string, value:number}|{ok:false, reason:string, message:string}}
 */
export function writeInviteRewardSetting(value) {
  if (!Number.isInteger(value) || value < 0) {
    return badValue('邀請獎勵數值', `「${JSON.stringify(value)}」不是非負整數（非整數 / 負數 / 非數字一律拒收）`)
  }
  let written = false
  try {
    written = writeKey(DRIVE_SETTING_KEY, { invite_reward: value }) === true
  } catch (error) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `寫入站點配置鍵（${DRIVE_SETTING_KEY}）失敗：${error && error.message ? error.message : '未知錯誤'}；本次零寫入。`
    }
  }
  if (!written) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `寫入站點配置鍵（${DRIVE_SETTING_KEY}）失敗：存儲不可用；本次零寫入。`
    }
  }
  return { ok: true, key: DRIVE_SETTING_KEY, value }
}

/* ============================================================================
   8. 用户行的「邀请键」门（§4.1.11 表下注 ①：邀请关系**只落 `invites` 行**）
   ----------------------------------------------------------------------------
   规范明文：`users` 行**不得新增邀请相关键**（如 `invited_by` / `invite_code` /
   `invited_count`）—— 新增 ⇒ `INVALID_FIELD` ＋ 零写入（沿用 §3.15.11 的键面门）。
   本段即该门的数据层落点：**凡邀请面要写用户行，一律走本段的守卫**（判定早于任何写入）。
   ============================================================================ */

/** `users` 行上**不得出现**的邀请相关键（规范点名的三个 ＋ 同族键名）。 */
export const INVITE_RELATION_USER_FIELDS = Object.freeze([
  'invited_by',
  'invite_code',
  'invited_count',
  'inviter_user_id',
  'invitee_user_id',
  'invite_reward',
  'invite',
  'invites'
])

/**
 * 用户行「邀请键」判定（键面门）。
 * @param {Array<object>} rows 目标用户行集合
 * @returns {null|{ok:false, reason:'INVALID_FIELD', message:string}} 合规 ⇒ `null`（放行）
 */
export function userRowsInviteDenial(rows) {
  const list = Array.isArray(rows) ? rows : []
  for (let index = 0; index < list.length; index += 1) {
    const row = list[index]
    if (!isPlainObject(row)) continue
    const hit = INVITE_RELATION_USER_FIELDS.filter((key) =>
      Object.prototype.hasOwnProperty.call(row, key)
    )
    if (hit.length > 0) {
      return {
        ok: false,
        reason: 'INVALID_FIELD',
        message: `邀請關係只落 invites 行：用戶行（${row.id || `第 ${index + 1} 行`}）不得出現邀請相關鍵 ${hit.join('、')}；本次零寫入。`
      }
    }
  }
  return null
}

/**
 * **邀请面唯一允许的用户行写入口**：先过「邀请键」门（拒绝 ⇒ `INVALID_FIELD` ＋ 零写入），
 * 再整集合写回。余额变更与流水写入仍由调用方保证一致（本入口只负责用户行）。
 * @param {Array<object>} rows 写入后的完整用户行集合
 * @returns {{ok:true, rows:Array<object>, count:number}|{ok:false, reason:string, message:string}}
 */
export function writeUserRowsGuarded(rows) {
  if (!Array.isArray(rows)) {
    return badValue('用戶行寫入載荷', '不是行陣列（整集合寫要求給出完整的行陣列）')
  }
  const denial = userRowsInviteDenial(rows)
  if (denial) return denial
  try {
    saveUserRows(rows)
  } catch (error) {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: `寫入用戶行失敗：${error && error.message ? error.message : '未知錯誤'}。`
    }
  }
  return { ok: true, rows, count: rows.length }
}
