/**
 * 玺爱 · 出版社（publisher）服务层（xiai.spec §3.107 / §4.1.22 / §10.115）
 * ============================================================================
 * 本文件是前端**唯一**的出版社入口（视图与组件只经本服务，不直碰 `data/*`、不直调云函数）：
 *   · `listPublishers`   —— 名录（只读；按 `code` 升序）。
 *   · `publisherById`    —— 按 `_id` / `code` 取行（**同一性只认 id / code，不认名字**）。
 *   · `publisherLabel`   —— 上屏标签 ＝ `name_cht || name` ＋ 号段（单点派生，页面不另写一套）。
 *   · `lookupByIsbn`     —— ISBN 反查（§3.107.4 唯一口径：三段组合**最长匹配**、**命中唯一**才返回）。
 *   · `putPublisher`     —— 新建 / 改行（**仅管理员**；新行 `_id = code` **由号段账本发**，
 *     **发号在服务端 `putPublisher` 内完成、随 `row` 回包**；op 名 ＝ `putPublisher`；
 *     `upsertPublisher` ＝ **同函数兼容别名**，不是第二个入口）。
 *   · `addIsbnCode` / `removeIsbnCode` —— 号段表增删（仅管理员；同走 `putPublisher` 单点）。
 *
 * 硬口径（逐条，照 §3.107，不得放宽）：
 *   · **键面封闭 14 业务键 ＋ `_id`**（§3.107.2 冻结表）：多一键 / 少一键 / 改键名 ⇒ `INVALID_VALUE`
 *     ＋ **零写入**；**不得**加 `display_name` / `isbn_full` 一类派生键（`publisherLabel` 派生不落盘）。
 *   · **`_id = code` 恒等**、形态 `^PB[0-9]{9}$`；**新行号只由号段账本发**（`kind=publisher`、
 *     **单次 ≤ 64**）⇒ **载荷自带 `code` 一律不采信**（`INVALID_VALUE` ＋零写入，AC-943）。
 *   · **值域封闭**：`org_type` 恆三值缺省 `publisher`、`isbn_prefix` 恆两值缺省 `978`、
 *     `isbn_publisher_codes[]` 元素封闭三键且 `status` 恆 `current` / `legacy`；
 *     第 4 值 ⇒ `INVALID_VALUE` ＋ **零写入**（AC-942）。
 *   · **`name_cht` 缺则 ＝ `name`**（读侧回落，缺键不判负）；`region` / `founded_year` / `note`
 *     可空、**禁特值**（`0` / `-1` / `""` ⇒ `INVALID_VALUE`）。
 *   · **判权只一处**：`data/session.js` 的 `isAdmin`（与全站同一取法；**本文件不自造第二套 role 判定**）。
 *   · **reason 只用既有冻结字面值**（`FORBIDDEN` / `MISSING_REQUIRED` / `INVALID_VALUE` /
 *     `NOT_FOUND` / `DUPLICATE_VALUE` / `STORAGE_UNAVAILABLE`）—— **零新增 reason**。
 *   · **写面形态照 `writeFaceMode()` 单点**：`local-dev` ⇒ 本机镜像 `xiai:v1:publishers`
 *     （**非正式写入路径**；**只受理改行** —— 本机形态没有云端号段账本 ⇒ 新建结构化拒，
 *     **不在客户端自造号**）；`cloud` ⇒ 只认服务端回包（经既有登录令牌写面门 `userWriteGate`，
 *     **不新建通道**）。
 *
 * **如实登记（不得据本文件声称「已实现 / 已上線」）**：**服务层 op 名已对齐为 `putPublisher`**
 * （`PUBLISHER_OP_PUT`，与 cloudfunctions 侧 `putPublisher` 逐字同值；服务层函数同名
 * `putPublisher`，`upsertPublisher` ＝ **同函数兼容别名**，不是第二个入口）。**全工程只此一个
 * 落盘 op 名**：`issuePublisherCodes` 是**服务端内部函数、不是 op**（云函数 `index.js` 的成功回包
 * 只透传 `row` ⇒ 号必须随 `row` 回）⇒ **客户端零预领号路径**（本文件不发第二个 op 名、
 * 不在客户端自造 `PB*` 号）；新建轮只发 `putPublisher`（**载荷不带 `code` / `_id`**），
 * 号由服务端号段账本发、随 `reply.row` 落回本机镜像。服务端 op 已入册
 * （`ADMIN_OPS` 52 → 53）；**其部署态以 `cloudfunctions/` 单负责**（本单红线：不碰
 * `cloudfunctions/`）⇒ 云端形态下任何拒绝仍由服务端回、`userWriteGate` **原样透传**，
 * **不伪装成功、不先写本机再称成功**。
 *
 * @module services/publishers
 */

import { isAdmin } from '../data/session.js'
import { listPublisherRows, savePublisherRows } from '../data/db.js'
import { userWriteGate } from './userWrite.js'
import { writeFaceMode, WRITE_FACE_MODES } from '../data/writeFaceMode.js'

/** 本机镜像集合键（真实键名 `xiai:v1:publishers`；代际登记 ＝ `data/storage.js::STORAGE_KEYS`）。 */
export const PUBLISHER_COLLECTION_KEY = 'publishers'

/** `_id = code` 形态（与 §3.107.1 同尺：`PB` ＋ 恰 9 位零填充数字）。 */
export const PUBLISHER_ID_PATTERN = /^PB[0-9]{9}$/

/** `org_type` 封闭三值（缺键按 `publisher` 读；`society` / `unknown` 永不参与 ISBN 反查）。 */
export const PUBLISHER_ORG_TYPES = Object.freeze(['publisher', 'society', 'unknown'])

/** `isbn_prefix` 封闭两值（缺省 `978`；**不得**自造第三种前缀）。 */
export const PUBLISHER_ISBN_PREFIXES = Object.freeze(['978', '979'])

/** `isbn_publisher_codes[].status` 恆两值。 */
export const PUBLISHER_ISBN_CODE_STATUS = Object.freeze(['current', 'legacy'])

/** 号段账本**单次领号上限**（§3.107.3：`kind=publisher`、单次 ≤ 64）。 */
export const PUBLISHER_ISSUE_MAX = 64

/** `name` / `name_cht` 长度上界（§3.107.2：1..200）。 */
export const PUBLISHER_NAME_MAX = 200

/** 云函数 op 名（**唯一字面值来源**；视图 / 组件不得另写 op 名）。
 *  `PUBLISHER_OP_PUT` ＝ **本单对齐后的落盘 op 名 `putPublisher`**（与 cloudfunctions 侧
 *  `putPublisher` 逐字同值；服务层函数同名 `putPublisher`）。
 *  `PUBLISHER_OP_UPSERT` ＝ **兼容别名（同值）** —— 旧引用面一字不改也能拿到同一个 op 名，
 *  **不是第二个 op**（全工程只此一个落盘 op 名）。
 *  **零第二个 op**：`issuePublisherCodes` 是服务端内部函数、**不是 op**（客户端发号只能靠
 *  `putPublisher` 新建时由服务端发、随 `row` 回包）⇒ 本文件**没有** `PUBLISHER_OP_ISSUE`。 */
export const PUBLISHER_OP_PUT = 'putPublisher'
export const PUBLISHER_OP_UPSERT = PUBLISHER_OP_PUT

/** 14 業務鍵（逐字 §3.107.2 冻结表；`_id` 不在内，但与 `code` 恒等）。 */
export const PUBLISHER_BUSINESS_KEYS = Object.freeze([
  'code',
  'name',
  'name_cht',
  'isbn_prefix',
  'isbn_group',
  'isbn_publisher_codes',
  'aliases',
  'region',
  'founded_year',
  'note',
  'created_at',
  'created_by',
  'updated_at',
  'org_type'
])

/* --------------------------------------------------------------------------- 小工具 */

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function nowIso() {
  return new Date().toISOString()
}

function deny(reason, message) {
  return { ok: false, reason, message }
}

function accept(extra) {
  return Object.assign({ ok: true }, extra || {})
}

/** 管理员门（**判权单点 ＝ `session.js::isAdmin`**；不自造第二套 role 判定）。 */
function adminDenial() {
  if (isAdmin.value) return null
  return deny('FORBIDDEN', '僅管理員可以新增 / 修改出版社；本次零寫入。')
}

function sameId(row, id) {
  return text(row && (row._id || row.code)) === id
}

/* --------------------------------------------------------------------------- 归一 / 值域门 */

/** 字符串数组归一（数组 / 逗号顿号串皆可；去空保序；非数组非串 ⇒ `[]`）。 */
function toAliases(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter((item) => item !== '')
  if (typeof value === 'string') return value.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean)
  return []
}

/** `founded_year` 归一：`null` / `''` ⇒ `null`；**特值 `0` / `-1` / 非整数 ⇒ 拒**。 */
function toFoundedYear(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null }
  const num = Number(value)
  if (!Number.isInteger(num) || num <= 0 || num > 9999) {
    return {
      ok: false,
      denial: deny('INVALID_VALUE', 'founded_year 必須是 1〜9999 的整數或 null（0 / -1 / 空串判負）；本次零寫入。')
    }
  }
  return { ok: true, value: num }
}

/** 可空串（`region` / `note`）：空 ⇒ `null`。 */
function toNullableText(value) {
  const out = text(value)
  return out === '' ? null : out
}

/**
 * `isbn_publisher_codes` 归一（元素**封闭三键** `code` / `status` / `note?`；`status` 恆两值）。
 * 第 4 个子键 / 第 3 个 `status` 值 ⇒ `INVALID_VALUE` ＋ **零写入**（AC-942）。
 */
function toIsbnCodes(value) {
  if (value === null || value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return { ok: false, denial: deny('INVALID_VALUE', 'isbn_publisher_codes 必須是數組；本次零寫入。') }
  }
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, denial: deny('INVALID_VALUE', 'isbn_publisher_codes 元素必須是對象；本次零寫入。') }
    }
    const keys = Object.keys(item)
    for (const key of keys) {
      if (key !== 'code' && key !== 'status' && key !== 'note') {
        return { ok: false, denial: deny('INVALID_VALUE', `isbn_publisher_codes 元素只封閉三鍵（code / status / note），多出「${key}」；本次零寫入。`) }
      }
    }
    const code = text(item.code)
    if (code === '') return { ok: false, denial: deny('INVALID_VALUE', 'isbn_publisher_codes[].code 不可為空；本次零寫入。') }
    if (code.length > 32) return { ok: false, denial: deny('INVALID_VALUE', 'isbn_publisher_codes[].code 過長（≤32）；本次零寫入。') }
    const status = text(item.status)
    if (PUBLISHER_ISBN_CODE_STATUS.indexOf(status) === -1) {
      return { ok: false, denial: deny('INVALID_VALUE', 'isbn_publisher_codes[].status 只能是 current / legacy；本次零寫入。') }
    }
    if (seen.has(code)) return { ok: false, denial: deny('DUPLICATE_VALUE', `出版者代號「${code}」重複；本次零寫入。`) }
    seen.add(code)
    const row = { code, status }
    const note = text(item.note)
    if (note !== '') row.note = note
    out.push(row)
  }
  return { ok: true, value: out }
}

/**
 * 业务载荷归一 ＋ **14 鍵值域门**（不含 `code` / `created_*` —— 那三组由 `putPublisher` 按
 * 「新建 / 改行」分支落位）。任何一项越界 ⇒ 返回结构化拒绝（调用方零写入）。
 * @returns {{ok:true, value:object}|{ok:false, reason:string, message:string}}
 */
function normalizeBusiness(raw) {
  const name = text(raw.name)
  if (name === '') return deny('MISSING_REQUIRED', 'name（簡體規範名）必填；本次零寫入。')
  if (name.length > PUBLISHER_NAME_MAX) return deny('INVALID_VALUE', `name 過長（≤${PUBLISHER_NAME_MAX}）；本次零寫入。`)

  const nameCht = text(raw.name_cht)
  if (nameCht.length > PUBLISHER_NAME_MAX) return deny('INVALID_VALUE', `name_cht 過長（≤${PUBLISHER_NAME_MAX}）；本次零寫入。`)

  const orgType = raw.org_type === undefined || raw.org_type === null || text(raw.org_type) === ''
    ? 'publisher'
    : text(raw.org_type)
  if (PUBLISHER_ORG_TYPES.indexOf(orgType) === -1) {
    return deny('INVALID_VALUE', 'org_type 只能是 publisher / society / unknown（缺省 publisher）；本次零寫入。')
  }

  const isbnPrefixRaw = raw.isbn_prefix === undefined || raw.isbn_prefix === null || text(raw.isbn_prefix) === ''
    ? '978'
    : text(raw.isbn_prefix)
  if (PUBLISHER_ISBN_PREFIXES.indexOf(isbnPrefixRaw) === -1) {
    return deny('INVALID_VALUE', 'isbn_prefix 只能是 978 / 979（缺省 978）；本次零寫入。')
  }

  /* `isbn_group`：组区号（中国大陆 ＝ `7`）。空值按播种面同值缺省 `7`；上界 8 位（够任何组区号）。 */
  const isbnGroupRaw = text(raw.isbn_group)
  if (isbnGroupRaw.length > 8) return deny('INVALID_VALUE', 'isbn_group 過長（≤8）；本次零寫入。')
  const isbnGroup = isbnGroupRaw === '' ? '7' : isbnGroupRaw

  const codes = toIsbnCodes(raw.isbn_publisher_codes)
  if (!codes.ok) return codes.denial

  const founded = toFoundedYear(raw.founded_year)
  if (!founded.ok) return founded.denial

  return accept({
    value: {
      name,
      name_cht: nameCht === '' ? null : nameCht,
      isbn_prefix: isbnPrefixRaw,
      isbn_group: isbnGroup,
      isbn_publisher_codes: codes.value,
      aliases: toAliases(raw.aliases),
      region: toNullableText(raw.region),
      founded_year: founded.value,
      note: toNullableText(raw.note),
      org_type: orgType
    }
  })
}

/* --------------------------------------------------------------------------- 写面（单点） */

/**
 * 载荷**封闭键面**取行（＝服务端 `PUBLISHER_ROW_KEYS`：14 業務鍵 ＋ `_id`，与本文件
 * `PUBLISHER_BUSINESS_KEYS` ＋ `_id` 同集）。递服务端的行**只取这 15 键** —— 本机镜像里若有
 * 杂键（种子 / 历史行）一并剔掉，**不给服务端 `INVALID_FIELD` 的机会**。
 * @param {object} row 拟递出的行
 * @returns {object} 只含封闭键面的行
 */
function pickRowKeys(row) {
  const out = {}
  if (row && typeof row === 'object') {
    PUBLISHER_BUSINESS_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key]
    })
  }
  const id = text(row && row._id) || text(row && row.code)
  if (id !== '') {
    out._id = id
    out.code = text(row && row.code) || id
  }
  return out
}

/**
 * 落盘（**唯一写点**）：`local-dev` ⇒ 本机镜像（**只受理改行**；新建无云端号段账本 ⇒ 前置
 * 结构化拒，**绝不在客户端自造 `PB*` 号**）；`cloud` ⇒ **只认服务端回包**
 * （`userWriteGate(PUBLISHER_OP_PUT, {publisher: 行})`）。云端拒绝 ⇒ **原样透传 ＋ 零写入**
 * （绝不先写本机再谎称成功）。
 *
 * **新建轮载荷不带 `code` / `_id`** —— 号由服务端 `putPublisher` 内部号段账本
 * （`issuePublisherCodes(1)`，**服务端内部函数、非 op**）发，**随 `reply.row` 回包** ⇒ 镜像
 * 收的是服务端那一行（含服务端盖章的 `created_*` / `updated_at`），**不自造第二套号 / 时间**。
 * @param {object} args
 * @param {Array<object>} args.rows 写入前的全量行集（本机镜像整键覆盖）
 * @param {object|null} args.existing 改行命中的既有行（`null` ＝ 新建）
 * @param {string} args.requested 改行的 `_id = code`
 * @param {object} args.business 归一后的 10 业务键
 * @param {string} args.at 本次时间戳（`local-dev` 改行用；云端由服务端盖章）
 * @returns {Promise<{ok:true, row:object, created:boolean, changed:boolean}|{ok:false, reason:string, message:string}>}
 */
async function persistPublisherPut({ rows, existing, requested, business, at }) {
  const creating = !existing
  if (writeFaceMode() === WRITE_FACE_MODES.LOCAL_DEV) {
    if (creating) {
      return deny(
        'STORAGE_UNAVAILABLE',
        '本機（dev / 離線）形態沒有雲端號段賬本（kind=publisher）⇒ 不在客戶端自造 `PB*` 號；' +
          '請在雲端寫入面下新建出版社；本次零寫入。'
      )
    }
    const row = Object.assign({}, existing, business, { _id: requested, code: requested, updated_at: at })
    savePublisherRows(rows.map((item) => (sameId(item, requested) ? row : item)))
    return accept({ row, created: false, changed: true })
  }
  const sent = creating ? business : pickRowKeys(Object.assign({}, existing, business, { _id: requested, code: requested, updated_at: at }))
  const reply = await userWriteGate(PUBLISHER_OP_PUT, { publisher: sent })
  if (!reply || reply.ok !== true) {
    return reply || deny('STORAGE_UNAVAILABLE', '出版社寫入失敗；本次零寫入。')
  }
  const serverRow = reply.row && typeof reply.row === 'object' ? reply.row : null
  if (!serverRow) {
    /* 服务端已回 `ok:true` 却缺 `row` ⇒ **不写镜像、也不谎称行已落**（号只随 `row` 回）。 */
    return deny('STORAGE_UNAVAILABLE', 'putPublisher 回包缺 `row`（號只隨 row 回）⇒ 本機鏡像未更新；請刷新讀面後再核對。')
  }
  const next = existing
    ? rows.map((item) => (sameId(item, requested) ? serverRow : item))
    : rows.concat([serverRow])
  savePublisherRows(next)
  return accept({ row: serverRow, created: creating, changed: true })
}

/* --------------------------------------------------------------------------- 读面 */

/** 名录（按 `code` 升序；只读）。 */
export function listPublishers() {
  return listPublisherRows()
    .slice()
    .sort((a, b) => text(a && (a._id || a.code)).localeCompare(text(b && (b._id || b.code))))
}

/** 按 `_id` / `code` 取行（**同一性只认 id / code**；未命中 ⇒ `null`）。 */
export function publisherById(id) {
  const key = text(id)
  if (!key) return null
  return listPublisherRows().find((row) => sameId(row, key)) || null
}

/**
 * 上屏标签（**单点派生、不落盘**）：`name_cht || name` ＋ 号段（`isbn_publisher_codes[].code`）。
 * 页面 / 组件不得另写第二套拼法。
 * @param {object|null} row 出版社行
 * @returns {string}
 */
export function publisherLabel(row) {
  if (!row || typeof row !== 'object') return ''
  const name = text(row.name_cht) || text(row.name)
  const codes = Array.isArray(row.isbn_publisher_codes) ? row.isbn_publisher_codes : []
  const segments = codes.map((item) => text(item && item.code)).filter((item) => item !== '')
  return segments.length > 0 ? `${name}（${segments.join('／')}）` : name
}

/** 搜索（`name` / `name_cht` / `aliases` / 号段 / `code` 子串；简繁不做第二套归一，原样小写比对）。 */
export function searchPublishers(query) {
  const rows = listPublishers()
  const q = text(query).toLowerCase()
  if (q === '') return rows
  return rows.filter((row) => {
    const hay = [
      text(row.code),
      text(row.name),
      text(row.name_cht),
      ...(Array.isArray(row.aliases) ? row.aliases.map((item) => text(item)) : []),
      ...(Array.isArray(row.isbn_publisher_codes) ? row.isbn_publisher_codes.map((item) => text(item && item.code)) : [])
    ]
      .join(' ')
      .toLowerCase()
    return hay.indexOf(q) !== -1
  })
}

/**
 * **ISBN 反查（§3.107.4 唯一口径，两侧同用）**。
 *   · 输入 ＝ 一个 ISBN（**去连字符 / 空格**）；
 *   · 候选集 ＝ **只对 `org_type='publisher'` 且 `isbn_publisher_codes` 非空的行**；
 *     `society` / `unknown` 行**永不参与**（即使其代号非空）；
 *   · 取段 ＝ `isbn_prefix`（前 3 位）＋ `isbn_group` ＋ `isbn_publisher_codes[].code`，
 *     三段组合**最长匹配**；**命中唯一才返回**；
 *   · 0 命中 / 多于 1 命中 ⇒ **返回原因、不返回任何行**（不猜、不模糊、不按名字回落）。
 * @param {string} isbn
 * @returns {{ok:true, publisher:object, matched:string}|{ok:false, reason:string, message:string}}
 */
export function lookupByIsbn(isbn) {
  const digits = text(isbn).replace(/[-\s]/g, '').toUpperCase()
  if (!/^[0-9X]{10,17}$/.test(digits)) {
    return deny('INVALID_VALUE', 'ISBN 形態不合法（去連字符後應為 10〜17 位數字）；本次未返回任何出版社。')
  }
  const candidates = listPublishers().filter((row) => {
    const orgType = text(row.org_type) || 'publisher'
    if (orgType !== 'publisher') return false
    return Array.isArray(row.isbn_publisher_codes) && row.isbn_publisher_codes.length > 0
  })
  const hits = []
  candidates.forEach((row) => {
    const prefix = text(row.isbn_prefix) || '978'
    const group = text(row.isbn_group)
    row.isbn_publisher_codes.forEach((item) => {
      const segment = `${prefix}${group}${text(item && item.code)}`
      if (segment !== '' && digits.startsWith(segment)) hits.push({ row, segment })
    })
  })
  if (hits.length === 0) {
    return deny('NOT_FOUND', 'ISBN 反查 0 命中（最長匹配無候選）；未命中不返回任何猜測值。')
  }
  const longest = hits.reduce((max, hit) => Math.max(max, hit.segment.length), 0)
  const winners = []
  hits.forEach((hit) => {
    if (hit.segment.length !== longest) return
    if (!winners.some((item) => sameId(item.row, text(hit.row._id || hit.row.code)))) winners.push(hit)
  })
  if (winners.length > 1) {
    return deny('DUPLICATE_VALUE', 'ISBN 反查多命中（最長匹配不唯一）；不任取其一，本次未返回任何出版社。')
  }
  return accept({ publisher: winners[0].row, matched: winners[0].segment })
}

/* --------------------------------------------------------------------------- 写面 */

/**
 * 新建 / 改行（**仅管理员**；**服务层主名**，op 名 ＝ `putPublisher`）。
 *   · **改行**：`code` 必须命中既有行（同一性只认 id / code）；载荷里的 `code` 形态不合 ⇒ 拒；
 *   · **新建**：`code` **不得**自带 —— **号只由服务端 `putPublisher` 内部号段账本发**、
 *     **随 `reply.row` 回包**（载荷自带 `code` ⇒ `INVALID_VALUE` ＋零写入，AC-943）；
 *     **本文件零预领号路径**（`issuePublisherCodes` 是服务端内部函数、不是 op，客户端不发它）；
 *   · **同值重写零写**：业务键与既有行逐字相同 ⇒ `changed:false`、`updated_at` 不动；
 *   · 任何值域越界 ⇒ 结构化拒绝 ＋ **零写入**（AC-942）。
 * @param {object} payload 业务载荷（14 鍵中的可写子集；**新建不带 `code`**）
 * @returns {Promise<{ok:true, row:object, created:boolean, changed:boolean, message:string}|{ok:false, reason:string, message:string}>}
 */
export async function putPublisher(payload) {
  const gate = adminDenial()
  if (gate) return gate
  const raw = payload && typeof payload === 'object' ? payload : {}

  const requested = text(raw.code) || text(raw._id)
  if (requested !== '' && !PUBLISHER_ID_PATTERN.test(requested)) {
    return deny('INVALID_VALUE', 'code 形態必須是 PB+9 位（^PB[0-9]{9}$）；本次零寫入。')
  }

  const rows = listPublisherRows()
  const existing = requested === '' ? null : rows.find((row) => sameId(row, requested)) || null
  if (requested !== '' && !existing) {
    return deny(
      'INVALID_VALUE',
      '新行的 `_id = code` 只由號段賬本發（kind=publisher、單次 ≤64）；載荷自帶 code 不採信；本次零寫入。'
    )
  }

  const normalized = normalizeBusiness(raw)
  if (normalized.ok !== true) return normalized
  const business = normalized.value

  if (existing) {
    const unchanged = Object.keys(business).every((key) => JSON.stringify(existing[key]) === JSON.stringify(business[key]))
    if (unchanged) {
      return accept({ row: existing, created: false, changed: false, message: '內容未變，零寫入。' })
    }
  }

  const saved = await persistPublisherPut({
    rows,
    existing,
    requested,
    business,
    at: nowIso()
  })
  if (saved.ok !== true) return saved
  const row = saved.row
  const code = text(row && (row._id || row.code))
  return accept({
    row,
    created: saved.created === true,
    changed: true,
    message: saved.created
      ? `已新建出版社「${publisherLabel(row)}」（${code}）。`
      : `已更新出版社「${publisherLabel(row)}」。`
  })
}

/** **兼容别名（同函数，非第二个入口）**：旧引用面 `upsertPublisher` 一字不断。 */
export const upsertPublisher = putPublisher

/** 号段表**增**一条（仅管理员；同走 `putPublisher` 单点）。 */
export async function addIsbnCode(code, entry) {
  const gate = adminDenial()
  if (gate) return gate
  const row = publisherById(code)
  if (!row) return deny('NOT_FOUND', '出版社不存在；本次零寫入。')
  const current = Array.isArray(row.isbn_publisher_codes) ? row.isbn_publisher_codes.slice() : []
  const next = current.concat([entry && typeof entry === 'object' ? entry : {}])
  return putPublisher(Object.assign({}, row, { isbn_publisher_codes: next }))
}

/** 号段表**删**一条（仅管理员；同走 `putPublisher` 单点）。 */
export async function removeIsbnCode(code, publisherCode) {
  const gate = adminDenial()
  if (gate) return gate
  const row = publisherById(code)
  if (!row) return deny('NOT_FOUND', '出版社不存在；本次零寫入。')
  const target = text(publisherCode)
  const current = Array.isArray(row.isbn_publisher_codes) ? row.isbn_publisher_codes : []
  if (!current.some((item) => text(item && item.code) === target)) {
    return deny('NOT_FOUND', `出版者代號「${target}」不在該出版社號段表內；本次零寫入。`)
  }
  return putPublisher(
    Object.assign({}, row, {
      isbn_publisher_codes: current.filter((item) => text(item && item.code) !== target)
    })
  )
}

export default {
  PUBLISHER_COLLECTION_KEY,
  PUBLISHER_ID_PATTERN,
  PUBLISHER_ORG_TYPES,
  PUBLISHER_ISBN_PREFIXES,
  PUBLISHER_ISBN_CODE_STATUS,
  PUBLISHER_ISSUE_MAX,
  PUBLISHER_NAME_MAX,
  PUBLISHER_OP_PUT,
  PUBLISHER_OP_UPSERT,
  PUBLISHER_BUSINESS_KEYS,
  listPublishers,
  publisherById,
  publisherLabel,
  searchPublishers,
  lookupByIsbn,
  putPublisher,
  upsertPublisher,
  addIsbnCode,
  removeIsbnCode
}
