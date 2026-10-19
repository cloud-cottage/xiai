# sealbank 试水批 100 条 · 批量提交脚本与生产读回（占位图形态）

- 日期：2026-10-19（CST）
- 执行单：四角色「Kong」（实现）；父单：feicui/sealbank ⇒ xiai 印章试水导入
- 产物：`scripts/submit-sealbank-batch.mjs`（本仓）＋ `scripts/out/submit_batch_report.json` / `submit_batch_ids.json` / `submit_batch_report.dry-run.json`
- 生产环境：`liwu-d8gek6jjdab1d087c`（凭据统一文件 `~/.config/bistro/cloudbase-liwu.env`，**值不入库不入日志**）

## 1. `submitSealImport` 的身份要求（代码证据）

**结论：op 函数体不验令牌；它只要求「服务端派生形态的身份对象」`{uid, phone}`（令牌路）。**

| 环节 | 证据（文件:行） | 内容 |
| --- | --- | --- |
| op 函数体签名 | `cloudfunctions/xiai-user-token/lib/ops.js:2156` | `async submitSealImport(payload, identity)`；身份注释「**服务端派生**的身份」 |
| 函数体内唯一身份判定 | `ops.js:2194-2196` → `lib/sessionAuthority.js:380-382` | `identityUsable(identity)` ＝ `!!(identity && identity.uid && (identity.phone \|\| identity.identity_source==='SESSION'))` —— **uid 必有；令牌路 phone 必有；会话路凭 `identity_source:'SESSION'` 免 phone** |
| 令牌验签在函数体外 | `cloudfunctions/xiai-user-token/index.js:202-227` | `action:'verify'` 先 `verifyToken`，再**服务端派生** `identity = {uid: uidOf(phone), phone, role:'user', identity_source:'SERVER_TOKEN'}` |
| uid 派生算法 | `lib/config.js:11-14`（`uidOf`） | `uidOf(phone) ＝ 'u-' + sha256(phone).hex 前 16 位`（与前端 `src/data/uid.js` 同算法同值） |
| 落库侧 | `ops.js:2220` | `imported_by: identity.uid`（**零手机号**） |
| 会话路 | `index.js:193-200` ＋ `sessionAuthority.js:77-99` | 仅当 `XIAI_SESSION_AUTHORITY=prefer`（惰性缺省 off）才启用；本批未用 |
| admin 通道 | `ops.js` `ADMIN_OPS` vs `OPS` | `submitSealImport` ∈ **用户写面 `OPS`**（W-83 拟定口径「沿用既有用戶令牌通道」）；`reviewSealImport` 才属管理员面（本批一律未跑） |

**本机直跑函数体的注入参数**：`ops.setOpsDbProvider(() => <真实 node-sdk database>)` ＋
`OPS.submitSealImport(payload, identity)` ＋ `ops.persist(res.plan)`（op 只产出落盘计划，
`persist` 才落库 —— 与 `index.js:276-280` 同序）。

**身份零伪造的三道闸（脚本内置）**：

1. `phone` 取环境变量 `XIAI_OPERATOR_PHONE`（真实操作者账号）；`uid` 用**服务端自己的**
   `config.uidOf(phone)` 派生（`config.js` 是唯一算法定义点）。
2. **写前强制取证 ①（uid 回读）**：读生产 `xiai_person_imports` 全量 `imported_by` 值集 ——
   本次实测 `scanned=570, hits=570`（该 uid 恰是既有 570 行印人导入的唯一导入人 ⇒ 真实操作者）。
3. 兜底取证 ②（后台签发通道）：生产云函数 `action:'issue'`（演示码从 `src/services/auth.js`
   读出、**绝不打印**）；两条全不成立 ⇒ 脚本**中止、零写入**并报告缺口。

## 2. 脚本用法

```bash
# 凭据（值不进命令行、不进日志）
set -a; . ~/.config/bistro/cloudbase-liwu.env; set +a
export XIAI_OPERATOR_PHONE=<操作者手机号>

node scripts/submit-sealbank-batch.mjs --limit 5 --dry-run      # 只读＋假体截留写（零落盘）
node scripts/submit-sealbank-batch.mjs --limit 1                # 金丝雀（1 条真写）
node scripts/submit-sealbank-batch.mjs --limit 100 --offset 0   # 正式试水批
node scripts/submit-sealbank-batch.mjs --rollback \
  --ids scripts/out/submit_batch_ids.json --yes                 # 回滚（二次确认；只删仍 PENDING 的行）
```

- 输入：feicui 产出 `local-private/datasrc/sealbank/out/xiai_imports_sealbank_placeholder.ndjson`
  （5,529 行，占位图形态：`faces[0].image_storage_key='placeholder/seal-no-image'`、`image_status='present'`）。
- 抽样：`--stride auto` ＝ `floor(5529/100)=55`，取 `offset + i*55`（等距、覆盖全文件，**不取前 100 连续**）。
- 幂等：每条**提交前**按 `(source, source_seal_id)` 查生产（limit 1）；已存在 ⇒ `skipped`
  （op 体内还会再判一次，命中返回既有行不改写）；重跑不重复。
- 限速：相邻两条 ≥300ms（默认 400ms）。
- 逐条结果：`scripts/out/submit_batch_report.json`（`results[]` 含 `source_seal_id` / `result`
  (`ok|skipped|rejected|error`) / `reason` / `doc_id` / `business_id`）。
- 回滚清单：`scripts/out/submit_batch_ids.json`（成功写入的 `doc_id` ＋ 幂等键；金丝雀行标注
  `canary(--limit 1)`）。`--rollback` 逐条回读核验 `source` ＋ `source_seal_id` ＋ `status==='PENDING'`
  才删；**非 PENDING（已采纳/已驳回/缺失/不匹配）一律跳过不删**。
- `--dry-run`：读走真库（幂等预检照跑）、`add/set/remove` 被假体截留 —— **不绕提交门**，只是不落盘。

## 3. 执行读数（全部来自真实读回）

| 步骤 | 读数 |
| --- | --- |
| dry-run（limit 5） | 5/5 过提交门；写被截留（零落盘）；身份取证 `uid-readback 570/570` |
| 金丝雀（limit 1） | `1268-001` 写入成功；改后读回 `source='真微印網 sealbank.net'` 行数 **1** |
| 正式批（limit 100, stride 55） | `ok=99 / skipped=1 / rejected=0 / error=0`（skipped ＝ 金丝雀幂等命中） |
| 改后读回（count API） | sealbank 行数 **100**（＝ before 1 ＋ 本轮 99 新写） |
| 全量读回（docs 100 行） | `status` 分布 `{PENDING: 100}`；`image_status` 分布 `{present: 100}`；`imported_by` 去重 **1** 个（＝操作者 uid） |
| faces 指向 | `placeholder/seal-no-image` **100/100**；face `image_sha256` ＝ 登记值（`18d94039…`）**100/100** |
| 内容指纹 | `content_fingerprint` 逐行重算（`SEAL_IMPORT_FINGERPRINT_FIELDS` 规范化串 sha256）一致 **100/100** |
| 抽 3 条核验 | `1268-001`（宋元/吾丘衍/魯郡吾氏）、`1859-183`（晚清/吳熙載/仲陶手斠）、`1910-164`（晚清/趙石/沈成伯氏祕笈之印）：`status=PENDING`、`dynasty ∈ 15 类枚举`、`seal_wen`/`author` 齐备、faces 指向占位键且 sha ＝ 登记值、`raw_json` 在行、`content_fingerprint` 重算一致 |

占位图登记行（`xiai_images` `_id=img-placeholder-seal-no-image`，sha `18d94039…`）在本批**未被改动**：
提交门不解析影像存在性（既有语义），采纳门才回读 —— 本批零采纳。

## 4. 前端展示核验（尽力而为）

**代码路径（已核）**：

- 显示唯一入口 `src/services/seals.js::loadImageDataUrl`（:714）—— **占位分支** :718-732：
  `isSealPlaceholderImageRow(meta)` ⇒ `loadSealPlaceholderBytes()`（随包资产、零转码、`transcoded:false`）；
  零转码字节面 `loadStoredImage`（:784）同门（:790-803，面别 `displayOnly + source:'bundled_placeholder'`）。
- 判据真源 `src/services/sealPlaceholderAsset.js`：**只认登记键** `storage_key === 'placeholder/seal-no-image'`；
  字节数必须 ≡ 登记值，不符 ⇒ 结构化失败。
- 面上消费方：`SealCard.vue:95` / `ShareView.vue:64` / `MyDriveView.vue:73`；
  占位图画面 ＝ 米白宣纸底 ＋ 朱红印章边框 ＋ 竖排「**待补充**」（`src/data/seed.js:920`）。
- **导入队列（`MyCorrectionsView.vue`「待審導入批次」）不渲染影像**（该文件 `loadImageDataUrl` /
  `loadStoredImage` / `<img>` 零命中）—— 队列里占位 faces 行走**纯文本行**渲染，无需图像分支。

**运行时验证（本地 dev ＝ `127.0.0.1:5199`，`VITE_XIAI_CB_ENV_ID` ＋ `VITE_XIAI_LOCAL_IMPORT_FACE=1`；未动线上）**：

- 真浏览器（标题「璽印匯類 · 璽愛」）内 `import('/src/services/sealPlaceholderAsset.js')`：
  `isSealPlaceholderImageRow(占位行)=true`、普通内容寻址行 `=false`（例外只在登记键上）；
  `loadSealPlaceholderBytes()` ⇒ `ok=true, source='bundled', mime='image/jpeg', bytes=23357` ＝
  登记值；`fetch('/placeholders/seal-no-image.jpg')` ⇒ `200 image/jpeg`。
- dev 登录（演示码自动填）后「待審導入批次」区块照常渲染并从云端取行；**取行窗上限 1000 条**
  （`PULL_IMPORT_DEFAULT_LIMIT`/`PULL_IMPORT_MAX_LIMIT`，ops.js:2390-2393），首窗被既有
  `seal_20261010_01`（复旦线，≥1000 行）占满 ⇒ **本批 sealbank 行不在首窗可见**（`已取 1000 條（可能還有更多）`）。
  这是**取行窗覆盖**问题，不是写入失败 —— 生产行数以直读为准（100，见 §3）。

**线上人工核验步骤（采纳后；本批未采纳）**：

1. 管理员在「待審導入批次 → 印章導入」按批次 `sealbank_idx_1051_1911` 抽 1 条**采纳**
   （采纳是终态，请先用无价值行试）；
2. 打开该印章详情/印面卡：应显示**占位图**（米白宣纸底＋朱红边框＋竖排「待补充」）而非破图/空白；
   `loadImageDataUrl` 返回 `transcoded:false`、`meta.storage_key='placeholder/seal-no-image'`；
3. 对照：采纳一条 `source_no_image` 行（faces 空）⇒ 应走「无印面」文案而非占位图。

## 5. 红线遵守

- 只投 100 条（99 新写 ＋ 1 金丝雀）；**零采纳**（`reviewSealImport` 未跑）；既有数据未改写
  （幂等路径只回读）；限速 400ms/条；凭据/手机号/演示码/令牌零打印（报告内手机号仅掩码）；
- 所有行数/计数来自生产真实读回（count API ＋ docs 全量读回），非脚本内存；
- `xiai_images` 占位登记行、`xiai_person_imports`、`seal_20261010_01` 既有行均未触碰。
