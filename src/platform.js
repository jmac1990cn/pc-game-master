'use strict';

/**
 * 平台启动器管理：
 *  - 检测各平台客户端进程是否在运行（Steam / Epic / 战网 / 育碧 / Xbox）
 *  - 找到平台启动器路径（注册表优先，最后兜底常见安装位置）
 *  - ensureRunning()：未运行则先把平台拉起来，等它就绪后再启动游戏
 *
 * 为什么需要它？
 *   很多平台游戏（Epic / 战网 / 育碧 / Xbox Game Pass）**必须**由平台客户端完成鉴权、
 *   挂载与 DRM 校验才能起来；客户端没开时直接跑 exe 往往黑屏、闪退或卡在初始界面。
 *   所以启动游戏前先确认平台在跑，没跑就先启动它。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const reg = require('./registry');

const LABELS = {
  steam: 'Steam',
  epic: 'Epic Games',
  battlenet: '战网',
  ubisoft: '育碧 Connect',
  xbox: 'Xbox',
  manual: '手动'
};

/** 各平台的客户端进程名（任一在跑即视为平台已启动） */
const PROCS = {
  steam: ['steam.exe', 'steamwebhelper.exe'],
  epic: ['EpicGamesLauncher.exe', 'EpicWebHelper.exe'],
  battlenet: ['Battle.net.exe', 'Battle.net Launcher.exe', 'Agent.exe'],
  ubisoft: ['UbisoftConnect.exe', 'UbisoftGameLauncher.exe', 'upc.exe'],
  xbox: ['GamingServices.exe', 'XboxPcApp.exe', 'GameBar.exe']
};

/* ----------------------------- 进程检测 ----------------------------- */

/** 用一次 tasklist 抓取全部进程名（小写），比逐个 filter 查快得多 */
let procCache = { at: 0, set: null };
const PROC_TTL = 1200;

function listProcesses() {
  const now = Date.now();
  if (procCache.set && now - procCache.at < PROC_TTL) return procCache.set;
  const set = new Set();
  if (process.platform !== 'win32') return set;
  try {
    const r = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000
    });
    if (r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) set.add(m[1].toLowerCase());
      }
    }
  } catch (e) {
    /* 读取失败：当作未知 */
  }
  procCache = { at: now, set };
  return set;
}

/** 平台客户端是否在运行 */
function isRunning(pf) {
  const names = PROCS[pf];
  if (!names || !names.length) return false;
  const set = listProcesses();
  return names.some(n => set.has(n.toLowerCase()));
}

/* ----------------------------- 启动器定位 ----------------------------- */

const STEAM_KEYS = [
  ['HKCU\\Software\\Valve\\Steam', 'SteamExe'],
  ['HKCU\\Software\\Valve\\Steam', 'SteamPath']
];

function findSteam() {
  for (const [key, val] of STEAM_KEYS) {
    const v = reg.readRegValue(key, val);
    if (!v) continue;
    if (/\.exe$/i.test(v) && fs.existsSync(v)) return v;
    const exe = path.join(v, 'steam.exe');
    if (fs.existsSync(exe)) return exe;
  }
  for (const c of ['C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files\\Steam\\steam.exe']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findEpic() {
  const uninstall = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EpicGamesLauncher';
  const uninstall32 = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EpicGamesLauncher';
  for (const key of [uninstall, uninstall32]) {
    const loc = reg.readRegValue(key, 'InstallLocation');
    if (loc) {
      const exe = path.join(loc, 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe');
      if (fs.existsSync(exe)) return exe;
      const exe2 = path.join(loc, 'EpicGamesLauncher.exe');
      if (fs.existsSync(exe2)) return exe2;
    }
  }
  for (const c of [
    'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
    'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findBattleNet(settings) {
  try {
    const scanner = require('./scanner');
    const p = scanner.detectBattleNetLauncher(settings || {});
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  for (const c of [
    'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
    'C:\\Program Files\\Battle.net\\Battle.net.exe'
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findUbisoft() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher',
    'HKLM\\SOFTWARE\\Ubisoft\\Launcher'
  ];
  for (const key of keys) {
    const dir = reg.readRegValue(key, 'InstallDir');
    if (!dir) continue;
    for (const exe of ['UbisoftConnect.exe', 'upc.exe', 'UbisoftGameLauncher.exe']) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const c of [
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe',
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe'
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 取平台启动器路径；xbox 返回 AUMID 伪路径（交给 explorer 打开） */
function findLauncher(pf, settings) {
  switch (pf) {
    case 'steam': return findSteam();
    case 'epic': return findEpic();
    case 'battlenet': return findBattleNet(settings);
    case 'ubisoft': return findUbisoft();
    case 'xbox': return 'shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App';
    default: return null;
  }
}

/* ----------------------------- 启动 ----------------------------- */

function startProcess(target) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (/^shell:/i.test(target)) {
    return spawn('explorer.exe', [target], opts);
  }
  return spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(target) });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 平台进程出现后的额外就绪等待：默认 15 秒，让客户端完成登录态 / DRM 服务初始化 */
const DEFAULT_READY_WAIT_SEC = 15;
const READY_WAIT_MS = DEFAULT_READY_WAIT_SEC * 1000;

/**
 * 纯函数：把设置里的「平台就绪等待秒数」归一化到 5~120 秒（导出便于单测）。
 * 策略是「宁可多等，一次成功」：等客户端把登录态/DRM 初始化完再启动游戏，
 * 而不是启动失败后再重试（重试会带来双开、音频抖动、界面闪回等副作用）。
 */
function resolveReadyWait(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return READY_WAIT_MS;
  return Math.min(120, Math.max(5, Math.round(n))) * 1000;
}

/**
 * 确保平台客户端已在运行。
 * 已运行 → 直接返回；未运行 → 启动启动器并轮询等待（默认最多 45 秒）。
 *
 * @param {string} pf 平台标识
 * @param {(msg:string)=>void} [onProgress] 进度回调（会推给界面显示）
 * @param {{timeout?:number, settings?:Object}} [opts]
 * @returns {Promise<{ok:boolean, alreadyRunning:boolean, started:boolean, message:string}>}
 */
async function ensureRunning(pf, onProgress = () => {}, opts = {}) {
  const label = LABELS[pf] || pf;
  if (!pf || pf === 'manual' || !PROCS[pf]) {
    return { ok: true, alreadyRunning: false, started: false, message: '' };
  }

  if (isRunning(pf)) {
    return { ok: true, alreadyRunning: true, started: false, message: `${label} 已在运行` };
  }

  const launcher = findLauncher(pf, opts.settings);
  if (!launcher) {
    return {
      ok: false, alreadyRunning: false, started: false,
      message: `未找到 ${label} 客户端路径，将直接尝试启动游戏`
    };
  }

  onProgress(`正在启动 ${label}…`);
  try {
    startProcess(launcher);
  } catch (e) {
    return { ok: false, alreadyRunning: false, started: false, message: `启动 ${label} 失败：${e.message}` };
  }

  // 轮询等待平台就绪（首次启动可能要 10~30 秒）
  const timeout = opts.timeout || 45000;
  const step = 1500;
  for (let waited = 0; waited < timeout; waited += step) {
    await delay(step);
    if (isRunning(pf)) {
      procCache.at = 0;                              // 清缓存，避免后续判断拿到旧结果
      // 进程出现 ≠ 会话就绪：客户端还要完成登录态 / DRM 服务初始化。
      // 按设置再等一段时间（默认 15 秒，可在设置里调大），宁可多等一次成功，
      // 也不要在会话未就绪时就把游戏启动起来 —— 那会表现为"启动后自退"。
      const waitMs = opts.readyWait !== undefined
        ? opts.readyWait
        : resolveReadyWait(opts.settings && opts.settings.platformReadyWaitSec);
      onProgress(`${label} 已启动，等待客户端就绪（约 ${Math.round(waitMs / 1000)} 秒）…`);
      await delay(waitMs);
      onProgress(`正在启动游戏…`);
      return { ok: true, alreadyRunning: false, started: true, message: `${label} 已启动` };
    }
  }
  procCache.at = 0;
  return {
    ok: false, alreadyRunning: false, started: false,
    message: `等待 ${label} 启动超时，仍将尝试直接启动游戏`
  };
}

/** 平台中文名（界面展示用） */
function labelOf(pf) { return LABELS[pf] || pf; }

/** 该平台的游戏是否需要“先启动平台” */
function needsPlatform(pf) {
  return !!PROCS[pf] && pf !== 'manual';
}

module.exports = {
  ensureRunning, isRunning, findLauncher, labelOf, needsPlatform, LABELS,
  READY_WAIT_MS, DEFAULT_READY_WAIT_SEC, resolveReadyWait,
};
