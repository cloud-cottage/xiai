'use strict'
/**
 * 玺爱 · **CARD 主库客户端（印人字段的主存储）**
 * ----------------------------------------------------------------------------
 * 口径（人类裁定，本单硬要求）：
 *   ① 印人字段的**主存储是 CARD**（另一 CloudBase 环境里的云函数 `card-api`，
 *      集合 `card_persons`）；xiai 侧（`xiai_persons`）是镜像 ＋ 工作流（提案 / 导入 / 审核）。
 *      该环境的**网关地址属运行时配置**（见 ③），本文件不写死任何域名 / 环境 id。
 *   ② xiai 的**采纳写入**（`reviewPersonProposal` / `reviewPersonImport` /
 *      `repairImportAcceptance`）必须**先写 CARD**，
 *      成功之后才允许把本地 `set` 推进落盘计划；**CARD 失败 ⇒ 整个 op 取消（零本地写入）**。
 *   ③ 本文件**只经 HTTP 通道**访问 CARD（跨环境 ⇒ 不能 `callFunction`）。请求形如
 *      `POST <CARD_API_URL>  {op, key, payload}`；回包一律带 `ok`，错误为 `{ok:false, code, msg}`。
 *   ④ **密钥永不入日志 / 永不入回包**：本文件**零日志输出**；`key` 只在请求体里出现一次，
 *      任何错误只回结构化 code（`UNAUTHORIZED` / `UPSTREAM_ERROR` …），不含 key、不含请求体。
 *   ⑤ 密钥取法（按序，**不写死、不入仓**）：
 *      ① `process.env.CARD_API_KEY`（若该函数环境已配）；
 *      ② 集合 `xiai_server_secrets` 文档 `card_api` 的 `key` 字段（本单新建；集合 ACL
 *         ＝ 全部不可读不可写，只有云函数的管理端凭据能读）。
 *      **两条都没有 ⇒ `{ok:false, code:'CONFIG_MISSING'}`**（fail-closed：**绝不静默降级成
 *      「只写 xiai 本地」** —— 那会造成「CARD 无此人、xiai 有」的双主库漂移）。
 *      基址同链：`CARD_API_URL` env → 同一文档 `base_url` 字段 → 都缺则 `CONFIG_MISSING`。
 *      注入缝 `setCardSecretProvider()` 由 `lib/ops.js` 提供（那里是本函数**唯一**持有
 *      集合句柄的地方 ⇒ 本文件零集合句柄字面，静态门照旧成立）。
 *   ⑥ **测试环境保护**：`XIAI_NO_REAL_CARD=1`（或 `NODE_ENV=test`）而**未注入**假传输 ⇒
 *      本文件**直接抛错、零请求**（防止测试进程误打生产 CARD）。
 *
 * 幂等 / 不重复建人（本文件的**核心正确性约束**）：
 *   `card-api` 的 `upsertPerson` **只按 `person_id` 去重**（无 `person_id` 时分配 `max+1`
 *   ⇒ 直接建新行，**不认 `sources`**）。因此去重责任在本文件：
 *     ① 本地行已带 `card_id` ⇒ 直接复用该 id（先 `getPerson` 核验；CARD 侧已删 ⇒ 继续走 ②）；
 *     ② 否则在 CARD 全量索引里按 **`sources` 引用**（`{system:'xiai', id:'PR…'}`，其次
 *        `{system:'cbdb', id:'<cbdb_id>'}`）找既有 `person_id` ⇒ 命中即**更新**（不建人）；
 *     ③ 都没命中 ⇒ 才 `upsertPerson`（新建一行，`sources` 一并落下，供下次命中）。
 *   ⇒ 「同一印人重复采纳」恒为 `created:false` ＋ 同一 `person_id`，CARD 行数不涨。
 *
 * 不覆盖既有内容（第二条硬约束）：
 *   更新走 `updatePersonFields`（白名单字段、`version` +1、**只改真变化的字段**），
 *   且**只送非空值**（空串 / `null` / 空数组一律不送）—— xiai 侧的稀疏行（导入行常常
 *   只有姓 / 名）**不得**把 CARD 里已有的字 / 號 / 齋名 / 生卒冲成空。
 */

/**
 * **CARD API 入口（运行时配置，代码内零域名）**
 * ----------------------------------------------------------------------------
 * 本文件**不留任何域名 / 网关串字面**（鉴权面机械尺 `verify-userwrite-pa` 的 D4：
 * 服务端不得与具体域名硬绑定）。基址按序取：
 *   ① `process.env.CARD_API_URL`（若该函数环境已配）；
 *   ② 集合 `xiai_server_secrets` 文档 `card_api` 的 `base_url` 字段（读点由 `lib/ops.js`
 *      经 `setCardSecretProvider` 注入 —— 本文件仍零集合句柄）；
 *   ③ 两者都没有 ⇒ `CONFIG_MISSING`（fail-closed：**不猜地址、不静默降级**）。
 * ⇒ 换环境 / 换网关只改配置，不改代码；测试注入 `setCardTransport()` 后基址不参与。
 */
const CARD_URL_ENV = 'CARD_API_URL'

/** 单次请求超时（毫秒）。CARD 侧 `exportPersons`（全量索引）实测 ~1.5s ⇒ 8s 有充分余量。 */
const CARD_TIMEOUT_MS = 8000

/** 落 `sources[].system` 的本系统名（CARD 种子数据用的就是 `xiai`）。 */
const CARD_SYSTEM = 'xiai'

/** CARD 可写字段白名单（与 `card-api/lib/ops.js::WRITABLE_FIELDS` 逐字同值；越界 ⇒ `INVALID_FIELD`）。 */
const CARD_WRITABLE_FIELDS = Object.freeze([
  'name',
  'family_name',
  'given_name',
  'courtesy_name',
  'courtesy_alt_names',
  'art_name',
  'biehao_text',
  'zhaihao',
  'zhaihao_alts',
  'dynasty',
  'birth_year',
  'death_year',
  'native_place',
  'biography',
  'tags'
])

/** 结构化判别码（上游同名码逐字透传；本文件自造的两个见注）。 */
const CARD_CODES = Object.freeze({
  /** 密钥两条取法都没有 ⇒ fail-closed（**不降级**）。 */
  CONFIG_MISSING: 'CONFIG_MISSING',
  /** 网络异常 / 超时 / 非 JSON 回包 / 回包缺 `person_id`（上游无此码，本文件独占）。 */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  /** 入参不合（本文件自己的前置校验）。 */
  INVALID_ARG: 'INVALID_ARG',
  /** 测试环境保护：设了哨兵（`XIAI_NO_REAL_CARD=1` / `NODE_ENV=test`）却未注入 transport ⇒ 抛错。 */
  TEST_GUARD: 'TEST_GUARD'
})

/**
 * **测试环境保护哨兵（硬防线）**：`XIAI_NO_REAL_CARD=1`（或 `NODE_ENV=test`）而
 * `setCardTransport()` **未注入** ⇒ 本文件**直接抛错、绝不发请求**。
 *
 * 为什么是抛错而不是回结构化失败：这类情形只可能出现在**忘了注入假传输的测试进程**里 ——
 * 静默失败会被断言吞掉（甚至被误读成「上游挂了」），必须**当场打断**，让漏注入暴露成红。
 * 生产不设该变量 ⇒ 行为逐字不变（真 `fetch` 走 ① ② 的运行时基址）。
 */
function testGuardError() {
  const error = new Error(
    'CARD_NETWORK_GUARD: 设了 XIAI_NO_REAL_CARD / NODE_ENV=test 但未注入 CARD transport —— 拒绝发起任何真实请求（测试必须注入假 CARD）。'
  )
  error.code = CARD_CODES.TEST_GUARD
  return error
}

/** 是否处于「禁止真网」的测试环境保护态（只看环境变量，不看其它状态）。 */
function testGuardArmed() {
  const env = process.env || {}
  return env.XIAI_NO_REAL_CARD === '1' || env.NODE_ENV === 'test'
}

/* ---------------------------------------------------------------------------
   注入缝（离线自检 / 宿主用；生产不注入 ⇒ 走真实 `fetch` ＋ `lib/ops.js` 供的密钥读点）
   --------------------------------------------------------------------------- */

let transport = null
let secretProvider = null

/**
 * 注入 HTTP 传输实现（`(url, init) => Promise<Response-like>`；传非函数 ⇒ 清除注入）。
 * @param {null|function(string, object):Promise<object>} fn
 */
function setCardTransport(fn) {
  transport = typeof fn === 'function' ? fn : null
}

/**
 * 注入密钥读取实现（`async () => ({key, source})`；传非函数 ⇒ 清除注入）。
 * 生产由 `lib/ops.js` 在模块加载时注册（那里能取集合句柄；本文件不能）。
 * @param {null|function():Promise<{key:string, source?:string}>} fn
 */
function setCardSecretProvider(fn) {
  secretProvider = typeof fn === 'function' ? fn : null
}

/* ---------------------------------------------------------------------------
   小工具（本文件自用；不引 ops.js 的任何私有件 ⇒ 零循环依赖）
   --------------------------------------------------------------------------- */

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function validPersonId(value) {
  const id = text(value)
  return /^\d{1,9}$/.test(id) ? id : ''
}

function textsOf(value) {
  return Array.isArray(value) ? value.map(text).filter((item) => item !== '') : []
}

/** 正整数年份（`null` / `''` / `0` / 负数 / 非数 ⇒ 不送 ⇒ 不覆盖 CARD 既有值）。 */
function yearOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null
}

/* ---------------------------------------------------------------------------
   配置解析（按序：① env ② 注入的读点 ⇒ 集合 `xiai_server_secrets#card_api`）
   --------------------------------------------------------------------------- */

/**
 * 解析 CARD 运行期配置（**本文件唯一的配置读取点**；密钥 ＋ 基址一并取，一次读点）。
 *
 * 密钥：① `process.env.CARD_API_KEY` ② 集合文档 `key` 字段；
 * 基址：① `process.env.CARD_API_URL` ② 集合文档 `base_url` 字段。
 * **读点抛错 ⇒ 一律降级成「空」⇒ 调用方 `CONFIG_MISSING`（fail-closed；错误文本不回吐）。**
 * @returns {Promise<{ok:true, key:string, keySource:string, baseUrl:string, baseUrlSource:string}>}
 */
async function resolveCardConfig() {
  const env = process.env || {}
  const envKey = text(env.CARD_API_KEY)
  const envBase = text(env[CARD_URL_ENV])
  let row = {}
  if (secretProvider) {
    try {
      const got = await secretProvider()
      /* 兼容两种返回形态：`{key, base_url}`（本单）与「直接回 key 串」（旧注入方）。 */
      row = got && typeof got === 'object' ? got : { key: got }
    } catch (error) {
      /* 读密钥失败**不**降级成真网（fail-closed）；错误文本里不含密钥 ⇒ 可安全丢弃。 */
      row = {}
    }
  }
  const key = envKey || text(row.key)
  const baseUrl = envBase || text(row.base_url) || text(row.baseUrl)
  return {
    ok: true,
    key,
    keySource: envKey ? 'env' : 'collection',
    baseUrl,
    baseUrlSource: envBase ? 'env' : 'collection'
  }
}

/**
 * 取 CARD 密钥（**本文件唯一的密钥读取点**）。
 * @returns {Promise<{ok:true, key:string, source:string}|{ok:false, code:string}>}
 */
async function resolveCardKey() {
  const config = await resolveCardConfig()
  if (!config.key) return { ok: false, code: CARD_CODES.CONFIG_MISSING }
  return { ok: true, key: config.key, source: config.keySource }
}

/* ---------------------------------------------------------------------------
   单次请求（唯一出口）：超时 / 网络异常 / 非 JSON ⇒ `UPSTREAM_ERROR`；上游码逐字透传
   --------------------------------------------------------------------------- */

/**
 * 调一次 CARD API。
 *
 * 出口顺序（**顺序本身是防线**）：
 *   ① 测试环境保护：哨兵已设 ＋ 未注入 transport ⇒ **抛错**（零请求）；
 *   ② 配置：密钥 / 基址任一缺 ⇒ `CONFIG_MISSING`（零请求）；注入 transport 时基址不参与；
 *   ③ 注入的 transport（离线自检）优先；否则真 `fetch` 打运行时基址。
 * @param {string} op CARD op 名（`ping` / `getPerson` / `upsertPerson` / `updatePersonFields` / `exportPersons`）
 * @param {object} payload op 载荷
 * @returns {Promise<{ok:true, raw:object}|{ok:false, code:string, raw?:object}>}
 */
async function request(op, payload) {
  /* ① 硬防线：测试环境保护态下未注入假传输 ⇒ 当场抛错（**绝不**悄悄打生产）。 */
  if (!transport && testGuardArmed()) throw testGuardError()
  const config = await resolveCardConfig()
  if (!config.key) return { ok: false, code: CARD_CODES.CONFIG_MISSING }
  let doFetch = transport
  if (!doFetch) {
    /* ② 真网路径必须显式配好基址（代码内零域名 ⇒ 不配即拒绝，不猜）。 */
    if (!config.baseUrl) return { ok: false, code: CARD_CODES.CONFIG_MISSING }
    doFetch = typeof fetch === 'function' ? fetch : null
    if (!doFetch) return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), CARD_TIMEOUT_MS) : null
  let reply = null
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, key: config.key, payload: payload && typeof payload === 'object' ? payload : {} })
    }
    if (controller) init.signal = controller.signal
    reply = await doFetch(config.baseUrl, init)
  } catch (error) {
    /* 超时（AbortError）与网络异常同一码；**错误对象不回吐**（防任何形态的密钥泄漏）。 */
    return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
  } finally {
    if (timer) clearTimeout(timer)
  }
  /* **HTTP 状态门（只判存在的状态码；注入式假体不设 `status` ⇒ 逐字跳过）**：
     非 2xx 一律 `UPSTREAM_ERROR` —— 网关 5xx / 404 的响应体常常**也是合法 JSON**，
     只按 body 判会把「网关错误」误读成「上游业务回包」；状态门让两类可分。 */
  if (reply && typeof reply.status === 'number' && (reply.status < 200 || reply.status >= 300)) {
    return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
  }
  let body = null
  try {
    if (reply && typeof reply.json === 'function') body = await reply.json()
    else if (reply && typeof reply.text === 'function') body = JSON.parse(await reply.text())
    else body = reply
  } catch (error) {
    return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
  }
  if (!body || typeof body !== 'object') return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
  if (body.ok !== true) {
    return { ok: false, code: text(body.code) || CARD_CODES.UPSTREAM_ERROR, raw: body }
  }
  return { ok: true, raw: body }
}

/* ---------------------------------------------------------------------------
   xiai 印人行 ⇒ CARD 可写字段（**只送非空值** ⇒ 不覆盖 CARD 既有内容）
   --------------------------------------------------------------------------- */

/**
 * 把 xiai 印人行映射成 CARD 可写字段面（`WRITABLE_FIELDS` 的封闭子集）。
 *
 * 映射（逐条，**不做任何转写 / 归一**，值原样送出）：
 *   · `name`               ⇐ `姓 + 名`（皆空 ⇒ `courtesy_names[0]`；再空 ⇒ `art_names[0]`）
 *   · `family_name` / `given_name` ⇐ 同名字段
 *   · `courtesy_name`      ⇐ `courtesy_names[0]`；`courtesy_alt_names` ⇐ 其余
 *   · `art_name`           ⇐ `art_names[0]`
 *   · `biehao_text`        ⇐ 其余 `art_names` ＋ `alias_names`（换行分隔；CARD 的既有形态）
 *   · `dynasty` / `birth_year` / `death_year` / `native_place` / `biography` ⇐ 同名字段
 *     （`native_place` / `biography` 为空时回落到简体的 `*_chs` 副本）
 *   ⇒ **空值一律不进字段面**（`''` / `null` / `[]` / 0 年），CARD 既有内容不被冲空。
 * @param {object} person xiai 印人行（`xiai_persons` 行形态）
 * @returns {object} CARD `updatePersonFields.fields` 形态（**可能为空对象**）
 */
function cardFieldsOf(person) {
  const row = person && typeof person === 'object' ? person : {}
  const courtesy = textsOf(row.courtesy_names)
  const art = textsOf(row.art_names)
  const alias = textsOf(row.alias_names)
  const family = text(row.family_name)
  const given = text(row.given_name)
  const fields = {}
  const fullName = text(family + given) || text(row.name_full) || courtesy[0] || art[0] || ''
  if (fullName) fields.name = fullName
  if (family) fields.family_name = family
  if (given) fields.given_name = given
  if (courtesy[0]) fields.courtesy_name = courtesy[0]
  if (courtesy.length > 1) fields.courtesy_alt_names = courtesy.slice(1)
  if (art[0]) fields.art_name = art[0]
  const biehao = art.slice(1).concat(alias).filter((item) => item !== '')
  if (biehao.length > 0) fields.biehao_text = biehao.join('\n')
  const dynasty = text(row.dynasty)
  if (dynasty) fields.dynasty = dynasty
  const birthYear = yearOf(row.birth_year)
  if (birthYear !== null) fields.birth_year = birthYear
  const deathYear = yearOf(row.death_year)
  if (deathYear !== null) fields.death_year = deathYear
  const nativePlace = text(row.native_place) || text(row.native_place_chs)
  if (nativePlace) fields.native_place = nativePlace
  const biography = text(row.biography) || text(row.biography_chs)
  if (biography) fields.biography = biography
  return fields
}

/**
 * 该印人在 CARD 的 `sources` 引用面（用于去重匹配）。
 * 顺序：① `person.sources`（调用方显式给定）② `xiai:<code>` ③ `cbdb:<cbdb_id>`。
 * @param {object} person xiai 印人行
 * @returns {Array<{system:string, id:string}>}
 */
function sourceRefsOf(person) {
  const row = person && typeof person === 'object' ? person : {}
  const refs = []
  const seen = new Set()
  const push = (system, id) => {
    const s = text(system)
    const v = text(id)
    if (!s || !v) return
    const token = `${s}:${v}`
    if (seen.has(token)) return
    seen.add(token)
    refs.push({ system: s, id: v })
  }
  if (Array.isArray(row.sources)) {
    row.sources.forEach((item) => {
      if (item && typeof item === 'object') push(item.system, item.id)
    })
  }
  const code = text(row.code) || text(row.id)
  if (code) push(CARD_SYSTEM, code)
  const cbdb = text(row.cbdb_id)
  if (cbdb) push('cbdb', cbdb)
  return refs
}

/* ---------------------------------------------------------------------------
   CARD 全量来源索引（**去重的唯一依据**；进程内 TTL 缓存 ⇒ 一个 op 只拉一次）
   --------------------------------------------------------------------------- */

/** TTL：60s（一次批审 200 行只拉一次；跨实例的新建行由「新建成功即写回本地索引」补上）。 */
const SOURCE_INDEX_TTL_MS = 60 * 1000

let sourceIndexCache = { at: 0, map: null, pending: null }

/** 清空索引缓存（离线自检 / 人工排障用；生产不调）。 */
function resetCardSourceIndex() {
  sourceIndexCache = { at: 0, map: null, pending: null }
}

/**
 * 取 CARD 全量 `sources` ⇒ `person_id` 索引（`Map<'system:id', 'person_id'>`）。
 * 失败 ⇒ `{ok:false, code}`（调用方据此取消整个采纳 —— **不猜**）。
 * @returns {Promise<{ok:true, map:Map<string,string>, size:number}|{ok:false, code:string}>}
 */
async function cardSourceIndex() {
  const now = Date.now()
  if (sourceIndexCache.map && now - sourceIndexCache.at < SOURCE_INDEX_TTL_MS) {
    return { ok: true, map: sourceIndexCache.map, size: sourceIndexCache.map.size }
  }
  if (sourceIndexCache.pending) return sourceIndexCache.pending
  const pending = (async () => {
    const res = await request('exportPersons', {})
    if (!res.ok) return { ok: false, code: res.code }
    const rows = Array.isArray(res.raw.rows) ? res.raw.rows : null
    if (!rows) return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
    const map = new Map()
    rows.forEach((row) => {
      const personId = validPersonId(row && row.person_id)
      if (!personId) return
      const refs = Array.isArray(row && row.sources) ? row.sources : []
      refs.forEach((ref) => {
        const system = text(ref && ref.system)
        const id = text(ref && ref.id)
        if (system && id) map.set(`${system}:${id}`, personId)
      })
    })
    sourceIndexCache = { at: Date.now(), map, pending: null }
    return { ok: true, map, size: map.size }
  })()
  sourceIndexCache.pending = pending
  const result = await pending
  if (!result.ok) sourceIndexCache.pending = null
  return result
}

/**
 * 按来源引用找既有 `person_id`（先 `xiai:` 后 `cbdb:`，与 `sourceRefsOf` 同序）。
 * @param {Array<{system:string,id:string}>} refs
 * @returns {Promise<{ok:true, personId:string, via:string}|{ok:true, personId:''}|{ok:false, code:string}>}
 */
async function findCardIdByRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return { ok: true, personId: '' }
  const index = await cardSourceIndex()
  if (!index.ok) return { ok: false, code: index.code }
  for (const ref of refs) {
    const hit = index.map.get(`${ref.system}:${ref.id}`)
    if (hit) return { ok: true, personId: hit, via: `${ref.system}:${ref.id}` }
  }
  return { ok: true, personId: '' }
}

/* ---------------------------------------------------------------------------
   对外三个函数
   --------------------------------------------------------------------------- */

/**
 * 读一个人（`getPerson`）—— **单人全字段读面**（公开 op `getPersonCard` 的首选源）。
 *
 * 回包 `person` 是 CARD 行**原样**（含 `biography` / `biography_chs` / `native_place` /
 * `biehao_text` / `zhaihao_alts` / `sources` / `version` 等全字段）—— 与 `getIndex`
 * 的 10 键瘦投影相对，**这里不做键面收窄**（上游就是主库真源）。
 * **单行读不做缓存**：写后立刻读必须能看到新值（索引才走 60s 缓存，见 `cardGetIndex`）。
 * @param {string} personId CARD `person_id`（九位数字串；`PR…` 形态属本地编号，**先经
 *   `xiai_persons.card_id` 映射**，本函数只认九位）
 * @returns {Promise<{ok:true, personId:string, person:object, raw:object}|{ok:false, code:string}>}
 */
async function cardGetPerson(personId) {
  const id = validPersonId(personId)
  if (!id) return { ok: false, code: CARD_CODES.INVALID_ARG }
  const res = await request('getPerson', { person_id: id })
  if (!res.ok) return { ok: false, code: res.code, raw: res.raw }
  const person = res.raw.person && typeof res.raw.person === 'object' ? res.raw.person : null
  if (!person) return { ok: false, code: CARD_CODES.UPSTREAM_ERROR, raw: res.raw }
  return { ok: true, personId: validPersonId(person.person_id) || id, person, raw: res.raw }
}

/**
 * 改既有人的若干字段（`updatePersonFields`：白名单字段、`version` +1、只改真变化的字段）。
 * @param {string} personId CARD `person_id`
 * @param {object} fields 字段面（键须在 `CARD_WRITABLE_FIELDS` 内）
 * @param {string} [source] `updated_by` 标记（缺省 `'xiai'`）
 * @returns {Promise<{ok:true, personId:string, changed:Array<string>, version:number, raw:object}|{ok:false, code:string}>}
 */
async function cardUpdateFields(personId, fields, source) {
  const id = validPersonId(personId)
  if (!id) return { ok: false, code: CARD_CODES.INVALID_ARG }
  const payloadFields = {}
  const row = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
  Object.keys(row).forEach((key) => {
    if (CARD_WRITABLE_FIELDS.indexOf(key) !== -1) payloadFields[key] = row[key]
  })
  if (Object.keys(payloadFields).length === 0) {
    return { ok: true, personId: id, changed: [], version: 0, raw: { ok: true, skipped: 'EMPTY_FIELDS' } }
  }
  const res = await request('updatePersonFields', {
    person_id: id,
    fields: payloadFields,
    source: text(source) || CARD_SYSTEM
  })
  if (!res.ok) return { ok: false, code: res.code, raw: res.raw }
  return {
    ok: true,
    personId: validPersonId(res.raw.person_id) || id,
    changed: Array.isArray(res.raw.changed) ? res.raw.changed : [],
    version: Number(res.raw.version) || 0,
    raw: res.raw
  }
}

/**
 * **把一枚印人 upsert 到 CARD（本单的唯一写入口）** —— 去重规则见文件头注：
 * ① 本地 `card_id` 复用 → ② 按 `sources` 引用在 CARD 索引里找 → ③ 都没有才新建。
 * 命中既有 ⇒ 走 `updatePersonFields`（只送非空、只改真变化）⇒ 回 `created:false`；
 * 未命中 ⇒ `upsertPerson`（`sources` 一并落下）⇒ 回 `created:true`。
 * @param {object} person xiai 印人行（`code`/`id` ＝ `PR…`；可带 `card_id`、`cbdb_id`、`sources`）
 * @param {string} [source] `updated_by` / `created` 标记（缺省 `'xiai'`）
 * @returns {Promise<{ok:true, personId:string, created:boolean, raw:object}|{ok:false, code:string, raw?:object}>}
 */
async function cardUpsertPerson(person, source) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) {
    return { ok: false, code: CARD_CODES.INVALID_ARG }
  }
  const tag = text(source) || CARD_SYSTEM
  const refs = sourceRefsOf(person)
  if (refs.length === 0) return { ok: false, code: CARD_CODES.INVALID_ARG }
  const fields = cardFieldsOf(person)

  /* ① 本地已有 `card_id` ⇒ 直接复用（先核验存在；CARD 已删 ⇒ 继续 ②）。 */
  let personId = validPersonId(person.card_id)
  if (personId) {
    const got = await cardGetPerson(personId)
    if (got.ok) {
      const updated = await cardUpdateFields(personId, fields, tag)
      if (!updated.ok) return { ok: false, code: updated.code, raw: updated.raw }
      return { ok: true, personId, created: false, raw: updated.raw }
    }
    if (got.code !== 'NOT_FOUND') return { ok: false, code: got.code, raw: got.raw }
    personId = ''
  }

  /* ② 按 `sources` 引用找既有（**不重复建人**）。 */
  if (!personId) {
    const found = await findCardIdByRefs(refs)
    if (!found.ok) return { ok: false, code: found.code }
    if (found.personId) {
      const updated = await cardUpdateFields(found.personId, fields, tag)
      if (!updated.ok) return { ok: false, code: updated.code, raw: updated.raw }
      return { ok: true, personId: found.personId, created: false, via: found.via, raw: updated.raw }
    }
  }

  /* ③ 新建：`upsertPerson` ＋ `sources`（下次即被 ② 命中）。 */
  const doc = Object.assign({}, fields)
  doc.sources = refs
  const res = await request('upsertPerson', { person: doc, source: tag })
  if (!res.ok) return { ok: false, code: res.code, raw: res.raw }
  const createdId = validPersonId(res.raw.person_id)
  if (!createdId) return { ok: false, code: CARD_CODES.UPSTREAM_ERROR, raw: res.raw }
  /* 新建成功 ⇒ 立刻写回本地索引（同一 op 内的后续行 / 60s 内的重放即命中，不建第二次）。 */
  const index = await cardSourceIndex()
  if (index.ok) refs.forEach((ref) => index.map.set(`${ref.system}:${ref.id}`, createdId))
  return { ok: true, personId: createdId, created: res.raw.created === true, raw: res.raw }
}

/* ---------------------------------------------------------------------------
   CARD 轻量索引（`getIndex`）—— **人物读面的首选源**（进程内 60s 缓存）
   ---------------------------------------------------------------------------
   为什么读面要走它：`xiai_persons` 的**属性字段**（字 / 號 / 齋號 / 朝代 / 別號）
   自 v1.108 起主存储已迁到 CARD，本地行只是镜像 ＋ 工作流 ⇒ 名录 / 检索 / 匹配都必须
   吃 CARD 的投影，否则「本地镜像没回填的行」在页面上是空的。

   回包口径（**上游 `card-api::getIndex` 逐字**）：
     `{ ok:true, generated_at:<ISO>, count:<行数>, rows:[…] }`
     每行**基面 10 键**（`person_id,name,family_name,given_name,courtesy_name,
     art_name,zhaihao,dynasty,tags,cbdb_id`）；`include_biehao:true` 再追加
     **2 键**（`biehao_text` / `zhaihao_alts`）⇒ 12 键（別號最占体积，按需取）。
   本文件**不信任上游的形状**：回包逐行经 `cardIndexRowOf` 收成上面这个封闭键面
   （多出的键**丢弃**、缺的键补 `''` / `[]`）—— 消费方（前端 / 匹配面）因此可以
   按固定键面解析。

   缓存：**进程内 Map ＋ 60s TTL，键 ＝ `includeBiehao`**（两个键面各自一份；一次名录页
   或一次批审只拉一次全量索引）。三条纪律：
     · **失败一律不缓存**（网络 / 超时 / 非 2xx ⇒ 下次调用立刻重试，绝不把一次抖动
       钉成 60s 的「CARD 不可用」）；
     · 同一键的**并发调用合并**（`pending` 去重 ⇒ N 个并发只发 1 次请求）；
     · **写后不主动失效**：TTL 60s 是既有口径（写路径只写单行、且写回本地索引见
       `cardUpsertPerson`），因此这里**不做**写后失效 —— 但**绝不缓存错误结果**。
   --------------------------------------------------------------------------- */

/** 索引缓存 TTL（＝ CARD 侧 `INDEX_TTL_MS` 同值；一次名录页 / 批审只拉一次）。 */
const CARD_INDEX_TTL_MS = 60 * 1000

/** 索引行的**基**键面（逐字 10 键，顺序即 CARD `INDEX_FIELDS`）。 */
const CARD_INDEX_ROW_KEYS = Object.freeze([
  'person_id',
  'name',
  'family_name',
  'given_name',
  'courtesy_name',
  'art_name',
  'zhaihao',
  'dynasty',
  'tags',
  'cbdb_id'
])

/** `includeBiehao:true` 时**追加**的键面（逐字 2 键，＝ CARD `INDEX_EXTRA_FIELDS`）。 */
const CARD_INDEX_BIEHAO_KEYS = Object.freeze(['biehao_text', 'zhaihao_alts'])

/** 索引缓存：`Map<'base'|'biehao', {at, generated_at, rows}>`（**只存成功结果**）。 */
let indexCache = new Map()
/** 并发合并：`Map<'base'|'biehao', Promise>`（同一个键的同刻多次调用只发一次请求）。 */
let indexPending = new Map()

/** 清空索引缓存 ＋ 并发登记（离线自检 / 人工排障用；生产不调）。 */
function resetCardIndexCache() {
  indexCache = new Map()
  indexPending = new Map()
}

/** 缓存键（`includeBiehao` 两个键面各一份 ⇒ 互不顶替）。 */
function indexCacheKeyOf(includeBiehao) {
  return includeBiehao ? 'biehao' : 'base'
}

/**
 * 把上游索引行收成**封闭键面**（基 10 键；`includeBiehao` 再 2 键）。
 * 值不做业务改写：文本键 trim 成串（缺 / null ⇒ `''`），`tags` / `zhaihao_alts` 取字符串数组。
 * @param {object} row 上游行（或本地 `xiai_persons` 行的同形投影，见 `localIndexRowOf`）
 * @param {boolean} includeBiehao 是否带別號两键
 * @returns {object} 10 或 12 键的行
 */
function cardIndexRowOf(row, includeBiehao) {
  const src = row && typeof row === 'object' ? row : {}
  const stringsOf = (value) =>
    Array.isArray(value) ? value.map((item) => text(item)).filter((item) => item !== '') : []
  const out = {
    person_id: text(src.person_id),
    name: text(src.name),
    family_name: text(src.family_name),
    given_name: text(src.given_name),
    courtesy_name: text(src.courtesy_name),
    art_name: text(src.art_name),
    zhaihao: text(src.zhaihao),
    dynasty: text(src.dynasty),
    tags: stringsOf(src.tags),
    cbdb_id: text(src.cbdb_id)
  }
  if (includeBiehao) {
    out.biehao_text = text(src.biehao_text)
    out.zhaihao_alts = stringsOf(src.zhaihao_alts)
  }
  return out
}

/**
 * 读 CARD 全量人物索引（`getIndex`；**只读、零写**）。
 *
 * 失败一律收成 `{ok:false, code}`（调用方据此决定降级本地 / 报错）：
 *   · 网络异常 / 超时 / 非 2xx / 回包缺 `rows` ⇒ `UPSTREAM_ERROR`（**不含上游原文**）；
 *   · 密钥 / 基址没配 ⇒ `CONFIG_MISSING`（与写路径同码，便于运维分流）；
 *   · 入参不合 ⇒ `INVALID_ARG`。
 * **绝不**回「空数组冒充成功」：CARD 挂了就是 `ok:false`，由调用方显式降级。
 * @param {{includeBiehao?:boolean}} [options] `includeBiehao:true` ⇒ 行内带別號两键
 * @returns {Promise<{ok:true, generated_at:string, count:number, rows:Array<object>, cached:boolean}|
 *                   {ok:false, code:string}>}
 */
async function cardGetIndex(options) {
  const raw = options && typeof options === 'object' ? options : {}
  if (raw.includeBiehao !== undefined && typeof raw.includeBiehao !== 'boolean') {
    return { ok: false, code: CARD_CODES.INVALID_ARG }
  }
  const includeBiehao = raw.includeBiehao === true
  const key = indexCacheKeyOf(includeBiehao)
  const hit = indexCache.get(key)
  if (hit && Date.now() - hit.at < CARD_INDEX_TTL_MS) {
    return { ok: true, generated_at: hit.generated_at, count: hit.rows.length, rows: hit.rows.slice(), cached: true }
  }
  if (indexPending.has(key)) return indexPending.get(key)
  const task = (async () => {
    let res = null
    try {
      res = await request('getIndex', { include_biehao: includeBiehao })
    } catch (error) {
      /* **读面降级（与写面 fail-closed 相区别）**：`request` 在「哨兵已设 ＋ 未注入假传输」时
         会**抛错**（写面靠这个抛错把漏注入暴露成红）。索引读面是**只读降级面** —— 调用方
         有显式的本地回落（`source:'local-fallback'`），所以这里把抛错收成结构化失败：
         抛错与 `{ok:false}` 都**零请求**（绝不悄悄打真网），但读面不该因一次配置/注入缺失
         就让整页名录 500。写面（`cardUpsertPerson` 等）**不吞**该抛错。 */
      return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
    }
    if (!res.ok) {
      /* 配置缺失保留原码（运维分流用）；其余一律归 `UPSTREAM_ERROR`（网络 / 超时 / 非 2xx / 上游码）。 */
      const code = res.code === CARD_CODES.CONFIG_MISSING ? CARD_CODES.CONFIG_MISSING : CARD_CODES.UPSTREAM_ERROR
      return { ok: false, code }
    }
    const upstreamRows = Array.isArray(res.raw.rows) ? res.raw.rows : null
    if (!upstreamRows) return { ok: false, code: CARD_CODES.UPSTREAM_ERROR }
    const rows = upstreamRows.map((row) => cardIndexRowOf(row, includeBiehao))
    const generatedAt = text(res.raw.generated_at) || new Date().toISOString()
    /* **只缓存成功结果**（失败走上面的早退 ⇒ 永不入缓存）。 */
    indexCache.set(key, { at: Date.now(), generated_at: generatedAt, rows })
    return { ok: true, generated_at: generatedAt, count: rows.length, rows: rows.slice(), cached: false }
  })()
  indexPending.set(key, task)
  try {
    return await task
  } finally {
    indexPending.delete(key)
  }
}

/**
 * 只读探针（运维 / 预演用；**不写任何东西**）。
 * @returns {Promise<{ok:true, persons:number, raw:object}|{ok:false, code:string}>}
 */
async function cardPing() {
  const res = await request('ping', {})
  if (!res.ok) return { ok: false, code: res.code, raw: res.raw }
  return { ok: true, persons: Number(res.raw.persons) || 0, raw: res.raw }
}

module.exports = {
  CARD_URL_ENV,
  CARD_TIMEOUT_MS,
  CARD_SYSTEM,
  CARD_WRITABLE_FIELDS,
  CARD_CODES,
  /* 索引读面（公开 op `listPersonCards` 的首选源；行键面供离线自检逐字断言）。 */
  CARD_INDEX_TTL_MS,
  CARD_INDEX_ROW_KEYS,
  CARD_INDEX_BIEHAO_KEYS,
  setCardTransport,
  setCardSecretProvider,
  resetCardSourceIndex,
  resetCardIndexCache,
  resolveCardConfig,
  resolveCardKey,
  testGuardArmed,
  cardFieldsOf,
  sourceRefsOf,
  cardGetIndex,
  cardIndexRowOf,
  cardGetPerson,
  cardUpdateFields,
  cardUpsertPerson,
  cardPing
}
