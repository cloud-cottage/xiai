/**
 * 玺爱 · 勘误服务
 *
 * 勘误针对「可标记属性」：印文简体字、印文古字、朝代、**印面内容**（键 `seal_type`）、
 * **印面风格**（键 `face_style`，R-31）、作者、印文释义。
 * 勘误挂在**印面**上（canonical 字段含 `faceId` / `sealId`）；
 * 用户提交的勘误不直接覆盖原始数据，由平台按可信度汇总后对外展示。
 * 状态机三态冻结：`PENDING` / `ACCEPTED` / `REJECTED`（单向迁移，终态不回退）。
 * 提交、汇总、审核与奖励发放的闭环追加在文件末尾的「闭环补全」段。
 */

import {
  listCorrectionRows,
  saveCorrectionRows,
  normalizeCorrectionStatus,
  listPendingCorrectionRowsForAdmin,
  writeCorrectionDecision,
  markCorrectionRewarded,
  PermissionError
} from '../data/db.js'
import { currentUser } from '../data/session.js'
/* 值域真源**复用**：朝代 14 类 = `seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`（R-20）；
   印面内容 9 值 = `FACE_CONTENT_OPTIONS` / `isKnownFaceContent`（R-30）；
   印面风格 23 值 = `FACE_STYLE_OPTIONS` / `isKnownFaceStyle`（R-31）。
   （**不得在此自写第二套枚举**——第二套必然与真源漂移，且数据层判据是按字面值检索的。） */
import {
  DYNASTY_OPTIONS,
  isKnownDynasty,
  FACE_CONTENT_OPTIONS,
  FACE_STYLE_OPTIONS,
  isKnownFaceContent,
  isKnownFaceStyle
} from '../data/seed.js'
import { awardCorrectionReward } from './points.js'
import { getFaceById, primaryFaceOf, faceLabelOf, FACE_KIND } from './seals.js'

/** 勘误三态（规范冻结字面值）。 */
export const CORRECTION_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED'
}

/**
 * 可标记属性字段（与固定属性相对）。
 *
 * R-30 / R-31（2026-09-20）：
 *   - `seal_type` 的**显示名＝【印面内容】**（值是 9 值封闭集合，键名不变）；
 *   - 新增 `face_style` ＝【印面风格】（**新键**，印面级；23 值封闭集合）。
 */
export const MARKABLE_FIELDS = [
  { key: 'seal_name', label: '印文' },
  { key: 'dynasty', label: '朝代' },
  { key: 'seal_type', label: '印面內容' },
  { key: 'face_style', label: '印面風格' },
  { key: 'author', label: '作者' },
  { key: 'transcription', label: '印文釋義' }
]

export function listMyCorrections() {
  const user = currentUser()
  if (!user) return []
  return listCorrectionRows()
    .filter((row) => row.user_id === user.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

export function summarizeCorrections(rows) {
  const list = Array.isArray(rows) ? rows : []
  return {
    total: list.length,
    pending: list.filter((r) => r.status === CORRECTION_STATUS.PENDING).length,
    accepted: list.filter((r) => r.status === CORRECTION_STATUS.ACCEPTED).length,
    rejected: list.filter((r) => r.status === CORRECTION_STATUS.REJECTED).length
  }
}


/* ============================================================================
   闭环补全（增量追加）
   ----------------------------------------------------------------------------
   上方既有的常量与只读查询签名、行为均未改动（仅把状态枚举字面值对齐规范）。
   以下为提交 / 汇总 / 审核的写入闭环。勘误**不覆盖**原始数据，
   对外的展示值由 resolveMarkable 汇总采纳结果后给出。
   ============================================================================ */

function makeId() {
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function nowIso() {
  return new Date().toISOString()
}

function markableMeta(field) {
  return MARKABLE_FIELDS.find((item) => item.key === field) || null
}

/* ============================================================================
   勘误**提交侧**值域门（R-20 门 2 的缺口补全）
   ----------------------------------------------------------------------------
   为什么必须有：`submitCorrection` 原只校验「字段可勘误 + 值非空」，
   绕过 UI（选择框）直调服务层即可提交 `dynasty:'宋朝'` 这种 ∉ 14 类的 PENDING 勘误。
   值与真源：**复用** `seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`，**不自写第二套**。
   判定时机：**写在写之前**。`saveCorrectionRows` 是**整集合覆盖写**且调用方不读返回值，
   所以「先写再靠返回值回滚」会**静默丢写入**（上一单已踩过）⇒ 本门一律在 `saveCorrectionRows`
   之前返回，天然零写入（勘误行数不变）。
   形态：表驱动（`field -> 值域描述`），便于将来其它字段封闭化；当前启用
   `dynasty`（R-20｜14 类）/ `seal_type`（R-30｜【印面内容】9 类）/ `face_style`（R-31｜【印面风格】23 类）；
   表里没有的字段 ⇒ 自由文本，一律放行（作者 / 印文等本轮不动）。
   ============================================================================ */

/**
 * **封闭值域表**（可扩展）：仅登记「取值必须来自封闭集合」的字段。
 * 未登记 ⇒ 自由文本（不拦）。
 *
 * 现有三项（**真源一律在 `src/data/seed.js`，不得自写第二套**）：
 *   - `dynasty`（R-20）：14 类，`DYNASTY_OPTIONS` / `isKnownDynasty`；
 *   - `seal_type`（R-30｜【印面内容】）：**9 值**，`FACE_CONTENT_OPTIONS` / `isKnownFaceContent`；
 *   - `face_style`（R-31｜【印面风格】）：**23 值**，`FACE_STYLE_OPTIONS` / `isKnownFaceStyle`。
 *
 * 拒绝形态＝结构化 `{ok:false, reason:'INVALID_VALUE', message}` ＋ **零写入**
 * （判定在写之前，见 `submitCorrection`）；**不得自写第二套**值域机制。
 *
 * ⚠️ **既有行的旧值不受本门约束**（R-21 / R-32）：库内旧值（`吉語印` / `鑒藏印` / `閒章`）
 * 照读不误；本门只拦**新提交 / 新写入**的值（换言之：旧值可以「读」，不可以「再写一遍」）。
 * @type {Record<string, {accepts:(text:string)=>boolean, denyMessage:(label:string, text:string)=>string}>}
 */
const FIELD_VALUE_DOMAINS = {
  /* 朝代（R-20）：真源＝`src/data/seed.js` 的 `DYNASTY_OPTIONS` / `isKnownDynasty`。 */
  dynasty: {
    accepts: (text) => isKnownDynasty(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 14 類之內（${DYNASTY_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【印面内容】（R-30）：真源＝`FACE_CONTENT_OPTIONS`（9 值；键名沿用 `seal_type`）。 */
  seal_type: {
    accepts: (text) => isKnownFaceContent(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 9 類之內（${FACE_CONTENT_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  },
  /* 【印面风格】（R-31）：真源＝`FACE_STYLE_OPTIONS`（23 值；新键 `face_style`）。 */
  face_style: {
    accepts: (text) => isKnownFaceStyle(text),
    denyMessage: (label, text) =>
      `${label}「${text}」不在允許的 23 類之內（${FACE_STYLE_OPTIONS.join('、')}），已拒絕提交；` +
      '請從給定選項中選擇。'
  }
}

/**
 * 值域门：字段落在封闭集合里且值 ∉ 真源 ⇒ 结构化拒绝（`INVALID_VALUE`，与数据层同字面值）。
 * @returns {null|{ok:false, reason:'INVALID_VALUE', message:string}} 放行 ⇒ `null`
 */
function domainValueDenial(field, label, text) {
  const domain = FIELD_VALUE_DOMAINS[field]
  if (!domain) return null // 未封闭的字段 ＝ 自由文本
  if (domain.accepts(text)) return null
  return { ok: false, reason: 'INVALID_VALUE', message: domain.denyMessage(label, text) }
}

/** 归属键：新数据用 `sealId`，旧数据只有 `stamp_id`（两者同值）。 */
function sealIdOf(row) {
  return row.sealId || row.stamp_id || ''
}

/** 某印面的勘误行；旧数据（无 `faceId`）按印章归属落到该印章的主印面。 */
function rowsOfFace(face) {
  if (!face) return []
  return listCorrectionRows().filter((row) => {
    if (row.faceId) return row.faceId === face.id
    return sealIdOf(row) === face.sealId && face.kind === FACE_KIND.FACE
  })
}

/**
 * 提交勘误：一条勘误对应一个印面上的一个属性字段，状态自 PENDING 起。
 *
 * 拒绝形态一律**结构化**（`{ok:false, reason?, message}`），**不抛未捕获异常**：
 *   - 未登录 / 字段不可勘误 / 未指定印面 / 值为空 ⇒ 只有 `message`（无 `reason`，历史形态保留）；
 *   - **值域门（R-20 / R-30 / R-31）**：字段落在 `FIELD_VALUE_DOMAINS`
 *     （`dynasty` 14 类 / `seal_type` 9 类 / `face_style` 23 类）且值 ∉ 真源
 *     ⇒ `{ok:false, reason:'INVALID_VALUE', message}` + **零写入**（**写之前**判定，
 *     不依赖 `saveCorrectionRows` 的返回值 —— 那是整集合覆盖写且调用方不读返回值）。
 */
export function submitCorrection({ faceId = '', sealId = '', stampId = '', field, value, basis = '' } = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交勘誤' }
  const meta = markableMeta(field)
  if (!meta) return { ok: false, message: '該屬性不支持勘誤' }

  /* 印面定位：优先 faceId；旧调用方只给印章编号时落到该印章的主印面。 */
  const targetSealId = sealId || stampId
  const face = faceId ? getFaceById(faceId) : targetSealId ? primaryFaceOf(targetSealId) : null
  if (!face) return { ok: false, message: '未指定印面' }

  const text = String(value === null || value === undefined ? '' : value).trim()
  if (!text) return { ok: false, message: `請填寫${meta.label}` }

  /* 值域门（R-20 / R-30 / R-31）：**写之前**判定，拒绝即零写入（不新增勘误行、不改动既有行）。
     看 `FIELD_VALUE_DOMAINS` 里登记了哪些封闭字段；未登记字段（作者 / 印文…）不受影响。 */
  const denied = domainValueDenial(field, meta.label, text)
  if (denied) return denied

  const row = {
    id: makeId(),
    faceId: face.id, // 规范字段：勘误挂在印面上
    sealId: face.sealId, // 规范字段：所属印章
    stamp_id: face.sealId, // 兼容别名：＝sealId，勿删
    userId: user.id, // 规范字段：提交人
    user_id: user.id, // 兼容别名：＝userId
    field,
    field_label: meta.label,
    value: text,
    basis: String(basis || '').trim(),
    status: CORRECTION_STATUS.PENDING,
    created_at: nowIso(),
    reviewed_at: null,
    reviewer_id: null,
    rewarded_at: null
  }
  saveCorrectionRows([...listCorrectionRows(), row])
  const faceLabel = faceLabelOf(face.id, face.sealId)
  return {
    ok: true,
    row,
    message: `已提交「${faceLabel}·${meta.label}」勘誤，待審覈`
  }
}

export function listCorrectionsOfStamp(stampId) {
  return listCorrectionRows().filter((row) => sealIdOf(row) === stampId)
}

/** 某印面的全部勘误（含旧数据按印章归属的回落）。 */
export function listCorrectionsOfFace(faceId) {
  return rowsOfFace(getFaceById(faceId))
}

/** 审核队列（管理员用），默认按时间倒序。 */
export function listAllCorrections({ status = '' } = {}) {
  return listCorrectionRows()
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/**
 * 汇总某印面的可标记属性对外展示值。
 * 可信度口径：同一字段的**已采纳**勘误里取出现次数最多的提交值；
 * 次数相同时取最近一条。采纳结果只影响展示，不写回原始数据。
 * 参数可以是印面（canonical）或印章（兼容：按主印面汇总）。
 * @returns {Array<{key:string,label:string,original:string,display:string,source:string,acceptedCount:number,pendingCount:number}>}
 */
export function resolveMarkable(target) {
  const face = target && target.kind ? target : target ? primaryFaceOf(target.stamp_id) : null
  const rows = face ? rowsOfFace(face) : []
  return MARKABLE_FIELDS.map((meta) => {
    const original = face ? face[meta.key] : ''
    const all = rows.filter((row) => row.field === meta.key)
    const accepted = all.filter((row) => row.status === CORRECTION_STATUS.ACCEPTED)
    const tally = new Map()
    accepted.forEach((row) => {
      const entry = tally.get(row.value) || { value: row.value, count: 0, at: '' }
      entry.count += 1
      if (String(row.reviewed_at || row.created_at) > entry.at) entry.at = String(row.reviewed_at || row.created_at)
      tally.set(row.value, entry)
    })
    const ranked = [...tally.values()].sort((a, b) => b.count - a.count || b.at.localeCompare(a.at))
    const winner = ranked[0] || null
    const raw = original === null || original === undefined ? '' : String(original)
    return {
      key: meta.key,
      label: meta.label,
      original: raw,
      display: winner ? winner.value : raw,
      source: winner ? 'CORRECTION' : 'ORIGINAL',
      acceptedCount: winner ? winner.count : 0,
      pendingCount: all.filter((row) => row.status === CORRECTION_STATUS.PENDING).length
    }
  })
}

/* ============================================================================
   审核勘误（v1.3｜载体改为「我的勘误记录」页内的「采纳 / 驳回」按钮）
   ----------------------------------------------------------------------------
   冻结给 UI 单的服务层 API：`listPendingForAdmin(actor)` / `review(actor, id, decision)`。
   发奖入口；采纳 +10 金且**每条只奖一次**（幂等由 `points.awardCorrectionReward` 承担）。
   非管理员一律**结构化拒绝**（`{ok:false, reason:'FORBIDDEN'}`，§3.12.10(c)：与数据层同字面值），
   不抛未捕获异常。
   ============================================================================ */

/** 当前（或指定）账号是否可审核勘误 —— 供 /my/corrections 决定是否渲染「采纳 / 驳回」。 */
export function canReviewCorrections(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/**
 * **冻结 API ③**：管理员可见的审核队列 —— **全部用户的 `PENDING`**（不是仅自己的）。
 *
 * 与数据层同口径：非管理员一律**结构化拒绝**
 * `{ok:false, reason:'FORBIDDEN', message:'仅管理员可以查看全部用户的待审勘误'}`
 * （§3.12.10(c) 字面值与数据层同源；**不以空集冒充拒绝**，形状与写入口 `review()` 一致）；
 * 管理员 ⇒ `{ok:true, rows}`。两条路径均**不抛未捕获异常**。
 *
 * 适配登记（2026-09-20 收口）：服务层读入口由「裸数组」改为「结构化结果」，**调用点同步适配**
 * —— 唯一产品侧调用点是 `src/views/MyCorrectionsView.vue`（队列读数读 `result.ok ? result.rows : []`，
 * 并把 `result.message` 作为可读文案渲染，**不静默**）。
 * @param {object|null} actor 操作者（须为管理员；缺省回落到当前登录态）
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 *   `rows` 为 `PENDING` 勘误行（按提交时间倒序）
 */
export function listPendingForAdmin(actor) {
  const who = actor || currentUser()
  /* 与写入口 `review` 同判定：非管理员**结构化拒绝**（不是空集）。 */
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的待審勘誤' }
  }
  let res
  try {
    res = listPendingCorrectionRowsForAdmin(who)
  } catch (err) {
    /* 数据层已改为结构化拒绝；此兜底只为保证展示面不崩（如实回报，绝不外抛）。 */
    if (isPermissionError(err)) {
      return { ok: false, reason: 'FORBIDDEN', message: err.message || '僅管理員可以查看全部用戶的待審勘誤' }
    }
    return { ok: false, reason: 'INTERNAL_ERROR', message: `讀取待審勘誤失敗：${(err && err.message) || '未知錯誤'}` }
  }
  if (Array.isArray(res)) return { ok: true, rows: res } // 兼容：万一数据层回退成裸数组
  if (res && res.ok) return { ok: true, rows: res.rows || [] }
  /* 数据层结构化拒绝 ⇒ 原样透传（reason / message 同字面值），不吞成空集。 */
  return {
    ok: false,
    reason: (res && res.reason) || 'FORBIDDEN',
    message: (res && res.message) || '僅管理員可以查看全部用戶的待審勘誤'
  }
}

function isPermissionError(err) {
  return err instanceof PermissionError || (err && err.name === 'PermissionError')
}

/**
 * **冻结 API ④**：审核一条勘误（采纳 / 驳回）。
 *
 * - 仅管理员；`decision` 取 `'ACCEPTED'`（采纳）或 `'REJECTED'`（驳回），
 *   旧字面值 `'APPROVED'` 由数据层归一为采纳（兼容既有调用）。
 * - 采纳 ⇒ 给**提交者**发放 10 金（`勘误奖励` 流水），**每条只奖一次**（重复审核被拒、
 *   重复采纳不二次发奖）；驳回 ⇒ 余额与流水均不变。
 * - 终态不回退：已审过的条目再调 ⇒ `{ok:false, reason:'ALREADY_REVIEWED'}`。
 * @returns {{ok:boolean, status?:string, accepted?:boolean, reward?:object, row?:object,
 *   reason?:string, message:string}}
 */
export function review(actor, correctionId, decision) {
  const who = actor || currentUser()
  if (!canReviewCorrections(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈勘誤' }
  }
  let decided
  try {
    decided = writeCorrectionDecision(who, correctionId, decision)
  } catch (err) {
    if (isPermissionError(err)) return { ok: false, reason: 'FORBIDDEN', message: err.message }
    return { ok: false, reason: 'ERROR', message: `審覈失敗：${(err && err.message) || '未知原因'}` }
  }
  if (!decided.ok) return decided

  let reward = { ok: true, awarded: false, message: '駁回不發獎' }
  if (decided.accepted) {
    const submitterId = decided.row.user_id || decided.row.userId
    reward = awardCorrectionReward(submitterId, correctionId)
    if (reward.awarded) {
      try {
        markCorrectionRewarded(who, correctionId)
      } catch {
        /* 奖励已实际发放；标记失败不回滚（奖励幂等以流水为准，见 §7.4）。 */
      }
    }
  }
  const label = decided.row.field_label || (markableMeta(decided.row.field) || {}).label || '該屬性'
  const faceLabel = faceLabelOf(decided.row.faceId, sealIdOf(decided.row))
  return {
    ok: true,
    status: decided.status,
    accepted: decided.accepted,
    reward,
    row: decided.row,
    message: decided.accepted
      ? `已採納「${faceLabel}·${label}」勘誤。${reward.message}`
      : `已駁回「${faceLabel}·${label}」勘誤`
  }
}

/**
 * 兼容入口：既有调用方（管理员专区页）按「当前登录态」审核。
 * 行为与 `review` 一致，签名保持 `(id, decision)`（**勿改**，既有页面在用）。
 */
export function reviewCorrection(id, decision) {
  const user = currentUser()
  if (!user || user.role !== 'admin') return { ok: false, message: '僅管理員可以審覈勘誤' }
  const rows = listCorrectionRows()
  const target = rows.find((row) => row.id === id)
  if (!target) return { ok: false, message: '未找到該勘誤' }
  if (normalizeCorrectionStatus(target.status) !== CORRECTION_STATUS.PENDING) {
    return { ok: false, message: '該勘誤已審覈，不可重複處理' }
  }
  return review(user, id, decision)
}
