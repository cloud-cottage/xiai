# P0-1 索引操作清单（xiai · CloudBase）

- 环境：**`liwu-cny1313-d1gb2fukyb7cb19bb`**（控制台显示名 `liwu-cny1313`）
- 入口：云开发控制台 → 数据库 → 选集合 → **索引管理** → 新建索引
- 原则：**只增不删**；先建读多写少的；唯一索引**先查重**（有重复值会建失败）
- 字段名以本件为准（**大小写敏感**）：`faceId`（驼峰）≠ `face_id`；`user_id` ≠ `uid`

> 更正说明：`docs/xiai-user-token-optimization-plan-2026-11-15.md` 首版的索引表把勘误面写成 `face_id` / `uid`，本件已按现盘代码核正，**以本件为准**。

---

## 一、建索引前的准备（1 分钟）

1. 确认环境是 `liwu-cny1313-d1gb2fukyb7cb19bb`（右上角环境切换）。
2. 打开「数据库 → 索引管理」，确认**目前只有 `_id` 默认索引**（若已有同名索引就跳过该条）。

## 二、唯一索引查重（只对下面标 🔒 的三条做）

控制台 → 数据库 → 对应集合 → **数据查询 / 聚合**，黏贴执行：

**① `xiai_images` · `sha256`**
```json
[{"$group":{"_id":"$sha256","n":{"$sum":1}}},{"$match":{"n":{"$gt":1}}},{"$limit":5}]
```
**② `xiai_correction_summaries` · (`faceId`,`field`,`value`)**
```json
[{"$group":{"_id":{"f":"$faceId","k":"$field","v":"$value"},"n":{"$sum":1}}},{"$match":{"n":{"$gt":1}}},{"$limit":5}]
```
**③ `xiai_persons` · `card_id`**
```json
[{"$group":{"_id":"$card_id","n":{"$sum":1}}},{"$match":{"n":{"$gt":1}}},{"$limit":5}]
```
- 返回**空** ⇒ 直接建唯一索引。
- 返回有重复 ⇒ **先不建唯一索引**，改建成**普通索引**（非唯一），把重复行贴给我处理。

---

## 三、索引清单（按优先级建）

### 第一批：首页 / 详情热路径（最高价值）

| # | 集合 | 索引字段（顺序不可换） | 唯一 | 用途 |
|---|---|---|---|---|
| 1 | `xiai_seals` | `view_count` ↓, `created_at` ↓, `stamp_id` ↓ | 否 | 首页热度排序三键（`listSealCards`） |
| 2 | `xiai_seals` | `stamp_id` ↑ | 否 | 详情页按章号取 |
| 3 | `xiai_faces` | `stamp_id` ↑, `kind` ↑ | 否 | 按章取面（10 处） |
| 4 | `xiai_images` | `stamp_id` ↑ | 否 | 整章图 / 面图读 |

### 第二批：影像与挂书

| # | 集合 | 索引字段 | 唯一 | 用途 |
|---|---|---|---|---|
| 5 🔒 | `xiai_images` | `sha256` ↑ | **是** | 内容寻址（4 处） |
| 6 | `xiai_images` | `book_id` ↑ | 否 | 印谱归属（新） |
| 7 | `xiai_faces` | `face_no` ↑ | 否 | 发号查重 |

### 第三批：勘误面（刚上线的三页签直接受益）

| # | 集合 | 索引字段 | 唯一 | 用途 |
|---|---|---|---|---|
| 8 | `xiai_corrections` | `status` ↑, `created_at` ↓ | 否 | 管理员待審/已採納/已駁回三页签 |
| 9 | `xiai_corrections` | `user_id` ↑, `created_at` ↓ | 否 | 我的勘误记录 |
| 10 | `xiai_corrections` | `faceId` ↑, `field` ↑, `value` ↑ | 否 | 同值查重（提交前置） |
| 11 🔒 | `xiai_correction_summaries` | `faceId` ↑, `field` ↑, `value` ↑ | **是** | 值级摘要单行 |
| 12 | `xiai_endorsements` | `faceId` ↑, `field` ↑ | 否 | 采信查重 |

### 第四批：印人 / 印谱 / 积分 / 导入

| # | 集合 | 索引字段 | 唯一 | 用途 |
|---|---|---|---|---|
| 13 🔒 | `xiai_persons` | `card_id` ↑ | **是** | 作者引用（CARD 号） |
| 14 | `xiai_persons` | `id` ↑ | 否 | 印人主键读 |
| 15 | `xiai_persons` | `code` ↑ | 否 | PR 号读 |
| 16 🔒 | `xiai_books` | `id` ↑ | **是** | 印谱写幂等查重 |
| 17 | `xiai_balances` | `uid` ↑ | 否 | 积分余额 |
| 18 | `xiai_points_flow` | `uid` ↑, `created_at` ↓ | 否 | 积分流水 |
| 19 | `xiai_person_imports` | `batch_id` ↑ | 否 | 导入批读面 |
| 20 | `xiai_seal_imports` | `batch_id` ↑ | 否 | 同上 |
| 21 | `xiai_item_imports` | `batch_id` ↑ | 否 | 同上 |
| 22 | `xiai_person_proposals` | `dedupe_key` ↑ | 否 | 提案去重 |

---

## 四、建完之后怎么验（不用改代码）

1. **控制台**：每条索引状态显示「已生效」（大集合首次建可能要几分钟，期间写入不受影响）。
2. **函数日志**：云开发控制台 → 云函数 → `xiai-user-token` → 日志，筛 `"event":"op.done"`，看 `public:listSealCards` 的 `durationMs`：
   - 索引生效前后各取 10 条对比，中位数应下降；
   - 若仍有 `"event":"op.slow"`（>3000ms）持续出现，把对应 `op` 名发我，我按那个 op 继续优化。
3. **页面**：首页应仍是「已載入 48 / 共 1045 枚」，翻页正常 —— 索引只影响快慢，不改结果。

## 五、注意事项

- **复合索引字段顺序不能换**：等值字段在前、排序字段在后（第 1 条必须是 `view_count, created_at, stamp_id` 这个顺序，否则首页排序用不上它）。
- **不要给 `_id` 建索引**（平台默认已有）。
- **唯一索引**建失败几乎都是因为已有重复值 —— 按上面第二节先查重。
- 每条索引都会略增**写入成本**；本库读远多于写，值得。
- 建索引期间**不要同时跑批量导入**，避免把索引重建拖慢。
