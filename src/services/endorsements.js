/**
 * 玺爱 · **采信（採信）服务**（本单新增 · 用户写面切片）
 * ============================================================================
 * 语义（人类冻结口径，逐条）：
 *   ① 同一印面 ＋ 同一字段，「**同一段文字**」只允许一个人提交（严格判据：值**逐字相同**即重复
 *      ⇒ 按值**精确字符串比较**，不做归一）；别人若赞同，**不去重复提交**，而是点【**採信**】。
 *   ② 【採信】**只作为佐证 / 可信度计数**（展示为「N 人採信」）；**生效仍由管理员采纳决定**
 *      （只有 `ACCEPTED` 的勘误参与对外展示值 —— 见 `services/corrections.js::resolveMarkable`）。
 *   ③ 采信目标键 ＝ `(faceId, field, value)`；**幂等**（同一人同值只记一次）、**不可自采**。
 *   ④ 计数经**云端公开只读集合** `xiai_endorsement_counts`（脱敏：**零身份字段**）全站一致；
 *      每次采信成功后由云函数重算该键的 count 并幂等 upsert。
 *
 * 分层纪律：本文件是**服务层**入口（视图只经 `services/index.js` 门面调用它）；
 * 底层读 / 写一律经 `data/db.js`（全工程唯一碰 localStorage 的是 `data/storage.js`）。
 *
 * 写面纪律（与勘误提交同一条管道）：`userGate(ENDORSE_OP, payload)` 经云函数 `xiai-user-token`
 * 服务端验签后才落盘；身份由服务端从令牌派生（载荷里的身份类键被服务端拒 ⇒ `INVALID_FIELD`）；
 * **传输 / 内部失败一律 `STORAGE_UNAVAILABLE`，绝不伪装 `FORBIDDEN`**。
 */

import {
  listCorrectionRows,
  listEndorsementRows,
  saveEndorsementRows,
  listEndorsementCountRows,
  listEndorsementCountMirrorRows,
  saveEndorsementCountRows
} from '../data/db.js'
import { currentUser } from '../data/session.js'
import { userWriteGate } from './userWrite.js'
import { MARKABLE_FIELDS, submissionGroupsOfFace, CORRECTION_STATUS } from './corrections.js'

/** 云端写面 op 名（须与云函数 `xiai-user-token/lib/ops.js::OPS` 的注册面逐字一致）。 */
export const ENDORSE_OP = 'endorseCorrection'

/**
 * 采信载荷的**封闭键面**（**须与云函数 `lib/ops.js::ENDORSE_ALLOWED_KEYS` 逐字同值**）。
 *
 * 为什么必须逐字：云函数侧 `ALLOWED_KEYS` 是**服务端封闭面** —— 载荷里出现未登记键
 * ⇒ `INVALID_FIELD` ＋ **零写入**（本地 dev 形态照样通过 ⇒ 本地绿、线上红，实测踩过）。
 * 密钥名对齐由 `scripts/verify-endorsement.mjs` **机械断言**（两处逐字相等）。
 */
export const ENDORSE_PAYLOAD_KEYS = ['faceId', 'sealId', 'stampId', 'field', 'value']

/** 公开计数行 schema 版本（与云函数 `ENDORSEMENT_SCHEMA` 逐字同值）。 */
export const ENDORSEMENT_SCHEMA = 'xiai-endorsement-counts-v1'

/** 公开计数行文档键前缀（与云函数 `ENDORSEMENT_COUNT_ID_PREFIX` 逐字同值）。 */
export const ENDORSEMENT_COUNT_ID_PREFIX = 'e-'

/** 采信私有行文档键前缀（与云函数 `ENDORSEMENT_ID_PREFIX` 逐字同值）。 */
export const ENDORSEMENT_ID_PREFIX = 'en-'

/** 采信值上限（与云函数 `MAX_TEXT_LENGTH` 同值：≤ 500 字）。 */
export const MAX_ENDORSE_VALUE_LENGTH = 500

function nowIso() {
  return new Date().toISOString()
}

/** 本机确定性 id 用的不可逆摘要（FNV-1a 32 位）；**只用于本地 dev 形态的镜像行键**。 */
function localHash(value) {
  let hash = 0x811c9dc5
  const source = String(value)
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function textOf(value) {
  return String(value === null || value === undefined ? '' : value)
}

/**
 * **纯函数：采信按钮的渲染判定**（供视图与离线自检直接调用；**不读任何数据**）。
 *
 * 判定顺序（**已冻结**）：
 *   ① 该值**是本人的提交** ⇒ 不出按钮（`reason:'SELF'`）；
 *   ② 该条目**已 `ACCEPTED`** ⇒ 不接受采信、按钮隐藏（`reason:'ACCEPTED'`）；检索登记：
 *      `data-endorse-accepted`；
 *   ③ **未登錄**（`viewer` 为空）⇒ 按钮**渲染**，但点击走登录引导（`actionable:false`）；
 *   ④ 其余（他人 `PENDING` 提交）⇒ 按钮渲染且可点。
 * @param {{status?:string, mine?:boolean}} entry 条目（`mine` ＝ 该值由本人提交）
 * @param {{id?:string}|null} viewer 当前登录用户（游客 ⇒ `null`）
 * @returns {{listed:boolean, button:boolean, actionable:boolean, reason:'SELF'|'ACCEPTED'|'LOGIN_REQUIRED'|'OK'}}
 */
export function endorsementDecision(entry, viewer) {
  const mine = Boolean(entry && entry.mine)
  const status = entry && entry.status ? String(entry.status) : CORRECTION_STATUS.PENDING
  if (mine) return { listed: true, button: false, actionable: false, reason: 'SELF' }
  if (status === CORRECTION_STATUS.ACCEPTED) return { listed: true, button: false, actionable: false, reason: 'ACCEPTED' }
  if (!viewer) return { listed: true, button: true, actionable: false, reason: 'LOGIN_REQUIRED' }
  return { listed: true, button: true, actionable: true, reason: 'OK' }
}

/**
 * 某 `(faceId, field, value)` 键的采信人数（**只读**）。
 * @param {string} faceId 印面编号
 * @param {string} field 字段键
 * @param {string} value 值（**精确字符串**）
 * @param {Array<object>} [rows] 计数行（缺省 ⇒ 现场读 `listEndorsementCountRows()`）
 * @returns {number} 计数（无行 / 非数 / ≤0 ⇒ `0`）
 */
export function endorsementCountOf(faceId, field, value, rows) {
  const list = Array.isArray(rows) ? rows : listEndorsementCountRows()
  const target = list.find(
    (row) =>
      String((row && row.faceId) || '') === String(faceId) &&
      String((row && row.field) || '') === String(field) &&
      String((row && row.value) === null || (row && row.value) === undefined ? '' : row.value) === String(value)
  )
  const count = target ? Number(target.count) : 0
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0
}

/**
 * 详情页「可標記屬性」区**采信列表**的读数单点（供视图 `v-for`）。
 * 每项 ＝ `{field, label, value, status, mine, count, listed, button, actionable, reason}`。
 * 数据源：`submissionGroupsOfFace(face)`（本机勘误行 ∪ 公开投影行）＋ 公开计数行。
 * @param {object|null} face 印面（canonical）
 * @param {{id?:string}|null} viewer 当前登录用户（游客 ⇒ `null`）
 * @returns {Array<object>}
 */
export function endorsementEntriesOf(face, viewer) {
  if (!face) return []
  const groups = submissionGroupsOfFace(face)
  const countRows = listEndorsementCountRows()
  const viewerId = viewer ? String(viewer.id || '') : ''
  return groups
    .map((group) => {
      const mine =
        viewerId !== '' && group.submitterIds.length > 0 && group.submitterIds.every((id) => id === viewerId)
      const decision = endorsementDecision({ status: group.status, mine }, viewer || null)
      return {
        field: group.field,
        label: group.label,
        value: group.value,
        status: group.status,
        mine,
        count: endorsementCountOf(face.id, group.field, group.value, countRows),
        listed: decision.listed,
        button: decision.button,
        actionable: decision.actionable,
        reason: decision.reason
      }
    })
    .filter((entry) => entry.listed)
}

/**
 * 本人是否已对该 `(faceId, field, value)` 采信（**只读本机私有镜像**）。
 * 用途：按钮态 / 幂等前置门（云端形态下服务端仍会独立判幂等）。
 * @returns {boolean}
 */
export function hasEndorsed(faceId, field, value, userId) {
  const target = String(userId || '')
  return listEndorsementRows().some(
    (row) =>
      String((row && row.faceId) || '') === String(faceId) &&
      String((row && row.field) || '') === String(field) &&
      String((row && row.value) === null || (row && row.value) === undefined ? '' : row.value) === String(value) &&
      (!target || String(row.user_id || row.userId || '') === target)
  )
}

/** **公开计数行的本机镜像 upsert**（幂等：按行身份覆盖；重复采信不新增第二行）。 */
function mirrorEndorsementCount(projection) {
  if (!projection || typeof projection !== 'object') return null
  const identity = (row) =>
    `${String((row && row.faceId) || '')}\u0001${String((row && row.field) || '')}\u0001${textOf(
      row && row.value
    )}`
  const key = identity(projection)
  const rows = listEndorsementCountMirrorRows()
  const exists = rows.some((row) => identity(row) === key)
  const next = exists ? rows.map((row) => (identity(row) === key ? { ...row, ...projection } : row)) : [...rows, projection]
  saveEndorsementCountRows(next)
  return projection
}

/** **本地 dev 形态**：按本机私有采信行重算计数行（自愈：去重后计数，重置 / 重放不涨数）。 */
function recomputeLocalCount(faceId, field, value, sealId) {
  const mineRows = listEndorsementRows().filter(
    (row) =>
      String((row && row.faceId) || '') === String(faceId) &&
      String((row && row.field) || '') === String(field) &&
      textOf(row && row.value) === String(value)
  )
  const ids = new Set(mineRows.map((row) => String((row && row._id) || '')).filter((id) => id !== ''))
  const count = ids.size > 0 ? ids.size : 1
  return {
    _id: `${ENDORSEMENT_COUNT_ID_PREFIX}${faceId}-${field}-${localHash(value)}`,
    faceId,
    sealId: sealId || '',
    stamp_id: sealId || '',
    field,
    value,
    count,
    updated_at: nowIso(),
    schema: ENDORSEMENT_SCHEMA
  }
}

/**
 * **采信写入口**（用户写面切片）。
 *
 * 顺序：① 本地前置门（登录态 / 字段面 / 印面 / 空值 / 上限 / **不可自采** / **本机幂等**）；
 * ② **服务端门** `userGate(ENDORSE_OP, payload)`（云端形态下唯一身份判据 ＋ 权威落盘两处：
 *   采信行 ＋ 公开计数行）；不过门 ⇒ **原样透传**服务端结构化拒绝 ＋ 零写入
 *   （传输层失败 ⇒ `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）；
 * ③ 过门后：**dev / 離線形態** ⇒ 本地镜像（非正式写入路径）；**云端形态** ⇒ 本地只镜像
 *   **服务端回传的那一行 ＋ 公开计数行**（非前端自建）。
 *
 * 返回一律**结构化**（`{ok:false, reason?, message}`），**不抛未捕获异常**。
 * @param {{faceId?:string, sealId?:string, stampId?:string, field:string, value:string}} input
 * @returns {Promise<{ok:boolean, reason?:string, message:string, authority?:string, docId?:string,
 *   row?:object, count?:number}>}
 */
export async function endorseCorrection({ faceId = '', sealId = '', stampId = '', field, value } = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再採信' }
  const meta = Array.isArray(MARKABLE_FIELDS) ? MARKABLE_FIELDS.find((item) => item.key === field) : null
  if (!meta) return { ok: false, message: '該屬性不支持採信' }
  const targetFaceId = String(faceId || '').trim()
  if (!targetFaceId) return { ok: false, message: '未指定印面' }
  const text = textOf(value).trim()
  if (!text) return { ok: false, message: `請選擇要採信的${meta.label}值` }
  if (text.length > MAX_ENDORSE_VALUE_LENGTH) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `採信文字超出上限（${MAX_ENDORSE_VALUE_LENGTH} 字）；本次零寫入。`
    }
  }
  const targetSeal = String(sealId || stampId || '').trim()

  /* ①-自采：本机勘误行里若同值就是本人提交 ⇒ 拒（与云函数同字面值 `FORBIDDEN`）。 */
  const mineSubmission = listCorrectionRows().some(
    (row) =>
      String((row && row.faceId) || '') === targetFaceId &&
      String((row && row.field) || '') === String(field) &&
      textOf(row && row.value).trim() === text &&
      String(row.user_id || row.userId || '') === String(user.id)
  )
  if (mineSubmission) {
    return { ok: false, reason: 'FORBIDDEN', message: '該值就是你自己的提交，不能對自己的提交採信；本次零寫入。' }
  }
  /* ①-幂等：本机私有镜像已有一条同键采信 ⇒ 拒。 */
  if (hasEndorsed(targetFaceId, field, text, user.id)) {
    return { ok: false, reason: 'ALREADY_ENDORSED', message: '你已經採信過該值（同一段文字只記一次）；本次零寫入。' }
  }

  const payload = { faceId: targetFaceId, sealId: targetSeal, stampId: targetSeal, field, value: text }
  const gate = await userWriteGate(ENDORSE_OP, payload)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    /* ③-a dev / 離線形態：本地镜像（**非正式寫入路徑**）。 */
    const rows = listEndorsementRows()
    const row = {
      _id: `${ENDORSEMENT_ID_PREFIX}${localHash([targetFaceId, field, text, user.id].join('\u0001'))}`,
      faceId: targetFaceId,
      sealId: targetSeal,
      stamp_id: targetSeal,
      field,
      value: text,
      user_id: user.id,
      user_phone: textOf(user.phone),
      identity_source: 'LOCAL_DEV',
      created_at: nowIso()
    }
    saveEndorsementRows([...rows, row])
    const countRow = recomputeLocalCount(targetFaceId, field, text, targetSeal)
    mirrorEndorsementCount(countRow)
    return {
      ok: true,
      authority: 'LOCAL_DEV',
      row,
      count: countRow.count,
      message: `已採信「${meta.label}·${text}」（dev / 離線形態，非正式寫入路徑）`
    }
  }

  /* ③-b 雲端形態：**服務端已落盤** ⇒ 本地只镜像服务端回传的那一行 ＋ 公开计数行。 */
  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。'
    }
  }
  const rows = listEndorsementRows()
  const rowId = String(serverRow._id || '')
  const exists = rowId !== '' && rows.some((row) => String((row && row._id) || '') === rowId)
  saveEndorsementRows(
    exists
      ? rows.map((row) => (String((row && row._id) || '') === rowId ? { ...row, ...serverRow } : row))
      : [...rows, serverRow]
  )
  const countRow = mirrorEndorsementCount(gate.projection)
  return {
    ok: true,
    authority: 'SERVER',
    docId: gate.docId,
    row: serverRow,
    count: countRow ? Number(countRow.count) || 0 : 0,
    message: `已採信「${meta.label}·${text}」`
  }
}
