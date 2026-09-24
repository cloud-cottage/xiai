/**
 * 真实数据源实现（R-101 二次封装：A27 消费 xiai TileSplicer API）。
 *
 * 现状：**仅 A27 `getDisplaySlices` 已接线**（消费 xiai 侧 TileSplicer 只读 API），
 * 其余方法仍为「未接入」的明确失败 —— 本文件**绝不返回伪造数据**。
 *
 * 边界（R-103 跨工程单向边界）：
 *   ① 只经 **HTTP 契约**消费 xiai（`/api/tilesplicer/v1`，经 yinsuo 自己的 Vite 代理转 127.0.0.1:5163）；
 *   ② **不得 import xiai 源码**（本文件除 yinsuo 自己的 `@/...` 模块外零跨工程 import）；
 *   ③ **不得在 yinsuo 重算切位 / 另写切割或几何逻辑** —— 几何一律逐字段取自真源响应
 *      （`tiles[].rect` / `cuts` / `directions` / `ratios` / `cols` / `rows` / `seam`），本层只做**包装**：
 *      包签名 URL、包 TTL、包缓存键、包字段名（R-101 / R-102）；
 *   ④ xiai 不可达 / 非 200 / 结构不符 ⇒ **结构化失败**（`code` + `reason` + 请求读数），
 *      **不回落到任何本地 / mock 数据**，也不得以空切片数组或占位图冒充成功。
 *
 * 块数以真源为准（R-102）：印面 FACE ⇒ 2 刀 / **4 块** / 2×2；实拍 PHOTO ⇒ 3 刀 / **8 块** / 4×2。
 * 本文件**不写死任何块数**，`slices.length` 恒等于真源 `tiles.length`。
 *
 * 严禁在本文件中返回任何伪造数据 —— 未接入就是未接入。
 */
import { API_BASE_URL } from '@/config/env.js'
import { PRICING } from '@/config/pricing.js'
import { toCstDate } from '@/data/time.js'

/** 统一未接入失败（页面应展示错误态 + 「演示环境：该功能未接入」）。 */
function notConnected(method, endpoint) {
  return Promise.reject(
    Object.assign(new Error(`演示环境：接口未接入（${method} → ${endpoint}）`), {
      code: 'NOT_CONNECTED',
      method,
      endpoint,
      apiBaseUrl: API_BASE_URL,
    }),
  )
}

/**
 * 各方法对应的真实接入点（spec §8.4）。
 * 下轮实现时：把 fetch(API_BASE_URL + endpoint) 的结果映射为同一契约的返回结构。
 */
export const ENDPOINTS = Object.freeze({
  getAppConfig: 'GET /api/v1/config',
  register: 'POST /api/v1/auth/register',
  login: 'POST /api/v1/auth/login',
  logout: 'POST /api/v1/auth/logout',
  getSession: 'GET /api/v1/me',
  listApiKeys: 'GET /api/v1/keys',
  createApiKey: 'POST /api/v1/keys',
  rotateApiKey: 'POST /api/v1/keys/{kid}/rotate',
  setApiKeyStatus: 'PATCH /api/v1/keys/{kid}',
  deleteApiKey: 'DELETE /api/v1/keys/{kid}',
  getUsageSummary: 'GET /api/v1/usage/summary',
  getUsageBreakdown: 'GET /api/v1/usage/breakdown?dim=',
  getUsageTrend: 'GET /api/v1/usage/trend',
  listUsageRecords: 'GET /api/v1/usage/records',
  exportUsage: 'GET /api/v1/usage/export',
  getAccount: 'GET /api/v1/account',
  getPlans: 'GET /api/v1/plans',
  getPricingTable: 'GET /api/v1/plans',
  computeScenario: '（可复用前端纯函数，前后端一致性来源）',
  createRechargeOrder: 'POST /api/v1/recharge/orders',
  getRechargeOrder: 'GET /api/v1/recharge/orders/{id}',
  listRechargeOrders: 'GET /api/v1/recharge/orders',
  simulatePayResult: 'POST /api/v1/recharge/orders/{id}/simulate（仅演示环境存在）',
  settleRechargeOrder: '支付回调服务',
  listLedgerEntries: 'GET /api/v1/ledger',
  listSeals: 'GET /api/v1/seals',
  getSeal: 'GET /api/v1/seals/{id}',
  getDisplaySlices: 'GET /api/tilesplicer/v1/plan?assetId=&kind=&width=&height=（xiai TileSplicer；R-101 二次封装）',
  submitDemoApplication: 'POST /api/v1/applications',
  listFaq: 'CMS / 静态内容',
  listDownloads: 'CMS / 静态内容',
  getOriginalQuota: 'GET /v1/me/original-quota',
  requestOriginalDownload: 'POST /v1/assets/{assetId}/original-download（服务端鉴权 + 额度校验后签发）',
})

const apiImpl = {}
for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
  apiImpl[name] = () => notConnected(name, endpoint)
}

/* ==========================================================================
 * A27 —— 展示切片（R-101 二次封装：消费 xiai TileSplicer API）
 *
 * 契约（xiai 侧，冻结）：
 *   · `GET {prefix}`            ⇒ `{name,version,kinds,cutCounts}`
 *   · `GET {prefix}/plan?assetId=&kind=FACE|PHOTO&width=&height=`
 *       成功 ⇒ `{ok:true,version,assetId,kind,source:{width,height},cuts,directions,ratios,cols,rows,
 *                tiles:[{index,row,col,rect:{x,y,w,h}}],seam:{ok,areaEqualsSource,noOverlap,edgesAdjacent}}`
 *       失败 ⇒ `{ok:false,reason:'INVALID_ARGUMENT'|'UNKNOWN_KIND'|'NOT_FOUND',message:'<繁体>'}`（400/400/404）
 * ========================================================================== */

/** xiai TileSplicer API 版本化前缀（逐字；**不 rewrite**，由 yinsuo 的 Vite 代理转 127.0.0.1:5163）。 */
const TILESPLICER_API_PREFIX = '/api/tilesplicer/v1'

/** 计划端点（相对路径：同源 ⇒ 免 CORS，请求由 dev / preview 的代理转发）。 */
const TILESPLICER_PLAN_PATH = `${TILESPLICER_API_PREFIX}/plan`

/**
 * **yinsuo 侧自持的源图尺寸表（尺寸来源逐字登记）**：
 *   · 尺寸是本层的**输入**，显式随请求传给真源（`width`/`height`）——
 *     **不依赖 xiai 的种子表**（两工程 assetId 空间不同，xiai 种子表里没有 yinsuo 的 assetId）；
 *   · 真源在缺尺寸时按其自身口径派生，本层**必须给全**，故按「作品类别」登记常量：
 *       - 印面 FACE ：`1200 × 1200`（方形印面）
 *       - 实拍 PHOTO：`1600 × 1200`（4:3 实拍）
 *   · 缺口（登记，不在本单代裁）：真实尺寸应由 yinsuo **自身资源服务**（A25/A26 的 ImageAsset
 *     `width`/`height`）下发；当前 A25/A26 在 api 模式下未接入 ⇒ 本层以常量登记演示尺寸。
 *     接入后改法：把 A26 的 `assets[].width/height` 透传进 `options.width/height` 即可，其余不动。
 */
const YS_SOURCE_DIMENSIONS = Object.freeze({
  FACE: Object.freeze({ width: 1200, height: 1200 }),
  PHOTO: Object.freeze({ width: 1600, height: 1200 }),
})

/**
 * yinsuo 影像类别（contract.ASSET_KIND：FACE 印面 / EDGE 边款 / IMPRESSION 钤本）
 * → xiai TileSplicer 作品类别（值域只有两值 `FACE|PHOTO`，逐字大写）。
 * 边款 / 钤本属**实拍影像** ⇒ 归 PHOTO 族（3 刀 / 8 块）。
 */
const XIAI_KIND_BY_ASSET_KIND = Object.freeze({
  FACE: 'FACE',
  EDGE: 'PHOTO',
  IMPRESSION: 'PHOTO',
})

/**
 * 默认作品类别 ＝ `FACE`（印面）。理由（逐字登记，非猜测）：
 * 首页样例卡（`HomePage.vue` 的 `samples`）取的是 A25 首个玺印的 `assets[0].assetId`，
 * 而 mock 种子（`seed.js::seedSeals`）对每个玺印**恒把 `assets[0]` 定为 `ASSET_KIND.FACE`（印面）**
 * ⇒ 该 assetId 走 FACE 族（2 刀 / 4 块）。调用方可用 `options.kind` 显式覆盖。
 */
const DEFAULT_XIAI_KIND = 'FACE'

/** 时区换算常量：一小时的秒数（非价格 / 非包量字面量）。 */
const SECONDS_PER_HOUR = 60 * 60

/** 24 小时毫秒数（自然日粒度换算用）。 */
const MS_PER_DAY = 24 * SECONDS_PER_HOUR * 1000

/** 稳定字符串散列（FNV-1a）—— 仅供**签名流**取种子。 */
function hashSeed(text) {
  const str = String(text)
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 确定性 PRNG（mulberry32）—— **仅供签名流**；本层不据此派生任何几何。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 当前 CST 自然日（spec §7.5）。 */
function currentCstDate() {
  return toCstDate(new Date().toISOString())
}

/**
 * 切片**内容缓存** TTL ＝ 当日剩余秒数（至 Asia/Shanghai 次日 00:00:00；自然日粒度）。
 * 与 `sigTtlSeconds`（签名 TTL，配置项）是**两个独立计时**（§7.7-10 / AC-79）。
 */
function secondsUntilCstMidnight() {
  const [y, m, d] = currentCstDate().split('-').map(Number)
  const utcStartOfToday = Date.UTC(y, m - 1, d) - 8 * SECONDS_PER_HOUR * 1000
  return Math.max(0, Math.floor((utcStartOfToday + MS_PER_DAY - Date.now()) / 1000))
}

/**
 * 切片**签名**签发序号——每签发一次递增。
 * 「签名流与内容流解耦」在本文件的表现：几何完全来自真源（本层无内容流 PRNG），
 * 签名种子含本序号与签发时刻 ⇒ **重复获取必得新签名**，而几何逐字不变（AC-79）。
 */
let sliceSigIssueCount = 0

/** 签发**一片**切片的**独立**签名（每片不得共用：种子含片序）。 */
function issueSliceSig(assetId, sliceIndex) {
  sliceSigIssueCount += 1
  const rnd = mulberry32(hashSeed(`${assetId}#${sliceIndex}#sig@${sliceSigIssueCount}@${Date.now()}`))
  const suffix = Math.floor(rnd() * 0xffffffff).toString(36) + Math.floor(rnd() * 0xffffffff).toString(36)
  return `sig=${hashSeed(`${assetId}#${sliceIndex}`).toString(36)}${suffix}`
}

/**
 * **结构化失败**（R-101 / §7.7 v1.34 注③）：`code` + `reason` + 请求读数齐备，
 * 供页面渲染可读失败态；**不返回任何切片数据**。
 */
function structuredFail(code, message, extra = {}) {
  return Promise.reject(Object.assign(new Error(message), { code, ...extra }))
}

/** 解析 yinsuo 影像类别 → xiai 作品类别（缺省 FACE；非法值不静默纠正，交由真源判 UNKNOWN_KIND）。 */
function resolveXiaiKind(kind) {
  if (kind === null || kind === undefined || kind === '') return DEFAULT_XIAI_KIND
  const upper = String(kind).trim().toUpperCase()
  return XIAI_KIND_BY_ASSET_KIND[upper] || upper
}

/**
 * 解析**显式传给真源的**源图尺寸：调用方覆盖优先（`options.width/height`），
 * 否则取本层登记的类别常量。两值必须同为正整数（不完整 ⇒ 结构化失败，不猜）。
 */
function resolveSourceDimensions(kind, options = {}) {
  const fallback = YS_SOURCE_DIMENSIONS[kind] || YS_SOURCE_DIMENSIONS[DEFAULT_XIAI_KIND]
  const width = Number(options.width === undefined || options.width === null ? fallback.width : options.width)
  const height = Number(options.height === undefined || options.height === null ? fallback.height : options.height)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
  }
}

/** 真源矩形白名单化（只取几何，不派生）：`{x,y,w,h}` 四值皆为有限数且 w/h > 0。 */
function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const w = Number(raw.w)
  const h = Number(raw.h)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** 有限数数组（真源 `ratios`）；非数组 / 含非有限数 ⇒ null（结构不符）。 */
function normalizeNumberList(raw) {
  if (!Array.isArray(raw)) return null
  const out = raw.map((n) => Number(n))
  return out.every((n) => Number.isFinite(n)) ? out : null
}

/** 非空字符串数组（真源 `directions`）。 */
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return null
  return raw.every((v) => typeof v === 'string' && v) ? raw.slice() : null
}

/**
 * 拉取真源切片计划（**只读、无副作用**；只发这一个请求，不落任何本地库 / 缓存）。
 * 网络层失败**在此抛出**，由调用方转成结构化失败。
 */
async function fetchTileSplicerPlan(requestedUrl) {
  const response = await fetch(requestedUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
  })
  let body = null
  let parseError = null
  try {
    body = await response.json()
  } catch (error) {
    parseError = error
  }
  return { response, body, parseError }
}

/**
 * A27 —— 取展示切片（R-101 二次封装）。
 *
 * @param {string} assetId yinsuo 影像资源 ID（**yinsuo 自己的 ID 空间**，与 xiai 种子表无关）
 * @param {{kind?:string,width?:number,height?:number}} [options]
 *        `kind`：yinsuo 影像类别（FACE/EDGE/IMPRESSION）或 xiai 类别（FACE/PHOTO），缺省 FACE；
 *        `width`/`height`：**显式源图尺寸**（缺省取本层登记的类别常量）。
 * @returns {Promise<object>} yinsuo 自己的 `displaySliceGroup` 形状：
 *   `{assetId, previewUrl, previewExpiresAt, slices[], sliceMeta{...真源几何逐字...},
 *     sliceContentTtlSeconds, sliceContentCacheKey, sigTtlSeconds}`
 *   `slices[]`：每片 `{sliceIndex, url, bytes, sigExpiresAt, row, col, rect{x,y,w,h}}`，**逐片独立签名**。
 */
apiImpl.getDisplaySlices = async function getDisplaySlices(assetId, options = {}) {
  const id = typeof assetId === 'string' ? assetId.trim() : ''
  const kind = resolveXiaiKind(options.kind)
  const { width, height } = resolveSourceDimensions(kind, options)

  if (!id) {
    return structuredFail('INVALID_ARGUMENT', '缺少 assetId：展示切片以资源 ID 为入参（spec §8.2 A27）', {
      reason: 'INVALID_ARGUMENT',
      endpoint: ENDPOINTS.getDisplaySlices,
      kind,
      sourceDimensions: { width, height },
    })
  }
  if (width === null || height === null) {
    return structuredFail(
      'INVALID_ARGUMENT',
      '源图尺寸不完整：width/height 必须同为正整数（本层显式传参，不依赖真源种子表）',
      { reason: 'INVALID_ARGUMENT', endpoint: ENDPOINTS.getDisplaySlices, assetId: id, kind, sourceDimensions: { width, height } },
    )
  }

  /** 请求 URL（相对 → 同源 → 经 yinsuo 的 Vite 代理转 127.0.0.1:5163；**前缀不 rewrite**）。 */
  const requestedUrl = `${TILESPLICER_PLAN_PATH}?assetId=${encodeURIComponent(id)}&kind=${kind}`
    + `&width=${width}&height=${height}`

  let response = null
  let body = null
  let parseError = null
  try {
    ({ response, body, parseError } = await fetchTileSplicerPlan(requestedUrl))
  } catch (error) {
    return structuredFail(
      'TILESPLICER_UNREACHABLE',
      `切片服务不可用：无法连到 xiai TileSplicer API（${TILESPLICER_PLAN_PATH}）。本层已结构化失败，不回退任何本地演示数据。`,
      {
        reason: 'TILESPLICER_UNREACHABLE',
        cause: String((error && error.message) || error),
        requestedUrl,
        endpoint: ENDPOINTS.getDisplaySlices,
        assetId: id,
        kind,
        sourceDimensions: { width, height },
      },
    )
  }

  if (parseError || body === null || typeof body !== 'object') {
    return structuredFail(
      'TILESPLICER_INVALID_RESPONSE',
      `切片计划响应不可解析：真源未返回合法 JSON（${TILESPLICER_PLAN_PATH}）。本层不造伪数据。`,
      {
        reason: 'TILESPLICER_INVALID_RESPONSE',
        httpStatus: response ? response.status : null,
        requestedUrl,
        endpoint: ENDPOINTS.getDisplaySlices,
        assetId: id,
        kind,
      },
    )
  }

  /** 真源的结构化错误面（400 / 404）：逐字透传 `reason` 与繁体 `message`，不降级、不替代。 */
  if (body.ok !== true) {
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'TILESPLICER_INVALID_RESPONSE'
    const message = typeof body.message === 'string' && body.message
      ? body.message
      : `切片计划请求失败：真源返回 ok=false（HTTP ${response.status}）。本层不造伪数据。`
    return structuredFail(reason, message, {
      reason,
      httpStatus: response.status,
      requestedUrl,
      endpoint: ENDPOINTS.getDisplaySlices,
      assetId: id,
      kind,
    })
  }

  /** 结构校验：几何字段缺一不可（缺 ⇒ 结构化失败；**不得**用默认值补齐成「看起来正常」的切片）。 */
  const source = body.source && typeof body.source === 'object' ? body.source : null
  const sourceWidth = source ? Number(source.width) : NaN
  const sourceHeight = source ? Number(source.height) : NaN
  const directions = normalizeStringList(body.directions)
  const ratios = normalizeNumberList(body.ratios)
  const cols = Number(body.cols)
  const rows = Number(body.rows)
  const tiles = Array.isArray(body.tiles) ? body.tiles : null
  const rects = tiles ? tiles.map((tile) => normalizeRect(tile && tile.rect)) : null
  const structureOk = Boolean(
    source
    && Number.isFinite(sourceWidth) && sourceWidth > 0
    && Number.isFinite(sourceHeight) && sourceHeight > 0
    && directions
    && ratios
    && Number.isFinite(cols) && cols > 0
    && Number.isFinite(rows) && rows > 0
    && tiles && tiles.length > 0
    && rects.every(Boolean),
  )
  if (!structureOk) {
    return structuredFail(
      'TILESPLICER_INVALID_RESPONSE',
      '切片计划结构不符：真源响应缺少必需的几何字段（source / directions / ratios / cols / rows / tiles[].rect）。本层不造伪数据。',
      {
        reason: 'TILESPLICER_INVALID_RESPONSE',
        httpStatus: response.status,
        requestedUrl,
        endpoint: ENDPOINTS.getDisplaySlices,
        assetId: id,
        kind,
      },
    )
  }

  const ttlSeconds = PRICING.displaySlices.signedUrlTtlSeconds
  const generatedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  const contentDay = currentCstDate()

  /**
   * 逐片映射：**几何逐字取自真源**（`rect` / `row` / `col`），
   * 签名 URL 由**本层自持的签名流**逐片独立签发（不得共用）。
   * `bytes` / `previewUrl` 真源不下发（R-99 / AC-100：API 只返元数据、不返图片字节与图片 URL）
   * ⇒ 本层给 `null`，由 UI 显示「未下发」，**不以估算值充数**。
   */
  const slices = tiles.map((tile, position) => {
    const index = Number.isFinite(Number(tile.index)) ? Number(tile.index) : position
    return {
      sliceIndex: index,
      url: `about:placeholder#${id}/slice-${index}?${issueSliceSig(id, index)}`,
      bytes: null,
      sigExpiresAt: expiresAt,
      row: Number.isFinite(Number(tile.row)) ? Number(tile.row) : null,
      col: Number.isFinite(Number(tile.col)) ? Number(tile.col) : null,
      rect: rects[position],
    }
  })

  return {
    assetId: id,
    /** 真源不返原图 / 预览直链（展示通道不得签发原图 URL，AC-80①）⇒ 显式 null。 */
    previewUrl: null,
    previewExpiresAt: null,
    slices,
    sliceMeta: {
      /** 既有字段（向后兼容同语义）：切向 / 切位取**真源第 1 刀**。 */
      direction: directions[0],
      offsetRatio: ratios[0],
      sourceWidth: Number(source.width),
      sourceHeight: Number(source.height),
      generatedAt,
      /** 真源几何**逐字保留**（R-101：不得在 yinsuo 重算切位）。 */
      tilesplicerVersion: typeof body.version === 'string' ? body.version : null,
      kind: body.kind,
      cuts: body.cuts,
      directions,
      ratios,
      cols,
      rows,
      seam: body.seam && typeof body.seam === 'object' ? body.seam : null,
      tiles: tiles.map((tile, position) => ({
        index: Number.isFinite(Number(tile.index)) ? Number(tile.index) : position,
        row: Number.isFinite(Number(tile.row)) ? Number(tile.row) : null,
        col: Number.isFinite(Number(tile.col)) ? Number(tile.col) : null,
        rect: rects[position],
      })),
      /** 请求读数（自证经代理命中真源；失败态 / 证据面可读）。 */
      sourcePlanUrl: requestedUrl,
    },
    /** 内容缓存 TTL ＝ 当日剩余秒数（至 CST 次日 00:00；自然日粒度，本层自持）。 */
    sliceContentTtlSeconds: secondsUntilCstMidnight(),
    /** 内容缓存键 ＝ `assetId:CST自然日`（本层自持；与签名解耦）。 */
    sliceContentCacheKey: `${id}:${contentDay}`,
    /** 签名 TTL 取自配置（AC-77 / §11.2-22：配置项、不得硬编码）。 */
    sigTtlSeconds: ttlSeconds,
  }
}

export default apiImpl
