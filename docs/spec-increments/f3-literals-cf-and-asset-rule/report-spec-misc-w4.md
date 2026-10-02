# 增量包报告 · `f3-literals-cf-and-asset-rule`（v1.39 `W-53` 回填 ＋ 已部署云函数登记 ＋ 静态资产位置硬规则包）

**包目录**：`xiai/docs/spec-increments/f3-literals-cf-and-asset-rule/`
**交付件**：`patch.diff`（**11 hunk｜`diff -u` 逐行计数 ＋132 行内容 / −0 行内容（纯追行：不删行、不替换任何既有行；`wc -l` 5,779 → 5,911 ＝ ＋132 ✓）**；**`patch.diff` 大小 ＝ 123,105 B；md5（算法 ＝ `md5`）＝ `23f5c545cbf46efe7c79c6097e617c1e`；sha256 ＝ `d2079ffa8c1e1f969ff531adad786027f0de1cb21df519c029e528800cfdc593`**）＋ 本报告（`report-spec-misc-w4.md`）
**落点对象**：`docs/xiai.spec.md`（**唯一被改文件**）
**本包性质**：**只写文档**。**不跑构建 / 不跑测试 / 不起服务 / 不占端口 / 不联网 / 不对任何仓做 git 写操作 / 不 push / 不执行需审批命令 / 禁 `pkill -f` 与 `killall`**；**不改仓库主规范现态**（**交付前后各测一次，md5 逐字一致 ＝ `5b8761c5663dd7dbf270399ee8a9a1b2`✓**）；**不改任何既有增量包本体**；**`git apply` 的实应用验一律在 scratch 副本内进行**（**仓库主规范零写入**；正向 `--check` 亦为只读）。

---

## 0. 基线（逐字；开工即现取）

| 项 | 值 |
| --- | --- |
| **开工时现取**（第一动作，只读） | **`md5 -q docs/xiai.spec.md` ＝ `5b8761c5663dd7dbf270399ee8a9a1b2`**（算法 ＝ `md5`）／**`wc -l` ＝ 5,779 行**／**`wc -c` ＝ 2,691,779 B** —— **＝ 派单件预计值（v1.38）逐字一致 ✓**（**无「开工后基线变更」**） |
| **应用基线（本包实际基线）** | **v1.38（管理员写面与「下載高清原圖」语义裁定入账单）＝ 现态** —— 同上三读数（本包开工就地只读实测） |
| **应用后终态** | **5,911 行（`wc -l`）/ 2,736,319 B（`wc -c`）**，`md5` **`10de43256cd22853942b658aa9502af3`**（**scratch 副本内实应用所得，非仓库现态**） |
| **行数增减** | **＋132 行**（**5,779 → 5,911**；**与 `wc -l` 同口径**）；**删除 0 行、替换 0 行** |
| **应用链** | `v1.34 → 第五包（v1.35）→ 第一续包 → 第二续包 → v1.36（第六包）→ v1.36 续包 → v1.36 写面与小口径结案包 → v1.37（改名包）→ v1.38（写面与 F3 语义裁定包）→ 本包` |
| **负对照基线 ①（＝ 紧邻上一态）** | **`aeaaa9ccaa10c4e2d3514346698a5664` ＝ v1.37（改名包）态**（**非独立 bak 文件**；**由 scratch 副本内对 `writeface-originalface-rulings-w3/patch.diff` 做 `git apply -R` 逆应用重建**，**重建后 md5 逐字一致 ✓**） |
| **负对照基线 ②** | `docs/xiai.spec.md.bak-pre-v137` ＝ **`bd73f0bd541decf86edf28767eb31ee4`**（本包就地复算一致） |
| **负对照基线 ③** | `docs/xiai.spec.md.bak-pre-w2` ＝ **`a8d8d83653618aeabb40478d3709b7f6`**（本包就地复算一致） |
| **仓库现态校验（交付后）** | **`5b8761c5663dd7dbf270399ee8a9a1b2` 一字未动 ✓**（本包对仓库主规范**只读**；**只新增本包目录一处**） |

**锚点逐处（本包 13 处插入点，逐行给现状行号 —— 现取、非估计）**：

| # | 模式 | 基线行号 | 锚点（逐字前缀） | 插入块 |
| --- | --- | --- | --- | --- |
| 1 | before | 7 | `**v1.38**（2026-09-30｜Jing｜` | 表头版本摘要行（v1.39） |
| 2 | before | 44 | `\| 最近修订 \| **v1.38｜2026-09-30｜修订人 Jing**｜` | 「最近修订」行（v1.39） |
| 3 | before | 200 | `\| 依据（**v1.38 追加**） \|` | 依据 / 被引用输入与时点 / 本次登记的基准版本（v1.39 追加，共 3 行） |
| 4 | after | 293 | `- **追溯码（v1.38 追加｜上句原文逐字保留、未改）**：` | §1.4 追溯码（v1.39 追加） |
| 5 | after | 3,373 | `- **★ 新字面值待回填（明文）**：` | §3.38.6 追加回填注（`W-53` 回填主体） |
| 6 | before | 3,413 | `## 4. 数据模型（canonical 归属：` | **新 §3.39**（云函数登记）＋ **新 §3.40**（静态资产规则） |
| 7 | before | 5,233 | `## 11. 待裁项清单（W-1 ～ W-7）` | **新 §10.38**（AC-355 〜 AC-372，共 18 条）＋ 计数留痕 ＋ 表下注 |
| 8 | after | 5,320 | `\| **W-53**（**v1.38 新增**｜` | §11 `W-53` 行追加结案注 |
| 9 | after | 5,323 | `\| **W-55**（**v1.38 新增**｜` | §11 新行 `W-56` / `W-57` |
| 10 | after | 5,371 | `**（v1.38 更新｜留痕）**：**`W-50` 部分结案` | §11 计数留痕（v1.39） |
| 11 | after | 5,840 | `\| **v1.38** \| 2026-09-30 \|` | §12 本版行（v1.39） |
| 12 | after | 5,846 | `**规范结束（xiai.spec.md v1.38｜` | 页脚版本横幅（v1.39）＋ 页脚留痕（v1.39 追加） |
| 13 | after | 4,105 | `**（v1.38 更新｜留痕）**：**新增 AC-339` | §10.7 AC 总条数留痕（v1.39） |

**⇒ 锚点唯一性**：**13 处锚点在基线态**各命中恰 1 行**（构建器内 `len(idxs) == 1` 硬断言，不唯一即整包不入盘）✓**。

---

## 1. `git apply` 正负对照（逐字输出）

### 1.1 正向（对现态 `5b8761c5…`）

```
$ cd /Users/kevin/.hermes/profiles/zang/cache/scratch/jing_w4
$ diff -u --label a/docs/xiai.spec.md --label b/docs/xiai.spec.md old.md new.md > patch.diff
PATCH bytes=123105 hunks=11 add=132 del=0 md5=23f5c545cbf46efe7c79c6097e617c1e

$ cp -p old.md t_pos/docs/xiai.spec.md          # 内容 ＝ 现态 docs/xiai.spec.md（仓库零写入）
$ md5 -q t_pos/docs/xiai.spec.md
5b8761c5663dd7dbf270399ee8a9a1b2
$ git apply --check /…/jing_w4/patch.diff       # cwd = t_pos
POS --check exit=0                              # ✓ 通过（无输出）
$ git apply /…/jing_w4/patch.diff               # cwd = t_pos
POS apply  exit=0                               # ✓ 实应用成功
$ md5 -q t_pos/docs/xiai.spec.md
10de43256cd22853942b658aa9502af3                # ＝ §0 的终态 md5 ✓（＝ new.md 的 md5）
$ wc -l t_pos/docs/xiai.spec.md ; wc -c t_pos/docs/xiai.spec.md
    5911 t_pos/docs/xiai.spec.md
 2736319 t_pos/docs/xiai.spec.md
```

### 1.2 负对照 ①（对紧邻上一态 `aeaaa9cc…` ＝ v1.37）⇒ 必失败 ✗

```
$ cp -p old.md t_negA/docs/xiai.spec.md
$ git apply -R /Users/kevin/bistro/xiai/docs/spec-increments/writeface-originalface-rulings-w3/patch.diff   # cwd = t_negA
NEG-A reverse exit=0                            # 逆应用 v1.38 包 => 重建上一态（无输出 ＝ 成功）
$ md5 -q t_negA/docs/xiai.spec.md
aeaaa9ccaa10c4e2d3514346698a5664                # ✓ 与预期逐字一致（v1.37）
$ git apply --check /…/jing_w4/patch.diff       # cwd = t_negA
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-A --check exit=1                            # ✓ 如期失败
```

### 1.3 负对照 ②（对 `bd73f0bd…`）⇒ 必失败 ✗

```
$ cp -p /Users/kevin/bistro/xiai/docs/xiai.spec.md.bak-pre-v137 t_negB/docs/xiai.spec.md
$ md5 -q t_negB/docs/xiai.spec.md
bd73f0bd541decf86edf28767eb31ee4
$ git apply --check /…/jing_w4/patch.diff       # cwd = t_negB
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-B --check exit=1                            # ✓ 如期失败
```

### 1.4 负对照 ③（对 `a8d8d836…`）⇒ 必失败 ✗

```
$ cp -p /Users/kevin/bistro/xiai/docs/xiai.spec.md.bak-pre-w2 t_negC/docs/xiai.spec.md
$ md5 -q t_negC/docs/xiai.spec.md
a8d8d83653618aeabb40478d3709b7f6
$ git apply --check /…/jing_w4/patch.diff       # cwd = t_negC
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-C --check exit=1                            # ✓ 如期失败
```

**⇒ 结论**：**正向对现态 `--check` ＝ 0 ✓、实应用成功 ✓（终态 md5 与 new.md 逐字一致）；三个负对照一律失败 ✗（含紧邻上一态 v1.37）**。**所有实应用验在 scratch 副本内完成 —— 仓库主规范零写入 ✓**。

---

## 2. 三条逐条落位（照登不改写）

| # | 条目（逐字要点） | 新增小节 / 回填注 | 追加注（旧行原文一字未改） | 判据 |
| --- | --- | --- | --- | --- |
| 1 | **`W-53` 回填（F3 新字面值）**：**`verdict:'display_only'`（唯一新值、未新增任何 `reason`）**＋**字段 `original` / `source`（`'cloud_display'` / `'stored'`）/ `displayOnly`**＋**档名前缀 `xiai-display-<sha12>`**＋**上屏文案逐字（繁體）**；**有真原图时仍逐字不变（`verdict:'match'` ＋ `via:'api'`）✓** | **§3.38.6 追加回填注**（主体） | **§10.37 ／ §3.38.6 既有各行原文一字未改**；**§11 `W-53` 行追加结案注** | **AC-368 ／ AC-369 ／ AC-370 ／ AC-371 ／ AC-372** |
| 2 | **已部署云函数 `xiai-admin-token`**：**环境 `liwu-d8gek6jjdab1d087c` ／ 函数 id `lam-lda5f0ud` ／ 运行时 `Nodejs18.15` ／ 列表 3 → 4（liwu 原有三个时间戳未变）**＋**TTL `900 s` ／ 滑动续期 ／ 负向四条一律结构化 `FORBIDDEN`（签名错与无令牌同文案）／ 零写入双证 ／ 令牌只存内存 · 密钥只在环境变量（仓内零字面值）** | **新 §3.39（含 §3.39.1 〜 §3.39.6）** | **§3.38.2 / §3.33.5 追加修订注（v1.36 / v1.38）原文一字未改**（**本包只登记事实、不动 `W-50` 余面**） | **AC-361 〜 AC-367** |
| 3 | **静态资产必须置 `public/assets/**`**：**机制 ＝ 部署根 `vercel.json` 兜底排除式恰豁免 `assets/` ｜ `yinyuan/` ｜ `xiai/` 三处**＋**实测反例（`public/` 根下被吞成 `text/html` ✗）与正例（`200` ＋ `image/svg+xml` ＋ 正确字节数 ✓）**＋**logo 登记（`public/assets/xiai-logo.svg`；640×400；md5 `199e507f5430b45d4e2cbaa6c98abfca`）** | **新 §3.40（含 §3.40.1 〜 §3.40.7）** | —（**新增义务面，无被改读旧行**） | **AC-355 〜 AC-360** |

**★ 三条「必须逐字写明」的核对（本包已落）**：
**① 「唯一新值 ＋ 未新增任何 `reason`」两件在 §3.38.6 追加回填注与 AC-368 并列写出（缺一即判「读法不齐」）✓**；
**② 「有真原图时逐字不变」在 §3.38.6 追加回填注 ＋ AC-371 逐字在册 ✓**；
**③ 反例与机制（`public/` 根被兜底吞 ＋ 排除式恰三处）在 §3.40.2 / §3.40.3 ＋ AC-356 / AC-357 逐字在册 ✓**。

**另落位**：**§10.38 表下注（v1.39）／ §10.7 计数留痕（v1.39）／ §11 计数留痕（v1.39）／ §1.4 追溯码（v1.39 追加）／ 表头四处（版本摘要行 ＋「最近修订」＋ 依据 · 被引用输入与时点 · 本次登记的基准版本）／ §12 本版行 ／ 页脚版本横幅 ＋ 页脚留痕（v1.39 追加）**。

---

## 3. 新增 AC / W 编号与计数（**逐处现取**）

| 项 | 现取读数 | 落位 |
| --- | --- | --- |
| **基线时最大 AC 号** | **`AC-354`**（现态已有 `AC-339` ～ `AC-354`，系 v1.38 落位） | — |
| **本包新增 AC** | **`AC-355` ～ `AC-372`（共 18 条，连续编号、无跳号、无复用）** | **新 `§10.38`** |
| **§10 总条数** | **354 → 372**（**终态实测：AC 表行 385 行 ／ 唯一编号 371 个 ／ 最大号 `AC-372`** —— **表行数 ＞ 唯一编号数系册内既有形态（既有重复编号 / 无独立表行的编号），非本包引入；本包 18 条编号两两不同 ✓**） | §10.7 v1.39 留痕 ＋ §10.38 计数留痕 |
| **基线时最大 W 号** | **`W-55`**（v1.38 新开） | — |
| **本包新增 W** | **`W-56` ／ `W-57`（共 2 行，均待裁；**自 `W-56` 起**，与派单件一致）** | **§11 表内** |
| **本包结案 W** | **`W-53`（**仅字面值面** —— 该行原待裁问题恰为字面值面）** | §11 `W-53` 行追加结案注 |
| **§11 表内行数** | **53 → 55 行**（**终态实测：表内 `W-` 行 55 行、唯一编号 55 个、最大号 `W-57` ✓**） | §11 计数留痕（v1.39） |
| **有效待裁项** | **39 → 40 行**（**`W-53` 结案 ⇒ −1；`W-56` / `W-57` 新开 ⇒ ＋2；`W-50` 仍计入（余三面未裁）**） | 同上 |
| **本包新增数值 / 字面值** | **新增机器字面值恰一处族 ＝ `verdict` 取值 `display_only`（照登不改写）；`reason` 面零新增 ✓；其余数字（`900 s` / `219` 字符 / `640×400` / `79 / 0 / 0` / `117,573 B` / `md5`）一律为**照登的实测读数或既有冻结值**，非本版新立阈值** | §3.38.6 ／ §3.39 ／ §3.40 |

---

## 4. 主规范零改动证明（前后各一次）

```
# 改动前（本包第一动作，只读）
$ md5 -q /Users/kevin/bistro/xiai/docs/xiai.spec.md
5b8761c5663dd7dbf270399ee8a9a1b2
$ wc -l /Users/kevin/bistro/xiai/docs/xiai.spec.md
    5779

# 落包后（交付前，只读）
$ md5 -q /Users/kevin/bistro/xiai/docs/xiai.spec.md
5b8761c5663dd7dbf270399ee8a9a1b2        # ✓ 一字未动
$ wc -l /Users/kevin/bistro/xiai/docs/xiai.spec.md
    5779
```

**⇒ 两读数逐字一致 ✓**：**本包对仓库主规范只读；本包在仓内**只新增** `docs/spec-increments/f3-literals-cf-and-asset-rule/` 一处（`patch.diff` ＋ 本报告），不改任何既有文件、不改任何既有增量包本体**。

---

## 5. 本包就地只读复核读数（四条；只作来源标注，非验收结论）

**（a）静态资产落位面**（现取；只读）

```
$ find public -type f ; ls -la public ; ls -la public/assets
public/assets/xiai-logo.svg
public:  drwxr-xr-x 3 … assets        # 仅一个目录、根下无文件 ✓
public/assets:  -rw-r--r-- 117573 xiai-logo.svg
$ md5 -q public/assets/xiai-logo.svg
199e507f5430b45d4e2cbaa6c98abfca        # ✓ 与派单件转述值逐字一致
```

**（b）部署根 `vercel.json` 兜底排除式**（现取；只读）

```
$ find /Users/kevin/bistro -maxdepth 4 -name vercel.json -not -path "*/node_modules/*"
/Users/kevin/bistro/cat/vercel.json
/Users/kevin/bistro/xiai/yinyuan/vercel.json        # 子站旧配：兜底条逐字 "/((?!assets/).*)"（仅豁免 assets/）
/Users/kevin/bistro/tokency/vercel.json …（其它不相关项目）

$ grep -n "source" /Users/kevin/repos/qa-xiai-cb/vercel.json | tail -4      # 部署根配（同形态为多个克隆）
59: "source": "/((?!assets/|yinyuan/|xiai/).*)"
72: "source": "/((?!assets/|yinyuan/|xiai/).*)"
```

**⇒ 复核结论**：**部署根配的兜底条逐字含排除式 `assets/` ｜ `yinyuan/` ｜ `xiai/` 恰三处 ✓**（**与派单件转述一致**）；**玺爱工作副本 `/Users/kevin/bistro/xiai` 内**无根 `vercel.json`****（**只有 `yinyuan/vercel.json` 子站旧配，其兜底条仅豁免 `assets/`**）—— **该差异如实登记：本册 §3.40.2 的规则针对**部署根配**，其真源不在玺爱工作副本内**（**若日后需把该真源也纳入册内指向，由派单方另开一单**）。

**（c）云函数在盘面**（现取；只读）

```
$ find cloudfunctions -maxdepth 3
cloudfunctions/xiai-admin-token/{index.js,package.json,README.md,lib/config.js,lib/token.js}
$ wc -l cloudfunctions/xiai-admin-token/index.js cloudfunctions/xiai-admin-token/lib/*.js
     272 index.js / 129 lib/config.js / 152 lib/token.js     # 合计 553 行
$ grep -n "process\.env\|createHash\|createHmac" …             # 仅 crypto 运算 ＋ process.env 读取；无数据库 / 集合 / 文件写入调用
$ cat cloudfunctions/xiai-admin-token/package.json            # "engines": { "node": ">=18" } ; "dependencies": {}
```

**（d）本包自身交付件**（现取）

```
$ wc -l …/f3-literals-cf-and-asset-rule/patch.diff
     218 …/patch.diff        # 123,105 B；md5 23f5c545cbf46efe7c79c6097e617c1e
```

---

## 6. 未登记项与待裁登记（本包不代裁）

- **① 静态资产的缓存与失效策略**（**`Cache-Control` 取值 / 是否内容指纹命名 / 发布后旧资产清理**）—— **本版未测、未登记** ⇒ **新开 `W-56`**（**待裁**）。
- **② 静态资产位置规则的护栏形态**（**是否在构建 / CI 增一条「`public/` 根下只允许目录白名单」检查**）—— **本版只冻规则、不冻护栏** ⇒ **新开 `W-57`**（**待裁**）。
- **③ `W-50` 的存储位置 / 撤销 / 时钟偏移三面** —— **本包只对「存储位置」面作**实测形态登记**（＝ 云函数内存），**不判结案**；三面仍留 `W-50`**（**不重复开行**）。
- **④ 令牌的具体编码形态（段数 / 声明字段名）** —— 属实现侧自由（**本册只登记短期 HMAC 令牌一族形态与 TTL**），**不另立条款、不登记 W 行**。
- **⑤ `xiai-logo.svg` 的图形内容 / 配色** —— 属实现侧自由（**本册只登记路径 / 尺寸 / 摘要**），**不另立条款、不登记 W 行**。
- **⑥ 既有 `public/` 根下文件是否需迁入 `assets/`** —— **本包就地只读实测根下**无文件** ⇒ **无待迁存量**，**不另立条款、不登记 W 行**（**若日后清点出存量，由派单方另开一单**）。
- **⑦ 部署根 `vercel.json` 真源的册内指向** —— **本包只登记「排除式恰三处」的机制与实测反例**；**该文件的册内真源落点未新立** ⇒ **若需纳册，由派单方另开一单**。
- **明文**：**`W-56` / `W-57` 未裁前，不得据任一方向判负**；**亦不得据本版把任一形态判通过**（`AC-359`）；**`W-50` 余三面同此**（`AC-367`）。

---

## 7. 纪律自查（逐条）

| 纪律 | 自查 |
| --- | --- |
| **只改 `docs/**`（只新增本包）** | ✓ **仓内唯一新增 ＝ `docs/spec-increments/f3-literals-cf-and-asset-rule/`**；**主规范只读**（前后 md5 一致） |
| **不得改主规范现态** | ✓ **`5b8761c5663dd7dbf270399ee8a9a1b2` 一字未动**（前后各测一次） |
| **不得改既有各包本体** | ✓ **`writeface-originalface-rulings-w3/patch.diff` 只作负对照**逆应用**用（读取 + 应用于 scratch 副本），本体零写入** |
| **不跑构建 / 测试、不起服务、不占端口、不联网** | ✓ **未跑 `npm` / `vite` / 任何测试；未起服务；未联网** |
| **不对任何仓 git 写、不 push** | ✓ **未执行 `git add` / `commit` / `push`**；**`git apply` 只在 scratch 副本内执行**（**仓库内无 `.git`，`git apply` 为独立补丁工具，不涉仓内写**） |
| **不碰实现侧工作区** | ✓ **未改 `src/**`、`public/**`、`cloudfunctions/**`、`vercel.json` 任何字节**（**只读复核**） |
| **不执行需审批命令；禁 `pkill -f` / `killall`** | ✓ **未执行** |
| **预算（≤ 25 次工具调用）** | ✓ **本包先落盘 patch ＋ 报告，未做多余往返** |

**⇒ 本包不含任何「已落地 / 已通过 / 已验收」结论**；**落地归 Kong、验收归 Neng**。**时点戳 ＝ 2026-09-30（CST）**。
