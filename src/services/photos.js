/**
 * 玺爱 · 实物照片服务（骨架）
 *
 * 实物照片是「影像属性」：普通登录用户可上传印章实物照片。
 * 斐萃库无此概念，属玺爱自有数据。
 * 上传闭环追加在文件末尾的「闭环补全」段。
 */

import {
  listPhotoRows,
  savePhotoRows,
  putPhotoBinary,
  getPhotoBinary,
  readPhotoDataUrl,
  deletePhotoBinary,
  photoBinaryKey,
  migrateLegacyPhotoRows,
  sha256Hex,
  imageSize,
  toUint8Array,
  /* ---- R-83 〜 R-88（2026-09-21｜Kong-I2 图像管线单）：切片几何真源**在数据层** ---- */
  sliceMetaOf as dataSliceMetaOf, // 切片元数据**确定性派生**（同 id 必同结果）——本服务不自写切位
  sliceWindowsOf as dataSliceWindowsOf // 由元数据派生**逐块归一化窗口**（几何唯一真源）
} from '../data/db.js'
import {
  sniffBytesMime,
  STORED_MAX_BYTES,
  exportSquareImage,
  exportStoredTiff,
  windowsToPixelRects,
  rectSeamReport,
  renderSliceTiles,
  composeSliceTiles,
  decodeImageInput,
  DISPLAY_MIME,
  STORAGE_MIME
} from '../utils/image.js'
import { SLICE_META_FIELD } from '../data/seed.js'
import { currentUser } from '../data/session.js'
/* 云端化三通道（本单新增；**只引用、不另立**）：公开读面 `callCloudFunction`、
   字节入云 `displayFetch('/image/store')`、写面（含管理三 op）`userWriteGate`。 */
import { callCloudFunction } from '../data/cloudbaseFn.js'
import { displayFetch } from './displayImage.js'
import { userWriteGate } from './userWrite.js'

export const PHOTO_AUDIT_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
}

export function listMyPhotos() {
  const user = currentUser()
  if (!user) return []
  return listPhotoRows()
    .filter((row) => row.user_id === user.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

export function countPhotosOfStamp(stampId) {
  return listPhotoRows().filter((row) => row.stamp_id === stampId).length
}


/* ============================================================================
   闭环补全（增量追加）
   ----------------------------------------------------------------------------
   上方既有的常量与只读查询签名、行为均未改动。
   实物照片是玺爱自有的「影像属性」，由登录用户上传，按印章归档。

   【本单改造（2026-09-20）｜影像存储分层 + 上限口径修正】
   ① **两套上限，不得混用**：
      - **输入侧 1 MB**：判据＝**原始文件字节数**，判在 `utils/image.js` 的 `loadImageFile`
        （旧实现判的是 **base64 串长度**，实际可传更小 ⇒ 一并修）。文案＝「照片过大：**所选文件**…」。
      - **产物侧 4 MiB**（`PHOTO_ARTIFACT_MAX_BYTES` ＝ `IMAGE_LIMITS.maxStoredBytes`）：判**处理后的二进制**。
        旧实现拿 1 MB 闸产物 ⇒ 浏览器编不出 WebP 回退 PNG（2048² ≈ 2.7 MB）时被自家闸拒，
        且文案误导（「照片过大…请换一张更小的图」，而用户没传大图）——本单修掉。
        产物超限时 `exportSquareImage` **先做有界降质重编**（≤3 轮），本服务只在重编后仍超限时兜底拒，
        且拒的文案＝「本机影像生成失败」（与输入侧文案**必须分开**）。
   ② **入库统一 WebP**：入参为**已处理的二进制**（`bytes` + `mime` + `width` + `height`），
   ③ **二进制 → IndexedDB、`localStorage` 只存元数据**（`width`/`height`/`bytes`/`sha256`/`mime`）
      ⇒ 修掉 AC-33（旧实现把整张 dataURL 写进 `xiai:v1:photos`，单值曾达 200.99 KiB ≥ 64 KiB 判负）。
   ④ **兜底红线**：浏览器编不出 WebP 时如实记录**实际 mime**（由处理管线按字节魔数给出），
      本服务**不得**把非 WebP 冒充成 `image/webp`；解码失败 / 超限 / 二进制写入失败一律给可读错误，
   ============================================================================ */

/** 输入上限（**原始文件字节数**）：1 MB。判在 `utils/image.js` 的 `loadImageFile`；**只管用户选的图**。 */
export const PHOTO_MAX_BYTES = 1024 * 1024

/**
 * **产物侧**入库上限（处理后二进制的字节数）：与输入上限同源不同值（`utils/image.js` 的
 * `IMAGE_LIMITS.maxStoredBytes`，4 MiB）。
 *
 * 为什么不能拿 1 MB 当产物闸：浏览器编不出 WebP 时回退 PNG，2048×2048 实测 2.70–2.72 MiB
 * ⇒ 用 1 MB 闸自家产物＝把**没有传大图**的用户拒掉，还甩「照片过大…请换一张更小的图」（误导）。
 * 产物超限时管线先做有界降质重编；本服务只做兜底拒，且文案必须说「本机影像生成失败」。
 */
export const PHOTO_ARTIFACT_MAX_BYTES = STORED_MAX_BYTES

/**
 * @deprecated 兼容别名（旧调用方仍在 import）。**语义已变**：历史上它是
 * **base64 串长度**上限（400×1024），现在等于**文件字节**上限 `PHOTO_MAX_BYTES`。
 * 新代码请用 `PHOTO_MAX_BYTES`，或直接读 `utils/image.js` 的 `IMAGE_LIMITS.maxInputBytes`。
 * ⚠️ 它**只用于输入侧**；产物侧一律用 `PHOTO_ARTIFACT_MAX_BYTES`。
 */
export const PHOTO_MAX_LENGTH = PHOTO_MAX_BYTES

/**
 * **输入侧**（用户所选原始文件）拒绝的结构化 reason 透传 —— 服务层**不得只回文案**。
 *
 * 冻结口径（§3.12.10(c)）：**输入侧超限 = `TOO_LARGE`**（仅输入侧用）；产物侧一律
 * `ARTIFACT_TOO_LARGE`（下方 `uploadPhoto` 的兜底），两者**不得互相复用**。
 * 输入侧上限（1 MB，判**原始文件字节**）判在 `utils/image.js` 的 `loadImageFile`；
 * 本服务不重复判。本函数把管线结果里的输入侧 `reason` 原样抬到服务层（与文案同源），
 * 两个上传口渲染提示时走它。
 * @param {{ok?:boolean, reason?:string, message?:string}} loaded `loadImageFile` 的返回值
 * @returns {null|{ok:false, reason:string, message:string}} 输入通过 ⇒ `null`
 */
export function inputDenialOf(loaded) {
  if (!loaded || loaded.ok) return null
  return {
    ok: false,
    reason: loaded.reason || 'NOT_IMAGE',
    message: loaded.message || '圖片不可用，請重新選擇文件'
  }
}

/** 实物照片的**元数据**字段（落 `localStorage`；二进制一律在 IndexedDB）。 */
const PHOTO_META_FIELDS = ['width', 'height', 'bytes', 'sha256', 'mime']

export function listPhotosByStamp(stampId) {
  return listPhotoRows()
    .filter((row) => row.stamp_id === stampId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
}

/** 当前用户可见的全部照片元数据行（含二进制键口径，供页面按 id 取回渲染）。 */
export function listAllPhotoRows() {
  return listPhotoRows().slice()
}

function describeBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

function isImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
}

/**
 * 上传实物照片（**入参为浏览器端处理后的二进制**）。
 *
 * @param {{stampId:string, bytes:Uint8Array|ArrayBuffer|ArrayBufferView, mime?:string,
 *          width?:number, height?:number, note?:string, fileName?:string}} payload
 * @returns {{ok:boolean, row?:object, reason?:string, message:string}}
 *          失败一律可读（未登录拒 / 未指定印章 / 内容空 / 超限 / 非图片 / 二进制写入失败）。
 */
export async function uploadPhoto({ stampId, bytes, mime = '', width, height, note = '', fileName = '' } = {}) {
  const user = currentUser()
  if (!user) return { ok: false, reason: 'UNAUTHENTICATED', message: '請先登錄後再上傳實物照片' }
  if (!stampId) return { ok: false, reason: 'MISSING_STAMP', message: '未指定印章' }

  const payload = toUint8Array(bytes)
  if (!payload || payload.length === 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '照片內容爲空，請重新選擇文件' }
  }
  /* 产物侧兜底：判的是**处理后的二进制**（`PHOTO_ARTIFACT_MAX_BYTES`＝4 MiB），
     **不是**输入文件的 1 MB —— 后者判在 `utils/image.js` 的 `loadImageFile`。
     文案必须与输入侧分开：这里说「本机影像生成失败」，不得再说「照片过大…请换一张更小的图」。 */
  if (payload.length > PHOTO_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'ARTIFACT_TOO_LARGE',
      message:
        `本機影像生成失敗：處理後影像 ${describeBytes(payload.length)} 超過入庫上限 ${describeBytes(PHOTO_ARTIFACT_MAX_BYTES)}。` +
        '這與「所選文件 ≤ 1 MB」的輸入上限是兩回事；請重試，或改用支持 WebP 編碼的瀏覽器後再上傳。'
    }
  }

  /* mime 以**字节魔数**为准（不采信调用方的声称值）：认不出 ⇒ 可读拒绝，不冒充图片。 */
  const actualMime = sniffBytesMime(payload)
  if (!isImageMime(actualMime)) {
    const claimed = String(mime || '').trim().toLowerCase()
    return {
      ok: false,
      reason: 'NOT_IMAGE',
      message: '這不是可用的圖片內容（無法識別圖片格式），請重新選擇圖片文件'
        + (claimed ? `（聲稱類型 ${claimed}）` : '')
    }
  }

  const size = imageSize(payload)
  const finalWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : size.width
  const finalHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.round(Number(height)) : size.height
  const digest = sha256Hex(payload)

  const id = `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  /* **先落二进制、再落元数据**：二进制失败 ⇒ 不写元数据行（不留「有行无图」的死数据）。 */
  const stored = await putPhotoBinary(id, payload)
  if (!stored.ok) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: `照片寫入本地影像庫失敗：${stored.message}` }
  }

  const row = {
    id,
    sealId: stampId, // 规范字段：实物照片归属印章
    stamp_id: stampId, // 兼容别名：＝sealId，勿删
    user_id: user.id,
    note: String(note || '').trim(),
    file_name: String(fileName || '').trim(),
    status: PHOTO_AUDIT_STATUS.APPROVED,
    /* --- 以下为**元数据**（`localStorage`）：二进制一律在 IndexedDB --- */
    mime: actualMime, // 如实的实际格式（编不出 WebP 时就是 PNG / JPEG，**不冒充 webp**）
    width: finalWidth,
    height: finalHeight,
    bytes: payload.length,
    sha256: digest,
    storage: 'indexeddb',
    storage_key: photoBinaryKey(id),
    /* **R-92**：实拍图行**同样落切片元数据**（键名与影像行一致 `slice_meta`）。
       内容＝**数据层的同一派生函数**（`sliceMetaOf(id, 'PHOTO')` ⇒ `cols:4 / rows:2 / cuts:3`），
       复现 ⇒ **无需迁移、不改写历史行**。 */
    [SLICE_META_FIELD]: dataSliceMetaOf(id, SLICE_KIND_PHOTO),
    created_at: new Date().toISOString()
  }
  savePhotoRows([...listPhotoRows(), row])
  return { ok: true, row, message: '實物照片已上傳' }
}

/**
 * 按照片 id 取回二进制并转 dataURL（**仅供运行时渲染**）。
 * 页面渲染画廊必须走这里：二进制只在 IndexedDB，页面 / 组件不得直接读浏览器存储。
 * **`bytes` 的语义（本单订正 JSDoc，行为未改）**：`bytes` ＝ **真字节数组**（`Uint8Array`，数组长度即字节数）；
 * `bytesLength`（`number`）只出现在**数据层读入口**（`db.js::readPhotoDataUrl`）。
 * @returns {Promise<{ok:boolean, dataUrl?:string, bytes?:Uint8Array, mime?:string, meta?:object, message:string}>}
 */
export async function loadPhotoDataUrl(photoId) {
  const meta = listPhotoRows().find((row) => row.id === photoId) || null
  if (!meta) return { ok: false, reason: 'NOT_FOUND', message: '未找到該實物照片' }
  const out = await readPhotoDataUrl(photoId, meta.mime)
  if (!out.ok) return { ok: false, reason: out.reason || 'ERROR', message: out.message }
  return { ok: true, dataUrl: out.dataUrl, bytes: out.bytes, mime: out.mime, meta, message: '' }
}

/** 该照片的二进制是否真的落在 IndexedDB（自测 / 排障用）。 */
export async function hasPhotoBinaryOf(photoId) {
  const out = await getPhotoBinary(photoId)
  return out.ok === true && Number(out.bytesLength) > 0
}

/**
 * 删除一条实物照片（元数据 + 二进制一起删，不留孤儿二进制）。
 * 仅允许删自己的照片；未登录 / 越权一律结构化拒绝。
 */
export async function deletePhoto(photoId) {
  const user = currentUser()
  if (!user) return { ok: false, reason: 'UNAUTHENTICATED', message: '請先登錄後再操作' }
  const rows = listPhotoRows()
  const target = rows.find((row) => row.id === photoId)
  if (!target) return { ok: false, reason: 'NOT_FOUND', message: '未找到該實物照片' }
  if (target.user_id !== user.id) {
    return { ok: false, reason: 'FORBIDDEN', message: '只能刪除自己上傳的實物照片' }
  }
  savePhotoRows(rows.filter((row) => row.id !== photoId))
  await deletePhotoBinary(photoId)
  return { ok: true, message: '實物照片已刪除' }
}

/** 元数据字段清单（自测用：核对 `localStorage` 里只有标量、没有 `data:image` 串）。 */
export function photoMetaFields() {
  return PHOTO_META_FIELDS.slice()
}

/**
 * **老库就地纠正入口**：页面在渲染实物照片前调一次即可。
 *
 * 把旧实现「整张 dataURL 直存 `localStorage`」的历史行迁成「元数据 + IndexedDB 二进制」
 * （口径见 `db.js` 的 `migrateLegacyPhotoRows`）。**幂等**：无可迁时零写入。
 *
 * 为什么页面要主动调：AC-33 的判定是**全量枚举 `localStorage`**，历史行不清掉就仍判负；
 * 而「清库 / 升命名空间版本」是被明令禁止的（会丢用户数据）⇒ 只能就地迁。
 * @returns {Promise<{ok:boolean, migrated:number, total:number, leftovers:number, message:string}>}
 */
export async function ensurePhotoStorageMigrated() {
  return migrateLegacyPhotoRows()
}

/* ============================================================================
   **R-83 〜 R-88（2026-09-21｜Kong-I2 图像管线单）**：实拍图源 = AVIF（如实回退）
   ／预览输出 webp／切片窗口消费（几何全在数据层）
   ----------------------------------------------------------------------------
     ① `preparePhotoSource` / `uploadPhotoSource`：实拍图上传 ⇒ 试编 **AVIF**，编不出**按字节
        如实记实际格式** ＋ 可读提示（绝不冒充），随后交给**既有** `uploadPhoto` 入库
        （产物侧 4 MiB ＋ 魔数判定 ＋ localStorage 只存元数据**照旧**）；
     ② `photoPreviewWebpOf` / `preparePhotoSource().preview`：**预览输出 webp**（R-86）；
     ③ `photoSlicePlanOf` / `photoSliceTiles`：切窗**从数据层取**（行上 `slice_meta` ⇒
        `db.sliceMetaOf(id, 'PHOTO')` ⇒ `db.sliceWindowsOf(meta)`），**实拍 8 块＝4×2**；
        本服务只做「归一化窗口 → 设备像素」与无缝机械校验。
   ============================================================================ */

/** 实拍图**源文件**的编码目标 mime（本单起＝**单页 8bit Deflate TIFF**；与印面面同容器）。 */
export const PHOTO_SOURCE_MIME = STORAGE_MIME

/** 预览输出 mime（预览一律 webp 0.92 —— 展示容器，与存储容器**分名**）。 */
export const PHOTO_PREVIEW_MIME = DISPLAY_MIME

/** 切片类别字面值：`PHOTO`＝实拍族（**8 块＝4×2**，刀数真源＝数据层 `SLICE_CUT_COUNTS.PHOTO`）。 */
export const SLICE_KIND_PHOTO = 'PHOTO'

/**
 * **数据层的切片元数据**（**消费真源，绝不自己算切位**；与 `seals.js` 同一口径）：
 *   ① 行上已持久化的 `slice_meta`（R-87：数据层确定性派生并持久化）⇒ **逐字采用**；
 *   ② 行上没有该键（既有行**无需迁移**）⇒ 调**数据层的同一派生函数** `db.sliceMetaOf(id, 'PHOTO')`。
 */
function sliceMetaOfRow(row, kind, fallbackId = '') {
  const persisted = row && typeof row === 'object' ? row[SLICE_META_FIELD] : null
  if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
    return { meta: persisted, source: 'row', id: (row && row.id) || fallbackId }
  }
  const id = (row && row.id) || fallbackId || ''
  return { meta: dataSliceMetaOf(id, kind), source: 'derived', id }
}

/** 实拍图行（编号 / 行对象 → 行；找不到 ⇒ `null`）。 */
export function photoRowOf(target) {
  if (target && typeof target === 'object') return target
  const id = String(target || '').trim()
  if (!id) return null
  return listPhotoRows().find((row) => row.id === id) || null
}

/**
 * 实拍图的**切片计划**（块数 / 刀向 / 切位 / 逐窗坐标全部来自数据层）——实拍族 ⇒ **8 块**。
 * @param {string|object} target 照片编号或照片行
 */
export function photoSlicePlanOf(target) {
  const row = photoRowOf(target)
  const { meta, source } = sliceMetaOfRow(row, SLICE_KIND_PHOTO, String(target || ''))
  const windows = dataSliceWindowsOf(meta)
  const width = row ? Math.round(Number(row.width) || 0) : 0
  const height = row ? Math.round(Number(row.height) || 0) : 0
  const converted = width > 0 && height > 0 ? windowsToPixelRects(windows, width, height) : null
  const rects = converted ? converted.rects : []
  const report = converted && converted.ok ? rectSeamReport(rects, width, height) : null
  return {
    ok: windows.length > 0,
    photoId: (row && row.id) || '',
    kind: SLICE_KIND_PHOTO,
    source,
    meta,
    windows,
    rects,
    report,
    width,
    height,
    message: windows.length > 0
      ? `實拍切片元數據（來源 ${source === 'row' ? `行上 ${SLICE_META_FIELD}` : '數據層派生'}）：${windows.length} 塊` +
        (report ? `；無縫校驗：面積相等 ${report.areaEqualsSource ? '是' : '否'}、兩兩不交 ${report.noOverlap ? '是' : '否'}` : '')
      : '實拍切片元數據不可用（照片不存在或尺寸元數據缺失）'
  }
}

/** 按数据层切窗**逐块裁剪**某张实拍图（展示层拼接用；`options.encodeMime` 给了就连块编码）。 */
export async function photoSliceTiles(target, bitmap, options = {}) {
  const plan = photoSlicePlanOf(target)
  if (plan.windows.length === 0) {
    return { ok: false, tiles: [], rects: [], report: null, plan, reason: 'SLICE_META_UNAVAILABLE', message: plan.message }
  }
  const rendered = await renderSliceTiles(bitmap, plan.windows, {
    encodeMime: options.encodeMime,
    quality: options.quality
  })
  return { ...rendered, plan }
}

/** **实拍图预览输出（webp）**（R-86）——独立入口，供展示层直接用。 */
export async function photoPreviewWebpOf(bitmap, options = {}) {
  const encoded = await exportSquareImage(bitmap, {
    crop: options.crop,
    maxSide: options.maxSide,
    quality: options.quality,
    maxBytes: options.maxBytes
  })
  return encoded
}

/** 源面容器口径**自述**（本单起实拍面与印面面同容器：单页 8bit Deflate TIFF）。 */
export async function photoSourceSupport() {
  return {
    supported: true,
    requested: PHOTO_SOURCE_MIME,
    previewMime: PHOTO_PREVIEW_MIME,
    message: `實拍圖源文件一律編為 ${PHOTO_SOURCE_MIME}（單頁 8bit Deflate TIFF，與印面面同一入口）。`
  }
}

/**
 * **实拍图源文件管线（R-135）**：实拍图源**一律**编成 **单页 8bit Deflate TIFF** —— 与印面面
 * **同一入口口径**（容器定义点恰 1 处 ＝ `utils/tiff.js`），**不按面类分流**；AVIF 已整体退场，
 * 不再有「原样保留 AVIF 源 / 试编 AVIF」两条分支，也**不再原字节透传**任何旧容器。
 * 一律同时产出**预览 webp（0.92）**；产物侧 4 MiB 与 mime 按**字节魔数**判定照旧。
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} bitmap 已解码的源（**必给**）
 * @param {{sourceBytes?:Uint8Array|ArrayBuffer, crop?:object, maxSide?:number, quality?:number, maxBytes?:number}} [options]
 */
export async function preparePhotoSource(bitmap, options = {}) {
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.round(maxBytesRaw) : PHOTO_ARTIFACT_MAX_BYTES
  const raw = options.sourceBytes ? toUint8Array(options.sourceBytes) : null
  const sourceMime = raw && raw.length > 0 ? sniffBytesMime(raw) : ''
  const preview = await photoPreviewWebpOf(bitmap, { ...options, maxBytes })
  const encoded = await exportStoredTiff(bitmap, {
    crop: options.crop,
    maxSide: options.maxSide,
    maxBytes
  })
  const bytes = encoded.bytes || null
  /* 容器按**字节魔数**复核（不采信任何声称值）；不是目标容器即拒，绝不冒充。 */
  const mime = bytes ? sniffBytesMime(bytes) : ''
  const base = {
    mode: 'encode',
    bytes: null,
    mime: '',
    width: encoded.width || 0,
    height: encoded.height || 0,
    requested: PHOTO_SOURCE_MIME,
    encoded: false,
    claimed: '',
    note: '',
    preview,
    support: true,
    previewMime: PHOTO_PREVIEW_MIME,
    tiff: encoded.tiff || null,
    sourceMime
  }
  if (!encoded.ok || !bytes || mime !== PHOTO_SOURCE_MIME) {
    return {
      ...base,
      reason: encoded.reason || 'ENCODE_FAILED',
      message:
        encoded.message ||
        `本機影像生成失敗：實拍圖存儲件未編成 ${PHOTO_SOURCE_MIME}（按字節魔數如實判定為 ${mime || '認不出'}），已拒絕交付。`
    }
  }
  if (bytes.length > maxBytes) {
    return {
      ...base,
      reason: 'ARTIFACT_TOO_LARGE',
      bytes,
      mime,
      encoded: true,
      message:
        `本機影像生成失敗：實拍圖存儲件 ${describeBytes(bytes.length)} 超過入庫上限 ${describeBytes(maxBytes)}。` +
        '這與「所選文件 ≤ 1 MB」的輸入上限是兩回事。'
    }
  }
  const note =
    `實拍圖存儲件（單頁 8bit Deflate TIFF）：${encoded.width || 0}×${encoded.height || 0}，` +
    `${describeBytes(bytes.length)}；預覽輸出 ${PHOTO_PREVIEW_MIME}`
  return { ...base, ok: true, bytes, mime, encoded: true, note, message: note }
}

/**
 * 实拍图上传闭环（R-86）：**试编 AVIF（如实回退）→ 交给既有 `uploadPhoto` 入库**。
 *
 * 既有不回退面**全部照旧**：输入侧 1 MB 判**原始文件字节**（判在 `utils/image.js`）、
 * 产物侧 4 MiB（`PHOTO_ARTIFACT_MAX_BYTES`）、mime 按**字节魔数**、localStorage 只存元数据、
 * 二进制进 IndexedDB、认不出即拒 —— 本函数**不新增也不放宽**任何一条。
 * @param {{stampId:string, bitmap:object, sourceBytes?:Uint8Array|ArrayBuffer, note?:string, fileName?:string, crop?:object, maxSide?:number, quality?:number}} payload
 */
export async function uploadPhotoSource({ stampId, bitmap, sourceBytes, note = '', fileName = '', crop, maxSide, quality } = {}) {
  const prepared = await preparePhotoSource(bitmap, { crop, maxSide, quality, sourceBytes })
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason || 'ENCODE_FAILED', message: prepared.message, source: null, preview: prepared.preview || null }
  }
  const uploaded = await uploadPhoto({
    stampId,
    bytes: prepared.bytes,
    mime: prepared.mime,
    width: prepared.width,
    height: prepared.height,
    note,
    fileName
  })
  return {
    ...uploaded,
    /* 源图口径随上传结果一并回报（取证 / 排障用）：AVIF 能编就是 avif，编不出就是**实际格式**。 */
    source: {
      requested: prepared.requested,
      encoded: prepared.encoded,
      mime: prepared.mime,
      bytes: prepared.bytes ? prepared.bytes.length : 0,
      claimed: prepared.claimed,
      note: prepared.note
    },
    preview: prepared.preview || null
  }
}

/** 某张实拍图的二进制 → 可绘制源（展示侧切片 / 预览用；二进制只从数据层读）。 */
export async function photoBitmapOf(photoId) {
  const loaded = await loadPhotoDataUrl(photoId)
  if (!loaded.ok) return { ok: false, reason: loaded.reason || 'NOT_FOUND', message: loaded.message }
  const bitmap = await decodeImageInput(loaded.dataUrl)
  if (!bitmap) return { ok: false, reason: 'NOT_IMAGE', message: '實拍圖二進制解碼失敗' }
  return { ok: true, bitmap, meta: loaded.meta, message: '' }
}

/** 把逐块画布按原坐标拼回整图（拼接自证 / 导出；与 `seals.js` 同一实现，不另写一份几何）。 */
export { composeSliceTiles }

/* ============================================================================
   **實物照片雲端化（2026-11-27｜派單方偵察結論照抄，不再议）**
   ----------------------------------------------------------------------------
   【通道（重要，照偵察修正版）】
     · 管理三 op（`listSealPhotosAdmin` / `setSealPhotoHidden` / `deleteSealPhoto`）
       全在云函数 `xiai-user-token`（admin-token 的 SealPhoto 命中 0）⇒
       **不得**走 `services/admin.js::adminWriteGate`，正确通道 ＝
       `services/userWrite.js::userWriteGate` → `token.js::userGate`
       （与 `pullImportRows` / `listPendingCorrectionsForAdmin` 同路）。
     · 公开 `listSealPhotos` 照 `services/sealCards.js` 的模式：
       `callCloudFunction('xiai-user-token', {action:'public', op:'listSealPhotos', payload:{seal_id}})`。
     · 字节入云走 `displayFetch('/image/store')`（候选回退单点，每档 4s 超时）；
       ≤8MiB 大文件有超时风险 ⇒ 失败一律如实报，**绝不静默**。
   【本文件自限，逐条可机械判】
     ① 上传**只写云端两步**，从头到尾**不碰本机存储**（不调 `putPhotoBinary` / `savePhotoRows`）；
     ② 列表合并：云端行在前（`storage:'cloud'`），本机 IDB 遗留行在后（`local:true`）；
        同 `sha256` 只留云端份；`hidden` 行非管理员不可见、管理员可见且带「已隱藏」徽标；
     ③ 管理员数据源 ＝ `listSealPhotosAdmin`，**仅在管理员打开管理开关 / 进入页面时调**，不轮询；
     ④ 所有文案一律繁体（AC-72）。
   ============================================================================ */

/** 承载五个照片 op 的云函数名（本文件唯一出现处）。 */
const SEAL_PHOTO_FUNCTION_NAME = 'xiai-user-token'
/** 公开只读通道的 `action` 字面值（云函数 `index.js::handlePublic` 的分流判据）。 */
const SEAL_PHOTO_PUBLIC_ACTION = 'public'
/** 五个 op 名（与云函数注册面逐字一致；本文件唯一出现处）。 */
const SEAL_PHOTO_LIST_OP = 'listSealPhotos'
const SEAL_PHOTO_ADMIN_LIST_OP = 'listSealPhotosAdmin'
const SEAL_PHOTO_CREATE_OP = 'createSealPhoto'
const SEAL_PHOTO_HIDDEN_OP = 'setSealPhotoHidden'
const SEAL_PHOTO_DELETE_OP = 'deleteSealPhoto'
/** 按 op 收窄的回包读数键面（与云函数 `index.js` 的收窄面逐字同集；`token.js::gate` 只按声明透传）。 */
const SEAL_PHOTO_ADMIN_LIST_READOUT_KEYS = Object.freeze(['rows', 'count', 'truncated'])
const SEAL_PHOTO_DELETE_READOUT_KEYS = Object.freeze(['deleted', 'object_retained'])
/** 云端行的存储标记（本单合并单点；本机遗留行不带它）。 */
const PHOTO_STORAGE_CLOUD = 'cloud'
/** 云存储收件容器（服务端 `mime` 逐字值域只认它）。 */
const PHOTO_CLOUD_MIME = 'image/tiff'
/** 隐藏行给管理员的徽标字面（上屏繁体）。 */
export const PHOTO_HIDDEN_BADGE = '已隱藏'
/**
 * 「字节已在云端、但登记行失败」的固定前缀 —— **语义冻结**：
 * 影像已存雲端 / 登記失敗 / 重試不會重複上傳（内容寻址 ⇒ 同图不重复上传字节）。
 */
const PHOTO_REGISTER_FAIL_PREFIX = '影像已存雲端，但登記失敗；重試不會重複上傳。'

/** 64 位小写十六进制（与服务端 `normalize_digest` 同口径；不符 ⇒ 空串，不猜不补）。 */
function photoDigestOf(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase()
  if (text.length !== 64) return ''
  for (const ch of text) if (!'0123456789abcdef'.includes(ch)) return ''
  return text
}

/** 当前（或指定）账号是否可操作照片管理三钮 —— 与 `seals.canDeleteSeal` **同一把尺子**。 */
export function canManageSealPhotos(actor) {
  const user = actor || currentUser()
  return user !== null && user !== undefined && user.role === 'admin'
}

/** 云端行 → 合并视图行（补 `id` / `storage` / 徽标；不改服务端键面本身）。 */
function cloudPhotoRowOf(row) {
  const source = row && typeof row === 'object' ? row : {}
  const merged = Object.assign({}, source, {
    id: String(source.id || source._id || ''),
    storage: PHOTO_STORAGE_CLOUD,
    local: false
  })
  if (merged.hidden === true) merged.hidden_badge = PHOTO_HIDDEN_BADGE
  return merged
}

/** 本机 IDB 遗留行 → 合并视图行（`local:true` 标记；其余键原样）。 */
function localPhotoRowOf(row) {
  return Object.assign({}, row, { id: String((row && row.id) || ''), local: true })
}

/**
 * **合并单点**：云端行在前、本机遗留行在后；同 `sha256` 只留云端份；
 * `hidden` 行非管理员不可见（本端兜底，不只依赖服务端过滤）。
 */
function mergeSealPhotoRows(cloudRows, localRows, admin) {
  const cloud = []
  const seenIds = new Set()
  const cloudDigests = new Set()
  for (const raw of Array.isArray(cloudRows) ? cloudRows : []) {
    const row = cloudPhotoRowOf(raw)
    if (!row.id) continue
    if (!admin && row.hidden === true) continue
    if (seenIds.has(row.id)) continue
    seenIds.add(row.id)
    if (row.sha256) cloudDigests.add(row.sha256)
    cloud.push(row)
  }
  const local = []
  for (const raw of Array.isArray(localRows) ? localRows : []) {
    const row = localPhotoRowOf(raw)
    if (!row.id) continue
    if (row.sha256 && cloudDigests.has(row.sha256)) continue
    local.push(row)
  }
  return { rows: cloud.concat(local), cloudCount: cloud.length, localOnly: local.length }
}

/** 云端列表的结构化失败（`ok:false` ＋ 冻结 reason ＋ 可读文案；不编造行）。 */
function cloudListFailure(reply, fallbackMessage) {
  const reason = (reply && reply.reason) || 'STORAGE_UNAVAILABLE'
  const message = (reply && reply.message) || fallbackMessage
  return { ok: false, rows: [], cloudCount: 0, localOnly: 0, truncated: false, reason, message }
}

/**
 * 读云端照片行（公开面 / 管理面共用一个函数；**排序与上限只在服务端做一次**）。
 * @param {string} sealKey 印章编号（`seal_id` 与 `stamp_id` 在本仓同值）
 * @param {boolean} admin `true` ＝ 走 `listSealPhotosAdmin`（全量含 hidden）
 * @returns {Promise<{ok:boolean, rows:Array, truncated:boolean, reason?:string, message:string}>}
 */
async function fetchCloudSealPhotos(sealKey, admin) {
  if (admin) {
    const reply = await userWriteGate(SEAL_PHOTO_ADMIN_LIST_OP, { seal_id: sealKey }, {
      readoutKeys: SEAL_PHOTO_ADMIN_LIST_READOUT_KEYS
    })
    if (reply && reply.dev === true) {
      return {
        ok: false, rows: [], truncated: false, reason: 'STORAGE_UNAVAILABLE',
        message: '離線形態：未經雲端，雲端實物照片列表不可用；以下為本機舊照片。'
      }
    }
    if (!reply || reply.ok !== true) return cloudListFailure(reply, '雲端實物照片列表暫時不可用，請稍後再試。')
    const rows = Array.isArray(reply.rows) ? reply.rows : []
    return { ok: true, rows, truncated: reply.truncated === true, message: '' }
  }
  const reply = await callCloudFunction(SEAL_PHOTO_FUNCTION_NAME, {
    action: SEAL_PHOTO_PUBLIC_ACTION,
    op: SEAL_PHOTO_LIST_OP,
    payload: { seal_id: sealKey }
  })
  const result = (reply && reply.result) || null
  if (!reply || reply.ok !== true || !result || result.ok !== true) {
    return cloudListFailure(result || reply, '雲端實物照片列表暫時不可用，請稍後再試。')
  }
  return {
    ok: true,
    rows: Array.isArray(result.rows) ? result.rows : [],
    truncated: result.truncated === true,
    message: ''
  }
}

/**
 * **列表合并**：云端行在前、本机 IDB 遗留行在后；同 `sha256` 只留云端份；
 * `hidden` 行非管理员不可见、管理员可见且带「已隱藏」徽标。
 *
 * 云端列表失败时**仍交回本机行**并带可读 `message`（不静默、不假装全空）。
 * @param {string} stampId 印章编号（兼容入参）
 * @param {string} sealId 印章编号（服务端 `seal_id`；与 `stamp_id` 同值）
 * @param {{admin?:boolean}} [options] `admin` ＝ 走管理面全量列表（**只在管理员打开管理开关 /
 *   进入页面时调，不自动轮询**）
 * @returns {Promise<{ok:boolean, rows:Array, cloudCount:number, localOnly:number,
 *   truncated:boolean, reason?:string, message:string}>}
 */
export async function listSealPhotosMerged(stampId, sealId, options = {}) {
  const admin = options.admin === true
  const sealKey = String(sealId || stampId || '').trim()
  const localStamp = String(stampId || sealId || '').trim()
  const localRows = localStamp ? listPhotosByStamp(localStamp) : []
  if (!sealKey) {
    const fallback = { rows: localRows.map(localPhotoRowOf), cloudCount: 0, localOnly: 0, truncated: false }
    return Object.assign({ ok: false, reason: 'MISSING_STAMP', message: '未指定印章。' }, fallback)
  }
  const cloud = await fetchCloudSealPhotos(sealKey, admin)
  const merged = mergeSealPhotoRows(cloud.rows, localRows, admin)
  const message = cloud.truncated
    ? '雲端照片超過單次列表上限 200 張，已如實截斷顯示（其餘未列出）。'
    : cloud.message
  return {
    ok: cloud.ok,
    rows: merged.rows,
    cloudCount: merged.cloudCount,
    localOnly: merged.localOnly,
    truncated: cloud.truncated,
    reason: cloud.reason,
    message
  }
}

/**
 * **上传两步走 · 第 ① 步：字节入云**（`POST /image/store`，候选回退单点、每档 4s）。
 * 回包摘要必须与本地按字节算出的值逐字一致，否则明确失败（不采信自报值）。
 */
async function storePhotoBytesToCloud(payload) {
  const localDigest = sha256Hex(payload)
  const attempt = await displayFetch(
    '/image/store',
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: payload },
    {
      networkFailure: {
        reason: 'STORAGE_UNAVAILABLE',
        message: '影像暫時無法上傳雲端（本機權威存儲服務未就緒），請稍後再試；本次未登記任何照片行。'
      },
      failureOfReply: async (reply) => {
        let reason = ''
        let message = ''
        try {
          const face = await reply.json()
          reason = String((face && face.reason) || '')
          message = String((face && face.message) || '')
        } catch {
          reason = ''
        }
        return {
          reason: reason || 'STORAGE_UNAVAILABLE',
          message: message || '影像暫時無法上傳雲端，請稍後再試；本次未登記任何照片行。'
        }
      }
    }
  )
  if (!attempt.ok) return { ok: false, reason: attempt.reason, message: attempt.message }
  let body = null
  try {
    body = await attempt.reply.json()
  } catch {
    body = null
  }
  const digest = photoDigestOf(body && body.sha256)
  if (!digest) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: '影像入庫失敗：雲端未回可辨識的摘要；本次未登記任何照片行。' }
  }
  if (digest !== localDigest) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: '影像入庫失敗：雲端回讀摘要與本地按字節算出的摘要不一致；本次未登記任何照片行。' }
  }
  const bytesLength = Number(body && body.bytesLength)
  if (Number.isFinite(bytesLength) && bytesLength !== payload.length) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: '影像入庫失敗：雲端回讀體量與本地不一致；本次未登記任何照片行。' }
  }
  return { ok: true, sha256: digest, message: '' }
}

/**
 * **上传两步走（停写 IDB）**：① `displayFetch('/image/store')` 拿 `sha256`；
 * ② `userWriteGate('createSealPhoto', 8 键)`。
 *
 * ② 失败 ⇒ **不写 IDB**（本函数从头到尾不碰本机存储）、文案含「登記失敗」且
 * 「影像已存雲端…重試不會重複上傳」（内容寻址 ⇒ 重试不会重复上传字节）。
 * @param {{stampId:string, sealId:string, bytes:Uint8Array|ArrayBuffer|ArrayBufferView,
 *          mime?:string, width?:number, height?:number, note?:string}} payload
 * @returns {Promise<{ok:boolean, stored?:boolean, row?:object, reason?:string, message:string}>}
 */
export async function uploadSealPhotoCloud({ stampId, sealId, bytes, mime, width, height, note } = {}) {
  const user = currentUser()
  if (!user) return { ok: false, reason: 'UNAUTHENTICATED', message: '請先登錄後再上傳實物照片' }
  const sealKey = String(sealId || stampId || '').trim()
  if (!sealKey) return { ok: false, reason: 'MISSING_STAMP', message: '未指定印章' }
  const stampKey = String(stampId || sealKey)

  const payload = toUint8Array(bytes)
  if (!payload || payload.length === 0) {
    return { ok: false, reason: 'EMPTY_CONTENT', message: '照片內容爲空，請重新選擇文件' }
  }
  if (payload.length > PHOTO_ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'ARTIFACT_TOO_LARGE',
      message:
        `本機影像生成失敗：處理後影像 ${describeBytes(payload.length)} 超過入庫上限 ${describeBytes(PHOTO_ARTIFACT_MAX_BYTES)}。` +
        '這與「所選文件 ≤ 1 MB」的輸入上限是兩回事；請重試，或改用支持 WebP 編碼的瀏覽器後再上傳。'
    }
  }
  /* mime 以**字节魔数**为准（不采信调用方的声称值）。 */
  const actualMime = sniffBytesMime(payload)
  if (!isImageMime(actualMime)) {
    const claimed = String(mime || '').trim().toLowerCase()
    return {
      ok: false,
      reason: 'NOT_IMAGE',
      message: '這不是可用的圖片內容（無法識別圖片格式），請重新選擇圖片文件'
        + (claimed ? `（聲稱類型 ${claimed}）` : '')
    }
  }
  /* 服务端 `mime` 逐字值域只认 `image/tiff`（存储容器与印面面同口径）⇒ 非 TIFF 如实拒。 */
  if (actualMime !== PHOTO_CLOUD_MIME) {
    return {
      ok: false,
      reason: 'NOT_IMAGE',
      message: `雲端實物照片只收 ${PHOTO_CLOUD_MIME} 存儲件（本機當前產物為 ${actualMime}）；本次零上傳。`
    }
  }
  const finalWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : 0
  const finalHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.round(Number(height)) : 0
  if (!finalWidth || !finalHeight) {
    return { ok: false, reason: 'INVALID_VALUE', message: '缺少影像尺寸（寬 / 高須為正整數）；本次零上傳。' }
  }
  const trimmedNote = String(note || '').trim()
  if (trimmedNote.length > 200) {
    return { ok: false, reason: 'INVALID_VALUE', message: '備註超過 200 字；本次零上傳。' }
  }

  /* ① 字节入云（候选回退单点；失败如实交回，不静默）。 */
  const stored = await storePhotoBytesToCloud(payload)
  if (!stored.ok) return { ok: false, stored: false, reason: stored.reason, message: stored.message }

  /* ② 登记行（载荷封闭恰 8 键；身份类键由服务端拒）。**失败零 IDB 写入。** */
  const gate = await userWriteGate(SEAL_PHOTO_CREATE_OP, {
    seal_id: sealKey,
    stamp_id: stampKey,
    sha256: stored.sha256,
    bytes: payload.length,
    mime: actualMime,
    width: finalWidth,
    height: finalHeight,
    note: trimmedNote
  })
  if (!gate || gate.ok !== true) {
    const detail = gate && gate.message ? String(gate.message) : ''
    return {
      ok: false,
      stored: true,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: PHOTO_REGISTER_FAIL_PREFIX + (detail ? `服務端回覆：${detail}` : '')
    }
  }
  return { ok: true, stored: true, row: cloudPhotoRowOf(gate.row), message: '實物照片已上傳' }
}

/** 管理员「隱藏 / 取消隱藏」（`userWriteGate` 通道；服务端裁决，本层零判定）。 */
export async function setSealPhotoHidden(photoId, hidden) {
  const id = String(photoId || '').trim()
  if (!id) return { ok: false, reason: 'MISSING_REQUIRED', message: '未指定照片編號；本次零寫入。' }
  if (typeof hidden !== 'boolean') {
    return { ok: false, reason: 'INVALID_VALUE', message: '隱藏標記必須是布爾值；本次零寫入。' }
  }
  const gate = await userWriteGate(SEAL_PHOTO_HIDDEN_OP, { photo_id: id, hidden })
  if (!gate || gate.ok !== true) {
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || '隱藏狀態更新失敗；本次零寫入。'
    }
  }
  return {
    ok: true,
    row: cloudPhotoRowOf(gate.row),
    message: hidden ? '已隱藏該實物照片。' : '已取消隱藏該實物照片。'
  }
}

/** 管理员「刪照片行」（只删元数据行、**云对象保留**；成功回包 `{ok, deleted, object_retained}`）。 */
export async function deleteSealPhoto(photoId) {
  const id = String(photoId || '').trim()
  if (!id) return { ok: false, reason: 'MISSING_REQUIRED', message: '未指定照片編號；本次零刪除。' }
  const gate = await userWriteGate(SEAL_PHOTO_DELETE_OP, { photo_id: id }, {
    readoutKeys: SEAL_PHOTO_DELETE_READOUT_KEYS
  })
  if (!gate || gate.ok !== true) {
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || '刪除失敗；本次零刪除。'
    }
  }
  const retained = gate.object_retained === true
  return {
    ok: true,
    deleted: gate.deleted === true,
    object_retained: retained,
    message: retained
      ? '已刪除該實物照片行；影像檔案仍保留於雲端儲存（可日後清理）。'
      : '已刪除該實物照片行。'
  }
}
