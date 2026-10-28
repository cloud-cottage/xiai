import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn } from '../data/session.js'

/**
 * 路由表 —— **10 条可直达路由**：
 * `/`、`/seal/:id`、`/my/corrections`、`/my/photos`、`/my/drive`、`/points`、`/login`、`/s/:code`
 * ＋ **v1.21 起**：`/my/drive`（【我的雲盤】，`requiresAuth`）与 `/s/:code`（分享页，**免登錄可达**，
 * 不设 `requiresAuth`）。
 * ＋ **Slice M1 新增两条**：`/styles`（【印風匯覽】，title 逐字 `印風匯覽`）与
 * `/persons`（【印家匯徵】，title 逐字 `印家匯徵`）—— 两条**均不设 `requiresAuth`（公开可达）**。
 * ＋ **本單新增一條**：`/connect`（【連接斐萃】；`meta.title` 逐字 `斐萃令牌`）—— **頁面現在兼具
 *   「斐萃令牌 ＋ 我的 API」**：斐萃令牌（管理員簽發）＋ 我的 AI 金鑰 / 餘額 / 用量（已登錄用戶）
 *   ＋ 管理員【上游配置】卡片；同样**不设 `requiresAuth`**（未登錄可直达，页内给登录引导）；
 *   **不是 `/admin` 类路由**（管理員能力＝頁內條件渲染的卡片，見 ConnectFeicuiView.vue）。
 * 侧边栏删去的三个条目（`我的勘誤記錄` / `我的實物照片` / `積分中心`）**其路由与视图一律保留**
 * （顶部弹出菜单 AppHeader.vue 仍在用）。**本条改版不动其余任何路由与末条兜底**。
 *
 * 管理员**没有**独立路由 / 独立页面：其编辑能力一律是**普通页面内的「管理员专属按钮」**
 * （璽印匯類「上传印章」、印章详情页「编辑固定属性」、我的勘误记录「采纳 / 驳回」），
 * 且对游客与普通用户**不渲染**（条件渲染，不是 CSS 隐藏 / disabled）。
 *
 * 末条 `/:pathMatch(.*)*` 是**兜底重定向**（不是一个可直达页面，不渲染任何内容）：
 * 未知路径——含已退役的 `/admin`——一律重定向到璽印匯類。
 */
const routes = [
  {
    path: '/',
    name: 'square',
    component: () => import('../views/SquareView.vue'),
    meta: { title: '璽印匯類' }
  },
  {
    path: '/seal/:id',
    name: 'seal-detail',
    component: () => import('../views/SealDetailView.vue'),
    meta: { title: '印章詳情' }
  },
  {
    path: '/my/corrections',
    name: 'my-corrections',
    component: () => import('../views/MyCorrectionsView.vue'),
    meta: { title: '我的勘誤記錄', requiresAuth: true }
  },
  {
    path: '/my/photos',
    name: 'my-photos',
    component: () => import('../views/MyPhotosView.vue'),
    meta: { title: '我的實物照片', requiresAuth: true }
  },
  {
    path: '/my/drive',
    name: 'my-drive',
    component: () => import('../views/MyDriveView.vue'),
    meta: { title: '我的雲盤', requiresAuth: true }
  },
  {
    path: '/points',
    name: 'points',
    component: () => import('../views/PointsView.vue'),
    meta: { title: '積分中心', requiresAuth: true }
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { title: '登錄', bare: true }
  },
  {
    path: '/s/:code',
    name: 'share',
    component: () => import('../views/ShareView.vue'),
    meta: { title: '分享資料夾' }
  },
  {
    path: '/styles',
    name: 'styles',
    component: () => import('../views/StyleIndexView.vue'),
    meta: { title: '印風匯覽' }
  },
  {
    path: '/persons',
    name: 'persons',
    component: () => import('../views/PersonIndexView.vue'),
    meta: { title: '印家匯徵' }
  },
  /* **本单改造（斐萃令牌）**：`/connect` ＝ 管理员签发 HMAC 令牌页（`api/feicui/v1/*` 转发面用它确权）。
     **本單（我的 API）**：同頁增設「我的 API」用戶區（AI 金鑰 / 餘額 / 用量，已登錄用戶）
     ＋ 管理員【上游配置】卡片（頁內條件渲染；鈎子值 `edit-ai-upstream`）—— **路由條目與路徑一字未動**。
     **不新增 `/admin` 类路由**（仓规禁）；本页 `requiresAuth` 不设 ⇒ 未登錄也可直达，
     由页内给登录 / 权限说明（服务端 op 另有独立的管理员门，两处互不替代）。 */
  {
    path: '/connect',
    name: 'connect-feicui',
    component: () => import('../views/ConnectFeicuiView.vue'),
    meta: { title: '斐萃令牌' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: { name: 'square' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !isLoggedIn.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta.title ? `${to.meta.title} · 璽愛` : '璽愛'
  if (typeof document !== 'undefined') document.title = title
})

export default router
