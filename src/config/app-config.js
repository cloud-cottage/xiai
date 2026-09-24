/**
 * 站点级配置（非金额类）。
 *
 * spec §3.2 User.featureFlags / §8.2 A1：注册开关等配置位由配置驱动，
 * 页面**不得硬编码**开关态（R2）。演示价相关配置见 `src/config/pricing.js`。
 *
 * 本对象是 A1 `getAppConfig()` 在 mock 下的取值来源；下轮换成
 * `GET /api/v1/config` 时只替换适配层实现，页面零改动。
 */
export const APP_CONFIG = Object.freeze({
  /** 配置位快照（spec §3.2）。 */
  featureFlags: Object.freeze({
    /** 注册开关（R2）：默认开放。spec §11 待决 5 默认「本地配置文件，无后台 UI」。 */
    registerOpen: true,
    /** 「申请演示环境」通路恒开（R3）。 */
    demoApplyOpen: true,
    /** API 文档入口（M2）。 */
    apiDocsOpen: true,
    /** 帮助中心入口（M3）。 */
    helpOpen: true,
    /** 机构资料页入口（M2）。 */
    orgProfileOpen: true,
    /** 「申请开票」占位入口（spec §11 待决 19：本轮仅占位）。 */
    invoiceEntryOpen: false,
  }),

  site: Object.freeze({
    name: '印源',
    tagline: '兆级玺印数字引擎',
    footerLine: '印源 © 2026 兆级玺印数字引擎｜文博玺印 API 图像服务平台',
    /** 全站时间口径标注（spec §7.5）。 */
    timezoneNote: '时间均为北京时间（CST）',
  }),

  /** 演示态开关与演示账号（P-M1-03 03-3）。凭证仅用于演示填充，登录不校验真实凭证。 */
  demo: Object.freeze({
    showDemoAccount: true,
    account: 'demo@yinsuo.example',
    password: 'yinsuo2026',
    label: '演示账号（演示环境：登录不校验真实凭证）',
  }),

  /** spec §11 待决 10 默认：每用户密钥数量上限 5。 */
  apiKeyLimit: 5,
  /** spec §11 待决 9 默认：待支付超时 15 分钟。 */
  orderPendingTimeoutMinutes: 15,
  /** spec §11 待决 18 默认：演示环境额度（30 天 + 2,000 次包量，无原图额度）。 */
  demoEnvQuota: Object.freeze({ days: 30, calls: 2000, originalImageQuota: 0 }),
  /** 未接入后端的操作统一提示语（spec §1.3 交互 3）。 */
  notConnectedNotice: '演示环境：该功能未接入',
})
