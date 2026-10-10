# 印谱（item）批量导入 · 来自 feicui 线的交接件（2026-10-10）

> **写给：xiai（玺爱）项目的会话。** 本件由 feicui 线（Zang）出具，**只写文档、未提交**（放在 xiai 仓内便于你们直接读到；是否入库由你们决定）。
> **一句话**：Kevin 2026-10-10 新立概念 **`item` ＝「印谱」**；feicui 侧已采全 **1742 本印谱**（含 1440 条 item↔印人关联）并产出**候选就绪包**，请你们按第 3 节定「模型 / 集合名 / 键面 / 导入通道」四项，再按第 4 节消费。
> **归属（Kevin 裁定 I-3）**：**item 的模型 / 集合名 / 导入通道归 xiai 线**；feicui 只负责采集 / 归一化 / 落本库 / 出就绪包；**feicui 不写 xiai 任何文件、不调云函数、不碰 CloudBase**。

---

## 1. 产物位置与读数（可复核）

| 项 | 值 |
| --- | --- |
| 包目录 | `/Users/kevin/bistro/xiai/feicui/exports/item_import_item_20261010_01/` |
| 主交付 | `items.jsonl` — **1742 行**（恰 23 键，键集唯一） |
| sidecar | `item_creators.jsonl` — **1440 行**（item↔印人） |
| manifest | `manifest.json`（`field_dict` / `field_dict_creators` / 覆盖统计 / 幂等键唯一计数 / `detail_policy` / `key_face_status`） |
| report | `report.json` |
| 源批次 | `item_20261010_01`；源 side `total = 1742`（`bookCount=1742`） |
| 幂等键 | **`source_item_id` ＝ 复旦 `seqid`**（1742 行非空且唯一） |
| 桥接键 | **`as_book_id`**（＝`asBookId` 补零业务号；**唯一 1742**；与印人侧 `person_relations.as_book_id` 对得上） |
| 关联面 | `item_creators` 1440 行 / **957 本**有责任者 / 涉及 **535 位印人**；`source_face`：`book_graph 1281` ＋ `person_graph 159` |
| 指纹 | `content_fingerprint = 8b6bde0c9d1a2927eb03721c473438e754d7e5d5f0e455da17feac0b971e0a2e` |

**主交付首行（截断展示）**
```json
{"source_item_id":"2214","as_book_id":"0307","as_id":1335,"category":"印谱","title":"龍泓山人印譜","title_chs":"龙泓山人印谱","volume_count":8,"date_text":"清宣統二年","date_year":1910,"has_image":"1","abstract":"八冊，不分卷。吳隱（石潛）編輯丁敬（敬身）刻印而成《龍泓山人印譜》此譜…","abstract_chs":"…","raw_json":"{…}"}
```

**sidecar 首行（示例形态）**
```json
{"source_item_id":"2214","creator_type":"辑","creator_name":"吳隱","person_grbsm":"907234486","source_face":"book_graph","creator_role":null,"creator_relator":null,"seq":0}
```

## 2. 字段面（供你们裁剪键面）

**item 本体（23 键）**：`source_item_id` / `as_book_id` / `as_id` / `book_uri` / `category` / `title` / `title_chs` / `title_other` / `title_other_chs` / `volume_count` / `date_text` / `date_year` / `publisher` / `abstract` / `abstract_chs` / `abstract_title` / `edition` / `donor` / `has_image` / `has_annotation` / `language` / `misc` / `raw_json`

- 口径：**繁体为正、简体入 `*_chs`**、零转换改写；`volume_count` / `date_year` 为**整数或 `null`**（**无 `0` / 空串特值**，实测 0 行命中）；**`raw_json` 保留源原文（不丢源）**。
- **实测非空覆盖（1742）**：`title` 1742 / `volume_count` 1728 / `date_year` 1076 / `abstract` **753** / `publisher` 113 / `has_image=1` **1714**；**`donor` 0**（见下）。

**sidecar（8 键）**：`source_item_id` / `creator_type` / `creator_name` / **`person_grbsm`** / `source_face` / `creator_role` / `creator_relator` / `seq`

- `source_face` ∈ {`book_graph`, `person_graph`, `book_detail`}：**关联来源面**（去重与追溯用）；**与 person 侧已删的 `from`（姓名抽取源字段名）不是同一概念**。
- `creator_role` / `creator_relator` 为 `null`（见第 5 节：detail 降级）。

## 3. 请你们定的四项（Kevin I-3 归你们）

| # | 事项 | 说明 |
| --- | --- | --- |
| **X-1** | **item 模型** | 集合名（建议 `xiai_items` 一型）/ 字段面 / 索引（建议 `source_item_id` 唯一、`as_book_id` 唯一）/ 是否收 `item_creators` |
| **X-2** | **就绪包键面裁剪** | 现包为**候选键面**（`manifest.key_face_status = pending_xiai`）：**你们定键面后**告知，feicui 侧**二次出包（不重新联网，从本库重建）**——与 person 流程同型 |
| **X-3** | **导入通道** | 建议沿用你们既有三段式：`submitItemImport` → 暂存集合（`PENDING`）→ 管理员在「我的勘误记录」批量采纳 → 正式集合（按 `source_item_id` 幂等） |
| **X-4** | **item↔person 关联是否入 xiai** | sidecar 已按 Kevin I-4 随包交付；**是否入库由你们定**（可扩导入行键面，或另立关联集合） |

## 4. 与 person 线的异同（避免踩坑）

| 面 | person（已交付） | item（本件） |
| --- | --- | --- |
| 幂等键 | `source_person_id`（`personGrbsm`） | `source_item_id`（`seqid`）；另**唯一桥接键 `as_book_id`** |
| 详情端点 | `person/detail` **与列表同构**（可省） | `book/detail` **与列表不同构**（多 `creatorList`/`titleList`/`itemList`/`bookDonor`）**但严限流** ⇒ 降 best-effort |
| 关联来源 | `graph/person` | **`graph/book`**（主源，给 `creatorType` ＋ `personGrbsm`）＋ 既有 `person_relations`（互补） |
| 键面状态 | 已按你们 21 键裁好、可直接提交 | **候选键面未裁**（`pending_xiai`），等你们定 |

## 5. 如实登记：`book/detail` 降级（缺三字段）

- **实测**：`book/detail/<seqid>` **严限流**（实跑日志 `5/10/20/40/60s` 退避反复）；`graph/book/<seqid>` **健康**（2 s 间隔 3/3 成功）。
- **口径**：item 本体全部取自 `book/list` 一次全量；关联主源改 `graph/book`；**`book/detail` 降为 best-effort（默认关，`--with-detail` 才开）**。
- **代价（manifest `detail_policy` 已登记）**：`creator_role` / `creator_relator` / **`donor`** 三字段默认缺（`donor=0/1742`）。`creator_type` 与 `person_grbsm` **不受影响**。若你们需要这三字段，告知即可（慢速 best-effort 补，不阻塞主交付）。

## 6. 锚点（供你们复核）

- `seqid=2214` / `as_book_id=0307`「龍泓山人印譜」：卷册 **8**、纪年「清宣統二年」、公元 **1910**、`has_image=1`、题要名「松蔭軒題要」、题要长文 484 字。
- 关联锚点：`2214` ⇒ **吳隱（辑，`907234486`）＋ 丁敬（刻印，`907415494`）**，`source_face='book_graph'`。
- `seqid=3547` / `1817`「楊仲子印存」（本体取自 list；`donor` 为 `null`＝detail 默认关）。

## 7. 重新生成就绪包（feicui 侧）

- HTTP：`POST http://127.0.0.1:5196/api/items/package`（可选 `batch_id`；缺省取库内最新批次）
- CLI：`cd feicui/server && ./.venv/bin/python -m app.items package --batch-id item_20261010_01`（以 `--help` 为准）
- 页面：`http://localhost:5164/feicui/items` →「就绪包（xiai）」区 →【生成 xiai 就绪包】
- **从本库重建、不联网采集**；**不写 xiai 任何文件**

## 8. feicui 侧落点（备查）

| 事项 | 提交 / 路径 |
| --- | --- |
| item 采集（批 1） | feicui `146cd0d`（origin/main 已含） |
| 规范 | `feicui/docs/feicui.spec.md` **v1.13**（§3.16 印谱（item）采集；AC-25〜AC-32）；页签集合 2 → 3（AC-23 v1.12 原位改写） |
| 拆解件 | `feicui/docs/item-ingest-draft-v0.1.md`（API 契约 ＋ Kevin 门控四答 ＋ §10 采集口径偏离登记） |
| 证据 | `feicui/ops/item-ingest/**`（落库/幂等/两库指纹/自检 7 例负向/API 14 例/全量日志） |
| 源站限流提醒 | 站点级窗口限流：HTTP 200 ＋ `code:"429"` ＋ `status:true` ＋ 无 `data`；`book/detail` 尤其敏感 |
