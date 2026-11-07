/** 5in1autocheckin 1.0：独立窗口、独立数据、单实例及后端清理。 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  type Session,
  type WebContents,
} from 'electron'
import { constants, createHash, publicEncrypt, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BackendService } from './backend.cjs'

const productName = '5in1autocheckin 1.0'
// 产品更名保留既有目录与应用 ID，保证原账号密文、单实例锁和快捷方式兼容。
const dataDirectory = process.env.COMMUNITY_DATA_DIR
  ? resolve(process.env.COMMUNITY_DATA_DIR)
  : join(app.getPath('appData'), 'BetterMASCommunity')
mkdirSync(dataDirectory, { recursive: true })
app.setName(productName)
app.setPath('userData', dataDirectory)
app.setAppUserModelId('independent.bettermas.community')
// 渲染进程（含皎皎角验证页 iframe）统一用「官方 App 内置 WebView」的身份。
// 阿里云验证码 risk 引擎会看 UA / 客户端类型：桌面 Electron 的 UA（带 Electron/xx、
// 自定义产品名）会被判成非官方客户端，App 场景的验证结果因此被服务端拒（248）。
// 这里直接照抄官方客户端 h5 请求头里的那条 UA（同样取自 dna-api 的 kf 请求头）。
const JJJ_APP_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 16; PLQ110 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.192 Mobile Safari/537.36CP6.TgzO Hero/1.1.4'
// 前端据此判定桌面专属能力。
app.userAgentFallback = JJJ_APP_WEBVIEW_UA

const backend = new BackendService()
const sessionFile = join(dataDirectory, 'desktop-session.json')
const smokeTest = process.argv.includes('--smoke-test')
let window: BrowserWindow | null = null
let origin = ''
let quitting = false

function log(message: string): void {
  try {
    appendFileSync(join(dataDirectory, 'desktop.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 日志失败不能阻断退出及后端清理。
  }
}

function openExternal(url: string): void {
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) {
      void shell.openExternal(url).catch(() => log('外部链接未能打开'))
    }
  } catch {
    log('已忽略无效链接')
  }
}

/** 只信任本机服务页面：导航与 IPC 都按 origin 比对，拒绝外域页面操作桌面能力。 */
function isTrustedUrl(value: string): boolean {
  if (!value || !origin) return false
  try {
    return new URL(value).origin === origin
  } catch {
    return false
  }
}

/** 窗口底色跟随系统主题，避免深色系统下启动瞬间先闪一帧白屏。 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff'
}

// 渲染进程兜底 CSP：与 Android 主页面策略（NativePolicy.contentPolicy）保持一致。
// 本机后端已为每个响应下发策略，因此这里只补后端没给的文档响应。
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://prod-alicdn-community.kurobbs.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function applyRendererCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}
    const hasPolicy = Object.keys(responseHeaders).some(
      key => key.toLowerCase() === 'content-security-policy'
    )
    // 只给顶层/子框架文档补策略：后端已下发的（含验证码 iframe 的放行）原样保留。
    const isDocument =
      details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    // 验证码页要直连阿里云 captcha / 图床，注入 'self' 策略会把 SDK 打不开，这里整体跳过。
    const isCaptchaFrame = /captcha/i.test(details.url)
    if (!hasPolicy && isDocument && !isCaptchaFrame) {
      responseHeaders['Content-Security-Policy'] = [RENDERER_CSP]
    }
    callback({ responseHeaders })
  })
}

/**
 * 统一的 IPC 入口守卫：只有本机服务页面（同源）发来的调用才会执行。
 * 渲染进程被导航到外域时，桥接仍存在，必须按发送方来源拦截。
 */
function handleTrusted<A extends unknown[], R>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: A) => Promise<R> | R
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const sender = event.senderFrame?.url ?? ''
    if (!isTrustedUrl(sender)) {
      log(`已拒绝来源未知的 IPC 请求 ${channel}：${sender || '未知来源'}`)
      throw new Error('untrusted sender')
    }
    return listener(event, ...(args as A))
  })
}

function showWindow(): void {
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }
  createWindow()
}

function createWindow(): void {
  const area = screen.getPrimaryDisplay().workAreaSize
  window = new BrowserWindow({
    title: productName,
    width: Math.min(1120, area.width),
    height: Math.min(780, area.height),
    minWidth: Math.min(780, area.width),
    minHeight: Math.min(540, area.height),
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  const webSession = window.webContents.session
  // 挂在真正加载页面的 session 上，确保验证页的网络策略一定生效。
  prepareJjjCaptchaSession(webSession)
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  webSession.setPermissionCheckHandler(() => false)
  window.webContents.on('console-message', details => {
    // 仅保存工具日志出口已脱敏的消息；第三方 SDK 的原始控制台输出不写入文件。
    if (details.message.startsWith('[BMAT]')) log(details.message)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    // 默认拦截：只有能解析且与本机服务同源的地址才放行；畸形 URL 也不会因解析抛异常而漏放。
    if (isTrustedUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })
  window.on('closed', () => {
    window = null
  })
  window.once('ready-to-show', () => {
    if (!smokeTest) window?.show()
  })
  void window.loadURL(origin)
  log('窗口页面加载完成')
  if (smokeTest) setTimeout(() => app.quit(), 1000)
}

/* ------------------------------------------------------------------ *
 * 皎皎角（二重螺旋官方社区）签到
 * 请求签名按 pa001024/dna-builder 的 packages/dna-api（MIT）中
 * build_signature130 / build_sa_header130 / rsa_encrypt 等价还原。
 * 只做「游戏签到 + 社区签到」，不做浏览、点赞、回复等社区日常任务。
 * ------------------------------------------------------------------ */
const JJJ_BASE = 'https://dnabbs-api.yingxiong.com/'
const JJJ_GAME_ID = 268
/**
 * 验证码 id 分两套，与 config/switchAll 按 source 下发的一致：
 * - h5 端（官网网页）：b4b05ab6…
 * - android 端（App/签到通道）：114d4e96…
 * vJson 里的 captcha_id 必须和发请求的 source 配对，配对错了服务端只会返回
 * code=248「网络异常，请稍后重试」，看起来像是网络问题，其实是通道不匹配。
 */
const JJJ_CAPTCHA_ID = 'b4b05ab6ca764ef4242e87cba47df9c8'
/** android 通道用的 captchaId 兜底值（与 config/switchAll 的 source:android 响应一致）。 */
const JJJ_CAPTCHA_ID_APP = '114d4e96cc4536050c7efaeb7e4f3c8c'
/** iOS 通道用的 captchaId 兜底值（与 config/switchAll 的 source:ios 响应一致）。 */
const JJJ_CAPTCHA_ID_IOS = 'a9d7b33f6daf81efea5e3dcea8d92bd7'
/** 官方皎皎角网页登录页：由用户本人登录，程序只在后台收集凭据。 */
const JJJ_WEB_ORIGIN = 'https://dnabbs.yingxiong.com'
const JJJ_WEB_LOGIN_URL = 'https://dnabbs.yingxiong.com/pc'
/** 官网 useDollarFetch 的请求头；H5 通道不带 tn/sa 签名，也不带 android 专属头。 */
const JJJ_H5_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded',
  source: 'h5',
  version: '3.11.1',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Origin: JJJ_WEB_ORIGIN,
  Referer: `${JJJ_WEB_ORIGIN}/`,
  Accept: '*/*',
}
/**
 * 后端是冻结的 exe，对所有页面下发 script-src 'self' 的严格 CSP。
 * 阿里云滑块 SDK 会按运行时下发的配置去 alicaptcha / alicdn / aliyun 等多个域名
 * 取脚本、图片并提交验证，白名单永远列不全，一旦漏掉就会报「网络错误」。
 * 因此只对皎皎角验证页这一张本地静态页移除 CSP，其它页面仍保持原来的严格策略。
 * 官方登录页本身带 no-referrer，这里同样去掉本地域 Referer，避免触发风控。
 */
const JJJ_CAPTCHA_URLS = [
  'https://*.alicaptcha.com/*',
  'https://*.aliyuncs.com/*',
  'https://*.alicdn.com/*',
  'https://*.aliyun.com/*',
  'https://*.aliapp.org/*',
]
const JJJ_HEADERS: Record<string, string> = {
  countrycode: 'CN',
  version: '1.3.2',
  versioncode: '12',
  source: 'android',
  lang: 'zh-Hans',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'okhttp/3.10.0',
}
/**
 * iOS 端请求头。服务端按 source 下发独立 captchaId，
 * 若 android 场景被拒（248），可用 iOS 通道作为另一条 App 会话路径。
 */
const JJJ_IOS_HEADERS: Record<string, string> = {
  ...JJJ_HEADERS,
  source: 'ios',
  'User-Agent': 'DoubleHelix/3 CFNetwork/3860.300.31 Darwin/25.2.0',
}

type JjjCredential = {
  token?: string
  devCode?: string
  refreshToken?: string
  /** 该 token 是在哪条通道登录得到的；签到请求必须沿用同一通道。 */
  channel?: JjjChannel
}
type JjjStep = { name: string; status: string; reward?: string; reason?: string }
type JjjResponse = { code?: number | string; msg?: string; data?: unknown; success?: boolean }
type JjjSignResult = {
  ok: boolean
  message: string
  token?: string
  signedAt: string
  steps: JjjStep[]
}

function jjjRandStr(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}

class JjjJavaRandom {
  private readonly multiplier = 0x5deece66dn
  private readonly addend = 0xbn
  private readonly mask = (1n << 48n) - 1n
  private seed: bigint

  constructor(seed: bigint = BigInt(Date.now())) {
    this.seed = (seed ^ this.multiplier) & this.mask
  }

  private next(bits: number): number {
    this.seed = (this.seed * this.multiplier + this.addend) & this.mask
    return Number(this.seed >> BigInt(48 - bits))
  }

  nextInt(bound: number): number {
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    }
    let bits = 0
    let value = 0
    do {
      bits = this.next(31)
      value = bits % bound
    } while (bits - value + (bound - 1) < 0)
    return value
  }
}

function jjjRandDigitStr(length: number): string {
  const chars = '01234567890123456789012345678901234567890123456789010123456789'
  const random = new JjjJavaRandom()
  let out = ''
  for (let i = 0; i < length; i++) out += chars.charAt(random.nextInt(0x3e))
  return out
}

function jjjSwapChars(text: string, i: number, j: number): string {
  if (i < 0 || j < 0 || i >= text.length || j >= text.length) return text
  const chars = text.split('')
  ;[chars[i], chars[j]] = [chars[j], chars[i]]
  return chars.join('')
}

function jjjSaHeader(rawSa: string, timestamp: number): string {
  let sa = rawSa
  sa = jjjSwapChars(sa, 1, 17)
  sa = jjjSwapChars(sa, 9, 20)
  sa = jjjSwapChars(sa, 15, 16)
  sa = jjjSwapChars(sa, 22, 27)
  const ts = String(timestamp)
  if (sa.length !== 30 || ts.length < 13) return sa
  let timeIndex = 0
  const out: string[] = []
  for (let i = 0; i < sa.length; i++) {
    if (i === 8 || i === 16) {
      out.push(ts.slice(timeIndex, timeIndex + 5))
      timeIndex += 5
    } else if (i === 22) {
      out.push(ts.slice(timeIndex, timeIndex + 3))
      timeIndex += 3
    }
    out.push(sa[i])
  }
  return out.join('')
}

function jjjMd5Upper(text: string): string {
  return createHash('md5').update(text).digest('hex').toUpperCase()
}

function jjjShuffleMd5(hex: string): string {
  if (hex.length <= 23) return hex
  const chars = hex.split('')
  for (const [i, j] of [
    [1, 13],
    [5, 17],
    [7, 23],
  ]) {
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

function jjjSignString(params: Record<string, string>, appKey: string): string {
  const pairs: string[] = []
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value !== '') pairs.push(`${key}=${value}`)
  }
  pairs.push(appKey)
  return pairs.join('&')
}

function jjjXorEncode(text: string, key: string): string {
  const bytes = Buffer.from(text, 'utf8')
  const keyBytes = Buffer.from(key, 'utf8')
  const out: string[] = []
  for (let i = 0; i < bytes.length; i++) {
    out.push(`@${(bytes[i] & 255) + (keyBytes[i % keyBytes.length] & 255)}`)
  }
  return out.join('')
}

function jjjRsaEncrypt(text: string, publicKeyBase64: string): string {
  const lines: string[] = []
  for (let i = 0; i < publicKeyBase64.length; i += 64) {
    lines.push(publicKeyBase64.slice(i, i + 64))
  }
  const pem = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`
  return publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(text, 'utf8')
  ).toString('base64')
}

let jjjPublicKey = ''
async function jjjGetPublicKey(): Promise<string> {
  if (jjjPublicKey) return jjjPublicKey
  const response = await fetch(`${JJJ_BASE}config/getRsaPublicKey`, {
    method: 'POST',
    headers: JJJ_HEADERS,
    signal: AbortSignal.timeout(10000),
  })
  const body = (await response.json()) as JjjResponse
  const keyPayload = (body.data ?? {}) as { key?: unknown }
  const key = typeof keyPayload.key === 'string' ? keyPayload.key : ''
  if (!key) throw new Error('皎皎角 RSA 公钥获取失败')
  jjjPublicKey = key
  return key
}

function jjjIsSuccess(body: JjjResponse): boolean {
  const code = Number(body.code)
  return code === 0 || code === 200
}

function jjjError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 北京时间 ISO 8601，与后端 signedAt 契约一致。 */
function jjjBeijingStamp(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
  return `${shifted.slice(0, 10)}T${shifted.slice(11, 16)}:00+08:00`
}

async function jjjRequest(
  url: string,
  payload: Record<string, string | number>,
  credential: JjjCredential,
  sign: boolean
): Promise<JjjResponse> {
  const channel: JjjChannel = credential.channel === 'ios' ? 'ios' : 'android'
  const headers: Record<string, string> = { ...jjjHeadersFor(channel) }
  if (credential.token) headers.token = credential.token
  if (credential.devCode) headers.devCode = credential.devCode
  if (sign) {
    const publicKey = await jjjGetPublicKey()
    const rk = jjjRandStr(16)
    const rawSa = jjjRandDigitStr(30)
    const signParams: Record<string, string> = {}
    for (const [key, value] of Object.entries(payload)) signParams[key] = String(value)
    if (credential.token) signParams.token = credential.token
    signParams.sa = rawSa
    const signValue = jjjShuffleMd5(jjjMd5Upper(jjjSignString(signParams, rk)))
    headers.tn = `${jjjRsaEncrypt(rk, publicKey)},${jjjXorEncode(signValue, rk)}`
    headers.sa = jjjSaHeader(rawSa, Date.now())
  }
  const body = new URLSearchParams(
    Object.entries(payload).map(([key, value]) => [key, String(value)])
  ).toString()
  const response = await fetch(JJJ_BASE + url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  try {
    const body = JSON.parse(text) as JjjResponse
    // 与 dna-builder 的 TimeBasicResponse 一致：部分接口把 data 包成 JSON 字符串。
    if (typeof body.data === 'string') {
      try {
        body.data = JSON.parse(body.data) as unknown
      } catch {
        /* 不是 JSON 就保留原文，由调用方判断 */
      }
    }
    return body
  } catch {
    return { code: -1, msg: `HTTP ${response.status}：响应不是 JSON` }
  }
}

/* ---------------- 官网 H5 登录通道 ---------------- *
 * 与线上 dnabbs.yingxiong.com 的 useDollarFetch 等价：
 * 请求头 source:h5 + Origin/Referer + devCode(64 位十六进制)，
 * 不带 tn/sa 签名；短信参数只有 mobile + vJson，登录参数 mobile + code + gameList。
 * 签名通道(build_signature130)仅供签到接口使用，不再用于登录。
 * --------------------------------------------------- */
/** 官网 generateUniqueID() 会把 32 字节随机数的十六进制串存在 localStorage.s_uuid。 */
let jjjH5DeviceCode = ''
/** 全角数字转半角、去空格/横线、去掉 +86 / 86 前缀，避免手输手机号带到服务端后格式不符。 */
function jjjNormalizePhone(input: string): string {
  let out = ''
  for (const ch of String(input ?? '')) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (codePoint >= 0xff10 && codePoint <= 0xff19) out += String.fromCharCode(codePoint - 0xff10 + 48)
    else out += ch
  }
  out = out.replace(/[\s\-()]/g, '')
  if (out.startsWith('+86')) out = out.slice(3)
  else if (out.startsWith('0086')) out = out.slice(4)
  else if (out.length === 13 && out.startsWith('86')) out = out.slice(2)
  return out
}

/** 日志里只写脱敏手机号，便于确认「填的到底是不是本人号」。 */
function jjjMaskPhone(input: string): string {
  const v = jjjNormalizePhone(input)
  if (v.length < 7) return `${v}（长度=${v.length}，格式可疑）`
  return `${v.slice(0, 3)}****${v.slice(-4)}（长度=${v.length}）`
}

function jjjEnsureH5DeviceCode(): string {
  if (!jjjH5DeviceCode) jjjH5DeviceCode = randomBytes(32).toString('hex')
  return jjjH5DeviceCode
}

/**
 * 官方 App 的设备码是「2 + 32 位十六进制」（33 位，见 DNABaseAPI.generateDeviceCode）。
 * 网页端是 64 位十六进制。两者不能混用，否则 App 通道的会话可能被当成网页会话。
 */
let jjjAndroidDeviceCode = ''
function jjjEnsureAndroidDeviceCode(): string {
  if (!jjjAndroidDeviceCode) {
    const chars = 'abcdef0123456789'
    let out = '2'
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
    jjjAndroidDeviceCode = out
  }
  return jjjAndroidDeviceCode
}

function jjjH5Success(body: JjjResponse): boolean {
  return body.success === true || Number(body.code) === 200 || Number(body.code) === 0
}

/* ---------------- 带签名的短信 / 登录通道 ---------------- *
 * 线上服务端对 user/getSmsCode、user/sdkLogin、user/signIn 等 signApiList
 * 接口强制校验 tn/sa 签名：缺签名一律回 code=10000「参数错误」，
 * 早期版本因此一直收不到短信。android 与 h5 的 sa 生成、参数过滤规则不同，
 * 签名必须与通道匹配；官网网页登录签发的 h5 会话也无法调用 App 签到接口，
 * 所以短信登录优先走 android 通道，拿到可用于签到的凭据。
 * ---------------------------------------------------------- */
function jjjH5RawSa(): string {
  const timestamp = String(Date.now())
  const chars = Array.from({ length: 30 }, () => '0123456789'[Math.floor(Math.random() * 10)])
  let index = 0
  for (let i = 0; i < 5; i++) chars[3 + i] = timestamp[index++]
  for (let i = 0; i < 6; i++) chars[18 + i] = timestamp[index++]
  for (let i = 0; i < 2; i++) chars[27 + i] = timestamp[index++]
  return chars.join('')
}

function jjjH5SaHeader(rawSa: string): string {
  const chars = rawSa.split('')
  for (const [i, j] of [
    [5, 19],
    [11, 22],
    [17, 28],
  ]) {
    const value = chars[i]
    chars[i] = chars[j]
    chars[j] = value
  }
  return chars.join('')
}

/** 官网 h5 版签名串只保留 truthy 值，与 build_h5_sign_string 一致。 */
function jjjH5SignString(params: Record<string, string>, appKey: string): string {
  const pairs: string[] = []
  for (const key of Object.keys(params).sort()) {
    if (params[key]) pairs.push(`${key}=${params[key]}`)
  }
  pairs.push(appKey)
  return pairs.join('&')
}

type JjjChannel = 'android' | 'ios' | 'h5'
/** 短信实际走通的通道；登录必须复用同一通道，避免验证码跨通道不互通。 */
/** 发短信时实际使用的设备码：登录要沿用同一个，服务端可能按「手机号+设备」找短信会话。 */
let jjjSmsDevice = ''

function jjjHeadersFor(channel: JjjChannel): Record<string, string> {
  if (channel === 'h5') return JJJ_H5_HEADERS
  if (channel === 'ios') return JJJ_IOS_HEADERS
  return JJJ_HEADERS
}

async function jjjSignedRequest(
  url: string,
  payload: Record<string, string | number>,
  credential: JjjCredential,
  channel: JjjChannel
): Promise<JjjResponse> {
  const headers: Record<string, string> = {
    ...jjjHeadersFor(channel),
    devCode: credential.devCode || jjjEnsureH5DeviceCode(),
  }
  if (credential.token) headers.token = credential.token
  const publicKey = await jjjGetPublicKey()
  const rk = jjjRandStr(16)
  const rawSa = channel === 'h5' ? jjjH5RawSa() : jjjRandDigitStr(30)
  const signParams: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload)) signParams[key] = String(value)
  if (credential.token) signParams.token = credential.token
  signParams.sa = rawSa
  const signValue = jjjShuffleMd5(
    jjjMd5Upper(channel === 'h5' ? jjjH5SignString(signParams, rk) : jjjSignString(signParams, rk))
  )
  headers.tn = `${jjjRsaEncrypt(rk, publicKey)},${jjjXorEncode(signValue, rk)}`
  headers.sa = channel === 'h5' ? jjjH5SaHeader(rawSa) : jjjSaHeader(rawSa, Date.now())
  const body = new URLSearchParams(
    Object.entries(payload).map(([key, value]) => [key, String(value)])
  ).toString()
  const response = await fetch(JJJ_BASE + url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as JjjResponse
    if (typeof parsed.data === 'string') {
      try {
        parsed.data = JSON.parse(parsed.data) as unknown
      } catch {
        /* 非 JSON 数据保持原文 */
      }
    }
    return parsed
  } catch {
    return { code: -1, msg: `HTTP ${response.status}：响应不是 JSON` }
  }
}

/**
 * config/switchAll 会按请求头 source 下发**不同**的 captchaId：
 * android → 114d4e96…，ios → a9d7b33f…，h5 → b4b05ab6…。
 * 服务端做二次校验时按请求通道取对应 id，用错通道的验证结果会被判成 248「网络异常」。
 * 所以验证码必须和真正发请求的通道配对，这里按通道解析。
 */
async function jjjResolveCaptchaId(channel: JjjChannel = 'android'): Promise<string> {
  try {
    const response = await fetch(`${JJJ_BASE}/config/switchAll`, {
      method: 'POST',
      headers: {
        ...jjjHeadersFor(channel),
        devCode: channel === 'h5' ? jjjEnsureH5DeviceCode() : jjjEnsureAndroidDeviceCode(),
      },
      body: '',
      signal: AbortSignal.timeout(10000),
    })
    const body = (await response.json()) as JjjResponse
    const data =
      body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {}
    const captcha = typeof data.captcha === 'string' ? data.captcha.trim() : ''
    if (captcha) {
      log(`[BMAT] 皎皎角验证码配置：使用服务端下发的 ${channel} captchaId`)
      return captcha
    }
  } catch (error) {
    log(`[BMAT] 皎皎角验证码配置获取失败，使用兜底值：${jjjError(error)}`)
  }
  if (channel === 'h5') return JJJ_CAPTCHA_ID
  return channel === 'ios' ? JJJ_CAPTCHA_ID_IOS : JJJ_CAPTCHA_ID_APP
}
handleTrusted('bmat-jjj-captcha-id', async (_event, channel?: JjjChannel) =>
  jjjResolveCaptchaId(channel === 'h5' ? 'h5' : channel === 'ios' ? 'ios' : 'android')
)

type JjjSmsResult = { ok: boolean; message: string; devCode: string }
type JjjLoginResult = {
  ok: boolean
  message: string
  token: string
  devCode: string
  refreshToken: string
  userName: string
  /** android/ios 通道登录的会话才能调用签到接口；官网网页登录的 h5 会话不行。 */
  appSession?: boolean
  /** 本次登录实际使用的通道，便于界面提示。 */
  channel?: JjjChannel
}

function jjjFailure(prefix: string): JjjLoginResult {
  return {
    ok: false,
    message: prefix,
    token: '',
    devCode: '',
    refreshToken: '',
    userName: '',
    appSession: false,
  }
}

/** 从官网 /user/sdkLogin 的 data 中提取凭据，兼容不同大小写与嵌套。 */
function jjjCredentialFromData(data: unknown, devCode: string): JjjLoginResult {
  const source: Record<string, unknown> =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const nested = source.data && typeof source.data === 'object'
    ? (source.data as Record<string, unknown>)
    : {}
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      for (const obj of [source, nested]) {
        const value = obj[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return ''
  }
  const token = pick('token', 'accessToken')
  log(`[BMAT] 皎皎角登录响应字段=${Object.keys(source).join(',')}（不含值）`)
  return {
    ok: !!token,
    message: token ? '登录成功' : '登录响应缺少 token',
    token,
    devCode,
    refreshToken: pick('refreshToken'),
    userName: pick('userName', 'nickName', 'nickname'),
  }
}

/**
 * vJson 是官方 SDK getValidate() 原样 JSON.stringify 的结果，不能改动任何字段类型。
 * 官方 App 发送时固定带 isCaptcha=1，这里与之对齐；captchaId 必须用 android 端的，
 * 否则服务端按通道取另一套密钥校验，会直接返回 248。
 */
/**
 * 发短信。
 *
 * 一条铁律（2026-11-08 定位）：**人机验证结果和发码通道必须严格配对，而且只能用一次**。
 * 服务端校验 vJson 时会拿「本次请求的 source 通道」对应的 captchaId 去核对，
 * 对不上就回 248「网络异常」；同一份 vJson 复用到另一条通道同样被判失败。
 * 所以这里只按目标通道发一次，绝不跨通道重试——之前的 151/248 混合失败，
 * 就是「h5 拿到的验证结果去试 android」造成的误判。
 *
 * 目标是拿到 App 会话，所以默认走 android 通道（与 dna-builder 完全一致：
 * android captchaId 场景 + android 请求头 + 33 位 App 设备码）。
 */
async function jjjSendSms(
  phone: string,
  vJson: string,
  devCode?: string,
  preferred: JjjChannel = 'android'
): Promise<JjjSmsResult> {
  const normalized = jjjNormalizePhone(phone)
  log(`[BMAT] 皎皎角短信：手机号=${jjjMaskPhone(phone)}，开始请求服务端`)
  phone = normalized
  const channel: JjjChannel = preferred === 'h5' ? 'h5' : 'android'
  // h5 通道沿用官网 64 位设备码；App 通道用官方客户端风格的 33 位设备码。
  const channelDevice = channel === 'h5' ? jjjEnsureH5DeviceCode() : devCode || jjjEnsureAndroidDeviceCode()
  const body = await jjjSignedRequest(
    'user/getSmsCode',
    { mobile: phone, vJson, isCaptcha: 1 },
    { devCode: channelDevice },
    channel
  )
  const message = body.msg || '验证码发送失败'
  log(`[BMAT] 皎皎角短信(${channel})服务端响应：code=${body.code ?? '?'} msg=${message}`)
  if (jjjH5Success(body)) {
    jjjSmsDevice = channelDevice
    log(
      `[BMAT] 皎皎角短信通道=${channel}，设备码长度=${channelDevice.length}（登录会沿用同一设备码）`
    )
    return { ok: true, message: '验证码已发送', devCode: channelDevice }
  }
  const hint = /网络异常|248/.test(message) ? `${message}|248` : message
  return { ok: false, message: hint, devCode: channelDevice }
}

async function jjjLogin(
  phone: string,
  code: string,
  devCode?: string
): Promise<JjjLoginResult> {
  const device = devCode || jjjEnsureAndroidDeviceCode()
  phone = jjjNormalizePhone(phone)
  log(`[BMAT] 皎皎角登录：手机号=${jjjMaskPhone(phone)}，验证码长度=${String(code).length}`)
  // 关键：无论短信是从哪条通道发出的，登录都先走 App(android) 通道——只有它换到的
  // token 才被允许调用签到接口（h5 会话调 user/signIn 一律 403 forbidden）。
  //
  // 151「错误手机号」的真正含义（2026-11-08 定位）：
  // 服务端按「手机号 + devCode」找待用的短信会话。发短信时用的是哪个设备码，
  // 登录就必须带同一个；换一个设备码过去，服务端找不到这条短信 → 回 151。
  // 所以这里先试「发短信时的设备码」，再试本通道自己的设备码。
  const devicesFor = (channel: JjjChannel): string[] => {
    const list: string[] = []
    const push = (value?: string) => {
      if (value && value.length >= 32 && !list.includes(value)) list.push(value)
    }
    push(jjjSmsDevice)
    push(channel === 'h5' ? jjjEnsureH5DeviceCode() : device)
    return list
  }
  const channels: JjjChannel[] = ['android', 'h5']
  // 官网登录页只发 {mobile, code, gameList}；dna-builder 额外带 loginType:1。
  // 2026-11-07T19:28 那次 h5 登录（不带 loginType）是成功的，之后加了 loginType 反而固定
  // 返回 151「错误手机号」，所以这里先按官网的写法试，再退回带 loginType 的写法。
  const variants: Array<{ label: string; loginType?: number }> = [
    { label: '无loginType' },
    { label: 'loginType=1', loginType: 1 },
  ]
  let lastMessage = '登录失败'
  for (const channel of channels) {
    for (const channelDevice of devicesFor(channel)) {
      const deviceLabel = channelDevice === jjjSmsDevice ? '短信设备码' : '通道设备码'
      for (const variant of variants) {
        const payload: Record<string, string | number> = {
          mobile: phone,
          code,
          gameList: JJJ_GAME_ID,
        }
        if (variant.loginType) payload.loginType = variant.loginType
        const body = await jjjSignedRequest('user/sdkLogin', payload, { devCode: channelDevice }, channel)
        log(
          `[BMAT] 皎皎角登录(${channel}/${deviceLabel}${channelDevice.length}位:${channelDevice.slice(0, 4)}…/${variant.label})服务端响应：code=${body.code ?? '?'} success=${body.success ?? '?'} msg=${body.msg ?? ''}`
        )
        if (jjjH5Success(body) && body.data && typeof body.data === 'object') {
          const result = jjjCredentialFromData(body.data, channelDevice)
          if (result.ok) {
            // 登录成功后立刻用「必须带身份」的接口自检一次：
            // App 会话应返回成功，网页会话固定「用户身份校验失败」。
            const probe = await jjjRequest(
              'user/login/log',
              {},
              { token: result.token, devCode: channelDevice, channel },
              false
            )
            const appSession = jjjIsSuccess(probe)
            log(
              `[BMAT] 皎皎角登录通道=${channel}（${channel === 'h5' ? '网页会话' : 'App 通道'}），会话自检=${appSession ? '通过（可签到）' : `未通过（${probe.msg || probe.code || '未知'}）`}`
            )
            return { ...result, devCode: channelDevice, appSession, channel }
          }
        }
        lastMessage = body.msg || lastMessage
      }
    }
  }
  return { ...jjjFailure(lastMessage), devCode: device }
}

const JJJ_WEB_SESSION_HINT =
  '当前凭据来自官网网页登录，服务端不允许网页会话执行签到；请改用「皎皎角短信登录」重新绑定一次。'

async function jjjCheck(credential: JjjCredential): Promise<{ ok: boolean; message: string }> {
  const body = await jjjRequest('user/login/log', {}, credential, false)
  if (jjjIsSuccess(body)) return { ok: true, message: '凭据有效' }
  const message = body.msg || '凭据无效或已过期'
  return { ok: false, message: /身份校验失败/.test(message) ? JJJ_WEB_SESSION_HINT : message }
}

async function jjjSign(credential: JjjCredential): Promise<JjjSignResult> {
  const signedAt = jjjBeijingStamp()
  const active: JjjCredential = { ...credential }
  const steps: JjjStep[] = []

  // token 过期时，若填了 refreshToken 就先续期。
  const probe = await jjjRequest('user/login/log', {}, active, false)
  if (!jjjIsSuccess(probe) && active.refreshToken) {
    const refreshed = await jjjRequest(
      'user/refreshToken',
      { refreshToken: active.refreshToken },
      active,
      true
    )
    const refreshedToken = (refreshed.data ?? {}) as { token?: unknown }
    if (
      jjjIsSuccess(refreshed) &&
      typeof refreshedToken.token === 'string' &&
      refreshedToken.token.trim().length > 10
    ) {
      active.token = refreshedToken.token.trim()
    }
  }

  try {
    const calendar = await jjjRequest(
      'encourage/signin/show',
      { gameId: JJJ_GAME_ID },
      active,
      true
    )
    if (!jjjIsSuccess(calendar) || !calendar.data) {
      steps.push({
        name: '皎皎角游戏签到',
        status: '失败',
        reason: calendar.msg || '获取签到日历失败',
      })
    } else {
      const data = calendar.data as {
        todaySignin?: boolean | number | string
        signinTime?: number | string
        period?: { id?: number }
        dayAward?: Array<{
          id?: number
          dayInPeriod?: number
          awardName?: string
          awardNum?: number
        }>
      }
      const awards = Array.isArray(data.dayAward) ? data.dayAward : []
      const signedCount = Number(data.signinTime ?? 0)
      const periodId = Number(data.period?.id ?? 0)
      const next = awards.find(item => Number(item.dayInPeriod) === signedCount + 1)
      const todayValue = data.todaySignin
      const alreadySignedToday =
        todayValue === true || todayValue === 1 || todayValue === '1' || todayValue === 'true'
      if (alreadySignedToday || !next) {
        steps.push({ name: '皎皎角游戏签到', status: '已签到', reward: '今日已签到' })
      } else {
        const result = await jjjRequest(
          'encourage/signin/signin',
          { dayAwardId: Number(next.id ?? 0), periodId, signinType: 1 },
          active,
          true
        )
        const ok = jjjIsSuccess(result)
        const already = !ok && /已签到|已经签到|重复/.test(String(result.msg ?? ''))
        steps.push({
          name: '皎皎角游戏签到',
          status: ok ? '成功' : already ? '已签到' : '失败',
          reward: ok ? `${next.awardName ?? '奖励'}×${next.awardNum ?? 1}` : '',
          reason: ok || already ? '' : result.msg || '签到失败',
        })
      }
    }
  } catch (error) {
    steps.push({ name: '皎皎角游戏签到', status: '失败', reason: jjjError(error) })
  }

  try {
    const result = await jjjRequest('user/signIn', { gameId: JJJ_GAME_ID }, active, true)
    const ok = jjjIsSuccess(result)
    const already = !ok && /已签到|已经签到|重复/.test(String(result.msg ?? ''))
    steps.push({
      name: '皎皎角社区签到',
      status: ok ? '成功' : already ? '已签到' : '失败',
      reason: ok || already ? '' : result.msg || '签到失败',
    })
  } catch (error) {
    steps.push({ name: '皎皎角社区签到', status: '失败', reason: jjjError(error) })
  }

  const identityRejected = steps.some(step => /身份校验失败/.test(step.reason || ''))
  return {
    ok: steps.some(step => step.status === '成功' || step.status === '已签到'),
    message: identityRejected
      ? JJJ_WEB_SESSION_HINT
      : steps.every(step => step.status === '失败')
        ? '皎皎角签到失败'
        : '',
    token: active.token,
    signedAt,
    steps,
  }
}

handleTrusted('bmat-jjj-check', async (_event, credential: JjjCredential) => {
  try {
    return await jjjCheck(credential ?? {})
  } catch (error) {
    log(`[BMAT] 皎皎角凭据校验异常：${jjjError(error)}`)
    return { ok: false, message: jjjError(error) }
  }
})

handleTrusted('bmat-jjj-sign', async (_event, credential: JjjCredential): Promise<JjjSignResult> => {
  try {
    const result = await jjjSign(credential ?? {})
    log(
      `[BMAT] 皎皎角签到：${result.steps
        .map(step => `${step.name}=${step.status}${step.reason ? `(${step.reason})` : ''}`)
        .join('，')}`
    )
    return result
  } catch (error) {
    const message = jjjError(error)
    log(`[BMAT] 皎皎角签到异常：${message}`)
    return { ok: false, message, signedAt: jjjBeijingStamp(), steps: [] }
  }
})

handleTrusted(
  'bmat-jjj-send-sms',
  async (
    _event,
    payload: {
      phone?: string
      validate?: Record<string, string>
      vJson?: string
      devCode?: string
      channel?: JjjChannel
    }
  ): Promise<JjjSmsResult> => {
    const phone = jjjNormalizePhone(String(payload?.phone || ''))
    // 优先用官方 SDK 原样的 vJson；兼容旧版逐字段传递。
    const vJson =
      typeof payload?.vJson === 'string' && payload.vJson.trim()
        ? payload.vJson
        : payload?.validate && Object.keys(payload.validate).length
          ? JSON.stringify(payload.validate)
          : ''
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return { ok: false, message: '请输入有效的中国大陆手机号', devCode: '' }
    }
    if (!vJson || vJson === '{}') {
      return { ok: false, message: '请先完成人工验证', devCode: '' }
    }
    try {
      let fields = '?'
      let captchaId = '?'
      try {
        const parsed = JSON.parse(vJson) as Record<string, unknown>
        fields = Object.keys(parsed).join(',')
        captchaId = String(parsed.captcha_id ?? '?')
      } catch {
        /* 非 JSON 时原样交给服务端 */
      }
      log(
        `[BMAT] 皎皎角短信：人工验证已通过，vJson ${vJson.length} 字节，字段=${fields}，captcha_id=${captchaId}，通道=${payload?.channel === 'android' ? 'android→h5' : 'h5'}，开始请求服务端`
      )
      const result = await jjjSendSms(
        phone,
        vJson,
        payload?.devCode,
        payload?.channel === 'h5' ? 'h5' : 'android'
      )
      log(`[BMAT] 皎皎角短信：${result.ok ? '已发送' : `服务端拒绝（${result.message}）`}`)
      return result
    } catch (error) {
      const message = jjjError(error)
      log(`[BMAT] 皎皎角短信发送异常：${message}`)
      return { ok: false, message, devCode: '' }
    }
  }
)

handleTrusted(
  'bmat-jjj-login',
  async (
    _event,
    payload: { phone?: string; code?: string; devCode?: string; channel?: JjjChannel }
  ): Promise<JjjLoginResult> => {
    const phone = jjjNormalizePhone(String(payload?.phone || ''))
    const code = String(payload?.code || '').trim()
    if (!/^1[3-9]\d{9}$/.test(phone) || !/^\d{4,8}$/.test(code)) {
      log(`[BMAT] 皎皎角登录：手机号/验证码格式不符，手机号=${jjjMaskPhone(phone)}`)
      return jjjFailure('手机号或验证码格式不正确')
    }
    try {
      const result = await jjjLogin(phone, code, payload?.devCode)
      // 登录响应含凭据，只记结果与服务端文案。
      log(`[BMAT] 皎皎角短信登录：${result.ok ? '成功' : `失败（${result.message}）`}`)
      return result
    } catch (error) {
      const message = jjjError(error)
      log(`[BMAT] 皎皎角短信登录异常：${message}`)
      return jjjFailure(message)
    }
  }
)

/* ---------------- 官方网页登录窗口 ---------------- *
 * 用户本人在官方页面完成手机号 + 人工验证 + 短信登录；程序不代做任何验证，
 * 只在后台捕获 /user/sdkLogin 的响应或官网写入的 token cookie，
 * 自动收集 token / dev_code / refreshToken 并回传给账号编辑页保存。
 * --------------------------------------------------- */
type JjjWebLoginResult = JjjLoginResult & { cancelled?: boolean }
let jjjWebLoginWindow: BrowserWindow | null = null
let jjjWebLoginSender: WebContents | null = null
let jjjWebLoginDone = true
let jjjWebLoginTimer: ReturnType<typeof setInterval> | undefined
/** 登录窗口刚关闭的短时间内，防止 window-all-closed 把整个程序带退出。 */
let jjjWebLoginClosedAt = 0

function jjjWebLoginFinish(result: JjjWebLoginResult): void {
  if (jjjWebLoginDone) return
  jjjWebLoginDone = true
  jjjWebLoginClosedAt = Date.now()
  if (jjjWebLoginTimer) clearInterval(jjjWebLoginTimer)
  jjjWebLoginTimer = undefined
  const sender = jjjWebLoginSender
  jjjWebLoginSender = null
  const win = jjjWebLoginWindow
  jjjWebLoginWindow = null
  try {
    sender?.send('bmat-jjj-web-login-result', result)
  } catch (error) {
    log(`[BMAT] 皎皎角登录结果回传失败：${jjjError(error)}`)
  }
  // 只关闭登录窗口本身：移除 closed 监听避免回环，绝不触碰主窗口，也绝不调用 app.quit。
  if (win && !win.isDestroyed()) {
    win.removeAllListeners('closed')
    win.close()
  }
  log(
    `[BMAT] 皎皎角官方网页登录：${result.cancelled ? '已取消' : result.ok ? '成功，凭据已收集' : `失败（${result.message}）`}`
  )
}

/** 官网登录后把 token / userInfo 写入 cookie 或 storage，这里统一读出并解析凭据。 */
async function jjjCollectWebCredential(win: BrowserWindow): Promise<JjjLoginResult | null> {
  const snapshot = (await win.webContents.executeJavaScript(
    `(() => {
      const read = storage => {
        try { return Object.entries(storage).map(([k, v]) => [k, String(v)]) } catch { return [] }
      }
      return JSON.stringify({
        cookie: document.cookie || '',
        s_uuid: (() => { try { return localStorage.getItem('s_uuid') || '' } catch { return '' } })(),
        storage: read(localStorage).concat(read(sessionStorage))
      })
    })()`,
    true
  )) as string
  if (typeof snapshot !== 'string') return null

  const parsed = JSON.parse(snapshot) as {
    cookie?: string
    s_uuid?: string
    storage?: [string, string][]
  }
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const merged: Record<string, unknown> = {}
  const absorb = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && item.length > 8) merged[key] = item
    }
  }
  const cookieText = parsed.cookie || ''
  for (const part of cookieText.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    const raw = decode(part.slice(index + 1).trim())
    if (name === 'token') merged.token = raw
    else if (/token/i.test(name) && !merged.token) merged.token = raw
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object') {
        absorb(value)
        if (value.data && typeof value.data === 'object') absorb(value.data)
      }
    } catch {
      /* 普通 cookie 值 */
    }
  }
  for (const [, raw] of parsed.storage || []) {
    const text = decode(raw)
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object') {
        absorb(value)
        for (const nested of Object.values(value as Record<string, unknown>)) {
          if (nested && typeof nested === 'object') absorb(nested)
        }
      }
    } catch {
      /* 非 JSON 存储项 */
    }
  }
  const device =
    typeof parsed.s_uuid === 'string' && parsed.s_uuid.length >= 16
      ? parsed.s_uuid
      : jjjEnsureH5DeviceCode()
  const token = typeof merged.token === 'string' ? merged.token.trim() : ''
  if (token.length < 10) return null
  log(`[BMAT] 皎皎角官网凭据字段=${Object.keys(merged).join(',')}（不含值）`)
  return {
    ok: true,
    message: '登录成功',
    token,
    devCode: device,
    // 官网 H5 会话只可读取社区数据，服务端禁止它调用 App 签到接口。
    appSession: false,
    refreshToken:
      typeof merged.refreshToken === 'string' ? (merged.refreshToken as string) : '',
    userName:
      typeof merged.userName === 'string'
        ? (merged.userName as string)
        : typeof merged.nickName === 'string'
          ? (merged.nickName as string)
          : '',
  }
}

/** 只在页面加载失败时显示可见提示，避免用户看到一片纯白。 */
function jjjShowWebLoginError(win: BrowserWindow, text: string): void {
  if (win.isDestroyed()) return
  const safe = text.replace(/[<>&]/g, '')
  const html =
    '<!doctype html><meta charset="utf-8"><title>皎皎角官方登录</title>' +
    '<div style="font:16px/1.8 system-ui,sans-serif;padding:48px;color:#333">' +
    '<h2>官方页面没能加载出来</h2><p>' +
    safe +
    '</p><p>请检查网络后关闭此窗口，回到「皎皎角」页签重新点一次登录；' +
    '也可以改用「短信登录（备用）」或手动填写 token。</p></div>'
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

async function openJjjWebLogin(sender: WebContents): Promise<{ ok: boolean; message: string }> {
  if (jjjWebLoginWindow && !jjjWebLoginWindow.isDestroyed()) {
    jjjWebLoginWindow.focus()
    return { ok: true, message: '' }
  }
  jjjWebLoginDone = false
  jjjWebLoginSender = sender
  const win = new BrowserWindow({
    title: '皎皎角官方登录',
    width: 1120,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 独立会话避免误取主窗口的历史凭据；官网静态资源较多，保留正常缓存。
      session: session.fromPartition('jjj-web-login'),
    },
  })
  jjjWebLoginWindow = win
  // 官网会按 UA 判断运行环境，Electron 默认 UA 可能被当成非浏览器而渲染空白。
  win.webContents.setUserAgent(JJJ_H5_HEADERS['User-Agent'])

  win.webContents.on('console-message', details => {
    // 新版 Electron 的 level 是数字（2=warning，3=error），旧版是字符串。
    const level = details.level as unknown
    if (String(level) === 'error' || Number(level) >= 2) {
      log(`[BMAT][皎皎角官网] ${details.message.slice(0, 220)}`)
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3 || jjjWebLoginDone) return
    log(`[BMAT] 皎皎角官网加载失败：code=${code} ${description} ${url}`)
    jjjShowWebLoginError(win, `${description}（错误码 ${code}）`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[BMAT] 皎皎角官网渲染进程退出：${details.reason}`)
  })

  // 不在导航前挂 CDP：Network.enable 会干扰主文档加载，正是白屏与
  // “target closed while handling command” 的来源。官网登录成功后把 token 写进
  // cookie / localStorage，直接定时读取即可，既不代做验证也更稳定。
  jjjWebLoginTimer = setInterval(() => {
    if (jjjWebLoginDone || win.isDestroyed()) return
    void (async () => {
      try {
        const credential = await jjjCollectWebCredential(win)
        if (credential?.ok) jjjWebLoginFinish(credential)
      } catch {
        /* 页面导航 / 刷新期间读取失败，下一轮继续 */
      }
    })()
  }, 1500)

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // 允许主进程自己加载的 data: 错误提示页。
    if (url.startsWith('data:') || url.startsWith('about:')) return
    try {
      if (new URL(url).origin !== JJJ_WEB_ORIGIN) {
        event.preventDefault()
        openExternal(url)
      }
    } catch {
      event.preventDefault()
    }
  })
  win.on('closed', () => {
    if (jjjWebLoginWindow === win) jjjWebLoginWindow = null
    jjjWebLoginFinish({ ...jjjFailure('已取消登录'), cancelled: true })
    // 关闭登录窗口后主程序必须继续存在。
    if (!quitting && (!window || window.isDestroyed())) showWindow()
  })
  void win.loadURL(JJJ_WEB_LOGIN_URL).catch(error => {
    log(`[BMAT] 皎皎角官网打开失败：${jjjError(error)}`)
    jjjShowWebLoginError(win, jjjError(error))
  })
  // 看门狗：HTTP 200 但脚本挂掉时页面会是一片纯白，这里给出可见提示而不是干等。
  setTimeout(() => {
    if (jjjWebLoginDone || win.isDestroyed()) return
    void (async () => {
      try {
        const state = (await win.webContents.executeJavaScript(
          `JSON.stringify({
            text: ((document.body && document.body.innerText) || '').trim().length,
            nuxt: (document.querySelector('#__nuxt') || {}).innerHTML?.length || 0
          })`,
          true
        )) as string
        const parsed = JSON.parse(state) as { text?: number; nuxt?: number }
        if ((parsed.text || 0) < 20 && (parsed.nuxt || 0) < 200) {
          log('[BMAT] 皎皎角官网页面内容为空，显示诊断提示')
          jjjShowWebLoginError(win, '页面脚本未渲染出内容（可能被网络或环境拦截）')
        }
      } catch {
        /* 页面仍在加载，忽略 */
      }
    })()
  }, 12000)
  log('[BMAT] 皎皎角官方登录窗口已打开（凭据读取=cookie/storage）')
  return { ok: true, message: '' }
}

handleTrusted('bmat-jjj-web-login-start', async event => openJjjWebLogin(event.sender))
handleTrusted('bmat-jjj-web-login-cancel', async () => {
  jjjWebLoginFinish({ ...jjjFailure('已取消登录'), cancelled: true })
  return { ok: true }
})

/** 只对皎皎角验证页移除 CSP / 对齐官网来源 / 记录网络失败；其它页面维持原策略。 */
let jjjSessionReady = false
function prepareJjjCaptchaSession(webSession: Session): void {
  if (jjjSessionReady) return
  jjjSessionReady = true
  webSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.includes('/assets/jjj-captcha.html')) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const headers: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(details.responseHeaders || {})) {
      const lower = key.toLowerCase()
      if (lower.startsWith('content-security-policy') || lower === 'x-content-security-policy') continue
      if (lower === 'cache-control') continue
      headers[key] = value
    }
    headers['Cache-Control'] = ['no-store']
    callback({ responseHeaders: headers })
  })
  webSession.webRequest.onBeforeSendHeaders({ urls: JJJ_CAPTCHA_URLS }, (details, callback) => {
    const headers: Record<string, string> = { ...(details.requestHeaders || {}) }
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'referer' || lower === 'origin') delete headers[key]
    }
    // 官网登录页并没有 no-referrer：SDK 请求会带官网域名的 Referer。
    // 本地验证页在 127.0.0.1，若不带或带本地来源，阿里云风控会按不同来源签发
    // 验证结果，服务端二次校验时就会回 248 / 参数错误。这里对齐官网来源。
    headers['Referer'] = `${JJJ_WEB_ORIGIN}/pc`
    callback({ requestHeaders: headers })
  })
  webSession.webRequest.onErrorOccurred({ urls: JJJ_CAPTCHA_URLS }, details => {
    log(`[BMAT] 皎皎角验证网络失败：${details.error} ${details.url}`)
  })
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)
  applyRendererCsp()
  // 系统深浅色切换时同步窗口底色。
  nativeTheme.on('updated', () => window?.setBackgroundColor(windowBackground()))
  origin = await backend.start({
    packaged: app.isPackaged,
    projectRoot: resolve(__dirname, '../..'),
    resourcesPath: process.resourcesPath,
    dataDirectory,
    onUnexpectedExit: () => {
      if (quitting) return
      dialog.showErrorBox(
        productName,
        '本地服务意外退出，请重新启动程序。详情见独立数据目录中的日志。'
      )
      app.quit()
    },
  })
  if (quitting) return
  writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, backendPid: backend.pid, origin }))
  log(`服务已就绪 pid=${backend.pid}`)
  createWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('window-all-closed', () => {
    // 登录窗口刚关闭（或仍在登录流程中）时，主窗口若已不在就恢复它，
    // 避免「关掉登录页把整个软件一起关掉」。用户平时主动关主窗口仍正常退出。
    if (!quitting && (!jjjWebLoginDone || Date.now() - jjjWebLoginClosedAt < 3000)) {
      showWindow()
      return
    }
    app.quit()
  })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void backend.stop().finally(() => {
      rmSync(sessionFile, { force: true })
      log('本地服务已关闭')
      app.quit()
    })
  })
  void app
    .whenReady()
    .then(start)
    .catch(error => {
      log(`启动失败：${error instanceof Error ? error.message : '未知错误'}`)
      dialog.showErrorBox(
        productName,
        '程序启动失败。请确认程序目录完整，并查看独立数据目录中的 desktop.log。'
      )
      app.quit()
    })
}
