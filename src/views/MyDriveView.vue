
<script setup>
/**
 * 【我的雲盤】页（**卡片矩陣（5 × 10 ＝ 50 位）＋ 資料夾彈窗**｜v1.22 改版｜K-2 追加）。
 *
 * 依据：规范 §3.21.2（第 5 项菜单的落地页）＋ §3.21.3（资料来源夹：引用式 / 一印章多夹 /
 * 夹内按加入时间倒序 / 编号 `SL` ＋ 9 位）＋ §3.21.5（分享入口）＋ §3.21.11（钩子族）
 * ＋ §3.21.12（逐字文案表）。
 * 契约：**只消费 `services/drive.js` / `services/seals.js` / `services/sealCards.js`**
 * （本视图不直接 import `../data/*`，也不读写任何浏览器存储；缩略图二进制经服务层取回）。
 *
 * 本版落点（清单面改版；夹内页 `?folder=<id>` 行为一字未改）：
 *   - 清单 ＝ **卡片矩陣**：每行 5 张、共 10 行（50 位），不足**留空位**；
 *   - 每卡 ＝ 该夹「最新加入的 9 枚」印章主印面缩略图（3 × 3 九宮格）＋ 名稱 / 枚数 / 分享徽标；
 *   - 点卡片 ⇒ **彈窗**（`role="dialog"` ＋ `useEscToClose`）＝ 现有全部操作：改名（本版新增）/
 *     分享（`ShareDialog` 的生成 / 重新生成）/ 夾内印章网格 ＋ 移出 / 打開資料夾；
 *   - 封面：**每页一次**批量 `listSealCovers`（`{stamp_ids}`）取 `thumb_key`，对象键 → URL
 *     的换算**仍只在** `services/sealCards.js::cardCoverUrl`（不新造取图通道）；
 *     九宮格按卡**懒加载**（IntersectionObserver ＋ 全页并发 ≤ 6）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TextTransformButtons from '../components/TextTransformButtons.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { drive, seals, corrections, sealCards } from '../services/index.js'
import { currentUser } from '../data/session.js'
import { useEscToClose } from '../utils/useEscToClose.js'

const route = useRoute()
const router = useRouter()

/** 任何一次写入后 +1，使下面的派生读数立即重算（服务层读的是已落盘数据）。 */
const version = ref(0)

const folderId = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : ''))

/* ------------------------------ 卡片矩陣骨架 ------------------------------ */

/** 矩陣列數 / 行數（**5 × 10 ＝ 50 位**；不足留空位）。 */
const MATRIX_COLUMNS = 5
const MATRIX_ROWS = 10
const MATRIX_SLOTS = MATRIX_COLUMNS * MATRIX_ROWS

/** 九宮格位數（3 × 3）—— 取服务层常量，不在页面硬编码 9。 */
const COVER_SLOTS = drive.FOLDER_COVER_SLOTS

/** 封面的全页并发上限（九宮格懒加载时不得超过）。 */
const COVER_CONCURRENCY = 6

/* ------------------------------ 资料夹清单 ------------------------------ */

const listing = computed(() => {
  void version.value
  return drive.listMyFolders()
})
const folders = computed(() => (listing.value.ok ? listing.value.rows : []))
const listingDegraded = computed(() =>
  listing.value.ok ? '' : `資料夾清單暫不可用：${listing.value.message}`
)
const listingEmpty = computed(() => listing.value.ok && folders.value.length === 0)

/** 50 个位：前 N 位放資料夾，余下留空（空位仍占格 ⇒ 5 × 10 不塌）。 */
const matrixSlots = computed(() => {
  const rows = folders.value
  const slots = []
  for (let index = 0; index < MATRIX_SLOTS; index += 1) {
    slots.push({ index, folder: rows[index] || null })
  }
  return slots
})

/* ------------------------------ 分享徽标（一次读盘） ------------------------------ */

const shareBadges = computed(() => {
  void version.value
  const ids = folders.value.map((row) => row.id)
  if (ids.length === 0) return {}
  const out = drive.folderShareBadges(ids)
  return out.ok ? out.by_folder : {}
})

function badgeOf(id) {
  return shareBadges.value[id] || { state: 'UNKNOWN', code: '', count: 0, text: '未分享' }
}

/* ------------------------------ 封面：最新 9 枚 ＋ 一次批量取键 ------------------------------ */

const coverPlan = computed(() => {
  void version.value
  return drive.myFolderCoverPlan(COVER_SLOTS)
})

/** `stamp_id ⇒ thumb_key`（批量接口回包的行；取不到就是没这一键）。 */
const coverKeys = ref({})
/** `stamp_id ⇒ 对象临时链接`（`''` ＝ 这一格取不到图，渲染浅色空格、不阻断卡片）。 */
const coverUrls = ref({})
const coverFailed = ref({})
const coverError = ref('')
const coverBusy = ref(false)

/** 该夹「最新加入的 9 枚」的 `seal_id`（时间倒序；口径见 `drive.latestStampIdsByFolder`）。 */
function coversOfFolder(id) {
  const plan = coverPlan.value
  if (!plan || !plan.ok) return []
  return plan.by_folder[id] || []
}

function coverStampIdOf(id, index) {
  return coversOfFolder(id)[index] || ''
}

function coverUrlOf(id, index) {
  const stampId = coverStampIdOf(id, index)
  return stampId ? coverUrls.value[stampId] || '' : ''
}

/* 并发闸门（≤ 6）：封面取链全部经此排队，50 卡 × 9 格不会一次性全拉。 */
let activeJobs = 0
const jobQueue = []

function pump() {
  while (activeJobs < COVER_CONCURRENCY && jobQueue.length > 0) {
    const job = jobQueue.shift()
    activeJobs += 1
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .then(() => {
        activeJobs -= 1
        pump()
      })
  }
}

function enqueueJob(job) {
  jobQueue.push(job)
  pump()
}

const pendingCovers = new Set()

/** 取一格封面（幂等：已成功 / 已在队列 ⇒ 直接返回）。
 *  **本單（四級回落）**：這一行**原樣**交給 `cardCoverUrl`（不再只抽 `thumb_key`）——
 *  台階 thumb → display → **原始件** → 佔位 全在服務層；今日 `listSealCovers` 的回包只帶
 *  `{stamp_id, thumb_key}` ⇒ 行為與改前逐字一致，雲端回包日後補 `display_key` / `original_*`
 *  鍵即自動獲得兜底（本頁零再改）。 */
function ensureCover(sealId) {
  if (!sealId) return
  if (coverUrls.value[sealId]) return
  if (pendingCovers.has(sealId)) return
  const row = coverKeys.value[sealId] || null
  if (!row) return
  if (!sealCards.coverKeyOf(row) && !sealCards.originalDisplayKeyOf(row)) return
  pendingCovers.add(sealId)
  enqueueJob(async () => {
    const out = await sealCards.cardCoverUrl(row)
    pendingCovers.delete(sealId)
    const nextUrls = { ...coverUrls.value }
    nextUrls[sealId] = out.ok ? out.url : ''
    coverUrls.value = nextUrls
    if (!out.ok) {
      coverFailed.value = { ...coverFailed.value, [sealId]: out.message || '封面暫時無法顯示' }
    }
  })
}

function loadCoversFor(folderKey) {
  coversOfFolder(folderKey).forEach((sealId) => ensureCover(sealId))
}

/* 批量取键：**每页一次**（stamp_ids 去重全集）。回包到了再补已在视野内的卡片。 */
watch(
  () => (coverPlan.value && coverPlan.value.ok ? coverPlan.value.stamp_ids.join(',') : ''),
  async (signature) => {
    coverUrls.value = {}
    coverFailed.value = {}
    coverKeys.value = {}
    coverError.value = ''
    if (!signature) {
      coverBusy.value = false
      return
    }
    coverBusy.value = true
    const result = await drive.listSealCovers({ stamp_ids: coverPlan.value.stamp_ids })
    coverBusy.value = false
    if (!result.ok) {
      /* 接口报错**原样上屏**（无云端会话时预期为 `FORBIDDEN`）；卡片仍照常显示，只是九宮格留浅色空格。 */
      coverError.value = `封面縮略圖暫不可用：${result.message}`
      return
    }
    const next = {}
    result.rows.forEach((row) => {
      /* **整行留存**（本單）：多帶的鍵（`display_key` / `original_*`，雲端日後補）原樣進台階，
         今日只帶 `{stamp_id, thumb_key}` ⇒ 與改前逐字一致。 */
      next[row.stamp_id] = row
    })
    coverKeys.value = next
    visibleFolders.forEach((key) => loadCoversFor(key))
  },
  { immediate: true }
)

/* ------------------------------ 九宮格懒加载（IntersectionObserver） ------------------------------ */

const matrixRef = ref(null)
const visibleFolders = new Set()
let observer = null

function onIntersect(entries) {
  entries.forEach((entry) => {
    const key = entry.target.getAttribute('data-cover-folder')
    if (!key) return
    if (entry.isIntersecting) {
      visibleFolders.add(key)
      loadCoversFor(key)
      return
    }
    visibleFolders.delete(key)
  })
}

function observeCards() {
  if (!observer || !matrixRef.value) return
  matrixRef.value.querySelectorAll('[data-cover-folder]').forEach((el) => {
    const key = el.getAttribute('data-cover-folder')
    if (!key) return
    if (el.getAttribute('data-cover-observed') === '1') return
    el.setAttribute('data-cover-observed', '1')
    observer.observe(el)
  })
}

watch(
  () => folders.value.map((row) => row.id).join(','),
  async () => {
    await nextTick()
    observeCards()
  }
)

onMounted(() => {
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(onIntersect, { rootMargin: '200px 0px', threshold: 0.01 })
  }
  observeCards()
})

onBeforeUnmount(() => {
  if (observer) observer.disconnect()
  observer = null
  visibleFolders.clear()
  jobQueue.length = 0
})

/* ------------------------------ 资料夹页（`?folder=<id>`，行为未改） ------------------------------ */

const detail = computed(() => {
  void version.value
  if (!folderId.value) return null
  return drive.listFolderItems(folderId.value)
})
const items = computed(() => (detail.value && detail.value.ok ? detail.value.rows : []))
const detailDegraded = computed(() => {
  if (!detail.value || detail.value.ok) return ''
  return `資料夾內容暫不可用：${detail.value.message}`
})

/* 缩略图：二进制只经服务层取回（页面不碰任何浏览器存储）。 */
const thumbs = ref({})
const thumbErrors = ref({})

async function loadThumbs() {
  const next = {}
  for (const row of items.value) {
    const imageId = row.image_id ? String(row.image_id) : ''
    if (!imageId) continue
    const out = await seals.loadImageDataUrl(imageId)
    next[row.seal_id] = out.ok ? out.dataUrl : ''
    if (!out.ok) thumbErrors.value = { ...thumbErrors.value, [row.seal_id]: out.message }
  }
  thumbs.value = next
}

watch(
  () => [folderId.value, items.value.map((row) => row.seal_id).join(',')],
  () => {
    loadThumbs()
  },
  { immediate: true }
)

/* ------------------------------ 新建資料夾 ------------------------------ */

const creating = ref(false)
const folderName = ref('')
const formError = ref('')
const feedback = ref('')

function openCreate() {
  creating.value = true
  folderName.value = ''
  formError.value = ''
  feedback.value = ''
}

function cancelCreate() {
  creating.value = false
  folderName.value = ''
  formError.value = ''
}

function submitCreate() {
  if (!String(folderName.value || '').trim()) {
    formError.value = '請先填寫資料夾名稱。'
    return
  }
  const result = drive.createFolder(folderName.value)
  if (!result.ok) {
    formError.value = result.message || '新增資料夾失敗，請稍後再試。'
    return
  }
  formError.value = ''
  creating.value = false
  feedback.value = result.message
  version.value += 1
  /* 新建后**不再**直接进夹内页（本版清单是卡片矩陣）—— 新卡立即出现在矩陣首位。 */
}

/* ------------------------------ 进 / 出资料夹页 ------------------------------ */

function openFolder(id) {
  feedback.value = ''
  closingModal()
  router.replace({ name: 'my-drive', query: { folder: String(id) } })
}

function backToList() {
  feedback.value = ''
  router.replace({ name: 'my-drive' })
}

/* ------------------------------ 卡片彈窗 ------------------------------ */

const modalFolder = ref(null)
const renameValue = ref('')
const renameError = ref('')
const modalFeedback = ref('')
const modalSaving = ref(false)
const modalThumbs = ref({})

const modalDetail = computed(() => {
  void version.value
  if (!modalFolder.value) return null
  return drive.listFolderItems(modalFolder.value.id)
})
const modalItems = computed(() => (modalDetail.value && modalDetail.value.ok ? modalDetail.value.rows : []))
const modalDegraded = computed(() => {
  if (!modalDetail.value || modalDetail.value.ok) return ''
  return `資料夾內容暫不可用：${modalDetail.value.message}`
})

const modalOpen = computed(() => Boolean(modalFolder.value))

function openModal(row) {
  modalFolder.value = row
  renameValue.value = row.name
  renameError.value = ''
  modalFeedback.value = ''
  modalSaving.value = false
}

function closingModal() {
  modalFolder.value = null
  renameValue.value = ''
  renameError.value = ''
  modalFeedback.value = ''
  modalThumbs.value = {}
}

/** ESC ＝ 取消（全仓单点实现）：关弹窗、丢弃未提交的改名输入、零写请求。 */
useEscToClose({
  isActive: () => modalOpen.value,
  isBusy: () => modalSaving.value,
  onCancel: () => closingModal()
})

/* 彈窗内印章缩略图：同一服务层取回路径，逐枚排队（并发仍 ≤ 6）。 */
watch(
  () => [modalFolder.value && modalFolder.value.id, modalItems.value.map((row) => row.seal_id).join(',')],
  () => {
    if (!modalFolder.value) return
    const rows = modalItems.value
    const next = {}
    rows.forEach((row) => {
      const imageId = row.image_id ? String(row.image_id) : ''
      if (!imageId) return
      enqueueJob(async () => {
        const out = await seals.loadImageDataUrl(imageId)
        next[row.seal_id] = out.ok ? out.dataUrl : ''
        modalThumbs.value = { ...modalThumbs.value, ...next }
      })
    })
  },
  { immediate: true }
)

/* ------------------------------ 改名（本版新增能力） ------------------------------ */

function submitRename() {
  if (!modalFolder.value) return
  renameError.value = ''
  const result = drive.renameFolder(modalFolder.value.id, renameValue.value)
  if (!result.ok) {
    renameError.value = result.message || '改名失敗，請稍後再試。'
    return
  }
  modalFolder.value = { ...modalFolder.value, name: result.row.name, updated_at: result.row.updated_at }
  renameValue.value = result.row.name
  modalFeedback.value = result.message
  version.value += 1
}

/* ------------------------------ 移出資料夾 ------------------------------ */

/**
 * 移出（钩子 `remove-from-folder`）：**恰 ＝ 删那条引用行** —— 印章仍在藏品库中、
 * 其它资料夹的引用行不受影响（语义由 K-1 服务层保证；本页只给可见反馈）。
 */
function removeFromFolder(row, targetFolderId) {
  const result = drive.removeSealFromFolder(targetFolderId, row.seal_id)
  if (!result.ok) {
    feedback.value = '移出失敗，請稍後再試。'
    return
  }
  feedback.value = result.message
  modalFeedback.value = result.message
  version.value += 1
}

/* ------------------------------ 分享 ------------------------------ */

const shareTarget = ref(null)
const ownerId = computed(() => {
  const user = currentUser()
  return user ? user.id : ''
})
const shareIsOwner = computed(() =>
  Boolean(shareTarget.value && shareTarget.value.owner_user_id === ownerId.value)
)

function openShare(row) {
  shareTarget.value = row
}

function closeShare() {
  shareTarget.value = null
}

function onShareChanged() {
  version.value += 1
}
</script>

<template>
  <section>
    <div class="page-head drive__head">
      <div>
        <h1>我的雲盤</h1>
        <p>
          資料夾只存放印章的引用：存入不複製印章本體，移出只移出引用，印章仍在藏品庫中；
          同一個資料夾內的印章按加入時間倒序排列。
        </p>
      </div>
      <button
        class="btn btn--primary"
        type="button"
        data-drive-action="new-folder"
        @click="openCreate"
      >
        新增資料夾
      </button>
    </div>

    <p v-if="feedback" class="notice drive__notice" data-drive-feedback="my-drive">{{ feedback }}</p>
    <p v-if="listingDegraded" class="notice drive__notice" data-drive-degraded="my-drive">
      {{ listingDegraded }}
    </p>
    <p v-if="coverError" class="notice drive__notice" data-drive-degraded="covers">{{ coverError }}</p>
    <p v-if="detailDegraded" class="notice drive__notice" data-drive-degraded="folder">
      {{ detailDegraded }}
    </p>

    <!-- 新建資料夾（逐字标题 / 占位符 / 提交钮 / 校验；名稱旁复用既有三动作钮）。 -->
    <section v-if="creating" class="panel" data-drive-create="new-folder">
      <div class="panel__head">
        <h2>新增資料夾</h2>
      </div>
      <div class="panel__body">
        <div class="field">
          <label for="drive-new-folder-name">資料夾名稱</label>
          <input
            id="drive-new-folder-name"
            v-model="folderName"
            type="text"
            :maxlength="drive.FOLDER_NAME_MAX_LENGTH"
            placeholder="請輸入資料夾名稱（建議使用繁體字）"
          />
          <TextTransformButtons
            v-model="folderName"
            field-key="drive-new-folder-name"
            field-label="資料夾名稱"
          />
          <span v-if="formError" class="drive__error">{{ formError }}</span>
        </div>
        <div class="drive__form-foot">
          <button class="btn btn--ghost" type="button" @click="cancelCreate">取消</button>
          <button class="btn btn--primary" type="button" @click="submitCreate">新增</button>
        </div>
      </div>
    </section>

    <!-- 资料夹页（`?folder=<id>`）：夹内倒序清单 ＋ 枚数 ＋ 移出 ＋ 分享。 -->
    <template v-if="folderId && detail && detail.ok">
      <div class="drive__crumb">
        <button class="btn btn--ghost" type="button" @click="backToList">返回資料夾清單</button>
      </div>

      <section class="panel" data-drive-folder="detail">
        <div class="panel__head">
          <h2>{{ detail.folder.name }}</h2>
          <button
            class="btn btn--ghost"
            type="button"
            data-drive-action="share-folder"
            @click="openShare(detail.folder)"
          >
            分享
          </button>
        </div>
        <div class="panel__body">
          <p class="drive__count" data-drive-count="folder">共 {{ items.length }} 枚印章</p>
          <p class="drive__order" data-drive-order="folder">按加入時間倒序</p>

          <ul v-if="items.length" class="drive-items">
            <li v-for="row in items" :key="row.seal_id" class="drive-item" :data-seal-id="row.seal_id">
              <router-link
                class="drive-item__thumb"
                :to="{ name: 'seal-detail', params: { id: row.seal_id } }"
              >
                <img
                  v-if="thumbs[row.seal_id]"
                  class="drive-item__img"
                  :src="thumbs[row.seal_id]"
                  :alt="`${corrections.resolveSealDisplayName(row)}印面縮略圖`"
                  loading="lazy"
                />
                <span v-else class="drive-item__glyph">{{ (corrections.resolveSealDisplayName(row)).slice(0, 1) }}</span>
              </router-link>
              <div class="drive-item__body">
                <router-link
                  class="drive-item__name"
                  :to="{ name: 'seal-detail', params: { id: row.seal_id } }"
                >
                  {{ corrections.resolveSealDisplayName(row) }}
                </router-link>
                <span class="drive-item__meta">藏品編號 {{ row.seal_id }}</span>
              </div>
              <button
                class="btn btn--ghost"
                type="button"
                data-drive-action="remove-from-folder"
                :data-folder-id="detail.folder.id"
                :data-seal-id="row.seal_id"
                @click="removeFromFolder(row, detail.folder.id)"
              >
                移出資料夾
              </button>
            </li>
          </ul>

          <p v-else class="drive__empty" data-drive-empty="folder">這個資料夾還是空的。</p>
        </div>
      </section>
    </template>

    <!-- 资料夹清单（未选中资料夹时）：**卡片矩陣 5 × 10 ＝ 50 位**，不足留空位。 -->
    <section v-else class="panel" data-drive-folder="list">
      <div class="panel__head">
        <h2>我的資料夾</h2>
        <span class="drive-matrix__hint" data-drive-matrix="hint">
          共 {{ folders.length }} 個資料夾（矩陣 {{ MATRIX_COLUMNS }} × {{ MATRIX_ROWS }} ＝
          {{ MATRIX_SLOTS }} 位）
        </span>
      </div>
      <div class="panel__body">
        <div ref="matrixRef" class="drive-matrix" data-drive-matrix="grid">
          <article
            v-for="slot in matrixSlots"
            :key="slot.index"
            class="drive-matrix__slot"
          >
            <button
              v-if="slot.folder"
              class="drive-card"
              type="button"
              data-drive-action="open-folder-modal"
              :data-folder-id="slot.folder.id"
              :data-cover-folder="slot.folder.id"
              @click="openModal(slot.folder)"
            >
              <span class="drive-card__grid">
                <span
                  v-for="cell in COVER_SLOTS"
                  :key="cell"
                  class="drive-card__cell"
                  :data-cover-stamp="coverStampIdOf(slot.folder.id, cell - 1) || null"
                >
                  <img
                    v-if="coverUrlOf(slot.folder.id, cell - 1)"
                    class="drive-card__img"
                    :src="coverUrlOf(slot.folder.id, cell - 1)"
                    :alt="`${slot.folder.name}印面縮略圖`"
                    loading="lazy"
                  />
                </span>
              </span>
              <span class="drive-card__meta">
                <span class="drive-card__name">{{ slot.folder.name }}</span>
                <span class="drive-card__sub">
                  <span class="drive-card__count" :data-item-count="slot.folder.item_count">
                    {{ slot.folder.item_count }} 枚印章
                  </span>
                  <span
                    class="drive-card__badge"
                    :data-share-state="badgeOf(slot.folder.id).state"
                  >{{ badgeOf(slot.folder.id).text }}</span>
                </span>
              </span>
            </button>
            <div v-else class="drive-card drive-card--blank" data-drive-card="empty" aria-hidden="true"></div>
          </article>
        </div>

        <p v-if="listingEmpty" class="drive__empty" data-drive-empty="list">
          尚無資料夾，先新增一個資料夾吧。
          <button class="btn btn--primary drive__empty-act" type="button" @click="openCreate">
            新增資料夾
          </button>
        </p>
      </div>
    </section>

    <!-- 卡片彈窗：現有全部操作（改名 / 分享 / 移出 / 打開資料夾）。 -->
    <div
      v-if="modalFolder"
      class="drive-modal"
      data-drive-modal="folder"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-modal-title"
      @click.self="closingModal"
    >
      <div class="drive-modal__panel">
        <div class="drive-modal__head">
          <h2 id="drive-modal-title">{{ modalFolder.name }}</h2>
          <button class="btn btn--ghost" type="button" data-drive-action="close-folder-modal" @click="closingModal">
            關閉
          </button>
        </div>

        <div class="drive-modal__body">
          <p class="drive__count" data-drive-count="modal">共 {{ modalItems.length }} 枚印章</p>
          <p class="drive__order" data-drive-order="modal">按加入時間倒序</p>
          <p class="drive__order" data-drive-share-badge="modal">
            分享狀態：{{ badgeOf(modalFolder.id).text }}
          </p>

          <p v-if="modalFeedback" class="notice drive__notice" data-drive-feedback="modal">{{ modalFeedback }}</p>
          <p v-if="modalDegraded" class="notice drive__notice" data-drive-degraded="modal">{{ modalDegraded }}</p>

          <!-- 改名（僅擁有者可寫；服务层同判 `FORBIDDEN` ＋ 零写入）。 -->
          <div class="field drive-modal__rename" data-drive-rename="folder">
            <label for="drive-rename-folder">資料夾名稱（可改名）</label>
            <div class="drive-modal__rename-row">
              <input
                id="drive-rename-folder"
                v-model="renameValue"
                type="text"
                :maxlength="drive.FOLDER_NAME_MAX_LENGTH"
                placeholder="請輸入資料夾名稱（建議使用繁體字）"
              />
              <button class="btn btn--primary" type="button" data-drive-action="rename-folder" @click="submitRename">
                儲存名稱
              </button>
            </div>
            <TextTransformButtons v-model="renameValue" field-key="drive-rename-folder" field-label="資料夾名稱" />
            <span v-if="renameError" class="drive__error">{{ renameError }}</span>
          </div>

          <div class="drive-modal__acts">
            <button class="btn btn--ghost" type="button" data-drive-action="open-folder" @click="openFolder(modalFolder.id)">
              打開資料夾
            </button>
            <button
              class="btn btn--ghost"
              type="button"
              data-drive-action="share-folder"
              @click="openShare(modalFolder)"
            >
              分享
            </button>
          </div>

          <ul v-if="modalItems.length" class="drive-modal__items">
            <li
              v-for="row in modalItems"
              :key="row.seal_id"
              class="drive-modal__item"
              :data-seal-id="row.seal_id"
            >
              <router-link
                class="drive-modal__thumb"
                :to="{ name: 'seal-detail', params: { id: row.seal_id } }"
              >
                <img
                  v-if="modalThumbs[row.seal_id]"
                  class="drive-modal__img"
                  :src="modalThumbs[row.seal_id]"
                  :alt="`${corrections.resolveSealDisplayName(row)}印面縮略圖`"
                  loading="lazy"
                />
                <span v-else class="drive-modal__glyph">
                  {{ (corrections.resolveSealDisplayName(row)).slice(0, 1) }}
                </span>
              </router-link>
              <span class="drive-modal__name">{{ corrections.resolveSealDisplayName(row) }}</span>
              <button
                class="btn btn--ghost"
                type="button"
                data-drive-action="remove-from-folder"
                :data-folder-id="modalFolder.id"
                :data-seal-id="row.seal_id"
                @click="removeFromFolder(row, modalFolder.id)"
              >
                移出資料夾
              </button>
            </li>
          </ul>
          <p v-else class="drive__empty" data-drive-empty="modal">這個資料夾還是空的。</p>
        </div>
      </div>
    </div>

    <ShareDialog
      v-if="shareTarget"
      :folder="shareTarget"
      :is-owner="shareIsOwner"
      @close="closeShare"
      @changed="onShareChanged"
    />
  </section>
</template>

<style scoped>
.drive__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

.drive__notice {
  margin-bottom: var(--s-4);
}

.drive__crumb {
  margin-bottom: var(--s-3);
}

.drive__count {
  margin-bottom: var(--s-1);
  color: var(--c-text);
  font-size: var(--t-md);
}

.drive__order,
.drive-folder__meta,
.drive-item__meta {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.drive__empty {
  padding: var(--s-4);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.drive__empty-act {
  margin-left: var(--s-3);
}

.drive__error {
  display: block;
  margin-top: var(--s-1);
  color: var(--c-danger);
  font-size: var(--t-xs);
}

.drive__form-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}

/* ---- 卡片矩陣：每行 5 張、共 10 行（50 位；不足留空位） ---- */
.drive-matrix {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  grid-template-rows: repeat(10, minmax(0, auto));
  gap: var(--s-3);
}

.drive-matrix__hint {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.drive-matrix__slot {
  min-width: 0;
}

.drive-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  width: 100%;
  height: 100%;
  padding: var(--s-2);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  background: var(--c-surface);
  color: var(--c-text);
  text-align: left;
  cursor: pointer;
}

.drive-card:hover {
  border-color: var(--c-border-strong, var(--c-line));
}

.drive-card--blank {
  border-style: dashed;
  background: var(--c-surface-sunken);
  cursor: default;
}

.drive-card__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  gap: 2px;
  aspect-ratio: 1 / 1;
  width: 100%;
  background: var(--c-surface-sunken);
  border-radius: var(--r-sm);
  overflow: hidden;
}

.drive-card__cell {
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--slot-card-seal-bg, var(--c-surface-sunken));
}

.drive-card__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.drive-card__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.drive-card__name {
  font-size: var(--t-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-card__sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-1);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.drive-card__badge {
  padding: 0 var(--s-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  white-space: nowrap;
}

.drive-card__badge[data-share-state='ACTIVE'] {
  color: var(--c-success, var(--c-text));
}

@media (max-width: 720px) {
  .drive-matrix {
    gap: var(--s-1);
  }

  .drive-card {
    padding: var(--s-1);
  }

  .drive-card__name {
    font-size: var(--t-xs);
  }
}

/* ---- 彈窗 ---- */
.drive-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: var(--s-4);
  background: rgba(0, 0, 0, 0.45);
}

.drive-modal__panel {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: 88vh;
  overflow: hidden;
  background: var(--c-surface);
  border-radius: var(--r-lg, var(--r-md));
  box-shadow: var(--shadow-lg, 0 12px 40px rgba(0, 0, 0, 0.28));
}

.drive-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--c-line);
}

.drive-modal__body {
  padding: var(--s-4);
  overflow-y: auto;
}

.drive-modal__rename {
  margin-top: var(--s-3);
}

.drive-modal__rename-row {
  display: flex;
  gap: var(--s-2);
}

.drive-modal__acts {
  display: flex;
  gap: var(--s-2);
  margin: var(--s-3) 0;
}

.drive-modal__items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.drive-modal__item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--c-line);
}

.drive-modal__thumb {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  overflow: hidden;
  background: var(--slot-card-seal-bg, var(--c-surface-sunken));
  border: 1px solid var(--slot-card-thumb-line, var(--c-line));
  border-radius: var(--r-sm);
}

.drive-modal__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.drive-modal__glyph {
  font-family: var(--font-seal);
  font-size: var(--t-lg);
  color: var(--slot-card-seal-text, var(--c-text));
}

.drive-modal__name {
  flex: 1 1 auto;
  font-size: var(--t-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 夹内页（`?folder=`）沿用既有清单样式 ---- */
.drive-items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.drive-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--c-line);
}

.drive-item__thumb {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  overflow: hidden;
  background: var(--slot-card-seal-bg);
  border: 1px solid var(--slot-card-thumb-line);
  border-radius: var(--r-sm);
}

.drive-item__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.drive-item__glyph {
  font-family: var(--font-seal);
  font-size: var(--t-xl);
  color: var(--slot-card-seal-text);
}

.drive-item__body {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  flex: 1 1 auto;
}

.drive-item__name {
  color: var(--c-text);
  font-size: var(--t-md);
}
</style>
