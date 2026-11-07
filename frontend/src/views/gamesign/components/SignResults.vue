<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SignAccountOut } from '@/api'
import {
  formatLatestSuccessAt,
  getAccountSignSteps,
  getSignSummaryState,
  summarizeSignResults,
} from '../signSummary'
import { usePerformanceStore } from '@/stores/performance'

const props = defineProps<{ results: Record<string, SignAccountOut[]>; today: string }>()
const { t } = useI18n()
const performance = usePerformanceStore()
// 原始中文状态来自社区结果契约，不能翻译后参与判定。
const isSuccess = (status: string | undefined) => status === '成功' || status === '已签到'
type SummaryText = string | { prefix: string; day: string; suffix: string }
const summary = (accounts: SignAccountOut[]): SummaryText => {
  const counts = summarizeSignResults(accounts, props.today)
  if (!counts.success && !counts.failed) return t('standalone.todayPending')
  if (!counts.failed && !counts.pending) {
    const stamp = formatLatestSuccessAt(accounts, props.today)
    if (!stamp) return t('standalone.signAllSuccess')
    // 用占位符拆开 i18n 模板，把「xx日」单独包成高亮片段，其余文案不写死。
    const marker = '\u0001'
    const [before = '', after = ''] = t('standalone.todayAllSuccess', { time: marker }).split(marker)
    const parts = /^(\d{4}年\d{2}月)(\d{2}日)(\d{2}:\d{2})$/.exec(stamp)
    if (!parts) return t('standalone.todayAllSuccess', { time: stamp })
    return { prefix: before + parts[1], day: parts[2], suffix: parts[3] + after }
  }
  if (counts.failed && counts.success) return t('standalone.todayPartialFailure', counts)
  return t('standalone.todaySummary', counts)
}
const summaryStyles = {
  success: { color: 'success', label: 'standalone.signAllSuccess' },
  partial: { color: 'warning', label: 'standalone.signPartialFailure' },
  failed: { color: 'error', label: 'standalone.signFailedStatus' },
  pending: { color: 'default', label: 'standalone.signPendingStatus' },
} as const
const groups = computed(() =>
  Object.entries(props.results).map(([platform, accounts]) => ({
    platform,
    summary: summary(accounts),
    accounts: accounts.map(account => ({
      ...account,
      steps: getAccountSignSteps(account),
      summary: summaryStyles[getSignSummaryState(summarizeSignResults([account], props.today))],
    })),
  }))
)
</script>

<template>
  <section class="sign-results" :class="{ 'reduced-motion': performance.isLowPower }">
    <h2 class="section-title">{{ t('standalone.signResults') }}</h2>
    <a-empty
      v-if="!Object.keys(results).length"
      :description="t('standalone.noResult')"
      :image="undefined"
    />
    <a-collapse v-else :default-active-key="Object.keys(results)">
      <a-collapse-panel v-for="group in groups" :key="group.platform" :header="group.platform">
        <template #extra>
          <span class="platform-summary">
            <template v-if="typeof group.summary === 'string'">{{ group.summary }}</template>
            <template v-else>{{ group.summary.prefix }}<strong class="day-highlight">{{ group.summary.day }}</strong>{{ group.summary.suffix }}</template>
          </span>
        </template>
        <div v-for="account in group.accounts" :key="account.account_uid" class="result-account">
          <div class="result-account-header">
            <strong>{{ account.account_alias }}</strong>
            <a-tag :color="account.summary.color">{{ t(account.summary.label) }}</a-tag>
          </div>
          <p v-if="!account.steps.length" class="result-detail">
            {{ t('standalone.todayPending') }}
          </p>
          <div
            v-for="(step, index) in account.steps"
            :key="index"
            class="result-step"
            :data-kind="step.kind"
          >
            <div class="result-line">
              <a-tag :color="isSuccess(step.status) ? 'success' : 'error'">{{ step.status }}</a-tag>
              <span class="result-game">{{
                step.kind === 'community'
                  ? t('standalone.kuroCoinSign')
                  : step.kind === 'game'
                    ? t('standalone.gameSignTask', { game: step.game })
                    : step.game
              }}</span>
              <span v-if="step.account" class="result-role">{{ step.account }}</span>
            </div>
            <p v-if="step.reward" class="result-detail">{{ step.reward }}</p>
            <p v-if="step.reason" class="result-reason">{{ step.reason }}</p>
          </div>
        </div>
      </a-collapse-panel>
    </a-collapse>
  </section>
</template>

<style scoped>
.sign-results {
  margin-top: 24px;
}
.sign-results :deep(.ant-collapse) {
  border: 0;
  background: transparent;
}
.sign-results :deep(.ant-collapse > .ant-collapse-item) {
  background: var(--ant-color-bg-container);
  border: 1px solid var(--ant-color-primary-border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 12px;
}
.sign-results :deep(.ant-collapse-header) {
  font-weight: 600;
  transition: background-color 200ms ease;
}
.sign-results :deep(.ant-collapse-header:hover),
.sign-results :deep(.ant-collapse-header:focus-visible),
.sign-results :deep(.ant-collapse-item-active > .ant-collapse-header) {
  background: var(--ant-color-primary-bg);
}
.sign-results.reduced-motion :deep(.ant-collapse-header) {
  transition: none;
}
.platform-summary {
  color: var(--ant-color-primary);
  font-size: 12px;
  font-weight: 400;
}
/* 把日期单独做成琥珀色标签，方便一眼确认「今天到底签了没」。 */
.day-highlight {
  display: inline-block;
  margin: 0 2px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--ant-color-warning-bg, #fffbe6);
  color: var(--ant-color-warning-text, #d46b08);
  font-size: 14px;
  font-weight: 800;
  line-height: 1.5;
  box-shadow: inset 0 0 0 1px var(--ant-color-warning-border, #ffe58f);
}
.result-account + .result-account {
  margin-top: 16px;
}
.result-account-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.result-step {
  overflow-wrap: anywhere;
}
.result-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 12px;
  overflow-wrap: anywhere;
}
.result-game {
  font-weight: 500;
}
.result-role,
.result-detail {
  color: var(--ant-color-text-secondary);
}
.result-detail,
.result-reason {
  margin: 4px 0 0;
}
.result-reason {
  color: var(--ant-color-error);
}
</style>
