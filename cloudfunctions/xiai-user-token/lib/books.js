'use strict'
/**
 * 玺爱 · **印譜（book）数据面 —— 管理员三 op 的唯一实现点**
 * ============================================================================
 * 口径真源：`docs/book-catalog-ruling-2026-11-14.md`（Kevin 2026-11-14 裁定，commit `06128fc`）。
 * 场景：`/books`（印譜匯觀）页由管理员建书 —— book 行落 `xiai_books`；并把「face 的图片」与
 * 「不指定 face 的整章图片」（二者**同为 `xiai_images` 行**）挂到某本书上（**单值** `book_id`）。
 *
 * 硬口径（逐条，与裁定件逐字对齐）：
 *  ① **管理员面**：三个 op 的**第一行**即 `adminWhitelistDenial`（缺 env / 非白名单 ⇒ 结构化拒 ＋
 *     **零读零写**）。三 op 一律落 `ADMIN_OPS`，**不落 `OPS`**、**不落 `PUBLIC_OPS` /
 *     `PUBLIC_WRITE_OPS`**（公开读面仍恰 4、公开写面仍恰 1，一个不增）。
 *  ② **载荷封闭键面**（未知键 / 身份类键 ⇒ `INVALID_FIELD`，判定**早于任何读**）：
 *     · `createBook`   恰 **5 键** `name / isbn / cip / author_person_id / first_publish_year`；
 *     · `listBooks`    恰 **0 键**（空载荷 `{}`）；
 *     · `setImageBook` 恰 **2 键** `image_id / book_id` —— `book_id` **必须显式出现**：
 *       `null` ＝ 取消归属（合法）；**缺键 ≠ 取消** ⇒ `MISSING_REQUIRED`（防「漏传即清空」）。
 *  ③ **值域门**（全部纯判定、早于任何写）：
 *     · `name` 必填、字符串、trim 后非空、≤ `BOOK_NAME_MAX_LENGTH`（200）；**简繁均可、不跑
 *       `s2t`**、原样落库（上屏原样输出）；
 *     · `author_person_id` 必填、字符串、trim 非空；**必须是已收录印人**（`readPersonRow` 同门，
 *       与勘误作者同门）；查不到 / 是 `tmp-` 临时行 ⇒ `INVALID_VALUE`，文案点名「先提交印人提案
 *       并经采纳」，**绝不放行自由文本**；
 *     · `isbn` / `cip` 可空：缺键 / 空串 / `null` ⇒ 落 `''`（＝未著录）；非空**保留原样**
 *       （**连字符不剥**）、长度 ≤ `BOOK_CODE_MAX_LENGTH`（64）；
 *     · `first_publish_year` 可空：非空时必须是 `BOOK_FIRST_YEAR_MIN`（1000）〜**当年**的**整数**
 *       （当年取 `context.nowSeconds`，缺省取服务端时钟）；越界 / 非整数 ⇒ `INVALID_VALUE`。
 *  ④ **`book_id` 服务端发号、不可改**：**五位纯数字**（`'00001'`）。实现**复用既有发号单点**
 *     `issueCodeNumberAvoiding('book', isTaken)` —— 本单在既有发号器上**加一个 `'book'` 号别**
 *     （同一份 CAS 认领 `xiai_counters`），**不写第二套发号实现**；号域 `no ∈ [1, 99999]`
 *     （号码即五位定长十进制，`capacity` 由 `COUNTER_CAPACITY.book` 封顶）；`isTaken` 按
 *     **`xiai_books.id`** 查重（`occupiedNosOf('book')`，单次 1000 行护栏）。
 *     **禁随机 id / 时间戳 / 客户端发号**。
 *  ⑤ **幂等**：同 `name`（trim 后逐字相等）＋ 同 `author_person_id` 已存在 ⇒ **返回既有 `book_id`、
 *     不建第二行、不发号、不写任何行**；该轮回包多一个 additive 键 `skipped: true`（**存在性驱动**
 *     ⇒ 正常建行轮**不出现**该键 ⇒ 回包恰 2 键 `{ok, book_id}`）。
 *  ⑥ **一对多、单值**：`setImageBook` 只写影像行上的 `book_id`（字符串或 `null`），**不是数组**。
 *     `book_id = null` ＝ 取消归属（合法）；改挂另一本 ＝ 直接覆盖为最新（**不需要先清空**）。
 *     **不做级联删除**：本批**零 book 删除能力**（避免悬空引用）；影像被删不影响 book。
 *  ⑦ **读回比对**（**不得以 `updated >= 1` 判成功**）：写完按**同一检索式重读该影像行**，
 *     `text(row.book_id) || null` 必须**逐字等于**目标值；读不到 / 不相等 ⇒ 结构化失败
 *     （`STORAGE_UNAVAILABLE`，文案如实报「写已送出但读回不一致」，**绝不报假成功**）。
 *  ⑧ **回包键面**（`index.js` 按 op 收窄透传的键面真源）：
 *     · `createBook`   → `book_id`（＋幂等轮的 `skipped`）；
 *     · `listBooks`    → `books` / `total`（按 `id` **升序**；每行投影恰 `BOOK_ROW_KEYS` 10 鍵（`author_name` 為**服務端回的作者顯示名快照**，供列表免讀本機印人快照）；
 *       **仅当本次取全到顶**时多一个 additive 提示键 `truncated: true`）；
 *     · `setImageBook` → `image_id` / `book_id`（`book_id` 为**读回值**）。
 *     失败恒**恰 3 键** `{ok:false, reason, message}`，`reason` **零新增字面值**（只用 `lib/config.js`
 *     既有冻结值）。
 *  ⑨ **零集合名字面**（D4 红线）：本文件**不出现任何集合名** —— 一律经 `lib/ops.js` 的
 *     `COLLECTIONS` 与既有读写封装（`readRows` / `readRowByAnyId` / `persist`）取。
 *     **不产 `plan`**（写步在本模块内按确定序执行 ⇒ `index.js` 没有内部落盘计划可外传）、
 *     **零全表扫描**（`xiai_books` 走 `readAllGuarded` 翻页取全、硬上限 20000 行：幂等预查遇
 *     `truncated` **结构化拒绝**、清单遇 `truncated` 回包带 additive 提示键；影像行按 `id` / `_id` 窄读）。
 *  ⑩ **普通用户零泄漏**：`book_id` **不进**任何普通用户可见的 DTO / 卡片（与浏览量「卡片不显示」
 *     同口径）；本模块的三个 op 全部是管理员 op ⇒ 客户端只能带管理员令牌取到。
 *
 * 复用单点（**不得第二套**）：发号 ＝ `lib/ops.js::issueCodeNumberAvoiding`（号别 `'book'`）＋
 * `occupiedNosOf('book')`；印人门 ＝ `readPersonRow`；行读 ＝ `readRowByAnyId` / `readRows`；
 * 写 ＝ `persist`；载荷门 ＝ `pointsPayloadDenial`；管理员门 ＝ `adminWhitelistDenial`。
 * @module books
 */

const { REASONS, deny } = require('./config.js')

/** 延迟取 `lib/ops.js`（打破加载环；离线自检不需要 SDK）—— 与 `lib/addSealFace.js` 同法。 */
function opsOf() {
  return require('./ops.js')
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** `createBook` 载荷**封闭恰 5 键**（`book_id` / 审计三键一律不在其中 ⇒ `INVALID_FIELD`）。 */
const BOOK_CREATE_ALLOWED_KEYS = Object.freeze([
  'name',
  'isbn',
  'cip',
  /* **2026-11-15 新增**：【出版社】非必填（空串 / null ⇒ 未著录；非空原样保留）。 */
  'publisher',
  'author_person_id',
  'first_publish_year'
])

/**
 * `listBooks` 载荷**封闭恰 6 键**（2026-11-15 分页＋筛选；缺键即默认值，多键/未知键 ⇒ `INVALID_FIELD`）：
 *   · `offset` —— 起始偏移（整数 ≥0，默认 0）
 *   · `limit`  —— 每页行数（整数 1〜200，默认 50）
 *   · `q`      —— 关键词（书名 / 作者名 / 出版社 / ISBN / CIP / 创作者名的包含匹配；≤60 字）
 *   · `author` —— 作者名包含匹配（主作者名 ＋ 创作者链人名；≤60 字）
 *   · `year_from` / `year_to` —— 首次出版年份区间（整数 1000〜当年，闭区间；给了区间 ⇒ 无年份的行**不命中**）
 */
const BOOK_LIST_ALLOWED_KEYS = Object.freeze(['offset', 'limit', 'q', 'author', 'year_from', 'year_to'])

/** `listBooks` 分页默认 / 上限（防御：误传大值不把一页拖成全表）。 */
const BOOK_LIST_DEFAULT_LIMIT = 50
const BOOK_LIST_MAX_LIMIT = 200

/** `listBooks` 关键词长度上界（与 `listSealCards.q` 同级）。 */
const BOOK_LIST_MAX_QUERY_LENGTH = 60

/** `setImageBook` 载荷**封闭恰 2 键**（`book_id` 必须显式出现；`null` ＝ 取消归属）。 */
const BOOK_SET_IMAGE_ALLOWED_KEYS = Object.freeze(['image_id', 'book_id'])

/** `book_id` 定长位数（**五位纯数字**，裁定件 §一「管理员不可改」）。 */
const BOOK_ID_WIDTH = 5

/** `book_id` 形态门（**只认五位十进制**，`'00001'`；其它形态一律 `INVALID_VALUE`）。 */
const BOOK_ID_PATTERN = /^\d{5}$/

/** 书名长度上限（服务层护栏；裁定件未设上限 ⇒ 取「短标题」量级，超出结构化拒）。 */
const BOOK_NAME_MAX_LENGTH = 200

/** ISBN / CIP 长度上限（ISBN-13 带连字符 17 位上下 ⇒ 64 足够；只防脏长串）。 */
const BOOK_CODE_MAX_LENGTH = 64

/** 首次出版年份下限（裁定件 §1.1：`1000`〜当年）。 */
const BOOK_FIRST_YEAR_MIN = 1000

/** `xiai_books` 翻页取全的**每页行数**（与 `lib/ops.js` 既有 1000 行护栏同尺）。 */
const BOOK_LIST_SCAN_LIMIT = 1000

/** `xiai_books` 翻页取全的**硬上限**（与 `lib/ops.js::readAllGuarded` 的默认 `SCAN_HARD_CAP` 20000 同值）。 */
const BOOK_SCAN_HARD_CAP = 20000

/** `image_id` 长度上限（与 `lib/ops.js::MAX_ID_LENGTH` 同值，纯形态护栏）。 */
const BOOK_IMAGE_ID_MAX_LENGTH = 128

/** 临时印人行 id 前缀（与 `lib/ops.js::TEMP_PERSON_ID_PREFIX` **同值**；临时行不是正式印人）。 */
const BOOK_TEMP_PERSON_PREFIX = 'tmp-'

/** `listBooks` 单行投影键面（**恰 8 键**；`created_by` 属审计面、不外传）。 */
const BOOK_ROW_KEYS = Object.freeze([
  'id',
  'name',
  'isbn',
  'cip',
  'publisher',
  'author_person_id',
  'author_name',
  'creators',
  /* **2026-11-15**：`image_count` ＝ 該書已歸屬影像數（服務端計，取代前端全量影像裝配）。 */
  'image_count',
  'first_publish_year',
  'created_at',
  'updated_at'
])

/** `createBook` 回包读数键面（`index.js` 按 op 收窄透传；`skipped` 存在性驱动）。 */
const CREATE_BOOK_READOUT_KEYS = Object.freeze(['book_id', 'skipped'])

/** `listBooks` 回包读数键面（`truncated` 为 **additive 提示键**：仅在「取不全」那一轮出现）。 */
const LIST_BOOKS_READOUT_KEYS = Object.freeze(['books', 'total', 'has_more', 'offset', 'limit', 'truncated'])

/** `searchBookImages` 回包读数键面（`total` ＝ 命中总数；`rows` 为本页）。 */
const SEARCH_BOOK_IMAGES_READOUT_KEYS = Object.freeze(['rows', 'total'])

/** `setImageBook` 回包读数键面（`book_id` 是**读回值**，非请求回显）。 */
const SET_IMAGE_BOOK_READOUT_KEYS = Object.freeze(['image_id', 'book_id'])

/** 号值 → `book_id`（**五位定长十进制**；唯一形态构造点）。 */
function bookIdOf(no) {
  return String(no).padStart(BOOK_ID_WIDTH, '0')
}

/** `book_id` → 号值（形态不符 ⇒ `null`，**不猜、不纠错**）。 */
function bookNoOf(id) {
  const raw = text(id)
  return BOOK_ID_PATTERN.test(raw) ? Number(raw) : null
}

/** 行键（`_id` 优先、`id` 兜底；都没有 ⇒ 空串）。 */
function rowKeyOf(row) {
  return text(row && row._id) || text(row && row.id)
}

/** 影像行上的 `book_id`（**空值归一为 `null`** —— 与前端 `normalizeImageRow` 同尺）。 */
function imageBookIdOf(row) {
  const raw = text(row && row.book_id)
  return raw === '' ? null : raw
}

/** 服务端时钟秒（`context.nowSeconds` 缺省 ⇒ 现取）。 */
function secondsOf(context) {
  const raw = context && context.nowSeconds
  return Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : Math.floor(Date.now() / 1000)
}

/** 由秒数取「当年」（年份门的上界）。 */
function yearOf(seconds) {
  return new Date(seconds * 1000).getFullYear()
}

/**
 * 读 book 行（**显式截断**，取代 `readRows(books, {}, { limit })` 的静默截断）：
 * 经 `lib/ops.js::readAllGuarded` **翻页取全**，回 `{ rows, truncated }`。
 *
 * 为什么必须显式：`readRows` 到顶即**静默停**。本函数有两个语义不同的调用方 ——
 *   · `listBooks`（**展示类**）：允许截断，但必须**在回包显式提示**（`truncated: true`）；
 *   · `createBook`（**幂等预查 ＝ 判定类**）：截断会让重复建书**悄悄漏判**（给错结论）⇒ 一律拒绝。
 * 故「取不全」这件事不在本函数里吞掉，而是交给调用点定性（口径见优化实施件 P0-2）。
 * @returns {Promise<{rows:object[], truncated:boolean}>}
 */
async function readBookRowsGuarded(ops) {
  /* 主路：`readAllGuarded` 是**唯一**取全实现（`lib/ops.js` 导出面恒有）。 */
  if (typeof ops.readAllGuarded === 'function') {
    const scan = await ops.readAllGuarded(ops.COLLECTIONS.books, {
      pageSize: BOOK_LIST_SCAN_LIMIT,
      cap: BOOK_SCAN_HARD_CAP
    })
    return {
      rows: Array.isArray(scan && scan.rows) ? scan.rows : [],
      truncated: Boolean(scan && scan.truncated === true)
    }
  }
  /* 退路（**只服务离线自检**）：`scripts/verify-books.mjs` 用 `require.cache` 注入的假 `lib/ops.js`
     面**不含**该导出（真运行时恒有）⇒ 单次取回 ＋ 同尺判顶（行数达硬上限才判 `truncated`；
     假体的行集本就是调用方可读到的全集 ⇒ 语义不降级、**不会**凭空报截断）。生产路径不走这里。 */
  const rows = await ops.readRows(ops.COLLECTIONS.books, {}, { limit: BOOK_SCAN_HARD_CAP })
  const list = Array.isArray(rows) ? rows : []
  return { rows: list, truncated: list.length >= BOOK_SCAN_HARD_CAP }
}

/** 行投影（**只出 `BOOK_ROW_KEYS` 11 鍵**；审计键 `created_by` / `_id` / `legacy_*` 不外传）。 */
function bookRowProjectionOf(row) {
  const source = row && typeof row === 'object' ? row : {}
  const out = {}
  for (const key of BOOK_ROW_KEYS) {
    if (key === 'first_publish_year') {
      out[key] = Number.isInteger(source.first_publish_year) ? source.first_publish_year : null
      continue
    }
    if (key === 'image_count') {
      out[key] = Number.isInteger(source.image_count) ? source.image_count : 0
      continue
    }
    if (key === 'creators') {
      /* **创作者链**（服務端權威）：只出四鍵，字串化；順序即源站 `seq` 序 ⇒ 原樣保留。
         非陣列 / 空 ⇒ `[]`（前端據此不渲染鏈行，**不編造**「佚名」）。 */
      out[key] = (Array.isArray(source.creators) ? source.creators : [])
        .map((item) => (item && typeof item === 'object'
          ? { person_id: text(item.person_id), card_id: text(item.card_id), role: text(item.role), name: text(item.name) }
          : null))
        .filter((item) => item !== null)
      continue
    }
    out[key] = text(source[key])
  }
  return out
}

/* --------------------------------------------------------------------------
 * `listBooks` 分页 ＋ 筛选（2026-11-15）
 * ------------------------------------------------------------------------- */

/** 简繁逐字表（**复用 `authorMatch` 的同一张表**，不建第二套）；惰性建一次。 */
let booksS2tMap = null
function s2tOfBooks(value) {
  const source = String(value === undefined || value === null ? '' : value)
  if (source === '') return ''
  if (booksS2tMap === null) {
    const authorMatch = require('./authorMatch.js')
    const from = Array.from(String(authorMatch.S2T_GLYPH_SOURCE || '').replace(/\s+/g, ''))
    const to = Array.from(String(authorMatch.S2T_GLYPH_TARGET || '').replace(/\s+/g, ''))
    booksS2tMap = new Map()
    for (let i = 0; i < from.length && i < to.length; i += 1) booksS2tMap.set(from[i], to[i])
  }
  return Array.from(source).map((ch) => booksS2tMap.get(ch) || ch).join('')
}

/** 正整数门（`null` ⇒ 默认值；非法 ⇒ `null` 表示拒绝）。 */
function positiveIntOf(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const num = Number(value)
  if (!Number.isInteger(num) || num < min || num > max) return null
  return num
}

/**
 * `listBooks` 载荷解析（**封闭 6 键**）：缺键取默认，非法 ⇒ `INVALID_VALUE`（零读）。
 * @returns {{ok:true, value:{offset:number, limit:number, q:string, author:string, yearFrom:number|null, yearTo:number|null}}
 *          |{ok:false, reason:string, message:string}}
 */
function parseListBooksPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const offset = positiveIntOf(source.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  if (offset === null) return deny(REASONS.INVALID_VALUE, '分頁起點（offset）必須是整數且不小於 0；本次零讀取。')
  const limit = positiveIntOf(source.limit, BOOK_LIST_DEFAULT_LIMIT, 1, BOOK_LIST_MAX_LIMIT)
  if (limit === null) {
    return deny(REASONS.INVALID_VALUE, `每頁行數（limit）必須是 1〜${BOOK_LIST_MAX_LIMIT} 的整數；本次零讀取。`)
  }
  const textOf = (value) => String(value === undefined || value === null ? '' : value).trim()
  const q = textOf(source.q)
  const author = textOf(source.author)
  for (const [key, value] of [['q', q], ['author', author]]) {
    if (value.length > BOOK_LIST_MAX_QUERY_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `關鍵詞（${key}）不得超過 ${BOOK_LIST_MAX_QUERY_LENGTH} 字；本次零讀取。`)
    }
  }
  const currentYear = new Date().getFullYear()
  const yearFrom = positiveIntOf(source.year_from, null, BOOK_FIRST_YEAR_MIN, currentYear)
  if (yearFrom === null && textOf(source.year_from) !== '') {
    return deny(REASONS.INVALID_VALUE, `起始年份（year_from）必須是 ${BOOK_FIRST_YEAR_MIN}〜${currentYear} 的整數；本次零讀取。`)
  }
  const yearTo = positiveIntOf(source.year_to, null, BOOK_FIRST_YEAR_MIN, currentYear)
  if (yearTo === null && textOf(source.year_to) !== '') {
    return deny(REASONS.INVALID_VALUE, `結束年份（year_to）必須是 ${BOOK_FIRST_YEAR_MIN}〜${currentYear} 的整數；本次零讀取。`)
  }
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) {
    return deny(REASONS.INVALID_VALUE, '起始年份不得大於結束年份；本次零讀取。')
  }
  return { ok: true, value: { offset, limit, q, author, yearFrom, yearTo } }
}

/** 行 ⇒ 检索面（书名 / 作者名 / 出版社 / ISBN / CIP / 创作者人名；简繁双形态）。 */
function bookSearchHaystackOf(book) {
  const row = book && typeof book === 'object' ? book : {}
  const creators = Array.isArray(row.creators) ? row.creators : []
  const base = [row.name, row.author_name, row.publisher, row.isbn, row.cip]
    .concat(creators.map((item) => (item && typeof item === 'object' ? item.name : '')))
    .map((value) => String(value === undefined || value === null ? '' : value))
    .join('\n')
  return `${base}\n${s2tOfBooks(base)}`
}

/** 行是否命中筛选（关键词 ＋ 作者名 ＋ 年份区间；空筛选恒真）。 */
function bookMatchesFiltersOf(book, filters) {
  const row = book && typeof book === 'object' ? book : {}
  if (filters.q !== '') {
    const hay = bookSearchHaystackOf(row).toLowerCase()
    const needle = filters.q.toLowerCase()
    if (hay.indexOf(needle) === -1 && hay.indexOf(s2tOfBooks(needle).toLowerCase()) === -1) return false
  }
  if (filters.author !== '') {
    const creators = Array.isArray(row.creators) ? row.creators : []
    const names = [row.author_name].concat(creators.map((item) => (item && typeof item === 'object' ? item.name : '')))
      .map((value) => String(value === undefined || value === null ? '' : value).toLowerCase())
      .join('\n')
    const needle = filters.author.toLowerCase()
    if (names.indexOf(needle) === -1 && names.indexOf(s2tOfBooks(needle).toLowerCase()) === -1) return false
  }
  if (filters.yearFrom !== null || filters.yearTo !== null) {
    const year = Number.isInteger(row.first_publish_year) ? row.first_publish_year : null
    if (year === null) return false
    if (filters.yearFrom !== null && year < filters.yearFrom) return false
    if (filters.yearTo !== null && year > filters.yearTo) return false
  }
  return true
}


/* --------------------------------------------------------------------------
 * 影像归属计数 ＋ 按需影像检索（2026-11-15｜「批量掛圖」改按需检索）
 * ------------------------------------------------------------------------- */

/** 印譜 ⇒ 已歸屬影像數（一次讀全 `xiai_images` 的 `book_id` 面；讀失敗 ⇒ 空表、不偽造）。 */
async function countBookImagesOf(ops) {
  const counts = new Map()
  try {
    const scan = await ops.readAllGuarded(ops.COLLECTIONS.images, { cap: BOOK_SCAN_HARD_CAP })
    const rows = scan && Array.isArray(scan.rows) ? scan.rows : []
    for (const row of rows) {
      const bookId = text(row && row.book_id)
      if (bookId === '') continue
      counts.set(bookId, (counts.get(bookId) || 0) + 1)
    }
  } catch (error) {
    /* 计数面失败**不影响清单**（全部 0，不把真故障伪装成「没有影像」） */
  }
  return counts
}

/** `searchBookImages` 载荷**封闭恰 2 键**（`q` 必填；`limit` 1〜100，默认 24）。 */
const BOOK_IMAGE_SEARCH_ALLOWED_KEYS = Object.freeze(['limit', 'q'])
const BOOK_IMAGE_SEARCH_DEFAULT_LIMIT = 24
const BOOK_IMAGE_SEARCH_MAX_LIMIT = 100

/** 边款影像的 kind 字面值（**小写比较**；不引入大写字面量，避免被视为 `reason` 取值）。 */
const IMAGE_KIND_EDGE_LOWER = 'edge'

/** `searchBookImages` 行投影键面（恰 5 键）。 */
const BOOK_IMAGE_ROW_KEYS = Object.freeze(['image_id', 'stamp_id', 'seal_name', 'kind', 'book_id'])

/**
 * **管理員「按需檢索可掛影像」（`searchBookImages`）** —— 「批量掛圖」面板的唯一讀面。
 *
 * 为什么要有：旧面板把全部印章/影像装配进浏览器（6,445 張影像）⇒ 页面卡顿。
 * 现在只在**输入关键词后**才查：命中印章（印文 / 章号 / 序号，简繁双形态）→ 其影像。
 *
 * 契约：
 *   · **第一行即管理员门**（`adminWhitelistDenial`）；载荷封闭 2 键；
 *   · `q` 必填（空 ⇒ `MISSING_REQUIRED`）、≤60 字；`limit` 1〜100（默认 24）；
 *   · 回包 `{ok, rows, total}`：`total` ＝ 命中影像总数，`rows` 为**本頁**（恰 5 键）；
 *   · 只读、零写；`EDGE` 影像不入结果（§脸层口径：边款不属于可挂印面的影像面）。
 * @param {object} payload `{q, limit?}`
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, rows:object[], total:number}|{ok:false, reason:string, message:string}>}
 */
async function searchBookImages(payload, identity, context) {
  const ops = opsOf()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_IMAGE_SEARCH_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  const source = payload && typeof payload === 'object' ? payload : {}
  const q = text(source.q)
  if (q === '') return deny(REASONS.MISSING_REQUIRED, '請輸入檢索關鍵詞（印文 / 章號 / 序號）；本次零讀取。')
  if (q.length > BOOK_LIST_MAX_QUERY_LENGTH) {
    return deny(REASONS.INVALID_VALUE, `關鍵詞不得超過 ${BOOK_LIST_MAX_QUERY_LENGTH} 字；本次零讀取。`)
  }
  const limit = positiveIntOf(source.limit, BOOK_IMAGE_SEARCH_DEFAULT_LIMIT, 1, BOOK_IMAGE_SEARCH_MAX_LIMIT)
  if (limit === null) {
    return deny(REASONS.INVALID_VALUE, `每頁行數（limit）必須是 1〜${BOOK_IMAGE_SEARCH_MAX_LIMIT} 的整數；本次零讀取。`)
  }
  const needles = [q.toLowerCase(), s2tOfBooks(q).toLowerCase()]
  const sealScan = await ops.readAllGuarded(ops.COLLECTIONS.seals, { cap: BOOK_SCAN_HARD_CAP })
  const sealRows = sealScan && Array.isArray(sealScan.rows) ? sealScan.rows : []
  const matchedStamps = new Set()
  const sealNameByStamp = new Map()
  for (const row of sealRows) {
    const stampId = text(row && (row.stamp_id || row.sid || row.id))
    if (stampId === '') continue
    const hay = [row && row.seal_name, row && row.transcription, stampId, String(row && row.seal_no)]
      .map((value) => text(value).toLowerCase())
      .join('\n')
    if (!needles.some((needle) => hay.indexOf(needle) !== -1)) continue
    matchedStamps.add(stampId)
    sealNameByStamp.set(stampId, text(row && row.seal_name))
  }
  if (matchedStamps.size === 0) return { ok: true, rows: [], total: 0 }
  const imageScan = await ops.readAllGuarded(ops.COLLECTIONS.images, { cap: BOOK_SCAN_HARD_CAP })
  const imageRows = imageScan && Array.isArray(imageScan.rows) ? imageScan.rows : []
  const hits = []
  for (const row of imageRows) {
    const stampId = text(row && row.stamp_id)
    if (!matchedStamps.has(stampId)) continue
    if (text(row && row.kind).toLowerCase() === IMAGE_KIND_EDGE_LOWER) continue
    const imageId = text(row && (row.id || row._id))
    if (imageId === '') continue
    hits.push({
      image_id: imageId,
      stamp_id: stampId,
      seal_name: sealNameByStamp.get(stampId) || '',
      kind: text(row && row.kind),
      book_id: text(row && row.book_id)
    })
  }
  return { ok: true, rows: hits.slice(0, limit), total: hits.length }
}

/**
 * **管理員「新建印譜」（`createBook`）**。
 * @param {object} payload 载荷（封闭 5 键，见 `BOOK_CREATE_ALLOWED_KEYS`）
 * @param {{uid:string, phone:string, role?:string}} identity **服务端派生**的身份（唯一来源）
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, book_id:string, skipped?:true}|{ok:false, reason:string, message:string}>}
 */
async function createBook(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 5 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`；判定早于任何读）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_CREATE_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  /* ③ 必填串门：`name` / `author_person_id`（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
  for (const key of ['name', 'author_person_id']) {
    const value = payload[key]
    if (value === undefined || value === null || text(value) === '') {
      return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${key}）；本次零寫入。`)
    }
    if (typeof value !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串；本次零寫入。`)
    }
  }
  const name = text(payload.name)
  if (name.length > BOOK_NAME_MAX_LENGTH) {
    return deny(
      REASONS.INVALID_VALUE,
      `書名（name）長度不得超過 ${BOOK_NAME_MAX_LENGTH} 字；本次零寫入。`
    )
  }
  /* ④ 可空串门：`isbn` / `cip`（编号类，上界 64）＋ `publisher`（出版社名，上界同书名 200）。
     给出即必须是字符串；空串 / `null` ⇒ 未著录。 */
  for (const [key, maxLength] of [['isbn', BOOK_CODE_MAX_LENGTH], ['cip', BOOK_CODE_MAX_LENGTH], ['publisher', BOOK_NAME_MAX_LENGTH]]) {
    const value = payload[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串（可留空）；本次零寫入。`)
    }
    if (text(value).length > maxLength) {
      return deny(
        REASONS.INVALID_VALUE,
        `欄位（${key}）長度不得超過 ${maxLength} 字；本次零寫入。`
      )
    }
  }
  const isbn = text(payload.isbn)
  const cip = text(payload.cip)
  const publisher = text(payload.publisher)
  /* ⑤ 年份门（可空；给出即必须是 1000〜当年的整数；**不静默归一 / 不四舍五入**）。 */
  const seconds = secondsOf(context)
  const currentYear = yearOf(seconds)
  let firstPublishYear = null
  const rawYear = payload.first_publish_year
  if (rawYear !== undefined && rawYear !== null) {
    if (!Number.isInteger(rawYear)) {
      return deny(
        REASONS.INVALID_VALUE,
        `首次出版年份（first_publish_year）必須是整數（可留空）；本次零寫入。`
      )
    }
    if (rawYear < BOOK_FIRST_YEAR_MIN || rawYear > currentYear) {
      return deny(
        REASONS.INVALID_VALUE,
        `首次出版年份（first_publish_year）必須在 ${BOOK_FIRST_YEAR_MIN}〜${currentYear} 之間；本次零寫入。`
      )
    }
    firstPublishYear = rawYear
  }
  /* ⑥ 作者门（**必须是已收录印人**；`readPersonRow` 同门；不放行自由文本）。 */
  const authorPersonIdIn = text(payload.author_person_id)
  const personRow = await ops.readPersonRow(authorPersonIdIn)
  if (!personRow) {
    return deny(
      REASONS.INVALID_VALUE,
      `作者（author_person_id：${authorPersonIdIn}）尚未收入印人庫 ⇒ 拒絕建書；` +
        '請先提交印人提案並經採納；本次零寫入。'
    )
  }
  const authorIdOfRow = text(personRow.id) || text(personRow.code)
  if (!authorIdOfRow || authorIdOfRow.indexOf(BOOK_TEMP_PERSON_PREFIX) === 0) {
    return deny(
      REASONS.INVALID_VALUE,
      `作者（author_person_id：${authorPersonIdIn}）是臨時印人行（尚未經採納）⇒ 拒絕建書；本次零寫入。`
    )
  }
  const authorPersonId = authorIdOfRow
  /* ⑦ 幂等预查（同书名 ＋ 同作者 ⇒ 返回既有 `book_id`、不建第二行、不发号）。
     **判定类**读面：`xiai_books` 行数超出可校验范围（`truncated`）⇒ **结构化拒绝**，
     绝不在「可能漏看既有行」的前提下建新行（否则会造出重复书目 ＋ 白耗一个号）。 */
  const bookScan = await readBookRowsGuarded(ops)
  if (bookScan.truncated) {
    return deny(REASONS.STORAGE_UNAVAILABLE, '印譜行數超出可校驗範圍，本次零寫入。')
  }
  const bookRows = bookScan.rows
  const duplicate = bookRows.find(
    (row) => text(row && row.name) === name && text(row && row.author_person_id) === authorPersonId
  )
  if (duplicate) {
    const existingId = text(duplicate.id) || text(duplicate._id)
    if (BOOK_ID_PATTERN.test(existingId)) {
      return { ok: true, book_id: existingId, skipped: true }
    }
    /* 既有行的 `id` 形态不合法（脏行）⇒ **不猜、不补编**：如实拒，交人工处理。 */
    return deny(
      REASONS.INVALID_VALUE,
      `既有印譜行的編號形態不合法（id：${existingId || '（空）'}）⇒ 拒絕自動復用；本次零寫入。`
    )
  }
  /* ⑧ 发号（**复用既有发号单点**：CAS 认领计数器文档；`isTaken` 按 `xiai_books.id` 查重）。 */
  const usedNos = await ops.occupiedNosOf('book')
  for (const row of bookRows) {
    const used = bookNoOf(row && row.id)
    if (used !== null) usedNos.add(used)
  }
  const issued = await ops.issueCodeNumberAvoiding('book', (no) => usedNos.has(no))
  if (!issued.ok) return { ok: false, reason: issued.reason, message: issued.message }
  const bookId = bookIdOf(issued.no)
  if (!BOOK_ID_PATTERN.test(bookId)) {
    /* 号源越出五位 ⇒ 号源异常（`COUNTER_CAPACITY.book` 已封顶，理论上不可达）⇒ 零写入。 */
    return deny(REASONS.STORAGE_UNAVAILABLE, '印譜編號（book_id）形態異常（號源超界）；本次零寫入。')
  }
  /* ⑨ 建 book 行（键集＝裁定件 §1.1；审计三键服务端写，客户端不可递）。 */
  const at = new Date(seconds * 1000).toISOString()
  const doc = {
    id: bookId,
    name,
    isbn,
    cip,
    publisher,
    author_person_id: authorPersonId,
    first_publish_year: firstPublishYear,
    created_by: text(identity && identity.uid),
    created_at: at,
    updated_at: at
  }
  try {
    await ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.books, id: bookId, doc }] })
  } catch (error) {
    /* 行没落成 ⇒ 如实报（发出去的号不回退：号源单调、留空洞不允许重号）。 */
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印譜行落盤失敗（book_id：${bookId}）；本次零寫入，可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  /* ⑩ **读回比对**（**不得以 `persist` 的写回执判成功**；样板 ＝ 本文件 `setImageBook`）：
     按 `id` 重读该 book 行，`id` 与 `name` **逐字相等**才算落盘成功；读不到 / 不等 ⇒
     结构化失败（**绝不报假成功**：`doc(id).set()` 的 resolve 只说明「写已送出」）。 */
  let writtenRows = []
  try {
    writtenRows = await ops.readRows(ops.COLLECTIONS.books, { id: bookId }, { limit: 1 })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印譜行已送出，但讀回校驗失敗（book_id：${bookId}）；可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  if (writtenRows.length === 0) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印譜行已送出，但讀回未見該行（book_id：${bookId}）⇒ 不報成功，請重試。`
    )
  }
  const writtenBookName = text(writtenRows[0] && writtenRows[0].name)
  if (writtenBookName !== name) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印譜行讀回不一致（book_id：${bookId}；期望書名 ${name}、讀回 ${
        writtenBookName || '（空）'
      }）⇒ 不報成功，請重試。`
    )
  }
  /* ⑪ 回包（正常建行轮**恰 2 键**；`index.js` 按 `CREATE_BOOK_READOUT_KEYS` 收窄透传）。 */
  return { ok: true, book_id: bookId }
}

/**
 * **管理員「印譜清單」（`listBooks`｜只读）**：按 `id` **升序**回全部 book 行（每行恰 8 键）。
 * @param {object} payload 载荷（**封闭 0 键**）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, books:object[], total:number, truncated?:true}|{ok:false, reason:string, message:string}>}
 */
async function listBooks(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；非管理员 ⇒ 结构化拒 ＋ 零读）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 6 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`），再做形态门。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_LIST_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  const parsed = parseListBooksPayload(payload)
  if (!parsed.ok) return parsed
  const filters = parsed.value
  /* ③ 读全表（**显式截断**：翻页取全，到顶回 `truncated`）＋ 按 `id` 数值升序（形态不符的行排尾、保序返回）。 */
  const scan = await readBookRowsGuarded(ops)
  const rows = scan.rows
  const books = rows
    .map((row, index) => ({ row, index, no: bookNoOf(row && row.id) }))
    .sort((left, right) => {
      const leftNo = left.no === null ? Number.MAX_SAFE_INTEGER : left.no
      const rightNo = right.no === null ? Number.MAX_SAFE_INTEGER : right.no
      if (leftNo !== rightNo) return leftNo - rightNo
      return left.index - right.index
    })
    .map((item) => bookRowProjectionOf(item.row))
  /* ③' 影像归属计数（**服务端一次读全 images 的 `book_id` 面**后聚合；取代前端全量装配） */
  const imageCounts = await countBookImagesOf(ops)
  for (const item of books) item.image_count = imageCounts.get(text(item.id)) || 0
  /* ④ 回包（`index.js` 按 `LIST_BOOKS_READOUT_KEYS` 收窄透传）：`books` 为**本页**，
     `total` 为**命中总数**（分页前）；`has_more` 驱动「下一頁」。
     **展示类**：允许截断，但**不得静默** ⇒ 到顶时多一个 additive 提示键 `truncated: true`。
     ⑤ 筛选（在**服务端**做：全表已在手，1,745 行内存过滤远小于一次网络往返）⇒ 分页切片。 */
  const matched = books.filter((book) => bookMatchesFiltersOf(book, filters))
  const total = matched.length
  const offset = filters.offset
  const limit = filters.limit
  const page = matched.slice(offset, offset + limit)
  const reply = {
    ok: true,
    books: page,
    total,
    offset,
    limit,
    has_more: offset + page.length < total
  }
  if (scan.truncated) reply.truncated = true
  return reply
}

/**
 * **管理員「影像掛書 / 取消掛書」（`setImageBook`）**。
 * 单值 `book_id`（一对多）；`null` ＝ 取消；写后**读回比对**（不以 `updated >= 1` 判成功）。
 * @param {object} payload 载荷（封闭 2 键 `image_id` / `book_id`；`book_id` 必须显式出现）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, image_id:string, book_id:string|null}|{ok:false, reason:string, message:string}>}
 */
async function setImageBook(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；非管理员 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 2 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_SET_IMAGE_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  /* ③ `image_id` 必填串门（缺 / 空 ⇒ `MISSING_REQUIRED`；非字符串 ⇒ `INVALID_VALUE`）。 */
  const rawImageId = payload.image_id
  if (rawImageId === undefined || rawImageId === null || text(rawImageId) === '') {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（image_id）；本次零寫入。')
  }
  if (typeof rawImageId !== 'string') {
    return deny(REASONS.INVALID_VALUE, '欄位（image_id）必須是字符串；本次零寫入。')
  }
  const imageIdIn = text(rawImageId)
  if (imageIdIn.length > BOOK_IMAGE_ID_MAX_LENGTH) {
    return deny(
      REASONS.INVALID_VALUE,
      `欄位（image_id）長度必須在 1〜${BOOK_IMAGE_ID_MAX_LENGTH} 之間；本次零寫入。`
    )
  }
  /* ④ `book_id` **必须显式出现**（缺键 ⇒ `MISSING_REQUIRED`：漏传不得被当作「取消归属」）。 */
  if (!Object.prototype.hasOwnProperty.call(payload, 'book_id')) {
    return deny(
      REASONS.MISSING_REQUIRED,
      '缺少必要欄位（book_id）：取消歸屬請顯式傳 null；本次零寫入。'
    )
  }
  const rawBookId = payload.book_id
  let targetBookId = null
  if (rawBookId !== undefined && rawBookId !== null) {
    if (typeof rawBookId !== 'string') {
      return deny(
        REASONS.INVALID_VALUE,
        '欄位（book_id）必須是字符串或 null（null ＝ 取消歸屬）；本次零寫入。'
      )
    }
    targetBookId = text(rawBookId)
    if (!BOOK_ID_PATTERN.test(targetBookId)) {
      return deny(
        REASONS.INVALID_VALUE,
        '印譜編號（book_id）必須是五位純數字（如 00001）；本次零寫入。'
      )
    }
  }
  /* ⑤ 影像行存在性（`id` → `_id` 两形态窄读；无行 ⇒ `INVALID_VALUE`）。 */
  const imageRow = await ops.readRowByAnyId(ops.COLLECTIONS.images, imageIdIn, 1)
  if (!imageRow) {
    return deny(REASONS.INVALID_VALUE, `該影像不存在（image_id：${imageIdIn}）；本次零寫入。`)
  }
  const imageDocId = rowKeyOf(imageRow)
  if (!imageDocId) {
    return deny(
      REASONS.INVALID_VALUE,
      `影像行缺可用編號（image_id：${imageIdIn}）⇒ 無法定位；本次零寫入。`
    )
  }
  const canonicalImageId = text(imageRow.id) || text(imageRow._id) || imageIdIn
  /* ⑥ 目标书存在性（仅 `book_id` 非 null 时校验；`null` ＝ 取消 ⇒ 不查书）。 */
  if (targetBookId !== null) {
    const bookRow = await ops.readRowByAnyId(ops.COLLECTIONS.books, targetBookId, 1)
    if (!bookRow) {
      return deny(REASONS.INVALID_VALUE, `該印譜不存在（book_id：${targetBookId}）；本次零寫入。`)
    }
  }
  /* ⑦ 写：只写影像行 `book_id` 一个键（`null` ＝ 取消归属）。检索式取 `_id` 优先。 */
  const match = text(imageRow._id) ? { _id: text(imageRow._id) } : { id: text(imageRow.id) }
  try {
    await ops.persist({
      writes: [
        {
          kind: 'update',
          collection: ops.COLLECTIONS.images,
          match,
          doc: { book_id: targetBookId },
          expectAtLeast: 1
        }
      ]
    })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `影像行掛書落盤失敗（image_id：${canonicalImageId}）；歸屬未確認，可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  /* ⑧ **读回比对**（不得以 `updated >= 1` 判成功）：按同一检索式重读该影像行。 */
  let readback = []
  try {
    readback = await ops.readRows(ops.COLLECTIONS.images, match, { limit: 1 })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `掛書已送出，但讀回校驗失敗（image_id：${canonicalImageId}；歸屬以服務端為準，請稍後重試讀取）。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  if (readback.length === 0) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `掛書已送出，但讀回未見該影像行（image_id：${canonicalImageId}）；歸屬以服務端為準，請稍後重新整理確認。`
    )
  }
  const writtenBookId = imageBookIdOf(readback[0])
  if (writtenBookId !== targetBookId) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `掛書讀回不一致（image_id：${canonicalImageId}；期望 ${
        targetBookId === null ? '未歸屬' : targetBookId
      }、讀回 ${writtenBookId === null ? '未歸屬' : writtenBookId}）⇒ 不報成功，請重試。`
    )
  }
  /* ⑨ 回包（`book_id` 是**读回值**；`index.js` 按 `SET_IMAGE_BOOK_READOUT_KEYS` 收窄透传）。 */
  return { ok: true, image_id: canonicalImageId, book_id: writtenBookId }
}

/* --------------------------------------------------------------------------
 * 卡片矩陣四 op（2026-11-17｜`updateBook` / `setBookCover` / `listBookCovers` / `listSealCovers`）
 * -------------------------------------------------------------------------
 * 接口**已冻结**（前端 `/books` 与 `/my/drive` 改卡片矩阵），键名逐字不得改：
 *   · `updateBook`    （管理員）`{book_id, patch:{name?,isbn?,cip?,publisher?,author_person_id?,first_publish_year?}}`
 *                     → `{ok:true, book}`（`book` 与 `listBooks` 行投影**同形**）；
 *   · `setBookCover`  （管理員）`{book_id, image_id}` → `{ok:true, book_id, cover_image_id}`
 *                     （`image_id` 空串 ＝ 清除封面；写到 `xiai_books.cover_image_id`）；
 *   · `listBookCovers`（管理員）`{book_ids:[≤200]}` → `{ok:true, rows:[{book_id, cover_image_id, thumb_key}]}`；
 *   · `listSealCovers`（**公開讀**｜`lib/sealCards.js::PUBLIC_OPS` 成员，`action:'public'`）`{stamp_ids:[≤200]}`
 *                     → `{ok:true, rows:[{stamp_id, thumb_key, display_key, original_storage_key,
 *                     original_sha256}]}`（**零寫入**；后三鍵為 2026-11-17 前端四級回落凍結的
 *                     **additive 鍵**，取不到給空串；`hidden` 影像行 ⇒ 四個影像派生鍵全空）。
 *
 * 硬口径（逐条）：
 *  ① 三个管理員 op 的**第一行**即 `adminWhitelistDenial`（缺 env / 非白名单 ⇒ 结构化拒 ＋ **零读零写**）；
 *    `listSealCovers` 是**公开读**（不验令牌、零写）。
 *  ② 载荷封闭键面（未知键 ⇒ `INVALID_FIELD`，判定**早于任何读**）；`updateBook.patch` 的**内层**键面
 *     亦封闭（只许 `BOOK_UPDATE_PATCH_KEYS` 六键，其余一律 `INVALID_FIELD`）。
 *  ③ 值域门照 `createBook`（同常量、同文案量级）：`name` 非空 ≤200、`isbn` / `cip` ≤64、
 *     `publisher` ≤200、`first_publish_year` 1000〜当年的整数（`null` ＝ 清空）、
 *     `author_person_id` 必须指向**已收录印人**（`readPersonRow` 同门；`tmp-` 临时行拒）。
 *  ④ 目标行不存在 ⇒ `INVALID_VALUE` ＋「該…不存在」（本函数冻结表**无 `NOT_FOUND`**）；
 *     `setBookCover` 的 `image_id` 必须存在**且其 `book_id` ＝ 该书**（否则 `INVALID_VALUE` ＋ 零写入）。
 *  ⑤ 封面数据**只经 `listBookCovers` / `listSealCovers` 回**，`BOOK_ROW_KEYS` 恒恰 12 键**不动**
 *     （封面不塞进 `listBooks` 行）。
 *  ⑥ `thumb_key` **复用** `lib/sealCards.js::thumbKeyOfDigest` 同源逻辑
 *     （`xiai/thumb/<sha 前兩位>/<sha>.webp`）；取不到摘要 / 无行 ⇒ 空串（**不编造对象键**）。
 *  ⑦ 写后**读回比对**（不以 `updated >= 1` 判成功）；读不到 / 不等 ⇒ `STORAGE_UNAVAILABLE`。
 *  ⑧ `reason` **零新增**、**零新集合**、本文件**零集合名字面**（一律经 `ops.COLLECTIONS` ＋
 *     `ops.readRows` / `ops.readRowByAnyId` / `ops.persist`），**不产 `plan`**。
 * ------------------------------------------------------------------------- */

/** `updateBook` 载荷**封闭恰 2 键**（`patch` 内层再封闭，见下）。 */
const BOOK_UPDATE_ALLOWED_KEYS = Object.freeze(['book_id', 'patch'])

/** `updateBook.patch` **封闭恰 6 键**（仅允许改这六项；其它键 ⇒ `INVALID_FIELD`）。 */
const BOOK_UPDATE_PATCH_KEYS = Object.freeze([
  'name',
  'isbn',
  'cip',
  'publisher',
  'author_person_id',
  'first_publish_year'
])

/** `setBookCover` 载荷**封闭恰 2 键**（`image_id` 必须显式出现；空串 ＝ 清除封面）。 */
const BOOK_SET_COVER_ALLOWED_KEYS = Object.freeze(['book_id', 'image_id'])

/** `listBookCovers` 载荷**封闭恰 1 键**。 */
const BOOK_LIST_COVERS_ALLOWED_KEYS = Object.freeze(['book_ids'])

/** `listSealCovers` 载荷**封闭恰 1 键**。 */
const BOOK_LIST_SEAL_COVERS_ALLOWED_KEYS = Object.freeze(['stamp_ids'])

/** 两个「按 id 批量取封面」op 的**单次 id 上限**（派单冻结值 200）。 */
const BOOK_COVERS_MAX_IDS = 200

/** `updateBook` 回包读数键面（`book` ＝ 与 `listBooks` 同形的行投影）。 */
const UPDATE_BOOK_READOUT_KEYS = Object.freeze(['book'])

/** `setBookCover` 回包读数键面（`cover_image_id` 是**读回值**）。 */
const SET_BOOK_COVER_READOUT_KEYS = Object.freeze(['book_id', 'cover_image_id'])

/** `listBookCovers` / `listSealCovers` 回包读数键面（`rows` 为 id 序行表）。 */
const LIST_BOOK_COVERS_READOUT_KEYS = Object.freeze(['rows'])
const LIST_SEAL_COVERS_READOUT_KEYS = Object.freeze(['rows'])

/** 空串（`cover_image_id` / `thumb_key` 的「无」值；**不写 `null`**，与前端卡片同尺）。 */
const BOOK_COVER_EMPTY = ''

/** 行上是否有该键（**看得见 `undefined` 与空串之别**）。 */
function hasKeyOf(row, key) {
  return Object.prototype.hasOwnProperty.call(row, key)
}

/**
 * `id` 表载荷解析（两个 list-op 共用）：缺 / 非数组 / 超上限 / 元素非字符串 ⇒ 结构化拒（零读）。
 * 元素按**原序去重**（重复 id 不重复出镜，也不报错）。
 * @returns {{ok:true, value:string[]}|{ok:false, reason:string, message:string}}
 */
function parseIdListOf(raw, keyName, pattern, shapeMessage) {
  if (raw === undefined || raw === null) {
    return deny(REASONS.MISSING_REQUIRED, `缺少必要欄位（${keyName}）；本次零讀取。`)
  }
  if (!Array.isArray(raw)) {
    return deny(REASONS.INVALID_VALUE, `欄位（${keyName}）必須是數組；本次零讀取。`)
  }
  if (raw.length > BOOK_COVERS_MAX_IDS) {
    return deny(REASONS.INVALID_VALUE, `欄位（${keyName}）最多 ${BOOK_COVERS_MAX_IDS} 項；本次零讀取。`)
  }
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${keyName}）的每一項必須是字符串；本次零讀取。`)
    }
    const id = text(item)
    if (id === '') continue
    if (pattern && !pattern.test(id)) {
      return deny(REASONS.INVALID_VALUE, `${shapeMessage}；本次零讀取。`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return { ok: true, value: out }
}

/**
 * **`field ∈ values` 一次批量窄读**（主路 `where in` ⇒ 退路逐 key 窄读）。
 *
 * 为什么要有退路：`db.command.in` 是**服务端算子**，离线桩（`require.cache` 注入的内存假体）
 * 与个别 SDK 版本没有它 —— 「一次批量取」不得以牺牲可测性为代价。**真存储故障会在退路里
 * 再次抛出**（原样上抛，绝不吞成「零行」）。读仍是 `ops.readRows`，本文件零第二套行读。
 * @param {object} ops `lib/ops.js` 模块
 * @param {string} collection 集合名（一律经 `ops.COLLECTIONS`）
 * @param {string} field 检索字段（`id` / `_id` / `sealId` / `stamp_id`）
 * @param {string[]} values 检索键族
 * @returns {Promise<object[]>} 行表（无行即不在表内）
 */
async function rowsByFieldIn(ops, collection, field, values) {
  const unique = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const id = text(value)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  if (unique.length === 0) return []
  let command = null
  try {
    const db = typeof ops.resolveDb === 'function' ? ops.resolveDb() : null
    command = db && db.command ? db.command : null
  } catch (error) {
    command = null
  }
  if (command && typeof command.in === 'function') {
    try {
      const rows = await ops.readRows(collection, { [field]: command.in(unique) }, { limit: unique.length })
      return Array.isArray(rows) ? rows : []
    } catch (error) {
      /* 退路（**不吞真故障**）：算子不被支持 / 形态不符 ⇒ 逐 key 窄读；真故障会在下面再次抛出。 */
    }
  }
  const rows = []
  for (const id of unique) {
    const one = await ops.readRows(collection, { [field]: id }, { limit: 1 })
    for (const row of Array.isArray(one) ? one : []) rows.push(row)
  }
  return rows
}

/** 行表 ⇒ `key ⇒ 行`（**先 `id` 后 `_id`** 两轮取；缺的行自然不在表内）。 */
async function rowsByIdOf(ops, collection, ids) {
  const map = new Map()
  const take = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = text(row && row.id) || text(row && row._id)
      if (key === '' || map.has(key)) continue
      map.set(key, row)
    }
  }
  take(await rowsByFieldIn(ops, collection, 'id', ids))
  const missing = ids.filter((id) => !map.has(id))
  if (missing.length > 0) take(await rowsByFieldIn(ops, collection, '_id', missing))
  return map
}

/**
 * 摘要 ⇒ `thumb_key`（**唯一派生入口**：复用 `lib/sealCards.js::thumbKeyOfDigest`）。
 * 无行 / 无摘要 / 摘要形态不符 ⇒ 空串（**不编造对象键**）。
 * @param {object|null} row 影像行
 * @returns {string}
 */
function thumbKeyOfImageRow(row) {
  const sha = text(row && row.sha256)
  if (sha === '') return BOOK_COVER_EMPTY
  /* 延迟 require（与 `opsOf()` 同法；本文件不在加载期拉入 `sealCards` ⇒ 零加载环风险）。 */
  const { thumbKeyOfDigest } = require('./sealCards.js')
  return text(thumbKeyOfDigest(sha))
}

/** book 行 ⇒ 与 `listBooks` **同形**的回包投影（含 `image_count` 服务端计数）。 */
async function bookProjectionWithCountsOf(ops, row) {
  const out = bookRowProjectionOf(row)
  const counts = await countBookImagesOf(ops)
  out.image_count = counts.get(text(out.id)) || 0
  return out
}

/**
 * **管理員「改印譜」（`updateBook`）** —— 只允许改 `BOOK_UPDATE_PATCH_KEYS` 六键。
 * @param {object} payload `{book_id, patch:{…}}`
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, book:object}|{ok:false, reason:string, message:string}>}
 */
async function updateBook(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；非管理员 ⇒ 结构化拒 ＋ 零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 2 键（未知键 / 身份类键 ⇒ `INVALID_FIELD`）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_UPDATE_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  /* ③ `book_id` 必填 ＋ 形态门（五位十进制）。 */
  const rawBookId = payload.book_id
  if (rawBookId === undefined || rawBookId === null || text(rawBookId) === '') {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（book_id）；本次零寫入。')
  }
  if (typeof rawBookId !== 'string') {
    return deny(REASONS.INVALID_VALUE, '欄位（book_id）必須是字符串；本次零寫入。')
  }
  const bookId = text(rawBookId)
  if (!BOOK_ID_PATTERN.test(bookId)) {
    return deny(REASONS.INVALID_VALUE, '印譜編號（book_id）必須是五位純數字（如 00001）；本次零寫入。')
  }
  /* ④ `patch` 必填、必须是对象，且**内层键面封闭**（不可改的键一律 `INVALID_FIELD`）。 */
  const rawPatch = payload.patch
  if (rawPatch === undefined || rawPatch === null) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（patch）；本次零寫入。')
  }
  if (typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    return deny(REASONS.INVALID_VALUE, '欄位（patch）必須是對象；本次零寫入。')
  }
  const unknownPatchKeys = Object.keys(rawPatch).filter((key) => BOOK_UPDATE_PATCH_KEYS.indexOf(key) === -1)
  if (unknownPatchKeys.length > 0) {
    return deny(
      REASONS.INVALID_FIELD,
      `patch 含不可改欄位：${unknownPatchKeys.join('、')}（僅允許 ${BOOK_UPDATE_PATCH_KEYS.join('、')}）；本次零寫入。`
    )
  }
  /* ⑤ 值域门（**纯判定、早于任何读**；与 `createBook` 同常量、同量级）。 */
  const patch = {}
  if (hasKeyOf(rawPatch, 'name')) {
    if (typeof rawPatch.name !== 'string' || text(rawPatch.name) === '') {
      return deny(REASONS.INVALID_VALUE, '書名（name）必須是非空字符串；本次零寫入。')
    }
    if (text(rawPatch.name).length > BOOK_NAME_MAX_LENGTH) {
      return deny(REASONS.INVALID_VALUE, `書名（name）長度不得超過 ${BOOK_NAME_MAX_LENGTH} 字；本次零寫入。`)
    }
    patch.name = text(rawPatch.name)
  }
  for (const [key, maxLength] of [['isbn', BOOK_CODE_MAX_LENGTH], ['cip', BOOK_CODE_MAX_LENGTH], ['publisher', BOOK_NAME_MAX_LENGTH]]) {
    if (!hasKeyOf(rawPatch, key)) continue
    const value = rawPatch[key]
    if (value !== null && typeof value !== 'string') {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）必須是字符串（可留空）；本次零寫入。`)
    }
    if (text(value).length > maxLength) {
      return deny(REASONS.INVALID_VALUE, `欄位（${key}）長度不得超過 ${maxLength} 字；本次零寫入。`)
    }
    patch[key] = text(value)
  }
  if (hasKeyOf(rawPatch, 'first_publish_year')) {
    const rawYear = rawPatch.first_publish_year
    if (rawYear === null) {
      patch.first_publish_year = null
    } else {
      const currentYear = yearOf(secondsOf(context))
      if (!Number.isInteger(rawYear)) {
        return deny(REASONS.INVALID_VALUE, '首次出版年份（first_publish_year）必須是整數（可留空）；本次零寫入。')
      }
      if (rawYear < BOOK_FIRST_YEAR_MIN || rawYear > currentYear) {
        return deny(
          REASONS.INVALID_VALUE,
          `首次出版年份（first_publish_year）必須在 ${BOOK_FIRST_YEAR_MIN}〜${currentYear} 之間；本次零寫入。`
        )
      }
      patch.first_publish_year = rawYear
    }
  }
  /* ⑥ 目标印譜存在性（无行 ⇒ `INVALID_VALUE` ＋「該印譜不存在」，**零写入**）。 */
  const bookRow = await ops.readRowByAnyId(ops.COLLECTIONS.books, bookId, 1)
  if (!bookRow) {
    return deny(REASONS.INVALID_VALUE, `該印譜不存在（book_id：${bookId}）；本次零寫入。`)
  }
  /* ⑦ 作者门（**必须是已收录印人**；`patch` 未带该键则免读）。 */
  if (hasKeyOf(patch, 'author_person_id') || hasKeyOf(rawPatch, 'author_person_id')) {
    const rawAuthor = rawPatch.author_person_id
    if (typeof rawAuthor !== 'string' || text(rawAuthor) === '') {
      return deny(REASONS.INVALID_VALUE, '作者（author_person_id）必須是非空字符串；本次零寫入。')
    }
    const authorPersonIdIn = text(rawAuthor)
    const personRow = await ops.readPersonRow(authorPersonIdIn)
    const personIdOfRow = text(personRow && (personRow.id || personRow.code))
    if (!personRow || !personIdOfRow || personIdOfRow.indexOf(BOOK_TEMP_PERSON_PREFIX) === 0) {
      return deny(
        REASONS.INVALID_VALUE,
        `作者（author_person_id：${authorPersonIdIn}）尚未收入印人庫 ⇒ 拒絕修改；` +
          '請先提交印人提案並經採納；本次零寫入。'
      )
    }
    patch.author_person_id = personIdOfRow
  }
  const changedKeys = Object.keys(patch)
  /* ⑧ 空 `patch` ＝ 无改动（**零写**）：直接回 `listBooks` 同形投影（不报错、不写行）。 */
  if (changedKeys.length === 0) {
    return { ok: true, book: await bookProjectionWithCountsOf(ops, bookRow) }
  }
  /* ⑨ 写：只写 `patch` 六键（＋ `updated_at`）；检索式取 `_id` 优先。 */
  const match = text(bookRow._id) ? { _id: text(bookRow._id) } : { id: text(bookRow.id) || bookId }
  const at = new Date(secondsOf(context) * 1000).toISOString()
  const doc = Object.assign({}, patch, { updated_at: at })
  try {
    await ops.persist({
      writes: [{ kind: 'update', collection: ops.COLLECTIONS.books, match, doc, expectAtLeast: 1 }]
    })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `印譜行修改落盤失敗（book_id：${bookId}）；改動未確認，可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  /* ⑩ **读回比对**（不得以 `updated >= 1` 判成功）：按同一检索式重读该 book 行。 */
  let readback = []
  try {
    readback = await ops.readRows(ops.COLLECTIONS.books, match, { limit: 1 })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `修改已送出，但讀回校驗失敗（book_id：${bookId}）；可重試。（診斷：${
        (error && error.message) || 'unknown'
      }）`
    )
  }
  if (!Array.isArray(readback) || readback.length === 0) {
    return deny(REASONS.STORAGE_UNAVAILABLE, `修改已送出，但讀回未見該印譜行（book_id：${bookId}）⇒ 不報成功，請重試。`)
  }
  const writtenRow = readback[0]
  for (const key of changedKeys) {
    const expected = patch[key]
    const actual = key === 'first_publish_year'
      ? (Number.isInteger(writtenRow.first_publish_year) ? writtenRow.first_publish_year : null)
      : text(writtenRow[key])
    if (actual !== expected) {
      return deny(
        REASONS.STORAGE_UNAVAILABLE,
        `印譜行讀回不一致（book_id：${bookId}；欄位 ${key}）⇒ 不報成功，請重試。`
      )
    }
  }
  /* ⑪ 回包：`book` 与 `listBooks` 行投影同形（`index.js` 按 `UPDATE_BOOK_READOUT_KEYS` 收窄透传）。 */
  return { ok: true, book: await bookProjectionWithCountsOf(ops, writtenRow) }
}

/**
 * **管理員「設封面」（`setBookCover`）**：把某影像设为该书封面（写 `xiai_books.cover_image_id`）。
 *
 * 硬口径：`image_id` 必须存在**且其 `book_id` ＝ 该书**（否则 `INVALID_VALUE` ＋ 零写入）；
 * `image_id` 空串 ＝ **清除封面**（合法，不查影像行）。
 * @param {object} payload `{book_id, image_id}`
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, book_id:string, cover_image_id:string}|{ok:false, reason:string, message:string}>}
 */
async function setBookCover(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；零读零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 2 键。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_SET_COVER_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  /* ③ `book_id` 必填 ＋ 形态门。 */
  const rawBookId = payload.book_id
  if (rawBookId === undefined || rawBookId === null || text(rawBookId) === '') {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（book_id）；本次零寫入。')
  }
  if (typeof rawBookId !== 'string') {
    return deny(REASONS.INVALID_VALUE, '欄位（book_id）必須是字符串；本次零寫入。')
  }
  const bookId = text(rawBookId)
  if (!BOOK_ID_PATTERN.test(bookId)) {
    return deny(REASONS.INVALID_VALUE, '印譜編號（book_id）必須是五位純數字（如 00001）；本次零寫入。')
  }
  /* ④ `image_id` **必须显式出现**（缺 / `null` ⇒ `MISSING_REQUIRED`：清除封面请显式传空串）。 */
  const rawImageId = payload.image_id
  if (rawImageId === undefined || rawImageId === null) {
    return deny(REASONS.MISSING_REQUIRED, '缺少必要欄位（image_id）：清除封面請顯式傳空串；本次零寫入。')
  }
  if (typeof rawImageId !== 'string') {
    return deny(REASONS.INVALID_VALUE, '欄位（image_id）必須是字符串（清除封面傳空串）；本次零寫入。')
  }
  const imageId = text(rawImageId)
  if (imageId.length > BOOK_IMAGE_ID_MAX_LENGTH) {
    return deny(REASONS.INVALID_VALUE, `欄位（image_id）長度必須在 0〜${BOOK_IMAGE_ID_MAX_LENGTH} 之間；本次零寫入。`)
  }
  /* ⑤ 目标印譜存在性。 */
  const bookRow = await ops.readRowByAnyId(ops.COLLECTIONS.books, bookId, 1)
  if (!bookRow) {
    return deny(REASONS.INVALID_VALUE, `該印譜不存在（book_id：${bookId}）；本次零寫入。`)
  }
  /* ⑥ 影像归属门（**空串 ＝ 清除 ⇒ 不查影像行**）：必须存在**且**其 `book_id` ＝ 该书。 */
  if (imageId !== BOOK_COVER_EMPTY) {
    const imageRow = await ops.readRowByAnyId(ops.COLLECTIONS.images, imageId, 1)
    if (!imageRow) {
      return deny(REASONS.INVALID_VALUE, `該影像不存在（image_id：${imageId}）；本次零寫入。`)
    }
    const ownerBookId = imageBookIdOf(imageRow)
    if (ownerBookId !== bookId) {
      return deny(
        REASONS.INVALID_VALUE,
        `該影像不屬於該印譜（image_id：${imageId}；book_id：${bookId}）⇒ 拒絕設為封面；本次零寫入。`
      )
    }
  }
  /* ⑦ 写：`xiai_books` 行的 `cover_image_id` 一个键（空串 ＝ 清除）。 */
  const match = text(bookRow._id) ? { _id: text(bookRow._id) } : { id: text(bookRow.id) || bookId }
  const at = new Date(secondsOf(context) * 1000).toISOString()
  try {
    await ops.persist({
      writes: [
        {
          kind: 'update',
          collection: ops.COLLECTIONS.books,
          match,
          doc: { cover_image_id: imageId, updated_at: at },
          expectAtLeast: 1
        }
      ]
    })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `封面落盤失敗（book_id：${bookId}）；封面未確認，可重試。（診斷：${(error && error.message) || 'unknown'}）`
    )
  }
  /* ⑧ **读回比对**（不得以 `updated >= 1` 判成功）。 */
  let readback = []
  try {
    readback = await ops.readRows(ops.COLLECTIONS.books, match, { limit: 1 })
  } catch (error) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `封面已送出，但讀回校驗失敗（book_id：${bookId}）；可重試。（診斷：${(error && error.message) || 'unknown'}）`
    )
  }
  if (!Array.isArray(readback) || readback.length === 0) {
    return deny(REASONS.STORAGE_UNAVAILABLE, `封面已送出，但讀回未見該印譜行（book_id：${bookId}）⇒ 不報成功，請重試。`)
  }
  const writtenCoverId = text(readback[0] && readback[0].cover_image_id)
  if (writtenCoverId !== imageId) {
    return deny(
      REASONS.STORAGE_UNAVAILABLE,
      `封面讀回不一致（book_id：${bookId}；期望 ${imageId || '（清除）'}、讀回 ${
        writtenCoverId || '（清除）'
      }）⇒ 不報成功，請重試。`
    )
  }
  /* ⑨ 回包（`cover_image_id` 是**读回值**；`index.js` 按 `SET_BOOK_COVER_READOUT_KEYS` 收窄透传）。 */
  return { ok: true, book_id: bookId, cover_image_id: writtenCoverId }
}

/**
 * **管理員「印譜封面表」（`listBookCovers`｜只读）**：按 `book_ids` 回
 * `[{book_id, cover_image_id, thumb_key}]`（**与请求 id 同序、去重、逐 id 一行**）。
 *
 * 一本书没有封面 / 书行不存在 / 影像行取不到摘要 ⇒ `cover_image_id` / `thumb_key` 给**空串**
 * （前端按空串走占位图；**不编造对象键、不静默少行**）。
 * @param {object} payload `{book_ids: string[]}`（≤200）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number}} [context]
 * @returns {Promise<{ok:true, rows:object[]}|{ok:false, reason:string, message:string}>}
 */
async function listBookCovers(payload, identity, context) {
  const ops = opsOf()
  /* ① 管理员门（**第一行即判**；只读、零写）。 */
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return identityDenial
  /* ② 载荷封闭恰 1 键 ＋ id 表形态门（零读）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_LIST_COVERS_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  const parsed = parseIdListOf(
    payload.book_ids,
    'book_ids',
    BOOK_ID_PATTERN,
    '印譜編號（book_ids）必須是五位純數字（如 00001）'
  )
  if (!parsed.ok) return parsed
  const bookIds = parsed.value
  if (bookIds.length === 0) return { ok: true, rows: [] }
  /* ③ 一次批量取 book 行（`id` → `_id` 两轮）＋ 一次批量取影像行 ⇒ 循环内零读库。 */
  const bookRows = await rowsByIdOf(ops, ops.COLLECTIONS.books, bookIds)
  const coverIdByBook = new Map()
  for (const bookId of bookIds) {
    const row = bookRows.get(bookId)
    coverIdByBook.set(bookId, text(row && row.cover_image_id))
  }
  const coverIds = Array.from(new Set(Array.from(coverIdByBook.values()).filter((id) => id !== '')))
  const imageRows = coverIds.length > 0 ? await rowsByIdOf(ops, ops.COLLECTIONS.images, coverIds) : new Map()
  /* ④ 回包（逐 id 一行、请求序、去重；`index.js` 按 `LIST_BOOK_COVERS_READOUT_KEYS` 收窄透传）。 */
  const rows = bookIds.map((bookId) => {
    const coverImageId = coverIdByBook.get(bookId) || BOOK_COVER_EMPTY
    const imageRow = coverImageId === '' ? null : imageRows.get(coverImageId) || null
    return {
      book_id: bookId,
      cover_image_id: coverImageId,
      thumb_key: imageRow ? thumbKeyOfImageRow(imageRow) : BOOK_COVER_EMPTY
    }
  })
  return { ok: true, rows }
}

/**
 * **公开读「印章封面表」（`listSealCovers`｜`action:'public'`，恒零写）**。
 *
 * 每个印章取**主印面**（`is_primary:true`；无则 `kind='FACE'` 中 `face_no` 最小 —— 与
 * `lib/sealCards.js::primaryFaceOf` **同一判据**）的 `face_image_id` → 影像行 → 同源派生
 * 封面键；取不到给空串。
 *
 * 回包每行**恰 5 键**（2026-11-17 前端四级回落冻结键面；**只加键，不改已有键名与语义**）：
 *   · `stamp_id` —— 请求里的印章键原样；
 *   · `thumb_key` —— 缩略件对象键（第一级）；
 *   · `display_key` —— 展示件对象键（第二级；派生单点 ＝ `sealCards.coverKeysOf`，与首页卡片同源）；
 *   · `original_storage_key` / `original_sha256` —— **转码行**才有的原图两字段（第三级）；
 *     行上没有 ⇒ 空串（**不编造**）。
 *
 * **读面闸门（2026-11-17）**：主印面影像行逐字 `hidden` ⇒ 该行**四个影像派生键全给空串**
 * （`thumb_key` / `display_key` / `original_storage_key` / `original_sha256`），前端据此落本地
 * 占位图；`stamp_id` 照回（行仍在表里，只是没有可出的图）。判据单点 ＝
 * `lib/ops.js::imageRowVisibilityOf`（缺键 / 表外值一律当 `visible`，旧行不得凭空少一张）。
 * @param {object} payload `{stamp_ids: string[]}`（≤200）
 * @returns {Promise<{ok:true, rows:object[]}|{ok:false, reason:string, message:string}>}
 */
async function listSealCovers(payload) {
  const ops = opsOf()
  /* ① 公开读：**无管理员门**（匿名可调）；载荷封闭恰 1 键 ＋ id 表形态门（零读）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_LIST_SEAL_COVERS_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
  const parsed = parseIdListOf(payload.stamp_ids, 'stamp_ids', null, '')
  if (!parsed.ok) return parsed
  const stampIds = parsed.value
  if (stampIds.length === 0) return { ok: true, rows: [] }
  /* ② 面行：`sealId ∈ ids` 主路；未命中的章再按 `stamp_id` / `seal_id` 各补一轮（**恒 3 次批量读**）。 */
  const facesByStamp = new Map()
  const take = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = text(row && row.sealId) || text(row && row.stamp_id) || text(row && row.seal_id)
      if (key === '' || stampIds.indexOf(key) === -1) continue
      if (!facesByStamp.has(key)) facesByStamp.set(key, [])
      facesByStamp.get(key).push(row)
    }
  }
  take(await rowsByFieldIn(ops, ops.COLLECTIONS.faces, 'sealId', stampIds))
  let missing = stampIds.filter((stampId) => !facesByStamp.has(stampId))
  if (missing.length > 0) take(await rowsByFieldIn(ops, ops.COLLECTIONS.faces, 'stamp_id', missing))
  missing = stampIds.filter((stampId) => !facesByStamp.has(stampId))
  if (missing.length > 0) take(await rowsByFieldIn(ops, ops.COLLECTIONS.faces, 'seal_id', missing))
  /* ③ 主印面（**唯一判据点** ＝ `lib/sealCards.js::primaryFaceOf`；本文件零第二套）。
     面行本身留着 —— `display_key` 的派生要与首页卡片**同一处**（`coverKeysOf` 在影像行
     缺席 `storage_key` 时会回落到面行自带引用）。 */
  const { primaryFaceOf, coverKeysOf } = require('./sealCards.js')
  const primaryImageIdOfStamp = new Map()
  const primaryFaceOfStamp = new Map()
  for (const stampId of stampIds) {
    const faces = facesByStamp.get(stampId) || []
    const face = faces.length > 0 ? primaryFaceOf(faces) : null
    primaryFaceOfStamp.set(stampId, face || null)
    primaryImageIdOfStamp.set(stampId, text(face && face.face_image_id))
  }
  /* ④ 影像行一次批量取（`id` → `_id` 两轮）⇒ 循环内零读库。 */
  const imageIds = Array.from(
    new Set(Array.from(primaryImageIdOfStamp.values()).filter((id) => id !== ''))
  )
  const imageRows = imageIds.length > 0 ? await rowsByIdOf(ops, ops.COLLECTIONS.images, imageIds) : new Map()
  /* ⑤ 回包（逐章一行、请求序、去重；零写入；`index.js` 公开面**原样透传**）。 */
  const rows = stampIds.map((stampId) => {
    const imageId = primaryImageIdOfStamp.get(stampId) || ''
    const imageRow = imageId === '' ? null : imageRows.get(imageId) || null
    /* **读面闸门**：影像行 `visibility === 'hidden'` ⇒ 四个影像派生键全空（`stamp_id` 照回）。 */
    if (imageRow !== null && ops.imageRowVisibilityOf(imageRow) === ops.IMAGE_VISIBILITY_HIDDEN) {
      return {
        stamp_id: stampId,
        thumb_key: BOOK_COVER_EMPTY,
        display_key: BOOK_COVER_EMPTY,
        original_storage_key: BOOK_COVER_EMPTY,
        original_sha256: BOOK_COVER_EMPTY
      }
    }
    const cover = imageRow ? coverKeysOf(imageRow, primaryFaceOfStamp.get(stampId), text(imageRow.sha256)) : null
    return {
      stamp_id: stampId,
      thumb_key: imageRow ? thumbKeyOfImageRow(imageRow) : BOOK_COVER_EMPTY,
      display_key: cover ? text(cover.displayKey) : BOOK_COVER_EMPTY,
      original_storage_key: imageRow ? text(imageRow.original_storage_key) : BOOK_COVER_EMPTY,
      original_sha256: imageRow ? text(imageRow.original_sha256) : BOOK_COVER_EMPTY
    }
  })
  return { ok: true, rows }
}

module.exports = {
  createBook,
  listBooks,
  setImageBook,
  searchBookImages,
  updateBook,
  setBookCover,
  listBookCovers,
  listSealCovers,
  BOOK_IMAGE_SEARCH_ALLOWED_KEYS,
  BOOK_IMAGE_ROW_KEYS,
  BOOK_CREATE_ALLOWED_KEYS,
  BOOK_LIST_ALLOWED_KEYS,
  BOOK_SET_IMAGE_ALLOWED_KEYS,
  BOOK_ROW_KEYS,
  BOOK_ID_WIDTH,
  BOOK_ID_PATTERN,
  CREATE_BOOK_READOUT_KEYS,
  LIST_BOOKS_READOUT_KEYS,
  SET_IMAGE_BOOK_READOUT_KEYS,
  SEARCH_BOOK_IMAGES_READOUT_KEYS,
  /* 卡片矩陣四 op（2026-11-17）：鍵面真源 ＋ 兩個新集合面讀寫常量（`index.js` 按 op 收窄透傳）。 */
  BOOK_UPDATE_ALLOWED_KEYS,
  BOOK_UPDATE_PATCH_KEYS,
  BOOK_SET_COVER_ALLOWED_KEYS,
  BOOK_LIST_COVERS_ALLOWED_KEYS,
  BOOK_LIST_SEAL_COVERS_ALLOWED_KEYS,
  BOOK_COVERS_MAX_IDS,
  UPDATE_BOOK_READOUT_KEYS,
  SET_BOOK_COVER_READOUT_KEYS,
  LIST_BOOK_COVERS_READOUT_KEYS,
  LIST_SEAL_COVERS_READOUT_KEYS
}
