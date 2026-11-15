# 交接文档 · 印面标识 `fid` 改为 8 位 base-22 字母（xiai → feicui）

- 交接方：xiai（玺爱）· Zang
- 接收方：feicui（斐萃）影子库/同步单
- 日期：2026-11-15
- xiai 侧状态：**已上线并完成全量数据迁移**（本文所有数字均为生产实测）
- 相关文件（xiai 仓）：`src/utils/codeId.js`、`cloudfunctions/xiai-user-token/lib/codeId.js`、
  `cloudfunctions/xiai-admin-token/lib/codeId.js`、`docs/spec-increments/face-id-base22-otp-v1.123.md`

---

## 0 · 一句话结论

印面标识 `fid` 由「**十进制 8 位零填充**」改为「**8 位 base-22 定长字母码**」，
字母表与印章 `sid` **完全同一张 22 字母表**；`fid` 仍由 `face_no` 派生；
xiai 已把全库 **6,524 个印面**的 `fid` 全量重写，**旧 8 位数字一律作废、不保留兼容映射**（Kevin 裁定）。

feicui 侧**必须先修一处字母表缺陷**（见 §4），否则双方 fid 从序号 21 起就不一致。

---

## 1 · 权威口径（唯一真源）

| 项 | 值 |
|---|---|
| 字母表 | `ABCDEFGHJKMNPQRSTVWXYZ`（**恰 22 个**；**不含 `I` / `L` / `O` / `U`**） |
| 定长 | **8** |
| 高位填充 | `A`（与 `sid` 同法） |
| 偏移 | **无偏移**：`code = base22(n)`，`n ≥ 1` |
| 已知向量 | `1 → AAAAAAAB`、`22 → AAAAAABA`、`1399 → AAAAACXQ`、`22⁸−1 → ZZZZZZZZ` |
| 码空间 | `22⁸ = 54,875,873,536` |
| 可编码号域 | `[1, 54,875,873,535]`（越界 ⇒ 结构化拒绝，不静默回绕） |
| 派生源 | **仍为 `face_no`**（整数序号），不另立号域 |
| 形态门 | `^[A-HJ-KM-NP-TV-Z]{8}$` |

计算方式（逐位、从低位起拼到高位）：

```text
rest = n; out = ''
重复 8 次： out = ALPHABET[rest % 22] + out; rest = rest // 22
```

参考实现（xiai，CJS/ESM 双端可载，**仓内三副本逐字节相同**）：

- `encodeFaceCode(no)` → `{ok, code}` / `{ok:false, reason, message}`
- `decodeFaceCode(code)` → `{ok, no}` / `{ok:false, ...}`
- 常量：`CODE_ALPHABET`、`CODE_ALPHABET_SIZE`(22)、`FID_LENGTH`(8)、`FID_MAX`(54875873536)、
  `FID_LAST`、`FID_PATTERN`

---

## 2 · xiai 侧已完成的事实（供对照，不需要重做）

| 项 | 实测结果 |
|---|---|
| 三副本同步 | `src/utils/codeId.js` = `cloudfunctions/xiai-user-token/lib/codeId.js` = `cloudfunctions/xiai-admin-token/lib/codeId.js`（字节数 10,114，`cmp` 逐字节相同） |
| 数据迁移 | 全库 **6,524 个印面** `fid` 全量重写：**0 失败**、**0 行残留旧形态** |
| 旧码 | 8 位纯数字**作废且无映射表**（Kevin 裁定：全量重编、旧码作废） |
| 编码分型 | 改为按**长度**：5 位字母 ⇒ `sid`（印章）；8 位字母 ⇒ `fid`（印面）。**不再按首字符是否数字分型** |
| 首页搜索 | 数字 OTP 由 8 格改 **9 格＝印人号**（CARD 人物号，跳 `/persons/<9 位>`）；字母 OTP 5 格（印章码）不变 |
| 自检 | `verify-code-id` 37/0（三副本 cmp、已知向量、双射抽样）、`verify-add-seal-face` 44/44、`verify-face-layer` 69/69、`verify-direct-write` 86/86、`verify-migrate-code-numbers` 42/0 |

---

## 3 · 数据契约（feicui 影子库 / 导出必须遵守）

`xiai_faces` 行上与编号相关的字段：

| 字段 | 形态 | 说明 |
|---|---|---|
| `fid` | 8 位 base-22 字母 | **识别编码**，对外展示与检索用；`= encodeFaceCode(face_no)` |
| `face_no` | 正整数 | 序号（发号器 `issueCodeNumberAvoiding('face')`），**不是**展示码 |
| `face_id` / `_id` | `fc-<stamp_id>-f<n>` | 面行主键（内部），**不是** fid |
| `stamp_id` | 5 位字母 | 所属印章 `sid` |

- **不得**把 `face_no` 直接补零当编号（这正是被废止的旧口径）。
- **不得**在 feicui 侧另建第二张字母表或第二套 base-22 实现；口径以本文 §1 为准。

---

## 4 ⚠️ · feicui 现有实现的不一致（**必须先修**）

`server/app/shadow/filemap.py`：

```python
SID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"     # ← 实际 24 个字母：多了 L、U
SID_CAPACITY = len(SID_ALPHABET) ** SID_WIDTH  # 注释写 22^5，实际按 24 算
FID_CAPACITY = len(SID_ALPHABET) ** FID_WIDTH  # 注释写 22^8，实际按 24 算
```

- 该字表**缺 `I`、`O`，但含 `L`、`U`** ⇒ 基数 24，与权威基数 22 不同。
- 后果：**从序号 21 起编码分叉**，序号越大差得越远：

| `face_no` | feicui 现实现 | xiai 权威 | 一致？ |
|---|---|---|---|
| 1 | `AAAAAAAB` | `AAAAAAAB` | ✅ |
| 21 | `AAAAAAAX` | `AAAAAAAZ` | ❌ |
| 22 | `AAAAAAAY` | `AAAAAABA` | ❌ |
| 23 | `AAAAAAAZ` | `AAAAAABB` | ❌ |
| 30 | `AAAAAABG` | `AAAAAABJ` | ❌ |
| 1399 | `AAAAACLH` | `AAAAACXQ` | ❌ |

- 另注意 `_RE_FID = ^[%s]{8}$ % SID_ALPHABET` 会**接受含 `L`/`U` 的非法码**，须同步收紧为
  `^[A-HJ-KM-NP-TV-Z]{8}$`。

---

## 5 · feicui 侧交接清单（逐条可勾）

1. [ ] `server/app/shadow/filemap.py::SID_ALPHABET` 改为 `"ABCDEFGHJKMNPQRSTVWXYZ"`（22 字母、无 I/L/O/U）。
2. [ ] 同步修正 `SID_CAPACITY` / `FID_CAPACITY` 的**实际基数**（22），使注释与实现一致；
       `SID_CAPACITY = 5,153,632`、`FID_CAPACITY = 54,875,873,536`。
3. [ ] `_RE_SID` / `_RE_FID` 形态门收紧为本文字母表（拒 `I/L/O/U`）。
4. [ ] `server/app/shadow/mapper.py` 里 `"fid": None  # 本地无八位 fid` 改为
       **按 `face_no` 计算** `fid`（同一 base-22 实现），不得留空、不得填旧十进制。
5. [ ] 存量文件名中的 **8 位纯数字 ID 段**：按既有规则判为「作废的 face 旧形态」
       ⇒ 进待改名清单（`id_kind=None`），**不要**把它当 `fid` 原样保留。
6. [ ] 改名规则不变（§3.1.1）：新名 = `fid`(8) + `_` + 原文件名主干**一字不删**；
       存量改名**不做任何字符替换**（含全角符号）。
7. [ ] **交叉比对（必须出数）**：随机抽 ≥50 个面，比对 feicui 计算的 `fid` 与 xiai `xiai_faces.fid`
       是否逐字相等；给出「抽样数 / 全等数 / 不等样例」三行读数。
8. [ ] 比对发现不等 ⇒ 停止改名批次，先回报（不要自行"对齐"成其中一方）。

---

## 6 · 验收判据（与 xiai `AC-820〜824` 对齐）

| 编号 | 判据 |
|---|---|
| H-1 | `encode(1) = AAAAAAAB`、`encode(22) = AAAAAABA`、`encode(1399) = AAAAACXQ`、`encode(22⁸−1) = ZZZZZZZZ` |
| H-2 | 字母表恰 22 个且等于 `ABCDEFGHJKMNPQRSTVWXYZ`；`22⁵ = 5,153,632`、`22⁸ = 54,875,873,536` |
| H-3 | 双射：抽样 `decode(encode(n)) == n`；越界（0 / 负数 / 非整数 / `FID_MAX`）⇒ 结构化拒绝 |
| H-4 | 形态门只认 8 位合法字母：数字串、7 位、9 位、含 `I/L/O/U` ⇒ 拒 |
| H-5 | 交叉比对：feicui 与 xiai 的 `fid` 逐字全等（§5.7） |

---

## 7 · 边界与纪律（别踩）

- **不建第二张字母表**：feicui 若需实现，只允许与 §1 逐字一致（建议直接照抄 22 字母串 + 8 位循环）。
- **不要保留十进制兼容分支**：旧 8 位数字编码已作废（Kevin 裁定），任何"两种都认"的兼容代码都会造成长期分叉。
- **不要把 4 位旧前缀（`0001_`）当任何码**：它只是历史序号，进待改名清单。
- **`face_no` 与 `fid` 是两回事**：前者发号器序号（决定 fid），后者才是对外编号；不要互相覆盖。
- 改完请回报 §5.7 的比对读数；未出数视为未交付。

---

## 8 · 参考路径

| 用途 | 路径 |
|---|---|
| 权威实现（三副本，逐字节相同） | `xiai/src/utils/codeId.js`、`xiai/cloudfunctions/xiai-user-token/lib/codeId.js`、`xiai/cloudfunctions/xiai-admin-token/lib/codeId.js` |
| 口径增量（含验收条目） | `xiai/docs/spec-increments/face-id-base22-otp-v1.123.md` |
| 自检（可照抄判据） | `xiai/scripts/verify-code-id.mjs`、`scripts/verify-migrate-code-numbers.mjs`、`scripts/verify-add-seal-face.mjs` |
| feicui 待修文件 | `feicui/server/app/shadow/filemap.py`、`feicui/server/app/shadow/mapper.py` |
| 数据 | CloudBase env `liwu-cny1313-d1gb2fukyb7cb19bb`，集合 `xiai_faces`（`fid` / `face_no` / `face_id` / `stamp_id`） |
