<script setup>
/* ============================================================================
   頁頭「單框雙態」搜索框（交互重構單｜由 `CodeSearchOtp.vue` 改造而來）
   ----------------------------------------------------------------------------
   同一個輸入框、兩種形態，**全站唯一搜索入口**（頁頭在任何頁面皆可用）：

   · **首字符判型**（忽略大小寫，只看首字符）：
       - 首字符 ∈ 22 字母 `ABCDEFGHJKMNPQRSTVWXYZ` ⇒ **字母 OTP**（5 格）；
       - 首字符 ∈ `0–9` ⇒ **數字 OTP**（8 格）；
       - **漢字及其它一切**（含空白、標點，以及 `I / L / O / U` 這四個
         拉丁但不在 22 字母表內的字母）⇒ **普通關鍵詞框**，**不觸發 OTP**、
         **不劫持輸入**、**不彈錯誤**。
   · **普通態**：`type=search` 輸入框（保留原 placeholder 與 420px 寬度觀感），
     仍**只按回車**提交關鍵詞（不改為輸入即搜）⇒ `submit-keyword`。
   · **OTP 態**：逐格單字符、自動上移、自動大寫；**填滿即自動檢索**（同時支持
     回車）⇒ `submit-code`（父級帶 `query:{code}` 走精確查）。
   · **復原**：OTP 態退格至**第 1 格變空** ⇒ 就地復原普通搜索框（清空、焦點保持）；
     另有「取消」小鈕與 `Esc` 同路復原。
   · **粘貼**：貼 5 位字母 / 8 位數字（可含空白、連字符、小寫）⇒ 直接進 OTP
     逐格填充並即檢索；貼上的候選碼**含非法字符或位數不對 ⇒ 整次拒絕**＋繁體提示；
     首字符非碼類（漢字等）⇒ 放行原生粘貼（當關鍵詞）。
   · **非法字符一律就地拒**（`I / L / O / U`、數字、符號），**不做自動糾錯映射**。
   · 取證鉤子：輸入控件上掛 `data-code-mode="plain|letter|digit"`；OTP 格沿用
     既有 `code-otp__cell` 類。本元件**不新增路由**、**不新增 `[data-admin-action]`**。
   · 上屏文案一律**繁體**；編碼器真源 ＝ `src/utils/codeId.js`（副作用導入）。
   ============================================================================ */
import { nextTick, ref } from 'vue'
import '../utils/codeId.js'

const CODE_ID = globalThis.__XIAI_CODE_ID__
const ALPHABET = CODE_ID ? CODE_ID.CODE_ALPHABET : 'ABCDEFGHJKMNPQRSTVWXYZ'

const props = defineProps({
  /** 掛載時帶入的初始關鍵詞（取自 `route.query.q`；只讀一次，不做後續同步）。 */
  initialQuery: { type: String, default: '' }
})
const emit = defineEmits(['submit-keyword', 'submit-code'])

const mode = ref('plain') // 'plain'（普通關鍵詞框）| 'letter'（5 格）| 'digit'（8 格）
const keyword = ref(props.initialQuery)
const cells = ref([])
const error = ref('')
const cellRefs = ref([])
const plainInput = ref(null)
const composing = ref(false) // 中文輸入法組詞中：此間**不判型**，避免拼音字母誤觸 OTP

/* ------------------------------- 基礎判定 ------------------------------- */
/** 嚴格單字符判定：`indexOf('') === 0` 的陷阱必須擋掉（空串曾被誤判成「合法字母」）。 */
function isSingleChar(ch) {
  return typeof ch === 'string' && ch.length === 1
}
function isDigitChar(ch) {
  return isSingleChar(ch) && ch >= '0' && ch <= '9'
}
function isLetterChar(ch) {
  return isSingleChar(ch) && ALPHABET.indexOf(ch) !== -1
}
function normalize(raw) {
  return String(raw === undefined || raw === null ? '' : raw).trim().toUpperCase()
}
function focusCell(index) {
  nextTick(() => {
    const list = Array.isArray(cellRefs.value) ? cellRefs.value : []
    /* 夾取範圍按**當前格數**（而非 ref 陣列長度）：換形態後舊格的殘留 ref 不參與聚焦。 */
    const last = Math.max(0, cells.value.length - 1)
    const target = list[Math.max(0, Math.min(index, last))]
    if (target) {
      target.focus()
      if (typeof target.select === 'function') target.select()
    }
  })
}
function focusPlain() {
  nextTick(() => {
    const target = plainInput.value
    if (target && typeof target.focus === 'function') target.focus()
  })
}

/* --------------------------- 形態切換（單點） --------------------------- */
/** 進 OTP 態並以首字符落格（第 1 格必非空 ⇒ 進來即可繼續輸入 / 直接退格復原）。 */
function enterCodeMode(kind, seed) {
  if (!isSingleChar(seed)) return // 防禦：無有效首字符不進 OTP（空串不得判型）
  const count = kind === 'digit' ? 8 : 5
  const filled = Array(count).fill('')
  filled[0] = seed
  mode.value = kind
  cells.value = filled
  error.value = ''
  keyword.value = '' // 兩態共用一個框：進 OTP 即清空關鍵詞（復原後同為空態）
  focusCell(1)
}
/** 復原普通搜索框（清空 + 焦點保持）。 */
function revertToPlain() {
  mode.value = 'plain'
  cells.value = []
  error.value = ''
  keyword.value = ''
  focusPlain()
}

/* ------------------------------ 普通態 ------------------------------ */
/** 首字符判型：漢字 / `I / L / O / U` / 標點 / 空白一律留在普通態。 */
function classifyFromPlain(raw) {
  const first = String(raw === undefined || raw === null ? '' : raw).charAt(0).toUpperCase()
  if (isDigitChar(first)) {
    enterCodeMode('digit', first)
    return
  }
  if (isLetterChar(first)) {
    enterCodeMode('letter', first)
    return
  }
  error.value = ''
}

function onPlainInput(event) {
  /* 組詞中（IME）不判型；`compositionend` 後按最終文本再判一次。 */
  if (event.isComposing || composing.value) return
  classifyFromPlain(event.target.value)
}

function onCompositionEnd(event) {
  composing.value = false
  classifyFromPlain(event.target ? event.target.value : keyword.value)
}

function onPlainEnter() {
  emit('submit-keyword', String(keyword.value === undefined || keyword.value === null ? '' : keyword.value).trim())
}

/** 粘貼：碼類候選（首字符為數字 / 22 字母）⇒ 必須是完整合法碼，否則整次拒；否則按關鍵詞放行。 */
function onPlainPaste(event) {
  const clipboard = event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null)
  const text = normalize(clipboard ? clipboard.getData('text') : '')
  /* 去空白 / 連字符（半全形）後再判型 —— 與 OTP 格粘貼同一歸一口徑。 */
  const candidate = text.split('').filter((ch) => ch !== ' ' && ch !== '-' && ch !== '—' && ch !== '－').join('')
  const first = candidate.charAt(0)
  if (!isDigitChar(first) && !isLetterChar(first)) return // 關鍵詞粘貼：放行原生行為，由輸入事件判型
  const digits = isDigitChar(first)
  const count = digits ? 8 : 5
  const allowed = digits ? isDigitChar : isLetterChar
  if (candidate.length !== count || candidate.split('').some((ch) => !allowed(ch))) {
    event.preventDefault()
    error.value = digits
      ? '貼上的內容不是 8 位純數字識別編碼，已整次拒絕本次貼上。'
      : '貼上的內容不是 5 位字母識別編碼（字母表不含 I、L、O、U，且不得混入數字或符號），已整次拒絕本次貼上。'
    return
  }
  event.preventDefault()
  mode.value = digits ? 'digit' : 'letter'
  const filled = Array(count).fill('')
  candidate.split('').forEach((ch, index) => {
    filled[index] = ch
  })
  cells.value = filled
  keyword.value = ''
  error.value = ''
  focusCell(count - 1)
  emit('submit-code', candidate) // 已填滿 ⇒ 即檢索
}

/* ------------------------------ OTP 態 ------------------------------ */
function placeChar(index, ch) {
  const next = [...cells.value]
  next[index] = ch
  cells.value = next
  error.value = ''
  if (index + 1 < next.length) focusCell(index + 1)
  else if (next.every((filled) => filled !== '')) emit('submit-code', next.join(''))
}

function onCellInput(index, event) {
  const typed = normalize(event.target.value)
  const ch = typed.slice(-1)
  if (!ch) {
    const next = [...cells.value]
    next[index] = ''
    cells.value = next
    error.value = ''
    /* **退格至第 1 格為空 ⇒ 復原普通搜索框**（清空、焦點保持）。 */
    if (next.length === 0 || next[0] === '') revertToPlain()
    return
  }
  if (mode.value === 'digit' && !isDigitChar(ch)) {
    event.target.value = cells.value[index] || ''
    error.value = '此識別編碼為 8 位數字，僅可輸入 0–9；該字符已就地拒絕。'
    return
  }
  if (mode.value === 'letter' && !isLetterChar(ch)) {
    event.target.value = cells.value[index] || ''
    error.value = '識別編碼僅可用 22 個英文字母（不含 I、L、O、U）；數字與其他字符一律就地拒絕。'
    return
  }
  placeChar(index, ch)
}

function onCellKeydown(index, event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    revertToPlain()
    return
  }
  if (event.key === 'Backspace') {
    const next = [...cells.value]
    if (next[index] !== '') {
      next[index] = ''
      cells.value = next
      error.value = ''
      if (next[0] === '') revertToPlain()
      return
    }
    if (index > 0) {
      event.preventDefault()
      next[index - 1] = ''
      cells.value = next
      focusCell(index - 1)
      if (next[0] === '') revertToPlain()
    }
    return
  }
  if (event.key === 'ArrowLeft' && index > 0) {
    event.preventDefault()
    focusCell(index - 1)
    return
  }
  if (event.key === 'ArrowRight' && index < cells.value.length - 1) {
    event.preventDefault()
    focusCell(index + 1)
    return
  }
  const complete = cells.value.length > 0 && cells.value.every((ch) => ch !== '')
  if (event.key === 'Enter' && complete) {
    event.preventDefault()
    emit('submit-code', cells.value.join(''))
  }
}

/** OTP 態粘貼：整次校驗（位數 + 字符集），不合法即整次拒絕並給繁體提示。 */
function onCellPaste(event) {
  const clipboard = event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null)
  const text = normalize(clipboard ? clipboard.getData('text') : '')
  if (!text) return
  event.preventDefault()
  const digits = isDigitChar(text.slice(0, 1))
  const count = digits ? 8 : 5
  const chars = text.split('').filter((ch) => ch !== ' ' && ch !== '-' && ch !== '—' && ch !== '－')
  const allowed = digits ? isDigitChar : isLetterChar
  if (chars.length !== count || chars.some((ch) => !allowed(ch))) {
    error.value = digits
      ? '貼上的內容不是 8 位純數字識別編碼，已整次拒絕本次貼上。'
      : '貼上的內容不是 5 位字母識別編碼（字母表不含 I、L、O、U，且不得混入數字或符號），已整次拒絕本次貼上。'
    return
  }
  mode.value = digits ? 'digit' : 'letter'
  const filled = Array(count).fill('')
  chars.forEach((ch, index) => {
    filled[index] = ch
  })
  cells.value = filled
  error.value = ''
  focusCell(count - 1)
  emit('submit-code', chars.join('')) // 已填滿 ⇒ 即檢索
}
</script>

<template>
  <div class="header-search" :data-code-mode="mode">
    <!-- 普通態：沿用既有 `.app-header__search input` 樣式（placeholder / 420px 觀感不變）。 -->
    <input
      v-if="mode === 'plain'"
      ref="plainInput"
      v-model="keyword"
      class="header-search__input"
      data-code-mode="plain"
      type="search"
      placeholder="搜索印文、作者（印人姓名／字號／別名）或藏品編號"
      aria-label="全局搜索"
      @input="onPlainInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @paste="onPlainPaste"
      @keyup.enter="onPlainEnter"
    />

    <!-- OTP 態：同一個框就地變形（格子沿用既有 `code-otp__cell` 類）。 -->
    <div v-else class="header-search__otp" data-code-search="otp" :data-code-mode="mode">
      <input
        v-for="(cell, index) in cells"
        :key="`${mode}-${index}`"
        :ref="(el) => { cellRefs[index] = el }"
        class="code-otp__cell"
        type="text"
        :data-code-mode="mode"
        :inputmode="mode === 'digit' ? 'numeric' : 'text'"
        maxlength="1"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="characters"
        spellcheck="false"
        :value="cell"
        :aria-label="`識別編碼第 ${index + 1} 格`"
        @input="onCellInput(index, $event)"
        @keydown="onCellKeydown(index, $event)"
        @paste="onCellPaste"
      />
      <button
        class="header-search__cancel"
        type="button"
        data-code-mode="cancel"
        aria-label="取消識別編碼，返回關鍵詞搜索"
        title="取消（Esc）"
        @click="revertToPlain"
      >
        ×
      </button>
    </div>

    <!-- 提示 / 拒絕語：絕對定位於框下方，**不撐高頁頭**（避免佈局跳動）。 -->
    <p v-if="error" class="header-search__error" role="alert" data-code-error>{{ error }}</p>
  </div>
</template>

<style scoped>
/* 兩態共用一個固定佔位（420px / 36px 高）⇒ 切換形態時頁頭不跳動。 */
.header-search {
  position: relative;
  width: 100%;
  max-width: 420px;
}

.header-search__otp {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  height: 36px;
  flex-wrap: nowrap;
}

/* 格子與頁頭輸入框同高；**逐項覆寫** `.app-header__search input` 的盒模型
   （width / padding / border-radius 等），避免全局圓角膠囊樣式外溢到格子上。 */
.code-otp__cell {
  width: 2.1rem;
  height: 34px;
  padding: 0;
  text-align: center;
  font-size: var(--t-md);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
  border: 1px solid var(--slot-header-search-line);
  border-radius: var(--r-sm, 6px);
  background: var(--slot-header-search-bg);
  color: var(--slot-header-text, var(--c-text));
  flex: 0 0 auto;
}

.code-otp__cell:focus {
  outline: 2px solid var(--slot-gold-text, #8a6d2f);
  outline-offset: 1px;
}

.header-search__cancel {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin-left: var(--s-1);
  padding: 0;
  line-height: 1;
  font-size: var(--t-lg);
  color: var(--slot-header-text, var(--c-text));
  background: transparent;
  border: 1px solid var(--slot-header-search-line);
  border-radius: 50%;
  cursor: pointer;
}

.header-search__cancel:hover {
  border-color: var(--slot-gold-text, #8a6d2f);
  color: var(--slot-gold-text, #8a6d2f);
}

.header-search__error {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 5;
  margin: 0;
  padding: var(--s-1) var(--s-3);
  font-size: var(--t-xs);
  color: var(--c-danger, #b3261e);
  background: var(--c-surface, #fff);
  border: 1px solid var(--c-border, #d8c9a3);
  border-radius: var(--r-sm, 6px);
}
</style>
