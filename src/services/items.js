/**
 * 玺爱 · **印谱（item）服务** —— 外部批量導入通道 ＋ 管理员采纳 / 驳回（item 通道切片 A｜v1.61）
 * ============================================================================
 * 归属 ＝ **玺爱 canonical**。三段式（X2）：
 *   · **提交** ＝ `submitItemImport`（任何登录用户）⇒ 经登录令牌写面门
 *     `userWriteGate('submitItemImport', …)` 落 `xiai_item_imports` 的 `PENDING` 行；
 *   · **暂存** ＝ 导入行三态 `PENDING`（单写者集合；**不开放任何直写入口，含管理员直写**）；
 *   · **审核** ＝ `reviewItemImport`（管理员；登錄令牌 ＋ 手機號白名單，沿既有通道）——
 *     `ACCEPTED` ⇒ **幂等**落 `xiai_items`（按 `source_item_id` 幂等；**重复采纳不改写既有行**）；
 *     `REJECTED` ⇒ **零写入**（仅导入行状态）。三态单向、**终态不回退**。
 *
 * 幂等键（X3）＝ `source_item_id`（**原样字符串**）；重复提交 / 重复采纳 ⇒ **不改写既有行**。
 * 本体 22 字段（X4）落 `xiai_items`；**`raw_json` 只存导入行**（正式集合不带）。
 * 繁简（X5）：**繁体为正**（`title` / `title_other` / `abstract`），简体入 `*_chs`（**落库不做上屏逻辑**）。
 * 值域 / 形态门（X6）：`volume_count` / `date_year` **整数或 `null`**（不得 `0` / 空串等特值）；
 * `has_image` / `has_annotation` **布尔或 `null`**（`null` ＝ 源側未知 ⇒ 放行、不改写）；`date_text` 的源侧占位 `'N.D.'` **归一为 `null`**；
 * 载荷形态违规 ⇒ `INVALID_VALUE` ＋ **零写入**（`reason` **零新增**）。
 * 读面（X7）：云读取面已配置但**未落定 / 读取失败**时**零行不再冒充事实空集** ⇒
 * 显式可读降级（`ok:false` ＋ `message`）；`off` **不降级**；有本机行照常返回。
 *
 * 写面门与 `persons` / `seals` / `corrections` **同一通道**（`userWriteGate`）。云端命中：
 * `submitItemImport` ∈ `xiai-user-token` 的 `OPS`；`reviewItemImport` ∈ 同函数 `ADMIN_OPS`
 * （登录令牌 ＋ 手机号白名单）。两 `index.js` 皆为 `hasOwnProperty` 动态派发 ⇒ **未动云函数 index**。
 * · **未覆盖（如实登记）**：`xiai_items` / `xiai_item_imports` 尚待人工新建（云控制台动作）⇒
 *   **云端落库路径不可达**；故云端形态端到端**当前不可验**。本机（dev / 離線）形态可验。
 * ============================================================================
 */

import { currentUser } from '../data/session.js'
import {
  listItemRows,
  saveItemRows,
  listItemImportRows,
  saveItemImportRows,
  itemBySourceId,
  itemImportBySourceId,
  itemDirectWriteDenial
} from '../data/db.js'
import {
  ITEM_IMPORT_STATUS,
  ITEM_IMPORT_ID_PREFIX,
  ITEM_BODY_FIELDS,
  ITEM_MISC_FIELDS,
  ITEM_BODY_INT_FIELDS,
  ITEM_BODY_BOOL_FIELDS,
  ITEM_DATE_PLACEHOLDER,
  emptyItemMisc
} from '../data/seed.js'
/* **登錄令牌寫面門（同一通道）**：與 `corrections` / `persons` / `seals` 的寫 op 一律經
   `userWriteGate`；身份由服務端從令牌派生，载荷里的身份类键由服务端拒。 */
import { userWriteGate } from './userWrite.js'
import { cloudBaseConfigured, cloudBaseStatus } from '../data/cloudbase.js'

/** 导入行三态（转发真源 `seed.js::ITEM_IMPORT_STATUS`；单向、终态不回退）。 */
export const ITEM_IMPORT_STATUS_EXPORT = ITEM_IMPORT_STATUS

/** 导入单号 / 幂等键上限（服务层本地护栏；与既有导入通道同规格）。 */
export const MAX_ITEM_IMPORT_ID_LENGTH = 128

/** 驳回理由上限（与勘误 / 印人导入 / 印章导入同值 200 字）。 */
export const MAX_ITEM_REVIEW_NOTE_LENGTH = 200

function nowIso() {
  return new Date().toISOString()
}

function makeItemImportId() {
  return `${ITEM_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 文本归一（缺值 ⇒ 空串；自由文本**不 trim** —— 值逐字保留）。 */
function importText(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** 导入状态归一（旧 / 缺值 ⇒ `PENDING`）。 */
export function normalizeItemImportStatus(status) {
  const text = String(status || '').trim()
  if (text === ITEM_IMPORT_STATUS.ACCEPTED || text === ITEM_IMPORT_STATUS.REJECTED) return text
  return ITEM_IMPORT_STATUS.PENDING
}

/** 审核决定归一：`ACCEPTED` / `REJECTED` 之外 ⇒ `''`（非法，调用方结构化拒绝）。 */
function normalizeItemDecision(decision) {
  const text = String(decision === null || decision === undefined ? '' : decision).trim()
  return text === ITEM_IMPORT_STATUS.ACCEPTED || text === ITEM_IMPORT_STATUS.REJECTED ? text : ''
}

/** 当前（或指定）账号是否可审核印谱外部导入批次 —— 供管理面渲染采纳 / 驳回。 */
export function canReviewItemImports(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/** 当前（或指定）账号是否可提交印谱外部导入行（任何登录用户）。 */
export function canSubmitItemImport(actor) {
  return (actor || currentUser()) !== null
}

/* ------------------------------ 值域 / 形态门（X6） ------------------------------ */

/**
 * **整数或 `null`**（**不得 `0` / 空串 / 非整数 / 布尔**）—— 纯函数，返回 `{ok, value}`。
 * 口径（X6 逐字）：`volume_count` / `date_year` 為**整數或 `null`**；`0` 與空串等特值一律违规。
 * @returns {{ok:true, value:number|null}|{ok:false}}
 */
export function strictIntOrNull(value) {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value === 'boolean') return { ok: false }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value === 0) return { ok: false }
    return { ok: true, value }
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || !/^-?\d+$/.test(text)) return { ok: false }
    const parsed = Number(text)
    if (!Number.isInteger(parsed) || parsed === 0) return { ok: false }
    return { ok: true, value: parsed }
  }
  return { ok: false }
}

/** 本体文本字段归一：**逐字保留**（缺值 ⇒ `null`）；`date_text` 的源侧占位 `'N.D.'` ⇒ `null`。 */
export function itemBodyTextOrNull(key, value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (key === 'date_text' && text.trim() === ITEM_DATE_PLACEHOLDER) return null
  return text
}

/** `misc` 子对象归一（5 键；缺键 ⇒ `null`；非对象 ⇒ 空面）。 */
export function normalizeItemMisc(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = emptyItemMisc()
  ITEM_MISC_FIELDS.forEach((key) => {
    out[key] = src[key] === undefined ? null : src[key]
  })
  return out
}

/**
 * **值域 / 形态门（X6；判定恒在写之前）**：放行 ⇒ `null`；违规 ⇒ 结构化拒绝 `{ok:false, reason:'INVALID_VALUE', …}`。
 * 覆盖：`volume_count` / `date_year` 整数或 `null`（不得 `0` / 空串等特值）；
 * `has_image` / `has_annotation` 在场时必须为**布尔或 `null`**（`null` ＝ 源側未知 ⇒ 放行；缺键 ⇒ 走默认 `false`，不因缺键拒收）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}}
 */
export function itemPayloadValueDenial(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  for (const key of ITEM_BODY_INT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (!strictIntOrNull(src[key]).ok) {
      return {
        ok: false,
        reason: 'INVALID_VALUE',
        message: `${key} 必須是整數或 null（不得 0 / 空串等特值）；本次零寫入。`
      }
    }
  }
  for (const key of ITEM_BODY_BOOL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    if (src[key] !== null && typeof src[key] !== 'boolean') {
      return {
        ok: false,
        reason: 'INVALID_VALUE',
        message: `${key} 必須是布爾（true / false）或 null（源側未知）；本次零寫入。`
      }
    }
  }
  return null
}

/** 本体 22 字段归一（**须先过值域 / 形态门**；返回的恰是 `ITEM_BODY_FIELDS` 面）。 */
export function normalizeItemBody(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  ITEM_BODY_FIELDS.forEach((key) => {
    if (key === 'source_item_id') {
      out[key] = importText(src[key])
      return
    }
    if (key === 'misc') {
      out[key] = normalizeItemMisc(src[key])
      return
    }
    if (ITEM_BODY_INT_FIELDS.includes(key)) {
      const parsed = strictIntOrNull(src[key])
      out[key] = parsed.ok ? parsed.value : null
      return
    }
    if (ITEM_BODY_BOOL_FIELDS.includes(key)) {
      /* **布爾或 `null`**（`null` ＝ 源側未知 ⇒ 原樣保留，不落 `false`、不歸一成布爾；缺鍵 ⇒ 默認 `false`）。 */
      out[key] = src[key] === null ? null : src[key] === true
      return
    }
    out[key] = itemBodyTextOrNull(key, src[key])
  })
  return out
}

/** 导入行 → 正式 `xiai_items` 行（**恰 22 字段**；无 `raw_json`、无身份 / 时间戳 —— 沿 X4）。 */
export function buildItemRowFromImport(importRow) {
  const src = importRow && typeof importRow === 'object' ? importRow : {}
  const out = {}
  ITEM_BODY_FIELDS.forEach((key) => {
    if (key === 'source_item_id') {
      out[key] = importText(src.source_item_id)
      return
    }
    if (key === 'misc') {
      out[key] = normalizeItemMisc(src.misc)
      return
    }
    if (ITEM_BODY_INT_FIELDS.includes(key)) {
      const parsed = strictIntOrNull(src[key])
      out[key] = parsed.ok ? parsed.value : null
      return
    }
    if (ITEM_BODY_BOOL_FIELDS.includes(key)) {
      /* **布爾或 `null`**（`null` ＝ 源側未知 ⇒ 原樣保留，不落 `false`、不歸一成布爾；缺鍵 ⇒ 默認 `false`）。 */
      out[key] = src[key] === null ? null : src[key] === true
      return
    }
    out[key] = itemBodyTextOrNull(key, src[key])
  })
  return out
}

/* ------------------------------ 導入：提交（外部通道） ------------------------------ */

/**
 * **提交印谱外部導入行**（外部批量導入通道；任何登录用户）。
 *
 * 判定顺序（**全部在写之前**，拒绝即零写入）：① 登录门 → ② 批次 / 幂等键（`source_item_id`）形态 →
 * ③ **值域 / 形态门（X6）** → ④ **幂等**（同 `source_item_id` 已有行 ⇒ 原样返回、**不改写既有行**）→
 * ⑤ **寫面門**（`userWriteGate('submitItemImport', …)`）。
 * @param {{batchId?:string, source?:string, sourceItemId?:string, payload?:object, rawJson?:*}} [options]
 * @returns {Promise<{ok:true, row:object, authority:string, idempotent?:boolean, message:string}|{ok:false, reason?:string, message:string}>}
 */
export async function submitItemImport({
  batchId = '',
  source = '',
  sourceItemId = '',
  payload = {},
  rawJson = null
} = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交印谱外部導入行' }

  const batch = String(batchId || '').trim()
  if (batch.length > MAX_ITEM_IMPORT_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `導入批次號超出上限（${MAX_ITEM_IMPORT_ID_LENGTH} 字）；本次零寫入。` }
  }
  const src = String(source || '').trim()
  const payloadObj = payload && typeof payload === 'object' ? payload : {}
  const sourceId = String(sourceItemId || payloadObj.source_item_id || '').trim()
  if (!sourceId) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少外部冪等鍵（source_item_id）⇒ 拒絕導入；本次零寫入。' }
  }
  if (sourceId.length > MAX_ITEM_IMPORT_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `外部冪等鍵超出上限（${MAX_ITEM_IMPORT_ID_LENGTH} 字）；本次零寫入。` }
  }

  /* ③ **值域 / 形态门（X6）**：任一违规 ⇒ `INVALID_VALUE` ＋ 零写入。 */
  const denial = itemPayloadValueDenial(payloadObj)
  if (denial) return denial

  const body = normalizeItemBody({ ...payloadObj, source_item_id: sourceId })
  const sourceRaw = rawJson !== null && rawJson !== undefined ? rawJson : (payloadObj.raw_json === undefined ? null : payloadObj.raw_json)

  /* ④ **幂等**：同 `source_item_id` 已有導入行 ⇒ 原樣返回（不改寫既有行）。 */
  const existing = itemImportBySourceId(sourceId)
  if (existing) {
    return {
      ok: true,
      row: existing,
      authority: 'LOCAL_IDEMPOTENT',
      idempotent: true,
      message: '該外部冪等鍵（source_item_id）已存在導入行 ⇒ 未改寫（冪等）。'
    }
  }

  const writePayload = { batch_id: batch, source: src, raw_json: sourceRaw, ...body }
  const gate = await userWriteGate('submitItemImport', writePayload)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    const at = nowIso()
    const row = {
      id: makeItemImportId(),
      batch_id: batch,
      source: src,
      source_item_id: sourceId,
      status: ITEM_IMPORT_STATUS.PENDING,
      ...body,
      raw_json: sourceRaw,
      imported_by: user.id, // **不透明 uid；零手机号**
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    saveItemImportRows([...listItemImportRows(), row])
    return { ok: true, row, authority: 'LOCAL_DEV', message: '已提交印谱外部導入行，待管理員審覈（dev / 離線形態，非正式寫入路徑）' }
  }

  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。' }
  }
  saveItemImportRows([...listItemImportRows(), serverRow])
  return { ok: true, row: serverRow, authority: 'SERVER', docId: gate.docId, message: '已提交印谱外部導入行，待管理員審覈' }
}

/* ------------------------------ 導入：读面（管理员） ------------------------------ */

/**
 * **纯函数：导入读面的可读降级文案**（未配置 / 正常 ⇒ `''`）。
 * 判据收口在数据层（**不自立第二份判据**）：调用方把 `cloudBaseConfigured()` / `cloudBaseStatus()`
 * 传进来即可；`off` **不降级**（X7 明文）。
 * @param {boolean} configured 云读取面是否已配置
 * @param {{state?:string, message?:string}} status 数据源状态读数
 * @returns {string}
 */
export function itemImportDegradedMessageOf(configured, status) {
  if (!configured) return ''
  const s = status || {}
  if (s.state === 'pending') return '雲端資料載入中，待審印谱導入批次稍後自動出現；請稍候再試。'
  if (s.state === 'failed') {
    return `雲端資料讀取失敗（${s.message || '未知原因'}），暫時無法列出全部待審印谱導入批次；請稍後重試。`
  }
  return ''
}

/**
 * **纯函数：待审读面的结论**（可单测的判定核；`listPendingItemImportsForAdmin` 的真实分支）。
 * **不静默显示 0**：已配置 ∧（`pending` / `failed`）∧ **零行** ⇒ `{ok:false, reason, message}`；
 * 有任何本机行 ⇒ 照常 `{ok:true, rows}`；`off` ⇒ `{ok:true, rows}`（不降级）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 */
export function itemPendingReadVerdict(rows, configured, status) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) {
    const degraded = itemImportDegradedMessageOf(configured, status)
    if (degraded) return { ok: false, reason: (status && status.reason) || '', message: degraded }
  }
  return { ok: true, rows: list }
}

/**
 * **管理员可见的待审印谱外部导入行**（全部用户的 `PENDING`）。
 * 非管理员 ⇒ **结构化拒绝**（`FORBIDDEN`；不以空集冒充拒绝）。
 * **不静默显示 0**（X7，照搬 `listPendingPersonImportsForAdmin` 写法）：云读取面已配置但
 * **未落定 / 读取失败**时，**零行**不再是事实空集 ⇒ 显式回可读降级文案（`ok:false` ＋ `message`）；
 * 有任何本机镜像行可列时**照常返回**；`off` **不降级**。`reason` **不新增字面值**。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 */
export function listPendingItemImportsForAdmin(actor) {
  const who = actor || currentUser()
  if (!canReviewItemImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的印谱外部導入批次' }
  }
  const rows = listItemImportRows()
    .filter((row) => normalizeItemImportStatus(row && row.status) === ITEM_IMPORT_STATUS.PENDING)
    .sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)))
  return itemPendingReadVerdict(rows, cloudBaseConfigured(), cloudBaseStatus())
}

/* ------------------------------ 導入：采纳 / 驳回（管理员） ------------------------------ */

/**
 * **本地采纳 / 驳回判定（不经写面门）**：供 `reviewItemImport` 过门后回写本机镜像 /
 * 在 dev·離線 形态作**本地权威**。
 * 采纳粒度：按批次（`batchId`）或按单行（`importId`）二选一（**两个入口都实现**）。
 * **逐条独立**：失败行保持 `PENDING` 且零写入；成功行落库；成功面**可重放且幂等**。
 * @returns {{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[], skipped?:string[],
 *   failed?:Array<object>, rows?:Array<object>, reason?:string, message:string}}
 */
function applyItemImportDecision(who, { batchId = '', importId = '', decision = '', note = '' } = {}) {
  const rawNote = note === null || note === undefined ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；本次零寫入。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > MAX_ITEM_REVIEW_NOTE_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `駁回理由不得超過 ${MAX_ITEM_REVIEW_NOTE_LENGTH} 字；本次零寫入。` }
  }
  const batch = String(batchId || '').trim()
  const single = String(importId || '').trim()
  if (!batch && !single) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。' }
  }
  const normalized = normalizeItemDecision(decision)
  if (!normalized) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message:
        `審覈決定「${String(decision === null || decision === undefined ? '' : decision)}」不在允許的 2 類之內` +
        '（ACCEPTED 採納 / REJECTED 駁回）；本次零寫入。'
    }
  }
  const accepted = normalized === ITEM_IMPORT_STATUS.ACCEPTED
  const at = nowIso()
  const imports = listItemImportRows()
  /* 选目标：单行优先（指定 `importId`）；否则全批次内行。 */
  const targets = imports.filter((row) => {
    if (!row) return false
    if (single) return String(row.id || '') === single
    return String(row.batch_id || '') === batch
  })
  if (targets.length === 0) {
    return { ok: false, reason: 'NOT_FOUND', message: '未找到匹配的印谱外部導入行（批次 / 單行）；本次零寫入。' }
  }

  const acceptedIds = []
  const rejectedIds = []
  const skipped = []
  const failed = []
  const nextItems = listItemRows().slice()
  const decidedById = new Map()

  targets.forEach((row) => {
    const rid = String((row && row.id) || '')
    const current = normalizeItemImportStatus(row && row.status)
    if (current !== ITEM_IMPORT_STATUS.PENDING) {
      /* 终态不回退：已审行**跳过**（幂等重放 / 部分失败场景均不改写既有终态）。 */
      skipped.push(rid)
      return
    }
    if (!accepted) {
      rejectedIds.push(rid)
      decidedById.set(rid, {
        ...row,
        status: ITEM_IMPORT_STATUS.REJECTED,
        reviewed_at: at,
        reviewer_id: who.id,
        review_note: noteText !== '' ? noteText : row.review_note || ''
      })
      return
    }
    /* **ACCEPTED**：按 `source_item_id` 幂等落 `xiai_items`（重复采纳不改写既有行）。 */
    const sourceId = String((row && row.source_item_id) || '').trim()
    if (!sourceId) {
      /* 幂等键缺失 ⇒ **该行失败、保持 PENDING 且零写入**（不动 items、不改本行）。 */
      failed.push({ id: rid, reason: 'MISSING_REQUIRED', message: '該導入行缺少冪等鍵（source_item_id）⇒ 未採納；本行保持 PENDING。' })
      return
    }
    const existingItem = nextItems.find((item) => item && String(item.source_item_id || '') === sourceId)
    if (!existingItem) {
      nextItems.push(buildItemRowFromImport(row))
    }
    acceptedIds.push(rid)
    decidedById.set(rid, {
      ...row,
      status: ITEM_IMPORT_STATUS.ACCEPTED,
      reviewed_at: at,
      reviewer_id: who.id,
      review_note: row.review_note || ''
    })
  })

  /* **成功面**：先落采纳产物（幂等）—— 再落导入行状态；两者都在本地（dev / 離線 ＝ 本地权威）。 */
  if (acceptedIds.length > 0) saveItemRows(nextItems)
  if (decidedById.size > 0) {
    saveItemImportRows(
      imports.map((row) => {
        const id = String((row && row.id) || '')
        return decidedById.has(id) ? decidedById.get(id) : row
      })
    )
  }
  return {
    ok: true,
    accepted,
    accepted_ids: acceptedIds,
    rejected_ids: rejectedIds,
    skipped,
    failed,
    rows: targets.map((row) => decidedById.get(String((row && row.id) || '')) || row),
    message: accepted
      ? `已採納 ${acceptedIds.length} 條印谱外部導入行並冪等落正式印谱（失敗 ${failed.length} / 跳過 ${skipped.length}）`
      : `已駁回 ${rejectedIds.length} 條印谱外部導入行（跳過 ${skipped.length}）`
  }
}

/**
 * **审核印谱外部导入行（采纳 / 驳回）**（管理员）。
 * 判定顺序（**全部在写之前**）：① 管理员门（非管理员 ⇒ `FORBIDDEN` ＋ 零写入）→
 * ② 经登录令牌写面门 `userWriteGate('reviewItemImport', …)`（缺 env ⇒ 安全拒 ＋ 零写入）。
 * `ACCEPTED` ⇒ 幂等落 `xiai_items`（按 `source_item_id`）；`REJECTED` ⇒ 零写入。
 * **两个入口都实现**：按批次（`batchId`）与按单行（`importId`）。
 * @param {{id?:string, role?:string}|null} actor 管理员
 * @param {{batchId?:string, importId?:string, decision?:string, note?:string}} [options]
 * @returns {Promise<{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[], skipped?:string[], failed?:Array<object>, rows?:Array<object>, reason?:string, message:string}>}
 */
export async function reviewItemImport(actor, options = {}) {
  const who = actor || currentUser()
  if (!canReviewItemImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈印谱外部導入批次' }
  }
  const gate = await userWriteGate('reviewItemImport', {
    batch_id: String((options && options.batchId) || ''),
    import_id: String((options && options.importId) || ''),
    decision: String((options && options.decision) || ''),
    note: String((options && options.note) || '')
  })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* 本機鏡像（dev / 離線 ＝ 本地權威；雲端 ＝ 服務端權威後的本機鏡像）。 */
  return applyItemImportDecision(who, options)
}

/* ------------------------------ 只读检索面 / 转发 ------------------------------ */

/** 取正式印谱行（原始行；云模式 ⇒ 云端快照；否则本机）。 */
export function listItems() {
  return listItemRows()
}

/** 按 `source_item_id` 取正式印谱行（采纳幂等键；未命中 ⇒ `null`）。 */
export function itemOfSourceId(sourceItemId) {
  return itemBySourceId(sourceItemId)
}

/** 单写者门转发（供视图 / 自检直调；两集合均不开放直写入口，含管理员直写）。 */
export function itemSingleWriterDenial(collectionKey) {
  return itemDirectWriteDenial(collectionKey)
}

/** 导入行提交人展示 uid（**零手机号**；此处只回 uid，避免第二套名表）。 */
export function itemImportSubmitterId(row) {
  return String((row && row.imported_by) || '')
}

/** 导入行三态真源转发 + 本体字段真源转发（供构造 / 自检复用；不另立第二套）。 */
export { ITEM_BODY_FIELDS, ITEM_MISC_FIELDS }
