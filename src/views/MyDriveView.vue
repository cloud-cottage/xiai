
<script setup>
/**
 * 【我的雲盤】页（**資料夾清单 ＋ 资料夹页**｜v1.21 新增｜K-2）。
 *
 * 依据：规范 §3.21.2（第 5 项菜单的落地页）＋ §3.21.3（资料来源夹：引用式 / 一印章多夹 /
 * 夹内按加入时间倒序 / 编号 `SL` ＋ 9 位）＋ §3.21.5（分享入口）＋ §3.21.11（钩子族）
 * ＋ §3.21.12（逐字文案表）。
 * 契约：**只消费 K-1 的 `services/drive.js` 与 `services/seals.js`**（本视图不直接
 * import `../data/*`，也不读写任何浏览器存储；缩略图二进制经服务层取回）。
 *
 * 落点分解（本页只做「清单 ＋ 资料夹页」；选择器归 `SealFolderPicker.vue`、分享弹窗归
 * `ShareDialog.vue`）：
 *   - 清单空态逐字「尚無資料夾，先新增一個資料夾吧。」；
 *   - 资料夹页：枚数逐字「共 {n} 枚印章」、排序说明逐字「按加入時間倒序」、
 *     空态逐字「這個資料夾還是空的。」、移出钮逐字「移出資料夾」且挂
 *     `data-drive-action="remove-from-folder"`；
 *   - 「新增資料夾」挂 `data-drive-action="new-folder"`；「分享」挂 `share-folder`。
 *
 * 资料夹页用**同一条路由的 query**（`/my/drive?folder=<id>`）承载 —— 规范只新增两条路由，
 * 不为夹内页另立第三条（§3.21.2 的路由集合恰 8 条）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TextTransformButtons from '../components/TextTransformButtons.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { drive, seals } from '../services/index.js'
import { currentUser } from '../data/session.js'

const route = useRoute()
const router = useRouter()

/** 任何一次写入后 +1，使下面的派生读数立即重算（服务层读的是已落盘数据）。 */
const version = ref(0)

const folderId = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : ''))

/* ------------------------------ 资料夹清单 ------------------------------ */

const listing = computed(() => {
  void version.value
  return drive.listMyFolders()
})
const folders = computed(() => (listing.value.ok ? listing.value.rows : []))
const listingDegraded = computed(() =>
  listing.value.ok ? '' : `資料夾清單暫不可用：${listing.value.message}`
)

/* ------------------------------ 资料夹页 ------------------------------ */

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
  folderName.value = ''
  feedback.value = result.message
  version.value += 1
  /* 新建后直接进入该资料夹（省一次点击；不改变「选中即存」等既有语义）。 */
  if (result.folder_id) openFolder(result.folder_id)
}

/* ------------------------------ 进 / 出资料夹页 ------------------------------ */

function openFolder(id) {
  feedback.value = ''
  router.replace({ name: 'my-drive', query: { folder: String(id) } })
}

function backToList() {
  feedback.value = ''
  router.replace({ name: 'my-drive' })
}

/* ------------------------------ 移出資料夾 ------------------------------ */

/**
 * 移出（钩子 `remove-from-folder`）：**恰 ＝ 删那条引用行** —— 印章仍在藏品库中、
 * 其它资料夹的引用行不受影响（语义由 K-1 服务层保证；本页只给可见反馈）。
 */
function removeFromFolder(row) {
  const result = drive.removeSealFromFolder(folderId.value, row.seal_id)
  if (!result.ok) {
    feedback.value = '移出失敗，請稍後再試。'
    return
  }
  feedback.value = result.message
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
            maxlength="60"
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
                  :alt="`${row.seal_name || '佚名'}印面縮略圖`"
                />
                <span v-else class="drive-item__glyph">{{ (row.seal_name || '佚名').slice(0, 1) }}</span>
              </router-link>
              <div class="drive-item__body">
                <router-link
                  class="drive-item__name"
                  :to="{ name: 'seal-detail', params: { id: row.seal_id } }"
                >
                  {{ row.seal_name || '佚名' }}
                </router-link>
                <span class="drive-item__meta">藏品編號 {{ row.seal_id }}</span>
              </div>
              <button
                class="btn btn--ghost"
                type="button"
                data-drive-action="remove-from-folder"
                :data-folder-id="detail.folder.id"
                :data-seal-id="row.seal_id"
                @click="removeFromFolder(row)"
              >
                移出資料夾
              </button>
            </li>
          </ul>

          <p v-else class="drive__empty" data-drive-empty="folder">這個資料夾還是空的。</p>
        </div>
      </section>
    </template>

    <!-- 资料夹清单（未选中资料夹时）。 -->
    <section v-else class="panel" data-drive-folder="list">
      <div class="panel__head">
        <h2>我的資料夾</h2>
      </div>
      <div class="panel__body">
        <ul v-if="folders.length" class="drive-folders">
          <li v-for="row in folders" :key="row.id" class="drive-folder" :data-folder-id="row.id">
            <div class="drive-folder__main">
              <button class="drive-folder__name" type="button" @click="openFolder(row.id)">
                {{ row.name }}
              </button>
              <span class="drive-folder__meta">{{ row.code }}｜共 {{ row.item_count }} 枚印章</span>
            </div>
            <div class="drive-folder__acts">
              <button class="btn btn--ghost" type="button" @click="openFolder(row.id)">打開資料夾</button>
              <button
                class="btn btn--ghost"
                type="button"
                data-drive-action="share-folder"
                @click="openShare(row)"
              >
                分享
              </button>
            </div>
          </li>
        </ul>

        <p v-else class="drive__empty" data-drive-empty="list">尚無資料夾，先新增一個資料夾吧。</p>
      </div>
    </section>

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

.drive-folders {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.drive-folder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}

.drive-folder__main {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.drive-folder__name {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--c-text);
  font-size: var(--t-md);
  cursor: pointer;
  text-align: left;
}

.drive-folder__acts {
  display: flex;
  gap: var(--s-2);
}

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
