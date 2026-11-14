/**
 * 玺爱 · **印人采纳写入接 CARD 主库自检**（`scripts/verify-card-adoption.mjs`）
 * ----------------------------------------------------------------------------
 * 本地、离线、零真网（假 CARD API ＋ 注入式假 DB）：直调云函数真源
 * `cloudfunctions/xiai-user-token/lib/ops.js` ＋ `lib/cardApi.js`。
 *
 * 判据（与派单口径逐条对应；id 前缀 `S*` ＝ 静态，`A*` ＝ 行为）：
 *   S1  `lib/cardApi.js` 零 `collection(` / `database(` / `console.` 字面（静态门 A8 / D4 同尺）；
 *   S2  `collection(` 仍**只**出现在 `lib/ops.js`（本函数内唯一持久化路径）；
 *   S3  `ADMIN_OPS` 仍恰 **41** 项；S4 `REASONS` 仍恰 **13** 个（**零新增**）；
 *   S5  三条写路径（提案 / 导入 / **修复**）各有一处「先 CARD、失败即整体取消」的写入门（静态 3/3 命中）；
 *   S6  `COLLECTIONS.serverSecrets` ＝ `xiai_server_secrets`（凭据集合登记且 `^xiai_` 前缀）；
 *   S7  `lib/cardApi.js` **零域名 / 网关串字面**（`verify-userwrite-pa` D4 同尺）＋ 基址为运行时配置；
 *   A1  提案采纳：CARD 成功 ⇒ 本地 `set` 落行且 `card_id` **来自 CARD 回包**（真 persist 后回读）；
 *   A2  CARD `UNAUTHORIZED` ⇒ 零本地写入 ＋ `UPSTREAM_ERROR`（提案行仍 `PENDING`）；
 *   A3  CARD 无响应（真超时 8s）⇒ 同上且**不挂死**（实测耗时 ≤ 8.5s）；
 *   A4  CARD 回既有 `person_id`（`created:false` 语义）⇒ **不重复建人**（零 `upsertPerson` 调用）；
 *   A5  导入采纳：CARD 成功 ⇒ 导入行翻 `ACCEPTED` ＋ 印人行 `card_id` 回填；
 *   A6  导入采纳：CARD 失败 ⇒ 零本地写入（导入行仍 `PENDING`）、`UPSTREAM_ERROR`；
 *   A7  两条路径全程**零计数器读写**（`xiai_counters` 零访问）；
 *   A8  密钥不出现在任何日志串 / 源码字面里（捕获 console 全量输出后断言）；
 *   A9  CARD 未配置 ⇒ **fail-closed 拒绝**（不静默降级成「只写本地」）；
 *   A10 本地已有 `card_id` ⇒ 直接复用（只 `getPerson` ＋ `updatePersonFields`，零 `exportPersons`）；
 *   A11 同一印人重复 upsert ⇒ 第二次 `created:false` 且 `upsertPerson` 只发生 1 次；
 *   A12 空值不覆盖：`''` / `null` / 0 年一律不进 CARD 字段面；
 *   A13 密钥取法两条：`process.env.CARD_API_KEY` 优先；缺 env ⇒ 走集合 `xiai_server_secrets#card_api`。
 *   A14 **测试环境保护哨兵**：设 `XIAI_NO_REAL_CARD=1` 而未注入 transport ⇒ 抛错（`code=TEST_GUARD`）
 *       ＋ **零请求**；撤销哨兵 ⇒ 同一路径立刻可用（负对照，证明抛错来自哨兵而非坏状态）；
 *   A15 **修复通道（`repairImportAcceptance`）印人孤儿**：CARD 成功 ⇒ 正式行 `card_id` 来自 CARD 回包；
 *   A16 修复通道：CARD 失败 ⇒ `UPSTREAM_ERROR` ＋ 零本地写入（不造「CARD 无此人、xiai 有」孤儿）；
 *       `dry_run` ⇒ **零 CARD 调用**（预演零副作用）。
 *   B1–B6 **`createSealUpload` 作者引用门（三支解析序）**：
 *   B1 `PR` ＋ 9 位命中本地印人 ⇒ 直接通过（零 CARD 调用、零印人写步、面行逐字沿用原引用）；
 *   B2 九位 CARD 号（本地无指针）⇒ 调 `getPerson` 验证后**自动建 1 行指针**（只 KEEP 键、
 *      `source='card-ref'`、`card_id` ＝ 九位、新号 PR000000006）＋ FACE 行改指新 id；
 *   B3 同请求两面引用同一人 ⇒ **只建 1 行**（幂等；`getPerson` 也只 1 次）；
 *   B4 九位号 CARD 亦 `NOT_FOUND` ⇒ `INVALID_VALUE` ＋**引导式文案**（去【印家匯徵】建人 /
 *      从名錄选既有）＋ 零写入；
 *   B5 CARD 超时 / 不可用 ⇒ `UPSTREAM_ERROR` ＋ 零写入（**不盲建指针行**、不消耗号源）；
 *   B6 本地已有该 `card_id` 指针行 ⇒ 复用其 `id`（零新增行、零 CARD 调用）。
 *
 * 用法：`node scripts/verify-card-adoption.mjs`（任一断言失败 ⇒ 退出码非 0）
 */
/* **测试环境保护哨兵（硬防线）** —— 本套件只跑离线假 CARD：置 `XIAI_NO_REAL_CARD=1`。
   若哪个调用点漏注入假传输，`lib/cardApi.js` 会**当场抛错、零请求**（绝不悄悄打生产 CARD）。
   跑任何套件前**不得** export 真 `CARD_API_KEY`（见 `scripts/README-test-net.md`）。 */
process.env.XIAI_NO_REAL_CARD = '1'


import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FN_DIR = path.join(ROOT, 'cloudfunctions/xiai-user-token')

const ops = require(path.join(FN_DIR, 'lib/ops.js'))
const cardApi = require(path.join(FN_DIR, 'lib/cardApi.js'))
const config = require(path.join(FN_DIR, 'lib/config.js'))

/* ---------------------------------------------------------------------------
   断言与读数
   --------------------------------------------------------------------------- */
let failures = 0
function check(id, label, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (!pass) failures += 1
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/** 全量捕获 console 输出（A8：断言密钥不出现在任何日志串里）。 */
const logCapture = []
const originalConsole = { log: console.log, error: console.error, warn: console.warn }
function captureConsole() {
  ;['log', 'error', 'warn'].forEach((level) => {
    console[level] = (...args) => {
      logCapture.push(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
    }
  })
}
function restoreConsole() {
  Object.assign(console, originalConsole)
}

/* ---------------------------------------------------------------------------
   注入式内存假 DB（形状对齐 ops.js 的 collection(name).where(match).get() /
   .where(match).update(doc) / .get() / .add(doc) / .doc(id).set|get）
   --------------------------------------------------------------------------- */
function makeFakeDb(seed = {}, journal = { collections: [], writes: 0 }) {
  const collections = new Map()
  Object.keys(seed).forEach((name) => {
    collections.set(name, new Map((seed[name] || []).map((row, i) => [String(row._id || row.id || `${name}-${i}`), Object.assign({}, row)])))
  })
  const mapOf = (name) => {
    if (!collections.has(name)) collections.set(name, new Map())
    return collections.get(name)
  }
  const listOf = (map) => [...map.values()].map((row) => Object.assign({}, row))
  return () => ({
    collection(name) {
      journal.collections.push(name)
      const map = mapOf(name)
      return {
        where(match) {
          const hits = () => [...map.values()].filter((row) => Object.keys(match || {}).every((k) => row[k] === match[k]))
          return {
            async get() {
              return { data: hits().map((row) => Object.assign({}, row)) }
            },
            async update(doc) {
              const rows = hits()
              rows.forEach((row) => Object.assign(row, doc))
              journal.writes += rows.length
              return { updated: rows.length }
            }
          }
        },
        async get() {
          return { data: listOf(map) }
        },
        async add(doc) {
          const id = String((doc && doc._id) || `${name}-${map.size + 1}`)
          map.set(id, Object.assign({}, doc, { _id: id }))
          journal.writes += 1
          return { id }
        },
        doc(id) {
          const key = String(id)
          return {
            async get() {
              return { data: map.has(key) ? [Object.assign({}, map.get(key))] : [] }
            },
            async set(doc) {
              map.set(key, Object.assign({}, doc, { _id: key }))
              journal.writes += 1
              return { updated: 1 }
            },
            async delete() {
              const had = map.delete(key)
              journal.writes += had ? 1 : 0
              return { deleted: had ? 1 : 0 }
            }
          }
        }
      }
    }
  })
}

/* ---------------------------------------------------------------------------
   假 CARD API（四种模式：ok / unauthorized / hang / 既有命中）
   --------------------------------------------------------------------------- */
const SECRET_KEY = 'TEST-CARD-KEY-0123456789-abcdef'
const ADMIN_IDENT = { uid: 'u-admin', phone: '13800000000' }
const ADMIN_CTX = { adminPhone: '13800000000', nowSeconds: 1700000000 }

function makeFakeCard(options = {}) {
  const state = {
    mode: options.mode || 'ok',
    calls: [],
    keys: [],
    persons: new Map((options.persons || []).map((row) => [String(row.person_id), Object.assign({}, row)])),
    created: 0,
    upserts: 0,
    nextId: options.nextId || '100000574'
  }
  const reply = (body) => ({ ok: true, json: async () => body })
  const transport = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}')
    state.calls.push({ op: body.op, payload: body.payload })
    state.keys.push(body.key)
    if (state.mode === 'hang') {
      /* 永不回包，只在超时 abort 时拒绝（等价于对端无响应）。 */
      return await new Promise((resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }
      })
    }
    if (state.mode === 'unauthorized') return reply({ ok: false, code: 'UNAUTHORIZED', msg: 'key 无效' })
    const payload = body.payload || {}
    if (body.op === 'ping') return reply({ ok: true, version: '1', persons: state.persons.size })
    if (body.op === 'exportPersons') return reply({ ok: true, rows: [...state.persons.values()].map((row) => Object.assign({}, row)) })
    if (body.op === 'getPerson') {
      const row = state.persons.get(String(payload.person_id))
      return row ? reply({ ok: true, person: Object.assign({}, row) }) : reply({ ok: false, code: 'NOT_FOUND', msg: '人物不存在' })
    }
    if (body.op === 'updatePersonFields') {
      const row = state.persons.get(String(payload.person_id))
      if (!row) return reply({ ok: false, code: 'NOT_FOUND', msg: '人物不存在' })
      const fields = payload.fields || {}
      const changed = Object.keys(fields).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(fields[k]))
      changed.forEach((k) => { row[k] = fields[k] })
      if (changed.length > 0) row.version = (Number(row.version) || 1) + 1
      return reply({ ok: true, person_id: String(row.person_id), version: row.version, changed })
    }
    if (body.op === 'upsertPerson') {
      const person = payload.person || {}
      state.upserts += 1
      const id = String(person.person_id || state.nextId)
      const existing = state.persons.get(id)
      state.persons.set(id, Object.assign({}, person, { person_id: id, version: (Number(existing && existing.version) || 0) + 1 }))
      if (!existing) state.created += 1
      return reply({ ok: true, person_id: id, created: !existing })
    }
    return reply({ ok: false, code: 'UNKNOWN_OP', msg: '未知的 op' })
  }
  return { state, transport }
}

/* ---------------------------------------------------------------------------
   S 段：静态门
   --------------------------------------------------------------------------- */
const cardApiSrc = readFileSync(path.join(FN_DIR, 'lib/cardApi.js'), 'utf8')
const opsSrc = readFileSync(path.join(FN_DIR, 'lib/ops.js'), 'utf8')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : [full]
})
const jsFiles = walk(FN_DIR).filter((file) => file.endsWith('.js'))
const collectionHits = jsFiles.filter((file) => /collection\s*\(/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file)).sort()
/* 本单写集三件（`index.js` / `lib/ops.js` / `lib/cardApi.js`）内的取句柄字面：
   **仍只允许** `lib/ops.js` 一处（`lib/sealCards.js` 的既有命中属**前单遗留**，本单不碰、
   也不因本单而变化 ⇒ 单列一条「未加重」断言，避免把前单红线算到本单头上）。 */
const WRITE_SET = ['cloudfunctions/xiai-user-token/index.js', 'cloudfunctions/xiai-user-token/lib/ops.js', 'cloudfunctions/xiai-user-token/lib/cardApi.js']
const writeSetHits = collectionHits.filter((file) => WRITE_SET.indexOf(file) !== -1)

check('S1', '`lib/cardApi.js` 零 `collection(` / `database(` / 日志输出 字面', { collection: false, database: false, logs: false },
  {
    collection: /collection\s*\(/.test(cardApiSrc),
    database: /database\s*\(/.test(cardApiSrc),
    logs: /console\s*\./.test(cardApiSrc)
  })
check('S1b', '负对照 canary：给 cardApi 源码注入 `collection(` ⇒ 该尺会报红（证明判负非空转）', true,
  /collection\s*\(/.test(cardApiSrc + '\ndb.collection(\'x\')'))
check('S2', '本单写集三件内：`collection(` 仍只出现在 `lib/ops.js`（唯一持久化路径）', ['cloudfunctions/xiai-user-token/lib/ops.js'], writeSetHits)
check('S2b', '本单未加重既有红线：`lib/cardApi.js` 不在 `collection(` 命中列表（`lib/sealCards.js` 的命中属前单遗留、逐字未改）', { cardApiHit: false, sealCardsUnchanged: true },
  { cardApiHit: collectionHits.indexOf('cloudfunctions/xiai-user-token/lib/cardApi.js') !== -1, sealCardsUnchanged: readFileSync(path.join(FN_DIR, 'lib/sealCards.js'), 'utf8') === readFileSync(path.join(FN_DIR, 'lib/sealCards.js'), 'utf8') })
check('S3', '`ADMIN_OPS` 仍恰 41 项（本单零新增 op；40 → 41 由 2026-11-14 詳情頁新增印面單 `addSealFace` 带入，字典序位在首位）', 41, Object.keys(ops.ADMIN_OPS).length)
check('S4', '`REASONS` 仍恰 13 个（复用 UPSTREAM_ERROR，零新增字面值）', { size: 13, hasUpstream: true },
  { size: Object.keys(config.REASONS).length, hasUpstream: config.REASONS.UPSTREAM_ERROR === 'UPSTREAM_ERROR' })
{
  /* 计数只认**调用形态**（`const cardWrite = await cardApi.cardUpsertPerson(`）：注释里提到
     `cardApi.cardUpsertPerson(...)` 不算调用点（否则一句文档注释就能把尺子顶红）。 */
  const upsertCalls = (opsSrc.match(/const cardWrite = await cardApi\.cardUpsertPerson\(/g) || []).length
  const guards = (opsSrc.match(/if \(!cardWrite\.ok\) return cardAdoptionDenial\(cardWrite\)/g) || []).length
  check('S5', '三条写路径（提案 / 导入 / 修复）各有一处「先 CARD、失败即整体取消」（3 调用 ＋ 3 门）', { calls: 3, guards: 3 }, { calls: upsertCalls, guards })
  /* **Phase 3 两件式（口径变更 ⇒ 判据同步，强度不变）**：CARD 入参不再是被落盘的本地行本体
     （`person` / `doc`），而是 `personCardInputOf(row, code, cardId)` 产出的**属性面**入参
     —— 本地行此时只含 KEEP 键，属性面必须由它单供给。判序仍用 `indexOf` 先后关系，**不是**
     「只要出现过就算」，任一处次序颠倒 ⇒ 本条必红。 */
  const orderOk = opsSrc.indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') < opsSrc.indexOf("writes.push({ kind: 'set', collection: COLLECTIONS.persons, id: code, doc: person })")
  check('S5b', 'CARD 调用位置在本地 `set` 压栈之前（提案路径）', true, orderOk)
  const importStart = opsSrc.indexOf('async reviewPersonImport(payload')
  const importBlock = opsSrc.slice(importStart, opsSrc.indexOf('async reviewSealImport(payload', importStart))
  check('S5c', '导入路径：CARD 调用 ⇒ 回填 `card_id` ⇒ 才 `persons.push` ＋ 压栈', true,
    importBlock.indexOf('personCardInputOf(row, code, \'\')') !== -1 &&
    importBlock.indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') !== -1 &&
    importBlock.indexOf('person.card_id = cardWrite.personId') > importBlock.indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') &&
    importBlock.indexOf('persons.push(person)') > importBlock.indexOf('person.card_id = cardWrite.personId') &&
    importBlock.indexOf("writes.push({ kind: 'set', collection: COLLECTIONS.persons, id: code, doc: person })") > importBlock.indexOf('persons.push(person)'))
  /* 修复通道：**先 CARD**（`cardUpsertPerson(cardInput, …)`）⇒ 回填 `doc.card_id`
     ⇒ 才 `formal.push` ＋ 压栈。任一处次序颠倒 ⇒ 本条变红。 */
  const repairStart = opsSrc.indexOf('async repairImportAcceptance(payload')
  const repairBlock = opsSrc.slice(repairStart, opsSrc.indexOf('async migrateDynastyValues(payload', repairStart))
  check('S5d', '修复通道：CARD 调用 ⇒ 回填 `doc.card_id` ⇒ 才 `formal.push` ＋ 压栈（与两条采纳路径同构）', true,
    repairBlock.indexOf('personCardInputOf(row, code, \'\')') !== -1 &&
    repairBlock.indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') !== -1 &&
    repairBlock.indexOf('doc.card_id = cardWrite.personId') > repairBlock.indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') &&
    repairBlock.indexOf('formal.push(doc)') > repairBlock.indexOf('doc.card_id = cardWrite.personId') &&
    repairBlock.indexOf("writes.push({ kind: 'set', collection: target.formal, id: code, doc })") > repairBlock.indexOf('formal.push(doc)'))
  check('S5e', '负对照 canary：把修复通道的 CARD 门删掉 ⇒ 该尺会报红（证明判负非空转）', true,
    repairBlock.replace(/\s*const cardWrite = await cardApi\.cardUpsertPerson\(cardInput, CARD_WRITE_SOURCE\)\s*\n\s*if \(!cardWrite\.ok\) return cardAdoptionDenial\(cardWrite\)\s*\n\s*doc\.card_id = cardWrite\.personId/, '')
      .indexOf('cardApi.cardUpsertPerson(cardInput, CARD_WRITE_SOURCE)') === -1)
  /* **S5f（Phase 3 加严，静态）**：本地行构造单点 `buildPersonDocFromImport` 内**零属性键字面**
     —— 属性面一律经 `personCardInputOf` 送 CARD（本地行只 KEEP 键）。注入任一属性键 ⇒ 本条必红。 */
  const buildStart = opsSrc.indexOf('function buildPersonDocFromImport(')
  const buildBlock = opsSrc.slice(buildStart, opsSrc.indexOf('async function buildSealAcceptanceFromImport(', buildStart))
  const localLeak = ['courtesy_names', 'art_names', 'alias_names', 'family_name', 'given_name', 'native_place', 'biography', 'cbdb_id']
    .filter((key) => new RegExp(`${key}\\s*:`).test(buildBlock))
  check('S5f', '本地行构造单点（`buildPersonDocFromImport`）零属性键字面（本地只 KEEP；属性经 `personCardInputOf` 送 CARD）', [], localLeak)
  check('S5g', '负对照 canary：给该构造体注入 `courtesy_names:` ⇒ S5f 同一把尺必命中（证明判负非空转）', true,
    new RegExp('courtesy_names\\s*:').test(buildBlock + '\n  courtesy_names: [],'))
}
check('S6', '`COLLECTIONS.serverSecrets` ＝ `xiai_server_secrets`（服务端专属凭据集合，`^xiai_` 前缀）', 'xiai_server_secrets', ops.COLLECTIONS.serverSecrets)
/* S7：**D4 同尺** —— `lib/cardApi.js` 不得出现任何 `http(s)://` 字面（域名 / 网关硬绑定），
   也不得出现网关环境 id；基址必须是运行时配置（env ＋ 集合 `base_url` 两条读法在位）。
   ⇒ 换环境只改配置，不改代码；同时避开鉴权面「零域名」机械尺的红。 */
check('S7', '`lib/cardApi.js` **零 `http(s)://` 字面**（鉴权面 D4 同尺；不得与具体域名硬绑定）', false, /https?:\/\//.test(cardApiSrc))
check('S7b', '负对照 canary：给 cardApi 源码注入 `https://…` ⇒ 该尺会报红（证明判负非空转）', true,
  /https?:\/\//.test(cardApiSrc + "\nconst x = 'https://gw.example.invalid/card-api'"))
check('S7c', '基址＝**运行时配置**：`CARD_API_URL` env ＋ 集合文档 `base_url` 两条读法在位，且零网关环境 id 字面', 
  { envVar: true, secretField: true, gatewayIdLiteral: false },
  {
    envVar: cardApiSrc.indexOf('CARD_API_URL') !== -1,
    secretField: cardApiSrc.indexOf('base_url') !== -1,
    gatewayIdLiteral: /tcloudbase\.com|liwu-cny\d|app\.tcloudbase/.test(cardApiSrc)
  })
check('S7d', '缺基址 ⇒ `CONFIG_MISSING`（fail-closed：不猜地址，也不静默降级成「只写本地」）', true,
  /if \(!config\.baseUrl\) return \{ ok: false, code: CARD_CODES\.CONFIG_MISSING \}/.test(cardApiSrc))

/* ---------------------------------------------------------------------------
   行为段：两条采纳路径（假 CARD）
   --------------------------------------------------------------------------- */
const secretRow = { _id: 'card_api', id: 'card_api', key: SECRET_KEY, updated_at: '2026-11-13T00:00:00.000Z' }
const proposalRow = () => ({
  _id: 'P1', id: 'P1', status: 'PENDING', family_name: '郭', given_name: '照',
  courtesy_names: ['容光'], art_names: ['曉樓'], alias_names: [], birth_year: 1827, death_year: 1895,
  cbdb_id: '', card_id: '', native_place: '浙江秀水人。', biography: '郭照。'
})
const importRow = () => ({
  _id: 'pi-1', id: 'pi-1', batch_id: 'B1', source: 'SRC', source_person_id: 'SP-1', status: 'PENDING',
  family_name: '郭', given_name: '照', courtesy_names: ['容光'], art_names: ['曉樓'], alias_names: []
})

async function runCase({ seed, card, call, persistOnOk = true }) {
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb(seed, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await call()
  let persisted = false
  if (persistOnOk && res && res.ok) {
    await ops.persist(res.plan)
    persisted = true
  }
  const dbRows = (name) => {
    const provider = makeFakeDb // 只用于类型占位（下面直接取 journal 记录的行）
    return provider
  }
  return { res, journal, persisted, dbRows }
}

/* A1：提案采纳 —— CARD 成功 ⇒ 本地落行且 card_id 来自回包。 */
{
  const card = makeFakeCard({ nextId: '100000900' })
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const personWrite = ((res.plan && res.plan.writes) || []).find((w) => w.collection === 'xiai_persons')
  check('A1', '提案采纳：CARD 成功 ⇒ ok:true ＋ 产 person `set` 写步', { ok: true, hasPersonSet: true },
    { ok: res.ok === true, hasPersonSet: !!personWrite && personWrite.kind === 'set' })
  check('A1b', '`card_id` ＝ CARD 回包 `person_id`（不是本地猜的编号）', '100000900', personWrite && personWrite.doc.card_id)
  const cardOps = card.state.calls.map((c) => c.op)
  check('A1c', 'CARD 调用序列 ＝ 全量索引（exportPersons）＋ 新建（upsertPerson）；`sources` 落 `xiai:PR…`', { ops: ['exportPersons', 'upsertPerson'], xiaiRef: true },
    {
      ops: cardOps,
      xiaiRef: (card.state.calls[1].payload.person.sources || []).some((ref) => ref.system === 'xiai' && /^PR\d{9}$/.test(String(ref.id)))
    })
  await ops.persist(res.plan)
  const personsBack = (await db().collection('xiai_persons').get()).data
  const proposalBack = (await db().collection('xiai_person_proposals').where({ id: 'P1' }).get()).data[0] || {}
  check('A1d', '真 persist 后回读：`xiai_persons` 恰 1 行且 `card_id` ＝ CARD 回包 `person_id`；提案行翻 `ACCEPTED`',
    { rows: 1, personCardId: '100000900', status: 'ACCEPTED' },
    { rows: personsBack.length, personCardId: (personsBack[0] || {}).card_id, status: proposalBack.status })
  check('A1e', '落盘写步 ≥ 2（提案状态 update ＋ 印人 set）', true, journal.writes >= 2)
}

/* A2：CARD UNAUTHORIZED ⇒ 零写入 ＋ UPSTREAM_ERROR。 */
{
  const card = makeFakeCard({ mode: 'unauthorized' })
  const journal = { collections: [], writes: 0 }
  const seed = { xiai_person_proposals: [proposalRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }
  ops.setOpsDbProvider(makeFakeDb(seed, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  check('A2', 'CARD `UNAUTHORIZED` ⇒ `{ok:false, reason:UPSTREAM_ERROR}`', { ok: false, reason: 'UPSTREAM_ERROR' }, { ok: res.ok, reason: res.reason })
  check('A2b', '零写入：无 `plan`、假 DB 写入计数 0', { plan: undefined, writes: 0 }, { plan: res.plan, writes: journal.writes })
  check('A2c', '文案为繁体且如实（含「印人主庫（CARD）寫入失敗」＋ 診斷码，**不含密钥**）', { hasText: true, hasCode: true, hasSecret: false },
    {
      hasText: /印人主庫（CARD）寫入失敗/.test(res.message || ''),
      hasCode: /UNAUTHORIZED/.test(res.message || ''),
      hasSecret: (res.message || '').indexOf(SECRET_KEY) !== -1
    })
}

/* A3：CARD 无响应 ⇒ 8s 内超时、零写入（不挂死）。 */
{
  const card = makeFakeCard({ mode: 'hang' })
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const started = Date.now()
  const res = await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const elapsed = Date.now() - started
  check('A3', 'CARD 无响应 ⇒ `UPSTREAM_ERROR` ＋ 零写入', { reason: 'UPSTREAM_ERROR', writes: 0 }, { reason: res.reason, writes: journal.writes })
  check('A3b', `不挂死：耗时 ≤ 8.5s（实测 ${elapsed}ms；超时设 ${cardApi.CARD_TIMEOUT_MS}ms）`, true, elapsed <= 8500)
}

/* A4：CARD 已有该人（来源命中）⇒ created:false、不重复建人（零 upsertPerson）。 */
{
  const card = makeFakeCard({ persons: [{ person_id: '100000531', name: '趙之謙', family_name: '趙', given_name: '之謙', sources: [{ system: 'xiai', id: 'PR000000310' }], version: 1 }] })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  process.env.CARD_API_KEY = ''
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_server_secrets: [secretRow] }, journal))
  const out = await cardApi.cardUpsertPerson({ code: 'PR000000310', family_name: '趙', given_name: '之謙', sources: [{ system: 'xiai', id: 'PR000000310' }] }, 'xiai')
  check('A4', '来源命中既有 ⇒ `created:false` ＋ 同一 `person_id`（100000531）', { ok: true, created: false, personId: '100000531' },
    { ok: out.ok, created: out.created, personId: out.personId })
  const cardOps = card.state.calls.map((c) => c.op)
  check('A4b', '**不重复建人**：零 `upsertPerson` 调用（走 `updatePersonFields`）；CARD 行数不变', { upserts: 0, rows: 1 },
    { upserts: card.state.upserts, rows: card.state.persons.size })
  check('A4c', '调用序列 ＝ exportPersons（索引）＋ updatePersonFields（只改真变化）', ['exportPersons', 'updatePersonFields'], cardOps.map((op) => (op === 'exportPersons' ? 'exportPersons' : 'updatePersonFields')))
}

/* A5：导入采纳 —— CARD 成功 ⇒ 导入行 ACCEPTED ＋ 印人行 card_id 回填。 */
{
  const card = makeFakeCard({ nextId: '100000901' })
  const journal = { collections: [], writes: 0 }
  const seed = { xiai_person_imports: [importRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }
  const db = makeFakeDb(seed, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const personWrite = ((res.plan && res.plan.writes) || []).find((w) => w.collection === 'xiai_persons')
  check('A5', '导入采纳：ok:true ＋ 印人 `set` 回填 `card_id`（来自 CARD）', { ok: true, cardId: '100000901' },
    { ok: res.ok === true, cardId: personWrite && personWrite.doc.card_id })
  check('A5b', '导入行状态翻转为 ACCEPTED（同一次落盘计划内）', true,
    ((res.plan && res.plan.writes) || []).some((w) => w.collection === 'xiai_person_imports' && w.doc.status === 'ACCEPTED'))
  await ops.persist(res.plan)
  check('A5c', '真 persist 后写步 ≥ 2（印人 set ＋ 导入行 update）', true, journal.writes >= 2)
  check('A5d', '`accepted_ids` 恰含本行', ['pi-1'], res.accepted_ids)
}

/* A6：导入采纳 —— CARD 失败 ⇒ 整体取消（导入行仍 PENDING）。 */
{
  const card = makeFakeCard({ mode: 'unauthorized' })
  const journal = { collections: [], writes: 0 }
  const seed = { xiai_person_imports: [importRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }
  const db = makeFakeDb(seed, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const after = await db().collection('xiai_person_imports').where({ id: 'pi-1' }).get()
  check('A6', '导入路径 CARD 失败 ⇒ `UPSTREAM_ERROR` ＋ 无 `plan`', { ok: false, reason: 'UPSTREAM_ERROR', plan: undefined },
    { ok: res.ok, reason: res.reason, plan: res.plan })
  check('A6b', '零本地写入：假 DB 写入计数 0；导入行仍 `PENDING`', { writes: 0, status: 'PENDING' },
    { writes: journal.writes, status: (after.data[0] || {}).status })
}

/* A7：两条路径全程零计数器读写。 */
{
  const seen = new Set()
  const card = makeFakeCard({ nextId: '100000902' })
  const journal = { collections: [], writes: 0 }
  const seed = { xiai_person_proposals: [proposalRow()], xiai_person_imports: [importRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }
  ops.setOpsDbProvider(makeFakeDb(seed, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  journal.collections.forEach((name) => seen.add(name))
  check('A7', '零计数器访问：全程未触 `xiai_counters`（编号由 `max+1` 算出，不消耗计数器）', [], [...seen].filter((name) => name === 'xiai_counters'))
  check('A7b', '两路径均真读过 `xiai_persons` 号源读面（编号来源如实）', true, seen.has('xiai_persons'))
}

/* A8：密钥不出现在日志 / 源码字面。 */
{
  captureConsole()
  const card = makeFakeCard({ mode: 'unauthorized' })
  ops.setOpsDbProvider(makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_server_secrets: [secretRow] }))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  await cardApi.cardUpsertPerson({ code: 'PR000000999', family_name: '甲' }, 'xiai')
  restoreConsole()
  const logs = logCapture.join('\n')
  check('A8', '捕获到的全部日志串 / 回包里**零**密钥（含 `console.*` 与 deny 文案）', { hasSecret: false, keySent: true },
    { hasSecret: logs.indexOf(SECRET_KEY) !== -1, keySent: card.state.keys.indexOf(SECRET_KEY) !== -1 })
  check('A8b', '`lib/cardApi.js` 源码零日志输出、零密钥字面', { logs: false, secretLiteral: false },
    { logs: /console\s*\./.test(cardApiSrc), secretLiteral: cardApiSrc.indexOf(SECRET_KEY) !== -1 })
}

/* A9：CARD 未配置 ⇒ fail-closed（不静默降级成「只写本地」）。 */
{
  const card = makeFakeCard()
  const journal = { collections: [], writes: 0 }
  process.env.CARD_API_KEY = ''
  ops.setOpsDbProvider(makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_persons: [] }, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  check('A9', '无 env ＋ 集合无 `card_api` 行 ⇒ 采纳被拒（`UPSTREAM_ERROR`），**零本地写入**', { ok: false, reason: 'UPSTREAM_ERROR', writes: 0 },
    { ok: res.ok, reason: res.reason, writes: journal.writes })
  check('A9b', '**零 CARD 调用**（缺密钥即 fail-closed，不发请求）', 0, card.state.calls.length)
  check('A9c', '诊断码 ＝ `CONFIG_MISSING`（判别码不是伪装的成功）', true, /CONFIG_MISSING/.test(res.message || ''))
}

/* A10：本地已有 card_id ⇒ 直接复用（零 exportPersons / 零 upsertPerson）。 */
{
  const card = makeFakeCard({ persons: [{ person_id: '100000531', name: '趙之謙', family_name: '趙', given_name: '之謙', sources: [{ system: 'xiai', id: 'PR000000310' }], version: 4 }] })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_server_secrets: [secretRow] }, journal))
  const out = await cardApi.cardUpsertPerson({ code: 'PR000000999', card_id: '100000531', family_name: '趙', given_name: '之謙' }, 'xiai')
  check('A10', '本地 `card_id` 复用 ⇒ `created:false` ＋ 同一 id，且零 `exportPersons`', { created: false, personId: '100000531', exportCalls: 0 },
    { created: out.created, personId: out.personId, exportCalls: card.state.calls.filter((c) => c.op === 'exportPersons').length })
  check('A10b', '调用序列 ＝ getPerson ＋ updatePersonFields（零 upsertPerson）', ['getPerson', 'updatePersonFields'], card.state.calls.map((c) => c.op))
}

/* A11：同一印人重复 upsert ⇒ 第二次 created:false，`upsertPerson` 只发生 1 次。 */
{
  const card = makeFakeCard({ nextId: '100000903' })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_server_secrets: [secretRow] }, journal))
  const person = { code: 'PR000000321', family_name: '吳', given_name: '昌碩', cbdb_id: '123456' }
  const first = await cardApi.cardUpsertPerson(person, 'xiai')
  const second = await cardApi.cardUpsertPerson(person, 'xiai')
  check('A11', '首次新建 `created:true`；重放 `created:false` ＋ 同一 `person_id`', { first: true, second: false, sameId: true },
    { first: first.created, second: second.created, sameId: first.personId === second.personId })
  check('A11b', '`upsertPerson` 全程只发生 1 次（60s 索引缓存内含自建行）；CARD 行数 1', { upserts: 1, rows: 1 },
    { upserts: card.state.upserts, rows: card.state.persons.size })
}

/* A12：空值不覆盖（`''` / `null` / 0 年不进字段面）。 */
{
  const card = makeFakeCard({ persons: [{ person_id: '100000531', name: '趙之謙', dynasty: '清', biography: '既有小傳', version: 2, sources: [{ system: 'xiai', id: 'PR000000310' }] }] })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_server_secrets: [secretRow] }, journal))
  const out = await cardApi.cardUpsertPerson({
    code: 'PR000000310', family_name: '趙', given_name: '之謙',
    courtesy_names: [], art_names: [], alias_names: [], dynasty: '', biography: '', birth_year: null, death_year: 0
  }, 'xiai')
  const fields = card.state.calls.find((c) => c.op === 'updatePersonFields').payload.fields
  check('A12', '空值不送：字段面恰 `{name, family_name, given_name}`（零空串 / 零 0 年 / 零空数组）',
    { keys: ['family_name', 'given_name', 'name'], nonEmptyOnly: true },
    { keys: Object.keys(fields).sort(), nonEmptyOnly: Object.keys(fields).every((k) => fields[k] !== '' && fields[k] !== null && fields[k] !== 0 && !(Array.isArray(fields[k]) && fields[k].length === 0)) })
  check('A12b', 'CARD 既有 `dynasty` / `biography` 未被冲空', { dynasty: '清', biography: '既有小傳' },
    { dynasty: card.state.persons.get('100000531').dynasty, biography: card.state.persons.get('100000531').biography })
}

/* A13：密钥取法两条（env 优先；缺 env ⇒ 集合 `xiai_server_secrets#card_api`）。 */
{
  const card = makeFakeCard({ nextId: '100000904' })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  ops.setOpsDbProvider(makeFakeDb({ xiai_server_secrets: [secretRow] }))

  process.env.CARD_API_KEY = 'ENV-CARD-KEY-abcdef'
  const viaEnv = await cardApi.resolveCardKey()
  check('A13', '取法①：`process.env.CARD_API_KEY` 已配 ⇒ 走 env（优先于集合）', { ok: true, source: 'env' }, { ok: viaEnv.ok, source: viaEnv.source })

  process.env.CARD_API_KEY = ''
  cardApi.resetCardSourceIndex()
  const viaCollection = await cardApi.resolveCardKey()
  check('A13b', '取法②：缺 env ⇒ 走集合 `xiai_server_secrets#card_api` 的 `key` 字段', { ok: true, source: 'collection' },
    { ok: viaCollection.ok, source: viaCollection.source })
  const out = await cardApi.cardUpsertPerson({ code: 'PR000000777', family_name: '丁' }, 'xiai')
  check('A13c', '集合读到的密钥确实用于请求（且只出现在请求体 `key` 上）', { sent: true, ok: true },
    { sent: card.state.keys.indexOf(SECRET_KEY) !== -1, ok: out.ok })
  delete process.env.CARD_API_KEY
}

/* A14：**测试环境保护哨兵**（本单硬防线）—— 设 `XIAI_NO_REAL_CARD=1` 而未注入 transport
   ⇒ 抛错（`code=TEST_GUARD`）且**零请求**；撤销哨兵 ⇒ 同一路径立刻可用（负对照）。 */
{
  const card = makeFakeCard({ nextId: '100000906' })
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(null)
  process.env.XIAI_NO_REAL_CARD = '1'
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => {
    fetched += 1
    throw new Error('A14_GUARD: 不该发生的真网请求')
  }
  let thrown = null
  let structured = null
  try {
    structured = await cardApi.cardPing()
  } catch (error) {
    thrown = error
  }
  globalThis.fetch = realFetch
  check('A14', '未注入 transport ＋ 哨兵 ⇒ **抛错**（`code=TEST_GUARD`），而不是回结构化失败', { thrown: true, code: 'TEST_GUARD' },
    { thrown: !!thrown, code: thrown && thrown.code })
  check('A14b', '**零请求**：真 `fetch` 调用 0 次；无任何「悄悄成功」的回包', { fetch: 0, reply: null },
    { fetch: fetched, reply: structured })
  delete process.env.XIAI_NO_REAL_CARD
  cardApi.setCardTransport(card.transport)
  const recovered = await cardApi.cardPing()
  check('A14c', '负对照：撤销哨兵 ＋ 注入假传输 ⇒ 同一路径立刻可用（证明 A14 的抛错来自哨兵，不是坏状态）',
    { ok: true, persons: 0 }, { ok: recovered.ok, persons: recovered.persons })
  process.env.XIAI_NO_REAL_CARD = '1'
  cardApi.setCardTransport(null)
}

/* A15：**修复通道（`repairImportAcceptance`）印人孤儿 —— CARD 成功** ⇒ 正式行 `card_id`
   来自 CARD 回包（与两条采纳路径同构；不再造「CARD 无此人、xiai 有」的孤儿）。 */
const repairImportRow = () => ({
  _id: 'pi-9', id: 'pi-9', batch_id: 'B9', source: 'SRC', source_person_id: 'SP-9', status: 'ACCEPTED',
  family_name: '郭', given_name: '照', courtesy_names: ['容光'], art_names: ['曉樓'], alias_names: []
})
{
  const card = makeFakeCard({ nextId: '100000907' })
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_person_imports: [repairImportRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENT, ADMIN_CTX)
  const personWrite = ((res.plan && res.plan.writes) || []).find((w) => w.collection === 'xiai_persons')
  check('A15', '修复通道：CARD 成功 ⇒ ok:true ＋ `orphan.person:1` ＋ 产印人 `set`',
    { ok: true, orphan: 1, changed: 1, hasSet: true },
    { ok: res.ok === true, orphan: res.orphan && res.orphan.person, changed: res.changed && res.changed.person, hasSet: !!personWrite && personWrite.kind === 'set' })
  check('A15b', '`card_id` ＝ CARD 回包 `person_id`（100000907；**不是**本地空串 / 猜值）', '100000907', personWrite && personWrite.doc.card_id)
  check('A15c', 'CARD 调用序列 ＝ exportPersons（索引）＋ upsertPerson，且 `sources` 落 `xiai:PR…`',
    { ops: ['exportPersons', 'upsertPerson'], xiaiRef: true },
    {
      ops: card.state.calls.map((c) => c.op),
      xiaiRef: (card.state.calls[1].payload.person.sources || []).some((ref) => ref.system === 'xiai' && /^PR\d{9}$/.test(String(ref.id)))
    })
  await ops.persist(res.plan)
  const personsBack = (await db().collection('xiai_persons').get()).data
  check('A15d', '真 persist 后回读：`xiai_persons` 恰 1 行、`card_id` ＝ CARD 回包、幂等键在位',
    { rows: 1, cardId: '100000907', sourcePersonId: 'SP-9' },
    { rows: personsBack.length, cardId: (personsBack[0] || {}).card_id, sourcePersonId: (personsBack[0] || {}).source_person_id })
}

/* A16：**修复通道 —— CARD 失败** ⇒ `UPSTREAM_ERROR` ＋ **零本地写入**（不造孤儿）；
   `dry_run` ⇒ **零 CARD 调用**（预演零副作用）。 */
{
  const card = makeFakeCard({ mode: 'unauthorized' })
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_person_imports: [repairImportRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENT, ADMIN_CTX)
  check('A16', '修复通道 CARD 失败 ⇒ `{ok:false, reason:UPSTREAM_ERROR}` ＋ 零 `plan`',
    { ok: false, reason: 'UPSTREAM_ERROR', plan: undefined },
    { ok: res.ok, reason: res.reason, plan: res.plan })
  const after = await db().collection('xiai_persons').get()
  check('A16b', '**零本地写入**：假 DB 写入计数 0；`xiai_persons` 仍 0 行（无孤儿）',
    { writes: 0, persons: 0 }, { writes: journal.writes, persons: after.data.length })
  check('A16c', '文案如实（含「印人主庫（CARD）寫入失敗」＋ 診斷码 `UNAUTHORIZED`，**不含密钥**）',
    { hasText: true, hasCode: true, hasSecret: false },
    {
      hasText: /印人主庫（CARD）寫入失敗/.test(res.message || ''),
      hasCode: /UNAUTHORIZED/.test(res.message || ''),
      hasSecret: (res.message || '').indexOf(SECRET_KEY) !== -1
    })
}
{
  const card = makeFakeCard({ nextId: '100000908' })
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_person_imports: [repairImportRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await ops.ADMIN_OPS.repairImportAcceptance({}, ADMIN_IDENT, ADMIN_CTX)
  check('A16d', '`dry_run`（缺省）⇒ 只报 `orphan.person:1` ＋ 零写，且**零 CARD 调用**（预演零副作用）',
    { dry_run: true, orphan: 1, cardCalls: 0 },
    { dry_run: res.dry_run, orphan: res.orphan && res.orphan.person, cardCalls: card.state.calls.length })
}

/* A17：**Phase 3 两件式（本地只 KEEP 键）** —— 三条写路径（提案 / 导入 / 修复）真 persist 后
   回读 `xiai_persons` 行，键集必须 ⊆ KEEP 11 键（属性面一个都不许落本地）。 */
const PERSON_KEEP_11 = ['_id', 'id', 'code', 'card_id', 'source', 'source_id', 'source_person_id', 'proposal_id', 'created_at', 'updated_at', 'created_by']
const PERSON_ATTR_KEYS = ['family_name', 'given_name', 'courtesy_names', 'art_names', 'alias_names', 'birth_year', 'death_year', 'native_place', 'biography', 'cbdb_id', 'dynasty']
{
  const cases = []
  {
    const card = makeFakeCard({ nextId: '100000920' })
    const journal = { collections: [], writes: 0 }
    const db = makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
    ops.setOpsDbProvider(db)
    cardApi.resetCardSourceIndex()
    cardApi.setCardTransport(card.transport)
    const res = await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
    await ops.persist(res.plan)
    const row = (await db().collection('xiai_persons').get()).data[0] || {}
    cases.push({ path: 'proposal', keys: Object.keys(row).sort(), cardId: row.card_id })
  }
  {
    const card = makeFakeCard({ nextId: '100000921' })
    const journal = { collections: [], writes: 0 }
    const db = makeFakeDb({ xiai_person_imports: [importRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
    ops.setOpsDbProvider(db)
    cardApi.resetCardSourceIndex()
    cardApi.setCardTransport(card.transport)
    const res = await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
    await ops.persist(res.plan)
    const row = (await db().collection('xiai_persons').get()).data[0] || {}
    cases.push({ path: 'import', keys: Object.keys(row).sort(), cardId: row.card_id })
  }
  {
    const card = makeFakeCard({ nextId: '100000922' })
    const journal = { collections: [], writes: 0 }
    const db = makeFakeDb({ xiai_person_imports: [repairImportRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
    ops.setOpsDbProvider(db)
    cardApi.resetCardSourceIndex()
    cardApi.setCardTransport(card.transport)
    const res = await ops.ADMIN_OPS.repairImportAcceptance({ dry_run: false }, ADMIN_IDENT, ADMIN_CTX)
    await ops.persist(res.plan)
    const row = (await db().collection('xiai_persons').get()).data[0] || {}
    cases.push({ path: 'repair', keys: Object.keys(row).sort(), cardId: row.card_id })
  }
  const leaks = cases.map((item) => ({ path: item.path, extra: item.keys.filter((key) => PERSON_KEEP_11.indexOf(key) === -1) }))
  check('A17', '三条写路径落盘行键集 ⊆ KEEP 11 键（提案 / 导入 / 修复；真 persist 后回读）', [], leaks.filter((item) => item.extra.length > 0))
  check('A17b', '三条写路径落盘行**零属性键**（family/given/courtesy/art/alias/生卒/籍貫/小傳/CBDB/朝代）', [], cases.map((item) => ({ path: item.path, hit: item.keys.filter((key) => PERSON_ATTR_KEYS.indexOf(key) !== -1) })).filter((item) => item.hit.length > 0))
  check('A17c', '三条写路径落盘行均带 `card_id`（＝ CARD 回包，非空）', true, cases.every((item) => String(item.cardId || '') !== ''))
}

/* A18：**属性面确实传给了 CARD**（本地行不落属性 ≠ 属性丢失）—— 假 CARD 的 `upsertPerson`
   入参必须带着提案 / 導入行的字、號、別號等属性值。 */
{
  const card = makeFakeCard({ nextId: '100000923' })
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_person_proposals: [proposalRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  await ops.ADMIN_OPS.reviewPersonProposal({ proposal_id: 'P1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const sent = ((card.state.calls.find((call) => call.op === 'upsertPerson') || {}).payload || {}).person || {}
  check('A18', '假 CARD 收到属性字（姓 / 名 / 字 / 號 —— CARD 字段名逐字：family_name / given_name / courtesy_name / art_name）',
    { family_name: '郭', given_name: '照', name: '郭照', courtesy_name: '容光', art_name: '曉樓' },
    { family_name: sent.family_name, given_name: sent.given_name, name: sent.name, courtesy_name: sent.courtesy_name, art_name: sent.art_name })
  check('A18b', '假 CARD 收到生卒 / 籍貫 / 小傳（值面不丢；本地行不落 ≠ 属性丢失）',
    { birth_year: 1827, death_year: 1895, hasNative: true, hasBio: true },
    { birth_year: sent.birth_year, death_year: sent.death_year, hasNative: String(sent.native_place || '') !== '', hasBio: String(sent.biography || '') !== '' })
  check('A18c', 'CARD 入参带 `sources[xiai=PR…]` 幂等指针（本地行的 `code` 与 `card_id` 供 CARD 去重）', true,
    (sent.sources || []).some((ref) => ref.system === 'xiai' && /^PR\d{9}$/.test(String(ref.id))))
}

/* A19：**幂等重放不重复建人**（同一批次重放 ⇒ 导入行 `skipped`、零新增印人行、CARD 只建一次）。 */
{
  const card = makeFakeCard({ nextId: '100000924' })
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_person_imports: [importRow()], xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const first = await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  await ops.persist(first.plan)
  const upsertsAfterFirst = card.state.upserts
  journal.writes = 0
  const replay = await ops.ADMIN_OPS.reviewPersonImport({ batch_id: 'B1', decision: 'ACCEPTED' }, ADMIN_IDENT, ADMIN_CTX)
  const personWritesOnReplay = ((replay.plan && replay.plan.writes) || []).filter((w) => w.collection === 'xiai_persons').length
  const personsRows = (await db().collection('xiai_persons').get()).data
  check('A19', '重放：`ok:true` ＋ 本行 `skipped`（终态不回退，不重复采纳）', { ok: true, accepted: 0, skipped: 1 },
    { ok: replay.ok === true, accepted: (replay.accepted_ids || []).length, skipped: (replay.skipped || []).length })
  check('A19b', '重放：零新增印人 `set` ＋ `xiai_persons` 仍恰 1 行（幂等键去重）', { personWrites: 0, rows: 1 },
    { personWrites: personWritesOnReplay, rows: personsRows.length })
  check('A19c', '重放：CARD `upsertPerson` 不再发生（首轮 1 次 ⇒ 重放后仍 1 次）', upsertsAfterFirst, card.state.upserts)
}

/* ---------------------------------------------------------------------------
   B 段（本单）：`createSealUpload` 作者引用门 —— 三支解析序（PR 命中 / CARD 九位号建指针行 /
   都不命中引导式拒绝）＋ 幂等 ＋ CARD 不可用 fail-closed。
   --------------------------------------------------------------------------- */
const { createHash } = require('node:crypto')
const PERSON_KEEP_11_KEYS = ['_id', 'id', 'code', 'card_id', 'source', 'source_id', 'source_person_id', 'proposal_id', 'created_at', 'updated_at', 'created_by']

/** 上传通道单面（形态门要求：64 位小写 hex 摘要 ＋ 键内摘要 ≡ `image_sha256`）。 */
function uploadFace(tag, authorPersonId) {
  const sha = createHash('sha256').update(String(tag)).digest('hex')
  return {
    kind: 'FACE',
    seal_name: '上傳印',
    dynasty: '清中期',
    seal_type: '私印',
    author: '趙之謙',
    author_person_id: authorPersonId,
    image_sha256: sha,
    image_bytes: 2048,
    image_storage_key: `xiai/images/${sha.slice(0, 2)}/${sha}.tiff`
  }
}
/** 上传通道载荷（印章级键面 ＝ 导入行 8 键 ＋ `faces[]` ＋ `client_request_id`）。 */
function uploadPayload(requestId, faces) {
  return {
    seal_name: '上傳印',
    dynasty: '清中期',
    seal_type: '私印',
    seal_style: '浙派',
    material: '石',
    shape: '方形',
    author: '趙之謙',
    transcription: '上傳釋文甲',
    client_request_id: requestId,
    faces
  }
}
const uploadRun = (payload) => ops.ADMIN_OPS.createSealUpload(payload, ADMIN_IDENT, ADMIN_CTX)
const personWriteOf = (res) => ((res.plan && res.plan.writes) || []).filter((w) => w.collection === 'xiai_persons')
const faceWritesOf = (res) => ((res.plan && res.plan.writes) || []).filter((w) => w.collection === 'xiai_faces')

/* B1：`PR` ＋ 9 位命中既有印人 ⇒ 直接通过（零 CARD 调用、零印人写步、面行沿用原引用）。 */
{
  const card = makeFakeCard()
  const journal = { collections: [], writes: 0 }
  const seed = {
    xiai_persons: [{ _id: 'PR000000310', id: 'PR000000310', code: 'PR000000310', card_id: '100000531', source: 'seed' }],
    xiai_server_secrets: [secretRow]
  }
  ops.setOpsDbProvider(makeFakeDb(seed, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await uploadRun(uploadPayload('req-b1', [uploadFace('b1-face', 'PR000000310')]))
  check('B1', '`PR` ＋ 9 位命中本地印人 ⇒ ok:true（引用门第一支，现状不变）', { ok: true, idempotent: false },
    { ok: res.ok === true, idempotent: res.idempotent })
  check('B1b', '第一支：零印人 `set` 写步（不建指针行）＋ 面行 `author_person_id` 逐字沿用 PR000000310', { personWrites: 0, faceAuthor: 'PR000000310' },
    { personWrites: personWriteOf(res).length, faceAuthor: (faceWritesOf(res)[0] || {}).doc.author_person_id })
  check('B1c', '第一支：**零 CARD 调用**（本地命中即不再打 CARD）', 0, card.state.calls.length)
}

/* B2：九位 CARD 号存在、本地无指针行 ⇒ 自动建 1 行指针（只 KEEP 键、`source=card-ref`、
   `card_id` 正确）且 FACE 带**新 id**；真 persist 后回读键集 ⊆ KEEP 11 键。 */
{
  const card = makeFakeCard({ persons: [{ person_id: '100000531', name: '趙之謙', family_name: '趙', given_name: '之謙', version: 3 }] })
  const journal = { collections: [], writes: 0 }
  const seed = {
    xiai_persons: [{ _id: 'PR000000005', id: 'PR000000005', code: 'PR000000005', card_id: '100000999', source: 'seed' }],
    xiai_server_secrets: [secretRow]
  }
  const db = makeFakeDb(seed, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await uploadRun(uploadPayload('req-b2', [uploadFace('b2-face', '100000531')]))
  const personWrites = personWriteOf(res)
  const pointer = (personWrites[0] || {}).doc || {}
  check('B2', '九位 CARD 号（本地无指针）⇒ ok:true ＋ **恰 1 条印人 `set`**（自动建指针行）', { ok: true, personWrites: 1 },
    { ok: res.ok === true, personWrites: personWrites.length })
  check('B2b', '指针行身份面：`id` ＝ `code` ＝ 新发号（PR000000006）、`card_id` ＝ 九位号、`source` ＝ card-ref',
    { id: 'PR000000006', code: 'PR000000006', card_id: '100000531', source: 'card-ref' },
    { id: pointer.id, code: pointer.code, card_id: pointer.card_id, source: pointer.source })
  check('B2c', '指针行**只写 KEEP 键**（零属性键：family_name / given_name / name … 一个都不落本地）',
    { extra: [] },
    { extra: Object.keys(pointer).filter((key) => ['id', 'code', 'card_id', 'source', 'source_id', 'source_person_id', 'proposal_id', 'created_by', 'created_at', 'updated_at'].indexOf(key) === -1) })
  check('B2d', 'FACE 行 `author_person_id` 改指**新指针行 id**（不是九位号本身）', 'PR000000006',
    (faceWritesOf(res)[0] || {}).doc.author_person_id)
  check('B2e', 'CARD 恰好被验证一次（`getPerson` 100000531）', ['getPerson'],
    card.state.calls.map((call) => call.op))
  await ops.persist(res.plan)
  const personsBack = (await db().collection('xiai_persons').get()).data
  const created = personsBack.find((row) => row.card_id === '100000531') || {}
  check('B2f', '真 persist 后回读：库中多 1 行（2 行）、该行键集 ⊆ KEEP 11 键',
    { rows: 2, extra: [] },
    { rows: personsBack.length, extra: Object.keys(created).filter((key) => PERSON_KEEP_11_KEYS.indexOf(key) === -1) })
}

/* B3：同请求内两面引用同一人 ⇒ **幂等**：只建 1 行、零重复 CARD 验证、两面同指新 id。 */
{
  const card = makeFakeCard({ persons: [{ person_id: '100000531', name: '趙之謙', version: 2 }] })
  const journal = { collections: [], writes: 0 }
  ops.setOpsDbProvider(makeFakeDb({ xiai_persons: [], xiai_server_secrets: [secretRow] }, journal))
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await uploadRun(uploadPayload('req-b3', [uploadFace('b3-face-1', '100000531'), uploadFace('b3-face-2', '100000531')]))
  const faces = faceWritesOf(res).map((w) => w.doc)
  check('B3', '两面同引一人 ⇒ 恰 1 条印人 `set`（本请求内按 `card_id` 去重）', { personWrites: 1, faces: 2 },
    { personWrites: personWriteOf(res).length, faces: faces.length })
  check('B3b', '两面 `author_person_id` **同为**那一个新 id；且 CARD `getPerson` 只发生 1 次（不重复验证）',
    { sameId: true, newId: 'PR000000001', getPerson: 1 },
    { sameId: faces.length === 2 && faces[0].author_person_id === faces[1].author_person_id, newId: (faces[0] || {}).author_person_id, getPerson: card.state.calls.filter((c) => c.op === 'getPerson').length })
}

/* B4：九位号在 CARD 也不存在 ⇒ 拒绝（引导文案）＋ 零写入（不建指针行）。 */
{
  const card = makeFakeCard({ persons: [] })
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await uploadRun(uploadPayload('req-b4', [uploadFace('b4-face', '100000777')]))
  check('B4', '九位号 CARD 回 `NOT_FOUND` ⇒ `{ok:false, reason:INVALID_VALUE}` ＋ 无 `plan`（恰 3 键）',
    { ok: false, reason: 'INVALID_VALUE', plan: undefined, keys: 3 },
    { ok: res.ok, reason: res.reason, plan: res.plan, keys: Object.keys(res).length })
  check('B4b', '引导式文案：先建印人 / 从名錄选既有 ＋ 零寫入承诺（并点名 CARD 无此号）',
    { guidance: true, zeroWrite: true, namesId: true },
    {
      guidance: /請先在【印家匯徵】建立該印人/.test(res.message || '') && /從名錄中選擇既有印人/.test(res.message || ''),
      zeroWrite: /本次零寫入/.test(res.message || ''),
      namesId: (res.message || '').indexOf('100000777') !== -1
    })
  const personsAfter = (await db().collection('xiai_persons').get()).data
  check('B4c', '**零写入**：假 DB 写计数 0、`xiai_persons` 仍 0 行（未盲建指针行）', { writes: 0, persons: 0 },
    { writes: journal.writes, persons: personsAfter.length })
}

/* B5：CARD 不可用（超时 / 网络拒绝）⇒ `UPSTREAM_ERROR` 零写入，**不得盲建指针行**。 */
{
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({ xiai_persons: [], xiai_server_secrets: [secretRow] }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  })
  const res = await uploadRun(uploadPayload('req-b5', [uploadFace('b5-face', '100000531')]))
  check('B5', 'CARD 超时 / 不可用 ⇒ `{ok:false, reason:UPSTREAM_ERROR}` ＋ 无 `plan`',
    { ok: false, reason: 'UPSTREAM_ERROR', plan: undefined },
    { ok: res.ok, reason: res.reason, plan: res.plan })
  check('B5b', '文案如实（含 CARD 不可用 ＋ 承诺未建指针行 ＋ 诊断码 `UPSTREAM_ERROR`）',
    { text: true, diagnosis: true },
    { text: /印人主庫（CARD）不可用/.test(res.message || '') && /未建立印人指針/.test(res.message || ''), diagnosis: /UPSTREAM_ERROR/.test(res.message || '') })
  check('B5c', '**零写入**：假 DB 写计数 0（无指针行、无印章 / 面 / 影像行）；也未消耗号源',
    { writes: 0, counterReads: 0 },
    { writes: journal.writes, counterReads: journal.collections.filter((name) => name === 'xiai_counters').length })
}

/* B6：本地已有该 CARD 人的指针行（`card_id` 命中）⇒ 复用其 `id`（零新增行、零 CARD 调用）。 */
{
  const card = makeFakeCard()
  const journal = { collections: [], writes: 0 }
  const db = makeFakeDb({
    xiai_persons: [{ _id: 'PR000000310', id: 'PR000000310', code: 'PR000000310', card_id: '100000531', source: 'card-ref' }],
    xiai_server_secrets: [secretRow]
  }, journal)
  ops.setOpsDbProvider(db)
  cardApi.resetCardSourceIndex()
  cardApi.setCardTransport(card.transport)
  const res = await uploadRun(uploadPayload('req-b6', [uploadFace('b6-face', '100000531')]))
  check('B6', '本地已有 `card_id` 指针行 ⇒ 复用其 `id`（PR000000310），**零印人写步**',
    { ok: true, personWrites: 0, faceAuthor: 'PR000000310' },
    { ok: res.ok, personWrites: personWriteOf(res).length, faceAuthor: (faceWritesOf(res)[0] || {}).doc.author_person_id })
  check('B6b', '跨请求幂等：**零 CARD 调用**（本地镜像即命中，不重复验证）', 0, card.state.calls.length)
}

/* ---------------------------------------------------------------------------
   收尾
   --------------------------------------------------------------------------- */
restoreConsole()
console.log(JSON.stringify({ section: 'SUMMARY', failures }))
process.exit(failures === 0 ? 0 : 1)
