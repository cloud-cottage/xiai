
<script setup>
/**
 * 分享页（`/s/:code`，**免登錄可达**｜v1.21 新增｜K-2）。
 *
 * 依据：规范 §3.21.5（分享短链）＋ §3.21.6（未登錄可见范围：資料夾名 ＋ 印數 ＋ 前 3 枚；
 * 其余遮罩 ＋ 引导；登錄 / 注册成功后**直接打开该资料夹完整页**）
 * ＋ §3.21.12（逐字文案表第 25 ～ 29 行）。
 * 契约：**只消费 K-1 的 `services/drive.js::resolveShare(code)` 投影** ——
 * 本项目**在投影层就把被遮内容摘掉**：未登錄时返回物件里只有前 3 枚（`visible_items`），
 * 第 4 枚起的任何印文 / 缩略图字段**不在返回物件中** ⇒ 本视图无从把它们渲进 DOM
 * （不得用 `filter: blur()` / `opacity: 0` / 隐藏同一份 DOM 冒充遮罩）。
 *
 * 本视图**只读**：不提供任何写操作入口（存入 / 移出 / 重新生成 / 改名对非拥有者不可用；
 * 拥有者的写入口在【我的雲盤】页内）。
 *
 * 登錄 / 注册成功后直达完整页：引导钮只把 `redirect` 指向**本分享链自身**，
 * 登录完成后由既有 `LoginView` 的 `redirect` 路径原样跳回本页；此时 `resolveShare`
 * 已按登錄态返回完整清单 ⇒ **一次点击即可见到完整清单**（不跳首页、不要求二次点击）。
 *
 * 上屏文案一律繁体（`s2t(x) === x`），且**零「切分」措辞**。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { drive, seals } from '../services/index.js'

const route = useRoute()
const router = useRouter()

const code = computed(() => String(route.params.code || ''))

/** 任何一次写入后 +1，使下面的派生读数立即重算（本页只读，此项仅供登錄态切换后重取投影）。 */
const version = ref(0)

const resolved = computed(() => {
  void version.value
  return drive.resolveShare(code.value)
})

/** 有效分享的两态（未登錄 `locked` / 登錄后完整清单）。 */
const active = computed(() => Boolean(resolved.value.ok && resolved.value.state === drive.SHARE_STATE.ACTIVE))
const rows = computed(() => (active.value ? resolved.value.visible_items || [] : []))
const maskedCount = computed(() => (active.value ? resolved.value.masked_count || 0 : 0))
const locked = computed(() => Boolean(active.value && resolved.value.locked))

/** 失效页 / 无效码页（**不得白屏**）。 */
const invalid = computed(() => !resolved.value.ok || resolved.value.state === drive.SHARE_STATE.UNKNOWN)
const expired = computed(
  () =>
    resolved.value.ok &&
    (resolved.value.state === drive.SHARE_STATE.EXPIRED || resolved.value.state === drive.SHARE_STATE.REVOKED)
)

/* 缩略图：二进制只经服务层取回（页面不碰任何浏览器存储）。
   被遮的印章不在此循环里 —— 投影层已把它们的缩略图字段摘掉。 */
const thumbs = ref({})
watch(
  () => rows.value.map((row) => row.seal_id).join(','),
  async () => {
    const next = {}
    for (const row of rows.value) {
      const imageId = row.image_id ? String(row.image_id) : ''
      if (!imageId) continue
      const out = await seals.loadImageDataUrl(imageId)
      if (out.ok) next[row.seal_id] = out.dataUrl
    }
    thumbs.value = next
  },
  { immediate: true }
)

onMounted(() => {
  version.value += 1
})

/** 未登錄引导：文案逐字，且把 `redirect` 指向本分享链（登录后直达该资料夹完整页）。 */
const GUIDE_MAIN = '登錄後查看完整清單'

function goLogin() {
  router.push({ name: 'login', query: { redirect: `/s/${code.value}` } })
}

function goSquare() {
  router.push({ name: 'square' })
}
</script>

<template>
  <section data-share-page="true">
    <!-- ============ 未登錄（有效链）：名 ＋ 印數 ＋ 前 3 枚 ＋ 遮罩 ＋ 引导 ============ -->
    <template v-if="active">
      <div class="page-head share__head">
        <div>
          <h1>{{ resolved.folder_name }}</h1>
          <p>這是一個分享的資料夾：資料夾名、印數與前 3 枚印章對所有人可見。</p>
        </div>
      </div>

      <p class="share__count" data-share-count="true">共 {{ resolved.item_count }} 枚印章</p>
      <p class="share__order" data-share-order="true">按加入時間倒序</p>

      <div v-if="rows.length" class="share__grid" data-share-visible="true">
        <article v-for="row in rows" :key="row.seal_id" class="share-card" :data-share-seal-id="row.seal_id">
          <div class="share-card__thumb">
            <img
              v-if="thumbs[row.seal_id]"
              class="share-card__img"
              :src="thumbs[row.seal_id]"
              :alt="`${row.seal_name || '佚名'}印面縮略圖`"
            />
            <span v-else class="share-card__glyph">{{ (row.seal_name || '佚名').slice(0, 1) }}</span>
          </div>
          <p class="share-card__name">{{ row.seal_name || '佚名' }}</p>
        </article>
      </div>
      <p v-else class="share__empty" data-share-empty="true">這個資料夾還是空的。</p>

      <!-- 遮罩面：**不承载任何被遮内容的文本 / `alt` / `title` / `data-*`**；
           只给枚数与引导（第 4 枚起的内容根本不在本页 DOM 内）。 -->
      <div v-if="locked && maskedCount" class="share-mask" data-share-mask="true">
        <p class="share-mask__main" data-share-guide="true">{{ GUIDE_MAIN }}</p>
        <p class="share-mask__sub">
          其餘印章在登錄後可見。本資料夾還有 {{ maskedCount }} 枚印章未展示。
        </p>
        <button class="btn btn--primary" type="button" @click="goLogin">登錄查看</button>
      </div>
      <div v-else-if="locked" class="share-mask" data-share-mask="none">
        <p class="share-mask__main" data-share-guide="true">{{ GUIDE_MAIN }}</p>
        <p class="share-mask__sub">其餘印章在登錄後可見。</p>
        <button class="btn btn--primary" type="button" @click="goLogin">登錄查看</button>
      </div>
    </template>

    <!-- ============ 失效页（过期 / 已作废） ============ -->
    <template v-else-if="expired">
      <div class="share-state" data-share-state="expired">
        <h1 class="share-state__title">連結已過期</h1>
        <p class="share-state__body">這個分享連結已失效。</p>
        <button class="btn btn--primary" type="button" @click="goSquare">返回藏品廣場</button>
      </div>
    </template>

    <!-- ============ 无效码 / 形态不符 ============ -->
    <template v-else>
      <div class="share-state" data-share-state="invalid">
        <h1 class="share-state__title">連結不存在</h1>
        <p class="share-state__body">請向分享者索取新的連結。</p>
        <button class="btn btn--ghost" type="button" @click="goSquare">返回藏品廣場</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.share__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
}

.share__count {
  color: var(--c-text);
  font-size: var(--t-md);
}

.share__order {
  margin-bottom: var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.share__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--s-4);
}

.share-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--slot-card-bg);
  border: 1px solid var(--slot-card-line);
  border-radius: var(--r-lg);
}

.share-card__thumb {
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: var(--slot-card-seal-bg);
  border: 1px solid var(--slot-card-thumb-line);
  border-radius: var(--r-sm);
}

.share-card__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.share-card__glyph {
  font-family: var(--font-seal);
  font-size: var(--t-2xl);
  color: var(--slot-card-seal-text);
}

.share-card__name {
  color: var(--slot-card-title-text);
  font-size: var(--t-sm);
}

.share__empty {
  padding: var(--s-4);
  background: var(--c-surface-sunken);
  border-radius: var(--r-md);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.share-mask {
  margin-top: var(--s-5);
  padding: var(--s-5);
  text-align: center;
  background: var(--c-surface-sunken);
  border: 1px dashed var(--c-line);
  border-radius: var(--r-lg);
}

.share-mask__main {
  color: var(--c-text);
  font-size: var(--t-lg);
}

.share-mask__sub {
  margin: var(--s-2) 0 var(--s-4);
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.share-state {
  padding: var(--s-6) var(--s-4);
  text-align: center;
}

.share-state__title {
  font-size: var(--t-xl);
  color: var(--c-text);
}

.share-state__body {
  margin: var(--s-3) 0 var(--s-5);
  color: var(--c-text-muted);
  font-size: var(--t-md);
}
</style>
