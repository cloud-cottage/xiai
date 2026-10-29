/**
 * 玺爱 · AI 中转路由 `POST /api/ai/v1/images/edits`（**薄壳**：白名单直接编码进文件名）。
 * 判定逻辑一律在 `api/_lib/aiRoute.js` / `api/_lib/aiRelay.js`；本文件只把固定路由段传死。
 */
import { createHandler } from '../../../_lib/aiRoute.js'

export default createHandler(undefined, 'images/edits')
