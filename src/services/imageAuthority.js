/**
 * 玺爱 · **xiai-api 權威存儲面客戶端（寫入口 ＋ 行級「按 digest 引用」分流口徑）**
 * ----------------------------------------------------------------------------
 * 本模塊只做兩件事，且各只做一件：
 *   ① **寫入口**：把**已在瀏覽器端成形的存儲件字節**交服務端權威存儲
 *      （`POST /api/image/store`，經同源代理 ⇒ 5163 → 5191）⇒ 取得 `sha256` / `bytesLength` /
 *      `relPath`；**本地不再落二進制**（影像行只存 digest ＋ 體量 ＋ 容器）。
 *   ② **讀取面的行級分流口徑（唯一一處定義點）**：以**行內是否有 digest** 判定
 *      `'digest'`（⇒ 三面走按 digest 引用的形態，**不需要本機字節**）
 *      `'local'`（⇒ 存量 / 本機二進制行，**一行未改**的既有本機路徑，零 api）。
 *
 * 分流口徑（**機械可判，不含任何猜測**）：
 *   · 行內無 `sha256`（或形態不是 64 位十六進制）⇒ **`local`**（存量行）；
 *   · 行內 `storage` 自報**非 `server`**（＝二進制在本機：`indexeddb` / 空 / 歷史值）
 *     ⇒ **`local`**（**存量守衛**：不得因本單把存量行強制改走 api —— §3.28.3 ② / AC-245）；
 *   · 僅當行內 digest 齊備 **且** `storage === 'server'` ⇒ **`digest`**（本單新寫入的行）。
 *
 * 紀律（本模塊自限，逐條可機械判）：
 *   ① **端基址恰 1 處** ＝ `services/displayImage.js::displayApiBase`（本文件只引用，不另立）；
 *   ② **只走凍結端點族**：寫入口 `POST /api/image/store`；本文件不新增任何路徑 / 方法；
 *   ③ **失敗一律結構化**（`{ok:false, reason, message}`；`reason` 取服務端凍結表值或
 *      `STORAGE_UNAVAILABLE`）；**零偽數據、零回落**（不以空件 / 假摘要冒充成功）；
 *   ④ **摘要自檢**：響應回的 `sha256` / `bytesLength` 必須與**本地按字節算出**的一致，
 *      否則**明確失敗**（不採信自報值 —— §3.12.10(b) / AC-141 同族）；
 *   ⑤ 本模塊**不做切分 / 幾何 / 轉碼**（真源仍恰 1 處 ＝ `src/tilesplicer/**` 與服務端）；
 *   ⑥ 所有文案一律**繁體**（AC-72）。
 */

import { displayApiBase } from './displayImage.js'
import { sha256Hex } from '../data/assetmeta.js'
import { STORAGE_MIME } from '../utils/image.js'

/** 權威存儲寫入口路徑（**唯一一處定義點**；方法固定 `POST`）。 */
export const AUTHORITY_STORE_PATH = '/image/store'

/** 行上「二進制在服務端權威庫」的標記值（本單新寫入的行一律落它）。 */
export const AUTHORITY_STORAGE_SERVER = 'server'

/** digest 形態：恰 64 位十六進制（與服務端 `store.normalize_digest` 同口徑）。 */
export const DIGEST_HEX_LENGTH = 64

const HEX_DIGITS = '0123456789abcdef'

const STORE_DOWN_MESSAGE = '影像暫時無法入庫，請稍後再試（本機權威存儲服務未就緒）'
const STORE_FAIL_MESSAGE = '影像暫時無法入庫，請稍後再試'
const NOT_IMAGE_MESSAGE = '影像暫時無法顯示，請稍後再試'
const SERVICE_DOWN_MESSAGE = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'

/** 真字節類 ⇒ 字節視圖；其餘一律 `null`（形狀認不出 ⇒ 明確失敗，不靜默放大）。 */
function bytesViewOf(payload) {
  if (payload instanceof Uint8Array) return payload
  if (typeof ArrayBuffer !== 'undefined' && payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  return null
}

/** digest 形態判定（大小寫歸一為小寫；不符 ⇒ 空串）。 */
export function normalizeDigest(raw) {
  if (raw === null || raw === undefined) return ''
  const text = String(raw).trim().toLowerCase()
  if (text.length !== DIGEST_HEX_LENGTH) return ''
  for (const ch of text) if (!HEX_DIGITS.includes(ch)) return ''
  return text
}

/** 行上的 digest（形態不符 ⇒ 空串 —— **不猜、不補**）。 */
export function digestOfRow(row) {
  return normalizeDigest(row && row.sha256)
}

/**
 * 行級讀取面分流（**唯一判據**）：`'digest'` ＝ 走按 digest 引用的三面形態；
 * `'local'` ＝ 本機 IndexedDB ＋ 瀏覽器原生解碼（存量 / 非源面容器）。
 * @param {object|null} row 影像行
 */
export function readViaOfRow(row) {
  if (!digestOfRow(row)) return 'local'
  const storage = String((row && row.storage) || '').trim().toLowerCase()
  if (storage !== AUTHORITY_STORAGE_SERVER) return 'local'
  return 'digest'
}

/** 失敗面：先取結構化 `reason`（服務端凍結表值），取不到再按字節面兜底為 `NOT_IMAGE`。 */
export async function reasonOfReply(reply) {
  try {
    const payload = await reply.json()
    const reason = String((payload && payload.reason) || '')
    if (reason) return reason
  } catch {
    /* 非 JSON 失敗體 ⇒ 落到兜底值 */
  }
  return 'NOT_IMAGE'
}

/** 展示面失敗文案（供調用方復用；本文件不新立任何格式 / 取值口徑）。 */
export const AUTHORITY_MESSAGES = {
  storeDown: STORE_DOWN_MESSAGE,
  storeFail: STORE_FAIL_MESSAGE,
  notImage: NOT_IMAGE_MESSAGE,
  serviceDown: SERVICE_DOWN_MESSAGE
}

/**
 * **寫入口**：存儲件字節 ⇒ 服務端權威存儲（內容尋址、冪等）。
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes 存儲件字節（**只收真字節類**）
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, sha256?:string, bytesLength?:number, mime?:string, relPath?:string,
 *          idempotent?:boolean, reason?:string, message:string}>}
 */
export async function storeArtifactBytes(bytes, options = {}) {
  const body = bytesViewOf(bytes)
  if (body === null) return { ok: false, reason: 'NOT_IMAGE', message: STORE_FAIL_MESSAGE }
  if (body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: STORE_FAIL_MESSAGE }
  let reply = null
  try {
    reply = await fetch(`${displayApiBase()}${AUTHORITY_STORE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: STORE_DOWN_MESSAGE }
  }
  if (!reply || !reply.ok) {
    const reason = reply ? await reasonOfReply(reply) : 'STORAGE_UNAVAILABLE'
    return { ok: false, reason: reason || 'STORAGE_UNAVAILABLE', message: STORE_FAIL_MESSAGE }
  }
  let payload = null
  try {
    payload = await reply.json()
  } catch {
    payload = null
  }
  const digest = normalizeDigest(payload && payload.sha256)
  const bytesLength = Number(payload && payload.bytesLength)
  const localDigest = sha256Hex(body)
  /* ④ 摘要自檢：形態不對 / 體量不符 / 與本地按字節算出的摘要不一致 ⇒ **明確失敗**。 */
  if (!digest || !Number.isFinite(bytesLength) || bytesLength !== body.length || digest !== localDigest) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: STORE_FAIL_MESSAGE }
  }
  return {
    ok: true,
    sha256: digest,
    bytesLength,
    mime: STORAGE_MIME,
    relPath: String((payload && payload.relPath) || ''),
    idempotent: String(reply.headers.get('X-Xiai-Idempotent') || '').toLowerCase() === 'true',
    message: ''
  }
}
