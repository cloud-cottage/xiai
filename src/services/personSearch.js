/**
 * 印人檢索 · 純函數模組（**索引 / 檢索 / 分組**）
 * ============================================================================
 * 為什麼單獨立檔：同一套「簡繁歸一 ＋ 跨欄位拼接 ＋ 三檔相關度」算法，現在有**兩處**要用 ——
 *   ① `components/PersonPicker.vue`（印面「作者」選人控件，已上線驗收）；
 *   ② `views/PersonIndexView.vue`（印家匯徵名錄，本期新增）。
 * 算法**原樣搬出**（不重寫、不改口徑），兩處共用同一份 ⇒ 修一處不會漏另一處。
 *
 * 本模組**零副作用**：不 import 服務層 / 數據層、不讀寫瀏覽器存儲、不發請求；
 * 只依賴 `utils/traditional.js` 的逐字 s2t 表與 `data/surnameInitials.js` 的分組函數。
 *
 * 對外接口（恰 5 個函數）：
 *   · `buildPersonIndex(persons)` ⇒ `{ rows, haystacks }`
 *   · `searchPersons(index, keyword)` ⇒ 命中行（三檔相關度排序；空關鍵字 ⇒ 全量）
 *   · `groupPersonsByInitial(rows, options)` ⇒ `[{ initial, rows }]`（A…Z、`#` 最後，只出非空組）
 *   · `biehaoTokensOf(row)` ⇒ `biehao_text` 的**檢索** token（按換行 / 全角 `／` 雙拆）
 *   · `biehaoLinesOf(row)` ⇒ `biehao_text` 的**展示**行（按換行拆；`／` 原樣保留）
 *
 * 檢索面（**命中面只增不減**，沿已驗收口徑）：
 *   · 單值：`courtesy_name`（字）/ `art_name`（號）/ `zhaihao`（齋號）；
 *   · 多值：`courtesy_alt_names[]`（別字）/ `zhaihao_alts[]`（別署齋號）逐值；
 *   · 舊三數組 `courtesy_names` / `art_names` / `alias_names` **原文保留、並存兼容**
 *     （遷移只寫新欄位不刪舊值的地方，兩路徑任一路徑都能命中）；
 *   · 姓 / 名 / `name_full` / `cbdb_id`；
 *   · `biehao_text` **雙拆 token**：按換行 ② 按全角 `／`（異寫並列，如 `悲庵／悲盦` ⇒ 兩個
 *     token 各自可搜）；`#待核` 這類**核校標記不入檢索**（髒資料裡 `行 #待核` 形態 ⇒ 取 `#`
 *     之前的部分；整段只剩標記 ⇒ 丟棄）。
 *
 * 簡繁歸一：查詢詞與候選**兩邊同走**逐字 s2t（繁體形）＋ 小寫再比子串 ⇒ 簡體（赵）/ 繁體
 * （趙）/ 混輸兩向互逆；ASCII（`PR0000`）不受歸一影響、仍原樣匹配。
 *
 * 三檔相關度（同檔保持入參順序 ⇒ 穩定）：
 *   ① `joined` **整串恰等**置頂（「姓＋名」或「姓＋字 / 號 / 齋號 / 別名」完整相等）；
 *   ② 前綴命中（任一檢索面串以關鍵字開頭）；③ 其餘任意位置子串命中。
 *   ⇒ 搜「趙之謙」/「赵之谦」**首項即本人**（`陸開鈞` 的字「畫均似趙之謙」落第三檔）。
 */

import { groupPersons } from '../data/surnameInitials.js'
import { toTraditionalText as s2t } from '../utils/traditional.js'

/** 新口徑**單值**欄位（遷移後真源）：`courtesy_name`（字）/ `art_name`（號）/ `zhaihao`（齋號）。 */
const SINGLE_FIELDS = ['courtesy_name', 'art_name', 'zhaihao']
/** 新口徑**多值**欄位：`courtesy_alt_names[]`（別字）/ `zhaihao_alts[]`（別署齋號）。 */
const ARRAY_FIELDS = ['courtesy_alt_names', 'zhaihao_alts']
/** 舊三數組（兼容並存；不得刪減 ⇒ 舊命中面逐字保留）。 */
const LEGACY_ARRAY_FIELDS = ['courtesy_names', 'art_names', 'alias_names']
/** 逐值拼接入索引的欄位（新 ＋ 舊）。 */
const VALUE_ARRAY_FIELDS = [...ARRAY_FIELDS, ...LEGACY_ARRAY_FIELDS]

/** 單值取文本（`null` / `undefined` ⇒ `''`；其餘 `String().trim()`）。 */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

/** 陣列取值（非陣列 / 空 ⇒ `[]`；逐項 trim、空值丟棄）。 */
function valuesOf(row, key) {
  const list = row && Array.isArray(row[key]) ? row[key] : []
  const out = []
  for (const value of list) {
    const text = textOf(value)
    if (text) out.push(text)
  }
  return out
}

/**
 * 歸一：逐字 s2t（繁體形）＋ 小寫。**查詢詞與候選兩邊同走這一條口徑** ⇒
 * 簡 / 繁 / 混輸互逆命中；逐字表只動簡體字形、ASCII 原樣 ⇒ `PR0000` 這類子串匹配不受影響。
 * @param {string} text
 * @returns {string}
 */
export function normalizeSearchText(text) {
  const value = text === null || text === undefined ? '' : String(text)
  return s2t(value).toLowerCase()
}

/**
 * `biehao_text`（別號長文）的**檢索 token**：① 按換行 ② 按全角 `／` 雙拆（異寫並列各自可搜）。
 * `#待核` 核校標記不參與檢索（取 `#` 之前的部分；整段只剩標記 ⇒ 丟棄）。
 * @param {object} row 印人行
 * @returns {string[]}
 */
export function biehaoTokensOf(row) {
  const text = textOf(row && row.biehao_text)
  if (!text) return []
  const out = []
  for (const chunk of text.split(/[\r\n／]+/)) {
    const token = chunk.split(/[#＃]/)[0].trim()
    if (token) out.push(token)
  }
  return out
}

/**
 * `biehao_text` 的**展示行**（詳情頁用）：按換行拆，`／` **原樣保留**（異寫並列是資料形態，
 * 不在展示層拆開）。含 `#待核` 核校標記的行**整行剔除**（那是內部核校占位、不是別號值），
 * 行內前後空白 trim、空行丟棄。
 * @param {object} row 印人行
 * @returns {string[]}
 */
export function biehaoLinesOf(row) {
  const text = textOf(row && row.biehao_text)
  if (!text) return []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || /[#＃]/.test(value)) continue
    out.push(value)
  }
  return out
}

/** 單欄位檢索面（姓 / 名 / 全名 / 新單值 / 新多值 / 舊三數組 / cbdb_id / 別號 token）。 */
function searchPartsOf(row) {
  if (!row || typeof row !== 'object') return []
  const parts = [row.family_name, row.given_name, row.name_full]
  for (const key of SINGLE_FIELDS) parts.push(row[key])
  for (const key of ARRAY_FIELDS) parts.push(...valuesOf(row, key))
  for (const key of LEGACY_ARRAY_FIELDS) parts.push(...valuesOf(row, key))
  parts.push(row.cbdb_id)
  parts.push(...biehaoTokensOf(row))
  return parts
}

/**
 * **跨欄位拼接形態的「值面」**（原始文本，**不含姓**）：名 ＋ 字 / 號 / 齋號 / 別字 / 別署齋號 /
 * 舊三數組逐值 / `biehao_text` token —— 整打全名時姓與名分屬兩欄位，單欄位子串永遠匹配不上，
 * 故預計算裡把「姓」與該值**直接相接**（不插分隔符，免得分隔符擋住子串）。
 */
function searchJoinedSourcesOf(row) {
  if (!row || typeof row !== 'object') return []
  const out = []
  const given = textOf(row.given_name)
  if (given) out.push(given)
  for (const key of SINGLE_FIELDS) {
    const text = textOf(row[key])
    if (text) out.push(text)
  }
  for (const key of VALUE_ARRAY_FIELDS) out.push(...valuesOf(row, key))
  out.push(...biehaoTokensOf(row))
  return out
}

/**
 * 建**候選側歸一索引**（一次性預計算）：`persons` 變更才重建；570 行只建一次，
 * 之後每次輸入只對既有串做子串匹配（不逐鍵重跑 s2t）。
 *
 * 行物件 → `{ parts, joined, blob }`：`parts` ＝ 全部檢索面歸一串（單欄位形態 ＋ 拼接形態，
 * 同人重複串只留一份）；`joined` ＝ 拼接形態歸一串（供整串恰等置頂排序）；
 * `blob` ＝ `parts` 以換行相接的整體串（逐鍵先做一次整串子串判定，未中即跳過該行；
 * 換行不是查詢詞裡會出現的字元 ⇒ 判定與逐片 `includes` **命中面等價**）。
 *
 * 去重與省算：① 先按**原始串**去重；② 歸一後再按歸一串去重；③ 拼接形態用「歸一的姓前綴 ＋
 * 歸一的該值」直接相接 —— `normalizeSearchText()` 是逐字映射 ＋ 逐字小寫 ⇒ 前綴歸一後拼接
 * ≡ 整串歸一（少跑一遍 s2t，口徑不變）。欄位缺失 / 空串 / 空陣列一律靜默跳過。
 *
 * @param {Array<object>} persons 印人行陣列
 * @returns {{rows: Array<object>, haystacks: Map<object, {parts: string[], joined: string[], blob: string}>}}
 */
export function buildPersonIndex(persons) {
  const rows = Array.isArray(persons) ? persons : []
  const haystacks = new Map()
  for (const row of rows) {
    const parts = []
    const normByRaw = new Map()
    const seenNorm = new Set()
    const push = (text) => {
      const raw = textOf(text)
      if (!raw || normByRaw.has(raw)) return
      const norm = normalizeSearchText(raw)
      normByRaw.set(raw, norm)
      if (!norm || seenNorm.has(norm)) return
      seenNorm.add(norm)
      parts.push(norm)
    }
    for (const text of searchPartsOf(row)) push(text)
    const joined = []
    const familyRaw = textOf(row && row.family_name)
    const familyNorm = familyRaw ? normByRaw.get(familyRaw) || '' : ''
    if (familyNorm) {
      const seenJoined = new Set()
      for (const value of searchJoinedSourcesOf(row)) {
        const norm = normByRaw.get(textOf(value))
        if (!norm) continue
        const joinedNorm = familyNorm + norm
        if (seenJoined.has(joinedNorm)) continue
        seenJoined.add(joinedNorm)
        joined.push(joinedNorm)
        if (!seenNorm.has(joinedNorm)) {
          seenNorm.add(joinedNorm)
          parts.push(joinedNorm)
        }
      }
    }
    haystacks.set(row, { parts, joined, blob: parts.join('\n') })
  }
  return { rows, haystacks }
}

/**
 * 檢索（**三檔相關度排序**，同檔保持入參順序 ⇒ 穩定）：空關鍵字 ⇒ 全量（原樣、原序）。
 * 命中面與排序口徑見檔頭注；預計算（`buildPersonIndex` 的 `{parts, joined}` 歸一串）複用，
 * 逐鍵不重算歸一。
 *
 * @param {{rows: Array<object>, haystacks: Map<object, object>}} index `buildPersonIndex` 的產物
 * @param {string} keyword 使用者輸入（簡 / 繁 / 混輸皆可；前後空白忽略）
 * @returns {Array<object>} 命中行（原行物件）
 */
export function searchPersons(index, keyword) {
  const rows = index && Array.isArray(index.rows) ? index.rows : []
  const haystacks = index && index.haystacks instanceof Map ? index.haystacks : new Map()
  const kw = normalizeSearchText(String(keyword === null || keyword === undefined ? '' : keyword).trim())
  if (!kw) return rows
  const exact = []
  const prefixed = []
  const contained = []
  for (const row of rows) {
    const entry = haystacks.get(row)
    if (!entry || !Array.isArray(entry.parts)) continue
    /* 整串預判：未中即該行無命中 ⇒ 不逐片掃（口徑等價，見 `blob` 注）。 */
    if (typeof entry.blob === 'string' && !entry.blob.includes(kw)) continue
    let hit = false
    let prefix = false
    for (const part of entry.parts) {
      if (!part.includes(kw)) continue
      hit = true
      /* `startsWith` 必然 `includes` ⇒ 命中前綴即可收工；未中前綴則繼續掃餘下分片。 */
      if (part.startsWith(kw)) {
        prefix = true
        break
      }
    }
    if (!hit) continue
    if (Array.isArray(entry.joined) && entry.joined.includes(kw)) exact.push(row)
    else if (prefix) prefixed.push(row)
    else contained.push(row)
  }
  return exact.concat(prefixed, contained)
}

/**
 * 按姓氏拼音首字母分組：`[{ initial, rows }]`，按 `GROUP_ORDER`（A…Z、`#` 最後），
 * **只出非空組**（沒人姓 I / U / V ⇒ 這些字母不出現在結果裡）。轉發 `data/surnameInitials.js`
 * 的分組單點（排序 / 分組口徑恰一處，不在此另立一套）。
 *
 * @param {Array<object>} rows 印人行
 * @param {{personName?: (row: object) => string}} [options] `personName` ＝ 顯示名函數
 * @returns {Array<{initial: string, rows: Array<object>}>}
 */
export function groupPersonsByInitial(rows, options = {}) {
  return groupPersons(rows, options)
}
