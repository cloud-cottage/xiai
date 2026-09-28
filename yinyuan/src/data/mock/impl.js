/**
 * ============================================================================
 * 数据源适配层 —— mock 实现（spec §8.2 / §8.3，R1 / R9）
 *
 * 与 src/data/api/impl.js 满足**同一契约**（A1–A29，spec §8.2）。
 * 页面不得直接 import 本文件（§8.3-3），只允许 import '@/data'。
 *
 * 关键口径：
 * - 每个方法都有 300–800ms 人工延迟（§8.3-4），用于暴露页面加载态缺失；
 * - 数据只存内存 / sessionStorage（§8.1），不落 localStorage；
 * - 伪随机由固定种子驱动（§8.1），同一会话多次渲染结果一致；
 * - 金额一律整数分；时间一律 UTC ISO8601；展示由页面按 CST 换算（§3.1/§7.5）；
 * - 价格全部来自 src/config/pricing.js，本文件不定义任何价格。
 * ============================================================================
 */
import { APP_CONFIG } from '@/config/app-config.js'
import { MOCK_LATENCY_MS } from '@/config/env.js'
import {
  PRICING, computeScenario as computeScenarioPure, formatCents, getOriginalQuotaPolicy,
  getPlanById, getPlans as getPlansFromConfig, getPricingTable as buildPricingTable,
} from '@/config/pricing.js'
import * as C from '@/data/contract.js'
import { toCstDate, toCstDateTime, toCstMonth } from '@/data/time.js'
import {
  DEMO_PASSWORD, DEMO_USER, DOWNLOAD_SEED, FAQ_SEED, SEED_ANNUAL_FEE_PAID_UNTIL,
  SEED_INITIAL_RECHARGE_CENTS, generatePlaintextKey, maskKey, mulberry32, randomKid,
  seedApiKeys, seedDisplayTraffic, seedSeals, seedUsageRecords,
} from './seed.js'

const PERSIST_KEY = 'yinsuo.mock.v1'
const DEMO_USER_ID = DEMO_USER.userId

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 300–800ms 人工延迟（§8.3-4）。 */
function delay() {
  const span = MOCK_LATENCY_MS.max - MOCK_LATENCY_MS.min
  const ms = MOCK_LATENCY_MS.min + Math.floor(Math.random() * (span + 1))
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(code, message, extra) {
  return Promise.reject(Object.assign(new Error(message), { code }, extra || {}))
}

function nowIso() {
  return new Date().toISOString()
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/**
 * 分页信封（spec §8.2 契约形状②）：`{items,total,page,pageSize,totalPages}`。
 * 所有分页型方法（A13/A21/A24/A25）一律返回该形状，**不得返回裸数组**，
 * 否则换真库时页面必须改动（违 §8.3-2 / §8.4 的「页面零改动」）。
 */
function paginate(list, page = {}, defaultPageSize = 20) {
  const pageSize = Math.max(1, Number(page.pageSize) || defaultPageSize)
  const pageNo = Math.max(1, Number(page.page) || 1)
  const start = (pageNo - 1) * pageSize
  return {
    items: clone(list.slice(start, start + pageSize)),
    total: list.length,
    page: pageNo,
    pageSize,
    totalPages: Math.max(1, Math.ceil(list.length / pageSize)),
  }
}

/** 当月起点的 UTC ISO（把「每月 1 日 00:00 CST」换算为 UTC）。 */
function monthStartUtcIso(monthKey) {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1, -8, 0, 0)).toISOString()
}

/** 「CST 自然日 00:00」的 UTC ISO（`dayKey` = 'YYYY-MM-DD'）。 */
function cstDayStartUtcIso(dayKey) {
  return new Date(`${dayKey}T00:00:00+08:00`).toISOString()
}

/** CST 自然日整日偏移（anchor 取 CST 当日 00:00，无夏令时，按整日加减）。 */
function shiftCstDayKey(dayKey, delta) {
  return toCstDate(new Date(Date.parse(`${dayKey}T00:00:00Z`) + delta * 86400000).toISOString())
}

/** CST 自然月偏移。 */
function shiftCstMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** CST 时间戳片段 `yyyyMMddHHmm`（导出文件名用；§7.6 / §7.5 展示一律 CST）。 */
function cstStamp(iso) {
  return toCstDateTime(iso).replace(/[^0-9]/g, '').slice(0, 12)
}

// ---------------------------------------------------------------------------
// R17 图片双通道（spec §7.7；适配层 A27 / A30 / A31）
// ---------------------------------------------------------------------------

/** 稳定字符串散列（FNV-1a）——切向 / 切位由 assetId 派生，同一会话同一条目稳定（§8.1）。 */
function hashSeed(text) {
  const str = String(text)
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 时区换算常量：一小时的秒数（非价格 / 非包量字面量，§4.3 静态检查口径）。 */
const SECONDS_PER_HOUR = 60 * 60

/**
 * 切向掷币判据与切位取样区间（**R-102 退役**）：块数与切位改由 **真源快照夹具** 提供
 * （见 `SLICE_GEOMETRY_FIXTURE`）—— yinsuo 侧**不再派生任何切向 / 切位**（R-101）。
 */

/** 当前 CST 自然日（spec §7.5）。 */
function currentCstDate() {
  return toCstDate(nowIso())
}

/** 下一个 CST 零点（UTC ISO8601；§3.9 `originalDownloadQuota.resetAt` 口径）。 */
function nextCstMidnightIso() {
  const [y, m, d] = currentCstDate().split('-').map(Number)
  // CST 当日 00:00 = UTC 前一日 16:00
  const utcStart = Date.UTC(y, m - 1, d) - 8 * SECONDS_PER_HOUR * 1000
  return new Date(utcStart + 24 * SECONDS_PER_HOUR * 1000).toISOString()
}

/**
 * 切片**内容缓存** TTL ＝ **当日剩余秒数**（至 Asia/Shanghai 次日 `00:00:00`；v1.7 §3.9
 * `displaySliceGroup.sliceContentTtlSeconds`）——自然日粒度，**不做固定秒数循环**。
 * 与 `sigTtlSeconds`（签名 TTL，配置项，默认 300 秒）是**两个独立计时**（§7.7-10 / AC-79）。
 */
function secondsUntilCstMidnight() {
  return Math.max(0, Math.floor((new Date(nextCstMidnightIso()).getTime() - Date.now()) / 1000))
}

/**
 * 切片**签名**签发序号——每签发一次 A27 递增。
 * 这是「签名流与内容流解耦」的关键：签名种子含本序号与签发时刻，因此**重复获取必得新签名**，
 * 而切片内容（切向 / 切位 / 两片字节）仍只由 `assetId` + 当日 CST 日期派生、不随签名变化
 * （§7.7-10「签名 URL 刷新只换签、不换图」，AC-79）。
 */
let sliceSigIssueCount = 0

/**
 * 签发一片切片的**独立**签名（R17a：两片不得共用签名）。
 * 种子 ＝ `assetId` + 片序 + 签发序号 + 签发时刻（毫秒）→ 与内容流（`assetId@CST当日`）**完全不同源**。
 */
function issueSliceSig(assetId, sliceIndex) {
  sliceSigIssueCount += 1
  const rnd = mulberry32(hashSeed(`${assetId}#${sliceIndex}#sig@${sliceSigIssueCount}@${Date.now()}`))
  const suffix = Math.floor(rnd() * 0xffffffff).toString(36) + Math.floor(rnd() * 0xffffffff).toString(36)
  return `sig=${hashSeed(`${assetId}#${sliceIndex}`).toString(36)}${suffix}`
}

/**
 * **块数与几何的「真源快照」夹具（离线）** —— R-102：块数以 xiai TileSplicer 真源为准
 * （印面 FACE ＝ 2 刀 / **4 块** / 2×2；实拍 PHOTO ＝ 3 刀 / **8 块** / 4×2）。
 *
 * 来源（逐字登记，**不是** yinsuo 重算的几何）—— xiai 侧 TileSplicer API 于 **2026-09-21** 的实测响应：
 *   · `GET http://127.0.0.1:5163/api/tilesplicer/v1/plan?assetId=ys-sample-face&kind=FACE&width=1200&height=1200`
 *   · `GET http://127.0.0.1:5163/api/tilesplicer/v1/plan?assetId=ys-sample-photo&kind=PHOTO&width=1600&height=1200`
 *   取证原文：`xiai/qa-recheck/kong-u1-20260921/raw-face.json` / `raw-photo.json`（两响应 `seam` 三项皆 true）。
 *
 * 纪律：
 *   · 本夹具是**真源响应的记录快照**（数据），**不是**在 yinsuo 另写切割 / 拼接 / 几何算法 ——
 *     几何（`tiles[].rect` / 刀向 / 刀数 / 列行数）**逐字复制**，yinsuo 侧不做任何切位计算（R-101 / R-103）。
 *   · mock 模式**不联网**（§8.1），故以快照充当离线数据源；其源尺寸即夹具尺寸
 *     （印面 1200×1200 / 实拍 1600×1200），与 api 模式显式传给真源的尺寸一致。
 *   · 升级夹具的方式＝重新记录真源响应，**不得**手工改 rect。
 */
const SLICE_GEOMETRY_FIXTURE = Object.freeze({
  /** 印面（`ASSET_KIND.FACE`）：2 刀 / 4 块 / 2×2。 */
  FACE: Object.freeze({
    geometrySource: 'xiai-tilesplicer/v1@2026-09-21:ys-sample-face(width=1200,height=1200)',
    kind: 'FACE',
    source: Object.freeze({ width: 1200, height: 1200 }),
    cuts: 2,
    directions: Object.freeze(['vertical', 'horizontal']),
    ratios: Object.freeze([0.5307, 0.5672]),
    cols: 2,
    rows: 2,
    seam: Object.freeze({ ok: true, areaEqualsSource: true, noOverlap: true, edgesAdjacent: true }),
    tiles: Object.freeze([
      Object.freeze({ index: 0, row: 0, col: 0, rect: Object.freeze({ x: 0, y: 0, w: 637, h: 681 }) }),
      Object.freeze({ index: 1, row: 0, col: 1, rect: Object.freeze({ x: 637, y: 0, w: 563, h: 681 }) }),
      Object.freeze({ index: 2, row: 1, col: 0, rect: Object.freeze({ x: 0, y: 681, w: 637, h: 519 }) }),
      Object.freeze({ index: 3, row: 1, col: 1, rect: Object.freeze({ x: 637, y: 681, w: 563, h: 519 }) }),
    ]),
  }),
  /** 实拍（边款 / 钤本）：3 刀 / 8 块 / 4×2。 */
  PHOTO: Object.freeze({
    geometrySource: 'xiai-tilesplicer/v1@2026-09-21:ys-sample-photo(width=1600,height=1200)',
    kind: 'PHOTO',
    source: Object.freeze({ width: 1600, height: 1200 }),
    cuts: 3,
    directions: Object.freeze(['vertical', 'horizontal', 'vertical']),
    ratios: Object.freeze([0.4003, 0.3738, 0.4721]),
    cols: 4,
    rows: 2,
    seam: Object.freeze({ ok: true, areaEqualsSource: true, noOverlap: true, edgesAdjacent: true }),
    tiles: Object.freeze([
      Object.freeze({ index: 0, row: 0, col: 0, rect: Object.freeze({ x: 0, y: 0, w: 302, h: 449 }) }),
      Object.freeze({ index: 1, row: 0, col: 1, rect: Object.freeze({ x: 302, y: 0, w: 338, h: 449 }) }),
      Object.freeze({ index: 2, row: 0, col: 2, rect: Object.freeze({ x: 640, y: 0, w: 453, h: 449 }) }),
      Object.freeze({ index: 3, row: 0, col: 3, rect: Object.freeze({ x: 1093, y: 0, w: 507, h: 449 }) }),
      Object.freeze({ index: 4, row: 1, col: 0, rect: Object.freeze({ x: 0, y: 449, w: 302, h: 751 }) }),
      Object.freeze({ index: 5, row: 1, col: 1, rect: Object.freeze({ x: 302, y: 449, w: 338, h: 751 }) }),
      Object.freeze({ index: 6, row: 1, col: 2, rect: Object.freeze({ x: 640, y: 449, w: 453, h: 751 }) }),
      Object.freeze({ index: 7, row: 1, col: 3, rect: Object.freeze({ x: 1093, y: 449, w: 507, h: 751 }) }),
    ]),
  }),
})

/**
 * 按 assetId 取真源快照夹具：先用种子表查出该影像的 yinsuo 类别
 * （`ASSET_KIND.FACE` 印面 ⇒ FACE 族 4 块；`EDGE` 边款 / `IMPRESSION` 钤本 ⇒ PHOTO 族 8 块，
 * 与 api 模式 `XIAI_KIND_BY_ASSET_KIND` 的映射逐字一致）。
 */
function sliceGeometryOf(assetId) {
  const asset = findSeedAsset(assetId)
  const assetKind = asset && asset.kind ? asset.kind : C.ASSET_KIND.FACE
  const family = assetKind === C.ASSET_KIND.FACE ? 'FACE' : 'PHOTO'
  return { assetKind, family, plan: SLICE_GEOMETRY_FIXTURE[family] }
}

/** 额度计数器（内存；CST 自然日 00:00 重置，§3.9）。
 * `usedToday` = 今日已下载原图张数（**免费额度优先抵扣**，超出部分计费）。
 * 页面**不得自行累加计数、不得自行相乘算金额**（§8.3-3）。 */
/** AC-80：展示通道（A25/A26 等）**不得**返回原图直链；原图地址只在下载通道（A31）校验通过后单独签发。 */
function stripOriginalLinks(seal) {
  if (seal && Array.isArray(seal.assets)) {
    seal.assets = seal.assets.map((asset) => {
      const { originalHighResUrl, ...rest } = asset
      return rest
    })
  }
  return seal
}

function quotaCounter() {
  const today = currentCstDate()
  if (!state.originalQuota || state.originalQuota.cstDate !== today) {
    state.originalQuota = { cstDate: today, usedToday: 0 }
    persist()
  }
  return state.originalQuota
}

/** 当前充值余额（分）——由流水重算（§5.4 Σ流水 = 余额）。 */
function currentBalanceCents() {
  const entries = ledgerWithRunningBalance()
  return entries.length ? entries[entries.length - 1].balanceAfterCents : 0
}

/**
 * 对外额度快照（spec §3.9 `originalDownloadQuota` / §8.2 A30，v1.5 字段名）：
 * `overageToday` 与 `chargedTodayCents` 为派生值（免费额度优先抵扣；超出部分按张计费）。
 */
function quotaSnapshot() {
  const policy = getOriginalQuotaPolicy()
  const counter = quotaCounter()
  const usedToday = counter.usedToday
  const overageToday = Math.max(0, usedToday - policy.freePerDay)
  return {
    policy: policy.policy,
    scopeKey: policy.scopeKey,
    freePerDay: policy.freePerDay,
    unitPriceCents: policy.unitPriceCents,
    usedToday,
    freeRemainingToday: Math.max(0, policy.freePerDay - usedToday),
    overageToday,
    /** 今日超出部分扣余额合计（分）——仅作展示/对账，**不构成每日金额上限**。 */
    chargedTodayCents: overageToday * policy.unitPriceCents,
    resetAt: nextCstMidnightIso(),
    cstDate: counter.cstDate,
    timezone: policy.timezone,
  }
}

/**
 * 展示通道图片流量账（R17c / §7.2 / AC-80①）：
 * 切片的**两片字节均计入图片流量**，但**不计调用次数**（不产生 UsageRecord 明细行）。
 * 因此这里单独记账，只在用量**聚合**（A10 汇总 / A11 分组 / A12 趋势）的 `imageBytes`（与 `imageCount`）
 * 上累加，**不**进 `calls` / `billableCalls`，也**不**进 A13 明细与 A14 导出明细行。
 */
const DISPLAY_TRAFFIC_ENDPOINT = '/v1/assets/{assetId}/display'

/**
 * 导出汇总口径注记（§7.6「汇总双口径注记行」冻结文字，v1.11）。
 *
 * 该文字**同时**是：① A14 CSV 汇总区第 3 行的注记内容；② A14 返回体 `summary.note`；
 * ③ 用量页口径说明抽屉（06-7）引用文字——三者**必须同一文字**，否则导出件与页面无法逐项勾稽（AC-49）。
 */
const SUMMARY_CALIBER_NOTE =
  '图片流量分两口径：明细行合计不含展示通道（切片）流量；展示通道流量只计图片流量、不计调用次数。两口径之和等于汇总图片流量。'

function recordDisplayTraffic(assetId, imageBytes, imageCount) {
  const at = nowIso()
  state.displayTraffic.push({
    at,
    cstDate: toCstDate(at),
    cstMonth: toCstMonth(at),
    endpoint: DISPLAY_TRAFFIC_ENDPOINT,
    assetId,
    imageBytes,
    imageCount,
  })
  persist()
}

/**
 * 取筛选区间内的展示切片流量 = **历史种子账**（固定种子，跨多自然日）＋ **本次会话运行时账**。
 *
 * 种子账的存在使「今日 / 近 7 日 / 近 30 日」等窗口得到**不同**且均 > 0 的数值（真实系统的累计形态）；
 * 运行时账由 A27 取切片时实时累加（§7.7-R17c）。
 *
 * 展示切片请求**没有明细行、也没有 kid 归属**（§7.2 三维聚合中的「按密钥」维度无来源）：
 * 因此仅在**未按密钥 / 环境筛选**时计入；接口筛选命中展示通道接口时同样计入。
 */
function displayTrafficIn(filter) {
  const f = normalizeFilter(filter)
  if (f.keys.length || f.env) return []
  if (f.endpoints.length && !f.endpoints.includes(DISPLAY_TRAFFIC_ENDPOINT)) return []
  return [...seededDisplayTraffic(), ...(state.displayTraffic || [])]
    .filter((t) => t.at >= f.from && t.at <= f.to)
    .sort((a, b) => (a.at < b.at ? -1 : 1))
}

/** 展示通道历史种子账（模块级缓存一次：同一会话内多次渲染结果一致，§8.1）。 */
let displayTrafficSeed = null
function seededDisplayTraffic() {
  if (!displayTrafficSeed) {
    const assetIds = []
    for (const seal of seedSeals()) for (const a of seal.assets) assetIds.push(a.assetId)
    displayTrafficSeed = seedDisplayTraffic({ assetIds })
  }
  return displayTrafficSeed
}

/** 资源存在性（AC-85）：在种子影像库中按 `assetId` 定位资源；不存在返回 `null`。 */
function findSeedAsset(assetId) {
  for (const seal of seedSeals()) {
    const hit = seal.assets.find((a) => a.assetId === assetId)
    if (hit) return hit
  }
  return null
}

// ---------------------------------------------------------------------------
// 状态与持久化（仅内存 + sessionStorage，§8.1）
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    users: [], apiKeys: [], orders: [], ledger: [], applications: [], audit: [], session: null,
    /** 每日原图下载额度计数器（§3.10 / §7.7-R17b）：{cstDate, usedToday}，CST 自然日重置。 */
    originalQuota: null,
    /** 展示切片流量账（R17c / AC-80①）：只计图片流量、不计调用次数的独立累计。 */
    displayTraffic: [],
  }
}

function loadState() {
  try {
    const raw = globalThis.sessionStorage?.getItem(PERSIST_KEY)
    if (raw) return { ...emptyState(), ...JSON.parse(raw) }
  } catch {
    /* 存储不可用时退化为纯内存 */
  }
  return emptyState()
}

const state = loadState()

function persist() {
  try {
    globalThis.sessionStorage?.setItem(PERSIST_KEY, JSON.stringify(state))
  } catch {
    /* 配额或隐私模式下静默退化 */
  }
}

// ---------------------------------------------------------------------------
// 种子与派生数据
// ---------------------------------------------------------------------------

function seedAllIfNeeded() {
  if (state.users.length) return
  state.users.push({
    ...DEMO_USER,
    annualFeePaidUntil: SEED_ANNUAL_FEE_PAID_UNTIL,
    createdAt: '2026-08-01T02:00:00Z',
    lastLoginAt: '2026-09-18T03:00:00Z',
    featureFlags: { registerOpen: APP_CONFIG.featureFlags.registerOpen },
  })
  state.apiKeys = seedApiKeys().map((key) => ({ ...key, userId: DEMO_USER_ID }))

  // 两笔种子订单：一笔已入账（余额来源），一笔超时关闭（对账示例）
  state.orders.push({
    orderId: 'RO20260901000001',
    userId: DEMO_USER_ID,
    amountCents: SEED_INITIAL_RECHARGE_CENTS,
    channel: C.PAY_CHANNEL.WECHAT,
    status: C.ORDER_STATUS.SETTLED,
    qrPayload: 'DEMO-QR:RO20260901000001',
    createdAt: '2026-09-01T01:00:00Z',
    expiresAt: '2026-09-01T01:15:00Z',
    paidAt: '2026-09-01T01:02:00Z',
    settledAt: '2026-09-01T01:02:01Z',
    ledgerEntryId: 'le_0001',
    idempotencyKey: 'idem_seed_0001',
    planId: undefined,
  })
  state.orders.push({
    orderId: 'RO20260910000002',
    userId: DEMO_USER_ID,
    // 充值金额取自单一配置源（§4.3），不写字面量；此处 = 界面第 2 档演示档位
    amountCents: PRICING.recharge.presetsCents[1],
    channel: C.PAY_CHANNEL.ALIPAY,
    status: C.ORDER_STATUS.EXPIRED,
    qrPayload: 'DEMO-QR:RO20260910000002',
    createdAt: '2026-09-10T07:20:00Z',
    expiresAt: '2026-09-10T07:35:00Z',
    failReason: '待支付超时',
    idempotencyKey: 'idem_seed_0002',
  })
  persist()
}
seedAllIfNeeded()

/** 演示用户的用量记录（固定种子，只生成一次）。 */
let usageCache = null
function usageRecords() {
  if (!usageCache) {
    const demoKeys = state.apiKeys.filter((k) => k.userId === DEMO_USER_ID)
    const kidSource = demoKeys.length
      ? demoKeys
      : [{ kid: 'key_DEMOTEST0000', env: C.ENV.TEST }, { kid: 'key_DEMOLIVE0000', env: C.ENV.LIVE }]
    usageCache = seedUsageRecords({ userId: DEMO_USER_ID, kids: kidSource, planId: DEMO_USER.planId })
  }
  return usageCache
}

function currentMonthKey() {
  return toCstMonth(nowIso())
}

/** 账单流水：种子充值 + 年费 + 当月用量回放（保证 Σ流水 = 余额，§5.4-3）。 */
let ledgerCache = null
function seedLedger() {
  if (ledgerCache) return ledgerCache
  const plan = getPlanById(DEMO_USER.planId)
  const monthKey = currentMonthKey()
  const entries = []
  let seq = 0
  let balance = 0

  const push = (partial) => {
    seq += 1
    const entry = {
      entryId: `le_${String(seq).padStart(4, '0')}`,
      userId: DEMO_USER_ID,
      amountCents: 0,
      callCount: 0,
      originalImageCount: 0,
      operatorType: C.OPERATOR_TYPE.SYSTEM,
      ...partial,
    }
    if (entry.direction === C.LEDGER_DIRECTION.IN) balance += entry.amountCents
    else balance -= entry.amountCents
    entry.balanceAfterCents = balance
    entries.push(entry)
    return entry
  }

  push({
    type: C.LEDGER_TYPE.RECHARGE,
    direction: C.LEDGER_DIRECTION.IN,
    amountCents: SEED_INITIAL_RECHARGE_CENTS,
    relatedOrderId: 'RO20260901000001',
    occurredAt: '2026-09-01T01:02:01Z',
    cstDate: toCstDate('2026-09-01T01:02:01Z'),
    cstMonth: toCstMonth('2026-09-01T01:02:01Z'),
    quotaUsedAfter: 0,
    remark: '在线充值（演示）',
    operatorType: C.OPERATOR_TYPE.USER,
  })
  push({
    type: C.LEDGER_TYPE.ANNUAL_FEE,
    direction: C.LEDGER_DIRECTION.OUT,
    amountCents: plan.annualFeeCents,
    occurredAt: '2026-09-01T01:03:00Z',
    cstDate: toCstDate('2026-09-01T01:03:00Z'),
    cstMonth: toCstMonth('2026-09-01T01:03:00Z'),
    quotaUsedAfter: 0,
    remark: `${plan.name}年费 · 授权与运维服务费`,
  })

  const monthRecords = usageRecords()
    .filter((r) => r.cstMonth === monthKey)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))

  const planQuota = plan.monthlyQuotaCalls
  let quotaUsed = 0
  for (const r of monthRecords) {
    if (r.isBillable && r.callCount > 0) {
      quotaUsed += r.callCount
      if (quotaUsed <= planQuota) {
        push({
          type: C.LEDGER_TYPE.DEDUCT_QUOTA,
          direction: C.LEDGER_DIRECTION.OUT,
          amountCents: 0,
          callCount: r.callCount,
          relatedKid: r.kid,
          occurredAt: r.requestedAt,
          cstDate: r.cstDate,
          cstMonth: monthKey,
          quotaUsedAfter: quotaUsed,
          remark: '计费调用消耗包量',
        })
      } else {
        push({
          type: C.LEDGER_TYPE.DEDUCT_BALANCE,
          direction: C.LEDGER_DIRECTION.OUT,
          amountCents: plan.overageUnitPriceCents * r.callCount,
          callCount: r.callCount,
          relatedKid: r.kid,
          occurredAt: r.requestedAt,
          cstDate: r.cstDate,
          cstMonth: monthKey,
          quotaUsedAfter: quotaUsed,
          remark: '包量耗尽后超量扣余额',
        })
      }
    }
    if (r.originalImageCount > 0) {
      push({
        type: C.LEDGER_TYPE.ORIGINAL_IMAGE,
        direction: C.LEDGER_DIRECTION.OUT,
        amountCents: PRICING.originalImage.unitPriceCents * r.originalImageCount,
        originalImageCount: r.originalImageCount,
        relatedKid: r.kid,
        occurredAt: r.requestedAt,
        cstDate: r.cstDate,
        cstMonth: monthKey,
        quotaUsedAfter: quotaUsed,
        remark: '高清原图按张扣余额',
      })
    }
  }
  for (const h of seedHistoricalLedger(monthKey)) push(h)

  ledgerCache = entries
  return entries
}

/**
 * 历史流水种子（**D1 修复配套**；§8.1 固定种子纪律）。
 *
 * 为什么需要：本卷其余流水**全部落在当期 CST 自然月内**（本演示约 19 天），若不补跨月 / 跨 30 日的
 * 历史条目，则「近 30 日」「本月」「全部」三档必然返回**同一集合**，时间范围筛选无从演示——
 * 与「展示通道流量须分布在筛选窗口内」（§8.1 v1.18 注）同一处理思路。
 *
 * 口径：
 *  ① **金额为 0**（包量扣减）⇒ Σ流水 = 余额、余额数值、各 KPI 数字**完全不变**；
 *  ② 一条落在「上月最后一分钟」（在近 30 日窗口内、本月窗口外），一条落在 60 天前（在全部窗口内、
 *     近 30 日窗口外）——两者按 `now` **相对**生成，不写死日期；
 *  ③ `entryId` 显式取 `le_9001` / `le_9002`，**不占用** `le_0001…` 序号，故种子订单的幂等锚点
 *     `le_0001` 指向的入账流水不受影响；`cstMonth` 为往月时不计入当月包量已用（§7.4）。
 */
function seedHistoricalLedger(monthKey) {
  const nowMs = Date.now()
  return [
    { entryId: 'le_9001', occurredAt: new Date(Date.parse(monthStartUtcIso(monthKey)) - 60000).toISOString(), callCount: 6 },
    { entryId: 'le_9002', occurredAt: new Date(nowMs - 60 * 86400000).toISOString(), callCount: 8 },
  ].map((h) => ({
    entryId: h.entryId,
    userId: DEMO_USER_ID,
    type: C.LEDGER_TYPE.DEDUCT_QUOTA,
    direction: C.LEDGER_DIRECTION.OUT,
    amountCents: 0,
    callCount: h.callCount,
    originalImageCount: 0,
    quotaUsedAfter: 0,
    occurredAt: h.occurredAt,
    cstDate: toCstDate(h.occurredAt),
    cstMonth: toCstMonth(h.occurredAt),
    remark: '计费调用消耗包量',
    operatorType: C.OPERATOR_TYPE.SYSTEM,
  }))
}

/** 全量流水 = 种子卷 + 用户侧新增卷，按时间升序。 */
function mergedLedger() {
  const userLedger = state.ledger
  return [...seedLedger(), ...userLedger].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
}

/** 余额快照按时间序重算一次，保证拼接后仍满足 Σ流水 = 余额（§5.4）。 */
function ledgerWithRunningBalance() {
  const monthKey = currentMonthKey()
  let balance = 0
  let quotaUsed = 0
  return mergedLedger().map((e) => {
    if (e.direction === C.LEDGER_DIRECTION.IN) balance += e.amountCents
    else balance -= e.amountCents
    if (e.callCount > 0 && e.cstMonth === monthKey) quotaUsed += e.callCount
    return { ...e, balanceAfterCents: balance, quotaUsedAfter: e.callCount > 0 ? quotaUsed : e.quotaUsedAfter }
  })
}

/** 对外只读形态：剥离内部字段（§6.2：明文不可再取回）。 */
function publicKey(key) {
  const { _issuedPlaintext, ...rest } = key
  void _issuedPlaintext
  return clone(rest)
}

function keysForViewer() {
  const viewerId = state.session?.userId || DEMO_USER_ID
  const lastUsed = new Map()
  for (const r of usageRecords()) {
    const prev = lastUsed.get(r.kid)
    if (!prev || prev < r.requestedAt) lastUsed.set(r.kid, r.requestedAt)
  }
  return state.apiKeys
    .filter((k) => k.userId === viewerId)
    .map((k) => {
      const key = publicKey(k)
      key.lastUsedAt = viewerId === DEMO_USER_ID ? lastUsed.get(k.kid) || undefined : undefined
      return key
    })
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function publicUser(user) {
  const { passwordHash, ...rest } = user
  void passwordHash
  return clone(rest)
}

function sessionUser() {
  if (!state.session?.userId) return null
  const user = state.users.find((u) => u.userId === state.session.userId)
  return user ? publicUser(user) : null
}

// ---------------------------------------------------------------------------
// 筛选与聚合（用量口径 §7）
// ---------------------------------------------------------------------------

function toArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return String(value).split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * 时间窗口 → `{from,to}`（**唯一真源**；一律 CST 自然日 / 自然月对齐，§7.5）。
 *
 * 窗口词表（与用量页 `UsagePage.vue` 既有档位口径**逐档一致**）：
 *  - `today`  今日 00:00 CST 起（窗口内不得出现往日的流水）；
 *  - `7d`     含今日在内近 7 个 CST 自然日 00:00 起；
 *  - `30d`    含今日在内近 30 个 CST 自然日 00:00 起（**未指定 range 时的默认档**）；
 *  - `month`  本月 1 日 00:00 CST 起；
 *  - `12m`    含当月在内近 12 个 CST 自然月 1 日 00:00 起（月粒度，§7.4 / AC-50）；
 *  - `all`    全部（epoch 起）。
 *
 * **D1 修复**：该换算只此一处，用量系（A10–A14）与流水（A24）**共用**；
 * 此前只有用量系方法消费 `range`，A24 只读 `from`/`to`，导致流水页时间范围筛选失效。
 */
function rangeWindow(range, now = new Date()) {
  const todayKey = toCstDate(now.toISOString())
  const monthKey = toCstMonth(now.toISOString())
  const to = now.toISOString()
  switch (range) {
    case 'all':
      return { from: new Date(0).toISOString(), to }
    case 'today':
      return { from: cstDayStartUtcIso(todayKey), to }
    case '7d':
      return { from: cstDayStartUtcIso(shiftCstDayKey(todayKey, -6)), to }
    case 'month':
      return { from: cstDayStartUtcIso(`${monthKey}-01`), to }
    case '12m':
      return { from: cstDayStartUtcIso(`${shiftCstMonthKey(monthKey, -11)}-01`), to }
    case '30d':
    default:
      return { from: cstDayStartUtcIso(shiftCstDayKey(todayKey, -29)), to }
  }
}

function normalizeFilter(filter = {}) {
  let from
  let to
  if (filter.from || filter.to) {
    from = filter.from ? new Date(filter.from).toISOString() : new Date(0).toISOString()
    to = filter.to ? new Date(filter.to).toISOString() : new Date().toISOString()
  } else {
    const win = rangeWindow(filter.range)
    from = win.from
    to = win.to
  }
  return {
    from,
    to,
    range: filter.range || '30d',
    keys: toArray(filter.keys),
    endpoints: toArray(filter.endpoints),
    env: filter.env && filter.env !== 'all' ? filter.env : null,
  }
}

function matches(record, f) {
  if (record.requestedAt < f.from || record.requestedAt > f.to) return false
  if (f.keys.length && !f.keys.includes(record.kid)) return false
  if (f.endpoints.length && !f.endpoints.includes(record.endpoint)) return false
  if (f.env && record.env !== f.env) return false
  return true
}

function filteredRecords(filter) {
  const f = normalizeFilter(filter)
  return usageRecords().filter((r) => matches(r, f))
}

function summarize(records) {
  const acc = {
    calls: 0, billableCalls: 0, failedCalls: 0, originalImages: 0,
    imageCount: 0, imageBytes: 0, latencySum: 0,
  }
  for (const r of records) {
    acc.calls += 1
    if (r.isBillable) acc.billableCalls += r.callCount
    if (r.statusCode >= 400) acc.failedCalls += 1
    acc.originalImages += r.originalImageCount
    acc.imageCount += r.imageCount
    acc.imageBytes += r.imageBytes
    acc.latencySum += r.latencyMs
  }
  acc.avgLatencyMs = records.length ? Math.round(acc.latencySum / records.length) : 0
  delete acc.latencySum
  return acc
}

const DIM_KEY = {
  [C.USAGE_DIM.KEY]: (r) => r.kid,
  [C.USAGE_DIM.ENDPOINT]: (r) => r.endpoint,
  [C.USAGE_DIM.DAY]: (r) => r.cstDate,
}

function breakdown(records, dim, keyLabels) {
  const keyOf = DIM_KEY[dim] || DIM_KEY[C.USAGE_DIM.DAY]
  const groups = new Map()
  for (const r of records) {
    const k = keyOf(r)
    if (!groups.has(k)) {
      groups.set(k, { dimValue: k, label: keyLabels?.[k] || k, calls: 0, billableCalls: 0, originalImages: 0, imageCount: 0, imageBytes: 0, failedCalls: 0 })
    }
    const g = groups.get(k)
    g.calls += 1
    if (r.isBillable) g.billableCalls += r.callCount
    if (r.statusCode >= 400) g.failedCalls += 1
    g.originalImages += r.originalImageCount
    g.imageCount += r.imageCount
    g.imageBytes += r.imageBytes
  }
  const total = records.length
  const rows = [...groups.values()].sort((a, b) => b.calls - a.calls)
  for (const row of rows) row.share = total ? row.calls / total : 0
  return rows
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function randomBase36(len) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(len)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 订单号：`RO` + YYYYMMDD + 6 位序列（§3.6）。 */
function nextOrderId() {
  const day = toCstDate(nowIso()).replace(/-/g, '')
  return `RO${day}${String(state.orders.length + 1).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------
// 适配层实现 A1–A29（spec §8.2）
// ---------------------------------------------------------------------------

const impl = {
  /** A1 —— 站点配置（注册开关等；R2） */
  async getAppConfig() {
    await delay()
    return clone({
      featureFlags: { ...APP_CONFIG.featureFlags },
      site: { ...APP_CONFIG.site },
      demo: { ...APP_CONFIG.demo },
      apiKeyLimit: APP_CONFIG.apiKeyLimit,
      orderPendingTimeoutMinutes: APP_CONFIG.orderPendingTimeoutMinutes,
      notConnectedNotice: APP_CONFIG.notConnectedNotice,
      dataSource: 'mock',
    })
  },

  /** A2 —— 注册（注册即自动开通，R2） */
  async register(input = {}) {
    await delay()
    if (!APP_CONFIG.featureFlags.registerOpen) {
      return fail('REGISTER_CLOSED', '注册已暂停，请走申请演示通道')
    }
    const email = String(input.email || '').trim().toLowerCase()
    if (!email) return fail('VALIDATION_ERROR', '邮箱必填')
    if (state.users.some((u) => u.email.toLowerCase() === email)) {
      return fail('EMAIL_TAKEN', '该邮箱已注册')
    }
    const userId = `u_${randomBase36(12)}`
    const user = {
      userId,
      orgName: input.orgName || '（演示）未命名机构',
      orgType: input.orgType || undefined,
      contactName: input.contactName || '（演示）联系人',
      phone: input.phone || '',
      email,
      passwordHash: `$mock$argon2id$v=19$m=65536,t=3,p=1$${userId}$mock`,
      status: C.USER_STATUS.ACTIVE,
      planId: getPlansFromConfig()[0].planId,
      annualFeePaidUntil: undefined,
      registerSource: C.REGISTER_SOURCE.SELF_SERVICE,
      createdAt: nowIso(),
      lastLoginAt: nowIso(),
      featureFlags: { registerOpen: APP_CONFIG.featureFlags.registerOpen },
    }
    state.users.push(user)
    state.session = { userId, sessionToken: `sess_${randomBase36(24)}`, createdAt: nowIso() }
    persist()
    return clone({ user: publicUser(user), sessionToken: state.session.sessionToken, opened: true })
  },

  /** A3 —— 登录（演示态：校验演示凭证或任意合法格式；§11 待决 6 默认邮箱 + 密码） */
  async login(account, password) {
    await delay()
    const identifier = String(account || '').trim().toLowerCase()
    const pwd = String(password || '')
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)
    const looksLikePhone = /^1\d{10}$/.test(identifier)
    if (!looksLikeEmail && !looksLikePhone) return fail('AUTH_FAILED', '账号格式不正确（邮箱或 11 位手机号）')
    if (pwd.length < 8) return fail('AUTH_FAILED', '密码至少 8 位')
    if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) return fail('AUTH_FAILED', '密码需同时包含字母与数字')
    if (identifier === DEMO_USER.email && pwd !== DEMO_PASSWORD) {
      return fail('AUTH_FAILED', '演示账号口令不正确')
    }
    let user = state.users.find((u) => u.email.toLowerCase() === identifier)
    if (!user) {
      user = {
        ...DEMO_USER,
        userId: `u_${randomBase36(12)}`,
        email: identifier,
        phone: looksLikePhone ? identifier : DEMO_USER.phone,
        orgName: '（演示）自助登录机构',
        annualFeePaidUntil: undefined,
        createdAt: nowIso(),
        lastLoginAt: nowIso(),
        featureFlags: { registerOpen: APP_CONFIG.featureFlags.registerOpen },
      }
      state.users.push(user)
    }
    user.lastLoginAt = nowIso()
    state.session = { userId: user.userId, sessionToken: `sess_${randomBase36(24)}`, createdAt: nowIso() }
    persist()
    return clone({ user: publicUser(user), sessionToken: state.session.sessionToken })
  },

  /** A4 —— 退出 */
  async logout() {
    await delay()
    state.session = null
    persist()
    return true
  },

  /** A4 —— 取会话 */
  async getSession() {
    await delay()
    return sessionUser()
  },

  /** A5 —— 密钥列表（无明文，§6.2） */
  async listApiKeys() {
    await delay()
    if (!sessionUser()) return fail('UNAUTHENTICATED', '未登录')
    return keysForViewer()
  },

  /** A6 —— 新建密钥（按 §6.1 真实生成；明文仅此一次） */
  async createApiKey(input = {}) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    const mine = state.apiKeys.filter((k) => k.userId === user.userId)
    if (mine.length >= APP_CONFIG.apiKeyLimit) {
      return fail('KEY_LIMIT_REACHED', `密钥数量已达上限（${APP_CONFIG.apiKeyLimit} 个）`)
    }
    const env = input.env === C.ENV.LIVE ? C.ENV.LIVE : C.ENV.TEST
    const plaintextOnce = generatePlaintextKey(env)
    const rnd = mulberry32(Math.abs(Date.now() % 2147483647))
    const key = {
      userId: user.userId,
      kid: randomKid(rnd),
      label: input.label || '未命名密钥',
      maskedKey: maskKey(plaintextOnce),
      env,
      scopes: Array.isArray(input.scopes) && input.scopes.length ? [...input.scopes] : ['seal:search'],
      status: C.API_KEY_STATUS.ACTIVE,
      ipAllowlist: [],
      createdAt: nowIso(),
      rotatedAt: undefined,
      lastUsedAt: undefined,
      _issuedPlaintext: plaintextOnce,
    }
    state.apiKeys.push(key)
    state.audit.push({ kid: key.kid, action: 'CREATE', at: nowIso() })
    persist()
    return { key: publicKey(key), plaintextOnce }
  },

  /** A7 —— 重生（kid 不变，rotatedAt 更新，旧明文立即失效，§6.3；§11 待决 11 默认 0 秒宽限） */
  async rotateApiKey(kid) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    const key = state.apiKeys.find((k) => k.kid === kid && k.userId === user.userId)
    if (!key) return fail('NOT_FOUND', '密钥不存在')
    const plaintextOnce = generatePlaintextKey(key.env)
    key.maskedKey = maskKey(plaintextOnce)
    key._issuedPlaintext = plaintextOnce
    key.rotatedAt = nowIso()
    state.audit.push({ kid: key.kid, action: 'ROTATE', at: key.rotatedAt })
    persist()
    return { key: publicKey(key), plaintextOnce }
  },

  /** A8 —— 启用 / 禁用 */
  async setApiKeyStatus(kid, status) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    const key = state.apiKeys.find((k) => k.kid === kid && k.userId === user.userId)
    if (!key) return fail('NOT_FOUND', '密钥不存在')
    key.status = status === C.API_KEY_STATUS.DISABLED ? C.API_KEY_STATUS.DISABLED : C.API_KEY_STATUS.ACTIVE
    state.audit.push({ kid, action: `STATUS:${key.status}`, at: nowIso() })
    persist()
    return publicKey(key)
  },

  /** A9 —— 删除（用量归属保留 kid 快照，§6.3） */
  async deleteApiKey(kid) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    const idx = state.apiKeys.findIndex((k) => k.kid === kid && k.userId === user.userId)
    if (idx < 0) return fail('NOT_FOUND', '密钥不存在')
    state.apiKeys.splice(idx, 1)
    state.audit.push({ kid, action: 'DELETE', at: nowIso() })
    persist()
    return undefined
  },

  /** A10 —— 用量汇总（**双口径**：明细行流量与展示通道流量分列，`imageBytes` 为两者之和） */
  async getUsageSummary(filter) {
    await delay()
    const records = filteredRecords(filter)
    const acc = summarize(records)
    /**
     * 双口径明示（Zang 终审）：`detailImageBytes` ＝ 明细行合计，`displayChannelBytes` ＝ 展示通道（切片）流量，
     * `imageBytes` ＝ 两者之和。页面与 A14 导出件因此可逐字节勾稽（AC-80①/AC-84 口径不改，仅口径分列）。
     */
    const detailImageBytes = acc.imageBytes
    let displayChannelBytes = 0
    // AC-80①（R17c）：展示切片流量只进**图片流量**，不进调用次数 / 计费调用（无明细行）。
    for (const t of displayTrafficIn(filter)) {
      acc.imageBytes += t.imageBytes
      acc.imageCount += t.imageCount
      displayChannelBytes += t.imageBytes
    }
    const account = await impl.getAccount({ silent: true })
    return {
      ...acc,
      detailImageBytes,
      displayChannelBytes,
      quotaTotalCalls: account.quotaTotalCalls,
      quotaUsedCalls: account.quotaUsedCalls,
      quotaRemainCalls: account.quotaRemainCalls,
    }
  },

  /** A11 —— 三维聚合（密钥 / 接口 / 日） */
  async getUsageBreakdown(filter, dim) {
    await delay()
    const records = filteredRecords(filter)
    const keyLabels = {}
    for (const k of state.apiKeys) keyLabels[k.kid] = k.label
    const rows = breakdown(records, dim, keyLabels)
    // AC-80①（R17c）：展示切片流量并入「按接口 / 按日」两维（**按密钥**无归属，故不计）。
    // 展示通道的调用次数为 0（切片不计调用），只累加图片流量 → 新分组行的 calls 保持 0。
    const boundDim = DIM_KEY[dim] ? dim : C.USAGE_DIM.DAY
    if (boundDim !== C.USAGE_DIM.KEY) {
      for (const t of displayTrafficIn(filter)) {
        const k = DIM_KEY[boundDim](t)
        let row = rows.find((r) => r.dimValue === k)
        if (!row) {
          row = { dimValue: k, label: keyLabels[k] || k, calls: 0, billableCalls: 0, originalImages: 0, imageCount: 0, imageBytes: 0, failedCalls: 0, share: 0 }
          rows.push(row)
        }
        row.imageBytes += t.imageBytes
        row.imageCount += t.imageCount
      }
    }
    return {
      dim: boundDim,
      rows,
      total: records.length,
    }
  },

  /** A12 —— 趋势（默认近 30 日；可切近 12 月；固定种子，§8.1） */
  async getUsageTrend(filter, bucket) {
    await delay()
    const mode = bucket === C.USAGE_BUCKET.MONTH ? 'month' : 'day'
    const groups = new Map()
    for (const r of filteredRecords(filter)) {
      const key = mode === 'month' ? r.cstMonth : r.cstDate
      if (!groups.has(key)) groups.set(key, { bucket: key, calls: 0, billableCalls: 0, imageBytes: 0, originalImages: 0 })
      const g = groups.get(key)
      g.calls += 1
      if (r.isBillable) g.billableCalls += r.callCount
      g.imageBytes += r.imageBytes
      g.originalImages += r.originalImageCount
    }
    // AC-80①（R17c）：展示切片流量按同一时间桶累加图片流量（调用次数不变）。
    for (const t of displayTrafficIn(filter)) {
      const key = mode === 'month' ? t.cstMonth : t.cstDate
      if (!groups.has(key)) groups.set(key, { bucket: key, calls: 0, billableCalls: 0, imageBytes: 0, originalImages: 0 })
      groups.get(key).imageBytes += t.imageBytes
    }
    const series = [...groups.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1))
    return { bucket: mode, series }
  },

  /** A13 —— 明细分页（默认 20/页） */
  async listUsageRecords(filter, page = {}) {
    await delay()
    const records = filteredRecords(filter).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
    const pageSize = Math.max(1, Number(page.pageSize) || 20)
    const pageNo = Math.max(1, Number(page.page) || 1)
    const start = (pageNo - 1) * pageSize
    return {
      items: clone(records.slice(start, start + pageSize)),
      total: records.length,
      page: pageNo,
      pageSize,
      totalPages: Math.max(1, Math.ceil(records.length / pageSize)),
    }
  },

  /** A14 —— 导出 CSV（UTF-8 BOM；列顺序见 §7.6；行集合严格等于当前筛选结果） */
  async exportUsage(filter) {
    await delay()
    const f = normalizeFilter(filter)
    const records = filteredRecords(filter).sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))
    const labelOf = {}
    for (const k of state.apiKeys) labelOf[k.kid] = k.label
    const header = [
      'requestedAt(CST)', 'kid', 'label', 'endpoint', 'method', 'statusCode', 'latencyMs',
      'isBillable', 'callCount', 'imageCount', 'imageBytes', 'originalImageCount', 'env', 'traceId',
    ]
    const lines = [header.join(',')]
    for (const r of records) {
      lines.push([
        toCstDateTime(r.requestedAt), r.kid, labelOf[r.kid] || '', r.endpoint, r.method, r.statusCode,
        r.latencyMs, r.isBillable ? '1' : '0', r.callCount, r.imageCount, r.imageBytes,
        r.originalImageCount, r.env, r.traceId || '',
      ].map(csvCell).join(','))
    }
    const acc = summarize(records)
    /**
     * **汇总行双口径（Zang 终审：导出件与页面必须可勾稽）**：
     * 明细行合计与展示通道流量分列两行，另附一行注记说明口径差异。
     * `imageBytes`（合计）＝ 明细行合计 ＋ 展示通道流量 ＝ A10 `getUsageSummary().imageBytes`。
     */
    const detailImageBytes = acc.imageBytes
    const displayChannelBytes = displayTrafficIn(filter).reduce((sum, t) => sum + t.imageBytes, 0)
    lines.push('')
    lines.push([
      '汇总', `区间 ${toCstDateTime(f.from)} ~ ${toCstDateTime(f.to)}`,
      `密钥 ${f.keys.length ? f.keys.join('|') : '全部'}`,
      `接口 ${f.endpoints.length ? f.endpoints.join('|') : '全部'}`,
      `环境 ${f.env || '全部'}`, `调用 ${acc.calls}`, `计费调用 ${acc.billableCalls}`,
      `原图 ${acc.originalImages} 张`, `失败 ${acc.failedCalls}`,
    ].map(csvCell).join(','))
    lines.push(['图片流量（明细行合计）', `${detailImageBytes} 字节`].map(csvCell).join(','))
    lines.push(['展示通道流量（不计调用）', `${displayChannelBytes} 字节`].map(csvCell).join(','))
    lines.push(['汇总口径注记', SUMMARY_CALIBER_NOTE].map(csvCell).join(','))
    /**
     * 文件名（§7.6）：`yinsuo-usage-<userId>-<yyyyMMddHHmm>-<区间>-<筛选摘要>.csv`。
     * 区间取实际生效窗口（CST 日期），筛选摘要＝密钥 / 接口 / 环境的命中个数或范围标记，
     * 因此导出件自带「区间与筛选摘要」，可回检导出的行集合对应的筛选条件。
     */
    const ownerId = sessionUser()?.userId || DEMO_USER_ID
    const filterToken = [
      `${f.from.slice(0, 10)}-${f.to.slice(0, 10)}`.replace(/-/g, '').replace(/(\d{8})(\d{8})/, '$1_$2'),
      f.keys.length ? `keys${f.keys.length}` : 'allkeys',
      f.endpoints.length ? `endpoints${f.endpoints.length}` : 'allendpoints',
      (f.env || 'allenv').toLowerCase(),
    ].join('_')
    const fileName = `yinsuo-usage-${ownerId}-${cstStamp(nowIso())}-${filterToken}.csv`

    return {
      fileName,
      mimeType: 'text/csv;charset=utf-8',
      content: '\ufeff' + lines.join('\r\n'),
      rowCount: records.length,
      /** 汇总字段（双口径）：供页面/导出后提示直接引用，避免消费方各自算口径。 */
      summary: {
        calls: acc.calls,
        billableCalls: acc.billableCalls,
        failedCalls: acc.failedCalls,
        originalImages: acc.originalImages,
        detailImageBytes,
        displayChannelBytes,
        imageBytes: detailImageBytes + displayChannelBytes,
        rowCount: records.length,
        /** 口径注记（§7.6 冻结文字）：与 CSV 汇总区注记行**同一文字**（AC-49）。 */
        note: SUMMARY_CALIBER_NOTE,
      },
    }
  },

  /** A15 —— 额度账户（余额权威来源是流水，§5.4-3） */
  async getAccount(options = {}) {
    if (!options.silent) await delay()
    const plan = getPlanById(DEMO_USER.planId)
    const monthKey = currentMonthKey()
    const monthRecords = usageRecords().filter((r) => r.cstMonth === monthKey)
    const quotaUsedCalls = monthRecords.reduce((sum, r) => sum + (r.isBillable ? r.callCount : 0), 0)
    const originalImageUsedThisMonth = monthRecords.reduce((sum, r) => sum + r.originalImageCount, 0)
    const entries = ledgerWithRunningBalance()
    const balanceCents = entries.length ? entries[entries.length - 1].balanceAfterCents : 0
    const quota = quotaSnapshot()
    const ledgerSumCents = entries.reduce(
      (s, e) => s + (e.direction === C.LEDGER_DIRECTION.IN ? e.amountCents : -e.amountCents), 0,
    )
    return {
      userId: DEMO_USER_ID,
      planId: plan.planId,
      monthKey,
      quotaTotalCalls: plan.monthlyQuotaCalls,
      quotaUsedCalls,
      quotaRemainCalls: Math.max(0, plan.monthlyQuotaCalls - quotaUsedCalls),
      balanceCents,
      originalImageUsedThisMonth,
      /** spec §3.10 v1.5：每日免费额度与今日下载/超出/扣费统计（与 A30 同源，页面不得自行累加，§8.3-3）。 */
      originalImageFreeDailyLimit: quota.freePerDay,
      originalImageDownloadUsedToday: quota.usedToday,
      originalImageFreeRemainingToday: quota.freeRemainingToday,
      originalImageOverageToday: quota.overageToday,
      originalImageOverageChargedTodayCents: quota.chargedTodayCents,
      annualFeePaidUntil: SEED_ANNUAL_FEE_PAID_UNTIL,
      updatedAt: nowIso(),
      /** 演示态一致性自检（§5.4-4 / AC-30 基础）：Σ流水 = 余额。 */
      consistency: { ledgerSumCents, consistent: ledgerSumCents === balanceCents },
    }
  },

  /** A16 —— 套餐（读配置，不重复定义） */
  async getPlans() {
    await delay()
    return getPlansFromConfig()
  },

  /** A17 —— 套餐对比表 */
  async getPricingTable() {
    await delay()
    return buildPricingTable()
  },

  /** A18 —— 典型场景算例（纯函数包装，页面不得自行乘加） */
  async computeScenario(input) {
    await delay()
    return computeScenarioPure(input)
  },

  /** A19 —— 下单（金额区间来自配置，§11 待决 8） */
  async createRechargeOrder(input = {}) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    const amountCents = Math.floor(Number(input.amountCents))
    const { min, max } = PRICING.recharge.customRangeCents
    if (!Number.isFinite(amountCents) || amountCents < min || amountCents > max) {
      return fail('AMOUNT_OUT_OF_RANGE', `充值金额需在 ${formatCents(min)} ~ ${formatCents(max)} 之间`)
    }
    const channel = input.channel === C.PAY_CHANNEL.ALIPAY ? C.PAY_CHANNEL.ALIPAY : C.PAY_CHANNEL.WECHAT
    const order = {
      orderId: nextOrderId(),
      userId: user.userId,
      amountCents,
      channel,
      status: C.ORDER_STATUS.CREATED,
      qrPayload: undefined,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + APP_CONFIG.orderPendingTimeoutMinutes * 60000).toISOString(),
      idempotencyKey: `idem_${randomBase36(20)}`,
      planId: undefined,
    }
    state.orders.push(order)
    persist()
    return clone(order)
  },

  async getRechargeOrder(orderId) {
    await delay()
    const order = state.orders.find((o) => o.orderId === orderId)
    if (!order) return fail('NOT_FOUND', '订单不存在')
    return clone(order)
  },

  /** A21 —— 充值订单（分页信封，§8.2 契约形状②；时间倒序） */
  async listRechargeOrders(filter = {}, page = {}) {
    await delay()
    const user = sessionUser()
    if (!user) return fail('UNAUTHENTICATED', '未登录')
    let list = state.orders.filter((o) => o.userId === user.userId)
    if (filter.status) list = list.filter((o) => o.status === filter.status)
    list = list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return paginate(list, page)
  },

  /**
   * A22 —— 演示态驱动支付状态机（仅演示环境存在；§5.2 状态迁移、§5.3 规则）。
   *
   * `result` 取值：
   *  - `'success'` / `'fail'` / `'timeout'` —— **规范三值**（§8.2 A22），语义与行为一字未改；
   *  - `'pay-code'` —— **T2「生成支付码」**（`CREATED` → `PENDING_PAY`：写 `qrPayload`、
   *    `expiresAt = now + 15min`，默认分钟数取自 A1 `orderPendingTimeoutMinutes`）；
   *  - `'cancel'` —— **T7「用户点『关闭』」**（`CREATED` / `PENDING_PAY` → `CANCELLED`，零副作用）。
   *
   * 为什么需要后两个演示态触发值（**已登记为规范 ↔ 契约缺口**）：§5.2 定义了 T2 / T7 两迁移，
   * 但 §8.2 的 A22 只给出 payment *result* 三值（`success`/`fail`/`timeout`），A1–A31 中
   * **没有其它方法**可驱动 T2 / T7；`contract.js` 的枚举常量（`ORDER_STATUS` 等）本实现
   * **一字未改**，此处仅扩展本方法接受的**演示态入参**。回归口径：上述三值行为保持原样，
   * 既有冒烟断言不受影响。
   */
  async simulatePayResult(orderId, result) {
    await delay()
    const order = state.orders.find((o) => o.orderId === orderId)
    if (!order) return fail('NOT_FOUND', '订单不存在')

    // T7 —— 用户主动关闭（仅未终态可关；终态一律零副作用）
    if (result === 'cancel') {
      if (![C.ORDER_STATUS.CREATED, C.ORDER_STATUS.PENDING_PAY].includes(order.status)) {
        return fail('ORDER_TERMINAL', '订单已是终态，不可变更；请重新下单')
      }
      order.status = C.ORDER_STATUS.CANCELLED
      order.failReason = undefined
      persist()
      return clone(order)
    }

    if (C.ORDER_TERMINAL_STATUS.includes(order.status)) {
      return fail('ORDER_TERMINAL', '订单已是终态，不可变更；请重新下单')
    }

    // T2 —— 生成支付码：写入占位二维码载荷与超时时刻；对已待支付的订单幂等（不重置倒计时）
    if (result === 'pay-code') {
      if (order.status === C.ORDER_STATUS.CREATED) {
        order.expiresAt = new Date(Date.now() + APP_CONFIG.orderPendingTimeoutMinutes * 60000).toISOString()
      }
      if (Date.now() >= Date.parse(order.expiresAt)) {
        // T6 —— 超时（待支付窗口已过，不再生成支付码）
        order.status = C.ORDER_STATUS.EXPIRED
        order.failReason = '待支付超时'
        persist()
        return clone(order)
      }
      order.status = C.ORDER_STATUS.PENDING_PAY
      order.qrPayload = `DEMO-QR:${order.orderId}`
      persist()
      return clone(order)
    }

    if (result === 'fail') {
      order.status = C.ORDER_STATUS.FAILED
      order.failReason = '演示态：模拟支付失败'
      persist()
      return clone(order)
    }
    if (result === 'timeout') {
      order.status = C.ORDER_STATUS.EXPIRED
      order.failReason = '待支付超时'
      order.expiresAt = nowIso()
      persist()
      return clone(order)
    }
    if (order.status === C.ORDER_STATUS.CREATED) {
      order.status = C.ORDER_STATUS.PENDING_PAY
      order.qrPayload = `DEMO-QR:${order.orderId}`
    }
    order.status = C.ORDER_STATUS.PAID
    order.paidAt = nowIso()
    persist()
    return clone(order)
  },

  /** A23 —— 入账（幂等：同一 orderId 只产生 1 条 RECHARGE 流水，§5.4） */
  async settleRechargeOrder(orderId) {
    await delay()
    const order = state.orders.find((o) => o.orderId === orderId)
    if (!order) return fail('NOT_FOUND', '订单不存在')
    if (order.status === C.ORDER_STATUS.SETTLED) {
      const existing = state.ledger.find((e) => e.entryId === order.ledgerEntryId)
      return { order: clone(order), ledgerEntry: clone(existing), account: await impl.getAccount({ silent: true }), idempotent: true }
    }
    if (order.status !== C.ORDER_STATUS.PAID) {
      return fail('ORDER_NOT_PAID', '订单未支付，不能入账')
    }
    order.status = C.ORDER_STATUS.SETTLED
    order.settledAt = nowIso()
    const entry = {
      entryId: `le_${randomBase36(10)}`,
      userId: order.userId,
      type: C.LEDGER_TYPE.RECHARGE,
      direction: C.LEDGER_DIRECTION.IN,
      amountCents: order.amountCents,
      callCount: 0,
      originalImageCount: 0,
      balanceAfterCents: 0,
      quotaUsedAfter: 0,
      relatedOrderId: order.orderId,
      occurredAt: order.settledAt,
      cstDate: toCstDate(order.settledAt),
      cstMonth: toCstMonth(order.settledAt),
      remark: '在线充值（演示）',
      operatorType: C.OPERATOR_TYPE.USER,
    }
    order.ledgerEntryId = entry.entryId
    state.ledger.push(entry)
    persist()
    const account = await impl.getAccount({ silent: true })
    return { order: clone(order), ledgerEntry: clone(entry), account, idempotent: false }
  },

  /**
   * A24 —— 流水（分页信封，§8.2 契约形状②；时间倒序 + 类型筛选 + **时间范围**）。
   *
   * **D1 修复**：与用量系共用 `normalizeFilter` 的 `range`→`{from,to}` 换算（页面不再各自换算）。
   * 未显式给 `range` / `from` / `to` 时维持本方法原有「全部」语义（页面始终显式传 `range`）。
   */
  async listLedgerEntries(filter = {}, page = {}) {
    await delay()
    const types = toArray(filter.types)
    const f = normalizeFilter(filter.range || filter.from || filter.to ? filter : { ...filter, range: 'all' })
    let list = ledgerWithRunningBalance()
    if (types.length) list = list.filter((e) => types.includes(e.type))
    if (f.from) list = list.filter((e) => e.occurredAt >= f.from)
    if (f.to) list = list.filter((e) => e.occurredAt <= f.to)
    list = list.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    return paginate(list, page)
  },

  /** A25 —— 玺印检索（占位数据，§8.1） */
  async listSeals(filter = {}, page = {}) {
    await delay()
    const keyword = String(filter.keyword || '').trim()
    const pageSize = Math.max(1, Number(page.pageSize) || 12)
    const pageNo = Math.max(1, Number(page.page) || 1)
    let list = seedSeals()
    if (keyword) {
      list = list.filter((s) => s.sealName.includes(keyword) || (s.transcription || '').includes(keyword))
    }
    if (filter.dynasty) list = list.filter((s) => s.dynasty === filter.dynasty)
    if (filter.material) list = list.filter((s) => s.material === filter.material)
    if (filter.sealType) list = list.filter((s) => s.sealType === filter.sealType)
    const start = (pageNo - 1) * pageSize
    return {
      items: clone(list.slice(start, start + pageSize)).map(stripOriginalLinks),
      total: list.length,
      page: pageNo,
      pageSize,
      totalPages: Math.max(1, Math.ceil(list.length / pageSize)),
      isPlaceholder: true,
    }
  },

  async getSeal(sealId) {
    await delay()
    const seal = seedSeals().find((s) => s.sealId === sealId)
    if (!seal) return fail('NOT_FOUND', '玺印条目不存在')
    return stripOriginalLinks(clone(seal))
  },

  /**
   * A27 —— 展示切片组（**v1.3 重定义**：旧 `getAssetUrl(assetId, kind)` 签名作废，§8.2）。
   * **块数与几何取真源快照**（R-102：印面 4 块 / 实拍 8 块，见 `SLICE_GEOMETRY_FIXTURE`，
   * 逐字复制自 xiai TileSplicer API 实测响应）—— yinsuo 侧**不派生切向 / 切位**；
   * 每片独立短期签名 URL（`about:placeholder#…`，不产生任何真实网络请求，§8.1）；
   * **不签发原图直链**（R17b）。
   */
  async getDisplaySlices(assetId) {
    await delay()
    if (!assetId) return fail('INVALID_ARGUMENT', '缺少 assetId')
    const cfg = PRICING.displaySlices
    const ttl = cfg.signedUrlTtlSeconds
    // AC-79（v1.6/v1.7）：切片**内容**按 `assetId` + **当日（Asia/Shanghai）日期**派生确定性随机 ——
    // 当天固定（当日结果可缓存）、**次日轮换**；与签名 URL 的短命 TTL（`sigTtlSeconds`，配置项）是
    // **两个独立计时**：重复获取只刷新签名，**不得**改变当日的切片内容。
    // —— R-102 起，本函数的 `rnd`（内容流）**只用于演示字节总量**；切向 / 切位 / 块数一律取
    //    真源快照夹具，签名一律走 `issueSliceSig()`（另一路派生）：两者不得共用同一条 PRNG 流，
    //    否则同日重复获取会返回逐字节相同的 sig URL（P2b 缺陷 1 根因）。
    const contentDay = currentCstDate()
    const rnd = mulberry32(hashSeed(`${assetId}@${contentDay}`))
    const geometry = sliceGeometryOf(assetId)
    const plan = geometry.plan
    const sourceWidth = plan.source.width
    const sourceHeight = plan.source.height
    const generatedAt = nowIso()
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    const totalBytes = 240000 + Math.floor(rnd() * 260000)
    // 演示字节口径：按各块面积占比分摊当日内容总字节（Σ 逐片字节 === totalBytes；末块吃余额）。
    const sourceArea = sourceWidth * sourceHeight
    let allocatedBytes = 0
    const slices = plan.tiles.map((tile) => {
      const isLast = tile.index === plan.tiles.length - 1
      const bytes = isLast
        ? totalBytes - allocatedBytes
        : Math.floor((totalBytes * (tile.rect.w * tile.rect.h)) / sourceArea)
      allocatedBytes += bytes
      // 每片**独立签名**（同源前缀由 assetId + 片序派生，随机后缀来自**签名流**，各片不得共用）
      return {
        sliceIndex: tile.index,
        url: `about:placeholder#${assetId}/slice-${tile.index}?${issueSliceSig(assetId, tile.index)}`,
        bytes,
        sigExpiresAt: expiresAt,
        row: tile.row,
        col: tile.col,
        /** 真源几何逐字（R-101：不得在 yinsuo 重算切位）。 */
        rect: { ...tile.rect },
      }
    })
    // AC-80①（R17c）：切片的**各块字节均计入图片流量**、**不计调用次数**（块数取真源）。
    recordDisplayTraffic(assetId, totalBytes, slices.length)
    return {
      assetId,
      previewUrl: `about:placeholder#${assetId}/preview`,
      previewExpiresAt: expiresAt,
      slices,
      sliceMeta: {
        direction: plan.directions[0],
        offsetRatio: plan.ratios[0],
        sourceWidth,
        sourceHeight,
        generatedAt,
        /** 真源几何逐字保留（形状与 api 模式一致，便于 UI 单一路径渲染）。 */
        kind: plan.kind,
        cuts: plan.cuts,
        directions: plan.directions.slice(),
        ratios: plan.ratios.slice(),
        cols: plan.cols,
        rows: plan.rows,
        seam: { ...plan.seam },
        tiles: plan.tiles.map((t) => ({ index: t.index, row: t.row, col: t.col, rect: { ...t.rect } })),
        geometrySource: plan.geometrySource,
      },
      /** v1.7 新增：内容缓存 TTL ＝ 当日剩余秒数（至 CST 次日 00:00:00，自然日粒度） */
      sliceContentTtlSeconds: secondsUntilCstMidnight(),
      /** v1.7 新增：内容缓存键 ＝ `assetId:CST自然日`（同日相同、次日必变、与签名解耦） */
      sliceContentCacheKey: `${assetId}:${contentDay}`,
      /** 签名 TTL（配置项；与内容缓存 TTL 独立计时，§7.7-10） */
      sigTtlSeconds: ttl,
    }
  },

  /**
   * A30 —— 查询每日原图下载额度（v1.3 新增，§7.7-R17b）：账号维度、CST 自然日重置。
   *
   * **登录态校验（Zang 终审 2026-09-19）**：额度是**账号维度**数据（同账号多密钥共享同一额度），
   * 未登录（无会话）时**不得**返回快照，一律 reject `UNAUTHENTICATED`（与 A31 同一拒绝码口径，§8.2）。
   */
  async getOriginalQuota() {
    await delay()
    if (!sessionUser()) {
      return fail(
        C.ORIGINAL_DOWNLOAD_ERROR.UNAUTHENTICATED,
        '未登录：原图下载额度为账号维度数据，查询前需先登录（spec §8.2 A30）',
      )
    }
    return clone(quotaSnapshot())
  },

  /**
   * A31 —— 主动申请原图下载（v1.3 新增、**v1.5 改口径**，§7.7-R17b / §8.2 A31）。
   * 顺序固定：校验登录态 → **先扣每日免费额度（≤ freePerDay 张不收费）** →
   * 免费额度用尽后按 `unitPriceCents` **从充值余额扣减（不设每日上限）** →
   * **仅余额不足时拒绝**（`INSUFFICIENT_BALANCE` + 充值引导；无「额度用尽」类拒绝码）。
   * 免费额度只由「成功签发」抵扣：未登录 / 余额不足 / 缺参 / 签发失败一律不抵扣（§7.7-5）。
   */
  async requestOriginalDownload(assetId) {
    await delay()
    const user = sessionUser()
    if (!user) {
      return fail(C.ORIGINAL_DOWNLOAD_ERROR.UNAUTHENTICATED, '未登录：原图下载需先登录（spec §8.2 A31）')
    }
    if (!assetId) return fail('INVALID_ARGUMENT', '缺少 assetId')
    /**
     * **资源存在性校验（AC-85 / §7.3-7 / §7.7-5）**：资源不存在时**一律不抵扣、不扣费、不写流水**——
     * 必须在额度计数与扣费**之前**判定，否则「不存在的资源」也会 `usedToday +1` 并产生
     * 指向不存在资源的 `ORIGINAL_IMAGE` 流水。
     * 拒绝码 `NOT_FOUND` 取自契约枚举 `contract.ORIGINAL_DOWNLOAD_ERROR`（v1.9 起该枚举**三项**：
     * `UNAUTHENTICATED` / `INSUFFICIENT_BALANCE` / `NOT_FOUND`；§8.2 A31），**不写字面量**。
     */
    const asset = findSeedAsset(assetId)
    if (!asset) {
      return fail(
        C.ORIGINAL_DOWNLOAD_ERROR.NOT_FOUND,
        '资源不存在：该影像资源不在库中，本次不抵扣额度、不扣费、不产生流水',
      )
    }
    const policy = getOriginalQuotaPolicy()
    const counter = quotaCounter()
    /**
     * `charged.freeApplied` 语义（**本次占用免费额度的张数，取值 0 或 1**；规范细则由 Jing 补写）：
     * 单次请求只下载 1 张，因此本字段只表达「这一张是否吃到了免费额度」：
     *   - `1` ＋ `overageCount = 0` / `overageAmountCents = 0` —— 本次在免费额度内（不扣费）；
     *   - `0` ＋ `overageCount = 1` / `overageAmountCents = unitPriceCents` —— 本次超出免费额度（扣余额）。
     * 两字段**互补、恒有 `freeApplied + overageCount = 1`**。免费额度优先抵扣。
     */
    const freeApplied = counter.usedToday < policy.freePerDay ? 1 : 0
    const chargeCents = freeApplied ? 0 : policy.unitPriceCents
    if (chargeCents > 0 && currentBalanceCents() < chargeCents) {
      return fail(
        C.ORIGINAL_DOWNLOAD_ERROR.INSUFFICIENT_BALANCE,
        policy.insufficientBalanceMessage,
        { rechargePath: policy.rechargePath, shortfallCents: chargeCents - currentBalanceCents() },
      )
    }
    const occurredAt = nowIso()
    if (chargeCents > 0) {
      state.ledger.push({
        entryId: `le_${randomBase36(10)}`,
        userId: user.userId,
        type: C.LEDGER_TYPE.ORIGINAL_IMAGE,
        direction: C.LEDGER_DIRECTION.OUT,
        amountCents: chargeCents,
        callCount: 0,
        originalImageCount: 1,
        balanceAfterCents: 0,
        quotaUsedAfter: 0,
        relatedAssetId: assetId,
        occurredAt,
        cstDate: toCstDate(occurredAt),
        cstMonth: toCstMonth(occurredAt),
        remark: '原图下载（演示，占位签名 URL；超出免费额度按张扣余额）',
        operatorType: C.OPERATOR_TYPE.USER,
      })
    }
    counter.usedToday += 1
    persist()
    const quota = quotaSnapshot()
    return {
      assetId,
      originalUrl: `about:placeholder#${assetId}/original?sig=${hashSeed(`${assetId}#original`).toString(36)}`,
      originalUrlExpiresAt: new Date(Date.now() + PRICING.displaySlices.signedUrlTtlSeconds * 1000).toISOString(),
      /** 本次计费明细（免费额度内 freeApplied=1、overageCount=0）。 */
      charged: { freeApplied, overageCount: chargeCents > 0 ? 1 : 0, overageAmountCents: chargeCents },
      quota: {
        freePerDay: quota.freePerDay,
        usedToday: quota.usedToday,
        freeRemainingToday: quota.freeRemainingToday,
        overageToday: quota.overageToday,
        chargedTodayCents: quota.chargedTodayCents,
        resetAt: quota.resetAt,
      },
    }
  },

  /** A28 —— 申请演示 / 联系咨询（假提交，落内存；§1.5） */
  async submitDemoApplication(input = {}) {
    await delay()
    const email = String(input.email || '').trim().toLowerCase()
    const inFlight = state.applications.find((a) => a.email === email && ['SUBMITTED', 'REVIEWING'].includes(a.status))
    if (inFlight) {
      return { applicationId: inFlight.applicationId, status: inFlight.status, duplicated: true }
    }
    const applicationId = `DEMO-${toCstDate(nowIso()).replace(/-/g, '')}-${String(state.applications.length + 1).padStart(4, '0')}`
    const application = {
      applicationId,
      ...input,
      email,
      status: 'SUBMITTED',
      submittedAt: nowIso(),
      history: [{ status: 'SUBMITTED', at: nowIso() }],
      demoQuota: { ...APP_CONFIG.demoEnvQuota, note: '配置值（spec §11 待决 18）' },
    }
    state.applications.push(application)
    persist()
    return { applicationId, status: application.status, duplicated: false, application: clone(application) }
  },

  /** A29 —— 静态内容（FAQ / 资料下载） */
  async listFaq() {
    await delay()
    return clone([...FAQ_SEED])
  },

  async listDownloads() {
    await delay()
    return clone([...DOWNLOAD_SEED])
  },
}

export default impl
