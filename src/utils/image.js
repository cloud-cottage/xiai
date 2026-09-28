/**
 * 玺爱 · 浏览器端影像处理（**展示面 ＝ 有损 WebP 0.92** ／ **存储面 ＝ 单页 8bit Deflate TIFF**）
 * ----------------------------------------------------------------------------
 * 两层分区（本模块只做**纯计算**，不碰 `localStorage` / IndexedDB）：
 *   - **展示容器**（预览 / 展示 / 缩略图 / 另存）＝ 有损 WebP、质量 `IMAGE_LIMITS.quality`（0.92）；
 *   - **存储容器**（两类影像 face / scene 一律）＝ 单页 8bit Deflate TIFF —— 编码器在
 *     `src/utils/tiff.js`（**恰 1 处定义点**），本模块只做「裁方形 → 降采样 → 交给它编码」
 *     （`exportStoredTiff`），压缩逐字复用本模块的 `zlibDeflate`。
 * 输入 / 产物两套上限**不得混用**（见 `IMAGE_LIMITS`）；判据一律按**字节魔数**（`sniffBytesMime`）。
 * **切割 / 拼接真源 ＝ TileSplicer 内核**（R-98）：本模块只**转调**（`pixelRectsOf` / `seamOf` /
 * `placementsOf`），不自持第二套实现；`windowsToPixelRects` / `rectSeamReport` /
 * `renderSliceTiles` / `composeSliceTiles` 的**导出名与签名逐字不变**（`services/**` 依赖）。
 */
/**
 * 冻结上限口径：输入 1 MB（**文件字节**）／最长边 2048px／**展示**输出 WebP 质量 0.92
 * （§3.22.5 / §3.25.4：展示 / 预览 / 缩略图 / 另存面 ＝ 有损 WebP 0.92；取值 0.85 ⇒ 0.92）。
 *
 * ⚠️ **两套上限，不得混用**（2026-09-20 修正的缺陷根因）：
 *   - `maxInputBytes`（1 MB）**只**约束「用户选的原始文件字节」，判在 `loadImageFile`，语义不得改；
 *   - `maxStoredBytes`（4 MiB）是**产物侧**的独立上限，判在「处理后的二进制」，
 *     **不许**再拿 1 MB 去闸自家产出的影像（旧实现就是拿它闸产物 ⇒ 回退 PNG 2.7 MB 被自家闸拒，
 *     还甩出误导文案「照片过大…请换一张更小的图」，而用户根本没传大图）。
 *   - 产物超 `maxStoredBytes` 时**先有界降质重编**（最多 `maxReencodeRounds` 轮），压不进才拒。
 */

/* 跨层依赖（**具名 import，逐条有使用点**；本模块此前整文件零 import，
   正文里的自由标识符在运行时会抛 `ReferenceError` —— 那是 P0 缺陷，本单修）：
   - `../tilesplicer/index.js`：切割 / 拼接内核的**导出面**（`index.js` 只转口 `core.js`
     的实现；`core.js` 的依赖链止于 `data/seed.js` / `data/assetmeta.js`，两者**零 import**
     ⇒ 本 import 不引入任何环）；
   - `./tiff.js`：存储容器（单页 8bit Deflate TIFF）的**唯一口径定义点**；`tiff.js` 反向
     import 本模块的 `zlibDeflate` 复用压缩实现 ⇒ 两模块构成**环**，环的安全性本单**实测**
     （见 `qa-recheck/kong-P4aF-20260923/REPORT.md` §2：ESM 在实例化期即初始化函数声明，
     `zlibDeflate` 对 `tiff.js` 恒可用）。 */
import { pixelRectsOf, seamOf, placementsOf } from '../tilesplicer/index.js'
import { TIFF_MIME, isTiffBytes, encodeTiff, tiffFacts } from './tiff.js'

export const IMAGE_LIMITS = Object.freeze({
  /* ① 输入侧：原始文件字节上限（1 MB）。 */
  maxInputBytes: 1048576,
  /* ② 产物侧：入库二进制上限。
     定值理由（本单实测）：正常路径产物是 WebP（实测 3000×1200 → 1200×1200 = 14.6 KB；
     2600×2600 → 2048×2048 = 36.6 KB），1 MB 富余得多；但**浏览器编不出 WebP 时**回退 PNG，
     2048×2048 实拍感图**两次实测**为 2,832,092 / 2,855,176 字节（2.70–2.72 MiB）
     ⇒ 上限必须**大于这一个真实产物**，否则等于「拿输入闸拒自家产物」；
     4 MiB 给实测回退产物留约 40% 余量，同时是输入上限的 4 倍、单行入库体量仍可控。 */
  maxStoredBytes: 4 * 1024 * 1024,
  /* ③ 有界降质重编的**硬上界**（轮数）：不许无限重试。每轮 = 最长边 ÷2（下限 reencodeSideFloor）
     + quality −0.2（下限 reencodeQualityFloor）。 */
  maxReencodeRounds: 3,
  reencodeSideFloor: 256,
  reencodeQualityFloor: 0.3,
  maxSide: 2048,
  /* 展示输出质量（**唯一一处定义点**；R-137：0.85 ⇒ 0.92，键名与机制不变）。 */
  quality: 0.92
})


/** 产物侧上限的具名常量（服务层按**同源**常量兜底，禁止各写一份魔数）。 */
export const STORED_MAX_BYTES = IMAGE_LIMITS.maxStoredBytes


/** 方形框最小边长（防手抖拖成 0 像素）。 */
export const MIN_CROP_SIDE = 16


/**
 * **展示容器**常量（预览 / 展示 / 缩略图 / 另存面）：有损 WebP、质量 0.92。
 * 与下面的**存储容器**常量**分开命名** —— 一个名字只指一种容器，不得互相借用。
 */
export const DISPLAY_MIME = 'image/webp'


/**
 * **存储容器**常量（两类影像 face / scene **一律**）：单页 8bit Deflate TIFF。
 * **本处是真别名**（R-… 本轮收口）：值**不在此处再写一遍** —— 容器口径的定义点**恰 1 处**
 * ＝ `utils/tiff.js::TIFF_MIME`，本模块只 `import` 后改名转口（对外导出名 `STORAGE_MIME`
 * 逐字不变，`services/**` 依赖）。
 */
export const STORAGE_MIME = TIFF_MIME


/** 可读体量文案（在模块内自带一份，避免 utils 之间互相依赖）。 */
export function describeBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}


/**
 * 读 `tokens.css` 的**画布令牌**（canvas 的 `fillStyle` / `strokeStyle` 不能直接写 `var()`，
 * 只能在运行时取计算值）—— AC-26「色值唯一来源」在 canvas 侧的落法。
 *
 * **无保底形态**（2026-09-20 收口）：本函数**不再接受字面保底色**。六个 `--canvas-*` 槽位
 * 已在 `tokens.css` 的 `:root` 定义（三主题共用），读得到是**契约**；读不到 ⇒ 返回空串并
 * 只告警一次（`console.warn`），**绝不静默填色** —— 静默回退会把「token 契约被破坏」藏起来，
 * 且字面回落值本身会再次构成「组件内字面色值」（AC-26）。
 * @param {string} name 形如 `--canvas-grid`
 * @returns {string} 计算值；取不到时为空串 `''`
 */
const warnedCanvasTokens = new Set()


export function canvasToken(name) {
  const missing = (why) => {
    /* 同一个令牌只告警一次（避免每帧重绘都刷屏），但**每次**都不给任何色值。 */
    if (!warnedCanvasTokens.has(name)) {
      warnedCanvasTokens.add(name)
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(
          `[canvas] 令牌 ${name} 讀不到（${why}）—— tokens.css 契約缺失，本次不給色值、不做靜默回退`
        )
      }
    }
    return ''
  }
  try {
    if (typeof document === 'undefined' || !document.documentElement) return missing('無 document')
    if (typeof getComputedStyle !== 'function') return missing('無 getComputedStyle')
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
    const value = String(raw || '').trim()
    return value || missing('計算值爲空')
  } catch (err) {
    return missing('讀取異常')
  }
}


/* ---------------------------------------------------------------------------
   ① 输入校验
   --------------------------------------------------------------------------- */

function pickSize(file) {
  const size = Number(file && file.size)
  return Number.isFinite(size) && size >= 0 ? size : -1
}


/**
 * 按**文件字节**判上限（＝需求「1MB 以内」的唯一判据）。
 *
 * reason（§3.12.10(c) 冻结字面值）：**输入侧超限 ⇒ `TOO_LARGE`**（仅输入侧用，与产物侧
 * `ARTIFACT_TOO_LARGE` 不得互相复用）；空内容 ⇒ `EMPTY_CONTENT`（空内容与认不出是两回事）。
 * @returns {{ok:boolean, reason:string, message:string}}
 */
export function assertWithinInputLimit(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '圖片內容爲空，請重新選擇文件' }
  }
  if (size > IMAGE_LIMITS.maxInputBytes) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      message:
        `照片過大：所選文件 ${describeBytes(size)}，上限 ${describeBytes(IMAGE_LIMITS.maxInputBytes)}（1 MB）。` +
        '請換一張更小的圖，或先用手機/系統自帶的壓縮再上傳。'
    }
  }
  return { ok: true, reason: '', message: '' }
}


/* ---------------------------------------------------------------------------
   ② 解码（createImageBitmap 优先，退回 <img>）
   --------------------------------------------------------------------------- */

async function decodeViaImageBitmap(blob) {
  if (typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    /* 老浏览器不认 options ⇒ 再试一次不带参数的形式。 */
  }
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}


function decodeViaImageElement(blob) {
  return new Promise((resolve) => {
    if (typeof Image !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      resolve(null)
      return
    }
    const url = URL.createObjectURL(blob)
    const image = new Image()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* 忽略：释放失败不影响结果。 */
      }
      resolve(value)
    }
    image.onload = () => finish(image)
    image.onerror = () => finish(null)
    image.src = url
  })
}


/**
 * 解码用户选择的图片文件，并在此完成 **1 MB 上限** 与 **类型** 校验。
 *
 * `reason` 的取值（§3.12.10(c) 冻结表；**本函数属输入侧**，对外 reason 与文案同源）：
 *   - `TOO_LARGE`   —— **输入侧超限**（原始文件字节 > 1 MB；**仅**输入侧用）
 *   - `EMPTY_CONTENT` —— 载荷为空（0 字节）
 *   - `NOT_IMAGE`   —— 不是可用的图片内容（类型不对 / 认不出 / 解码失败 / 宽高读不到）；
 *                      取**服务层对外**的冻结字面值（数据层认不出的 `UNRECOGNIZED_IMAGE`
 *                      是字节写入口的字面值，两层不得互相冒充）
 *   - `MISSING_REQUIRED` —— 未提供文件
 * @param {File|Blob} file
 * @returns {Promise<{ok:boolean, bitmap:ImageBitmap|HTMLImageElement|null, width:number, height:number, originalBytes:number, originalMime:string, reason:string, message:string}>}
 */
export async function loadImageFile(file) {
  const out = {
    ok: false,
    bitmap: null,
    width: 0,
    height: 0,
    originalBytes: 0,
    originalMime: '',
    reason: '',
    message: ''
  }
  if (!file || typeof file !== 'object') {
    return { ...out, reason: 'MISSING_REQUIRED', message: '請選擇圖片文件' }
  }

  const declaredMime = String(file.type || '').trim().toLowerCase()
  out.originalMime = declaredMime

  let size = pickSize(file)
  if (size < 0) {
    /* 非 Blob 形态（无 size）⇒ 以真实字节数补齐。 */
    try {
      if (typeof file.arrayBuffer === 'function') size = (await file.arrayBuffer()).byteLength
    } catch {
      size = -1
    }
  }
  out.originalBytes = size > 0 ? size : 0

  if (declaredMime && !declaredMime.startsWith('image/')) {
    return { ...out, reason: 'NOT_IMAGE', message: `這不是圖片文件（類型 ${declaredMime}），請選擇 JPG / PNG / WebP 圖片` }
  }
  if (!declaredMime) {
    return { ...out, reason: 'NOT_IMAGE', message: '無法識別文件類型，請選擇 JPG / PNG / WebP 圖片' }
  }
  const limit = assertWithinInputLimit(size)
  if (!limit.ok) return { ...out, reason: limit.reason, message: limit.message }

  let bitmap = await decodeViaImageBitmap(file)
  if (!bitmap) bitmap = await decodeViaImageElement(file)
  if (!bitmap) {
    return { ...out, reason: 'NOT_IMAGE', message: '圖片解碼失敗（文件可能已損壞或不是可用的圖片），請換一張再試' }
  }

  const width = Math.round(Number(bitmap.width) || 0)
  const height = Math.round(Number(bitmap.height) || 0)
  if (width <= 0 || height <= 0) {
    return { ...out, reason: 'NOT_IMAGE', message: '圖片尺寸無效（讀不到寬高），請換一張再試' }
  }
  return { ...out, ok: true, bitmap, width, height }
}


/**
 * Blob / `ArrayBuffer` / `data:` URL / 已是可绘制源 → **可绘制源**（`createImageBitmap` 优先，
 * 退回 `<img>`）。**不发起任何网络请求**（`data:` URL 也只在本地解成字节再解图）。
 *
 * 用途（R-88）：把「库里取回的二进制 / dataURL」变成可再加工的源（切片、双色调导出），
 * ⇒ 展示侧不必各自写一遍解码逻辑。
 * @returns {Promise<ImageBitmap|HTMLImageElement|HTMLCanvasElement|null>} 解不出 ⇒ `null`
 */
export async function decodeImageInput(input) {
  if (!input) return null
  const asBlob = (bytes, mime) => new Blob([bytes], { type: mime || 'application/octet-stream' })
  if (typeof Blob !== 'function') return null
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    return (await decodeViaImageBitmap(asBlob(bytes))) || (await decodeViaImageElement(asBlob(bytes)))
  }
  if (typeof input === 'string') {
    if (!input.startsWith('data:')) return null
    const parsed = dataUrlToBytes(input)
    if (!parsed || !parsed.bytes || parsed.bytes.length === 0) return null
    const blob = asBlob(parsed.bytes, parsed.mime)
    return (await decodeViaImageBitmap(blob)) || (await decodeViaImageElement(blob))
  }
  if (typeof input === 'object' && typeof input.arrayBuffer === 'function') {
    return (await decodeViaImageBitmap(input)) || (await decodeViaImageElement(input))
  }
  /* 已经是可绘制源（ImageBitmap / HTMLImageElement / canvas）。 */
  return typeof input === 'object' && Number(input.width) > 0 && Number(input.height) > 0 ? input : null
}


/* ---------------------------------------------------------------------------
   ③④ 方形化 → 降采样 → 编码
   --------------------------------------------------------------------------- */

/** 取「可被 `drawImage` 绘制」的源，并拿到它自己的像素尺寸（兼容 ImageBitmap / <img> / <canvas>）。 */
function resolveSource(bitmap) {
  if (!bitmap) return null
  const width = Math.round(Number(bitmap.width) || 0)
  const height = Math.round(Number(bitmap.height) || 0)
  if (width <= 0 || height <= 0) return null
  return { draw: bitmap, width, height }
}


/** 中心最大正方形（边长＝短边）＝需求默认口径。 */
export function centerSquareCrop(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const side = Math.min(w, h)
  return { cx: Math.round((w - side) / 2), cy: Math.round((h - side) / 2), side }
}


/** 归一外部传入的 `crop`：夹在图像范围内、保持正方形、边长不小于 `MIN_CROP_SIDE`。 */
export function normalizeCrop(crop, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  if (!crop || typeof crop !== 'object') return centerSquareCrop(w, h)
  const maxSide = Math.min(w, h)
  let side = Math.round(Number(crop.side))
  if (!Number.isFinite(side) || side <= 0) return centerSquareCrop(w, h)
  side = Math.min(Math.max(side, Math.min(MIN_CROP_SIDE, maxSide)), maxSide)
  let cx = Math.round(Number(crop.cx))
  let cy = Math.round(Number(crop.cy))
  if (!Number.isFinite(cx)) cx = (w - side) / 2
  if (!Number.isFinite(cy)) cy = (h - side) / 2
  cx = Math.min(Math.max(cx, 0), w - side)
  cy = Math.min(Math.max(cy, 0), h - side)
  return { cx, cy, side }
}


function createCanvas(width, height) {
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  return null
}


/** `canvas` → `Blob`（`toBlob` 优先，`convertToBlob` 兜底；**不检查类型**，实际类型由返回值如实反映）。 */
function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      try {
        canvas.toBlob((blob) => resolve(blob || null), mime, quality)
        return
      } catch {
        /* 落到下面的 toDataURL 兜底。 */
      }
    }
    if (typeof canvas.convertToBlob === 'function') {
      Promise.resolve(canvas.convertToBlob({ type: mime, quality })).then(
        (blob) => resolve(blob || null),
        () => resolve(null)
      )
      return
    }
    resolve(null)
  })
}


function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(',')
  if (comma < 0) return null
  const head = String(dataUrl).slice(5, comma)
  const mime = (head.split(';')[0] || '').trim().toLowerCase()
  if (!/;base64/i.test(head)) return null
  try {
    const binary = atob(String(dataUrl).slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff
    return { bytes, mime }
  } catch {
    return null
  }
}


/**
 * 按**字节魔数**判 mime（如实口径的第一真源：不信任 `blob.type` 的声称值）。
 *
 * **R-86（2026-09-21｜本单新增 AVIF，四条既有谓词逐字未动）**：另认 **AVIF**
 * （ISO-BMFF 容器：`....ftyp` ＋ 主品牌 / 兼容品牌含 `avif` / `avis`）。这是**在原来返回空串
 * 的位置上多认一个真实存在的图片容器**（AVIF 不在场 ⇒ 仍返回空串，既有判据不变）。
 *
 * ⚠️ **对齐说明（登记为规范缺口）**：数据层 `assetmeta.js::magicMime` 的「逐条谓词对齐」版本
 * 尚未同步 AVIF ⇒ 走**数据层**写入口（`insertImageRow` / `replaceFaceImage`）的 AVIF 仍会被
 * 判 `UNRECOGNIZED_IMAGE`；实拍图路径（`services/photos.js`）走本函数，认得出 AVIF。
 * @returns {string} 识别不出时返回空串。
 */
export function sniffBytesMime(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  /* ① TIFF 魔数：小端 `II*\0`（49 49 2A 00）/ 大端 `MM\0*`（4D 4D 00 2A）—— 存储容器。
     判在 PNG 之前无冲突（两族首字节不同：0x49/0x4d vs 0x89）。 */
  if (v.length >= 4 && isTiffBytes(v)) return TIFF_MIME
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
 * 单次「裁方形 → 降采样 → 编码」。返回 `{bytes, mime, claimed, width, height}` 或 `{error}`。
 * **不判上限**（上限口径由 `exportSquareImage` 的有界重编循环统一负责）。
 *
 * `targetMime` 默认 `DISPLAY_MIME`（**展示容器**＝有损 WebP 0.92）；**存储容器**（单页 8bit
 * Deflate TIFF）走 `exportStoredTiff`（另一条入口，不复用本函数的画布编码目标 —— 容器不同）。
 * 返回值**多带一个 `claimed`**（浏览器 `blob.type` 的声称值）—— 供上游在如实回退时并列展示。
 */
async function encodeSquareOnce(source, crop, target, quality, targetMime = DISPLAY_MIME) {
  const canvas = createCanvas(target, target)
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { error: '當前環境不支持瀏覽器端圖片處理（畫布不可用）' }
  }
  const context = canvas.getContext('2d')
  if (!context) return { error: '當前環境不支持瀏覽器端圖片處理（畫布不可用）' }

  try {
    context.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high'
    context.drawImage(source.draw, crop.cx, crop.cy, crop.side, crop.side, 0, 0, target, target)
  } catch (err) {
    return { error: `圖片裁剪失敗：${(err && err.message) || '未知原因'}` }
  }

  const blob = await canvasToBlob(canvas, targetMime, quality)
  let bytes = null
  let claimed = ''
  if (blob) {
    try {
      bytes = new Uint8Array(await blob.arrayBuffer())
      claimed = String(blob.type || '').toLowerCase()
    } catch (err) {
      return { error: `圖片編碼結果讀取失敗：${(err && err.message) || '未知原因'}` }
    }
  } else if (typeof canvas.toDataURL === 'function') {
    /* `toBlob` 不可用时的最后一条路：dataURL → 字节（失败即如实报错，不冒充）。 */
    let fallback = null
    try {
      fallback = dataUrlToBytes(canvas.toDataURL(targetMime, quality))
    } catch {
      fallback = null
    }
    if (fallback && fallback.bytes && fallback.bytes.length > 0) {
      bytes = fallback.bytes
      claimed = fallback.mime
    }
  }
  if (!bytes || bytes.length === 0) {
    return { error: '圖片編碼失敗（瀏覽器未能生成圖片數據），請換一張再試' }
  }
  /* 如实口径：**先认字节魔数**；认不出才退回浏览器声称的类型；都没有则给中性类型。 */
  const mime = sniffBytesMime(bytes) || claimed || 'application/octet-stream'
  return { bytes, mime, claimed, width: target, height: target }
}


/**
 * 把「用户拖拽/缩放后的方形框」裁出来 → 降采样 → 编码。
 *
 * **产物侧口径（本单修正）**：产物体量判的是 `options.maxBytes`（默认 `IMAGE_LIMITS.maxStoredBytes`，
 * **与 1 MB 输入上限无关**）。超限时**先有界降质重编**（≤ `IMAGE_LIMITS.maxReencodeRounds` 轮，
 * 每轮最长边 ÷2 且 quality −0.2），压进上限就照常入库；**用满硬上界仍压不进才拒**，
 * 且文案是「本机影像生成失败」，**不再甩「照片过大…请换一张更小的图」**（那是输入侧的话）。
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap `loadImageFile` 的返回值（或任何可绘制源）
 * @param {{crop?:{cx:number,cy:number,side:number}, maxSide?:number, quality?:number, maxBytes?:number}} options
 *        `crop` 为**原图像素坐标**的方形框；省略 ⇒ 中心最大正方形。`maxBytes` 为产物侧上限（测试可注入）。
 * @returns {Promise<{ok:boolean, bytes:Uint8Array|null, mime:string, width:number, height:number, message:string,
 *                    reason?:string, initialBytes?:number, reencodeRounds?:number, maxBytes?:number}>}
 */
export async function exportSquareImage(bitmap, options = {}) {
  const out = {
    ok: false,
    bytes: null,
    mime: '',
    width: 0,
    height: 0,
    message: '',
    reason: '',
    initialBytes: 0,
    reencodeRounds: 0,
    maxBytes: IMAGE_LIMITS.maxStoredBytes
  }
  const source = resolveSource(bitmap)
  if (!source) return { ...out, message: '圖片尚未就緒，請重新選擇文件' }

  const maxSideRaw = Number(options.maxSide)
  const maxSide = Number.isFinite(maxSideRaw) && maxSideRaw > 0 ? Math.round(maxSideRaw) : IMAGE_LIMITS.maxSide
  const qualityRaw = Number(options.quality)
  const quality = Number.isFinite(qualityRaw) && qualityRaw > 0 && qualityRaw <= 1 ? qualityRaw : IMAGE_LIMITS.quality
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.round(maxBytesRaw) : IMAGE_LIMITS.maxStoredBytes

  const crop = normalizeCrop(options.crop, source.width, source.height)
  const baseTarget = Math.max(1, Math.min(crop.side, maxSide))

  /* 第 0 轮：基准质量与最长边。 */
  let best = await encodeSquareOnce(source, crop, baseTarget, quality)
  if (best.error) return { ...out, maxBytes, message: best.error }
  const initialBytes = best.bytes.length
  let rounds = 0

  /* 有界降质重编：轮数是**硬上界**，每轮同时降最长边（÷2）与质量（−0.2），取更小者。 */
  while (best.bytes.length > maxBytes && rounds < IMAGE_LIMITS.maxReencodeRounds) {
    rounds += 1
    const nextSide = Math.max(
      Math.min(IMAGE_LIMITS.reencodeSideFloor, baseTarget),
      Math.round(baseTarget / Math.pow(2, rounds))
    )
    const nextQuality = Math.max(IMAGE_LIMITS.reencodeQualityFloor, Number((quality - 0.2 * rounds).toFixed(3)))
    const next = await encodeSquareOnce(source, crop, Math.max(1, Math.min(nextSide, baseTarget)), nextQuality)
    if (next.error) break
    if (next.bytes.length < best.bytes.length) best = next
  }

  const reencodedNote = rounds > 0
    ? `產物超過入庫上限 ${describeBytes(maxBytes)}，已自動降質重編 ${rounds} 輪：${describeBytes(initialBytes)} → ${describeBytes(best.bytes.length)}`
    : ''

  /* 用满硬上界仍压不进上限 **才** 拒 —— 文案必须与「你选的图太大」分开。 */
  if (best.bytes.length > maxBytes) {
    return {
      ...out,
      reason: 'ARTIFACT_TOO_LARGE',
      mime: best.mime,
      width: best.width,
      height: best.height,
      initialBytes,
      reencodeRounds: rounds,
      maxBytes,
      message:
        `本機影像生成失敗：已自動降質重編 ${rounds} 輪，產出仍有 ${describeBytes(best.bytes.length)}，` +
        `超過入庫上限 ${describeBytes(maxBytes)}。這與「所選文件 ≤ 1 MB」的輸入上限是兩回事；` +
        '請重試，或改用支持 WebP 編碼的瀏覽器後再上傳。'
    }
  }

  const fallbackNote = best.mime !== DISPLAY_MIME
    ? `當前瀏覽器未能編碼 ${DISPLAY_MIME}，已按實際格式 ${best.mime} 入庫`
    : ''
  return {
    ok: true,
    bytes: best.bytes,
    mime: best.mime,
    width: best.width,
    height: best.height,
    initialBytes,
    reencodeRounds: rounds,
    maxBytes,
    message: [fallbackNote, reencodedNote].filter(Boolean).join('；')
  }
}


/**
 * 探测当前浏览器能否真正编码 WebP（用于上传前给用户提示；**不影响**入库时的如实口径）。
 * @returns {Promise<boolean>}
 */
export async function canEncodeWebp() {
  const canvas = createCanvas(2, 2)
  if (!canvas || typeof canvas.getContext !== 'function') return false
  const context = canvas.getContext('2d')
  if (!context) return false
  context.fillStyle = canvasToken('--canvas-ink')
  context.fillRect(0, 0, 2, 2)
  const blob = await canvasToBlob(canvas, DISPLAY_MIME, IMAGE_LIMITS.quality)
  if (!blob) return false
  const claimed = String(blob.type || '').toLowerCase()
  if (claimed === DISPLAY_MIME) return true
  try {
    return sniffBytesMime(new Uint8Array(await blob.arrayBuffer())) === DISPLAY_MIME
  } catch {
    return false
  }
}


/* ============================================================================
   ② AVIF 编码尝试与如实回退（预览输出 webp）
   ============================================================================ */

/** ISO-BMFF 容器 → 是否 AVIF（`ftyp` 主品牌 / 兼容品牌含 `avif` / `avis`）。 */
export function isIsobmffAvif(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (v.length < 12) return false
  if (!(v[4] === 0x66 && v[5] === 0x74 && v[6] === 0x79 && v[7] === 0x70)) return false /* 'ftyp' */
  const brandAt = (offset) => String.fromCharCode(v[offset], v[offset + 1], v[offset + 2], v[offset + 3])
  if (brandAt(8) === 'avif' || brandAt(8) === 'avis') return true
  const boxSize = readBe32(v, 0)
  const end = Math.min(v.length, boxSize >= 16 ? boxSize : v.length)
  for (let offset = 16; offset + 3 < end; offset += 4) {
    const tag = brandAt(offset)
    if (tag === 'avif' || tag === 'avis') return true
  }
  return false
}


const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()


/** CRC-32（IEEE，PNG 每个 chunk 的校验场）。 */
export function crc32(bytes) {
  const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  let crc = 0xffffffff
  for (let i = 0; i < v.length; i += 1) crc = CRC_TABLE[(crc ^ v[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}


/* `adler32` / `be32` / `concatBytes` / `deflateStored` / `zlibDeflate` 这一簇已下移到
   `./zlib.js`（**下层模块**，零本仓依赖 ⇒ 消掉 `image.js ↔ tiff.js` 的环；见彼处文件头注释）。 */


function readBe32(v, offset) {
  return ((v[offset] << 24) | (v[offset + 1] << 16) | (v[offset + 2] << 8) | v[offset + 3]) >>> 0
}


/* zlib 压缩簇已在 `./zlib.js`（下层模块）；本模块**逐字转口**该导出名，对外面不变。 */
export { zlibDeflate } from './zlib.js'


/* ============================================================================
   ③ 切割窗口消费（几何由**数据层**派生；本模块只做「归一化 → 设备像素」同一数取整）
   ============================================================================ */

/**
 * **数据层归一化窗口 → 设备像素矩形**（纯函数）。
 * 实现真源＝**TileSplicer 内核**（`src/tilesplicer/core.js::pixelRectsOf`）：本函数**只转调**，
 * **不自写切位**（切位来自数据层 `data/db.js::sliceWindowsOf` 的产物）。
 *
 * 无缝口径（R-87）：**所有块共用同一份取整后的边界数** —— 先收集全部唯一边界值 → 升序 →
 * 逐值取整（严格递增、每段 ≥ 1px、末值 ＝ 边长）⇒ 并集**必等于**整图、两两**必不重叠**。
 * @returns {{ok:boolean, rects:Array<object>, xEdges:number[], yEdges:number[], width:number, height:number, reason?:string, message:string}}
 */
export function windowsToPixelRects(windows, width, height) {
  return pixelRectsOf(windows, width, height)
}


/**
 * **无缝性机械读数**（纯函数，供展示层 / 取证复用）—— 实现真源＝**TileSplicer 内核**
 * （`src/tilesplicer/core.js::seamOf`）：本函数**只转调**。
 *   - `areaEqualsSource`：块面积之和 **恰等于** 源面积（叠盖会偏大、留缝会偏小）；
 *   - `noOverlap`：两两块矩形交集面积之和为 0；
 *   - `edgesAdjacent`：任一非整图边界既是「某块的右/下边」也是「某块的左/上边」；
 *   - `seamless`：三者同时成立。
 */
export function rectSeamReport(rects, width, height) {
  return seamOf(rects, width, height)
}


/**
 * 按数据层窗口**逐块裁剪**为独立画布（展示层拼接用；**不编码**，编码由调用方决定）。
 * 落位几何（窗口 → 设备像素矩形、无缝读数）一律来自 **TileSplicer 内核**；
 * 本函数只保留**渲染本职**（建画布 / `drawImage` / 可选编码）。
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 * @param {Array<object>} windows `data/db.js::sliceWindowsOf(meta)` 的产物
 * @param {{encodeMime?:string, quality?:number}} [options] 给了 `encodeMime` 则逐块编码并给出 `bytes`
 */
export async function renderSliceTiles(bitmap, windows, options = {}) {
  const source = resolveSource(bitmap)
  if (!source) return { ok: false, tiles: [], rects: [], report: null, message: '圖片尚未就緒，請重新選擇文件' }
  const converted = pixelRectsOf(windows, source.width, source.height)
  if (!converted.ok) return { ok: false, tiles: [], rects: converted.rects, report: null, reason: converted.reason, message: converted.message }
  const tiles = []
  for (const rect of converted.rects) {
    const canvas = createCanvas(rect.width, rect.height)
    const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context) return { ok: false, tiles: [], rects: converted.rects, report: null, message: '當前環境不支持瀏覽器端圖片處理（畫布不可用）' }
    context.imageSmoothingEnabled = false
    context.drawImage(source.draw, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
    const tile = { ...rect, canvas }
    if (options.encodeMime) {
      const blob = await canvasToBlob(canvas, String(options.encodeMime), options.quality)
      if (blob) {
        try {
          tile.bytes = new Uint8Array(await blob.arrayBuffer())
          tile.mime = sniffBytesMime(tile.bytes) || String(blob.type || '').toLowerCase()
        } catch {
          tile.bytes = null
        }
      }
    }
    tiles.push(tile)
  }
  const report = seamOf(converted.rects, source.width, source.height)
  return {
    ok: true,
    tiles,
    rects: converted.rects,
    report,
    reason: '',
    message: `${tiles.length} 塊已裁剪；無縫校驗：面積相等 ${report.areaEqualsSource ? '是' : '否'}、兩兩不交 ${report.noOverlap ? '是' : '否'}、邊界相接 ${report.edgesAdjacent ? '是' : '否'}`
  }
}


/**
 * 把逐块画布**按原坐标拼回**一张整图画布（拼接自证 / 导出用）。
 * 落位几何（逐块 `x/y/width/height`）来自 **TileSplicer 内核的 `placementsOf`**；
 * 本函数只保留**拼接本职**（建画布 / `drawImage`），**不在渲染模块自算座标**。
 */
export function composeSliceTiles(tiles, width, height) {
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)
  const list = Array.isArray(tiles) ? tiles : []
  if (w <= 0 || h <= 0 || list.length === 0) return null
  const canvas = createCanvas(w, h)
  const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  if (!context) return null
  context.imageSmoothingEnabled = false
  placementsOf(list).forEach((placement) => {
    context.drawImage(placement.canvas, placement.x, placement.y, placement.width, placement.height)
  })
  return canvas
}

/* ============================================================================
   **存储产物（本单新增）：单页 8bit Deflate TIFF**
   ----------------------------------------------------------------------------
   两类影像（face / scene）**同一条入口、同一套容器口径**（§3.22.1 四条 ＋ §3.25.2「单页」）；
   裁剪 / 降采样与展示面共用同一套纯计算（`normalizeCrop` / `resolveSource` / `createCanvas`）；
   产物超入库上限时**按最长边有界降采样重编**（Deflate 无损 ⇒ 调质量无意义，只缩尺寸；
   轮数沿用 `IMAGE_LIMITS.maxReencodeRounds` 这一硬上界）。
   ============================================================================ */

/**
 * 把浏览器端可绘制源编成**存储产物**：单页 8bit Deflate TIFF（RGB 连续取样 / Compression=8）。
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap `loadImageFile` 的返回值（或任何可绘制源）
 * @param {{crop?:{cx:number,cy:number,side:number}, maxSide?:number, maxBytes?:number, xResolution?:number, yResolution?:number}} [options]
 * @returns {Promise<{ok:boolean, bytes:Uint8Array|null, mime:string, width:number, height:number,
 *          pages:number, compression:number, bitsPerSample:number[], photometricInterpretation:number,
 *          samplesPerPixel:number, planarConfiguration:number, rowsPerStrip:number, stripCount:number,
 *          stripByteCounts:number[], deflate:string, rawBytes:number, initialBytes:number,
 *          reencodeRounds:number, maxBytes:number, tiff:object|null, reason?:string, message:string}>}
 */
export async function exportStoredTiff(bitmap, options = {}) {
  const out = {
    ok: false,
    bytes: null,
    mime: STORAGE_MIME,
    width: 0,
    height: 0,
    pages: 1,
    compression: 8,
    bitsPerSample: [8, 8, 8],
    photometricInterpretation: 2,
    samplesPerPixel: 3,
    planarConfiguration: 1,
    rowsPerStrip: 0,
    stripCount: 0,
    stripByteCounts: [],
    deflate: '',
    rawBytes: 0,
    initialBytes: 0,
    reencodeRounds: 0,
    maxBytes: IMAGE_LIMITS.maxStoredBytes,
    tiff: null,
    reason: '',
    message: ''
  }
  const source = resolveSource(bitmap)
  if (!source) return { ...out, reason: 'EMPTY_CONTENT', message: '圖片尚未就緒，請重新選擇文件' }

  const maxSideRaw = Number(options.maxSide)
  const maxSide = Number.isFinite(maxSideRaw) && maxSideRaw > 0 ? Math.round(maxSideRaw) : IMAGE_LIMITS.maxSide
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.round(maxBytesRaw) : IMAGE_LIMITS.maxStoredBytes
  const crop = normalizeCrop(options.crop, source.width, source.height)
  const baseTarget = Math.max(1, Math.min(crop.side, maxSide))

  let side = baseTarget
  let encoded = null
  let rounds = 0
  for (;;) {
    const canvas = createCanvas(side, side)
    const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context) return { ...out, maxBytes, message: '當前環境不支持瀏覽器端圖片處理（畫布不可用）' }
    try {
      context.imageSmoothingEnabled = true
      if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high'
      context.drawImage(source.draw, crop.cx, crop.cy, crop.side, crop.side, 0, 0, side, side)
    } catch (err) {
      return { ...out, maxBytes, message: `圖片繪製失敗：${(err && err.message) || '未知原因'}` }
    }
    let pixels = null
    try {
      pixels = context.getImageData(0, 0, side, side)
    } catch {
      pixels = null
    }
    if (!pixels) return { ...out, maxBytes, message: '當前環境不支持瀏覽器端像素讀取（畫布不可用）' }
    const attempt = await encodeTiff({ data: pixels.data, width: side, height: side }, {
      xResolution: options.xResolution,
      yResolution: options.yResolution
    })
    if (!attempt.ok) {
      return { ...out, maxBytes, reason: attempt.reason || 'ENCODE_FAILED', message: attempt.message }
    }
    encoded = attempt
    if (rounds === 0) out.initialBytes = attempt.bytes.length
    if (attempt.bytes.length <= maxBytes) break
    if (rounds >= IMAGE_LIMITS.maxReencodeRounds) {
      return {
        ...out,
        maxBytes,
        reencodeRounds: rounds,
        reason: 'ARTIFACT_TOO_LARGE',
        message:
          `本機影像生成失敗：存儲件（單頁 8bit Deflate TIFF）${describeBytes(attempt.bytes.length)} ` +
          `超過入庫上限 ${describeBytes(maxBytes)}。這與「所選文件 ≤ 1 MB」的輸入上限是兩回事。`
      }
    }
    rounds += 1
    side = Math.max(1, Math.min(side - 1, Math.max(IMAGE_LIMITS.reencodeSideFloor, Math.round(side / 2))))
  }

  /* mime 一律按**字节魔数**复核（不采信自称值）；自证标签后才交付。 */
  const mime = sniffBytesMime(encoded.bytes)
  if (mime !== STORAGE_MIME) {
    return {
      ...out,
      maxBytes,
      reason: 'SELFCHECK_FAILED',
      message: `存儲件自檢未通過：產物字節魔數爲 ${mime || '認不出'}（期望 ${STORAGE_MIME}），已拒絕交付`
    }
  }
  const facts = tiffFacts(encoded.bytes)
  if (
    !facts.ok ||
    facts.imagePages !== 1 ||
    facts.compression !== 8 ||
    facts.photometricInterpretation !== 2 ||
    facts.samplesPerPixel !== 3 ||
    facts.planarConfiguration !== 1 ||
    facts.bitsPerSample.join(',') !== '8,8,8'
  ) {
    return {
      ...out,
      maxBytes,
      tiff: facts,
      reason: 'SELFCHECK_FAILED',
      message:
        '存儲件自檢未通過（期望單頁 / Compression=8 / BitsPerSample=[8,8,8] / ' +
        `PhotometricInterpretation=2 / SamplesPerPixel=3 / PlanarConfiguration=1；實測 ` +
        `${facts.imagePages} 頁 / ${facts.compression} / [${facts.bitsPerSample.join(',')}] / ` +
        `${facts.photometricInterpretation} / ${facts.samplesPerPixel} / ${facts.planarConfiguration}）`
    }
  }
  return {
    ...out,
    ok: true,
    bytes: encoded.bytes,
    mime,
    width: facts.width,
    height: facts.height,
    pages: facts.imagePages,
    compression: facts.compression,
    bitsPerSample: facts.bitsPerSample,
    photometricInterpretation: facts.photometricInterpretation,
    samplesPerPixel: facts.samplesPerPixel,
    planarConfiguration: facts.planarConfiguration,
    rowsPerStrip: facts.rowsPerStrip,
    stripCount: facts.stripByteCounts.length,
    stripByteCounts: facts.stripByteCounts,
    deflate: encoded.deflate,
    rawBytes: encoded.rawBytes,
    tiff: facts,
    message:
      `存儲件（單頁 8bit Deflate TIFF）：${facts.width}×${facts.height}，Compression=8、` +
      `BitsPerSample=[${facts.bitsPerSample.join(',')}]、PhotometricInterpretation=${facts.photometricInterpretation}、` +
      `SamplesPerPixel=${facts.samplesPerPixel}、影像頁 ${facts.imagePages}、strip ${facts.stripByteCounts.length} 條、` +
      `${describeBytes(encoded.bytes.length)}`
  }
}
