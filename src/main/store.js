'use strict';
/** 设置 / 历史采样 / 日志 的本地持久化（userData 目录，原子写入 + 防抖） */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WIDGET = {
  enabled: true,
  alwaysOnTop: true,
  clickThrough: false,
  locked: false,
  opacity: 0.94,
  scale: 1,
  compact: false,
  orientation: 'vertical',
  showFiveHour: true,
  showWeekly: true,
  showMonthly: true,
  showCountdown: true,
  showSpent: true,
  showSparkline: true,
  showHeader: true,
  accent: '#22d3ee',
  bounds: null,
  displayId: null,
  snapToEdges: true,
};

const DEFAULTS = {
  version: 1,
  apiBaseUrl: 'https://api.commandcode.ai',
  credentialsMode: 'auto', // auto | manual
  manualApiKey: '',
  autoRefresh: true,
  refreshIntervalSec: 60,
  smartRefresh: true, // 悬浮窗可见时用下面的更快间隔
  widgetRefreshIntervalSec: 20,
  requestTimeoutMs: 20000,
  historyEnabled: true,
  historyRetentionDays: 30,
  maxHistoryPoints: 20000,
  autoUpdatePricing: true,
  thresholds: {
    warn: 70,
    critical: 90,
    notifyOnWarn: true,
    notifyOnCritical: true,
    notifyOnReset: true,
    notifyOnExceeded: true,
  },
  theme: 'dark', // dark | light | system
  language: 'zh',
  launchAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  globalHotkey: 'CommandOrControl+Shift+Q',
  trayPercentWindow: 'fiveHour', // fiveHour | weekly | monthly
  widget: { ...DEFAULT_WIDGET },
  modelTable: {
    window: 'fiveHour',
    onlyGoat: false,
    profile: { freshInputTokens: 800, cacheReadTokens: 50000, outputTokens: 175 },
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.historyFile = path.join(dir, 'history.json');
    this.logFile = path.join(dir, 'app.log');
    fs.mkdirSync(dir, { recursive: true });
    this.settings = this.#loadSettings();
    this.history = this.#loadHistory();
    this._timer = null;
    this._historyTimer = null;
  }

  #loadSettings() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return deepMerge(DEFAULTS, json);
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  #loadHistory() {
    try {
      const json = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      return {
        samples: Array.isArray(json.samples) ? json.samples : [],
        daily: json.daily && typeof json.daily === 'object' ? json.daily : {},
      };
    } catch {
      return { samples: [], daily: {} };
    }
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.#writeSettings(), 250);
    return this.settings;
  }

  resetSettings() {
    this.settings = JSON.parse(JSON.stringify(DEFAULTS));
    this.#writeSettings();
    return this.settings;
  }

  #writeSettings() {
    try {
      atomicWrite(this.file, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      this.log('error', `settings write failed: ${err.message}`);
    }
  }

  /** 记录一次采样（同一分钟只留一个点） */
  addSample(sample) {
    if (!this.settings.historyEnabled) return;
    const s = this.history;
    const minute = Math.floor(sample.t / 60000);
    const last = s.samples[s.samples.length - 1];
    if (last && Math.floor(last.t / 60000) === minute) {
      s.samples[s.samples.length - 1] = { ...last, ...sample };
    } else {
      s.samples.push(sample);
    }
    const cutoff = Date.now() - this.settings.historyRetentionDays * 86400000;
    if (s.samples.length > 0 && s.samples[0].t < cutoff) {
      s.samples = s.samples.filter((x) => x.t >= cutoff);
    }
    if (s.samples.length > this.settings.maxHistoryPoints) {
      s.samples = s.samples.slice(-this.settings.maxHistoryPoints);
    }
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => this.#writeHistory(), 2000);
  }

  #writeHistory() {
    try {
      atomicWrite(this.historyFile, JSON.stringify(this.history));
    } catch (err) {
      this.log('error', `history write failed: ${err.message}`);
    }
  }

  getHistory(sinceMs) {
    const since = sinceMs ? Number(sinceMs) : 0;
    return { samples: this.history.samples.filter((s) => s.t >= since), daily: this.history.daily };
  }

  clearHistory() {
    this.history = { samples: [], daily: {} };
    this.#writeHistory();
  }

  log(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    try {
      fs.appendFileSync(this.logFile, `${line}\n`);
    } catch {}
    if (level === 'error') console.error(line);
  }

  readLog(limit = 300) {
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n');
      return lines.slice(-limit).join('\n');
    } catch {
      return '';
    }
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { Store, DEFAULTS, deepMerge };
