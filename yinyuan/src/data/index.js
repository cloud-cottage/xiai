/**
 * ============================================================================
 * 数据源适配层 —— 页面读写数据的**唯一入口**（spec §1.1 R1 / §8.2 / §8.3）
 *
 * 页面只允许 `import { ... } from '@/data'`；
 * **禁止** 页面直接 import `@/data/mock/**`（spec §8.3-3），否则换真库时会漏网。
 * 换实现只改 `src/config/env.js` 的 DATA_SOURCE（mock | api），页面零改动。
 * ============================================================================
 */

import { DATA_SOURCE } from '@/config/env.js'
import mockImpl from './mock/impl.js'
import apiImpl from './api/impl.js'

const impl = DATA_SOURCE === 'api' ? apiImpl : mockImpl

/** 当前生效的实现名（'mock' | 'api'），供页面做演示态标注。 */
export const RESOLVED_DATA_SOURCE = DATA_SOURCE

// ---- A1–A31：与 spec §8.2 方法清单一一对应（31 个编号 = 33 个方法，契约形状⑧） -----
export const getAppConfig = impl.getAppConfig          // A1
export const register = impl.register                  // A2
export const login = impl.login                        // A3
export const logout = impl.logout                      // A4
export const getSession = impl.getSession              // A4
export const listApiKeys = impl.listApiKeys            // A5
export const createApiKey = impl.createApiKey          // A6
export const rotateApiKey = impl.rotateApiKey          // A7
export const setApiKeyStatus = impl.setApiKeyStatus    // A8
export const deleteApiKey = impl.deleteApiKey          // A9
export const getUsageSummary = impl.getUsageSummary    // A10
export const getUsageBreakdown = impl.getUsageBreakdown // A11
export const getUsageTrend = impl.getUsageTrend        // A12
export const listUsageRecords = impl.listUsageRecords  // A13
export const exportUsage = impl.exportUsage            // A14
export const getAccount = impl.getAccount              // A15
export const getPlans = impl.getPlans                  // A16
export const getPricingTable = impl.getPricingTable     // A17
export const computeScenario = impl.computeScenario     // A18
export const createRechargeOrder = impl.createRechargeOrder // A19
export const getRechargeOrder = impl.getRechargeOrder     // A20
export const listRechargeOrders = impl.listRechargeOrders // A21
export const simulatePayResult = impl.simulatePayResult   // A22
export const settleRechargeOrder = impl.settleRechargeOrder // A23
export const listLedgerEntries = impl.listLedgerEntries   // A24
export const listSeals = impl.listSeals                   // A25
export const getSeal = impl.getSeal                       // A26
export const getDisplaySlices = impl.getDisplaySlices     // A27（v1.3 重定义）
export const submitDemoApplication = impl.submitDemoApplication // A28
export const listFaq = impl.listFaq                       // A29
export const listDownloads = impl.listDownloads           // A29
export const getOriginalQuota = impl.getOriginalQuota     // A30（v1.3 新增）
export const requestOriginalDownload = impl.requestOriginalDownload // A31（v1.3 新增）

// ---- 契约枚举（只读常量，非数据读写；供页面避免硬编码枚举字面量，§8.3-3 不涉及实现） -----
export { ENV, API_KEY_STATUS, SCOPES } from './contract.js'

// ---- 影像三面（R-101 二次封裝：xiai-api `/api/image/**`；**非 A1–A31 契約方法**） -------
// 说明：三面是 xiai-api 影像面的直接消費面（塊 / 縮略 / 原字節），**不受 `DATA_SOURCE` 開關影響** ——
// 是否有「源件摘要（sha256）」由頁面決定；無摘要 ⇒ 調用即結構化失敗（不代填、不造僞）。
// 頁面仍只經本入口取用（spec §8.3-3：禁止頁面直接 import `@/data/api/**`）。
export {
  IMAGE_FACES,
  IMAGE_FACE_ENDPOINTS,
  XIAI_CLIENT_KIND,
  CLIENT_KIND_BY_ASSET_KIND,
  clientKindOf,
  normalizeDigest,
  sha256Hex,
  releaseImageUrls,
  getImageSlices,
  getImageThumb,
  getImageOriginal,
} from './api/image.js'

// ---- 展示辅助（非数据读写，纯函数） --------------------------------------
/** 时间展示口径：UTC ISO8601 存储 → Asia/Shanghai 展示（spec §7.5 / AC-17）。 */
export { toCstDate, toCstMonth, toCstDateTime, recentCstBuckets } from './time.js'

export default impl
