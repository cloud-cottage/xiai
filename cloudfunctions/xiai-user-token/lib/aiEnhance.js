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
 *     产物族只有这两族，读面单点 `IMAGE_OBJECT_KEY_PATTERN` 只认 `.png|.webp`）。
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

/** 产物族（**只收 png / webp** —— 读面单点 `IMAGE_OBJECT_KEY_PATTERN` 只认这两族）。 */
const PRODUCT_MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp' })

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
    const first = payload && Array.isArray(payload.data) && payload.data.length > 0 ? payload.data[0] : null
    if (!first || typeof first !== 'object') {
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '回包缺圖片數據'), status }
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
    }
    if (!bytes || bytes.length === 0) {
      return { ok: false, reason: REASONS.UPSTREAM_ERROR, message: upstreamFailureMessage(status, '回包缺圖片數據'), status }
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
  AI_ENHANCE_SUCCESS_KEYS,
  AI_ENHANCE_FAILURE_KEYS,
  setAiEnhanceFetchProvider,
  aiEnhanceFetchInjected,
  idemKeyOf,
  imageIdOfIdemKey,
  sniffImageMime,
  enhanceFace
}
