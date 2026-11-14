# 印章详情页「新增印面」功能 —— 需求裁定件

- 状态：**已裁定**（Kevin 2026-11-14 CST，选 A 方案：开发）
- 性质：**非规范**。本件是并发实现 / 规范 / 质检单的唯一口径真源；规范条款由 Jing 落 `docs/xiai.spec.md`。冲突以本件为实现契约并当场回报。
- 派单方：Zang。实现：Kong（云函数单 ＋ 前端单）。规范：Jing。质检：Neng（串行）。

## 一、背景与现状（派单前已实测，勿再猜）

- `xiai_seals` 1252 行；`xiai_faces` 1044 个「章 → 面组」，其中 **529 枚章已有 ≥2 个 FACE 面** ⇒ 历史上卡死「同章第二个 FACE 面」的 `xiai_faces.(kind, sealId)` 唯一索引**已不在库**，数据层支持 1 印 : N 面。
- `AACQF` 当前 = 1 面（`fc-AACQF-f1`，`face_no 2193`，`is_primary:true`，影像 `img-2984f1ae`）。
- 缺口**只在 UI**：详情页每个印面块只有「編輯固定屬性 / 重新上傳印面圖 / 人工智能修復」三个管理员按钮，没有任何建面入口；`上傳印章` 弹窗只建**新章带 1 面**，无边款位。
- 页面既有文案「一枚印章可含多個印面，邊款是其中的特殊印面」属只读说明 ⇒ 用户会把它读成能力承诺（本次需求即由此而来）。

## 二、可复用的既有单点（实现方必须复用，不得第二套）

| 单点 | 位置 | 用途 |
|---|---|---|
| `nextFaceIdOf(stampId, kind, taken)` | `lib/ops.js`（约 1820 行） | 面行 id ＝ `fc-<章序号>-f<n>` / `-e<n>` |
| `issueCodeNumberAvoiding('face', isTaken)` | `lib/ops.js`（约 2419 行） | `face_no` 发号，**避让全库已占号**（释放号优先） |
| `codeId.encodeFaceCode(face_no)` | 既有模块 | 由 `face_no` 恒重算 `fid` |
| 「补缺失面」建行骨架 | `lib/ops.js` 约 4520–4580 行 | 面行完整键集 ＋ `is_primary` 判定 ＋ `face_count` 回出 |
| 影像四道形态门 | 与 `registerFaceImage` 同一张表 | `sha256` 64 位小写十六进制 ＋ 对象键只认 `xiai/images/<sha 前两位>/<sha>.tiff` |
| `registerFaceImage` | 既有管理员 op（前端先调） | 建面前**必须**先把图入册，拿到 `image_id` |

## 三、op 契约：`addSealFace`（新，入院 `ADMIN_OPS` 40 → 41）

- **管理员面**：`adminWhitelistDenial` 门**第一行**即判（缺 env / 非白名单 ⇒ 结构化拒 ＋ 零读零写）。
- **载荷封闭恰 7 键**：`stamp_id` / `kind` / `sha256` / `bytes` / `mime` / `storage_key` / `seal_name`。
  - `stamp_id` 必填（trim 非空、≤64）；印章行不存在 ⇒ `INVALID_VALUE` ＋「該印章不存在；本次零寫入。」
  - `kind` 缺省 `FACE`；只接受 `FACE` / `EDGE`（其它 ⇒ `INVALID_VALUE`）。
  - 影像四道形态门与 `registerFaceImage` **同一张表、同一条文案**（摘要 64 位小写十六进制；对象键形态；`bytes` 正整数且 ≤ 上限；`mime` 白名单）。
  - `sha256` 对应的 `xiai_images` 行**必须已存在**（前端先调 `registerFaceImage` 入册）⇒ 未入册 ⇒ `INVALID_VALUE`，文案点名「請先經 registerFaceImage 入冊」。
  - `seal_name` 可选（空串⇒落章行的 `seal_name`）。
- **写序（单事务语义，逐步落盘）**：① 读章行 ＋ 现有面行 → ② 幂等预查 → ③ 发面行 id（`nextFaceIdOf`）→ ④ 发 `face_no`（`issueCodeNumberAvoiding`，避让全库）→ ⑤ 算 `fid` → ⑥ 建面行 → ⑦ 更新章行 `face_count`。任一步失败 ⇒ 结构化失败，**不留半成品面行**（已建则删除回滚；`face_count` 未改）。
- **面行键集**（与既有构造点逐字同形）：`id` / `sealId` / `stamp_id` / `face_no` / `fid` / `kind` / `face_image_id`（FACE）或 `edge_image_ids`（EDGE，恰 1 项）/ `seal_name` / `dynasty` / `seal_type` / `face_style` / `seal_class` / `author` / `author_person_id` / `transcription` / `image_source_kind` / `source` / `uploaded_by` / `created_at` / `updated_at` / `is_primary`（**仅 FACE**）。
  - 本 op 不写 `author_person_id`（空串）、不写 `transcription`（空串）—— 属性留白，建后由既有「編輯固定屬性」补。
- **`is_primary` 判定**：章**已有任一 FACE 面** ⇒ 新面 `is_primary:false`（不抢既有主印面）；章**尚无 FACE 面**且新面是 `FACE` ⇒ `true`。`EDGE` 永不落该键。
- **`face_count` 维护**：新面是 `FACE` ⇒ 章行 `face_count + 1`；`EDGE` ⇒ **不变**（`face_count` 只数非 EDGE）。写体只含 `face_count` 一个键，不碰其它字段。
- **幂等**：同 `(stamp_id, kind, sha256)` 已存在面行 ⇒ 不建第二行，回 `{ok:true, face_id:<既有>, skipped:true, face_count:<现值>}`（additive 键，`index.js` 按 op 收窄透传）。
- **成功回包**（本 op 自有读数）`{ok, face_id, face_no, fid, kind, face_count}`；失败恒**恰 3 键** `{ok, reason, message}`。`reason` **零新增字面值**（只用既有 `INVALID_VALUE` / `INVALID_FIELD` / `FORBIDDEN` / `MISSING_REQUIRED` / `STORAGE_UNAVAILABLE`）。
- 不写流水、不计费、不产 `plan` 外泄。

## 四、前端契约

- **入口钩子**：`data-action="add-seal-face"`（**不进 `[data-admin-action]` 族** —— 该族取值集合已冻结计数，扩展会连撞断言；参照 `correction-revoke` 的先例）。
- 位置：详情页「印面列表」区块标题旁（每个印面块之外、只在区块出现**一次**，不逐块复制）。管理员专属条件渲染（游客/普通用户 DOM 零命中）。
- 弹窗内容：
  - 类型：印面（FACE，缺省）/ 边款（EDGE）二选一；
  - 图：**必填**，两条并列路径 —— ① 選擇本機文件；② 粘貼剪貼板（必须复用 `src/utils/clipboardImage.js` 的 `PASTE_HINT` ＋ `handleClipboardPaste`，不另写贴图解析）；
  - 印文（可选，≤ 既有上限）；
  - 提交 / 取消。
- **上传管道**（与既有入口同一条）：`loadImageFile` → `inputDenialOf` → `runUploadPipeline`（产出单页 8bit Deflate **TIFF**）→ `storeArtifactBytes` → `registerFaceImage`（拿影像编号）→ `addSealFace`。**不得**直接拿原始 PNG/JPG 字节入册（对象键只认 `.tiff`，会被拒）。
- 成功后：重取云端快照（与既有写面同一刷新路径）＋ 一条页面级成功提示（繁体，`s2t(x) === x`），说明「新印面已加入，印面圖與屬性可繼續編輯」。
- 失败：结构化文案上屏（不得吞成一句），零写入；影像已入册但建面失败 ⇒ 如实提示「影像已入冊但印面未建立」，不谎称零写入。
- 弹窗形态守既有口径：`role="dialog"` ＋ `aria-label`、一次性提交守卫（防重提交）、提交中禁用。

## 五、规范（Jing 落 `docs/xiai.spec.md`，版本按现盘续 v1.111）

须入册：新增节（`addSealFace` 全契约：门/载荷 7 键/写序/幂等/`is_primary`/`face_count`/回包键面）＋ 前端入口与上传管道口径 ＋ 新增 AC 段（至少覆盖：载荷键面与四类拒绝、幂等不建第二行、`is_primary` 两条分支、`face_count` FACE +1 / EDGE 不变、非管理员零写、未入册影像拒绝、卡片 14 键与面筛选仍绿）。`ADMIN_OPS` 40 → 41；计数面同步；`data-action` 钩子新增值须登记但**不计入 `data-admin-action` 族**。

## 六、不可动项（越界即退回）

卡片 DTO 14 键；`PUBLIC_OPS` 4 成员且恒零写；`face_count >= 1` 过滤；`q` 检索 12 字段表；既有四个面级/印章级 op 的载荷与回包键面；`[data-admin-action]` 取值集合；`reason` 零新增字面值；零全表扫描。

## 七、验收（生产端到端，缺一不可）

1. 给 `AACQF` 加一个 **FACE** ⇒ 库内该章 2 个 FACE、`face_count` 由 1 变 2、原面 `is_primary` 仍 `true`、新面 `false`、`fid` 与 `face_no` 递增且全库唯一。
2. 再加一个 **EDGE** ⇒ 该章边款块出现、`face_count` **仍为 2**（EDGE 不计）。
3. 同图重放（同 `stamp_id` + `kind` + `sha256`）⇒ `skipped:true`、库内面行数不变。
4. 非管理员调 `addSealFace` ⇒ `FORBIDDEN` ＋ 零写入；未入册的 `sha256` ⇒ `INVALID_VALUE`。
5. 干净浏览器（零本机镜像）打开该章 ⇒ 新面可见（证面行真落库、非本机镜像）。
6. 首页 `listSealCards` 仍正常（`total` 不变口径）＋ 面筛选（`seal_type` / `face_style`）仍工作。
7. 上传即建面：选 PNG/JPG 也能成功（走 TIFF 转容器），且桶内对象键为 `xiai/images/<sha 前两位>/<sha>.tiff`。
