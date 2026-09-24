/**
 * API 文档内容 —— 第二段（接口文档 2.x ～ 附录 6）。
 *
 * 单一真源拆分：本文件与 `apidoc.js` 合计 2 个内容模块，`apidoc.js` 负责汇总导出，
 * 页面只从 `@/config/apidoc.js` 读数据（本文件不直接对外）。
 *
 * 文本逐字取自只读源文件
 *   qa-recheck/kong-apidoc-page-20260924/source/apidoc-source-20260924.txt
 * 对应行区间 335–637（修订版全文，生效版）。
 *
 * 搬运纪律（本轮固定）：
 *   - 只做 markdown 语法记号到结构化字段的**手工**映射：`#` / `##` / `###` → h1/h2/h3，
 *     `>` → quote，`-` / `1.` → ul/ol，``` 围栏 → code，`|` 表 → table，`**` → 加粗片段，
 *     行内 ` 反引号 ` → 代码片段。记号本身不是内容，一律不进入 parts。
 *   - 文中所有可见文本（含 `ApiKey YOUR_API_KEY` 这行占位密钥、JSON 示例、相对路径写法、未定稿声明、
 *     「all /preview/detail /search/bill」这类原样空格）**逐字保留**，不做统一、改写、补全。
 *
 * parts 片段类型：{ t } 纯文本 · { c } 行内代码 · { b } 加粗
 * 块类型：h1 h2 h3 p strong? code quote ul ol table hr
 */

export const endpointBlocks = [
  { type: 'h2', t: '2 接口文档' },

  /* ---------------- 2.1 ---------------- */
  { type: 'h3', t: '2.1 GET /all' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '获取全量资源 ID 与核心属性。无请求参数。' }] },
      { kind: 'text', parts: [{ t: '用途：客户服务端拉取全量轻量核心数据，在本地建立索引，实现前端列表、本地筛选、本地翻页。' }] },
      { kind: 'text', parts: [{ t: '限制：每日最多调用 1000 次。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" https://api.example.com/yinyuan/v1/all' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": [
    {
      "resourceId": "res_001",
      "coreAttr": {
        "name": "样例印",
        "dynasty": "明",
        "category": "玺印"
      }
    },
    {
      "resourceId": "res_002",
      "coreAttr": {
        "name": "另一枚印",
        "dynasty": "清",
        "category": "玺印"
      }
    }
  ]
}`,
  },
  { type: 'hr' },

  /* ---------------- 2.2 ---------------- */
  { type: 'h3', t: '2.2 GET /preview/{resourceId}' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '获取单个资源预览图签名 URL 与前端几何拼接参数。' }] },
      { kind: 'text', parts: [{ t: '路径参数：' }, { c: 'resourceId' }] },
      { kind: 'text', parts: [{ t: '返回：4 张预览图 URL，以及一组几何参数，客户前端根据参数完成图片拼接渲染。' }] },
      { kind: 'text', parts: [{ t: '预览图 URL 签名防盗链，有效期 1 小时。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" https://api.example.com/yinyuan/v1/preview/res_001' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": {
    "resourceId": "res_001",
    "previewImages": [
      "https://img.example.com/preview/xxx?token=abc&expire=1790000000",
      "https://img.example.com/preview/xxx?token=abd&expire=1790000000",
      "https://img.example.com/preview/xxx?token=abe&expire=1790000000",
      "https://img.example.com/preview/xxx?token=abf&expire=1790000000"
    ],
    "transform": [0.12, 0.84, 1.57, 0.96]
  }
}`,
  },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: 'transform：几何拼接参数数组，前端使用该组参数完成 4 张预览图的合成渲染。参数业务释义后续文档补充。' }] },
    ],
  },
  { type: 'hr' },

  /* ---------------- 2.3 ---------------- */
  { type: 'h3', t: '2.3 GET /preview/batch' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '批量获取预览图签名 URL 与前端几何拼接参数。' }] },
      { kind: 'text', parts: [{ t: 'Query 参数：' }, { c: 'ids' }, { t: '，逗号分隔 resourceId；单次最多传入 10 个 ID。' }] },
      { kind: 'text', parts: [{ t: '返回：每个 resourceId 包含 4 张预览图 URL，以及一组几何参数，客户前端根据参数完成图片拼接渲染。' }] },
      { kind: 'text', parts: [{ t: '预览图 URL 签名防盗链，有效期 1 小时。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" "https://api.example.com/yinyuan/v1/preview/batch?ids=res_001,res_002"' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": [
    {
      "resourceId": "res_001",
      "previewImages": [
        "https://img.example.com/preview/xxx?token=abc&expire=1790000000",
        "https://img.example.com/preview/xxx?token=abd&expire=1790000000",
        "https://img.example.com/preview/xxx?token=abe&expire=1790000000",
        "https://img.example.com/preview/xxx?token=abf&expire=1790000000"
      ],
      "transform": [0.12, 0.84, 1.57, 0.96]
    },
    {
      "resourceId": "res_002",
      "previewImages": [
        "https://img.example.com/preview/xxx?token=acd&expire=1790000000",
        "https://img.example.com/preview/xxx?token=ace&expire=1790000000",
        "https://img.example.com/preview/xxx?token=acf&expire=1790000000",
        "https://img.example.com/preview/xxx?token=acg&expire=1790000000"
      ],
      "transform": [0.22, 0.71, 0.45, 1.02]
    }
  ]
}`,
  },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: 'transform：几何拼接参数数组，前端使用该组参数完成 4 张预览图的合成渲染。参数业务释义后续文档补充。' }] },
    ],
  },
  { type: 'hr' },

  /* ---------------- 2.4 ---------------- */
  { type: 'h3', t: '2.4 GET /detail/{resourceId}' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '根据单个资源 ID 查询附加属性与高清原图签名 URL。' }] },
      { kind: 'text', parts: [{ t: '路径参数：' }, { c: 'resourceId' }] },
      { kind: 'text', parts: [{ t: '高清原图 URL 签名防盗链，有效期 5 分钟。访问该 URL 触发流量计费。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" https://api.example.com/yinyuan/v1/detail/res_001' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": {
    "resourceId": "res_001",
    "extraAttr": {
      "detail": "详细文字描述内容...",
      "material": "青铜",
      "size": "32mm × 32mm"
    },
    "originalImageUrl": "https://img.example.com/original/xxx?token=xyz&expire=1789998000"
  }
}`,
  },
  { type: 'hr' },

  /* ---------------- 2.5 ---------------- */
  { type: 'h3', t: '2.5 GET /search/' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '根据附加属性字段检索资源，返回匹配的 resourceId 列表。' }] },
      { kind: 'text', parts: [{ t: '请求参数：扁平化 Query 参数，例如 ' }, { c: 'category=玺印&dynasty=明' }, { t: '。' }] },
      { kind: 'text', parts: [{ t: '返回限制：单次检索最多返回 100 条 resourceId。客户拿到 ID 列表后，循环调用 ' }, { c: '/detail/{resourceId}' }, { t: ' 获取详情。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" "https://api.example.com/yinyuan/v1/search/?category=玺印&dynasty=明"' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": {
    "resourceIds": ["res_001","res_003","res_010"]
  }
}`,
  },
  { type: 'hr' },

  /* ---------------- 2.6 ---------------- */
  { type: 'h3', t: '2.6 GET /bill' },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: '查询账单信息，用于客户对账。返回高清原图月度额度、已消耗次数、剩余流量额度。' }] },
    ],
  },
  { type: 'p', strong: true, parts: [{ b: '请求示例' }] },
  { type: 'code', t: 'curl -H "Authorization: ApiKey YOUR_API_KEY" https://api.example.com/yinyuan/v1/bill' },
  { type: 'p', strong: true, parts: [{ b: '响应示例' }] },
  {
    type: 'code',
    t: `{
  "data": {
    "monthlyQuota": 1000,
    "usedCount": 120,
    "remainCount": 880
  }
}`,
  },

  /* ---------------- 3 错误码规范 ---------------- */
  { type: 'h2', t: '3 错误码规范' },
  { type: 'p', parts: [{ t: '所有接口异常返回统一 JSON 结构：' }] },
  {
    type: 'code',
    t: `{
  "code": 10001,
  "msg": "可读错误描述",
  "requestId": "uuid-xxxxxx"
}`,
  },
  {
    type: 'table',
    head: [[{ t: 'HTTP Status' }], [{ t: '业务 code' }], [{ t: '说明' }]],
    rows: [
      [[{ t: '401' }], [{ t: '10001' }], [{ t: 'ApiKey 不存在或者鉴权失败' }]],
      [[{ t: '403' }], [{ t: '10002' }], [{ t: '权限拒绝；高清原图月度流量额度耗尽' }]],
      [[{ t: '404' }], [{ t: '10003' }], [{ t: 'resourceId 不存在' }]],
      [[{ t: '400' }], [{ t: '10004' }], [{ t: '参数错误（ids 超过 10 个、检索参数非法等）' }]],
      [[{ t: '429' }], [{ t: '10005' }], [{ t: '请求超出限流配额' }]],
      [[{ t: '500' }], [{ t: '10006' }], [{ t: '服务内部异常' }]],
    ],
  },
  {
    type: 'quote',
    lines: [
      { kind: 'blank' },
      { kind: 'text', parts: [{ t: 'requestId：每次请求唯一标识，客户提交工单排查问题时，需要附带 requestId。' }] },
    ],
  },

  /* ---------------- 4 图片链接访问说明 ---------------- */
  { type: 'h2', t: '4 图片链接访问说明' },
  {
    type: 'ol',
    items: [
      { parts: [{ t: '预览图 URL：有效期 1 小时，过期访问返回 403；仅预览展示，不计费。' }] },
      { parts: [{ t: '高清原图 URL：有效期 5 分钟，过期访问返回 403；访问触发流量计费。' }] },
      { parts: [{ t: '防盗链机制：URL 内置签名与过期时间，不依赖 Referer。' }] },
    ],
  },

  /* ---------------- 5 集成最佳实践 ---------------- */
  { type: 'h2', t: '5 集成最佳实践' },
  {
    type: 'ol',
    items: [
      { parts: [{ t: '客户服务启动 / 同步调用 ' }, { c: '/all' }, { t: '，拉取全量核心属性，本地存储。每日最多调用 1000 次。' }] },
      {
        parts: [{ t: '前端列表渲染：使用本地核心属性；需要预览图时：' }],
        sub: [
          [{ t: '少量 ID：调用 ' }, { c: '/preview/{resourceId}' }],
          [{ t: '批量（最多 10 个）：调用 ' }, { c: '/preview/batch?ids=xxx' }],
        ],
        tail: [{ t: '拿到预览素材，前端根据 transform 参数拼接图片。' }],
      },
      { parts: [{ t: '用户点击查看详情：调用 ' }, { c: '/detail/{resourceId}' }, { t: ' 获取附加属性与高清原图地址。' }] },
      { parts: [{ t: '附加属性检索场景：调用 ' }, { c: '/search/' }, { t: ' 获取匹配 ID 列表，再逐个拉取详情。' }] },
      { parts: [{ t: '程序健壮性：接口 429 限流时使用指数退避重试；捕获异常，不要无限循环请求。' }] },
    ],
  },

  /* ---------------- 6 附录 ---------------- */
  { type: 'h2', t: '6 附录' },
  {
    type: 'ul',
    items: [
      { parts: [{ t: '限流配额可根据签约合同调整。' }] },
      { parts: [{ t: 'transform 几何拼接参数说明：后续版本补充。' }] },
      { parts: [{ t: '检索支持字段清单：后续版本补充。' }] },
    ],
  },
]
