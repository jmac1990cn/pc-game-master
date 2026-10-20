'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

// 改名迁移：老版本「游戏管家」→「PC Game Master」。
// 必须在 require('./store') 之前执行——store 模块加载时就会触发 app.getPath('userData')
// 创建新目录（基于 productName），那时再搬迁旧数据就来不及了。
// 新用户数据目录即 appData 下与 productName 同名的文件夹。
(function migrateLegacyUserData() {
  try {
    const oldDir = path.join(app.getPath('appData'), '游戏管家');
    const newDir = path.join(app.getPath('appData'), 'PC Game Master');
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
      console.log('[migrate] 已从「游戏管家」迁移用户数据到「PC Game Master」：' + newDir);
    }
  } catch (e) {
    console.error('[migrate] 迁移旧用户数据失败（可忽略，不影响运行）：', e);
  }
})();

const store = require('./store');
const scanner = require('./scanner');
const launcher = require('./launcher');
const metadata = require('./metadata');
const netfetch = require('./netfetch');
const platform = require('./platform');
const savedir = require('./savedir');
const audio = require('./audio');
const playtime = require('./playtime');
const steamlaunch = require('./steamlaunch');
const winfocus = require('./winfocus');
const dlc = require('./dlc');
const { log } = require('./log');

// 内存优化：暴露 global.gc() 供启动游戏后主动回收；限制老生代上限，让 V8 更早回收而不是一路膨胀
// （必须在 app ready 之前设置）
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=512');

// 单实例锁：防止误开第二个实例把内存/扫描翻倍；重复启动时把已有窗口带回前台
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let lastGames = [];

/* ----------------------------- 全局异常兜底 -----------------------------
 * 默认情况下，主进程里任何未捕获异常都会被 Electron 弹成红色
 * 「A JavaScript error occurred in the main process」对话框，管家直接不可用。
 * 一次「修改器 spawn EACCES」就够触发它（v1.2.4 实机事故）。
 * 这里兜住：记日志 + 在界面上提示，程序继续跑。
 */
process.on('uncaughtException', (err) => {
  log('crash', 'uncaughtException: ' + ((err && err.stack) || err));
  try { pushLaunchStatus('后台发生异常，已记录日志（' + ((err && err.message) || err) + '）'); } catch (e) { /* 忽略 */ }
});

process.on('unhandledRejection', (reason) => {
  log('crash', 'unhandledRejection: ' + ((reason && reason.stack) || reason));
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0b0e14',
    title: 'PC Game Master',
    autoHideMenuBar: true,
    fullscreen: true,          // 默认进入 Playnite 风格全屏沉浸模式
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,              // 不需要拼写检查，省一份词库与相关内存
      backgroundThrottling: true,     // 窗口不可见时降低渲染频率
      v8CacheOptions: 'code'
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 后台闲置时只保留必要资源：窗口最小化/隐藏后清掉 HTTP 会话缓存（图片解码位图已在
  // 内存缓存里，clearCache 会连带释放），再触发一次主进程 GC。不动 UI 图片引用，
  // 恢复时无需重建、不闪屏。
  const backgroundTrim = () => {
    try {
      const web = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (web) { try { web.session.clearCache().catch(() => {}); } catch (e) {} }
    } catch (e) {}
    try { if (global.gc) global.gc(); } catch (e) {}
  };
  mainWindow.on('minimize', backgroundTrim);
  mainWindow.on('hide', backgroundTrim);

  // 从最小化恢复时，通知渲染层把卸载掉的图片重建回来
  const notifyRestore = () => {
    try { mainWindow.webContents.send('memory:restore'); } catch (e) {}
  };
  mainWindow.on('restore', notifyRestore);
  mainWindow.on('show', notifyRestore);
  // 开发时打开控制台：mainWindow.webContents.openDevTools();
}

/** 将本地绝对路径转为渲染进程可用的 file:// URL；非本地路径原样返回 */
function toLocalUrl(p) {
  if (!p) return p;
  if (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/')) {
    try {
      if (fs.existsSync(p)) return pathToFileURL(p).href;
    } catch (e) {}
  }
  return p;
}

/**
 * 全平台扫描。只在两处调用：应用启动时、界面「⟳ 刷新」按钮（都是明确的全量扫描时机）。
 * 结果缓存在 detectedCache，之后所有刷新（改设置、隐藏游戏、改封面、中文化完成…）
 * 都只做「合并」，不再触碰注册表 / 磁盘 / Appx 枚举——扫描是启动耗时和内存抖动的大头。
 */
let detectedCache = null;

function detectGames() {
  const settings = store.getSettings();
  const seen = new Set();
  const list = [];
  for (const g of scanner.scanAll(settings)) {
    if (!g || !g.id) continue;
    const key = String(g.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(g);
  }
  return list;
}

/** 把检测到的游戏 + 手动游戏 + 本地配置合并成最终列表（不过滤隐藏项） */
function buildAll() {
  // 扫描只在启动 / 手动刷新时进行；平时直接用上次扫描结果合并
  const detected = detectedCache !== null ? detectedCache : detectGames();
  const manual = store.getManualGames();

  // 合并前按 id 去重（自动扫描与手动添加可能撞同一 id），重复 id 会在首页渲染成两张卡片
  const seenIds = new Set();
  const all = [];
  for (const g of detected.concat(manual)) {
    if (!g || !g.id) continue;
    const key = String(g.id).toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    all.push(g);
  }

  // 平台游玩时长（Steam 本地 localconfig.vdf）；其它平台没有可离线读取的时长
  const steamPlay = playtime.readSteamPlaytime();
  // Steam 侧「启动选项」（同一个 localconfig.vdf，纯本地读取、不联网）：
  // 管理弹窗里显示 Steam 当前值 / 一键读取 / 保存时写回，见 steamlaunch.js
  const steamLaunchOpts = steamlaunch.readAll();

  const merged = all.map(g => {
    const cfg = store.getGameConfig(g.id) || {};
    const customBackground = cfg.customBackground ? toLocalUrl(cfg.customBackground) : null;
    const customCover = cfg.customCover ? toLocalUrl(cfg.customCover) : null;

    // 解析 appid：手动游戏的 appid 字段，或管理弹窗里补的 appid，或 Steam id 中的数字
    //
    // ⚠️ 契约：appid 对非 Steam 游戏**只影响资料与展示**（名称/封面/背景/徽标、手柄支持档位），
    //    绝不影响启动方式。启动只看 executable / launchCommand / platform（见 launcher.chooseLaunch），
    //    所以给 Epic / 战网 / 育碧 / Xbox / 手动游戏填 appid 后，它依旧按自己的路径启动，
    //    不会被改成 Steam 启动。playtime / savedir 里对 appid 的使用都额外用 platform==='steam' 门控。
    const appid = g.appid || (cfg && cfg.appid) || (g.platform === 'steam' && g.id && g.id.startsWith('steam:') ? g.id.split(':')[1] : null);
    // 用信息库（游戏基本信息库）富集：中文名 + 封面/背景/徽标
    const md = appid ? store.getMetadata(appid) : null;
    if (md) {
      if (md.name) g.name = md.name;              // 中文名优先
      if (md.cover) g.cover = md.cover;
      if (md.background) g.background = md.background;
      if (md.logo) g.logo = md.logo;
    }
    // 手动填写的显示名优先级最高（部分游戏 Steam 商店压根没有中文标题，只能手填）
    const customName = (cfg && cfg.customName) || '';
    if (customName) g.name = customName;

    // 游玩时长：平台数据优先，没有则用本地累计
    const localPt = store.getPlaytime(g.id) || { ms: 0, last: 0 };
    const steamPt = (g.platform === 'steam' && appid && steamPlay[String(appid)]) || null;
    const platformMinutes = steamPt ? (steamPt.minutes || 0) : 0;
    const localMinutes = Math.floor((localPt.ms || 0) / 60000);
    let playtimeMinutes = 0;
    let playtimeSource = null;
    if (platformMinutes > 0) { playtimeMinutes = platformMinutes; playtimeSource = 'steam'; }
    else if (localMinutes > 0) { playtimeMinutes = localMinutes; playtimeSource = 'local'; }
    // 最后游玩时间：平台时间戳（秒）与本地时间戳（毫秒）取较新者
    const lastPlayed = Math.max(
      localPt.last || 0,
      steamPt && steamPt.lastPlayed ? steamPt.lastPlayed * 1000 : 0
    );
    // 近两周游玩时长（分钟）：Steam 的 Playtime2wks 优先，否则用本地近 14 天会话累计。
    // 用于首页「近两周常玩」排序——纯本地读取，两种情况都不联网。
    const localRecentMs = store.getRecentMs(g.id);
    const platformRecentMinutes = steamPt ? (steamPt.minutes2wks || 0) : 0;
    let playtime2wks = 0;
    if (platformRecentMinutes > 0) playtime2wks = platformRecentMinutes;
    else if (localRecentMs > 0) playtime2wks = Math.floor(localRecentMs / 60000);

    // Steam 侧「启动选项」原文（仅 Steam 平台游戏；appid 对其它平台只补资料，不查启动项）
    const steamArgs = (g.platform === 'steam' && appid) ? (steamLaunchOpts[String(appid)] || '') : '';

    return Object.assign({}, g, {
      appid: appid || null,
      customName,                                 // 供管理弹窗回填
      nameEn: (md && md.nameEn) || '',            // 保留英文名，便于用英文搜索
      // 只渲染本地缓存图（file://）：md 落地后是本地路径，enrich 后台抓完即本地；
      // 远程 URL 一律不交给 <img>，否则游戏结束重建 / 列表刷新时会几十张重新联网加载。
      cover: customCover || (isLocalPath(g.cover) ? toLocalUrl(g.cover) : null),
      background: customBackground || (isLocalPath(g.background) ? toLocalUrl(g.background) : null),
      logo: (g.logo && isLocalPath(g.logo)) ? toLocalUrl(g.logo) : null,
      // 手柄支持档位（来自 Steam 商店，随信息库缓存；非 Steam 游戏没有数据源，保持 null）
      controllerSupport: (md && md.controllerSupport) || null,
      trainer: cfg.trainer || null,
      launchOrder: cfg.launchOrder || 'game-first',
      trainerDelay: cfg.trainerDelay != null ? cfg.trainerDelay : 0,
      hasCustomBg: !!cfg.customBackground,
      customBackgroundPath: cfg.customBackground || null,
      // 自定义封面（战网/育碧等无 appid 游戏没有在线封面，只能用户自指定）
      hasCustomCover: !!cfg.customCover,
      customCoverPath: cfg.customCover || null,
      // 存档目录（用户可手动指定；未指定时由 savedir 模块自动探测）
      saveDir: cfg.saveDir || null,
      // 自定义启动选项（cfg = 管理弹窗里保存的；g.launchArgs = 手动添加时填的，
      // 模拟器游戏靠它把「这款游戏的启动参数」传给模拟器本体 exe；
      // 都没有则用 Steam 里已设置的启动项兜底 —— 用户可能只在 Steam 侧填过）
      launchArgs: cfg.launchArgs || g.launchArgs || steamlaunch.toLocalArgs(steamArgs),
      steamLaunchOptions: steamArgs,              // Steam 侧原文（界面显示「Steam 启动项：…」）
      launchArgsMode: cfg.launchArgsMode === 'ask' ? 'ask' : 'normal',
      // 指定音频输出通道（空 = 跟随设置里的默认通道）
      audioDevice: cfg.audioDevice || null,
      // 游玩时长与最后游玩
      playtimeMinutes,
      playtimeSource,
      playtime2wks,                               // 近两周游玩时长（分钟）
      playtimeMs: (localPt.ms || 0),
      lastPlayed: lastPlayed || 0,
      isManual: g.platform === 'manual'
    });
  });
  merged.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return merged;
}

/**
 * 主页排序（最多 5 个席位，同一款游戏绝不重复占位）：
 *   第 1 位 ── 最后游玩的游戏（lastPlayed 最大）
 *   第 2、3 位 ── 近两周游玩时长最多的两款（playtime2wks）
 *   第 4、5 位 ── 总游玩时长最多的两款（playtimeMinutes）
 * 其余保持字母序。完全没有游玩记录时维持原样，避免新用户看到「随机」顺序。
 */
function applyHomeOrder(merged) {
  const withLast = merged.filter(g => g.lastPlayed > 0);
  if (!withLast.length) return merged;

  const picked = [];
  const pickedIds = new Set();
  const take = (g) => {
    if (g && !pickedIds.has(g.id)) { picked.push(g); pickedIds.add(g.id); }
  };

  // 1) 最后游玩
  let recent = null;
  for (const g of merged) {
    if (g.lastPlayed > 0 && (!recent || g.lastPlayed > recent.lastPlayed)) recent = g;
  }
  take(recent);

  // 2) 近两周游玩时长最多的两款（跳过已入选的）
  merged
    .filter(g => !pickedIds.has(g.id) && g.playtime2wks > 0)
    .sort((a, b) => b.playtime2wks - a.playtime2wks || b.lastPlayed - a.lastPlayed)
    .slice(0, 2)
    .forEach(take);

  // 3) 总游玩时长最多的两款（继续跳过已入选的）
  merged
    .filter(g => !pickedIds.has(g.id) && g.playtimeMinutes > 0)
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || b.lastPlayed - a.lastPlayed)
    .slice(0, 2)
    .forEach(take);

  const tail = merged.filter(g => !pickedIds.has(g.id));
  return picked.concat(tail);
}

/** 应用“隐藏”设置，过滤掉用户隐藏的游戏 */
function buildGames() {
  const hidden = new Set(store.getHiddenGames());
  return applyHomeOrder(buildAll().filter(g => !hidden.has(g.id)));
}

/**
 * 刷新游戏列表。默认只「合并」（读缓存 + 本地配置，毫秒级）；
 * opts.rescan=true 时才做全平台扫描——仅限应用启动和界面「⟳ 刷新」按钮。
 */
function refreshCache(opts = {}) {
  if (opts.rescan || detectedCache === null) detectedCache = detectGames();
  lastGames = buildGames();
  return lastGames;
}

/** 取某个 appid 对应游戏的资源目录（封面/背景/徽标统一缓存在 userData 下） */
function assetDirForAppid(appid) {
  const g = lastGames.find(x => x && x.appid && String(x.appid) === String(appid));
  return store.resolveAssetsDir(null, g ? g.id : `appid-${appid}`);
}

/**
 * 开机自启（登录时自动启动管家）。
 * 管家以普通权限（asInvoker）运行、用户级安装，故直接用 Electron 自带的 app.setLoginItemSettings：
 * 它在 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写入登录项，登录时静默拉起、不弹 UAC，
 * 最朴素也最可靠。升级自 v1.2.20（曾用任务计划程序）若残留旧任务，这里顺手清掉，避免它再尝试提权自启。
 */
function applyLoginItem(settings) {
  try {
    // 清掉旧版（v1.2.20）用任务计划程序建的自启任务，避免残留干扰（失败忽略）
    try { spawnSync('schtasks', ['/Delete', '/TN', 'GameLauncherAutoStart', '/F'], { windowsHide: true }); } catch (e) { /* 忽略 */ }
    // 标准登录项自启：打包后写 HKCU Run，普通权限下登录静默启动（开发模式不写）
    app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin && app.isPackaged });
  } catch (e) {
    console.error('设置开机自启失败', e);
  }
}

/* ----------------------------- 游戏名中文化（后台） ----------------------------- */

let localizing = false;
const nameMiss = new Map();          // appid -> 上次失败时间戳：只短期跳过，网络恢复后会自动重试
const NAME_MISS_TTL = 2 * 60 * 1000;
let lastLocalize = { at: 0, updated: 0, total: 0, missing: 0, networkOk: true };

function missRecently(appid) {
  const t = nameMiss.get(String(appid));
  if (!t) return false;
  if (Date.now() - t > NAME_MISS_TTL) { nameMiss.delete(String(appid)); return false; }
  return true;
}

/**
 * 后台把英文名换成中文。
 * 网络失败时不做长期缓存，2 分钟后即可自动重试（避免代理没开时把整库名字永久判死）。
 */
async function localizeInBackground(opts = {}) {
  if (localizing) return lastLocalize;
  localizing = true;
  try {
    if (opts.force) nameMiss.clear();
    const targets = lastGames
      .filter(g => g.appid && (opts.force || !missRecently(g.appid)))
      .map(g => ({ appid: g.appid, name: g.name }));
    if (!targets.length) return lastLocalize;

    const r = await metadata.localizeNames(targets, { force: !!opts.force });
    const now = Date.now();
    for (const a of r.missing || []) nameMiss.set(String(a), now);

    lastLocalize = {
      at: now,
      updated: r.updated,
      total: r.total || targets.length,
      missing: (r.missing || []).length,
      networkOk: r.networkOk !== false
    };

    if (r.updated > 0) {
      refreshCache();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('games:updated');
      }
    }
    return lastLocalize;
  } catch (e) {
    lastLocalize = Object.assign({}, lastLocalize, { networkOk: false, error: e.message });
    return lastLocalize;
  } finally {
    localizing = false;
  }
}

/* ----------------------------- 图片本地化（离线可用） -----------------------------
 * 把封面/背景/徽标抓到本地缓存目录（userData/assets/<id>/），让界面永远走本地 file://，
 * 不再在游戏结束重建 / 列表刷新时重新联网加载几十张远程图。
 * 选择条件（needsLocalImage）：md 为 null（从没抓过）→ 抓；或 md.cover / md.background 不是本地路径
 * （含老数据卡在 Steam CDN 远程链接）→ 抓。已落本地的跳过。
 * 串行 + 150ms 间隔，不挡界面；全部抓完统一 refreshCache + 推送 games:updated。
 * 抓完一次的图会落本地并标记 assetV，下次启动 needsLocalImage 返回 false，不再重复联网。
 * cacheImages 关闭时不预取（保留纯远程行为）。
 */
let enriching = false;

// 本地路径判断（与 metadata.js 的 isLocalFile 同义，主进程侧自用）
function isLocalPath(p) {
  return typeof p === 'string' && (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/') || p.startsWith('file://'));
}

/**
 * 某 appid 是否「本地还缺图」：需要后台预取到 userData/assets/<id>/。
 *   - 从没抓过（md 为 null）
 *   - 封面或背景不是本地路径（含老数据卡在 Steam CDN 远程链接的情况）
 * 已落本地的跳过，避免重复联网。
 */
function needsLocalImage(appid) {
  const md = store.getMetadata(appid);
  if (!md) return true;
  if (!isLocalPath(md.cover)) return true;
  if (!isLocalPath(md.background)) return true;
  return false;
}

/**
 * 后台把封面/背景/徽标抓到本地缓存目录，让界面永远走本地 file://，
 * 不再在游戏结束重建 / 列表刷新时重新联网加载几十张远程图。
 * 只处理「本地还缺图」的游戏（needsLocalImage），已落本地的跳过。
 * 串行 + 150ms 间隔，避免一次性开几十个请求卡界面；全部抓完后统一 refreshCache + 推送 games:updated，
 * 让刚落地的本地图即时替换占位 / 远程图。
 */
async function enrichInBackground() {
  if (enriching) return;
  const settings = store.getSettings();
  if (!settings.cacheImages) return;          // 用户关了图片缓存就不预取（保持纯远程行为）

  const seen = new Set();
  const todo = [];
  for (const g of lastGames) {
    if (!g.appid) continue;
    const id = String(g.appid);
    if (seen.has(id)) continue;
    seen.add(id);
    if (needsLocalImage(id)) todo.push(g);
  }
  if (!todo.length) return;

  enriching = true;
  try {
    for (const g of todo) {
      try {
        await metadata.fetchAndStore(g.appid, { force: false, assetDir: store.resolveAssetsDir(null, g.id) });
      } catch (e) {
        /* 单款失败不影响其他款 */
      }
      await new Promise(r => setTimeout(r, 150));   // 别把网络/CPU 打满
    }
    refreshCache();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('games:updated');
  } finally {
    enriching = false;
  }
}

/* ----------------------------- 后台元数据预热 ----------------------------- */

/** 先中文化名字，再补全缺失的封面/背景/徽标（都走后台，不挡界面） */
function warmMetadata() {
  Promise.resolve()
    .then(() => localizeInBackground())
    .then(() => enrichInBackground())
    .catch(() => {})
    .finally(() => {
      // 启动预热完成后放一放：30 秒后清掉预热期间的会话缓存并 GC，
      // 让稳态内存只保留界面真正需要的东西
      setTimeout(() => {
        try {
          const web = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
          if (web) { try { web.session.clearCache().catch(() => {}); } catch (e) {} }
        } catch (e) {}
        try { if (global.gc) global.gc(); } catch (e) {}
      }, 30 * 1000);
    });
}

/* ----------------------------- 内存优化 ----------------------------- */

function memMB(bytes) { return Math.round((bytes || 0) / 1048576); }

/** 汇总主进程 / 渲染进程 / GPU 进程的实际内存占用（MB） */
function memoryInfo() {
  const mainMB = memMB(process.memoryUsage().rss);
  let rendererMB = 0, gpuMB = 0;
  try {
    for (const m of app.getAppMetrics()) {
      const kb = m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0;   // 单位 KB
      if (m.type === 'Tab' || m.type === 'Renderer') rendererMB += memMB(kb * 1024);
      else if (m.type === 'GPU') gpuMB += memMB(kb * 1024);
    }
  } catch (e) {}
  return { mainMB, rendererMB, gpuMB, totalMB: mainMB + rendererMB + gpuMB };
}

/**
 * 释放内存。启动游戏后自动调用，也可在设置里手动触发。
 *  - 渲染层卸掉全部图片引用（封面/大背景的解码位图是占用大头）
 *  - 清空会话缓存（含内存缓存中的图片）
 *  - 主进程强制 GC（需要 --expose-gc）
 *  - minimize=true 时把窗口最小化，让 Chromium 停止绘制并把资源让给游戏
 */
function trimMemory(opts = {}) {
  const settings = store.getSettings();
  const doTrim = opts.force || settings.trimMemory !== false;   // 是否卸图片/清缓存/GC
  const minimize = opts.minimize !== undefined ? !!opts.minimize : (settings.minimizeOnLaunch !== false);
  const web = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;

  if (web && doTrim) {
    if (minimize) {
      try { web.send('memory:trim'); } catch (e) {}
    }
    try { web.session.clearCache().catch(() => {}); } catch (e) {}
  }
  try { if (doTrim && global.gc) global.gc(); } catch (e) {}

  if (minimize && mainWindow && !mainWindow.isDestroyed()) {
    // 稍等一下让游戏窗口先抢到前台焦点，再把本窗口收起来
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) mainWindow.minimize();
      } catch (e) {}
      try { if (global.gc) global.gc(); } catch (e) {}
    }, 1500);
  }
}

/**
 * 游戏进程结束后：把窗口从最小化恢复、让渲染层重建图片/网格，并切回大屏模式。
 * 在 playtime 会话结束（onEnd）时调用——此时游戏进程已退出，恢复不会抢占前台。
 */
function restoreAfterGame() {
  const settings = store.getSettings();
  const web = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;

  // 1) 渲染层重建（还原此前卸掉的封面/背景；未卸过则为空操作）
  if (web) {
    try { web.send('memory:restore'); } catch (e) {}
  }

  // 2) 把窗口从最小化恢复并置前（游戏已结束，不会抢游戏焦点）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      if (typeof mainWindow.focus === 'function') {
        try { mainWindow.focus(); } catch (e) {}
      }
    } catch (e) {}

    // 3) 切回大屏模式（用户要求：游戏结束后恢复大屏）
    if (settings.restoreBigScreenOnExit !== false) {
      try { store.setSettings({ mode: 'fullscreen' }); } catch (e) {}
      try { web.send('window:toBigScreen'); } catch (e) {}
    }
  }
  try { if (global.gc) global.gc(); } catch (e) {}
}

/* ----------------------------- IPC ----------------------------- */

// 全量重新扫描：只有界面「⟳ 刷新」按钮会走到这里（用户明确要求重新扫描）
ipcMain.handle('games:scan', () => {
  const list = refreshCache({ rescan: true });
  warmMetadata();   // 后台中文化 + 补全缺失的封面/背景/徽标，完成后推送 games:updated
  return list;
});

ipcMain.handle('games:get', () => {
  if (!lastGames.length) lastGames = buildGames();
  return lastGames;
});

/** 向界面推送启动进度（平台客户端启动等待等耗时步骤，让用户知道程序没卡死） */
function pushLaunchStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('launch:status', msg); } catch (e) {}
  }
}

/* ----------------------------- 音频通道联动 ----------------------------- */

/**
 * 本次「指定通道」会话的状态（同一时刻只有一个游戏在跑）。
 *   want        本次要切到的设备
 *   restoreTo   游戏结束后要还原到的设备（启动前的系统默认 / 设置里的默认通道）
 *   corrections 本次会话已纠正过几次漂移
 *
 * 关键点：还原目标只在「游戏真的结束」时消费一次。v1.2.1 之前它是个一次性变量，
 * 任何一次误判「游戏退出」都会把它清掉——之后切到桌面被系统改回默认、正常退出
 * 也不再还原，全是同一个原因。
 */
let audioSession = null;
let audioGuardTimer = null;
const AUDIO_GUARD_MS = 60 * 1000;    // 游戏中守护检查间隔
const AUDIO_GUARD_MAX_FIX = 3;       // 单次会话最多纠正几次（再改就认为用户另有打算）

function audioLabel(list, id) {
  const hit = list && list.devices ? list.devices.find(d => d.id === id) : null;
  return hit ? hit.name : id;
}

/**
 * 启动前把系统默认输出切到该游戏指定的通道。
 * 目标设备已不可用 / 本来就是当前设备时不做任何切换（也就不会记录还原动作）。
 */
async function applyGameAudio(game) {
  const settings = store.getSettings();
  if (settings.switchAudioOnLaunch === false) return;
  const want = game.audioDevice || null;
  if (!want) return;

  let list;
  try { list = await audio.listDevices(); } catch (e) { return; }
  if (!list || !list.ok) return;

  if (!list.devices.some(d => d.id === want)) {
    pushLaunchStatus('该游戏指定的音频通道当前不可用，保持系统设置');
    log('audio', `指定通道不可用，跳过切换 游戏=${game.id}`);
    return;
  }
  if (list.default === want) {
    // 已经是目标设备：不用切，但仍记下「退出后该还原到哪」——
    // 否则用户手动把默认设成游戏通道后就再也回不来了
    const to = (settings.defaultAudioDevice && list.devices.some(d => d.id === settings.defaultAudioDevice))
      ? settings.defaultAudioDevice : null;
    audioSession = { gameId: game.id, want, restoreTo: to && to !== want ? to : null, corrections: 0 };
    log('audio', `系统默认已是游戏通道「${audioLabel(list, want)}」，仅登记还原目标=${audioLabel(list, audioSession.restoreTo)}`);
    return;
  }

  const fallback = (settings.defaultAudioDevice && list.devices.some(d => d.id === settings.defaultAudioDevice))
    ? settings.defaultAudioDevice
    : list.default;

  pushLaunchStatus(`正在切换音频到「${audioLabel(list, want)}」…`);
  const r = await audio.setDefault(want);
  if (!r || !r.ok) {
    pushLaunchStatus('音频通道切换失败，继续启动游戏');
    log('audio', `切换失败，放弃 游戏=${game.id}`);
    return;
  }
  audioSession = { gameId: game.id, want, restoreTo: fallback || null, corrections: 0 };
  log('audio', `切到「${audioLabel(list, want)}」（游戏 ${game.id}），结束后还原到「${audioLabel(list, fallback)}」`);
}

/** 停止游戏内音频守护 */
function stopAudioGuard() {
  if (audioGuardTimer) { clearTimeout(audioGuardTimer); audioGuardTimer = null; }
}

/**
 * 游戏运行期间的音频守护：每 60 秒看一眼系统默认输出是不是还在游戏指定的通道上。
 * 切到桌面、系统自己重设默认、设备热插拔都可能让它漂走，漂走了就切回来，
 * 这样「回到游戏」时听到的仍然是游戏通道。只在游戏确实在跑时工作，
 * 且最多纠正 AUDIO_GUARD_MAX_FIX 次（用户真想换设备时不会被一直抢）。
 */
function startAudioGuard() {
  stopAudioGuard();
  const sess = audioSession;
  if (!sess || !sess.want) return;

  const schedule = () => {
    if (audioGuardTimer || audioSession !== sess) return;
    audioGuardTimer = setTimeout(check, AUDIO_GUARD_MS);
    if (audioGuardTimer.unref) audioGuardTimer.unref();
  };

  const check = async () => {
    audioGuardTimer = null;
    if (audioSession !== sess) return;
    const st = playtime.getActiveSession();
    if (!st || st.gameId !== sess.gameId) return;      // 会话结束：交给 restoreAudio
    if (!st.seen) { schedule(); return; }              // 游戏还没跑起来，先等

    let list = null;
    try { list = await audio.listDevices({ force: true }); } catch (e) {}
    if (audioSession !== sess) return;
    if (!list || !list.ok) { schedule(); return; }

    if (!list.devices.some(d => d.id === sess.want)) {
      log('audio', '守护：指定通道已不可用，停止守护');
      return;
    }
    if (list.default === sess.want) { schedule(); return; }

    if (sess.corrections >= AUDIO_GUARD_MAX_FIX) {
      log('audio', `守护：已纠正 ${sess.corrections} 次，停止守护（尊重手动改动）`);
      return;
    }
    sess.corrections++;
    await audio.setDefault(sess.want);
    log('audio', `守护：默认输出漂到「${audioLabel(list, list.default)}」，已切回「${audioLabel(list, sess.want)}」（第 ${sess.corrections} 次）`);
    pushLaunchStatus(`默认音频被改走，已切回「${audioLabel(list, sess.want)}」`);
    schedule();
  };

  schedule();
}

/**
 * 本次会话结束，把系统默认输出还原到启动前记下的设备。
 * 只有「游戏确实结束 / 管家退出」才会走到这里——不还原保持不动，宁可不切也不乱切。
 */
async function restoreAudio(msg = '已切回默认音频通道') {
  stopAudioGuard();
  if (!audioSession) return;
  const to = audioSession.restoreTo;
  const gameId = audioSession.gameId;
  audioSession = null;
  if (!to) return;
  try {
    const r = await audio.setDefault(to);
    if (r && r.ok) pushLaunchStatus(msg);
    log('audio', `还原默认输出 游戏=${gameId} ${r && r.ok ? 'ok' : 'fail'}`);
  } catch (e) {
    log('audio', '还原失败：' + (e && e.message));
  }
}

/* ----------------------------- 启动 ----------------------------- */

/**
 * 游玩会话结束（进程退出）时的收尾：累计游玩时长、切回默认音频、刷新界面、恢复大屏。
 *
 * 按结算原因区分动作（v1.2.1）：
 *   exited / manual / timeout —— 游戏确实不在跑了：还原音频 + 恢复窗口与大屏；
 *   superseded —— 又启动了别的游戏：音频和窗口都交给新会话，什么都不动；
 *   never-started / undetectable —— 从没确认到游戏进程：只把音频还回去，**不动窗口**。
 *     万一游戏其实在跑（进程探测不到），弹窗会把全屏游戏顶到桌面 —— 这正是老版本
 *     「切到桌面后音频被改回默认」的观感来源。
 */
async function onSessionEnd(game, rec) {
  if (rec.counted) store.addPlaytime(game.id, rec.ms, rec.startAt);

  // 游戏结束（含被新游戏顶替）→ 关闭本场联动的修改器，不留残留进程。
  // 放在最前：superseded 时旧游戏会话已结束、其修改器也要随之关掉，不能 early-return 漏掉。
  if (game && game.trainer) {
    try { launcher.terminateTrainer(game.trainer); }
    catch (e) { log('trainer', '关闭修改器异常：' + (e && e.message)); }
  }

  if (rec.reason === 'superseded') return;      // 新会话已接管，别把它的通道切回去

  await restoreAudio();

  const started = rec.reason === 'exited' || rec.reason === 'manual' || rec.reason === 'timeout';
  if (!started) {
    pushLaunchStatus('没有检测到游戏进程，音频已还回默认通道');
    refreshCache();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('games:updated'); } catch (err) {}
    }
    return;
  }

  refreshCache();
  restoreAfterGame();
  if (game && game.trainer) pushLaunchStatus('已联动关闭修改器');
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('games:updated'); } catch (err) {}
  }
}

/**
 * 启动游戏：先把平台客户端拉起并**等它就绪**（默认 15 秒，设置里可调），再发起启动。
 *
 * 不做「启动后自退 → 自动重试」：重试会带来双开、音频抖动、大屏闪回等副作用。
 * 改为「宁可多等，一次成功」—— 等客户端完成登录态 / DRM 初始化后再启动；
 * Epic / 战网 / 育碧由客户端接管启动并拉起游戏本体（官方 URI 协议，Playnite 同款）。
 */
async function startGameFlow(game, overrideArgs) {
  // 平台客户端没在运行 → 先把平台拉起来再启动游戏
  // （Epic / 战网 / 育碧 / Xbox 的游戏强依赖客户端鉴权与 DRM，客户端没开会黑屏或自退）
  if (store.getSettings().startPlatformFirst !== false && platform.needsPlatform(game.platform)) {
    pushLaunchStatus(`正在检查 ${platform.labelOf(game.platform)} 客户端…`);
    const p = await platform.ensureRunning(game.platform, pushLaunchStatus, { settings: store.getSettings() });
    if (p && p.message && !p.alreadyRunning) pushLaunchStatus(p.message);
  }

  const result = await launcher.launchGame(game, overrideArgs);
  log('launch', `游戏=${game.id} 修改器=${game.trainer ? '有' : '无'} 结果=${result && result.ok ? 'ok' : 'fail'} ${(result && result.message) || ''}`);
  if (!result || !result.ok) return result;

  store.touchLastPlayed(game.id, Date.now());
  playtime.beginSession(game, { onEnd: (rec) => onSessionEnd(game, rec) });

  // 游戏窗口出现后自动激活到最前（v1.2.5）
  // 为什么需要：不少游戏启动比修改器慢，或者平台客户端要先登录/校验/更新——
  // 等游戏窗口finally出来时已经被压在后面，还得手动点任务栏才能进游戏。
  // 这里交给一个独立的帮助进程去等（平台游戏最多等 4 分钟，普通游戏 2 分钟），
  // 窗口一出现就激活，并在随后 20 秒守卫期内被抢走还会拉回来（最多 6 次）。
  if (store.getSettings().focusGameOnLaunch !== false) {
    try {
      const f = winfocus.focusGameWindow(game);
      if (f && f.ok) {
        log('launch', `游戏窗口前台激活已排入 游戏=${game.id} 等待上限=${Math.round(f.waitMs / 1000)}s ` +
          `候选进程名=${f.names.length}`);
      } else if (f && f.skipped) {
        log('launch', `前台激活跳过（${f.reason}）游戏=${game.id}`);
      }
    } catch (e) {
      log('launch', '前台激活排入失败：' + (e && e.message));
    }
  }

  return result;
}

ipcMain.handle('game:launch', async (e, id, overrideArgs) => {
  const game = lastGames.find(g => g.id === id);
  if (!game) return { ok: false, message: '未找到该游戏' };

  // 0) 音频通道：按该游戏的配置切换系统默认输出（结束后自动还原）
  await applyGameAudio(game);

  // 1) 平台就绪 → 启动游戏（含修改器联动）；overrideArgs 来自「在开始游戏时询问」模式
  const result = await startGameFlow(game, overrideArgs);
  if (!result || !result.ok) {
    await restoreAudio();                        // 没启动成功就把音频还回去
    return result;
  }

  // 2) 启动成功后按设置释放内存 / 最小化窗口，把资源让给游戏
  trimMemory();

  // 3) 游戏运行期间守护「指定音频通道」：切桌面 / 系统改默认都不该把它带走
  startAudioGuard();
  return result;
});

/* ----------------------------- 存档目录 ----------------------------- */

// 探测该游戏的候选存档目录（Steam 云存档 / 我的文档 / AppData / 安装目录 …）
ipcMain.handle('game:saveDirs', (e, id) => {
  const game = lastGames.find(g => g.id === id);
  if (!game) return { ok: false, message: '未找到该游戏', dirs: [] };
  try {
    const dirs = savedir.findSaveDirs(game);
    return { ok: true, dirs, custom: game.saveDir || null };
  } catch (err) {
    return { ok: false, message: '探测存档目录失败：' + err.message, dirs: [] };
  }
});

// 一键打开某个目录；不传 path 时打开该游戏探测到的第一个存档目录
ipcMain.handle('game:openSaveDir', async (e, id, target) => {
  const game = lastGames.find(g => g.id === id);
  if (!game) return { ok: false, message: '未找到该游戏' };
  let dir = target;
  if (!dir) {
    const dirs = savedir.findSaveDirs(game);
    const hit = dirs.find(d => d.exists);
    if (!hit) return { ok: false, message: '未找到存档目录，可在「管理」里手动指定' };
    dir = hit.path;
  }
  try {
    if (!fs.existsSync(dir)) return { ok: false, message: '目录不存在：' + dir };
    await shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, message: '打开失败：' + err.message };
  }
});

/**
 * 存档位置在线查询：存档资料站（PCGamingWiki 等）都是英文站，
 * 统一用英文名检索——中文名在这些站点基本搜不到结果。
 */
ipcMain.handle('game:searchSaveOnline', async (e, id, engine) => {
  const game = lastGames.find(g => g.id === id) || store.getManualGames().find(g => g.id === id);
  if (!game) return { ok: false, message: '未找到该游戏' };
  const term = String(game.nameEn || '').trim() || String(game.name || '').trim();
  if (!term) return { ok: false, message: '该游戏没有可用名称，无法查询' };
  const url = engine === 'search'
    ? 'https://www.bing.com/search?q=' + encodeURIComponent(term + ' save game file location')
    : 'https://www.pcgamingwiki.com/w/index.php?search=' + encodeURIComponent(term) + '&title=Special%3ASearch&go=Go';
  try {
    await shell.openExternal(url);
    return { ok: true, term, url, engine: engine === 'search' ? 'search' : 'pcgamingwiki' };
  } catch (err) {
    return { ok: false, message: '打开浏览器失败：' + err.message };
  }
});

ipcMain.handle('game:setConfig', async (e, id, patch) => {
  const next = Object.assign({}, patch);
  // 界面上的控制字段（是否顺带写回 Steam），不落进配置文件
  const wantSyncSteam = next.syncSteam === true;
  delete next.syncSteam;
  // 资源目录：统一放在 userData 下，不写入游戏安装目录
  const game = lastGames.find(g => g.id === id) || store.getManualGames().find(g => g.id === id) || {};
  const assetsDir = () => store.resolveAssetsDir(null, id);

  // 远程背景图（来自 SteamGridDB 等）：下载到该游戏的资源目录
  if (next.customBackgroundUrl) {
    try {
      const url = next.customBackgroundUrl;
      const ext = /\.png(\?|$)/i.test(url) ? '.png' : (/\.webp(\?|$)/i.test(url) ? '.webp' : '.jpg');
      const dest = path.join(assetsDir(), `background${ext}`);
      // 走 Chromium 网络栈，才能自动使用系统代理（否则代理环境下必然下载失败）
      if (await netfetch.downloadTo(url, dest)) next.customBackground = dest;
    } catch (err) { /* 下载失败则不更新 */ }
    delete next.customBackgroundUrl;
  }
  // 本地背景图：复制到该游戏的资源目录，避免原图被移动后失效
  if (next.customBackground && fs.existsSync(next.customBackground)) {
    const ext = path.extname(next.customBackground) || '.jpg';
    const dest = path.join(assetsDir(), `background${ext}`);
    try {
      fs.copyFileSync(next.customBackground, dest);
      next.customBackground = dest;
    } catch (err) {
      /* 复制失败则保留原路径 */
    }
  }
  // 本地封面图：同样收进资源目录
  if (next.customCover && fs.existsSync(next.customCover)) {
    const ext = path.extname(next.customCover) || '.jpg';
    const dest = path.join(assetsDir(), `cover${ext}`);
    try {
      fs.copyFileSync(next.customCover, dest);
      next.customCover = dest;
    } catch (err) {
      /* 复制失败则保留原路径 */
    }
  }
  store.setGameConfig(id, next);

  // Steam 启动项双向同步：把管理弹窗里的「启动选项」写回 Steam 自带的启动项
  // （localconfig.vdf 的 apps/<appid>/LaunchOptions）。
  // 只对 Steam 平台的游戏做 —— appid 对其它平台只补资料、不影响启动（见 buildAll 的契约注释）。
  let steamSync = null;
  if (wantSyncSteam) {
    const appidSync = (game && game.appid) || next.appid ||
      (String(id).startsWith('steam:') ? String(id).split(':')[1] : null);
    if (appidSync && game && game.platform === 'steam') {
      const args = next.launchArgs !== undefined ? next.launchArgs : (store.getGameConfig(id).launchArgs || '');
      steamSync = steamlaunch.write(appidSync, args);
    }
  }

  refreshCache();
  return { ok: true, steamSync };
});

/**
 * DLC 查询：按平台调用各自数据源（Steam 读本地 manifest + 商店 API；Epic 扫 manifests；
 * 非 Steam 平台若填了 Steam appid 则按 appid 拉商店全部 DLC 供手动勾选）。
 * 清单默认读本地缓存（userData/dlc-cache.json，零联网），只有 opts.force（点 ↻ 手动更新）才联网重查。
 * 自动检测结果再与本地手动覆盖（cfg.dlcManual）合并，返回带 installed 标记的完整列表。
 */
ipcMain.handle('game:dlc', async (e, id, opts) => {
  const game = lastGames.find(g => g.id === id) || store.getManualGames().find(g => g.id === id);
  if (!game) return { ok: false, message: '未找到该游戏' };
  const force = !!(opts && opts.force);
  try {
    const raw = await dlc.getDlc(game, { force });
    const cfg = store.getGameConfig(id);
    const manual = cfg.dlcManual || {};
    if (!raw.supported) {
      return { ok: true, platform: raw.platform, supported: false, source: raw.source || 'none', items: [], note: raw.note };
    }
    const merged = dlc.mergeManual(raw.items, manual);
    if (force) log('dlc', `缓存更新：appid=${raw.appid || '-'} 共 ${merged.length} 项（${raw.source || raw.platform}）`);
    return {
      ok: true,
      platform: raw.platform,
      supported: true,
      source: raw.source || raw.platform,   // steam / epic / steam-appid（后者=非 Steam 游戏按 appid 拉清单）
      appid: raw.appid,
      items: merged,
      installed: merged.filter(i => i.installed).map(i => i.appid),
      uninstalled: merged.filter(i => !i.installed).map(i => i.appid),
      note: raw.note,
      manual,
      cached: !!raw.cached,                  // true=读的本地缓存，false=刚联网更新
      ts: raw.ts || 0,                       // 缓存时间戳（界面显示「x 小时前更新」）
      stale: !!raw.stale                     // 联网失败、退回过期缓存
    };
  } catch (err) {
    log('dlc', 'game:dlc 失败：' + ((err && err.stack) || err));
    return { ok: false, supported: true, items: [], message: 'DLC 查询失败：' + ((err && err.message) || err) };
  }
});

/**
 * DLC 手动标记：把 {[appid]: bool} 合并进该游戏的 cfg.dlcManual 并落盘。
 * 传 null/undefined 值可清除某条手动覆盖（回到自动检测）。
 */
ipcMain.handle('game:setDlcManual', async (e, id, map) => {
  const cfg = store.getGameConfig(id);
  const cur = Object.assign({}, cfg.dlcManual || {});
  const patch = map || {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null || v === undefined) delete cur[k];
    else cur[k] = !!v;
  }
  store.setGameConfig(id, { dlcManual: cur });
  return { ok: true, dlcManual: cur };
});

ipcMain.handle('game:addManual', (e, game) => {
  const id = game.id || `manual:${Date.now()}`;
  const rec = Object.assign(
    { id, platform: 'manual', cover: null, background: null, executable: null, launchCommand: null, launchArgs: null, installPath: null },
    game,
    { id }
  );
  store.addManualGame(rec);
  refreshCache();
  return { ok: true, id };
});

ipcMain.handle('game:remove', (e, id) => {
  store.removeGame(id);
  refreshCache();
  return { ok: true };
});

ipcMain.handle('dialog:selectImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:selectExe', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择可执行文件 / 修改器',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe', 'lnk', 'bat'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (e, patch) => {
  const s = store.setSettings(patch);
  if (patch.openAtLogin !== undefined) applyLoginItem(s);
  refreshCache();
  return s;
});

ipcMain.handle('window:toggleFullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  }
  return false;
});

// 由渲染进程在“桌面/全屏模式”切换时调用，显式设置全屏状态
ipcMain.handle('window:setFullscreen', (e, on) => {
  if (mainWindow) mainWindow.setFullScreen(!!on);
  return mainWindow ? mainWindow.isFullScreen() : false;
});

ipcMain.handle('shell:openFolder', (e, p) => {
  if (p && fs.existsSync(p)) shell.openPath(p);
  return true;
});

ipcMain.handle('shell:openExternal', (e, url) => {
  if (url) shell.openExternal(url);
  return true;
});

/* ----------------------------- 内存 ----------------------------- */

// 手动释放内存：不最小化窗口，强制清缓存 + GC（界面保持可见）
ipcMain.handle('app:trimMemory', () => {
  trimMemory({ minimize: false, force: true });
  return memoryInfo();
});

ipcMain.handle('app:memoryInfo', () => memoryInfo());

/* ----------------------------- 电源菜单 ----------------------------- */

// 重启 PC Game Master：重新拉起自身后立即退出当前实例
ipcMain.handle('power:restart', () => {
  try {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '重启失败：' + e.message };
  }
});

ipcMain.handle('power:quit', () => {
  try {
    app.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '退出失败：' + e.message };
  }
});

/**
 * 关机：交给系统自带的 shutdown.exe，延迟 10 秒（这 10 秒内可用「取消」撤回）。
 * 不用 app.quit 之类的方式，因为要关的是整台机器。
 */
ipcMain.handle('power:shutdown', (e, delaySec) => {
  if (process.platform !== 'win32') return { ok: false, message: '仅支持 Windows' };
  const t = Math.max(0, Math.min(600, parseInt(delaySec, 10) || 10));
  try {
    const p = spawn('shutdown', ['/s', '/t', String(t), '/c', `PC Game Master 将在 ${t} 秒后关机`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    p.unref();
    return { ok: true, seconds: t };
  } catch (err) {
    return { ok: false, message: '关机指令执行失败：' + err.message };
  }
});

// 取消已排定的关机
ipcMain.handle('power:cancelShutdown', () => {
  if (process.platform !== 'win32') return { ok: false, message: '仅支持 Windows' };
  try {
    const r = require('child_process').spawnSync('shutdown', ['/a'], { windowsHide: true, timeout: 8000 });
    return { ok: r.status === 0, message: r.status === 0 ? '已取消关机' : '没有待执行的关机计划' };
  } catch (err) {
    return { ok: false, message: '取消失败：' + err.message };
  }
});

/* ----------------------------- 音频输出通道 ----------------------------- */

// 列出可用播放设备 + 当前默认设备
ipcMain.handle('audio:list', async () => {
  const r = await audio.listDevices();
  return {
    ok: !!(r && r.ok),
    default: (r && r.default) || null,
    devices: (r && r.devices) || [],
    settingsDefault: store.getSettings().defaultAudioDevice || '',
    supported: audio.isSupported(),
  };
});

// 立即把系统默认播放设备切到指定端点（设置页「切换到该通道」、管理页「试听切换」用）
// 注意：这里只切系统当前设备，不写配置——「默认通道」由设置保存时写入 settings.defaultAudioDevice
ipcMain.handle('audio:apply', async (e, deviceId) => {
  if (!deviceId) return { ok: false, message: '未选择音频设备' };
  // 用户在界面上手动选通道（设置页「切换」/ 管理页「试听」）：本次会话不再守回指定通道，
  // 尊重手动选择；退出游戏时仍会还原到启动前的默认通道。
  if (audioSession) {
    stopAudioGuard();
    log('audio', '用户在界面上手动切换通道，暂停本次会话的音频守护');
  }
  return await audio.setDefault(deviceId);
});

/* ----------------------------- 元数据 / 信息库 ----------------------------- */

// 按 SteamGridDB 游戏名搜索候选背景图（heroes）
ipcMain.handle('metadata:searchBackgrounds', async (e, term) => {
  const key = (store.getSettings().steamGridDbKey || '').trim();
  if (!key) return { ok: false, message: 'no-key' };
  const list = await metadata.searchBackgrounds(term, key);
  if (!list.length) return { ok: false, message: '未找到候选背景图' };
  return { ok: true, list };
});

// 按 appid 查询并写入游戏基本信息库（游戏名中文优先 + 封面/背景/徽标）
// force=true 时忽略缓存重新抓取（用于补全缺失的 heroes 大背景）
// 手动重新抓取中文名（设置里「重新抓取中文名」）：忽略 nameTried 与失败缓存，全部重来
ipcMain.handle('metadata:localizeNow', async () => {
  const r = await localizeInBackground({ force: true });
  return Object.assign({ ok: true, network: netfetch.usingChromiumStack() ? 'chromium' : 'node' }, r);
});

/** 信息库统计 + 上次本地化结果（设置界面展示，便于自查网络问题） */
ipcMain.handle('metadata:stats', () => {
  const all = store.getConfig().metadata || {};
  const ids = Object.keys(all);
  const named = ids.filter(id => all[id] && all[id].name).length;
  const zh = ids.filter(id => /[\u4e00-\u9fff]/.test((all[id] && all[id].name) || '')).length;
  return {
    records: ids.length,
    named,
    zhName: zh,
    unnamed: ids.length - named,
    last: lastLocalize,
    network: netfetch.usingChromiumStack() ? 'chromium' : 'node'
  };
});

/**
 * 按 appid 抓取资料（名称/封面/背景/徽标/手柄支持）。
 *
 * ⚠️ 这里**只读资料**：appid 绝不影响游戏的启动方式。非 Steam 游戏（Epic / 战网 / 育碧 /
 * Xbox / 手动添加）填了 appid 之后依旧走各自的官方启动路径（平台 URI / 自己的 exe），
 * 不会变成 Steam 启动。详见 launcher.chooseLaunch（只看 executable / launchCommand / platform）。
 *
 * 返回 missing 列表：这次哪些资料没拿到（Steam 上没有对应图、或网络不通），
 * 让界面能如实告诉用户，而不是一律弹「已补全」。
 */
ipcMain.handle('metadata:query', async (e, appid, force) => {
  try {
    const meta = await metadata.fetchAndStore(appid, { force: !!force, assetDir: assetDirForAppid(appid) });
    if (!meta) return { ok: false, message: '未找到该 appid 的信息' };

    const missing = [];
    if (!meta.name) missing.push('名称');
    if (!meta.cover) missing.push('封面');
    if (!meta.background) missing.push('背景');
    if (!meta.logo) missing.push('徽标');

    // 连名称和封面都没有：appid 不存在，或网络/代理不通（两者对用户是同一件事：查不到）
    if (!meta.name && !meta.cover) {
      log(`[metadata] appid=${appid} 查不到任何资料（名称/封面均无），可能 appid 不存在或网络不通`);
      return {
        ok: false,
        missing,
        message: '没查到该 appid 的资料：请确认 appid 是否正确，或检查网络/代理后重试'
      };
    }

    log(`[metadata] appid=${appid} 名称=「${meta.name || ''}」缺失=${missing.length ? missing.join('、') : '无'}`);
    return {
      ok: true,
      missing,
      meta: {
        appid: meta.appid,
        name: meta.name || '',
        nameEn: meta.nameEn || '',
        cover: toLocalUrl(meta.cover),
        background: toLocalUrl(meta.background),
        logo: toLocalUrl(meta.logo),
        controllerSupport: meta.controllerSupport || null,
        source: meta.source
      }
    };
  } catch (err) {
    return { ok: false, message: '查询失败：' + err.message };
  }
});

// 返回整个信息库（用于展示“已入库 N 条”等）
ipcMain.handle('metadata:library', () => {
  const lib = store.getConfig().metadata || {};
  return { count: Object.keys(lib).length, items: lib };
});

// 扫描文件夹，列出其中的 exe（供批量添加）
ipcMain.handle('folder:scan', (e, folder) => {
  if (!folder || !fs.existsSync(folder)) return [];
  return scanner.findExes(folder);
});

// 选择文件夹对话框
ipcMain.handle('dialog:selectFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择游戏文件夹',
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

// 批量添加（来自文件夹扫描）：list = [{ name, path, appid? }]
ipcMain.handle('game:addGames', (e, list) => {
  if (!Array.isArray(list) || !list.length) return { ok: false, message: '没有可添加的项' };
  let added = 0;
  for (const item of list) {
    if (!item.path) continue;
    const id = `manual:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    store.addManualGame({
      id,
      platform: 'manual',
      appid: item.appid || null,
      name: item.name || path.basename(item.path).replace(/\.exe$/i, ''),
      cover: null,
      background: null,
      logo: null,
      executable: item.path,
      launchCommand: null,
      installPath: path.dirname(item.path)
    });
    added++;
  }
  refreshCache();
  return { ok: true, count: added };
});

// 隐藏一款游戏（扫描到的游戏用隐藏而非删除）
ipcMain.handle('game:hide', (e, id) => {
  store.hideGame(id);
  refreshCache();
  return { ok: true };
});

// 恢复显示一款被隐藏的游戏
ipcMain.handle('game:unhide', (e, id) => {
  store.unhideGame(id);
  refreshCache();
  return { ok: true };
});

// 返回已隐藏游戏的 [{ id, name, platform }]（供设置里恢复）
ipcMain.handle('game:hiddenList', () => {
  const hidden = new Set(store.getHiddenGames());
  return buildAll()
    .filter(g => hidden.has(g.id))
    .map(g => ({ id: g.id, name: g.name, platform: g.platform }));
});

/* ----------------------------- 生命周期 ----------------------------- */

app.whenReady().then(() => {
  // 单实例锁没抢到的实例会在上面 app.quit()；这里处理「重复启动 → 带回已有窗口」
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } catch (e) {}
    }
  });

  store.init(app);
  applyLoginItem(store.getSettings());   // 开机自启跟随已保存设置
  refreshCache({ rescan: true });        // 全平台扫描只在启动（重启）时执行一次
  createWindow();
  warmMetadata();   // 启动即把英文名换成中文，并补全缺失图片

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前收尾：停掉音频守护、结束未完成的时长会话，并把音频通道还原
// （audio.setDefault 内部是同步 spawn，这里直接调用也能在进程退出前完成切换）
app.on('before-quit', () => {
  try { stopAudioGuard(); } catch (e) {}
  try {
    const to = audioSession && audioSession.restoreTo;
    audioSession = null;
    if (to) { audio.setDefault(to); log('audio', '管家退出，已还原默认输出'); }
  } catch (e) {}
  try { playtime.endSession(); } catch (e) {}
});
