/**
 * 玺爱 · **自检：AI 修復产物影像继承源影像印谱归属（`book_id`）**
 * ============================================================================
 * （`scripts/verify-ai-enhance-book-id.mjs` · AC-891 起 · 派单口径 2026-11-24 Zang 裁定）
 *
 * **本地、离线**（注入式假 DB ＋ 假对象存储 ＋ 假上游 fetch ＋ 假账本；零网络、零云端连接、
 * 零生产数据、零网易云）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhance.js::readInheritedBookId`（**唯一实现点**）
 *   · `lib/aiEnhance.js::enhanceFace` ⑨′ 落库点（**老同步路**）
 *   · `lib/aiEnhanceTasks.js::registerProductImage` ②′ 落库点（**异步主路**）
 *   · `lib/aiEnhanceTasks.js::statusEnhanceTask` ⑥c（生产在用的端到端入册）
 *
 * 断言面（本套 **25** 条）：
 *   A 段 同步路（`ai-enhance-face`）：① 源有 `book_id` ⇒ 产物行 `book_id` **逐字相同**；
 *      ② 源无键 / `null` ⇒ 产物行**没有** `book_id` 键（键面**逐字**＝基线 22 键）；
 *      ③ 脏值 `abc` / `1234` / `123456` ⇒ 不继承；④ 源行读取抛错 ⇒ **仍成功入册**、无
 *      `book_id` ＋ `log.warn` 如实；⑤ 钱路读数（7 发各恰扣 10、零退款、余额 930）。
 *   B 段 异步入册路（`registerProductImage`，**同一函数**）：同矩阵（基线 21 键）＋ 空集降级
 *      ＋ 读取点**恰 1 发**（零 N+1）＋ 段预算两分支（到点不新发读请求 / 读超段预算 ⇒ 无归属
 *      ＋ warn，且**既有超预算收口一字不变**）。
 *   C 段 端到端异步主路（`ai-enhance-status` ⑥c）：任务行推到 `READY`（恰 6 键）＋ 产物行
 *      继承同值 ＋ 任务行 `product_image_id` 逐字同产物 id。
 *   D 段 两路行为一致（⑥）＋ 静态纪律：单实现点唯一、`doc.book_id` 赋值恰 2 处且带 `null`
 *      护栏、剥注释后零 `book_id: null` / 空串落值、幂等注释在场、**钱路零变化**
 *      （`REASONS` 恰 13、reason ⊆ 冻结 13、submit 恰 5 键 / status READY 恰 6 键 /
 *      list 行恰 6 键 / 同步成功 9 键、失败 4 键 / `ADMIN_OPS` 恰 56 项）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥（上游 key 只登记长度）。
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假体：置 `XIAI_NO_REAL_CARD=1`；
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

/* 合成测试环境（缺省才写；**脚本内不写任何真实密钥** —— secret 走运行期随机）。 */
process.env.XIAI_USER_SMS_CODE = String(process.env.XIAI_USER_SMS_CODE || '729341').trim()
if (!process.env.XIAI_USER_TOKEN_SECRET) process.env.XIAI_USER_TOKEN_SECRET = randomHex('user-secret')
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET).trim()
process.env.XIAI_ADMIN_PHONE = String(process.env.XIAI_ADMIN_PHONE || '13800000000').trim()
process.env.XIAI_AI_UPSTREAM_SECRET = randomHex('upstream-secret')

function randomHex(tag) {
  return createHash('sha256').update(`${tag}-${Date.now()}-${Math.random()}`).digest('hex')
}

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const ledger = require(path.join(FN_DIR, 'lib/ledger.js'))
const aiUpstream = require(path.join(FN_DIR, 'lib/aiUpstream.js'))
const aiEnhance = require(path.join(FN_DIR, 'lib/aiEnhance.js'))
const tasks = require(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'))
const { REASONS } = require(path.join(FN_DIR, 'lib/config.js'))

/* --------------------------------------------------------------------------- *
  断言 / 读数（与既有 verify-*.mjs 同形；`expected` / `actual` 深排序后比对 ⇒ 不吃键序）
 * --------------------------------------------------------------------------- */
let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(sortDeep(expected)) === JSON.stringify(sortDeep(actual))
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const countOf = (text, needle) => String(text).split(needle).length - 1
/** 剥注释（块注释 ＋ 行注释）⇒ 静态断言只看真代码，不吃注释里的字面。 */
const stripComments = (raw) => String(raw).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/* --------------------------------------------------------------------------- *
  内存假 DB（形状对齐真实 SDK 使用面；与 `verify-ai-enhance.mjs` 同一只尺）
 * --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  const hooks = { setCalls: [], queries: [], setInterceptor: null }
  const bucketOf = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  function makeQuery(map, state) {
    return {
      orderBy(field, direction) {
        return makeQuery(map, Object.assign({}, state, { order: { field, direction } }))
      },
      skip(count) {
        return makeQuery(map, Object.assign({}, state, { skip: count }))
      },
      limit(count) {
        return makeQuery(map, Object.assign({}, state, { limit: count }))
      },
      async get() {
        await tick()
        let rows = [...map.values()].filter((row) => rowMatches(row, state.match || {})).map((row) => Object.assign({}, row))
        if (state.order) {
          const { field, direction } = state.order
          rows = rows.sort((a, b) => {
            const left = a[field]
            const right = b[field]
            const cmp = left < right ? -1 : left > right ? 1 : 0
            return direction === 'desc' ? -cmp : cmp
          })
        }
        if (state.skip) rows = rows.slice(state.skip)
        if (state.limit) rows = rows.slice(0, state.limit)
        return { data: rows }
      },
      async update(patch) {
        await tick()
        let updated = 0
        for (const row of map.values()) {
          if (rowMatches(row, state.match || {})) {
            Object.assign(row, patch)
            updated += 1
          }
        }
        return { updated }
      }
    }
  }
  const db = {
    bucketOf,
    collection(name) {
      const map = bucketOf(name)
      return {
        doc(id) {
          return {
            async get() {
              await tick()
              const row = map.get(id)
              return { data: row ? Object.assign({}, row) : null }
            },
            async update(patch) {
              await tick()
              const row = map.get(id)
              if (!row) return { updated: 0 }
              Object.assign(row, patch)
              return { updated: 1 }
            },
            async set(doc) {
              await tick()
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              hooks.setCalls.push({ collection: name, id })
              if (hooks.setInterceptor) hooks.setInterceptor({ collection: name, id, doc, bucket: map })
              map.set(id, Object.assign({ _id: id }, doc))
              return { updated: 1 }
            }
          }
        },
        async add(doc) {
          await tick()
          const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : `gen-${map.size + 1}-${Math.random().toString(36).slice(2, 8)}`
          if (map.has(id)) throw new Error('FAKE_DUPLICATE_ID')
          map.set(id, Object.assign({ _id: id }, doc))
          return { _id: id }
        },
        where(match) {
          hooks.queries.push({ collection: name, match })
          return makeQuery(map, { match })
        }
      }
    }
  }
  db.hooks = hooks
  return db
}

const fakeDb = createFakeDb()
const balanceRowOf = (uid) => fakeDb.bucketOf('xiai_balances').get(`bl-${uid}`) || null
const flowRowsOf = (uid) => [...fakeDb.bucketOf('xiai_points_flow').values()].filter((row) => row.uid === uid)

/* 四处注入（生产不注入 ⇒ 走各模块的真句柄；此处全部假体）。 */
ops.setOpsDbProvider(() => fakeDb)
ledger.setLedgerStoreProvider(() => ({
  balances: fakeDb.collection('xiai_balances'),
  flow: fakeDb.collection('xiai_points_flow')
}))
aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))

/* 假对象存储：读缝（对象不存在 ⇒ **抛错**，同缝契约）＋ 上传缝（记录键与字节）。 */
const storageObjects = new Map()
const uploads = []
ops.setOpsStorageProvider(async (cloudPath) => {
  if (!storageObjects.has(cloudPath)) throw new Error('OBJECT_NOT_FOUND')
  return Buffer.from(storageObjects.get(cloudPath))
})
ops.setOpsStorageUploadProvider(async ({ cloudPath, bytes }) => {
  const payload = Buffer.from(bytes)
  storageObjects.set(cloudPath, payload)
  uploads.push({ cloudPath, bytes: payload })
})

/* --------------------------------------------------------------------------- *
  读取点探针：**按 id 读 `xiai_images` 的发数**（零 N+1 证据）＋ **定点抛错**（失败降级用）
 * --------------------------------------------------------------------------- */
const readProbe = { failId: '', failAt: 0, seen: 0, delayId: '', delayMs: 0, counts: new Map() }
const realReadRows = ops.readRows
ops.readRows = async function patchedReadRows(collection, match, options) {
  const id = match && typeof match.id === 'string' ? match.id : ''
  if (id !== '') {
    const key = `${collection}|${id}`
    readProbe.counts.set(key, (readProbe.counts.get(key) || 0) + 1)
    if (collection === ops.COLLECTIONS.images && readProbe.delayId === id && readProbe.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, readProbe.delayMs))
    }
    if (collection === ops.COLLECTIONS.images && readProbe.failId === id) {
      readProbe.seen += 1
      if (readProbe.failAt > 0 && readProbe.seen === readProbe.failAt) {
        throw new Error('OFFLINE_SOURCE_ROW_READ_FAILURE')
      }
    }
  }
  return realReadRows(collection, match, options)
}
const readsOfSource = (sourceId) => readProbe.counts.get(`${ops.COLLECTIONS.images}|${sourceId}`) || 0
const setReadFail = (spec) => {
  readProbe.failId = spec ? spec.id : ''
  readProbe.failAt = spec ? spec.at : 0
  readProbe.seen = 0
}
const setReadDelay = (id, ms) => {
  readProbe.delayId = id || ''
  readProbe.delayMs = Number(ms) || 0
}

/* `log.warn` 捕获（`lib/log.js` 是本仓唯一 `console.*` 落点 ⇒ 这里就是告警面的读数）。 */
const warnLines = []
const realConsoleWarn = console.warn
console.warn = (...args) => {
  warnLines.push(args.map((value) => String(value)).join(' '))
}

/* --------------------------------------------------------------------------- *
  影像字节（**每例唯一 sha256** —— 内容寻址唯一索引不撞车）
 * --------------------------------------------------------------------------- */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngBytesOf = (tag) => Buffer.concat([PNG_MAGIC, Buffer.from(`offline-bookid-${tag}`, 'utf8')])
const objectKeyOf = (digest) => `xiai/images/${digest.slice(0, 2)}/${digest}.png`
/** 源无 `book_id` 键的哨兵（**区别于 `null`** —— 「缺键」与「显式空值」两例都要钉）。 */
const ABSENT = Symbol('book_id-absent')

/** 种一株源影像行（＋内容寻址对象字节）；`bookValue` ＝ 字符串 / `null` / `ABSENT`。 */
function seedSourceImage(imageId, bookValue) {
  const bytes = pngBytesOf(`src-${imageId}`)
  const digest = sha256Hex(bytes)
  const row = {
    _id: imageId,
    id: imageId,
    kind: 'FACE',
    storage: 'server',
    mime: 'image/png',
    sha256: digest,
    bytes: bytes.length,
    created_at: new Date().toISOString()
  }
  if (bookValue !== ABSENT) row.book_id = bookValue
  fakeDb.bucketOf('xiai_images').set(imageId, row)
  storageObjects.set(objectKeyOf(digest), bytes)
  return digest
}

/* 上游注入：同步路（`aiEnhance` 自己的 fetch 缝）直接回 `b64_json`；异步路（`tasks` 的 fetch 缝）
   单查回 `completed` ＋ `result_urls`、下载回产物字节。 */
let currentProductBytes = pngBytesOf('init')
aiEnhance.setAiEnhanceFetchProvider(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ b64_json: currentProductBytes.toString('base64') }] })
}))
const PRODUCT_URL = 'https://cdn.upstream.example/product-bookid.png'
tasks.setTaskFetchProvider(async (url, init) => {
  const method = (init && init.method) || 'GET'
  if (method === 'GET' && url.indexOf('/tasks/') !== -1) {
    return { ok: true, status: 200, json: async () => ({ status: 'completed', result_urls: [PRODUCT_URL] }) }
  }
  if (url.indexOf('https://cdn.upstream.example/') === 0) {
    return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(currentProductBytes).buffer }
  }
  throw new Error(`UNEXPECTED_UPSTREAM_CALL:${method}:${url}`)
})

/* 上游配置（真 `setUpstream` 加密往返；timeout_ms=1000 ＝ 允许的最小值）。 */
const UPSTREAM_KEY = randomHex('upstream-key')
await aiUpstream.setUpstream({
  actor_uid: 'u-admin-bookid-test',
  base_url: 'https://api.upstream.example/v1',
  model: 'gpt-image-1',
  key: UPSTREAM_KEY,
  timeout_ms: 1000
})

/* 身份与余额（管理员面）。 */
const ADMIN_PHONE = process.env.XIAI_ADMIN_PHONE
const ADMIN_IDENTITY = { uid: 'u-admin-ai-enhance-bookid', phone: ADMIN_PHONE }
const CONTEXT = (requestId) => ({ adminPhone: ADMIN_PHONE, nowSeconds: Math.floor(Date.now() / 1000), requestId })
fakeDb.bucketOf('xiai_balances').set(`bl-${ADMIN_IDENTITY.uid}`, {
  _id: `bl-${ADMIN_IDENTITY.uid}`,
  uid: ADMIN_IDENTITY.uid,
  points: 1000
})

/* `reason` 收集（末检「零新增」用）。 */
const seenReasons = new Set()
const note = (reply) => {
  if (reply && typeof reply.reason === 'string') seenReasons.add(reply.reason)
  return reply
}
const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'ALREADY_ENDORSED', 'DUPLICATE_VALUE', 'INSUFFICIENT_POINTS', 'KEY_INVALID', 'CONFIG_MISSING', 'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR']

/* 产物行键面基线（**两路不同**：同步路 doc 带 `visibility`、异步入册路不带 —— 逐字冻结）。 */
const SYNC_ROW_KEYS = ['_id', 'id', 'stamp_id', 'sealId', 'kind', 'seq', 'storage', 'storage_key', 'sha256', 'bytes', 'bytesLength', 'mime', 'width', 'height', 'source', 'displayOnly', 'visibility', 'source_image_id', 'charge_balance_after', 'upstream_status', 'elapsed_ms', 'created_at'].sort().join(',')
const ASYNC_ROW_KEYS = ['_id', 'id', 'stamp_id', 'sealId', 'kind', 'seq', 'storage', 'storage_key', 'sha256', 'bytes', 'bytesLength', 'mime', 'width', 'height', 'source', 'displayOnly', 'source_image_id', 'charge_balance_after', 'upstream_status', 'elapsed_ms', 'created_at'].sort().join(',')
/** 基线键面 ＋ `book_id`（**排序口径同 `shapeOf`** —— `book_id` 字典序在首位）。 */
const withBookKey = (keys) => keys.split(',').concat('book_id').sort().join(',')
const SYNC_SUCCESS_KEYS = ['ok', 'image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent', 'row'].sort().join(',')
const STATUS_READY_KEYS = ['ok', 'task_id', 'status', 'image_id', 'preview', 'charge'].sort().join(',')

/** 用例矩阵（两路同一张表 ⇒ D1 逐字比对）。 */
const MATRIX = [
  { name: 'inherit', book: '00003', expect: '00003' },
  { name: 'absent', book: ABSENT, expect: null },
  { name: 'explicitNull', book: null, expect: null },
  { name: 'dirtyLetters', book: 'abc', expect: null },
  { name: 'dirtyFour', book: '1234', expect: null },
  { name: 'dirtySix', book: '123456', expect: null }
]

const productIdOf = (sourceId, requestId) => aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(sourceId, requestId))
const rowOf = (imageId) => fakeDb.bucketOf('xiai_images').get(imageId) || null
const bookIdStateOf = (row) => (row && Object.prototype.hasOwnProperty.call(row, 'book_id') ? row.book_id : '<no-key>')

/* =========================================================================== *
  A 段：同步路 `enhanceFace` ⑨′（老同步路落库点）
 * =========================================================================== */
section('A', '同步路（ai-enhance-face）：继承矩阵 ＋ 读失败降级 ＋ 钱路读数')

async function runSync({ sourceId, requestId, failAt }) {
  readProbe.counts.clear()
  setReadFail(failAt ? { id: sourceId, at: failAt } : null)
  const warnsBefore = warnLines.length
  currentProductBytes = pngBytesOf(`sync-${sourceId}`)
  const reply = note(
    await ops.ADMIN_OPS['ai-enhance-face'](
      { image_id: sourceId, seal_id: 's-bookid', face_id: 'f-bookid' },
      ADMIN_IDENTITY,
      CONTEXT(requestId)
    )
  )
  setReadFail(null)
  const productId = productIdOf(sourceId, requestId)
  return {
    reply,
    row: rowOf(productId),
    productId,
    reads: readsOfSource(sourceId),
    warns: warnLines.slice(warnsBefore)
  }
}

const syncOutcomes = []
for (const testCase of MATRIX) {
  const sourceId = `img-a-${testCase.name}`
  const requestId = `rid-a-${testCase.name}-01`
  seedSourceImage(sourceId, testCase.book)
  const run = await runSync({ sourceId, requestId })
  syncOutcomes.push(bookIdStateOf(run.row))
  if (testCase.name === 'inherit') {
    check('A1', '① 源影像行 `book_id` 合法（`00003`）⇒ 产物行 `book_id` **逐字相同**；回包 `row` 同值；回包**恰 9 键**；产物行键面＝基线 22 键 ＋ `book_id`（恰 23 键）；该发**恰扣 10 金**（CHARGE 行 `delta = -10`、`idem_key` 三段封闭）', {
      ok: true,
      keys: SYNC_SUCCESS_KEYS,
      productBookId: '00003',
      replyRowBookId: '00003',
      rowKeys: withBookKey(SYNC_ROW_KEYS),
      chargeDeltas: [-10],
      idemKey: `ai-enhance-${sourceId}-${requestId}`
    }, {
      ok: run.reply.ok,
      keys: shapeOf(run.reply),
      productBookId: bookIdStateOf(run.row),
      replyRowBookId: bookIdStateOf(run.reply.row),
      rowKeys: shapeOf(run.row),
      chargeDeltas: flowRowsOf(ADMIN_IDENTITY.uid)
        .filter((flow) => flow.kind === 'CHARGE' && flow.idem_key === `ai-enhance-${sourceId}-${requestId}`)
        .map((flow) => flow.delta),
      idemKey: (flowRowsOf(ADMIN_IDENTITY.uid).find((flow) => flow.kind === 'CHARGE' && flow.idem_key === `ai-enhance-${sourceId}-${requestId}`) || {}).idem_key
    })
    continue
  }
  check(`A${MATRIX.indexOf(testCase) + 1}`, `②③ 源 \`${testCase.name}\` ⇒ 产物行**没有** \`book_id\` 键（键面**逐字**＝基线 22 键）；入册仍成功（回包恰 9 键）`, {
    ok: true,
    keys: SYNC_SUCCESS_KEYS,
    rowKeys: SYNC_ROW_KEYS,
    bookId: '<no-key>',
    noBookIdKey: true
  }, {
    ok: run.reply.ok,
    keys: shapeOf(run.reply),
    rowKeys: shapeOf(run.row),
    bookId: bookIdStateOf(run.row),
    noBookIdKey: !(run.row && Object.prototype.hasOwnProperty.call(run.row, 'book_id'))
  })
}

/* A7：源行读取抛错（同步路第 2 发 ＝ 继承读）⇒ 仍成功入册、无 `book_id` ＋ warn 如实。 */
{
  const sourceId = 'img-a-readThrows'
  const requestId = 'rid-a-readThrows-01'
  seedSourceImage(sourceId, '00003')
  const run = await runSync({ sourceId, requestId, failAt: 2 })
  check('A7', '④ 源行读取**抛错**（第 2 发＝继承读；第 1 发＝既有图源读照常）⇒ **仍成功入册**（回包恰 9 键、产物行在场）、产物行**没有** `book_id` 键（键面基线 22 键）、`log.warn` 捕获 `aiEnhance.inheritBookId.read.failed`', {
    ok: true,
    keys: SYNC_SUCCESS_KEYS,
    rowFound: true,
    rowKeys: SYNC_ROW_KEYS,
    bookId: '<no-key>',
    sourceReads: 2,
    warned: true
  }, {
    ok: run.reply.ok,
    keys: shapeOf(run.reply),
    rowFound: !!run.row,
    rowKeys: shapeOf(run.row),
    bookId: bookIdStateOf(run.row),
    sourceReads: run.reads,
    warned: warnLines.some((line) => line.indexOf('"event":"aiEnhance.inheritBookId.read.failed"') !== -1)
  })
}

/* A8：钱路读数（7 发 ×10 金、零退款、余额 930）。 */
{
  const charges = flowRowsOf(ADMIN_IDENTITY.uid).filter((flow) => flow.kind === 'CHARGE')
  const refunds = flowRowsOf(ADMIN_IDENTITY.uid).filter((flow) => flow.kind === 'REFUND')
  check('A8', '⑤ 钱路零变化：A 段 7 发**各恰扣 10 金**（CHARGE 恰 7 行、`delta` 合计 -70、`ref_type = AI_IMAGE`）、**零退款**、余额 1000 → 930', {
    chargeRows: 7,
    chargeSum: -70,
    refundRows: 0,
    balance: 930,
    refTypes: ['AI_IMAGE']
  }, {
    chargeRows: charges.length,
    chargeSum: charges.reduce((sum, flow) => sum + Number(flow.delta || 0), 0),
    refundRows: refunds.length,
    balance: balanceRowOf(ADMIN_IDENTITY.uid) && balanceRowOf(ADMIN_IDENTITY.uid).points,
    refTypes: [...new Set(charges.map((flow) => flow.ref_type))]
  })
}

/* =========================================================================== *
  B 段：异步入册路 `registerProductImage` ②′（**同一实现点**）
 * =========================================================================== */
section('B', '异步入册路（registerProductImage）：同一矩阵 ＋ 空集 ＋ 读取点恰 1 发 ＋ 段预算分支')

async function runIngest({ sourceId, requestId, sealId, failAt, budgetDeadlineAt }) {
  readProbe.counts.clear()
  setReadFail(failAt ? { id: sourceId, at: failAt } : null)
  const warnsBefore = warnLines.length
  currentProductBytes = pngBytesOf(`async-${sourceId}`)
  const reply = note(
    await tasks.registerProductImage({
      bytes: currentProductBytes,
      sealId,
      sourceImageId: sourceId,
      requestId,
      chargeBalanceAfter: 40,
      upstreamStatus: 200,
      elapsedMs: 12,
      budgetDeadlineAt: budgetDeadlineAt === undefined ? Date.now() + 15000 : budgetDeadlineAt
    })
  )
  setReadFail(null)
  setReadDelay('', 0)
  const productId = productIdOf(sourceId, requestId)
  return {
    reply,
    row: rowOf(productId),
    productId,
    reads: readsOfSource(sourceId),
    warns: warnLines.slice(warnsBefore)
  }
}

const asyncOutcomes = []
for (const testCase of MATRIX) {
  const sourceId = `img-b-${testCase.name}`
  const requestId = `rid-b-${testCase.name}-01`
  seedSourceImage(sourceId, testCase.book)
  const run = await runIngest({ sourceId, requestId, sealId: `s-b-${testCase.name}` })
  asyncOutcomes.push(bookIdStateOf(run.row))
  const inherited = testCase.expect !== null
  check(`B${MATRIX.indexOf(testCase) + 1}`, `①②③ 源 \`${testCase.name}\` ⇒ 异步入册路产物行 \`${inherited ? 'book_id 逐字相同' : '没有 book_id 键'}\`；回 \`ok:true\`、产物 id 确定性（\`img-\` ＋ 8 位十六进制）、键面${inherited ? '＝基线 21 键 ＋ book_id（共 22 键）' : '**逐字**＝基线 21 键'}、对源行**恰 1 发读**（零 N+1）`, {
    ok: true,
    imageIdShape: true,
    productBookId: inherited ? testCase.expect : '<no-key>',
    rowKeys: inherited ? withBookKey(ASYNC_ROW_KEYS) : ASYNC_ROW_KEYS,
    sourceReads: 1
  }, {
    ok: run.reply.ok,
    imageIdShape: /^img-[0-9a-f]{8}$/.test(String(run.reply.image_id)),
    productBookId: bookIdStateOf(run.row),
    rowKeys: shapeOf(run.row),
    sourceReads: run.reads
  })
}

/* B7：源行读取抛错（异步路第 1 发 ＝ 继承读）⇒ 仍成功入册、无 `book_id` ＋ warn。 */
{
  const sourceId = 'img-b-readThrows'
  const requestId = 'rid-b-readThrows-01'
  seedSourceImage(sourceId, '00003')
  const run = await runIngest({ sourceId, requestId, sealId: 's-b-readThrows', failAt: 1 })
  check('B7', '④ 源行读取**抛错** ⇒ **仍成功入册**（`ok:true`、产物行在场、产物 id 确定性）、产物行**没有** `book_id` 键（键面基线 21 键）、`log.warn` 捕获 `aiEnhance.inheritBookId.read.failed`', {
    ok: true,
    rowFound: true,
    rowKeys: ASYNC_ROW_KEYS,
    bookId: '<no-key>',
    sourceReads: 1,
    warned: true
  }, {
    ok: run.reply.ok,
    rowFound: !!run.row,
    rowKeys: shapeOf(run.row),
    bookId: bookIdStateOf(run.row),
    sourceReads: run.reads,
    warned: warnLines.some((line) => line.indexOf('"event":"aiEnhance.inheritBookId.read.failed"') !== -1)
  })
}

/* B8：空集（源行不存在）⇒ 仍成功入册、无 `book_id` ＋ warn `inheritBookId.empty`。 */
{
  const sourceId = 'img-b-ghost-0001'
  const requestId = 'rid-b-ghost-01'
  const run = await runIngest({ sourceId, requestId, sealId: 's-b-ghost' })
  check('B8', '③ 空集（源行**不存在**）⇒ 按「无归属」**继续落行**（`ok:true`、产物行在场）、产物行**没有** `book_id` 键、`log.warn` 捕获 `aiEnhance.inheritBookId.empty`', {
    ok: true,
    rowFound: true,
    rowKeys: ASYNC_ROW_KEYS,
    bookId: '<no-key>',
    warned: true
  }, {
    ok: run.reply.ok,
    rowFound: !!run.row,
    rowKeys: shapeOf(run.row),
    bookId: bookIdStateOf(run.row),
    warned: warnLines.some((line) => line.indexOf('"event":"aiEnhance.inheritBookId.empty"') !== -1)
  })
}

/* B9：单实现点的段预算分支 ① —— 执行器直接回哨兵（到点）⇒ 不新发读请求、按无归属降级。 */
{
  const sourceId = 'img-a-inherit'
  readProbe.counts.clear()
  const warnsBefore = warnLines.length
  const SENTINEL = Symbol('TEST_BUDGET_EXPIRED')
  const value = await aiEnhance.readInheritedBookId(sourceId, { run: () => SENTINEL, expired: SENTINEL })
  check('B9', '段预算分支 ①：执行器回超时哨兵 ⇒ **不新发读请求**（对该源行 0 发读）、按「无归属」回 `null`、`log.warn` 捕获 `aiEnhance.inheritBookId.budgetExpired`（**恒不抛**）', {
    value: null,
    sourceReads: 0,
    warned: true
  }, {
    value,
    sourceReads: readsOfSource(sourceId),
    warned: warnLines.slice(warnsBefore).some((line) => line.indexOf('"event":"aiEnhance.inheritBookId.budgetExpired"') !== -1)
  })
}

/* B10：段预算分支 ② —— 读**超段预算**（慢读 ＋ 短截止）⇒ 告警在场 ＋ 既有超预算收口一字不变。 */
{
  const sourceId = 'img-b-budget'
  const requestId = 'rid-b-budget-01'
  seedSourceImage(sourceId, '00003')
  setReadDelay(sourceId, 500)
  const run = await runIngest({ sourceId, requestId, sealId: 's-b-budget', budgetDeadlineAt: Date.now() + 100 })
  setReadDelay('', 0)
  check('B10', '段预算分支 ②：继承读**超段预算** ⇒ `log.warn` 捕获 `aiEnhance.inheritBookId.budgetExpired`（**不阻断、不新增失败面**）；其后**既有**「入册段在剩餘預算內未完成」超预算收口一字不变（`reason = UPSTREAM_ERROR`、`budgetFail` 既有恰 3 键 `message/ok/reason`、**零产物行** —— 钱路口径未被本单改动）', {
    warned: true,
    ok: false,
    reason: 'UPSTREAM_ERROR',
    keys: 'message,ok,reason',
    messageAnchor: true,
    rowFound: false
  }, {
    warned: warnLines.some((line) => line.indexOf('"event":"aiEnhance.inheritBookId.budgetExpired"') !== -1),
    ok: run.reply.ok,
    reason: run.reply.reason,
    keys: shapeOf(run.reply),
    messageAnchor: String(run.reply.message || '').indexOf('入冊段在剩餘預算內未完成') !== -1,
    rowFound: !!run.row
  })
}

/* =========================================================================== *
  C 段：端到端异步主路 `ai-enhance-status` ⑥c（生产在用路径）
 * =========================================================================== */
section('C', '端到端异步入册（ai-enhance-status ⑥c）：READY 恰 6 键 ＋ 产物行继承同值')

{
  const sourceId = 'img-c-e2e-0001'
  const requestId = 'rid-c-e2e-0001'
  const taskId = 'aiet-c-e2e-00000001'
  seedSourceImage(sourceId, '00007')
  const now = new Date().toISOString()
  fakeDb.bucketOf('xiai_ai_enhance_tasks').set(taskId, {
    _id: taskId,
    uid: ADMIN_IDENTITY.uid,
    request_id: requestId,
    source_image_id: sourceId,
    seal_id: 's-bookid-c',
    face_id: 'f-bookid-c',
    status: 'SUBMITTED',
    upstream_task_id: 'up-c-e2e-0001',
    upstream_status: 200,
    product_image_id: '',
    charge_amount: 10,
    charge_state: tasks.CHARGE_STATE.CHARGED,
    charge_balance_after: 40,
    error_reason: '',
    error_message: '',
    refunded: false,
    created_at: now,
    updated_at: now,
    deadline_at: new Date(Date.now() + tasks.TASK_DEADLINE_MS).toISOString()
  })
  currentProductBytes = pngBytesOf('c-e2e')
  const chargesBefore = flowRowsOf(ADMIN_IDENTITY.uid).length
  readProbe.counts.clear()
  const reply = note(await ops.ADMIN_OPS['ai-enhance-status']({ task_id: taskId }, ADMIN_IDENTITY, CONTEXT('rid-c-e2e-status')))
  const productId = productIdOf(sourceId, requestId)
  const productRow = rowOf(productId)
  const taskRow = fakeDb.bucketOf('xiai_ai_enhance_tasks').get(taskId)
  check('C1', '异步主路端到端：任务行推到 `READY`（回包**恰 6 键** `ok/task_id/status/image_id/preview/charge`）、产物行 `book_id` **逐字 ＝ 源行 `00007`**、任务行 `product_image_id` 逐字 ＝ 产物 id、**零新增扣费**（status 不扣费）', {
    ok: true,
    keys: STATUS_READY_KEYS,
    status: 'READY',
    productBookId: '00007',
    taskProductId: productId,
    taskStatus: 'READY',
    sourceReads: 1,
    zeroChargeDelta: 0
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    status: reply.status,
    productBookId: bookIdStateOf(productRow),
    taskProductId: taskRow && taskRow.product_image_id,
    taskStatus: taskRow && taskRow.status,
    sourceReads: readsOfSource(sourceId),
    zeroChargeDelta: flowRowsOf(ADMIN_IDENTITY.uid).length - chargesBefore
  })
}

/* =========================================================================== *
  D 段：两路行为一致（⑥）＋ 静态纪律（单实现点 / 落键护栏 / 幂等注释 / 钱路键面）
 * =========================================================================== */
section('D', '两路一致 ＋ 静态纪律：同一函数 / 落键护栏 / 幂等注释 / 钱路零变化')

/* D1：六个矩阵用例两路结果逐字一致（同一函数被测）。 */
{
  check('D1', '⑥ 两处落库路径行为**逐字一致**（同一矩阵、同一实现点）：继承值 `00003`；缺键 / `null` / `abc` / `1234` / `123456` 两路都**不写该键**（`<no-key>`）', {
    sync: ['00003', '<no-key>', '<no-key>', '<no-key>', '<no-key>', '<no-key>'],
    async: ['00003', '<no-key>', '<no-key>', '<no-key>', '<no-key>', '<no-key>'],
    same: true
  }, {
    sync: syncOutcomes,
    async: asyncOutcomes,
    same: JSON.stringify(syncOutcomes) === JSON.stringify(asyncOutcomes)
  })
}

/* D2：单实现点（定义恰 1 处、调用恰 2 处、仅 2 个文件在场）。 */
{
  const libDir = path.join(FN_DIR, 'lib')
  const libSources = readdirSync(libDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: readFileSync(path.join(libDir, name), 'utf8') }))
  const defCount = libSources.reduce((sum, item) => sum + countOf(item.source, 'async function readInheritedBookId('), 0)
  const callCount = libSources.reduce((sum, item) => sum + countOf(item.source, 'readInheritedBookId('), 0) - defCount
  const filesWith = libSources.filter((item) => item.source.indexOf('readInheritedBookId(') !== -1).length
  const inTasks = countOf(libSources.find((item) => item.name === 'aiEnhanceTasks.js').source, 'aiEnhance.readInheritedBookId(')
  check('D2', '读取点**单实现点**：`async function readInheritedBookId(` 全 `lib/*.js` 恰 1 处；调用恰 2 处（`enhanceFace` ⑨′ ＋ `registerProductImage` ②′）、仅这两个文件在场；`aiEnhanceTasks.js` 走 `aiEnhance.` 导出**恰 1 处**（不复制第二套）', {
    definitions: 1,
    callSites: 2,
    files: 2,
    tasksCallSites: 1,
    exported: true
  }, {
    definitions: defCount,
    callSites: callCount,
    files: filesWith,
    tasksCallSites: inTasks,
    exported: typeof aiEnhance.readInheritedBookId === 'function'
  })
}

/* D3：落键护栏（恰 2 处 `if (inheritedBookId !== null) doc.book_id = …`；剥注释后零 `null` / 空串落值）。 */
{
  const enhanceSrc = stripComments(readFileSync(path.join(FN_DIR, 'lib/aiEnhance.js'), 'utf8'))
  const tasksSrc = stripComments(readFileSync(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'), 'utf8'))
  const guards = countOf(enhanceSrc, 'if (inheritedBookId !== null) doc.book_id = inheritedBookId') +
    countOf(tasksSrc, 'if (inheritedBookId !== null) doc.book_id = inheritedBookId')
  check('D3', '落键护栏：两处落库**恰各 1 处** `if (inheritedBookId !== null) doc.book_id = inheritedBookId`；剥注释后**零** `book_id: null` / `book_id: \'\'` 落值（`null` ⇒ 不写键、绝不写空串）', {
    guards: 2,
    nullLiterals: 0,
    emptyStringLiterals: 0
  }, {
    guards,
    nullLiterals: countOf(enhanceSrc + tasksSrc, 'book_id: null'),
    emptyStringLiterals: countOf(enhanceSrc + tasksSrc, "book_id: ''")
  })
}

/* D4：幂等语义写进注释（两文件都在场）。 */
{
  const enhanceSrc = readFileSync(path.join(FN_DIR, 'lib/aiEnhance.js'), 'utf8')
  const tasksSrc = readFileSync(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'), 'utf8')
  const anchor = '不加锁、不加新状态'
  check('D4', '幂等语义入注释：两处落库文件都写明「确定性 `doc(id).set` ⇒ 重放用**当时**的源行 `book_id` 覆盖；既有幂等语义的自然延伸 —— 不加锁、不加新状态」', {
    enhance: true,
    tasks: true
  }, {
    enhance: enhanceSrc.indexOf(anchor) !== -1 && enhanceSrc.indexOf('doc(id).set') !== -1,
    tasks: tasksSrc.indexOf(anchor) !== -1 && tasksSrc.indexOf('doc(id).set') !== -1
  })
}

/* D5：钱路零变化（reason 恰 13 且零新增；三 op 回包键面冻结；注册面 52 项）。 */
{
  const reasons = [...seenReasons].sort()
  check('D5', '钱路零变化：`REASONS` **恰 13 值**、本套全程 `reason` ⊆ 冻结 13（零新增）；键面常量冻结 —— submit 成功恰 5 键 / 失败恰 4 键、status READY 恰 6 键、list 行恰 6 键、同步成功恰 9 键 / 失败恰 4 键；`ADMIN_OPS` 恰 56 项', {
    reasonsSize: 13,
    reasonsSubset: true,
    submitSuccess: ['charge', 'ok', 'source_image_id', 'status', 'task_id'],
    submitFailure: ['message', 'ok', 'reason', 'refunded'],
    statusReady: ['charge', 'image_id', 'ok', 'preview', 'status', 'task_id'],
    listRow: ['created_at', 'error_message', 'image_id', 'source_image_id', 'status', 'task_id'],
    syncSuccess: 9,
    syncFailure: 4,
    adminOps: 56
  }, {
    reasonsSize: Object.keys(REASONS).length,
    reasonsSubset: reasons.every((reason) => FROZEN_REASONS.indexOf(reason) !== -1),
    submitSuccess: [...tasks.SUBMIT_SUCCESS_KEYS].sort(),
    submitFailure: [...tasks.SUBMIT_FAILURE_KEYS].sort(),
    statusReady: [...tasks.STATUS_READY_KEYS].sort(),
    listRow: [...tasks.LIST_ROW_KEYS].sort(),
    syncSuccess: aiEnhance.AI_ENHANCE_SUCCESS_KEYS.length,
    syncFailure: aiEnhance.AI_ENHANCE_FAILURE_KEYS.length,
    adminOps: Object.keys(ops.ADMIN_OPS).length
  })
  console.log(JSON.stringify({ id: 'D5.readout', seenReasons: reasons }))
}

/* D6：段预算接线（静态：`registerProductImage` 传执行器 ＋ 哨兵；到点不新发读请求）。 */
{
  const tasksSrc = readFileSync(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'), 'utf8')
  check('D6', '段预算接线（静态）：`registerProductImage` 调用单实现点时传**惰性执行器** `budgetExhausted() ? BUDGET_EXPIRED : withinBudget(read(), deadlineAt)` ＋ `expired: BUDGET_EXPIRED`（与同文件既有 `withinBudget` 同法；到点不新发读请求）', {
    runner: 1,
    expired: 1
  }, {
    runner: countOf(tasksSrc, 'budgetExhausted() ? BUDGET_EXPIRED : withinBudget(read(), deadlineAt)'),
    expired: countOf(tasksSrc, 'expired: BUDGET_EXPIRED')
  })
}

/* 收针：还原注入缝（不留全局态给后续脚本进程）。 */
aiEnhance.setAiEnhanceFetchProvider(null)
tasks.setTaskFetchProvider(null)
console.warn = realConsoleWarn

/* =========================================================================== *
  收尾
 * =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；注入缝＝ops 三缝（DB / 存储读 / 存储上传）＋ ledger / aiUpstream 存储缝 ＋ 两处上游 fetch 缝 ＋ `ops.readRows` 读取点探针（发数 / 定点抛错 / 延时）。'
  })
)
process.exit(total === passed ? 0 : 1)
