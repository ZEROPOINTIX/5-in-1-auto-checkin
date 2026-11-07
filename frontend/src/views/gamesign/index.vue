<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message, Modal } from 'ant-design-vue'
import { HolderOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import draggable from 'vuedraggable'
import type { AccountOut, SignAccountOut, StatusOut } from '@/api'
import { useCommunityApi, errorMessage } from '@/composables/useCommunityApi'
import { usePerformanceStore } from '@/stores/performance'
import {
  JJJ_PLATFORM,
  beijingToday,
  jjjAvailable,
  jjjConfigured,
  jjjToSignAccount,
  readJjjCredentials,
  readJjjResults,
  writeJjjCredential,
  writeJjjResults,
  type JjjCredential,
} from './jiaojiaojiao'
import AccountEditor from './components/AccountEditor.vue'
import SignResults from './components/SignResults.vue'
import MiyousheVerificationPanel from './MiyousheVerificationPanel.vue'

const { t } = useI18n()
const api = useCommunityApi()
const performance = usePerformanceStore()
const accounts = ref<AccountOut[]>([])
const status = ref<StatusOut | null>(null)
const loading = ref(false)
const adding = ref(false)
const signing = ref(false)
const ordering = ref(false)
const error = ref('')
const selected = ref<AccountOut | null>(null)
const editorOpen = ref(false)
const jjjCreds = ref<Record<string, JjjCredential>>({})
const jjjResults = ref<Record<string, SignAccountOut[]>>({})
const today = computed(() => status.value?.today || beijingToday())
const results = computed<Record<string, SignAccountOut[]>>(() => ({
  ...(status.value?.results ?? {}),
  ...jjjResults.value,
}))
const busy = computed(
  () => signing.value || status.value?.running === true || status.value?.activityRunning === true
)
let timer: ReturnType<typeof setTimeout> | undefined
let alive = true
const fields = [
  { field: 'SklandToken', name: 'skland' },
  { field: 'MiyousheToken', name: 'miyoushe' },
  { field: 'TaygedoToken', name: 'taygedo' },
  { field: 'KuroToken', name: 'kuro' },
] as const

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const [accountResponse, statusResponse] = await Promise.all([api.listAccounts(), api.status()])
    if (!alive) return
    accounts.value = accountResponse.data
    status.value = statusResponse
    jjjCreds.value = readJjjCredentials()
    jjjResults.value = readJjjResults(today.value)
  } catch (cause) {
    error.value = errorMessage(cause, t('standalone.loadFailed'))
  } finally {
    loading.value = false
  }
}
const poll = async () => {
  if (!alive) return
  if (!document.hidden && !loading.value) {
    try {
      status.value = await api.status()
    } catch (cause) {
      error.value = errorMessage(cause, t('standalone.loadFailed'))
    }
  }
  if (alive) timer = setTimeout(poll, performance.isLowPower ? 30000 : 10000)
}
onMounted(async () => {
  await load()
  if (alive) timer = setTimeout(poll, 10000)
})
onUnmounted(() => {
  alive = false
  clearTimeout(timer)
})
const edit = (account: AccountOut) => {
  selected.value = account
  editorOpen.value = true
}
const add = async () => {
  adding.value = true
  try {
    const response = await api.createAccount()
    await load()
    edit(response.data)
  } catch (cause) {
    message.error(errorMessage(cause, t('standalone.saveFailed')))
  } finally {
    adding.value = false
  }
}
const remove = (account: AccountOut) =>
  Modal.confirm({
    title: t('standalone.deleteTitle'),
    content: t('standalone.deleteHint'),
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await api.deleteAccount(account.uid)
        await load()
      } catch (cause) {
        message.error(errorMessage(cause, t('standalone.saveFailed')))
        throw cause
      }
    },
  })
const reorder = async () => {
  ordering.value = true
  try {
    await api.reorderAccounts(accounts.value.map(account => account.uid))
  } catch (cause) {
    message.error(errorMessage(cause, t('standalone.saveFailed')))
    await load()
  } finally {
    ordering.value = false
  }
}
/** 第五个社区：与后端四社区同一次点击并行执行，结果并入签到详情面板。 */
const runJjjSigns = async () => {
  if (!jjjAvailable()) return
  const day = today.value
  const credentials = readJjjCredentials()
  const targets = accounts.value.filter(
    account => account.data.Enabled !== false && jjjConfigured(account.uid, credentials)
  )
  if (!targets.length) {
    jjjResults.value = {}
    writeJjjResults(day, {})
    return
  }
  const group: SignAccountOut[] = []
  for (const account of targets) {
    const credential = credentials[account.uid]
    const alias = account.data.Name || account.uid
    try {
      const result = await window.bmatJjj!.sign(credential)
      if (result.token && result.token !== credential.token) {
        writeJjjCredential(account.uid, { ...credential, token: result.token })
      }
      group.push(jjjToSignAccount(alias, account.uid, result))
    } catch (cause) {
      group.push(
        jjjToSignAccount(alias, account.uid, {
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
          signedAt: `${day}T00:00:00+08:00`,
          steps: [],
        })
      )
    }
  }
  jjjResults.value = { [JJJ_PLATFORM]: group }
  writeJjjResults(day, jjjResults.value)
}
const sign = async () => {
  signing.value = true
  try {
    await Promise.all([
      api.sign().catch(cause => message.error(errorMessage(cause, t('standalone.signFailed')))),
      runJjjSigns(),
    ])
  } finally {
    signing.value = false
    await load()
  }
}
</script>

<template>
  <section class="community-sign-page">
    <header class="page-toolbar">
      <h1 class="page-title">{{ t('standalone.sign') }}</h1>
      <a-space wrap>
        <a-button :loading="loading" @click="load"
          ><ReloadOutlined />{{ t('standalone.refresh') }}</a-button
        >
        <a-button :loading="adding" :disabled="busy" @click="add"
          ><PlusOutlined />{{ t('standalone.addAccount') }}</a-button
        >
        <a-button type="primary" :loading="busy" :disabled="!accounts.length" @click="sign">{{
          t('standalone.signNow')
        }}</a-button>
      </a-space>
    </header>
    <a-alert v-if="error" type="error" show-icon :message="error" class="page-alert" />
    <h2 v-if="accounts.length" class="section-title">{{ t('standalone.accountList') }}</h2>
    <a-spin :spinning="loading">
      <a-empty
        v-if="!accounts.length && !loading"
        class="page-state"
        :description="t('standalone.noAccounts')"
      />
      <draggable
        v-else
        v-model="accounts"
        item-key="uid"
        handle=".account-handle"
        :disabled="busy || ordering"
        :animation="performance.isLowPower ? 0 : 150"
        class="account-list"
        @end="reorder"
      >
        <template #item="{ element: account }"
          ><div
            class="account-row industrial-panel"
            :class="{
              selected: editorOpen && selected?.uid === account.uid,
              'reduced-motion': performance.isLowPower,
            }"
          >
            <HolderOutlined class="account-handle" />
            <div class="account-info">
              <strong>{{ account.data.Name }}</strong>
              <div class="platforms">
                <span
                  v-for="item in fields"
                  :key="item.field"
                  :class="{ configured: account.data[item.field] }"
                  >{{ t(`standalone.${item.name}`) }} ·
                  {{
                    t(
                      account.data[item.field]
                        ? 'standalone.configured'
                        : 'standalone.emptyCredential'
                    )
                  }}</span
                >
                <span :class="{ configured: jjjConfigured(account.uid, jjjCreds) }"
                  >{{ t('standalone.jiaojiaojiao') }} ·
                  {{
                    t(
                      jjjConfigured(account.uid, jjjCreds)
                        ? 'standalone.configured'
                        : 'standalone.emptyCredential'
                    )
                  }}</span
                >
              </div>
            </div>
            <a-tag v-if="!account.data.Enabled">{{ t('standalone.disabled') }}</a-tag>
            <a-space
              ><a-button :disabled="busy" @click="edit(account)">{{
                t('standalone.edit')
              }}</a-button
              ><a-button danger :disabled="busy" @click="remove(account)">{{
                t('standalone.delete')
              }}</a-button></a-space
            >
          </div></template
        >
      </draggable>
    </a-spin>
    <MiyousheVerificationPanel :busy="busy" @completed="load" />
    <SignResults :results="results" :today="today" />
    <AccountEditor
      :open="editorOpen"
      :account="selected"
      @close="editorOpen = false"
      @saved="load"
    />
  </section>
</template>

<style scoped>
.page-alert {
  margin-bottom: 16px;
}
.account-list {
  display: grid;
  gap: 12px;
}
.account-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--ant-color-border-secondary);
  border-left: 3px solid var(--ant-color-primary-border);
  border-radius: 8px;
  background: var(--ant-color-bg-container);
  transition:
    background-color 200ms ease,
    border-color 200ms ease;
}
.account-row:hover,
.account-row.selected {
  background: var(--ant-color-primary-bg);
  border-color: var(--ant-color-primary-border);
}
.account-row.reduced-motion {
  transition: none;
}
.account-handle {
  color: var(--ant-color-text-tertiary);
  cursor: grab;
}
.account-handle:active {
  cursor: grabbing;
}
.account-info {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.account-info > strong {
  font-size: 16px;
}
.platforms {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
  color: var(--ant-color-text-tertiary);
  font-size: 12px;
}
.platforms .configured {
  color: var(--ant-color-text-secondary);
}
@media (max-width: 760px) {
  .account-row {
    flex-wrap: wrap;
    gap: 12px;
  }
  .account-info {
    min-width: calc(100% - 48px);
  }
}
</style>
