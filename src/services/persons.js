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
 * **写面接线（本单）**：
 *   · 两个写 op（`submitPersonProposal` / `reviewPersonProposal`）**已经 `userWriteGate` 接到既有
 *     云函数通道**（与 `corrections.submitCorrection` / `corrections.review` **同一通道**：含令牌自愈 /
 *     `dev`·離線 與 雲端 两形态 / 失败零写入 / 本机镜像回写）。云端命中：
 *     `submitPersonProposal` ∈ `xiai-user-token` 的 `OPS`；`reviewPersonProposal` ∈ 同函数 `ADMIN_OPS`
 *     （登录令牌 ＋ 手机号白名单）。两 `index.js` 皆为 `hasOwnProperty` 动态派发 ⇒ **未动云函数**。
 *   · **未覆盖（如实登记）**：**两集合尚待人工新建**（云控制台动作）⇒ **云端落库路径不可达**；
 *     故云端形态的端到端验证**当前不可验**（依赖未建集合 / 未部署）。本机（dev / 離線）形态可验。
 */

import { currentUser } from '../data/session.js'
import {
  listPersonRows,
  savePersonRows,
  listPersonProposalRows,
  savePersonProposalRows,
  personById,
  personDisplayName,
  nextPersonCode,
  /* **批 2 前置（v1.54）**：外部批量导入行的读 / 写 ＋ 幂等键 ＋ 单写者门。 */
  listPersonImportRows,
  savePersonImportRows,
  personBySourceId,
  personImportBySourceId,
  personDirectWriteDenial
} from '../data/db.js'
import { PERSON_PROPOSAL_STATUS, emptyPersonFields, PERSON_IMPORT_STATUS, PERSON_IMPORT_ID_PREFIX, emptyPersonImportPayload } from '../data/seed.js'
/* **登录令牌写面门（同一通道）**：与 `corrections.js` / `endorsements.js` / `admin.js` 的写 op
   一律经 `userWriteGate` —— 先保证有一枚可携带的令牌（必要时静默补签），再过云端门
   （`xiai-user-token` 的 `verify`）。**身份由服务端从令牌派生**，载荷里的身份类键由服务端拒。 */
import { userWriteGate } from './userWrite.js'

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
 * ③ 至少一处姓名 / 字 / 号 / 别名 → ④ **防重键**（同键已有未驳回提案 ⇒ `DUPLICATE_VALUE`）→
 * ⑤ **写面门**（`userWriteGate('submitPersonProposal', …)`；dev·離線 ⇒ 本地落盘，雲端 ⇒ 服务端落盘后镜像）。
 * @returns {Promise<{ok:true, row:object, message:string}|{ok:false, reason?:string, message:string}>}
 */
export async function submitPersonProposal({
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
  /* **批 2（v1.54｜§3.54.13 / §4.1.16；人类已拍 ①）**：用户提案表单亦收四扩字段
     （籍贯 / 传记 / 来源 / 来源 id）＋ 两繁简副字段。**只接收、不转改**（零繁简转换）。 */
  nativePlace = '',
  biography = '',
  source = '',
  sourceId = '',
  nativePlaceChs = '',
  biographyChs = '',
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

  /* **写面接线（本单）**：与既有写 op（`corrections.submitCorrection`）**同一通道** ——
     经登录令牌写面门 `userWriteGate`（含令牌自愈）。载荷键面**逐字**取服务端封闭面
     （云函数 `xiai-user-token/lib/ops.js::PERSON_PROPOSAL_ALLOWED_KEYS`：`batch_id` /
     `target_person_id` / `family_name` / `given_name` / `courtesy_names` / `art_names` /
     `alias_names` / `birth_year` / `death_year` / `cbdb_id` / `card_id` / `native_place` /
     `biography` / `source` / `source_id` / `native_place_chs` / `biography_chs` / `note`
     —— **恰 18 键，与云函数逐字同集**；批 2 由 12 键扩为 18 键）；
     **提交人由服务端从令牌派生**（载荷里的身份类键被服务端拒 ⇒ `INVALID_FIELD` ＋ 零写入）。 */
  const payload = {
    batch_id: batch,
    target_person_id: target,
    family_name: family,
    given_name: given,
    courtesy_names: courtesy,
    art_names: art,
    alias_names: alias,
    birth_year: birth,
    death_year: death,
    cbdb_id: cbdb,
    card_id: card,
    /* **四扩字段（正字段，繁体为正）＋ 两繁简副字段**：逐字透传，**不做任何转换改写**。 */
    native_place: String(nativePlace || ''),
    biography: String(biography || ''),
    source: String(source || ''),
    source_id: String(sourceId || ''),
    native_place_chs: String(nativePlaceChs || ''),
    biography_chs: String(biographyChs || ''),
    note: String(note || '').trim()
  }
  const gate = await userWriteGate('submitPersonProposal', payload)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    /* dev / 離線形態：本地落盤（**非正式寫入路徑**；身份 ＝ 本地 `user.id`）。 */
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
      /* **四扩字段 ＋ 两繁简副字段**（local-dev 本地权威行；逐字透传，零转换）。 */
      native_place: String(nativePlace || ''),
      biography: String(biography || ''),
      source: String(source || ''),
      source_id: String(sourceId || ''),
      native_place_chs: String(nativePlaceChs || ''),
      biography_chs: String(biographyChs || ''),
      note: String(note || '').trim(),
      submitted_by: user.id, // **不透明 uid；零手机号**
      submitted_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: '',
      dedupe_key: dedupe
    }
    savePersonProposalRows([...listPersonProposalRows(), row])
    return {
      ok: true,
      row,
      authority: 'LOCAL_DEV',
      message: '已提交印人提案，待管理員審覈（dev / 離線形態，非正式寫入路徑）'
    }
  }

  /* 雲端形態：**服務端已落盤** ⇒ 本地只寫服務端回傳的那一行（鏡像；身份／時間／狀態皆為服務端值）。 */
  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return {
      ok: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。'
    }
  }
  savePersonProposalRows([...listPersonProposalRows(), serverRow])
  return {
    ok: true,
    row: serverRow,
    authority: 'SERVER',
    docId: gate.docId,
    message: '已提交印人提案，待管理員審覈'
  }
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
    /* **批 2（v1.54｜§3.54.13 / §4.1.16）**：采纳提案落 `xiai_persons` 行时**带上六扩字段**
       （四正字段 ＋ 两繁简副字段；值来自提案行，**不做任何转换改写**）。 */
    native_place: String((proposal && proposal.native_place) || ''),
    biography: String((proposal && proposal.biography) || ''),
    source: String((proposal && proposal.source) || ''),
    source_id: String((proposal && proposal.source_id) || ''),
    native_place_chs: String((proposal && proposal.native_place_chs) || ''),
    biography_chs: String((proposal && proposal.biography_chs) || ''),
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
 * @returns {Promise<{ok:boolean, status?:string, accepted?:boolean, row?:object|null, reconciled?:boolean, reason?:string, message:string}>}
 */
export async function reviewPersonProposal(actor, proposalId, decision, note = '') {
  const who = actor || currentUser()
  if (!canReviewPersonProposals(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈印人提案' }
  }
  /* **写面接线（本单）**：与 `corrections.review` **同一通道** —— 登录令牌写面门 `userWriteGate`
     （含令牌自愈）。载荷键面**逐字**取服务端封闭面
     （云函数 `xiai-user-token/lib/ops.js::PERSON_REVIEW_ALLOWED_KEYS` ＝ `proposal_id` / `decision` / `note`）；
     **审核人由服务端从令牌派生**（登录令牌 ＋ 手机号 ∈ 管理员白名单）。失败 ⇒ 零写入。 */
  const gate = await userWriteGate('reviewPersonProposal', {
    proposal_id: String(proposalId === null || proposalId === undefined ? '' : proposalId),
    decision: String(decision === null || decision === undefined ? '' : decision),
    note: String(note === null || note === undefined ? '' : note)
  })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  /* ② 本機鏡像（dev / 離線 ＝ 本地權威；雲端 ＝ 服務端權威後的本機鏡像）。 */
  const decided = applyPersonProposalDecision(who, proposalId, decision, note)
  /* ②-a **雲端權威優先**：雲端門已成功落盤，但本機鏡像未成功（`NOT_FOUND` / `ALREADY_REVIEWED`…）
     ⇒ **不得當失敗返回**：以服務端權威行更正本機鏡像行（本機無該行 ⇒ 如實回本地判定，不編造）。 */
  if (!decided.ok && gate.mode === 'cloud' && gate.row && typeof gate.row === 'object') {
    const reconciled = mirrorPersonProposalFromAuthority(gate.row)
    if (reconciled) {
      const accepted = reconciled.status === PERSON_PROPOSAL_STATUS.ACCEPTED
      return {
        ok: true,
        status: reconciled.status,
        accepted,
        row: null,
        reconciled: true,
        message: `雲端已${accepted ? '採納' : '駁回'}印人提案；本機鏡像已按雲端權威更正。`
      }
    }
  }
  return decided
}

/**
 * 本地審覈判定（**不經寫面門**）：供 `reviewPersonProposal` 過門後回寫本機鏡像 /
 * 在 dev·離線形態作**本地權威**。返回形狀與接线前**逐字一致**。
 * @returns {{ok:boolean, status?:string, accepted?:boolean, row?:object|null, reason?:string, message:string}}
 */
function applyPersonProposalDecision(who, proposalId, decision, note) {
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

/**
 * **本機鏡像更正（雲端權威優先）**：用服務端回傳的權威提案行覆蓋本機同名行（`id` 配对；逐键合并、
 * 服務端优先）。本機無該行 ⇒ 返回 `null`（**不編造**，调用方退回本地判定）。
 * @param {object} serverRow 服務端權威行（`gate.row`）
 * @returns {object|null} 更正后的本机行；本机无该行 ⇒ `null`
 */
function mirrorPersonProposalFromAuthority(serverRow) {
  const id = String((serverRow && serverRow.id) || '').trim()
  if (!id) return null
  const rows = listPersonProposalRows()
  const index = rows.findIndex((row) => String((row && row.id) || '') === id)
  if (index === -1) return null
  const merged = { ...rows[index], ...serverRow }
  const next = rows.slice()
  next[index] = merged
  savePersonProposalRows(next)
  return merged
}

/* ============================================================================
   **印人批 2 前置（v1.54｜§3.54.13 〜 §3.54.16 / §4.1.16）：外部批量导入通道 ＋ 管理员批量采纳通道**
   ----------------------------------------------------------------------------
   · 导入（提交）＝ **外部批量导入通道**（服务端 / 采集侧）：经 `userWriteGate('submitPersonImport', …)`
     落 `xiai_person_imports` 的 `PENDING` 行（**幂等键 `source_person_id`**；重复导入不改写既有行）。
   · 采纳 / 驳回 ＝ **管理员**（登录令牌 ＋ 手机号白名单，沿 §3.48；缺 env ⇒ 安全拒 ＋ 零写入）。
     `ACCEPTED` ⇒ **幂等**落 `xiai_persons`（按 `source_person_id` 幂等；重复采纳**不改写既有行**，
     并带上 person 六扩字段）；`REJECTED` ⇒ **零写入**（仅导入行状态）。三态单向、终态不回退。
   · **采纳粒度（W-77 拟案）**：**两个入口都实现** —— 按批次（`batchId`）与按单行（`importId`）；
     部分失败 ⇒ **失败行保持 `PENDING` 且零写入**、成功行落库；成功面**可重放且幂等**。
   · **零新增 `reason` 字面值**（一律沿用既有冻结表）。
   ============================================================================ */

/** 导入行三态（转发真源 `seed.js::PERSON_IMPORT_STATUS`；单向、终态不回退）。 */
export const PERSON_IMPORT_STATUS_EXPORT = PERSON_IMPORT_STATUS

/** 当前（或指定）账号是否可审核外部导入批次 —— 供 `/my/corrections` 决定是否渲染采纳 / 驳回。 */
export function canReviewPersonImports(actor) {
  const who = actor || currentUser()
  return who !== null && who !== undefined && who.role === 'admin'
}

/** 归一化载荷 → 导入行载荷面（数组 / 整数 / 文本；**不做繁简转换**）。 */
function normalizeImportPayload(source) {
  const src = source && typeof source === 'object' ? source : {}
  return {
    name_full: String(src.name_full || '').trim(),
    family_name: String(src.family_name || '').trim(),
    given_name: String(src.given_name || '').trim(),
    courtesy_names: toArray(src.courtesy_names),
    art_names: toArray(src.art_names),
    alias_names: toArray(src.alias_names),
    birth_year: toIntOrNull(src.birth_year),
    death_year: toIntOrNull(src.death_year),
    native_place: String(src.native_place || ''),
    native_place_chs: String(src.native_place_chs || ''),
    biography: String(src.biography || ''),
    biography_chs: String(src.biography_chs || ''),
    nationality: String(src.nationality || '').trim(),
    cbdb_id: String(src.cbdb_id || '').trim(),
    source_id: String(src.source_id || '').trim()
  }
}

/** 导入行 → person 行（**采纳落行**：带上 person 四扩字段 ＋ 两副字段 ＋ 幂等键 `source_person_id`）。 */
function buildPersonRowFromImport(importRow, persons, actor, at) {
  const code = nextPersonCode(persons)
  return {
    id: code,
    code,
    ...emptyPersonFields(),
    family_name: String((importRow && importRow.family_name) || ''),
    given_name: String((importRow && importRow.given_name) || ''),
    courtesy_names: toArray(importRow && importRow.courtesy_names),
    art_names: toArray(importRow && importRow.art_names),
    alias_names: toArray(importRow && importRow.alias_names),
    birth_year: toIntOrNull(importRow && importRow.birth_year),
    death_year: toIntOrNull(importRow && importRow.death_year),
    cbdb_id: String((importRow && importRow.cbdb_id) || ''),
    card_id: '',
    /* **person 六扩字段（值来自采纳的导入行；不做任何转换改写）**。 */
    native_place: String((importRow && importRow.native_place) || ''),
    biography: String((importRow && importRow.biography) || ''),
    source: String((importRow && importRow.source) || ''),
    source_id: String((importRow && importRow.source_id) || ''),
    native_place_chs: String((importRow && importRow.native_place_chs) || ''),
    biography_chs: String((importRow && importRow.biography_chs) || ''),
    source_person_id: String((importRow && importRow.source_person_id) || ''), // **幂等键（溯源）**
    proposal_id: '', // 导入通道产出（非提案通道）⇒ 空
    created_by: actor && actor.id ? actor.id : '', // **不透明 uid；零手机号**
    created_at: at,
    updated_at: at
  }
}

/* ------------------------------ 导入：提交（外部通道） ------------------------------ */

/**
 * **提交外部导入行**（导入通道；任何登录用户。§3.54.14 / §3.54.15）。
 *
 * 判定顺序（**全部在写之前**，拒绝即零写入）：① 登录门 → ② 幂等键（`source_person_id`）必有 /
 * 形态 → ③ **幂等**（同 `source_person_id` 已有行 ⇒ 原样返回、**不改写既有行**）→
 * ④ 至少一处姓名 / 字 / 号 / 别名 → ⑤ **写面门**（`userWriteGate('submitPersonImport', …)`）。
 * @returns {Promise<{ok:true, row:object, authority:string, idempotent?:boolean, message:string}|{ok:false, reason?:string, message:string}>}
 */
export async function submitPersonImport({
  batchId = '',
  source = '',
  sourcePersonId = '',
  payload = {}
} = {}) {
  const user = currentUser()
  if (!user) return { ok: false, message: '請先登錄後再提交外部導入行' }

  const batch = String(batchId || '').trim()
  if (batch.length > MAX_PROPOSAL_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `導入批次號超出上限（${MAX_PROPOSAL_ID_LENGTH} 字）；本次零寫入。` }
  }
  const src = String(source || '').trim()
  const sourceId = String(sourcePersonId || '').trim()
  if (!sourceId) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少外部冪等鍵（source_person_id）⇒ 拒絕導入；本次零寫入。' }
  }
  if (sourceId.length > MAX_PROPOSAL_ID_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `外部冪等鍵超出上限（${MAX_PROPOSAL_ID_LENGTH} 字）；本次零寫入。` }
  }
  const norm = normalizeImportPayload(payload)
  if (
    !norm.family_name &&
    !norm.given_name &&
    norm.courtesy_names.length === 0 &&
    norm.art_names.length === 0 &&
    norm.alias_names.length === 0
  ) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '導入行請至少帶姓名、字、號或別名之一；本次零寫入。' }
  }

  /* **幂等**（§3.54.14）：同 `source_person_id` 已有導入行 ⇒ 原樣返回（不改寫既有行）。 */
  const existing = personImportBySourceId(sourceId)
  if (existing) {
    return { ok: true, row: existing, authority: 'LOCAL_IDEMPOTENT', idempotent: true, message: '該外部冪等鍵（source_person_id）已存在導入行 ⇒ 未改寫（冪等）。' }
  }

  const writePayload = {
    batch_id: batch,
    source: src,
    source_person_id: sourceId,
    ...norm
  }
  const gate = await userWriteGate('submitPersonImport', writePayload)
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }

  if (gate.mode === 'local-dev') {
    const at = nowIso()
    const row = {
      id: `${PERSON_IMPORT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      batch_id: batch,
      source: src,
      source_person_id: sourceId,
      status: PERSON_IMPORT_STATUS.PENDING,
      ...norm,
      imported_by: user.id, // **不透明 uid；零手机号**
      imported_at: at,
      reviewed_at: null,
      reviewer_id: null,
      review_note: ''
    }
    savePersonImportRows([...listPersonImportRows(), row])
    return { ok: true, row, authority: 'LOCAL_DEV', message: '已提交外部導入行，待管理員審覈（dev / 離線形態，非正式寫入路徑）' }
  }

  const serverRow = gate.row
  if (!serverRow || typeof serverRow !== 'object') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '雲端回傳缺少權威行，無法確認寫入內容；本機未鏡像（雲端是否已寫入未知）。' }
  }
  savePersonImportRows([...listPersonImportRows(), serverRow])
  return { ok: true, row: serverRow, authority: 'SERVER', docId: gate.docId, message: '已提交外部導入行，待管理員審覈' }
}

/* ------------------------------ 导入：读面（管理员） ------------------------------ */

/**
 * **管理员可见的待审外部导入行**（全部用户的 `PENDING`）。
 * 非管理员 ⇒ **结构化拒绝**（`FORBIDDEN`；不以空集冒充拒绝）。
 * @returns {{ok:true, rows:Array<object>}|{ok:false, reason:string, message:string}}
 */
export function listPendingPersonImportsForAdmin(actor) {
  const who = actor || currentUser()
  if (!canReviewPersonImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以查看全部用戶的外部導入批次' }
  }
  const rows = listPersonImportRows()
    .filter((row) => String((row && row.status) || '') === PERSON_IMPORT_STATUS.PENDING || !(row && row.status))
    .sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)))
  return { ok: true, rows }
}

/* ------------------------------ 导入：采纳 / 驳回（管理员） ------------------------------ */

/**
 * **本地采纳 / 驳回判定（不經写面门）**：供 `reviewPersonImport` 过门后回写本机镜像 /
 * 在 dev·離線 形态作**本地权威**。
 * 采纳粒度：按批次（`batchId`）或按单行（`importId`）二选一（**两个入口都实现**）。
 * **部分失败**：失败行保持 `PENDING` 且零写入；成功行落库；成功面**可重放且幂等**。
 * @returns {{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[], skipped?:string[], failed?:Array<object>, rows?:Array<object>, reason?:string, message:string}}
 */
function applyPersonImportDecision(who, { batchId = '', importId = '', decision = '', note = '' } = {}) {
  const rawNote = note === null || note === undefined ? '' : note
  if (typeof rawNote !== 'string') {
    return { ok: false, reason: 'INVALID_VALUE', message: '駁回理由必須是文字；本次零寫入。' }
  }
  const noteText = rawNote.trim()
  if (noteText.length > MAX_REVIEW_NOTE_LENGTH) {
    return { ok: false, reason: 'INVALID_VALUE', message: `駁回理由不得超過 ${MAX_REVIEW_NOTE_LENGTH} 字；本次零寫入。` }
  }
  const batch = String(batchId || '').trim()
  const single = String(importId || '').trim()
  if (!batch && !single) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少導入批次號（batch_id）或導入行號（import_id）⇒ 拒絕審覈；本次零寫入。' }
  }
  const normalized = normalizeDecision(decision)
  if (!normalized) {
    return {
      ok: false,
      reason: 'INVALID_VALUE',
      message: `審覈決定「${String(decision === null || decision === undefined ? '' : decision)}」不在允許的 2 類之內（ACCEPTED 採納 / REJECTED 駁回）；本次零寫入。`
    }
  }
  const accepted = normalized === PERSON_IMPORT_STATUS.ACCEPTED
  const at = nowIso()
  const imports = listPersonImportRows()
  /* 选目标：单行优先（指定 `importId`）；否则全批次内 `PENDING` 行。 */
  const targets = imports.filter((row) => {
    if (!row) return false
    if (single) return String(row.id || '') === single
    return String(row.batch_id || '') === batch
  })
  if (targets.length === 0) {
    return { ok: false, reason: 'NOT_FOUND', message: '未找到匹配的外部導入行（批次 / 單行）；本次零寫入。' }
  }

  const acceptedIds = []
  const rejectedIds = []
  const skipped = []
  const failed = []
  const persons = listPersonRows()
  const nextPersons = persons.slice()
  const decidedById = new Map()

  targets.forEach((row) => {
    const current = String(row.status || PERSON_IMPORT_STATUS.PENDING)
    if (current !== PERSON_IMPORT_STATUS.PENDING) {
      /* 终态不回退：已审行**跳过**（幂等重放 / 部分失败场景均不改写既有终态）。 */
      skipped.push(String(row.id || ''))
      return
    }
    if (!accepted) {
      rejectedIds.push(String(row.id || ''))
      decidedById.set(String(row.id || ''), {
        ...row,
        status: PERSON_IMPORT_STATUS.REJECTED,
        reviewed_at: at,
        reviewer_id: who.id,
        review_note: noteText !== '' ? noteText : row.review_note || ''
      })
      return
    }
    /* **ACCEPTED**：按 `source_person_id` 幂等落 `xiai_persons`（重复采纳不改写既有行）。 */
    const sourceId = String(row.source_person_id || '').trim()
    if (!sourceId) {
      /* 幂等键缺失 ⇒ **该行失败、保持 PENDING 且零写入**（不动 person、不改本行）。 */
      failed.push({ id: String(row.id || ''), reason: 'MISSING_REQUIRED', message: '該導入行缺少冪等鍵（source_person_id）⇒ 未採納；本行保持 PENDING。' })
      return
    }
    const existingPerson = personBySourceId(sourceId)
    if (!existingPerson) {
      const built = buildPersonRowFromImport(row, nextPersons, who, at)
      nextPersons.push(built)
    }
    acceptedIds.push(String(row.id || ''))
    decidedById.set(String(row.id || ''), {
      ...row,
      status: PERSON_IMPORT_STATUS.ACCEPTED,
      reviewed_at: at,
      reviewer_id: who.id,
      review_note: row.review_note || ''
    })
  })

  /* **成功面**：先落采纳产物（幂等）—— 再落导入行状态；两者都在本地（dev / 離線 ＝ 本地权威）。 */
  if (acceptedIds.length > 0) savePersonRows(nextPersons)
  if (decidedById.size > 0) {
    savePersonImportRows(imports.map((row) => {
      const id = String((row && row.id) || '')
      return decidedById.has(id) ? decidedById.get(id) : row
    }))
  }
  const done = acceptedIds.length + rejectedIds.length
  return {
    ok: true,
    accepted,
    accepted_ids: acceptedIds,
    rejected_ids: rejectedIds,
    skipped,
    failed,
    rows: targets.map((row) => decidedById.get(String(row.id || '')) || row),
    message: accepted
      ? `已採納 ${acceptedIds.length} 條外部導入行並冪等生成正式印人（失敗 ${failed.length} / 跳過 ${skipped.length}）`
      : `已駁回 ${rejectedIds.length} 條外部導入行（跳過 ${skipped.length}）`
  }
}

/**
 * **审核外部导入行（采纳 / 驳回）**（管理员；§3.54.15）。
 *
 * 判定顺序（**全部在写之前**）：① 管理员门（非管理员 ⇒ `FORBIDDEN` ＋ 零写入）→
 * ② 经登录令牌写面门 `userWriteGate('reviewPersonImport', …)`（缺 env ⇒ 安全拒 ＋ 零写入）。
 * `ACCEPTED` ⇒ 幂等落 `xiai_persons`（按 `source_person_id`）；`REJECTED` ⇒ 零写入。
 * **两个入口都实现**：按批次（`batchId`）与按单行（`importId`）。
 * @param {{id?:string, role?:string}|null} actor 管理员
 * @param {{batchId?:string, importId?:string, decision?:string, note?:string}} [options]
 * @returns {Promise<{ok:boolean, accepted?:boolean, accepted_ids?:string[], rejected_ids?:string[], skipped?:string[], failed?:Array<object>, rows?:Array<object>, reason?:string, message:string}>}
 */
export async function reviewPersonImport(actor, options = {}) {
  const who = actor || currentUser()
  if (!canReviewPersonImports(who)) {
    return { ok: false, reason: 'FORBIDDEN', message: '僅管理員可以審覈外部導入批次' }
  }
  const gate = await userWriteGate('reviewPersonImport', {
    batch_id: String((options && options.batchId) || ''),
    import_id: String((options && options.importId) || ''),
    decision: String((options && options.decision) || ''),
    note: String((options && options.note) || '')
  })
  if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
  /* 本機鏡像（dev / 離線 ＝ 本地權威；雲端 ＝ 服務端權威後的本機鏡像）。 */
  return applyPersonImportDecision(who, options)
}

/** 单写者门转发（供视图 / 自检直调；两集合均不开放直写入口）。 */
export function personSingleWriterDenial(collectionKey) {
  return personDirectWriteDenial(collectionKey)
}

/** 导入行提交人展示 uid（**零手机号**；此处只回 uid，避免第二套名表）。 */
export function importSubmitterId(row) {
  return String((row && row.imported_by) || '')
}

/** 导入载荷默认面（转发真源 `seed.js::emptyPersonImportPayload`；供构造 / 自检复用）。 */
export { emptyPersonImportPayload }
