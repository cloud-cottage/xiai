/**
 * API 文档内容 —— 单一真源（汇总导出）。
 *
 * 页面（`src/pages/marketing/ApiDocsPage.vue`）只从这里取数据，不另存文本副本。
 * 本文件不含数据适配逻辑，故**不放在 `src/data/`**（那里是数据适配层）。
 *
 * 文本逐字取自只读源文件
 *   qa-recheck/kong-apidoc-page-20260924/source/apidoc-source-20260924.txt
 *   md5 e2829375500233365a3316854e6149f5
 * 两段来源，按源文件自身顺序拼接：
 *   1) 行 317–331 接口清单总表（含每接口限流规则）—— 见本文件 clauseBlocks
 *   2) 行 335–637 修订版全文（生效版）—— 见 ./apidoc-endpoints.js
 *
 * 搬运纪律（本轮固定）：
 *   - 只做 markdown 语法记号到结构化字段的**手工**映射（`##`→h2、`>`→quote、`|` 表→table、
 *     `**`→加粗片段、行内反引号→代码片段）。记号本身不是内容，一律不进入 parts。
 *   - 正文可见文本逐字保留：基础地址 `https://api.example.com/yinyuan/v1` 原样、
 *     鉴权示例里的 `ApiKey` 与该行占位密钥原样（源文件字节为 `ApiKey YOUR_API_KEY`；
 *     注意：某些工具回显会把 `ApiKey <token>` 打码成三个星号，落盘一律以源文件字节为准）、
 *     未定稿声明（「后续文档补充」「后续版本补充」）照抄。
 *   - 接口清单表用**全路径**（形如 `/yinyuan/v1/all`），下文各接口小标题用**相对路径**
 *     （形如 `/all`）——两种形态如实保留，不统一、不推导。
 *
 * parts 片段类型：{ t } 纯文本 · { c } 行内代码 · { b } 加粗
 * 块类型：h1 h2 h3 p strong? code quote ul ol table hr
 */
import { endpointBlocks } from './apidoc-endpoints.js'

/** 行 317–331：接口清单总表（更新定稿）。 */
const clauseBlocks = [
  { type: 'h2', t: '接口清单' },
  {
    type: 'table',
    head: [[{ t: '接口' }], [{ t: 'Method' }], [{ t: '路径' }], [{ t: '简述' }], [{ t: '限流规则' }]],
    rows: [
      [
        [{ t: '1' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/all' }],
        [{ t: '无入参。鉴权通过返回' }, { b: '全量 resourceId + 核心属性' }, { t: '，不含预览图。客户本地做列表、筛选、翻页。' }],
        [{ t: '每日最多 ' }, { b: '1000 次' }, { t: '，无 QPS 限制' }],
      ],
      [
        [{ t: '2' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/preview/{resourceId}' }],
        [{ t: '单 ID 获取预览图：路径传入单个 resourceId，返回 4 张预览图 URL + transform 几何参数' }],
        [{ t: '默认 QPS 20，合同可协商上调' }],
      ],
      [
        [{ t: '3' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/preview/batch' }],
        [
          { t: '批量获取预览图：Query 参数 ' },
          { c: 'ids=res_001,res_002' },
          { t: '，逗号分隔 ID，单次最多 10 个 ID；返回每个 ID 对应的 4 张预览图 URL + transform 参数。预览 URL 有效期：' },
          { b: '1 小时' },
        ],
        [{ t: '默认 QPS 20，合同可协商上调' }],
      ],
      [
        [{ t: '4' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/detail/{resourceId}' }],
        [{ t: '单 ID 查询附加属性 + 高清原图签名 URL。高清原图 URL 有效期：' }, { b: '5 分钟' }],
        [{ t: '默认 QPS 20，合同可协商上调' }],
      ],
      [
        [{ t: '5' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/search/' }],
        [{ t: 'GET 扁平化 Query 参数检索附加属性，返回匹配 resourceId 列表，单次最多返回 100 条 ID' }],
        [{ t: '默认 QPS 10，合同可协商上调' }],
      ],
      [
        [{ t: '6' }],
        [{ t: 'GET' }],
        [{ c: '/yinyuan/v1/bill' }],
        [{ t: '查询账单：原图消耗次数、月度额度、剩余流量，对账使用' }],
        [{ t: '默认 QPS 5' }],
      ],
    ],
  },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      {
        kind: 'text',
        parts: [
          {
            t: '图片规则不变：预览图 URL 签名防盗链，有效期 1 小时，不计费；高清原图 URL 有效期 5 分钟，访问才扣费；同一客户 + 同一 resourceId，5 分钟内多次访问原图仅计 1 次。',
          },
        ],
      },
    ],
  },
]

/** 行 335–384：修订版全文的开头（标题 + 1 概述）。 */
const overviewBlocks = [
  { type: 'h1', t: 'Yinyuan v1 API 文档（机构客户版）【修订版】' },

  { type: 'h2', t: '1 概述' },

  { type: 'h3', t: '1.1 简介' },
  {
    type: 'p',
    parts: [
      {
        t: 'Yinyuan API 是面向机构客户的图像资源查询服务。客户通过 api-key 鉴权调用 RESTful API，获取图像资源 ID、核心属性、预览图素材、附加业务属性以及高清原图访问地址。',
      },
    ],
  },
  {
    type: 'p',
    parts: [
      { t: '整体架构采用' },
      { b: '轻量核心属性全量下发，客户本地筛选； heavy 附加属性按需检索、单 ID 详情查询' },
      { t: '的模式。我方不提供列表分页能力，分页逻辑由客户前端自行实现。' },
    ],
  },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '图片访问规则' }] },
      { kind: 'blank' },
      { kind: 'blank' },
      { kind: 'li', parts: [{ t: '预览图 URL：签名防盗链，有效期 1 小时；仅用于前端拼接预览，不计费。' }] },
      { kind: 'li', parts: [{ t: '高清原图 URL：签名防盗链，有效期 5 分钟；访问高清原图触发流量计费。' }] },
    ],
  },

  { type: 'h3', t: '1.2 版本信息' },
  { type: 'p', parts: [{ t: '当前版本：' }, { c: 'v1' }] },
  { type: 'p', parts: [{ t: '基础地址：' }, { c: 'https://api.example.com/yinyuan/v1' }] },

  { type: 'h3', t: '1.3 鉴权方式' },
  { type: 'p', parts: [{ t: '所有接口必须在 HTTP 请求头携带 api-key：' }] },
  { type: 'code', t: 'Authorization: ApiKey YOUR_API_KEY' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '⚠️ 安全提示' }] },
      {
        kind: 'text',
        parts: [{ t: 'api-key 属于密钥，禁止在客户端浏览器直接使用。所有 API 调用必须由客户服务端中转，避免密钥泄露被盗刷。' }],
      },
    ],
  },

  { type: 'h3', t: '1.4 计费说明' },
  {
    type: 'ol',
    items: [
      { parts: [{ b: '年费' }, { t: '：固定服务年费，开通 Yinyuan 服务权限。' }] },
      {
        parts: [{ b: '流量费' }, { t: '：高清原图访问次数流量计费。' }],
        sub: [
          [{ t: '计费触发点：HTTP 访问高清原图签名 URL。' }],
          [{ t: '计费规则：同一客户账号，同一个 resourceId，在高清原图 URL 有效期（5 分钟）内多次访问，仅计 1 次流量。' }],
          [{ t: 'API 接口调用（all /preview/detail /search/bill）本身' }, { b: '不产生流量费用' }, { t: '。' }],
        ],
      },
      {
        parts: [
          { b: '额度管控' },
          { t: '：客户存在月度高清原图访问上限。额度耗尽后，高清原图访问返回 403；属性查询、预览接口可正常使用。' },
        ],
      },
    ],
  },

  { type: 'h3', t: '1.5 限流说明' },
  { type: 'p', parts: [{ t: '接口配置限流保护，防止异常调用冲击服务。' }] },
  {
    type: 'ul',
    items: [
      {
        parts: [
          { t: '超出 QPS / 调用次数限制，返回 HTTP ' },
          { c: '429 Too Many Requests' },
          { t: '，响应头附带 ' },
          { c: 'Retry-After: N' },
          { t: '（单位秒），提示建议等待时间。' },
        ],
      },
      { parts: [{ t: '客户重试策略：推荐指数退避重试，禁止高频循环暴力重试。' }] },
      { parts: [{ t: 'QPS 上限可根据机构客户合同协商调整。' }] },
    ],
  },
]

/** 页面渲染顺序：接口清单总表（源文件在前）→ 修订版全文。 */
export const apidocBlocks = [...clauseBlocks, ...overviewBlocks, ...endpointBlocks]
