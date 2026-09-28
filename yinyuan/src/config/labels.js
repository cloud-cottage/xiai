/**
 * 展示层「枚举值 → 对客中文名」映射（唯一映射点）。
 *
 * 硬约束：
 * - 契约 / 适配层 / 配置里的枚举值**一字不改**（`contract.contract.js` 的 `LEDGER_TYPE`、
 *   额度策略 `policy` 等仍是原值，仅供程序判断，不直接渲染）；
 * - 对外页面**只渲染本文件给出的中文业务名**：英文枚举值、配置位路径（如 `featureFlags.registerOpen`）
 *   一律不得进入渲染文本；
 * - 本文件只做映射，不含金额 / 包量 / 额度 / 次数字面量（spec §4.3）；
 * - 未知值给兜底中文名，**不回显内部枚举值**（避免后端口径扩展时重新泄漏）。
 */

/** 账单流水类型（`contract.LEDGER_TYPE`）→ 对客中文名（§3.7 / §4.4）。 */
const LEDGER_TYPE_LABELS = Object.freeze({
  RECHARGE: '充值入账',
  ANNUAL_FEE: '年费扣减',
  DEDUCT_QUOTA: '额度扣减',
  DEDUCT_BALANCE: '余额扣减',
  OVERAGE: '超量结算',
  ORIGINAL_IMAGE: '原图下载',
  ADJUST: '人工调整',
  REFUND: '退款',
})

/** 支付渠道（`contract.PAY_CHANNEL`）→ 对客中文名（§3.6 / §1.3 P-M1-07 07-2）。 */
const PAY_CHANNEL_LABELS = Object.freeze({
  WECHAT: '微信支付',
  ALIPAY: '支付宝',
})

/** 原图额度策略（`PRICING.originalImageDownload.policy`）→ 对客中文名。 */
const ORIGINAL_QUOTA_POLICY_LABELS = Object.freeze({
  freeQuotaThenOverage: '免费额度 + 超量计费',
  HARD_CAP: '免费额度用尽后停止',
})

/**
 * 账单流水方向（`contract.LEDGER_DIRECTION`）→ 展示形态。
 * spec §1.3 P-M1-07 07-6 明确规定该列表头为「方向（+/-）」，故**不显示** `IN` / `OUT` 枚举值。
 */
const LEDGER_DIRECTION_LABELS = Object.freeze({
  IN: '+',
  OUT: '-',
})

/** 订单状态（`contract.ORDER_STATUS`）→ 对客中文名（spec §5.1 状态集合「中文」列，逐字对齐）。 */
const ORDER_STATUS_LABELS = Object.freeze({
  CREATED: '已下单',
  PENDING_PAY: '待支付',
  PAID: '已支付',
  SETTLED: '已入账',
  FAILED: '支付失败',
  EXPIRED: '已关闭（超时）',
  CANCELLED: '已取消',
})

/** 账单流水类型的中文名。 */
export function ledgerTypeLabel(type) {
  return LEDGER_TYPE_LABELS[type] || '其他'
}

/** 账单流水方向的展示形态（spec §1.3 07-6「方向（+/-）」）。 */
export function ledgerDirectionLabel(direction) {
  return LEDGER_DIRECTION_LABELS[direction] || '—'
}

/** 订单状态的中文名。 */
export function orderStatusLabel(status) {
  return ORDER_STATUS_LABELS[status] || '其他'
}

/**
 * 扣减顺序步骤（配置里的策略值）→ 对客中文名（§4.2 扣减顺序 / §8.2 A17 `deduction.order`）。
 * 策略枚举值本身不出现在界面上（§1.6 对外页面禁止集合）。
 */
const DEDUCTION_STEP_LABELS = Object.freeze({
  MONTHLY_QUOTA: '先用月包量',
  RECHARGE_BALANCE: '后扣充值余额',
})

export function deductionStepLabel(step) {
  return DEDUCTION_STEP_LABELS[step] || '按平台扣减规则'
}

/** 支付渠道的中文名（§3.6）。 */
export function payChannelLabel(channel) {
  return PAY_CHANNEL_LABELS[channel] || '其他'
}

/**
 * 流水筛选用的「类型多选」选项（§1.3 P-M1-07 07-7）——**值取自本文件的映射表键**，
 * 页面因此既不需要硬编码任何 SNAKE_CASE 枚举，也不会把枚举值渲染到界面上。
 */
export function ledgerTypeOptions() {
  return Object.keys(LEDGER_TYPE_LABELS).map((value) => ({ value, label: LEDGER_TYPE_LABELS[value] }))
}

/** 原图额度策略的中文名。 */
export function originalQuotaPolicyLabel(policy) {
  return ORIGINAL_QUOTA_POLICY_LABELS[policy] || '按平台每日额度规则'
}
