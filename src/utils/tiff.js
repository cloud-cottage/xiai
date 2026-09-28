/**
 * 玺爱 · **单页 8bit Deflate TIFF 编码器**（浏览器端，零第三方依赖）
 * ----------------------------------------------------------------------------
 * 冻结容器口径（规范 §3.22.1 四条 ＋ §3.25.2「单页」一条 ＝ 五条；两类影像**同一套**）：
 *   ① 取样与位深：**RGB 8-bit 连续取样**（`BitsPerSample = [8,8,8]`、
 *      `PhotometricInterpretation = 2`、`PlanarConfiguration = 1`（chunky））；
 *   ② 压缩：**Deflate（`Compression = 8`，zlib 流）** —— 复用本仓 `utils/zlib.js`
 *      的 `zlibDeflate`（`CompressionStream('deflate')` 原生优先、合法无压缩 deflate 保底），
 *      **本模块不重写压缩**；（该簇原在 `utils/image.js`；K-P4aF 随「消环」下移到 `utils/zlib.js`
 *      —— 此前后者与 `tiff.js` 互为依赖，补 import 后实测第二个进入顺序会 TDZ。）
 *   ③ Alpha：**不透明则省 Alpha** ⇒ `SamplesPerPixel = 3`（本实现恒 3：入参为已绘制到画布的
 *      不透明位图，与「不透明则省 Alpha」同一条）；
 *   ④ 单页：**一个影像行恰 1 个图像页**；
 *   ⑤ 必需标签齐备：`ImageWidth` / `ImageLength` / `XResolution` / `YResolution` / `ResolutionUnit`
 *      ＋ strip 组织（`RowsPerStrip` / `StripOffsets` / `StripByteCounts`）。
 *
 * 为什么 TIFF 里**不**调 `crc32`：TIFF 容器（TIFF 6.0）没有校验帧 —— `crc32` 是 PNG chunk 的
 * 校验场，本容器无对应位（这与「复用既有压缩」不同：Deflate 是两容器共用的一件，逐字复用；
 * 校验算法在 TIFF 里没有落点）。故本模块**只**复用 `zlibDeflate`，并如实登记这一点，
 * 不为凑「复用」而给 TIFF 塞一个规范里不存在的校验字段。
 *
 * 字节布局（小端 `II`）：header(8) → IFD(2 + 14×12 + 4) → 附加区（2 字节对齐）→ 压缩像素数据。
 */

import { zlibDeflate } from './zlib.js'

/** TIFF 魔数（小端 `II*\0` / 大端 `MM\0*`；「图像编解码面」命名例外范围内）。 */
export const TIFF_MAGIC_LE = Object.freeze([0x49, 0x49, 0x2a, 0x00])
export const TIFF_MAGIC_BE = Object.freeze([0x4d, 0x4d, 0x00, 0x2a])

/** 存储容器 mime（单页 8bit Deflate TIFF；两类影像同值）。 */
export const TIFF_MIME = 'image/tiff'

/** 本编码器冻结的取值（逐条可机械判定；与规范 §3.22.1 四条一一对应）。 */
export const TIFF_LIMITS = Object.freeze({
  pages: 1,
  bitsPerSample: 8,
  samplesPerPixel: 3,
  photometricInterpretation: 2,
  planarConfiguration: 1,
  compression: 8,
  resolutionUnit: 2,
  xResolution: 72,
  yResolution: 72,
  /* 单条 strip（`RowsPerStrip` ＝ 整图高）：strip 数恰 1，Deflate 流恰 1 条。 */
  stripsPerImage: 1
})

/** 按字节判 TIFF 魔数（小端 / 大端两式；不采信任何声称值）。 */
export function isTiffBytes(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (v.length < 8) return false
  const le = TIFF_MAGIC_LE.every((byte, index) => v[index] === byte)
  const be = TIFF_MAGIC_BE.every((byte, index) => v[index] === byte)
  return le || be
}

function u16(value) {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value & 0xffff, true)
  return out
}

function u32(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  parts.forEach((part) => {
    out.set(part, offset)
    offset += part.length
  })
  return out
}

/** IFD 条目（`type`：SHORT ＝ 3 / LONG ＝ 4）。值 ≤ 4 字节内联，否则落在附加区。 */
function entry(tag, type, count, inlineBytes, extraOffset) {
  const valueBytes = inlineBytes || u32(extraOffset)
  const body = new Uint8Array(4)
  body.set(valueBytes.subarray(0, 4), 0)
  return concat([u16(tag), u16(type), u32(count), body])
}

/** RGBA（`ImageData.data` 形态）→ RGB 连续取样字节（丢弃 Alpha ⇒ `SamplesPerPixel = 3`）。 */
export function rgbaToRgbContinuous(rgba, width, height) {
  const w = Math.max(0, Math.round(Number(width) || 0))
  const h = Math.max(0, Math.round(Number(height) || 0))
  const src = rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba || [])
  const out = new Uint8Array(w * h * 3)
  for (let i = 0, o = 0; i < w * h; i += 1) {
    const p = i * 4
    out[o] = src[p]
    out[o + 1] = src[p + 1]
    out[o + 2] = src[p + 2]
    o += 3
  }
  return out
}

/**
 * 编出**单页 8bit Deflate TIFF**。
 * @param {{data:Uint8ClampedArray|Uint8Array|number[], width:number, height:number}} imageData
 *        RGBA 位图（`ImageData` 或其等价物；逐像素取 R/G/B，丢弃 Alpha）
 * @param {{xResolution?:number, yResolution?:number}} [options]
 * @returns {Promise<{ok:boolean, bytes:Uint8Array|null, mime:string, width:number, height:number,
 *          pages:number, bitsPerSample:number[], photometricInterpretation:number,
 *          samplesPerPixel:number, planarConfiguration:number, compression:number,
 *          rowsPerStrip:number, stripCount:number, stripByteCounts:number[],
 *          deflate:string, rawBytes:number, reason?:string, message:string}>}
 */
export async function encodeTiff(imageData, options = {}) {
  const meta = {
    ok: false,
    bytes: null,
    mime: TIFF_MIME,
    width: 0,
    height: 0,
    pages: TIFF_LIMITS.pages,
    bitsPerSample: [8, 8, 8],
    photometricInterpretation: TIFF_LIMITS.photometricInterpretation,
    samplesPerPixel: TIFF_LIMITS.samplesPerPixel,
    planarConfiguration: TIFF_LIMITS.planarConfiguration,
    compression: TIFF_LIMITS.compression,
    rowsPerStrip: 0,
    stripCount: 0,
    stripByteCounts: [],
    deflate: '',
    rawBytes: 0,
    reason: '',
    message: ''
  }
  const width = Math.max(0, Math.round(Number(imageData && imageData.width) || 0))
  const height = Math.max(0, Math.round(Number(imageData && imageData.height) || 0))
  if (!imageData || !imageData.data || width <= 0 || height <= 0) {
    return { ...meta, reason: 'EMPTY_CONTENT', message: 'TIFF 編碼失敗：位圖尺寸為空' }
  }
  const rgb = rgbaToRgbContinuous(imageData.data, width, height)
  if (rgb.length !== width * height * 3) {
    return { ...meta, reason: 'EMPTY_CONTENT', message: 'TIFF 編碼失敗：位圖樣本不足' }
  }

  /* 压缩：**复用**本仓既有 `zlibDeflate`（原生 `CompressionStream('deflate')` 优先）。 */
  const packed = await zlibDeflate(rgb)
  const strip = packed.bytes

  /* 目录与附加区的定址（先算偏移，才能把 StripOffsets 写进 IFD）。 */
  const entryCount = 14
  const ifdOffset = 8
  const ifdSize = 2 + entryCount * 12 + 4
  let cursor = ifdOffset + ifdSize
  const align = (offset) => (offset % 2 === 0 ? offset : offset + 1)

  cursor = align(cursor)
  const bitsOffset = cursor
  cursor += 6
  cursor = align(cursor)
  const sampleFormatOffset = cursor
  cursor += 6
  cursor = align(cursor)
  const xResOffset = cursor
  cursor += 8
  cursor = align(cursor)
  const yResOffset = cursor
  cursor += 8
  cursor = align(cursor)
  const dataOffset = cursor

  const xRes = Number.isFinite(Number(options.xResolution)) && Number(options.xResolution) > 0
    ? Math.round(Number(options.xResolution))
    : TIFF_LIMITS.xResolution
  const yRes = Number.isFinite(Number(options.yResolution)) && Number(options.yResolution) > 0
    ? Math.round(Number(options.yResolution))
    : TIFF_LIMITS.yResolution

  /* 标签按升序排列（TIFF 6.0 要求）。 */
  const entries = [
    entry(256, 4, 1, u32(width)), // ImageWidth
    entry(257, 4, 1, u32(height)), // ImageLength
    entry(258, 3, 3, null, bitsOffset), // BitsPerSample = [8,8,8]
    entry(259, 3, 1, u16(TIFF_LIMITS.compression)), // Compression = 8（Deflate / zlib 流）
    entry(262, 3, 1, u16(TIFF_LIMITS.photometricInterpretation)), // PhotometricInterpretation = 2（RGB）
    entry(273, 4, 1, u32(dataOffset)), // StripOffsets（LONG×1 ⇒ 值内联，**不**落附加区）
    entry(277, 3, 1, u16(TIFF_LIMITS.samplesPerPixel)), // SamplesPerPixel = 3（不透明則省 Alpha）
    entry(278, 4, 1, u32(height)), // RowsPerStrip = 整图高（strip 恰 1 条）
    entry(279, 4, 1, u32(strip.length)), // StripByteCounts（LONG×1 ⇒ 值内联，**不**落附加区）
    entry(282, 5, 1, null, xResOffset), // XResolution（RATIONAL）
    entry(283, 5, 1, null, yResOffset), // YResolution（RATIONAL）
    entry(284, 3, 1, u16(TIFF_LIMITS.planarConfiguration)), // PlanarConfiguration = 1（chunky）
    entry(296, 3, 1, u16(TIFF_LIMITS.resolutionUnit)), // ResolutionUnit = 2（英寸）
    entry(339, 3, 3, null, sampleFormatOffset) // SampleFormat = [1,1,1]（unsigned int）
  ]

  const ifd = concat([u16(entryCount), ...entries, u32(0)])
  const extras = concat([
    u16(8),
    u16(8),
    u16(8), // BitsPerSample
    u16(1),
    u16(1),
    u16(1), // SampleFormat
    u32(xRes),
    u32(1), // XResolution
    u32(yRes),
    u32(1) // YResolution
  ])

  const header = concat([u16(0x4949), u16(42), u32(ifdOffset)])
  const padBeforeData = new Uint8Array(Math.max(0, dataOffset - (ifdOffset + ifdSize + extras.length)))
  const bytes = concat([header, ifd, padBeforeData, extras, strip])

  return {
    ...meta,
    ok: true,
    bytes,
    width,
    height,
    rowsPerStrip: height,
    stripCount: 1,
    stripByteCounts: [strip.length],
    deflate: packed.compression,
    rawBytes: rgb.length,
    message:
      `單頁 8bit Deflate TIFF：${width}×${height}，Compression=8、BitsPerSample=[8,8,8]、` +
      `PhotometricInterpretation=2、SamplesPerPixel=3、PlanarConfiguration=1，` +
      `strip 恰 ${1} 條（RowsPerStrip=${height}），壓縮流 ${packed.compression}`
  }
}

/** 读回本编码器子集的标签（**自证**用：编号 / 尺寸 / 压缩 / 取样 / 位深 / 像素页数 / strip 组织）。 */
export function tiffFacts(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const out = {
    ok: false,
    magic: '',
    byteOrder: '',
    width: 0,
    height: 0,
    compression: 0,
    bitsPerSample: [],
    photometricInterpretation: 0,
    samplesPerPixel: 0,
    planarConfiguration: 0,
    resolutionUnit: 0,
    stripOffsets: [],
    stripByteCounts: [],
    rowsPerStrip: 0,
    imagePages: 0,
    tags: [],
    reason: '',
    message: ''
  }
  if (!isTiffBytes(v)) return { ...out, reason: 'NOT_TIFF', message: '字節魔數不是 TIFF' }
  const little = v[0] === 0x49 && v[1] === 0x49
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  const read16 = (offset) => view.getUint16(offset, little)
  const read32 = (offset) => view.getUint32(offset, little)
  const tags = {}
  let ifdOffset = read32(4)
  let pages = 0
  while (ifdOffset > 0 && ifdOffset + 2 <= v.length) {
    pages += 1
    const count = read16(ifdOffset)
    for (let i = 0; i < count; i += 1) {
      const base = ifdOffset + 2 + i * 12
      if (base + 12 > v.length) break
      const tag = read16(base)
      const type = read16(base + 2)
      const n = read32(base + 4)
      const byteLength = type === 3 ? 2 : 4
      const values = []
      const inline = byteLength * n <= 4
      const valueOffset = inline ? base + 8 : read32(base + 8)
      for (let k = 0; k < n; k += 1) {
        if (valueOffset + (k + 1) * byteLength > v.length) break
        values.push(type === 3 ? read16(valueOffset + k * 2) : read32(valueOffset + k * 4))
      }
      tags[tag] = type === 5 ? [read32(valueOffset)] : values
    }
    ifdOffset = read32(ifdOffset + 2 + count * 12)
  }
  return {
    ...out,
    ok: true,
    magic: little ? 'II*\\0' : 'MM\\0*',
    byteOrder: little ? 'little-endian' : 'big-endian',
    width: (tags[256] || [0])[0],
    height: (tags[257] || [0])[0],
    compression: (tags[259] || [0])[0],
    bitsPerSample: tags[258] || [],
    photometricInterpretation: (tags[262] || [0])[0],
    samplesPerPixel: (tags[277] || [0])[0],
    planarConfiguration: (tags[284] || [0])[0],
    resolutionUnit: (tags[296] || [0])[0],
    rowsPerStrip: (tags[278] || [0])[0],
    stripOffsets: tags[273] || [],
    stripByteCounts: tags[279] || [],
    imagePages: pages,
    tags: Object.keys(tags).map((key) => Number(key)).sort((a, b) => a - b),
    message: `TIFF（${little ? '小端' : '大端'}）：${(tags[256] || [0])[0]}×${(tags[257] || [0])[0]}，影像頁 ${pages}，壓縮 ${(tags[259] || [0])[0]}`,
    reason: ''
  }
}
