import type { SignAccountOut } from '@/api'

/** 共享的库洛币签到放在游戏结果之后；旧记录保留合并状态，不猜测分项成功。 */
export function getAccountSignSteps(account: SignAccountOut) {
  return (account.games ?? [])
    .flatMap(game => {
      const details = game.details?.length
        ? game.details
        : [
            {
              kind: 'combined' as const,
              status: game.status,
              reward: game.reward,
              reason: game.reason,
            },
          ]
      return details.map(detail => ({
        ...detail,
        game: game.game,
        account: detail.kind === 'community' ? '' : game.account,
        signedAt: game.signedAt,
      }))
    })
    .sort(
      (first, second) => Number(first.kind === 'community') - Number(second.kind === 'community')
    )
}

/** 历史结果缺少时间时视为尚未确认，不能推断成今天成功。 */
export function summarizeSignResults(accounts: SignAccountOut[], today: string) {
  let success = 0
  let failed = 0
  let pending = 0
  for (const account of accounts) {
    const steps = getAccountSignSteps(account)
    if (!steps.length) pending++
    for (const step of steps) {
      if (!today || step.signedAt?.slice(0, 10) !== today) {
        pending++
      } else if (step.status === '成功' || step.status === '已签到') {
        // 中文状态是后端协议，不能翻译后比较。
        success++
      } else {
        failed++
      }
    }
  }
  return { success, failed, pending }
}

/** 取本组今天已成功分项中最晚的执行时间，格式化为 yyyy年MM月dd日HH:mm。 */
export function formatLatestSuccessAt(accounts: SignAccountOut[], today: string): string {
  const times: string[] = []
  for (const account of accounts) {
    for (const step of getAccountSignSteps(account)) {
      if (!today || step.signedAt?.slice(0, 10) !== today) continue
      if (step.status !== '成功' && step.status !== '已签到') continue
      if (step.signedAt) times.push(step.signedAt)
    }
  }
  if (!times.length) return ''
  const latest = times.sort().at(-1) ?? ''
  // signedAt 形如 2026-11-07T21:30:00+08:00（ISO 8601 北京时间）
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(latest)
  if (!match) return ''
  const [, year, month, day, hour, minute] = match
  return `${year}年${month}月${day}日${hour}:${minute}`
}

export function getSignSummaryState(counts: ReturnType<typeof summarizeSignResults>) {
  if (counts.failed) return counts.success ? 'partial' : 'failed'
  if (counts.pending || !counts.success) return 'pending'
  return 'success'
}
