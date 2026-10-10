# 印人批量导入 · 来自 feicui 线的交接件（2026-10-10）

> **写给：xiai（玺爱）项目的会话。** 本件由 feicui 线（Zang）出具，**只写文档、未提交**（放在 xiai 仓内便于你们直接读到；是否入库由你们决定）。
> **一句话**：feicui 侧已产出「xiai 就绪导入包」（**570 位印人**，主交付严格裁剪到**你们现有的 18 键**），请按第 4 节消费：**① 扩 3 个 extraction 键（走你们自己的规范流程）② 用 `submitPersonImport` 落 `xiai_person_imports`（PENDING）③ 管理员在「我的勘误记录」批量采纳 → `xiai_persons`**。
> **不做**：本线不写 xiai 任何文件、不调任何云函数、不碰 CloudBase（Kevin 2026-10-10 裁定：xiai 侧写入由你们承接）。

---

## 1. 产物位置与形态（可直接读取）

| 项 | 值 |
| --- | --- |
| 包目录 | `/Users/kevin/bistro/xiai/feicui/exports/person_import_person_20261010_01/` |
| 主交付 | `person_imports.jsonl` — **570 行**，**逐行恰 18 键**（＝你们的 `PERSON_IMPORT_ALLOWED_KEYS`） |
| sidecar | `person_imports_extraction.jsonl` — 570 行，extraction 标注（**待你们扩键面后并入**） |
| manifest | `manifest.json` — `schema_version` / 源批次 / 行数 / **键面 diff=0** / 幂等键唯一计数 / sidecar 说明 |
| 源批次 | `batch_id = person_20261010_01`（feicui 批次包 `exports/person_20261010_01/`：persons 570 / relations 1650） |
| 数据来源 | 复旦印藏（`https://yin.fudan.edu.cn/service_yinpu/person/list` 等），`source = 林章松《印人小传》` |
| 幂等键 | **`source_person_id` ＝ 复旦 `personGrbsm`**（9 位字符串，如 `907450151`；570 行非空且唯一） |

**主交付首行原文（截断展示）**
```json
{"batch_id":"person_20261010_01","source":"林章松《印人小传》","source_person_id":"900289963","name_full":"郭照","family_name":"郭","given_name":"照","courtesy_names":["容光","子青","鳴之","飴之"],"art_names":["曉樓","曉罍","…"],"alias_names":["郭容光","隱吾草堂","鐵如意室"],"birth_year":1827,"death_year":1895,"native_place":"浙江秀水（今嘉興）人。","native_place_chs":"浙江秀水（今嘉兴）人。","biography":"郭照(容光)。1827-1895。…","biography_chs":"郭照(容光)。1827-1895。…","nationality":"中國","cbdb_id":null,"source_id":"RW2132"}
```

## 2. 主交付键面（逐字 18 键，与你们现行契约一致）

`batch_id` / `source` / `source_person_id` / `name_full` / `family_name` / `given_name` / `courtesy_names` / `art_names` / `alias_names` / `birth_year` / `death_year` / `native_place` / `native_place_chs` / `biography` / `biography_chs` / `nationality` / `cbdb_id` / `source_id`

**为什么必须裁剪**：feicui 原始批次包一行 **32 键**（多出 `source_seqid` / `name_full_chs` / `nationality_chs` / `nationality_code` / `spell` / `initial` / `flag` / `notes` / `raw_json`），而你们的 `submitPersonImport` 是**封闭键面**——多一个键即 `INVALID_FIELD`「载荷含未知字段」＋零写入。故本包已按 18 键裁好，**可直接提交**。

## 3. 字 / 号 / 别名的形态（Kevin 2026-10-10 裁定）

- **主交付**：`courtesy_names` / `art_names` / `alias_names` ＝ **`string[]`**（只保留 `value`，顺序不变）。你们现有 `asArray()` + `text(item)` 可直接吃。
- **`extraction` 标注**（＝该字号是「规则抽取」而非权威分类；**不是人物简介**，简介是 `biography`/`biography_chs`，已在主交付内）：暂存 **sidecar** `person_imports_extraction.jsonl`：
  ```json
  {"source_person_id":"900289963","courtesy_names_extraction":["rule-based","rule-based","rule-based","rule-based"],"art_names_extraction":["rule-based","…"],"alias_names_extraction":["rule-based","…"]}
  ```
  与主交付对应值**等长**；**已按裁定去掉 `from`**（原 `from` 仅技术溯源 `personBm`/`personBmChs`）。

## 4. 需要你们做的三件事

| # | 事项 | 说明 |
| --- | --- | --- |
| D-1 | **扩 3 个键**（走你们自己的规范流程） | `courtesy_names_extraction` / `art_names_extraction` / `alias_names_extraction`（等长 `string[]`，元素恒 `rule-based`）。**扩键面之前**：主交付已可正常提交，extraction 元数据暂以 sidecar 存放 ⇒ **不阻塞**；扩完后可把 sidecar 并入主载荷（或由你们导入器合并）。 |
| D-2 | **提交 `submitPersonImport`（必需，由你们执行）** | 该 op 的 `imported_by` 由**服务端从令牌派生**（`uid`，零手机号）⇒ 只能由持有可验证令牌的玺爱侧发起；feicui 侧无令牌、且不得调云函数。建议由管理员在玺爱侧批量提交（570 条；同 `source_person_id` 幂等，重复提交不改写）。 |
| D-3 | **审核门维持**（Kevin 已定） | 导入先落 `xiai_person_imports`（`status='PENDING'`）；管理员在「我的勘误记录」页（印人导入 ＋ 印章导入同屏区块）**批量采纳**后方成 `xiai_persons` 正式印人（按 `source_person_id` 幂等落行）。 |

## 5. 人工前置 / 依赖（请你们核实）

1. **集合 `xiai_person_imports` 需在云控制台人工新建**（规范 §3.54.14 / §4.1.16 已登记为人工步骤）；同批另需 `xiai_persons`（正式落点）。
2. **云函数 deploy 状态**：`submitPersonImport`（`xiai-user-token`）与 `reviewPersonImport`（`xiai-admin-token`）需已部署到环境 `liwu-d8gek6jjdab1d087c`。
3. **令牌**：提交需可验证用户令牌（`issue` 走手机号 ＋ 验证码；W-43 为已接受风险）。

## 6. 关联面（**目前无处可去，请一起裁**）

feicui 侧还采到 **1650 条关联**（该印人的**印谱 / 印章**，来自详情页 `graph/person/<grbsm>`，见 `exports/person_20261010_01/relations.jsonl`：
`source_person_id` / `kind`(`印谱`|`印章`) / `ref_id` / `name` 或 `desc`(印文) / `creator_type` / `as_book_id` / `has_image` / `image_key` / `type` / `seq`）。

但**你们现行 `submitPersonImport` 的键面里没有关联位**，故这 1650 条**本轮无法经同一通道导入**。三选一，请你们/Kevin 定：
- **(a) 本轮先不导入关联**（只落印人本体）；
- **(b) 在印人导入行上扩一个 `relations[]` 键面**（走你们规范流程）；
- **(c) 另立独立通道/集合**（如 `xiai_person_relations`），后补。

> 参考尺度：`印谱 1349 / 印章 301`；抽样锚点 `趙之謙 907404573 ⇒ 印谱 23 / 印章 65`、`吳昌碩 907271790 ⇒ 印章 10`、`鄒夢禪 907450151 ⇒ 印谱 1`、`宗汝剛 907566313 ⇒ 0`。

## 7. 如何重新生成导入包（feicui 侧，可复跑）

- HTTP：`POST http://127.0.0.1:5196/api/persons/import-package`（可选 body/query `batch_id`，缺省取库内最新批次）；列表：`GET /api/persons/import-packages`
- CLI：`cd feicui/server && ./.venv/bin/python -m app.persons import-package --batch-id person_20261010_01`
- 页面：`http://localhost:5164/feicui/persons` → 「导入包（xiai 就绪）」区 → 按钮【生成 xiai 就绪导入包】
- **不联网采集**（从 feicui 独立库 `var/person_ingest.db` 重建）；**不写 xiai 任何文件**

## 8. 我方已验读数（供你们复核对照）

- 主交付：**570 行**；键集仅 1 种且**恰等 18 键**（多余键 0 / 缺失键 0）；三桶均 `list[str]`（1517 个元素）；`birth_year`/`death_year` 仅 `int` 或 `null`；无 BOM；幂等键**非空 570 / 唯一 570**。
- sidecar：570 行，三数组与对应值**等长**，元素恒 `rule-based`，**无 `from`**。
- 自检 `feicui/ops/person-ingest/verify_import_package.py`：**PASS**；含**旧形态（32 键/对象数组）FAIL 对照**（3869 处违规）⇒ 判据有区别力。
- 证据：`feicui/ops/person-ingest/13_import_package.{txt,json}`（含真浏览器点验上屏文字）。

## 9. 与本仓规范的对应关系

你们仓 `docs/xiai.spec.md` **v1.54** 已落「印人批 2 前置增量」= **§3.54.13〜§3.54.18 ＋ §4.1.16 ＋ §10.53（AC-485〜AC-492）**（集合清单 17→18、钩子族 10 值/9 类、W-77〜W-80）。本件是其**数据供给侧**的对口说明：
- 本件第 2 节的 18 键 ≡ §3.54.14 的导入行键面；
- 本件第 3 节的 3 个 extraction 键是**新提出的扩键需求**（D-1），需你们按 §1.3 流程落规范；
- 本件第 6 节（关联面）是**新提出的待裁项**，建议登记为新的 W 行。

## 10. feicui 侧落点（备查）

| 事项 | 提交 / 路径 |
| --- | --- |
| 印人采集（批 1） | feicui `cfa522d` → `a5abd69` → `d10c0da` → `9356348`（origin/main 已含） |
| 导入就绪包（本件） | feicui `dd1940a`（实现）＋ `0581a52`（规范 v1.10 §3.15.11 ＋ AC-24）＋ `e6f76a4`（独立点验留痕） |
| 规范 | `feicui/docs/feicui.spec.md` **v1.10**（§3.15.11 导出面）；AC-14〜AC-24 |
| 契约真源 | `feicui/docs/person-ingest-handoff-v0.1.md`（第七节）｜`feicui/docs/person-ingest-draft-v0.1.md`（API 契约） |
| 源站限流提醒 | `person/detail` 与累计请求量上去后的 `graph/person` 均会 429（HTTP 200 ＋ `code:"429"` ＋ `status:true` ＋ 无 `data`，约 150s 自愈）⇒ 若你们要实时复核关联，**低频抽样 + 退避** |
