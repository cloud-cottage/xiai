/**
 * 数据源适配层契约（spec §8.2 / §3）。
 *
 * 本文件只定义「枚举常量 + 方法清单 + 字段类型说明」，不含任何实现。
 * mock 实现（src/data/mock/impl.js）与真实实现（src/data/api/impl.js）必须
 * 满足同一契约；新增页面字段时**先改契约**，再改两个实现（spec §8.3-2）。
 *
 * 字段命名 lowerCamelCase；枚举值大写下划线（spec §3.1）。
 * 时间字段一律 UTC ISO8601 字符串，展示按 Asia/Shanghai 换算（spec §7.5）。
 * 金额字段一律**整数分**（spec §3.1）。
 */

export const ENV = Object.freeze({ TEST: 'TEST', LIVE: 'LIVE' })

export const USER_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED' })

/** spec §3.2 User.orgType */
export const ORG_TYPE = Object.freeze({
  MUSEUM: 'MUSEUM',
  UNIVERSITY: 'UNIVERSITY',
  RESEARCH: 'RESEARCH',
  PUBLISHER: 'PUBLISHER',
  OTHER: 'OTHER',
})

/** spec §3.2 User.registerSource（R2 / R3） */
export const REGISTER_SOURCE = Object.freeze({ SELF_SERVICE: 'SELF_SERVICE', REVIEWED: 'REVIEWED' })

/** spec §3.3 ApiKey.status */
export const API_KEY_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', DISABLED: 'DISABLED' })

/** spec §6.4 权限范围 */
export const SCOPES = Object.freeze(['seal:search', 'image:preview', 'image:original', 'usage:read'])

/** spec §3.5 Plan —— 三档（金额见 src/config/pricing.js，此处只登记标识） */
export const PLAN_ID = Object.freeze({
  STANDARD: 'plan_standard',
  PRO: 'plan_pro',
  ORG: 'plan_org',
})

/** spec §3.6 / §5.1 订单状态集合 */
export const ORDER_STATUS = Object.freeze({
  CREATED: 'CREATED',
  PENDING_PAY: 'PENDING_PAY',
  PAID: 'PAID',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
})

/** spec §5.1 终态 */
export const ORDER_TERMINAL_STATUS = Object.freeze([
  ORDER_STATUS.SETTLED,
  ORDER_STATUS.FAILED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.CANCELLED,
])

export const PAY_CHANNEL = Object.freeze({ WECHAT: 'WECHAT', ALIPAY: 'ALIPAY' })

/** spec §4.4 / §3.7 流水类型（DEDUCT_QUOTA 与 DEDUCT_BALANCE 不得合并） */
export const LEDGER_TYPE = Object.freeze({
  RECHARGE: 'RECHARGE',
  ANNUAL_FEE: 'ANNUAL_FEE',
  DEDUCT_QUOTA: 'DEDUCT_QUOTA',
  DEDUCT_BALANCE: 'DEDUCT_BALANCE',
  OVERAGE: 'OVERAGE',
  ORIGINAL_IMAGE: 'ORIGINAL_IMAGE',
  ADJUST: 'ADJUST',
  REFUND: 'REFUND',
})

/** spec §3.7 LedgerEntry.direction */
export const LEDGER_DIRECTION = Object.freeze({ IN: 'IN', OUT: 'OUT' })

/** spec §3.7 operatorType */
export const OPERATOR_TYPE = Object.freeze({ SYSTEM: 'SYSTEM', USER: 'USER', ADMIN: 'ADMIN' })

/** spec §3.8 Seal.sealType（五类） */
export const SEAL_TYPE = Object.freeze({
  NAME_SEAL: 'NAME_SEAL',
  LEISURE: 'LEISURE',
  AUSPICIOUS: 'AUSPICIOUS',
  OFFICIAL: 'OFFICIAL',
  COLLECTION: 'COLLECTION',
})

export const SEAL_TYPE_LABEL = Object.freeze({
  NAME_SEAL: '姓名印',
  LEISURE: '闲章',
  AUSPICIOUS: '吉语印',
  OFFICIAL: '官印',
  COLLECTION: '鉴藏印',
})

/** spec §3.8 Seal.sealStyle（白文 / 朱文） */
export const SEAL_STYLE = Object.freeze({ ZHU_WEN: 'ZHU_WEN', BAI_WEN: 'BAI_WEN', UNKNOWN: 'UNKNOWN' })

export const SEAL_STYLE_LABEL = Object.freeze({ ZHU_WEN: '朱文', BAI_WEN: '白文', UNKNOWN: '未定' })

/** spec §3.8 Seal.reviewStatus */
export const REVIEW_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  MACHINE_EXTRACTED: 'MACHINE_EXTRACTED',
  VERIFIED: 'VERIFIED',
})

/** spec §3.8 Seal.rightsStatus */
export const RIGHTS_STATUS = Object.freeze({
  PUBLIC: 'PUBLIC',
  LICENSED: 'LICENSED',
  RESTRICTED: 'RESTRICTED',
  UNKNOWN: 'UNKNOWN',
})

/** spec §3.9 ImageAsset.kind */
export const ASSET_KIND = Object.freeze({ FACE: 'FACE', EDGE: 'EDGE', IMPRESSION: 'IMPRESSION' })

export const ASSET_KIND_LABEL = Object.freeze({ FACE: '印面', EDGE: '边款', IMPRESSION: '钤本' })

/** spec §3.9 ImageAsset.colorMode */
export const COLOR_MODE = Object.freeze({ BINARY: 'BINARY', PALETTE: 'PALETTE', COLOR: 'COLOR' })

/** spec §8.2 A11 三维聚合维度 */
export const USAGE_DIM = Object.freeze({ KEY: 'key', ENDPOINT: 'endpoint', DAY: 'day' })

/** spec §8.2 A12 趋势粒度 */
export const USAGE_BUCKET = Object.freeze({ DAY: 'day', MONTH: 'month' })

/** spec §8.2 授权方法清单（A1–A31 编号；共 33 个方法，契约形状⑧）。页面只允许调用这些方法读写数据。 */
export const ADAPTER_METHODS = Object.freeze([
  'getAppConfig',      // A1
  'register',          // A2
  'login',             // A3
  'logout',            // A4
  'getSession',        // A4
  'listApiKeys',       // A5
  'createApiKey',      // A6
  'rotateApiKey',      // A7
  'setApiKeyStatus',   // A8
  'deleteApiKey',      // A9
  'getUsageSummary',   // A10
  'getUsageBreakdown', // A11
  'getUsageTrend',     // A12
  'listUsageRecords',  // A13
  'exportUsage',       // A14
  'getAccount',        // A15
  'getPlans',          // A16
  'getPricingTable',   // A17
  'computeScenario',   // A18
  'createRechargeOrder', // A19
  'getRechargeOrder',    // A20
  'listRechargeOrders',  // A21
  'simulatePayResult',   // A22
  'settleRechargeOrder', // A23
  'listLedgerEntries',   // A24
  'listSeals',           // A25
  'getSeal',             // A26
  'getDisplaySlices',    // A27（v1.3 重定义；旧 getAssetUrl 签名作废）
  'submitDemoApplication', // A28
  'listFaq',             // A29
  'listDownloads',       // A29
  'getOriginalQuota',    // A30（v1.3 新增，R17b）
  'requestOriginalDownload', // A31（v1.3 新增，R17b）
])

/** spec §7.7-R17b / §3.10 原图额度维度。 */
export const QUOTA_SCOPE = Object.freeze({ ACCOUNT: 'account' })

/**
 * spec §8.2 A31 拒绝码枚举（**三项**，v1.9 枚举级定义；`DAILY_LIMIT_EXCEEDED` 已退役）。
 *
 * 三项一律**不抵扣额度、不扣减余额、不写入流水**（§7.7-5 / AC-85 / AC-86）：
 *  - `UNAUTHENTICATED`     未登录 / 会话无效；
 *  - `INSUFFICIENT_BALANCE` 余额不足以支付超出每日免费额度的部分（附配置插值文案）；
 *  - `NOT_FOUND`           资源不存在（无该 assetId 的影像，或影像未通过汇入落地 / 校验）。
 */
export const ORIGINAL_DOWNLOAD_ERROR = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  NOT_FOUND: 'NOT_FOUND',
})

/** spec §7.7-R17a 切片切割方向。 */
export const SLICE_DIRECTION = Object.freeze({ HORIZONTAL: 'horizontal', VERTICAL: 'vertical' })

/**
 * @typedef {Object} UsageSummary     spec §8.2 A10（**双口径**：明细行与展示通道分列）
 * @property {number} calls
 * @property {number} billableCalls
 * @property {number} failedCalls
 * @property {number} originalImages
 * @property {number} detailImageBytes    图片流量·明细行合计
 * @property {number} displayChannelBytes 图片流量·展示通道（切片；只计流量、不计调用、无明细行）
 * @property {number} imageBytes          ＝ detailImageBytes + displayChannelBytes（页面「图片流量」汇总）
 *
 * @typedef {Object} UsageExport      spec §8.2 A14 / §7.6 导出信封（形状③）
 * @property {string} fileName
 * @property {string} mimeType
 * @property {string} content    CSV 文本（UTF-8 带 BOM；表尾含**双口径汇总行 ×2 + 口径注记行**）
 * @property {number} rowCount   **明细数据行数**（不含表头、汇总行与注记行）
 * @property {{calls:number,billableCalls:number,failedCalls:number,originalImages:number,
 *   detailImageBytes:number,displayChannelBytes:number,imageBytes:number,rowCount:number,note:string}} summary
 *   **双口径汇总字段**（Zang 终审：字段名锁定 `detailImageBytes` / `displayChannelBytes` / `imageBytes`
 *   ＋ `note`，与 A10 同口径可勾稽）：
 *   - `detailImageBytes`     图片流量·明细行合计（＝ CSV 第 1 行汇总行 / A10 同名口径）；
 *   - `displayChannelBytes`  展示通道（切片）流量·**不计调用次数**（＝ CSV 第 2 行汇总行）；
 *   - `imageBytes`           ＝ `detailImageBytes + displayChannelBytes` ＝ A10 `getUsageSummary().imageBytes`；
 *   - `note`                 口径注记文字，**与 CSV 汇总区注记行（行名 `汇总口径注记`）逐字相同**（AC-49）。
 *
 * @typedef {Object} User           spec §3.2
 * @property {string} userId
 * @property {string} orgName
 * @property {string} [orgType]
 * @property {string} contactName
 * @property {string} phone
 * @property {string} email
 * @property {string} status
 * @property {string} [planId]
 * @property {string} [annualFeePaidUntil]
 * @property {string} registerSource
 * @property {string} createdAt
 * @property {string} [lastLoginAt]
 * @property {{registerOpen:boolean}} featureFlags
 *
 * @typedef {Object} ApiKey         spec §3.3
 * @property {string} kid
 * @property {string} label
 * @property {string} maskedKey
 * @property {string} env
 * @property {string[]} scopes
 * @property {string} status
 * @property {string[]} ipAllowlist
 * @property {string} createdAt
 * @property {string} [rotatedAt]
 * @property {string} [lastUsedAt]
 * @property {string} [plaintextOnce]  仅创建 / 重生当次响应出现（§6.2）
 *
 * @typedef {Object} UsageRecord    spec §3.4
 * @property {string} recordId
 * @property {string} userId
 * @property {string} kid
 * @property {string} endpoint
 * @property {string} method
 * @property {number} statusCode
 * @property {boolean} isBillable
 * @property {number} callCount
 * @property {string} requestedAt
 * @property {string} cstDate
 * @property {string} cstMonth
 * @property {number} latencyMs
 * @property {number} imageCount
 * @property {number} imageBytes
 * @property {number} originalImageCount
 * @property {boolean} [isPreviewOnly]
 * @property {string} [traceId]
 * @property {string} planIdAtTime
 *
 * @typedef {Object} Account        spec §3.10
 * @property {string} userId
 * @property {string} planId
 * @property {string} monthKey
 * @property {number} quotaTotalCalls
 * @property {number} quotaUsedCalls
 * @property {number} quotaRemainCalls
 * @property {number} balanceCents
 * @property {number} originalImageUsedThisMonth
 * @property {string} [annualFeePaidUntil]
 * @property {string} updatedAt
 *
 * @typedef {Object} RechargeOrder  spec §3.6
 * @property {string} orderId
 * @property {string} userId
 * @property {number} amountCents
 * @property {string} channel
 * @property {string} status
 * @property {string} [qrPayload]
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {string} [paidAt]
 * @property {string} [settledAt]
 * @property {string} [failReason]
 * @property {string} [ledgerEntryId]
 * @property {string} idempotencyKey
 * @property {string} [planId]
 *
 * @typedef {Object} LedgerEntry    spec §3.7
 * @property {string} entryId
 * @property {string} userId
 * @property {string} type
 * @property {string} direction
 * @property {number} amountCents
 * @property {number} callCount
 * @property {number} originalImageCount
 * @property {number} balanceAfterCents
 * @property {number} quotaUsedAfter
 * @property {string} [relatedOrderId]
 * @property {string} [relatedKid]
 * @property {string} occurredAt
 * @property {string} cstDate
 * @property {string} cstMonth
 * @property {string} [remark]
 * @property {string} operatorType
 *
 * @typedef {Object} Seal           spec §3.8
 * @typedef {Object} ImageAsset     spec §3.9
 * @typedef {Object} Plan           spec §3.5
 *
 * @typedef {Object} DisplaySliceGroup  spec §3.9 / §7.7-R17a（A27）
 * @property {string} assetId
 * @property {string} previewUrl
 * @property {string} previewExpiresAt
 * @property {Array<{sliceIndex:number,url:string,bytes:number,sigExpiresAt:string}>} slices  恰好 2 片，各带独立签名
 * @property {{direction:string,offsetRatio:number,sourceWidth:number,sourceHeight:number,generatedAt:string}} sliceMeta
 * @property {number} sigTtlSeconds
 *
 * @typedef {Object} OriginalQuota      spec §3.9 / §8.2 A30（v1.5 更名自 originalDownloadDailyQuota）
 * @property {string} policy              恒 'freeQuotaThenOverage'
 * @property {string} scopeKey            'account'
 * @property {number} freePerDay          每日免费额度（张/账号；额度内不计费）
 * @property {number} unitPriceCents      超出部分单价（分/张，超出后扣余额、不设每日金额上限）
 * @property {number} usedToday           今日已下载原图张数（免费额度优先抵扣）
 * @property {number} freeRemainingToday  今日剩余免费额度（≥0；为 0 不阻断下载）
 * @property {number} overageToday        今日超出免费额度的张数（≥0）
 * @property {number} chargedTodayCents   今日超出部分扣余额合计（分；非每日金额上限）
 * @property {string} resetAt
 * @property {string} cstDate
 * @property {string} timezone
 *
 * @typedef {Object} OriginalDownloadResult  spec §8.2 A31（v1.5 成功返回）
 * @property {string} assetId
 * @property {string} originalUrl
 * @property {string} originalUrlExpiresAt
 * @property {{freeApplied:number,overageCount:number,overageAmountCents:number}} charged
 * @property {{freePerDay:number,usedToday:number,freeRemainingToday:number,overageToday:number,chargedTodayCents:number,resetAt:string}} quota
 */

export {}
