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
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { persons, seals } from '../services/index.js'
import { loadPersonDetail } from '../services/personCards.js'
import { biehaoLinesOf } from '../services/personSearch.js'

const route = useRoute()

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
   本頁只做「取到 ⇒ 上屏、取不到 ⇒ 可讀空態」的形態分流，不自行拼第二套字段面。 */
const detail = ref(null)
const detailLoading = ref(false)
let detailToken = 0

async function fetchDetail() {
  const code = wantedCode.value
  const token = (detailToken += 1)
  if (!code) {
    detail.value = { ok: false, reason: 'MISSING_REQUIRED', message: '' }
    detailLoading.value = false
    return
  }
  detailLoading.value = true
  const got = await loadPersonDetail(code)
  if (token !== detailToken) return
  detail.value = got
  detailLoading.value = false
}

watch(wantedCode, fetchDetail, { immediate: true })

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
      </header>

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
    </template>

    <!-- 未命中 / 載入 / 失敗：可讀空態（不白屏），回到名錄。 -->
    <section v-else class="panel person__panel">
      <div class="panel__body person__body">
        <div class="person__empty" :data-person-missing="missing ? '1' : '0'">
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

/* ------------------------------ 窄屏（≤640px） ------------------------------ */
@media (max-width: 640px) {
  .person__title {
    font-size: var(--t-2xl);
    letter-spacing: 0.14em;
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
