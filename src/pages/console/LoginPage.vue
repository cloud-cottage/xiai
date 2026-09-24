<template>
  <div class="container">
    <div class="auth-wrap">
      <aside class="auth-aside">
        <p class="eyebrow">控制台</p>
        <h2>机构登录</h2>
        <ul>
          <li><b>演示环境</b>：登录不校验真实凭证，会话只存于本机浏览器</li>
          <li>账号支持<b>邮箱或手机号</b>；密码至少 8 位且需含字母与数字</li>
          <li>尚未开通的机构可走「申请演示环境」通道（长期保留）</li>
        </ul>
      </aside>

      <section class="auth-main">
        <!-- 03-4 声明 -->
        <NoticeBar variant="warn" data-role="login-disclaimer">演示环境：登录不校验真实凭证</NoticeBar>

        <!-- 03-1 登录表单 -->
        <form novalidate @submit.prevent="submit">
          <div class="field">
            <label for="login-account">账号（邮箱 / 手机号）</label>
            <input
              id="login-account" v-model.trim="form.account" type="text" autocomplete="username"
              placeholder="demo@yinyuan.example 或 11 位手机号"
              :aria-invalid="showError('account') || undefined"
              :aria-describedby="showError('account') ? 'login-account-error' : undefined"
              @blur="touch('account')"
            />
            <p v-if="showError('account')" id="login-account-error" class="field-error" data-error-for="account">{{ errors.account }}</p>
          </div>

          <div class="field">
            <label for="login-password">密码</label>
            <input
              id="login-password" v-model="form.password" type="password" autocomplete="current-password"
              placeholder="至少 8 位，含字母与数字"
              :aria-invalid="showError('password') || undefined"
              :aria-describedby="showError('password') ? 'login-password-error' : undefined"
              @blur="touch('password')"
            />
            <p v-if="showError('password')" id="login-password-error" class="field-error" data-error-for="password">{{ errors.password }}</p>
          </div>

          <div class="field">
            <label for="login-captcha">图形验证码</label>
            <div class="field-row">
              <input
                id="login-captcha" v-model.trim="form.captcha" type="text" maxlength="4" placeholder="填写右侧图形字符"
                :aria-invalid="showError('captcha') || undefined"
                :aria-describedby="showError('captcha') ? 'login-captcha-error' : undefined"
                @blur="touch('captcha')"
              />
              <!-- 图形占位（R9：纯 CSS 占位、零外链、零真实请求） -->
              <div class="cap-box" aria-hidden="true">DEMO<span>图形占位</span></div>
            </div>
            <p v-if="showError('captcha')" id="login-captcha-error" class="field-error" data-error-for="captcha">{{ errors.captcha }}</p>
            <p v-else class="hint">图形验证码为占位（演示态），任意填写即可，仅作非空校验</p>
          </div>

          <label class="checkline" for="login-remember">
            <input id="login-remember" v-model="form.remember" type="checkbox" />
            <span>记住我（演示态：会话统一保存于本机浏览器会话，勾选与否不改变存储位置）</span>
          </label>

          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <button class="btn" type="submit" :disabled="submitting" data-action="login-submit">
              {{ submitting ? '登录中…' : '登录' }}
            </button>
            <!-- 03-3 演示账号提示：一键填充，填充后仍可手动修改 -->
            <button
              v-if="demo" class="btn ghost" type="button" :disabled="submitting" data-action="fill-demo"
              @click="fillDemo"
            >点击使用演示账号</button>
          </div>

          <p v-if="demo" class="hint" data-block="demo-account">
            演示账号：<code class="mono">{{ demo.account }}</code>（演示态提供，仅用于界面演示）；
            点击「点击使用演示账号」一键填充，填充后仍可手动修改
          </p>
          <p v-if="submitting" class="hint" data-hint="submitting">正在校验登录信息，请稍候…</p>

          <!-- 提交失败/校验失败一律内联展示，不弹全局错误 -->
          <p v-if="submitError" class="field-error" role="alert" data-error="submit">{{ submitError }}</p>
        </form>

        <!-- 03-2 辅助入口 -->
        <div class="modal-acts">
          <router-link class="btn ghost sm" to="/console/register">还没有账号？注册</router-link>
          <EntryLink class="btn ghost sm" to="/demo">申请演示环境</EntryLink>
          <button class="btn ghost sm" type="button" data-action="forgot" @click="notifyForgot">忘记密码</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * P-M1-03 登录页。
 *
 * 要素 03-1～03-4 与交互 1～4 逐项落地：
 *  - 表单（03-1）：账号（邮箱 / 手机号合并）+ 密码 + 图形验证码（占位）+ 记住我；
 *  - 辅助入口（03-2）：忘记密码（占位提示）、还没有账号？注册、申请演示环境；
 *  - 演示账号提示（03-3）：一键填充、可手动修改，账号本身来自配置（不硬编码）；
 *  - 声明（03-4）：「演示环境：登录不校验真实凭证」；
 *  - 校验失败 → 字段内联错误，不弹全局错误；成功后写入会话并支持 `redirect` 回跳；
 *  - 已登录访问本页由路由守卫重定向至概览。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import { useAppConfig } from '@/composables/useAppConfig.js'
import { useAuth } from '@/composables/useAuth.js'
import { toast, toastNotConnected } from '@/composables/useToast.js'

const router = useRouter()
const route = useRoute()
const { demo, loadAppConfig } = useAppConfig()
const { signIn } = useAuth()

const form = reactive({ account: '', password: '', captcha: '', remember: true })
const submitting = ref(false)
const submitError = ref('')
const attempted = ref(false)
const touched = reactive({})
/** 适配层返回的字段级错误（如口令不正确）——仍以字段内联方式展示。 */
const serverError = reactive({})

const errors = computed(() => {
  const e = {}
  if (!form.account.trim()) e.account = '请输入账号（邮箱或手机号）'
  if (String(form.password).length < 8) e.password = '密码至少 8 位'
  if (!form.captcha.trim()) e.captcha = '请输入图形验证码'
  for (const [k, v] of Object.entries(serverError)) if (v) e[k] = v
  return e
})

/** 字段错误展示时机：失焦后或提交尝试后（首次提交前不预先报错）。 */
function showError(field) {
  return !!errors.value[field] && (attempted.value || !!touched[field])
}
function touch(field) {
  touched[field] = true
}

/** 账号或密码改动即清除服务端内联错误。 */
watch([() => form.account, () => form.password], () => { delete serverError.account })

onMounted(async () => {
  await loadAppConfig()
})

/** 03-3：一键填充演示凭证（填充后用户仍可自行修改）。 */
function fillDemo() {
  const cred = demo.value
  if (!cred) return
  form.account = cred.account
  form.password = cred.password
  toast(cred.label || '已填充演示账号')
}

async function submit() {
  submitError.value = ''
  delete serverError.account
  attempted.value = true
  // 字段级校验不通过 → 内联错误已展示，直接返回，不弹全局错误
  if (Object.keys(errors.value).length) return

  submitting.value = true
  try {
    await signIn(form.account, form.password)
    /** `redirect` 回跳：仅接受站内 `/console/**` 目标，其余一律回概览。 */
    const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    const target = raw.startsWith('/console') ? raw : null
    await router.replace(target || { name: 'console-overview' })
  } catch (e) {
    if (e?.code === 'AUTH_FAILED') serverError.account = e?.message || '账号或密码不正确'
    else submitError.value = e?.message || '登录失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}

function notifyForgot() {
  toastNotConnected('演示环境：找回密码通路未接入')
}
</script>
