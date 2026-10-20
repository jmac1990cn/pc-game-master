'use strict';

/**
 * 多平台游戏扫描器。
 * 每个平台独立 try/catch，失败时返回空数组，不影响其它平台与手动添加的游戏。
 * 扫描结果为“检测到的游戏”列表，main 进程会再与本地配置（自定义背景/改器）合并。
 */

const fs = require('fs');
const path = require('path');
const reg = require('./registry');

const PLATFORM_NAMES = {
  steam: 'Steam',
  epic: 'Epic',
  battlenet: '战网',
  ubisoft: '育碧',
  xbox: 'Xbox',
  manual: '手动'
};

// 战网产品代码 -> 显示名
const BNET_GAMES = {
  wow: '魔兽世界',
  wow_classic: '魔兽世界（怀旧服）',
  wow_classic_beta: '魔兽世界（怀旧服测试）',
  d3: '暗黑破坏神 III',
  sc2: '星际争霸 II',
  wtcg: '炉石传说',
  ow: '守望先锋',
  ow2: '守望先锋 2',
  pro: 'Call of Duty',
  fore: '使命召唤：黑色行动 4',
  viper: '使命召唤：先锋',
  laurel: '使命召唤',
  odin: '使命召唤'
};

/**
 * 战网产品代码 → 中文名（大小写不敏感）。
 * 注册表与官方协议里的代码是 Pro / WTCG / D3 这种大小写形式，而本表键为小写，
 * 故统一转小写后再查；否则官方代码查不到名字，会退化成乱码或代码本身。
 */
function bnetDisplayName(code) {
  if (!code) return null;
  return BNET_GAMES[String(code).toLowerCase()] || null;
}

function makeGame(o) {
  return Object.assign(
    {
      id: '',
      name: '未知游戏',
      platform: 'steam',
      appid: null,
      cover: null,
      background: null,
      defaultBackground: null,
      executable: null,
      launchCommand: null,
      installPath: null,
      icon: null
    },
    o
  );
}

/* ----------------------------- Steam ----------------------------- */

function readVdfKeyValues(filePath) {
  // 极简 VDF 解析：返回顶层键 -> 值 或 嵌套对象（这里只取需要的文本）
  const text = fs.readFileSync(filePath, 'utf8');
  const result = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/"([^"]+)"\s+"([^"]*)"/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/**
 * 规范化库路径，用于「同一目录只算一次」的判断。
 * 必须处理两种来源的差异，否则同一个库会被当成两个：
 *   - 注册表 SteamPath 返回 `d:/steam`（正斜杠、可能小写）
 *   - libraryfolders.vdf 的 "path" 是 VDF 转义过的 `D:\\steam`（双反斜杠）
 */
function normalizeLibPath(p) {
  if (!p) return null;
  const s = String(p).replace(/\\\\/g, '\\').trim();   // 还原 VDF 转义
  if (!s) return null;
  return s.replace(/[\\/]+/g, '/').replace(/\/+$/, ''); // 统一分隔符 + 去掉结尾斜杠
}

function findSteamLibraries(steamPath) {
  const seen = new Set();
  const libs = [];

  const add = (p) => {
    const norm = normalizeLibPath(p);
    if (!norm) return;
    const key = norm.toLowerCase();      // Windows 路径不区分大小写
    if (seen.has(key)) return;
    seen.add(key);
    libs.push(norm.split('/').join(path.sep));
  };

  add(steamPath);

  const lf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(lf)) {
    const text = fs.readFileSync(lf, 'utf8');
    let m;
    // 新格式: "path"  "D:\\..."
    const re1 = /"path"\s+"([^"]+)"/g;
    while ((m = re1.exec(text))) add(m[1]);
    // 旧格式: "1"  "D:\\..."
    const re2 = /"\d+"\s+"([A-Za-z]:[\\/][^"]*)"/g;
    while ((m = re2.exec(text))) add(m[1]);
  }
  return libs;
}

function scanSteam() {
  const games = [];
  try {
    const steamPath = reg.readRegValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (!steamPath || !fs.existsSync(steamPath)) return games;

    const libraries = findSteamLibraries(steamPath);
    for (const lib of libraries) {
      const appDir = path.join(lib, 'steamapps');
      if (!fs.existsSync(appDir)) continue;
      const files = fs.readdirSync(appDir).filter(f => /^appmanifest_\d+\.acf$/.test(f));
      for (const f of files) {
        try {
          const kv = readVdfKeyValues(path.join(appDir, f));
          const appid = kv.appid;
          const name = kv.name || 'Steam 游戏';
          if (!appid) continue;
          // 跳过 Steam 组件（如 Steamworks Common Redistributables、各类 SDK、运行库等），不当作游戏列出
          if (/redistributable|steamworks|common redist|\bsdk\b|visual c\+\+|directx|microsoft.*runtime/i.test(name)) continue;
          const exes = reg.readRegValue(
            `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App ${appid}`,
            'DisplayIcon'
          );
          const executable = reg.cleanExeFromIcon(exes);
          games.push(
            makeGame({
              id: `steam:${appid}`,
              name,
              platform: 'steam',
              cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
              background: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
              defaultBackground: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
              executable,
              launchCommand: executable
                ? null
                : `steam://rungameid/${appid}`,
              installPath: kv.installdir
                ? path.join(appDir, 'common', kv.installdir)
                : null,
              icon: executable || null
            })
          );
        } catch (e) {
          /* 单个 manifest 出错忽略 */
        }
      }
    }
  } catch (e) {
    console.error('Steam 扫描失败', e);
  }
  return games;
}

/* ----------------------------- Epic ----------------------------- */

/**
 * 纯函数：拼 Epic 官方启动 URI（导出便于单测）。
 *
 * 官方文档（Epic Games Store Protocol Activation）三段式，**顺序是
 *   命名空间 : CatalogItemId : AppName**
 *   com.epicgames.launcher://apps/<CatalogNamespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true
 * 例：Fortnite → com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true
 *     （`fn` 就是 Fortnite 的 CatalogNamespace，最后一段是可读的 AppName）
 *
 * ⚠ 顺序不能错（v1.1.9 教训）：早期写成 AppName 在前，Epic 会把**最后一段**当应用 ID 查所有权，
 * 报错「Application Not Owned — 本账户不具有 <CatalogNamespace> 的所有权」，游戏不启动。
 *
 * 三段之间用 %3A（编码后的冒号）连接；字段缺失时逐级降级（缺 Namespace → 两段）。
 */
function buildEpicUri(m) {
  const parts = [m && m.CatalogNamespace, m && m.CatalogItemId, m && m.AppName].filter(Boolean);
  if (!parts.length) return null;
  return `com.epicgames.launcher://apps/${parts.join('%3A')}?action=launch&silent=true`;
}

/**
 * 纯函数：战网游戏的启动命令（导出便于单测）。
 *
 * 官方启动方式是客户端命令行开关：`"<Battle.net.exe>" --exec="launch <产品代码>"`
 * （Playnite / Steam 社区通用的做法，代码示例：WTCG=炉石、WoW=魔兽、D3=暗黑3、Pro=守望、S2=星际2…）。
 *
 * `battlenet://<代码>` 协议在部分环境（尤其国服客户端）只会把客户端唤起/登录、
 * **不触发游戏启动**（实机现象：战网会登录，不启动游戏），因此只在找不到 Battle.net.exe 时用它兜底。
 */
function buildBnetLaunchCommand(code, launcher) {
  if (launcher && fs.existsSync(launcher)) {
    return `"${launcher}" --exec="launch ${code}"`;
  }
  return `battlenet://${code}`;
}

function scanEpic() {
  const games = [];
  try {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const manifestDir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    if (!fs.existsSync(manifestDir)) return games;
    const files = fs.readdirSync(manifestDir).filter(f => f.endsWith('.item'));
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(manifestDir, f), 'utf8'));
        // 跳过 DLC / 非主游戏（可选）
        const name = m.DisplayName || m.AppName || 'Epic 游戏';
        const installLocation = m.InstallLocation || '';
        let executable = null;
        if (m.LaunchExecutable && installLocation) {
          executable = path.resolve(installLocation, m.LaunchExecutable);
          if (!fs.existsSync(executable)) executable = null;
        }
        games.push(
          makeGame({
            id: `epic:${m.CatalogItemId || m.AppName || name}`,
            name,
            platform: 'epic',
            cover: null,
            background: null,
            defaultBackground: null,
            executable,
            // 始终给出 Epic 官方启动 URI（Playnite 同款）。Epic 游戏强依赖 EGL 会话/鉴权，
            // 直接跑 exe 会被判定为「无有效会话」而自退；URI 把启动交给客户端：
            // 系统唤起 EGL → 客户端完成登录与 DRM 校验 → 客户端拉起游戏。
            launchCommand: buildEpicUri(m),
            installPath: installLocation,
            icon: executable
          })
        );
      } catch (e) {
        /* 单个 manifest 出错忽略 */
      }
    }
  } catch (e) {
    console.error('Epic 扫描失败', e);
  }
  return games;
}

/* ----------------------------- 战网 (Battle.net / 国服) -----------------------------
 * 启动走官方客户端命令行：`"<Battle.net.exe>" --exec="launch <产品代码>"`（WTCG=炉石、WoW=魔兽、
 * D3=暗黑3、Pro=守望、S2=星际2 …）。流程：调用客户端 → 客户端完成登录校验 → 客户端拉起游戏本体。
 * `battlenet://<代码>` 协议在国服客户端只会唤起/登录、不启动游戏（实机验证），仅作找不到客户端时的兜底。
 * 战网没有官方方式绕过客户端直接运行游戏 exe（会被提示需要登录并立即自退），故不再直接 spawn 游戏 exe。
 * --------------------------------------------------------------------------------- */

// 卸载表子键/显示名 -> 战网官方产品代码（用于 --exec="launch <CODE>"；匹配不到时用子键小写兜底）
// 代码取自暴雪官方协议与社区公认值：WTCG=炉石、WoW=魔兽世界、D3=暗黑3、Hero=风暴英雄、Pro=守望先锋
const BNET_NAME_TO_CODE = {
  hearthstone: 'WTCG',
  'hearthstone and battlenet': 'WTCG',
  'world of warcraft': 'WoW',
  'world of warcraft classic': 'wow_classic',
  'diablo iii': 'D3',
  'diablo ii resurrected': 'OSI',
  'diablo iv': 'Fen',
  'starcraft ii': 'S2',
  starcraft: 'S1',
  'starcraft remastered': 'S1',
  'warcraft iii': 'W3',
  'warcraft iii reforged': 'W3',
  'heroes of the storm': 'Hero',
  overwatch: 'Pro',
  'overwatch 2': 'Pro',
  'destiny 2': 'DST2'
};

/** 名称归一化：小写、去掉所有非字母数字字符。用于跨来源比较游戏名。 */
function normalizeNameKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function detectBattleNetLauncher(settings) {
  if (settings && settings.battleNetLauncher && fs.existsSync(settings.battleNetLauncher)) {
    return settings.battleNetLauncher;
  }
  // 卸载表里查找 Battle.net
  const uninstallKey = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const candidates = [];
  try {
    const keys = reg.listRegSubKeys(uninstallKey);
    for (const k of keys) {
      if (/battle\.?net/i.test(k)) {
        const loc = reg.readRegValue(`${uninstallKey}\\${k}`, 'InstallLocation');
        if (loc) candidates.push(path.join(loc, 'Battle.net.exe'));
      }
    }
  } catch (e) {}
  const common = [
    'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
    'C:\\Program Files\\Battle.net\\Battle.net.exe',
    'C:\\Program Files (x86)\\NetEase\\Battle.net\\Battle.net.exe'
  ];
  for (const c of candidates.concat(common)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 来源 1（老）：HKCU\...\Battle.net\LaunchOptions\<code>\Executable。
 * 国际服老战网客户端会写这个键。
 */
function scanBNetLaunchOptions(launcher, games) {
  const key = 'HKCU\\Software\\Blizzard Entertainment\\Battle.net\\LaunchOptions';
  const codes = reg.listRegSubKeys(key);
  for (const code of codes) {
    if (code.toLowerCase() === 'battle.net' || code.toLowerCase() === 'bnet') continue;
    const exe = reg.readRegValue(`${key}\\${code}`, 'Executable');
    games.push(
      makeGame({
        id: `battlenet:${code.toLowerCase()}`,
        name: bnetDisplayName(code) || code.toUpperCase(),
        platform: 'battlenet',
        cover: null,
        background: null,
        defaultBackground: null,
        executable: exe && fs.existsSync(exe) ? exe : null,
        launchCommand: buildBnetLaunchCommand(code, launcher),
        installPath: exe ? path.dirname(exe) : null,
        icon: exe || null
      })
    );
  }
}

/**
 * 来源 2（新）：卸载表。国服战网 / 新版客户端不写 LaunchOptions（本机键名已变成
 * "Launch Options" 且无 Executable 结构），但已安装游戏在卸载表里一定有条目：
 * HKLM\...\Uninstall\Hearthstone → DisplayName=炉石传说、DisplayIcon=D:\Hearthstone\Hearthstone.exe。
 *
 * 性能关键：用 queryRegValuesRecursive 每个根键只 spawn 一次 reg.exe 拿全部 DisplayName，
 * 只对命中已知映射的条目再单独查 DisplayIcon。逐键查询会上千次 spawn，
 * 同步阻塞主进程分钟级（应用启动时同步刷新缓存，窗口都会被拖住）。
 */
function scanBNetUninstall(launcher, games) {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  const seenCodes = new Set(games.map(g => String(g.id).toLowerCase()));

  // 显示名里的乱码标记（reg.exe GBK 输出被误按 UTF-8 解码时会出现 U+FFFD）
  const isClean = (s) => !!s && !s.includes('\uFFFD');

  for (const root of roots) {
    try {
      const names = reg.queryRegValuesRecursive(root, 'DisplayName');
      for (const [k, displayName] of Object.entries(names)) {
        try {
          const lower = k.toLowerCase();
          // 排除启动器自身与通用框架
          if (/battle\.?net|^agent$|blizzard battle\.net/i.test(k)) continue;

          // 命中判定：子键名或显示名能映射到已知战网产品
          const nameKey = normalizeNameKey(displayName);
          let code = BNET_NAME_TO_CODE[lower] || null;
          if (!code) {
            for (const [n, c] of Object.entries(BNET_NAME_TO_CODE)) {
              if (nameKey && (nameKey === normalizeNameKey(n) || nameKey.includes(normalizeNameKey(n)))) {
                code = c;
                break;
              }
            }
          }
          // 中文名对照 BNET_GAMES 的值（如 "炉石传说"）
          if (!code) {
            for (const [c, cn] of Object.entries(BNET_GAMES)) {
              if (displayName && normalizeNameKey(cn) === nameKey) {
                code = c;
                break;
              }
            }
          }
          if (!code) continue; // 不是已知的暴雪游戏，跳过（避免把卸载表里其它软件拉进来）

          const id = `battlenet:${code.toLowerCase()}`;
          if (seenCodes.has(id)) continue;   // LaunchOptions 来源已收录
          seenCodes.add(id);

          // 只有命中的条目才查 DisplayIcon（个位数次 spawn）
          const exe = reg.cleanExeFromIcon(
            reg.readRegValue(`${root}\\${k}`, 'DisplayIcon')
          );

          // 显示名优先用标准中文名（注册表 GBK 乱码时注册表名不可读）
          const name = isClean(displayName)
            ? displayName
            : (bnetDisplayName(code) || displayName || k);

          games.push(
            makeGame({
              id,
              name,
              platform: 'battlenet',
              cover: null,
              background: null,
              defaultBackground: null,
              executable: exe && fs.existsSync(exe) ? exe : null,
              launchCommand: buildBnetLaunchCommand(code, launcher),
              installPath: exe ? path.dirname(exe) : null,
              icon: exe || null
            })
          );
        } catch (e) {
          /* 单条目出错忽略 */
        }
      }
    } catch (e) {
      /* 单个根键查询失败忽略 */
    }
  }
}

function scanBattleNet(settings) {
  const games = [];
  try {
    const launcher = detectBattleNetLauncher(settings);
    scanBNetLaunchOptions(launcher, games);
    scanBNetUninstall(launcher, games);

    // 按 id 去重：两个来源可能命中同一款游戏
    const seen = new Set();
    const out = [];
    for (const g of games) {
      const key = String(g.id).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
    return out;
  } catch (e) {
    console.error('战网扫描失败', e);
    return games;
  }
}

/* ----------------------------- 育碧 (Ubisoft Connect) ----------------------------- */

/**
 * 育碧的安装登记表有三处，必须都查：
 *   - HKLM\...\WOW6432Node\Ubisoft\Launcher\Installs  ← 老版启动器，唯一带 InstallDir 的地方
 *   - HKLM\SOFTWARE\Ubisoft\Launcher\Installs         ← 少数 64 位安装
 *   - HKCU\SOFTWARE\Ubisoft\Launcher\Installs         ← 新版 Ubisoft Connect 只在这里写 InstallState
 * 只查第一个会漏（新版装机 4 个 id 里只有 1 个在 HKLM 有路径）。
 */
const UBI_INSTALL_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
  'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs',
  'HKCU\\SOFTWARE\\Ubisoft\\Launcher\\Installs'
];

/** 育碧启动器自身的登记键（Installs 的父键，从中取启动器安装位置） */
const UBI_LAUNCHER_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher',
  'HKLM\\SOFTWARE\\Ubisoft\\Launcher'
];

/** 安装目录名 → 显示名：Watch_Dogs → Watch Dogs */
function prettyUbisoftName(dir) {
  const base = path.basename(String(dir || '').replace(/[\\/]+$/, ''));
  return base ? base.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim() : '';
}

/** 育碧游戏的根目录候选（启动器安装位置下的 games/ + 默认位置），只返回真实存在的 */
function ubisoftGamesRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const s = String(p).replace(/\//g, path.sep).replace(/[\\/]+$/, '');
    if (s && !roots.includes(s)) roots.push(s);
  };
  for (const k of UBI_LAUNCHER_KEYS) push(reg.readRegValue(k, 'InstallDir'));
  push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Ubisoft', 'Ubisoft Game Launcher'));
  return roots
    .map(r => path.join(r, 'games'))
    .filter(d => { try { return fs.existsSync(d); } catch (e) { return false; } });
}

function scanUbisoft() {
  const games = [];
  try {
    // 1) 注册表登记的游戏
    const ids = new Set();
    for (const k of UBI_INSTALL_KEYS) reg.listRegSubKeys(k).forEach(id => ids.add(id));

    for (const id of ids) {
      // 安装目录：HKLM(32 位) → HKLM(64 位) → HKCU
      let installDir = null;
      for (const k of UBI_INSTALL_KEYS) {
        const v = reg.readRegValue(`${k}\\${id}`, 'InstallDir');
        if (v) { installDir = v.replace(/\//g, path.sep).replace(/[\\/]+$/, ''); break; }
      }
      // 有 id 但没有安装目录：只是「安装状态」残留（游戏已卸载或不在本机），
      // 硬报出来会得到点不开的空条目，直接跳过。
      if (!installDir) continue;

      const onDisk = (() => { try { return fs.existsSync(installDir); } catch (e) { return false; } })();
      let executable = null;
      if (onDisk) {
        const exes = walkForExe(installDir);
        if (exes.length) executable = exes[0];
      }
      // 显示名：注册表 Name（老版启动器会写）→ 安装目录名兜底
      const name = reg.readRegValue(`${UBI_INSTALL_KEYS[0]}\\${id}`, 'Name')
        || prettyUbisoftName(installDir)
        || `育碧游戏 ${id}`;

      games.push(
        makeGame({
          id: `ubisoft:${id}`,
          name,
          platform: 'ubisoft',
          cover: null,
          background: null,
          defaultBackground: null,
          executable,
          // 始终给 uplay:// URI：育碧游戏依赖 Ubisoft Connect 会话，直接跑 exe 会因
          // 无有效会话立即退出。URI 由客户端拉起才稳（有 exe 也优先走 URI）。
          launchCommand: `uplay://launch/${id}/0`,
          installPath: installDir,
          icon: executable
        })
      );
    }

    // 2) 兜底：注册表没登记、但确实躺在育碧 games 目录里的（手动搬过安装位置等情况）
    const known = new Set(
      games.map(g => String(g.installPath || '').replace(/[\\/]+$/, '').toLowerCase()).filter(Boolean)
    );
    for (const root of ubisoftGamesRoots()) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch (e) { continue; }
      for (const d of dirs) {
        const full = path.join(root, d);
        if (known.has(full.toLowerCase())) continue;         // 已由注册表收录
        const exes = walkForExe(full);
        if (!exes.length) continue;                          // 没有 exe，跳过（避免误报）
        known.add(full.toLowerCase());
        games.push(
          makeGame({
            id: `ubisoft:folder:${d}`,
            name: prettyUbisoftName(full) || d,
            platform: 'ubisoft',
            cover: null,
            background: null,
            defaultBackground: null,
            executable: exes[0],
            launchCommand: null,
            installPath: full,
            icon: exes[0]
          })
        );
      }
    }
  } catch (e) {
    console.error('育碧扫描失败', e);
  }
  return games;
}

/** 在目录里找第一个 .exe（最多两层，避免过深扫描） */
function walkForExe(dir, depth = 0) {
  if (depth > 2) return [];
  let found = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        found = found.concat(walkForExe(p, depth + 1));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        found.push(p);
      }
      if (found.length >= 3) break;
    }
  } catch (e) {}
  return found;
}

/* ----------------------------- Xbox / Microsoft Store ----------------------------- */

/** 枚举可用盘符（C:–Z:） */
function listDrives() {
  const out = [];
  if (process.platform !== 'win32') return out;
  for (let i = 67; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch (e) {}
  }
  return out;
}

/**
 * 用 PowerShell 列出已安装的 Xbox/MSIX 游戏包：返回 Map<包名, {pfn, appId, installLocation}>
 * 判据：包内含 MicrosoftGame.config —— 这是 Xbox 打包游戏的标志文件，可精准排除系统应用。
 * （若系统 ACL 禁止读取该文件，则返回空，不会产生误报。）
 */
function listAppxPackages() {
  const map = new Map();
  if (process.platform !== 'win32') return map;
  const { spawnSync } = require('child_process');
  const ps = [
    "Get-AppxPackage | Where-Object { -not $_.IsFramework } | ForEach-Object {",
    "  $p = $_; try {",
    "    $loc = $p.InstallLocation; if (-not $loc) { return }",
    "    if (-not (Test-Path -LiteralPath (Join-Path $loc 'MicrosoftGame.config'))) { return }",
    "    $m = Get-AppxPackageManifest $p;",
    "    foreach ($a in $m.Package.Applications.Application) {",
    "      if ($a.Id) { \"$($p.Name)`t$($p.PackageFamilyName)`t$($a.Id)`t$loc\" }",
    "    }",
    "  } catch {}",
    "}"
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000
    });
    if (r.status !== 0 || !r.stdout) return map;
    for (const line of r.stdout.split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      map.set(parts[0].trim(), {
        pfn: parts[1].trim(),
        appId: parts[2].trim(),
        installLocation: (parts[3] || '').trim() || null
      });
    }
  } catch (e) {}
  return map;
}

/** 读取 Xbox 游戏的 MicrosoftGame.config，取显示名 / 包名 / 主 exe */
function readMicrosoftGameConfig(gameDir) {
  const candidates = [
    path.join(gameDir, 'MicrosoftGame.config'),
    path.join(gameDir, 'Content', 'MicrosoftGame.config')
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const xml = fs.readFileSync(f, 'utf8');
      const idn = xml.match(/<Identity\s[^>]*Name="([^"]+)"/i);
      const disp = xml.match(/DefaultDisplayName="([^"]+)"/i);
      const exe = xml.match(/<Executable\s[^>]*Name="([^"]+)"/i);
      return {
        identityName: idn ? idn[1] : null,
        displayName: disp ? disp[1] : null,
        executable: exe ? exe[1] : null
      };
    } catch (e) {}
  }
  return null;
}

/** 在游戏目录里挑主 exe：优先 MicrosoftGame.config 指定名 → 名字贴近 → 体积最大 */
function findMainExe(rootDir, preferNames) {
  const cands = [];
  const skipDir = /^(audio|sound|music|video|movies|cinematics|localization|locale|lang|languages|textures|assets|paks|shaders|redist|_commonredist|support|symbols|pdb|installers)$/i;
  const walk = (dir, depth) => {
    if (depth > 4 || cands.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (cands.length > 500) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDir.test(e.name)) walk(p, depth + 1);
      } else if (e.isFile() && /\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name)) {
        let size = 0;
        try { size = fs.statSync(p).size; } catch (e) {}
        cands.push({ path: p, name: e.name.replace(/\.exe$/i, ''), size });
      }
    }
  };
  walk(rootDir, 0);
  if (!cands.length) return null;
  // 1) 精确匹配期望名（MicrosoftGame.config 里的 Executable）
  for (const want of (preferNames || []).filter(Boolean)) {
    const w = String(want).replace(/\.exe$/i, '').toLowerCase();
    const hit = cands.find(c => c.name.toLowerCase() === w);
    if (hit) return hit.path;
  }
  // 2) 名字互为子串
  for (const want of (preferNames || []).filter(Boolean)) {
    const w = String(want).replace(/\.exe$/i, '').toLowerCase();
    if (w.length < 4) continue;
    const hit = cands.find(c => c.name.toLowerCase().includes(w) || w.includes(c.name.toLowerCase()));
    if (hit) return hit.path;
  }
  // 3) 体积最大者（主程序通常最大）
  cands.sort((a, b) => b.size - a.size);
  return cands[0].path;
}

/** 扫描 Xbox / Game Pass 游戏 */
function scanXbox(settings) {
  const games = [];
  try {
    const pkgMap = listAppxPackages();

    // 来源 1：XboxGames 目录（Xbox App 安装的 PC 游戏）
    for (const drive of listDrives()) {
      const root = path.join(drive, 'XboxGames');
      let dirs = [];
      try {
        if (!fs.existsSync(root)) continue;
        dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
      } catch (e) { continue; }

      for (const d of dirs) {
        // 跳过存档 / 系统目录
        if (/^(GameSave|GameDVR|Temp|Microsoft\.|WindowsApps|ModifiableWindowsApps)$/i.test(d.name)) continue;
        const gameDir = path.join(root, d.name);
        try {
          const cfg = readMicrosoftGameConfig(gameDir);
          const title = (cfg && cfg.displayName) || d.name;
          const exe = findMainExe(gameDir, [cfg && cfg.executable, d.name, title]);

          // 若能匹配到已安装的 Appx 包，用官方 AUMID 启动最稳（部分 Game Pass 游戏需经 Xbox 服务）
          let launchCommand = null;
          if (cfg && cfg.identityName) {
            const p = pkgMap.get(cfg.identityName);
            if (p && p.pfn && p.appId) launchCommand = `shell:AppsFolder\\${p.pfn}!${p.appId}`;
          }

          games.push(
            makeGame({
              id: `xbox:${d.name}`,
              name: title,
              platform: 'xbox',
              cover: null,
              background: null,
              defaultBackground: null,
              executable: exe || null,
              launchCommand,
              installPath: gameDir,
              icon: exe || null
            })
          );
        } catch (e) { /* 单个游戏出错忽略 */ }
      }
    }

    // 来源 2：直接列出 MSIX/Store 游戏包（已用 MicrosoftGame.config 精准过滤）
    if (settings && settings.scanXboxApps) {
      const seen = new Set(games.map(g => g.id));
      const dirs = games.map(g => g.installPath).filter(Boolean);
      // 名称归一化集合：XboxGames 目录形态与 WindowsApps 包形态路径完全不同，
      // 但名称是同一款（例：目录 "Wo Long- Fallen Dynasty" vs 包 "WoLongFallenDynasty"），
      // 路径前缀判重会漏，这里再加一道名称判重。
      const nameKeys = new Set(
        games.map(g => normalizeNameKey(g.name)).filter(Boolean)
      );
      for (const [pkgName, info] of pkgMap) {
        if (!info.pfn || !info.appId) continue;
        const id = `xbox:appx:${info.pfn}`;
        if (seen.has(id)) continue;
        // 已在 XboxGames 目录中列出过的同一个游戏，跳过避免重复
        const loc = info.installLocation || '';
        if (loc && dirs.some(d => loc.toLowerCase().startsWith(d.toLowerCase()))) continue;
        // 名称去重：包名去掉发行商前缀后与已收录游戏的归一化名比对
        const bareName = pkgName.includes('.') ? pkgName.split('.').slice(1).join('.') : pkgName;
        const pkgKey = normalizeNameKey(bareName);
        if (pkgKey && nameKeys.has(pkgKey)) continue;
        // 名称美化：去掉发行商前缀
        const title = bareName.replace(/([a-z])([A-Z])/g, '$1 $2');
        games.push(
          makeGame({
            id,
            name: title,
            platform: 'xbox',
            cover: null,
            background: null,
            defaultBackground: null,
            executable: null,
            launchCommand: `shell:AppsFolder\\${info.pfn}!${info.appId}`,
            installPath: info.installLocation,
            icon: null
          })
        );
        if (normalizeNameKey(title)) nameKeys.add(normalizeNameKey(title));
      }
    }
  } catch (e) {
    console.error('Xbox 扫描失败', e);
  }
  return games;
}

/* ----------------------------- 汇总 ----------------------------- */

function scanAll(settings) {
  let all = [];
  if (settings.scanSteam) all = all.concat(scanSteam());
  if (settings.scanEpic) all = all.concat(scanEpic());
  if (settings.scanBattleNet) all = all.concat(scanBattleNet(settings));
  if (settings.scanUbisoft) all = all.concat(scanUbisoft());
  if (settings.scanXbox) all = all.concat(scanXbox(settings));

  // 兜底去重：任何来源重复产出同一 id 时只保留第一条。
  // 页面按 id 渲染卡片，重复 id 会让同一款游戏出现两张封面。
  const seen = new Set();
  const out = [];
  for (const g of all) {
    if (!g || !g.id) continue;
    const key = String(g.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/* ----------------------------- 文件夹扫描（手动添加用） ----------------------------- */

// 常见非游戏 exe，直接跳过，减少误加
const SKIP_EXE = /^(unins\d+|vc_redist|vc_redist\.\w+|dxwebsetup|directxsetup|dotnetfx|dotnet|\w*setup|install|repair|patch|crashsender|unitycrashhandler|unitycrashhandler64|steam|game_save|\w*helper|\w*launcher|redist|\w*redist|awesomium|webkit|wowhelper|blizzard|agent|updater|update|notification|browser|chrome|ffmpeg|getvalue|geteven|binkpkg|physx|eac|easyanticheat|beclIENT|x64|crashreport|sendreport)\.exe$/i;
// 常见非游戏目录，直接跳过
const SKIP_DIR = /^(redist|commonredist|_commonredist|support|directx|vcredist|dotnet|deps|\.|\.\.|__macosx|engine|bin|x64|plugins|data|sdk|sdk_.*|thirdparty|windows|win32|win64|native|localization|locale|lang|languages|soundtrack|tools|extras)$/i;

/** 在文件夹内（默认 3 层深度）查找游戏 exe；返回 { name, path } 列表 */
function findExes(folder, depth = 0, maxDepth = 3, out = []) {
  if (depth > maxDepth || out.length >= 500) return out;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    if (out.length >= 500) break;
    const p = path.join(folder, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      findExes(p, depth + 1, maxDepth, out);
    } else if (e.isFile() && /\.exe$/i.test(e.name)) {
      if (SKIP_EXE.test(e.name)) continue;
      if (p.toLowerCase().includes('redist') || p.toLowerCase().includes('_commonredist')) continue;
      out.push({ name: e.name.replace(/\.exe$/i, ''), path: p });
    }
  }
  return out;
}

module.exports = {
  scanAll,
  buildEpicUri,         // 导出便于单测：Epic 三段式官方启动 URI（命名空间:%3A:Cid:%3A:AppName）
  buildBnetLaunchCommand, // 导出便于单测：战网官方 --exec="launch CODE"，无客户端时退回 battlenet://CODE
  scanBattleNet,        // 导出便于单测：战网双来源（LaunchOptions + 卸载表）
  PLATFORM_NAMES,
  detectBattleNetLauncher,
  findExes,
  findSteamLibraries,   // 导出便于单测：库路径去重是重复游戏的高发点
  normalizeLibPath,
  normalizeNameKey,     // 导出便于单测：Xbox 跨形态名称去重依赖它
  BNET_NAME_TO_CODE,
  scanUbisoft,          // 导出便于单测：育碧多来源登记表 + 目录兜底
  prettyUbisoftName
};
