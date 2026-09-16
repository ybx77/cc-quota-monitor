'use strict';
/** 渲染进程桥（contextIsolation: true） */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('cc', {
  // 数据
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: (reason) => ipcRenderer.invoke('state:refresh', reason),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // 价目表
  getPricing: () => ipcRenderer.invoke('pricing:get'),
  reloadPricing: () => ipcRenderer.invoke('pricing:reload'),

  // 历史
  getHistory: (sinceMs) => ipcRenderer.invoke('history:get', sinceMs),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // 诊断 / 导出
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  exportData: (kind) => ipcRenderer.invoke('export:data', kind),

  // 账号
  testAuth: (payload) => ipcRenderer.invoke('auth:test', payload),

  // 系统
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openUsagePage: () => ipcRenderer.invoke('open:usage-page'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  notifyTest: () => ipcRenderer.invoke('notify:test'),

  // 窗口 / 悬浮窗
  widgetAction: (action, value) => ipcRenderer.invoke('widget:action', { action, value }),
  getWidgetSettings: () => ipcRenderer.invoke('widget:get-settings'),
  showDashboard: (tab) => ipcRenderer.invoke('dashboard:show', tab),
  hideApp: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  registerHotkey: () => ipcRenderer.invoke('hotkey:register'),

  // 事件
  onState: on('state:update'),
  onTick: on('state:tick'),
  onNavigate: on('ui:navigate'),
  onTheme: on('ui:theme'),
});
