# 第三步增量包报告 · 玺爱（xiai）「一键导出印章数据」导出面 · **v1.34 第三包**（两项规范遗留：`AC-309` 路由条数读差 ＋ 既有结构事实登记）

- **角色 / 边界**：Jing（Specifier）。**只写文档**；未改 `src/**`、`package.json`、路由表（**路由表只读实测**）；未跑构建 / 测试；未起服务、未占端口；**未对任何仓做 git 写操作、未 push**；未碰实现方与 QA 的工作区（`xiai-export` 一类）、未碰其它规范文件（`yinyuan-web.spec.md` 等）；**未执行 `pkill -f` / `killall`**。
- **交付物**：① `xiai/docs/spec-increments/export-seal-data-v1.34-third/patch.diff`（md5 `dc0dee4d39fab26172d4cda371943c2e`、**87,445 B**、**9 个 hunk**、**`+10 行` / `−0 行`**＝纯插入、无删除语义）；② 本报告。
- **基准（＝ 包 1 ＋ 包 2 之后的状态，非 v1.33）**：`xiai/docs/xiai.spec.md` **v1.34（首包 ＋ 续包）**，md5 `913d8404f7395534d540f86f270e6594`、**5,195 行 / 2,327,406 B**（本单在一次性副本内复现该态后作为第三包基线）。
- **三步应用后的产物**：**5,205 行 / 2,340,574 B**、md5 `7c9c88746e9b3f010b7abd6ef7cce44a`；**版本仍 v1.34**（第三包**不升版本号** —— 见 §4）。
- **仓库现状（如实登记）**：`xiai/docs/xiai.spec.md` **当前仍是 v1.33 原文**（md5 `b352a5eb5e5e06c5a5cd04ee229fbbfa`、4,923 行 / 2,211,581 B）——**三包均尚未应用**；**本单未直接改仓库主规范文件**（按交付口径保持 v1.33，落地时由 Zang 统一应用）。
- **已交付包的文件本体**：`export-seal-data-v1.34/`（包 1）与 `export-seal-data-v1.34-followup/`（包 2）**一个字节未碰**（md5 与体积见 §3.5）。

---

## 0. 两项遗留的结论摘要（一句话各一）

1. **遗留 1（`AC-309` 的「路由仍 8 条」vs 仓内实测 9 条）**：**判定 ＝ 规范那个数字不是转抄错误 ⇒ 数字不改（仍 8）；差值的唯一成因是「条数口径未写明」（是否计入末条兜底重定向），构成 `AC-309` 判据 ⑥ 的**可执行性缺口** ⇒ 按第二方向处置：**不改规范数字、开 `W-42` 如实登记差异（附实测命令与读数）并交人裁**；本包**不改 `AC-309` 的数字与行内文字、不代裁**。**三件依据见 §1.3**。
2. **遗留 2（既有结构事实）**：**本册 AC 表现存 313 行、唯一编号 299 个、重复编号恰 14 个（`AC-05` / `AC-09` / `AC-13` / `AC-21` / `AC-33` / `AC-72` / `AC-87` / `AC-88` / `AC-89` / `AC-90` / `AC-93` / `AC-94` / `AC-96` / `AC-125`）；`AC-219` 无独立表行** —— **作为既有结构事实单列一句登记（不改动、不代裁）**。

---

## 1. 遗留 1：`AC-309` 的路由条数（现取真值 → 再判定性质）

### 1.1 实测（先现取真值：命令 ＋ 读数，逐字）

工作目录 `/Users/kevin/bistro/xiai`（**只读**）：

```
$ sed -n '/^const routes = \[/,/^\]$/p' src/router/index.js | grep -c '^    path:'
9                                  # ← routes 数组内 path 条数（含末条兜底）

$ sed -n '/^const routes = \[/,/^\]$/p' src/router/index.js | grep '^    path:' | sed 's/^ *//'
path: '/',
path: '/seal/:id',
path: '/my/corrections',
path: '/my/photos',
path: '/my/drive',
path: '/points',
path: '/login',
path: '/s/:code',
path: '/:pathMatch(.*)*'           # ← 末条：兜底重定向

$ ... | grep '^    path:' | grep -vc 'pathMatch(.*)\*'
8                                  # ← 排除末条兜底后的条数

$ grep -n -A3 'pathMatch' src/router/index.js
14: * 末条 `/:pathMatch(.*)*` 是**兜底重定向**（不是一个可直达页面，不渲染任何内容）：
15- * 未知路径——含已退役的 `/admin`——一律重定向到藏品广场。
16- */
17-const routes = [
--
67:    path: '/:pathMatch(.*)*',
68-    name: 'not-found',
69-    redirect: { name: 'square' }
70-  }
```

**口径说明（关键）**：**同一份 `src/router/index.js` 在两种口径下给出两个读数** ——

- **9 条 ＝ `routes` 数组长度**（**8 条可直达路由 ＋ 末条兜底重定向**）；
- **8 条 ＝ 可直达路由条数**（**不含末条 `/:pathMatch(.*)*`**；**该条是 `redirect: { name: 'square' }` 的兜底条，不渲染任何页面**）。

**该文件自身的头注亦按「8 条可直达路由」写**，并明写末条「**不是一个可直达页面**」（第 5 行、第 14 行，逐字见上）；**即实现方的 9 条并非与规范相冲的读数，而是另一口径下的读数**。

### 1.2 性质判定

**结论 ＝ 非转抄错误**（**规范数字 8 与册内权威计数一致 ⇒ 不改**）；**同时，实测 9 条与 `AC-309` 字面的 8 条确有读差，其唯一成因 ＝ 「条数口径未写明」** ⇒ 这属**判据可执行性缺口**（`AC-309` 判据 ⑥ 只写「读路由表（给条数与逐条 `name` / `path`）」与「路由仍 8 条」，**未写明是否计入末条兜底重定向**），因此**按「不改规范数字、开 `W-42` 如实登记差异并交人裁」的方向处置**。

**为什么同时不取「转抄错误 ⇒ 改数」这一方向**：**若 8 系转抄旧值所得，其真值须有册内 9 条的来源；本单检索后确认册内无「9 条」来源，且旧值方向恰为 7 条 / 6 条（与 8 不符）** —— 即**改数方向会把规范改成与 `§8.1` / `§8.3` 直接自相矛盾的 9 条**（详见 §1.3 依据 ③ 与 §1.4）。

### 1.3 三件依据（规范原值 / 实测值 / 判为转抄错误的依据）

**① 规范原值 ＝ 8 条（出处逐字）**

- `§8.1` 表下注（**v1.21 追加**）②：**「集合计数自本版起为 8 条」**（同注并写明：**上表 7 行 ＋ v1.3 表下注 ① 的移除 `/admin` ⇒ 6 条，为本版之前的历史读数 …… 自 v1.21 起为「8 条即全部」**）。
- `§8.1` 表下注（**v1.21 追加**）③：**末条 `/:pathMatch(.*)*` ⇒ 重定向到藏品廣場**；**其形态与指向一字未改**；**不得因新增路由而删除 / 改向 / 使其失效**（**即末条在册内被单列为「兜底重定向」，从不计入「N 条」**）。
- `§8.3` **v1.21 收口注**判负形态：**「菜单项与 §8.1 的 8 条路由对不上」**。
- `AC-309`（§10.32）判据 ⑥：**「路由仍 8 条（逐条与改前一致）」**；判负 ⑥：**「改了既有 8 条路由的 `name` / `path`」**。

**② 实测值 ＝ 9 条（数组长度口径）／8 条（可直达口径）** —— 命令、逐条 `path`、兜底条原文、文件头注**均见 §1.1**。

**③ 判为「转抄错误」的依据 —— 不成立（三条反面验证，逐条给命令与读数）**

```
$ grep -c '路由[^|]\{0,40\}9 条\|9 条[^|]\{0,40\}路由' docs/xiai.spec.md
0                                  # ← 册内「路由 + 9 条」共现 0 命中 ⇒ 无 9 条的规范化来源

$ grep -o '路由集合[^；]\{0,18\}' docs/xiai.spec.md | sort | uniq -c | sort -rn
   2 路由集合「6 条即全部」⇒ 8 条**
   1 路由集合（「6 条即全部」）⇒ 现为 8 条
   1 路由集合自本版起为 8 条、菜单 5 项**
   1 路由集合自本版起为 8 条**（**原「6 …
   1 路由集合 ＝ 6 条**（上表第 1 ～ 5
   1 路由集合封闭性**：上表**7 条即全部**
   …（去重后仅三档：7 条 / 6 条 / 8 条）

$ grep -n '条路由\|路由表' docs/xiai-plan.md | cut -c1-120
…:1005:**磁盘事实（拆解前先摸）**：侧边栏 `AppSidebar.vue` **4 项**…；路由表 **6 条**（`/`、`/seal/:id`、`/my/cor…
…:2043:**已派**：`K-repo-vercel-prep`（Kong）—— …（**与路由条数无关**：vercel rewrites）
```

⇒ **三点合起来**：**（i）册内历版路由读数只有 7 条（v1.0 ～ v1.2）／6 条（v1.3 ～ v1.20）／8 条（自 v1.21）三档，从无 9 条**；**（ii）派单件所列的「旧值来源」候选 —— `xiai/docs/xiai-plan.md` —— 其内路由读数恰为 6 条（L1005），与 8 不符**（因此**若 `AC-309` 的 8 系转抄旧值，它应写成 6 而非 8**）；**（iii）8 恰与 `§8.1` 表下注（v1.21 追加）② 的权威计数逐字一致**。**⇒ 8 不是旧值转抄所得，是现行权威计数 ⇒ 「转抄错误」方向不成立**。

### 1.4 为什么不走「真偏差 ⇒ 只开 `W-42` 不解释数字」的粗口径，也不走「改数」方向

- **不是「仓内不符规范要求」意义上的真偏差**：**仓内 8 条可直达路由与规范逐条一致**（`/`、`/seal/:id`、`/my/corrections`、`/my/photos`、`/my/drive`、`/points`、`/login`、`/s/:code`）；**未新增 / 未删除路由，未改任何既有路由的 `name` / `path`**；**末条兜底重定向的形态与指向未改**（与 `§8.1` 表下注（v1.21 追加）③ 的硬要求一致）。
- **但确有一条真登记项**：**`AC-309` 判据 ⑥ / 判负 ⑥ 的条数口径未写明** ⇒ **按单里给出的第二方向落地：不改规范数字、开 `W-42`、附实测命令、交人裁**（**`W-42` 编号亦为册内预授权** —— `§11`（v1.34 续包 更新｜留痕）逐字：「**若后续实现 / 质检面报出真缺口，一律另开 `W-42` 并交 Kevin 裁、不代裁**」）。
- **双向封堵（本包落笔，未裁前有效）**：**不得据「`routes` 数组读到 9 条」判任何合规实现负**；**亦不得据「按 `§8.1` 口径读到 8 条」判通过**。

### 1.5 落点（**`AC-309` 一行字未改**）

| 落点 | 内容 |
| --- | --- |
| 表头「最近修订」新增行 | v1.34（第三包）摘要（两遗留 ＋ 结论 ＋ 落位） |
| 表头「依据（**v1.34 第三包 追加**）」 | 输入面 ＋ 本包只读实测面 |
| 表头「被引用输入与时点（**v1.34 第三包 追加**）」 | 时点 ＋ 准入读数面 ＋ 不写验收结论 |
| `§1.4` 追溯码（**v1.34 第三包 追加**） | 不新立 R 项 / 不新增 AC / 新增 `W-42` 一行 |
| **`§10.32` 表下注（v1.34 第三包 追加）** | ① 不改动声明（`AC-309` 判据 ⑥ 与判负 ⑥ **逐字未改**）；② 两读数并存（规范 8 / 实测 9）；③ **双向封堵三条**；④ 待裁落点 ＝ `W-42`；⑤ **实测命令与读数逐字** |
| **`§11` `W-42` 行** | 五栏 ＋ 事实（含命令与逐条 path）＋ 待裁问题（口径二选一）＋ Zang 拟（取 ① 维持 8 并把口径写明）＋ 影响面 / 缺什么 |
| `§11` 计数留痕（**v1.34 第三包 更新**） | 表内 39 → **40 行**；有效待裁项 31 → **32 行** |
| `§11.2(ae)` ＋ `(ae-2)` | 未登记项与原因（四项）＋ 小节性质 |
| `§12` 变更记录新增行 | 本包完整叙述 |
| 页脚留痕（**v1.34 第三包 追加**） | **不升版本号**的明文与理由 |

---

## 2. 遗留 2：既有结构事实（**单列一句**，不改动、不代裁）

**既有结构事实（如实登记）：本册 AC 表现存 313 行、唯一编号 299 个、其中 14 个编号在两张表重复（`AC-05` / `AC-09` / `AC-13` / `AC-21` / `AC-33` / `AC-72` / `AC-87` / `AC-88` / `AC-89` / `AC-90` / `AC-93` / `AC-94` / `AC-96` / `AC-125`）、且 `AC-219` 无独立表行（作表行命中 0；作为字串出现 12 次，均为引用）—— 系既有结构事实，本包不改两张表的任何一行、不移位、不合并、不代裁；明文：不得据上述结构事实判任何合规实现负。**

复跑命令与读数（**本包就地复核**，与上一轮登记一致）：

```
$ grep -c '^| \*\*AC-[0-9]\+\*\*' docs/xiai.spec.md            # AC 表行总数
313
$ grep -o '^| \*\*AC-[0-9]\+\*\*' docs/xiai.spec.md | grep -o 'AC-[0-9]\+' | sort -u | wc -l
     299                                                        # 唯一编号数
$ ... | sort | uniq -d | wc -l
      14                                                        # 重复编号个数（上列 14 个）
$ grep -c '^| \*\*AC-219\*\*' docs/xiai.spec.md                 # AC-219 作独立表行
0
$ grep -c 'AC-219' docs/xiai.spec.md                            # 作为字串出现
12
```

**（不改动、不代裁）落在 `§11.2(ae) ③` 与 `§11` 计数留痕句内，各一句。**

---

## 3. 补丁可应用性（**三步应用顺序，逐字取证**）

### 3.1 应用顺序（明文）

**① `v1.33` 原文 ⇒ ② 包 1** `docs/spec-increments/export-seal-data-v1.34/patch.diff`（**v1.33 → v1.34 首包**）**⇒ ③ 包 2** `docs/spec-increments/export-seal-data-v1.34-followup/patch.diff`（**v1.34 首包 → v1.34 续包**）**⇒ ④ 包 3** `docs/spec-increments/export-seal-data-v1.34-third/patch.diff`（**本单交付物：v1.34 续包 → v1.34 第三包**）。

**三步均为必需，缺任一步后一步必被拒**（负对照 A / B / C 逐条为证）。**接受判据 ＝ 各步 `git apply --check` 退出码 0 且 `git apply` 打印 `Applied patch docs/xiai.spec.md cleanly.`**。

### 3.2 逐字输出（一次性副本；基线 md5 `b352a5eb5e5e06c5a5cd04ee229fbbfa` / 4,923 行 / 2,211,581 B）

**负对照（跳包必失败；三处的 `error: while searching for:` 之后 git 会各打印一段候选上下文原文，本报告按长度省略该段，**其后的关键行与退出码逐字保留**）**：

```
# 【负对照 A】跳「包 1」——在 v1.33 原文上直接应用「包 2」⇒ 必失败
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34-followup/patch.diff
Checking patch docs/xiai.spec.md...
error: while searching for:
（git 逐字打印的候选上下文原文，约 22 行 —— 本报告省略）
error: patch failed: docs/xiai.spec.md:36
error: docs/xiai.spec.md: patch does not apply
exit=1                                    # raw_skip1_check_exit=1

# 【负对照 B】跳「包 1 ＋ 包 2」——在 v1.33 原文上直接应用「包 3」⇒ 必失败
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34-third/patch.diff
Checking patch docs/xiai.spec.md...
error: while searching for:
（同上，本报告省略）
error: patch failed: docs/xiai.spec.md:36
error: docs/xiai.spec.md: patch does not apply
exit=1                                    # raw_skip12_check_exit=1

# 【负对照 C】跳「包 2」——在 v1.33 ＋ 包 1 上直接应用「包 3」⇒ 必失败
$ git apply --verbose docs/spec-increments/export-seal-data-v1.34/patch.diff
Applied patch docs/xiai.spec.md cleanly.
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34-third/patch.diff
Checking patch docs/xiai.spec.md...
error: while searching for:
（同上，本报告省略）
error: patch failed: docs/xiai.spec.md:36
error: docs/xiai.spec.md: patch does not apply
exit=1                                    # raw_skip2_check_exit=1
```

**正向（三步序列）**：

```
--- 第 1 步：包 1（复现基线，非本单交付物）---
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34/patch.diff
Checking patch docs/xiai.spec.md...
check_exit=0
$ git apply --verbose docs/spec-increments/export-seal-data-v1.34/patch.diff
Checking patch docs/xiai.spec.md...
Applied patch docs/xiai.spec.md cleanly.
apply_exit=0
$ md5 docs/xiai.spec.md
9d367d3434ae53b83bfdee6b2d33291d

--- 第 2 步：包 2 ---
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34-followup/patch.diff
Checking patch docs/xiai.spec.md...
check_exit=0
$ git apply --verbose docs/spec-increments/export-seal-data-v1.34-followup/patch.diff
Checking patch docs/xiai.spec.md...
Applied patch docs/xiai.spec.md cleanly.
apply_exit=0
$ md5 docs/xiai.spec.md
913d8404f7395534d540f86f270e6594

--- 第 3 步：包 3（本单交付物）---
$ git apply --check --verbose docs/spec-increments/export-seal-data-v1.34-third/patch.diff
Checking patch docs/xiai.spec.md...
check_exit=0
$ git apply --verbose docs/spec-increments/export-seal-data-v1.34-third/patch.diff
Checking patch docs/xiai.spec.md...
Applied patch docs/xiai.spec.md cleanly.
apply_exit=0
$ md5 docs/xiai.spec.md && wc -l -c < docs/xiai.spec.md
7c9c88746e9b3f010b7abd6ef7cce44a
    5205 2340574
$ cmp docs/xiai.spec.md <本单构建器输出>
cmp_with_builder_output=IDENTICAL          # 应用结果与产出文件逐字节一致

--- 反向复核（包 3）---
$ git apply -R --check --verbose docs/spec-increments/export-seal-data-v1.34-third/patch.diff
Checking patch docs/xiai.spec.md...
reverse_check_exit=0
```

**旁证三件**：**①** 结构 ＝ **纯插入 10 处、`−0 行`**（`patch.diff` 内以 `-` 起首的行只有 diff 头 `--- a/docs/xiai.spec.md` 一行 ⇒ **无任何删除 / 替换语义**）；**②** 应用结果与构建器输出 `cmp` **逐字节一致**；**③** 反向 `--check` 通过（`exit=0`）。

### 3.3 现场应用命令（逐字，供 Zang 落地）

```
cd /Users/kevin/bistro/xiai
git apply -v docs/spec-increments/export-seal-data-v1.34/patch.diff
git apply -v docs/spec-increments/export-seal-data-v1.34-followup/patch.diff
git apply -v docs/spec-increments/export-seal-data-v1.34-third/patch.diff
md5 docs/xiai.spec.md      # 期望 7c9c88746e9b3f010b7abd6ef7cce44a（5,205 行 / 2,340,574 B）
# 反向复核（可选）：git apply -R -v docs/spec-increments/export-seal-data-v1.34-third/patch.diff
```

**注**：`/Users/kevin/bistro/xiai` 当前**不是 git 仓库**（`git apply` 在非仓目录不可用），故本单的可应用性取证与上两包同法 —— **在一次性副本（`git init` 的临时目录）内、以 `docs/xiai.spec.md` 为路径基准进行**；补丁路径前缀为 **`a/docs/xiai.spec.md` / `b/docs/xiai.spec.md`**，与包 1 / 包 2 一致。

### 3.4 本包落点的 10 处插入（逐处）

| # | 位置 | 插入内容 |
| --- | --- | --- |
| 1 | 表头「最近修订」（前置一行） | v1.34（第三包）摘要 |
| 2 | 表头「依据（**v1.34 第三包 追加**）」 | 输入 ＋ 只读实测面 |
| 3 | 表头「被引用输入与时点（**v1.34 第三包 追加**）」 | 时点 ＋ 准入读数 ＋ 不写验收结论 |
| 4 | `§1.4` 追溯码（**v1.34 第三包 追加**） | 编号纪律 ＋ `W-42` |
| 5 | `§11` 表内（紧随 `W-41` 行） | **`W-42`** 行 |
| 6 | `§10.32` 表下注（续包注之后） | **v1.34 第三包 追加**注（登记 ＋ 双向封堵 ＋ 命令） |
| 7 | `§11` 计数留痕（v1.34 续包 句之后） | **v1.34 第三包 更新｜留痕** |
| 8 | `§11.2`（`(ad-2)` 之后） | **`(ae)` ＋ `(ae-2)`** |
| 9 | `§12` 变更记录（v1.34（续包）行之前） | **v1.34（第三包）** 行 |
| 10 | 页脚（续包留痕之后） | **页脚留痕（v1.34 第三包 追加）** |

### 3.5 三包体量对照（**包 1 / 包 2 本体未碰**）

| 包 | 文件 | 字节 | hunk 数 | md5 |
| --- | --- | --- | --- | --- |
| 包 1 | `export-seal-data-v1.34/patch.diff` | 142,933 | 14 | （未碰，与交付时一致） |
| 包 2 | `export-seal-data-v1.34-followup/patch.diff` | 103,710 | 16 | （未碰，与交付时一致） |
| **包 3（本单）** | `export-seal-data-v1.34-third/patch.diff` | **87,445** | **9** | **`dc0dee4d39fab26172d4cda371943c2e`** |

---

## 4. 版本号与快照（明文口径）

- **不升版本**：第三包与首包 / 续包**同属 v1.34 的入账单**、未产生新的对外版本 ⇒ **版本横幅行「规范结束（xiai.spec.md v1.34｜2026-09-29｜Jing）」一字未改**；页脚只增「**页脚留痕（v1.34 第三包 追加）**」一行，**逐字写明不升版本号及其理由**：**本包为同版遗留收口 —— 不新增 AC、不新增实质阈值、不放宽任何判据、不对任何既有条款作取代 / 收窄；唯一新增内容为一条待裁登记（`W-42`）与一条既有结构事实的如实登记**。
- **本包不新建版本快照**：**§1.3 第 0 步的改前快照仍为 `xiai/docs/versions/xiai.spec.v1.33.md`**（首包已建）。
- **计数面**：**§10 仍 316 条（AC-01 〜 AC-316）**；**AC 编号与行内文字一字未改**；**§11 表内 39 → 40 行、有效待裁项 31 → 32 行**（新增 `W-42`）。

---

## 5. 纪律核对（逐条）

| 项 | 状态 |
| --- | --- |
| 只改 `docs/**`（新增第三包目录） | ✅ 仅新增 `docs/spec-increments/export-seal-data-v1.34-third/{patch.diff, 本报告}` |
| 不改主规范文件 | ✅ `docs/xiai.spec.md` **仍 v1.33 原文**（改动只存在于补丁内，落地时由 Zang 统一应用） |
| 不改 `src/**` / `package.json` / 路由 | ✅ 路由表**只读实测**（`sed` / `grep`），一个字节未碰 |
| 不跑构建 / 测试、不起服务、不占端口 | ✅ |
| 不对任何仓做 git 写操作、不 push | ✅ 仅在**一次性副本（临时目录）**内 `git init` ＋ `git apply` 做可应用性自证 |
| 不碰实现方与 QA 工作区 | ✅ 未进 `xiai-export`、`xiai/qa-recheck/**` |
| 不升版本号（仍 v1.34） | ✅ 页脚留痕写明理由（§4） |
| 不执行需审批命令 | ✅ |
| 禁 `pkill -f` / `killall` | ✅ 未执行 |
| 不改已交付的包 1 / 包 2 文件本体 | ✅ 未碰（§3.5） |
| 不代裁 | ✅ `AC-309` 数字与行内文字一字未改；`W-42` 只登记 ＋ 拟案，交 Kevin 裁；结构事实只登记、不改动 |

---

## 6. 交付清单

```
xiai/docs/spec-increments/export-seal-data-v1.34-third/
├── patch.diff                      # 87,445 B；9 hunk；+10 行 / −0 行；md5 dc0dee4d39fab26172d4cda371943c2e
└── report-spec-export-third.md     # 本文件
```

**三步应用后成品**：`xiai/docs/xiai.spec.md` v1.34（**5,205 行 / 2,340,574 B**、md5 **`7c9c88746e9b3f010b7abd6ef7cce44a`**），**版本仍 v1.34**。
**待裁项**：**`W-42`（`AC-309` 的路由条数口径）—— 裁定人 Kevin；未裁前不得据任一读数判负、亦不得据任一读数判通过**。
