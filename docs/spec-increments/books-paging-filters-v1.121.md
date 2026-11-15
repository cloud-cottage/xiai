# 规范增量 v1.121 —— 印谱清单分页与筛选（`listBooks` 载荷 0 → 6 键）

- 作者：Zang（本轮破例）
- 提出：Kevin（2026-11-15）「`/books` 要分页，加适当的筛选」
- 主件状态：**未动** `docs/xiai.spec.md`（v1.117 / 794 条），由 Jing 合并；接 v1.120（`AC-807〜810`）

## 一 · 契约

`listBooks` 载荷 **0 → 6 键（封闭）**，全部可缺省：

| 键 | 形态门 | 语义 |
|---|---|---|
| `offset` | 整数 ≥ 0（默认 0） | 起始偏移 |
| `limit` | 整数 1〜200（默认 50） | 每页行数 |
| `q` | 串 ≤ 60 字 | 关键词：书名 / 作者名 / 出版社 / ISBN / CIP / 创作者名，**简繁双形态**包含匹配 |
| `author` | 串 ≤ 60 字 | 作者名包含匹配（主作者名 ＋ 创作者链人名） |
| `year_from` / `year_to` | 整数 1000〜当年；`from ≤ to` | 首次出版年闭区间；**给了区间 ⇒ 无年份的行不命中** |

回包（`LIST_BOOKS_READOUT_KEYS`）：

- 命中轮：`{ok, books, total, offset, limit, has_more}`（**恰 6 键**）
- `books` ＝ **本页**行（行投影仍恰 `BOOK_ROW_KEYS` 11 键）
- `total` ＝ **命中总数**（分页前）
- `has_more` ＝ `offset + books.length < total`
- 全表扫描到顶时**额外** additive 键 `truncated: true`（既有口径，不改）

非法载荷一律 `INVALID_VALUE` ＋ **零读**（`limit` 越界 / 年份倒挂 / 超长关键词）。

## 二 · 前端

- 筛选与分页**全在服务端**；输入框改动**不即生效**，按【查詢】才发请求（避免逐字打云端）。
- 页码条：`上一頁` / `下一頁`（整页步进，`disabled` 由 `canPrevPage` / `has_more` 驱动）
  ＋ 范围文案 `第 1–50 筆 / 共 1,745 筆`。
- 空态文案区分：**无筛选且 0 命中** ⇒「尚無印譜資料…」；**有筛选 0 命中** ⇒「目前篩選條件沒有符合的印譜」。
- 批量挂图面板的目标印谱下拉**只列当前页**，面板头明示"先用上方筛选缩小范围"（不为下拉全量再拉 1,745 行）。
- 钩子：`data-books-filter` / `data-books-pager`；按钮 `data-action="filter-books" / "reset-books-filter" / "books-prev-page" / "books-next-page"`（**不新增 `data-admin-action` 取值**）。

## 三 · 验收（`AC-811` 〜 `AC-814`）

| 编号 | 判据 |
|---|---|
| `AC-811` | `listBooks` 载荷恰 6 键；未知键 ⇒ `INVALID_FIELD` ＋ 零读；`limit=0`／`year_from>year_to` ⇒ `INVALID_VALUE` ＋ 零读 |
| `AC-812` | `limit=2` ⇒ 首页 2 行且 `has_more:true`；`offset=2` ⇒ 次页 1 行且 `has_more:false`；`total` 恒为命中总数（与分页无关） |
| `AC-813` | 三筛选各自缩小命中集：`q`（书名包含）、`author`（作者名包含）、`year_from`（无年份行不命中）；**简繁双形态**均可命中 |
| `AC-814` | 回包恰 6 键（`books/total/offset/limit/has_more/ok`）；**判负面**：把 `total` 当成本页行数、或把本页当全量渲染 |

## 四 · 计数

| 项 | 前 | 后 |
|---|---|---|
| §10 验收条目（含未合并增量） | 810 | **814** |
| `listBooks` 载荷键 | 0 | **6** |
| `listBooks` 回包读数键 | 3 | **6** |
| 行投影 / `PUBLIC_OPS` / `ADMIN_OPS` / `reason` / 集合 / 路由 | 11 / 5 / 47 / 13 / 30 / 11 | **不变** |
