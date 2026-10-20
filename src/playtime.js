'use strict';

/**
 * 游玩时长统计。
 *
 * 两个来源，优先级从高到低：
 *   1) 平台数据 —— Steam 客户端把每个游戏的累计时长写在本地
 *      `<SteamPath>\userdata\<账号>\config\localconfig.vdf` 的
 *      Software/Valve/Steam/apps/<appid>/Playtime（单位：分钟），并且带 LastPlayed 时间戳。
 *      Epic / 战网 / 育碧 / Xbox 没有可离线读取的本地时长（都在各自云端账号里），因此跳过。
 *   2) 本地计时 —— 启动游戏后监视进程，进程退出时把本次时长累加到配置里，覆盖所有平台。
 *
 * 展示规则：平台有数据就用平台数据（跨机器、跨重装都准），没有才用本地累计。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const reg = require('./registry');
const { log } = require('./log');

/* ------------------------------------------------------------------ 通用 */

/** 从 text[openIdx] 的 '{' 开始做配对匹配，返回内部文本 */
function blockAt(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start: openIdx + 1, end: i, text: text.slice(openIdx + 1, i) };
    }
  }
  return null;
}

/** 查找 "key" { ... } 块；key 用正则转义，忽略大小写 */
function findBlock(text, key, from = 0) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('"' + esc + '"\\s*\\{', 'i');
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index);
  return blockAt(text, open);
}

/* ------------------------------------------------------------------ Steam */

let steamCache = { at: 0, data: null };
const STEAM_TTL = 120 * 1000;

/**
 * 读取 Steam 本地游玩时长。
 *
 * localconfig.vdf 里每个 appid 块通常含：
 *   - Playtime      —— 累计总时长（分钟）
 *   - Playtime2wks  —— 近两周时长（分钟，只有近两周玩过才有该键）
 *   - LastPlayed    —— 最后游玩时间戳（秒）
 * 三者同级，直接读同一块即可，无需联网。
 *
 * @returns {Object<string, {minutes:number, minutes2wks:number, lastPlayed:number}>}
 *          appid -> { 总分钟, 近两周分钟, 最后游玩(秒) }
 */
function readSteamPlaytime() {
  const now = Date.now();
  if (steamCache.data && now - steamCache.at < STEAM_TTL) return steamCache.data;

  const map = {};
  try {
    const steamPath = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (!steamPath || !fs.existsSync(steamPath)) return map;

    const userdata = path.join(steamPath, 'userdata');
    if (!fs.existsSync(userdata)) return map;

    const accounts = fs.readdirSync(userdata, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name));
    if (!accounts.length) return map;

    for (const acc of accounts) {
      const file = path.join(userdata, acc.name, 'config', 'localconfig.vdf');
      if (!fs.existsSync(file)) continue;

      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      if (!text) continue;

      const software = findBlock(text, 'Software');
      if (!software) continue;
      const valve = findBlock(software.text, 'Valve');
      if (!valve) continue;
      const steam = findBlock(valve.text, 'Steam');
      if (!steam) continue;
      const apps = findBlock(steam.text, 'apps');
      if (!apps) continue;

      // apps 下直接就是 appid -> { ... } 一堆配置
      const re = /"(\d{2,8})"\s*\{/g;
      let m;
      while ((m = re.exec(apps.text))) {
        const open = apps.text.indexOf('{', m.index);
        const blk = blockAt(apps.text, open);
        if (!blk) continue;
        if (!/"Playtime"/i.test(blk.text) && !/"Playtime2wks"/i.test(blk.text) && !/"LastPlayed"/i.test(blk.text)) continue;

        const pm = /"Playtime"\s*"(\d+)"/i.exec(blk.text);
        // 近两周时长：Steam 只在最近两周玩过时写这个键，没写就是 0
        const p2 = /"Playtime2wks"\s*"(\d+)"/i.exec(blk.text);
        const pl = /"LastPlayed"\s*"(\d+)"/i.exec(blk.text);
        const appid = m[1];
        const minutes = pm ? parseInt(pm[1], 10) : 0;
        const minutes2wks = p2 ? parseInt(p2[1], 10) : 0;
        const lastPlayed = pl ? parseInt(pl[1], 10) : 0;

        const cur = map[appid] || { minutes: 0, minutes2wks: 0, lastPlayed: 0 };
        map[appid] = {
          minutes: Math.max(cur.minutes, minutes || 0),
          minutes2wks: Math.max(cur.minutes2wks, minutes2wks || 0),
          lastPlayed: Math.max(cur.lastPlayed, lastPlayed || 0),
        };
      }
    }
  } catch (e) {
    /* 读不到就当没有 */
  }

  steamCache = { at: now, data: map };
  return map;
}

function invalidateSteamCache() {
  steamCache = { at: 0, data: null };
}

/* ------------------------------------------------------------------ 进程监视 */

const SKIP_PROC = /^(unins\d+|vc_redist|dxwebsetup|dotnetfx|dotnet|setup|install|repair|patch|crashsender|crashreport|unitycrashhandler|unitycrashhandler64|steam|steamwebhelper|gameoverlayui|epicgameslauncher|epicwebhelper|battle\.net|battle\.net\slauncher|agent|ubisoftconnect|ubisoftgamelauncher|upc|gamingservices|xboxpcapp|gamebar|explorer|cmd|conhost|node|electron|\\w*helper|\\w*updater|\\w*launcher)\.exe$/i;

/** 用一次 tasklist 抓取全部进程名（小写） */
function listProcessNames() {
  const set = new Set();
  if (process.platform !== 'win32') return set;
  try {
    const r = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000,
    });
    if (r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) set.add(m[1].toLowerCase());
      }
    }
  } catch (e) { /* 当作未知 */ }
  return set;
}

/** 用 PowerShell 抓取所有进程的可执行路径（用于按安装目录判断游戏在跑） */
function listProcessPaths() {
  const out = [];
  if (process.platform !== 'win32') return out;
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }',
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
    if (r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p && /\.exe$/i.test(p)) out.push(p);
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

const SKIP_DIR = /^(redist|_commonredist|commonredist|support|directx|vcredist|dotnet|deps|engine|plugins|sdk|thirdparty|tools|extras)$/i;
const MAX_NAMES = 40;        // 候选进程名上限
const SCAN_MAX_DEPTH = 3;    // 递归深度：覆盖 …\game\bin\win64\cs2.exe 这类深层主程序
const SCAN_MAX_DIRS = 400;   // 目录预算：超大游戏目录也不至于拖慢启动

/**
 * 从游戏记录推断「它跑起来会是什么进程名」。
 *
 * 按目录广度优先递归（上限 SCAN_MAX_DEPTH 层）：主程序常常不在安装根目录，
 * 例如 CS2 是 …\Counter-Strike Global Offensive\game\bin\win64\cs2.exe，
 * 只扫 1 层会得到空列表 —— 那样任何进程核对都失效，游戏还在跑却判定成「已退出」。
 */
function candidateNames(game) {
  const names = new Set();
  const addPath = (p) => {
    if (!p) return;
    const base = path.basename(String(p)).toLowerCase();
    if (!base.endsWith('.exe')) return;
    if (SKIP_PROC.test(base)) return;
    if (names.size < MAX_NAMES) names.add(base);
  };

  addPath(game.executable);

  const queue = [];
  for (const d of [game.executable ? path.dirname(game.executable) : null, game.installPath]) {
    if (d) { try { if (fs.existsSync(d) && !queue.some(q => q.dir === d)) queue.push({ dir: d, depth: 0 }); } catch (e) {} }
  }

  let visited = 0;
  while (queue.length && names.size < MAX_NAMES && visited < SCAN_MAX_DIRS) {
    const { dir, depth } = queue.shift();
    visited++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (names.size >= MAX_NAMES) break;
      const full = path.join(dir, e.name);
      if (e.isFile()) addPath(full);
      else if (e.isDirectory() && depth < SCAN_MAX_DEPTH && !SKIP_DIR.test(e.name)) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return [...names];
}

/** 该游戏的安装目录前缀（小写、带尾部反斜杠），用于「按进程路径核对」 */
function gameDirs(game) {
  const out = [];
  const push = (d) => {
    if (!d) return;
    try { if (!fs.existsSync(d)) return; } catch (e) { return; }
    const s = String(d).toLowerCase().replace(/[\\/]+$/, '') + '\\';
    if (!out.includes(s)) out.push(s);
  };
  push(game.installPath);
  push(game.executable ? path.dirname(game.executable) : null);
  return out;
}

/**
 * 纯函数：给定的进程名 / 进程路径里，有没有这个游戏。
 * 两个信号是「或」的关系——进程名列表常常推断不到真正的主程序（平台拉起的、
 * 深层目录里的、可执行名和目录名不一样的），所以安装目录前缀匹配必须独立生效。
 */
function matchRunning({ names, procs, dirs, paths }) {
  if (names && names.length && procs && procs.size) {
    for (const n of names) if (procs.has(n)) return true;
  }
  if (dirs && dirs.length && paths && paths.length) {
    for (const p of paths) {
      const lp = String(p).toLowerCase();
      for (const d of dirs) if (lp.startsWith(d)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ 会话 */

let active = null;   // { game, startAt, firstSeen, names, dirs, seen, seenVia, ticks, onEnd, timer, confirmTimer }
const POLL_MS = 10000;                   // 轮询间隔（启动前置期：还没确认见到游戏进程，低频避免频繁 tasklist）
const POLL_MS_ACTIVE = 3000;             // 已确认游戏在跑后：更密地轮询，能更快发现游戏退出 → 主界面更快恢复
const EXIT_CONFIRM_MS = 2000;            // 发现进程不见后，隔多久做一次强确认（双路 miss 才结算，2s 足够且误判风险低）
const PATH_CHECK_EVERY = 3;              // 进程名没命中时，每 N 轮做一次「按安装目录核对」
const START_GRACE_MS = 6 * 60 * 1000;    // 6 分钟内没见过进程才放弃（平台客户端前置流程可能很长）
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;
const MIN_RECORD_MS = 60 * 1000;         // 不足 1 分钟不计入

/**
 * 一次运行状态探测。
 * @returns {{running:boolean, via:'name'|'path'|'miss'|'skip'|'unknown'}}
 *   name / path —— 确认在跑；
 *   miss        —— 确认不在（可以结算）；
 *   skip / unknown —— 本轮证据不足，不能据此判定「已退出」。
 */
function probe(sess, opts = {}) {
  const deep = !!opts.deep;
  const procs = listProcessNames();
  const nameKnown = procs.size > 0;          // 拿不到进程列表时，任何「没命中」都不算数
  if (nameKnown && matchRunning({ names: sess.names, procs })) return { running: true, via: 'name' };

  const canPath = sess.dirs.length > 0;
  // 路径核对开销大（要 spawn PowerShell 取全部进程路径），按需节流；deep 时无条件执行
  const wantPath = canPath && (deep || !nameKnown || !sess.seen || sess.ticks % PATH_CHECK_EVERY === 0);
  if (!wantPath) {
    if (!canPath && nameKnown && sess.names.length) return { running: false, via: 'miss' };
    return { running: false, via: canPath ? 'skip' : 'unknown' };
  }

  const paths = listProcessPaths();
  if (paths.length && matchRunning({ dirs: sess.dirs, paths })) return { running: true, via: 'path' };
  if (paths.length) return { running: false, via: 'miss' };                  // 路径核对跑通且没命中
  if (nameKnown && sess.names.length) return { running: false, via: 'miss' }; // 退化：至少进程名可用
  return { running: false, via: 'unknown' };
}

function clearTimers(sess) {
  if (!sess) return;
  if (sess.timer) { clearTimeout(sess.timer); sess.timer = null; }
  if (sess.confirmTimer) { clearTimeout(sess.confirmTimer); sess.confirmTimer = null; }
}

function stopWatcher(sess, reason) {
  clearTimers(sess);
  if (active === sess) active = null;
  if (!sess) return;
  const endAt = Date.now();
  const from = sess.firstSeen || sess.startAt;
  const ms = Math.max(0, endAt - from);
  const record = {
    game: sess.game,
    startAt: sess.startAt,
    endAt,
    ms,
    seen: !!sess.seen,
    via: sess.seenVia || null,
    counted: ms >= MIN_RECORD_MS && (sess.seen || reason === 'manual'),
    reason,
  };
  log('playtime', `会话结束 reason=${reason} seen=${record.seen} via=${record.via} ` +
    `用时=${Math.round(ms / 1000)}s 计入=${record.counted} 游戏=${sess.game.id}`);
  try { if (typeof sess.onEnd === 'function') sess.onEnd(record); } catch (e) { /* 忽略 */ }
}

/** 确认游戏进程在跑 */
function markSeen(sess, via, now) {
  if (!sess.seen) {
    sess.seenVia = via;
    log('playtime', `见到游戏进程 via=${via} 游戏=${sess.game.id}（候选进程名 ${sess.names.length} 个）`);
  }
  sess.seen = true;
  if (!sess.firstSeen) sess.firstSeen = now;
}

/**
 * 进程「不见」之后的强确认：EXIT_CONFIRM_MS 毫秒后再核一次（含安装目录路径核对），
 * 仍然找不到才结算。这样单次采样抖动（tasklist 超时、游戏短暂换进程）不会
 * 把「游戏还在跑」误判成退出——那会连带把系统音频切回默认、并把窗口弹到桌面。
 */
function scheduleExitConfirm(sess) {
  if (sess.confirmTimer || active !== sess) return;
  sess.confirmTimer = setTimeout(() => {
    sess.confirmTimer = null;
    if (active !== sess) return;
    const r = probe(sess, { deep: true });
    if (r.running) { markSeen(sess, r.via, Date.now()); return; }        // 误报：进程还在
    if (r.via === 'skip' || r.via === 'unknown') {                       // 证据不足，下轮再看
      log('playtime', `退出确认证据不足（${r.via}），继续跟踪 游戏=${sess.game.id}`);
      return;
    }
    stopWatcher(sess, 'exited');
  }, EXIT_CONFIRM_MS);
  if (sess.confirmTimer.unref) sess.confirmTimer.unref();
}

function tick() {
  const sess = active;
  if (!sess) return;

  const now = Date.now();
  if (now - sess.startAt > MAX_SESSION_MS) { stopWatcher(sess, 'timeout'); return; }

  sess.ticks++;
  const r = probe(sess, { deep: false });

  if (r.running) {
    markSeen(sess, r.via, now);
  } else if (r.via === 'skip' || r.via === 'unknown') {
    // 证据不足：不结算，也不当作退出。宽限期到了还从没见过进程 → 这台机器上
    // 没法可靠识别它，放弃跟踪（主进程会据此只还原音频、不动窗口）
    if (!sess.seen && r.via === 'unknown' && now - sess.startAt > START_GRACE_MS) {
      stopWatcher(sess, 'undetectable');
      return;
    }
  } else if (sess.seen) {
    scheduleExitConfirm(sess);
  } else if (now - sess.startAt > START_GRACE_MS) {
    // 一直没见过进程：放弃前做一次强核对（含路径），仍找不到才判定「没启动起来」
    const deep = probe(sess, { deep: true });
    if (deep.running) markSeen(sess, deep.via, now);
    else if (deep.via !== 'skip' && deep.via !== 'unknown') { stopWatcher(sess, 'never-started'); return; }
  }

  if (active !== sess) return;
  // 游戏确实在跑 → 切到更密的轮询，尽快发现退出；否则保持低频（启动前置期不扰民）
  const nextPoll = sess.seen ? POLL_MS_ACTIVE : POLL_MS;
  sess.timer = setTimeout(tick, nextPoll);
  if (sess.timer.unref) sess.timer.unref();   // 不要把应用钉在事件循环里
}

/**
 * 开始一次游玩会话监视（同一时刻只跟踪一个游戏）。
 * @param {Object} game 已合并配置的游戏对象
 * @param {{onEnd?:(record:Object)=>void}} opts
 */
function beginSession(game, opts = {}) {
  if (!game || !game.id) return;
  if (active) stopWatcher(active, 'superseded');   // 上一个没结束就先结算

  const sess = {
    game,
    startAt: Date.now(),
    firstSeen: 0,
    seen: false,
    seenVia: null,
    ticks: 0,
    names: candidateNames(game),
    dirs: gameDirs(game),
    onEnd: opts.onEnd,
    timer: null,
    confirmTimer: null,
  };
  active = sess;
  log('playtime', `会话开始 游戏=${game.id} 候选进程名=${sess.names.length} 路径核对目录=${sess.dirs.length}`);
  sess.timer = setTimeout(tick, POLL_MS);
  if (sess.timer.unref) sess.timer.unref();
}

function getActiveSession() {
  if (!active) return null;
  return { gameId: active.game.id, startAt: active.startAt, seen: active.seen };
}

function endSession() {
  if (active) stopWatcher(active, 'manual');
}

/**
 * 立刻判断游戏是否还在运行（音频还原前确认、诊断脚本用）。
 * @returns {boolean|null} true=在跑，false=确实不在，null=判断不了
 */
function isRunningNow(game) {
  if (process.platform !== 'win32' || !game) return null;
  const names = candidateNames(game);
  const procs = listProcessNames();
  const nameKnown = procs.size > 0;
  if (matchRunning({ names, procs })) return true;
  const dirs = gameDirs(game);
  if (dirs.length) {
    const paths = listProcessPaths();
    if (paths.length) return matchRunning({ dirs, paths });
  }
  if (nameKnown && names.length) return false;
  return null;
}

module.exports = {
  readSteamPlaytime,
  invalidateSteamCache,
  beginSession,
  getActiveSession,
  endSession,
  candidateNames,
  gameDirs,
  matchRunning,
  isRunningNow,
  blockAt,
  findBlock,
};
