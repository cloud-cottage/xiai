#!/usr/bin/env node
/**
 * xiai-api · TileSplicer 內核橋（**薄橋**｜零算法複製）
 * ============================================================================
 * 職責：把 Python 側的請求**原樣**交給同一份 JS 內核，並把內核 / 契約的產出**逐字節**
 * 交回 Python 側。**本檔不含任何幾何、切位、刀向、塊數、取整的計算** —— 一行都沒有。
 *
 * 真源恰 1 處（AC-177 / §3.24.6 ③(a)）：`xiai/src/tilesplicer/core.js`。
 *   · 幾何 / 切位派生 —— 全部在 `core.js`（經 `index.js` 的凍結導出面轉口）；
 *   · `/api/tilesplicer/v1*` 的**契約響應體** —— 由 `src/tilesplicer/server.js` 的
 *     **同一份只讀中間件**（T2／前端 Vite dev server 所掛的那一份）在本進程內直接應答；
 *     本檔**只接管 req/res 的殼**（捕獲字節），**不重寫 buildPlanBody / normalizeTiles /
 *     normalizeSeam 一枚字節** ⇒ 響應體一致是**結構性**的，不是巧合。
 *
 * 協議（CLI）：
 *   ① stdin 收一行 JSON 請求：`{"cmd":"...", ...}`
 *   ② stdout **只寫**響應字節（**無尾隨換行**；契約面即為 JSON 文本 ⇒ 逐字節可對帳）
 *   ③ stderr **唯一一行** JSON 元資訊：`{"status":<HTTP 碼>,"headers":{...}}`（供上層如實照搬狀態碼）
 *   ④ 出錯 ⇒ stderr 寫 JSON `{"ok":false,"error":...}` ＋ 非零退出碼（**零偽數據**：不假造產出）
 *
 * 命令（逐條）：
 *   · `discovery`  ⇒ 中間件對 `GET /api/tilesplicer/v1` 的響應
 *   · `plan`       ⇒ 中間件對 `GET /api/tilesplicer/v1/plan?...` 的響應
 *                    （`{assetId, kind, width?, height?, method?}`；`method` 用於非 GET 的方法面取證）
 *   · `raw`        ⇒ 中間件對**任意** `/api/tilesplicer/**` 路徑的響應（含未知路徑的 404 面）
 *   · `kernel-plan`⇒ **內核直調** `planFor(...)` 的 `JSON.stringify` 結果（與上式對照用）
 *   · `placements` ⇒ 內核 `placementsOf(...)` 的 `JSON.stringify` 結果（落位幾何由內核派生）
 *   · `kernel-info`⇒ 內核身份與導出面清單（AC-177 取證用；**只讀，不改任何值**）
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ── 路徑面（唯一真源指向；不另立第二份內核）────────────────────────────── */
const HERE = path.dirname(fileURLToPath(import.meta.url))                 // server/tools
const REPO_ROOT = path.resolve(HERE, '..', '..')                          // xiai/
const KERNEL_DIR = path.join(REPO_ROOT, 'src', 'tilesplicer')
const CORE_MODULE = path.join(KERNEL_DIR, 'core.js')                      // ★ 真源
const SURFACE_MODULE = path.join(KERNEL_DIR, 'index.js')                  // 凍結導出面（core.js 轉口）
const CONTRACT_MODULE = path.join(KERNEL_DIR, 'server.js')                // 契約響應體的同一份實現

const coreModule = await import(pathToFileURL(CORE_MODULE).href)
const surface = await import(pathToFileURL(SURFACE_MODULE).href)
const { createTilesplicerMiddleware } = await import(pathToFileURL(CONTRACT_MODULE).href)

/* ── req/res 殼：只捕獲字節，不參與任何內容構造 ─────────────────────────── */
function toBuffer(chunk) {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0)
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
}

/**
 * 在本進程內直接驅動契約中間件（**中間件本身一字未改**）。
 * @returns {Promise<{status:number, headers:Record<string,string>, body:Buffer}>}
 */
function callMiddleware(request) {
  const middleware = createTilesplicerMiddleware({ root: REPO_ROOT })
  return new Promise((resolve, reject) => {
    const headers = new Map()
    const chunks = []
    let status = 200
    const res = {
      get headersSent() { return false },
      get writableEnded() { return false },
      set statusCode(value) { status = Number(value) },
      get statusCode() { return status },
      setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); return res },
      getHeader(name) { return headers.get(String(name).toLowerCase()) },
      removeHeader(name) { headers.delete(String(name).toLowerCase()); return res },
      writeHead(code, extra) {
        status = Number(code)
        if (extra && typeof extra === 'object') {
          for (const [name, value] of Object.entries(extra)) headers.set(String(name).toLowerCase(), String(value))
        }
        return res
      },
      write(chunk) { const buf = toBuffer(chunk); if (buf.length) chunks.push(buf); return true },
      end(chunk) {
        const buf = toBuffer(chunk)
        if (buf.length) chunks.push(buf)
        resolve({ status, headers: Object.fromEntries(headers), body: Buffer.concat(chunks) })
      },
      on() { return res },
      once() { return res },
      emit() { return false },
      destroy() {}
    }
    const req = {
      method: request.method || 'GET',
      url: request.url,
      headers: {},
      httpVersion: '1.1',
      on() {}, once() {}, removeListener() {}, setEncoding() {}, pause() {}, resume() {}
    }
    try {
      const returned = middleware(req, res, () => reject(new Error(`middleware passed through: ${request.url}`)))
      if (returned && typeof returned.catch === 'function') returned.catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}

function queryOf(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/* ── 命令面（每條返回 `{body:Buffer, meta:{status,headers}}`）─────────────── */
const COMMANDS = {
  async discovery(request) {
    const response = await callMiddleware({ method: request.method || 'GET', url: '/api/tilesplicer/v1' })
    return { body: response.body, meta: { status: response.status, headers: response.headers } }
  },

  async plan(request) {
    const url = `/api/tilesplicer/v1/plan${queryOf({
      assetId: request.assetId,
      kind: request.kind,
      width: request.width,
      height: request.height
    })}`
    const response = await callMiddleware({ method: request.method || 'GET', url })
    return { body: response.body, meta: { status: response.status, headers: response.headers } }
  },

  async raw(request) {
    const target = String(request.path || '/api/tilesplicer/v1')
    const query = request.query === undefined || request.query === null ? '' : String(request.query)
    const url = query ? `${target}?${query}` : target
    const response = await callMiddleware({ method: request.method || 'GET', url })
    return { body: response.body, meta: { status: response.status, headers: response.headers } }
  },

  async 'kernel-plan'(request) {
    const input = { assetId: request.assetId, kind: request.kind }
    if (request.sourceWidth !== undefined && request.sourceWidth !== null) input.sourceWidth = request.sourceWidth
    if (request.sourceHeight !== undefined && request.sourceHeight !== null) input.sourceHeight = request.sourceHeight
    const result = surface.planFor(input)
    return { body: Buffer.from(JSON.stringify(result), 'utf8'), meta: { status: 200, headers: {} } }
  },

  async placements(request) {
    const tiles = Array.isArray(request.tiles) ? request.tiles : []
    // `placementsOf` 的契約要求逐塊帶畫布；api 側沒有畫布物件 ⇒ 以**塊序號**作不透明把手
    // （值原樣回傳，幾何 x/y/width/height 一律由內核派生，本檔不自算座標）。
    const withHandle = tiles.map((tile, position) => ({
      canvas: tile && tile.canvas !== undefined && tile.canvas !== null ? tile.canvas : position,
      x: tile && tile.x,
      y: tile && tile.y,
      width: tile && tile.width,
      height: tile && tile.height
    }))
    return { body: Buffer.from(JSON.stringify(surface.placementsOf(withHandle)), 'utf8'), meta: { status: 200, headers: {} } }
  },

  async 'kernel-info'() {
    const info = {
      name: surface.TILESPLICER_NAME,
      version: surface.TILESPLICER_VERSION,
      exports: Object.keys(surface).sort(),
      core_exports: Object.keys(coreModule).sort(),
      cut_counts: surface.SLICE_CUT_COUNTS,
      directions: surface.SLICE_DIRECTIONS,
      meta_field: surface.SLICE_META_FIELD,
      modules: {
        core: path.relative(REPO_ROOT, CORE_MODULE),
        surface: path.relative(REPO_ROOT, SURFACE_MODULE),
        contract: path.relative(REPO_ROOT, CONTRACT_MODULE),
        bridge: path.relative(REPO_ROOT, fileURLToPath(import.meta.url))
      },
      node: process.version
    }
    return { body: Buffer.from(JSON.stringify(info), 'utf8'), meta: { status: 200, headers: {} } }
  }
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

async function main() {
  const raw = await readStdin()
  let request
  try {
    request = JSON.parse(raw || '{}')
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: `bad request json: ${error.message}` })}\n`)
    process.exit(2)
  }
  const command = COMMANDS[request.cmd]
  if (typeof command !== 'function') {
    process.stderr.write(`${JSON.stringify({ ok: false, error: `unknown cmd: ${String(request.cmd)}` })}\n`)
    process.exit(2)
  }
  const result = await command(request)
  process.stderr.write(`${JSON.stringify(result.meta)}\n`)   // 狀態碼 / 中間件自帶回應頭（如實照搬）
  process.stdout.write(result.body)                          // ★ 逐字節；**不追加換行**
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String((error && error.message) || error) })}\n`)
  process.exit(1)
})
