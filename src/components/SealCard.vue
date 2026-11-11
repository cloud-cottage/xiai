
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
   判據只看行上有沒有對象鍵，**不看登錄態 / 不猜數據源狀態**。
   ============================================================================ */
const cardMode = computed(() => sealCards.coverKeyOf(props.seal) !== '')
/** 標籤取值：卡片行用 `category`（＝印面內容）；本機行沿用 `seal_type`。 */
const contentTag = computed(() => String(props.seal.seal_type || props.seal.category || ''))
/** 「含邊款」判據：卡片行讀 `edge_count`；本機行沿用 `hasEdge`。 */
const hasEdge = computed(() => {
  if (props.seal.hasEdge === true) return true
  const edges = Number(props.seal.edge_count)
  return Number.isFinite(edges) && edges > 0
})
/** 主印面（**僅本機形態**查詢**；卡片形態下不查**，避免任何全量映射依賴）。 */
const face = computed(() => (cardMode.value ? null : seals.primaryFaceOf(props.seal.stamp_id)))
const thumbUrl = ref('')
const thumbError = ref('')
/** 縮略件的來源面別（機械讀數）：`object` ＝ 分頁行的對象鍵（thumb/display）；`api` ＝ 縮略面（256 長邊單件、不經切分內核）；`native` ＝ 本機原生解碼。 */
const thumbVia = ref('')
/** 封面取件中（卡片形態）：佔位字形照常顯示，不把「還沒到」說成「沒有」（不靜默成空態）。 */
const thumbBusy = ref(false)

/* ============================================================================
   縮略面（规范 §3.27.6 / §3.24.3 ②）
   ----------------------------------------------------------------------------
   縮略圖 ＝ **256 長邊單件**、**不經切分內核** ⇒ 卡片縮略圖走 **`POST /api/image/thumb`**
   （由服務端從**源字節**轉出），**不再**在卡片上按塊切分渲染。
   **存量舊 8 色索引 PNG（及一切非 TIFF 容器）仍走瀏覽器原生解碼、絕不過 api**
   （服務端來源門對非 TIFF 結構化拒絕 ⇒ 舊行必須仍由原生解碼顯示，不得回歸）。
   ============================================================================ */
async function loadThumb() {
  /* **卡片形態（本單）**：封面只取 `thumb_key`（缺 ⇒ `display_key`）對應的對象臨時鏈接。
     不查主印面、不讀本機影像庫 ⇒ 與全量水合解耦（首屏 48 枚不必等 11,800 行落定）。 */
  if (cardMode.value) {
    revokeThumb()
    thumbBusy.value = true
    thumbUrl.value = ''
    thumbError.value = ''
    thumbVia.value = ''
    const cover = await sealCards.cardCoverUrl(props.seal)
    thumbBusy.value = false
    if (cover.ok) {
      thumbUrl.value = cover.url
      thumbVia.value = 'object'
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
           TIFF 存儲件 ⇒ 走縮略面（`POST /api/image/thumb`）；存量 / 非 TIFF ⇒ 本機原生解碼。
           `data-thumb-face` ＝ 本次縮略件的來源面別（`api` / `native`）機械讀數。 -->
      <img
        v-if="thumbUrl"
        class="seal-card__thumb-img"
        :src="thumbUrl"
        :alt="`${currentText}印面縮略圖`"
        :data-thumb-face="thumbVia || null"
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
        <span v-if="hasEdge" class="seal-card__tag seal-card__tag--edge">含邊款</span>
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

.seal-card__tag--edge {
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
