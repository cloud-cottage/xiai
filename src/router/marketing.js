/**
 * 营销入口路由表 —— spec §2.2（最终栈，R13）。
 * #1 `/`、#2 `/pricing` 为 M1；#10–#13（/docs、/docs/quickstart、/org、/demo、/help）为 M2/M3，
 * 本轮按 §1.2「导航骨架与路由占位必须已存在」先挂「即将开放」占位页，**不得跳期实现**。
 */
import { createRouter, createWebHistory } from 'vue-router'
import { APP_CONFIG } from '@/config/app-config.js'

const ComingSoonPage = () => import('@/pages/ComingSoonPage.vue')
const NotFoundPage = () => import('@/pages/NotFoundPage.vue')

export const marketingRoutes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/pages/marketing/HomePage.vue'),
    meta: { entry: 'marketing', milestone: 'M1', title: '首页', specRef: 'P-M1-01' },
  },
  {
    path: '/pricing',
    name: 'pricing',
    component: () => import('@/pages/marketing/PricingPage.vue'),
    meta: { entry: 'marketing', milestone: 'M1', title: '计费规则', specRef: 'P-M1-08' },
  },
  {
    path: '/docs',
    name: 'docs',
    component: ComingSoonPage,
    meta: {
      entry: 'marketing', milestone: 'M2', title: 'API 文档', specRef: 'P-M2-01', comingSoon: true,
      highlights: [
        '按接口查阅方法、路径、请求参数与响应示例，可直接照此接入',
        '鉴权头的写法，以及密钥泄露后的处置建议',
        '常见错误码、限流与配额的说明',
      ],
    },
  },
  {
    path: '/docs/quickstart',
    name: 'docs-quickstart',
    component: ComingSoonPage,
    meta: {
      entry: 'marketing', milestone: 'M2', title: '快速开始', specRef: 'P-M2-01', comingSoon: true,
      highlights: [
        '四步完成第一次检索请求：开通 → 生成密钥 → 发起调用 → 调取图像',
        '每一步都给出可直接复制的示例片段',
        '可一键跳转到控制台对应位置继续操作',
      ],
    },
  },
  {
    path: '/org',
    name: 'org',
    component: ComingSoonPage,
    meta: {
      entry: 'marketing', milestone: 'M2', title: '机构资料', specRef: 'P-M2-02', comingSoon: true,
      highlights: [
        '机构定位、服务对象与合作方式',
        '数据体量、著录字段与检索能力说明',
        '图像技术规格、对接流程与可申请的资料',
      ],
    },
  },
  {
    path: '/demo',
    name: 'demo',
    component: ComingSoonPage,
    meta: {
      entry: 'marketing', milestone: 'M3', title: '申请演示 / 联系咨询', specRef: 'P-M3-01', comingSoon: true,
      highlights: [
        '在线提交申请，人工受理后会与你联系对接',
        '受理进度可查询，通过后由平台签发演示密钥',
        '演示额度与图像取用规则说明',
      ],
    },
  },
  {
    path: '/help',
    name: 'help',
    component: ComingSoonPage,
    meta: {
      entry: 'marketing', milestone: 'M3', title: '帮助中心 FAQ', specRef: 'P-M3-02', comingSoon: true,
      highlights: [
        '按分类浏览常见问题，也可用关键词搜索',
        '逐条展开查看详细解答',
        '未解决的问题可直接联系我们',
      ],
    },
  },
  {
    // §2.3-3：未匹配路由 → 404 页（营销风格），提供「回首页 / 去控制台」
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundPage,
    meta: { entry: 'marketing', title: '页面不存在' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes: marketingRoutes,
  scrollBehavior(to, _from, savedPosition) {
    // §2.3-5 锚点约定：站内锚点平滑滚动；浏览器回退还原位置
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  },
})

router.afterEach((to) => {
  const name = to.meta?.title ? `${to.meta.title}｜${APP_CONFIG.site.name}` : `${APP_CONFIG.site.name}｜${APP_CONFIG.site.tagline}`
  document.title = name
})

export default router
