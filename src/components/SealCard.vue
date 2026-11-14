
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sealGlyph } from '../utils/format.js'
import { seals, corrections, imageFaces, sealCards } from '../services/index.js'

const props = defineProps({
  seal: { type: Object, required: true }
})
const emit = defineEmits(['download', 'save'])

const glyph = computed(() => sealGlyph(props.seal.seal_name))
/* r2：显示名单点（采纳值 → 原始 `seal_name` →「佚名」），与详情页 / 属性表同源。 */
const currentText = computed(() => corrections.resolveSealDisplayName(props.seal))
/* **作者显示名单点（§3.54.9）**：与详情 / 导出 / 文本导出**同一单点**
   （`author_person_id` 命中 ⇒ 印人 display_name → 未命中 ⇒ 旧 `author` → 皆空 ⇒「佚名」）。
   卡片**不读**裸 `seal.author`（那会绕过引用型、长出第二套名表）。 */
const authorName = computed(() => corrections.resolveAuthorDisplayName(props.seal))

/* ============================================================================
   **兩種卡來源（本單｜分頁卡片 vs 本機行）**
   ----------------------------------------------------------------------------
   · `card` 形態 ＝ 雲端分頁回包的 14 鍵行：封面**只**用 `thumb_key` / `display_key`
     （內容尋址對象）⇒ **不碰全量水合的 seals/faces 映射**、也不查主印面；
   · 本機形態 ＝ 既有印章視圖模型（示範資料 / 詳情同源行）：維持原路徑
     （主印面 ⇒ 影像行 ⇒ 縮略面 / 原生解碼）。
   判據：**雲端分頁行標記**（`sealCards.isCloudCardRow`，符號鍵）**或**行上有對象鍵，
   **不看登錄態 / 不猜數據源狀態**。為什麼必須認標記：bundled 占位行 ／ 無影像行的
   `thumb_key` / `display_key` **兩鍵皆空串**（與本機行同形）—— 只看鍵會把它們誤判成本機行
   ⇒ 走本機解碼路徑（雲端行多半查無影像 ⇒ 只剩字形，**本地占位圖出不來**）。
   ============================================================================ */
const cardMode = computed(() => sealCards.isCloudCardRow(props.seal) || sealCards.coverKeyOf(props.seal) !== '')
/** 標籤取值：卡片行用 `category`（＝印面內容）；本機行沿用 `seal_type`。 */
const contentTag = computed(() => String(props.seal.seal_type || props.seal.category || ''))
/** 「多面」判據（裁定件 §三）：**面數 > 1** ⇒ 多面（不再按 `kind === 'EDGE'` 分類）。
    卡片行 ＝ `face_count`（非 EDGE 面數）＋ `edge_count`（EDGE 面數）；
    本機視圖模型 ＝ `faceCount`（`seals.js` 的 `faces.length`，含 `kind='EDGE'` 面）；
    两键皆缺的旧行才回落到 `hasEdge`（兼容兜底，非分类口径）。 */
const isMultiFace = computed(() => {
  if (props.seal.face_count !== undefined && props.seal.face_count !== null) {
    const faceCount = Number(props.seal.face_count)
    const edgeCount = Number(props.seal.edge_count)
    const total = (Number.isFinite(faceCount) ? faceCount : 0) + (Number.isFinite(edgeCount) ? edgeCount : 0)
    return total > 1
  }
  const localFaces = Number(props.seal.faceCount)
  if (Number.isFinite(localFaces) && localFaces > 0) return localFaces > 1
  return props.seal.hasEdge === true
})
/** 主印面（**僅本機形態**查詢**；卡片形態下不查**，避免任何全量映射依賴）。 */
const face = computed(() => (cardMode.value ? null : seals.primaryFaceOf(props.seal.stamp_id)))
const thumbUrl = ref('')
const thumbError = ref('')
/**
 * 縮略件的來源面別（機械讀數 `data-thumb-face`）：
 *   · 卡片形態三級回落 —— `object` ＝ 第一級 `thumb_key` 對象；`fallback` ＝ 第二級
 *     `display_key`（取鏈失敗 / `<img @error>` 的運行時回落）；`placeholder` ＝ 第三級
 *     **本地占位圖**（`SEAL_PLACEHOLDER_IMAGE.asset_url`，base 感知）；
 *   · 本機形態沿用 —— `api` ＝ 縮略面（256 長邊單件、不經切分內核）；`native` ＝ 本機原生解碼。
 */
const thumbVia = ref('')
/** 封面取件中（卡片形態）：佔位字形照常顯示，不把「還沒到」說成「沒有」（不靜默成空態）。 */
const thumbBusy = ref(false)
/** 卡片形態封面的**回落台階**：0 ＝ thumb 級、1 ＝ display 級、2 ＝ 本地占位圖（`@error` 的判據）。 */
const coverStage = ref(0)

/* **卡片形態封面：三級回落**（thumb → display → 本地占位圖）。
   第一級與第二級的「取鏈失敗」在 `cardCoverUrl` 內逐級處理；「取到鏈但字節 404 / 解碼失敗」
   由 `<img @error>` → `onCoverImageError` 處理 —— 回落是**運行時**的，不只判空。 */
function applyCover(cover) {
  thumbUrl.value = cover.url
  thumbVia.value = cover.via === 'thumb' ? 'object' : 'fallback'
  coverStage.value = cover.via === 'thumb' ? 0 : 1
}

/** 第三級：**本地占位圖**（base 感知資產 URL，非站根絕對路徑）；資產缺損 ⇒ 退回字形空態（不造假 URL）。 */
function toCoverPlaceholder(message) {
  const url = sealCards.coverPlaceholderUrl()
  thumbVia.value = url ? 'placeholder' : ''
  thumbError.value = url ? '' : (message || '封面影像暫時無法顯示')
  thumbUrl.value = url
  coverStage.value = 2
}

/** `<img @error>` 的**運行時回落**：thumb 級壞 ⇒ 換 display 級；再壞 ⇒ 本地占位圖。 */
async function onCoverImageError() {
  if (!cardMode.value) return
  if (coverStage.value === 0 && sealCards.coverDisplayKeyOf(props.seal)) {
    const cover = await sealCards.cardCoverUrl(props.seal, { via: 'display' })
    if (cover.ok) {
      applyCover(cover)
      return
    }
    toCoverPlaceholder(cover.message)
    return
  }
  if (coverStage.value <= 1) {
    toCoverPlaceholder('封面影像暫時無法顯示')
    return
  }
  /* 占位圖資產本身取不到 ⇒ 如實退回字形空態（**不再重試**，避免循環）。 */
  thumbUrl.value = ''
  thumbVia.value = ''
  thumbError.value = '封面影像暫時無法顯示'
}

/* ============================================================================ *
   縮略面（规范 §3.27.6 / §3.24.3 ②）
   ----------------------------------------------------------------------------
   縮略圖 ＝ **256 長邊單件**、**不經切分內核** ⇒ 卡片縮略圖走 **`POST /api/image/thumb`**
   （由服務端從**源字節**轉出），**不再**在卡片上按塊切分渲染。
   **存量舊 8 色索引 PNG（及一切非 TIFF 容器）仍走瀏覽器原生解碼、絕不過 api**
   （服務端來源門對非 TIFF 結構化拒絕 ⇒ 舊行必須仍由原生解碼顯示，不得回歸）。
   ============================================================================ */
async function loadThumb() {
  /* **卡片形態（本單）**：封面按 `thumb_key` → `display_key` 逐級取對象臨時鏈接，
     兩級都取不到 ⇒ 本地占位圖；不查主印面、不讀本機影像庫 ⇒ 與全量水合解耦
     （首屏 48 枚不必等 11,800 行落定）。 */
  if (cardMode.value) {
    revokeThumb()
    thumbBusy.value = true
    thumbUrl.value = ''
    thumbError.value = ''
    thumbVia.value = ''
    coverStage.value = 0
    const cover = await sealCards.cardCoverUrl(props.seal)
    thumbBusy.value = false
    if (cover.ok) {
      applyCover(cover)
      return
    }
    /* **內容面取不到**（兩鍵皆空 / 對象不存在 / 鍵形態不過）⇒ 第三級本地占位圖；
       **配置 / 傳輸面失敗**（未配桶、雲端不可用）⇒ 仍走既有字形空態 ＋ 原話
       （不把「壞了」說成「沒有圖」）。 */
    const contentReasons = ['MISSING_REQUIRED', 'INVALID_VALUE', 'STORAGE_FILE_NOT_FOUND', 'NOT_IMAGE']
    if (contentReasons.indexOf(cover.reason) !== -1) {
      toCoverPlaceholder(cover.message)
      return
    }
    thumbError.value = cover.message || '封面影像暫時無法顯示'
    return
  }
  const current = face.value
  const imageId = current && current.face_image_id ? String(current.face_image_id) : ''
  if (!imageId) {
    thumbUrl.value = ''
    thumbError.value = ''
    thumbVia.value = ''
    return
  }
  /* **K-P5b｜讀取面雙路分流（硬判據）**：行內有 digest（二進制在服務端權威庫）⇒ 縮略面走
     **按 digest 引用的形態**（`POST /api/image/thumb?sha256=<hex>`）—— **不需要本機字節**；
     無 digest 的存量行 ⇒ 下面既有路徑**一行未改**（非 TIFF 原生解碼、**零 api**）。 */
  const digest = seals.imageDigestOf(imageId)
  if (digest) {
    const thumb = await imageFaces.fetchThumbBytes({
      sha256: digest,
      kind: imageFaces.clientKindOf(current.faceImage || {}, ''),
      longEdge: imageFaces.THUMB_LONG_EDGE
    })
    if (thumb.ok) {
      revokeThumb()
      thumbObjectUrl.value = URL.createObjectURL(new Blob([thumb.bytes], { type: thumb.mime || 'image/webp' }))
      thumbUrl.value = thumbObjectUrl.value
      thumbError.value = ''
      thumbVia.value = 'api'
      return
    }
    thumbUrl.value = ''
    thumbVia.value = ''
    thumbError.value = thumb.message || '印面縮略圖讀取失敗'
    return
  }
  /* 二進制只經服務層取回（頁面 / 組件不碰任何瀏覽器存儲）。 */
  const stored = await seals.loadStoredImage(imageId)
  if (!stored.ok) {
    thumbUrl.value = ''
    thumbError.value = stored.message || '印面縮略圖讀取失敗'
    thumbVia.value = ''
    return
  }
  if (imageFaces.kernelFaceEligible(stored.mime)) {
    const thumb = await imageFaces.fetchThumbBytes({
      bytes: stored.bytes,
      kind: imageFaces.clientKindOf(stored.row || {}, ''),
      longEdge: imageFaces.THUMB_LONG_EDGE
    })
    if (thumb.ok) {
      revokeThumb()
      thumbObjectUrl.value = URL.createObjectURL(new Blob([thumb.bytes], { type: thumb.mime || 'image/webp' }))
      thumbUrl.value = thumbObjectUrl.value
      thumbError.value = ''
      thumbVia.value = 'api'
      return
    }
    thumbUrl.value = ''
    thumbVia.value = ''
    thumbError.value = thumb.message || '印面縮略圖讀取失敗'
    return
  }
  /* 存量 / 非源面容器：**原生解碼**（非 TIFF 的存儲件瀏覽器可直接解 ⇒ 不經 api）。 */
  const native = await seals.loadImageDataUrl(imageId)
  if (native.ok) {
    revokeThumb()
    thumbUrl.value = native.dataUrl
    thumbError.value = ''
    thumbVia.value = 'native'
  } else {
    thumbUrl.value = ''
    thumbVia.value = ''
    thumbError.value = native.message || '印面縮略圖讀取失敗'
  }
}

const thumbObjectUrl = ref('')
function revokeThumb() {
  if (thumbObjectUrl.value) {
    URL.revokeObjectURL(thumbObjectUrl.value)
    thumbObjectUrl.value = ''
  }
}

onMounted(loadThumb)
/* 換卡（或該卡的對象鍵變了）⇒ 重取封面；`stamp_id` 只作本機形態的換卡判據。 */
watch(() => [props.seal.stamp_id, sealCards.coverKeyOf(props.seal)], loadThumb)
onBeforeUnmount(revokeThumb)
</script>

<template>
  <article class="seal-card">
    <router-link class="seal-card__thumb" :to="{ name: 'seal-detail', params: { id: seal.stamp_id } }">
      <!-- 縮略圖 = **單件**（規範 §3.27.6：256 長邊單件 WebP、不經切分內核）。
           卡片形態：`thumb_key` → `display_key` → 本地占位圖（三級回落，`@error` 是**運行時**那一半）；
           本機形態：TIFF 存儲件走縮略面（`POST /api/image/thumb`）、存量 / 非 TIFF 走原生解碼。
           `data-thumb-face` ＝ 本次縮略件的來源面別機械讀數
           （卡片形態 `object` / `fallback` / `placeholder`；本機形態 `api` / `native`）。 -->
      <img
        v-if="thumbUrl"
        class="seal-card__thumb-img"
        :src="thumbUrl"
        :alt="`${currentText}印面縮略圖`"
        :data-thumb-face="thumbVia || null"
        @error="onCoverImageError"
      />
      <template v-else>
        <span class="seal-card__thumb-glyph">{{ glyph }}</span>
        <span class="seal-card__thumb-cap">{{ thumbError || (thumbBusy ? '封面載入中' : '印面縮略圖') }}</span>
      </template>
    </router-link>

    <div class="seal-card__body">
      <div class="seal-card__tags">
        <span class="seal-card__tag seal-card__tag--era">{{ seal.dynasty }}</span>
        <span class="seal-card__tag">{{ contentTag }}</span>
        <span v-if="isMultiFace" class="seal-card__tag seal-card__tag--multi">多面</span>
      </div>

      <h3 class="seal-card__title">
        <router-link :to="{ name: 'seal-detail', params: { id: seal.stamp_id } }">
          {{ currentText }}
        </router-link>
      </h3>

      <dl class="seal-card__meta">
        <div>
          <dt>當前印文</dt>
          <dd>{{ currentText }}</dd>
        </div>
        <div>
          <dt>作者</dt>
          <dd>{{ authorName }}</dd>
        </div>
        <div>
          <dt>編號</dt>
          <dd>{{ seal.stamp_id }}</dd>
        </div>
      </dl>
    </div>

    <div class="seal-card__foot">
      <router-link class="btn btn--ghost" :to="{ name: 'seal-detail', params: { id: seal.stamp_id } }">
        查看詳情
      </router-link>
      <!-- 保存入口①：卡片内一键式按钮（v1.21 新增｜规范 §3.21.4 / §3.21.11）。
           未登錄点击由 `SquareView` 给逐字引导并跳 `/login`（带 `redirect`）。
           本按钮属**普通用户入口**，**不挂** `data-admin-action`（两族职责分开）。 -->
      <button
        class="btn btn--ghost"
        type="button"
        data-drive-action="save-seal"
        @click="emit('save', seal)"
      >
        存入雲盤
      </button>
      <button
        class="btn btn--primary"
        type="button"
        @click="emit('download', seal)"
      >
        下載高清原圖
      </button>
    </div>
  </article>
</template>

<style scoped>
.seal-card {
  display: flex;
  flex-direction: column;
  background: var(--slot-card-bg);
  border: 1px solid var(--slot-card-line);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.seal-card:hover {
  box-shadow: var(--shadow-2);
}

.seal-card__thumb {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 4 / 3;
  background: var(--slot-card-seal-bg);
  border-bottom: 1px solid var(--slot-card-thumb-line);
}

.seal-card__thumb-glyph {
  font-family: var(--font-seal);
  font-size: 62px;
  line-height: 1;
  color: var(--slot-card-seal-text);
  border: 3px solid var(--slot-card-seal-stroke);
  border-radius: var(--r-sm);
  padding: var(--s-4) var(--s-5);
}

/* 縮略圖鋪滿縮略圖區（單件：整張縮略件等比縮放，不做塊化）。 */
.seal-card__thumb-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.seal-card__thumb-cap {
  position: absolute;
  bottom: var(--s-2);
  right: var(--s-3);
  color: var(--slot-card-meta-text);
  font-size: var(--t-xs);
}

.seal-card__body {
  flex: 1 1 auto;
  padding: var(--s-4);
}

.seal-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}

.seal-card__tag {
  padding: 1px var(--s-2);
  border: 1px solid var(--slot-chip-line);
  border-radius: var(--r-sm);
  color: var(--slot-chip-text);
  font-size: var(--t-xs);
}

.seal-card__tag--era {
  background: var(--slot-chip-active-bg);
  color: var(--slot-chip-active-text);
  border-color: var(--slot-chip-active-bg);
}

.seal-card__tag--multi {
  color: var(--slot-gold-text);
  border-color: var(--slot-gold-line);
  background: var(--slot-gold-bg);
}

.seal-card__title {
  margin-bottom: var(--s-3);
  font-size: var(--t-lg);
  color: var(--slot-card-title-text);
}

.seal-card__meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  font-size: var(--t-sm);
}

.seal-card__meta div {
  display: flex;
  gap: var(--s-3);
}

.seal-card__meta dt {
  flex: 0 0 62px;
  color: var(--slot-card-meta-text);
}

.seal-card__meta dd {
  margin: 0;
  color: var(--slot-card-title-text);
}

.seal-card__foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4) var(--s-4);
}

.seal-card__foot > * {
  flex: 1 1 0;
}
</style>
