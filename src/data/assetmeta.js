/**
 * 玺爱 · 影像二进制工具（**纯函数**，不碰任何浏览器存储）
 *
 * 职责：把「上传进来的图」归一成字节、算摘要（`sha256`）、读尺寸与色彩模式，
 * 以及 dataURL ↔ 字节 的双向转换。**不写任何存储**（二进制落盘见 `blobstore.js`，
 * 元数据落盘见 `db.js`）。
 *
 * 为什么自带 `sha256` 而不用 `crypto.subtle`：① 免 async（判重键要能在同一处算完）；
 * ② 不依赖安全上下文（`crypto.subtle` 在非 https / 非 localhost 下不可用）；
 * ③ 结果可复算、可跨环境（浏览器与 node 侧自测读数一致）。
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

/** 任意形态 → `Uint8Array`（dataURL / base64 由 `dataUrlToBytes` 负责，这里收口字节类输入）。 */
export function toUint8Array(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (Array.isArray(input)) return Uint8Array.from(input)
  if (typeof input === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input)
    const out = new Uint8Array(input.length)
    for (let i = 0; i < input.length; i += 1) out[i] = input.charCodeAt(i) & 0xff
    return out
  }
  return new Uint8Array(0)
}

export function bytesToHex(bytes) {
  const view = toUint8Array(bytes)
  let out = ''
  for (let i = 0; i < view.length; i += 1) out += view[i].toString(16).padStart(2, '0')
  return out
}

/** SHA-256（返回小写十六进制）。输入：`Uint8Array` / `ArrayBuffer` / 数字数组 / 字符串。 */
export function sha256Hex(input) {
  const msg = toUint8Array(input)
  const len = msg.length
  const total = ((len + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[len] = 0x80
  const view = new DataView(buf.buffer)
  const bitLenHi = Math.floor(len / 536870912) // len * 8 / 2^32
  const bitLenLo = (len << 3) >>> 0
  view.setUint32(total - 8, bitLenHi)
  view.setUint32(total - 4, bitLenLo)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
    0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  /* 逐字按**大端**序列化（不能拿 `h.buffer` 直接转 —— 平台字节序是小端，会得到字节倒序的错值）。 */
  let hex = ''
  for (let i = 0; i < 8; i += 1) hex += h[i].toString(16).padStart(8, '0')
  return hex
}

/**
 * dataURL → 字节。**只接受** `data:image/...;base64,...`，其它形态给可读拒绝。
 * @returns {{ok:boolean, bytes?:Uint8Array, mime?:string, message?:string}}
 */
export function dataUrlToBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return { ok: false, message: '請選擇圖片文件（JPG / PNG / WebP）' }
  }
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return { ok: false, message: '圖片內容無法解析，請重新選擇文件' }
  const head = dataUrl.slice(5, comma)
  const mime = (head.split(';')[0] || '').trim().toLowerCase()
  if (!mime.startsWith('image/')) return { ok: false, message: '僅支持圖片文件（JPG / PNG / WebP）' }
  if (!/;base64/i.test(head)) return { ok: false, message: '圖片需爲 base64 編碼（瀏覽器文件讀取默認如此）' }
  const body = dataUrl.slice(comma + 1)
  try {
    const binary = typeof atob === 'function' ? atob(body) : Buffer.from(body, 'base64').toString('binary')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff
    return { ok: true, bytes, mime }
  } catch {
    return { ok: false, message: '圖片內容無法解析，請重新選擇文件' }
  }
}

function encodeBase64(bytes) {
  const view = toUint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk))
  }
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(binary, 'binary').toString('base64')
}

/**
 * 字节魔数 → mime。**认不出返回空串**（不回落、不猜测）。
 *
 * 判定口径与 `src/utils/image.js::sniffBytesMime` **逐条谓词逐字对齐**
 * （PNG / JPEG / GIF / WebP 四个签名；WebP 要求 `RIFF....WEBP` 四个字节全中，
 * 不接受只命中 `[8] === 'W'` 的其它 RIFF 容器如 `WAVE`）。
 * 为什么两处各留一份而不是互相 import：本模块是**纯函数**影像工具（见文件头），
 * 数据层不 import `utils/**`（层级纪律）；口径对齐靠**同一组谓词**维持。
 *
 * **R-91（2026-09-21｜本单）**：补上 **AVIF** 谓词（`isIsobmffAvif`），
 * 与 `utils/image.js::sniffBytesMime` 的 R-86 版本**逐条对齐**（该差异此前是单向的：
 * 服务层认 AVIF、数据层不认 ⇒ 走 `insertImageRow` / `replaceFaceImage` 的 AVIF 被误判
 * `UNRECOGNIZED_IMAGE`）。四条**既有**谓词逐字未动，AVIF 分支追加在**末尾**
 * （AVIF 不在场 ⇒ 仍返回空串 ⇒ 既有判据零变化）。
 */
function magicMime(v) {
  /* ① **存储容器**：TIFF 魔数 —— 小端 `II*\0`（49 49 2A 00）/ 大端 `MM\0*`（4D 4D 00 2A）。
     与 `utils/image.js::sniffBytesMime` 的同一组字节判据（数字层不 import utils ⇒ 各持一份谓词，
     谓词逐条对齐；两族首字节与 PNG 不同 ⇒ 无冲突）。 */
  if (v.length >= 4 && ((v[0] === 0x49 && v[1] === 0x49 && v[2] === 0x2a && v[3] === 0x00) ||
      (v[0] === 0x4d && v[1] === 0x4d && v[2] === 0x00 && v[3] === 0x2a))) return 'image/tiff'
  if (v.length >= 8 && v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47) return 'image/png'
  if (v.length >= 3 && v[0] === 0xff && v[1] === 0xd8 && v[2] === 0xff) return 'image/jpeg'
  if (v.length >= 4 && v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46) return 'image/gif'
  if (
    v.length >= 12 &&
    v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 &&
    v[8] === 0x57 && v[9] === 0x45 && v[10] === 0x42 && v[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (isIsobmffAvif(v)) return 'image/avif'
  return ''
}

/**
 * ISO-BMFF 容器 → 是否 AVIF（`ftyp` 主品牌 / 兼容品牌含 `avif` / `avis`）。
 *
 * 与 `src/utils/image.js::isIsobmffAvif` **逐条谓词对齐**（同一组字节判据，本模块自持一份
 * —— 理由同上：数据层不 import `utils/**`）。读法：偏移 4 起必须是 `ftyp`（0x66 0x74 0x79 0x70），
 * 主品牌在偏移 8，其后每个 4 字节品牌的兼容品牌表在 `ftyp` box 内（box 尺寸不足 16 时不扫兼容表）。
 */
function isIsobmffAvif(v) {
  if (v.length < 12) return false
  if (!(v[4] === 0x66 && v[5] === 0x74 && v[6] === 0x79 && v[7] === 0x70)) return false /* 'ftyp' */
  const brandAt = (offset) => String.fromCharCode(v[offset], v[offset + 1], v[offset + 2], v[offset + 3])
  if (brandAt(8) === 'avif' || brandAt(8) === 'avis') return true
  const boxSize = ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0
  const end = Math.min(v.length, boxSize >= 16 ? boxSize : v.length)
  for (let offset = 16; offset + 3 < end; offset += 4) {
    const tag = brandAt(offset)
    if (tag === 'avif' || tag === 'avis') return true
  }
  return false
}

/**
 * 字节 → dataURL（**只用于运行时渲染**，落盘一律走二进制，见 §4.1.3 表下注）。
 *
 * `mime` **必传**（不再有 `'image/png'` 默认值 —— 那是「认不出也冒充 PNG」的源头之一）。
 * 传空 / 未传时**按字节魔数如实得出**（`sniffMime`）；仍认不出则用
 * `application/octet-stream`（**如实的「不是已知图片」**，绝不回落 `image/png`）。
 */
export function bytesToDataUrl(bytes, mime) {
  const view = toUint8Array(bytes)
  const actual = String(mime || '').trim().toLowerCase() || sniffMime(view) || 'application/octet-stream'
  return `data:${actual};base64,${encodeBase64(view)}`
}

/**
 * 按魔数嗅探 mime（用于补全 `kind` 之外的影像元数据）。
 * **认不出返回空串**（与 `sniffBytesMime` 同口径）—— 旧实现的 `return 'image/png'`
 * 会把任何垃圾字节说成 PNG，是「认不出也冒充图片」的源头。
 */
export function sniffMime(bytes) {
  return magicMime(toUint8Array(bytes))
}

function pngMetaFacts(v) {
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  let paletteEntries = 0
  let neutral = null
  let hasTrns = false
  let offset = 8
  while (offset + 8 <= v.length) {
    const len = view.getUint32(offset)
    const type = String.fromCharCode(v[offset + 4], v[offset + 5], v[offset + 6], v[offset + 7])
    if (type === 'IDAT' || type === 'IEND') break /* PLTE / tRNS 必在 IDAT 之前 */
    const dataAt = offset + 8
    const avail = Math.max(0, v.length - dataAt)
    if (type === 'PLTE') {
      const declared = Math.floor(len / 3)
      const usable = Math.min(declared, Math.floor(avail / 3))
      paletteEntries = declared
      if (declared === 0 || usable < declared) {
        neutral = null
      } else {
        neutral = true
        for (let i = 0; i < usable; i += 1) {
          const r = v[dataAt + i * 3]
          const g = v[dataAt + i * 3 + 1]
          const b = v[dataAt + i * 3 + 2]
          if (r !== g || g !== b) {
            neutral = false
            break
          }
        }
      }
    } else if (type === 'tRNS') {
      hasTrns = true
    }
    if (len > avail) break
    offset = dataAt + len + 4
  }
  return { paletteEntries, neutral, hasTrns }
}

/**
 * TIFF（**存储件容器**）→ 尺寸与取样事实（IFD 走查）。
 *
 * **为什么数据层也要能读 TIFF**：`magicMime` 早已把 TIFF 认成 `image/tiff`
 * （本仓自研编码器 `utils/tiff.js` 的存储件容器，K-P5b 起新写入行一律用它），
 * 但**尺寸解析此前缺失** ⇒ 新写入行的 `width` / `height` 落在 0（D2：
 * `.detail` 上传反馈自述「按字節解析實爲 0 × 0」，而存储件按 IFD 实为 360×360）。
 * 修法取「补 IFD 解析」而不是「写入时用编码器已知宽高」：真源必须是**字節**
 * —— 写入面之外还有多处消费同一函数（读时现判 `imageColorFacts`、实拍图
 * `uploadPhoto` 的尺寸回落、既有旧行迁移），只在写入面接一个「调用方声称值」
 * 通道会让「字節派生」这一类字段在其余入口仍是 0，且与本层「元数据一律由字節
 * 得出、不采信声称值」的口径相冲。
 *
 * 读法（TIFF 6.0）：魔数后偏移 4 ⇒ 第一个 IFD 偏移；IFD ＝ 2 字节项数 ＋ 每项
 * 12 字节（tag / type / count / value-or-offset，值 > 4 字节时后四字节是偏移）。
 * 取用的标签与 `utils/tiff.js::tiffFacts` **同一组**（256 宽 / 257 高 / 258 每样本
 * 位数 / 262 光度 / 277 每像素样本数 / 320 调色板）；数字层不 import `utils/**`
 * （层级纪律）⇒ 各持一份谓词、口径对齐，与 PNG / WebP / AVIF 的既有做法一致。
 *
 * **认不出就不猜**：无 IFD / 越界 / 宽高标签缺失 ⇒ 返回 `null`（调用方走既有
 * 兜底 `{0, 0}`，与「未解析出尺寸」如实同义）。`colorType` 恒 `null`
 * —— TIFF 没有 PNG 式的色彩类型编码，**不虚造数字**；TIFF 的可判色彩事实由
 * `colorMode`（光度 2 ⇒ RGB / 0·1 ⇒ GRAY）与 `bitDepth`（每样本位数）承载。
 */
function tiffMetaFacts(v) {
  const little = v[0] === 0x49
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  const u16 = (at) => (little ? view.getUint16(at, true) : view.getUint16(at, false))
  const u32 = (at) => (little ? view.getUint32(at, true) : view.getUint32(at, false))
  const ifdAt = u32(4)
  if (ifdAt + 2 > v.length) return null
  const entryCount = u16(ifdAt)
  const entries = {}
  for (let i = 0; i < entryCount; i += 1) {
    const at = ifdAt + 2 + i * 12
    if (at + 12 > v.length) break
    entries[u16(at)] = { type: u16(at + 2), count: u32(at + 4), at }
  }
  /* 逐值读出（内联 ≤ 4 字节 / 否则按偏移）；类型不认识或越界 ⇒ null（不猜）。 */
  const valuesOf = (tag) => {
    const entry = entries[tag]
    if (!entry) return null
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 6: 1, 7: 1, 8: 2, 9: 4 }
    const size = sizes[entry.type] || 0
    if (!size || entry.count === 0 || entry.count > 0x10000) return null
    const total = entry.count * size
    const base = total <= 4 ? entry.at + 8 : u32(entry.at + 8)
    const out = []
    for (let i = 0; i < entry.count; i += 1) {
      const pos = base + i * size
      if (pos + size > v.length) return null
      if (entry.type === 1 || entry.type === 6 || entry.type === 7) out.push(v[pos])
      else if (entry.type === 3 || entry.type === 8) out.push(u16(pos))
      else out.push(u32(pos))
    }
    return out
  }
  const width = valuesOf(256)
  const height = valuesOf(257)
  /* 宽高是**必填**：取不到 ⇒ 如实 null（不做任何估算）。 */
  if (!width || !height || !width[0] || !height[0]) return null
  const bits = valuesOf(258)
  const samples = valuesOf(277)
  const photometric = valuesOf(262)
  const colorMap = valuesOf(320)
  const samplesPerPixel = samples && samples.length ? samples[0] : 0
  const photo = photometric && photometric.length ? photometric[0] : null
  const gray = photo === 0 || photo === 1
  /* 每样本位数：各通道一致才可判（不一致 ⇒ null，不取首个凑数）。 */
  const bitDepth = bits && bits.length && bits.every((b) => b === bits[0]) ? bits[0] : null
  const paletteEntries = colorMap && colorMap.length >= 3 ? Math.floor(colorMap.length / 3) : 0
  return {
    width: width[0],
    height: height[0],
    colorMode: gray ? 'GRAY' : 'RGB',
    colorType: null,
    bitDepth,
    paletteEntries,
    paletteSize: paletteEntries,
    neutral: gray,
    alpha: samplesPerPixel === 4
  }
}

function imageSizeCore(bytes) {
  const v = toUint8Array(bytes)
  const fallback = { width: 0, height: 0, colorMode: 'RGB' }
  /* PNG：IHDR ＋ PLTE / tRNS 走查（索引色可判：调色板项数与无彩色） */
  if (v.length >= 33 && v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47) {
    const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    const bitDepth = v[24]
    const colorType = v[25]
    const facts = pngMetaFacts(v)
    /* 无彩色：0（灰阶）/ 4（灰阶+alpha）天生无彩色；3（索引色）由调色板逐项定；2 / 6 ⇒ 否。 */
    const neutral =
      colorType === 0 || colorType === 4 ? true : colorType === 3 ? facts.neutral : false
    const alpha =
      colorType === 4 || colorType === 6 ? true : colorType === 3 ? facts.hasTrns : false
    const colorMode = colorType === 0 || colorType === 4 ? 'GRAY' : colorType === 3 ? 'INDEXED' : 'RGB'
    return {
      width,
      height,
      colorMode,
      colorType,
      bitDepth,
      paletteEntries: facts.paletteEntries,
      paletteSize: facts.paletteEntries,
      neutral,
      alpha
    }
  }
  /* TIFF（**存储件容器**）→ IFD 取尺寸与取样事实（**K-P5b5（2026-09-23）｜D2 修**）。
     放在 PNG 之后：两族首字节不同（PNG 0x89 / TIFF 0x49·0x4d）⇒ 无判据交叉、既有分支零变化。
     认不出 ⇒ 落既有 fallback（`{width:0, height:0}` ＝ 如实「未解析出尺寸」）。 */
  if (v.length >= 8 &&
      ((v[0] === 0x49 && v[1] === 0x49 && v[2] === 0x2a && v[3] === 0x00) ||
       (v[0] === 0x4d && v[1] === 0x4d && v[2] === 0x00 && v[3] === 0x2a))) {
    const facts = tiffMetaFacts(v)
    if (facts) return facts
    return fallback
  }
  /* GIF：邏輯屏幕描述符（小端）＋ 全局色表（項數 / 無彩色）。`colorMode` 沿用既有 'RGB'（零變化）。 */
  if (v.length >= 10 && v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46) {
    const packed = v[10]
    const hasGct = (packed & 0x80) !== 0
    const entries = hasGct ? 2 << (packed & 0x07) : 0
    const tableAt = 13
    let neutral = null
    if (entries > 0 && v.length >= tableAt + entries * 3) {
      neutral = true
      for (let i = 0; i < entries; i += 1) {
        const r = v[tableAt + i * 3]
        const g = v[tableAt + i * 3 + 1]
        const b = v[tableAt + i * 3 + 2]
        if (r !== g || g !== b) {
          neutral = false
          break
        }
      }
    }
    return {
      width: v[6] | (v[7] << 8),
      height: v[8] | (v[9] << 8),
      colorMode: 'RGB',
      bitDepth: entries > 0 ? (packed & 0x07) + 1 : null,
      paletteEntries: entries,
      paletteSize: entries,
      neutral
    }
  }
  /* WebP：VP8 / VP8L / VP8X */
  if (v.length >= 30 && v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 && v[8] === 0x57) {
    const tag = String.fromCharCode(v[12], v[13], v[14], v[15])
    if (tag === 'VP8 ') {
      return {
        width: (v[26] | (v[27] << 8)) & 0x3fff,
        height: (v[28] | (v[29] << 8)) & 0x3fff,
        colorMode: 'RGB'
      }
    }
    if (tag === 'VP8L' && v.length >= 25) {
      const bits = v[21] | (v[22] << 8) | (v[23] << 16) | (v[24] << 24)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        colorMode: 'RGB'
      }
    }
    if (tag === 'VP8X' && v.length >= 30) {
      return {
        width: (v[24] | (v[25] << 8) | (v[26] << 16)) + 1,
        height: (v[27] | (v[28] << 8) | (v[29] << 16)) + 1,
        colorMode: 'RGB'
      }
    }
    return fallback
  }
  /* JPEG：扫 SOF 段 */
  if (v.length >= 4 && v[0] === 0xff && v[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < v.length) {
      if (v[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = v[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const segLen = (v[offset + 2] << 8) | v[offset + 3]
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = (v[offset + 5] << 8) | v[offset + 6]
        const width = (v[offset + 7] << 8) | v[offset + 8]
        const components = v[offset + 9]
        /* 1 分量 ⇒ 灰阶 JPEG（无彩色）。分量数由字节给出，非猜测。 */
        return { width, height, colorMode: components === 1 ? 'GRAY' : 'RGB', neutral: components === 1 }
      }
      if (segLen <= 0) break
      offset += 2 + segLen
    }
  }
  return fallback
}

export function imageSize(bytes) {
  const core = imageSizeCore(toUint8Array(bytes))
  return {
    colorType: null,
    bitDepth: null,
    paletteEntries: 0,
    paletteSize: 0,
    neutral: null,
    alpha: null,
    ...core
  }
}

export function normalizeImagePayload(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: false, message: '請選擇印面圖片' }
  }
  let bytes = null
  if (typeof input === 'string') {
    if (!input.startsWith('data:')) {
      return { ok: false, message: '印面圖片需爲文件內容（dataURL）或二進制' }
    }
    const parsed = dataUrlToBytes(input)
    if (!parsed.ok) return parsed
    bytes = parsed.bytes
  } else {
    bytes = toUint8Array(input)
  }
  if (!bytes || bytes.length === 0) return { ok: false, message: '印面圖片內容爲空，請重新選擇文件' }
  /* 字节魔数是唯一判据：dataURL 头里声明的 `image/xxx` 只是**声称值**，一律不采信。 */
  const mime = sniffMime(bytes)
  if (!mime) {
    return {
      ok: false,
      reason: 'UNRECOGNIZED_IMAGE',
      message: '這不是可識別的圖片內容（按字節魔數認不出 PNG / JPEG / GIF / WebP），已拒絕入庫；請重新選擇圖片文件'
    }
  }
  const size = imageSize(bytes)
  return {
    ok: true,
    bytes,
    mime,
    sha256: sha256Hex(bytes),
    bytesLength: bytes.length,
    width: size.width,
    height: size.height,
    colorMode: size.colorMode,
    /* **R-91**：色彩元数据的**可判字段**随载荷一并交出（同 `imageSize` 的统一形状）。
       索引色 PNG ⇒ `colorType=3` / `bitDepth` / `paletteEntries`（＝`paletteSize`）/ `neutral`，
       R-83 的「8 級灰 / 無彩色 / 位深 4」从此在数据面**有字段可判**（不再只能看 `colorMode='RGB'`）。 */
    colorType: size.colorType,
    bitDepth: size.bitDepth,
    paletteEntries: size.paletteEntries,
    paletteSize: size.paletteSize,
    neutral: size.neutral,
    alpha: size.alpha
  }
}
