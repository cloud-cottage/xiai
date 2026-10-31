/**
 * 玺爱 · **自检：云函数传输诊断面**（`src/data/cloudbaseFn.js` 的 `transportDenial` 消息拼接）
 * ============================================================================
 * **本地、离线**（注入 `setCloudFunctionTransport` 缝、零云端、零真实网络）：
 *
 *   ① 注入传输实现抛 `Error('boom-connection-reset')` ⇒ 回包 `message` 含
 *      `boom-connection-reset`、恰 3 键、`reason` 为既有冻结值；
 *   ② 注入传输实现抛含 48 个 a 的长串错误 ⇒ 回包 `message` 不含那 48 位（被打码）；
 *   ③ 注入传输实现抛无 message 的对象 ⇒ 不崩、`message` 可用且不含 `undefined` 字样；
 *   ④ 正常成功回包路径零影响（走既有 `unpackFunctionReply` 断言）。
 *
 * 纪律：断言失败 ⇒ 退出码 1；不打印任何明文密钥 / 令牌。
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* 被测件（ESM）。 */
const mod = await import(pathToFileURL(path.join(ROOT, 'src/data/cloudbaseFn.js')).href)
const { callCloudFunction, setCloudFunctionTransport, unpackFunctionReply, CLOUD_FUNCTION_UNAVAILABLE } = mod

/* --------------------------------------------------------------------------- 0. 断言 / 读数
   --------------------------------------------------------------------------- */

let total = 0
let passed = 0
const failedIds = []

function check(id, title, expected, actual) {
  total += 1
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  if (pass) passed += 1
  else failedIds.push(id)
  console.log(JSON.stringify({ id, case: title, pass, expected, actual }))
}

const shapeOf = (value) => Object.keys(value || {}).sort().join(',')
const countIn = (text, needle) => (needle === '' ? -1 : String(text).split(needle).length - 1)

/* ===========================================================================
   R 段：注入传输实现的诊断面
   =========================================================================== */

/* R1：① 注入传输抛 Error('boom-connection-reset') ⇒ message 含原始原因、恰 3 键、reason 冻结值 */
setCloudFunctionTransport(() => {
  throw new Error('boom-connection-reset')
})
const R1 = await callCloudFunction('selfcheck-fn', {})
check('R1', '① 注入传输抛 Error ⇒ message 含 boom-connection-reset、恰 3 键、reason 为既有冻结值', { hasBoom: true, keys: 'message,ok,reason', reason: CLOUD_FUNCTION_UNAVAILABLE }, { hasBoom: countIn(R1.message, 'boom-connection-reset') >= 1, keys: shapeOf(R1), reason: R1.reason })

/* R2：② 注入传输抛含 48 个 a 的长串错误 ⇒ message 不含那 48 位（被打码） */
const LEAK48 = 'a'.repeat(48)
setCloudFunctionTransport(() => {
  throw new Error(`upstream error: ${LEAK48}`)
})
const R2 = await callCloudFunction('selfcheck-fn', {})
check('R2', '② 注入传输抛 48 位长串错误 ⇒ message 不含那 48 位（被打码）、含 `<REDACTED-LONGSTRING>`', { leakHits: 0, hasRedacted: true, keys: 'message,ok,reason', reason: CLOUD_FUNCTION_UNAVAILABLE }, { leakHits: countIn(R2.message, LEAK48), hasRedacted: countIn(R2.message, '<REDACTED-LONGSTRING>') >= 1, keys: shapeOf(R2), reason: R2.reason })

/* R3：③ 注入传输抛无 message 的对象 ⇒ 不崩、message 可用且不含 undefined 字样 */
setCloudFunctionTransport(() => {
  /* 故意抛非 Error 对象（无 .message）；含 code 字段走 `code` 档。 */
  throw { code: 'ERR_NO_MESSAGE_FIELD' }
})
let R3 = null
let R3Threw = false
try {
  R3 = await callCloudFunction('selfcheck-fn', {})
} catch {
  R3Threw = true
}
check('R3', '③ 注入传输抛无 message 的对象 ⇒ 不崩（零抛错）、message 可用且不含 undefined 字样', { threw: false, hasMessage: true, noUndefined: true, keys: 'message,ok,reason', reason: CLOUD_FUNCTION_UNAVAILABLE }, { threw: R3Threw, hasMessage: Boolean(R3 && typeof R3.message === 'string' && R3.message.length > 0), noUndefined: R3 !== null && countIn(R3.message, 'undefined') === 0, keys: shapeOf(R3), reason: R3 && R3.reason })

/* R4：④ 正常成功回包路径零影响（走既有 unpackFunctionReply） */
const INNER = { ok: true, data: 'selfcheck-payload' }
setCloudFunctionTransport(async () => ({ result: INNER }))
const R4 = await callCloudFunction('selfcheck-fn', {})
const R4Unpacked = unpackFunctionReply({ result: INNER })
check('R4', '④ 正常成功回包 ⇒ 透传不破（ok:true、result 逐字等于、走 unpackFunctionReply）', { ok: true, resultExact: true, unpackedOk: true, unpackedExact: true }, { ok: R4.ok === true, resultExact: JSON.stringify(R4.result) === JSON.stringify(INNER), unpackedOk: R4Unpacked.ok === true, unpackedExact: JSON.stringify(R4Unpacked.result) === JSON.stringify(INNER) })

/* 清除注入 */
setCloudFunctionTransport(null)

/* --------------------------------------------------------------------------- 收尾
   --------------------------------------------------------------------------- */

console.log(
  JSON.stringify({
    summary: { total, passed, failed: total - passed },
    failed_ids: failedIds,
    note: '离线自检：注入 setCloudFunctionTransport 缝、零云端、零真实网络；不打印任何明文密钥 / 令牌。'
  })
)
process.exit(failedIds.length === 0 ? 0 : 1)
