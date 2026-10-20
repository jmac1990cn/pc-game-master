'use strict';

/**
 * 存档目录探测：一键直达游戏存档位置。
 *
 * Windows 上游戏存档散落在很多地方，这里按「命中概率」依次探测：
 *   1. 用户手动指定的存档目录（最高优先级）
 *   2. Steam 云存档目录   <Steam>\userdata\<账号ID>\<appid>\（含 remote 子目录）
 *   3. 我的文档            Documents\<游戏名>、Documents\My Games\<游戏名>
 *   4. 保存的游戏          Saved Games\<游戏名>
 *   5. AppData             AppData\Roaming\<游戏名>、AppData\Local\<游戏名>、AppData\LocalLow\<游戏名>
 *   6. 安装目录下          <安装目录>\save|saves|SaveData|SaveGames 等
 *
 * 只返回「实际存在」的目录（自定义目录除外，即使暂不存在也回显，便于用户确认）。
 */

const fs = require('fs');
const path = require('path');
const reg = require('./registry');

/* ----------------------------- 工具 ----------------------------- */

function exists(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** 目录浅层信息：条目数 + 最后修改时间（用于界面上区分哪个才是真存档） */
function describe(dir) {
  let entries = 0, last = 0;
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    entries = list.length;
    for (const e of list.slice(0, 40)) {
      try {
        const st = fs.statSync(path.join(dir, e.name));
        if (st.mtimeMs > last) last = st.mtimeMs;
      } catch (e2) {}
    }
  } catch (e) {}
  return { entries, lastModified: last || null };
}

/** 游戏名的各种写法：中文名 / 英文名 / 安装目录名 / exe 名，并做常见变形 */
function nameVariants(game) {
  const raw = [];
  if (game.name) raw.push(game.name);
  if (game.nameEn) raw.push(game.nameEn);
  if (game.installPath) raw.push(path.basename(game.installPath));
  if (game.executable) raw.push(path.basename(game.executable).replace(/\.exe$/i, ''));

  const out = new Set();
  for (const n of raw) {
    const s = String(n || '').trim();
    if (!s) continue;
    out.add(s);
    // 去掉 Windows 文件名非法字符（"只狼：影逝二度" → "只狼影逝二度"）
    const clean = s.replace(/[:：]/g, '').replace(/[\\/:*?"<>|]/g, '').trim();
    if (clean && clean !== s) out.add(clean);
    // 去掉副标题（"只狼：影逝二度" → "只狼"、"A - B" → "A"）；两字短名也要保留（很多游戏存档目录就用短名）
    const head = s.split(/[:：\-–—]/)[0].trim();
    if (head && head.length >= 2 && head !== s) out.add(head);
    // 去掉空格与下划线（"My Game" → "MyGame" / "My_Game"）
    const nospace = s.replace(/\s+/g, '');
    if (nospace && nospace !== s) out.add(nospace);
    const underscore = s.replace(/\s+/g, '_');
    if (underscore && underscore !== s) out.add(underscore);
  }
  return [...out].filter(s => s.length >= 2).slice(0, 24);
}

/* ----------------------------- 各来源 ----------------------------- */

function steamUserdataRoots() {
  const roots = [];
  const steamPath = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath) return roots;
  const ud = path.join(steamPath, 'userdata');
  if (!exists(ud)) return roots;
  try {
    for (const e of fs.readdirSync(ud, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d+$/.test(e.name)) roots.push(path.join(ud, e.name));
    }
  } catch (e) {}
  return roots;
}

/**
 * 探测某款游戏的候选存档目录。
 * @param {Object} game 已合并配置的游戏对象（name/nameEn/installPath/executable/appid/platform/saveDir）
 * @returns {Array<{path:string, source:string, exists:boolean, entries:number, lastModified:number|null}>}
 */
function findSaveDirs(game) {
  const out = [];
  const seen = new Set();
  const push = (p, source, force = false) => {
    if (!p) return;
    let norm;
    try { norm = path.normalize(p); } catch (e) { norm = p; }
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    const ok = exists(norm);
    if (!ok && !force) return;
    seen.add(key);
    const info = ok ? describe(norm) : { entries: 0, lastModified: null };
    out.push({
      path: norm,
      source,
      exists: ok,
      entries: info.entries,
      lastModified: info.lastModified
    });
  };

  // 1) 用户自定义
  if (game.saveDir) push(game.saveDir, '自定义', true);

  const variants = nameVariants(game);

  // 2) Steam 云存档
  if (game.platform === 'steam' && game.appid) {
    for (const root of steamUserdataRoots()) {
      const base = path.join(root, String(game.appid));
      push(base, 'Steam 云存档');
      push(path.join(base, 'remote'), 'Steam 云存档');
    }
  }

  // 3~5) 用户目录下的常见位置
  const home = process.env.USERPROFILE || '';
  const appData = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
  const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
  const localLow = home ? path.join(home, 'AppData', 'LocalLow') : '';

  const bases = [];
  if (home) {
    bases.push([path.join(home, 'Saved Games'), '保存的游戏']);
    bases.push([path.join(home, 'Documents', 'My Games'), '我的文档']);
    bases.push([path.join(home, 'Documents'), '我的文档']);
  }
  if (appData) bases.push([appData, 'AppData']);
  if (localAppData) bases.push([localAppData, 'AppData']);
  if (localLow) bases.push([localLow, 'LocalLow']);

  for (const [base, source] of bases) {
    if (!exists(base)) continue;
    for (const v of variants) push(path.join(base, v), source);
  }

  // 6) 安装目录下的常见存档子目录
  if (game.installPath && exists(game.installPath)) {
    for (const sub of ['save', 'saves', 'SaveData', 'SaveGames', 'savegame', 'SaveData', 'saved', 'Saved Games', 'Profile', 'profiles']) {
      push(path.join(game.installPath, sub), '安装目录');
    }
    for (const v of variants.slice(0, 6)) {
      push(path.join(game.installPath, v), '安装目录');
    }
  }

  // 排序：自定义 > Steam 云存档 > 其他；同类按最近修改时间倒序
  const weight = { '自定义': 0, 'Steam 云存档': 1, '保存的游戏': 2, '我的文档': 3, 'AppData': 4, 'LocalLow': 5, '安装目录': 6 };
  out.sort((a, b) => {
    const wa = weight[a.source] !== undefined ? weight[a.source] : 9;
    const wb = weight[b.source] !== undefined ? weight[b.source] : 9;
    if (wa !== wb) return wa - wb;
    return (b.lastModified || 0) - (a.lastModified || 0);
  });

  return out.slice(0, 12);
}

module.exports = { findSaveDirs, nameVariants };
