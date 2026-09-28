
<script setup>
/**
 * 三動作文本轉換組件（轉爲繁體 / 轉爲簡體 / 撤銷）——R-73 / R-74 / R-75（Kong，2026-09-21）。
 *
 * 契約（**另一單提供並在改**，本組件**只調不改、不自寫第二套轉換**）：
 *   `src/utils/traditional.js` 導出 **異步全量版** `toTraditionalFull(text)` / `toSimplifiedFull(text)`
 *   （含詞組表、**內部按需加載**）。⇒ 本組件的三個動作**一律用異步全量版**；
 *   等待期間給可讀態「轉換中…」；模組未就緒 ⇒ **可讀降級提示**（不靜默、不回落自寫轉換）。
 *
 * 語義（R-73）：
 *   - 轉爲繁體 ＝ 對**當前字段值**做 s2t（**冪等**：已是繁體則不變）；
 *   - 轉爲簡體 ＝ 對當前值做 t2s；
 *   - 撤銷 ＝ 還原該字段**上一次轉換前**的值（**單步、按字段記快照**；無轉換可撤時**按鈕禁用**）。
 *   **只作用於當前字段**（本組件只 emit 本欄的新值，絕不觸碰其它字段）。
 *
 * 觸發面（R-74）：轉換**只在用戶點按時**發生 —— 本組件不在掛載 / 提交 / 保存 / 渲染路徑上做任何轉換；
 *   提交值 ＝ 用戶所見的當前值（逐字），用戶輸入不被自動繁化（AC-78）。
 *
 * 呈現紀律（R-75）：按鈕文案與 `title` / `aria-label` **一律繁體**（含「建議使用繁體字提交」）；
 *   三鈕旁另有**不顯眼的長期提示**（`data-transform-hint`，單一真源 `TRANSFORM_HINT`，小字＋ muted 色）
 *   —— 多義字按設計不猜 ⇒ **轉換結果需用戶自行核對**（同句亦併入三鈕 `title` / `aria-label`）；
 *   控件鉤子 ＝ `data-transform="s2t|t2s|undo"`（另有 `data-transform-scope` 標明所屬字段，
 *   它**不是** `data-transform` 同名屬性、不污染 `[data-transform]` 的取值集合）；
 *   **嚴禁**在本組件內新增任何 `data-admin-action`（AC-45 的恰 6 值 / 5 類不得變）。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** 當前字段值（`v-model`）。 */
  modelValue: { type: String, default: '' },
  /** 字段標識（只作鉤子值，不參與轉換）。 */
  fieldKey: { type: String, default: '' },
  /** 字段顯示名（用於 tooltip / aria-label，如「印文釋義」）。 */
  fieldLabel: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

/** 降級提示文案（可讀；模組未就緒時給出，不靜默、不回落自寫轉換）。 */
const MODULE_MISSING_MESSAGE =
  '轉換模組未就緒（utils/traditional.js 的 toTraditionalFull / toSimplifiedFull 不可用），請稍後重試。'

/**
 * **不顯眼的長期提示（單一真源）**：一鍵轉換只處理**可自動定形**的字；上下文相關的多義字
 * （`為`/`發`/`據`/`種`/`後`/`當`/`幾`/`須`/`參`/`鏈`/`範`/`佔`/`恆`/`蟲`/`偽`/`簽`/`劃`/`閒`/`閑`/`鑑`/`鑒`）
 * 按設計**不猜**、原樣保留（**是邏輯缺口、不是缺陷**）⇒ 轉換結果**需用戶自行核對**。
 *
 * 同一句只寫一次，兩處承載、**不出現相互矛盾的說明**：
 *   ① 控件旁**可見**（小字號 ＋ muted 色；不彈窗、不 toast、不加色塊）；
 *   ② 併入三個按鈕的 `title` / `aria-label`（既有懸停說明與本句重疊處**合併**，見下方 hints）。
 */
const TRANSFORM_HINT = '轉換只處理可自動定形的字；少數多義字需自行核對。'

/**
 * 按需加載轉換模組（**動態 import**；導入失敗 ⇒ 拋出，由調用處掛可讀降級提示）。
 *
 * 兩種加載形態（**不改變契約、不自寫轉換**）：
 *   ① `import.meta.glob`（**首選**：構建期即可確定、產物路徑正確；目標模組缺位時取到空對象、**不報錯**）；
 *   ② 相對路徑 `import()` ＋ `@vite-ignore`（**兜底**：dev 環境下 glob 尚未刷新時也能取到模組；
 *      目標模組缺位時該 import 失敗 ⇒ 落到可讀降級提示）。
 * ⇒ **目標模組未落盤時本組件不是「壞掉」而是「可讀降級」**（且不影響頁面其餘部分渲染）。
 * 失敗後清空緩存 ⇒ 模組落盤後再點按即可成功（無需刷新頁面）。
 */
const TRANSFORM_MODULE_KEY = '../utils/traditional.js'
const TRANSFORM_MODULES = import.meta.glob('../utils/traditional.js')

let modulePromise = null
function loadTransformModule() {
  if (!modulePromise) {
    const loader =
      TRANSFORM_MODULES[TRANSFORM_MODULE_KEY] ||
      (() => import(/* @vite-ignore */ TRANSFORM_MODULE_KEY))
    modulePromise = loader()
      .then((mod) => {
        if (typeof mod.toTraditionalFull !== 'function' || typeof mod.toSimplifiedFull !== 'function') {
          throw new Error('CONTRACT_MISSING')
        }
        return mod
      })
      .catch((err) => {
        modulePromise = null
        throw err
      })
  }
  return modulePromise
}

const busy = ref(false)
/** 單步快照（**按字段**：每個字段各有一個本組件實例，快照只屬於本欄）。 */
const snapshot = ref(null)
const feedback = ref('')
const degraded = ref(false)

const hasSnapshot = computed(() => snapshot.value !== null)
const status = computed(() => {
  if (busy.value) return 'busy'
  if (degraded.value) return 'degraded'
  return 'idle'
})
const label = computed(() => props.fieldLabel || '本欄')

/* tooltip / aria-label 一律繁體（R-75）；繁體動作的說明裏必須帶「建議使用繁體字提交」。
   三句各自**以 `TRANSFORM_HINT` 收尾**（同一句，不另寫第二套說法）；
   `t2s` 原有的「便於自行核對」與本句重疊 ⇒ **合併**（不保留兩處相近文案）。 */
const s2tHint = computed(
  () => `將「${label.value}」的內容轉爲繁體（建議使用繁體字提交）；已是繁體時不變。${TRANSFORM_HINT}`
)
const t2sHint = computed(() => `將「${label.value}」的內容轉爲簡體。${TRANSFORM_HINT}`)
const undoHint = computed(
  () => `還原「${label.value}」上一次轉換前的內容（單步、僅本欄）。${TRANSFORM_HINT}`
)

/**
 * 執行一次轉換。**只在用戶點按時調用**（R-74）；僅在值真的變化時記快照並 emit。
 * @param {'s2t'|'t2s'} kind
 */
async function apply(kind) {
  if (busy.value) return
  const before = String(props.modelValue === null || props.modelValue === undefined ? '' : props.modelValue)
  busy.value = true
  feedback.value = ''
  try {
    const mod = await loadTransformModule()
    const convert = kind === 's2t' ? mod.toTraditionalFull : mod.toSimplifiedFull
    const out = await convert(before)
    const next = typeof out === 'string' ? out : before
    degraded.value = false
    if (next !== before) {
      snapshot.value = before // 單步：只記「上一次轉換前」的值
      emit('update:modelValue', next)
      feedback.value = kind === 's2t' ? '已轉爲繁體。' : '已轉爲簡體。'
    } else {
      feedback.value = kind === 's2t' ? '已是繁體，未改動。' : '已是簡體，未改動。'
    }
  } catch (err) {
    degraded.value = true
    feedback.value = MODULE_MISSING_MESSAGE
  } finally {
    busy.value = false
  }
}

/** 撤銷：還原本欄上一次轉換前的值（單步；撤銷後即無可撤 ⇒ 按鈕重新禁用）。 */
function undo() {
  if (busy.value || !hasSnapshot.value) return
  const target = String(snapshot.value)
  snapshot.value = null
  emit('update:modelValue', target)
  feedback.value = '已撤銷上一次轉換。'
}

/** 供質檢探針讀取的穩定形狀（不參與轉換邏輯）。 */
defineExpose({ hasSnapshot, busy, degraded })
</script>

<template>
  <div
    class="xform"
    :data-transform-scope="fieldKey"
    :data-transform-status="status"
    :data-transform-has-snapshot="hasSnapshot ? '1' : '0'"
  >
    <button
      class="btn btn--ghost xform__btn"
      type="button"
      data-transform="s2t"
      :title="s2tHint"
      :aria-label="s2tHint"
      :disabled="busy"
      @click="apply('s2t')"
    >
      轉爲繁體
    </button>
    <button
      class="btn btn--ghost xform__btn"
      type="button"
      data-transform="t2s"
      :title="t2sHint"
      :aria-label="t2sHint"
      :disabled="busy"
      @click="apply('t2s')"
    >
      轉爲簡體
    </button>
    <button
      class="btn btn--ghost xform__btn"
      type="button"
      data-transform="undo"
      :title="undoHint"
      :aria-label="undoHint"
      :disabled="busy || !hasSnapshot"
      @click="undo"
    >
      撤銷
    </button>
    <span v-if="busy" class="xform__status" data-transform-busy>轉換中…</span>
    <span
      v-else-if="feedback"
      class="xform__status"
      :data-transform-feedback="degraded ? 'degraded' : 'ok'"
    >{{ feedback }}</span>
    <!-- 不顯眼的長期提示（小字號 ＋ muted 色）：與三鈕 title/aria-label 同一句、單一真源。 -->
    <span class="xform__hint" data-transform-hint>{{ TRANSFORM_HINT }}</span>
  </div>
</template>

<style scoped>
.xform {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-1, 4px);
  margin-top: var(--s-1, 4px);
}

.xform__btn {
  padding: 1px var(--s-2, 8px);
  font-size: var(--t-xs, 12px);
  line-height: 1.6;
}

.xform__status {
  color: var(--c-text-muted);
  font-size: var(--t-xs, 12px);
}

/* 不顯眼：小字號 ＋ muted 級顏色；獨佔一行（不擠壓按鈕、不加底色/邊框/圖示）。 */
.xform__hint {
  flex: 0 0 100%;
  color: var(--c-text-muted, var(--muted, #574d40));
  font-size: var(--t-xs, 12px);
  font-weight: 400;
  line-height: 1.5;
}
</style>
