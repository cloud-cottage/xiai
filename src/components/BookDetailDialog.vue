<script setup>
/**
 * 【印譜詳情彈窗】`/books` 點卡片後開啟的 book 模態框（Kevin 2026-11-17 定：選 B）。
 *
 * 一個彈窗裝下**全部操作**（列表頁不再散落面板）：
 *   ① 詳情：全部欄位可編輯 ⇒ 只遞**改動過的鍵**給 `updateBook({book_id, patch})`；
 *   ② 掛圖：`searchBookImages` 檢索 → `toggleImage` 勾選 → `attachSelected` 逐張
 *      `setImageBook`（改掛前二次確認，與原面板同一口徑）；已掛影像可逐張**取消歸屬**
 *      （`setImageBook({image_id, book_id:null})`，`null` ＝ 取消，缺鍵 ≠ 取消）；
 *   ③ 選封面：在**已掛影像網格**裡點一張 ⇒ `setBookCover({book_id, image_id})`；另有「清除封面」。
 *
 * 硬口徑：
 *   · **封面不自動選**：本彈窗不會自己挑一張影像當封面（只有用戶點才算）；
 *   · 接口未就緒（`updateBook` / `setBookCover` 缺席）⇒ **明示缺哪個 op、本次零寫入**，不偽造成功；
 *   · 報錯**原樣上屏**（`message || reason` 逐字，不吞成通用提示）；
 *   · 彈窗 `role="dialog"` ＋ `aria-label`；ESC 走全倉單點 `useEscToClose`
 *     （提交中 / 掛圖中 / 封面寫入中 ⇒ ESC 不生效，不留半提交狀態）。
 */
import { computed, ref } from 'vue'
import ConfirmActionDialog from './ConfirmActionDialog.vue'
import PersonPicker from './PersonPicker.vue'
import { persons } from '../services/index.js'
import * as bookService from '../services/books.js'
import { useEscToClose } from '../utils/useEscToClose.js'

const props = defineProps({
  /** 印譜行（`BOOK_ROW_KEYS` 投影；開啟時由列表頁給快照） */
  book: { type: Object, required: true },
  /** 封面行（`listBookCovers` 回的 `{book_id, cover_image_id, thumb_key}`；可空） */
  cover: { type: Object, default: null },
  /** 當前封面的對象臨時鏈接（列表頁已解析；空串 ⇒ 顯示占位說明） */
  coverUrl: { type: String, default: '' },
  /** 印譜編號 → 顯示標籤（列表頁給；缺省退原編號） */
  labelOfBook: { type: Function, default: null }
})

const emit = defineEmits(['close', 'saved', 'cover-changed', 'count-changed'])

const currentYear = new Date().getFullYear()
const IMAGE_SEARCH_LIMIT = 24

/* **服務層 op 取用**：`updateBook` / `setBookCover` 由服務端**並行落地**（本單不改
   `services/books.js`）⇒ 這裡經一次 async 轉手取模組（不寫成靜態具名導入，免得打包期
   把「還不存在的導出」當成硬錯誤）；缺 op ⇒ 調用點如實提示、本次零寫入。 */
let bookApiPromise = null
function loadBookApi() {
  if (!bookApiPromise) bookApiPromise = Promise.resolve(bookService)
  return bookApiPromise
}

/** 清除封面的 `image_id` 形態（服務端約定為空串；若改成 `null` 只此一處）。 */
const CLEAR_COVER_IMAGE_ID = ''

const bookId = computed(() => String(props.book.id || ''))
const bookName = computed(() => String(props.book.name || '').trim() || '（無書名）')

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/* ------------------------------ ① 詳情（可編輯） ------------------------------ */
const detailForm = ref({
  name: text(props.book.name),
  author_person_id: text(props.book.author_person_id),
  publisher: text(props.book.publisher),
  isbn: text(props.book.isbn),
  cip: text(props.book.cip),
  first_publish_year: Number.isInteger(props.book.first_publish_year)
    ? String(props.book.first_publish_year)
    : ''
})
const saving = ref(false)
const saveError = ref('')
const saveFeedback = ref('')

const authorCandidates = computed(() => persons.referablePersons())

/** 首次出版年校验（空 ⇒ 合規；否則須為 1000〜當年的整數）。 */
function yearProblemOf(raw) {
  const value = text(raw)
  if (!value) return ''
  if (!/^\d{1,4}$/.test(value)) return `首次出版年須為整數年份（1000〜${currentYear}）。`
  const year = Number(value)
  if (!year || year < 1000 || year > currentYear) return `首次出版年須介於 1000〜${currentYear}。`
  return ''
}

/** 只把**改動過的鍵**放進 patch（未改的鍵不遞，避免無意義覆寫）。 */
function patchOf() {
  const base = props.book || {}
  const patch = {}
  if (text(detailForm.value.name) !== text(base.name)) patch.name = text(detailForm.value.name)
  if (text(detailForm.value.author_person_id) !== text(base.author_person_id)) {
    patch.author_person_id = text(detailForm.value.author_person_id)
  }
  if (text(detailForm.value.publisher) !== text(base.publisher)) patch.publisher = text(detailForm.value.publisher)
  if (text(detailForm.value.isbn) !== text(base.isbn)) patch.isbn = text(detailForm.value.isbn)
  if (text(detailForm.value.cip) !== text(base.cip)) patch.cip = text(detailForm.value.cip)
  const yearNow = text(detailForm.value.first_publish_year)
  const yearBase = Number.isInteger(base.first_publish_year) ? String(base.first_publish_year) : ''
  if (yearNow !== yearBase) patch.first_publish_year = yearNow === '' ? null : Number(yearNow)
  return patch
}

/** 保存詳情（一次性提交守衛在 `saving` 前置判，不靠按鈕 disabled）。 */
async function saveDetails() {
  if (saving.value) return
  saveError.value = ''
  saveFeedback.value = ''
  if (!text(detailForm.value.name)) {
    saveError.value = '書名不可為空；本次未提交。'
    return
  }
  const problem = yearProblemOf(detailForm.value.first_publish_year)
  if (problem) {
    saveError.value = problem
    return
  }
  const patch = patchOf()
  if (Object.keys(patch).length === 0) {
    saveFeedback.value = '沒有變更 —— 本次未提交。'
    return
  }
  const api = await loadBookApi()
  const update = api && typeof api.updateBook === 'function' ? api.updateBook : null
  if (!update) {
    saveError.value = '印譜詳情保存尚未就緒（服務層缺 `updateBook`）；本次零寫入。'
    return
  }
  saving.value = true
  let out = null
  try {
    out = await update({ book_id: bookId.value, patch })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  saving.value = false
  if (!out || out.ok !== true) {
    saveError.value = `保存失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}（本次未寫入）。`
    return
  }
  /* 服務端回 `book` ⇒ 以回包為準；未回 ⇒ 只把本次 patch 併上（不編造其它欄位）。 */
  const echoed = out.book && typeof out.book === 'object' ? out.book : null
  const merged = { ...props.book, ...(echoed || patch) }
  if (merged.name !== undefined) detailForm.value.name = text(merged.name)
  saveFeedback.value = `已保存 ${Object.keys(patch).length} 個欄位變更。`
  emit('saved', merged)
}

/* ------------------------------ ② 掛圖 ------------------------------ */
const imageSearch = ref({ q: '', busy: false, rows: [], total: 0, searched: false, error: '' })
const selectedImages = ref([]) // [{ imageId, stampId, bookId }]
const attaching = ref(false)
const attachFeedback = ref('')
const pendingAttach = ref(null) // { ids, conflicts }
const pendingDetach = ref('') // 待確認取消歸屬的影像編號
/** 本次彈窗內已成功掛到本書的影像（搜索行未必回最新歸屬 ⇒ 本地記一份即時反映）。 */
const localAttached = ref([])

const selectedImageIds = computed(() => new Set(selectedImages.value.map((row) => row.imageId)))

function isSelected(imageId) {
  return selectedImageIds.value.has(imageId)
}

/** 行字段读取（蛇形 / 驼峰二选一；缺 ⇒ 空串，不造值）。 */
function textOfRow(row, snake, camel) {
  const source = row && typeof row === 'object' ? row : {}
  const value = source[snake] !== undefined ? source[snake] : source[camel]
  return text(value)
}

function ownerLabelOf(imageId, ownerId) {
  const id = text(ownerId)
  if (!id) return '未歸屬'
  if (id === bookId.value) return '本印譜'
  const label = props.labelOfBook ? props.labelOfBook(id) : ''
  return label || id
}

/** 執行檢索（`q` 必填；空 ⇒ 本地擋，零請求）。 */
async function runImageSearch() {
  const keyword = text(imageSearch.value.q)
  if (!keyword) {
    imageSearch.value = { ...imageSearch.value, error: '請輸入檢索關鍵詞（印文 / 章號 / 序號）。', rows: [], total: 0, searched: false }
    return
  }
  if (imageSearch.value.busy) return
  if (typeof bookService.searchBookImages !== 'function') {
    imageSearch.value = { ...imageSearch.value, error: '影像檢索尚未就緒（服務層缺 `searchBookImages`）。' }
    return
  }
  imageSearch.value = { ...imageSearch.value, busy: true, error: '' }
  let out = null
  try {
    out = await bookService.searchBookImages({ q: keyword, limit: IMAGE_SEARCH_LIMIT })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  if (!out || out.ok !== true) {
    imageSearch.value = {
      ...imageSearch.value,
      busy: false,
      rows: [],
      total: 0,
      searched: true,
      error: `檢索失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}`
    }
    return
  }
  imageSearch.value = {
    ...imageSearch.value,
    busy: false,
    rows: Array.isArray(out.rows) ? out.rows : [],
    total: Number.isInteger(out.total) ? out.total : 0,
    searched: true,
    error: ''
  }
}

/** 勾選 / 取消（保留勾選時的歸屬快照 ⇒ 改掛確認據此明示「當前歸屬」）。 */
function toggleImage(row) {
  if (attaching.value) return
  const imageId = textOfRow(row, 'image_id', 'imageId')
  if (!imageId) return
  if (isSelected(imageId)) {
    selectedImages.value = selectedImages.value.filter((item) => item.imageId !== imageId)
    return
  }
  selectedImages.value = [
    ...selectedImages.value,
    { imageId, stampId: textOfRow(row, 'stamp_id', 'stampId'), bookId: textOfRow(row, 'book_id', 'bookId') }
  ]
}

function clearSelection() {
  if (attaching.value) return
  selectedImages.value = []
}

async function attachSelected() {
  if (attaching.value) return
  attachFeedback.value = ''
  if (!selectedImages.value.length) {
    attachFeedback.value = '請先勾選至少一張影像。'
    return
  }
  const conflicts = selectedImages.value
    .filter((item) => item.bookId && item.bookId !== bookId.value)
    .map((item) => ({ imageId: item.imageId, currentBookId: item.bookId }))
  if (conflicts.length) {
    pendingAttach.value = { ids: selectedImages.value.map((item) => item.imageId), conflicts }
    return
  }
  await runAttach(selectedImages.value.map((item) => item.imageId))
}

function cancelReassign() {
  if (attaching.value) return
  pendingAttach.value = null
}

async function confirmReassign() {
  if (attaching.value) return
  const pending = pendingAttach.value
  pendingAttach.value = null
  const ids = (pending && pending.ids) || []
  if (!ids.length) return
  await runAttach(ids)
}

/**
 * 逐張提交 `setImageBook`（**串行**，一張一判；回包須與請求一致才算成功）。
 * 失敗項保留勾選並給原話原因。
 */
async function runAttach(imageIds) {
  if (attaching.value) return
  const targetId = bookId.value
  if (!targetId || !imageIds.length) return
  if (typeof bookService.setImageBook !== 'function') {
    attachFeedback.value = '印譜服務尚未就緒（服務層缺 `setImageBook`）；本次零寫入。'
    return
  }
  attaching.value = true
  attachFeedback.value = ''
  const failures = []
  const succeeded = []
  const countEvents = []
  const attached = new Set(localAttached.value)
  for (const imageId of imageIds) {
    let out = null
    try {
      out = await bookService.setImageBook({ image_id: imageId, book_id: targetId })
    } catch (err) {
      out = { ok: false, message: (err && err.message) || '調用異常' }
    }
    const echoedImage = out && out.image_id !== undefined && out.image_id !== null ? String(out.image_id) : ''
    const echoedBook = out && out.book_id !== undefined && out.book_id !== null ? String(out.book_id) : ''
    if (out && out.ok === true && (!echoedImage || echoedImage === imageId) && echoedBook === targetId) {
      succeeded.push(imageId)
      attached.add(imageId)
      /* 關聯數即時反映：目標書 +1；若原屬別的書 ⇒ 原書 -1（改掛）。 */
      const previousBookId = (selectedImages.value.find((item) => item.imageId === imageId) || {}).bookId || ''
      countEvents.push({ book_id: targetId, delta: 1 })
      if (previousBookId && previousBookId !== targetId) countEvents.push({ book_id: previousBookId, delta: -1 })
    } else {
      failures.push(`${imageId}：${(out && (out.message || out.reason)) || '回包與請求不一致'}`)
    }
  }
  attaching.value = false
  localAttached.value = [...attached]
  const failedIds = new Set(failures.map((line) => line.split('：')[0]))
  selectedImages.value = selectedImages.value.filter((item) => failedIds.has(item.imageId))
  const okText = `已掛上 ${succeeded.length} 張影像到《${bookName.value}》。`
  attachFeedback.value = failures.length
    ? `${okText} ${failures.length} 張失敗 —— ${failures.join('；')}（失敗項保留勾選，可重試）。`
    : okText
  countEvents.forEach((event) => emit('count-changed', event))
}

/** 取消歸屬（先確認；`book_id: null` 是服務端口徑的唯一取消形態）。 */
function askDetach(imageId) {
  if (attaching.value) return
  pendingDetach.value = text(imageId)
}

function cancelDetach() {
  if (attaching.value) return
  pendingDetach.value = ''
}

async function confirmDetach() {
  if (attaching.value) return
  const imageId = pendingDetach.value
  pendingDetach.value = ''
  if (!imageId) return
  if (typeof bookService.setImageBook !== 'function') {
    attachFeedback.value = '印譜服務尚未就緒（服務層缺 `setImageBook`）；本次零寫入。'
    return
  }
  attaching.value = true
  attachFeedback.value = ''
  let out = null
  try {
    out = await bookService.setImageBook({ image_id: imageId, book_id: null })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  attaching.value = false
  if (!out || out.ok !== true) {
    attachFeedback.value = `取消歸屬失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}（${imageId} 仍歸屬原印譜）。`
    return
  }
  localAttached.value = localAttached.value.filter((id) => id !== imageId)
  selectedImages.value = selectedImages.value.filter((item) => item.imageId !== imageId)
  attachFeedback.value = `已把影像 ${imageId} 從《${bookName.value}》取消歸屬。`
  if (currentCoverId.value === imageId) currentCoverId.value = ''
  emit('count-changed', { book_id: bookId.value, delta: -1 })
}

/** 已掛影像行：搜索行上 `book_id` ＝ 本書，或本次彈窗內掛成功的。 */
const attachedRows = computed(() => {
  const rows = imageSearch.value.rows || []
  return rows.filter((row) => {
    const imageId = textOfRow(row, 'image_id', 'imageId')
    const owner = textOfRow(row, 'book_id', 'bookId')
    return owner === bookId.value || localAttached.value.indexOf(imageId) !== -1
  })
})

/* ------------------------------ ③ 選封面 ------------------------------ */
const currentCoverId = ref(text(props.cover && props.cover.cover_image_id))
const coverBusy = ref(false)
const coverError = ref('')
const coverFeedback = ref('')

/** 把一張**已掛在本書**的影像設為封面（用戶點才發生；不會自動挑）。 */
async function chooseCover(imageId) {
  const id = text(imageId)
  if (!id || coverBusy.value) return
  coverError.value = ''
  coverFeedback.value = ''
  if (id === currentCoverId.value) {
    coverFeedback.value = `影像 ${id} 已是本書封面；本次未提交。`
    return
  }
  const api = await loadBookApi()
  const setCover = api && typeof api.setBookCover === 'function' ? api.setBookCover : null
  if (!setCover) {
    coverError.value = '封面上線尚未就緒（服務層缺 `setBookCover`）；本次零寫入。'
    return
  }
  coverBusy.value = true
  let out = null
  try {
    out = await setCover({ book_id: bookId.value, image_id: id })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  coverBusy.value = false
  if (!out || out.ok !== true) {
    coverError.value = `設定封面失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}（本次未改動）。`
    return
  }
  currentCoverId.value = text(out.cover_image_id) || id
  coverFeedback.value = `已把影像 ${id} 設為《${bookName.value}》的封面。`
  emit('cover-changed', { book_id: bookId.value, cover_image_id: currentCoverId.value })
}

/** 清除封面（回到占位圖；卡片不因此報錯）。 */
async function clearCover() {
  if (coverBusy.value) return
  coverError.value = ''
  coverFeedback.value = ''
  if (!currentCoverId.value) {
    coverFeedback.value = '本書目前沒有封面；本次未提交。'
    return
  }
  const api = await loadBookApi()
  const setCover = api && typeof api.setBookCover === 'function' ? api.setBookCover : null
  if (!setCover) {
    coverError.value = '封面上線尚未就緒（服務層缺 `setBookCover`）；本次零寫入。'
    return
  }
  coverBusy.value = true
  let out = null
  try {
    out = await setCover({ book_id: bookId.value, image_id: CLEAR_COVER_IMAGE_ID })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  coverBusy.value = false
  if (!out || out.ok !== true) {
    coverError.value = `清除封面失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}（本次未改動）。`
    return
  }
  currentCoverId.value = ''
  coverFeedback.value = `已清除《${bookName.value}》的封面；卡片回到占位圖。`
  emit('cover-changed', { book_id: bookId.value, cover_image_id: '' })
}

/* ------------------------------ 彈窗門 ------------------------------ */
/** 任一寫入中 ⇒ ESC 不生效（不製造半提交狀態）。 */
function dialogBusy() {
  return saving.value || attaching.value || coverBusy.value || Boolean(pendingAttach.value) || Boolean(pendingDetach.value)
}

useEscToClose({ onCancel: () => emit('close'), isBusy: dialogBusy })
</script>

<template>
  <div class="book-dialog-mask" role="dialog" aria-modal="true" :aria-label="`印譜 ${book.id}《${bookName}》詳情`" data-book-dialog>
    <div class="book-dialog">
      <header class="book-dialog__head">
        <div class="book-dialog__heading">
          <span class="book-dialog__id">{{ book.id }}</span>
          <h2 class="book-dialog__title">{{ bookName }}</h2>
          <span class="book-dialog__sub">
            作者 {{ text(book.author_name) || '未收錄' }} ・ 首次出版年 {{ book.first_publish_year || '未著錄' }} ・
            關聯影像 {{ book.image_count || 0 }} 張
          </span>
        </div>
        <button class="btn btn--ghost" type="button" data-action="book-dialog-close" @click="emit('close')">
          關閉
        </button>
      </header>

      <!-- ① 詳情（可編輯；只遞改動過的鍵） -->
      <section class="book-dialog__section" data-book-dialog-section="detail">
        <h3 class="book-dialog__section-title">印譜詳情（可編輯）</h3>
        <div class="book-dialog__fields">
          <label class="book-dialog__field">
            <span>書名（必填）</span>
            <input v-model="detailForm.name" type="text" maxlength="200" data-book-dialog-field="name" />
          </label>
          <div class="book-dialog__field">
            <span>作者（必填，只可選印人庫已收錄的人）</span>
            <PersonPicker
              v-model="detailForm.author_person_id"
              :persons="authorCandidates"
              :person-name="persons.personName"
              label="作者"
              data-author-picker="book-dialog"
            />
          </div>
          <label class="book-dialog__field">
            <span>出版社（可空）</span>
            <input v-model="detailForm.publisher" type="text" maxlength="200" data-book-dialog-field="publisher" />
          </label>
          <label class="book-dialog__field">
            <span>ISBN（可空）</span>
            <input v-model="detailForm.isbn" type="text" maxlength="64" data-book-dialog-field="isbn" />
          </label>
          <label class="book-dialog__field">
            <span>CIP（可空）</span>
            <input v-model="detailForm.cip" type="text" maxlength="64" data-book-dialog-field="cip" />
          </label>
          <label class="book-dialog__field">
            <span>首次出版年（可空，1000〜{{ currentYear }}）</span>
            <input
              v-model="detailForm.first_publish_year"
              type="number"
              min="1000"
              :max="currentYear"
              step="1"
              data-book-dialog-field="first_publish_year"
            />
          </label>
        </div>
        <p v-if="saveError" class="notice book-dialog__notice" data-book-dialog-feedback="save-error">{{ saveError }}</p>
        <p v-if="saveFeedback" class="notice book-dialog__notice" data-book-dialog-feedback="save">
          {{ saveFeedback }}
        </p>
        <div class="book-dialog__foot">
          <button class="btn btn--primary" type="button" data-action="book-dialog-save" :disabled="saving" @click="saveDetails">
            {{ saving ? '正在保存…' : '保存詳情' }}
          </button>
        </div>
      </section>

      <!-- ② 掛圖 ＋ ③ 選封面（封面只可由用戶在已掛影像裡點選） -->
      <section class="book-dialog__section" data-book-dialog-section="attach">
        <h3 class="book-dialog__section-title">掛圖與封面</h3>
        <p class="book-dialog__hint">
          檢索可掛影像 → 勾選 → 逐張掛上（已歸屬其它印譜的影像改掛前須確認）。
          封面**不會自動選**：掛好後在「已掛影像」網格裡點一張，才會成為本書封面。
        </p>
        <form class="book-dialog__search" data-book-dialog-search @submit.prevent="runImageSearch">
          <input
            v-model="imageSearch.q"
            type="search"
            maxlength="60"
            placeholder="輸入印文 / 章號 / 序號，如「登彼太行」或 AACBM"
            aria-label="檢索影像"
          />
          <button class="btn btn--primary" type="submit" data-action="book-dialog-search" :disabled="imageSearch.busy">
            {{ imageSearch.busy ? '檢索中…' : '檢索' }}
          </button>
        </form>
        <p class="book-dialog__hint">
          命中 {{ imageSearch.total }} 張，已勾選 {{ selectedImages.length }} 張<template
            v-if="imageSearch.total > imageSearch.rows.length"
          >，僅列前 {{ imageSearch.rows.length }} 張 ⇒ 請收窄關鍵詞</template>。
        </p>
        <p v-if="imageSearch.error" class="notice book-dialog__notice" data-book-dialog-feedback="search">
          {{ imageSearch.error }}
        </p>

        <ul v-if="imageSearch.rows.length" class="book-dialog__images">
          <li v-for="row in imageSearch.rows" :key="row.image_id" class="book-dialog__image" :data-image-id="row.image_id">
            <label class="book-dialog__image-check">
              <input
                type="checkbox"
                :checked="isSelected(row.image_id)"
                :disabled="attaching"
                data-action="book-dialog-pick"
                @change="toggleImage(row)"
              />
              <span class="book-dialog__image-id">{{ row.image_id }}</span>
            </label>
            <span class="book-dialog__image-meta">
              {{ row.seal_name || '（未命名印章）' }}（{{ row.stamp_id || '無編號' }}）・ {{ row.kind || '影像' }}
            </span>
            <span class="book-dialog__image-owner">{{ ownerLabelOf(row.image_id, row.book_id) }}</span>
          </li>
        </ul>
        <p v-else-if="imageSearch.searched && !imageSearch.error" class="book-dialog__empty">
          沒有符合條件的影像；換個關鍵詞再試（印文片段也可）。
        </p>
        <p v-else-if="!imageSearch.searched" class="book-dialog__empty">
          尚未檢索 —— 輸入印文 / 章號後按【檢索】。
        </p>

        <p v-if="attachFeedback" class="notice book-dialog__notice" data-book-dialog-feedback="attach">
          {{ attachFeedback }}
        </p>
        <div class="book-dialog__foot">
          <button class="btn btn--ghost" type="button" data-action="book-dialog-clear" :disabled="attaching" @click="clearSelection">
            清空勾選
          </button>
          <button
            class="btn btn--primary"
            type="button"
            data-action="book-dialog-attach"
            :disabled="attaching"
            @click="attachSelected"
          >
            {{ attaching ? '正在逐張提交…' : `掛上所選影像（${selectedImages.length}）` }}
          </button>
        </div>

        <!-- 已掛影像網格：點一張 ⇒ 設為封面；另有逐張「取消歸屬」。 -->
        <h4 class="book-dialog__sub-title">已掛影像（{{ attachedRows.length }} 張；點一張設為封面）</h4>
        <p class="book-dialog__hint" data-book-dialog-current-cover>
          當前封面：{{ currentCoverId || '未設（卡片顯示占位圖）' }}
        </p>
        <div v-if="attachedRows.length" class="book-dialog__covers" data-book-dialog-covers>
          <div v-for="row in attachedRows" :key="`cover-${row.image_id}`" class="book-dialog__cover">
            <button
              class="book-dialog__cover-pick"
              type="button"
              :data-cover-image-id="row.image_id"
              :disabled="coverBusy || row.image_id === currentCoverId"
              data-action="book-dialog-set-cover"
              @click="chooseCover(row.image_id)"
            >
              <span class="book-dialog__cover-id">{{ row.image_id }}</span>
              <span class="book-dialog__cover-name">{{ row.seal_name || '（未命名印章）' }}</span>
              <span class="book-dialog__cover-flag">{{ row.image_id === currentCoverId ? '當前封面' : '設為封面' }}</span>
            </button>
            <button
              class="btn btn--ghost book-dialog__cover-detach"
              type="button"
              :disabled="attaching"
              data-action="book-dialog-detach"
              @click="askDetach(row.image_id)"
            >
              取消歸屬
            </button>
          </div>
        </div>
        <p v-else class="book-dialog__empty" data-book-dialog-covers-empty>
          尚未檢索到本書已掛的影像 —— 先在上面檢索並掛上，之後才可在這裡點選封面。
        </p>
        <p v-if="coverError" class="notice book-dialog__notice" data-book-dialog-feedback="cover-error">
          {{ coverError }}
        </p>
        <p v-if="coverFeedback" class="notice book-dialog__notice" data-book-dialog-feedback="cover">
          {{ coverFeedback }}
        </p>
        <div class="book-dialog__foot">
          <button
            class="btn btn--ghost"
            type="button"
            data-action="book-dialog-clear-cover"
            :disabled="coverBusy || !currentCoverId"
            @click="clearCover"
          >
            {{ coverBusy ? '正在提交…' : '清除封面' }}
          </button>
        </div>
      </section>
    </div>

    <!-- 改掛確認（已歸屬其它印譜的影像）：明示當前歸屬，確認後逐張提交。 -->
    <ConfirmActionDialog
      v-if="pendingAttach"
      title="確認改掛印譜"
      :message="`所選影像中有 ${pendingAttach.conflicts.length} 張已歸屬其它印譜；一張影像只歸一本，改掛後即從原印譜移出。`"
      :detail="pendingAttach.conflicts.map((item) => `${item.imageId}：現屬 ${ownerLabelOf(item.imageId, item.currentBookId)}`).join('；')"
      hint="確認後逐張提交；失敗的影像會保留在勾選中並給出原因。"
      confirm-text="確認改掛"
      cancel-text="取消"
      confirm-action="book-dialog-confirm-attach"
      cancel-action="book-dialog-cancel-attach"
      :busy="attaching"
      @confirm="confirmReassign"
      @cancel="cancelReassign"
    />

    <!-- 取消歸屬確認：明確說出「一本影像只歸一本」。 -->
    <ConfirmActionDialog
      v-if="pendingDetach"
      title="確認取消歸屬"
      :message="`影像 ${pendingDetach} 將從《${bookName}》移出（歸屬清空）。`"
      hint="取消後該影像回到未歸屬狀態，可再掛到別的印譜。"
      confirm-text="確認取消歸屬"
      cancel-text="取消"
      confirm-action="book-dialog-confirm-detach"
      cancel-action="book-dialog-cancel-detach"
      :busy="attaching"
      @confirm="confirmDetach"
      @cancel="cancelDetach"
    />
  </div>
</template>

<style scoped>
.book-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-4);
  background: var(--c-overlay);
}

.book-dialog {
  width: 100%;
  max-width: 980px;
  max-height: 90vh;
  overflow-y: auto;
  padding: var(--s-4) var(--s-5) var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.book-dialog__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-3);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--c-line);
}

.book-dialog__heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.book-dialog__id {
  color: var(--c-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
}

.book-dialog__title {
  font-size: var(--t-lg);
  color: var(--c-text);
}

.book-dialog__sub {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-dialog__section {
  margin-top: var(--s-4);
}

.book-dialog__section-title {
  margin-bottom: var(--s-2);
  font-size: var(--t-md);
  color: var(--c-text);
}

.book-dialog__sub-title {
  margin: var(--s-4) 0 var(--s-2);
  font-size: var(--t-sm);
  color: var(--c-text);
}

.book-dialog__hint {
  margin-bottom: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  line-height: 1.5;
}

.book-dialog__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-3);
}

.book-dialog__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: var(--t-xs);
  color: var(--c-text-muted);
}

.book-dialog__field input {
  padding: 6px 8px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text);
  font: inherit;
}

.book-dialog__search {
  display: flex;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
}

.book-dialog__search input {
  flex: 1 1 auto;
  padding: 6px 8px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text);
  font: inherit;
}

.book-dialog__notice {
  margin: var(--s-2) 0;
}

.book-dialog__empty {
  padding: var(--s-3);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-dialog__images {
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.book-dialog__image {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-1) 0;
  border-bottom: 1px solid var(--c-line);
}

.book-dialog__image-check {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-width: 180px;
  cursor: pointer;
}

.book-dialog__image-id {
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
}

.book-dialog__image-meta {
  flex: 1 1 auto;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-dialog__image-owner {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-dialog__covers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--s-2);
}

.book-dialog__cover {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-dialog__cover-pick {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--s-2);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  background: var(--c-surface-sunken);
  color: var(--c-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.book-dialog__cover-pick:disabled {
  cursor: default;
  border-color: var(--c-line-strong);
}

.book-dialog__cover-id {
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
}

.book-dialog__cover-name {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-dialog__cover-flag {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-dialog__cover-detach {
  align-self: flex-start;
}

.book-dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-3);
}

@media (max-width: 720px) {
  .book-dialog__fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
