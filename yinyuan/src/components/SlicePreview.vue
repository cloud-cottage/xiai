<template>
  <div class="slice-demo">
    <!--
      展示通道：真源返回的**每一塊**切片各自獨立簽名，前端按真源切割元數據（`slices[].rect`）
      以 `clip-path` 分塊還原為視覺完整圖（spec §7.7-R17a / AC-78）。
      塊數不硬編碼：`slices.length` 恒等於真源 `tiles.length`（R-102：印面 4 塊 / 實拍 8 塊）。
    -->
    <figure
      class="slice-stage"
      :class="stageClass"
      :style="stageStyle"
      :data-slice-mode="realMode ? 'image-api' : 'a27'"
      :data-slice-blocks="stageBlockCount"
      :data-slice-state="stageState"
      :data-slice-error="currentError ? (currentError.code || 'ERROR') : ''"
      draggable="false"
      :aria-label="`展示切片示意图：${label}`"
      @contextmenu.prevent="onSaveBlocked"
      @dragstart.prevent="onSaveBlocked"
      @click="onSaveBlocked"
    >
      <span v-if="!realMode" class="ph-badge">图占位</span>

      <!--
        真源影像三面（**塊面**）分支：每塊用**自己的**落位（`placements`，真源逐字）絕對定位，
        塊字節即真源下發的 WebP（本組件**不裁切 / 不縮放 / 不拼接像素** —— R-101）。
        塊數不硬編碼：`blocks.length` 恒等於真源清單的塊數。
      -->
      <template v-if="realMode && realBlocks.length">
        <img
          v-for="block in realBlocks"
          :key="block.index"
          class="slice-real-block"
          :src="block.objectUrl"
          :alt="`第${block.index + 1}块切片`"
          :data-block-index="block.index"
          :data-block-rect="block.rectText"
          :data-block-bytes="block.bytes"
          :data-block-sha256="block.sha256 || ''"
          draggable="false"
          :style="block.style"
        >
      </template>

      <template v-else-if="!realMode && geometryReady">
        <div v-for="tile in tiles" :key="tile.index" class="slice-layer" :style="tile.style">
          <SealPlaceholder :text="text" :style="sealStyle" :badge="false" />
        </div>
        <span
          v-for="seam in seams"
          :key="seam.key"
          class="slice-seam"
          :class="seam.className"
          :style="seam.style"
          aria-hidden="true"
        ></span>
      </template>
      <div v-else class="slice-busy note">
        <!-- 真源影像三面：不可達 / 無摘要 / 無塊 ⇒ **如實降級**（不偽造、不白屏） -->
        <template v-if="realMode">
          <template v-if="slicesLoading">切片载入中…</template>
          <template v-else-if="currentError">真源影像三面读取失败</template>
          <template v-else>真源未下发切片块</template>
        </template>
        <template v-else-if="error">切片读取失败</template>
        <template v-else-if="!assetId">无演示资源 ID</template>
        <template v-else-if="slices && !geometryReady">切片元数据不含几何（rect）：无法拼接显示</template>
        <template v-else>切片载入中…</template>
      </div>
    </figure>

    <p class="slice-meta note">
      <!-- 真源影像三面（塊面）：塊數 / 網格 / 刀數 / 刀向 / 幾何真源版本**全部讀自真源清單** -->
      <template v-if="realMode">
        <template v-if="realBlocks.length">
          展示切片 {{ realBlocks.length }} 块 · {{ realGridText }} · 几何真源
          <code class="mono">{{ realVersionText }}</code>（{{ realKindText }}）
        </template>
        <template v-else-if="currentError">切片读取失败</template>
        <template v-else-if="slicesLoading">切片载入中…</template>
        <template v-else>真源未下发切片块</template>
      </template>
      <template v-else-if="geometryReady">
        展示切片 {{ slices.slices.length }} 块 · {{ meta.cols }}×{{ meta.rows }} 网格（{{ meta.cuts }} 刀 ·
        刀向 {{ meta.directions.join(' → ') }}）· 签名 TTL {{ slices.sigTtlSeconds }}s
      </template>
      <template v-else-if="error">切片读取失败</template>
      <template v-else-if="!assetId">—</template>
      <template v-else-if="slices">切片元数据不含几何</template>
      <template v-else>切片载入中…</template>
    </p>

    <!-- 真源影像三面：源尺寸 / 切位比例 / 無縫讀數 / 縮略面讀數（**一律真源返回值，不代算**） -->
    <template v-if="realMode && realBlocks.length">
      <p class="slice-meta note">
        切位比例 {{ realRatiosText }} · 源尺寸 {{ realSourceText }} px · 块容器
        <code class="mono">{{ realBlockMimeText }}</code>（无损 {{ realBlockLosslessText }}）
      </p>
      <p class="slice-meta note">
        无缝读数（真源自报）：面积守恒 {{ realSeamText('areaEqualsSource') }} · 无重叠
        {{ realSeamText('noOverlap') }} · 边缘相邻 {{ realSeamText('edgesAdjacent') }} · 响应内含未分割整图
        {{ realDisplayWholeImageText }}
      </p>
      <p class="slice-meta note">
        缩略图面（直出路径 · 不经切片）：{{ thumbText }}
      </p>
      <p v-if="thumbUrl" class="slice-meta note">
        <img
          class="slice-thumb-proof"
          :src="thumbUrl"
          :alt="`缩略图面真源输出（${thumbMimeText}）`"
          :data-thumb-mime="thumbMimeText"
          :data-thumb-bytes="thumbBytesText"
          draggable="false"
        >
      </p>
    </template>

    <p v-if="geometryReady" class="slice-meta note">
      切位比例 {{ meta.ratios.join(' / ') }} · 源尺寸 {{ meta.sourceWidth }}×{{ meta.sourceHeight }} px ·
      几何真源 <code class="mono">{{ meta.tilesplicerVersion || '—' }}</code>（{{ meta.kind }}）
    </p>

    <p v-if="geometryReady" class="slice-meta note">
      内容缓存 TTL {{ slices.sliceContentTtlSeconds }}s（至次日 00:00，当日内容固定）·
      缓存键 <code class="mono">{{ slices.sliceContentCacheKey }}</code>
    </p>

    <template v-if="currentError">
      <p class="slice-meta note">
        失败码 <code class="mono">{{ currentError.code || '—' }}</code>（reason
        <code class="mono">{{ currentError.reason || '—' }}</code>）· 已结构化失败，<b>不回退演示资料</b>
      </p>
      <div v-if="currentError.requestedUrl" class="sig-box mono">请求：{{ currentError.requestedUrl }}</div>
      <p v-if="currentError.message" class="slice-meta note">{{ currentError.message }}</p>
    </template>

    <template v-if="realMode && realBlocks.length">
      <button class="sig-toggle" type="button" @click="showSig = !showSig">
        {{ showSig ? '收起各块读数（rect / 位元组 / sha256）' : `查看 ${realBlocks.length} 块切片读数（rect / 位元组 / sha256）` }}
      </button>
      <div v-if="showSig" class="sig-box mono">
        <span v-for="block in realBlocks" :key="block.index">
          第{{ block.index + 1 }}块 · 行{{ block.row }}列{{ block.col }} ·
          rect({{ block.rectText }}) · 落位(x{{ block.placement.x }},y{{ block.placement.y }},{{
            block.placement.width }}×{{ block.placement.height }}) ·
          {{ block.bytes }} B · {{ block.mime }} · sha256 {{ block.sha256 || '未下发' }}
        </span>
      </div>
    </template>

    <template v-if="geometryReady">
      <button class="sig-toggle" type="button" @click="showSig = !showSig">
        {{ showSig ? '收起各块独立签名 URL' : `查看 ${slices.slices.length} 块独立签名 URL` }}
      </button>
      <div v-if="showSig" class="sig-box mono">
        <span v-for="s in slices.slices" :key="s.sliceIndex">
          第{{ s.sliceIndex + 1 }}块 · 行{{ s.row }}列{{ s.col }} ·
          rect({{ s.rect.x }},{{ s.rect.y }},{{ s.rect.w }},{{ s.rect.h }}) ·
          {{ bytesText(s) }}：{{ s.url }}
        </span>
      </div>
    </template>

    <p class="hint">
      展示切片为辅助防护：<b>本卡片区域内</b>屏蔽右键另存与拖曳（页面其他区域不做限制）；无法阻止专业爬虫抓取切片后拼接，原图权限由后端鉴权控制
    </p>
  </div>
</template>

<script setup>
/**
 * 圖片雙通道「輕演示」組件（首頁樣例卡用；不新增頁面）。
 *
 * 職責：
 *  ① 經 A27 `getDisplaySlices(assetId)` 取切片組 —— **塊數聽真源**（R-102：印面 4 塊 / 實拍 8 塊），
 *     各塊獨立簽名 URL，零外鏈；
 *  ② **按元數據分塊渲染**：每一塊用它自己的 `slices[].rect`（真源幾何逐字）以 `clip-path`
 *     `inset()` 裁切，底圖為同一張「視覺完整圖」⇒ 預設重疊後視覺無縫（無白縫、無疊蓋、
 *     無重複像素，AC-78）；懸停時各塊按自身 `row/col` 輕微分離，直觀顯示「由 N 塊拼成」；
 *     切割線位置亦由元數據的塊邊界派生（`cols-1` 條豎線 / `rows-1` 條橫線），**本組件不重算切位**（R-101）；
 *  ③ 另存門檻：`contextmenu` / `dragstart` preventDefault + `draggable="false"` +
 *     CSS `user-select:none`，並給出提示（**輔助手段，非強防護**）；
 *  ④ 失敗態：適配層的結構化失敗（`code` / `reason` / 請求讀數）在此**可讀呈現**；
 *     本組件**不回落 mock 資料**、不以占位圖冒充成功（§7.7 v1.34 注③）。
 *
 * 紀律（spec §7.7-R17d / §1.6 圖片雙通道聲明 / AC-84）：任何文案**不得**出現
 * 「切片防盜圖 / 不可下載」類誇大表述；塊數、切位、簽名 TTL 一律來自適配層返回值。
 * 上屏文案一律繁體（AC-72 同源紀律）。
 *
 * 階段 P5c（本單新增）：**分派兩條路徑** ——
 *  · 父級給出 `sha256` ⇒ **xiai-api 影像三面**（塊面 `/api/image/slices` ＋ 縮略面 `/api/image/thumb`）：
 *    塊字節即真源下發的 WebP，落位逐字取自真源 `placements`，本組件**零像素運算**（R-101）；
 *    真源不可達 / 無摘要 / 無塊 / 結構不符 ⇒ **如實降級**（顯示失敗碼 + 請求讀數），
 *    **不偽造數據、不白屏、不拋未捕獲異常**（缺字段一律先防護再讀）；本組件**不觸發原字節面**
 *    （下載面屬顯式動作、需登錄態與額度校驗，不在本卡範圍）。
 *  · 未給 `sha256` ⇒ 既有 A27 路徑（`getDisplaySlices`，mock 可運行）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import SealPlaceholder from '@/components/SealPlaceholder.vue'
import { getDisplaySlices, getImageSlices, getImageThumb, clientKindOf, releaseImageUrls } from '@/data'
import { useAsync } from '@/composables/useAsync.js'
import { toastNotConnected } from '@/composables/useToast.js'

const props = defineProps({
  /** 影像資源 ID（A27 / 塊面 入參） */
  assetId: { type: String, default: '' },
  /** 卡片標題，用於無障礙標籤 */
  label: { type: String, default: '玺印样例' },
  /** 印面文字（純 CSS 佔位） */
  text: { type: String, default: 'XX之印' },
  /** BAI_WEN | ZHU_WEN */
  sealStyle: { type: String, default: 'BAI_WEN' },
  /** 作品類別（FACE | PHOTO；留空 ⇒ 由適配層按預設 FACE 解析） */
  kind: { type: String, default: '' },
  /**
   * 源件摘要（`sha256`，64 位十六進制）—— **給出即走 xiai-api 影像三面**
   * （塊面 `/api/image/slices` ＋ 縮略面 `/api/image/thumb`）；
   * 缺省 ⇒ 維持既有 A27 路徑（mock 亦可運行）。
   * 形態不符的摘要**不由本組件代填或改寫** —— 一律交真源判定，失敗如實上屏。
   */
  sha256: { type: String, default: '' },
})

const showSig = ref(false)

/**
 * 真源影像三面模式判據 ＝ **調用方是否給出源件摘要**。
 * 與 `config/env.js` 的 `DATA_SOURCE`（mock | api）**解耦**：三面屬 xiai-api 影像面，
 * 不經 A1–A31 適配層，故 mock 模式下只要給出摘要亦可真實取件（spec §8.3-1 不受影響）。
 */
const realMode = computed(() => String(props.sha256 || '').trim() !== '')

/** A27 路徑（既有）：mock 或 api 由 `@/data` 的單一開關決定。 */
const state = useAsync(
  (id) => getDisplaySlices(id, props.kind ? { kind: props.kind } : undefined),
  { immediate: false },
)

/** 真源影像三面：塊面（展示切片）＋ 縮略面（直出路徑縮略圖）。**本組件不觸發原字節面**。 */
const slicesState = useAsync((payload) => getImageSlices(payload), { immediate: false })
const thumbState = useAsync((payload) => getImageThumb(payload), { immediate: false })

/**
 * 本組件持有的 `objectURL` 登記（**逐面獨立替換**）：新數據落地才釋放舊的一組，
 * 避免在舊 DOM 仍引用時提前 revoke；卸載時全數釋放。
 */
let retainedSliceUrls = []
let retainedThumbUrl = ''

function swapSliceUrls(urls) {
  const previous = retainedSliceUrls
  retainedSliceUrls = Array.isArray(urls) ? urls : []
  releaseImageUrls(previous)
}

function swapThumbUrl(url) {
  const previous = retainedThumbUrl
  retainedThumbUrl = typeof url === 'string' ? url : ''
  if (previous) releaseImageUrls([previous])
}

/** 起一輪真源三面取件（塊面 ＋ 縮略面並發；**互不阻塞** —— 縮略面失敗不影響塊面上屏）。 */
function runImageFaces() {
  const payload = {
    assetId: props.assetId,
    kind: clientKindOf(props.kind),
    sha256: String(props.sha256 || '').trim(),
  }
  slicesState.run(payload).then((data) => {
    if (data && Array.isArray(data.blocks)) {
      swapSliceUrls(data.blocks.map((block) => block.objectUrl).filter(Boolean))
    }
  })
  thumbState.run({ kind: payload.kind, sha256: payload.sha256 }).then((data) => {
    if (data && data.objectUrl) swapThumbUrl(data.objectUrl)
  })
}

/** 退出真源模式（或卸載）時釋放所有 `objectURL`。 */
function releaseRealUrls() {
  swapSliceUrls([])
  swapThumbUrl('')
}

/**
 * 資源 ID / 類別 / 摘要由父級異步給出，可能晚於本組件掛載 —— 必須 `watch` 後重新取件，
 * 否則卡片會永久停在「切片載入中…」（P2b 實測踩到：首帧 assetId 為空）。
 * 分派：**有摘要 ⇒ 真源三面**；否則 ⇒ 既有 A27 路徑（mock 可運行）。
 */
watch(
  () => [props.assetId, props.kind, props.sha256],
  ([id]) => {
    if (realMode.value) {
      runImageFaces()
      return
    }
    releaseRealUrls()
    if (id) state.run(id)
  },
  { immediate: true },
)

onBeforeUnmount(releaseRealUrls)

/** 適配層返回的切片組（未就緒時為 null）。 */
const slices = computed(() => state.data.value)
const error = computed(() => state.error.value)
const meta = computed(() => slices.value?.sliceMeta || null)

/* --------------------------------------------------------------------------
 * 真源影像三面（塊面 / 縮略面）的讀數面 —— **一律真源返回值，缺字段即「未下發」，不代算**
 * ------------------------------------------------------------------------ */

/** 未下發哨兵（**不得**以 0 / 空字串充當讀數）。 */
const UNSET = '未下发'

/** 真源清單（塊面）與其失敗態。 */
const imageGroup = computed(() => slicesState.data.value)
const imageError = computed(() => slicesState.error.value)

/** 當前生效的失敗態（真源模式 ⇒ 三面失敗；A27 模式 ⇒ 適配層失敗）。 */
const currentError = computed(() => (realMode.value ? imageError.value : error.value))
const slicesLoading = computed(() => (realMode.value ? slicesState.loading.value : state.loading.value))

/** 供取證 / 無障礙讀取的態讀數（**穩定字面值**：loading | error | ready | empty）。 */
const stageState = computed(() => {
  if (slicesLoading.value) return 'loading'
  if (currentError.value) return 'error'
  if (realMode.value) return realBlocks.value.length ? 'ready' : 'empty'
  return geometryReady.value ? 'ready' : 'empty'
})

/** 有限數如實轉字串；非有限 ⇒ `未下發`。 */
function shown(value) {
  const num = Number(value)
  return Number.isFinite(num) ? String(num) : UNSET
}

/** 布爾讀數如實轉字串；非布爾 ⇒ `未下發`。 */
function shownBool(value) {
  return typeof value === 'boolean' ? (value ? '是' : '否') : UNSET
}

/**
 * 塊面的**逐塊落位**：位置 / 尺寸全部由真源 `blocks[].placements`（缺則 `rect`）以百分比換算，
 * 容器即源圖尺寸 ⇒ 塊與塊之間**無縫**（本組件不派生素何 —— R-101 / AC-78）。
 */
const realBlocks = computed(() => {
  const group = imageGroup.value
  const source = group && group.source ? group.source : null
  const width = source ? Number(source.width) : NaN
  const height = source ? Number(source.height) : NaN
  if (!group || !Array.isArray(group.blocks) || !group.blocks.length) return []
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return []

  return group.blocks
    .map((block) => {
      const rect = block.rect
      const placement = block.placement || rect
      if (!rect || !placement || !block.objectUrl) return null
      return {
        index: block.index,
        row: block.row,
        col: block.col,
        rect,
        placement,
        rectText: `${rect.x},${rect.y},${rect.w},${rect.h}`,
        bytes: Number.isFinite(Number(block.bytes)) ? Number(block.bytes) : null,
        mime: block.mime || UNSET,
        lossless: block.lossless,
        sha256: block.sha256,
        objectUrl: block.objectUrl,
        style: {
          left: pct(placement.x, width),
          top: pct(placement.y, height),
          width: pct(placement.width, width),
          height: pct(placement.height, height),
        },
      }
    })
    .filter(Boolean)
})

/** 塊數 / 網格 / 刀數 / 刀向（真源清單逐字）。 */
const realGridText = computed(() => {
  const group = imageGroup.value
  if (!group) return UNSET
  const directions = Array.isArray(group.directions) && group.directions.length
    ? group.directions.join(' → ')
    : UNSET
  return `${shown(group.cols)}×${shown(group.rows)} 网格（${shown(group.cuts)} 刀 · 刀向 ${directions}）`
})

/** 幾何真源版本 / 類別（含內核類別，供面別不串台的覆核）。 */
const realVersionText = computed(() => imageGroup.value?.version || UNSET)
const realKindText = computed(() => {
  const group = imageGroup.value
  if (!group) return UNSET
  const kind = group.kind || UNSET
  return group.kernelKind ? `${kind} ⇐ 内核 ${group.kernelKind}` : kind
})

/** 切位比例（真源 `ratios` 逐字）。 */
const realRatiosText = computed(() => {
  const ratios = imageGroup.value?.ratios
  return Array.isArray(ratios) && ratios.length ? ratios.map((n) => shown(n)).join(' / ') : UNSET
})

/** 源尺寸（真源 `source`）。 */
const realSourceText = computed(() => {
  const source = imageGroup.value?.source
  return source ? `${shown(source.width)}×${shown(source.height)}` : UNSET
})

/** 塊傳輸容器（真源首塊 `mime`）與其無損標記。 */
const realBlockMimeText = computed(() => realBlocks.value[0]?.mime || UNSET)
const realBlockLosslessText = computed(() => shownBool(realBlocks.value[0]?.lossless))

/** 無縫讀數（真源 `seam` 自報；本組件不重算幾何，只如實呈現）。 */
function realSeamText(key) {
  const seam = imageGroup.value?.seam
  return seam ? shownBool(seam[key]) : UNSET
}

/** 響應內是否含未切分整圖（真源 `display.whole_image_included`）。 */
const realDisplayWholeImageText = computed(() => shownBool(imageGroup.value?.display?.wholeImageIncluded))

/** 縮略面讀數（**直出路徑**；失敗如實上屏，不改用塊面數據冒充）。 */
const thumbText = computed(() => {
  const thumb = thumbState.data.value
  if (thumb) {
    return `长边 ${shown(thumb.longEdge)} px · ${shown(thumb.byteLength)} B · ${thumb.mime || UNSET}`
      + `（源 ${shown(thumb.source?.width)}×${shown(thumb.source?.height)} → 出 ${shown(thumb.out?.width)}×${shown(thumb.out?.height)}）`
  }
  const failure = thumbState.error.value
  if (failure) return `读取失败（${failure.code || 'ERROR'}）`
  return '读取中…'
})

const thumbUrl = computed(() => thumbState.data.value?.objectUrl || '')
const thumbMimeText = computed(() => thumbState.data.value?.mime || UNSET)
const thumbBytesText = computed(() => shown(thumbState.data.value?.byteLength))

/**
 * 幾何就緒判據：**必須**有真源 `sourceWidth/Height` 且**每一塊**都帶 `rect`。
 * 缺幾何 ⇒ 走可讀失敗態，**不以舊的 direction/offsetRatio 自行補算切位**（R-101）。
 */
const geometryReady = computed(() => {
  const group = slices.value
  const m = meta.value
  if (!group?.slices?.length || !m) return false
  if (!(m.sourceWidth > 0) || !(m.sourceHeight > 0)) return false
  return group.slices.every((s) => s?.rect && s.rect.w > 0 && s.rect.h > 0)
})

/** 像素 → 百分比（相對源圖尺寸；位數足以避免累積捨入）。 */
function pct(value, total) {
  return `${((value / total) * 100).toFixed(4)}%`
}

/** 單塊的裁切窗口：`inset(top right bottom left)` 由該塊 rect 直接換算（不推導切位）。 */
function clipOf(rect, sourceWidth, sourceHeight) {
  return `inset(${pct(rect.y, sourceHeight)} ${pct(sourceWidth - (rect.x + rect.w), sourceWidth)}`
    + ` ${pct(sourceHeight - (rect.y + rect.h), sourceHeight)} ${pct(rect.x, sourceWidth)})`
}

/** 懸停時各塊的分離位移（像素；僅視覺演示，非業務數字）。 */
const SEPARATION_PX = 4

/**
 * 逐塊圖層：每塊皆為「整張視覺完整圖」的一層，用自身 rect 裁切 ⇒ 預設重疊即無縫；
 * 懸停分離量按該塊的 `row/col` 相對網格中心派生（元數據驅動，塊數任意）。
 */
const tiles = computed(() => {
  const group = slices.value
  const m = meta.value
  if (!geometryReady.value) return []
  const cols = Number(m.cols) || Math.max(...group.slices.map((s) => s.col + 1))
  const rows = Number(m.rows) || Math.max(...group.slices.map((s) => s.row + 1))
  return group.slices.map((slice) => {
    const clip = clipOf(slice.rect, m.sourceWidth, m.sourceHeight)
    const dx = (Number(slice.col) - (cols - 1) / 2) * SEPARATION_PX
    const dy = (Number(slice.row) - (rows - 1) / 2) * SEPARATION_PX
    return {
      index: slice.sliceIndex,
      style: {
        clipPath: clip,
        webkitClipPath: clip,
        '--dx': `${dx}px`,
        '--dy': `${dy}px`,
      },
    }
  })
})

/** 切割線位置：由塊邊界的**去重集合**派生（豎線 ＝ 內側 x 邊界；橫線 ＝ 內側 y 邊界）。 */
const seams = computed(() => {
  const group = slices.value
  const m = meta.value
  if (!geometryReady.value) return []
  const xEdges = [...new Set(group.slices.map((s) => s.rect.x + s.rect.w))]
    .filter((v) => v > 0 && v < m.sourceWidth)
  const yEdges = [...new Set(group.slices.map((s) => s.rect.y + s.rect.h))]
    .filter((v) => v > 0 && v < m.sourceHeight)
  return [
    ...xEdges.map((v) => ({
      key: `v${v}`,
      className: 'seam-v',
      style: { left: pct(v, m.sourceWidth), top: '0', bottom: '0', width: '1px' },
    })),
    ...yEdges.map((v) => ({
      key: `h${v}`,
      className: 'seam-h',
      style: { top: pct(v, m.sourceHeight), left: '0', right: '0', height: '1px' },
    })),
  ]
})

const stageClass = computed(() => {
  if (realMode.value) return realBlocks.value.length ? 'is-real' : 'is-unknown'
  return geometryReady.value ? 'is-gapped' : 'is-unknown'
})

/**
 * 真源模式下的舞台比例：**由真源 `source` 尺寸派生**（非方形源圖不得被拉成方形 —— 如實呈現）。
 * A27 模式維持既有固定方形（純 CSS 佔位，不涉真像素）。
 */
const stageStyle = computed(() => {
  const source = imageGroup.value?.source
  const width = source ? Number(source.width) : NaN
  const height = source ? Number(source.height) : NaN
  if (!realMode.value || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {}
  }
  return { '--src-aspect': `${width} / ${height}` }
})

/** **已就緒塊數**讀數（供取證 / 無障礙；真源模式 ⇒ 真源塊數，A27 模式 ⇒ 真源切片數，皆非硬編碼）。 */
const stageBlockCount = computed(() => {
  if (realMode.value) return realBlocks.value.length
  return geometryReady.value ? (slices.value?.slices?.length || 0) : 0
})

/** 每塊位元組：真源不下發時如實顯示「未下發」，不以估算值充數。 */
function bytesText(slice) {
  return slice?.bytes === null || slice?.bytes === undefined ? '位元组未下发' : `${slice.bytes} B`
}

/** 另存門檻命中提示 —— 如實說明這是輔助手段，且**限定作用範圍**：僅本卡片區域內屏蔽。 */
function onSaveBlocked() {
  toastNotConnected('展示切片为辅助防护手段：仅本卡片区域内屏蔽右键另存 / 拖曳（页面其他区域不做限制）；无法阻止专业爬虫拼接，原图权限由后端鉴权控制')
}
</script>

<style scoped>
.slice-demo { display: flex; flex-direction: column; align-items: stretch; }
.slice-stage {
  position: relative; width: var(--seal-size); height: var(--seal-size); margin: 0 auto;
  user-select: none; -webkit-user-select: none; -webkit-user-drag: none; touch-action: manipulation;
}
.slice-layer { position: absolute; inset: 0; transition: transform var(--t-fade) ease; }

/* 真源塊面：逐塊按真源落位（placements）絕對定位，容器比例由真源 source 派生 ⇒ 預設無縫（AC-78）；
   塊本身就是真源下發的 WebP 字節 —— 本組件不裁切、不縮放、不拼接像素（R-101）。 */
.slice-stage.is-real { height: auto; aspect-ratio: var(--src-aspect, 1 / 1); }
.slice-real-block { position: absolute; display: block; object-fit: fill; pointer-events: none; }
/* 縮略面（直出路徑）真源輸出，供取證覆核用；不作為卡片主視覺 */
.slice-thumb-proof {
  display: block; width: var(--sp-20); max-width: 100%; height: auto;
  border: var(--border-dashed); border-radius: var(--radius-sm);
}

/* 懸停時各塊按自身 row/col 輕微分離 → 直觀展示「由 N 塊拼接」；移出即復原為視覺完整圖 */
.slice-stage.is-gapped:hover .slice-layer { transform: translate(var(--dx, 0px), var(--dy, 0px)); }

.slice-seam {
  position: absolute; opacity: 0; pointer-events: none;
  background: repeating-linear-gradient(var(--seam-angle, 90deg), var(--line) 0 4px, transparent 4px 8px);
}
/* AC-78 全部切片塊拼接**視覺無縫**：預設不顯示切割線；僅當懸停使各塊分離時才顯形 */
.slice-stage:hover .slice-seam { opacity: .9; }
.slice-seam.seam-h { --seam-angle: 0deg; }
.slice-busy {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  border: var(--border-dashed); border-radius: var(--radius-sm); text-align: center; padding: 0 var(--sp-3);
}
.slice-meta { margin: var(--sp-4) 0 0; }
.sig-toggle {
  align-self: center; margin-top: var(--sp-2); font-family: inherit; font-size: var(--fs-12);
  background: none; border: 0; color: var(--brand); cursor: pointer; text-decoration: underline;
}
.sig-box {
  margin-top: var(--sp-2); font-size: var(--fs-11); color: var(--faint); word-break: break-all;
  border-left: var(--border-accent); background: var(--paper); padding: var(--sp-2) var(--sp-3); text-align: left;
}
.sig-box span { display: block; }
</style>
