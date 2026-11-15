
<script setup>
/**
 * 【印譜匯觀】管理页（`/books`）—— 印譜（book）清單 ＋ 新建 ＋ 批量掛圖。
 *
 * 口径真源：`docs/book-catalog-ruling-2026-11-14.md`（§一 数据模型 / §二 菜单与路由 /
 * §三 写入面 / §四 前端 / §五 验收）。
 *
 * 三块落点（本页只做这三块；详情页的「所屬印譜」下拉在 `SealDetailView.vue`）：
 *   ① 列表：印譜編號 / 書名 / 作者人名 / 首次出版年 / ISBN / CIP / 關聯影像數；
 *   ② 新建表单：書名（必填）／作者 `PersonPicker`（必填，候选源 `persons.referablePersons()`，
 *      無命中 ⇒ 引導提交印人提案，**不放行自由文本**）／ISBN／CIP／首次出版年（可空，1000〜當年）；
 *   ③ 批量掛圖：选一本书 → 勾选影像 → **逐张** `setImageBook`；已归属其它书的影像**明示当前归属**，
 *      改挂前须管理员二次确认（一次性提交守卫在 `runAttach` 的 `attaching` 判，不靠按钮 disabled）。
 *
 * 权限（双门之一｜UI 门）：**非管理员 / 未登錄 ⇒ 只渲染无权限提示，零 book 数据请求**
 * （`canManage` 前置判定，`refreshBooks` / 影像清单 / `loadBookApi` 一律不触发）—— 不得先取后藏。
 * 服务端另有管理员门（另一门，本页不替代）。
 *
 * 服務層：`../services/books.js`（`createBook` / `listBooks` / `setImageBook`）由**另一单**提供，
 * 本单写集不含该文件 ⇒ 这里用 `import.meta.glob` **晚绑定**：文件落地前构建照样通过，
 * 调用时缺模块 ⇒ 给「印譜服務尚未就緒」的可见反馈（**不伪造成功**）；落地后自动接上，
 * 签名按裁定件 §三（payload 恰 5 键 / `book_id: null` ＝ 取消归属）。
 *
 * 隐私（普通用户零泄漏）：本页仅管理员可达；`book_id` **不出现在任何普通用户可见文本**
 * （本页所有上屏内容都只在管理员态渲染）。
 * 钩子：本页新按钮一律用 `data-action`（**不得**用 `data-admin-action` —— 该族取值集合冻结为 12）。
 * 上屏文案一律繁體（`s2t(x) === x`）。
 */
import { computed, ref, watch } from 'vue'
import ConfirmActionDialog from '../components/ConfirmActionDialog.vue'
import PersonPicker from '../components/PersonPicker.vue'
import PersonProposalDialog from '../components/PersonProposalDialog.vue'
import { admin, corrections, persons, seals } from '../services/index.js'
import { isLoggedIn } from '../data/session.js'
import { toTraditionalText } from '../utils/traditional.js'
/* 印譜（book）服务：静态命名空间导入（本页用 `createBook` / `listBooks` / `setImageBook`）。 */
import * as bookService from '../services/books.js'

/* ------------------------------ 服務層晚綁定 ------------------------------ */
/* **静态接线（本批修）**：`services/books.js` 已落地，导入在文件头 import 区块 ——
   不再用 `import.meta.glob` 晚绑定（过渡手段留着会掩盖真实接线错误）。 */
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
  if (!isLoggedIn.value) return '此頁僅管理員可用，請先登錄管理員帳號。'
  return '此頁僅管理員可用：當前帳號沒有「印譜匯觀」權限。'
})

/* ------------------------------ ① 列表 ------------------------------ */
const books = ref([])
const booksState = ref('idle') // idle / loading / ready / failed / unavailable
const booksMessage = ref('')
const version = ref(0)

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
 *   · 結果為空 ⇒ 模板不渲染這一鏈行（**不編造**「佚名」）。
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
  const id = book && book.author_person_id ? String(book.author_person_id) : ''
  const snapshot = book && book.author_name ? String(book.author_name).trim() : ''
  if (id) {
    const resolved = persons.personNameOfId(id)
    if (resolved) return resolved
  }
  if (snapshot) return snapshot
  if (!id) return '（未著錄）'
  return '（未收錄於印人庫）'
}

/* 影像行（只在管理员态读）：关联影像数从影像行 `book_id` 统计，不另造统计接口。 */
const sealRows = computed(() => {
  void version.value
  if (!canManage.value) return []
  return seals.listSeals()
})

/** 影像行是否已带 `book_id` 字段（数据层未落地 ⇒ 关联数无法统计 ⇒ 见表格下方提示）。 */
const bookFieldPresent = computed(() =>
  sealRows.value.some((seal) =>
    (Array.isArray(seal.images) ? seal.images : []).some(
      (image) => image && Object.prototype.hasOwnProperty.call(image, 'book_id')
    )
  )
)

/** 本页写入成功后的本地归属覆盖（影像编号 → 印譜编号；'' ⇒ 未归属），用于即时反映而不假成功。 */
const bookOverrides = ref({})

function bookIdOfImageRow(image) {
  const id = image && image.id ? String(image.id) : ''
  if (id && Object.prototype.hasOwnProperty.call(bookOverrides.value, id)) return bookOverrides.value[id]
  if (!image || !Object.prototype.hasOwnProperty.call(image, 'book_id')) return ''
  return image.book_id === null || image.book_id === undefined ? '' : String(image.book_id)
}

/** 逐本印譜的關聯影像数（含 side face 影像 —— 计数按影像行原值，不做分类裁剪）。 */
const imageCountByBook = computed(() => {
  const counts = new Map()
  sealRows.value.forEach((seal) => {
    ;(Array.isArray(seal.images) ? seal.images : []).forEach((image) => {
      const bookId = bookIdOfImageRow(image)
      if (!bookId) return
      counts.set(bookId, (counts.get(bookId) || 0) + 1)
    })
  })
  return counts
})

function imageCountOf(book) {
  const id = book && book.id ? String(book.id) : ''
  return id ? imageCountByBook.value.get(id) || 0 : 0
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
  /* 载荷恰 5 键（裁定件 §三：未知键 ⇒ `INVALID_FIELD`）。 */
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
  if (/^\d{5}$/.test(bookId)) selectedBookId.value = bookId
}

/* ------------------------------ ③ 批量掛圖 ------------------------------ */
const selectedBookId = ref('')
const imageFilter = ref('')
const selectedImages = ref([]) // [{ imageId, stampId, bookId }]
const attaching = ref(false)
const attachFeedback = ref('')
/** 待确认的批量提交（`{ ids, conflicts }`；`ids` ＝ 当时全部勾选项，`conflicts` 仅用于明示当前归属）。 */
const pendingAttach = ref(null)

/** 可挂影像清单：印面影像 ＋ 整枚印章圖（裁定件 §1.2 覆盖的两类影像行）。 */
const allImages = computed(() => {
  const out = []
  sealRows.value.forEach((seal) => {
    const images = Array.isArray(seal.images) ? seal.images : []
    const faceIds = new Set()
    const wholeIds = new Set()
    ;(Array.isArray(seal.faces) ? seal.faces : []).forEach((face) => {
      if (face && face.face_image_id) faceIds.add(String(face.face_image_id))
    })
    ;(Array.isArray(seal.wholeSealImages) ? seal.wholeSealImages : []).forEach((image) => {
      if (image && image.id) wholeIds.add(String(image.id))
    })
    const sealName = corrections.resolveSealDisplayName(seal) || '（未命名印章）'
    const stampId = seal && seal.stamp_id ? String(seal.stamp_id) : ''
    images.forEach((image) => {
      const imageId = image && image.id ? String(image.id) : ''
      if (!imageId) return
      const kind = faceIds.has(imageId) ? '印面影像' : wholeIds.has(imageId) ? '整枚印章圖' : ''
      if (!kind) return
      out.push({ imageId, stampId, sealName, kind, bookId: bookIdOfImageRow(image) })
    })
  })
  return out
})

const IMAGE_RENDER_LIMIT = 200

/** 命中条数（不受渲染上限影响；用于「清單過長」提示）。 */
const filteredImageCount = computed(() => {
  const keyword = String(imageFilter.value || '').trim().toLowerCase()
  if (!keyword) return allImages.value.length
  return allImages.value.filter((row) =>
    [row.imageId, row.stampId, row.sealName, row.kind].join(' ').toLowerCase().includes(keyword)
  ).length
})

const visibleImages = computed(() => {
  const keyword = String(imageFilter.value || '').trim().toLowerCase()
  const rows = keyword
    ? allImages.value.filter((row) =>
        [row.imageId, row.stampId, row.sealName, row.kind].join(' ').toLowerCase().includes(keyword)
      )
    : allImages.value
  return rows.slice(0, IMAGE_RENDER_LIMIT)
})

const imagesTruncated = computed(() => visibleImages.value.length < filteredImageCount.value)

const selectedImageIds = computed(() => new Set(selectedImages.value.map((row) => row.imageId)))

function isSelected(imageId) {
  return selectedImageIds.value.has(imageId)
}

/** 勾选 / 取消（保留勾选时的归属快照 ⇒ 改挂确认据此明示「当前归属」）。 */
function toggleImage(row) {
  if (attaching.value) return
  if (isSelected(row.imageId)) {
    selectedImages.value = selectedImages.value.filter((item) => item.imageId !== row.imageId)
    return
  }
  selectedImages.value = [...selectedImages.value, { imageId: row.imageId, stampId: row.stampId, bookId: row.bookId }]
}

function clearSelection() {
  if (attaching.value) return
  selectedImages.value = []
}

async function attachSelected() {
  if (attaching.value) return
  attachFeedback.value = ''
  const targetId = String(selectedBookId.value || '')
  if (!targetId) {
    attachFeedback.value = '請先在上方選定要掛上的印譜。'
    return
  }
  if (!selectedImages.value.length) {
    attachFeedback.value = '請先勾選至少一張影像。'
    return
  }
  /* 已归属其它书的影像 ⇒ 先明示当前归属、要求管理员确认（改挂需确认）。 */
  const conflicts = selectedImages.value
    .filter((item) => item.bookId && item.bookId !== targetId)
    .map((item) => ({ imageId: item.imageId, currentBookId: item.bookId }))
  if (conflicts.length) {
    /* 确认后提交的是**当时全部勾选项**（未归属项一并挂上，不只改挂那几张）。 */
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
 * 逐张提交 `setImageBook`（**串行**，一张一判；回包须与请求一致才算成功 —— 不以
 * `updated >= 1` 判成功）。失败项保留勾选并给原因。
 */
async function runAttach(imageIds) {
  if (attaching.value) return
  const targetId = String(selectedBookId.value || '')
  if (!targetId || !imageIds.length) return
  attaching.value = true
  attachFeedback.value = ''
  const api = await loadBookApi()
  if (!api || typeof api.setImageBook !== 'function') {
    attaching.value = false
    attachFeedback.value = '印譜服務尚未就緒（`services/books.js` 未提供 `setImageBook`）；本次零寫入。'
    return
  }
  const failures = []
  const succeeded = []
  for (const imageId of imageIds) {
    let out = null
    try {
      out = await api.setImageBook({ image_id: imageId, book_id: targetId })
    } catch (err) {
      out = { ok: false, message: (err && err.message) || '調用異常' }
    }
    const echoedImage = out && out.image_id !== undefined && out.image_id !== null ? String(out.image_id) : ''
    const echoedBook = out && out.book_id !== undefined && out.book_id !== null ? String(out.book_id) : ''
    if (out && out.ok === true && (!echoedImage || echoedImage === imageId) && echoedBook === targetId) {
      bookOverrides.value = { ...bookOverrides.value, [imageId]: targetId }
      succeeded.push(imageId)
    } else {
      failures.push(`${imageId}：${(out && (out.message || out.reason)) || '回包與請求不一致'}`)
    }
  }
  attaching.value = false
  const failedIds = new Set(failures.map((line) => line.split('：')[0]))
  selectedImages.value = selectedImages.value.filter((item) => failedIds.has(item.imageId))
  const okText = `已掛上 ${succeeded.length} 張影像到 ${bookLabel(targetId)}。`
  attachFeedback.value = failures.length
    ? `${okText} ${failures.length} 張失敗 —— ${failures.join('；')}（失敗項保留勾選，可重試）。`
    : okText
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
  booksState.value = 'ready'
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
      selectedImages.value = []
      selectedBookId.value = ''
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
          印譜（book）資料與影像歸屬關係目前僅管理員可見：一本印譜含書名、作者（印人庫引用）、
          ISBN、CIP 與首次出版年；一張影像至多歸一本印譜，可在此批量掛圖或取消歸屬。
        </p>
      </div>
      <span class="books__gate" data-books-gate="admin">僅管理員</span>
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

      <!-- ① 印譜清單 -->
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
            </div>
          </form>
          <table v-if="books.length" class="books-table">
            <thead>
              <tr>
                <th>印譜編號</th>
                <th>書名</th>
                <th>作者</th>
                <th>首次出版年</th>
                <th>出版社</th>
                <th>ISBN</th>
                <th>CIP</th>
                <th v-if="bookFieldPresent">關聯影像數</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="book in books" :key="book.id" :data-book-row="book.id">
                <td class="books-table__id">{{ book.id }}</td>
                <td>{{ book.name }}</td>
                <td class="books-table__author">
                  <span class="books-table__author-name">{{ authorNameOf(book) }}</span>
                  <span v-if="creatorChainOf(book)" class="books-table__creator-chain" data-creator-chain>
                    {{ creatorChainOf(book) }}
                  </span>
                </td>
                <td>{{ book.first_publish_year || '未著錄' }}</td>
                <td>{{ book.publisher || '未著錄' }}</td>
                <td>{{ book.isbn || '未著錄' }}</td>
                <td>{{ book.cip || '未著錄' }}</td>
                <td v-if="bookFieldPresent">{{ imageCountOf(book) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else-if="booksState === 'ready'" class="books__empty" data-books-empty="list">
            {{ pageTotal === 0 && !filterActive ? '尚無印譜資料，先在下方的「新增印譜」建立第一本。' : '目前篩選條件沒有符合的印譜；可調整條件或按【重置】。' }}
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
          <p v-if="books.length && !bookFieldPresent" class="books__hint" data-books-hint="no-book-field">
            影像行尚未回傳 `book_id` 欄位（數據層未落地）⇒ 關聯影像數暫不能統計，本列暫不顯示。
          </p>
        </div>
      </section>

      <!-- ② 新增印譜 -->
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

      <!-- ③ 批量掛圖 -->
      <section class="panel" data-book-batch>
        <div class="panel__head">
          <h2>批量掛圖</h2>
          <span class="detail__hint">
              選定一本印譜 → 勾選影像 → 逐張提交；已歸屬其它印譜的影像改掛前須確認。
              目標印譜下拉只列**當前頁**（每頁 {{ pageSize }} 本）—— 先用上方篩選縮小範圍，再在此選定。
            </span>
        </div>
        <div class="panel__body">
          <div class="field">
            <label for="book-batch-target">目標印譜</label>
            <select id="book-batch-target" v-model="selectedBookId" data-action="book-batch-target">
              <option value="">請選擇印譜</option>
              <option v-for="book in books" :key="book.id" :value="String(book.id)">
                {{ book.id }}｜{{ book.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="book-batch-filter">篩選影像</label>
            <input
              id="book-batch-filter"
              v-model="imageFilter"
              type="text"
              placeholder="按影像編號 / 印章編號 / 印文 / 類型篩選"
            />
            <span class="field__hint">
              命中 {{ filteredImageCount }} 張影像；目前顯示前 {{ visibleImages.length }} 張，已勾選 {{ selectedImages.length }} 張。
            </span>
          </div>

          <ul v-if="visibleImages.length" class="books-images">
            <li v-for="row in visibleImages" :key="row.imageId" class="books-image" :data-image-id="row.imageId">
              <label class="books-image__check">
                <input
                  type="checkbox"
                  :checked="isSelected(row.imageId)"
                  :disabled="attaching"
                  :data-image-id="row.imageId"
                  data-action="book-batch-pick"
                  @change="toggleImage(row)"
                />
                <span class="books-image__id">{{ row.imageId }}</span>
              </label>
              <span class="books-image__meta">{{ row.sealName }}（{{ row.stampId || '無編號' }}）· {{ row.kind }}</span>
              <span class="books-image__owner" :data-image-owner="row.bookId">{{ bookLabel(row.bookId) }}</span>
            </li>
          </ul>
          <p v-else class="books__empty">沒有符合條件的影像。</p>
          <p v-if="imagesTruncated" class="books__hint" data-books-hint="image-limit">
            清單過長，僅顯示前 {{ IMAGE_RENDER_LIMIT }} 張 ⇒ 請用上方「篩選影像」收窄。
          </p>

          <p v-if="attachFeedback" class="notice books__notice" data-books-feedback="attach">
            {{ attachFeedback }}
          </p>
          <div class="books__form-foot">
            <button class="btn btn--ghost" type="button" data-action="book-batch-clear" :disabled="attaching" @click="clearSelection">
              清空勾選
            </button>
            <button
              class="btn btn--primary"
              type="button"
              data-action="book-batch-attach"
              :disabled="attaching"
              @click="attachSelected"
            >
              {{ attaching ? '正在逐張提交…' : `掛上所選影像（${selectedImages.length}）` }}
            </button>
          </div>
        </div>
      </section>

      <!-- 改掛確認（已歸屬其它印譜的影像）：明示當前歸屬，確認後逐張提交。 -->
      <ConfirmActionDialog
        v-if="pendingAttach"
        title="確認改掛印譜"
        :message="`所選影像中有 ${pendingAttach.conflicts.length} 張已歸屬其它印譜；一張影像只歸一本，改掛後即從原印譜移出。`"
        :detail="pendingAttach.conflicts.map((item) => `${item.imageId}：現屬 ${bookLabel(item.currentBookId)}`).join('；')"
        hint="確認後逐張提交；失敗的影像會保留在勾選中並給出原因。"
        confirm-text="確認改掛"
        cancel-text="取消"
        confirm-action="book-batch-confirm"
        cancel-action="book-batch-cancel"
        :busy="attaching"
        @confirm="confirmReassign"
        @cancel="cancelReassign"
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

.books__hint {
  display: block;
  margin-top: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
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

.books-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}

.books-table th,
.books-table td {
  padding: var(--s-2);
  border-bottom: 1px solid var(--c-line);
  text-align: left;
  vertical-align: top;
}

.books-table th {
  color: var(--c-text-muted);
  font-weight: normal;
  font-size: var(--t-xs);
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
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
}

.books-filter__actions {
  display: flex;
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
  color: var(--muted-foreground, #666);
  font-variant-numeric: tabular-nums;
}

.books-table__id {
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.06em;
}

/* 作者列：主作者一行 ＋ 创作者链一行（弱化一級；链行存在性由 `v-if` 控制）。 */
.books-table__author-name {
  display: block;
}

.books-table__creator-chain {
  display: block;
  margin-top: 2px;
  color: var(--muted-foreground, #666);
  font-size: 0.86em;
  line-height: 1.35;
}

.books-images {
  margin: var(--s-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  max-height: 420px;
  overflow-y: auto;
}

.books-image {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--c-line);
}

.books-image__check {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-width: 200px;
  cursor: pointer;
}

.books-image__id {
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
}

.books-image__meta {
  flex: 1 1 auto;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.books-image__owner {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}
</style>
