/**
 * 玺爱 · 启动引导
 * 把初始化收口到一处，避免 main.js 直接触碰 data 层。
 */

import { bootstrapSession as restoreSession } from './auth.js'
import { restoreTheme, setTheme } from '../data/session.js'

export function bootstrapSession() {
  return restoreSession()
}

export function bootstrapTheme() {
  return restoreTheme()
}

export function switchTheme(theme) {
  setTheme(theme)
}
