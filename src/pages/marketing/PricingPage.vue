<template>
  <div class="container" style="padding-top:44px;padding-bottom:64px;">
    <p class="eyebrow">计费规则</p>
    <h1 style="font-size:32px;letter-spacing:2px;margin-bottom:10px;">计费构成与演示价</h1>
    <p class="note" style="margin-bottom:20px;">
      本页所有价格与包量均来自<b>统一计价配置</b>，页面只消费不硬编码；改一处全站生效。
    </p>

    <NoticeBar variant="banner">
      本页说明计费构成、套餐档位与扣减口径，并给出两条场景算例；
      价格与额度均为演示价，可一句话整体替换。控制台内的实际扣减与账单见「充值账单」页。
    </NoticeBar>

    <!-- 锚点目标 /pricing#overage（D3 修复：id 曾挂在 v-if 异步块内，路由滚动时目标尚未渲染，
         于是「只存在不滚动」；现挂静态外壳，数据就绪后另有一次 scrollIntoView 兜底） -->
    <div id="overage" class="anchor-shell">
      <p class="block-head">
        <span class="eyebrow" style="margin:0;">超量单价与套餐</span>
      </p>
    </div>

    <StateBlock
      :state="table.state.value"
      empty-text="暂无套餐配置"
      error-text="读取定价配置失败"
      @retry="loadTable"
    >
      <div v-if="table.data.value">
        <!-- 08-1 计费构成说明（五个收费项，金额与包量一律配置插值） -->
        <div class="banner">
          计费构成：① 一次性开通部署费（{{ table.data.value.setupFee.label }}，不展示金额）
          ｜ ② 年度平台授权与运维服务费（年费；按年收取，不转化为包量）
          ｜ ③ 月度包量 API 调用（包量内不另计费）
          ｜ ④ 超量调用单价（包量耗尽后按档位单价从充值余额扣减）
          ｜ ⑤ 高清原图单价 {{ formatCents(table.data.value.originalImageUnitPriceCents) }}/张
          （各档同价、不含在包量内；账号维度每日免费额度
          {{ table.data.value.originalImageDownload.freePerDay }} 张内不计费，超出部分按张从余额扣减）
        </div>

        <!-- 08-2 套餐对比表 -->
        <div class="block-head" style="margin-top:24px;">
          <h3>套餐对比</h3>
          <span class="rule"></span>
          <span class="note">
            年费与月包量是两个并列收费项，不合并展示；高清原图各档同价（超出每日免费额度后按张计费）
          </span>
        </div>

        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>档位</th><th>年费</th><th>月包量（计费调用）</th><th>超量单价</th><th>高清原图单价</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in table.data.value.rows"
                :key="row.planId"
                :class="{ 'row-focus': row.planId === activePlanId }"
              >
                <td><b>{{ row.name }}</b></td>
                <td>{{ formatCents(row.annualFeeCents) }} / 年</td>
                <td>{{ formatCalls(row.monthlyQuotaCalls) }}</td>
                <td>{{ formatCents(row.overageUnitPriceCents) }} / 次</td>
                <td>{{ formatCents(row.originalImageUnitPriceCents) }} / 张</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="note" style="margin-top:8px;">
          高清原图额度（账号维度 · {{ quotaPolicyLabel }}）：每日免费额度
          <b>{{ table.data.value.originalImageDownload.freePerDay }} 张</b>，
          按 {{ table.data.value.originalImageDownload.timezone }} 自然日 00:00 重置，同账号多密钥共享；
          <b>额度内不计费</b>；超出部分每张 {{ formatCents(table.data.value.originalImageDownload.unitPriceCents) }}
          从充值余额扣减，<b>不设每日金额上限</b>，仅余额不足时拒绝。
        </p>

        <SegmentedControl
          v-model="activePlanId"
          variant="chips"
          aria-label="套餐档位"
          :options="planOptions"
          @change="loadScenario"
        />

        <div class="plans">
          <article
            v-for="row in table.data.value.rows"
            :key="row.planId"
            class="plan"
            :class="{ hi: row.planId === activePlanId }"
          >
            <h4>{{ row.name }}</h4>
            <div class="price">{{ formatCents(row.annualFeeCents) }}<small> / 年费</small></div>
            <ul>
              <li>月包量：{{ formatCalls(row.monthlyQuotaCalls) }}</li>
              <li>超量单价：{{ formatCents(row.overageUnitPriceCents) }}/次</li>
              <li>高清原图：{{ formatCents(row.originalImageUnitPriceCents) }}/张（超出每日免费额度后）</li>
            </ul>
          </article>
        </div>

        <!-- 08-3 典型场景算例 -->
        <div class="block-head" style="margin-top:26px;">
          <h3>典型场景算例</h3>
          <span class="rule"></span>
          <span class="note">{{ table.data.value.scenarioText }}</span>
        </div>

        <StateBlock
          :state="scenario.state.value"
          empty-text="暂无算例"
          error-text="算例计算失败"
          @retry="loadScenario"
        >
          <div v-if="scenario.data.value" class="table-wrap">
            <table class="tbl">
              <thead>
                <tr><th>收费项</th><th>口径</th><th>金额</th></tr>
              </thead>
              <tbody>
                <tr v-for="line in scenario.data.value.lines" :key="line.key">
                  <td>{{ line.label }}</td>
                  <td class="note">{{ line.detail }}</td>
                  <td>{{ formatCents(line.amountCents) }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>首年合计（年费 + 单月用量）</td>
                  <td class="note">
                    不含一次性开通部署费（{{ table.data.value.setupFee.label }}）；
                    原图落在免费额度内 ⇒ 原图费用 {{ formatCents(0) }}，故首年合计＝年费
                  </td>
                  <td>{{ formatCents(scenario.data.value.totalFirstYearCents) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </StateBlock>

        <div class="block-head" style="margin-top:26px;">
          <h3>超额算例</h3>
          <span class="rule"></span>
          <span class="note">{{ overageLabel }}</span>
        </div>

        <StateBlock
          :state="overageExample.state.value"
          empty-text="暂无算例"
          error-text="算例计算失败"
          @retry="loadScenario"
        >
          <div v-if="overageExample.data.value" class="table-wrap">
            <table class="tbl">
              <thead>
                <tr><th>收费项</th><th>口径</th><th>金额</th></tr>
              </thead>
              <tbody>
                <tr v-for="line in overageExample.data.value.lines" :key="line.key">
                  <td>{{ line.label }}</td>
                  <td class="note">{{ line.detail }}</td>
                  <td>{{ formatCents(line.amountCents) }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>首年合计（年费 + 该月用量）</td>
                  <td class="note">
                    单月口径 {{ formatCents(overageExample.data.value.monthlyCents) }}；
                    本算例仅示意「超出部分按张计费」，不设每日金额上限
                  </td>
                  <td>{{ formatCents(overageExample.data.value.totalFirstYearCents) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </StateBlock>

        <div class="block-head" style="margin-top:26px;">
          <h3>扣减顺序</h3>
          <span class="rule"></span>
        </div>
        <div class="steps">
          <div class="step">
            <b>① 先用月包量</b>
            <span>
              每 1 次计费调用优先消耗当月剩余包量；包量不跨月结转，
              {{ table.data.value.deduction.quotaResetAt }} 重置，上月未用余量作废
            </span>
          </div>
          <div class="step">
            <b>② 后扣充值余额</b>
            <span>包量耗尽后，超出部分按该档超量单价从充值余额扣减</span>
          </div>
          <div class="step">
            <b>③ 原图：先免费额度、后余额</b>
            <span>
              账号维度每日免费额度 {{ table.data.value.originalImageDownload.freePerDay }} 张内不计费；
              超出部分每张 {{ formatCents(table.data.value.originalImageDownload.unitPriceCents) }}
              从充值余额扣减（仅余额不足时拒绝）
            </span>
          </div>
          <div class="step">
            <b>展示切片不计调用</b>
            <span>展示通道下发的每方 {{ table.data.value.displaySlices.sliceCount }} 片切片只计图片流量、不计调用次数</span>
          </div>
          <div class="step">
            <b>包量不跨月结转</b>
            <span>{{ table.data.value.deduction.quotaResetAt }} 包量重置，上月未用余量作废</span>
          </div>
        </div>

        <!-- 08-5 计费口径摘要 -->
        <div class="card" style="margin-top:24px;padding:20px 22px;">
          <h3 style="font-size:16px;">计费口径摘要</h3>
          <ul style="margin-top:8px;">
            <li style="padding:6px 0;border-bottom:var(--border-dashed);">
              <b>什么算一次计费调用</b>
              <p class="note">已鉴权且返回成功的业务请求各计 1 次；批量接口单次请求返回多条记录仍只计 1 次（按请求计，不按返回条数计）。</p>
            </li>
            <li style="padding:6px 0;border-bottom:var(--border-dashed);">
              <b>不计费的情形</b>
              <p class="note">
                鉴权失败的请求、返回错误的请求不计计费调用；预览图与展示切片只累计图片流量、不计调用次数；
                高清原图{{ table.data.value.originalImageCountAsCall ? '计入' : '不叠加' }}调用次数，只按张计价。
              </p>
            </li>
            <li style="padding:6px 0;border-bottom:var(--border-dashed);">
              <b>图片流量的两个口径</b>
              <p class="note">
                明细行合计与展示通道（切片）流量分列展示，两者之和等于汇总图片流量；
                展示通道只计图片流量、不计调用次数。
              </p>
            </li>
            <li style="padding:6px 0;">
              <b>时区与重置</b>
              <p class="note">
                用量归属与额度重置一律按 {{ table.data.value.originalImageDownload.timezone }}（北京时间）；
                月包量于每月 1 日 00:00 重置，原图免费额度按自然日 00:00 重置。
              </p>
            </li>
          </ul>
        </div>

        <!-- 08-6 行动按钮 -->
        <div class="modal-acts" style="margin-top:24px;">
          <EntryLink class="btn" to="/console/register">立即开通</EntryLink>
          <EntryLink class="btn ghost" to="/demo">申请演示环境</EntryLink>
          <EntryLink class="btn ghost" to="/docs">查看 API 文档</EntryLink>
        </div>

        <!-- 08-7 声明条 -->
        <p class="disclaimer" style="margin-top:20px;">
          {{ table.data.value.disclaimer }} · 本页价格为演示价，非正式报价，可一句话整体替换。
        </p>
      </div>
    </StateBlock>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import StateBlock from '@/components/StateBlock.vue'
import { getPricingTable, computeScenario } from '@/data'
import { formatCalls, formatCents } from '@/config/pricing.js'
import { originalQuotaPolicyLabel } from '@/config/labels.js'
import { useAsync } from '@/composables/useAsync.js'

const route = useRoute()
const table = useAsync(getPricingTable)
const scenario = useAsync(computeScenario)
const overageExample = useAsync(computeScenario)
const activePlanId = ref('')

const planOptions = computed(() =>
  (table.data.value?.rows || []).map((row) => ({ value: row.planId, label: row.name })),
)

/**
 * ④ 原图额度策略的对客中文名：由 `originalImageDownload.policy` 经展示层映射得到
 * （配置 / 契约里的原值保持不变，页面不回显枚举值本体）。
 */
const quotaPolicyLabel = computed(
  () => originalQuotaPolicyLabel(table.data.value?.originalImageDownload?.policy),
)

/** 两条算例的入参（口径① 免费额度内 / 口径② 超额）一律取自配置，页面不造数字。 */
const examples = computed(() => table.data.value?.scenarioExamples || [])
const overageLabel = computed(() => examples.value[1]?.label || '')

async function loadTable() {
  const data = await table.run()
  if (data?.rows?.length) {
    activePlanId.value = data.rows[0].planId
    await loadScenario()
  }
  // D3 兜底：数据就绪后再定位一次 #overage（静态外壳已在挂载时就存在）
  if (route.hash === '#overage') {
    await nextTick()
    document.getElementById('overage')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

async function loadScenario() {
  if (!activePlanId.value) return
  const list = examples.value
  await scenario.run({
    planId: activePlanId.value,
    originalImagesPerMonth: list[0]?.originalImagesPerMonth,
  })
  await overageExample.run({
    planId: activePlanId.value,
    originalImagesPerMonth: list[1]?.originalImagesPerMonth,
  })
}

onMounted(loadTable)
</script>

<style scoped>
.anchor-shell { scroll-margin-top: var(--sp-11); }
.anchor-shell .block-head { margin-bottom: var(--sp-4); }
/* 当前选中档位所在行（信息性底色，沿用品牌浅底 token） */
.row-focus td { background: var(--brand-tint); }
</style>
