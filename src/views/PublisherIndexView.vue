<script setup>
/**
 * 梓行匯溯（`/publishers`）—— 出版社（publisher）管理页（本單新增）。
 * ===================================================================
 * 形态照 `BookIndexView.vue`（同级做法）：
 *   · **页面本体做管理员门**：非管理员 / 未登录 ⇒ 只渲染一段提示（`data-publishers-denied`）
 *     且**零出版社数据请求**（读面 computed 一律先过 `canManage`，不得先取后藏）；
 *     路由**不设 `requiresAuth`**（未登录也能落到「请先登录」提示，而不是被守门静默改写路径）；
 *   · **判权单点** ＝ `services/admin.js::isAdminSession()`（＝ `data/session.js` 的 `isAdmin`，
 *     与 `/books` 同一取法；**本页不自造第二套 role 判定**）；
 *   · **数据面只经服务层门面** `services/publishers.js`（不直碰 `data/*`、不直调云函数）：
 *     `searchPublishers` / `publisherLabel` / `putPublisher`（`upsertPublisher` ＝ 兼容别名）/
 *     `addIsbnCode` / `removeIsbnCode`；**op 名只一个 ＝ `putPublisher`**（发号在服务端，
 *     本页不预领号、不自造号）。
 *
 * 内容面（缺一即不算交付）：
 *   ① 名录 ＋ 搜索（名稱 / 別名 / 代號 / `PB` 碼）＋ 性質篩選；
 *   ② 新建（**`_id = code` 由号段账本发**，页面不填号、不自造号）；
 *   ③ 编辑（名稱 / 繁體名 / `org_type` / `isbn_prefix` / `isbn_group` / 別名 / 地域 / 創立年 / 備註）；
 *   ④ 号段表（`isbn_publisher_codes`）就地增删 —— 行内【加 / ×】走服务层
 *      `addIsbnCode` / `removeIsbnCode`（编辑器内的是草稿，随【儲存】一起提交）。
 *
 * 口径红线（照 xiai.spec §3.107）：
 *   · **不以名字当身份**：同一性只认 `_id` / `code`；两家分列不合并
 *     （`西泠印社`＝society、`西泠印社出版社`＝publisher、`上海西泠印社`＝unknown 待考）；
 *   · **`org_type` 恆三值**、`isbn_prefix` 恆两值、号段 `status` 恆 `current` / `legacy`
 *     —— 越界由服务层拒（`INVALID_VALUE` ＋零写入），本页只给封闭选项、不给自由输入；
 *   · **上屏文案一律繁體**；空值显示 `—`（零 `undefined` / `null` / `NaN`）。
 */
import { computed, ref } from 'vue'
import { isLoggedIn } from '../data/session.js'
import { ADMIN_LABEL } from '../data/roleLabels.js'
import { admin, publishers } from '../services/index.js'
/* 管理员专属入口按钮的角标（唯一实现；配 `.btn--admin` 虚线轮廓）。 */
import AdminBadge from '../components/AdminBadge.vue'

/* ------------------------------ 权限门（判权单点 ＝ isAdminSession） ------------------------------ */
const canManage = computed(() => admin.isAdminSession())

const denialMessage = computed(() => {
  if (!isLoggedIn.value) return `此頁僅${ADMIN_LABEL}可用，請先登錄${ADMIN_LABEL}帳號。`
  return `此頁僅${ADMIN_LABEL}可用。`
})

/* ------------------------------ 读面（只读；非管理员恒零请求） ------------------------------ */
const query = ref('')
const orgFilter = ref('')

/**
 * **读面代次**：`storageGeneration()`（`data/storage.js`）是**非响应式**的模块级计数 —— 写盘会
 * 递增它、`readCollection` 的读缓存也会失效，但 Vue **不会**因它重算 computed。故本页自持一个
 * `revision` ref：**每次写成功 ＋1**，让 `rows`（及其下游 `visible` / `totalLabel`）重算 ⇒
 * 写完立刻在读面上看到新行，**不靠 toast / 不靠整页刷新**。
 */
const revision = ref(0)

function refreshReadFace() {
  revision.value += 1
}

/** `org_type` 三值的上屏名（**封闭映射**，与服务层 `PUBLISHER_ORG_TYPES` 同集）。 */
const ORG_TYPE_LABELS = { publisher: '出版法人', society: '社團（非出版法人）', unknown: '待考' }

/** 名录（搜索 ＋ 性質篩選；**先过 `canManage`** ⇒ 未登录 / 非管理员零读取；随 `revision` 重算）。 */
const rows = computed(() => {
  void revision.value
  return canManage.value ? publishers.searchPublishers(query.value) : []
})

const visible = computed(() => {
  const pick = orgFilter.value
  if (!pick) return rows.value
  return rows.value.filter((row) => (row.org_type || 'publisher') === pick)
})

const totalLabel = computed(() => String(visible.value.length))

/* ------------------------------ 行派生（只读） ------------------------------ */

function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function orgTypeLabel(row) {
  const key = textOf(row && row.org_type) || 'publisher'
  return ORG_TYPE_LABELS[key] || key
}

function nameOf(row) {
  return textOf(row && row.name_cht) || textOf(row && row.name) || '—'
}

function codesOf(row) {
  const list = row && Array.isArray(row.isbn_publisher_codes) ? row.isbn_publisher_codes : []
  return list.filter((item) => item && typeof item === 'object')
}

function aliasesOf(row) {
  const list = row && Array.isArray(row.aliases) ? row.aliases : []
  const joined = list.map((item) => textOf(item)).filter((item) => item !== '').join('、')
  return joined || '—'
}

function statusLabel(status) {
  return textOf(status) === 'legacy' ? '舊' : '現'
}

/* ------------------------------ 反馈（消息 ＋ 结构化 reason） ------------------------------ */
const feedback = ref('')
/** 本次失败的 `reason` 码（成功 ⇒ 空串）；上屏见 `REASON_LABELS` ＋ 原因码双显。 */
const feedbackReason = ref('')

/**
 * **reason → 可读中文（封闭映射，只列本页会见到的冻结字面值）**；未列到的码**原样显示码本身**
 * （不猜、不改写服务端文案）。显示形态恒为「中文（REASON）」⇒ 既有码可查、文案可读。
 */
const REASON_LABELS = Object.freeze({
  FORBIDDEN: `權限不足（僅${ADMIN_LABEL}可寫；或寫入憑證缺失）`,
  INVALID_VALUE: '值域不符（越界值／形態不合，已零寫入）',
  INVALID_FIELD: '載荷欄位不合法（含未知欄位／新建自帶 code）',
  LOGIN_REQUIRED: '請先登錄後再寫（寫入憑證缺失）',
  STORAGE_UNAVAILABLE: '儲存面暫不可用（可重試）',
  MISSING_REQUIRED: '缺少必填欄位',
  NOT_FOUND: '查無此行',
  DUPLICATE_VALUE: '鍵值重複'
})

function reasonText(reason) {
  const key = textOf(reason)
  if (!key) return ''
  const label = REASON_LABELS[key]
  return label ? `${label}（${key}）` : key
}

/** 落反馈：`reason` 给了 ⇒ 失败面（消息区带 `data-publishers-feedback-reason`）。 */
function say(message, reason) {
  feedback.value = textOf(message)
  feedbackReason.value = textOf(reason)
}

/* ------------------------------ 号段行内增删（既有行即时生效） ------------------------------ */
const quickCode = ref({ code: '', status: 'current' })

async function quickAddCode(row) {
  const code = textOf(quickCode.value.code)
  if (!code) return
  const result = await publishers.addIsbnCode(textOf(row._id || row.code), {
    code,
    status: quickCode.value.status === 'legacy' ? 'legacy' : 'current'
  })
  say(result.message, result.ok ? '' : result.reason)
  if (result.ok) {
    quickCode.value.code = ''
    refreshReadFace()
  }
}

async function quickRemoveCode(row, entry) {
  const result = await publishers.removeIsbnCode(textOf(row._id || row.code), textOf(entry && entry.code))
  say(result.message, result.ok ? '' : result.reason)
  if (result.ok) refreshReadFace()
}

/* ------------------------------ 编辑器（新建 / 改行共用一份表单） ------------------------------ */
const editorOpen = ref(false)
const editingCode = ref('')
const saving = ref(false)
const form = ref(emptyForm())

function emptyForm() {
  return {
    name: '',
    name_cht: '',
    org_type: 'publisher',
    isbn_prefix: '978',
    isbn_group: '7',
    aliases: '',
    region: '',
    founded_year: '',
    note: '',
    codes: [{ code: '', status: 'current', note: '' }]
  }
}

function openCreate() {
  editingCode.value = ''
  form.value = emptyForm()
  editorOpen.value = true
}

function openEdit(row) {
  editingCode.value = textOf(row._id || row.code)
  form.value = {
    name: textOf(row.name),
    name_cht: textOf(row.name_cht),
    org_type: textOf(row.org_type) || 'publisher',
    isbn_prefix: textOf(row.isbn_prefix) || '978',
    isbn_group: textOf(row.isbn_group) || '7',
    aliases: (Array.isArray(row.aliases) ? row.aliases : []).map((item) => textOf(item)).join('、'),
    region: textOf(row.region),
    founded_year: row.founded_year === null || row.founded_year === undefined ? '' : String(row.founded_year),
    note: textOf(row.note),
    codes: codesOf(row)
      .map((item) => ({ code: textOf(item.code), status: item.status === 'legacy' ? 'legacy' : 'current', note: textOf(item.note) }))
      .concat([{ code: '', status: 'current', note: '' }])
  }
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
  editingCode.value = ''
  form.value = emptyForm()
}

function addDraftCode() {
  form.value.codes.push({ code: '', status: 'current', note: '' })
}

function removeDraftCode(index) {
  form.value.codes.splice(index, 1)
  if (!form.value.codes.length) form.value.codes.push({ code: '', status: 'current', note: '' })
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    const draft = form.value
    /* 号段草稿：只收**填了代號**的行（空行不提交）；`note` 空 ⇒ 不带该键。 */
    const codes = draft.codes
      .map((item) => {
        const entry = { code: textOf(item.code), status: item.status === 'legacy' ? 'legacy' : 'current' }
        const note = textOf(item.note)
        if (note !== '') entry.note = note
        return entry
      })
      .filter((item) => item.code !== '')

    const payload = {
      name: draft.name,
      name_cht: draft.name_cht,
      org_type: draft.org_type,
      isbn_prefix: draft.isbn_prefix,
      isbn_group: draft.isbn_group,
      aliases: draft.aliases,
      region: draft.region,
      founded_year: draft.founded_year,
      note: draft.note,
      isbn_publisher_codes: codes
    }
    /* 改行必须带 `code`（同一性只认 id / code）；新建**不带**（号由号段账本发）。 */
    if (editingCode.value) payload.code = editingCode.value

    const result = await publishers.putPublisher(payload)
    say(result.message, result.ok ? '' : result.reason)
    if (result.ok) {
      closeEditor()
      /* 成功 ⇒ **必须刷新读面**（`storageGeneration` 非响应式 ⇒ 靠 `revision` 让 rows 重算）。 */
      refreshReadFace()
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section>
    <div class="page-head publishers__head">
      <div>
        <h1>梓行匯溯</h1>
        <p>
          出版社（publisher）規範行：一家出版機構 / 印社 / 書肆一行，以 `PB` + 9 位碼為同一性
          （join 只認 id 不認名字）。社團與出版法人**分列不合并**；ISBN 反查只認出版法人的號段。
        </p>
      </div>
      <span class="publishers__gate" data-publishers-gate="admin">僅{{ ADMIN_LABEL }}</span>
    </div>

    <!-- 權限門：非管理員 / 未登錄 ⇒ 只此一段提示，**零出版社請求**（見 `rows` 前置判）。 -->
    <p v-if="!canManage" class="notice publishers__notice" data-publishers-denied>
      {{ denialMessage }}
    </p>

    <template v-else>
      <p v-if="feedback" class="notice publishers__notice" data-publishers-feedback>
        <span v-if="feedbackReason" data-publishers-feedback-reason>{{ reasonText(feedbackReason) }}</span>
        {{ feedback }}
      </p>

      <section class="panel" data-publishers-list>
        <div class="panel__head">
          <h2>出版社清單</h2>
          <span class="detail__hint">共 {{ totalLabel }} 家</span>
        </div>
        <div class="panel__body">
          <form class="publishers-filter" data-publishers-filter @submit.prevent>
            <label class="publishers-filter__field">
              <span>搜索</span>
              <input
                v-model="query"
                type="search"
                maxlength="80"
                placeholder="名稱 / 別名 / 出版者代號 / PB 碼"
                data-publishers-search
              />
            </label>
            <label class="publishers-filter__field publishers-filter__field--org">
              <span>性質</span>
              <select v-model="orgFilter" data-publishers-org-filter>
                <option value="">全部</option>
                <option value="publisher">出版法人</option>
                <option value="society">社團（非出版法人）</option>
                <option value="unknown">待考</option>
              </select>
            </label>
            <div class="publishers-filter__actions">
              <button
                class="btn btn--primary btn--admin"
                type="button"
                data-publishers-create
                @click="openCreate"
              >
                <AdminBadge />
                新增出版社
              </button>
            </div>
          </form>

          <div v-if="visible.length" class="publishers-table-wrap">
            <table class="publishers-table" data-publishers-table>
              <thead>
                <tr>
                  <th>代號</th>
                  <th>名稱</th>
                  <th>性質</th>
                  <th>號段（出版者代號）</th>
                  <th>別名</th>
                  <th>地域</th>
                  <th>創立</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visible" :key="textOf(row._id || row.code)">
                  <td><code>{{ textOf(row._id || row.code) }}</code></td>
                  <td>{{ nameOf(row) }}</td>
                  <td>{{ orgTypeLabel(row) }}</td>
                  <td>
                    <span
                      v-for="entry in codesOf(row)"
                      :key="textOf(entry.code)"
                      class="publishers-chip"
                      :class="{ 'publishers-chip--legacy': entry.status === 'legacy' }"
                    >
                      {{ textOf(entry.code) }}<em>{{ statusLabel(entry.status) }}</em>
                      <button
                        class="publishers-chip__x"
                        type="button"
                        :aria-label="`移除代號 ${textOf(entry.code)}`"
                        @click="quickRemoveCode(row, entry)"
                      >
                        ×
                      </button>
                    </span>
                    <span v-if="!codesOf(row).length" class="publishers-muted">—</span>
                    <form class="publishers-quickcode" @submit.prevent="quickAddCode(row)">
                      <input
                        v-model="quickCode.code"
                        type="text"
                        maxlength="32"
                        placeholder="加代號"
                        :aria-label="`為 ${nameOf(row)} 新增出版者代號`"
                      />
                      <button class="btn btn--ghost" type="submit">加</button>
                    </form>
                  </td>
                  <td>{{ aliasesOf(row) }}</td>
                  <td>{{ textOf(row.region) || '—' }}</td>
                  <td>{{ row.founded_year === null || row.founded_year === undefined ? '—' : String(row.founded_year) }}</td>
                  <td>
                    <button
                      class="btn btn--ghost btn--admin"
                      type="button"
                      :data-publishers-edit="textOf(row._id || row.code)"
                      @click="openEdit(row)"
                    >
                      <AdminBadge />
                      編輯
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="publishers__empty" data-publishers-empty>
            {{ rows.length === 0 ? '出版社名錄暫無資料（雲端集合尚未播種）。' : '查無所獲，試試別的關鍵詞或切回「全部」。' }}
          </p>
        </div>
      </section>

      <!-- 編輯器：新建 / 改行共用一份表单（不自建第二份）。 -->
      <section v-if="editorOpen" class="panel" data-publishers-editor>
        <div class="panel__head">
          <h2>{{ editingCode ? '編輯出版社' : '新增出版社' }}</h2>
          <span v-if="editingCode" class="detail__hint"><code>{{ editingCode }}</code></span>
        </div>
        <div class="panel__body">
          <form class="publishers-form" @submit.prevent="save">
            <label class="publishers-form__field">
              <span>名稱（簡體規範名）*</span>
              <input v-model="form.name" type="text" maxlength="200" required data-publishers-field="name" />
            </label>
            <label class="publishers-form__field">
              <span>繁體規範名</span>
              <input v-model="form.name_cht" type="text" maxlength="200" data-publishers-field="name_cht" />
            </label>
            <label class="publishers-form__field">
              <span>機構性質</span>
              <select v-model="form.org_type" data-publishers-field="org_type">
                <option value="publisher">出版法人（publisher）</option>
                <option value="society">社團等非出版法人（society）</option>
                <option value="unknown">待考（unknown）</option>
              </select>
            </label>
            <label class="publishers-form__field publishers-form__field--short">
              <span>ISBN 前綴</span>
              <select v-model="form.isbn_prefix" data-publishers-field="isbn_prefix">
                <option value="978">978</option>
                <option value="979">979</option>
              </select>
            </label>
            <label class="publishers-form__field publishers-form__field--short">
              <span>組區號</span>
              <input v-model="form.isbn_group" type="text" maxlength="8" data-publishers-field="isbn_group" />
            </label>
            <label class="publishers-form__field publishers-form__field--short">
              <span>創立年</span>
              <input
                v-model="form.founded_year"
                type="number"
                min="1"
                max="9999"
                inputmode="numeric"
                placeholder="如 1904"
                data-publishers-field="founded_year"
              />
            </label>
            <label class="publishers-form__field">
              <span>地域</span>
              <input v-model="form.region" type="text" maxlength="100" data-publishers-field="region" />
            </label>
            <label class="publishers-form__field">
              <span>別名（、或逗號分隔）</span>
              <input v-model="form.aliases" type="text" maxlength="400" data-publishers-field="aliases" />
            </label>

            <fieldset class="publishers-codes">
              <legend>號段（出版者代號）</legend>
              <p class="publishers-muted">
                號段隨【儲存】一併提交；狀態只兩值（現行 / 舊號），第 3 值一律不收。
              </p>
              <div
                v-for="(entry, index) in form.codes"
                :key="index"
                class="publishers-codes__row"
              >
                <input
                  v-model="entry.code"
                  type="text"
                  maxlength="32"
                  placeholder="如 5508"
                  :aria-label="`第 ${index + 1} 條代號`"
                />
                <select v-model="entry.status" :aria-label="`第 ${index + 1} 條狀態`">
                  <option value="current">現行（current）</option>
                  <option value="legacy">舊號（legacy）</option>
                </select>
                <input
                  v-model="entry.note"
                  type="text"
                  maxlength="200"
                  placeholder="備註（可空）"
                  :aria-label="`第 ${index + 1} 條備註`"
                />
                <button class="btn btn--ghost" type="button" @click="removeDraftCode(index)">刪</button>
              </div>
              <button class="btn btn--ghost" type="button" data-publishers-code-add @click="addDraftCode">
                加一條號段
              </button>
            </fieldset>

            <label class="publishers-form__field">
              <span>備註</span>
              <textarea v-model="form.note" rows="3" maxlength="2000" data-publishers-field="note"></textarea>
            </label>

            <div class="publishers-form__foot">
              <button class="btn btn--primary" type="submit" :disabled="saving" data-publishers-save>
                {{ saving ? '儲存中…' : '儲存' }}
              </button>
              <button class="btn btn--ghost" type="button" @click="closeEditor">取消</button>
              <span class="publishers-muted">
                {{ editingCode ? '改行只認代號；同值重寫零寫入。' : '新行代號由號段賬本發（頁面不填號）。' }}
              </span>
            </div>
          </form>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.publishers__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

.publishers__gate {
  flex: 0 0 auto;
  padding: var(--s-1) var(--s-2);
  border: 1px dashed var(--c-line);
  border-radius: var(--r-sm);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.publishers__notice {
  margin: 0 0 12px;
}

.publishers__empty {
  margin: 16px 0;
  color: var(--text-dim, #8a8a8a);
  font-size: 14px;
}

.publishers-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}

.publishers-filter__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.publishers-filter__field input,
.publishers-filter__field select {
  min-width: 220px;
  padding: 7px 10px;
  border: 1px solid var(--line, #d8d8d8);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 14px;
}

.publishers-filter__field--org select {
  min-width: 180px;
}

.publishers-filter__actions {
  display: flex;
  gap: 8px;
}

.publishers-table-wrap {
  overflow-x: auto;
}

.publishers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.publishers-table th,
.publishers-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line, #e5e5e5);
  text-align: left;
  vertical-align: top;
}

.publishers-table th {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  white-space: nowrap;
}

.publishers-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 6px 4px 0;
  padding: 2px 6px;
  border: 1px solid var(--line, #d8d8d8);
  border-radius: 6px;
  font-size: 13px;
}

.publishers-chip em {
  font-style: normal;
  font-size: 11px;
  opacity: 0.7;
}

.publishers-chip--legacy {
  opacity: 0.65;
}

.publishers-chip__x {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}

.publishers-quickcode {
  display: inline-flex;
  gap: 4px;
  margin-top: 4px;
}

.publishers-quickcode input {
  width: 96px;
  padding: 4px 6px;
  border: 1px solid var(--line, #d8d8d8);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}

.publishers-muted {
  opacity: 0.6;
  font-size: 13px;
}

.publishers-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.publishers-form__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.publishers-form__field--short {
  max-width: 160px;
}

.publishers-form__field input,
.publishers-form__field select,
.publishers-form__field textarea {
  padding: 7px 10px;
  border: 1px solid var(--line, #d8d8d8);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  font-family: inherit;
}

.publishers-codes {
  grid-column: 1 / -1;
  border: 1px solid var(--line, #e5e5e5);
  border-radius: 8px;
  padding: 10px 12px 12px;
}

.publishers-codes legend {
  padding: 0 4px;
  font-size: 13px;
}

.publishers-codes__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.publishers-codes__row input,
.publishers-codes__row select {
  padding: 6px 8px;
  border: 1px solid var(--line, #d8d8d8);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 13px;
}

.publishers-codes__row input:first-child {
  width: 110px;
}

.publishers-codes__row input:nth-child(3) {
  flex: 1;
  min-width: 140px;
}

.publishers-form__foot {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
