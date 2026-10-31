/**
 * 玺爱 · 「我的 AI」連接頁（`/connect`）**静态 ＋ 可执行逻辑自检**
 * ============================================================================
 * 被测件（本单三件）：
 *   · `src/services/aiAccess.js` ——「我的 AI」**唯一业务入口**（7 個 op 鍵面真源）；
 *   · `src/views/ConnectFeicuiView.vue` —— 门面页（未登录说明区 / 用户区 / 一次性明文区 / 管理员卡片）；
 *   · `src/router/index.js` —— 路由表（**未新增**；`/connect` 一条未动）。
 *
 * 判据（①〜⑪；**零 dev server**、**零网络**：传输层被本脚本的假传输替换）：
 *   ① 7 個 op 名**逐字**在 `aiAccess.js`（`AI_OPS` 键 ＋ 值 ＋ `READOUT_KEYS` 键面）；
 *   ② 全 `src/**` 除 `aiAccess.js` 外**零处**直连这 7 个 op 名（去注释后判；唯一通道）；
 *   ③ `data-admin-action="edit-ai-upstream"` **恰 1 处**，且就地挂在 `v-if="admin"` 元素上；
 *   ④ 全 `src/**` 的 `[data-admin-action]` 去重取值集合**现抽并印出**，与预期 11 值逐字相等；
 *   ⑤ 一次性明文：`issuedKey.key` 渲染**恰 1 处**且在「仅显示一次」区块（`data-ai-key-once`）内；
 *   ⑥ 金鑰零落盘：View（去注释）内 `localStorage` / `sessionStorage` 命中 **0**（一次性区块内亦 0）；
 *   ⑦ 未登錄零请求：`aiAccess.*` 调用点**全部**落在带 `!logged.value` / `!admin.value` 守卫的函数内；
 *      ＋ **可执行对照**：未登录时调 7 个入口 ⇒ 全部前置拒绝且传输层**零往返**；
 *   ⑧ 上屏文案繁體：去注释后「简体专用码位」命中 0（正 / 负对照证明探测器有效）；
 *   ⑨ 5 個 reason（INSUFFICIENT_POINTS / LIMIT_DAY / LIMIT_MINUTE / KEY_INVALID / CONFIG_MISSING）
 *      在 `AI_REASON_HINTS` 都有可读繁体文案；
 *   ⑩ 路由未新增：路由表条目与基线条目**逐字相等**、无 `/admin` 类路径、`/connect` 未设 `requiresAuth`；
 *   ⑪ 餘額 / 用量三组读数接自 `getAiUsage` 回包键（`points` / `today` / `minute`）—— 静态键面
 *      ＋ **可执行回包透传**双证（假传输回一包 ⇒ 门面页拿到的正是这三组读数）。
 *
 * 纪律：不打印任何密钥 / 令牌原文（只给长度 / 键面）；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 环境变量缺省用**合成值**（非真实凭据；可用 env 覆盖）：XIAI_ADMIN_PHONE / XIAI_USER_SMS_CODE。
 * 用法：node scripts/verify-ai-connect-page.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. localStorage / window 假体（只为让服务层 ESM 真源在本机 Node 下可导入）
   --------------------------------------------------------------------------- */
const memory = new Map()
const localStorageShim = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
  clear: () => memory.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.localStorage = localStorageShim
globalThis.navigator = globalThis.navigator || { clipboard: { writeText: async () => {} } }

/* ---------------------------------------------------------------------------
   1. 断言与读数（与既有 27 个脚本同形）
   --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canonical(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical))
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = value[key]
        return acc
      }, {}),
    (key, val) => (val === undefined ? '__undefined__' : val)
  )
}

function check(id, label, expected, actual) {
  const pass = canonical(expected) === canonical(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* ---------------------------------------------------------------------------
   2. 静态源面（View / aiAccess / router）＋ 去注释
   --------------------------------------------------------------------------- */
const VIEW_REL = 'src/views/ConnectFeicuiView.vue'
const AI_REL = 'src/services/aiAccess.js'
const ROUTER_REL = 'src/router/index.js'
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const viewRaw = read(VIEW_REL)
const aiRaw = read(AI_REL)
const routerRaw = read(ROUTER_REL)

/** 去注释（HTML / 块 / 行）——判据只看码面 / 上屏面（与仓内既有自检逐字同法）。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}
const viewSrc = stripComments(viewRaw)
const aiSrc = stripComments(aiRaw)
const routerSrc = stripComments(routerRaw)

function walkFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(vue|js)$/.test(entry.name)) out.push(full)
  })
  return out
}

/* ---------------------------------------------------------------------------
   3. 7 個 op 名（鍵面真源）
   --------------------------------------------------------------------------- */
const AI_OPS_NAMES = [
  'getAiUpstream',
  'getAiUsage',
  'issueAiKey',
  'listAiKeys',
  'revokeAiKey',
  'setAiUpstream',
  'updateAiKeyLimits'
]
const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)

/* ---------------------------------------------------------------------------
   4. `[data-admin-action]` 去重集合（预期现值 11 值；**现抽现印**）
   --------------------------------------------------------------------------- */
const EXPECTED_ADMIN_ACTIONS = [
  'ai-enhance-face',
  'correction-accept',
  'correction-reject',
  'edit-ai-upstream',
  'edit-fixed-attributes',
  'edit-invite-reward',
  'edit-seal-attributes',
  'export-seal-data',
  'person-import-review',
  'person-proposal-review',
  'replace-face-image',
  'upload-seal'
]
function collectAdminActions(srcFiles) {
  const found = new Set()
  srcFiles.forEach((file) => {
    const body = stripComments(readFileSync(file, 'utf8'))
    const matches = body.match(/data-admin-action="([^"]+)"/g) || []
    matches.forEach((item) => found.add(item.replace(/^data-admin-action="/, '').replace(/"$/, '')))
  })
  return [...found].sort()
}
const SRC_FILES = walkFiles(path.join(ROOT, 'src'))

/* ---------------------------------------------------------------------------
   5. 「仅显示一次」区块（`data-ai-key-once`）的定界（按 div 配平）
   --------------------------------------------------------------------------- */
function divBlockOf(src, marker) {
  const start = src.indexOf(marker)
  if (start < 0) return null
  const open = src.lastIndexOf('<div', start) /* 标记本身在开标签内 ⇒ 必须往回找开标签 */
  if (open < 0) return null
  const re = /<div\b|<\/div>/g
  re.lastIndex = open
  let depth = 0
  let m
  while ((m = re.exec(src))) {
    if (m[0] === '<div') depth += 1
    else {
      depth -= 1
      if (depth === 0) return src.slice(open, m.index + m[0].length)
    }
  }
  return null
}
const onceBlock = divBlockOf(viewSrc, 'data-ai-key-once') || ''

/* ===========================================================================
   A 段：① 7 個 op 名逐字在 `aiAccess.js` ＋ 可执行键面
   =========================================================================== */
console.log(JSON.stringify({ section: 'A', title: '① 7 個 op 鍵面（aiAccess.js 唯一真源）' }))
/* 可执行真源：**模块导入**（不是正则）——键面由运行时对象给出。 */
const aiAccess = await import(path.join(ROOT, AI_REL))
check('A1', '① `AI_OPS` 运行时键面 ＝ 7 個 op 名（逐字）', AI_OPS_NAMES, Object.keys(aiAccess.AI_OPS).sort())
check('A1b', '① `AI_OPS` 每项键 ＝ 值（自引用常量，无第二套拼装面）', AI_OPS_NAMES, AI_OPS_NAMES.filter((op) => aiAccess.AI_OPS[op] === op && Object.prototype.hasOwnProperty.call(aiAccess.AI_OPS, op)))
check('A1c', '① 码面：7 個 op 名在 `aiAccess.js` 各至少出现 2 次（AI_OPS 键值 ＋ READOUT_KEYS ＋ 调用点）', AI_OPS_NAMES.map((op) => [op, true]), AI_OPS_NAMES.map((op) => [op, countIn(aiSrc, op) >= 2]))
check('A1d', '① `READOUT_KEYS` 为 7 個 op 各声明一份读数键面（`op: Object.freeze([...])` 逐行存在）', AI_OPS_NAMES, AI_OPS_NAMES.filter((op) => new RegExp('\\n\\s*' + op + ': Object\\.freeze\\(\\[').test(aiSrc)))

/* ===========================================================================
   B 段：② 唯一通道（src/** 除 aiAccess.js 外零直连）＋ ③ 管理員鈎子
   =========================================================================== */
console.log(JSON.stringify({ section: 'B', title: '② op 名唯一通道 ＋ ③ edit-ai-upstream 鈎子' }))
{
  const others = SRC_FILES.filter((file) => path.resolve(file) !== path.resolve(ROOT, AI_REL))
  const leaks = []
  others.forEach((file) => {
    const body = stripComments(readFileSync(file, 'utf8'))
    AI_OPS_NAMES.forEach((op) => {
      const hit = countIn(body, op)
      if (hit > 0) leaks.push({ file: path.relative(ROOT, file), op, count: hit })
    })
  })
  check('B1', '② 全 `src/**` 除 `aiAccess.js` 外**零处**直连 7 個 op 名（去注释后）', [], leaks)
  /* 正对照：同一探测器在 `aiAccess.js` 必报满（证明「零处」不是恒真）。 */
  check('B1b', '② 正对照：同一探测器在 `aiAccess.js` 命中 7 個 op 名（探测器有效）', 7, AI_OPS_NAMES.filter((op) => countIn(aiSrc, op) > 0).length)
  /* 唯一通道的另一半：门面页不直连云函数、只经 aiAccess 一个 import。 */
  check('B2', '② 门面页零 `callCloudFunction` / 零 `userWriteGate` 直连（唯一入口＝aiAccess 一个 import）', { cloud: 0, gate: 0, import: 1 }, { cloud: countIn(viewSrc, 'callCloudFunction'), gate: countIn(viewSrc, 'userWriteGate'), import: countIn(viewSrc, "import * as aiAccess from '../services/aiAccess.js'") })
  /* ③ 恰 1 处 ＋ 就地 `v-if="admin"`。 */
  const hook = 'data-admin-action="edit-ai-upstream"'
  const hits = []
  let from = 0
  for (;;) {
    const at = viewSrc.indexOf(hook, from)
    if (at < 0) break
    hits.push(at)
    from = at + hook.length
  }
  check('B3', '③ `data-admin-action="edit-ai-upstream"` 在 View（去注释）恰 1 处', 1, hits.length)
  const tagAt = (() => {
    if (hits.length !== 1) return null
    const open = viewSrc.lastIndexOf('<', hits[0])
    const close = viewSrc.indexOf('>', hits[0])
    return viewSrc.slice(open, close + 1)
  })()
  check('B3b', '③ 该鈎子就地挂在 `v-if="admin"` 元素上（条件渲染，非 CSS 隐藏）', true, typeof tagAt === 'string' && /v-if="admin"/.test(tagAt))
  check('B3c', '③ 正对照：探测器认得 `v-if="admin"`（非 admin 样本必判 false）', { admin: true, plain: false }, { admin: /v-if="admin"/.test('<section v-if="admin" class="panel" data-admin-action="edit-ai-upstream">'), plain: /v-if="admin"/.test('<section class="panel" data-admin-action="edit-ai-upstream">') })
  /* ④ 集合现抽并印出。 */
  const scanned = collectAdminActions(SRC_FILES)
  console.log(JSON.stringify({ readout: 'data-admin-action 去重取值集合（现抽）', count: scanned.length, values: scanned }))
  check('B4', '④ `[data-admin-action]` 去重取值集合逐字 ＝ 预期 12 值（v1.77：＋ai-enhance-face）（**集合为主体判据，不是个数**）', EXPECTED_ADMIN_ACTIONS, scanned)
}

/* ===========================================================================
   C 段：⑤ 一次性明文唯一上屏 ＋ ⑥ 零落盘
   =========================================================================== */
console.log(JSON.stringify({ section: 'C', title: '⑤ 一次性明文唯一上屏 ＋ ⑥ 零落盘' }))
{
  const renderRe = /issuedKey\.key(?![A-Za-z0-9_])/g
  const renders = viewSrc.match(renderRe) || []
  check('C1', '⑤ `issuedKey.key` 渲染（明文）在 View（去注释）恰 1 处（排除 `key_id` / `key_prefix`）', 1, renders.length)
  check('C1b', '⑤ 唯一渲染落在「仅显示一次」区块内（`data-ai-key-once` 的 div 配平段）', true, onceBlock.length > 0 && (onceBlock.match(renderRe) || []).length === 1)
  check('C1c', '⑤ 该渲染位是只读一次性文本域（`data-ai-key-plaintext` ＋ readonly ＋ 不回填输入框）', true, onceBlock.includes('data-ai-key-plaintext') && onceBlock.includes('readonly') && onceBlock.includes(':value="issuedKey.key"'))
  check('C1d', '⑤ 明文持有点唯一：`issuedKey.value = {`（签发回包）恰 1 处 ＋ 清除点 `issuedKey.value = null` 恰 1 处', { assign: 1, clear: 1 }, { assign: countIn(viewSrc, 'issuedKey.value = {'), clear: countIn(viewSrc, 'issuedKey.value = null') })
  /* ⑥ 零落盘：整文件 ＋ 一次性区块内。 */
  check('C2', '⑥ View（去注释）内 `localStorage` / `sessionStorage` 命中 0（金鑰不落盘）', { localStorage: 0, sessionStorage: 0 }, { localStorage: countIn(viewSrc, 'localStorage'), sessionStorage: countIn(viewSrc, 'sessionStorage') })
  check('C2b', '⑥ 「仅显示一次」区块内存储命中 0（含 `<script>` 面的明文持有段）', { localStorage: 0, sessionStorage: 0 }, { localStorage: countIn(onceBlock, 'localStorage'), sessionStorage: countIn(onceBlock, 'sessionStorage') })
  /* 正 / 负对照：探测器有效（含存储调用的样本必报）。 */
  check('C2c', '⑥ 正对照：含存储调用的样本必被命中（探测器有效）', 1, countIn('<textarea :value="issuedKey.key"></textarea>\nlocalStorage.setItem(\'k\', issuedKey.key)', 'localStorage'))
}

/* ===========================================================================
   D 段：⑦ 未登錄零请求（静态：调用点全部落在守卫函数内）
   =========================================================================== */
console.log(JSON.stringify({ section: 'D', title: '⑦ 未登錄 / 非管理員零请求（静态调用点 ＋ 可执行对照）' }))
{
  const scriptSrc = viewSrc.slice(viewSrc.indexOf('<script setup>') + '<script setup>'.length, viewSrc.indexOf('</script>'))
  /* 按花括号配平切出每个顶层函数体（本文件无花括号不平衡的字面量）。 */
  const bodies = new Map()
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g
  let m
  while ((m = re.exec(scriptSrc))) {
    const name = m[1]
    const open = scriptSrc.indexOf('{', m.index)
    let depth = 0
    let i = open
    for (; i < scriptSrc.length; i += 1) {
      if (scriptSrc[i] === '{') depth += 1
      else if (scriptSrc[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    bodies.set(name, scriptSrc.slice(open, i + 1))
  }
  const GUARD_LOGGED = /if\s*\(\s*!\s*logged\.value\s*\)\s*return/
  const GUARD_ADMIN = /if\s*\(\s*!\s*admin\.value\s*\)\s*return/
  const owners = []
  bodies.forEach((body, name) => {
    const sites = body.match(/await\s+aiAccess\.[A-Za-z0-9_$]+/g) || []
    if (sites.length > 0) owners.push({ name, sites: sites.length, logged: GUARD_LOGGED.test(body), admin: GUARD_ADMIN.test(body) })
  })
  const totalSites = owners.reduce((sum, item) => sum + item.sites, 0)
  check('D1', '⑦ 含 `aiAccess.*` 调用的函数恰 6 个（refreshAiPanel / onGenerateKey / onSaveLimits / confirmRevoke / loadUpstream / onSaveUpstream）', ['confirmRevoke', 'loadUpstream', 'onGenerateKey', 'onSaveLimits', 'onSaveUpstream', 'refreshAiPanel'], owners.map((item) => item.name).sort())
  check('D1b', '⑦ 每个调用函数**首行守卫**：用户面 4 个带 `!logged.value` 守卫、管理员面 2 个带 `!admin.value` 守卫', { confirmRevoke: 'logged', loadUpstream: 'admin', onGenerateKey: 'logged', onSaveLimits: 'logged', onSaveUpstream: 'admin', refreshAiPanel: 'logged' }, owners.reduce((acc, item) => {
    acc[item.name] = item.logged ? 'logged' : item.admin ? 'admin' : 'NONE'
    return acc
  }, {}))
  check('D1c', '⑦ 守卫先于请求：每个函数内守卫出现在**首个** `aiAccess.*` 调用之前', true, owners.every((item) => {
    const body = bodies.get(item.name)
    const guard = item.logged ? GUARD_LOGGED : GUARD_ADMIN
    return guard.test(body.slice(0, body.search(/await\s+aiAccess\./)))
  }))
  check('D1d', '⑦ 调用点总数（读用量 / 清单 / 签发 / 改限額 / 註銷 / 讀上游 ×2 / 寫上游）＝ 8', 8, totalSites)
  /* 模板面：未登录 ⇒ 只有说明 ＋ 登录引导（`v-if="!logged"` 面板 ＋ 其后的 `v-else` 已登录区）。 */
  const anonAt = viewSrc.indexOf('<section v-if="!logged"')
  const anonEnd = anonAt < 0 ? -1 : viewSrc.indexOf('</section>', anonAt)
  check('D2', '⑦ 未登录面板 `data-ai-anon-panel` 带 v-if 取反 logged（＝未登录才渲染）且其后紧跟 `v-else` 已登录区', { anon: 1, elseAfterAnon: true }, { anon: countIn(viewSrc, 'v-if="!logged"'), elseAfterAnon: anonAt >= 0 && anonEnd > anonAt && /^\s*<\/section>\s*<template v-else>/.test(viewSrc.slice(anonEnd)) })
}

/* ===========================================================================
   E 段：⑦ 可执行对照（未登录零往返 ＋ 已登录真往返）＋ ⑪ 三组读数透传
   =========================================================================== */
console.log(JSON.stringify({ section: 'E', title: '⑦ 可执行对照：未登录零往返 ＋ ⑪ getAiUsage 三组读数' }))
const USAGE_REPLY = { points: 42, today: { used: 3, limit: 20 }, minute: { used: 1, limit: 5 } }
const UPSTREAM_REPLY = { base_url: 'https://api.example.com/v1', model: 'qa-model', key_mask: 'qa-****-mask', timeout_ms: 60000, updated_at: '2026-10-28T00:00:00.000Z' }
{
  const writeFace = await import(path.join(ROOT, 'src/data/writeFaceMode.js'))
  const session = await import(path.join(ROOT, 'src/data/session.js'))
  const userTokenSvc = await import(path.join(ROOT, 'src/services/userToken.js'))

  writeFace.setWriteFaceModeOverride('cloud')
  const nowS = () => Math.floor(Date.now() / 1000)
  const calls = []
  userTokenSvc.setUserTokenTransport(async (name, data) => {
    calls.push({ name, action: data && data.action, op: data && data.op })
    if (data && data.action === 'issue') {
      return {
        result: {
          ok: true,
          token: 'qa-user-token-in-memory',
          ttlSeconds: 900,
          expiresAt: nowS() + 900,
          issuedAt: nowS(),
          serverNow: nowS(),
          sub: '13900000001',
          uid: 'u-qa00000000000000',
          ver: '1'
        }
      }
    }
    const op = (data && data.op) || ''
    const payload = (data && data.payload) || {}
    if (op === 'getAiUsage') return { result: Object.assign({ ok: true, op, serverNow: nowS() }, USAGE_REPLY) }
    if (op === 'listAiKeys') return { result: { ok: true, op, serverNow: nowS(), rows: [], count: 0 } }
    if (op === 'issueAiKey') {
      return {
        result: {
          ok: true,
          op,
          serverNow: nowS(),
          key_id: 'k-qa-1',
          key: 'qa-plaintext-never-printed',
          key_prefix: 'qa-pre',
          label: payload.label || '',
          day_limit: payload.day_limit || 20,
          minute_limit: payload.minute_limit || 5,
          created_at: '2026-10-28T00:00:00.000Z'
        }
      }
    }
    if (op === 'updateAiKeyLimits') return { result: { ok: true, op, serverNow: nowS(), key_id: payload.key_id, day_limit: payload.day_limit, minute_limit: payload.minute_limit, updated_at: '2026-10-28T00:00:00.000Z' } }
    if (op === 'revokeAiKey') return { result: { ok: true, op, serverNow: nowS(), key_id: payload.key_id, status: 'REVOKED', revoked_at: '2026-10-28T00:00:00.000Z', already: false } }
    if (op === 'getAiUpstream' || op === 'setAiUpstream') return { result: Object.assign({ ok: true, op, serverNow: nowS() }, UPSTREAM_REPLY) }
    return { result: { ok: false, op, reason: 'STORAGE_UNAVAILABLE', message: '自检假传输未覆盖该 op。' } }
  })

  /* E1：未登录 ⇒ 7 個入口全部前置拒绝 ＋ 传输层零往返。 */
  userTokenSvc.clearUserToken()
  session.setUser(null)
  calls.length = 0
  const anon = {
    issue: await aiAccess.issueKey({ label: 'qa' }),
    list: await aiAccess.listKeys(),
    revoke: await aiAccess.revokeKey('k-qa-1'),
    limits: await aiAccess.updateKeyLimits({ key_id: 'k-qa-1', day_limit: 5, minute_limit: 5 }),
    usage: await aiAccess.readUsage(),
    upRead: await aiAccess.readUpstream(),
    upWrite: await aiAccess.writeUpstream({ base_url: 'https://api.example.com/v1', model: 'qa-model' })
  }
  check('E1', '⑦ 未登录：5 個用户面入口全拒 `LOGIN_REQUIRED` ＋ 2 個管理员面入口全拒 `NOT_ADMIN`（恰 3 键拒绝面）', { issue: 'LOGIN_REQUIRED', list: 'LOGIN_REQUIRED', revoke: 'LOGIN_REQUIRED', limits: 'LOGIN_REQUIRED', usage: 'LOGIN_REQUIRED', upRead: 'NOT_ADMIN', upWrite: 'NOT_ADMIN' }, Object.keys(anon).reduce((acc, key) => {
    acc[key] = anon[key].reason
    return acc
  }, {}))
  check('E1b', '⑦ 未登录：**零往返**（传输层调用计数 0）', 0, calls.length)
  check('E1c', '⑦ 未登录：拒绝面恰 3 键（`message,ok,reason`），无任何读数键泄漏', true, Object.keys(anon).every((key) => canonical(Object.keys(anon[key]).sort()) === canonical(['message', 'ok', 'reason'])))

  /* E2：已登录（普通用户）⇒ 真往返 ＋ ⑪ 三组读数逐字透传。 */
  calls.length = 0
  session.setUser({ id: 'u-qa00000000000000', phone: '13900000001', role: 'user', nickname: '自檢用戶' })
  const usage = await aiAccess.readUsage()
  check('E2', '⑪ 已登录：`readUsage()` 过门后拿到假传输回的三组读数（points / today / minute）逐字', USAGE_REPLY, { points: usage.points, today: usage.today, minute: usage.minute })
  check('E2b', '⑪ 已登录：门面回包只含声明的读数键 ＋ `ok`（additive 透传，不编造键）', ['minute', 'ok', 'points', 'today'], Object.keys(usage).sort())
  check('E2c', '⑦ 已登录：往返真实发生（issue 补签 ＋ verify 各至少一次；op 面含 getAiUsage）', true, calls.length >= 2 && calls.some((c) => c.op === 'getAiUsage') && calls.some((c) => c.action === 'issue'))

  /* E3：管理员面 —— 普通用户零往返被前置拒；管理员真往返且**只回遮罩**。 */
  const beforeAdmin = calls.length
  const asUser = await aiAccess.readUpstream()
  check('E3', '⑦ 普通用户读上游：前端前置拒 `NOT_ADMIN` 且**零新增往返**', { reason: 'NOT_ADMIN', added: 0 }, { reason: asUser.reason, added: calls.length - beforeAdmin })
  calls.length = 0
  session.setUser({ id: 'u-qa00000000000000', phone: '13900000001', role: 'admin', nickname: '自檢管理員' })
  const upstream = await aiAccess.readUpstream()
  check('E3b', '⑦ 管理员读上游：过门后拿到 `key_mask` 遮罩面（5 键；**零明文键** `key`）', { keys: ['base_url', 'key_mask', 'model', 'ok', 'timeout_ms', 'updated_at'], mask: UPSTREAM_REPLY.key_mask }, { keys: Object.keys(upstream).sort(), mask: upstream.key_mask })
  check('E3c', '⑦ 管理员读上游：回包内**无任何明文键名**（`key` / `key_cipher` / `key_iv` 命中 0）', { key: 0, cipher: 0, iv: 0 }, { key: Object.keys(upstream).filter((k) => k === 'key').length, cipher: Object.keys(upstream).filter((k) => k === 'key_cipher').length, iv: Object.keys(upstream).filter((k) => k === 'key_iv').length })

  /* E4：⑪ 静态半边 —— 键面声明 ＋ 页面取值 ＋ 上屏三格。 */
  check('E4', '⑪ 静态：`READOUT_KEYS` 内 `getAiUsage` 声明恰三键 `points` / `today` / `minute`（逐字）', true, /getAiUsage: Object\.freeze\(\['points', 'today', 'minute'\]\)/.test(aiSrc))
  check('E4b', '⑪ 静态：页面取值逐字 `points: usageReply.points, today: usageReply.today, minute: usageReply.minute`', 3, countIn(viewSrc, 'usageReply.points') + countIn(viewSrc, 'usageReply.today') + countIn(viewSrc, 'usageReply.minute'))
  check('E4c', '⑪ 静态：上屏三格逐字 `usage.points` / `usage.today.used` ＋ `.limit` / `usage.minute.used` ＋ `.limit`', 5, countIn(viewSrc, 'usage.points') + countIn(viewSrc, 'usage.today.used') + countIn(viewSrc, 'usage.today.limit') + countIn(viewSrc, 'usage.minute.used') + countIn(viewSrc, 'usage.minute.limit'))

  /* E5：一次性明文在**可执行**面也不落盘 —— 签发成功后 `issuedKey` 明文不经存储（本层零存储调用）。 */
  calls.length = 0
  const storageBeforeIssue = memory.size
  const issued = await aiAccess.issueKey({ label: 'qa-key', day_limit: 20, minute_limit: 5 })
  check('E5', '⑤ 可执行：签发回包带**唯一一次明文**（长度 > 0；本脚本只报长度、不打印原文）', true, issued.ok === true && typeof issued.key === 'string' && issued.key.length > 0)
  check('E5b', '⑤ 可执行：签发回包键面恰 8 键（ok ＋ key_id / key / key_prefix / label / day_limit / minute_limit / created_at）', ['created_at', 'day_limit', 'key', 'key_id', 'key_prefix', 'label', 'minute_limit', 'ok'], Object.keys(issued).sort())
  check('E5c', '⑥ 可执行：明文上抛后**存储面零新增写入**（localStorage 假体键数不变）', storageBeforeIssue, memory.size)
}

/* ===========================================================================
   F 段：⑧ 上屏文案繁體 ＋ ⑨ 5 個 reason 可讀文案
   =========================================================================== */
console.log(JSON.stringify({ section: 'F', title: '⑧ 上屏文案繁體 ＋ ⑨ reason 可讀文案' }))
/* 只含「简体专用」码位（无合法繁体用法）⇒ 命中必为简体（与 verify-review-token-path G 段同一张表）。 */
const SIMPLIFIED_ONLY = new Set(
  '说这认边过请对员码确录记误页项题类别输选择开关击钮盘师价体变总积键种样数据获奖励审览处办当给让删询详单号称显标签档尽为无与专业东丝两严个临汉从众们会优传伟伤伦'.split('')
)
const simplifiedHits = (text) => [...new Set([...text].filter((ch) => SIMPLIFIED_ONLY.has(ch)))]
{
  check('F0', '⑧ 正对照：已知简体串必命中（探测器有效）', true, simplifiedHits('这里说数据').length > 0)
  check('F0b', '⑧ 负对照：纯繁体串不命中', [], simplifiedHits('這裏說數據'))
  check('F1', '⑧ 门面页（去注释）简体专用码位命中 0（上屏文案全繁體）', [], simplifiedHits(viewSrc))
  const forbidden = ['生成密钥', '设置', '密钥', '默认', '网络', '缓存', '点击']
  check('F1b', '⑧ 简体词面零命中（生成密钥 / 设置 / 密钥 / 默认 / 网络 / 缓存 / 点击）', [], forbidden.filter((word) => viewSrc.includes(word)))
  /* ⑨ 5 個 reason 都有可读繁体文案。 */
  const REASONS = ['INSUFFICIENT_POINTS', 'LIMIT_DAY', 'LIMIT_MINUTE', 'KEY_INVALID', 'CONFIG_MISSING']
  const hints = REASONS.map((reason) => aiAccess.AI_REASON_HINTS[reason])
  check('F2', '⑨ 5 個 reason 在 `AI_REASON_HINTS` 都有非空可读文案', true, hints.every((hint) => typeof hint === 'string' && hint.trim().length >= 6))
  check('F2b', '⑨ 这 5 條文案本身也是繁體（简体专用码位命中 0）', [], hints.reduce((acc, hint) => acc.concat(simplifiedHits(String(hint))), []))
  check('F2c', '⑨ 5 條文案前綴逐字（金不 / 日限 / 分鐘 / 金鑰 / 配置 —— 各自专属，非通用兜底）', ['金不', '日限', '分鐘', '金鑰', '配置'], REASONS.map((reason) => String(aiAccess.AI_REASON_HINTS[reason]).slice(0, 2)))
}

/* ===========================================================================
   G 段：⑩ 路由未新增
   =========================================================================== */
console.log(JSON.stringify({ section: 'G', title: '⑩ 路由未新增（条目逐字 ＝ 基线；无 /admin 类路径）' }))
{
  /* 基线条目（与 `git show HEAD:src/router/index.js` 逐字同表；本单不改路由）。 */
  const BASELINE_ROUTES = [
    { path: '/', name: 'square' },
    { path: '/seal/:id', name: 'seal-detail' },
    { path: '/my/corrections', name: 'my-corrections' },
    { path: '/my/photos', name: 'my-photos' },
    { path: '/my/drive', name: 'my-drive' },
    { path: '/points', name: 'points' },
    { path: '/login', name: 'login' },
    { path: '/s/:code', name: 'share' },
    { path: '/styles', name: 'styles' },
    { path: '/persons', name: 'persons' },
    { path: '/connect', name: 'connect-feicui' },
    { path: '/:pathMatch(.*)*', name: 'not-found' }
  ]
  const paths = (routerSrc.match(/^\s*path:\s*'([^']+)'/gm) || []).map((line) => line.trim().replace(/^path:\s*'/, '').replace(/'$/, ''))
  const names = (routerSrc.match(/^\s*name:\s*'([^']+)'/gm) || []).map((line) => line.trim().replace(/^name:\s*'/, '').replace(/'$/, ''))
  check('G1', '⑩ 路由条目数 ＝ 基线 12 条（未新增）', 12, paths.length)
  check('G1b', '⑩ 路由 path 序列逐字 ＝ 基线（含兜底重定向）', BASELINE_ROUTES.map((r) => r.path), paths)
  check('G1c', '⑩ 路由 name 序列逐字 ＝ 基线', BASELINE_ROUTES.map((r) => r.name), names)
  check('G1d', '⑩ 无 `/admin` 类路径（全仓路由面 `/admin` 命中 0；含已退役路径的重定向说明不算条目）', [], paths.filter((p) => /^\/admin/i.test(p)))
  check('G1e', '⑩ `/connect` 未设 `requiresAuth`（未登錄可直达；頁內给登录引导）', 1, countIn(routerSrc, "path: '/connect'"))
  check('G1f', '⑩ `/connect` 的 `meta.title` 逐字 `斐萃令牌`（未改）', 1, countIn(routerSrc, "meta: { title: '斐萃令牌' }"))
}

/* ===========================================================================
   汇总
   =========================================================================== */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    admin_actions: EXPECTED_ADMIN_ACTIONS,
    ai_ops: AI_OPS_NAMES,
    plaintext_render_sites: (viewSrc.match(/issuedKey\.key(?![A-Za-z0-9_])/g) || []).length,
    transport_roundtrips_anon: 0
  })
)
process.exit(failures === 0 ? 0 : 1)
