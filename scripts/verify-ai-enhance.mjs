/**
 * 玺爱 · **自检：管理員人工智能修復（`ai-enhance-face`）**（本单新增）
 * ============================================================================ *
 * **本地、离线**（自造 DB 假体 ＋ 注入上游 fetch / 存储读 / 存储上传；零外部网络、零云端连接、
 * 零生产数据）。被测件：
 *   · `cloudfunctions/xiai-user-token/lib/aiEnhance.js`（唯一实现点：`enhanceFace` ＋ 幂等键纯函数）
 *   · `cloudfunctions/xiai-user-token/lib/ops.js` 的 `ADMIN_OPS['ai-enhance-face']`（薄委派注册面）
 *   · `lib/ledger.js` 扣费 / 退款单点（注入假存储）· `lib/aiUpstream.js` 上游配置（注入假存储）
 *
 * 断言面（本套 **26** 条 —— 原 16 条 ＋ 非 2xx 上游诊断 6 条 ＋ 2xx 形状诊断 4 条；覆盖派单方点名的 一〜八）：
 *   A. 注册面与成功路（①）
 *      A0 `ADMIN_OPS` 注册面（恰 18 项、`ai-enhance-face` 在册且为函数）；
 *      A1 回包**恰 8 键**；`image_id` 为新编号（`img-` ＋ 8 位十六进制 ≠ 原编号，且逐字
 *         ＝ `imageIdOfIdemKey(idemKeyOf(原编号, 请求号))`）；`source_image_id` 为原编号；
 *      A2 `preview.sha256` **逐字 ＝ 上传字节的 sha256**（且上传字节与上游回图字节**逐字节相等**、
 *         对象键为内容寻址 `xiai/images/<前两位>/<sha>.png`）；`charge.amount === 10`；
 *      A3 上游请求体恰五键（`model/prompt/size/resolution/image`）、`size` 逐字 `1:1`、
 *         `resolution` 逐字 `1K`、`prompt` 逐字 ＝ `lib/aiEnhancePrompt.js`、`image` 为 `data:` URL；
 *      A4 新影像行入册键面（不挂印面：零 `face_image_id`）；扣金恰 10（CHARGE 行 delta -10）。
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
 *      回包**恰 8 键**（既有取图行为不被破坏）。
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
/** 成功回包恰 8 键的**排序后**键面（`shapeOf` 排序口径）。 */
const SUCCESS_KEYS = ['ok', 'image_id', 'source_image_id', 'preview', 'charge', 'upstream_status', 'elapsed_ms', 'idempotent'].sort().join(',')

/* ---------------------------------------------------------------------------
   内存假 DB（形状对齐真实 SDK 使用面；`where(...).update(...)` 在**执行时**按过滤条件匹配；
   `tick` 让出事件循环 ⇒ 真并发可交错 —— 与 verify-points-ledger 同一只尺）
   --------------------------------------------------------------------------- */
const tick = () => new Promise((resolve) => setImmediate(resolve))
const rowMatches = (row, match) => Object.keys(match).every((key) => row[key] === match[key])

function createFakeDb() {
  const buckets = new Map()
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
          return makeQuery(map, { match })
        }
      }
    }
  }
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

let upstreamMode = 'ok'
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
const upstreamCalls = []
aiEnhance.setAiEnhanceFetchProvider(async (url, init) => {
  upstreamCalls.push({
    url,
    method: init && init.method,
    authorization: init && init.headers && init.headers.Authorization,
    body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null
  })
  const diag = Object.prototype.hasOwnProperty.call(DIAG_MODES, upstreamMode) ? DIAG_MODES[upstreamMode] : null
  if (diag) {
    /* 诊断模式（非 2xx）：回包带 `text()` 读体 —— 钉住 `upstreamDetailOf` 的四形态。 */
    return { ok: false, status: diag.status, text: async () => diag.body, json: async () => ({}) }
  }
  if (Object.prototype.hasOwnProperty.call(SHAPE_MODES, upstreamMode)) {
    /* 形状模式（2xx 但认不出图）：钉住 `upstreamShapeOf` 的键名轮廓（零值泄露）。 */
    return { ok: true, status: 200, json: async () => SHAPE_MODES[upstreamMode] }
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
section('A', '注册面与成功路：恰 8 键 / 新编号 / sha256 逐字一致 / 上游体五键 / 扣金恰 10')

{
  const keys = Object.keys(ops.ADMIN_OPS)
  check('A0', '`ADMIN_OPS` 恰 18 项且 `ai-enhance-face` 在册（函数；薄委派）', { count: 18, type: 'function' }, { count: keys.length, type: typeof ops.ADMIN_OPS['ai-enhance-face'] })
}

const RID_OK = 'rid-a-success-0001'
const expectedNewId = aiEnhance.imageIdOfIdemKey(aiEnhance.idemKeyOf(SRC_OK, RID_OK))
const uploadsBeforeOk = uploads.length
const okReply = await enhance({ image_id: SRC_OK, seal_id: 's-1', face_id: 'f-1' }, RID_OK)
{
  check('A1', '① 成功回包**恰 8 键**；`image_id` 为新编号（`img-`＋8 位十六进制、≠ 原编号、逐字 ＝ `imageIdOfIdemKey(idemKeyOf(原编号, 请求号))`）；`source_image_id` 为原编号', {
    keys: SUCCESS_KEYS,
    newIdShape: true,
    newIdDiffers: true,
    newIdDeterministic: expectedNewId,
    sourceIsOriginal: SRC_OK,
    ok: true,
    idempotent: false,
    upstreamStatus: 200
  }, {
    keys: shapeOf(okReply),
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
    rowKeys: ['_id', 'id', 'stamp_id', 'sealId', 'kind', 'storage', 'storage_key', 'sha256', 'bytes', 'bytesLength', 'mime', 'width', 'height', 'source', 'displayOnly', 'source_image_id', 'charge_balance_after', 'upstream_status', 'elapsed_ms', 'created_at'].sort().join(','),
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
  check('D1', '⑥ **同请求号重放** ⇒ `idempotent: true`、恰 8 键、同 `image_id`；不重复扣金（chargePoints 零新调、CHARGE 行仍 1）、不重复建行（影像行数不变）、不再调上游、余额不变', {
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
  check('D2', '⑦ **并发两发同 image_id**（同请求号）⇒ 两发皆回成功 8 键、恰一路真跑（`idempotent: false`）、另一路**等行回放**（`idempotent: true`）；真扣恰一次（CHARGE 恰 1 行、余额只减 10；两路都经 `chargePoints` ⇒ 调用增量 2、账本幂等收敛）、行恰一条、上游恰一调、上传恰一次', {
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
  ④ 200 + data[0].b64_json 真 PNG ⇒ 仍成功、回包恰 8 键（既有行为不被破坏））
   =========================================================================== */
section('G', '2xx 无图形状诊断：message 带回包键名轮廓（零值泄露）；b64_json 真图仍成功恰 8 键')

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

  /* ④ 200 + data[0].b64_json 真 PNG ⇒ 仍成功、回包恰 8 键（既有取图行为不被形状诊断破坏）。 */
  const shapeOkReply = await runDiag('ok', 'rid-g4-shape-b64-ok')
  check('G4', '④ 假上游 200 + {"data":[{"b64_json":"<真 PNG base64>"}]} ⇒ **仍成功**：`ok: true`、回包**恰 8 键**（既有 b64_json 取图行为不被形状诊断破坏）', {
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
   收尾
   =========================================================================== */
console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    sections: sectionStats,
    failed_ids: failedIds,
    note: '离线自检：不连云端、不写生产数据；注入缝＝ops 四缝（DB / 存储读 / 存储上传）＋ ledger / aiUpstream 存储缝 ＋ aiEnhance 上游 fetch 缝。'
  })
)
process.exit(total === passed ? 0 : 1)
