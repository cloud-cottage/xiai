'use strict'
/**
 * 玺爱 · **纯 JS TIFF → PNG 转码器**（云函数侧；零新依赖：只用 node:zlib ＋ 自写 CRC32）
 * ----------------------------------------------------------------------------
 * 冻结口径（读面 ③「服务端转码」）：
 *   · **只解「单页 8bit Deflate RGB TIFF」这一类** —— 仓内 `src/utils/tiff.js::encodeTiff`
 *     产出的那类：`Compression=8`（zlib 流）、`BitsPerSample=[8,8,8]`、
 *     `PhotometricInterpretation=2`（RGB）、`SamplesPerPixel=3`、`PlanarConfiguration=1`
 *     （chunky）、**恰 1 个影像页**（IFD 链长 1）；strip 布局按标签**精确读取并自洽校验**；
 *   · **其余一切变体一律抛 `TIFF_UNSUPPORTED`**（结构化拒绝：不猜、不补、不回退、不降级 ——
 *     非 TIFF 魔数 / 多页 / 非 Deflate / 非 RGB / 非 8bit / planar=2 / strip 不自洽 / 尺寸越界）；
 *   · 输出 PNG：8bit 真彩（color type 2）、无隔行、单 IDAT、逐行 filter 0（None）、
 *     `zlib.deflateSync`（node 内建 ⇒ PNG 侧零手写压缩器）；
 *   · PNG chunk 的 CRC-32 自写（查表法，PNG 规范多项式 0xEDB88320）。TIFF 容器没有校验帧，
 *     CRC 只属于 PNG（与 `src/utils/tiff.js` 文件头同一条登记：不为凑「复用」塞规范里不存在的字段）。
 *
 * 防解压炸弹：像素总量按声明尺寸硬上限（`MAX_PIXEL_BYTES` / `MAX_SIDE`），超限即结构化拒绝；
 * 每条 strip 展开后的字节数必须与「该 strip 应含的行数 × 宽 × 3」**精确相等**。
 */

const zlib = require('node:zlib')

/** 结构化拒绝码（不支持 / 认不出的 TIFF 变体；调用方据 `error.code` 转冻结表对外 reason）。 */
const TIFF_UNSUPPORTED = 'TIFF_UNSUPPORTED'

/** 像素总量上限（本平台影像最长边 ≤ 2048 ⇒ 2048²×3 ≈ 12.6 MiB；上限给足余量）。 */
const MAX_PIXEL_BYTES = 48 * 1024 * 1024
const MAX_SIDE = 8192

/** 本转码器会读取的标签（其余标签跳过不读 —— 只证这一类，不做通用 TIFF 解析器）。 */
const REQUIRED_TAGS = Object.freeze([256, 257, 258, 259, 262, 273, 277, 278, 279, 284])

/** PNG 签名（8 字节，逐字规范值）。 */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function unsupportedError(message) {
  const error = new Error(message)
  error.code = TIFF_UNSUPPORTED
  return error
}

/** 是否为「不支持的 TIFF 变体」这一结构化拒绝（供调用方分流对外文案）。 */
function isTiffUnsupportedError(error) {
  return Boolean(error) && error.code === TIFF_UNSUPPORTED
}

/* ---------------------------------------------------------------------------
   TIFF 读侧（小端 / 大端都可；结构校验逐条可判）
   --------------------------------------------------------------------------- */

function makeReader(bytes) {
  const little = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a
  if (!little && !big) throw unsupportedError('TIFF 魔數不是 II*\\0 / MM\\0*')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    read16: (offset) => view.getUint16(offset, little),
    read32: (offset) => view.getUint32(offset, little)
  }
}

/**
 * 解析首个 IFD 的**本转码器所需标签**，并强校验「单页」（下一 IFD 指针必须为 0）。
 * 任一结构不满 ⇒ 抛 `TIFF_UNSUPPORTED`。
 */
function ifdValues(bytes, read16, read32) {
  const len = bytes.length
  const ifdOffset = read32(4)
  if (ifdOffset < 8 || ifdOffset + 2 > len) throw unsupportedError('TIFF IFD 定址越界')
  const count = read16(ifdOffset)
  const tableEnd = ifdOffset + 2 + count * 12
  if (count < 2 || count > 512 || tableEnd + 4 > len) throw unsupportedError('TIFF IFD 表長度不可辨')
  if (read32(tableEnd) !== 0) throw unsupportedError('TIFF 不是單頁（存在下一個影像頁）')
  const tags = new Map()
  for (let i = 0; i < count; i += 1) {
    const base = ifdOffset + 2 + i * 12
    const tag = read16(base)
    if (REQUIRED_TAGS.indexOf(tag) === -1) continue
    const type = read16(base + 2)
    const n = read32(base + 4)
    const unit = type === 3 ? 2 : type === 4 ? 4 : 0
    if (unit === 0) throw unsupportedError(`標籤 ${tag} 的欄位型別不被支持（type=${type}）`)
    const total = unit * n
    const values = []
    const inlineAt = base + 8
    const valueAt = total <= 4 ? inlineAt : read32(inlineAt)
    if (valueAt < 8 || valueAt + total > len) throw unsupportedError(`標籤 ${tag} 的值區越界`)
    for (let k = 0; k < n; k += 1) {
      values.push(unit === 2 ? read16(valueAt + k * 2) : read32(valueAt + k * 4))
    }
    tags.set(tag, values)
  }
  const missing = REQUIRED_TAGS.filter((tag) => !tags.has(tag))
  if (missing.length > 0) throw unsupportedError(`TIFF 缺少必需標籤：${missing.join(',')}`)
  return tags
}

/** 单一取值标签的形态校验（取值数恰 1 且为正整数）。 */
function singlePositive(tags, tag) {
  const values = tags.get(tag)
  if (values.length !== 1 || values[0] < 1) throw unsupportedError(`標籤 ${tag} 形態不符（期望單一正整數）`)
  return values[0]
}

/** 单一取值标签的值域校验（恰 1 值且逐字等于期望值）。 */
function expectFlag(tags, tag, expected, name) {
  const values = tags.get(tag)
  if (values.length !== 1 || values[0] !== expected) {
    throw unsupportedError(`${name} 必須是 ${expected}（收到 ${values.join(',')}）`)
  }
}

/**
 * 解出 **RGB 连续取样字节**（`width*height*3`；与 `src/utils/tiff.js::rgbaToRgbContinuous`
 * 的产物同形）—— 任何一步不满 ⇒ 抛 `TIFF_UNSUPPORTED`。
 */
function decodeTiffRgb(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (v.length < 8) throw unsupportedError('TIFF 位元組過短')
  const { read16, read32 } = makeReader(v)
  const tags = ifdValues(v, read16, read32)
  const width = singlePositive(tags, 256)
  const height = singlePositive(tags, 257)
  const bits = tags.get(258)
  if (bits.length !== 3 || bits.some((b) => b !== 8)) throw unsupportedError('BitsPerSample 必須是 [8,8,8]')
  expectFlag(tags, 259, 8, 'Compression（Deflate）')
  expectFlag(tags, 262, 2, 'PhotometricInterpretation（RGB）')
  expectFlag(tags, 277, 3, 'SamplesPerPixel（RGB 三取樣）')
  expectFlag(tags, 284, 1, 'PlanarConfiguration（chunky）')
  if (width > MAX_SIDE || height > MAX_SIDE || width * height * 3 > MAX_PIXEL_BYTES) {
    throw unsupportedError('尺寸超出本面支持的上限（防解压炸弹）')
  }
  const rowsPerStrip = singlePositive(tags, 278)
  const stripOffsets = tags.get(273)
  const stripCounts = tags.get(279)
  const stripTotal = Math.ceil(height / rowsPerStrip)
  if (stripOffsets.length !== stripTotal || stripCounts.length !== stripTotal) {
    throw unsupportedError('strip 組織與 RowsPerStrip 不自洽（Offset / ByteCounts 條數不符）')
  }
  const rgb = new Uint8Array(width * height * 3)
  let rowCursor = 0
  for (let i = 0; i < stripTotal; i += 1) {
    const offset = stripOffsets[i]
    const count = stripCounts[i]
    if (offset < 8 || count < 1 || offset + count > v.length) throw unsupportedError('strip 定址越界')
    const expectedRows = Math.min(rowsPerStrip, height - rowCursor)
    let plain = null
    try {
      plain = zlib.inflateSync(v.subarray(offset, offset + count))
    } catch {
      throw unsupportedError('Deflate 流無法展開（非 zlib 流或已損壞）')
    }
    if (plain.length !== expectedRows * width * 3) {
      throw unsupportedError('展開後的取樣數與該 strip 應含行數不符')
    }
    rgb.set(plain, rowCursor * width * 3)
    rowCursor += expectedRows
  }
  if (rowCursor !== height) throw unsupportedError('取樣總行數與影像高不符')
  return { rgb, width, height }
}

/* ---------------------------------------------------------------------------
   PNG 写侧（真彩 8bit ＋ 自写 CRC32 ＋ node:zlib deflate）
   --------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32（PNG 规范；对 chunk type ＋ data 计算）。 */
function crc32(parts) {
  let crc = 0xffffffff
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u32be(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, false)
  return out
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i)
  return out
}

/** PNG chunk ＝ 长度(4) ＋ 类型(4) ＋ 数据 ＋ CRC32(类型＋数据)(4)。 */
function chunkOf(type, data) {
  const typeBytes = asciiBytes(type)
  const body = new Uint8Array(12 + data.length)
  body.set(u32be(data.length), 0)
  body.set(typeBytes, 4)
  body.set(data, 8)
  body.set(u32be(crc32([typeBytes, data])), 8 + data.length)
  return body
}

function encodePngRgb(rgb, width, height) {
  const rowBytes = width * 3
  const raw = new Uint8Array(height * (1 + rowBytes))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + rowBytes)] = 0 // filter type：None（逐行；不做启发式 —— 正确性优先）
    raw.set(rgb.subarray(y * rowBytes, (y + 1) * rowBytes), y * (1 + rowBytes) + 1)
  }
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type：truecolor RGB（无 Alpha —— 源 TIFF 已是不透明 RGB 三取樣）
  ihdr[10] = 0 // compression：deflate
  ihdr[11] = 0 // filter：adaptive（逐行 byte 已定）
  ihdr[12] = 0 // interlace：none
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunkOf('IHDR', ihdr),
    chunkOf('IDAT', zlib.deflateSync(raw)),
    chunkOf('IEND', new Uint8Array(0))
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    png.set(part, at)
    at += part.length
  }
  return png
}

/**
 * **单页 8bit Deflate RGB TIFF ⇒ PNG**（冻结入口形态）。
 * @param {Uint8Array|Buffer} bytes 原图 TIFF 字节
 * @returns {Promise<{png:Uint8Array, width:number, height:number}>}
 * @throws {Error} `error.code === 'TIFF_UNSUPPORTED'`（不支持 / 认不出的变体；结构化拒绝）
 */
async function tiffToPng(bytes) {
  const { rgb, width, height } = decodeTiffRgb(bytes)
  const png = encodePngRgb(rgb, width, height)
  return { png, width, height }
}

module.exports = {
  tiffToPng,
  TIFF_UNSUPPORTED,
  isTiffUnsupportedError
}
