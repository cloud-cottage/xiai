
<script setup>
/**
 * 積分中心（`/points`）。
 *
 * **v1.21 追加（K-2）**：
 *   - 规则清单**第 4 条「邀請註冊」**（规范 §3.21.7 / §5.1 表下注（v1.21 追加）／
 *     §5.5 / §3.21.12 第 31 行）：label 逐字「邀請註冊」，取值**由配置插值** ——
 *     **页面不得硬编码该数值**，一律经 `points.readInviteReward()`（配置键 ⇒ 默认值回落）；
 *   - **管理员专属入口** `data-admin-action="edit-invite-reward"`（第 7 个字面值 / 归并第 6 类）：
 *     **普通用户与未登錄一律不渲染**（DOM 零命中，含 CSS 隐藏 / `disabled`）；
 *     弹窗提交钮挂 `data-action="edit-invite-reward-submit"`、**不带** `data-admin-action`
 *     （派生规则：提交钮取值 ＝ 所属入口取值 ＋ `-submit`）。
 *     数据层另有独立拒绝（非管理员 ⇒ `FORBIDDEN` ＋ 零写入；非法值 ⇒ `INVALID_VALUE`），
 *     本页只做入口渲染侧（两条独立要求，缺一即判负）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 *
 * **写面 Phase 1 追加（2026-09-30｜页面改动，逐处登记）**：
 *   - 提交钮的落盘路径改为「**先取寫入令牌 → 雲端驗簽 → 才落盘**」：`submitEdit` 改为 `async`，
 *     先 `admin.ensureAdminWriteSession(校驗碼)` 再 `await admin.setInviteReward(...)`；
 *   - 弹窗内**新增一个输入位**（「寫入校驗碼」，云写入面下必需；已有未过期令牌时留空）；
 *   - **`data-admin-action` 取值集合与实例数一字未动**（仍恰 8 值；本页仍恰 `edit-invite-reward` 1 处）；
 *     入口钮的 `v-if="isAdmin"` 渲染判定**一字未改**（它只是展示性隐藏，不是授权）。
 */
import { computed, ref } from 'vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import { admin, points, seals } from '../services/index.js'
import { formatDateTime } from '../utils/format.js'

/** 任何一次写入（如改邀请奖励）后 +1，使派生读数立即重算。 */
const dataVersion = ref(0)

const balance = computed(() => points.getBalance())
const rows = computed(() =>
  points
    .listLedger()
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
)
const earned = computed(() =>
  rows.value.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0)
)
const spent = computed(() =>
  rows.value.filter((row) => row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0)
)

/* 前 3 条规则**逐字未改**（§3.21.12 的「前 3 条逐字未改」）；第 4 条为 v1.21 新增。 */
const rules = computed(() => {
  void dataVersion.value
  /* 取值由配置插值（配置键缺失 ⇒ 回落规范 §5.1 的默认值；页面**不写死数字**）。 */
  const reward = points.readInviteReward().value
  return [
    { label: '新賬號初始贈送', value: `${points.GOLD_INITIAL} 金` },
    { label: '下載高清原圖', value: `每次 ${points.DOWNLOAD_COST} 金，按印章計費一次` },
    { label: '勘誤被採納', value: `每條獎勵 ${points.CORRECTION_REWARD} 金` },
    {
      label: '邀請註冊',
      value: `邀請人與被邀請人各 ${reward} 金，被邀請人註冊成功即發放`
    }
  ]
})

function refLabel(row) {
  if (row.ref_type === 'seal' && row.ref_id) {
    const seal = seals.getSealById(row.ref_id)
    return seal ? `${seal.seal_name || '佚名'}（${row.ref_id}）` : row.ref_id
  }
  if (row.ref_type === 'correction') return '勘誤採納獎勵'
  /* 第 4 类流水（邀請註冊）的关联对象字面（§3.21.12 第 34 行）。 */
  if (row.ref_type === 'invite') return '邀請註冊'
  return row.ref_label || '賬號初始贈送'
}

function amountText(amount) {
  return amount > 0 ? `+${amount}` : String(amount)
}

/* ============================================================================
   編輯邀請獎勵（管理员专属；v1.21 新增｜规范 §3.21.8 / §4.1.12 / §3.21.12 第 32 ～ 33 行）
   ============================================================================ */
const isAdmin = computed(() => admin.isAdminSession())
const editOpen = ref(false)
const editValue = ref('')
const editFeedback = ref('')
const editSaved = ref(false)
/* 寫入校驗碼（写面 Phase 1：云端写入面下用于换取 15 分钟写入令牌；dev / 離線形態留空即可）。 */
const writeCode = ref('')
const editBusy = ref(false)

function openEdit() {
  editOpen.value = true
  editFeedback.value = ''
  editSaved.value = false
  writeCode.value = ''
  /* 预填当前生效值（配置键 ⇒ 默认值回落），仍不硬编码。 */
  editValue.value = String(points.readInviteReward().value)
}

function closeEdit() {
  editOpen.value = false
  editFeedback.value = ''
  editSaved.value = false
  writeCode.value = ''
}

async function submitEdit() {
  if (editBusy.value) return
  editFeedback.value = ''
  editSaved.value = false
  const raw = String(editValue.value || '').trim()
  const parsed = Number(raw)
  /* 前端先给逐字校验文案；数据层仍会独立再判一次（不得只靠 UI 拦）。 */
  if (!raw || !Number.isInteger(parsed) || parsed < 0) {
    editFeedback.value = '請填寫非負整數。'
    return
  }
  editBusy.value = true
  try {
    /* ① 保證有一枚可攜帶的寫入令牌（雲端寫入面下必需）——**它本身不是授權**，
       只是把請求交給服務端；服務端驗簽才是唯一判據。 */
    const session = await admin.ensureAdminWriteSession(writeCode.value)
    if (!session.ok) {
      editFeedback.value = session.message || '寫入校驗失敗，請稍後再試。'
      return
    }
    /* ② 經雲端校驗後才落盘（過不了門 ⇒ 結構化拒絕 ＋ 零寫入）。 */
    const result = await admin.setInviteReward(null, parsed)
    if (!result.ok) {
      editFeedback.value = result.message || '保存失敗，請稍後再試。'
      return
    }
    editSaved.value = true
    editFeedback.value = '已保存，新註冊將按新數值發放。'
    writeCode.value = ''
    /* 规则第 4 条的插值随之更新（页面文案随值变化，无硬编码）。 */
    dataVersion.value += 1
  } finally {
    editBusy.value = false
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>積分中心</h1>
      <p>積分的單位爲「金」，可用於下載高清原圖；勘誤被採納亦可獲得金獎勵。</p>
    </div>

    <div class="balance-row">
      <div class="balance">
        <span class="balance__num">{{ balance }}</span>
        <span class="balance__unit">金</span>
        <span class="balance__label">當前餘額</span>
      </div>
      <div class="balance">
        <span class="balance__num">{{ earned }}</span>
        <span class="balance__unit">金</span>
        <span class="balance__label">累計獲得</span>
      </div>
      <div class="balance">
        <span class="balance__num">{{ spent }}</span>
        <span class="balance__unit">金</span>
        <span class="balance__label">累計消耗</span>
      </div>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>積分規則</h2>
        <!-- 管理员专属入口（**普通用户 / 未登錄 ⇒ 不渲染**，DOM 零命中；非 CSS 隐藏、非 disabled）。 -->
        <button
          v-if="isAdmin"
          class="btn btn--ghost"
          type="button"
          data-admin-action="edit-invite-reward"
          @click="openEdit"
        >
          編輯邀請獎勵
        </button>
      </div>
      <div class="panel__body">
        <ul class="rules">
          <li
            v-for="(rule, index) in rules"
            :key="rule.label"
            :data-points-rule="index + 1"
            :data-points-rule-label="rule.label"
          >
            <span>{{ rule.label }}</span>
            <span class="rules__value" :data-points-rule-value="index + 1">{{ rule.value }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="rows.length" class="panel">
      <div class="panel__head">
        <h2>積分明細</h2>
      </div>
      <div class="panel__body">
        <table class="ledger">
          <thead>
            <tr>
              <th>類型</th>
              <th>金變動</th>
              <th>關聯對象</th>
              <th>變更後餘額</th>
              <th>時間</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>{{ row.type }}</td>
              <td>
                <span class="ledger__amount" :class="row.amount > 0 ? 'ledger__amount--in' : 'ledger__amount--out'">
                  {{ amountText(row.amount) }}
                </span>
              </td>
              <td>{{ refLabel(row) }}</td>
              <td>{{ row.balance_after }} 金</td>
              <td>{{ formatDateTime(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <PlaceholderPanel
      v-else
      glyph="金"
      title="暫無積分流水"
      desc="下載高清原圖或提交勘誤被採納後，這裏會記錄每一筆金的變動。"
    >
      <router-link class="btn btn--ghost" :to="{ name: 'square' }">去璽印匯類看看</router-link>
    </PlaceholderPanel>

    <!-- 編輯邀請獎勵弹窗（仅管理员入口可开；提交钮用 `data-action`，**不带** `data-admin-action`）。 -->
    <div
      v-if="editOpen && isAdmin"
      class="edit-mask"
      role="dialog"
      aria-modal="true"
      aria-label="編輯邀請獎勵"
      data-admin-dialog="edit-invite-reward"
    >
      <div class="edit-box">
        <h3 class="edit-box__title">編輯邀請獎勵</h3>
        <p class="edit-box__lede">
          修改後只影響之後的結算：既有邀請行與既有積分流水逐字不變。
        </p>

        <div class="field">
          <label for="invite-reward-value">邀請註冊獎勵（金）</label>
          <input id="invite-reward-value" v-model="editValue" type="number" min="0" step="1" inputmode="numeric" />
          <span class="field__hint">須為非負整數；邀請人與被邀請人各得該數值。</span>
        </div>

        <!-- 寫入校驗碼（写面 Phase 1 新增输入位）：云端写入面下必需，用于换取 15 分钟写入令牌；
             已有未过期令牌时可留空。**它不是授权凭据** —— 服务端验签才是唯一判据。 -->
        <div class="field">
          <label for="invite-reward-write-code">寫入校驗碼</label>
          <input
            id="invite-reward-write-code"
            v-model="writeCode"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
          />
          <span class="field__hint">雲端寫入面下必要（管理員手機號 ＋ 校驗碼換取 15 分鐘寫入令牌）；已有未過期令牌時可留空。</span>
        </div>

        <p v-if="editFeedback" class="edit-box__feedback" data-admin-feedback="edit-invite-reward">
          {{ editFeedback }}
        </p>

        <div class="edit-box__foot">
          <button class="btn btn--ghost" type="button" @click="closeEdit">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            data-action="edit-invite-reward-submit"
            @click="submitEdit"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.balance-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.balance {
  display: flex;
  align-items: baseline;
  gap: var(--s-1);
  flex-wrap: wrap;
  padding: var(--s-4);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
}

.balance__num {
  font-family: var(--font-serif);
  font-size: var(--t-3xl);
  color: var(--c-gold-strong);
}

.balance__unit {
  color: var(--c-gold-strong);
  font-size: var(--t-md);
}

.balance__label {
  flex: 1 0 100%;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.rules {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--t-sm);
}

.rules li {
  display: flex;
  justify-content: space-between;
  gap: var(--s-4);
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--c-line);
  color: var(--c-text);
}

.rules li:last-child {
  border-bottom: 0;
}

.rules__value {
  color: var(--c-text-muted);
}

.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}

.ledger th,
.ledger td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--c-line);
  text-align: left;
}

.ledger th {
  color: var(--c-text-muted);
  font-weight: 500;
}

.ledger__amount--in {
  color: var(--c-ok);
}

.ledger__amount--out {
  color: var(--c-brand-strong);
}

.edit-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-overlay);
}

.edit-box {
  width: 100%;
  max-width: 420px;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.edit-box__title {
  margin-bottom: var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.edit-box__lede {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.edit-box__feedback {
  margin-top: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.edit-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
</style>
