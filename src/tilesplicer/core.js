/**
 * TileSplicer 內核（**切割 / 拼接的唯一真源**）—— xiai · 玺愛
 * ============================================================================
 * 命名與歸屬（R-97 / R-98 逐字）：Kevin 把「切割、拼接」內核正式命名為 **TileSplicer**，
 * **歸屬 xiai**；將來由 yinsuo 通過 API 二次封裝消費（本檔案**不含**任何 API / HTTP 代碼）。
 *
 * **真源恰 1 處**：切位派生（`offsetRatio`）、刀向序列、`cols` / `rows`、逐塊幾何、
 * 無縫判據 —— 全部**只在本檔案有定義點**。`data/db.js` / `utils/image.js` /
 * `components/sliceMeta.js` 三處一律 `import` 本檔案並**轉調**（保留各自原本職與導出名）。
 *
 * 純度：**不依賴 DOM、不依賴任何存儲**（不碰 `localStorage` / `IndexedDB` / `canvas`）。
 * 只 import 兩份**真源**：
 *   - `data/seed.js` 的凍結字面值（`SLICE_DIRECTIONS` 刀向序列 / `SLICE_CUT_COUNTS` 刀數表 /
 *     `SLICE_META_FIELD` 元數據鍵名 / `FACE_KIND` 印面類別）；
 *   - `data/assetmeta.js` 的 `sha256Hex`（摘要真源）。
 * ⇒ 瀏覽器、Vite dev server（Node）與將來的 API 消費方三處**逐字同結果**。
 *
 * ----------------------------------------------------------------------------
 * 凍結導出面（T2 API 與消費方依賴，**一字不得改**）
 * ----------------------------------------------------------------------------
 *   - `TILESPLICER_NAME`    ＝ `'TileSplicer'`
 *   - `TILESPLICER_VERSION` ＝ `'tilesplicer/v1'`
 *   - `planFor({assetId, kind, sourceWidth, sourceHeight})`
 *       ⇒ `{ok:true, version, assetId, kind, source:{width,height}, cuts, directions, ratios,
 *           cols, rows, tiles:[{index,row,col,rect:{x,y,w,h}}],
 *           seam:{ok,areaEqualsSource,noOverlap,edgesAdjacent}}`
 *       ⇒ 錯誤 `{ok:false, reason, message}`，`reason ∈ ('INVALID_ARGUMENT' | 'UNKNOWN_KIND' | 'NOT_FOUND')`，
 *         `message` 為**繁體可讀**（上屏文案紀律）；**永不拋未捕獲異常**（結構化返回）。
 *
 * 塊數口徑（R-98 凍結）：`kind='FACE'` ⇒ 2 刀 ⇒ **4 塊＝2×2**；`kind='PHOTO'` ⇒ 3 刀 ⇒ **8 塊＝4×2**。
 * `kind='EDGE'`（邊款＝特殊印面）按**印面族**口徑 ⇒ 2 刀 / 4 塊（與 `SLICE_CUT_COUNTS` 註釋一致）。
 *
 * ----------------------------------------------------------------------------
 * 口徑明細（三處消費方原各自持有一份，本單收斂至此）
 * ----------------------------------------------------------------------------
 * ① **確定性切位**：`offsetRatio` 只由 **影像 id 的 `sha256` 摘要**派生（每刀吃 8 位十六進制
 *    ＝ 32 位），落在取值帶 `[0.35, 0.65]`、保留 4 位小數 ⇒ **同 id 必同結果**，與時間 /
 *    隨機 / 調用順序 / 環境無關；換 id 則切位另行派生（避免「一條細縫」或「半張圖」的退化切位）。
 * ② **刀向序列（交替）**：刀 1 向 A（`vertical`）、刀 2 ⊥A（`horizontal`）、**刀 3 回 A 向**
 *    （`vertical`）—— 序列字面值真源＝`seed.js::SLICE_DIRECTIONS`，本檔案**只切片、不另寫一份**。
 * ③ **`cols` / `rows`**：由刀向序列推得（豎切一次列數 ×2、橫切一次行數 ×2）⇒ 2×2 / 4×2。
 * ④ **逐塊 `rect`**：先由刀向 + 切位派生**歸一化窗口**（`windowsOf`，相鄰塊**共用同一個邊界數值**
 *    ⇒ 天生無縫縫無疊蓋），再做**數據層窗口 → 設備像素換算**（`pixelRectsOf`：收集全部唯一边界
 *    → 升序 → 逐值取整、嚴格遞增、每段 ≥ 1px、末值 ＝ 邊長）。
 * ⑤ **無縫判據**（`seamOf`）：塊面積和 **恰等於** 源圖面積 ＋ 兩兩交集面積和 **恰為 0**
 *    ＋ 每條內部邊界同時是「某塊右/下邊」與「另一塊左/上邊」⇒ 三者皆真方判 `ok`。
 */

import {
  SLICE_DIRECTIONS,
  SLICE_CUT_COUNTS,
  SLICE_META_FIELD,
  FACE_KIND,
  SEED_IMAGES
} from '../data/seed.js'
import { sha256Hex } from '../data/assetmeta.js'

/* ============================================================================
   ① 凍結常量與身份
   ============================================================================ */

/** 內核名（凍結；供 API 發現面 `{name, version, kinds, cutCounts}`）。 */
export const TILESPLICER_NAME = 'TileSplicer'

/** 內核版本（凍結；版本化前綴 `tilesplicer/v1` ⇒ 將來升版另開新前綴，不改本值語義）。 */
export const TILESPLICER_VERSION = 'tilesplicer/v1'

/** 元數據鍵名（轉口自真源常量，供數據層 / 展示層引用同一名字）。 */
export { SLICE_META_FIELD }

/** 刀向序列真源（**只轉口**，不在此另寫字面量）。 */
export { SLICE_DIRECTIONS }

/** 類別 → 刀數真源（**只轉口**）。 */
export { SLICE_CUT_COUNTS }

/** 刀向字面值：取自凍結序列**首刀**（豎切）與**第二刀**（橫切，⊥首刀）。 */
const VERTICAL = String(SLICE_DIRECTIONS[0] || '')
const HORIZONTAL = String(SLICE_DIRECTIONS[1] || '')

/** 切位取值帶（歸一化比例）：留在中段 ⇒ 不出現「一條細縫」或「半張圖」的退化切位。 */
const RATIO_MIN = 0.35
const RATIO_MAX = 0.65
/** 切位保留小數位（4 位：夠精細、可逐字比對、JSON 穩定）。 */
const RATIO_DECIMALS = 4
/** 每刀吃多少位摘要（8 位十六進制 ＝ 32 位）：切位只由 id 摘要派生 ⇒ 同 id 必同結果。 */
const RATIO_HEX_CHUNK = 8
/** 窗口歸一化時，切位不可採信 ⇒ 回落的默認比例（沿用既有 `sliceWindowsOf` 口徑）。 */
const WINDOW_RATIO_FALLBACK = 0.5
/** 逐塊幾何歸一化時，切位不可採信 ⇒ 回落的默認比例（沿用既有 `tilesFromCuts` 口徑）。 */
const TILE_RATIO_FALLBACK = 0

/** 結構化錯誤出口（**統一**；不含堆棧、不含內部錨點）。 */
function failure(reason, message) {
  return { ok: false, reason, message }
}

/** 任意形態 → 整數（非有限數 ⇒ 0）；沿用既有 `toInt` 口徑。 */
function toInt(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : 0
}

/* ============================================================================
   ② 類別 / 刀向 / 切位的歸一（值域判定唯一實現點）
   ============================================================================ */

/**
 * 類別 → 族（**刀數口徑的唯一實現點**）。
 *   - `FACE` / `EDGE` ⇒ 族 `FACE`（印面族：邊款是特殊印面，同口徑 4 塊）；
 *   - `PHOTO` ⇒ 族 `PHOTO`（實拍族 8 塊）；
 *   - 其餘（含空串 / `null` / 未登記字面值）⇒ `{ok:false, reason:'UNKNOWN_KIND'}`。
 * 歸一：去首尾空白 + 大寫（大小寫不敏感；`'photo'` 等價 `'PHOTO'`）。
 * @returns {{ok:boolean, kind:string, family:string, reason:string}}
 */
export function familyOf(kind) {
  const key = kind === null || kind === undefined ? '' : String(kind).trim().toUpperCase()
  if (key === FACE_KIND.FACE || key === FACE_KIND.EDGE) {
    return { ok: true, kind: key, family: FACE_KIND.FACE, reason: '' }
  }
  if (key && Object.prototype.hasOwnProperty.call(SLICE_CUT_COUNTS, key)) {
    return { ok: true, kind: key, family: key, reason: '' }
  }
  return { ok: false, kind: key, family: '', reason: 'UNKNOWN_KIND' }
}

/**
 * 刀向歸一：**只認真源字面值**（大小寫不敏感、去首尾空白）；其餘一律不可識別（空串）。
 * @returns {string} 規範刀向字面值，或 `''`（不可識別）
 */
export function directionOf(value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toUpperCase()
  if (!text) return ''
  if (VERTICAL && text === VERTICAL.toUpperCase()) return VERTICAL
  if (HORIZONTAL && text === HORIZONTAL.toUpperCase()) return HORIZONTAL
  return ''
}

/**
 * 切位歸一：**機械夾到 `[0, 1]`**；非有限數 ⇒ `null`（＝不可採信，由調用方決定拒絕或回落）。
 * @returns {number|null}
 */
export function clampRatio(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(Math.max(num, 0), 1)
}

/** 該刀是否為橫切（＝真源第二刀字面值；空真源 ⇒ 一律不算橫切）。 */
function isHorizontalDirection(value) {
  return HORIZONTAL !== '' && String(value) === HORIZONTAL
}

/* ============================================================================
   ③ 確定性切位派生（同 id 必同結果）
   ============================================================================ */

/**
 * 第 `index` 刀的切位比例：**純函數** —— 由 id 摘要的**定長片段**取模落在取值帶內。
 * @param {string} seedHex `sha256Hex(assetId)` 的十六進制串
 * @param {number} index 刀序（0 起）
 */
export function ratioAt(seedHex, index) {
  const span = Math.round((RATIO_MAX - RATIO_MIN) * 10 ** RATIO_DECIMALS)
  const chunk = String(seedHex).slice(index * RATIO_HEX_CHUNK, (index + 1) * RATIO_HEX_CHUNK)
  const value = parseInt(chunk || '0', 16)
  const step = Number.isFinite(value) ? value % (span + 1) : 0
  return Number((RATIO_MIN + step / 10 ** RATIO_DECIMALS).toFixed(RATIO_DECIMALS))
}

/**
 * **切片元數據派生**（純函數，不碰任何存儲）—— 形狀**逐字凍結**：
 * `{directions, ratios, cols, rows, cuts}`（鍵序亦凍結）。
 *
 * 確定性：只由 `assetId`（經 `sha256Hex`）與 `kind` 決定；同 id 連算 N 次結果全等，
 * 與時間 / 隨機 / 調用順序無關。
 *
 * @param {string} assetId 影像編號（`asset.id`）
 * @param {string} [kind] 切片類別（`FACE` / `EDGE` / `PHOTO`）
 * @param {{tolerateUnregisteredKind?:boolean}} [options]
 *        `tolerateUnregisteredKind: true` ⇒ **未登記類別按印面族**（`FACE`）口徑派生，
 *        本函數**不報錯** —— 這是**數據層歷史口徑**（既有 `sliceMetaOf(imageId, kind)`
 *        對未登記類別不拋錯、按印面 4 塊；既有探針 86/86 依賴此行為）。`planFor` **不**開此容忍。
 * @returns {{ok:boolean, reason:string, message:string, assetId:string, kind:string,
 *            family:string, meta:object|null}}
 */
export function metaFor(assetId, kind, options = {}) {
  const id = assetId === null || assetId === undefined ? '' : String(assetId)
  const resolved = familyOf(kind)
  let kindLabel = resolved.kind
  if (!resolved.ok) {
    if (options && options.tolerateUnregisteredKind === true) {
      kindLabel = FACE_KIND.FACE
      resolved.family = FACE_KIND.FACE
      resolved.ok = true
    } else {
      return {
        ok: false,
        reason: 'UNKNOWN_KIND',
        message: `不支援的 kind「${resolved.kind}」：僅接受 FACE、EDGE 或 PHOTO。`,
        assetId: id,
        kind: resolved.kind,
        family: '',
        meta: null
      }
    }
  }
  const declared = Number(SLICE_CUT_COUNTS[resolved.family])
  const cuts = Number.isFinite(declared)
    ? Math.max(0, Math.min(declared, SLICE_DIRECTIONS.length))
    : 0
  const directions = SLICE_DIRECTIONS.slice(0, cuts)
  const seedHex = sha256Hex(id)
  const ratios = directions.map((_, index) => ratioAt(seedHex, index))
  let cols = 1
  let rows = 1
  directions.forEach((direction) => {
    if (direction === VERTICAL) cols *= 2
    else if (direction === HORIZONTAL) rows *= 2
  })
  return {
    ok: true,
    reason: '',
    message: '',
    assetId: id,
    kind: kindLabel,
    family: resolved.family,
    meta: { directions, ratios, cols, rows, cuts: directions.length }
  }
}

/* ============================================================================
   ④ 歸一化邊界 / 窗口派生（數據層元數據 → 歸一化窗口）
   ============================================================================ */

/**
 * 在**當前全部線段**上各切一刀（歸一化座標）。
 * 相鄰塊**共用同一個邊界數值** ⇒ 天生**無縫、無疊蓋、並集＝整圖**。
 * @param {number[]} edges 當前邊界（升序、首 0 末 1）
 * @param {number} ratio 切位比例
 * @param {number} fallback 比例不可採信時的回落值（窗口口徑 0.5 / 逐塊幾何口徑 0）
 */
function splitEdges(edges, ratio, fallback) {
  const clamped = clampRatio(ratio)
  const at = clamped === null ? fallback : clamped
  const next = []
  for (let i = 0; i < edges.length - 1; i += 1) {
    const from = edges[i]
    const to = edges[i + 1]
    next.push(from, from + (to - from) * at)
  }
  next.push(edges[edges.length - 1])
  return next
}

/**
 * 由切片元數據派生**逐塊歸一化窗口**（純函數；座標 `x0/y0/x1/y1`，左上原點）。
 *
 * 幾何保證：並集 ＝ `[0,1] × [0,1]` 全幅；兩兩不交（相鄰塊共用同一邊界數值）；
 * 順序 ＝ 行主序（`index = row * cols + col`）。
 * 非法 / 殘缺元數據 ⇒ 走**確定性退化**（缺失方向被忽略、切位夾到 `[0,1]`），**不拋錯**。
 *
 * @param {{directions?:string[], ratios?:number[]}} meta 切片元數據（`metaFor` 的產物）
 * @returns {Array<{index:number, col:number, row:number, x0:number, y0:number, x1:number, y1:number}>}
 */
export function windowsOf(meta) {
  const source = meta && typeof meta === 'object' ? meta : {}
  const directions = Array.isArray(source.directions) ? source.directions : []
  const ratios = Array.isArray(source.ratios) ? source.ratios : []
  let xs = [0, 1]
  let ys = [0, 1]
  directions.forEach((direction, index) => {
    if (direction === VERTICAL) xs = splitEdges(xs, ratios[index], WINDOW_RATIO_FALLBACK)
    else if (direction === HORIZONTAL) ys = splitEdges(ys, ratios[index], WINDOW_RATIO_FALLBACK)
  })
  const windows = []
  const cols = xs.length - 1
  const rows = ys.length - 1
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      windows.push({
        index: row * cols + col,
        col,
        row,
        x0: xs[col],
        y0: ys[row],
        x1: xs[col + 1],
        y1: ys[row + 1]
      })
    }
  }
  return windows
}

/* ============================================================================
   ⑤ 數據層窗口 → 設備像素換算（像素級無縫的唯一實現點）
   ============================================================================ */

/**
 * **歸一化窗口 → 設備像素矩形**（純函數）。
 *
 * 無縫口徑：**所有塊共用同一份取整後的邊界數** —— 先收集全部唯一边界值 → 升序 →
 * 逐值取整（嚴格遞增、每段 ≥ 1px、末值 ＝ 邊長）⇒ 並集**必等於**整圖、兩兩**必不重疊**。
 * @returns {{ok:boolean, rects:Array<object>, xEdges:number[], yEdges:number[],
 *            width:number, height:number, reason:string, message:string}}
 */
export function pixelRectsOf(windows, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const list = (Array.isArray(windows) ? windows : []).filter((win) => win && typeof win === 'object')
  const out = { ok: false, rects: [], xEdges: [], yEdges: [], width: w, height: h, reason: '', message: '' }
  if (list.length === 0) {
    return { ...out, reason: 'NO_WINDOWS', message: '切片窗口爲空（切分元數據不可用）—— 不在本模組自造切位' }
  }
  const quantizeEdges = (values, span) => {
    const uniq = [...new Set(values.map((value) => clampRatio(value) ?? 0))].sort((a, b) => a - b)
    if (span < uniq.length - 1) return null
    const map = new Map()
    let prev = -1
    uniq.forEach((value, index) => {
      const remaining = uniq.length - 1 - index
      let px = Math.round(value * span)
      px = Math.max(px, prev + 1)
      px = Math.min(px, span - remaining)
      map.set(value, px)
      prev = px
    })
    return { map, pixels: uniq.map((value) => map.get(value)) }
  }
  const xs = quantizeEdges(list.flatMap((win) => [win.x0, win.x1]), w)
  const ys = quantizeEdges(list.flatMap((win) => [win.y0, win.y1]), h)
  if (!xs || !ys) {
    return { ...out, reason: 'SIZE_TOO_SMALL', message: '影像像素尺寸小於切塊數（無法保證每塊 ≥ 1px）—— 拒絕切分' }
  }
  const rects = list.map((win, index) => {
    const left = xs.map.get(clampRatio(win.x0) ?? 0)
    const right = xs.map.get(clampRatio(win.x1) ?? 0)
    const top = ys.map.get(clampRatio(win.y0) ?? 0)
    const bottom = ys.map.get(clampRatio(win.y1) ?? 0)
    return {
      index: Number.isFinite(Number(win.index)) ? Number(win.index) : index,
      col: Number.isFinite(Number(win.col)) ? Number(win.col) : 0,
      row: Number.isFinite(Number(win.row)) ? Number(win.row) : 0,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      x0: clampRatio(win.x0) ?? 0,
      y0: clampRatio(win.y0) ?? 0,
      x1: clampRatio(win.x1) ?? 0,
      y1: clampRatio(win.y1) ?? 0
    }
  })
  return {
    ok: rects.every((rect) => rect.width > 0 && rect.height > 0),
    rects,
    xEdges: xs.pixels,
    yEdges: ys.pixels,
    width: w,
    height: h,
    reason: '',
    message: `${rects.length} 塊（同一數取整邊界：x ${xs.pixels.join('/')}、y ${ys.pixels.join('/')}）`
  }
}

/**
 * **刀向 + 切位 → 逐塊像素矩形**（純函數；源像素座標，行主序 `index = row * cols + col`）。
 *
 * 用途：展示適配層（`components/sliceMeta.js`）由**行上元數據的刀向 / 切位**直接派生矩形
 * —— 與 `pixelRectsOf`（走歸一化窗口）**同源於本檔案**，兩者口徑差別僅在邊界歸一化的
 * 取整路徑：本函數逐值 `Math.round(value × 邊長)`、**末值強制 ＝ 邊長**，退化塊（寬 / 高 ≤ 0）
 * 直接略去；`pixelRectsOf` 則對唯一边界做嚴格遞增取整（保證每段 ≥ 1px）。
 * 邊界一律取自**同一份數組** ⇒ 相鄰塊邊緣座標相接（無白縫、無疊蓋、無重複像素）。
 * @returns {Array<{index:number, col:number, row:number, x:number, y:number, width:number, height:number}>}
 */
export function pixelRectsFromCuts(sourceWidth, sourceHeight, cuts) {
  const width = Math.max(1, toInt(sourceWidth))
  const height = Math.max(1, toInt(sourceHeight))
  let xs = [0, 1]
  let ys = [0, 1]
  ;(Array.isArray(cuts) ? cuts : []).forEach((cut) => {
    const direction = cut && typeof cut === 'object' ? cut.direction : undefined
    const ratio = cut && typeof cut === 'object' ? cut.offsetRatio : undefined
    if (isHorizontalDirection(direction)) ys = splitEdges(ys, ratio, TILE_RATIO_FALLBACK)
    else xs = splitEdges(xs, ratio, TILE_RATIO_FALLBACK)
  })
  const xPx = xs.map((value, index) => (index === xs.length - 1 ? width : Math.round(value * width)))
  const yPx = ys.map((value, index) => (index === ys.length - 1 ? height : Math.round(value * height)))
  const tiles = []
  for (let row = 0; row < yPx.length - 1; row += 1) {
    for (let col = 0; col < xPx.length - 1; col += 1) {
      const x0 = xPx[col]
      const x1 = xPx[col + 1]
      const y0 = yPx[row]
      const y1 = yPx[row + 1]
      if (x1 <= x0 || y1 <= y0) continue
      tiles.push({
        index: row * (xPx.length - 1) + col,
        col,
        row,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0
      })
    }
  }
  return tiles
}

/* ============================================================================
   ⑥ 無縫判據（面積和 / 兩兩交 / 邊緣相接的唯一實現點）
   ============================================================================ */

/**
 * **無縫性機械讀數**（純函數，供展示層 / 證據復用）：
 *   - `areaEqualsSource`：塊面積之和 **恰等於** 源面積（疊蓋會偏大、留縫會偏小）；
 *   - `noOverlap`：兩兩矩形交集面積之和為 0；
 *   - `edgesAdjacent`：任一非整圖邊界既是「某塊的右 / 下邊」也是「某塊的左 / 上邊」；
 *   - `seamless`：三者同時成立。
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects 逐塊矩形（像素）
 * @returns {{tileCount:number, area:number, sourceArea:number, areaEqualsSource:boolean,
 *            overlap:number, noOverlap:boolean, edgesAdjacent:boolean, seamless:boolean}}
 */
export function seamOf(rects, width, height) {
  const list = Array.isArray(rects) ? rects : []
  const w = Math.max(0, Math.round(Number(width) || 0))
  const h = Math.max(0, Math.round(Number(height) || 0))
  const area = list.reduce((sum, rect) => sum + rect.width * rect.height, 0)
  let overlap = 0
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
      const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
      overlap += ox * oy
    }
  }
  const rightEdges = new Set(list.map((rect) => rect.x + rect.width))
  const leftEdges = new Set(list.map((rect) => rect.x))
  const bottomEdges = new Set(list.map((rect) => rect.y + rect.height))
  const topEdges = new Set(list.map((rect) => rect.y))
  const gapFreeX = [...rightEdges].filter((edge) => edge < w).every((edge) => leftEdges.has(edge))
  const gapFreeY = [...bottomEdges].filter((edge) => edge < h).every((edge) => topEdges.has(edge))
  return {
    tileCount: list.length,
    area,
    sourceArea: w * h,
    areaEqualsSource: w > 0 && h > 0 && area === w * h,
    overlap,
    noOverlap: overlap === 0,
    edgesAdjacent: gapFreeX && gapFreeY,
    seamless: w > 0 && h > 0 && area === w * h && overlap === 0 && gapFreeX && gapFreeY
  }
}

/**
 * **拼接落位**（純函數）：把逐塊（帶畫布者）映射成待繪製的落位清單 `{canvas,x,y,width,height}`。
 * 用途：合成（拼接）端只負責 `drawImage`，**落位幾何來自內核** —— 不在渲染模組自算座標。
 * @returns {Array<{canvas:any, x:number, y:number, width:number, height:number}>}
 */
export function placementsOf(tiles) {
  const list = Array.isArray(tiles) ? tiles : []
  return list
    .filter((tile) => tile && tile.canvas)
    .map((tile) => ({
      canvas: tile.canvas,
      x: Number(tile.x),
      y: Number(tile.y),
      width: Number(tile.width),
      height: Number(tile.height)
    }))
}

/* ============================================================================
   ⑦ 凍結入口：planFor
   ============================================================================ */

/**
 * 已登記影像的尺寸真源查詢（**只讀 `seed.js` 的種子影像表**，不碰任何存儲）。
 * 用戶上傳的影像活在前端存儲裡，內核（純函數）看不到 ⇒ 那類調用須**顯式傳入**
 * `sourceWidth` / `sourceHeight`（T2 的 `/plan` 支持 `?width=&height=` 即為此）。
 * @returns {{width:number, height:number}|null}
 */
function registeredSizeOf(assetId) {
  const list = Array.isArray(SEED_IMAGES) ? SEED_IMAGES : []
  for (const row of list) {
    if (row && String(row.id) === assetId) {
      const width = toInt(row.width)
      const height = toInt(row.height)
      return width > 0 && height > 0 ? { width, height } : null
    }
  }
  return null
}

/** 參數是否「有給」（`undefined` / `null` / 空串 ⇒ 沒給）。 */
function isProvided(value) {
  return value !== undefined && value !== null && value !== ''
}

/** 正整數像素邊長判定（`'1600'` 這類數值串可接受；小數 / 非有限 / ≤0 ⇒ 拒）。 */
function positiveIntOrNull(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  if (!Number.isInteger(num)) return null
  return num > 0 ? num : null
}

/**
 * **TileSplicer 凍結入口**：由影像 id + 類別派生完整切片計劃。
 *
 * 參數：`{assetId, kind, sourceWidth, sourceHeight}`
 *   - `assetId`：必填**非空字串**（缺 / 空 / 非字串 ⇒ `INVALID_ARGUMENT`）；
 *   - `kind`：必填（`FACE` / `EDGE` / `PHOTO`，大小寫不敏感；其餘 ⇒ `UNKNOWN_KIND`）；
 *   - `sourceWidth` / `sourceHeight`：可選。**都給** ⇒ 必須為**正整數**像素邊長（否 ⇒ `INVALID_ARGUMENT`）；
 *     **都不給** ⇒ 由內核按 `assetId` 在種子影像表查尺寸；
 *     查不到 ⇒ `NOT_FOUND`（提示改為顯式傳入尺寸）。
 *
 * 返回（成功）：`{ok:true, version, assetId, kind, source:{width,height}, cuts, directions, ratios,
 * cols, rows, tiles:[{index,row,col,rect:{x,y,w,h}}], seam:{ok,areaEqualsSource,noOverlap,edgesAdjacent}}`。
 * 返回（失敗）：`{ok:false, reason:'INVALID_ARGUMENT'|'UNKNOWN_KIND'|'NOT_FOUND', message:'<繁體可讀>'}`。
 *
 * 紀律：**只讀、冪等、零副作用**（不寫盤、不寫庫、不改任何狀態）；同參兩次調用逐字相同；
 * **絕不返回圖片字節 / data URL / 用戶隱私字段**；內部不變量錯誤一律走結構化返回，**不拋異常**。
 */
export function planFor(input) {
  const args = input && typeof input === 'object' ? input : {}

  /* ① assetId：非空字串 */
  if (typeof args.assetId !== 'string' || !args.assetId.trim()) {
    return failure('INVALID_ARGUMENT', '請求參數不完整或無效：assetId 必須為非空字串。')
  }
  const assetId = args.assetId.trim()

  /* ② kind：值域（唯一實現點在 familyOf） */
  const resolved = familyOf(args.kind)
  if (!resolved.ok) {
    return failure('UNKNOWN_KIND', `不支援的 kind「${resolved.kind}」：僅接受 FACE、EDGE 或 PHOTO。`)
  }

  /* ③ 源圖尺寸：顯式參數優先，否則查已登記影像；都拿不到 ⇒ NOT_FOUND */
  const hasWidth = isProvided(args.sourceWidth)
  const hasHeight = isProvided(args.sourceHeight)
  let width = 0
  let height = 0
  if (hasWidth || hasHeight) {
    const w = positiveIntOrNull(args.sourceWidth)
    const h = positiveIntOrNull(args.sourceHeight)
    if (w === null || h === null) {
      return failure('INVALID_ARGUMENT', '請求參數無效：sourceWidth 與 sourceHeight 必須同為正整數像素邊長。')
    }
    width = w
    height = h
  } else {
    const registered = registeredSizeOf(assetId)
    if (!registered) {
      return failure(
        'NOT_FOUND',
        `找不到影像「${assetId}」的尺寸真源：請以 sourceWidth / sourceHeight 顯式傳入尺寸。`
      )
    }
    width = registered.width
    height = registered.height
  }

  /* ④ 元數據 → 歸一化窗口 → 像素矩形（全部走本內核，無第二份實現） */
  const derived = metaFor(assetId, args.kind)
  const meta = derived.meta
  const converted = pixelRectsOf(windowsOf(meta), width, height)
  if (!converted.ok) {
    return failure(
      'INVALID_ARGUMENT',
      `源圖尺寸 ${width}×${height} 不足以切成 ${meta.cols}×${meta.rows} 塊（每塊至少 1px）：${converted.message}`
    )
  }

  /* ⑤ 凍結返回面（鍵序凍結；tiles 只含 {index,row,col,rect:{x,y,w,h}}） */
  const seam = seamOf(converted.rects, width, height)
  return {
    ok: true,
    version: TILESPLICER_VERSION,
    assetId,
    kind: resolved.kind,
    source: { width, height },
    cuts: meta.cuts,
    directions: meta.directions.slice(),
    ratios: meta.ratios.slice(),
    cols: meta.cols,
    rows: meta.rows,
    tiles: converted.rects.map((rect) => ({
      index: rect.index,
      row: rect.row,
      col: rect.col,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    })),
    seam: {
      ok: seam.seamless,
      areaEqualsSource: seam.areaEqualsSource,
      noOverlap: seam.noOverlap,
      edgesAdjacent: seam.edgesAdjacent
    }
  }
}
