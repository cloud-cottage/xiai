/**
 * 玺爱 · **占位图随包资产读取面**（影像例外｜仅 feicui/sealbank 来源）
 * ============================================================================
 * 背景：`placeholder/seal-no-image` **不是**内容寻址键（云端桶里没有这个对象），
 * `data/cloudbase.js::cloudBaseObjectKeyOf` 对它一律回空串 —— **刻意不为此放宽通用判据**。
 * 于是占位图的字节来源只有一处：**仓内随包资产**（`public/placeholders/seal-no-image.jpg`，
 * HTTP 站根相对路径 ⇒ `SEAL_PLACEHOLDER_IMAGE.asset_url`）。
 *
 * 口径（逐条）：
 *   · **只认登记键**：`isSealPlaceholderImageRow(row)` 按 `storage_key` 逐字比对常量，别的一律不认；
 *   · **字节数必须 ≡ 登记值**（`SEAL_PLACEHOLDER_IMAGE.bytes`）：不符 ⇒ **结构化失败**（不返回
 *     半张图、不静默降级成空图）；摘要一致性由 `scripts/verify-seal-placeholder.mjs` 在 CI 侧重算；
 *   · **零转码**：交出去的就是资产文件的字节（JPEG）；
 *   · 取不到（离线 / 资产缺失 / 非浏览器环境） ⇒ `{ok:false, message}`，由调用方如实上抛。
 */

import { SEAL_PLACEHOLDER_IMAGE } from '../data/seed.js'

/** 该影像行是否即占位图登记行（**唯一判据**：`storage_key` 逐字等于常量）。 */
export function isSealPlaceholderImageRow(row) {
  if (!row || typeof row !== 'object') return false
  return String(row.storage_key === undefined || row.storage_key === null ? '' : row.storage_key).trim() ===
    SEAL_PLACEHOLDER_IMAGE.key
}

/**
 * 读回占位图**资产字节**（随包文件；零转码、零网络存储）。
 * @returns {Promise<{ok:true, bytes:Uint8Array, mime:string, source:'bundled'}|{ok:false, message:string}>}
 */
export async function loadSealPlaceholderBytes() {
  if (typeof fetch !== 'function') {
    return { ok: false, message: '當前環境無 fetch ⇒ 占位圖（隨包資產）不可讀' }
  }
  try {
    const response = await fetch(SEAL_PLACEHOLDER_IMAGE.asset_url, { cache: 'force-cache' })
    if (!response || !response.ok) {
      return { ok: false, message: `占位圖資產讀取失敗（HTTP ${response ? response.status : '—'}）` }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== SEAL_PLACEHOLDER_IMAGE.bytes) {
      return {
        ok: false,
        message: `占位圖資產字節數與登記值不符（實得 ${bytes.length} ≠ 登記 ${SEAL_PLACEHOLDER_IMAGE.bytes}）⇒ 拒絕使用`
      }
    }
    return { ok: true, bytes, mime: SEAL_PLACEHOLDER_IMAGE.mime, source: 'bundled' }
  } catch (error) {
    return { ok: false, message: `占位圖資產讀取異常：${(error && error.message) || String(error)}` }
  }
}
