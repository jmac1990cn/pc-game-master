'use strict';

/**
 * DLC 管理模块。
 *
 * 各平台在各自平台内调用数据查询（不跨平台）：
 *   - Steam ：读本机已安装的 `appmanifest_<appid>.acf` 的 `InstalledDepots.dlcappid`
 *             ∩ 商店 API 的 `data.dlc` 全量清单，再用 IStoreBrowseService 批量取中文名；
 *             不在商店清单里的 dlcappid（免费/已下架）也按「已安装」显示。
 *   - Epic  ：扫 `C:\ProgramData\Epic\...\Manifests\*.item`，DLC 是独立 .item 文件，
 *             `AppCategories` 含 "dlc" 且 `MainGameAppName` 等于本体 AppName 即视为该游戏的 DLC。
 *   - 非 Steam 平台但填了 Steam appid（Epic / 战网 / 育碧 / Xbox / 手动）：
 *             按该 appid 拉商店的全部 DLC 清单，让用户自己勾选「已拥有」的那几项
 *             （平台副本无法从 Steam 安装清单判断，所以不做自动判定，只给清单）。
 *   - 其它：既不是 Steam/Epic 又没 appid → 不支持自动检测，只提供搜索入口。
 *
 * 本地缓存（`userData/dlc-cache.json`）：联网拿到的「商店 DLC 清单 + 中文名」按 appid 落盘，
 * 之后打开详情页只读缓存（零联网），只有点 ↻ 手动更新（opts.force=true）才重新联网。
 * 「已安装/已拥有」永远现算：Steam 读本地 manifest、其它平台取用户手动标记，不进缓存。
 *
 * 手动覆盖：通过 `game:setDlcManual` 把 `{[appid]: bool}` 落到 store 的 `dlcManual`，
 * 渲染时由 `mergeManual` 合并到列表之上（用户勾选优先）。
 */

const fs = require('fs');
const path = require('path');
const reg = require('./registry');       // 读 Steam 注册表路径
const scanner = require('./scanner');    // 复用 findSteamLibraries（库路径去重）
const netfetch = require('./netfetch');  // 走 Chromium 网络栈（带系统代理）
const store = require('./store');        // 只取 userData 目录（放缓存文件）

/* ============================ 纯函数（便于单测） ============================ */

/**
 * 从 appmanifest 文本里解析「已安装 DLC」的 appid 列表。
 * 只取 `InstalledDepots` 区块内的 `"dlcappid" "数字"`。
 * @param {string} text appmanifest_<appid>.acf 内容
 * @returns {string[]} dlc appid 字符串数组（去重、保序）
 */
function parseInstalledDlc(text) {
  if (!text) return [];
  const i = text.indexOf('"InstalledDepots"');
  if (i < 0) return [];
  let depth = 0;
  let started = false;
  let end = text.length;
  for (let p = i; p < text.length; p++) {
    const ch = text[p];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) { end = p; break; }
    }
  }
  const block = text.slice(i, end + 1);
  const out = [];
  const seen = new Set();
  const re = /"dlcappid"\s+"(\d+)"/g;
  let m;
  while ((m = re.exec(block))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * 判断一个 Epic manifest 对象是不是某本体游戏的 DLC。
 * @param {object} m 已 JSON.parse 的 .item 内容
 * @param {string} baseName 本体游戏的 AppName（用于与 m.MainGameAppName 比对）
 */
function isEpicDlcOf(m, baseName) {
  if (!m || !Array.isArray(m.AppCategories)) return false;
  if (!m.AppCategories.includes('dlc')) return false;
  return !!(baseName && m.MainGameAppName === baseName);
}

/**
 * 合并手动覆盖到自动检测列表。
 * @param {Array<{appid:string,name?:string,installed:boolean}>} list 自动检测结果
 * @param {Object<string,boolean>} manualMap 手动标记 {[appid]: bool}
 * @returns 合并后的列表（手动标记带 manual:true）
 */
function mergeManual(list, manualMap) {
  manualMap = manualMap || {};
  const items = (list || []).map(it => {
    const ov = manualMap[String(it.appid)];
    return ov === undefined ? it : Object.assign({}, it, { installed: !!ov, manual: true });
  });
  // 补上「自动没检测到、但用户手动标记过」的 DLC（appid 来源可信，如用户已知编号）
  const have = new Set((list || []).map(it => String(it.appid)));
  for (const k of Object.keys(manualMap)) {
    if (!have.has(k)) {
      items.push({ appid: k, name: 'DLC #' + k, installed: !!manualMap[k], manual: true });
    }
  }
  return items;
}

/** 在线搜索链接：h.juij.fun 用游戏名检索（keyword 需 URL 编码） */
function dlcSearchUrl(name) {
  return 'https://h.juij.fun/search/?keyword=' + encodeURIComponent(name || '');
}

/* ============================ 本地缓存（零联网复用） ============================ */

const CACHE_FILE = 'dlc-cache.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 正常清单：超过 7 天自动联网更新一次（手动更新随时可用）
const CACHE_TTL_FAIL_MS = 24 * 60 * 60 * 1000;       // 失败/空结果：只认 1 天，避免「查不到」被长期钉死

/** 缓存文件绝对路径（未 init store / 单测环境返回 null → 缓存自动降级为不写盘） */
function dlcCachePath() {
  try {
    const dir = store.getUserDataDir();
    return dir ? path.join(dir, CACHE_FILE) : null;
  } catch (e) {
    return null;
  }
}

function readCacheAll() {
  const p = dlcCachePath();
  if (!p) return {};
  try {
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (e) {
    return {};
  }
}

function writeCacheAll(obj) {
  const p = dlcCachePath();
  if (!p) return false;
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读某个 appid 的 DLC 清单缓存。
 * @returns {{ts:number,appid:string,items:Array<{appid:string,name:string}>,note?:string}|null}
 */
function readDlcCache(appid) {
  const e = readCacheAll()[String(appid)];
  if (!e || !Array.isArray(e.items)) return null;
  return e;
}

/** 写某个 appid 的 DLC 清单缓存（覆盖式，带时间戳） */
function writeDlcCache(appid, entry) {
  const all = readCacheAll();
  const rec = Object.assign({}, entry, { appid: String(appid), ts: Date.now() });
  all[String(appid)] = rec;
  writeCacheAll(all);
  return rec;
}

/** 删掉某个 appid 的缓存（返回是否删掉了东西） */
function clearDlcCache(appid) {
  const all = readCacheAll();
  const k = String(appid);
  if (!(k in all)) return false;
  delete all[k];
  writeCacheAll(all);
  return true;
}

/** 缓存是否还是新鲜的（失败/空结果只认 1 天，免得「一时连不上」被钉死很久） */
function isCacheFresh(entry) {
  if (!entry || !entry.ts) return false;
  const ttl = entry.failed ? CACHE_TTL_FAIL_MS : CACHE_TTL_MS;
  return (Date.now() - entry.ts) < ttl;
}

/* ============================ 平台查询实现 ============================ */

/** 读取某个 Steam 游戏的 appmanifest 文本（跨所有库查找） */
function readSteamManifest(appid) {
  if (!appid) return null;
  const steamPath = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath || !fs.existsSync(steamPath)) return null;
  const libs = scanner.findSteamLibraries(steamPath);
  for (const lib of libs) {
    const p = path.join(lib, 'steamapps', `appmanifest_${appid}.acf`);
    if (fs.existsSync(p)) {
      try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
    }
  }
  return null;
}

/**
 * 商店 API 取该游戏的全部 DLC appid（data.dlc 数组）。
 * 单 appid 查询正常；多 appid 批查当前坏（400），故一次只查一个。
 */
async function fetchStoreDlcList(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=schinese`;
  const j = await netfetch.getJson(url, { tries: 2, timeout: 15000 });
  const e = j && j[String(appid)];
  if (e && e.success && e.data && Array.isArray(e.data.dlc)) return e.data.dlc.map(String);
  return [];
}

/**
 * 批量取 DLC 中文名（IStoreBrowseService.GetItems，规避多 appid 商店 API 的 400）。
 * @returns {Object<string,string>} {appid: 名称}
 */
async function fetchDlcNames(appids) {
  if (!appids.length) return {};
  const inputs = {
    ids: appids.map(a => ({ appid: Number(a) })),
    context: { language: 'schinese', country_code: 'US', steam_realm: 1 },
    data_request: {
      include_basic_info: true,
      include_assets: false,
      include_release: false,
      include_platforms: false,
      include_all_purchase_options: false
    }
  };
  const url = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' +
    encodeURIComponent(JSON.stringify(inputs));
  const j = await netfetch.getJson(url, { tries: 2, timeout: 20000 });
  const map = {};
  const items = (j && j.response && j.response.store_items) || [];
  for (const it of items) {
    if (!it) continue;
    const a = String(it.appid);
    const nm = it.name || (it.basic_info && it.basic_info.name) || '';
    if (a) map[a] = nm;
  }
  return map;
}

/**
 * DLC 清单目录（带本地缓存）：缓存新鲜就直接用，否则联网（商店 dlc 数组 + 批量中文名）后落盘。
 * 联网失败但有旧缓存 → 用旧缓存兜底（标记 stale），绝不因为一次断网就把列表清空。
 * 注意 force（手动更新）也先读一份缓存当兜底：联网失败时用户看到的还是上次那份，不会被清空。
 *
 * @param {string} appid
 * @param {{force?:boolean, installedAppids?:string[]}} opts force=手动更新（绕过新鲜缓存、强制联网）
 * @returns {Promise<{appid:string,items:Array,note:string,cached:boolean,ts:number,failed?:boolean,stale?:boolean}>}
 */
async function getDlcCatalog(appid, opts = {}) {
  appid = String(appid || '');
  const cached = readDlcCache(appid);   // 永远读一份：既用于「新鲜就直接用」，也用于联网失败兜底
  if (!opts.force && cached && isCacheFresh(cached)) {
    return { appid, items: cached.items, note: cached.note || '', cached: true, ts: cached.ts || 0 };
  }

  let storeList = [];
  try { storeList = await fetchStoreDlcList(appid); } catch (e) { storeList = []; }

  // 全量 = 商店清单 ∪ 本地已装（已装可能含商店未列出的免费/下架项，离线时也是唯一来源）
  const allAppids = [];
  const seen = new Set();
  for (const a of storeList.concat(opts.installedAppids || [])) {
    const s = String(a);
    if (!seen.has(s)) { seen.add(s); allAppids.push(s); }
  }

  let nameMap = {};
  if (allAppids.length) {
    try { nameMap = await fetchDlcNames(allAppids); } catch (e) { nameMap = {}; }
  }

  const items = allAppids.map(a => ({ appid: a, name: nameMap[a] || ('DLC #' + a) }));

  if (!items.length) {
    // 联网没拿到东西：有旧缓存就继续用，别把已下载的清单丢了
    if (cached) {
      return {
        appid, items: cached.items, note: '联网更新失败，仍显示上次缓存',
        cached: true, ts: cached.ts || 0, stale: true, failed: true
      };
    }
    // 「查不到 / 连不上」也落一条负结果缓存（TTL 1 天）：避免每次打开详情页都默默重试一遍
    const note = '未获取到该游戏的 DLC 清单（商店无 DLC 数据或网络不可用），可稍后点「↻ 更新」重试';
    const rec = writeDlcCache(appid, { items: [], note, failed: true });
    return { appid, items: [], note, cached: false, ts: (rec && rec.ts) || Date.now(), failed: true };
  }

  const rec = writeDlcCache(appid, { items, note: '' });
  return { appid, items, note: '', cached: false, ts: rec.ts };
}

/** 取出 game 对应的 Steam appid（手动游戏的 appid 字段 / id 里的数字） */
function gameAppid(game) {
  if (!game) return '';
  if (game.appid) return String(game.appid);
  const id = String(game.id || '');
  if (id.startsWith('steam:')) return id.split(':')[1] || '';
  return '';
}

/** Steam 平台：本地安装清单（现读）∩ 商店全量清单（缓存优先） */
async function getSteamDlc(game, opts = {}) {
  const appid = gameAppid(game);
  const installedAppids = parseInstalledDlc(readSteamManifest(appid));
  const cat = await getDlcCatalog(appid, { force: opts.force, installedAppids });

  const byAppid = new Map(cat.items.map(i => [String(i.appid), i.name]));
  for (const a of installedAppids) if (!byAppid.has(a)) byAppid.set(a, '');   // 商店没列出的（免费/下架/离线）

  const items = [...byAppid.entries()].map(([a, nm]) => ({
    appid: a,
    name: nm || ('DLC #' + a),
    installed: installedAppids.includes(a)
  }));

  let note = cat.note || '';
  if (!installedAppids.length && !cat.items.length) {
    note = note || '未检测到该游戏的 DLC（或读取安装清单失败）';
  } else if (!cat.items.length) {
    note = '商店 DLC 清单暂不可用，仅显示本地安装清单里的内容';
  } else if (!installedAppids.length) {
    note = note || '本地安装清单里没有 DLC（商店清单已列出，可手动勾选核对）';
  }

  return {
    platform: 'steam',
    supported: true,
    source: 'steam',
    appid,
    items,
    installed: items.filter(i => i.installed).map(i => i.appid),
    uninstalled: items.filter(i => !i.installed).map(i => i.appid),
    cached: !!cat.cached,
    ts: cat.ts || 0,
    note
  };
}

/** Epic：本地 .item 里归属本体的 DLC（返回带 installed:true 的原始项） */
function epicLocalDlcItems(game) {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const manifestDir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  if (!fs.existsSync(manifestDir)) return [];
  const files = fs.readdirSync(manifestDir).filter(f => f.endsWith('.item'));

  // 先定位本体 manifest，拿到它的 AppName 作为匹配基准
  let baseName = null;
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(manifestDir, f), 'utf8'));
      const mid = `epic:${m.CatalogItemId || m.AppName || (m.DisplayName || m.AppName)}`;
      if (mid === game.id || (m.DisplayName || m.AppName) === game.name) {
        baseName = m.AppName || m.DisplayName || m.MainGameAppName || baseName;
        break;
      }
    } catch (e) { /* 单个坏文件忽略 */ }
  }
  if (!baseName) baseName = game.name; // 兜底：用显示名匹配

  const items = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(manifestDir, f), 'utf8'));
      if (!isEpicDlcOf(m, baseName)) continue;
      const appid = m.CatalogItemId || m.AppName || m.DisplayName || '';
      if (!appid || seen.has(appid)) continue;
      seen.add(appid);
      items.push({
        appid,
        name: m.DisplayName || m.AppName || appid,
        installed: true // Epic 本地清单里出现即视为已安装
      });
    } catch (e) { /* 单个坏文件忽略 */ }
  }
  return items;
}

/**
 * Epic 平台：本地清单（真实已装）+ 若填了 Steam appid 则并入商店全量清单（未装项供手动勾选）。
 */
async function getEpicDlc(game, opts = {}) {
  const local = epicLocalDlcItems(game);
  const appid = gameAppid(game);
  if (!appid) {
    return {
      platform: 'epic',
      supported: true,
      source: 'epic',
      appid: null,
      items: local,
      installed: local.map(i => i.appid),
      uninstalled: [],
      cached: false,
      ts: 0,
      note: local.length ? '' : '该 Epic 游戏没有检测到 DLC；可在「管理」里填 Steam appid 后拉取全部 DLC 自行勾选'
    };
  }

  const cat = await getDlcCatalog(appid, { force: opts.force });
  const byAppid = new Map(cat.items.map(i => [String(i.appid), { appid: String(i.appid), name: i.name, installed: false }]));
  for (const l of local) {
    const k = String(l.appid);
    if (byAppid.has(k)) byAppid.get(k).installed = true;   // 本地清单能对上 → 已装
    else byAppid.set(k, l);                                // 本地装了但商店清单没有
  }
  const items = [...byAppid.values()];
  return {
    platform: 'epic',
    supported: true,
    source: 'epic',
    appid,
    items,
    installed: items.filter(i => i.installed).map(i => i.appid),
    uninstalled: items.filter(i => !i.installed).map(i => i.appid),
    cached: !!cat.cached,
    ts: cat.ts || 0,
    note: items.length
      ? `已并入 Steam appid ${appid} 的全部 DLC 清单，可手动勾选已拥有的项`
      : (cat.note || '未检测到该游戏的 DLC')
  };
}

/**
 * 非 Steam 平台 + 有 Steam appid：按 appid 拉商店全部 DLC，让用户自己勾选「已有」。
 * 平台副本不由 Steam 管理，所以不做自动安装判定（installed 一律 false，靠手动标记）。
 */
async function getAppidDlc(game, opts = {}) {
  const appid = gameAppid(game);
  if (!appid) {
    return {
      platform: game && game.platform, supported: false, source: 'none',
      items: [], installed: [], uninstalled: [],
      note: '该平台不支持自动检测 DLC；可在「管理」里填 Steam appid 后拉取全部 DLC 自行勾选'
    };
  }
  const cat = await getDlcCatalog(appid, { force: opts.force });
  const items = cat.items.map(i => ({ appid: String(i.appid), name: i.name, installed: false }));
  let note = `按 Steam appid ${appid} 列出全部 DLC，请勾选你已拥有的项`;
  if (!items.length) note = cat.note || `未获取到 appid ${appid} 的 DLC 清单`;
  return {
    platform: game && game.platform,
    supported: true,
    source: 'steam-appid',
    appid,
    items,
    installed: [],
    uninstalled: items.map(i => i.appid),
    cached: !!cat.cached,
    ts: cat.ts || 0,
    note
  };
}

/**
 * 分发器：按平台选数据源。
 * @param {object} game
 * @param {{force?:boolean}} opts force=手动更新（联网重查并覆盖本地缓存）
 */
async function getDlc(game, opts = {}) {
  if (!game) return { platform: null, supported: false, items: [], note: '无游戏信息' };
  if (game.platform === 'steam') return await getSteamDlc(game, opts);
  if (game.platform === 'epic') return await getEpicDlc(game, opts);
  if (gameAppid(game)) return await getAppidDlc(game, opts);   // 非 Steam 平台 + 有 Steam appid
  return {
    platform: game.platform,
    supported: false,
    source: 'none',
    items: [],
    note: '该平台不支持自动检测 DLC；可在「管理」里填 Steam appid 后拉取全部 DLC 自行勾选，或用下方搜索核对'
  };
}

module.exports = {
  parseInstalledDlc,   // 纯函数：解析 appmanifest 已装 DLC
  isEpicDlcOf,         // 纯函数：判断 Epic .item 是否某游戏 DLC
  mergeManual,         // 纯函数：合并手动覆盖
  dlcSearchUrl,        // 纯函数：生成在线搜索链接
  dlcCachePath,        // 本地缓存文件路径
  readDlcCache,        // 读缓存
  writeDlcCache,       // 写缓存
  clearDlcCache,       // 清缓存
  isCacheFresh,        // 缓存是否新鲜
  getDlcCatalog,       // 清单目录（缓存优先，force 联网）
  gameAppid,           // 取游戏 appid
  getSteamDlc,
  getEpicDlc,
  getAppidDlc,
  getDlc
};
