# 外部批量导入「本機專屬面」改造 —— 拆解 / 裁定件（v1）

> **性質**：**Zang 的拆解與裁定件（口徑真源）**；本件**只寫口徑 / 邊界 / 判據 / 派單記錄**，
> **不含實現現狀結論、不含驗收結論**；凡引現狀讀數一律帶**來源 + 時點戳**。
> **時點戳**：**2026-10-12 20:0x–20:37（CST）**。
> **適用**：`xiai.plus`（生產）與本機站（`127.0.0.1:5163`）在外**部批量導入面**的可見性分離。

---

## 0. 輸入（Kevin 本輪裁定，逐字）

1. **原始訴求**：「在 https://xiai.plus/my/corrections 頁面中，進行對外部批量導入的處理時，為什麼無法批量駁回？」
2. **需求變更原話（逐字）**：「**批量導入的包，只在本地電腦出現，xiai.plus 不可見。**」
3. **形態二選一之答（逐字）**：**「①按「本機運行的本地站（127.0.0.1:5163，本地數據源）」區分 —— 可實現」**。
4. **變體選擇（逐字）**：**「乙→甲：先斷公網可見（小步），再搬本地權威（推薦）」**。
5. **過渡期處置（逐字）**：**「先修鏈路，修完再一併處理」**（對象 ＝ 線上殘留的 3079 條 `PENDING` 印章導入行）。

---

## 1. 凍結口徑（本件為真源）

- **R-1（可見性）**：**外部批量導入的「包 / 導入行 / 待審導入批次」＝ 本機專屬面**；
  **`xiai.plus`（公網面）不可見、不可審**。
- **R-2（「本機」的判定）**：**按數據源 / 構建區分** —— **本地數據源（`127.0.0.1:5163`，非 cloudbase）⇒ 本機面**；
  **cloudbase 數據源（生產構建）⇒ 公網面**。
  **不按「哪台電腦訪問 xiai.plus」區分**（同一份線上頁面無法按訪問機器分叉；技術上不可實現，明文排除）。
- **R-3（三條硬判據，可判負）**：
  - ① **生產構建** DOM 內「待審導入批次」區塊**零命中**（不得以 CSS 隱藏 / `disabled` 冒充）；
  - ② **雲讀面** `CLOUD_COLLECTIONS` / `CLOUD_COLLECTION_KEYS` **不含**三族導入集合
    （`personImports` / `sealImports` / `itemImports`），`CLOUD_KEY_OF_LOCAL` 亦撤三條映射；
  - ③ **本機站**完整可見可審：**整批採納 / 駁回一次點擊到位**（見 R-5）。
- **R-4（不做的那一半）**：**採納後的正式行仍落雲端正式集合**（`xiai_seals` / `xiai_faces` / `xiai_persons` / `xiai_items`）
  —— 生產站要展示它們；**本裁定不把正式集合搬本地**。
- **R-5（「整批」的語義）**：**一次點擊 = 該批次全部待審行處理完畢**（不是「每次 200 行」）；
  界面讀數**一律取服務端回包真值**，**不得**用本機全量判定報數（假成功）、**不得**在點擊後仍讀舊快照。
- **R-6（本機權威的落點）**：本機面若承載權威數據，**大對象面落 IndexedDB**（沿既有 `src/data/blobstore.js`）；
  **不得**落 localStorage —— 實測 ≥6 MB 即 `QuotaExceededError`，且 `storage.js::writeKey` 的 `catch` **靜默吞掉**。
- **R-7（失敗形態）**：本機側寫入失敗**必須如實報錯**（不得靜默、不得報成功）；傳輸失敗 ≠ `FORBIDDEN`。

---

## 2. 診斷基線（實測，只讀；來源 + 時點戳）

| # | 讀數 | 來源 |
|---|---|---|
| B-1 | `xiai_seal_imports` 3,681 行；批次 `seal_20261010_01` ＝ **3,679 行（3,079 `PENDING` / 600 `REJECTED`）**；`QA-E2E-B1` / `QA-E2E-B2` 各 1 行（`REJECTED`） | 管理端 `db nosql execute`（2026-10-12 20:0x CST） |
| B-2 | 600 筆駁回的 `reviewed_at` 恰三組：`2026-10-11T11:35:45Z`＝200、`2026-10-12T12:04:18Z`＝200、`12:04:37Z`＝200 ⇒ **一次點擊只翻 200 行**（＝ `cloudfunctions/xiai-user-token/lib/ops.js::IMPORT_REVIEW_PAGE_SIZE`） | 同上 |
| B-3 | 對照：`xiai_person_imports` 570 行全 `ACCEPTED`（`100`＋`200`＋`200`＋`70`）；`xiai_item_imports` 1,742 行全 `ACCEPTED`（`200×8`＋`142`，每次間隔 ≈14–15 s） ⇒ **採納同樣每擊 200 行** | 同上 |
| B-4 | 線上 `xiai-user-token` 與倉內 `HEAD`（`d8d6d87`）**逐字節一致**（`fn code download` + `md5` / `cmp`）；函數 **Timeout 900 s**、Memory 1024 MB ⇒ 非部署/超時問題 | CloudBase CLI + cmp（2026-10-12 20:1x CST） |
| B-5 | 生產站 `/my/corrections` 實讀：印章導入「共 3,079 條 · 1 批」，`整批採納` / `整批駁回` 按鈕在位，DOM 內 3,079 行 | headless Chrome 實讀（2026-10-12 20:2x CST） |
| B-6 | 雲讀面**一次性水合**（`cloudBase.js::ensureCloudBaseHydration` 記憶化；`cloudBaseReadOf` 只讀 `snapshotRef`），審核流程只 `dataVersion += 1`、**無重新拉取** ⇒ **點完界面不變** | 源碼 `src/data/cloudbase.js` / `src/views/MyCorrectionsView.vue` |
| B-7 | `services/*.js::apply*ImportDecision` 用**本機鏡像全量**判定並**忽略服務端回包**（信封亦未透傳 `accepted_ids/rejected_ids/skipped/failed`）⇒ 對該批會報「已駁回 3,079 條」而雲端只落 200；隨後整集合（≈3,679 行 × ≈4.4 KB ≈ **13–16 MB**）寫 localStorage，**靜默失敗** | 源碼；單行實測 4,376 字元；本機審判：4 MB OK / **≥6 MB `QuotaExceededError`** |
| B-8 | 規範 §3.55.5 / §3.54.15 / §3.59.3 與 `W-77` / `W-84` 的口徑是「**整批 ＋ 逐條兩個入口都實現**」，**無任何「每次 200 行」的條文** | `docs/xiai.spec.md`（2026-10-12 現盤） |

**⇒ 定性**：B-2/B-3 的「每次 200 行」是**實現側為修「100 行卡死」引入的分頁**，規範未登記；
配合 B-6（界面不刷新）與 B-7（假成功 + 靜默丟寫），用戶所見即「**整批駁回點了沒用**」。
**在新口徑下（R-1/R-2）此類缺陷整族消失**（審核不再經雲往返回合）。

---

## 3. 兩階段落地（乙 → 甲）

### 階段乙（本批 · 目標：公網不可見 ＋ 本機審核可用）

- **E-1 讀面撤出**：三族導入集合撤出 `CLOUD_COLLECTIONS`（`CLOUD_COLLECTION_KEYS` 隨動）＋撤 `CLOUD_KEY_OF_LOCAL` 三條映射。
- **E-2 渲染條件**：生產（cloudbase 數據源）⇒「待審導入批次」區塊**不渲染**（DOM 零命中）；
  本機（本地數據源）⇒ 照常渲染（三塊：印人 / 印章 / 印譜）。
- **E-3 本機取行通道**：新增**只讀**、管理員白名單的 op（暫擬 `pullImportRows`），把雲端待審導入行**單向取回本機**；
  **本階段由操作者在本機發起**，用於「雲端包 → 本機審」。該通道**階段甲復用**（存量搬遷）。
- **E-4 審核真值化**：服務端**按 `op` 收窄**透傳 `accepted_ids` / `rejected_ids` / `skipped` / `failed` / `done` / `remaining`；
  前端**只認回包**報數，並**循環推進**至該批 `remaining == 0`（或到達時間預算 ⇒ 顯示「剩餘 N，可續」）；
  點擊後**必須刷新讀面**（重拉或就地更新）。
- **E-5 寫入失敗如實**：本機鏡像寫入失敗**不得靜默**；本階段**不再整體落鏡像**（只落本批或改 IDB）。
- **驗收判據（乙）**：R-3 ①②③ ＋ 「點一次後該批 `remaining == 0`」或「如實報剩餘」＋「回包計數 = 雲端實際翻轉數」＋「零假成功」。

### 階段甲（下一批 · 目標：權威搬本機）

- **A-1 本地權威**：導入行**只落本機**（IndexedDB；沿 `blobstore.js`）；localStorage 不承載（R-6）。
- **A-2 提交通道**：`submitXImport` 的雲端寫入退場（改本機寫）；雲端不再新增導入行。
- **A-3 採納通道（二選一，**本件不代裁、待一句話**）**：**(a)** 行隨載荷上傳（服務端校驗鍵面 / 值域 / 影像引用後落正式集合）；
  **(b)** 另開「本機正式行 → 雲端正式集合」上傳口。
- **A-4 退場與留痕**：雲端三族暫存集合**下線（數據保留不刪）**；規範以**取代項 + 留痕**承載（不刪歷史行）。
- **A-5 過渡期數據**：本機由 E-3 通道把雲端存量導入行搬回本機後再審；**`REJECTED` 為終態、雲端不可回退**。

---

## 4. 影響面清單（硬計數現盤，2026-10-12）

- **集合清單**：現 21 項（`§3.33.3`）⇒ 三族導入集合**退出雲讀面**（**是否退出「集合清單」由 Jing 依取代流程裁定**；
  **不得**由實現側自行改計數）。
- **`[data-admin-action]`**：**仍恰 10 值 / 歸併 9 類**（本改造**不新增取值**；「待審導入批次」複用 `person-import-review`）。
- **`reason` 凍結表**：**零新增**（`FORBIDDEN` / `INVALID_FIELD` / `MISSING_REQUIRED` / `NOT_FOUND` / `STORAGE_UNAVAILABLE` 已夠）。
- **`storage.js` 鍵登記表**：**不新增鍵**（三族本機鏡像鍵已在冊）。
- **本機大對象面**：`src/data/blobstore.js`（IndexedDB）為 R-6 的既定落點。
- **雲函數**：`cloudfunctions/xiai-user-token` 一個（`index.js` 信封白名單按 `op` 收窄 ＋ `lib/ops.js` 新增只讀 op）。
- **前端**：`src/data/cloudbase.js`、`src/data/db.js`、`src/views/MyCorrectionsView.vue`、`src/services/{seals,persons,items}.js`。

---

## 5. 待處置項（過渡期，已裁：先修鏈路，修完一併處理）

- **P-1**：線上 `xiai_seal_imports` 批次 `seal_20261010_01` 的 **3,079 行 `PENDING`**（B-1）⇒ 階段甲由 E-3 通道搬回本機後再審；
  **雲端駁回為終態、不可回退**，處置方式（逐批審 / 雲上清理）**待修完後一句話定**。
- **P-2**：線上`PENDING`以外的既有行（600 `REJECTED` ＋ 570 `person ACCEPTED` ＋ 1,742 `item ACCEPTED`）**保留不刪**，作審計留痕。

---

## 6. 派單記錄（本件為唯一口徑真源；子單以本件 commit 為準）

| 單 | 角色 | 文件集（不得越界） | 要點 |
|---|---|---|---|
| K-乙-1 | Kong（實現） | `src/data/cloudbase.js`、`src/data/db.js`、`src/views/MyCorrectionsView.vue`、`src/services/{seals,persons,items}.js` | E-1 / E-2 / E-4 / E-5 |
| K-乙-2 | Kong（實現） | `cloudfunctions/xiai-user-token/{index.js,lib/ops.js}` | E-3（只讀 op）＋ E-4（按 `op` 收窄透傳） |
| J-乙 | Jing（規範） | `docs/xiai.spec.md`（＋ `docs/spec-increments/**`） | R-1/R-2/R-3 入規範（取代項 + 留痕）＋ AC 追加注 |
| N-乙 | Neng（質檢） | 報告檔（不碰產品碼） | **實現落地後另派**：R-3 三條硬判據 ＋ 假成功回歸 |

**三禁（寫進每份 brief）**：① 不部署（`fn deploy` / `fn code update` / `fn config update` 一律不跑）；
② 不 `git add/commit/push`（單一推送者 ＝ 派單方 Zang）；③ 不動生產數據（庫 / 桶都不寫）。
另禁破壞性 git：`checkout` / `restore` / `stash` / `reset` / `clean`。

---

## 7. v2 追補（2026-10-12 21:0x CST）：形態更正 ＋ 雲函數已上線

### 7.1 Kevin 本輪裁定（逐字）
- **形態**：**「①云数据源 ＋ 本机构建开关 ＋ E-3 取行（仅内存）—— 本机可审、采纳落云」**。
- **上線節奏**：**「云函数先上，前端等形态定了一并推」**。

### 7.2 更正 R-2（**取代 §1 的「本地數據源 ⇒ 本機面」字面**）
- **本機面判據 ＝ 本機構建開關**（`.env.local` 一類**不入庫**的本機構建配置；擬名
  `VITE_XIAI_LOCAL_IMPORT_FACE`，取法必須是**字面** `import.meta.env.VITE_XIAI_LOCAL_IMPORT_FACE`
  —— 本倉既有陷阱：先 `const env = import.meta.env` 再取鍵**不會**被 Vite 靜態替換）。
- **本機站跑「雲數據源」**（可寫雲、可落正式行），**不再**用 `writeFaceMode() === local-dev` 作本機面判據：
  該形態下本機站既看不到雲端的包、採納也落不了雲（寫面門放行但不發請求）⇒ 與 R-4 衝突。
- **公網面（生產構建，無該開關）**：不渲染「待審導入批次」區塊 ＋ 三族導入集合不在雲讀面（E-1 已完成）。

### 7.3 新增 R-8 / R-9
- **R-8（本機面數據只駐內存）**：待審導入行由 `pullImportRows` 分頁取回後**只放內存**（不落
  localStorage / IndexedDB），刷新即重取；理由 ＝ 3,679 行 ≈16 MB > 配額（實測 ≥6 MB 即拋），
  而 `storage.writeKey` 的 `catch` 會**靜默吞掉**寫入失敗。
- **R-9（審核仍走既有 review op）**：本機面審核＝用雲數據源走服務端（R-4 落正式行）；界面只認
  **回包真值** ＋ 循環推進至 `remaining == 0`（每次調用上限 200 行的分片由前端循環吸收，不是語義）。

### 7.4 上線記錄（實測，2026-10-12）
- **雲函數 `xiai-user-token` 已上線**：`fn code update --deployMode zip`（乾淨目錄，只含 index.js /
  package.json / README.md / lib/）；`fn list` 修改時間 **2026-09-30 22:42:24 → 2026-10-12 20:53:55**；
  `fn code download` 回下載 **7 個文件與倉內逐字節一致（SAME）**。
- **前端未推**（等形態①落地一併推）；生產站此刻 ＝ **舊前端 ＋ 新函數**（新 op 與新計數對舊前端向後兼容）。

### 7.5 派單記錄追加
| 單 | 角色 | 文件集 | 要點 |
|---|---|---|---|
| K-乙-3 | Kong | `src/services/token.js` | 修跨層契約縫：`gate()` 按 op 收窄透傳 8 個新鍵（現狀：白名單式重建對象 ⇒ 新鍵被靜默丟棄） |
| K-乙-4 | Kong | `src/data/**`、`src/services/{seals,persons,items}.js`、`src/views/MyCorrectionsView.vue` | 形態①落地：判據換本機構建開關 ＋ 接 E-3（分頁取行、僅內存，待審列表數據源切到取回結果） |
| J-乙-2 | Jing | `docs/**` | 以追加注承載 R-2 更正 ＋ R-8 / R-9（不刪舊行） |

### 7.6 待辦（本件登記）
- **P-3 真機 E2E（阻塞在前端未推）**：前端上線後在生產站實測 —— 本機面取行（`pullImportRows`）＋ 整批駁回循環推進至 `remaining == 0`。
- **工具陷阱（實測 2026-10-12）**：`cloudbase fn invoke --json` 回來的 `RetMsg.token` **在輸出裡只有 13 字元**
  （真令牌為兩段 base64url＋`.`），拿去 `action:'verify'` 恒 `TOKEN_MALFORMED` ⇒ **不得用 CLI invoke 做令牌往返 / op 真機驗證**。
- **P-1 不變**：線上 3,079 行 `PENDING` 印章導入行，待鏈路修完後處置（終態不可回退）。

### 7.7 上線與複檢（2026-10-12 21:2x CST｜前端口徑已定 ⇒ 前後端一併上線）

**上線動作**：`git push origin main`（`124c3bf..43f82e4`）⇒ Vercel 聯動；雲函數已於 20:53:55 先上（見 §7.4）。

**複檢讀數（實測）**：

| 判據 | 讀數 |
|---|---|
| 線上入口換版（推送即上線） | `assets/index-uuwkS9Nk.js` → **`assets/index-B717HeqN.js`**（約 45 s；輪詢 3 次命中） |
| 線上入口 ≡ 本地同一入口 | `sha256 c9fd2a4101ad76d52edae7db18efbe29def51ebacb9772d22e39ae76a9782af0` **逐字節一致** |
| 生產包內本機面開關痕跡 | `VITE_XIAI_LOCAL_IMPORT_FACE` **0 命中**（構建期常量；公網面恒 false） |
| R-3① 公網面零命中 | 生產站 `/my/corrections`（管理員已登錄、新構建）：`h2` 無「待審導入批次」項；`[data-import-pull-refresh]` / `[data-import-pull-notice]` / `[data-seal-import-id]` **均 0** |
| R-3③ 本機面完整可用 | 本機站 `http://127.0.0.1:5163/my/corrections`（雲數據源）：區塊**渲染**；「印章導入 共 1000 條 · 1 批」；notice「印章導入 **已取 1000 條（可能還有更多）**」；`pullImportRows` 真走雲（`tcb-api` 資源條目在位） |
| R-6 / R-8 本地落盤 | 本機站 `localStorage` **無** `xiai:v1:{person,seal,item}-imports` 任一鍵（取回行僅駐內存） |

**仍然待辦**：
- **P-1 處置（未動）**：線上 `xiai_seal_imports` 批次 `seal_20261010_01` 的 **3,079 行 `PENDING`** —— 上線後**公網面已不可見、不可審**；要處理只能在本機站（已實測可取 1000 條/輪；駁回一輪後再取即為下一批 PENDING）。**終態不可回退 ⇒ 等 Kevin 定處置方式**。
- **P-3 真機 E2E（已達成；一輪試水，2026-10-12 21:27–21:28 CST）**：本機站 `127.0.0.1:5163` 點一次「整批駁回」＝ 5 次服務端調用 × 200 行 ＝ **1000 行**落地；雲端複核：批次 `seal_20261010_01` `PENDING` 3,079 → **2,079**、`REJECTED` 600 → **1,600**（新增 `reviewed_at` 5 組 × 200：`13:27:56Z` / `13:28:07Z` / `13:28:16Z` / `13:28:24Z` / `13:28:32Z`，間隔 ≈8–9 s）；總數仍 3,679（零丟失）。界面：進度「**已處理 1000 · 剩餘 200**」、列表**已自動重取**（行 id 換新一批 1000 條）。
- **F-1（本輪唯一缺陷，待修）**：終態 feedback 只顯示**最後一輪**的條數 —— 逐字為「已駁回 **200** 條印章外部導入行（跳過 0 / 剩餘 200）（已達本次循環預算，剩餘 200 條；可再次點擊續審）」，而進度條同時顯示「已處理 1000」⇒ **同一屏兩個數不一致**。根因：`runImportReviewLoop` 每輪覆寫 `message`、只保留末輪。建議：改為**累計**文案（如「本輪共駁回 N 條（M 次調用）；剩餘 R 條，可再次點擊續審」）。
