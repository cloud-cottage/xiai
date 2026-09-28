/**
 * 控制台入口（web-console，需登录）—— spec §2.1 / §2.3-6。
 */
import { createApp } from 'vue'
import '@/styles/tokens.css'
import '@/styles/base.css'
import ConsoleApp from './App.vue'
import router from '@/router/console.js'
import { loadAppConfig } from '@/composables/useAppConfig.js'

loadAppConfig()

createApp(ConsoleApp).use(router).mount('#console-app')
