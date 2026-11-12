
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FilterBar from '../components/FilterBar.vue'
import SealCard from '../components/SealCard.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import UploadSealDialog from '../components/UploadSealDialog.vue'
import SealFolderPicker from '../components/SealFolderPicker.vue'
/* **識別編碼精確查**（§5）：服務層單點（decode ⇒ 按 `no` 等值匹配；查無即「查無此印」）。
   編碼入口已上收**頁頭單框雙態搜索**（`HeaderSearch`）—— 本頁只按 `route.query.code` 精確查，
   不再另設獨立 OTP 控件（全站唯一入口，任何頁面可用、鏈接可分享）。 */
import { findSealByCode } from '../services/seals.js'
import { seals, corrections, points, imageFaces, sealCards } from '../services/index.js'
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

/* 任何一次写入后 +1，使下面的派生读数立即重算（服务层读的是已落盘数据）；
   列表侧同样依赖它 ⇒ 上傳 / 清除本機資料後自動**重置到首頁**重拉。 */
const dataVersion = ref(0)

/* 管理员专属「上传印章」按钮：以服务层判定为准（普通用户 / 游客为 false ⇒ 不渲染）。 */
const canUploadSeal = computed(() => seals.canUploadSeal())

/* ============================================================================
   **列表 ＝ 分頁消費 `listSealCards`（本單）**
   ----------------------------------------------------------------------------
   改前：`seals.listSeals()` 在渲染期同步全量組裝（雲端 11,800 行）⇒ 首屏實測 28〜42 秒。
   改後：
     · 首屏只請求 **48 枚**（`SQUARE_PAGE_SIZE`）；滾到底（`IntersectionObserver`，提前
       400px 預取）或按「載入更多」按 **`next_cursor` 續拉**；
     · 續拉觸發條件 ＝ `has_more === true` **且** `next_cursor` 非空 **且** 當前沒有在飛的
       請求（`moreBusy` / `pageLoading` 皆 false）；
     · 四維篩選（朝代 / 印面內容 / 印面風格 / 大類）與**關鍵詞 `q`** 一併**下推**為請求參數
       （映射表真源 ＝ `sealCards.SQUARE_FILTER_PARAMS`；請求恰 **7 鍵**），關鍵詞由服務端
       **全庫**檢索，不再客戶端過濾已載入的頁；
     · 篩選 / 關鍵詞變化或 `dataVersion` 變 ⇒ **重置到首頁**（丟掉舊游標與累積行）；
     · 封面圖取行上的 `thumb_key` / `display_key`（`SealCard` 負責）⇒ **不再依賴全量水合的
       seals / faces 映射**；
     · 無雲端 / 雲端讀失敗 ⇒ 服務層返回本機示範資料（`fallback:true`）＋ 本頁顯式提示。
   · **關鍵詞 `?q=` 仍由 URL 承載**（可分享、可後退）：`route.query.q` trim 後隨請求下推；
     上屏「共 N 枚」一律取服務端 `total`；**不得**再上屏任何「只覆已載入頁」的降級計數
     與其配套提示（規範 §3.81.7 / `AC-723` 判負面）。
   ============================================================================ */
const PAGE_SIZE = sealCards.SQUARE_PAGE_SIZE

/** 累積的卡片行（雲端回包的 14 鍵行 / 本機降級行）。 */
const cards = ref([])
/** 服務端不透明游標（本層不解析、不猜測）。 */
const nextCursor = ref('')
/** 續拉閘門：`has_more` 為真且游標非空才可續拉。 */
const hasMore = ref(false)
/** `total` 取自服務端（本機降級 ⇒ 本機命中總數）。 */
const totalCount = ref(0)
const pageLoading = ref(true)
const moreBusy = ref(false)
const pageError = ref('')
/** 本頁是否為「本機示範資料」兜底（與 `dataSource.failed` 分立：兩者都可能成立）。 */
const fallbackPage = ref(false)
/** 兜底原話（服務層透傳的 `message`；上屏只作補充，不替代既有提示文案）。 */
const fallbackDetail = ref('')
/** 請求代次：篩選連點 / 分頁並發時，**只認最後一代**的回包（丟掉過期結果）。 */
let requestGen = 0

/** 當前的四維篩選 ＋ 關鍵詞（視圖參數名；翻譯成請求參數由服務層單點負責）。 */
function filterArgs() {
  return {
    dynasty: dynasty.value,
    content: content.value,
    style: style.value,
    sealClass: sealClass.value,
    q: keyword.value
  }
}

/** 首屏 / 重置：清空游標與累積行，只拉第 1 頁。 */
async function loadFirstPage() {
  const gen = ++requestGen
  pageLoading.value = true
  moreBusy.value = false
  pageError.value = ''
  cards.value = []
  nextCursor.value = ''
  hasMore.value = false
  totalCount.value = 0
  fallbackPage.value = false
  fallbackDetail.value = ''
  const out = await sealCards.listSealCardPage({ ...filterArgs(), cursor: '', limit: PAGE_SIZE })
  if (gen !== requestGen) return
  pageLoading.value = false
  if (!out.ok) {
    pageError.value = out.message || '雲端藏品資料暫時未能讀取，請稍後再試。'
    return
  }
  cards.value = out.rows
  nextCursor.value = out.next_cursor
  hasMore.value = out.has_more && out.next_cursor !== ''
  totalCount.value = out.total
  fallbackPage.value = out.fallback === true
  fallbackDetail.value = out.fallback ? String(out.message || '') : ''
}

/** 續拉一頁（滾到底 / 「載入更多」同一執行點；並發去重、過期回包丟棄）。 */
async function loadMore() {
  if (!hasMore.value || !nextCursor.value || moreBusy.value || pageLoading.value) return
  const gen = requestGen
  const cursor = nextCursor.value
  moreBusy.value = true
  pageError.value = ''
  const out = await sealCards.listSealCardPage({ ...filterArgs(), cursor, limit: PAGE_SIZE })
  if (gen !== requestGen) return
  moreBusy.value = false
  if (!out.ok) {
    pageError.value = out.message || '載入更多藏品時失敗，請稍後再試。'
    return
  }
  /* 去重（同一 `stamp_id` 只上屏一張）：游標重疊 / 亂序時不漏不重，v-for 的 key 也不會撞。 */
  const seen = new Set(cards.value.map((row) => row.stamp_id))
  const fresh = out.rows.filter((row) => !seen.has(row.stamp_id))
  cards.value = cards.value.concat(fresh)
  nextCursor.value = out.next_cursor
  hasMore.value = out.has_more && out.next_cursor !== ''
  if (out.total > 0) totalCount.value = out.total
  if (out.fallback === true) {
    fallbackPage.value = true
    fallbackDetail.value = String(out.message || '')
  }
}

/* 篩選 / 關鍵詞變化、寫入後 ⇒ 重置到首頁（`q` 與四維篩選**同權**：游標清空、列表清空、
   重拉第 1 頁 —— 關鍵詞由服務端全庫檢索，**不在前端二次過濾**）。 */
watch(
  () => [dynasty.value, content.value, style.value, sealClass.value, keyword.value, dataVersion.value],
  () => { void loadFirstPage() },
  { immediate: true }
)

/* 滾到底自動續拉：哨兵元素常駐在網格之後；不支援 `IntersectionObserver` 的環境
   仍可用「載入更多」按鈕（同一執行點）。 */
const sentinel = ref(null)
let sentinelObserver = null
onMounted(() => {
  if (typeof IntersectionObserver !== 'function') return
  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    },
    { rootMargin: '400px 0px' }
  )
  if (sentinel.value) sentinelObserver.observe(sentinel.value)
})
watch(sentinel, (el, prev) => {
  if (!sentinelObserver) return
  if (prev) sentinelObserver.unobserve(prev)
  if (el) sentinelObserver.observe(el)
})
onBeforeUnmount(() => {
  if (sentinelObserver) sentinelObserver.disconnect()
  sentinelObserver = null
})

/* **列表 ＝ 服務端分頁 rows 原樣上屏**：關鍵詞 `q` 已下推為請求第 7 鍵（服務端全庫檢索）
   ⇒ 本層**不再做任何關鍵詞二次過濾**（`filter` / `slice` / `sort` 一律不加），
   「共 N 枚」一律取服務端 `total`。 */

/* **數據源狀態（只讀）**：仍用於「本機示範資料」提示與孤兒行計數，**不再驅動列表水合**。 */
const dataSource = computed(() => seals.dataSourceState())
const hydrating = computed(() => pageLoading.value)
/* **O-1（本單不變）**：雲端讀取失敗已回落本機示範資料 ⇒ 顯式告知 ＋ 重試入口（不靜默）。
   判據兩支：數據層狀態 `failed`，或本頁回包自帶 `fallback`（分頁路徑的失敗兜底）。 */
const demoFallback = computed(() => dataSource.value.failed || fallbackPage.value)

async function retryDataSource() {
  pageError.value = ''
  await seals.retryDataSource()
  await loadFirstPage()
}

/* ============================================================================
   一次性提示（刪印章後跳回廣場｜本單）
   ----------------------------------------------------------------------------
   载体 ＝ 路由 query `notice`（跳转时带上，**读后立即 replace 清除**）：
   ① 只消费一次（刷新 / 返回都不会再弹）；② **不新增全局状态库**（零 store、零持久层）。
   ============================================================================ */
const SQUARE_NOTICES = Object.freeze({
  'seal-deleted': '已刪除印章（編號已釋放）。',
  'local-db-cleared': '本機資料已清除（雲端資料不受影響）。'
})

/* ============================================================================
   識別編碼精確查（口径件 §5｜R-4）
   ----------------------------------------------------------------------------
   · 唯一入口 ＝ **頁頭單框雙態搜索**（`HeaderSearch.vue`：5 / 8 格、首字符自動判型、
     非法字符就地拒、退格至空復原）；本頁**不再渲染**獨立 OTP 控件。
   · 本頁只讀 `route.query.code` ⇒ 服務層 `findSealByCode` decode ⇒ **按 `no` 精確等值匹配**；
     查無 ⇒ `查無此印` **空態**，**絕不回落關鍵詞 `q`、絕不模糊匹配**。
   · 命中 ⇒ 就地 `replace` 直達該印章詳情（`stamp_id` 精確等值路由；R-6：舊碼不受理、
     不加兼容分支；`replace` 使返回鍵不會回到已命中的 `?code=` 頁、避免重導航迴環）。
   ============================================================================ */
const codeQuery = computed(() =>
  typeof route.query.code === 'string' ? route.query.code.trim().toUpperCase() : ''
)
/* 任何一次寫入後 +1 ⇒ 與列表同源重算（服務層讀的是已落盤數據）。 */
const codeLookup = computed(() => {
  void dataVersion.value
  if (!codeQuery.value) return null
  return findSealByCode(codeQuery.value)
})
const codeMiss = computed(() => !!codeLookup.value && !codeLookup.value.ok)
const codeMissDesc = computed(() => {
  const lookup = codeLookup.value
  if (!lookup || lookup.ok) return ''
  return lookup.reason === 'NOT_FOUND'
    ? '查無此印：請核對識別編碼後再試；本入口不會改用關鍵詞檢索，也不做近似匹配。'
    : lookup.message
})

/* `?code=` 落地（頁頭 OTP 提交 / 分享鏈接打開）⇒ 命中即直達詳情；查無則留在本頁顯示空態。
   **與數據層同源重算**：雲端快照是 `shallowRef`（`data/cloudbase.js`），`codeLookup` 讀它 ⇒ 依賴
   被自然追蹤 —— 水合**晚到**時本效應會再跑一次並補做直達（掛載時只查一次的 `watch` 會漏掉這一拍）。 */
watchEffect(() => {
  const lookup = codeLookup.value
  if (!lookup || !lookup.ok) return
  const nav = router.replace({ name: 'seal-detail', params: { id: lookup.seal.stamp_id } })
  /* 冗余導航（本就在目標頁）不製造未處理拒絕；非冗余導航的失敗仍由路由層失敗面承接。 */
  if (nav && typeof nav.catch === 'function') nav.catch(() => {})
})
/* ============================================================================
   筛选条四维度值集（R-21 / R-30 / R-31 / R-34）
   ----------------------------------------------------------------------------
   四维度＝① 朝代 `dynasty`（DYNASTY_OPTIONS 15 类）② 印面内容 `seal_type`
   （FACE_CONTENT_OPTIONS 9 类）③ 印面风格 `face_style`（FACE_STYLE_OPTIONS 23 类）
   ④ **大類 `seal_class`（SEAL_CLASS_OPTIONS 3 类，印面级、无回落）**。
   值集口径 ＝ **只列真源常量**（规范顺序）——**不再 ∪ 库内派生值**、**不生成 `UNKNOWN`
   一类占位项**（与 `UploadSealDialog.vue` / `SealDetailView.vue` 已废除 union 的形态
   **逐字同口径**）。真源缺位 ⇒ 沿用既有**可读降级提示**（不自造第二套常量，也不拿
   库内旧值冒充完整值集）。库内**真源外旧值**由**数据侧**一次性幂等迁移
   （管理员 op `migrateSealValueDomains`）收敛 ⇒ 不再靠上屏面兜底。
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

/* 四维度值集**只列真源**（旧值不外溢；库内真源外旧值走数据侧 `migrateSealValueDomains` 收敛）。 */
const dynasties = computed(() => DYNASTY_LISTED)
const contents = computed(() => FACE_CONTENT_LISTED)
const styles = computed(() => FACE_STYLE_LISTED)
const sealClasses = computed(() => SEAL_CLASS_LISTED)

const pendingSeal = ref(null)
const feedback = ref('')

/* 一次性提示的消费点（**放在 `feedback` 声明之后**：首拍同步执行时不得踩 TDZ）。 */
watchEffect(() => {
  const notice = typeof route.query.notice === 'string' ? route.query.notice : ''
  if (!notice || !Object.prototype.hasOwnProperty.call(SQUARE_NOTICES, notice)) return
  feedback.value = SQUARE_NOTICES[notice]
  const query = Object.assign({}, route.query)
  delete query.notice
  const nav = router.replace({ name: 'square', query })
  if (nav && typeof nav.catch === 'function') nav.catch(() => {})
})

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

/* ============================================================================ *
   **清除本機資料（管理員面）＋ 孤兒印章行提示（Kevin 2026-11-06）**
   ----------------------------------------------------------------------------
   · 入口只按服务层 `seals.canClearLocalData()` 渲染（非管理员 / 游客 ⇒ **不渲染**，
     不得 CSS 隐藏 / `disabled` 冒充）；钩子**只用** `data-action="local-db-clear"`
     （**不新增 `data-admin-action` 取值**，管理员钩子取值集合仍为规范冻结值）。
   · 二次确认文案**必须列明**：清空本機全部印章 / 印面 / 影像行与影像二进制、**不可恢复**、
     **雲端資料不受影響**（另点名保留登录会话 / 账号 / 主题）。
   · 成功 ⇒ **强制从云端重载**（`seals.retryDataSource()`）＋ 回广场带一次性提示
     `?notice=local-db-cleared`；失败 ⇒ **本页如实上屏**（不假报成功）。
   · 孤儿行提示：本机有、云端快照没有的印章行（计数真源＝数据层 `localOrphanSealReadout()`）
     ⇒ 顶部一行「本機有 N 枚印章不在雲端（已不再顯示）」＋同一入口按钮；**不渲染孤儿行**。
   ============================================================================ */
const canClearLocal = computed(() => seals.canClearLocalData())
/** 依赖面必须含**数据源状态**：云端水合晚到 / 重新加载后要重算（与 `list` 同源）。 */
const orphanReadout = computed(() => {
  void dataVersion.value
  void dataSource.value.state
  return seals.localOrphanSealReadout()
})
const orphanCount = computed(() => orphanReadout.value.count)
const clearOpen = ref(false)
const clearBusy = ref(false)

/** 二次确认主文案（**必须列明**：清空范围、不可恢复、云端不受影响）。 */
const CLEAR_MESSAGE =
  '將清空本機全部印章、印面與影像行、影像二進制，以及其餘本機資料行；清除後不可恢復，雲端資料不受影響（登錄會話、帳號與主題會保留）。'

function askClearLocal() {
  clearOpen.value = true
}

/** 确认清除：过服务层执行点；成功 ⇒ 强制从云端重载并回广场带一次性提示，失败 ⇒ 本页上屏。 */
async function confirmClearLocal() {
  if (clearBusy.value) return
  clearBusy.value = true
  let result = null
  try {
    result = await seals.clearLocalDatabase()
  } catch {
    result = { ok: false, messages: ['清除本機資料時發生未預期錯誤。'] }
  }
  clearBusy.value = false
  clearOpen.value = false
  if (!result || result.ok !== true) {
    /* **失败如实上屏**：取数据层 / 存储层原话，不假报成功。 */
    const detail = result && Array.isArray(result.messages) && result.messages.length ? `（${result.messages.join('；')}）` : ''
    feedback.value = `清除本機資料失敗，本次未完成清除。${detail}`
    return
  }
  dataVersion.value += 1
  /* **强制从云端重载**（清完必须重读云端，不拿本机残留充数）。 */
  void seals.retryDataSource()
  const nav = router.push({ name: 'square', query: { notice: 'local-db-cleared' } })
  if (nav && typeof nav.catch === 'function') nav.catch(() => {})
}
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
      <!-- 「清除本機資料」（管理员专属）：非管理员 / 游客 ⇒ **不渲染**（DOM 零命中；
           不得 CSS 隐藏 / `disabled` 冒充）。钩子只用 `data-action="local-db-clear"`
           （**不新增 `data-admin-action` 取值**，管理员钩子取值集合仍为规范冻结值）。 -->
      <button
        v-if="canClearLocal"
        class="btn btn--ghost"
        type="button"
        data-action="local-db-clear"
        @click="askClearLocal"
      >
        清除本機資料
      </button>
    </div>

    <!-- **孤兒印章行提示**（本機有、雲端快照沒有 ⇒ 已不再渲染，只提示＋給同一入口）。
         計數真源＝數據層覆蓋層；雲端未落定時計數為 0 ⇒ 本塊不渲染。 -->
    <div
      v-if="orphanCount > 0"
      class="notice square__notice"
      data-local-orphan="square"
    >
      <span>本機有 {{ orphanCount }} 枚印章不在雲端（已不再顯示）。</span>
      <button
        v-if="canClearLocal"
        class="btn btn--ghost"
        type="button"
        data-action="local-db-clear"
        @click="askClearLocal"
      >
        清除本機資料
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
      :total="totalCount"
      :degraded="FILTER_DEGRADED"
      @update:dynasty="(value) => applyQuery({ dynasty: value })"
      @update:content="(value) => applyQuery({ content: value })"
      @update:style="(value) => applyQuery({ style: value })"
      @update:seal-class="(value) => applyQuery({ sealClass: value })"
      @reset="resetFilter"
    />

    <!-- 識別編碼入口（§5｜R-4）：**已上收頁頭單框雙態搜索**（`HeaderSearch`），本頁不再另設入口。
         本頁只按 `route.query.code` 精確查、查無即空態，不回落關鍵詞 `q`、不模糊匹配。 -->

    <!-- **關鍵詞已下推服務端全庫檢索**（請求第 7 鍵 `q`）：「共 N 枚」一律取服務端 `total`，
         不再上屏「只覆已載入頁」的降級計數與其配套提示（規範 §3.81.7 / `AC-723`）。 -->
    <p v-if="keyword" class="square__keyword" data-square-keyword>
      當前檢索「{{ keyword }}」：共 {{ totalCount }} 枚
    </p>

    <!-- **O-1**：雲讀失敗已回落本機示範資料 ⇒ 顯式提示 ＋ 重試入口（不靜默；字形同全站）。 -->
    <div
      v-if="demoFallback"
      class="notice square__notice"
      data-source-fallback="square"
      :data-fallback-detail="fallbackDetail || null"
    >
      <span>雲端藏品資料暫時未能讀取，目前列出的是本機示範資料；可按「重新讀取」再試一次。</span>
      <button class="btn btn--ghost" type="button" @click="retryDataSource">重新讀取</button>
    </div>

    <!-- 讀取失敗（本機也沒有資料可兜底）⇒ **如實上屏原話 ＋ 重試**（不冒充「沒有符合條件的印章」）。 -->
    <div v-if="pageError" class="notice square__notice" data-square-error>
      <span>{{ pageError }}</span>
      <button class="btn btn--ghost" type="button" @click="retryDataSource">重新讀取</button>
    </div>

    <!-- 縮略圖走**縮略面**（規範 §3.27.6：256 長邊**單件**、不經切分內核；卡片內不再按塊渲染）；
         存量 / 非 TIFF 存儲件仍由瀏覽器原生解碼顯示（存量面不得回歸）。
         **本單**：雲端分頁行的封面改取 `thumb_key` / `display_key` 對應對象（見 `SealCard`）。 -->
    <!-- 識別編碼查無 ⇒ **明確空態「查無此印」**（不回落關鍵詞、不模糊匹配；描述取自服務層讀數）。 -->
    <PlaceholderPanel
      v-if="codeMiss"
      glyph="查"
      title="查無此印"
      :desc="codeMissDesc"
    />

    <div v-else-if="cards.length" class="square__grid">
      <SealCard
        v-for="card in cards"
        :key="card.stamp_id"
        :seal="card"
        @download="askDownload"
        @save="askSaveSeal"
      />
    </div>

    <!-- **資料尚未到位 ⇒ 載入態**（不得顯示「沒有符合條件的印章」這類終態）。 -->
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

    <!-- **分頁尾巴**：哨兵元素 ＝ 滾到底自動續拉的觀測點；「載入更多」按鈕走同一執行點
         （不支援 `IntersectionObserver` 時仍可用）。游標空 ⇒ 如實報「已全部載入」。 -->
    <div
      v-if="!codeMiss && cards.length"
      ref="sentinel"
      class="square__more"
      data-square-pager
      :data-square-has-more="hasMore ? '1' : '0'"
    >
      <span data-square-loaded>
        已載入 {{ cards.length }} / 共 {{ totalCount }} 枚
      </span>
      <button
        v-if="hasMore"
        class="btn btn--ghost"
        type="button"
        data-square-more
        :disabled="moreBusy"
        @click="loadMore"
      >
        {{ moreBusy ? '載入中…' : '載入更多' }}
      </button>
      <span v-else>已全部載入</span>
    </div>

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

    <!-- 「清除本機資料」二次确认（**必须列明**：清空范围、不可恢复、雲端資料不受影響）。
         默认不通过；确认走 `confirmClearLocal`（失败本页如实上屏、成功回广场带一次性提示）。 -->
    <ConfirmDialog
      v-if="clearOpen"
      title="清除本機資料"
      :message="CLEAR_MESSAGE"
      hint="此操作只影響本機瀏覽器裡的資料；清除後需重新從雲端載入。"
      confirm-text="確認清除"
      @confirm="confirmClearLocal"
      @cancel="clearOpen = false"
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

/* 分頁尾巴（已載入 / 共 N 枚 ＋ 「載入更多」）：與網格同列寬、居中；滾到底自動續拉的哨兵。 */
.square__more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  margin: var(--s-5) 0 var(--s-3);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}
</style>
