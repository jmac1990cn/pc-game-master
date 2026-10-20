'use strict';

/**
 * 本地配置存储：在 userData 下维护 config.json
 *  - games:    { [gameId]: { trainer, launchOrder, trainerDelay, customBackground, customCover,
 *                            customName, appid, saveDir, launchArgs, launchArgsMode, audioDevice } }
 *  - manualGames: 用户手动添加的游戏
 *  - playtime:   { [gameId]: { ms, last } } 本地游玩时长累计与最后游玩时间
 *  - settings:  扫描开关、额外扫描路径、音频默认输出通道等
 */
const fs = require('fs');
const path = require('path');

let userData = null;
let configPath = null;
let cache = null;

function init(app) {
  userData = app.getPath('userData');
  configPath = path.join(userData, 'config.json');
  // userData 一般由 Electron 保证存在，但首启动/目录被清理时可能缺失，
  // 若不建目录 save() 会一直静默失败（配置永远写不下去），这里兜底。
  try {
    fs.mkdirSync(userData, { recursive: true });
  } catch (e) {
    console.error('创建配置目录失败', e);
  }
  load();
}

function defaultConfig() {
  return {
    games: {},
    manualGames: [],
    metadata: {},            // 游戏基本信息库：{ [appid]: { name, nameEn, cover, background, logo, source, updatedAt } }
    playtime: {},            // 本地游玩时长：{ [gameId]: { ms, last } }
    hiddenGames: [],         // 用户隐藏的游戏 id 列表（扫描到的游戏可隐藏，手动游戏可删除）
    settings: {
      scanSteam: true,
      scanEpic: true,
      scanBattleNet: true,
      scanUbisoft: true,
      scanXbox: true,          // 扫描 Xbox / Game Pass 游戏（XboxGames 目录）
      scanXboxApps: true,      // 额外扫描 MSIX/Store 游戏包（以 MicrosoftGame.config 判定，非游戏不会混入）
      battleNetLauncher: '',   // 国服/国际战网启动器路径，留空自动探测
      extraScanPaths: [],      // 额外扫描目录（可选）
      openAtLogin: false,      // 开机自动启动
      steamGridDbKey: '',      // SteamGridDB API Key（免费申请，用于抓取徽标/高清背景，留空则用 Steam CDN 兜底）
      cacheImages: true,       // 把封面/背景/徽标缓存到本地，离线可用
      mode: 'fullscreen',      // 'fullscreen' 大屏模式 / 'desktop' 桌面模式
      trimMemory: true,        // 启动游戏后释放内存（卸图片缓存 + GC + 清会话缓存）
      minimizeOnLaunch: true,  // 启动游戏后自动最小化本窗口（让出资源给游戏，配合 trimMemory）
      restoreBigScreenOnExit: true, // 游戏进程结束后：窗口从最小化还原，并切回大屏模式
      startPlatformFirst: true,// 启动游戏前，若平台客户端未运行则先启动平台
      platformReadyWaitSec: 15,// 平台客户端刚被拉起时，等待其完成登录/DRM 初始化的秒数（宁可多等，一次成功）
      defaultAudioDevice: '',  // 默认音频输出通道端点 ID（空 = 不改动系统设置）
      switchAudioOnLaunch: true,// 启动游戏前按游戏配置切换音频通道，结束后切回默认
      focusGameOnLaunch: true, // 游戏窗口出现后自动激活到最前端（平台先起、游戏后起时也不会被压在后面）
      screensaverOnIdle: true, // 空闲一段时间后启动屏保，轮播已安装游戏的背景图
      screensaverIdleMin: 3    // 无操作多少分钟后启动屏保（默认 3 分钟）
    }
  };
}

function load() {
  try {
    if (fs.existsSync(configPath)) {
      cache = Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(configPath, 'utf8')));
      // 确保嵌套对象存在
      cache.games = cache.games || {};
      cache.manualGames = cache.manualGames || [];
      cache.metadata = cache.metadata || {};
      cache.playtime = cache.playtime || {};
      cache.hiddenGames = cache.hiddenGames || [];
      cache.settings = Object.assign(defaultConfig().settings, cache.settings || {});
    } else {
      cache = defaultConfig();
    }
  } catch (e) {
    cache = defaultConfig();
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败', e);
  }
}

function getConfig() {
  return cache || load();
}

function getSettings() {
  return getConfig().settings;
}

function setSettings(patch) {
  Object.assign(getConfig().settings, patch);
  save();
  return getConfig().settings;
}

/** 读取某个游戏的自定义配置（无则返回空对象） */
function getGameConfig(id) {
  return getConfig().games[id] || {};
}

/** 写入/更新某个游戏的自定义配置（合并） */
function setGameConfig(id, patch) {
  const g = getConfig().games;
  g[id] = Object.assign({}, g[id] || {}, patch);
  save();
  return g[id];
}

function getManualGames() {
  return getConfig().manualGames;
}

function addManualGame(game) {
  getConfig().manualGames.push(game);
  save();
  return game;
}

function removeGame(id) {
  const c = getConfig();
  if (c.manualGames.some(g => g.id === id)) {
    c.manualGames = c.manualGames.filter(g => g.id !== id);
  }
  delete c.games[id];
  if (c.playtime) delete c.playtime[id];
  save();
}

/* ----------------- 本地游玩时长（平台数据缺失时的兜底） ----------------- */

// 近两周窗口：首页「近两周常玩」用它筛出最近两周玩得最多的游戏。
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 400;   // 单款游戏保留的会话条数上限，防无限增长

function getPlaytime(id) {
  return getConfig().playtime[id] || null;
}

function getAllPlaytime() {
  return getConfig().playtime || {};
}

/**
 * 近两周（14 天）内的本地游玩时长（毫秒）。
 * 按会话开始时间判定是否落在窗口内；没有会话记录（老数据 / 平台数据）时返回 0。
 */
function getRecentMs(id, now = Date.now()) {
  const rec = getConfig().playtime[id];
  if (!rec || !Array.isArray(rec.sessions)) return 0;
  const cutoff = now - RECENT_WINDOW_MS;
  let sum = 0;
  for (const s of rec.sessions) {
    if (s && Number(s.t) >= cutoff) sum += Math.max(0, Number(s.ms) || 0);
  }
  return sum;
}

/**
 * 累加一次游玩时长。
 * @param {string} id 游戏 id
 * @param {number} ms 本次时长（毫秒）
 * @param {number} at 本次开始时间戳（同时作为最后游玩时间）
 *
 * 除了累计总量，还按会话（{t:开始时间, ms:时长}）记账，用于「近两周」窗口；
 * 写入时顺带裁掉超出 14 天的旧会话，避免 sessions 无限膨胀。
 */
function addPlaytime(id, ms, at) {
  const p = getConfig().playtime;
  const cur = p[id] || { ms: 0, last: 0 };
  const delta = Math.max(0, Number(ms) || 0);
  const ts = Number(at) || Date.now();
  const cutoff = Date.now() - RECENT_WINDOW_MS;

  let sessions = (Array.isArray(cur.sessions) ? cur.sessions : [])
    .filter(s => s && Number(s.t) >= cutoff);
  // 只有落在窗口内的这次才算「近两周」（补记很久以前的会话不再计入）
  if (delta > 0 && ts >= cutoff) sessions.push({ t: ts, ms: delta });
  if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);

  const next = {
    ms: Math.max(0, (cur.ms || 0) + delta),
    last: Math.max(cur.last || 0, ts),
    sessions,
  };
  p[id] = next;
  save();
  return next;
}

/** 只更新「最后游玩时间」（启动即记，即使这次没统计到时长） */
function touchLastPlayed(id, at) {
  const p = getConfig().playtime;
  const cur = p[id] || { ms: 0, last: 0 };
  const ts = Number(at) || Date.now();
  if (cur.last && cur.last >= ts) return cur;
  p[id] = { ms: cur.ms || 0, last: ts, sessions: cur.sessions || [] };
  save();
  return p[id];
}

function backgroundsDir() {
  const d = path.join(userData, 'backgrounds');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function imagesDir() {
  const d = path.join(userData, 'images');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ----------------- 游戏资源目录（封面/背景/徽标集中存放） ----------------- */

/**
 * 取某款游戏的资源目录：封面 / 背景 / 徽标等统一缓存在 userData 下。
 * 不写入游戏安装目录——避免污染游戏文件夹，也不会因安装目录只读（Xbox/MSIX）而失败。
 * installPath 参数保留是为了兼容既有调用方，现不再使用。
 */
function resolveAssetsDir(installPath, id) {
  const safe = String(id || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  const dir = path.join(userData, 'assets', safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ----------------- 游戏基本信息库（metadata） ----------------- */

function getMetadata(appid) {
  return getConfig().metadata[String(appid)] || null;
}

function setMetadata(rec) {
  getConfig().metadata[String(rec.appid)] = rec;
  save();
  return rec;
}

function metadataCount() {
  return Object.keys(getConfig().metadata || {}).length;
}

/* ----------------- 隐藏游戏（扫描到的游戏可隐藏，手动游戏可删除） ----------------- */

function getHiddenGames() {
  return getConfig().hiddenGames || [];
}

function isHidden(id) {
  return getHiddenGames().includes(id);
}

function hideGame(id) {
  const c = getConfig();
  if (!c.hiddenGames.includes(id)) {
    c.hiddenGames.push(id);
    save();
  }
  return c.hiddenGames;
}

function unhideGame(id) {
  const c = getConfig();
  c.hiddenGames = (c.hiddenGames || []).filter(x => x !== id);
  save();
  return c.hiddenGames;
}

function getUserDataDir() {
  return userData;
}

module.exports = {
  init,
  getConfig,
  getSettings,
  setSettings,
  getGameConfig,
  setGameConfig,
  getManualGames,
  addManualGame,
  removeGame,
  getPlaytime,
  getAllPlaytime,
  addPlaytime,
  getRecentMs,
  touchLastPlayed,
  backgroundsDir,
  imagesDir,
  resolveAssetsDir,
  getMetadata,
  setMetadata,
  metadataCount,
  getHiddenGames,
  isHidden,
  hideGame,
  unhideGame,
  getUserDataDir
};
