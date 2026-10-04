
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
import { corrections, points, seals } from '../services/index.js'
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
                  <td>{{ row.value }}</td>
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
              <td>{{ row.value }}</td>
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
