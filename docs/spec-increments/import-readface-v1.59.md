# 增量件：讀面接雲（本機鏡像鍵 ↔ 雲集合鍵 單點翻譯）＋ 讀失敗不得靜默顯示 0 ＋ 包封透傳按 `op` 收窄（**v1.59**）

> **性質**：**本件為 `docs/xiai.spec.md` v1.59 的增量說明**（**只寫規範 / 口徑 / 判據；不含落地結論、不含驗收結論**）。
> **本件不是規範正本**；**判據正本 ＝ `docs/xiai.spec.md` §3.57 ＋ §10.57（`AC-511` 〜 `AC-519`）**。
> **時點戳 ＝ 2026-10-10（CST）**；**凡引現狀讀數一律帶來源標註與時點戳**。

## 0. 落位彙總（本版改了什麼）
- **表頭三處**（版本摘要行 ＋「最近修訂」行 ＋「依據 / 被引用輸入與時點 / 本次登記的基準版本」三行）。
- **新增 §3.57**（含 §3.57.1 〜 §3.57.8）。
- **新增 §10.57**（`AC-511` 〜 `AC-519`，共 9 條 ＋ 表下注 ＋ 計數留痕）。
- **§1.4 追溯碼（v1.59 追加）**、**§10.7 留痕（v1.59 更新）**、**§11 計數留痕（v1.59）**。
- **§12 本版行**、**頁腳橫幅（v1.59）與頁腳留痕（v1.59 追加）**。
- **第 0 步快照** ＝ `docs/versions/xiai.spec.v1.58.md`（`cp -p` ＋ `cmp` 逐字節一致；md5 `0cd4b824eb86125a209ab2eb22ae6c06`、8,033 行 / 3,593,254 B）。
- **本包只寫文檔**（規範本件 ＋ 本件）；**未碰 `src/**`、`cloudfunctions/**`、`scripts/**`、`ctrl/**`、路由表、`docs/xiai-plan.md`、`docs/yinyuan-web.spec.md` 一個字節**；未跑構建 / 測試、未起服務、未佔端口、未聯網、未做任何 git 寫操作。

## 1. 輸入（凍結口徑 A / B / C，逐條照登）
- **A（讀面接雲）**：**本機鏡像鍵 ↔ 雲集合鍵**兩鍵族只允許**一個翻譯點**（`src/data/db.js::readCollection` 入口）；映射表真源 ＝ `CLOUD_COLLECTIONS`（異名恰 5 條）；未登記鍵原樣返回 ⇒ 非接管集合行為不變；**禁止在各服務層分頭翻譯**。
- **B（讀失敗不得靜默顯示 0）**：兩個導入讀面（`listPendingPersonImportsForAdmin` / `listPendingSealImportsForAdmin`）在雲已配置且 `pending` / `failed` 且**零行** ⇒ `{ ok:false, reason, message }`（可讀降級文案）；**有本機鏡像行可列 ⇒ 照常返回**；未配置（`off`）⇒ 行為不變；**`reason` 不新增字面值**（轉發 `cloudBaseStatus().reason`）。
- **C（包封透傳按 `op` 收窄）**：遷移 op `migrateDynastyValues` 的 5 個回傳鍵（`dry_run` / `scanned` / `changed` / `samples` / `idempotent`）**只在 `op === 'migrateDynastyValues'` 時並入響應信封**；**其它任何 op 一律不透傳**；**`plan` 永不外泄**。

## 2. 已入庫提交（實體哈希；帶時點戳）
- **`31845fc`** ＝ `fix(xiai): 导入读面接云 —— 本机镜像键→云集合键单点翻译（570 行读不到的真因）`（**本單開工後由派單方落地**；开工时本单 HEAD 曾为 `896f003`，补提交其后落地）。改动面 4 文件 ＋127/−5：`src/data/db.js`（`CLOUD_KEY_OF_LOCAL` ＋ `cloudKeyOfLocal()` ＋ `withLocalOverlay(key, cloudRows, localKey = key)` ＋ `readCollection` 單點翻譯）／`src/services/persons.js`／`src/services/seals.js`（導入讀面降級）／`scripts/verify-person-model.mjs`（Z 段 9 條）。
- **`896f003`** ＝ `fix(xiai): 包封加性透传收窄到 migrateDynastyValues 这一个 op（Neng 终检 P1）`（**C 的落地**）。
- **`58640de`** ＝ `fix(xiai): corrections.js 三句拒绝文案的值域类数改为从真源 .length 派生（闭合该反模式最后一处）`。
- **派單方實測（帶來源與時點戳）**：**生產站管理頁「待審導入批次」修前顯示「印人導入 共 0 條 · 0 批」（2026-10-10 15:0x（CST）派單方實測）**；**十套件真實計數（120 / 44 / 124 / 143 / 84 / 60 / 54 / person-model（含 Z 段）/ 63 / 31）、`npm run build` exit 0**（來源 ＝ 提交 `31845fc` 的獨立複核記錄）。

## 3. A：讀面接雲（本機鏡像鍵 ↔ 雲集合鍵）
- **兩鍵族**：**本機鏡像鍵** ＝ `STORAGE_KEYS`（`src/data/storage.js`）的值；**雲集合鍵** ＝ `CLOUD_COLLECTIONS`（`src/data/cloudbase.js`）的鍵名（經 `CLOUD_COLLECTION_KEYS` 暴露）。
- **異名映射恰 5 條**：`corrections-public`↔`correctionsPublic`；`correction-summaries`↔`correctionSummaries`；`person-proposals`↔`personProposals`；`person-imports`↔`personImports`；`seal-imports`↔`sealImports`。**同名者直用**：`seals` / `faces` / `images` / `persons`。
- **單點翻譯**：翻譯點恰一處（`readCollection` 入口）；**翻譯後仍須是雲鍵才用**（否則視為未登記、原樣返回）。
- **雙鍵分工**：覆蓋層成員判據用雲集合鍵；讀本機鏡像 / 比種子指紋用本機鏡像鍵。
- **未登記鍵原樣返回 ⇒ 非接管集合（`users` / `corrections` / `points` / `photos` …）行為一字未變**。

## 4. B：讀失敗不得靜默顯示 0（兩個導入讀面）
- **口徑**：雲已配置 ＋ `pending` / `failed` ＋ **零行** ⇒ `{ ok:false, reason, message }`；**有本機行 ⇒ 照常返回**；未配置 ⇒ 不變。
- **反例兩條**：① **未配置（`off`）⇒ 不降級**（仍 `ok:true`）；② **有本機鏡像行 ⇒ 不降級**（照常列出本機行、不隱藏）。
- **`reason` 零新增**：轉發 `cloudBaseStatus().reason`；**判據收口在資料層**（服務層不自立第二份判據）。
- **理由**：雲讀取面被權限 / 配置攔下時 `query` 可能**靜默返回 0 行** ⇒ 照舊交出 `{ok:true, rows:[]}` 會把「讀不到」誤判成「沒有待審批次」（沿 §3.29.4 同向）。

## 5. C：包封透傳按 `op` 收窄
- **5 鍵只在 `op === 'migrateDynastyValues'` 時並入信封**；**其它任何 op 一律不透傳**（**含 `submitPersonImport` / `submitSealImport` / `registerArtifact` 的冪等路徑 `idempotent`**）⇒ 既有回包逐字不變。
- **反例**：**非遷移 op 即使內部返回 `idempotent`，也不得出現在信封頂層**（實證：`submitPersonImport` 冪等路徑曾泄漏頂層 `idempotent`）。
- **`plan` 是內部落盤計劃 ⇒ 不在白名單、永不外泄**。
- **未引入第二套 `op` 清單**。

## 6. 舊表述退役（§3.57.6）
- **退役對象**：**「此 5 集合讀面未遷移到雲 / 讀仍走本機 `localStorage` / 恆回落本機」一類表述**（含 `src/data/cloudbase.js` 集合同步的豁免 / 誠實空態頭注中的同義句）。
- **取代方式**：**以「追加注 / 表下注」承載**；**不得刪改任何既有 AC 與既有行內文字**。
- **明文**：**舊注中的「讀仍走本機 `localStorage`」自 v1.59 起只適用於未登記集合**；**不得據舊表述把「5 集合讀面未接雲」判任一合規實現負**（命中即該判定無效）。

## 7. 判據面（§10.57）
- **新增 `AC-511` 〜 `AC-519`（共 9 條）** ⇒ **§10 由 510 條增至 519 條**；**`AC-01` 〜 `AC-510` 的行內文字一字未改**。
- **`AC-511`** 單點翻譯恰一處；**`AC-512`** 映射真源恰一處（5 條逐字）；**`AC-513`** 未登記鍵原樣返回；**`AC-514`** 5 集合讀面已接雲 ＋ 舊表述退役；**`AC-515`** 讀失敗不得靜默顯示 0（含兩個反例）；**`AC-516`** 降級返回形狀 ＋ `reason` 零新增；**`AC-517`** 包封按 `op` 收窄；**`AC-518`** 反例：非遷移 op `idempotent` 不外泄 ＋ `plan` 永不外泄；**`AC-519`** 回歸面。

## 8. 計數（本包現取）
- **AC 新增 9 條 ⇒ §10 由 510 條增至 519 條**；**既有 `AC-01` 〜 `AC-510` 的編號與行內文字一字未改**。
- **集合不新增 ⇒ 仍 19 項**；**`[data-admin-action]` 仍恰 10 值 / 歸併 9 類**；**不新增 `reason` 字面值**；**`MARKABLE_FIELDS` 仍 7 項；路由表仍 10 條**。
- **不新開 W 行 ⇒ §11 表內仍 85 行、有效待裁項仍 63 行**。
- **本版純新增**：與 v1.58 快照 `diff` 的 **删除行 ＝ 0**、新增行 ＝ 85。
