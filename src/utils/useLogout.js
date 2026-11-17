/**
 * 玺爱 · **退出登錄的交互壳（三态 + 防重复点 + 可见反馈）**
 * ============================================================================
 * 两个登出入口（頁頭 `AppHeader.vue`、登錄頁 `LoginView.vue`）共用这一份，
 * 保证行为与文案**逐字一致**：
 *
 *   · 進行中：`running = true` ⇒ 按钮 immediate 换「正在退出…」并禁用
 *     （`view.disabled`）；重复点击直接返回，不重发请求。
 *   · 成功：服务层回 `ok` ⇒ **先**上屏「已退出登錄」（toast ＝ 明确可见的结论），
 *     **再**执行业务侧的收尾（关菜单 / 清输入 / 路由重置）—— 顺序上「提示」不依赖
 *     收尾是否抛错，收尾失败也只是多留一句提示，不会退回「看起来没退」。
 *   · 失败：服务层回 `ok:false` ⇒ 上屏「退出失敗：<原因>」并**保留** `running = false`
 *     ⇒ 按钮恢复可点，用户可原地重试；原会话由服务层原样保留（全或全无）。
 *
 * 幂等：未登錄时服务层直接回 `ok/accepted`（零网络），本壳照样上屏「已退出登錄」，
 * 不报错、不抛错。
 */

import { computed, ref } from 'vue'
import { auth } from '../services/index.js'
import { LOGOUT_DONE_TEXT, logoutFailureText, logoutOutcome, logoutView } from '../services/logoutText.js'
import { pushToast } from './appToast.js'

/**
 * @returns {{
 *   running: import('vue').Ref<boolean>,
 *   error: import('vue').Ref<string>,
 *   notice: import('vue').Ref<string>,
 *   view: import('vue').ComputedRef<{tone:string,label:string,disabled:boolean,message:string}>,
 *   signOut: (options?: {onSignedOut?: () => (void|Promise<void>)}) => Promise<{ok:boolean, message:string}>
 * }}
 */
export function useLogout() {
  const running = ref(false)
  const error = ref('')
  /* 成功结论的**页内**留存（toast 会自己消失；登錄頁靠它留一条持久提示条）。 */
  const notice = ref('')

  const view = computed(() => logoutView({ running: running.value, error: error.value }))

  /**
   * 执行一次退出。`onSignedOut` 只在**退出成功**后调用（关菜单 / 清输入 / 路由重置）。
   * @param {{onSignedOut?: () => (void|Promise<void>)}} [options]
   */
  async function signOut(options = {}) {
    /* 防重复点（与按钮 disabled 同源判据）：在飞时直接返回，不重发、不改变反馈。 */
    if (running.value) return { ok: false, message: '' }
    running.value = true
    error.value = ''
    try {
      let reply = null
      try {
        reply = await auth.logout()
      } catch (thrown) {
        reply = { ok: false, message: logoutFailureText(thrown) }
      }
      const outcome = logoutOutcome(reply)
      if (!outcome.ok) {
        /* 失败：可见文案 ＋ 原会话保留 ＋ 按钮恢复（可重试）。 */
        error.value = outcome.message
        pushToast(outcome.message, 'error')
        return { ok: false, message: outcome.message }
      }
      /* 成功：先上屏结论，再收尾（收尾抛错也不抹掉这句结论）。 */
      error.value = ''
      notice.value = LOGOUT_DONE_TEXT
      pushToast(LOGOUT_DONE_TEXT, 'ok')
      if (typeof options.onSignedOut === 'function') await options.onSignedOut()
      return { ok: true, message: LOGOUT_DONE_TEXT }
    } finally {
      running.value = false
    }
  }

  return { running, error, notice, view, signOut }
}
