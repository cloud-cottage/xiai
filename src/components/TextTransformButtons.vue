
<script setup>
/**
 * 三動作文本轉換組件（轉爲繁體 / 轉爲簡體 / 撤銷）——R-73 / R-74 / R-75（Kong，2026-09-21）。
 * 首次點按另加**真實下載進度**與**失敗面**（R-PB1〜5，Zang，2026-09-29）。
 *
 * 契約（**另一單提供並在改**，本組件**只調不改、不自寫第二套轉換**）：
 *   `src/utils/traditional.js` 導出 **異步全量版** `toTraditionalFull(text)` / `toSimplifiedFull(text)`
 *   （含詞組表、**內部按需取回**），另導出 `loadPhraseTable(kind, onProgress)` —— 取詞組表並
 *   **流式**匯報真實下載進度。⇒ 本組件的三個動作**一律用異步全量版**；轉換前先 await 取表，
 *   期間顯示**真實百分比**進度；模組未就緒 / 取表失敗 ⇒ **可讀失敗態**（不靜默、不假成功、
 *   不回落自寫轉換），失敗態帶【重試】。
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
 * 呈現紀律（R-75 / R-PB4）：按鈕文案與 `title` / `aria-label` **一律繁體**（含「建議使用繁體字提交」）；
 *   三鈕旁另有**不顯眼的長期提示**（`data-transform-hint`，單一真源 `TRANSFORM_HINT`，小字＋ muted 色）
 *   —— 多義字按設計不猜 ⇒ **轉換結果需用戶自行核對**（同句亦併入三鈕 `title` / `aria-label`）；
 *   控件鉤子 ＝ `data-transform="s2t|t2s|undo"`（另有 `data-transform-scope` 標明所屬字段，
 *   它**不是** `data-transform` 同名屬性、不污染 `[data-transform]` 的取值集合）；
 *   進度面鉤子 ＝ `data-transform-load="loading|failed"` ／ `data-transform-progress` ／
 *   `data-transform-retry="1"`，文案**全繁體、零內部語彙**（不出一箇拉丁字母、不設第二套面板，
 *   樣式只用既有 token）；
 *   **進度面只服務「冷取」**（§3.36.1（a）：詞組表**已在本次會話內取得** ⇒ 再點按**不得再顯進度**）
 *   —— 此時退回**既有**的可讀等待態 `[data-transform-busy]`「轉換中…」（不顯進度條、不顯百分比，
 *   進度件也不因此常駐：§3.36.4（e）②）；
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
 * **取表失敗文案（單一真源）**：可讀、全繁體、**零內部語彙**（不提檔名 / 技術名），
 * 並明說「可重試」；具體動作出右側【重試】鈕承擔（不靠自動重試假裝成功）。
 */
const TABLE_FAILED_MESSAGE = '字庫資料下載失敗，轉換未執行；請檢查網絡後重試。'

/** **下載中**文案（單一真源；真百分比以 `（）` 追加，**不確定態不寫百分比**）。 */
const DOWNLOAD_TEXT = '正下載字庫資料…'
/** **取回完成、本地轉換中**文案（單一真源；毫秒級 ⇒ 不顯百分比）。 */
const CONVERTING_TEXT = '正在轉換…'
/** **既有等待態**文案（表已在會話內取得時的唯一等待反饋；**不是**進度面、不顯百分比）。 */
const BUSY_TEXT = '轉換中…'

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
/** 本次點按的動作（重試要重放同一個動作）。 */
const lastKind = ref('s2t')
/** 取表進度：`{ phase: 'download'|'ready', ratio: number|null, loaded, total }`；`null` ⇒ 無進度面。 */
const progress = ref(null)
/** **本次點按是否需要去取表**（冷取 ⇒ `true`：進度面適用；表已在會話內 ⇒ `false`：只給既有等待態）。 */
const fetching = ref(false)
/** 失敗面（取表失敗 ⇒ `true`；**不靜默**：文案 ＋ 可見【重試】）。 */
const failed = ref(false)
/** 轉換模組是否帶**取表 ＋ 進度**接口（＝ `loadPhraseTable` 可調；質檢鉤子，不參與轉換邏輯）。 */
const hasLoader = ref(false)

const hasSnapshot = computed(() => snapshot.value !== null)
const status = computed(() => {
  if (busy.value) return 'busy'
  if (failed.value) return 'failed'
  if (degraded.value) return 'degraded'
  return 'idle'
})
const label = computed(() => props.fieldLabel || '本欄')
/** 進度面的階段：`loading`（下載中 / 轉換中）｜`failed`（取表失敗）；**冷取之外不出進度面**。 */
const loadState = computed(() => (failed.value ? 'failed' : fetching.value && busy.value ? 'loading' : ''))
/** 真實百分比（整數）；響應**沒有** `Content-Length` ⇒ `null` ⇒ 界面走**不確定態**（不假造百分比）。 */
const percent = computed(() => {
  const p = progress.value
  if (!p) return null
  if (p.phase === 'ready') return 100
  if (p.ratio === null || p.ratio === undefined) return null
  return Math.max(0, Math.min(100, Math.round(p.ratio * 100)))
})
/** 進度文案（全繁體；不確定態**不寫百分比**）。 */
const progressText = computed(() => {
  const p = progress.value
  if (p && p.phase === 'ready') return CONVERTING_TEXT
  if (!p) return DOWNLOAD_TEXT
  return percent.value === null ? DOWNLOAD_TEXT : `${DOWNLOAD_TEXT}（${percent.value}%）`
})

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
/** 【重試】說明（繁體，與失敗文案同一件事，不另寫第二套說法）。 */
const retryHint = computed(() => `重新下載「${label.value}」轉換所需的字庫資料，並重做本次轉換。`)

/**
 * 執行一次轉換。**只在用戶點按時調用**（R-74）；僅在值真的變化時記快照並 emit。
 * 轉換前先 `await loadPhraseTable()`（**首次**點按會有可觀的下載 ⇒ 給真百分比進度）；
 * 取表失敗 ⇒ 失敗態 ＋【重試】（**不**靜默回落、**不**假成功）。
 *
 * **進度面只服務「冷取」**（§3.36.1（a））：表已在本次會話內取得 ⇒ `fetching = false`
 * ⇒ 不出進度面、不發新請求，只給既有等待態 `[data-transform-busy]`（`轉換中…`）。
 * 判斷在**取表之前**同步拍板（`phraseTableInfo(kind).loaded`），進度面亦在**取表之前**即置位
 * （§3.36.4（e）①）。
 * @param {'s2t'|'t2s'} kind
 */
async function apply(kind) {
  if (busy.value) return
  const before = String(props.modelValue === null || props.modelValue === undefined ? '' : props.modelValue)
  lastKind.value = kind
  busy.value = true
  failed.value = false
  degraded.value = false
  feedback.value = ''
  fetching.value = false
  progress.value = null
  try {
    const mod = await loadTransformModule()
    hasLoader.value = typeof mod.loadPhraseTable === 'function'
    // 冷取判定：只有「本次會話內尚未取得該方向的詞組表」才顯進度（且此時才會有下載）
    const info = hasLoader.value && typeof mod.phraseTableInfo === 'function' ? mod.phraseTableInfo(kind) : null
    fetching.value = hasLoader.value && !(info && info.loaded)
    if (fetching.value) {
      progress.value = { phase: 'download', ratio: null, loaded: 0, total: null } // 取表前即見（不確定態起步）
      await mod.loadPhraseTable(kind, (p) => {
        if (!p || p.phase !== 'download') return
        progress.value = {
          phase: 'download',
          ratio: p.ratio === undefined ? null : p.ratio,
          loaded: p.loaded,
          total: p.total
        }
      })
      progress.value = { phase: 'ready', ratio: 1, loaded: 0, total: null } // 下載完成 ⇒ 餘下是本地計算（毫秒級）
    }
    const convert = kind === 's2t' ? mod.toTraditionalFull : mod.toSimplifiedFull
    const out = await convert(before)
    const next = typeof out === 'string' ? out : before
    if (next !== before) {
      snapshot.value = before // 單步：只記「上一次轉換前」的值
      emit('update:modelValue', next)
      feedback.value = kind === 's2t' ? '已轉爲繁體。' : '已轉爲簡體。'
    } else {
      feedback.value = kind === 's2t' ? '已是繁體，未改動。' : '已是簡體，未改動。'
    }
  } catch (err) {
    progress.value = null
    if (err && typeof err.code === 'string' && err.code.indexOf('PHRASE_TABLE_') === 0) {
      failed.value = true
      feedback.value = TABLE_FAILED_MESSAGE
    } else {
      degraded.value = true
      feedback.value = MODULE_MISSING_MESSAGE
    }
  } finally {
    busy.value = false
  }
}

/** 【重試】：重放**同一個動作**（`loadPhraseTable()` 內部嘗試次數 +1 ⇒ 真的**重新發請求**）。 */
function retry() {
  if (busy.value) return
  apply(lastKind.value)
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
defineExpose({ hasSnapshot, busy, degraded, failed, progress, fetching })
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
    <!-- 進度面 / 失敗面：**獨佔一行**（不擠壓三鈕、不改變既有排版的換行位置）。 -->
    <!-- **只在冷取時出現**（§3.36.1（a）：表已在會話內 ⇒ 不出進度面）。 -->
    <div
      v-if="loadState"
      class="xform__load"
      :data-transform-load="loadState"
      :aria-busy="loadState === 'loading' ? 'true' : 'false'"
    >
      <!-- 真實進度條：`percent === null` ⇒ **不確定態**（未知長度；不假造百分比） -->
      <span
        v-if="loadState === 'loading'"
        class="xform__bar"
        :class="{ 'xform__bar--indeterminate': percent === null }"
        data-transform-progress
        :data-transform-progress-loaded="progress ? progress.loaded : ''"
        :data-transform-progress-total="progress && progress.total !== null && progress.total !== undefined ? progress.total : ''"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent === null ? undefined : percent"
        :aria-valuetext="percent === null ? '下載中' : `${percent}%`"
      >
        <span class="xform__bar-fill" :style="percent === null ? null : { width: `${percent}%` }"></span>
      </span>
      <span v-if="loadState === 'loading'" class="xform__status" data-transform-progress-text>{{ progressText }}</span>
      <span v-else class="xform__status" data-transform-feedback="failed">{{ TABLE_FAILED_MESSAGE }}</span>
      <button
        v-if="loadState === 'failed'"
        class="btn btn--ghost xform__btn"
        type="button"
        data-transform-retry="1"
        :title="retryHint"
        :aria-label="retryHint"
        @click="retry"
      >
        重試
      </button>
    </div>
    <!-- 既有等待態（**非**進度面：冷取之外、以及取表已完成的收尾階段）：不顯進度條、不顯百分比。 -->
    <span v-else-if="busy" class="xform__status" data-transform-busy>{{ BUSY_TEXT }}</span>
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

/* 進度面 / 失敗面：獨佔一行（`flex: 0 0 100%` ⇒ 不參與三鈕那一行的寬度計算，
   窄屏 375px 下也不可能把行撐寬）；不新開面板、不加底色/邊框/圖示。 */
.xform__load {
  flex: 0 0 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-1, 4px);
  min-width: 0;
}

/* 進度條：4px 細條，走既有 token（`--c-surface-sunken` 底 / `--c-brand` 進度 / `--r-round` 圓角）。 */
.xform__bar {
  flex: 1 1 96px;
  min-width: 64px;
  max-width: 100%;
  height: 4px;
  border-radius: var(--r-round, 999px);
  background: var(--c-surface-sunken, #ece4d3);
  overflow: hidden;
}

.xform__bar-fill {
  display: block;
  height: 100%;
  width: 0;
  background: var(--c-brand, #a3271a);
  border-radius: var(--r-round, 999px);
  transition: width 120ms linear;
}

/* 不確定態（響應無 `Content-Length`）：跑馬燈 —— **不顯示任何百分比數字**。 */
.xform__bar--indeterminate .xform__bar-fill {
  width: 34%;
  animation: xform-pulse 1.1s ease-in-out infinite;
}

@keyframes xform-pulse {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
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
