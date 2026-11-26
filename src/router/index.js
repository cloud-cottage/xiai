import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn } from '../data/session.js'

/**
 * 路由表 —— **10 条可直达路由**：
 * `/`、`/seal/:id`、`/my/corrections`、`/my/photos`、`/my/drive`、`/points`、`/login`、`/s/:code`
 * ＋ **v1.21 起**：`/my/drive`（【我的雲盤】，`requiresAuth`）与 `/s/:code`（分享页，**免登錄可达**，
 * 不设 `requiresAuth`）。
 * ＋ **Slice M1 新增两条**：`/styles`（【印風匯覽】，title 逐字 `印風匯覽`）与
 * `/persons`（【印家匯徵】，title 逐字 `印家匯徵`）—— 两条**均不设 `requiresAuth`（公开可达）**。
 * ＋ **本單新增一條**：`/persons/:code`（【印人詳情】，title 逐字 `印人詳情`；由 `/persons` 行點擊進入，
 *   **與名錄同為公開可達**，不發第二條網絡請求 —— 只按 `code` 查名錄已落定的印人快照）。
 * ＋ **本單新增一條**：`/books`（【印譜匯觀】，`meta.title` 逐字 `印譜匯觀`）——
 *   **不是**游客 / 普通用户可达页：**页面本体**做管理员门（非管理员 / 未登录 ⇒ 页内显示无权限
 *   提示且**零 book 数据请求**，不得先取后藏），故**不设 `requiresAuth`**（未登录也要能落到
 *   「请先登录」提示，而不是被守门静默改写路径）；侧栏入口亦仅管理员渲染
 *   （`AppSidebar.vue`）。服务端另有管理员门（双门）。口径：`docs/book-catalog-ruling-2026-11-14.md` §二。
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
  /* **本單新增一條**：`/me`（【我的名刺】，title 逐字 `我的名刺`）—— 登录用户**自己的**
     名刺页（徽號行内改名 / 手機號打码 / 註冊時間 / 金 / 登出）：**不是管理员页**
     （零 `.btn--admin`、零权限判定），侧栏入口**普通用户也可见**（`AppSidebar.vue`，
     放在 `my-drive` 之前）。**不设 `requiresAuth`**：未登录也可直达，页内只给
     「請先登錄」引导 ＋ 去 `/login` 的链接（不重定向、不报错、零 profile 请求）。 */
  {
    path: '/me',
    name: 'me',
    component: () => import('../views/MeView.vue'),
    meta: { title: '我的名刺' }
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
  {
    path: '/persons/:code',
    name: 'personDetail',
    component: () => import('../views/PersonDetailView.vue'),
    meta: { title: '印人詳情' }
  },
  {
    path: '/books',
    name: 'books',
    component: () => import('../views/BookIndexView.vue'),
    meta: { title: '印譜匯觀' }
  },
  /* **本單新增一條**：`/publishers`（【梓行匯溯】；`meta.title` 逐字 `梓行匯溯`）—— 与 `/books`
     **同一形态**（xiai.spec §3.107 出版社实体的管理页）：**页面本体做管理员门**（非管理员 / 未登录
     ⇒ 页内显示无权限提示且**零出版社数据请求**，不得先取后藏），故**不设 `requiresAuth`**
     （未登录也要能落到「请先登录」提示，而不是被守门静默改写路径）；侧栏入口亦仅管理员渲染
     （`AppSidebar.vue`，沿 `isAdmin` 同一取法）。**不是 `/admin` 类路由**（仓规禁）。 */
  {
    path: '/publishers',
    name: 'publishers',
    component: () => import('../views/PublisherIndexView.vue'),
    meta: { title: '梓行匯溯' }
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
  /* **本單新增一條**：`/admin`（【管理後台】，`meta.title` 逐字 `管理後台`，**不挂 `requiresAuth`**）——
     **纯静态导航卡片页**：四张卡分别跳既有管理页（`/publishers`、`/books`、`/connect`、`/points`），
     卡片可见性走既有管理员门的服务层单点、进入资格走管理层会话的同一单点（见 `services/admin.js`）；
     页内三态（游客登录引导 / 非管理层页内拒绝 / 管理层按门渲染，一张都不命中 ⇒ 诚实空态）
     **一律不重定向**；本页**零数据请求、零写入**（不读云端集合、不调任何写 op）。
     本頁自帶三態、不挂 requiresAuth（与 books / publishers / connect-feicui 同形）；游客 URL 不变、零卡片。 */
  {
    path: '/admin',
    name: 'admin',
    component: () => import('../views/AdminView.vue'),
    meta: { title: '管理後台' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: { name: 'square' }
  }
]

const router = createRouter({
  /* 子路径（`/xiai/`）：history 基必须与 `vite.config.js::base` 同源 ⇒ 直接读 `BASE_URL`
     （不写字面量，改 base 只需改一处）。BASE_URL 恒以 `/` 结尾（Vite 保证）。 */
  history: createWebHistory(import.meta.env.BASE_URL),
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
