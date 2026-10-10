# 增量件：印谱（item）導入通道（**v1.61**）

**件别**：规范增量说明件（**只增行、不改任何既有行**）。
**主文件**：`docs/xiai.spec.md`（v1.60 → v1.61）。
**修订人**：Jing（规范 / 口径）。**时点戳**：2026-10-10（CST）。
**改前基准**：主文件 v1.60 態（md5 `7730edbff01eb5249d51b90925b27e02`、8,191 行 / 3,671,398 B）。
**第 0 步快照**：`docs/versions/xiai.spec.v1.60.md`（`cp -p` ＋ `cmp` 逐字节一致、同 md5 / 同字节数）。

---

## 1. 本版落位汇总（可机械核对）

- 新增节：**§3.59（含 §3.59.1 〜 §3.59.13）＋ §4.1.18 ／ §4.1.19**
- 新增判据：**§10.59（`AC-527` 〜 `AC-537`，共 11 条）**
- 集合清单修订注：**§3.33.3 追加修订注（v1.61）**
- 追溯码：**§1.4 追溯码（v1.61 追加）**
- 计数留痕：**§10.7 留痕（v1.61 更新）＋ §11 計數留痕（v1.61）**
- 待裁 / 收口行：**§11 `W-90`（登记即收口 ＝ 已裁）／ `W-91`（待裁）**
- 表头三处：**版本摘要行（行首前置 v1.61）＋ 最近修订行（v1.61）＋ 依据 / 被引用输入与时点 / 本次登记的基准版本（v1.61 追加）**
- **§12 变更记录 v1.61 行** ＋ **页脚横幅 v1.61** ＋ **页脚留痕（v1.61）**
- 本增量件：`docs/spec-increments/item-channel-v1.61.md`

## 2. 集合清单（19 → 21）

主集合 **`xiai_items`** ＋ 导入行集合 **`xiai_item_imports`**（均 `xiai_` 前缀）。
清單由 19 项增至 **21** 项；上列 19 项逐字未删、未改名、未改顺序（沿「清單擴容 ≠ 清單推翻」體例）。

## 3. 口径逐条（X1 〜 X10，逐条照登）

- **X1 集合与命名**：`xiai_items`（主）/ `xiai_item_imports`（导入行）⇒ 集合清单 19 → 21。
- **X2 導入通道 ＝ 三段式**：`submitItemImport` → `xiai_item_imports`（`PENDING` 暂存）→ 管理员在「我的勘误记录」页「待審導入批次」**第三块（印谱導入）**逐条 / 整批采纳 / 驳回 → 采纳落 `xiai_items`；**驳回零写入**；**两态终态不回退**。
- **X3 冪等与桥接键**：**冪等键 ＝ `source_item_id`（＝复旦 `seqid`，原样字符串）**；重复提交 / 采纳不改写既有行；**桥接键 ＝ `as_book_id`（＝补零 `asBookId`）**（本輪只登记、将来与印人侧关联对齐）。
- **X4 键面（22 项业务字段，逐字）**：`source_item_id` / `as_book_id` / `as_id` / `book_uri` / `category` / `title` / `title_chs` / `title_other` / `title_other_chs` / `volume_count` / `date_text` / `date_year` / `publisher` / `abstract` / `abstract_chs` / `abstract_title` / `edition` / `donor` / `has_image` / `has_annotation` / `language` / `misc`（子对象：`bookZzxs` / `bookCj` / `bookSk` / `bookSz` / `bookPsqk`）；**`raw_json` 只落导入行、不落正式集合**。
- **X5 正副字段口径**：**繁体为正字段（`title` / `title_other` / `abstract`），简体入 `*_chs` 副字段；副字段落库但不上屏**。
- **X6 值面口径**：`volume_count` / `date_year` ＝ **整数或 `null`**（不得 `0` / 空串）；**`date_text` 源侧占位字面 `"N.D."` 归 `null`**；`has_image` / `has_annotation` ＝ **布尔**。
- **X7 审核面复用**：审核区块与印人 / 印章導入**合并同屏、共用既有钩子值 `person-import-review`** ⇒ **钩子族不新增（仍恰 10 值 / 归并 9 类）**；文案位复用既有 `importNotice` 位。
- **X8 读面与键表**：新集合必须**同批登记** `CLOUD_COLLECTIONS` 与「本机镜像键 → 云集合键」映射（`db.js::CLOUD_KEY_OF_LOCAL`，两键异名时必须登记）；**`AC-522` 的键表可达性断言必须覆盖新集合**（实现交下一批实现单，本包只写入口径与判据指向，**不得声称已落地**）；導入读面**必须含「不静默显示 0」降级分支**（云已配置且 `pending` / `failed` 且零行 ⇒ `{ok:false,reason,message}`；`off` 不降级；有本机行照常返回）。
- **X9 关联面**：`item_creators`（`feicui` 侧 `item_creators.jsonl` **1,020 行**）**本輪不收**（与 person 关联面 1650 条同口径）⇒ 登记为新 W 行 **`W-90`**（键面 ＝ `creator_type` / `creator_role` / `creator_relator` / `creator_name` / `person_grbsm` / `source_face`），并入「关联面」独立需求（指针 ＝ `W-87` 同族 ＋ feicui 侧 `item_creators.jsonl` 留在原处、可复跑）；**登记即收口 ＝ 已裁 ＋ 独立需求指针**。
- **X10 上屏面（本輪边界）**：本輪**只落数据层 ＋ 導入通道 ＋ 管理页采纳块**；**不新建面向读者的「印谱浏览 / 详情」页**（另开，登记为待裁项 **`W-91`**）。

## 4. 现状输入（带来源与时点戳，只作输入登记）

- **Kevin 2026-10-10 裁定（全部同意）**；口径真源 ＝ 拆解件 `feicui/docs/item-ingest-draft-v0.1.md` §I-3（模型 / 集合名 / 键面 / 導入通道归 xiai 线）。
- **feicui 侧已交付第一批就绪包**：`feicui/exports/item_import_item_20261010_01/`（`items.jsonl` **1,200 行** / `item_creators.jsonl` **1,020 行** / `manifest.json` 的 `key_face_status: pending_xiai`；时点 ＝ 2026-10-10（CST））。

## 5. 计数自证

- **§10 判据**：526 → **537**（新增 `AC-527` 〜 `AC-537`，共 11 条；既有 `AC-01` 〜 `AC-526` 编号与行内文字一字未改）。
- **集合清单**：19 → **21**。
- **钩子族**：`[data-admin-action]` 仍恰 **10 值 / 归并 9 类**（本通道不新增）。
- **`reason` 字面值**：**零新增**。
- **`MARKABLE_FIELDS`**：仍 **7 项**；**路由表**：仍 **10 条**。
- **§11 表内行数**：87 → **89**；**有效待裁项**：64 → **65**（`W-90` 登记即收口 ＋0；`W-91` 待裁 ＋1）。

## 6. 不以本版为前提的封堵（须齐备）

- 不得据「暂存集合未建 / 采集侧未接 / 導入未接线 / 键表未同批登记 / 读面降级未落地 / 1,020 条关联未導入 / 读者面页未建」把任一合规实现判负。
- 不得据本版把「印谱導入已落地 / 采纳通道已上线 / 键表已同批登记 / 读面降级已落地 / 读者面页已上线 / 关联已導入」判通过。

## 7. 未改 / 未动作

`src/**`、`server/**`、`yinyuan/**`、`feicui/**`、`ctrl/**`（含 `ctrl/PORTS.md`）、`package.json`、路由表、`cloudfunctions/**`、`scripts/**`、`docs/xiai-plan.md`、`docs/yinyuan-web.spec.md` 一律一字未碰；未跑构建 / 测试、未起服务、未占端口、未联网、未登录任何云控制台、未写任何生产数据、未执行 `tcb fn detail`、未对任何仓做 git 写操作（不 `git add` / 不 `git commit` / 不 `git push`）。
