<script setup>
/**
 * 印人詳情（`/persons/:code`）—— 接名錄頁 vA 的行點擊。
 * ============================================================================
 * 版面：返回鏈（回 `/persons`）→ 頁首（姓名 ＋ 生卒 ＋ 籍貫 ＋ 朝代 ＋ CBDB 編號）
 *      → 屬性區塊（字 / 別字 / 號 / 齋號 / 別署齋號 / 別號）→ 小傳。
 *
 * 硬口徑（逐條，與名錄頁同一套）：
 *   · **數據面 ＝ CARD 主庫**（本單切換）：`services/personCards.js::loadPersonDetail(code)` ——
 *     由雲函數公開只讀 op `getPersonCard` 取**全字段**（`PR…` 與 CARD 九位號兩種編號皆認）；
 *     CARD 不可用時該服務回退本地行轉同形（`source:'local'`），**本頁不自行拼第二套數據面**。
 *   · **只上屏正字段**：繁體正字段（`courtesy_name` / `courtesy_alt_names` / `art_name` /
 *     `zhaihao` / `zhaihao_alts` / `biehao_text` / `biography`）。
 *     簡體副字段 `native_place_chs` / `biography_chs` **一律不上屏**；
 *     舊三數組（`courtesy_names` / `art_names` / `alias_names`）**不上屏**（僅供檢索兼容）。
 *   · **缺值整塊不渲染**（不是渲染空佔位）；`dynasty` 為空 ⇒ 展示「待考」。
 *   · `biehao_text` 按行展示（全角 `／` 原樣保留），含 `#待核` 核校標記的行**整行剔除** ——
 *     口徑與名錄頁同源：`services/personSearch.js::biehaoLinesOf`。
 *   · 查不到 `code` ⇒ 可讀空態（「查無此印人」＋ 返回名錄鏈），**不白屏、不重定向**；
 *     首屏水合未落定時顯示載入態（不把「還沒讀到」說成「查無此印人」）。
 *   · 上屏文案一律繁體（`s2t(x) === x`）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { persons, seals } from '../services/index.js'
import { loadPersonDetail, isBasicInfoOnlyCard } from '../services/personCards.js'
import { biehaoLinesOf } from '../services/personSearch.js'
/* 管理員入口文案（身份詞**單點**取字 `data/roleLabels.js`；本頁零硬編碼身份詞）。 */
import { ADMIN_LABEL } from '../data/roleLabels.js'
import AdminBadge from '../components/AdminBadge.vue'
/* 彈窗 ESC ＝ 取消（**全倉單點** `utils/useEscToClose.js`；本頁恰 1 扇自建彈窗 ⇒ 1 層）。 */
import { useEscToClose } from '../utils/useEscToClose.js'

const route = useRoute()
/* 路由替換（`tmp-` 暂存编号解析成功时 `replace` 而非 `push` —— 不留一条坏历史）。 */
const router = useRouter()

function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 行編碼（與名錄頁 `codeOf` 同一口徑）：`code` 優先，退 `id`，再退 `_id`，再退 CARD `person_id`。 */
function codeOf(row) {
  if (!row || typeof row !== 'object') return ''
  return textOf(row.code) || textOf(row.id) || textOf(row._id) || textOf(row.person_id)
}

function firstOf(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return textOf(list[0])
}

/** 多值欄位（去空、保序、去重複值）。 */
function valuesOf(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = textOf(item)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** 數據源狀態（載入 / 失敗分流；與名錄頁同一讀數）。 */
const source = computed(() => seals.dataSourceState())

const wantedCode = computed(() => textOf(route.params && route.params.code))

/* ------------------------------ 數據面（CARD 主庫） ------------------------------
   `loadPersonDetail` 認兩種編號（`PR…` / CARD 九位號），帶 60 s 緩存、失敗回退本地行；
   本頁只做「取到 ⇒ 上屏、取不到 ⇒ 可讀空態」的形態分流，不自行拼第二套字段面。
   **本單追加**：編輯成功後要把服務端權威行疊回本行（`editOverlay`），故重讀時**繞過緩存**。 */
const detail = ref(null)
const detailLoading = ref(false)
let detailToken = 0

/**
 * **本次編輯的行疊加層**（`{code, fields}`）：只放服務端 `updatePerson` 回傳的**白名單字段**。
 * 用途 —— 讀面主庫若不是本地鏡像（CARD 優先），編輯後的值也要**立刻可見**；
 * 這不是第二套判定：值一律來自服務端權威回包，`isBasicInfoOnlyCard` 判定仍單點、一字未改。
 * 換編號（`wantedCode` 變化）即清空。
 */
const editOverlay = ref(null)

/* --------------------------- `tmp-` 暂存编号解析态（本单） ---------------------------
   `resolving` ＝ 解析中的短状态（「正在對照雲端編號…」）；`tempUnresolved` ＝ 解析不到时
   页内的诚实提示（不回跳、不报错、零编辑入口）。正式编号两者恒为 `false`。 */
const resolving = ref(false)
const tempUnresolved = ref(false)

async function fetchDetail() {
  const code = wantedCode.value
  const token = (detailToken += 1)
  if (!code) {
    detail.value = { ok: false, reason: 'MISSING_REQUIRED', message: '' }
    detailLoading.value = false
    return
  }
  const overlay = editOverlay.value && editOverlay.value.code === code ? editOverlay.value.fields : null
  detailLoading.value = true
  const got = await loadPersonDetail(code, overlay ? { force: true } : {})
  if (token !== detailToken) return
  if (overlay && got && got.ok === true && got.person) {
    got.person = Object.assign({}, got.person, overlay)
  }
  detail.value = got
  detailLoading.value = false
}

watch(
  wantedCode,
  async () => {
    editOverlay.value = null
    tempUnresolved.value = false
    const code = wantedCode.value
    /* **`tmp-` 暂存编号先解析正式编号**（服务层单点 `persons.resolveTempPersonCode`，
       走既有读取面、零新网络请求）：命中 ⇒ `router.replace` 到正式 `code`（路由变化会
       重新进本 watch，届时才读详情）；解析不到 ⇒ **不回跳、不报错**，页内诚实提示。
       正式 `PR…` 编号 ⇒ 本分支不进，`fetchDetail` 与改前逐字一致。 */
    if (persons.isTempPersonCode(code)) {
      resolving.value = true
      try {
        const result = await persons.resolveTempPersonCode(code, { router })
        if (result.redirected) return
        tempUnresolved.value = true
      } catch {
        tempUnresolved.value = true
      } finally {
        resolving.value = false
      }
      return
    }
    resolving.value = false
    fetchDetail()
  },
  { immediate: true }
)

/** 命中行（未命中 ⇒ `null`）。 */
const row = computed(() => (detail.value && detail.value.ok === true ? detail.value.person : null))

/** 生卒（兩端皆有 ⇒ `1829–1884`；只有一端 ⇒ 該端；皆無 ⇒ 空串）。 */
function lifeOf(item) {
  const birth = textOf(item && item.birth_year)
  const death = textOf(item && item.death_year)
  if (birth && death) return `${birth}–${death}`
  return birth || death
}

/** 詳情面視圖模型（缺值一律空串 / 空數組 ⇒ 模板按空值整塊省略）。 */
const person = computed(() => {
  const item = row.value
  if (!item) return null
  return {
    code: textOf(wantedCode.value) || codeOf(item),
    name: textOf(item.name) || persons.personName(item) || '',
    life: lifeOf(item),
    nativePlace: textOf(item.native_place),
    dynasty: textOf(item.dynasty) || '待考',
    unknownDynasty: textOf(item.dynasty) === '',
    cbdbId: textOf(item.cbdb_id),
    courtesy: textOf(item.courtesy_name) || firstOf(item.courtesy_names),
    courtesyAlts: valuesOf(item.courtesy_alt_names),
    art: textOf(item.art_name) || firstOf(item.art_names),
    zhaihao: textOf(item.zhaihao),
    zhaihaoAlts: valuesOf(item.zhaihao_alts),
    biehaoLines: biehaoLinesOf(item),
    biographyLines: textOf(item.biography)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    hasProfile:
      textOf(item.courtesy_name) !== '' ||
      valuesOf(item.courtesy_alt_names).length > 0 ||
      textOf(item.art_name) !== '' ||
      textOf(item.zhaihao) !== '' ||
      valuesOf(item.zhaihao_alts).length > 0 ||
      biehaoLinesOf(item).length > 0
  }
})

const loading = computed(
  () => !person.value && (detailLoading.value || (!detail.value && source.value.pending))
)
/* 「僅基礎信息」提示：判定**单点**在 `services/personCards.js::isBasicInfoOnlyCard`
   （名录页同一函数）；本页只喂**原始详情行**（10 键全空 ⇒ 只余姓名 / 朝代）。 */
const basicInfoOnly = computed(() => (row.value ? isBasicInfoOnlyCard(row.value) : false))
const unavailable = computed(() => {
  if (person.value || loading.value) return false
  const got = detail.value
  if (!got || got.ok !== false) return false
  /* `INVALID_VALUE` ＝ 云端「該印人不存在」；其余（传输层 / 未配置 / 未预期）⇒ 读不到，非「查无此人」。 */
  return textOf(got.reason) !== 'INVALID_VALUE' && textOf(got.reason) !== 'NOT_FOUND'
})
const missing = computed(() => !person.value && !loading.value && !unavailable.value)

const emptyTitle = computed(() => {
  if (loading.value) return '正在讀取印人資料'
  if (unavailable.value) return '印人資料暫時無法讀取'
  return '查無此印人'
})

const emptyBody = computed(() => {
  if (loading.value) return '雲端印人資料載入中，就緒後會自動顯示，無需手動刷新。'
  if (unavailable.value) return '雲端資料暫時未能讀取，請稍後重新整理本頁。'
  return '此編號未在印家名錄中，或該印人尚未收錄；可返回名錄重新查找。'
})

/* ============================================================================
   管理員 · 補充 / 編輯印人信息（本單）
   ----------------------------------------------------------------------------
   · **入口渲染門**單點 ＝ `services/persons.canEditPersonInfo(undefined, wantedCode)`
     （＝管理員 **且非 `tmp-` 暫存編號**；後者判定單點 `persons.isTempPersonCode`）；
     非管理員 / 遊客 / 本機暫存行 ⇒ **零渲染、零 DOM 命中**（不用 CSS 隱藏 / `disabled`
     冒充）—— 暫存行在雲端沒有這行，彈一個必然失敗的按鈕只會把用戶帶進
     「未找到該印人」的死路。
   · **表單四組**；當前值預填；**只送出使用者改動過的欄** ⇒ 服務端「未傳 ＝ 不改」天然成立
     （讀面沒有的欄，如 `name_cht`，不會被空值誤清）。
   · **留空 ＝ 清除該欄**（逐欄標注）；數值欄一行一項（服務端去重保序、去空項）。
   · 保存：`busy` 禁雙擊 ⇒ 成功 ⇒ **就地一行反饋**（`已儲存 N 項變更`）＋ **行刷新**（權威行疊回
     ＋ 強制重讀）＋ **關窗** ⇒「僅基礎信息」提示隨字段填上自動消失（判定仍單點
     `isBasicInfoOnlyCard`，本頁**不另寫判定**）；失敗 ⇒ **服務端原文上屏**、窗不關。
   · 彈窗內兩鈕**不帶**管理員虛線樣式（虛線只屬入口）。
   ============================================================================ */

/** 入口渲染門（單點；非管理員 / 遊客 / `tmp-` 暫存編號 ⇒ `false` ⇒ 模板零渲染）。 */
const canEditPerson = computed(() => persons.canEditPersonInfo(undefined, wantedCode.value))

/** 可編輯字段面（＝服務端封閉鍵面的 13 個可寫字段；轉發真源 `services/persons.js`）。 */
const EDIT_FIELDS = persons.PERSON_EDITABLE_FIELDS

const editOpen = ref(false)
const editBusy = ref(false)
/** 失敗文案（**服務端原文**，一字不改）。 */
const editError = ref('')
/** 成功反饋（頁面就地一行；關窗後仍可見）。 */
const editFeedback = ref('')

/** 表單值（鍵面 ＝ `EDIT_FIELDS`；一律字串，數組欄以換行分隔）。 */
const editForm = reactive(EDIT_FIELDS.reduce((acc, key) => Object.assign(acc, { [key]: '' }), {}))
/** 預填基線（**只送改動過的欄**的比對依據）。 */
const editBaseline = ref({})

/** 行 ⇒ 表單值（預填；數組欄以換行分隔，視圖同形取值 `valuesOf` / `firstOf` / `textOf`）。 */
function prefillEditForm() {
  const item = row.value
  const next = {}
  EDIT_FIELDS.forEach((key) => {
    next[key] = ''
  })
  if (item) {
    next.name = textOf(item.name)
    next.name_cht = textOf(item.name_cht)
    next.dynasty = textOf(item.dynasty)
    next.courtesy_name = textOf(item.courtesy_name) || firstOf(item.courtesy_names)
    next.courtesy_alt_names = valuesOf(item.courtesy_alt_names).join('\n')
    next.art_name = textOf(item.art_name) || firstOf(item.art_names)
    next.zhaihao = textOf(item.zhaihao)
    next.zhaihao_alts = valuesOf(item.zhaihao_alts).join('\n')
    next.biehao_text = textOf(item.biehao_text)
    next.native_place = textOf(item.native_place)
    next.birth_year = textOf(item.birth_year)
    next.death_year = textOf(item.death_year)
    next.biography = textOf(item.biography)
  }
  EDIT_FIELDS.forEach((key) => {
    editForm[key] = next[key]
  })
  editBaseline.value = next
}

function openEdit() {
  if (!canEditPerson.value) return
  editError.value = ''
  editFeedback.value = ''
  prefillEditForm()
  editOpen.value = true
}

/** 取消：關窗並丟棄未提交輸入（**零寫請求**）。 */
function closeEdit() {
  if (editBusy.value) return
  editOpen.value = false
  editError.value = ''
}

/** 服務端權威行 ⇒ 只取白名單字段（疊回本行用；其餘內部鍵一律不取）。 */
function pickEditableRow(serverRow) {
  const out = {}
  if (!serverRow || typeof serverRow !== 'object') return out
  EDIT_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(serverRow, key)) out[key] = serverRow[key]
  })
  return out
}

async function saveEdit() {
  if (editBusy.value) return
  editError.value = ''
  /* **只送改動過的欄**（未改動 ⇒ 鍵不入載荷 ⇒ 服務端「未傳 ＝ 不改」）。 */
  const fields = { person_id: wantedCode.value }
  const base = editBaseline.value
  EDIT_FIELDS.forEach((key) => {
    const value = String(editForm[key])
    if (String(base[key] === undefined || base[key] === null ? '' : base[key]) === value) return
    fields[key] = value
  })
  editBusy.value = true
  try {
    const result = await persons.updatePersonInfo(fields)
    if (!result.ok) {
      /* 失敗：**服務端原文上屏**，不造第二套文案；窗保持打開。 */
      editError.value = result.message
      return
    }
    const count = Array.isArray(result.changed) ? result.changed.length : 0
    editFeedback.value = count > 0 ? `已儲存 ${count} 項變更` : '沒有需要保存的變更'
    /* 行刷新：權威行疊回 ＋ 繞過 60 s 緩存重讀 ⇒「僅基礎信息」提示隨字段填上自動消失。 */
    editOverlay.value = { code: wantedCode.value, fields: pickEditableRow(result.row) }
    await fetchDetail()
    editOpen.value = false
  } finally {
    editBusy.value = false
  }
}

/* ESC ＝ 取消（全倉單點實現；提交中不生效、不向下穿透）。 */
useEscToClose({ isActive: () => editOpen.value, onCancel: closeEdit, isBusy: () => editBusy.value })
</script>

<template>
  <section class="person" data-person-detail>
    <nav class="person__back">
      <RouterLink class="person__back-link" :to="{ name: 'persons' }" data-person-back>← 返回印家名錄</RouterLink>
    </nav>

    <!-- 命中：頁首 ＋ 屬性區塊 ＋ 小傳（缺值整塊不渲染）。 -->
    <template v-if="person">
      <header class="person__head">
        <p class="person__eyebrow">印人 · 名錄</p>
        <h1 class="person__title" data-person-name>{{ person.name }}</h1>
        <p class="person__sub">
          <span v-if="person.life" data-person-life>{{ person.life }}</span>
          <span v-if="person.life && person.nativePlace" class="person__dot">·</span>
          <span v-if="person.nativePlace" data-person-native>{{ person.nativePlace }}</span>
        </p>
        <dl class="person__facts">
          <div class="person__fact">
            <dt>朝代</dt>
            <dd :class="{ 'person__na': person.unknownDynasty }" data-person-dynasty>{{ person.dynasty }}</dd>
          </div>
          <div v-if="person.cbdbId" class="person__fact">
            <dt>CBDB 編號</dt>
            <dd data-person-cbdb>{{ person.cbdbId }}</dd>
          </div>
          <div v-if="person.code" class="person__fact">
            <dt>印人編號</dt>
            <dd data-person-code>{{ person.code }}</dd>
          </div>
        </dl>
        <!-- 管理員入口（本單）：渲染門單點 `persons.canEditPersonInfo(undefined, wantedCode)`
             ⇒ 非管理員 / 遊客 / `tmp-` 暫存編號 ⇒ `v-if` 恆假 ⇒ **零渲染、零 DOM 命中**
             （不用隱藏 / `disabled` 冒充）。 -->
        <button
          v-if="canEditPerson"
          class="btn btn--ghost btn--admin"
          type="button"
          data-action="person-edit"
          :title="`編輯印人信息（僅${ADMIN_LABEL}可見）`"
          :aria-label="`編輯印人信息（僅${ADMIN_LABEL}可見）`"
          @click="openEdit"
        >
          <AdminBadge />
          編輯信息
        </button>
      </header>

      <!-- 編輯成功反饋（**就地一行**；關窗後仍可見）—— 文案由服務端回包的 `changed` 派生。 -->
      <p v-if="editFeedback" class="notice person__edit-feedback" data-person-edit-feedback>{{ editFeedback }}</p>

      <!-- 「僅基礎信息」提示（固定位置＝頁首之後、屬性區塊之前）：10 個詳情類字段全空 ⇒
           整段渲染；判定單點 `services/personCards.js::isBasicInfoOnlyCard`（名錄頁同源）。 -->
      <section v-if="basicInfoOnly" class="panel person__panel">
        <div class="panel__body">
          <p class="person__notice" data-person-basic-info>本卡片僅有基礎信息（姓名／朝代），尚未著錄傳略。</p>
        </div>
      </section>

      <section v-if="person.hasProfile" class="panel person__panel">
        <div class="panel__body person__body">
          <!-- 字 -->
          <div v-if="person.courtesy" class="person__field" data-field="courtesy">
            <p class="person__key">字</p>
            <p class="person__value" data-person-courtesy>{{ person.courtesy }}</p>
          </div>

          <!-- 別字（chip） -->
          <div v-if="person.courtesyAlts.length" class="person__field" data-field="courtesy-alts">
            <p class="person__key">別字</p>
            <ul class="person__chips" data-person-courtesy-alts>
              <li v-for="alt in person.courtesyAlts" :key="alt" class="person__chip">{{ alt }}</li>
            </ul>
          </div>

          <!-- 號 -->
          <div v-if="person.art" class="person__field" data-field="art">
            <p class="person__key">號</p>
            <p class="person__value" data-person-art>{{ person.art }}</p>
          </div>

          <!-- 齋號 -->
          <div v-if="person.zhaihao" class="person__field" data-field="zhaihao">
            <p class="person__key">齋號</p>
            <p class="person__value" data-person-zhaihao>{{ person.zhaihao }}</p>
          </div>

          <!-- 別署齋號（chip） -->
          <div v-if="person.zhaihaoAlts.length" class="person__field" data-field="zhaihao-alts">
            <p class="person__key">別署齋號</p>
            <ul class="person__chips" data-person-zhaihao-alts>
              <li v-for="alt in person.zhaihaoAlts" :key="alt" class="person__chip">{{ alt }}</li>
            </ul>
          </div>

          <!-- 別號（按行；`／` 原樣保留，`#待核` 行已在 `biehaoLinesOf` 剔除） -->
          <div v-if="person.biehaoLines.length" class="person__field person__field--wide" data-field="biehao">
            <p class="person__key">別號</p>
            <ul class="person__lines" data-person-biehao>
              <li v-for="(line, index) in person.biehaoLines" :key="index" class="person__line" data-biehao-line>{{ line }}</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- 小傳：只上屏 `biography`（簡體副字段不上屏）。 -->
      <section v-if="person.biographyLines.length" class="panel person__panel">
        <div class="panel__body person__body">
          <div class="person__field person__field--wide" data-field="biography">
            <p class="person__key">小傳</p>
            <div class="person__prose" data-person-biography>
              <p v-for="(line, index) in person.biographyLines" :key="index" class="person__para">{{ line }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 補充 / 編輯對話框（本單）：**管理員才可能打開** —— 入口不渲染 ⇒ 本節點零命中。
           內部兩鈕只用通用按鈕樣式（**不帶**管理員虛線輪廓）。 -->
      <div
        v-if="editOpen"
        class="person-edit-mask"
        role="dialog"
        aria-modal="true"
        aria-label="編輯印人信息"
        data-person-edit-dialog
      >
        <div class="person-edit-box">
          <h3 class="person-edit-box__title">編輯印人信息</h3>
          <p class="person-edit-box__lede">
            留空 ＝ 清除該欄；**未改動的欄位不會送出**。數值欄（字 / 別字 / 齋號 / 別號）一行一項，系統自動去重、去空。
          </p>

          <fieldset class="person-edit-group" :disabled="editBusy">
            <legend class="person-edit-group__legend">基本信息</legend>
            <div class="field">
              <label for="pe-name">姓名</label>
              <input id="pe-name" v-model="editForm.name" type="text" data-person-edit-field="name" />
            </div>
            <div class="field">
              <label for="pe-name-cht">姓名（繁體）</label>
              <input id="pe-name-cht" v-model="editForm.name_cht" type="text" data-person-edit-field="name_cht" />
            </div>
            <div class="field">
              <label for="pe-dynasty">朝代</label>
              <input id="pe-dynasty" v-model="editForm.dynasty" type="text" data-person-edit-field="dynasty" />
            </div>
          </fieldset>

          <fieldset class="person-edit-group" :disabled="editBusy">
            <legend class="person-edit-group__legend">別名</legend>
            <div class="field">
              <label for="pe-courtesy">字</label>
              <input id="pe-courtesy" v-model="editForm.courtesy_name" type="text" data-person-edit-field="courtesy_name" />
            </div>
            <div class="field">
              <label for="pe-courtesy-alts">別字（一行一項）</label>
              <textarea id="pe-courtesy-alts" v-model="editForm.courtesy_alt_names" rows="2" data-person-edit-field="courtesy_alt_names"></textarea>
              <p class="field__hint">留空 ＝ 清除；同一行重複只保留首次。</p>
            </div>
            <div class="field">
              <label for="pe-art">號</label>
              <input id="pe-art" v-model="editForm.art_name" type="text" data-person-edit-field="art_name" />
            </div>
            <div class="field">
              <label for="pe-zhaihao">齋號</label>
              <input id="pe-zhaihao" v-model="editForm.zhaihao" type="text" data-person-edit-field="zhaihao" />
            </div>
            <div class="field">
              <label for="pe-zhaihao-alts">別署齋號（一行一項）</label>
              <textarea id="pe-zhaihao-alts" v-model="editForm.zhaihao_alts" rows="2" data-person-edit-field="zhaihao_alts"></textarea>
              <p class="field__hint">留空 ＝ 清除；同一行重複只保留首次。</p>
            </div>
            <div class="field">
              <label for="pe-biehao">別號（一行一項）</label>
              <textarea id="pe-biehao" v-model="editForm.biehao_text" rows="3" data-person-edit-field="biehao_text"></textarea>
              <p class="field__hint">留空 ＝ 清除；按行展示。</p>
            </div>
          </fieldset>

          <fieldset class="person-edit-group" :disabled="editBusy">
            <legend class="person-edit-group__legend">籍貫與生卒</legend>
            <div class="field">
              <label for="pe-native-place">籍貫</label>
              <input id="pe-native-place" v-model="editForm.native_place" type="text" data-person-edit-field="native_place" />
            </div>
            <div class="field">
              <label for="pe-birth-year">生年</label>
              <input id="pe-birth-year" v-model="editForm.birth_year" type="text" data-person-edit-field="birth_year" />
            </div>
            <div class="field">
              <label for="pe-death-year">卒年</label>
              <input id="pe-death-year" v-model="editForm.death_year" type="text" data-person-edit-field="death_year" />
            </div>
          </fieldset>

          <fieldset class="person-edit-group" :disabled="editBusy">
            <legend class="person-edit-group__legend">傳略</legend>
            <div class="field">
              <label for="pe-biography">小傳</label>
              <textarea id="pe-biography" v-model="editForm.biography" rows="6" data-person-edit-field="biography"></textarea>
              <p class="field__hint">留空 ＝ 清除；允許換行。</p>
            </div>
          </fieldset>

          <!-- 失敗：**服務端原文**上屏（不造第二套文案）。 -->
          <p v-if="editError" class="person-edit-box__error" data-person-edit-error>{{ editError }}</p>

          <div class="person-edit-box__foot">
            <button class="btn btn--ghost" type="button" data-person-edit-cancel :disabled="editBusy" @click="closeEdit">
              取消
            </button>
            <button class="btn btn--primary" type="button" data-person-edit-save :disabled="editBusy" @click="saveEdit">
              {{ editBusy ? '儲存中…' : '儲存變更' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 未命中 / 載入 / 失敗：可讀空態（不白屏），回到名錄。
         **`tmp-` 暫存編號先分兩支**（本單）：解析中短狀態 / 解析不到的誠實提示 ——
         不把「還沒對照完」或「本機暫存行」說成「查無此印人」，也不給編輯入口。 -->
    <section v-else class="panel person__panel">
      <div class="panel__body person__body">
        <!-- 解析中（短狀態）：就緒後自動 `replace` 到正式編號，無需手動刷新。 -->
        <div v-if="resolving" class="person__empty" data-person-temp-resolving>
          <p class="person__empty-title">正在對照雲端編號…</p>
          <p class="person__empty-body">正在把本機暫存行對照雲端正式印人編號，就緒後會自動跳轉，無需手動刷新。</p>
        </div>
        <!-- 解析不到：**誠實提示**（不回跳、不報錯、零編輯入口；不編造正式編號）。 -->
        <div v-else-if="tempUnresolved" class="person__empty" data-person-temp-row>
          <p class="person__empty-title">本機暫存行尚未取得正式印人編號，暫不可編輯。</p>
          <p class="person__empty-body">此編號是本機鏡像的暫存行，雲端尚無對應的正式印人；可返回名錄重新查找。</p>
          <RouterLink class="btn btn--ghost person__empty-link" :to="{ name: 'persons' }">返回印家名錄</RouterLink>
        </div>
        <div v-else class="person__empty" :data-person-missing="missing ? '1' : '0'">
          <p class="person__empty-title">{{ emptyTitle }}</p>
          <p class="person__empty-body">{{ emptyBody }}</p>
          <RouterLink class="btn btn--ghost person__empty-link" :to="{ name: 'persons' }">返回印家名錄</RouterLink>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.person {
  position: relative;
}

.person__back {
  padding: var(--s-2) 0 var(--s-1);
}

.person__back-link {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  letter-spacing: 0.04em;
  text-decoration: none;
}

.person__back-link:hover {
  color: var(--c-brand-strong);
}

.person__head {
  padding: var(--s-2) 0 var(--s-3);
  border-bottom: 1px solid var(--c-line);
}

.person__eyebrow {
  display: inline-block;
  margin: 0;
  padding: 2px var(--s-2);
  border: 1px solid var(--c-line);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
}

.person__title {
  margin: var(--s-3) 0 0;
  font-size: var(--t-3xl);
  letter-spacing: 0.2em;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.person__sub {
  margin: var(--s-2) 0 0;
  color: var(--c-text-muted);
  font-size: var(--t-md);
  letter-spacing: 0.03em;
}

.person__dot {
  margin: 0 var(--s-2);
  color: var(--c-text-muted);
}

.person__facts {
  display: flex;
  align-items: baseline;
  gap: var(--s-4);
  flex-wrap: wrap;
  margin: var(--s-3) 0 0;
}

.person__fact {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  min-width: 0;
}

.person__fact dt {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.person__fact dd {
  margin: 0;
  font-size: var(--t-sm);
  overflow-wrap: anywhere;
}

.person__na {
  color: var(--c-text-muted);
}

/* ------------------------------ 屬性區塊 ------------------------------ */
.person__panel {
  margin-top: var(--s-4);
}

.person__body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--s-4) var(--s-5);
}

.person__field {
  min-width: 0;
}

.person__field--wide {
  grid-column: 1 / -1;
}

.person__key {
  margin: 0 0 var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.12em;
}

.person__value {
  margin: 0;
  font-size: var(--t-lg);
  letter-spacing: 0.05em;
  overflow-wrap: anywhere;
}

.person__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.person__chip {
  padding: 2px var(--s-2);
  border: 1px solid var(--slot-chip-line);
  border-radius: var(--r-sm);
  background: var(--slot-chip-bg);
  color: var(--slot-chip-text);
  font-size: var(--t-sm);
  letter-spacing: 0.04em;
  overflow-wrap: anywhere;
}

.person__lines {
  margin: 0;
  padding: 0;
  list-style: none;
}

.person__line {
  padding: var(--s-1) 0;
  border-bottom: 1px dashed var(--c-line);
  font-size: var(--t-sm);
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.person__line:last-child {
  border-bottom: 0;
}

.person__prose {
  font-size: var(--t-sm);
  line-height: 2;
  letter-spacing: 0.02em;
}

.person__para {
  margin: 0 0 var(--s-2);
  overflow-wrap: anywhere;
}

.person__para:last-child {
  margin-bottom: 0;
}

/* ------------------------------ 僅基礎信息提示 ------------------------------
   令牌一律取既有变量（`--c-line` / `--c-text-muted` / `--s-*` / `--t-*`），不新造颜色。 */
.person__notice {
  margin: 0;
  padding: var(--s-3) var(--s-4);
  border: 1px dashed var(--c-line);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  line-height: 1.9;
  letter-spacing: 0.06em;
  overflow-wrap: anywhere;
}

/* ------------------------------ 空態 ------------------------------ */
.person__empty {
  grid-column: 1 / -1;
  margin: var(--s-6) 0;
  padding: var(--s-6) var(--s-5);
  border: 1px dashed var(--c-line);
  text-align: center;
}

.person__empty-title {
  margin: 0 0 var(--s-2);
  color: var(--c-text);
  font-size: var(--t-lg);
  letter-spacing: 0.16em;
}

.person__empty-body {
  margin: 0 0 var(--s-3);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  line-height: 1.9;
}

.person__empty-link {
  display: inline-block;
  text-decoration: none;
}

/* ------------------------------ 編輯對話框（管理員） ------------------------------
   形態与既有模态**逐字同形**（`ConfirmDialog` / `AddSealFaceDialog` / `PersonProposalDialog`）：
   固定遮罩 ＋ `inset: 0` ＋ `z-index: 40` ＋ grid 居中 ＋ `--c-overlay` 底；
   框体只用既有表面 / 线 / 阴影令牌（`--c-surface` / `--c-line-strong` / `--r-lg` / `--shadow-2`）。
   遮罩**不设**点击关闭 —— 与上述模态同形（关窗只经「取消」钮 ＋ Esc）；
   Esc ＝ 取消走全仓单点 `utils/useEscToClose.js`（提交中不生效），本页恰 1 扇自建弹窗。
   颜色零新增：错误行取既有 `--c-danger`，其余取 `--c-text*` / `--c-line*`。 */
.person-edit-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  overflow-y: auto;
  background: var(--c-overlay);
}

.person-edit-box {
  width: 100%;
  max-width: 560px;
  max-height: 88vh;
  overflow-y: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.person-edit-box__title {
  margin: 0 0 var(--s-2);
  color: var(--c-text);
  font-size: var(--t-lg);
  letter-spacing: 0.08em;
}

.person-edit-box__lede {
  margin: 0 0 var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  line-height: 1.9;
}

/* 失败行：**服务端原文**上屏（文案不在样式层造第二套）；色取既有危险令牌。 */
.person-edit-box__error {
  margin: var(--s-3) 0 0;
  padding: var(--s-2) var(--s-3);
  border-left: 2px solid var(--c-danger);
  color: var(--c-danger);
  font-size: var(--t-sm);
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.person-edit-box__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}

/* 四组字段集：只用既有线色分组（浏览器默认 fieldset 边框 / 内边距在此归零重建）。 */
.person-edit-group {
  min-width: 0;
  margin: 0 0 var(--s-3);
  padding: var(--s-3) var(--s-4) var(--s-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}

.person-edit-group:last-of-type {
  margin-bottom: 0;
}

/* 组内末项不再留白（`.field` 自带 `margin-bottom: var(--s-4)`）。 */
.person-edit-group .field:last-child {
  margin-bottom: 0;
}

.person-edit-group__legend {
  padding: 0 var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.12em;
}

/* ------------------------------ 编辑就地反馈（页首之下） ------------------------------
   本类只补边距：底色 / 边框 / 字号一律由既有 `.notice`（金底条）给出，不另立第二套配色。 */
.person__edit-feedback {
  margin: var(--s-3) 0 0;
}

/* ------------------------------ 窄屏（≤640px） ------------------------------ */
@media (max-width: 640px) {
  .person__title {
    font-size: var(--t-2xl);
    letter-spacing: 0.14em;
  }

  .person-edit-mask {
    padding: var(--s-3);
    place-items: start center;
  }

  .person-edit-box {
    max-height: 92vh;
    padding: var(--s-4);
  }

  .person__body {
    grid-template-columns: minmax(0, 1fr);
    padding: var(--s-3);
  }

  .person__empty {
    margin: var(--s-4) 0;
    padding: var(--s-5) var(--s-3);
  }
}
</style>
