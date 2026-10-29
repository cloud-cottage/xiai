/**
 * 玺爱 · 函数层探针 `GET /api/health`
 *
 * 用途：**唯一目的**是判别「Vercel 是否在编译本项目的 `api/` 目录」。
 * 它本身不做任何业务、不读库、不读 env、不返回任何凭据。
 *
 * 为什么需要它：`api/ai/v1/[...path].js` 用了方括号 catch-all 文件名，
 * 若线上 404 就有两种可能 —— ①整个 `api/` 没被部署 ②非 Next 项目不支持方括号动态段。
 * 一枚**纯文件名**探针可以把这两种情况分开：
 *   · `/api/health` 200  ⇒ `api/` 已被部署 ⇒ 问题在方括号路由
 *   · `/api/health` 404  ⇒ `api/` 根本没部署 ⇒ 问题在项目配置
 *
 * 保留价值：以后每次前端推送后，`curl -s https://xiai.plus/api/health` 一句
 * 就能确认函数层是否活着，不必靠猜。
 */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(200).send(
    JSON.stringify({
      ok: true,
      probe: 'xiai-api-health',
      method: req && req.method ? req.method : '',
      hasRequestBody: Boolean(req && req.body),
      ts: Date.now()
    })
  )
}
