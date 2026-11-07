<script setup lang="ts">
/**
 * 皎皎角短信登录。
 * 用户本人完成图标点选/滑块 → 官方发短信 → 输入验证码登录；程序不做任何自动验证。
 * 网络请求全部走主进程 IPC（后端 exe 冻结、页面本身也没有跨域能力），
 * 成功后把 token / dev_code / refreshToken 交给账号编辑页写入本地凭据。
 *
 * 实测结论（决定了这里的分工）：
 * - 人机验证结果、发短信通道、换 token 通道必须是同一条：android 场景的验证结果
 *   只能给 android 的 getSmsCode 用，h5 场景的只能给 h5 用，跨用一律 248。
 * - 签到只认 App 会话（h5 会话调 user/signIn 一律 403 forbidden），
 *   所以必须全程走 android：android captchaId + android 请求头 + 33 位 App 设备码，
 *   这条路与 dna-builder 的 DNALogin 完全一致。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import CaptchaModal from '@/components/CaptchaModal.vue'
import {
  JJJ_CAPTCHA_ID_APP,
  JJJ_CAPTCHA_PAGE,
  JJJ_CAPTCHA_SANDBOX,
  jjjAvailable,
  type JjjCredential,
} from './jiaojiaojiao'

const props = defineProps<{ open: boolean; accountId?: string }>()
const emit = defineEmits<{ close: []; saved: [credential: JjjCredential] }>()
const { t } = useI18n()

const phone = ref('')
const code = ref('')
const devCode = ref('')
const sent = ref(false)
const cooldown = ref(0)
const busy = ref(false)
const verifying = ref(false)
// 人机验证场景必须用 App(android) 那套 captchaId：验证结果按场景签发，
// 拿 h5 场景的结果去发 App 通道的短信会被判 248。
const captchaId = ref(JJJ_CAPTCHA_ID_APP)
// 登录/发码通道：唯一目标是拿到能签到的 App 会话。
const channel = 'android' as const
// 三步登录器：① 人工验证 → ② 收短信 → ③ 登录并自动保存凭据。
const currentStep = computed(() => (sent.value ? (code.value ? 2 : 1) : 0))
let generation = 0
let timer: ReturnType<typeof setInterval> | undefined

const reset = () => {
  generation++
  clearInterval(timer)
  phone.value = ''
  code.value = ''
  devCode.value = ''
  sent.value = false
  cooldown.value = 0
  busy.value = false
  verifying.value = false
}
watch(() => [props.open, props.accountId], reset)
onBeforeUnmount(reset)

const markSent = () => {
  sent.value = true
  cooldown.value = 60
  clearInterval(timer)
  timer = setInterval(() => {
    cooldown.value = Math.max(0, cooldown.value - 1)
    if (!cooldown.value) clearInterval(timer)
  }, 1000)
  message.success(t('standalone.smsSent'))
}

const startCaptcha = async () => {
  if (!jjjAvailable()) {
    message.warning(t('standalone.jjjDesktopOnly'))
    return
  }
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    message.error(t('standalone.validPhone'))
    return
  }
  await openCaptcha()
}

/** 取 App(android) 场景下发的 captchaId 并打开验证；配置接口不可用时用本地兜底值。 */
const openCaptcha = async () => {
  try {
    const resolved = await window.bmatJjj!.captchaId(channel)
    if (typeof resolved === 'string' && resolved.trim()) captchaId.value = resolved.trim()
  } catch {
    captchaId.value = JJJ_CAPTCHA_ID_APP
  }
  verifying.value = true
}

/** 人工验证通过后，把官方 SDK 的原始 vJson 交给主进程发送短信。 */
const send = async (solution: Record<string, string>) => {
  verifying.value = false
  const current = generation
  busy.value = true
  try {
    // 保真透传：vJson 必须与 dna-builder 的 JSON.stringify(validate) 一模一样。
    const payload = solution.__vJson
      ? {
          phone: phone.value,
          vJson: solution.__vJson,
          devCode: devCode.value || undefined,
          channel,
        }
      : {
          phone: phone.value,
          validate: solution,
          devCode: devCode.value || undefined,
          channel,
        }
    const result = await window.bmatJjj!.sendSms(payload)
    if (current !== generation) return
    if (!result.ok) {
      const reason = (result.message || t('standalone.loginFailed')).replace(/\|248$/, '')
      message.error(
        /人机验证/.test(reason)
          ? reason
          : /参数错误|网络异常|业务异常|系统异常/.test(reason)
            ? `${reason}。${t('standalone.jjjSmsRejected')}`
            : reason
      )
      return
    }
    devCode.value = result.devCode || devCode.value
    markSent()
  } catch (cause) {
    if (current === generation) {
      message.error(cause instanceof Error ? cause.message : t('standalone.loginFailed'))
    }
  } finally {
    if (current === generation) busy.value = false
  }
}

const login = async () => {
  if (!/^\d{4,8}$/.test(code.value)) {
    message.error(t('standalone.validSmsCode'))
    return
  }
  const current = generation
  busy.value = true
  try {
    const result = await window.bmatJjj!.login({
      phone: phone.value,
      code: code.value,
      devCode: devCode.value || undefined,
    })
    if (current !== generation) return
    if (!result.ok) {
      const reason = result.message || t('standalone.loginFailed')
      message.error(/错误手机号|151/.test(reason) ? t('standalone.jjjPhoneMismatch') : reason)
      return
    }
    emit('saved', {
      token: result.token,
      devCode: result.devCode || devCode.value,
      refreshToken: result.refreshToken,
      channel: result.channel,
    })
    if (result.appSession === false) message.warning(t('standalone.jjjWebSessionWarning'))
    emit('close')
  } catch (cause) {
    if (current === generation) {
      message.error(cause instanceof Error ? cause.message : t('standalone.loginFailed'))
    }
  } finally {
    if (current === generation) {
      busy.value = false
      code.value = ''
    }
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="t('standalone.jjjSmsLoginTitle')"
    :confirm-loading="busy"
    :ok-button-props="{ disabled: !sent }"
    :ok-text="t('standalone.login')"
    @ok="login"
    @cancel="emit('close')"
  >
    <a-steps
      size="small"
      :current="currentStep"
      :items="[
        { title: t('standalone.jjjStepVerify') },
        { title: t('standalone.jjjStepSms') },
        { title: t('standalone.jjjStepLogin') },
      ]"
      class="jjj-sms-steps"
    />
    <a-alert type="info" show-icon :message="t('standalone.jjjSmsHint')" class="jjj-sms-hint" />
    <a-form layout="vertical" :model="{ phone, code }">
      <a-form-item name="phone" :label="t('standalone.phone')" required>
        <a-input
          v-model:value="phone"
          inputmode="tel"
          autocomplete="off"
          :maxlength="11"
          :disabled="busy"
        />
      </a-form-item>
      <a-form-item name="code" :label="t('standalone.smsCode')" required>
        <a-space wrap>
          <a-input
            v-model:value="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            :maxlength="8"
            :disabled="!sent || busy"
            @press-enter="login"
          />
          <a-button
            :loading="busy"
            :disabled="cooldown > 0 || verifying"
            @click="startCaptcha"
            >{{
              cooldown ? t('standalone.smsCooldown', { seconds: cooldown }) : t('standalone.jjjSendSms')
            }}</a-button
          >
        </a-space>
      </a-form-item>
    </a-form>
  </a-modal>
  <CaptchaModal
    :open="verifying && open"
    :version="4"
    :page="JJJ_CAPTCHA_PAGE"
    :sandbox="JJJ_CAPTCHA_SANDBOX"
    :captcha-id="captchaId"
    client-type="android"
    @close="verifying = false"
    @solved="send"
  />
</template>

<style scoped>
.jjj-sms-steps {
  margin-bottom: 18px;
}
.jjj-sms-hint {
  margin-bottom: 20px;
}
</style>
