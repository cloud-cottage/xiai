# 增量件 · 印源 v1.37 —— 改名登记（`yinsuo` → `yinyuan`；「印索」→「印源」）＋ 规范文件名随改 ＋ 自查项转正 A-24 ＋ 跳站注双向对齐

- **单号**：J-yinyuan-v137（Jing / 规范方 · 印索＝印源线）
- **升版**：`docs/yinsuo-web.spec.md` **v1.36 → v1.37**，**同一文件同期改名为 `docs/yinyuan-web.spec.md`**
- **基线（开工现算自证，与派单基线一致）**：主文件 md5 `5f309de7a800be7c9192e5d0ebb0bd31` / **1,853 行** / **720,763 B**（**该文件无末行换行符**：`wc -l` 报 1852、`splitlines()` 报 1853 —— **1,853 行为真值**）
- **快照**：**新建** `docs/versions/yinyuan-web.spec.v1.36.md` ＝ **改名前 v1.36 的逐字节副本**（改版前 `cp -p`；`cmp` 无差异）；**既有 `docs/versions/yinsuo-web.spec.v1.35.md` 未覆写**（md5 复核一致）
- **来源**：**改名口径一律「Kevin 2026-09-24 裁定」**（重命名：`yinsuo` 为 `yinyuan`（目录更改）；文案：【印索】为【印源】）；**涉现状者为磁盘只读实测（带时点与证据）**
- **AC 续号**：上版末号 **AC-100** ⇒ 本版 **AC-101**（**无重号、无跳号**）；**AC 计数 100 → 101**
- **性质**：**登记 ＋ 留痕 ＋ 文件名变更 ＋ 一项转正**；**零取代**（**历史行逐字保留、不逐字改写**）

**开工实测（本单自跑，作为本版结论的实证）**：

```
$ md5 docs/yinsuo-web.spec.md                         → 5f309de7a800be7c9192e5d0ebb0bd31
$ wc -l -c docs/yinsuo-web.spec.md                    → 1852 720763
$ python3 -c "…splitlines()…"                         → 1853 行（无末行换行符）
$ grep -o '^- \[ \] AC-[0-9]\+' docs/yinsuo-web.spec.md | wc -l → 100
$ md5 docs/versions/yinsuo-web.spec.v1.35.md          → 11bb84f2573b8d9192dc838498145ce1
$ md5 docs/spec-increments/yinsuo-hans-baseline-v1.36.md → a2de602f01bb27e45d7c67220eec0e7d
$ ls -d /Users/kevin/bistro/xiai/yinsuo               → No such file or directory
$ ls -d /Users/kevin/bistro/xiai/yinyuan              → 命中（birth=Sep 20 15:04:01 2026 / mtime=Sep 24 12:39:37 2026）
$ grep -c yinyuan /Users/kevin/bistro/xiai/ctrl/PORTS.md → 0（ctrl 侧同源登记尚未落地）
$ grep -ro 印源 yinyuan/src yinyuan/*.html | wc -l    → 15
$ grep -ro 印索 yinyuan/src yinyuan/*.html | wc -l    → 0
```

**核验时点**：**2026-09-24 12:43（CST）**（全部磁盘读数为**只读**取得）。

## 一、五项落位总览

| # | 事项 | 落点 | 判据 / 产物 |
| --- | --- | --- | --- |
| ① | **改名事实入规范**（目录 / 显示名 / 上屏文案；**历史行不动**；**留痕 ＋ 新旧对照表**） | **§0.8**（＋ §0.2 v1.37 注 ＋ §0.4 第 9 条 ＋ §10 术语表新增「印源」行） | **AC-101** |
| ② | **规范文件名随目录改名**（`mv` 主文件 ＋ 新建逐字节快照；**不动既有快照 / 增量件文件名**） | **`docs/yinyuan-web.spec.md`** ＋ **`docs/versions/yinyuan-web.spec.v1.36.md`** | `cmp` 无差异 |
| ③ | **自查项转正 A-24**（由 v1.36 附录 A 注 → 正式表行） | **附录 A 第 24 行**（＋ 其下 v1.37 追加注） | 附录 A `A-24` |
| ④ | **跳站注双向完备**（本文件已就地注「`AC-72` 与玺爱线同号异义」；**补「玺爱规范 v1.32 侧已同步加跳站交叉注」**） | **§7.9-6**（＋ §1.8 引言 v1.37 追加注 ＋ §12 L 组 AC-72 v1.37 追加注） | **AC-99** |
| ⑤ | **例行留痕**（AC 计数 100 → 101；§11 W 行；页脚横幅；变更记录；来源标注） | **§12 U 组 AC-101** ＋ **§11 `W-YS-1`** ＋ 表头「最近修订」块 ＋ §0.5 ＋ 页脚横幅 | 三处同步 |

## 二、新旧对照表（全文 ＝ 规范 §0.8-2）

| # | 项 | 旧（2026-09-24 之前） | 新（2026-09-24 起） | 处置 / 证据 |
| --- | --- | --- | --- | --- |
| 1 | **工程目录** | `xiai/yinsuo/` | **`xiai/yinyuan/`** | 目录改名**已落地**（**由 Kong / ctrl 侧执行**）；**只读实测**：`ls -d xiai/yinsuo` ⇒ `No such file or directory`；`ls -d xiai/yinyuan` ⇒ **命中**。**Jing 不写 `xiai/yinyuan/**`** |
| 2 | **面板显示名** | 「印索 shu」 | **「印源 shu」** | **只读实测**：`ctrl/index.js` 第 **50** 行 `name: '印源 shu'`；第 **58–60** 行记「⚠ 重命名（2026-09-24，Kevin 裁定）：目录 `yinsuo` → `yinyuan`；显示名「印索」→「印源」」＋ `cwd: '/Users/kevin/bistro/xiai/yinyuan'`。**该文件属 ctrl 侧，本文件零写入**。**同文件第 176 行 `label` 仍为「印索 shu」** ⇒ **如实登记：ctrl 侧尚存一处旧名，归他线** |
| 3 | **上屏文案** | 「印索」 | **「印源」** | **今后正文写「印源」**；**只读实测**：`yinyuan/src/config/app-config.js` `name: '印源'`、`yinyuan/index.html` `<title>印源｜兆级玺印数字引擎</title>`、`HomePage.vue` `<h1>印源・兆级玺印数字引擎</h1>`；**`yinyuan/src` ＋ 根 HTML 内「印源」15 处 / 「印索」0 处** |
| 4 | **规范文件名** | `docs/yinsuo-web.spec.md` | **`docs/yinyuan-web.spec.md`** | **本单 `mv` 执行**；**同一文件继续为 v1.37**；**除本版登记外内容零改动** |
| 5 | **快照命名** | `docs/versions/yinsuo-web.spec.v<ver>.md` | **`docs/versions/yinyuan-web.spec.v<ver>.md`** | **自 v1.37 起新快照用新名**（**§0.4 第 9 条**）；**既有快照文件名一律不动（历史）** |
| 6 | **历史行**（旧名『印索』出现的既有行） | 「印索」 | **逐字保留、不逐字改写** | **留痕 ＋ 对照表**；**不得以「改名」为由回改任何历史行** |
| 7 | **工程根 / 端口** | `/Users/kevin/bistro/xiai` / 5164 | **不变 / 不变** | **`strictPort: true` 不变**；**§2.2 路由表仍 14 条** |

## 三、读法规则（只对「路径引用」生效；不改任何历史行）

- 本文件内以 **`yinsuo/...`** 起头的**现行有效路径引用**，**一律读作 `yinyuan/...`**（**可复跑判据**＝`ls -d /Users/kevin/bistro/xiai/yinsuo` ⇒ `No such file or directory`；`ls -d /Users/kevin/bistro/xiai/yinyuan` ⇒ 命中）。
- **历史行 / 快照式引文中的 `yinsuo`**（含 `docs/versions/yinsuo-web.spec.v*.md`、`docs/spec-increments/yinsuo-*.md` **之文件名**）**逐字保留、不改写** —— **文件名属历史对象**。
- **`shu` 的读法规则（§0.2 v1.29 / v1.30 注）不受影响**，**两条读法规则并存**。
- **产品名 / 上屏文案**：今后正文写「印源」；旧名既有行逐字保留。

## 四、纪律与边界（本单自证）

- **产物先行**：先写本增量件 → 再存快照（`cmp` 验）→ 再 `mv` 主文件 → 最后改主文件；**每段写完即落盘**。
- **历史行不动**：主文件改动**只含「新增行」＋「表头`版本`行前插 v1.37 段」**；`diff` 的 `<` 侧**只许**下列**已声明**两处 —— **(a) 表头「版本」行**（前插 v1.37 段、**v1.36 及其后全部原文逐字保留**）、**(b) 页脚末行**（**原末行无换行符；追加 v1.37 横幅后该行获得换行符，字节上体现为「改行」**，**其文字一字未改**）。
- **不得触碰**：`xiai/src/**`、`xiai/server/**`、`xiai/yinyuan/**`、`xiai/ctrl/**`、`docs/xiai.spec.md`（**他线文件与实现一律只读、零写入**）；**未起服务 / 未占端口 / 未复测**。
- **§11.3 挂账 GB-1 / GB-2 不动**；**§11.2 待决项统计仍 20 条**（**W 行另计**）。

## 五、跨仓同源登记（登记事实，不越界）

- **`ctrl/PORTS.md`**：**尚无 `yinyuan` 字样**（**只读实测，核验时点 2026-09-24 12:43（CST）：`grep -c yinyuan ctrl/PORTS.md` ⇒ 0；其版本行仍 v1.16**）⇒ **该同源登记须由 ctrl 线执行**，**本文件不代写**。
- **`ctrl/index.js`**：**已含改名登记与 `cwd` 新值**（第 58–60 行）⇒ **ctrl 侧改名登记部分已落地**；**仍有第 176 行 `label`「印索 shu」旧名**（**归他线**）。
- **`docs/xiai.spec.md`（玺爱线）**：**v1.32 侧已同步加跳站交叉注**（**只引编号与语义、不复制条文**）⇒ **跳站注双侧对齐**（**规范 §7.9-6**）。**本单未读、未改该文件**。
