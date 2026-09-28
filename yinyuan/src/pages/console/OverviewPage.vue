<template>
  <ConsoleShell crumb="控制台 / 概览" spec-ref="P-M1-04">
    <NoticeBar v-if="justOpened" variant="banner">
      <b>开通成功</b> —— 机构账号已自动开通（演示态），可自助生成 API 密钥并开始调用。
    </NoticeBar>

    <!-- ===================== KPI 卡 ×4 ===================== -->
    <StateBlock
      :state="account.state.value"
      empty-title="暂无账户数据"
      empty-text="新注册空账号：各卡片显示零值，不显示占位假数字"
      error-text="读取账户失败"
      @retry="load"
    >
      <div v-if="acct" class="kpis">
        <div class="kpi">
          <label>本月调用次数</label>
          <b>{{ formatCalls(acct.quotaUsedCalls) }}<em>/ 包量 {{ formatCalls(acct.quotaTotalCalls) }}</em></b>
          <div class="note">{{ acct.monthKey }}（CST）· 余 {{ formatCalls(acct.quotaRemainCalls) }}</div>
        </div>

        <div class="kpi">
          <label>本月高清原图</label>
          <b>{{ acct.originalImageUsedThisMonth }}<em>张</em></b>
          <div class="note">
            <template v-if="quota.state.value === 'ready' && quota.data.value">
              <span>今日免费额度 {{ quota.data.value.freePerDay }} 张 · 今日已下载 {{ quota.data.value.usedToday }} 张</span>
              <template v-if="quota.data.value.overageToday > 0">
                <span class="kpi-strong">
                  （其中超出免费额度 {{ quota.data.value.overageToday }} 张，已扣 {{ formatCents(quota.data.value.chargedTodayCents) }}）
                </span>
              </template>
              <span> · 免费剩余 {{ quota.data.value.freeRemainingToday }} 张</span>
              <span> · 重置 {{ toCstDateTime(quota.data.value.resetAt) }}</span>
              <span>
                · 额度内不计费；超出部分按 {{ formatCents(quota.data.value.unitPriceCents) }}/张 从余额扣减
              </span>
            </template>
            <template v-else-if="quota.state.value === 'loading'">今日原图额度读取中…</template>
            <template v-else>
              今日原图额度暂不可读（额度为账号维度数据，需登录后查询）
              <button class="btn ghost sm" type="button" @click="quota.run()">重试</button>
            </template>
          </div>
        </div>

        <div class="kpi">
          <label>本月图片流量</label>
          <b>{{ bytesParts ? bytesParts.total : '—' }}</b>
          <div v-if="bytesParts" class="note">
            <span>明细行合计 {{ bytesParts.detail }}</span>
            <span> ＋ 展示通道 {{ bytesParts.display }}（不计调用次数）</span>
            <span> ＝ 合计 {{ bytesParts.total }}</span>
          </div>
          <div v-else class="note">读取中…</div>
        </div>

        <div class="kpi">
          <label>账户余额</label>
          <b>{{ formatCents(acct.balanceCents) }}</b>
          <div class="note">
            Σ流水 = 余额 自检
            <span :class="acct.consistency?.consistent ? 'state' : 'state warn'">
              {{ acct.consistency?.consistent ? '通过' : '不一致' }}
            </span>
          </div>
        </div>
      </div>
    </StateBlock>

    <!-- ===================== 月额度余量条 ===================== -->
    <div v-if="acct" class="card" style="margin-top:16px;">
      <div class="block-head" style="margin-bottom:8px;">
        <h3 style="margin-bottom:0;">月额度余量</h3>
        <span class="rule"></span>
        <span class="tag pending">数据为示例</span>
      </div>
      <div class="meter" role="progressbar" :aria-valuenow="quotaPercent" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: quotaPercent + '%' }"></i>
      </div>
      <p class="note" style="margin-top:10px;">
        本月包量 {{ formatCalls(acct.quotaTotalCalls) }}，已用 {{ formatCalls(acct.quotaUsedCalls) }}，
        余 {{ formatCalls(acct.quotaRemainCalls) }}；包量不跨月结转（每月 1 日 00:00 CST 重置包量）。
      </p>
    </div>

    <!-- ===================== 趋势图 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>调用趋势</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
      <div class="mini-seg" role="tablist" aria-label="趋势时间范围">
        <button
          v-for="opt in RANGE_OPTIONS"
          :key="opt.value"
          type="button"
          role="tab"
          :class="{ 'is-active': range === opt.value }"
          :aria-selected="range === opt.value"
          @click="setRange(opt.value)"
        >{{ opt.label }}</button>
      </div>
    </div>

    <StateBlock
      :state="trend.state.value"
      empty-title="当前区间暂无调用"
      empty-text="该区间没有调用记录，图表不做假填充"
      error-text="读取趋势失败"
      @retry="loadRange"
    >
      <div class="chart-card">
        <svg class="chart-svg" viewBox="0 0 760 210" role="img" :aria-label="trendAria">
          <line
            v-for="t in trendChart.ticks"
            :key="'g' + t.ratio"
            class="grid"
            :x1="trendChart.plotLeft"
            :x2="trendChart.plotRight"
            :y1="t.y"
            :y2="t.y"
          />
          <text v-for="t in trendChart.ticks" :key="'t' + t.ratio" class="axis-text" :x="trendChart.plotLeft - 6" :y="t.y + 3" text-anchor="end">{{ t.value }}</text>
          <g v-for="bar in trendChart.bars" :key="bar.key">
            <rect class="trend-bar" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h">
              <title>{{ bar.key }}：调用 {{ bar.calls }} 次</title>
            </rect>
          </g>
          <text v-for="bar in trendChart.xLabels" :key="'x' + bar.key" class="axis-text" :x="bar.x + bar.w / 2" :y="trendChart.plotBottom + 14" text-anchor="middle">{{ bar.label }}</text>
        </svg>
        <p class="note">
          柱高 = 该{{ trendRange.unit }}调用次数（口径＝调用次数，不含展示切片流量）；
          X 轴刻度 = 筛选窗口覆盖的 CST 自然{{ trendRange.unit }}（{{ trendRange.spanNote }}），
          无记录的时间桶显示零值。区间合计 {{ formatCalls(trendChart.total) }}，
          与下方「调用占比」同源同区间；「本月」口径的 KPI 与图表区间不同属正常差异。
        </p>
      </div>
    </StateBlock>

    <!-- ===================== 分布图 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>调用占比（按接口）· {{ trendRange.label }}</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
    </div>

    <StateBlock
      :state="byEndpoint.state.value"
      empty-title="当前区间暂无调用"
      empty-text="该区间没有调用记录，不显示占比残骸"
      error-text="读取接口分布失败"
      @retry="loadRange"
    >
      <div v-if="donut.slices.length" class="chart-card dist-flex">
        <svg class="donut" viewBox="0 0 160 160" role="img" :aria-label="donutAria">
          <circle cx="80" cy="80" r="54" fill="none" stroke="var(--meter-track)" stroke-width="18" />
          <circle
            v-for="arc in donut.slices"
            :key="arc.key"
            :class="'c' + arc.colorIndex"
            cx="80"
            cy="80"
            r="54"
            fill="none"
            stroke-width="18"
            transform="rotate(-90 80 80)"
            :stroke-dasharray="arc.dash"
            :stroke-dashoffset="arc.offset"
          >
            <title>{{ arc.key }}：调用 {{ arc.calls }} 次（{{ arc.percent }}%）</title>
          </circle>
          <text class="donut-center" x="80" y="78" text-anchor="middle">{{ donut.totalCalls }}</text>
          <text class="donut-caption" x="80" y="94" text-anchor="middle">调用次数</text>
        </svg>
        <ul class="legend">
          <li v-for="arc in donut.slices" :key="'l' + arc.key">
            <i :class="'dot c' + arc.colorIndex" aria-hidden="true"></i>
            <span class="mono">{{ arc.key }}</span>
            <b>{{ arc.calls }} 次</b>
            <em>{{ arc.percent }}%</em>
          </li>
        </ul>
      </div>
      <p class="note">
        占比分母为区间内「调用次数」合计（占比按接口聚合）；
        <b>展示通道（切片）只计图片流量、不计调用次数</b>，故其分组调用次数为 0、不进入调用占比，
        该部分流量计入上方「本月图片流量」的展示通道口径。
      </p>
    </StateBlock>

    <div class="block-head" style="margin-top:22px;">
      <h3>调用占比（按密钥）· {{ trendRange.label }}</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
    </div>

    <StateBlock
      :state="byKey.state.value"
      empty-title="当前区间暂无调用"
      empty-text="该区间没有调用记录"
      error-text="读取密钥分布失败"
      @retry="loadRange"
    >
      <div class="chart-card">
        <div v-for="row in keyDistribution" :key="row.dimValue" class="dist-row">
          <span class="dist-label mono">{{ row.label }}</span>
          <span class="dist-track"><i :style="{ width: row.percent + '%' }"></i></span>
          <span class="dist-val">{{ row.calls }} 次 · {{ row.percent }}%</span>
        </div>
      </div>
    </StateBlock>

    <!-- ===================== 密钥摘要 + 账单摘要 ===================== -->
    <div class="grid-2" style="margin-top:22px;">
      <div>
        <div class="block-head">
          <h3>密钥摘要</h3><span class="rule"></span>
          <span class="tag pending">数据为示例</span>
        </div>
        <StateBlock
          :state="keys.state.value"
          empty-title="尚无密钥"
          empty-text="新账号没有密钥：点击「新建密钥」自助生成"
          error-text="读取密钥失败"
          @retry="keys.run"
        >
          <div class="card kpi-flat">
            <p class="note">密钥数量 <b>{{ keySummary.total }}</b> 个 · 当前启用 <b>{{ keySummary.active }}</b> 个</p>
            <p class="note">最近一次调用：{{ keySummary.lastUsed ? toCstDateTime(keySummary.lastUsed) : '—' }}</p>
            <div class="modal-acts" style="justify-content:flex-start;margin-top:12px;">
              <router-link class="btn ghost sm" to="/console/keys">前往密钥管理</router-link>
            </div>
          </div>
        </StateBlock>
      </div>

      <div>
        <div class="block-head">
          <h3>账单摘要 · 最近 3 条</h3><span class="rule"></span>
          <span class="tag pending">数据为示例</span>
        </div>
        <StateBlock
          :state="ledger.state.value"
          empty-title="暂无流水"
          empty-text="尚无账单流水记录"
          error-text="读取流水失败"
          @retry="load"
        >
          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr><th>时间（CST）</th><th>类型</th><th>金额 / 次数</th><th>余额快照</th></tr>
              </thead>
              <tbody>
                <tr v-for="entry in recentLedger" :key="entry.entryId">
                  <td>{{ toCstDateTime(entry.occurredAt) }}</td>
                  <td>{{ ledgerTypeLabel(entry.type) }}</td>
                  <td>
                    <template v-if="entry.amountCents">{{ formatCents(entry.amountCents) }}</template>
                    <template v-else>{{ entry.callCount }} 次</template>
                  </td>
                  <td>{{ formatCents(entry.balanceAfterCents) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="modal-acts" style="justify-content:flex-start;margin-top:12px;">
              <router-link class="btn ghost sm" to="/console/billing">查看全部流水</router-link>
            </div>
          </div>
        </StateBlock>
      </div>
    </div>

    <!-- ===================== 快捷动作 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>快捷动作</h3><span class="rule"></span>
    </div>
    <div class="modal-acts" style="justify-content:flex-start;">
      <router-link class="btn sm" to="/console/keys">新建密钥</router-link>
      <router-link class="btn ghost sm" to="/console/billing">去充值</router-link>
      <button class="btn ghost sm" type="button" :aria-busy="exporting" :aria-disabled="exporting" @click="exportCsv">
        {{ exporting ? '导出中…' : '导出用量明细' }}
      </button>
      <EntryLink class="btn ghost sm" to="/pricing">查看计费规则</EntryLink>
    </div>

    <!-- ===================== 声明条 ===================== -->
    <NoticeBar variant="status" style="margin-top:22px;">
      <b>声明</b> —— {{ disclaimer }}；本页数字均来自统一数据源（无页面硬编码），
      时间均为北京时间（CST）；展示切片为辅助防护手段，无法阻止专业爬虫抓取切片后拼接，
      原图访问权限完全由后端鉴权控制（CDN 签名 URL + 账号额度）。
    </NoticeBar>
  </ConsoleShell>
</template>

<script setup>
/**
 * 控制台概览（spec §1.3 P-M1-04）—— 要素 04-1 ～ 04-9 闭合清单。
 *
 * 数据来源（一律经适配层 `@/data`，页面零硬编码）：
 *  - 04-2 KPI ×4：A15 `getAccount`（调用次数 / 原图 / 余额）＋ A30 `getOriginalQuota`（今日原图额度）
 *                 ＋ A10 `getUsageSummary`（本月图片流量，**双口径**）；
 *  - 04-3 趋势图：A12 `getUsageTrend`（30 日 / 12 月切换，轴刻度由 `recentCstBuckets` 提供）；
 *  - 04-4 分布图：A11 `getUsageBreakdown`（按接口环形 / 按密钥横条）；
 *  - 04-6 密钥摘要：A5 `listApiKeys`；04-7 账单摘要：A24 `listLedgerEntries`；
 *  - 04-8 导出：A14 `exportUsage`（CSV 汇总双口径＋口径注记，见 §7.6）。
 *
 * 图表为**内联 SVG + CSS 手绘**，未引入任何第三方图表库（零依赖原则）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConsoleShell from '@/components/ConsoleShell.vue'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import StateBlock from '@/components/StateBlock.vue'
import {
  exportUsage, getAccount, getOriginalQuota, getPricingTable, getUsageBreakdown,
  getUsageSummary, getUsageTrend, listApiKeys, listLedgerEntries, recentCstBuckets, toCstDateTime,
} from '@/data'
import { formatBytesParts, formatCalls, formatCents } from '@/config/pricing.js'
import { ledgerTypeLabel } from '@/config/labels.js'
import { useAsync } from '@/composables/useAsync.js'
import { toast } from '@/composables/useToast.js'

const route = useRoute()
const router = useRouter()

/** 一次性开通提示：仅由注册成功跳转带来的标记触发。 */
const justOpened = ref(route.query.opened === '1')

// ---------------------------------------------------------------------------
// 数据读取（每个模块独立三态：加载 / 空 / 错误，§1.6）
// ---------------------------------------------------------------------------
const account = useAsync(getAccount)                                  // A15
const quota = useAsync(getOriginalQuota)                              // A30（未登录会 reject UNAUTHENTICATED → 空态）
const monthSummary = useAsync((filter) => getUsageSummary(filter))    // A10（本月，双口径）
const trend = useAsync((filter, bucket) => getUsageTrend(filter, bucket)) // A12
const byEndpoint = useAsync((filter, dim) => getUsageBreakdown(filter, dim)) // A11 endpoint
const byKey = useAsync((filter, dim) => getUsageBreakdown(filter, dim))      // A11 key
const keys = useAsync(listApiKeys)                                    // A5
const ledger = useAsync((filter, page) => listLedgerEntries(filter, page))   // A24

/** 时间范围切换：仅重算图表（交互 2：切换不刷新整页）。
 *
 * 轴桶数说明：适配层时间窗口为**滚动小时数**（30 日 = 720 小时、12 月 = 365 日），
 * 该窗口跨越的 CST 自然日/月**最多比标称多一个**（首日为/首月为部分区间），
 * 故轴取 31 桶 / 13 桶 —— 使「柱图区间合计」与 A11 调用占比（同一筛选区间）**逐项对得上**，
 * 不让对客出现两个无法对账的「区间合计」（§7.5 归属按 CST 自然日）。
 */
const RANGE_OPTIONS = [
  { value: '30d', label: '近 30 日', bucket: 'day', buckets: 31, unit: '日', spanNote: '滚动的近 30 日窗口最多跨 31 个 CST 自然日，故首日为部分日' },
  { value: '12m', label: '近 12 月', bucket: 'month', buckets: 13, unit: '月', spanNote: '滚动的近 12 月窗口最多跨 13 个 CST 自然月，故首月为部分月' },
]
const range = ref(RANGE_OPTIONS[0].value)
const exporting = ref(false)

const acct = computed(() => account.data.value)
const monthImages = computed(() => monthSummary.data.value)
/**
 * 04-2 图片流量**双口径**显示三元组（D3 修复）：三数字同单位、同精度，且**合计 = 两个显示值之和**，
 * 屏幕上的「明细 ＋ 展示 ＝ 合计」因此可相加（不再出现 4.3 + 2.5 = 6.7）。
 */
const bytesParts = computed(() => {
  const data = monthImages.value
  if (!data) return null
  return formatBytesParts(data.detailImageBytes, data.displayChannelBytes, data.imageBytes)
})
const recentLedger = computed(() => (ledger.data.value?.items || []).slice(0, 3))
const trendRange = computed(() => RANGE_OPTIONS.find((o) => o.value === range.value) || RANGE_OPTIONS[0])

const quotaPercent = computed(() => {
  const data = acct.value
  if (!data?.quotaTotalCalls) return 0
  const used = Math.max(0, Math.min(data.quotaTotalCalls, data.quotaUsedCalls))
  return Math.round((used / data.quotaTotalCalls) * 100)
})

const keySummary = computed(() => {
  const list = Array.isArray(keys.data.value) ? keys.data.value : []
  const active = list.filter((k) => k.status === 'ACTIVE').length
  const lastUsed = list.map((k) => k.lastUsedAt).filter(Boolean).sort().pop() || null
  return { total: list.length, active, lastUsed }
})

// ---------------------------------------------------------------------------
// 04-3 趋势图（内联 SVG，坐标全部由适配层数据派生）
// ---------------------------------------------------------------------------
const CHART = { w: 760, h: 210, padL: 48, padR: 16, padT: 12, padB: 28 }
const TICK_RATIOS = [0, 1 / 4, 1 / 2, 3 / 4, 1]

const trendChart = computed(() => {
  const spec = trendRange.value
  const seriesMap = new Map((trend.data.value?.series || []).map((s) => [s.bucket, s]))
  const buckets = recentCstBuckets(spec.bucket, spec.buckets)
  const points = buckets.map((key) => {
    const hit = seriesMap.get(key)
    return { key, label: key.slice(5), calls: hit ? hit.calls : 0, imageBytes: hit ? hit.imageBytes : 0 }
  })
  const rawMax = Math.max(1, ...points.map((p) => p.calls))
  /** Y 轴上界取整到 5 的倍数（留 5% 余量），刻度值一律为整数，避免出现 7/13 这类「半个刻度」标签。 */
  const niceMax = Math.max(1, Math.ceil((rawMax * 105) / 100 / 5) * 5)
  const max = niceMax
  const plotH = CHART.h - CHART.padT - CHART.padB
  const plotLeft = CHART.padL
  const plotRight = CHART.w - CHART.padR
  const step = (plotRight - plotLeft) / points.length
  const barW = Math.max(2, (step * 62) / 100)
  const bars = points.map((p, i) => {
    const h = (p.calls / max) * plotH
    return {
      ...p,
      x: plotLeft + i * step + (step - barW) / 2,
      y: CHART.padT + plotH - h,
      w: barW,
      h: Math.max(p.calls > 0 ? 1 : 0, h),
    }
  })
  const ticks = TICK_RATIOS.map((ratio) => ({
    ratio,
    y: CHART.padT + plotH - ratio * plotH,
    value: Math.round(max * ratio),
  }))
  const labelEvery = points.length > 14 ? 5 : 1
  return {
    bars,
    ticks,
    plotLeft,
    plotRight,
    plotBottom: CHART.padT + plotH,
    xLabels: bars.filter((_, i) => i % labelEvery === 0),
    max,
    peak: rawMax,
    total: points.reduce((s, p) => s + p.calls, 0),
    days: points.filter((p) => p.calls > 0).length,
  }
})

const trendAria = computed(() => {
  const c = trendChart.value
  return `${trendRange.value.label}调用量柱图：单${trendRange.value.unit}最高 ${c.peak} 次，区间合计 ${c.total} 次，`
    + `有记录的桶 ${c.days} 个 / 共 ${c.bars.length} 个`
})

// ---------------------------------------------------------------------------
// 04-4 分布图（按接口：内联 SVG 环形；按密钥：CSS 横条）
// ---------------------------------------------------------------------------
const DONUT = { r: 54, cx: 80, cy: 80 }
/** 调色板长度（scoped 样式 `.c0`～`.c4`，颜色全部取自已冻结 tokens）。 */
const DONUT_PALETTE = 5
/** 单环最多直接展示的分组数：其余归入「其他」，保证切片数 = 调色板长度。 */
const DONUT_TOP = DONUT_PALETTE - 1

const donut = computed(() => {
  const rows = (byEndpoint.data.value?.rows || []).filter((r) => r.calls > 0)
  const sorted = [...rows].sort((a, b) => b.calls - a.calls)
  const top = sorted.slice(0, DONUT_TOP)
  const rest = sorted.slice(DONUT_TOP)
  /** 「其他」并入后**按次数降序重排**：配色随大小分布（最大切片取最深色），图例与环序一致。 */
  const slices = (rest.length
    ? [...top, {
      dimValue: '其他',
      label: '其他接口',
      calls: rest.reduce((s, r) => s + r.calls, 0),
      share: rest.reduce((s, r) => s + r.share, 0),
    }]
    : top).sort((a, b) => b.calls - a.calls)
  const totalCalls = sorted.reduce((s, r) => s + r.calls, 0)
  const circumference = 2 * Math.PI * DONUT.r
  let passed = 0
  const arcs = slices.map((row, i) => {
    const share = totalCalls ? row.calls / totalCalls : 0
    const arc = {
      key: row.dimValue,
      calls: row.calls,
      percent: (share * 100).toFixed(1),
      colorIndex: i % DONUT_PALETTE,
      dash: `${(share * circumference).toFixed(2)} ${(circumference * (1 - share)).toFixed(2)}`,
      offset: (-passed * circumference).toFixed(2),
    }
    passed += share
    return arc
  })
  return { slices: arcs, totalCalls }
})

const donutAria = computed(() => {
  const d = donut.value
  return `按接口调用占比环形图：共 ${d.slices.length} 组 —— `
    + d.slices.map((s) => `${s.key} ${s.percent}%`).join('，')
})

const keyDistribution = computed(() => {
  const rows = byKey.data.value?.rows || []
  const total = rows.reduce((s, r) => s + r.calls, 0)
  return rows.map((r) => ({
    dimValue: r.dimValue,
    label: r.label || r.dimValue,
    calls: r.calls,
    percent: total ? Math.round((r.calls / total) * 1000) / 10 : 0,
  }))
})

// ---------------------------------------------------------------------------
// 读取与交互
// ---------------------------------------------------------------------------
function loadRange() {
  const filter = { range: range.value }
  return Promise.all([
    trend.run(filter, trendRange.value.bucket),
    byEndpoint.run(filter, 'endpoint'),
    byKey.run(filter, 'key'),
  ])
}

async function load() {
  await Promise.all([
    account.run(),
    quota.run(),
    monthSummary.run({ range: 'month' }),
    keys.run(),
    ledger.run({}, { page: 1, pageSize: 3 }),
    loadRange(),
  ])
}

function setRange(value) {
  if (range.value === value) return
  range.value = value
  loadRange()
}

/** 04-8「导出用量明细」：A14 CSV（汇总双口径＋口径注记），成功 / 失败均提示（交互 4）。 */
async function exportCsv() {
  if (exporting.value) return
  exporting.value = true
  try {
    const result = await exportUsage({ range: range.value })
    const blob = new Blob([result.content], { type: result.mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast(`导出成功：${result.fileName}（${result.rowCount} 行，含双口径汇总与口径注记）`)
  } catch (e) {
    toast(`导出失败：${e?.message || '演示环境数据源不可用'}`)
  } finally {
    exporting.value = false
  }
}

/** 04-9 声明条文案：首选 A17 `getPricingTable().disclaimer`（唯一配置源），失败时回落同级默认声明。 */
const DEFAULT_DISCLAIMER = '本页金额、单价、用量数字均为界面示意值，非报价'
const disclaimer = ref(DEFAULT_DISCLAIMER)

onMounted(async () => {
  // 声明文案与数据同源（A17），读取失败不阻塞主流程
  getPricingTable()
    .then((table) => { if (table?.disclaimer) disclaimer.value = table.disclaimer })
    .catch(() => {})
  await load()
  // 一次性提示：展示后即从网址移除标记，刷新 / 回退不重复提示。
  if (justOpened.value) {
    const query = { ...route.query }
    delete query.opened
    router.replace({ name: 'console-overview', query })
  }
})
</script>

<style scoped>
.kpi .note { font-size: var(--fs-12); color: var(--faint); line-height: 1.65; margin-top: 6px; }
.kpi .note span { display: inline; }
.kpi-strong { color: var(--brand); }
.kpi-flat { padding: var(--sp-8) var(--sp-9); }
.kpi-flat b { color: var(--brand); }

.chart-card {
  border: var(--border);
  border-radius: var(--radius);
  background: var(--card);
  padding: var(--sp-9) var(--sp-10) var(--sp-7);
}
.chart-svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--line); stroke-width: 1; }
.axis-text { fill: var(--faint); font-size: 10px; }
.trend-bar { fill: var(--chart-1); stroke: var(--chart-1); stroke-width: 1; }
.trend-bar:hover { fill: var(--chart-3); }

.dist-flex { display: flex; gap: var(--sp-12); align-items: center; flex-wrap: wrap; }
.donut { width: 190px; height: 190px; flex: 0 0 auto; }
.donut-center { fill: var(--ink); font-size: 22px; }
.donut-caption { fill: var(--faint); font-size: 9px; }
.legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 260px; }
.legend li {
  display: flex; align-items: baseline; gap: var(--sp-4);
  font-size: var(--fs-13); color: var(--ink-2); padding: 5px 0; border-bottom: var(--border);
}
.legend li:last-child { border-bottom: 0; }
.legend li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend li b { font-weight: normal; color: var(--ink); }
.legend li em { font-style: normal; color: var(--faint); min-width: 46px; text-align: right; }
.legend .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }

/**
 * 图表配色一律引用**专用图表色板** `--chart-1…5`（spec §1.8-10 token 用途纪律；
 * 不得借用 `--brand-line` 等槽位专用 token）。
 *
 * **D1 修复（环形图末片与轨道不可区分）**：原第 5 片用 `--brand-line #f0e2e2`，
 * 对轨道 `--meter-track #efebe3` 仅 1.06:1，目视读作 4 片。现改用专用色板的 5 色，
 * 每片对轨道实测对比度：--chart-1 6.777 / --chart-2 5.216 / --chart-3 6.270 /
 * --chart-4 13.382 / --chart-5 4.470（最差 4.470 ≥ 3，符合 §1.8-9 / AC-87）；
 * 相邻切片在「色相 + 亮度」两个维度上均拉开（详见 tokens.css 图表色板块注）。
 */
.c0 { stroke: var(--chart-1); background: var(--chart-1); }
.c1 { stroke: var(--chart-2); background: var(--chart-2); }
.c2 { stroke: var(--chart-3); background: var(--chart-3); }
.c3 { stroke: var(--chart-4); background: var(--chart-4); }
.c4 { stroke: var(--chart-5); background: var(--chart-5); }

.dist-row {
  display: grid; grid-template-columns: minmax(120px, 220px) 1fr 130px;
  gap: var(--sp-5); align-items: center; font-size: var(--fs-13); padding: 5px 0;
}
.dist-label { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dist-track { height: 10px; background: var(--meter-track); border-radius: var(--radius-sm); overflow: hidden; }
.dist-track i { display: block; height: 100%; background: var(--chart-1); }
.dist-val { color: var(--faint); text-align: right; }
</style>
