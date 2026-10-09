/**
 * 玺爱 · 印人（person）服务（person-model-draft-v0.1 §2 / §3 / §4.3）
 * ----------------------------------------------------------------------------
 * 归属 ＝ **玺爱 canonical 唯一真源**。本服务是**印人提案**的提交 / 采纳 / 驳回 / 查询入口，
 * 以及正式印人的**只读**检索面（供印面「作者」选人控件取用）。
 *
 * 硬口径（逐条）：
 *   · **正式印人只经采纳路径产生**（`reviewPersonProposal(..., 'ACCEPTED')` 的幂等生成）；
 *     **不开放任何直写入口**（含管理员直写 ⇒ `FORBIDDEN` ＋ 零写入）。
 *   · **提交 ＝ 任何登录用户**；**采纳 / 驳回 ＝ 管理员**（`role === 'admin'`）。
 *   · 状态机三态**单向、终态不回退**（`PENDING` / `ACCEPTED` / `REJECTED`）。
 *   · **防重键**（§3）：同 `(target_person_id, 姓名, 生卒, cbdb_id)` **只允许一人提交**；
 *     重复 ⇒ 结构化拒绝 `{ok:false, reason:'DUPLICATE_VALUE'}` ＋ **零写入**。
 *   · **零新增 reason 字面值**：一律沿用既有冻结表字面值
 *     （`FORBIDDEN` / `MISSING_REQUIRED` / `INVALID_VALUE` / `NOT_FOUND` / `DUPLICATE_VALUE` /
 *     `ALREADY_REVIEWED`）。
 *   · **显示名（单点）**：`display_name` **派生不落盘** —— 只读面用数据层单点
 *     `db.personDisplayName` / `db.resolveAuthorName`，**本服务不另立第二套名表**。
 *   · **编号**：`PR` ＋ 9 位零填充（真源 `seed.js::formatPersonCode` / `db.nextPersonCode`）。
 *
 * **本期未接线（如实登记）**：
 *   · **云函数写面**（`xi…/lib/ops.js` 的 `submitPersonProposal` / `reviewPersonProposal`）**新增
 *     op 与本服务的 `userWriteGate` 尚未接通**（云函数 `index.js` 不在本单写集）⇒ 本服务**当前
 *     只在本地（dev / 离线）形态落盘**；云端形态的端到端验证**不可达**（须先补 op 接线）。
 *   · **两集合尚待人工新建**（云控制台动作）⇒ 云端模式下落库路径不可达。
 */

import { currentUser } from '../data/session.js'
import {
  listPersonRows,
  savePersonRows,
  listPersonProposalRows,
  savePersonProposalRows,
  personById,
  personDisplayName,
  nextPersonCode
} from '../data/db.js'
import { PERSON_PROPOSAL_STATUS, emptyPersonFields } from '../data/seed.js'

/** 印人提案三态（转发真源 `seed.js::PERSON_PROPOSAL_STATUS`；单向、终态不回退）。 */
export const PERSON_STATUS = PERSON_PROPOSAL_STATUS

/** 提案单号上限（服务层本地护栏；与既有勘误口径同规格）。 */
export const MAX_PROPOSAL_ID_LENGTH = 128

/** 驳回理由上限（与勘误同值 200 字）。 */
export const MAX_REVIEW_NOTE_LENGTH = 200

function nowIso() {
  return new Date().toISOString()
}

function makeProposalId() {
  return `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 归一为字符串数组（去空、保序；非数组 ⇒ `[]`）。 */
function toArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item === null || item === undefined ? '' : item).trim()).filter((item) => item !== '')
  if (typeof value === 'string') return value.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean)
  return []
}

/** 归一为「整数或 null」：非数 / 空 ⇒ `null`（「不详」＝空，**不设特值**）。 */
function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : null
}

/** 提案状态归一（旧 / 缺值 ⇒ `PENDING`）。 */
function normalizeProposalStatus(status) {
  const text = String(status || '').trim()
  if (text === PERSON_PROPOSAL_STATUS.ACCEPTED || text === PERSON_PROPOSAL_STATUS.REJECTED) return text
  return PERSON_PROPOSAL_STATUS.PENDING
}

/** 审核决定归一：`ACCEPTED` / `REJECTED` 之外 ⇒ `''`（非法，调用方结构化拒绝）。 */
function normalizeDecision(decision) {
  const text = String(decision === null || decision === undefined ? '' : decision).trim()
  return text === PERSON_PROPOSAL_STATUS.ACCEPTED || text === PERSON_PROPOSAL_STATUS.REJECTED ? text : ''
}

/**
 * **防重键（§3）**：`(target_person_id, 姓名, 生卒, cbdb_id)` 的确定性拼接。
 * 「姓名」取 `family_name + given_name`（与显示名派生同源，但**不落第二份显示名** —— 本键只是
 * 去重标识，不是展示名）。
 * @returns {string}
 */
export function personProposalDedupeKey({ targetPersonId = null, familyName = '', givenName = '', birthYear = null, deathYear = null, cbdbId = '' } = {}) {
  const target = targetPersonId === null || targetPersonId === undefined ? '' : String(targetPersonId).trim()
  const name = `${String(familyName || '').trim()}${String(givenName || '').trim()}`
  const birth = birthYear === null || birthYear === undefined ? '' : String(birthYear)
  const death = deathYear === null || deathYear === undefined ? '' : String(deathYear)
  return [target, name, birth, death, String(cbdbId || '').trim()].join('|')
}

/* ------------------------------ 只读检索面 ------------------------------ */

/** 取正式印人行（原始行；显示名请经 `personName` / 数据层单点派生）。 */
export function listPersons() {
  return listPersonRows()
}

/** 印人显示名（**转发数据层单点**；不另立第二套名表）。 */
export function personName(row) {
  return personDisplayName(row)
}

/** 按 id 取正式印人（未命中 ⇒ `null`）。 */
export function person(id) {
  return personById(id)
}

/** 按 id 取印人显示名（未命中 ⇒ `''`）。 */
export function personNameOfId(id) {
  const row = personById(id)
  return row ? personDisplayName(row) : ''
}

/**
 * **印人检索**（供印面「作者」选人控件；§4.3）：关键字面扩到 `姓` / `名` / `字` / `号` / `别名` /
 * `cbdb_id`（子串、大小写不敏感）。空关键字 ⇒ 全量（调用方可自截断）。
 * @param {string} keyword
 * @returns {Array<object>} 命中的印人行
 */
export function searchPersons(keyword = '') {
  const kw = String(keyword || '').trim().toLowerCase()
  const rows = listPersonRows()
  if (!kw) return rows
  const hayOf = (row) => {
    const parts = [
      row && row.family_name,
      row && row.given_name,
      ...(Array.isArray(row && row.courtesy_names) ? row.courtesy_names : []),
      ...(Array.isArray(row && row.art_names) ? row.art_names : []),
      ...(Array.isArray(row && row.alias_names) ? row.alias_names : []),
      row && row.cbdb_id
    ]
    return parts
      .map((item) => String(item === null || item === undefined ? '' : item).toLowerCase())
      .join('\u0001')
  }
  return rows.filter((row) => hayOf(row).includes(kw))
}

/* ------------------------------ 提案：提交 ------------------------------ */

/** 当前（或指定）账号是否可审核印人提案 —— 供 `/my/corrections` 决定是否渲染采纳 / 驳回。 */
export function canReviewPersonProposals(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/**
 * **提交印人提案**（任何登录用户；§3）。
 *
 * 判定顺序（**全部在写之前**，拒绝即零写入）：① 登录门 → ② 目标印人（修改既有）存在性 →
 * ③ 至少一处姓名 / 字 / 号 / 别名 → ④ **防重键**（同键已有未驳回提案 ⇒ `DUPLICATE_VALUE`）。
 * @returns {{ok:true, row:object, message:string}|{ok:false, reason?:string, message:string}}
 */
export function submitPersonProposal({
  batchId = '',
  targetPersonId = null,
  familyName = '',
  givenName = '',
  courtesyNames = [],
  artNames = [],
  aliasNames = [],
  birthYear = null,
  deathYear = null,
  cbdbId = '',
  cardId = '',
  note = ''
} = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交印人提案' }

  const family = String(familyName || '').trim()
  const given = String(givenName || '').trim()
  const courtesy = toArray(courtesyNames)
  const art = toArray(artNames)
  const alias = toArray(aliasNames)
  if (!family && !given && courtesy.length === 0 && art.length === 0 && alias.length === 0) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '請至少填寫姓名、字、號或別名之一；本次零寫入。' }
  }

  const batch = String(batchId || '').trim()
  if (batch.length > MAX_PROPOSAL_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `提交單號超出上限（${MAX_PROPOSAL_ID_LENGTH} 字）；本次零寫入。` }
  }

  const target = targetPersonId === null || targetPersonId === undefined ? null : String(targetPersonId).trim() || null
  if (target && !personById(target)) {
    return { ok: false, reason: 'NOT_FOUND', message: `要修改的印人（${target}）不存在；本次零寫入。` }
  }

  const birth = toIntOrNull(birthYear)
  const death = toIntOrNull(deathYear)
  const cbdb = String(cbdbId || '').trim()
  const card = String(cardId || '').trim()

  const dedupe = personProposalDedupeKey({ targetPersonId: target, familyName: family, givenName: given, birthYear: birth, deathYear: death, cbdbId: cbdb })
  const duplicate = listPersonProposalRows().some(
    (row) => String((row && row.dedupe_key) || '') === dedupe && normalizeProposalStatus(row && row.status) !== PERSON_PROPOSAL_STATUS.REJECTED
  )
  if (duplicate) {
    return {
      ok: false,
      reason: 'DUPLICATE_VALUE',
      message: '同一印人（姓名 ＋ 生卒 ＋ cbdb_id）已有待審提案 ⇒ 只允許一人提交；本次零寫入。'
    }
  }

  const at = nowIso()
  const row = {
    id: makeProposalId(),
    batch_id: batch,
    target_person_id: target, // null ＝ 新增；非空 ＝ 修改既有（字段级粒度 ⇒ §8 待裁 W-f）
    status: PERSON_PROPOSAL_STATUS.PENDING,
    family_name: family,
    given_name: given,
    courtesy_names: courtesy,
    art_names: art,
    alias_names: alias,
    birth_year: birth,
    death_year: death,
    cbdb_id: cbdb,
    card_id: card,
    note: String(note || '').trim(),
    submitted_by: user.id, // **不透明 uid；零手机号**
    submitted_at: at,
    reviewed_at: null,
    reviewer_id: null,
    review_note: '',
    dedupe_key: dedupe
  }
  savePersonProposalRows([...listPersonProposalRows(), row])
  return { ok: true, row, message: '已提交印人提案，待管理員審覈' }
}

/* ------------------------------ 提案：读面 ------------------------------ */

/** 我的印人提案（提交人 ＝ 当前登录态）。 */
export function listMyPersonProposals() {
  const user = currentUser()
  if (!user) return []
  return listPersonProposalRows()
    .filter((row) => String((row && row.submitted_by) || '') === user.id)
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
}

/**
 * **管理员可见的待审印人提案**（全部用户的 `PENDING`）。
 * 非管理员 ⇒ **结构化拒绝**（`FORBIDDEN`；与勘误读面**同字面值**，不以空集冒充拒绝）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 */
export function listPendingPersonProposalsForAdmin(actor) {
  const who = actor || currentUser()
  if (!canReviewPersonProposals(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的待審印人提案' }
  }
  const rows = listPersonProposalRows()
    .filter((row) => normalizeProposalStatus(row && row.status) === PERSON_PROPOSAL_STATUS.PENDING)
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
  return { ok: true, rows }
}

/** 提交人展示名（`暱稱（uid 短碼）` 之流由视图提供；此处只回 uid，避免第二套名表）。 */
export function proposalSubmitterId(row) {
  return String((row && row.submitted_by) || '')
}

/* ------------------------------ 提案：采纳 / 驳回 ------------------------------ */

/**
 * **采纳路径的幂等生成 / 更新（§3）**：`ACCEPTED` ⇒ 幂等生成 `xiai_persons` 行
 * （`proposal_id` 溯源；**重复采纳不改写既有行**）。
 *
 * **本期只落「新增」形态**（`target_person_id === null`）：「修改既有印人」的**字段级粒度**
 * 属 §8 待裁 `W-f` ⇒ **本期不改写既有印人行**（如实登记，不擅自发明口径）。
 * @returns {object|null} 生成 / 命中的印人行；修改型裁定未落 ⇒ `null`
 */
function acceptPersonProposal(proposal, actor, at) {
  const persons = listPersonRows()
  /* 幂等：同一提案已产出印人行 ⇒ 原样返回（不新增第二行、不改写既有行）。 */
  const existing = persons.find((row) => String((row && row.proposal_id) || '') === String((proposal && proposal.id) || ''))
  if (existing) return existing
  if (proposal && proposal.target_person_id) {
    /* 修改既有：§8 待裁 W-f（字段级 vs 整行）⇒ 本期不改写既有行。 */
    return persons.find((row) => String((row && row.id) || '') === String(proposal.target_person_id)) || null
  }
  const code = nextPersonCode(persons)
  const row = {
    id: code, // 行主键（与 `code` 同值；系统生成、只读）
    code,
    ...emptyPersonFields(),
    family_name: String((proposal && proposal.family_name) || ''),
    given_name: String((proposal && proposal.given_name) || ''),
    courtesy_names: toArray(proposal && proposal.courtesy_names),
    art_names: toArray(proposal && proposal.art_names),
    alias_names: toArray(proposal && proposal.alias_names),
    birth_year: toIntOrNull(proposal && proposal.birth_year),
    death_year: toIntOrNull(proposal && proposal.death_year),
    cbdb_id: String((proposal && proposal.cbdb_id) || ''),
    card_id: String((proposal && proposal.card_id) || ''),
    proposal_id: String((proposal && proposal.id) || ''), // 溯源：产出本行的采纳提案
    created_by: actor && actor.id ? actor.id : '', // **不透明 uid；零手机号**
    created_at: at,
    updated_at: at
  }
  savePersonRows([...persons, row])
  return row
}

/**
 * **审核印人提案（采纳 / 驳回）**（管理员；§3）。
 *
 * 判定顺序（**全部在写之前**）：① 管理员门（非管理员 ⇒ `FORBIDDEN` ＋ 零写入）→
 * ② 提案存在性 → ③ 状态门（仅 `PENDING` 可审；`ALREADY_REVIEWED`）→ ④ 决定值域门。
 * `ACCEPTED` ⇒ 幂等生成印人行（`proposal_id` 溯源）；`REJECTED` ⇒ **零写入**（仅提案行状态）。
 * @returns {{ok:boolean, status?:string, accepted?:boolean, row?:object|null, reason?:string, message:string}}
 */
export function reviewPersonProposal(actor, proposalId, decision, note = '') {
  const who = actor || currentUser()
  if (!canReviewPersonProposals(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈印人提案' }
  }
  const rawNote = note === null || note === undefined ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；本次零寫入。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > MAX_REVIEW_NOTE_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `駁回理由不得超過 ${MAX_REVIEW_NOTE_LENGTH} 字；本次零寫入。` }
  }
  const id = String(proposalId === null || proposalId === undefined ? '' : proposalId).trim()
  if (!id) return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少要審覈的印人提案標識；本次零寫入。' }
  const normalized = normalizeDecision(decision)
  if (!normalized) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `審覈決定「${String(decision === null || decision === undefined ? '' : decision)}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）；本次零寫入。`
    }
  }
  const rows = listPersonProposalRows()
  const target = rows.find((row) => String((row && row.id) || '') === id)
  if (!target) return { ok: false, reason: 'NOT_FOUND', message: '未找到該印人提案；本次零寫入。' }
  if (normalizeProposalStatus(target.status) !== PERSON_PROPOSAL_STATUS.PENDING) {
    return { ok: false, reason: 'ALREADY_REVIEWED', message: '該印人提案已審覈，不可重複處理（終態不回退）；本次零寫入。' }
  }
  const accepted = normalized === PERSON_PROPOSAL_STATUS.ACCEPTED
  const at = nowIso()
  /* 先算采纳产物（幂等）—— 再落提案行状态；dev / 离线形态下两者都在本地。 */
  let personRow = null
  if (accepted) personRow = acceptPersonProposal(target, who, at)
  const decided = {
    ...target,
    status: normalized,
    reviewed_at: at,
    reviewer_id: who.id,
    review_note: !accepted && noteText !== '' ? noteText : target.review_note || ''
  }
  savePersonProposalRows(rows.map((row) => (String((row && row.id) || '') === id ? decided : row)))
  return {
    ok: true,
    status: normalized,
    accepted,
    row: personRow,
    message: accepted ? '已採納印人提案並生成正式印人' : '已駁回印人提案'
  }
}
