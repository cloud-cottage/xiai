/**
 * 玺爱 · **xiai-api 读取面客户端（直出三面 ＋ 块面）**
 * ----------------------------------------------------------------------------
 * 本模块只做一件事：把**已落库的存储件字节**送到 xiai-api 的读取面端点，
 * 并把响应**如实**交回调用方。三面各一行，不交叉、不冒充（规范 §3.24.3 ③）：
 *
 *   - `POST /api/image/download` ⇒ **原字節面**（「下載高清原圖」）：**原始存儲件字節直出**、
 *     `image/tiff`、**不加水印**、**不经 TileSplicer**、**零转码** ⇒ **byte-verbatim**
 *     （下載件 `sha256` ≡ 存儲件 `sha256`）。**存量只讀行（AVIF）同樣原字節直出**。
 *   - `POST /api/image/thumb`    ⇒ **縮略面**：**256 長邊單件 WebP**、**不經 TileSplicer**。
 *   - `POST /api/image/slices`   ⇒ **塊面**：face 4 塊（2×2）/ scene 8 塊（4×2），每塊無損 WebP；
 *     響應 ＝ 清單（JSON）＋ 逐塊字節（**不含未切分整圖**）。
 *
 * **幾何口徑（硬約束）**：本模塊**只消費響應**——塊數 / 逐塊 `rect` 與落位 `placements`
 * 一律來自響應清單；**本文件不寫任何塊數常量、不派生任何切位 / 幾何**
 * （幾何真源仍恰 1 處 ＝ `src/tilesplicer/**`）。
 *
 * **容器門（與服務端一致，本文件不新立數值）**：
 *   - 塊面 / 縮略面：服務端來源門＝**只認 TIFF**（`decode_source_to_bitmap`）；
 *   - 原字節面：**TIFF ＋ 存量只讀 AVIF**（`source_mime`）。
 *   其餘容器（**存量舊 8 色索引 PNG 等**）**一律不走 api** —— 調用方按 `passThroughMimeOf`
 *   自行走**瀏覽器原生解碼 / 本機字節**路徑（存量面不得回歸）。
 *
 * 端基址**唯一一處定義點**仍為 `displayImage.js::displayApiBase`（本文件只引用，不另立）。
 * 失敗一律**結構化**（`{ok:false, reason, message}`；`reason` 取值屬 §3.12.10(c) 凍結表），
 * **零偽數據、零回落**（不得以空文件 / 假容器冒充成功）。
 */

import { displayApiBase } from './displayImage.js'
import { loadStoredImage, primaryFaceOf, imageSourceOf } from './seals.js'
import { normalizeDigest, reasonOfReply } from './imageAuthority.js'
import { sniffBytesMime } from '../utils/image.js'
import { sha256Hex } from '../data/assetmeta.js'

/** 塊面 / 縮略面的來源門（服務端口徑：只認 TIFF）。 */
export const KERNEL_FACE_MIME = 'image/tiff'
/** 原字節面的來源門（服務端口徑：TIFF ＋ 存量只讀 AVIF）。 */
export const ORIGINAL_FACE_MIMES = ['image/tiff', 'image/avif']

/** 縮略面長邊（規範 §3.27.6「256 長邊單件 WebP」；本文件只引用，不另立取值）。 */
export const THUMB_LONG_EDGE = 256

const NOT_IMAGE_MESSAGE = '影像暫時無法顯示，請稍後再試'
const SERVICE_DOWN_MESSAGE = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'

/** 真字節類 ⇒ 字節視圖；其餘一律 `null`（形狀認不出 ⇒ 明確失敗，不靜默放大）。 */
function bytesViewOf(payload) {
  if (payload instanceof Uint8Array) return payload
  if (typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  return null
}

/** 按字節如實判定容器（**不採信自稱值** —— §3.12.10(b) / AC-141 同族）。 */
function mimeOfBytes(bytes) {
  return sniffBytesMime(bytes) || ''
}

/**
 * 存儲件容器（對外可用的同一把尺子）：**按字節**判定；認不出時才退用行上自報值。
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes 存儲件字節
 * @param {string} fallback 行上自報的 mime（僅在字節認不出時使用）
 */
export function storedMimeOf(bytes, fallback) {
  const byted = mimeOfBytes(bytes)
  return byted || String(fallback || '').trim().toLowerCase()
}

/** 面别由**行上的資產類別**決定（`kind` 為內核/客戶面字面值：`face` / `scene`）。 */
export function clientKindOf(row, cutHint) {
  const hint = String(cutHint || '').trim().toLowerCase()
  if (hint === 'photo' || hint === 'scene') return 'scene'
  const kind = String((row && row.kind) || '').trim().toUpperCase()
  if (kind === 'PHOTO') return 'scene'
  if (kind === 'FACE' || kind === 'EDGE') return 'face'
  return ''
}

/** 該 mime 是否可走 api 的塊面 / 縮略面（只認 TIFF；其餘走本機原生路徑）。 */
export function kernelFaceEligible(mime) {
  return String(mime || '').trim().toLowerCase() === KERNEL_FACE_MIME
}

/** 該 mime 是否可走 api 的原字節面（TIFF ＋ 存量只讀 AVIF）。 */
export function passThroughMimeOf(mime) {
  return ORIGINAL_FACE_MIMES.includes(String(mime || '').trim().toLowerCase())
}

const EXT_OF_MIME = { 'image/tiff': '.tif', 'image/avif': '.avif', 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' }

/**
 * 原字節面的**檔名**：優先取響應頭 `Content-Disposition` 裡的名字（服務端已凍結命名口徑），
 * 缺位 / 不可解析時退化為 `xiai-original-<sha256 前 12>.tif`（後綴按**字節**如實取）。
 */
export function filenameFromDisposition(header, mime, sha256) {
  const text = String(header || '')
  const match = /filename\s*=\s*"?([^";]+)"?/i.exec(text)
  const name = match ? match[1].trim() : ''
  if (name) return name
  const suffix = EXT_OF_MIME[String(mime || '').toLowerCase()] || '.bin'
  return `xiai-original-${String(sha256 || '').slice(0, 12)}${suffix}`
}

/**
 * **原字節面**：原始存儲件字節直出（byte-verbatim、零轉碼、**不加水印**）。
 *
 * **K-P5b**：新增**按 digest 引用**形態（`?sha256=<hex>`，經同源代理）—— 行內有 digest 的行
 * **不需要本機字節**；不帶 `sha256` 時仍走**既有直傳字節形態**（一字未破）。
 * @param {{bytes?:Uint8Array|ArrayBuffer|ArrayBufferView, sha256?:string, kind?:string}} input
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, filename?:string, bytesLength?:number,
 *          sha256?:string, passthrough?:boolean, watermark?:boolean, message:string, reason?:string}>}
 */
export async function fetchOriginalBytes(input = {}) {
  const digest = normalizeDigest(input.sha256)
  const body = digest ? null : bytesViewOf(input.bytes)
  if (!digest && body === null) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  if (!digest && body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: NOT_IMAGE_MESSAGE }
  const params = []
  if (digest) params.push(`sha256=${encodeURIComponent(digest)}`)
  if (input.kind) params.push(`kind=${encodeURIComponent(input.kind)}`)
  const query = params.length ? `?${params.join('&')}` : ''
  let reply = null
  try {
    reply = await fetch(`${displayApiBase()}/image/download${query}`, {
      method: 'POST',
      headers: digest ? undefined : { 'Content-Type': 'application/octet-stream' },
      body: digest ? undefined : body
    })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: SERVICE_DOWN_MESSAGE }
  }
  if (!reply || !reply.ok) return { ok: false, reason: await reasonOfReply(reply), message: NOT_IMAGE_MESSAGE }
  const out = new Uint8Array(await reply.arrayBuffer())
  /** **判據三件**（規範 §3.26.4）：`sha256` ＋ 字節長度 ＋ 魔數（按字節，不採信自稱值）。 */
  const mime = mimeOfBytes(out)
  const declaredPassthrough = String(reply.headers.get('X-Xiai-Passthrough') || '').toLowerCase() === 'true'
  const watermark = String(reply.headers.get('X-Xiai-Watermark') || '').toLowerCase() === 'true'
  return {
    ok: true,
    bytes: out,
    mime,
    bytesLength: out.length,
    sha256: sha256Hex(out),
    filename: filenameFromDisposition(reply.headers.get('Content-Disposition'), mime, sha256Hex(out)),
    passthrough: declaredPassthrough,
    watermark,
    message: ''
  }
}

/**
 * **縮略面**：256 長邊**單件** WebP、**不經 TileSplicer**。
 *
 * **K-P5b**：新增**按 digest 引用**形態（`?sha256=<hex>`）—— 行內有 digest 的行不需要本機字節；
 * 不帶 `sha256` 時仍走**既有直傳字節形態**（一字未破）。
 * @param {{bytes?:Uint8Array|ArrayBuffer|ArrayBufferView, sha256?:string, kind?:string, longEdge?:number}} input
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, longEdge?:number, message:string,
 *          reason?:string}>}
 */
export async function fetchThumbBytes(input = {}) {
  const digest = normalizeDigest(input.sha256)
  const body = digest ? null : bytesViewOf(input.bytes)
  if (!digest && body === null) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  if (!digest && body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: NOT_IMAGE_MESSAGE }
  const longEdge = Number(input.longEdge) > 0 ? Number(input.longEdge) : THUMB_LONG_EDGE
  const params = [`width=${encodeURIComponent(longEdge)}`]
  if (input.kind) params.push(`kind=${encodeURIComponent(input.kind)}`)
  if (digest) params.push(`sha256=${encodeURIComponent(digest)}`)
  let reply = null
  try {
    reply = await fetch(`${displayApiBase()}/image/thumb?${params.join('&')}`, {
      method: 'POST',
      headers: digest ? undefined : { 'Content-Type': 'application/octet-stream' },
      body: digest ? undefined : body
    })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: SERVICE_DOWN_MESSAGE }
  }
  if (!reply || !reply.ok) return { ok: false, reason: await reasonOfReply(reply), message: NOT_IMAGE_MESSAGE }
  const out = new Uint8Array(await reply.arrayBuffer())
  const mime = mimeOfBytes(out)
  const edge = Number(reply.headers.get('X-Xiai-Thumb-Long-Edge'))
  return { ok: true, bytes: out, mime, longEdge: Number.isFinite(edge) ? edge : longEdge, message: '' }
}

/* ============================================================================
   塊面（`POST /api/image/slices`）—— `multipart/mixed` 解析
   ----------------------------------------------------------------------------
   響應形態：首件 ＝ 清單（JSON），其後逐件 ＝ 塊字節（塊內無損 WebP）；
   逐塊的 `rect`（源面矩形）與落位 `placements`（畫布矩形）**一律讀自響應**。
   ============================================================================ */

function bytesIndexOf(hay, needle, from) {
  if (needle.length === 0) return -1
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function parseHeaders(text) {
  const out = {}
  for (const line of String(text).split('\r\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return out
}

/** `multipart/mixed` ⇒ `{manifest, blocks}`（塊按 `X-Block-Index` 排序；幾何只讀響應）。 */
export function parseSlicesMultipart(body, boundary) {
  const buf = bytesViewOf(body)
  if (buf === null) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  const dash = new TextEncoder().encode(`--${boundary}`)
  const crlfcrlf = new TextEncoder().encode('\r\n\r\n')
  const decoder = new TextDecoder()
  const parts = []
  let pos = bytesIndexOf(buf, dash, 0)
  while (pos >= 0) {
    let cursor = pos + dash.length
    if (buf[cursor] === 45 && buf[cursor + 1] === 45) break // `--` ⇒ 收尾
    while (buf[cursor] === 13 || buf[cursor] === 10) cursor += 1
    const headEnd = bytesIndexOf(buf, crlfcrlf, cursor)
    if (headEnd < 0) break
    const headers = parseHeaders(decoder.decode(buf.subarray(cursor, headEnd)))
    const bodyStart = headEnd + crlfcrlf.length
    const nextDash = bytesIndexOf(buf, dash, bodyStart)
    if (nextDash < 0) break
    let bodyEnd = nextDash
    if (bodyEnd >= 2 && buf[bodyEnd - 2] === 13 && buf[bodyEnd - 1] === 10) bodyEnd -= 2
    parts.push({ headers, bytes: buf.subarray(bodyStart, bodyEnd) })
    pos = nextDash
  }
  if (parts.length === 0) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  let manifest = null
  const blocks = []
  parts.forEach((part, order) => {
    const ctype = String(part.headers['content-type'] || '')
    if (part.headers['content-id'] === 'manifest' || ctype.startsWith('application/json')) {
      try {
        manifest = JSON.parse(decoder.decode(part.bytes))
      } catch {
        manifest = null
      }
      return
    }
    const rect = String(part.headers['x-block-rect'] || '').split(',').map(Number)
    const place = String(part.headers['x-block-placement'] || '').split(',').map(Number)
    blocks.push({
      order,
      index: Number(part.headers['x-block-index']),
      row: Number(part.headers['x-block-row']),
      col: Number(part.headers['x-block-col']),
      mime: mimeOfBytes(part.bytes) || ctype,
      lossless: String(part.headers['x-block-lossless'] || '').toLowerCase() === 'true',
      sha256: String(part.headers['x-block-sha256'] || ''),
      rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
      placement: { x: place[0], y: place[1], width: place[2], height: place[3] },
      bytes: part.bytes
    })
  })
  if (!manifest || blocks.length === 0) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  blocks.sort((a, b) => (a.index || 0) - (b.index || 0))
  return { ok: true, manifest, blocks }
}

/**
 * **塊面**：源面字節 ⇒ 逐塊（**響應內不含未切分整圖**）。塊數 / 幾何一律讀自響應。
 *
 * **K-P5b**：新增**按 digest 引用**形態（`?sha256=<hex>`）—— 行內有 digest 的行不需要本機字節；
 * 不帶 `sha256` 時仍走**既有直傳字節形態**（一字未破）。
 * @param {{bytes?:Uint8Array|ArrayBuffer|ArrayBufferView, sha256?:string, assetId:string, kind:string}} input
 * @returns {Promise<{ok:boolean, blocks?:Array, manifest?:object, sourceWidth?:number, sourceHeight?:number,
 *          outWidth?:number, outHeight?:number, blockCount?:number, message:string, reason?:string}>}
 */
export async function fetchSlices(input = {}) {
  const digest = normalizeDigest(input.sha256)
  const body = digest ? null : bytesViewOf(input.bytes)
  if (!digest && body === null) return { ok: false, reason: 'NOT_IMAGE', message: NOT_IMAGE_MESSAGE }
  if (!digest && body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: NOT_IMAGE_MESSAGE }
  const assetId = String(input.assetId || '').trim()
  if (!assetId) return { ok: false, reason: 'MISSING_REQUIRED', message: NOT_IMAGE_MESSAGE }
  const params = [`assetId=${encodeURIComponent(assetId)}`]
  if (input.kind) params.push(`kind=${encodeURIComponent(input.kind)}`)
  if (digest) params.push(`sha256=${encodeURIComponent(digest)}`)
  let reply = null
  try {
    reply = await fetch(`${displayApiBase()}/image/slices?${params.join('&')}`, {
      method: 'POST',
      headers: digest ? undefined : { 'Content-Type': 'application/octet-stream' },
      body: digest ? undefined : body
    })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: SERVICE_DOWN_MESSAGE }
  }
  if (!reply || !reply.ok) return { ok: false, reason: await reasonOfReply(reply), message: NOT_IMAGE_MESSAGE }
  const ctype = String(reply.headers.get('Content-Type') || '')
  const boundary = /boundary=([^;]+)/i.exec(ctype)
  if (!boundary) return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: NOT_IMAGE_MESSAGE }
  const parsed = parseSlicesMultipart(await reply.arrayBuffer(), boundary[1].trim())
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message }
  const width = Number(reply.headers.get('X-Xiai-Out-Width'))
  const height = Number(reply.headers.get('X-Xiai-Out-Height'))
  const headerBlocks = Number(reply.headers.get('X-Xiai-Blocks'))
  /** 落位口徑：塊數與畫布尺寸**一律以響應為準**（缺位時退用清單的同名字段，仍不本機派生）。 */
  const placements = parsed.blocks.map((b) => b.placement)
  const derivedWidth = placements.reduce((max, p) => Math.max(max, (p.x || 0) + (p.width || 0)), 0)
  const derivedHeight = placements.reduce((max, p) => Math.max(max, (p.y || 0) + (p.height || 0)), 0)
  return {
    ok: true,
    manifest: parsed.manifest,
    blocks: parsed.blocks,
    blockCount: Number.isFinite(headerBlocks) && headerBlocks > 0 ? headerBlocks : parsed.blocks.length,
    sourceWidth: Number.isFinite(width) && width > 0 ? width : derivedWidth,
    sourceHeight: Number.isFinite(height) && height > 0 ? height : derivedHeight,
    message: ''
  }
}

/**
 * **一枚印章的「下載高清原圖」全流程**（权限与扣费**不在此处**：由调用方沿用既有
 * `points.chargeSealDownload` 会话计费流程，本函数只管**取字节 ＋ 对账**）。
 *
 * 主印面影像的来源＝**服务层单点** `primaryFaceOf`（R-44 口径；本文件不得另写一份
 * `find(kind === 'FACE')`）。字节来源＝ `loadStoredImage`（**零转码**：不触发展示面端点）。
 *
 * @param {string} stampId 印章编号
 * @returns {Promise<{ok:boolean, filename?:string, bytes?:Uint8Array, mime?:string, bytesLength?:number,
 *          sha256?:string, sha256Stored?:string, verdict?:string, viaApi?:boolean, watermark?:boolean,
 *          passthrough?:boolean, report:object, message:string}>}
 */
export async function downloadOriginalFor(stampId) {
  const face = primaryFaceOf(stampId)
  const imageId = face && face.face_image_id ? String(face.face_image_id) : ''
  if (!imageId) {
    return { ok: false, report: { reason: 'MISSING_REQUIRED' }, message: '本印面暫無印面影像，暫無原檔可下載。' }
  }
  const source = imageSourceOf(imageId)
  if (source.via === 'digest') {
    /* **K-P5b｜按 digest 引用的原字節面**：行內有 digest ⇒ **不需要本機字節**，
       服務端權威庫按 digest 原字節直出（byte-verbatim）⇒ 判據三件 ＝
       **下載件 `sha256` ≡ 行內 digest** ＋ 體量 ＋ 魔數（按字節如實）。 */
    const out = await fetchOriginalBytes({
      sha256: source.digest,
      kind: clientKindOf(source.row || {}, '')
    })
    const matched = out.ok && out.sha256 === source.digest
    const report = {
      imageId,
      storedMime: String((source.row && source.row.mime) || '').toLowerCase(),
      outMime: out.mime || '',
      bytesLength: out.bytesLength || 0,
      sha256: out.sha256 || '',
      sha256Stored: source.digest,
      verdict: out.ok ? (matched ? 'match' : 'mismatch') : '',
      viaApi: true,
      via: 'api',
      source: 'digest',
      digest: source.digest,
      passthrough: out.passthrough === true,
      watermark: out.watermark === true,
      filename: out.filename || '',
      reason: out.reason || ''
    }
    if (!out.ok) {
      return {
        ok: false,
        report,
        message: '原檔下載失敗，請稍後再試（本次會話已爲該印章計費，重試不再扣費）。'
      }
    }
    if (!matched) {
      return {
        ok: false,
        report,
        message: '下載件與存檔件的摘要不一致，已中止本次下載（本次會話不再重複扣費，可直接重試）。'
      }
    }
    return {
      ok: true,
      filename: out.filename,
      bytes: out.bytes,
      mime: out.mime,
      bytesLength: out.bytesLength,
      sha256: out.sha256,
      sha256Stored: source.digest,
      verdict: 'match',
      viaApi: true,
      watermark: out.watermark === true,
      passthrough: out.passthrough === true,
      report,
      message: `已下載原檔 ${out.filename}（${out.bytesLength} 字節）；摘要核對一致（≡ 影像行內 digest）。`
    }
  }
  const stored = await loadStoredImage(imageId)
  if (!stored.ok) {
    return { ok: false, report: { reason: 'NOT_FOUND', imageId }, message: stored.message }
  }
  const out = await originalDownloadOf({
    imageId,
    kind: clientKindOf(stored.row || {}, ''),
    bytes: stored.bytes,
    mime: stored.mime
  })
  const report = {
    imageId,
    storedMime: stored.mime,
    outMime: out.mime || '',
    bytesLength: out.bytesLength || 0,
    sha256: out.sha256 || '',
    sha256Stored: out.sha256Stored || '',
    verdict: out.verdict || '',
    viaApi: out.viaApi === true,
    via: out.viaApi === true ? 'api' : 'local',
    passthrough: out.passthrough === true,
    watermark: out.watermark === true,
    filename: out.filename || '',
    reason: out.reason || ''
  }
  if (!out.ok) {
    return {
      ok: false,
      report,
      message: '原檔下載失敗，請稍後再試（本次會話已爲該印章計費，重試不再扣費）。'
    }
  }
  if (out.verdict !== 'match') {
    /* **判據三件**未過（`sha256` ≠ 存檔件）⇒ 明示中止，不把未核對的件交出去。 */
    return {
      ok: false,
      report,
      message: '下載件與存檔件的摘要不一致，已中止本次下載（本次會話不再重複扣費，可直接重試）。'
    }
  }
  return {
    ok: true,
    filename: out.filename,
    bytes: out.bytes,
    mime: out.mime,
    bytesLength: out.bytesLength,
    sha256: out.sha256,
    sha256Stored: out.sha256Stored,
    verdict: out.verdict,
    viaApi: out.viaApi === true,
    watermark: out.watermark === true,
    passthrough: out.passthrough === true,
    report,
    message: `已下載原檔 ${out.filename}（${out.bytesLength} 字節）；摘要核對一致。`
  }
}

/**
 * **原字節面的落盤件**（面別限定：**顯式索取面**）。
 *
 * 走 api ⇔ 存儲件容器 ∈ {TIFF, 存量只讀 AVIF}；**其餘容器（存量舊 8 色索引 PNG 等）
 * 一律不走 api** ⇒ 直接把**本機既有字節**原樣交出（同一份「原字節面」語義，
 * 只是不經網路；**存量面語義不得回歸**）。
 *
 * @param {{imageId:string, kind?:string, bytes:Uint8Array, mime:string}} input 存儲件讀數
 * @returns {Promise<{ok:boolean, filename?:string, bytes?:Uint8Array, mime?:string, bytesLength?:number,
 *          sha256?:string, sha256Stored?:string, verdict?:string, viaApi?:boolean, watermark?:boolean,
 *          passthrough?:boolean, message:string, reason?:string}>}
 */
export async function originalDownloadOf(input = {}) {
  const stored = bytesViewOf(input.bytes)
  const mime = String(input.mime || '').trim().toLowerCase()
  if (stored === null || stored.length === 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '本機影像庫中暫無該編號的圖象文件' }
  }
  const storedSha = sha256Hex(stored)
  const verdict = (downSha) => (downSha === storedSha ? 'match' : 'mismatch')
  if (!passThroughMimeOf(mime)) {
    /* 存量 / 非源面容器：**不經 api**，本機字節原樣交出 + 摘要對賬。 */
    const suffix = EXT_OF_MIME[mime] || '.bin'
    return {
      ok: true,
      viaApi: false,
      filename: `xiai-original-${storedSha.slice(0, 12)}${suffix}`,
      bytes: stored,
      mime,
      bytesLength: stored.length,
      sha256: storedSha,
      sha256Stored: storedSha,
      verdict: verdict(storedSha),
      watermark: false,
      passthrough: true,
      message: ''
    }
  }
  const out = await fetchOriginalBytes({ bytes: stored, kind: input.kind })
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message }
  return {
    ok: true,
    viaApi: true,
    filename: out.filename,
    bytes: out.bytes,
    mime: out.mime,
    bytesLength: out.bytesLength,
    sha256: out.sha256,
    sha256Stored: storedSha,
    verdict: verdict(out.sha256),
    watermark: out.watermark,
    passthrough: out.passthrough,
    message: ''
  }
}
