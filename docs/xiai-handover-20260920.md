# 玺爱（xiai）—— 本线交接单（2026-09-20 16:3x）

- 出单人：**Zang**（本会话线）｜依据：clarify 表单超时未填 ⇒ 按推荐项推进（**本线停发写 `xiai/**` 的实现单**），一并标注「**一句话可改**」
- 用途：把本线已验收成果、已知缺陷、失效证据与剩余待办，整份交给**另一条会话线**或 Kevin 直接使用

---

## 1. 为什么要交接：并发线已证实

| 证据（磁盘实测） | 内容 |
| --- | --- |
| `ctrl/index.js` | md5 `512d294533042ca054b45a5dd3883b44` → `d488f9cde7de65853b7f6de5a6e4010b`，**新增「玺爱 5163」服务条目**（本线的 `group: 'xiai'` 改名仍在 42 / 54 / 71 行存活） |
| `ctrl/logs/xiai.log` | **15:47:26** ctrl 面板拉起 `xiai@0.1.0 dev` ⇒ 5163 是**面板托管服务**（本线 15:5x 的「人类手起」归因**有误，此处更正**） |
| `src/data/db.js` / `seed.js` / `services/auth.js` | 均 **16:05** 被写（341 / 471 / 69 行；含 `ADMIN_PHONE` 常量与「启动时就地纠正 role」）—— 在本线全部写者窗口之外（本线最后写者 K-FIX 收于 15:35） |
| `xiai.spec.md` | **16:15 升 v1.3**（非本线派单）：口径 A＝唯一管理员手机号 `16601061656` + 启动时老库就地纠正；口径 B＝新增第六项能力「上传印章」；**形态变更＝移除 `/admin`（路由 7→6）、菜单 5→4、`AdminView` 退役**；AC 27→37 |
| `yinsuo-web.spec.md` | 15:43 / 15:47 / 15:56 连续升至 **v1.31** |

**纪律动作**：两条线写同一批文件会互相作废 ⇒ 本线**停止派发写 `xiai/**` 的实现单**，只保留只读复核与登记。

## 2. 本线已交付且经 Zang 独立复核的资产（可用，不必重做）

| 单 | 交付物 | 复核真值 |
| --- | --- | --- |
| K-INFRA | `ctrl/index.js` 的 `group` 三处改 `'xiai'`；印索冻结存档页移至 `xiai/yinsuo/index.legacy.html` | `node --check` exit 0；归档页 md5 `b8c6051a5fd19f4677c92c4e3c33052e` **未变**；字节差恰 `+3`（3 个 `shu`→`xiai`） |
| K-REMAIN | 7 个视图 + 业务闭环 + `README.md` + 自测脚本 | Zang 自己复跑 `npm run build` → `✓ built in 665ms`，7 个视图各自成 chunk |
| K-FIX | Z-1 枚举 `ACCEPTED` / Z-2 印面一等实体 / Z-3 边款图 ID 生效 | `corrections.js` 已是 `ACCEPTED` 且含旧值归一；`storage.js` 有 `faces` 键、`seals.js` 有 `getFaceById` 等；`SealDetailView.vue` 有边款区与缺号空态 |
| K-VARIANTS | `xiai/mockups/xiai/v1〜v3.html` + README | md5 `0b05de4d…` / `c5c5f47d…` / `2882bd87…`，各 602 行；Zang 自己 grep 外链 → **三版全 0 命中** |
| F-UI | 斐萃展示名【斐萃】+ 蓝绿宝石配色 + `BackendBanner.vue` 旧路径修正 | `title` 已是「斐萃｜印谱解析任务台」；`--bg:#0a1a1d` / `--accent:#2fd6a0` / `--accent-line:#43e6bd`；启动提示已改为 `xiai/feicui/server` + `./.venv/bin/python -m app.main` |
| J-REMAIN / J-SPECS | `xiai.spec.md` v1.1（§1〜§12，AC-27）；`ctrl/PORTS.md` v1.13；斐萃规范升 v1.5（V-1/V-2） | `FILL:` 占位 **0**；`PORTS.md` 的 `5163` 命中；`yinsuo-web.spec.md` 曾实升 v1.29（该文件随后被另一线推进到 v1.31） |

报告与证据目录：`/Users/kevin/bistro/xiai/qa-recheck/`（`kong-*` / `jing-*` / `neng-20260920/`）。

## 3. 已知缺陷（真实存在，与规范版本无关，**待修**）

| 编号 | 缺陷 | 证据 | 性质 |
| --- | --- | --- | --- |
| **D-1** | **AC-24 非文本对比不达标**：默认主题的 chip / tab 按钮轮廓 **2.85:1**、卡片描边 **2.96:1**，均低于 3:1 | Neng 报告 `qa-recheck/neng-20260920/report.md` + `contrast-ac24-3themes.json` | 视觉硬指标，**可判负** |
| **D-2** | **AC-27 槽位 token 跨用途复用**：`--slot-btn-primary-text` 被标签 / 徽章槽位复用 | 同上 | token 纪律，**可判负** |
| **D-3** | **实现与 v1.3 不符（时序缺口）**：路由仍含 `/admin`、`AdminView.vue` 仍在、`上传印章` 未实现 | `src/router/index.js` 第 36 行仍有 `/admin`；`grep uploadSeal` 零命中 | 规范前进、实现未跟 |
| **D-4** | **`ctrl/PORTS.md` v1.13 与实况漂移**：该行把玺爱标为「已登记 · **未落地**（面板托管未落地）」，而面板**已于 15:47:26 托管**（`ctrl/index.js` 有条目 + `ctrl/logs/xiai.log`） | 两处磁盘实测 | **口径漂移**，需按制度再升一版 |
| **D-5** | **`xiai/yinpu.db` 为 0 字节**（mtime 15:11），真库为 `xiai/feicui/yinpu.db`（647,168 B）。同名不同目录，**极易被误当「斐萃库被清空」的证据** | `ls -l` | 待清理（Zang 未动，需一句授权） |

## 4. 剩余待办（谁接谁做）

1. **按 v1.3 落地形态变更**：移除 `/admin` 路由（7→6）、左侧菜单 5→4、`AdminView` 退役，管理员编辑能力改为「普通用户页面内的管理员专属按钮」（广场多「上传印章」、详情页多「编辑固定属性」）。
2. **落地 v1.3 口径 B「上传印章」**：影像二进制走 IndexedDB、`localStorage` 只存元数据；防重与必填校验。
3. **落地 v1.3 口径 A**：唯一管理员手机号 `16601061656` 以常量形式定义在数据层，启动时就地纠正老库 role。（**16:05 的第三方改动已做了这一半**，需按 v1.3 逐条核。）
4. **修 D-1 / D-2**（视觉对比度与 token 槽位）。
5. **`ctrl/PORTS.md` 按 D-4 再升一版**（把玺爱行状态由「未落地」升为「已托管」，并登记 sid / group / directUrl）。
6. **质检需按 v1.3 重跑一轮**：现有 Neng 报告锁 v1.1（AC-01〜AC-27），其 25 条「已证实」在 `src/data/**` 于 16:05 被第三方改写后**效力已过期**，须按 v1.3（AC 37 条）复检。
7. **视觉基线未定**：三版变体 `xiai/mockups/xiai/v1〜v3.html` 待选；选定后按该目录 `README.md` 第 5 节的逐 token 替换清单落到 `src/styles/tokens.css`。
8. **斐萃副标题端口号**：本线裁定去掉界面外露的「端口 5195 · API 5196」（**一句话可改**），斐萃规范已登记为「已定、落地情形待核」。
9. **`xiai/web` 是否迁入 `xiai/yinsuo/`**（W-6，涉在跑 dev server 与面板登记，须单独一轮）。
10. **`/Users/kevin/bistro/shu/` 残留空壳**（两个空目录树）—— 清理须停相关进程后进行。

## 5. 失效基线登记（后续断言一律先重读真源）

| 对象 | 本线核过的旧值 | 现状 |
| --- | --- | --- |
| `ctrl/index.js` | md5 `512d294533042ca054b45a5dd3883b44` | 已失效 → `d488f9cde7de65853b7f6de5a6e4010b` |
| `xiai.spec.md` | v1.1 / AC 27 / md5 `64d4fd85…` | 已失效 → **v1.3 / AC 37** |
| `xiai/docs/yinsuo-web.spec.md` | v1.28 → 本线 jing 实升 v1.29 | 已被另一线推进至 **v1.31** |
| `xiai/feicui/docs/feicui.spec.md` | v1.4 | 已由本线 jing 升至 **v1.5** |

## 6. 本次交接的判据边界

- 本单**不改 `xiai/**` 任何文件**（`docs/xiai-plan.md` 除外，它是本线自己的拆解件）；**不 kill / 不重启任何进程**；**不占端口**。
- 上表 2 节「可用」仅指**本线已独立复核到「产物存在 + 构建绿 + 关键行为可复现」**这一层；**不等于按 v1.3 验收通过**——验收结论归质检角色，且须在 v1.3 上重跑。
- 第 3 节的 D-1 / D-2 是唯一**与规范版本无关**的判负项，无论谁接都应修。
