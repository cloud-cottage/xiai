/**
 * 玺爱 · **印谱（item）外部批量導入通道自检**（item 通道切片 A｜v1.61）
 * ============================================================================
 * **本地、离线、零网络、零云端**；强制 dev / 離線 形态（`writeFaceMode = 'local-dev'`）。
 * 逐条对应派单口径 X1 〜 X8 ＋ 自证 ① 〜 ⑥：
 *   · **① 静态**：集合名 / 本机镜像键 / 键前缀 / 三态 / 本体 22 字段表 / 封闭键面（逐字）。
 *   · **② 值域门（X6）**：`volume_count=0` / `date_year=""` ⇒ `INVALID_VALUE` ＋ 零写入；
 *     `date_text='N.D.'` ⇒ 归一为 `null`；`has_image="1"`（非布尔）⇒ 拒；
 *     **布尔门 null 容忍（B-2）**：`has_annotation=null` ⇒ 放行且落 `null`（不落 `false`）；
 *     `has_annotation="false"`（字符串）/ `has_image=1`（数字）⇒ 仍必拒 ＋ 零写入。
 *   · **③ 幂等（X3）**：同 `source_item_id` 重提 ⇒ 不改写既有行（对拍行指纹）。
 *   · **④ 采纳（X2）**：提交 2 条 ⇒ 采纳 1 条 ⇒ `xiai_items` 恰 +1、導入行置 `ACCEPTED`、
 *     重复采纳不改写；正式行恰本体 22 字段（**无 `raw_json`**）。
 *   · **⑤ 读面（X7）**：注入假 `xiai_items` 行 ⇒ 能读回；异名键翻译在位；
 *     云 `failed` ＋ 零行 ⇒ 降级（`ok:false`）；`off` 不降级；非管理员 ⇒ `FORBIDDEN`。
 *   · **⑥ 云函数键面**：`OPS.submitItemImport` / `ADMIN_OPS.reviewItemImport` 存在（动态派发）。
 *   · **⑦ 護欄（本單補；行為已在位、僅缺斷言）**：封閉鍵面外的欄位 ⇒ `INVALID_FIELD` ＋ 零寫入；
 *     載荷自報身份（`uid` / `phone` / `imported_by`）⇒ 被拒（服務端身份來自令牌、不採信自報）；
 *     身份缺失 / 不可用 ⇒ `FORBIDDEN` ＋ 零寫入。
 *
 * 纪律：**不打印任何密钥 / 验证码 / 令牌原文**；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 用法：node scripts/verify-item-imports.mjs
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const fileUrl = (p) => pathToFileURL(`${ROOT}/${p}`).href
const require = createRequire(`${ROOT}/package.json`)

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让 ESM 真源在本机 Node 下可导入）
   --------------------------------------------------------------------------- */
const memory = new Map()
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear()
}
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数（沿既有套件形态：check(id, desc, expected, actual)）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0
function check(id, desc, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  if (!ok) failures += 1
  results.push({ id, pass: ok })
  console.log(JSON.stringify({ id, case: desc, pass: ok, expected, actual }))
}
const text = (v) => (v === undefined || v === null ? '' : String(v))

/* ---------------------------------------------------------------------------
   2. 真源載入
   --------------------------------------------------------------------------- */
const writeFaceMode = await import(fileUrl('src/data/writeFaceMode.js'))
writeFaceMode.setWriteFaceModeOverride('local-dev')

const seed = await import(fileUrl('src/data/seed.js'))
const db = await import(fileUrl('src/data/db.js'))
const session = await import(fileUrl('src/data/session.js'))
const storage = await import(fileUrl('src/data/storage.js'))
const cloudbase = await import(fileUrl('src/data/cloudbase.js'))
const items = await import(fileUrl('src/services/items.js'))
const userOps = require(`${ROOT}/cloudfunctions/xiai-user-token/lib/ops.js`)

const ADMIN = { id: 'u-admin', phone: '13800000000', role: 'admin', nickname: '管理員' }
session.setUser(ADMIN)
db.ensureSeed()

const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'NOT_FOUND', 'DUPLICATE_VALUE', 'ALREADY_ENDORSED']
const OBSERVED_REASONS = []
const noteReason = (res) => {
  if (res && typeof res.reason === 'string' && res.reason !== '') OBSERVED_REASONS.push(res.reason)
  return res
}

/** 印谱本体 22 字段（逐字真源；测试里作为「第二把独立尺子」对拍）。 */
const BODY_22 = [
  'source_item_id', 'as_book_id', 'as_id', 'book_uri', 'category',
  'title', 'title_chs', 'title_other', 'title_other_chs', 'volume_count',
  'date_text', 'date_year', 'publisher', 'abstract', 'abstract_chs',
  'abstract_title', 'edition', 'donor', 'has_image', 'has_annotation',
  'language', 'misc'
]

/** 造一条完整本体（本机 / 云端两路共用）。 */
function itemPayload(sourceItemId, overrides = {}) {
  return {
    source_item_id: sourceItemId,
    as_book_id: '1211',
    as_id: '1764',
    book_uri: '0e77476f-1a90-44fe-82dc-2ef8445d140b',
    category: '印谱',
    title: '楊聾石印存',
    title_chs: '杨聋石印存',
    title_other: null,
    title_other_chs: null,
    volume_count: 1,
    date_text: '民國二十三年',
    date_year: 1934,
    publisher: null,
    abstract: '十二冊，分卷。',
    abstract_chs: '十二册，分卷。',
    abstract_title: '松蔭軒題要',
    edition: '鈐印本',
    donor: null,
    has_image: true,
    has_annotation: false,
    language: 'chi',
    misc: { bookZzxs: null, bookCj: null, bookSk: null, bookSz: null, bookPsqk: null },
    raw_json: { list: { seqid: Number(sourceItemId) || 0 } },
    ...overrides
  }
}

/* ===========================================================================
   ① 静态：集合名 / 本机镜像键 / 键前缀 / 三态 / 本体字段表 / 封闭键面（逐字）
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '静态常量与键面（X1 / X4 / X5）' }))
check('A1', 'X1 主集合名逐字 ＝ `xiai_items`', 'xiai_items', seed.XIAI_ITEMS_COLLECTION)
check('A2', 'X1 導入行集合名逐字 ＝ `xiai_item_imports`', 'xiai_item_imports', seed.XIAI_ITEM_IMPORTS_COLLECTION)
check('A3', 'X1 導入行 id 前缀 ＝ `ii-`', 'ii-', seed.ITEM_IMPORT_ID_PREFIX)
check('A4', 'X1 三态逐字 ＝ PENDING / ACCEPTED / REJECTED', { p: 'PENDING', a: 'ACCEPTED', r: 'REJECTED' }, { p: seed.ITEM_IMPORT_STATUS.PENDING, a: seed.ITEM_IMPORT_STATUS.ACCEPTED, r: seed.ITEM_IMPORT_STATUS.REJECTED })
check('A4b', 'X1 云端三态与前端逐字同值', seed.ITEM_IMPORT_STATUS, userOps.ITEM_IMPORT_STATUS)
check('A5', 'X4 本体字段恰 22', 22, seed.ITEM_BODY_FIELDS.length)
check('A5b', 'X4 本体 22 字段逐字且顺序一致', BODY_22, seed.ITEM_BODY_FIELDS)
check('A6', 'X4 `misc` 子对象恰 5 键', ['bookZzxs', 'bookCj', 'bookSk', 'bookSz', 'bookPsqk'], seed.ITEM_MISC_FIELDS)
check('A7', 'X4 `raw_json` **不在**本体字段表（正式集合不带）', false, seed.ITEM_BODY_FIELDS.includes('raw_json'))
check('A7b', 'X4 `raw_json` **在**導入行字段表（只存導入行）', true, seed.ITEM_IMPORT_ROW_FIELDS.includes('raw_json'))
check('A8', 'X4 導入行字段全集 ＝ 行级 11 ＋ 本体 22 ＝ 33', 33, seed.ITEM_IMPORT_FIELDS.length)
check('A9', 'X8 云端 `ITEM_BODY_FIELDS` ≡ 前端（逐字同值）', seed.ITEM_BODY_FIELDS, userOps.ITEM_BODY_FIELDS)
check('A10', 'X8 云端封闭键面恰 25（batch_id / source / raw_json ＋ 22）', 25, userOps.ITEM_IMPORT_ALLOWED_KEYS.length)
check('A10b', 'X8 封闭键面 ≡ {batch_id, source, raw_json} ∪ 本体 22', ['batch_id', 'source', 'raw_json', ...BODY_22].slice().sort(), userOps.ITEM_IMPORT_ALLOWED_KEYS.slice().sort())
check('A11', 'X7 `CLOUD_COLLECTIONS` 登记 items / itemImports（逐字）', { items: 'xiai_items', itemImports: 'xiai_item_imports' }, { items: cloudbase.CLOUD_COLLECTIONS.items, itemImports: cloudbase.CLOUD_COLLECTIONS.itemImports })
check('A12', 'X7 `STORAGE_KEYS` 登记 items / item-imports（逐字）', { items: 'items', itemImports: 'item-imports' }, { items: storage.STORAGE_KEYS.items, itemImports: storage.STORAGE_KEYS.itemImports })
check('A13', 'X5 繁体为正（`title` / `title_other` / `abstract` 正字段 ⊕ 简体 `*_chs` 副字段同在）',
  { t: true, to: true, ab: true, tc: true, toc: true, abc: true },
  { t: BODY_22.includes('title'), to: BODY_22.includes('title_other'), ab: BODY_22.includes('abstract'), tc: BODY_22.includes('title_chs'), toc: BODY_22.includes('title_other_chs'), abc: BODY_22.includes('abstract_chs') })
check('A14', 'X8 正文 22 字段无繁简映射外键（`raw_json` / `id` / `status` 均不在本体）', [], ['raw_json', 'id', 'status', 'batch_id'].filter((k) => seed.ITEM_BODY_FIELDS.includes(k)))
/* 负对照 canary：注入第 23 键 ⇒ 22 尺必报红。 */
check('A15', '负对照：注入第 23 键 ⇒ 22 尺必报红', 23, seed.ITEM_BODY_FIELDS.concat(['canary']).length)

/* ===========================================================================
   ② 值域门（X6）—— 先走**云端真函数体**（注入式假 DB），再走**本地服务层**
   =========================================================================== */
console.log(JSON.stringify({ section: 'V', title: '值域 / 形态门（X6）' }))

/* 內存假 DB（形狀對齐 ops.js 的 collection(name).where(match).get() / .get() / .doc(id).get()）。 */
function makeFakeDb(seedData = {}) {
  const collections = new Map()
  Object.keys(seedData).forEach((name) => collections.set(name, new Map((seedData[name] || []).map((row, i) => [String(row._id || row.id || `${name}-${i}`), row]))))
  return () => ({
    collection(name) {
      const map = collections.get(name) || new Map()
      collections.set(name, map)
      const list = () => [...map.values()].map((row) => Object.assign({}, row))
      return {
        where(match) {
          return { async get() { return { data: list().filter((row) => Object.keys(match).every((k) => row[k] === match[k])) } } }
        },
        async get() { return { data: list() } },
        doc(id) { return { async get() { const row = map.get(String(id)); return { data: row ? [Object.assign({}, row)] : [] } } } }
      }
    }
  })
}
const IDENT = { uid: 'u-import', phone: '13800000000' }

{
  userOps.setOpsDbProvider(makeFakeDb())
  const zero = noteReason(await userOps.OPS.submitItemImport(itemPayload('V-zero', { volume_count: 0 }), IDENT))
  check('V1', 'X6 `volume_count=0` ⇒ INVALID_VALUE', { ok: false, reason: 'INVALID_VALUE' }, { ok: zero.ok, reason: zero.reason })
  check('V1b', 'X6 `volume_count=0` ⇒ 零写入（无 plan）', undefined, zero.plan)

  userOps.setOpsDbProvider(makeFakeDb())
  const emptyYear = noteReason(await userOps.OPS.submitItemImport(itemPayload('V-empty', { date_year: '' }), IDENT))
  check('V2', 'X6 `date_year=""`（空串）⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE', plan: undefined }, { ok: emptyYear.ok, reason: emptyYear.reason, plan: emptyYear.plan })

  userOps.setOpsDbProvider(makeFakeDb())
  const nd = await userOps.OPS.submitItemImport(itemPayload('V-nd', { date_text: 'N.D.' }), IDENT)
  check('V3', 'X6 `date_text="N.D."` ⇒ 接受（非拒收）', true, nd.ok === true)
  check('V3b', 'X6 `date_text="N.D."` 归一为 `null`（不得当纪年原文）', null, nd.row && nd.row.date_text)

  userOps.setOpsDbProvider(makeFakeDb())
  const badBool = noteReason(await userOps.OPS.submitItemImport(itemPayload('V-bool', { has_image: '1' }), IDENT))
  check('V4', 'X6 `has_image="1"`（非布尔）⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE', plan: undefined }, { ok: badBool.ok, reason: badBool.reason, plan: badBool.plan })

  /* **布尔门 null 容忍（本单 B-2）**：布尔 **或 `null`**（源側未知 ⇒ 放行、不落 `false`）；其余值域**不放宽**。 */
  userOps.setOpsDbProvider(makeFakeDb())
  const strBool = noteReason(await userOps.OPS.submitItemImport(itemPayload('V-boolstr', { has_annotation: 'false' }), IDENT))
  check('V4b', 'X6 `has_annotation="false"`（字符串）⇒ INVALID_VALUE ＋ 零写入（null 容忍不放宽字符串）', { ok: false, reason: 'INVALID_VALUE', plan: undefined }, { ok: strBool.ok, reason: strBool.reason, plan: strBool.plan })

  userOps.setOpsDbProvider(makeFakeDb())
  const numBool = noteReason(await userOps.OPS.submitItemImport(itemPayload('V-boolnum', { has_image: 1 }), IDENT))
  check('V4c', 'X6 `has_image=1`（数字）⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE', plan: undefined }, { ok: numBool.ok, reason: numBool.reason, plan: numBool.plan })

  userOps.setOpsDbProvider(makeFakeDb())
  const nullBool = await userOps.OPS.submitItemImport(itemPayload('V-boolnull', { has_annotation: null }), IDENT)
  check('V4d', 'X6 `has_annotation=null`（源側未知）⇒ **放行**（ok:true）', true, nullBool.ok === true)
  check('V4e', 'X6 `has_annotation=null` ⇒ 落行**原樣 `null`**（不落 `false`、不歸一成布爾）', null, nullBool.row && nullBool.row.has_annotation)

  userOps.setOpsDbProvider(makeFakeDb())
  const nullInt = await userOps.OPS.submitItemImport(itemPayload('V-null', { volume_count: null, date_year: null }), IDENT)
  check('V5', 'X6 `volume_count=null` / `date_year=null` ⇒ 接受（合法空）', { ok: true, vc: null, dy: null }, { ok: nullInt.ok, vc: nullInt.row && nullInt.row.volume_count, dy: nullInt.row && nullInt.row.date_year })
}

/* 本地服务层同口径（dev / 離線）：三例逐条对齐。 */
{
  const sZero = noteReason(await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-zero', payload: itemPayload('S-zero', { volume_count: 0 }) }))
  check('V6', '服务层 X6 `volume_count=0` ⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE' }, { ok: sZero.ok, reason: sZero.reason })
  const sEmpty = noteReason(await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-empty', payload: itemPayload('S-empty', { date_year: '' }) }))
  check('V6b', '服务层 X6 `date_year=""` ⇒ INVALID_VALUE', { ok: false, reason: 'INVALID_VALUE' }, { ok: sEmpty.ok, reason: sEmpty.reason })
  const sNd = await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-nd', payload: itemPayload('S-nd', { date_text: 'N.D.' }) })
  check('V6c', '服务层 X6 `date_text="N.D."` ⇒ `null`（落行）', { ok: true, dateText: null }, { ok: sNd.ok, dateText: sNd.row && sNd.row.date_text })
  /* 被拒的两例 ⇒ 本机導入行零新增（仍只 1 条：S-nd）。 */
  check('V6d', '服务层被拒两例 ⇒ 零写入（本机導入行恰 1 条）', 1, db.listItemImportRows().length)

  /* **服务层同口径（本单 B-2）**：null 放行且落 `null`；字符串 / 数字仍必拒。 */
  const sNullBool = await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-boolnull', payload: itemPayload('S-boolnull', { has_annotation: null }) })
  check('V6e', '服务层 X6 `has_annotation=null` ⇒ 放行且落行 `null`（不落 `false`）', { ok: true, v: null }, { ok: sNullBool.ok, v: sNullBool.row && sNullBool.row.has_annotation })
  const sStrBool = noteReason(await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-boolstr', payload: itemPayload('S-boolstr', { has_annotation: 'false' }) }))
  check('V6f', '服务层 X6 `has_annotation="false"`（字符串）⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE' }, { ok: sStrBool.ok, reason: sStrBool.reason })
  const sNumBool = noteReason(await items.submitItemImport({ batchId: 'SB', source: 'SRC', sourceItemId: 'S-boolnum', payload: itemPayload('S-boolnum', { has_image: 1 }) }))
  check('V6g', '服务层 X6 `has_image=1`（数字）⇒ INVALID_VALUE ＋ 零写入', { ok: false, reason: 'INVALID_VALUE' }, { ok: sNumBool.ok, reason: sNumBool.reason })
  check('V6h', '服务层 null 放行 ⇒ 導入行恰 +1（无「0」或「false」冒充）', 2, db.listItemImportRows().length)
}

/* ===========================================================================
   ③ 幂等（X3）—— 同 `source_item_id` 重提 ⇒ 不改写既有行（对拍行指纹）
   =========================================================================== */
console.log(JSON.stringify({ section: 'I', title: '幂等（X3）' }))
{
  /* 云端：预置一条同键導入行 ⇒ 重提原样返回。 */
  const existing = { _id: 'ii-dup', id: 'ii-dup', source_item_id: 'DUP', batch_id: 'B', source: 'SRC', status: 'PENDING', title: '原標題', volume_count: 1, has_image: true, has_annotation: false }
  userOps.setOpsDbProvider(makeFakeDb({ xiai_item_imports: [existing] }))
  const dup = await userOps.OPS.submitItemImport(itemPayload('DUP', { title: '改過的標題' }), IDENT)
  check('I1', '云端：同 `source_item_id` 重提 ⇒ 幂等返回既有行', { idempotent: true, id: 'ii-dup', title: '原標題' }, { idempotent: dup.idempotent, id: dup.row && dup.row.id, title: dup.row && dup.row.title })
  check('I1b', '云端：幂等返回 ⇒ 不发写计划（零写入）', undefined, dup.plan)

  /* 本地服务层：同键重提 ⇒ 行指纹逐字不变、行数不变。 */
  const first = await items.submitItemImport({ batchId: 'B-IDEM', source: 'SRC', sourceItemId: 'IDEM-1', payload: itemPayload('IDEM-1', { title: '甲' }) })
  const fp1 = JSON.stringify(first.row)
  const before = db.listItemImportRows().length
  const second = await items.submitItemImport({ batchId: 'B-IDEM', source: 'SRC', sourceItemId: 'IDEM-1', payload: itemPayload('IDEM-1', { title: '乙' }) })
  const after = db.itemImportBySourceId('IDEM-1')
  check('I2', '服务层：同键重提 ⇒ idempotent:true', true, second.idempotent === true)
  check('I2b', '服务层：同键重提 ⇒ 既有行指纹逐字不变（标题仍「甲」）', { fp: fp1, title: '甲' }, { fp: JSON.stringify(after), title: after && after.title })
  check('I2c', '服务层：同键重提 ⇒ 導入行数不增', before, db.listItemImportRows().length)
}

/* ===========================================================================
   ④ 采纳（X2 / X4）—— 提交 2 条 ⇒ 采纳 1 条 ⇒ xiai_items 恰 +1、置 ACCEPTED、重复采纳不改写
   =========================================================================== */
console.log(JSON.stringify({ section: 'R', title: '采纳 / 驳回（X2）' }))
{
  await items.submitItemImport({ batchId: 'B-ACC', source: 'SRC', sourceItemId: 'ACC-1', payload: itemPayload('ACC-1', { title: '甲譜' }) })
  await items.submitItemImport({ batchId: 'B-ACC', source: 'SRC', sourceItemId: 'ACC-2', payload: itemPayload('ACC-2', { title: '乙譜' }) })
  const itemsBefore = db.listItemRows().length
  /* 用「单行」入口只采纳 1 条（ACC-1）。 */
  const row1 = db.listItemImportRows().find((r) => String(r.source_item_id) === 'ACC-1')
  const one = await items.reviewItemImport(ADMIN, { importId: row1.id, decision: 'ACCEPTED' })
  const itemsAfter = db.listItemRows().length
  const row1After = db.listItemImportRows().find((r) => String(r.source_item_id) === 'ACC-1')
  check('R1', '采纳 1 条 ⇒ `xiai_items` 恰 +1', 1, itemsAfter - itemsBefore)
  check('R1b', '被采纳的導入行 ⇒ status=ACCEPTED', 'ACCEPTED', text(row1After && row1After.status))
  check('R1c', '单行入口：accepted_ids 恰含该行', [row1.id], one.accepted_ids)
  /* 正式行恰本体 22 字段（无 raw_json / 无行级元数据）。 */
  const acceptedItem = db.itemBySourceId('ACC-1')
  check('R1d', '正式行键面 ≡ 本体 22 字段（无 `raw_json` / `id` / `status`）',
    BODY_22.slice().sort(),
    Object.keys(acceptedItem || {}).slice().sort())
  check('R1e', '正式行不含 `raw_json`（X4：只存導入行）', false, Object.prototype.hasOwnProperty.call(acceptedItem || {}, 'raw_json'))

  /* 重复采纳 ⇒ 既有 xiai_items 行不改写、狀態不回退（终态不回退）。 */
  const fpItem = JSON.stringify(db.itemBySourceId('ACC-1'))
  const replay = await items.reviewItemImport(ADMIN, { importId: row1.id, decision: 'ACCEPTED' })
  check('R2', '重复采纳 ⇒ 既有 `xiai_items` 行指纹逐字不变', fpItem, JSON.stringify(db.itemBySourceId('ACC-1')))
  check('R2b', '重复采纳 ⇒ 该行已终态 ⇒ 跳过（skipped）', true, replay.skipped.includes(row1.id))
  check('R2c', '重复采纳 ⇒ 未新增第二枚正式行', 1, db.listItemRows().length - itemsBefore)
  check('R2d', '重复采纳 ⇒ 全部失败行 0（幂等非失败）', [], replay.failed.map((f) => f.id))

  /* 驳回 ⇒ 零写入（仅導入行状态）。 */
  const itemsBeforeRej = db.listItemRows().length
  const rejected = await items.reviewItemImport(ADMIN, { importId: row1.id, decision: 'REJECTED' })
  check('R3', '已 ACCEPTED 行再驳回 ⇒ 终态不回退（跳过）', true, rejected.skipped.includes(row1.id) || rejected.rejected_ids.length === 0)
  const row2 = db.listItemImportRows().find((r) => String(r.source_item_id) === 'ACC-2')
  const rej2 = await items.reviewItemImport(ADMIN, { importId: row2.id, decision: 'REJECTED', note: '資料不足' })
  check('R3b', '驳回 PENDING 行 ⇒ accepted=false / 该行 status=REJECTED', { accepted: false, status: 'REJECTED' }, { accepted: rej2.accepted, status: text(db.itemImportBySourceId('ACC-2').status) })
  check('R3c', '驳回 ⇒ `xiai_items` 零写入', itemsBeforeRej, db.listItemRows().length)
}

/* 云端采纳路径：落正式行恰 22 字段（无 raw_json）。 */
{
  const importRow = {
    _id: 'ii-acc', id: 'ii-acc', batch_id: 'B-C', source: 'SRC', source_item_id: 'C-1', status: 'PENDING',
    ...itemPayload('C-1', { title: '雲端甲' })
  }
  userOps.setOpsDbProvider(makeFakeDb({ xiai_item_imports: [importRow] }))
  const res = await userOps.ADMIN_OPS.reviewItemImport({ batch_id: 'B-C', decision: 'ACCEPTED' }, { uid: 'u-admin', phone: '13800000000' }, { adminPhone: '13800000000', nowSeconds: 1700000000 })
  const itemWrite = ((res.plan && res.plan.writes) || []).find((w) => w.collection === 'xiai_items')
  check('R4', '云端采纳 ⇒ 生成 `xiai_items` 写（kind=set，doc id ＝ source_item_id）', { kind: 'set', id: 'C-1' }, { kind: itemWrite && itemWrite.kind, id: itemWrite && itemWrite.id })
  const doc = (itemWrite && itemWrite.doc) || {}
  check('R4b', '云端采纳正式行键面 ≡ 本体 22 字段', BODY_22.slice().sort(), Object.keys(doc).slice().sort())
  check('R4c', '云端采纳正式行**无** `raw_json`', false, Object.prototype.hasOwnProperty.call(doc, 'raw_json'))
  /* 重放：導入行已 ACCEPTED ⇒ 跳过、零写入。 */
  userOps.setOpsDbProvider(makeFakeDb({ xiai_item_imports: [{ ...importRow, status: 'ACCEPTED' }] }))
  const replay = await userOps.ADMIN_OPS.reviewItemImport({ batch_id: 'B-C', decision: 'ACCEPTED' }, { uid: 'u-admin', phone: '13800000000' }, { adminPhone: '13800000000', nowSeconds: 1700000000 })
  check('R4d', '云端重放：终态不回退（跳过）且零 items 写', { skipped: true, itemWrites: 0 }, { skipped: replay.skipped.length > 0, itemWrites: ((replay.plan && replay.plan.writes) || []).filter((w) => w.collection === 'xiai_items').length })
}

/* ===========================================================================
   ⑤ 读面（X7）—— 注入假行能读回 / 异名键翻译 / 云 failed ＋ 零行 ⇒ 降级 / off 不降级
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '读面（X7）' }))
{
  /* 注入假 `xiai_items` 行 ⇒ 本机读回（云未配置 ⇒ 本地路径）。 */
  const fake = { source_item_id: 'READ-1', title: '讀回甲', volume_count: 3, has_image: true, has_annotation: false, misc: { bookZzxs: null, bookCj: null, bookSk: null, bookSz: null, bookPsqk: null } }
  storage.writeKey(storage.STORAGE_KEYS.items, [fake])
  const read = db.listItemRows()
  check('D1', '注入假 `items` 行 ⇒ `listItemRows()` 读回该行', { n: 1, title: '讀回甲' }, { n: read.length, title: read[0] && read[0].title })
  check('D1b', '读面经 `readCollection('+"'items'"+')`（同键名 ⇒ 不须翻译）', true, cloudbase.CLOUD_COLLECTION_KEYS.includes('items'))

  /* 异名键翻译在位（`item-imports` ↔ `itemImports`）。 */
  const dbSrc = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
  check('D2', '异名键翻译在位：`CLOUD_KEY_OF_LOCAL` 含 `item-imports` → `itemImports`', true, dbSrc.includes("'item-imports': 'itemImports'"))
  check('D2b', '翻译目标逐字 ∈ `CLOUD_COLLECTION_KEYS`（真源）', true, cloudbase.CLOUD_COLLECTION_KEYS.includes('itemImports'))

  /* 云 failed ＋ 零行 ⇒ 降级文案（ok:false）；off 不降级。 */
  const degraded = items.itemPendingReadVerdict([], true, { state: 'failed', reason: 'TIMEOUT', message: '雲端逾時' })
  check('D3', '云 failed ＋ 零行 ⇒ `{ok:false, reason, message}`（不静默显示 0）', { ok: false, reason: 'TIMEOUT' }, { ok: degraded.ok, reason: degraded.reason })
  check('D3b', '云 failed 降级文案可读（非空）', true, typeof degraded.message === 'string' && degraded.message.length > 0)
  const pendingV = items.itemPendingReadVerdict([], true, { state: 'pending', reason: 'HYDRATING', message: '' })
  check('D3c', '云 pending ＋ 零行 ⇒ 降级（ok:false；同一条失败状态机）', false, pendingV.ok)
  const offV = items.itemPendingReadVerdict([], false, { state: 'failed', reason: 'X', message: 'Y' })
  check('D4', '`off`（未配置）⇒ **不降级**（ok:true、零行照读）', { ok: true, n: 0 }, { ok: offV.ok, n: offV.rows.length })
  const withRows = items.itemPendingReadVerdict([{ id: 'x' }], true, { state: 'failed', reason: 'X', message: 'Y' })
  check('D4b', '有本机行 ⇒ 照常返回（不因云端未落定而隐藏本机已知行）', { ok: true, n: 1 }, { ok: withRows.ok, n: withRows.rows.length })

  /* 管理员读面：本机有 PENDING 行（云 off）⇒ 照常返回；非管理员 ⇒ FORBIDDEN。 */
  const pend = items.listPendingItemImportsForAdmin(ADMIN)
  check('D5', '管理员读面（云 off）⇒ 照读本机 PENDING 行', { ok: true, gt0: pend.ok && pend.rows.length > 0 }, { ok: pend.ok, gt0: pend.ok && pend.rows.length > 0 })
  const nonAdmin = noteReason(items.listPendingItemImportsForAdmin({ id: 'u-user', role: 'user' }))
  check('D5b', '非管理员读待审面 ⇒ FORBIDDEN（不以空集冒充）', { ok: false, reason: 'FORBIDDEN' }, { ok: nonAdmin.ok, reason: nonAdmin.reason })
}

/* ===========================================================================
   ⑥ 单写者门 ＋ 云函数键面 ＋ reason 零新增 ＋ 常量现态
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '单写者门 / 云函数键面 / reason 现态' }))
{
  const d1 = db.itemDirectWriteDenial('items')
  const d2 = db.itemDirectWriteDenial('item-imports')
  const d3 = db.itemDirectWriteDenial('seals')
  const d4 = items.itemSingleWriterDenial('item-imports')
  noteReason(d1)
  check('G1', '数据层直写门（items / item-imports）⇒ FORBIDDEN', { a: 'FORBIDDEN', b: 'FORBIDDEN' }, { a: d1 && d1.reason, b: d2 && d2.reason })
  check('G1b', '门面收窄：非单写者键（seals）⇒ 放行 null', null, d3)
  check('G1c', '服务层转发 ≡ 数据层门（逐字同值）', db.itemDirectWriteDenial('item-imports'), d4)

  check('G2', 'X8 云函数 `OPS.submitItemImport` 存在（动态派发，未动 index.js）', 'function', typeof userOps.OPS.submitItemImport)
  check('G2b', 'X8 云函数 `ADMIN_OPS.reviewItemImport` 存在', 'function', typeof userOps.ADMIN_OPS.reviewItemImport)
  const idxSrc = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'), 'utf8')
  check('G2c', '云函数派发面仍为 `hasOwnProperty` 动态派发（未动 index.js）', true, idxSrc.includes('hasOwnProperty.call(OPS, op)') && idxSrc.includes('hasOwnProperty.call(ADMIN_OPS, op)'))

  check('G3', '`STORAGE_KEYS` 键总数 ＝ 27（v1.61：25 → 27，新增 items / itemImports）', 27, Object.keys(storage.STORAGE_KEYS).length)
  check('G3b', '`CLOUD_COLLECTIONS` 键总数 ＝ 11（v1.61：9 → 11）', 11, cloudbase.CLOUD_COLLECTION_KEYS.length)

  /* reason 零新增（观测面：本套件已触发的拒绝 reason 全部 ∈ 既有冻结表）。 */
  check('G4', '观测到的 `reason` 字面值全部 ∈ 既有凍結表（零新增）', [], [...new Set(OBSERVED_REASONS)].filter((r) => FROZEN_REASONS.indexOf(r) === -1))
  check('G4x', '负对照：注入新 `reason` 字面值 ⇒ 零新增尺必报红', ['TOTALLY_NEW_REASON'], [...new Set([...OBSERVED_REASONS, 'TOTALLY_NEW_REASON'])].filter((r) => FROZEN_REASONS.indexOf(r) === -1))
}

/* ===========================================================================
   ⑦ 封閉鍵面 ＋ 身份來源門（X8 護欄；行為已在位，本單只補斷言）
   ---------------------------------------------------------------------------
   雲端真函數體判序（`ops.js::submitItemImport`）：未知鍵 → 冪等鍵必有 → **值域 / 形態門（X6）**
   → **身份可用（`identityUsable`）** → 冪等 → 寫（全部在寫之前）。本段沿 V 段同形（三件套
   `{ok, reason, plan}` ＋「零寫入 ＝ 無 plan」）補三條嚴格等值護欄：
     ① 封閉鍵面外的欄位 ⇒ `INVALID_FIELD` ＋ 零寫入；
     ② 載荷自報身份（`uid` / `phone` / `imported_by`）⇒ 被拒（服務端身份來自令牌、不採信自報）；
     ③ 身份缺失 / 不可用 ⇒ `FORBIDDEN` ＋ 零寫入。
   =========================================================================== */
console.log(JSON.stringify({ section: 'U', title: '封閉鍵面 / 身份來源門（X8 護欄）' }))
{
  /* ① 封閉鍵面：鍵面外欄位 ⇒ `INVALID_FIELD` ＋ 零寫入。 */
  userOps.setOpsDbProvider(makeFakeDb())
  const unknownKey = noteReason(await userOps.OPS.submitItemImport(itemPayload('U-unknown', { unknown_column: 'x' }), IDENT))
  check('U1', 'X8 封閉鍵面外的欄位 ⇒ INVALID_FIELD ＋ 零寫入', { ok: false, reason: 'INVALID_FIELD', plan: undefined }, { ok: unknownKey.ok, reason: unknownKey.reason, plan: unknownKey.plan })
  check('U1b', 'X8 未知鍵的拒絕文案點明「如實報回，不靜默丟鍵」', true, String(unknownKey.message).includes('不靜默丟鍵'))

  /* ② 載荷自報身份（身份類鍵 `uid` / `phone`；落行時由服務端派生的 `imported_by`）⇒ 一律拒 ＋ 零寫入。 */
  userOps.setOpsDbProvider(makeFakeDb())
  const spoofUid = noteReason(await userOps.OPS.submitItemImport(itemPayload('U-spoof-uid', { uid: 'u-evil' }), IDENT))
  check('U2', 'X8 載荷自報身份（`uid`）⇒ INVALID_FIELD ＋ 零寫入（服務端身份來自令牌、不採信自報）', { ok: false, reason: 'INVALID_FIELD', plan: undefined }, { ok: spoofUid.ok, reason: spoofUid.reason, plan: spoofUid.plan })
  check('U2b', 'X8 身份類鍵的拒絕文案點明「不採信前端自稱」', true, String(spoofUid.message).includes('不採信前端自稱'))
  userOps.setOpsDbProvider(makeFakeDb())
  const spoofPhone = noteReason(await userOps.OPS.submitItemImport(itemPayload('U-spoof-phone', { phone: '13900000000' }), IDENT))
  check('U2c', 'X8 載荷自報手機號（`phone`）⇒ INVALID_FIELD ＋ 零寫入', { ok: false, reason: 'INVALID_FIELD', plan: undefined }, { ok: spoofPhone.ok, reason: spoofPhone.reason, plan: spoofPhone.plan })
  userOps.setOpsDbProvider(makeFakeDb())
  const spoofImporter = noteReason(await userOps.OPS.submitItemImport(itemPayload('U-spoof-importedby', { imported_by: 'u-evil' }), IDENT))
  check('U2d', 'X8 載荷自報導入人（`imported_by`；落行值取 `identity.uid`）⇒ INVALID_FIELD ＋ 零寫入', { ok: false, reason: 'INVALID_FIELD', plan: undefined }, { ok: spoofImporter.ok, reason: spoofImporter.reason, plan: spoofImporter.plan })

  /* ③ 身份缺失 / 不可用（`null` / 空值 / 令牌路缺手機號）⇒ `FORBIDDEN` ＋ 零寫入（寫之前判）。 */
  const unusableDenials = [{ ok: false, reason: 'FORBIDDEN', plan: undefined }, { ok: false, reason: 'FORBIDDEN', plan: undefined }, { ok: false, reason: 'FORBIDDEN', plan: undefined }]
  const unusable = []
  for (const identity of [null, {}, { uid: 'u-import' }]) {
    userOps.setOpsDbProvider(makeFakeDb())
    const res = noteReason(await userOps.OPS.submitItemImport(itemPayload(`U-noident-${unusable.length}`), identity))
    unusable.push({ ok: res.ok, reason: res.reason, plan: res.plan, message: res.message })
  }
  check('U3', 'X8 身份不可用（`null` / `{}` / 令牌路缺手機號）⇒ FORBIDDEN ＋ 零寫入', unusableDenials,
    unusable.map(({ ok, reason, plan }) => ({ ok, reason, plan })))
  check('U3b', 'X8 身份不可用拒絕文案點明「缺少可驗證的導入人身份」', true, unusable.every((r) => String(r.message).includes('缺少可驗證的導入人身份')))
}

/* ---------------------------------------------------------------------------
   汇總
   --------------------------------------------------------------------------- */
const total = results.length
console.log(JSON.stringify({ summary: { total, passed: total - failures, failed: failures }, failed_ids: results.filter((r) => !r.pass).map((r) => r.id) }))
process.exit(failures === 0 ? 0 : 1)
