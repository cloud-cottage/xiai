<script setup>
/**
 * 【印譜卡片】`/books` 卡片矩陣的單格（**只顯示、只開彈窗**）。
 *
 * 口径（Kevin 2026-11-17 定）：
 *   ① 每格显示：封面位 ／ 書名 ／ 作者名（`author_name` 優先）／ ISBN ・ CIP ／ 首次出版年 ／ 影像數；
 *   ② **封面不自動選**（選 C）：`coverUrl` 為空 ⇒ 一律顯示**統一占位圖**
 *      （`sealCards.coverPlaceholderUrl()`，與 `SealCard` 第三級回落的同一資產、同一 base 感知單點）；
 *      **取鏈失敗 / 字節 404 也走占位圖，且不報錯**（缺封面不是錯誤）；
 *   ③ 本組件**不發任何請求**（封面批量取在列表頁 `loadBookCovers` 一處；取鏈在
 *      `resolveCoverUrls` 一處）—— 卡上零 service 調用，避免逐卡打服務端。
 *
 * 卡體是一個 `<button>`（整卡可點、鍵盤可達、`aria-label` 說清是哪一本），內容全用
 * `<span>`（button 只容許 phrasing content）。
 */
import { computed, ref, watch } from 'vue'
import { sealCards } from '../services/index.js'

const props = defineProps({
  /** 印譜行（`services/books.js::BOOK_ROW_KEYS` 投影） */
  book: { type: Object, required: true },
  /** 封面對象臨時鏈接（由列表頁批量解析；空串 ⇒ 占位圖） */
  coverUrl: { type: String, default: '' },
  /** 作者顯示名（`author_name` 優先，已由列表頁算好） */
  authorName: { type: String, default: '' },
  /** 創作者鏈文本（空串 ⇒ 不渲染該行） */
  creatorChain: { type: String, default: '' },
  /** 關聯影像數（服務端快照 ＋ 本頁增量） */
  imageCount: { type: Number, default: 0 }
})

const emit = defineEmits(['open'])

/** 占位圖 URL（base 感知單點；資產缺損 ⇒ 空串，退字形空態，不造假 URL）。 */
const placeholderUrl = computed(() => sealCards.coverPlaceholderUrl())

/** `<img @error>` 的**運行時**回落：鏈接能取到但字節 404 / 解碼失敗 ⇒ 占位圖（不報錯）。 */
const broken = ref(false)
watch(
  () => props.coverUrl,
  () => {
    broken.value = false
  }
)

/** 實際出網的封面：**有鏈且未壞** ⇒ 真封面；否則占位圖。 */
const displayUrl = computed(() => {
  if (props.coverUrl && !broken.value) return props.coverUrl
  return placeholderUrl.value
})

/** 封面來源面別（機械讀數 `data-book-cover`）：`image` ＝ 用戶已選封面、`placeholder` ＝ 占位圖。 */
const coverFace = computed(() => (props.coverUrl && !broken.value ? 'image' : 'placeholder'))

function onCoverError() {
  broken.value = true
}

const bookName = computed(() => String(props.book.name || '').trim() || '（無書名）')
const titleText = computed(() => `印譜 ${props.book.id || ''}《${bookName.value}》`)
</script>

<template>
  <article class="book-card" :data-book-card="book.id">
    <button
      class="book-card__hit"
      type="button"
      data-action="book-card-open"
      :aria-label="`開啟${titleText}詳情`"
      @click="emit('open', book)"
    >
      <span class="book-card__cover" :data-book-cover="coverFace">
        <img
          v-if="displayUrl"
          class="book-card__cover-img"
          :src="displayUrl"
          :alt="`${titleText}封面`"
          loading="lazy"
          decoding="async"
          @error="onCoverError"
        />
        <span v-else class="book-card__cover-empty" data-book-cover-empty>封面影像暫無</span>
        <span class="book-card__id">{{ book.id }}</span>
      </span>

      <span class="book-card__body">
        <span class="book-card__title">{{ bookName }}</span>
        <span class="book-card__author" data-book-author>{{ authorName }}</span>
        <span v-if="creatorChain" class="book-card__chain" data-creator-chain>{{ creatorChain }}</span>
        <span class="book-card__meta">ISBN {{ book.isbn || '未著錄' }}</span>
        <span class="book-card__meta">CIP {{ book.cip || '未著錄' }}</span>
        <span class="book-card__meta">
          {{ book.first_publish_year ? `${book.first_publish_year} 年` : '首次出版年未著錄' }}
        </span>
        <span class="book-card__count" data-book-image-count>{{ imageCount }} 張影像</span>
      </span>
    </button>
  </article>
</template>

<style scoped>
.book-card {
  display: flex;
  min-width: 0;
  background: var(--c-surface);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  overflow: hidden;
}

.book-card:hover,
.book-card:focus-within {
  border-color: var(--c-line-strong);
  box-shadow: var(--shadow-2);
}

/* 整卡可點：按鈕鋪滿卡面，內部排版用 span（button 只容許 phrasing content）。 */
.book-card__hit {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.book-card__cover {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 3 / 4;
  background: var(--c-surface-sunken);
  border-bottom: 1px solid var(--c-line);
}

.book-card__cover-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* 占位圖是「沒有封面」的統一外觀（與真封面同一尺寸，不撐高卡片）。 */

.book-card__cover-empty {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.book-card__id {
  position: absolute;
  left: var(--s-1);
  bottom: var(--s-1);
  padding: 0 var(--s-1);
  border-radius: var(--r-sm);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
}

.book-card__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--s-2) var(--s-3) var(--s-3);
}

.book-card__title {
  color: var(--c-text);
  font-size: var(--t-sm);
  line-height: 1.3;
  /* 兩行封頂：卡片高度不被長書名撐歪（完整書名在彈窗裡）。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.book-card__author,
.book-card__chain,
.book-card__meta,
.book-card__count {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-card__count {
  margin-top: auto;
  font-variant-numeric: tabular-nums;
}
</style>
