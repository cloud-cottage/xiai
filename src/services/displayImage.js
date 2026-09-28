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
 * 端基址单点登记：默认**同源** `/api`（dev 由 `vite.config.js` 的代理转到 xiai-api；
 * 面板重启后生效），可用 `VITE_XIAI_API_BASE` 覆盖。
 */

import { sniffBytesMime } from '../utils/image.js'
import { bytesToDataUrl } from '../data/assetmeta.js'

/** 存储容器的 mime 字面值（本模块只对**它**触发转码；其余容器一律原生解码）。 */
export const TIFF_STORAGE_MIME = 'image/tiff'

/** 端基址（**唯一一处定义点**）：同源 `/api` 优先，`VITE_XIAI_API_BASE` 可覆盖。 */
export function displayApiBase() {
  const fromEnv =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_XIAI_API_BASE : ''
  const base = String(fromEnv || '').trim() || '/api'
  return base.replace(/\/+$/, '')
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
  const base = displayApiBase()
  let reply = null
  try {
    reply = await fetch(`${base}/image/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: TRANSCODE_DOWN_MESSAGE }
  }
  if (!reply || !reply.ok) {
    let reason = ''
    try {
      const payload = await reply.json()
      reason = String((payload && payload.reason) || '')
    } catch {
      reason = ''
    }
    return { ok: false, reason: reason || 'NOT_IMAGE', message: TRANSCODE_FAIL_MESSAGE }
  }
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
