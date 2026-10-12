
<script setup>
/**
 * 我的勘误记录。
 *
 * - 普通用户 / 游客：只看到**自己**提交的勘误，**没有任何审核按钮**。
 * - 管理员：本页是勘误审核的载体（不再是独立页面 / 页签）——上方列出**全部用户**的
 *   待审勘误，每条带「采纳 / 驳回」按钮；下方仍可看到自己的提交明细。
 *   审核动作是奖励的唯一触发路径（采纳 +10 金且每条只奖一次）。
 * 按钮一律**条件渲染**（`v-if`），判定来自服务层 `canReviewCorrections(actor)`；
 * 数据层对越权写另有独立拒绝，不因界面变化而放宽。
 */

import { computed, onMounted, ref } from 'vue'
import PlaceholderPanel from '../components/PlaceholderPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { corrections, persons, points, seals, items } from '../services/index.js'
import { currentUser } from '../data/session.js'
/* **形態①（K-乙-4｜2026-10-12｜更正 R-2）**：本机面判据的**唯一真源** —— 外部批量导入＝
   本机专属面，判据是**本机构建开关** `VITE_XIAI_LOCAL_IMPORT_FACE`（字面取键；值 ∈ {'1','true'}），
   **不再**用 `writeFaceMode() === local-dev`：那样本机站既看不到云端的包、采纳也落不了云
   （与 R-4「采纳后正式行仍落云端」冲突）。
   生产构建（无该开关）⇒ `isLocalImportFace()` 恒 false ⇒「待審導入批次」区块**不渲染**
   （DOM 零命中，不以 CSS 隐藏冒充）**且不發任何取行請求**。**不自造第二套判据、不在本文件读 env。** */
import { isLocalImportFace } from '../data/writeFaceMode.js'
import { statusLabel, formatDateTime, importReviewFeedbackText } from '../utils/format.js'

/* 任何一次审核 / 提交后 +1，使下面的派生读数重算。 */
const dataVersion = ref(0)
const feedback = ref('')
/* **E-4**：循環審核期間的進度讀數（`已處理 N · 剩餘 M`）；空串 ⇒ 不顯示。 */
const importReviewProgress = ref('')

/* ============================================================================
   **E-3 取行（本機面｜K-乙-4｜2026-10-12｜形態①）—— 數據源切到「取回結果（僅內存）」
   ----------------------------------------------------------------------------
   本機面（`isLocalImportFace()` ⇒ true）下，三個待審導入列表的數據源**不再**是雲快照 /
   本機鏡像，而是 `pullImportRows` 取回的結果：
     · **僅內存**（本文件的 `ref`；**禁** localStorage / IndexedDB —— R-8：3,679 行 ≈16 MB
       > 配額，且 `storage.writeKey` 的 catch 會靜默吞掉）；
     · **刷新即重取**（掛載時取一次；見 `onMounted`）；
     · **審後刷新**（三處審核循環結束後**重新取行**，**不再**靠 `dataVersion` 重讀舊快照）；
     · **未取完如實上屏**「已取 N 條（可能還有更多）」，**不得報成全部**。
   生產面（`isLocalImportFace()` ⇒ false）：**零取行**（不發請求、不進內存）＋ 區塊不渲染
   ⇒ 與改前**零回歸**。
   ============================================================================ */
const localImportLoading = ref(false)
const localImportPulled = ref(false)
/** 三族待審導入行（取回結果；**僅內存**）。 */
const localImportRowsByFamily = ref({ persons: [], seals: [], items: [] })
/** 逐族「可能還有更多」（該輪取滿 ⇒ 如實標；**不得報成全部**）。 */
const localImportMaybeMoreByFamily = ref({ persons: false, seals: false, items: false })
/** 取行降級 / 未取完的可讀文案（正常路徑為空串）。 */
const localImportPullNotice = ref('')

const LOCAL_IMPORT_FAMILY_LABELS = { persons: '印人導入', seals: '印章導入', items: '印谱導入' }

/**
 * **重新取行**（本機面；僅內存）。三族並行；任一族的失敗**如實上屏**（不靜默、不以空集冒充）。
 */
async function refreshLocalImportRows() {
  if (!isLocalImportFace()) {
    localImportRowsByFamily.value = { persons: [], seals: [], items: [] }
    localImportMaybeMoreByFamily.value = { persons: false, seals: false, items: false }
    localImportPullNotice.value = ''
    localImportPulled.value = false
    return
  }
  localImportLoading.value = true
  try {
    /* 待審面 ⇒ 逐族取 `PENDING`（`status` 空串不落鍵；非空才落 —— 雲側鍵面封閉）。 */
    const responses = await Promise.all([
      persons.pullPersonImportRows(actor.value, { status: 'PENDING' }),
      seals.pullSealImportRows(actor.value, { status: 'PENDING' }),
      items.pullItemImportRows(actor.value, { status: 'PENDING' })
    ])
    const families = ['persons', 'seals', 'items']
    const rowsByFamily = { persons: [], seals: [], items: [] }
    const maybeMoreByFamily = { persons: false, seals: false, items: false }
    const parts = []
    families.forEach((family, index) => {
      const result = responses[index]
      if (result && result.ok === true) {
        rowsByFamily[family] = Array.isArray(result.rows) ? result.rows : []
        maybeMoreByFamily[family] = result.maybeMore === true
        if (maybeMoreByFamily[family]) {
          parts.push(`${LOCAL_IMPORT_FAMILY_LABELS[family]} 已取 ${rowsByFamily[family].length} 條（可能還有更多）`)
        }
        return
      }
      parts.push(`${LOCAL_IMPORT_FAMILY_LABELS[family]}：${(result && result.message) || '取行失敗'}`)
    })
    localImportRowsByFamily.value = rowsByFamily
    localImportMaybeMoreByFamily.value = maybeMoreByFamily
    localImportPullNotice.value = parts.join('；')
    localImportPulled.value = true
  } finally {
    localImportLoading.value = false
  }
}

/* 刷新即重取（R-8：僅內存 ⇒ 不持久化、不緩存）。 */
onMounted(() => {
  void refreshLocalImportRows()
})

/* ============================================================================
   **V3 撤除「校驗碼彈窗」**（2026-10-04）
   ----------------------------------------------------------------------------
   采纳 / 驳回已收敛到「一枚登录令牌 ＋ 手机号白名单」⇒ **不再有校驗碼弹窗 / 输入位**；
   令牌的「取 / 补签（刷新后）」收口在服务层单点（`services/userWrite.js`），
   本页**直接调** `corrections.review / reviewBatch`（零弹窗、零校驗碼输入位钩子）。
   ============================================================================ */

const actor = computed(() => currentUser())
/* 管理员专属「采纳 / 驳回」按钮的渲染条件（服务层判定；普通用户 / 游客 ⇒ false）。 */
const canReview = computed(() => corrections.canReviewCorrections(actor.value))

/* ============================================================================
   **印人提案审核区块（person-model §4.3.3 / §3.54；本单新增）**
   ----------------------------------------------------------------------------
   管理员视角在**本页**新增「待審印人提案（全部用戶）」的采纳 / 驳回区块 ——
   **复用既有按钮形态**、**不新开路由 / 不新建管理员专区**（落点 ＝ §3.9 追加注（v1.53））。
   - 采纳 / 驳回 ＝ **管理员**：入口仅管理员渲染（非管理员 ⇒ DOM 零命中，不得 CSS 隐藏冒充）；
     服务层 / 数据层对越权另有**独立拒绝**（`FORBIDDEN` ＋ 零写入）。
   - 钩子族：新增**恰 1 个** `data-admin-action` 取值 `person-proposal-review`
     （采纳 / 驳回**共用**；**不复用既有 `correction-accept` 等字面值承载新实体**）
     ⇒ `[data-admin-action]` 由 8 值 / 归并 7 类 变为 **9 值 / 归并 8 类**。
   ============================================================================ */
const canReviewProposals = computed(() => persons.canReviewPersonProposals(actor.value))
/** 待审印人提案（结构化结果：拒绝 ⇒ `ok:false`，**不以空集冒充拒绝**）。 */
const proposalResult = computed(() => {
  void dataVersion.value
  return persons.listPendingPersonProposalsForAdmin(actor.value)
})
const proposals = computed(() => (proposalResult.value.ok ? proposalResult.value.rows : []))
const proposalNotice = computed(() => (proposalResult.value.ok ? '' : proposalResult.value.message))

/** 提案提交人展示名（沿服务层单点 `submitterLabelOf`：`暱稱（uid 短碼）`，零手机号）。 */
function proposalSubmitterOf(row) {
  return corrections.submitterLabelOf(persons.proposalSubmitterId(row))
}

/** 提案印人显示名（服务层单点 `personName`；空 ⇒ 空串，模板显示「（未命名）」）。 */
function proposalNameOf(row) {
  return persons.personName(row)
}

/** 生卒上屏（「不详」＝空，不设特值；两端皆空 ⇒ 「—」）。 */
function proposalYearsOf(row) {
  const birth = row && row.birth_year !== null && row.birth_year !== undefined ? String(row.birth_year) : ''
  const death = row && row.death_year !== null && row.death_year !== undefined ? String(row.death_year) : ''
  if (!birth && !death) return '—'
  return `${birth || '?'}～${death || '?'}`
}

/** 采纳 / 驳回一条印人提案（服务层判定与幂等生成 / 更新；`message` 原文上屏）。
 *
 *  `reviewPersonProposal` 已改 **`async`**（经登录令牌写面门 `userWriteGate` 同一通道，与
 *  `corrections.review` 同径）⇒ 宿主函数亦须 `async` 并 `await`；否则拿到的是 Promise
 *  （`result.message` 恒 `undefined`，且 `dataVersion` 在落盘前即自增 ⇒ UI 不按结果更新）。
 *  返回契约（`persons.js::reviewPersonProposal`）：成功 / 失败皆回 `{ok, …, message}`——
 *  `ACCEPTED` ⇒ `{ok:true, status, accepted:true, row, message:'已採納…'}`；`REJECTED` ⇒
 *  `{ok:true, status, accepted:false, row:null, message:'已駁回…'}`；`FORBIDDEN` /
 *  `ALREADY_REVIEWED` / `NOT_FOUND` 等 ⇒ `{ok:false, reason, message}`。故一律以
 *  `result.message` 原文上屏，**拒绝不折回「假成功」**（沿用既有 `runReview` 口径）。 */
async function decideProposal(row, decision) {
  const result = await persons.reviewPersonProposal(actor.value, row.id, decision, '')
  feedback.value = result.message
  dataVersion.value += 1
}

/* ============================================================================
   **待審導入批次審核區塊（印人批 2｜§3.54.15 / §4.1.16 / AC-490；本单新增）**
   ----------------------------------------------------------------------------
   管理员视角在**本页**新增「待審導入批次（外部批量導入）」的采纳 / 驳回区块 ——
   **复用既有采纳 / 驳回形态与二次确认体例（沿 §3.44.10 / W-78）**；**不新开路由 / 专区**。
   - 采纳 / 驳回 ＝ **管理员**：入口仅管理员渲染（非管理员 ⇒ DOM 零命中，不得 CSS 隐藏冒充）；
     服务层 / 数据层对越权另有**独立拒绝**（`FORBIDDEN` ＋ 零写入）。
   - 钩子族：新增**恰 1 个** `data-admin-action` 取值 `person-import-review`
     （采纳 / 驳回**共用**；**不复用既有字面值**）＋ `data-action`（person-import-accept / reject）
     ⇒ `[data-admin-action]` 由 9 值 / 归并 8 类 变为 **10 值 / 归并 9 类**（v1.54）。
   - 采纳粒度（W-77 拟案）：**两个入口都实现** —— 按批次（整批）与按单行（逐条）。
   ============================================================================ */
const canReviewImports = computed(() => persons.canReviewPersonImports(actor.value))
/** 待审外部导入行（结构化结果：拒绝 ⇒ `ok:false`，不以空集冒充拒绝）。 */
const importResult = computed(() => {
  void dataVersion.value
  return persons.listPendingPersonImportsForAdmin(actor.value)
})
/* **形態①**：本機面 ⇒ 數據源 ＝ E-3 取回結果（僅內存；見 `refreshLocalImportRows`）；
   公網面 ⇒ 既有服務層讀面**逐字不變**。 */
const importRows = computed(() =>
  isLocalImportFace() ? localImportRowsByFamily.value.persons : importResult.value.ok ? importResult.value.rows : []
)
const importNotice = computed(() =>
  isLocalImportFace() ? '' : importResult.value.ok ? '' : importResult.value.message
)
/** 按批次（`batch_id`）分组（视图层分组；单批内逐条采纳仍保留）。 */
const importBatches = computed(() => {
  const groups = new Map()
  importRows.value.forEach((row) => {
    const key = String((row && row.batch_id) || '（無批次）')
    if (!groups.has(key)) groups.set(key, { key, batchId: String((row && row.batch_id) || ''), rows: [] })
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})
/** 导入行外部来源 id（幂等键；零手机号）。 */
function importSourceIdOf(row) {
  return String((row && row.source_person_id) || '')
}
/** 导入行导入人展示名（服务层单点：`暱稱（uid 短碼）`，零手机号）。 */
function importSubmitterOf(row) {
  return corrections.submitterLabelOf(persons.importSubmitterId(row))
}
/** 导入行姓名上屏（服务层单点派生；空 ⇒ 回落 `name_full`）。 */
function importNameOf(row) {
  return persons.personName(row) || String((row && row.name_full) || '')
}

/** 二次确认状态（`null` ＝ 未打开）；粒度：按批次（`batch`）/ 按单行（`row`）。 */
const importDialog = ref(null)
const importNote = ref('')
const importBusy = ref(false)

function askImport(target, decision) {
  importNote.value = ''
  importDialog.value = { batch: target.batch || null, row: target.row || null, decision }
}

function cancelImport() {
  importDialog.value = null
}

const importConfirmText = computed(() =>
  importDialog.value && importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '確認採納' : '確認駁回'
)
const importDialogTitle = computed(() => {
  if (!importDialog.value) return ''
  const scope = importDialog.value.row ? '單行' : '整批'
  return `${scope}${importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'}`
})
const importDialogMessage = computed(() => {
  if (!importDialog.value) return ''
  const { batch, row, decision } = importDialog.value
  const verb = decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'
  const count = row ? 1 : batch ? batch.rows.length : 0
  const who = row ? importSourceIdOf(row) : batch ? batch.key : ''
  return `這將對「${who}」的 ${count} 條外部導入行全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const importConfirmAction = computed(() => {
  if (!importDialog.value) return ''
  return importDialog.value.decision === persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED
    ? 'person-import-confirm-accept'
    : 'person-import-confirm-reject'
})
const IMPORT_CANCEL_ACTION = 'person-import-cancel'

/* **E-4（阶段乙｜2026-10-12）**：整批 / 單行審核的**循環推進**（≤5 輪、≤60 s 預算）。
   每輪只認**回包**的權威計數（鍵名逐字凍結：`accepted_ids` / `rejected_ids` / `skipped` /
   `failed` / `done` / `remaining`）—— 服務層已把雲端回包透傳（本機面下即本機權威回包，同一條路）。
   逐輪上屏「已處理 N · 剩餘 M」，並令本機鏡像就地更新（落盤由服務層承擔 ⇒ 此處只 `dataVersion += 1`
   觸發重算）。
   **F-1（2026-10-12｜本單修）**：終態反饋**改累計口徑** —— 逐輪把 `accepted_ids.length` /
   `rejected_ids.length` 累加（**只由回包陣列長度派生**，不另立真源）、並記**實際完成**（`ok === true`）
   的調用次數；終態文案交純函式 `importReviewFeedbackText`（`src/utils/format.js`）拼裝 ⇒
   `本輪共{採納|駁回} {n} 條（共 {rounds} 次調用）` ＋（未收斂時）`；剩餘 {remaining} 條，可再次點擊續審。`
   動詞隨 `options.decision`（**不寫死「駁回」**）；`remaining` 缺席 ⇒ **不填 0**（不寫「剩餘」一句）。
   任一輪 `ok !== true` ⇒ **即時中斷**、該輪 `reason` / `message` **原文上屏**（真因不吞）、
   **該輪條數不計入累計**、**不報成成功**。
   **F-2（2026-10-12｜本單修）**：**入口分叉**（視圖層判定，**不新增參數到服務層**；判定用
   `options.importId` 非空）——「單行」入口一次只決定**一行**，跑滿 5 輪就是拿同一行去服務端
   反覆打（服務端逐輪 `skipped` 1 ⇒ 4 次無謂往返 ＋ 文案「共 5 次調用；跳過 4」對「只駁一行」
   屬誤導）、且「剩餘 N 條，可再次點擊續審」不是單行入口的語義 ⇒ 單行改為**恰 1 次調用**
   （`maxRounds === 1`）＋ 終態**不附**剩餘一句（向純函式傳 `remaining: null`，**不填 0**）。
   整批入口（`batchId`）**一字不改**（≤5 輪 / ≤60 s 預算 / 累計口徑 / 真因回補 / 剩餘提示）。 */
const IMPORT_REVIEW_MAX_ROUNDS = 5
const IMPORT_REVIEW_BUDGET_MS = 60000
/** 單行入口的循環上限（**恰 1 次調用**；F-2）。 */
const IMPORT_REVIEW_SINGLE_ROW_ROUNDS = 1

async function runImportReviewLoop(reviewFn, options) {
  /* **F-2 入口分叉**（逐字照口徑）：非空 `importId` ⇒ 單行；否則 ⇒ 整批。 */
  const singleRow = !!(options && options.importId)
  const maxRounds = singleRow ? IMPORT_REVIEW_SINGLE_ROW_ROUNDS : IMPORT_REVIEW_MAX_ROUNDS
  const deadline = Date.now() + IMPORT_REVIEW_BUDGET_MS
  let processed = 0
  let rounds = 0
  let skippedCount = 0
  let failedCount = 0
  let remaining = null
  let message = ''
  let serverMessage = ''
  let ok = true
  importReviewProgress.value = ''
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await reviewFn(actor.value, options)
    if (!result || result.ok !== true) {
      ok = false
      /* **F-1**：失敗 / 中斷輪 ⇒ 照舊**即時中斷**；該輪原文上屏；**該輪條數不入累計**、不報成成功。 */
      message = (result && result.message) || message
      if (result && Number.isFinite(Number(result.remaining))) remaining = Number(result.remaining)
      break
    }
    rounds += 1
    processed +=
      (Array.isArray(result.accepted_ids) ? result.accepted_ids.length : 0) +
      (Array.isArray(result.rejected_ids) ? result.rejected_ids.length : 0)
    /* **F-1 補（真因累計）**：逐輪（僅 `ok === true`）累加回包 `skipped` / `failed` 的**陣列長度**
       （**唯一真源**；不得由 `done` / `remaining` 推）⇒ 多輪下 `rounds > 1` 時由純函式回補
       「失敗 N · 跳過 M」。失敗 / 中斷輪不入累計（見上 `break` 分支）。 */
    skippedCount += Array.isArray(result.skipped) ? result.skipped.length : 0
    failedCount += Array.isArray(result.failed) ? result.failed.length : 0
    remaining = result.remaining === undefined || result.remaining === null ? null : Number(result.remaining)
    if (result.message) serverMessage = result.message
    importReviewProgress.value = `已處理 ${processed} · 剩餘 ${remaining === null ? '—' : remaining}`
    dataVersion.value += 1
    if (remaining === null || remaining <= 0) break
    if (Date.now() >= deadline) break
  }
  if (ok) {
    /* **F-1**：**累計**口徑（非末輪）；動詞隨 `options.decision`；服務端 `message` 與**真因累計**
       由純函式按規則處置（單輪原文自帶失敗/跳過 ⇒ 不重複報；多輪補回）。
       **F-2**：單行入口 ⇒ `remaining` 傳 `null`（**不附**「剩餘 N 條，可再次點擊續審」；
       **不填 0**）；整批入口 ⇒ 照舊傳真實 `remaining`。 */
    message = importReviewFeedbackText({
      decision: options && options.decision,
      count: processed,
      rounds,
      remaining: singleRow ? null : remaining,
      serverMessage,
      skippedCount,
      failedCount
    })
  }
  return { ok, message, remaining }
}

async function confirmImport() {
  const dialog = importDialog.value
  if (!dialog || importBusy.value) return
  const note = dialog.decision === persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED ? importNote.value : ''
  importBusy.value = true
  try {
    /* 两个入口：按单行（`importId`）优先；否则按批次（`batchId`）。回包 `message` 原文上屏。 */
    const options = dialog.row
      ? { importId: String(dialog.row.id || ''), decision: dialog.decision, note }
      : { batchId: String((dialog.batch && dialog.batch.batchId) || ''), decision: dialog.decision, note }
    const outcome = await runImportReviewLoop(persons.reviewPersonImport, options)
    feedback.value = outcome.message
    importDialog.value = null
    /* **形態①**：審核循環結束 ⇒ **重新取行**（內存刷新）；**不**靠雲快照 / `dataVersion` 重讀舊數據。 */
    if (isLocalImportFace()) await refreshLocalImportRows()
    dataVersion.value += 1
  } finally {
    importBusy.value = false
  }
}

/* ============================================================================
   **印章導入待審行（批 3｜v1.55 §3.55.8 / §4.1.17；本单新增）**
   ----------------------------------------------------------------------------
   与上方「印人导入」区块**同屏、合并为一个区块**（人类 2026-10-10 拍定）：
   - 待审源 ＝ 服务层既有 `seals.listPendingSealImportsForAdmin(actor)`；
     采纳 / 驳回走服务层既有 `seals.reviewSealImport(actor, {...})`（**视图不重建业务逻辑**）。
   - **共用同一钩子值** `person-import-review` ⇒ `[data-admin-action]` **不新增取值**
     （仍恰 10 值 / 归并 9 类）。
   - 非管理员 ⇒ **不渲染**（条件渲染；不得 CSS 隐藏 / `disabled` 冒充）。
   - 驳回理由上限用服务层单点 `seals.MAX_SEAL_REVIEW_NOTE_LENGTH`。
   ============================================================================ */
const canReviewSealImports = computed(() => seals.canReviewSealImports(actor.value))
const sealImportResult = computed(() => {
  void dataVersion.value
  return seals.listPendingSealImportsForAdmin(actor.value)
})
const sealImportRows = computed(() =>
  isLocalImportFace() ? localImportRowsByFamily.value.seals : sealImportResult.value.ok ? sealImportResult.value.rows : []
)
const sealImportNotice = computed(() =>
  isLocalImportFace() ? '' : sealImportResult.value.ok ? '' : sealImportResult.value.message
)
/** 按批次（`batch_id`）分组（视图层分组；单批内逐条采纳仍保留，与印人导入同型）。 */
const sealImportBatches = computed(() => {
  const groups = new Map()
  sealImportRows.value.forEach((row) => {
    const key = String((row && row.batch_id) || '（無批次）')
    if (!groups.has(key)) groups.set(key, { key, batchId: String((row && row.batch_id) || ''), rows: [] })
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})
/** 印章導入行外部来源 id（幂等键；零手机号）。 */
function sealImportSourceIdOf(row) {
  return String((row && row.source_seal_id) || '')
}
/** 印章導入行导入人展示名（服务层单点：`暱稱（uid 短碼）`，零手机号）。 */
function sealImportSubmitterOf(row) {
  return corrections.submitterLabelOf(seals.sealImportSubmitterId(row))
}
/** 印章導入行印名上屏（缺 ⇒ 模板回落「（未命名）」）。 */
function sealImportNameOf(row) {
  return String((row && row.seal_name) || '')
}
/** 印章導入行印面数（同屏读数；缺 ⇒ 0）。 */
function sealImportFaceCountOf(row) {
  return Array.isArray(row && row.faces) ? row.faces.length : 0
}

/** 印章导入二次确认状态（`null` ＝ 未打开）；粒度：按批次（`batch`）/ 按单行（`row`）。 */
const sealImportDialog = ref(null)
const sealImportNote = ref('')
const sealImportBusy = ref(false)

function askSealImport(target, decision) {
  sealImportNote.value = ''
  sealImportDialog.value = { batch: target.batch || null, row: target.row || null, decision }
}

function cancelSealImport() {
  sealImportDialog.value = null
}

const sealImportConfirmText = computed(() =>
  sealImportDialog.value && sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '確認採納' : '確認駁回'
)
const sealImportDialogTitle = computed(() => {
  if (!sealImportDialog.value) return ''
  const scope = sealImportDialog.value.row ? '單行' : '整批'
  return `${scope}${sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'}`
})
const sealImportDialogMessage = computed(() => {
  if (!sealImportDialog.value) return ''
  const { batch, row, decision } = sealImportDialog.value
  const verb = decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'
  const count = row ? 1 : batch ? batch.rows.length : 0
  const who = row ? sealImportSourceIdOf(row) : batch ? batch.key : ''
  return `這將對「${who}」的 ${count} 條印章外部導入行全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const sealImportConfirmAction = computed(() => {
  if (!sealImportDialog.value) return ''
  return sealImportDialog.value.decision === seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED
    ? 'seal-import-confirm-accept'
    : 'seal-import-confirm-reject'
})
const SEAL_IMPORT_CANCEL_ACTION = 'seal-import-cancel'
/** 驳回理由上限（服务层单点 `MAX_SEAL_REVIEW_NOTE_LENGTH`；不在视图另立数值）。 */
const SEAL_IMPORT_NOTE_MAX = seals.MAX_SEAL_REVIEW_NOTE_LENGTH

async function confirmSealImport() {
  const dialog = sealImportDialog.value
  if (!dialog || sealImportBusy.value) return
  const note = dialog.decision === seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED ? sealImportNote.value : ''
  sealImportBusy.value = true
  try {
    /* 服务层单点：按单行（`importId`）优先；否则按批次（`batchId`）。回包 `message` 原文上屏。 */
    const options = dialog.row
      ? { importId: String(dialog.row.id || ''), decision: dialog.decision, note }
      : { batchId: String((dialog.batch && dialog.batch.batchId) || ''), decision: dialog.decision, note }
    const outcome = await runImportReviewLoop(seals.reviewSealImport, options)
    feedback.value = outcome.message
    sealImportDialog.value = null
    /* **形態①**：審核循環結束 ⇒ **重新取行**（內存刷新）；**不**靠雲快照 / `dataVersion` 重讀舊數據。 */
    if (isLocalImportFace()) await refreshLocalImportRows()
    dataVersion.value += 1
  } finally {
    sealImportBusy.value = false
  }
}

/* ============================================================================
   **印谱導入待審行（第三類｜v1.62；本单新增）**
   ----------------------------------------------------------------------------
   在既有「待審導入批次」區塊內新增**第三塊**（前两块 ＝ 印人导入 / 印章导入），
   形态**逐项照搬既有两块**：
   - 待审源 ＝ 服务层既有 `items.listPendingItemImportsForAdmin(actor)`（已含「不静默显示 0」降级）；
     采纳 / 驳回走服务层既有 `items.reviewItemImport(actor, {...})`（**视图不重建业务逻辑**）。
   - **共用同一钩子值** `person-import-review` ⇒ `[data-admin-action]` **不新增取值**。
   - 非管理员 ⇒ **不渲染**（条件渲染；不得 CSS 隐藏 / `disabled` 冒充）。
   - **列面只展示正字段（繁体）**，**不展示 `*_chs` 副字段**。
   - 驳回理由上限用服务层单点 `items.MAX_ITEM_REVIEW_NOTE_LENGTH`。
   - **两态终态行仍能显示**：行渲染不假设 `PENDING`（`data-item-import-status` 标记当前状态），
     终态行照常上屏、置灰（`is-terminal` class），**不因终态而报错**。
   ============================================================================ */
const canReviewItemImports = computed(() => items.canReviewItemImports(actor.value))
const itemImportResult = computed(() => {
  void dataVersion.value
  return items.listPendingItemImportsForAdmin(actor.value)
})
const itemImportRows = computed(() =>
  isLocalImportFace() ? localImportRowsByFamily.value.items : itemImportResult.value.ok ? itemImportResult.value.rows : []
)
const itemImportNotice = computed(() =>
  isLocalImportFace() ? '' : itemImportResult.value.ok ? '' : itemImportResult.value.message
)
/** 按批次（`batch_id`）分组（视图层分组；单批内逐条采纳仍保留，与印人 / 印章导入同型）。 */
const itemImportBatches = computed(() => {
  const groups = new Map()
  itemImportRows.value.forEach((row) => {
    const key = String((row && row.batch_id) || '（無批次）')
    if (!groups.has(key)) groups.set(key, { key, batchId: String((row && row.batch_id) || ''), rows: [] })
    groups.get(key).rows.push(row)
  })
  return [...groups.values()]
})
/** 印谱導入行外部来源 id（幂等键；零手机号）。 */
function itemImportSourceIdOf(row) {
  return String((row && row.source_item_id) || '')
}
/** 印谱導入行导入人展示名（服务层单点：`暱稱（uid 短碼）`，零手机号）。 */
function itemImportSubmitterOf(row) {
  return corrections.submitterLabelOf(items.itemImportSubmitterId(row))
}
/** 印谱導入行题名上屏（**正字段 `title`**；缺 ⇒ 模板回落「（未命名）」）。 */
function itemImportTitleOf(row) {
  return String((row && row.title) || '')
}
/** 印谱導入行年代上屏（**正字段 `date_text`**；空 ⇒ 「—」）。 */
function itemImportDateTextOf(row) {
  const t = row && row.date_text
  return t === null || t === undefined || t === '' ? '—' : String(t)
}
/** 印谱導入行卷數上屏（**正字段 `volume_count`**；空 ⇒ 「—」）。 */
function itemImportVolumeCountOf(row) {
  const v = row && row.volume_count
  return v === null || v === undefined ? '—' : String(v)
}
/** 终态行（`ACCEPTED` / `REJECTED`）⇒ 置灰标记（**不因终态而报错**）。 */
function itemImportIsTerminal(row) {
  const status = String((row && row.status) || '')
  return status === items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED || status === items.ITEM_IMPORT_STATUS_EXPORT.REJECTED
}

/** 印谱导入二次确认状态（`null` ＝ 未打开）；粒度：按批次（`batch`）/ 按单行（`row`）。 */
const itemImportDialog = ref(null)
const itemImportNote = ref('')
const itemImportBusy = ref(false)

function askItemImport(target, decision) {
  itemImportNote.value = ''
  itemImportDialog.value = { batch: target.batch || null, row: target.row || null, decision }
}

function cancelItemImport() {
  itemImportDialog.value = null
}

const itemImportConfirmText = computed(() =>
  itemImportDialog.value && itemImportDialog.value.decision === items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED ? '確認採納' : '確認駁回'
)
const itemImportDialogTitle = computed(() => {
  if (!itemImportDialog.value) return ''
  const scope = itemImportDialog.value.row ? '單行' : '整批'
  return `${scope}${itemImportDialog.value.decision === items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'}`
})
const itemImportDialogMessage = computed(() => {
  if (!itemImportDialog.value) return ''
  const { batch, row, decision } = itemImportDialog.value
  const verb = decision === items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED ? '採納' : '駁回'
  const count = row ? 1 : batch ? batch.rows.length : 0
  const who = row ? itemImportSourceIdOf(row) : batch ? batch.key : ''
  return `這將對「${who}」的 ${count} 條印谱外部導入行全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const itemImportConfirmAction = computed(() => {
  if (!itemImportDialog.value) return ''
  return itemImportDialog.value.decision === items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED
    ? 'item-import-confirm-accept'
    : 'item-import-confirm-reject'
})
const ITEM_IMPORT_CANCEL_ACTION = 'item-import-cancel'
/** 驳回理由上限（服务层单点 `MAX_ITEM_REVIEW_NOTE_LENGTH`；不在视图另立数值）。 */
const ITEM_IMPORT_NOTE_MAX = items.MAX_ITEM_REVIEW_NOTE_LENGTH

async function confirmItemImport() {
  const dialog = itemImportDialog.value
  if (!dialog || itemImportBusy.value) return
  const note = dialog.decision === items.ITEM_IMPORT_STATUS_EXPORT.REJECTED ? itemImportNote.value : ''
  itemImportBusy.value = true
  try {
    /* 服务层单点：按单行（`importId`）优先；否则按批次（`batchId`）。回包 `message` 原文上屏。 */
    const options = dialog.row
      ? { importId: String(dialog.row.id || ''), decision: dialog.decision, note }
      : { batchId: String((dialog.batch && dialog.batch.batchId) || ''), decision: dialog.decision, note }
    const outcome = await runImportReviewLoop(items.reviewItemImport, options)
    feedback.value = outcome.message
    itemImportDialog.value = null
    /* **形態①**：審核循環結束 ⇒ **重新取行**（內存刷新）；**不**靠雲快照 / `dataVersion` 重讀舊數據。 */
    if (isLocalImportFace()) await refreshLocalImportRows()
    dataVersion.value += 1
  } finally {
    itemImportBusy.value = false
  }
}

/** 我的提交（所有登录用户都能看到自己的记录）。 */
const rows = computed(() => {
  void dataVersion.value
  return corrections.listMyCorrections()
})
const summary = computed(() => corrections.summarizeCorrections(rows.value))

/** 管理员：全部用户的待审勘误。服务层返回**结构化结果**（`{ok:true,rows}` /
 *  `{ok:false,reason,message}`）—— 这里按 `result.ok ? result.rows : []` 取数，
 *  并把 `message` 作为可读空态文案渲染（见模板 `data-correction-queue-notice`），**不静默**。 */
const pendingResult = computed(() => {
  void dataVersion.value
  return corrections.listPendingForAdmin(actor.value)
})
/** 队列读数：拒绝时为空集（**不把「拒绝」渲染成「就是没有数据」**）。 */
const queue = computed(() => (pendingResult.value.ok ? pendingResult.value.rows : []))
/** 队列拒绝理由（正常路径为空串）；模板里作为可读文案展示，不做静默吞掉。 */
const queueNotice = computed(() => (pendingResult.value.ok ? '' : pendingResult.value.message))

/* --------------------------------------------------------------------------
   按提交单（batch）分组 + 组级批量审核（R-B3 / R-B4 / R-B7）
   --------------------------------------------------------------------------
   分组口径**只在服务层**（`listPendingBatchesForAdmin`）；视图层不另写第二套。
   组级按钮 `data-admin-action` **复用** `correction-accept` / `correction-reject`
   ⇒ `[data-admin-action]` 取值集合不变；另加 `data-action` / `data-correction-batch` 区分。
   -------------------------------------------------------------------------- */
const batchResult = computed(() => {
  void dataVersion.value
  return corrections.listPendingBatchesForAdmin(actor.value)
})
/** 待审提交单（拒绝 ⇒ 空集，**不把「拒绝」渲染成「就是没有数据」**）。 */
const batches = computed(() => (batchResult.value.ok ? batchResult.value.batches : []))
/** 待审条数合计（用于标题读数）。 */
const batchRowCount = computed(() => batches.value.reduce((sum, batch) => sum + batch.count, 0))

/** 批量审核的二次确认状态（`null` ＝ 未打开）。 */
const batchDialog = ref(null)
/** 批量驳回的可选理由（≤200 字；默认空 ⇒ 不落 `review_note`）。 */
const batchNote = ref('')
const batchBusy = ref(false)

function askBatch(batch, decision) {
  batchNote.value = ''
  batchDialog.value = { batch, decision }
}

function cancelBatch() {
  batchDialog.value = null
}

const batchConfirmText = computed(() =>
  batchDialog.value && batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED ? '確認採納' : '確認駁回'
)
const batchDialogTitle = computed(() => {
  if (!batchDialog.value) return ''
  return batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED ? '全部採納' : '全部駁回'
})
const batchDialogMessage = computed(() => {
  if (!batchDialog.value) return ''
  const { batch, decision } = batchDialog.value
  const verb = decision === corrections.CORRECTION_STATUS.ACCEPTED ? '採納' : '駁回'
  return `這將對「${batch.submitterLabel}」本次提交的 ${batch.count} 條勘誤全部${verb}，此操作不可撤銷。`
})
/** 弹窗内按钮的 `data-action`（**只用 `data-action`**，不带 `data-admin-action`）。 */
const batchConfirmAction = computed(() => {
  if (!batchDialog.value) return ''
  return batchDialog.value.decision === corrections.CORRECTION_STATUS.ACCEPTED
    ? 'correction-batch-confirm-accept'
    : 'correction-batch-confirm-reject'
})
const BATCH_CANCEL_ACTION = 'correction-batch-cancel'

async function confirmBatch() {
  const dialog = batchDialog.value
  if (!dialog || batchBusy.value) return
  const note = dialog.decision === corrections.CORRECTION_STATUS.REJECTED ? batchNote.value : ''
  batchBusy.value = true
  try {
    /* V3：登录令牌写面门（必要时**静默补签**）由服务层单点承担 ⇒ 本页**直接批量审核**、零弹窗。 */
    const result = await corrections.reviewBatch(
      actor.value,
      dialog.batch.rows.map((row) => row.id),
      dialog.decision,
      note
    )
    feedback.value = result.message
    batchDialog.value = null
    dataVersion.value += 1
  } finally {
    batchBusy.value = false
  }
}

const reward = points.CORRECTION_REWARD

function sealLabel(sealId) {
  const seal = seals.getSealById(sealId)
  /* r2 显示名单点：采纳值 → 原始 seal_name →「佚名」（`corrections.resolveSealDisplayName`）；
     印章行缺失时才用「未知印章」。 */
  return seal ? corrections.resolveSealDisplayName(seal) : '未知印章'
}

function sealKeyOf(row) {
  return row.sealId || row.stamp_id
}

/** 勘误挂在印面上：列出所属印面，旧数据（无 faceId）按主印面标注。 */
function faceLabelOfRow(row) {
  return seals.faceLabelOf(row.faceId, sealKeyOf(row))
}

function statusClass(status) {
  if (status === corrections.CORRECTION_STATUS.ACCEPTED) return 'chip--adopted'
  if (status === corrections.CORRECTION_STATUS.REJECTED) return 'chip--rejected'
  return 'chip--pending'
}

function submitterOf(row) {
  /* **上屏不显示他人手机号**（人类口径 ④）：一律用服务层单点 `submitterLabelOf` ⇒
     `暱稱（uid 短碼）`；**不得**再拼 `user.phone`。 */
  return corrections.submitterLabelOf(row.user_id || row.userId)
}

/**
 * **提交值上屏**：`author` 自 person-model §4.2 起为**引用型**（值是 `author_person_id`）
 * ⇒ 经**显示名单点链**（`corrections.resolveAuthorDisplayName`：引用命中 ⇒ 印人名 →
 * 未命中 ⇒ 旧文本 →「佚名」）渲染为印人名，便于审核人判读；其余字段原样。
 * 历史行（值为旧自由文本）经同一链回落到原文本，不被吞掉。
 */
function valueLabelOf(row) {
  const value = row && row.value !== undefined && row.value !== null ? String(row.value) : ''
  if (row && row.field === 'author') {
    return corrections.resolveAuthorDisplayName({ author_person_id: value, author: value })
  }
  return value
}

/** 跑一次审核（服务层 `message` 原文展示）；结果原样回传供调用方判断。 */
async function runReview(row, decision) {
  const result = await corrections.review(actor.value, row.id, decision)
  feedback.value = result.message
  dataVersion.value += 1
  return result
}

/**
 * 采纳 / 驳回（单条）：V3 起**直接调** —— 登录令牌写面门在服务层单点承担
 * 「无令牌 ⇒ 静默补签」，**零弹窗、不需要第二个码**；dev / 離線形态亦零行为变化。
 */
async function decide(row, decision) {
  await runReview(row, decision)
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>我的勘誤記錄</h1>
      <p v-if="canReview">
        這裏列出你提交的全部勘誤；上方另列出全部用戶的待審覈勘誤，可直接採納或駁回。
        採納後提交者獲得 {{ reward }} 金獎勵，駁回不改變積分。
      </p>
      <p v-else>這裏列出你提交的全部勘誤，審覈通過後會獲得金獎勵。</p>
    </div>

    <p v-if="feedback" class="notice review__notice" data-review-feedback>{{ feedback }}</p>
    <!-- **E-4**：循環審核進度（`已處理 N · 剩餘 M`）；僅本機面且循環進行中才顯示。 -->
    <p
      v-if="isLocalImportFace() && importReviewProgress"
      class="notice review__notice"
      data-import-review-progress
    >{{ importReviewProgress }}</p>

    <section v-if="canReview" class="panel">
      <div class="panel__head">
        <h2>待審覈勘誤（全部用戶）</h2>
        <span class="muted-hint">共 {{ queue.length }} 條 · {{ batches.length }} 批</span>
      </div>
      <div class="panel__body">
        <!-- 按提交单（batch）分组：组级「全部採納 / 全部駁回」＋ 批内逐条按钮（保留）。
             组级按钮 `data-admin-action` **复用** correction-accept / correction-reject
             ⇒ `[data-admin-action]` 取值集合不变；另加 `data-action` ＋ `data-correction-batch` 区分。 -->
        <div v-if="batches.length" class="batch-list">
          <article
            v-for="batch in batches"
            :key="batch.key"
            class="batch"
            :data-correction-batch="batch.key"
            :data-correction-batch-id="batch.batchId"
            :data-correction-batch-count="batch.count"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">{{ batch.submitterLabel }}</strong>
                <span class="muted-hint">
                  · {{ sealLabel(batch.sealId) }} · {{ batch.faceLabel }} · {{ formatDateTime(batch.createdAt) }}
                </span>
                <span class="chip chip--pending">共 {{ batch.count }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="correction-accept"
                  data-action="correction-batch-accept"
                  :data-correction-batch="batch.key"
                  @click="askBatch(batch, corrections.CORRECTION_STATUS.ACCEPTED)"
                >
                  全部採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="correction-reject"
                  data-action="correction-batch-reject"
                  :data-correction-batch="batch.key"
                  @click="askBatch(batch, corrections.CORRECTION_STATUS.REJECTED)"
                >
                  全部駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印章</th>
                  <th>印面</th>
                  <th>屬性</th>
                  <th>提交值</th>
                  <th>提交人</th>
                  <th>提交時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>
                    <router-link
                      class="list-table__link"
                      :to="{ name: 'seal-detail', params: { id: sealKeyOf(row) } }"
                    >
                      {{ sealLabel(sealKeyOf(row)) }}
                    </router-link>
                    <span class="list-table__meta">{{ sealKeyOf(row) }}</span>
                  </td>
                  <td>{{ faceLabelOfRow(row) }}</td>
                  <td>{{ row.field_label || row.field }}</td>
                  <td>{{ valueLabelOf(row) }}</td>
                  <td>{{ submitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.created_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="correction-accept"
                      :data-correction-id="row.id"
                      @click="decide(row, corrections.CORRECTION_STATUS.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="correction-reject"
                      :data-correction-id="row.id"
                      @click="decide(row, corrections.CORRECTION_STATUS.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="queueNotice" class="notice review__notice" data-correction-queue-notice>
          {{ queueNotice }}
        </p>
        <p v-else class="muted-hint">當前沒有待審覈的勘誤。</p>
      </div>
    </section>

    <!-- **印人提案审核区块（本单新增）**：管理员专属（非管理员 ⇒ 不渲染，DOM 零命中）；
         采纳 / 驳回复用既有按钮形态；**不新开路由 / 专区**（落点＝本页，沿 §3.9 追加注（v1.53））。
         钩子族新增**恰 1 个**取值 `person-proposal-review`（采纳 / 驳回共用，不复用既有字面值）。 -->
    <section v-if="canReviewProposals" class="panel">
      <div class="panel__head">
        <h2>待審印人提案（全部用戶）</h2>
        <span class="muted-hint">共 {{ proposals.length }} 條</span>
      </div>
      <div class="panel__body">
        <table v-if="proposals.length" class="list-table">
          <thead>
            <tr>
              <th>印人</th>
              <th>姓</th>
              <th>名</th>
              <th>字 / 號 / 別名</th>
              <th>生卒</th>
              <th>提交人</th>
              <th>提交時間</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in proposals" :key="row.id">
              <td>{{ proposalNameOf(row) || '（未命名）' }}</td>
              <td>{{ row.family_name || '—' }}</td>
              <td>{{ row.given_name || '—' }}</td>
              <td>
                {{ [...(row.courtesy_names || []), ...(row.art_names || []), ...(row.alias_names || [])].join('、') || '—' }}
              </td>
              <td>{{ proposalYearsOf(row) }}</td>
              <td>{{ proposalSubmitterOf(row) }}</td>
              <td>{{ formatDateTime(row.submitted_at) }}</td>
              <td class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-proposal-review"
                  data-action="person-proposal-accept"
                  :data-person-proposal-id="row.id"
                  @click="decideProposal(row, persons.PERSON_STATUS.ACCEPTED)"
                >
                  採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-proposal-review"
                  data-action="person-proposal-reject"
                  :data-person-proposal-id="row.id"
                  @click="decideProposal(row, persons.PERSON_STATUS.REJECTED)"
                >
                  駁回
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="proposalNotice" class="notice review__notice" data-person-proposal-notice>
          {{ proposalNotice }}
        </p>
        <p v-else class="muted-hint">當前沒有待審覈的印人提案。</p>
      </div>
    </section>

    <!-- **待審導入批次審核區塊（印人批 2 ＋ 印章批 3 ＋ 印谱批 4｜同屏合并）**：管理员专属（非管理员 ⇒ 不渲染，DOM 零命中）；
         采纳 / 驳回复用既有按钮形态与**二次确认体例（沿 §3.44.10 / W-78）**；不新开路由 / 专区。
         **三类导入行同屏**（印人导入 ＋ 印章导入 ＋ 印谱导入），**共用同一钩子值** `person-import-review`
         （采纳 / 驳回共用，不复用既有字面值，也不新增取值 ⇒ 取值集合不增）。
         粒度（W-77）：按批次（整批）＋ 按单行（逐条）两个入口都实现（三类同型）。 -->
    <section v-if="isLocalImportFace() && (canReviewImports || canReviewSealImports || canReviewItemImports)" class="panel">
      <div class="panel__head">
        <h2>待審導入批次（外部批量導入）</h2>
        <span class="muted-hint">印人導入 共 {{ importRows.length }} 條 · {{ importBatches.length }} 批</span>
        <span class="muted-hint">印章導入 共 {{ sealImportRows.length }} 條 · {{ sealImportBatches.length }} 批</span>
        <span class="muted-hint">印谱導入 共 {{ itemImportRows.length }} 條 · {{ itemImportBatches.length }} 批</span>
      </div>
      <div class="panel__body">
        <!-- **形態①（E-3 取行）**：本機面下三族待審行來自 `pullImportRows` 取回結果（**僅內存**）。
             未取完時如實上屏「已取 N 條（可能還有更多）」；取行失敗如實上屏（**不靜默、不以空集冒充**）。
             「重新取行」＝ 手動刷新（刷新即重取；不持久化）。 -->
        <p v-if="localImportPullNotice" class="notice review__notice" data-import-pull-notice>
          {{ localImportPullNotice }}
        </p>
        <div class="review__ops">
          <button
            class="btn btn--ghost"
            type="button"
            data-import-pull-refresh
            :disabled="localImportLoading"
            @click="refreshLocalImportRows"
          >
            {{ localImportLoading ? '取行中…' : '重新取行' }}
          </button>
        </div>
        <div v-if="importBatches.length" class="batch-list">
          <article
            v-for="batch in importBatches"
            :key="batch.key"
            class="batch"
            :data-person-import-batch="batch.key"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">批次 {{ batch.batchId || '（無批次）' }}</strong>
                <span class="chip chip--pending">共 {{ batch.rows.length }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="person-import-accept"
                  :data-person-import-batch="batch.key"
                  @click="askImport({ batch }, persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED)"
                >
                  整批採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="person-import-reject"
                  :data-person-import-batch="batch.key"
                  @click="askImport({ batch }, persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED)"
                >
                  整批駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印人</th>
                  <th>姓</th>
                  <th>名</th>
                  <th>來源 id</th>
                  <th>導入人</th>
                  <th>導入時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>{{ importNameOf(row) || '（未命名）' }}</td>
                  <td>{{ row.family_name || '—' }}</td>
                  <td>{{ row.given_name || '—' }}</td>
                  <td>{{ importSourceIdOf(row) }}</td>
                  <td>{{ importSubmitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.imported_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="person-import-accept"
                      :data-person-import-id="row.id"
                      @click="askImport({ row }, persons.PERSON_IMPORT_STATUS_EXPORT.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="person-import-reject"
                      :data-person-import-id="row.id"
                      @click="askImport({ row }, persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="importNotice" class="notice review__notice" data-person-import-notice>
          {{ importNotice }}
        </p>

        <!-- **印章導入（第二类｜同屏、共用同一钩子值 `person-import-review`）**：
             待审源 ＝ `seals.listPendingSealImportsForAdmin`；采纳 / 驳回走 `seals.reviewSealImport`。 -->
        <div v-if="sealImportBatches.length" class="batch-list" data-seal-import-list>
          <article
            v-for="batch in sealImportBatches"
            :key="'seal:' + batch.key"
            class="batch"
            :data-seal-import-batch="batch.key"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">批次 {{ batch.batchId || '（無批次）' }}</strong>
                <span class="chip chip--pending">共 {{ batch.rows.length }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="seal-import-accept"
                  :data-seal-import-batch="batch.key"
                  @click="askSealImport({ batch }, seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED)"
                >
                  整批採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="seal-import-reject"
                  :data-seal-import-batch="batch.key"
                  @click="askSealImport({ batch }, seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED)"
                >
                  整批駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印章</th>
                  <th>來源 id</th>
                  <th>印面數</th>
                  <th>導入人</th>
                  <th>導入時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in batch.rows" :key="row.id">
                  <td>{{ sealImportNameOf(row) || '（未命名）' }}</td>
                  <td>{{ sealImportSourceIdOf(row) }}</td>
                  <td>{{ sealImportFaceCountOf(row) }}</td>
                  <td>{{ sealImportSubmitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.imported_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="seal-import-accept"
                      :data-seal-import-id="row.id"
                      @click="askSealImport({ row }, seals.SEAL_IMPORT_STATUS_EXPORT.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="seal-import-reject"
                      :data-seal-import-id="row.id"
                      @click="askSealImport({ row }, seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="sealImportNotice" class="notice review__notice" data-seal-import-notice>
          {{ sealImportNotice }}
        </p>

        <!-- **印谱導入（第三類｜同屏、共用同一钩子值 `person-import-review`）**：
             待审源 ＝ `items.listPendingItemImportsForAdmin`；采纳 / 驳回走 `items.reviewItemImport`。
             列面**只展示正字段（繁体）**（`title` / `as_book_id` / `volume_count` / `date_text`），
             **不展示 `*_chs` 副字段**；终态行照常上屏并置灰（`is-terminal`）。 -->
        <div v-if="itemImportBatches.length" class="batch-list" data-item-import-list>
          <article
            v-for="batch in itemImportBatches"
            :key="'item:' + batch.key"
            class="batch"
            :data-item-import-batch="batch.key"
          >
            <header class="batch__head">
              <div class="batch__meta">
                <strong class="batch__submitter">批次 {{ batch.batchId || '（無批次）' }}</strong>
                <span class="chip chip--pending">共 {{ batch.rows.length }} 條</span>
              </div>
              <div class="review__ops">
                <button
                  class="btn btn--primary"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="item-import-accept"
                  :data-item-import-batch="batch.key"
                  @click="askItemImport({ batch }, items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED)"
                >
                  整批採納
                </button>
                <button
                  class="btn btn--ghost"
                  type="button"
                  data-admin-action="person-import-review"
                  data-action="item-import-reject"
                  :data-item-import-batch="batch.key"
                  @click="askItemImport({ batch }, items.ITEM_IMPORT_STATUS_EXPORT.REJECTED)"
                >
                  整批駁回
                </button>
              </div>
            </header>
            <table class="list-table">
              <thead>
                <tr>
                  <th>印譜</th>
                  <th>書號</th>
                  <th>卷數</th>
                  <th>年代</th>
                  <th>來源 id</th>
                  <th>導入人</th>
                  <th>導入時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in batch.rows"
                  :key="row.id"
                  :data-item-import-status="row.status"
                  :class="{ 'is-terminal': itemImportIsTerminal(row) }"
                >
                  <td>{{ itemImportTitleOf(row) || '（未命名）' }}</td>
                  <td>{{ row.as_book_id || '—' }}</td>
                  <td>{{ itemImportVolumeCountOf(row) }}</td>
                  <td>{{ itemImportDateTextOf(row) }}</td>
                  <td>{{ itemImportSourceIdOf(row) }}</td>
                  <td>{{ itemImportSubmitterOf(row) }}</td>
                  <td>{{ formatDateTime(row.imported_at) }}</td>
                  <td class="review__ops">
                    <button
                      class="btn btn--primary"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="item-import-accept"
                      :data-item-import-id="row.id"
                      @click="askItemImport({ row }, items.ITEM_IMPORT_STATUS_EXPORT.ACCEPTED)"
                    >
                      採納
                    </button>
                    <button
                      class="btn btn--ghost"
                      type="button"
                      data-admin-action="person-import-review"
                      data-action="item-import-reject"
                      :data-item-import-id="row.id"
                      @click="askItemImport({ row }, items.ITEM_IMPORT_STATUS_EXPORT.REJECTED)"
                    >
                      駁回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </article>
        </div>
        <p v-else-if="itemImportNotice" class="notice review__notice" data-item-import-notice>
          {{ itemImportNotice }}
        </p>

        <!-- **合并空态**：三类皆空、无提示文案、且**取行已落定**（非取行中）时才显示（可读、繁體、不白屏）。 -->
        <p
          v-if="localImportPulled && !localImportLoading && !importBatches.length && !sealImportBatches.length && !itemImportBatches.length && !importNotice && !sealImportNotice && !itemImportNotice && !localImportPullNotice"
          class="muted-hint"
          data-import-empty
        >
          當前沒有待審覈的印人 / 印章 / 印谱外部導入批次。
        </p>
      </div>
    </section>

    <!-- 批量审核二次确认（复用 ConfirmDialog；显式、可取消、默认不通过；文案写明批内条数 ＋ 提交人）。
         批量驳回时弹窗内提供**可选**理由（textarea，≤200 字）；弹窗按钮**只用 `data-action`**。 -->
    <ConfirmDialog
      v-if="batchDialog"
      :title="batchDialogTitle"
      :message="batchDialogMessage"
      :confirm-text="batchConfirmText"
      :confirm-action="batchConfirmAction"
      :cancel-action="BATCH_CANCEL_ACTION"
      @confirm="confirmBatch"
      @cancel="cancelBatch"
    >
      <div
        v-if="batchDialog.decision === corrections.CORRECTION_STATUS.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="correction-batch-note">駁回理由（可選，最多 200 字）</label>
        <textarea
          id="correction-batch-note"
          v-model="batchNote"
          class="batch__note-input"
          maxlength="200"
          rows="3"
          data-correction-batch-note
        ></textarea>
        <span class="batch__note-hint">填寫後將一併記錄到該批每條勘誤，提交者可在「我的提交」中看到。</span>
      </div>
    </ConfirmDialog>

    <!-- **導入批次審核的二次确认（本单新增）**：显式、可取消、默认不通过；文案写明粒度 ＋ 条数；
         驳回时提供**可选**理由（≤200 字）；弹窗按钮**只用 `data-action`**（不带 `data-admin-action`）。 -->
    <ConfirmDialog
      v-if="importDialog"
      :title="importDialogTitle"
      :message="importDialogMessage"
      :confirm-text="importConfirmText"
      :confirm-action="importConfirmAction"
      :cancel-action="IMPORT_CANCEL_ACTION"
      @confirm="confirmImport"
      @cancel="cancelImport"
    >
      <div
        v-if="importDialog.decision === persons.PERSON_IMPORT_STATUS_EXPORT.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="person-import-note">駁回理由（可選，最多 200 字）</label>
        <textarea
          id="person-import-note"
          v-model="importNote"
          class="batch__note-input"
          maxlength="200"
          rows="3"
          data-person-import-note
        ></textarea>
      </div>
    </ConfirmDialog>

    <!-- **印章導入審核的二次确认（本单新增）**：显式、可取消、默认不通过；文案写明粒度 ＋ 条数；
         驳回理由上限引服务层单点 `MAX_SEAL_REVIEW_NOTE_LENGTH`；弹窗按钮**只用 `data-action`**。 -->
    <ConfirmDialog
      v-if="sealImportDialog"
      :title="sealImportDialogTitle"
      :message="sealImportDialogMessage"
      :confirm-text="sealImportConfirmText"
      :confirm-action="sealImportConfirmAction"
      :cancel-action="SEAL_IMPORT_CANCEL_ACTION"
      @confirm="confirmSealImport"
      @cancel="cancelSealImport"
    >
      <div
        v-if="sealImportDialog.decision === seals.SEAL_IMPORT_STATUS_EXPORT.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="seal-import-note">駁回理由（可選，最多 {{ SEAL_IMPORT_NOTE_MAX }} 字）</label>
        <textarea
          id="seal-import-note"
          v-model="sealImportNote"
          class="batch__note-input"
          :maxlength="SEAL_IMPORT_NOTE_MAX"
          rows="3"
          data-seal-import-note
        ></textarea>
      </div>
    </ConfirmDialog>

    <!-- **印谱導入審核的二次确认（本单新增）**：显式、可取消、默认不通过；文案写明粒度 ＋ 条数；
         驳回理由上限引服务层单点 `MAX_ITEM_REVIEW_NOTE_LENGTH`；弹窗按钮**只用 `data-action`**。 -->
    <ConfirmDialog
      v-if="itemImportDialog"
      :title="itemImportDialogTitle"
      :message="itemImportDialogMessage"
      :confirm-text="itemImportConfirmText"
      :confirm-action="itemImportConfirmAction"
      :cancel-action="ITEM_IMPORT_CANCEL_ACTION"
      @confirm="confirmItemImport"
      @cancel="cancelItemImport"
    >
      <div
        v-if="itemImportDialog.decision === items.ITEM_IMPORT_STATUS_EXPORT.REJECTED"
        class="batch__note"
      >
        <label class="batch__note-label" for="item-import-note">駁回理由（可選，最多 {{ ITEM_IMPORT_NOTE_MAX }} 字）</label>
        <textarea
          id="item-import-note"
          v-model="itemImportNote"
          class="batch__note-input"
          :maxlength="ITEM_IMPORT_NOTE_MAX"
          rows="3"
          data-item-import-note
        ></textarea>
      </div>
    </ConfirmDialog>

    <section v-if="rows.length" class="panel">
      <div class="panel__head">
        <h2>我的提交</h2>
      </div>
      <div class="panel__body">
        <div class="stat-row">
          <div class="stat">
            <span class="stat__num">{{ summary.total }}</span>
            <span class="stat__label">累計提交</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.pending }}</span>
            <span class="stat__label">待審覈</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.accepted }}</span>
            <span class="stat__label">已採納</span>
          </div>
          <div class="stat">
            <span class="stat__num">{{ summary.rejected }}</span>
            <span class="stat__label">駁回</span>
          </div>
        </div>

        <table class="list-table">
          <thead>
            <tr>
              <th>印章</th>
              <th>印面</th>
              <th>屬性</th>
              <th>提交值</th>
              <th>依據</th>
              <th>狀態</th>
              <th>提交時間</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>
                <router-link class="list-table__link" :to="{ name: 'seal-detail', params: { id: sealKeyOf(row) } }">
                  {{ sealLabel(sealKeyOf(row)) }}
                </router-link>
                <span class="list-table__meta">{{ sealKeyOf(row) }}</span>
              </td>
              <td>{{ faceLabelOfRow(row) }}</td>
              <td>{{ row.field_label || row.field }}</td>
              <td>{{ valueLabelOf(row) }}</td>
              <td>{{ row.basis || '—' }}</td>
              <td>
                <span class="chip" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span>
                <!-- R-B11：驳回理由（`review_note`）在狀態列内附一行弱化说明；有才渲染。 -->
                <span v-if="row.review_note" class="review__note" data-correction-note>{{ row.review_note }}</span>
              </td>
              <td>{{ formatDateTime(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <PlaceholderPanel
      v-else
      glyph="勘"
      title="暫無勘誤記錄"
      desc="在印章詳情頁對可標記屬性提交勘誤後，會在此處顯示審覈進度。"
    >
      <router-link class="btn btn--ghost" :to="{ name: 'square' }">去璽印匯類看看</router-link>
    </PlaceholderPanel>
  </section>
</template>

<style scoped>
.review__notice {
  margin-bottom: var(--s-4);
}

.muted-hint {
  color: var(--c-text-muted);
  font-size: var(--t-sm);
}

.review__ops {
  display: flex;
  gap: var(--s-2);
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  padding: var(--s-4);
  background: var(--c-surface);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
}

.stat__num {
  font-family: var(--font-serif);
  font-size: var(--t-2xl);
  color: var(--c-brand-strong);
}

.stat__label {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

.list-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}

.list-table th,
.list-table td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--c-line);
  text-align: left;
  vertical-align: top;
}

.list-table th {
  color: var(--c-text-muted);
  font-weight: 500;
}

.list-table__link {
  color: var(--c-text);
  text-decoration: underline;
}

.list-table__meta {
  display: block;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* 终态導入行（`ACCEPTED` / `REJECTED`）置灰标记（**不因终态而报错**）。 */
.is-terminal {
  opacity: 0.55;
}

.chip {
  display: inline-block;
  padding: 1px var(--s-2);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-sm);
  font-size: var(--t-xs);
  white-space: nowrap;
}

.chip--pending {
  background: var(--c-gold-soft);
  border-color: var(--c-gold);
  color: var(--c-gold-strong);
}

.chip--adopted {
  background: var(--c-brand-soft);
  border-color: var(--c-brand);
  color: var(--c-brand-strong);
}

.chip--rejected {
  color: var(--c-text-muted);
}

/* 按提交单分组（批量审核） */
.batch-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.batch {
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.batch__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  flex-wrap: wrap;
  padding: var(--s-3) var(--s-3);
  background: var(--c-surface-sunken);
  border-bottom: 1px solid var(--c-line);
}

.batch__meta {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.batch__submitter {
  color: var(--c-text);
}

.batch__note {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  margin-top: var(--s-3);
}

.batch__note-label {
  color: var(--c-text);
  font-size: var(--t-sm);
}

.batch__note-input {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--c-line-strong);
  border-radius: var(--r-md);
  font: inherit;
  resize: vertical;
}

.batch__note-hint {
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}

/* 驳回理由弱化说明（R-B11：狀態列内附一行） */
.review__note {
  display: block;
  margin-top: 2px;
  color: var(--c-text-muted);
  font-size: var(--t-xs);
}
</style>
