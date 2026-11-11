/**
 * 玺爱 · **广场卡片分頁服務**（首屏 48 枚 ＋ `next_cursor` 續拉）
 * ============================================================================
 * 【為什麼有這一層】改前廣場靠「雲端全量水合」才能出圖：`seals.listSeals()` 要等 11,800 行
 *   `seals` / `faces` / `images` 全部落到快照裡，再在**主線程**逐印章組裝視圖模型 ⇒ 實測首屏
 *   28〜42 秒。本單把列表改成**分頁消費雲函數的匿名 action `listSealCards`**：
 *     · 首屏只請求 48 枚；滾到底 / 按「載入更多」按 `next_cursor` 續拉；
 *     · 四個篩選維度**下推**為請求參數（不再客戶端全量過濾）；
 *     · 封面圖直接取行上的 `thumb_key` / `display_key`（已是
 *       `xiai/images/<sha 前兩位>/<sha>.png` 形態）⇒ **不再依賴全量水合的 seals/faces 映射**。
 *
 * 【凍結契約（本文件只消費，不自造字段）】
 *   請求 payload：`{ limit, cursor, dynasty, seal_type, face_style, category }`
 *   回包：`{ ok, rows, next_cursor, has_more, total }`；`rows` 元素**恰 14 鍵**：
 *     `stamp_id, seal_name, dynasty, category, primary_face_id, face_count, edge_count,
 *      image_id, image_sha256, image_mime, width, height, thumb_key, display_key`
 *   **0 面印章不會出現**在 rows（本層另做一道防禦性過濾，契約側漏了也不上屏空卡）。
 *
 * 【降級路徑（必須保留）】無雲端（未配置 / 呼叫失敗）⇒ 走**本機示範資料**：用既有的
 *   `seals.listSeals()`（保留 `CLOUD_PAGE_SIZE` 等既有常量與全量讀面，其它頁面照舊）
 *   在本地做同一套四維篩選並按 offset 切片 ⇒ 廣場照樣可用，且 `fallback: true` 讓視圖
 *   顯式告知「目前列的是本機示範資料」，**不靜默**。
 *
 * 【分層紀律】本文件屬 services 層：只消費 `data/*` 與其它 services，不自碰 localStorage /
 *   IndexedDB；視圖與組件只經 `services/index.js` 門面進來。
 */

import { callCloudFunction, cloudBaseApp } from '../data/cloudbaseFn.js'
import { cloudBaseConfigured, cloudBaseFileIdDenial, cloudBaseFileIdOf, IMAGE_OBJECT_KEY_PATTERN } from '../data/cloudbase.js'
import { listSeals } from './seals.js'

/* ---------------------------------------------------------------------------
 * 1. 分頁與契約常量（唯一真源；改條數只改這裡）
 * ------------------------------------------------------------------------- */

/** 首屏 / 每頁條數（凍結契約的默認 `limit`）。 */
export const SQUARE_PAGE_SIZE = 48

/** 續拉請求上限（防御：視圖 / 誤用傳大值時仍不至於把首屏拖回全量）。 */
export const SQUARE_PAGE_MAX_LIMIT = 96

/** 承載 `listSealCards` 的雲函數名（**唯一真源**：雲函數側若掛到別的函數，只改這一行）。 */
export const SEAL_CARDS_FUNCTION_NAME = 'xiai-user-token'

/** 匿名 action 名（與雲函數註冊面逐字一致）。 */
export const SEAL_CARDS_ACTION = 'listSealCards'

/** `rows` 元素**恰 14 鍵**（順序即契約順序；取證可逐字比對）。 */
export const SEAL_CARD_ROW_KEYS = Object.freeze([
  'stamp_id',
  'seal_name',
  'dynasty',
  'category',
  'primary_face_id',
  'face_count',
  'edge_count',
  'image_id',
  'image_sha256',
  'image_mime',
  'width',
  'height',
  'thumb_key',
  'display_key'
])

/**
 * **篩選映射表（UI 維度 → 請求參數｜逐字凍結）**：
 *   ① 朝代 `dynasty`        → `dynasty`
 *   ② 印面內容 `content`    → `seal_type`
 *   ③ 印面風格 `style`      → `face_style`
 *   ④ 大類 `sealClass`      → `category`
 * 視圖側的參數名沿用既有 URL query 名（`content` / `style` / `sealClass`），
 * 本表是唯一翻譯點 ⇒ **不得在視圖裡各自拼參數**。
 */
export const SQUARE_FILTER_PARAMS = Object.freeze({
  dynasty: 'dynasty',
  content: 'seal_type',
  style: 'face_style',
  sealClass: 'category'
})

/** 本地降級路徑的游標前綴（`off:<offset>`；雲端游標不透明，本層不解析）。 */
const LOCAL_CURSOR_PREFIX = 'off:'

/** 本地降級路徑的游標：offset → 串。 */
function localCursorOf(offset) {
  return `${LOCAL_CURSOR_PREFIX}${Math.max(0, Number(offset) || 0)}`
}

/** 本地降級路徑的游標解析：只認本層產出的形態；其餘一律當首頁。 */
function localOffsetOf(cursor) {
  const text = String(cursor === undefined || cursor === null ? '' : cursor).trim()
  if (!text.startsWith(LOCAL_CURSOR_PREFIX)) return 0
  const n = Number(text.slice(LOCAL_CURSOR_PREFIX.length))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return SQUARE_PAGE_SIZE
  return Math.min(Math.floor(n), SQUARE_PAGE_MAX_LIMIT)
}

function textOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

function intOf(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/* ---------------------------------------------------------------------------
 * 2. 請求組裝（純函數；可離線自檢）
 * ------------------------------------------------------------------------- */

/**
 * 由視圖的四維篩選組出請求 payload（**恰 6 鍵，鍵名逐字凍結**）。
 * 空值一律傳空串（雲端按「空串 ⇒ 不篩」處理），不傳 `undefined` / `null`。
 * @param {{dynasty?:string, content?:string, style?:string, sealClass?:string,
 *          cursor?:string, limit?:number}} input
 * @returns {{limit:number, cursor:string, dynasty:string, seal_type:string,
 *            face_style:string, category:string}}
 */
export function sealCardsRequestOf(input = {}) {
  const source = input || {}
  return {
    limit: clampLimit(source.limit),
    cursor: textOf(source.cursor).trim(),
    [SQUARE_FILTER_PARAMS.dynasty]: textOf(source.dynasty).trim(),
    [SQUARE_FILTER_PARAMS.content]: textOf(source.content).trim(),
    [SQUARE_FILTER_PARAMS.style]: textOf(source.style).trim(),
    [SQUARE_FILTER_PARAMS.sealClass]: textOf(source.sealClass).trim()
  }
}

/**
 * 把一行雲端回包**收窄成恰 14 鍵**的卡片行（型別歸一；不新增、不改名、不補編造值）。
 * @returns {object|null} 收不下（無 `stamp_id` / 0 面）⇒ `null`（呼叫方統計後丟棄）
 */
export function normalizeSealCardRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const row = {
    stamp_id: textOf(raw.stamp_id).trim(),
    seal_name: textOf(raw.seal_name),
    dynasty: textOf(raw.dynasty),
    category: textOf(raw.category),
    primary_face_id: textOf(raw.primary_face_id),
    face_count: intOf(raw.face_count),
    edge_count: intOf(raw.edge_count),
    image_id: textOf(raw.image_id),
    image_sha256: textOf(raw.image_sha256),
    image_mime: textOf(raw.image_mime),
    width: intOf(raw.width),
    height: intOf(raw.height),
    thumb_key: textOf(raw.thumb_key).trim(),
    display_key: textOf(raw.display_key).trim()
  }
  /* 契約明文「0 面印章不會出現」——照收但不讓它上屏（防禦性過濾，零猜值）。 */
  if (!row.stamp_id || row.face_count <= 0) return null
  return row
}

/**
 * 回包取值（**同時認服務端信封的三種合理落點**：頂層 / `value` / `data`）。
 *
 * 為什麼要認 `value`：雲函數 `index.js` 的成功回包是**固定白名單**；新 op 的讀數鍵若沒被
 * 白名單放行、又沒走 `value` 位，就會被靜默丟棄（前端表現成「形狀不可辨識」而後端其實成功）。
 * 本層不改雲函數 ⇒ 先把三種落點都認下來，並在報告裡點名「需把 `rows`/`next_cursor`/
 * `has_more`/`total` 加進白名單或塞進 `value`」。
 * @returns {object|null} 帶 `rows` 陣列的那一層；認不出 ⇒ `null`
 */
export function sealCardsReadoutsOf(result) {
  const candidates = [result, result && result.value, result && result.data]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.rows)) return candidate
  }
  return null
}

/**
 * 由可辨識的回包讀數組出**一頁**（純函數；`rows` 逐行收窄成恰 14 鍵、`has_more` 以服務端為準）。
 * @param {{rows:Array, next_cursor?:string, has_more?:boolean, total?:number}} readouts
 */
export function sealCardPageOfReadouts(readouts) {
  const rows = readouts.rows.map(normalizeSealCardRow).filter(Boolean)
  const nextCursor = textOf(readouts.next_cursor).trim()
  /* `has_more` 以服務端為準；服務端沒給 ⇒ 只在有游標時樂觀為 true（游標缺 ⇒ 不能續拉）。 */
  const hasMore = typeof readouts.has_more === 'boolean' ? readouts.has_more : nextCursor !== ''
  const total = Number.isFinite(Number(readouts.total))
    ? Math.max(0, Math.floor(Number(readouts.total)))
    : rows.length
  return {
    ok: true,
    rows,
    next_cursor: hasMore ? nextCursor : '',
    has_more: hasMore && nextCursor !== '',
    total,
    source: 'cloud',
    fallback: false
  }
}

/* ---------------------------------------------------------------------------
 * 3. 本機示範資料（降級路徑｜不得刪）
 * ------------------------------------------------------------------------- */

/**
 * 由本機印章視圖模型（`seals.listSeals()` 的行）組出**同名 14 鍵**的卡片行。
 * 本機行沒有內容尋址對象鍵 ⇒ `thumb_key` / `display_key` 一律空串
 * （卡片據此走既有的本機解碼路徑，**不編造**對象鍵、也不假裝是雲端展示件）。
 */
function cardRowOfLocalSeal(seal) {
  if (!seal || !seal.stamp_id) return null
  const faces = Array.isArray(seal.faces) ? seal.faces : []
  const faceCount = faces.filter((face) => face && face.kind !== 'EDGE').length
  const edgeCount = faces.filter((face) => face && face.kind === 'EDGE').length
  const primary = seal.faceImage || null
  return {
    stamp_id: textOf(seal.stamp_id),
    seal_name: textOf(seal.seal_name),
    dynasty: textOf(seal.dynasty),
    category: textOf(seal.seal_type || seal.category),
    primary_face_id: primary ? textOf(primary.id) : '',
    face_count: faceCount,
    edge_count: edgeCount,
    image_id: primary ? textOf(primary.id) : '',
    image_sha256: primary ? textOf(primary.sha256) : '',
    image_mime: primary ? textOf(primary.mime) : '',
    width: primary ? intOf(primary.width) : 0,
    height: primary ? intOf(primary.height) : 0,
    thumb_key: '',
    display_key: ''
  }
}

/**
 * 本機降級路徑的一頁（四維篩選仍走既有 `listSeals`，只做 offset 切片）。
 * @returns {{ok:true, rows:object[], next_cursor:string, has_more:boolean, total:number,
 *            source:'local', fallback:boolean}}
 */
function localPageOf(input = {}) {
  const offset = localOffsetOf(input.cursor)
  const limit = clampLimit(input.limit)
  const all = listSeals({
    dynasty: textOf(input.dynasty),
    content: textOf(input.content),
    style: textOf(input.style),
    sealClass: textOf(input.sealClass)
  })
    .map(cardRowOfLocalSeal)
    .filter(Boolean)
  const rows = all.slice(offset, offset + limit)
  const nextOffset = offset + rows.length
  const hasMore = nextOffset < all.length
  return {
    ok: true,
    rows,
    next_cursor: hasMore ? localCursorOf(nextOffset) : '',
    has_more: hasMore,
    total: all.length,
    source: 'local',
    fallback: true
  }
}

/* ---------------------------------------------------------------------------
 * 4. 分頁讀入口（視圖唯一消費點）
 * ------------------------------------------------------------------------- */

/**
 * 取一頁卡片。
 *
 * 讀序（機械可判、三支互斥）：
 *   ① **未配置雲端**（`cloudBaseConfigured() === false`）⇒ 本機示範資料（`source:'local'`）；
 *   ② 已配置 ⇒ 調匿名 action `listSealCards`：
 *        · 回包可辨識 ⇒ 用服務端 rows / `next_cursor` / `has_more` / `total`（原樣透傳，零派生）；
 *        · 傳輸層失敗或形狀不可辨識 ⇒ **本機示範資料兜底**（`fallback:true` ＋ 服務端原話），
 *          本機也空 ⇒ 如實回 `{ok:false, reason, message}`（不假裝成功、不假裝「沒有印章」）。
 *
 * @param {{dynasty?:string, content?:string, style?:string, sealClass?:string,
 *          cursor?:string, limit?:number}} input
 * @returns {Promise<{ok:true, rows:object[], next_cursor:string, has_more:boolean, total:number,
 *            source:'cloud'|'local', fallback:boolean, reason?:string, message?:string}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function listSealCardPage(input = {}) {
  const request = sealCardsRequestOf(input)
  if (!cloudBaseConfigured()) return localPageOf(input)

  const reply = await callCloudFunction(SEAL_CARDS_FUNCTION_NAME, {
    action: SEAL_CARDS_ACTION,
    payload: request
  })
  if (!reply.ok) return demoFallbackOf(input, reply.reason, reply.message)
  const result = reply.result || {}
  if (result.ok === false) {
    return demoFallbackOf(
      input,
      typeof result.reason === 'string' ? result.reason : 'STORAGE_UNAVAILABLE',
      typeof result.message === 'string' && result.message ? result.message : '雲端藏品資料暫時未能讀取，請稍後再試。'
    )
  }
  const readouts = sealCardsReadoutsOf(result)
  if (!readouts) {
    return demoFallbackOf(input, 'BAD_REPLY', '雲端藏品資料回傳形狀不可辨識，已回退本機示範資料。')
  }
  return sealCardPageOfReadouts(readouts)
}

/** 雲端失敗 ⇒ 本機示範資料兜底（本機亦空 ⇒ 如實失敗，不冒充「沒有符合條件的印章」）。 */
function demoFallbackOf(input, reason, message) {
  const local = localPageOf(input)
  if (local.rows.length > 0 || local.total > 0) {
    return {
      ...local,
      reason: textOf(reason),
      message: textOf(message) || '雲端藏品資料暫時未能讀取，目前列出的是本機示範資料。'
    }
  }
  return {
    ok: false,
    reason: textOf(reason) || 'STORAGE_UNAVAILABLE',
    message: textOf(message) || '雲端藏品資料暫時未能讀取，請稍後再試。'
  }
}

/* ---------------------------------------------------------------------------
 * 5. 封面圖（`thumb_key` / `display_key` ⇒ 對象臨時鏈接）
 * ------------------------------------------------------------------------- */

/** 臨時鏈接快取（同一對象在滾動中不重複取簽名；鏈接有 TTL ⇒ 只在本次頁面生命週期內用）。 */
const urlCache = new Map()
const URL_CACHE_LIMIT = 256

function cachePut(key, value) {
  if (urlCache.has(key)) urlCache.delete(key)
  urlCache.set(key, value)
  while (urlCache.size > URL_CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value)
}

/** 卡的封面對象鍵：**優先 `thumb_key`**（256 長邊縮略件），缺 ⇒ `display_key`（展示件整件）。 */
export function coverKeyOf(card) {
  if (!card || typeof card !== 'object') return ''
  const thumb = textOf(card.thumb_key).trim()
  if (thumb) return thumb
  return textOf(card.display_key).trim()
}

/**
 * 取卡片封面的**對象臨時鏈接**（`getTempFileURL`；桶 ACL 不動、匿名可讀展示件）。
 *
 * 為什麼不直接用讀面那個 `cloudTempUrlOfObjectKey`：那個函數要 `appRef`，而 `appRef` 只在
 * **全量水合**裡才被賦值 ⇒ 拿它就等於又把首屏綁回水合。本函數改走 `cloudBaseApp()`
 * （同一套 SDK 裝載縫 ＋ 同一條匿名登錄，與影像上傳面共用），**與水合無關**。
 *
 * @param {object} card 卡片行（`thumb_key` / `display_key`）
 * @returns {Promise<{ok:true, url:string, key:string, via:'thumb'|'display', message:''}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function cardCoverUrl(card) {
  const thumb = textOf(card && card.thumb_key).trim()
  const display = textOf(card && card.display_key).trim()
  const key = thumb || display
  if (!key) return { ok: false, reason: 'MISSING_REQUIRED', message: '此印章暫無封面影像。' }
  const cached = urlCache.get(key)
  if (cached) return { ok: true, url: cached, key, via: thumb ? 'thumb' : 'display', message: '' }
  /* 對象鍵形態門（`xiai/images/<2hex>/<64hex>.(png|webp|jpg|jpeg)`）：畸形鍵一律不出網。 */
  if (!IMAGE_OBJECT_KEY_PATTERN.test(key)) {
    return { ok: false, reason: 'INVALID_VALUE', message: '封面影像鍵形態不合法，暫時無法顯示。' }
  }
  const denial = cloudBaseFileIdDenial()
  if (denial) return denial
  const app = await cloudBaseApp()
  if (!app || typeof app.getTempFileURL !== 'function') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法顯示，請稍後再試。' }
  }
  let reply = null
  try {
    reply = await app.getTempFileURL({ fileList: [{ fileID: cloudBaseFileIdOf(key), maxAge: 3600 }] })
  } catch {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法顯示，請稍後再試。' }
  }
  const list = (reply && (reply.fileList || (reply.data && reply.data.fileList))) || []
  const first = list[0] || null
  const url = textOf(first && (first.tempFileURL || first.download_url || first.downloadUrl)).trim()
  if (!url) {
    const code = textOf(first && (first.code || first.status || first.errCode)).trim()
    if (code === 'STORAGE_FILE_NONEXIST') {
      return { ok: false, reason: 'STORAGE_FILE_NOT_FOUND', message: '封面影像在雲端儲存中不存在，暫時無法顯示。' }
    }
    return { ok: false, reason: 'NOT_IMAGE', message: '影像暫時無法顯示，請稍後再試。' }
  }
  cachePut(key, url)
  return { ok: true, url, key, via: thumb ? 'thumb' : 'display', message: '' }
}

/** 本層是否由雲端分頁接管（診斷 / 取證讀數；不改任何既有狀態機）。 */
export function sealCardsSource() {
  return {
    configured: cloudBaseConfigured(),
    pageSize: SQUARE_PAGE_SIZE,
    functionName: SEAL_CARDS_FUNCTION_NAME,
    action: SEAL_CARDS_ACTION,
    filterParams: { ...SQUARE_FILTER_PARAMS }
  }
}
