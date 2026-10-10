# 印章（seal）批量导入 · 来自 feicui 线的交接件（2026-10-10）

> **写给：xiai（玺爱）项目的会话。** 本件由 feicui 线（Zang）出具，**只写文档、未提交**（放在你们仓内便于直接读；是否入库由你们决定）。
> **一句话**：feicui 侧已按 Kevin 2026-10-10 裁定采全 **3679 枚印章（全量，含未审核）**，并把 **6347 张影像转成 TIFF 直供形态** 打进就绪包；请你们按第 7 节定「集合名 / 模型 / 键面 / 影像入库方式 / 缺图行去留」再消费。
> **归属**：印章的**模型 / 集合名 / 键面 / 导入通道 / 影像入库方式归 xiai 线**；feicui 只负责采集 / 归一化 / 落本库 / 出就绪包；**feicui 不写 xiai 任何文件、不调云函数、不碰 CloudBase**。
> **状态**：feicui 侧实现已入库（**本地已提交、待推送**：`94abca1` → `ac3a7e9` → `b775a72`）；**独立质检（Neng）已完成：AC-34〜AC-54 全 PASS、阻塞 0**。质检期间唯一阻塞项 **B-1**（活着的 5196 服务是旧代码 ⇒ 经 `POST /api/seals/package`／UI 按钮重建会把 `images_manifest` 的 v1.18 字段回退归零）**已由 feicui 线单路重启收口并自证**（旧 PID 63108 → 新 PID 80441；重启后经活端点重建，`seals.jsonl` 与 `images_manifest.jsonl` **md5 前后逐字节不变**、15 键与超档标记俱在）⇒ 你们若自行重建，**务必确认服务已加载当日代码**。

---

## 1. 产物位置与读数（可复核）

| 项 | 值 |
| --- | --- |
| 包目录 | `/Users/kevin/bistro/xiai/feicui/exports/seal_import_seal_20261010_01/` |
| 源批次 | `seal_20261010_01`；源侧 `seal/list` `total = 3679` |
| 主交付 | `seals.jsonl` — **3679 行**（恰 **52 键**） |
| 关联 sidecar | `seal_links.jsonl` — **8964 行**（恰 **9 键**） |
| 影像树 | `images/<sha256[:2]>/<sha256>.tiff` — **6347 张**（约 **1.2 GB**） |
| 影像索引 | `images_manifest.jsonl` — **6347 行**（恰 **15 键**；**唯一索引**，见 §4） |
| manifest / report | `manifest.json`（字段字典 / 形製码表 / `audit_status_distribution` / `image_policy` / `oversize_for_xiai_store` / `key_face_status`）、`report.json` |
| 幂等键 | **`source_seal_id` ＝ 复旦 `seqid`**（3679 行非空且唯一） |
| 桥接键 | **`as_book_id`**（印谱业务号，19 种全部命中 feicui `item_ingest.db`）；`seal_links.bridge_item_id` ＝ item 侧 `source_item_id` |
| 内容指纹 | `content_fingerprint = e8155837ff2785cbef1466ab7c419c1b3ed52c213fc6f7de2ecf57dc85e3c447` |
| 包内自检 | 9 条全绿（`ops/seal-ingest/17_package_selfcheck.json`）：索引↔文件**双向一一对应 6347＝6347＝6347（orphan 0 / rows_without_file 0）**、抽样 sha256 20/20 自洽、**逐行 TIFF 魔数 0 违**、超档 6 条、`width/height` 全有、`image_policy` 三子因齐 |

## 2. 印章本体字段面（52 键；**候选键面，未裁**）

```
source_seal_id, seal_uri, category, seal_wen, seal_wen_chs, seal_wen_pinyin,
seal_wen_wzly, seal_wen_wzly_chs, seal_wen_yssw, seal_wen_yssw_chs, seal_wen_wyz,
seal_wen_zjsw, seal_wen_zjsw_chs, seal_ys_xz, seal_ys_label, seal_ys_kf, seal_ys_st,
seal_zyz, seal_yz, seal_yz_person_name, seal_yz_person_name_chs, seal_yz_name,
seal_yz_ref_id, seal_yzzkz, seal_yzzkz_chs, seal_yzzkz_id, seal_bk, seal_bk_chs,
seal_bkzkz, seal_bkzkz_chs, seal_bkzkz_id, as_book_id, related_book, seal_yt_url,
seal_ytsw_url, seal_yzbk_url, seal_yzqt_url, seal_threed_url, seal_title, seal_title_chs,
seal_org, seal_org_name, seal_cz, seal_cc, seal_ly, seal_yn, seal_yksj_lsjn,
seal_yksj_lsjn_chs, seal_yksj_gyjn, audit_status, misc, raw_json
```

- 口径：**繁体为正 ＋ 简体入 `*_chs`**、零转换改写；**`null` 不写空串 / `0` 特值**；`raw_json` 保留源原文（不丢源）。
- **`seal_wen`（印文释文）3679/3679**（本体的核心文本）；**`seal_ys_label`（形製可读值）为 feicui **本地派生**（见下码表），源列表侧恒 `null`**。
- **`audit_status` 全量保留**：实测分布 **`1=2929 / 2=716 / 9=31 / 0=3`**；**`716` 恰等于站点 `statistic.sealCount`（＝「已发布」子集）**。**本包是全量 3679**（Kevin 裁定 A）；若要只要已发布，用 `audit_status=2` 过滤即可。
- **形製码表（`manifest.seal_ys_lookup`，纯函数、20 次标定 0 冲突）**：
  `1=白文方印 · 2=朱文方印 · 3=白文圆印 · 4=朱文圆印 · 5=白文长方印 · 6=朱文长方印 · 7=白文椭圆印 · 8=朱文椭圆印 · 9=朱文异性印 · 10=白文异性印`
  ⚠ **源侧原文写作「异性」（非「异形」）——本包逐字照登、不代改**；`seal_ys_xz` 为 `null` 的行合法（644 行）。
- 关联面字段（行内）：`seal_yz`(印主 person id) 2379 / `seal_yzzkz_id`(篆者) 2652 / `seal_bkzkz_id`(边款篆者) 254 / `as_book_id` 3679 / `related_book` 3679。

## 3. 关联 sidecar（`seal_links.jsonl`，9 键）

```
source_seal_id, link_kind, ref_id, ref_name, ref_name_chs, creator_type, bridge_item_id, source_face, seq
```

- `link_kind` ∈ {`book`(印谱)、`person_yz`(印主)、`person_zzkz`(篆者)、`person_bkzkz`(边款篆者)}；`source_face` 标明来源面（`seal_row` 等）。
- `bridge_item_id` ＝ feicui item 侧 `source_item_id`（可回指印谱）；印谱面 `ref_id` ＝ `as_book_id`。**19 种印谱 100% 命中 item 库**；印人/篆者 id 与 person 库同域。
- ⚠ 实测**个别 `ref_id` 不在印人库（570 人）内**：印主面 **8/438** 行、篆者面 **1/403** 行、边款篆者面 **6/11** 行 —— 系**源侧引用未收录**（源数据引用了人物库里没有的 id），**非缺陷**；建议消费侧按「命中即可解析、未命中保留 `ref_name` 原值」处理。
- 是否入库由你们定（见 §7 X-4）。

## 4. 影像面：**TIFF 直供 xiai 影像库**（重点）

**形态（与你们 `data/originals/` 同形，可直接复制或逐张 POST）**：`images/<sha256[:2]>/<sha256>.tiff`

| 面 | 口径 |
| --- | --- |
| **`sha256`** | **TIFF 字节的 sha256 ＝ 你们的内容寻址键**（`images_manifest.sha256`；也即文件路径名） |
| **`bytes`** | **TIFF 字节数**（源 JPEG 侧另记 `source_bytes` / `source_sha256`，供溯源） |
| 容器 | **TIFF，`RGB 8-bit` ＋ `Deflate`（Compression=8）** —— **照你们 `server/app/codec.py` 的口径做**（未自创；未用 JPEG-in-TIFF） |
| 上限 | 单张 **≤ 4 MiB（`STORED_MAX_BYTES`）**；⚠ 注：`MAX_INPUT_BYTES`=1 MB 是你们**编解码口的输入面**上限，**`/api/image/store` 不校验它**（我方实读 `store.py::validate_payload` 只校验 空 / 4 MiB / TIFF 魔数） |
| 取图口径 | 站点 IIIF **原生裁切 `/full/0/default.jpg`（1:1）**：**放大尺寸一律禁用** —— 我方判定服务器大尺寸为**纯插值上采样**（同区域 1200,→1200×2147 与我方双三次上采样边缘强度 135.71 vs 137.69、MAD 4.32/255、累方差 2858 vs 2824 ⇒ 不增真实信息）；证据 `feicui/ops/seal-ingest/09_upscale_probe.json`（含复跑对拍 `.recheck.json`） |
| 转换性质 | **JPEG → TIFF 无损容器转换**（不重采样、不二次有损编码）；**质量上限受源 JPEG 限制**（站点仅出 JPEG） |
| 入库方式 | 二选一：① 逐张 `POST /api/image/store`（**幂等**：同名同 size 同 sha256 不重写）；② 直接把 `images/**` 树合并进 `data/originals/**` |
| **必须用索引** | 内容寻址后**文件名不含 `seqid`/`kind`** ⇒ **`images_manifest.jsonl` 是唯一回指表**：`seqid · kind(yt=印面/ytsw=印体释文/yzbk=边款) · source_ref · source_url · sha256 · bytes · width · height · source_bytes · source_sha256 · container · conversion · upscaled · oversize_for_xiai_store` |

**影像计数（`report.counts.images`）**：`total 6765 = ok 6347 / source_no_image 418 / failed 0`；按 kind：印面 `yt 3464 ok`、印体 `ytsw 2424 ok`、**边款 `yzbk 459 全成`**。

### ⚠ 6 张超出你们 store 上限（**待你们裁定**，见 §7 X-5）

| seqid | kind | TIFF bytes | W×H | 源 JPEG bytes |
| --- | --- | ---: | --- | ---: |
| 3510 | yt | 4,960,644 | 1586×1498 | 277,175 |
| 3367 | yt | 4,930,210 | 1635×1590 | 278,551 |
| 3464 | yt | 4,822,388 | 1488×1576 | 293,939 |
| 3353 | yt | 4,751,398 | 1536×1510 | 284,976 |
| 3506 | yt | 4,639,606 | 1557×1498 | 264,871 |
| 3366 | yt | 4,379,040 | 1522×1533 | 262,202 |

- 成因：原生裁切本身就大（~1500×1500），TIFF 存 RGB 像素（Deflate 后仍 ~4.4–5.0 MB）。
- **我方处置（既定）**：**保留原生裁切与你们家法格式，不自行降采样、不自行转码**；包内**逐行标记 `oversize_for_xiai_store: true`** ＋ `manifest.oversize_count = 6` ＋ 清单（规范 AC-54；`feicui.spec.md` §9 **R34** 登记四选项）。另：**1–4 MiB 共 219 张**（合规，不需处理）。

## 5. 源侧缺图 418 张（**源侧事实，非我方可控**）

- `source_no_image = 418`，子因三态：**`http_500` 415**（有界重试后仍 500；**1/4/8 并发下失败集合完全相同、全程 0 次 429** ⇒ **按 ref 恒定、非限流**；失败 ref 按来源前缀整批集中）、**`nan_ref` 2**（源 ref 以 `NaN_` 开头）、**`bad_bytes` 1**（`2_3609_1`：HTTP 200 ＋ `content-type: image/jpeg`，但正文 697 B 是 iipsrv 把自己的响应头当正文吐出来的，不可解码、持久复现）。
- **站点自身页面同样是坏图**（实测 `#/home/yzDetail/1029`、`/1030` 的图 `naturalWidth = 0`）⇒ **源侧缺图**。
- **我方从不把它计入 `failed`**（`failed = 0`）；清单与按前缀聚合见 `report.source_missing` 与 `feicui/ops/seal-ingest/08_source_missing.json`。
- **去留请你们定**（见 §7 X-6）：留空白行 / 不落行 / 落行但标缺图。

## 6. 与印人 / 印谱两线的异同（避免踩坑）

| 面 | 印人 | 印谱 item | **印章 seal** |
| --- | --- | --- | --- |
| 幂等键 | `source_person_id` | `source_item_id` | **`source_seal_id`（`seqid`）** |
| 列表一次全量 | 570 | 1742 | **3679** |
| detail 关系 | 与 list 同构（可省） | **不同构**（降 best-effort） | **不同构**（list 独有 `*_chs`；detail 独有 `seal_ys_label`/`seal_yz_ref_id`/`audit_user`）⇒ **形製标签改由本地码表派生，detail 默认关** |
| 关联来源 | `graph/person` | `graph/book` | **行内字段即可**（`seal_yz`/`seal_yzzkz_id`/`as_book_id`） |
| 影像 | 无 | 无 | **★ 有：6347 张 TIFF 直供（1.2 GB）** |
| 键面状态 | 已按你们 21 键裁好 | `pending_xiai` | **`pending_xiai`（52 键／候选）** |

## 7. 请你们定的项

| # | 事项 | 说明 |
| --- | --- | --- |
| **X-1** | **印章模型 / 集合名 / 索引** | 建议 `xiai_seals`（`source_seal_id` 唯一、`sha256` 建索引以接影像库）；是否收 `seal_links` |
| **X-2** | **就绪包键面裁剪** | 现包为**候选键面**（`manifest.key_face_status = "pending_xiai"`，52 键）：你们定键面后告知，feicui **二次出包（不联网、从本库重建）** |
| **X-3** | **导入通道** | 建议沿用你们三段式：`submitSealImport` → 暂存（`PENDING`）→ 管理员批量采纳 → 正式集合（按 `source_seal_id` 幂等） |
| **X-4** | **`seal_links` 关联是否入库** | 8964 行（印章↔印谱↔印人）；可扩导入行键面或另立关联集合 |
| **X-5** | **影像入库方式 + 6 张超档如何处置** | ① 逐张 `POST /api/image/store` ／ ② 复制 `images/**` 树；超档四选项：**(a)** 你们放宽 `STORED_MAX_BYTES`；**(b)** 落库标超档、不缩图（本包默认姿态）；**(c)** 你们侧另降采样；**(d)** 本包剔除这 6 条 |
| **X-6** | **源侧缺图 418 行的去留** | 留空白行（`has_image=false` 类）／不落行／落行 + 缺图标记 ／ 另记一集合 |
| **X-7** | **是否需要 `audit_status ≠ 2` 的行** | 现为全量 3679（Kevin 裁定 A）；若只要已发布，按 `audit_status=2` 过滤得 **716** |

## 8. 锚点（供你们复核）

- `seqid=3922`「二金蝶堂」：印文「二金蝶堂」、形製「白文方印」、印主/篆者 **趙之謙（`907404573`）**、所属印谱 **`1967` / `as_book_id 0113`「二金蜨堂印存」**。
- `seqid=3894`「解社范叔」→ 魯盦印選（`3072`）；`seqid=3921`「test」（**源侧真数据，未过滤**）。
- 影像锚点：`seqid=3510`（超档代表）、`seqid=1000`（常规，源 JPEG 13,355 B）。

## 9. 重新生成就绪包（feicui 侧）

```bash
cd /Users/kevin/bistro/xiai/feicui
# 采集（幂等、可续跑；已存在且 sha 一致即跳过；429 一律判负）
server/.venv/bin/python -m app.seals sync --batch-id seal_20261010_01
cd server && ../server/.venv/bin/python -u -m app.seals sync-images --batch-id seal_20261010_01 --img-workers 8 --img-delay 0.1
../server/.venv/bin/python -m app.seals convert-images --db ../var/seal_ingest.db   # JPEG→TIFF 幂等补转
../server/.venv/bin/python -m app.seals package --batch-id seal_20261010_01        # 出包（零联网）
```
- HTTP：`POST http://127.0.0.1:5196/api/seals/package`（可选 `batch_id`；缺省取库内最新批次）；页面 `http://localhost:5164/feicui/seals` →【生成 xiai 就绪包】。
- **重建幂等**：仅时间戳变、JSONL 字节不变；**重出包不重转影像**。

## 10. feicui 侧落点（备查）

| 事项 | 位置 |
| --- | --- |
| 实现 | `feicui/server/app/seals.py`、`server/app/routers/seals.py`、`web/src/pages/SealsPage.vue`、`web/src/api/seals.js`；新依赖 **Pillow 12.3.0**（`server/requirements.txt`） |
| 规范 | `feicui/docs/feicui.spec.md` **v1.18**（**§3.17 印章采集**（含 §3.17.8 影像面 a-v1.16/17/18 三块）＋ **AC-34〜AC-54**＋**R33/R34**） |
| 证据 | `feicui/ops/seal-ingest/**`（含 9 条包自检、三态与缺图清单、上采样探针与复跑对拍、门禁指纹 before/after、幂等重放、API 与浏览器自检） |
| 提交 | `94abca1` → `ac3a7e9` → `b775a72`（**本地已入库、待推送**；质检通过后统一 push） |
| 源站提醒 | 站点级窗口限流：HTTP 200 ＋ `code="429"`（**字符串**）＋ `status=true` ＋ 无 `data`；**影像与 API 共用同一窗口** |
