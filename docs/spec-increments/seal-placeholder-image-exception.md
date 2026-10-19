# 影像例外：sealbank 占位图（`placeholder/seal-no-image`）

> 单页说明。落地范围：`src/data/seed.js` / `cloudfunctions/xiai-user-token/lib/ops.js` /
> `src/services/seals.js` / `src/services/sealPlaceholderAsset.js` /
> `public/placeholders/seal-no-image.jpg` / `scripts/register-seal-placeholder-image.mjs` /
> `scripts/verify-seal-placeholder.mjs`。

## 1. 影像存储落点（代码证据）

| 面 | 落点 | 证据 |
|---|---|---|
| 影像**元数据行** | CloudBase 集合 **`xiai_images`** | `cloudfunctions/xiai-user-token/lib/ops.js:107`（`images: 'xiai_images'`）；线上实测 79 行 fixture（`docs/versions/xiai.spec.v1.65.md` §3.33.3 追加注 v1.41） |
| 影像**二进制** | CloudBase **云存储桶**（env 同 liwu；bucket 默认 `6c69-liwu-d8gek6jjdab1d087c-1463728495`） | `src/data/cloudbase.js:153`（`CLOUD_STORAGE_BUCKET_DEFAULT`）、`:1204`（fileID ＝ `cloud://<envId>.<bucket>/<对象键>`） |
| 对象键命名 | `xiai/images/<sha 前两位>/<sha64>.png|webp`（源件行 `.tiff` ⇒ 派生 `.png` 展示键） | `src/data/cloudbase.js:156`（`IMAGE_OBJECT_KEY_PATTERN`）、`:1163`（TIFF 源件）、`:1183`（`cloudBaseObjectKeyOf`） |
| 行内 `storage` | 云端行恒 **`server`** | `src/data/cloudbase.js:1185` |
| 本机/dev 回落 | localStorage 行 ＋ **IndexedDB** 二进制（`storage='indexeddb'`、`storage_key='photo:<id>'`） | `src/data/db.js:1364`（`listImageRows`）、`:2690`（迁移回填 `storage: 'indexeddb'`） |

**结论**：生产影像**二进制确实在 CloudBase 云存储**，行在 `xiai_images`；本机无 CloudBase 管理端凭据
（`TENCENTCLOUD_SECRETID` / `SECRETKEY` 未配置、未 `tcb login`）⇒ **本单未向生产写任何一行**
（登记脚本默认 dry-run；`--write` 在凭据缺失时以码 3 退出）。

## 2. 现有拦截点（本单前）

| 门 | 位置 | 对占位键的行为 |
|---|---|---|
| 提交门 | `ops.js::submitSealImport`（`faces.length===0` ⇒ 需 `source_no_image`） | **不查**影像引用存在性 ⇒ 占位键**不拦** |
| 采纳门（引用存在性） | `ops.js:2469` `hasRef`＝「非空即算有引用」；`ops.js:1210` 按 `sha256` / `storage_key` 查 `xiai_images` | 只要 `xiai_images` 有这条登记行就**放行**；多条目复用同一张图天然支持（按 key 查） |
| 通用内容寻址 | `src/data/cloudbase.js:1183` `cloudBaseObjectKeyOf` | **会拦**：`placeholder/seal-no-image` 不匹配对象键模式 ⇒ 回空串（**这是正确行为**，桶里确实没这个对象） |
| 展示 | `src/services/seals.js::loadImageDataUrl` / `loadStoredImage` | 云端分支因上一行为空被跳过 ⇒ 本机 IndexedDB 也取不到 ⇒ 「影像暂时无法显示」 |

⇒ **真正需要改的不是「校验」，而是「展示取字节那条路」** 。通用校验规则**一字未改**。

## 3. 例外实现（最小）

1. **常量**（两处逐字同值，自检 A1/A2 断言）：
   `SEAL_PLACEHOLDER_IMAGE_KEY = 'placeholder/seal-no-image'`，`SEAL_PLACEHOLDER_IMAGE`
   ＝ `{ id, sha256, bytes: 23357, mime: 'image/jpeg', width/height: 512, storage: 'bundled' }`。
2. **登记行**：`xiai_images` 一条 `_id='img-placeholder-seal-no-image'`、`storage='bundled'`
   （**不是** `server` ⇒ 内容寻址判据刻意不认它）、`source_scope='sealbank'`；**不含二进制**。
   写入脚本：`scripts/register-seal-placeholder-image.mjs`（幂等 `doc(id).set` ＋ 写后回读核验）。
3. **字节来源**：仓内随包资产 `public/placeholders/seal-no-image.jpg`（512×512、23,357 B、
   已 `-strip` 去除 EXIF）。`src/services/sealPlaceholderAsset.js` 只认登记键，并把
   「字节数 ≠ 登记值」判为**结构化失败**。
4. **来源门**（`sealPlaceholderRefDenial`）：任一印面 `image_storage_key === 占位键` 且
   **来源标签不含 `sealbank`** ⇒ 拒。三处同判：`seed.js`（客户端）、`services/seals.js`（本机写面）、
   `ops.js`（云函数提交门 ＋ 采纳门）。
5. **摘要门**：指向占位键者，`image_sha256`（若宣告）与解析到的行 `sha256` 都必须 ≡ 登记摘要
   （防「同键换图」）。

## 4. 反例仍被拒（`scripts/verify-seal-placeholder.mjs` E/F 段）

| # | 反例 | 结果 |
|---|---|---|
| ① | 非 sealbank 来源指向占位键 | 提交门 `INVALID_VALUE` ＋ 零写入；直投采纳门亦拒 |
| ② | `faces` 指向不存在的 key | 提交门放行（既有语义：提交不解析影像）；**采纳门拒** |
| ③ | `faces=[]` 且无 `source_no_image` | 提交门 `MISSING_REQUIRED` ＋ 零写入 |
| ④ | `image_status` 值域外 | 提交门 `INVALID_VALUE` ＋ 零写入 |
| ⑤ | 占位键 ＋ 摘要不符 | 采纳门拒 |
| F3 | 非占位键的普通引用（非 sealbank 来源） | **不受影响**（门只认这一个键） |

## 5. 10 条真跑

`node scripts/verify-seal-placeholder.mjs`（源：feicui `out/xiai_imports_sealbank.ndjson`，5,529 行等距 10 条）
与 `--ndjson …_placeholder.ndjson`（feicui `index --placeholder` 产出）各跑一遍：
**占位图模式 10/10 提交门 ok ＋ 10/10 采纳门 ok（印面 `face_image_id='img-placeholder-seal-no-image'`）**；
**无图对照 10/10 双门 ok（0 印面行）**；30 条断言全绿。

## 6. 未做 / 待凭据

- **生产 `xiai_images` 登记行未写**（无管理端凭据）。具备凭据后：
  `TCB_ENV=… TENCENTCLOUD_SECRETID=… TENCENTCLOUD_SECRETKEY=… node scripts/register-seal-placeholder-image.mjs --write`
- **未在真实浏览器验证占位图渲染**（需起 dev 服 ＋ 有 CloudBase 行的会话）；本单只验证了
  「资产字节 / 登记值 / 分支判据」三者一致（`loadImageDataUrl` 的占位分支按 `storage_key` 命中）。
- 占位图**不写入** CloudBase 桶：`storage='bundled'` 是刻意的（否则要放宽内容寻址判据）。
