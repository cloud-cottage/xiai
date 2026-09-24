<template>
  <div class="container">
    <div class="auth-wrap">
      <aside class="auth-aside">
        <p class="eyebrow">开通</p>
        <h2>注册机构账号</h2>
        <ul>
          <li><b>注册即自动开通</b>，可自助生成 API 密钥</li>
          <li>注册开关由平台配置驱动：开放时可自助注册，暂停时改走申请演示通道</li>
          <li>本轮为演示态，账号数据仅存于本机浏览器会话，刷新即重置，不写入任何真实库</li>
        </ul>
      </aside>

      <section class="auth-main">
        <!-- 02-2 注册开关态提示：开关位来自平台配置（不硬编码），状态条 + 按钮可见性双通道表达 -->
        <NoticeBar :variant="registerOpen ? 'status' : 'warn'" data-role="register-flag-bar">
          <template v-if="registerOpen"><b>注册开放中</b> —— 注册即自动开通，可自助生成 API 密钥</template>
          <template v-else>
            <b>注册已暂停</b>，请走
            <EntryLink to="/demo">申请演示通道</EntryLink>
          </template>
        </NoticeBar>

        <!-- 02-1 注册表单 -->
        <form novalidate @submit.prevent="submit">
          <div class="field-row">
            <div class="field">
              <label for="reg-org">机构名称</label>
              <input
                id="reg-org" v-model.trim="form.orgName" type="text" placeholder="（演示）XX 博物馆"
                :aria-invalid="showError('orgName') || undefined"
                :aria-describedby="showError('orgName') ? 'reg-org-error' : undefined"
                @blur="touch('orgName')"
              />
              <p v-if="showError('orgName')" id="reg-org-error" class="field-error" data-error-for="orgName">{{ errors.orgName }}</p>
            </div>
            <div class="field">
              <label for="reg-contact">联系人姓名</label>
              <input
                id="reg-contact" v-model.trim="form.contactName" type="text" placeholder="张示例"
              />
              <p class="hint">用于后续服务联络；演示态不落库</p>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="reg-phone">手机号</label>
              <input
                id="reg-phone" v-model.trim="form.phone" type="tel" inputmode="numeric" placeholder="11 位数字"
                :aria-invalid="showError('phone') || undefined"
                :aria-describedby="showError('phone') ? 'reg-phone-error' : undefined"
                @blur="touch('phone')"
              />
              <p v-if="showError('phone')" id="reg-phone-error" class="field-error" data-error-for="phone">{{ errors.phone }}</p>
            </div>
            <div class="field">
              <label for="reg-email">邮箱</label>
              <input
                id="reg-email" v-model.trim="form.email" type="email" autocomplete="username" placeholder="name@yinsuo.example"
                :aria-invalid="showError('email') || undefined"
                :aria-describedby="showError('email') ? 'reg-email-error' : undefined"
                @blur="touch('email')"
              />
              <p v-if="showError('email')" id="reg-email-error" class="field-error" data-error-for="email">{{ errors.email }}</p>
            </div>
          </div>

          <div class="field-row">
            <div class="field">
              <label for="reg-pwd">密码</label>
              <input
                id="reg-pwd" v-model="form.password" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字"
                :aria-invalid="showError('password') || undefined"
                :aria-describedby="showError('password') ? 'reg-pwd-error' : undefined"
                @blur="touch('password')"
              />
              <p v-if="showError('password')" id="reg-pwd-error" class="field-error" data-error-for="password">{{ errors.password }}</p>
            </div>
            <div class="field">
              <label for="reg-pwd2">确认密码</label>
              <input
                id="reg-pwd2" v-model="form.confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码"
                :aria-invalid="showError('confirmPassword') || undefined"
                :aria-describedby="showError('confirmPassword') ? 'reg-pwd2-error' : undefined"
                @blur="touch('confirmPassword')"
              />
              <p v-if="showError('confirmPassword')" id="reg-pwd2-error" class="field-error" data-error-for="confirmPassword">{{ errors.confirmPassword }}</p>
            </div>
          </div>

          <div class="field">
            <label for="reg-captcha">图形验证码</label>
            <div class="field-row">
              <input
                id="reg-captcha" v-model.trim="form.captcha" type="text" maxlength="4" placeholder="填写右侧图形字符"
                :aria-invalid="showError('captcha') || undefined"
                :aria-describedby="showError('captcha') ? 'reg-captcha-error' : undefined"
                @blur="touch('captcha')"
              />
              <!-- 图形占位（R9：纯 CSS 占位、零外链、零真实请求） -->
              <div class="cap-box" aria-hidden="true">DEMO<span>图形占位</span></div>
            </div>
            <p v-if="showError('captcha')" id="reg-captcha-error" class="field-error" data-error-for="captcha">{{ errors.captcha }}</p>
            <p v-else class="hint">图形验证码为占位（演示态），任意填写即可，仅作非空校验</p>
          </div>

          <label class="checkline" for="reg-terms">
            <input id="reg-terms" v-model="form.agreed" type="checkbox" />
            <span>我已阅读并同意《服务条款》与《隐私政策》（演示占位）</span>
          </label>

          <!-- 02-3 提交按钮：「立即开通」；未勾选条款禁用；开关关闭时置灰并出现「申请演示环境」次按钮 -->
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <button
              class="btn" type="submit" :disabled="!canSubmit" data-action="register-submit"
            >{{ submitting ? '开通中…' : '立即开通' }}</button>
            <EntryLink v-if="!registerOpen" class="btn ghost" to="/demo">申请演示环境</EntryLink>
          </div>

          <!-- 禁用态不得是唯一语义手段：另有文案说明为何不可提交 -->
          <p v-if="!form.agreed" class="hint" data-hint="terms">勾选服务条款后方可提交</p>
          <p v-else-if="!registerOpen" class="hint" data-hint="register-closed">
            注册已暂停，可点击「申请演示环境」走人工通道
          </p>
          <p v-if="submitting" class="hint" data-hint="submitting">正在创建机构账号，请稍候…</p>

          <!-- 提交失败一律内联展示，不弹全局错误 -->
          <p v-if="submitError" class="field-error" role="alert" data-error="submit">{{ submitError }}</p>
        </form>

        <!-- 02-4 已有账号入口 -->
        <div class="modal-acts">
          <router-link class="btn ghost sm" to="/console/login">已有账号？去登录</router-link>
        </div>

        <!-- 02-5 说明区 -->
        <p class="disclaimer" style="margin-top:18px;" data-block="register-note">
          注册即自动开通，可自助生成 API 密钥；本轮为演示态，账号数据仅保存于本机浏览器会话（刷新即重置），不落库。
        </p>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * P-M1-02 注册页。
 *
 * 要素 02-1～02-5 与交互 1～5 逐项落地：
 *  - 开关态（02-2 / 交互 4）来自配置（经 A1 读入 featureFlags.registerOpen），页面不硬编码；
 *  - 字段级校验（交互 1）→ **内联字段错误**，不弹全局错误（交互 2）；未勾选条款禁用提交；
 *  - 提交成功（交互 3）→ 写入适配层（A2 已落内存 mock）→ 跳控制台概览 + 一次性开通提示；
 *  - 已登录访问本页由路由守卫重定向至概览（交互 5）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntryLink from '@/components/EntryLink.vue'
import NoticeBar from '@/components/NoticeBar.vue'
import { useAppConfig } from '@/composables/useAppConfig.js'
import { useAuth } from '@/composables/useAuth.js'
import { toast } from '@/composables/useToast.js'

const router = useRouter()
const { featureFlags, loadAppConfig } = useAppConfig()
const { signUp } = useAuth()

const form = reactive({
  orgName: '', contactName: '', phone: '', email: '',
  password: '', confirmPassword: '', captcha: '', agreed: false,
})
const submitting = ref(false)
const submitError = ref('')
const attempted = ref(false)
const touched = reactive({})
/** 适配层返回的字段级错误（如邮箱已注册）——仍以字段内联方式展示。 */
const serverError = reactive({})

/** 开关态来自配置：配置未就绪（null）时按「开放」处理，避免误判为暂停而误禁提交。 */
const registerOpen = computed(() => featureFlags.value.registerOpen !== false)

const errors = computed(() => {
  const e = {}
  if (form.orgName.trim().length < 2) e.orgName = '机构名称至少 2 个字'
  if (!/^1\d{10}$/.test(form.phone.trim())) e.phone = '请输入 11 位手机号'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = '请输入有效邮箱地址'
  const pwd = String(form.password)
  if (pwd.length < 8) e.password = '密码至少 8 位'
  else if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) e.password = '密码需同时包含字母与数字'
  if (!form.confirmPassword) e.confirmPassword = '请再次输入密码'
  else if (form.confirmPassword !== pwd) e.confirmPassword = '两次输入的密码不一致'
  if (!form.captcha.trim()) e.captcha = '请输入图形验证码'
  for (const [k, v] of Object.entries(serverError)) if (v) e[k] = v
  return e
})

const canSubmit = computed(() => registerOpen.value && form.agreed && !submitting.value)

/** 字段错误展示时机：失焦后或提交尝试后（首次提交前不预先报错）。 */
function showError(field) {
  return !!errors.value[field] && (attempted.value || !!touched[field])
}
function touch(field) {
  touched[field] = true
}

/** 邮箱被占用属服务端判定；用户改动邮箱即清除该内联错误。 */
watch(() => form.email, () => { delete serverError.email })

onMounted(async () => {
  await loadAppConfig()
})

async function submit() {
  submitError.value = ''
  delete serverError.email
  attempted.value = true
  if (!registerOpen.value) {
    submitError.value = '注册已暂停，请走申请演示通道'
    return
  }
  if (!form.agreed) {
    submitError.value = '请先阅读并勾选服务条款'
    return
  }
  // 字段级校验不通过 → 内联错误已展示，直接返回，不弹全局错误
  if (Object.keys(errors.value).length) return

  submitting.value = true
  try {
    await signUp({
      orgName: form.orgName,
      contactName: form.contactName,
      phone: form.phone,
      email: form.email,
      password: form.password,
    })
    toast('开通成功：机构账号已创建（演示态），可自助生成 API 密钥')
    await router.replace({ name: 'console-overview', query: { opened: '1' } })
  } catch (e) {
    const code = e?.code
    if (code === 'EMAIL_TAKEN' || code === 'VALIDATION_ERROR') {
      serverError.email = e?.message || '该邮箱不可用'
    } else {
      submitError.value = e?.message || '注册失败，请稍后重试'
    }
  } finally {
    submitting.value = false
  }
}
</script>
