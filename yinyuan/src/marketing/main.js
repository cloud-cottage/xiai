/**
 * 营销入口（web-marketing，公开）—— spec §2.1 / §2.3-6。
 */
import { createApp } from 'vue'
import '@/styles/tokens.css'
import '@/styles/base.css'
import MarketingApp from './App.vue'
import router from '@/router/marketing.js'
import { loadAppConfig } from '@/composables/useAppConfig.js'

// 配置位（注册开关等）在任何页面渲染前先取一次，避免导航/按钮态闪烁
loadAppConfig()

createApp(MarketingApp).use(router).mount('#marketing-app')
