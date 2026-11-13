/**
 * 玺爱 · **离线假 CARD 传输（测试夹具）** —— `scripts/fixtures/fake-card.mjs`
 * ----------------------------------------------------------------------------
 * 为什么要有它：`lib/ops.js` 的印人采纳路径已接 CARD 主库且 **fail-closed**
 * （拿不到密钥 / 传输失败 ⇒ 整个 op 拒绝、零本地写入）。任何**离线**套件只要走到
 * 采纳路径，就必须注入**假 CARD**：
 *   ① 否则在无密钥的机器上会被 fail-closed 判红（假红）；
 *   ② 若宿主 shell 恰好导出了 `CARD_API_KEY`，`lib/cardApi.js` 会**真的打生产 CARD**
 *      （测试行写进主库 —— 真事故）。
 *
 * 纪律：本夹具**只动注入缝**（`setCardTransport` / `setCardSecretProvider`）＋ 设
 * **测试环境保护哨兵** `XIAI_NO_REAL_CARD=1`，生产代码的 fail-closed **一字不改**；
 * 同时把任何发往**绝对地址**的真 `fetch` 拦成显式异常，让「漏注入」当场报错，
 * 而不是静默联网。
 *
 * 用法（每个套件在 require 被测件之后调用一次，整个进程内常驻）：
 *   import { createFakeCard, installFakeCard } from './fixtures/fake-card.mjs'
 *   const fakeCard = installFakeCard(createFakeCard())
 *   fakeCard.setMode('unauthorized')   // 需要时切失败模式，事后 setMode('ok')
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const cardApi = require(path.join(ROOT, 'cloudfunctions/xiai-user-token/lib/cardApi.js'))

/** 假密钥（合成值；只用于证明「密钥确实被送进请求体」，不出现在任何断言输出里）。 */
export const TEST_CARD_KEY = 'test-card-key-fixture-0000'

/** 假 CARD 基址（合成值；`installFakeCard` 把它供进配置读点，生产代码内零域名）。 */
export const TEST_CARD_BASE_URL = 'http://fake-card.invalid/card-api'

/** 假 CARD 首个分配 id（九位数字串，与 CARD `person_id` 形态同形）。 */
export const TEST_CARD_FIRST_ID = 900000001

/** 索引投影的基键面（逐字 10 键，与 `card-api/lib/ops.js::INDEX_FIELDS` 同值同序）。 */
export const TEST_CARD_INDEX_FIELDS = [
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
]

/** `include_biehao:true` 时追加的两键（＝ `card-api` 的 `INDEX_EXTRA_FIELDS`）。 */
export const TEST_CARD_INDEX_EXTRA_FIELDS = ['biehao_text', 'zhaihao_alts']

/**
 * 索引行投影（**与生产 `card-api` 的 `projectIndexRow` 同法**）：
 * 固定 10 字段，`includeBiehao` 时再追加 `biehao_text` / `zhaihao_alts`
 * （別號最占体积 ⇒ 按需取；名录首屏不带、搜索面才带）。
 */
export function projectIndexRow(doc, includeBiehao) {
  const row = doc && typeof doc === 'object' ? doc : {}
  const asText = (value) => (value === null || value === undefined ? '' : String(value))
  const asTextArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  const out = {
    person_id: asText(row.person_id || row._id),
    name: asText(row.name),
    family_name: asText(row.family_name),
    given_name: asText(row.given_name),
    courtesy_name: asText(row.courtesy_name),
    art_name: asText(row.art_name),
    zhaihao: asText(row.zhaihao),
    dynasty: asText(row.dynasty),
    tags: asTextArray(row.tags),
    cbdb_id: asText(row.cbdb_id)
  }
  if (includeBiehao) {
    out.biehao_text = asText(row.biehao_text)
    out.zhaihao_alts = asTextArray(row.zhaihao_alts)
  }
  return out
}

/**
 * 造一个内存假 CARD（`ping` / `exportPersons` / `getPerson` / `updatePersonFields` / `upsertPerson`）。
 * @param {{firstId?:number, persons?:Array<object>}} [options]
 */
export function createFakeCard(options = {}) {
  const state = {
    mode: 'ok',
    calls: [],
    seen: new Set(),
    /* 索引 `generated_at`（固定值 ⇒ 断言可对拍；生产是服务端现算的 ISO）。 */
    generatedAt: String(options.generatedAt || '2026-11-13T00:00:00.000Z'),
    persons: new Map((options.persons || []).map((row) => [String(row.person_id), Object.assign({}, row)])),
    nextId: Number(options.firstId) || TEST_CARD_FIRST_ID,
    blocked: 0
  }
  const reply = (body) => ({ ok: true, json: async () => body })

  const transport = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}')
    state.calls.push({ op: body.op, payload: body.payload, keyed: Boolean(body.key) })
    state.seen.add(String(body.op))
    if (state.mode === 'unauthorized') return reply({ ok: false, code: 'UNAUTHORIZED', msg: 'key 无效' })
    if (state.mode === 'down') return reply({ ok: false, code: 'UPSTREAM_ERROR', msg: '上游不可用' })
    /* `abort` ＝ 模拟**超时被 abort**（`request` 的 catch 路径与真超时**同一条**，
       但不真等 8s ⇒ 套件可以在毫秒级验「超时 ⇒ 降级」）。 */
    if (state.mode === 'abort') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const payload = body.payload || {}
    if (body.op === 'ping') return reply({ ok: true, version: '1', persons: state.persons.size })
    /* **索引读面（`getIndex`）**：与生产 `card-api::getIndex` 同契约
       （`{ok, generated_at, count, rows}`，行面 10 键 / `include_biehao` 时 12 键）。 */
    if (body.op === 'getIndex') {
      const includeBiehao = payload.include_biehao === true
      const rows = [...state.persons.values()].map((row) => projectIndexRow(row, includeBiehao))
      if (state.mode === 'index-broken') return reply({ ok: true, generated_at: state.generatedAt })
      return reply({ ok: true, generated_at: state.generatedAt, count: rows.length, rows })
    }
    if (body.op === 'exportPersons') return reply({ ok: true, rows: [...state.persons.values()].map((row) => Object.assign({}, row)) })
    if (body.op === 'getPerson') {
      const row = state.persons.get(String(payload.person_id))
      return row ? reply({ ok: true, person: Object.assign({}, row) }) : reply({ ok: false, code: 'NOT_FOUND', msg: '人物不存在' })
    }
    if (body.op === 'updatePersonFields') {
      const row = state.persons.get(String(payload.person_id))
      if (!row) return reply({ ok: false, code: 'NOT_FOUND', msg: '人物不存在' })
      const fields = payload.fields || {}
      const changed = Object.keys(fields).filter((key) => JSON.stringify(row[key]) !== JSON.stringify(fields[key]))
      changed.forEach((key) => { row[key] = fields[key] })
      if (changed.length > 0) row.version = (Number(row.version) || 1) + 1
      return reply({ ok: true, person_id: String(row.person_id), version: row.version, changed })
    }
    if (body.op === 'upsertPerson') {
      const person = payload.person || {}
      const id = String(person.person_id || state.nextId)
      if (!person.person_id) state.nextId += 1
      const existing = state.persons.get(id)
      state.persons.set(id, Object.assign({}, person, { person_id: id, version: (Number(existing && existing.version) || 0) + 1 }))
      return reply({ ok: true, person_id: id, created: !existing })
    }
    return reply({ ok: false, code: 'UNKNOWN_OP', msg: '未知的 op' })
  }

  return {
    state,
    transport,
    /** 切模式：`ok` / `unauthorized` / `down`。 */
    setMode(mode) { state.mode = String(mode || 'ok') },
    /** 清调用账（不断开注入；**不**动生产读点）。 */
    resetCalls() { state.calls.length = 0 },
    /** 已发生的 op 序列（如 `['exportPersons','upsertPerson']`）。 */
    ops() { return state.calls.map((call) => call.op) },
    /** 全程累计出现过的 op（**不受 `resetCalls()` 影响**）。 */
    seenOps() { return [...state.seen] },
    persons() { return [...state.persons.values()].map((row) => Object.assign({}, row)) },
    /** 被护栏拦下的真网络次数（**必须恒 0**）。 */
    blockedFetches() { return state.blocked }
  }
}

/**
 * 把假 CARD 接到 `lib/cardApi.js` 的两个注入缝上，并装**真网护栏**。
 *
 * 三重（顺序即防线）：
 *   ① 设哨兵 `XIAI_NO_REAL_CARD=1` ⇒ 即使哪个调用点漏注入 transport，`cardApi` 也**当场抛错**；
 *   ② 两个注入缝（transport ＋ 密钥/基址读点）；
 *   ③ `globalThis.fetch` 包一层：**任何**绝对地址请求都被拦下并计数（必须恒 0）。
 * @param {ReturnType<typeof createFakeCard>} card
 * @returns {ReturnType<typeof createFakeCard>} 同一个句柄（便于 `const fakeCard = installFakeCard(...)`）
 */
export function installFakeCard(card) {
  process.env.XIAI_NO_REAL_CARD = '1'
  cardApi.resetCardSourceIndex()
  cardApi.setCardSecretProvider(async () => ({ key: TEST_CARD_KEY, base_url: TEST_CARD_BASE_URL, source: 'test-fixture' }))
  cardApi.setCardTransport(card.transport)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (/^[a-z]+:\/\//i.test(String(url))) {
      card.state.blocked += 1
      throw new Error('FAKE_CARD_GUARD: 真网请求被拦截（套件应注入假传输）')
    }
    if (typeof realFetch !== 'function') throw new Error('FAKE_CARD_GUARD: 运行环境无 fetch')
    return realFetch(url, init)
  }
  return card
}
