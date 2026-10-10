
<script setup>
/**
 * 我的勘误记录。
 *
 * - 普通用户 / 游客：只看到**自己**提交的勘误，**没有任何审核按钮**。
 * - 管理员：本页是勘误审核的载体（不再是独立页面 / 页签）——上方列出**全部用户**的
 *   待审勘误，每条带「采纳 / 驳回」按钮；下方仍可看到自己的提交明细。
 *   审核动作是奖励的唯一触发路径（采纳 +10 金且每条只奖一次）。
 * 按钮一律**条件渲染**（`v-if`），判定来自服务层 `canReviewCorrections(actor)`；
 * 数据层对越权写另有独立拒绝，不因界面变化而放宽。
 */

import { computed, ref } from 'vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { corrections, persons, points, seals } from '../services/index.js'
import { currentUser } from '../data/session.js'
import { statusLabel, formatDateTime } from '../utils/format.js'

/* 任何一次审核 / 提交后 +1，使下面的派生读数重算。 */
const dataVersion = ref(0)
const feedback = ref('')

/* ============================================================================
   **V3 撤除「校驗碼彈窗」**（2026-10-04）
   ----------------------------------------------------------------------------
   采纳 / 驳回已收敛到「一枚登录令牌 ＋ 手机号白名单」⇒ **不再有校驗碼弹窗 / 输入位**；
   令牌的「取 / 补签（刷新后）」收口在服务层单点（`services/userWrite.js`），
   本页**直接调** `corrections.review / reviewBatch`（零弹窗、零校驗碼输入位钩子）。
   ============================================================================ */

const actor = computed(() => currentUser())
/* 管理员专属「采纳 / 驳回」按钮的渲染条件（服务层判定；普通用户 / 游客 ⇒ false）。 */
const canReview = computed(() => corrections.canReviewCorrections(actor.value))

/* ============================================================================
   **印人提案审核区块（person-model §4.3.3 / §3.54；本单新增）**
   ----------------------------------------------------------------------------
   管理员视角在**本页**新增「待審印人提案（全部用戶）」的采纳 / 驳回区块 ——
   **复用既有按钮形态**、**不新开路由 / 不新建管理员专区**（落点 ＝ §3.9 追加注（v1.53））。
   - 采纳 / 驳回 ＝ **管理员**：入口仅管理员渲染（非管理员 ⇒ DOM 零命中，不得 CSS 隐藏冒充）；
     服务层 / 数据层对越权另有**独立拒绝**（`FORBIDDEN` ＋ 零写入）。
   - 钩子族：新增**恰 1 个** `data-admin-action` 取值 `person-proposal-review`
     （采纳 / 驳回**共用**；**不复用既有 `correction-accept` 等字面值承载新实体**）
     ⇒ `[data-admin-action]` 由 8 值 / 归并 7 类 变为 **9 值 / 归并 8 类**。
   ============================================================================ */
const canReviewProposals = computed(() => persons.canReviewPersonProposals(actor.value))
/** 待审印人提案（结构化结果：拒绝 ⇒ `ok:false`，**不以空集冒充拒绝**）。 */
const proposalResult = computed(() => {
  void dataVersion.value
  return persons.listPendingPersonProposalsForAdmin(actor.value)
})
const proposals = computed(() => (proposalResult.value.ok ? proposalResult.value.rows : []))
const proposalNotice = computed(() => (proposalResult.value.ok ? '' : proposalResult.value.message))

/** 提案提交人展示名（沿服务层单点 `submitterLabelOf`：`暱稱（uid 短碼）`，零手机号）。 */
function proposalSubmitterOf(row) {
  return corrections.submitterLabelOf(persons.proposalSubmitterId(row))
}

/** 提案印人显示名（服务层单点 `personName`；空 ⇒ 空串，模板显示「（未命名）」）。 */
function proposalNameOf(row) {
  return persons.personName(row)
}

/** 生卒上屏（「不详」＝空，不设特值；两端皆空 ⇒ 「—」）。 */
function proposalYearsOf(row) {
  const birth = row && row.birth_year !== null && row.birth_year !== undefined ? String(row.birth_year) : ''
  const death = row && row.death_year !== null && row.death_year !== undefined ? String(row.death_year) : ''
  if (!birth && !death) return '—'
  return `${birth || '?'}～${death || '?'}`
}

/** 采纳 / 驳回一条印人提案（服务层判定与幂等生成 / 更新；`message` 原文上屏）。
 *
 *  `reviewPersonProposal` 已改 **`async`**（经登录令牌写面门 `userWriteGate` 同一通道，与
 *  `corrections.review` 同径）⇒ 宿主函数亦须 `async` 并 `await`；否则拿到的是 Promise
 *  （`result.message` 恒 `undefined`，且 `dataVersion` 在落盘前即自增 ⇒ UI 不按结果更新）。
 *  返回契约（`persons.js::reviewPersonProposal`）：成功 / 失败皆回 `{ok, …, message}`——
 *  `ACCEPTED` ⇒ `{ok:true, status, accepted:true, row, message:'已採納…'}`；`REJECTED` ⇒
 *  `{ok:true, status, accepted:false, row:null, message:'已駁回…'}`；`FORBIDDEN` /
 *  `ALREADY_REVIEWED` / `NOT_FOUND` 等 ⇒ `{ok:false, reason, message}`。故一律以
 *  `result.message` 原文上屏，**拒绝不折回「假成功」**（沿用既有 `runReview` 口径）。 */
async function decideProposal(row, decision) {
  const result = await persons.reviewPersonProposal(actor.value, row.id, decision, '')
  feedback.value = result.message
  dataVersion.value += 1
}

/* ============================================================================
   **待審導入批次審核區塊（印人批 2｜§3.54.15 / §4.1.16 / AC-490；本单新增）**
   ----------------------------------------------------------------------------
   管理员视角在**本页**新增「待審導入批次（外部批量導入）」的采纳 / 驳回区块 ——
   **复用既有采纳 / 驳回形态与二次确认体例（沿 §3.44.10 / W-78）**；**不新开路由 / 专区**。
   - 采纳 / 驳回 ＝ **管理员**：入口仅管理员渲染（非管理员 ⇒ DOM 零命中，不得 CSS 隐藏冒充）；
     服务层 / 数据层对越权另有**独立拒绝**（`FORBIDDEN` ＋ 零写入）。
   - 钩子族：新增**恰 1 个** `data-admin-action` 取值 `person-import-review`
     （采纳 / 驳回**共用**；**不复用既有字面值**）＋ `data-action`（person-import-accept / reject）
     ⇒ `[data-admin-action]` 由 9 值 / 归并 8 类 变为 **10 值 / 归并 9 类**（v1.54）。
   - 采纳粒度（W-77 拟案）：**两个入口都实现** —— 按批次（整批）与按单行（逐条）。
   ============================================================================ */
const canReviewImports = computed(() => persons.canReviewPersonImports(actor.value))
/** 待审外部导入行（结构化结果：拒绝 ⇒ `ok:false`，不以空集冒充拒绝）。 */
const importResult = computed(() => {
  void dataVersion.value
  return persons.listPendingPersonImportsForAdmin(actor.value)
})
const importRows = computed(() => (importResult.value.ok ? importResult.value.rows : []))
const importNotice = computed(() => (importResult.value.ok ? '' : importResult.value.message))
/** 按批次（`batch_id`）分组（视图层分组；单批内逐条采纳仍保留）。 */
const importBatches = computed(() => {
  const groups = new Map()
  importRows.value.forEach((row) => {
    const key = String((row && row.batch_id) || '（無批次）')
    if (!groups.has(key)) groups.set(key, { key, batchId: String((row && row.batch_id) || ''), rows: [] })
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})
/** 导入行外部来源 id（幂等键；零手机号）。 */
function importSourceIdOf(row) {
  return String((row && row.source_person_id) || '')
}
/** 导入行导入人展示名（服务层单点：`暱稱（uid 短碼）`，零手机号）。 */
function importSubmitterOf(row) {
  return corrections.submitterLabelOf(persons.importSubmitterId(row))
}
/** 导入行姓名上屏（服务层单点派生；空 ⇒ 回落 `name_full`）。 */
function importNameOf(row) {
  return persons.personName(row) || String((row && row.name_full) || '')
}

/** 二次确认状态（`null` ＝ 未打开）；粒度：按批次（`batch`）/ 按单行（`row`）。 */
const importDialog = ref(null)
const importNote = ref('')
const importBusy = ref(false)

function askImport(target, decision) {
  importNote.value = ''
  importDialog.value = { batch: target.batch || null, row: target.row || null, decision }
}

function cancelImport() {
  importDialog.value = null
}

const importConfirmText = computed(() =>
  importDialog.value && importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '確認採納' : '確認駁回'
)
const importDialogTitle = computed(() => {
  if (!importDialog.value) return ''
  const scope = importDialog.value.row ? '單行' : '整批'
  return `${scope}${importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'}`
})
const importDialogMessage = computed(() => {
  if (!importDialog.value) return ''
  const { batch, row, decision } = importDialog.value
  const verb = decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'
  const count = row ? 1 : batch ? batch.rows.length : 0
  const who = row ? importSourceIdOf(row) : batch ? batch.key : ''
  return `這將對「${who}」的 ${count} 條外部導入行全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const importConfirmAction = computed(() => {
  if (!importDialog.value) return ''
  return importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED
    ? 'person-import-confirm-accept'
    : 'person-import-confirm-reject'
})
const IMPORT_CANCEL_ACTION = 'person-import-cancel'

async function confirmImport() {
  const dialog = importDialog.value
  if (!dialog || importBusy.value) return
  const note = dialog.decision === persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED ? importNote.value : ''
  importBusy.value = true
  try {
    /* 两个入口：按单行（`importId`）优先；否则按批次（`batchId`）。服务层 message 原文上屏。 */
    const options = dialog.row
      ? { importId: String(dialog.row.id || ''), decision: dialog.decision, note }
      : { batchId: String((dialog.batch && dialog.batch.batchId) || ''), decision: dialog.decision, note }
    const result = await persons.reviewPersonImport(actor.value, options)
    feedback.value = result.message
    importDialog.value = null
    dataVersion.value += 1
  } finally {
    importBusy.value = false
  }
}

/* ============================================================================
   **印章導入待審行（批 3｜v1.55 §3.55.8 / §4.1.17；本单新增）**
   ----------------------------------------------------------------------------
   与上方「印人导入」区块**同屏、合并为一个区块**（人类 2026-10-10 拍定）：
   - 待审源 ＝ 服务层既有 `seals.listPendingSealImportsForAdmin(actor)`；
     采纳 / 驳回走服务层既有 `seals.reviewSealImport(actor, {...})`（**视图不重建业务逻辑**）。
   - **共用同一钩子值** `person-import-review` ⇒ `[data-admin-action]` **不新增取值**
     （仍恰 10 值 / 归并 9 类）。
   - 非管理员 ⇒ **不渲染**（条件渲染；不得 CSS 隐藏 / `disabled` 冒充）。
   - 驳回理由上限用服务层单点 `seals.MAX_SEAL_REVIEW_NOTE_LENGTH`。
   ============================================================================ */
const canReviewSealImports = computed(() => seals.canReviewSealImports(actor.value))
const sealImportResult = computed(() => {
  void dataVersion.value
  return seals.listPendingSealImportsForAdmin(actor.value)
})
const sealImportRows = computed(() => (sealImportResult.value.ok ? sealImportResult.value.rows : []))
const sealImportNotice = computed(() => (sealImportResult.value.ok ? '' : sealImportResult.value.message))
/** 按批次（`batch_id`）分组（视图层分组；单批内逐条采纳仍保留，与印人导入同型）。 */
const sealImportBatches = computed(() => {
  const groups = new Map()
  sealImportRows.value.forEach((row) => {
    const key = String((row && row.batch_id) || '（無批次）')
    if (!groups.has(key)) groups.set(key, { key, batchId: String((row && row.batch_id) || ''), rows: [] })
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})
/** 印章導入行外部来源 id（幂等键；零手机号）。 */
function sealImportSourceIdOf(row) {
  return String((row && row.source_seal_id) || '')
}
/** 印章導入行导入人展示名（服务层单点：`暱稱（uid 短碼）`，零手机号）。 */
function sealImportSubmitterOf(row) {
  return corrections.submitterLabelOf(seals.sealImportSubmitterId(row))
}
/** 印章導入行印名上屏（缺 ⇒ 模板回落「（未命名）」）。 */
function sealImportNameOf(row) {
  return String((row && row.seal_name) || '')
}
/** 印章導入行印面数（同屏读数；缺 ⇒ 0）。 */
function sealImportFaceCountOf(row) {
  return Array.isArray(row && row.faces) ? row.faces.length : 0
}

/** 印章导入二次确认状态（`null` ＝ 未打开）；粒度：按批次（`batch`）/ 按单行（`row`）。 */
const sealImportDialog = ref(null)
const sealImportNote = ref('')
const sealImportBusy = ref(false)

function askSealImport(target, decision) {
  sealImportNote.value = ''
  sealImportDialog.value = { batch: target.batch || null, row: target.row || null, decision }
}

function cancelSealImport() {
  sealImportDialog.value = null
}

const sealImportConfirmText = computed(() =>
  sealImportDialog.value && sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '確認採納' : '確認駁回'
)
const sealImportDialogTitle = computed(() => {
  if (!sealImportDialog.value) return ''
  const scope = sealImportDialog.value.row ? '單行' : '整批'
  return `${scope}${sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'}`
})
const sealImportDialogMessage = computed(() => {
  if (!sealImportDialog.value) return ''
  const { batch, row, decision } = sealImportDialog.value
  const verb = decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'
  const count = row ? 1 : batch ? batch.rows.length : 0
  const who = row ? sealImportSourceIdOf(row) : batch ? batch.key : ''
  return `這將對「${who}」的 ${count} 條印章外部導入行全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const sealImportConfirmAction = computed(() => {
  if (!sealImportDialog.value) return ''
  return sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED
    ? 'seal-import-confirm-accept'
    : 'seal-import-confirm-reject'
})
const SEAL_IMPORT_CANCEL_ACTION = 'seal-import-cancel'
/** 驳回理由上限（服务层单点 `MAX_SEAL_REVIEW_NOTE_LENGTH`；不在视图另立数值）。 */
const SEAL_IMPORT_NOTE_MAX = seals.MAX_SEAL_REVIEW_NOTE_LENGTH

async function confirmSealImport() {
  const dialog = sealImportDialog.value
  if (!dialog || sealImportBusy.value) return
  const note = dialog.decision === seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED ? sealImportNote.value : ''
  sealImportBusy.value = true
  try {
    /* 服务层单点：按单行（`importId`）优先；否则按批次（`batchId`）。message 原文上屏。 */
    const options = dialog.row
      ? { importId: String(dialog.row.id || ''), decision: dialog.decision, note }
      : { batchId: String((dialog.batch && dialog.batch.batchId) || ''), decision: dialog.decision, note }
    const result = await seals.reviewSealImport(actor.value, options)
    feedback.value = result.message
    sealImportDialog.value = null
    dataVersion.value += 1
  } finally {
    sealImportBusy.value = false
  }
}

/** 我的提交（所有登录用户都能看到自己的记录）。 */
const rows = computed(() => {
  void dataVersion.value
  return corrections.listMyCorrections()
})
const summary = computed(() => corrections.summarizeCorrections(rows.value))

/** 管理员：全部用户的待审勘误。服务层返回**结构化结果**（`{ok:true,rows}` /
 *  `{ok:false,reason,message}`）—— 这里按 `result.ok ? result.rows : []` 取数，
 *  并把 `message` 作为可读空态文案渲染（见模板 `data-correction-queue-notice`），**不静默**。 */
const pendingResult = computed(() => {
  void dataVersion.value
  return corrections.listPendingForAdmin(actor.value)
})
/** 队列读数：拒绝时为空集（**不把「拒绝」渲染成「就是没有数据」**）。 */
const queue = computed(() => (pendingResult.value.ok ? pendingResult.value.rows : []))
/** 队列拒绝理由（正常路径为空串）；模板里作为可读文案展示，不做静默吞掉。 */
const queueNotice = computed(() => (pendingResult.value.ok ? '' : pendingResult.value.message))

/* --------------------------------------------------------------------------
   按提交单（batch）分组 + 组级批量审核（R-B3 / R-B4 / R-B7）
   --------------------------------------------------------------------------
   分组口径**只在服务层**（`listPendingBatchesForAdmin`）；视图层不另写第二套。
   组级按钮 `data-admin-action` **复用** `correction-accept` / `correction-reject`
   ⇒ `[data-admin-action]` 取值集合不变；另加 `data-action` / `data-correction-batch` 区分。
   -------------------------------------------------------------------------- */
const batchResult = computed(() => {
  void dataVersion.value
  return corrections.listPendingBatchesForAdmin(actor.value)
})
/** 待审提交单（拒绝 ⇒ 空集，**不把「拒绝」渲染成「就是没有数据」**）。 */
const batches = computed(() => (batchResult.value.ok ? batchResult.value.batches : []))
/** 待审条数合计（用于标题读数）。 */
const batchRowCount = computed(() => batches.value.reduce((sum, batch) => sum + batch.count, 0))

/** 批量审核的二次确认状态（`null` ＝ 未打开）。 */
const batchDialog = ref(null)
/** 批量驳回的可选理由（≤200 字；默认空 ⇒ 不落 `review_note`）。 */
const batchNote = ref('')
const batchBusy = ref(false)

function askBatch(batch, decision) {
  batchNote.value = ''
  batchDialog.value = { batch, decision }
}

function cancelBatch() {
  batchDialog.value = null
}

const batchConfirmText = computed(() =>
  batchDialog.value && batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED ? '確認採納' : '確認駁回'
)
const batchDialogTitle = computed(() => {
  if (!batchDialog.value) return ''
  return batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED ? '全部採納' : '全部駁回'
})
const batchDialogMessage = computed(() => {
  if (!batchDialog.value) return ''
  const { batch, decision } = batchDialog.value
  const verb = decision === corrections.CORRECTION_STATUS.ACCEPTED ? '採納' : '駁回'
  return `這將對「${batch.submitterLabel}」本次提交的 ${batch.count} 條勘誤全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const batchConfirmAction = computed(() => {
  if (!batchDialog.value) return ''
  return batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED
    ? 'correction-batch-confirm-accept'
    : 'correction-batch-confirm-reject'
})
const BATCH_CANCEL_ACTION = 'correction-batch-cancel'

async function confirmBatch() {
  const dialog = batchDialog.value
  if (!dialog || batchBusy.value) return
  const note = dialog.decision === corrections.CORRECTION_STATUS.REJECTED ? batchNote.value : ''
  batchBusy.value = true
  try {
    /* V3：登录令牌写面门（必要时**静默补签**）由服务层单点承担 ⇒ 本页**直接批量审核**、零弹窗。 */
    const result = await corrections.reviewBatch(
      actor.value,
      dialog.batch.rows.map((row) => row.id),
      dialog.decision,
      note
    )
    feedback.value = result.message
    batchDialog.value = null
    dataVersion.value += 1
  } finally {
    batchBusy.value = false
  }
}

const reward = points.CORRECTION_REWARD

function sealLabel(sealId) {
  const seal = seals.getSealById(sealId)
  /* r2 显示名单点：采纳值 → 原始 seal_name →「佚名」（`corrections.resolveSealDisplayName`）；
     印章行缺失时才用「未知印章」。 */
  return seal ? corrections.resolveSealDisplayName(seal) : '未知印章'
}

function sealKeyOf(row) {
  return row.sealId || row.stamp_id
}

/** 勘误挂在印面上：列出所属印面，旧数据（无 faceId）按主印面标注。 */
function faceLabelOfRow(row) {
  return seals.faceLabelOf(row.faceId, sealKeyOf(row))
}

function statusClass(status) {
  if (status === corrections.CORRECTION_STATUS.ACCEPTED) return 'chip--adopted'
  if (status === corrections.CORRECTION_STATUS.REJECTED) return 'chip--rejected'
  return 'chip--pending'
}

function submitterOf(row) {
  /* **上屏不显示他人手机号**（人类口径 ④）：一律用服务层单点 `submitterLabelOf` ⇒
     `暱稱（uid 短碼）`；**不得**再拼 `user.phone`。 */
  return corrections.submitterLabelOf(row.user_id || row.userId)
}

/**
 * **提交值上屏**：`author` 自 person-model §4.2 起为**引用型**（值是 `author_person_id`）
 * ⇒ 经**显示名单点链**（`corrections.resolveAuthorDisplayName`：引用命中 ⇒ 印人名 →
 * 未命中 ⇒ 旧文本 →「佚名」）渲染为印人名，便于审核人判读；其余字段原样。
 * 历史行（值为旧自由文本）经同一链回落到原文本，不被吞掉。
 */
function valueLabelOf(row) {
  const value = row && row.value !== undefined && row.value !== null ? String(row.value) : ''
  if (row && row.field === 'author') {
    return corrections.resolveAuthorDisplayName({ author_person_id: value, author: value })
  }
  return value
}

/** 跑一次审核（服务层 `message` 原文展示）；结果原样回传供调用方判断。 */
async function runReview(row, decision) {
  const result = await corrections.review(actor.value, row.id, decision)
  feedback.value = result.message
  dataVersion.value += 1
  return result
}

/**
 * 采纳 / 驳回（单条）：V3 起**直接调** —— 登录令牌写面门在服务层单点承担
 * 「无令牌 ⇒ 静默补签」，**零弹窗、不需要第二个码**；dev / 離線形态亦零行为变化。
 */
async function decide(row, decision) {
  await runReview(row, decision)
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>我的勘誤記錄</h1>
      <p v-if="canReview">
        這裏列出你提交的全部勘誤；上方另列出全部用戶的待審覈勘誤，可直接採納或駁回。
        採納後提交者獲得 {{ reward }} 金獎勵，駁回不改變積分。
      </p>
      <p v-else>這裏列出你提交的全部勘誤，審覈通過後會獲得金獎勵。</p>
    </div>

    <p v-if="feedback" class="notice review__notice" data-review-feedback>{{ feedback }}</p>

    <section v-if="canReview" class="panel">
      <div class="panel__head">
        <h2>待審覈勘誤（全部用戶）</h2>
        <span class="muted-hint">共 {{ queue.length }} 條 · {{ batches.length }} 批</span>
      </div>
      <div class="panel__body">
        <!-- 按提交单（batch）分组：组级「全部採納 / 全部駁回」＋ 批内逐条按钮（保留）。
             组级按钮 `data-admin-action` **复用** correction-accept / correction-reject
             ⇒ `[data-admin-action]` 取值集合不变；另加 `data-action` ＋ `data-correction-batch` 区分。 -->
        <div v-if="batches.length" class="batch-list">
          <article
            v-for="batch in batches"
            :key="batch.key"
            class="batch"
            :data-correction-batch="batch.key"
            :data-correction-batch-id="batch.batchId"
            :data-correction-batch-count="batch.count"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">{{ batch.submitterLabel }}</strong>
                <span class="muted-hint">
                  · {{ sealLabel(batch.sealId) }} · {{ batch.faceLabel }} · {{ formatDateTime(batch.createdAt) }}
                </span>
                <span class="chip chip--pending">共 {{ batch.count }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="correction-accept"
                  data-action="correction-batch-accept"
                  :data-correction-batch="batch.key"
                  @click="askBatch(batch, corrections.CORRECTION_STATUS.ACCEPTED)"
                >
                  全部採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="correction-reject"
                  data-action="correction-batch-reject"
                  :data-correction-batch="batch.key"
                  @click="askBatch(batch, corrections.CORRECTION_STATUS.REJECTED)"
                >
                  全部駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印章</th>
                  <th>印面</th>
                  <th>屬性</th>
                  <th>提交值</th>
                  <th>提交人</th>
                  <th>提交時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>
                    <router-link
                      class="list-table__link"
                      :to="{ name: 'seal-detail', params: { id: sealKeyOf(row) } }"
                    >
                      {{ sealLabel(sealKeyOf(row)) }}
                    </router-link>
                    <span class="list-table__meta">{{ sealKeyOf(row) }}</span>
                  </td>
                  <td>{{ faceLabelOfRow(row) }}</td>
                  <td>{{ row.field_label || row.field }}</td>
                  <td>{{ valueLabelOf(row) }}</td>
                  <td>{{ submitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.created_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="correction-accept"
                      :data-correction-id="row.id"
                      @click="decide(row, corrections.CORRECTION_STATUS.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="correction-reject"
                      :data-correction-id="row.id"
                      @click="decide(row, corrections.CORRECTION_STATUS.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="queueNotice" class="notice review__notice" data-correction-queue-notice>
          {{ queueNotice }}
        </p>
        <p v-else class="muted-hint">當前沒有待審覈的勘誤。</p>
      </div>
    </section>

    <!-- **印人提案审核区块（本单新增）**：管理员专属（非管理员 ⇒ 不渲染，DOM 零命中）；
         采纳 / 驳回复用既有按钮形态；**不新开路由 / 专区**（落点＝本页，沿 §3.9 追加注（v1.53））。
         钩子族新增**恰 1 个**取值 `person-proposal-review`（采纳 / 驳回共用，不复用既有字面值）。 -->
    <section v-if="canReviewProposals" class="panel">
      <div class="panel__head">
        <h2>待審印人提案（全部用戶）</h2>
        <span class="muted-hint">共 {{ proposals.length }} 條</span>
      </div>
      <div class="panel__body">
        <table v-if="proposals.length" class="list-table">
          <thead>
            <tr>
              <th>印人</th>
              <th>姓</th>
              <th>名</th>
              <th>字 / 號 / 別名</th>
              <th>生卒</th>
              <th>提交人</th>
              <th>提交時間</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in proposals" :key="row.id">
              <td>{{ proposalNameOf(row) || '（未命名）' }}</td>
              <td>{{ row.family_name || '—' }}</td>
              <td>{{ row.given_name || '—' }}</td>
              <td>
                {{ [...(row.courtesy_names || []), ...(row.art_names || []), ...(row.alias_names || [])].join('、') || '—' }}
              </td>
              <td>{{ proposalYearsOf(row) }}</td>
              <td>{{ proposalSubmitterOf(row) }}</td>
              <td>{{ formatDateTime(row.submitted_at) }}</td>
              <td class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-proposal-review"
                  data-action="person-proposal-accept"
                  :data-person-proposal-id="row.id"
                  @click="decideProposal(row, persons.PERSON_STATUS.ACCEPTED)"
                >
                  採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-proposal-review"
                  data-action="person-proposal-reject"
                  :data-person-proposal-id="row.id"
                  @click="decideProposal(row, persons.PERSON_STATUS.REJECTED)"
                >
                  駁回
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="proposalNotice" class="notice review__notice" data-person-proposal-notice>
          {{ proposalNotice }}
        </p>
        <p v-else class="muted-hint">當前沒有待審覈的印人提案。</p>
      </div>
    </section>

    <!-- **待審導入批次審核區塊（印人批 2 ＋ 印章批 3｜本单合并同屏）**：管理员专属（非管理员 ⇒ 不渲染，DOM 零命中）；
         采纳 / 驳回复用既有按钮形态与**二次确认体例（沿 §3.44.10 / W-78）**；不新开路由 / 专区。
         **两类导入行同屏**（印人导入 ＋ 印章导入），**共用同一钩子值** `person-import-review`
         （采纳 / 驳回共用，不复用既有字面值，也不新增取值 ⇒ 仍恰 10 值 / 归并 9 类）。
         粒度（W-77）：按批次（整批）＋ 按单行（逐条）两个入口都实现（两类同型）。 -->
    <section v-if="canReviewImports || canReviewSealImports" class="panel">
      <div class="panel__head">
        <h2>待審導入批次（外部批量導入）</h2>
        <span class="muted-hint">印人導入 共 {{ importRows.length }} 條 · {{ importBatches.length }} 批</span>
        <span class="muted-hint">印章導入 共 {{ sealImportRows.length }} 條 · {{ sealImportBatches.length }} 批</span>
      </div>
      <div class="panel__body">
        <div v-if="importBatches.length" class="batch-list">
          <article
            v-for="batch in importBatches"
            :key="batch.key"
            class="batch"
            :data-person-import-batch="batch.key"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">批次 {{ batch.batchId || '（無批次）' }}</strong>
                <span class="chip chip--pending">共 {{ batch.rows.length }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="person-import-accept"
                  :data-person-import-batch="batch.key"
                  @click="askImport({ batch }, persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED)"
                >
                  整批採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="person-import-reject"
                  :data-person-import-batch="batch.key"
                  @click="askImport({ batch }, persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED)"
                >
                  整批駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印人</th>
                  <th>姓</th>
                  <th>名</th>
                  <th>來源 id</th>
                  <th>導入人</th>
                  <th>導入時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>{{ importNameOf(row) || '（未命名）' }}</td>
                  <td>{{ row.family_name || '—' }}</td>
                  <td>{{ row.given_name || '—' }}</td>
                  <td>{{ importSourceIdOf(row) }}</td>
                  <td>{{ importSubmitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.imported_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="person-import-accept"
                      :data-person-import-id="row.id"
                      @click="askImport({ row }, persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="person-import-reject"
                      :data-person-import-id="row.id"
                      @click="askImport({ row }, persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="importNotice" class="notice review__notice" data-person-import-notice>
          {{ importNotice }}
        </p>

        <!-- **印章導入（第二类｜同屏、共用同一钩子值 `person-import-review`）**：
             待审源 ＝ `seals.listPendingSealImportsForAdmin`；采纳 / 驳回走 `seals.reviewSealImport`。 -->
        <div v-if="sealImportBatches.length" class="batch-list" data-seal-import-list>
          <article
            v-for="batch in sealImportBatches"
            :key="'seal:' + batch.key"
            class="batch"
            :data-seal-import-batch="batch.key"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">批次 {{ batch.batchId || '（無批次）' }}</strong>
                <span class="chip chip--pending">共 {{ batch.rows.length }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="seal-import-accept"
                  :data-seal-import-batch="batch.key"
                  @click="askSealImport({ batch }, seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED)"
                >
                  整批採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="seal-import-reject"
                  :data-seal-import-batch="batch.key"
                  @click="askSealImport({ batch }, seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED)"
                >
                  整批駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印章</th>
                  <th>來源 id</th>
                  <th>印面數</th>
                  <th>導入人</th>
                  <th>導入時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>{{ sealImportNameOf(row) || '（未命名）' }}</td>
                  <td>{{ sealImportSourceIdOf(row) }}</td>
                  <td>{{ sealImportFaceCountOf(row) }}</td>
                  <td>{{ sealImportSubmitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.imported_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="seal-import-accept"
                      :data-seal-import-id="row.id"
                      @click="askSealImport({ row }, seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="seal-import-reject"
                      :data-seal-import-id="row.id"
                      @click="askSealImport({ row }, seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="sealImportNotice" class="notice review__notice" data-seal-import-notice>
          {{ sealImportNotice }}
        </p>

        <!-- **合并空态**：两类皆空且无拒绝理由时才显示（可读、繁體、不白屏）。 -->
        <p
          v-if="!importBatches.length && !sealImportBatches.length && !importNotice && !sealImportNotice"
          class="muted-hint"
          data-import-empty
        >
          當前沒有待審覈的印人 / 印章外部導入批次。
        </p>
      </div>
    </section>

    <!-- 批量审核二次确认（复用 ConfirmDialog；显式、可取消、默认不通过；文案写明批内条数 ＋ 提交人）。
         批量驳回时弹窗内提供**可选**理由（textarea，≤200 字）；弹窗按钮**只用 `data-action`**。 -->
    <ConfirmDialog
      v-if="batchDialog"
      :title="batchDialogTitle"
      :message="batchDialogMessage"
      :confirm-text="batchConfirmText"
      :confirm-action="batchConfirmAction"
      :cancel-action="BATCH_CANCEL_ACTION"
      @confirm="confirmBatch"
      @cancel="cancelBatch"
    >
      <div
        v-if="batchDialog.decision === corrections.CORRECTION_STATUS.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="correction-batch-note">駁回理由（可選，最多 200 字）</label>
        <textarea
          id="correction-batch-note"
          v-model="batchNote"
          class="batch__note-input"
          maxlength="200"
          rows="3"
          data-correction-batch-note
        ></textarea>
        <span class="batch__note-hint">填寫後將一併記錄到該批每條勘誤，提交者可在「我的提交」中看到。</span>
      </div>
    </ConfirmDialog>

    <!-- **導入批次審核的二次确认（本单新增）**：显式、可取消、默认不通过；文案写明粒度 ＋ 条数；
         驳回时提供**可选**理由（≤200 字）；弹窗按钮**只用 `data-action`**（不带 `data-admin-action`）。 -->
    <ConfirmDialog
      v-if="importDialog"
      :title="importDialogTitle"
      :message="importDialogMessage"
      :confirm-text="importConfirmText"
      :confirm-action="importConfirmAction"
      :cancel-action="IMPORT_CANCEL_ACTION"
      @confirm="confirmImport"
      @cancel="cancelImport"
    >
      <div
        v-if="importDialog.decision === persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="person-import-note">駁回理由（可選，最多 200 字）</label>
        <textarea
          id="person-import-note"
          v-model="importNote"
          class="batch__note-input"
          maxlength="200"
          rows="3"
          data-person-import-note
        ></textarea>
      </div>
    </ConfirmDialog>

    <!-- **印章導入審核的二次确认（本单新增）**：显式、可取消、默认不通过；文案写明粒度 ＋ 条数；
         驳回理由上限引服务层单点 `MAX_SEAL_REVIEW_NOTE_LENGTH`；弹窗按钮**只用 `data-action`**。 -->
    <ConfirmDialog
      v-if="sealImportDialog"
      :title="sealImportDialogTitle"
      :message="sealImportDialogMessage"
      :confirm-text="sealImportConfirmText"
      :confirm-action="sealImportConfirmAction"
      :cancel-action="SEAL_IMPORT_CANCEL_ACTION"
      @confirm="confirmSealImport"
      @cancel="cancelSealImport"
    >
      <div
        v-if="sealImportDialog.decision === seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="seal-import-note">駁回理由（可選，最多 {{ SEAL_IMPORT_NOTE_MAX }} 字）</label>
        <textarea
          id="seal-import-note"
          v-model="sealImportNote"
          class="batch__note-input"
          :maxlength="SEAL_IMPORT_NOTE_MAX"
          rows="3"
          data-seal-import-note
        ></textarea>
      </div>
    </ConfirmDialog>

    <section v-if="rows.length" class="panel">
      <div class="panel__head">
        <h2>我的提交</h2>
      </div>
      <div class="panel__body">
        <div class="stat-row">
          <div class="stat">
            <span class="stat__num">{{ summary.total }}</span>
            <span class="stat__label">累計提交</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.pending }}</span>
            <span class="stat__label">待審覈</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.accepted }}</span>
            <span class="stat__label">已採納</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.rejected }}</span>
            <span class="stat__label">駁回</span>
          </div>
        </div>

        <table class="list-table">
          <thead>
            <tr>
              <th>印章</th>
              <th>印面</th>
              <th>屬性</th>
              <th>提交值</th>
              <th>依據</th>
              <th>狀態</th>
              <th>提交時間</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>
                <router-link class="list-table__link" :to="{ name: 'seal-detail', params: { id: sealKeyOf(row) } }">
                  {{ sealLabel(sealKeyOf(row)) }}
                </router-link>
                <span class="list-table__meta">{{ sealKeyOf(row) }}</span>
              </td>
              <td>{{ faceLabelOfRow(row) }}</td>
              <td>{{ row.field_label || row.field }}</td>
              <td>{{ valueLabelOf(row) }}</td>
              <td>{{ row.basis || '—' }}</td>
              <td>
                <span class="chip" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span>
                <!-- R-B11：驳回理由（`review_note`）在狀態列内附一行弱化说明；有才渲染。 -->
                <span v-if="row.review_note" class="review__note" data-correction-note>{{ row.review_note }}</span>
              </td>
              <td>{{ formatDateTime(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <PlaceholderPanel
      v-else
      glyph="勘"
      title="暫無勘誤記錄"
      desc="在印章詳情頁對可標記屬性提交勘誤後，會在此處顯示審覈進度。"
    >
      <router-link class="btn btn--ghost" :to="{ name: 'square' }">去璽印匯類看看</router-link>
    </PlaceholderPanel>
  </section>
</template>

<style scoped>
.review__notice {
  margin-bottom: var(--s-4);
}

.muted-hint {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.review__ops {
  display: flex;
  gap: var(--s-2);
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  padding: var(--s-4);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
}

.stat__num {
  font-family: var(--font-serif);
  font-size: var(--t-2xl);
  color: var(--c-brand-strong);
}

.stat__label {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.list-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}

.list-table th,
.list-table td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--c-line);
  text-align: left;
  vertical-align: top;
}

.list-table th {
  color: var(--c-text-muted);
  font-weight: 500;
}

.list-table__link {
  color: var(--c-text);
  text-decoration: underline;
}

.list-table__meta {
  display: block;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.chip {
  display: inline-block;
  padding: 1px var(--s-2);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  font-size: var(--t-xs);
  white-space: nowrap;
}

.chip--pending {
  background: var(--c-gold-soft);
  border-color: var(--c-gold);
  color: var(--c-gold-strong);
}

.chip--adopted {
  background: var(--c-brand-soft);
  border-color: var(--c-brand);
  color: var(--c-brand-strong);
}

.chip--rejected {
  color: var(--c-text-muted);
}

/* 按提交单分组（批量审核） */
.batch-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.batch {
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.batch__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  flex-wrap: wrap;
  padding: var(--s-3) var(--s-3);
  background: var(--c-surface-sunken);
  border-bottom: 1px solid var(--c-line);
}

.batch__meta {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.batch__submitter {
  color: var(--c-text);
}

.batch__note {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  margin-top: var(--s-3);
}

.batch__note-label {
  color: var(--c-text);
  font-size: var(--t-sm);
}

.batch__note-input {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  font: inherit;
  resize: vertical;
}

.batch__note-hint {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* 驳回理由弱化说明（R-B11：狀態列内附一行） */
.review__note {
  display: block;
  margin-top: 2px;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}
</style>
