<script setup>
/**
 * 【印譜匯觀】管理页（`/books`）—— 印譜（book）**卡片矩陣** ＋ 新建 ＋ 點卡開彈窗。
 *
 * 口径真源：`docs/book-catalog-ruling-2026-11-14.md`（§一 数据模型 / §二 菜单与路由 /
 * §三 写入面 / §四 前端 / §五 验收）；本页形态另按 Kevin 2026-11-17 定：
 *   · 列表 ＝ **卡片矩陣：每行 5 個、共 10 行（50 個位）**；不足 50 時**剩餘位留空**（不拉伸、
 *     欄固定五等分，不改成自動填充類寫法）；分頁沿用 `listBooks`（`limit=50` 正好一頁）；
 *   · **封面不自動選**（選 C）：卡片封面位一律先給**統一占位圖**；封面只能由用戶在彈窗裡手動選
 *     （`setBookCover`）；
 *   · 點卡片 ⇒ **book 彈窗**（詳情 ＋ 全部操作 ＋ 手動選封面），見 `components/BookDetailDialog.vue`。
 *
 * 服務端接口（本页调用的 4 个 op；其中 3 个**服务端并行实现中**，未就绪时如实提示、零写入）：
 *   · `listBooks({offset,limit,q,author,year_from,year_to})`  —— 既有
 *   · `updateBook({book_id, patch})`                          —— 新
 *   · `setBookCover({book_id, image_id})`                     —— 新
 *   · 封面批量讀（一次 ≤50 個 id）                            —— 新（詳見 `loadBookCovers`）
 *   （彈窗內沿用既有的 `searchBookImages` / `setImageBook` / `createBook`。）
 *
 * 取值口径：
 *   · 卡片封面：**一次批量**讀封面行（不逐卡發請求）⇒ 對象鍵逐張走**既有取圖鏈**
 *     `sealCards.cardCoverUrl()`（與 `SealCard` 同一個 `thumb_key` → `display_key` 單點）；
 *     取不到 / 缺封面 ⇒ 占位圖（`sealCards.coverPlaceholderUrl()`），**不報錯**；
 *   · 圖片一律 `loading="lazy"`；
 *   · 接口報錯**原樣上屏**（`message || reason` 逐字），不吞成通用提示。
 *
 * 权限（双门之一｜UI 门）：**非管理员 / 未登錄 ⇒ 只渲染无权限提示，零 book 数据请求**
 * （`canManage` 前置判定，`refreshBooks` / 封面批量 / 影像清单 一律不触发）—— 不得先取后藏。
 * 钩子：本页按钮一律 `data-action`（**不得**用 `data-admin-action` —— 该族取值集合冻结为 12）。
 * 上屏文案一律繁體（`s2t(x) === x`）。
 */
import { ADMIN_LABEL } from '../data/roleLabels.js'
import { computed, ref, watch } from 'vue'
import BookCard from '../components/BookCard.vue'
import BookDetailDialog from '../components/BookDetailDialog.vue'
import PersonPicker from '../components/PersonPicker.vue'
import PersonProposalDialog from '../components/PersonProposalDialog.vue'
import { admin, persons, sealCards } from '../services/index.js'
import { isLoggedIn } from '../data/session.js'
import { toTraditionalText } from '../utils/traditional.js'
/* 印譜（book）服务：静态命名空间导入（本页用 `listBooks` / `createBook`；弹窗内用其余 op）。 */
import * as bookService from '../services/books.js'

/* ------------------------------ 服務層 ------------------------------ */
let bookApiPromise = null
function loadBookApi() {
  if (!bookApiPromise) bookApiPromise = Promise.resolve(bookService)
  return bookApiPromise
}

/* ------------------------------ 權限門 ------------------------------ */
/** 管理员门（与 PointsView / 详情页同一服务层判定 `role === 'admin'`）。 */
const canManage = computed(() => admin.isAdminSession())
/** 無權限時的上屏提示：未登錄與「登錄了但不是管理員」分开说（都不發任何請求）。 */
const denialMessage = computed(() => {
  if (!isLoggedIn.value) return `此頁僅${ADMIN_LABEL}可用，請先登錄${ADMIN_LABEL}帳號。`
  return `此頁僅${ADMIN_LABEL}可用：當前帳號沒有「印譜匯觀」權限。`
})

/* ------------------------------ ① 列表 ------------------------------ */
const books = ref([])
const booksState = ref('idle') // idle / loading / ready / failed / unavailable
const booksMessage = ref('')

/* ---------------------- 卡片矩陣（5 欄 × 10 行 ＝ 50 位） ---------------------- */
/** 每行格數（Kevin 定：5）。 */
const GRID_COLUMNS = 5
/** 行數（Kevin 定：10）。 */
const GRID_ROWS = 10
/** 位的總數 ＝ 一頁的印譜上限（50 ＝ `listBooks` 的預設 limit，正好一頁）。 */
const GRID_SLOT_COUNT = GRID_COLUMNS * GRID_ROWS

/**
 * 50 個位：前段放印譜（最多 50 本），**不足則補空位**（`book: null`）。
 * 空格位照樣佔一個 grid cell ⇒ 佈局永遠是 5 × 10，最後一行不會被拉伸。
 * @param {Array<object>} list 印譜行
 * @param {number} [slotCount] 位數（缺省 50）
 * @returns {Array<{key:string, book:object|null}>}
 */
function bookGridSlotsOf(list, slotCount = GRID_SLOT_COUNT) {
  const source = Array.isArray(list) ? list : []
  const total = Number.isInteger(slotCount) && slotCount > 0 ? slotCount : 50
  const slots = []
  const filled = source.slice(0, total)
  for (let index = 0; index < filled.length; index += 1) {
    const book = filled[index] && typeof filled[index] === 'object' ? filled[index] : null
    slots.push({ key: `book-${book && book.id ? book.id : index}`, book })
  }
  for (let index = slots.length; index < total; index += 1) {
    slots.push({ key: `slot-${index}`, book: null })
  }
  return slots
}

/** 上屏的 50 個位（每頁一屏，不虛擬滾動 —— 一頁最多 50 本）。 */
const gridSlots = computed(() => bookGridSlotsOf(books.value, GRID_SLOT_COUNT))

/* ---------------------- 分頁 ＋ 篩選（2026-11-15） ---------------------- */
/* 口徑：篩選與分頁**一律在服務端**（`listBooks` 封閉 6 鍵）；本頁只持「已生效」條件，
   輸入框改動不算數，按【查詢】才生效（避免每次輸入都打雲端）。 */
const pageSize = ref(bookService.BOOK_LIST_PAGE_SIZE || 50)
const pageOffset = ref(0)
const pageTotal = ref(0)
const pageHasMore = ref(false)
const filterForm = ref({ q: '', author: '', yearFrom: '', yearTo: '' })
const appliedFilters = ref({ q: '', author: '', yearFrom: '', yearTo: '' })

/** 當前頁範圍文案（`第 1–50 筆 / 共 1,745 筆`；零命中 ⇒ `共 0 筆`）。 */
const pageRangeText = computed(() => {
  const total = pageTotal.value
  if (total === 0) return '共 0 筆'
  const start = pageOffset.value + 1
  const end = Math.min(pageOffset.value + pageSize.value, total)
  return `第 ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} 筆 / 共 ${total.toLocaleString('en-US')} 筆`
})
const canPrevPage = computed(() => pageOffset.value > 0)
/** 是否有生效中的篩選（決定空清單文案：真沒資料 vs 條件沒命中）。 */
const filterActive = computed(() => {
  const applied = appliedFilters.value || {}
  return [applied.q, applied.author, applied.yearFrom, applied.yearTo]
    .some((value) => String(value === undefined || value === null ? '' : value).trim() !== '')
})
const canNextPage = computed(() => pageHasMore.value)

/** 篩選值收口（去空白；年份留空 ⇒ 不設界）。 */
function filterInputOf(applied) {
  const source = applied || {}
  const input = { offset: pageOffset.value, limit: pageSize.value }
  const q = String(source.q || '').trim()
  const author = String(source.author || '').trim()
  if (q !== '') input.q = q
  if (author !== '') input.author = author
  /* 空年份**不下发**（`Number('') === 0` 会被服务端形态门拒）；非空才判整。 */
  for (const [from, to] of [['yearFrom', 'year_from'], ['yearTo', 'year_to']]) {
    const raw = source[from]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const value = Number(raw)
    if (Number.isInteger(value)) input[to] = value
  }
  return input
}

/** 按當前輸入執行查詢（重置回第一頁）。 */
function applyFilters() {
  appliedFilters.value = { ...filterForm.value }
  pageOffset.value = 0
  void refreshBooks()
}

/** 重置篩選（清空輸入 ＋ 已生效條件）。 */
function resetFilters() {
  filterForm.value = { q: '', author: '', yearFrom: '', yearTo: '' }
  appliedFilters.value = { q: '', author: '', yearFrom: '', yearTo: '' }
  pageOffset.value = 0
  void refreshBooks()
}

/** 上/下一頁（步進＝一整頁；越界由服務端 `has_more` / `offset` 兜住）。 */
function gotoPrevPage() {
  pageOffset.value = Math.max(0, pageOffset.value - pageSize.value)
  void refreshBooks()
}
function gotoNextPage() {
  if (!pageHasMore.value) return
  pageOffset.value += pageSize.value
  void refreshBooks()
}

/**
 * 作者人名：**服务端快照优先**（`book.author_name`，`listBooks` 行上带回），
 * 服务端没带再退本机印人快照（`persons.personNameOfId`），两者皆无 ⇒ 明示「未收錄」。
 *
 * 为什么先吃行上快照：本机印人快照（`xiai:v1:persons`）在新设备/未水合的会话里可能为空，
 * 那时整表都会误显示「未收錄於印人庫」（实测 1,745 行全中招）。行上 `author_name`
 * 由服务端单点落盘 ⇒ 与本机快照是否就绪无关。
 */
/**
 * **創作者鏈**（`book.creators`，服務端權威）⇒ 上屏文本片段。
 *
 * 口徑：
 *   · **主作者已在上一行顯示** ⇒ 鏈裡**排除主作者本人**，避免重複；
 *   · 角色**簡轉繁**（源站 `role` 混用「辑／輯／刻印／刻」；上屏一律繁體），空角色 ⇒ `編者`；
 *   · 人名優先本機印人快照，退行上快照（`c.name`）；皆無 ⇒ 不造名、該條**整條略過**；
 *   · 結果為空 ⇒ 卡片不渲染這一鏈行（**不編造**「佚名」）。
 */
function creatorChainOf(book) {
  const list = book && Array.isArray(book.creators) ? book.creators : []
  const primaryId = book && book.author_person_id ? String(book.author_person_id) : ''
  const parts = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const personId = item.person_id ? String(item.person_id) : ''
    if (personId !== '' && personId === primaryId) continue
    const name = persons.personNameOfId(personId) || String(item.name || '').trim()
    if (!name) continue
    const role = toTraditionalText(String(item.role || '').trim()) || '編者'
    parts.push(`${role} ${name}`)
  }
  return parts.join(' · ')
}

function authorNameOf(book) {
  /* 卡片口徑（Kevin 2026-11-17）：**`author_name` 優先**（服務端行上快照，與本機印人快照
     是否就緒無關）；快照缺 ⇒ 退本機印人快照 ⇒ 皆無明示「未收錄」。 */
  const snapshot = book && book.author_name ? String(book.author_name).trim() : ''
  if (snapshot) return snapshot
  const id = book && book.author_person_id ? String(book.author_person_id) : ''
  if (id) {
    const resolved = persons.personNameOfId(id)
    if (resolved) return resolved
  }
  if (!id) return '（未著錄）'
  return '（未收錄於印人庫）'
}

/**
 * 逐本印譜的關聯影像数：**服务端行上快照**（`book.image_count`）＋ 本次弹窗内的挂载增量
 * （`attachDelta` 里由本页写入产生的变化）。
 */
const attachDelta = ref({}) // bookId -> +1 / -1

function imageCountOf(book) {
  const id = book && book.id ? String(book.id) : ''
  const base = Number.isInteger(book && book.image_count) ? book.image_count : 0
  const delta = attachDelta.value[id] || 0
  return Math.max(0, base + delta)
}

const bookById = computed(() => {
  const map = new Map()
  books.value.forEach((book) => {
    if (book && book.id) map.set(String(book.id), book)
  })
  return map
})

/** 印譜显示标签（`00003｜書名`）；未知编号 ⇒ 明示「清單外」，不假装存在。 */
function bookLabel(bookId) {
  const id = bookId === null || bookId === undefined ? '' : String(bookId)
  if (!id) return '未歸屬'
  const book = bookById.value.get(id)
  return book ? `${id}｜${book.name || '（無書名）'}` : `${id}（清單外）`
}

/* ---------------------- 卡片封面（**一次批量**，不逐卡發請求） ---------------------- */
const coverRows = ref({}) // bookId -> { book_id, cover_image_id, thumb_key }
const coverUrls = ref({}) // bookId -> 對象臨時鏈接
const coversState = ref('idle') // idle / loading / ready / unavailable / failed
const coversMessage = ref('')

/** 取鏈失敗里**屬於「沒有封面」而非「壞了」**的原因（照 `SealCard` 同一分檔；這些不報錯）。 */
const COVER_CONTENT_REASONS = ['MISSING_REQUIRED', 'INVALID_VALUE', 'STORAGE_FILE_NOT_FOUND', 'NOT_IMAGE']
/** 取鏈併發上限（同屏 50 張也不一次打滿 SDK）。 */
const COVER_URL_CONCURRENCY = 6

/**
 * **封面批量讀取（本頁唯一的封面請求點）**：本頁 50 個印譜 id **一次**取回封面行，
 * 之後只做本地映射 —— 卡片不得各自發請求。
 * 接口未上線 ⇒ 記 `unavailable`，卡片顯示占位圖（**不是錯誤**：還沒請求過）。
 * 報錯 ⇒ 原樣上屏，且卡片仍走占位圖（列表不因此不可用）。
 */
async function loadBookCovers() {
  if (!canManage.value) return
  const ids = books.value
    .map((book) => (book && book.id ? String(book.id) : ''))
    .filter((id) => id !== '')
    .slice(0, GRID_SLOT_COUNT)
  if (!ids.length) {
    coverRows.value = {}
    coverUrls.value = {}
    coversState.value = 'ready'
    coversMessage.value = ''
    return
  }
  coversState.value = 'loading'
  coversMessage.value = ''
  const api = await loadBookApi()
  /* **本頁唯一的封面請求點**（一次取回本頁 ≤50 本的封面行；卡片一律不得自行發請求）。 */
  const listCovers = api && typeof api.listBookCovers === 'function' ? api.listBookCovers : null
  if (!listCovers) {
    coverRows.value = {}
    coverUrls.value = {}
    coversState.value = 'unavailable'
    return
  }
  let out = null
  try {
    out = await listCovers({ book_ids: ids })
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  if (!out || out.ok !== true) {
    coverRows.value = {}
    coverUrls.value = {}
    coversState.value = 'failed'
    coversMessage.value = `封面讀取失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}`
    return
  }
  const rows = Array.isArray(out.rows) ? out.rows : []
  const nextRows = {}
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.book_id === undefined || row.book_id === null ? '' : row.book_id)
    if (!id) continue
    nextRows[id] = {
      book_id: id,
      cover_image_id: String(row.cover_image_id === undefined || row.cover_image_id === null ? '' : row.cover_image_id),
      thumb_key: String(row.thumb_key === undefined || row.thumb_key === null ? '' : row.thumb_key)
    }
  }
  coverRows.value = nextRows
  coversState.value = 'ready'
  await resolveCoverUrls()
}

/**
 * 對象鍵 → 臨時鏈接：**逐張走既有取圖鏈**（`sealCards.cardCoverUrl`，抖 `{thumb_key}` 過去的
 * 就是同一條 `thumb_key` → `display_key` 鏈），併發受限。失敗 ⇒ 該卡留空走占位圖。
 */
async function resolveCoverUrls() {
  const tasks = Object.keys(coverRows.value)
    .map((bookId) => ({ bookId, key: String((coverRows.value[bookId] || {}).thumb_key || '').trim() }))
    .filter((item) => item.key !== '')
  if (!tasks.length) {
    coverUrls.value = {}
    return
  }
  const next = {}
  const reports = []
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const item = tasks[cursor]
      cursor += 1
      const cover = await sealCards.cardCoverUrl({ thumb_key: item.key })
      if (cover.ok) {
        next[item.bookId] = cover.url
        continue
      }
      if (COVER_CONTENT_REASONS.indexOf(cover.reason) === -1) {
        reports.push(cover.message || '封面影像暫時無法顯示')
      }
    }
  }
  const size = Math.min(COVER_URL_CONCURRENCY, tasks.length)
  const workers = []
  for (let index = 0; index < size; index += 1) workers.push(worker())
  await Promise.all(workers)
  coverUrls.value = next
  /* 只有「配置 / 傳輸面」的失敗才上屏（缺封面不算錯）。 */
  if (reports.length && Object.keys(next).length === 0) {
    coversMessage.value = `封面影像暫時無法顯示：${reports[0]}`
  }
}

function coverOf(bookId) {
  const id = bookId === undefined || bookId === null ? '' : String(bookId)
  return id && Object.prototype.hasOwnProperty.call(coverRows.value, id) ? coverRows.value[id] : null
}

function coverUrlOf(bookId) {
  const id = bookId === undefined || bookId === null ? '' : String(bookId)
  return id && Object.prototype.hasOwnProperty.call(coverUrls.value, id) ? coverUrls.value[id] : ''
}

/* ------------------------------ ② 新建表單 ------------------------------ */
const currentYear = new Date().getFullYear()
const form = ref({ name: '', author_person_id: '', isbn: '', cip: '', publisher: '', first_publish_year: '' })
const submitting = ref(false)
const formError = ref('')
const createFeedback = ref('')
/** `PersonPicker` 检索态（`filter` 事件只读回传）—— 无命中 ⇒ 露「提交印人提案」入口。 */
const authorFilter = ref({ query: '', count: 0 })
const proposalOpen = ref(false)

const authorCandidates = computed(() => (canManage.value ? persons.referablePersons() : []))
const authorNoMatch = computed(
  () => Boolean(authorFilter.value.query) && Number(authorFilter.value.count || 0) === 0
)

function onAuthorFilter(state) {
  authorFilter.value = {
    query: String((state && state.query) || ''),
    count: Number((state && state.count) || 0)
  }
}

function openProposal() {
  proposalOpen.value = true
}

/** 「新增印譜」入口（清單工具列按鈕）：滾到表單並聚焦書名，不另開彈窗。 */
function focusCreateForm() {
  if (typeof document === 'undefined') return
  const input = document.getElementById('book-name')
  if (!input) return
  if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (typeof input.focus === 'function') input.focus()
}

/** 首次出版年校验（空 ⇒ 合规；否则须为 1000〜當年的整数）。 */
function yearProblemOf(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!text) return ''
  if (!/^\d{1,4}$/.test(text)) return `首次出版年須為整數年份（1000〜${currentYear}）。`
  const year = Number(text)
  if (year < 1000 || year > currentYear) return `首次出版年須介於 1000〜${currentYear}。`
  return ''
}

/** 五字段门（`name` / `author_person_id` 必填；其余可空）—— 先本地挡，服务端另有一道。 */
function formProblemOf() {
  const name = String(form.value.name || '').trim()
  if (!name) return '請先填寫書名。'
  if (!String(form.value.author_person_id || '').trim()) return '請從既有印人中選擇作者（作者必填，不接受自由文本）。'
  return yearProblemOf(form.value.first_publish_year)
}

function resetForm() {
  form.value = { name: '', author_person_id: '', isbn: '', cip: '', publisher: '', first_publish_year: '' }
  authorFilter.value = { query: '', count: 0 }
}

async function submitBook() {
  if (submitting.value) return
  const problem = formProblemOf()
  if (problem) {
    formError.value = problem
    createFeedback.value = ''
    return
  }
  formError.value = ''
  createFeedback.value = ''
  submitting.value = true
  const api = await loadBookApi()
  if (!api || typeof api.createBook !== 'function') {
    submitting.value = false
    formError.value = '印譜服務尚未就緒（`services/books.js` 未提供 `createBook`）；本次未提交。'
    return
  }
  const yearText = String(form.value.first_publish_year || '').trim()
  /* 载荷恰 6 键（裁定件 §三：未知键 ⇒ `INVALID_FIELD`）。 */
  const payload = {
    name: String(form.value.name || '').trim(),
    isbn: String(form.value.isbn || '').trim(),
    cip: String(form.value.cip || '').trim(),
    publisher: String(form.value.publisher || '').trim(),
    author_person_id: String(form.value.author_person_id || '').trim(),
    first_publish_year: yearText ? Number(yearText) : null
  }
  let out = null
  try {
    out = await api.createBook(payload)
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '新增印譜失敗（調用異常）。' }
  }
  submitting.value = false
  if (!out || out.ok !== true) {
    formError.value = `新增失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}（本次未建立印譜）。`
    return
  }
  const bookId = out.book_id === undefined || out.book_id === null ? '' : String(out.book_id)
  if (!/^\d{5}$/.test(bookId)) {
    formError.value = `服務回報的印譜編號格式異常（${bookId || '空'}）；已要求五位數字編號，請通知技術人員核對。`
  }
  createFeedback.value = `已建立印譜 ${bookId}《${payload.name}》。清單已重新讀取。`
  resetForm()
  await refreshBooks()
  const created = bookById.value.get(bookId)
  if (created) openBookDialog(created)
}

/* ------------------------------ ③ 詳情彈窗 ------------------------------ */
/** 開啟中的印譜快照（`null` ⇒ 彈窗不掛載）。 */
const openBook = ref(null)

function openBookDialog(book) {
  if (!book || typeof book !== 'object') return
  if (!canManage.value) return
  openBook.value = { ...book }
}

function closeBookDialog() {
  openBook.value = null
}

/** 詳情保存回包 ⇒ 就地更新（清單卡片與彈窗同步；不重拉整頁）。 */
function onBookSaved(book) {
  if (!book || !book.id) return
  const id = String(book.id)
  books.value = books.value.map((row) => (String(row.id) === id ? { ...row, ...book } : row))
  if (openBook.value && String(openBook.value.id) === id) {
    openBook.value = { ...openBook.value, ...book }
  }
}

/** 封面變更 ⇒ 重取本頁封面批量（仍是同一個請求點；換封面後卡片立刻反映）。 */
function onCoverChanged() {
  void loadBookCovers()
}

/** 掛圖 / 取消歸屬 ⇒ 關聯數即時反映（正負增量，不清零）。 */
function onCountChanged(event) {
  const id = event && event.book_id ? String(event.book_id) : ''
  const delta = Number(event && event.delta)
  if (!id || !Number.isFinite(delta) || delta === 0) return
  const next = { ...attachDelta.value }
  next[id] = (next[id] || 0) + delta
  attachDelta.value = next
}

/* ------------------------------ 讀數 ------------------------------ */
async function refreshBooks() {
  /* 管理员门前置：非管理员 / 未登錄 ⇒ **零請求**（不得先取后藏）。 */
  if (!canManage.value) return
  booksState.value = 'loading'
  booksMessage.value = ''
  const api = await loadBookApi()
  if (!api || typeof api.listBooks !== 'function') {
    booksState.value = 'unavailable'
    booksMessage.value = '印譜服務尚未就緒（`services/books.js` 未提供 `listBooks`）；清單暫不可用。'
    return
  }
  let out = null
  try {
    out = await api.listBooks(filterInputOf(appliedFilters.value))
  } catch (err) {
    out = { ok: false, message: (err && err.message) || '調用異常' }
  }
  if (!out || out.ok !== true) {
    booksState.value = 'failed'
    booksMessage.value = `印譜清單讀取失敗：${(out && (out.message || out.reason)) || '服務未回報原因'}`
    return
  }
  books.value = Array.isArray(out.books) ? out.books : []
  pageTotal.value = Number.isInteger(out.total) ? out.total : books.value.length
  pageHasMore.value = out.hasMore === true
  if (Number.isInteger(out.offset)) pageOffset.value = out.offset
  if (Number.isInteger(out.limit) && out.limit > 0) pageSize.value = out.limit
  /* 換頁 / 換篩選 ⇒ 舊增量清零（本頁內增量只對同一批行有意義）。 */
  attachDelta.value = {}
  booksState.value = 'ready'
  await loadBookCovers()
}

/* 会话水合后才变成管理员的情形：`watch` 在 `canManage` 翻真时**才**发第一次请求。 */
watch(
  canManage,
  (isManager) => {
    if (isManager) {
      refreshBooks()
    } else {
      books.value = []
      booksState.value = 'idle'
      coverRows.value = {}
      coverUrls.value = {}
      coversState.value = 'idle'
      attachDelta.value = {}
      openBook.value = null
    }
  },
  { immediate: true }
)
</script>

<template>
  <section>
    <div class="page-head books__head">
      <div>
        <h1>印譜匯觀</h1>
        <p>
          印譜（book）資料與影像歸屬關係目前僅{{ ADMIN_LABEL }}可見：一本印譜含書名、作者（印人庫引用）、
          ISBN、CIP 與首次出版年；一張影像至多歸一本印譜。點卡片開啟詳情，即場改資料、掛圖、選封面。
        </p>
      </div>
      <span class="books__gate" data-books-gate="admin">僅{{ ADMIN_LABEL }}</span>
    </div>

    <!-- 權限門：非管理員 / 未登錄 ⇒ 只此一段提示，**零 book 請求**（見 `refreshBooks` 前置判）。 -->
    <p v-if="!canManage" class="notice books__notice" data-books-denied>
      {{ denialMessage }}
    </p>

    <template v-else>
      <p v-if="createFeedback" class="notice books__notice" data-books-feedback="create">
        {{ createFeedback }}
      </p>
      <p v-if="booksMessage" class="notice books__notice" data-books-feedback="list">
        {{ booksMessage }}
      </p>

      <!-- ① 印譜卡片矩陣（5 欄 × 10 行 ＝ 50 位） -->
      <section class="panel" data-books-list>
        <div class="panel__head">
          <h2>印譜清單</h2>
          <span class="detail__hint">
            {{ booksState === 'loading' ? '正在讀取…' : pageRangeText }}
          </span>
        </div>
        <div class="panel__body">
          <!-- 篩選（服務端過濾；輸入改動不即時生效，按【查詢】才落請求） -->
          <form class="books-filter" data-books-filter @submit.prevent="applyFilters">
            <label class="books-filter__field">
              <span>書名／關鍵詞</span>
              <input v-model="filterForm.q" type="search" maxlength="60" placeholder="書名、作者、出版社、ISBN、CIP" />
            </label>
            <label class="books-filter__field">
              <span>作者</span>
              <input v-model="filterForm.author" type="search" maxlength="60" placeholder="作者或創作者人名" />
            </label>
            <label class="books-filter__field books-filter__field--year">
              <span>出版年起</span>
              <input v-model="filterForm.yearFrom" type="number" min="1000" max="2100" inputmode="numeric" placeholder="如 1900" />
            </label>
            <label class="books-filter__field books-filter__field--year">
              <span>出版年止</span>
              <input v-model="filterForm.yearTo" type="number" min="1000" max="2100" inputmode="numeric" placeholder="如 1949" />
            </label>
            <div class="books-filter__actions">
              <button class="btn btn--primary" type="submit" data-action="filter-books">查詢</button>
              <button class="btn btn--ghost" type="button" data-action="reset-books-filter" @click="resetFilters">重置</button>
              <button class="btn btn--ghost" type="button" data-action="book-create-open" @click="focusCreateForm">
                新增印譜
              </button>
            </div>
          </form>

          <!-- 封面批量讀取的錯誤才上屏（缺封面走占位圖，不報錯） -->
          <p v-if="coversMessage" class="notice books__notice" data-books-feedback="covers">
            {{ coversMessage }}
          </p>

          <!-- 卡片矩陣：固定 5 欄；50 個位不足則補空位（不拉伸） -->
          <div v-if="books.length" class="books-grid-scroll">
            <div class="books-grid" data-books-grid>
              <template v-for="slot in gridSlots" :key="slot.key">
                <BookCard
                  v-if="slot.book"
                  :book="slot.book"
                  :cover-url="coverUrlOf(slot.book.id)"
                  :author-name="authorNameOf(slot.book)"
                  :creator-chain="creatorChainOf(slot.book)"
                  :image-count="imageCountOf(slot.book)"
                  @open="openBookDialog"
                />
                <div v-else class="books-grid__slot" aria-hidden="true" data-books-grid-empty-slot></div>
              </template>
            </div>
          </div>
          <p v-else-if="booksState === 'ready'" class="books__empty" data-books-empty="list">
            {{ pageTotal === 0 && !filterActive ? '尚無印譜資料：先在下方「新增印譜」建立第一本，建好後會是卡片矩陣的第一格。' : '目前篩選條件沒有符合的印譜；可調整條件或按【重置】。' }}
          </p>
          <p v-else class="books__empty">印譜清單尚未就緒。</p>

          <!-- 分頁（服務端 offset/limit；上一頁/下一頁以整頁步進） -->
          <div v-if="booksState === 'ready' && pageTotal > 0" class="books-pager" data-books-pager>
            <button
              class="btn btn--ghost"
              type="button"
              data-action="books-prev-page"
              :disabled="!canPrevPage"
              @click="gotoPrevPage"
            >上一頁</button>
            <span class="books-pager__range">{{ pageRangeText }}</span>
            <button
              class="btn btn--ghost"
              type="button"
              data-action="books-next-page"
              :disabled="!canNextPage"
              @click="gotoNextPage"
            >下一頁</button>
          </div>
        </div>
      </section>

      <!-- ② 新增印譜（入口保留在清單工具列，表單在本區） -->
      <section class="panel" data-book-create>
        <div class="panel__head">
          <h2>新增印譜</h2>
          <span class="detail__hint">書名與作者必填；印譜編號由系統發號（五位數字），不可自填。</span>
        </div>
        <div class="panel__body">
          <div class="field">
            <label for="book-name">書名（必填）</label>
            <input id="book-name" v-model="form.name" type="text" maxlength="120" placeholder="請輸入書名（簡繁均可，原樣上屏）" />
          </div>
          <div class="field">
            <label for="book-author">作者（必填）</label>
            <PersonPicker
              id="book-author"
              v-model="form.author_person_id"
              :persons="authorCandidates"
              :person-name="persons.personName"
              label="作者"
              data-author-picker="book-form"
              @filter="onAuthorFilter"
            />
            <span class="field__hint">
              作者必須是印人庫已收錄的人（候選共 {{ authorCandidates.length }} 位）；只可點選，不接受自由文本。
            </span>
            <template v-if="authorNoMatch">
              <span class="field__hint" data-author-nomatch="book-form">
                庫中沒有匹配「{{ authorFilter.query }}」的印人 ⇒ 不能手輸自由文本。
              </span>
              <button
                class="btn btn--ghost"
                type="button"
                data-action="person-proposal-open"
                data-person-proposal-entry="book-form"
                @click="openProposal"
              >
                提交印人提案
              </button>
            </template>
          </div>
          <div class="field">
            <label for="book-publisher">出版社（可空）</label>
            <input id="book-publisher" v-model="form.publisher" type="text" maxlength="200" placeholder="可空；如 上海書畫出版社" />
            <label for="book-isbn">ISBN（可空）</label>
            <input id="book-isbn" v-model="form.isbn" type="text" maxlength="40" placeholder="可空；非空時原樣保留（連字符不剝）" />
          </div>
          <div class="field">
            <label for="book-cip">CIP（可空）</label>
            <input id="book-cip" v-model="form.cip" type="text" maxlength="60" placeholder="可空；非空時原樣保留" />
          </div>
          <div class="field">
            <label for="book-year">首次出版年（可空）</label>
            <input
              id="book-year"
              v-model="form.first_publish_year"
              type="number"
              min="1000"
              :max="currentYear"
              step="1"
              :placeholder="`可空；如 1935（範圍 1000〜${currentYear}）`"
            />
          </div>
          <span v-if="formError" class="books__error" data-books-error="create">{{ formError }}</span>
          <div class="books__form-foot">
            <button
              class="btn btn--primary"
              type="button"
              data-action="book-create-submit"
              :disabled="submitting"
              @click="submitBook"
            >
              {{ submitting ? '正在提交…' : '新增印譜' }}
            </button>
          </div>
        </div>
      </section>

      <!-- ③ 詳情彈窗（詳情 ＋ 掛圖 ＋ 選封面，全部操作都在裡面） -->
      <BookDetailDialog
        v-if="openBook"
        :book="openBook"
        :cover="coverOf(openBook.id)"
        :cover-url="coverUrlOf(openBook.id)"
        :label-of-book="bookLabel"
        @close="closeBookDialog"
        @saved="onBookSaved"
        @cover-changed="onCoverChanged"
        @count-changed="onCountChanged"
      />

      <PersonProposalDialog v-if="proposalOpen" @close="proposalOpen = false" />
    </template>
  </section>
</template>

<style scoped>
.books__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

.books__gate {
  flex: 0 0 auto;
  padding: var(--s-1) var(--s-2);
  border: 1px dashed var(--c-line);
  border-radius: var(--r-sm);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.books__notice {
  margin-bottom: var(--s-4);
}

.books__error {
  display: block;
  margin-top: var(--s-1);
  color: var(--c-danger);
  font-size: var(--t-xs);
}

.books__empty {
  padding: var(--s-4);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.books__form-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}

/* ============================================================================
   **卡片矩陣**：每行 5 個、共 10 行（50 位）。
   · 欄固定五等分（見下一條 `grid-template-columns`）—— **不得**改成自動填充類寫法：
     那會把不足 50 的最後一行「撐寬拉伸」，與定案相反；
   · 位子由 `bookGridSlotsOf` 補足到 50 個（空格位是真空 div，佔格但不可見）；
   · 窄屏不放棄 5 欄（定案如此）⇒ 容器橫向可滾，格寬有下限。
   ============================================================================ */
.books-grid-scroll {
  overflow-x: auto;
  padding-bottom: var(--s-1);
}

.books-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  grid-auto-rows: auto;
  gap: var(--s-3);
  min-width: 880px;
}

/* 空格位：佔一個格但不畫任何東西（不拉伸、不留假卡片）。 */
.books-grid__slot {
  min-height: 1px;
}

/* 篩選列（服務端過濾；窄屏自動換行） */
.books-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.books-filter__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
  font-size: 0.9em;
}

.books-filter__field--year {
  min-width: 110px;
}

.books-filter__field input {
  padding: 6px 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}

.books-filter__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}

/* 分頁條 */
.books-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  margin-top: var(--s-4);
}

.books-pager__range {
  color: var(--c-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
