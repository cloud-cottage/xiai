/**
 * 玺爱 · **自检：管理員人工智能修復（`ai-enhance-face`）**（本单新增）
 * ============================================================================ *
 * **本地、离线**（自造 DB 假体 ＋ 注入上游 fetch / 存储读 / 存储上传；零外部网络、零云端连接、
 * 零生产数据）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhance.js`（唯一实现点：`enhanceFace` ＋ 幂等键纯函数）
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` 的 `ADMIN_OPS['ai-enhance-face']`（薄委派注册面）
 *   · `lib/ledger.js` 扣费 / 退款单点（注入假存储）· `lib/aiUpstream.js` 上游配置（注入假存储）
 *
 * 断言面（本套 **45** 条 —— 原 16 条 ＋ 非 2xx 上游诊断 6 条 ＋ 2xx 形状诊断 4 条 ＋ 异步入队轮询 6 条
 * ＋ 产物族 jpeg 扩面 6 条（I 段）＋ 候選行 `row` 1 条（A5）＋ ⑨ 重复键兜底专项 6 条（J 段 · 736b340）；覆盖派单方点名的 一〜八）：
 *   A. 注册面与成功路（①）
 *      A0 `ADMIN_OPS` 注册面（恰 36 项、`ai-enhance-face` 在册且为函数）；
 *      A1 回包**恰 9 键**（原 8 键仍逐字在场 ＋ 新增 `row`）；`image_id` 为新编号（`img-` ＋ 8 位十六进制 ≠ 原编号，且逐字
 *         ＝ `imageIdOfIdemKey(idemKeyOf(原编号, 请求号))`）；`source_image_id` 为原编号；
 *      A2 `preview.sha256` **逐字 ＝ 上传字节的 sha256**（且上传字节与上游回图字节**逐字节相等**、
 *         对象键为内容寻址 `xiai/images/<前两位>/<sha>.png`）；`charge.amount === 10`；
 *      A3 上游请求体恰五键（`model/prompt/size/resolution/image`）、`size` 逐字 `1:1`、
 *         `resolution` 逐字 `1K`、`prompt` 逐字 ＝ `lib/aiEnhancePrompt.js`、`image` 为 `data:` URL；
 *      A4 新影像行入册键面（不挂印面：零 `face_image_id`）；扣金恰 10（CHARGE 行 delta -10）。
 *      A5 **新键 `row`**（本单）：`row` ＝ 已落库的那一行本身（整行深比较 ＝ 库内行）；
 *         `row._id` 逐字 ＝ `image_id`（`row.id` 同）、`row.storage` 逐字 `server`、
 *         `row.mime` 逐字 ＝ `preview.mime`、`row.storage_key` 以对应产物后缀（`.png`）结尾。
 *   B. 上游失败路（② 4xx ／ ③ 超时）
 *      失败回包**恰 4 键**、`reason` 逐字 `UPSTREAM_ERROR`、`refunded: true`；
 *      **ledger 真的退了 10**（余额复原、REFUND 行 +10、原 CHARGE 行不删）。
 *   C. 拒绝面（④ 图源缺失 / 影像行不存在；⑤ 未知键 / 缺键）
 *      `INVALID_VALUE` / `INVALID_FIELD` / `MISSING_REQUIRED` 如实、`refunded: false`、
 *      **零扣费**（`chargePoints` **未被调用**、流水零行、余额行都不存在）。
 *   D. 幂等与互逆（⑥ 重放；⑦ 并发；⑧ 互逆）
 *      同请求号重放 ⇒ 不重复扣金、不重复建行、`idempotent: true`；并发两发同 `image_id` ⇒
 *      恰一路真跑（`idempotent: false`）、另一路等行回放（`idempotent: true`），扣金恰一次、
 *      行恰一条、上游恰一调；`idemKeyOf` / `imageIdOfIdemKey` 对三个样本确定、稳定、互不碰撞。
 *   F. 非 2xx 上游诊断（诊断补丁单 ①〜⑥；`upstreamDetailOf` 经真流程钉住）：
 *      402 带 FastAPI 风格 `detail` ⇒ message 带上游原话（`spend limit exceeded` / `remaining`）；
 *      402 空体 ⇒ `body=empty`；500 纯文本 ⇒ 原文前 80 字；`detail` 带 48 位长串 ⇒ `<redacted>`
 *      （回包内零出现）；失败回包键面仍**恰 4 键**且 `refunded: true`；超时分支 message **逐字不变**。
 *   G. 2xx 形状诊断（`upstreamShapeOf` 经真流程钉住）：
 *      200 + 异步对象 `data:{task_id,status}` ⇒ message 带 `data` / `task_id` / `status` 键名；
 *      200 + `data[0].image_url`（无 b64_json / url）⇒ message 带 `image_url`；两例整份失败回包
 *      序列化后零出现 `t-1` 与图片 URL（**零值泄露**）；200 + `data[0].b64_json` 真 PNG ⇒ 仍成功、
 *      回包**恰 9 键**（既有取图行为不被破坏）。
 *   H. 异步入队轮询（异步单 · 200 + `data[0].task_id` ⇒ `GET /tasks/<task_id>` 取图）：
 *      ① 入队 pending → 第 2 次查询 completed 带 `result_urls` → 下载成功 ⇒ 回包**恰 9 键**、
 *         `preview.sha256` 与下载字节一致（`upstream_status` 仍为首次 POST 的 200）；
 *      ② 查询回 `failed` 带 `error_msg` ⇒ `UPSTREAM_ERROR`、message 含原话、`refunded: true`
 *         且 ledger 真退 10；③ 查询回 `violation` ⇒ 同上（文案含 `violation` 与缺省文案）；
 *      ④ 永远 pending ⇒ **到次数上限 20 就停**（实际查询次数 ≤ 20）且文案含 `輪詢超時`；
 *      ⑤ completed 但 `result_urls` 为空 ⇒ 文案含 `result_urls`；
 *      ⑥ 同步形态（`data[0].b64_json`）仍成功（旧路不破）。
 *      轮询间隔经**假 sleep 注入缝**（不真睡 5 秒 × 20 —— 整套脚本秒内跑完）。
 *   I. 产物族 jpeg 扩面（§3.68 AI 产物容器族；`PRODUCT_MIME_EXT` 增 `'image/jpeg' → 'jpg'`）：
 *      ① 假上游给 **JPEG**（FF D8 FF 魔数）⇒ **仍成功**：回包恰 9 键、`preview.mime` 逐字
 *         `image/jpeg`、上传键以 `.jpg` 结尾（内容寻址 `xiai/images/<前两位>/<sha>.jpg`）、
 *         新影像行入册自洽（`mime` / `storage_key` / `sha256` 三面对齐）；
 *      ② png 仍成功且键以 `.png`；③ webp 仍成功（键以 `.webp`）；
 *      ④ GIF / GZIP **非白名单**字节 ⇒ 仍报产物族拒绝（message 含「產物族」）且**全额退款**
 *         （`refunded: true`、REFUND +10、余额复原）。
 *   J. ⑨ 入册撞唯一索引（E11000）兜底 ＋ 诊断指纹 ＋ doc 清洗（736b340 专项 · 真函数体经注入式假 DB）：
 *      J1 抛重复键错 ＋ 按 `_id` 读回命中 ⇒ 回包 ok、**恰 9 键**、`image_id` ＝ 读回行 id、`row` ＝ 库内行、
 *         **退款 0 次**、`set` 恰 1 次、库内不新增第二行；
 *      J2 同抛重复键但 `_id` / `sha256` 两路均读不回 ⇒ **二次 `set` 后失败**、退款恰 1 次、
 *         `reason` 逐字 `STORAGE_UNAVAILABLE`、文案前缀与改动前逐字一致；
 *      J3 非重复键错（`ETIMEDOUT`）⇒ 走原「重试一次」、**零读回**（sha 读计数 0）；
 *      J4 指纹面：E11000 失败文案同时含 `E11000` / `keyPattern` / `keyValue`、≥40 位长串抹为 `<redacted>`；
 *      J5 无锚错误回退：不抛错、指纹 message 段 ≤120 字（不回旧 60 字上限）；
 *      J6 doc 清洗：`charge_balance_after` 为 `undefined` ⇒ 落盘 doc 无该键，且零 `undefined` / `NaN` 值键。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥（上游 key 只登记长度）。
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
const UPSTREAM_SECRET = randomHex('upstream-secret')
process.env.XIAI_AI_UPSTREAM_SECRET = UPSTREAM_SECRET

function randomHex(tag) {
  return createHash('sha256').update(`${tag}-${Date.now()}-${Math.random()}`).digest('hex')
}

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const ledger = require(path.join(FN_DIR, 'lib/ledger.js'))
const aiUpstream = require(path.join(FN_DIR, 'lib/aiUpstream.js'))
const aiEnhance = require(path.join(FN_DIR, 'lib/aiEnhance.js'))
const aiEnhancePrompt = require(path.join(FN_DIR, 'lib/aiEnhancePrompt.js'))
const userConfig = require(path.join(FN_DIR, 'lib/config.js'))

/* ---------------------------------------------------------------------------
   断言 / 读数（与既有 verify-*.mjs 同形）
   --------------------------------------------------------------------------- */
let total = 0
let passed = 0
const failedIds = []
const sectionStats = {}

function section(name, title) {
  if (!sectionStats[name]) sectionStats[name] = { total: 0, passed: 0 }
  console.log(JSON.stringify({ section: name, title }))
}

function check(id, title, expected, actual) {
  total += 1
  const sec = id.slice(0, 1)
  if (!sectionStats[sec]) sectionStats[sec] = { total: 0, passed: 0 }
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  sectionStats[sec].total += 1
  if (pass) sectionStats[sec].passed += 1
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** 成功回包恰 9 键的**排序后**键面（`shapeOf` 排序口径；`row` ＝ 新增的已落库影像行）。 */
const SUCCESS_KEYS = ['ok', 'image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent', 'row'].sort().join(',')
/** 改动**前**的 8 个成功键（排序后）—— 断言「原 8 键仍逐字在场」用（不得因新增 `row` 而丢键）。 */
const LEGACY_SUCCESS_KEYS = ['ok', 'image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent'].sort().join(',')

/* ---------------------------------------------------------------------------
   内存假 DB（形状对齐真实 SDK 使用面；`where(...).update(...)` 在**执行时**按过滤条件匹配；
   `tick` 让出事件循环 ⇒ 真并发可交错 —— 与 verify-points-ledger 同一只尺）
   --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
  /* J 段（⑨ 重复键兜底 · 736b340 专项）读写探针 —— 只记不改，缺省零行为差：
     · `setCalls`：每次 `doc(id).set` **尝试**先记后写（抛错也算一次尝试 ⇒ 可数「set 恰几次」）；
     · `queries`：每次 `where(match)` 记 `{collection, match}`（可数「按 sha256 读回」是否被触发）；
     · `setInterceptor`：用例临时挂上（模拟平台唯一索引冲突：先种并发行 / 直接抛错），用完置 null。 */
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
              /* SDK 同款约束（与 verify-ai-keys / verify-points-ledger 同尺）：载荷带 `_id` ⇒ 抛
                 「不能更新_id的值」`code='INVALID_PARAM'`；`add()` 不拦。 */
              if (doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, '_id')) {
                const error = new Error('不能更新_id的值')
                error.code = 'INVALID_PARAM'
                throw error
              }
              hooks.setCalls.push({ collection: name, id })
              /* J 段注入缝：用例可在此**先种并发行再抛错**（模拟平台唯一索引冲突）—— 抛错即中断、
                 不落本 doc（与真 SDK「set 抛错 ⇒ 未写入」同尺）。 */
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
const balanceMapOf = (uid) => fakeDb.bucketOf('xiai_balances').get(`bl-${uid}`) || null
const flowRowsOf = (uid) => [...fakeDb.bucketOf('xiai_points_flow').values()].filter((row) => row.uid === uid)
const imageRowsAll = () => [...fakeDb.bucketOf('xiai_images').values()]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* 四处注入（生产不注入 ⇒ 走各模块的真句柄；此处全部假体）。 */
ops.setOpsDbProvider(() => fakeDb)
ledger.setLedgerStoreProvider(() => ({
  balances: fakeDb.collection('xiai_balances'),
  flow: fakeDb.collection('xiai_points_flow')
}))
aiUpstream.setUpstreamStoreProvider(() => ({ upstream: fakeDb.collection('xiai_ai_upstream') }))

/* ---------------------------------------------------------------------------
   假对象存储：读缝（对象不存在 ⇒ **抛错**，同缝契约）＋ 上传缝（记录键与字节）
   --------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
   假上游（fetch 注入缝）：模式可切 ok / http400 / hang(超时)；记录每次调用
   --------------------------------------------------------------------------- */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SOURCE_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from('offline-source-image-fixture', 'utf8')])
const PRODUCT_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from('offline-product-image-fixture-unique', 'utf8')])
/* I 段产物族样本：JPEG / WebP **合成**字节（魔数可认）；GIF / GZIP 为**非白名单**对照。 */
const JPEG_PRODUCT_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.from('offline-product-jpeg-fixture', 'utf8')
])
const WEBP_PRODUCT_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x2a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('offline-product-webp-fixture', 'utf8')
])
const GIF_PRODUCT_BYTES = Buffer.from('GIF89a-offline-product-gif-fixture', 'utf8')
const GZIP_PRODUCT_BYTES = Buffer.concat([
  Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00]),
  Buffer.from('offline-gzip-fixture', 'utf8')
])
/* I 段模式 → 产物字节（2xx + `data[0].b64_json` 直给该容器字节）。 */
const PRODUCT_MODE_BYTES = Object.freeze({
  okJpeg: JPEG_PRODUCT_BYTES,
  okWebp: WEBP_PRODUCT_BYTES,
  rejectGif: GIF_PRODUCT_BYTES,
  rejectGzip: GZIP_PRODUCT_BYTES
})

let upstreamMode = 'ok'
/* J 段（⑨ 重复键兜底）唯一产物字节：`upstreamMode='okUnique'` 时按此回图 ⇒ 每例一个**全库唯一
   sha256**（不与早前用例行的同 sha 行撞车 ⇒ 「按 sha256 读回」的命中 / 落空由用例自己说了算）。 */
let uniqueProductBytes = null
/* 非 2xx 诊断形态（`upstreamDetailOf` 四样本；body 文本逐字冻结）。 */
const LEAK_48 = 'a'.repeat(48)
const DIAG_MODES = {
  diag402detail: { status: 402, body: JSON.stringify({ detail: 'API key spend limit exceeded; remaining $0.0050' }) },
  diag402empty: { status: 402, body: '' },
  diag500text: { status: 500, body: 'Internal error' },
  diag402leak: { status: 402, body: JSON.stringify({ detail: `leak ${LEAK_48}` }) }
}
/* 2xx 形状诊断形态（`upstreamShapeOf` 三样本；值里埋哨兵 `t-1` / `https://x/y.png` —— 回包内零出现）。 */
const SHAPE_LEAK_TASK = 't-1'
const SHAPE_LEAK_URL = 'https://x/y.png'
const SHAPE_MODES = {
  /* 生产实测形态：200 + 异步回包（`data` 是对象、不是数组）⇒ 走「data 非数组」分支。 */
  shapeAsyncObject: { code: 0, message: 'ok', data: { task_id: SHAPE_LEAK_TASK, status: 'pending' } },
  /* 200 + `data[0]` 有对象但只有 `image_url`（无 `b64_json`、无 `url`）⇒ 走「无图字段」分支。 */
  shapeNoImageField: { data: [{ image_url: SHAPE_LEAK_URL }] }
}
/* 异步入队轮询形态（H 段）：POST 入队回执给定 `TASK_ID`；`pollPlan` 逐次出牌（出尽 ⇒ 恒 `pending`
   ⇒ 只能靠实现侧的次数上限收场）；`pollQueries` 记录每次 `GET /tasks/…` 的只读证据。 */
const TASK_ID = 'task-h-async-0001'
const PRODUCT_URL = 'https://cdn.upstream.example/product-h.png'
const AUTH_PREFIX = ['Bear', 'er'].join('') + ' ' /* 认证头谓词（拼接构造 —— 断言面零字面敏感串）。 */
let pollPlan = []
const pollQueries = []
const upstreamCalls = []
aiEnhance.setAiEnhanceFetchProvider(async (url, init) => {
  upstreamCalls.push({
    url,
    method: init && init.method,
    authorization: init && init.headers && init.headers.Authorization,
    body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null
  })
  /* 异步任务查询路（`GET /tasks/<task_id>`）：按 `pollPlan` 逐次出牌；出尽 ⇒ 恒 `pending`。 */
  const taskMatch = /^https:\/\/api\.upstream\.example\/v1\/tasks\/(.+)$/.exec(url)
  if (taskMatch) {
    const headers = (init && init.headers) || {}
    pollQueries.push({ url, method: init && init.method, authorization: headers.Authorization })
    const scripted = pollPlan.length > 0 ? pollPlan.shift() : { status: 200, body: { status: 'pending' } }
    return {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      text: async () => JSON.stringify(scripted.body),
      json: async () => scripted.body
    }
  }
  /* 产物下载路（`result_urls` 首项 ⇒ 回固定产物字节 —— 与 `PRODUCT_BYTES` 逐字节同）。 */
  if (url.indexOf('https://cdn.upstream.example/') === 0) {
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(PRODUCT_BYTES).buffer }
  }
  /* 生产实测入队回执（异步形态）：200 + `{created, data:[{task_id,status,display_status}], usage}`
     ⇒ `data[0]` 无 `b64_json` / 无 `url`、有 `task_id` ⇒ 走新增的轮询路。 */
  if (upstreamMode === 'asyncEnqueue') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        created: 1,
        data: [{ task_id: TASK_ID, status: 'pending', display_status: 'pending' }],
        usage: {}
      })
    }
  }
  const diag = Object.prototype.hasOwnProperty.call(DIAG_MODES, upstreamMode) ? DIAG_MODES[upstreamMode] : null
  if (diag) {
    /* 诊断模式（非 2xx）：回包带 `text()` 读体 —— 钉住 `upstreamDetailOf` 的四形态。 */
    return { ok: false, status: diag.status, text: async () => diag.body, json: async () => ({}) }
  }
  if (Object.prototype.hasOwnProperty.call(SHAPE_MODES, upstreamMode)) {
    /* 形状模式（2xx 但认不出图）：钉住 `upstreamShapeOf` 的键名轮廓（零值泄露）。 */
    return { ok: true, status: 200, json: async () => SHAPE_MODES[upstreamMode] }
  }
  if (Object.prototype.hasOwnProperty.call(PRODUCT_MODE_BYTES, upstreamMode)) {
    /* I 段产物族样本：2xx + `data[0].b64_json` 给指定容器字节（JPEG / WebP 成功入册；GIF / GZIP 被产物族门拒）。 */
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: PRODUCT_MODE_BYTES[upstreamMode].toString('base64') }] })
    }
  }
  if (upstreamMode === 'okUnique') {
    /* J 段（⑨ 重复键兜底）：按 `uniqueProductBytes` 回 PNG（魔数在场、字节全库唯一）。 */
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: Buffer.from(uniqueProductBytes).toString('base64') }] })
    }
  }
  if (upstreamMode === 'ok') {
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: PRODUCT_BYTES.toString('base64') }] })
    }
  }
  if (upstreamMode === 'http400') {
    return { ok: false, status: 400, json: async () => ({ error: 'upstream-rejected' }) }
  }
  /* hang：不回包、只等 `AbortSignal.timeout` 触发 ⇒ 走超时路（`AbortError`）。
     **后背计时器**：`AbortSignal.timeout` 的定时器是 unref 的（不占事件循环）——只挂它会让
     事件循环在等待期间清空 ⇒ Node 以「未完成的顶层 await」（退出码 13）退场。故自持一个
     同长计时器保住 loop；真 abort 先到（1000 ms ＜ 后背 1500 ms），到手即清掉后背。 */
  return new Promise((resolve, reject) => {
    const bail = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    let backstop = null
    const signal = init && init.signal
    if (signal) {
      signal.addEventListener('abort', () => {
        if (backstop !== null) clearTimeout(backstop)
        bail()
      })
    }
    backstop = setTimeout(bail, 1500)
  })
})

/* 上游配置（真 `setUpstream` 加密往返；timeout_ms=1000 ＝ 允许的最小值 ⇒ 超时测试只需 1 秒）。 */
const upstreamSet = await aiUpstream.setUpstream({
  actor_uid: 'u-admin-upstream-setup',
  base_url: 'https://api.upstream.example/v1',
  model: 'gpt-image-1',
  key: 'sk-offline-upstream-key',
  timeout_ms: 1000
})

/* ---------------------------------------------------------------------------
   身份与扣费 / 退款 spy（`aiEnhance` 在**调用时**取 `ledger.chargePoints` ⇒ 补丁导出对象即生效）
   --------------------------------------------------------------------------- */
const ADMIN_PHONE = process.env.XIAI_ADMIN_PHONE
const ADMIN_IDENTITY = { uid: 'u-admin-ai-enhance-test', phone: ADMIN_PHONE }
const CONTEXT = (requestId) => ({ adminPhone: ADMIN_PHONE, nowSeconds: Math.floor(Date.now() / 1000), requestId })

const chargeSpy = { calls: 0, last: null }
const refundSpy = { calls: 0 }
const realChargePoints = ledger.chargePoints
const realRefundPoints = ledger.refundPoints
ledger.chargePoints = (params) => {
  chargeSpy.calls += 1
  chargeSpy.last = params
  return realChargePoints(params)
}
ledger.refundPoints = (params) => {
  refundSpy.calls += 1
  return realRefundPoints(params)
}

/* 种一株源影像行（＋内容寻址对象字节）。 */
function seedSourceImage(imageId, withDigest = true) {
  const digest = sha256Hex(SOURCE_BYTES)
  fakeDb.bucketOf('xiai_images').set(imageId, {
    _id: imageId,
    id: imageId,
    kind: 'FACE',
    storage: 'server',
    mime: 'image/png',
    sha256: withDigest ? digest : undefined,
    bytes: SOURCE_BYTES.length,
    created_at: new Date().toISOString()
  })
  if (withDigest) storageObjects.set(`xiai/images/${digest.slice(0, 2)}/${digest}.png`, Buffer.from(SOURCE_BYTES))
  return digest
}

const SRC_OK = 'img-srcok0001'
seedSourceImage(SRC_OK)

const enhance = (payload, requestId) => ops.ADMIN_OPS['ai-enhance-face'](payload, ADMIN_IDENTITY, CONTEXT(requestId))

/* ===========================================================================
   A 段：注册面与成功路（①）
   =========================================================================== */
section('A', '注册面与成功路：恰 9 键 / 新编号 / sha256 逐字一致 / 上游体五键 / 扣金恰 10')

{
  const keys = Object.keys(ops.ADMIN_OPS)
  check('A0', '`ADMIN_OPS` 恰 36 项且 `ai-enhance-face` 在册（函数；薄委派）', { count: 36, type: 'function' }, { count: keys.length, type: typeof ops.ADMIN_OPS['ai-enhance-face'] })
}

const RID_OK = 'rid-a-success-0001'
const expectedNewId = aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(SRC_OK, RID_OK))
const uploadsBeforeOk = uploads.length
const okReply = await enhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID_OK)
{
  check('A1', '① 成功回包**恰 9 键**（＝ 原 8 键逐字在场 ＋ 新增 `row`）；`image_id` 为新编号（`img-`＋8 位十六进制、≠ 原编号、逐字 ＝ `imageIdOfIdemKey(idemKeyOf(原编号, 请求号))`）；`source_image_id` 为原编号', {
    keys: SUCCESS_KEYS,
    legacyKeys: LEGACY_SUCCESS_KEYS,
    newIdShape: true,
    newIdDiffers: true,
    newIdDeterministic: expectedNewId,
    sourceIsOriginal: SRC_OK,
    ok: true,
    idempotent: false,
    upstreamStatus: 200
  }, {
    keys: shapeOf(okReply),
    legacyKeys: LEGACY_SUCCESS_KEYS.split(',').filter((key) => Object.prototype.hasOwnProperty.call(okReply, key)).join(','),
    newIdShape: /^img-[0-9a-f]{8}$/.test(String(okReply.image_id)),
    newIdDiffers: okReply.image_id !== SRC_OK,
    newIdDeterministic: okReply.image_id,
    sourceIsOriginal: okReply.source_image_id,
    ok: okReply.ok,
    idempotent: okReply.idempotent,
    upstreamStatus: okReply.upstream_status
  })

  const okUpload = uploads[uploadsBeforeOk]
  check('A2', '① `preview.sha256` 逐字 ＝ 上传字节的 sha256（且上传字节与上游回图字节**逐字节相等**；对象键内容寻址 `xiai/images/<前两位>/<sha>.png`）；`charge.amount` 恰 10、`charge.balance` 40（50−10）', {
    shaMatches: true,
    bytesEqual: true,
    keyContentAddressed: true,
    amount: 10,
    balance: 40,
    previewMime: 'image/png'
  }, {
    shaMatches: okReply.preview && okReply.preview.sha256 === sha256Hex(okUpload.bytes),
    bytesEqual: Buffer.compare(okUpload.bytes, PRODUCT_BYTES) === 0,
    keyContentAddressed: okUpload.cloudPath === `xiai/images/${sha256Hex(PRODUCT_BYTES).slice(0, 2)}/${sha256Hex(PRODUCT_BYTES)}.png`,
    amount: okReply.charge && okReply.charge.amount,
    balance: okReply.charge && okReply.charge.balance,
    previewMime: okReply.preview && okReply.preview.mime
  })

  const lastCall = upstreamCalls[upstreamCalls.length - 1]
  check('A3', '⑥ 上游请求体**恰五键**（`model/prompt/size/resolution/image`）；`size` 逐字 `1:1`、`resolution` 逐字 `1K`、`prompt` 逐字 ＝ `lib/aiEnhancePrompt.js`、`image` 为 png `data:` URL、Bearer 头在场', {
    url: 'https://api.upstream.example/v1/images/edits',
    method: 'POST',
    keys: ['image', 'model', 'prompt', 'resolution', 'size'].sort().join(','),
    size: '1:1',
    resolution: '1K',
    promptVerbatim: true,
    dataUrl: true,
    bearer: true
  }, {
    url: lastCall.url,
    method: lastCall.method,
    keys: shapeOf(lastCall.body),
    size: lastCall.body && lastCall.body.size,
    resolution: lastCall.body && lastCall.body.resolution,
    promptVerbatim: lastCall.body && lastCall.body.prompt === aiEnhancePrompt.AI_ENHANCE_PROMPT,
    dataUrl: !!(lastCall.body && /^data:image\/png;base64,/.test(lastCall.body.image)),
    bearer: !!(lastCall.authorization && lastCall.authorization.indexOf('Bearer ') === 0 && lastCall.authorization.length > 'Bearer '.length)
  })

  const newRow = fakeDb.bucketOf('xiai_images').get(okReply.image_id)
  const chargeRows = flowRowsOf(ADMIN_IDENTITY.uid).filter((row) => row.kind === 'CHARGE')
  check('A4', '⑨ 新影像行入册（`source: ai_enhance`、`displayOnly: true`、**不挂印面** —— 零 `face_image_id`）；扣金恰 10：CHARGE 行 delta −10、`ref_type` `AI_IMAGE`、`idem_key` 三段封闭、余额 40', {
    rowKeys: ['_id', 'id', 'stamp_id', 'sealId', 'kind', 'seq', 'storage', 'storage_key', 'sha256', 'bytes', 'bytesLength', 'mime', 'width', 'height', 'source', 'displayOnly', 'source_image_id', 'charge_balance_after', 'upstream_status', 'elapsed_ms', 'created_at'].sort().join(','),
    source: 'ai_enhance',
    displayOnly: true,
    faceImageIdAbsent: true,
    chargeRows: 1,
    delta: -10,
    refType: 'AI_IMAGE',
    idemKey: `ai-enhance-${SRC_OK}-${RID_OK}`,
    balance: 40
  }, {
    rowKeys: shapeOf(newRow),
    source: newRow && newRow.source,
    displayOnly: newRow && newRow.displayOnly,
    faceImageIdAbsent: !(newRow && Object.prototype.hasOwnProperty.call(newRow, 'face_image_id')),
    chargeRows: chargeRows.length,
    delta: chargeRows[0] && chargeRows[0].delta,
    refType: chargeRows[0] && chargeRows[0].ref_type,
    idemKey: chargeRows[0] && chargeRows[0].idem_key,
    balance: balanceMapOf(ADMIN_IDENTITY.uid) && balanceMapOf(ADMIN_IDENTITY.uid).points
  })

  /* A5（本单新增）：新键 `row` ＝ **已落库的那一行本身**（与库内行深比较逐字一致）。 */
  const okRow = okReply.row
  const expectedExt = aiEnhance.PRODUCT_MIME_EXT[okReply.preview && okReply.preview.mime]
  check('A5', '⑨ 新键 `row` ＝ **已落库的那一行本身**：整行深比较逐字 ＝ 库内该行；`row._id` 逐字 ＝ `image_id`（`row.id` 同）、`row.storage` 逐字 `server`、`row.mime` 逐字 ＝ `preview.mime`、`row.storage_key` 以对应产物后缀（`.png`）结尾', {
    isObject: true,
    sameAsStored: true,
    idMatches: true,
    storage: 'server',
    mimeMatches: true,
    keyExt: 'png',
    keyExtMatchesMime: true,
    source: 'ai_enhance'
  }, {
    isObject: !!(okRow && typeof okRow === 'object' && !Array.isArray(okRow)),
    sameAsStored: !!okRow && JSON.stringify(okRow) === JSON.stringify(newRow),
    idMatches: !!(okRow && okRow._id === okReply.image_id && okRow.id === okReply.image_id),
    storage: okRow && okRow.storage,
    mimeMatches: !!(okRow && okRow.mime === (okReply.preview && okReply.preview.mime)),
    keyExt: String((okRow && okRow.storage_key) || '').split('.').pop(),
    keyExtMatchesMime: !!(okRow && typeof okRow.storage_key === 'string' && expectedExt && okRow.storage_key.slice(-(`.${expectedExt}`).length) === `.${expectedExt}`),
    source: okRow && okRow.source
  })
}

/* ===========================================================================
   B 段：上游失败路（② 4xx ／ ③ 超时）⇒ 恰 4 键、UPSTREAM_ERROR、全退
   =========================================================================== */
section('B', '上游失败路：4xx ／ 超时 ⇒ 恰 4 键 + UPSTREAM_ERROR + refunded true + ledger 真退 10')

async function runUpstreamFailure(label, mode, requestId) {
  upstreamMode = mode
  const chargesBefore = chargeSpy.calls
  const refundBefore = refundSpy.calls
  const balanceBefore = balanceMapOf(ADMIN_IDENTITY.uid).points
  const reply = await enhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, requestId)
  const uid = ADMIN_IDENTITY.uid
  const kinds = flowRowsOf(uid)
    .filter((row) => row.idem_key === `ai-enhance-${SRC_OK}-${requestId}` || row.idem_key === `ai-enhance-${SRC_OK}-${requestId}-refund`)
    .map((row) => `${row.kind}:${row.delta}`)
    .sort()
  check(label, `②/③ 上游${mode === 'http400' ? ' 4xx（HTTP 400）' : '超时（AbortSignal.timeout 触发）'} ⇒ 失败回包**恰 4 键**、\`reason\` 逐字 \`UPSTREAM_ERROR\`、\`refunded: true\`；**ledger 真的退了 10**（余额复原 50、REFUND +10、原 CHARGE 行不删）`, {
    keys: ['ok', 'reason', 'message', 'refunded'].sort().join(','),
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    balance: balanceBefore,
    flow: ['CHARGE:-10', 'REFUND:10'],
    charged: 1,
    refundedCalls: 1
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    balance: balanceMapOf(uid) && balanceMapOf(uid).points,
    flow: kinds,
    charged: chargeSpy.calls - chargesBefore,
    refundedCalls: refundSpy.calls - refundBefore
  })
  upstreamMode = 'ok'
}

await runUpstreamFailure('B1', 'http400', 'rid-b4xx-0001')
await runUpstreamFailure('B2', 'hang', 'rid-btimeout-0001')

/* ===========================================================================
   C 段：拒绝面（④ 图源缺失 / 影像行不存在；⑤ 未知键 / 缺键）⇒ 零扣费
   =========================================================================== */
section('C', '拒绝面：INVALID_VALUE / INVALID_FIELD / MISSING_REQUIRED ⇒ refunded false + 零扣费（chargePoints 未被调用）')

const ZERO_UID = 'u-reject-zero-charge'
async function runRejection(label, title, payload, requestId, expectedReason) {
  const before = { charges: chargeSpy.calls, refunds: refundSpy.calls, flow: flowRowsOf(ZERO_UID).length, rows: imageRowsAll().length }
  const identity = { uid: ZERO_UID, phone: ADMIN_PHONE }
  const reply = await ops.ADMIN_OPS['ai-enhance-face'](payload, identity, CONTEXT(requestId))
  check(label, title, {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: expectedReason,
    refunded: false,
    zeroCharge: true,
    zeroRefund: true,
    zeroFlow: true,
    zeroRows: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    zeroCharge: chargeSpy.calls === before.charges,
    zeroRefund: refundSpy.calls === before.refunds,
    zeroFlow: flowRowsOf(ZERO_UID).length === before.flow,
    zeroRows: imageRowsAll().length === before.rows
  })
}

/* ④a 影像行不存在 ⇒ INVALID_VALUE。 */
await runRejection(
  'C1',
  '④ 影像行**不存在**（image_id 无行）⇒ `INVALID_VALUE`、`refunded: false`、零扣费（`chargePoints` 未被调用、流水零行、无新建影像行）',
  { image_id: 'img-missing-0001', seal_id: 's-1', face_id: 'f-1' },
  'rid-c1-missing-row',
  'INVALID_VALUE'
)

/* ④b 图源无从定位（行在、无合法 sha256）⇒ INVALID_VALUE。 */
{
  const SRC_NODIGEST = 'img-srcnodigest1'
  fakeDb.bucketOf('xiai_images').set(SRC_NODIGEST, { _id: SRC_NODIGEST, id: SRC_NODIGEST, kind: 'FACE', mime: 'image/png' })
  await runRejection(
    'C2',
    '④ 图源**无从定位**（行在但缺合法 `sha256` 摘要）⇒ `INVALID_VALUE`、`refunded: false`、零扣费',
    { image_id: SRC_NODIGEST, seal_id: 's-1', face_id: 'f-1' },
    'rid-c2-no-digest',
    'INVALID_VALUE'
  )
}

/* ④c 附：图源对象字节缺失（摘要在、存储四候选全取不到）⇒ STORAGE_UNAVAILABLE（拒绝面、零扣费）。 */
{
  const SRC_NOOBJ = 'img-srcnoobj001'
  fakeDb.bucketOf('xiai_images').set(SRC_NOOBJ, { _id: SRC_NOOBJ, id: SRC_NOOBJ, kind: 'FACE', mime: 'image/png', sha256: sha256Hex(Buffer.from('no-such-object-bytes', 'utf8')) })
  await runRejection(
    'C3',
    '④ 附：图源**对象缺失**（摘要在、存储取不到 png/webp/jpeg 展示件）⇒ `STORAGE_UNAVAILABLE`、`refunded: false`、零扣费（拒绝面、不是失败面）',
    { image_id: SRC_NOOBJ, seal_id: 's-1', face_id: 'f-1' },
    'rid-c3-no-object',
    'STORAGE_UNAVAILABLE'
  )
}

/* ⑤a 未知键 ⇒ INVALID_FIELD。 */
await runRejection(
  'C4',
  '⑤ 载荷含**未知键**（`gold_amount`）⇒ `INVALID_FIELD`、`refunded: false`、零扣费（金额一律由服务端给定）',
  { image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', gold_amount: 1 },
  'rid-c4-unknown-key',
  'INVALID_FIELD'
)

/* ⑤b 缺 image_id ⇒ MISSING_REQUIRED。 */
await runRejection(
  'C5',
  '⑤ **缺 `image_id`**（仅 `seal_id` / `face_id`）⇒ `MISSING_REQUIRED`、`refunded: false`、零扣费',
  { seal_id: 's-1', face_id: 'f-1' },
  'rid-c5-missing-key',
  'MISSING_REQUIRED'
)

/* ===========================================================================
   D 段：幂等与互逆（⑥ 重放；⑦ 并发；⑧ 互逆）
   =========================================================================== */
section('D', '幂等与互逆：同请求号重放零重扣零重建行 / 并发恰一路真跑 / 幂等键三样本确定互逆')

/* ⑥ 同请求号重放。 */
{
  const uid = ADMIN_IDENTITY.uid
  const before = {
    charges: chargeSpy.calls,
    uploads: uploads.length,
    upstream: upstreamCalls.length,
    flow: flowRowsOf(uid).filter((row) => row.idem_key === `ai-enhance-${SRC_OK}-${RID_OK}`).length,
    rows: imageRowsAll().length,
    balance: balanceMapOf(uid).points
  }
  const replay = await enhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID_OK)
  check('D1', '⑥ **同请求号重放** ⇒ `idempotent: true`、恰 9 键、同 `image_id`；不重复扣金（chargePoints 零新调、CHARGE 行仍 1）、不重复建行（影像行数不变）、不再调上游、余额不变', {
    keys: SUCCESS_KEYS,
    ok: true,
    idempotent: true,
    sameImageId: expectedNewId,
    noNewCharge: true,
    chargeRowsStill1: true,
    noNewRow: true,
    noNewUpstream: true,
    noNewUpload: true,
    balanceUnchanged: before.balance
  }, {
    keys: shapeOf(replay),
    ok: replay.ok,
    idempotent: replay.idempotent,
    sameImageId: replay.image_id,
    noNewCharge: chargeSpy.calls === before.charges,
    chargeRowsStill1: flowRowsOf(uid).filter((row) => row.idem_key === `ai-enhance-${SRC_OK}-${RID_OK}`).length === before.flow && before.flow === 1,
    noNewRow: imageRowsAll().length === before.rows,
    noNewUpstream: upstreamCalls.length === before.upstream,
    noNewUpload: uploads.length === before.uploads,
    balanceUnchanged: balanceMapOf(uid).points
  })
}

/* ⑦ 并发两发同 image_id（同请求号 ⇒ 同幂等键）。 */
{
  const SRC_CONC = 'img-srcconc0001'
  seedSourceImage(SRC_CONC)
  const RID_CONC = 'rid-d7-concurrent'
  const uid = ADMIN_IDENTITY.uid
  const before = { charges: chargeSpy.calls, upstream: upstreamCalls.length, uploads: uploads.length, balance: balanceMapOf(uid).points }
  const [first, second] = await Promise.all([
    enhance({ image_id: SRC_CONC, seal_id: 's-1', face_id: 'f-1' }, RID_CONC),
    enhance({ image_id: SRC_CONC, seal_id: 's-1', face_id: 'f-1' }, RID_CONC)
  ])
  const chargeRows = flowRowsOf(uid).filter((row) => row.idem_key === `ai-enhance-${SRC_CONC}-${RID_CONC}` && row.kind === 'CHARGE')
  const concRows = imageRowsAll().filter((row) => row.source_image_id === SRC_CONC)
  check('D2', '⑦ **并发两发同 image_id**（同请求号）⇒ 两发皆回成功 9 键、恰一路真跑（`idempotent: false`）、另一路**等行回放**（`idempotent: true`）；真扣恰一次（CHARGE 恰 1 行、余额只减 10；两路都经 `chargePoints` ⇒ 调用增量 2、账本幂等收敛）、行恰一条、上游恰一调、上传恰一次', {
    bothOk: true,
    shapes: `${SUCCESS_KEYS},${SUCCESS_KEYS}`,
    realRuns: 1,
    replays: 1,
    sameImageId: true,
    chargeRows: 1,
    chargeCallsDelta: 2,
    imageRows: 1,
    upstreamDelta: 1,
    uploadDelta: 1,
    balance: before.balance - 10
  }, {
    bothOk: first.ok === true && second.ok === true,
    shapes: `${shapeOf(first)},${shapeOf(second)}`,
    realRuns: [first, second].filter((reply) => reply.idempotent === false).length,
    replays: [first, second].filter((reply) => reply.idempotent === true).length,
    sameImageId: first.image_id === second.image_id && /^img-[0-9a-f]{8}$/.test(String(first.image_id)),
    chargeRows: chargeRows.length,
    chargeCallsDelta: chargeSpy.calls - before.charges,
    imageRows: concRows.length,
    upstreamDelta: upstreamCalls.length - before.upstream,
    uploadDelta: uploads.length - before.uploads,
    balance: balanceMapOf(uid).points
  })
}

/* ⑧ `idemKeyOf` / `imageIdOfIdemKey` 互逆（三个样本）。 */
{
  const samples = [
    ['img-aaaaaaaa', 'rid-x1'],
    [SRC_OK, RID_OK],
    ['img-zzzzzzzz', 'rid-another-9']
  ]
  const perSample = samples.map(([imageId, requestId]) => {
    const idem = aiEnhance.idemKeyOf(imageId, requestId)
    const newId = aiEnhance.imageIdOfIdemKey(idem)
    const newIdAgain = aiEnhance.imageIdOfIdemKey(idem)
    const idemAgain = aiEnhance.idemKeyOf(imageId, requestId)
    return {
      idemShape: idem === `ai-enhance-${imageId}-${requestId}`,
      idemStable: idemAgain === idem,
      newIdShape: /^img-[0-9a-f]{8}$/.test(newId),
      newIdStable: newIdAgain === newId
    }
  })
  const ids = samples.map(([imageId, requestId]) => aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(imageId, requestId)))
  const idems = samples.map(([imageId, requestId]) => aiEnhance.idemKeyOf(imageId, requestId))
  check('D3', '⑧ `idemKeyOf` ↔ `imageIdOfIdemKey` 互逆：三个样本上幂等键形态逐字（三段封闭）、派生新编号形态 `img-`＋8 位十六进制、**同样本重算恒等**（确定性）且**异样本互不碰撞**；并经真流程钉住（A1 的 `image_id` ＝ `imageIdOfIdemKey(idemKeyOf(原编号, 请求号))`）', {
    perSample: [{ idemShape: true, idemStable: true, newIdShape: true, newIdStable: true }, { idemShape: true, idemStable: true, newIdShape: true, newIdStable: true }, { idemShape: true, idemStable: true, newIdShape: true, newIdStable: true }],
    distinctIds: true,
    distinctIdems: true,
    pinnedByLiveFlow: expectedNewId
  }, {
    perSample,
    distinctIds: new Set(ids).size === samples.length,
    distinctIdems: new Set(idems).size === samples.length,
    pinnedByLiveFlow: okReply.image_id
  })
}

/* ===========================================================================
   E 段：静态门（薄委派零第二套逻辑；实现点零取库句柄字面；新 reason 登记）
   =========================================================================== */
section('E', '静态门：委派恰一处 require / 实现点零集合句柄字面 / REASONS 13 值含 UPSTREAM_ERROR')

{
  const { readFileSync } = require('node:fs')
  const opsSource = readFileSync(path.join(FN_DIR, 'lib/ops.js'), 'utf8')
  const implSource = readFileSync(path.join(FN_DIR, 'lib/aiEnhance.js'), 'utf8')
  const countIn = (text, needle) => String(text).split(needle).length - 1
  check('E1', '注册面恰一处 `ai-enhance-face` 成员、恰一处 `require(\'./aiEnhance.js\')`（薄委派零第二套逻辑）；实现点**零集合句柄字面**（零 `collection(`、零 `.doc(` —— 读写一律经 `ops.js` 读点）', {
    memberInOps: 1,
    requireInOps: 1,
    collectionLiterals: 0,
    docCalls: 0,
    reasonsSize: 13,
    upstreamErrorRegistered: true
  }, {
    memberInOps: countIn(opsSource, "'ai-enhance-face'"),
    requireInOps: countIn(opsSource, "require('./aiEnhance.js')"),
    collectionLiterals: countIn(implSource, 'collection('),
    docCalls: countIn(implSource, '.doc('),
    reasonsSize: Object.keys(userConfig.REASONS).length,
    upstreamErrorRegistered: userConfig.REASONS.UPSTREAM_ERROR === 'UPSTREAM_ERROR'
  })
}

/* ===========================================================================
   F 段：非 2xx 上游诊断（诊断补丁单 · `upstreamDetailOf` 经真流程钉住：
   ① 402 带 detail ⇒ message 带上游原话 ② 402 空体 ⇒ body=empty ③ 500 纯文本 ⇒ 原文前 80 字
   ④ detail 带 48 位长串 ⇒ <redacted>（回包内零出现）⑤ 键面仍恰 4 键且 refunded true
   ⑥ 超时分支 message 逐字不变）
   =========================================================================== */
section('F', '非 2xx 上游诊断：message 带上游原话（抹除截长）；失败键面仍 4 键 + refunded true；超时文案逐字不变')

async function runDiag(mode, requestId) {
  upstreamMode = mode
  const reply = await enhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, requestId)
  upstreamMode = 'ok'
  return reply
}

{
  const diagReplies = {
    detail: await runDiag('diag402detail', 'rid-f1-402-detail'),
    empty: await runDiag('diag402empty', 'rid-f2-402-empty'),
    text500: await runDiag('diag500text', 'rid-f3-500-text'),
    leak: await runDiag('diag402leak', 'rid-f4-402-leak')
  }

  /* ① 402 + FastAPI 风格 detail ⇒ message 带上游原话。 */
  const detailMessage = String(diagReplies.detail.message)
  check('F1', '① 假上游 402 + {"detail":"API key spend limit exceeded; remaining $0.0050"} ⇒ 失败 message **带上游原话**（含 spend limit exceeded 与 remaining；HTTP 402 在场）', {
    http402: true,
    spendLimitExceeded: true,
    remaining: true,
    reason: 'UPSTREAM_ERROR'
  }, {
    http402: detailMessage.indexOf('HTTP 402：') !== -1,
    spendLimitExceeded: detailMessage.indexOf('spend limit exceeded') !== -1,
    remaining: detailMessage.indexOf('remaining') !== -1,
    reason: diagReplies.detail.reason
  })

  /* ② 402 + 空体 ⇒ body=empty。 */
  const emptyMessage = String(diagReplies.empty.message)
  check('F2', '② 假上游 402 + **空体** ⇒ message 含 body=empty（「空体」与「有体读不懂」可区分）', {
    http402: true,
    bodyEmpty: true
  }, {
    http402: emptyMessage.indexOf('HTTP 402：') !== -1,
    bodyEmpty: emptyMessage.indexOf('body=empty') !== -1
  })

  /* ③ 500 + 纯文本（非 JSON）⇒ 原文前 80 字。 */
  const textMessage = String(diagReplies.text500.message)
  check('F3', '③ 假上游 500 + **纯文本** Internal error（非 JSON）⇒ message 含原文 Internal error', {
    http500: true,
    internalError: true
  }, {
    http500: textMessage.indexOf('HTTP 500：') !== -1,
    internalError: textMessage.indexOf('Internal error') !== -1
  })

  /* ④ 402 + detail 带 48 位长串 ⇒ 抹除（回包内零出现）。 */
  const leakSerialized = JSON.stringify(diagReplies.leak)
  check('F4', '④ 假上游 402 + {"detail":"leak " + 48 位 a} ⇒ **回包内不得出现那 48 位串**（必须被 <redacted> 抹除）', {
    leakAbsent: true,
    redacted: true
  }, {
    leakAbsent: leakSerialized.indexOf(LEAK_48) === -1,
    redacted: String(diagReplies.leak.message).indexOf('<redacted>') !== -1
  })

  /* ⑤ 诊断改动不动回包键面：恰 4 键、refunded 恒 true。 */
  const diagNames = ['detail', 'empty', 'text500', 'leak']
  check('F5', '⑤ 诊断改动**不动回包键面**：四例失败回包均恰 4 键（message,ok,reason,refunded）且 refunded: true（退金判据未因诊断改动而漂）', {
    shapes: ['message,ok,reason,refunded', 'message,ok,reason,refunded', 'message,ok,reason,refunded', 'message,ok,reason,refunded'],
    refundedAll: true
  }, {
    shapes: diagNames.map((name) => shapeOf(diagReplies[name])),
    refundedAll: diagNames.every((name) => diagReplies[name].refunded === true)
  })

  /* ⑥ 超时分支 message 逐字不变（不得被新诊断污染）。 */
  const timeoutReply = await runDiag('hang', 'rid-f6-timeout-verbatim')
  check('F6', '⑥ **超时分支 message 逐字仍为原样**（網絡 / 超時：超時；不得被新诊断污染）', {
    message: 'AI 修復上游調用失敗（網絡 / 超時：超時）⇒ 已全額退回 10 金；本次未建影像行、未改印面指向。',
    keys: 'message,ok,reason,refunded',
    reason: 'UPSTREAM_ERROR',
    refunded: true
  }, {
    message: timeoutReply.message,
    keys: shapeOf(timeoutReply),
    reason: timeoutReply.reason,
    refunded: timeoutReply.refunded
  })
}

/* ===========================================================================
   G 段：2xx 无图的**形状诊断**（诊断单 · `upstreamShapeOf` 经真流程钉住：
  ① 200 + 异步对象 data ⇒ message 带 data / task_id / status 键名
  ② 200 + data[0] 只有 image_url ⇒ message 带 image_url 键名
  ③ 两例整份失败回包（含 message）序列化零出现 t-1 与图片 URL（零值泄露）
  ④ 200 + data[0].b64_json 真 PNG ⇒ 仍成功、回包恰 9 键（既有行为不被破坏））
   =========================================================================== */
section('G', '2xx 无图形状诊断：message 带回包键名轮廓（零值泄露）；b64_json 真图仍成功恰 9 键')

{
  const shapeAsyncReply = await runDiag('shapeAsyncObject', 'rid-g1-shape-async-object')
  const shapeNoImageReply = await runDiag('shapeNoImageField', 'rid-g2-shape-no-image-field')

  /* ① 200 + {code,message,data:{task_id,status}}（`data` 为对象）⇒ message 带 data / task_id / status。 */
  const shapeAsyncMessage = String(shapeAsyncReply.message)
  check('G1', '① 假上游 200 + {"code":0,"message":"ok","data":{"task_id":"t-1","status":"pending"}}（`data` 为**对象**、非数组）⇒ 失败 message **带形状轮廓**（含顶层 `data` 键名与 `data 键=（task_id,status）`；HTTP 200 在场；仍 `UPSTREAM_ERROR` ＋ `refunded: true`）', {
    hasData: true,
    hasTaskId: true,
    hasStatus: true,
    http200: true,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    keys: 'message,ok,reason,refunded'
  }, {
    hasData: shapeAsyncMessage.indexOf('data') !== -1,
    hasTaskId: shapeAsyncMessage.indexOf('task_id') !== -1,
    hasStatus: shapeAsyncMessage.indexOf('status') !== -1,
    http200: shapeAsyncMessage.indexOf('HTTP 200') !== -1,
    reason: shapeAsyncReply.reason,
    refunded: shapeAsyncReply.refunded,
    keys: shapeOf(shapeAsyncReply)
  })

  /* ② 200 + data[0].image_url（无 b64_json、无 url）⇒ message 带 image_url。 */
  const shapeNoImageMessage = String(shapeNoImageReply.message)
  check('G2', '② 假上游 200 + {"data":[{"image_url":"https://x/y.png"}]}（`data[0]` 有对象但无 `b64_json`、无 `url`）⇒ 失败 message **带形状轮廓**（含 `data[0] 键=（image_url）`；仍 `UPSTREAM_ERROR` ＋ `refunded: true`）', {
    hasImageUrl: true,
    hasData0: true,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    keys: 'message,ok,reason,refunded'
  }, {
    hasImageUrl: shapeNoImageMessage.indexOf('image_url') !== -1,
    hasData0: shapeNoImageMessage.indexOf('data[0]') !== -1,
    reason: shapeNoImageReply.reason,
    refunded: shapeNoImageReply.refunded,
    keys: shapeOf(shapeNoImageReply)
  })

  /* ③ 零值泄露：两例整份失败回包（含 message）序列化后不得出现哨兵值。 */
  const shapeSerialized = JSON.stringify(shapeAsyncReply) + JSON.stringify(shapeNoImageReply)
  check('G3', '③ **零值泄露**：上述两例整份失败回包（含 `message`；恰 4 键、零额外字段）序列化后**不得出现** `t-1` 与 `https://x/y.png`（形状只带键名、不带值）', {
    taskAbsent: true,
    urlAbsent: true,
    shapes: ['message,ok,reason,refunded', 'message,ok,reason,refunded']
  }, {
    taskAbsent: shapeSerialized.indexOf(SHAPE_LEAK_TASK) === -1,
    urlAbsent: shapeSerialized.indexOf(SHAPE_LEAK_URL) === -1,
    shapes: [shapeOf(shapeAsyncReply), shapeOf(shapeNoImageReply)]
  })

  /* ④ 200 + data[0].b64_json 真 PNG ⇒ 仍成功、回包恰 9 键（既有取图行为不被形状诊断破坏）。 */
  const shapeOkReply = await runDiag('ok', 'rid-g4-shape-b64-ok')
  check('G4', '④ 假上游 200 + {"data":[{"b64_json":"<真 PNG base64>"}]} ⇒ **仍成功**：`ok: true`、回包**恰 9 键**（既有 b64_json 取图行为不被形状诊断破坏）', {
    ok: true,
    keys: SUCCESS_KEYS,
    previewMime: 'image/png',
    upstreamStatus: 200
  }, {
    ok: shapeOkReply.ok,
    keys: shapeOf(shapeOkReply),
    previewMime: shapeOkReply.preview && shapeOkReply.preview.mime,
    upstreamStatus: shapeOkReply.upstream_status
  })
}

/* ===========================================================================
   H 段：异步入队轮询（异步单 · 200 + `data[0].task_id` ⇒ `GET /tasks/<task_id>` 取图）
  =========================================================================== */
section('H', '异步入队轮询：pending→completed 下载恰 9 键 / failed·violation 全退 / 次数上限停 / 缺 result_urls / 同步路不破')

/* 轮询假 sleep（注入缝）：不真睡 5 秒 × 20 —— 整段秒内跑完；注入面**只**影响异步轮询路。 */
aiEnhance.setAiEnhanceSleepProvider(async () => {})

const H_SRC = SRC_OK
const hFlowKinds = (requestId) =>
  flowRowsOf(ADMIN_IDENTITY.uid)
    .filter(
      (row) =>
        row.idem_key === `ai-enhance-${H_SRC}-${requestId}` || row.idem_key === `ai-enhance-${H_SRC}-${requestId}-refund`
    )
    .map((row) => `${row.kind}:${row.delta}`)
    .sort()

/* ① 入队 pending → 第 2 次查询 completed 带 result_urls → 下载成功。 */
{
  const uid = ADMIN_IDENTITY.uid
  const RID = 'rid-h1-async-pending-then-done'
  upstreamMode = 'asyncEnqueue'
  pollPlan = [
    { status: 200, body: { status: 'pending', display_status: 'pending' } },
    { status: 200, body: { status: 'completed', display_status: 'succeeded', result_urls: [PRODUCT_URL] } }
  ]
  pollQueries.length = 0
  const uploadsBefore = uploads.length
  const balanceBefore = balanceMapOf(uid).points
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  const upload = uploads[uploads.length - 1]
  const firstQuery = pollQueries[0]
  check('H1', '① 入队回执 pending ⇒ 第 2 次查询 `completed` 带 `result_urls` ⇒ 下载成功：回包**恰 9 键**、`preview.sha256` 逐字 ＝ **下载字节**的 sha256（且上传字节与下载字节逐字节相等）、恰 2 次查询（URL ＝ base_url 去尾斜杠拼 `/tasks/` 拼 task_id、方法 GET、认证头在场）、`upstream_status` 仍为**首次 POST** 的 200、扣金恰 10', {
    keys: SUCCESS_KEYS,
    ok: true,
    idempotent: false,
    queries: 2,
    taskUrl: 'https://api.upstream.example/v1/tasks/task-h-async-0001',
    method: 'GET',
    bearer: true,
    previewShaMatchesDownload: true,
    uploadedBytesEqual: true,
    newUploads: 1,
    upstreamStatus: 200,
    balance: balanceBefore - 10
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    idempotent: reply.idempotent,
    queries: pollQueries.length,
    taskUrl: firstQuery && firstQuery.url,
    method: firstQuery && firstQuery.method,
    bearer: !!(
      firstQuery &&
      typeof firstQuery.authorization === 'string' &&
      firstQuery.authorization.indexOf(AUTH_PREFIX) === 0 &&
      firstQuery.authorization.length > AUTH_PREFIX.length
    ),
    previewShaMatchesDownload: !!(reply.preview && reply.preview.sha256 === sha256Hex(PRODUCT_BYTES)),
    uploadedBytesEqual: uploads.length === uploadsBefore + 1 && Buffer.compare(upload.bytes, PRODUCT_BYTES) === 0,
    newUploads: uploads.length - uploadsBefore,
    upstreamStatus: reply.upstream_status,
    balance: balanceMapOf(uid).points
  })
}

/* ② 查询回 failed 带 error_msg ⇒ UPSTREAM_ERROR ＋ 全退 10。 */
{
  const uid = ADMIN_IDENTITY.uid
  const RID = 'rid-h2-async-failed'
  const ERROR_MSG = 'content policy violation: task rejected by upstream'
  upstreamMode = 'asyncEnqueue'
  pollPlan = [{ status: 200, body: { status: 'failed', error_msg: ERROR_MSG } }]
  pollQueries.length = 0
  const balanceBefore = balanceMapOf(uid).points
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  const message = String(reply.message)
  check('H2', '② 查询回 `failed` 带 `error_msg` ⇒ 失败回包**恰 4 键**、`UPSTREAM_ERROR`、message **含 `error_msg` 原话**（`failed` 状态与 HTTP 200 在场）、`refunded: true` 且 **ledger 真退 10**（REFUND +10、余额复原）', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    hasStatus: true,
    hasErrorMsg: true,
    http200: true,
    queries: 1,
    flow: ['CHARGE:-10', 'REFUND:10'],
    balance: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    hasStatus: message.indexOf('failed') !== -1,
    hasErrorMsg: message.indexOf(ERROR_MSG) !== -1,
    http200: message.indexOf('HTTP 200') !== -1,
    queries: pollQueries.length,
    flow: hFlowKinds(RID),
    balance: balanceMapOf(uid).points
  })
}

/* ③ 查询回 violation（且回包无 error_msg）⇒ 同上（文案含 violation 与缺省文案）。 */
{
  const uid = ADMIN_IDENTITY.uid
  const RID = 'rid-h3-async-violation'
  upstreamMode = 'asyncEnqueue'
  pollPlan = [{ status: 200, body: { status: 'violation' } }]
  pollQueries.length = 0
  const balanceBefore = balanceMapOf(uid).points
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  const message = String(reply.message)
  check('H3', '③ 查询回 `violation`（回包**无** `error_msg`）⇒ 同上：恰 4 键、`UPSTREAM_ERROR`、message 含 `violation` 状态与「上游未給 error_msg」缺省文案、`refunded: true`、ledger 真退 10', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    hasStatus: true,
    fallbackNote: true,
    http200: true,
    queries: 1,
    flow: ['CHARGE:-10', 'REFUND:10'],
    balance: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    hasStatus: message.indexOf('violation') !== -1,
    fallbackNote: message.indexOf('上游未給 error_msg') !== -1,
    http200: message.indexOf('HTTP 200') !== -1,
    queries: pollQueries.length,
    flow: hFlowKinds(RID),
    balance: balanceMapOf(uid).points
  })
}

/* ④ 永远 pending ⇒ 到次数上限就停（实际查询次数 ≤ 20）且文案含 輪詢超時。 */
{
  const uid = ADMIN_IDENTITY.uid
  const RID = 'rid-h4-async-always-pending'
  upstreamMode = 'asyncEnqueue'
  pollPlan = [] /* 出尽 ⇒ 恒 `pending` —— 只能靠实现侧的次数上限收场。 */
  pollQueries.length = 0
  const balanceBefore = balanceMapOf(uid).points
  const startedAt = Date.now()
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  const elapsedMs = Date.now() - startedAt
  check('H4', '④ 永远 `pending` ⇒ **到次数上限就停**（实际查询次数 ≤ 20，恰 ＝ `AI_ENHANCE_POLL_MAX_QUERIES`；假 sleep ⇒ 整例毫秒级、零真睡）、message 含 `輪詢超時`、恰 4 键、`refunded: true`、ledger 真退 10', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    hasPollTimeout: true,
    queriesAtMost: true,
    queriesExact: 20,
    maxQueries: 20,
    budgetMs: 90000,
    intervalMs: 5000,
    fast: true,
    flow: ['CHARGE:-10', 'REFUND:10'],
    balance: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    hasPollTimeout: String(reply.message).indexOf('輪詢超時') !== -1,
    queriesAtMost: pollQueries.length <= aiEnhance.AI_ENHANCE_POLL_MAX_QUERIES,
    queriesExact: pollQueries.length,
    maxQueries: aiEnhance.AI_ENHANCE_POLL_MAX_QUERIES,
    budgetMs: aiEnhance.AI_ENHANCE_POLL_BUDGET_MS,
    intervalMs: aiEnhance.AI_ENHANCE_POLL_INTERVAL_MS,
    fast: elapsedMs < 5000,
    flow: hFlowKinds(RID),
    balance: balanceMapOf(uid).points
  })
}

/* ⑤ completed 但 result_urls 为空 ⇒ 文案含 result_urls。 */
{
  const uid = ADMIN_IDENTITY.uid
  const RID = 'rid-h5-async-no-result-urls'
  upstreamMode = 'asyncEnqueue'
  pollPlan = [{ status: 200, body: { status: 'completed', result_urls: [] } }]
  pollQueries.length = 0
  const balanceBefore = balanceMapOf(uid).points
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  const message = String(reply.message)
  check('H5', '⑤ 查询回 `completed` 但 `result_urls` **为空数组** ⇒ 恰 4 键、`UPSTREAM_ERROR`、message 含 `result_urls`（任務已完成但缺 result_urls）、`refunded: true`、ledger 真退 10', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    hasResultUrlsNote: true,
    http200: true,
    queries: 1,
    flow: ['CHARGE:-10', 'REFUND:10'],
    balance: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    hasResultUrlsNote: message.indexOf('result_urls') !== -1,
    http200: message.indexOf('HTTP 200') !== -1,
    queries: pollQueries.length,
    flow: hFlowKinds(RID),
    balance: balanceMapOf(uid).points
  })
}

/* ⑥ 同步形态（data[0].b64_json）仍成功 —— 旧路一字不破。 */
{
  const RID = 'rid-h6-sync-b64-still-ok'
  upstreamMode = 'ok'
  pollPlan = []
  pollQueries.length = 0
  const reply = await enhance({ image_id: H_SRC, seal_id: 's-1', face_id: 'f-1' }, RID)
  check('H6', '⑥ **同步形态**（`data[0].b64_json`）仍成功：恰 9 键、`preview.mime` 逐字 `image/png`、`upstream_status` 200、**零轮询查询**（旧同步路未被异步改动破坏）', {
    ok: true,
    keys: SUCCESS_KEYS,
    previewMime: 'image/png',
    upstreamStatus: 200,
    queries: 0
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    previewMime: reply.preview && reply.preview.mime,
    upstreamStatus: reply.upstream_status,
    queries: pollQueries.length
  })
}

/* ===========================================================================
   I 段：产物族 jpeg 扩面（§3.68 AI 产物容器族；`PRODUCT_MIME_EXT` 增 'image/jpeg' → 'jpg'）
   =========================================================================== */
section('I', '产物族扩 jpeg：JPEG 产物入册（键 .jpg / preview.mime image/jpeg）；png·webp 不破；GIF·GZIP 仍拒且全退')

/* 专用管理员身份（同白名单手机号、不同 uid ＋ 预置 100 金 —— 不动 ADMIN 的余额与用量轨迹）。 */
const I_IDENTITY = { uid: 'u-admin-ai-enhance-family', phone: ADMIN_PHONE }
const iBalance = () => balanceMapOf(I_IDENTITY.uid)
const iFlowKinds = (requestId) =>
  flowRowsOf(I_IDENTITY.uid)
    .filter(
      (row) =>
        row.idem_key === `ai-enhance-${SRC_OK}-${requestId}` || row.idem_key === `ai-enhance-${SRC_OK}-${requestId}-refund`
    )
    .map((row) => `${row.kind}:${row.delta}`)
    .sort()
fakeDb.bucketOf('xiai_balances').set(`bl-${I_IDENTITY.uid}`, { _id: `bl-${I_IDENTITY.uid}`, uid: I_IDENTITY.uid, points: 100, updated_at: 'seed' })
const iEnhance = (payload, requestId) => ops.ADMIN_OPS['ai-enhance-face'](payload, I_IDENTITY, CONTEXT(requestId))

/* ① 假上游给 JPEG（FF D8 FF 魔数）⇒ 成功入册：恰 9 键、preview.mime image/jpeg、键以 .jpg 结尾。 */
{
  const RID = 'rid-i1-product-jpeg'
  const uploadsBefore = uploads.length
  const balanceBefore = iBalance().points
  upstreamMode = 'okJpeg'
  const reply = await iEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  upstreamMode = 'ok'
  const upload = uploads[uploads.length - 1]
  const jpegSha = sha256Hex(JPEG_PRODUCT_BYTES)
  check('I1', '① 假上游给 **JPEG**（FF D8 FF 魔数）⇒ **成功**：回包**恰 9 键**、`preview.mime` 逐字 `image/jpeg`、上传键以 `.jpg` 结尾（内容寻址 `xiai/images/<前两位>/<sha>.jpg`）、上传字节与上游回图**逐字节相等**、扣金恰 10', {
    ok: true,
    keys: SUCCESS_KEYS,
    previewMime: 'image/jpeg',
    keyEndsWithJpg: true,
    keyContentAddressed: true,
    bytesEqual: true,
    newUploads: 1,
    upstreamStatus: 200,
    balance: balanceBefore - 10
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    previewMime: reply.preview && reply.preview.mime,
    keyEndsWithJpg: !!(upload && upload.cloudPath.slice(-4) === '.jpg'),
    keyContentAddressed: !!(upload && upload.cloudPath === `xiai/images/${jpegSha.slice(0, 2)}/${jpegSha}.jpg`),
    bytesEqual: !!(upload && Buffer.compare(upload.bytes, JPEG_PRODUCT_BYTES) === 0),
    newUploads: uploads.length - uploadsBefore,
    upstreamStatus: reply.upstream_status,
    balance: iBalance().points
  })
  /* I1b：新影像行入册自洽（读面按行内 sha / storage_key / mime 取图 ⇒ 三面必须对齐）。 */
  const row = fakeDb.bucketOf('xiai_images').get(reply.image_id)
  check('I1b', '① 新影像行入册自洽：`mime` 逐字 `image/jpeg`、`storage_key` 以 `.jpg` 结尾且**逐字 ＝ 上传键**、`sha256` ＝ 上传字节摘要', {
    mime: 'image/jpeg',
    keyEndsWithJpg: true,
    keyMatchesUpload: true,
    shaMatches: true
  }, {
    mime: row && row.mime,
    keyEndsWithJpg: !!(row && row.storage_key && row.storage_key.slice(-4) === '.jpg'),
    keyMatchesUpload: !!(row && upload && row.storage_key === upload.cloudPath),
    shaMatches: !!(row && row.sha256 === jpegSha && row.sha256 === sha256Hex(upload.bytes))
  })
}

/* ② png 仍成功、键以 .png（既有族不破）。 */
{
  const RID = 'rid-i2-product-png-still-ok'
  const uploadsBefore = uploads.length
  const balanceBefore = iBalance().points
  const reply = await iEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  const upload = uploads[uploads.length - 1]
  check('I2', '② **png 仍成功**：恰 9 键、`preview.mime` 逐字 `image/png`、上传键以 `.png` 结尾（既有族不破）', {
    ok: true,
    keys: SUCCESS_KEYS,
    previewMime: 'image/png',
    keyEndsWithPng: true,
    newUploads: 1,
    balance: balanceBefore - 10
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    previewMime: reply.preview && reply.preview.mime,
    keyEndsWithPng: !!(upload && upload.cloudPath.slice(-4) === '.png'),
    newUploads: uploads.length - uploadsBefore,
    balance: iBalance().points
  })
}

/* ③ webp 仍成功、键以 .webp。 */
{
  const RID = 'rid-i3-product-webp-still-ok'
  const uploadsBefore = uploads.length
  const balanceBefore = iBalance().points
  upstreamMode = 'okWebp'
  const reply = await iEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  upstreamMode = 'ok'
  const upload = uploads[uploads.length - 1]
  check('I3', '③ **webp 仍成功**：恰 9 键、`preview.mime` 逐字 `image/webp`、上传键以 `.webp` 结尾', {
    ok: true,
    keys: SUCCESS_KEYS,
    previewMime: 'image/webp',
    keyEndsWithWebp: true,
    newUploads: 1,
    balance: balanceBefore - 10
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    previewMime: reply.preview && reply.preview.mime,
    keyEndsWithWebp: !!(upload && upload.cloudPath.slice(-5) === '.webp'),
    newUploads: uploads.length - uploadsBefore,
    balance: iBalance().points
  })
}

/* ④ GIF / GZIP（非白名单字节）⇒ 仍报产物族拒绝且全额退款（两发；模式即复位）。 */
for (const [label, mode, rid, note] of [
  ['I4a', 'rejectGif', 'rid-i4a-product-gif-reject', 'GIF89a'],
  ['I4b', 'rejectGzip', 'rid-i4b-product-gzip-reject', 'GZIP（1f 8b）']
]) {
  upstreamMode = mode
  const balanceBefore = iBalance().points
  const reply = await iEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, rid)
  upstreamMode = 'ok'
  const message = String(reply.message)
  check(label, `④ 假上游给非白名单字节（${note}）⇒ **仍报产物族拒绝**：恰 4 键、\`reason\` 逐字 \`UPSTREAM_ERROR\`、message 含「產物族」、\`refunded: true\` 且 **ledger 真退 10**（REFUND +10、余额复原；原 CHARGE 行不删）`, {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'UPSTREAM_ERROR',
    refunded: true,
    hasFamilyNote: true,
    flow: ['CHARGE:-10', 'REFUND:10'],
    balance: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    hasFamilyNote: message.indexOf('產物族') !== -1,
    flow: iFlowKinds(rid),
    balance: iBalance().points
  })
}

/* ===========================================================================
   J 段（本单新增 · 736b340 专项）：⑨ 入册撞唯一索引（E11000）兜底 ＋ 诊断指纹 ＋ doc 清洗
   跑**真函数体**（`enhanceFace` → `ops.persist` → 注入式假 DB 的 `doc(id).set`）：
   `fakeDb.hooks.setInterceptor` 在 `set` 时抛平台错（可先种并发行），`hooks.setCalls` /
   `hooks.queries` 给出「set 几次」「按 sha256 读回几次」的机械读数。
   =========================================================================== */
section('J', '⑨ 重复键兜底：E11000 ⇒ 读回既有行视为成功（不退款不建第二行）／读不回 ⇒ 二次 set 后退款；非重复键走原重试；指纹带 E11000·keyPattern·keyValue；doc 清洗 undefined·NaN')

/* 专用管理员身份（同白名单手机号、不同 uid ＋ 预置 100 金 —— 不动既有余额与用量轨迹）。 */
const J_IDENTITY = { uid: 'u-admin-ai-enhance-dupkey', phone: ADMIN_PHONE }
fakeDb.bucketOf('xiai_balances').set(`bl-${J_IDENTITY.uid}`, { _id: `bl-${J_IDENTITY.uid}`, uid: J_IDENTITY.uid, points: 100, updated_at: 'seed' })
const jEnhance = (payload, requestId) => ops.ADMIN_OPS['ai-enhance-face'](payload, J_IDENTITY, CONTEXT(requestId))
const jFlowKinds = (requestId) =>
  flowRowsOf(J_IDENTITY.uid)
    .filter(
      (row) =>
        row.idem_key === `ai-enhance-${SRC_OK}-${requestId}` || row.idem_key === `ai-enhance-${SRC_OK}-${requestId}-refund`
    )
    .map((row) => `${row.kind}:${row.delta}`)
    .sort()
const jNewIdOf = (requestId) => aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(SRC_OK, requestId))
const jHooks = fakeDb.hooks
const jSetCallsOf = (imageId) => jHooks.setCalls.filter((call) => call.collection === ops.COLLECTIONS.images && call.id === imageId)
const jShaReadsFrom = (mark) =>
  jHooks.queries.slice(mark).filter((q) => q.collection === ops.COLLECTIONS.images && Object.prototype.hasOwnProperty.call(q.match, 'sha256'))
/* 每例一份**全库唯一**的产物字节（新 sha256 ⇒ 「按 sha256 读回」的命中 / 落空由用例自己说了算）。 */
const jUniqueBytes = (tag) => Buffer.concat([PNG_MAGIC, Buffer.from(`offline-dupkey-product-${tag}`, 'utf8')])
/* 平台 bulk write 多写错原文（带 ≥40 位长串 —— 抹除面同尺断言）；`code` 取 `E11000` 同真源。 */
const J_DUP_MESSAGE = `[FailedOperation] multiple write errors: [{write errors: [{E11000 duplicate key error index: sha256_1 dup key: { sha256: "${LEAK_48}" } keyPattern: { sha256: 1 } keyValue: { sha256: "${LEAK_48}" } }]}]`
/* ⑨ 失败文案前缀（与改动前 `b403e9e` **逐字同** —— 本次只在其后拼诊断段）。 */
const J_FAIL_PREFIX = '修復產物影像行入册失敗（權威存儲不可用）⇒ 已全額退回 10 金；不留半成品行、未改印面指向。（診斷：'
const jFingerprintOf = (message) => (/（診斷：([\s\S]*)）$/.exec(String(message)) || [, ''])[1]
/* 指纹里**最后一层**的 message 段（`<name> / <code> / <message>` 三段取末段）。 */
const jFpMessageSegOf = (fingerprint) => {
  const parts = String(fingerprint).split(' ⇒ ')
  return parts[parts.length - 1].split(' / ').slice(2).join(' / ')
}
const jThrower = (targetId, makeError) => ({ collection, id, bucket }) => {
  if (collection !== ops.COLLECTIONS.images || id !== targetId) return
  makeError(bucket)
}

/* ---------------- J1（判据 A）：重复键 ＋ 按 `_id` 读回命中 ⇒ 视为成功、不退款、不建第二行 ---------------- */
{
  const RID = 'rid-j1-dupkey-readback-hit'
  const newId = jNewIdOf(RID)
  const bytes = jUniqueBytes('j1')
  const productSha = sha256Hex(bytes)
  /* 「并发写方」已抢先落的那一行（挂在同一行号下 ⇒ 第一路读回命中）。 */
  const existingRow = {
    _id: newId,
    id: newId,
    stamp_id: 's-1',
    sealId: 's-1',
    kind: 'FACE',
    storage: 'server',
    storage_key: `xiai/images/${productSha.slice(0, 2)}/${productSha}.png`,
    sha256: productSha,
    bytes: bytes.length,
    bytesLength: bytes.length,
    mime: 'image/png',
    width: null,
    height: null,
    source: 'ai_enhance',
    displayOnly: true,
    source_image_id: SRC_OK,
    charge_balance_after: 90,
    upstream_status: 200,
    elapsed_ms: 7,
    created_at: '2026-11-02T12:00:00.000Z'
  }
  uniqueProductBytes = bytes
  upstreamMode = 'okUnique'
  const rowsBefore = imageRowsAll().length
  const refundBefore = refundSpy.calls
  jHooks.setInterceptor = jThrower(newId, (bucket) => {
    bucket.set(newId, Object.assign({}, existingRow))
    const error = new Error(J_DUP_MESSAGE)
    error.code = 'E11000'
    throw error
  })
  const reply = await jEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  jHooks.setInterceptor = null
  upstreamMode = 'ok'
  const stored = fakeDb.bucketOf('xiai_images').get(newId)
  const setCalls = jSetCallsOf(newId)
  const rowsForId = imageRowsAll().filter((row) => row.id === newId)
  check('J1', '⑨ 抛重复键错（`E11000 duplicate key` ＋ `keyPattern` ＋ `keyValue`）且按 `_id` 读回命中 ⇒ **视为成功**：回包 `ok: true`、**恰 9 键**、`image_id` 逐字 ＝ 读回行 id、`row` ＝ 库内行（深比较）、`preview.sha256` ＝ 读回行摘要；**退款 0 次**、`set` 恰 1 次（不重试）、库内不新增第二行（该行号恰 1 行、影像行总数只多「并发写方」那 1 行）；扣金恰 10', {
    ok: true,
    keys: SUCCESS_KEYS,
    idempotent: false,
    imageIdIsReadBackRow: true,
    rowIsStoredRow: true,
    previewShaMatchesRow: true,
    refundCalls: 0,
    setCalls: 1,
    rowsForId: 1,
    imageRowsDelta: 1,
    flow: ['CHARGE:-10'],
    balanceAfterCharge: 90
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    idempotent: reply.idempotent,
    imageIdIsReadBackRow: reply.image_id === existingRow.id && reply.image_id === newId,
    rowIsStoredRow: !!reply.row && JSON.stringify(reply.row) === JSON.stringify(stored),
    previewShaMatchesRow: !!(reply.preview && reply.row && reply.preview.sha256 === productSha && reply.row.sha256 === productSha),
    refundCalls: refundSpy.calls - refundBefore,
    setCalls: setCalls.length,
    rowsForId: rowsForId.length,
    imageRowsDelta: imageRowsAll().length - rowsBefore,
    flow: jFlowKinds(RID),
    balanceAfterCharge: balanceMapOf(J_IDENTITY.uid).points
  })
}

/* ---------------- J2（判据 B ＋ D 前半）：两路均读不回 ⇒ 二次 set 后失败、退款恰 1 次 ---------------- */
let jDupReply = null
{
  const RID = 'rid-j2-dupkey-readback-miss'
  const newId = jNewIdOf(RID)
  uniqueProductBytes = jUniqueBytes('j2')
  upstreamMode = 'okUnique'
  const rowsBefore = imageRowsAll().length
  const refundBefore = refundSpy.calls
  const balanceBefore = balanceMapOf(J_IDENTITY.uid).points
  /* 不种任何并发行 ⇒ 按 `_id` 与按 `sha256` 两路都读不回（每例产物 sha 全库唯一，故 sha 路必空）。 */
  jHooks.setInterceptor = jThrower(newId, () => {
    const error = new Error(J_DUP_MESSAGE)
    error.code = 'E11000'
    throw error
  })
  const reply = await jEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  jHooks.setInterceptor = null
  upstreamMode = 'ok'
  jDupReply = reply
  const setCalls = jSetCallsOf(newId)
  check('J2', '⑨ 抛重复键错但按 `_id` 与 `sha256` **两路均读不回** ⇒ 按 `seq` 递增重试（首试 ＋ 3 次递增 ⇒ `set` 恰 4 次）、仍失败才判失败：回包**恰 4 键**、`reason` 逐字 `STORAGE_UNAVAILABLE`、`refunded: true` 且 **ledger 恰退款 1 次**（REFUND +10、余额复原到扣前值）、零建行；文案前缀与改动前**逐字一致**', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'STORAGE_UNAVAILABLE',
    refunded: true,
    refundCalls: 1,
    setCalls: 4,
    imageRowsDelta: 0,
    flow: ['CHARGE:-10', 'REFUND:10'],
    prefixVerbatim: true,
    balanceRestored: balanceBefore
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    refundCalls: refundSpy.calls - refundBefore,
    setCalls: setCalls.length,
    imageRowsDelta: imageRowsAll().length - rowsBefore,
    flow: jFlowKinds(RID),
    prefixVerbatim: String(reply.message).indexOf(J_FAIL_PREFIX) === 0,
    balanceRestored: balanceMapOf(J_IDENTITY.uid).points
  })
}

/* ---------------- J3（判据 C）：非重复键错 ⇒ 走原「重试一次」、零读回 ---------------- */
{
  const RID = 'rid-j3-nondup-retry'
  const newId = jNewIdOf(RID)
  uniqueProductBytes = jUniqueBytes('j3')
  upstreamMode = 'okUnique'
  const rowsBefore = imageRowsAll().length
  const refundBefore = refundSpy.calls
  const queriesMark = jHooks.queries.length
  jHooks.setInterceptor = jThrower(newId, () => {
    const error = new Error('connect ETIMEDOUT 10.0.0.1:443')
    error.code = 'ETIMEDOUT'
    throw error
  })
  const reply = await jEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  jHooks.setInterceptor = null
  upstreamMode = 'ok'
  const setCalls = jSetCallsOf(newId)
  const shaReads = jShaReadsFrom(queriesMark)
  check('J3', '⑨ 抛**非重复键错**（`ETIMEDOUT`）⇒ 走原「重试一次」路：`set` 恰 2 次、**零读回**（按 `sha256` 的读计数 0）、退款恰 1 次、`reason` 逐字 `STORAGE_UNAVAILABLE`、文案前缀逐字一致、零建行', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'STORAGE_UNAVAILABLE',
    refunded: true,
    refundCalls: 1,
    setCalls: 2,
    shaReads: 0,
    imageRowsDelta: 0,
    flow: ['CHARGE:-10', 'REFUND:10'],
    prefixVerbatim: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    refundCalls: refundSpy.calls - refundBefore,
    setCalls: setCalls.length,
    shaReads: shaReads.length,
    imageRowsDelta: imageRowsAll().length - rowsBefore,
    flow: jFlowKinds(RID),
    prefixVerbatim: String(reply.message).indexOf(J_FAIL_PREFIX) === 0
  })
}

/* ---------------- J4（判据 D 前半）：E11000 失败文案的指纹面（锚段在场 ＋ 长串抹除） ---------------- */
{
  const message = String((jDupReply && jDupReply.message) || '')
  const fingerprint = jFingerprintOf(message)
  const fpMessageSeg = jFpMessageSegOf(fingerprint)
  check('J4', 'D 指纹面：J2 的 E11000 失败文案**同时含** `E11000`、`keyPattern`、`keyValue`；≥40 位长串已抹为 `<redacted>`（整份回包零出现该长串）；指纹 message 段**不超 120 字**且非空', {
    hasE11000: true,
    hasKeyPattern: true,
    hasKeyValue: true,
    redacted: true,
    leakAbsent: true,
    fpSegNonEmpty: true,
    fpSegWithin120: true
  }, {
    hasE11000: message.indexOf('E11000') !== -1,
    hasKeyPattern: message.indexOf('keyPattern') !== -1,
    hasKeyValue: message.indexOf('keyValue') !== -1,
    redacted: message.indexOf('<redacted>') !== -1,
    leakAbsent: message.indexOf(LEAK_48) === -1,
    fpSegNonEmpty: fpMessageSeg.length > 0,
    fpSegWithin120: fpMessageSeg.length <= 120
  })
}

/* ---------------- J5（判据 D 后半）：无锚错误 ⇒ 回退取起始段（不抛错、不超长、非旧 60 字） ---------------- */
{
  const RID = 'rid-j5-fingerprint-no-anchor'
  const newId = jNewIdOf(RID)
  uniqueProductBytes = jUniqueBytes('j5')
  upstreamMode = 'okUnique'
  const refundBefore = refundSpy.calls
  /* 无任一锚段（`E\d{5}` / duplicate key / keyPattern / keyValue / AlreadyExists / RESOURCE_ALREADY_EXISTS）的长文案。 */
  jHooks.setInterceptor = jThrower(newId, () => {
    throw new Error('boom '.repeat(60))
  })
  const reply = await jEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  jHooks.setInterceptor = null
  upstreamMode = 'ok'
  const fingerprint = jFingerprintOf(String(reply.message))
  const fpMessageSeg = jFpMessageSegOf(fingerprint)
  const boomRuns = fpMessageSeg.split('boom').length - 1
  const setCalls = jSetCallsOf(newId)
  check('J5', 'D 回退规则：**无锚**错误的指纹不抛错（回包仍恰 4 键、`STORAGE_UNAVAILABLE`、退款 1 次、`set` 2 次）、指纹 message 段 **≤120 字且 >60 字**（不回旧 60 字上限）、内容取自原文起始段（`boom` 在场、出现次数被上限封顶）', {
    keys: 'message,ok,reason,refunded',
    ok: false,
    reason: 'STORAGE_UNAVAILABLE',
    refunded: true,
    refundCalls: 1,
    setCalls: 2,
    prefixVerbatim: true,
    fpSegNonEmpty: true,
    fpSegWithin120: true,
    fpSegBeyondOld60: true,
    fpHasBoom: true,
    fpBoomRunsCapped: true
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    reason: reply.reason,
    refunded: reply.refunded,
    refundCalls: refundSpy.calls - refundBefore,
    setCalls: setCalls.length,
    prefixVerbatim: String(reply.message).indexOf(J_FAIL_PREFIX) === 0,
    fpSegNonEmpty: fpMessageSeg.length > 0,
    fpSegWithin120: fpMessageSeg.length <= 120,
    fpSegBeyondOld60: fpMessageSeg.length > 60,
    fpHasBoom: fpMessageSeg.indexOf('boom') !== -1,
    fpBoomRunsCapped: boomRuns <= 24
  })
}

/* ---------------- J6（判据 E）：入册前 doc 清洗（`undefined` / `NaN` 一律不落） ---------------- */
{
  const RID = 'rid-j6-doc-sanitize'
  const newId = jNewIdOf(RID)
  uniqueProductBytes = jUniqueBytes('j6')
  upstreamMode = 'okUnique'
  /* 模拟「服务端取不到结算后余额」：只改**回传值**（`balance_after` ⇒ `undefined`），不动账本行。 */
  const chargeWrap = ledger.chargePoints
  ledger.chargePoints = async (params) => {
    const result = await chargeWrap(params)
    return result && result.ok === true ? Object.assign({}, result, { balance_after: undefined }) : result
  }
  const reply = await jEnhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID)
  ledger.chargePoints = chargeWrap
  upstreamMode = 'ok'
  const row = fakeDb.bucketOf('xiai_images').get(newId)
  const badValueKeys = row
    ? Object.keys(row).filter((key) => row[key] === undefined || (typeof row[key] === 'number' && Number.isNaN(row[key])))
    : ['<no-row>']
  const coreKeys = ['id', 'stamp_id', 'sealId', 'kind', 'storage', 'storage_key', 'sha256', 'bytes', 'bytesLength', 'mime', 'source', 'displayOnly', 'source_image_id', 'upstream_status', 'elapsed_ms', 'created_at']
  check('J6', 'E doc 清洗：`charge_balance_after` 取到 `undefined` ⇒ **落盘 doc 无该键**；落盘行**零 `undefined` / `NaN` 值键**、其余核心键一个不少；回包仍恰 9 键且 `row` ＝ 库内行', {
    ok: true,
    keys: SUCCESS_KEYS,
    rowFound: true,
    hasChargeBalanceAfter: false,
    badValueKeys: [],
    coreKeysAllPresent: true,
    replyRowMatchesStored: true
  }, {
    ok: reply.ok,
    keys: shapeOf(reply),
    rowFound: !!row,
    hasChargeBalanceAfter: !!(row && Object.prototype.hasOwnProperty.call(row, 'charge_balance_after')),
    badValueKeys,
    coreKeysAllPresent: !!row && coreKeys.every((key) => Object.prototype.hasOwnProperty.call(row, key)),
    replyRowMatchesStored: !!row && !!reply.row && JSON.stringify(reply.row) === JSON.stringify(row)
  })
}

/* ===========================================================================
   K 段：异步两段式三 op 契约（v1.97 §3.80 ／ AC-694〜AC-700；本单新增）
   —— 注入式假体（假 DB ／ 假账本 ／ 假对象存储 ／ 假上游 fetch 缝）；零网络、零生产数据
   =========================================================================== */
section('K', '异步两段式三 op：注册面 / 载荷封闭键面 / 回包恰几键与键名 / 四态字面值 / reason 零新增 / list 零写入')

const tasks = require(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'))
const TASK_COLLECTION = 'xiai_ai_enhance_tasks'
const taskRows = () => [...fakeDb.bucketOf(TASK_COLLECTION).values()]
const taskSetCalls = () => fakeDb.hooks.setCalls.filter((call) => call.collection === TASK_COLLECTION).length
const taskReads = () => fakeDb.hooks.queries.filter((query) => query.collection === TASK_COLLECTION).length
const sortedKeys = (list) => list.slice().sort()
/** 任务行 `xiai_ai_enhance_tasks` 的**期望键面**（恰 19 项，含 `_id`；字典序 ＝ `shapeOf` 同一把尺 ——
 *  本单增 `charge_state`，故 18 → 19）。 */
const TASK_ROW_KEYS = ['_id', 'charge_amount', 'charge_balance_after', 'charge_state', 'created_at', 'deadline_at', 'error_message', 'error_reason', 'face_id', 'product_image_id', 'refunded', 'request_id', 'seal_id', 'source_image_id', 'status', 'uid', 'updated_at', 'upstream_status', 'upstream_task_id'].sort()
/** 既有 `reason` 冻结面（13 值；与 `verify-ai-enhance-discard` G2 同一张表）。 */
const FROZEN_REASONS = ['FORBIDDEN', 'INVALID_VALUE', 'INVALID_FIELD', 'MISSING_REQUIRED', 'STORAGE_UNAVAILABLE', 'ALREADY_ENDORSED', 'DUPLICATE_VALUE', 'INSUFFICIENT_POINTS', 'KEY_INVALID', 'CONFIG_MISSING', 'LIMIT_DAY', 'LIMIT_MINUTE', 'UPSTREAM_ERROR']

/* K 段读数登记（失败 `reason` 与回包 `status` 字面值全程收集 ⇒ 末检「零新增 / 四态封闭」）。 */
const kReasons = new Set()
const kStatuses = new Set()
const note = (reply) => {
  if (reply && typeof reply.reason === 'string') kReasons.add(reply.reason)
  if (reply && typeof reply.status === 'string') kStatuses.add(reply.status)
  return reply
}
const K_OTHER_IDENTITY = { uid: 'u-not-admin-ai-enhance-k', phone: '13900000001' }
const kCtx = (requestId) => CONTEXT(requestId)
const submitOp = async (payload, identity, requestId) =>
  note(await ops.ADMIN_OPS['ai-enhance-submit'](payload, identity || ADMIN_IDENTITY, kCtx(requestId || 'rid-k-default')))
const statusOp = async (payload, identity) =>
  note(await ops.ADMIN_OPS['ai-enhance-status'](payload, identity || ADMIN_IDENTITY, kCtx('rid-k-status')))
const listOp = async (payload, identity) =>
  note(await ops.ADMIN_OPS['ai-enhance-list'](payload, identity || ADMIN_IDENTITY, kCtx('rid-k-list')))

/* --------------------------------------------------------------------------- *
  K 段假上游（`aiEnhanceTasks` 自己的 fetch 缝；生产不注入 ⇒ 全局 fetch）
  —— POST /images/edits ＝ 异步入队回执；GET /tasks/<id> ＝ 按 plan 出牌
 * --------------------------------------------------------------------------- */
const kTaskFetchCalls = []
const K_ENQUEUE_TASK_ID = 'up-k-async-0001'
let kQueryState = 'pending'
tasks.setTaskFetchProvider(async (url, init) => {
  const method = (init && init.method) || 'GET'
  kTaskFetchCalls.push({ url, method })
  if (method === 'POST') {
    return {
      ok: true,
      status: 200,
      json: async () => ({ created: 1, data: [{ task_id: K_ENQUEUE_TASK_ID, status: 'pending', display_status: 'pending' }], usage: {} })
    }
  }
  return { ok: true, status: 200, json: async () => ({ status: kQueryState }) }
})

/* 假账本余额护栏（**夹具**：只在余额不足 100 时把假余额行抬到 1000 —— 生产零接触）。 */
{
  const uid = ADMIN_IDENTITY.uid
  const row = balanceMapOf(uid)
  if (!row) fakeDb.bucketOf('xiai_balances').set(`bl-${uid}`, { _id: `bl-${uid}`, uid, points: 1000 })
  else if (!(Number(row.points) >= 100)) row.points = 1000
}

/* ---------------- K1：注册面（三 op 在册且为函数、字典序落位、legacy 仍在册） ---------------- */
{
  const keys = Object.keys(ops.ADMIN_OPS)
  const at = (name) => keys.indexOf(name)
  check('K1', '注册面：`ai-enhance-submit` / `ai-enhance-status` / `ai-enhance-list` 三 op 均在 `ADMIN_OPS` 且为**函数**，字典序位在 `ai-enhance-face` 之后、`backfillAcceptedCorrections` 之前；legacy `ai-enhance-face` / `ai-enhance-discard` 仍在册（函数）', {
    submit: 'function',
    status: 'function',
    list: 'function',
    face: 'function',
    discard: 'function',
    ordered: true
  }, {
    submit: typeof ops.ADMIN_OPS['ai-enhance-submit'],
    status: typeof ops.ADMIN_OPS['ai-enhance-status'],
    list: typeof ops.ADMIN_OPS['ai-enhance-list'],
    face: typeof ops.ADMIN_OPS['ai-enhance-face'],
    discard: typeof ops.ADMIN_OPS['ai-enhance-discard'],
    ordered:
      at('ai-enhance-face') !== -1 &&
      at('ai-enhance-face') < at('ai-enhance-list') &&
      at('ai-enhance-list') < at('ai-enhance-status') &&
      at('ai-enhance-status') < at('ai-enhance-submit') &&
      at('ai-enhance-submit') < at('backfillAcceptedCorrections')
  })
}

/* ---------------- K2：载荷 / 回包键面常量逐字封闭 ＋ 任务集合名逐字 ---------------- */
{
  check('K2', '键面常量逐字封闭：submit 载荷恰 4 键、status 恰 1 键、list 恰 1 键；回包常量 submit 成功 5 / 失败 4、status 4 / 6 / 5、list 成功 2 / 失败 3、`rows` 行恰 6 键；状态字面值恰四态；集合名逐字 `xiai_ai_enhance_tasks`', {
    submitPayload: ['face_id', 'image_id', 'request_id', 'seal_id'],
    statusPayload: ['task_id'],
    listPayload: ['face_id'],
    submitSuccess: ['charge', 'ok', 'source_image_id', 'status', 'task_id'],
    submitFailure: ['message', 'ok', 'reason', 'refunded'],
    statusRunning: ['ok', 'status', 'task_id', 'upstream_status'],
    statusReady: ['charge', 'image_id', 'ok', 'preview', 'status', 'task_id'],
    statusFailed: ['message', 'ok', 'reason', 'refunded', 'status'],
    listSuccess: ['ok', 'rows'],
    listFailure: ['message', 'ok', 'reason'],
    listRow: ['created_at', 'error_message', 'image_id', 'source_image_id', 'status', 'task_id'],
    statuses: ['FAILED', 'READY', 'RUNNING', 'SUBMITTED'],
    collection: TASK_COLLECTION
  }, {
    submitPayload: sortedKeys(tasks.SUBMIT_ALLOWED_KEYS),
    statusPayload: sortedKeys(tasks.STATUS_ALLOWED_KEYS),
    listPayload: sortedKeys(tasks.LIST_ALLOWED_KEYS),
    submitSuccess: sortedKeys(tasks.SUBMIT_SUCCESS_KEYS),
    submitFailure: sortedKeys(tasks.SUBMIT_FAILURE_KEYS),
    statusRunning: sortedKeys(tasks.STATUS_RUNNING_KEYS),
    statusReady: sortedKeys(tasks.STATUS_READY_KEYS),
    statusFailed: sortedKeys(tasks.STATUS_FAILED_KEYS),
    listSuccess: sortedKeys(tasks.LIST_SUCCESS_KEYS),
    listFailure: sortedKeys(tasks.LIST_FAILURE_KEYS),
    listRow: sortedKeys(tasks.LIST_ROW_KEYS),
    statuses: Object.values(tasks.TASK_STATUS).sort(),
    collection: tasks.AI_ENHANCE_TASKS_COLLECTION
  })
}

/* ---------------- K3：载荷封闭键面（行为面）＋ 管理员门（零读零写零扣费零上游） ---------------- */
{
  const chargesBefore = chargeSpy.calls
  const taskRowsBefore = taskRows().length
  const taskWritesBefore = taskSetCalls()
  const taskReadsBefore = taskReads()
  const upstreamBefore = kTaskFetchCalls.length
  const extra = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: 'rid-k-extra-0001', amount: 10 })
  const missing = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' })
  const badRid = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: 'x' })
  const nonString = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: 12345678 })
  const statusExtra = await statusOp({ task_id: 'aiet-0000000000000000', extra: 1 })
  const statusMissing = await statusOp({})
  const listExtra = await listOp({ face_id: 'f-1', limit: 5 })
  const listMissing = await listOp({})
  const gateSubmit = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: 'rid-k-gate-0001' }, K_OTHER_IDENTITY)
  const gateStatus = await statusOp({ task_id: 'aiet-0000000000000000' }, K_OTHER_IDENTITY)
  const gateList = await listOp({ face_id: 'f-1' }, K_OTHER_IDENTITY)
  check('K3', '载荷封闭键面（行为）：submit 多键 ⇒ `INVALID_FIELD`、缺键 ⇒ `MISSING_REQUIRED`、请求号形态 / 非字符串 ⇒ `INVALID_VALUE`（四发均**恰 4 键**、`refunded:false`）；status 多键 ⇒ `INVALID_FIELD`、缺键 ⇒ `MISSING_REQUIRED`（均**恰 5 键** 且 `status=FAILED`）；list 多键 ⇒ `INVALID_FIELD`、缺键 ⇒ `MISSING_REQUIRED`（均**恰 3 键**、**零 `refunded`**）；三 op 非白名单身份 ⇒ `FORBIDDEN`（键面 4 / 5 / 3）；全程**零扣费、零任务行、零写入、零上游、零任务行读取**（管理员门与载荷门先于一切读写）', {
    submitKeys: ['message,ok,reason,refunded', 'message,ok,reason,refunded', 'message,ok,reason,refunded', 'message,ok,reason,refunded'].join('|'),
    submitReasons: ['INVALID_FIELD', 'MISSING_REQUIRED', 'INVALID_VALUE', 'INVALID_VALUE'],
    submitRefundedAll: false,
    statusKeys: ['message,ok,reason,refunded,status', 'message,ok,reason,refunded,status'].join('|'),
    statusReasons: ['INVALID_FIELD', 'MISSING_REQUIRED'],
    statusAllFailed: true,
    listKeys: ['message,ok,reason', 'message,ok,reason'].join('|'),
    listReasons: ['INVALID_FIELD', 'MISSING_REQUIRED'],
    listHasRefunded: false,
    gateReasons: ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'],
    gateKeys: ['message,ok,reason,refunded', 'message,ok,reason,refunded,status', 'message,ok,reason'],
    zeroCharge: true,
    zeroTaskRows: true,
    zeroTaskWrites: true,
    zeroTaskReads: true,
    zeroUpstream: true
  }, {
    submitKeys: [extra, missing, badRid, nonString].map(shapeOf).join('|'),
    submitReasons: [extra, missing, badRid, nonString].map((reply) => reply.reason),
    submitRefundedAll: [extra, missing, badRid, nonString].some((reply) => reply.refunded !== false),
    statusKeys: [statusExtra, statusMissing].map(shapeOf).join('|'),
    statusReasons: [statusExtra, statusMissing].map((reply) => reply.reason),
    statusAllFailed: [statusExtra, statusMissing].every((reply) => reply.status === 'FAILED'),
    listKeys: [listExtra, listMissing].map(shapeOf).join('|'),
    listReasons: [listExtra, listMissing].map((reply) => reply.reason),
    listHasRefunded: [listExtra, listMissing].some((reply) => Object.prototype.hasOwnProperty.call(reply, 'refunded')),
    gateReasons: [gateSubmit, gateStatus, gateList].map((reply) => reply.reason),
    gateKeys: [gateSubmit, gateStatus, gateList].map(shapeOf),
    zeroCharge: chargeSpy.calls === chargesBefore,
    zeroTaskRows: taskRows().length === taskRowsBefore,
    zeroTaskWrites: taskSetCalls() === taskWritesBefore,
    zeroTaskReads: taskReads() === taskReadsBefore,
    zeroUpstream: kTaskFetchCalls.length === upstreamBefore
  })
}

/* ---------------- K4：submit 成功（异步入队）＝ 恰 5 键 ＋ 预扣 10 ＋ 任务行 18 字段 ---------------- */
const K_RID = 'rid-k-submit-0001'
let kSubmitReply = null
{
  const chargesBefore = chargeSpy.calls
  const taskWritesBefore = taskSetCalls()
  const upstreamBefore = kTaskFetchCalls.length
  const reply = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: K_RID }, undefined, K_RID)
  kSubmitReply = reply
  const rows = taskRows()
  const row = rows.length === 1 ? rows[0] : null
  const chargeRows = flowRowsOf(ADMIN_IDENTITY.uid).filter((entry) => entry.kind === 'CHARGE' && entry.idem_key === `ai-enhance-${SRC_OK}-${K_RID}`)
  check('K4', 'submit 成功（异步入队）：回包**恰 5 键** `ok / task_id / status / source_image_id / charge`、`status` 逐字 `SUBMITTED`、`task_id` 形态 `aiet-`＋16 位十六进制、`charge` 恰 `amount / balance` 两键且 `amount` 恰 10；**提交即预扣恰 1 次**（`CHARGE` 行 `delta = -10`、`ref_type = AI_IMAGE`、`idem_key` 三段封闭）；任务行落 `xiai_ai_enhance_tasks` 且**字段面恰 19 项**（含 `_id`；本单增 `charge_state`）、`status = SUBMITTED`、`upstream_task_id` 逐字 ＝ 上游回执号、`deadline_at` 晚于 `created_at` 20 分钟', {
    keys: 'charge,ok,source_image_id,status,task_id',
    ok: true,
    status: 'SUBMITTED',
    taskIdShape: true,
    chargeKeys: ['amount', 'balance'],
    chargeAmount: 10,
    chargeRows: 1,
    delta: -10,
    refType: 'AI_IMAGE',
    idemKey: `ai-enhance-${SRC_OK}-${K_RID}`,
    taskRowCount: 1,
    taskRowKeys: 19,
    taskRowKeyList: TASK_ROW_KEYS,
    taskRowStatus: 'SUBMITTED',
    upstreamTaskId: K_ENQUEUE_TASK_ID,
    deadlineAhead: true,
    upstreamCalls: 1,
    taskWrites: 1,
    chargeDelta: 1
  }, {
    keys: shapeOf(reply),
    ok: reply.ok,
    status: reply.status,
    taskIdShape: /^aiet-[0-9a-f]{16}$/.test(String(reply.task_id)),
    chargeKeys: reply.charge && typeof reply.charge === 'object' ? Object.keys(reply.charge).sort() : null,
    chargeAmount: reply.charge && reply.charge.amount,
    chargeRows: chargeRows.length,
    delta: chargeRows[0] && chargeRows[0].delta,
    refType: chargeRows[0] && chargeRows[0].ref_type,
    idemKey: chargeRows[0] && chargeRows[0].idem_key,
    taskRowCount: rows.length,
    taskRowKeys: row ? Object.keys(row).length : -1,
    taskRowKeyList: row ? Object.keys(row).sort() : null,
    taskRowStatus: row && row.status,
    upstreamTaskId: row && row.upstream_task_id,
    deadlineAhead: !!row && Date.parse(row.deadline_at) - Date.parse(row.created_at) === tasks.TASK_DEADLINE_MS,
    upstreamCalls: kTaskFetchCalls.length - upstreamBefore,
    taskWrites: taskSetCalls() - taskWritesBefore,
    chargeDelta: chargeSpy.calls - chargesBefore
  })
}

/* ---------------- K5：submit 同请求号幂等回放（零扣费、零上游、零新任务行） ---------------- */
{
  const chargesBefore = chargeSpy.calls
  const taskWritesBefore = taskSetCalls()
  const taskRowsBefore = taskRows().length
  const upstreamBefore = kTaskFetchCalls.length
  const reply = await submitOp({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1', request_id: K_RID }, undefined, K_RID)
  check('K5', 'submit 同 `request_id` 重放：回同一 `task_id`、回包仍**恰 5 键**、**零新增扣费**（`chargeSpy` 不动）、**零上游调用**、**零新任务行 / 零任务行写入**（幂等回放既有行）', {
    keys: 'charge,ok,source_image_id,status,task_id',
    sameTaskId: true,
    status: kSubmitReply.status,
    zeroCharge: true,
    zeroUpstream: true,
    zeroNewTaskRows: true,
    zeroTaskWrites: true
  }, {
    keys: shapeOf(reply),
    sameTaskId: reply.task_id === kSubmitReply.task_id,
    status: reply.status,
    zeroCharge: chargeSpy.calls === chargesBefore,
    zeroUpstream: kTaskFetchCalls.length === upstreamBefore,
    zeroNewTaskRows: taskRows().length === taskRowsBefore,
    zeroTaskWrites: taskSetCalls() === taskWritesBefore
  })
}

/* ---------------- K6：status 三态键面（RUNNING 4 / READY 6 / FAILED 5）＋ 终态零上游 ---------------- */
{
  const chargesBefore = chargeSpy.calls
  const taskWritesBefore = taskSetCalls()
  const upstreamBefore = kTaskFetchCalls.length
  const running = await statusOp({ task_id: kSubmitReply.task_id })
  const runningRow = fakeDb.bucketOf(TASK_COLLECTION).get(kSubmitReply.task_id)

  /* READY 终态（种子行；产物影像行 ＝ 既有 `SRC_OK` 行）。 */
  const readyId = 'aiet-k-ready-00000001'
  fakeDb.bucketOf(TASK_COLLECTION).set(readyId, {
    _id: readyId,
    uid: ADMIN_IDENTITY.uid,
    request_id: 'rid-k-ready-0001',
    source_image_id: SRC_OK,
    seal_id: 's-1',
    face_id: 'f-k-status',
    status: 'READY',
    upstream_task_id: '',
    upstream_status: 200,
    product_image_id: SRC_OK,
    charge_amount: 10,
    charge_balance_after: 40,
    error_reason: '',
    error_message: '',
    refunded: false,
    created_at: '2026-11-08T00:00:00.000Z',
    updated_at: '2026-11-08T00:00:00.000Z',
    deadline_at: '2026-11-08T00:20:00.000Z'
  })
  const ready = await statusOp({ task_id: readyId })

  /* FAILED 终态（种子行）。 */
  const failedId = 'aiet-k-failed-000001'
  fakeDb.bucketOf(TASK_COLLECTION).set(failedId, {
    _id: failedId,
    uid: ADMIN_IDENTITY.uid,
    request_id: 'rid-k-failed-0001',
    source_image_id: SRC_OK,
    seal_id: 's-1',
    face_id: 'f-k-status',
    status: 'FAILED',
    upstream_task_id: '',
    upstream_status: 500,
    product_image_id: '',
    charge_amount: 10,
    charge_balance_after: 50,
    error_reason: 'UPSTREAM_ERROR',
    error_message: '上游修復任務失敗（狀態＝failed）',
    refunded: true,
    created_at: '2026-11-08T00:00:00.000Z',
    updated_at: '2026-11-08T00:00:00.000Z',
    deadline_at: '2026-11-08T00:20:00.000Z'
  })
  const failed = await statusOp({ task_id: failedId })
  const absent = await statusOp({ task_id: 'aiet-k-no-such-task' })

  const terminalUpstream = kTaskFetchCalls.length - upstreamBefore - 1 /* RUNNING 那一发单查 */ 
  check('K6', 'status 按状态收窄：`RUNNING` **恰 4 键** `ok/task_id/status/upstream_status`（行被置 RUNNING）；`READY` **恰 6 键** `ok/task_id/status/image_id/preview/charge`（`preview` 恰 `mime/sha256`、`charge` 恰 `amount/balance`）；`FAILED` **恰 5 键** `ok/reason/message/refunded/status`；任务不存在 ⇒ `INVALID_VALUE` 且仍恰 5 键；**READY / FAILED / 不存在三发零上游、全程零扣费**（终态只回放）', {
    runningKeys: 'ok,status,task_id,upstream_status',
    runningStatus: 'RUNNING',
    runningRowStatus: 'RUNNING',
    readyKeys: 'charge,image_id,ok,preview,status,task_id',
    readyStatus: 'READY',
    readyPreviewKeys: ['mime', 'sha256'],
    readyChargeKeys: ['amount', 'balance'],
    readyImageId: SRC_OK,
    failedKeys: 'message,ok,reason,refunded,status',
    failedStatus: 'FAILED',
    failedReason: 'UPSTREAM_ERROR',
    failedRefunded: true,
    absentKeys: 'message,ok,reason,refunded,status',
    absentReason: 'INVALID_VALUE',
    terminalUpstreamCalls: 0,
    zeroCharge: true
  }, {
    runningKeys: shapeOf(running),
    runningStatus: running.status,
    runningRowStatus: runningRow && runningRow.status,
    readyKeys: shapeOf(ready),
    readyStatus: ready.status,
    readyPreviewKeys: ready.preview && typeof ready.preview === 'object' ? Object.keys(ready.preview).sort() : null,
    readyChargeKeys: ready.charge && typeof ready.charge === 'object' ? Object.keys(ready.charge).sort() : null,
    readyImageId: ready.image_id,
    failedKeys: shapeOf(failed),
    failedStatus: failed.status,
    failedReason: failed.reason,
    failedRefunded: failed.refunded,
    absentKeys: shapeOf(absent),
    absentReason: absent.reason,
    terminalUpstreamCalls: terminalUpstream,
    zeroCharge: chargeSpy.calls === chargesBefore
  })
}

/* ---------------- K7：list 只读（恰 2 键 / 每行恰 6 键 / 采纳过滤 / 零写入零扣费） ---------------- */
{
  const K_FACE = 'f-k-list-0001'
  const baseTask = {
    uid: ADMIN_IDENTITY.uid,
    seal_id: 's-1',
    face_id: K_FACE,
    upstream_task_id: '',
    upstream_status: 200,
    charge_amount: 10,
    charge_balance_after: 40,
    refunded: false,
    deadline_at: '2026-11-08T00:20:00.000Z'
  }
  const put = (id, patch) => fakeDb.bucketOf(TASK_COLLECTION).set(id, Object.assign({ _id: id }, baseTask, patch))
  put('aiet-k-l-submitted', {
    request_id: 'rid-k-l-1',
    source_image_id: SRC_OK,
    status: 'SUBMITTED',
    upstream_task_id: 'up-k-1',
    product_image_id: '',
    error_reason: '',
    error_message: '',
    created_at: '2026-11-08T01:00:00.000Z',
    updated_at: '2026-11-08T01:00:00.000Z'
  })
  put('aiet-k-l-ready', {
    request_id: 'rid-k-l-2',
    source_image_id: SRC_OK,
    status: 'READY',
    product_image_id: '',
    error_reason: '',
    error_message: '',
    created_at: '2026-11-08T02:00:00.000Z',
    updated_at: '2026-11-08T02:00:00.000Z'
  })
  put('aiet-k-l-failed', {
    request_id: 'rid-k-l-3',
    source_image_id: SRC_OK,
    status: 'FAILED',
    product_image_id: '',
    error_reason: 'UPSTREAM_ERROR',
    error_message: '上游修復任務失敗',
    created_at: '2026-11-08T03:00:00.000Z',
    updated_at: '2026-11-08T03:00:00.000Z'
  })
  put('aiet-k-l-adopted', {
    request_id: 'rid-k-l-4',
    source_image_id: SRC_OK,
    status: 'READY',
    product_image_id: 'img-k-adopted-0001',
    error_reason: '',
    error_message: '',
    created_at: '2026-11-08T04:00:00.000Z',
    updated_at: '2026-11-08T04:00:00.000Z'
  })
  fakeDb.bucketOf('xiai_faces').set('f-k-adopted-ref', { _id: 'f-k-adopted-ref', kind: 'FACE', face_image_id: 'img-k-adopted-0001' })

  const chargesBefore = chargeSpy.calls
  const taskWritesBefore = taskSetCalls()
  const allWritesBefore = fakeDb.hooks.setCalls.length
  const upstreamBefore = kTaskFetchCalls.length
  const reply = await listOp({ face_id: K_FACE })
  const rows = Array.isArray(reply.rows) ? reply.rows : []
  const rowShapes = [...new Set(rows.map(shapeOf))].sort()
  const statuses = [...new Set(rows.map((row) => row.status))].sort()
  const ordered = rows.map((row) => row.created_at)
  check('K7', 'list 只读：回包**恰 2 键** `ok / rows`；`rows` **每行恰 6 键** `task_id/status/image_id/source_image_id/created_at/error_message`（零内部字段、零 `plan` / `refunded`）；`READY` 且产物已被印面引用者**被采纳过滤不回**（4 行种入 ⇒ 回 3 行）、按 `created_at` 倒序；状态取值 ⊆ 四态；**零写入、零扣费、零上游**', {
    keys: 'ok,rows',
    rowCount: 3,
    rowShapes: ['created_at,error_message,image_id,source_image_id,status,task_id'],
    statuses: ['FAILED', 'READY', 'SUBMITTED'],
    orderedDesc: true,
    adoptedFiltered: true,
    zeroWrites: true,
    zeroCharge: true,
    zeroUpstream: true
  }, {
    keys: shapeOf(reply),
    rowCount: rows.length,
    rowShapes,
    statuses,
    orderedDesc: ordered.every((value, index) => index === 0 || ordered[index - 1] >= value),
    adoptedFiltered: rows.every((row) => row.image_id !== 'img-k-adopted-0001') && rows.length === 3,
    zeroWrites: fakeDb.hooks.setCalls.length === allWritesBefore && taskSetCalls() === taskWritesBefore,
    zeroCharge: chargeSpy.calls === chargesBefore,
    zeroUpstream: kTaskFetchCalls.length === upstreamBefore
  })
}

/* ---------------- K8：`reason` 零新增 ＋ 状态四态封闭 ---------------- */
{
  const seen = [...kReasons].sort()
  const statuses = [...kStatuses].sort()
  check('K8', 'K 段读数：失败 `reason` **零新增**（全部 ⊆ 既有冻结 13 值）；回包 `status` 只在四态字面值内（`SUBMITTED` / `RUNNING` / `READY` / `FAILED`）', {
    reasonSubset: true,
    reasonCountOk: true,
    statusSubset: true
  }, {
    reasonSubset: seen.every((reason) => FROZEN_REASONS.indexOf(reason) !== -1),
    reasonCountOk: Object.keys(userConfig.REASONS).length === 13,
    statusSubset: statuses.every((status) => Object.values(tasks.TASK_STATUS).indexOf(status) !== -1) && statuses.length > 0
  })
  console.log(JSON.stringify({ id: 'K8.readout', kReasons: seen, kStatuses: statuses }))
}

/* ---------------- K9：任务集合服务端专属（不进客户端读面真源） ---------------- */
{
  const { readFileSync } = require('node:fs')
  const occurrences = (text, needle) => String(text).split(needle).length - 1
  const dbSource = readFileSync(path.join(ROOT, 'src/data/db.js'), 'utf8')
  const taskSource = readFileSync(path.join(FN_DIR, 'lib/aiEnhanceTasks.js'), 'utf8')
  check('K9', '任务集合 `xiai_ai_enhance_tasks`：实现点集合名逐字恰 1 处；客户端读面真源 `src/data/db.js` **零出现**（服务端专属、不进 `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS` / `CLOUD_KEY_OF_LOCAL`）', {
    implLiterals: 1,
    clientReadFace: 0
  }, {
    implLiterals: occurrences(taskSource, "'xiai_ai_enhance_tasks'"),
    clientReadFace: occurrences(dbSource, 'xiai_ai_enhance_tasks') + occurrences(dbSource, 'ai_enhance_tasks')
  })
}

/* ---------------- K10：单次预算全部显著低于网关 60 秒上限 ---------------- */
{
  check('K10', '超时预算：提交 25 秒 / 单查 20 秒 / 下载 25 秒 / 入册 45 秒 / 整轮 45 秒，**任一 ≥ 60 秒即判负**；任务期限恰 20 分钟（`deadline_at` − `created_at`）', {
    submit: 25000,
    query: 20000,
    download: 25000,
    ingest: 45000,
    round: 45000,
    deadline: 1200000,
    allBelowGateway: true
  }, {
    submit: tasks.SUBMIT_POST_BUDGET_MS,
    query: tasks.STATUS_QUERY_BUDGET_MS,
    download: tasks.STATUS_DOWNLOAD_BUDGET_MS,
    ingest: tasks.STATUS_INGEST_BUDGET_MS,
    round: tasks.STATUS_ROUND_BUDGET_MS,
    deadline: tasks.TASK_DEADLINE_MS,
    allBelowGateway: [
      tasks.SUBMIT_POST_BUDGET_MS,
      tasks.STATUS_QUERY_BUDGET_MS,
      tasks.STATUS_DOWNLOAD_BUDGET_MS,
      tasks.STATUS_INGEST_BUDGET_MS,
      tasks.STATUS_ROUND_BUDGET_MS
    ].every((budget) => budget > 0 && budget < 60000)
  })
}

/* 收针：清 sleep 注入、复位上游模式（不留全局态给后续脚本进程）。 */
aiEnhance.setAiEnhanceSleepProvider(null)
upstreamMode = 'ok'
jHooks.setInterceptor = null

/* ===========================================================================
   收尾
   =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；注入缝＝ops 四缝（DB / 存储读 / 存储上传）＋ ledger / aiUpstream 存储缝 ＋ aiEnhance 上游 fetch / 轮询 sleep 缝。'
  })
)
process.exit(total === passed ? 0 : 1)
