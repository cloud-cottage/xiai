# 测试网守则（`scripts/`）—— 跑任何套件前先读这页

本仓的离线套件**不允许**碰真实网络（尤其**不允许碰生产 CARD**）。共三道防线，缺一不可。

## 1. 硬防线：哨兵环境变量 `XIAI_NO_REAL_CARD`

- `cloudfunctions/xiai-user-token/lib/cardApi.js`：若 `XIAI_NO_REAL_CARD=1`（或 `NODE_ENV=test`）
  而**未注入**自定义 transport ⇒ **直接抛错**（`error.code === 'TEST_GUARD'`）、**零请求**。
- 所有 `scripts/verify-*.mjs` **开头都设** `process.env.XIAI_NO_REAL_CARD = '1'`；
  `scripts/fixtures/fake-card.mjs` 的 `installFakeCard()` 里也设一次（减少重复、防漏）。
- 计数校验：`grep -l "XIAI_NO_REAL_CARD" scripts/verify-*.mjs | wc -l` 必须等于
  `ls scripts/verify-*.mjs | wc -l`。

## 2. 注入缝：所有套件必须注入假 CARD

```js
import { createFakeCard, installFakeCard } from './fixtures/fake-card.mjs'
const fakeCard = installFakeCard(createFakeCard())
```

`installFakeCard()` 同时：设哨兵、注入假 transport 与假密钥/基址读点、把**任何绝对地址**的
`fetch` 拦下并计数（`fakeCard.blockedFetches()` 必须恒 `0`）。

## 3. 纪律（人）

- **不得**在跑套件前 `export CARD_API_KEY`（也不得 `source` 任何含真密钥的 env 文件）。
  跑之前先自查：`node -e "console.log(!!process.env.CARD_API_KEY)"` 必须打印 `false`。
- 生产 CARD 只允许**只读**（`ping` / `exportPersons`）；任何写（`upsertPerson` /
  `updatePersonFields`）都不许在自检里发生。
- **预演脚本单独立目录**（如 `scripts/predict/` 或 `scripts/preview/`），文件头**必须写明目标环境**
  （生产 / 预发 / 本地）与「是否只读」；不得与 `verify-*.mjs` 混放，避免被当成离线套件顺手跑。
- 生产基址**不入代码**：`lib/cardApi.js` 零域名（鉴权面 D4 机械尺）；基址走
  `CARD_API_URL` env → 集合 `xiai_server_secrets` 文档 `card_api` 的 `base_url` 字段。

## 上线前置（改了 `lib/cardApi.js` 基址口径的批次必看）

本仓 `lib/cardApi.js` **代码内零域名** ⇒ 部署后**必须有**下列之一，否则三处采纳 / 修复写入
一律 `CONFIG_MISSING`（fail-closed，零写入）：

1. 云函数环境变量 `CARD_API_URL`＝CARD 网关完整基址；或
2. 集合 `xiai_server_secrets` 文档 `card_api` 增加 `base_url` 字段（同一文档已存 `key`）。

两条都没配就上线，等于把「采纳」整条路径关掉 —— 部署前先确认一条在位。

## 事故考古（为什么有这页）

曾有一次 `verify-person-model` / `verify-adopt-atomicity` 在 shell 已导出真 `CARD_API_KEY`
的情况下跑起来，`lib/cardApi.js` 走了真 `fetch`，把测试行写进生产 CARD（脏了 `person_id`，
已用种子回填修复）。防线 1 + 2 就是从那次数出来的：**漏注入必须当场红，不能静默联网**。
