#!/usr/bin/env node
/**
 * 玺爱 · **影像 API 候选基址回退**离线自检（`displayApiCandidates` ＋ `displayFetch`）
 * ==============================================================================
 * 被测实现（本单改动的两个文件，跑的是**仓里那份真源码**，不是抄本）：
 *   · `src/services/displayImage.js` —— `displayApiCandidates()`（env 覆盖 / 生产两档 /
 *       dev 单档）、`displayApiBase()`（回候选首个）、`displayFetch()`（回退执行单点：
 *       每档 `DISPLAY_FETCH_TIMEOUT_MS` 短超时、首个成功即返回、全失败如实交回**最后一档**
 *       的 `{reason, message}`、模块级记忆上次成功候选索引）、`transcodeStoredToDisplay()`
 *       （displayImage 自己的取件入口，同样走单点）；
 *   · `src/services/imageFaces.js` —— `fetchThumbBytes` / `fetchOriginalBytes` / `fetchSlices`
 *       三处真发请求的入口，一律改走 `displayFetch`（本文件零直连 `fetch(`）。
 *
 * 怎么跑（**本地、离线、零网络**）：
 *   · **env 注入缝** ＝ `scripts/lib/display-env-shim.mjs`（把 `displayImage.js` 里的
 *     `import.meta.env` 改道到 `globalThis.__XIAI_TEST_ENV__`；Node 下原式恒 `undefined`）；
 *   · **假 transport** ＝ 直接替换 `globalThis.fetch`（被测代码里的 `fetch(...)` 是运行期全局查找
 *     ⇒ 假 transport 必然被用到；真网络一次都不会发）；每档的行为按 URL 编排，并逐轮记录
 *     **调用日志**（顺序 / 次数）作为读数；
 *   · 断言骨架与本仓既有 `verify-*.mjs` 同形：期望值与实读数逐条 `canon` 比对，任一不等 ⇒ 该条红、
 *     退出码非 0。
 *
 * 判据（逐条硬口）：
 *   A  **候选顺序**：生产 ＝ `[容器直连, '/api/xiai']`（先直连、后同源）；dev 只一档 `['/api/xiai']`；
 *      `VITE_XIAI_API_BASE` 非空 ⇒ **就它一档**（带尾斜杠也剥掉，不额外垫）；env ＋ PROD 同在 ⇒ env 赢。
 *   B  **回退与记忆**：第一档失败、第二档成功 ⇒ 回包成功且**记忆生效**（下一次直接先试原成功档，
 *      假 transport 的调用日志可证）；两档全失败 ⇒ **如实返回最后一档**的 `{reason, message}`
 *      （服务端 reason 原样透传、文案逐字相等，**不混合**另一档的文案）。
 *   C  **超时**：挂起档在 `DISPLAY_FETCH_TIMEOUT_MS`（4000ms）后被中止并跳过，下一档成功。
 *   D  **轮次不变式**：同一次调用内候选**不重复尝试**（每轮日志里 URL 互不相同、且 ≤ 候选数）。
 *   E  **静态纪律**：域名字面值只落在 `displayImage.js` 一处；`displayImage.js` 模块级可变状态
 *      恰 1 个（＝ 上次成功索引，**不缓存任何响应体**）；`imageFaces.js` 零直连 `fetch(`；
 *      `displayApiBase()` ＝ `displayApiCandidates()[0]`（旧调用点面逐字未变）。
 *
 * 纪律：不打印任何密钥 / 令牌原文；断言失败 ⇒ 退出码非 0；本套件零写入、零网络。
 */
/* **测试环境保护哨兵（硬防线）**：本套件只跑离线假 transport，绝不碰真实 CARD / 云端 / 真网络。 */
process.env.XIAI_NO_REAL_CARD = '1'

import { register } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* --------------------------------------------------------------------------- */
/* 0. 构建期 env 注入缝（**必须早于任何 `src/**` 的 `import()`**）                */
/* --------------------------------------------------------------------------- */
globalThis.__XIAI_TEST_ENV__ = {}
register(pathToFileURL(path.join(HERE, 'lib', 'display-env-shim.mjs')).href)

/* --------------------------------------------------------------------------- */
/* 1. `localStorage / window` 假体（与既有 verify-*.mjs 头部同套）               */
/* --------------------------------------------------------------------------- */
const store = new Map()
const localStorageShim = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: (key) => { store.delete(key) },
  clear: () => store.clear()
}
globalThis.window = globalThis.window || {}
globalThis.window.localStorage = localStorageShim
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}
globalThis.localStorage = localStorageShim

/* --------------------------------------------------------------------------- */
/* 2. 断言与读数                                                                */
/* --------------------------------------------------------------------------- */
const results = []
let failures = 0

function canon(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return JSON.stringify(value.map(canon))
  return JSON.stringify(
    Object.keys(value).sort().reduce((acc, key) => { acc[key] = value[key]; return acc }, {})
  )
}

function check(id, label, expected, actual) {
  const pass = canon(expected) === canon(actual)
  if (!pass) failures += 1
  results.push({ id, label, pass, expected, actual })
  console.log(JSON.stringify({ id, case: label, pass, expected, actual }))
}

/* --------------------------------------------------------------------------- */
/* 3. 真源加载（被测实现）                                                      */
/* --------------------------------------------------------------------------- */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
const display = await load('src/services/displayImage.js')
const faces = await load('src/services/imageFaces.js')

const CONTAINER = 'https://xiai-api-344046-5-1463728495.sh.run.tcloudbase.com/api'
const PROXY = '/api/xiai'
const FAIL_MSG = '影像暫時無法顯示，請稍後再試'
const DOWN_MSG = '影像暫時無法顯示，請稍後再試（本機轉碼服務未就緒）'

/* --------------------------------------------------------------------------- */
/* 4. 假 transport（全局替换 `fetch`；逐轮记录调用日志）                         */
/* --------------------------------------------------------------------------- */
const realFetch = globalThis.fetch
const callLog = []
const rounds = []
let handler = () => { throw new Error('假 transport 未编排本次调用') }
let mark = 0 // 本轮开始前的日志长度

globalThis.fetch = async (url, init) => {
  const index = callLog.push(String(url)) - 1
  return handler(String(url), init, index - mark)
}
const beginRound = () => { mark = callLog.length }
const endRound = () => {
  const slice = callLog.slice(mark)
  rounds.push(slice)
  return slice
}

function replyOf({ status = 200, bytes = null, json = null, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null) },
    json: async () => {
      if (json === null) throw new Error('非 JSON 失败体')
      return json
    },
    arrayBuffer: async () => {
      const src = bytes || new Uint8Array([1, 2, 3])
      return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
    }
  }
}

/** 16 字节「RIFF….WEBP」夹具（`sniffBytesMime` 按魔数认 `image/webp`）。 */
function webpBytes() {
  const out = new Uint8Array(16)
  out.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
  out.set([0x57, 0x45, 0x42, 0x50], 8) // 'WEBP'
  out.set([0x56, 0x50, 0x38, 0x20], 12) // 'VP8 '
  return out
}

const isContainer = (url) => url.startsWith(CONTAINER)
const isProxy = (url) => url.startsWith(PROXY)
const THUMB_QUERY = '/image/thumb?width=256&kind=FACE'

/* ========================================================================== */
/* A. 候选顺序（env 注入；这些用例**不发请求** ⇒ 不动记忆）                     */
/* ========================================================================== */
globalThis.__XIAI_TEST_ENV__ = {}
check('A1', 'dev（无 PROD、无 env 覆盖）只一档', [PROXY], display.displayApiCandidates())
check('A2', 'dev 下 displayApiBase() 回候选首个', PROXY, display.displayApiBase())

globalThis.__XIAI_TEST_ENV__ = { PROD: true }
check('A3', '生产候选顺序：先容器直连、后同源反代', [CONTAINER, PROXY], display.displayApiCandidates())
check('A4', '生产下 displayApiBase() ＝ 容器直连（旧调用点面）', CONTAINER, display.displayApiBase())

globalThis.__XIAI_TEST_ENV__ = { VITE_XIAI_API_BASE: 'https://env-override.example/api/' }
check('A5', 'env 覆盖 ⇒ 就它一档（尾斜杠剥掉、不额外垫）', ['https://env-override.example/api'],
  display.displayApiCandidates())
check('A6', 'env 覆盖（非生产）仍只一档', 1, display.displayApiCandidates().length)

globalThis.__XIAI_TEST_ENV__ = { PROD: true, VITE_XIAI_API_BASE: 'https://only.example/api' }
check('A7', 'env 覆盖 ＋ PROD 同在 ⇒ env 赢（一档）', ['https://only.example/api'], display.displayApiCandidates())

/* ========================================================================== */
/* B. 回退执行 ＋ 记忆（生产两档）                                             */
/* ========================================================================== */
globalThis.__XIAI_TEST_ENV__ = { PROD: true }
check('B0', '每档短超时常量 ＝ 4000ms', 4000, display.DISPLAY_FETCH_TIMEOUT_MS)

/* B1：第一档（容器直连）网络失败、第二档（同源反代）成功 ⇒ 回包成功。 */
handler = (url) => {
  if (isContainer(url)) throw new TypeError('假 transport：容器域名被解析成代理假 IP（连不上）')
  return replyOf({ bytes: new Uint8Array([7, 7, 7]), headers: { 'X-Xiai-Thumb-Long-Edge': '256' } })
}
beginRound()
const b1 = await faces.fetchThumbBytes({ bytes: new Uint8Array([1, 2, 3]), kind: 'FACE' })
const b1Log = endRound()
check('B1a', '第一档失败、第二档成功 ⇒ 回包成功', true, b1.ok)
check('B1b', '本轮调用顺序：先容器直连、后同源反代',
  [`${CONTAINER}${THUMB_QUERY}`, `${PROXY}${THUMB_QUERY}`], b1Log)

/* B2：记忆生效 —— 下一次**直接先试**上一次成功的那一档（假 transport 计数可证）。 */
beginRound()
const b2 = await faces.fetchThumbBytes({ bytes: new Uint8Array([1, 2, 3]), kind: 'FACE' })
const b2Log = endRound()
check('B2a', '第二次调用同样成功', true, b2.ok)
check('B2b', '记忆生效：先试上次成功档（同源反代），零容器直连尝试', [`${PROXY}${THUMB_QUERY}`], b2Log)
check('B2c', '两轮合计只发 3 次（首轮 2 次 ＋ 次轮 1 次 ⇒ 次轮未重复试第一档）', 3, callLog.length)

/* B3：两档全失败 ⇒ 如实返回**最后一档**的 {reason, message}（不混合文案）。 */
handler = (url) => {
  if (isProxy(url)) throw new TypeError('假 transport：ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR（同源反代 502）')
  return replyOf({ status: 404, json: { reason: 'NOT_FOUND' } })
}
beginRound()
const b3 = await faces.fetchThumbBytes({ bytes: new Uint8Array([1, 2, 3]), kind: 'FACE' })
const b3Log = endRound()
check('B3a', '两档全失败 ⇒ ok:false', false, b3.ok)
check('B3b', '两档各试一次（轮次不变式：不重复）', 2, new Set(b3Log).size)
check('B3c', '回包 ＝ 最后一档（容器直连 404）的 reason 原样透传', 'NOT_FOUND', b3.reason)
check('B3d', '回包 ＝ 最后一档文案逐字相等（不改写）', FAIL_MSG, b3.message)
check('B3e', '另一档（同源反代）的文案没有被混进来', false, String(b3.message).includes(DOWN_MSG))

/* ========================================================================== */
/* C. 超时档被跳过（挂起档 4000ms 后中止，下一档成功）                          */
/* ========================================================================== */
let hung = false
handler = (url, init, attemptNo) => {
  if (attemptNo === 0) {
    hung = true
    /* 挂起：只在 abort 时才 reject ⇒ 中止必须由被测的 4s 超时触发。 */
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('假 transport：4s 超时被中止')))
    })
  }
  return replyOf({ bytes: new Uint8Array([5]), headers: { 'X-Xiai-Thumb-Long-Edge': '256' } })
}
beginRound()
const startedAt = Date.now()
const c1 = await faces.fetchThumbBytes({ bytes: new Uint8Array([1, 2, 3]), kind: 'FACE' })
const elapsed = Date.now() - startedAt
const c1Log = endRound()
check('C1a', '挂起档确实挂起过（假 transport 收到过挂起请求）', true, hung)
check('C1b', '挂起档在 4000ms 超时后被中止并跳过（下界）', true, elapsed >= display.DISPLAY_FETCH_TIMEOUT_MS)
check('C1c', '总耗时仍在两档上界内（4s × 2 ＋ 宽限）', true,
  elapsed < 2 * display.DISPLAY_FETCH_TIMEOUT_MS + 1500)
check('C1d', '超时档被跳过 ⇒ 第二档成功回包', true, c1.ok)
check('C1e', '本轮两档各试一次（轮次不变式）', 2, new Set(c1Log).size)

/* ========================================================================== */
/* D. displayImage 自己的取件入口（转码面）同样走回退单点                       */
/* ========================================================================== */
handler = (url) => {
  if (isContainer(url)) throw new TypeError('假 transport：容器直连失败')
  return replyOf({ bytes: webpBytes(), headers: { 'X-Xiai-Quality': '0.92' } })
}
beginRound()
const d1 = await display.transcodeStoredToDisplay(new Uint8Array([1, 2, 3, 4, 5]))
const d1Log = endRound()
check('D1a', '转码入口：第一档失败、第二档成功 ⇒ ok', true, d1.ok)
check('D1b', '转码入口按候选顺序回退（先直连、后同源）',
  [`${CONTAINER}/image/decode`, `${PROXY}/image/decode`], d1Log)
check('D1c', '回包字节按魔数判为 image/webp', 'image/webp', d1.mime)
check('D1d', 'quality 从响应头如实取', 0.92, d1.quality)

/* ========================================================================== */
/* E. 轮次不变式（全局汇总）                                                   */
/* ========================================================================== */
check('E1', '每一轮内候选不重复（轮次不变式）', true,
  rounds.every((slice) => new Set(slice).size === slice.length))
check('E2', '每一轮的尝试数 ≤ 该环境候选数（生产两档 ⇒ ≤2）', true,
  rounds.every((slice) => slice.length <= 2))
check('E3', '共跑 ' + rounds.length + ' 轮、' + callLog.length + ' 次假请求（零真网络）', true,
  rounds.reduce((sum, slice) => sum + slice.length, 0) === callLog.length)

/* ========================================================================== */
/* F. 静态纪律                                                                 */
/* ========================================================================== */
const displaySrc = readFileSync(path.join(ROOT, 'src/services/displayImage.js'), 'utf8')
const facesSrc = readFileSync(path.join(ROOT, 'src/services/imageFaces.js'), 'utf8')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|vue|mjs)$/.test(name)) out.push(full)
  }
  return out
}
const srcFiles = walk(path.join(ROOT, 'src'))
const countInSrc = (needle) =>
  srcFiles.reduce((sum, file) => sum + (readFileSync(file, 'utf8').split(needle).length - 1), 0)
const filesWith = (needle) =>
  srcFiles.filter((file) => readFileSync(file, 'utf8').includes(needle)).map((file) => path.relative(ROOT, file))

check('F1', '域名字面值只落在 src/services/displayImage.js 一处', ['src/services/displayImage.js'],
  filesWith('tcloudbase'))
check('F1', '域名字面值在 src/** 恰出现 1 次', 1, countInSrc('tcloudbase'))

const moduleLevelLets = displaySrc.split('\n').filter((line) => /^let\s/.test(line))
check('F2', 'displayImage.js 模块级可变状态恰 1 个（＝ 上次成功候选索引）', ['lastGoodCandidateIndex'],
  moduleLevelLets.map((line) => (/\blet\s+([A-Za-z0-9_$]+)/.exec(line) || [])[1]))
check('F2', '模块级不缓存任何响应体（零 body/bytes/reply/payload 级 let）', 0,
  moduleLevelLets.filter((line) => /(body|bytes|reply|payload)/.test(line)).length)

check('F3', 'imageFaces.js 零直连 fetch（三处入口全走回退单点）', 0,
  (facesSrc.match(/[^A-Za-z]fetch\s*\(/g) || []).length)
check('F3', 'displayImage.js 恰 1 处真 fetch（就在 displayFetch 单点里）', 1,
  (displaySrc.match(/[^A-Za-z]fetch\s*\(/g) || []).length)

check('F4', 'displayApiBase() ＝ displayApiCandidates()[0]（旧调用点面逐字未变）',
  display.displayApiCandidates()[0], display.displayApiBase())
check('F4', '导出面未破（displayImage）', true,
  ['displayApiBase', 'displayApiCandidates', 'displayFetch', 'transcodeStoredToDisplay',
    'displayDataUrlOf', 'TIFF_STORAGE_MIME', 'DISPLAY_FETCH_TIMEOUT_MS']
    .every((key) => key in display))
check('F4', '导出面未破（imageFaces）', true,
  ['fetchSlices', 'fetchThumbBytes', 'fetchOriginalBytes', 'parseSlicesMultipart', 'downloadOriginalFor']
    .every((key) => key in faces))
check('F5', 'env 覆盖点（VITE_XIAI_API_BASE）仍只在 displayImage.js 一处', ['src/services/displayImage.js'],
  filesWith('VITE_XIAI_API_BASE'))

/* --------------------------------------------------------------------------- */
/* 收尾：还原真 transport，打印读数                                             */
/* --------------------------------------------------------------------------- */
globalThis.fetch = realFetch
delete globalThis.__XIAI_TEST_ENV__

console.log(JSON.stringify({
  summary: {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: failures,
    rounds: rounds.length,
    fakeRequests: callLog.length
  }
}))
process.exit(failures === 0 ? 0 : 1)
