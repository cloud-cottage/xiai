/**
 * 玺爱 · **采信（採信）服务**（本单新增 · 用户写面切片；值级公开摘要面）
 * ============================================================================
 * 语义（人类冻结口径，逐条）：
 *   ① 同一印面 ＋ 同一字段，「**同一段文字**」只允许一个人提交（严格判据：值**逐字相同**即重复
 *      ⇒ 按值**精确字符串比较**，不做归一）；别人若赞同，**不去重复提交**，而是点【**採信**】。
 *   ② 【採信】**只作为佐证 / 可信度计数**（展示为「N 人採信」）；**生效仍由管理员采纳决定**
 *      （只有 `ACCEPTED` 的勘误参与对外展示值 —— 见 `services/corrections.js::resolveMarkable`）。
 *   ③ 采信目标键 ＝ `(faceId, field, value)`；**幂等**（同一人同值只记一次）、**不可自采**。
 *   ④ 计数与候选值列表经**云端公开只读集合** `xiai_correction_summaries`
 *      （**值级公开脱敏摘要面**：`submits` / `endorses` / `status` / `submitter_uids`；
 *      **零手机号**、uid 允许）—— 让**未采纳提交的公开摘要面**跨浏览器 / 跨用户可见
 *      （他人在另一浏览器提交的 `PENDING` 值也能被列出并【採信】）。每次采信成功后由云函数
 *      重算该键的摘要行并幂等 upsert；前端只镜像、**不在前端重建**。
 *
 * 分层纪律：本文件是**服务层**入口（视图只经 `services/index.js` 门面调用它）；
 * 底层读 / 写一律经 `data/db.js`（全工程唯一碰 localStorage 的是 `data/storage.js`）。
 *
 * 写面纪律（与勘误提交同一条管道）：`userWriteGate(ENDORSE_OP, payload)` 经云函数 `xiai-user-token`
 * 服务端验签后才落盘；身份由服务端从令牌派生（载荷里的身份类键被服务端拒 ⇒ `INVALID_FIELD`）；
 * **传输 / 内部失败一律 `STORAGE_UNAVAILABLE`，绝不伪装 `FORBIDDEN`**。
 */

import { listCorrectionRows, listCorrectionSummaryRows, listEndorsementRows, saveEndorsementRows } from '../data/db.js'
import { currentUser } from '../data/session.js'
import { userWriteGate } from './userWrite.js'
import {
  MARKABLE_FIELDS,
  CORRECTION_STATUS,
  CORRECTION_SUMMARY_SCHEMA,
  CORRECTION_SUMMARY_ID_PREFIX,
  mirrorCorrectionSummaryRow,
  syncLocalCorrectionSummary
} from './corrections.js'

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

/**
 * 值级公开摘要行的 schema 版本（与云函数 `ENDORSEMENT_SCHEMA` 收口后的
 * `ops.js::CORRECTION_SUMMARY_SCHEMA` 逐字同值）—— 真源在 `corrections.js`，此处转口。
 */
export { CORRECTION_SUMMARY_SCHEMA, CORRECTION_SUMMARY_ID_PREFIX }

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

/** 字段元数据（`MARKABLE_FIELDS` 单点）；未登记 ⇒ `null`。 */
function markableMeta(field) {
  return Array.isArray(MARKABLE_FIELDS) ? MARKABLE_FIELDS.find((item) => item.key === field) || null : null
}

/** 状态归一（缺键 ⇒ `PENDING`；认不出的字面值原样返回）。 */
function statusOf(value) {
  const raw = textOf(value)
  if (raw === CORRECTION_STATUS.ACCEPTED || raw === CORRECTION_STATUS.REJECTED) return raw
  return CORRECTION_STATUS.PENDING
}

/** 正向数值护栏（缺键 / 非数 / ≤0 ⇒ `0`；**不冒充有计数**）。 */
function countNumberOf(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

/**
 * **纯函数：采信按钮的渲染判定**（供视图与离线自检直接调用；**不读任何数据**）。
 *
 * 判定顺序（**已冻结**）：
 *   ① 该值**是本人的提交** ⇒ 不出按钮（`reason:'SELF'`）；
 *   ② 该值**已 `ACCEPTED`** ⇒ 不接受采信、按钮隐藏（`reason:'ACCEPTED'`）；
 *   ③ 该值**已 `REJECTED`** ⇒ 不再接受采信、按钮隐藏（`reason:'REJECTED'`）；
 *   ④ **未登錄**（`viewer` 为空）⇒ 按钮**渲染**，但点击走登录引导（`actionable:false`）；
 *   ⑤ 其余（他人 `PENDING` 值）⇒ 按钮渲染且可点。
 * @param {{status?:string, mine?:boolean}} entry 条目（`mine` ＝ 该值由本人提交）
 * @param {{id?:string}|null} viewer 当前登录用户（游客 ⇒ `null`）
 * @returns {{listed:boolean, button:boolean, actionable:boolean, reason:'SELF'|'ACCEPTED'|'REJECTED'|'LOGIN_REQUIRED'|'OK'}}
 */
export function endorsementDecision(entry, viewer) {
  const mine = Boolean(entry && entry.mine)
  const status = statusOf(entry && entry.status)
  if (mine) return { listed: true, button: false, actionable: false, reason: 'SELF' }
  if (status === CORRECTION_STATUS.ACCEPTED) return { listed: true, button: false, actionable: false, reason: 'ACCEPTED' }
  if (status === CORRECTION_STATUS.REJECTED) return { listed: true, button: false, actionable: false, reason: 'REJECTED' }
  if (!viewer) return { listed: true, button: true, actionable: false, reason: 'LOGIN_REQUIRED' }
  return { listed: true, button: true, actionable: true, reason: 'OK' }
}

/**
 * 某 `(faceId, field, value)` 键的采信人数（**只读**；读值级公开摘要行的 `endorses`）。
 * @param {string} faceId 印面编号
 * @param {string} field 字段键
 * @param {string} value 值（**精确字符串**）
 * @param {Array<object>} [rows] 值级公开摘要行（缺省 ⇒ 现场读 `listCorrectionSummaryRows()`）
 * @returns {number} 计数（无行 / 非数 / ≤0 ⇒ `0`）
 */
export function endorsementCountOf(faceId, field, value, rows) {
  const list = Array.isArray(rows) ? rows : listCorrectionSummaryRows()
  const target = list.find(
    (row) =>
      String((row && row.faceId) || '') === String(faceId) &&
      String((row && row.field) || '') === String(field) &&
      textOf(row && row.value) === String(value)
  )
  return countNumberOf(target && target.endorses)
}

/**
 * 详情页「可標記屬性」区**候选值列表**的读数单点（供视图 `v-for`）。
 *
 * **数据源 ＝ 值级公开摘要面**（`listCorrectionSummaryRows()`：云端快照 ∪ 本机镜像）——
 * **不读本机 `corrections` 镜像** ⇒ 他人在**另一浏览器**提交的 `PENDING` 值同样可见（跨浏览器成立）。
 * 每项 ＝ `{field, label, value, status, mine, submits, count, listed, button, actionable, reason}`；
 * `submits` ＝「N 人提交」、`count` ＝「M 人採信」。
 * @param {object|null} face 印面（canonical）
 * @param {{id?:string}|null} viewer 当前登录用户（游客 ⇒ `null`）
 * @returns {Array<object>}
 */
export function endorsementEntriesOf(face, viewer) {
  if (!face) return []
  const summaries = listCorrectionSummaryRows()
  const viewerId = viewer ? String(viewer.id || '') : ''
  return summaries
    .filter((row) => String((row && row.faceId) || '') === String(face.id))
    .map((row) => {
      const uids = Array.isArray(row && row.submitter_uids) ? row.submitter_uids.map((item) => String(item)) : []
      const mine = viewerId !== '' && uids.indexOf(viewerId) !== -1
      const field = String((row && row.field) || '')
      const status = statusOf(row && row.status)
      const decision = endorsementDecision({ status, mine }, viewer || null)
      const meta = markableMeta(field)
      return {
        field,
        label: meta ? meta.label : field,
        value: textOf(row && row.value),
        status,
        mine,
        submits: countNumberOf(row && row.submits),
        count: countNumberOf(row && row.endorses),
        listed: decision.listed,
        button: decision.button,
        actionable: decision.actionable,
        reason: decision.reason
      }
    })
    .filter((entry) => entry.listed && entry.value !== '')
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
      textOf(row && row.value) === String(value) &&
      (!target || String(row.user_id || row.userId || '') === target)
  )
}

/**
 * **采信写入口**（用户写面切片）。
 *
 * 顺序：① 本地前置门（登录态 / 字段面 / 印面 / 空值 / 上限 / **不可自采** / **本机幂等**）；
 * ② **服务端门** `userWriteGate(ENDORSE_OP, payload)`（云端形态下唯一身份判据 ＋ 权威落盘两处：
 *   采信行 ＋ 值级公开摘要行）；不过门 ⇒ **原样透传**服务端结构化拒绝 ＋ 零写入
 *   （传输层失败 ⇒ `STORAGE_UNAVAILABLE`，**绝不伪装 `FORBIDDEN`**）；
 * ③ 过门后：**dev / 離線形態** ⇒ 本地镜像 ＋ 本地重算值级公开摘要行（非正式写入路径）；
 *   **云端形態** ⇒ 本地只镜像**服务端回传的那一行 ＋ 值级公开摘要行**（非前端自建）。
 *
 * 返回一律**结构化**（`{ok:false, reason?, message}`），**不抛未捕获异常**。
 * @param {{faceId?:string, sealId?:string, stampId?:string, field:string, value:string}} input
 * @returns {Promise<{ok:boolean, reason?:string, message:string, authority?:string, docId?:string,
 *   row?:object, count?:number}>}
 */
export async function endorseCorrection({ faceId = '', sealId = '', stampId = '', field, value } = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再採信' }
  const meta = markableMeta(field)
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
    /* ③-a dev / 離線形態：本地镜像 ＋ 本地重算值级公开摘要行（**非正式寫入路徑**）。 */
    const rows = listEndorsementRows()
    const row = {
      _id: `${ENDORSEMENT_ID_PREFIX}${localHash([targetFaceId, field, text, user.id].join('\u0001'))}`,
      faceId: targetFaceId,
      sealId: targetSeal,
      stamp_id: targetSeal,
      field,
      value: text,
      user_id: user.id,
      /* **业务行不再落手机号**（人类口径 ②）：dev 形态亦只落不透明 uid。 */
      identity_source: 'LOCAL_DEV',
      created_at: nowIso()
    }
    saveEndorsementRows([...rows, row])
    const summaryRow = syncLocalCorrectionSummary(targetFaceId, targetSeal, field, text)
    return {
      ok: true,
      authority: 'LOCAL_DEV',
      row,
      count: countNumberOf(summaryRow && summaryRow.endorses),
      message: `已採信「${meta.label}·${text}」（dev / 離線形態，非正式寫入路徑）`
    }
  }

  /* ③-b 雲端形態：**服務端已落盤** ⇒ 本地只镜像服务端回传的那一行 ＋ 值级公开摘要行。 */
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
  const summaryRow = mirrorCorrectionSummaryRow(gate.summary)
  return {
    ok: true,
    authority: 'SERVER',
    docId: gate.docId,
    row: serverRow,
    count: countNumberOf(summaryRow && summaryRow.endorses),
    message: `已採信「${meta.label}·${text}」`
  }
}
