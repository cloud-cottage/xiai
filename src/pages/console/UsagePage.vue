<template>
  <ConsoleShell crumb="控制台 / 用量明细">
    <!-- ===================== 06-8 声明条 ===================== -->
    <NoticeBar variant="status">
      <b>用量数据为界面示意值</b> —— 本页汇总、聚合、趋势、明细与导出均来自同一套筛选条件，
      页面自身即可对账；导出件与本页逐项一致。数据为示例，时间均为北京时间（CST）。
      筛选状态固化在网址里，可复制链接分享或收藏。
    </NoticeBar>

    <!-- ===================== 06-1 筛选器组 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>筛选条件</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
    </div>

    <section class="card filter-card" aria-label="用量筛选条件">
      <div class="frow">
        <span class="frow-label">时间范围</span>
        <SegmentedControl
          v-model="range"
          variant="chips"
          aria-label="时间范围"
          :options="RANGE_OPTIONS"
          @change="onFilterChange"
        />
        <span class="note">{{ rangeNote }}</span>
      </div>

      <div v-if="range === 'custom'" class="frow">
        <span class="frow-label">自定义区间</span>
        <label class="sr-inline" for="usage-from">起</label>
        <input id="usage-from" v-model="customFrom" type="date" class="date-input" />
        <label class="sr-inline" for="usage-to">止</label>
        <input id="usage-to" v-model="customTo" type="date" class="date-input" />
        <button class="btn sm" type="button" @click="applyCustom">应用区间</button>
        <span class="note">按北京时间自然日整段取（起日 00:00:00 至止日 23:59:59）</span>
      </div>

      <div class="frow">
        <span class="frow-label">密钥</span>
        <div class="chips" role="group" aria-label="密钥（多选）">
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': filters.keys.length === 0 }"
            :aria-pressed="String(filters.keys.length === 0)"
            @click="setKeys([])"
          >全部密钥</button>
          <button
            v-for="opt in keyOptions"
            :key="opt.kid"
            type="button"
            class="chip"
            :class="{ 'is-active': filters.keys.includes(opt.kid) }"
            :aria-pressed="String(filters.keys.includes(opt.kid))"
            @click="toggleKey(opt.kid)"
          >{{ opt.label }} <span class="mono">{{ opt.kid }}</span></button>
        </div>
        <span v-if="!keyOptions.length" class="note">当前账号还没有密钥</span>
      </div>

      <div class="frow">
        <span class="frow-label">接口</span>
        <div class="chips" role="group" aria-label="接口（多选）">
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': filters.endpoints.length === 0 }"
            :aria-pressed="String(filters.endpoints.length === 0)"
            @click="setEndpoints([])"
          >全部接口</button>
          <button
            v-for="ep in endpointOptions"
            :key="ep"
            type="button"
            class="chip"
            :class="{ 'is-active': filters.endpoints.includes(ep) }"
            :aria-pressed="String(filters.endpoints.includes(ep))"
            @click="toggleEndpoint(ep)"
          ><span class="mono">{{ ep }}</span></button>
        </div>
        <span class="note">接口按路由模板归组：同一路径的不同参数合并为一组</span>
      </div>

      <div class="frow">
        <span class="frow-label">环境</span>
        <SegmentedControl v-model="env" variant="chips" aria-label="环境" :options="ENV_OPTIONS" @change="onFilterChange" />
        <button class="btn ghost sm" type="button" @click="resetFilters">重置筛选</button>
      </div>

      <p class="note filter-link">
        可复制的筛选链接：<code class="mono">{{ shareLink }}</code>
      </p>
    </section>

    <!-- ===================== 06-2 汇总条（双口径） ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>区间汇总 · {{ rangeLabel }}</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
      <button
        class="btn ghost sm"
        type="button"
        :aria-expanded="String(drawerOpen)"
        aria-controls="caliber-drawer"
        @click="drawerOpen = !drawerOpen"
      >{{ drawerOpen ? '收起口径说明' : '口径说明' }}</button>
    </div>

    <StateBlock
      :state="summaryState"
      loading-text="正在按筛选条件重算汇总…"
      empty-title="当前筛选无数据"
      empty-text="该筛选区间没有任何调用记录，汇总不显示占位假数字"
      error-text="读取用量汇总失败"
      @retry="reload"
    >
      <div v-if="summaryData" class="kpis">
        <div class="kpi">
          <label>调用次数</label>
          <b>{{ formatCalls(summaryData.calls) }}</b>
          <div class="note">区间内全部请求，含失败请求</div>
        </div>
        <div class="kpi">
          <label>计费调用</label>
          <b>{{ formatCalls(summaryData.billableCalls) }}</b>
          <div class="note">已鉴权且返回成功；失败请求不计费</div>
        </div>
        <div class="kpi">
          <label>高清原图张数</label>
          <b>{{ summaryData.originalImages }}<em>张</em></b>
          <div class="note">按张单独计价，不占月包量</div>
        </div>
        <div class="kpi">
          <label>失败请求数</label>
          <b>{{ formatCalls(summaryData.failedCalls) }}</b>
          <div class="note">不计费，单列以便与计费调用区分</div>
        </div>
      </div>

      <div v-if="parts" class="caliber" aria-label="图片流量双口径">
        <h4>图片流量（双口径）</h4>
        <div class="caliber-row">
          <div class="caliber-cell" data-figure="detail">
            <span class="caliber-label">明细行合计</span>
            <b>{{ parts.detail }}</b>
            <span class="note">逐条调用记录的图片字节数之和</span>
          </div>
          <span class="caliber-op" aria-hidden="true">＋</span>
          <div class="caliber-cell" data-figure="display">
            <span class="caliber-label">展示通道流量（不计调用）</span>
            <b>{{ parts.display }}</b>
            <span class="note">展示切片只计图片流量、不计调用次数</span>
          </div>
          <span class="caliber-op" aria-hidden="true">＝</span>
          <div class="caliber-cell is-total" data-figure="total">
            <span class="caliber-label">合计</span>
            <b>{{ parts.total }}</b>
            <span class="note">汇总图片流量口径</span>
          </div>
        </div>
        <p class="note" data-check="caliber-sum">
          {{ parts.detail }} ＋ {{ parts.display }} ＝ {{ parts.total }} —— {{ sumCheck ? '两口径之和与合计一致，对账通过' : '两口径之和不等于合计，请重试' }}。
        </p>
        <p v-if="exportMatch" class="note" data-check="export-match">
          导出件汇总与本页汇总逐项一致（明细行合计 / 展示通道流量 / 合计三项均相等）。
        </p>
        <p v-else-if="exportMatch === false" class="note warn-text" data-check="export-match">
          导出件汇总与本页汇总不一致，请重试导出。
        </p>
      </div>
    </StateBlock>

    <!-- ===================== 06-7 口径说明抽屉 ===================== -->
    <aside v-show="drawerOpen" id="caliber-drawer" class="drawer" aria-label="统计口径说明">
      <h4>统计口径说明</h4>
      <dl class="caliber-list">
        <dt>计费调用</dt>
        <dd>已鉴权且返回成功的业务请求各计 1 次；批量接口单请求返回多条仍只计 1 次。</dd>
        <dt>不计费情形</dt>
        <dd>预览图与用量查询等请求只累计图片流量、不计调用次数；失败请求计入调用次数与失败数、不计费。</dd>
        <dt>时区</dt>
        <dd>时间以协调世界时存储，页面与导出均按北京时间（UTC+8）归属自然日与自然月；自然日 00:00:00 至 23:59:59。</dd>
        <dt>图片流量双口径</dt>
        <dd>
          <p v-if="parts" class="caliber-figures">
            明细行合计 {{ parts.detail }} ＋ 展示通道流量（不计调用）{{ parts.display }} ＝ 合计 {{ parts.total }}。
          </p>
          <p class="note" data-check="drawer-note">{{ caliberNote }}</p>
        </dd>
        <dt>展示切片防护定性</dt>
        <dd>展示切片为辅助防护手段，无法阻止专业爬虫抓取切片后拼接；原图访问权限完全由后端鉴权控制。</dd>
      </dl>
    </aside>

    <!-- ===================== 06-4 趋势图 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>调用量 / 图片流量趋势 · {{ rangeLabel }}</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
    </div>

    <StateBlock
      :state="trendViewState"
      loading-text="正在重算趋势…"
      empty-title="当前区间暂无调用"
      empty-text="该区间没有调用记录，图表不做假填充"
      error-text="读取趋势失败"
      @retry="reload"
    >
      <div class="chart-card">
        <ul class="chart-legend" aria-hidden="true">
          <li><svg width="14" height="10" aria-hidden="true"><rect x="0" y="1" width="14" height="8" rx="1" class="sw-bar" /></svg>柱＝调用次数</li>
          <li><svg width="14" height="10" aria-hidden="true"><line x1="0" y1="5" x2="14" y2="5" class="sw-line" /><circle cx="7" cy="5" r="2.5" class="sw-line-dot" /></svg>折线＝图片流量（含展示通道）</li>
        </ul>
        <svg class="chart-svg" viewBox="0 0 760 240" role="img" :aria-label="trendAria">
          <line
            v-for="t in trendChart.ticks"
            :key="'g' + t.ratio"
            class="grid"
            :x1="trendChart.plotLeft"
            :x2="trendChart.plotRight"
            :y1="t.y"
            :y2="t.y"
          />
          <text
            v-for="t in trendChart.ticks"
            :key="'ty' + t.ratio"
            class="axis-text"
            :x="trendChart.plotLeft - 6"
            :y="t.y + 3"
            text-anchor="end"
          >{{ t.value }}</text>
          <text
            v-for="t in trendChart.bytesTicks"
            :key="'by' + t.ratio"
            class="axis-text"
            :x="trendChart.plotRight + 6"
            :y="t.y + 3"
          >{{ t.label }}</text>

          <g v-for="bar in trendChart.bars" :key="'b' + bar.key">
            <rect class="trend-bar" :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h">
              <title>{{ bar.key }}：调用 {{ bar.calls }} 次</title>
            </rect>
          </g>

          <path class="trend-line" :d="trendChart.linePath" />
          <circle
            v-for="pt in trendChart.linePoints"
            :key="'p' + pt.key"
            class="trend-dot"
            :cx="pt.x"
            :cy="pt.y"
            r="2.5"
          >
            <title>{{ pt.key }}：图片流量 {{ pt.bytesText }}</title>
          </circle>

          <text
            v-for="bar in trendChart.xLabels"
            :key="'x' + bar.key"
            class="axis-text"
            :x="bar.x + bar.w / 2"
            :y="trendChart.plotBottom + 14"
            text-anchor="middle"
          >{{ bar.label }}</text>
        </svg>
        <p class="note">
          柱＝该{{ trendChart.unit }}调用次数（含失败请求）；折线＝同一时间桶的图片流量（明细行合计 ＋ 展示通道流量）。
          X 轴刻度＝筛选窗口覆盖的北京时间自然{{ trendChart.unit }}（{{ rangeNote }}），无记录的时间桶按 0 显示。
          区间合计 {{ formatCalls(trendChart.totalCalls) }}，图片流量 {{ trendChart.totalBytesText }}，与上方汇总同源同区间。
        </p>
      </div>
    </StateBlock>

    <!-- ===================== 06-3 三维表 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>用量聚合 · 三维视图</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
    </div>

    <SegmentedControl v-model="dim" variant="dim" aria-label="聚合维度" :options="DIM_OPTIONS" />

    <StateBlock
      :state="dimViewState"
      loading-text="正在重算聚合…"
      empty-title="无匹配记录"
      empty-text="该筛选区间没有可聚合的记录，不显示 0 行表格残骸"
      error-text="读取聚合失败"
      @retry="reload"
    >
      <div v-if="dimState.data.value" class="table-wrap">
        <table class="tbl" data-block="dim-table">
          <thead>
            <tr>
              <th>{{ dimMeta.unit }}</th>
              <th>调用次数</th>
              <th>计费调用</th>
              <th>原图张数</th>
              <th>图片流量</th>
              <th>失败数</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dimRowView" :key="row.dimValue">
              <td class="mono">
                {{ row.label || row.dimValue }}
                <span v-if="row.isDisplay" class="tag soft">展示通道（不计调用）</span>
              </td>
              <td>{{ row.calls }} 次</td>
              <td>{{ row.billableCalls }} 次</td>
              <td>{{ row.originalImages }} 张</td>
              <td>{{ row.bytesText }}</td>
              <td>{{ row.failedCalls }}</td>
              <td class="share-cell">
                <svg class="share-bar" width="64" height="10" role="img" :aria-label="`占比 ${row.sharePercent}%`">
                  <rect x="0" y="0" width="64" height="10" rx="2" class="share-track" />
                  <rect x="0" y="0" :width="row.shareWidth" height="10" rx="2" class="share-fill">
                    <title>{{ row.dimValue }}：占比 {{ row.sharePercent }}%</title>
                  </rect>
                </svg>
                <span class="note">{{ row.sharePercent }}%</span>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>本维合计</td>
              <td>{{ dimTotals.calls }} 次</td>
              <td>{{ dimTotals.billableCalls }} 次</td>
              <td>{{ dimTotals.originalImages }} 张</td>
              <td>{{ dimTotals.bytesText }}</td>
              <td>{{ dimTotals.failedCalls }}</td>
              <td class="note">100.0%</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div v-if="parts" class="caliber caliber-embed" data-block="dim-caliber">
        <div class="caliber-row">
          <div class="caliber-cell" data-figure="dim-detail">
            <span class="caliber-label">明细行合计</span>
            <b>{{ parts.detail }}</b>
          </div>
          <span class="caliber-op" aria-hidden="true">＋</span>
          <div class="caliber-cell" data-figure="dim-display">
            <span class="caliber-label">展示通道流量（不计调用）</span>
            <b>{{ parts.display }}</b>
          </div>
          <span class="caliber-op" aria-hidden="true">＝</span>
          <div class="caliber-cell is-total" data-figure="dim-total">
            <span class="caliber-label">合计</span>
            <b>{{ parts.total }}</b>
          </div>
        </div>
        <p class="note" data-check="dim-sum">
          {{ parts.detail }} ＋ {{ parts.display }} ＝ {{ parts.total }} —— {{ sumCheck ? '与导出件汇总逐项一致，对账通过' : '两口径之和不等于合计，请重试' }}。
          {{ dimMeta.caliberNote }}
        </p>
      </div>
    </StateBlock>

    <!-- ===================== 06-5 明细表 + 06-6 导出 ===================== -->
    <div class="block-head" style="margin-top:22px;">
      <h3>调用明细 · {{ rangeLabel }}</h3><span class="rule"></span>
      <span class="tag pending">数据为示例</span>
      <button
        class="btn sm"
        type="button"
        :disabled="!canExport"
        :aria-disabled="String(!canExport)"
        :aria-busy="String(exporting)"
        @click="exportCsv"
      >{{ exporting ? '导出中…' : '导出当前筛选结果（CSV）' }}</button>
    </div>

    <p class="note" data-check="export-hint">
      <template v-if="canExport">
        本次将导出 {{ detailTotal }} 条明细行（严格等于当前筛选结果），列顺序固定，
        文件末尾附「明细行合计 / 展示通道流量（不计调用）」两行与一行口径注记。
      </template>
      <template v-else>当前筛选无数据，导出不可用（不导出空表残骸）。</template>
    </p>

    <StateBlock
      :state="detail.state.value"
      loading-text="正在读取调用明细…"
      empty-title="当前筛选无明细"
      empty-text="该筛选区间没有任何调用记录，不显示 0 行表格残骸"
      error-text="读取调用明细失败"
      @retry="reload"
    >
      <div v-if="detail.data.value" class="table-wrap">
        <table class="tbl" data-block="detail-table">
          <thead>
            <tr>
              <th>时间（CST）</th>
              <th>密钥 kid</th>
              <th>接口</th>
              <th>方法</th>
              <th>状态码</th>
              <th>耗时</th>
              <th>图片张数</th>
              <th>图片字节数</th>
              <th>是否计费</th>
              <th>traceId</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rec in detail.data.value.items" :key="rec.recordId">
              <td>{{ toCstDateTime(rec.requestedAt) }}</td>
              <td class="mono">{{ rec.kid }}</td>
              <td class="mono">{{ rec.endpoint }}</td>
              <td>{{ rec.method }}</td>
              <td>{{ rec.statusCode }}</td>
              <td>{{ rec.latencyMs }} ms</td>
              <td>{{ rec.imageCount }} 张</td>
              <td>{{ formatBytesExact(rec.imageBytes) }}</td>
              <td :class="rec.isBillable ? 'state' : 'note'">{{ rec.isBillable ? '计费' : '不计费' }}</td>
              <td class="mono">{{ rec.traceId || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <nav class="pager" aria-label="明细分页" data-check="pager">
        <button class="btn ghost sm" type="button" :disabled="page <= 1" :aria-disabled="String(page <= 1)" @click="goPage(page - 1)">上一页</button>
        <template v-for="token in pageTokens" :key="token.key">
          <span v-if="token.gap" class="pager-gap">…</span>
          <button
            v-else
            class="pager-num"
            type="button"
            :class="{ 'is-active': token.value === page }"
            :aria-current="token.value === page ? 'page' : undefined"
            @click="goPage(token.value)"
          >{{ token.value }}</button>
        </template>
        <button class="btn ghost sm" type="button" :disabled="page >= pageCount" :aria-disabled="String(page >= pageCount)" @click="goPage(page + 1)">下一页</button>
        <span class="note" data-check="pager-state">
          第 {{ page }} / {{ pageCount }} 页 · 共 {{ detailTotal }} 行
        </span>
      </nav>
    </StateBlock>

    <!-- ===================== 页脚声明 ===================== -->
    <NoticeBar variant="status" style="margin-top:22px;">
      <b>声明</b> —— 「数据为示例」：本页金额、用量、密钥展示均为界面示意值，非真实凭据；
      页面数字与导出件汇总同源同区间，可逐项对账；时间均为北京时间（CST）。
    </NoticeBar>
  </ConsoleShell>
</template>

<script setup>
/**
 * 控制台用量明细（spec §1.3 P-M1-06）—— 要素 06-1 ～ 06-8 闭合清单。
 *
 * 数据来源（一律经适配层 `@/data`，页面零硬编码；筛选条件全量下传，页面不自行聚合）：
 *  - 06-1 筛选器组：时间范围（今日 / 近 7 日 / 近 30 日 / 本计费周期 / 近 12 月 / 自定义）
 *                  ＋ 密钥多选（密钥列表来源 A5）＋ 接口多选（选项来源 A11 近 12 月聚合）
 *                  ＋ 环境（测试 / 线上）；筛选态以 query 固化，可直接分享；
 *  - 06-2 汇总条：A10（**双口径**：detailImageBytes / displayChannelBytes / imageBytes）；
 *  - 06-3 三维表：A11（按密钥 / 按接口 / 按日三张自标签切换，三表随筛选同步重算）；
 *  - 06-4 趋势图：A12（调用次数柱 ＋ 图片流量折线）；
 *  - 06-5 明细表：A13（20 行/页分页）；06-6 导出：A14（真 Blob 下载）；
 *  - 06-7 口径抽屉：口径摘要 ＋ A14 `summary.note` **同一文字**；
 *  - 06-8 声明条：「数据为示例」。
 *
 * 图表为**内联 SVG + CSS 手绘**，未引入任何第三方图表库；配色一律引用专用图表色板
 * `--chart-1…5`（token 用途纪律，不借用品牌 / 线条等槽位专用 token）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ConsoleShell from '@/components/ConsoleShell.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import StateBlock from '@/components/StateBlock.vue'
import {
  ENV, exportUsage, getUsageBreakdown, getUsageSummary, getUsageTrend,
  listApiKeys, listUsageRecords, toCstDate, toCstDateTime, toCstMonth,
} from '@/data'
import { formatBytes, formatBytesExact, formatBytesParts, formatCalls } from '@/config/pricing.js'
import { useAsync } from '@/composables/useAsync.js'
import { toast } from '@/composables/useToast.js'

const route = useRoute()
const router = useRouter()

const DAY_MS = 86400000
const PAGE_SIZE = 20

// ---------------------------------------------------------------------------
// 06-1 筛选器组（时间窗口一律按 CST 自然日 / 自然月对齐，§7.5）
// ---------------------------------------------------------------------------
const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
  { value: 'month', label: '本月（本计费周期）' },
  { value: '12m', label: '近 12 月' },
  { value: 'custom', label: '自定义' },
]

const ENV_OPTIONS = [
  { value: 'all', label: '全部环境' },
  { value: ENV.TEST, label: '测试环境' },
  { value: ENV.LIVE, label: '线上环境' },
]

const DIM_OPTIONS = [
  { value: 'key', label: '按密钥' },
  { value: 'endpoint', label: '按接口' },
  { value: 'day', label: '按日' },
]

/** CST 自然日起点 / 终点 → UTC ISO。 */
const cstDayStart = (dayKey) => new Date(`${dayKey}T00:00:00+08:00`).toISOString()
const cstDayEnd = (dayKey) => new Date(`${dayKey}T23:59:59.999+08:00`).toISOString()

/** CST 自然日偏移（anchor 取 CST 当日 00:00，无夏令时，按整日加减）。 */
function shiftDayKey(dayKey, delta) {
  return toCstDate(new Date(Date.parse(`${dayKey}T00:00:00Z`) + delta * DAY_MS).toISOString())
}

/** CST 自然月偏移。 */
function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

const todayKey = ref(toCstDate(new Date().toISOString()))
const currentMonth = ref(toCstMonth(new Date().toISOString()))
const customFrom = ref(shiftDayKey(todayKey.value, -6))
const customTo = ref(todayKey.value)

/** 筛选态（可在网址里固化，§2.3-4 / 交互 1）。 */
function initialFilters() {
  const q = route.query
  const rangeRaw = typeof q.range === 'string' ? q.range : ''
  const envRaw = typeof q.env === 'string' ? q.env.toLowerCase() : ''
  return {
    range: RANGE_OPTIONS.some((o) => o.value === rangeRaw) ? rangeRaw : '30d',
    keys: typeof q.keys === 'string' ? q.keys.split(',').map((s) => s.trim()).filter(Boolean) : [],
    endpoints: typeof q.endpoints === 'string' ? q.endpoints.split(',').map((s) => s.trim()).filter(Boolean) : [],
    env: envRaw === 'live' ? ENV.LIVE : envRaw === 'test' ? ENV.TEST : 'all',
  }
}

const filters = ref(initialFilters())
const range = ref(filters.value.range)
const env = ref(filters.value.env)

/** 时间窗口 → `{from,to}`（UTC ISO）；一律 CST 自然日 / 自然月对齐。 */
function windowOf(rangeValue) {
  const nowIso = new Date().toISOString()
  switch (rangeValue) {
    case 'today':
      return { from: cstDayStart(todayKey.value), to: nowIso }
    case '7d':
      return { from: cstDayStart(shiftDayKey(todayKey.value, -6)), to: nowIso }
    case 'month':
      return { from: cstDayStart(`${currentMonth.value}-01`), to: nowIso }
    case '12m':
      return { from: cstDayStart(`${shiftMonthKey(currentMonth.value, -11)}-01`), to: nowIso }
    case 'custom': {
      const from = customFrom.value <= customTo.value ? customFrom.value : customTo.value
      const to = customFrom.value <= customTo.value ? customTo.value : customFrom.value
      return { from: cstDayStart(from), to: cstDayEnd(to) }
    }
    case '30d':
    default:
      return { from: cstDayStart(shiftDayKey(todayKey.value, -29)), to: nowIso }
  }
}

const params = computed(() => {
  const win = windowOf(filters.value.range)
  return {
    from: win.from,
    to: win.to,
    range: filters.value.range,
    keys: [...filters.value.keys],
    endpoints: [...filters.value.endpoints],
    env: filters.value.env === 'all' ? null : filters.value.env,
  }
})

const rangeLabel = computed(() => (RANGE_OPTIONS.find((o) => o.value === filters.value.range) || RANGE_OPTIONS[2]).label)

/** 窗口说明（图注 / 筛选提示共用，口径与实际传参一致）。 */
const rangeNote = computed(() => {
  const notes = {
    today: '今日＝北京时间当日 00:00:00 起至当前时刻',
    '7d': '近 7 日＝含今日的 7 个北京自然日',
    '30d': '近 30 日＝含今日的 30 个北京自然日',
    month: '本计费周期＝当月 1 日 00:00:00 起（月包量同月重置）',
    '12m': '近 12 月＝含当月的 12 个北京自然月',
    custom: '自定义区间按北京时间自然日整段取',
  }
  return notes[filters.value.range] || notes['30d']
})

/** X 轴刻度：跨度 ≤ 62 个北京自然日用日粒度，否则自动升为月粒度（§7.4）。 */
const axis = computed(() => {
  const win = windowOf(filters.value.range)
  const fromDay = toCstDate(win.from)
  const toDay = toCstDate(win.to)
  const dayCount = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS) + 1
  if (dayCount <= 62) {
    const keys = []
    for (let i = 0; i < dayCount; i += 1) keys.push(shiftDayKey(fromDay, i))
    return { bucket: 'day', keys, unit: '日' }
  }
  const fromMonth = toCstMonth(win.from)
  const toMonth = toCstMonth(win.to)
  const monthCount = (Number(toMonth.slice(0, 4)) * 12 + Number(toMonth.slice(5, 7)))
    - (Number(fromMonth.slice(0, 4)) * 12 + Number(fromMonth.slice(5, 7))) + 1
  const keys = []
  for (let i = 0; i < monthCount; i += 1) keys.push(shiftMonthKey(fromMonth, i))
  return { bucket: 'month', keys, unit: '月' }
})

/** 可分享的筛选链接（交互 1：筛选态可被网址固化）。 */
const shareLink = computed(() => {
  const q = { range: filters.value.range }
  if (filters.value.keys.length) q.keys = filters.value.keys.join(',')
  if (filters.value.endpoints.length) q.endpoints = filters.value.endpoints.join(',')
  if (filters.value.env === ENV.LIVE) q.env = 'live'
  if (filters.value.env === ENV.TEST) q.env = 'test'
  if (filters.value.range === 'custom') {
    q.from = customFrom.value
    q.to = customTo.value
  }
  return `/console/usage?${new URLSearchParams(q).toString()}`
})

function syncUrl() {
  const idx = shareLink.value.indexOf('?')
  const query = Object.fromEntries(new URLSearchParams(shareLink.value.slice(idx + 1)))
  router.replace({ name: 'console-usage', query })
}

// ---------------------------------------------------------------------------
// 数据读取（每个模块独立三态：加载 / 空 / 错误，§1.6）
// ---------------------------------------------------------------------------
const summary = useAsync(getUsageSummary)                                     // A10
const trend = useAsync((p, bucket) => getUsageTrend(p, bucket))               // A12
const byKey = useAsync((p, d) => getUsageBreakdown(p, d))                     // A11（按密钥）
const byEndpoint = useAsync((p, d) => getUsageBreakdown(p, d))                // A11（按接口）
const byDay = useAsync((p, d) => getUsageBreakdown(p, d))                     // A11（按日）
const detail = useAsync((p, pg) => listUsageRecords(p, pg))                   // A13
const exportSpec = useAsync(exportUsage)                                      // A14（取口径注记 + 与页面勾稽）
const keyList = useAsync(listApiKeys)                                         // A5（密钥筛选项）
/** 接口筛选项：近 12 月聚合结果（只取分组值，不带其它筛选，保证选项稳定）。 */
const endpointList = useAsync((p, d) => getUsageBreakdown(p, d))

const dim = ref('endpoint')
const page = ref(1)
const drawerOpen = ref(false)
const exporting = ref(false)

const DIM_META = {
  key: {
    unit: '密钥',
    caliberNote: '展示通道（切片）没有密钥归属，故不落在本维任何一行，只进合计口径。',
  },
  endpoint: {
    unit: '接口',
    caliberNote: '展示通道（切片）在按接口维度自成一组（调用次数为 0，只累计图片流量）。',
  },
  day: {
    unit: '自然日',
    caliberNote: '展示通道（切片）流量并入所属北京自然日。',
  },
}
const dimMeta = computed(() => DIM_META[dim.value] || DIM_META.endpoint)
const dimState = computed(() => ({ key: byKey, endpoint: byEndpoint, day: byDay }[dim.value] || byEndpoint))

const summaryData = computed(() => summary.data.value)
const detailPage = computed(() => detail.data.value || null)
const detailTotal = computed(() => detailPage.value?.total || 0)
const pageCount = computed(() => Math.max(1, detailPage.value?.totalPages || 1))
const canExport = computed(() => detailTotal.value > 0)

/**
 * 06-2 图片流量**双口径**显示三元组：三数字同单位、同精度，且**合计 = 两个显示值之和**
 * （以 0.01 为单位整数相加，规避浮点误差）——屏幕上「明细 ＋ 展示 ＝ 合计」可相加。
 */
/**
 * 交互 4：空筛选结果 → **各区块都走空态**，不留 0 行表格残骸 / 0 值假图。
 * 判定口径：区间内既无调用记录、也无展示通道流量（`calls` 与两个流量口径同时为 0）。
 */
const windowEmpty = computed(() => {
  const d = summaryData.value
  return !!d && d.calls === 0 && d.displayChannelBytes === 0 && d.imageBytes === 0
})
const summaryState = computed(() => (windowEmpty.value ? 'empty' : summary.state.value))
const dimViewState = computed(() => (
  dimState.value.state.value === 'ready' && dimRows.value.length === 0 ? 'empty' : dimState.value.state.value
))
const trendViewState = computed(() => (
  trend.state.value === 'ready' && !(trend.data.value?.series || []).length ? 'empty' : trend.state.value
))

const parts = computed(() => {
  const d = summaryData.value
  if (!d) return null
  return formatBytesParts(d.detailImageBytes, d.displayChannelBytes, d.imageBytes)
})
const sumCheck = computed(() => (parts.value ? parts.value.detailHundredths + parts.value.displayHundredths === parts.value.totalHundredths : false))

/** 交互 6：页面自身即可对账 —— 导出件汇总与本页汇总**逐项一致**。 */
const exportMatch = computed(() => {
  const a10 = summaryData.value
  const a14 = exportSpec.data.value?.summary
  if (!a10 || !a14) return null
  return a10.detailImageBytes === a14.detailImageBytes
    && a10.displayChannelBytes === a14.displayChannelBytes
    && a10.imageBytes === a14.imageBytes
})

/** 06-7 抽屉口径注记：**与导出件汇总区注记行、导出返回体的口径注记同一文字**。 */
const caliberNote = computed(
  () => exportSpec.data.value?.summary?.note || '图片流量分两口径：明细行合计不含展示通道（切片）流量；展示通道流量只计图片流量、不计调用次数。两口径之和等于汇总图片流量。',
)

// ---- 06-3 三维表视图 ------------------------------------------------------
const DISPLAY_GROUP_ROWS = (rows) => rows.filter((r) => r.calls === 0 && r.imageBytes > 0)
const dimRows = computed(() => dimState.value.data.value?.rows || [])

const dimRowView = computed(() => dimRows.value.map((r) => ({
  ...r,
  isDisplay: r.calls === 0 && r.imageBytes > 0,
  bytesText: formatBytes(r.imageBytes),
  sharePercent: (Number(r.share || 0) * 100).toFixed(1),
  shareWidth: Math.max(0, Math.min(64, Math.round(Number(r.share || 0) * 64))),
})))

const dimTotals = computed(() => {
  const acc = { calls: 0, billableCalls: 0, originalImages: 0, failedCalls: 0, imageBytes: 0 }
  for (const r of dimRows.value) {
    acc.calls += r.calls
    acc.billableCalls += r.billableCalls
    acc.originalImages += r.originalImages
    acc.failedCalls += r.failedCalls
    acc.imageBytes += r.imageBytes
  }
  return { ...acc, bytesText: formatBytes(acc.imageBytes) }
})

// ---- 06-4 趋势图（内联 SVG，坐标全部由适配层数据派生） ---------------------
const CHART = { w: 760, h: 240, padL: 52, padR: 62, padT: 14, padB: 30 }
const TICK_RATIOS = [0, 1 / 4, 1 / 2, 3 / 4, 1]

const trendChart = computed(() => {
  const spec = axis.value
  const seriesMap = new Map((trend.data.value?.series || []).map((s) => [s.bucket, s]))
  const points = spec.keys.map((key) => {
    const hit = seriesMap.get(key)
    return {
      key,
      label: spec.bucket === 'month' ? key : key.slice(5),
      calls: hit ? hit.calls : 0,
      imageBytes: hit ? hit.imageBytes : 0,
    }
  })
  const plotH = CHART.h - CHART.padT - CHART.padB
  const plotW = CHART.w - CHART.padL - CHART.padR
  const maxCalls = Math.max(1, ...points.map((p) => p.calls))
  const maxBytes = Math.max(1, ...points.map((p) => p.imageBytes))
  const step = plotW / Math.max(1, points.length)
  const barW = Math.max(2, step * 0.56)
  const bars = points.map((p, i) => {
    const h = (p.calls / maxCalls) * plotH
    return {
      ...p,
      x: CHART.padL + i * step + (step - barW) / 2,
      y: CHART.padT + plotH - h,
      w: barW,
      h: Math.max(p.calls > 0 ? 1 : 0, h),
    }
  })
  const linePoints = points.map((p, i) => ({
    key: p.key,
    x: CHART.padL + i * step + step / 2,
    y: CHART.padT + plotH - (p.imageBytes / maxBytes) * plotH,
    bytesText: formatBytes(p.imageBytes),
  }))
  const labelEvery = points.length > 16 ? Math.ceil(points.length / 10) : 1
  return {
    unit: spec.unit,
    bars,
    linePoints,
    linePath: linePoints.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' '),
    ticks: TICK_RATIOS.map((ratio) => ({
      ratio,
      y: CHART.padT + plotH - ratio * plotH,
      value: Math.round(maxCalls * ratio),
    })),
    bytesTicks: TICK_RATIOS.map((ratio) => ({
      ratio,
      y: CHART.padT + plotH - ratio * plotH,
      label: formatBytes(Math.round(maxBytes * ratio)),
    })),
    plotLeft: CHART.padL,
    plotRight: CHART.w - CHART.padR,
    plotBottom: CHART.padT + plotH,
    xLabels: bars.filter((_, i) => i % labelEvery === 0),
    totalCalls: points.reduce((s, p) => s + p.calls, 0),
    totalBytesText: formatBytes(points.reduce((s, p) => s + p.imageBytes, 0)),
  }
})

const trendAria = computed(() => {
  const c = trendChart.value
  return `${rangeLabel.value}趋势图：柱＝每${c.unit}调用次数，折线＝每${c.unit}图片流量，`
    + `区间合计 ${c.totalCalls} 次调用、图片流量 ${c.totalBytesText}，共 ${c.bars.length} 个时间桶`
})

// ---- 06-5 明细分页 --------------------------------------------------------
const pageTokens = computed(() => {
  const total = pageCount.value
  const cur = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => ({ key: `p${i + 1}`, value: i + 1, gap: false }))
  const nums = [...new Set([1, total, cur - 1, cur, cur + 1].filter((n) => n >= 1 && n <= total))].sort((a, b) => a - b)
  const tokens = []
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) tokens.push({ key: `gap${n}`, gap: true })
    tokens.push({ key: `p${n}`, value: n, gap: false })
  })
  return tokens
})

// ---- 筛选交互 -------------------------------------------------------------
function reload() {
  const p = params.value
  const bucket = axis.value.bucket
  return Promise.all([
    summary.run(p),
    trend.run(p, bucket),
    byKey.run(p, 'key'),
    byEndpoint.run(p, 'endpoint'),
    byDay.run(p, 'day'),
    detail.run(p, { page: page.value, pageSize: PAGE_SIZE }),
    exportSpec.run(p),
  ]).then(async () => {
    const totalPages = pageCount.value
    if (page.value > totalPages) {
      page.value = totalPages
      await detail.run(p, { page: page.value, pageSize: PAGE_SIZE })
    }
  })
}

/** 任一筛选变更 → 三表 + 汇总 + 趋势 + 明细 + 导出件同步重算，页面不整页刷新。 */
async function onFilterChange() {
  filters.value = { ...filters.value, range: range.value, env: env.value }
  page.value = 1
  syncUrl()
  await reload()
}

function setKeys(next) {
  filters.value = { ...filters.value, keys: next }
  onFilterChange()
}

function toggleKey(kid) {
  const keys = filters.value.keys.includes(kid)
    ? filters.value.keys.filter((k) => k !== kid)
    : [...filters.value.keys, kid]
  setKeys(keys)
}

function setEndpoints(next) {
  filters.value = { ...filters.value, endpoints: next }
  onFilterChange()
}

function toggleEndpoint(ep) {
  const endpoints = filters.value.endpoints.includes(ep)
    ? filters.value.endpoints.filter((e) => e !== ep)
    : [...filters.value.endpoints, ep]
  setEndpoints(endpoints)
}

function applyCustom() {
  onFilterChange()
}

function resetFilters() {
  filters.value = { range: '30d', keys: [], endpoints: [], env: 'all' }
  range.value = '30d'
  env.value = 'all'
  page.value = 1
  syncUrl()
  reload()
}

function goPage(next) {
  const target = Math.min(Math.max(1, next), pageCount.value)
  if (target === page.value) return
  page.value = target
  detail.run(params.value, { page: page.value, pageSize: PAGE_SIZE })
}

/** 06-6 导出：真 Blob 下载；文件名体现区间与筛选摘要；行集合严格等于当前筛选结果。 */
async function exportCsv() {
  if (exporting.value || !canExport.value) return
  exporting.value = true
  try {
    const result = await exportUsage(params.value)
    const blob = new Blob([result.content], { type: result.mimeType || 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = result.fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    toast(`导出成功：${result.fileName}（${result.rowCount} 行明细）`)
  } catch (e) {
    toast(`导出失败：${e?.message || '演示环境数据源不可用'}`)
  } finally {
    exporting.value = false
  }
}

// ---- 筛选项（密钥 / 接口） ------------------------------------------------
const keyOptions = computed(() => {
  const list = Array.isArray(keyList.data.value) ? keyList.data.value : []
  const map = new Map(list.map((k) => [k.kid, k.label || k.kid]))
  for (const kid of filters.value.keys) if (!map.has(kid)) map.set(kid, '已删除密钥')
  return [...map.entries()].map(([kid, label]) => ({ kid, label }))
})

const endpointOptions = computed(() => {
  const rows = endpointList.data.value?.rows || []
  return [...new Set([...rows.map((r) => r.dimValue), ...filters.value.endpoints])]
})

onMounted(async () => {
  keyList.run()
  endpointList.run({ range: '12m' }, 'endpoint')
  await reload()
})
</script>

<style scoped>
.filter-card { padding: var(--sp-9) var(--sp-10); }
.frow { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; padding: var(--sp-3) 0; }
.frow-label { font-size: var(--fs-13); color: var(--muted); min-width: 62px; letter-spacing: var(--ls-2); }
.sr-inline { font-size: var(--fs-13); color: var(--muted); }
.date-input {
  font-family: inherit; font-size: var(--fs-13); padding: var(--sp-2) var(--sp-4);
  background: #fff; border: var(--border); border-radius: var(--radius-sm); color: var(--ink);
}
.chips { margin: 0; }
.chip .mono { font-size: var(--fs-12); color: var(--muted); }
.chip.is-active .mono { color: #fff; }
.filter-link { margin-top: var(--sp-5); }
.filter-link code { word-break: break-all; }

.kpi .note { font-size: var(--fs-12); color: var(--faint); line-height: 1.65; margin-top: 6px; }

/* 双口径（汇总条 / 三维表共用）：三数字同单位同精度、可相加 */
.caliber {
  margin-top: var(--sp-8); border: var(--border); border-radius: var(--radius);
  background: var(--paper); padding: var(--sp-8) var(--sp-9);
}
.caliber h4 { font-size: var(--fs-15); color: var(--brand); letter-spacing: var(--ls-3); margin-bottom: var(--sp-5); }
.caliber-row { display: flex; align-items: center; gap: var(--sp-5); flex-wrap: wrap; }
.caliber-cell {
  flex: 1 1 190px; min-width: 170px; display: flex; flex-direction: column; gap: var(--sp-1);
  background: #fff; border: var(--border); border-radius: var(--radius-sm); padding: var(--sp-5) var(--sp-6);
}
.caliber-cell.is-total { border-color: var(--brand); }
.caliber-cell b { font-size: var(--fs-19); color: var(--ink); letter-spacing: var(--ls-1); }
.caliber-cell.is-total b { color: var(--brand); }
.caliber-label { font-size: var(--fs-12); color: var(--muted); letter-spacing: var(--ls-2); }
.caliber-cell .note { font-size: var(--fs-11-5); line-height: 1.5; }
.caliber-op { font-size: var(--fs-19); color: var(--brand); }
.caliber-embed { margin-top: var(--sp-7); background: var(--card); }
.warn-text { color: var(--brand); }

.drawer {
  margin-top: var(--sp-7); border: var(--border); border-left: var(--border-accent);
  border-radius: var(--radius); background: var(--paper); padding: var(--sp-9) var(--sp-10);
}
.drawer h4 { font-size: var(--fs-16); color: var(--brand); letter-spacing: var(--ls-3); margin-bottom: var(--sp-5); }
.caliber-list { margin: 0; }
.caliber-list dt { font-size: var(--fs-13); color: var(--brand); letter-spacing: var(--ls-2); margin-top: var(--sp-6); }
.caliber-list dt:first-child { margin-top: 0; }
.caliber-list dd { margin: var(--sp-2) 0 0; font-size: var(--fs-13); color: var(--ink-2); line-height: 1.7; }
.caliber-figures { margin: 0 0 var(--sp-2); color: var(--ink); }

/* 06-4 趋势图（内联 SVG） */
.chart-card { border: var(--border); border-radius: var(--radius); background: var(--card); padding: var(--sp-9) var(--sp-10) var(--sp-7); }
.chart-legend { list-style: none; display: flex; gap: var(--sp-10); margin: 0 0 var(--sp-5); padding: 0; font-size: var(--fs-12); color: var(--muted); }
.chart-legend li { display: flex; align-items: center; gap: var(--sp-2); }
.chart-svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--line); stroke-width: 1; }
.axis-text { fill: var(--faint); font-size: 10px; }
/**
 * 图表元素一律引用专用图表色板 `--chart-*`（§1.8-10 token 用途纪律）：
 * 柱填充 --chart-1、折线描边 --chart-4、占比条填充 --chart-2，轨道一律 --meter-track，
 * 每一元素对轨道 / 白底的对比度均 ≥ 3:1（§1.8-9），且柱与折线另有形状与图例直接标注区分。
 */
.sw-bar { fill: var(--chart-1); }
.sw-line { stroke: var(--chart-4); stroke-width: 2.5; }
.sw-line-dot { fill: var(--chart-4); }
.trend-bar { fill: var(--chart-1); stroke: var(--chart-1); stroke-width: 1; }
.trend-line { fill: none; stroke: var(--chart-4); stroke-width: 2; stroke-linejoin: round; }
.trend-dot { fill: var(--chart-4); }
.trend-bar:hover { fill: var(--chart-2); }

/* 06-3 三维表：占比内联 SVG 分布条 */
.share-cell { display: flex; align-items: center; gap: var(--sp-3); }
.share-bar { flex: 0 0 auto; }
.share-track { fill: var(--meter-track); }
.share-fill { fill: var(--chart-2); }
.tbl tfoot td { border-top: var(--border-brand); color: var(--ink); }

/* 06-5 分页 */
.pager { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; margin-top: var(--sp-7); }
.pager-num {
  font-family: inherit; font-size: var(--fs-13); min-width: 30px; padding: var(--sp-2) var(--sp-3);
  background: #fff; border: var(--border); border-radius: var(--radius-sm); color: var(--ink-2); cursor: pointer;
}
.pager-num:hover { border-color: var(--brand); color: var(--brand); }
.pager-num.is-active { background: var(--brand); border-color: var(--brand); color: #fff; }
.pager-gap { color: var(--faint); font-size: var(--fs-13); }
</style>
