/**
 * 玺爱 · **印譜（book）服务层**（裁定件 `docs/book-catalog-ruling-2026-11-14.md` §3 / §4）
 * ============================================================================
 * 本文件是前端**唯一**的印譜入口（视图与组件只经本服务，不直碰 `data/*`、不直调云函数）：
 *   · `createBook`   —— 建书（管理员）；载荷封闭 5 键，`book_id` 由**服务端发号**（五位纯数字）。
 *   · `listBooks`    —— 印譜清單（管理员读；按 `id` 升序）。
 *   · `setImageBook` —— 影像挂书 / 取消挂书（管理员；单值 `book_id`，`null` ＝ 取消）。
 *
 * 硬口径（逐条）：
 *   · **通道单点**：三个 op 一律经既有的登录令牌写面门 `userWriteGate`
 *     （＝ `services/userWrite.js` → `userToken.js::userGate` → 云函数 `xiai-user-token`），
 *     **不新建通道、不直连 SDK**。三个 op 都落在云函数的 `ADMIN_OPS`（管理员门在服务端**第一行**：
 *     手机号 ∈ `XIAI_ADMIN_PHONE` 白名单 / 平台会话角色 `admin`；缺 env ⇒ 结构化拒）。
 *   · **载荷键面逐字取服务端封闭面**（云函数 `lib/books.js::BOOK_*_ALLOWED_KEYS`）：
 *     `createBook` 恰 5 键 `name / isbn / cip / author_person_id / first_publish_year`；
 *     `listBooks` 恰 0 键（`{}`）；`setImageBook` 恰 2 键 `image_id / book_id`
 *     （`book_id` **必须显式出现**：`null` ＝ 取消归属，**缺键 ≠ 取消**）。
 *     身份类键（`uid` / `phone` / `created_by` …）一律**不递**（服务端拒 ⇒ `INVALID_FIELD`）。
 *   · **回包读数面**按 `readoutKeys` **additive 透传**声明取得（`token.js` 既有机制）：
 *     `createBook` → `book_id`（＋幂等轮 `skipped`）；`listBooks` → `books` / `total`；
 *     `setImageBook` → `image_id` / `book_id`。**服务端未回 ⇒ 本键缺席**（**不默认成 `[]` /
 *     `0` / `''`**、不编造假读数）。
 *   · **`setImageBook` 必读回比对**（硬口径，与 `seals.js::readBackCloudReplace` 同族）：
 *     服务端回的 `book_id` 是**读回值**，前端再按**云端快照**（必要时 `retryCloudBaseHydration()`
 *     重拉一轮）确认该影像行的 `book_id` **逐字等于**目标值；确认不到 ⇒ **如实回失败**
 *     （`STORAGE_UNAVAILABLE` ＋ 可读文案），**绝不以「回包 ok」冒充「已生效」**、不保留假状态。
 *   · **本机开发形态（`local-dev` / 離線）如实拒绝**：印譜行只存云端（`xiai_books` 不进客户端云读面），
 *     `book_id` 由**服务端发号**（禁随机 / 时间戳 / 客户端发号）⇒ 本机形态**没有**本地权威可写，
 *     三个 op 一律回结构化拒绝并说明原因（**不造假成功、不在本地另立第二套发号**）。
 *   · **普通用户零泄漏**：`book_id` 不进入任何普通用户可见的 DTO / 卡片；本服务的三个调用全部
 *     需要管理员令牌，非管理员在服务端被拒（`FORBIDDEN`）。
 * @module services/books
 */

import { userWriteGate } from './userWrite.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'
import { cloudBaseReadOf, cloudBaseStatus, retryCloudBaseHydration } from '../data/cloudbase.js'

/** 云函数 op 名（唯一字面值来源；视图 / 组件不得另写 op 名）。 */
export const BOOK_OP_CREATE = 'createBook'
export const BOOK_OP_LIST = 'listBooks'
export const BOOK_OP_SET_IMAGE = 'setImageBook'
/** 按需检索可挂影像（批量挂图面板唯一读面；2026-11-15）。 */
export const BOOK_OP_SEARCH_IMAGES = 'searchBookImages'

/** `book_id` 形态（与云函数 `lib/books.js::BOOK_ID_PATTERN` **同尺**：五位纯数字）。 */
export const BOOK_ID_PATTERN = /^\d{5}$/

/** 首次出版年份下限（与云函数同值：`1000`〜当年）。 */
export const BOOK_FIRST_YEAR_MIN = 1000

/** 书名 / ISBN / CIP 长度护栏（与云函数 `lib/books.js` 同值）。 */
export const BOOK_NAME_MAX_LENGTH = 200
export const BOOK_CODE_MAX_LENGTH = 64

/** 回包读数键面（**与云函数 `lib/books.js::*_READOUT_KEYS` 逐字同集**）。 */
const CREATE_BOOK_READOUT_KEYS = Object.freeze(['book_id', 'skipped'])
const LIST_BOOKS_READOUT_KEYS = Object.freeze(['books', 'total', 'has_more', 'offset', 'limit'])
const SET_IMAGE_BOOK_READOUT_KEYS = Object.freeze(['image_id', 'book_id'])

/** `listBooks` 单行投影键面（服务端 `BOOK_ROW_KEYS` 的客户端副本，供视图按同一键面取值）。 */
export const BOOK_ROW_KEYS = Object.freeze([
  'id',
  'name',
  'isbn',
  'cip',
  /* **2026-11-15**：【出版社】非必填（服务端同名键，行投影同步加一）。 */
  'publisher',
  'author_person_id',
  /* **2026-11-15（v1.120）**：`author_name` ＝ 服务端回的作者显示名快照 —— 本机印人快照
     缺失时（新设备 / 未水合会话）作者列仍能出真名，不误报「未收錄」。 */
  'author_name',
  /* **2026-11-15（v1.121）**：`creators` ＝ 创作者链（服務端權威；`[{person_id,card_id,role,name}]`） */
  'creators',
  /* **2026-11-15**：`image_count` ＝ 服务端计好的「该书已归属影像数」。 */
  'image_count',
  'first_publish_year',
  'created_at',
  'updated_at'
])

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

/** 失败面（恒**恰 3 键** `{ok:false, reason, message}` —— 与云函数 / 通道同形）。 */
function denial(reason, message) {
  return { ok: false, reason, message }
}

/**
 * **本机开发形态的统一拒绝**（印譜只存云端、`book_id` 只由服务端发号）。
 * @param {string} what 动作名（中文，进文案）
 */
function localDevDenial(what) {
  return denial(
    'STORAGE_UNAVAILABLE',
    `印譜資料只存於雲端（印譜編號由服務端發號）⇒ 本機開發形態不支援「${what}」；` +
      '請連雲端後重試；本次零寫入。'
  )
}

/** 是否本机开发 / 離線形态（无云端权威面）。 */
function isLocalDevMode() {
  return writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV
}

/** 当年（年份门上界；与云函数同取本机时钟的年份 —— 服务端仍是唯一判据）。 */
function currentYear() {
  return new Date().getFullYear()
}

/**
 * **建书（管理员）**。
 *
 * 判定顺序（本地只做**形态护栏**；值域与授权的唯一判据在服务端）：① 真源门（`local-dev` ⇒ 如实拒）
 * → ② `name` / `author_person_id` 必有 → ③ `first_publish_year` 形态门 → ④ 写面门
 * `userWriteGate('createBook', payload, {readoutKeys})` → ⑤ 取回包 `book_id`（缺 / 形态不符 ⇒
 * **如实失败**，不编造编号）。
 * @param {{name:string, author_person_id:string, isbn?:string|null, cip?:string|null,
 *          first_publish_year?:number|null}} input 表单值
 * @returns {Promise<{ok:true, book_id:string, skipped?:boolean, mode:string}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function createBook(input) {
  const source = input && typeof input === 'object' ? input : {}
  const name = text(source.name)
  const authorPersonId = text(source.author_person_id)
  if (!name) return denial('MISSING_REQUIRED', '請填寫書名（name）；本次零寫入。')
  if (!authorPersonId) {
    return denial('MISSING_REQUIRED', '請選擇作者（author_person_id，須為已收錄印人）；本次零寫入。')
  }
  if (name.length > BOOK_NAME_MAX_LENGTH) {
    return denial('INVALID_VALUE', `書名不得超過 ${BOOK_NAME_MAX_LENGTH} 字；本次零寫入。`)
  }
  const isbn = text(source.isbn)
  const cip = text(source.cip)
  /* 出版社：非必填；长度上界与书名同级（200），与编号类 64 分开判。 */
  const publisher = text(source.publisher)
  if (publisher.length > BOOK_NAME_MAX_LENGTH) {
    return denial('INVALID_VALUE', `出版社不得超過 ${BOOK_NAME_MAX_LENGTH} 字；本次零寫入。`)
  }
  for (const [key, value] of [
    ['isbn', isbn],
    ['cip', cip]
  ]) {
    if (value.length > BOOK_CODE_MAX_LENGTH) {
      return denial('INVALID_VALUE', `欄位（${key}）不得超過 ${BOOK_CODE_MAX_LENGTH} 字；本次零寫入。`)
    }
  }
  let firstPublishYear = null
  const rawYear = source.first_publish_year
  if (rawYear !== undefined && rawYear !== null && text(rawYear) !== '') {
    const parsed = typeof rawYear === 'number' ? rawYear : Number(text(rawYear))
    if (!Number.isInteger(parsed)) {
      return denial('INVALID_VALUE', '首次出版年份必須是整數（可留空）；本次零寫入。')
    }
    if (parsed < BOOK_FIRST_YEAR_MIN || parsed > currentYear()) {
      return denial(
        'INVALID_VALUE',
        `首次出版年份必須在 ${BOOK_FIRST_YEAR_MIN}〜${currentYear()} 之間；本次零寫入。`
      )
    }
    firstPublishYear = parsed
  }
  if (isLocalDevMode()) return localDevDenial('新建印譜')
  /* **载荷封闭恰 6 键**（逐字取服务端 `BOOK_CREATE_ALLOWED_KEYS`；身份类键一律不递）。 */
  const payload = {
    name,
    isbn,
    cip,
    publisher,
    author_person_id: authorPersonId,
    first_publish_year: firstPublishYear
  }
  const gate = await userWriteGate(BOOK_OP_CREATE, payload, { readoutKeys: CREATE_BOOK_READOUT_KEYS })
  if (!gate.ok) return denial(gate.reason, gate.message)
  const bookId = text(gate.book_id)
  if (!BOOK_ID_PATTERN.test(bookId)) {
    /* 服务端已成功写入（`ok:true`）但未回可用编号 ⇒ **如实失败**（不编造、不假定成功）。 */
    return denial(
      'STORAGE_UNAVAILABLE',
      '雲端已受理建書，但未回傳可辨識的印譜編號（book_id）；請重新整理後在清單中確認（以服務端為準）。'
    )
  }
  return { ok: true, book_id: bookId, skipped: gate.skipped === true, mode: gate.mode }
}

/** `listBooks` 默认每页行数（与服务端 `BOOK_LIST_DEFAULT_LIMIT` 同值）。 */
export const BOOK_LIST_PAGE_SIZE = 50

/** `listBooks` 每页上限（与服务端 `BOOK_LIST_MAX_LIMIT` 同值）。 */
export const BOOK_LIST_MAX_PAGE_SIZE = 200

/**
 * **印譜清單（管理员读；分頁 ＋ 篩選）**。
 *
 * 载荷封闭 6 键（缺键由服务端取默认；客户端**只递非空键**，不递 `undefined`）：
 * `offset` / `limit` / `q` / `author` / `year_from` / `year_to`。
 * @param {{offset?:number, limit?:number, q?:string, author?:string,
 *          year_from?:number|null, year_to?:number|null}} [input]
 * @returns {Promise<{ok:true, books:Array<object>, total:number, hasMore:boolean,
 *            offset:number, limit:number, truncated:boolean, mode:string}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function listBooks(input = {}) {
  if (isLocalDevMode()) return localDevDenial('讀取印譜清單')
  const source = input && typeof input === 'object' ? input : {}
  const payload = {}
  const offset = Number(source.offset)
  payload.offset = Number.isInteger(offset) && offset >= 0 ? offset : 0
  const limit = Number(source.limit)
  payload.limit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, BOOK_LIST_MAX_PAGE_SIZE)
    : BOOK_LIST_PAGE_SIZE
  for (const key of ['q', 'author']) {
    const value = text(source[key])
    if (value !== '') payload[key] = value
  }
  for (const key of ['year_from', 'year_to']) {
    /* **空值不递**：`Number('') === 0` 且 `Number.isInteger(0)` 为真 —— 直接判整会
       把「未填年份」误发成 `year_from: 0`，被服务端形态门拒（实测首屏直接读失败）。 */
    const raw = source[key]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const value = Number(raw)
    if (Number.isInteger(value)) payload[key] = value
  }
  const gate = await userWriteGate(BOOK_OP_LIST, payload, { readoutKeys: LIST_BOOKS_READOUT_KEYS })
  if (!gate.ok) return denial(gate.reason, gate.message)
  if (!Array.isArray(gate.books)) {
    /* 服务端未回行面 ⇒ **如实失败**（不默认成 `[]` 冒充「一本書都沒有」）。 */
    return denial(
      'STORAGE_UNAVAILABLE',
      '雲端已受理讀取，但未回傳印譜清單（books）；請稍後重試（以服務端為準）。'
    )
  }
  const books = gate.books.map((row) => {
    const src = row && typeof row === 'object' ? row : {}
    const out = {}
    for (const key of BOOK_ROW_KEYS) {
      if (key === 'first_publish_year') {
        out[key] = Number.isInteger(src.first_publish_year) ? src.first_publish_year : null
        continue
      }
      if (key === 'image_count') {
        out[key] = Number.isInteger(src.image_count) ? src.image_count : 0
        continue
      }
      if (key === 'creators') {
        /* 创作者链：只取四鍵、字串化；非陣列 ⇒ `[]`（视图据空集不渲染链行）。 */
        out[key] = (Array.isArray(src.creators) ? src.creators : [])
          .map((item) => (item && typeof item === 'object'
            ? { person_id: text(item.person_id), card_id: text(item.card_id), role: text(item.role), name: text(item.name) }
            : null))
          .filter((item) => item !== null)
        continue
      }
      out[key] = text(src[key])
    }
    return out
  })
  const total = Number.isInteger(gate.total) ? gate.total : books.length
  const appliedOffset = Number.isInteger(gate.offset) ? gate.offset : payload.offset
  const appliedLimit = Number.isInteger(gate.limit) ? gate.limit : payload.limit
  return {
    ok: true,
    books,
    total,
    hasMore: gate.has_more === true,
    offset: appliedOffset,
    limit: appliedLimit,
    truncated: gate.truncated === true,
    mode: gate.mode
  }
}

/**
 * **按需检索可挂影像（管理员）** —— 「批量挂图」面板的唯一读面。
 *
 * 为什么：旧面板把全部印章/影像装配进浏览器（6,445 张）⇒ 页面卡顿；
 * 现在只在**输入关键词后**才查（服务端按印文 / 章号 / 序号匹配，简繁双形态）。
 *
 * @param {{q:string, limit?:number}} input `q` 必填；`limit` 1〜100（默认服务端 24）
 * @returns {Promise<{ok:true, rows:Array<{image_id:string,stamp_id:string,seal_name:string,
 *            kind:string,book_id:string}>, total:number, mode:string}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function searchBookImages(input = {}) {
  if (isLocalDevMode()) return localDevDenial('檢索可掛影像')
  const source = input && typeof input === 'object' ? input : {}
  const q = text(source.q)
  if (q === '') return denial('MISSING_REQUIRED', '請輸入檢索關鍵詞（印文 / 章號 / 序號）；本次零讀取。')
  if (q.length > 60) return denial('INVALID_VALUE', '關鍵詞不得超過 60 字；本次零讀取。')
  const payload = { q }
  const limit = Number(source.limit)
  if (Number.isInteger(limit) && limit > 0) payload.limit = Math.min(limit, 100)
  const gate = await userWriteGate(BOOK_OP_SEARCH_IMAGES, payload, { readoutKeys: ['rows', 'total'] })
  if (!gate.ok) return denial(gate.reason, gate.message)
  if (!Array.isArray(gate.rows)) {
    return denial('STORAGE_UNAVAILABLE', '雲端已受理檢索，但未回傳影像清單（rows）；請稍後重試。')
  }
  const rows = gate.rows.map((row) => {
    const src = row && typeof row === 'object' ? row : {}
    const out = {}
    for (const key of BOOK_IMAGE_ROW_KEYS) out[key] = text(src[key])
    return out
  })
  return { ok: true, rows, total: Number.isInteger(gate.total) ? gate.total : rows.length, mode: gate.mode }
}

/**
 * **影像挂书 / 取消挂书（管理员）**：单值 `book_id`；写后**读回比对**。
 *
 * 判定顺序：① 真源门（`local-dev` ⇒ 如实拒）→ ② `image_id` 必有、`book_id` 形态门
 * （`null` ＝ 取消；非 `null` 必须五位纯数字）→ ③ 写面门 `userWriteGate('setImageBook', …)`
 * → ④ **读回比对**（云端快照，必要时重拉一轮；`book_id` 必须与目标值逐字相等，否则**如实失败**）。
 * @param {string} imageId 影像编号（`xiai_images.id`）
 * @param {string|null} bookId 目标印譜編號（`null` ＝ 取消归属）
 * @returns {Promise<{ok:true, image_id:string, book_id:string|null, mode:string, refreshed:boolean}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function setImageBook(imageId, bookId) {
  /* **两形态兼容（单点，本批修接线错配）**：调用面统一用对象形
     `setImageBook({ image_id, book_id })`（与裁定件载荷键面同形）；
     内部与历史调用仍可用位置形 `(imageId, bookId)`。两形都在此归一，**不另开第二套函数**。 */
  if (imageId && typeof imageId === 'object') {
    bookId = imageId.book_id
    imageId = imageId.image_id
  }
  const id = text(imageId)
  if (!id) return denial('MISSING_REQUIRED', '缺少影像編號（image_id）；本次零寫入。')
  const rawBookId = bookId === undefined ? null : bookId
  let targetBookId = null
  if (rawBookId !== null) {
    const candidate = text(rawBookId)
    if (!BOOK_ID_PATTERN.test(candidate)) {
      return denial('INVALID_VALUE', '印譜編號必須是五位純數字（如 00001）；本次零寫入。')
    }
    targetBookId = candidate
  }
  if (isLocalDevMode()) return localDevDenial('影像掛書')
  /* **载荷封闭恰 2 键**（`book_id` 显式出现：`null` ＝ 取消归属）。 */
  const gate = await userWriteGate(
    BOOK_OP_SET_IMAGE,
    { image_id: id, book_id: targetBookId },
    { readoutKeys: SET_IMAGE_BOOK_READOUT_KEYS }
  )
  if (!gate.ok) return denial(gate.reason, gate.message)
  /* ④ **读回比对**（硬口径）：先看当前云端快照；未见 / 不一致 ⇒ 走既有读口重拉一轮再看。 */
  const verified = await readBackImageBook(id, targetBookId)
  if (!verified.ok) {
    return denial(
      'STORAGE_UNAVAILABLE',
      verified.message
    )
  }
  return {
    ok: true,
    image_id: verified.imageId || id,
    book_id: verified.bookId,
    mode: gate.mode,
    refreshed: verified.refreshed
  }
}

/** 在云端快照里按影像编号取行（`id` / `_id` 两形态；快照未就绪 ⇒ `null`）。 */
function findCloudImageRow(imageId) {
  const cloud = cloudBaseReadOf('images')
  if (!Array.isArray(cloud.rows)) return null
  return (
    cloud.rows.find(
      (row) => row && (text(row.id) === imageId || text(row._id) === imageId)
    ) || null
  )
}

/** 影像行上的 `book_id`（空值归一为 `null`；与 `cloudbase.js::normalizeImageRow` 同尺）。 */
function imageBookIdOf(row) {
  const raw = text(row && row.book_id)
  return raw === '' ? null : raw
}

/**
 * **读回比对**（`setImageBook` 专用；**不以回包 `ok` / `updated >= 1` 判成功**）。
 *
 * 为什么必然可能要重拉：云端快照在**写入之前**就已拉取 ⇒ 刚在服务端改的 `book_id` 不在其中
 * （本机镜像在云模式下停写，**更不能**拿它充数）⇒ 命中不了时走既有读口
 * `retryCloudBaseHydration()` 重拉一輪，再读一次；仍确认不到 ⇒ **如实回失败**。
 * @param {string} imageId 影像编号
 * @param {string|null} expected 期望的 `book_id`（`null` ＝ 未归属）
 * @returns {Promise<{ok:true, imageId:string, bookId:string|null, refreshed:boolean}
 *                  |{ok:false, message:string}>}
 */
async function readBackImageBook(imageId, expected) {
  const direct = findCloudImageRow(imageId)
  if (direct && imageBookIdOf(direct) === expected) {
    return { ok: true, imageId: text(direct.id) || text(direct._id) || imageId, bookId: expected, refreshed: false }
  }
  let status = null
  try {
    status = await retryCloudBaseHydration()
  } catch (error) {
    return {
      ok: false,
      message:
        `掛書已送出，但讀回校驗失敗（image_id：${imageId}）；` +
        `歸屬以服務端為準，請稍後重新整理確認。（診斷：${(error && error.message) || 'unknown'}）`
    }
  }
  const fresh = findCloudImageRow(imageId)
  const actual = imageBookIdOf(fresh)
  if (fresh && actual === expected) {
    return { ok: true, imageId: text(fresh.id) || text(fresh._id) || imageId, bookId: expected, refreshed: true }
  }
  const state = (status && typeof status.state === 'string' && status.state) || (cloudBaseStatus() || {}).state || 'unknown'
  return {
    ok: false,
    message:
      `掛書已送出，但讀回不一致（image_id：${imageId}；期望 ${
        expected === null ? '未歸屬' : expected
      }、讀回 ${fresh ? (actual === null ? '未歸屬' : actual) : '未見該影像行'}）` +
      `⇒ 不報成功，請稍後重新整理確認（雲端快照狀態：${state}；歸屬以服務端為準）。`
  }
}

/**
 * **影像当前归属（只读，供视图/下拉取现值）**：从云端快照读该影像行的 `book_id`。
 * 快照未就绪 / 未见该行 ⇒ `{ok:false}`（**不猜**）；**仅供管理员面使用**。
 * @param {string} imageId 影像编号
 * @returns {{ok:true, book_id:string|null}|{ok:false, reason:string, message:string}}
 */
export function imageBookOf(imageId) {
  const id = text(imageId)
  if (!id) return denial('MISSING_REQUIRED', '缺少影像編號（image_id）。')
  const cloud = cloudBaseReadOf('images')
  if (!Array.isArray(cloud.rows)) {
    return denial('STORAGE_UNAVAILABLE', '雲端快照尚未就緒，暫時無法讀取影像歸屬；請稍後重試。')
  }
  const row = findCloudImageRow(id)
  if (!row) return denial('NOT_FOUND', `雲端快照中未見該影像（image_id：${id}）。`)
  return { ok: true, book_id: imageBookIdOf(row) }
}
