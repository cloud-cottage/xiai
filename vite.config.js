import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createTilesplicerMiddleware } from './src/tilesplicer/server.js'

// 玺爱 H5 工程根：/Users/kevin/bistro/xiai
// 端口 5163 为本工程专属，server 与 preview 均 strictPort，禁止回退到 5173/5174。
//
// 【子路径】线上挂在 `/xiai/`（同域根路径归 liwu）⇒ `base` 必须是 `/xiai/`：
//   ① 构建产物里的资源引用（`/xiai/assets/*`）与 `<base>` 由它决定；
//   ② 前端路由 `createWebHistory(import.meta.env.BASE_URL)`、分享链接、
//      分片加载失败后的整档重试都读同一个 `BASE_URL` ⇒ **全工程只有这一处定义点**。
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  base: '/xiai/',
  plugins: [
    vue(),
    // TileSplicer 只讀 API（R-99/R-100）：掛在 dev server 上 —— 不新佔端口、不起常駐服務。
    // 注意：Vite 只從 **plugin** 讀 `configureServer` hook（`config.getSortedPluginHooks('configureServer')`），
    // `server.configureServer` 這種寫法會被靜默忽略（實測：config 重啟後中間件不生效）。
    {
      name: 'xiai:tilesplicer-api',
      configureServer(server) {
        server.middlewares.use(createTilesplicerMiddleware({ root: projectRoot }))
      }
    }
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5163,
    strictPort: true,
    /* 展示面转码桥（案 C）：同源 `/api/**` 转到 xiai-api（127.0.0.1:5191）。
       只代理图像编解码端点族 —— `/api/tilesplicer/**` 仍由本工程 dev 中间件承担，两者不交叉。
       线上 API 前缀是 `/api/xiai/*`（子路径隔离，见 `services/displayImage.js::displayApiBase`）
       ⇒ dev 同样走该前缀，`rewrite` 把它剥回 5191 认识的 `/api/*`；`/api/image` 原条目保留
       （本地工具 / 旧链接直打 5163 时仍可达，行为一字未改）。 */
    proxy: {
      '/api/xiai/image': {
        target: 'http://127.0.0.1:5191',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/xiai/, '/api')
      },
      '/api/image': { target: 'http://127.0.0.1:5191', changeOrigin: false }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 5163,
    strictPort: true,
    proxy: {
      '/api/xiai/image': {
        target: 'http://127.0.0.1:5191',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api\/xiai/, '/api')
      },
      '/api/image': { target: 'http://127.0.0.1:5191', changeOrigin: false }
    }
  }
})
