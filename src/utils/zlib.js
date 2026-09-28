/**
 * 玺爱 · **zlib 压缩簇**（浏览器端，零第三方依赖；**下层模块**，自己不 import 任何本仓模块）
 * ----------------------------------------------------------------------------
 * 为什么单独成模块（**K-P4aF 本轮收口**）：本簇原先在 `src/utils/image.js` 内，而
 * `src/utils/tiff.js` 为「复用同一件压缩实现」反向 import 它 ⇒ `image.js ↔ tiff.js`
 * **互相依赖**。补上 `image.js` 对 `tiff.js` 的具名 import 后，环的第二个进入顺序
 * （**先求值 `tiff.js`**：`tiff.js` → `image.js` → 回边跳过 → `image.js` 体内读
 * `TIFF_MIME`（此时 `tiff.js` 尚未求值完）⇒ `ReferenceError: Cannot access 'TIFF_MIME'
 * before initialization`）**实测复现**（`qa-recheck/kong-P4aF-20260923/evidence/cycle_probe.log`）。
 * 故把 zlib 簇下移到本模块，依赖方向变成单向：
 *   `image.js → tiff.js → zlib.js`、`image.js → zlib.js`（**无环**）。
 *
 * 口径不变：`zlibDeflate` 有 `CompressionStream('deflate')` 就用原生，否则退回**合法无压缩
 * deflate 块**并如实回报用的哪种（`compression ∈ 'deflate' | 'stored'`）。
 * `image.js` 仍以 `export { zlibDeflate } from './zlib.js'` **逐字转口**（对外导出名不变）。
 */

/** 无压缩 deflate 块（BTYPE=00）的辅助：大端 4 字节。 */
function be32(value) {
  const n = Number(value) >>> 0
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}


/** zlib 流尾校验（Adler-32）。 */
function adler32(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  let a = 1
  let b = 0
  for (let i = 0; i < v.length; i += 1) {
    a = (a + v[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}


function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  parts.forEach((part) => {
    out.set(part, offset)
    offset += part.length
  })
  return out
}


/** 无压缩 deflate 块（BTYPE=00）—— `CompressionStream` 不可用时的**保底**（仍是**合法 zlib**）。 */
function deflateStored(raw) {
  const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw || [])
  const parts = [new Uint8Array([0x78, 0x01])]
  const max = 65535
  if (src.length === 0) parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]))
  let offset = 0
  while (offset < src.length) {
    const end = Math.min(offset + max, src.length)
    const len = end - offset
    const final = end >= src.length ? 1 : 0
    parts.push(new Uint8Array([
      final,
      len & 0xff,
      (len >>> 8) & 0xff,
      ~len & 0xff,
      (~len >>> 8) & 0xff
    ]))
    parts.push(src.subarray(offset, end))
    offset = end
  }
  parts.push(be32(adler32(src)))
  return concatBytes(parts)
}


/**
 * zlib 压缩（有 `CompressionStream` 就用它；否则退回无压缩块，**如实回报用的哪种**）。
 *
 * **复用面**：`utils/tiff.js` 的 Deflate TIFF 编码器**逐字复用**本函数（同一件压缩实现，
 * 不得另写第二份）；返回值 `{bytes, compression}`，`compression` ∈ `deflate` / `stored`。
 */
export async function zlibDeflate(raw) {
  if (
    typeof CompressionStream === 'function' &&
    typeof Blob === 'function' &&
    typeof Response === 'function'
  ) {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
      if (bytes.length > 0) return { bytes, compression: 'deflate' }
    } catch {
      /* 落到无压缩块。 */
    }
  }
  return { bytes: deflateStored(raw), compression: 'stored' }
}
