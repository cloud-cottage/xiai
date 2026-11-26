/**
 * 玺爱 · **展示面转码桥**（案 C：由后端承担「TIFF → 浏览器可直接解码格式」的转码）
 * ----------------------------------------------------------------------------
 * 只做一件事，且**只做这一件事**：
 *   - **存储件是 TIFF**（新增产物一律单页 8bit Deflate TIFF）⇒ 交 `xiai-api` 的
 *     `POST /api/image/decode` 转出**展示件**（有损 WebP、质量 0.92，取值定义点仍在服务端）；
 *   - **其余容器**（PNG / JPEG / GIF / WebP / 存量 AVIF）⇒ **原字节**交给浏览器
 *     **原生解码**（`<img>` / `createImageBitmap`）。
 *     ★ **存量旧 8 色索引 PNG 绝不走 api**：`/api/image/decode` 对 PNG 入参结构化 415
 *     （`NOT_IMAGE`）⇒ 旧行必须仍由原生解码显示，否则存量集体报错。
 *
 * 范围声明（**不得外推**）：本模块**不是** P5 的「权威存储 api 客户端」——
 * 不存原图、不取原图库、不改 yinsuo 代理指向，只读地换一份**展示件**；
 * 端点族、字段名、质量取值全部沿用服务端既有口径（此处不新立数值）。
 * 端基址单点登记（**候选列表**，定义点＝ `displayApiCandidates()`，域名字面值只在本文件一处）：
 *   · `VITE_XIAI_API_BASE` 非空 ⇒ 候选就是它（**一档**，不额外垫）；
 *   · 生产 ⇒ `[云托管容器直连域名, 同源 '/api/xiai']`（**先直连、后同源**）；
 *   · dev ⇒ `['/api/xiai']`（由 `vite.config.js` 的代理剥前缀后转到 xiai-api，面板重启后生效）。
 * 两条路**实测各有缺陷**（某些网络把容器域名解析成代理假 IP 连不上；同源反代实测 8 次里
 * 2 次 502）⇒ 图像请求单点 `displayFetch()` **按候选顺序回退**：每档 4s 短超时、
 * 首个成功即刻返回、全失败如实交回**最后一档**的 `{reason, message}`、
 * 模块级记住上次成功的候选索引（**只记索引，绝不缓存回包**）。
 */

import { sniffBytesMime } from '../utils/image.js'
import { bytesToDataUrl } from '../data/assetmeta.js'

/** 每档**短超时**（毫秒）：某一档连不上 / 挂起时不得卡住渲染 ⇒ 超时即按该档失败继续下一档。 */
export const DISPLAY_FETCH_TIMEOUT_MS = 4000

/** 存储容器的 mime 字面值（本模块只对**它**触发转码；其余容器一律原生解码）。 */
export const TIFF_STORAGE_MIME = 'image/tiff'

/* **端基址（唯一一处定义点）** —— 云托管容器直连域名的字面值**只出现在下面这一行**。 */
const PROD_CONTAINER_BASE = 'https://xiai-api-344046-5-1463728495.sh.run.tcloudbase.com/api'

/**
 * **端基址候选**（唯一一处定义点）：按优先级给一串可回退的基址。
 *   ① `VITE_XIAI_API_BASE` 非空 ⇒ 候选就是它（**一档**，不额外垫）；
 *   ② 生产 ⇒ `[容器直连, '/api/xiai']`（**先直连、后同源**：直连在某些网络被解析成代理假 IP、
 *      同源反代实测 8 次 2 次 502 ⇒ 两条各自都不够，必须能互为回退）；
 *   ③ dev ⇒ `['/api/xiai']`（vite proxy 到 5191，行为一字未改）。
 * 取法纪律（见 `.env.development.local`）：Vite 只静态替换 `import.meta.env.<KEY>` 的**字面**
 * 访问（`const env = import.meta.env` 不被替换）⇒ 这里两处 KEY 都写字面。
 * @returns {string[]} 非空候选数组（尾斜杠已剥）
 */
export function displayApiCandidates() {
  const fromEnv =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_XIAI_API_BASE
      ? String(import.meta.env.VITE_XIAI_API_BASE)
      : ''
  const isProd =
    typeof import.meta !== 'undefined' && import.meta.env ? Boolean(import.meta.env.PROD) : false
  const trimmed = fromEnv.trim()
  const list = trimmed ? [trimmed] : isProd ? [PROD_CONTAINER_BASE, '/api/xiai'] : ['/api/xiai']
  return list.map((base) => base.replace(/\/+$/, ''))
}

/** 端基址（**旧调用点 / 外部读取面**）：回候选**首个**（定义点仍是 `displayApiCandidates`）。 */
export function displayApiBase() {
  return displayApiCandidates()[0]
}

/** 上一次成功的候选索引（**只记索引**：绝不缓存响应体 / 回包，避免同一批字节存多份）。 */
let lastGoodCandidateIndex = -1

/**
 * 候选尝试顺序：**从上次成功档起、环绕其余档** ⇒ 同一次调用内每个候选**恰试一次**
 * （轮次不变式：不重复、不遗漏）。首次（无记忆）从 0 起。
 */
function candidateOrder(candidates) {
  const total = candidates.length
  const start = lastGoodCandidateIndex >= 0 && lastGoodCandidateIndex < total ? lastGoodCandidateIndex : 0
  const order = []
  for (let step = 0; step < total; step += 1) order.push((start + step) % total)
  return order
}

/** 单档尝试：4s 短超时；成功（2xx）⇒ `{ok:true, reply}`；失败 ⇒ 该档的结构化失败。 */
async function attemptDisplayFetch(url, init, hooks, index, base) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), DISPLAY_FETCH_TIMEOUT_MS) : null
  let reply = null
  try {
    reply = await fetch(url, controller ? { ...init, signal: controller.signal } : { ...init })
  } catch {
    /* 网络错 **或** 超时（`AbortError`）⇒ 该档失败，交下一档。 */
    return { ok: false, ...hooks.networkFailure, index, base }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  if (reply && reply.ok) return { ok: true, reply, index, base }
  /* 非 2xx ⇒ 该档的结构化失败（文案 / reason 由调用方既有口径给，**不混合各档**）。 */
  const face = await hooks.failureOfReply(reply)
  return { ok: false, reason: face.reason, message: face.message, index, base }
}

/**
 * **图像请求单点 · 候选基址回退**：按候选顺序逐档尝试（每档 `DISPLAY_FETCH_TIMEOUT_MS` 短超时），
 * **首个成功即刻返回**；全部失败 ⇒ 用**最后一档**的 `{reason, message}` **原样**交回
 * （不拼接、不改写、不混合文案）。成功 ⇒ 记下该档索引（下次优先；单次失败也回退）。
 *
 * @param {string} path 以 `/` 开头的端点路径（可带 query）
 * @param {object} init 该次请求的 `fetch` init（每档复制一份挂自己的 signal；body 不复制多份）
 * @param {{networkFailure:{reason:string,message:string},
 *          failureOfReply:(reply:any)=>Promise<{reason:string,message:string}>}} hooks
 *        `networkFailure` ＝ 网络错 / 超时这一档的结构化失败；
 *        `failureOfReply` ＝ 非 2xx 这一档的结构化失败（保持各调用点既有文案口径）
 * @returns {Promise<{ok:true, reply:any, index:number, base:string}
 *          |{ok:false, reason:string, message:string, index:number, base:string}>}
 */
export async function displayFetch(path, init, hooks) {
  const candidates = displayApiCandidates()
  const order = candidateOrder(candidates)
  let last = null
  for (const index of order) {
    const base = candidates[index]
    const attempt = await attemptDisplayFetch(`${base}${path}`, init, hooks, index, base)
    if (attempt.ok) {
      lastGoodCandidateIndex = index
      return attempt
    }
    last = attempt
  }
  /* 全失败 ⇒ **最后一档**的失败原样交回（候选恒非空 ⇒ `last` 必在）。 */
  return last
}

/** 展示件的可读失败文案（繁体；不含内部标识、不含「切分」类措辞 —— R-123 同族纪律）。 */
const TRANSCODE_FAIL_MESSAGE = '影像暫時無法顯示，請稍後再試'
const TRANSCODE_DOWN_MESSAGE = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'

/**
 * **真字节类**判定（`Uint8Array` / `ArrayBuffer` / `ArrayBufferView`）⇒ 字节视图；**其余一律 `null`**。
 * 反例锚点（本单删除的**静默放大**机制）：`bytes` 误传 `number`（如 `5`）时，旧写法
 * `new Uint8Array(bytes || [])` 会**静默**产出一个 5 字节的**全零**缓冲 ⇒「形状不对」被当成
 * 「一段有效载荷」继续往下走（缺陷被掩盖，正是上个 P0 的放大机制）。⇒ 现改为**明确失败**。
 */
function bytesViewOf(payload) {
  if (payload instanceof Uint8Array) return payload
  if (typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  return null
}

/**
 * TIFF（或任何存储件字节）⇒ 展示件 bytes（WebP 0.92）。
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes 存储件字节（**只收真字节类**；
 *        其它形状（如 `number`）⇒ 结构化失败 `reason === 'NOT_IMAGE'`，绝不静默产全零缓冲）
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, quality?:number, reason?:string, message:string}>}
 */
export async function transcodeStoredToDisplay(bytes) {
  const body = bytesViewOf(bytes)
  /* 非**真字节类** ⇒ **明确失败**（结构化拒绝；不静默放大、不产全零缓冲）。
     reason 取 §3.12.10(c) 冻结表「服务层（对外面）」值 `NOT_IMAGE`：本模块在 `src/services/**`，
     属对外面；`EMPTY_CONTENT` 判的是「载荷为空」，与「形状认不出」不是一回事 ⇒ 不得混用
     （§3.12.10 表下注（v1.6 追加）③ 明文）。 */
  if (body === null) return { ok: false, reason: 'NOT_IMAGE', message: TRANSCODE_FAIL_MESSAGE }
  if (body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: TRANSCODE_FAIL_MESSAGE }
  /* **候选基址回退单点**：按候选顺序尝试，首个 2xx 即返回；全失败 ⇒ 最后一档的失败原样交回。 */
  const attempt = await displayFetch(
    '/image/decode',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    },
    {
      networkFailure: { reason: 'STORAGE_UNAVAILABLE', message: TRANSCODE_DOWN_MESSAGE },
      failureOfReply: async (reply) => {
        let reason = ''
        try {
          const payload = await reply.json()
          reason = String((payload && payload.reason) || '')
        } catch {
          reason = ''
        }
        return { reason: reason || 'NOT_IMAGE', message: TRANSCODE_FAIL_MESSAGE }
      }
    }
  )
  if (!attempt.ok) return { ok: false, reason: attempt.reason, message: attempt.message }
  const reply = attempt.reply
  const out = new Uint8Array(await reply.arrayBuffer())
  const mime = sniffBytesMime(out) || ''
  if (!mime) return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: TRANSCODE_FAIL_MESSAGE }
  const quality = Number(reply.headers.get('X-Xiai-Quality'))
  return { ok: true, bytes: out, mime, quality: Number.isFinite(quality) ? quality : 0, message: '' }
}

/**
 * 展示用 dataURL（**原生优先、TIFF 才转码**）。
 * @param {{dataUrl?:string, mime?:string, bytes?:Uint8Array|ArrayBuffer|ArrayBufferView}} input
 *        `mime` 为**按字节判定**的存储件 mime；`bytes` 可省（有 `dataUrl` 即可）
 * @returns {Promise<{ok:boolean, dataUrl?:string, mime?:string, transcoded:boolean,
 *          reason?:string, message:string}>}
 */
export async function displayDataUrlOf(input = {}) {
  const storedMime = String(input.mime || '').trim().toLowerCase()
  const storedDataUrl = String(input.dataUrl || '')
  if (storedMime !== TIFF_STORAGE_MIME) {
    /* 原生解码面（含存量旧 8 色索引 PNG）—— **绝不经 api**。 */
    return { ok: true, dataUrl: storedDataUrl, mime: storedMime, transcoded: false, message: '' }
  }
  const transcoded = await transcodeStoredToDisplay(input.bytes)
  if (!transcoded.ok) {
    return { ok: false, dataUrl: '', mime: '', transcoded: true, reason: transcoded.reason, message: transcoded.message }
  }
  return {
    ok: true,
    dataUrl: bytesToDataUrl(transcoded.bytes, transcoded.mime),
    mime: transcoded.mime,
    transcoded: true,
    message: ''
  }
}
