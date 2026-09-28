/**
 * TileSplicer 導出面（xiai · 玺愛）—— **T1 凍結**
 * ============================================================================
 * 本檔案只是**導出面**（無任何實現）：實現全部在 `./core.js`（**真源恰 1 處**）。
 * 消費方（T2 的 `src/tilesplicer/server.js`、xiai 的三處內部消費方、將來的 yinsuo）
 * 一律從本檔案 import。
 *
 * 凍結導出面（**逐字不得改**）：
 *   - `TILESPLICER_NAME`    ＝ `'TileSplicer'`
 *   - `TILESPLICER_VERSION` ＝ `'tilesplicer/v1'`
 *   - `planFor({assetId, kind, sourceWidth, sourceHeight})`
 *       ⇒ `{ok:true, version, assetId, kind, source:{width,height}, cuts, directions, ratios,
 *           cols, rows, tiles:[{index,row,col,rect:{x,y,w,h}}],
 *           seam:{ok,areaEqualsSource,noOverlap,edgesAdjacent}}`
 *       ⇒ 錯誤 `{ok:false, reason:'INVALID_ARGUMENT'|'UNKNOWN_KIND'|'NOT_FOUND', message:'<繁體可讀>'}`
 *     塊數口徑：`kind='FACE'` ⇒ 2 刀 / **4 塊 / 2×2**；`kind='PHOTO'` ⇒ 3 刀 / **8 塊 / 4×2**。
 *
 * 其餘導出＝內核基元（xiai 內部三處消費方**轉調**用；同樣**只在本模組鏈上有定義點**）：
 *   - `metaFor(assetId, kind, options)`：切片元數據派生（`{directions,ratios,cols,rows,cuts}`）
 *   - `windowsOf(meta)`：元數據 → 逐塊**歸一化窗口**（`x0/y0/x1/y1`）
 *   - `pixelRectsOf(windows, width, height)`：歸一化窗口 → **設備像素矩形**（像素級無縫）
 *   - `pixelRectsFromCuts(width, height, cuts)`：刀向 + 切位 → 逐塊像素矩形
 *   - `seamOf(rects, width, height)`：無縫性機械讀數
 *   - `placementsOf(tiles)`：拼接落位（合成端只負責 `drawImage`）
 *   - `familyOf(kind)` / `directionOf(value)` / `clampRatio(value)`：值域與歸一謂詞
 *   - 常量轉口：`SLICE_META_FIELD` / `SLICE_DIRECTIONS` / `SLICE_CUT_COUNTS`
 */

export {
  /* 凍結身份常量 */
  TILESPLICER_NAME,
  TILESPLICER_VERSION,
  /* 凍結入口 */
  planFor,
  /* 內核基元（消費方轉調用） */
  metaFor,
  windowsOf,
  pixelRectsOf,
  pixelRectsFromCuts,
  seamOf,
  placementsOf,
  familyOf,
  directionOf,
  clampRatio,
  ratioAt,
  /* 常量轉口（真源仍為 data/seed.js；此處只為「一處 import 面」） */
  SLICE_META_FIELD,
  SLICE_DIRECTIONS,
  SLICE_CUT_COUNTS
} from './core.js'
