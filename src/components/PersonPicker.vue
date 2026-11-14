<script setup>
/**
 * 通讯录式「选印人」控件（**只可点选，不接受自由文本**）。
 * =====================================================================
 * 数据面单点：**检索算法全部收在** `services/personSearch.js`（纯函数：`buildPersonIndex` /
 * `searchPersons` / `groupPersonsByInitial`）—— 名录页（`views/PersonIndexView.vue`）与本控件
 * **共用同一套**「简繁归一 ＋ 单字段 ＋ 姓+值拼接 ＋ 三档相关度」算法，本控件不再自带一份。
 * 本组件自身不 import 服务层 / 数据层、不读写任何浏览器存储、不发请求 ⇒ 可在任一表单里直接挂载。
 *
 * 契约：
 *   props   `modelValue` 所选印人 id（字符串）｜`persons` 印人行数组
 *           `personName(row)` 显示名函数（缺省走本组件内置兜底链，与数据层派生同源）
 *           `label` 缺省「作者」｜`placeholder` 缺省「按姓名 / 字號 / 別名搜尋」
 *   emits   `update:modelValue`（点选 ⇒ id；**清除 ⇒ 空串**）
 *           `picked`（点选 ⇒ **整行**；清除不发此事件）
 *
 * 结构：当前选中态（姓名 ＋ 字号 ＋ 清除）→ 弹层（搜索框 ＋ 列表 ＋ 右侧 A–Z 索引条）。
 *   - 搜索是**本地过滤**（姓名 / 字 / 號 / 齋號 / 別字 / 別名 / cbdb_id 子串匹配）；
 *   - **搜索态 ＝ 扁平相关度列表**（搜索框非空时）：**无姓氏分组头、无 A–Z 索引条**，
 *     排序三档（同档保持入参顺序，稳定）＝ ① `joined` **整串恰等**置顶（「姓＋名」或
 *     「姓＋字 / 號 / 齋號 / 別名」完整相等）② 前缀命中 ③ 其余任意位置子串命中
 *     ⇒ 搜「趙之謙」/「赵之谦」**首项即本人**（`陸開鈞` 的字「畫均似趙之謙」落第三档）；
 *     **清空搜索 ⇒ 原姓氏分组 ＋ 索引条一字不改地回归**；
 *     **跨字段拼接形态**：预计算里额外收「姓＋名」「姓＋字 / 號 / 齋號 / 別名（逐值）」直接相接串
 *     ⇒ 整打全名（`趙之謙`，姓与名分属两字段）也能命中；单字段形态全部保留（命中面只增不减）；
 *     **迁移后新字段同入索引**：`courtesy_name` / `art_name` / `zhaihao`（单值）＋
 *     `courtesy_alt_names[]` / `zhaihao_alts[]`（逐值）＋ `biehao_text`（按换行与全角 `／`
 *     **双拆 token**，每个异写各自可搜；`#待核` 之类核校标记不入索引）；旧三数组
 *     （`courtesy_names` / `art_names` / `alias_names`）**原文保留、并存兼容**；
 *     **简繁归一**：查询词与候选**两边同走**逐字 s2t 归一（`toTraditionalText` ＋ 小写）再比子串
 *     ⇒ 简体（赵）/ 繁体（趙）/ 混输两向互逆；ASCII（`PR0000`）不受归一影响、仍原样子串匹配；
 *     候选侧归一文本**一次性预计算**（`persons` 变更才重建），逐键只做子串匹配；
 *   - 索引条**只列有人的字母**（`I` / `U` / `V` 等空母不出现）；无姓氏的 `#` 组在列表里有组头，
 *     索引条按「A–Z 字母」口径不收 `#`；
 *   - 键盘：`Esc` 关闭、搜索框 `↑`/`↓` 移动高亮、`Enter` 选中高亮项（无高亮 ⇒ **第一条**）；
 *   - 移动端（宽度 < 640px）弹层铺满屏；桌面为最高 420px 的浮层。
 *
 * 取证钩子：`data-person-picker` / `data-person-search` / `data-person-index="<字母>"` /
 * `data-person-option="<id>"` / `data-person-current="<id>"`（未选 ⇒ 空串）。
 *
 * 上屏文案一律繁體（`s2t(x) === x`）。
 */
import { computed, nextTick, ref, useId, watch } from 'vue'
import { buildPersonIndex, searchPersons, groupPersonsByInitial } from '../services/personSearch.js'
import { useEscToClose } from '../utils/useEscToClose.js'

const props = defineProps({
  /** 所选印人 id（字符串；空串 ＝ 未选）。 */
  modelValue: { type: String, default: '' },
  /** 印人行数组（`xiai_persons` 形状）。 */
  persons: { type: Array, default: () => [] },
  /** 显示名函数（服务层 `personName`）；缺省走本组件兜底链。 */
  personName: { type: Function, default: null },
  /** 字段标签。 */
  label: { type: String, default: '作者' },
  /** 未选时的占位文案。 */
  placeholder: { type: String, default: '按姓名 / 字號 / 別名搜尋' }
})
const emit = defineEmits(['update:modelValue', 'picked', 'filter'])

/* ------------------------------ 行派生（只读） ------------------------------ */

/** 行 id：优先 `id`，退 `_id`；两者皆无 ⇒ 空串。 */
function idOf(row) {
  if (!row || typeof row !== 'object') return ''
  const value = row.id !== undefined && row.id !== null ? row.id : row._id
  return value === undefined || value === null ? '' : String(value)
}

/** 取数组首项（trim 后；空 ⇒ `''`）。 */
function firstOf(list) {
  if (!Array.isArray(list) || !list.length) return ''
  const value = list[0]
  return value === undefined || value === null ? '' : String(value).trim()
}

/** 显示名：调用方给了 `personName` 就用它；否则走兜底链（姓＋名 → 字 → 號 → 空串）。 */
function nameOf(row) {
  if (typeof props.personName === 'function') {
    const value = props.personName(row)
    return value === null || value === undefined ? '' : String(value)
  }
  if (!row || typeof row !== 'object') return ''
  const full = `${String(row.family_name || '').trim()}${String(row.given_name || '').trim()}`
  if (full) return full
  return firstOf(row.courtesy_names) || firstOf(row.art_names)
}

/** 字号首项（字 → 號）；与显示名重复时不重复呈现。 */
function artOf(row) {
  if (!row || typeof row !== 'object') return ''
  return firstOf(row.courtesy_names) || firstOf(row.art_names)
}

/** 朝代（无 ⇒ 空串）。 */
function dynastyOf(row) {
  return !row || typeof row !== 'object' || !row.dynasty ? '' : String(row.dynasty).trim()
}

/* ------------------------------ 当前选中态 ------------------------------ */

const selectedRow = computed(() => {
  const target = String(props.modelValue || '')
  if (!target) return null
  return (Array.isArray(props.persons) ? props.persons : []).find((row) => idOf(row) === target) || null
})

/** 清除 ⇒ 只回传空串（不发 `picked`：只有点选才回传整行）。 */
function clearSelection() {
  emit('update:modelValue', '')
}

/* ------------------------------ 弹层开合 ------------------------------ */

const open = ref(false)
const searchEl = ref(null)
const listEl = ref(null)

function openPicker() {
  if (open.value) return
  open.value = true
  query.value = ''
  activeIndex.value = -1
  nextTick(() => {
    if (searchEl.value && typeof searchEl.value.focus === 'function') searchEl.value.focus()
  })
}

function closePicker() {
  if (!open.value) return
  open.value = false
}

/* ESC ＝ 取消（全仓单点实现）：本控件是**弹层**（常驻挂载、按需开），故按 `open` 注册 / 出栈。
   浮层开着时它就是最上层 ⇒ 一次 ESC 只关浮层；浮层关掉后再按 ESC 才关外层弹窗。
   旧的 `@keydown.esc.prevent` 已移除（否则同一按键会**重复触发**：本地关闭 ＋ 全局关闭）。 */
useEscToClose({ isActive: () => open.value, onCancel: closePicker })

function togglePicker() {
  if (open.value) closePicker()
  else openPicker()
}

/* ------------------------------ 本地过滤 + 分组 ------------------------------ */

const query = ref('')

/**
 * 候選側歸一索引（**一次性預計算**）：`persons` 變更才重建；570 行只建一次，之後每次輸入
 * 只對既有串做子串匹配（不逐鍵重跑 s2t）。算法本體 ＝ `services/personSearch.js`
 * `buildPersonIndex`（**與名錄頁共用同一份**，本控件不再自帶一套）。
 */
const personIndex = computed(() => buildPersonIndex(props.persons))

/**
 * 搜索态（搜索框非空）：**扁平相关度列表**（无分组头、无索引条）；
 * 清空搜索 ⇒ `false` ⇒ 恢复姓氏分组 ＋ A–Z 索引条（原行为）。
 */
const searching = computed(() => String(query.value || '').trim() !== '')

/**
 * 过滤后的行（**搜索态三档相关度排序**，同档保持入参顺序 ⇒ 稳定）：
 * ① `joined` **整串恰等**置顶（「姓＋名」/「姓＋字·號·別名」完整相等，即搜全名时本尊在首）；
 * ② 前缀命中（任一检索面串以关键字开头）；③ 其余任意位置子串命中。
 * 排序只动候选序、不改命中面：搜「趙之謙」时 `陸開鈞`（字「畫均似趙之謙」）仍命中，但落第三档。
 */
const visibleRows = computed(() =>
  searching.value ? searchPersons(personIndex.value, query.value) : Array.isArray(props.persons) ? props.persons : []
)

/** 分组：`[{ initial, rows }]`，按 `GROUP_ORDER`（A…Z、`#` 最后），**只出非空组**（清空搜索才计算）。 */
const groups = computed(() => (searching.value ? [] : groupPersonsByInitial(visibleRows.value, { personName: nameOf })))

/** 扁平顺序（＝搜索态按相关度；清空后 ＝ 组内顺序连接）：键盘高亮与 `Enter` 选中都按它走。 */
const flatOptions = computed(() => (searching.value ? visibleRows.value : groups.value.flatMap((group) => group.rows)))

/**
 * 过滤状态**只读回传**（`filter` 事件）：父组件据此判「作者检索无命中」⇒ 露出「提交印人提案」入口
 * （如 `UploadSealDialog`）。**不在父组件里复制第二套检索算法** —— 命中面唯一真源仍在本控件。
 */
watch(
  () => [String(query.value || '').trim(), flatOptions.value.length],
  () => emit('filter', { query: String(query.value || '').trim(), count: flatOptions.value.length })
)

/** 行 id → 扁平下标（O(1) 判高亮，避免每行 `findIndex`）。 */
const flatIndexById = computed(() => {
  const map = new Map()
  flatOptions.value.forEach((row, index) => map.set(idOf(row), index))
  return map
})

/** 索引条按钮：只列 **A–Z 且组非空** 的字母（`#` 不收，见文件头注）；**搜索态不渲染**（`groups` 空 ⇒ 空数组）。 */
const indexLetters = computed(() =>
  groups.value.map((group) => group.initial).filter((initial) => /^[A-Z]$/.test(initial))
)

const emptyText = computed(() =>
  (Array.isArray(props.persons) && props.persons.length ? '查無符合的作者' : '暫無可選作者')
)

/* ------------------------------ 键盘高亮 ------------------------------ */

const uid = String(useId() || '').replace(/[^a-zA-Z0-9-]/g, '') || 'pp'
/** 列表盒 DOM id（按实例加盐：同页多个选择器不撞 id）。 */
const listboxId = `pp-listbox-${uid}`
const activeIndex = ref(-1)

/** 高亮行 id（无 ⇒ `''`）。 */
const activeId = computed(() => {
  const row = flatOptions.value[activeIndex.value]
  return row ? idOf(row) : ''
})

/** 高亮项的 DOM id（供 `aria-activedescendant`）。 */
const activeOptionId = computed(() =>
  activeIndex.value >= 0 ? `pp-opt-${uid}-${activeIndex.value}` : ''
)

watch(query, () => {
  activeIndex.value = -1
})
watch(flatOptions, (rows) => {
  if (activeIndex.value >= rows.length) activeIndex.value = rows.length ? rows.length - 1 : -1
})

function moveActive(step) {
  const total = flatOptions.value.length
  if (!total) {
    activeIndex.value = -1
    return
  }
  if (activeIndex.value < 0) {
    activeIndex.value = step > 0 ? 0 : total - 1
  } else {
    const next = activeIndex.value + step
    activeIndex.value = next < 0 ? 0 : next > total - 1 ? total - 1 : next
  }
  scrollActiveIntoView()
}

function pickActive() {
  const rows = flatOptions.value
  const index = activeIndex.value >= 0 ? activeIndex.value : 0
  const row = rows[index]
  if (row) pick(row)
}

function onSearchKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    pickActive()
  }
}

/* ------------------------------ 点选 / 索引跳转 ------------------------------ */

/** 点选一行 ⇒ 回填 id ＋ 回传整行 ＋ 关闭；**没有任何自由文本回填路径**。 */
function pick(row) {
  const id = idOf(row)
  if (!id) return
  emit('update:modelValue', id)
  emit('picked', row)
  closePicker()
}

/* 元素登记（函数 ref；只作滚动定位，不参与渲染态）。 */
const sectionRefs = ref({})
const optionRefs = ref(new Map())

function setSectionRef(initial, element) {
  if (element) sectionRefs.value[initial] = element
  else delete sectionRefs.value[initial]
}

function setOptionRef(id, element) {
  if (element) optionRefs.value.set(id, element)
  else optionRefs.value.delete(id)
}

/** 索引条点击 ⇒ 列表滚到该分组（`.pp__list` 是定位祖先 ⇒ `offsetTop` 即内容坐标）。 */
function jumpTo(initial) {
  const section = sectionRefs.value[initial]
  const list = listEl.value
  if (!section || !list) return
  list.scrollTo?.({ top: section.offsetTop })
}

/** 高亮项滚进可视区（只滚列表，不动整页）。 */
function scrollActiveIntoView() {
  nextTick(() => {
    const list = listEl.value
    const element = optionRefs.value.get(activeId.value)
    if (!list || !element) return
    const top = element.offsetTop
    const bottom = top + element.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  })
}

defineExpose({ open, query, groups, activeIndex })
</script>

<template>
  <div class="pp" data-person-picker>
    <!-- 当前选中态：姓名 ＋ 字号（有则）＋ 清除；未选 ⇒ placeholder。 -->
    <span class="pp__label">{{ label }}</span>
    <div class="pp__control">
      <button
        class="pp__trigger"
        type="button"
        :data-person-current="String(modelValue || '')"
        :aria-expanded="open ? 'true' : 'false'"
        aria-haspopup="dialog"
        @click="togglePicker"
      >
        <span v-if="selectedRow" class="pp__value">
          <span class="pp__name">{{ nameOf(selectedRow) }}</span>
          <span v-if="artOf(selectedRow) && artOf(selectedRow) !== nameOf(selectedRow)" class="pp__art">{{ artOf(selectedRow) }}</span>
          <span v-if="dynastyOf(selectedRow)" class="pp__dynasty">{{ dynastyOf(selectedRow) }}</span>
        </span>
        <span v-else class="pp__placeholder">{{ placeholder }}</span>
        <span class="pp__caret" aria-hidden="true"></span>
      </button>
      <button
        v-if="selectedRow"
        class="pp__clear"
        type="button"
        :aria-label="`清除${label}`"
        data-person-clear
        @click.stop="clearSelection"
      >
        清除
      </button>
    </div>

    <!-- 遮罩：点弹层之外关闭。 -->
    <div v-if="open" class="pp__mask" data-person-mask @click="closePicker"></div>

    <!-- 弹层：搜索 ＋ 列表（搜索态扁平相关度 / 清空后姓氏分组）＋ 右侧 A–Z 索引条（清空后才有）。 -->
    <div
      v-if="open"
      class="pp__panel"
      role="dialog"
      aria-modal="true"
      aria-label="選擇作者"
      data-person-panel
    >
      <div class="pp__search-row">
        <input
          ref="searchEl"
          v-model="query"
          class="pp__search"
          type="text"
          autocomplete="off"
          data-person-search
          role="combobox"
          aria-expanded="true"
          :aria-controls="listboxId"
          :aria-activedescendant="activeOptionId"
          aria-autocomplete="list"
          aria-label="搜尋作者"
          placeholder="搜尋姓名 / 字 / 號 / 別名"
          @keydown="onSearchKeydown"
        />
      </div>

      <div class="pp__body">
        <ul
          v-if="flatOptions.length"
          :id="listboxId"
          ref="listEl"
          class="pp__list"
          role="listbox"
          aria-label="作者清單"
        >
          <!-- 搜索态（`searching`）：**扁平相关度列表** —— 无分组头、无 `data-person-group`。 -->
          <template v-if="searching">
            <li
              v-for="(row, index) in flatOptions"
              :id="`pp-opt-${uid}-${index}`"
              :key="idOf(row)"
              :ref="(element) => setOptionRef(idOf(row), element)"
              class="pp__option"
              :class="{ 'is-active': activeId === idOf(row), 'is-selected': String(modelValue || '') === idOf(row) }"
              role="option"
              :aria-selected="String(modelValue || '') === idOf(row) ? 'true' : 'false'"
              :data-person-option="idOf(row)"
              @click="pick(row)"
            >
              <span class="pp__option-name">{{ nameOf(row) }}</span>
              <span v-if="artOf(row) && artOf(row) !== nameOf(row)" class="pp__option-art">{{ artOf(row) }}</span>
              <span v-if="dynastyOf(row)" class="pp__option-dynasty">{{ dynastyOf(row) }}</span>
            </li>
          </template>
          <!-- 清空搜索：原姓氏分组（组头 ＋ 组内顺序），原行为一字不改。 -->
          <template v-else>
            <li
              v-for="group in groups"
              :key="group.initial"
              :ref="(element) => setSectionRef(group.initial, element)"
              class="pp__group"
              role="presentation"
              :data-person-group="group.initial"
            >
              <div class="pp__group-title" aria-hidden="true">{{ group.initial }}</div>
              <div
                v-for="row in group.rows"
                :id="`pp-opt-${uid}-${flatIndexById.get(idOf(row))}`"
                :key="idOf(row)"
                :ref="(element) => setOptionRef(idOf(row), element)"
                class="pp__option"
                :class="{ 'is-active': activeId === idOf(row), 'is-selected': String(modelValue || '') === idOf(row) }"
                role="option"
                :aria-selected="String(modelValue || '') === idOf(row) ? 'true' : 'false'"
                :data-person-option="idOf(row)"
                @click="pick(row)"
              >
                <span class="pp__option-name">{{ nameOf(row) }}</span>
                <span v-if="artOf(row) && artOf(row) !== nameOf(row)" class="pp__option-art">{{ artOf(row) }}</span>
                <span v-if="dynastyOf(row)" class="pp__option-dynasty">{{ dynastyOf(row) }}</span>
              </div>
            </li>
          </template>
        </ul>
        <p v-else class="pp__empty">{{ emptyText }}</p>

        <nav v-if="indexLetters.length" class="pp__index" aria-label="拼音索引">
          <button
            v-for="initial in indexLetters"
            :key="initial"
            class="pp__index-btn"
            type="button"
            :data-person-index="initial"
            :aria-label="`跳到 ${initial}`"
            @click="jumpTo(initial)"
          >
            {{ initial }}
          </button>
        </nav>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--s-2, 8px);
  font-size: var(--t-sm, 14px);
  color: var(--c-text, #23262b);
}

.pp__label {
  flex: none;
  color: var(--c-text-muted, #6b7280);
}

.pp__control {
  display: flex;
  align-items: center;
  gap: var(--s-2, 8px);
  min-width: 0;
  flex: 1;
}

.pp__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2, 8px);
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
  border-radius: var(--r-md, 8px);
  background: var(--c-surface, #fff);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pp__trigger:hover {
  border-color: var(--c-line-strong, rgba(0, 0, 0, 0.3));
}

.pp__trigger:focus-visible {
  outline: 2px solid var(--c-brand, #7a4f2c);
  outline-offset: 1px;
}

.pp__value,
.pp__placeholder {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pp__placeholder {
  color: var(--c-text-muted, #6b7280);
}

.pp__art,
.pp__option-art {
  color: var(--c-text-muted, #6b7280);
}

.pp__dynasty,
.pp__option-dynasty {
  color: var(--c-text-muted, #6b7280);
  font-size: var(--t-xs, 12px);
}

.pp__caret {
  flex: none;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 5px solid currentColor;
  opacity: 0.6;
}

.pp__clear {
  flex: none;
  padding: 6px 10px;
  border: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
  border-radius: var(--r-md, 8px);
  background: var(--c-surface, #fff);
  color: var(--c-text-muted, #6b7280);
  font: inherit;
  cursor: pointer;
}

.pp__clear:hover {
  color: var(--c-text, #23262b);
  border-color: var(--c-line-strong, rgba(0, 0, 0, 0.3));
}

.pp__mask {
  position: fixed;
  inset: 0;
  z-index: 20;
  background: var(--c-overlay, rgba(15, 18, 22, 0.4));
}

.pp__panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: 420px;
  overflow: hidden;
  border: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
  border-radius: var(--r-lg, 12px);
  background: var(--c-surface, #fff);
  box-shadow: var(--shadow-2, 0 12px 32px rgba(15, 18, 22, 0.18));
}

.pp__search-row {
  flex: none;
  padding: var(--s-2, 8px);
  border-bottom: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
}

.pp__search {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
  border-radius: var(--r-md, 8px);
  background: var(--c-surface-sunken, #f6f7f9);
  color: inherit;
  font: inherit;
}

.pp__search:focus {
  outline: none;
  border-color: var(--c-brand, #7a4f2c);
  background: var(--c-surface, #fff);
}

.pp__body {
  display: flex;
  min-height: 0;
  flex: 1;
}

.pp__list {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: var(--s-1, 4px) 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pp__group-title {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px var(--s-3, 12px);
  background: var(--c-surface-sunken, #f6f7f9);
  color: var(--c-text-muted, #6b7280);
  font-size: var(--t-xs, 12px);
  letter-spacing: 0.08em;
}

.pp__option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px var(--s-3, 12px);
  cursor: pointer;
}

.pp__option:hover {
  background: var(--c-surface-sunken, #f6f7f9);
}

.pp__option.is-active {
  background: var(--c-surface-sunken, #f6f7f9);
  box-shadow: inset 2px 0 0 var(--c-brand, #7a4f2c);
}

.pp__option.is-selected {
  /* 先给一条普通浏览器可吃的底色，再叠 `color-mix`（不支持时自动丢弃后者）。 */
  background: rgba(122, 79, 44, 0.1);
  background: color-mix(in srgb, var(--c-brand, #7a4f2c) 12%, transparent);
}

.pp__option-name {
  font-weight: 600;
}

.pp__empty {
  flex: 1;
  margin: 0;
  padding: var(--s-5, 20px) var(--s-3, 12px);
  color: var(--c-text-muted, #6b7280);
  text-align: center;
}

.pp__index {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  width: 26px;
  padding: var(--s-1, 4px) 0;
  border-left: 1px solid var(--c-line, rgba(0, 0, 0, 0.14));
  background: var(--c-surface, #fff);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pp__index-btn {
  min-width: 22px;
  min-height: 18px;
  padding: 1px 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--c-text-muted, #6b7280);
  font-size: 11px;
  line-height: 1.4;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
}

.pp__index-btn:hover {
  background: var(--c-surface-sunken, #f6f7f9);
  color: var(--c-text, #23262b);
}

/* 移动端（宽度 < 640px）：弹层铺满屏。 */
@media (max-width: 639px) {
  .pp__panel {
    position: fixed;
    inset: 0;
    width: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
  }

  .pp__index {
    width: 32px;
  }

  .pp__index-btn {
    min-width: 28px;
    min-height: 22px;
  }
}
</style>