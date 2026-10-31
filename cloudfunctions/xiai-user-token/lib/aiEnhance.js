'use strict'
/**
 * 玺爱 · **管理员「人工智能修復」（`ai-enhance-face`）唯一实现点**
 * ============================================================================ *
 * 职责（本单范围）：印面影像 AI 修復的**全部业务逻辑**只在此落地 —— 载荷封闭键面 / 管理员门
 * 复核 / 图源取字节 / 上游配置读取 / 预扣与退款 / 上游调用与取图 / 内容寻址存储 / 新影像行入册
 * / 幂等回放；`lib/ops.js` 只做**注册与薄委派**（不写第二套逻辑）。
 *
 * 硬口径（逐条；派单方冻结契约 ①〜⑥ ＋ 规范 §3.68.1 〜 §3.68.7）：
 *  ① **载荷封闭恰三键** `image_id` / `seal_id` / `face_id`（三键皆字符串）：未知键 ⇒
 *     `INVALID_FIELD`；缺键 / 空键 ⇒ `MISSING_REQUIRED`；非字符串 / trim 后为空 ⇒
 *     `INVALID_VALUE`。一切拒绝**零扣费、零写入、未调上游**。
 *  ② **管理员门复用既有单点**（`ops.adminWhitelistDenial`；非管理员 ⇒ `FORBIDDEN` ＋ 零扣费）。
 *  ③ **图源只读云端展示件**：行 → 对象键由行内 `sha256` 拼
 *     `xiai/images/<摘要前两位>/<摘要>.<ext>`（ext 依次试 `.png` / `.webp` / `.jpg` / `.jpeg`，
 *     **绝不读 `.tiff` 源件、不涉转码**）；取不到（存储层报错）⇒ `STORAGE_UNAVAILABLE`；
 *     无行 / 无摘要 ⇒ `INVALID_VALUE`；字节魔数认不出（非 png / jpeg / webp）或 **> 2 MiB**
 *     ⇒ `INVALID_VALUE`。以上均在**预扣之前** ⇒ **零扣费**（拒绝面、不是失败面）。
 *  ④ **上游配置**：`lib/aiUpstream.resolveUpstreamSecret` 解出 `{base_url, model, key, timeout_ms}`
 *     （明文 key **永不进回包**）；缺配置 ⇒ `CONFIG_MISSING` ＋ **零扣费**（未预扣即拒）。
 *  ⑤ **预扣 10 金**（`ledger.chargePoints`；`kind=CHARGE`、`ref_type=AI_IMAGE`、
 *     `idem_key` ＝ `ai-enhance-` 拼 `image_id` 拼 `-` 拼请求号 —— 三段顺序封闭）；
 *     余额不足 ⇒ `INSUFFICIENT_POINTS` ＋ 零扣费。
 *  ⑥ **上游调用**：`POST <base_url>/images/edits`（`Authorization: Bearer <解密 key>`；体恰五键
 *     `{model, prompt, size, resolution, image}` —— `prompt` 固定全文（`lib/aiEnhancePrompt.js`
 *     逐字）、`size` 固定字符串 `1:1`、`resolution` 固定 `1K`、`image` ＝ `data:` URL；
 *     超时取行内 `timeout_ms`（`AbortSignal.timeout`）。非 2xx / 网络错 / 超时 / 取图失败 /
 *     图形魔数不认 ⇒ `UPSTREAM_ERROR` ＋ **全额退款**（`refunded: true`，原 `CHARGE` 行不删）。
 *  ⑦ **取图**：回包 `data[0].b64_json` 或 `data[0].url`（下载）⇒ 魔数校验（只收 png / webp ——
 *     产物族只有这两族，读面单点 `IMAGE_OBJECT_KEY_PATTERN` 只认 `.png|.webp`）；`data[0].task_id`
 *     （**异步入队回执**，生产实测 200 + `{created, data:[{task_id, status, display_status}], usage}`
 *     ）⇒ 轮询 `GET <base_url>/tasks/<task_id>` 取图（间隔 5 秒、总预算 90 秒、单查 30 秒、
 *     最多 20 次查询）：`completed` ⇒ 取 `result_urls` 首项下载；`failed` / `violation` ⇒
 *     `UPSTREAM_ERROR`（文案带抹除后的 `error_msg`）；预算 / 次数耗尽 ⇒ `輪詢超時`；
 *     `upstream_status` 仍为**首次 POST** 的状态码。两条都没有 ⇒ 仍报「回包缺圖片數據」。
 *  ⑧ **入册**：内容寻址键 `xiai/images/<新摘要前两位>/<新摘要>.<ext>` ＋ **新影像行**（8 位影像
 *     编号 `img-` ＋ 8 位十六进制 ＝ `sha256(idem_key)` 前 8 位 —— **确定性 ⇒ 重放不建第二行**；
 *     `sha256` / `bytes` / `bytesLength` / `mime` / `storage: 'server'` / `source: 'ai_enhance'` /
 *     `displayOnly: true` / `created_at`）；**不挂印面**（不写任何 `face_image_id`、不写面行）。
 *  ⑨ **成功回包恰 8 键**：`ok, image_id, source_image_id, preview{mime,sha256},
 *     charge{amount,balance}, upstream_status, elapsed_ms, idempotent`。
 *  ⑩ **失败回包恰 4 键**：`ok, reason, message, refunded` —— 任何失败路径**先确保退款**
 *     （已预扣 ⇒ 退、退成功 ⇒ `refunded: true`；未预扣 ⇒ `refunded: false`）。
 *  ⑪ **幂等**：同请求号重放 ⇒ 不重复扣金、不重复调上游、不重复建行，回首次结果
 *     （`idempotent: true`）；**并发两发同请求号** ⇒ 恰一路真跑、另一路等行回放（扣金恰一次、
 *     行恰一条、上游恰一调）。
 *
 * 存储 / 读点纪律：本文件**零取库句柄字面**（集合句柄一律经 `lib/ops.js` 的既有
 * 注入缝 / 导出读点取得 ⇒ 静态门 A8 / A8b 照旧成立）；上游明文 key 不打印、不日志、不进回包。
 * ============================================================================ *
 */

const crypto = require('crypto')
const { REASONS } = require('./config.js')
const { AI_ENHANCE_PROMPT } = require('./aiEnhancePrompt.js')

/* --------------------------------------------------------------------------- *
  常量面（封闭；客户端一律不可改）
 * --------------------------------------------------------------------------- */

/** op 名（与 `lib/ops.js` 注册面、前端 `src/services/aiEnhance.js::AI_ENHANCE_OP` 逐字一致）。 */
const AI_ENHANCE_OP = 'ai-enhance-face'

/** 单张修復成本（金）；**唯一写值处**沿规范 §3.67.2（本文件只引用、不另立数值）。 */
const AI_ENHANCE_COST = 10

/** `size` 固定字符串（**逐字 `1:1`**；派单方终审裁定 —— 不是 `1024x1024`）。 */
const AI_ENHANCE_SIZE = '1:1'

/** `resolution` 固定字符串（**逐字 `1K`**）。 */
const AI_ENHANCE_RESOLUTION = '1K'

/** 载荷封闭键面（恰三键）。 */
const AI_ENHANCE_ALLOWED_KEYS = Object.freeze(['image_id', 'seal_id', 'face_id'])

/** 冪等鍵前缀（三段拼法的第 1 段；顺序封闭）。 */
const IDEM_KEY_PREFIX = 'ai-enhance-'

/** 退款流水的冪等鍵后缀（与原 `CHARGE` 的 `idem_key` 区分；原行不删）。 */
const REFUND_IDEM_SUFFIX = '-refund'

/** 流水参照类型（复用既有冻结面 `ref_type` 取值；本单零新增）。 */
const REF_TYPE_AI_IMAGE = 'AI_IMAGE'

/** 图源字节上限（2 MiB；**硬口径 ③**）。 */
const SOURCE_MAX_BYTES = 2 * 1024 * 1024

/** 图源对象键的扩展名候选序（**绝不含 `.tiff`** —— 不读源件、不涉转码）。 */
const SOURCE_KEY_EXTS = Object.freeze(['.png', '.webp', '.jpg', '.jpeg'])

/** 图源对象键形态（`<摘要>` 段必须 ≡ 行内 sha256；客户端无法用一个路径冒充另一份内容）。 */
const SOURCE_KEY_PATTERN = /^xiai\/images\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|webp|jpg|jpeg)$/

/** 摘要形态（64 位小写十六进制）。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** 产物族（png / webp / **jpeg** —— 读面单点 `IMAGE_OBJECT_KEY_PATTERN` 同认这三族；
 *  之所以允许 jpeg：**上游 nano-banana 类模型原生输出常为 JPEG**（生产实测回图 FF D8 FF），
 *  `sniffImageMime` 本就认得 image/jpeg，此前缺此映射 ⇒ 下载成功的 JPEG 产物被误判
 *  「不是本面入册的產物族」而全额退回；jpeg 产物的对象键后缀取 `jpg`。 */
const PRODUCT_MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' })

/** 成功回包键面（恰 8 键；`preview` / `charge` 是嵌套对象 —— 顶层键面即此 8 个）。 */
const AI_ENHANCE_SUCCESS_KEYS = Object.freeze([
  'ok',
  'image_id',
  'source_image_id',
  'preview',
  'charge',
  'upstream_status',
  'elapsed_ms',
  'idempotent'
])

/** 失败回包键面（恰 4 键；`refunded` 恒为布尔）。 */
const AI_ENHANCE_FAILURE_KEYS = Object.freeze(['ok', 'reason', 'message', 'refunded'])

/** 并发回放等行护栏（路数 × 间隔；真跑方在窗口内完成上游 + 存储 + 入册 ⇒ 等行方回放）。 */
const REPLAY_POLL_ATTEMPTS = 40
const REPLAY_POLL_DELAY_MS = 25

/** 异步入队轮询面（**封闭常量**；官方协议 `GET <base_url>/tasks/<task_id>`）：
 *  间隔 5 秒；总预算 90 秒（自入队成功时刻算起）；单次查询超时 30 秒；
 *  **最多 20 次查询**（防意外死循环 —— 达到即按超时处理）。 */
const AI_ENHANCE_POLL_INTERVAL_MS = 5000
const AI_ENHANCE_POLL_BUDGET_MS = 90000
const AI_ENHANCE_POLL_QUERY_TIMEOUT_MS = 30000
const AI_ENHANCE_POLL_MAX_QUERIES = 20

/* --------------------------------------------------------------------------- *
  注入缝（离线自检 / 宿主用；生产不注入 ⇒ 走全局 `fetch`）
 * --------------------------------------------------------------------------- */

let fetchProvider = null

/**
 * 注入上游 HTTP 实现（`async (url, init) => Response`）；传非函数 ⇒ 清除注入。
 * **仅供离线自检 / 宿主**（回环测试把 `https` 改写成 `http` 再转发；生产走真实 `fetch`）。
 * @param {null|function(string, object):Promise<object>} fn
 */
function setAiEnhanceFetchProvider(fn) {
  fetchProvider = typeof fn === 'function' ? fn : null
}

/** 注入缝是否已注入（诊断读数用，**不含任何凭据**）。 */
function aiEnhanceFetchInjected() {
  return fetchProvider !== null
}

let sleepProvider = null

/**
 * 注入轮询间隔实现（`async (ms) => void`）；传非函数 ⇒ 清除注入。
 * **仅供离线自检 / 宿主**（假 sleep 即回 ⇒ 整套自检秒内跑完；生产不注入 ⇒ 真睡 5 秒间隔，
 * 绝不把「不睡」当生产行为）。异步轮询单点的注入缝 —— 不注入绝不影响同步取图路。
 * @param {null|function(number):Promise<void>} fn
 */
function setAiEnhanceSleepProvider(fn) {
  sleepProvider = typeof fn === 'function' ? fn : null
}

/** 轮询间隔注入缝是否已注入（诊断读数用）。 */
function aiEnhanceSleepInjected() {
  return sleepProvider !== null
}

/** 轮询间隔（注入缝 → 原生 `sleep`；只用于异步轮询路，回放等行路不动）。 */
function pollSleep(ms) {
  return sleepProvider ? sleepProvider(ms) : sleep(ms)
}

/* --------------------------------------------------------------------------- *
  小工具
 * --------------------------------------------------------------------------- */

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim()
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 失败回包（**恰 4 键**；`refunded` 恒布尔 —— 退费与否只由服务端说了算）。 */
function failure(reason, message, refunded) {
  return { ok: false, reason, message, refunded: refunded === true }
}

/** 按字节魔数判容器（认不出 ⇒ 空串 —— **不采信自称值**）。 */
function sniffImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return ''
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

/** `data:` URL（上游输入图形态；**回包零 `data:` 前缀** —— 只在服务端内存流转）。 */
function dataUrlOf(mime, bytes) {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** 冪等鍵（三段封闭：`ai-enhance-` 拼 `image_id` 拼 `-` 拼请求号）。 */
function idemKeyOf(imageId, requestId) {
  return `${IDEM_KEY_PREFIX}${imageId}-${requestId}`
}

/** 新影像行编号（**确定性**：`sha256(idem_key)` 前 8 位 ⇒ 同请求号重放落同一行、不建第二行）。 */
function imageIdOfIdemKey(idemKey) {
  return `img-${sha256Hex(Buffer.from(idemKey, 'utf8')).slice(0, 8)}`
}

/** 请求号：客户端可经顶层 `event.requestId`（＝ `X-Request-Id`）给出；缺位 ⇒ 服务端现铸
 *  （**每次调用都是全新可计费尝试** —— 不猜、不复用）。 */
function requestIdOf(context) {
  const given = text(context && context.requestId)
  if (given) return given
  return `srv-${crypto.randomBytes(8).toString('hex')}`
}

/* --------------------------------------------------------------------------- *
  读点（一律经 `lib/ops.js` 的既有导出；本文件零集合句柄字面）
 * --------------------------------------------------------------------------- */

function opsModule() {
  /* 延迟 require：与 `lib/aiUpstream.js` 同法（打破加载环；离线自检不需要 SDK）。 */
  return require('./ops.js')
}

function ledgerModule() {
  return require('./ledger.js')
}

/** 读新影像行（按 `id` 字段；无行 ⇒ `null`）。 */
async function readEnhanceRow(imageId) {
  const ops = opsModule()
  const rows = await ops.readRows(ops.COLLECTIONS.images, { id: text(imageId) }, { limit: 1 })
  return rows.length > 0 ? rows[0] : null
}

/** 读图源字节（存储层取不到 ⇒ 抛错 ⇒ 调用方转 `STORAGE_UNAVAILABLE`）。 */
async function readSourceBytes(objectKey) {
  const ops = opsModule()
  return ops.readArtifactBytes(objectKey)
}

/** 内容寻址上传（失败 ⇒ 抛错 ⇒ 调用方转退款 + `STORAGE_UNAVAILABLE`）。 */
async function uploadProductBytes(objectKey, bytes) {
  const ops = opsModule()
  await ops.uploadDisplayArtifactBytes(objectKey, bytes)
}

/** 新影像行入册（`doc(id).set` ⇒ 确定性 `_id` 幂等 upsert —— 重放不建第二行）。 */
async function persistEnhanceRow(imageId, doc) {
  const ops = opsModule()
  await ops.persist({ writes: [{ kind: 'set', collection: ops.COLLECTIONS.images, id: imageId, doc }] })
}

/* --------------------------------------------------------------------------- *
  资费（预扣 / 退款；单点 `lib/ledger.js`）
 * --------------------------------------------------------------------------- */

/**
 * 预扣 10 金。
 * @returns {Promise<{ok:true, balance:number, idempotent:boolean}|{ok:false, reason:string, message:string}>}
 */
async function chargeTen(uid, idemKey, imageId) {
  const ledger = ledgerModule()
  const charged = await ledger.chargePoints({
    uid,
    amount: AI_ENHANCE_COST,
    kind: 'CHARGE',
    ref_type: REF_TYPE_AI_IMAGE,
    ref_id: imageId,
    idem_key: idemKey
  })
  if (!charged || charged.ok !== true) {
    return { ok: false, reason: (charged && charged.reason) || REASONS.STORAGE_UNAVAILABLE, message: (charged && charged.message) || '積分扣減失敗；本次零寫入。' }
  }
  return { ok: true, balance: charged.balance_after, idempotent: charged.idempotent === true }
}

/**
 * 全额退款（已预扣才调；`ref_id` 与原 `CHARGE` 相同、原行不删）。
 * @returns {Promise<boolean>} 退款是否成功（失败 ⇒ `refunded: false` 如实上报）
 */
async function refundTen(uid, idemKey, imageId) {
  try {
    const ledger = ledgerModule()
    const refunded = await ledger.refundPoints({
      uid,
      amount: AI_ENHANCE_COST,
      kind: 'REFUND',
      ref_type: REF_TYPE_AI_IMAGE,
      ref_id: imageId,
      idem_key: `${idemKey}${REFUND_IDEM_SUFFIX}`
    })
    return !!(refunded && refunded.ok === true)
  } catch {
    return false
  }
}

/* --------------------------------------------------------------------------- *
  上游调用（配置读取 → POST → 取图）
 * --------------------------------------------------------------------------- */

/** 取上游 HTTP 实现（注入缝 → 全局 `fetch`；两者皆无 ⇒ 抛错 ⇒ 调用方转 `UPSTREAM_ERROR`）。 */
function resolveFetch() {
  if (fetchProvider) return fetchProvider
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  throw new Error('AI_ENHANCE_FETCH_UNAVAILABLE')
}

/**
 * 上游失败摘要（**零敏感**：状态码 ＋（经抹除截长的）上游错误体可读摘要 / 错误名；
 * 明文 key 永不进回包）。
 */
function upstreamFailureMessage(status, detail) {
  const statusText = Number.isInteger(status) && status > 0 ? `HTTP ${status}` : '網絡 / 超時'
  return `AI 修復上游調用失敗（${statusText}${detail ? `：${detail}` : ''}）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；本次未建影像行、未改印面指向。`
}

/**
 * 上游**非 2xx 错误体**的可读摘要（纯函数；**本文件唯一定义点**；零 I/O、零自抛）。
 *
 * 生产实测上游（maizitech / FastAPI）402 只回 `{"detail":"API key spend limit exceeded; …"}`，
 * 此前非 2xx 分支 detail 恒空串 ⇒ 管理员只看到「HTTP 402」、无从定位。口径与
 * `api/_lib/aiRelay.js::upstreamErrorDigestOf` 同族，此处取**最小版**：
 *   · 入参先 `trim`；空 ⇒ 回 `body=empty`（让「空体」与「有体读不懂」可区分）；
 *   · 尝试 `JSON.parse`：成功则**按序**取 `error.message` / `message` / `msg` / `detail` /
 *     （`error` 为**字符串**时的）`error` —— 取到就回**该值的抹除版**；
 *   · JSON 解析失败或取不到可读字段 ⇒ 回**原文前 80 字**（抹除版）；
 *   · 抹除规则：`/[A-Za-z0-9+/=]{40,}/g` → `<redacted>`（base64 / 长随机串一律抹掉），
 *     再截 120 字；**任何异常 ⇒ 回 `unknown`（不自抛）** —— 诊断面绝不影响主判定。
 * @param {string} rawText 上游响应体文本
 * @returns {string}
 */
function upstreamDetailOf(rawText) {
  const LIMIT = 120
  const REDACT = /[A-Za-z0-9+/=]{40,}/g
  const cut = (value) => {
    const safe = String(value === undefined || value === null ? '' : value).replace(REDACT, '<redacted>')
    return safe.length > LIMIT ? safe.slice(0, LIMIT) : safe
  }
  try {
    const raw = String(rawText === undefined || rawText === null ? '' : rawText).trim()
    if (!raw) return 'body=empty'
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const errorObj = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) ? parsed.error : null
      /* 按序取值；只认标量（对象 / 数组形态的字段不采信 ⇒ 落原文回退）。 */
      const candidates = [errorObj ? errorObj.message : undefined, parsed.message, parsed.msg, parsed.detail, errorObj ? undefined : parsed.error]
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' && typeof candidate !== 'number' && typeof candidate !== 'boolean') continue
        const out = cut(candidate)
        if (out) return out
      }
    }
    return cut(raw).slice(0, 80)
  } catch {
    return 'unknown'
  }
}

/**
 * 上游**2xx 回包的形状轮廓**（纯函数；**本文件唯一定义点**；零 I/O、零自抛）。
 *
 * 生产实测：上游 200 但回包里没有本面认得出的图（如异步形态 `{code,message,data:{task_id,status}}`）
 * 时，此前 detail 恒「回包缺圖片數據」、管理员无从判断上游到底回了什么。口径向
 * `api/_lib/aiRelay.js::shapeOutlineOf` 对齐，此处取**同尺版**：
 *   · 顶层键名逗号拼接（最多 8 个、每个截 24 字）；
 *   · `parsed.data` 是数组 ⇒ 追加 `; data[0] 键=（…）`（空数组则 `; data[]`）；是对象 ⇒
 *     追加 `; data 键=（…）`；
 *   · `output` / `result` / `images` 存在时同样追加一层键名（数组同 `data` 形态）；
 *   · **只取 `Object.keys`、绝不序列化任何值**（键名本身不含上游数据值 ⇒ 零值泄露）；
 *     总长截 240 字；**任何异常 ⇒ 回 `unknown`（不自抛）** —— 诊断面绝不影响主判定。
 * @param {*} parsed 上游 2xx 回包（已 `JSON.parse`）
 * @returns {string}
 */
function upstreamShapeOf(parsed) {
  const LIMIT = 240
  const keysOf = (value) => {
    if (!value || typeof value !== 'object') return null
    return Object.keys(value)
      .filter((key) => typeof key === 'string')
      .slice(0, 8)
      .map((key) => (key.length > 24 ? key.slice(0, 24) : key))
      .join(',')
  }
  const layerOf = (name, value) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return `; ${name}[]`
      return `; ${name}[0] 键=（${keysOf(value[0]) || ''}）`
    }
    if (value && typeof value === 'object') return `; ${name} 键=（${keysOf(value) || ''}）`
    return ''
  }
  try {
    if (!parsed || typeof parsed !== 'object') return 'unknown'
    let out = keysOf(parsed)
    if (out === null) return 'unknown'
    for (const name of ['data', 'output', 'result', 'images']) {
      if (Object.prototype.hasOwnProperty.call(parsed, name)) out += layerOf(name, parsed[name])
    }
    return out.length > LIMIT ? out.slice(0, LIMIT) : out
  } catch {
    return 'unknown'
  }
}

/**
 * 异步任务回包的**状态取值**（纯函数；**本文件唯一定义点**；零 I/O、零自抛）。
 * 口径（官方协议 `GET /tasks/<task_id>` 回包）：兼容**顶层 `status`** 与 **`payload.data.status`**
 * （`data` 为**对象**或**数组首项**两种形态都要认）；只认字符串 / 数字标量、trim 后转小写；
 * 取不到 ⇒ 空串（⇒ 调用方按「其他状态」睡后继续）。**任何异常 ⇒ 回空串（不自抛）。**
 * @param {*} parsed 任务查询回包（已 `JSON.parse`）
 * @returns {string}
 */
function taskStatusOf(parsed) {
  const pick = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return ''
    return text(value).toLowerCase()
  }
  try {
    if (!parsed || typeof parsed !== 'object') return ''
    const direct = pick(parsed.status)
    if (direct) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.status)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].status)
    return ''
  } catch {
    return ''
  }
}

/**
 * `completed` 任务的**产物 URL 列表**（纯函数；**本文件唯一定义点**；零 I/O、零自抛）。
 * 口径：兼容**顶层 `result_urls`** 与 **`payload.data.result_urls`**（`data` 为对象 / 数组首项
 * 两形态）；只收**非空字符串**项（滤掉空串 / 非字符串）；取不到 ⇒ 空数组（⇒ 调用方报
 * 「任務已完成但缺 result_urls」）。**任何异常 ⇒ 回空数组（不自抛）。**
 * @param {*} parsed 任务查询回包（已 `JSON.parse`）
 * @returns {string[]}
 */
function taskResultUrlsOf(parsed) {
  const pick = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [])
  try {
    if (!parsed || typeof parsed !== 'object') return []
    const direct = pick(parsed.result_urls)
    if (direct.length > 0) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.result_urls)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].result_urls)
    return []
  } catch {
    return []
  }
}

/**
 * `failed` / `violation` 任务的**错误原话 `error_msg`**（纯函数；**本文件唯一定义点**；
 * 零 I/O、零自抛）。口径：兼容**顶层 `error_msg`** 与 **`payload.data.error_msg`**（`data` 为
 * 对象 / 数组首项两形态）；只认字符串 / 数字标量；取不到 ⇒ 空串（⇒ 调用方写「上游未給 error_msg」）。
 * **任何异常 ⇒ 回空串（不自抛）。**
 * @param {*} parsed 任务查询回包（已 `JSON.parse`）
 * @returns {string}
 */
function taskErrorOf(parsed) {
  const pick = (value) => (typeof value === 'string' || typeof value === 'number' ? text(value) : '')
  try {
    if (!parsed || typeof parsed !== 'object') return ''
    const direct = pick(parsed.error_msg)
    if (direct) return direct
    const data = parsed.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return pick(data.error_msg)
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object') return pick(data[0].error_msg)
    return ''
  } catch {
    return ''
  }
}

/**
 * 异步任务轮询取图（**本文件唯一轮询点**；纯 I/O —— 零计费、零写入，退款仍在主流程）。
 *
 * 官方协议：`GET <base_url>/tasks/<task_id>`（去尾斜杠后拼接；`task_id` 经 `encodeURIComponent`
 * 编码；头带 `Authorization` 头（取值法同 ⑥ 的 POST 认证头：谓词 ＋ 空格 ＋ 解密后的 key；单次查询 `AbortSignal.timeout(30 秒)`）。
 * 节奏与护栏：间隔 `AI_ENHANCE_POLL_INTERVAL_MS`（5 秒，经注入缝可被自检替换 —— **不得真睡**）；
 * 总预算 `AI_ENHANCE_POLL_BUDGET_MS`（90 秒，自**入队成功时刻**算起）；**最多
 * `AI_ENHANCE_POLL_MAX_QUERIES`（20）次查询**（防意外死循环 —— 达到即按超时处理）。
 * 状态口径（每次回包先把状态取出，兼容顶层与 `data` 内两形态）：
 *   · `completed` ⇒ 取 `result_urls`（同样兼容两形态）**首项非空字符串** ⇒ 下载（30 秒超时）；
 *     拿不到 `result_urls` ⇒ 「任務已完成但缺 result_urls」；下载失败 / 空字节 ⇒ 「取圖下載失敗」；
 *   · `failed` / `violation` ⇒ 文案带抹除后的 `error_msg`（`upstreamDetailOf`；缺失 ⇒
 *     「上游未給 error_msg」）；
 *   · 其他状态（`pending` / `processing` / 空）⇒ 睡后继续；
 *   · 预算 / 次数耗尽 ⇒ `輪詢超時`；单次查询非 2xx ⇒ 带 HTTP 码与 `upstreamDetailOf`；
 *     查询抛错（超时 / 网络 / 坏 JSON）⇒ 同归 `UPSTREAM_ERROR`（**不得死循环**）。
 * @param {function(string, object):Promise<object>} fetchImpl 上游 HTTP 实现（调用方已解析）
 * @param {{base_url:string, key:string}} upstream 解出的上游配置（明文 key 永不进回包）
 * @param {string} taskId 入队回执的 `task_id`
 * @returns {Promise<{ok:true, bytes:Buffer}|{ok:false, message:string}>}
 */
async function pollTaskUntilImage(fetchImpl, upstream, taskId) {
  const taskUrl = `${text(upstream.base_url).replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}`
  const budgetNote = `輪詢超時（${Math.round(AI_ENHANCE_POLL_BUDGET_MS / 1000)} 秒內未完成）`
  const maxQueriesNote = `輪詢超時（查詢 ${AI_ENHANCE_POLL_MAX_QUERIES} 次仍未完成）`
  const startedAt = Date.now()
  let lastStatus = 0
  let queries = 0
  for (;;) {
    /* 护栏先于查询：次数上限（达到即按超时处理）与总预算（自入队成功时刻算起）双双封顶。 */
    if (queries >= AI_ENHANCE_POLL_MAX_QUERIES) {
      return { ok: false, message: upstreamFailureMessage(lastStatus, maxQueriesNote) }
    }
    if (Date.now() - startedAt >= AI_ENHANCE_POLL_BUDGET_MS) {
      return { ok: false, message: upstreamFailureMessage(lastStatus, budgetNote) }
    }
    queries += 1
    let payload = null
    try {
      const response = await fetchImpl(taskUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${text(upstream.key)}` },
        signal: AbortSignal.timeout(AI_ENHANCE_POLL_QUERY_TIMEOUT_MS)
      })
      lastStatus = Number(response && response.status) || 0
      if (!response || response.ok !== true) {
        /* 单次查询非 2xx ⇒ `UPSTREAM_ERROR`（文案带 HTTP 码与抹除后的上游原话；**不循环**）。 */
        let raw = ''
        try {
          raw = response && typeof response.text === 'function' ? await response.text() : ''
        } catch {
          raw = ''
        }
        return { ok: false, message: upstreamFailureMessage(lastStatus, upstreamDetailOf(raw)) }
      }
      payload = await response.json()
    } catch (error) {
      /* 查询抛错（`AbortSignal.timeout` 超时 / 网络错 / 坏 JSON）⇒ `UPSTREAM_ERROR`（**不得死循环**）。 */
      const name = error && error.name ? String(error.name) : 'error'
      return { ok: false, message: upstreamFailureMessage(lastStatus, name === 'AbortError' ? '超時' : name) }
    }
    const taskStatus = taskStatusOf(payload)
    if (taskStatus === 'completed') {
      const urls = taskResultUrlsOf(payload)
      const firstUrl = urls.length > 0 ? urls[0] : ''
      if (firstUrl === '') {
        return { ok: false, message: upstreamFailureMessage(lastStatus, '任務已完成但缺 result_urls') }
      }
      let download = null
      try {
        download = await fetchImpl(firstUrl, { signal: AbortSignal.timeout(AI_ENHANCE_POLL_QUERY_TIMEOUT_MS) })
      } catch {
        download = null
      }
      if (!download || download.ok !== true) {
        return { ok: false, message: upstreamFailureMessage(lastStatus, '取圖下載失敗') }
      }
      let bytes = null
      try {
        bytes = Buffer.from(await download.arrayBuffer())
      } catch {
        bytes = null
      }
      if (!bytes || bytes.length === 0) {
        return { ok: false, message: upstreamFailureMessage(lastStatus, '取圖下載失敗') }
      }
      return { ok: true, bytes }
    }
    if (taskStatus === 'failed' || taskStatus === 'violation') {
      const errorText = taskErrorOf(payload)
      const detail = errorText ? upstreamDetailOf(errorText) : '上游未給 error_msg'
      return { ok: false, message: upstreamFailureMessage(lastStatus, `任務失敗（狀態＝${taskStatus}：${detail}）`) }
    }
    /* 其他状态（`pending` / `processing` / 空 / 读不懂）⇒ 睡后继续（间隔 5 秒；注入缝可替换）。 */
    await pollSleep(AI_ENHANCE_POLL_INTERVAL_MS)
  }
}

/**
 * 调上游 `POST <base_url>/images/edits` 并取回产物字节。
 * @param {{base_url:string, model:string, key:string, timeout_ms:number}} upstream 解出的上游配置（明文 key 永不进回包）
 * @param {string} imageDataUrl 输入图 `data:` URL
 * @returns {Promise<{ok:true, bytes:Buffer, status:number, elapsedMs:number}
 *          |{ok:false, reason:string, message:string, status:number}>}
 */
async function callUpstreamAndFetchImage(upstream, imageDataUrl) {
  const startedAt = Date.now()
  const url = `${text(upstream.base_url).replace(/\/+$/, '')}/images/edits`
  const body = JSON.stringify({
    model: text(upstream.model),
    prompt: AI_ENHANCE_PROMPT,
    size: AI_ENHANCE_SIZE,
    resolution: AI_ENHANCE_RESOLUTION,
    image: imageDataUrl
  })
  const timeoutMs = Number(upstream.timeout_ms) > 0 ? Number(upstream.timeout_ms) : 60000
  let status = 0
  try {
    const fetchImpl = resolveFetch()
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${text(upstream.key)}` },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
    status = Number(response && response.status) || 0
    if (!response || response.ok !== true) {
      /* 非 2xx：先读响应体（**读失败当空串**），把抹除后的可读摘要作为第二参传给
         `upstreamFailureMessage`（签名不变）⇒ 文案带上游原话（`upstreamDetailOf`）。 */
      let raw = ''
      try {
        raw = response && typeof response.text === 'function' ? await response.text() : ''
      } catch {
        raw = ''
      }
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, upstreamDetailOf(raw)), status }
    }
    const payload = await response.json()
    /* 2xx 但两条取图路都不成立（见下分支注）⇒ detail 带**回包形状轮廓**（`upstreamShapeOf`：
       只带键名、零值泄露）—— 形状读不懂时管理员此前只见「回包缺圖片數據」无从定位。 */
    const shapeNote = `回包缺圖片數據（形狀＝${upstreamShapeOf(payload)}）`
    /* 2xx 取图分支（分支判定只看 `data[0]`）：有 `b64_json` / 有 `url` ⇒ **同步取图路（一字不改）**；
       有 `task_id`（异步入队回执，生产实测 200 + `{created,data:[{task_id,status,display_status}],usage}`）
       ⇒ **轮询取图路**（`GET <base_url>/tasks/<task_id>`；`upstream_status` 仍为首次 POST 的状态码）；
       两条都没有（`data` 非数组 / 第一项非对象 / 无任一字段）⇒ detail 带**回包形状轮廓**
       （`upstreamShapeOf`：只带键名、零值泄露）。 */
    const first = payload && Array.isArray(payload.data) && payload.data.length > 0 ? payload.data[0] : null
    if (!first || typeof first !== 'object') {
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, shapeNote), status }
    }
    let bytes = null
    if (typeof first.b64_json === 'string' && first.b64_json !== '') {
      bytes = Buffer.from(first.b64_json, 'base64')
    } else if (typeof first.url === 'string' && first.url !== '') {
      const download = await fetchImpl(first.url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!download || download.ok !== true) {
        return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '取圖下載失敗'), status }
      }
      bytes = Buffer.from(await download.arrayBuffer())
    } else if (text(first.task_id) !== '') {
      const polled = await pollTaskUntilImage(fetchImpl, upstream, text(first.task_id))
      if (!polled.ok) {
        return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: polled.message, status }
      }
      bytes = polled.bytes
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, shapeNote), status }
    }
    return { ok: true, bytes, status, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    /* 超时（`AbortError`）/ 网络错 / JSON 坏 / 取图失败 —— 一律 `UPSTREAM_ERROR`（网络错与超时 `status = 0`）。 */
    const name = error && error.name ? String(error.name) : 'error'
    return {
      ok: false,
      reason: REASONS.UPSTREAM_ERROR,
      message: upstreamFailureMessage(0, name === 'AbortError' ? '超時' : name),
      status: 0,
      elapsedMs: Date.now() - startedAt
    }
  }
}

/* --------------------------------------------------------------------------- *
  主流程
 * --------------------------------------------------------------------------- */

/** 已存行 ⇒ 回放成功回包（`idempotent: true`；零扣费、零上游、零建行）。 */
function replayReply(row, sourceImageId) {
  return {
    ok: true,
    image_id: text(row.id),
    source_image_id: sourceImageId,
    preview: { mime: text(row.mime), sha256: text(row.sha256) },
    charge: { amount: AI_ENHANCE_COST, balance: Number(row.charge_balance_after) || 0 },
    upstream_status: Number(row.upstream_status) || 0,
    elapsed_ms: Number.isInteger(row.elapsed_ms) ? row.elapsed_ms : 0,
    idempotent: true
  }
}

/**
 * **一次印面人工智能修復**（管理员面；会計費：单张 10 金；服务端裁决）。
 * 顺序（**判定全部在扣费 / 调上游之前**）：① 载荷封闭三键 → ② 管理员门 → ③ 幂等回放预查
 * → ④ 读影像行 / 拼对象键 / 下载字节（拒绝面：零扣费）→ ⑤ 上游配置（缺 ⇒ 零扣费）
 * → ⑥ 预扣 10 金 → ⑦ 调上游 + 取图 → ⑧ 内容寻址存储 → ⑨ 新影像行入册 → ⑩ 成功回包恰 8 键。
 * 任何失败路径：**先退款（已预扣才退）**，回失败回包恰 4 键（`refunded` 恒布尔）。
 * @param {object} payload 载荷（封闭三键 `image_id` / `seal_id` / `face_id`）
 * @param {{uid:string, phone:string, role?:string}} identity 服务端派生身份
 * @param {{adminPhone?:string, nowSeconds?:number, requestId?:string}} [context]
 * @returns {Promise<object>} 成功恰 8 键 / 失败恰 4 键
 */
async function enhanceFace(payload, identity, context) {
  const uid = text(identity && identity.uid)

  /* ① 载荷封闭三键（形态 → 封闭键面 → 缺键 → 值域；全部早于管理员门与任何读写）。 */
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(REASONS.MISSING_REQUIRED, '缺少必要的載荷（payload）；本次零扣費、零寫入、未調上游。', false)
  }
  const unknown = Object.keys(payload).filter((key) => AI_ENHANCE_ALLOWED_KEYS.indexOf(key) === -1)
  if (unknown.length > 0) {
    return failure(
      REASONS.INVALID_FIELD,
      `載荷含未知欄位：${unknown.join('、')}（AI 修復入參封閉三鍵：image_id / seal_id / face_id；金額、prompt、size、resolution 一律由服務端給定）；本次零扣費、零寫入、未調上游。`,
      false
    )
  }
  const imageId = text(payload.image_id)
  const sealId = text(payload.seal_id)
  const faceId = text(payload.face_id)
  if (!imageId || !sealId || !faceId) {
    return failure(
      REASONS.MISSING_REQUIRED,
      '人工智能修復需要原圖影像編號（image_id）／印章編號（seal_id）／印面編號（face_id）三鍵齊備；本次零扣費、零寫入、未調上游。',
      false
    )
  }
  if (typeof payload.image_id !== 'string' || typeof payload.seal_id !== 'string' || typeof payload.face_id !== 'string') {
    return failure(REASONS.INVALID_VALUE, '三鍵必須都是字符串；本次零扣費、零寫入、未調上游。', false)
  }

  /* ② 管理员门（复用既有单点；非管理员 / 缺 env ⇒ 结构化拒绝 ＋ 零扣费）。 */
  const ops = opsModule()
  const identityDenial = ops.adminWhitelistDenial(identity, context && context.adminPhone)
  if (identityDenial) return failure(identityDenial.reason, identityDenial.message, false)

  /* ③ 幂等回放预查（同请求号已有成功行 ⇒ 直接回首次结果：零扣费、零上游、零建行）。 */
  const requestId = requestIdOf(context)
  const idemKey = idemKeyOf(imageId, requestId)
  const newImageId = imageIdOfIdemKey(idemKey)
  const existing = await readEnhanceRow(newImageId)
  if (existing) return replayReply(existing, imageId)

  /* ④ 读影像行 → 拼对象键 → 下载字节（拒绝面：全部零扣费、未调上游）。 */
  const sourceRows = await ops.readRows(ops.COLLECTIONS.images, { id: imageId }, { limit: 1 })
  if (sourceRows.length === 0) {
    return failure(REASONS.INVALID_VALUE, `原圖影像編號（image_id）在影像行中不存在；本次零扣費、零寫入、未調上游。`, false)
  }
  const sourceRow = sourceRows[0]
  const digest = text(sourceRow.sha256).toLowerCase()
  if (!DIGEST_PATTERN.test(digest)) {
    return failure(REASONS.INVALID_VALUE, '原圖影像行缺少合法摘要（sha256）⇒ 無從定位圖源；本次零扣費、零寫入、未調上游。', false)
  }
  let sourceBytes = null
  for (const ext of SOURCE_KEY_EXTS) {
    const candidate = `xiai/images/${digest.slice(0, 2)}/${digest}${ext}`
    if (!SOURCE_KEY_PATTERN.test(candidate)) continue
    try {
      const bytes = await readSourceBytes(candidate)
      sourceBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      break
    } catch {
      /* 该扩展名候选对象不存在 ⇒ 试下一个候选（`.tiff` 源件一律不在候选面内）。 */
    }
  }
  if (!sourceBytes) {
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      '雲端展示件對象存儲不可用或圖源對象不存在（未讀到 png / webp / jpeg 展示件）；本次零扣費、零寫入、未調上游。',
      false
    )
  }
  const sourceMime = sniffImageMime(sourceBytes)
  if (!sourceMime) {
    return failure(REASONS.INVALID_VALUE, '圖源字節不是本面認可的影像容器（png / jpeg / webp）；本次零扣費、零寫入、未調上游。', false)
  }
  if (sourceBytes.length > SOURCE_MAX_BYTES) {
    return failure(
      REASONS.INVALID_VALUE,
      `圖源字節超出上限（${Math.round(SOURCE_MAX_BYTES / 1024 / 1024)} MiB）；本次零扣費、零寫入、未調上游。`,
      false
    )
  }

  /* ⑤ 上游配置（缺 ⇒ `CONFIG_MISSING` ＋ 零扣费 —— 未预扣即拒、不落 `CHARGE` 行）。 */
  const aiUpstream = require('./aiUpstream.js')
  const upstream = await aiUpstream.resolveUpstreamSecret()
  if (!upstream || upstream.ok === false) {
    return failure(
      (upstream && upstream.reason) || REASONS.CONFIG_MISSING,
      `${(upstream && upstream.message) || 'AI 上游未配置'}；本次零扣費、零寫入、未調上游。`,
      false
    )
  }

  /* ⑥ 预扣 10 金（`idem_key` 三段封闭；余额不足 ⇒ `INSUFFICIENT_POINTS` ＋ 零扣费）。 */
  const charged = await chargeTen(uid, idemKey, newImageId)
  if (!charged.ok) return failure(charged.reason, `${charged.message}（本次零扣費、未調上游）`, false)

  /* 并发回放护栏：同请求号的另一路已持 charge（`idempotent`）⇒ 等它的行入册后回放（恰一路真跑）。 */
  if (charged.idempotent) {
    for (let attempt = 0; attempt < REPLAY_POLL_ATTEMPTS; attempt += 1) {
      const row = await readEnhanceRow(newImageId)
      if (row) return replayReply(row, imageId)
      await sleep(REPLAY_POLL_DELAY_MS)
    }
    /* 行迟迟未入册（首路中断的自愈窗口）⇒ 本路接管：重新调上游并按确定性 `_id` 幂等入册。 */
  }

  /* ⑦ 调上游 + 取图（非 2xx / 超时 / 网络错 / 取图失败 / 图形魔数不认 ⇒ `UPSTREAM_ERROR` ＋ 全退）。 */
  const imageDataUrl = dataUrlOf(sourceMime, sourceBytes)
  const upstreamCall = await callUpstreamAndFetchImage(upstream, imageDataUrl)
  if (!upstreamCall.ok) {
    const refunded = await refundTen(uid, idemKey, newImageId)
    return failure(upstreamCall.reason, upstreamCall.message, refunded)
  }
  const productMime = sniffImageMime(upstreamCall.bytes)
  const productExt = PRODUCT_MIME_EXT[productMime]
  if (!productExt) {
    const refunded = await refundTen(uid, idemKey, newImageId)
    return failure(
      REASONS.UPSTREAM_ERROR,
      `上游回圖字節不是本面入册的產物族（png / webp）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；本次未建影像行、未改印面指向。`,
      refunded
    )
  }

  /* ⑧ 内容寻址存储（新 sha；失败 ⇒ 全退 ＋ `STORAGE_UNAVAILABLE`，不留半成品）。 */
  const productSha = sha256Hex(upstreamCall.bytes)
  const productKey = `xiai/images/${productSha.slice(0, 2)}/${productSha}.${productExt}`
  try {
    await uploadProductBytes(productKey, upstreamCall.bytes)
  } catch {
    const refunded = await refundTen(uid, idemKey, newImageId)
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      `修復產物上傳失敗（雲端存儲不可用）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；本次未建影像行、未改印面指向。`,
      refunded
    )
  }

  /* ⑨ 新影像行入册（确定性 `_id` ＝ 幂等 upsert；**不挂印面** —— 不写任何 `face_image_id`）。 */
  const now = text(new Date().toISOString())
  const doc = {
    id: newImageId,
    stamp_id: sealId,
    sealId,
    kind: 'FACE',
    storage: 'server',
    storage_key: productKey,
    sha256: productSha,
    bytes: upstreamCall.bytes.length,
    bytesLength: upstreamCall.bytes.length,
    mime: productMime,
    width: null,
    height: null,
    source: 'ai_enhance',
    displayOnly: true,
    /* 回放重建回包用的服务端记载（不下发、不参与读面判定）。 */
    source_image_id: imageId,
    charge_balance_after: charged.balance,
    upstream_status: upstreamCall.status,
    elapsed_ms: Number.isInteger(upstreamCall.elapsedMs) ? upstreamCall.elapsedMs : 0,
    created_at: now
  }
  try {
    await persistEnhanceRow(newImageId, doc)
  } catch {
    const refunded = await refundTen(uid, idemKey, newImageId)
    return failure(
      REASONS.STORAGE_UNAVAILABLE,
      `修復產物影像行入册失敗（權威存儲不可用）⇒ 已全額退回 ${AI_ENHANCE_COST} 金；不留半成品行、未改印面指向。`,
      refunded
    )
  }

  /* ⑩ 成功回包（**恰 8 键**；`preview` / `charge` 嵌套、顶层键面即 8 个）。 */
  return {
    ok: true,
    image_id: newImageId,
    source_image_id: imageId,
    preview: { mime: productMime, sha256: productSha },
    charge: { amount: AI_ENHANCE_COST, balance: charged.balance },
    upstream_status: upstreamCall.status,
    elapsed_ms: Number.isInteger(upstreamCall.elapsedMs) ? upstreamCall.elapsedMs : 0,
    idempotent: charged.idempotent
  }
}

module.exports = {
  AI_ENHANCE_OP,
  AI_ENHANCE_COST,
  AI_ENHANCE_SIZE,
  AI_ENHANCE_RESOLUTION,
  AI_ENHANCE_ALLOWED_KEYS,
  IDEM_KEY_PREFIX,
  REF_TYPE_AI_IMAGE,
  SOURCE_MAX_BYTES,
  SOURCE_KEY_EXTS,
  SOURCE_KEY_PATTERN,
  PRODUCT_MIME_EXT,
  AI_ENHANCE_POLL_INTERVAL_MS,
  AI_ENHANCE_POLL_BUDGET_MS,
  AI_ENHANCE_POLL_QUERY_TIMEOUT_MS,
  AI_ENHANCE_POLL_MAX_QUERIES,
  AI_ENHANCE_SUCCESS_KEYS,
  AI_ENHANCE_FAILURE_KEYS,
  setAiEnhanceFetchProvider,
  aiEnhanceFetchInjected,
  setAiEnhanceSleepProvider,
  aiEnhanceSleepInjected,
  idemKeyOf,
  imageIdOfIdemKey,
  sniffImageMime,
  enhanceFace
}
