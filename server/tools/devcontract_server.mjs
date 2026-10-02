#!/usr/bin/env node
/**
 * 奇偶對帳用的**前端側契約宿主**（parity harness；**不是 xiai-api 的一部分**）
 * ============================================================================
 * 目的：把「前端側實際掛的那一份契約中間件」（`src/tilesplicer/server.js` 的
 * `createTilesplicerMiddleware`）以**真實 HTTP** 服務起來 —— 即 Vite dev server
 * （5163）所掛的同一份實現、同一份內核 —— 用於與 xiai-api 的響應體做**逐字節對帳**。
 *
 * 紀律：
 *   ① **零算法、零改寫**：本檔只 `import` 而後掛載，不重寫任何響應體；
 *   ② 監聽位址 ＝ `127.0.0.1` ＋ **作業系統指派的高位埠（`port 0`）** ——
 *      **不佔用 5163 / 5164 / 5191 / 5195 / 5196 中的任何一個**，用完即關；
 *   ③ 只讀：不含任何寫入面。
 *
 * 用法：`node server/tools/devcontract_server.mjs`  ⇒ stdout 印 `PORT <n>` 後常駐，
 *       直至收到 SIGTERM / SIGINT（或 stdin 關閉）。
 */

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const { createTilesplicerMiddleware } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'src', 'tilesplicer', 'server.js')).href
)

const middleware = createTilesplicerMiddleware({ root: REPO_ROOT })

const server = http.createServer((req, res) => {
  middleware(req, res, () => {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, reason: 'NOT_FOUND', message: '找不到這個位址或方法。' }))
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`PORT ${address.port}\n`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// ★ 刻意**不**把生命週期綁在 stdin 上：呼叫方（對帳探針）以 SIGTERM 收尾，
//   否則 stdin 一關（`cmd &` 之類）本服務會立刻退出、監聽面歸零。
