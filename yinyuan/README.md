# 印源 · 兆级玺印数字引擎 Web 平台（营销入口 + 控制台入口）

> **名称**：本站一律写作「**印源**」（英文 `yinyuan`），全站简体。2026-09-24 由 `yinsuo` / 印索站改名而来。
> **权威规范**：位于私有 monorepo `xiai/docs/`（印源 Web 规范），**不随本仓公开**；规范版本以私有仓现盘为准，本 README 不记录版本号。
> **本 README 只讲**：怎么跑起来、双入口与路由、目录结构、数据源开关、部署配置；产品与交互口径一律以私有规范为准。

## 环境要求

- Node **>= 18.19.0**；包管理器固定 **npm**。
- **Vite 锁 `^6`**：Vite 7 要求 Node 20.19+，请勿升级。
- 运行时依赖 Vue 3.5 / vue-router 4，版本由 `package-lock.json` 锁定。
- 离线可运行：0 个 CDN、0 个远程字体、0 个外链图片（样式走系统字体栈，图片为纯 CSS 占位）。

## 快速开始

```bash
npm install           # 安装依赖（package-lock.json 锁定精确版本）
npm run dev           # 双入口开发服务：固定端口 5164，strictPort
npm run build         # vite build → 产出 dist/（dist/index.html + dist/console.html）
npm run preview       # 预览构建产物：端口 5164，同样带 /console 入口改写
npm run smoke         # 适配层契约方法的运行期断言（esbuild 打包后由 node 执行）
npm run check:pricing # 价格 / 包量 / 场景数字字面量静态检查
```

- 端口固定 **5164**：`vite.config.js` 的 `server.port` / `preview.port` 均为 5164 且 `strictPort: true`；端口被占用时**直接报错**，不静默回退到 5173 等默认端口。
- `dev:marketing` / `dev:console` 两个便捷脚本分别以 `--open` 打开营销首页与控制台登录页。
- 演示账号：账号与显示开关见 `src/config/app-config.js` 的 `demo` 字段；演示登录密码 **`yinyuan2026`**（仅演示填充，登录不校验真实凭证）。
- `check:pricing` 扫描仓库内 `.html` / `.vue` / `.js` / `.css`，除单一配置源外不允许出现价格与包量字面量；根目录的 `index.legacy.html` 为旧存档单页，**不参与构建与路由**，但会被该检查一并扫描。

## 双入口与路由

本站是**多页构建**：两个入口 HTML 各自独立挂载一份 vue-router，路由表互不包含对方前缀。

| 入口 | 入口 HTML | 路由表 | 负责路径 |
| --- | --- | --- | --- |
| 营销 | `index.html` | `src/router/marketing.js` | `/`、`/pricing`、`/docs`、`/docs/quickstart`、`/org`、`/demo`、`/help` + 404 |
| 控制台 | `console.html` | `src/router/console.js` | `/console`（重定向到 `/console/overview`）、`/console/login`、`/console/register`、`/console/overview`、`/console/keys`、`/console/usage`、`/console/billing` + 404 |

- `vite.config.js` 的 `build.rollupOptions.input` 同时声明 `index.html` 与 `console.html`（多页输入）。
- 内置 `consoleEntryRewrite` 插件在 **dev / preview** 下把 `/console` 与 `/console/**` 的直达请求内部改写为 `console.html`，使 `/console/overview` 这类 history 路由可直接打开；**生产不适用**，须由部署侧做同构改写（见「部署」）。
- **跨入口导航纪律**：同一入口内用 `<router-link>`；跨入口（营销 ⇄ 控制台）一律用原生 `<a href>` **整页跳转** —— 两个路由表互不含对方前缀，营销侧点 `/console/**` 会被自己的 catch-all 吞成 404 页，控制台侧点 `/`、`/pricing` 会渲染空视图。组件 `src/components/EntryLink.vue` 按「当前入口 × 目标前缀」自动选择 `<a>` / `<router-link>`，新增跨入口链接请用它，不要手写。
- 营销锚点：`/#resources`、`/#tech`、`/#api`、`/#seals`、`/#contact`、`/pricing#overage`。

## 目录结构

```text
index.html / console.html      # 两个入口 HTML（多页构建输入）
index.legacy.html              # 旧存档单页（不参与构建与路由）
vite.config.js                 # 端口 / 路径别名 / 多页输入 / /console 入口改写 / 开发期代理
vercel.json                    # 部署配置（见「部署」）
src/
  router/       marketing.js、console.js     # 两份互不相交的路由表
  pages/        marketing/、console/、NotFoundPage.vue、ComingSoonPage.vue
  components/   共享组件（含 EntryLink.vue 跨入口链接、SlicePreview.vue 图片双通道演示）
  composables/  useAppConfig、useAsync、useAuth、useToast
  config/       app-config.js（站点配置 / 开关 / 演示账号）、env.js（唯一环境读取点）、pricing.js（定价单一数据源）、labels.js
  data/         contract.js、index.js、mock/、api/  —— 页面只 import 这里
  console/      控制台入口挂载（main.js + App.vue）
  marketing/    营销入口挂载（main.js + App.vue）
  styles/       tokens.css（设计 token）、base.css
scripts/        check-price-literals.mjs、build-smoke.mjs、smoke-adapter.mjs
```

## 数据源开关

```bash
VITE_DATA_SOURCE=mock   # 默认：内存 mock 实现
VITE_DATA_SOURCE=api    # 真实实现（src/data/api/impl.js）：未接入的接口明确失败，不返回假数据
VITE_API_BASE_URL=/api/v1
```

- 浏览器端只能读 `VITE_` 前缀的变量；代码内统一暴露为 `DATA_SOURCE`，唯一读取点是 `src/config/env.js`。示例见仓库根 `.env.example`；改动后需重启 dev 服务生效。
- 页面**只能** `import { ... } from '@/data'`，**禁止** import `@/data/mock/**`，否则切到真实实现时会漏网。
- 需要真实后端联调时，开发期由 Vite 代理转发到本机服务（仅 dev / preview 生效，生产不适用）；代理前缀与目标见 `vite.config.js`。

## 部署

`vercel.json` 已就绪：`framework: vite`、`buildCommand: npm run build`、`outputDirectory: dist`，并用 `rewrites` 覆盖两个入口的 history 回退：

| source | destination | 说明 |
| --- | --- | --- |
| `/console` | `/console.html` | 控制台入口（**必须排在兜底规则之前**） |
| `/console/:path*` | `/console.html` | 控制台子路由整页回退 |
| `/`、`/pricing`、`/docs`、`/docs/quickstart`、`/org`、`/demo`、`/help` | `/index.html` | 营销各路由回退 |
| `/((?!assets/).*)` | `/index.html` | 末尾兜底，且**不吞** `/assets/**` |

- 换到其他平台（Nginx、对象存储 + CDN 等）时，须做**同构改写**：`/console` 与 `/console/**` → `console.html`，其余未命中静态文件的路径 → `index.html`，均返回 200；否则直接打开 `/console/overview` 会 404。
- `dist/`、`.env` / `.env.*`、`node_modules/` 不入库（见 `.gitignore`，仅 `.env.example` 保留），构建产物由部署侧生成。

## 关键文件

| 关注点 | 位置 |
| --- | --- |
| 设计 token（视觉唯一来源） | `src/styles/tokens.css` |
| 站点配置 / 功能开关 / 演示账号 | `src/config/app-config.js` |
| 数据源开关读取点 | `src/config/env.js` |
| 定价与计费口径（唯一数据源） | `src/config/pricing.js` |
| 适配层契约与入口 | `src/data/contract.js`、`src/data/index.js` |
| mock 实现 / 种子数据 | `src/data/mock/impl.js`、`src/data/mock/seed.js` |
| 营销首页 / 计费规则页 | `src/pages/marketing/HomePage.vue`、`src/pages/marketing/PricingPage.vue` |
| 跨入口链接 / 图片双通道演示组件 | `src/components/EntryLink.vue`、`src/components/SlicePreview.vue` |
| 部署配置 | `vercel.json` |

> 本仓为**纯前端演示实现**（mock 数据；未接入的后端功能统一提示「演示环境：该功能未接入」），不含后端服务。接口契约、产品口径与品牌规范一律以私有 monorepo `xiai/docs/` 的印源 Web 规范为准。
