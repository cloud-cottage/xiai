<template>
  <ConsoleShell crumb="控制台 / 密钥管理" spec-ref="P-M1-05">
    <!-- 05-7 声明（全站声明条）：对客文案不含任何内部标识 -->
    <NoticeBar variant="status">
      <b>密钥为界面示意值，不产生真实凭据</b> —— 列表只显示掩码；
      完整密钥仅在创建 / 重生的当次弹层中出现一次，关闭后无法再次查看，请立即复制保存。
    </NoticeBar>

    <div class="block-head" style="margin-top:18px;">
      <h3>密钥列表</h3><span class="rule"></span>
      <span class="note">{{ summaryText }}</span>
      <button class="btn ghost sm" type="button" :disabled="keys.loading.value" @click="load()">刷新列表</button>
      <button class="btn sm" type="button" :disabled="createDisabled" :aria-disabled="createDisabled" @click="openCreate()">
        新建密钥
      </button>
    </div>

    <!-- 05-2 数量上限：达上限时按钮禁用并提示（上限值来自站点配置，非页面字面量） -->
    <p v-if="limitReached" class="note limit-note" role="status">
      已达密钥数量上限（{{ limit }} 个）：如需新增，请先删除或停用不再使用的密钥。
    </p>

    <StateBlock
      :state="keys.state.value"
      empty-title="尚无密钥，点击新建"
      empty-text="创建后完整密钥只显示一次；此后列表与详情一律只显示掩码。"
      error-text="读取密钥列表失败，请稍后重试"
      @retry="load()"
    >
      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>备注名</th><th>密钥 ID</th><th>前缀与掩码</th><th>环境</th><th>scopes</th>
              <th>状态</th><th>创建时间（CST）</th><th>最近使用（CST）</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in list" :key="key.kid">
              <td>{{ key.label }}</td>
              <td class="mono">{{ key.kid }}</td>
              <td class="mask mono">{{ key.maskedKey }}</td>
              <td>{{ envText(key.env) }}</td>
              <td class="note">{{ key.scopes.join('、') }}</td>
              <td>
                <span class="state" :class="{ warn: key.status !== API_KEY_STATUS.ACTIVE }">{{ statusText(key.status) }}</span>
              </td>
              <td class="note">
                {{ toCstDateTime(key.createdAt) }}
                <template v-if="key.rotatedAt"><br />轮换 {{ toCstDateTime(key.rotatedAt) }}</template>
              </td>
              <td class="note">{{ key.lastUsedAt ? toCstDateTime(key.lastUsedAt) : '—' }}</td>
              <td class="rowacts">
                <button type="button" :disabled="busy" @click="askStatus(key)">
                  {{ key.status === API_KEY_STATUS.ACTIVE ? '禁用' : '启用' }}
                </button>
                <button type="button" :disabled="busy" @click="askRotate(key)">重生</button>
                <button type="button" :disabled="busy" @click="askDelete(key)">删除</button>
                <!-- 明文只此一次：已展示过明文的密钥，行内永久置灰，二次点击不重现明文 -->
                <button
                  v-if="shownKids.includes(key.kid)"
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="该密钥的明文本次已展示过，无法再次查看"
                >明文已展示</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note" style="margin-top:10px;">
        共 {{ list.length }} 个密钥 · 密钥 ID 非机密，可用于日志与用量归属；时间均为北京时间（CST）。
      </p>
    </StateBlock>

    <!-- ===================== 05-6 使用说明区 ===================== -->
    <div class="block-head" style="margin-top:24px;">
      <h3>使用说明</h3><span class="rule"></span>
    </div>
    <div class="card">
      <span class="field-label">鉴权头示例形态（占位片段，请替换为你自己的密钥）</span>
      <div class="plain" id="auth-header-sample">Authorization: Bearer &lt;你的密钥&gt;</div>
      <ul class="usage-list">
        <li><b>明文只显示一次</b>：创建或重生成功后请立即复制保存；关闭弹层后任何入口都无法再次取回明文。</li>
        <li><b>禁用 / 启用即时生效</b>：禁用后该密钥的请求一律被拒绝，可随时重新启用；禁用不删除记录。</li>
        <li><b>重生</b>：密钥 ID 不变，明文被替换、旧明文立即失效，并更新轮换时间。</li>
        <li><b>删除</b>：记录被移除，已产生的用量记录不删除，仍保留原密钥归属。</li>
        <li><b>泄露处置建议</b>：第一时间禁用或重生该密钥，再排查调用来源与用量异常。</li>
        <li>
          <b>权限范围（scopes）</b>：检索与详情（seal:search）、预览图与展示切片（image:preview）、
          高清原图取图 / 下载（image:original）、读取自己的用量（usage:read）。
        </li>
      </ul>
    </div>

    <!-- ===================== 05-2 新建密钥弹层 ===================== -->
    <div v-if="createOpen" class="modal show" role="dialog" aria-modal="true" aria-labelledby="key-create-title">
      <div class="modal-box">
        <h4 id="key-create-title">新建密钥</h4>
        <div class="field">
          <label for="key-label">备注名</label>
          <input id="key-label" v-model="formLabel" type="text" maxlength="24" placeholder="例如：展陈联调" />
        </div>
        <div class="field">
          <span class="field-label">环境</span>
          <div class="radios">
            <label><input v-model="formEnv" type="radio" :value="ENV.TEST" /> 测试环境</label>
            <label><input v-model="formEnv" type="radio" :value="ENV.LIVE" /> 正式环境</label>
          </div>
        </div>
        <fieldset class="scopebox">
          <legend>权限范围（scopes，至少一项）</legend>
          <label v-for="scope in SCOPE_OPTIONS" :key="scope.value">
            <input v-model="formScopes" type="checkbox" :value="scope.value" /> {{ scope.label }}
          </label>
        </fieldset>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
        <div class="modal-acts">
          <button class="btn sm" type="button" :disabled="busy" @click="submitCreate()">
            {{ busy ? '创建中…' : '创建密钥' }}
          </button>
          <button class="btn ghost sm" type="button" :disabled="busy" @click="createOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- ===================== 05-3 一次性明文展示区（仅此一次） ===================== -->
    <div v-if="plaintextOpen" class="modal show" role="dialog" aria-modal="true" aria-labelledby="key-plain-title">
      <div class="modal-box">
        <h4 id="key-plain-title">{{ plaintextTitle }}</h4>

        <template v-if="plaintext">
          <NoticeBar variant="warn" title="请立即复制保存">关闭后无法再次查看，列表与详情此后只显示掩码。</NoticeBar>
          <div ref="plainRef" class="plain" id="key-plaintext">{{ plaintext }}</div>
          <p class="note">
            密钥 ID：<span class="mono">{{ plaintextKid }}</span>
            ｜{{ plaintextEnv === ENV.LIVE ? '正式环境' : '测试环境' }}
            <template v-if="plaintextRotatedAt"><br />轮换时间（CST）：{{ toCstDateTime(plaintextRotatedAt) }}</template>
          </p>
          <div class="modal-acts">
            <button class="btn sm" type="button" @click="copyPlaintext()">{{ copied ? '已复制' : '复制' }}</button>
            <button class="btn ghost sm" type="button" @click="ackPlaintext()">我已保存</button>
          </div>
        </template>

        <!-- 置灰「已展示」态：明文已从内存丢弃，弹层内也不再提供任何重现入口 -->
        <template v-else>
          <div class="plain-shown" id="key-plaintext-shown">
            <b>已展示</b>
            <span>明文已从本页移除，无法再次查看；如已丢失，请对该密钥执行一次「重生」。</span>
          </div>
          <div class="modal-acts">
            <button class="btn ghost sm" type="button" @click="closePlaintext()">关闭</button>
          </div>
        </template>
      </div>
    </div>

    <!-- ===================== 05-4 行级操作二次确认（禁用/启用、重生、删除） ===================== -->
    <div v-if="confirmState.open" class="modal show" role="dialog" aria-modal="true" aria-labelledby="key-confirm-title">
      <div class="modal-box sm">
        <h4 id="key-confirm-title">{{ confirmState.title }}</h4>
        <p class="note">{{ confirmState.message }}</p>
        <p class="note">
          密钥 ID：<span class="mono">{{ confirmState.kid }}</span>（{{ confirmState.label }}）
        </p>
        <div class="modal-acts">
          <button class="btn sm" type="button" :disabled="busy" @click="runConfirm()">
            {{ busy ? '处理中…' : confirmState.confirmLabel }}
          </button>
          <button class="btn ghost sm" type="button" :disabled="busy" @click="closeConfirm()">取消</button>
        </div>
      </div>
    </div>
  </ConsoleShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ConsoleShell from '@/components/ConsoleShell.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import StateBlock from '@/components/StateBlock.vue'
import {
  API_KEY_STATUS,
  ENV,
  SCOPES,
  createApiKey,
  deleteApiKey,
  getAppConfig,
  listApiKeys,
  rotateApiKey,
  setApiKeyStatus,
  toCstDateTime,
} from '@/data'
import { useAsync } from '@/composables/useAsync.js'
import { toast } from '@/composables/useToast.js'

/** 05-1 列表（无明文）。 */
const keys = useAsync(listApiKeys)
/** 05-2 数量上限：站点配置驱动，页面零硬编码。 */
const appConfig = useAsync(getAppConfig, { immediate: true })

const list = computed(() => (Array.isArray(keys.data.value) ? keys.data.value : []))
const limit = computed(() => Number(appConfig.data.value?.apiKeyLimit) || 0)
/** 05-2 交互 4：达到数量上限 → 新建按钮禁用并提示。 */
const limitReached = computed(() => limit.value > 0 && list.value.length >= limit.value)

const summaryText = computed(() => {
  if (!list.value.length) return ''
  const active = list.value.filter((k) => k.status === API_KEY_STATUS.ACTIVE).length
  return `共 ${list.value.length} 个 · 启用 ${active} 个 · 已禁用 ${list.value.length - active} 个`
})

function load() {
  return keys.run()
}

// ---------------------------------------------------------------------------
// 表单 / 弹层状态
// ---------------------------------------------------------------------------
const busy = ref(false)
const createOpen = ref(false)
const formLabel = ref('')
const formEnv = ref(ENV.TEST)
const formScopes = ref(['seal:search'])
const formError = ref('')
const createDisabled = computed(() => limitReached.value || busy.value)

const SCOPE_OPTIONS = [
  { value: SCOPES[0], label: '检索与详情（seal:search）' },
  { value: SCOPES[1], label: '预览图与展示切片（image:preview）' },
  { value: SCOPES[2], label: '高清原图取图 / 下载（image:original）' },
  { value: SCOPES[3], label: '读取自己的用量（usage:read）' },
]

/** 明文态：只在创建 / 重生当次响应里存在；关闭即丢弃，列表只留掩码。 */
const plaintextOpen = ref(false)
const plaintext = ref(null)
const plaintextKid = ref('')
const plaintextEnv = ref(ENV.TEST)
const plaintextKind = ref('create')
const plaintextRotatedAt = ref(null)
const copied = ref(false)
const plainRef = ref(null)
/** 本会话内已展示过明文的密钥 ID：行内永久置灰「明文已展示」，二次点击不重现明文。 */
const shownKids = ref([])

const plaintextTitle = computed(() => (plaintextKind.value === 'rotate' ? '重生成功：新明文（仅显示一次）' : '创建成功：密钥明文（仅显示一次）'))

const confirmState = ref({
  open: false,
  kind: '',
  kid: '',
  label: '',
  title: '',
  message: '',
  confirmLabel: '确认',
  nextStatus: API_KEY_STATUS.ACTIVE,
})

function envText(env) {
  return env === ENV.LIVE ? 'live' : 'test'
}

function statusText(status) {
  return status === API_KEY_STATUS.ACTIVE ? '启用中' : '已禁用'
}

/** 列表以 A5 返回为权威；A6/A7/A8 返回单条、A9 无返回，本地同步一份避免额外往返。 */
function upsertKey(key) {
  const current = list.value
  const index = current.findIndex((k) => k.kid === key.kid)
  keys.data.value = index < 0 ? [...current, key] : current.map((k) => (k.kid === key.kid ? key : k))
}

function markShown(kid) {
  if (!kid || shownKids.value.includes(kid)) return
  shownKids.value = [...shownKids.value, kid]
}

// ---------------------------------------------------------------------------
// 05-2 新建
// ---------------------------------------------------------------------------
function openCreate() {
  if (limitReached.value) {
    toast(`密钥数量已达上限（${limit.value} 个）：请先删除或停用不再使用的密钥`)
    return
  }
  formLabel.value = ''
  formEnv.value = ENV.TEST
  formScopes.value = ['seal:search']
  formError.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (busy.value) return
  const label = String(formLabel.value || '').trim()
  if (!label) {
    formError.value = '请填写备注名'
    return
  }
  if (!formScopes.value.length) {
    formError.value = '请至少勾选一项权限范围'
    return
  }
  formError.value = ''
  busy.value = true
  try {
    const result = await createApiKey({ label, env: formEnv.value, scopes: [...formScopes.value] })
    upsertKey(result.key)
    createOpen.value = false
    showPlaintext(result.key, result.plaintextOnce, 'create')
  } catch (err) {
    formError.value = err?.message || '创建失败，请重试'
    toast(formError.value)
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------
// 05-3 一次性明文：展示 → 复制 → 「我已保存」→ 置灰「已展示」且不再重现
// ---------------------------------------------------------------------------
function showPlaintext(key, plain, kind) {
  if (typeof plain !== 'string' || !plain) {
    toast('本次未返回明文：明文只在创建 / 重生的当次响应中出现一次')
    return
  }
  plaintextKid.value = key.kid
  plaintextEnv.value = key.env
  plaintextKind.value = kind
  plaintextRotatedAt.value = key.rotatedAt || null
  plaintext.value = plain
  copied.value = false
  plaintextOpen.value = true
}

/** 「我已保存」：明文从内存丢弃 → 弹层切到置灰「已展示」态 → 行内同步置灰。 */
function ackPlaintext() {
  markShown(plaintextKid.value)
  plaintext.value = null
}

/** 关闭：无论从「我已保存」还是直接关闭，明文都被丢弃；此后无任何入口可再取回。 */
function closePlaintext() {
  if (plaintextKid.value) markShown(plaintextKid.value)
  plaintextOpen.value = false
  plaintext.value = null
  plaintextRotatedAt.value = null
  copied.value = false
}

function selectPlaintextText() {
  const el = plainRef.value
  if (!el || typeof window === 'undefined' || !window.getSelection) return
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  } catch (err) {
    void err
  }
}

/** 交互 6：复制成功提示；剪贴板不可用时降级为「请手动选中复制」。 */
async function copyPlaintext() {
  const text = plaintext.value
  if (!text) return
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      copied.value = true
      toast('已复制到剪贴板')
      return
    } catch (err) {
      void err
    }
  }
  selectPlaintextText()
  toast('剪贴板不可用：请手动选中复制')
}

// ---------------------------------------------------------------------------
// 05-4 行级操作（禁用/启用、重生、删除，均需二次确认）
// ---------------------------------------------------------------------------
function askStatus(key) {
  const disabling = key.status === API_KEY_STATUS.ACTIVE
  confirmState.value = {
    open: true,
    kind: 'status',
    kid: key.kid,
    label: key.label,
    title: disabling ? '确认禁用该密钥？' : '确认启用该密钥？',
    message: disabling
      ? '禁用后该密钥的请求会立即被拒绝；记录保留，可随时重新启用。'
      : '启用后该密钥恢复可用，可继续用于检索与取图。',
    confirmLabel: disabling ? '确认禁用' : '确认启用',
    nextStatus: disabling ? API_KEY_STATUS.DISABLED : API_KEY_STATUS.ACTIVE,
  }
}

function askRotate(key) {
  confirmState.value = {
    open: true,
    kind: 'rotate',
    kid: key.kid,
    label: key.label,
    title: '确认重生该密钥？',
    message: '重生会立即替换明文（密钥 ID 不变、轮换时间更新），原明文立即失效；新明文只显示一次。',
    confirmLabel: '确认重生',
    nextStatus: key.status,
  }
}

function askDelete(key) {
  confirmState.value = {
    open: true,
    kind: 'delete',
    kid: key.kid,
    label: key.label,
    title: '确认删除该密钥？',
    message: '删除后该密钥记录被移除，操作不可撤销；已产生的用量记录会保留原密钥归属。',
    confirmLabel: '确认删除',
    nextStatus: key.status,
  }
}

function closeConfirm() {
  confirmState.value = { ...confirmState.value, open: false }
}

async function runConfirm() {
  const state = confirmState.value
  if (!state.open || busy.value) return
  busy.value = true
  try {
    if (state.kind === 'status') {
      const updated = await setApiKeyStatus(state.kid, state.nextStatus)
      upsertKey(updated)
      toast(state.nextStatus === API_KEY_STATUS.DISABLED ? '已禁用：该密钥的请求将立即被拒绝' : '已启用')
    } else if (state.kind === 'rotate') {
      const result = await rotateApiKey(state.kid)
      upsertKey(result.key)
      showPlaintext(result.key, result.plaintextOnce, 'rotate')
      toast('已重生：密钥 ID 不变，旧明文立即失效，请复制保存新明文')
    } else if (state.kind === 'delete') {
      await deleteApiKey(state.kid)
      keys.data.value = list.value.filter((k) => k.kid !== state.kid)
      toast('已删除该密钥：用量记录保留原密钥归属')
    }
    closeConfirm()
  } catch (err) {
    toast(err?.message || '操作失败，请重试')
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------
// 无障碍：Esc 关闭当前弹层
// ---------------------------------------------------------------------------
function onKeydown(event) {
  if (event.key !== 'Escape' || busy.value) return
  if (confirmState.value.open) closeConfirm()
  else if (createOpen.value) createOpen.value = false
  else if (plaintextOpen.value) closePlaintext()
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.limit-note { margin: 6px 0 10px; }
.usage-list { margin-top: 4px; }
.usage-list li {
  font-size: var(--fs-13);
  color: var(--ink-2);
  padding: 4px 0;
  border-bottom: var(--border-dashed);
  line-height: 1.7;
}
.usage-list li:last-child { border-bottom: 0; }
.usage-list b { color: var(--ink); font-weight: normal; }
/* 置灰「已展示」态：与明文区同一位置，视觉上明确不可再取 */
.plain-shown {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  background: var(--panel-alt);
  border: var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-6);
  margin-bottom: var(--sp-4);
}
.plain-shown b { color: var(--faint); font-size: var(--fs-15); letter-spacing: var(--ls-2); font-weight: normal; }
.plain-shown span { font-size: var(--fs-13); color: var(--faint); }
</style>
