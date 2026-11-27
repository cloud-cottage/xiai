<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import SliceImage from './SliceImage.vue'
import { formatBytes } from '../utils/format.js'
/* 翻页边界的**唯一实现**（首尾不循环）：模板只读 `canPrev` / `canNext`，不写算式。 */
import { neighborIndex } from '../utils/photoLightbox.js'
/* ESC ＝ 關閉：全倉單點 `utils/useEscToClose.js`（本組件隨 `v-if` 掛載 ⇒ 缺省恆為最上層）。 */
import { useEscToClose } from '../utils/useEscToClose.js'

/**
 * 實物照片**點擊放大**遮罩（全用戶可用；本單只做查看 —— 隱藏 / 刪除屬下一單）。
 *
 * · 图源仍是页面传进来的 `photoUrls`（`srcs`）—— **零新增取数、零新增服务调用**；
 *   大图用 `SliceImage` 在大尺寸**重渲染同一张**（切块铺贴，不改切分口径、不整图直出）。
 * · 受控：本组件不自持下标，只 `emit('update:index')`，由页面写回。
 * · 焦点：打开进遮罩（`tabindex="-1"` ＋ `focus()`），关闭把焦点还回触发的那张照片。
 */
const props = defineProps({
  /** 实物照片元数据行（与页面 `gallery` 同源）。 */
  photos: { type: Array, default: () => [] },
  /** 当前下标（受控）。 */
  index: { type: Number, default: 0 },
  /** `photoUrls` 同一映射（id ⇒ 已取回的 dataURL）。 */
  srcs: { type: Object, default: () => ({}) },
  /** 触发的那张照片元素（关窗后回焦；缺省回落 `document.activeElement`）。 */
  trigger: { type: Object, default: null }
})

const emit = defineEmits(['close', 'update:index'])

const rootRef = ref(null)
/** 关闭时要还回去的焦点元素（`document.activeElement` 记忆，由触发方的 `currentTarget` 传入）。 */
let restoreTarget = null
/** 挂载前的 `body` overflow（关窗原样还原 ⇒ 不覆盖别的弹窗留下的锁）。 */
let previousBodyOverflow = ''

const total = computed(() => props.photos.length)
/** 越界的下标一律夹回合法域（gallery 在遮罩打开期间变动也不至于渲染 undefined）。 */
const at = computed(() => {
  const n = props.photos.length
  if (n <= 0) return -1
  const raw = Number.isFinite(props.index) ? Math.trunc(props.index) : 0
  return Math.min(Math.max(raw, 0), n - 1)
})
const current = computed(() => (at.value >= 0 ? props.photos[at.value] : null))
/** 计数器分子（1 起）。 */
const position = computed(() => (at.value >= 0 ? at.value + 1 : 0))
/** 边界判定一律经纯函数（首尾不循环 ⇒ 首张禁「上一张」、末张禁「下一张」）。 */
const canPrev = computed(() => neighborIndex(at.value, props.photos.length, -1) !== -1)
const canNext = computed(() => neighborIndex(at.value, props.photos.length, 1) !== -1)
const ariaLabel = computed(() => (current.value ? `實拍圖 ${current.value.id} 放大檢視` : '實物照片放大檢視'))

function go(step) {
  const next = neighborIndex(at.value, props.photos.length, step)
  if (next !== -1) emit('update:index', next)
}

function close() {
  emit('close')
}

/* 点遮罩关闭：图与操作条之外的任意位置（X / 上一张 / 下一张 自带处理，不冒泡到此）。 */
function onRootClick(event) {
  const target = event && event.target
  if (!target || typeof target.closest !== 'function') return
  if (target.closest('button') || target.closest('.photo-lightbox__figure')) return
  close()
}

/* 左右方向键翻页（焦点在遮罩内任意位置都生效）。 */
function onRootKeydown(event) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    go(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    go(1)
  }
}

/* ESC ＝ 關閉（全倉單點）。 */
useEscToClose({ onCancel: close })

onMounted(async () => {
  restoreTarget = props.trigger || (typeof document !== 'undefined' ? document.activeElement : null)
  previousBodyOverflow = document.body.style.overflow
  /* 遮罩打开期间禁背景滚动（关窗原样还原 ⇒ 不丢当前滚动位置）。 */
  document.body.style.overflow = 'hidden'
  await nextTick()
  if (rootRef.value) rootRef.value.focus()
})

onBeforeUnmount(() => {
  document.body.style.overflow = previousBodyOverflow
  if (restoreTarget && typeof restoreTarget.focus === 'function' && document.contains(restoreTarget)) {
    restoreTarget.focus()
  }
})
</script>

<template>
  <div
    ref="rootRef"
    class="photo-lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="ariaLabel"
    tabindex="-1"
    data-photo-lightbox
    @click="onRootClick"
    @keydown="onRootKeydown"
  >
    <div class="photo-lightbox__bar">
      <div class="photo-lightbox__meta">
        <span class="photo-lightbox__title" data-photo-lightbox-title>實拍圖 {{ current ? current.id : '' }}</span>
        <span class="photo-lightbox__info" data-photo-lightbox-info>
          <template v-if="current && current.width && current.height">{{ current.width }} × {{ current.height }} · </template>
          <template v-if="current">{{ formatBytes(current.bytes) }}</template>
          <template v-if="current && current.mime"> · {{ current.mime }}</template>
        </span>
      </div>
      <span class="photo-lightbox__count" data-photo-lightbox-count>{{ position }} / {{ total }}</span>
      <button
        class="btn btn--ghost photo-lightbox__close"
        type="button"
        data-photo-lightbox-close
        aria-label="關閉大圖"
        @click="close"
      >×</button>
    </div>

    <div class="photo-lightbox__stage">
      <button
        class="btn btn--ghost photo-lightbox__nav"
        type="button"
        data-photo-lightbox-prev
        :disabled="!canPrev"
        aria-label="上一張實物照片"
        @click="go(-1)"
      >上一張</button>

      <div class="photo-lightbox__figure" data-photo-lightbox-figure>
        <!-- 大尺寸**重渲染同一张**：与缩略图同一 `srcs[id]` ＋ 同一 `row` ＋ 同一 `cut-hint`
             ⇒ 同一套切分口径，只换容器宽度（切块铺贴，不整图直出）。 -->
        <SliceImage
          v-if="current && srcs[current.id]"
          :src="srcs[current.id]"
          :row="current"
          cut-hint="photo"
          alt="印章實物照片"
          :caption="`實拍圖 ${current.id}`"
        />
        <p v-else class="photo-lightbox__hint" data-photo-lightbox-hint>
          {{ current ? '正在讀取照片…' : '暫無實物照片。' }}
        </p>
      </div>

      <button
        class="btn btn--ghost photo-lightbox__nav"
        type="button"
        data-photo-lightbox-next
        :disabled="!canNext"
        aria-label="下一張實物照片"
        @click="go(1)"
      >下一張</button>
    </div>
  </div>
</template>

<style scoped>
/* 大图遮罩：视觉与交互语言照既有 `.confirm-mask` / `.correction-mask` 范式 ——
   全屏 fixed 遮罩 ＋ 令牌色（**零新增色值**，颜色一律 `var(--…)`）。 */
.photo-lightbox {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--s-3);
  padding: var(--s-4);
  background: var(--c-overlay);
}

/* 容器本身是可编程聚焦目标（`tabindex="-1"`），不给它画整屏焦点环 —— 焦点语义交给内部按钮。 */
.photo-lightbox:focus,
.photo-lightbox:focus-visible {
  outline: none;
  box-shadow: none;
}

.photo-lightbox__bar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-2);
}

.photo-lightbox__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-1) var(--s-3);
  min-width: 0;
}

.photo-lightbox__title {
  color: var(--c-text);
  font-size: var(--t-md);
  font-weight: 600;
}

.photo-lightbox__info {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.photo-lightbox__count {
  margin-left: auto;
  color: var(--c-text);
  font-size: var(--t-sm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.photo-lightbox__close {
  flex: none;
  min-width: 34px;
  padding: 0 var(--s-2);
}

.photo-lightbox__stage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  min-height: 0;
  overflow: auto;
  padding: var(--s-2) 0;
}

.photo-lightbox__figure {
  flex: 0 1 auto;
  width: min(92vw, 900px);
  max-width: 100%;
  padding: var(--s-3);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.photo-lightbox__nav {
  flex: none;
}

.photo-lightbox__hint {
  margin: 0;
  padding: var(--s-5) 0;
  text-align: center;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}
</style>
