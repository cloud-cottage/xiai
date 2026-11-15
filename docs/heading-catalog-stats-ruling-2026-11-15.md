# 首页页头「库存储量」三计数 · 裁定件

- 提出：Kevin（2026-11-15）
- 落地：Zang（子代理额度受限，本轮由 Zang 直接实现）
- 关联：`docs/xiai.spec.md` §3.81（公开只读面）；本件为**增量契约**，规范正文由 Jing 合并

## 一 · 需求（原话）

> 网页文案：**璽印匯類** 的后面加上库存总 seal 量和 face 量和图像总量。文案形如
> 【玺印 xxxx 枚】【印面 xxxx 个】【图像 xxxx 张】（均为繁体）

## 二 · 口径（判据，逐条可判）

1. **位置**：`璽印匯類` 标题 ＋ 说明文字**之下**，同一头部块内；独占一行。
2. **形态**：三段并列文本，繁体、方头括号（【】）、千分位、量词逐字：
   `【璽印 N 枚】【印面 N 個】【圖像 N 張】`（`枚`／`個`／`張` 不得混用）。
3. **数值语义 ＝ 库存储量**（集合总行数）：
   - `seals` → `xiai_seals` 行数
   - `faces` → `xiai_faces` 行数
   - `images` → `xiai_images` 行数
4. **与列表页「共 N 枚」不同尺**：后者是 `listSealCards.total`（只算有面章）。
   两处数字**允许不同**，页头一行以「庫存」语义自证；不得为「看起来一致」而改写任一口径。
5. **失败不上屏 0**：读取失败 ⇒ 整行**不渲染**（不上屏「0 枚」冒充；不得回退本机演示数）。
6. **零写**：三计数只发 `count()`，恒零写。
7. **匿名可读**：无需登录即可看见（首页公开面）。

## 三 · 服务端契约

新公开只读 op `catalogStats`（`lib/sealCards.js`；`PUBLIC_OPS` **4 → 5**）：

| 项 | 契约 |
|---|---|
| 载荷 | **封闭**：不接受任何参数；带任意键 ⇒ `INVALID_VALUE` ＋ **零读** |
| 回包 | **恰 4 键** `{ok, seals, faces, images}`，三值为非负整数 |
| 读法 | 三个 `count()` 无因果依赖 ⇒ **并行** |
| 失败 | 异常 ⇒ 由信封层回 `STORAGE_UNAVAILABLE`（内部故障不伪装 `FORBIDDEN`） |

`index.js::handlePublic` **零改写、零补键** ⇒ 逐字透传 op 回包（既有口径不变）。

## 四 · 前端契约

- 服务层：`src/services/sealCards.js::catalogStats()` —— `{action:'public', op:'catalogStats', payload:{}}`；
  失败回 `null`（**不抛、不编造 0**）。
- 视图：`src/views/SquareView.vue` —— `stats` 为 `null` ⇒ `statsItems` 空数组 ⇒ `v-if` 整行不渲染；
  挂载时读一次，`dataVersion` 变化（上传/清除本机资料后）重读。
- 钩子：`data-catalog-stats`（供取证与自检锚定）。

## 五 · 验收

| 编号 | 判据 |
|---|---|
| A1 | `PUBLIC_OPS` 恰 5 成员，含 `catalogStats`，皆函数 |
| A2 | `catalogStats({})` 回包恰 4 键；三计数＝集合行数（含零面章） |
| A3 | `catalogStats({limit:1})` ⇒ `INVALID_VALUE` ＋ 零读 |
| A4 | 全程零写 |
| A5 | 生产首页渲染 `【璽印 N 枚】【印面 N 個】【圖像 N 張】`，N 与库内一致 |
