# 印索・兆级玺印数字引擎 — Web 平台（营销入口 + 控制台入口）

> 唯一权威规范：`../docs/yinsuo-web.spec.md`（当前 **v1.5**，md5 `08cda20a27bddfbacd37db11978261e2`）。
> 本 README 只讲**怎么跑起来**、**地基边界**与**本轮交付映射**；产品与交互口径一律以规范为准。
> 视觉唯一来源：`../mockups/v1.html`（md5 `46ddac3e82ff7f3459b8a95d0302403b`，已定稿归档，不得回退）。

## 阶段状态

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| P1 | Vite 双入口地基、13 路由骨架、tokens、数据适配层（A1–A31 = 33 方法）、定价单一数据源 | ✅ |
| P2a | D1 跨入口导航修复、契约方法补齐、计价页地基 | ✅ |
| **P2b（本轮）** | **首页全量要素 01-1 ～ 01-10 + 图片双通道轻演示（A27）+ 三项裁定落地 + D3 修复** | ✅ |
| P2c | 注册页（P-M1-02）/ 登录页（P-M1-03） | ⏳ 下一单 |
| P3 / P4 | 控制台三页 / 充值账单 + 计费规则全量要素 | ⏳ |

## 本轮（P2b）交付映射

### 首页 P-M1-01 要素 → 文件

| 要素 | 落点 |
| --- | --- |
| 01-1 品牌头（logo + 副标题 + 5 项锚点导航） | `src/components/MarketingHeader.vue` |
| 01-2 行动区（机构登录 / 免费开通 ⇄ 申请演示，开关态驱动） | `src/components/MarketingHeader.vue` |
| 01-3 Hero（主标题 + 定位说明 + 查看资源规格 / 获取技术白皮书） | `src/pages/marketing/HomePage.vue` |
| 01-4 资源总览 3 卡（10 万方 / 远期兆级 / 约 40 万张影像 / 五字段著录 / 五类型 / PostgreSQL） | 同上 `#resources` |
| 01-5 图像技术 4 块（TIFF G4 仅归档不外发 / WebP 优先 + PNG 索引 2 色兜底 / 2cm 400PPI 双色 / CDN 分发） | 同上 `#tech` |
| 01-6 API 服务 3 卡（**场景数字由 `getPricingTable().scenarioText` 插值**） | 同上 `#api` |
| 01-7 玺印样例 4 卡 + 图片双通道轻演示 + 防护定性声明 | 同上 `#seals` + `src/components/SlicePreview.vue` |
| 01-8 接入入口区 4 入口（按开关态调整） | 同上 `#contact` |
| 01-9 底部声明条（示意值声明 + 版权行 + 当前数据源） | 同上 `#statement` |
| 01-10 页脚（版权行 + 站内/跨入口链接 + 声明） | `src/components/MarketingFooter.vue` |

- 宣传文案与旧存档单页 `../index.html` **逐字一致**；**唯一例外**是 01-6 的典型场景数字：规范 §1.3 01-6 / §4.3 要求**插值**（旧「按张调取高清原图」的 v1.1 口径已按 §7.7-R17 退役），页面内**零金额 / 零包量 / 零额度字面量**。
- 交互：导航锚点平滑滚动不跳转不刷新；「获取技术白皮书 / 发送咨询邮件」等未接入功能统一提示 **「演示环境：该功能未接入」**；0 个 `<img>`、0 个外部请求。

### 图片双通道轻演示（R17 / 首页 4 张样例卡，不新增页面）

`src/components/SlicePreview.vue`：

1. 经 **A27 `getDisplaySlices(assetId)`** 取**恰好 2 片**，各自带独立假签名 URL（`about:placeholder#<assetId>/slice-N?sig=…`，**零外链、零真实请求**）；切向与切位由后端（mock 固定种子）给出，同一资源稳定。
2. 前端按 `sliceMeta.direction` / `offsetRatio` **拼接近原为视觉完整图**：两片各为一个图层，用 `clip-path: inset(...)` 各裁一半，半区互补（实测两片 clip 分别为 `inset(0% 0px 44.34%)` 与 `inset(55.66% 0px 0%)`）；中间有切割线标记；悬停时两片轻微分离，直观显示「两片拼成」。
3. **另存门槛**：`contextmenu` / `dragstart` 一律 `preventDefault` + `draggable="false"` + CSS `user-select:none; -webkit-user-drag:none`，命中时给出提示。
4. **防护定性声明**（§1.6 / §7.7-R17d / AC-84）：明确写明展示切片为**辅助**手段、**无法阻止专业爬虫拼接**、原图权限**完全由后端鉴权控制**；全站**禁止**「切片防盗图 / 不可下载」类夸大表述。

### 三项裁定落地

| 裁定 | 落点 |
| --- | --- |
| ① 计费算例口径（Zang 终审） | `src/config/pricing.js`：`scenario.daysPerMonth=30`、默认 `originalImagesPerMonth=30`（落在每日免费额度内）、新增 `scenario.overageExample.originalImagesPerMonth=100`；`computeScenario()` 改为「免费额度 `freePerDay × daysPerMonth` 张内不计费 ⇒ 原图费用 ¥0 ⇒ 首年 = 年费」，并新增 `originalImageFreeAllowance / originalImagesFreeCount / originalImagesOverageCount` 等字段；`getScenarioExamples()` 供页面渲染两条算例（A17 `scenarioExamples`）。计价页新增「超额算例」表。 |
| ② A30 登录态校验（Zang 终审） | `src/data/mock/impl.js`：`getOriginalQuota()` 未登录一律 reject `UNAUTHENTICATED`（额度是账号维度数据），与 A31 复用 `contract.ORIGINAL_DOWNLOAD_ERROR`。当前无页面在未登录态调用 A30（`/console/*` 均需登录），故无需页面空态改动。 |
| ③ `charged.freeApplied` 语义 | 保持 P2a 实现：**本次占用免费额度张数（0 / 1）**，与 `overageCount` 互补（恒 `freeApplied + overageCount = 1`）；已在 `requestOriginalDownload` 与 `contract.js` 注释中写死语义，等 Jing 在规范补细则。**不改其他语义。** |

### D3 锚点滚动修复（`/pricing#overage`）

- 根因：`id="overage"` 曾位于 `v-if` 异步块内，router 的 `scrollBehavior` 执行时目标尚未渲染 ⇒ 锚点命中失败（实测 0～750ms 内 `document.getElementById('overage')` 为 `null`，前 2.4s `scrollY` 恒为 0；之后仅由浏览器的「加载后补一次 fragment 滚动」落到 544px，非平滑滚动且落点偏高）。
- 修法：把 `id` 提到**静态外壳** `div.anchor-shell`（挂载即存在），并在 `PricingPage.vue` 数据就绪后对 `route.hash === '#overage'` 再做一次 `scrollIntoView` 兜底。
- 实测（headless Chrome + CDP，1440×900）：直达 `/pricing#overage` 最终 `scrollY=387`、`#overage` 距视口顶 **24px**（＝设计的 `scroll-margin-top`）；站内 SPA 跳转同样落到 387 / 24px。

## 环境要求

- Node **>= 18.19.0**（本机 v18.19.0）。
- 包管理器固定 **npm**。
- **Vite 锁 `^6`，不得升到 Vite 7**：Vite 7 要求 Node 20.19+，本机 Node 18 会直接失败。
- 离线可运行：0 个 CDN、0 个远程字体、0 个外链图片（样式用 `--font-serif` 系统字体栈，图片一律纯 CSS 占位）。
- 本地 dev 端口固定 **5164 + `strictPort`**（`vite.config.js`）；**改端口属跨项目变更**，须同步 `ctrl/PORTS.md` 与本 README。

## 常用命令

```bash
npm install          # 安装依赖（package-lock.json 锁定精确版本）
npm run dev          # 双入口开发服务，固定端口 5164，strictPort
npm run dev:marketing
npm run dev:console
npm run build        # 产出 dist/（index.html + console.html 两个入口）
npm run preview      # 预览构建产物，端口 5164
npm run check:pricing   # 价格/包量/场景数字字面量静态检查（§4.3 / AC-19）
npm run smoke           # 适配层 A1–A31 运行期断言（esbuild 打包后 node 执行）
```

演示账号（仅演示填充，登录不校验真实凭证）：见 `src/config/app-config.js` 的 `demo` 字段。

## 双入口与路由

| 入口 | 入口 HTML | 负责路径 |
| --- | --- | --- |
| 营销 `marketing` | `index.html` | `/`、`/pricing`、`/docs`、`/docs/quickstart`、`/org`、`/demo`、`/help` + 404 |
| 控制台 `console` | `console.html` | `/console`、`/console/login`、`/console/register`、`/console/overview`、`/console/keys`、`/console/usage`、`/console/billing`（+ `/console/docs`、`/console/help` 占位）+ 404 |

`vite.config.js` 内置 `consoleEntryRewrite` 插件，在 dev 与 preview 下把 `/console/**` 的直达请求内部改写为 `console.html`。

> **部署要求**：生产环境必须在网关做同构改写 —— `/console` 与 `/console/**` → `console.html`，其余 → `index.html`，均返回 200（history 路由回退）。否则直接打开 `/console/overview` 会 404。

锚点约定（§2.3-5，**均已实测可滚到位**）：`/#resources`、`/#tech`、`/#api`、`/#seals`、`/#contact`、`/pricing#overage`。

## 数据源切换（§8.3）

```bash
VITE_DATA_SOURCE=mock   # 默认：内存 mock（本轮）
VITE_DATA_SOURCE=api    # 真实实现：src/data/api/impl.js（本轮未接入，会明确失败，不返回假数据）
```

- 浏览器端只能读 `VITE_` 前缀变量，代码内统一暴露为 `DATA_SOURCE`（`src/config/env.js`，唯一读取点）。
- 页面**只能** `import { ... } from '@/data'`；**禁止** import `@/data/mock/**`，否则切真库时会漏网（§8.3-3）。

## 跨入口导航纪律（M1-P1 验收 D1 修复；必须遵守）

营销入口（`index.html`）与控制台入口（`console.html`）**各有一份 vue-router 路由表，互不包含对方前缀**。因此：

- **同入口内**跳转 → `<router-link>`（保留 history 语义，如控制台侧栏四条）。
- **跨入口**跳转 → 一律原生 `<a href>` **整页跳转**。营销侧点 `/console/**` 会被自己的 catch-all 吞掉（渲染营销 404 页），控制台侧点 `/`、`/pricing`、`/demo` 会渲染空视图（纯白页）。
- 组件 `src/components/EntryLink.vue` 按「当前入口（`route.meta.entry`）× 目标前缀」自动选择 `<a>` / `<router-link>`，新增跨入口链接一律用它，不要手写 `<router-link to="/console/...">`。

## 图片双通道（R17 / v1.5 口径）与适配层 A27 / A30 / A31

| 方法 | 说明 |
| --- | --- |
| A27 `getDisplaySlices(assetId)` | 展示切片组：**恰好 2 片**，每片各带独立短期签名占位 URL（`about:placeholder#…`，不外链）；切向/切位由 `assetId` 固定种子派生，同一会话稳定。**不返回原图直链**。 |
| A30 `getOriginalQuota()` | 原图额度快照（§3.9 `originalDownloadQuota`）：`{policy:'freeQuotaThenOverage', scopeKey, freePerDay, unitPriceCents, usedToday, freeRemainingToday, overageToday, chargedTodayCents, resetAt, cstDate, timezone}`。**未登录 → reject `UNAUTHENTICATED`**（账号维度数据）。 |
| A31 `requestOriginalDownload(assetId)` | 主动申请原图下载：**先扣每日免费额度（≤ `freePerDay` 张不收费）→ 额度用尽后按 `unitPriceCents` 从充值余额扣减、不设每日上限 → 仅余额不足时拒绝**（`UNAUTHENTICATED` / `INSUFFICIENT_BALANCE`；`DAILY_LIMIT_EXCEEDED` 已退役）。额度只由成功签发抵扣；**`charged.freeApplied` ＝ 本次占用免费额度张数（0/1）**，与 `overageCount` 互补。 |

- 额度策略、免费张数、超出单价与全部文案数字集中在 `src/config/pricing.js` 的 `ORIGINAL_QUOTA_POLICY`（经 `getOriginalQuotaPolicy()` 解析）：**策略切换只改这一处**。
- 页面**不得自行累加额度计数、不得自行相乘算金额**（§8.3-3）：一律取 A30 / `getAccount()` 的 §3.10 字段。
- 展示切片张数与签名 TTL 同样来自配置（`getPricingTable().displaySlices`，TTL 默认 300s ＝ §11.2 待决 22）。
- **防护定性（R17d）**：切片只是展示层辅助手段，**无法阻止专业爬虫拼接**；原图权限完全由后端鉴权控制。禁止夸大表述。

## 验证基线（最近一次实跑）

```text
npm run check:pricing → ✓ 价格字面量静态检查通过（spec §4.3 / AC-19）
npm run smoke         → ✓ 全部通过（77 项断言）
npm run build         → ✓ built（dist/index.html + dist/console.html）
```

浏览器实测（fresh `--user-data-dir` headless Chrome + CDP，复用 5164 上已在跑的 dev，不新起服务）：

- 首页 4 张样例卡 × 2 片切片 = 8 个 `.slice-layer`；两片 clip-path 互补；右键 `contextmenu` `defaultPrevented=true`、`dragstart` `defaultPrevented=true`、`draggable="false"`、`user-select:none`；`<img>` 0 个、请求来源仅 `http://localhost:5164`。
- 锚点滚动实测：`#resources` 519/519、`#tech` 971/971、`#api` 1791/1791、`#seals` 2369/2369（scrollY = 区块 offsetTop）；`#contact` 3043（页尾到底，标题在视口内）；`/pricing#overage` 387、`#overage` 距顶 24px。

## 关键文件

| 关注点 | 位置 |
| --- | --- |
| 设计 tokens（唯一视觉来源） | `src/styles/tokens.css` |
| 共享基础样式（由 v1 搬运） | `src/styles/base.css` |
| 定价与计费口径（唯一数据源） | `src/config/pricing.js` |
| 站点配置 / 开关位 / 演示账号 | `src/config/app-config.js` |
| 数据源开关 | `src/config/env.js` |
| 适配层契约（枚举 + A1–A31 清单 / 33 个方法） | `src/data/contract.js` |
| 适配层入口（页面只 import 这里） | `src/data/index.js` |
| mock 实现 / 种子数据 | `src/data/mock/impl.js`、`src/data/mock/seed.js` |
| 首页 / 计费规则页 | `src/pages/marketing/HomePage.vue`、`src/pages/marketing/PricingPage.vue` |
| 图片双通道轻演示组件 | `src/components/SlicePreview.vue` |
| 路由表 | `src/router/marketing.js`、`src/router/console.js` |
