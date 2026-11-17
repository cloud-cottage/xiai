/**
 * 玺爱 · **封面四級回落（本單）離線自檢**（Kong｜離線、零網絡、零真實雲端）
 * ============================================================================
 * 被測真源（**一字不改地 import 倉內文件**，不複製實現）：
 *   · `src/services/sealCards.js` —— `originalDisplayKeyOf` / `coverKeyChainOf` /
 *     `coverEscalationOf` / `cardCoverUrl` / `coverPlaceholderUrl` / `coverKeyOf`。
 *
 * 四條驗收（逐條對應派單）：
 *   ① 行上 thumb 缺、display 缺、**有 `original_storage_key`** ⇒ 鍵鏈回 `original` 鍵
 *      （另測「只有 `original_sha256`」⇒ 派生 `xiai/images/<sha2>/<sha>.png`）；
 *   ② 三級全缺 ⇒ 鍵鏈 `[]`、`MISSING_REQUIRED`，且**本地占位圖 URL 非空**（占位級真的有圖）；
 *   ③ **無 `original_*` 的行 ⇒ 行為與改前逐字一致**：把改前實現（`preChainOf` / `preEscalationOf`，
 *      逐字抄錄本單改前的 `coverKeyChainOf` / `SealCard.onCoverImageError` 判定）與現實現
 *      在同一批行上逐項對拍，並打印改前／改後對照；
 *   ④ **`@error` 台階順序**：thumb 壞 → display → original → 占位 → 字形，**不得跳級**
 *      （逐步斷言 `coverEscalationOf` 的 `step` / `via` / `stage`）。
 *
 * 纪律：不打印任何令牌 / 手機號；不聯網（無云配置 ⇒ `cardCoverUrl` 必在取鏈前停住）；
 *       斷言失敗 ⇒ 退出碼非 0。
 *
 * 用法：node tests/kong-cover-four-stage.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const target = (rel) => pathToFileURL(path.join(ROOT, rel)).href

/* ---------------------------------------------------------------------------
 * 0. 瀏覽器底座假體（`src/data/storage.js` 碰 `window.localStorage`；本探針只用純函數，
 *    但被 import 的模塊在頂層會摸到這些全局）
 * ------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
  key: (index) => Array.from(memory.keys())[index] ?? null,
  get length() {
    return memory.size
  }
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.window.location = globalThis.window.location || { origin: 'http://offline.test', pathname: '/' }

/* ---------------------------------------------------------------------------
 * 1. 斷言與讀數
 * ------------------------------------------------------------------------- */
let passed = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

const j = (value) => JSON.stringify(value)
const equal = (a, b) => j(a) === j(b)

/* ---------------------------------------------------------------------------
 * 2. 被測真源
 * ------------------------------------------------------------------------- */
const sealCards = await import(target('src/services/sealCards.js'))

const {
  originalDisplayKeyOf,
  coverKeyChainOf,
  coverEscalationOf,
  coverKeyOf,
  coverThumbKeyOf,
  coverDisplayKeyOf,
  coverPlaceholderUrl,
  cardCoverUrl
} = sealCards

/* ---------------------------------------------------------------------------
 * 3. 測試行（內容尋址鍵按真形態拼；sha 一律 64 位小寫十六進制）
 * ------------------------------------------------------------------------- */
const T_SHA = 'a1'.repeat(32) /* 轉碼後的 .tiff sha（當前行 sha） */
const O_SHA = 'b2'.repeat(32) /* 原圖 sha（original_sha256） */
const D_SHA = 'c3'.repeat(32) /* 展示件 sha（正常行） */

const keyOf = (sha, ext) => `xiai/images/${sha.slice(0, 2)}/${sha}.${ext}`
const thumbOf = (sha) => `xiai/thumb/${sha.slice(0, 2)}/${sha}.webp`

/** 轉碼行：thumb / display 皆缺（對象沒補上），但帶原圖兩字段。 */
const ROW_TRANSCODE = {
  stamp_id: 'S-TRANSCODE',
  thumb_key: '',
  display_key: '',
  sha256: T_SHA,
  storage_key: keyOf(T_SHA, 'tiff'),
  original_storage_key: keyOf(O_SHA, 'png'),
  original_sha256: O_SHA
}
/** 只有 `original_sha256`（original_storage_key 缺位 ⇒ 按展示件形態派生）。 */
const ROW_ONLY_ORIG_SHA = { stamp_id: 'S-ONLY-SHA', thumb_key: '', display_key: '', original_sha256: O_SHA }
/** 三級全缺（bundled 占位行 / 無影像行同形）。 */
const ROW_EMPTY = { stamp_id: 'S-EMPTY', thumb_key: '', display_key: '' }
/** 正常行（三級皆備）。 */
const ROW_FULL = {
  stamp_id: 'S-FULL',
  thumb_key: thumbOf(D_SHA),
  display_key: keyOf(D_SHA, 'png'),
  original_storage_key: keyOf(O_SHA, 'png'),
  original_sha256: O_SHA
}
/** 正常行（**無** `original_*`）—— 改前／改後必須逐字一致的那一族。 */
const ROW_PLAIN = { stamp_id: 'S-PLAIN', thumb_key: thumbOf(D_SHA), display_key: keyOf(D_SHA, 'png') }
/** 只有縮略件（無展示件、無原圖）。 */
const ROW_THUMB_ONLY = { stamp_id: 'S-THUMB', thumb_key: thumbOf(D_SHA), display_key: '' }
/** 畸形原圖鍵（`.tiff` / 私有前綴）＋ 合法原圖摘要 ⇒ 走派生（不拿 .tiff 當展示件）。 */
const ROW_BAD_ORIG_KEY = {
  stamp_id: 'S-BAD-ORIG',
  thumb_key: '',
  display_key: '',
  original_storage_key: keyOf(O_SHA, 'tiff'),
  original_sha256: O_SHA
}
/** 畸形的兩個原圖字段都在 ⇒ 第三級不存在（不猜鍵）。 */
const ROW_GARBAGE_ORIG = {
  stamp_id: 'S-GARBAGE',
  thumb_key: '',
  display_key: '',
  original_storage_key: 'xiai/originals/x/y.png',
  original_sha256: 'not-a-sha'
}

/* ---------------------------------------------------------------------------
 * 4. 改前實現（逐字抄錄；**只為對拍**，不參與生產）
 *    · `preChainOf` ＝ 本單改前的 `coverKeyChainOf`（兩級）
 *    · `preEscalationOf` ＝ 本單改前的 `SealCard.onCoverImageError` 判定（thumb → display → 占位 → 字形）
 * ------------------------------------------------------------------------- */
const keyShapeOk = (key) =>
  /^xiai\/images\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|webp|jpg|jpeg)$/.test(key) ||
  /^xiai\/thumb\/([0-9a-f]{2})\/([0-9a-f]{64})\.webp$/.test(key)

function preChainOf(card, options = {}) {
  const prefer = String((options && options.via) || '').trim()
  const thumb = String((card && card.thumb_key) || '').trim()
  const display = String((card && card.display_key) || '').trim()
  const chain = []
  if (prefer !== 'display' && thumb && keyShapeOk(thumb)) chain.push({ via: 'thumb', key: thumb })
  if (display && keyShapeOk(display) && (prefer === 'display' || display !== thumb)) {
    chain.push({ via: 'display', key: display })
  }
  return chain
}

function preEscalationOf(stage, card) {
  const current = Number.isFinite(Number(stage)) ? Math.max(0, Math.floor(Number(stage))) : 0
  if (current === 0 && String((card && card.display_key) || '').trim()) {
    return { step: 'display', via: 'display', stage: 1 }
  }
  if (current <= 1) return { step: 'placeholder', via: '', stage: 2 }
  return { step: 'glyph', via: '', stage: 2 }
}

/** 台階連走（`<img @error>` 連環失敗）：每一步「這一級壞了」就問下一級，直到占位／字形。 */
function walkSteps(escalate, card, startStage = 0) {
  const seen = []
  let stage = startStage
  for (let guard = 0; guard < 6; guard += 1) {
    const next = escalate(stage, card)
    seen.push({ step: next.step, via: next.via })
    if (next.step === 'glyph') break
    stage = next.stage
  }
  return seen
}

/* ---------------------------------------------------------------------------
 * 5. ① 有 `original_storage_key` ⇒ 第三級（原始件）
 * ------------------------------------------------------------------------- */
console.log('\n[①] thumb 缺 ＋ display 缺 ＋ 有 original_storage_key ⇒ 回 original 鍵')
{
  const expectedKey = keyOf(O_SHA, 'png')
  const chain = coverKeyChainOf(ROW_TRANSCODE)
  check('鍵鏈恰一級且 via=original', equal(chain, [{ via: 'original', key: expectedKey }]), j(chain))
  check('推導鍵 ≡ 行上 original_storage_key（直用）', originalDisplayKeyOf(ROW_TRANSCODE) === expectedKey, expectedKey)
  check('coverKeyOf 仍是兩級語義（不改對外形狀）', coverKeyOf(ROW_TRANSCODE) === '', j(coverKeyOf(ROW_TRANSCODE)))
  check('coverThumbKeyOf / coverDisplayKeyOf 仍回空串', coverThumbKeyOf(ROW_TRANSCODE) === '' && coverDisplayKeyOf(ROW_TRANSCODE) === '')

  const onlySha = originalDisplayKeyOf(ROW_ONLY_ORIG_SHA)
  check(
    '只有 original_sha256 ⇒ 派生 xiai/images/<sha2>/<sha>.png',
    onlySha === `xiai/images/${O_SHA.slice(0, 2)}/${O_SHA}.png`,
    onlySha
  )
  check(
    '只有 original_sha256 的鍵鏈也是 original 級',
    equal(coverKeyChainOf(ROW_ONLY_ORIG_SHA), [{ via: 'original', key: onlySha }]),
    j(coverKeyChainOf(ROW_ONLY_ORIG_SHA))
  )

  const bad = originalDisplayKeyOf(ROW_BAD_ORIG_KEY)
  check('original_storage_key 是 .tiff ⇒ 不直用，改走摘要派生', bad === keyOf(O_SHA, 'png'), bad)
  check('兩原圖字段皆畸形 ⇒ 第三級不存在（不猜鍵）', originalDisplayKeyOf(ROW_GARBAGE_ORIG) === '', j(originalDisplayKeyOf(ROW_GARBAGE_ORIG)))
  check('畸形行鍵鏈為空（無一級可出網）', coverKeyChainOf(ROW_GARBAGE_ORIG).length === 0)

  /* 取鏈入口：這一級真的被走到（離線無雲 ⇒ 停在取鏈前，回 STORAGE_UNAVAILABLE 而**不是** MISSING_REQUIRED） */
  const got = await cardCoverUrl(ROW_TRANSCODE)
  check(
    'cardCoverUrl 未在「三鍵皆空」處短路（走到取鏈面）',
    got.ok === false && got.reason === 'STORAGE_UNAVAILABLE',
    `${got.ok} / ${got.reason}`
  )
  const gotOriginal = await cardCoverUrl(ROW_TRANSCODE, { via: 'original' })
  check(
    'cardCoverUrl({via:"original"}) 同樣走到取鏈面',
    gotOriginal.ok === false && gotOriginal.reason === 'STORAGE_UNAVAILABLE',
    `${gotOriginal.reason}`
  )
}

/* ---------------------------------------------------------------------------
 * 6. ② 三級全缺 ⇒ 占位圖（第四級）
 * ------------------------------------------------------------------------- */
console.log('\n[②] 三級全缺 ⇒ 本地占位圖')
{
  const chain = coverKeyChainOf(ROW_EMPTY)
  check('鍵鏈為空', chain.length === 0, j(chain))
  const got = await cardCoverUrl(ROW_EMPTY)
  check('cardCoverUrl 回 MISSING_REQUIRED（不造假 URL）', got.ok === false && got.reason === 'MISSING_REQUIRED', `${got.reason}`)
  const placeholder = coverPlaceholderUrl()
  check('本地占位圖 URL 非空（base 感知資產）', placeholder !== '', placeholder)
  const step = coverEscalationOf(0, ROW_EMPTY)
  check('台階 0 ⇒ 直接進占位級（第三級不存在，非跳級）', step.step === 'placeholder' && step.stage === 3, j(step))
  const denialOriginal = await cardCoverUrl(ROW_EMPTY, { via: 'original' })
  check(
    '無原圖字段時 via:"original" 仍回 MISSING_REQUIRED',
    denialOriginal.ok === false && denialOriginal.reason === 'MISSING_REQUIRED',
    denialOriginal.reason
  )
}

/* ---------------------------------------------------------------------------
 * 7. ③ 無 `original_*` 的行 ⇒ 與改前**逐字一致**（改前／改後對拍）
 * ------------------------------------------------------------------------- */
console.log('\n[③] 無 original_* 的行 ⇒ 行為與改前逐字一致')
{
  const rows = [
    ['ROW_PLAIN（thumb+display）', ROW_PLAIN],
    ['ROW_THUMB_ONLY（僅 thumb）', ROW_THUMB_ONLY],
    ['ROW_EMPTY（三級全缺）', ROW_EMPTY]
  ]
  const table = []
  for (const [name, row] of rows) {
    for (const via of ['', 'display']) {
      const before = preChainOf(row, { via })
      const after = coverKeyChainOf(row, { via })
      const same = equal(before, after)
      table.push(`${name} via=${via || '(默認)'}\n      改前: ${j(before)}\n      改後: ${j(after)}${same ? '' : '   ← 不一致'}`)
      check(`鍵鏈逐字一致 · ${name} · via=${via || '(默認)'}`, same)
    }
    const beforeEsc = walkSteps(preEscalationOf, row)
    const afterEsc = walkSteps(coverEscalationOf, row)
    check(`台階序列逐字一致（step/via）· ${name}`, equal(beforeEsc, afterEsc), `${j(beforeEsc)} vs ${j(afterEsc)}`)
  }
  for (const line of table) console.log(`    · ${line}`)
  check('ROW_PLAIN 第三級不存在（originalDisplayKeyOf 空）', originalDisplayKeyOf(ROW_PLAIN) === '')
  check('ROW_PLAIN 鍵鏈無 original 級', coverKeyChainOf(ROW_PLAIN).every((item) => item.via !== 'original'))
}

/* ---------------------------------------------------------------------------
 * 8. ④ `@error` 台階順序（不得跳級）
 * ------------------------------------------------------------------------- */
console.log('\n[④] @error 台階順序：thumb 壞 → display → original → 占位 → 字形')
{
  /** 模擬 `<img @error>` 連環失敗：從 stage 0 起，每次「這一級壞了」就問下一級（帶台階編號）。 */
  const walk = (card, startStage = 0) => {
    const seen = []
    let stage = startStage
    for (let guard = 0; guard < 6; guard += 1) {
      const next = coverEscalationOf(stage, card)
      seen.push({ step: next.step, via: next.via, stage: next.stage })
      if (next.step === 'glyph') break
      stage = next.stage
    }
    return seen
  }

  const full = walk(ROW_FULL)
  check(
    '全鍵行：display → original → placeholder → glyph',
    equal(full.map((s) => s.step), ['display', 'original', 'placeholder', 'glyph']),
    j(full.map((s) => s.step))
  )
  check(
    '全鍵行：各級 via 次序 display → original → (空) → (空)',
    equal(full.map((s) => s.via), ['display', 'original', '', '']),
    j(full.map((s) => s.via))
  )
  check(
    '全鍵行：台階編號嚴格遞增（1 → 2 → 3 → 3，只前進不回退）',
    full[0].stage === 1 && full[1].stage === 2 && full[2].stage === 3 && full[3].stage === 3,
    j(full.map((s) => s.stage))
  )

  /* 不得跳級：只要行上有 display 鍵，stage 0 的下一步**必須**是 display（不得直跳 original / 占位）。 */
  const withDisplay = [ROW_FULL, ROW_PLAIN, ROW_THUMB_ONLY].filter((row) => String(row.display_key || '').trim() !== '')
  for (const row of withDisplay) {
    const first = coverEscalationOf(0, row)
    check(`有展示件鍵 ⇒ 第一步必須是 display · ${row.stamp_id}`, first.step === 'display' && first.stage === 1, j(first))
  }

  /* 不得跳級：display 級壞了（stage 1）而 original 級存在 ⇒ 下一步必須是 original（不得直跳占位）。 */
  const fromDisplay = coverEscalationOf(1, ROW_FULL)
  check('display 壞 ⇒ 下一步 original（不跳占位）', fromDisplay.step === 'original' && fromDisplay.stage === 2, j(fromDisplay))
  /* original 級壞了（stage 2）⇒ 才進占位。 */
  const fromOriginal = coverEscalationOf(2, ROW_FULL)
  check('original 壞 ⇒ 下一步 placeholder', fromOriginal.step === 'placeholder' && fromOriginal.stage === 3, j(fromOriginal))
  /* 占位圖自己壞了（stage 3）⇒ 字形空態，不再重試。 */
  const fromPlaceholder = coverEscalationOf(3, ROW_FULL)
  check('占位圖壞 ⇒ glyph（不再重試）', fromPlaceholder.step === 'glyph', j(fromPlaceholder))

  /* 顯示件缺但原圖在：thumb 壞 ⇒ 直降 original（這一級本來就沒有，非跳級）。 */
  const skipAbsent = walk(ROW_TRANSCODE)
  check(
    '無展示件鍵的轉碼行：thumb 壞 ⇒ original ⇒ 占位 ⇒ 字形',
    equal(skipAbsent.map((s) => s.step), ['original', 'placeholder', 'glyph']),
    j(skipAbsent.map((s) => s.step))
  )
  /* 無原圖字段的行：台階裡**永不**出現 original。 */
  const plainWalk = walk(ROW_PLAIN)
  check(
    '無 original_* 的行：永不進入 original 級',
    plainWalk.every((s) => s.via !== 'original') && equal(plainWalk.map((s) => s.step), ['display', 'placeholder', 'glyph']),
    j(plainWalk.map((s) => s.step))
  )

  /* 去重：原圖鍵與展示件鍵同鍵 ⇒ 第三級不入鏈（不重簽同一對象），但台階仍在 display 之後才問 original。 */
  const dup = { stamp_id: 'S-DUP', thumb_key: thumbOf(O_SHA), display_key: keyOf(O_SHA, 'png'), original_sha256: O_SHA, original_storage_key: keyOf(O_SHA, 'png') }
  const dupChain = coverKeyChainOf(dup)
  check('原圖鍵與展示件同鍵 ⇒ 鍵鏈去重（恰 thumb + display）', equal(dupChain, [
    { via: 'thumb', key: thumbOf(O_SHA) },
    { via: 'display', key: keyOf(O_SHA, 'png') }
  ]), j(dupChain))
}

/* ---------------------------------------------------------------------------
 * 9. 匯總
 * ------------------------------------------------------------------------- */
console.log(`\n通過 ${passed} 條；失敗 ${failures.length} 條`)
if (failures.length > 0) {
  console.log(`失敗清單：\n  · ${failures.join('\n  · ')}`)
  process.exit(1)
}
console.log('EXIT=0')
