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

/**
 * 雲端**展示件轉碼** op 名（本單新增；與雲函數 `OPS` 註冊面逐字一致）：
 * 瀏覽器不能原生解 TIFF ⇒ B 路在 `registerArtifact` 成功後追加一次
 * `ensureDisplayArtifact`（best-effort），由**服務端**把 `.tiff` 原圖轉碼成展示件 PNG
 * 並上傳到內容尋址展示鍵 `xiai/images/<摘要前兩位>/<摘要>.png`。
 */
export const ARTIFACT_ENSURE_DISPLAY_OP = 'ensureDisplayArtifact'

const HEX_DIGITS = '0123456789abcdef'

const STORE_DOWN_MESSAGE = '影像暫時無法入庫，請稍後再試（本機權威存儲服務未就緒）'
const STORE_FAIL_MESSAGE = '影像暫時無法入庫，請稍後再試'
const NOT_IMAGE_MESSAGE = '影像暫時無法顯示，請稍後再試'
const SERVICE_DOWN_MESSAGE = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'
const CLOUD_UPLOAD_DOWN_MESSAGE = '影像暫時無法入庫，請稍後再試（雲端存儲未就緒）'
const CLOUD_UPLOAD_FAIL_MESSAGE = '影像暫時無法入庫，請稍後再試（雲端存儲寫入失敗）'
const CLOUD_VERIFY_FAIL_MESSAGE = '影像入庫失敗：未取得雲端回讀校驗，本次未寫入任何影像行'
const CLOUD_UNCONFIGURED_MESSAGE = '影像入庫失敗：雲端寫入面未配置，無法完成回讀校驗'

/* ---------------------------------------------------------------------------
   失敗診斷（本單新增；**只在失敗時填**，成功路徑回包形狀一字不動）
   ---------------------------------------------------------------------------
   為什麼要有這一段：線上實測出現「重傳同一張圖（同一 sha）恆失敗」，而三面可能的真因
   （A 路回包、直傳這一步、`registerArtifact` 回讀覆核）在對外文案上**長得一模一樣**
   ⇒ 拿不到真因就無從修。本段把三面**串成一條可讀診斷**，只落兩處：
     ① 只讀單槽 `storeArtifactAttemptSnapshot()`（與 `displayArtifactAttemptSnapshot()` 同構）；
     ② **B 路**失敗的 `message` 末尾追加 `｜診斷：…`（A 路業務性拒絕的文案**一字不改** ——
        既有自檢「A 路失敗文案沿用舊口徑」的字面斷言照舊成立）。
   硬口徑：診斷串**不含密鑰 / URL / 手機號 / 摘要原文**（一律打碼）；不改變任何**成功**回包。
   --------------------------------------------------------------------------- */

/** 診斷標記前綴（繁體；固定分隔符，便於肉眼與腳本切分）。 */
const STORE_DIAG_TAG = '｜診斷：'

/** 最近一次寫入口失敗的結構化診斷（單槽只讀；無失敗 ⇒ `null`）。 */
let lastStoreAttempt = null

/** 讀取最近一次 `storeArtifactBytes` 失敗的結構化診斷（不改變任何回包形狀）。 */
export function storeArtifactAttemptSnapshot() {
  return lastStoreAttempt
}

/** 診斷打碼：URL / `cloud://` / 40 位以上長串（token、摘要、fileID）/ 手機號一律不落。 */
function redactDiagnostic(raw) {
  return String(raw === null || raw === undefined ? '' : raw)
    .replace(/https?:\/\/\S+/gi, '<URL>')
    .replace(/\bcloud:\/\/\S+/gi, '<CLOUD>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<REDACTED>')
    .replace(/\b\d{11}\b/g, '<PHONE>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 回包文本摘要（剝 HTML 標籤、截斷、打碼）。 */
function replySummaryOf(raw) {
  return redactDiagnostic(String(raw || '').replace(/<[^>]*>/g, ' ')).slice(0, 160)
}

/** 拋出物摘要（只取判別字段、打碼截斷；**不落載荷、不落地址**）。 */
function errorSummaryOf(error) {
  if (!error) return ''
  const picked = error.code || error.message || error.name || String(error)
  return redactDiagnostic(picked).slice(0, 160)
}

/**
 * A 路失敗回包的**可讀診斷面**：HTTP status ＋ 回包摘要文本 ＋ 結構化 `reason`。
 *
 * 讀法（**與既有行為逐字等價**）：有 `text()` ⇒ 先取文本、再自行 `JSON.parse`
 * （真實 `fetch` 的 `json()` 本來就是 `text().then(JSON.parse)`；先調 `json()` 會把體消耗掉、
 * 摘要文本就沒了）；無 `text()`（離線自檢的假回包只有 `json`）⇒ 退回 `json()`。
 * 取不到結構化 `reason` ⇒ 仍按舊口徑兜底 `'NOT_IMAGE'`。
 * @param {object|null} reply HTTP 回包
 * @returns {Promise<{status:number, reason:string, summary:string}>}
 */
async function readAuthorityFailureFace(reply) {
  const status = Number(reply && reply.status) || 0
  let raw = null
  if (reply && typeof reply.text === 'function') {
    try {
      raw = await reply.text()
    } catch {
      raw = null
    }
  }
  let payload = null
  if (raw !== null) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
  } else if (reply && typeof reply.json === 'function') {
    try {
      payload = await reply.json()
    } catch {
      payload = null
    }
  }
  const hasPayload = Boolean(payload) && typeof payload === 'object'
  const reason = hasPayload ? String(payload.reason || '') : ''
  const summary = hasPayload
    ? redactDiagnostic(String(payload.message || payload.error || JSON.stringify(payload))).slice(0, 160)
    : replySummaryOf(raw || '')
  return { status, reason: reason || 'NOT_IMAGE', summary }
}

/**
 * 「同一內容已存在」類回包判定（機械可判）：HTTP **409**，或 `reason` 字面含
 * `duplicate` / `exists` / `already` / `已存在` / `重複`（`重复`）。
 * **只**服務於「不當失敗、轉 B 路回讀覆核」這一個分支；不改寫任何 `reason` 字面值。
 * @param {number} status HTTP 狀態碼
 * @param {string} reason 結構化 `reason`
 * @returns {boolean}
 */
function isAuthorityExistsFace(status, reason) {
  if (Number(status) === 409) return true
  const text = String(reason || '').toLowerCase()
  if (!text) return false
  return (
    text.indexOf('duplicate') !== -1 ||
    text.indexOf('exists') !== -1 ||
    text.indexOf('already') !== -1 ||
    text.indexOf('已存在') !== -1 ||
    text.indexOf('重複') !== -1 ||
    text.indexOf('重复') !== -1
  )
}

/* A 路「已存在」類回包的內部標記 ＋ 失敗回包上的診斷側信道：一律用 `Symbol`（不進
   `Object.keys` / `JSON`）⇒ **失敗回包恰 3 鍵的形狀逐字不變**、成功回包一個鍵都不多。 */
const AUTHORITY_REPLAY_MARK = Symbol('xiai.authorityReplay')
const ATTEMPT_DIAG_MARK = Symbol('xiai.storeAttempt')

/** 在回包上掛診斷側信道（只掛失敗面；定義不了就沒有診斷，**不影響任何判定**）。 */
function attachAttemptDiag(result, diag) {
  if (result && typeof result === 'object') {
    try {
      Object.defineProperty(result, ATTEMPT_DIAG_MARK, { value: diag, enumerable: false, configurable: true, writable: true })
    } catch {
      /* 忽略：診斷是附加品，絕不改變判定 */
    }
  }
  return result
}

/** 讀回包上的診斷側信道（無 ⇒ `null`）。 */
function attemptDiagOf(result) {
  return (result && result[ATTEMPT_DIAG_MARK]) || null
}

/** 標記「A 路回的是已存在類回包」（`storeArtifactBytes` 據此單開冪等回放分支）。 */
function markAuthorityReplay(result) {
  if (result && typeof result === 'object') {
    try {
      Object.defineProperty(result, AUTHORITY_REPLAY_MARK, { value: true, enumerable: false, configurable: true, writable: true })
    } catch {
      /* 標記不了 ⇒ 按一般失敗走（**不會**誤轉 B 路） */
    }
  }
  return result
}

/** 讀「A 路回了已存在類回包」標記（導出供離線自檢斷言；不改變任何回包形狀）。 */
export function isAuthorityReplay(result) {
  return Boolean(result && result[AUTHORITY_REPLAY_MARK])
}

/** 把三面診斷壓成一條可讀串（打碼 ＋ 截斷；**零密鑰 / 零 URL / 零手機號**）。 */
function describeAttempt(diag) {
  const parts = []
  const authority = (diag && diag.authority) || null
  if (authority) {
    parts.push(
      `A路 HTTP ${authority.status || '-'} reason=${authority.reason || '-'}${authority.summary ? ` ${authority.summary}` : ''}`
    )
  }
  const cloud = (diag && diag.cloud) || null
  if (cloud) {
    const upload = cloud.upload || {}
    parts.push(`直傳 step=${upload.step || '-'} existedBefore=${upload.existedBefore === true ? 'true' : 'false'}`)
    if (upload.detail) parts.push(`直傳細節=${upload.detail}`)
    parts.push(
      cloud.register
        ? `register ok=${cloud.register.ok === true ? 'true' : 'false'} reason=${cloud.register.reason || '-'}${
            cloud.register.message ? ` ${cloud.register.message}` : ''
          }`
        : 'register 未執行'
    )
  }
  return redactDiagnostic(parts.join('；')).slice(0, 420)
}

/**
 * 失敗收口（**只在失敗時調**）：登記只讀單槽 ＋（僅當本輪走過 B 路）在 `message` 末尾追加診斷。
 * A 路業務性拒絕 / 預檢失敗 ⇒ **回包原樣返回**（文案一字不改，只登記快照）。
 * @returns {{ok:false, reason:string, message:string}} 恰 3 鍵
 */
function recordStoreFailure(result, authorityDiag, cloudDiag) {
  const diag = {
    at: new Date().toISOString(),
    route: cloudDiag ? 'A→B' : authorityDiag ? 'A' : 'pre-check',
    reason: String((result && result.reason) || ''),
    authority: authorityDiag || null,
    cloud: cloudDiag || null
  }
  lastStoreAttempt = diag
  if (!cloudDiag) return result
  const base = String((result && result.message) || STORE_FAIL_MESSAGE)
  return {
    ok: false,
    reason: (result && result.reason) || 'STORAGE_UNAVAILABLE',
    message: `${base}${STORE_DIAG_TAG}${describeAttempt(diag)}`
  }
}

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
  if (!cloudPath) {
    return attachAttemptDiag(
      { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: CLOUD_UPLOAD_FAIL_MESSAGE },
      { step: 'bad-key', existedBefore: false, retryRegister: false }
    )
  }
  const fileID = cloudBaseFileIdOf(cloudPath)
  if (artifactStorageProvider) {
    try {
      const injected = await artifactStorageProvider({ cloudPath, fileID, bytes })
      if (!injected || injected.ok !== true) {
        return attachAttemptDiag(
          {
            ok: false,
            reason: (injected && injected.reason) || 'STORAGE_UNAVAILABLE',
            message: (injected && injected.message) || CLOUD_UPLOAD_FAIL_MESSAGE
          },
          {
            step: 'provider-failed',
            existedBefore: Boolean(injected && injected.existedBefore === true),
            /* 注入面失敗 ⇒ 對象可能本就在（內容尋址）⇒ 允許交 `registerArtifact` 回讀覆核一次。 */
            retryRegister: true,
            detail: errorSummaryOf(injected && injected.message)
          }
        )
      }
      return attachAttemptDiag(
        { ok: true, cloudPath, fileID, existedBefore: injected.existedBefore === true, message: '' },
        { step: 'provider-ok', existedBefore: injected.existedBefore === true, retryRegister: false }
      )
    } catch (error) {
      return attachAttemptDiag(
        { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_FAIL_MESSAGE },
        { step: 'provider-threw', existedBefore: false, retryRegister: true, detail: errorSummaryOf(error) }
      )
    }
  }
  const app = await cloudBaseApp()
  if (!app || typeof app.uploadFile !== 'function') {
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_DOWN_MESSAGE },
      { step: 'app-unavailable', existedBefore: false, retryRegister: true }
    )
  }
  const existedBefore = await artifactObjectExisted(app, fileID)
  /* **內容尋址 ⇒ 冪等（本單）**：同一 sha 的對象在本輪之前已存在 ⇒ **跳過 `uploadFile`**，
     直接回 `ok:true, existedBefore:true`（後續 `registerArtifact` 會做服務端回讀覆核，
     不需要重複寫字節；覆核不成立仍會明確失敗，零偽數據）。 */
  if (existedBefore === true) {
    return attachAttemptDiag(
      { ok: true, cloudPath, fileID, existedBefore: true, message: '', skippedUpload: true },
      { step: 'skipped-existing', existedBefore: true, retryRegister: false }
    )
  }
  const file = makeUploadFile(bytes)
  if (!file) {
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_DOWN_MESSAGE },
      { step: 'no-file', existedBefore: false, retryRegister: true }
    )
  }
  try {
    await app.uploadFile({ cloudPath, filePath: file })
  } catch (error) {
    /* 直傳失敗 **≠** 對象不在（線上實測「重傳同一張圖恆失敗」即此形態：對象本就在桶裡）
       ⇒ 不當場判死，交 `storeViaCloud` 走一次 `registerArtifact` 服務端回讀覆核。 */
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UPLOAD_FAIL_MESSAGE, cloudPath, fileID },
      { step: 'upload-failed', existedBefore: false, retryRegister: true, detail: errorSummaryOf(error) }
    )
  }
  return attachAttemptDiag(
    { ok: true, cloudPath, fileID, existedBefore, message: '' },
    { step: 'uploaded', existedBefore, retryRegister: false }
  )
}

/**
 * **A 路**：交本機權威存儲 api（**回包口徑一字未改**；本單只加「失敗可讀診斷面」與
 * 「已存在類回包」的內部標記 —— 標記用 `Symbol`，不進 `Object.keys` / `JSON`）。
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
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: STORE_DOWN_MESSAGE },
      { route: 'A', status: 0, reason: 'STORAGE_UNAVAILABLE', summary: 'fetch 抛错（連不上本機權威存儲 api）', existsFace: false }
    )
  }
  if (!reply || !reply.ok) {
    /* 診斷面（HTTP status ＋ 回包摘要文本 ＋ 結構化 reason）**與判定分開取**：判定仍只認
       結構化 `reason`（取不到 ⇒ 舊口徑 `'NOT_IMAGE'`），診斷只進側信道，不改判定、不改文案。 */
    const face = reply
      ? await readAuthorityFailureFace(reply)
      : { status: 0, reason: 'STORAGE_UNAVAILABLE', summary: '' }
    const reason = face.reason || 'STORAGE_UNAVAILABLE'
    const existsFace = isAuthorityExistsFace(face.status, reason)
    const result = attachAttemptDiag(
      { ok: false, reason, message: STORE_FAIL_MESSAGE },
      { route: 'A', status: face.status, reason, summary: face.summary, existsFace }
    )
    /* 「同一內容已存在」類回包 ⇒ **不當失敗**：掛冪等回放標記，交 `storeArtifactBytes` 轉 B 路
       回讀覆核。這一分支**不在** `ARTIFACT_FALLBACK_REASONS` 之內（那張表仍只管「本機這一側
       不可用 / 形狀不可辨」），業務性拒絕的既有口徑一字不動。 */
    if (existsFace) markAuthorityReplay(result)
    return result
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
    return attachAttemptDiag(
      { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: STORE_FAIL_MESSAGE },
      {
        route: 'A',
        status: Number(reply.status) || 0,
        reason: 'UNRECOGNIZED_IMAGE',
        summary: '回包摘要面不成立（缺 sha256 / bytesLength，或與本地按字節算出的摘要不一致）',
        existsFace: false
      }
    )
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

/* ---------------------------------------------------------------------------
   ③ best-effort 展示件轉碼（本單）：B 路在 `registerArtifact` 成功後追加**一次**
   `ensureDisplayArtifact` —— 瀏覽器不能原生解 TIFF，展示件 PNG 由服務端轉碼並上傳
   到內容尋址展示鍵 `xiai/images/<摘要前兩位>/<摘要>.png`。
   **失敗隔離（硬口徑）**：一切失敗（dev 形態 / 服務端結構化拒絕 / 傳輸失敗 / 回包缺
   display 面）只**結構化登記**在 `displayArtifactAttemptSnapshot()`，**不上拋、不阻斷
   行寫入、不改變 `storeArtifactBytes` 的回包形狀**（含成功路徑）。
   --------------------------------------------------------------------------- */

/** 最近一次 best-effort 展示件轉碼的結構化登記（單槽；供離線自檢 / 取證讀數；無調用 ⇒ `null`）。 */
let lastDisplayAttempt = null

/** 讀取最近一次展示件轉碼的結構化登記（不改變任何寫入口回包形狀）。 */
export function displayArtifactAttemptSnapshot() {
  return lastDisplayAttempt
}

/**
 * 追加一次 `ensureDisplayArtifact`（best-effort）：**永不拋錯**。
 * @param {string} cloudPath 源件對象鍵（`…/<sha>.tiff`）
 * @param {string} digest 源件摘要（已與服務端回讀值比對一致）
 * @returns {Promise<object>} 結構化登記 `{at, op, cloudPath, sha256, ok, outcome, reason, message,
 *          displayKey, bytesLength, width, height}`
 */
async function ensureDisplayArtifactBestEffort(cloudPath, digest) {
  const record = {
    at: new Date().toISOString(),
    op: ARTIFACT_ENSURE_DISPLAY_OP,
    cloudPath,
    sha256: digest,
    ok: false,
    outcome: 'failed',
    reason: 'STORAGE_UNAVAILABLE',
    message: '',
    displayKey: '',
    bytesLength: 0,
    width: 0,
    height: 0
  }
  try {
    const gate = await userWriteGate(ARTIFACT_ENSURE_DISPLAY_OP, { cloudPath, sha256: digest })
    if (gate && gate.dev === true) {
      /* dev / 離線形態：`userGate` 直接放行（本門不算授權）⇒ 未經雲端 ⇒ 如實登記為跳過。 */
      record.outcome = 'skipped-dev'
      record.reason = 'STORAGE_UNAVAILABLE'
      record.message = 'dev / 離線形態：未經雲端，展示件轉碼跳過（best-effort）'
    } else if (!gate || gate.ok !== true) {
      /* 服務端業務拒絕 / 傳輸失敗 ⇒ 原樣登記（reason 不改寫）。 */
      record.reason = (gate && gate.reason) || 'STORAGE_UNAVAILABLE'
      record.message = (gate && gate.message) || ''
    } else {
      const display = gate.display || null
      if (display) {
        record.ok = true
        record.outcome = 'ok'
        record.reason = ''
        record.displayKey = String(display.displayKey || '')
        record.bytesLength = Number(display.bytesLength) || 0
        record.width = Number(display.width) || 0
        record.height = Number(display.height) || 0
      } else {
        /* 雲端 op 成功（`ok:true` ⇒ 展示件已由服務端轉碼並上傳）。`gate` 回包面未透傳
           `display` 明細（`src/services/token.js` 的回包白名單不在本單可改範圍）⇒ 展示鍵
           按**同一內容尋址規則**就地派生（與讀面單點同構：`…/<sha>.tiff` ⇒ `…/<sha>.png`），
           尺寸 / 體量**如實記 0（未取得）**，不編造讀數。 */
        record.ok = true
        record.outcome = 'ok'
        record.reason = ''
        record.displayKey = cloudPath.replace(/\.tiff$/, '.png')
        record.message = '雲端轉碼成功（display 明細未透傳；尺寸／體量未取得，如實記 0）'
      }
    }
  } catch {
    record.reason = 'STORAGE_UNAVAILABLE'
    record.message = ''
  }
  lastDisplayAttempt = record
  return record
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
async function storeViaCloud(body, localDigest, options = {}) {
  const uploaded = await cloudUploadArtifact(body, localDigest)
  const uploadDiag = attemptDiagOf(uploaded) || { step: 'unknown', existedBefore: false, retryRegister: false }
  /* 內容尋址 ⇒ 對象鍵只由摘要派生（唯一構造點）；直傳面沒吐鍵時按同一規則補齊，
     好讓「回讀覆核」這一支不依賴直傳這一步的回包形狀。 */
  let cloudPath = uploaded.cloudPath || artifactObjectKeyOf(localDigest)
  let existedBefore = uploaded.existedBefore === true
  if (!uploaded.ok) {
    /* **內容尋址 ⇒ 冪等（本單）**：直傳這一步失敗 **不等於**「對象不在」—— 同一 sha 的對象
       可能本就在桶裡（線上實測「重傳同一張圖恆失敗」正是這一形態：對象在、直傳這一步恆紅）。
       ⇒ 不當場判死：改交 `registerArtifact` **服務端回讀覆核**一次；回讀逐字驗過 ⇒ 成功
       （＝「同一 sha 的對象已存在」視作成功，且 `idempotent:true`）。
       回讀也不成立 ⇒ **照原樣結構化失敗**（零偽數據：一個字節都沒驗過就不報成功）。 */
    const retryable = uploadDiag.retryRegister === true && Boolean(cloudPath)
    if (!retryable) {
      return attachAttemptDiag(
        { ok: false, reason: uploaded.reason || 'STORAGE_UNAVAILABLE', message: uploaded.message },
        { route: 'B', upload: uploadDiag, register: null }
      )
    }
    /* 直傳沒寫成而回讀讀到 ⇒ 對象在本輪之前就已在（內容尋址下讀到的必是同一份字節）。 */
    existedBefore = true
  }
  const gate = await userWriteGate(ARTIFACT_REGISTER_OP, {
    cloudPath,
    sha256: localDigest,
    bytesLength: body.length
  })
  const registerDiag = { ok: false, reason: '', message: '' }
  if (gate && gate.dev === true) {
    /* dev / 離線形態：`userGate` 直接放行（**本門不算授權**）⇒ 未經雲端回讀覆核 ⇒ **結構化失敗**。 */
    registerDiag.reason = 'STORAGE_UNAVAILABLE'
    registerDiag.message = 'dev / 離線形態：未經雲端回讀覆核'
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_UNCONFIGURED_MESSAGE },
      { route: 'B', upload: uploadDiag, register: registerDiag }
    )
  }
  if (!gate || gate.ok !== true) {
    /* 服務端業務拒絕 ⇒ **原樣透傳**（`reason` / `message` 一個都不改寫）。 */
    registerDiag.reason = (gate && gate.reason) || 'STORAGE_UNAVAILABLE'
    registerDiag.message = (gate && gate.message) || CLOUD_UPLOAD_FAIL_MESSAGE
    return attachAttemptDiag(
      { ok: false, reason: registerDiag.reason, message: registerDiag.message },
      { route: 'B', upload: uploadDiag, register: registerDiag }
    )
  }
  const artifact = gate.artifact || null
  /* 雲端形態下成功回包**必須**帶回讀覆核面；缺它 ⇒ 形同「只信客戶端自報」⇒ 明確失敗。 */
  if (!artifact) {
    registerDiag.reason = 'STORAGE_UNAVAILABLE'
    registerDiag.message = CLOUD_VERIFY_FAIL_MESSAGE
    return attachAttemptDiag(
      { ok: false, reason: 'STORAGE_UNAVAILABLE', message: CLOUD_VERIFY_FAIL_MESSAGE },
      { route: 'B', upload: uploadDiag, register: registerDiag }
    )
  }
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
    registerDiag.reason = 'UNRECOGNIZED_IMAGE'
    registerDiag.message = CLOUD_VERIFY_FAIL_MESSAGE
    return attachAttemptDiag(
      { ok: false, reason: 'UNRECOGNIZED_IMAGE', message: CLOUD_VERIFY_FAIL_MESSAGE },
      { route: 'B', upload: uploadDiag, register: registerDiag }
    )
  }
  registerDiag.ok = true
  registerDiag.reason = ''
  registerDiag.message = ''
  /* ③ **best-effort 展示件轉碼（本單追加的一次 op 調用）**：`registerArtifact` 成功後追加
     `ensureDisplayArtifact`（服務端把 `.tiff` 原圖轉碼成展示件 PNG 並上傳到內容尋址展示鍵）。
     **失敗隔離**：一切失敗只結構化登記（`displayArtifactAttemptSnapshot()`），不上拋、
     不阻斷行寫入、**不改變本函數回包形狀**（既有 8 鍵逐字不動）。 */
  await ensureDisplayArtifactBestEffort(cloudPath, serverDigest)
  return {
    ok: true,
    sha256: serverDigest,
    bytesLength: serverBytes,
    mime: serverMime,
    relPath: artifactRelPathOf(serverDigest),
    storageKey: serverKey,
    /* `idempotent` 語義與 A 路對齊：**本輪之前對象已存在**（內容尋址 ⇒ 未新增字節 / 未新增寫入）。
       本單兩個「已存在」來源都算數：① 本機探針 `existedBefore === true`（跳過直傳那一支）；
       ② A 路回「已存在類回包」後轉來的冪等回放（`options.knownExisting`）。 */
    idempotent: existedBefore === true || options.knownExisting === true,
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
  if (body === null) return recordStoreFailure({ ok: false, reason: 'NOT_IMAGE', message: STORE_FAIL_MESSAGE }, null, null)
  if (body.length === 0) {
    return recordStoreFailure({ ok: false, reason: 'EMPTY_CONTENT', message: STORE_FAIL_MESSAGE }, null, null)
  }
  const localDigest = sha256Hex(body)
  const apiResult = await storeViaAuthorityApi(body, localDigest)
  if (apiResult.ok) return apiResult
  const authorityDiag = attemptDiagOf(apiResult)
  /* ②′ **冪等回放分支（本單；在 `ARTIFACT_FALLBACK_REASONS` 之外單開）**：A 路回的是「同一
     內容已存在」類回包（HTTP 409 / `reason` 含 duplicate·exists·已存在）⇒ **不當失敗**，
     轉 **B 路回讀覆核**（由 `registerArtifact` 服務端回讀重算、逐字比對才算數）。
     只在這一條件下走這條分支；其餘業務性拒絕仍按 ③ 原樣上拋、不換路。 */
  if (isAuthorityReplay(apiResult)) {
    const replayed = await storeViaCloud(body, localDigest, { knownExisting: true })
    if (replayed.ok) return replayed
    return recordStoreFailure(replayed, authorityDiag, attemptDiagOf(replayed))
  }
  if (ARTIFACT_FALLBACK_REASONS.indexOf(apiResult.reason || '') === -1) {
    return recordStoreFailure(apiResult, authorityDiag, null)
  }
  const cloudResult = await storeViaCloud(body, localDigest)
  if (cloudResult.ok) return cloudResult
  return recordStoreFailure(cloudResult, authorityDiag, attemptDiagOf(cloudResult))
}
