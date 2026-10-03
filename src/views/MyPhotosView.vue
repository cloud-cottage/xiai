
<script setup>
/**
 * 我的实物照片
 * ----------------------------------------------------------------------------
 * 本页承担实物照片的**上传闭环**（选图 → 预览 + 可拖拽/缩放的方形框 → 上传）
 * 与**画廊渲染**（二进制从数据层取回，页面不碰任何浏览器存储）。
 *
 * 处理全部在浏览器端完成（解码 → 降采样 → 方形化 → WebP 编码），
 * **不调用任何后端 / 斐萃端点**；二进制进 IndexedDB，`localStorage` 只存元数据。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import SliceImage from '../components/SliceImage.vue'
import { photos as photoService, seals, corrections } from '../services/index.js'
import { formatBytes, formatDateTime } from '../utils/format.js'
import {
  IMAGE_LIMITS,
  MIN_CROP_SIDE,
  canvasToken,
  centerSquareCrop,
  canEncodeWebp,
  describeBytes,
  exportSquareImage,
  loadImageFile,
  normalizeCrop
} from '../utils/image.js'

/* ------------------------------- 画廊 ------------------------------- */

const version = ref(0)
const rows = computed(() => {
  version.value // 触碰一次：上传 / 删除后强制重算
  return photoService.listMyPhotos()
})

/** 渲染用 dataURL：一律按 id 从数据层取回（二进制在 IndexedDB）。 */
const rendered = reactive({})
const renderErrors = reactive({})

async function renderRow(row) {
  if (rendered[row.id] || renderErrors[row.id]) return
  const out = await photoService.loadPhotoDataUrl(row.id)
  if (out.ok) rendered[row.id] = out.dataUrl
  else renderErrors[row.id] = out.message || '照片讀取失敗'
}

async function renderAll() {
  /* 老库就地纠正：旧格式（整张 dataURL 直存 localStorage）的历史行先迁进影像库，
     否则 AC-33 的历史行仍会在全量枚举里判负、且这些行没有二进制可渲染。 */
  await photoService.ensurePhotoStorageMigrated()
  for (const row of rows.value) await renderRow(row)
}

onMounted(renderAll)
watch(version, renderAll)

function sealOf(stampId) {
  return seals.getSealById(stampId)
}

/* ------------------------------- 选图与预览 ------------------------------- */

const PREVIEW_SIZE = 360 // 预览画布边长（CSS 像素）
const canvasRef = ref(null)
const fileInputRef = ref(null)

const canUpload = computed(() => seals.canUploadPhoto())
const sealOptions = computed(() => seals.listSeals())

const stampId = ref('')
const note = ref('')
const status = ref('')
const statusKind = ref('') // '' | 'ok' | 'error'
const busy = ref(false)
const stepText = ref('')
const webpOk = ref(true)

const source = ref(null) // {bitmap, width, height, originalBytes, originalMime, fileName}
const crop = ref(null) // {cx, cy, side}（**原图像素坐标**）

const limitText = `≤ ${describeBytes(IMAGE_LIMITS.maxInputBytes)}（${IMAGE_LIMITS.maxInputBytes} 字節）`
const sideLimit = computed(() => (source.value ? Math.min(source.value.width, source.value.height) : 0))
const outSizeText = computed(() => {
  if (!source.value || !crop.value) return '—'
  const side = Math.min(crop.value.side, IMAGE_LIMITS.maxSide)
  return `${side} × ${side} px`
})

function setStatus(message, kind = '') {
  status.value = message
  statusKind.value = kind
}

onMounted(async () => {
  webpOk.value = await canEncodeWebp()
  if (sealOptions.value.length > 0) stampId.value = sealOptions.value[0].stamp_id
})

/* ------------------------------- 画布绘制 ------------------------------- */

const fit = computed(() => {
  if (!source.value) return { scale: 1, dx: 0, dy: 0 }
  const scale = Math.min(PREVIEW_SIZE / source.value.width, PREVIEW_SIZE / source.value.height)
  return {
    scale,
    dx: (PREVIEW_SIZE - source.value.width * scale) / 2,
    dy: (PREVIEW_SIZE - source.value.height * scale) / 2
  }
})

function imageToView(point) {
  const { scale, dx, dy } = fit.value
  return { x: dx + point.x * scale, y: dy + point.y * scale }
}

function viewToImage(clientX, clientY) {
  const canvas = canvasRef.value
  if (!canvas || !source.value) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  const x = ((clientX - rect.left) / rect.width) * PREVIEW_SIZE
  const y = ((clientY - rect.top) / rect.height) * PREVIEW_SIZE
  const { scale, dx, dy } = fit.value
  return { x: (x - dx) / scale, y: (y - dy) / scale }
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  if (canvas.width !== Math.round(PREVIEW_SIZE * dpr)) {
    canvas.width = Math.round(PREVIEW_SIZE * dpr)
    canvas.height = Math.round(PREVIEW_SIZE * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
  /* 遮罩 / 框线 / 网格 / 把手色一律来自 `tokens.css` 的 `--canvas-*`（AC-26：组件内零字面色值）。
     读不到令牌时 `canvasToken()` 返回空串并告警一次（赋值被 canvas 忽略），**不做静默填色**。 */
  ctx.fillStyle = canvasToken('--canvas-shade')
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
  if (!source.value || !crop.value) {
    ctx.restore()
    return
  }
  /* 原图铺底（按适配比例）。 */
  const topLeft = imageToView({ x: 0, y: 0 })
  ctx.drawImage(
    source.value.bitmap,
    topLeft.x,
    topLeft.y,
    source.value.width * fit.value.scale,
    source.value.height * fit.value.scale
  )
  /* 方形框外的部分压暗。 */
  const a = imageToView({ x: crop.value.cx, y: crop.value.cy })
  const side = crop.value.side * fit.value.scale
  ctx.fillStyle = canvasToken('--canvas-mask')
  ctx.fillRect(topLeft.x, topLeft.y, source.value.width * fit.value.scale, a.y - topLeft.y)
  ctx.fillRect(topLeft.x, a.y + side, source.value.width * fit.value.scale, topLeft.y + source.value.height * fit.value.scale - (a.y + side))
  ctx.fillRect(topLeft.x, a.y, a.x - topLeft.x, side)
  ctx.fillRect(a.x + side, a.y, topLeft.x + source.value.width * fit.value.scale - (a.x + side), side)
  /* 框线与四角把手（三等分网格便于对位）。 */
  ctx.strokeStyle = canvasToken('--canvas-frame-line')
  ctx.lineWidth = 1.5
  ctx.strokeRect(a.x, a.y, side, side)
  ctx.strokeStyle = canvasToken('--canvas-grid')
  ctx.lineWidth = 1
  for (let i = 1; i <= 2; i += 1) {
    const offset = (side / 3) * i
    ctx.beginPath()
    ctx.moveTo(a.x + offset, a.y)
    ctx.lineTo(a.x + offset, a.y + side)
    ctx.moveTo(a.x, a.y + offset)
    ctx.lineTo(a.x + side, a.y + offset)
    ctx.stroke()
  }
  ctx.fillStyle = canvasToken('--canvas-handle-fill')
  const handle = 8
  ;[
    [a.x, a.y],
    [a.x + side, a.y],
    [a.x, a.y + side],
    [a.x + side, a.y + side]
  ].forEach(([hx, hy]) => {
    ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle)
  })
  ctx.restore()
}

watch([source, crop], draw, { deep: true, flush: 'post' })

/* ------------------------------- 拖拽 / 缩放 ------------------------------- */

const drag = ref(null)

function handleOf(imageX, imageY) {
  if (!crop.value) return ''
  const tol = 14 / Math.max(fit.value.scale, 0.0001)
  const { cx, cy, side } = crop.value
  const nearX = (value) => Math.abs(imageX - value) <= tol
  const nearY = (value) => Math.abs(imageY - value) <= tol
  if (nearX(cx) && nearY(cy)) return 'nw'
  if (nearX(cx + side) && nearY(cy)) return 'ne'
  if (nearX(cx) && nearY(cy + side)) return 'sw'
  if (nearX(cx + side) && nearY(cy + side)) return 'se'
  return ''
}

function insideCrop(imageX, imageY) {
  if (!crop.value) return false
  const { cx, cy, side } = crop.value
  return imageX >= cx && imageX <= cx + side && imageY >= cy && imageY <= cy + side
}

function applyResize(corner, point) {
  const { width, height } = source.value
  const start = drag.value.startCrop
  const anchor = {
    nw: { x: start.cx + start.side, y: start.cy + start.side },
    ne: { x: start.cx, y: start.cy + start.side },
    sw: { x: start.cx + start.side, y: start.cy },
    se: { x: start.cx, y: start.cy }
  }[corner]
  let side = Math.max(Math.abs(point.x - anchor.x), Math.abs(point.y - anchor.y))
  const cx = point.x < anchor.x ? anchor.x - side : anchor.x
  const cy = point.y < anchor.y ? anchor.y - side : anchor.y
  side = Math.max(MIN_CROP_SIDE, side)
  crop.value = normalizeCrop({ cx, cy, side }, width, height)
}

function onPointerDown(event) {
  if (!source.value || !crop.value) return
  const point = viewToImage(event.clientX, event.clientY)
  const corner = handleOf(point.x, point.y)
  const moving = !corner && insideCrop(point.x, point.y)
  if (!corner && !moving) return
  drag.value = { mode: corner ? 'resize' : 'move', corner, start: point, startCrop: { ...crop.value } }
  try {
    if (event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId)
  } catch {
    /* 合成事件 / 无活动指针时可能抛：拖拽本身不依赖指针捕获。 */
  }
}

function onPointerMove(event) {
  if (!drag.value) return
  event.preventDefault()
  const point = viewToImage(event.clientX, event.clientY)
  const { width, height } = source.value
  if (drag.value.mode === 'move') {
    const start = drag.value.startCrop
    crop.value = normalizeCrop(
      {
        cx: start.cx + (point.x - drag.value.start.x),
        cy: start.cy + (point.y - drag.value.start.y),
        side: start.side
      },
      width,
      height
    )
    return
  }
  applyResize(drag.value.corner, point)
}

function onPointerUp() {
  drag.value = null
}

function onWheel(event) {
  if (!source.value || !crop.value) return
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
  setSide(crop.value.side * factor)
}

function setSide(nextSide) {
  if (!source.value || !crop.value) return
  const { width, height } = source.value
  const side = Math.round(nextSide)
  const cx = crop.value.cx + (crop.value.side - side) / 2
  const cy = crop.value.cy + (crop.value.side - side) / 2
  crop.value = normalizeCrop({ cx, cy, side }, width, height)
}

function onSideSlider(event) {
  setSide(Number(event.target.value))
}

function resetCrop() {
  if (!source.value) return
  crop.value = centerSquareCrop(source.value.width, source.value.height)
}

function clearSelection() {
  source.value = null
  crop.value = null
  if (fileInputRef.value) fileInputRef.value.value = ''
}

/* ------------------------------- 选图 → 处理 → 上传 ------------------------------- */

async function onPickFile(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  setStatus('正在解碼並準備預覽…')
  busy.value = true
  const loaded = await loadImageFile(file)
  busy.value = false
  const denied = photoService.inputDenialOf(loaded)
  if (denied) {
    clearSelection()
    /* 输入侧 reason 由**服务层结构化透传**（输入超限 ⇒ `TOO_LARGE`，§3.12.10(c)），文案同源。 */
    setStatus(denied.message, 'error')
    if (fileInputRef.value) fileInputRef.value.value = ''
    return
  }
  source.value = {
    bitmap: loaded.bitmap,
    width: loaded.width,
    height: loaded.height,
    originalBytes: loaded.originalBytes,
    originalMime: loaded.originalMime,
    fileName: file.name
  }
  crop.value = centerSquareCrop(loaded.width, loaded.height)
  setStatus(
    `已就緒：${loaded.width} × ${loaded.height} px / ${describeBytes(loaded.originalBytes)}（${loaded.originalMime}）。` +
      '拖動方框調整位置，拖四角或滾輪縮放，然後點「上傳實物照片」。'
  )
  await nextTick()
  draw()
}

async function onUpload() {
  if (!canUpload.value) {
    setStatus('請先登錄後再上傳實物照片', 'error')
    return
  }
  if (!stampId.value) {
    setStatus('請先選擇這枚照片歸屬的印章', 'error')
    return
  }
  if (!source.value || !crop.value) {
    setStatus('請先選擇要上傳的圖片', 'error')
    return
  }
  busy.value = true
  stepText.value = '正在裁切並編碼…'
  const exported = await exportSquareImage(source.value.bitmap, {
    crop: { ...crop.value },
    maxSide: IMAGE_LIMITS.maxSide,
    quality: IMAGE_LIMITS.quality
  })
  if (!exported.ok) {
    busy.value = false
    stepText.value = ''
    setStatus(`處理失敗：${exported.message}`, 'error')
    return
  }
  stepText.value = '正在寫入本地影像庫…'
  const result = await photoService.uploadPhoto({
    stampId: stampId.value,
    bytes: exported.bytes,
    mime: exported.mime,
    width: exported.width,
    height: exported.height,
    note: note.value,
    fileName: source.value.fileName
  })
  busy.value = false
  stepText.value = ''
  if (!result.ok) {
    setStatus(`上傳失敗：${result.message}`, 'error')
    return
  }
  const before = describeBytes(source.value.originalBytes)
  const after = describeBytes(exported.bytes.length)
  clearSelection()
  note.value = ''
  version.value += 1
  setStatus(
    `${result.message}：${before} → ${after}（${exported.width} × ${exported.height}，${exported.mime}），已在下方畫廊中。`,
    'ok'
  )
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>我的實物照片</h1>
      <p>你爲印章上傳的實物照片都在這裏，點擊可回到對應印章。</p>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>上傳實物照片</h2>
        <span class="photos__hint">單張上限 {{ limitText }}，處理全部在瀏覽器端完成（裁方形 → WebP）</span>
      </div>
      <div class="panel__body">
        <div class="field">
          <label for="photo-stamp">歸屬印章</label>
          <select id="photo-stamp" v-model="stampId" :disabled="busy">
            <option v-for="item in sealOptions" :key="item.stamp_id" :value="item.stamp_id">
              {{ corrections.resolveSealDisplayName(item) }}（{{ item.stamp_id }}）
            </option>
          </select>
          <p v-if="!sealOptions.length" class="field__hint">暫無印章可選，請先在璽印匯類上傳印章。</p>
        </div>

        <div class="field">
          <label for="photo-file">選擇圖片（JPG / PNG / WebP，≤ 1 MB）</label>
          <input
            id="photo-file"
            ref="fileInputRef"
            type="file"
            accept="image/*"
            :disabled="busy"
            data-testid="photo-file"
            @change="onPickFile"
          />
          <p class="field__hint">
            上限按原始文件字節數判定：{{ limitText }}。超出會被拒，並提示真實大小。
          </p>
        </div>

        <div v-if="source" class="photos__edit">
          <div class="photos__preview">
            <canvas
              ref="canvasRef"
              class="photos__canvas"
              :style="{ width: PREVIEW_SIZE + 'px', height: PREVIEW_SIZE + 'px' }"
              data-testid="crop-canvas"
              :data-crop="crop ? `${crop.cx},${crop.cy},${crop.side}` : ''"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerUp"
              @pointerleave="onPointerUp"
              @wheel="onWheel"
            />
            <p class="field__hint">拖動方框移動；拖四角或滾輪縮放；也可用下方滑塊。</p>
          </div>
          <div class="photos__controls">
            <p class="photos__meta">
              原始尺寸 {{ source.width }} × {{ source.height }} px · {{ describeBytes(source.originalBytes) }} ·
              {{ source.originalMime }}
            </p>
            <label class="photos__slider">
              方形邊長
              <input
                type="range"
                :min="Math.min(MIN_CROP_SIDE, sideLimit)"
                :max="sideLimit"
                :value="crop ? crop.side : sideLimit"
                :disabled="busy"
                data-testid="crop-side"
                @input="onSideSlider"
              />
              <b>{{ crop ? crop.side : 0 }} px</b>
            </label>
            <p class="photos__meta">產出：{{ outSizeText }} · 目標格式 image/webp（編不出時如實記錄實際格式）</p>
            <p v-if="!webpOk" class="photos__warn">
              當前瀏覽器未確認支持 WebP 編碼：將按實際產出格式如實入庫（不冒充 webp）。
            </p>
            <div class="field">
              <label for="photo-note">備註（可選）</label>
              <input id="photo-note" v-model="note" type="text" :disabled="busy" maxlength="120" />
            </div>
            <div class="photos__actions">
              <button class="btn btn--primary" type="button" :disabled="busy" data-testid="photo-upload" @click="onUpload">
                {{ busy ? stepText || '處理中…' : '上傳實物照片' }}
              </button>
              <button class="btn btn--ghost" type="button" :disabled="busy" @click="resetCrop">取中心最大正方形</button>
              <button class="btn btn--ghost" type="button" :disabled="busy" @click="clearSelection">取消</button>
            </div>
          </div>
        </div>

        <p v-if="status" class="notice" :class="{ 'notice--error': statusKind === 'error' }" data-testid="photo-status">
          {{ status }}
        </p>
      </div>
    </section>

    <section v-if="rows.length" class="panel">
      <div class="panel__head">
        <h2>已上傳（{{ rows.length }} 張）</h2>
        <span class="photos__hint">二進制在本機影像庫（IndexedDB），此處按 id 取回渲染</span>
      </div>
      <div class="panel__body">
        <div class="photo-grid">
          <router-link
            v-for="row in rows"
            :key="row.id"
            class="photo-card"
            :to="{ name: 'seal-detail', params: { id: row.stamp_id } }"
          >
            <!-- 我的照片列表：**统一走 `SliceImage`**（与详情页同一展示路径），
                 按行上切分元数据（实拍族 **8 塊**）現場切分 → 拼接；
                 实拍图按原色呈现（R-135：上色面整体退场）。 -->
            <SliceImage
              v-if="rendered[row.id]"
              class="photo-card__slice"
              :src="rendered[row.id]"
              :row="row"
              cut-hint="photo"
              alt="印章實物照片"
              data-photo-slice
            />
            <p v-else class="photo-card__pending">{{ renderErrors[row.id] || '正在讀取照片…' }}</p>
            <div class="photo-card__body">
              <p class="photo-card__name">
                {{ sealOf(row.stamp_id) ? corrections.resolveSealDisplayName(sealOf(row.stamp_id)) : row.stamp_id }}
              </p>
              <p class="photo-card__meta">{{ row.stamp_id }}</p>
              <p class="photo-card__meta">
                {{ formatBytes(row.bytes) }} · {{ row.mime }} · {{ row.width }} × {{ row.height }} ·
                {{ formatDateTime(row.created_at) }}
              </p>
            </div>
          </router-link>
        </div>
      </div>
    </section>

    <PlaceholderPanel
      v-else
      glyph="影"
      title="還沒有上傳實物照片"
      desc="在上方選擇印章與圖片上傳，或進入任一印章詳情頁的實物照片區上傳。"
    >
      <router-link class="btn btn--ghost" :to="{ name: 'square' }">去璽印匯類看看</router-link>
    </PlaceholderPanel>
  </section>
</template>

<style scoped>
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--s-4);
}

.photo-card {
  display: block;
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.photo-card:hover {
  box-shadow: var(--shadow-2);
}

/* 切片缩略图铺满卡片（块几何由 `SliceImage` 按元数据绘制）。 */
.photo-card__slice {
  display: block;
  width: 100%;
}

.photo-card__pending {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  padding: var(--s-3);
  text-align: center;
  background: var(--c-surface-sunken);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.photo-card__body {
  padding: var(--s-3);
}

.photo-card__name {
  color: var(--c-text);
  font-family: var(--font-serif);
  font-size: var(--t-lg);
}

.photo-card__meta {
  margin-top: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.photos__hint {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.photos__edit {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-4);
  margin-top: var(--s-4);
}

.photos__canvas {
  display: block;
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  background: var(--c-surface-sunken);
  touch-action: none;
  cursor: move;
}

.photos__controls {
  flex: 1 1 260px;
  min-width: 240px;
}

.photos__meta {
  margin-bottom: var(--s-2);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.photos__warn {
  margin-bottom: var(--s-2);
  color: var(--c-text);
  font-size: var(--t-xs);
}

.photos__slider {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
  font-size: var(--t-xs);
  color: var(--c-text-muted);
}

.photos__slider input {
  flex: 1 1 auto;
}

.photos__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
  margin-top: var(--s-3);
}

.notice--error {
  border-color: var(--c-danger);
  color: var(--c-danger);
}
</style>
