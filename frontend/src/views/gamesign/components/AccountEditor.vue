<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message, Modal } from 'ant-design-vue'
import type { AccountData, AccountOut } from '@/api'
import { useCommunityApi, errorMessage } from '@/composables/useCommunityApi'
import { getLogger } from '@/utils/logger'
import QrLoginModal from '../QrLoginModal.vue'
import KuroSmsLoginModal from '../KuroSmsLoginModal.vue'
import JjjSmsLoginModal from '../JjjSmsLoginModal.vue'
import { useQrLogin, type QrLoginProvider } from '../useQrLogin'
import {
  jjjAvailable,
  loadJjjCredentials,
  writeJjjCredential,
  type JjjCredential,
  type JjjWebLoginResult,
} from '../jiaojiaojiao'

const props = defineProps<{ open: boolean; account: AccountOut | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()
const api = useCommunityApi()
const draft = ref<AccountData>({})
const baseline = ref('')
const saving = ref(false)
const loggingIn = ref(false)
const credentials = reactive({ phone: '', password: '' })
const provider = ref<QrLoginProvider>('miyoushe')
const kuroOpen = ref(false)
const jjjLoginOpen = ref(false)
const jjjDraft = reactive<JjjCredential>({ token: '', devCode: '', refreshToken: '' })
const jjjBaseline = ref('')
const jjjTesting = ref(false)
const tabs = [
  { key: 'MiyousheToken', label: 'miyoushe' },
  { key: 'SklandToken', label: 'skland' },
  { key: 'TaygedoToken', label: 'taygedo' },
  { key: 'KuroToken', label: 'kuro' },
] as const
const jjjSnapshot = () => JSON.stringify(jjjDraft)
const dirty = computed(
  () => JSON.stringify(draft.value) !== baseline.value || jjjSnapshot() !== jjjBaseline.value
)

watch(
  () => [props.open, props.account?.uid],
  async () => {
    if (props.open && props.account) {
      const uid = props.account.uid
      draft.value = { ...props.account.data }
      baseline.value = JSON.stringify(draft.value)
      // 凭据来自主进程文件，首次用到时要等载入完成（之后走内存缓存，立即返回）。
      const saved = (await loadJjjCredentials())[uid] || {}
      // 等待期间若已切到别的账号，就不能把上一个账号的凭据填进来。
      if (props.open && props.account?.uid === uid) {
        jjjDraft.token = saved.token || ''
        jjjDraft.devCode = saved.devCode || ''
        jjjDraft.refreshToken = saved.refreshToken || ''
        jjjDraft.channel = saved.channel
        jjjBaseline.value = jjjSnapshot()
      }
    }
    // 切换账号或关窗时复位短信登录弹窗，否则给另一个账号重开编辑会沿用它上次的打开状态。
    kuroOpen.value = false
    credentials.phone = ''
    credentials.password = ''
  },
  { immediate: true }
)

/** 短信登录成功后直接落本地凭据，与其它四个社区「登录后自动保存」的行为一致。 */
const onJjjLoginSaved = (credential: JjjCredential, webSession = false) => {
  jjjDraft.token = credential.token
  jjjDraft.devCode = credential.devCode || ''
  jjjDraft.refreshToken = credential.refreshToken || ''
  jjjDraft.channel = credential.channel
  jjjLoginOpen.value = false
  if (props.account) writeJjjCredential(props.account.uid, { ...jjjDraft })
  jjjBaseline.value = jjjSnapshot()
  if (webSession) message.warning(t('standalone.jjjWebSessionWarning'))
  else message.success(t('standalone.loginSuccess'))
  emit('saved')
}

/**
 * 官方网页登录：打开皎皎角官网，由用户本人完成手机号 + 人工验证 + 短信登录。
 * 程序不代做验证，只在后台接收主进程捕获到的 token / devCode / refreshToken 并落盘。
 */
const jjjWebLoggingIn = ref(false)
const startJjjWebLogin = async () => {
  if (!jjjAvailable()) {
    message.warning(t('standalone.jjjDesktopOnly'))
    return
  }
  jjjWebLoggingIn.value = true
  window.bmatJjj!.setWebLoginListener((payload: unknown) => {
    const result = payload as JjjWebLoginResult | null
    jjjWebLoggingIn.value = false
    window.bmatJjj?.setWebLoginListener(null)
    if (!result || result.cancelled) return
    if (!result.ok || !result.token) {
      message.error(result.message || t('standalone.loginFailed'))
      return
    }
    onJjjLoginSaved(
      {
        token: result.token,
        devCode: result.devCode,
        refreshToken: result.refreshToken,
      },
      result.appSession !== true
    )
  })
  try {
    const started = await window.bmatJjj!.startWebLogin()
    if (!started.ok) {
      message.error(started.message || t('standalone.loginFailed'))
      jjjWebLoggingIn.value = false
      window.bmatJjj?.setWebLoginListener(null)
    }
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : t('standalone.loginFailed'))
    jjjWebLoggingIn.value = false
    window.bmatJjj?.setWebLoginListener(null)
  }
}
const cancelJjjWebLogin = () => {
  void window.bmatJjj?.cancelWebLogin()
  window.bmatJjj?.setWebLoginListener(null)
  jjjWebLoggingIn.value = false
}
onBeforeUnmount(cancelJjjWebLogin)

const testJjj = async () => {
  if (!jjjAvailable()) {
    message.warning(t('standalone.jjjDesktopOnly'))
    return
  }
  if (!jjjDraft.token.trim()) {
    message.warning(t('standalone.loginRequired'))
    return
  }
  jjjTesting.value = true
  try {
    const result = await window.bmatJjj!.check({ ...jjjDraft })
    if (result.ok) message.success(t('standalone.jjjTestOk'))
    else message.error(`${t('standalone.jjjTestFail')}：${result.message}`)
  } finally {
    jjjTesting.value = false
  }
}

const syncCredential = async (
  field: 'MiyousheToken' | 'SklandToken' | 'TaygedoToken' | 'KuroToken',
  isCurrent: () => boolean = () => true
) => {
  const response = await api.listAccounts()
  if (!isCurrent()) return
  const fresh = response.data.find(item => item.uid === props.account?.uid)
  if (fresh) {
    draft.value[field] = fresh.data[field]
    const saved: AccountData = JSON.parse(baseline.value)
    saved[field] = fresh.data[field]
    baseline.value = JSON.stringify(saved)
    emit('saved')
  }
}
const qr = useQrLogin({
  getAccountId: () => props.account?.uid,
  onSaved: (_uid, _credential, isCurrent) =>
    syncCredential(provider.value === 'skland' ? 'SklandToken' : 'MiyousheToken', isCurrent),
  provider: () => provider.value,
  logger: getLogger('扫码登录'),
})
const startQr = (next: QrLoginProvider) => {
  provider.value = next
  void qr.start()
}
const close = () => {
  if (saving.value || loggingIn.value) return
  const finish = () => {
    qr.cancel()
    // 与扫码弹窗同样在这里收尾：关抽屉即复位短信登录弹窗，下次打开不会被残留状态顶出来。
    kuroOpen.value = false
    credentials.password = ''
    jjjLoginOpen.value = false
    emit('close')
  }
  if (dirty.value || credentials.password) {
    Modal.confirm({
      title: t('standalone.discardTitle'),
      content: t('standalone.discardHint'),
      onOk: finish,
    })
  } else finish()
}
const save = async () => {
  if (!props.account) return
  if (!draft.value.Name?.trim()) {
    message.error(t('standalone.requiredName'))
    return
  }
  saving.value = true
  try {
    await api.updateAccount({
      accountId: props.account.uid,
      data: { ...draft.value, Name: draft.value.Name.trim() },
    })
    writeJjjCredential(props.account.uid, { ...jjjDraft })
    baseline.value = JSON.stringify(draft.value)
    // 保存成功后直接 emit('close')，不经过 close()，这里同步复位短信登录弹窗。
    kuroOpen.value = false
    jjjBaseline.value = jjjSnapshot()
    message.success(t('standalone.saved'))
    emit('saved')
    emit('close')
  } catch (error) {
    message.error(errorMessage(error, t('standalone.saveFailed')))
  } finally {
    saving.value = false
  }
}
const passwordLogin = async () => {
  if (!props.account) return
  if (!credentials.phone || !credentials.password) {
    message.error(t('standalone.loginRequired'))
    return
  }
  loggingIn.value = true
  try {
    await api.loginTaygedo(props.account.uid, credentials.phone, credentials.password)
    await syncCredential('TaygedoToken')
    message.success(t('standalone.loginSuccess'))
  } catch (error) {
    message.error(errorMessage(error, t('standalone.saveFailed')))
  } finally {
    credentials.password = ''
    loggingIn.value = false
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="t('standalone.editAccount')"
    :width="620"
    destroy-on-close
    :closable="!saving && !loggingIn"
    :mask-closable="!saving && !loggingIn"
    @close="close"
  >
    <!-- 打开状态变化即重建输入控件，避免关闭动画中重开仍保留凭据的明文状态。 -->
    <a-form
      :key="`${account?.uid}-${open}`"
      layout="vertical"
      :model="draft"
      :disabled="saving || loggingIn"
    >
      <a-form-item name="Name" :label="t('standalone.accountName')" required
        ><a-input v-model:value="draft.Name" :maxlength="80"
      /></a-form-item>
      <a-form-item name="Enabled" :label="t('standalone.accountEnabled')"
        ><a-switch v-model:checked="draft.Enabled"
      /></a-form-item>
      <a-alert
        type="info"
        show-icon
        :message="t('standalone.credentialHint')"
        class="credential-hint"
      />
      <a-tabs>
        <a-tab-pane v-for="tab in tabs" :key="tab.key" :tab="t(`standalone.${tab.label}`)">
          <a-button
            v-if="tab.key === 'KuroToken'"
            class="credential-hint"
            @click="kuroOpen = true"
            >{{ t('standalone.kuroSmsLogin') }}</a-button
          >
          <a-form-item
            :name="tab.key"
            :label="t('standalone.token')"
            :extra="t('standalone.tokenHint')"
            ><a-input-password v-model:value="draft[tab.key]" autocomplete="off" spellcheck="false"
          /></a-form-item>
          <a-button
            v-if="tab.key === 'MiyousheToken' || tab.key === 'SklandToken'"
            @click="startQr(tab.key === 'SklandToken' ? 'skland' : 'miyoushe')"
            >{{ t('standalone.qrLogin') }}</a-button
          >
          <a-form-item
            v-if="tab.key === 'MiyousheToken'"
            name="CloudGenshinToken"
            :label="t('standalone.cloudToken')"
            :extra="t('standalone.cloudHint')"
            class="cloud-token"
            ><a-input-password v-model:value="draft.CloudGenshinToken" autocomplete="off"
          /></a-form-item>
          <template v-if="tab.key === 'TaygedoToken'">
            <a-divider orientation="left">{{ t('standalone.passwordLogin') }}</a-divider>
            <a-form-item :label="t('standalone.loginAccount')"
              ><a-input v-model:value="credentials.phone" autocomplete="off"
            /></a-form-item>
            <a-form-item :label="t('standalone.password')" :extra="t('standalone.loginHint')"
              ><a-input-password v-model:value="credentials.password" autocomplete="new-password"
            /></a-form-item>
            <a-button :loading="loggingIn" @click="passwordLogin">{{
              t('standalone.login')
            }}</a-button>
          </template>
        </a-tab-pane>
        <a-tab-pane key="Jiaojiaojiao" :tab="t('standalone.jiaojiaojiao')">
          <a-alert
            type="info"
            show-icon
            :message="t('standalone.jjjHint')"
            class="credential-hint"
          />
          <a-button
            type="primary"
            class="credential-hint"
            :disabled="!jjjAvailable()"
            @click="jjjLoginOpen = true"
            >{{ t('standalone.jjjSmsLogin') }}</a-button
          >
          <div class="jjj-login-secondary">
            <a-button
              type="link"
              size="small"
              :loading="jjjWebLoggingIn"
              :disabled="!jjjAvailable()"
              @click="startJjjWebLogin"
              >{{ t('standalone.jjjWebLogin') }}</a-button
            >
            <a-button
              v-if="jjjWebLoggingIn"
              type="link"
              size="small"
              danger
              @click="cancelJjjWebLogin"
              >{{ t('standalone.cancel') }}</a-button
            >
          </div>
          <a-alert
            v-if="jjjWebLoggingIn"
            type="info"
            show-icon
            :message="t('standalone.jjjWebLoginHint')"
            class="credential-hint"
          />
          <a-form-item :label="t('standalone.jjjToken')" :extra="t('standalone.jjjTokenHint')"
            ><a-input-password
              v-model:value="jjjDraft.token"
              autocomplete="off"
              spellcheck="false"
          /></a-form-item>
          <a-form-item :label="t('standalone.jjjDevCode')" :extra="t('standalone.jjjDevCodeHint')"
            ><a-input v-model:value="jjjDraft.devCode" autocomplete="off" spellcheck="false"
          /></a-form-item>
          <a-form-item
            :label="t('standalone.jjjRefreshToken')"
            :extra="t('standalone.jjjRefreshTokenHint')"
            ><a-input-password
              v-model:value="jjjDraft.refreshToken"
              autocomplete="off"
              spellcheck="false"
          /></a-form-item>
          <a-button :loading="jjjTesting" :disabled="!jjjAvailable()" @click="testJjj">{{
            t('standalone.jjjTest')
          }}</a-button>
        </a-tab-pane>
      </a-tabs>
    </a-form>
    <template #footer
      ><a-space
        ><a-button :disabled="saving || loggingIn" @click="close">{{
          t('standalone.cancel')
        }}</a-button
        ><a-button type="primary" :loading="saving" :disabled="loggingIn" @click="save">{{
          t('standalone.save')
        }}</a-button></a-space
      ></template
    >
  </a-drawer>
  <QrLoginModal
    :open="qr.visible.value"
    :status="qr.status.value"
    :status-text="qr.statusText.value"
    :qr-code-data-url="qr.qrCodeDataUrl.value"
    :loading="qr.loading.value"
    :provider="provider"
    @cancel="qr.cancel"
    @retry="qr.start"
  />
  <KuroSmsLoginModal
    :open="kuroOpen && open"
    :account-id="account?.uid"
    @close="kuroOpen = false"
    @saved="syncCredential('KuroToken')"
  />
  <JjjSmsLoginModal
    :open="jjjLoginOpen && open"
    :account-id="account?.uid"
    @close="jjjLoginOpen = false"
    @saved="onJjjLoginSaved"
  />
</template>

<style scoped>
.credential-hint {
  margin-bottom: 16px;
}
.jjj-login-secondary {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: -10px 0 16px -8px;
}
.cloud-token {
  margin-top: 24px;
}
</style>
