<template>
  <ConsoleShell crumb="控制台 / 充值账单" spec-ref="P-M1-07">
    <NoticeBar variant="banner">
      <b>未接入真实支付通道</b> —— 本页的账户余额、充值订单与账单流水均为界面示意值，非报价；
      假扫码支付仅用于演示四态闭环（待支付 / 成功 / 失败 / 超时）。
    </NoticeBar>

    <!-- ============ 07-1 账户区 ============ -->
    <div class="block-head" style="margin-top:22px;">
      <h3>账户概览</h3><span class="rule"></span>
      <span class="note">余额的权威来源是流水：Σ流水 = 余额</span>
    </div>

    <StateBlock :state="account.state.value" empty-title="暂无账户数据" error-text="读取账户失败" @retry="loadAll">
      <div v-if="account.data.value" class="balance">
        <span>充值余额（账期 {{ account.data.value.monthKey }}）</span>
        <b>{{ formatCents(account.data.value.balanceCents) }}</b>
        <p class="note" style="margin-top:6px;">
          当前套餐档位：{{ planName }}
          ｜ 年费状态：{{ annualFeeText }}
          ｜ 月包量余量：{{ formatCalls(account.data.value.quotaRemainCalls) }}
          （上限 {{ formatCalls(account.data.value.quotaTotalCalls) }}，已用 {{ formatCalls(account.data.value.quotaUsedCalls) }}）
        </p>
        <p class="note" style="margin-top:4px;">
          一致性自检：流水合计 {{ formatCents(account.data.value.consistency.ledgerSumCents) }}
          ＝ 余额 {{ formatCents(account.data.value.balanceCents) }}
          <b>{{ account.data.value.consistency.consistent ? '一致 ✓' : '不一致 ✗（演示态告警）' }}</b>
        </p>
      </div>
    </StateBlock>

    <!-- ============ 07-2 / 07-3 充值套餐选择 + 去支付 ============ -->
    <div class="block-head" style="margin-top:22px;">
      <h3>充值金额</h3><span class="rule"></span>
      <span class="note">固定档位与自定义金额互斥选择；金额区间为硬校验，界面出现的取值都能成功下单</span>
    </div>

    <StateBlock :state="table.state.value" empty-title="暂无充值配置" error-text="读取充值配置失败" @retry="loadAll">
      <div v-if="table.data.value">
        <div class="chips" role="group" aria-label="充值金额档位">
          <button
            v-for="preset in presetOptions"
            :key="preset.cents"
            type="button"
            class="chip"
            :class="{ 'is-active': !customActive }"
            :aria-pressed="String(!customActive)"
            @click="selectPreset(preset.cents)"
          >{{ preset.label }}</button>
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': customActive }"
            :aria-pressed="String(customActive)"
            @click="selectCustom"
          >自定义金额</button>
        </div>

        <p class="hint">
          本次充值金额：<b>{{ amountText }}</b>　｜　自定义金额为整数元，范围 {{ customRangeText }}
        </p>

        <div v-if="customActive" class="field" style="max-width:280px;">
          <label for="billing-custom-amount">自定义金额（元，整数）</label>
          <input
            id="billing-custom-amount"
            v-model="customYuan"
            class="amt-input"
            type="number"
            inputmode="numeric"
            step="1"
            :min="customMinYuan"
            :max="customMaxYuan"
            @input="validateCustom"
          >
          <p v-if="customError" class="field-error" role="alert">{{ customError }}</p>
        </div>

        <div class="radios">
          <label v-for="item in channelOptions" :key="item.value">
            <input v-model="channel" type="radio" name="billing-pay-channel" :value="item.value">
            {{ item.label }}
          </label>
        </div>

        <div class="modal-acts" style="margin-top:14px;">
          <button
            class="btn"
            type="button"
            :disabled="payDisabled"
            :aria-disabled="String(payDisabled)"
            @click="goPay"
          >{{ payButtonLabel }}</button>
          <button v-if="needReorder" class="btn" type="button" @click="reorder()">重新下单（生成新订单号）</button>
          <button class="btn ghost" type="button" @click="notifyInvoice">申请开票{{ invoiceOpen ? '' : '（即将开放）' }}</button>
        </div>
        <p v-if="payDisabledHint" class="hint">{{ payDisabledHint }}</p>

        <p class="note" style="margin-top:12px;">
          假支付闭环：去支付 → 待支付（演示二维码 + 倒计时）→ 支付成功 / 支付失败 / 超时关闭 → 入账（余额与流水同时变动）；
          失败或超时后「重新下单」会生成**新的订单号**，不复用旧订单。
        </p>
      </div>
    </StateBlock>

    <!-- 年费与扣减口径（全部由配置插值） -->
    <div v-if="table.data.value" class="card" style="margin-top:18px;padding:20px 22px;">
      <h3 style="font-size:16px;">支付与结算说明</h3>
      <ul class="steps" style="flex-direction:column;">
        <li class="step">
          <b>年费与包量的关系</b>
          <span>{{ annualFeeRelationText }}</span>
        </li>
        <li class="step">
          <b>扣减顺序</b>
          <span>{{ deductionOrderText }}</span>
        </li>
        <li class="step">
          <b>包量重置</b>
          <span>{{ quotaResetText }}</span>
        </li>
        <li class="step">
          <b>高清原图</b>
          <span>{{ originalImageText }}</span>
        </li>
        <li class="step">
          <b>展示切片</b>
          <span>
            每方玺印以 {{ table.data.value.displaySlices.sliceCount }} 片切片下发，只计图片流量、不计调用次数。
          </span>
        </li>
      </ul>
    </div>

    <!-- ============ 07-5 订单列表 ============ -->
    <div class="block-head" style="margin-top:24px;">
      <h3>充值订单</h3><span class="rule"></span>
      <span class="note">
        订单终态不可逆；失败 / 超时后重新下单生成新订单号
        <template v-if="deepLinkSample">　｜　网址可带订单号直达本页：{{ deepLinkSample }}</template>
      </span>
    </div>

    <StateBlock :state="orders.state.value" empty-title="暂无订单" error-text="读取订单失败" @retry="loadAll">
      <div v-if="orders.data.value" class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>订单号</th><th>创建时间（CST）</th><th>金额</th><th>支付方式</th>
              <th>状态</th><th>关联流水</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="order in orders.data.value.items"
              :key="order.orderId"
              :class="{ 'row-focus': order.orderId === focusedOrderId }"
            >
              <td class="mono">{{ order.orderId }}</td>
              <td>{{ toCstDateTime(order.createdAt) }}</td>
              <td>{{ formatCents(order.amountCents) }}</td>
              <td>{{ payChannelLabel(order.channel) }}</td>
              <td><span class="state" :class="{ warn: order.status !== 'SETTLED' }">{{ orderStatusLabel(order.status) }}</span></td>
              <td class="mono">{{ order.ledgerEntryId || '—' }}</td>
              <td class="rowacts">
                <template v-if="isOpenOrder(order)">
                  <button type="button" @click="resumePay(order)">继续支付</button>
                  <button type="button" @click="closeOrder(order)">关闭</button>
                </template>
                <template v-else-if="order.status === 'SETTLED'">
                  <button type="button" @click="showOrderLedger(order)">查看流水</button>
                </template>
                <template v-else>
                  <button type="button" @click="reorder(order)">重新下单（新订单号）</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="note" style="margin-top:8px;">
          共 {{ orders.data.value.total }} 单，本页显示 {{ orders.data.value.items.length }} 单（第 {{ orders.data.value.page }} / {{ orders.data.value.totalPages }} 页）
        </p>
      </div>
    </StateBlock>

    <!-- ============ 07-6 / 07-7 账单流水（含筛选） ============ -->
    <div class="block-head" style="margin-top:24px;">
      <h3>账单流水</h3><span class="rule"></span>
      <span class="note">包量扣减与余额扣减是两种独立流水，分别记录次数与金额</span>
    </div>

    <div class="filters">
      <label for="billing-ledger-range" class="note">时间范围</label>
      <select id="billing-ledger-range" v-model="ledgerRange" @change="applyLedgerFilter">
        <option v-for="opt in ledgerRangeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <span class="note">类型多选</span>
      <button
        v-for="opt in ledgerTypeChoices"
        :key="opt.value"
        type="button"
        class="chip"
        :class="{ 'is-active': ledgerTypes.includes(opt.value) }"
        :aria-pressed="String(ledgerTypes.includes(opt.value))"
        @click="toggleLedgerType(opt.value)"
      >{{ opt.label }}</button>
      <button v-if="ledgerTypes.length" class="btn ghost sm" type="button" @click="resetLedgerFilter">重置类型</button>
    </div>

    <StateBlock :state="ledger.state.value" empty-title="当前筛选无流水" empty-text="可放宽时间范围或取消类型筛选" error-text="读取流水失败" @retry="loadLedger">
      <div v-if="ledger.data.value" class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时间（CST）</th><th>类型</th><th>方向</th><th>金额 / 次数</th>
              <th>关联单号 / 密钥</th><th>余额快照</th><th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in ledger.data.value.items" :key="entry.entryId" :class="{ 'row-focus': entry.relatedOrderId && entry.relatedOrderId === focusedOrderId }">
              <td>{{ toCstDateTime(entry.occurredAt) }}</td>
              <td>{{ ledgerTypeLabel(entry.type) }}</td>
              <td>{{ ledgerDirectionLabel(entry.direction) }}</td>
              <td>
                <template v-if="entry.amountCents">{{ formatCents(entry.amountCents) }}</template>
                <template v-else-if="entry.callCount">{{ formatCalls(entry.callCount) }}</template>
                <template v-else-if="entry.originalImageCount">{{ entry.originalImageCount }} 张</template>
                <template v-else>—</template>
              </td>
              <td class="mono">{{ entry.relatedOrderId || entry.relatedKid || '—' }}</td>
              <td>{{ formatCents(entry.balanceAfterCents) }}</td>
              <td class="note">{{ entry.remark || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="filters" style="margin-top:10px;">
          <span class="note">
            共 {{ ledger.data.value.total }} 条流水，第 {{ ledger.data.value.page }} / {{ ledger.data.value.totalPages }} 页
            （每页 {{ ledger.data.value.pageSize }} 条）
          </span>
          <button class="btn ghost sm" type="button" :disabled="ledger.data.value.page <= 1" @click="gotoLedgerPage(ledger.data.value.page - 1)">上一页</button>
          <button class="btn ghost sm" type="button" :disabled="ledger.data.value.page >= ledger.data.value.totalPages" @click="gotoLedgerPage(ledger.data.value.page + 1)">下一页</button>
        </div>
        <p class="note" style="margin-top:6px;">
          流水与充值订单是同一数据源的两个视图：入账后余额与流水同时变动，余额快照逐条可核对。
        </p>
      </div>
    </StateBlock>

    <!-- ============ 07-8 声明条 ============ -->
    <NoticeBar variant="disclaimer" style="margin-top:22px;">
      {{ disclaimerText }}（未接入支付渠道，所有金额为界面示意值）
    </NoticeBar>

    <!-- ============ 07-4 假扫码弹层 ============ -->
    <div
      class="modal"
      :class="{ show: pay.open }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="billing-pay-title"
      :aria-hidden="String(!pay.open)"
    >
      <div v-if="pay.open" class="modal-box">
        <h4 id="billing-pay-title">扫码支付（假支付闭环演示）</h4>
        <p class="note">
          订单号 <span class="mono">{{ pay.order.orderId }}</span>
          ｜ 状态 <b>{{ orderStatusLabel(pay.order.status) }}</b>
          ｜ 支付方式 {{ payChannelLabel(pay.order.channel) }}
        </p>
        <p class="pay-amt">{{ formatCents(pay.order.amountCents) }}</p>

        <div v-if="payPending" class="center">
          <div class="qr" aria-hidden="true">
            <i v-for="(cell, idx) in qrCells" :key="idx" :class="{ on: cell }"></i>
          </div>
          <p class="note">演示二维码，不可扫（纯 CSS 绘制占位，未接入支付渠道）</p>
          <p class="center">
            剩余支付时间 <b>{{ countdownText }}</b>（默认 {{ pendingTimeoutMinutes }} 分钟）
          </p>
          <label class="switchline">
            <input :checked="accel" type="checkbox" @change="onAccelToggle">
            <span>演示开关：加速到 {{ ACCEL_SECONDS }} 秒（仅用于演示超时分支）</span>
          </label>
        </div>

        <div v-else class="statusbar">
          <b>{{ payResultTitle }}</b>
          <p class="note" style="margin-top:6px;">{{ payResultText }}</p>
        </div>

        <p v-if="pay.notice" class="tip">{{ pay.notice }}</p>

        <div class="modal-acts demo-acts">
          <button type="button" @click="simulateSuccess">模拟支付成功（演示按钮）</button>
          <button type="button" @click="simulateFail">模拟支付失败（演示按钮）</button>
          <button type="button" :disabled="!payPending" @click="accelerateTimeout">加速超时（演示按钮）</button>
        </div>
        <div class="modal-acts">
          <button type="button" :disabled="!payPending" @click="cancelPay">关闭（取消订单）</button>
          <button type="button" @click="hidePayModal">收起弹层（保留待支付订单）</button>
        </div>
        <p class="note" style="margin-top:8px;">
          三个按钮均为演示按钮，不对应任何真实支付动作；重复点「模拟支付成功」不会重复入账。
        </p>
      </div>
    </div>
  </ConsoleShell>
</template>

<script setup>
/**
 * P-M1-07 充值账单（spec §1.3 要素 07-1 ～ 07-8；§5 假支付闭环状态机 T1–T8；§5.4 幂等与一致性）。
 *
 * 纪律：
 * - 所有数据一律经适配层（`@/data`）读写，页面不 import mock / 不 import 配置模块的金额数据；
 * - 金额档位、自定义区间、渠道、扣减顺序、重置口径、原图单价与免费额度**全部来自 A17 / A15 返回值**（§4.3）；
 * - 枚举一律经 `@/config/labels.js` 映射为中文后渲染，界面不出现任何 SNAKE_CASE 枚举或内部标识（§1.6）；
 * - 一致性自检（Σ流水 = 余额）取值来自 A15 的 `consistency`，页面不自行遍历求和（§5.4-5）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import ConsoleShell from '@/components/ConsoleShell.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import StateBlock from '@/components/StateBlock.vue'
import {
  createRechargeOrder, getAccount, getAppConfig, getPricingTable, getRechargeOrder,
  listLedgerEntries, listRechargeOrders, settleRechargeOrder, simulatePayResult, toCstDateTime,
} from '@/data'
import { formatCalls, formatCents } from '@/config/pricing.js'
import {
  deductionStepLabel, ledgerDirectionLabel, ledgerTypeLabel, ledgerTypeOptions,
  orderStatusLabel, payChannelLabel,
} from '@/config/labels.js'
import { useAsync } from '@/composables/useAsync.js'
import { toast, toastNotConnected } from '@/composables/useToast.js'

/** 演示态「加速超时」目标秒数（§5.3-3：把倒计时压到 30 秒）。 */
const ACCEL_SECONDS = 30
/** 未终态订单（可继续支付 / 可关闭）——仅用于界面分支，不参与渲染文本。 */
const OPEN_ORDER = Object.freeze(['CREATED', 'PENDING_PAY'])

const route = useRoute()
const table = useAsync(getPricingTable)
const config = useAsync(getAppConfig)
const account = useAsync(getAccount)
const orders = useAsync(listRechargeOrders)
const ledger = useAsync(listLedgerEntries)

const accountData = computed(() => account.data.value)
const tableData = computed(() => table.data.value)

/** 07-1：套餐档位名（由 A17 档位表 + A15 的 planId 解析，不硬编码）。 */
const planName = computed(() => {
  const rows = tableData.value?.rows || []
  const planId = accountData.value?.planId
  return (rows.find((r) => r.planId === planId) || rows[0])?.name || '未开通'
})

/** 07-1：年费状态（本年已缴 / 未缴 + 有效期）。 */
const annualFeeText = computed(() => {
  const until = accountData.value?.annualFeePaidUntil
  return until ? `本年已缴，有效期至 ${until}` : '本年未缴'
})

/** 07-2：档位 / 自定义 / 渠道 / 区间（全部来自配置插值）。 */
const rechargeCfg = computed(() => tableData.value?.recharge || { presetsCents: [], customRangeCents: {}, channels: [] })
const customMinYuan = computed(() => Number(rechargeCfg.value.customRangeCents?.min || 0) / 100)
const customMaxYuan = computed(() => Number(rechargeCfg.value.customRangeCents?.max || 0) / 100)
/** 展示「元」数值：由整数分换算，不含货币符号与小数尾巴（金额本身仍来自配置）。 */
function yuanText(cents) {
  const value = Number(cents) / 100
  return Number.isFinite(value) ? String(value) : '—'
}
/** 自定义区间文案（两侧金额均来自配置，页面不写字面量）。 */
const customRangeText = computed(() => `${yuanText(rechargeCfg.value.customRangeCents?.min)} – ${yuanText(rechargeCfg.value.customRangeCents?.max)} 元`)
/**
 * 界面可选档位 = 配置档位 ∩ 自定义区间 —— **硬保证「界面可选即可成功下单」**：
 * 任何超出区间的档位不会出现在界面上（§1.3 P-M1-07 规则 5 / AC-74）。
 */
const presetOptions = computed(() =>
  (rechargeCfg.value.presetsCents || [])
    .filter((cents) => cents >= rechargeCfg.value.customRangeCents?.min && cents <= rechargeCfg.value.customRangeCents?.max)
    .map((cents) => ({ cents, label: formatCents(cents) })),
)
const channelOptions = computed(() =>
  (rechargeCfg.value.channels || []).map((value) => ({ value, label: payChannelLabel(value) })),
)

const selectedPresetCents = ref(null)
const customActive = ref(false)
const customYuan = ref('')
const customError = ref('')
const channel = ref('')

/** 默认选中第一个可选档位与第一个渠道（候选项为空时留空，由界面提示）。 */
function initSelection() {
  if (selectedPresetCents.value === null && presetOptions.value.length) {
    selectedPresetCents.value = presetOptions.value[0].cents
  }
  if (!channel.value && channelOptions.value.length) channel.value = channelOptions.value[0].value
}

function selectPreset(cents) {
  customActive.value = false
  customError.value = ''
  selectedPresetCents.value = cents
}

function selectCustom() {
  customActive.value = true
  validateCustom()
}

/** 自定义金额硬校验：整数元、落在配置区间内；不合规当场拦下（不发起任何请求）。 */
function validateCustom() {
  const raw = String(customYuan.value ?? '').trim()
  if (!raw) {
    customError.value = `请输入 ${customRangeText.value} 之间的整数元`
    return null
  }
  if (!/^\d+$/.test(raw)) {
    customError.value = '金额须为整数元（不支持小数、符号或其它字符）'
    return null
  }
  const yuan = Number(raw)
  if (yuan < customMinYuan.value || yuan > customMaxYuan.value) {
    customError.value = `金额须在 ${customRangeText.value} 之间`
    return null
  }
  customError.value = ''
  return yuan
}

/** 当前待提交金额（分）；不可用时返回 null。 */
const amountCents = computed(() => {
  if (customActive.value) {
    const yuan = validateCustom()
    return yuan === null ? null : yuan * 100
  }
  return selectedPresetCents.value
})

const amountText = computed(() => (amountCents.value ? formatCents(amountCents.value) : '未选择金额'))

/** 最近一笔订单决定「去支付」可用性（§5.2 T6：超时后置灰「去支付」，另给「重新下单」）。 */
const latestOrder = computed(() => orders.data.value?.items?.[0] || null)
const needReorder = computed(() => !!latestOrder.value && ['EXPIRED', 'FAILED'].includes(latestOrder.value.status))
const payDisabled = computed(() => !amountCents.value || needReorder.value)
const payButtonLabel = computed(() => '去支付')
const payDisabledHint = computed(() => {
  if (!amountCents.value) return '请选择固定档位或填写合规的自定义金额后再去支付。'
  if (needReorder.value) return `上一笔订单状态：${orderStatusLabel(latestOrder.value.status)}；「去支付」已置灰，请点「重新下单」生成新订单号（旧单不可复用）。`
  return ''
})

/** 07-8：声明与开票占位（开关位来自 A1，页面不硬编码开关态）。 */
const disclaimerText = computed(() => tableData.value?.disclaimer || '本页金额、单价、用量数字均为界面示意值，非报价')
const invoiceOpen = computed(() => config.data.value?.featureFlags?.invoiceEntryOpen === true)

/** 结算说明文案（全部由配置插值，不在页面写字面口径）。 */
const annualFeeRelationText = computed(() => (tableData.value?.deduction?.annualFeeSeparatFromQuota
  ? '年费与月包量是两个并列收费项：年费不转化为包量，包量不抵扣年费。'
  : '年费与包量由同一账户结算。'))
const deductionOrderText = computed(() => {
  const steps = (tableData.value?.deduction?.order || []).map((step) => deductionStepLabel(step))
  return steps.length ? `计费调用按「${steps.join(' → ')}」的顺序扣减；包量耗尽后超出部分按该档超量单价从充值余额扣减。` : '计费调用按先包量、后余额的顺序扣减。'
})
const quotaResetText = computed(() => {
  const resetAt = tableData.value?.deduction?.quotaResetAt || ''
  const carry = tableData.value?.deduction?.quotaCarryOver
  return carry
    ? `${resetAt} 重置，未用余量结转到下月。`
    : `${resetAt} 重置，上月未用余量作废（包量不跨月结转）。`
})
const originalImageText = computed(() => {
  const q = tableData.value?.originalImageDownload
  if (!q) return '高清原图按张计价，不含在月包量内。'
  return `账号维度每日免费额度 ${q.freePerDay} 张（额度内不计费，按 ${q.timezone} 自然日 00:00 重置，同账号多密钥共享）；超出部分每张 ${formatCents(q.unitPriceCents)} 从充值余额扣减，不设每日金额上限，仅余额不足时拒绝；原图不占调用次数。`
})

// ---------------------------------------------------------------------------
// 假支付闭环（§5）：下单 → 待支付 → 成功 / 失败 / 超时 / 取消
// ---------------------------------------------------------------------------

const pay = reactive({ open: false, order: null, notice: '', tick: null })
const accel = ref(false)
const pendingTimeoutMinutes = computed(() => Number(config.data.value?.orderPendingTimeoutMinutes) || 15)
const payPending = computed(() => pay.order?.status === 'PENDING_PAY')
const countdownText = computed(() => {
  const total = remainSeconds.value
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

/** 剩余秒数：按订单的超时时刻重算（刷新 / 重新打开弹层都能恢复，§5.3-7）。 */
const nowTick = ref(Date.now())
/**
 * 「加速超时」的加速基准时刻（0 = 未加速）。
 *
 * §5.3-3 演示按钮「加速超时（倒计时压到 30 秒）」的**正确语义**：把该订单的**剩余有效期真正压到
 * 30 秒**，倒计时取 `expiresAt` 与加速基准二者**较早者**并**真实递减**，30 秒后**真正归零** →
 * 由 1 秒 tick 触发 T6（EXPIRED）。此前实现把**显示值** `Math.min(remain, 30)` 钳在 30 秒而不
 * 改写有效期，导致真实剩余 > 30s 时 `remainSeconds === 0` 永不成立、T6 在界面上不可达（D2）。
 */
const accelDeadline = ref(0)
const remainSeconds = computed(() => {
  if (!pay.order) return 0
  let deadline = Date.parse(pay.order.expiresAt)
  if (accel.value && accelDeadline.value) deadline = Math.min(deadline, accelDeadline.value)
  return Math.max(0, Math.ceil((deadline - nowTick.value) / 1000))
})

/**
 * 按下「加速超时」/ 勾选演示开关：写入加速基准 = now + 30s（等效于把该订单剩余有效期压到 30 秒），
 * 倒计时自此**从 30 秒起真实递减**并归零 → T6。取消勾选则恢复到订单自身的超时时刻。
 */
function accelerateTimeout() {
  if (!pay.order || !payPending.value) return
  accel.value = true
  accelDeadline.value = Date.now() + ACCEL_SECONDS * 1000
  nowTick.value = Date.now()
  toast(`加速超时已生效：该订单剩余有效期压到 ${ACCEL_SECONDS} 秒，倒计时归零即关闭（超时）`)
}

function releaseAccel() {
  accel.value = false
  accelDeadline.value = 0
  nowTick.value = Date.now()
}

function onAccelToggle(event) {
  if (event?.target?.checked) accelerateTimeout()
  else releaseAccel()
}

const payResultTitle = computed(() => {
  if (!pay.order) return ''
  switch (pay.order.status) {
    case 'SETTLED': return '支付成功（已支付）→ 已入账'
    case 'FAILED': return '支付失败'
    case 'EXPIRED': return '已关闭（超时）'
    case 'CANCELLED': return '已取消'
    case 'PAID': return '已支付（等待入账）'
    default: return orderStatusLabel(pay.order.status)
  }
})
const payResultText = computed(() => {
  if (!pay.order) return ''
  switch (pay.order.status) {
    case 'SETTLED':
      return `余额与流水已同时变动：+${formatCents(pay.order.amountCents)}；订单为终态，不可再变更。`
    case 'FAILED':
      return `失败原因：${pay.order.failReason || '渠道返回支付失败'}。余额不变、不产生流水；可重新下单（生成新订单号）。`
    case 'EXPIRED':
      return '倒计时归零，「去支付」已置灰；请在订单列表点「重新下单」生成新订单号。'
    case 'CANCELLED':
      return '订单已取消，无余额变动；可重新下单（生成新订单号）。'
    default:
      return '等待支付结果。'
  }
})

/** 纯 CSS 演示二维码：21×21 网格，格子由订单号派生（固定哈希，同一订单稳定）。 */
const qrCells = computed(() => {
  const orderId = pay.order?.orderId || ''
  let seed = 0
  for (let i = 0; i < orderId.length; i += 1) seed = (seed * 31 + orderId.charCodeAt(i)) >>> 0
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return (seed >>> 16) % 7 < 3
  }
  const N = 21
  const cells = []
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      let on = next()
      const inFinder = (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7)
      if (inFinder) {
        const lx = x >= N - 7 ? x - (N - 7) : x
        const ly = y >= N - 7 ? y - (N - 7) : y
        on = lx === 0 || lx === 6 || ly === 0 || ly === 6 || (lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4)
      }
      cells.push(on)
    }
  }
  return cells
})

function isOpenOrder(order) {
  return OPEN_ORDER.includes(order.status)
}

function startTick() {
  stopTick()
  pay.tick = window.setInterval(() => {
    nowTick.value = Date.now()
    if (remainSeconds.value === 0 && payPending.value) expireOrder()
  }, 1000)
}

function stopTick() {
  if (pay.tick) {
    window.clearInterval(pay.tick)
    pay.tick = null
  }
}

/** T1 下单 → T2 生成支付码（待支付）→ 打开弹层。 */
async function goPay() {
  if (amountCents.value === null || amountCents.value === undefined) {
    toast('金额校验未通过：请选择固定档位或填写合规的自定义金额（整数元，且在配置区间内）')
    return
  }
  try {
    const created = await createRechargeOrder({ amountCents: amountCents.value, channel: channel.value })
    const pending = await simulatePayResult(created.orderId, 'pay-code')
    openPayModal(pending)
    await refreshOrders()
    focusedOrderId.value = pending.orderId
    toast(`订单已创建 → 已生成支付码（待支付）：${pending.orderId}`)
  } catch (e) {
    toast(e?.message || '下单失败，请稍后重试')
  }
}

function openPayModal(order) {
  pay.order = order
  pay.notice = ''
  accel.value = false
  accelDeadline.value = 0
  pay.open = true
  nowTick.value = Date.now()
  if (order.status === 'PENDING_PAY') startTick()
  else stopTick()
}

function hidePayModal() {
  stopTick()
  pay.open = false
  if (pay.order && pay.order.status === 'PENDING_PAY') {
    toast('弹层已收起：订单仍为待支付，可在订单列表「继续支付」按超时时刻恢复倒计时')
  }
}

/**
 * 重复入账的幂等证据：用适配层返回值（而非页面自算）核对——同一订单的入账流水仍只有 1 条。
 * 页面只统计「返回条数」，不自行遍历金额求和（§5.4-5）。
 */
async function rechargeEntryCount(orderId) {
  try {
    const rows = await listLedgerEntries({}, { pageSize: 500 })
    return (rows?.items || []).filter((e) => e.relatedOrderId === orderId).length
  } catch {
    return null
  }
}

/** T3 支付成功 → T4 入账（幂等：重复触发只产生 1 条入账流水）。 */
async function simulateSuccess() {
  if (!pay.order) return
  try {
    const paid = await simulatePayResult(pay.order.orderId, 'success')
    const settled = await settleRechargeOrder(paid.orderId)
    pay.order = settled.order
    stopTick()
    await refreshAll()
    if (settled.idempotent) {
      pay.notice = '重复入账已被幂等拦截：同一订单只产生 1 条入账流水，余额与流水条数不变（一致性自检见页面顶部账户区）。'
      toast('该订单已入账：重复入账请求被幂等拦截（余额与流水条数不变）')
    } else {
      pay.notice = `已入账：余额 +${formatCents(settled.order.amountCents)}，流水表顶部新增「充值入账」行（金额与余额快照逐条可核对）。`
      toast('支付成功 → 已入账：余额与流水同时变动')
    }
    focusedOrderId.value = settled.order.orderId
  } catch (e) {
    if (e?.code === 'ORDER_TERMINAL') {
      // 终态订单被重复点击 → 再走一次入账，用真实返回证明幂等（§5.4 / AC-29）
      try {
        const again = await settleRechargeOrder(pay.order.orderId)
        const count = await rechargeEntryCount(pay.order.orderId)
        pay.order = again.order
        await refreshAll()
        pay.notice = `重复点击未产生新入账：订单已是终态「${orderStatusLabel(again.order.status)}」，再次入账返回幂等命中`
          + `${count === null ? '' : `，该订单的入账流水仍为 ${count} 条`}；余额与流水条数不变。`
        toast(count === null
          ? '订单已是终态：重复入账被幂等拦截（余额与流水条数不变）'
          : `订单已是终态：重复入账被幂等拦截（该订单入账流水仍为 ${count} 条，余额不变）`)
      } catch (inner) {
        toast(inner?.message || '重复入账校验失败')
      }
      return
    }
    toast(e?.message || '支付失败，请重试')
  }
}

/** T5 支付失败：余额不变、不产生流水。 */
async function simulateFail() {
  if (!pay.order) return
  try {
    const failed = await simulatePayResult(pay.order.orderId, 'fail')
    pay.order = failed
    stopTick()
    await refreshAll()
    pay.notice = '支付失败：余额不变、不产生流水；可重新下单（生成新订单号）。'
    toast('支付失败：余额不变、未产生流水')
  } catch (e) {
    toast(e?.message || '订单已终态，不可再变更')
  }
}

/** T6 超时：倒计时归零 → 已关闭（超时），「去支付」置灰。 */
async function expireOrder() {
  if (!pay.order) return
  try {
    const expired = await simulatePayResult(pay.order.orderId, 'timeout')
    pay.order = expired
    stopTick()
    await refreshAll()
    pay.notice = '倒计时归零：订单已关闭（超时），「去支付」已置灰，请「重新下单」生成新订单号。'
    toast('支付超时：订单已关闭（超时），可在订单列表「重新下单」')
  } catch (e) {
    stopTick()
    toast(e?.message || '关闭订单失败')
  }
}

/** T7 用户主动关闭 → 已取消（零副作用）。 */
async function cancelPay() {
  if (!pay.order) return
  try {
    const cancelled = await simulatePayResult(pay.order.orderId, 'cancel')
    pay.order = cancelled
    stopTick()
    await refreshAll()
    pay.notice = '订单已取消：无余额变动，可重新下单（生成新订单号）。'
    toast('订单已取消：无余额变动')
  } catch (e) {
    toast(e?.message || '订单不可取消')
  }
}

/** 订单列表：继续支付（T2 幂等）→ 恢复弹层与倒计时。 */
async function resumePay(order) {
  try {
    const resumed = await simulatePayResult(order.orderId, 'pay-code')
    openPayModal(resumed)
    focusedOrderId.value = resumed.orderId
    await refreshOrders()
    if (resumed.status === 'EXPIRED') toast('该订单已超时关闭，请重新下单')
    else toast(`已恢复待支付订单 ${resumed.orderId}（按超时时刻重算剩余时间）`)
  } catch (e) {
    toast(e?.message || '无法恢复该订单')
  }
}

/** 订单列表：关闭（取消）→ T7。 */
async function closeOrder(order) {
  try {
    const cancelled = await simulatePayResult(order.orderId, 'cancel')
    if (pay.order && pay.order.orderId === cancelled.orderId) {
      pay.order = cancelled
      stopTick()
    }
    await refreshAll()
    toast(`订单 ${cancelled.orderId} 已取消：无余额变动`)
  } catch (e) {
    toast(e?.message || '订单不可取消')
  }
}

/** T8 重新下单：不复用旧订单号。 */
async function reorder(order) {
  if (order?.orderId) toast(`重新下单：将为本次支付生成新的订单号（原订单 ${order.orderId} 保持终态，不复用）`)
  else toast('重新下单：将生成新的订单号（旧单不复用）')
  await goPay()
}

/** 订单列表：查看流水 → 定位到该订单的入账流水。 */
async function showOrderLedger(order) {
  focusedOrderId.value = order.orderId
  ledgerRange.value = '30d'
  ledgerTypes.value = []
  ledgerPage.value = 1
  await loadLedger()
  const hit = (ledger.data.value?.items || []).some((e) => e.relatedOrderId === order.orderId)
  toast(hit
    ? `订单 ${order.orderId} 已入账，流水见下方「充值入账」行`
    : '该订单的入账流水不在当前筛选范围内（可放宽时间范围）')
}

function notifyInvoice() {
  toastNotConnected(invoiceOpen.value ? '演示环境：开票通路未接入' : '演示环境：开票入口即将开放')
}

// ---------------------------------------------------------------------------
// 07-7 流水筛选（时间范围 + 类型多选）与分页
// ---------------------------------------------------------------------------

const ledgerRangeOptions = Object.freeze([
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
  { value: 'today', label: '今日' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
])
const ledgerRange = ref('30d')
const ledgerTypes = ref([])
const ledgerPage = ref(1)
const ledgerTypeChoices = ledgerTypeOptions()
const focusedOrderId = ref('')

async function loadLedger() {
  // D1：时间范围原样交给适配层（range→{from,to} 换算只在适配层一处完成，页面不各自换算）。
  await ledger.run({ types: [...ledgerTypes.value], range: ledgerRange.value }, { page: ledgerPage.value, pageSize: 20 })
}

async function applyLedgerFilter() {
  ledgerPage.value = 1
  await loadLedger()
}

async function toggleLedgerType(type) {
  ledgerTypes.value = ledgerTypes.value.includes(type)
    ? ledgerTypes.value.filter((t) => t !== type)
    : [...ledgerTypes.value, type]
  await applyLedgerFilter()
}

async function resetLedgerFilter() {
  ledgerTypes.value = []
  await applyLedgerFilter()
}

async function gotoLedgerPage(page) {
  ledgerPage.value = Math.max(1, page)
  await loadLedger()
}

// ---------------------------------------------------------------------------
// 装载与深链（§5.3-7：/console/billing?orderId=… 可恢复待支付订单的倒计时）
// ---------------------------------------------------------------------------

async function refreshOrders() {
  await orders.run({})
  initSelection()
}

async function refreshAll() {
  const results = await Promise.all([account.run(), orders.run({}), loadLedger()])
  void results
  initSelection()
}

async function loadAll() {
  await Promise.all([table.run(), config.run(), refreshAll()])
}

/** 深链示例：用真实存在的订单号（可复制可用，不留省略号）。 */
const deepLinkSample = computed(() => {
  const id = orders.data.value?.items?.[0]?.orderId
  return id ? `/console/billing?orderId=${id}` : ''
})

async function focusOrderFromQuery(orderId) {
  try {
    const order = await getRechargeOrder(orderId)
    focusedOrderId.value = order.orderId
    if (isOpenOrder(order)) {
      await resumePay(order)
      return
    }
    toast(`订单 ${order.orderId} 当前状态：${orderStatusLabel(order.status)}（终态不可再变更）`)
  } catch (e) {
    toast(e?.message || '订单不存在')
  }
}

onMounted(async () => {
  await loadAll()
  const orderId = route.query?.orderId
  if (orderId) await focusOrderFromQuery(String(orderId))
})

onUnmounted(stopTick)
</script>

<style scoped>
.row-focus td { background: var(--brand-tint); }
/* 结算说明用列表形态展示步骤卡（复用 .steps / .step 样式） */
.steps li.step { list-style: none; min-width: 100%; }
</style>
