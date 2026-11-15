# 裁定：CARD 人物新增繁体【姓】【名】两字段（xiai 专用辨识面）

- 状态：**已裁定**（Kevin 2026-11-15 CST）
- 性质：非规范。供 card-api / card 静态站 / xiai 三侧实现与质检作唯一口径真源。

## 〇、Kevin 原话

> CARD 的人物属性需要新增两个字段，分别代表繁体的【姓】和繁体的【名】，之前的字段简体的【姓】和【名】是用来在 jiapu 等其它项目中辨识人物的用途，繁体的这两个字段是为 xiai 项目辨识任务的用途。

## 一、字段定义

| 新字段 | 类型 | 语义 | 消费方 |
|---|---|---|---|
| `family_name_cht` | 字符串 | **繁体【姓】** | **xiai 唯一辨识/展示面** |
| `given_name_cht` | 字符串 | **繁体【名】** | **xiai 唯一辨识/展示面** |

沿用仓内既有后缀族（`_chs` ＝简体，如 `native_place_chs` / `biography_chs`），对称取 **`_cht`**（繁体）。
（若你更想要 `_trad`，改一处常量即可，属一句话可改。）

**既有字段不变、语义收窄**：
- `family_name` / `given_name` ＝ **简体标识面**，供 jiapu 等其它项目辨识人物使用；
- 它们**今后可能被其它项目写入简体值**，因此 **xiai 不得再依赖这两个字段做辨识或展示**。

## 二、现状实测（2026-11-15）

- `card_persons` 574 行；`family_name` / `given_name` **无缺失**（0 行缺字段）。
- 用 xiai 的 `toTraditionalText` 逐行比对：**仅 1 行**会变（`100000141 胡䦆 → 胡钁`），其余 573 行本来就是繁体。
  ⇒ 现有数据**事实上已是繁体**，但**没有语义保证**（其它项目随时可写简体进去）。本次新增字段就是把这个保证落到字段上。

## 三、写面（card-api）

1. `WRITABLE_FIELDS` 追加入参：`family_name_cht` / `given_name_cht`（经 `STRING_FIELDS` 加入，与 `native_place_chs` 同族）。
2. **空值不写**：传 `''` / `null` / 纯空白 ⇒ 视为「不改动」，绝不冲掉已有值（沿用既有 STRING_FIELDS 规则）。
3. `updatePersonFields` 与 `upsertPerson` 两条写路径都要能写这两个字段（`upsertPerson` 走 `UPSERT_WRITABLE_FIELDS` 继承）。

## 四、回填（一次性，可重跑）

- 对全部 574 行：`family_name_cht := toTraditionalText(family_name)`、`given_name_cht := toTraditionalText(given_name)`；
- 转换器**复用 xiai 的 `src/utils/traditional.js::toTraditionalText`**（全站同一张表，禁第二套转换）；
- 回填走 `card-api::updatePersonFields`（带 `source='backfill-cht'`），**dry-run 先出读数**（将写行数 / 会变的行数 / 样例），再真写；
- 幂等：重跑时值相同 ⇒ 不产生变更（`changed: []`）。

## 五、读面

### 5.1 CARD 静态索引

`card/scripts/refresh-index.mjs` 产出的 `person-index.json`（瘦）与 `person-index-full.json`（全）**必须包含** `family_name_cht` / `given_name_cht`；重生成后提交并部署静态站。

### 5.2 xiai

- **显示名与辨识**一律优先新字段：`family_name_cht + given_name_cht`；
- 回落链：`*_cht` → 既有 `family_name/given_name`（**仅为兼容尚未回填的行**，回填完成后不得再依赖）；
- 落点（唯一单点，禁第二套）：`src/data/db.js::personDisplayName`、`src/services/corrections.js::resolveAuthorDisplayName`、`cloudfunctions/xiai-user-token/lib/sealCards.js`（`listPersonCards` / `getPersonCard` / `suggestAuthors` 的姓名拼接与匹配文本）。
- `suggestAuthors` 的匹配文本须含新字段（作者检索不再依赖简体姓名字段）。

## 六、验收

1. `card-api` 两写路径都能写 `family_name_cht` / `given_name_cht`；未知键仍 `INVALID_FIELD`；空值不覆盖。
2. 回填后 574 行 `*_cht` 全非空；`100000141` 的 `given_name_cht = 胡钁` 而旧的 `given_name` 保持 `胡䦆`（证明两面独立）。
3. CARD 索引两份 JSON 均含新字段（字段数 10 → 12 / 12 → 14）。
4. xiai：名录、印章详情作者、作者选择器、`suggestAuthors` 均按新字段显示/匹配；把某行旧字段改成简体后，xiai 显示**不受影响**（这是本需求的根本目的）。
5. 既有套件全绿；`ADMIN_OPS` / `PUBLIC_OPS` / DTO 键面计数不变。
