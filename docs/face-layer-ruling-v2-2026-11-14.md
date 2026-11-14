# 裁定补充（v2）：EDGE 并入 FACE ＋ 整章图删除 ＋ base face 可切换

- 状态：**已裁定**（Kevin 2026-11-14 CST，复答 **1B / 2C / 3B**）
- 性质：非规范。与 `docs/face-layer-ruling-2026-11-14.md` 并存，**本件取代其第五、六节中与下列三条冲突的部分**；其余条款（术语、次序、整章图定义、上传三选一）继续有效。
- 派单方：Zang。实现：Kong。规范：Jing。质检：Neng（串行）。

## 一、三条裁定

1. **1B**：`kind` 的 `FACE` / `EDGE` 两个数据值**合并为一种** —— 把现有 170 行 `EDGE` 迁移成 `FACE`，库内只剩 `FACE`。
2. **2C**：整枚印章圖（无面归属影像）＝**展示 ＋ 上传 ＋ 删除**（新增删除入口，二次确认）。
3. **3B**：base face **可切换** —— 新增「設為 base face」入口；仍保证**每章恰一枚**。

## 二、1B 的数据连带后果（必须先算清，实测量已核）

现库：`xiai_faces` 1743 行 ＝ `FACE` 1573 ＋ `EDGE` 170；有 `EDGE` 的章 170 枚。

迁移每行要做三件事（**不是只改 kind**）：

| 字段 | 现状（EDGE 行） | 迁移后（FACE 行） |
|---|---|---|
| `kind` | `EDGE` | `FACE` |
| `edge_image_ids` | `[img-…]`（恰 1 项） | `[]` |
| `face_image_id` | `null` | 原 `edge_image_ids[0]` |
| `is_primary` | 键不存在 | `false`（**绝不抢既有 base**） |

**`face_count` 必须逐章重算，不能盲目 +1**：该字段口径是「非 EDGE 面数」，迁移后口径等价于「FACE 面数」⇒ 受影响的 170 枚章由 1 变 2；但**必须按迁移后该章的 FACE 行数实算**（历史上可能存在零面章、或同章多枚 EDGE 的例外），并把结果写回章行（只写 `face_count` 一个键）。

**迁移后的不变量**：0 行 `EDGE`；每章 `is_primary=true` 仍恰一枚（170 枚章的原 base 不变，新并入的面为 `false`）；`fid` / `face_no` / 面行 id 一律不动。

**代码分支的处理分两批**（风险隔离）：
- 本批只做**数据迁移**。迁移后所有 `kind === 'EDGE'` 分支成为**死代码**（零行命中），保留无害。
- 删分支（`face_count` 的 EDGE 豁免、`edge_image_ids` 写入、标签映射、tilesplicer 的 EDGE 口径等约 45 处）列为**下一批**的独立清理单；本批不得顺手删，避免与迁移同时出问题时无法二分定位。

## 三、新 op「A：`migrateEdgeFaces`」（管理员面）

- 落 `ADMIN_OPS`（现盘 41 → 42）。管理员门第一行即判。
- 载荷封闭**恰 3 键** `{dry_run, limit, cursor}`：`dry_run` 缺省 `true`（非布林 ⇒ `INVALID_VALUE`）；`limit` 1〜500 缺省 200；`cursor` ＝ 上轮 `next_cursor`（**必须随载荷回传**，双向分页）。
- 窗口：`xiai_faces` 按 `_id` 升序、严格大于 `cursor`，只取 `kind === 'EDGE'` 的行。
- 写序（逐行）：① 记下原 `edge_image_ids` 首项 → ② 更新面行（`kind='FACE'`、`face_image_id`、`edge_image_ids: []`、`is_primary:false`）→ ③ 重算该章 `face_count` 写回章行。
- 回包恒**恰 7 键** `{ok, scanned, eligible, written, failed, samples, next_cursor}`：`written` 由**整窗读回**判定（不得由写调用 resolve 驱动）；`failed` 元素恰 2 键 `{_id, reason}`；`samples` ≤ 5 条、元素恰 3 键 `{row_id, seal_id, moved_image_id}`。
- **幂等**：无 `EDGE` 行 ⇒ `eligible 0`、`written 0`；重放不重复搬图（`edge_image_ids` 已空 ⇒ 不会二次搬）。
- **零新集合、零删行、`reason` 零新增字面值**。真写前必须 `dry_run` 并把读数交裁定人确认。

## 四、新 op「B：`deleteWholeSealImage`」（管理员面）

- 落 `ADMIN_OPS`（42 → 43）。
- 载荷封闭**恰 2 键** `{stamp_id, image_id}`。
- 判定（全部早于写）：影像行存在（不存在 ⇒ `INVALID_VALUE`「該影像不存在」）；行上 `stamp_id` 等于载荷 `stamp_id`（不符 ⇒ `INVALID_VALUE`，防跨章误删）；**该影像未被任何面行引用**（`face_image_id` 命中或任一 `edge_image_ids` 含它 ⇒ `INVALID_VALUE`「該影像已被印面引用，請改用印面級刪除」）。
- 写序：删影像行 → 尽力删对象（复用既有 `deleteImageObjectsOfRow` 单点）；对象删失败不阻断但计数如实。
- 回包恰 4 键 `{ok, image_id, deleted_rows, deleted_objects}`；失败恰 3 键。不写流水、不计费。

## 五、新 op「C：`setBaseFace`」（管理员面）

- 落 `ADMIN_OPS`（43 → 44）。
- 载荷封闭**恰 2 键** `{stamp_id, face_id}`。
- 判定：面行存在且属该章（否则 `INVALID_VALUE`）；该行 `kind` 必须是 `FACE`（迁移后恒成立；非 FACE ⇒ `INVALID_VALUE`）。
- 写序：读该章现有 base → 若就是目标面 ⇒ **零写**、回 `previous_base_face_id` 等于目标（幂等）；否则**先把旧 base 置 `false`、再把目标置 `true`**（两次写，失败则回滚旧 base 为 `true`，绝不留零 base 或多 base）。
- 回包恰 3 键 `{ok, face_id, previous_base_face_id}`；失败恰 3 键。
- 不写 `face_count`、不动 `face_no`、不删行。

## 六、前端

- **整枚印章圖 区块**：每张图加「刪除」（管理员专属条件渲染）。钩子 `data-action="delete-whole-seal-image"`、**不进 `[data-admin-action]` 族**。二次确认必须列明：影像编号、不可恢复、**若已被印面引用服务端会拒绝并保持原状**。成功后重取云端快照；失败原文上屏。
- **面块**：非 base 的 FACE 面块加「設為 base face」按钮（管理员专属）。钩子 `data-action="set-base-face"`，同样不进 `data-admin-action` 族。成功后重取快照并上屏提示「已切換主印面（封面圖已更新）」。目标已是 base ⇒ 按钮不渲染（避免无意义点按）。
- 两者沿用既有弹窗形态（`role="dialog"` ＋ `aria-label`）与一次性提交守卫；上屏文案一律繁体（`s2t(x) === x`）；`data-admin-action` 取值集合**仍恰 12 值**。

## 七、规范（Jing，v1.113）

入册：三条裁定；`kind` 值域收敛为单一 `FACE`（`EDGE` 仅作**历史值**登记，不得再被写入）；`migrateEdgeFaces` / `deleteWholeSealImage` / `setBaseFace` 全契约；`face_count` 口径由「非 EDGE 面数」改为「FACE 面数」（等价，但表述要跟着改，用追加注承载）；两个新钩子不进 `data-admin-action` 族；AC 至少覆盖：迁移后 0 行 EDGE / 每章恰一枚 base / 重放幂等 / 搬图与 `face_count` 重算 / 未引用才能删 / 已引用拒删且保持原状 / 切 base 后恰一枚且幂等 / `data-admin-action` 仍 12。

## 八、验收（生产）

1. `migrateEdgeFaces` `dry_run` 读数：`eligible` 应 ≈ 170（逐章核算），samples 里的 `moved_image_id` 与面行原 `edge_image_ids[0]` 一致。
2. 真写后：`kind='EDGE'` 计数 **0**；`xiai_faces` 总数仍 1743（零删行）；170 枚受影响章 `face_count` 由 1 → 2 且这 170 枚章**各自仍恰一枚** `is_primary=true`。
3. 重放 `dry_run`：`eligible 0`（幂等）。
4. `deleteWholeSealImage`：删一张未被引用的整章图 ⇒ 行与对象都少 1；删一张已被面引用的 ⇒ `INVALID_VALUE` 且**行与对象均不变**。
5. `setBaseFace`：把某章第二面设为 base ⇒ 原 base 变 `false`、目标变 `true`、章内仍恰一枚；重复调用同参 ⇒ 零写且回包 `previous_base_face_id` ＝ 目标。
6. 干净浏览器打开受影响章 ⇒ 两个面块都显示、base 徽标只在一枚上、封面图取 base。
