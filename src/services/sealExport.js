/**
 * 玺爱 · 「一鍵導出印章數據」服务（管理员专属）
 * ============================================================================
 * 需求（Kevin 逐字）：「在 web 端的印章详情页中添加一個只有管理員可以見到和操作的按鈕
 * 【一鍵導出印章數據】…點擊後在網頁端生成 xlsx … 表格文件中包含此印章涉及到的各高清圖片，
 * 並把所有的印章數據…列在表格中。一些非固定的屬性…只把被系統選中的（可能性最大）的信息
 * 放在表格中就可以。」
 *
 * 本模块只做三件事，且**只经既有入口**做：
 *   ① **权限门（双层之一）**：非管理员一律 `{ok:false, reason:'FORBIDDEN', message}`
 *      （复用 `admin.js::isAdminSession()`，与数据层/服务层同字面值；不抛未捕获异常、
 *       不以空集 / `null` 冒充拒绝）；
 *   ② **取数**：该印章的全部**已解析**数据 ——
 *      印章级固定属性（`SEAL_FIXED_ATTR_LABELS`：形制 / 材質）、
 *      印面级固定属性（`fixedAttributesOf` ＋ `FIXED_ATTR_LABELS`：印面圖片 / 邊款圖片 ID）、
 *      可勘误属性的**系统选中值**（`corrections.js::resolveMarkable()` —— 只取 `display`，
 *      **不**写入 PENDING / REJECTED 勘误行、条数或候选值列表）、
 *      影像（印面圖 ＋ 邊款圖 ＋ 用户上传的实物照片）；
 *   ③ **成表**：一个 `.xlsx`（**恰好一个工作表**）＋ 影像层（每张图内嵌 PNG）。
 *
 * 影像档位（R-EX3）：取**展示档整图**（页面上看到的那一档）—— 即
 * `seals.js::imageDisplaySourceOf()` / `photos.js::loadPhotoDataUrl()` 交给页面的那一份，
 * 再在浏览器端**转成 PNG**（Excel 只保证 PNG / JPEG 显示）。**不用**缩略面、**不用**切分块
 * 原样、**不用**原图 TIFF。转码与切片区一律**复用既有入口**（`displayImage.js` 的展示面、
 * `imageFaces.js` 的块面、`utils/image.js` 的解码 / 拼接内核），本模块**不自写第二套**。
 *
 * 表格库（R-EX8）：`write-excel-file/browser` —— **动态 `import()` 按需加载**（主包体不因此变大）。
 *
 * 失败形态（R-EX9）：取图 / 转码 / 库加载 / 成表，任一步失败 ⇒ **整体取消**，
 * 返回结构化 `{ok:false, reason, message}`，**绝不产出半成品文件**（下载动作只在全部成功之后）。
 */

import { FIXED_ATTR_LABELS, SEAL_FIXED_ATTR_LABELS, isAdminSession } from './admin.js'
import { faceLabelOf, fixedAttributesOf, getSealById, imageDisplaySourceOf, imageSourceOf, listFacesOf } from './seals.js'
import { listPhotosByStamp, loadPhotoDataUrl } from './photos.js'
import { resolveMarkable, resolveSealDisplayName } from './corrections.js'
import { clientKindOf, fetchSlices } from './imageFaces.js'
import { displayDataUrlOf } from './displayImage.js'
import { bytesToDataUrl } from '../data/assetmeta.js'
import { composeSliceTiles, decodeImageInput, sniffBytesMime } from '../utils/image.js'
import { saveLocalBinary } from '../utils/file.js'

/* ============================================================================
   冻结给 UI 单的字面值与常量
   ============================================================================ */

/** 管理员动作字面值（按钮钩子 `data-admin-action`；规范侧由 Jing 单同步登记）。 */
export const EXPORT_ADMIN_ACTION = 'export-seal-data'

/** 工作表名（**恰好一个**工作表；单文件 ⇒ 单表）。 */
export const EXPORT_SHEET_NAME = '印章數據'

/** 下载件 MIME（`.xlsx`）。 */
export const EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 文件后缀（与 MIME 同源口径，只有一处定义点）。 */
export const EXPORT_EXTENSION = '.xlsx'

/** 表格库模块标识（**动态 `import()` 的唯一定义点**；主包体不因本模块变大）。 */
export const EXPORT_LIBRARY_SPECIFIER = 'write-excel-file/browser'

/**
 * 内嵌图在表格中的**显示**边长上限（像素）。**只在单边 > 1600 px 时降采样**；
 * 展示档原生 ≤ 1600 px 的图**按原生像素内嵌**（不放大、也**不压到展示档以下**）。
 * Kevin 需求原文是「各**高清**图片」⇒ 展示件整图档的原生像素**保留**；
 * 本常量只决定「表格里显示多大」，**不改内嵌 PNG 的字节与像素**（R-EX3）。
 */
export const EXPORT_IMAGE_DISPLAY_MAX_SIDE = 1600

/** 内嵌图的 “DPI”（库的取值域只有 72 / 96；本模块固定 96，不新立第三值）。 */
export const EXPORT_IMAGE_DPI = 96

/** 影像区每张图占用的行数（1 行说明 ＋ 若干空行 ⇒ 图与图不叠盖）。 */
export const EXPORT_IMAGE_ROW_SPAN = 8

/**
 * 文件名清洗规则（规范续包 §3.34.2(e-1) 逐字；**只作用于文件名**，不动单元格内容 / 影像字节）：
 *   ① **剔除** Windows 非法字符（`/ \ : * ? " < > |`）—— **不是替换为 `_`**；
 *   ② **剔除**全部控制字符（`\u0000`–`\u001F` ＋ `\u007F`），非仅 `\r\n\t`；
 *   ③ 连续空白**折叠为单个空格**（`\s` 族：空格 / NBSP / 全角空格 …）；
 *   ④ 修剪首尾空白与**首尾点号**（Windows 不允许尾点名）；
 *   ⑤ 整体截断至 ≤ `FILENAME_MAX_LENGTH` 字符且**保留 `.xlsx` 扩展名**（按码点截，不切碎代理对）。
 */
const FILENAME_ILLEGAL = /[\\/:*?"<>|]/g
const FILENAME_CONTROL = /[\u0000-\u001F\u007F]/g
const FILENAME_SPACES = /\s+/g
const FILENAME_EDGE = /^[\s.]+|[\s.]+$/g
const FILENAME_MAX_LENGTH = 120

/* ============================================================================
   权限门（与既有判定同口径）
   ============================================================================ */

/**
 * 当前（或指定）账号是否可**导出印章数据** —— 供详情页决定按钮是否渲染。
 *
 * 判定与 `canEditFixedAttributes` / `canEditSealAttributes` **同一套**（`role === 'admin'`；
 * 缺省回落到当前登录态，读的就是 `admin.js::isAdminSession()`）。
 * 非管理员 / 游客 ⇒ `false` ⇒ 入口**不渲染**（DOM 零命中）；服务层另有独立拒绝（见下）。
 * @param {{id?:string, role?:string}|null} [actor] 显式操作者（缺省 ⇒ 当前登录态）
 * @returns {boolean}
 */
export function canExportSealData(actor) {
  if (actor === undefined || actor === null) return isAdminSession()
  return actor.role === 'admin'
}

/** 结构化拒绝（`reason` 逐字；**不抛异常**、**不以空集冒充**）。 */
function denial(reason, message) {
  return { ok: false, reason, message }
}

/** 失败文案统一后缀（house 口径：失败即取消，不得产生重复 / 半成品）。 */
const NO_FILE_SUFFIX = '本次未產出任何文件。'

/* ============================================================================
   影像任务清单（印面圖 ＋ 邊款圖 ＋ 实物照片）
   ============================================================================ */

/**
 * 该印章的全部相关影像任务。
 * 归属：印面级固定属性指向的影像（印面圖 / 邊款圖）＋ 该印章的实物照片行。
 * 同一影像编号被多个印面引用 ⇒ **只列一次**（按首次出现的位置与说明）。
 * @param {Array<object>} faces 印面视图模型（`seals.js::listFacesOf` 的产物）
 * @param {Array<object>} photos 实物照片元数据行（`photos.js::listPhotosByStamp` 的产物）
 * @returns {Array<{key:string, source:'face'|'photo', imageId:string, kindLabel:string, faceLabel:string}>}
 */
export function imageTasksOf(faces, photos) {
  const tasks = []
  const seen = new Set()
  const add = (task) => {
    if (seen.has(task.key)) return
    seen.add(task.key)
    tasks.push(task)
  }
  faces.forEach((face) => {
    const label = faceLabelOf(face.id, face.sealId)
    const fixed = fixedAttributesOf(face)
    if (fixed.face_image_id) {
      const imageId = String(fixed.face_image_id)
      add({ key: `face:${imageId}`, source: 'face', imageId, kindLabel: '印面圖', faceLabel: label })
    }
    fixed.edge_image_ids.forEach((id) => {
      add({ key: `face:${id}`, source: 'face', imageId: id, kindLabel: '邊款圖', faceLabel: label })
    })
  })
  photos.forEach((row) => {
    add({ key: `photo:${row.id}`, source: 'photo', imageId: String(row.id), kindLabel: '實物照片', faceLabel: '' })
  })
  return tasks
}

/* ============================================================================
   影像 → PNG（展示档整图；复用既有展示 / 拼接入口）
   ============================================================================ */

/**
 * 画布 → PNG 字节（**如实回报**：按字节魔数复核，认不出即失败，绝不冒充）。
 */
async function pngBytesOfCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return denial('NOT_IMAGE', '本機畫布不可用，暫時無法生成表格內嵌影像。')
  }
  let blob = null
  try {
    if (typeof canvas.toBlob === 'function') {
      blob = await new Promise((resolve) => {
        canvas.toBlob((out) => resolve(out || null), 'image/png')
      })
    }
  } catch {
    blob = null
  }
  if (!blob && typeof canvas.convertToBlob === 'function') {
    try {
      blob = await canvas.convertToBlob({ type: 'image/png' })
    } catch {
      blob = null
    }
  }
  let bytes = null
  if (blob && typeof blob.arrayBuffer === 'function') {
    try {
      bytes = new Uint8Array(await blob.arrayBuffer())
    } catch {
      bytes = null
    }
  }
  if (!bytes && typeof canvas.toDataURL === 'function') {
    /* `toBlob` 不可用时的最后一条路：dataURL → 字节（失败即如实报错）。 */
    try {
      const dataUrl = canvas.toDataURL('image/png')
      const comma = dataUrl.indexOf(',')
      if (comma > 0) {
        const binary = atob(dataUrl.slice(comma + 1))
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff
      }
    } catch {
      bytes = null
    }
  }
  if (!bytes || bytes.length === 0) return denial('ENCODE_FAILED', '表格內嵌影像生成失敗（本機未能編出 PNG）。')
  const mime = sniffBytesMime(bytes)
  if (mime !== 'image/png') {
    return denial('ENCODE_FAILED', `表格內嵌影像生成失敗（按字節判定為 ${mime || '認不出'}，非 PNG）。`)
  }
  return { ok: true, bytes, mime }
}

/**
 * 可绘制源 → PNG（同尺寸绘制，**不改分辨率**、不做裁剪 / 降采样）。
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap
 */
async function pngOfDrawable(bitmap) {
  const width = Math.round(Number(bitmap && bitmap.width) || 0)
  const height = Math.round(Number(bitmap && bitmap.height) || 0)
  if (width <= 0 || height <= 0) return denial('NOT_IMAGE', '影像無法解碼（尺寸不可用），暫無法內嵌。')
  let canvas = null
  if (typeof document !== 'undefined' && document.createElement) {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
  } else if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height)
  }
  const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  if (!context) return denial('NOT_IMAGE', '本機畫布不可用，暫時無法生成表格內嵌影像。')
  try {
    context.drawImage(bitmap, 0, 0, width, height)
  } catch (err) {
    return denial('NOT_IMAGE', `影像繪製失敗：${(err && err.message) || '未知原因'}`)
  }
  const png = await pngBytesOfCanvas(canvas)
  if (!png.ok) return png
  return { ok: true, bytes: png.bytes, mime: png.mime, width, height }
}

/** dataURL → PNG（原生可解码的展示档；TIFF 已在展示面换过一份，故此处不会再遇到 TIFF）。 */
async function pngOfDataUrl(dataUrl) {
  const bitmap = await decodeImageInput(dataUrl)
  if (!bitmap) return denial('NOT_IMAGE', '影像無法解碼，暫無法內嵌到表格。')
  return pngOfDrawable(bitmap)
}

/**
 * **存储件字节 → 展示档整图 → PNG**（复用 `displayImage.js` 的展示面转码单点：
 * TIFF 存储件换一份展示件；其余容器原字节交给浏览器原生解码）。
 */
async function pngOfStoredBytes(bytes, mime) {
  const storedMime = String(mime || '').trim().toLowerCase()
  const display = await displayDataUrlOf({
    dataUrl: bytesToDataUrl(bytes, storedMime),
    mime: storedMime,
    bytes
  })
  if (!display.ok) return denial(display.reason || 'NOT_IMAGE', display.message || '影像暫時無法顯示。')
  return pngOfDataUrl(display.dataUrl)
}

/**
 * 块面（digest 分流）→ 按响应落位**拼回整图** → PNG。
 * 几何（块数 / 画布尺寸 / 逐块落位）**一律读自响应**；拼接走 `utils/image.js` 的
 * `composeSliceTiles`（拼接落位真源＝TileSplicer 内核），本模块不自算座标。
 */
async function pngOfDigest(imageId, digest, kind) {
  const reply = await fetchSlices({ sha256: digest, assetId: imageId, kind })
  if (!reply.ok) return denial(reply.reason || 'NOT_IMAGE', reply.message || '影像暫時無法顯示。')
  const tiles = []
  for (const block of reply.blocks) {
    const bitmap = await decodeImageInput(block.bytes)
    if (!bitmap) return denial('NOT_IMAGE', '影像塊無法解碼，暫無法內嵌到表格。')
    const width = Math.round(Number(block.placement.width) || 0)
    const height = Math.round(Number(block.placement.height) || 0)
    if (width <= 0 || height <= 0) return denial('NOT_IMAGE', '影像塊落位不可用，暫無法內嵌到表格。')
    let canvas = null
    if (typeof document !== 'undefined' && document.createElement) {
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
    } else if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(width, height)
    }
    const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context) return denial('NOT_IMAGE', '本機畫布不可用，暫時無法生成表格內嵌影像。')
    context.drawImage(bitmap, 0, 0, width, height)
    tiles.push({
      x: Number(block.placement.x) || 0,
      y: Number(block.placement.y) || 0,
      width,
      height,
      canvas
    })
  }
  const whole = composeSliceTiles(tiles, reply.sourceWidth, reply.sourceHeight)
  if (!whole) return denial('NOT_IMAGE', '影像無法完整還原，暫無法內嵌到表格。')
  const png = await pngBytesOfCanvas(whole)
  if (!png.ok) return png
  return { ok: true, bytes: png.bytes, mime: png.mime, width: reply.sourceWidth, height: reply.sourceHeight }
}

/** 印面族影像（展示档整图）→ PNG。 */
async function pngOfFaceImage(imageId) {
  const display = await imageDisplaySourceOf(imageId)
  if (!display.ok) return denial(display.reason || 'IMAGE_UNAVAILABLE', display.message || '影像暫時無法顯示。')
  if (display.via === 'digest') {
    /* 面别由**行上的资产类别**判定（`imageFaces.js::clientKindOf` 单点；本模块不自写谓词）。 */
    const kind = clientKindOf(imageSourceOf(imageId).row || {}, '')
    if (!kind) return denial('NOT_IMAGE', '影像類別不可用，暫無法內嵌到表格。')
    return pngOfDigest(imageId, display.digest, kind)
  }
  return pngOfDataUrl(display.dataUrl)
}

/** 实物照片（展示档整图）→ PNG。 */
async function pngOfPhoto(photoId) {
  const out = await loadPhotoDataUrl(photoId)
  if (!out.ok) return denial(out.reason || 'IMAGE_UNAVAILABLE', out.message || '實物照片暫時無法讀取。')
  return pngOfStoredBytes(out.bytes, out.mime)
}

/** 一张影像任务 → PNG 读数。 */
async function pngOfTask(task) {
  const got = task.source === 'photo' ? await pngOfPhoto(task.imageId) : await pngOfFaceImage(task.imageId)
  if (!got.ok) return got
  return { ok: true, bytes: got.bytes, mime: got.mime, width: got.width, height: got.height }
}

/* ============================================================================
   工作表内容（层级分组：印章级 → 印面级 → 非固定属性（系统选中值） → 影像）
   ============================================================================ */

const BOLD = { fontWeight: 'bold' }

function textCell(value) {
  return { value: String(value === null || value === undefined ? '' : value), type: String }
}

function boldCell(value) {
  return { value: String(value === null || value === undefined ? '' : value), type: String, ...BOLD }
}

/** 印章级 / 印面级固定属性的值：无值 ⇒ 可读空态（**不回落成任何编造值**）。 */
function fixedValueOf(value, emptyText) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  return text || emptyText
}

/**
 * 组装工作表（行数组）＋ 影像锚点行号。
 * 层级顺序（R-EX2）：印章级固定属性 → 印面级固定属性 → 非固定属性（系统选中值）→ 影像。
 * 非固定属性只写 `resolveMarkable()` 的 `display`（系统选中值）与取值来源，
 * **不写**条数 / 候选值 / 勘误历史。
 * @returns {{rows:Array<Array<object|string>>, imageRows:Array<number>}}
 */
export function buildSheetContent(seal, faces, tasks) {
  const rows = []
  const push = (cells) => rows.push(cells)
  const imageRows = []

  push([boldCell(`璽愛 · 印章數據 · ${seal.stamp_id} · ${resolveSealDisplayName(seal)}`)])
  push([boldCell('藏品編號'), textCell(seal.stamp_id)])
  push([boldCell('印面數'), { value: faces.length, type: Number }])
  push([])

  /* ---- 印章级固定属性（真源标签表：SEAL_FIXED_ATTR_LABELS） ---- */
  push([boldCell('【印章級固定屬性】')])
  push([boldCell('屬性'), boldCell('值')])
  push([textCell(SEAL_FIXED_ATTR_LABELS.shape), textCell(fixedValueOf(seal.shape, '未設置'))])
  push([textCell(SEAL_FIXED_ATTR_LABELS.material), textCell(fixedValueOf(seal.material, '未設置'))])
  push([])

  /* ---- 印面级固定属性 ＋ 非固定属性（系统选中值），逐印面分组 ---- */
  faces.forEach((face) => {
    const label = faceLabelOf(face.id, face.sealId)
    const fixed = fixedAttributesOf(face)
    push([boldCell(`【印面級固定屬性 · ${label}】`)])
    push([boldCell('屬性'), boldCell('值')])
    push([textCell(FIXED_ATTR_LABELS.face_image_id), textCell(fixedValueOf(fixed.face_image_id, '暫缺'))])
    push([
      textCell(FIXED_ATTR_LABELS.edge_image_ids),
      textCell(fixed.edge_image_ids.length ? fixed.edge_image_ids.join('、') : '無')
    ])
    push([boldCell(`【可勘誤屬性（系統選中值） · ${label}】`)])
    push([boldCell('屬性'), boldCell('值'), boldCell('取值來源')])
    resolveMarkable(face).forEach((item) => {
      push([
        textCell(item.label),
        textCell(fixedValueOf(item.display, '未著錄')),
        textCell(item.source === 'CORRECTION' ? '系統選中' : '原值')
      ])
    })
    push([])
  })

  /* ---- 影像区（属性区下方；每张图一行说明，图按其锚点行内嵌） ---- */
  push([boldCell('【影像】')])
  push([boldCell('序號'), boldCell('編號'), boldCell('類型'), boldCell('尺寸'), boldCell('格式')])
  tasks.forEach((task, index) => {
    const rowIndex = rows.length + 1 // 1-based 行号（下一行就是本图的说明行）
    imageRows.push(rowIndex)
    push([
      { value: index + 1, type: Number },
      textCell(task.imageId),
      textCell(task.kindLabel),
      textCell(`${task.width} × ${task.height}`),
      textCell(task.mime)
    ])
    for (let i = 1; i < EXPORT_IMAGE_ROW_SPAN; i += 1) push([])
  })

  return { rows, imageRows }
}

/** 影像层（`images` 选项）：按说明行顺序锚定在属性列右侧，**不占单元格**。 */
export function buildImageLayer(tasks, imageRows) {
  return tasks.map((task, index) => {
    /* 展示档原生像素优先：仅当单边 > 上限才等比降采样（**绝不放大**小图，也不额外压低）。 */
    const longest = Math.max(task.width, task.height)
    const scale = longest > EXPORT_IMAGE_DISPLAY_MAX_SIDE ? EXPORT_IMAGE_DISPLAY_MAX_SIDE / longest : 1
    const displayWidth = Math.max(1, Math.round(task.width * scale))
    const displayHeight = Math.max(1, Math.round(task.height * scale))
    return {
      content: task.bytes,
      contentType: 'image/png',
      width: Math.max(1, displayWidth),
      height: Math.max(1, displayHeight),
      dpi: EXPORT_IMAGE_DPI,
      anchor: { row: imageRows[index], column: 6 },
      title: `${task.kindLabel} ${task.imageId}`.trim(),
      description: task.faceLabel || ''
    }
  })
}

/* ============================================================================
   文件名（Zang 定：璽愛印章-<藏品編號或印章 id>-<印文>.xlsx）
   ============================================================================ */

/**
 * 单个文件名片段（藏品编号 / 印文）的清洗 ＋ 首尾修剪。
 * 逐字按 §3.34.2(e-1) ①〜④：**剔除**非法字符、**剔除**控制字符、折叠连续空白、修剪首尾空白 / 点号。
 * @param {unknown} text
 * @returns {string}（可能为空串；兜底字面值由 `exportFilenameOf` 给）
 */
export function sanitizeFilenamePart(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(FILENAME_ILLEGAL, '')
    .replace(FILENAME_CONTROL, '')
    .replace(FILENAME_SPACES, ' ')
    .replace(FILENAME_EDGE, '')
}

/**
 * 下载件文件名：`璽愛印章-<藏品編號或印章 id>-<印文>.xlsx`。
 * ⑤ 截断：**按码点**截到 ≤120 字符，且**恒保留 `.xlsx` 扩展名**（截的是尾巴、保住前缀 ——
 * 与旧版「取尾部 N 字」写法不同，旧写法会把「璽愛印章-编号-」整段丢掉）。
 * @param {{stamp_id?:string, seal_name?:string}|null} seal
 * @returns {string}
 */
export function exportFilenameOf(seal) {
  const id = sanitizeFilenamePart((seal && seal.stamp_id) || '') || '未編號'
  /* 印文段取**显示名单点**（采纳值 → 原始 `seal_name` →「佚名」），与表头 / 详情页同源；
     `sanitizeFilenamePart` 之后仍为空（全是不允许字符）才回落到「佚名」。 */
  const name = sanitizeFilenamePart(resolveSealDisplayName(seal)) || '佚名'
  const stem = `璽愛印章-${id}-${name}`
  const limit = Math.max(1, FILENAME_MAX_LENGTH - EXPORT_EXTENSION.length)
  const points = Array.from(stem)
  const head = points.length > limit ? points.slice(0, limit).join('') : stem
  return `${sanitizeFilenamePart(head)}${EXPORT_EXTENSION}`
}

/* ============================================================================
   主入口
   ============================================================================ */

/**
 * 一键导出该印章为一个 `.xlsx`（**恰好一个工作表**）并触发浏览器下载。
 *
 * @param {string} stampId 印章编号（藏品編號）
 * @param {{id?:string, role?:string}|null} [actor] 显式操作者（缺省 ⇒ 当前登录态）
 * @returns {Promise<{ok:boolean, reason?:string, message:string, filename?:string, bytes?:number,
 *   sheet?:string, images?:number, faces?:number}>}
 *   - 成功：`{ok:true, filename, bytes, sheet, images, faces, message}`（下载已触发）；
 *   - 拒绝：`{ok:false, reason, message}`（`FORBIDDEN` 为越权唯一字面值；**零产出**）。
 * @throws 从不抛未捕获异常（一切失败都转成结构化读数）。
 */
export async function exportSealData(stampId, actor) {
  if (!canExportSealData(actor)) {
    return denial('FORBIDDEN', `僅管理員可以導出印章數據；${NO_FILE_SUFFIX}`)
  }
  const id = String(stampId || '').trim()
  const seal = id ? getSealById(id) : null
  if (!seal) return denial('NOT_FOUND', `未找到該印章，無法導出；${NO_FILE_SUFFIX}`)

  const faces = listFacesOf(seal.stamp_id)
  const photos = listPhotosByStamp(seal.stamp_id)
  const tasks = imageTasksOf(faces, photos)

  /* ① 取齐全部影像（展示档整图 → PNG）：任一张失败 ⇒ 整体取消（零产出）。 */
  const images = []
  for (const task of tasks) {
    const got = await pngOfTask(task)
    if (!got.ok) {
      return denial(
        got.reason || 'IMAGE_UNAVAILABLE',
        `「${task.kindLabel} ${task.imageId}」影像無法取得或無法顯示（${got.message}）；${NO_FILE_SUFFIX}`
      )
    }
    images.push({ ...task, ...got })
  }

  /* ② 动态加载表格库（主包体不因本模块变大）。 */
  let writeXlsxFile = null
  try {
    /* **动态 `import()` ＋ 字面量说明符**：打包器据此把表格库切进独立分块，
       `SealDetailView` 之外的路径**永不加载**它（本模块的静态图里不含该库）。 */
    const mod = await import('write-excel-file/browser')
    writeXlsxFile = (mod && (mod.default || mod.writeXlsxFile)) || null
  } catch (err) {
    return denial('LIBRARY_UNAVAILABLE', `表格生成元件未能加載（${(err && err.message) || '未知原因'}）；${NO_FILE_SUFFIX}`)
  }
  if (typeof writeXlsxFile !== 'function') {
    return denial('LIBRARY_UNAVAILABLE', `表格生成元件不可用（本機返回形態不符）；${NO_FILE_SUFFIX}`)
  }

  /* ③ 成表（工作表 ＋ 影像层）—— 先拿 Blob，**全部成功后才触发下载**。 */
  const { rows, imageRows } = buildSheetContent(seal, faces, images)
  const sheetOptions = {
    sheet: EXPORT_SHEET_NAME,
    columns: [{ width: 22 }, { width: 26 }, { width: 46 }, { width: 18 }, { width: 14 }, { width: 46 }],
    images: buildImageLayer(images, imageRows)
  }
  let blob = null
  try {
    const out = writeXlsxFile(rows, sheetOptions)
    blob = await out.toBlob()
  } catch (err) {
    return denial('WRITE_FAILED', `表格生成失敗（${(err && err.message) || '未知原因'}）；${NO_FILE_SUFFIX}`)
  }
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return denial('WRITE_FAILED', `表格生成失敗（未取得二進制產物）；${NO_FILE_SUFFIX}`)
  }
  let bytes = null
  try {
    bytes = new Uint8Array(await blob.arrayBuffer())
  } catch (err) {
    return denial('WRITE_FAILED', `表格產物讀取失敗（${(err && err.message) || '未知原因'}）；${NO_FILE_SUFFIX}`)
  }
  /* 产物自证：`.xlsx` 是 zip 容器（`PK`）⇒ 按字节复核，认不出即取消（不交出可疑文件）。 */
  if (!(bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return denial('WRITE_FAILED', `表格產物形狀不符（非 xlsx 容器）；${NO_FILE_SUFFIX}`)
  }

  const filename = exportFilenameOf(seal)
  if (!saveLocalBinary(filename, bytes, EXPORT_MIME)) {
    return denial('DOWNLOAD_UNAVAILABLE', `當前環境不支持本機下載；${NO_FILE_SUFFIX}`)
  }
  return {
    ok: true,
    filename,
    bytes: bytes.length,
    sheet: EXPORT_SHEET_NAME,
    library: EXPORT_LIBRARY_SPECIFIER,
    images: images.length,
    faces: faces.length,
    message: `已導出「${resolveSealDisplayName(seal)}」（${filename}）：${faces.length} 個印面、${images.length} 張影像。`
  }
}
