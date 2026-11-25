#!/usr/bin/env node
/**
 * 玺爱 · **印譜匯觀（book 数据 ＋ 影像归属印谱）** 仓库级质检套件
 * =====================================================================
 * 覆盖：裁定件 `docs/book-catalog-ruling-2026-11-14.md`（`06128fc`）；
 *       被测实现 `4645b3c`（`lib/books.js` 单点 ＋ `lib/ops.js` 三薄委派 ＋ `index.js` 读出面 ＋
 *       `services/books.js` / `BookIndexView.vue` / `SealDetailView.vue` / `AppSidebar.vue` / 路由）。
 *
 * 判据口径（照本仓既有套件）：
 *   · **先剥注释再判**：`<!-- -->` / `/* *\/` / 行内 `//`，剥除器**引号感知**（' " ` 内不剥；
 *     `://` 不当前缀行注释）—— 产品件头注里逐字写着 `xiai_books` / `ADMIN_OPS` / `data-admin-action`
 *     等「解释性字样」，不剥会把说明当实码（同批 `verify-admin-buttons.mjs` 第一版即踩此坑）。
 *   · **静态面**只读源码文本；**行为面**用离线桩（`require.cache` 注入假 `lib/ops.js`，
 *     跑真实 `lib/books.js`）：**零网络、零 SDK、零库、零生产数据**。
 *   · 每条判据**可判负**：E 段五条变异负对照（发号回归固定号 / 去掉读回比对 / 去掉作者门 /
 *     放宽 `book_id` 正则 / 原样全绿正对照）必须逐条见红。
 *
 * 判据分段：
 *   A 数据模型与写面：三 op 在 `ADMIN_OPS`（恰 53）、载荷封闭键面、必填 / 可空 / 年份值域、
 *     作者引用门、`listBooks` 行投影 11 键与升序、`setImageBook` 形态门与 `null` 取消、
 *     幂等、发号（`issueCodeNumberAvoiding('book', isTaken)` ＋ `padStart(5)`）、`index.js` 读出面收窄。
 *   B 静态红线：`lib/books.js` 零集合名字面、`lib/ops.js` 三 op 薄委派、
 *     `reason` 仍 13 值 ＋ `[data-admin-action]` 仍 12 值。
 *   C 前端与可见性：侧栏项位置 / glyph / 管理员包裹、`/books` 懒加载路由、
 *     `/books` 非管理员前置返回（零请求）、详情页挂书下拉只 `data-action`、卡片 16 键零 `book_id`。
 *   D 行为（离线桩）：首本 `00001` / 第二本 `00002` / 幂等不回建 / 未收录作者零写 /
 *     年份越界零写 / 挂书读回一致（含**读回不一致必拒**）/ 清空 `null` / 书不存在拒 / 清单升序。
 *   E 变异负对照：五条（E1〜E4 必红、E5 正对照必绿）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module, { createRequire } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const CF_REL = 'cloudfunctions/xiai-user-token'
const BOOKS_REL = `${CF_REL}/lib/books.js`
const OPS_REL = `${CF_REL}/lib/ops.js`
const CONFIG_REL = `${CF_REL}/lib/config.js`
const SEAL_CARDS_REL = `${CF_REL}/lib/sealCards.js`
const BOOKS_PATH = path.join(ROOT, BOOKS_REL)
const OPS_PATH = path.join(ROOT, OPS_REL)
const CONFIG_PATH = path.join(ROOT, CONFIG_REL)

const require_ = createRequire(import.meta.url)
const { REASONS, deny } = require_(CONFIG_PATH)

/* ---------------------------------------------------------------- 断言骨架 */
const results = []
let failures = 0
const sectionStats = {}
let currentSection = 'A'

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
    .join(',')}}`
}

function check(id, desc, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  const stat = sectionStats[currentSection] || (sectionStats[currentSection] = { total: 0, failed: 0 })
  stat.total += 1
  if (!pass) stat.failed += 1
  results.push({ id, desc, pass, expected, actual })
  console.log(JSON.stringify({ id, case: desc, pass, expected, actual }))
}

const section = (id, title) => {
  currentSection = id
  console.log(JSON.stringify({ section: id, title }))
}
const sorted = (arr) => [...arr].slice().sort()
const countOf = (text, needle) => (needle ? text.split(needle).length - 1 : 0)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readAbs = (abs) => fs.readFileSync(abs, 'utf8')
const textOf = (value) => String(value === undefined || value === null ? '' : value).trim()

/* --------------------------------------------- 去注释（引号感知，保留偏移） */
/**
 * 剥注释：`<!-- -->` / `/* *\/` / （`line` 时）行内 `//`。
 * **引号感知**：`'` `"` `` ` `` 内部一律不看（防脚本里的 `/*` 字面量把整文件尾巴吃掉）；
 * `://` 前缀的 `//` 不当作行注释（URL 残片）。
 */
function stripComments(text, options = {}) {
  const lineMode = options.line === true
  const chars = [...text]
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, chars.length); k += 1) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '<' && chars[i + 1] === '!' && chars[i + 2] === '-' && chars[i + 3] === '-') {
      let j = i + 4
      while (j < chars.length && !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')) j += 1
      blank(i, j + 3)
      i = j + 3
      continue
    }
    if (c === '/' && chars[i + 1] === '*') {
      let j = i + 2
      while (j < chars.length && !(chars[j] === '*' && chars[j + 1] === '/')) j += 1
      blank(i, j + 2)
      i = j + 2
      continue
    }
    if (lineMode && c === '/' && chars[i + 1] === '/') {
      if (chars[i - 1] === ':') {
        i += 2
        continue
      }
      let j = i
      while (j < chars.length && chars[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < chars.length) {
        if (chars[j] === '\\') {
          j += 2
          continue
        }
        if (chars[j] === quote) break
        j += 1
      }
      i = j + 1
      continue
    }
    i += 1
  }
  return chars.join('')
}

/** 从 `from` 处的 `{` 起做括号配对，回闭合 `}` 的下标（找不到 ⇒ 文本末尾）。 */
function matchBrace(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length
}

/* ================================ 离线桩 ================================= */
/**
 * 用 SDK 桩加载真模块（`lib/ops.js` 顶层 `require('wx-server-sdk')` 在本仓未装 ⇒ 给 `{}`）。
 * 只用于**读注册面**（`ADMIN_OPS` 键数），不执行任何 op。
 */
function loadWithSdkStub(absPath) {
  const realLoad = Module._load
  Module._load = function patched(request, parent, isMain) {
    const bare = !request.startsWith('.') && !request.startsWith('/') && !request.startsWith('node:')
    if (bare) {
      try {
        return realLoad.call(this, request, parent, isMain)
      } catch {
        return {}
      }
    }
    return realLoad.call(this, request, parent, isMain)
  }
  try {
    return require_(absPath)
  } finally {
    Module._load = realLoad
  }
}

/** 把假 `lib/ops.js` 塞进模块缓存（`lib/books.js` 的 `opsOf()` 延迟 require ⇒ 恒取当前桩）。 */
function installOps(opsExports) {
  const fake = new Module(OPS_PATH, null)
  fake.filename = OPS_PATH
  fake.paths = Module._nodeModulePaths(path.dirname(OPS_PATH))
  fake.loaded = true
  fake.exports = opsExports
  require_.cache[OPS_PATH] = fake
}

const ADMIN_CTX = { adminPhone: '+8613800000000', nowSeconds: Date.UTC(2026, 5, 1) / 1000 }
const CURRENT_YEAR = new Date(ADMIN_CTX.nowSeconds * 1000).getFullYear()

/**
 * 内存桩：三集合（book / image / person）＋ 递增号源 ＋ 计数（读 / 写 / 发号 / isTaken 询问）。
 * `options.dropImageWrites` ⇒ 影像行更新「写已送出但不生效」（构造**读回不一致**）。
 * `options.dropBookWrites` ⇒ book 行不落。
 * `options.denyAdmin` ⇒ 管理员门恒拒（零读零写自证用）。
 */
function makeHarness(options = {}) {
  const persons = new Map([
    ['PR000000001', { id: 'PR000000001', name: '巴慰祖' }],
    ['PR000000002', { id: 'PR000000002', name: '汪啟淑' }],
    ['tmp-000001', { id: 'tmp-000001', name: '臨時行' }]
  ])
  const images = new Map([
    ['img-face-1', { id: 'img-face-1', stamp_id: 'AAAAX', kind: 'FACE' }],
    ['img-whole-1', { id: 'img-whole-1', stamp_id: 'AAAAX', kind: 'WHOLE' }],
    /* 边款影像（`EDGE`）—— `searchBookImages` 必须把它排除在结果外。 */
    ['img-edge-1', { id: 'img-edge-1', stamp_id: 'AAAAX', kind: 'EDGE' }]
  ])
  const seals = new Map([
    ['AAAAX', { _id: 'AAAAX', id: 'AAAAX', stamp_id: 'AAAAX', seal_name: '甲印', seal_no: 1 }]
  ])
  const books = new Map()
  const log = { persist: 0, issue: [], taken: [], reads: 0, writes: [] }

  const same = (row, match) =>
    !match ||
    Object.keys(match).every(
      (key) => textOf(row && row[key]) === textOf(match[key])
    )
  const rowsOf = (collection) =>
    collection === 'xiai_books'
      ? [...books.values()]
      : collection === 'xiai_images'
        ? [...images.values()]
        : collection === 'xiai_persons'
          ? [...persons.values()]
          : collection === 'xiai_seals'
            ? [...seals.values()]
            : []
  const mapOf = (collection) =>
    collection === 'xiai_books' ? books : collection === 'xiai_images' ? images : null

  const ops = {
    COLLECTIONS: Object.freeze({ books: 'xiai_books', images: 'xiai_images', persons: 'xiai_persons', seals: 'xiai_seals' }),
    adminWhitelistDenial: () => (options.denyAdmin ? deny(REASONS.FORBIDDEN, '非管理員；本次零讀寫。') : null),
    /* 假体的翻页取全（真运行时由 `lib/ops.js::readAllGuarded` 提供）。 */
    readAllGuarded: async (collection) => ({ ok: true, rows: rowsOf(collection), truncated: false, scanned: rowsOf(collection).length }),
    pointsPayloadDenial: (payload, allowed) => {
      const source = payload && typeof payload === 'object' ? payload : {}
      const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
      return unknown.length ? deny(REASONS.INVALID_FIELD, `未知欄位：${unknown.join(',')}`) : null
    },
    /* 号源：从 1 起找第一个 `isTaken(no) === false` 的号（CAS 认领的等价语义）。 */
    issueCodeNumberAvoiding: async (kind, isTaken) => {
      log.issue.push(kind)
      for (let no = 1; no <= 99999; no += 1) {
        const taken = typeof isTaken === 'function' ? Boolean(await isTaken(no)) : false
        log.taken.push({ no, taken })
        if (!taken) return { ok: true, no }
      }
      return { ok: false, reason: REASONS.STORAGE_UNAVAILABLE, message: '號源耗盡' }
    },
    occupiedNosOf: async () => {
      log.reads += 1
      return new Set([...books.keys()].map((key) => Number(key)))
    },
    readRows: async (collection, match) => {
      log.reads += 1
      return rowsOf(collection)
        .filter((row) => same(row, match))
        .map((row) => ({ ...row }))
    },
    readRowByAnyId: async (collection, id) => {
      log.reads += 1
      const hit = rowsOf(collection).find((row) => textOf(row._id || row.id) === textOf(id))
      return hit ? { ...hit } : null
    },
    readPersonRow: async (id) => {
      log.reads += 1
      return persons.get(textOf(id)) || null
    },
    persist: async (plan) => {
      log.persist += 1
      for (const write of (plan && plan.writes) || []) {
        const doc = write.doc || write.patch || {}
        log.writes.push({ collection: write.collection, kind: write.kind, keys: Object.keys(doc) })
        if (write.kind === 'set') {
          if (write.collection === 'xiai_books' && !options.dropBookWrites) {
            books.set(textOf(write.id), { ...doc })
          }
          continue
        }
        if (write.collection === 'xiai_images' && options.dropImageWrites) continue
        const target = mapOf(write.collection)
        if (!target) continue
        const row = [...target.values()].find((item) => same(item, write.match))
        if (row) Object.assign(row, doc)
      }
      return { ok: true }
    }
  }

  return {
    ops,
    log,
    persons,
    images,
    books,
    seedBook: (id, extra = {}) => {
      books.set(id, { id, name: `書${id}`, isbn: '', cip: '', author_person_id: 'PR000000001', first_publish_year: null, created_by: 'u-x', created_at: '', updated_at: '', ...extra })
    },
    storedBookIdOf: (imageId) => {
      const row = images.get(imageId)
      return row ? textOf(row.book_id) || null : null
    }
  }
}

/** 读 book 行上的一个字段（无行 ⇒ `null`）。 */
const fieldOf = (harness, bookId, field) => {
  const row = harness.books.get(bookId)
  return row ? (row[field] === undefined ? null : row[field]) : null
}

/* ============================ 行为探针（可复用） ========================= */
/* 探针都返回**纯数据**：正对照（真 `lib/books.js`）与变异负对照（内存改过的副本）共用同一份。 */

/** 生命周期：首本 / 第二本 / 幂等重投 / 同名异作者 / 清单。 */
async function probeLifecycle(mod) {
  const h = makeHarness()
  installOps(h.ops)
  const create = (payload) => mod.createBook(payload, {}, ADMIN_CTX)

  const r1 = await create({ name: '璽印集存', author_person_id: 'PR000000001' })
  const step1 = { taken: [...h.log.taken], kinds: [...h.log.issue], persist: h.log.persist, size: h.books.size }
  h.log.taken.length = 0

  const issueBase = h.log.issue.length
  const r2 = await create({ name: '秦漢印統', author_person_id: 'PR000000001' })
  const step2 = { taken: [...h.log.taken], kinds: h.log.issue.slice(issueBase), size: h.books.size }

  const persistBefore = h.log.persist
  const issueBefore = h.log.issue.length
  const r3 = await create({ name: '璽印集存', author_person_id: 'PR000000001' })
  const step3 = { persistDelta: h.log.persist - persistBefore, issueDelta: h.log.issue.length - issueBefore, size: h.books.size }

  const r4 = await create({ name: '璽印集存', author_person_id: 'PR000000002' })
  const r5 = await mod.listBooks({}, {}, ADMIN_CTX)

  return {
    r1,
    r2,
    r3,
    r4,
    r5,
    step1,
    step2,
    step3,
    ids: sorted([...h.books.keys()]),
    rowKeys1: sorted(Object.keys(h.books.get('00001') || {}))
  }
}

/** 作者引用门：未收录 / 自由文本 / 临时行 / 空白包裹的合法 id。 */
async function probeAuthorGate(mod) {
  const cases = {
    unknown: { name: '未收錄作者', author_person_id: '999999999' },
    freeText: { name: '自由文本作者', author_person_id: '巴慰祖' },
    tempRow: { name: '臨時行作者', author_person_id: 'tmp-000001' },
    padded: { name: '空白包裹', author_person_id: '  PR000000001  ' }
  }
  const out = {}
  for (const [key, payload] of Object.entries(cases)) {
    const h = makeHarness()
    installOps(h.ops)
    const res = await mod.createBook(payload, {}, ADMIN_CTX)
    const rows = [...h.books.values()]
    out[key] = {
      ok: res.ok === true,
      reason: res.ok === true ? null : res.reason,
      size: h.books.size,
      persist: h.log.persist,
      issue: h.log.issue.length,
      storedAuthor: rows.length ? textOf(rows[0].author_person_id) : null
    }
  }
  return out
}

/** 年份门 ＋ 必填门 ＋ 可空默认值。 */
async function probeFieldGate(mod) {
  const run = async (payload, options = {}) => {
    const h = makeHarness(options)
    installOps(h.ops)
    const res = await mod.createBook(payload, {}, ADMIN_CTX)
    const rows = [...h.books.values()]
    return {
      ok: res.ok === true,
      reason: res.ok === true ? null : res.reason,
      size: h.books.size,
      persist: h.log.persist,
      row: rows.length
        ? {
            name: textOf(rows[0].name),
            isbn: textOf(rows[0].isbn),
            cip: textOf(rows[0].cip),
            first_publish_year: rows[0].first_publish_year === undefined ? null : rows[0].first_publish_year
          }
        : null
    }
  }
  const author = 'PR000000001'
  return {
    missingName: await run({ author_person_id: author }),
    missingAuthor: await run({ name: '無作者書' }),
    blankName: await run({ name: '   ', author_person_id: author }),
    optionalEmpty: await run({ name: '可空書', author_person_id: author, isbn: '', cip: null, first_publish_year: null }),
    belowMin: await run({ name: '年份過小', author_person_id: author, first_publish_year: 999 }),
    aboveMax: await run({ name: '年份越界', author_person_id: author, first_publish_year: CURRENT_YEAR + 1 }),
    fractional: await run({ name: '年份小數', author_person_id: author, first_publish_year: 1999.5 }),
    stringYear: await run({ name: '年份字符串', author_person_id: author, first_publish_year: '1990' }),
    minYear: await run({ name: '年份下限', author_person_id: author, first_publish_year: 1000 }),
    currentYear: await run({ name: '年份當年', author_person_id: author, first_publish_year: CURRENT_YEAR }),
    longName: await run({ name: '書'.repeat(201), author_person_id: author }),
    longIsbn: await run({ name: '超長 ISBN', author_person_id: author, isbn: '9'.repeat(65) }),
    adminDenied: await run({ name: '無權限', author_person_id: author }, { denyAdmin: true })
  }
}

/** 载荷封闭键面（三 op）。 */
async function probePayloadGate(mod) {
  const runCreate = async (payload) => {
    const h = makeHarness()
    installOps(h.ops)
    const res = await mod.createBook(payload, {}, ADMIN_CTX)
    return { ok: res.ok === true, reason: res.ok === true ? null : res.reason, reads: h.log.reads, persist: h.log.persist, issue: h.log.issue.length }
  }
  const hList = makeHarness()
  installOps(hList.ops)
  const listExtra = await mod.listBooks({ evil: 1 }, {}, ADMIN_CTX)
  const listExtraReads = hList.log.reads
  const listAllowed = await mod.listBooks({ q: 'x', offset: 0, limit: 10 }, {}, ADMIN_CTX)
  installOps(hList.ops)
  const listMissing = await mod.listBooks(undefined, {}, ADMIN_CTX)
  const hSet = makeHarness()
  installOps(hSet.ops)
  const setExtra = await mod.setImageBook({ image_id: 'img-face-1', book_id: '00002', evil: 1 }, {}, ADMIN_CTX)
  return {
    allowedCreateKeys: sorted(mod.BOOK_CREATE_ALLOWED_KEYS || []),
    allowedListKeys: sorted(mod.BOOK_LIST_ALLOWED_KEYS || []),
    allowedSetKeys: sorted(mod.BOOK_SET_IMAGE_ALLOWED_KEYS || []),
    extraKey: await runCreate({ name: '多鍵', author_person_id: 'PR000000001', evil: 1 }),
    bookIdKey: await runCreate({ name: '自帶編號', author_person_id: 'PR000000001', book_id: '00001' }),
    auditKey: await runCreate({ name: '自帶審計', author_person_id: 'PR000000001', created_by: 'u-x' }),
    listExtra: { ok: listExtra.ok === true, reason: listExtra.reason, reads: listExtraReads },
    listMissing: { ok: listMissing.ok === true, reason: listMissing.reason, reasonIsInvalid: listMissing.reason === REASONS.INVALID_VALUE },
    setExtra: { ok: setExtra.ok === true, reason: setExtra.reason },
    setExtraKeys: sorted(mod.BOOK_ROW_KEYS || [])
  }
}

/** `setImageBook` 形态门矩阵（含 `book_id` 正则放宽的判负点）。 */
/** 分頁 ＋ 篩選探針（2026-11-15）：服務端切片 / 命中總數 / 三類篩選 / 形態門。 */
async function probeListPagingAndFilters(mod) {
  const h = makeHarness()
  h.seedBook('00001', { name: '求是齋印稿', author_name: '黃鵷', first_publish_year: 1838 })
  h.seedBook('00002', { name: '試篆印存', author_name: '黃家積', first_publish_year: null })
  h.seedBook('00003', { name: '二金蜨堂印存', author_name: '吳隱', first_publish_year: 1908 })
  const run = async (payload) => {
    installOps(h.ops)
    const out = await mod.listBooks(payload, {}, ADMIN_CTX)
    return {
      ok: out.ok === true,
      reason: out.ok === true ? null : out.reason,
      ids: (Array.isArray(out.books) ? out.books : []).map((row) => textOf(row.id)),
      total: out.total,
      hasMore: out.has_more === true,
      offset: out.offset,
      limit: out.limit
    }
  }
  return {
    page1: await run({ limit: 2 }),
    page2: await run({ limit: 2, offset: 2 }),
    byName: await run({ q: '篆' }),
    byAuthor: await run({ author: '黃' }),
    byYear: await run({ year_from: 1900 }),
    badLimit: await run({ limit: 0 }),
    badYearRange: await run({ year_from: 2000, year_to: 1900 })
  }
}

async function probeSetImageGuards(mod) {
  const run = async (payload) => {
    const h = makeHarness()
    h.seedBook('00002', { name: '秦漢印統' })
    installOps(h.ops)
    const res = await mod.setImageBook(payload, {}, ADMIN_CTX)
    return {
      ok: res.ok === true,
      reason: res.ok === true ? null : res.reason,
      formMessage: res.ok === true ? false : /五位純數字/.test(textOf(res.message)),
      persist: h.log.persist
    }
  }
  return {
    patternSource: String((mod.BOOK_ID_PATTERN && mod.BOOK_ID_PATTERN.source) || ''),
    acceptsFive: Boolean(mod.BOOK_ID_PATTERN && mod.BOOK_ID_PATTERN.test('00001')),
    rejectsShort: mod.BOOK_ID_PATTERN
      ? ['1234', '000001', 'ABCDE', '0001a'].every((value) => mod.BOOK_ID_PATTERN.test(value) === false)
      : false,
    extraKey: await run({ image_id: 'img-face-1', book_id: '00002', evil: 1 }),
    missingBookId: await run({ image_id: 'img-face-1' }),
    missingImageId: await run({ book_id: '00002' }),
    fourDigits: await run({ image_id: 'img-face-1', book_id: '1234' }),
    sixDigits: await run({ image_id: 'img-face-1', book_id: '000001' }),
    letters: await run({ image_id: 'img-face-1', book_id: 'ABCDE' }),
    numeric: await run({ image_id: 'img-face-1', book_id: 12345 }),
    unknownBook: await run({ image_id: 'img-face-1', book_id: '09999' }),
    unknownImage: await run({ image_id: 'img-nope', book_id: '00002' }),
    clearNull: await run({ image_id: 'img-face-1', book_id: null })
  }
}

/** 挂书读回：一致 ⇒ ok；**写不生效 ⇒ 必拒**（假成功即为红）。 */
async function probeReadback(mod) {
  const consistent = makeHarness()
  consistent.seedBook('00002', { name: '秦漢印統' })
  installOps(consistent.ops)
  const ok = await mod.setImageBook({ image_id: 'img-face-1', book_id: '00002' }, {}, ADMIN_CTX)

  const dropped = makeHarness({ dropImageWrites: true })
  dropped.seedBook('00002', { name: '秦漢印統' })
  installOps(dropped.ops)
  const bad = await mod.setImageBook({ image_id: 'img-whole-1', book_id: '00002' }, {}, ADMIN_CTX)

  const clear = makeHarness()
  clear.seedBook('00002', { name: '秦漢印統' })
  clear.images.set('img-face-1', { id: 'img-face-1', stamp_id: 'AAAAX', kind: 'FACE', book_id: '00002' })
  installOps(clear.ops)
  const cleared = await mod.setImageBook({ image_id: 'img-face-1', book_id: null }, {}, ADMIN_CTX)

  const missing = makeHarness()
  installOps(missing.ops)
  const ghost = await mod.setImageBook({ image_id: 'img-face-1', book_id: '09999' }, {}, ADMIN_CTX)

  return {
    ok: ok.ok === true,
    okEcho: ok.ok === true ? textOf(ok.book_id) || null : null,
    okStored: consistent.storedBookIdOf('img-face-1'),
    okKeys: sorted(Object.keys(ok)),
    mismatchOk: bad.ok === true,
    mismatchReason: bad.ok === true ? null : bad.reason,
    mismatchStored: dropped.storedBookIdOf('img-whole-1'),
    clearOk: cleared.ok === true,
    clearEcho: cleared.ok === true ? textOf(cleared.book_id) || null : 'unset',
    clearStored: clear.storedBookIdOf('img-face-1'),
    ghostOk: ghost.ok === true,
    ghostReason: ghost.ok === true ? null : ghost.reason,
    ghostPersist: missing.log.persist,
    ghostStored: missing.storedBookIdOf('img-face-1')
  }
}

/** 清单：行投影 8 键 ＋ 升序 ＋ `total`（乱序入库）。 */
async function probeList(mod) {
  const h = makeHarness()
  h.seedBook('00003', { name: '第三本' })
  h.seedBook('00001', { name: '第一本' })
  h.seedBook('00002', { name: '第二本' })
  installOps(h.ops)
  const out = await mod.listBooks({}, {}, ADMIN_CTX)
  const books = Array.isArray(out.books) ? out.books : []
  return {
    ok: out.ok === true,
    total: out.total,
    count: books.length,
    ids: books.map((row) => textOf(row.id)),
    rowKeys: books.map((row) => sorted(Object.keys(row))),
    expectedRowKeys: sorted(mod.BOOK_ROW_KEYS || []),
    rowHasAudit: books.some((row) => Object.prototype.hasOwnProperty.call(row, 'created_by')),
    responseKeys: sorted(Object.keys(out)),
    ascending: books.map((row) => textOf(row.id)).join('|') === '00001|00002|00003'
  }
}

/* =============================== 静态判据 =============================== */
const ADMIN_ACTIONS = 12
const REASON_COUNT = 13
const BOOK_ROW_KEY_COUNT = 12

function judgeSidebar(raw) {
  const clean = stripComments(raw, { line: true })
  const at = clean.indexOf('const items = computed(() => {')
  const end = at >= 0 ? matchBrace(clean, clean.indexOf('{', at)) : -1
  const block = at >= 0 ? clean.slice(at, end + 1) : ''
  const booksAt = block.indexOf(`key: 'books'`)
  const driveAt = block.indexOf(`key: 'my-drive'`)
  const gateAt = block.indexOf('if (isAdmin.value) {')
  const gateEnd = gateAt >= 0 ? matchBrace(block, block.indexOf('{', gateAt)) : -1
  const itemSlice = booksAt >= 0 ? block.slice(booksAt, booksAt + 160) : ''
  return {
    booksBeforeDrive: booksAt >= 0 && driveAt >= 0 && booksAt < driveAt,
    glyph: /glyph:\s*'譜'/.test(itemSlice),
    label: /label:\s*'印譜匯觀'/.test(itemSlice),
    routeName: /to:\s*\{\s*name:\s*'books'\s*\}/.test(itemSlice),
    insideAdminGate: booksAt >= 0 && gateAt >= 0 && booksAt > gateAt && booksAt < gateEnd,
    itemsCount: countOf(block, `key: 'books'`),
    disabledHack: /disabled/.test(itemSlice)
  }
}

function judgeRouter(raw) {
  const clean = stripComments(raw, { line: true })
  const at = clean.indexOf(`path: '/books'`)
  const slice = at >= 0 ? clean.slice(at, at + 400) : ''
  return {
    hasPath: at >= 0,
    name: /name:\s*'books'/.test(slice),
    lazyImport: /component:\s*\(\)\s*=>\s*import\('\.\.\/views\/BookIndexView\.vue'\)/.test(slice),
    title: /meta:\s*\{\s*title:\s*'印譜匯觀'\s*\}/.test(slice)
  }
}

function judgeBookIndexView(raw) {
  const clean = stripComments(raw, { line: true })
  const refreshAt = clean.indexOf('async function refreshBooks()')
  const refreshBody = refreshAt >= 0 ? clean.slice(refreshAt, refreshAt + 900) : ''
  const gateAt = refreshBody.indexOf('!canManage.value')
  const requestAt = refreshBody.indexOf('listBooks(')
  return {
    gateCount: countOf(clean, 'if (!canManage.value) return'),
    refreshGatedBeforeRequest: gateAt >= 0 && (requestAt < 0 || gateAt < requestAt),
    deniedPanel: /v-if="!canManage"/.test(clean),
    adminOnlyBranch: /<template v-else>/.test(clean),
    deniedHook: /data-books-denied/.test(clean)
  }
}

function judgeDetailHooks(raw) {
  const clean = stripComments(raw, { line: true })
  const sliceOfBlock = (marker, span = 1600) => {
    const at = clean.indexOf(marker)
    if (at < 0) return ''
    const start = clean.lastIndexOf('<div', at)
    return clean.slice(start < 0 ? at : start, (start < 0 ? at : start) + span)
  }
  const faceBlock = sliceOfBlock('data-image-book-block="face"')
  const wholeBlock = sliceOfBlock('data-image-book-block="whole-seal"')
  return {
    faceAction: countOf(clean, 'data-action="assign-face-image-book"'),
    wholeAction: countOf(clean, 'data-action="assign-whole-seal-image-book"'),
    faceGated: /v-if="canAssignBook/.test(faceBlock),
    wholeGated: /v-if="canAssignBook/.test(wholeBlock),
    adminActionInBlocks: countOf(faceBlock, 'data-admin-action') + countOf(wholeBlock, 'data-admin-action'),
    optionsSource: countOf(clean, 'bookOptions') > 0
  }
}

function parseKeyArray(raw, anchor) {
  const clean = stripComments(raw, { line: true })
  const at = clean.indexOf(anchor)
  if (at < 0) return []
  const arrStart = clean.indexOf('[', at)
  const arrEnd = clean.indexOf(']', arrStart)
  return [...clean.slice(arrStart + 1, arrEnd).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

function judgeCardDto() {
  const serverCard = parseKeyArray(read(`${CF_REL}/lib/sealCards.js`), 'const CARD_ROW_KEYS = Object.freeze(')
  const clientCard = parseKeyArray(read('src/services/sealCards.js'), 'export const SEAL_CARD_ROW_KEYS = Object.freeze(')
  return {
    serverCount: serverCard.length,
    clientCount: clientCard.length,
    sameSet: serverCard.join('|') === clientCard.join('|'),
    serverHasBookId: serverCard.includes('book_id'),
    clientHasBookId: clientCard.includes('book_id'),
    dtoBookIdHits: [
      `${CF_REL}/lib/sealCards.js`,
      'src/services/sealCards.js',
      'src/components/SealCard.vue'
    ].reduce((sum, rel) => sum + countOf(stripComments(read(rel), { line: true }), 'book_id'), 0)
  }
}

function judgeBooksNoCollectionLiteral(raw) {
  const clean = stripComments(raw, { line: true })
  return {
    collectionLiterals: countOf(clean, 'xiai_'),
    collectionsUses: countOf(clean, 'COLLECTIONS.')
  }
}

function judgeOpsThinDelegation(raw) {
  const clean = stripComments(raw, { line: true })
  const runners = { createBook: 'runCreate', listBooks: 'runList', setImageBook: 'runSet' }
  const out = {}
  for (const [op, runner] of Object.entries(runners)) {
    const signature = `async ${op}(payload, identity, context) {`
    const at = clean.indexOf(signature)
    let body = ''
    if (at >= 0) {
      const start = clean.indexOf('{', at)
      body = clean.slice(start + 1, matchBrace(clean, start))
    }
    out[op] = {
      found: at >= 0,
      requiresBooks: /const\s*\{\s*\w+\s*:\s*\w+\s*\}\s*=\s*require\('\.\/books\.js'\)/.test(body),
      delegates: body.includes(`return ${runner}(payload, identity, context)`),
      hasAwait: /\bawait\b/.test(body),
      touchesStorage: /\b(?:persist|readRows|readRowByAnyId|adminWhitelistDenial|occupiedNosOf)\s*\(/.test(body),
      statements: body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('/*') && !line.startsWith('*')).length
    }
  }
  return out
}

function judgeAdminActionValues() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|js|mjs)$/.test(entry.name)) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/data-admin-action="([a-z-]+)"/g)) found.add(m[1])
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return sorted([...found])
}

function judgeIndexReadout() {
  const clean = stripComments(read(`${CF_REL}/index.js`), { line: true })
  const blocks = {
    create: countOf(clean, 'for (const key of CREATE_BOOK_READOUT_KEYS)'),
    list: countOf(clean, 'for (const key of LIST_BOOKS_READOUT_KEYS)'),
    setImage: countOf(clean, 'for (const key of SET_IMAGE_BOOK_READOUT_KEYS)')
  }
  const importOk =
    /* 允许在三个既有常量之后**追加**新常量（如 `SEARCH_BOOK_IMAGES_READOUT_KEYS`）——
       只要求前三个仍在同一处、且整块来自 `./lib/books.js`（单一真源）。 */
    /CREATE_BOOK_READOUT_KEYS,\s*\n\s*LIST_BOOKS_READOUT_KEYS,\s*\n\s*SET_IMAGE_BOOK_READOUT_KEYS(?:,\s*\n\s*[A-Z_]+)*\s*\n\}\s*=\s*require\('\.\/lib\/books\.js'\)/.test(
      clean
    )
  return {
    blocks,
    importFromBooks: importOk,
    opComparisons:
      countOf(clean, `if (op === 'createBook')`) + countOf(clean, `if (op === 'listBooks')`) + countOf(clean, `if (op === 'setImageBook')`)
  }
}

/* ================================ 加载真源 =============================== */
const opsModule = loadWithSdkStub(OPS_PATH)
const adminOps = opsModule.ADMIN_OPS || {}
const adminOpKeys = Object.keys(adminOps)
const booksSource = read(BOOKS_REL)

/* --------------------------------- A 数据模型与写面 ---------------------- */
section('A', '数据模型与写面：三 op 注册面、载荷封闭键面、必填/可空/年份值域、作者引用门、行投影、幂等、发号')

const BOOK_OPS = ['createBook', 'listBooks', 'setImageBook']
const notInUserOps = BOOK_OPS.filter((op) => Object.prototype.hasOwnProperty.call(opsModule.OPS || {}, op))
const publicOps = opsModule.PUBLIC_OPS || {}
const notInPublicOps = BOOK_OPS.filter((op) => Object.prototype.hasOwnProperty.call(publicOps, op))

check(
  'A1',
  '三 op 全落 `ADMIN_OPS` 且均为 function；`ADMIN_OPS` 恰 53（52 → 53，2026-11-26 出版社写面单增 `putPublisher`（函数、零新 reason、只落 `ADMIN_OPS` ⇒ 52 → 53）；前一版 52 由 51 → 52，2026-11-17 AI 候選圖可见性回填單增 `repairAiCandidateVisibility`：函數、薄委派本文件实现点、零新 reason，字典序位在 `registerFaceImage` 之後、`repairAuthorPersonId` 之前；前一版 51 由 2026-11-17 印譜封面/改名單增 `updateBook` / `setBookCover` / `listBookCovers` 带入 48 → 51）；三 op 不落 `OPS` / `PUBLIC_OPS`（零用户读面）',
  { types: ['function', 'function', 'function'], adminOpsCount: 53, contains: true, userOpsLeak: [], publicOpsLeak: [] },
  {
    types: BOOK_OPS.map((op) => typeof adminOps[op]),
    adminOpsCount: adminOpKeys.length,
    contains: BOOK_OPS.every((op) => adminOpKeys.includes(op)),
    userOpsLeak: notInUserOps,
    publicOpsLeak: notInPublicOps
  }
)

const payloadGate = await probePayloadGate(booksModule0())

check('A2', '`createBook` 载荷**封闭恰 6 键**（`name/isbn/cip/publisher/author_person_id/first_publish_year`；2026-11-15 增 publisher【出版社】非必填）；`book_id` / `created_by` / 未知键 ⇒ `INVALID_FIELD` 且**零读零写**（判定早于任何读）', {
  allowedCreateKeys: ['author_person_id', 'cip', 'first_publish_year', 'isbn', 'name', 'publisher'],
  extraKeyReason: REASONS.INVALID_FIELD,
  bookIdKeyReason: REASONS.INVALID_FIELD,
  auditKeyReason: REASONS.INVALID_FIELD,
  extraKeyReads: 0,
  extraKeyPersist: 0,
  extraKeyIssue: 0
}, {
  allowedCreateKeys: payloadGate.allowedCreateKeys,
  extraKeyReason: payloadGate.extraKey.reason,
  bookIdKeyReason: payloadGate.bookIdKey.reason,
  auditKeyReason: payloadGate.auditKey.reason,
  extraKeyReads: payloadGate.extraKey.reads,
  extraKeyPersist: payloadGate.extraKey.persist,
  extraKeyIssue: payloadGate.extraKey.issue
})

check('A2b', '`listBooks` 载荷**封闭 6 键**（offset/limit/q/author/year_from/year_to；给出未知键 ⇒ `INVALID_FIELD` ＋ 零读）；`setImageBook` 载荷**封闭 2 键**（`image_id` / `book_id`）', {
  allowedListKeys: ['author', 'limit', 'offset', 'q', 'year_from', 'year_to'],
  allowedSetKeys: ['book_id', 'image_id'],
  listExtraReason: REASONS.INVALID_FIELD,
  listExtraReads: 0,
  setExtraReason: REASONS.INVALID_FIELD
}, {
  allowedListKeys: payloadGate.allowedListKeys,
  allowedSetKeys: payloadGate.allowedSetKeys,
  listExtraReason: payloadGate.listExtra.reason,
  listExtraReads: payloadGate.listExtra.reads,
  setExtraReason: payloadGate.setExtra.reason
})

const fieldGate = await probeFieldGate(booksModule0())

check('A3', '必填门：`name` / `author_person_id` 缺 / 空 ⇒ `MISSING_REQUIRED` 且零写；非管理员 ⇒ 结构化拒（`FORBIDDEN`）且零写', {
  missingName: REASONS.MISSING_REQUIRED,
  missingAuthor: REASONS.MISSING_REQUIRED,
  blankName: REASONS.MISSING_REQUIRED,
  adminDenied: REASONS.FORBIDDEN,
  zeroWrite: [0, 0, 0, 0]
}, {
  missingName: fieldGate.missingName.reason,
  missingAuthor: fieldGate.missingAuthor.reason,
  blankName: fieldGate.blankName.reason,
  adminDenied: fieldGate.adminDenied.reason,
  zeroWrite: [fieldGate.missingName.persist, fieldGate.missingAuthor.persist, fieldGate.blankName.persist, fieldGate.adminDenied.persist]
})

check('A3b', '可空门：`isbn` / `cip` / `first_publish_year` 缺键 / 空串 / `null` ⇒ 建行成功且落空串 / 空串 / `null`（不编造值）', {
  ok: true,
  row: { name: '可空書', isbn: '', cip: '', first_publish_year: null }
}, {
  ok: fieldGate.optionalEmpty.ok,
  row: fieldGate.optionalEmpty.row
})

check('A3c', '年份门：`999` / 当年 +1 / `1999.5` / `"1990"` ⇒ `INVALID_VALUE` 且零写；`1000` 与当年 ⇒ 接受；书名 201 字 / ISBN 65 字 ⇒ 拒', {
  belowMin: REASONS.INVALID_VALUE,
  aboveMax: REASONS.INVALID_VALUE,
  fractional: REASONS.INVALID_VALUE,
  stringYear: REASONS.INVALID_VALUE,
  minYearOk: true,
  currentYearOk: true,
  longName: REASONS.INVALID_VALUE,
  longIsbn: REASONS.INVALID_VALUE,
  zeroWrite: [0, 0, 0, 0]
}, {
  belowMin: fieldGate.belowMin.reason,
  aboveMax: fieldGate.aboveMax.reason,
  fractional: fieldGate.fractional.reason,
  stringYear: fieldGate.stringYear.reason,
  minYearOk: fieldGate.minYear.ok,
  currentYearOk: fieldGate.currentYear.ok,
  longName: fieldGate.longName.reason,
  longIsbn: fieldGate.longIsbn.reason,
  zeroWrite: [fieldGate.belowMin.persist, fieldGate.aboveMax.persist, fieldGate.fractional.persist, fieldGate.stringYear.persist]
})

const authorGate = await probeAuthorGate(booksModule0())

check('A4', '作者**引用型**门：未收录 id / 自由文本人名 / `tmp-` 临时行 ⇒ `INVALID_VALUE` ＋ 零读后零写（不放行自由文本）；空白包裹的合法 id ⇒ 接受并按行 id 归一落库', {
  unknown: { ok: false, reason: REASONS.INVALID_VALUE, size: 0, persist: 0, issue: 0 },
  freeText: { ok: false, reason: REASONS.INVALID_VALUE, size: 0, persist: 0 },
  tempRow: { ok: false, reason: REASONS.INVALID_VALUE, size: 0 },
  padded: { ok: true, storedAuthor: 'PR000000001' }
}, {
  unknown: { ok: authorGate.unknown.ok, reason: authorGate.unknown.reason, size: authorGate.unknown.size, persist: authorGate.unknown.persist, issue: authorGate.unknown.issue },
  freeText: { ok: authorGate.freeText.ok, reason: authorGate.freeText.reason, size: authorGate.freeText.size, persist: authorGate.freeText.persist },
  tempRow: { ok: authorGate.tempRow.ok, reason: authorGate.tempRow.reason, size: authorGate.tempRow.size },
  padded: { ok: authorGate.padded.ok, storedAuthor: authorGate.padded.storedAuthor }
})

const listProbe = await probeList(booksModule0())

check('A5', '`listBooks`：`books` / `total` / `offset` / `limit` / `has_more` 键面；行投影**恰 `BOOK_ROW_KEYS` 12 键**（2026-11-15 增 publisher ＋ author_name ＋ creators ＋ image_count）（零 `created_by` / 零 `_id`）；按 `id` 升序（乱序入库仍升序）；`total` ＝ 行数', {
  responseKeys: ['books', 'has_more', 'limit', 'offset', 'ok', 'total'],
  total: 3,
  count: 3,
  ids: ['00001', '00002', '00003'],
  rowKeyCount: BOOK_ROW_KEY_COUNT,
  rowKeysDistinct: 1,
  rowHasAudit: false,
  ascending: true
}, {
  responseKeys: listProbe.responseKeys,
  total: listProbe.total,
  count: listProbe.count,
  ids: listProbe.ids,
  rowKeyCount: (listProbe.rowKeys[0] || []).length,
  rowKeysDistinct: new Set(listProbe.rowKeys.map((keys) => keys.join('|'))).size,
  rowHasAudit: listProbe.rowHasAudit,
  ascending: listProbe.ascending
})


const pagingProbe = await probeListPagingAndFilters(booksModule0())

check('A5b', '`listBooks` 分頁：`limit=2` ⇒ 首頁 2 行 / `has_more:true`；`offset=2` ⇒ 次頁 1 行 / `has_more:false`；`total` 恒為命中總數（3）', {
  page1: { ids: ['00001', '00002'], total: 3, hasMore: true, offset: 0, limit: 2 },
  page2: { ids: ['00003'], total: 3, hasMore: false, offset: 2, limit: 2 }
}, {
  page1: { ids: pagingProbe.page1.ids, total: pagingProbe.page1.total, hasMore: pagingProbe.page1.hasMore, offset: pagingProbe.page1.offset, limit: pagingProbe.page1.limit },
  page2: { ids: pagingProbe.page2.ids, total: pagingProbe.page2.total, hasMore: pagingProbe.page2.hasMore, offset: pagingProbe.page2.offset, limit: pagingProbe.page2.limit }
})

check('A5c', '`listBooks` 篩選：`q`（書名包含）、`author`（作者名包含）、`year_from`（年份下界，無年份行不命中）各自縮小命中集；`limit=0` / `year_from>year_to` ⇒ `INVALID_VALUE`', {
  byName: ['00002'],
  byAuthor: ['00001', '00002'],
  byYear: ['00003'],
  badLimit: REASONS.INVALID_VALUE,
  badYearRange: REASONS.INVALID_VALUE
}, {
  byName: pagingProbe.byName.ids,
  byAuthor: pagingProbe.byAuthor.ids,
  byYear: pagingProbe.byYear.ids,
  badLimit: pagingProbe.badLimit.reason,
  badYearRange: pagingProbe.badYearRange.reason
})

/** `searchBookImages` 探针（2026-11-15）：关键词必填 / 命中面 / 边款排除 / 行键面 / 只读。 */
async function probeSearchBookImages(mod) {
  const h = makeHarness()
  installOps(h.ops)
  const writesBefore = h.log.writes.length
  const empty = await mod.searchBookImages({}, {}, ADMIN_CTX)
  const emptyReads = h.log.reads
  const byName = await mod.searchBookImages({ q: '甲印' }, {}, ADMIN_CTX)
  const byStamp = await mod.searchBookImages({ q: 'AAAAX' }, {}, ADMIN_CTX)
  const noHit = await mod.searchBookImages({ q: '不存在' }, {}, ADMIN_CTX)
  const rows = Array.isArray(byName.rows) ? byName.rows : []
  return {
    empty: { ok: empty.ok === true, reason: empty.reason, reads: emptyReads },
    byName: { ok: byName.ok === true, total: byName.total, ids: rows.map((row) => textOf(row.image_id)), keys: rows.map((row) => sorted(Object.keys(row))), expectedKeys: sorted(mod.BOOK_IMAGE_ROW_KEYS || []) },
    byStamp: { ok: byStamp.ok === true, total: byStamp.total },
    noHit: { ok: noHit.ok === true, total: noHit.total },
    writes: h.log.writes.length - writesBefore
  }
}

const searchProbe = await probeSearchBookImages(booksModule0())

check('A5d', '`searchBookImages`：`q` 必填（空 ⇒ `MISSING_REQUIRED` ＋ 零读）；按印文或章號命中即回该章影像、**边款（EDGE）不入结果**；行投影恰 5 键；无命中 ⇒ `total 0`；**全程零写**', {
  empty: { ok: false, reason: REASONS.MISSING_REQUIRED, reads: 0 },
  byName: { ok: true, total: 2, ids: ['img-face-1', 'img-whole-1'] },
  byStamp: { ok: true, total: 2 },
  noHit: { ok: true, total: 0 },
  rowKeysDistinct: 1,
  writes: 0
}, {
  empty: searchProbe.empty,
  byName: { ok: searchProbe.byName.ok, total: searchProbe.byName.total, ids: searchProbe.byName.ids },
  byStamp: searchProbe.byStamp,
  noHit: searchProbe.noHit,
  rowKeysDistinct: new Set(searchProbe.byName.keys.map((keys) => keys.join('|'))).size,
  writes: searchProbe.writes
})

const setGuards = await probeSetImageGuards(booksModule0())

check('A6', '`setImageBook` 形态门：`book_id` 正则**恰五位十进制**；`1234` / `000001` / `ABCDE` ⇒ `INVALID_VALUE` ＋ 文案点明「五位純數字」；非字符串 ⇒ 拒；缺 `book_id` 键 ⇒ `MISSING_REQUIRED`（**缺键 ≠ 取消**）；未知键 ⇒ `INVALID_FIELD`', {
  patternSource: '^\\d{5}$',
  acceptsFive: true,
  rejectsNonFive: true,
  fourDigits: { ok: false, reason: REASONS.INVALID_VALUE, form: true },
  sixDigits: { ok: false, reason: REASONS.INVALID_VALUE, form: true },
  letters: { ok: false, reason: REASONS.INVALID_VALUE, form: true },
  numeric: { ok: false, reason: REASONS.INVALID_VALUE },
  missingBookId: { ok: false, reason: REASONS.MISSING_REQUIRED },
  missingImageId: { ok: false, reason: REASONS.MISSING_REQUIRED },
  extraKey: { ok: false, reason: REASONS.INVALID_FIELD }
}, {
  patternSource: setGuards.patternSource,
  acceptsFive: setGuards.acceptsFive,
  rejectsNonFive: setGuards.rejectsShort,
  fourDigits: { ok: setGuards.fourDigits.ok, reason: setGuards.fourDigits.reason, form: setGuards.fourDigits.formMessage },
  sixDigits: { ok: setGuards.sixDigits.ok, reason: setGuards.sixDigits.reason, form: setGuards.sixDigits.formMessage },
  letters: { ok: setGuards.letters.ok, reason: setGuards.letters.reason, form: setGuards.letters.formMessage },
  numeric: { ok: setGuards.numeric.ok, reason: setGuards.numeric.reason },
  missingBookId: { ok: setGuards.missingBookId.ok, reason: setGuards.missingBookId.reason },
  missingImageId: { ok: setGuards.missingImageId.ok, reason: setGuards.missingImageId.reason },
  extraKey: { ok: setGuards.extraKey.ok, reason: setGuards.extraKey.reason }
})

check('A6b', '`setImageBook` 存在性门：书不存在（`09999`）/ 影像不存在 ⇒ `INVALID_VALUE` ＋ 零写；`book_id: null` ＝ 清空（合法，不查书）⇒ ok', {
  unknownBook: { ok: false, reason: REASONS.INVALID_VALUE, persist: 0 },
  unknownImage: { ok: false, reason: REASONS.INVALID_VALUE },
  clearNull: { ok: true, reason: null }
}, {
  unknownBook: { ok: setGuards.unknownBook.ok, reason: setGuards.unknownBook.reason, persist: setGuards.unknownBook.persist },
  unknownImage: { ok: setGuards.unknownImage.ok, reason: setGuards.unknownImage.reason },
  clearNull: { ok: setGuards.clearNull.ok, reason: setGuards.clearNull.reason }
})

const booksClean = stripComments(booksSource, { line: true })
check('A6c', '`setImageBook` 的成功判据是**读回比对**（`writtenBookId !== targetBookId`），不是写回执：源码零 `updated >= 1` / 零 `updatedCount` 之类「回执即成功」判据（`expectAtLeast: 1` 只是写的最小断言）', {
  writeMinAssertion: true,
  readbackCompare: true,
  updateReceiptSuccess: 0
}, {
  writeMinAssertion: countOf(booksClean, 'expectAtLeast: 1') >= 1,
  readbackCompare: /writtenBookId !== targetBookId/.test(booksClean),
  updateReceiptSuccess:
    countOf(booksClean, 'updated >=') + countOf(booksClean, 'updatedCount') + countOf(booksClean, 'updated_count')
})

const lifecycle = await probeLifecycle(booksModule0())

check('A7', '**幂等**：同 `name` ＋ 同 `author_person_id` 重投 ⇒ 回既有 `book_id` ＋ additive `skipped:true`，**不建第二行、不发号、不写任何行**；建行轮回包恰 2 键（`skipped` 是存在性驱动）', {
  duplicateId: '00001',
  skipped: true,
  sizeUnchanged: 2,
  issueDelta: 0,
  persistDelta: 0,
  normalKeys: ['book_id', 'ok'],
  duplicateKeys: ['book_id', 'ok', 'skipped']
}, {
  duplicateId: lifecycle.r3.ok === true ? textOf(lifecycle.r3.book_id) : null,
  skipped: lifecycle.r3.skipped === true,
  sizeUnchanged: lifecycle.step3.size,
  issueDelta: lifecycle.step3.issueDelta,
  persistDelta: lifecycle.step3.persistDelta,
  normalKeys: sorted(Object.keys(lifecycle.r1)),
  duplicateKeys: sorted(Object.keys(lifecycle.r3))
})

check('A8', '**发号**复用单点 `issueCodeNumberAvoiding(\'book\', isTaken)`：号别恒 `book`、占号面经 `isTaken` 询问（首本问 `1`、第二本问 `1`→`2`）；`id` ＝ `padStart(5, \'0\')` 单点；零 `Math.random` / 零 `randomUUID`（禁随机 / 时间戳 / 客户端发号）', {
  kinds: ['book', 'book'],
  firstAsk: [{ no: 1, taken: false }],
  secondAsk: [{ no: 1, taken: true }, { no: 2, taken: false }],
  idWidth: 5,
  padStartOnce: 1,
  randomCalls: 0
}, {
  kinds: lifecycle.step1.kinds.concat(lifecycle.step2.kinds),
  firstAsk: lifecycle.step1.taken,
  secondAsk: lifecycle.step2.taken,
  idWidth: booksModule0().BOOK_ID_WIDTH,
  padStartOnce: countOf(stripComments(booksSource, { line: true }), 'padStart(BOOK_ID_WIDTH'),
  randomCalls:
    countOf(stripComments(booksSource, { line: true }), 'Math.random') +
    countOf(stripComments(booksSource, { line: true }), 'randomUUID')
})

const readout = judgeIndexReadout()

check('A9', '读出面（`index.js`）按 op **收窄透传**：三 op 各恰一块 `hasOwnProperty` 收窄循环 ＋ 键面常量自 `lib/books.js`（单一真源，零第二套键表）', {
  blocks: { create: 1, list: 1, setImage: 1 },
  importFromBooks: true,
  opComparisons: 3
}, {
  blocks: readout.blocks,
  importFromBooks: readout.importFromBooks,
  opComparisons: readout.opComparisons
})

/* --------------------------------- B 静态红线 ---------------------------- */
section('B', '静态红线：`lib/books.js` 零集合名字面、三 op 薄委派、`reason` 13 值与 `[data-admin-action]` 12 值不变')

const booksLiteral = judgeBooksNoCollectionLiteral(booksSource)
check('B1', '`lib/books.js` **零集合名字面**（先剥注释后仍零 `xiai_`）；集合一律经 `ops.COLLECTIONS` / 既有读写封装取（≥ 3 处引用）', {
  collectionLiterals: 0,
  collectionsUsesAtLeast: true
}, {
  collectionLiterals: booksLiteral.collectionLiterals,
  collectionsUsesAtLeast: booksLiteral.collectionsUses >= 3
})

const delegation = judgeOpsThinDelegation(read(OPS_REL))
check('B2', '`lib/ops.js` 三 op 为**薄委派**：`require(\'./books.js\')`（延迟形式）＋ 单条 `return runX(payload, identity, context)`；零 `await`、零直触存储、零管理员门复写、语句数恰 2（require ＋ return）', {
  createBook: { found: true, requiresBooks: true, delegates: true, hasAwait: false, touchesStorage: false, statements: 2 },
  listBooks: { found: true, requiresBooks: true, delegates: true, hasAwait: false, touchesStorage: false, statements: 2 },
  setImageBook: { found: true, requiresBooks: true, delegates: true, hasAwait: false, touchesStorage: false, statements: 2 }
}, {
  createBook: delegation.createBook,
  listBooks: delegation.listBooks,
  setImageBook: delegation.setImageBook
})

const adminActions = judgeAdminActionValues()
const reasonValues = Object.keys(REASONS)
const booksReasonLiterals = [
  ...new Set(
    [...stripComments(booksSource, { line: true }).matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)]
      .map((m) => m[1])
      .filter((value) => !reasonValues.includes(value))
  )
]
check('B3', '`lib/books.js` 零新增 `reason` 字面值（全表仍 **13 值**，只用 `REASONS.*`）；`[data-admin-action]` 全仓仍**恰 12 值**', {
  reasonCount: REASON_COUNT,
  newReasonLiterals: [],
  adminActionCount: ADMIN_ACTIONS
}, {
  reasonCount: reasonValues.length,
  newReasonLiterals: booksReasonLiterals,
  adminActionCount: adminActions.length
})

/* --------------------------------- C 前端与可见性 ------------------------ */
section('C', '前端与可见性：侧栏项（位置/字形/管理员包裹）、`/books` 懒加载路由、非管理员零请求、挂书只 `data-action`、卡片 16 键零 `book_id`')

const sidebarJudge = judgeSidebar(read('src/components/AppSidebar.vue'))
check('C1', '侧栏【印譜匯觀】位于 `my-drive` **之前**、glyph ＝ `譜`、`label` ＝ `印譜匯觀`、路由 `name: \'books\'`；push 在 `if (isAdmin.value)` 块内（非管理员 **0 渲染**，非 `disabled` / CSS 隐藏冒充）且全件仅 1 项', {
  booksBeforeDrive: true,
  glyph: true,
  label: true,
  routeName: true,
  insideAdminGate: true,
  itemsCount: 1,
  disabledHack: false
}, sidebarJudge)

const routerJudge = judgeRouter(read('src/router/index.js'))
check('C2', '路由 `/books` 存在：`name: \'books\'`、**懒加载** `() => import(\'../views/BookIndexView.vue\')`、`meta.title` ＝ `印譜匯觀`', {
  hasPath: true,
  name: true,
  lazyImport: true,
  title: true
}, routerJudge)

const bookIndexJudge = judgeBookIndexView(read('src/views/BookIndexView.vue'))
check('C3', '`/books` 非管理员**前置返回**（`refreshBooks` 的 `!canManage.value` 判在任何 `listBooks(` 之前，零请求）；模板非管理员只渲染提示（`v-if="!canManage"` ＋ `data-books-denied`，管理内容走 `v-else`）', {
  gateCountAtLeast: true,
  refreshGatedBeforeRequest: true,
  deniedPanel: true,
  adminOnlyBranch: true,
  deniedHook: true
}, {
  gateCountAtLeast: bookIndexJudge.gateCount >= 2,
  refreshGatedBeforeRequest: bookIndexJudge.refreshGatedBeforeRequest,
  deniedPanel: bookIndexJudge.deniedPanel,
  adminOnlyBranch: bookIndexJudge.adminOnlyBranch,
  deniedHook: bookIndexJudge.deniedHook
})

const detailJudge = judgeDetailHooks(read('src/views/SealDetailView.vue'))
check('C4', '详情页挂书钩子**只用 `data-action`**（`assign-face-image-book` / `assign-whole-seal-image-book` 各 1）；face 图与整章图两块均带 `v-if="canAssignBook"`（管理员门）；两块的 DOM 内**零 `data-admin-action`**（该族仍 12 值）', {
  faceAction: 1,
  wholeAction: 1,
  faceGated: true,
  wholeGated: true,
  adminActionInBlocks: 0
}, {
  faceAction: detailJudge.faceAction,
  wholeAction: detailJudge.wholeAction,
  faceGated: detailJudge.faceGated,
  wholeGated: detailJudge.wholeGated,
  adminActionInBlocks: detailJudge.adminActionInBlocks
})

const cardJudge = judgeCardDto()
/* C5 冻结期望（**16 键**；本单 14 → 16。`dtoBookIdHits: 0` 属「不得改弱」判据，**一字不动**）。 */
const C5_EXPECTED = {
  serverCount: 16,
  clientCount: 16,
  sameSet: true,
  serverHasBookId: false,
  clientHasBookId: false,
  dtoBookIdHits: 0
}
check('C5', '普通用户零泄漏：卡片 DTO **16 键不变**（服务端 `CARD_ROW_KEYS` ＋ 客户端 `SEAL_CARD_ROW_KEYS` 同集），且三处 DTO 文件里 `book_id` **0 命中**', C5_EXPECTED, cardJudge)
/* **C5n 负对照（键面类）**：把服务端 / 客户端两处键数打回 14 喂**同一条**判据 ⇒ 必须判红；
   真实 16 / 16 读数 ⇒ 判绿。判据本体一字未改（只换喂进去的读数）。 */
{
  const mutant14 = Object.assign({}, cardJudge, { serverCount: 14, clientCount: 14 })
  check('C5n', '负对照：`serverCount/clientCount` 14 喂 C5 同一判据 ⇒ **判红**；16 / 16 ⇒ **判绿**（`dtoBookIdHits` 仍 0）', {
    mutantRed: true,
    realGreen: true,
    mutantServer: 14,
    mutantClient: 14,
    mutantBookIdHits: 0
  }, {
    mutantRed: JSON.stringify(C5_EXPECTED) !== JSON.stringify(mutant14),
    realGreen: JSON.stringify(C5_EXPECTED) === JSON.stringify(cardJudge),
    mutantServer: mutant14.serverCount,
    mutantClient: mutant14.clientCount,
    mutantBookIdHits: mutant14.dtoBookIdHits
  })
}

/* --------------------------------- D 行为（离线桩） ---------------------- */
section('D', '行为（离线桩，零网络零库）：发号递增 / 幂等 / 未收录作者零写 / 年份越界零写 / 挂书读回 / 清空 / 书不存在 / 清单升序')

check('D1', '首本 ⇒ `00001`（五位纯数字、服务端发号；回包恰 `{ok, book_id}`）', { ok: true, book_id: '00001', keys: ['book_id', 'ok'] }, {
  ok: lifecycle.r1.ok === true,
  book_id: lifecycle.r1.ok === true ? lifecycle.r1.book_id : null,
  keys: sorted(Object.keys(lifecycle.r1))
})

check('D2', '第二本 ⇒ `00002`（号源递增、**不重号**：两行并存）', { ok: true, book_id: '00002', rows: 2, ids: ['00001', '00002'] }, {
  ok: lifecycle.r2.ok === true,
  book_id: lifecycle.r2.ok === true ? lifecycle.r2.book_id : null,
  rows: lifecycle.step2.size,
  ids: lifecycle.ids.slice(0, 2)
})

check('D3', '幂等不回建：同 name ＋ 同 author 重投 ⇒ 回 `00001` ＋ `skipped:true`，行数不增、零发号、零写', {
  book_id: '00001',
  skipped: true,
  rows: 2,
  issueDelta: 0,
  persistDelta: 0
}, {
  book_id: lifecycle.r3.ok === true ? lifecycle.r3.book_id : null,
  skipped: lifecycle.r3.skipped === true,
  rows: lifecycle.step3.size,
  issueDelta: lifecycle.step3.issueDelta,
  persistDelta: lifecycle.step3.persistDelta
})

check('D4', '未收录作者 ⇒ 拒（`INVALID_VALUE`）且**零写**（行数 0 / 零 persist / 零发号）；同名异作者 ⇒ 另立一本（幂等键含作者）', {
  ok: false,
  reason: REASONS.INVALID_VALUE,
  rows: 0,
  persist: 0,
  issue: 0,
  sameNameOtherAuthor: '00003'
}, {
  ok: authorGate.unknown.ok,
  reason: authorGate.unknown.reason,
  rows: authorGate.unknown.size,
  persist: authorGate.unknown.persist,
  issue: authorGate.unknown.issue,
  sameNameOtherAuthor: lifecycle.r4.ok === true ? lifecycle.r4.book_id : null
})

check('D5', '年份越界 ⇒ 拒（`INVALID_VALUE`）且零写；下限 `1000` 与当年接受', {
  aboveMax: { ok: false, reason: REASONS.INVALID_VALUE, persist: 0 },
  belowMin: { ok: false, reason: REASONS.INVALID_VALUE, persist: 0 },
  minYear: true,
  currentYear: true
}, {
  aboveMax: { ok: fieldGate.aboveMax.ok, reason: fieldGate.aboveMax.reason, persist: fieldGate.aboveMax.persist },
  belowMin: { ok: fieldGate.belowMin.ok, reason: fieldGate.belowMin.reason, persist: fieldGate.belowMin.persist },
  minYear: fieldGate.minYear.ok,
  currentYear: fieldGate.currentYear.ok
})

const readback = await probeReadback(booksModule0())
check('D6', '挂书**读回比对**：写后回包 `book_id` ＝ 读回值且库内同值（`{ok, image_id, book_id}`）；**写不生效（读回不一致）⇒ 必拒**（`STORAGE_UNAVAILABLE`，绝不报假成功）', {
  ok: true,
  echo: '00002',
  stored: '00002',
  keys: ['book_id', 'image_id', 'ok'],
  mismatch: { ok: false, reason: REASONS.STORAGE_UNAVAILABLE, stored: null }
}, {
  ok: readback.ok,
  echo: readback.okEcho,
  stored: readback.okStored,
  keys: readback.okKeys,
  mismatch: { ok: readback.mismatchOk, reason: readback.mismatchReason, stored: readback.mismatchStored }
})

check('D7', '清空 ⇒ `ok:true` 且回包 / 库内 ``book_id`` 均 `null`（一对多、单值；非数组）', { ok: true, echo: null, stored: null }, {
  ok: readback.clearOk,
  echo: readback.clearEcho,
  stored: readback.clearStored
})

check('D8', '书不存在 ⇒ 拒（`INVALID_VALUE`）＋ **零写**（库内仍是未归属）', { ok: false, reason: REASONS.INVALID_VALUE, persist: 0, stored: null }, {
  ok: readback.ghostOk,
  reason: readback.ghostReason,
  persist: readback.ghostPersist,
  stored: readback.ghostStored
})

check('D9', '`listBooks` 升序：乱序入库（`00003` / `00001` / `00002`）⇒ 回 `00001|00002|00003`，`total` ＝ 3', { ids: ['00001', '00002', '00003'], total: 3 }, {
  ids: listProbe.ids,
  total: listProbe.total
})

/* --------------------------------- E 变异负对照 -------------------------- */
section('E', '变异负对照：判据必须会响（只在内存副本上改，落盘仅到临时目录，不写被测件）')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-books-'))
const mutatedFiles = []
/** 内存改过的 `lib/books.js` 副本（改 `require` 为绝对路径 ⇒ 相对 `./config.js` / `./ops.js` 仍可解）。 */
function loadBooksVariant(label, source) {
  const file = path.join(scratch, `books-${label}.cjs`)
  const rewritten = source
    .split(`require('./config.js')`).join(`require(${JSON.stringify(CONFIG_PATH)})`)
    .split(`require('./ops.js')`).join(`require(${JSON.stringify(OPS_PATH)})`)
  fs.writeFileSync(file, rewritten)
  mutatedFiles.push(file)
  delete require_.cache[file]
  return require_(file)
}
function mutate(source, from, to) {
  if (!source.includes(from)) throw new Error(`变异锚点未命中：${from.slice(0, 70)}`)
  return source.split(from).join(to)
}
function cleanupScratch() {
  try {
    for (const file of mutatedFiles) delete require_.cache[file]
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响判据 */
  }
}

/* ① 发号回归固定号 ⇒ D2 必红 */
const e1Source = mutate(booksSource, 'const bookId = bookIdOf(issued.no)', 'const bookId = bookIdOf(1)')
const e1Life = await probeLifecycle(loadBooksVariant('fixed-no', e1Source))
check('E1', '负对照 ①：发号改成回归固定号 `bookIdOf(1)` ⇒ **D2 必红**（第二本仍回 `00001`、两行退化为一行）', {
  mutationApplied: true,
  d2Red: true,
  secondIdDiffersFromExpected: true
}, {
  mutationApplied: e1Source !== booksSource,
  d2Red: !(e1Life.r2.ok === true && textOf(e1Life.r2.book_id) === '00002'),
  secondIdDiffersFromExpected: !(e1Life.r2.ok === true && textOf(e1Life.r2.book_id) === '00002')
})

/* ② 去掉读回比对直接返回 ok ⇒ D6 必红（构造写不生效的桩） */
const e2Source = mutate(
  booksSource,
  "  const writtenBookId = imageBookIdOf(readback[0])\n  if (writtenBookId !== targetBookId) {",
  '  const writtenBookId = targetBookId\n  if (false) {'
)
const e2Readback = await probeReadback(loadBooksVariant('no-readback', e2Source))
check('E2', '负对照 ②：去掉读回比对（直接回请求值）⇒ **D6 必红**（写不生效时仍报 `ok:true` ＝ 假成功）', {
  mutationApplied: true,
  d6Red: true,
  falseSuccess: true
}, {
  mutationApplied: e2Source !== booksSource,
  d6Red: e2Readback.mismatchOk !== false,
  falseSuccess: e2Readback.mismatchOk === true
})

/* ③ 去掉作者存在性校验 ⇒ D4 必红 */
const e3Source = mutate(
  booksSource,
  `  const personRow = await ops.readPersonRow(authorPersonIdIn)
  if (!personRow) {
    return deny(
      REASONS.INVALID_VALUE,
      \`作者（author_person_id：\${authorPersonIdIn}）尚未收入印人庫 ⇒ 拒絕建書；\` +
        '請先提交印人提案並經採納；本次零寫入。'
    )
  }
  const authorIdOfRow = text(personRow.id) || text(personRow.code)`,
  `  const personRow = (await ops.readPersonRow(authorPersonIdIn)) || { id: authorPersonIdIn }
  const authorIdOfRow = text(personRow.id) || text(personRow.code) || authorPersonIdIn`
)
const e3Author = await probeAuthorGate(loadBooksVariant('no-author-gate', e3Source))
check('E3', '负对照 ③：去掉作者存在性校验 ⇒ **D4 必红**（未收录 id 被放行、自由文本进库）', {
  mutationApplied: true,
  d4Red: true,
  unknownAccepted: true
}, {
  mutationApplied: e3Source !== booksSource,
  d4Red: e3Author.unknown.ok !== false,
  unknownAccepted: e3Author.unknown.ok === true
})

/* ④ 放宽 `book_id` 正则 ⇒ A6 必红 */
const e4Source = mutate(booksSource, 'const BOOK_ID_PATTERN = /^\\d{5}$/', 'const BOOK_ID_PATTERN = /^.*$/')
const e4Guards = await probeSetImageGuards(loadBooksVariant('loose-pattern', e4Source))
check('E4', '负对照 ④：`book_id` 正则放宽成任意串 ⇒ **A6 必红**（`1234` 不再走「五位純數字」形态门）', {
  mutationApplied: true,
  a6Red: true,
  patternChanged: true,
  fourDigitsFormDenied: false
}, {
  mutationApplied: e4Source !== booksSource,
  a6Red: e4Guards.patternSource !== '^\\d{5}$' && e4Guards.fourDigits.formMessage === false,
  patternChanged: e4Guards.patternSource !== '^\\d{5}$',
  fourDigitsFormDenied: e4Guards.fourDigits.formMessage
})

/* ⑤ 原样全绿（正对照） */
check('E5', '负对照 ⑤（正对照）：**不改**源 ⇒ D2 / D6 / D4 / A6 四条判据全部为绿（证明前面四条红只由变异造成）', {
  d2Green: true,
  d6Green: true,
  d4Green: true,
  a6Green: true
}, {
  d2Green: lifecycle.r2.ok === true && textOf(lifecycle.r2.book_id) === '00002',
  d6Green: readback.mismatchOk === false && readback.mismatchReason === REASONS.STORAGE_UNAVAILABLE,
  d4Green: authorGate.unknown.ok === false && authorGate.unknown.reason === REASONS.INVALID_VALUE,
  a6Green: setGuards.patternSource === '^\\d{5}$' && setGuards.fourDigits.formMessage === true
})

/* ---------------------------------------------------------------- 收尾 */
cleanupScratch()

const total = results.length
const failedIds = results.filter((item) => !item.pass).map((item) => item.id)
console.log(
  JSON.stringify({
    summary: { total, passed: total - failedIds.length, failed: failedIds.length },
    sections: sectionStats,
    failed_ids: failedIds,
    note:
      '静态面只读源码文本（先剥注释、引号感知）；行为面用 require.cache 注入假 lib/ops.js 跑真实 lib/books.js' +
      '（零网络、零 SDK、零库、零生产数据）；E 段变异只在内存副本上做，临时文件落 TMPDIR 后即删。'
  })
)
/* 退出码 ＝ 失败数（0 ⇒ 全绿；>0 ⇒ 失败条数，封顶 255）。 */
process.exit(Math.min(failedIds.length, 255))

/* 占位：`booksModule0()` 让 A 段与 E 段共用「已缓存真模块」的取法（首次 require，后续命中缓存）。 */
function booksModule0() {
  if (!require_.cache[BOOKS_PATH]) require_(BOOKS_PATH)
  return require_(BOOKS_PATH)
}
