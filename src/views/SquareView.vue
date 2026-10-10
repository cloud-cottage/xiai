
<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FilterBar from '../components/FilterBar.vue'
import SealCard from '../components/SealCard.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import UploadSealDialog from '../components/UploadSealDialog.vue'
import SealFolderPicker from '../components/SealFolderPicker.vue'
import { seals, corrections, points, imageFaces } from '../services/index.js'
import { DYNASTY_OPTIONS, FACE_CONTENT_OPTIONS, FACE_STYLE_OPTIONS, SEAL_CLASS_OPTIONS } from '../data/seed.js'
import { isLoggedIn } from '../data/session.js'
import { saveLocalBinary } from '../utils/file.js'

const route = useRoute()
const router = useRouter()

const logged = isLoggedIn
const dynasty = computed(() => (typeof route.query.dynasty === 'string' ? route.query.dynasty : ''))
/* 四维度筛选（R-34）：朝代 / 印面内容（`seal_type`）/ 印面风格（`face_style`）/ **大類（`seal_class`）**。
   URL 参数名与**服务层参数名逐字一致**（`content` / `style` / `sealClass`），便于取证与分享链接。 */
const content = computed(() => (typeof route.query.content === 'string' ? route.query.content : ''))
const style = computed(() => (typeof route.query.style === 'string' ? route.query.style : ''))
/* **大類**（第 4 维度，与前三者并列）：`seal_class` 是**印面级**键（无回落）。 */
const sealClass = computed(() => (typeof route.query.sealClass === 'string' ? route.query.sealClass : ''))
const keyword = computed(() => (typeof route.query.q === 'string' ? route.query.q.trim() : ''))

/* 任何一次写入后 +1，使下面的派生读数立即重算（服务层读的是已落盘数据）。 */
const dataVersion = ref(0)

/* 管理员专属「上传印章」按钮：以服务层判定为准（普通用户 / 游客为 false ⇒ 不渲染）。 */
const canUploadSeal = computed(() => seals.canUploadSeal())

const allSeals = computed(() => {
  void dataVersion.value
  return seals.listSeals()
})
const list = computed(() => {
  void dataVersion.value
  /* 参数名**逐字** `content` / `style` / `sealClass`（取代旧 `sealType`）；筛选**按印面聚合**由服务层实现。 */
  return seals.listSeals({ dynasty: dynasty.value, content: content.value, style: style.value, sealClass: sealClass.value, keyword: keyword.value })
})
/* **硬導航首屏（同一類終態缺陷，見 SealDetailView 的同名處理）**：直接打開 / 刷新廣場時，
   雲端快照尚未落定 ⇒ `list` 必為空。此刻渲染「沒有符合條件的印章」等於把「還沒讀到」
   說成「沒有」⇒ 讀數據層的數據源讀數，`pending` 時渲染**載入態**。 */
const dataSource = computed(() => seals.dataSourceState())
const hydrating = computed(() => !list.value.length && dataSource.value.pending)
/* **O-1（本單）**：雲端讀取失敗 ⇒ 數據層已回落**本機示範資料**（`readCollection` 的非 ready 分支）。
   此刻廣場照樣列出 8 行示範資料 —— **不得靜默**：顯式告知目前看的是示範資料，並給重試入口。
   判據只讀數據層狀態（`failed`），不猜、不自造第二套狀態機。 */
const demoFallback = computed(() => dataSource.value.failed)

function retryDataSource() {
  void seals.retryDataSource()
}
/* ============================================================================
   筛选条四维度值集（R-21 / R-30 / R-31 / R-34）
   ----------------------------------------------------------------------------
   四维度＝① 朝代 `dynasty`（DYNASTY_OPTIONS 15 类）② 印面内容 `seal_type`
   （FACE_CONTENT_OPTIONS 9 类）③ 印面风格 `face_style`（FACE_STYLE_OPTIONS 23 类）
   ④ **大類 `seal_class`（SEAL_CLASS_OPTIONS 3 类，印面级、无回落）**。
   值集口径统一为「**真源常量（规范顺序、在前）＋ 库内旧值（去重、追加于后）**」：
   只列真源 ⇒ 旧值（`漢` / `吉語印` / 既有行的 face_style）筛不到；只列库内派生值 ⇒
   真源里的空类无选项。**选项值一律不自造**，旧值只从已落盘数据里取。
   形制（`shape`）**不参与筛选**（印章级固定属性；规范明示不参与）。
   筛选**按印面聚合**由服务层实现，本页只传参。
   ============================================================================ */
const DYNASTY_LISTED = Array.isArray(DYNASTY_OPTIONS) ? DYNASTY_OPTIONS.filter(Boolean) : []
const FACE_CONTENT_LISTED = Array.isArray(FACE_CONTENT_OPTIONS) ? FACE_CONTENT_OPTIONS.filter(Boolean) : []
const FACE_STYLE_LISTED = Array.isArray(FACE_STYLE_OPTIONS) ? FACE_STYLE_OPTIONS.filter(Boolean) : []
/* 大類的 3 值**引真源 `SEAL_CLASS_OPTIONS`**（不硬编码副本）。 */
const SEAL_CLASS_LISTED = Array.isArray(SEAL_CLASS_OPTIONS) ? SEAL_CLASS_OPTIONS.filter(Boolean) : []

/* 真源常量缺位 ⇒ **可读降级提示**（不静默；也不拿库内派生值冒充完整值集）。 */
const FILTER_DEGRADED = computed(() => {
  const missing = []
  if (!FACE_CONTENT_LISTED.length) missing.push('印面內容（FACE_CONTENT_OPTIONS）')
  if (!FACE_STYLE_LISTED.length) missing.push('印面風格（FACE_STYLE_OPTIONS）')
  if (!SEAL_CLASS_LISTED.length) missing.push('大類（SEAL_CLASS_OPTIONS）')
  return missing.length
    ? `篩選選項模塊未就緒：${missing.join('、')} 的真源常量不可用，相應維度的完整值集暫不可用，請稍後重試。`
    : ''
})

/** 库内旧值：印章视图模型上的镜像值 ＋ **每个印面自身**的值（去重）。 */
function inStoreValues(pick) {
  const out = []
  allSeals.value.forEach((item) => {
    const direct = pick(item)
    if (direct) out.push(String(direct))
    const faces = Array.isArray(item.faces) ? item.faces : []
    faces.forEach((face) => {
      const value = pick(face)
      if (value) out.push(String(value))
    })
  })
  return [...new Set(out)]
}

/** 真源（在前、保持规范顺序）＋ 库内旧值（去重、追加于后）。 */
function unionOptions(listed, inStore) {
  const seen = new Set(listed)
  return [...listed, ...inStore.filter((value) => !seen.has(value))]
}

const dynasties = computed(() => unionOptions(DYNASTY_LISTED, inStoreValues((row) => row.dynasty)))
const contents = computed(() => unionOptions(FACE_CONTENT_LISTED, inStoreValues((row) => row.seal_type)))
const styles = computed(() => unionOptions(FACE_STYLE_LISTED, inStoreValues((row) => row.face_style)))
/* 大類：真源 3 值在前 ＋ 库内旧值（印面级 `seal_class`，无回落）追加。 */
const sealClasses = computed(() => unionOptions(SEAL_CLASS_LISTED, inStoreValues((row) => row.seal_class)))

const pendingSeal = ref(null)
const feedback = ref('')

const uploadOpen = ref(false)
const uploadFeedback = ref('')
const uploadedSeal = ref(null)

function onSealUploaded(result) {
  uploadOpen.value = false
  uploadFeedback.value = result.message
  uploadedSeal.value = result.ok ? result : null
  dataVersion.value += 1
}

const downloadCost = points.DOWNLOAD_COST
/* 下載面的機械讀數（**不上屏技術標識**：以 `data-*` 屬性承載，供取證 / 自證讀取）。 */
const downloadReport = ref(null)
const downloadBusy = ref(false)
const quote = computed(() => {
  if (!pendingSeal.value) return null
  return points.quoteDownload(pendingSeal.value.stamp_id, points.downloadSessionKey())
})
const quoteDetail = computed(() => {
  if (!quote.value) return ''
  if (quote.value.charged) {
    return `本次會話已爲該印章計費，不再扣除金，當前金餘額 ${quote.value.balance} 金。`
  }
  if (!quote.value.ok) {
    return `金餘額不足：下載需要 ${downloadCost} 金，當前 ${quote.value.balance} 金。`
  }
  return `當前金餘額 ${quote.value.balance} 金，確認後剩餘 ${quote.value.balance - downloadCost} 金。`
})

function applyQuery(patch) {
  const nextDynasty = 'dynasty' in patch ? patch.dynasty : dynasty.value
  const nextContent = 'content' in patch ? patch.content : content.value
  const nextStyle = 'style' in patch ? patch.style : style.value
  const nextSealClass = 'sealClass' in patch ? patch.sealClass : sealClass.value
  const query = {}
  if (keyword.value) query.q = keyword.value
  if (nextDynasty) query.dynasty = nextDynasty
  if (nextContent) query.content = nextContent
  if (nextStyle) query.style = nextStyle
  if (nextSealClass) query.sealClass = nextSealClass
  router.replace({ name: 'square', query })
}

function resetFilter() {
  applyQuery({ dynasty: '', content: '', style: '', sealClass: '' })
}

function askDownload(seal) {
  feedback.value = ''
  if (!logged.value) {
    feedback.value = '登錄後可下載高清原圖；同一枚印章每次會話只扣費一次。'
    router.push({ name: 'login', query: { redirect: `/seal/${seal.stamp_id}` } })
    return
  }
  pendingSeal.value = seal
}

/* ============================================================================
   下載面（「下載高清原圖」｜规范 §3.26 / §3.24.3 ②）
   ----------------------------------------------------------------------------
   产物 ＝ **存儲件的原字節直出**（`image/tiff`；不加水印；不經切分內核；零轉碼 ⇒ byte-verbatim）；
   經 `imageFaces.downloadOriginalFor` 取得（主印面影像 ⇒ 存儲件字節 ⇒ 原字節面端點）。
   **權限與扣費流程不變**：仍走 `points.chargeSealDownload` 的會話計費（同一枚印章同一次會話
   只扣一次）——扣費通過後才取件；取件失敗時**不再扣費**且留在對話框內可直接重試。
   ============================================================================ */
async function confirmDownload() {
  const sealRow = pendingSeal.value
  if (!sealRow || downloadBusy.value) return
  const result = points.chargeSealDownload(sealRow.stamp_id, points.downloadSessionKey(), sealRow.seal_name)
  if (!result.ok) {
    feedback.value = result.message
    pendingSeal.value = null
    return
  }
  downloadBusy.value = true
  const out = await imageFaces.downloadOriginalFor(sealRow.stamp_id)
  downloadBusy.value = false
  downloadReport.value = out.report
  feedback.value = out.message
  if (out.ok) {
    /* 字節原樣落盤（`saveLocalBinary` 不做任何轉碼 / 加水印）。 */
    saveLocalBinary(out.filename, out.bytes, out.mime)
    pendingSeal.value = null
  }
  /* 失敗 ⇒ 對話框保持打開：本次會話已計費，重試不再扣費（不得重複扣費 / 不得產生重複行）。 */
}

/* ============================================================================
   保存入口①（廣場卡片内，v1.21 新增｜规范 §3.21.4 / §3.21.11 / §3.21.12）
   ----------------------------------------------------------------------------
   未登錄点击 ⇒ **给逐字引导**（§3.21.12 第 14 行）**并跳 `/login` 带 `redirect`**
   —— 不静默失败；登錄点击 ⇒ 打开轻量选择器（**必经选择器，不静默存入**）。
   卡片内的按钮**恒渲染**（未登錄不隐藏、不 `disabled` 冒充），故判据面与登录态无关。
   ============================================================================ */
const SAVE_GUIDE = '登錄後即可把印章存入資料夾。'
const saveTarget = ref(null)

function askSaveSeal(seal) {
  feedback.value = ''
  if (!logged.value) {
    feedback.value = SAVE_GUIDE
    router.push({ name: 'login', query: { redirect: `/seal/${seal.stamp_id}` } })
    return
  }
  saveTarget.value = seal
}

/** 保存反馈由选择器内给出（成功 / 幂等 / 失败三类逐字）⇒ 此处只保留选择器打开态。 */
function onSealSaved() {}
</script>

<template>
  <section>
    <div class="page-head square__head">
      <div>
        <h1>璽印匯類</h1>
        <p>歷代印章與印面彙集於此，可按朝代、印面內容、印面風格與大類篩選，亦可查看印面詳情。</p>
      </div>
      <button
        v-if="canUploadSeal"
        class="btn btn--primary"
        type="button"
        data-admin-action="upload-seal"
        @click="uploadOpen = true"
      >
        上傳印章
      </button>
    </div>

    <div v-if="uploadFeedback" class="notice square__notice" data-admin-feedback="square-upload">
      <span>
        {{ uploadFeedback }}
        <template v-if="uploadedSeal">
          <router-link
            class="square__notice-link"
            :to="{ name: 'seal-detail', params: { id: uploadedSeal.id } }"
          >
            查看「{{ corrections.resolveSealDisplayName(uploadedSeal.seal) }}」
          </router-link>
        </template>
      </span>
    </div>

    <div v-if="feedback" class="notice square__notice" :data-download-report="downloadReport ? JSON.stringify(downloadReport) : null">
      <span>{{ feedback }}</span>
    </div>

    <FilterBar
      :dynasties="dynasties"
      :contents="contents"
      :styles="styles"
      :seal-classes="sealClasses"
      :dynasty="dynasty"
      :content="content"
      :style="style"
      :seal-class="sealClass"
      :total="list.length"
      :degraded="FILTER_DEGRADED"
      @update:dynasty="(value) => applyQuery({ dynasty: value })"
      @update:content="(value) => applyQuery({ content: value })"
      @update:style="(value) => applyQuery({ style: value })"
      @update:seal-class="(value) => applyQuery({ sealClass: value })"
      @reset="resetFilter"
    />

    <p v-if="keyword" class="square__keyword">當前檢索「{{ keyword }}」，共 {{ list.length }} 枚</p>

    <!-- **O-1**：雲讀失敗已回落本機示範資料 ⇒ 顯式提示 ＋ 重試入口（不靜默；字形同全站）。 -->
    <div v-if="demoFallback" class="notice square__notice" data-source-fallback="square">
      <span>雲端藏品資料暫時未能讀取，目前列出的是本機示範資料；可按「重新讀取」再試一次。</span>
      <button class="btn btn--ghost" type="button" @click="retryDataSource">重新讀取</button>
    </div>

    <!-- 縮略圖走**縮略面**（規範 §3.27.6：256 長邊**單件**、不經切分內核；卡片內不再按塊渲染）；
         存量 / 非 TIFF 存儲件仍由瀏覽器原生解碼顯示（存量面不得回歸）。 -->
    <div v-if="list.length" class="square__grid">
      <SealCard
        v-for="seal in list"
        :key="seal.stamp_id"
        :seal="seal"
        @download="askDownload"
        @save="askSaveSeal"
      />
    </div>

    <!-- **資料尚未到位 ⇒ 載入態**（水合未完成時不得顯示「沒有符合條件的印章」這類終態；
         水合落定後本元件自動重算並渲染真實結果）。 -->
    <PlaceholderPanel
      v-else-if="hydrating"
      glyph="候"
      title="正在讀取藏品資料"
      desc="雲端藏品資料載入中，就緒後會自動顯示；載入過慢時會自動重試一次。"
    />

    <PlaceholderPanel
      v-else
      glyph="覓"
      title="沒有符合條件的印章"
      desc="可調整朝代、印面內容、印面風格或大類，或清空檢索詞後再試。"
    />

    <ConfirmDialog
      v-if="pendingSeal"
      title="下載高清原圖"
      :message="`本次下載將扣除 ${downloadCost} 金；同一枚印章在本次會話內只扣費一次。`"
      :detail="quoteDetail"
      hint="本機存有原檔時直出原檔；雲端暫無原檔時交付展示檔並註明。"
      confirm-text="確認下載"
      @confirm="confirmDownload"
      @cancel="pendingSeal = null"
    />

    <UploadSealDialog
      v-if="uploadOpen"
      @close="uploadOpen = false"
      @uploaded="onSealUploaded"
    />

    <!-- 保存入口①的轻量选择器（**必经选择器**：点卡片按钮不直接存入任何夹）。 -->
    <SealFolderPicker
      v-if="saveTarget"
      :seal-id="saveTarget.stamp_id"
      :seal-name="saveTarget.seal_name"
      @close="saveTarget = null"
      @saved="onSealSaved"
    />
  </section>
</template>

<style scoped>
.square__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

.square__notice-link {
  color: var(--slot-gold-text);
  text-decoration: underline;
}
.square__notice {
  margin-bottom: var(--s-4);
}

.square__keyword {
  margin: var(--s-4) 0;
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.square__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--s-4);
  margin-top: var(--s-4);
}
</style>
