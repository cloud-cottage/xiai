/**
 * 玺爱 · 影像二进制落盘底座（IndexedDB）
 *
 * **本文件是全工程唯一允许直接读写 IndexedDB 的模块**（与 `storage.js` 对 localStorage
 * 的独占比对称）。理由见规范 §3.2 收口注 ① / §4.1.3 表下注：`localStorage` 上限约 5 MB，
 * 单张 400 dpi 印面图就可能几百 KB，直接塞必炸 ⇒ **二进制走 IndexedDB、`localStorage`
 * 只存元数据**。
 *
 * 纪律：
 *   - 页面 / 组件 / 服务层**不得**直接 import 本文件；唯一入口是数据层 `db.js` 暴露的
 *     `putImageBinary` / `getImageBinary` / `hasImageBinary` / `deleteImageBinary`。
 *   - **任何失败都返回可读的 `{ok:false, reason, message}`，绝不向上抛未捕获异常**
 *     （规范 §10.8 AC-30 判负形态：拒绝路径不得抛未捕获异常）。
 *   - 不新增第三方依赖，只用浏览器原生 IndexedDB。
 */

/** 库名与对象仓名。**不得**在别处再开第二个库名（避免影像散落多库）。 */
export const BLOBSTORE_DB_NAME = 'xiai:v1:assetblobs'
export const BLOBSTORE_DB_VERSION = 1
export const BLOBSTORE_STORE = 'assets'

/** 影像二进制键口径：`asset:<影像 id>`（与 §4.1.3 `asset.id` 一一对应）。 */
export function assetBlobKey(assetId) {
  return `asset:${String(assetId || '')}`
}

/**
 * 实物照片二进制键口径：`photo:<照片 id>`（与 §4.1.7 `photo.id` 一一对应）。
 *
 * **只增不改**：`asset:` 前缀与 `assetBlobKey` 的行为一字未动（印面图 / 边款图仍按原键读写）。
 * 与 `asset:` 前缀并列放在**同一个库、同一个对象仓**里，避免影像散落多库。
 */
export function photoBlobKey(photoId) {
  return `photo:${String(photoId || '')}`
}

/** 与 `storage.js` 同样的容错口径：读不到 / 环境不支持一律走 `{ok:false}`，不抛。 */
function idbFactory() {
  if (typeof indexedDB !== 'undefined' && indexedDB) return indexedDB
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB
  return null
}

let dbPromise = null

function openDb() {
  const factory = idbFactory()
  if (!factory) return Promise.resolve({ ok: false, message: '當前環境不支持影像本地存儲（IndexedDB 不可用）' })
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    let request
    try {
      request = factory.open(BLOBSTORE_DB_NAME, BLOBSTORE_DB_VERSION)
    } catch (err) {
      resolve({ ok: false, message: `影像存儲打開失敗：${(err && err.message) || '未知原因'}` })
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BLOBSTORE_STORE)) db.createObjectStore(BLOBSTORE_STORE)
    }
    request.onsuccess = () => resolve({ ok: true, db: request.result })
    request.onerror = () =>
      resolve({ ok: false, message: `影像存儲打開失敗：${(request.error && request.error.message) || '未知原因'}` })
    request.onblocked = () => resolve({ ok: false, message: '影像存儲被其它標籤頁佔用，請關閉其它標籤頁後重試' })
  })
  return dbPromise
}

/** 统一的 IDB 操作包装：**所有**异常在此收口为可读结果。 */
async function withStore(mode, run) {
  const opened = await openDb()
  if (!opened.ok) return { ok: false, reason: 'UNAVAILABLE', message: opened.message }
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      const tx = opened.db.transaction(BLOBSTORE_STORE, mode)
      const store = tx.objectStore(BLOBSTORE_STORE)
      const request = run(store)
      tx.oncomplete = () => done({ ok: true, result: request ? request.result : undefined })
      tx.onabort = () =>
        done({ ok: false, reason: 'ABORTED', message: `影像存儲寫入未完成：${(tx.error && tx.error.message) || '存儲空間可能已滿'}` })
      tx.onerror = () =>
        done({ ok: false, reason: 'FAILED', message: `影像存儲操作失敗：${(tx.error && tx.error.message) || '未知原因'}` })
    } catch (err) {
      done({ ok: false, reason: 'FAILED', message: `影像存儲操作失敗：${(err && err.message) || '未知原因'}` })
    }
  })
}

/**
 * 落盘一份二进制。
 * @param {string} key `assetBlobKey(assetId)`
 * @param {Uint8Array|ArrayBuffer|Blob} data
 * @returns {Promise<{ok:boolean, key?:string, bytes?:number, message?:string}>}
 */
export async function putBlob(key, data) {
  if (!key) return { ok: false, reason: 'BAD_KEY', message: '影像存儲鍵爲空' }
  if (data === null || data === undefined) return { ok: false, reason: 'BAD_DATA', message: '影像內容爲空' }
  let payload = data
  try {
    if (typeof Blob !== 'undefined' && data instanceof Blob) payload = new Uint8Array(await data.arrayBuffer())
  } catch (err) {
    return { ok: false, reason: 'BAD_DATA', message: `影像內容讀取失敗：${(err && err.message) || '未知原因'}` }
  }
  const out = await withStore('readwrite', (store) => store.put(payload, key))
  if (!out.ok) return out
  const bytes = payload && typeof payload.byteLength === 'number' ? payload.byteLength : 0
  return { ok: true, key, bytes }
}

/**
 * 读回二进制。
 * @returns {Promise<{ok:boolean, bytes?:Uint8Array, bytesLength?:number, mime?:string, shape?:string, message?:string}>}
 */
export async function getBlob(key) {
  if (!key) return { ok: false, reason: 'BAD_KEY', message: '影像存儲鍵爲空' }
  const out = await withStore('readonly', (store) => store.get(key))
  if (!out.ok) return out
  const value = out.result
  if (value === undefined || value === null) {
    return { ok: false, reason: 'NOT_FOUND', message: '影像二進制不在本地存儲中（可能未上傳成功）' }
  }
  if (value instanceof Uint8Array) {
    return { ok: true, bytes: value, bytesLength: value.byteLength, shape: 'Uint8Array' }
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    return { ok: true, bytes, bytesLength: bytes.byteLength, mime: value.type || '', shape: 'Blob' }
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer)
    return { ok: true, bytes, bytesLength: bytes.byteLength, shape: 'ArrayBuffer' }
  }
  return { ok: false, reason: 'BAD_DATA', message: '影像二進制形態無法識別' }
}

/**
 * 删除一份二进制。
 * @returns {Promise<{ok:boolean, deleted:boolean, message?:string}>}
 */
export async function deleteBlob(key) {
  if (!key) return { ok: false, reason: 'BAD_KEY', message: '影像存儲鍵爲空', deleted: false }
  const existed = await hasBlob(key)
  const out = await withStore('readwrite', (store) => store.delete(key))
  if (!out.ok) return { ...out, deleted: false }
  return { ok: true, deleted: existed === true }
}

/** 是否已有该键（用于「不重复落库」判重与自检）。 */
export async function hasBlob(key) {
  if (!key) return false
  const out = await withStore('readonly', (store) => store.getKey(key))
  if (!out.ok) return false
  return out.result !== undefined && out.result !== null
}

/** 枚举全部影像键（自检用：核对二进制真的落在本库里）。 */
export async function listBlobKeys() {
  const out = await withStore('readonly', (store) => store.getAllKeys())
  if (!out.ok) return []
  return Array.isArray(out.result) ? out.result.map((key) => String(key)) : []
}

/** 仅用于自测 / 诊断：上报底层可用性与库名（不改任何数据）。 */
export function blobstoreInfo() {
  return {
    available: idbFactory() !== null,
    db: BLOBSTORE_DB_NAME,
    version: BLOBSTORE_DB_VERSION,
    store: BLOBSTORE_STORE
  }
}
