/** 沙箱预加载：仅暴露皎皎角签到所需的最小 IPC 调用，不给页面任何文件系统/网络能力。 */
import { contextBridge, ipcRenderer } from 'electron'

// 官方网页登录窗口是异步的：主进程在用户登录成功后主动推送凭据。
// contextBridge 不代理返回值里的函数，因此用一个可替换的回调槽位代替订阅函数。
let webLoginListener: ((payload: unknown) => void) | null = null
ipcRenderer.on('bmat-jjj-web-login-result', (_event, payload: unknown) => {
  webLoginListener?.(payload)
})

contextBridge.exposeInMainWorld('bmatJjj', {
  check: (credential: unknown) => ipcRenderer.invoke('bmat-jjj-check', credential),
  sign: (credential: unknown) => ipcRenderer.invoke('bmat-jjj-sign', credential),
  sendSms: (payload: unknown) => ipcRenderer.invoke('bmat-jjj-send-sms', payload),
  login: (payload: unknown) => ipcRenderer.invoke('bmat-jjj-login', payload),
  captchaId: (channel?: string) => ipcRenderer.invoke('bmat-jjj-captcha-id', channel),
  // 凭据存主进程文件（DPAPI 加密），不再依赖按 origin 隔离的 localStorage。
  loadCredentials: () => ipcRenderer.invoke('bmat-jjj-credentials-load'),
  saveCredentials: (value: unknown) => ipcRenderer.invoke('bmat-jjj-credentials-save', value),
  startWebLogin: () => ipcRenderer.invoke('bmat-jjj-web-login-start'),
  cancelWebLogin: () => ipcRenderer.invoke('bmat-jjj-web-login-cancel'),
  setWebLoginListener: (callback: ((payload: unknown) => void) | null) => {
    webLoginListener = callback
  },
})
