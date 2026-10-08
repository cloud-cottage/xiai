/**
 * 玺爱 · **權威存儲面客戶端（寫入口 ＋ 行級「按 digest 引用」分流口徑）**
 * ----------------------------------------------------------------------------
 * 本模塊只做兩件事，且各只做一件：
 *   ① **寫入口**：把**已在瀏覽器端成形的存儲件字節**交權威存儲方，取得 `sha256` / `bytesLength` /
 *      `relPath`（＋ 雲端路徑 `storageKey`）；**本地不再落二進制**（影像行只存 digest ＋ 體量 ＋ 容器）。
 *      **雙路（本單 M-1）**：
 *        · **A｜本機權威存儲 api**（原路，**一字未改**）：`POST /api/image/store`
 *          （端基址 ＝ `displayImage.js::displayApiBase`，dev 由 5163 代理到 5191）；
 *        · **B｜客戶端直傳雲存儲 ＋ 雲函數 `registerArtifact` 覆核**（**新增**）：本機 api
 *          **不可達 / 不可用**時（線上 Vercel 上 `/api/**` 恒被 SPA 兜底吞成 200 HTML ⇒ 原路必失敗），
 *          改用既有 SDK 裝載縫把字節**直傳對象存儲**（內容尋址鍵），再由雲函數**回讀該對象、
 *          自行重算摘要與體量**並與聲稱值逐字比對 ⇒ 一致才成功。
 *      **兩條路的對外回包形狀 / `reason` 字面值 / `idempotent` 語義一致**（不新增任何 `reason`）。
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
 *      **對象鍵 / fileID 恰 1 族** ＝ `data/cloudbase.js::cloudBaseFileIdOf`（本文件只引用，不另立）；
 *   ② **只走凍結端點族**：寫入口 `POST /api/image/store`（A 路）／雲函數 `registerArtifact` op（B 路）；
 *      本文件不新增任何路徑 / 方法；
 *   ③ **失敗一律結構化**（`{ok:false, reason, message}`；`reason` 取服務端凍結表值或
 *      `STORAGE_UNAVAILABLE` / `UNRECOGNIZED_IMAGE`）；**零偽數據、零回落**（不以空件 / 假摘要冒充成功）；
 *   ④ **摘要自檢**：兩條路都必須把**服務端回讀值**與**本地按字節算出**的值逐字比對，
 *      否則**明確失敗**（不採信自報值 —— §3.12.10(b) / AC-141 同族）。B 路**不採信客戶端自稱**：
 *      雲函數自己回讀重算，客戶端再拿回讀值與本地值對一次。
 *   ⑤ 本模塊**不做切分 / 幾何 / 轉碼**（真源仍恰 1 處 ＝ `src/tilesplicer/**` 與服務端）；
 *   ⑥ 所有文案一律**繁體**（AC-72）。
 */

import { displayApiBase } from './displayImage.js'
import { sha256Hex } from '../data/assetmeta.js'
import { STORAGE_MIME } from '../utils/image.js'
import { cloudBaseFileIdOf } from '../data/cloudbase.js'
import { cloudBaseApp } from '../data/cloudbaseFn.js'
import { userWriteGate } from './userWrite.js'

/** 權威存儲寫入口路徑（**唯一一處定義點**；方法固定 `POST`）。 */
export const AUTHORITY_STORE_PATH = '/image/store'

/** 行上「二進制在服務端權威庫」的標記值（本單新寫入的行一律落它）。 */
export const AUTHORITY_STORAGE_SERVER = 'server'

/** digest 形態：恰 64 位十六進制（與服務端 `store.normalize_digest` 同口徑）。 */
export const DIGEST_HEX_LENGTH = 64

/** 物件存儲的影像鍵根（與 `data/cloudbase.js::IMAGE_OBJECT_KEY_PATTERN` 同族）。 */
export const ARTIFACT_OBJECT_KEY_PREFIX = 'xiai/images'

/** 存儲件容器對應的擴展名（既有展示件行是 `png|webp`；**本面新增產物一律 `tiff`**）。 */
export const ARTIFACT_OBJECT_KEY_EXT = 'tiff'

/** 雲端登記 op 名（與雲函數 `OPS` 註冊面逐字一致）。 */
export const ARTIFACT_REGISTER_OP = 'registerArtifact'

const HEX_DIGITS = '0123456789abcdef'

const STORE_DOWN_MESSAGE = '影像暫時無法入庫，請稍後再試（本機權威存儲服務未就緒）'
const STORE_FAIL_MESSAGE = '影像暫時無法入庫，請稍後再試'
const NOT_IMAGE_MESSAGE = '影像暫時無法顯示，請稍後再試'
const SERVICE_DOWN_MESSAGE = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'
const CLOUD_UPLOAD_DOWN_MESSAGE = '影像暫時無法入庫，請稍後再試（雲端存儲未就緒）'
const CLOUD_UPLOAD_FAIL_MESSAGE = '影像暫時無法入庫，請稍後再試（雲端存儲寫入失敗）'
const CLOUD_VERIFY_FAIL_MESSAGE = '影像入庫失敗：未取得雲端回讀校驗，本次未寫入任何影像行'
const CLOUD_UNCONFIGURED_MESSAGE = '影像入庫失敗：雲端寫入面未配置，無法完成回讀校驗'

/**
 * **A 路回包落到「改用 B 路」的 `reason` 面**（機械可判；**封閉集合**）。
 *
 * 為什麼要有這張表（而不是「任何失敗都回落」）：業務性拒絕（如值域 / 上限 / 端點約定）**必須原樣
 * 上拋** —— 回落到另一條路只會把真因換成另一條路的真因，讓用戶看到與事實無關的提示。
 * 表內四個值全部是「**本機 api 這一側不可用 / 形狀不可辨**」：
 *   · `STORAGE_UNAVAILABLE` —— 連不上 / 500 / 網絡異常（**不可達**）；
 *   · `UNRECOGNIZED_IMAGE`  —— 回包不是可辨識的權威回覆（**線上 Vercel 的 SPA 兜底 200 HTML 就走這裡**）；
 *   · `NOT_IMAGE` / `EMPTY_CONTENT` —— 回包形狀不成立（同上，屬「這一側不可用」）。
 */
export const ARTIFACT_FALLBACK_REASONS = Object.freeze([
  'STORAGE_UNAVAILABLE',
  'UNRECOGNIZED_IMAGE',
  'NOT_IMAGE',
  'EMPTY_CONTENT'
])

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

/** 內容尋址對象鍵：`xiai/images/<摘要前兩位>/<摘要>.tiff`（**唯一構造點**）。 */
export function artifactObjectKeyOf(digest) {
  const text = normalizeDigest(digest)
  if (!text) return ''
  return `${ARTIFACT_OBJECT_KEY_PREFIX}/${text.slice(0, 2)}/${text}.${ARTIFACT_OBJECT_KEY_EXT}`
}

/** 權威庫**相對路徑形狀**：`<摘要前兩位>/<摘要>.tiff`（與既有 `authority_rel_path` 同形）。 */
export function artifactRelPathOf(digest) {
  const text = normalizeDigest(digest)
  if (!text) return ''
  return `${text.slice(0, 2)}/${text}.${ARTIFACT_OBJECT_KEY_EXT}`
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

/* ---------------------------------------------------------------------------
   B 路：客戶端直傳雲存儲（**對象存儲寫入縫**；離線自檢可注入）
   --------------------------------------------------------------------------- */

let artifactStorageProvider = null

/**
 * 注入「直傳」實現（**僅供離線自檢 / 宿主**；生產不注入 ⇒ 走真實 SDK app）。
 * 形狀：`async ({cloudPath, fileID, bytes}) => {ok:true, existedBefore:boolean} | {ok:false, reason, message}`。
 * @param {null|function(object):Promise<object>} fn
 */
export function setArtifactStorageProvider(fn) {
  artifactStorageProvider = typeof fn === 'function' ? fn : null
}

/** 直傳實現是否已注入（讀數用）。 */
export function artifactStorageInjected() {
  return artifactStorageProvider !== null
}

/** 上傳體（瀏覽器用 `File`，退而求其次 `Blob`；都取不到 ⇒ `null` ⇒ 明確失敗）。 */
function makeUploadFile(bytes) {
  try {
    if (typeof File === 'function') return new File([bytes], `artifact.${ARTIFACT_OBJECT_KEY_EXT}`, { type: STORAGE_MIME })
    if (typeof Blob === 'function') return new Blob([bytes], { type: STORAGE_MIME })
  } catch {
    return null
  }
  return null
}

/** 既有讀面機制探「該對象在本輪之前是否已存在」（`getTempFileURL` 的簽名鏈接；失敗 ⇒ 視為不存在）。 */
async function artifactObjectExisted(app, fileID) {
  if (!fileID || !app || typeof app.getTempFileURL !== 'function') return false
  try {
    const reply = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 300 }] })
    const list = (reply && (reply.fileList || (reply.data && reply.data.fileList))) || []
    const first = list[0] || null
    const url = String((first && (first.tempFileURL || first.download_url || first.downloadUrl)) || '').trim()
    return url !== ''
  } catch {
    return false
  }
}

/**
 * 直傳一份存儲件字節到**內容尋址鍵**。
 * @returns {Promise<{ok:boolean, cloudPath?:string, fileID?:string, existedBefore?:boolean,
 *          reason?:string, message:string}>}
 */
async function cloudUploadArtifact(bytes, digest) {
  const cloudPath = artifactObjectKeyOf(digest)
  if (!cloudPath) return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: CLOUD_UPLOAD_FAIL_MESSAGE }
  const fileID = cloudBaseFileIdOf(cloudPath)
  if (artifactStorageProvider) {
    try {
      const injected = await artifactStorageProvider({ cloudPath, fileID, bytes })
      if (!injected || injected.ok !== true) {
        return {
          ok: false,
          reason: (injected && injected.reason) || 'STORAGE_UNAVAILABLE',
          message: (injected && injected.message) || CLOUD_UPLOAD_FAIL_MESSAGE
        }
      }
      return { ok: true, cloudPath, fileID, existedBefore: injected.existedBefore === true, message: '' }
    } catch {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_FAIL_MESSAGE }
    }
  }
  const app = await cloudBaseApp()
  if (!app || typeof app.uploadFile !== 'function') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_DOWN_MESSAGE }
  }
  const existedBefore = await artifactObjectExisted(app, fileID)
  const file = makeUploadFile(bytes)
  if (!file) return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_DOWN_MESSAGE }
  try {
    await app.uploadFile({ cloudPath, filePath: file })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_FAIL_MESSAGE }
  }
  return { ok: true, cloudPath, fileID, existedBefore, message: '' }
}

/**
 * **A 路**：交本機權威存儲 api（既有實作**一字未改**，只把「不可用」這一類標出來供上層回落）。
 * @returns {Promise<{ok:true, sha256, bytesLength, mime, relPath, storageKey, idempotent, message}
 *          |{ok:false, reason:string, message:string}>}
 */
async function storeViaAuthorityApi(body, localDigest) {
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
  /* ④ 摘要自檢：形態不對 / 體量不符 / 與本地按字節算出的摘要不一致 ⇒ **明確失敗**
     （線上 Vercel 的 200 HTML 走的就是這一支 ⇒ 上層據 `reason` 表回落到 B 路）。 */
  if (!digest || !Number.isFinite(bytesLength) || bytesLength !== body.length || digest !== localDigest) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: STORE_FAIL_MESSAGE }
  }
  return {
    ok: true,
    sha256: digest,
    bytesLength,
    mime: STORAGE_MIME,
    relPath: String((payload && payload.relPath) || ''),
    /* A 路：二進制**不在客户端雲桶**（在本機權威庫）⇒ 行上 `storage_key` 仍為空串（既有口徑）。 */
    storageKey: '',
    idempotent: String(reply.headers.get('X-Xiai-Idempotent') || '').toLowerCase() === 'true',
    message: ''
  }
}

/**
 * **B 路**：直傳對象存儲 ＋ 雲函數 `registerArtifact` 回讀覆核。
 *
 * 覆核判據（逐條，缺一即失敗）：雲端回傳的 `sha256` / `bytesLength` **必須與本地按字節算出的
 * 逐字一致**、`mime` 必須是存儲件容器、`storageKey` 必須等於本地構造的對象鍵。
 * 只有雲端**真的回讀覆核過**才算成功 —— 未經雲端覆核（如 dev / 離線形態的放行）一律
 * **結構化失敗**（不得只信客戶端自報）。
 * @returns {Promise<{ok:boolean, sha256?:string, bytesLength?:number, mime?:string, relPath?:string,
 *          storageKey?:string, idempotent?:boolean, reason?:string, message:string}>}
 */
async function storeViaCloud(body, localDigest) {
  const uploaded = await cloudUploadArtifact(body, localDigest)
  if (!uploaded.ok) {
    return { ok: false, reason: uploaded.reason || 'STORAGE_UNAVAILABLE', message: uploaded.message }
  }
  const cloudPath = uploaded.cloudPath
  const gate = await userWriteGate(ARTIFACT_REGISTER_OP, {
    cloudPath,
    sha256: localDigest,
    bytesLength: body.length
  })
  if (gate && gate.dev === true) {
    /* dev / 離線形態：`userGate` 直接放行（**本門不算授權**）⇒ 未經雲端回讀覆核 ⇒ **結構化失敗**。 */
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UNCONFIGURED_MESSAGE }
  }
  if (!gate || gate.ok !== true) {
    /* 服務端業務拒絕 ⇒ **原樣透傳**（`reason` / `message` 一個都不改寫）。 */
    return {
      ok: false,
      reason: (gate && gate.reason) || 'STORAGE_UNAVAILABLE',
      message: (gate && gate.message) || CLOUD_UPLOAD_FAIL_MESSAGE
    }
  }
  const artifact = gate.artifact || null
  /* 雲端形態下成功回包**必須**帶回讀覆核面；缺它 ⇒ 形同「只信客戶端自報」⇒ 明確失敗。 */
  if (!artifact) return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_VERIFY_FAIL_MESSAGE }
  const serverDigest = normalizeDigest(artifact && artifact.sha256)
  const serverBytes = Number(artifact && artifact.bytesLength)
  const serverMime = String((artifact && artifact.mime) || '').trim().toLowerCase()
  const serverKey = String((artifact && artifact.storageKey) || '').trim()
  const verified =
    serverDigest !== '' &&
    Number.isFinite(serverBytes) &&
    serverDigest === localDigest &&
    serverBytes === body.length &&
    serverMime === STORAGE_MIME &&
    serverKey === cloudPath
  if (!verified) {
    return { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: CLOUD_VERIFY_FAIL_MESSAGE }
  }
  return {
    ok: true,
    sha256: serverDigest,
    bytesLength: serverBytes,
    mime: serverMime,
    relPath: artifactRelPathOf(serverDigest),
    storageKey: serverKey,
    /* `idempotent` 語義與 A 路對齊：**本輪之前對象已存在**（內容尋址 ⇒ 未新增字節 / 未新增寫入）。 */
    idempotent: uploaded.existedBefore === true,
    message: ''
  }
}

/**
 * **寫入口（雙路）**：存儲件字節 ⇒ 權威存儲（內容尋址、冪等）。
 *
 * 選擇順序（**逐條可機械判**）：
 *   ① 先走 **A 路**（本機權威存儲 api）；
 *   ② A 路**成功** ⇒ 直接回；A 路失敗且 `reason` **在 `ARTIFACT_FALLBACK_REASONS` 之內**
 *      （＝本機這一側不可達 / 形狀不可辨）⇒ 走 **B 路**（直傳 ＋ `registerArtifact` 回讀覆核）；
 *   ③ A 路失敗但 `reason` **不在**表內（業務性拒絕）⇒ **原樣上拋**，不改走 B 路。
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes 存儲件字節（**只收真字節類**）
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, sha256?:string, bytesLength?:number, mime?:string, relPath?:string,
 *          storageKey?:string, idempotent?:boolean, reason?:string, message:string}>}
 */
export async function storeArtifactBytes(bytes, options = {}) {
  const body = bytesViewOf(bytes)
  if (body === null) return { ok: false, reason: 'NOT_IMAGE', message: STORE_FAIL_MESSAGE }
  if (body.length === 0) return { ok: false, reason: 'EMPTY_CONTENT', message: STORE_FAIL_MESSAGE }
  const localDigest = sha256Hex(body)
  const apiResult = await storeViaAuthorityApi(body, localDigest)
  if (apiResult.ok) return apiResult
  if (ARTIFACT_FALLBACK_REASONS.indexOf(apiResult.reason || '') === -1) return apiResult
  return await storeViaCloud(body, localDigest)
}
