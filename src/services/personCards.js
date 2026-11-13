/**
 * 玺爱 · **印人属性读面（CARD 主库优先，本地降级）**
 * ============================================================================
 * 为什么单独立档：人物属性（姓名 / 字 / 號 / 齋號 / 別署齋號 / 別號 / 朝代 / CBDB / 籍貫 / 小传）
 * 的**主存储已迁到 CARD**（`card-api` 集合 `card_persons`）。本文件是前端**唯一**知道
 * 「怎么取 CARD 人物数据」的地方 —— 名录、详情、广场卡片显示名、印人选择器**一律**经此。
 *
 * 读面契约（两个公开只读 op；已上线，`PUBLIC_OPS` 成员）：
 *   · `listPersonCards` 载荷 `{include_biehao:true}` ⇒ `{ok, generated_at, count, rows[12 键]}`；
 *     CARD 不可用时云函数降级读本地镜像并在回包追加 `source:'local-fallback'`（显式标记）。
 *     索引行键面：`person_id(九位) / name / family_name / given_name / courtesy_name /
 *     art_name / zhaihao / dynasty / tags / cbdb_id`（`include_biehao` 再加
 *     `biehao_text` / `zhaihao_alts`）。
 *   · `getPersonCard` 载荷 `{person_id}`（**九位号或 `PR…` 均可**）⇒ `{ok, person}`（全字段）。
 *
 * 硬口径（逐条）：
 *   · **不抛错**：本文件对外一切入口失败都是结构化回包（`{ok:false, reason, message}`）——
 *     调用方多在渲染路径上，抛错会把整页打成白屏。
 *   · **缓存**：索引 ＝ **进程内单例**（一次成功终生复用；失败按 `INDEX_RETRY_MS` 退避重试，
 *     避免网络抖动时每个组件各发一次）；详情 ＝ 按编号缓存 60 s（`DETAIL_CACHE_TTL_MS`）。
 *   · **响应式**：索引状态放在 `shallowRef`（与 `data/cloudbase.js` 同一套「现有响应式机制」，
 *     **不引新状态库**）⇒ 快照到位后，读它的 `computed`（卡片显示名等）自动重算重渲。
 *   · **零新依赖**：只用工程既有 `vue` ＋ `data/cloudbaseFn.js`（云函数调用缝）。
 *   · **本地 `xiai_persons` 降为 fallback**：CARD 值非空则用 CARD 值，CARD 缺席/为空才回落本地
 *     属性字段 —— 这正是「把本地属性字段置空后全站显示仍正确」的判据。
 *
 * 调试钩子 `?cardsOnly=1`（**仅调试用，规范待登记**）：
 *   URL 带该参数 ⇒ `personAttributesOf()` **忽略本地属性字段**、只认 CARD；CARD 未就绪 / 失败时
 *   **宁可不显示也不回退**，用来暴露「还有谁在偷偷依赖本地字段」。生产不留常驻入口，无参数即失效。
 */

import { shallowRef } from 'vue'
import { callCloudFunction } from '../data/cloudbaseFn.js'
import { cloudBaseConfigured } from '../data/cloudbase.js'
/* **循环导入（已知且有界）**：`data/db.js::personDisplayName` 反向 import 本文件的
   `personAttributesOf`（显示名单点改吃 CARD）。两侧都只在**函数体内**使用对方导出，
   且本文件导出的都是函数声明（hoisted）⇒ 任一方向先求值都不会踩 TDZ。 */
import { listPersonRows } from '../data/db.js'

/** 承载两个人物读 op 的云函数名（与 `listSealCards` / `suggestAuthors` 同一函数）。 */
export const PERSON_CARDS_FUNCTION_NAME = 'xiai-user-token'

/** 公开只读 action（云函数 `index.js` 在令牌校验**之前**按此值分流）。 */
export const PERSON_CARDS_ACTION = 'public'

/** 索引 op 名（逐字；云函数 `PUBLIC_OPS` 成员）。 */
export const LIST_PERSON_CARDS_OP = 'listPersonCards'

/** 详情 op 名（逐字；云函数 `PUBLIC_OPS` 成员）。 */
export const GET_PERSON_CARD_OP = 'getPersonCard'

/** 云函数降级标记字面值（回包出现 ⇒ 索引行其实来自本地镜像）。 */
export const PERSON_CARD_SOURCE_LOCAL = 'local-fallback'

/** 详情缓存 TTL（毫秒）。 */
export const PERSON_DETAIL_CACHE_TTL_MS = 60000

/** 索引失败后的重试退避（毫秒）：期间内重复调用**不再发请求**（首屏只多 1 次的保证之一）。 */
export const PERSON_INDEX_RETRY_MS = 60000

/** 属性键面（CARD 索引行 ⇒ 对外属性对象；逐字，与云函数冻结键面同名）。 */
const ATTRIBUTE_KEYS = Object.freeze([
  'name',
  'family_name',
  'given_name',
  'courtesy_name',
  'art_name',
  'zhaihao',
  'dynasty',
  'cbdb_id',
  'biehao_text',
  'zhaihao_alts'
])

/** 单值取文本（`null` / `undefined` ⇒ `''`；其余 `String().trim()`）。 */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 字符串数组归一（非数组 ⇒ `[]`；逐项 trim、空值丢弃）。 */
function textsOf(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = textOf(item)
    if (text) out.push(text)
  }
  return out
}

/**
 * **调试闸门**（仅调试用，规范待登记）：URL 带 `?cardsOnly=1` ⇒ 只认 CARD，不回退本地属性字段。
 * 每次**调用时**读 `location.search`（路由 `pushState` 改 URL 后即时生效；无 window 环境 ⇒ false）。
 * @returns {boolean}
 */
export function cardsOnlyMode() {
  try {
    if (typeof window === 'undefined' || !window.location) return false
    const search = String(window.location.search || '')
    return /[?&]cardsOnly=1(?:&|$)/.test(search)
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------------------
   1. 索引（进程内单例 ＋ shallowRef 驱动重算）
   ------------------------------------------------------------------------- */

/** 索引状态：`{ok:true, at, generated_at, source, rows, byId}` / `{ok:false, reason, message, at}`。 */
const indexState = shallowRef(null)

/** 并发合并：同刻多次调用只发一次请求。 */
let indexPromise = null

/** 索引是否已就绪（CARD 快照在手）。 */
export function personIndexReady() {
  const state = indexState.value
  return !!(state && state.ok === true)
}

/** 索引诊断读数（不含网络细节；供自检 / 排障）。 */
export function personIndexStatus() {
  const state = indexState.value
  if (!state) return { loaded: false, ok: false, count: 0, source: '', generated_at: '' }
  return {
    loaded: true,
    ok: state.ok === true,
    count: Array.isArray(state.rows) ? state.rows.length : 0,
    source: textOf(state.source),
    generated_at: textOf(state.generated_at),
    reason: textOf(state.reason)
  }
}

/** 索引行归一（封闭 10/12 键面；`person_id` 缺失 ⇒ 丢弃该行）。 */
function normalizeIndexRow(row) {
  if (!row || typeof row !== 'object') return null
  const personId = textOf(row.person_id)
  if (!personId) return null
  return {
    person_id: personId,
    name: textOf(row.name),
    family_name: textOf(row.family_name),
    given_name: textOf(row.given_name),
    courtesy_name: textOf(row.courtesy_name),
    art_name: textOf(row.art_name),
    zhaihao: textOf(row.zhaihao),
    dynasty: textOf(row.dynasty),
    tags: textsOf(row.tags),
    cbdb_id: textOf(row.cbdb_id),
    biehao_text: textOf(row.biehao_text),
    zhaihao_alts: textsOf(row.zhaihao_alts)
  }
}

/** 真取一次索引（**不抛错**；调用方拿结构化回包）。 */
async function fetchIndexState() {
  if (!cloudBaseConfigured()) {
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '未配置雲端讀取面，印人屬性或暫不可用。' }
  }
  try {
    const reply = await callCloudFunction(PERSON_CARDS_FUNCTION_NAME, {
      action: PERSON_CARDS_ACTION,
      op: LIST_PERSON_CARDS_OP,
      payload: { include_biehao: true }
    })
    if (!reply || reply.ok !== true) {
      return {
        ok: false,
        reason: textOf(reply && reply.reason) || 'STORAGE_UNAVAILABLE',
        message: textOf(reply && reply.message) || '印人索引讀取失敗（雲端暫不可用）。'
      }
    }
    const result = reply.result && typeof reply.result === 'object' ? reply.result : {}
    if (result.ok === false) {
      return {
        ok: false,
        reason: textOf(result.reason) || 'STORAGE_UNAVAILABLE',
        message: textOf(result.message) || '印人索引讀取被雲端拒絕。'
      }
    }
    if (!Array.isArray(result.rows)) {
      return { ok: false, reason: 'BAD_REPLY', message: '印人索引回傳形狀不可辨識（未帶 rows）。' }
    }
    const rows = result.rows.map(normalizeIndexRow).filter(Boolean)
    const byId = new Map()
    rows.forEach((row) => {
      if (row.person_id && !byId.has(row.person_id)) byId.set(row.person_id, row)
    })
    return {
      ok: true,
      at: Date.now(),
      generated_at: textOf(result.generated_at),
      /* CARD 路无 `source` 键；有值且为 `local-fallback` ⇒ 云侧已降级读本地镜像。 */
      source: textOf(result.source) || 'card',
      rows,
      byId
    }
  } catch (error) {
    /* 传输层异常一律收成结构化失败（渲染路径上不得抛）。 */
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '印人索引讀取異常（網路）；已回退本地屬性。' }
  }
}

/**
 * **载入人物索引**（进程内单例）。成功 ⇒ 落快照并返回；失败 ⇒ 返回结构化失败且**不抛错**。
 * 失败态在 `PERSON_INDEX_RETRY_MS` 内复用（不再发请求）；超时后允许重试。
 * @param {{force?:boolean}} [options]
 * @returns {Promise<{ok:true, count:number, source:string}|{ok:false, reason:string, message:string}>}
 */
export async function loadPersonIndex(options = {}) {
  const force = options && options.force === true
  if (!force) {
    const state = indexState.value
    if (state && state.ok === true) {
      return { ok: true, count: state.rows.length, source: textOf(state.source) }
    }
    if (state && state.ok === false && Date.now() - Number(state.at || 0) < PERSON_INDEX_RETRY_MS) {
      return { ok: false, reason: textOf(state.reason), message: textOf(state.message) }
    }
    if (indexPromise) return indexPromise
  }
  indexPromise = (async () => {
    const fetched = await fetchIndexState()
    const settled = fetched.ok === true ? fetched : { ...fetched, at: Date.now() }
    indexState.value = settled
    indexPromise = null
    if (settled.ok === true) return { ok: true, count: settled.rows.length, source: textOf(settled.source) }
    return { ok: false, reason: textOf(settled.reason), message: textOf(settled.message) }
  })()
  try {
    return await indexPromise
  } catch (error) {
    indexPromise = null
    return { ok: false, reason: 'STORAGE_UNAVAILABLE', message: '印人索引載入失敗（未預期異常）。' }
  }
}

/** 清空索引 / 详情缓存（自检、排障、切换数据源时用；生产不调）。 */
export function resetPersonCardsCache() {
  indexState.value = null
  indexPromise = null
  detailCache.clear()
}

/* ---------------------------------------------------------------------------
   2. 本地 `xiai_persons` 行（fallback 投影，与云侧降级口径同向）
   ------------------------------------------------------------------------- */

/** 按 `id` / `code` / `_id` 取本地印人行（未命中 ⇒ `null`）。 */
function localPersonRowOf(personId) {
  const id = textOf(personId)
  if (!id) return null
  const rows = listPersonRows()
  if (!Array.isArray(rows)) return null
  return (
    rows.find((row) => row && (textOf(row.id) === id || textOf(row.code) === id || textOf(row._id) === id)) || null
  )
}

/** 本地行 ⇒ 属性面（**与 CARD 索引行同形**；旧三数组兼容取首项）。 */
function localAttributesOf(row) {
  if (!row || typeof row !== 'object') return null
  const courtesy = textsOf(row.courtesy_names)
  const art = textsOf(row.art_names)
  const alias = textsOf(row.alias_names)
  const family = textOf(row.family_name)
  const given = textOf(row.given_name)
  const courtesyName = textOf(row.courtesy_name) || courtesy[0] || ''
  const artName = textOf(row.art_name) || art[0] || ''
  const biehao = textOf(row.biehao_text) || art.slice(1).concat(alias).filter(Boolean).join('\n')
  return {
    name: `${family}${given}` || textOf(row.name_full) || textOf(row.name) || courtesyName || artName,
    family_name: family,
    given_name: given,
    courtesy_name: courtesyName,
    art_name: artName,
    zhaihao: textOf(row.zhaihao),
    dynasty: textOf(row.dynasty),
    cbdb_id: textOf(row.cbdb_id),
    biehao_text: biehao,
    zhaihao_alts: textsOf(row.zhaihao_alts)
  }
}

/** 索引行 ⇒ 属性面（恰 10 键；空值 ⇒ 空串 / 空数组）。 */
function attributesOfCardRow(row) {
  if (!row || typeof row !== 'object') return null
  const out = {}
  ATTRIBUTE_KEYS.forEach((key) => {
    out[key] = key === 'zhaihao_alts' ? textsOf(row[key]) : textOf(row[key])
  })
  return out
}

/**
 * 逐字段合并：**CARD 非空优先**，CARD 为空才取本地值（数组同理）。
 * 「CARD 優先、本地降級」在字段粒度上成立 ⇒ 迁移未覆盖的零散字段（如某人的 `zhaihao`）不会因
 * CARD 侧空值而消失。
 */
function mergeAttributes(card, local) {
  if (!card) return local
  if (!local) return card
  const out = {}
  ATTRIBUTE_KEYS.forEach((key) => {
    if (key === 'zhaihao_alts') {
      out[key] = Array.isArray(card[key]) && card[key].length > 0 ? card[key] : local[key] || []
    } else {
      out[key] = textOf(card[key]) || textOf(local[key])
    }
  })
  return out
}

/* ---------------------------------------------------------------------------
   3. 对外读面
   ------------------------------------------------------------------------- */

/**
 * **按本地编号取 CARD 索引行**：`PR…` ⇒ 本地 thin 行 `card_id` ⇒ 索引行；九位号 ⇒ 直接命中。
 * 索引未就绪 / 该人不在索引 ⇒ `null`（**不臆造**）。
 * @param {string} prId 本地编号（`PR…` / `id` / `code`）或 CARD 九位号
 * @returns {object|null}
 */
export function indexRowOfPrId(prId) {
  const state = indexState.value
  if (!state || state.ok !== true) return null
  const id = textOf(prId)
  if (!id) return null
  if (state.byId.has(id)) return state.byId.get(id)
  const local = localPersonRowOf(id)
  const cardId = textOf(local && local.card_id)
  if (cardId && state.byId.has(cardId)) return state.byId.get(cardId)
  return null
}

/**
 * **印人属性（CARD 优先，本地 fallback）** —— 全站显示名 / 字号 / 齋號的唯一数据源。
 *
 * 只读**已加载**的索引快照（内部零 `await`）⇒ 可在 `computed` / 渲染路径直接调用；
 * 快照未就绪时返回本地投影（索引到位后因 `shallowRef` 变更自动重算）。
 *
 * @param {string|object} prIdOrRow 本地编号（`PR…` / 九位号）或本地印人行（供批量合并少走查找）
 * @returns {null|{name:string, family_name:string, given_name:string, courtesy_name:string,
 *   art_name:string, zhaihao:string, dynasty:string, cbdb_id:string, biehao_text:string,
 *   zhaihao_alts:string[]}} 无任何数据（或 `?cardsOnly=1` 且 CARD 未就绪）⇒ `null`
 */
export function personAttributesOf(prIdOrRow) {
  const localRow = prIdOrRow && typeof prIdOrRow === 'object' ? prIdOrRow : localPersonRowOf(prIdOrRow)
  const key = localRow
    ? textOf(localRow.id) || textOf(localRow.code) || textOf(localRow._id)
    : textOf(prIdOrRow)
  const cardRow = indexRowOfPrId(key) || (() => {
    /* 行对象可能只有 `card_id`（thin 行）：直接按 `card_id` 命中索引。 */
    const cardId = textOf(localRow && localRow.card_id)
    const state = indexState.value
    return cardId && state && state.ok === true && state.byId.has(cardId) ? state.byId.get(cardId) : null
  })()
  const fromCard = cardRow ? attributesOfCardRow(cardRow) : null
  if (cardsOnlyMode()) return fromCard
  const fromLocal = localRow ? localAttributesOf(localRow) : null
  return mergeAttributes(fromCard, fromLocal)
}

/* ---------------------------------------------------------------------------
   4. 详情（单人全字段；60 s 缓存 ＋ 本地降级）
   ------------------------------------------------------------------------- */

/** `key(person_id)` ⇒ `{at, value}`。 */
const detailCache = new Map()

/** CARD 全字段 ⇒ 视图同形（正字段繁体 ＋ 字/號 主值从数组首项补齐）。 */
function normalizePersonDetail(person, fallbackId) {
  const src = person && typeof person === 'object' ? person : {}
  const courtesy = textsOf(src.courtesy_names)
  const art = textsOf(src.art_names)
  const alias = textsOf(src.alias_names)
  const courtesyAlts = textsOf(src.courtesy_alt_names)
  const courtesyName = textOf(src.courtesy_name) || courtesy[0] || ''
  const artName = textOf(src.art_name) || art[0] || ''
  const family = textOf(src.family_name)
  const given = textOf(src.given_name)
  return {
    person_id: textOf(src.person_id) || textOf(fallbackId),
    /* 显示名不派生第二份：缺 `name` 时回 `姓＋名`，再缺则由视图经显示名单点派生。 */
    name: textOf(src.name) || `${family}${given}`,
    family_name: family,
    given_name: given,
    courtesy_name: courtesyName,
    courtesy_alt_names: courtesyAlts.length > 0 ? courtesyAlts : courtesy.slice(1),
    courtesy_names: courtesy.length > 0 ? courtesy : courtesyName ? [courtesyName] : [],
    art_name: artName,
    art_names: art.length > 0 ? art : artName ? [artName] : [],
    zhaihao: textOf(src.zhaihao),
    zhaihao_alts: textsOf(src.zhaihao_alts),
    biehao_text: textOf(src.biehao_text) || art.slice(1).concat(alias).filter(Boolean).join('\n'),
    alias_names: alias,
    dynasty: textOf(src.dynasty),
    native_place: textOf(src.native_place),
    native_place_chs: textOf(src.native_place_chs),
    biography: textOf(src.biography),
    biography_chs: textOf(src.biography_chs),
    birth_year: src.birth_year === 0 || src.birth_year ? src.birth_year : null,
    death_year: src.death_year === 0 || src.death_year ? src.death_year : null,
    cbdb_id: textOf(src.cbdb_id),
    tags: textsOf(src.tags)
  }
}

/** 本地行 ⇒ 详情同形（降级路；与 CARD 路逐键同形）。 */
function localPersonDetailOf(row, fallbackId) {
  const attrs = localAttributesOf(row) || {}
  const base = normalizePersonDetail(
    {
      person_id: textOf(row && row.card_id) || textOf(row && row.id) || textOf(fallbackId),
      name: `${attrs.family_name || ''}${attrs.given_name || ''}` || attrs.name,
      family_name: attrs.family_name,
      given_name: attrs.given_name,
      courtesy_name: attrs.courtesy_name,
      art_name: attrs.art_name,
      zhaihao: attrs.zhaihao,
      zhaihao_alts: attrs.zhaihao_alts,
      biehao_text: attrs.biehao_text,
      dynasty: attrs.dynasty,
      cbdb_id: attrs.cbdb_id,
      courtesy_names: row && row.courtesy_names,
      art_names: row && row.art_names,
      alias_names: row && row.alias_names,
      native_place: row && row.native_place,
      native_place_chs: row && row.native_place_chs,
      biography: row && row.biography,
      biography_chs: row && row.biography_chs,
      birth_year: row && row.birth_year,
      death_year: row && row.death_year,
      tags: row && row.tags
    },
    fallbackId
  )
  return base
}

/** 本地 thin 行 ⇒ CARD 九位号（无本地行 / 无 `card_id` ⇒ 空串）。 */
function cardIdOfLocal(prId) {
  const local = localPersonRowOf(prId)
  return textOf(local && local.card_id)
}

/** 是否 CARD 九位号（`PR…` / 其它本地编号 ⇒ 假）。 */
function isCardPersonId(value) {
  return /^\d{1,9}$/.test(textOf(value))
}

/** 真取一次详情（**不抛错**）。 */
async function fetchPersonDetail(id, requestId = '') {
  const localId = textOf(requestId) || id
  let reason = ''
  let message = ''
  if (cloudBaseConfigured()) {
    try {
      const reply = await callCloudFunction(PERSON_CARDS_FUNCTION_NAME, {
        action: PERSON_CARDS_ACTION,
        op: GET_PERSON_CARD_OP,
        payload: { person_id: id }
      })
      if (reply && reply.ok === true) {
        const result = reply.result && typeof reply.result === 'object' ? reply.result : {}
        if (result.ok !== false && result.person && typeof result.person === 'object') {
          return {
            ok: true,
            person: normalizePersonDetail(result.person, id),
            source: textOf(result.source) || 'card'
          }
        }
        reason = textOf(result.reason)
        message = textOf(result.message)
      } else {
        reason = textOf(reply && reply.reason)
        message = textOf(reply && reply.message)
      }
    } catch (error) {
      reason = 'STORAGE_UNAVAILABLE'
      message = '印人詳情讀取異常（網路）。'
    }
  } else {
    reason = 'STORAGE_UNAVAILABLE'
    message = '未配置雲端讀取面，印人詳情暫不可用。'
  }
  /* 调试闸门：只认 CARD，失败宁可空着也不回退本地（Phase 3 闸门用）。 */
  if (cardsOnlyMode()) {
    return {
      ok: false,
      reason: reason || 'STORAGE_UNAVAILABLE',
      message: message || '印人詳情（CARD）暫不可用；本次未回退本地屬性。'
    }
  }
  const local = localPersonRowOf(localId)
  if (local) return { ok: true, person: localPersonDetailOf(local, localId), source: 'local' }
  return {
    ok: false,
    reason: reason || 'STORAGE_UNAVAILABLE',
    message: message || '印人詳情暫不可用（CARD 與本地均未命中）。'
  }
}

/**
 * **载入单个印人详情**（`PR…` 或 CARD 九位号均可）。60 s 缓存；CARD 失败 ⇒ 本地行转同形。
 * **不抛错**。
 *
 * 载荷编号的取法：本地 thin 行带 `card_id`（KEEP 字段）⇒ 直接送 CARD 九位号（少一次服务端
 * 本地映射、更快）；无映射才按原样送（云函数两种编号都认）。
 * @param {string} idOrPrId
 * @param {{force?:boolean}} [options]
 * @returns {Promise<{ok:true, person:object, source:'card'|'local-fallback'|'local'}
 *   |{ok:false, reason:string, message:string}>}
 */
export async function loadPersonDetail(idOrPrId, options = {}) {
  const id = textOf(idOrPrId)
  if (!id) return { ok: false, reason: 'MISSING_REQUIRED', message: '缺少印人編號；本次零讀取。' }
  const force = options && options.force === true
  const cached = detailCache.get(id)
  if (!force && cached && Date.now() - cached.at < PERSON_DETAIL_CACHE_TTL_MS) return cached.value
  const payloadId = isCardPersonId(id) ? id : cardIdOfLocal(id) || id
  const value = await fetchPersonDetail(payloadId, id)
  detailCache.set(id, { at: Date.now(), value })
  return value
}
