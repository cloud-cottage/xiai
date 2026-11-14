<script setup>
/**
 * 簡繁**開關式**圖示鈕（單一動作、無撤銷）——2026-11-14 選型單。
 * ============================================================================
 * 與舊的**三動作轉換鈕**（三動作 ＋ 進度面）**並存互不影響**：本組件是**新檔**，
 * 舊組件與其使用處（`UploadSealDialog` / `AddSealFaceDialog` / `SealFolderPicker`）一律不動。
 *
 * 開關判據（**單一真源**）：
 *   點按時對**當前值**取 `toTraditionalText(x) === x` ——
 *     成立（已是繁體）⇒ 本次做 **t2s**；不成立 ⇒ 本次做 **s2t**。
 *   ⇒ 同一個值連點兩下即「簡 → 繁 → 簡」來回切；**不提供撤銷**（本表單口徑）。
 *   轉換本身走 `src/utils/traditional.js` 的**異步全量版**（詞組表口徑，避免逐字表誤轉），
 *   期間圖示進忙碌態（`disabled` ＋ `aria-busy`），**不顯進度條、不顯百分比**。
 *   轉換失敗 ⇒ **值不變**、給一行可讀繁體提示（不靜默、不假裝成功）。
 *   空值 ⇒ 圖示禁用（轉了也沒意義）。
 *
 * 鉤子（**新名**；不併入舊三鈕那組的取值集合，亦不改動其既有取值）：
 *   - `data-transform-toggle="s2t|t2s"`：本次**實際方向**（點按後即保持該次方向，直到下一次點按；
 *     尚未點按時為**下一次**將走的方向，由同一判據算出，恆為二值之一、不空置）。
 *   - `data-transform-toggle-busy`：繁忙態標記 —— 轉換在途為 `"true"`，其餘**屬性缺省**（非繁忙）。
 *   - `data-transform-toggle-message`：一行提示（僅「未變更／失敗」時出現）。
 *   **嚴禁**新增管理員動作屬性（AC-45 的取值集合不變）。
 *
 * 呈現紀律：`title` / `aria-label` / 提示文案**一律繁體**、零內部語彙；
 *   圖示為**內聯 SVG**（倉內無圖示庫；先例 `AppHeader.vue`），尺寸與輸入框行高一致、不搶眼。
 */
import { computed, ref } from 'vue'
import { toTraditionalText, toTraditionalFull, toSimplifiedFull } from '../utils/traditional.js'

const props = defineProps({
  /** 當前字段值（`v-model`，與舊組件同一契約）。 */
  modelValue: { type: String, default: '' },
  /** 字段顯示名（只用於 `title` / `aria-label`，不參與轉換）。 */
  fieldLabel: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

/** 轉換失敗文案（單一真源；全繁體、零內部語彙，明說「內容未改動」）。 */
const FAILED_MESSAGE = '轉換未完成，內容保持不變；請檢查網絡後重試。'
/** 逐字未變文案（單一真源；不出「簡體 / 繁體」字樣 —— 方向信息只走懸停說明與圖標形態）。 */
const NO_CHANGE_MESSAGE = '此欄內容無可轉換的字，保持原樣。'

const busy = ref(false)
/** 本次點按的**實際方向**（`''` ⇒ 尚未點按）。 */
const lastDir = ref('')
const message = ref('')
const failed = ref(false)

const value = computed(() =>
  props.modelValue === null || props.modelValue === undefined ? '' : String(props.modelValue)
)
/** 空值判據：**含僅空白 / 僅全角空格**（`trim()` 一併去 U+3000）—— 三態切換（空／非空／復空）都按此現算。 */
const hasValue = computed(() => value.value.trim().length > 0)
/** **開關判據**：已是繁體 ⇔ 逐字繁化後原樣返回。 */
const isTraditionalNow = computed(() => hasValue.value && toTraditionalText(value.value) === value.value)
/** 下一次點按將走的方向（= 開關判據的結論）。 */
const pendingDir = computed(() => (isTraditionalNow.value ? 't2s' : 's2t'))
/** 鉤子值：點過 ⇒ 本次實際方向；未點 ⇒ 下一次方向（恆為 `s2t|t2s`）。 */
const direction = computed(() => lastDir.value || pendingDir.value)

const label = computed(() => props.fieldLabel || '本欄')
const hint = computed(() => {
  if (!hasValue.value) return `簡繁轉換：「${label.value}」暫無內容，無需轉換。`
  const from = isTraditionalNow.value ? '繁體' : '簡體'
  const to = isTraditionalNow.value ? '簡體' : '繁體'
  return `簡繁轉換（再次點按切回）：「${label.value}」目前為${from}，點按後轉為${to}。`
})

/**
 * 執行一次開關轉換。**只在用戶點按時調用**（不在掛載 / 提交 / 渲染路徑上轉換）。
 * 僅在值真的變化時 emit（判據同步拍板，轉換前即定方向）。
 * **成功不另加提示**（值已變即為反饋）；只有「無可轉換的字」與「失敗」各給一行可讀提示。
 */
async function apply() {
  if (busy.value || !hasValue.value) return
  const before = value.value
  const kind = toTraditionalText(before) === before ? 't2s' : 's2t'
  lastDir.value = kind
  busy.value = true
  failed.value = false
  message.value = ''
  try {
    const out = await (kind === 's2t' ? toTraditionalFull(before) : toSimplifiedFull(before))
    const next = typeof out === 'string' ? out : before
    if (next !== before && next.trim() !== '') {
      emit('update:modelValue', next)
    } else {
      /* 逐字未變 ⇒ 保持原樣並如實說明（不假裝成功、不改寫成空串）。 */
      message.value = NO_CHANGE_MESSAGE
    }
  } catch {
    /* 失敗：值不變（不 emit）、給可讀提示（不靜默、不假裝成功）。 */
    failed.value = true
    message.value = FAILED_MESSAGE
  } finally {
    busy.value = false
  }
}

/** 供質檢探針讀取的穩定形狀（不參與轉換邏輯）。 */
defineExpose({ busy, direction, lastDir, pendingDir, isTraditionalNow, hasValue, apply })
</script>

<template>
  <!-- 多根：圖示鈕與提示各自是所在行（`.field__row`）的 flex 子項 —— 提示 `flex: 1 1 100%`
       自帶換行，窄屏下只落到下一行，不把輸入框擠出、不撐破彈窗。 -->
  <button
    class="xtog"
    :class="{ 'xtog--busy': busy }"
    type="button"
    :title="hint"
    :aria-label="hint"
    :aria-busy="busy ? 'true' : 'false'"
    :disabled="busy || !hasValue"
    :data-transform-toggle="direction"
    :data-transform-toggle-busy="busy ? 'true' : null"
    @click="apply"
  >
    <!-- ⇄：上下兩支反向箭頭（純路徑，不依賴字體；小尺寸下仍可辨） -->
    <svg
      class="xtog__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 8.5h14" />
      <path d="M14 5l3.5 3.5L14 12" />
      <path d="M20.5 15.5h-14" />
      <path d="M10 12l-3.5 3.5L10 19" />
    </svg>
  </button>
  <span
    v-if="message"
    class="xtog__msg"
    :class="{ 'xtog__msg--failed': failed }"
    data-transform-toggle-message
    role="status"
  >{{ message }}</span>
</template>

<style scoped>
/* 尺寸跟輸入框行高一致（`.field input` ＝ 38px），寬度收窄、無文字標籤 ⇒ 不搶眼。 */
.xtog {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 38px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}

.xtog:hover:not(:disabled) {
  color: var(--c-brand);
  border-color: var(--c-brand);
}

.xtog:focus-visible {
  outline: 2px solid var(--c-brand);
  outline-offset: 1px;
}

.xtog:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.xtog__icon {
  width: 16px;
  height: 16px;
}

/* 忙碌態：變淡 ＋ 緩慢旋轉（不顯進度條、不顯百分比）。 */
.xtog--busy {
  opacity: 0.6;
}

.xtog--busy .xtog__icon {
  animation: xtog-spin 900ms linear infinite;
}

@keyframes xtog-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .xtog--busy .xtog__icon { animation: none; }
}

/* 一行提示：獨佔整行（flex-basis 100% ⇒ 換到下一行），故不會把輸入框擠窄。 */
.xtog__msg {
  flex: 1 1 100%;
  min-width: 0;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  line-height: 1.5;
}

.xtog__msg--failed {
  color: var(--c-danger);
}
</style>
