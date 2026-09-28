/**
 * 基础环境配置。
 *
 * spec §8.3-1：适配层由单一开关选择实现 `DATA_SOURCE = mock | api`。
 * 浏览器端只能读取 Vite 的 `VITE_` 前缀变量，因此配置文件里写作
 * `VITE_DATA_SOURCE`，代码内统一暴露为 `DATA_SOURCE`（唯一读取点）。
 */

const RAW = String(import.meta.env.VITE_DATA_SOURCE || 'mock').trim().toLowerCase()

/** 单一开关：'mock' | 'api'（spec §8.3-1）。改这里或改 .env 即切换实现。 */
export const DATA_SOURCE = RAW === 'api' ? 'api' : 'mock'

export const IS_MOCK = DATA_SOURCE === 'mock'

/** 真实实现使用的 API 前缀（mock 下不发起任何请求）。 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

/** 构建模式：development | production */
export const APP_ENV = import.meta.env.MODE

/** 全站时区口径（spec §7.5）。 */
export const TIMEZONE = 'Asia/Shanghai'

/** mock 方法的人工延迟区间（spec §8.3-4：300–800ms，用于暴露加载态缺失）。 */
export const MOCK_LATENCY_MS = { min: 300, max: 800 }
