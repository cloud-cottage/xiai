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
