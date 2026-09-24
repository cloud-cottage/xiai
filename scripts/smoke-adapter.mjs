/**
 * 适配层运行期冒烟（Node 侧，经 esbuild 打包后执行；验证真实逻辑而非静态文本）。
 * 用法：npm run smoke
 */
import * as A from '@/data'
import { RESOLVED_DATA_SOURCE } from '@/data'
import { ADAPTER_METHODS, ORIGINAL_DOWNLOAD_ERROR } from '@/data/contract.js'
import { PRICING, formatBytesExact, formatBytesParts, formatCents, getOriginalQuotaPolicy } from '@/config/pricing.js'
import { toCstDate, recentCstBuckets } from '@/data/time.js'

const out = []
const log = (...a) => out.push(a.join(' '))
const ok = (cond, label, detail = '') => log(`${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)

/** §8.2 契约形状② 分页信封：{items,total,page,pageSize,totalPages}，不得为裸数组（D2 回归护栏）。 */
const isEnvelope = (v) => !!v && !Array.isArray(v) && Array.isArray(v.items)
  && typeof v.total === 'number' && typeof v.page === 'number'
  && typeof v.pageSize === 'number' && typeof v.totalPages === 'number'
  && v.total === v.items.length + (v.page - 1) * v.pageSize
  && v.totalPages === Math.max(1, Math.ceil(v.total / v.pageSize))

log(`数据源实现：${RESOLVED_DATA_SOURCE}`)

// 契约形状⑧：方法总数 = 33（A1–A31 编号；A4 / A29 各 2 个子方法）
ok(ADAPTER_METHODS.length === 33, '⑧ 契约方法总数 = 33（A1–A31；A4/A29 各含 2 子方法）', `len=${ADAPTER_METHODS.length}`)
ok(new Set(ADAPTER_METHODS).size === ADAPTER_METHODS.length, '⑧ 方法清单无重复项')
const missing = ADAPTER_METHODS.filter((m) => typeof A[m] !== 'function')
ok(missing.length === 0, '⑧ 清单内 33 个方法在适配层全部存在', missing.join(',') || '缺 0 个')

// A1
const cfg = await A.getAppConfig()
ok(cfg.featureFlags.registerOpen === true, 'A1 getAppConfig → 注册开关位', JSON.stringify(cfg.featureFlags))

// A3 登录（演示凭证）
const loginErr = await A.login('not-an-account', 'abc12345').then(() => null).catch((e) => e)
ok(loginErr?.code === 'AUTH_FAILED', 'A3 login 非法账号被拒', loginErr?.message || '')
const session = await A.login(cfg.demo.account, cfg.demo.password)
ok(!!session.sessionToken && session.user.email === cfg.demo.account, 'A3 login 演示账号通过', session.user.userId)
ok((await A.getSession())?.userId === session.user.userId, 'A4 getSession 返回会话用户')

// A5 密钥（无明文）
const keys = await A.listApiKeys()
ok(keys.length > 0, 'A5 listApiKeys 返回种子密钥', `${keys.length} 个`)
ok(keys.every((k) => !('plaintextOnce' in k) && !('_issuedPlaintext' in k)), 'A5/A6 列表不含明文与内部字段')
ok(keys.every((k) => /^ys_(test|live)_•{24}[A-Za-z0-9]{4}$/.test(k.maskedKey)), 'A5 掩码形态 = 前缀 + 24 个 • + 末 4 位', keys[0].maskedKey)
ok(keys.every((k) => /^key_[A-Z2-7]{12}$/.test(k.kid)), '§6.1 kid = key_ + 12 位 Base32', keys[0].kid)

// A6 新建密钥（明文仅一次；§6.1 格式与长度）
const created = await A.createApiKey({ label: '冒烟', env: 'TEST', scopes: ['seal:search'] })
ok(/^ys_test_[A-Za-z0-9]{32}$/.test(created.plaintextOnce) && created.plaintextOnce.length === 40, 'A6 明文 = ys_test_ + 32 位 Base62 = 40 字符', `len=${created.plaintextOnce.length}`)
ok(!('plaintextOnce' in created.key) && created.key.maskedKey.endsWith(created.plaintextOnce.slice(-4)), 'A6 响应内明文一次、掩码末 4 位一致')
const afterList = await A.listApiKeys()
ok(!JSON.stringify(afterList).includes(created.plaintextOnce), '§6.2 再取列表无法取回明文')

// A7 重生：kid 不变、rotatedAt 更新
const before = afterList.find((k) => k.kid === created.key.kid)
const rotated = await A.rotateApiKey(created.key.kid)
ok(rotated.key.kid === before.kid && rotated.key.rotatedAt, 'A7 重生 kid 不变、rotatedAt 已写', `${rotated.key.kid} @ ${rotated.key.rotatedAt}`)

// A8 / A9
const disabled = await A.setApiKeyStatus(created.key.kid, 'DISABLED')
ok(disabled.status === 'DISABLED', 'A8 禁用生效')
await A.deleteApiKey(created.key.kid)
ok((await A.listApiKeys()).every((k) => k.kid !== created.key.kid), 'A9 删除生效')

// A10–A13 用量口径
const summary = await A.getUsageSummary({ range: '30d' })
ok(summary.calls > 0 && summary.billableCalls <= summary.calls, 'A10 汇总：调用次数 ≥ 计费调用', `calls=${summary.calls} billable=${summary.billableCalls} failed=${summary.failedCalls} 原图=${summary.originalImages} 流量=${summary.imageBytes}B`)
const has = (r) => r.isBillable || r.statusCode >= 400
ok(summary.failedCalls >= 0 && has, 'A10 失败请求单列（不计入计费调用）')
const bd = await A.getUsageBreakdown({ range: '30d' }, 'endpoint')
ok(bd.rows.length > 0 && Math.abs(bd.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9, 'A11 按接口分组且占比合计 = 1', `${bd.rows.length} 组`)
const tr = await A.getUsageTrend({ range: '30d' }, 'day')
const tr2 = await A.getUsageTrend({ range: '30d' }, 'day')
ok(JSON.stringify(tr) === JSON.stringify(tr2), 'A12 固定种子：同会话两次趋势结果一致', `${tr.series.length} 个桶`)
const page1 = await A.listUsageRecords({ range: '30d' }, { page: 1, pageSize: 20 })
ok(page1.items.length === 20 && page1.total === summary.calls, 'A13 分页 20/页且 total = 汇总口径', `total=${page1.total} pages=${page1.totalPages}`)

// P-M1-04 04-3 趋势图：图表轴（CST 自然桶，覆盖完整窗口）+ A12 「近 12 月（月粒度）」窗口
const todayCst = toCstDate(new Date().toISOString())
const monthAxis = recentCstBuckets('month', 12)
const dayAxis = recentCstBuckets('day', 30)
ok(monthAxis.length === 12 && new Set(monthAxis).size === 12 && monthAxis[0] < monthAxis[11]
  && monthAxis[11] === todayCst.slice(0, 7) && monthAxis.every((k) => /^\d{4}-\d{2}$/.test(k)),
  'P-M1-04 04-3 趋势轴：近 12 月刻度升序、无重复、末月 = 当期 CST 自然月', `${monthAxis[0]} … ${monthAxis[11]}`)
ok(dayAxis.length === 30 && new Set(dayAxis).size === 30 && dayAxis[0] < dayAxis[29]
  && dayAxis[29] === todayCst && dayAxis.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
  && dayAxis[0] !== dayAxis[29],
  'P-M1-04 04-3 趋势轴：近 30 日刻度升序、无重复、末日 = 当期 CST 自然日', `${dayAxis[0]} … ${dayAxis[29]}`)
const tr12 = await A.getUsageTrend({ range: '12m' }, 'month')
ok(tr12.bucket === 'month' && tr12.series.length >= 1
  && tr12.series.every((s) => /^\d{4}-\d{2}$/.test(s.bucket) && s.bucket >= monthAxis[0]),
  'A12 支持「近 12 月」窗口（月粒度）—— 概览页趋势图切换同一适配层方法重算',
  `${tr12.series.length} 个有记录的月桶 / ${tr12.series.map((s) => s.bucket).join(',')}`)

// A14 导出：UTF-8 BOM、列顺序、行集 = 筛选结果
const csv = await A.exportUsage({ range: '7d' })
const csv7 = await A.exportUsage({ range: '7d' })
const expectedHeader = 'requestedAt(CST),kid,label,endpoint,method,statusCode,latencyMs,isBillable,callCount,imageCount,imageBytes,originalImageCount,env,traceId'
ok(csv.content.charCodeAt(0) === 0xfeff, 'A14 CSV 带 UTF-8 BOM')
ok(csv.content.replace(/^\ufeff/, '').split('\r\n')[0] === expectedHeader, 'A14 列顺序符合 §7.6')
ok(csv.rowCount === csv7.rowCount && csv.fileName.includes('7d') === false && csv.fileName.endsWith('.csv'), 'A14 行集合严格等于筛选结果', `rows=${csv.rowCount} file=${csv.fileName}`)
ok(csv.rowCount < summary.calls, 'A14 近 7 日行数 < 近 30 日行数（不是全量导出）')

// A15 账户：Σ流水 = 余额（§5.4-3）
const acct = await A.getAccount()
ok(acct.consistency.consistent && acct.consistency.ledgerSumCents === acct.balanceCents, 'A15 Σ流水 = 余额 自检通过', `余额=${formatCents(acct.balanceCents)}`)
ok(acct.quotaRemainCalls === Math.max(0, acct.quotaTotalCalls - acct.quotaUsedCalls) && acct.quotaRemainCalls >= 0, 'A15 月额度余量非负且 = 包量 − 已用', `${acct.quotaUsedCalls}/${acct.quotaTotalCalls}`)

// A16–A18
const plans = await A.getPlans()
ok(plans.length === 3 && plans.every((p) => p.originalImageUnitPriceCents === plans[0].originalImageUnitPriceCents), 'A16 三档且原图单价同价')
const sc = await A.computeScenario({ planId: 'plan_standard' })
ok(sc.totalFirstYearCents === sc.annualCents + sc.overageCents + sc.originalImageCents, 'A18 算例自洽（年费 + 超量 + 原图）', formatCents(sc.totalFirstYearCents))

// A18 **v1.5 口径（Zang 终审）**：原图在每日免费额度内 ⇒ 原图费用 0 ⇒ 首年 = 年费；另给一条超额算例。
const tableA17 = await A.getPricingTable()
const stdRow = plans.find((p) => p.planId === sc.planId)
const scenarioDays = PRICING.scenario.daysPerMonth
const freeAllowance = sc.originalImageFreePerDay * scenarioDays
ok(sc.originalImagesFreeCount === sc.originalImages && sc.originalImagesOverageCount === 0
  && sc.originalImageCents === 0 && sc.originalImagePolicy === 'freeQuotaThenOverage',
  'A18 ① 默认算例：原图落在每日免费额度内 ⇒ 原图费用 ¥0',
  `${sc.originalImages} 张 ≤ 每月免费用量 ${freeAllowance} 张（每日 ${sc.originalImageFreePerDay} 张 × ${scenarioDays} 天）`)
ok(sc.totalFirstYearCents === sc.annualCents && sc.annualCents === stdRow.annualFeeCents,
  'A18 ① 默认算例：首年合计 = 年费（原图费用为 0）',
  `${stdRow.name} 首年 ${formatCents(sc.totalFirstYearCents)}`)
const inQuotaLine = sc.lines.find((l) => l.key === 'ORIGINAL_IMAGE')
ok(inQuotaLine.amountCents === 0 && inQuotaLine.detail.includes(String(sc.originalImageFreePerDay)),
  'A18 ① 原图费用行口径由配置插值（不含金额字面量）', inQuotaLine.detail)
const overInput = (tableA17.scenarioExamples || []).find((e) => e.key === 'OVERAGE')
ok(!!overInput && tableA17.scenarioExamples.length === 2 && overInput.originalImagesPerMonth > freeAllowance,
  'A17 场景算例清单含「超额算例」入参（页面据其渲染，不造数字）',
  `入参 ${overInput?.originalImagesPerMonth} 张/月`)
const scOver = await A.computeScenario({ planId: 'plan_standard', originalImagesPerMonth: overInput.originalImagesPerMonth })
const expectedOverage = overInput.originalImagesPerMonth - freeAllowance
ok(scOver.originalImagesFreeCount === freeAllowance && scOver.originalImagesOverageCount === expectedOverage
  && scOver.originalImageCents === expectedOverage * scOver.originalImageUnitPriceCents
  && scOver.monthlyCents === scOver.originalImageCents,
  'A18 ② 超额算例：免费额度内不计费 + 超出部分按张计费',
  `月需 ${overInput.originalImagesPerMonth} 张 ＝ 免费 ${freeAllowance} 张 ＋ 超出 ${expectedOverage} 张 × `
  + `${formatCents(scOver.originalImageUnitPriceCents)}/张 ⇒ 月 ${formatCents(scOver.originalImageCents)}；首年 ${formatCents(scOver.totalFirstYearCents)}`)
const retiredPhrase = ['调取', '10', '张', '高清原图'].join(' ')
ok(!tableA17.scenarioText.includes(retiredPhrase)
  && tableA17.scenarioText.includes(String(sc.originalImageFreePerDay))
  && tableA17.scenarioText.includes(formatCents(sc.originalImageUnitPriceCents)),
  '§4.3 场景文案插值：免费额度与超出单价均来自配置，旧「' + retiredPhrase + '」口径已退役',
  tableA17.scenarioText)

// A19–A23 假支付闭环 + 幂等
const order = await A.createRechargeOrder({ amountCents: PRICING.recharge.presetsCents[0], channel: 'ALIPAY' })
ok(/^RO\d{14}$/.test(order.orderId) && order.status === 'CREATED', 'A19 下单：订单号 RO+YYYYMMDD+6 位序列', order.orderId)
const badAmt = await A.createRechargeOrder({ amountCents: 50 }).then(() => null).catch((e) => e)
ok(badAmt?.code === 'AMOUNT_OUT_OF_RANGE', 'A19 金额越界被拒', badAmt?.message || '')
const paid = await A.simulatePayResult(order.orderId, 'success')
ok(paid.status === 'PAID' && paid.paidAt && paid.qrPayload.startsWith('DEMO-QR:'), 'A22 模拟成功 → PAID（含假二维码载荷）')
const s1 = await A.settleRechargeOrder(order.orderId)
const s2 = await A.settleRechargeOrder(order.orderId)
const rechargeEntries = (await A.listLedgerEntries({}, { pageSize: 500 })).items.filter((e) => e.relatedOrderId === order.orderId && e.type === 'RECHARGE')
ok(s1.idempotent === false && s2.idempotent === true && rechargeEntries.length === 1, '§5.4 重复入账只产生 1 条 RECHARGE 流水', `entries=${rechargeEntries.length}`)
ok(!s1.idempotent && s1.account.balanceCents > acct.balanceCents, 'A23 入账后余额增加', `${formatCents(acct.balanceCents)} → ${formatCents(s1.account.balanceCents)}`)
const failed = await A.createRechargeOrder({ amountCents: PRICING.recharge.presetsCents[0] }).then((o) => A.simulatePayResult(o.orderId, 'fail'))
const beforeFail = failed.status === 'FAILED'
const noLedger = (await A.listLedgerEntries({}, { pageSize: 500 })).items.filter((e) => e.relatedOrderId === failed.orderId)
ok(beforeFail && noLedger.length === 0, '§5.2 T5 失败分支：余额不变、无流水')
const termErr = await A.simulatePayResult(order.orderId, 'fail').then(() => null).catch((e) => e)
ok(termErr?.code === 'ORDER_TERMINAL', '§5.3 终态不可逆')

// A21 充值订单：§8.2 契约形状②（D2 曾判为裸数组）
const ordersPage = await A.listRechargeOrders({})
ok(isEnvelope(ordersPage) && ordersPage.items.some((o) => o.orderId === order.orderId), 'A21 分页信封 {items,total,page,pageSize,totalPages}', `total=${ordersPage.total} pages=${ordersPage.totalPages} items=${ordersPage.items.length}`)
ok((await A.listRechargeOrders({}, { page: 1, pageSize: 1 })).items.length === 1, 'A21 支持分页入参（pageSize=1 → 1 条/页）')

// A24 流水类型：DEDUCT_QUOTA 与 DEDUCT_BALANCE 分列
const ledger = await A.listLedgerEntries({}, { pageSize: 500 })
ok(isEnvelope(ledger) && ledger.items.length === ledger.total, 'A24 分页信封 {items,total,page,pageSize,totalPages}', `total=${ledger.total} pages=${ledger.totalPages}`)
const types = new Set(ledger.items.map((e) => e.type))
ok(types.has('DEDUCT_QUOTA'), '§4.4 存在 DEDUCT_QUOTA 流水（只动次数）')
ok(types.has('ORIGINAL_IMAGE'), '§4.4 存在 ORIGINAL_IMAGE 流水（原图扣余额）')
ok(ledger.items.every((e) => e.balanceAfterCents !== undefined), '§3.7 每条流水带余额快照')

// ---------------------------------------------------------------------------
// D1 回归护栏：A24 流水时间范围（`range`）—— 换算只在适配层一处，用量系与流水共用
// ---------------------------------------------------------------------------
const idsOf = (env) => env.items.map((e) => e.entryId)
const sets = {
  today: new Set(idsOf(await A.listLedgerEntries({ range: 'today' }, { pageSize: 500 }))),
  '7d': new Set(idsOf(await A.listLedgerEntries({ range: '7d' }, { pageSize: 500 }))),
  '30d': new Set(idsOf(await A.listLedgerEntries({ range: '30d' }, { pageSize: 500 }))),
  month: new Set(idsOf(await A.listLedgerEntries({ range: 'month' }, { pageSize: 500 }))),
  all: new Set(idsOf(await A.listLedgerEntries({ range: 'all' }, { pageSize: 500 }))),
}
const sizes = Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size]))
const subsetOf = (a, b) => [...a].every((x) => b.has(x))
ok(subsetOf(sets.today, sets['7d']) && sets.today.size < sets['7d'].size
  && subsetOf(sets['7d'], sets['30d']) && sets['7d'].size < sets['30d'].size
  && subsetOf(sets['30d'], sets.all) && sets['30d'].size < sets.all.size,
  'D1 流水窗口严格嵌套：今日 ⊊ 近 7 日 ⊊ 近 30 日 ⊊ 全部（修复前五档返回同一集合）',
  `today=${sizes.today} ⊊ 7d=${sizes['7d']} ⊊ 30d=${sizes['30d']} ⊊ all=${sizes.all}`)
ok(new Set([sets.today, sets['7d'], sets['30d'], sets.month, sets.all].map((s) => [...s].sort().join('|'))).size === 5,
  'D1 五档（今日／近 7 日／近 30 日／本月／全部）返回集合两两互不相同',
  `集合规模 ${sizes.today}/${sizes['7d']}/${sizes['30d']}/${sizes.month}/${sizes.all}`)
const todayCstKey = toCstDate(new Date().toISOString())
const todayRows = (await A.listLedgerEntries({ range: 'today' }, { pageSize: 500 })).items
ok(todayRows.length > 0 && todayRows.every((e) => e.cstDate === todayCstKey),
  'D1 「今日」档不得出现往日的流水（逐行核对 CST 归属日）', `今日 ${todayRows.length} 条，越界 0 条`)
const monthRows = (await A.listLedgerEntries({ range: 'month' }, { pageSize: 500 })).items
ok(monthRows.length > 0 && monthRows.every((e) => e.cstMonth === todayCstKey.slice(0, 7)),
  'D1 「本月」档不得出现往月的流水（逐行核对 CST 归属月）', `本月 ${monthRows.length} 条，越界 0 条`)
const cstDayStart = (k) => new Date(`${k}T00:00:00+08:00`).toISOString()
const shiftDayKey = (k, d) => toCstDate(new Date(Date.parse(`${k}T00:00:00Z`) + d * 86400000).toISOString())
const winStart = {
  today: cstDayStart(todayCstKey),
  '7d': cstDayStart(shiftDayKey(todayCstKey, -6)),
  '30d': cstDayStart(shiftDayKey(todayCstKey, -29)),
  month: cstDayStart(`${todayCstKey.slice(0, 7)}-01`),
  all: new Date(0).toISOString(),
}
const nowIso = new Date().toISOString()
for (const r of Object.keys(winStart)) {
  const rows = (await A.listLedgerEntries({ range: r }, { pageSize: 500 })).items
  const bad = rows.filter((e) => e.occurredAt < winStart[r] || e.occurredAt > nowIso)
  ok(rows.length > 0 && bad.length === 0,
    `D1 「${r}」档行集 = 该窗口内的流水（逐行核对 occurredAt ∈ [窗口起点, now]）`,
    `${rows.length} 条 · 窗口起 ${winStart[r]} · 越界 ${bad.length} 条`)
}
const typed = await A.listLedgerEntries({ range: 'all', types: ['RECHARGE'] }, { pageSize: 500 })
const typedToday = await A.listLedgerEntries({ range: 'today', types: ['RECHARGE'] }, { pageSize: 500 })
ok(typed.total > 0 && typed.items.every((e) => e.type === 'RECHARGE')
  && typedToday.total < typed.total && typedToday.items.every((e) => e.type === 'RECHARGE'),
  'D1 类型多选 × 时间范围同时生效（RECHARGE：今日 ⊊ 全部，且行类型唯一）',
  `今日 ${typedToday.total} 条 / 全部 ${typed.total} 条`)
const pageA = await A.listLedgerEntries({ range: 'all' }, { page: 1, pageSize: 20 })
const pageB = await A.listLedgerEntries({ range: 'all' }, { page: 2, pageSize: 20 })
ok(pageA.items.length === 20 && pageB.items.length === 20 && pageA.total === sets.all.size
  && pageB.items.every((e) => !idsOf(pageA).includes(e.entryId)),
  'D1 时间范围 + 分页不回归（20/页、total 与行集一致、相邻页不重叠）',
  `total=${pageA.total} pages=${pageA.totalPages} 第 2 页 ${pageB.items.length} 条且与第 1 页无交集`)

// ---------------------------------------------------------------------------
// M1-P4 充值账单（spec §1.3 P-M1-07 07-1～07-8；§4.3 充值档位；§5 状态机 T1–T8；§5.4 幂等）
// ---------------------------------------------------------------------------
// ① A17 下发充值档位 / 自定义区间 / 渠道（页面不得写死档位；界面可选的取值必须都能下单，AC-74）
const tRec = tableA17.recharge
ok(Array.isArray(tRec?.presetsCents) && tRec.presetsCents.length === 3
  && tRec.presetsCents.every((c) => Number.isInteger(c)
    && c >= tRec.customRangeCents.min && c <= tRec.customRangeCents.max)
  && tRec.channels.length === 2,
  'A17 下发充值档位（3 档，逐档落在自定义区间内）与支付渠道（AC-74 硬保证）',
  `${tRec.presetsCents.map((c) => formatCents(c)).join(' / ')}`
  + ` ∈ [${formatCents(tRec.customRangeCents.min)}, ${formatCents(tRec.customRangeCents.max)}] · ${tRec.channels.join(',')}`)
ok(typeof tableA17.originalImageCountAsCall === 'boolean'
  && tableA17.deduction.annualFeeSeparatFromQuota === true
  && typeof tableA17.deduction.quotaCarryOver === 'boolean'
  && typeof tableA17.deduction.quotaResetAt === 'string',
  'A17 下发扣减与口径开关（年费独立 / 不跨月结转 / 重置时刻 / 原图是否计调用），页面文案据此插值',
  `原图计调用=${tableA17.originalImageCountAsCall} · 不跨月结转=${tableA17.deduction.quotaCarryOver === false}`)
const presetOrders = []
for (const cents of tRec.presetsCents) presetOrders.push(await A.createRechargeOrder({ amountCents: cents }))
ok(presetOrders.every((o) => o.status === 'CREATED'),
  'A19 三个固定档位逐档下单均成功（不存在「界面可选、提交被拒」的档位）',
  presetOrders.map((o) => o.orderId).join(','))
const edgeMin = await A.createRechargeOrder({ amountCents: tRec.customRangeCents.min })
const edgeMax = await A.createRechargeOrder({ amountCents: tRec.customRangeCents.max })
const belowErr = await A.createRechargeOrder({ amountCents: tRec.customRangeCents.min - 1 }).then(() => null).catch((e) => e)
const aboveErr = await A.createRechargeOrder({ amountCents: tRec.customRangeCents.max + 1 }).then(() => null).catch((e) => e)
ok(edgeMin.status === 'CREATED' && edgeMax.status === 'CREATED'
  && belowErr?.code === 'AMOUNT_OUT_OF_RANGE' && aboveErr?.code === 'AMOUNT_OUT_OF_RANGE',
  'A19 自定义金额边界（下限 / 上限）可下单，越界一律当场拦下',
  `${formatCents(edgeMin.amountCents)} / ${formatCents(edgeMax.amountCents)} · 越界拒绝码 ${belowErr?.code}/${aboveErr?.code}`)

// ② T1 → T2：下单（CREATED）→ 生成支付码（PENDING_PAY：占位二维码载荷 + 超时时刻）
const t2Order = await A.createRechargeOrder({ amountCents: tRec.presetsCents[1], channel: 'WECHAT' })
ok(t2Order.status === 'CREATED' && /^RO\d{14}$/.test(t2Order.orderId),
  '§5.2 T1 下单 → CREATED（订单号 RO + YYYYMMDD + 6 位序列）', t2Order.orderId)
const pendingOrder = await A.simulatePayResult(t2Order.orderId, 'pay-code')
ok(pendingOrder.status === 'PENDING_PAY' && pendingOrder.qrPayload === `DEMO-QR:${t2Order.orderId}`,
  '§5.2 T2 生成支付码 → PENDING_PAY（写占位二维码载荷，页面据此绘 CSS 占位码）',
  `${pendingOrder.status} / ${pendingOrder.qrPayload}`)
const payWindowSeconds = (new Date(pendingOrder.expiresAt).getTime() - Date.now()) / 1000
ok(payWindowSeconds > 0 && Math.abs(payWindowSeconds - cfg.orderPendingTimeoutMinutes * 60) <= 2,
  '§5.2 T2 超时时刻 = 下单 + 配置的待支付分钟数（A1 orderPendingTimeoutMinutes，倒计时来源）',
  `剩余 ${Math.round(payWindowSeconds)}s / 配置 ${cfg.orderPendingTimeoutMinutes} 分钟`)
const pendingAgain = await A.simulatePayResult(t2Order.orderId, 'pay-code')
ok(pendingAgain.status === 'PENDING_PAY' && pendingAgain.expiresAt === pendingOrder.expiresAt,
  '§5.2 T2 幂等：重复生成支付码不重置倒计时（刷新 / 「继续支付」按 expiresAt 恢复，AC-32）',
  pendingAgain.expiresAt)

// ③ T3 / T4 + 入账幂等 + 一致性自检（AC-25 / AC-29 / AC-30）
const acctBeforePay = await A.getAccount()
const ledgerCountBeforePay = (await A.listLedgerEntries({}, { pageSize: 500 })).total
const paidOrder = await A.simulatePayResult(t2Order.orderId, 'success')
const settledNow = await A.settleRechargeOrder(t2Order.orderId)
const settleAgain = await A.settleRechargeOrder(t2Order.orderId)
const entriesAfterPay = (await A.listLedgerEntries({}, { pageSize: 500 })).items
const mineNow = entriesAfterPay.filter((e) => e.relatedOrderId === t2Order.orderId)
ok(paidOrder.status === 'PAID' && !!paidOrder.paidAt, '§5.2 T3 模拟支付成功 → PAID（写支付时刻）', paidOrder.paidAt)
ok(settledNow.order.status === 'SETTLED' && settledNow.idempotent === false
  && settleAgain.idempotent === true && mineNow.length === 1 && mineNow[0].type === 'RECHARGE',
  '§5.2 T4 + §5.4 入账幂等：连续两次入账只产生 1 条「充值入账」流水',
  `入账流水条数=${mineNow.length}（第二次 idempotent=${settleAgain.idempotent}）`)
ok(mineNow[0].direction === 'IN' && mineNow[0].amountCents === t2Order.amountCents
  && mineNow[0].balanceAfterCents === settledNow.account.balanceCents,
  '§3.7 入账流水：方向 IN、金额 = 订单金额、余额快照 = 当前余额（流水表可直接核对）',
  `${formatCents(mineNow[0].amountCents)} → 余额快照 ${formatCents(mineNow[0].balanceAfterCents)}`)
ok(entriesAfterPay.length === ledgerCountBeforePay + 1
  && settledNow.account.balanceCents === acctBeforePay.balanceCents + t2Order.amountCents
  && settledNow.account.consistency.consistent
  && settledNow.account.consistency.ledgerSumCents === settledNow.account.balanceCents,
  '§5.4-2/3/4 入账原子：余额 +金额、仅 +1 条流水、Σ流水 = 余额（一致性自检通过）',
  `流水 ${ledgerCountBeforePay} → ${entriesAfterPay.length} · 余额 ${formatCents(acctBeforePay.balanceCents)}`
  + ` → ${formatCents(settledNow.account.balanceCents)} · Σ流水=${formatCents(settledNow.account.consistency.ledgerSumCents)}`)

// ④ T5 失败 / T6 超时 / T7 取消：一律零副作用，终态不可逆（§5.3-1 / §5.3-2）
const acctBeforeZero = await A.getAccount()
const ledgerBeforeZero = (await A.listLedgerEntries({}, { pageSize: 500 })).total
const failOrder = await A.createRechargeOrder({ amountCents: tRec.presetsCents[0] })
const failPending = await A.simulatePayResult(failOrder.orderId, 'pay-code')
const failedNow = await A.simulatePayResult(failOrder.orderId, 'fail')
const expireOrder = await A.createRechargeOrder({ amountCents: tRec.presetsCents[0] })
await A.simulatePayResult(expireOrder.orderId, 'pay-code')
const expiredNow = await A.simulatePayResult(expireOrder.orderId, 'timeout')
const cancelTarget = await A.createRechargeOrder({ amountCents: tRec.presetsCents[0] })
await A.simulatePayResult(cancelTarget.orderId, 'pay-code')
const cancelledNow = await A.simulatePayResult(cancelTarget.orderId, 'cancel')
ok(failPending.status === 'PENDING_PAY' && failedNow.status === 'FAILED' && !!failedNow.failReason,
  '§5.2 T5 模拟支付失败 → FAILED（写失败原因）', failedNow.failReason)
ok(expiredNow.status === 'EXPIRED' && expiredNow.failReason === '待支付超时',
  '§5.2 T6 倒计时归零 → 已关闭（超时）（页面据此置灰「去支付」并给「重新下单」）', expiredNow.failReason)
ok(cancelledNow.status === 'CANCELLED', '§5.2 T7 用户关闭 → CANCELLED（无余额变动）')
const terminalCancelErr = await A.simulatePayResult(expiredNow.orderId, 'cancel').then(() => null).catch((e) => e)
const zeroSideLedger = (await A.listLedgerEntries({}, { pageSize: 500 })).items
  .filter((e) => [failedNow.orderId, expiredNow.orderId, cancelledNow.orderId].includes(e.relatedOrderId))
const acctAfterZero = await A.getAccount()
ok(terminalCancelErr?.code === 'ORDER_TERMINAL'
  && zeroSideLedger.length === 0
  && acctAfterZero.balanceCents === acctBeforeZero.balanceCents
  && acctAfterZero.consistency.consistent
  && (await A.listLedgerEntries({}, { pageSize: 500 })).total === ledgerBeforeZero,
  '§5.3-1/2 失败 / 超时 / 取消三态零副作用（余额不变、流水零新增）且终态不可逆',
  `余额 ${formatCents(acctAfterZero.balanceCents)}（不变）· 流水 ${ledgerBeforeZero} → ${(await A.listLedgerEntries({}, { pageSize: 500 })).total}`)

// ⑤ T8 重新下单：生成新订单号，不复用旧单
const reorderNow = await A.createRechargeOrder({ amountCents: tRec.presetsCents[0] })
ok(reorderNow.status === 'CREATED' && reorderNow.orderId !== expiredNow.orderId,
  '§5.2 T8 重新下单 → 新订单号（不复用失败 / 超时订单）',
  `${expiredNow.orderId} → ${reorderNow.orderId}`)

// ⑥ 订单列表分页信封 + 状态为枚举值（中文名由展示层映射，适配层不翻译）
const orderPageP4 = await A.listRechargeOrders({}, { pageSize: 100 })
ok(isEnvelope(orderPageP4) && orderPageP4.items.length === orderPageP4.total
  && orderPageP4.items.every((o) => o.status === o.status.toUpperCase()),
  'A21 订单列表分页信封 + 状态保持枚举值（页面经展示层映射渲染中文，AC-88 不漏枚举）',
  `total=${orderPageP4.total} · 状态集 ${[...new Set(orderPageP4.items.map((o) => o.status))].join(',')}`)

// ⑦ 缺陷修复回归：展示通道流量含历史种子（三窗口不同、窗口平移不再归零）
const dcToday = (await A.getUsageSummary({ range: 'today' })).displayChannelBytes
const dc7 = (await A.getUsageSummary({ range: '7d' })).displayChannelBytes
const dc30 = (await A.getUsageSummary({ range: '30d' })).displayChannelBytes
ok(dcToday > 0 && dc7 > dcToday && dc30 > dc7,
  '展示通道流量含历史种子：今日 < 近 7 日 < 近 30 日（原缺陷：三窗口恒等、平移一天即归零）',
  `today=${dcToday}B · 7d=${dc7}B · 30d=${dc30}B`)

// A25–A27 玺印与取图（占位）
const seals = await A.listSeals({}, { page: 1, pageSize: 6 })
ok(seals.isPlaceholder === true && seals.items.length === 6 && seals.items.every((s) => s.isPlaceholder), 'A25 玺印条目为占位', `total=${seals.total}`)
const sealed = await A.getSeal(seals.items[0].sealId)
ok(sealed.assets.length === sealed.assetCount && sealed.assets.every((a) => a.previewWebpUrl.startsWith('about:placeholder#')), 'A26 详情含影像且预览地址为占位（不外链）')
// AC-80① 计量基线：取切片**前**的用量汇总（切片字节应只进图片流量、不进调用次数）
const trafficBefore = await A.getUsageSummary({ range: '30d' })
const url = await A.getDisplaySlices(sealed.assets[0].assetId)
// R-102（块数以真源为准）：印面（assets[0].kind === FACE）⇒ 2 刀 / 4 块 / 2×2；切片序号连续 0..n-1。
ok(url.slices.length === url.sliceMeta.tiles.length && url.slices.length === 4
  && url.slices.map((s) => s.sliceIndex).join(',') === '0,1,2,3'
  && url.slices.every((s) => s.rect && s.rect.w > 0 && s.rect.h > 0),
  'R-102 A27 印面（FACE）块数取真源：2 刀 / 4 块 / sliceIndex 0..3，各块带几何 rect',
  `slices=${url.slices.length} cuts=${url.sliceMeta.cuts} grid=${url.sliceMeta.cols}×${url.sliceMeta.rows}`)
ok(new Set(url.slices.map((s) => s.url)).size === url.slices.length
  && url.slices.every((s) => s.url.startsWith('about:placeholder#') && /sig=/.test(s.url)),
  'R-102 A27 各块各带独立签名 URL（不共用签名、不外链、无真实请求）', url.slices[0].url)
ok(/^(horizontal|vertical)$/.test(url.sliceMeta.direction)
  && url.sliceMeta.offsetRatio > 0 && url.sliceMeta.offsetRatio < 1
  && url.sliceMeta.sourceWidth > 0 && url.sliceMeta.sourceHeight > 0,
  'A27 切割元数据齐备（direction/offsetRatio/sourceWidth/sourceHeight）',
  `${url.sliceMeta.direction}@${url.sliceMeta.offsetRatio}`)
ok(url.sigTtlSeconds === PRICING.displaySlices.signedUrlTtlSeconds
  && url.slices.every((s) => s.sigExpiresAt && s.sigExpiresAt > url.sliceMeta.generatedAt),
  'A27 签名 TTL 取自配置且各块签名未过期（§11.2 待决 22 默认 300s）', `${url.sigTtlSeconds}s`)
// v1.7 新增两字段（AC-79）：内容缓存 TTL ＝ 当日剩余秒数（至 CST 次日 00:00:00）；内容缓存键 ＝ assetId:CST自然日
const cstDay = toCstDate(new Date().toISOString())
const cstNow = Date.now() + 8 * 60 * 60 * 1000
const cstRemainSeconds = Math.floor((Math.floor(cstNow / 86400000) * 86400000 + 86400000 - cstNow) / 1000)
ok(url.sliceContentCacheKey === `${url.assetId}:${cstDay}` && /^\d{4}-\d{2}-\d{2}$/.test(cstDay),
  'AC-79 v1.7 sliceContentCacheKey = `assetId:CST自然日`（同日相同、次日必变、与签名解耦）', url.sliceContentCacheKey)
ok(Number.isInteger(url.sliceContentTtlSeconds) && Math.abs(url.sliceContentTtlSeconds - cstRemainSeconds) <= 3
  && url.sliceContentTtlSeconds > 0 && url.sliceContentTtlSeconds !== url.sigTtlSeconds,
  'AC-79 v1.7 sliceContentTtlSeconds = 当日剩余秒数（自然日粒度，非固定秒数循环）≠ sigTtlSeconds（两个独立计时）',
  `内容 TTL=${url.sliceContentTtlSeconds}s（实测当日剩余 ${cstRemainSeconds}s）· 签名 TTL=${url.sigTtlSeconds}s`)
const url2 = await A.getDisplaySlices(sealed.assets[0].assetId)
ok(url2.sliceMeta.direction === url.sliceMeta.direction
  && url2.sliceMeta.offsetRatio === url.sliceMeta.offsetRatio,
  'AC-79 切片内容按 assetId + 当日日期派生：当天固定（可缓存）、重复获取不变（次日轮换由种子含日期保证）',
  `${url2.sliceMeta.direction}@${url2.sliceMeta.offsetRatio}`)
ok(url2.slices.every((s) => s.bytes === url.slices[s.sliceIndex].bytes && s.url !== url.slices[s.sliceIndex].url),
  'AC-79 签名 URL 刷新不改当日切片内容（内容与签名是两个独立计时）',
  `片字节 ${url.slices.map((s) => s.bytes).join('/')}`)
// AC-80① 切片字节计入图片流量、不计调用次数（两次取切片 = 2 组 × 每组块数字节）
const trafficAfter = await A.getUsageSummary({ range: '30d' })
const perGroupBytes = url.slices.reduce((s, x) => s + x.bytes, 0)
ok(trafficAfter.calls === trafficBefore.calls && trafficAfter.billableCalls === trafficBefore.billableCalls
  && trafficAfter.imageBytes - trafficBefore.imageBytes === perGroupBytes * 2
  && trafficAfter.imageCount - trafficBefore.imageCount === url.slices.length * 2,
  'AC-80① 切片各块字节均计入图片流量、切片请求不计调用次数',
  `流量 ${trafficBefore.imageBytes} → ${trafficAfter.imageBytes}B（+${trafficAfter.imageBytes - trafficBefore.imageBytes}B = 2 组 × ${perGroupBytes}B）`
  + ` · 调用次数 ${trafficBefore.calls} → ${trafficAfter.calls} 不变`)
ok((await A.getUsageBreakdown({ range: '30d' }, 'endpoint')).rows.some((r) => r.imageBytes > 0 && r.calls === 0),
  'AC-80① 展示切片流量并入 A11 按接口聚合（该分组调用次数为 0，只累计图片流量）')
ok(!(await A.listUsageRecords({ range: '30d' }, { page: 1, pageSize: 20 })).items.some((r) => r.endpoint.includes('/display')),
  'AC-80① 切片流量不产生调用明细行（A13 明细内无 display 请求）')
ok(url.slices.every((s) => s.bytes > 0) && !/\/original/.test(JSON.stringify(url)),
  'A27 展示通道不返回原图直链（R17b）、切片字节齐备')

// A10 / A14 **双口径**（Zang 终审）：明细行流量与展示通道流量分列 → 导出件与页面可逐字节勾稽
const summary30 = await A.getUsageSummary({ range: '30d' })
const export30 = await A.exportUsage({ range: '30d' })
ok(Number.isInteger(summary30.detailImageBytes) && Number.isInteger(summary30.displayChannelBytes)
  && summary30.displayChannelBytes > 0
  && summary30.imageBytes === summary30.detailImageBytes + summary30.displayChannelBytes,
  'A10 汇总双口径：imageBytes = detailImageBytes（明细行合计）+ displayChannelBytes（展示通道，不计调用）',
  `明细 ${summary30.detailImageBytes}B + 展示 ${summary30.displayChannelBytes}B = ${summary30.imageBytes}B`)
ok(export30.summary?.detailImageBytes === summary30.detailImageBytes
  && export30.summary?.displayChannelBytes === summary30.displayChannelBytes
  && export30.summary?.imageBytes === summary30.imageBytes,
  'A14 导出汇总字段与 A10 页面汇总同区间同口径（对客数字可勾稽）',
  `导出 明细 ${export30.summary?.detailImageBytes}B / 展示 ${export30.summary?.displayChannelBytes}B / 合计 ${export30.summary?.imageBytes}B`)
const exportLines = export30.content.replace(/^\ufeff/, '').split('\r\n')
ok(exportLines.some((l) => l.startsWith('图片流量（明细行合计）,') && l.includes(String(summary30.detailImageBytes)))
  && exportLines.some((l) => l.startsWith('展示通道流量（不计调用）,') && l.includes(String(summary30.displayChannelBytes)))
  && exportLines.some((l) => l.startsWith('汇总口径注记,')),
  'A14 CSV 表尾含双口径汇总两行 + 一行口径注记（导出件自带口径说明）')
// A14 `summary.note`（Zang 终审裁定：字段名对齐 A10 同名 + `note`）——CSV 注记行文字必须与 note **逐字一致**
const noteLine = exportLines.find((l) => l.startsWith('汇总口径注记,')) || ''
const noteCell = noteLine.slice(noteLine.indexOf(',') + 1).replace(/^"|"$/g, '')
ok(typeof export30.summary?.note === 'string' && export30.summary.note.length > 0
  && noteCell === export30.summary.note
  && export30.summary.note.includes('两口径之和'),
  'A14 summary.note 存在、含「两口径之和」口径句，且与 CSV 注记行文字逐字一致（AC-49 同一文字来源）',
  export30.summary?.note || '（无 note 字段）')
ok(Object.keys(export30.summary || {}).sort().join(',')
  === 'billableCalls,calls,detailImageBytes,displayChannelBytes,failedCalls,imageBytes,note,originalImages,rowCount',
  'A14 summary 字段集锁定：A10 同名三字段 + note（＋ calls/billableCalls/failedCalls/originalImages/rowCount）',
  Object.keys(export30.summary || {}).join(','))

// ---------------------------------------------------------------------------
// M1-P3c 用量明细页（spec §1.3 P-M1-06；06-1 ～ 06-8）的适配层依据
// ---------------------------------------------------------------------------
// ① 三维聚合齐备（AC-45）+ 展示通道分组（A11 口径）
const bdKey = await A.getUsageBreakdown({ range: '30d' }, 'key')
const bdEndpoint = await A.getUsageBreakdown({ range: '30d' }, 'endpoint')
const bdDay = await A.getUsageBreakdown({ range: '30d' }, 'day')
ok(bdKey.dim === 'key' && bdEndpoint.dim === 'endpoint' && bdDay.dim === 'day'
  && bdKey.rows.length > 0 && bdEndpoint.rows.length > 0 && bdDay.rows.length > 0,
  'AC-45 三维聚合齐备：按密钥 / 按接口 / 按日三张表都有分组返回',
  `key=${bdKey.rows.length} endpoint=${bdEndpoint.rows.length} day=${bdDay.rows.length}`)
const epDisplayRow = bdEndpoint.rows.find((r) => r.calls === 0 && r.imageBytes > 0)
ok(!!epDisplayRow,
  'A11 按接口维含展示通道分组（调用次数 0、只累计图片流量）—— 三维表须为其标注「不计调用」',
  epDisplayRow ? `${epDisplayRow.dimValue} 流量=${epDisplayRow.imageBytes}B calls=${epDisplayRow.calls}` : '未找到')
// ② 三维表双口径可相加（AC-45 页面侧可对账）：按密钥行合计 + 展示通道 = 合计；按接口行合计（含展示通道分组）= 合计
const bdKeySum = bdKey.rows.reduce((s, r) => s + r.imageBytes, 0)
const bdEndpointSum = bdEndpoint.rows.reduce((s, r) => s + r.imageBytes, 0)
ok(bdKeySum + summary30.displayChannelBytes === summary30.imageBytes && bdEndpointSum === summary30.imageBytes,
  'AC-45 三维表双口径可相加（按密钥维不含展示通道分组、按接口维含）：行合计 ＋ 展示通道 ＝ 合计',
  `keyΣ=${bdKeySum} ｜ endpointΣ=${bdEndpointSum} ｜ 展示通道=${summary30.displayChannelBytes} ｜ 合计=${summary30.imageBytes}`)
// ③ 导出文件名体现区间与筛选摘要（§7.6 命名规则）
ok(/^yinsuo-usage-.+-\d{12}-\d{8}_\d{8}_[a-z0-9_]+\.csv$/.test(export30.fileName),
  '§7.6 导出文件名形态：yinsuo-usage-<账号>-<yyyyMMddHHmm(CST)>-<区间>-<筛选摘要>.csv',
  export30.fileName)
const exportEnv = await A.exportUsage({ range: '30d', env: 'LIVE' })
const exportKeys = await A.exportUsage({ range: '30d', keys: [keys[0].kid] })
ok(exportEnv.fileName.includes('live') && exportKeys.fileName.includes('keys1'),
  '§7.6 导出文件名随筛选摘要变化（环境 / 密钥命中数进入文件名）',
  `${exportEnv.fileName} ｜ ${exportKeys.fileName}`)
// ④ 导出数据行集合 **严格等于** 当前筛选结果（AC-49 / 交互 3）：逐 traceId 与明细表（A13）对齐
const csvDataLines = export30.content.replace(/^\ufeff/, '').split('\r\n')
const csvSummaryIdx = csvDataLines.findIndex((l) => l.startsWith('汇总,'))
const csvDataRows = csvDataLines.slice(1, csvSummaryIdx < 0 ? undefined : csvSummaryIdx - 1)
const pageAll = await A.listUsageRecords({ range: '30d' }, { page: 1, pageSize: 9999 })
const csvTrace = new Set(csvDataRows.map((l) => l.split(',').pop()))
const detailTrace = new Set(pageAll.items.map((r) => String(r.traceId || '')))
ok(csvDataRows.length === export30.rowCount && csvDataRows.length === pageAll.total
  && csvTrace.size === csvDataRows.length && [...csvTrace].every((t) => detailTrace.has(t)),
  'AC-49 导出数据行集合严格等于当前筛选结果（行数与明细表逐条一致，不是全量导出）',
  `CSV ${csvDataRows.length} 行 / 明细表 total=${pageAll.total} / traceId 全命中=${[...csvTrace].every((t) => detailTrace.has(t))}`)
// ⑤ 页面侧双口径显示值必须可相加（0.01 单位整数相加；同单位同精度）
const bp = formatBytesParts(summary30.detailImageBytes, summary30.displayChannelBytes, summary30.imageBytes)
ok(bp.detailHundredths + bp.displayHundredths === bp.totalHundredths
  && bp.detail.endsWith(bp.unit) && bp.display.endsWith(bp.unit) && bp.total.endsWith(bp.unit),
  'M1-P3c 双口径三数字同单位同精度且显示值可相加（明细 ＋ 展示 ＝ 合计）',
  `${bp.detail} ＋ ${bp.display} ＝ ${bp.total}`)
ok(formatBytesExact(12345) === '12,345 字节' && formatBytesExact(0) === '0 字节',
  'M1-P3c 明细「图片字节数」为精确值（与导出 CSV 的 imageBytes 列逐字节一致）',
  `${formatBytesExact(12345)} / ${formatBytesExact(0)}`)
// AC-80：A25 / A26（展示通道）同样**不得**出现原图直链
const sealPage = await A.listSeals({}, { page: 1, pageSize: 6 })
ok(sealPage.items.every((s) => s.assets.every((a) => !('originalHighResUrl' in a)))
  && sealed.assets.every((a) => !('originalHighResUrl' in a))
  && !/\/original/.test(JSON.stringify(sealPage)),
  'AC-80 展示通道（A25/A26）不返回 originalHighResUrl（原图地址仅在 A31 校通过后签发）',
  `assets=${sealed.assets.length}`)

// A30 每日原图免费额度 + A31 主动申请原图下载（v1.3 新增、**v1.5 改口径与字段名**，§3.9/§8.2）
const policy = getOriginalQuotaPolicy()
const q0 = await A.getOriginalQuota()
ok(q0.policy === 'freeQuotaThenOverage' && q0.scopeKey === 'account'
  && q0.freePerDay === policy.freePerDay && q0.unitPriceCents === PRICING.originalImage.unitPriceCents
  && q0.usedToday === 0 && q0.freeRemainingToday === policy.freePerDay
  && q0.overageToday === 0 && q0.chargedTodayCents === 0
  && q0.timezone === 'Asia/Shanghai' && /^\d{4}-\d{2}-\d{2}$/.test(q0.cstDate)
  && q0.resetAt > new Date().toISOString(),
  'A30 免费额度快照 = {policy,scopeKey,freePerDay,unitPriceCents,usedToday,freeRemainingToday,overageToday,chargedTodayCents,resetAt,cstDate,timezone}',
  `freePerDay=${q0.freePerDay} used=${q0.usedToday} freeRemaining=${q0.freeRemainingToday} overage=${q0.overageToday}`)
ok(!('limitPerDay' in q0) && !('remainingToday' in q0) && !('mode' in q0),
  'v1.5 更名落地：旧 limitPerDay / remainingToday /（额度对象上的）mode 已退役')
ok(Object.keys(ORIGINAL_DOWNLOAD_ERROR).sort().join(',') === 'INSUFFICIENT_BALANCE,NOT_FOUND,UNAUTHENTICATED',
  'A31 拒绝码枚举三项：UNAUTHENTICATED / INSUFFICIENT_BALANCE / NOT_FOUND（v1.9 枚举级定义；DAILY_LIMIT_EXCEEDED 退役）',
  Object.values(ORIGINAL_DOWNLOAD_ERROR).join(','))
const acctBefore = await A.getAccount()
let lastFree = null
for (let i = 0; i < policy.freePerDay; i += 1) {
  lastFree = await A.requestOriginalDownload(sealed.assets[0].assetId)
}
const acctFree = await A.getAccount()
ok(lastFree.charged.freeApplied === 1 && lastFree.charged.overageCount === 0
  && lastFree.charged.overageAmountCents === 0
  && lastFree.quota.usedToday === policy.freePerDay && lastFree.quota.freeRemainingToday === 0,
  'A31 顺序①：先扣免费额度、额度内不收费',
  `freeApplied=${lastFree.charged.freeApplied} usedToday=${lastFree.quota.usedToday}`)
ok(acctFree.balanceCents === acctBefore.balanceCents,
  'A31 免费额度内余额不变', `${formatCents(acctFree.balanceCents)}`)
const charged = await A.requestOriginalDownload(sealed.assets[0].assetId)
const acctCharged = await A.getAccount()
ok(charged.charged.freeApplied === 0 && charged.charged.overageCount === 1
  && charged.charged.overageAmountCents === policy.unitPriceCents
  && charged.quota.overageToday === 1,
  'A31 顺序②：免费额度用尽后**不拒绝**，按 unitPriceCents 扣余额',
  `overageAmount=${formatCents(charged.charged.overageAmountCents)} overageToday=${charged.quota.overageToday}`)
ok(lastFree.charged.freeApplied + lastFree.charged.overageCount === 1
  && charged.charged.freeApplied + charged.charged.overageCount === 1
  && lastFree.charged.freeApplied === 1 && charged.charged.freeApplied === 0,
  'A31 `charged.freeApplied` 语义 = 本次占用免费额度张数（0/1），与 overageCount 互补',
  `额度内 ${lastFree.charged.freeApplied}+${lastFree.charged.overageCount} / 超出 ${charged.charged.freeApplied}+${charged.charged.overageCount}`)
ok(acctCharged.balanceCents === acctFree.balanceCents - policy.unitPriceCents
  && acctCharged.consistency.consistent,
  'A31 超量按 ' + formatCents(policy.unitPriceCents) + '/张 扣减且 Σ流水 = 余额 自洽',
  `${formatCents(acctFree.balanceCents)} → ${formatCents(acctCharged.balanceCents)}`)
ok(acctCharged.originalImageFreeDailyLimit === policy.freePerDay
  && acctCharged.originalImageDownloadUsedToday === policy.freePerDay + 1
  && acctCharged.originalImageFreeRemainingToday === 0
  && acctCharged.originalImageOverageToday === 1
  && acctCharged.originalImageOverageChargedTodayCents === policy.unitPriceCents,
  'A15/A30 同源：§3.10 v1.5 五个额度字段与 A30 一致（页面不自行累加/相乘，§8.3-3）')
const q1 = await A.getOriginalQuota()
ok(q1.overageToday === 1 && q1.chargedTodayCents === policy.unitPriceCents && q1.freeRemainingToday === 0,
  'A30 计费态：今日超出张数与扣费金额由适配层派生', `overage=${q1.overageToday} charged=${formatCents(q1.chargedTodayCents)}`)
const charged2 = await A.requestOriginalDownload(sealed.assets[0].assetId)
ok(charged2.charged.overageCount === 1 && charged2.quota.overageToday === 2
  && charged2.quota.chargedTodayCents === policy.unitPriceCents * 2,
  'A31 继续可下载（不设每日上限）',
  `overageToday=${charged2.quota.overageToday} charged=${formatCents(charged2.quota.chargedTodayCents)}`)

ok(url.originalUrl === undefined && lastFree.originalUrl.startsWith('about:placeholder#')
  && lastFree.originalUrlExpiresAt > new Date().toISOString(),
  'A31 成功返回单独的短期签名原图链接（展示通道不含原图 URL）', lastFree.originalUrl)

// AC-85 资源存在性校验：资源不存在 → 拒绝且**不抵扣、不扣费、不写流水**
const accountBeforeMissing = await A.getAccount()
const ledgerBeforeMissing = (await A.listLedgerEntries({}, { pageSize: 500 })).total
const missingErr = await A.requestOriginalDownload('not-exist-asset').then(() => null).catch((e) => e)
const quotaAfterMissing = await A.getOriginalQuota()
const accountAfterMissing = await A.getAccount()
const ledgerAfterMissing = (await A.listLedgerEntries({}, { pageSize: 500 })).total
ok(missingErr?.code === ORIGINAL_DOWNLOAD_ERROR.NOT_FOUND
  && quotaAfterMissing.usedToday === policy.freePerDay + 2
  && accountAfterMissing.originalImageDownloadUsedToday === policy.freePerDay + 2
  && accountAfterMissing.balanceCents === accountBeforeMissing.balanceCents
  && ledgerAfterMissing === ledgerBeforeMissing,
  'AC-85 资源不存在 → 拒绝（NOT_FOUND）且不抵扣、不扣费、不写流水',
  `usedToday=${quotaAfterMissing.usedToday}（不变）余额 ${formatCents(accountAfterMissing.balanceCents)}（不变）`
  + ` 流水条数 ${ledgerBeforeMissing} → ${ledgerAfterMissing}`)
ok(!(await A.listLedgerEntries({}, { pageSize: 500 })).items.some((e) => e.relatedAssetId === 'not-exist-asset'),
  'AC-85 不存在资源的 ORIGINAL_IMAGE 流水零写入（relatedAssetId 无悬挂引用）')

// A28/A29
const app1 = await A.submitDemoApplication({ orgName: '（演示）冒烟机构', email: 'smoke@yinsuo.example' })
const app2 = await A.submitDemoApplication({ orgName: '（演示）冒烟机构', email: 'smoke@yinsuo.example' })
ok(app1.duplicated === false && app2.duplicated === true && /^DEMO-\d{8}-\d{4}$/.test(app1.applicationId), 'A28 首次受理 + 同邮箱重复提交判重', app1.applicationId)
const faq = await A.listFaq()
const dl = await A.listDownloads()
ok(faq.length === 12 && dl.length === 6, 'A29 FAQ 12 条 / 资料包 6 项（§11 待决 17、15）', `faq=${faq.length} downloads=${dl.length}`)

// A4 退出
await A.logout()
ok((await A.getSession()) === null, 'A4 logout 清空会话')
const unauthErr = await A.requestOriginalDownload(sealed.assets[0].assetId).then(() => null).catch((e) => e)
ok(unauthErr?.code === 'UNAUTHENTICATED', 'A31 未登录 → reject UNAUTHENTICATED（R17b）', unauthErr?.message || '')
const quotaUnauthErr = await A.getOriginalQuota().then(() => null).catch((e) => e)
ok(quotaUnauthErr?.code === 'UNAUTHENTICATED',
  'A30 未登录 → reject UNAUTHENTICATED（额度为账号维度数据，Zang 终审）', quotaUnauthErr?.message || '')
ok(ORIGINAL_DOWNLOAD_ERROR.UNAUTHENTICATED === quotaUnauthErr?.code
  && ORIGINAL_DOWNLOAD_ERROR.UNAUTHENTICATED === unauthErr?.code,
  'A30/A31 复用同一拒绝码枚举（contract.ORIGINAL_DOWNLOAD_ERROR）')
const quotaAfterLogout = await A.getOriginalQuota().then((q) => q).catch(() => null)
ok(quotaAfterLogout === null, 'A30 未登录时**不**返回额度快照（不泄露账号维度数据）')

const fails = out.filter((l) => l.startsWith('✗'))
log('')
log(fails.length ? `✗ 失败 ${fails.length} 项 / 共 ${out.length} 项` : `✓ 全部通过（${out.length - 1} 项断言）`)
console.log(out.join('\n'))
process.exit(fails.length ? 1 : 0)
