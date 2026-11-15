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

/** `listBooks` 载荷**封闭恰 0 键**（管理员读；无分页 / 无筛选面）。 */
const BOOK_LIST_ALLOWED_KEYS = Object.freeze([])

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
  'first_publish_year',
  'created_at',
  'updated_at'
])

/** `createBook` 回包读数键面（`index.js` 按 op 收窄透传；`skipped` 存在性驱动）。 */
const CREATE_BOOK_READOUT_KEYS = Object.freeze(['book_id', 'skipped'])

/** `listBooks` 回包读数键面（`truncated` 为 **additive 提示键**：仅在「取不全」那一轮出现）。 */
const LIST_BOOKS_READOUT_KEYS = Object.freeze(['books', 'total', 'truncated'])

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
  /* ② 载荷封闭恰 0 键（空载荷 `{}`；给出任何键 ⇒ `INVALID_FIELD`）。 */
  const payloadDenial = ops.pointsPayloadDenial(payload, BOOK_LIST_ALLOWED_KEYS)
  if (payloadDenial) return payloadDenial
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
  /* ④ 回包（`index.js` 按 `LIST_BOOKS_READOUT_KEYS` 收窄透传）。
     **展示类**：允许截断，但**不得静默** ⇒ 到顶时多一个 additive 提示键 `truncated: true`
     （正常轮**不出现**该键 ⇒ 既有键面 `{ok, books, total}` 逐字不变）。 */
  const reply = { ok: true, books, total: books.length }
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

module.exports = {
  createBook,
  listBooks,
  setImageBook,
  BOOK_CREATE_ALLOWED_KEYS,
  BOOK_LIST_ALLOWED_KEYS,
  BOOK_SET_IMAGE_ALLOWED_KEYS,
  BOOK_ROW_KEYS,
  BOOK_ID_WIDTH,
  BOOK_ID_PATTERN,
  CREATE_BOOK_READOUT_KEYS,
  LIST_BOOKS_READOUT_KEYS,
  SET_IMAGE_BOOK_READOUT_KEYS
}
