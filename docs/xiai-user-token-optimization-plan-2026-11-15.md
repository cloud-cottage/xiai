# 实施口径：xiai-user-token 性能与一致性优化（P0 / P1 / P2）

- 状态：**Kevin 2026-11-15「P0P1P2 都做，开工吧」**
- 性质：实施口径件（非规范）。供实现 / 质检单作唯一口径真源。
- 边界：**不做深度拆分**（不拆函数、不按域拆 ops.js）。只做小步、可回滚、有套件兜底的改动。

## P0-1 索引（DB 配置，零代码）

按代码实测的查询条件给出（`readRows(集合, 条件)` 现取）。控制台建，**只增不删**。

> **（2026-11-15 更正）** 下表首版把勘误面字段写成 `face_id` / `uid`，现盘代码实为 **`faceId`（驼峰）**
> 与 **`user_id`**。字段名、查重 pipeline、分批顺序、验证方法一律以
> **`docs/xiai-index-checklist-2026-11-15.md`** 为准（本表仅留作口径演变记录）。

| 集合 | 索引 | 类型 | 依据 |
|---|---|---|---|
| `xiai_seals` | `stamp_id` | 单键 | 详情页按章号取 |
| `xiai_seals` | `view_count` desc ＋ `created_at` desc ＋ `stamp_id` desc | 复合 | 首页热度排序三键（`listSealCards`） |
| `xiai_faces` | `stamp_id` ＋ `kind` | 复合 | 10 处按章取面 |
| `xiai_faces` | `face_no` | 单键 | 发号查重 |
| `xiai_images` | `sha256` | 单键（唯一） | 内容寻址 4 处 |
| `xiai_images` | `stamp_id` | 单键 | 整章图与面图读 |
| `xiai_images` | `book_id` | 单键 | 印谱归属（新） |
| `xiai_corrections` | `face_id` ＋ `created_at` desc | 复合 | 勘误列表 2 处 |
| `xiai_corrections` | `status` ＋ `created_at` desc | 复合 | 管理员待审面（`status` 15 处） |
| `xiai_correction_summaries` | `face_id` ＋ `field` ＋ `value` | 复合（唯一） | 值级摘要单行 |
| `xiai_endorsements` | `face_id` ＋ `field` | 复合 | 采信查重 |
| `xiai_persons` | `card_id` | 单键（唯一） | 作者引用（`uid`/`id` 外用） |
| `xiai_books` | `id` | 单键（唯一） | 印谱幂等查重 |
| `xiai_*_imports` | `batch_id` | 单键 | 导入批读面（4 集合同形） |
| `xiai_*_imports` | `source_*_id` | 单键 | 导入去重（4 集合同形） |
| ledger / usage | `uid` ＋ `created_at` desc | 复合 | 积分与用量查询（`uid` 108 处为最大宗） |
| ledger | `idem_key` | 单键（唯一） | 幂等键 |

**禁止**：本批不删任何现有索引、不改集合权限规则。

## P0-2 静默截断 → 显式（代码）

**问题**：14 处 `readRows(集合, {}, { limit })` 到顶即静默截断，导致查重/引用存在性判定在数据超限后**悄悄失效**。

**做法**：
1. 新增**单一辅助函数** `readAllGuarded(collection, options)`（落在 `lib/ops.js`，导出）：
   - 按批翻页取全（游标/`skip` 皆可，需与既有 `readRows` 兼容），硬上限 `SCAN_HARD_CAP = 20000`；
   - 返回 `{ ok: true, rows, truncated: boolean }`；抛错沿用既有 `STORAGE_UNAVAILABLE` 语义。
2. **判定类调用点**（查重 / 引用存在性 / 发号）⇒ `truncated === true` 一律**结构化拒绝**（`STORAGE_UNAVAILABLE`，文案：「集合行数超出可校验范围，本次零写入」）。这类点宁可拒绝，不得给错数据。
3. **非判定类调用点**（仅用于展示/统计）⇒ 允许截断，但必须**在回包或上屏提示「僅統計前 N 行」**，不得静默。
4. 已有 14 处逐个归类并注明理由（判定类 / 展示类），写进实现报告。

## P1-4 热路径并行化

只改三处最热，独立读改 `Promise.all`：
1. 首页卡片分页（`lib/sealCards.js::listSealCards` 及其依赖读）；
2. 印章详情（api 面读章/面/影像三集合）；
3. 我的勘误（本用户勘误行 ＋ 摘要面）。

**约束**：有因果依赖的读不得并行（先读章再按章读面这类必须串行）；并行后**回包键面与语义逐字不变**。

## P1-5 N+1 批量化

只挑高频 4 处：逐 face 读影像、逐 face 读勘误摘要、逐行发号预查、逐图取字节元数据。改成循环外批量取（`where in` 或一次读后建 Map）。

## P1-6 回执判据统一

全仓扫「以写回执判成功」的写法（`updated >= 1`、`stats.updated`、`affectedRows` 之类），**一律改读回比对**。样板 ＝ `lib/books.js::setImageBook`（写完按同一检索式重读、逐字比对目标值；不一致 ⇒ 结构化失败，绝不报假成功）。

## P2-7 超时 / 内存

现为 900s / 1024MB。**本批不改数值** —— 先经 P2-8 埋点拿到 P99 再定，避免盲调打断导入批与 AI 异步链。

## P2-8 结构化日志

新增单点 `lib/log.js`（`info/warn/error` ＋ 可选 `durationMs`），替换 37 处 `console`；敏感字段（手机号/令牌/密钥/连接串）**只允许出现字段名，不得出现值**。慢调用阈值日志：单 op 超 3s ⇒ `warn`。

## P2-9 传输瘦身

列表类 op 只回投影字段（卡片 DTO 仍恰 14 键，不得增键）；影像行不回 `palette` 等展示无关键。

## 验收（每批必跑）

- `node scripts/run-verify-suite.sh`（全量 47 套）**必须全绿**；
- `ADMIN_OPS` 仍 47、`PUBLIC_OPS` 4、`PUBLIC_WRITE_OPS` 1、`[data-admin-action]` 12、`reason` 13；
- 卡片 DTO 仍 14 键；
- 截断改动：新增用例覆盖「到顶 ⇒ 判定类拒绝 / 展示类提示」。
