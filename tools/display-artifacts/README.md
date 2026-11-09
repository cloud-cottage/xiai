# tools/display-artifacts — 展示件 / 缩略图离线批量转码 + 直传 COS

把内容寻址 TIFF（`data/originals/<sha 前两位>/<sha>.tiff`）离线批量转成
**展示件 WebP** 与 **缩略图 WebP**，直传多云对象存储，供前端直出 ——
不经云函数，绕开 6MB 请求体与 60s 网关。

- 入口：`transcode.mjs`（Node 18+，无第三方依赖；只用本机 `magick` 与 `@cloudbase/node-sdk`）
- 写集：仅本目录（`transcode.mjs` / `README.md` / `progress.jsonl`）
- 不碰 `src/**`、`cloudfunctions/**`、`docs/**`、`scripts/**`、`package.json`，不 git add/commit/push，
  **不写任何数据库集合**（只写 COS 对象 + 本地进度文件）
- TIFF 与中间产物一律落在 `$TMPDIR`，跑完自动清理，**不写进仓库**

## 转码口径（Kevin 裁定，硬口径，不得放宽）

| 产物 | 口径 | 实际命令 |
| --- | --- | --- |
| 展示件 | **零重采样**：既不放大也不缩小，保留原图宽高，只做 TIFF→WebP 容器/编码转换；无任何 `-resize`、无上限 | `magick '<src>[0]' -strip -quality 92 -define webp:method=6 <out>` |
| 缩略图 | 长边上限 **256**，**只缩不放**（原图长边 <256 保持原尺寸） | `magick '<src>[0]' -resize 256x256> -strip -quality 82 <out>` |

- `[0]`：源是多页 TIFF 时取第 1 页；**16bit 不得因此改变尺寸**。
- `>` 后缀即「仅当大于时缩放」，是「只缩不放」的实现，**不得改写**。
- 每张一遍遍历出两个对象：两次 `magick` 转码 + 一次 `magick identify`（同时读源/展示件/缩略图三者宽高），
  转码时当场断言：
  - 展示件宽高 **逐字等于** 源 TIFF 第 1 页宽高；
  - 缩略图长边 == `min(源长边, 256)`。
  任一断言不过 ⇒ 该张记 `failed`，不上传。

## 产物键（内容寻址，与入库行 sha256 同键 ⇒ 采纳后自动接上）

```
xiai/display/<sha 前两位>/<sha>.webp     展示件（原生尺寸）
xiai/thumb/<sha 前两位>/<sha>.webp       缩略图（长边 ≤256）
```

目标环境默认 `liwu-d8gek6jjdab1d087c`（生产在用），`--env` 可切。

## 用法

```bash
# 先小量 dry-run：只解码与算尺寸，不探测、不上传、不写进度
node tools/display-artifacts/transcode.mjs --limit 20 --dry-run

# 小量真跑（真上传到默认环境）
node tools/display-artifacts/transcode.mjs --limit 20

# 全量（6,347 张；断点续跑，随时可 Ctrl-C，重跑接着来）
node tools/display-artifacts/transcode.mjs

# 只处理 manifest 外的 10 张孤儿 TIFF（默认是跳过并列 sha）
node tools/display-artifacts/transcode.mjs --include-orphans --limit 10 --dry-run
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--manifest <path>` | `/Users/kevin/bistro/feicui/exports/seal_import_seal_20261010_01/images_manifest.jsonl` | 入口清单 |
| `--originals <dir>` | `data/originals` | 内容寻址 TIFF 根目录 |
| `--progress <path>` | `tools/display-artifacts/progress.jsonl` | 进度 JSONL（本目录） |
| `--env <envId>` | `liwu-d8gek6jjdab1d087c` | 目标 CloudBase 环境 |
| `--limit <n>` | 0（全部） | 只处理前 n 张（按 manifest 顺序；`--include-orphans` 时孤儿排在后面） |
| `--batch <n>` | 500 | 单批张数：转码 → 探测 → 上传 → 落进度（每批落盘一次） |
| `--concurrency <n>` | 4 | `magick` 子进程并发 |
| `--probe-chunk <n>` | 50 | `getFileInfo` / `getTempFileURL` 单次条目数（**硬上限 50**：传更大也只按 50 分批，只能调小） |
| `--dry-run` | off | 只解码算尺寸：不探测、不上传、**不写进度文件** |
| `--include-orphans` | off | 连 manifest 外孤儿 TIFF 一并处理 |

退出码：`0` 全部成功；`1` 有 `failed` 或回读断言失败；`2` 有 `conflict`（同键不同字节，未覆盖）。

## 凭据

取 `~/.config/.cloudbase/auth.json` 的 `credential.tmpSecretId / tmpSecretKey / tmpToken`。
注意两点（实测）：

1. **必须带 `sessionToken: tmpToken`**，否则所有请求报 `SIGN_PARAM_INVALID / secret id error`；
2. 临时密钥会过期：剩余不足 10 分钟、或请求报凭据类错误时，自动跑一次 `tcb env list` 刷新后重读文件
   （60s 内只刷一次，避免风暴）。

上传前还会用一次 `getUploadMetadata` 拿本环境的 `cloud://<env>.<bucket>/` 前缀，探测要靠它拼 fileID。

## 幂等语义

上传前先探对象（`getFileInfo` → 对已存在者 HEAD `content-length`）：

> **批量上限（平台硬限）**：CloudBase `getFileInfo` / `getTempFileURL` 单次最多 **50 个 fileID**，
> 超限报 `INVALID_PARAM: Cannot operate more than 50 files one time …`。
> 分批在 `Cloud.probe` / `Cloud.tempUrls` 内自行按 `Math.min(remaining, 50)` 计算
> （常量 `PROBE_CHUNK_MAX = 50`），**不依赖调用方传参**；全量 6,327 张曾因按 100 分批整批全 failed。

| 探测结果 | 动作 | 计数 |
| --- | --- | --- |
| 不存在 | 上传 | `uploaded` |
| 存在且字节数 == 本地 | 不动 | `skipped`（对象级 `exists`） |
| 存在但字节数不同 | **不覆盖** | `conflict` |

- 图片级状态：任一对象 `error` ⇒ `failed`；否则任一 `conflict` ⇒ `conflict`；
  否则任一 `uploaded` ⇒ `ok`；两族都已存在同字节 ⇒ `skipped`。
- 转码失败与上传失败各重试 **2 次**（共 3 次尝试）。
- 编码是确定性的：同一源 + 同参数 ⇒ 同字节，所以「已存在同字节」是可靠的复跑判据
  （实测：手工先传过 1 个展示件，正式跑时它被识别为同字节 `exists`，只补传了缩略图）。

## 续跑语义

- 进度文件 JSONL 逐行追加（每批落盘一次），**中途被掐不丢已完成进度**。
- 启动时读回：`status ∈ {ok, skipped}` 的 sha 直接跳过（不转码、不探测、不上传）；
  `failed` / `conflict` 会被重新检查（失败可自愈，冲突持续暴露给派单方裁定）。
- `dry-run` 不写进度，不会污染后续真跑的幂等判断。
- 字段：`sha / at / status / native_w / native_h / thumb_w / thumb_h / display_bytes / thumb_bytes / ms / objects / error? / orphan? / manifest_mismatch?`
  （`native_*` = 展示件原生宽高 == 源 TIFF 宽高，**无缩放语义**；`thumb_*` = 缩略图宽高。）

## 对账三读数（每次跑完必打）

```
[读数1] manifest 行数 = <行数>（唯一 sha = …，重复 = …）
[读数2] 成功处理唯一 sha 数 = …（ok=… skipped=…；conflict=… failed=… none=…，本批候选 …）
[读数3] 两族对象应到数 = 读数2 × 2（display N + thumb N）
```

外加 `[本 run 处理明细]`（幂等复跑时 `幂等跳过=… 新处理=0`）、`[统计]`（对象级新上传/已存在/conflict）、
`[孤儿]`（manifest 外 10 张 sha 全列，不静默丢；`--include-orphans` 时打
`本批纳入 N 张【单独计数】（解码/成功 n/N）`）、`[conflict]` / `[failed]` 明细。

## 回读抽样（跑完必打）

从本次成功 sha 中均匀抽 **12 张**，用 `getTempFileURL` 下载回 `$TMPDIR` 断言：

- 两族对象都能被 `magick identify` 解码且格式为 `WEBP`；
- 展示件宽高 **逐字等于** 源 TIFF 第 1 页宽高；
- 缩略图长边 == `min(源长边, 256)`。

打印 `[回读 n/12] … PASS/FAIL` 与汇总；有 FAIL ⇒ 退出码 1。

## manifest 外的 10 张 TIFF

磁盘 6,357 张、manifest 6,347 行，多出的 10 张**默认跳过**，sha 逐条列在报告里
（不入库、不静默丢）；要处理用 `--include-orphans`，会单独计数并打 `orphan:true`。

## 已跑小量读数（2026-11-09，本机实跑）

1. `--limit 20 --dry-run`：解码 20/20，全部 `native == 源宽高`，缩略图长边均 == `min(源长边,256)`，退出码 0；未写进度。
2. `--limit 20`（真上传）：`读数2 = 20（ok=20）`、`读数3 = 40`；对象级 `已存在同字节=1 新上传=39 conflict=0`；
   回读 `12/12 PASS`；退出码 0。
   独立复核：40 个对象全部存在、缺失 0、总字节 566,052 B，例如
   `xiai/display/d2/d24c3c12…d8c84.webp = 16,202 B`、`xiai/thumb/d2/d24c3c12…d8c84.webp = 6,680 B`。
3. `--limit 20` 复跑（幂等）：`[plan] 续跑跳过=20 待处理=0`、
   `[本 run 处理明细] 幂等跳过=20 … 新处理=0（ok=0 对象已存在=0 conflict=0 failed=0 decoded=0）`、
   解码 0 张、新上传 0 个、回读仍 `12/12 PASS`，退出码 0。
4. `--limit 200 --probe-chunk 500`（2026-11-09，修 50 分批上限后实跑；**故意传 500** 验证硬限不吃调用方参数）：
   `[plan] 本批候选=200 续跑跳过=20 待处理=180` —— 进度里前 200 张中 180 张 `failed`（`getFileInfo` 超限）
   **全部被重新检查并转 ok**，只跳过 20 张历史 `ok`；`读数2 = 200（ok=200 skipped=0；conflict=0 failed=0 none=0）`、
   `读数3 = 400`；对象级 `已存在同字节=0 新上传=360 conflict=0`、图片级 `failed=0`；回读 `12/12 PASS`；
   进度 6,347 → 6,527 行。
5. 同参数复跑（幂等）：`[plan] 续跑跳过=200 待处理=0`、
   `新处理=0（ok=0 对象已存在=0 conflict=0 failed=0 decoded=0）`、解码 0 张、新上传 0 个、
   进度文件仍 6,527 行、回读 `12/12 PASS`，退出码 0。

全量（6,347 张 × 2 族）由派单方另跑。

## upload-originals.mjs — 原图 TIFF 直传 COS（同目录新增）

与 `transcode.mjs` 分工：transcode 只产展示件/缩略图（`xiai/display`、`xiai/thumb`）；
本脚本把**原图 TIFF 字节本身**搬到内容寻址键，供影像入册 op 回读对象字节、现算 sha256 逐字比对：

```
源   data/originals/<sha 前两位>/<sha>.tiff        （6,357 张 / 1,237,405,497 B）
目标 xiai/images/<sha 前两位>/<sha>.tiff           （与 §3.61.6 image_storage_key、
                                                    src/services/imageAuthority.js#artifactObjectKeyOf 逐字一致）
```

- 入口：`upload-originals.mjs`（Node 18+，无第三方依赖；只用本机 `@cloudbase/node-sdk`）
- 写集：仅本目录（`upload-originals.mjs` / `README.md` / `progress-originals.jsonl`）＋ COS 对象；
  不碰 `transcode.mjs` / `progress.jsonl`，不碰 `src/**`、`cloudfunctions/**`、`docs/**`、`scripts/**`、
  `package.json`，不 git add/commit/push，**不写任何数据库集合**
- 中间文件不落仓库：回读字节在内存校验（临时目录用 `$TMPDIR`，跑完即删）

```bash
node tools/display-artifacts/upload-originals.mjs --limit 5 --dry-run   # 只算 sha 与字节
node tools/display-artifacts/upload-originals.mjs --limit 5             # 小量真跑
node tools/display-artifacts/upload-originals.mjs                        # 全量（断点续跑）
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--originals <dir>` | `data/originals` | 内容寻址 TIFF 根目录 |
| `--progress <path>` | `tools/display-artifacts/progress-originals.jsonl` | 进度 JSONL（**与 transcode 的 `progress.jsonl` 分开**） |
| `--env <envId>` | `liwu-d8gek6jjdab1d087c` | 目标 CloudBase 环境 |
| `--limit <n>` | 0（全部） | 只处理前 n 张（**按 sha 升序** ⇒ 同一 limit 每次同一批） |
| `--batch <n>` | 500 | 单批：自证哈希 → 探测 → 上传 → 落进度 |
| `--concurrency <n>` | 4 | 哈希 / 上传并发 |
| `--probe-chunk <n>` | 50 | 探测/取临时 URL 单次条目数；**平台上限恰 50**（见下） |
| `--dry-run` | off | 只算 sha 与字节：不探测、不上传、不写进度 |

### 上传前本地自证（不等 ⇒ 不上传）

文件名 sha 与**文件实际内容 sha256** 逐字相等才允许上传；不等 ⇒ 记 `badfile`
（`error` 里带 `actual=`，报告逐条列出 `xiai/images/…`），**不上传**。
上传那一刻再做一次二次自证（重读文件、现算 sha256、字节数与自证时比对），任一不符即失败、不发请求。

### 幂等语义（与 transcode 同口径）

| 探测结果 | 动作 | status |
| --- | --- | --- |
| 不存在 | 上传 | `ok` |
| 存在且字节数 == 本地 | 不动 | `skipped` |
| 存在但字节数不同 | **不覆盖** | `conflict`（退出码 2） |

### 续跑语义

- `progress-originals.jsonl` 逐行追加：`sha / at / status(ok\|skipped\|conflict\|badfile\|failed) / bytes / ms / key / error?`
- 启动读回：`status ∈ {ok, skipped}` 直接跳过（不哈希、不探测、不上传）；
  `failed / conflict / badfile` 会被重新检查（失败可自愈、冲突持续暴露）。
- `dry-run` 不写进度，不污染真跑的幂等判断。

### 凭据

取 `~/.config/.cloudbase/auth.json` 的 `credential.tmpSecretId / tmpSecretKey / **tmpToken**`，
**必须作 `sessionToken` 注入**（缺它一律 `SIGN_PARAM_INVALID / secret id error`）。
剩余不足 10 分钟、或请求报凭据类错误时跑一次 `tcb env list` 后重读文件（60s 内只刷一次）。

### ★ 平台硬限制：单次探测 ≤ 50 个 fileID（实测）

`getFileInfo` / `getTempFileURL` 单次 `fileList` **超过 50 条**直接报
`INVALID_PARAM: Cannot operate more than 50 files one time`（不是网络问题、不是权限问题）。
本脚本默认 `--probe-chunk 50`，传更大的值会被夹到 50 并打 `[warn]`。
（同目录 `transcode.mjs` 在派单方全量跑时撞到同一上限并已修复 —— 见上方读数 4/5。）

### 对账三读数（每次真跑必打）＋ 回读抽样

```
[读数1] 磁盘 TIFF 总数 = …（内容寻址可用 sha = …，非法文件名 = …，重复 sha = …）
[读数2] 成功处理唯一 sha 数 = …（ok=… skipped=…；conflict=… failed=… badfile=… none=…，本批候选 …）
[读数3] 对象存在数 = … / 磁盘 … 键（全量探测 code 分布={…}）
[对象核对] 本批候选 N 键（终读探测 + 本地 stat）：exists 同字节=…（skipped） 新上传=… conflict=… 缺失=…
```

- 读数3 = 对磁盘**全部**键跑一遍 `getFileInfo`（`--limit` 也全量探，读数才可跨 run 比）。
- 回读：从「桶内已存在」的原图对象里均匀抽 **12 张**（不足 12 按可用数），下载后断言
  ① 对象字节数 == 本地字节数；② 回读字节**现算 sha256 == 键里的 sha**；③ 与进度记录字节数一致。
  有 FAIL ⇒ 退出码 1。
- 全量探测失败 ⇒ 读数3 / 对象核对 / 回读全部不可用，**本 run 判失败（退出码 1）**，不静默降级。

退出码：`0` 全部成功；`1` 有 `failed` / `badfile` / 回读 FAIL / 全量探测失败；`2` 有 `conflict`（同键不同字节，未覆盖）。

### 已跑小量读数（2026-11-09，本机实跑；全量 6,357 张由派单方另跑）

1. `--limit 5 --dry-run`：自证哈希 5/5 全 `sha_ok=true`（bytes 1,228,682 / 141,254 / 138,048 / 59,246 / 44,906）；
   `读数1 = 6357`、`读数2 = 5（仅自证哈希，未上传未落进度）`、`读数3 = 未探测`；退出码 0。
2. `--limit 5`（真跑）：对象级 `新上传=5 已存在同字节=0 conflict=0 failed=0 badfile=0`；
   `[probe] 全量探测 6357 个对象键 32.2s，code 分布={"SUCCESS":5,"STORAGE_FILE_NONEXIST":6352}`；
   `读数2 = 5（ok=5）`、`读数3 = 5 / 6357`；`[对象核对] exists 同字节=5 新上传=5 缺失=0`；
   回读 `5/5 PASS`（桶内当时只有 5 个原图对象 ⇒ 按可用数抽 5）；退出码 0。
   **脚本外独立复核**（一次性探针，不走本脚本）：2 个键 `remote size == local size` 且 `本地 sha256 == 键内 sha` 全真 ——
   `xiai/images/00/0009ba05cde81312f6c1e1c53e9acdc82f30dccadb919606f22d1f45c869698f.tiff = 1,228,682 B`、
   `xiai/images/00/0017ec6837ddbf1de02c5908b2f31445d3d541e6a259234328d4745447fd3bdc.tiff = 44,906 B`。
3. `--limit 5` 复跑（幂等）：`[plan] 续跑跳过=5 待处理=0`、`[本 run 处理明细] 幂等跳过=5 新处理=0`、
   `自证哈希成功=0`、对象级 `新上传=0`；`[对象核对] exists 同字节=5（skipped） 新上传=0 缺失=0`；
   `读数3 = 5 / 6357`（同上 code 分布）；回读 `5/5 PASS`；退出码 0。
4. **badfile 负对照**（在 `$TMPDIR` 造一个「文件名 sha ≠ 内容 sha256」的 TIFF，`--originals` 指过去）：
   dry-run 判 `badfile` 并列出 `actual=`、退出码 1、不写进度；
   真跑（进度走隔离文件）落 `status:"badfile"` 记录（含 `actual` / `error`）、`新上传=0`、退出码 1。
5. `--limit 5 --batch 2 --progress $TMPDIR/…`（**多批循环**验证，隔离进度、零新增上传）：
   `[batch 1/3] [batch 2/3] [batch 3/3]` 三批全跑通；5 个对象已存在且同字节 ⇒
   `新上传=0 已存在同字节=5`、`读数2 = 5（ok=0 skipped=5）`、`读数3 = 5 / 6357`、回读 `5/5 PASS`、退出码 0；
   仓库内 `progress-originals.jsonl` 未被触碰（仍是真跑留下的 5 行 `ok`）。

**坑（实测）**：`getFileInfo` / `getTempFileURL` 单次 `fileList` 上限 **50**，超了报 `INVALID_PARAM`；
首次真跑按 100 分批 ⇒ 读数3 探测失败，脚本已改为默认 50 ＋ 超参夹取 ＋ 探测失败即判退出码 1（不再静默降级）。


