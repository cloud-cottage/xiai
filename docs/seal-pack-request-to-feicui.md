# 索取件（玺爱/印源侧 → feicui 线）：**印章本体就绪包**（路线 1 · 关联面前置）

> 可直接粘贴到另一条对话。时点 2026-10-10（CST）。**裁定依据：Kevin 2026-10-10 选「路线 1」。**

## 为什么需要它（一句话）

你们交付的 `person_20261010_01/relations.jsonl` 里 **kind=印章 的 301 条关联**（覆盖 **261 枚** distinct 印章、`creator_type` 全部 `印主`、**影像键覆盖 261/261**）指向的**印章本体不在我方库** —— 我方 `xiai_seals` 现仅 79 行且来自**另一来源**（PDF 解析批 `fb_*`，与 `feicui_work.db.seals` 同批）。按 Kevin 路线 1：**三本体（印人 570 ／ 印谱 1742 ／ 印章 261）同批入库，关联（1650 条含 301）紧接一批**，避免任何悬空引用。

## 请你们产出：`seal_import_<batch_id>/`

| 文件 | 内容 |
|---|---|
| `seals.jsonl` | **一行一枚印章**（本体；见下方键面） |
| `manifest.json` | 源端点/入参、`total`、行数、幂等键唯一计数、覆盖统计、**缺失字段如实登记**、`key_face_status` |
| （可选）`seal_faces.jsonl` | 若印面/边款需单列（否则并入 `seals.jsonl` 的 `faces[]`） |

**范围（Kevin 2026-10-10 定：`全量优先，越多越好`）**：
- **主目标 ＝ 源站印章全量**（`sealCount=716`）；**那 261 枚包含在内**（它们只是我方关联校验的**最小集**）。
- 若源站还有**其它可采的印章**（其它书目／其它入口／其它 id 前缀），**一并采** —— 「越多越好」。
- 三条硬约束：① 同一**幂等键** `source_seal_id`（＝源站印章 id，**原样字符串**，不得改写/补零）；② 同一**键面**（见下，多键会被我方拒）；③ `manifest.json` 如实登记**总量 / 各来源分布 / 缺项计数**。
- **与我方现有 79 枚的关系**：那 79 枚来自**另一来源**（PDF 解析批 `fb_*`）⇒ 本批以 `source_seal_id` 为幂等键**独立入库**，**不覆盖、不改写**既有行（旧值不改写红线）。

## 键面（**请逐字照此出包；我方已冻结，多键会被拒**）

**行级**：`batch_id`（建议统一写 `seal_20261010_01`）／ `source`（**请统一写 `复旦印藏（yin.fudan.edu.cn）「印章」`** —— 我方采纳按 **`(source_seal_id, source)`** 去重，**同一批必须同一 `source` 字面**）／ **`source_seal_id`（幂等键，＝源站印章 id，原样字符串）**

**印章级 8 键**：`seal_name` ／ `dynasty` ／ `seal_type` ／ `seal_style` ／ `material` ／ `shape` ／ `author` ／ `transcription`

**印面数组 `faces[]`（每印面；13 键）**：`kind`（**`FACE` ／ `EDGE` 边款，须在列**）／ `seal_name` ／ `dynasty` ／ `seal_type` ／ `face_style` ／ `seal_class` ／ `author` ／ `author_person_id` ／ `transcription` ／ `image_storage_key` ／ `image_sha256` ／ `image_bytes` ／ `image_mime`

**影像面（重要）**：**不要传二进制**。只给**影像引用键**（`image_storage_key` 等）；你们已有的 `image_key`（形如 `5_3012_1`）可直接落 `image_storage_key`。**同一印面「宣告引用但解析不到」会被我方拒收**（这是冻结口径，见我方 §3.55.6）。

**值面**：`dynasty` 请用我方 15 类（春秋／戰國／秦／漢／魏晉／隋唐／宋元／明早中期／晚明／清初／清中期／晚清／民國／新中國／當代）；`seal_type`（印面內容）9 类、`face_style`（印面風格）23 类、`seal_class`（大類）3 类 —— **以你们采集到的原值为准，缺就 `null`，不要硬编**；`author_person_id` 若可给，请填**印人 id（＝`source_person_id`／grbsm）**，与已交付的 570 印人对得上。

## 随件交付：261 枚清单

- 文件：`seal-pack-request-refids.jsonl`（**261 行**），每行：
  `{"source_seal_id":"3012","image_key":"5_3012_1","desc":"松蔭軒藏印譜","creator_type":"印主","persons":["907118823"],"rows":1,"person_count":1}`
- 说明：`source_seal_id` ＝ 你们 `relations.jsonl` 的 `ref_id`；`desc` **原样照抄**（疑似印文/谱名，用途由你们判）；`persons` ＝ 关联到的印人（grbsm）。

## 我方收单后怎么走（时序）

1. 你们出包 ⇒ 我方按 **`submitSealImport`** 同批提交（批次建议 `seal_20261010_01`）；
2. **三本体（印人 570 ／ 印谱 1742 ／ 印章 261）同批采纳** ⇒ 分别落 `xiai_persons` ／ `xiai_items` ／ `xiai_seals`（＋印面落 `xiai_faces`，`review_status='APPROVED'`）；
3. 随后**关联批**（`person_relations` 1650 条：印谱 1349 ／ 印章 301）入库 ⇒ 此时每条关联的 `ref_id` 都能在库内找到，**零悬空**。

## 我方接口与状态（供你们对齐）

- 通道：`submitSealImport`（行级 3 键 ＋ 印章级 8 键 ＋ `faces[]` 13 键；**幂等键 `source_seal_id`**）；管理员采纳 ⇒ 写 `xiai_seals` ＋ `xiai_faces`。
- 我方现况：`xiai_seals` 79 行 ／ `xiai_faces` 79 行（另一来源）；印人 570 行 ／ 印谱 1742 行已在暂存集合待采纳。
- **feicui 依旧不写 xiai 任何文件、不调云函数**：出包即可，提交归我方。
