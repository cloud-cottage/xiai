/**
 * 玺爱 · **「剪贴板一键粘贴图片」自检**（`scripts/verify-clipboard-paste.mjs`）
 * ----------------------------------------------------------------------------
 * **本地、离线、零网络、零 DOM**（注入合成剪贴板对象 ＋ 直接调用纯函数；
 * 静态接线只做源码文本取证）。
 *
 * 判据两族（与派单口径逐条对应）：
 *   (P) **纯函数行为**：`src/utils/clipboardImage.js` 的「取图 / 文本优先不劫持」判定，
 *       用合成 `clipboardData` 逐条取证 —— 尤其 ①②：
 *         ① 有图片、无文字        ⇒ **接管**（`handled:true`, `reason:'IMAGE'`）；
 *         ② 含非空纯文本          ⇒ **不接管**（`handled:false`, `reason:'TEXT_PRIORITY'`）——即使同含图片；
 *       以及 `handleClipboardPaste` 只按 `handled` 调 `accept`，**自身绝不 `preventDefault`**。
 *   (S) **静态接线**：三处上传面（新增印章印面图 / 上传实物照片 / 替换印面图）各自
 *       ① 有 `data-paste-zone` 承载 `@paste`（可聚焦 `tabindex`）；
 *       ② 引 `../utils/clipboardImage.js` 的 `PASTE_HINT` ＋ `handleClipboardPaste`；
 *       ③ 有可见繁體提示 `data-paste-hint`；
 *       ④ 「选图 / 粘贴」共用**同一处理体** `apply*(file)`，且粘贴入口带文本优先分支。
 *
 * 纪律：不打印任何密钥 / 令牌原文；不碰任何服务；断言失败 ⇒ 退出码非 0。
 * 用法（无需环境变量）：`node scripts/verify-clipboard-paste.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ---------------------------------------------------------------------------
   0. 断言与读数
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
   1. 被测件（纯函数真源）
   --------------------------------------------------------------------------- */
const clip = await import(path.join(ROOT, 'src/utils/clipboardImage.js'))

/* ---------------------------------------------------------------------------
   2. 合成剪贴板对象（与浏览器 ClipboardEvent.clipboardData 同形的最小面）
   --------------------------------------------------------------------------- */
function fakeFile(mime, name) {
  return { type: mime, name: name || 'clip-image', size: 123 }
}
function fakeClipboard({ text = '', items = [], files = [] } = {}) {
  return {
    getData: (type) => (type === 'text/plain' || type === 'text' || type === 'Text' ? text : ''),
    items,
    files
  }
}
function imageItem(mime, name) {
  const file = fakeFile(mime, name)
  return { kind: 'file', type: mime, getAsFile: () => file }
}
function textItem() {
  return { kind: 'string', type: 'text/plain', getAsFile: () => null }
}

/* ---------------------------------------------------------------------------
   3. (P) 纯函数行为
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'P', title: '纯函数行为：取图判定 / 文本优先不劫持' }))

check('p1', 'isImageMime：image/* ⇒ true', [true, true, true, false, false], [
  clip.isImageMime('image/png'),
  clip.isImageMime('IMAGE/JPEG'),
  clip.isImageMime('image/webp'),
  clip.isImageMime('text/plain'),
  clip.isImageMime('')
])
check('p1b', 'isImageMime：非字符串入参安全（null / undefined / 数字）', [false, false, false], [
  clip.isImageMime(null),
  clip.isImageMime(undefined),
  clip.isImageMime(42)
])

check('p2', 'clipboardPlainText：读 text/plain', 'hello', clip.clipboardPlainText(fakeClipboard({ text: 'hello' })))
check('p2b', 'clipboardPlainText：无文本 / 无对象 ⇒ 空串', ['', '', ''], [
  clip.clipboardPlainText(fakeClipboard({})),
  clip.clipboardPlainText(null),
  clip.clipboardPlainText({})
])
check(
  'p2c',
  'clipboardPlainText：getData 抛错 ⇒ 不冒泡、回空串',
  '',
  clip.clipboardPlainText({
    getData: () => {
      throw new Error('boom')
    }
  })
)

check('p3', 'clipboardImageFiles：从 items 取图片（kind=file ＋ image/*）', 1, clip.clipboardImageFiles(fakeClipboard({ items: [imageItem('image/png')] })).length)
check(
  'p3b',
  'clipboardImageFiles：忽略非图片项 / 非文件项（kinds: string image-mime / file text-mime 都不算）',
  0,
  clip.clipboardImageFiles(
    fakeClipboard({
      items: [
        { kind: 'string', type: 'image/png', getAsFile: () => fakeFile('image/png') },
        { kind: 'file', type: 'text/plain', getAsFile: () => fakeFile('text/plain') }
      ]
    })
  ).length
)
check('p3c', 'clipboardImageFiles：退路走 `files` 数组（items 缺位时）', 1, clip.clipboardImageFiles(fakeClipboard({ files: [fakeFile('image/webp')] })).length)
check('p3d', 'clipboardImageFiles：空对象 / null ⇒ 空数组', [0, 0], [
  clip.clipboardImageFiles(null).length,
  clip.clipboardImageFiles({}).length
])

/* ① 有图片、无文字 ⇒ 接管 */
{
  const decision = clip.resolvePastedImage(fakeClipboard({ items: [imageItem('image/png', 'a.png')] }))
  check('p4', '① 有图片无文字 ⇒ 接管（handled:true, reason:IMAGE）', { handled: true, reason: 'IMAGE' }, {
    handled: decision.handled,
    reason: decision.reason
  })
  check('p4b', '① 接管时 file 为取到的图片（name 透传）', 'a.png', decision.file && decision.file.name)
  check('p4c', '① 接管时 message 为空串（界面零噪声）', '', decision.message)
}
/* ② 含非空纯文本 ⇒ 绝不接管（即便同时含图片：文本优先） */
{
  const textOnly = clip.resolvePastedImage(fakeClipboard({ text: '一段文字' }))
  check('p5', '② 纯文本（无图）⇒ 不接管（TEXT_PRIORITY）', { handled: false, reason: 'TEXT_PRIORITY' }, {
    handled: textOnly.handled,
    reason: textOnly.reason
  })
  const textAndImage = clip.resolvePastedImage(
    fakeClipboard({ text: '一段文字', items: [imageItem('image/png')] })
  )
  check(
    'p6',
    '② 文本 ＋ 图片同在 ⇒ 仍不接管（**文本优先不劫持**，D1 主判据）',
    { handled: false, reason: 'TEXT_PRIORITY' },
    { handled: textAndImage.handled, reason: textAndImage.reason }
  )
  check('p6b', '② 文本优先时 file 为 null（不交出图片）', null, textAndImage.file)
  check('p6c', '② 文本优先的 message ＝ 冻结繁體文案', clip.PASTE_TEXT_PRIORITY_MESSAGE, textAndImage.message)
}
/* ③ 无文字无图片 ⇒ NO_IMAGE（可读交代） */
check('p7', '③ 空剪贴板 ⇒ 不接管（NO_IMAGE）', { handled: false, reason: 'NO_IMAGE' }, (() => {
  const d = clip.resolvePastedImage(fakeClipboard({}))
  return { handled: d.handled, reason: d.reason }
})())
check('p8', '③ 仅非图片文件（无文字）⇒ NO_IMAGE', 'NO_IMAGE', clip.resolvePastedImage(fakeClipboard({ files: [fakeFile('application/pdf')] })).reason)
check('p8b', 'resolvePastedImage(null) 不抛、回 NO_IMAGE', 'NO_IMAGE', clip.resolvePastedImage(null).reason)

/* 空白文本不算「文本」：仅空白 ⇒ 不触发文本优先（仍按图片判定） */
check(
  'p9',
  '空白文本（仅空格/换行）不算文本 ⇒ 有图仍接管',
  'IMAGE',
  clip.resolvePastedImage(fakeClipboard({ text: '   \n ', items: [imageItem('image/jpeg')] })).reason
)

/* handleClipboardPaste：只按 handled 调 accept；自身绝不 preventDefault */
{
  let accepted = null
  let preventCalls = 0
  const event = {
    clipboardData: fakeClipboard({ items: [imageItem('image/png', 'p.png')] }),
    preventDefault: () => {
      preventCalls += 1
    }
  }
  const decision = clip.handleClipboardPaste(event, (file) => {
    accepted = file
  })
  check('p10', 'handleClipboardPaste：接管 ⇒ accept 收到图片文件', 'p.png', accepted && accepted.name)
  check('p10b', 'handleClipboardPaste：接管 ⇒ 返回 handled:true', true, decision.handled)
  check('p10c', 'handleClipboardPaste：**自身绝不 preventDefault**（交由调用方按 handled 决定）', 0, preventCalls)
}
{
  let accepted = null
  const event = {
    clipboardData: fakeClipboard({ text: '文字', items: [imageItem('image/png')] }),
    preventDefault: () => {}
  }
  const decision = clip.handleClipboardPaste(event, (file) => {
    accepted = file
  })
  check('p11', 'handleClipboardPaste：文本优先 ⇒ **不**调 accept', null, accepted)
  check('p11b', 'handleClipboardPaste：文本优先 ⇒ handled:false', false, decision.handled)
}
check(
  'p12',
  'handleClipboardPaste：读 `dataTransfer` 退路（无 clipboardData）',
  'IMAGE',
  clip.handleClipboardPaste({ dataTransfer: fakeClipboard({ items: [imageItem('image/png')] }) }, () => {}).reason
)
check('p12b', 'handleClipboardPaste(null) 不抛 ⇒ NO_IMAGE', 'NO_IMAGE', clip.handleClipboardPaste(null, () => {}).reason)

/* 文案冻结面：繁體可见提示必须存在且为繁體 */
check('p13', 'PASTE_HINT 非空且含「粘貼」与快捷键说明（繁體可见提示）', true, /粘貼/.test(clip.PASTE_HINT) && /Ctrl\/⌘\+V/.test(clip.PASTE_HINT))
check('p13b', '三条冻结文案均为繁體（含「剪貼板」或「粘貼」）', true, [
  clip.PASTE_HINT,
  clip.PASTE_TEXT_PRIORITY_MESSAGE,
  clip.PASTE_NO_IMAGE_MESSAGE
].every((text) => /剪貼板|粘貼/.test(text)))
check('p13c', 'PASTE_REASONS 冻结三值', ['IMAGE', 'NO_IMAGE', 'TEXT_PRIORITY'], Object.values(clip.PASTE_REASONS).slice().sort())

/* ---------------------------------------------------------------------------
   4. (S) 静态接线：三处上传面
   --------------------------------------------------------------------------- */
console.log(JSON.stringify({ section: 'S', title: '静态接线：三处上传面 @paste / 共用处理体 / 繁體提示' }))

const ZONES = [
  {
    zone: 'upload-seal-face',
    file: 'src/components/UploadSealDialog.vue',
    surface: '新增印章印面图',
    pasteHandler: 'onPasteFace',
    applyBody: 'applyFaceFile'
  },
  {
    zone: 'photo-upload',
    file: 'src/views/SealDetailView.vue',
    surface: '上传实物照片',
    pasteHandler: 'onPastePhoto',
    applyBody: 'applyPhotoFile'
  },
  {
    zone: 'replace-face-image',
    file: 'src/views/SealDetailView.vue',
    surface: '替换印面图',
    pasteHandler: 'onPasteReplaceImage',
    applyBody: 'applyReplaceFile'
  }
]

const fileCache = new Map()
function sourceOf(rel) {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(path.join(ROOT, rel), 'utf8'))
  return fileCache.get(rel)
}

/* 取承载某 zone 的开标签（用于确认 `@paste` 落在同一元素上）。 */
function openingTagWithZone(source, zone) {
  const re = new RegExp(`<[a-zA-Z][^>]*data-paste-zone="${zone}"[^>]*>`)
  const hit = source.match(re)
  return hit ? hit[0] : ''
}

for (const item of ZONES) {
  const source = sourceOf(item.file)
  const tag = openingTagWithZone(source, item.zone)

  check(`s-${item.zone}-1`, `[${item.surface}] 承载元素有 data-paste-zone="${item.zone}"`, true, tag !== '')
  check(`s-${item.zone}-2`, `[${item.surface}] 同一元素绑 @paste=`, true, /@paste\s*=/.test(tag))
  check(`s-${item.zone}-3`, `[${item.surface}] 承载元素可聚焦（tabindex）`, true, /tabindex\s*=/.test(tag))
  check(`s-${item.zone}-4`, `[${item.surface}] @paste 指向具名入口 ${item.pasteHandler}`, true, new RegExp(`@paste="${item.pasteHandler}"`).test(tag))
  check(
    `s-${item.zone}-5`,
    `[${item.surface}] 有可见繁體提示 data-paste-hint="${item.zone}"`,
    true,
    new RegExp(`data-paste-hint="${item.zone}"`).test(source) &&
      new RegExp(`data-paste-hint="${item.zone}"[^>]*>\\s*\\{\\{\\s*PASTE_HINT\\s*\\}\\}`).test(source)
  )
  check(`s-${item.zone}-6`, `[${item.surface}] 引共用纯函数模块 clipboardImage.js`, true, /from\s+'\.\.\/utils\/clipboardImage\.js'/.test(source))
  check(`s-${item.zone}-7`, `[${item.surface}] 引 PASTE_HINT 常量`, true, /\bPASTE_HINT\b/.test(source))
  check(`s-${item.zone}-8`, `[${item.surface}] 引 handleClipboardPaste 入口`, true, /\bhandleClipboardPaste\b/.test(source))
  check(
    `s-${item.zone}-9`,
    `[${item.surface}] 粘贴入口 ${item.pasteHandler} 存在且走共用入口`,
    true,
    new RegExp(`function\\s+${item.pasteHandler}\\s*\\(event\\)`).test(source) &&
      new RegExp(`${item.pasteHandler}[\\s\\S]{0,220}handleClipboardPaste`).test(source)
  )
  check(
    `s-${item.zone}-10`,
    `[${item.surface}] 共用处理体 ${item.applyBody}(file) 存在（选图 + 粘贴同源）`,
    true,
    new RegExp(`async\\s+function\\s+${item.applyBody}\\s*\\(file\\)`).test(source)
  )
  check(
    `s-${item.zone}-11`,
    `[${item.surface}] 粘贴入口带文本优先分支（reason !== 'TEXT_PRIORITY'）`,
    true,
    new RegExp(`${item.pasteHandler}[\\s\\S]{0,260}TEXT_PRIORITY`).test(source)
  )
  check(
    `s-${item.zone}-12`,
    `[${item.surface}] 仅接管时 preventDefault（handled 门控）`,
    true,
    new RegExp(`${item.pasteHandler}[\\s\\S]{0,200}if\\s*\\(decision\\.handled\\)\\s*event\\.preventDefault\\(\\)`).test(source)
  )
}

/* 三处共用同一纯函数模块（唯一真源，不各自另写一份判定）。 */
{
  const importers = ['src/components/UploadSealDialog.vue', 'src/views/SealDetailView.vue'].filter((rel) =>
    /from\s+'\.\.\/utils\/clipboardImage\.js'/.test(sourceOf(rel))
  )
  check('s-shared-1', '两个承载文件都引同一 clipboardImage.js（唯一真源）', 2, importers.length)
}

/* ---------------------------------------------------------------------------
   5. 汇总
   --------------------------------------------------------------------------- */
const total = results.length
console.log(
  JSON.stringify({
    summary: { total, passed: total - failures, failed: failures },
    failed_ids: results.filter((item) => !item.pass).map((item) => item.id),
    zones: ZONES.map((item) => ({ zone: item.zone, surface: item.surface, file: item.file }))
  })
)
process.exit(failures === 0 ? 0 : 1)
