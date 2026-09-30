# 玺爱 · 篆刻知识分享平台（H5）

印章（藏品）在线浏览与知识共建平台。前端为纯静态单页应用，数据落在浏览器本地，
**零后端、零外部网络请求**（不引入任何第三方 UI 库、外部字体或 CDN 资源）。

## 工程与运行

- 工程根：`/Users/kevin/bistro/xiai`
- 端口：`5163`（`vite.config.js` 中 `strictPort: true`，端口被占用会直接报错，不会静默改端口）
- 访问地址：`http://127.0.0.1:5163/`

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖（vue ^3.5、vue-router ^4.5） |
| `npm run dev` | 启动本地开发服务（127.0.0.1:5163） |
| `npm run build` | 产出静态构建到 `dist/` |
| `npm run preview` | 本地预览构建产物（127.0.0.1:5163） |

## 登录与账号

- 登录方式：手机号 + 验证码。
- 开发（演示）环境验证码固定为 **1234**，不发送真实短信。
- 使用任意符合格式的手机号登录即为普通用户，首次登录自动创建账号并赠送 50 金。
- **管理员账号手机号：`16601061656`**（昵称「库守」）：它是**唯一管理员**。管理员在界面上比普通用户**多出编辑入口**（当前落在「管理员专区」页；按最新口径将改为普通页面内的**管理员专属按钮**——璽印匯類的「上传印章」、印章详情页的「编辑固定属性」、我的勘误记录页的「采纳 / 驳回」，页面侧属下一轮）。
  该号是**唯一管理员**，其唯一真源为数据层常量 `ADMIN_PHONE`（`src/data/seed.js`），
  本 README 与实现均引此处，不另立第二个来源。
- **原管理员号 `13800000001` 已不再是管理员**（既不在种子中，也不再是 `admin`）：
  老库里若残留该账号，引导时会被**就地降为普通用户**（保留该行与其金余额，不清库）。
- 管理员唯一性由数据层在**每次引导**时按 `ADMIN_PHONE` 就地纠正（见 `src/data/db.js`
  的 `reconcileAdminRoles()`）：该号为 `admin`（缺失则建号），其它任何号若仍是
  `admin` 一律降为 `user`。**不依赖清空浏览器存储、也不依赖升存储命名空间版本**，
  已有账号数据（金余额 / 勘误 / 照片 / 登录态）不受影响。
- 种子中的普通用户账号：**13800000002**（昵称「印友」）。
- 登录态保存在本机浏览器中，刷新页面不丢失。

## 权限

| 能力 | 游客 | 普通用户 | 管理员 |
| --- | --- | --- | --- |
| 浏览印章、印面与实物照片 | 可 | 可 | 可 |
| 提交勘误 | 不可 | 可 | 可 |
| 上传实物照片 | 不可 | 可 | 可 |
| 扣金下载高清印面 | 不可 | 可 | 可 |
| 编辑印面固定属性 | 不可 | 不可（且不显示编辑入口） | 可 |
| 上传印章（新增进藏品库） | 不可 | 不可（且不显示入口） | 可 |

数据层对越权写有独立拦截：即使绕过页面入口，非管理员写**五类**数据（新增印章 / 新增印面 / 上传印面图 / 编辑印面固定属性 / 审核勘误）也会被拒绝——数据层抛 `PermissionError`，服务层返回 `{ ok: false, reason: 'PERMISSION_DENIED' }`，两类都不静默放行。

「上传印章」＝「新增印章 + 新增印面 + 上传印面图」（边款图可选）。新增印章必须带**广场筛选维度**（朝代 / 分类），缺失即拒且不产生半成品记录；**印文（`seal_name`）为选填**，留空则对外显示「佚名」。同一印章重复上传同一张印面图不产生重复印面（印章级按 `(印文, 朝代, 分类, sha256(印面图))` 判重，印面级按 `(所属印章, 类别, sha256)` 判重）。入口是**璽印匯類页内的「上传印章」按钮**（管理员专属，普通用户不渲染）——按钮侧属下一轮页面工作，本轮已备好数据层与服务层。

## 业务口径

- **印章编号口径**：新建印章的编号＝**`XA` + 9 位零填充序号**（第 1 枚 ⇒ `XA000000001`），生成时**跳过已占用**编号；**既有种子编号 `XAI-0001`…`XAI-0008` 一律保留、不改写**，也不参与新序号的递增（解析只把 `^XA\d{9}$` 当序号，旧式 `XAI-000x` 不会被误解析成序号）。印面 id / 影像 id 的编号模板不变（仍按印章序号派生）。
- **「印章名称」概念已删：名称＝印文**——印文即 `seal_name`（与平台 `sealName` 同源），**新增印章时选填**；显示取值顺序为「印文简体字（`transcription_simplified`）→ 印文（`seal_name`）→ **佚名**」，都为空即显示「佚名」。
- 新增印章的**必填**仅剩 **朝代 / 分类 / 印面图**（`seal_name` 不再必填）；**印章级防重键＝`(印文, 朝代, 分类, sha256(印面图))`**（印文可为空串）。
- **印章 1 对 N 印面**（数据层有独立的印面集合 `faces`）；边款是 `kind = EDGE` 的特殊印面。种子中已含多印面样本（`XAI-0001`：2 个印面 + 1 个边款）。「默认 1 印面 = 1 印章」只是新建种子时的默认值，不是模型限制；印章另有分组字段供后续合并。
- 印面是属性的归属载体，**三类属性都按印面归属**（同一枚印章的不同印面可以各有自己的印文与释义）：
  1. **固定属性**：印面图片、材质、边款图片 ID。仅管理员可改，且**按印面逐项编辑**；边款图片 ID 指向影像清单中的编号，保存后详情页边款区即按该编号展示影像；编号在影像清单中不存在时页面给出可读空态。
  2. **可标记属性**：印文简体字、印文古字、朝代、分类、作者、印文释义。用户可提交勘误（勘误按印面归档），勘误不覆盖原始数据；平台汇总后择可信者对外展示。
  3. **影像属性**：登录用户可上传印章实物照片。
- **影像存储口径（重要）**：印面图 / 边款图的**二进制走 IndexedDB**（`src/data/blobstore.js` 是全工程唯一直接读写 IndexedDB 的模块），`localStorage` **只存元数据**（`id` / `kind` / `sha256` / `bytes` / `width` / `height` / `colorMode` 等标量字段）。理由：`localStorage` 上限约 5 MB，而单张 400 dpi 印面图就可能几百 KB，直接塞必炸。页面要显示影像须经服务层 `seals.loadImageDataUrl(imageId)` 取回（**不得**自行读写 IndexedDB）；页面与组件**不得**直接读写 `localStorage` / IndexedDB。
- 积分单位「金」：新账号初始 50 金；下载高清印面按**印章**计费，每次 5 金，同一印章在同一次页面会话内重复下载不再二次扣费；勘误被采纳每条奖励 10 金。
- 勘误状态三态冻结：`PENDING`（待审核）/ `ACCEPTED`（已采纳）/ `REJECTED`（驳回），单向迁移、终态不回退、同字段多条按可信度汇总后展示。**审核动作（采纳 / 驳回）是奖励的唯一触发路径**，采纳时自动发放奖励（每条只奖一次）。旧版本落盘的 `APPROVED` 值在读取时自动归一为 `ACCEPTED`。审核载体正在从「管理员专区」迁往「我的勘误记录」页内的「采纳 / 驳回」按钮（管理员该页可见**全部用户**的 `PENDING`）——服务层已备好 `corrections.listPendingForAdmin(actor)` / `corrections.review(actor, id, decision)`，页面侧属下一轮工作。

## 数据层

- 纯前端 mock：种子数据 + 浏览器本地存储持久化。
- 页面与组件只通过 `src/services/` 抽象层访问数据，不直接读写浏览器存储；`src/data/storage.js` 是全工程唯一接触 `localStorage` 的模块，`src/data/blobstore.js` 是全工程唯一接触 **IndexedDB** 的模块（影像二进制）。
- 集合划分：印章 / **印面** / 影像 / 用户 / 勘误 / 积分流水 / 实物照片。印面行同时给出规范字段名 `id` / `sealId` / `kind`，并保留 `stamp_id` 作为 `sealId` 的兼容别名。
- 影像二进制经**数据层统一出口**落盘（`db.js` 的 `putImageBinary` / `getImageBinary` / `hasImageBinary` / `deleteImageBinary` 包装 `blobstore.js`）；二进制键口径 `asset:<影像 id>`，`localStorage` 里的影像行只存元数据并标 `storage: 'indexeddb'`。
- **「上传印章」的服务层入口（本轮冻结，函数名不得改）**：
  - `seals.createSealWithFace(actor, payload)` —— 新增印章 + 印面 + 印面图（可选边款图）；`payload` 必填 `dynasty` / `type`（＝`category` / `seal_type`）/ `faceImage`（二进制或 dataURL），**`seal_name`（印文）为选填**（旧键 `name` 保留为兼容别名；留空则显示「佚名」），可选 `material` / `edgeImage`；成功返回印章与印面视图模型 + 影像元数据。
  - `seals.updateSealFixedAttributes(actor, faceId, patch)` —— 按印面编辑固定属性（`face_image_id` / `material` / `edge_image_ids`）。
  - `corrections.listPendingForAdmin(actor)` —— 全部用户的 `PENDING` 勘误（非管理员返回空集，数据层同口径拒绝）。
  - `corrections.review(actor, correctionId, decision)` —— `'ACCEPTED'` / `'REJECTED'`；采纳 +10 金且每条只奖一次。
  - 四个入口均返回结构化结果（`{ ok, reason, message }`），非管理员不静默放行；另有 `seals.loadImageDataUrl(imageId)`（取回影像二进制供渲染）与 `seals.canUploadSeal()` / `corrections.canReviewCorrections()`（供页面决定是否渲染管理员按钮）。
- 写入的印章带 `source: 'manual'`（区别于斐萃汇入）、`uploaded_by`（上传者 id）与 `created_at`；id 生成扫描既有记录取下一个未被占用的编号（印章编号为 `XA` + 9 位，见「业务口径」），不与既有冲突。
- 种子版本升级时只做加法：补新增集合与影像、把旧版挂在印章行上的固定属性搬到对应印面，用户数据（勘误 / 照片 / 积分 / 登录态）不受影响。
- 管理员账号唯一性：管理员手机号以数据层常量 `ADMIN_PHONE` 为唯一真源；引导时（每次进入应用）
  数据层对 `users` 做一次**幂等就地纠正**——该号强制 `admin`（缺失则建号），非该号而仍为
  `admin` 的降为 `user`。**只改 `role` 一个字段**，不删用户行、不清存储、不升命名空间版本。
- 演示数据不含真实图象：印章用印文字符呈现，下载「高清印面」得到的是包含印面资料与影像摘要的清单文件。

## 我的雲盤（資料夾 / 分享 / 邀请｜数据层 ＋ services 契约）

> 本节为 **v1.21 新增面（K-1：数据层 ＋ services）** 的**实现侧登记**；UI 面（三入口 ＋ 分享页）属另一单。
> 数值口径（10 / 30 天 / 8 位 / 9 位 / 前 3 枚）的**唯一写值处仍是规范 §5.1 与 §3.21**，
> 本工程内一律经 `src/services/drive.js` / `src/services/points.js` 的具名常量取值，**组件里不得硬编码**。

- **存储键（新增 5 个，登记于 `src/data/storage.js` 的 `STORAGE_KEYS`；既有 13 键未改、未删、未改名）**：
  `seallists` / `seallist-items` / `shares` / `invites` / `invite-reward`（真实键名 ＝ 命名空间 `xiai:v1:` ＋ 该字面值）。
  元数据进 `localStorage`，二进制仍进 IndexedDB；写方一律只经 `src/data/storage.js`，
  四条集合与配置键的集合级读写落在 `src/data/drive.js`。
- **資料夾编号口径**：`SL` ＋ **9 位零填充**（首号 `SL000000001`，自存量最大号 ＋1 连续递增、全局唯一）；
  与印章编号 `XA` ＋ 9 位是**两个互不替代的编号面**。
- **夹内排序＝加入时间倒序**（`added_at` 降序）；**同 `added_at` 时的确定序 ＝ 引用行 `id` 降序**
  （规范 §4.1.8 表下注 ③ 要求把同值时的确定序写明 ⇒ 即本行；实现见 `services/drive.js` 的 `byTimeDesc`）。
- **引用式**：資料夾引用行只持 `seal_id`（不落印文 / 影像 id / 影像字节副本）；「移出資料夾」＝ 删那条引用行，
  印章本体、其它资料夹的引用行都不动。**重复存入幂等**（同夹同印仍 1 行、`added_at` 不变）。
  枚数与条目 id 数组**现场派生**（資料夾行内不落第二份计数）。
- **分享**：短碼 ＝ 8 位小写 ASCII 字母或数字（全局唯一）；`expires_at ＝ created_at ＋ 720 小时`（＝ 30 天）；
  「重新生成」⇒ 旧行立刻落 `revoked_at`（**不删行**）＋ 新行新 `code`；同一資料夾任一時刻**至多 1 条有效分享**
  （`createShare` 遇到既有有效链接时**沿用**它，要换链接请走 `regenerateShare`）。
  有效 / 过期 / 已作废**一律现场派生**，不落第二份状态字段。
- **未登錄分享页投影**：`drive.resolveShare(code)` 在**投影层**摘除被遮内容 —— 未登錄返回
  名 ＋ 印數 ＋ 夹内倒序**前 3 枚**（`visible_items`），第 4 枚起的印文 / 缩略图**不在返回物件内**；
  登錄后（含非擁有者）返回完整清单（只读）。遮罩引导句逐字「登錄後查看完整清單」由该返回值给出。
- **邀请註冊奖励**：默认 **10 金**（邀请人与被邀请人**各 10**），触发时点 ＝ 被邀请人**註冊成功**；
  运行期可改值落配置键 `invite-reward`（`{invite_reward: <number>}`，非负整数，**仅管理员**可写）；
  幂等（同一邀请关系只结算一次，`invite.settled_at` 非空即不再发放）；发放值快照进 `invite.reward`，
  **历史流水与历史邀请行不改写**。邀请关系**只落 `invites` 行** —— `users` 行新增邀请相关键
  ⇒ `INVALID_FIELD` ＋ 零写入。
- **服务层入口（K-1 冻结；函数名不得改）**：`services/drive.js` 的
  `createFolder(name)` / `listMyFolders()` / `getFolder(folderId)` / `listFolderItems(folderId)` /
  `addSealToFolder(folderId, sealId)` / `removeSealFromFolder(folderId, sealId)` /
  `createShare(folderId)` / `regenerateShare(folderId)` / `activeShareOf(folderId)` /
  `resolveShare(code)`；`services/points.js` 的 `readInviteReward()` / `inviteRewardValue()` /
  `settleInviteReward(inviterId, inviteeId)`（＋ 第 4 类流水常量 `LEDGER_TYPE.INVITE ＝ '邀請註冊'`、
  默认值常量 `INVITE_REWARD_DEFAULT`）；`services/admin.js` 的 `setInviteReward(actor, value)`。
  均为结构化返回（`{ ok, reason, message, … }`）；越权写 ⇒ `FORBIDDEN` ＋ 零写入，
  非法值 ⇒ `INVALID_VALUE` ＋ 零写入。
- **註冊结算钩**：`auth.login(phone, code, { inviterId })` —— 仅在**新建账号**那一次（＝被邀请人註冊成功）
  触发结算；老账号登录不触发。邀请入口 / 邀请码的形态属待裁项（规范 §11 W-23）⇒ 本工程未新增任何邀请入口形态，
  数据层只提供 `inviterId → 结算` 的钩子；资料夹改名 / 删除 / 名称上限 / 夹数上限同属待裁项（W-25），实现侧未做。

## 目录

```
src/
  components/   通用组件（顶栏、侧栏、筛选条、印章卡片、确认弹窗、占位面板）
  data/         mock 数据底座（种子、仓库、登录态、localStorage 存储、IndexedDB 影像库 blobstore、影像二进制工具 assetmeta）
  router/       路由与权限守卫
  services/     业务服务抽象层（印章、勘误、照片、积分、管理员、登录）
  styles/       设计令牌与基础样式
  utils/        格式化与本地文件工具
  views/        页面：璽印匯類、印章详情、我的勘误记录、我的实物照片、积分中心、管理员专区、登录
```

## 自测

```bash
npm run build                                   # 构建必须成功
npm run dev                                     # 另起终端
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5163/
lsof -nP -iTCP:5163 -sTCP:LISTEN                # 监听证据
```

页面为单页应用，任意深链（如 `/seal/XAI-0001`）都由开发/预览服务回落到索引页，再由前端路由分发。
