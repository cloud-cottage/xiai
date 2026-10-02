# 增量包报告 · `writeface-pa-and-platform-gate`（v1.41｜写面 Phase A 与平台网关门（函数安全规则）实测登记包）

**包目录**：`xiai/docs/spec-increments/writeface-pa-and-platform-gate/`
**交付件**：`patch.diff`（**13 hunk｜`diff -u` 逐行计数 ＋126 行内容 / −0 行内容（纯追行：不删行、不替换任何既有行；`wc -l` 6005 → 6131 ＝ ＋126 ✓）**；**`patch.diff` 大小 ＝ 112075 B；md5（算法 ＝ `md5`）＝ `d6f2802aeabbc2a9be680808ef8e8789`；sha256 ＝ `353ca77259ecc6cd89a1fedc6b4504f9e5eef829b6c03f76562a309dc5022efd`**）＋ 本报告（`report-spec-misc-w5.md`）
**落点对象**：`docs/xiai.spec.md`（**唯一被改文件**）
**本包性质**：**只写文档**。**不跑构建 / 不跑测试 / 不起服务 / 不占端口 / 不联网 / 不对任何仓做 git 写操作 / 不 push / 不执行需审批命令 / 禁 `pkill -f` 与 `killall`**；**不改仓库主规范现态**（**交付前后各测一次，md5 逐字一致 ＝ `366b3afd94c46671b15773d26b313320`✓**）；**不改任何既有增量包本体**；**`git apply` 的实应用验一律在 scratch 副本内进行**（**仓库主规范零写入**；正向 `--check` 亦为只读）。

---

## 0. 基线（逐字；开工即现取）

| 项 | 值 |
| --- | --- |
| **开工时现取**（第一动作，只读） | **`md5 -q docs/xiai.spec.md` ＝ `366b3afd94c46671b15773d26b313320`**（算法 ＝ `md5`）／**`wc -l` ＝ 6005 行**／**`wc -c` ＝ 2769467 B** —— **＝ 派单件预计值（v1.40「或其后」）逐字一致 ✓**（**盘上现态 ＝ v1.40；无「开工后基线变更」**） |
| **应用基线（本包实际基线）** | **v1.40（写面 Phase 2 口径冻结单（P2-0）入账单）＝ 现态** —— 同上三读数（本包开工就地只读实测，时点 2026-10-01） |
| **应用后终态** | **6131 行（`wc -l`）/ 2818062 B（`wc -c`）**，`md5` **`34f0a38ad00ff0be28b9f246e82145c1`**（**scratch 副本内实应用所得，非仓库现态**） |
| **行数增减** | **＋126 行**（**6005 → 6131**；**与 `wc -l` 同口径**）；**删除 0 行、替换 0 行** |
| **应用链** | `v1.34 → … → v1.38（写面与 F3 语义裁定包）→ v1.39（F3 字面值与资产规则包）→ v1.40（写面 P2-0 口径冻结包）→ 本包` |
| **负对照基线 ①（＝ 紧邻上一态）** | **`10de43256cd22853942b658aa9502af3` ＝ v1.39 态**（**非独立 bak 文件**；**由 scratch 副本内对 `writeface-p2-0-freeze/patch.diff` 做 `git apply -R` 逆应用重建**，**重建后 md5 逐字一致 ✓**） |
| **负对照基线 ②** | `docs/xiai.spec.md.bak-pre-v139` ＝ **`5b8761c5663dd7dbf270399ee8a9a1b2`**（本包就地复算一致） |
| **负对照基线 ③** | `docs/xiai.spec.md.bak-pre-w2` ＝ **`a8d8d83653618aeabb40478d3709b7f6`**（本包就地复算一致） |
| **仓库现态校验（交付后）** | **`366b3afd94c46671b15773d26b313320` 一字未动 ✓**（本包对仓库主规范**只读**；**只新增本包目录一处**） |

**锚点逐处（本包 16 处插入块，逐行给现状行号 —— 现取、非估计）**：**全部 16 处锚点在基线态各命中恰 1 行**（**构建器内 `len(idxs) == 1` 硬断言，不唯一即整包不入盘 ✓**）；**锚点 ←→ 插入块对应表见下表**（**3 / 4 / 5 三块共用同一锚点（表头「依据 · 被引用输入与时点 · 本次登记的基准版本」三行）**）：

| # | 模式 | 基线行号 | 锚点（逐字前缀） |
| --- | --- | --- | --- |
| 1 | 插入于该行**之前** | 7 | `**v1.40**（2026-09-30｜Jing｜` |
| 2 | 插入于该行**之前** | 45 | `| 最近修订 | **v1.39｜2026-09-30｜修订人 Jing**｜` |
| 3 | 插入于该行**之前** | 201 | `| 依据（**v1.39 追加**） |` |
| 4 | 插入于该行**之前** | 201 | `| 依据（**v1.39 追加**） |` |
| 5 | 插入于该行**之前** | 201 | `| 依据（**v1.39 追加**） |` |
| 6 | 插入于该行**之后** | 295 | `- **追溯码（v1.39 追加｜上句原文逐字保留、未改）**：` |
| 7 | 插入于该行**之后** | 2821 | `- **⇒ 追加修订注（v1.40｜写面 P2-0 口径冻结｜` |
| 8 | 插入于该行**之前** | 3457 | `### 3.40 静态资产位置规则（**v1.39 追加**｜硬获经验）` |
| 9 | 插入于该行**之前** | 3504 | `### 3.41 写面 Phase 2 口径冻结（P2-0）（**v1.40 新增**｜` |
| 10 | 插入于该行**之前** | 3570 | `## 4. 数据模型（canonical 归属：**以玺爱为主**）` |
| 11 | 插入于该行**之后** | 4176 | `**（v1.40 更新｜留痕）**：**新增 AC-373 〜 AC-384` |
| 12 | 插入于该行**之后** | 5416 | `| **W-59**（**v1.40 新增**｜` |
| 13 | 插入于该行**之后** | 5417 | `**（v1.40 更新｜留痕）**：**结案 W 行 1 行（`W-36`）` |
| 14 | 插入于该行**之前** | 5351 | `## 11. 待裁项清单（W-1 ～ W-7）` |
| 15 | 插入于该行**之后** | 5934 | `| **v1.40** | 2026-09-30 |` |
| 16 | 插入于该行**之后** | 5941 | `**规范结束（xiai.spec.md v1.40｜2026-09-30｜Jing）**` |

---

## 1. `git apply` 正负对照（逐字输出）

```
$ diff -u --label a/docs/xiai.spec.md --label b/docs/xiai.spec.md old.md new.md > patch.diff
PATCH bytes=112075 hunks=13 add=126 del=0 md5=d6f2802aeabbc2a9be680808ef8e8789

$ cp -p old.md t_pos/docs/xiai.spec.md          # 内容 ＝ 现态 docs/xiai.spec.md（仓库零写入）
$ md5 -q t_pos/docs/xiai.spec.md
366b3afd94c46671b15773d26b313320
$ git apply --check /…/jing_w5/patch.diff        # cwd = t_pos
POS --check exit=0
$ git apply /…/jing_w5/patch.diff               # cwd = t_pos
POS apply  exit=0
$ md5 -q t_pos/docs/xiai.spec.md
34f0a38ad00ff0be28b9f246e82145c1                # ＝ 终态 md5
$ wc -l t_pos/docs/xiai.spec.md ; wc -c t_pos/docs/xiai.spec.md
6131 t_pos/docs/xiai.spec.md
 2818062 t_pos/docs/xiai.spec.md

### 负对照 ①（对紧邻上一态 v1.39 ⇒ 必失败 ✗）
$ cp -p old.md t_negA/docs/xiai.spec.md
$ git apply -R /Users/kevin/bistro/xiai/docs/spec-increments/writeface-p2-0-freeze/patch.diff   # cwd = t_negA
NEG-A reverse exit=0
$ md5 -q t_negA/docs/xiai.spec.md
10de43256cd22853942b658aa9502af3                # ✓ ＝ v1.39
$ git apply --check /…/jing_w5/patch.diff        # cwd = t_negA
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-A --check exit=1

### 负对照 ②（对 xiai.spec.md.bak-pre-v139 ⇒ 必失败 ✗）
$ cp -p /Users/kevin/bistro/xiai/docs/xiai.spec.md.bak-pre-v139 t_negB/docs/xiai.spec.md
$ md5 -q t_negB/docs/xiai.spec.md
5b8761c5663dd7dbf270399ee8a9a1b2
$ git apply --check /…/jing_w5/patch.diff        # cwd = t_negB
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-B --check exit=1

### 负对照 ③（对 xiai.spec.md.bak-pre-w2 ⇒ 必失败 ✗）
$ cp -p /Users/kevin/bistro/xiai/docs/xiai.spec.md.bak-pre-w2 t_negC/docs/xiai.spec.md
$ md5 -q t_negC/docs/xiai.spec.md
a8d8d83653618aeabb40478d3709b7f6
$ git apply --check /…/jing_w5/patch.diff        # cwd = t_negC
error: patch failed: docs/xiai.spec.md:4
error: docs/xiai.spec.md: patch does not apply
NEG-C --check exit=1
```

**⇒ 结论**：**正向对现态 `366b3afd94c46671b15773d26b313320` 的 `--check` ＝ 0 ✓、实应用成功 ✓（终态 md5 与终态读数逐字一致）；三个负对照一律失败 ✗（含紧邻上一态 v1.39）**。**所有实应用验在 scratch 副本内完成 —— 仓库主规范零写入 ✓**。

**★ 追加一条只读复核（就地、不改仓）**：**在仓库根直接跑一次 `--check`（只读、不写盘）** —— `$ cd /Users/kevin/bistro/xiai && git apply --check docs/spec-increments/writeface-pa-and-platform-gate/patch.diff` ⇒ **`REPO-ROOT --check exit=0`** ✓（**即：该补丁对**仓库现态**亦可通过校验；此复核不写盘，故仓库主规范仍为零写入**）。

---

## 2. 七组事实逐条落位（照登不改写）

| # | 条目（逐字要点） | 新增小节 / 追加修订注 | 追加注（旧行原文一字未改） | 判据 | 新开 W 行 |
| --- | --- | --- | --- | --- | --- |
| 1 | **函数安全规则（客户端 `callFunction` 的网关鉴权）**：改前 `{"*":{"invoke":"auth != null && auth.loginType != 'ANONYMOUS'"}}` ⇒ 匿名整体排除 ✗（`OPERATION_FAIL` / `[PERMISSION_DENIED]`、无 `{result}` 信封、`50–250 ms`）；改后只开两个令牌函数（`auth != null`）、其余原样 ✓、两次 `DescribeResourcePermission` 回读一致 ✓；**判别性反证**（不存在的函数名仍 `PERMISSION_DENIED`）✓；**「CLI 假象」**（CLI 走管理员凭证不受此规则约束）✗ | **§3.42.2 / §3.42.3** | — | **AC-385 / AC-386 / AC-387** | **W-61** |
| 2 | **新增云函数 `xiai-user-token`**（id `lam-q949cajz`，已部署；与 `xiai-admin-token` `lib/token.js` 逐字节相同 sha256 `68d10895…f9f6f9` ⇒ 同形态 / 同 TTL `900 s` / 同滑动续期 / 同「恰 3 键」失败形态；新增 `reason` 字面值 0；`uid = u-<手机号>` 服务端确定性派生；载荷带 `userId` / `role` ⇒ `INVALID_FIELD` ＋ 零写入 ✓） | **§3.42.4 ＋ §3.39 追加修订注（v1.41）** | **§3.39.1 〜 §3.39.6 原文一字未改**（**仅追加「列表自本包起 ＝ 5」**） | **AC-388 / AC-389 / AC-390 / AC-391** | — |
| 3 | **真浏览器实测读数**（origin `https://xiai2026.vercel.app`、SDK `2.31.0`、匿名登录 ✓）：admin issue `ok:true`（`181 ms` / `tokenLen 219` / TTL `900`）→ 携令牌 verify `ok:true`（`112 ms` / 滑动续期 ✓）；四条负向结构化、签名错与无令牌同文案 ✓；user-token issue `ok:true`（`149 ms` / `tokenLen 218`）✓；未知 op ⇒ `INVALID_FIELD` ✓；不存在的函数 ⇒ `PERMISSION_DENIED` ✓；**「过期令牌」负向**未跑** ⇒ 登记为待补 ✗** | **§3.42.5** | — | **AC-392 / AC-393 / AC-394 / AC-395** | **W-60** |
| 4 | **可观测性修复**（已上线 `cdf1421`）：`src/data/cloudbaseFn.js` 加诊断通道 `[xiai:cloud-fn]`（令牌 / 手机号 / 长串打码）；失败形状仍恰 3 键、未新增 `reason` 字面值 ✓；实测网关拒绝时仍 3 键且 `console.warn` 逃出平台原文 ✓ | **§3.42.6** | — | **AC-396** | — |
| 5 | **静态资产与 favicon 重裁**：页头用整张横版 `public/assets/xiai-logo.svg`（Kevin 亲选 ✓）；favicon 用方形派生 `public/assets/xiai-logo-mark.svg`（viewBox `-102.24 -18.26 437.64 437.64`；已上线 `4f56523`）；机械判据（红墨连通域恰 1 ✓ ／ 外来像素 `0.0000%` ✓ ／ 除 `viewBox` 外逐字节相同 ✓）；代价右留白 `0.78%`；**★ 红框上下横杠与左印属同一连通域 ⇒ 单纯裁剪无法根除右缘尖刺、完美方印需改图（未做、待 Kevin 定）**；未采用解两处（`-83.76 …`：四边 ≥ 5% / `0.1385%`；字面居中解：`1.297%`、比旧版更差 ✗） | **§3.42.7 ＋ §3.40 追加修订注（v1.41）** | **§3.40.1 〜 §3.40.7 原文一字未改** | **AC-397 / AC-398** | **W-63** |
| 6 | **数据面真实全貌（13 个精确集合名）**：`xiai_seals` / `xiai_faces` / `xiai_images` 各 79（2026-09-20 fixture，早于全部写面单、未动 ✓）；`xiai_config` 存在但 0 文档；`xiai_corrections` / `downloaded` / `photos` / `points` / `invites` / `seallists` / `seallist_items` / `shares` / `users` 均 0；`xiai_admin_audit` **未创建** ✓；**★ 更正**：「`79 / 0 / 0`」系集合名对不上而回 0 ⇒ **不得**用作「零写入」或「数据变化」依据 ✗；P1 零写入现由**正确集合名**重数支撑 ✓ | **§3.42.8 ＋ §3.33.3 追加修订注（v1.41）** | **§3.33.3 清单与各注原文一字未改、未删** | **AC-399 / AC-400** | — |
| 7 | **配置键的实现位置**：客户端 `localStorage` 键 `xiai:v1:invite-reward`（链路 `admin.js:154 → drive.js:485 → storage.js:117`），**不是云端文档** ✗；`setInviteReward` 授权门载荷键形 `{value:<int>}` ≠ 配置键形状 `{invite_reward:<int>}` ✓；**★ 明文撤回**：云端 `xiai_config` 无该记录；任何「云端已被写成 9」的判断均**不成立**（已撤回 ✓） | **§3.42.8** | — | **AC-401 / AC-402** | **W-62** |

**另落位**：**新 §3.42（含 §3.42.1 〜 §3.42.9）／ 新 §10.40 ＋ §10.40 表下注（v1.41）／ §10.7 计数留痕（v1.41）／ §11 新行 4 行 ＋ §11 计数留痕（v1.41）／ §1.4 追溯码（v1.41 追加）／ 表头三处（版本摘要行 ＋「最近修订」＋「依据 / 被引用输入与时点 / 本次登记的基准版本」）／ §12 本版行 ／ 页脚版本横幅 ＋ 页脚留痕（v1.41 追加）**。

**⇒ 三条「不得写成已验证」的核对（本包已落）**：
**① 「过期令牌」负向 ＝ 待补**：**在 §3.42.5 ＋ AC-395 ＋ W-60 三处并列写出「未跑 / 不得写成已验证」✓**；
**② 「假 0 基线」更正**：**在 §3.42.8 ＋ §3.33.3 追加修订注（v1.41）＋ AC-400 ＋ §10.40 表下注 ①(c) 四处并列写出（含「不得据旧读数判 `AC-365` 通过 / 判负」）✓**；
**③ 「云端被写成 9」撤回**：**在 §3.42.8 ＋ AC-402 ＋ W-62 三处并列写出 ✓**。

---

## 3. 新增 AC / W 编号与计数（**逐处现取**）

| 项 | 现取读数 | 落位 |
| --- | --- | --- |
| **基线时最大 AC 号** | **`AC-384`**（现态含 `AC-373` 〜 `AC-384`，系 v1.40 落位） | — |
| **本包新增 AC** | **`AC-385` 〜 `AC-402`（共 18 条，连续编号、无跳号、无复用）** | **新 `§10.40`** |
| **§10 总条数** | **384 → 402**（**终态实测：`AC-` 唯一编号 402 个／最大号 `AC-402`**） | §10.7 v1.41 留痕 ＋ §10.40 计数留痕 |
| **基线时最大 W 号** | **`W-59`**（v1.40 新开） | — |
| **本包新增 W** | **`W-60` ／ `W-61` ／ `W-62` ／ `W-63`（共 4 行，**自 `W-60` 起**，均待裁、本包不代裁）** | **§11 表内（紧随 `W-59` 行之后）** |
| **本包结案 W** | **0 行**（**不结案、不收窄任何既有 W 行**） | — |
| **§11 表内行数** | **57 → 61 行**（**终态实测：表内 `W-` 行 61 行、唯一编号 61 个、最大号 `W-63` ✓**） | §11 计数留痕（v1.41） |
| **有效待裁项** | **40 → 44 行**（**＋4 全数计入；基线 40 行系 v1.40 行登记值 —— `W-36` 结案 −1、`W-43` 转「已接受风险（暂缓）」−1、`W-58` / `W-59` ＋2 ⇒ 净额不变**） | 同上 |
| **本包新增数值 / 字面值** | **新增 `reason` 字面值 0 ✓；新增 `verdict` 字面值 0 ✓**；**新增数值一律为**照登的实测读数**（`181 ms` / `112 ms` / `149 ms` / `219` / `218` / `900` / `79` / `0` / `437.64` / `0.78%` / `0.0000%` / `0.1385%` / `1.297%` / `50–250 ms`）或**既有冻结值的引用**（TTL `900 s` ＝ 15 分钟），非本版新立阈值** | §3.42 ／ §10.40 |

---

## 4. 主规范零改动证明（前后各一次）

```
# 改动前（本包第一动作，只读）
$ md5 -q /Users/kevin/bistro/xiai/docs/xiai.spec.md
366b3afd94c46671b15773d26b313320
$ wc -l /Users/kevin/bistro/xiai/docs/xiai.spec.md
   6005

# 落包后（交付前，只读）
$ md5 -q /Users/kevin/bistro/xiai/docs/xiai.spec.md
366b3afd94c46671b15773d26b313320        # ✓ 一字未动
$ wc -l /Users/kevin/bistro/xiai/docs/xiai.spec.md
   6005
```

**⇒ 两读数逐字一致 ✓**：**本包对仓库主规范只读；本包在仓内**只新增** `docs/spec-increments/writeface-pa-and-platform-gate/` 一处（`patch.diff` ＋ 本报告），不改任何既有文件、不改任何既有增量包本体**。

---

## 5. 未登记项与待裁登记（本包不代裁）

- **① 过期令牌负向的补跑形态与判据** ⇒ **新开 `W-60`**（**待补 / 待裁**）。
- **② 云函数匿名可达清单与各函数授权形态** ⇒ **新开 `W-61`**（**待裁**）。
- **③ 站点配置的权威落点（客户端 `localStorage` vs 云端 `xiai_config`）** ⇒ **新开 `W-62`**（**待裁**）。
- **④ 完美方印 favicon 的改图形态与范围** ⇒ **新开 `W-63`**（**待 Kevin 定**）。
- **⑤ 诊断通道的打码规则（正则 / 保留长度）与日志留存形态** —— 属实现侧自由（**§3.42.6 只登记「打码」与「形状不变」两条**），**不另立条款、不登记 W 行**。
- **⑥ 令牌的具体编码形态（段数 / 声明字段名）** —— 属实现侧自由（**沿用 §3.39 的「不登记编码细节」口径**），**不另立条款、不登记 W 行**。
- **⑦ 静态资产的缓存与失效 / 护栏形态**（`W-56` / `W-57`）—— **本包只追加登记两件资产与机械判据**，**不判结案、不重复开行**。
- **⑧ `W-59`（写面云函数正式命名与 `cloudbaserc.json` 的 `functions[]` 维护归属）** —— **本包只登记第五个函数的部署事实**，**不判结案、不重复开行**。
- **明文**：**`W-60` 〜 `W-63` 未裁前，不得据任一方向判负**；**亦不得据本版把任一形态判通过**（`AC-395` / `AC-398` / `AC-400` / `AC-402`）。

---

## 6. 纪律自查（逐条）

| 纪律 | 自查 |
| --- | --- |
| **只改 `docs/**`（只新增本包）** | ✓ **仓内唯一新增 ＝ `docs/spec-increments/writeface-pa-and-platform-gate/`**；**主规范只读**（前后 md5 一致） |
| **不得改主规范现态** | ✓ **`366b3afd94c46671b15773d26b313320` 一字未动**（前后各测一次） |
| **不得改既有各包本体** | ✓ **`writeface-p2-0-freeze/patch.diff` 只作负对照**逆应用**用（读取 ＋ 应用于 scratch 副本），本体零写入** |
| **不跑构建 / 测试、不起服务、不占端口、不联网** | ✓ **未跑 `npm` / `vite` / 任何测试；未起服务；未联网** |
| **不对任何仓 git 写、不 push** | ✓ **未执行 `git add` / `commit` / `push`**；**`git apply` 只在 scratch 副本内执行**（**仓库内无 `.git`，`git apply` 为独立补丁工具，不涉仓内写**） |
| **不碰实现侧工作区** | ✓ **未改 `src/**`、`public/**`、`cloudfunctions/**`、`vercel.json` 任何字节**（**只读引用**） |
| **不执行需审批命令；禁 `pkill -f` / `killall`** | ✓ **未执行** |
| **预算（≤ 30 次工具调用）** | ✓ **先落盘 patch ＋ 报告，未做多余往返** |

**⇒ 本包不含任何「已落地 / 已通过 / 已验收」结论**；**落地归 Kong、验收归 Neng**。**时点戳 ＝ 2026-10-01（CST）**。
