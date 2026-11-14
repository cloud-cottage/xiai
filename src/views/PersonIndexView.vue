<script setup>
/**
 * 印家匯徵（`/persons`）—— vA 名錄列表（本單改造）。
 * ============================================================================
 * 版面（對照 `xiai-persons-design/vA.html`）：
 *   頁首（標題 `印家匯徵` ＋「收錄 N 位印人」）→ 控制條（搜索框 ＋ 朝代篩選 ＋ 結果計數）
 *   → A–Z 分組列表（組頭黏頂，只出有人的字母 ＋ 末尾 `#`）→ 右側 A–Z 豎索引（點擊跳轉 ＋
 *   滾動高亮；≤640px 轉橫排黏頂）。
 *
 * 檢索口徑**不在此另立一套**：算法真源 ＝ `services/personSearch.js`（與印面「作者」選人控件
 * `components/PersonPicker.vue` 共用同一份「簡繁歸一 ＋ 跨欄位拼接 ＋ 三檔相關度」）：
 *   · 分組列表（無搜索）＝ `buildPersonIndex` ＋ `groupPersonsByInitial`；
 *   · 搜索態 ＝ 扁平相關度列表（`searchPersons`）⇒ **隱藏組頭與索引條**，空態文案繁體。
 *
 * 行內容（缺字段整段省略）：「姓名 · 生卒 · 朝代 · 字X · 號Y · 齋Z」；**別號不上主行**
 * （只入檢索面，見 `personSearch.js` 的 `biehao_text` token 口徑）。
 * 行點擊 ⇒ `/persons/:code`（路由 `personDetail`）。
 *
 * 朝代篩選**按庫內實際值**生成（`清 / 明 / 民國 / 現代 / 待考（空）`，其餘庫內值照實追加；
 * 全員皆無朝代 ⇒ 整個篩選器不渲染）。
 *
 * 保留既有約定：`[data-person-roster]` 容器；`[data-collect-action]` 恰一處。
 * 提案入口（2026-11-14 裁定）：控制條**常駐**「提交印人提案」＋ 底部【徵集印家】，二者同走
 * `openProposalEntry` —— **與登錄態解耦**（未登錄照常渲染可點，點擊走登錄引導帶 `redirect` 回本頁；
 * 已登錄就地打開共用提案框 `components/PersonProposalDialog.vue`）。表单不在本頁重建。
 * 水合未落定時數字位顯示占位「—」，**不得**說成「收錄 0 位」。
 * 上屏文案一律繁體（`*_chs` 副字段不上屏）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isLoggedIn } from '../data/session.js'
import { persons, seals } from '../services/index.js'
import PersonProposalDialog from '../components/PersonProposalDialog.vue'
import {
  buildPersonIndex,
  searchPersons,
  groupPersonsByInitial,
  normalizeSearchText
} from '../services/personSearch.js'

const router = useRouter()
const route = useRoute()

/* ------------------------------ 提案入口（與登錄態解耦；未登錄 ⇒ 引導登錄） ------------------------------ */
const proposalOpen = ref(false)

function openProposalEntry() {
  if (!isLoggedIn.value) {
    /* 未登錄 ⇒ 入口照常渲染、可點（不得 CSS 隱藏 / disabled 冒充），點擊走**登錄引導**
       （帶 `redirect` 回本頁），不靜默失敗。 */
    router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }
  /* 已登錄 ⇒ 就地打開共用提案框（`components/PersonProposalDialog.vue`，全站唯一一份表單；
     本頁**不自建第二個表單**）。提交仍落 `PENDING`，管理員在 `/my/corrections` 審覈。 */
  proposalOpen.value = true
}

/* ------------------------------ 數據面（只讀） ------------------------------ */

/** 正式印人行（雲端快照 / 本機鏡像；`readCollection` 已做讀緩存，逐次讀取不重解析）。 */
const rosterRows = computed(() => persons.listPersons())

/* 數據源狀態：首屏水合未落定時 `listPersons()` 回空集 —— 此刻**不得**把「還沒讀到」說成
   「名錄暫無資料」，故讀數據層的狀態讀數（`pending` ⇒ 載入態 / `failed` ⇒ 可重試失敗態）。 */
const source = computed(() => seals.dataSourceState())

/* ------------------------------ 行派生（只讀） ------------------------------ */

function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 行編碼（詳情頁路由參數）：`code` 優先，退 `id`，再退 `_id`。 */
function codeOf(row) {
  if (!row || typeof row !== 'object') return ''
  return textOf(row.code) || textOf(row.id) || textOf(row._id)
}

function firstOf(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return textOf(list[0])
}

/** 顯示名（派生單點在數據層；服務層 `persons.personName` 即其投影）。 */
function nameOf(row) {
  return persons.personName(row) || ''
}

/** 生卒（兩端皆有 ⇒ `1829–1884`；只有一端 ⇒ 該端；皆無 ⇒ 空串）。 */
function lifeOf(row) {
  const birth = textOf(row && row.birth_year)
  const death = textOf(row && row.death_year)
  if (birth && death) return `${birth}–${death}`
  return birth || death
}

function dynastyOf(row) {
  return textOf(row && row.dynasty)
}

/* 新口徑單值欄位（遷移後真源）優先；舊數組僅在真源缺失時兜底（遷移未覆蓋的行仍能顯示）。 */
function courtesyOf(row) {
  return textOf(row && row.courtesy_name) || firstOf(row && row.courtesy_names)
}

function artOf(row) {
  return textOf(row && row.art_name) || firstOf(row && row.art_names)
}

function zhaihaoOf(row) {
  return textOf(row && row.zhaihao)
}

/* ------------------------------ 檢索 / 篩選 ------------------------------ */

const query = ref('')
const dynastyPick = ref('')
const searching = computed(() => textOf(query.value) !== '')

/** 朝代選項（按庫內實際值；全員皆無朝代 ⇒ 空數組 ⇒ 篩選器不渲染）。 */
const DYNASTY_ORDER = ['清', '明', '民國', '現代']
const EMPTY_DYNASTY = '待考'

const dynastyOptions = computed(() => {
  const counts = new Map()
  for (const row of rosterRows.value) {
    const key = dynastyOf(row) || EMPTY_DYNASTY
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const hasReal = [...counts.keys()].some((key) => key !== EMPTY_DYNASTY)
  if (!hasReal) return []
  const ordered = DYNASTY_ORDER.filter((key) => counts.has(key))
  const rest = [...counts.keys()]
    .filter((key) => !DYNASTY_ORDER.includes(key) && key !== EMPTY_DYNASTY)
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
  const keys = [...ordered, ...rest]
  if (counts.has(EMPTY_DYNASTY)) keys.push(EMPTY_DYNASTY)
  return keys.map((key) => ({
    value: key,
    label: `${key}　${counts.get(key)} 人`
  }))
})

/** 朝代篩選後的行（`待考` ＝ 朝代為空的行）。 */
const baseRows = computed(() => {
  const pick = textOf(dynastyPick.value)
  if (!pick) return rosterRows.value
  if (pick === EMPTY_DYNASTY) return rosterRows.value.filter((row) => !dynastyOf(row))
  return rosterRows.value.filter((row) => dynastyOf(row) === pick)
})

/** 候選側歸一索引（一次性預計算；算法真源見 `services/personSearch.js`）。 */
const personIndex = computed(() => buildPersonIndex(baseRows.value))

const visibleRows = computed(() =>
  searching.value ? searchPersons(personIndex.value, query.value) : baseRows.value
)

/* ------------------------------ 顯示卡片（一次性派生） ------------------------------ */

/**
 * 搜索命中高亮切片：候選與查詢詞**兩邊同走**逐字 s2t 歸一（長度不變 ⇒ 下標可回投原文）。
 * @param {string} value 原文
 * @param {string} keyword 已歸一（`normalizeSearchText`）的關鍵詞
 * @returns {Array<{text:string, hit:boolean}>}
 */
function markParts(value, keyword) {
  const source_ = value === null || value === undefined ? '' : String(value)
  if (!keyword) return [{ text: source_, hit: false }]
  const fold = normalizeSearchText(source_)
  const at = fold.indexOf(keyword)
  if (at === -1) return [{ text: source_, hit: false }]
  const parts = []
  if (at > 0) parts.push({ text: source_.slice(0, at), hit: false })
  parts.push({ text: source_.slice(at, at + keyword.length), hit: true })
  const tail = source_.slice(at + keyword.length)
  if (tail) parts.push({ text: tail, hit: false })
  return parts
}

const cards = computed(() => {
  const keyword = searching.value ? normalizeSearchText(textOf(query.value)) : ''
  return visibleRows.value.map((row) => {
    const name = nameOf(row)
    return {
      code: codeOf(row),
      name,
      nameParts: markParts(name, keyword),
      life: lifeOf(row),
      dynasty: dynastyOf(row) || EMPTY_DYNASTY,
      unknownDynasty: dynastyOf(row) === '',
      courtesy: courtesyOf(row),
      art: artOf(row),
      zhaihao: zhaihaoOf(row)
    }
  })
})

/** 組內卡片（行物件 → 卡片）：分組按原行排序（`groupPersonsByInitial` 的次序），不另排。 */
const cardOfRow = computed(() => {
  const map = new Map()
  visibleRows.value.forEach((row, index) => map.set(row, cards.value[index]))
  return map
})

const groups = computed(() => {
  if (searching.value) return []
  return groupPersonsByInitial(visibleRows.value, { personName: nameOf }).map((group) => ({
    initial: group.initial,
    cards: group.rows.map((row) => cardOfRow.value.get(row)).filter(Boolean)
  }))
})

/**
 * 渲染条目（單一 `v-for` 出「組頭 ＋ 行」）：搜索態 ⇒ 全扁平行、無組頭；
 * 非搜索態 ⇒ 每組一個組頭（`[data-roster-group]`，豎索引的跳轉錨點）＋ 該組行。
 */
const entries = computed(() => {
  if (searching.value) {
    return cards.value.map((card, index) => ({ key: `r${index}`, kind: 'row', card }))
  }
  const out = []
  for (const group of groups.value) {
    out.push({ key: `h${group.initial}`, kind: 'head', initial: group.initial, count: group.cards.length })
    for (const card of group.cards) out.push({ key: `r${card.code}`, kind: 'row', card })
  }
  return out
})

/* ------------------------------ A–Z 豎索引（只列有人的字母 ＋ `#`） ------------------------------ */

const indexLetters = computed(() => (searching.value ? [] : groups.value.map((group) => group.initial)))
const activeInitial = ref('')

/** 高亮當前組：取最後一個「已滾過參考線」的組頭（組頭黏頂高度見樣式 `scroll-margin-top`）。 */
const SPY_OFFSET = 128
function syncActive() {
  if (searching.value) return
  let current = ''
  document.querySelectorAll('[data-roster-group]').forEach((head) => {
    if (head.getBoundingClientRect().top <= SPY_OFFSET) {
      const value = head.getAttribute('data-roster-group')
      if (value) current = value
    }
  })
  activeInitial.value = current
}

function jumpTo(initial) {
  const value = textOf(initial)
  if (!value) return
  const head = document.querySelector(`[data-roster-group="${value}"]`)
  if (!head) return
  activeInitial.value = value
  head.scrollIntoView({ block: 'start' })
}

onMounted(() => {
  window.addEventListener('scroll', syncActive, { passive: true })
  syncActive()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', syncActive)
})
/* 數據落定 / 篩選變化後組頭重生 ⇒ 重新判定一次高亮（不輪詢、不定時）。 */
watch(indexLetters, () => nextTick(syncActive))

/* ------------------------------ 空態文案（繁體） ------------------------------ */

const loading = computed(() => rosterRows.value.length === 0 && source.value.pending)
const unavailable = computed(() => rosterRows.value.length === 0 && source.value.failed)

/* 水合期（首屏數據未落定）**不得**把「還沒讀到」說成「收錄 0 位」：數字位顯示占位「—」，
   落定後顯示真實數（空集則照實顯示 0）。 */
const totalLabel = computed(() => (loading.value ? '—' : String(rosterRows.value.length)))
const visibleLabel = computed(() => (loading.value ? '—' : String(visibleRows.value.length)))

const emptyTitle = computed(() => {
  if (searching.value || textOf(dynastyPick.value)) return '查無所獲'
  if (loading.value) return '正在讀取印人資料'
  if (unavailable.value) return '印人資料暫時無法讀取'
  return '名錄暫無資料'
})

const emptyBody = computed(() => {
  if (loading.value) return '雲端印人資料載入中，就緒後會自動顯示，無需手動刷新。'
  if (unavailable.value) return '雲端資料暫時未能讀取（目前顯示的是本機資料），請稍後重新整理本頁。'
  if (searching.value) return '姓名、字、號、齋號皆可檢索，簡體繁體互通；可試：趙之謙 · 悲盦 · 二金蜨堂。'
  if (textOf(dynastyPick.value)) return '此朝代暫無收錄，可切回「全部朝代」瀏覽。'
  return '印家名錄暫時留空，稍後補充。'
})
</script>

<template>
  <section class="roster">
    <!-- 頁首：標題 ＋ 收錄總數（總數取全量行數，不隨搜索 / 篩選變化）。 -->
    <header class="roster__head">
      <p class="roster__eyebrow">印人 · 名錄</p>
      <h1 class="roster__title">印家匯徵</h1>
      <p class="roster__sub">
        收錄 <b data-roster-total>{{ totalLabel }}</b> 位印人<span class="roster__dot">·</span>依姓氏拼音 A–Z 編次<span class="roster__dot">·</span>字 · 號 · 齋號可檢索
      </p>
    </header>

    <!-- 控制條：搜索 ＋ 朝代篩選 ＋ 結果計數（黏頂，方便長列表翻查）。 -->
    <div class="roster__bar" data-roster-bar>
      <label class="roster__search">
        <span class="roster__search-icon" aria-hidden="true">搜</span>
        <input
          v-model.trim="query"
          class="roster__input"
          type="search"
          data-roster-search
          placeholder="搜尋姓名、字、號、齋號（簡繁皆可）"
          aria-label="搜尋印人"
          autocomplete="off"
        >
        <button v-if="query" class="roster__clear" type="button" aria-label="清除" @click="query = ''">×</button>
      </label>
      <label v-if="dynastyOptions.length" class="roster__filter">
        <select v-model="dynastyPick" class="roster__select" data-roster-dynasty aria-label="朝代篩選">
          <option value="">全部朝代</option>
          <option v-for="option in dynastyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <button
        class="btn btn--primary roster__submit"
        type="button"
        data-action="person-proposal-open"
        data-person-proposal-entry="persons-index"
        @click="openProposalEntry"
      >
        提交印人提案
      </button>
      <span class="roster__count" data-roster-count><b>{{ visibleLabel }}</b> 位</span>
    </div>

    <!-- A–Z 豎索引：只列有人的字母（含末尾 `#`）；搜索態整個不渲染。 -->
    <nav v-if="indexLetters.length" class="roster__rail" aria-label="姓氏首字母索引">
      <button
        v-for="letter in indexLetters"
        :key="letter"
        class="roster__rail-btn"
        :class="{ 'roster__rail-btn--on': letter === activeInitial }"
        type="button"
        :data-roster-index="letter"
        :aria-label="`跳至 ${letter} 組`"
        @click="jumpTo(letter)"
      >
        {{ letter }}
      </button>
    </nav>

    <p v-if="searching" class="roster__note" data-roster-note>
      檢索「<b>{{ query }}</b>」<span class="roster__dot">·</span>命中 <b>{{ visibleRows.length }}</b> 位<span class="roster__dot">·</span>依相關度排序
    </p>

    <section class="panel roster__panel">
      <div class="panel__body roster__body" data-person-roster>
        <div v-if="!visibleRows.length" class="roster__empty" data-roster-empty>
          <p class="roster__empty-title">{{ emptyTitle }}</p>
          <p class="roster__empty-body">{{ emptyBody }}</p>
        </div>
        <template v-else>
          <template v-for="entry in entries" :key="entry.key">
            <!-- 組頭（A–Z ＋ 人數）：黏頂；`[data-roster-group]` 是豎索引的跳轉錨點。 -->
            <div v-if="entry.kind === 'head'" class="roster__group" :data-roster-group="entry.initial">
              <span class="roster__letter">{{ entry.initial }}</span>
              <span class="roster__gcount">{{ entry.count }} 位</span>
              <span class="roster__rule"></span>
            </div>
            <!-- 行：姓名 · 生卒 · 朝代 · 字 · 號 · 齋（缺字段省略；別號不上主行）。 -->
            <button
              v-else
              class="roster__row"
              type="button"
              :data-person-code="entry.card.code"
              @click="router.push({ name: 'personDetail', params: { code: entry.card.code } })"
            >
              <span class="roster__row-main">
                <span class="roster__nameline">
                  <span class="roster__name">
                    <template v-for="(part, index) in entry.card.nameParts" :key="index">
                      <mark v-if="part.hit" class="roster__mark">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </span>
                  <span v-if="entry.card.life" class="roster__life">{{ entry.card.life }}</span>
                </span>
                <span class="roster__meta">
                  <span class="roster__dyn" :class="{ 'roster__dyn--na': entry.card.unknownDynasty }">{{ entry.card.dynasty }}</span>
                  <span v-if="entry.card.courtesy" class="roster__seg"><span class="roster__k">字</span>{{ entry.card.courtesy }}</span>
                  <span v-if="entry.card.art" class="roster__seg"><span class="roster__k">號</span>{{ entry.card.art }}</span>
                  <span v-if="entry.card.zhaihao" class="roster__seg"><span class="roster__k">齋</span>{{ entry.card.zhaihao }}</span>
                </span>
              </span>
            </button>
          </template>
        </template>
      </div>
    </section>

    <!-- 徵集入口：與登錄態解耦（未登錄仍渲染、可點，點擊引導登錄）；已登錄即開共用提案框。 -->
    <section class="panel roster__collect">
      <div class="panel__body roster__collect-body">
        <button
          class="btn btn--primary"
          type="button"
          data-collect-action="person-collect"
          @click="openProposalEntry"
        >
          徵集印家
        </button>
      </div>
    </section>

    <!-- 共用印人提案框（全站唯一一份表單；本頁由控制條常駐入口 / 底部徵集入口打開）。 -->
    <PersonProposalDialog v-if="proposalOpen" @close="proposalOpen = false" />
  </section>
</template>

<style scoped>
.roster {
  --roster-bar-h: 68px;
  --roster-rail-h: 42px;
  position: relative;
}

.roster__head {
  padding: var(--s-2) 0 var(--s-3);
}

.roster__eyebrow {
  display: inline-block;
  margin: 0;
  padding: 2px var(--s-2);
  border: 1px solid var(--c-line);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
}

.roster__title {
  margin: var(--s-3) 0 0;
  font-size: var(--t-3xl);
  letter-spacing: 0.24em;
}

.roster__sub {
  margin: var(--s-2) 0 0;
  color: var(--c-text-muted);
  font-size: var(--t-md);
  letter-spacing: 0.03em;
}

.roster__sub b {
  color: var(--c-text);
}

.roster__dot {
  margin: 0 var(--s-2);
  color: var(--c-text-muted);
}

/* ------------------------------ 控制條 ------------------------------ */
.roster__bar {
  position: sticky;
  top: var(--layout-header-h);
  z-index: 15;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
  padding: var(--s-3) 0;
  background: var(--c-bg);
  border-bottom: 1px solid var(--c-line);
}

.roster__search {
  position: relative;
  flex: 1 1 260px;
  max-width: 420px;
  display: block;
}

.roster__search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.04em;
  pointer-events: none;
}

.roster__input {
  width: 100%;
  height: 40px;
  padding: 0 32px 0 34px;
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-md);
  outline: none;
  appearance: none;
}

.roster__input:focus {
  border-color: var(--c-brand);
}

.roster__input::placeholder {
  color: var(--c-text-muted);
}

.roster__clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 26px;
  height: 26px;
  border: 0;
  background: none;
  color: var(--c-text-muted);
  font-size: var(--t-lg);
  line-height: 1;
  cursor: pointer;
}

.roster__select {
  height: 40px;
  padding: 0 var(--s-3);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-md);
  cursor: pointer;
}

.roster__count {
  margin-left: auto;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  white-space: nowrap;
}

.roster__count b {
  color: var(--c-text);
  font-size: var(--t-lg);
}

/* ------------------------------ A–Z 豎索引 ------------------------------ */
.roster__rail {
  position: fixed;
  right: var(--s-3);
  top: 50%;
  transform: translateY(-50%);
  z-index: 18;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--s-2) var(--s-1);
  background: var(--c-surface);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
}

.roster__rail-btn {
  width: 26px;
  height: 21px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-text-muted);
  font-family: inherit;
  font-size: var(--t-xs);
  cursor: pointer;
  border-radius: var(--r-xs);
}

.roster__rail-btn:hover {
  color: var(--c-text);
  background: var(--c-brand-soft);
}

.roster__rail-btn--on {
  background: var(--c-brand);
  color: var(--slot-tag-text);
}

/* ------------------------------ 結果提示 / 空態 ------------------------------ */
.roster__note {
  margin: 0;
  padding: var(--s-3) 0 var(--s-2);
  border-bottom: 1px solid var(--c-line);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.roster__note b {
  color: var(--c-brand-strong);
}

.roster__panel {
  margin-top: var(--s-4);
  padding: var(--s-2) var(--s-4) var(--s-4);
}

.roster__body {
  padding: 0;
}

.roster__empty {
  margin: var(--s-6) 0;
  padding: var(--s-6) var(--s-5);
  border: 1px dashed var(--c-line);
  text-align: center;
}

.roster__empty-title {
  margin: 0 0 var(--s-2);
  color: var(--c-text);
  font-size: var(--t-lg);
  letter-spacing: 0.16em;
}

.roster__empty-body {
  margin: 0;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
  line-height: 1.9;
}

/* ------------------------------ 組頭 ------------------------------ */
.roster__group {
  position: sticky;
  top: calc(var(--layout-header-h) + var(--roster-bar-h));
  z-index: 10;
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  padding: var(--s-3) 0 var(--s-2);
  background: var(--slot-panel-bg);
  border-bottom: 1px solid var(--c-line);
  scroll-margin-top: calc(var(--layout-header-h) + var(--roster-bar-h) - 2px);
}

.roster__letter {
  font-size: var(--t-xl);
  font-weight: 600;
  letter-spacing: 0.12em;
}

.roster__gcount {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.05em;
}

.roster__rule {
  flex: 1;
  height: 1px;
  background: var(--c-line);
  margin-bottom: 4px;
}

/* ------------------------------ 行 ------------------------------ */
.roster__row {
  display: flex;
  align-items: flex-start;
  gap: var(--s-4);
  width: 100%;
  padding: var(--s-3) var(--s-2);
  border: 0;
  border-bottom: 1px solid var(--c-line);
  background: none;
  color: var(--c-text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.roster__row:hover {
  background: var(--c-brand-soft);
}

.roster__row-main {
  flex: 1;
  min-width: 0;
}

.roster__nameline {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  flex-wrap: wrap;
}

.roster__name {
  font-size: var(--t-lg);
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1.4;
}

.roster__mark {
  background: var(--c-brand-soft);
  color: var(--c-brand-strong);
  padding: 0 1px;
}

.roster__life {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  letter-spacing: 0.03em;
}

.roster__meta {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-top: var(--s-1);
  font-size: var(--t-sm);
  color: var(--c-text-muted);
}

.roster__dyn {
  min-width: 38px;
  padding: 0 6px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-xs);
  color: var(--c-text);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  text-align: center;
}

.roster__dyn--na {
  border-style: dashed;
  color: var(--c-text-muted);
}

.roster__seg {
  white-space: nowrap;
}

.roster__k {
  margin-right: 4px;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* ------------------------------ 徵集入口 ------------------------------ */
.roster__collect {
  margin-top: var(--s-5);
}

.roster__collect-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-2);
}

.roster__submit {
  flex: none;
  white-space: nowrap;
}

/* ------------------------------ 窄屏（≤640px）：索引轉橫排黏頂 ------------------------------ */
@media (max-width: 640px) {
  .roster__bar {
    position: static;
    padding: var(--s-2) 0 var(--s-3);
  }

  .roster__count {
    margin-left: 0;
    width: 100%;
    text-align: right;
  }

  .roster__rail {
    position: sticky;
    top: var(--layout-header-h);
    right: auto;
    transform: none;
    flex-direction: row;
    align-items: center;
    gap: 0;
    width: 100%;
    padding: var(--s-1) var(--s-2);
    overflow-x: auto;
    background: var(--c-bg);
    border: 0;
    border-bottom: 1px solid var(--c-line);
    border-radius: 0;
    scrollbar-width: none;
  }

  .roster__rail::-webkit-scrollbar {
    display: none;
  }

  .roster__rail-btn {
    flex: none;
    width: 26px;
    height: 30px;
  }

  .roster__group {
    top: calc(var(--layout-header-h) + var(--roster-rail-h));
    scroll-margin-top: calc(var(--layout-header-h) + var(--roster-rail-h));
  }

  .roster__panel {
    padding: var(--s-1) var(--s-2) var(--s-3);
  }

  .roster__row {
    padding: var(--s-3) var(--s-1);
  }
}
</style>
