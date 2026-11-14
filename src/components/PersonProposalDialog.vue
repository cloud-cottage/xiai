<script setup>
/**
 * 提交印人提案（**全站唯一一份提案表单**）。
 * ============================================================================
 * 来源与归属（2026-11-14 裁定：入口迁出印章详情页）：
 *   本组件由**原印章详情页的内联提案表单**原样抽出（字段、文案、钩子、载荷与行为逐字一致），
 *   三处共用同一实现（**不复制三份表单**）：
 *     A. 作者【勘誤】模态框 —— 作者检索**无命中**时露出入口；
 *     B. 首页【上傳印章】模态框 —— 同上（原来只给「庫中無此人…」的文案、没有路）；
 *     C. 印人名录 `/persons` —— 控制条常驻入口。
 *   **印章详情页不再有该入口**（按钮与内联表单已删除，DOM 里零命中）。
 *
 * 硬口径（逐条沿用，不得放宽）：
 *   · 提交 ⇒ `persons.submitPersonProposal` ⇒ 落 `PENDING` ⇒ 管理员在 `/my/corrections`
 *     「待審印人提案」采纳 / 驳回；**不新增 op、不新增 reason 字面值、不改载荷键面**。
 *   · **四扩字段**（籍貫 / 傳記 / 來源 / 來源 id）照旧收：繁體錄入＝**软提示 ＋「一鍵轉繁」三动作钮**
 *     （`TextTransformButtons`）；**不强制、不拒收、不自动改写**（四字段全空亦可提交），
 *     提交值＝用户所见当前值，逐字（沿「不转用户输入」口径）。
 *   · 登录门在**入口处**（未登录点入口走登录引导，不静默失败）；本组件不再重复引导，
 *     服务层仍会独立拒一次（双保险）。
 *   · ESC ＝ 取消（单一实现 `useEscToClose`，见 `utils/useEscToClose.js`）；**提交中 ESC 不生效**。
 *   · 上屏文案一律繁體（`s2t(x) === x`）。
 */

import { reactive, ref } from 'vue'
import TextTransformButtons from './TextTransformButtons.vue'
import { persons } from '../services/index.js'
import { useEscToClose } from '../utils/useEscToClose.js'

const emit = defineEmits(['close', 'submitted'])

/** 提交结果文案（成功 / 跳过 / 失败一律用服务层原文，不受本组件改写）。 */
const feedback = ref('')
/** 提交中（一次性提交守卫 ＋ ESC 失效判据）。 */
const busy = ref(false)

/** 表单字段（与原内联版逐字同键；提交时再映射成载荷键）。 */
const form = reactive({
  familyName: '',
  givenName: '',
  courtesy: '',
  art: '',
  alias: '',
  birthYear: '',
  deathYear: '',
  cbdbId: '',
  nativePlace: '',
  biography: '',
  source: '',
  sourceId: '',
  note: ''
})

function resetForm() {
  form.familyName = ''
  form.givenName = ''
  form.courtesy = ''
  form.art = ''
  form.alias = ''
  form.birthYear = ''
  form.deathYear = ''
  form.cbdbId = ''
  form.nativePlace = ''
  form.biography = ''
  form.source = ''
  form.sourceId = ''
  form.note = ''
}

/** 取消：关闭并丢弃未提交输入（**零写请求**）。 */
function close() {
  if (busy.value) return
  emit('close')
}

async function submit() {
  if (busy.value) return
  busy.value = true
  try {
    /* 写面门在服务层（`userWriteGate('submitPersonProposal', …)`）⇒ 必须 `await`。 */
    const result = await persons.submitPersonProposal({
      targetPersonId: null,
      familyName: form.familyName,
      givenName: form.givenName,
      courtesyNames: form.courtesy,
      artNames: form.art,
      aliasNames: form.alias,
      birthYear: form.birthYear,
      deathYear: form.deathYear,
      cbdbId: form.cbdbId,
      /* 四扩字段（正字段，繁体为正）：逐字提交；不强制、不拒收、不自动改写。 */
      nativePlace: form.nativePlace,
      biography: form.biography,
      source: form.source,
      sourceId: form.sourceId,
      note: form.note
    })
    feedback.value = result.message
    if (result.ok) resetForm()
    emit('submitted', result)
  } finally {
    busy.value = false
  }
}

/* ESC ＝ 取消（单点实现）；提交中不生效，且不向底层弹窗穿透。 */
useEscToClose({ onCancel: close, isBusy: () => busy.value })
</script>

<template>
  <div
    class="proposal-mask"
    role="dialog"
    aria-modal="true"
    aria-label="提交印人提案"
    data-person-proposal-dialog
  >
    <div class="proposal-box">
      <h3 class="proposal-box__title">提交印人提案</h3>
      <p class="proposal-box__lede">
        庫中無此人時提交本提案；提交後為待審狀態，經管理員審覈通過即入印人名錄。
      </p>

      <div class="field">
        <label for="pp-family">姓</label>
        <input id="pp-family" v-model="form.familyName" type="text" data-person-proposal-family />
      </div>
      <div class="field">
        <label for="pp-given">名</label>
        <input id="pp-given" v-model="form.givenName" type="text" data-person-proposal-given />
      </div>
      <div class="field">
        <label for="pp-courtesy">字（多個以逗號分隔）</label>
        <input id="pp-courtesy" v-model="form.courtesy" type="text" data-person-proposal-courtesy />
      </div>
      <div class="field">
        <label for="pp-art">號（多個以逗號分隔）</label>
        <input id="pp-art" v-model="form.art" type="text" data-person-proposal-art />
      </div>
      <div class="field">
        <label for="pp-alias">別名（多個以逗號分隔）</label>
        <input id="pp-alias" v-model="form.alias" type="text" data-person-proposal-alias />
      </div>
      <div class="field">
        <label for="pp-birth">生年（公元，可空）</label>
        <input id="pp-birth" v-model="form.birthYear" type="text" data-person-proposal-birth />
      </div>
      <div class="field">
        <label for="pp-death">卒年（公元，可空）</label>
        <input id="pp-death" v-model="form.deathYear" type="text" data-person-proposal-death />
      </div>
      <div class="field">
        <label for="pp-cbdb">CBDB id（可空）</label>
        <input id="pp-cbdb" v-model="form.cbdbId" type="text" data-person-proposal-cbdb />
      </div>
      <!-- 四扩字段（籍貫 / 傳記 / 來源 / 來源 id）：繁體錄入 ＝ **變體 C** —— 軟提示 ＋
           既有「一鍵轉繁」三動作鈕；不強制、不拒收、不自動改寫（不得攔截提交）。 -->
      <p class="proposal-box__trad-hint" data-person-proposal-trad-hint>
        建議使用繁體字填寫（不強制，留空亦可提交；系統不自動轉換）。
      </p>
      <div class="field">
        <label for="pp-native-place">籍貫</label>
        <input id="pp-native-place" v-model="form.nativePlace" type="text" data-person-proposal-native-place />
        <TextTransformButtons v-model="form.nativePlace" field-key="person-proposal:native_place" field-label="籍貫" />
      </div>
      <div class="field">
        <label for="pp-biography">傳記</label>
        <input id="pp-biography" v-model="form.biography" type="text" data-person-proposal-biography />
        <TextTransformButtons v-model="form.biography" field-key="person-proposal:biography" field-label="傳記" />
      </div>
      <div class="field">
        <label for="pp-source">來源</label>
        <input id="pp-source" v-model="form.source" type="text" data-person-proposal-source />
        <TextTransformButtons v-model="form.source" field-key="person-proposal:source" field-label="來源" />
      </div>
      <div class="field">
        <label for="pp-source-id">來源 id</label>
        <input id="pp-source-id" v-model="form.sourceId" type="text" data-person-proposal-source-id />
        <TextTransformButtons v-model="form.sourceId" field-key="person-proposal:source_id" field-label="來源 id" />
      </div>
      <div class="field">
        <label for="pp-note">依據（選填）</label>
        <input id="pp-note" v-model="form.note" type="text" data-person-proposal-note />
      </div>

      <p v-if="feedback" class="proposal-box__feedback" data-person-proposal-feedback>{{ feedback }}</p>

      <div class="proposal-box__foot">
        <button class="btn btn--ghost" type="button" data-action="person-proposal-cancel" :disabled="busy" @click="close">
          取消
        </button>
        <button
          class="btn btn--primary"
          type="button"
          data-action="person-proposal-submit"
          :disabled="busy"
          @click="submit"
        >
          {{ busy ? '提交中…' : '提交提案' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩层级高于其余弹窗（40）：本框会在「提交勘誤」/「上傳印章」之上**嵌套**打开，
   一次 ESC 只关本层（后开先关，见 `utils/useEscToClose.js`）。 */
.proposal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  overflow-y: auto;
  background: var(--c-overlay);
}

.proposal-box {
  width: 100%;
  max-width: 560px;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.proposal-box__title {
  margin: 0 0 var(--s-2);
  font-size: var(--t-lg);
  color: var(--c-text);
}

.proposal-box__lede {
  margin: 0 0 var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.proposal-box__trad-hint {
  margin: var(--s-2) 0;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.proposal-box__feedback {
  margin-top: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}

.proposal-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
</style>
