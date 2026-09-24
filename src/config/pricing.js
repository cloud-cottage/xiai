/**
 * ============================================================================
 * 定价与计费口径 —— 全站唯一的金额 / 包量 / 单价 / 扣减规则数据源
 * （spec §4.3 单一数据源；追溯 R8）
 *
 * 「演示价，可一句话整体替换」：改本文件即可全站生效。
 * 页面 / 组件 / 文案中禁止出现任何金额、包量、单价的字面量
 * （spec §4.3 校验：除本模块外不得出现 3600/12000/36000/2000/10000/50000/0.8/0.5/0.3/2.00 作为价格）。
 * 页面只能经适配层 getPlans() / getPricingTable() / computeScenario() 读取。
 * ============================================================================
 */

/** 套餐档位标识（spec §3.5）。 */
export const PLAN_IDS = Object.freeze({
  STANDARD: 'plan_standard',
  PRO: 'plan_pro',
  ORG: 'plan_org',
})

/**
 * 演示价配置对象（唯一来源）。
 * - 金额单位一律为**整数分**（spec §3.1）；
 * - 高清原图单价各档同价，因此**只在此处定义一次**，
 *   由 getPlans() 折叠进每个 Plan.originalImageUnitPriceCents（spec §3.5 / §4.2）。
 */
export const PRICING = Object.freeze({
  currency: 'CNY',
  isDemoPrice: true,
  effectiveFrom: '2026-01-01',
  timezone: 'Asia/Shanghai',

  /** ① 一次性开通部署费：不展示金额（spec §4.1 ①）。 */
  setupFee: Object.freeze({
    display: false,
    label: '按项目测算',
  }),

  /** ② 年费 + ③ 月包量 + 超量单价（spec §4.2）。 */
  plans: Object.freeze([
    Object.freeze({
      planId: PLAN_IDS.STANDARD,
      name: '标准版',
      annualFeeCents: 360000,
      monthlyQuotaCalls: 2000,
      overageUnitPriceCents: 80,
      features: Object.freeze(['标准支持', '含检索与预览图调用']),
    }),
    Object.freeze({
      planId: PLAN_IDS.PRO,
      name: '专业版',
      annualFeeCents: 1200000,
      monthlyQuotaCalls: 10000,
      overageUnitPriceCents: 50,
      features: Object.freeze(['标准支持', '含优先支持', '含机构资料包']),
    }),
    Object.freeze({
      planId: PLAN_IDS.ORG,
      name: '机构版',
      annualFeeCents: 3600000,
      monthlyQuotaCalls: 50000,
      overageUnitPriceCents: 30,
      features: Object.freeze(['专属支持', '含机构资料包', '含定制对接']),
    }),
  ]),

  /** ④ 高清原图：按张计价，各档同价，不含在包量内（spec §4.1 ④ / §7.3）。 */
  originalImage: Object.freeze({
    unitPriceCents: 200,
    includedInQuota: false,
    chargedTo: 'RECHARGE_BALANCE',
    /** spec §11 待决 3 默认：原图调取**不**额外叠加 1 次调用。 */
    countOriginalAsCall: false,
    /** spec §11 待决 4 默认：同一 assetId 24h 内不去重，每次调取都计 1 张。 */
    dedupeWithin24h: false,
  }),

  /**
   * 展示切片通道配置（spec §7.7-R17a / §4.3「原图每日额度」行：切片张数经
   * getPricingTable() 提供，**不得在页面或文案中硬编码**）。
   * `signedUrlTtlSeconds` ＝ §11.2 待决 22 默认值 300 秒（切片与原图同一口径）。
   */
  displaySlices: Object.freeze({
    sliceCount: 2,
    signedUrlTtlSeconds: 300,
  }),

  /** 扣减顺序与跨月规则（spec §4.2，必须严格执行）。 */
  deduction: Object.freeze({
    /** 先用月包量，后扣充值余额。 */
    order: Object.freeze(['MONTHLY_QUOTA', 'RECHARGE_BALANCE']),
    /** 包量不跨月结转（spec §4.2-4 / R8）。 */
    quotaCarryOver: false,
    quotaResetAt: '每月 1 日 00:00:00（Asia/Shanghai）',
    /** 高清原图不占包量，直接扣充值余额。 */
    originalImageFrom: 'RECHARGE_BALANCE',
    /** 余额不足：记录欠费并阻断下轮调用（演示态）。 */
    blockCallWhenBalanceInsufficient: true,
    /** 年费与包量是两个独立收费项：年费不转包量、包量不抵年费（spec §4.2-5）。 */
    annualFeeSeparatFromQuota: true,
  }),

  /** 充值档位与自定义范围（spec §1.3 P-M1-07 07-2 / §11 待决 8）。 */
  recharge: Object.freeze({
    presetsCents: Object.freeze([100000, 500000, 1000000]),
    customRangeCents: Object.freeze({ min: 100, max: 10000000 }),
    channels: Object.freeze(['WECHAT', 'ALIPAY']),
  }),

  /**
   * 典型场景算例入参（spec §1.3 01-6 / 08-3，与官网既有宣传口径一致）。
   *
   * **v1.5 口径（Zang 终审 2026-09-19）**：旧「每月调取 10 张高清原图」的默认入参**退役**。
   * 默认入参改为「原图用量落在每日免费额度内」⇒ 原图费用 = ¥0 ⇒ 首年合计 = 年费；
   * 另配一条**超额算例**入参（`overageExample`）：免费额度 `freePerDay × daysPerMonth` 张内不计费，
   * 超出部分按原图单价从充值余额扣减。
   */
  scenario: Object.freeze({
    sessionsPerMonth: 200,
    sealsPerSession: 100,
    /** 折算口径：把「每日免费额度」折成每月免费用量（免费额度按自然日重置）。 */
    daysPerMonth: 30,
    /** 默认算例：原图用量落在每日免费额度内（额度内不计费）。 */
    originalImagesPerMonth: 30,
    /** 超额算例入参（§1.3 08-3）：超出免费额度后按张计费。 */
    overageExample: Object.freeze({
      originalImagesPerMonth: 100,
    }),
  }),

  /** 全站声明文案（含金额/用量页面必须展示，spec §1.6 全局声明条）。 */
  disclaimer: '本页金额、单价、用量数字均为界面示意值，非报价',
})

/**
 * ============================================================================
 * 原图下载额度策略 —— **单一配置项**（Zang 终审 2026-09-19；规范 v1.5 将对齐）
 *
 * 裁定口径（本项目当前默认，`mode='freeQuotaThenOverage'`）：
 *   ① 每日**免费额度** `freePerDay` 张/账号（Asia/Shanghai 自然日 00:00 重置；同账号多密钥共享）；
 *   ② 免费额度内**不收费**；
 *   ③ 免费额度用尽后**不拒绝**：每次下载按原图单价从**充值余额**扣减、**不设每日上限**；
 *      **仅余额不足时拒绝**（复用既有「余额不足」语义 + 充值引导）；
 *   ④ 免费额度**只由成功签发的下载**抵扣（未登录 / 余额不足 / 资源不存在 / 签发失败一律不抵扣）；
 *   ⑤ 原图不计调用次数（`countOriginalAsCall=false`）；切片只计图片流量、不计调用。
 *
 * 单价**不在此处重复定义**：一律取 `PRICING.originalImage.unitPriceCents`（单一真源，R8）。
 * 策略切换**只改本对象的 `mode`**（页面与适配层响应文案一律读 `getOriginalQuotaPolicy()`，
 * 不写死「免费 / 封顶 / 不可再多」类措辞）：
 *   - `'freeQuotaThenOverage'` —— **当前默认**（上述裁定口径）；
 *   - `'HARD_CAP'`            —— 规范 v1.4 历史口径（用尽即拒），保留仅供回滚对比，非默认。
 * ============================================================================
 */
export const ORIGINAL_QUOTA_POLICY = Object.freeze({
  /** 唯一在生效的口径（v1.5 §3.9/§8.2 A30）：免费额度 + 超量按张扣余额。 */
  policy: 'freeQuotaThenOverage',
  /** 额度维度（spec §3.9 `originalDownloadQuota.scopeKey`）。 */
  scopeKey: 'account',
  /** 每日**免费**额度（张/账号；仅决定免收费张数，用尽不拒绝）。 */
  freePerDay: 3,
  /** 超出部分单价的去向（按张扣充值余额，不设每日金额上限）。 */
  chargedTo: 'RECHARGE_BALANCE',
  /** 重置口径（§7.7 / §7.5）。 */
  timezone: 'Asia/Shanghai',
  /** 余额不足时的充值引导目标（页面据此跳转；§4.2-2 / P-M1-07）。 */
  insufficientBalanceRechargePath: '/console/billing',
  /**
   * 余额不足拒绝文案模板（§8.2 A31 固定文案口径；数字一律由本配置插值，§4.3）。
   * 占位：{unitPrice} = formatCents(unitPriceCents)。
   */
  insufficientBalanceMessageTemplate: '余额不足，原图下载超出每日免费额度后按 {unitPrice}/张 从余额扣减，请先充值',
})

/**
 * 解析后的额度策略（含由 `PRICING.originalImage.unitPriceCents` 派生的单价与文案）。
 * 适配层 A30 / A31 与页面一律读本函数，不在别处硬编码额度、单价或措辞。
 */
export function getOriginalQuotaPolicy() {
  const p = ORIGINAL_QUOTA_POLICY
  const unitPriceCents = PRICING.originalImage.unitPriceCents
  return {
    policy: p.policy,
    scopeKey: p.scopeKey,
    /** 免费额度（张/账号/日）。 */
    freePerDay: p.freePerDay,
    unitPriceCents,
    chargedTo: p.chargedTo,
    timezone: p.timezone,
    rechargePath: p.insufficientBalanceRechargePath,
    insufficientBalanceMessage: p.insufficientBalanceMessageTemplate.replace('{unitPrice}', formatCents(unitPriceCents)),
  }
}

/** 展示格式：`¥` + 千分位 + 两位小数（spec §4.3 展示格式）。 */
export function formatCents(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—'
  const value = Number(cents) / 100
  const [intPart, decPart] = Math.abs(value).toFixed(2).split('.')
  const sign = value < 0 ? '-' : ''
  return `${sign}¥${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decPart}`
}

/** 次数展示：「N 次」。 */
export function formatCalls(calls) {
  if (calls === null || calls === undefined || !Number.isFinite(Number(calls))) return '—'
  return `${Number(calls).toLocaleString('en-US')} 次`
}

/** 流量展示：MB/GB，1 GB = 1024 MB（spec §7.2），保留 1 位小数。 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  const mb = n / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(1)} MB`
}

/**
 * 明细行级别的字节展示：`12,345 字节`（**精确值**，不做 MB 折算）。
 *
 * 理由：单条调用的图片字节数通常在几千～几万量级，`formatBytes` 会四舍五入成 `0.0 MB`（不可读）。
 * 汇总口径仍用 MB/GB（`formatBytes` / `formatBytesParts`），明细口径用精确字节，与导出 CSV 的
 * `imageBytes` 列**逐字节一致**（§7.6 列口径 / §1.3 P-M1-06 06-5「图片字节数」）。
 */
export function formatBytesExact(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 字节'
  return `${Math.round(n).toLocaleString('en-US')} 字节`
}

/**
 * 图片流量的**双口径显示三元组**（spec §7.6「汇总双口径」；修复质检缺陷 D3）。
 *
 * 屏幕上的三个数字必须**可相加**：一律按**同一单位**（MB，任一值 ≥ 1 GB 时三者统一为 GB）
 * 与**同一精度（两位小数）**格式化，且**合计取「两个显示值之和」**（以 0.01 为单位做整数相加，
 * 规避浮点误差）——因此不会再出现「明细 4.3 ＋ 展示 2.5 ＝ 合计 6.7」这类显示层不自洽。
 *
 * 边界：`0` 与极小值（如展示通道为 0）一律不抛错——`safe()` 把非有限值 / 负值归零，
 * 三值相加仍自洽（`0.00 ＋ 0.00 ＝ 0.00`）。
 */
export function formatBytesParts(detailBytes, displayBytes, totalBytes = null) {
  const safe = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  const detail = safe(detailBytes)
  const display = safe(displayBytes)
  const rawTotal = totalBytes === null || totalBytes === undefined ? detail + display : safe(totalBytes)
  // 任一值达到 1 GB 时三者统一用 GB，保证三数字同单位、可相加
  const useGb = [detail, display, rawTotal].some((v) => v / (1024 * 1024) >= 1024)
  const unit = useGb ? 'GB' : 'MB'
  const divisor = useGb ? 1024 * 1024 * 1024 : 1024 * 1024
  const hundredths = (v) => Math.round((v / divisor) * 100)
  const detailH = hundredths(detail)
  const displayH = hundredths(display)
  const totalH = detailH + displayH
  const fmt = (h) => `${(h / 100).toFixed(2)} ${unit}`
  return {
    unit,
    detail: fmt(detailH),
    display: fmt(displayH),
    total: fmt(totalH),
    /** 显示值（以 0.01 为单位）——供自测与对账断言直接相加，不再受四舍五入影响。 */
    detailHundredths: detailH,
    displayHundredths: displayH,
    totalHundredths: totalH,
  }
}

/** 由配置派生的 Plan[]（含原图单价与币种，spec §3.5 / §8.2 A16）。 */
export function getPlans() {
  return PRICING.plans.map((plan) => ({
    planId: plan.planId,
    name: plan.name,
    annualFeeCents: plan.annualFeeCents,
    monthlyQuotaCalls: plan.monthlyQuotaCalls,
    overageUnitPriceCents: plan.overageUnitPriceCents,
    originalImageUnitPriceCents: PRICING.originalImage.unitPriceCents,
    currency: PRICING.currency,
    isDemoPrice: PRICING.isDemoPrice,
    effectiveFrom: PRICING.effectiveFrom,
    features: [...plan.features],
  }))
}

/** 按 planId 取档位；未知档位回落到第一档（不抛错，避免页面崩）。 */
export function getPlanById(planId) {
  const plans = getPlans()
  return plans.find((p) => p.planId === planId) || plans[0]
}

/**
 * 典型场景文案（从配置插值，页面不得自行书写数字；spec §4.3）。
 * v1.3 口径：场景数字 ＝ 200 次查阅会话 / 100 方玺印 / 账号维度每日原图下载额度 N 张
 * （旧「10 张高清原图」表述退役；切片张数亦取自配置）。
 */
export function getScenarioText() {
  const s = PRICING.scenario
  const q = getOriginalQuotaPolicy()
  return `每月 ${s.sessionsPerMonth} 次查阅会话，单次会话浏览 ${s.sealsPerSession} 方玺印，`
    + `图像以「展示切片」下发（每方 ${PRICING.displaySlices.sliceCount} 片，不计调用次数）；`
    + `高清原图：账号维度每日免费额度 ${q.freePerDay} 张（额度内不计费），`
    + `超出部分按 ${formatCents(q.unitPriceCents)}/张 从充值余额扣减`
}

/**
 * 场景算例清单（页面渲染用；口径① 免费额度内 / 口径② 超额算例）。
 * 页面的「典型场景」与「超额算例」两张表均由本函数驱动，**不得在页面内造数字**。
 */
export function getScenarioExamples() {
  const s = PRICING.scenario
  const q = getOriginalQuotaPolicy()
  return [
    {
      key: 'IN_FREE_QUOTA',
      label: '典型场景 · 原图落在每日免费额度内',
      originalImagesPerMonth: s.originalImagesPerMonth,
    },
    {
      key: 'OVERAGE',
      label: `超额算例 · 免费额度 ${q.freePerDay} 张/日 × ${s.daysPerMonth} 天 内不计费，超出部分按张计费`,
      originalImagesPerMonth: s.overageExample.originalImagesPerMonth,
    },
  ]
}

/** 套餐对比表结构（spec §8.2 A17）。 */
export function getPricingTable() {
  return {
    currency: PRICING.currency,
    isDemoPrice: PRICING.isDemoPrice,
    effectiveFrom: PRICING.effectiveFrom,
    setupFee: { ...PRICING.setupFee },
    originalImageUnitPriceCents: PRICING.originalImage.unitPriceCents,
    originalImageIncludedInQuota: PRICING.originalImage.includedInQuota,
    /** §7.1 / §11 待决 3 默认：原图调取**不**叠加调用次数（页面据此插值口径文案）。 */
    originalImageCountAsCall: PRICING.originalImage.countOriginalAsCall,
    /** v1.3 新增配置行「原图每日额度」（§4.3；页面与 A30 一律读本行，不得硬编码）。 */
    originalImageDownload: {
      ...getOriginalQuotaPolicy(),
    },
    /** v1.3 展示切片通道配置（§7.7-R17a；切片张数不得硬编码）。 */
    displaySlices: { ...PRICING.displaySlices },
    rows: getPlans(),
    /**
     * 充值档位与自定义区间（spec §1.3 P-M1-07 07-2 / §4.3）：**必须经本方法下发**，
     * 页面不得写死档位金额或自定义上下限（`check:pricing` 对 1000/5000/10000 元与
     * 100000/500000/1000000 分等字面量做静态拦截）。渠道亦在此声明。
     */
    recharge: {
      presetsCents: [...PRICING.recharge.presetsCents],
      customRangeCents: { ...PRICING.recharge.customRangeCents },
      channels: [...PRICING.recharge.channels],
    },
    scenario: { ...PRICING.scenario },
    scenarioText: getScenarioText(),
    /** v1.5：典型场景 / 超额算例两条口径的入参清单（§1.3 08-3；数字不得在页面硬编码）。 */
    scenarioExamples: getScenarioExamples(),
    deduction: {
      order: [...PRICING.deduction.order],
      quotaCarryOver: PRICING.deduction.quotaCarryOver,
      quotaResetAt: PRICING.deduction.quotaResetAt,
      originalImageFrom: PRICING.deduction.originalImageFrom,
      /** §4.2-5：年费与包量为两个独立收费项（文案由页面据本开关插值，不写死口径）。 */
      annualFeeSeparatFromQuota: PRICING.deduction.annualFeeSeparatFromQuota,
      /** §4.2-2：余额不足时记录欠费并阻断下轮调用（演示态）。 */
      blockCallWhenBalanceInsufficient: PRICING.deduction.blockCallWhenBalanceInsufficient,
    },
    disclaimer: PRICING.disclaimer,
  }
}

/**
 * 典型场景算例（spec §8.2 A18）—— 纯函数，页面不得自行乘加。
 *
 * **v1.5 口径（Zang 终审 2026-09-19）**：
 *  - 默认入参（`PRICING.scenario`）＝ 原图用量落在**每日免费额度**内 ⇒ 原图费用 **¥0** ⇒
 *    **首年合计＝年费**（标准 ¥3,600 / 专业 ¥12,000 / 机构 ¥36,000，均由配置给出）；
 *  - 超额算例（`PRICING.scenario.overageExample`）＝ 免费额度 `freePerDay × daysPerMonth` 张内不计费，
 *    超出部分按 `unitPriceCents` 逐张计费。
 *
 * 计次口径（spec §7.1）：批量检索按**请求**计，单请求返回 100 方仍为 1 次调用；
 * 高清原图**不**叠加调用次数（countOriginalAsCall=false），展示切片亦不计调用次数（R17c）。
 */
export function computeScenario(input = {}) {
  const plan = getPlanById(input.planId)
  const scenario = PRICING.scenario
  const quota = getOriginalQuotaPolicy()
  const calls = toCount(input.calls ?? input.sessionsPerMonth, scenario.sessionsPerMonth)
  const sealsPerSession = toCount(input.sealsPerSession, scenario.sealsPerSession)
  const originalImages = toCount(
    input.originalImages ?? input.originalImagesPerMonth,
    scenario.originalImagesPerMonth,
  )
  const daysPerMonth = toCount(input.daysPerMonth, scenario.daysPerMonth)

  const quotaTotalCalls = plan.monthlyQuotaCalls
  const callsInQuota = Math.min(calls, quotaTotalCalls)
  const overageCalls = Math.max(0, calls - quotaTotalCalls)
  const overageCents = overageCalls * plan.overageUnitPriceCents

  /** 每月免费用量 = 每日免费额度 × 天数（每日额度按 Asia/Shanghai 自然日重置）。 */
  const originalImageFreeAllowance = quota.freePerDay * daysPerMonth
  const originalImagesFreeCount = Math.min(originalImages, originalImageFreeAllowance)
  const originalImagesOverageCount = Math.max(0, originalImages - originalImageFreeAllowance)
  const originalImageCents = originalImagesOverageCount * quota.unitPriceCents

  const monthlyCents = overageCents + originalImageCents
  const annualCents = plan.annualFeeCents

  return {
    planId: plan.planId,
    planName: plan.name,
    currency: PRICING.currency,
    isDemoPrice: PRICING.isDemoPrice,
    inputs: { calls, sealsPerSession, originalImages, daysPerMonth },
    quotaTotalCalls,
    callsInQuota,
    callsInQuotaCents: 0,
    overageCalls,
    overageUnitPriceCents: plan.overageUnitPriceCents,
    overageCents,
    originalImages,
    originalImageUnitPriceCents: quota.unitPriceCents,
    /** v1.5：免费额度口径字段（额度内不计费；超出部分按张扣余额）。 */
    originalImagePolicy: quota.policy,
    originalImageFreePerDay: quota.freePerDay,
    originalImageDaysPerMonth: daysPerMonth,
    originalImageFreeAllowance,
    originalImagesFreeCount,
    originalImagesOverageCount,
    originalImageCents,
    monthlyCents,
    annualCents,
    /** 首年合计 = 年费 + 单月用量（不含一次性开通部署费）。 */
    totalFirstYearCents: annualCents + monthlyCents,
    setupFee: { display: PRICING.setupFee.display, label: PRICING.setupFee.label },
    lines: [
      {
        key: 'ANNUAL_FEE',
        label: '年度平台授权与运维服务费',
        detail: `${plan.name}年费（按年收取，不转包量）`,
        amountCents: annualCents,
      },
      {
        key: 'QUOTA',
        label: '月度包量内调用',
        detail: `${formatCalls(callsInQuota)} / 包量 ${formatCalls(quotaTotalCalls)}（包量内不另计费）`,
        amountCents: 0,
      },
      {
        key: 'OVERAGE',
        label: '超量调用',
        detail:
          overageCalls > 0
            ? `${formatCalls(overageCalls)} × ${formatCents(plan.overageUnitPriceCents)}/次`
            : '未超出包量',
        amountCents: overageCents,
      },
      {
        key: 'ORIGINAL_IMAGE',
        label: '高清原图调取',
        detail: originalImages === 0
          ? '未调取'
          : originalImagesOverageCount === 0
            ? `${originalImages} 张（每日免费额度 ${quota.freePerDay} 张内，不计费）`
            : `${originalImages} 张 ＝ 免费额度 ${originalImageFreeAllowance} 张`
              + `（每日 ${quota.freePerDay} 张 × ${daysPerMonth} 天，不计费）`
              + ` ＋ 超出 ${originalImagesOverageCount} 张 × ${formatCents(quota.unitPriceCents)}/张`
              + '（不含在包量内，从充值余额扣减）',
        amountCents: originalImageCents,
      },
    ],
    disclaimer: PRICING.disclaimer,
  }
}

function toCount(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}
