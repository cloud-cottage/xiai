/**
 * 玺爱 · 上传端「新影像管线」接线（**单一具名调用**；只调不改）
 * ----------------------------------------------------------------------------
 * R-83 / R-86：印面源文件＝**PNG 索引色（调色板恰 8 项、无彩色）**；实拍源文件＝**AVIF**；
 * 两类的产出由**服务层**提供 —— 本模块**只调用、不改写**，
 * **不得自写第二套编码**（同语义不得多处各自实现）。
 *
 * **R-95（收敛为单一具名调用）**：过期形态的「候选名探测 + 形状校验」**已删除**；
 * 就绪判据＝**唯一具名入口在服务层可调用**（名字以磁盘导出面为准，逐字登记在下方常量里）：
 *   - 印面：`services/seals.js` 的 `prepareFaceImageSource(bitmap, options)`（8 色索引 PNG）；
 *   - 实拍：`services/photos.js` 的 `preparePhotoSource(bitmap, options)`（AVIF 源文件）。
 * **没有探测分支、没有回落既有 WebP 管线**：入口不可调用 / 调用失败 / 产物形状不符
 * ⇒ **结构化失败 + 可读繁体提示**，绝不把形状异常的结果当成功、也不静默假装已接入。
 * 所有文案一律**繁体**（AC-72）。
 */

import * as sealService from '../services/seals.js'
import * as photoService from '../services/photos.js'

/** 印面源图（8 色索引 PNG）的**唯一**具名入口（`services/seals.js` 导出面逐字）。 */
export const FACE_PIPELINE_CALL = 'prepareFaceImageSource'

/** 实拍源文件（AVIF）的**唯一**具名入口（`services/photos.js` 导出面逐字）。 */
export const PHOTO_PIPELINE_CALL = 'preparePhotoSource'

/** 调用时透传的选项键（**只多不少**：两个入口各自取用自己认得的键，多余键被忽略）。 */
export const PIPELINE_OPTION_KEYS = ['crop', 'maxSide', 'maxBytes', 'quality', 'sourceBytes']

function entryOf(kind) {
  return kind === 'photo'
    ? { name: PHOTO_PIPELINE_CALL, ns: photoService, label: '實拍' }
    : { name: FACE_PIPELINE_CALL, ns: sealService, label: '印面' }
}

/**
 * 管線就緒讀數（模块内缓存；页面重载后重探测）。
 * @returns {{faceReady:boolean, photoReady:boolean, ready:boolean, faceFn:string, photoFn:string,
 *            faceMessage:string, photoMessage:string}}
 */
let cache = null

export function pipelineStatus() {
  if (cache) return cache
  const faceEntry = entryOf('face')
  const photoEntry = entryOf('photo')
  const faceFn = typeof faceEntry.ns[faceEntry.name] === 'function' ? faceEntry.name : ''
  const photoFn = typeof photoEntry.ns[photoEntry.name] === 'function' ? photoEntry.name : ''
  const missingFace = `新印面管線（8 色索引 PNG，services/seals.js 的 ${FACE_PIPELINE_CALL}）尚未就緒`
  const missingPhoto = `新實拍管線（AVIF，services/photos.js 的 ${PHOTO_PIPELINE_CALL}）尚未就緒`
  cache = {
    faceReady: Boolean(faceFn),
    photoReady: Boolean(photoFn),
    get ready() {
      return Boolean(faceFn && photoFn)
    },
    faceFn,
    photoFn,
    faceMessage: faceFn
      ? `新印面管線已就緒：${faceFn}（8 色索引 PNG）`
      : `${missingFace}；本次不提交未經管線處理的影像，請稍後重試。`,
    photoMessage: photoFn
      ? `新實拍管線已就緒：${photoFn}（AVIF 源文件）`
      : `${missingPhoto}；本次不提交未經管線處理的影像，請稍後重試。`
  }
  return cache
}

function toUint8Length(bytes) {
  if (bytes instanceof Uint8Array) return bytes.length
  if (bytes instanceof ArrayBuffer) return bytes.byteLength
  return 0
}

/**
 * 上传端**唯一出口**：按类别调**那一个具名入口**，并把服务层返回值归一成展示层口径。
 * @param {{kind:'face'|'photo', bitmap:object, options:object}} input
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, mime?:string, width?:number, height?:number,
 *                    message:string, notice:string, viaNewPipeline:boolean, artifact?:object}>}
 */
export async function runUploadPipeline({ kind, bitmap, options = {} }) {
  const entry = entryOf(kind)
  const fn = entry.ns[entry.name]
  if (typeof fn !== 'function') {
    const message = `${entry.label}影像管線未就緒（${entry.name} 不可用）：本次未提交任何內容，請稍後重試。`
    return { ok: false, message, notice: pipelineNotice(kind), viaNewPipeline: false }
  }
  const payload = {}
  PIPELINE_OPTION_KEYS.forEach((key) => {
    if (options[key] !== undefined) payload[key] = options[key]
  })
  let result = null
  try {
    result = await fn(bitmap, payload)
  } catch (err) {
    return {
      ok: false,
      message: `${entry.label}影像管線調用異常：${(err && err.message) || '未知原因'}（本次未提交任何內容）`,
      notice: '',
      viaNewPipeline: true
    }
  }
  if (!result || typeof result !== 'object' || result.ok !== true) {
    return {
      ok: false,
      message: (result && result.message) || `${entry.label}影像管線如實回報失敗（本次未提交任何內容）`,
      notice: '',
      viaNewPipeline: true
    }
  }
  if (!toUint8Length(result.bytes)) {
    return {
      ok: false,
      message: `${entry.label}影像管線返回值形狀不符（缺非空 bytes）：本次未提交任何內容。`,
      notice: '',
      viaNewPipeline: true
    }
  }
  return {
    ok: true,
    bytes: result.bytes,
    /* mime **一律采信服务层按字节魔数给出的读数**（不采信任何声称值，也不在此另判）。 */
    mime: result.mime || '',
    width: Math.round(Number(result.width) || 0),
    height: Math.round(Number(result.height) || 0),
    message: result.message || '',
    notice: result.note || '',
    viaNewPipeline: true,
    artifact: result
  }
}

/** 展示用的降级提示（入口不可用时挂给页面；就绪时为空串 ⇒ 界面零噪声）。 */
export function pipelineNotice(kind = 'face') {
  const status = pipelineStatus()
  const ready = kind === 'photo' ? status.photoReady : status.faceReady
  return ready ? '' : (kind === 'photo' ? status.photoMessage : status.faceMessage)
}
