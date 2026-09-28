import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import { bootstrapSession, bootstrapTheme } from './services/bootstrap.js'
import './styles/tokens.css'
import './styles/base.css'

bootstrapTheme()
bootstrapSession()

createApp(App).use(router).mount('#app')
