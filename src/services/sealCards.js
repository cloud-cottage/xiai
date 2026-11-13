/**
 * 玺爱 · **广场卡片分頁服務**（首屏 48 枚 ＋ `next_cursor` 續拉）
 * ============================================================================
 * 【為什麼有這一層】改前廣場靠「雲端全量水合」才能出圖：`seals.listSeals()` 要等 11,800 行
 *   `seals` / `faces` / `images` 全部落到快照裡，再在**主線程**逐印章組裝視圖模型 ⇒ 實測首屏
 *   28〜42 秒。本單把列表改成**分頁消費雲函數的公開只讀面 `{action:'public', op:'listSealCards'}`**：
 *     · 首屏只請求 48 枚；滾到底 / 按「載入更多」按 `next_cursor` 續拉；
 *     · 四個篩選維度 ＋ **關鍵詞 `q`（第五個入參）** 一併**下推**為請求參數（服務端全庫檢索，
 *       不再客戶端全量過濾 / 二次過濾）；
 *     · 封面圖直接取行上的 `thumb_key` / `display_key`（**按影像行真實 `storage_key` 派生**：
 *       `.tiff` 源件 ⇒ 派生 `.png`；`.png` / `.jpg` / `.webp` ⇒ 原樣；bundled 占位行與無引用行
 *       ⇒ 兩鍵皆空串）⇒ **不再依賴全量水合的 seals/faces 映射**；取不到對象時由本層＋
 *       `SealCard` 做**三級回落** thumb → display → 本地占位圖；
 *
 * 【凍結契約（本文件只消費，不自造字段）】
 *   請求 payload：`{ limit, cursor, dynasty, seal_type, face_style, category, q }`（**恰 7 鍵**；
 *   `q` 空串 ＝ 不檢索，**仍佔一鍵** —— 與規範 §3.81.4 載荷字面 `q: ''` 逐字同形）
 *   回包：`{ ok, rows, next_cursor, has_more, total }`；`rows` 元素**恰 14 鍵**：
 *     `stamp_id, seal_name, dynasty, category, primary_face_id, face_count, edge_count,
 *      image_id, image_sha256, image_mime, width, height, thumb_key, display_key`
 *   **0 面印章不會出現**在 rows（本層另做一道防禦性過濾，契約側漏了也不上屏空卡）。
 *
 * 【降級路徑（必須保留）】無雲端（未配置 / 呼叫失敗）⇒ 走**本機示範資料**：用既有的
 *   `seals.listSeals()`（保留 `CLOUD_PAGE_SIZE` 等既有常量與全量讀面，其它頁面照舊）
 *   在本地做同一套四維篩選 ＋ 同一關鍵詞面（`listSeals` 既有 `keyword`）並按 offset 切片
 *   ⇒ 廣場照樣可用，且 `fallback: true` 讓視圖
 *   顯式告知「目前列的是本機示範資料」，**不靜默**。
 *
 * 【分層紀律】本文件屬 services 層：只消費 `data/*` 與其它 services，不自碰 localStorage /
 *   IndexedDB；視圖與組件只經 `services/index.js` 門面進來。
 *   **唯一例外（本單｜裁定件 §6 第 58 行）**：瀏覽量計數的**客戶端 24h 去重**明文指定用
 *   `localStorage` 單鍵 `xiai.sealview.v1`，而本單寫集不含 `data/storage.js` ⇒ 去重讀寫**就近收口**
 *   在 §6 的兩個小函數裡（全部 `try/catch` 包住、不可用即照發），**不**把「碰存儲」的能力散給視圖。
 */

import { callCloudFunction, cloudBaseApp } from '../data/cloudbaseFn.js'
import { cloudBaseConfigured, cloudBaseFileIdDenial, cloudBaseFileIdOf, IMAGE_OBJECT_KEY_PATTERN } from '../data/cloudbase.js'
/* **公開寫面（`action:'public-write'`）的收窄信封**：只取信封、不新增 op 名字面值以外的任何判据
   （`bumpSealView` 这个名字面值**只**在本文件出现一次，见 §6）。 */
import { publicWrite as publicWriteEnvelope } from './token.js'
/* **本地占位圖（三級回落的第三級）**：字節真源在 `sealPlaceholderAsset.js`（只認登記鍵），
   這裡只取**同一真源**的 base 感知資產 URL（`SITE_BASE_URL` 拼接；**不是**站根絕對路徑）。 */
import { SEAL_PLACEHOLDER_IMAGE } from '../data/seed.js'
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

/** 公開只讀通道的 `action` 字面值（雲函數 `index.js::handlePublic` 的分流判據；與 `authorMatch.js` 同寫法）。 */
export const SEAL_CARDS_ACTION = 'public'

/** 公開只讀 op 名（與雲函數 `PUBLIC_OPS` 註冊面逐字一致）。 */
export const SEAL_CARDS_OP = 'listSealCards'

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
 *   ⑤ 關鍵詞 `q`            → `q`（第五個入參；同名零翻譯、**服務端全庫檢索**，規範 §3.81.4）
 * 視圖側的參數名沿用既有 URL query 名（`content` / `style` / `sealClass` / `q`），
 * 本表是唯一翻譯點 ⇒ **不得在視圖裡各自拼參數**。
 */
export const SQUARE_FILTER_PARAMS = Object.freeze({
  dynasty: 'dynasty',
  content: 'seal_type',
  style: 'face_style',
  sealClass: 'category',
  q: 'q'
})

/** 本地降級路徑的游標前綴（`off:<offset>`；雲端游標不透明，本層不解析）。 */
const LOCAL_CURSOR_PREFIX = 'off:'

/**
 * **卡片行來源標記（符號鍵）**：`'cloud'`（雲端 `listSealCards` 回包經 `normalizeSealCardRow` 收窄）
 * ／ `'local'`（本機示範資料經 `cardRowOfLocalSeal` 組裝）。
 * 用符號而非字串鍵：**不進 `Object.keys`** ⇒ 14 鍵面一字不變；標成 `enumerable`
 * ⇒ `{...row}` 展開複製也不丟。為什麼需要它：雲端行在 bundled 占位行 / 無影像行上
 * **兩鍵皆空串**（與本機行同形），`SealCard` 必須仍認得出「這是雲端分頁行」才走封面三級回落，
 * 而不是誤入本機解碼路徑（那條路上雲端行多半查無影像 ⇒ 只剩字形，占位圖出不來）。
 */
const CARD_ROW_SOURCE = Symbol('xiai.sealCard.source')

/** 該行是否為雲端分頁卡片行（封面三級回落的判據；與 `coverKeyOf` 互補、不替代）。 */
export function isCloudCardRow(row) {
  return Boolean(row && typeof row === 'object' && row[CARD_ROW_SOURCE] === 'cloud')
}

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
 * 由視圖的四維篩選 ＋ 關鍵詞組出請求 payload（**恰 7 鍵，鍵名與鍵序逐字凍結**）。
 * 空值一律傳空串（雲端按「空串 ⇒ 不篩 / 不檢索」處理），不傳 `undefined` / `null`。
 * `q` 由本層 `trim`（視圖也 trim 過一次，兩處同值）；**長度上限由服務端判**（> 40 ⇒ `INVALID_VALUE`），
 * 本層不截斷、不夾取（規範 §3.81.4：不得靜默截斷）。
 * @param {{dynasty?:string, content?:string, style?:string, sealClass?:string, q?:string,
 *          cursor?:string, limit?:number}} input
 * @returns {{limit:number, cursor:string, dynasty:string, seal_type:string,
 *            face_style:string, category:string, q:string}}
 */
export function sealCardsRequestOf(input = {}) {
  const source = input || {}
  return {
    limit: clampLimit(source.limit),
    cursor: textOf(source.cursor).trim(),
    [SQUARE_FILTER_PARAMS.dynasty]: textOf(source.dynasty).trim(),
    [SQUARE_FILTER_PARAMS.content]: textOf(source.content).trim(),
    [SQUARE_FILTER_PARAMS.style]: textOf(source.style).trim(),
    [SQUARE_FILTER_PARAMS.sealClass]: textOf(source.sealClass).trim(),
    [SQUARE_FILTER_PARAMS.q]: textOf(source.q).trim()
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
  /* 來源標記（符號鍵，不佔 14 鍵面）：雲端分頁行 ⇒ 封面走三級回落。 */
  row[CARD_ROW_SOURCE] = 'cloud'
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
  const card = {
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
  /* 來源標記（符號鍵，不佔 14 鍵面）：本機示範資料行 ⇒ 封面維持本機解碼路徑。 */
  card[CARD_ROW_SOURCE] = 'local'
  return card
}

/**
 * 本機降級路徑的一頁（四維篩選與關鍵詞仍走既有 `listSeals` 的同一套面，只做 offset 切片；
 * `total` ＝ 命中集總數，與雲端 `total` 同一口徑）。
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
    sealClass: textOf(input.sealClass),
    /* 關鍵詞走 `listSeals` 既有 `keyword` 面（印文 / 作者 / 編號 …，本機全量命中集）；
       空串 ⇒ 不篩（與雲端「空串 ＝ 不檢索」同語義）。 */
    keyword: textOf(input.q)
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
 *   ② 已配置 ⇒ 調公開只讀面 `{action:'public', op:'listSealCards'}`：
 *        · 回包可辨識 ⇒ 用服務端 rows / `next_cursor` / `has_more` / `total`（原樣透傳，零派生）；
 *        · 傳輸層失敗或形狀不可辨識 ⇒ **本機示範資料兜底**（`fallback:true` ＋ 服務端原話），
 *          本機也空 ⇒ 如實回 `{ok:false, reason, message}`（不假裝成功、不假裝「沒有印章」）。
 *
 * @param {{dynasty?:string, content?:string, style?:string, sealClass?:string, q?:string,
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
    op: SEAL_CARDS_OP,
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
 * 5. 封面圖（`thumb_key` / `display_key` ⇒ 對象臨時鏈接；**三級回落**）
 * ------------------------------------------------------------------------- */

/** 臨時鏈接快取（同一對象在滾動中不重複取簽名；鏈接有 TTL ⇒ 只在本次頁面生命週期內用）。 */
const urlCache = new Map()
const URL_CACHE_LIMIT = 256

function cachePut(key, value) {
  if (urlCache.has(key)) urlCache.delete(key)
  urlCache.set(key, value)
  while (urlCache.size > URL_CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value)
}

/**
 * **縮略件**對象鍵形態（`xiai/thumb/<sha 前兩位>/<sha>.webp`）—— 與
 * `tools/display-artifacts/transcode.mjs` 的 `DEFAULT_THUMB_PREFIX` 逐字同值。
 * 展示件形態仍用既有 `IMAGE_OBJECT_KEY_PATTERN`（**一字未動**，`verify-object-key-pattern` 管著）。
 */
export const THUMB_OBJECT_KEY_PATTERN = /^xiai\/thumb\/([0-9a-f]{2})\/([0-9a-f]{64})\.webp$/

/** 封面鍵形態門（展示件 ／ 縮略件二族）：畸形鍵一律不出網（但**不**擋三級回落）。 */
function coverKeyShapeOk(key) {
  return IMAGE_OBJECT_KEY_PATTERN.test(key) || THUMB_OBJECT_KEY_PATTERN.test(key)
}

/** 卡的封面對象鍵：**優先 `thumb_key`**（256 長邊縮略件），缺 ⇒ `display_key`（展示件整件）。 */
export function coverKeyOf(card) {
  if (!card || typeof card !== 'object') return ''
  const thumb = textOf(card.thumb_key).trim()
  if (thumb) return thumb
  return textOf(card.display_key).trim()
}

/** 卡片行的**展示件鍵**（三級回落的第二級；空串＝沒有第二級）。 */
export function coverDisplayKeyOf(card) {
  return textOf(card && card.display_key).trim()
}

/** 卡片行的**縮略件鍵**（三級回落的第一級）。 */
export function coverThumbKeyOf(card) {
  return textOf(card && card.thumb_key).trim()
}

/**
 * **本地占位圖 URL（三級回落的第三級）** —— 取**與 `sealPlaceholderAsset.js` 同一真源**
 * （`SEAL_PLACEHOLDER_IMAGE.asset_url`）的 base 感知路徑：瀏覽器側 `SITE_BASE_URL`（＝部署 base，
 * 如 `/xiai/`）⇒ `/xiai/placeholders/seal-no-image.jpg`。**不是站根絕對路徑**
 * （`/placeholders/…` 在子路徑部署下恆 404 —— 已修過的回歸根因，不得回退）。
 * @returns {string} 資產 URL；登記面缺損 ⇒ 空串（調用方退回字形空態，不造假 URL）
 */
export function coverPlaceholderUrl() {
  return textOf(SEAL_PLACEHOLDER_IMAGE && SEAL_PLACEHOLDER_IMAGE.asset_url).trim()
}

/**
 * 封面鍵鏈（**三級回落的前兩級**，唯一組鏈處）：`thumb_key` → `display_key`。
 * 只收**形態合法**的鍵（畸形鍵不出網），去重、保序；兩鍵皆空 ⇒ `[]`。
 * @param {object} card 卡片行
 * @param {{via?:'display'}} [options] `via:'display'` ＝ **只取第二級**（`<img @error>` 的
 *   運行時回落用；避免重簽第一級那條已知壞掉的鏈）
 * @returns {Array<{via:'thumb'|'display', key:string}>}
 */
export function coverKeyChainOf(card, options = {}) {
  const prefer = textOf(options && options.via).trim()
  const thumb = coverThumbKeyOf(card)
  const display = coverDisplayKeyOf(card)
  const chain = []
  if (prefer !== 'display' && thumb && coverKeyShapeOk(thumb)) chain.push({ via: 'thumb', key: thumb })
  if (display && coverKeyShapeOk(display) && (prefer === 'display' || display !== thumb)) {
    chain.push({ via: 'display', key: display })
  }
  return chain
}

/**
 * 取卡片封面的**對象臨時鏈接**（`getTempFileURL`；桶 ACL 不動、匿名可讀展示件），
 * **按鍵鏈逐級取鏈**：`thumb_key` 取不到（`STORAGE_FILE_NONEXIST` / 形態不過 / 簽名異常）
 * ⇒ 立刻試 `display_key`；兩級都取不到 ⇒ `{ok:false}`（由 `SealCard` 落到本地占位圖）。
 *
 * 為什麼不直接用讀面那個 `cloudTempUrlOfObjectKey`：那個函數要 `appRef`，而 `appRef` 只在
 * **全量水合**裡才被賦值 ⇒ 拿它就等於又把首屏綁回水合。本函數改走 `cloudBaseApp()`
 * （同一套 SDK 裝載縫 ＋ 同一條匿名登錄，與影像上傳面共用），**與水合無關**。
 *
 * @param {object} card 卡片行（`thumb_key` / `display_key`）
 * @param {{via?:'display'}} [options] `via:'display'` ＝ **只取第二級**（`<img @error>` 的
 *   運行時回落用；避免重簽第一級那條已知壞掉的鏈）
 * @returns {Promise<{ok:true, url:string, key:string, via:'thumb'|'display', message:''}
 *          |{ok:false, reason:string, message:string}>}
 */
export async function cardCoverUrl(card, options = {}) {
  const prefer = textOf(options && options.via).trim()
  const thumb = coverThumbKeyOf(card)
  const display = coverDisplayKeyOf(card)
  if (!thumb && !display) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '此印章暫無封面影像。' }
  }
  /* `via:'display'` 但行上沒有展示件鍵 ⇒ 第二級根本不存在（與「兩鍵皆空」同判）。 */
  if (prefer === 'display' && !display) {
    return { ok: false, reason: 'MISSING_REQUIRED', message: '此印章暫無封面影像。' }
  }
  const chain = coverKeyChainOf(card, { via: prefer })
  if (chain.length === 0) {
    return { ok: false, reason: 'INVALID_VALUE', message: '封面影像鍵形態不合法，暫時無法顯示。' }
  }
  const denial = cloudBaseFileIdDenial()
  if (denial) return denial
  const app = await cloudBaseApp()
  if (!app || typeof app.getTempFileURL !== 'function') {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '影像暫時無法顯示，請稍後再試。' }
  }
  /* 逐級取鏈：**取鏈失敗分支的回落**（`<img @error>` 是另一半，見 `SealCard`）。 */
  let reason = 'STORAGE_FILE_NOT_FOUND'
  let message = '封面影像在雲端儲存中不存在，暫時無法顯示。'
  for (const item of chain) {
    const cached = urlCache.get(item.key)
    if (cached) return { ok: true, url: cached, key: item.key, via: item.via, message: '' }
    let reply = null
    try {
      reply = await app.getTempFileURL({ fileList: [{ fileID: cloudBaseFileIdOf(item.key), maxAge: 3600 }] })
    } catch {
      reason = 'STORAGE_UNAVAILABLE'
      message = '影像暫時無法顯示，請稍後再試。'
      continue
    }
    const list = (reply && (reply.fileList || (reply.data && reply.data.fileList))) || []
    const first = list[0] || null
    const url = textOf(first && (first.tempFileURL || first.download_url || first.downloadUrl)).trim()
    if (url) {
      cachePut(item.key, url)
      return { ok: true, url, key: item.key, via: item.via, message: '' }
    }
    const code = textOf(first && (first.code || first.status || first.errCode)).trim()
    if (code === 'STORAGE_FILE_NONEXIST') {
      reason = 'STORAGE_FILE_NOT_FOUND'
      message = '封面影像在雲端儲存中不存在，暫時無法顯示。'
    } else {
      reason = 'NOT_IMAGE'
      message = '影像暫時無法顯示，請稍後再試。'
    }
  }
  return { ok: false, reason, message }
}

/** 本層是否由雲端分頁接管（診斷 / 取證讀數；不改任何既有狀態機）。 */
export function sealCardsSource() {
  return {
    configured: cloudBaseConfigured(),
    pageSize: SQUARE_PAGE_SIZE,
    functionName: SEAL_CARDS_FUNCTION_NAME,
    action: SEAL_CARDS_ACTION,
    op: SEAL_CARDS_OP,
    filterParams: { ...SQUARE_FILTER_PARAMS }
  }
}

/* ---------------------------------------------------------------------------
 * 6. 瀏覽量計數（公開寫面 `{action:'public-write', op:'bumpSealView'}`｜裁定件 §6）
 * ---------------------------------------------------------------------------
 * 契約（照登裁定件 §6，本層只消費）：
 *   · 載荷封閉**恰 1 鍵** `stamp_id`；成功回包**恰 1 鍵** `ok:true`；失敗恰 3 鍵 `ok/reason/message`。
 *   · **服務端無冪等**（每次調用都 +1）⇒ 同一瀏覽器同一枚 **24h 內只計一次** 由本層負責。
 *   · 去重真源：`localStorage` 單鍵 `xiai.sealview.v1`，值域 `{ 印章編號: 毫秒時間戳 }`；
 *     24h（86,400,000 ms）內跳過；表項 > 200 按時間戳淘汰最舊；存儲不可用（隱私模式）⇒ **照發**。
 *   · 計數是**靜默副作用**：本層**永不拋出**，呼叫方（詳情頁 / 分享頁）不必包 try/catch、
 *     不上屏、不改任何既有錯誤態。
 * ------------------------------------------------------------------------- */

/** 白名單裡**唯一**的公開寫 op（`PUBLIC_WRITE_OPS` 恰 1 成員）。 */
export const SEAL_VIEW_BUMP_OP = 'bumpSealView'

/** 客戶端去重的單鍵（**唯一真源**；改鍵名只改這裡）。 */
export const SEAL_VIEW_STORE_KEY = 'xiai.sealview.v1'

/** 同一枚印章的計數間隔（24 小時，毫秒）。 */
export const SEAL_VIEW_DEDUPE_MS = 86400000

/** 去重表項上限（超過按時間戳淘汰最舊）。 */
export const SEAL_VIEW_STORE_MAX = 200

/**
 * **去重判定的唯一內核（純函數｜零副作用、零 I/O）**：讀寫都在這一個函數裡完成計算，
 * 呼叫方只負責把回傳的 `store` 落盤（不得自行改寫表項）。
 *
 * 判定（三種輸入的行為見報告）：
 *   · 首次 / 表裡沒有該編號 / 上次計數距今 ≥ 24h ⇒ `send:true`，回傳表已寫入「編號 → now」；
 *   · 上次計數距今 < 24h ⇒ `send:false`，回傳表原樣（**不刷新時間戳**：24h 從上次計數起算）；
 *   · 時鐘回撥（存值比 now 晚）⇒ 按 `|now - 存值|` 判，仍在窗口內則跳過（不因回撥永久封死）。
 * 表項清理：非有限數 / ≤ 0 的值一律丟棄；> 200 條按時間戳**降序保留最新 200 條**。
 * @param {object|null} store 讀回的原始表（`null` ＝ 存儲不可用 ⇒ 視同空表、照發）
 * @param {string} stampId 印章編號
 * @param {number} nowMs 當前毫秒時間戳（由呼叫方注入 ⇒ 可用假時鐘斷言）
 * @returns {{send:boolean, store:Object<string, number>}}
 */
export function sealViewClaimOf(store, stampId, nowMs) {
  const id = textOf(stampId).trim()
  const now = Number.isFinite(Number(nowMs)) ? Math.floor(Number(nowMs)) : Date.now()
  const source = store && typeof store === 'object' && !Array.isArray(store) ? store : {}
  const entries = []
  for (const key of Object.keys(source)) {
    const name = textOf(key).trim()
    const at = Number(source[key])
    if (!name || !Number.isFinite(at) || at <= 0) continue
    entries.push([name, Math.floor(at)])
  }
  const kept = {}
  for (const [name, at] of entries) kept[name] = at
  /* 缺編號 ⇒ 不發（本機 fail-closed；服務端另有 `INVALID_VALUE` 判據）。 */
  if (!id) return { send: false, store: kept }
  const last = Number(kept[id])
  if (Number.isFinite(last) && last > 0 && Math.abs(now - last) < SEAL_VIEW_DEDUPE_MS) {
    return { send: false, store: kept }
  }
  const next = { ...kept, [id]: now }
  const ordered = Object.keys(next)
    .map((name) => [name, next[name]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEAL_VIEW_STORE_MAX)
  const trimmed = {}
  for (const [name, at] of ordered) trimmed[name] = at
  return { send: true, store: trimmed }
}

/** 讀去重表：存儲不可用（隱私模式 / 被停用 / 壞 JSON）⇒ `null`（呼叫方照發，**不阻斷**）。 */
function sealViewStoreRead() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null
    const raw = localStorage.getItem(SEAL_VIEW_STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (err) {
    return null
  }
}

/** 寫去重表：失敗只回 `false`（**不上屏、不拋**）。 */
function sealViewStoreWrite(store) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false
    localStorage.setItem(SEAL_VIEW_STORE_KEY, JSON.stringify(store))
    return true
  } catch (err) {
    return false
  }
}

/**
 * **印章瀏覽量 +1（公開寫面門面｜視圖唯一消費點）**。
 *
 * 行為（機械可判、四支互斥）：
 *   ① 缺編號 ⇒ 不發（`INVALID_VALUE`，載荷不合法就不出網）；
 *   ② 雲端未配置（`cloudBaseConfigured() === false`）⇒ **靜默返回**，不偽造成功、
 *      **不回落本機鏡像寫入**（本機沒有可寫的權威計數面）；
 *   ③ 24h 內同一枚已計 ⇒ 不發（`deduped:true`）；
 *   ④ 其餘 ⇒ 發 `{action:'public-write', op:'bumpSealView', payload:{stamp_id}}`：
 *        成功 ⇒ **才**把去重表落盤（失敗不落 ⇒ 下次還有機會計數）；
 *        失敗 ⇒ 原樣回結構化拒絕（`reason` / `message` 不改寫），**永不拋出**。
 *
 * @param {string} stampId 印章編號（`stamp_id`）
 * @returns {Promise<{ok:boolean, sent:boolean, deduped:boolean, reason:string, message:string}>}
 *   `ok` ＝ 服務端確認 +1 過（**不由請求發出與否冒充**）；`sent` ＝ 這次是否真的出了網。
 */
export async function bumpSealView(stampId) {
  const id = textOf(stampId).trim()
  if (!id) {
    return { ok: false, sent: false, deduped: false, reason: 'INVALID_VALUE', message: '缺少印章編號，未計數。' }
  }
  if (!cloudBaseConfigured()) {
    return {
      ok: false,
      sent: false,
      deduped: false,
      reason: 'NOT_CONFIGURED',
      message: '未配置雲端資料源，未計數。'
    }
  }
  const claim = sealViewClaimOf(sealViewStoreRead(), id, Date.now())
  if (!claim.send) return { ok: true, sent: false, deduped: true, reason: '', message: '' }
  let reply = null
  try {
    reply = await publicWriteEnvelope(SEAL_VIEW_BUMP_OP, { stamp_id: id })
  } catch (err) {
    reply = null
  }
  if (!reply || reply.ok !== true) {
    return {
      ok: false,
      sent: true,
      deduped: false,
      reason: textOf(reply && reply.reason) || 'STORAGE_UNAVAILABLE',
      message: textOf(reply && reply.message)
    }
  }
  sealViewStoreWrite(claim.store)
  return { ok: true, sent: true, deduped: false, reason: '', message: '' }
}
