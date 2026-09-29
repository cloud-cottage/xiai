<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import AppSidebar from './components/AppSidebar.vue'
import PlaceholderPanel from './components/PlaceholderPanel.vue'

const route = useRoute()
const router = useRouter()
const isBare = computed(() => route.meta.bare === true)

/**
 * 路由級延遲載入（分頁）失敗面。
 *
 * 分頁模組取不到時（連線中斷、資源被攔），vue-router 預設**靜默**：導航不落地、
 * 畫面不變，使用者只看到「點了沒反應」。這裡在**路由層**接住這類失敗
 * （`router.onError` 會連同失敗的目標路由一起回呼），用**既有佔位面板**
 * （`PlaceholderPanel`）就地給出可操作的失敗態，失效時不顯示任何假內容：
 * 【重試】＝重發同一次導航；【重新載入】＝重載當前頁。
 *
 * 上屏文案**逐字取自規範 §3.35.6 凍結表**（該表為唯一真源），一律不改字、不改字序。
 */
const loadFailed = ref(false)
const failedTarget = ref('')
const retryAgainFailed = ref(false)

/**
 * 「重試後仍失敗」的追加行（§3.35.6）必須**跨整檔導航**記住：【重試】是一次
 * 整檔導航（見下），換了文件之後，新文件要知道「這次失敗緊接在一次【重試】之後」。
 * 標記放同源同分頁的 `sessionStorage`，且只作**一次性消費**（讀到即清）；
 * 導航成功落地時一律清除。
 */
const RETRY_MARK = 'xiai:route-load-retried'

function readRetryMark() {
  try {
    return window.sessionStorage.getItem(RETRY_MARK) === '1'
  } catch (error) {
    return false
  }
}

function writeRetryMark() {
  try {
    window.sessionStorage.setItem(RETRY_MARK, '1')
  } catch (error) {
    /* 存儲取不到（私密模式等）時退化為「不顯示追加行」，失敗面本身不受影響 */
  }
}

function clearRetryMark() {
  try {
    window.sessionStorage.removeItem(RETRY_MARK)
  } catch (error) {
    /* 同上 */
  }
}

function onRouteError(error, to) {
  failedTarget.value = (to && to.fullPath) || route.fullPath || '/'
  // 一次性讀取：只有「緊接在一次【重試】之後」的失敗才帶追加行；讀完即清。
  retryAgainFailed.value = readRetryMark()
  clearRetryMark()
  loadFailed.value = true
}

const stopRouteError = router.onError(onRouteError)
// 導航成功落地 ⇒ 清除標記：此後的新失敗不得再帶「重試後仍失敗」追加行。
const stopAfterEach = router.afterEach(() => clearRetryMark())
onBeforeUnmount(() => {
  stopRouteError()
  stopAfterEach()
})

/**
 * 【重試】＝重發同一次導航（到失敗的目標路徑）。
 *
 * 這裡刻意用一次**整檔導航**而不是原地 `router.push()`：量測事實是——分頁模組
 * 載入失敗後，**同一份文件**內再 import 同一個 URL 不會再發出請求（瀏覽器記住了
 * 那次失敗），原地重試只會拿到同一個錯誤（實測見 report-chunk-load.md 的 §4.3）。
 * 換一份文件重取模組，瞬時故障即可成功；失敗則失敗面照樣重繪，不假裝成功。
 */
function retryRouteLoad() {
  const target = failedTarget.value || '/'
  writeRetryMark()
  failedTarget.value = ''
  loadFailed.value = false
  window.location.assign(target)
}

function reloadPage() {
  window.location.reload()
}
</script>

<template>
  <div v-if="isBare" class="app-shell">
    <main class="app-body">
      <router-view />
    </main>
  </div>

  <div v-else class="app-shell">
    <AppHeader />
    <div class="app-body">
      <AppSidebar />
      <main class="app-main">
        <div class="app-main__inner">
          <router-view />
        </div>
      </main>
    </div>
  </div>

  <!-- 路由級延遲載入失敗面：分頁模組取不到時，**不得**讓使用者只看到「點了沒反應」，
       也不得用假內容頂替 —— 就地顯示可重試的失敗態，兩個動作各自可用。
       下面每一條上屏字面逐字取自規範 §3.35.6 凍結表（唯一真源），不得改字。 -->
  <div v-if="loadFailed" class="route-load" data-route-load-error="1" role="alert">
    <PlaceholderPanel
      class="route-load__panel"
      glyph="斷"
      title="頁面載入失敗"
      desc="這一步的內容沒能載入。請稍後重試，或重新載入頁面。"
    >
      <div class="route-load__actions">
        <button
          class="btn btn--primary"
          type="button"
          data-route-load-action="retry"
          @click="retryRouteLoad"
        >
          重試
        </button>
        <button
          class="btn btn--ghost"
          type="button"
          data-route-load-action="reload"
          @click="reloadPage"
        >
          重新載入
        </button>
      </div>
      <!-- §3.35.6 追加行：只在「緊接一次【重試】之後仍失敗」時同面板同現。 -->
      <p v-if="retryAgainFailed" class="route-load__again" data-route-load-again="1">仍然無法載入，請稍後再試。</p>
    </PlaceholderPanel>
  </div>
</template>

<style scoped>
.route-load {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  background: var(--c-bg);
}

.route-load__panel {
  width: min(100%, 420px);
  background: var(--slot-panel-bg);
  border: 1px solid var(--slot-panel-line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
}

.route-load__actions {
  display: flex;
  gap: var(--s-3);
}

.route-load__again {
  margin: var(--s-3) 0 0;
}
</style>
