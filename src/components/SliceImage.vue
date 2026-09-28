<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { sliceMetaOf, seamReport } from './sliceMeta.js'
import { seals, photos as photoService, imageFaces } from '../services/index.js'

const props = defineProps({
  /** 源图展示地址（**存量 / 非 TIFF 容器**的本机展示路径用；TIFF 走块面时不需要它）。 */
  src: { type: String, default: '' },
  row: { type: Object, default: null },
  /** 无障碍替代文本（R-123④：默认值**中性化** —— 曾为「切分拼接影像」，泄漏展示机制）。 */
  alt: { type: String, default: '影像' },
  /**
   * 图注（可读繁体）。**入参保留声明**（父组件仍在绑定；删声明会让该绑定落到根节点成 HTML 属性），
   * 但 **R-123① 起不再上屏** —— 原文本「由 N 塊按元數據切分後拼接（切向 …；切分元數據來源：…）」
   * 泄漏切分机制（R-116②：用户无感切分）。
   */
  caption: { type: String, default: '' },
  /** 切片类别提示（`photo` ＝ 实拍族；行上无资产类别元数据时按它取真源刀数）。 */
  cutHint: { type: String, default: '' }
})

const rootRef = ref(null)
const loading = ref(false)
const error = ref('')
/**
 * **结构化拒绝的机械读数**（R-123③）：`sliceMetaOf` 给的是 `reason`（`TRUTH_UNAVAILABLE` /
 * `META_MISSING` / `META_INVALID` / `SIZE_UNKNOWN`）。这类**技术细节（含内部字段名与机制）
 * 不上屏、不进 console**（AGENTS.md 禁 `console.log`）—— 只留在本注释与该读数里，
 * 供取证 / 自证读取；上屏一律中性文案，但**必须仍是可读错误**（有文案，绝不静默）。
 */
const errorReason = ref('')
const notice = ref('')
/** 上色 / 拼接产物（webp）。 */
const outputUrl = ref('')
const outputMime = ref('')
const meta = ref(null)
const seam = ref(null)
/** 展示层几何（display px；由同一份边界数组派生 ⇒ 相邻块坐标相接）。 */
const geometry = ref({ width: 0, height: 0, tiles: [], xBounds: [], yBounds: [] })

/* ============================================================================
   塊面（TIFF 存儲件）：`POST /api/image/slices` ⇒ 逐塊字節 ＋ 響應內清單
   ----------------------------------------------------------------------------
   - **幾何只消費響應**：塊數 / 逐塊矩形 / 落位一律讀自響應（`X-Block-Rect` /
     `X-Block-Placement` / 清單），**本組件不派生任何切位**（幾何真源仍恰 1 處 ＝
     `src/tilesplicer/**`，本處連調用都不需要 —— 服務端已用同一份內核算好）。
   - **拼接仍在展示端**：每塊自己的字節按各自落位擺放（不再以「整圖 ＋ 負偏移」冒充逐塊）。
   - **存量 / 非 TIFF 存儲件仍走本機既有路徑**（瀏覽器原生解碼 ＋ 行上元數據），**不經 api**。
   ============================================================================ */
/** 塊面讀數（響應原樣；`null` ⇒ 本機路徑）。 */
const blockSet = ref(null)
/** 逐塊的對象地址（與 `blockSet.blocks` 同序；離場 / 重渲染時一律回收）。 */
const blockUrls = ref([])
/** 本次展示的來源面別（機械讀數）：`api` ＝ 塊面；`local` ＝ 本機既有路徑。 */
const via = ref('')

function reset() {
  loading.value = false
  error.value = ''
  errorReason.value = ''
  notice.value = ''
  outputUrl.value = ''
  outputMime.value = ''
  meta.value = null
  seam.value = null
  blockSet.value = null
  via.value = ''
  revokeBlockUrls()
  geometry.value = { width: 0, height: 0, tiles: [], xBounds: [], yBounds: [] }
}

function revokeBlockUrls() {
  blockUrls.value.forEach((url) => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* 回收失败不影响展示 */
    }
  })
  blockUrls.value = []
}

/** dataURL → ImageBitmap（解码失败给可读繁体文案，不静默）。 */
function decode(src) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('當前環境不支持圖像解碼'))
      return
    }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('影像無法解碼（文件損壞或格式不受支持）'))
    img.src = src
  })
}

function canvasOf(width, height) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

/** 源位图 → 画布（按原色绘制；**本单起不再做任何上色 / 量化**）。 */
function paint(img, width, height) {
  const canvas = canvasOf(width, height)
  const ctx = canvas && canvas.getContext('2d')
  if (!canvas || !ctx) return { ok: false, message: '本機畫布不可用，暫時無法顯示影像' }
  ctx.drawImage(img, 0, 0, width, height)
  return { ok: true, canvas, message: '' }
}

/** 画布 → webp（**如实回报实际 mime**）。 */
function encodeWebp(canvas) {
  let url = ''
  try {
    url = canvas.toDataURL('image/webp', 0.92)
  } catch {
    url = ''
  }
  if (!url || !url.startsWith('data:')) {
    try {
      url = canvas.toDataURL('image/png')
    } catch {
      url = ''
    }
  }
  if (!url) return { ok: false, message: '影像暫時無法顯示（本機畫布無法導出影像）' }
  const comma = url.indexOf(',')
  const mime = comma > 0 ? url.slice(5, url.indexOf(';')) : ''
  return { ok: true, url, mime }
}

/** 存儲件字節的來源（**零轉碼**）：印面族 ⇒ 影像庫；實拍族 ⇒ 照片庫。 */
async function loadStoredFor(rowId, clientKind) {
  if (clientKind === 'scene') {
    const out = await photoService.loadPhotoDataUrl(rowId)
    if (!out.ok) return { ok: false, message: out.message }
    return { ok: true, bytes: out.bytes, mime: imageFaces.storedMimeOf(out.bytes, out.mime), row: props.row }
  }
  const out = await seals.loadStoredImage(rowId)
  if (!out.ok) return { ok: false, message: out.message }
  return { ok: true, bytes: out.bytes, mime: out.mime, row: out.row }
}

/** 块面响应 ⇒ 展示态（**只消费响应**：块数 / 矩形 / 落位皆取自响应）。 */
async function applyBlocks(reply) {
  blockSet.value = reply
  blockUrls.value = reply.blocks.map((block) =>
    URL.createObjectURL(new Blob([block.bytes], { type: block.mime || 'image/webp' }))
  )
  const kernelSeam = reply.manifest && reply.manifest.seam
  seam.value = kernelSeam && typeof kernelSeam === 'object' ? kernelSeam : null
  outputMime.value = (reply.blocks[0] && reply.blocks[0].mime) || ''
  via.value = 'api'
  await Promise.resolve()
  computeGeometry()
}

/** 展示几何：块矩形（源像素）→ 展示像素；**共用边界数组** ⇒ 边缘坐标相接。 */
function computeGeometry() {
  const root = rootRef.value
  if (!root) return
  const rects = sourceRects()
  const source = sourceSizeOf()
  if (!rects || !rects.length || !source) return
  const width = root.clientWidth
  const height = root.clientHeight
  if (!width || !height) return
  const scaleX = width / source.width
  const scaleY = height / source.height
  const xEdges = [...new Set(rects.flatMap((tile) => [tile.x, tile.x + tile.width]))].sort((a, b) => a - b)
  const yEdges = [...new Set(rects.flatMap((tile) => [tile.y, tile.y + tile.height]))].sort((a, b) => a - b)
  const xBounds = xEdges.map((edge, index) => (index === xEdges.length - 1 ? width : Math.round(edge * scaleX)))
  const yBounds = yEdges.map((edge, index) => (index === yEdges.length - 1 ? height : Math.round(edge * scaleY)))
  const urls = blockUrls.value
  const tiles = rects.map((tile, index) => {
    const left = xBounds[xEdges.indexOf(tile.x)]
    const right = xBounds[xEdges.indexOf(tile.x + tile.width)]
    const top = yBounds[yEdges.indexOf(tile.y)]
    const bottom = yBounds[yEdges.indexOf(tile.y + tile.height)]
    const centerX = left + (right - left) / 2
    const centerY = top + (bottom - top) / 2
    return {
      index,
      source: tile,
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      shiftX: centerX < width / 2 ? -1 : 1,
      shiftY: centerY < height / 2 ? -1 : 1,
      /** 塊面模式：本塊自己的字節（**逐塊獨立**，拼接在展示端完成）。 */
      blockUrl: urls[index] || ''
    }
  })
  geometry.value = { width, height, tiles, xBounds, yBounds }
}

/** 畫布上的塊矩形（源像素）：塊面 ⇒ 響應的落位；本機路徑 ⇒ 行上元數據派生的窗口。 */
function sourceRects() {
  if (blockSet.value) {
    return blockSet.value.blocks.map((block) => ({
      x: block.placement.x,
      y: block.placement.y,
      width: block.placement.width,
      height: block.placement.height
    }))
  }
  const current = meta.value
  if (!current || !current.ok) return null
  return current.slices.map((tile) => ({ x: tile.x, y: tile.y, width: tile.width, height: tile.height }))
}

/** 畫布尺寸：塊面 ⇒ 響應的輸出尺寸；本機路徑 ⇒ 解碼得到的大小。 */
function sourceSizeOf() {
  if (blockSet.value) {
    return { width: blockSet.value.sourceWidth, height: blockSet.value.sourceHeight }
  }
  const current = meta.value
  if (!current || !current.ok) return null
  return { width: current.sourceWidth, height: current.sourceHeight }
}

async function render() {
  reset()
  const row = props.row || {}
  const rowId = row.id ? String(row.id) : ''
  const clientKind = imageFaces.clientKindOf(row, props.cutHint)
  loading.value = true
  try {
    if (rowId) {
      /* **K-P5b｜讀取面雙路分流（硬判據）**：行內有 digest（二進制在服務端權威庫）⇒ 塊面走
         **按 digest 引用的形態**（`POST /api/image/slices?sha256=<hex>`）—— **不需要本機字節**；
         無 digest 的存量行 ⇒ 下面既有本機路徑**一行未改**（非 TIFF 原生解碼、**零 api**）。 */
      const digest = seals.imageDigestOf(rowId)
      if (digest) {
        const reply = await imageFaces.fetchSlices({ sha256: digest, assetId: rowId, kind: clientKind })
        if (reply.ok) {
          await applyBlocks(reply)
          return
        }
        /**
         * **可见失败、不回落整图直出**：预览路径的产物恒为切块（规范 §3.24.3 ③）——
         * 失败一律给可读文案 ＋ 机械 `reason`，**不以「本机整图」冒充预览产物**。
         */
        errorReason.value = reply.reason || ''
        error.value = '影像暫時無法顯示'
        return
      }
      const stored = await loadStoredFor(rowId, clientKind)
      if (stored.ok && imageFaces.kernelFaceEligible(stored.mime)) {
        const reply = await imageFaces.fetchSlices({ bytes: stored.bytes, assetId: rowId, kind: clientKind })
        if (reply.ok) {
          await applyBlocks(reply)
          return
        }
        /**
         * **可见失败、不回落整图直出**：预览路径的产物恒为切块（规范 §3.24.3 ③）——
         * 失败一律给可读文案 ＋ 机械 `reason`，**不以「本机整图」冒充预览产物**。
         */
        errorReason.value = reply.reason || ''
        error.value = '影像暫時無法顯示'
        return
      }
      if (!stored.ok && !props.src) {
        error.value = stored.message || '影像暫時無法顯示'
        return
      }
    }
    if (!props.src) return
    /* ---------------------------------------------------------------------
       本機既有路徑（**存量 / 非 TIFF 存儲件**，含存量舊 8 色索引 PNG）——
       與改動前逐行一致：瀏覽器原生解碼 ⇒ 行上元數據派生窗口 ⇒ 逐塊擺放。
       --------------------------------------------------------------------- */
    const img = await decode(props.src)
    const width = img.naturalWidth || img.width
    const height = img.naturalHeight || img.height
    const current = sliceMetaOf(props.row, {
      sourceWidth: width,
      sourceHeight: height,
      cutHint: props.cutHint
    })
    if (!current.ok) {
      /**
       * **R-123③**：`current.message` 是结构化拒绝文案（含内部字段名 / 机制，如
       * 「切分元數據真源缺位：影像行上沒有 slice_meta 鍵（容器未落地）⇒ 拒絕派生張數 / 切位」）
       * ⇒ **不上屏、不进 console**。技术细节退回本注释 + `errorReason` 机械读数；
       * 上屏用中性文案，且**仍是可读错误**（绝不静默、绝不拿空值冒充成功）。
       */
      errorReason.value = current.reason || ''
      error.value = '影像暫時無法顯示'
      return
    }
    const painted = paint(img, width, height)
    if (!painted.ok) {
      error.value = painted.message
      return
    }
    const encoded = encodeWebp(painted.canvas)
    if (!encoded.ok) {
      error.value = encoded.message
      return
    }
    meta.value = current
    seam.value = seamReport(current.sourceWidth, current.sourceHeight, current.slices)
    outputUrl.value = encoded.url
    outputMime.value = encoded.mime
    via.value = 'local'
    notice.value = encoded.mime === 'image/webp'
      ? ''
      : `本機編不出 webp，本次對外展示按實際產物如實標注爲 ${encoded.mime}（不冒充 webp）。`
    await Promise.resolve()
    computeGeometry()
  } catch (err) {
    error.value = `影像讀取失敗：${(err && err.message) || '未知原因'}`
  } finally {
    loading.value = false
  }
}

let observer = null
watch(
  () => [props.src, props.row, props.cutHint],
  async () => {
    await render()
  },
  { immediate: true }
)

watch(rootRef, (el) => {
  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (el && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => computeGeometry())
    observer.observe(el)
  }
})
watch(() => geometry.value.width, () => computeGeometry())

onBeforeUnmount(() => {
  if (observer) observer.disconnect()
  observer = null
  revokeBlockUrls()
})

const tileGeometryText = computed(() =>
  JSON.stringify(
    geometry.value.tiles.map((tile) => ({
      index: tile.index,
      source: [tile.source.x, tile.source.y, tile.source.width, tile.source.height],
      display: [tile.left, tile.top, tile.width, tile.height]
    }))
  )
)

/** 塊數：塊面 ⇒ 響應自報；本機路徑 ⇒ 行上元數據派生（**兩者皆非本組件自算**）。 */
const blockCount = computed(() => {
  if (blockSet.value) return blockSet.value.blockCount
  return meta.value ? meta.value.sliceCount : 0
})
/**
 * **R-123①**：图注生成器（`captionText`）已删除 —— 其文本「由 N 塊按元數據切分後拼接（切向 …；
 * 切分元數據來源：…）」把内部展示机制搬到用户眼前（R-116②：切分对用户无感）。
 * 图注入参（`props.caption`）**保留声明**但不再参与渲染：父组件（详情页 / 我的照片）仍在绑定，
 * 删声明会让该绑定落到根节点成 HTML 属性（无谓的 DOM 改动）。
 */

defineExpose({ geometry, meta, seam, outputUrl, outputMime, errorReason, blockSet, via })
</script>

<template>
  <div class="slice">
    <div
      ref="rootRef"
      class="slice__frame"
      :style="sourceSizeOf() ? { aspectRatio: `${sourceSizeOf().width} / ${sourceSizeOf().height}` } : null"
      :data-slice-block="blockCount || null"
      :data-slice-via="via || null"
      :data-slice-source="blockSet ? (blockSet.manifest.source || 'metadata') : (meta ? meta.source : null)"
      :data-slice-direction="blockSet
        ? (blockSet.manifest.directions || []).join(',')
        : (meta ? meta.direction : null)"
      :data-slice-offsets="blockSet
        ? (blockSet.manifest.ratios || []).join(',')
        : (meta ? meta.offsetRatio.join(',') : null)"
      :data-slice-count-key="blockSet ? 'api-manifest' : (meta ? meta.containerKey : null)"
      :data-slice-cut-kind="blockSet
        ? (blockSet.manifest.kernelKind || blockSet.manifest.kind || null)
        : (meta ? meta.cutKind : null)"
      :data-slice-ratio="blockSet
        ? (blockSet.manifest.ratios || []).join(',')
        : (meta ? meta.offsetRatio.join(',') : null)"
      :data-tile-geometry="geometry.tiles.length ? tileGeometryText : null"
      :data-seam-ok="seam && typeof seam.seamless === 'boolean' ? String(seam.seamless) : null"
      :data-display-mime="outputMime || null"
    >
      <div
        v-for="tile in geometry.tiles"
        :key="tile.index"
        class="slice__tile"
        :data-slice-tile="tile.index"
        :data-tile-rect="`${tile.source.x},${tile.source.y},${tile.source.width},${tile.source.height}`"
        :data-tile-display-rect="`${tile.left},${tile.top},${tile.width},${tile.height}`"
        :style="tile.blockUrl
          ? {
            left: `${tile.left}px`,
            top: `${tile.top}px`,
            width: `${tile.width}px`,
            height: `${tile.height}px`,
            backgroundImage: `url(${tile.blockUrl})`,
            backgroundSize: '100% 100%',
            backgroundPosition: '0 0'
          }
          : {
            left: `${tile.left}px`,
            top: `${tile.top}px`,
            width: `${tile.width}px`,
            height: `${tile.height}px`,
            backgroundImage: outputUrl ? `url(${outputUrl})` : null,
            backgroundSize: `${geometry.width}px ${geometry.height}px`,
            backgroundPosition: `-${tile.left}px -${tile.top}px`
          }"
      />
      <p v-if="loading" class="slice__state">正在載入影像…</p>
      <p v-else-if="error" class="slice__state slice__state--error">{{ error }}</p>
    </div>

    <!-- R-123①：图注文本**已清空**（不留替代文案）。`data-slice-caption` 属性**保留**为机械读数
         —— 既有页面探针在按 `[data-slice-caption]` 计数 / 取文本（`qa-recheck/v20-neng-n3/ev3/
         n3c_pages.py:194-195`、`n3_ext.js:36`、`v20-neng-n1/p_c1_detail.py:32` 等），删元素会
         让这些读数失去锚点。空文本 ⇒ 用户看不到任何切分描述。 -->
    <p v-if="(meta || blockSet) && !error" class="slice__caption" data-slice-caption />
    <p v-if="notice" class="slice__hint" data-slice-notice>{{ notice }}</p>
  </div>
</template>

<style scoped>
.slice {
  display: block;
}

.slice__frame {
  position: relative;
  width: 100%;
  overflow: visible;
  background: var(--c-surface-sunken);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
}

.slice__tile {
  position: absolute;
  background-repeat: no-repeat;
}

.slice__state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: var(--s-2);
  text-align: center;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.slice__state--error {
  color: var(--c-danger);
}

.slice__caption {
  margin-top: var(--s-2);
  color: var(--c-text);
  font-size: var(--t-xs);
}

.slice__hint {
  margin-top: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}
</style>
