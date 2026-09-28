import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const CONSOLE_ENTRY = '/console.html'

// 阶段 1c：feicui 前端 dev/preview 的直达目标（端口真源 ctrl/PORTS.md ＝ 5195）。
// 显式写 127.0.0.1（PORTS.md §1 制度 (d)：本机非生产链路引用一律写 127.0.0.1），
// feicui 侧亦显式绑 127.0.0.1，避免只绑 IPv6 `::1` 时的 ECONNREFUSED。
const FEICUI_PROXY = { target: 'http://127.0.0.1:5195', changeOrigin: true }

/**
 * R-101 / R-100：xiai 侧 TileSplicer API（dev 中间件挂在 xiai 的 Vite dev server 5163）的直达代理。
 *
 * · **不 rewrite 前缀**：原样把 `/api/tilesplicer/**` 透传给 5163，xiai 侧才能按 `TILESPLICER_API_PREFIX`
 *   （`/api/tilesplicer/v1`）逐字匹配路由；改前缀会直接落 404。
 * · **target 写 `127.0.0.1`（不写 `localhost`）**：xiai 的 dev server 实测**只绑 IPv4 `127.0.0.1:5163`**，
 *   而 Node 侧 `localhost` 解析优先 `::1` ⇒ 写 `localhost` 会 `ECONNREFUSED ::1:5163`（R-100 原文写
 *   `localhost`，此处按实测取 `127.0.0.1`；差异已登记，见 qa-recheck/kong-u1-20260921）。
 * · 同源转发 ⇒ yinsuo 页面相对路径请求 `fetch('/api/tilesplicer/v1/plan?...')` **免 CORS**。
 */
const TILESPLICER_PROXY = { target: 'http://127.0.0.1:5163', changeOrigin: true }

/**
 * R-101：xiai 側 **xiai-api 影像三面**（FastAPI；`/api/image/**`）的直達代理 ——
 * 階段 P5c 新增面（此前 `5191` / `api/image` 在 `yinsuo/**` **零命中**）。
 *
 * · **不 rewrite 前綴**：原樣把 `/api/image/**` 透傳給 127.0.0.1:5191，xiai-api 側才能逐字匹配
 *   `SLICES_PATH` / `THUMB_PATH` / `DOWNLOAD_PATH`（`/api/image/slices` `/thumb` `/download`）；
 *   改前綴會直接落 404（`GET /api/image` 實測即 404 NOT_FOUND，三面皆為 `POST`）。
 * · **target 寫 `127.0.0.1`（不寫 `localhost`）**：5191 實測**只綁 IPv4**
 *   （`lsof` ⇒ `Python … TCP 127.0.0.1:5191 (LISTEN)`），而 Node 側 `localhost` 解析優先 `::1`
 *   ⇒ 寫 `localhost` 會 `ECONNREFUSED ::1:5191`（與上一條 TileSplicer 同因，見 PORTS.md 制度 (d)）。
 * · 同源轉發 ⇒ yinsuo 頁面相對路徑請求 `fetch('/api/image/slices?…')` **免 CORS**，
 *   且 `credentials` / Cookie 不外發。
 * · **dev 與 preview 兩段都挂**（與既有兩條代理同形；spec §附錄 B-B4 要求兩段一致）。
 */
const IMAGE_API_PROXY = { target: 'http://127.0.0.1:5191', changeOrigin: true }

/**
 * 双入口（R13 / spec §2.3-6）：营销入口 index.html（`/`）+ 控制台入口 console.html（`/console/**`）。
 * 把 `/console` 前缀的浏览器直达请求内部改写为控制台入口 HTML，
 * 让 `/console/overview` 这类 history 路由在 dev / preview 下可直接打开。
 * 生产部署需在网关做同构改写：`/console/**` -> `console.html`（见 README）。
 */
function consoleEntryRewrite() {
  const rewrite = (req, _res, next) => {
    const raw = req.url || '/'
    const path = raw.split('?')[0]
    if (path === '/console' || path.startsWith('/console/')) {
      req.url = CONSOLE_ENTRY + raw.slice(path.length)
    }
    next()
  }
  return {
    name: 'yinsuo-console-entry-rewrite',
    configureServer(server) { server.middlewares.use(rewrite) },
    configurePreviewServer(server) { server.middlewares.use(rewrite) },
  }
}

export default defineConfig({
  plugins: [vue(), consoleEntryRewrite()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  /**
   * 阶段 1c：`/feicui` 直达代理（不改 Vue 路由表，`/feicui` 只被 proxy 拦截）。
   * feicui 前端（5195）自身 base 已是 `/feicui/`，故此处**不得 rewrite 前缀**：
   * 原样把 `/feicui/**` 透传给 127.0.0.1:5195，feicui 侧才能正确解析绝对路径 asset
   * 并命中其 SPA fallback。证据见 feicui/web/evidence-proxy/。
   */
  server: {
    port: 5164,
    strictPort: true,
    proxy: {
      '/feicui': FEICUI_PROXY,
      '/api/tilesplicer': TILESPLICER_PROXY,
      '/api/image': IMAGE_API_PROXY,
    },
  },
  preview: {
    port: 5164,
    strictPort: true,
    proxy: {
      '/feicui': FEICUI_PROXY,
      '/api/tilesplicer': TILESPLICER_PROXY,
      '/api/image': IMAGE_API_PROXY,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        marketing: fileURLToPath(new URL('./index.html', import.meta.url)),
        console: fileURLToPath(new URL('./console.html', import.meta.url)),
      },
    },
  },
})
