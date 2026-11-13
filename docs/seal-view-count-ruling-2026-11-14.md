# 印章浏览量（`view_count`）与首页热度排序 —— 需求裁定件

- 状态：**已裁定**（Kevin 2026-11-14 CST，四问四答）
- 性质：**非规范**。本件是并发实现 / 规范 / 质检单的**唯一口径真源**；规范条款由 Jing 落 `docs/xiai.spec.md`。若本件与规范冲突，以本件为实现契约并当场回报冲突，不得静默择一。
- 派单方：Zang。实现：Kong（云函数 / 前端两张单）。规范：Jing。质检：Neng（串行，待实现落盘）。

## 一、口径（照登，四问四答）

1. **计数**：A 轻 —— 匿名也计；印章详情页打开即 +1；**同一浏览器同一枚 24 小时内只计一次**。
2. **卡片**：**不显示**浏览数；`listSealCards` 卡片 DTO 仍**恰 14 键**（冻结断言不动）。
3. **排序**：**统一** —— 首页默认列表与筛选 / 搜索态**都**按 `view_count` 倒序。
4. **触点**：`/seal/:id`（详情页）与 `/s/:code`（分享页）**都计**；列表曝光不计。

## 二、数据契约

- 字段：`xiai_seals.view_count`，整数且 ≥ 0，缺省 0。
- **只由服务端 `inc` 维护**；客户端（含管理员 UI）不得直写该字段。
- 不进任何客户端集合读面，不进卡片 DTO，不进 `q` 检索字段表。
- 缺失视同 0；排序上线前必须先回填（第五节）。

## 三、排序契约（`listSealCards`）

- DB 链顺序写死：`where(筛选) → orderBy('view_count','desc') → orderBy('created_at','desc') → orderBy('stamp_id','desc') → skip(offset) → limit(window)`。
- 第三键 `stamp_id` **只为稳定序**（同 `view_count` 同 `created_at` 时防分页重漏），不改变业务语义、不对外暴露。
- **全态同一序**：无条件 / `dynasty`+`category` / `q` / 面筛选（`seal_type` / `face_style`）一律同一热度序。
- 面筛选路径改为「**先按热度读印章页 → 批量读该页 FACE 行 → 按主印面命中过滤**」（原「面候选 → 印章」顺序反转，因热度序必须由印章侧决定）。窗口因子 / 上限 / 轮数沿用现值（`CARD_SEAL_WINDOW_FACTOR` / `CARD_SEAL_WINDOW_MAX` / `CARD_SEAL_WINDOW_ROUNDS`），命中率过低时按既有 `has_more` 如实上报，**绝不谎报「已到底」**。

## 四、分页契约

- `cursor` **语义变更**：原「上一页末枚 `stamp_id`」→ **偏移量**。形态 `off:<n>`（`n` 为十进制非负整数，0〜7 位），空串＝首页。
  - 该形态与前端本机退路 `LOCAL_CURSOR_PREFIX = 'off:'` **同形** ⇒ 视图层 `next_cursor` 原样透传逻辑**零改动**。
  - 形态不符（含旧 `stamp_id` 形态、负数、超长）⇒ `INVALID_VALUE` ＋ **零读取**，文案写明「游标形态已变更，请刷新页面」。
- `next_cursor`：`has_more` 为真 ⇒ `off:<offset + rows.length>`；否则空串。
- `has_more`：仍以「多取 1 枚卡片（`limit + 1`）」为判据；窗口轮数用尽而候选未尽 ⇒ `true`。
- `total` 口径**不变**（四维 ＋ `q` ＋ `face_count >= 1` 的命中总数，服务端 `count()`）。
- 载荷**仍恰 7 键** `{limit, cursor, dynasty, seal_type, face_style, category, q}`，**不新增键**。

## 五、前置回填（`repairSealViewCount`，新管理员 op）

- 入 `ADMIN_OPS`：**39 → 40**（现盘 `node -e` 枚举为 39，键名字典序插入位置须由实现方现取校验）。
- 载荷封闭**恰 3 键** `{dry_run, limit, cursor}`：`dry_run` 缺省 `true`（给了但非布林 ⇒ `INVALID_VALUE`）；`limit` 1〜500、缺省 200；`cursor` ＝ 上轮 `next_cursor`（`_id` 双向游标，必须随载荷回传）。
- 回包恒**恰 5 键** `{ok, scanned, eligible, written, next_cursor}`；`dry_run` 与真写同形（`dry_run` 时 `written` 恒 0）。
- `eligible` ＝ `view_count` 缺失、或非整数、或 < 0 的行；写入值 0；`written` 由**整窗读回**判定（不得由写调用的 resolve/reject 驱动）。
- 索引：建议人类在控制台建复合索引 `(view_count desc, created_at desc, stamp_id desc)`。**无索引亦可跑**（真库 1252 行，实测多字段 `orderBy` ＋ `skip` 已可用）⇒ 登记为「可选前置」，不得写成阻塞项。

## 六、计数契约（新公开写面）

- `cloudfunctions/xiai-user-token/index.js` 新增分流：`action === 'public-write'`，位置在**令牌 / 会话 / 配置判定之前**（与 `action === 'public'` 同级）。
- 白名单 `PUBLIC_WRITE_OPS`（新常量，落在 `lib/sealCards.js` 导出于 `index.js` 消费）**恰 1 成员**：`bumpSealView`。
- **`PUBLIC_OPS` 仍恰 4 成员且恒零写** —— 既有「公开读面零写」断言一字不动，两张表分开可判负。
- op `bumpSealView`：
  - 载荷封闭**恰 1 键** `stamp_id`：非字符串 / trim 后空 / 长度 > 64 ⇒ `INVALID_VALUE`（零读）。
  - 印章行不存在 ⇒ `INVALID_VALUE` ＋ 文案「該印章不存在」（**不得用 `NOT_FOUND`**：user-token 侧 `REASONS` 无该值，会退化成 2 键回包）。
  - 写面：对命中行 `command.inc(1)`，**原子**；不写流水、不计费、不产 `plan`。
  - 成功回包**恰 1 键** `ok:true`；失败**恰 3 键** `ok / reason / message`。
  - **无幂等**：每次调用都 +1（去重职责在客户端，见下）。
  - 存储故障 ⇒ 结构化失败（不得 5xx），前端 fail-open。
- 客户端去重：`localStorage` 单键 `xiai.sealview.v1`，值 `{ 印章编号: 毫秒时间戳 }`；同章 24h（86,400,000 ms）内跳过；表项 > 200 按时间戳淘汰最旧；`localStorage` 不可用 ⇒ 照发（不阻断浏览）。

## 七、前端接线

- `src/views/SealDetailView.vue`：印章解析成功（`seal` 非空）后触发**一次**；失败**静默**（不弹提示、不阻塞渲染、不改既有错误态）。
- `src/views/ShareView.vue`：解析到印章编号后同法一次。
- 新增服务层门面（落在 `src/services/sealCards.js`），信封在 `src/services/token.js` 按 `action:'public-write'` **新增一条同形收窄分支**；既有两个收窄分支的键集逐字不动。
- 上屏文案一律繁体（`s2t(x) === x`）。本单预期**零新文案**（计数静默）。

## 八、不可动项（越界即退回）

- 卡片 14 键及其取值规则；`total` 口径；`face_count >= 1` 过滤；`q` 检索 12 字段表；`PUBLIC_OPS` 4 成员且恒零写；零全表扫描做分页；`reason` **零新增字面值**。
- 实现单不碰 `scripts/verify-*.mjs`（属质检写集），只在报告里自曝预期红与每条一行修法。

## 九、顺序与判据

- 部署顺序：**云函数先**（新 op 上线）→ 前端 push。**质检通过才推送**。
- 套件禁连生产（哨兵 `XIAI_NO_REAL_CARD=1` / `env -u`），本仓基线非全绿 ⇒ 红必须与 HEAD 副本逐条对拍后定性。
- 生产端到端判据（缺一不可）：
  1. 回填后 `xiai_seals` 中 `view_count` 有值行数 = 1252 / 1252；
  2. 打开一枚详情页后该行 `view_count` **+1**（回读比对，非仅「请求 200」）；
  3. 首页首屏顺序 = `view_count` 降序、同值按 `created_at` 降序（取 ≥3 页比对）；
  4. 连续翻到第 3 页，三页 `stamp_id` 集合**无重无漏**；
  5. 匿名直打 `public-write` 的 `bumpSealView` 成功、匿名直打 `PUBLIC_OPS` 老 op 仍是原行为（读面零写不变）；
  6. 未登录访问详情页/分享页，浏览量同样 +1（匿名计数生效）。
