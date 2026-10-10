# 关联面（三表联立）· 来自 feicui 线的交接件（2026-10-10）

> **写给：xiai（玺爱）项目的会话。** 本件由 feicui 线（Zang）出具，**只写文档、未提交**（放在你们仓内便于直接读；是否入库由你们决定）。
> **一句话**：Kevin 裁定的「**印人关联面另开**」需求已落地——feicui 侧把**四条线的既有关系数据**（印人／印谱／印章／影像）在本库内**联立、去重、归一**为**统一关系边**，产出**候选关系包** `relations.jsonl`（**9976 行**）。**这是一次纯本库联立：零联网、不新增任何采集请求。**
> **归属**：关系集合名 / 模型 / 键面 / 导入通道归 xiai 线；feicui 只读三库、产出包；**不写 xiai 任何文件、不调云函数**。
> **状态**：feicui 侧已入库并推送；**独立质检（Neng）AC-55〜AC-61 全 PASS、阻塞 0**（其后又收口 3 条 OBS 真缺陷：守卫路径 `exists:false`、多角色行 `role`/`role_note` 配对错位、`person_resolved:false` 计数缺失）。

---

## 1. 产物位置与读数（可复核）

| 项 | 值 |
| --- | --- |
| 包目录 | `/Users/kevin/bistro/xiai/feicui/exports/relation_import_relation_20261010_01/` |
| 主交付 | `relations.jsonl` — **9976 行**（恰 **16 键**，UTF-8、无 BOM） |
| 内容 | 幂等键 `(predicate, subject_id, object_id)` **9976/9976 全唯一** |
| 字节 / 指纹 | 3,690,342 B；sha256 `642d3a4b…c6146fc` |
| 其它 | `manifest.json`（`field_dict` / `predicate_counts` / `dedup_arithmetic` / `ghost_unresolved` / **`r_defaults`** / **`key_face_status: "pending_xiai"``）· `report.json`（含九行对账、守卫指纹、幽灵与未收录清单） |
| 页签 | **未新增页签**（tabbar 仍四项；关联面是跨线产物，不做采集页） |

**各 predicate 行数（去重后）**

| predicate | 行数 | 语义 |
| --- | ---: | --- |
| `person_to_item` | 1349 | 印人 → 印谱（来源 `graph/person`） |
| `item_to_person` | 1379 | 印谱 → 印人（`book_graph` 1281 ∪ `person_graph` 159，去重后） |
| `person_to_seal` | 301 | 印人 → 印章（含 `image_ref`，可直连影像面） |
| `seal_to_item` | 3679 | 印章 → 印谱 |
| `seal_to_person` | 3268 | 印章 → 印人（印主／篆者／边款篆者，多角色行已合并、`role` 与 `role_note` **成对**） |
| **合计** | **9976** | 去重前原始行合计 **12054** |

## 2. 边键面（16 键；**候选键面，未裁**）

```
predicate, subject_type, subject_id, object_type, object_id,
role, role_note, evidence, source_ref, image_ref,
name, name_chs, seq, ghost, person_resolved, batch_id
```

- `predicate` 枚举五值：`person_to_item` / `item_to_person` / `person_to_seal` / `seal_to_item` / `seal_to_person`。
- `evidence` 为**数组**，保留来源：`person_graph` / `book_graph` / `seal_row`；**两源共报同一事实的行**记 `["person_graph","book_graph"]`（共 **2498** 行）。
- `role` / `role_note` 为 `|` 连接的多值串（**成对有序**）；`ghost:true` 标源侧幽灵行；`person_resolved:false` 标印人 id 未收录。
- `image_ref` 为影像 ref（如 `19_3250_1`），可与 feicui 印章包的 `images_manifest.jsonl.source_ref` 对上。

## 3. 去重算术与对账（**可复算**）

- **跨表去重**：`|A| = 1281`（`item_creators(book_graph)`）／`|B| = 1349`（`person_relations(印谱)`）／**`|A∩B| = 1249`** ⇒ **`|A∪B| = 1281 + 1349 − 1249 = 1381`**（only-item 32、only-person 100）。
- **行内合并**：`item_to_person` 1440 → 1379（合并 61 组，均跨源、`evidence` 保双源）；`seal_to_person` 5285 → 3268（合并 2017 组 ＝ 同一 `(印章, 印人)` 多角色）。
- **九行可连键对账**（`report.join_reconciliation`，Neng 已独立重算）：`as_book_id 932→931`（缺 1 ＝ 值 `test`）／`ref_id 932→931`（缺 1 ＝ `103`）／`印章 ref 261/261`／`印章 image_key 261/261`／`seal_links(book) ref 19/19`／`bridge_item_id 19/19`／`item_creators.person_grbsm 535/535`／`seal_links 印人面 41→27`（缺 14）／`∩1249、∪1381`。**包内行级可连键违规 0**（除 `ghost` 行）。

## 4. 源侧异常（**保留并标记，请你们定去留**）

| 类 | 计数 | 说明 |
| --- | --- | --- |
| **幽灵行** `ghost:true` | **2 行** | 印人 `907118823` / `907135358` 挂 `as_book_id='test'`（源侧测试占位行，印人名「【测试】印谱平台数据全样例，请勿改动…」；`items` 无此书） |
| **未收录印人 id** `person_resolved:false` | **449 行 / 14 个 id** | 全部在 `seal_to_person`；按面 印主 8 / 篆者 1 / 边款篆者 6（`907566509` 跨两面 ⇒ 出现 15 次、去重 14）；这些 id 不在 feicui 印人库 570 人内，**系源侧引用未收录**，非缺陷 |

## 5. 请你们定的项（R35〜R39，**逐项带后果**）

| # | 事项 | 选项与后果 |
| --- | --- | --- |
| **R35** | **关系集合名 / 模型** | 单集合 `xiai_relations`（一条边一行）vs 按 predicate 分集合。**你们定后 feicui 二次出包，无需重新联立以外的工作**（本包已是落库就绪形态） |
| **R36** | **键面裁剪 ＋ 合成 hash** | 现 16 键为**候选**（`pending_xiai`）；若你们要单列主键 `edge_id = hash(predicate|subject|object)`，告知即加（不改变幂等语义） |
| **R37** | **导入通道** | 沿用三段式（`submitRelationImport` → `PENDING` → 管理员采纳）vs 直写（本包是**派生数据**、可由 feicui 随时重建，风险等级与三条原始线不同，**你们可据此选择更轻的通道**） |
| **R38** | **幽灵/未收录去留** | ① 保留并带标记（本包默认）；② 剔除幽灵 2 行、未收录 449 行保留；③ 全部剔除。**若选②/③，feicui 二次出包即剔除（数据不丢，本库仍有）** |
| **R39** | **双源去重形态** | ① 同一 `(subject,object,predicate)` 合一行、`evidence` 数组保双源（**本包默认**，2498 行）；② 拆成两行、各自保留原字段（行数会增加）。**②会破坏「三元组唯一」这条判据，需你们确认** |

## 6. 接口（feicui 侧，additive）

- `GET  http://127.0.0.1:5196/api/relations/summary` — 只读：各 predicate 计数 / 去重前后 / 对账 / 幽灵与未收录。
- `POST http://127.0.0.1:5196/api/relations/package`（可选 `batch_id`；缺省取最新）— **从三库重建包、零联网**。
- 重建幂等：**仅时间戳变、`relations.jsonl` 字节不变**（sha256 两次全同）。错误面：未白名单参数 ⇒ `400 UNSUPPORTED_PARAM`；批次不存在 ⇒ `404 BATCH_NOT_FOUND`（结构化 JSON，非 HTML）。

## 7. 重新生成（feicui 侧）

```bash
cd /Users/kevin/bistro/xiai/feicui/server
../server/.venv/bin/python -m app.relations package --batch-id relation_20261010_01
```
- **零联网**：本需求为纯本库联立（不访问 `yin.fudan.edu.cn`）；Neng 已做**代码面**（无出网 import）＋ **连接面**（重建期间 `lsof` 非环回连接数 = 0）双证。

## 8. feicui 侧落点（备查）

| 事项 | 位置 |
| --- | --- |
| 实现 | `feicui/server/app/relations.py`、`server/app/routers/relations.py`（additive，不动 E1〜E7 与既有端点） |
| 规范 | `feicui/docs/feicui.spec.md` **v1.20**（**§3.18 关联面**（含 §3.18.1〜§3.18.8）＋ **AC-55〜AC-61** ＋ **R35〜R39**） |
| 口径真源 | `feicui/docs/relation-ingest-draft-v0.1.md`（三表现状 / 九行对账 / R-a〜R-f 默认值） |
| 证据 | `feicui/ops/relation-ingest/**`（九行对账脚本、守卫 before/after、包自检、幂等、报告） |
| 质检 | `feicui/qa-recheck/relation-ingest-neng/`（**AC-55〜AC-61 全 PASS、阻塞 0**；含自写可判负探针） |
| 服务 | 改码后已单路重启（PID → **92929**），活端点读到新口径 |

> **四线全景**：印人（570）／印谱 item（1742）／印章 seal（3679 本体 ＋ 6347 张 TIFF 影像）／**关联面（9976 条边）**——前三条各有独立交接件（`person-import-handoff-from-feicui.md` / `item-import-handoff-from-feicui.md` / `seal-import-handoff-from-feicui.md`），本件为**第四条**，它把前三条缝成一张网。
