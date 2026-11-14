# seal / face 层口径重定 —— base face / side face / seal 级图片

- 状态：**已裁定**（Kevin 2026-11-14 CST，三点口径原文见第一节；clarify 超时未细选，按推荐组合落地：**零迁移 ＋ 展示&上传 ＋ 三选一**，一句话可改）
- 性质：**非规范**，供实现 / 规范 / 质检单作唯一口径真源。规范由 Jing 落 `docs/xiai.spec.md`。

## 一、口径（Kevin 原话）

1. 每个 seal 有若干 face，其中最主要的叫 **base face**：它的图是整枚 seal 的**封面图**，且在 seal 页面的各个 face 的**显示次序中排最前**。
2. 除 base face 之外的其它 face 叫 **side face**（**不叫 edge**）；最常见是黑白影像或其它类型影像，而不是 base face 那样的红白相间。
3. seal 的图片一般要指定属于哪个 face；**特殊情况**：无法确认属于哪个 face、而属于整只 seal 整体的，**直接挂在 seal 下**。页面显示时，**无 face 挂载的图片排在最后**。

## 二、数据实况（派单前实测，勿再猜）

| 项 | 读数 |
|---|---|
| base face 覆盖 | `is_primary=true` **1044 枚** = 有面章数 1044 ⇒ **每章恰一枚、零例外** |
| 面结构 | FACE 1573 / EDGE 170（总 1743）；515 章单面、**529 章双面**、无 3 面以上 |
| 边款现状 | 170 行走 `kind='EDGE'`，分布在 170 枚章 |
| seal 级图片现状 | `xiai_images` 6446 行，被面引用 1643 个；**未被任何面引用且带真实章编号的 23 张**（另有 4780 行 `stamp_id` 以 `imp-` 开头的导入占位，未归属，不属本口径） |
| 客户端读面 | `xiai_images` **已在 `CLOUD_COLLECTIONS`** ⇒ 章级图片展示不需新增服务端读 op |

## 三、术语（上屏只有两个词，不带 edge）

| 上屏 | 判定 |
|---|---|
| **base face** | `is_primary === true`（每章恰一枚） |
| **side face** | 该章其余**所有**面 —— **不论** DB 内 `kind` 是 `FACE` 还是 `EDGE` |
| **整枚印章圖**（区块名） | `xiai_images` 行 `stamp_id` 指向该章、且**未被任何面行**的 `face_image_id` / `edge_image_ids` 引用 |

- **上屏不得出现「邊款」「edge」字样**（现有 95 处文案 + 45 处内部值引用中，凡属**上屏文案**的一律改；**`kind` 的数据值 `FACE` / `EDGE` 保持不动**，零迁移、零数据改写）。
- `kind` 从此只是**内部实现细节**：不参与上屏分类、不得作为面向用户的分类项（筛选、标签、弹窗选项）。
- 既有「含邊款」类标签改为「多面」或按第二节的 base/side 语义改写，不保留 edge 词。

## 四、显示次序（详情页）

1. **base face 块** —— 最前（且卡片 `SealCard` 封面图取 base face 的影像，沿用 `is_primary` 优先、无标记时 `face_no` 最小的既有兼容口径）。
2. **side face 块** —— 随后，次序按 `face_no` 升序（同章稳定）。
3. **整枚印章圖 区块** —— **最后**，独立区块（无面归属影像），排在任何面块之后。

`faces` 数组的排序实现必须**在视图层或服务层单点完成**（一处排序），不得在多处各排一遍。

## 五、上传（同一入口三选一）

现有 `AddSealFaceDialog` 的「印面 / 邊款」二选一改为三选一：

| 选项 | 服务端行为 | 约束 |
|---|---|---|
| **base face** | `addSealFace`（`kind='FACE'`）→ 该面 `is_primary:true` | **仅当本章尚无任何 FACE 面时可选**；本章已有 base ⇒ 该选项**禁用**并说明「本章已有主印面，請改選 side face」 |
| **side face** | `addSealFace`（`kind='FACE'`）→ `is_primary:false` | 无额外约束 |
| **整枚印章圖** | **不建面**：只调 `registerFaceImage`（`seal_id` 指向章）建影像行，**不被任何面引用** | `face_count` 不变；本章必然已有 ≥1 面（零面章不应只挂整章图） |

- `addSealFace` 的**服务端载荷仍恰 7 键、`kind` 仍只接受 `FACE` / `EDGE`**（不变）；前端**不再暴露 `EDGE`**（用户选 side face ⇒ 上传 `kind='FACE'`）。`EDGE` 分支保留作向后兼容，不进 UI。
- 不提供「切换 base face」能力（本轮不做）：本章已有 base 时只能加 side face；改主印面仍走既有管理员回填口径（`repairPrimaryFace`）。
- 「整枚印章圖」上传复用既有管道（`runUploadPipeline` → TIFF → `registerFaceImage`）；`registerFaceImage` 的 `face_id` 必填门沿用既有占位串（该 op 只过必填门、行体不含面引用，已实测核实）。

## 六、不做的事（显式排除）

- **不迁移** `kind='EDGE'` 的 170 行（零数据改写）。
- **不新增**服务端 op（整章图复用 `registerFaceImage`；`addSealFace` 契约不变）。
- **不提供** base face 切换、side face 删除的 UI（删除沿用既有「刪除印面影像」与 `deleteSeal` 路径）。
- **不动** 卡片 DTO 14 键、`PUBLIC_OPS` 4、`face_count >= 1` 过滤、`q` 12 字段表。

## 七、验收

1. 详情页 `AACQF`（1 面）：面块显示 `base face` 徽标；无「邊款」字样。
2. 取一枚 2 面章（如 `AACFJ`）：首个面块 `base face`、第二个 `side face`，且 base 在前。
3. 上传三选一：① 已有 base 的章选 base ⇒ 选项禁用并给出说明；② 选 side ⇒ 新建 `is_primary:false` 面、`face_count +1`；③ 选整枚印章圖 ⇒ **面行数不变**、`face_count` 不变、详情页最后区块出现该图。
4. 全站上屏文案 grep：`邊款` / `edge` 在 `src/views/**`、`src/components/**` 的用户可见串中命中 **0**（内部常量与注释不算）。
5. 首页卡片封面仍取 base face（`is_primary` 优先）。
6. 既有套件全绿（除已知基线红），`data-admin-action` 集合不变。
