// 皎皎角（阿里云验证码 4）独立 iframe：与 CaptchaModal 复用 community-captcha 消息协议。
// SDK 本地化存放，避免依赖外部 CDN 的可用性；SDK 自身仍会连接 *.alicaptcha.com。
// 主进程已对本页移除 CSP 并去掉 Referer；所有关键节点都用 [BMAT] 前缀写进 desktop.log。
const config = JSON.parse(decodeURIComponent(location.hash.slice(1)))
const status = document.getElementById('status')
const CAPTCHA_ID = config.captchaId || 'b4b05ab6ca764ef4242e87cba47df9c8'
let failed = false
let instance

// 主进程只把以 [BMAT] 开头的控制台消息写入 desktop.log，这里是唯一可靠的诊断通道。
function report(message) {
  console.warn('[BMAT][皎皎角验证] ' + message)
}
function notify(data) {
  parent.postMessage(
    { kind: 'community-captcha', nonce: config.nonce, ...data },
    config.parentOrigin
  )
}
function fail(reason = 'sdk') {
  if (failed) return
  failed = true
  clearTimeout(loadTimer)
  report('失败：' + reason)
  status.textContent = '验证服务加载失败（' + reason + '），请关闭重试。'
  notify({ error: true, reason })
}
const loadTimer = setTimeout(() => fail('timeout:20s'), 20000)
window.addEventListener('securitypolicyviolation', event =>
  fail(`policy:${event.violatedDirective || '?'}:${event.blockedURI || '?'}`)
)
window.addEventListener(
  'error',
  event => {
    const target = event.target
    if (target && target !== window && (target.src || target.href)) {
      report('资源加载失败：' + (target.src || target.href))
    } else if (event.message) {
      report('脚本异常：' + event.message)
    }
  },
  true
)
window.addEventListener('unhandledrejection', event =>
  report('Promise 异常：' + String(event.reason && event.reason.message ? event.reason.message : event.reason))
)
window.addEventListener('pagehide', () => {
  clearTimeout(loadTimer)
  try {
    instance?.destroy()
  } catch {
    /* 页面卸载时 SDK 可能已释放 */
  }
})
notify({ loading: true })
report(
  '页面已加载，captchaId=' +
    CAPTCHA_ID +
    (config.clientType ? ' clientType=' + config.clientType : '') +
    ' UA=' +
    navigator.userAgent.slice(0, 72)
)

const script = document.createElement('script')
script.src = '/assets/alicom4.js'
script.onerror = () => fail('network:本地 SDK /assets/alicom4.js')
script.onload = () => {
  if (failed) return
  const initialize = window.initAlicom4
  if (typeof initialize !== 'function') return fail('sdk:initAlicom4 未定义')
  report('本地 SDK 已加载，开始初始化')
  try {
    initialize(
      {
        // 与 dna-builder 桌面端 initAlicom4 完全对齐：captchaId + product + https + clientType。
        // clientType 必须显式传 android/ios：官方 App 通道的验证结果按客户端类型签发，
        // 不传时 SDK 按桌面浏览器判成 web，服务端二次校验会拒（248 网络异常）。
        captchaId: CAPTCHA_ID,
        product: 'bind',
        https: true,
        ...(config.clientType ? { clientType: config.clientType } : {}),
        // SDK 初始化失败时默认会抛出笼统的「网络错误」，这里改为带错误码上报。
        onError: error =>
          fail(
            `sdk-error:${error?.code ?? ''}:${error?.msg ?? ''}:${JSON.stringify(error?.desc ?? {})}`
          ),
      },
      captcha => {
        if (failed) {
          try {
            captcha.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        instance = captcha
        captcha
          .onReady(() => {
            if (failed) return
            clearTimeout(loadTimer)
            status.textContent = '请完成下方验证'
            report('SDK ready，显示滑块')
            captcha.showCaptcha()
            notify({ ready: true })
          })
          .onSuccess(() => {
            const validate = captcha.getValidate()
            if (!validate) return fail('sdk:验证通过但 getValidate 为空')
            // 与官网 sendPhone() 完全一致：params.vJson = JSON.stringify(captchaObj.getValidate())。
            // 不注入 captcha_id、不把字段转成字符串，否则服务端校验会拒收。
            const vJson = JSON.stringify(validate)
            report(
              `人工验证通过，captchaId=${CAPTCHA_ID}，vJson 字段=${Object.keys(validate).join(',')}，长度=${vJson.length}`
            )
            // CaptchaModal 协议只传字符串值，故用单个键承载原始 JSON，由主进程直接放进请求体。
            if (!failed) notify({ solution: { __vJson: vJson } })
          })
          // 滑块失败时 SDK 会自行重置并允许重试，不能摧毁整个实例。
          .onFail(() => {
            status.textContent = '验证未通过，请重试'
            report('滑块未通过，等待重试')
          })
          .onError(error => fail('sdk-instance:' + JSON.stringify(error ?? {})))
      }
    )
  } catch (error) {
    fail('sdk-throw:' + (error?.message || String(error)))
  }
}
document.head.append(script)
