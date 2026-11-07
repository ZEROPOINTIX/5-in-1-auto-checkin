import type { SignAccountOut } from '@/api'

/** 皎皎角是第五个社区：凭据与结果留在本地，后端是冻结的 exe，不改动其数据契约。 */
export type JjjCredential = {
  token: string
  devCode?: string
  refreshToken?: string
  /** 登录时使用的通道；签到请求必须沿用同一通道，否则会被判身份校验失败。 */
  channel?: JjjChannel
}
export type JjjStep = { name: string; status: string; reward?: string; reason?: string }
export type JjjSignResult = {
  ok: boolean
  message: string
  token?: string
  signedAt: string
  steps: JjjStep[]
}
/** __vJson 是官方 SDK getValidate() 的原始 JSON，保真透传，不做类型转换。 */
export type JjjChannel = 'android' | 'ios' | 'h5'
export type JjjSmsPayload = {
  phone: string
  validate?: Record<string, string>
  vJson?: string
  devCode?: string
  channel?: JjjChannel
}
export type JjjSmsResult = { ok: boolean; message: string; devCode: string }
export type JjjLoginResult = {
  ok: boolean
  message: string
  token: string
  devCode: string
  refreshToken: string
  userName: string
  /** 只有 App 通道登录得到的会话才能签到；官网网页登录得到的是网页会话。 */
  appSession?: boolean
  /** 本次登录实际使用的通道。 */
  channel?: JjjChannel
}
export type JjjWebLoginResult = JjjLoginResult & { cancelled?: boolean }

declare global {
  interface Window {
    bmatJjj?: {
      check: (credential: JjjCredential) => Promise<{ ok: boolean; message: string }>
      sign: (credential: JjjCredential) => Promise<JjjSignResult>
      sendSms: (payload: JjjSmsPayload) => Promise<JjjSmsResult>
      login: (payload: {
        phone: string
        code: string
        devCode?: string
        channel?: JjjChannel
      }) => Promise<JjjLoginResult>
      captchaId: (channel?: 'android' | 'ios' | 'h5') => Promise<string>
      startWebLogin: () => Promise<{ ok: boolean; message: string }>
      cancelWebLogin: () => Promise<{ ok: boolean }>
      setWebLoginListener: ((callback: ((payload: unknown) => void) | null) => void)
    }
  }
}

export const JJJ_PLATFORM = '皎皎角'
/** 官网 config/switchAll 下发的 H5 端 captchaId。 */
export const JJJ_CAPTCHA_ID = 'b4b05ab6ca764ef4242e87cba47df9c8'
/**
 * android 端 captchaId。短信登录走 App 通道（只有 App 会话能签到），
 * 验证码必须用这一套，否则服务端按通道校验会返回 248「网络异常」。
 */
export const JJJ_CAPTCHA_ID_APP = '114d4e96cc4536050c7efaeb7e4f3c8c'
/** iOS 端 captchaId：android 场景被拒时的备用 App 通道。 */
export const JJJ_CAPTCHA_ID_IOS = 'a9d7b33f6daf81efea5e3dcea8d92bd7'
/** 冻结后端只开放 /assets 静态目录，验证页必须放在该目录下才可访问。 */
export const JJJ_CAPTCHA_PAGE = '/assets/jjj-captcha.html'
/** 阿里云滑块需要弹窗、表单和下载能力，默认的极验 sandbox 不够用。 */
export const JJJ_CAPTCHA_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'
const CREDENTIAL_KEY = 'bmat-jjj-credentials'
const RESULT_KEY = 'bmat-jjj-last-results'

export const jjjAvailable = () => typeof window !== 'undefined' && !!window.bmatJjj

export function readJjjCredentials(): Record<string, JjjCredential> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, JjjCredential>) : {}
  } catch {
    return {}
  }
}

export function writeJjjCredential(uid: string, credential: JjjCredential): void {
  const all = readJjjCredentials()
  if (!credential.token.trim()) delete all[uid]
  else {
    all[uid] = {
      token: credential.token.trim(),
      devCode: credential.devCode?.trim() || '',
      refreshToken: credential.refreshToken?.trim() || '',
      ...(credential.channel ? { channel: credential.channel } : {}),
    }
  }
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(all))
}

export function jjjConfigured(uid: string, credentials: Record<string, JjjCredential>): boolean {
  return !!credentials[uid]?.token?.trim()
}

/** 与后端 status.today 一致：北京时间 YYYY-MM-DD。 */
export function beijingToday(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function readJjjResults(today: string): Record<string, SignAccountOut[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESULT_KEY) || '{}')
    if (parsed?.today === today && parsed.results && typeof parsed.results === 'object') {
      return parsed.results as Record<string, SignAccountOut[]>
    }
  } catch {
    // 本地缓存损坏时按无结果处理即可。
  }
  return {}
}

export function writeJjjResults(
  today: string,
  results: Record<string, SignAccountOut[]>
): void {
  localStorage.setItem(RESULT_KEY, JSON.stringify({ today, results }))
}

/** 把主进程返回的简洁结构转成签到详情面板认识的结果形状。 */
export function jjjToSignAccount(
  alias: string,
  uid: string,
  result: JjjSignResult
): SignAccountOut {
  const games = result.steps.length
    ? result.steps.map(step => ({
        game: step.name,
        status: step.status,
        reward: step.reward || '',
        reason: step.reason || '',
        signedAt: result.signedAt,
      }))
    : [
        {
          game: '皎皎角签到',
          status: '失败',
          reward: '',
          reason: result.message || '未知错误',
          signedAt: result.signedAt,
        },
      ]
  return { account_alias: alias, account_uid: uid, games }
}
