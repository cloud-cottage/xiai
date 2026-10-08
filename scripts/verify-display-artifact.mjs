/**
 * 玺爱 · **服务端展示件转码面自检**（读面 ③：TIFF→PNG 转码器 ＋ op `ensureDisplayArtifact` ＋
 * 客户端 best-effort 接线 ＋ 读面单点扩展）
 * ============================================================================
 * **本地、离线、零网络**（对象存储读/写、DB、云函数传输全部注入；跑的是**真实函数体与真实服务层代码**）。
 *
 * 跑什么：
 *   A. **转码器**（`cloudfunctions/xiai-user-token/lib/tiffToPng.js`）：仓内
 *      `src/utils/tiff.js::encodeTiff` 造夹具 ⇒ tiffToPng ⇒ PNG 签名/chunk 序列/CRC 逐个合法、
 *      IHDR 尺寸逐字一致、像素经 inflate 回读与源 RGBA 的 RGB 逐字节一致（**像素一致性证据**）；
 *      非 TIFF / 多页 / 非 Deflate / 非 RGB / 非 8bit / 截断 ⇒ `TIFF_UNSUPPORTED`（负对照 ≥ 3 例）。
 *   B. **op `ensureDisplayArtifact`**（用户令牌门）：注入缝 —— 键形态不符 ⇒ 拒且**不读**；
 *      读回失败 ⇒ 结构化；成功 ⇒ 上传缝收到的键恰为 `…/<sha>.png` 且字节与转码输出逐字一致；
 *      重复调用幂等；全程零 DB 写入。
 *   C. **读面单点**（`src/data/cloudbase.js::cloudBaseObjectKeyOf`）：`.tiff` 行＋sha ⇒ 派生
 *      `.png` 键；`.png` / `.webp` 行 ⇒ 逐字不变；无 sha ⇒ 现状（空串）。
 *   D. **客户端接线**（`src/services/imageAuthority.js`）：B 路 `registerArtifact` 成功后追加
 *      一次 best-effort 调用（快照结构化登记）；**失败隔离**（转码失败不改写入口回包形状）。
 *   E. **静态**：不新增 reason 字面值；op 本体无落盘计划；读面既有 pattern 未被改动。
 *
 * 纪律：不打印任何密钥 / 令牌原文；断言失败 ⇒ 退出码非 0。
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage 假体（让数据层 / 服务层在本机 Node 下跑起来）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: (key) => { memory.delete(key) },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

/* ---------------------------------------------------------------------------
   1. 断言与读数
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value).sort().reduce((acc, key) => { acc[key] = value[key]; return acc }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* ---------------------------------------------------------------------------
   2. 环境（密钥只从环境变量来；缺省 ⇒ 合成一次性假环境，绝不写进仓）
   --------------------------------------------------------------------------- */
const authModule = await import(path.join(ROOT, 'src/services/auth.js'))
const SMSCode = String(authModule.DEMO_SMS_CODE)
const PHONE = String(process.env.XIAI_USER_PHONE || '13800000002').trim()
process.env.XIAI_USER_SMS_CODE = SMSCode
process.env.XIAI_USER_TOKEN_SECRET = String(process.env.XIAI_USER_TOKEN_SECRET || randomBytes(32).toString('hex')).trim()
process.env.XIAI_USER_TOKEN_VERSION = process.env.XIAI_USER_TOKEN_VERSION || '1'
process.env.XIAI_USER_TOKEN_TTL_SECONDS = process.env.XIAI_USER_TOKEN_TTL_SECONDS || '900'

const FROZEN_REASONS = [
  'FORBIDDEN', 'INVALID_FIELD', 'INVALID_VALUE', 'MISSING_REQUIRED',
  'STORAGE_UNAVAILABLE', 'ALREADY_ENDORSED', 'DUPLICATE_VALUE'
]
const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const isDenial = (value) => value && value.ok === false && shapeOf(value) === 'message,ok,reason' && FROZEN_REASONS.indexOf(value.reason) !== -1
const sha256Of = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

/* ---------------------------------------------------------------------------
   3. 被测件装载（云函数本体 ＋ op 面 ＋ 转码器 ＋ 服务层 ＋ 读面单点）
   --------------------------------------------------------------------------- */
const fn = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'))
const ops = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'))
const codec = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/tiffToPng.js'))
const tiffUtils = await import(path.join(ROOT, 'src/utils/tiff.js'))
const cloudbase = await import(path.join(ROOT, 'src/data/cloudbase.js'))
const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
const imageAuthority = await import(path.join(ROOT, 'src/services/imageAuthority.js'))
const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))

/* 假 DB（本 op 必须一次都不碰 ⇒ 记调用数） */
let dbCalls = 0
ops.setOpsDbProvider(() => {
  dbCalls += 1
  return {
    collection() {
      dbCalls += 1
      return {
        where() {
          return {
            async get() { return { data: [] } },
            async update() { return { updated: 1 } }
          }
        },
        doc() {
          return {
            async set() {},
            async get() { return { data: [] } }
          }
        },
        async add() { return { id: 'x' } }
      }
    }
  }
})

/* 假对象存储：读缝（bucket）＋ 写缝（displayUploads） */
const bucket = new Map()
let bucketReads = 0
ops.setOpsStorageProvider(async (cloudPath) => {
  bucketReads += 1
  if (!bucket.has(cloudPath)) throw new Error('injected-object-missing')
  return bucket.get(cloudPath)
})
const displayUploads = []
ops.setOpsStorageUploadProvider(async ({ cloudPath, bytes }) => {
  displayUploads.push({ cloudPath, bytes: Buffer.from(bytes) })
})

/* 客户端：传输注入（直打真实函数体）＋ 直传注入 ＋ fetch 桩 */
let fnCalls = []
let transportMutate = null
userTokenSvc.setUserTokenTransport(async (name, data) => {
  fnCalls.push({ name, data })
  if (name !== 'xiai-user-token') return { ok: false, reason: 'FORBIDDEN', message: 'harness: wrong function' }
  const result = await fn.main(data)
  return { result: transportMutate ? transportMutate(result) : result }
})
imageAuthority.setArtifactStorageProvider(async ({ cloudPath, fileID, bytes }) => {
  if (!cloudPath || !fileID || !bytes) return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: 'harness: bad shape' }
  if (!bucket.has(cloudPath)) bucket.set(cloudPath, Buffer.from(bytes))
  return { ok: true, existedBefore: false }
})
globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }

writeFace.setWriteFaceModeOverride('cloud')
const login = await userTokenSvc.requestUserToken(PHONE, SMSCode)
check('Z0', 'harness：经真实函数体取得用户令牌', true, login.ok === true)
const issued = await fn.main({ action: 'issue', phone: PHONE, code: SMSCode })
const token = issued.token
const callOp = (op, payload) => fn.main({ action: 'verify', token, op, payload })

/* ---------------------------------------------------------------------------
   4. 夹具（仓内 encodeTiff 产出 ⇒ 天然可回环）
   --------------------------------------------------------------------------- */
function makeImageData(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      data[i] = (x * 37 + y * 11 + seed) & 255
      data[i + 1] = (x * 13 + y * 29 + seed * 3) & 255
      data[i + 2] = (x * 53 + y * 7 + seed * 5) & 255
      data[i + 3] = (x + y + seed) % 3 === 0 ? 255 : 0 /* 混合 255 / 0 alpha ⇒ 证明解码面只认 RGB */
    }
  }
  return { data, width, height }
}

/** **独立参照**：从夹具 RGBA 直接算期望 RGB（不复用仓内转换函数，避免自证）。 */
function expectedRgbOf(imageData) {
  const { data, width, height } = imageData
  const out = new Uint8Array(width * height * 3)
  for (let i = 0, o = 0; i < width * height; i += 1, o += 3) {
    out[o] = data[i * 4]
    out[o + 1] = data[i * 4 + 1]
    out[o + 2] = data[i * 4 + 2]
  }
  return out
}

const W = 7
const H = 5
const FIXTURE = makeImageData(W, H, 1)
const tiffMeta = await tiffUtils.encodeTiff(FIXTURE)
const TIFF = Buffer.from(tiffMeta.bytes)
const TIFF_DIGEST = sha256Of(TIFF)
const TIFF_KEY = imageAuthority.artifactObjectKeyOf(TIFF_DIGEST)
const DISPLAY_KEY = `xiai/images/${TIFF_DIGEST.slice(0, 2)}/${TIFF_DIGEST}.png`

/* ---------------------------------------------------------------------------
   A 段：转码器
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'A', title: '转码器 tiffToPng（纯 JS 零新依赖）' }))

check('A0', '夹具＝仓内 encodeTiff 产物（单页 8bit Deflate RGB TIFF）', true, tiffMeta.ok === true && tiffMeta.compression === 8 && tiffMeta.samplesPerPixel === 3 && tiffMeta.stripCount === 1)

const decoded = await codec.tiffToPng(TIFF)
const PNG = decoded.png
check('A1', 'tiffToPng ⇒ {png,width,height}，尺寸逐字一致', { width: W, height: H }, { width: decoded.width, height: decoded.height })

check('A2', 'PNG 签名（8 字节逐字）', true, PNG.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => PNG[i] === b))

/** PNG 规范 CRC-32（脚本侧独立实现，用于逐 chunk 校验）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  return table
})()
function pngCrc32(parts) {
  let crc = 0xffffffff
  for (const part of parts) for (let i = 0; i < part.length; i += 1) crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function parsePngChunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks = []
  let at = 8
  while (at < png.length) {
    const length = view.getUint32(at, false)
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7])
    const data = png.subarray(at + 8, at + 8 + length)
    const crc = view.getUint32(at + 8 + length, false)
    chunks.push({ type, data, crc, crcOk: pngCrc32([png.subarray(at + 4, at + 8), data]) === crc })
    at += 12 + length
  }
  return { chunks, consumedExactly: at === png.length }
}
const parsed = parsePngChunks(PNG)
check('A3', 'chunk 序列恰 [IHDR,IDAT,IEND] 且每片 CRC 合法、整件恰好消费完', true, parsed.consumedExactly && parsed.chunks.map((c) => c.type).join(',') === 'IHDR,IDAT,IEND' && parsed.chunks.every((c) => c.crcOk))

const ihdr = parsed.chunks[0].data
const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
check('A4', 'IHDR：宽高逐字一致、8bit 真彩（colorType 2）、无隔行', { width: W, height: H, bitDepth: 8, colorType: 2, compression: 0, filter: 0, interlace: 0 }, { width: ihdrView.getUint32(0, false), height: ihdrView.getUint32(4, false), bitDepth: ihdr[8], colorType: ihdr[9], compression: ihdr[10], filter: ihdr[11], interlace: ihdr[12] })

const rawPixels = inflateSync(parsed.chunks[1].data)
const rowBytes = W * 3
let filterOk = true
for (let y = 0; y < H; y += 1) if (rawPixels[y * (1 + rowBytes)] !== 0) filterOk = false
const actualRgb = new Uint8Array(H * rowBytes)
for (let y = 0; y < H; y += 1) actualRgb.set(rawPixels.subarray(y * (1 + rowBytes) + 1, (y + 1) * (1 + rowBytes)), y * rowBytes)
check('A5', '**像素一致性证据**：inflate 回读（长度 H·(1+W·3)、逐行 filter 0）与**独立参照 RGB** 逐字节一致', { length: H * (1 + rowBytes), filtersAllZero: filterOk, pixelsIdentical: true }, { length: rawPixels.length, filtersAllZero: filterOk, pixelsIdentical: Buffer.compare(Buffer.from(actualRgb), Buffer.from(expectedRgbOf(FIXTURE))) === 0 })

const viaRepoConverter = tiffUtils.rgbaToRgbContinuous(FIXTURE.data, W, H)
check('A6', '与仓内 rgbaToRgbContinuous 交叉一致（同一位图、两条算法路径）', true, Buffer.compare(Buffer.from(actualRgb), Buffer.from(viaRepoConverter)) === 0)

const decodedAgain = await codec.tiffToPng(TIFF)
check('A7', '确定性：同输入 ⇒ 输出逐字节一致（内容寻址幂等的基石）', true, Buffer.compare(Buffer.from(PNG), Buffer.from(decodedAgain.png)) === 0)

/* 负对照（≥3 例）：非 TIFF / 多页 / 非 Deflate / 非 RGB / 非 8bit / 截断 ⇒ TIFF_UNSUPPORTED */
function findTagEntry(bytes, tag) {
  const little = bytes[0] === 0x49
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const r16 = (o) => view.getUint16(o, little)
  const r32 = (o) => view.getUint32(o, little)
  const ifd = r32(4)
  const count = r16(ifd)
  for (let i = 0; i < count; i += 1) {
    const base = ifd + 2 + i * 12
    if (r16(base) === tag) return { base, ifd, count, type: r16(base + 2), n: r32(base + 4), valueAt: base + 8, nextIfdAt: ifd + 2 + count * 12 }
  }
  return null
}
function patchedTiff(mutate) {
  const copy = Buffer.from(TIFF)
  mutate(copy)
  return copy
}
const NEGATIVES = [
  ['N1', '非 TIFF（PNG 魔数）', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])],
  ['N2', '多页（下一 IFD 指针非 0）', patchedTiff((copy) => { const e = findTagEntry(copy, 256); copy.writeUInt32LE(200, e.nextIfdAt) })],
  ['N3', '非 Deflate（Compression=1）', patchedTiff((copy) => { const e = findTagEntry(copy, 259); copy.writeUInt16LE(1, e.valueAt) })],
  ['N4', '非 RGB（Photometric=0）', patchedTiff((copy) => { const e = findTagEntry(copy, 262); copy.writeUInt16LE(0, e.valueAt) })],
  ['N5', '非三取样（SamplesPerPixel=1，灰度）', patchedTiff((copy) => { const e = findTagEntry(copy, 277); copy.writeUInt16LE(1, e.valueAt) })],
  ['N6', '截断（strip 数据不完整）', TIFF.subarray(0, TIFF.length - 12)]
]
for (const [id, label, bytes] of NEGATIVES) {
  let thrown = null
  try { await codec.tiffToPng(bytes) } catch (error) { thrown = error }
  check(id, `负对照：${label} ⇒ 抛 TIFF_UNSUPPORTED（不猜不补）`, 'TIFF_UNSUPPORTED', thrown && thrown.code)
}

/* ---------------------------------------------------------------------------
   B 段：op ensureDisplayArtifact（用户令牌门；注入缝）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'B', title: 'op ensureDisplayArtifact（服务端转码＋上传展示件）' }))

bucket.set(TIFF_KEY, TIFF)
const OTHER_DIGEST = sha256Of(Buffer.from('ensure-display-other'))
const OTHER_KEY = imageAuthority.artifactObjectKeyOf(OTHER_DIGEST)

/* B1 键形态不符 ⇒ 拒且不读 */
const b1Before = bucketReads
const b1 = await callOp('ensureDisplayArtifact', { cloudPath: OTHER_KEY, sha256: TIFF_DIGEST })
check('B1', '路径摘要 ≠ 声称摘要 ⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(b1) && b1.reason === 'INVALID_VALUE')
check('B1b', '该形态**连对象都不读**（判定在读回之前）', 0, bucketReads - b1Before)

/* B2 键形态本身不符（.png 结尾 / 错误前缀）⇒ 拒且不读 */
const b2Before = bucketReads
const b2a = await callOp('ensureDisplayArtifact', { cloudPath: `xiai/images/${TIFF_DIGEST.slice(0, 2)}/${TIFF_DIGEST}.png`, sha256: TIFF_DIGEST })
const b2b = await callOp('ensureDisplayArtifact', { cloudPath: `other/${TIFF_DIGEST.slice(0, 2)}/${TIFF_DIGEST}.tiff`, sha256: TIFF_DIGEST })
check('B2', '键形态不符（.png / 错误前缀）⇒ INVALID_VALUE 且零读', true, isDenial(b2a) && b2a.reason === 'INVALID_VALUE' && isDenial(b2b) && b2b.reason === 'INVALID_VALUE' && bucketReads - b2Before === 0)

/* B3 未知键 / 身份类键 ⇒ INVALID_FIELD */
const b3 = await callOp('ensureDisplayArtifact', { cloudPath: TIFF_KEY, sha256: TIFF_DIGEST, userId: 'u-x' })
check('B3', '载荷含未知（身份类）键 ⇒ INVALID_FIELD ＋ 恰 3 键', true, isDenial(b3) && b3.reason === 'INVALID_FIELD')

/* B4 读回失败（对象不存在）⇒ STORAGE_UNAVAILABLE（不伪装 FORBIDDEN） */
const b4 = await callOp('ensureDisplayArtifact', { cloudPath: OTHER_KEY, sha256: OTHER_DIGEST })
check('B4', '对象不存在 ⇒ STORAGE_UNAVAILABLE（≠ FORBIDDEN）', true, isDenial(b4) && b4.reason === 'STORAGE_UNAVAILABLE')

/* B5 容器墨数不是 TIFF ⇒ INVALID_VALUE */
const NOT_TIFF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
const NOT_TIFF_KEY = imageAuthority.artifactObjectKeyOf(sha256Of(NOT_TIFF))
bucket.set(NOT_TIFF_KEY, NOT_TIFF)
const b5 = await callOp('ensureDisplayArtifact', { cloudPath: NOT_TIFF_KEY, sha256: sha256Of(NOT_TIFF) })
check('B5', '非 TIFF 容器 ⇒ INVALID_VALUE', true, isDenial(b5) && b5.reason === 'INVALID_VALUE')

/* B6 内容寻址完整性：键内摘要 ≠ 对象真身摘要 ⇒ 不转码（放第二份合法 TIFF 到别键的键名下） */
const FIXTURE2 = makeImageData(4, 3, 9)
const tiff2 = await tiffUtils.encodeTiff(FIXTURE2)
const TIFF2 = Buffer.from(tiff2.bytes)
bucket.set(OTHER_KEY, TIFF2)
const b6 = await callOp('ensureDisplayArtifact', { cloudPath: OTHER_KEY, sha256: OTHER_DIGEST })
check('B6', '对象真身摘要 ≠ 鍵內摘要 ⇒ INVALID_VALUE（不轉碼「內容與鍵不符」的對象）', true, isDenial(b6) && b6.reason === 'INVALID_VALUE')

/* B7 成功：转码＋上传展示件（键恰为 …/<sha>.png、字节与转码输出逐字一致） */
bucket.set(TIFF_KEY, TIFF)
const b7UploadsBefore = displayUploads.length
const b7 = await callOp('ensureDisplayArtifact', { cloudPath: TIFF_KEY, sha256: TIFF_DIGEST })
const b7direct = await ops.OPS.ensureDisplayArtifact({ cloudPath: TIFF_KEY, sha256: TIFF_DIGEST })
const expectedPng = (await codec.tiffToPng(TIFF)).png
check('B7', 'op 回包（brief 冻结形态：{ok,sha256,displayKey,bytesLength,width,height}）', { ok: true, sha256: TIFF_DIGEST, displayKey: DISPLAY_KEY, bytesLength: expectedPng.length, width: W, height: H }, { ok: b7direct.ok === true, sha256: b7direct.sha256, displayKey: b7direct.displayKey, bytesLength: b7direct.bytesLength, width: b7direct.width, height: b7direct.height })
check('B7b', '上传缝恰收 2 次（信封＋直调各 1）、键恰为 <sha>.png、字节与转码输出**逐字一致**', true, displayUploads.length - b7UploadsBefore === 2 && displayUploads.slice(b7UploadsBefore).every((item) => item.cloudPath === DISPLAY_KEY && Buffer.compare(item.bytes, Buffer.from(expectedPng)) === 0))
check('B7c', '分组视图 `display` 与扁平键同源同值（op 直接回包）', { sha256: TIFF_DIGEST, displayKey: DISPLAY_KEY, bytesLength: expectedPng.length, width: W, height: H }, b7direct.display)
check('B7d', '信封层 `display` 原样透传（index.js 登记面）', b7direct.display, b7.display)

/* B8 信封层透传（客户端实际走的那条） */
check('B8', '信封层 `display` 原样透传（＝ op 回包的分组视图）', b7.display, b7.display && (await callOp('ensureDisplayArtifact', { cloudPath: TIFF_KEY, sha256: TIFF_DIGEST })).display)

/* B9 幂等：重复调用安全（内容寻址 ⇒ 同键覆写同内容，不做存在性探测） */
const b9Before = displayUploads.length
const b9 = await callOp('ensureDisplayArtifact', { cloudPath: TIFF_KEY, sha256: TIFF_DIGEST })
check('B9', '重复调用 ⇒ 同一回包值（幂等）', { sha256: b7.sha256, displayKey: b7.displayKey, bytesLength: b7.bytesLength, width: b7.width, height: b7.height }, { sha256: b9.sha256, displayKey: b9.displayKey, bytesLength: b9.bytesLength, width: b9.width, height: b9.height })
check('B9b', '重复调用再次上传（同键同内容覆写；两次字节逐字一致）', true, displayUploads.length - b9Before === 1 && Buffer.compare(displayUploads[b9Before].bytes, displayUploads[b7UploadsBefore].bytes) === 0)

/* B10 不支持的 TIFF 变体在 op 内 ⇒ INVALID_VALUE（不新增 reason 字面值） */
const BAD_TIFF = patchedTiff((copy) => { const e = findTagEntry(copy, 259); copy.writeUInt16LE(1, e.valueAt) })
const BAD_KEY = imageAuthority.artifactObjectKeyOf(sha256Of(BAD_TIFF))
bucket.set(BAD_KEY, BAD_TIFF)
const b10 = await callOp('ensureDisplayArtifact', { cloudPath: BAD_KEY, sha256: sha256Of(BAD_TIFF) })
check('B10', '不支持变体（Compression=1）⇒ INVALID_VALUE ＋ 恰 3 键', true, isDenial(b10) && b10.reason === 'INVALID_VALUE')

/* B11 全程零 DB 写入；op 本体无落盘计划 */
check('B11', 'op 全程零 DB 调用（不产出 plan ⇒ index.js 落盘分支不触发）', 0, dbCalls)
check('B11b', '成功回包**无 `plan` 键**', false, Object.prototype.hasOwnProperty.call(b7, 'plan'))
check('B11c', 'op 直接调用键面 ＝ 冻结形态（扁平 ＋ display 分组）', 'bytesLength,display,displayKey,height,ok,op,sha256,width', shapeOf(await ops.OPS.ensureDisplayArtifact({ cloudPath: TIFF_KEY, sha256: TIFF_DIGEST })))

/* B12 回归：registerArtifact 的信封**不带** display 面（既有回包逐字不变） */
const regEnvelope = JSON.parse(JSON.stringify(await callOp('registerArtifact', { cloudPath: TIFF_KEY, sha256: TIFF_DIGEST, bytesLength: TIFF.length })))
check('B12', 'registerArtifact 信封：`artifact` 在、`display` 不在（JSON 序列化面）', true, Object.prototype.hasOwnProperty.call(regEnvelope, 'artifact') && !Object.prototype.hasOwnProperty.call(regEnvelope, 'display'))

/* ---------------------------------------------------------------------------
   C 段：读面单点（cloudBaseObjectKeyOf）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'C', title: '读面单点 cloudBaseObjectKeyOf（.tiff ⇒ 派生 .png 展示键）' }))

const PNG_DIGEST = sha256Of(Buffer.from('legacy-png-row'))
const PNG_KEY = `xiai/images/${PNG_DIGEST.slice(0, 2)}/${PNG_DIGEST}.png`
const WEBP_DIGEST = sha256Of(Buffer.from('legacy-webp-row'))
const WEBP_KEY = `xiai/images/${WEBP_DIGEST.slice(0, 2)}/${WEBP_DIGEST}.webp`

check('C1', '.tiff 行＋sha ⇒ 派生展示键 …/<sha>.png（逐字）', DISPLAY_KEY, cloudbase.cloudBaseObjectKeyOf({ storage: 'server', sha256: TIFF_DIGEST, storage_key: TIFF_KEY, mime: 'image/tiff' }))
check('C2', '.png 行 ⇒ 返回**逐字不变**的 storage_key', PNG_KEY, cloudbase.cloudBaseObjectKeyOf({ storage: 'server', sha256: PNG_DIGEST, storage_key: PNG_KEY, mime: 'image/png' }))
check('C3', '.webp 行 ⇒ 同上（现状不变）', WEBP_KEY, cloudbase.cloudBaseObjectKeyOf({ storage: 'server', sha256: WEBP_DIGEST, storage_key: WEBP_KEY, mime: 'image/webp' }))
check('C4', '.tiff 行**无 sha256**（旧行）⇒ 现状（空串＝显式结构化失败，不静默造键）', '', cloudbase.cloudBaseObjectKeyOf({ storage: 'server', storage_key: TIFF_KEY }))
check('C5', '.tiff 行键内摘要 ≠ 行内 sha256 ⇒ 空串（不猜不拼）', '', cloudbase.cloudBaseObjectKeyOf({ storage: 'server', sha256: OTHER_DIGEST, storage_key: TIFF_KEY, mime: 'image/tiff' }))
check('C6', '.tiff 行 storage ≠ server（存量守卫）⇒ 空串（不因本单改走云读）', '', cloudbase.cloudBaseObjectKeyOf({ storage: 'indexeddb', sha256: TIFF_DIGEST, storage_key: TIFF_KEY, mime: 'image/tiff' }))
check('C7', '.png 行键内摘要被篡改 ⇒ 空串（既有拒绝面不变）', '', cloudbase.cloudBaseObjectKeyOf({ storage: 'server', sha256: OTHER_DIGEST, storage_key: PNG_KEY, mime: 'image/png' }))

/* ---------------------------------------------------------------------------
   D 段：客户端接线（best-effort ＋ 失败隔离）
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'D', title: '客户端 B 路接线（registerArtifact 成功后追加 ensureDisplayArtifact）' }))

const resetClient = () => { fnCalls = []; transportMutate = null }

/* D1 B 路成功 ⇒ 追加一次转码（快照 ok；写入口回包形状**逐字不变**） */
resetClient()
const d1 = await imageAuthority.storeArtifactBytes(TIFF)
const d1Snapshot = imageAuthority.displayArtifactAttemptSnapshot()
check('D1', 'B 路成功 ⇒ storeArtifactBytes ok:true', true, d1.ok === true)
check('D1b', '写入口回包键集合**逐字不变**（既有 8 键）', 'bytesLength,idempotent,message,mime,ok,relPath,sha256,storageKey', shapeOf(d1))
check('D1c', 'best-effort 快照：outcome ok、op 名逐字、displayKey ＝ 内容寻址展示键（gate 未透傳 display 明細 ⇒ 就地派生）', { op: 'ensureDisplayArtifact', outcome: 'ok', ok: true, displayKey: DISPLAY_KEY }, { op: d1Snapshot.op, outcome: d1Snapshot.outcome, ok: d1Snapshot.ok, displayKey: d1Snapshot.displayKey })
check('D1d', 'best-effort 快照：尺寸／體量**如實記 0**（gate 白名單未透傳 display，不編造讀數）', { width: 0, height: 0, bytesLength: 0 }, { width: d1Snapshot.width, height: d1Snapshot.height, bytesLength: d1Snapshot.bytesLength })
check('D1e', '云函数恰 2 次调用：registerArtifact ＋ ensureDisplayArtifact（载荷封闭键面）', true, fnCalls.length === 2 && fnCalls[0].data.op === 'registerArtifact' && fnCalls[1].data.op === 'ensureDisplayArtifact' && shapeOf(fnCalls[1].data.payload) === 'cloudPath,sha256')

/* D2 失败隔离：display op 被服务端拒 ⇒ 写入口仍成功、只结构化登记 */
resetClient()
transportMutate = (result) => (result && result.op === 'ensureDisplayArtifact' ? { ok: false, reason: 'INVALID_VALUE', message: 'harness: display denied' } : result)
const d2 = await imageAuthority.storeArtifactBytes(TIFF)
const d2Snapshot = imageAuthority.displayArtifactAttemptSnapshot()
check('D2', 'display 被拒 ⇒ **写入口仍 ok:true**（失败隔离：不上抛、不阻断行写入）', true, d2.ok === true && shapeOf(d2) === 'bytesLength,idempotent,message,mime,ok,relPath,sha256,storageKey')
check('D2b', '该失败**只结构化登记**（outcome failed、reason 原样透传）', { outcome: 'failed', ok: false, reason: 'INVALID_VALUE' }, { outcome: d2Snapshot.outcome, ok: d2Snapshot.ok, reason: d2Snapshot.reason })

/* D3 失败隔离：display 调用遭遇**传输类失败**（STORAGE_UNAVAILABLE）⇒ 写入口仍成功、只登记 */
resetClient()
transportMutate = (result) => (result && result.op === 'ensureDisplayArtifact' ? { ok: false, reason: 'STORAGE_UNAVAILABLE', message: 'harness: transport down' } : result)
const d3 = await imageAuthority.storeArtifactBytes(TIFF)
const d3Snapshot = imageAuthority.displayArtifactAttemptSnapshot()
check('D3', 'display 传输类失败 ⇒ 写入口仍 ok:true ＋ 登记为 STORAGE_UNAVAILABLE（≠ FORBIDDEN）', true, d3.ok === true && shapeOf(d3) === 'bytesLength,idempotent,message,mime,ok,relPath,sha256,storageKey' && d3Snapshot.outcome === 'failed' && d3Snapshot.reason === 'STORAGE_UNAVAILABLE' && d3Snapshot.message === 'harness: transport down')

/* D4 dev / 離線形態：B 路本身不成立 ⇒ 不追加（快照保持上一次登记，不误报） */
resetClient()
writeFace.setWriteFaceModeOverride('local-dev')
const d4 = await imageAuthority.storeArtifactBytes(TIFF)
const d4Snapshot = imageAuthority.displayArtifactAttemptSnapshot()
check('D4', 'dev 形态 ⇒ B 路结构化失败（与既有口径一致），追加未发生', true, d4.ok === false && d4Snapshot.op === 'ensureDisplayArtifact')
writeFace.setWriteFaceModeOverride('cloud')

/* ---------------------------------------------------------------------------
   E 段：静态
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'E', title: '静态断言' }))

const fromReasonTable = Object.values(require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/config.js')).REASONS)
check('E1', 'REASONS ⊆ 既有冻结表（**新增 reason 字面值 0**）', [], fromReasonTable.filter((item) => FROZEN_REASONS.indexOf(item) === -1))

const opsSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/ops.js'), 'utf8')
const opStart = opsSource.indexOf('async ensureDisplayArtifact(')
const opBody = opStart >= 0 ? opsSource.slice(opStart, opsSource.indexOf('\n  }\n})', opStart)) : ''
check('E2', 'op 本体：无落盘计划（`plan:` 0）＆ 走 readArtifactBytes ＋ tiffToPng ＋ uploadDisplayArtifactBytes', [false, true, true, true], [opBody.includes('plan:'), opBody.includes('readArtifactBytes'), opBody.includes('tiffToPng'), opBody.includes('uploadDisplayArtifactBytes')])

const cbSource = readFileSync(path.join(ROOT, 'src/data/cloudbase.js'), 'utf8')
check('E3', '读面：既有 IMAGE_OBJECT_KEY_PATTERN（png|webp）未被改动 ＋ 新增源件 pattern 在场', true, /IMAGE_OBJECT_KEY_PATTERN = \/\^xiai\\\/images\\\/\(\[0-9a-f\]\{2\}\)\\\/\(\[0-9a-f\]\{64\}\)\\\.\(png\|webp\)\$\//.test(cbSource) && cbSource.includes('IMAGE_SOURCE_TIFF_KEY_PATTERN'))

const iaSource = readFileSync(path.join(ROOT, 'src/services/imageAuthority.js'), 'utf8')
const ixSource = readFileSync(path.join(ROOT, 'cloudfunctions/xiai-user-token/index.js'), 'utf8')
check('E4', '接线面：imageAuthority 追加一次 best-effort 调用 ＆ index.js 信封登记 `display`', true, iaSource.includes('await ensureDisplayArtifactBestEffort(cloudPath, serverDigest)') && ixSource.includes('display: opResult.display'))

/* ---------------------------------------------------------------------------
   5. 汇总
   --------------------------------------------------------------------------- */
const summary = { total: results.length, passed: results.length - failures, failed: failures }
console.log(JSON.stringify({ summary, failed_ids: results.filter((item) => !item.pass).map((item) => item.id), wire_calls: fnCalls.length, display_uploads: displayUploads.length }))
if (failures > 0) process.exitCode = 1
