/**
 * 影像三面 —— **R-101 二次封裝**（消費 xiai-api 的 `/api/image/**`）。
 *
 * 面別（xiai-api §3.24.3；**逐字路徑，不得 rewrite 前綴**）：
 *   ① **塊面**    `POST /api/image/slices`   —— 預覽路徑：解 → 轉 WebP 0.92 → 經 TileSplicer → 出塊；
 *   ② **縮略面**  `POST /api/image/thumb`    —— 直出路徑（縮略圖）：**不經 TileSplicer**；
 *   ③ **原字節面** `POST /api/image/download` —— 直出路徑・原字節面：**原始存儲件字節直出**
 *      （byte-verbatim、零轉碼 / 零重編碼 ⇒ 下載件 `sha256` ≡ 源存儲件 `sha256`）。
 *
 * 邊界（與 `impl.js` 同口徑，R-101 / R-103）：
 *   ① 只經 **HTTP 契約**消費 xiai-api —— 相對路徑 ⇒ 同源 ⇒ 經 yinsuo 自己的 Vite 代理轉
 *      `http://127.0.0.1:5191`；**前綴不 rewrite**（xiai-api 逐字匹配 `/api/image/**`，改前綴直落 404）；
 *   ② **不得 import xiai 源碼**；**不得在本層重算切位 / 重寫切分或轉碼實現** ——
 *      幾何一律**逐字段取自真源響應**（`blocks[].rect` / `blocks[].placements` / `cols` / `rows` /
 *      `cuts` / `directions` / `ratios` / `source{width,height}`），本層只做**包裝**：
 *      解 `multipart/mixed`、建 `objectURL`、包字段名、包讀數（響應頭）；
 *      **本層不做任何像素運算 —— 不裁剪、不縮放、不轉碼、不拼圖**；
 *   ③ xiai-api 不可達 / 非 200 / 結構不符 ⇒ **結構化失敗**（`code` + `reason` + 請求讀數），
 *      **不回落任何本地 / mock 數據**，不以空塊集合或佔位圖冒充成功；
 *   ④ **地址族**：5191 實測**只綁 IPv4**（`127.0.0.1:5191`）⇒ 代理 target 必須寫 `127.0.0.1`
 *      （不寫 `localhost`：Node 側 `localhost` 優先 `::1` ⇒ `ECONNREFUSED ::1:5191`）。
 *
 * 源字節的取得形態（xiai-api 兩種，**面別不變**）：
 *   · `?sha256=<hex>`：從服務端權威存儲按摘要取件 —— **瀏覽器端無源字節時的唯一形態**；
 *   · `options.body`：請求載荷直傳字節（`application/octet-stream`）。
 *   兩者都不給 ⇒ 結構化失敗（本層**不猜**、不代填摘要）。
 *
 * 本文件**不屬 A1–A31 契約方法**（A27 仍由 `impl.js` 提供），故**不受 `DATA_SOURCE` 開關影響**：
 * 它是 xiai-api 影像三面的直接消費面，是否有摘要由調用方（頁面）決定。
 */
import { ASSET_KIND } from '@/data/contract.js'

/** 三面**逐字**路徑（不改前綴、不拼版本號）。 */
export const IMAGE_FACES = Object.freeze({
  SLICES: '/api/image/slices',
  THUMB: '/api/image/thumb',
  ORIGINAL: '/api/image/download',
})

/** 供頁面展示 / 失敗態引用的端點讀數。 */
export const IMAGE_FACE_ENDPOINTS = Object.freeze({
  slices: `POST ${IMAGE_FACES.SLICES}?assetId=&kind=&sha256=`,
  thumb: `POST ${IMAGE_FACES.THUMB}?kind=&width=&sha256=`,
  original: `POST ${IMAGE_FACES.ORIGINAL}?kind=&sha256=`,
})

/** xiai-api 客戶面 `kind` 值域（**只兩值**；`scene` ⇔ 內核 PHOTO）。 */
export const XIAI_CLIENT_KIND = Object.freeze({ FACE: 'face', SCENE: 'scene' })

/**
 * yinsuo 影像類別（contract.ASSET_KIND）→ xiai-api 客戶面 `kind`（值域只有 `face|scene`）。
 * 邊款 / 鈐本屬**實拍影像** ⇒ 歸 `scene` 族。（與 `impl.js` 的 TileSplicer 別名表同源；
 * 那是計劃面的大寫 `FACE|PHOTO`，這是影像面的小寫 `face|scene` —— **不是同一張表**。）
 */
export const CLIENT_KIND_BY_ASSET_KIND = Object.freeze({
  [ASSET_KIND.FACE]: XIAI_CLIENT_KIND.FACE,
  [ASSET_KIND.EDGE]: XIAI_CLIENT_KIND.SCENE,
  [ASSET_KIND.IMPRESSION]: XIAI_CLIENT_KIND.SCENE,
})

/** 缺省類別 ＝ 印面（與首頁樣例卡 `assets[0]` 恒為 FACE 同口徑）。 */
const DEFAULT_CLIENT_KIND = XIAI_CLIENT_KIND.FACE

/** 縮略面目標長邊（**本層不設口徑**）：不傳則取真源默認值，由真源響應頭如實回報。 */
export const THUMB_WIDTH_MIN = 16
export const THUMB_WIDTH_MAX = 4096

const TEXT_ENCODER = new TextEncoder()
const CRLF_CRLF = TEXT_ENCODER.encode('\r\n\r\n')

/**
 * 結構化失敗（與 `impl.js::structuredFail` 同形狀）：`code` + `reason` + 請求讀數齊備，
 * 供頁面渲染可讀失敗態；**不返回任何影像數據**。
 */
function imageFail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, reason: extra.reason || code, ...extra })
}

/** 解析 yinsuo 影像類別 → xiai-api 客戶面 `kind`（缺省 FACE；非法值不靜默糾正，交真源判 INVALID_VALUE）。 */
export function clientKindOf(kind) {
  if (kind === null || kind === undefined || kind === '') return DEFAULT_CLIENT_KIND
  const upper = String(kind).trim().toUpperCase()
  return CLIENT_KIND_BY_ASSET_KIND[upper] || String(kind).trim().toLowerCase()
}

/** 摘要白名單化：64 位十六進制（xiai-api 的 `sha256` 形態）；不符 ⇒ null（不代填、不截斷）。 */
export function normalizeDigest(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(text) ? text : ''
}

/** 字節白名單化：`Uint8Array` / `ArrayBuffer` 皆認；其它形態 ⇒ null。 */
function normalizeBody(raw) {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return null
}

/** 拼三面查詢串（空值不下發；參數**如實透傳**，本層不替真源做值域判定）。 */
export function buildImageUrl(face, params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `${face}?${qs}` : face
}

/** 採集 `x-xiai-*` 響應頭讀數（**如實透傳**；缺失即缺失，不補默認值）。 */
export function readXiaiHeaders(headers) {
  const out = {}
  if (!headers || typeof headers.forEach !== 'function') return out
  headers.forEach((value, key) => {
    if (String(key).toLowerCase().startsWith('x-xiai-')) out[String(key).toLowerCase()] = value
  })
  return out
}

/**
 * 三面的統一請求（**只有這一處 fetch**）。
 * 網絡層失敗與真源的結構化錯誤面（`{ok:false,reason,message}`）在此轉成結構化失敗。
 */
async function postImageFace(face, params, options = {}) {
  const requestedUrl = buildImageUrl(face, params)
  const endpoint = options.endpoint || face
  const body = normalizeBody(options.body)
  const init = {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: options.accept || '*/*' },
  }
  if (options.signal) init.signal = options.signal
  if (body) {
    init.body = body
    init.headers['Content-Type'] = 'application/octet-stream'
  }

  let response = null
  try {
    response = await fetch(requestedUrl, init)
  } catch (error) {
    throw imageFail(
      'IMAGE_API_UNREACHABLE',
      `影像服务不可用：无法连到 xiai-api（${endpoint}）。本层已结构化失败，不回退任何本地演示数据。`,
      {
        cause: String((error && error.message) || error),
        requestedUrl,
        endpoint,
        httpStatus: null,
        params: { kind: params.kind, assetId: params.assetId, sha256: params.sha256 },
      },
    )
  }

  if (!response.ok) {
    let reason = ''
    let message = ''
    try {
      const text = await response.text()
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        reason = typeof parsed.reason === 'string' ? parsed.reason : ''
        message = typeof parsed.message === 'string' ? parsed.message : ''
      }
    } catch (error) {
      reason = ''
      message = ''
    }
    throw imageFail(
      reason || `IMAGE_API_HTTP_${response.status}`,
      message || `影像请求失败：真源返回 HTTP ${response.status}（${endpoint}）。本层不造伪数据。`,
      {
        reason: reason || `IMAGE_API_HTTP_${response.status}`,
        httpStatus: response.status,
        requestedUrl,
        endpoint,
        params: { kind: params.kind, assetId: params.assetId, sha256: params.sha256 },
      },
    )
  }

  return { response, requestedUrl, endpoint }
}

/** 取 `multipart/mixed` 的 boundary（**逐字取自響應頭**；缺失 ⇒ 結構不符）。 */
function boundaryOf(contentType) {
  const match = /boundary=("?)([^";]+)\1/i.exec(String(contentType || ''))
  return match ? match[2].trim() : ''
}

/** 字節級 `indexOf`（`multipart/mixed` 含二進制塊字節，不得經文本解碼）。 */
function indexOfBytes(haystack, needle, from) {
  const limit = haystack.length - needle.length
  outer: for (let i = Math.max(0, from); i <= limit; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 解析 `multipart/mixed`（**純字節切分，零像素運算**）：首部清單（JSON）＋ 逐塊一件。
 * 返回 `[{headers, body:Uint8Array}]`；結構與真源的 `_multipart_slices` 逐字對應。
 */
export function parseMultipartMixed(arrayBuffer, boundary) {
  const bytes = new Uint8Array(arrayBuffer)
  const dashBoundary = TEXT_ENCODER.encode(`--${boundary}`)
  const parts = []
  let pos = indexOfBytes(bytes, dashBoundary, 0)

  while (pos !== -1) {
    const afterBoundary = pos + dashBoundary.length
    // 收尾定界符 `--` ⇒ 結束
    if (bytes[afterBoundary] === 0x2d && bytes[afterBoundary + 1] === 0x2d) break

    let start = afterBoundary
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2

    const next = indexOfBytes(bytes, dashBoundary, start)
    const segmentEnd = next === -1 ? bytes.length : next
    const headerEnd = indexOfBytes(bytes, CRLF_CRLF, start)
    if (headerEnd === -1 || headerEnd > segmentEnd) {
      pos = next
      continue
    }

    const headers = {}
    const headerText = new TextDecoder().decode(bytes.subarray(start, headerEnd))
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }

    let bodyEnd = segmentEnd
    if (bodyEnd - 2 >= headerEnd && bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2
    parts.push({ headers, body: bytes.slice(headerEnd + CRLF_CRLF.length, bodyEnd) })
    pos = next
  }

  return parts
}

/** 矩形白名單化（只取幾何，不派生）：`{x,y,w,h}` 四值有限且 w/h > 0。 */
function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const w = Number(raw.w)
  const h = Number(raw.h)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** 落位白名單化（真源 `placements`：`{x,y,width,height}`），缺失 ⇒ null（**不代算**）。 */
function normalizePlacement(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** 有限數數組（真源 `ratios`）；非數組 / 含非有限數 ⇒ null（結構不符）。 */
function normalizeNumberList(raw) {
  if (!Array.isArray(raw)) return null
  const out = raw.map((n) => Number(n))
  return out.every((n) => Number.isFinite(n)) ? out : null
}

/** 非空字符串數組（真源 `directions`）。 */
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return null
  return raw.every((v) => typeof v === 'string' && v) ? raw.slice() : null
}

/** 已建的 `objectURL` 登記（供調用方一次性釋放；**本層不自行 revoke 未知 URL**）。 */
const RETAINED_URLS = new Set()

/** 建 `objectURL` 並登記。 */
function retainObjectUrl(blob) {
  const url = URL.createObjectURL(blob)
  RETAINED_URLS.add(url)
  return url
}

/** 釋放影像三面產生的 `objectURL`（頁面在替換數據 / 卸載時調用）。 */
export function releaseImageUrls(...urls) {
  for (const url of urls.flat()) {
    if (typeof url === 'string' && RETAINED_URLS.has(url)) {
      URL.revokeObjectURL(url)
      RETAINED_URLS.delete(url)
    }
  }
}

/** 三面共用的入參前置門（摘要 / 直傳字節二選一；assetId 僅塊面必需）。 */
function requireSource({ assetId = '', sha256 = '', body = null, endpoint, needAssetId = false, kind }) {
  const id = typeof assetId === 'string' ? assetId.trim() : ''
  const digest = normalizeDigest(sha256)
  const bytes = normalizeBody(body)
  const common = { endpoint, kind, assetId: id, sha256: digest || '', sourceMode: bytes ? 'inline-bytes' : (digest ? 'sha256-ref' : 'none') }

  if (needAssetId && !id) {
    throw imageFail('INVALID_ARGUMENT', '缺少 assetId：块面以资源 ID 为入参（xiai-api /api/image/slices）', common)
  }
  if (!digest && !bytes) {
    throw imageFail(
      'INVALID_ARGUMENT',
      '缺少源件：既未给出 sha256 摘要（服务端权威存储取件），也未直传字节。本层不代填摘要、不猜测源件。',
      common,
    )
  }
  if (sha256 && !digest) {
    throw imageFail('INVALID_ARGUMENT', 'sha256 形态不符：需 64 位十六进制小写摘要（本层不改写、不截断）。', common)
  }
  return { assetId: id, sha256: digest, body: bytes, common }
}

/* ==========================================================================
 * ① 塊面 —— 展示切片（多塊字節；幾何逐字取自真源）
 * ========================================================================== */

/**
 * 塊面：取展示切片（**本層不拼接、不裁切、不轉碼** —— 每塊字節與幾何皆真源原樣）。
 *
 * @param {{assetId?:string, kind?:string, sha256?:string, body?:Uint8Array|ArrayBuffer, signal?:AbortSignal}} [input]
 * @returns {Promise<object>} `{assetId, kind, kernelKind, version, source{width,height}, cuts, directions,
 *   ratios, cols, rows, blockCount, tiles[], seams, blocks[], display{}, slicing{}, responseHeaders{},
 *   requestedUrl, release()}`；`blocks[]` 每塊
 *   `{index,row,col,rect{x,y,w,h},placement{x,y,width,height},mime,lossless,bytes,sha256,body:Uint8Array,objectUrl}`。
 */
export async function getImageSlices(input = {}) {
  const { assetId, sha256, body, common } = requireSource({
    assetId: input.assetId,
    sha256: input.sha256,
    body: input.body,
    kind: clientKindOf(input.kind),
    endpoint: IMAGE_FACE_ENDPOINTS.slices,
    needAssetId: true,
  })
  const kind = clientKindOf(input.kind)

  const { response, requestedUrl } = await postImageFace(
    IMAGE_FACES.SLICES,
    { assetId, kind, sha256 },
    { accept: 'multipart/mixed', body, endpoint: IMAGE_FACE_ENDPOINTS.slices, signal: input.signal },
  )

  const boundary = boundaryOf(response.headers.get('content-type'))
  if (!boundary) {
    throw imageFail('IMAGE_API_INVALID_RESPONSE', '块面响应不是 multipart/mixed（缺 boundary）：真源结构不符，本层不造伪数据。', {
      ...common, httpStatus: response.status, requestedUrl, contentType: response.headers.get('content-type') || '',
    })
  }

  const parts = parseMultipartMixed(await response.arrayBuffer(), boundary)
  if (!parts.length) {
    throw imageFail('IMAGE_API_INVALID_RESPONSE', '块面响应无任何 part：真源结构不符，本层不造伪数据。', {
      ...common, httpStatus: response.status, requestedUrl,
    })
  }

  const manifestPart = parts.find((part) => part.headers['content-id'] === 'manifest') || parts[0]
  let manifest = null
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestPart.body))
  } catch (error) {
    throw imageFail('IMAGE_API_INVALID_RESPONSE', '块面清单（manifest）不可解析为 JSON：本层不造伪数据。', {
      ...common, httpStatus: response.status, requestedUrl, cause: String((error && error.message) || error),
    })
  }
  if (!manifest || typeof manifest !== 'object' || manifest.ok !== true) {
    throw imageFail('IMAGE_API_INVALID_RESPONSE', '块面清单结构不符（缺 ok:true）：本层不造伪数据。', {
      ...common, httpStatus: response.status, requestedUrl,
    })
  }

  const sourceRaw = manifest.source && typeof manifest.source === 'object' ? manifest.source : null
  const sourceWidth = sourceRaw ? Number(sourceRaw.width) : NaN
  const sourceHeight = sourceRaw ? Number(sourceRaw.height) : NaN
  const directions = normalizeStringList(manifest.directions)
  const ratios = normalizeNumberList(manifest.ratios)
  const cols = Number(manifest.cols)
  const rows = Number(manifest.rows)
  const tiles = Array.isArray(manifest.tiles) ? manifest.tiles : null
  const tileRects = tiles ? tiles.map((tile) => normalizeRect(tile && tile.rect)) : null
  const rawBlocks = Array.isArray(manifest.blocks) ? manifest.blocks : null
  const blockRects = rawBlocks ? rawBlocks.map((block) => normalizeRect(block && block.rect)) : null

  const structureOk = Boolean(
    sourceRaw
    && Number.isFinite(sourceWidth) && sourceWidth > 0
    && Number.isFinite(sourceHeight) && sourceHeight > 0
    && directions && ratios
    && Number.isFinite(cols) && cols > 0
    && Number.isFinite(rows) && rows > 0
    && tiles && tiles.length > 0 && tileRects.every(Boolean)
    && rawBlocks && rawBlocks.length > 0 && blockRects.every(Boolean),
  )
  if (!structureOk) {
    throw imageFail(
      'IMAGE_API_INVALID_RESPONSE',
      '块面结构不符：真源响应缺少必需的几何字段（source / directions / ratios / cols / rows / tiles[].rect / blocks[].rect）。本层不造伪数据。',
      { ...common, httpStatus: response.status, requestedUrl },
    )
  }

  const payloads = parts.filter((part) => String(part.headers['content-id'] || '').startsWith('block-'))
  const payloadByIndex = new Map()
  for (const part of payloads) {
    const index = Number(part.headers['x-block-index'])
    if (Number.isFinite(index)) payloadByIndex.set(index, part)
  }

  const objectUrls = []
  const blocks = rawBlocks.map((block, position) => {
    const index = Number.isFinite(Number(block.index)) ? Number(block.index) : position
    const part = payloadByIndex.get(index) || null
    const payload = part ? part.body : new Uint8Array(0)
    const blob = new Blob([payload], { type: part ? (part.headers['content-type'] || 'application/octet-stream') : 'application/octet-stream' })
    const objectUrl = payload.length ? retainObjectUrl(blob) : ''
    if (objectUrl) objectUrls.push(objectUrl)
    return {
      index,
      row: Number.isFinite(Number(block.row)) ? Number(block.row) : null,
      col: Number.isFinite(Number(block.col)) ? Number(block.col) : null,
      rect: blockRects[position],
      placement: normalizePlacement(block.placements) || blockRects[position],
      mime: typeof block.mime === 'string' ? block.mime : (part ? part.headers['content-type'] || null : null),
      lossless: typeof block.lossless === 'boolean' ? block.lossless : null,
      quality: block.quality === undefined ? null : block.quality,
      bytes: Number.isFinite(Number(block.bytes)) ? Number(block.bytes) : payload.length,
      /** 真源自報塊摘要（逐字）；與本地字節是否一致由呼叫方自行覆核。 */
      sha256: typeof block.sha256 === 'string' ? block.sha256 : null,
      body: payload,
      objectUrl,
    }
  })

  const display = manifest.display && typeof manifest.display === 'object' ? manifest.display : null

  return {
    assetId: typeof manifest.assetId === 'string' ? manifest.assetId : assetId,
    kind: typeof manifest.kind === 'string' ? manifest.kind : kind,
    kernelKind: typeof manifest.kernelKind === 'string' ? manifest.kernelKind : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    source: { width: sourceWidth, height: sourceHeight },
    cuts: Number.isFinite(Number(manifest.cuts)) ? Number(manifest.cuts) : null,
    directions,
    ratios,
    cols,
    rows,
    blockCount: blocks.length,
    /** 真源清單自報塊數（與實際 part 數不符即如實並列，供呼叫方覆核）。 */
    blockCountReported: Number.isFinite(Number(manifest.blockCount)) ? Number(manifest.blockCount) : null,
    tiles: tiles.map((tile, position) => ({
      index: Number.isFinite(Number(tile.index)) ? Number(tile.index) : position,
      row: Number.isFinite(Number(tile.row)) ? Number(tile.row) : null,
      col: Number.isFinite(Number(tile.col)) ? Number(tile.col) : null,
      rect: tileRects[position],
    })),
    seam: manifest.seam && typeof manifest.seam === 'object' ? manifest.seam : null,
    blocks,
    display: display ? {
      mime: display.mime || null,
      quality: display.quality === undefined ? null : display.quality,
      lossless: typeof display.lossless === 'boolean' ? display.lossless : null,
      wholeImageIncluded: typeof display.whole_image_included === 'boolean' ? display.whole_image_included : null,
    } : null,
    slicing: manifest.slicing && typeof manifest.slicing === 'object' ? manifest.slicing : null,
    responseHeaders: readXiaiHeaders(response.headers),
    requestedUrl,
    /** 釋放本響應建立的 objectURL（呼叫方在替換數據 / 卸載時調用）。 */
    release: () => releaseImageUrls(objectUrls),
  }
}

/* ==========================================================================
 * ② 縮略面（直出路徑；不經 TileSplicer）
 * ========================================================================== */

/**
 * 縮略面：取縮略圖（**本層不縮放、不做像素運算** —— 縮放由真源完成）。
 *
 * @param {{kind?:string, width?:number, sha256?:string, body?:Uint8Array|ArrayBuffer, signal?:AbortSignal}} [input]
 * @returns {Promise<object>} `{mime, byteLength, blob, objectUrl, body:Uint8Array,
 *   longEdge, source{width,height}, out{width,height}, responseHeaders, requestedUrl, release()}`。
 */
export async function getImageThumb(input = {}) {
  const kind = clientKindOf(input.kind)
  const { sha256, body, common } = requireSource({
    sha256: input.sha256, body: input.body, kind, endpoint: IMAGE_FACE_ENDPOINTS.thumb,
  })

  let width = ''
  if (input.width !== undefined && input.width !== null && input.width !== '') {
    const parsed = Number(input.width)
    if (!Number.isFinite(parsed) || parsed < THUMB_WIDTH_MIN || parsed > THUMB_WIDTH_MAX) {
      throw imageFail(
        'INVALID_ARGUMENT',
        `缩略图长边不在允许范围（${THUMB_WIDTH_MIN}–${THUMB_WIDTH_MAX}）：本层不改写入参，交真源判定。`,
        { ...common, width: input.width },
      )
    }
    width = Math.round(parsed)
  }

  const { response, requestedUrl } = await postImageFace(
    IMAGE_FACES.THUMB,
    { kind, width, sha256 },
    { accept: 'image/webp', body, endpoint: IMAGE_FACE_ENDPOINTS.thumb, signal: input.signal },
  )

  const blob = await response.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const headers = readXiaiHeaders(response.headers)
  const objectUrl = retainObjectUrl(blob)

  return {
    mime: response.headers.get('content-type') || blob.type || null,
    byteLength: bytes.length,
    body: bytes,
    blob,
    objectUrl,
    /** 真源如實回報的長邊 / 尺寸讀數（缺失即 null）。 */
    longEdge: headers['x-xiai-thumb-long-edge'] ? Number(headers['x-xiai-thumb-long-edge']) : null,
    source: {
      width: headers['x-xiai-source-width'] ? Number(headers['x-xiai-source-width']) : null,
      height: headers['x-xiai-source-height'] ? Number(headers['x-xiai-source-height']) : null,
    },
    out: {
      width: headers['x-xiai-out-width'] ? Number(headers['x-xiai-out-width']) : null,
      height: headers['x-xiai-out-height'] ? Number(headers['x-xiai-out-height']) : null,
    },
    responseHeaders: headers,
    requestedUrl,
    release: () => releaseImageUrls([objectUrl]),
  }
}

/* ==========================================================================
 * ③ 原字節面（直出路徑；byte-verbatim、零轉碼）
 * ========================================================================== */

/** 瀏覽器端摘要（`crypto.subtle` 不可用時返回 null —— **不用偽值充數**）。 */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) return null
  const data = normalizeBody(bytes)
  if (!data) return null
  const digest = await subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 原字節面：取「下載高清原圖」（**原始存儲件字節直出**）。
 *
 * 本層**如實**把「本地重算摘要」與「響應頭自報摘要」並列返回（`digestMatches`：相等 true、
 * 不等 false、無法重算 null）——**不得以自報值冒充覆核結果**。
 *
 * @param {{kind?:string, sha256?:string, body?:Uint8Array|ArrayBuffer, signal?:AbortSignal}} [input]
 * @returns {Promise<object>} `{mime, byteLength, disposition, fileName, body:Uint8Array, blob, objectUrl,
 *   sha256, storedSha256, storedBytes, digestMatches, passthrough, transcode, watermark,
 *   responseHeaders, requestedUrl, release()}`。
 */
export async function getImageOriginal(input = {}) {
  const kind = clientKindOf(input.kind)
  const { sha256, body, common } = requireSource({
    sha256: input.sha256, body: input.body, kind, endpoint: IMAGE_FACE_ENDPOINTS.original,
  })

  const { response, requestedUrl } = await postImageFace(
    IMAGE_FACES.ORIGINAL,
    { kind, sha256 },
    { body, endpoint: IMAGE_FACE_ENDPOINTS.original, signal: input.signal },
  )

  const blob = await response.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const headers = readXiaiHeaders(response.headers)
  const digest = await sha256Hex(bytes)
  const storedSha256 = headers['x-xiai-stored-sha256'] || null
  const objectUrl = retainObjectUrl(blob)
  const disposition = response.headers.get('content-disposition') || ''
  const fileName = /filename="([^"]*)"/.exec(disposition)

  return {
    mime: response.headers.get('content-type') || blob.type || null,
    byteLength: bytes.length,
    body: bytes,
    blob,
    objectUrl,
    disposition: disposition || null,
    fileName: fileName ? fileName[1] : null,
    /** 本地重算摘要（`crypto.subtle` 不可用 ⇒ null）。 */
    sha256: digest,
    /** 響應頭自報摘要（服務端權威庫摘要）。 */
    storedSha256,
    storedBytes: headers['x-xiai-stored-bytes'] ? Number(headers['x-xiai-stored-bytes']) : null,
    digestMatches: digest && storedSha256 ? digest === storedSha256 : null,
    passthrough: headers['x-xiai-passthrough'] || null,
    transcode: headers['x-xiai-transcode'] || null,
    watermark: headers['x-xiai-watermark'] || null,
    fullResolution: headers['x-xiai-full-resolution'] || null,
    minRole: headers['x-xiai-min-role'] || null,
    responseHeaders: headers,
    requestedUrl,
    release: () => releaseImageUrls([objectUrl]),
  }
}
