import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createTilesplicerMiddleware } from './src/tilesplicer/server.js'

// 玺爱 H5 工程根：/Users/kevin/bistro/xiai
// 端口 5163 为本工程专属，server 与 preview 均 strictPort，禁止回退到 5173/5174。
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
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
    /* 展示面转码桥（案 C）：同源 `/api/image/**` 转到 xiai-api（127.0.0.1:5191）。
       只代理图像编解码端点族 —— `/api/tilesplicer/**` 仍由本工程 dev 中间件承担，两者不交叉。 */
    proxy: {
      '/api/image': { target: 'http://127.0.0.1:5191', changeOrigin: false }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 5163,
    strictPort: true,
    proxy: {
      '/api/image': { target: 'http://127.0.0.1:5191', changeOrigin: false }
    }
  }
})
