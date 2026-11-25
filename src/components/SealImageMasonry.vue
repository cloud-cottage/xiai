<script setup>
/**
 * 玺爱 · **影像瀑布流**（【單獨列出影像】｜裁定件 ③）
 * ============================================================================
 * 【為什麼是瀑布流而不是等高网格】影像長寬比不一致：等高网格要么裁图、要么留白，
 *   且每次换页都会把行高重新算一遍（跳动）。這裡用**多列折行**（`column-count`），
 *   列內項目 `break-inside: avoid` —— 一行一張、隨內容高度排，容器寬度決定列數（2〜5 列）。
 *   等高网格**明令禁止**（裁定件 ③）。
 * 【防跳动】每項按行上的 `width` / `height` 预留 `aspect-ratio`（缺值 ⇒ `4 / 3` 兜底，
 *   **不猜真实尺寸**）⇒ 圖未到先占位，瀑布流高度不因圖片載入而重排。
 * 【四級回落】封面取件复用服务层同一条链：`thumb_key` → `display_key` → 原始件
 *   （`originalDisplayKeyOf`）→ 本地占位图（`coverPlaceholderUrl`）—— 台阶判据一律取
 *   `sealCards.coverEscalationOf`（純函數，与 `SealCard` 同一份，不另立第二套顺序）。
 *   占位图也壞 ⇒ 该项落**空态**（字形 + 说明），**不再重试**（不无限重试、不循环出网）。
 * 【点击】每項是 `router-link` ⇒ 進该印章详情页；行上 `face_id` **非空**才带 `?face=<id>`
 *   （整枚章圖 / 无面归属 ⇒ 不带），由详情页自己做形態門与锚点滚动。
 * 【取証鉤子】容器 `data-image-masonry`；每項 `data-image-id`；縮略件來源面別 `data-thumb-face`。
 * ============================================================================
 */
import { reactive, watch } from 'vue'
import { sealCards } from '../services/index.js'

const props = defineProps({
  /** 影像行（服务层 `listSealImagePage` 归一后的 13 键行；已按 `image_id` 去重）。 */
  rows: { type: Array, default: () => [] }
})

/** 缩略件来源面别（与 `SealCard` 同名读数）：object / fallback / original / placeholder。 */
const COVER_VIA_FACE = Object.freeze({ thumb: 'object', display: 'fallback', original: 'original' })

/* 逐影像的封面状态（键 ＝ `image_id`；**会话级缓存**，与服务层 `urlCache` 同寿命）。
   `started` 防同一行并发取两次；`error` 非空 ＝ 终态空态（不再重试）。 */
const covers = reactive({})

const EMPTY_STATE = Object.freeze({ url: '', via: '', stage: 0, busy: false, error: '', started: false })

/** 模板读数：**只读不写**（状态由 watch 预建，避免渲染期改响应式对象触发重渲染）。 */
function stateOf(row) {
  const id = row && row.image_id ? String(row.image_id) : ''
  return (id && covers[id]) || EMPTY_STATE
}

function applyCover(state, cover) {
  state.url = cover.url
  state.via = COVER_VIA_FACE[cover.via] || 'fallback'
  state.stage = cover.via === 'thumb' ? 0 : cover.via === 'original' ? 2 : 1
  state.busy = false
  state.error = ''
}

/** 第四级：本地占位图（base 感知资产 URL）；资产缺损 ⇒ 退回空态（不造假 URL）。
    `stage` 落到 3（占位级）—— 下一次 `<img @error>` 由此判 `glyph` 终态，**不再重试**。 */
function toPlaceholder(state, message) {
  const url = sealCards.coverPlaceholderUrl()
  state.busy = false
  state.stage = 3
  state.via = url ? 'placeholder' : ''
  state.url = url
  state.error = url ? '' : (message || '影像暫時無法顯示')
}

/** 终态空态（**不再重试**：占位图本身也取不到时的唯一出口）。 */
function toGlyphError(state, message) {
  state.busy = false
  state.stage = 3
  state.url = ''
  state.via = ''
  state.error = message || '影像暫時無法顯示'
}

async function loadCover(row) {
  const id = row.image_id
  const state = covers[id]
  if (!state || state.url || state.error) return
  state.busy = true
  /* 取链（服务层内部已按 thumb → display → original 逐级走；失败 ⇒ 该行没有可用对象链接）。 */
  const cover = await sealCards.cardCoverUrl(row)
  if (covers[id] !== state) return /* 行已被替换（换页 / 清单）⇒ 丢掉过期结果。 */
  if (cover.ok) {
    applyCover(state, cover)
    return
  }
  /* 四级回落的第四级：本地占位图；资产也缺 ⇒ 空态（不无限重试）。 */
  toPlaceholder(state, cover.message || '影像暫時無法顯示')
}

function ensureCover(row) {
  if (!row || typeof row !== 'object' || !row.image_id) return
  const id = String(row.image_id)
  if (covers[id]) return /* 已开始（含终态）⇒ 不重复取。 */
  covers[id] = { url: '', via: '', stage: 0, busy: true, error: '', started: true }
  void loadCover(row)
}

/**
 * `<img @error>` 的**运行时回落**：每坏一次只降一级（判据全在 `coverEscalationOf`）——
 * thumb → display → original → 本地占位图 → 空态（**不再重试**，避免循环出网）。
 */
async function onImageError(row) {
  /* 状态由 watch 预建；这里**只读已有状态**（缺失 ⇒ 直接补建，绝不就地改模板读数）。 */
  if (!row || typeof row !== 'object' || !row.image_id) return
  const id = String(row.image_id)
  if (!covers[id]) ensureCover(row)
  const state = covers[id]
  if (!state) return
  let stage = state.stage
  for (let guard = 0; guard < 4; guard += 1) {
    const next = sealCards.coverEscalationOf(stage, row)
    if (next.step === 'placeholder') {
      toPlaceholder(state, '影像暫時無法顯示')
      return
    }
    if (next.step === 'glyph') {
      toGlyphError(state, '影像暫時無法顯示')
      return
    }
    const cover = await sealCards.cardCoverUrl(row, { via: next.via })
    if (covers[id] !== state) return
    if (cover.ok) {
      applyCover(state, cover)
      return
    }
    /* 这一级取链失败 ⇒ 落到该级台阶，循环接着降下一级。 */
    stage = next.stage
  }
  toPlaceholder(state, '影像暫時無法顯示')
}

/* 预建状态并取首张（`rows` 由视图以**新数组**替换（concat）⇒ 引用变化即触发）。 */
watch(
  () => props.rows,
  (rows) => {
    const list = Array.isArray(rows) ? rows : []
    list.forEach(ensureCover)
  },
  { immediate: true }
)

/** 预留比例（缺宽 / 高 ⇒ `4 / 3` 兜底；**不猜真实尺寸**）。 */
function frameStyle(row) {
  const width = Number(row && row.width)
  const height = Number(row && row.height)
  const ratio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width} / ${height}`
    : '4 / 3'
  return { aspectRatio: ratio }
}

function altOf(row) {
  const name = String(row.seal_name || '').trim() || '佚名'
  const dynasty = String(row.dynasty || '').trim()
  return dynasty ? `${name}（${dynasty}）影像` : `${name}影像`
}

function glyphOf(row) {
  const name = String(row.seal_name || '').trim()
  return name ? name.slice(0, 1) : '印'
}

/** 详情页路由：`face_id` 非空才带 `?face=`（整枚章图不带）；值的形態門由详情页把。 */
function detailTo(row) {
  const faceId = String(row.face_id || '').trim()
  return faceId
    ? { name: 'seal-detail', params: { id: row.stamp_id }, query: { face: faceId } }
    : { name: 'seal-detail', params: { id: row.stamp_id } }
}
</script>

<template>
  <div class="seal-images" data-image-masonry>
    <!-- 多列瀑布流：列数随**容器**宽度 2〜5 列（容器查询优先；不支持的浏览器退到媒体查询）。
         列内项目 `break-inside: avoid` ⇒ 一項一列内不拆行。**禁止等高网格**（裁定件 ③）。 -->
    <div class="seal-images__cols">
      <div
        v-for="row in rows"
        :key="row.image_id"
        class="seal-images__item"
        :data-image-id="row.image_id"
      >
        <router-link class="seal-images__link" :to="detailTo(row)">
          <!-- 按 width / height 预留 aspect-ratio ⇒ 图未到先占位，不因載入重排。 -->
          <div class="seal-images__frame" :style="frameStyle(row)">
            <img
              v-if="stateOf(row).url"
              class="seal-images__img"
              :src="stateOf(row).url"
              :alt="altOf(row)"
              :data-thumb-face="stateOf(row).via || null"
              loading="lazy"
              @error="onImageError(row)"
            />
            <template v-else>
              <span class="seal-images__glyph">{{ glyphOf(row) }}</span>
              <span class="seal-images__cap">
                {{ stateOf(row).error || (stateOf(row).busy ? '影像載入中' : '影像') }}
              </span>
            </template>
          </div>
          <div class="seal-images__meta">
            <span class="seal-images__name">{{ row.seal_name || '佚名' }}</span>
            <span v-if="row.dynasty" class="seal-images__era">{{ row.dynasty }}</span>
          </div>
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 容器查询的锚点（列数按**容器**宽度定；`inline-size` 约束不影响内部折行）。 */
.seal-images {
  container-type: inline-size;
  margin-top: var(--s-4);
}

.seal-images__cols {
  /* 兜底（不支持容器查询的环境）：2 列起步。 */
  column-count: 2;
  column-gap: var(--s-4);
}

/* 媒体查询（仅作旧浏览器回落；声明在容器查询**之前** ⇒ 支持容器查询时由后者接管）。 */
@media (min-width: 768px) {
  .seal-images__cols { column-count: 3; }
}
@media (min-width: 1180px) {
  .seal-images__cols { column-count: 4; }
}
@media (min-width: 1560px) {
  .seal-images__cols { column-count: 5; }
}

/* 容器宽度 ⇒ 列数（2〜5 列；同一元素等宽 ⇒ 不会跨列撕开）。 */
@container (min-width: 420px) {
  .seal-images__cols { column-count: 3; }
}
@container (min-width: 660px) {
  .seal-images__cols { column-count: 4; }
}
@container (min-width: 940px) {
  .seal-images__cols { column-count: 5; }
}

/* 瀑布流項：**列内不拆行**（防项目被截成两半）。 */
.seal-images__item {
  display: inline-block;
  width: 100%;
  margin-bottom: var(--s-4);
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  page-break-inside: avoid;
}

.seal-images__link {
  display: block;
  color: inherit;
  text-decoration: none;
}

.seal-images__frame {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--slot-card-seal-bg);
  border: 1px solid var(--slot-card-line);
  border-radius: var(--r-md);
}

.seal-images__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.seal-images__glyph {
  font-family: var(--font-seal);
  font-size: 44px;
  line-height: 1;
  color: var(--slot-card-seal-text);
  border: 3px solid var(--slot-card-seal-stroke);
  border-radius: var(--r-sm);
  padding: var(--s-3) var(--s-4);
}

.seal-images__cap {
  position: absolute;
  bottom: var(--s-2);
  right: var(--s-3);
  max-width: calc(100% - var(--s-4));
  color: var(--slot-card-meta-text);
  font-size: var(--t-xs);
}

.seal-images__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
  margin-top: var(--s-2);
  font-size: var(--t-sm);
}

.seal-images__name {
  overflow: hidden;
  color: var(--slot-card-title-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seal-images__era {
  flex: 0 0 auto;
  padding: 1px var(--s-2);
  border: 1px solid var(--slot-chip-line);
  border-radius: var(--r-sm);
  color: var(--slot-chip-text);
  font-size: var(--t-xs);
}
</style>
