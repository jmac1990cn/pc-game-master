'use strict';

/**
 * Steam 启动项（LaunchOptions）双向同步。
 *
 * Steam 的「启动选项」没有官方 API，只在本地存在这一处：
 *   <SteamPath>\userdata\<账号>\config\localconfig.vdf
 *     Software / Valve / Steam / apps / <appid> / LaunchOptions
 * （本机实测格式：appid 行 5 个 tab 缩进，块内键 6 个 tab，键与值之间 2 个 tab）
 *
 * 因此和 Playnite 等第三方工具走同一条路：
 *   读 —— 刷新列表时把 Steam 侧的值带出来，管理弹窗里直接可见 / 一键读取
 *   写 —— 保存时把管家填的参数写回；只动 LaunchOptions 这一行，其余字节原样保留，
 *        写入前先备份一份（.glbak），写坏了可手工恢复
 *
 * 语义注意：Steam 启动项里的 %command% 是「游戏本体命令行」的占位符
 * （如 `gamemoderun %command% -dx11`）。管家是直接 spawn exe，%command% 无意义，
 * 所以读出来时只取它后面的参数、写回去时保留它前面的包装命令。
 *
 * 生效时机：Steam 运行中改这个文件，Steam 会用内存里的状态覆盖它，
 * 所以检测到 Steam 在跑时给出「重启 Steam 后生效」的明确提示。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const reg = require('./registry');
const { log } = require('./log');
const { blockAt, findBlock } = require('./playtime');

const CMD = '%command%';
const CACHE_TTL = 60 * 1000;

// 测试注入（与 store.init 同款做法）：指向临时 Steam 目录、强制 Steam 运行状态，
// 这样文件读写链路（备份 / 幂等 / 清空）能在冒烟测试里真跑一遍，而不是只测纯函数。
let override = { steamPath: null, steamRunning: null };

function init(opts = {}) {
  override.steamPath = opts.steamPath || null;
  override.steamRunning = typeof opts.steamRunning === 'boolean' ? opts.steamRunning : null;
  invalidate();
}

/* ------------------------------------------------------------- VDF 字符串 */

function escapeVdf(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeVdf(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

/* --------------------------------------------------- %command% 双向换算 */

/**
 * Steam 启动项 → 管家用的启动参数。
 * 有 %command% 时只取它后面的部分（前面的 gamemoderun / mangohud 之类是 Steam 侧的包装命令）。
 */
function toLocalArgs(steamValue) {
  const s = String(steamValue == null ? '' : steamValue);
  const i = s.indexOf(CMD);
  if (i < 0) return s.trim();
  return s.slice(i + CMD.length).trim();
}

/**
 * 管家参数 → 写回 Steam 的值。
 * 原值带 %command% 时保留它前面的包装命令，只替换 %command% 后面的参数；
 * 不带 %command%（绝大多数情况）时直接就是参数本身——Steam 会把它拼到游戏命令行后面。
 */
function toSteamValue(currentSteamValue, args) {
  const cur = String(currentSteamValue == null ? '' : currentSteamValue);
  const val = String(args == null ? '' : args).trim();
  const i = cur.indexOf(CMD);
  if (i < 0) return val;
  const pre = cur.slice(0, i);
  return (pre + CMD + (val ? ' ' + val : '')).trim();
}

/* ---------------------------------------------------------- 文本级读写 */

/** 取某个缩进（第一个带引号的行的前导空白），用于插入新行/新块 */
function inferIndent(text, fallback) {
  const m = /^([ \t]+)"/m.exec(text || '');
  return m ? m[1] : (fallback || '\t\t\t\t\t');
}

/** 定位 Software/Valve/Steam/apps 块（返回相对原文的绝对区间） */
function locateApps(text) {
  const sw = findBlock(text, 'Software');
  if (!sw) return null;
  const va = findBlock(sw.text, 'Valve');
  if (!va) return null;
  const st = findBlock(va.text, 'Steam');
  if (!st) return null;
  const ap = findBlock(st.text, 'apps');
  if (!ap) return null;
  const base = sw.start + va.start + st.start + ap.start;
  return { start: base, end: base + ap.text.length, text: ap.text };
}

/**
 * 从 localconfig.vdf 全文解析出所有启动项。
 * @returns {Object<string,string>} appid -> LaunchOptions 原文
 */
function readFromText(text) {
  const map = {};
  const apps = locateApps(text);
  if (!apps) return map;
  // ⚠ appid 行与 '{' 之间是**换行**（5 个 tab + "appid" + \n + 5 个 tab + {），
  //    这里必须用 \s* 而不是 [ \t]* —— 用后者会一个都匹配不到，表现为「Steam 里明明有启动项却读不到」
  const re = /"(\d{2,8})"\s*\{/g;
  let m;
  while ((m = re.exec(apps.text))) {
    const blk = blockAt(apps.text, apps.text.indexOf('{', m.index));
    if (!blk) continue;
    const v = /"LaunchOptions"[ \t]*"((?:[^"\\]|\\.)*)"/i.exec(blk.text);
    if (!v) continue;
    const val = unescapeVdf(v[1]).trim();
    if (!val) continue;
    if (map[m[1]] === undefined) map[m[1]] = val;
  }
  return map;
}

/**
 * 纯函数：在 apps 块文本里设置 / 清除某个 appid 的 LaunchOptions。
 * 只增删/替换这一行，块内其余内容逐字节保留。
 * @param {string} appsText apps 块内部文本
 * @param {string|number} appid
 * @param {string} value 新值；空字符串 = 清除（删掉该行，与 Steam 清空启动项的行为一致）
 */
function setLaunchOptionInText(appsText, appid, value) {
  const key = String(appid);
  const val = String(value == null ? '' : value).trim();
  const line = val ? '"LaunchOptions"\t\t"' + escapeVdf(val) + '"' : '';

  // 同 readFromText：appid 与 '{' 之间隔着换行，只能 \s*
  const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*\\{');
  const m = re.exec(appsText);
  const blk = m ? blockAt(appsText, appsText.indexOf('{', m.index)) : null;

  if (blk) {
    const lineRe = /^([ \t]*)"LaunchOptions"[ \t]*"(?:[^"\\]|\\.)*"[^\r\n]*/im;
    const lm = lineRe.exec(blk.text);
    if (lm) {
      const abs = blk.start + lm.index;
      if (!val) {
        // 清空：整行删掉（含行尾换行）
        let end = abs + lm[0].length;
        if (appsText[end] === '\r') end++;
        if (appsText[end] === '\n') end++;
        return appsText.slice(0, abs) + appsText.slice(end);
      }
      return appsText.slice(0, abs) + lm[1] + line + appsText.slice(abs + lm[0].length);
    }
    if (!val) return appsText;   // 本来就没有 → 无需改动
    // 插到块首（缩进沿用块内第一行）
    const indent = inferIndent(blk.text, inferIndent(appsText) + '\t');
    return insertWithNewline(appsText, blk.start, blk.text, indent + line);
  }

  if (!val) return appsText;     // Steam 里没这个 appid 的记录，也没什么可清的
  // 该 appid 在 Steam 本地没有任何配置（从未启动过）→ 在 apps 块首补一个 appid 块
  const indent = inferIndent(appsText);
  const chunk = indent + '"' + key + '"\n'
    + indent + '{\n'
    + indent + '\t' + line + '\n'
    + indent + '}';
  return insertWithNewline(appsText, 0, appsText, chunk);
}

/**
 * 在 host 文本的 pos（对应 raw = host.slice(pos)）处插入一段内容，
 * 自动处理前后换行，避免插入后多出空行或把两行并到一行。
 */
function insertWithNewline(host, pos, raw, body) {
  const lead = /^\r\n/.test(raw) ? 2 : (/^\n/.test(raw) ? 1 : 0);
  const at = pos + lead;
  const ins = (lead ? '' : '\n') + body + '\n';
  return host.slice(0, at) + ins + host.slice(at);
}

/* ------------------------------------------------------------ 文件系统 */

/** Steam 安装目录（注册表；读不到返回 null） */
function steamPathNow() {
  if (override.steamPath && fs.existsSync(override.steamPath)) return override.steamPath;
  try {
    const p = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 忽略 */ }
  return null;
}

/** 当前登录的 Steam 账号（userdata 下的目录名就是它） */
function activeAccount() {
  try {
    const v = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'ActiveUser');
    if (v && String(v).trim()) return String(v).trim();
  } catch (e) { /* 忽略 */ }
  return null;
}

/** 全部账号的 localconfig.vdf，当前登录账号排最前，其余按修改时间从新到旧 */
function configFiles() {
  const sp = steamPathNow();
  if (!sp) return [];
  const out = [];
  try {
    const dir = path.join(sp, 'userdata');
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
      const file = path.join(dir, e.name, 'config', 'localconfig.vdf');
      let st;
      try { st = fs.statSync(file); } catch (err) { continue; }
      out.push({ account: e.name, file, mtime: st.mtimeMs });
    }
  } catch (e) { return []; }
  const act = activeAccount();
  out.sort((a, b) => (b.account === act) - (a.account === act) || b.mtime - a.mtime);
  return out;
}

let cache = { at: 0, data: null };

/**
 * 读取所有游戏在 Steam 里设置的启动项（带缓存；写回后自动失效）。
 * @returns {Object<string,string>} appid -> LaunchOptions 原文（未设置的不会出现在结果里）
 */
function readAll(force) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL) return cache.data;
  const map = {};
  for (const f of configFiles()) {
    let text;
    try { text = fs.readFileSync(f.file, 'utf8'); } catch (e) { continue; }
    if (text.indexOf('"LaunchOptions"') < 0) continue;   // 快速预检：整个文件都没有启动项
    const part = readFromText(text);
    for (const k of Object.keys(part)) if (map[k] === undefined) map[k] = part[k];
  }
  cache = { at: now, data: map };
  return map;
}

function invalidate() {
  cache = { at: 0, data: null };
}

/** Steam 客户端是否在运行（运行中写盘会被它内存里的状态覆盖 → 需要重启才生效） */
function isSteamRunning() {
  if (override.steamRunning !== null) return override.steamRunning;
  if (process.platform !== 'win32') return false;
  try {
    const r = spawnSync('tasklist', ['/NH', '/FO', 'CSV'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000,
    });
    return /"steam\.exe"/i.test(r.stdout || '');
  } catch (e) {
    return false;
  }
}

/**
 * 把某个游戏的启动项写回 Steam（空字符串 = 清除 Steam 侧的启动项）。
 * @returns {{ok:boolean, changed:boolean, steamRunning:boolean, file?:string, backup?:string, message:string}}
 */
function write(appid, value) {
  const steamRunning = isSteamRunning();
  const val = String(value == null ? '' : value).trim();
  const files = configFiles();
  if (!files.length) {
    return { ok: false, changed: false, steamRunning, message: '没找到 Steam 的 localconfig.vdf（未安装 Steam 或账号目录不可读），未同步到 Steam' };
  }
  const target = files[0];
  let text;
  try { text = fs.readFileSync(target.file, 'utf8'); } catch (e) {
    return { ok: false, changed: false, steamRunning, message: '读取 Steam 配置失败：' + e.message };
  }
  const apps = locateApps(text);
  if (!apps) {
    return { ok: false, changed: false, steamRunning, message: 'Steam 配置结构无法识别（未找到 apps 节点），未同步到 Steam' };
  }

  const cur = readFromText(text)[String(appid)] || '';
  const next = toSteamValue(cur, val);
  const sameMsg = steamRunning
    ? 'Steam 启动项已是该值（Steam 正在运行，重启后才读到新值）'
    : 'Steam 启动项已是该值，无需改动';
  if (next === cur) return { ok: true, changed: false, steamRunning, file: target.file, message: sameMsg };

  const newApps = setLaunchOptionInText(apps.text, appid, next);
  if (newApps === apps.text) {
    return { ok: true, changed: false, steamRunning, file: target.file, message: sameMsg };
  }
  const newText = text.slice(0, apps.start) + newApps + text.slice(apps.end);

  const backup = target.file + '.glbak';
  try {
    fs.copyFileSync(target.file, backup);          // 先备份，再写
    fs.writeFileSync(target.file, newText, 'utf8');
  } catch (e) {
    return { ok: false, changed: false, steamRunning, file: target.file, message: '写入 Steam 配置失败：' + e.message };
  }
  invalidate();
  log('steamlaunch', `启动项写入 appid=${appid} 账号=${target.account} Steam运行中=${steamRunning} 值="${next}"` +
    (cur ? ` 原值="${cur}"` : ' 原值=(空)'));
  return {
    ok: true, changed: true, steamRunning, file: target.file, backup,
    message: steamRunning
      ? '已写入 Steam 启动项，但 Steam 正在运行——重启 Steam 后生效'
      : '已同步到 Steam 启动项',
  };
}

module.exports = {
  init,
  toLocalArgs,
  toSteamValue,
  setLaunchOptionInText,
  readFromText,
  locateApps,
  readAll,
  invalidate,
  isSteamRunning,
  write,
  configFiles,
};
