# 编号重编执行留痕（V3 · 2026-10-27）

> 性质：**执行证据**（派单方 Zang 执行）。口径真源 ＝ `docs/seal-face-code-plan-2026-10-27.md` @ `85aa695`（R-5 / R-6 / R-7）。
> 人类授权：「直接修改」（**不经 dry_run 人工复核，直接执行**）。**本件只含计数与 md5，不含任何生产行数据或映射表**（映射表与备份留在 `$HERMES_HOME/profiles/zang/cache/scratch/xiai-code-migration/`）。

## 1. 执行前状态（只读取证，时点 2026-10-27 CST）

| 集合 | 行数 | 旧 `stamp_id` 形态 |
| --- | --- | --- |
| `xiai_seals` | 79 | 纯数字 `"1"`…`"79"`（**无 `XA` 前缀**） |
| `xiai_faces` | 79 | `sealId`/`stamp_id` ＝ `"1"`…；`_id` ＝ `fc-fx1-FACE…`；**全为 `kind=FACE`** |
| `xiai_images` | 80 | 79 行带 `stamp_id` ＋ 1 行公共占位图（`img-placeholder-seal-no-image`，无 `stamp_id`） |
| `xiai_corrections` | 36 | `sealId`/`stamp_id` ＝ `"1"`… |
| `xiai_corrections_public` | 6 | `sealId`/`stamp_id` ＝ `"14"` 等 |
| 引用面（`seallist_items` / `shares` / `photos` / `downloaded` / `points` / `seal_links` / `person_relations`） | **全 0 行** | 云侧无引用需迁 |

## 2. 备份（执行前全文快照）

| 文件 | 行数 | md5 |
| --- | --- | --- |
| `backup-xiai_seals.json` | 79 | `479ce130e79a05ef729757b69ce90363` |
| `backup-xiai_faces.json` | 79 | `21dfbecbbc93f4eaa7b8d949bc8fa93e` |
| `backup-xiai_images.json` | 80 | `e45c5bcf45287575bcdf0d77649c8fb1` |
| `backup-xiai_corrections.json` | 36 | `9c627a2749c6abb8969905f943509f25` |
| `backup-xiai_corrections_public.json` | 6 | `395f657ff2ab65fad061f5798b21ab98` |

回滚计划（`rollback-plan.json`）＝ 逐行 `_id` 反向 `$set`（新值 ← 旧值），**未执行**。

## 3. 发号规则（确定性，无映射表也可复算）

`旧号 N`（`"N"` 或 `XA0000000N`）→ `seal_no = N` → `sid = encodeSealCode(N)`；印章按旧号升序 1…79；印面按「所属印章号 ＋ 同类序号」升序 1…79。
样值：`xf-1 → 1 → AAAAB`，`xf-79 → 79 → AAADQ`；`fc-fx1-FACE → face_no 1 → fid 00000001`。

## 4. 写入回包（`db nosql execute` UPDATE ＋ `$set`）

| 命令 | `n` | `nModified` |
| --- | --- | --- |
| `xiai_seals`（`stamp_id`=`sid`、`seal_no`、`sid`） | 79 | **79** |
| `xiai_faces`（`stamp_id`/`sealId`=`sid`、`face_no`、`fid`） | 79 | **79** |
| `xiai_images`（`stamp_id`=`sid`；**占位图跳过**） | 79 | **79** |
| `xiai_corrections`（`sealId`/`stamp_id`） | 36 | **36** |
| `xiai_corrections_public`（`sealId` ＋ `stamp_id` **两键同改**） | 6 | **6** |
| `xiai_counters`（`seal` / `face`，`seq=79`，upsert） | 1 / 1 | 0 / 0（新建） |

## 5. 回读验证（写后独立取数）

| 判据 | 读数 | 结论 |
| --- | --- | --- |
| `seals` 行数 / 旧数字 `stamp_id` 命中 / 新 sid 命中 | 79 / **0** / 79 | ✅ |
| `faces` 行数 / 旧数字命中 / `fid` 8 位命中 | 79 / **0** / 79 | ✅ |
| `images` 行数 / 旧数字命中 / 新 sid 命中 | 80 / **0** / 79 | ✅（占位图除外） |
| `corrections` 行数 / 旧数字命中 / 新 sid 命中 | 36 / **0** / 36 | ✅ |
| `corrections_public` 行数 / 旧数字命中 / 新 sid 命中 | 6 / **0** / 6 | ✅ |
| `seal_no` 连续且无空洞 | `1…79` | ✅ |
| 勘误 join 无孤儿（`sealId ∈ seals.stamp_id`） | 孤儿 **0** | ✅ |
| `sid` 两两唯一 | 唯一 79 / 79 | ✅ |
| 计数器 | `seal=79`、`face=79` | ✅ |

## 6. 已知中间态（**须尽快收口**）

- **云函数尚未部署**：线上仍是旧代码 ⇒ 其 `nextSealStampIdOf` / `nextSealStampId` 仍会发 `XA`+9 位。此窗口内若新建印章，会产出一枚 `XA…` 行，**再跑重编会与 `seal_no=1` 撞号** ⇒ 部署前**不得新建印章**，部署后须复核行数仍为 79（或按 §3 规则补编）。
- **前端尚未推送**：线上站点的数据面已是 sid（`/seal/AAAAB` 可用、`/seal/1` 走「找不到」），但 OTP 识别编码搜索入口要等前端上线。
