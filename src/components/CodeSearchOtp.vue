<script setup>
/* ============================================================================
   識別編碼 OTP 入口（口径件 §5｜R-4 自动判型）
   ----------------------------------------------------------------------------
   · **单框自动判型**：首字符 ∈ 22 字母 ⇒ 5 格字母键盘；首字符为数字 ⇒ 8 格数字键盘。
   · 每格单字符、**自动上移**（回格自动后退）、**自动大写**（字母入码一律归一大写）。
   · **粘贴归一**：去空白 / 连字符后按首字符判型并逐格填充；含非法字符 ⇒ 整次拒绝 ＋ 提示。
   · **非法字符一律就地拒**：`0 / 1 / I / L / O / U` 与其它非目标字符**当场拒绝**并给可读提示，
     **不做任何自动纠错映射**（字符集本就不含这些字母，无映射可做）。
   · 上屏文案一律**繁體**；本组件**不新增路由**、**不新增 `[data-admin-action]` 取值**。
   · 编码器真源 ＝ `src/utils/codeId.js`（与云函数副本逐字节相同；副作用导入，见其文件头纪律）。
   ============================================================================ */
import { computed, nextTick, ref } from 'vue'
import '../utils/codeId.js'

const CODE_ID = globalThis.__XIAI_CODE_ID__
const ALPHABET = CODE_ID ? CODE_ID.CODE_ALPHABET : 'ABCDEFGHJKMNPQRSTVWXYZ'

const emit = defineEmits(['submit'])

const mode = ref('letter') // 'letter'（5 格） | 'digit'（8 格）
const cells = ref(Array(5).fill(''))
const error = ref('')
const cellRefs = ref([])

const hint = computed(() =>
  mode.value === 'digit'
    ? '首字符為數字 ⇒ 8 格數字編碼（僅 0–9）'
    : '首字符為英文字母 ⇒ 5 格字母編碼（22 字母，不含 I / L / O / U）'
)
const complete = computed(() => cells.value.length > 0 && cells.value.every((ch) => ch !== ''))

function isDigitChar(ch) {
  return ch >= '0' && ch <= '9'
}
function isLetterChar(ch) {
  return ALPHABET.indexOf(ch) !== -1
}
function normalize(raw) {
  return String(raw === undefined || raw === null ? '' : raw).trim().toUpperCase()
}
function focusCell(index) {
  nextTick(() => {
    const list = Array.isArray(cellRefs.value) ? cellRefs.value : []
    const target = list[Math.max(0, Math.min(index, list.length - 1))]
    if (target) {
      target.focus()
      if (typeof target.select === 'function') target.select()
    }
  })
}
function placeChar(index, ch) {
  const next = [...cells.value]
  next[index] = ch
  cells.value = next
  error.value = ''
  if (index + 1 < next.length) focusCell(index + 1)
  else if (next.every((filled) => filled !== '')) emit('submit', next.join(''))
}

function onInput(index, event) {
  const typed = normalize(event.target.value)
  const ch = typed.slice(-1)
  if (!ch) {
    const next = [...cells.value]
    next[index] = ''
    cells.value = next
    error.value = ''
    return
  }
  /* **首字符判型**：默认 5 格字母；首格仍空且首字符是数字 ⇒ 切到 8 格数字键盘。 */
  if (mode.value === 'letter' && isDigitChar(ch) && cells.value.every((cell) => cell === '')) {
    mode.value = 'digit'
    cells.value = Array(8).fill('')
    error.value = ''
    placeChar(0, ch)
    return
  }
  if (mode.value === 'digit' && !isDigitChar(ch)) {
    event.target.value = cells.value[index] || ''
    error.value = '此編碼為 8 位數字，僅可輸入 0–9；該字符已就地拒絕。'
    return
  }
  if (mode.value === 'letter' && !isLetterChar(ch)) {
    event.target.value = cells.value[index] || ''
    error.value = '識別編碼僅可用 22 個英文字母（不含 I、L、O、U）；數字與其他字符一律就地拒絕。'
    return
  }
  placeChar(index, ch)
}

function onKeydown(index, event) {
  if (event.key === 'Backspace') {
    const next = [...cells.value]
    if (next[index] !== '') {
      next[index] = ''
      cells.value = next
      error.value = ''
      return
    }
    if (index > 0) {
      event.preventDefault()
      next[index - 1] = ''
      cells.value = next
      focusCell(index - 1)
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
  if (event.key === 'Enter' && complete.value) {
    event.preventDefault()
    emit('submit', cells.value.join(''))
  }
}

function onPaste(event) {
  const clipboard = event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null)
  const text = normalize(clipboard ? clipboard.getData('text') : '')
  if (!text) return
  event.preventDefault()
  const digits = isDigitChar(text.slice(0, 1))
  const count = digits ? 8 : 5
  const chars = text.split('').filter((ch) => ch !== ' ' && ch !== '-' && ch !== '—' && ch !== '－')
  const allowed = digits ? isDigitChar : isLetterChar
  if (chars.length > count || chars.some((ch) => !allowed(ch))) {
    error.value = digits
      ? '貼上的內容不是 8 位純數字編碼，已拒絕本次貼上。'
      : '貼上的內容含字母表以外的字符（I、L、O、U、數字或符號），已拒絕本次貼上。'
    return
  }
  mode.value = digits ? 'digit' : 'letter'
  const filled = Array(count).fill('')
  chars.forEach((ch, i) => {
    filled[i] = ch
  })
  cells.value = filled
  error.value = ''
  focusCell(Math.min(chars.length, count - 1))
  if (filled.every((cell) => cell !== '')) emit('submit', filled.join(''))
}

function submit() {
  if (complete.value) emit('submit', cells.value.join(''))
}

/** 由父级清空（一次查完 / 换一次查询）。 */
function reset() {
  mode.value = 'letter'
  cells.value = Array(5).fill('')
  error.value = ''
}

defineExpose({ reset })
</script>

<template>
  <div class="code-otp" data-code-search="otp">
    <div class="code-otp__head">
      <span class="code-otp__label">識別編碼</span>
      <span class="code-otp__hint">{{ hint }}</span>
    </div>
    <div class="code-otp__row" @paste="onPaste">
      <input
        v-for="(cell, index) in cells"
        :key="`${mode}-${index}`"
        :ref="(el) => { if (el) cellRefs[index] = el }"
        class="code-otp__cell"
        type="text"
        :inputmode="mode === 'digit' ? 'numeric' : 'text'"
        maxlength="1"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="characters"
        spellcheck="false"
        :value="cell"
        :aria-label="`識別編碼第 ${index + 1} 格`"
        @input="onInput(index, $event)"
        @keydown="onKeydown(index, $event)"
      />
      <button class="btn btn--primary code-otp__submit" type="button" :disabled="!complete" @click="submit">
        查詢
      </button>
    </div>
    <p v-if="error" class="code-otp__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.code-otp {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.code-otp__head {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  flex-wrap: wrap;
}

.code-otp__label {
  font-size: var(--t-sm);
  font-weight: 600;
  color: var(--c-text);
}

.code-otp__hint {
  font-size: var(--t-xs);
  color: var(--c-text-muted);
}

.code-otp__row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.code-otp__cell {
  width: 2.4rem;
  height: 2.8rem;
  text-align: center;
  font-size: var(--t-md);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
  border: 1px solid var(--c-border, #d8c9a3);
  border-radius: var(--r-sm, 6px);
  background: var(--c-surface, #fff);
  color: var(--c-text);
}

.code-otp__cell:focus {
  outline: 2px solid var(--slot-gold-text, #8a6d2f);
  outline-offset: 1px;
}

.code-otp__submit {
  margin-left: var(--s-2);
}

.code-otp__error {
  margin: 0;
  font-size: var(--t-xs);
  color: var(--c-danger, #b3261e);
}
</style>
