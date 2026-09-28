
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
import { auth, corrections, points, seals } from '../services/index.js'
import { currentUser } from '../data/session.js'
import { statusLabel, formatDateTime } from '../utils/format.js'

/* 任何一次审核 / 提交后 +1，使下面的派生读数重算。 */
const dataVersion = ref(0)
const feedback = ref('')

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

const reward = points.CORRECTION_REWARD

function sealLabel(sealId) {
  const seal = seals.getSealById(sealId)
  /* R-65：显示名链只用 `seal_name`（空 ⇒「佚名」）；印章行缺失时才用「未知印章」。 */
  return seal ? seal.seal_name || '佚名' : '未知印章'
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
  const user = auth.findUserById(row.user_id || row.userId)
  return user ? `${user.nickname}（${user.phone}）` : '未知賬號'
}

/** 采纳 / 驳回：结果一律读服务层返回的 `message` 原文展示（不做一闪而过的提示）。 */
function decide(row, decision) {
  const result = corrections.review(actor.value, row.id, decision)
  feedback.value = result.message
  dataVersion.value += 1
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
        <span class="muted-hint">共 {{ queue.length }} 條</span>
      </div>
      <div class="panel__body">
        <table v-if="queue.length" class="list-table">
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
            <tr v-for="row in queue" :key="row.id">
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
        <p v-else-if="queueNotice" class="notice review__notice" data-correction-queue-notice>
          {{ queueNotice }}
        </p>
        <p v-else class="muted-hint">當前沒有待審覈的勘誤。</p>
      </div>
    </section>

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
              <td><span class="chip" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span></td>
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
      <router-link class="btn btn--ghost" :to="{ name: 'square' }">去藏品廣場看看</router-link>
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
</style>
