/**
 * TileSplicer 只读 API 中間件（xiai · 玺愛）
 * ============================================================================
 * 契約真源：`docs/xiai-plan.md` 的 **R-99 / R-100**（Kevin 逐字授權）。
 *
 * - `GET /api/tilesplicer/v1`                ⇒ 發現面 `{name, version, kinds, cutCounts}`
 * - `GET /api/tilesplicer/v1/plan?assetId=&kind=FACE|PHOTO`
 *                                            ⇒ `{ok:true, version, assetId, kind, source:{width,height},
 *                                                cuts, directions, ratios, cols, rows,
 *                                                tiles:[{index,row,col,rect:{x,y,w,h}}],
 *                                                seam:{ok,areaEqualsSource,noOverlap,edgesAdjacent}}`
 * - 錯誤面（結構化，`message` 為繁體可讀）：`{ok:false, reason, message}`
 *     · 缺參 / 空參                  ⇒ `INVALID_ARGUMENT` + **HTTP 400**
 *     · `kind` 不在 `FACE|PHOTO` 內  ⇒ `UNKNOWN_KIND`     + **HTTP 400**
 *     · 未知路徑 / 未定義方法         ⇒ `NOT_FOUND`        + **HTTP 404**
 *
 * 紀律：
 *   ① **只讀、冪等、零副作用**——不寫盤、不寫庫、不變更任何狀態；同參兩次調用逐字相同；
 *   ② **絕不返回圖片字節**——響應體只含元數據（R-88：切割是元數據，展示時前端現場切分），
 *      不含 `data:` URL、不含 base64 長串、不含圖片 URL；
 *   ③ **不返回任何用戶隱私字段**——響應按**白名單**逐鍵構造，內核多餘字段一律不外泄；
 *   ④ 內核由 `src/tilesplicer/index.js`（T1 落地）提供，本文件**只 import，不實現任何切位/幾何**。
 *
 * 提供方式：掛在 **xiai 自己的 Vite dev server（5163）** 上（`vite.config.js` 的
 * `configureServer`）——**不新佔端口、不起長駐服務**。yinsuo 側用自己的 Vite 代理轉發。
 *
 * 內核加載形態：**請求時動態 import**（而非配置期靜態 import）。理由＝內核文件由並行單
 * 落地，若在配置加載期 import 一個尚未存在的文件，整個 dev server 會起不來 ⇒ 5163 直接 DOWN。
 * 動態 import 讓「內核未就緒」退化為一次結構化的 503，而不是把宿主服務拖下水。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 版本化前綴（凍結）。 */
export const TILESPLICER_API_PREFIX = '/api/tilesplicer/v1'

/** 接受的作品類別（凍結順序）。 */
export const TILESPLICER_KINDS = Object.freeze(['FACE', 'PHOTO'])

/** 各類別刀數（切位數，非塊數）：印面 2 刀 ⇒ 2×2＝4 塊；實拍 3 刀 ⇒ 4×2＝8 塊。 */
export const TILESPLICER_CUT_COUNTS = Object.freeze({ FACE: 2, PHOTO: 3 })

/** 內核模塊（T1 落地）相對工程根的路徑。 */
const CORE_MODULE_REL = 'src/tilesplicer/index.js'

/** 繁體錯誤文案（AC-72：上屏文案一律繁體）。 */
const ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: '請求參數不完整或為空：請提供非空的 assetId 與 kind（FACE 或 PHOTO）。',
  UNKNOWN_KIND: '不支援的 kind：僅接受 FACE 或 PHOTO。',
  NOT_FOUND: '找不到指定的資源：請確認路徑為 /api/tilesplicer/v1 或 /api/tilesplicer/v1/plan。',
  CORE_UNAVAILABLE: 'TileSplicer 內核尚未就緒：暫時無法提供切片計劃，請稍後再試。'
})

/** 內核導入緩存（僅緩存成功；失敗不緩存 ⇒ 內核落地後無需重啟即可生效）。 */
let coreCache = null

/* ------------------------------------------------------------------ 工具 */

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  Object.keys(extraHeaders).forEach((key) => res.setHeader(key, extraHeaders[key]))
  res.end(payload)
}

function sendError(res, status, reason) {
  return sendJson(res, status, { ok: false, reason, message: ERROR_MESSAGES[reason] })
}

/** 結構化錯誤（可帶內核的繁體 message；缺省時回落到本模組的凍結文案）。 */
function sendErrorWith(res, status, reason, message) {
  const text = typeof message === 'string' && message.trim() ? message.trim() : ERROR_MESSAGES[reason]
  return sendJson(res, status, { ok: false, reason, message: text })
}

/** 請求期動態載入內核（失敗返回 `null`，由調用方給結構化 503，不假造數據）。 */
async function loadCore(rootDir) {
  const abs = path.join(rootDir, CORE_MODULE_REL)
  if (coreCache && coreCache.abs === abs) return coreCache.mod
  const mod = await import(pathToFileURL(abs).href)
  coreCache = { abs, mod }
  return mod
}

/** 有限數字或 `null`；**缺參（`null`/`undefined`/空串）一律 `null`** —— 不得落成 `0`（`Number(null) === 0` 是陷阱）。 */
function finiteNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 可選的源圖尺寸查詢參數（`width` / `height`）。
 * 契約的 `/plan` 只需 `assetId` + `kind`；尺寸由內核按其自身口徑派生。
 * 顯式傳入時作為**輸入**轉交內核（不在此處做任何幾何計算）。
 */
function optionalSourceSize(searchParams) {
  const width = finiteNumber(searchParams.get('width'))
  const height = finiteNumber(searchParams.get('height'))
  return { width, height }
}

/* -------------------------------------------------------- 響應白名單映射 */

/** 逐塊矩形白名單化：只保留 `{index,row,col,rect:{x,y,w,h}}`。 */
function normalizeTiles(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  raw.forEach((tile, position) => {
    if (!tile || typeof tile !== 'object') return
    const rect = tile.rect && typeof tile.rect === 'object' ? tile.rect : {}
    const index = finiteNumber(tile.index)
    const row = finiteNumber(tile.row)
    const col = finiteNumber(tile.col)
    out.push({
      index: index === null ? position : index,
      row: row === null ? 0 : row,
      col: col === null ? 0 : col,
      rect: {
        x: finiteNumber(rect.x) ?? 0,
        y: finiteNumber(rect.y) ?? 0,
        w: finiteNumber(rect.w) ?? 0,
        h: finiteNumber(rect.h) ?? 0
      }
    })
  })
  return out
}

/** 拼接診斷白名單化：只保留凍結四鍵。 */
function normalizeSeam(raw) {
  const seam = raw && typeof raw === 'object' ? raw : {}
  return {
    ok: seam.ok === true,
    areaEqualsSource: seam.areaEqualsSource === true,
    noOverlap: seam.noOverlap === true,
    edgesAdjacent: seam.edgesAdjacent === true
  }
}

/**
 * 由內核產物構造**凍結鍵序**的 `/plan` 響應體。
 * 白名單式逐鍵取值 ⇒ 內核多餘字段（用戶隱私字段、內部錨點等）一律不外泄。
 */
function buildPlanBody(planResult, { assetId, kind, sourceWidth, sourceHeight, version }) {
  const plan = planResult && typeof planResult === 'object' ? planResult : {}
  const planSource = plan.source && typeof plan.source === 'object' ? plan.source : {}
  const width = finiteNumber(planSource.width)
    ?? finiteNumber(plan.sourceWidth)
    ?? (Number.isFinite(sourceWidth) ? sourceWidth : null)
  const height = finiteNumber(planSource.height)
    ?? finiteNumber(plan.sourceHeight)
    ?? (Number.isFinite(sourceHeight) ? sourceHeight : null)

  return {
    ok: true,
    version,
    assetId,
    kind,
    source: { width, height },
    cuts: plan.cuts,
    directions: Array.isArray(plan.directions) ? plan.directions.slice() : [],
    ratios: Array.isArray(plan.ratios) ? plan.ratios.slice() : [],
    cols: finiteNumber(plan.cols),
    rows: finiteNumber(plan.rows),
    tiles: normalizeTiles(plan.tiles),
    seam: normalizeSeam(plan.seam)
  }
}

/* ------------------------------------------------------------- 路由處理 */

async function handleDiscovery(res, rootDir) {
  const core = await loadCore(rootDir)
  const version = core && core.TILESPLICER_VERSION ? core.TILESPLICER_VERSION : null
  const name = core && core.TILESPLICER_NAME ? core.TILESPLICER_NAME : 'TileSplicer'
  return sendJson(res, 200, {
    name,
    version,
    kinds: TILESPLICER_KINDS.slice(),
    cutCounts: { FACE: TILESPLICER_CUT_COUNTS.FACE, PHOTO: TILESPLICER_CUT_COUNTS.PHOTO }
  })
}

async function handlePlan(res, rootDir, url) {
  const rawAssetId = url.searchParams.get('assetId')
  const rawKind = url.searchParams.get('kind')
  const assetId = typeof rawAssetId === 'string' ? rawAssetId.trim() : ''
  const kind = typeof rawKind === 'string' ? rawKind.trim() : ''

  // ① 缺參 / 空參 ⇒ INVALID_ARGUMENT（先於 kind 值域判定：連參數都沒給，談不上「值不合法」）
  if (!assetId || !kind) return sendError(res, 400, 'INVALID_ARGUMENT')

  // ② kind 值域（逐字比對 FACE / PHOTO，不做大小寫歸一 —— 契約逐字）
  if (!TILESPLICER_KINDS.includes(kind)) return sendError(res, 400, 'UNKNOWN_KIND')

  let core
  try {
    core = await loadCore(rootDir)
  } catch (error) {
    return sendError(res, 503, 'CORE_UNAVAILABLE')
  }
  if (!core || typeof core.planFor !== 'function') {
    return sendError(res, 503, 'CORE_UNAVAILABLE')
  }

  const { width, height } = optionalSourceSize(url.searchParams)
  const version = core.TILESPLICER_VERSION || null

  let planResult
  try {
    planResult = await core.planFor({
      assetId,
      kind,
      sourceWidth: width === null ? undefined : width,
      sourceHeight: height === null ? undefined : height
    })
  } catch (error) {
    // 內核的結構化失敗（如資源不存在）按凍結錯誤面透傳；未預期錯誤**不假造計劃**，走結構化 503。
    const reason = error && typeof error.reason === 'string' ? error.reason : ''
    if (reason === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND')
    if (reason === 'INVALID_ARGUMENT') return sendError(res, 400, 'INVALID_ARGUMENT')
    if (reason === 'UNKNOWN_KIND') return sendError(res, 400, 'UNKNOWN_KIND')
    return sendError(res, 503, 'CORE_UNAVAILABLE')
  }

  if (planResult && planResult.ok === false) {
    const reason = ['INVALID_ARGUMENT', 'UNKNOWN_KIND', 'NOT_FOUND'].includes(planResult.reason)
      ? planResult.reason
      : null
    if (reason) return sendErrorWith(res, reason === 'NOT_FOUND' ? 404 : 400, reason, planResult.message)
    return sendError(res, 503, 'CORE_UNAVAILABLE')
  }

  return sendJson(res, 200, buildPlanBody(planResult, { assetId, kind, sourceWidth: width, sourceHeight: height, version }))
}

/**
 * 處理本中間件名前綴下的請求。
 * @returns {Promise<boolean>} 是否已應答（false ⇒ 交由下一個中間件）
 */
async function handleApiRequest(req, res, pathname, rootDir) {
  // 只讀：僅 GET / HEAD 有語義；其餘方法一律結構化 NOT_FOUND（契約未定義的路徑/方法）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 404, 'NOT_FOUND')
    return true
  }

  const normalized = pathname.replace(/\/+$/, '') || '/'

  if (normalized === TILESPLICER_API_PREFIX) {
    await handleDiscovery(res, rootDir)
    return true
  }

  if (normalized === `${TILESPLICER_API_PREFIX}/plan`) {
    await handlePlan(res, rootDir, new URL(req.url, 'http://localhost'))
    return true
  }

  sendError(res, 404, 'NOT_FOUND')
  return true
}

/* --------------------------------------------------------------- 中間件 */

/**
 * 建立 TileSplicer 只讀 API 中間件。
 * @param {{root?:string}} [options] `root` ＝工程根（用於解析內核模塊路徑）
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse, next:Function) => void}
 */
export function createTilesplicerMiddleware(options = {}) {
  const rootDir = options.root || process.cwd()
  /** 前綴根：`/api/tilesplicer` 之下的任何路徑都歸本中間件答覆（未知者 ⇒ 404 結構化）。 */
  const scope = '/api/tilesplicer'

  return function tilesplicerMiddleware(req, res, next) {
    let pathname
    try {
      pathname = new URL(req.url, 'http://localhost').pathname
    } catch (error) {
      return next()
    }

    if (pathname !== scope && !pathname.startsWith(`${scope}/`)) return next()

    handleApiRequest(req, res, pathname, rootDir).catch(() => {
      if (!res.headersSent) {
        sendError(res, 503, 'CORE_UNAVAILABLE')
      } else {
        res.end()
      }
    })
  }
}

export default createTilesplicerMiddleware
