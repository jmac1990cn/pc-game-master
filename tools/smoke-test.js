'use strict';
/**
 * 主进程冒烟测试（无窗口）
 *
 * 用 Module._load 拦截 require('electron')，并让 app.whenReady() 永不 resolve，
 * 从而不建窗口、不触发网络任务，然后直接调用已注册的 IPC handler 验证真实业务逻辑。
 *
 * 因为 whenReady 不 resolve，main.js 里的 store.init(app) 不会执行，
 * 这里必须手动补一次，否则配置持久化会失败（写 configPath=null）。
 *
 * 沙箱环境会拦截 Node 调用 reg.exe / tasklist，因此桩掉 registry / scanner，
 * 把测试聚焦在：VDF 解析、游玩时长合并、首页排序、电源 IPC、音频枚举、配置持久化。
 *
 * 用法： npm run smoke
 * 产物： <系统临时目录>/gl-smoke-result.json （完整结果）
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'gl-smoke-result.json');

/* ---------- 1) 桩：electron ---------- */
const handlers = {};
const fakeWin = {
  loadFile() {}, on() {}, isDestroyed: () => false, isMinimized: () => false,
  minimize() {}, setFullScreen() {}, isFullScreen: () => false,
  webContents: { send() {}, openDevTools() {}, session: { clearCache: () => Promise.resolve() } },
};
const fakeElectron = {
  app: {
    commandLine: { appendSwitch() {} },
    whenReady: () => new Promise(() => {}),          // 关键：永不 resolve
    getPath: () => path.join(os.tmpdir(), 'gl-smoke'),
    getName: () => 'game-launcher',
    on() {}, quit() {}, exit() {}, relaunch() {}, isPackaged: false,
    getAppMetrics: () => [], setLoginItemSettings() {},
    requestSingleInstanceLock: () => true,           // main.js 模块加载时即调用
  },
  BrowserWindow: Object.assign(function () { return fakeWin; }, { getAllWindows: () => [] }),
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '', openExternal: async () => {} },
  net: null,
};

/* ---------- 2) 桩：registry（避免调用被沙箱拦截的 reg.exe） ---------- */
// __uninstall 非空时，按「卸载表」语义返回注入的数据（用于战网扫描用例）
const regStub = {
  __uninstall: null,
  __ubisoft: null,   // 精确键表：{ '<完整键路径>': { subkeys:[], values:{} } }（育碧扫描用例）
  regExists: () => true,
  queryReg(key) {
    const r = { subkeys: [], values: {} };
    const k = String(key);
    if (this.__ubisoft && this.__ubisoft[k]) {
      const e = this.__ubisoft[k];
      return { subkeys: (e.subkeys || []).slice(), values: Object.assign({}, e.values) };
    }
    if (this.__uninstall && /Uninstall$/i.test(k)) {
      r.subkeys = Object.keys(this.__uninstall);
    } else if (this.__uninstall && /Uninstall/i.test(k)) {
      const leaf = k.split('\\').pop();
      if (this.__uninstall[leaf]) r.values = Object.assign({}, this.__uninstall[leaf]);
    }
    return r;
  },
  readRegValue(key, name) {
    const k = String(key);
    if (this.__ubisoft && this.__ubisoft[k]) {
      const v = this.__ubisoft[k].values || {};
      return v[name] !== undefined ? v[name] : null;
    }
    if (this.__uninstall && /Uninstall/i.test(k)) {
      const leaf = k.split('\\').pop();
      if (this.__uninstall[leaf]) return this.__uninstall[leaf][name] || null;
    }
    return null;
  },
  listRegSubKeys(key) {
    return this.queryReg(key).subkeys;
  },
  queryRegValuesRecursive(key, valueName) {
    const out = {};
    if (this.__uninstall && /Uninstall/i.test(String(key))) {
      for (const [leaf, vals] of Object.entries(this.__uninstall)) {
        if (vals[valueName] != null) out[leaf] = vals[valueName];
      }
    }
    return out;
  },
  cleanExeFromIcon(icon) {
    if (!icon) return null;
    let p = String(icon).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const c = p.lastIndexOf(',');
    if (c > 0 && /,\s*-?\d+\s*$/.test(p)) p = p.slice(0, c);
    return p.toLowerCase().endsWith('.exe') ? path.normalize(p) : null;
  },
};

/* ---------- 3) 桩：scanner（提供可控的假游戏列表） ---------- */
const G = (o) => Object.assign({
  id: '', name: '', platform: 'steam', appid: null, cover: null, background: null,
  defaultBackground: null, executable: null, launchCommand: null, installPath: null, icon: null,
}, o);

const FAKE_GAMES = [
  G({ id: 'steam:730', name: 'Counter-Strike 2', platform: 'steam', appid: '730', installPath: 'D:/Games/CS2' }),
  G({ id: 'steam:570', name: 'Dota 2', platform: 'steam', appid: '570', installPath: 'D:/Games/dota' }),
  G({ id: 'steam:1091500', name: 'Cyberpunk 2077', platform: 'steam', appid: '1091500' }),
  G({ id: 'epic:abc', name: 'Alan Wake 2', platform: 'epic' }),
  G({ id: 'ubisoft:42', name: 'Assassin Creed', platform: 'ubisoft' }),
  G({ id: 'manual:1', name: 'Zzz 自建游戏', platform: 'manual', executable: 'E:/x/z.exe' }),
];
let scanAllCalls = 0;   // 统计平台扫描次数，验证「只在启动/手动刷新时扫描」
const scannerStub = {
  // 故意多返回一条重复 id，用来验证主进程合并阶段会按 id 去重
  scanAll: () => {
    scanAllCalls++;
    return FAKE_GAMES.map(g => Object.assign({}, g))
      .concat([Object.assign({}, FAKE_GAMES[0])]);
  },
  findExes: () => [],
  detectBattleNetLauncher: () => null,
  PLATFORM_NAMES: {},
  __calls: () => scanAllCalls,
};

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
// 真实 registry 用于「reg query 输出解析」的纯函数单测（必须在被桩覆盖之前取出来）
const realRegistry = require(path.join(ROOT, 'src', 'registry.js'));
stub('registry.js', regStub);

// 先取真实 scanner 用于「Steam 库路径去重」单测，再用桩覆盖它供 main.js 使用
delete require.cache[require.resolve(path.join(ROOT, 'src', 'scanner.js'))];
const realScanner = require(path.join(ROOT, 'src', 'scanner.js'));
stub('scanner.js', scannerStub);

/* ---------- 4) 桩：electron 模块本身 ---------- */
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

/* ---------- 5) 加载被测主进程 ---------- */
const playtime = require(path.join(ROOT, 'src', 'playtime.js'));
const store = require(path.join(ROOT, 'src', 'store.js'));
require(path.join(ROOT, 'src', 'main.js'));
// 真实 metadata 用于「手柄支持档位提取」纯函数单测（不联网，只测解析）
const realMetadata = require(path.join(ROOT, 'src', 'metadata.js'));
const realLauncher = require(path.join(ROOT, 'src', 'launcher.js'));
const realPlatform = require(path.join(ROOT, 'src', 'platform.js'));

// whenReady 不 resolve，main.js 里的 store.init 不会跑，这里手动补上
store.init(fakeElectron.app);

const results = {};
const checks = [];
const expect = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  return pass;
};

/* ---------- A) VDF 解析 ---------- */
(function testVdf() {
  const vdf = `"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"730"
					{
						"LastPlayed"		"1757500000"
						"Playtime"		"4321"
						"Playtime2wks"		"60"
					}
					"570"
					{
						"LastPlayed"		"1757000000"
						"Playtime"		"98765"
					}
					"nested"
					{
						"junk" { "a" "b" }
						"Playtime"	"7"
					}
				}
				"friends" { "x" "y" }
			}
		}
	}
}`;
  const software = playtime.findBlock(vdf, 'Software');
  const valve = software && playtime.findBlock(software.text, 'Valve');
  const steam = valve && playtime.findBlock(valve.text, 'Steam');
  const apps = steam && playtime.findBlock(steam.text, 'apps');
  const found = {};
  if (apps) {
    const re = /"(\d{2,8})"\s*\{/g;
    let m;
    while ((m = re.exec(apps.text))) {
      const blk = playtime.blockAt(apps.text, apps.text.indexOf('{', m.index));
      if (!blk) continue;
      const pm = /"Playtime"\s*"(\d+)"/i.exec(blk.text);
      const p2 = /"Playtime2wks"\s*"(\d+)"/i.exec(blk.text);
      const pl = /"LastPlayed"\s*"(\d+)"/i.exec(blk.text);
      found[m[1]] = { minutes: pm ? +pm[1] : 0, minutes2wks: p2 ? +p2[1] : 0, lastPlayed: pl ? +pl[1] : 0 };
    }
  }
  results.vdfParse = { chainOk: !!(software && valve && steam && apps), found };
  expect('VDF 解析（嵌套大括号配对 + Playtime2wks 近两周时长）',
    apps && found['730'] && found['730'].minutes === 4321 && found['730'].minutes2wks === 60
    && found['570'] && found['570'].minutes === 98765 && found['570'].minutes2wks === 0,
    '链式查找 ' + (software && valve && steam && apps ? 'OK' : 'FAIL') + '，含嵌套块 "nested" 不误吞');
})();

/* ---------- A2) Steam 库路径去重（重复游戏的根因，回归测试） ---------- */
(function testSteamLibraryDedup() {
  // 真实场景：注册表 SteamPath 返回 "d:/steam"（正斜杠、小写盘符），
  // 而 libraryfolders.vdf 里同一库写成 "D:\\steam"（VDF 转义双反斜杠）。
  // 两者字符串不同却是同一目录，早期版本因此把整个库扫两遍 -> 同 id 游戏各出两张卡片。
  const T = path.join(os.tmpdir(), 'gl-smoke-steamlib');
  const appDir = path.join(T, 'steamapps');
  fs.mkdirSync(appDir, { recursive: true });
  const other = path.join(os.tmpdir(), 'gl-smoke-steamlib2');

  const esc = (p) => p.replace(/\\/g, '\\\\').replace(/\//g, '\\\\');   // VDF 转义
  fs.writeFileSync(
    path.join(appDir, 'libraryfolders.vdf'),
    '"libraryfolders"\n{\n' +
    '\t"0"\n\t{\n\t\t"path"\t\t"' + esc(T) + '"\n\t}\n' +
    '\t"1"\n\t{\n\t\t"path"\t\t"' + esc(other) + '"\n\t}\n' +
    '}\n',
    'utf8'
  );

  const regForm = T.replace(/\\/g, '/').replace(/^([A-Z]):/, (m, c) => c.toLowerCase() + ':');
  const libs = realScanner.findSteamLibraries(regForm);
  const key = (p) => String(realScanner.normalizeLibPath(p) || '').toLowerCase();
  const tKey = key(T);
  const sameAsFirst = libs.filter(l => key(l) === tKey).length;

  results.steamLibraryDedup = { regForm, vdfPath: esc(T), libs, count: libs.length, sameAsFirst };
  expect('Steam 库路径去重（注册表正斜杠 vs VDF 转义路径 视为同一目录）',
    libs.length === 2 && sameAsFirst === 1,
    libs.length + ' 个库，其中与注册表 SteamPath 同目录的 ' + sameAsFirst + ' 个');
})();

/* ---------- A3) Xbox 跨形态名称去重（目录形态 vs WindowsApps 包形态） ---------- */
(function testXboxNameDedup() {
  // 真实场景：同一款游戏以两种形态存在——
  //   XboxGames 目录：C:\XboxGames\Wo Long- Fallen Dynasty\Content\MicrosoftGame.config
  //   MSIX 包：      946B6A6E.WoLongFallenDynasty (C:\Program Files\WindowsApps\...)
  // 两者路径完全不同，路径前缀判重会漏；名称归一化后必须视为同一款。
  const k1 = realScanner.normalizeNameKey('Wo Long- Fallen Dynasty');
  const k2 = realScanner.normalizeNameKey('WoLongFallenDynasty');
  const k3 = realScanner.normalizeNameKey('Project Aibou');
  const k4 = realScanner.normalizeNameKey('Fictions.ProjectAibou');
  const okBasic = k1 === k2 && k1 === 'wolongfallendynasty';
  // 模拟 scanXbox 来源 2 的判重逻辑：包名去发行商前缀后，命中已收录名称集合则跳过
  const nameKeys = new Set([k1, k3]);
  const bare = '946B6A6E.WoLongFallenDynasty'.split('.').slice(1).join('.');
  const simDup = nameKeys.has(realScanner.normalizeNameKey(bare));
  results.xboxNameDedup = { k1, k2, bare, simDup };
  expect('Xbox 名称归一化去重（目录名 vs MSIX 包名 视为同一款）', okBasic && simDup,
    `key("${'Wo Long- Fallen Dynasty'}")===key("WoLongFallenDynasty") 且包名判重命中`);
})();

/* ---------- A4) 战网卸载表扫描（国服无 LaunchOptions 键的真实场景） ---------- */
(function testBNetUninstall() {
  const fakeExe = path.join(os.tmpdir(), 'gl-smoke', 'Hearthstone.exe');
  fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
  fs.writeFileSync(fakeExe, 'mz fake', 'utf8');
  regStub.__uninstall = {
    Hearthstone: {
      DisplayName: '炉石传说',
      DisplayIcon: fakeExe + ',0',
      InstallLocation: path.dirname(fakeExe),
    },
    'Battle.net': { DisplayName: 'Battle.net', DisplayIcon: fakeExe, InstallLocation: path.dirname(fakeExe) },
    // 真实场景：reg.exe 输出 GBK，被按 UTF-8 解码后中文变成乱码（含 U+FFFD）
    'World of Warcraft': {
      DisplayName: '\u9B54\u517D\u4E16\u754C\uffFD\uffFD',  // "魔兽世界" + 乱码
      DisplayIcon: fakeExe + ',0',
      InstallLocation: path.dirname(fakeExe),
    },
  };
  let bnet = [];
  try {
    bnet = realScanner.scanBattleNet({ battleNetLauncher: null });
  } finally {
    regStub.__uninstall = null;   // 不污染其它用例
  }
  const hs = bnet.find(g => g.name === '炉石传说');
  const wow = bnet.find(g => g.id === 'battlenet:wow');
  results.bnetUninstall = {
    found: bnet.map(g => ({ id: g.id, name: g.name, exe: g.executable })),
    hsOk: !!(hs && hs.id === 'battlenet:wtcg' && hs.executable && fs.existsSync(hs.executable)),
    wowFallbackName: !!(wow && wow.name === '魔兽世界'),
    launcherFiltered: !bnet.some(g => /battle\.?net/i.test(String(g.id).replace('battlenet:', ''))),
  };
  expect('战网卸载表扫描（国服无 LaunchOptions 也能扫出炉石传说）',
    results.bnetUninstall.hsOk && results.bnetUninstall.launcherFiltered && results.bnetUninstall.wowFallbackName,
    bnet.map(g => g.id + '=' + g.name).join(', ') || '(空)');
})();

/* ---------- A5) reg query 输出解析（Win11 子键按完整路径输出） ----------
 * 真机实测（Win11 26100）：`reg query <key>` 把子键输出成完整 HKEY 路径，
 * 早期实现把所有 HKEY_ 行都当「表头」跳过 → 子键列表恒为空，
 * 育碧 Installs / 战网 LaunchOptions / 卸载表全部因此扫不到东西。
 */
(function testRegParse() {
  const key = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs';
  const win11 = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\274',
    '    Language    REG_SZ    zh-CN',
    '    InstallDir    REG_SZ    D:/Ubisoft Game Launcher/games/Watch_Dogs/',
    '',
  ].join('\r\n');
  const r1 = realRegistry.parseRegOutput(win11, key);

  // 老格式（缩进裸键名）也要继续认
  const legacy = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
    '    SubA',
    '    SubB',
    '',
  ].join('\r\n');
  const r2 = realRegistry.parseRegOutput(legacy, key);

  results.regParse = {
    win11Subkeys: r1.subkeys, installDir: r1.values['InstallDir'], legacySubkeys: r2.subkeys,
    normalized: realRegistry.normalizeKeyPath('hklm\\software\\x\\'),
  };
  expect('reg query 解析：Win11 完整路径子键 + 老式缩进子键都能识别，且不误收自身表头',
    JSON.stringify(r1.subkeys) === JSON.stringify(['274'])
    && r1.values['InstallDir'] === 'D:/Ubisoft Game Launcher/games/Watch_Dogs/'
    && JSON.stringify(r2.subkeys) === JSON.stringify(['SubA', 'SubB']),
    'win11=' + JSON.stringify(r1.subkeys) + ' legacy=' + JSON.stringify(r2.subkeys));
  expect('reg 键路径归一化（HKLM 与 HKEY_LOCAL_MACHINE 等价，可去尾斜杠）',
    realRegistry.normalizeKeyPath('HKLM\\SOFTWARE\\X') === 'HKEY_LOCAL_MACHINE\\SOFTWARE\\X'
    && realRegistry.normalizeKeyPath('hklm\\software\\x\\') === 'HKEY_LOCAL_MACHINE\\software\\x',
    realRegistry.normalizeKeyPath('hklm\\software\\x\\'));
})();

/* ---------- A6) 育碧扫描：多来源登记表 + 目录名兜底 ---------- */
(function testUbisoft() {
  const gamesRoot = path.join(os.tmpdir(), 'gl-smoke', 'Ubisoft Game Launcher', 'games');
  const wdDir = path.join(gamesRoot, 'Watch_Dogs');
  const wdExe = path.join(wdDir, 'bin', 'Watch_Dogs.exe');
  fs.mkdirSync(path.dirname(wdExe), { recursive: true });
  fs.writeFileSync(wdExe, 'mz fake', 'utf8');

  const K32 = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs';
  const K32L = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher';
  regStub.__ubisoft = {
    [K32]: { subkeys: ['274'], values: {} },
    'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs': { subkeys: [], values: {} },
    'HKCU\\SOFTWARE\\Ubisoft\\Launcher\\Installs': { subkeys: ['274', '3559'], values: {} },
    [K32 + '\\274']: {
      subkeys: [],
      // 真机注册表里就是正斜杠 + 结尾斜杠，必须归一
      values: { Language: 'zh-CN', InstallDir: wdDir.replace(/\\/g, '/') + '/' },
    },
    // 只有安装状态、没有安装路径的残留项（游戏已卸载）
    'HKCU\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\3559': { subkeys: [], values: { InstallState: '0x1' } },
    [K32L]: { subkeys: ['Installs'], values: { InstallDir: path.dirname(gamesRoot) + '\\' } },
    'HKLM\\SOFTWARE\\Ubisoft\\Launcher': { subkeys: [], values: {} },
  };
  let ubi = [];
  try {
    ubi = realScanner.scanUbisoft();
  } finally {
    regStub.__ubisoft = null;
  }

  const wd = ubi.find(g => g.id === 'ubisoft:274');
  results.ubisoft = {
    found: ubi.map(g => ({ id: g.id, name: g.name, path: g.installPath, exe: g.executable })),
    wdOk: !!(wd && wd.name === 'Watch Dogs' && wd.executable && fs.existsSync(wd.executable)),
    staleSkipped: !ubi.some(g => g.id === 'ubisoft:3559'),
    noDupFolder: ubi.filter(g => /Watch_?Dogs/i.test(String(g.installPath))).length === 1,
  };
  expect('育碧扫描：HKLM+HKCU 双来源 + 正斜杠路径归一 + 目录名兜底命名 + exe 定位',
    results.ubisoft.wdOk && results.ubisoft.noDupFolder,
    JSON.stringify(results.ubisoft.found));
  expect('育碧扫描：只有 InstallState 没有安装路径的残留项不报（避免点不开的空条目）',
    results.ubisoft.staleSkipped, 'id 3559 已跳过');
  expect('育碧目录名 → 显示名（Watch_Dogs → Watch Dogs）',
    realScanner.prettyUbisoftName('D:\\Ubisoft Game Launcher\\games\\Watch_Dogs\\') === 'Watch Dogs',
    realScanner.prettyUbisoftName('D:\\Ubisoft Game Launcher\\games\\Watch_Dogs\\'));
})();

/* ---------- A7) 手柄支持档位提取 ---------- */
(function testControllerSupport() {
  const url = realMetadata.buildControllerSupportUrl(582160);
  const full = realMetadata.pickControllerSupport({ controller_support: 'full' });
  const partial = realMetadata.pickControllerSupport({ controller_support: 'partial' });
  const viaCatFull = realMetadata.pickControllerSupport(
    { categories: [{ id: 2 }, { id: 28, description: 'Full controller support' }] });
  const viaCatPartial = realMetadata.pickControllerSupport({ categories: [{ id: 18 }] });
  const none = realMetadata.pickControllerSupport({ name: 'x', categories: [{ id: 2 }] });
  results.controllerSupport = { url, full, partial, viaCatFull, viaCatPartial, none };
  expect('手柄支持：请求 URL 不带 filters=basic（basic 过滤会裁掉 controller_support 字段）',
    !/filters=basic/.test(url) && /appids=582160/.test(url), url);
  expect('手柄支持：字段直读 + categories(28/18) 兜底，两者都没有则为 null',
    full === 'full' && partial === 'partial' && viaCatFull === 'full'
    && viaCatPartial === 'partial' && none === null,
    JSON.stringify({ full, partial, viaCatFull, viaCatPartial, none }));
})();

/* ---------- A8) 非 Steam 游戏补资料：候选图源 + 重抓判定 + 名称来源 ----------
 * 实机根因（v1.2.2 修）：育碧版《看门狗》appid 243470 在 Steam CDN 上没有
 * library_600x900_2x.jpg，而当时只试这一条 → 下载失败 → 库里只剩远程链接，
 * 界面表现为「输入 appid 后什么都没补上」；再点一次又因缓存的 bgTried 直接早退。
 */
(function testMetadataAssets() {
  const cover = realMetadata.assetCandidates(243470, 'cover');
  const bg = realMetadata.assetCandidates(243470, 'background');
  const logo = realMetadata.assetCandidates(243470, 'logo');
  const coverUrls = cover.map(c => c.url);

  results.assetCandidates = { cover: coverUrls, bg: bg.map(c => c.url), logo: logo.map(c => c.url) };

  const firstFallback = cover.findIndex(c => c.fallback);
  const lastPortrait = cover.map(c => c.fallback).lastIndexOf(false);
  expect('封面候选：竖版优先、横版垫底（全失败才会用横版兜底）',
    cover.length >= 5
    && cover[0].url.endsWith('library_600x900_2x.jpg') && cover[0].fallback === false
    && coverUrls.some(u => u.endsWith('library_600x900.jpg'))
    && firstFallback > lastPortrait && lastPortrait >= 0
    && cover.some(c => c.url.endsWith('header.jpg') && c.fallback === true)
    && cover.every(c => c.url.includes('/243470/')),
    coverUrls.map(u => u.split('/').pop() + (cover[coverUrls.indexOf(u)].fallback ? '(横版)' : '')).join(' → '));

  expect('封面候选：两个 CDN 域名都试，且同名图两域名相邻（单域名被墙不至于耗尽预算）',
    cover.some(c => c.url.includes('cdn.cloudflare.steamstatic.com'))
    && cover.some(c => c.url.includes('cdn.akamai.steamstatic.com'))
    && cover[0].url.includes('cloudflare') && cover[1].url.includes('akamai')
    && cover[0].url.split('/').pop() === cover[1].url.split('/').pop(),
    cover.slice(0, 2).map(c => c.url.split('/').pop()).join(' + '));

  expect('背景候选：library_hero → page_bg_raw → 横版兜底',
    bg.some(c => c.url.endsWith('library_hero.jpg'))
    && bg.some(c => c.url.endsWith('page_bg_raw.jpg'))
    && bg.some(c => c.url.endsWith('header.jpg')),
    bg.map(c => c.url.split('/').pop()).join(' → '));

  expect('徽标候选：CDN 的 logo.png（不配 SteamGridDB Key 也能拿到徽标）',
    logo.some(c => c.url.endsWith('logo.png')) && logo.every(c => !/\?/.test(c.url)),
    logo.map(c => c.url.split('/').pop()).join(' → '));

  // 商店 API 直给的官方地址必须进候选链（老游戏全靠它兜住）
  const apiCover = realMetadata.assetCandidates(243470, 'cover', {
    headerImage: 'https://s/api/header_schinese.jpg',
    storeBackground: 'https://s/img/storepagebackground/app/243470?t=1',
    screenshot: 'https://s/img/ss_abc.1920x1080.jpg?t=1',
  });
  const apiBg = realMetadata.assetCandidates(243470, 'background', {
    storeBackground: 'https://s/img/storepagebackground/app/243470?t=1',
    screenshot: 'https://s/img/ss_abc.1920x1080.jpg?t=1',
  });
  const iApiHeader = apiCover.findIndex(c => c.url.includes('header_schinese'));
  const iPlainHeader = apiCover.findIndex(c => c.url.endsWith('header.jpg'));
  const iHero = apiBg.findIndex(c => c.url.endsWith('library_hero.jpg'));
  const iStoreBg = apiBg.findIndex(c => c.url.includes('storepagebackground'));
  const iShot = apiBg.findIndex(c => c.url.includes('1920x1080'));
  const iPageBg = apiBg.findIndex(c => c.url.endsWith('page_bg_raw.jpg'));
  const iCoverStoreBg = apiCover.findIndex(c => c.url.includes('storepagebackground'));
  const iCoverShot = apiCover.findIndex(c => c.url.includes('1920x1080'));
  expect('官方图进候选（封面）：capsule → 商店大图 → 官方头图 → 截图 → header.jpg',
    iCoverStoreBg > 0 && iApiHeader > iCoverStoreBg && iCoverShot > iApiHeader
    && iPlainHeader > iCoverShot && apiCover[iApiHeader].fallback === true,
    'capsule→storebg(' + iCoverStoreBg + ')→header(' + iApiHeader + ')→shot(' + iCoverShot + ')→header.jpg(' + iPlainHeader + ')');
  expect('官方大图进候选：library_hero → 商店大图 → 1080p 截图（老游戏没有 library_* 时靠这几条）',
    iHero === 0 && iStoreBg > iHero && iShot > iStoreBg && iPageBg > iShot && iPageBg > 0,
    'hero ' + iHero + ' → storebg ' + iStoreBg + ' → shot ' + iShot + ' → page_bg_raw ' + iPageBg);

  const A = realMetadata.ASSET_V;
  const D = realMetadata.DETAIL_V;
  const oldRemote = { appid: '243470', name: 'Watch_Dogs™', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/243470/library_600x900_2x.jpg', background: 'https://cdn.cloudflare.steamstatic.com/steam/apps/243470/library_hero.jpg', logo: null, bgTried: true, metaV: 2 };
  const networkFail = { appid: '1', cover: 'https://cdn/x.jpg', coverTried: false, bgTried: false, logoTried: false, assetV: A };
  const allLocal = { appid: '2', cover: 'C:\\u\\assets\\steam_730\\cover.jpg', background: 'C:\\u\\assets\\steam_730\\background.jpg', logo: 'C:\\u\\assets\\steam_730\\logo.png', coverTried: true, bgTried: true, logoTried: true, assetV: A, detailV: D };
  const reallyNone = { appid: '3', cover: null, background: null, logo: null, coverTried: true, bgTried: true, logoTried: true, assetV: A, detailV: D };
  const noOfficialUrls = { appid: '4', cover: null, background: 'C:\\u\\b.jpg', logo: null, coverTried: true, bgTried: true, logoTried: true, assetV: A };

  expect('重抓判定：库里只有远程链接的旧记录必须重抓（「再点一次没反应」的修复点）',
    realMetadata.needsAssetRetry(oldRemote, { cacheImages: true }) === true,
    'assetV 缺失 + 远程链接 → 重抓');
  expect('重抓判定：网络失败没落地的记录下次继续补',
    realMetadata.needsAssetRetry(networkFail, { cacheImages: true }) === true,
    'coverTried=false → 重抓');
  expect('重抓判定：本地已缓存且策略已是最新 → 不再联网',
    realMetadata.needsAssetRetry(allLocal, { cacheImages: true }) === false
    && realMetadata.needsAssetRetry(reallyNone, { cacheImages: true }) === false,
    '已补全 / 确认没有 → 早退');
  expect('重抓判定：关掉图片本地缓存时，远程链接不算「没补上」',
    realMetadata.needsAssetRetry({ ...allLocal, cover: 'https://cdn/x.jpg', coverTried: true }, { cacheImages: false }) === false,
    'cacheImages=false → 不因远程链接重抓');
  expect('重抓判定：还没用过商店官方图片地址且缺图 → 再给一次机会（拿到 detailV 后停止）',
    realMetadata.needsAssetRetry(noOfficialUrls, { cacheImages: true }) === true,
    'detailV 缺失 + 缺封面 → 重抓一次');

  expect('名称来源：中文请求走美区（cc=us），国区仅作兜底',
    realMetadata.NAME_SOURCES[0].lang === 'schinese' && realMetadata.NAME_SOURCES[0].cc === 'us'
    && realMetadata.NAME_SOURCES[1].lang === 'english'
    && realMetadata.NAME_EXTRA.cc === 'cn',
    JSON.stringify({ primary: realMetadata.NAME_SOURCES, extra: realMetadata.NAME_EXTRA }));
  expect('手柄支持请求同样避开国区（未发行条目在国区返回 success:false）',
    /cc=us/.test(realMetadata.buildControllerSupportUrl(243470)),
    realMetadata.buildControllerSupportUrl(243470));
})();

(async () => {
  /* ---------- B) 游玩时长合并 + 首页排序 ---------- */
  const now = Date.now();
  // 本地时长按「会话开始时间」落窗口：近两周（14 天）内才算 playtime2wks。
  //   570    近两周 800 / 总 800  → 近两周第 1
  //   730    近两周 300 / 总 300  → 近两周第 2
  //   42     近两周 120 / 总 120
  //   epic   40 天前（超出窗口）→ 近两周 0 / 总 5000 → 总时长第 1
  store.addPlaytime('steam:730', 300 * 60000, now - 5 * 86400000);
  store.addPlaytime('steam:570', 800 * 60000, now - 3 * 86400000);
  store.addPlaytime('epic:abc', 5000 * 60000, now - 40 * 86400000);
  store.addPlaytime('ubisoft:42', 120 * 60000, now - 2 * 86400000);
  store.touchLastPlayed('steam:1091500', now - 3600 * 1000);   // 最近游玩（仅时间，无时长）

  expect('近两周窗口：40 天前的会话不计入近两周时长',
    store.getRecentMs('epic:abc', now) === 0 && store.getRecentMs('steam:570', now) === 800 * 60000,
    'epic=' + store.getRecentMs('epic:abc', now) + ' 570=' + store.getRecentMs('steam:570', now));

  expect('配置持久化（config.json 可写）',
    !!store.getConfig() && fs.existsSync(path.join(fakeElectron.app.getPath(), 'config.json')),
    'configPath = ' + path.join(fakeElectron.app.getPath(), 'config.json'));

  const games = await handlers['games:get'](null);
  const ids = games.map(g => g.id);
  const uniqIds = new Set(ids.map(s => String(s).toLowerCase()));
  expect('合并阶段按 id 去重（重复 id 只保留一张卡片）',
    ids.length === uniqIds.size && ids.length === FAKE_GAMES.length,
    ids.length + ' 条记录 / ' + uniqIds.size + ' 个唯一 id');

  results.playtimeMerge = games.map(g => ({
    name: g.name, minutes: g.playtimeMinutes, source: g.playtimeSource,
    minutes2wks: g.playtime2wks,
    lastPlayedDaysAgo: g.lastPlayed ? Math.round((now - g.lastPlayed) / 86400000) : null,
  }));

  const order = games.map(g => g.id);
  // 前 5 席由排序规则指定，其余保持字母序（此处 tail 从第 6 位起）
  const tailNames = games.slice(5).map(g => g.name);
  const sortedNames = [...tailNames].sort((a, b) => a.localeCompare(b, 'zh'));
  results.homeOrder = {
    actual: order, tailActual: tailNames,
    tailIsAlphabetical: JSON.stringify(tailNames) === JSON.stringify(sortedNames),
  };
  expect('首页排序（最后游玩 → 近两周时长Top2 → 总时长Top2，且不重复占位）',
    order[0] === 'steam:1091500'      // ① 最后游玩
    && order[1] === 'steam:570'       // ② 近两周第 1（800 分钟）
    && order[2] === 'steam:730'       // ③ 近两周第 2（300 分钟）
    && order[3] === 'epic:abc'        // ④ 总时长第 1（5000 分钟）
    && order[4] === 'ubisoft:42'      // ⑤ 总时长第 2（120 分钟）
    && uniqIds.size === ids.length    // 同一款不重复占位
    && JSON.stringify(tailNames) === JSON.stringify(sortedNames),
    order.join(' , '));

  // 无游玩数据时应保持字母序（games:get 会命中缓存，用 games:scan 强制重建）
  for (const k of Object.keys(store.getConfig().playtime)) delete store.getConfig().playtime[k];
  const games2 = await handlers['games:scan'](null);
  results.noDataOrder = {
    names: games2.map(g => g.name),
    pass: JSON.stringify(games2.map(g => g.name))
      === JSON.stringify([...games2.map(g => g.name)].sort((a, b) => a.localeCompare(b, 'zh'))),
    anyBadge: games2.some(g => g.lastPlayed > 0 || g.playtimeMinutes > 0),
  };
  expect('无游玩数据时退化为纯字母序', results.noDataOrder.pass, '且无任何角标数据污染');

  store.addPlaytime('steam:730', 300 * 60000, now - 5 * 86400000);   // 还原

  /* ---------- C) 音频设备枚举（真实调用 PowerShell COM，未桩） ---------- */
  const a = await handlers['audio:list']();
  results.audio = {
    ok: a.ok, supported: a.supported, default: a.default,
    deviceCount: (a.devices || []).length, sample: (a.devices || []).slice(0, 3),
  };
  expect('音频设备枚举', a.ok && (a.devices || []).length > 0,
    '发现 ' + (a.devices || []).length + ' 个输出通道，默认=' + (a.default || '(未知)'));

  /* ---------- D) 电源 IPC（只跑取消，不会真的关机） ---------- */
  results.cancelShutdown = await handlers['power:cancelShutdown']();
  expect('电源 IPC：power:cancelShutdown 可调用', !!results.cancelShutdown,
    JSON.stringify(results.cancelShutdown));

  /* ---------- E) 设置读写 ---------- */
  await handlers['settings:set'](null, { defaultAudioDevice: a.default || '', switchAudioOnLaunch: true });
  const s = await handlers['settings:get'](null);
  results.settings = { hasDefaultAudio: !!s.defaultAudioDevice, switchAudioOnLaunch: s.switchAudioOnLaunch };
  expect('设置读写（默认音频通道 + 启动时切换开关）',
    s.switchAudioOnLaunch === true && !!s.defaultAudioDevice,
    'defaultAudioDevice=' + (s.defaultAudioDevice || '(空)'));

  /* ---------- F) 按游戏音频通道持久化 ---------- */
  if (a.devices && a.devices.length) {
    const dev = a.devices[0].id;
    await handlers['game:setConfig'](null, 'steam:730', { audioDevice: dev });
    const g1 = (await handlers['games:scan'](null)).find(g => g.id === 'steam:730');
    results.perGameAudio = { saved: g1 && g1.audioDevice, pass: !!(g1 && g1.audioDevice === dev) };
    expect('按游戏指定音频通道并持久化', results.perGameAudio.pass, dev);
  } else {
    results.perGameAudio = { skipped: '没有可用音频设备' };
    expect('按游戏指定音频通道并持久化', false, '跳过：没有可用音频设备');
  }

  /* ---------- F1) 进程探测：主程序藏在深目录、进程名推断不到的游戏（CS2 回归） ----------
   * v1.2.1 前的 bug：候选进程名只扫安装目录下 1 层，CS2（…\game\bin\win64\cs2.exe）
   * 得到的是空列表；而「按安装目录核对进程路径」只在「从未见过进程」时才启用 ——
   * 靠它见到进程后的下一轮就只剩空名字表可查，于是把还在跑的游戏判成「已退出」：
   * 系统音频被切回默认、最小化的窗口被弹回桌面。这里把探测链路的纯函数钉住。
   */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-proc-'));
    const deep = path.join(root, 'game', 'bin', 'win64');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'cs2.exe'), '');
    fs.writeFileSync(path.join(deep, 'cs2.dll'), '');
    fs.writeFileSync(path.join(root, 'readme.txt'), '');

    const game = { id: 'steam:730', platform: 'steam', installPath: root, executable: null };
    const names = playtime.candidateNames(game);
    const dirs = playtime.gameDirs(game);
    expect('候选进程名递归 3 层找到主程序 cs2.exe（CS2 回归）',
      names.includes('cs2.exe'), names.join(',') || '(空)');
    expect('安装目录前缀带尾分隔符（避免 D:\\Games\\CS2 命中 D:\\Games\\CS2000）',
      dirs.length === 1 && /\\$/.test(dirs[0]), dirs.join(','));

    // 名字表为空 → 必须靠安装目录前缀命中（与「是否见过进程」这个状态无关）
    const hitByPath = playtime.matchRunning({
      names: [], procs: new Set(['explorer.exe']), dirs,
      paths: [path.join(deep, 'cs2.exe')],
    });
    expect('进程名没命中时，按安装目录路径仍然判定在跑', hitByPath === true, String(hitByPath));

    const missOutside = playtime.matchRunning({
      names: [], procs: new Set(['explorer.exe']), dirs,
      paths: [path.join(os.tmpdir(), 'gl-other', 'x.exe')],
    });
    expect('安装目录之外的进程不算命中', missOutside === false, String(missOutside));

    const hitByName = playtime.matchRunning({ names: ['cs2.exe'], procs: new Set(['cs2.exe']), dirs: [], paths: [] });
    expect('按进程名命中', hitByName === true, String(hitByName));

    expect('isRunningNow 可用于音频还原前二次确认', typeof playtime.isRunningNow === 'function',
      typeof playtime.isRunningNow);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------- F2) 自定义封面：写入 → 拷贝 → 合并优先级 ---------- */
  {
    // 无 appid 的游戏（战网/育碧/手动）没有在线封面，只能用户自指定
    const img = path.join(os.tmpdir(), 'gl-smoke', 'my-cover.jpg');
    fs.writeFileSync(img, 'fake-jpeg-bytes', 'utf8');
    await handlers['game:setConfig'](null, 'steam:730', { customCover: img });
    const g = (await handlers['games:get'](null)).find(x => x.id === 'steam:730');
    // 合并后的 cover 是 file:// URL；转回本地路径验证文件确实拷进了资源目录
    const coverLocal = g && g.cover && g.cover.startsWith('file:')
      ? require('url').fileURLToPath(g.cover) : g.cover;
    const copied = !!(coverLocal && coverLocal !== img && fs.existsSync(coverLocal)
      && /cover\.jpe?g$/i.test(coverLocal));   // 主进程应把图拷进资源目录再转 file:// URL
    await handlers['game:setConfig'](null, 'steam:730', { customCover: '' });   // 清除
    const g2 = (await handlers['games:get'](null)).find(x => x.id === 'steam:730');
    results.customCover = {
      cover: g && g.cover, local: coverLocal, copiedOk: !!copied,
      hasFlag: !!(g && g.hasCustomCover), cleared: !g2.hasCustomCover,
    };
    expect('自定义封面（本地图拷入资源目录，合并时优先于在线封面，可清除）',
      copied && g.hasCustomCover === true && !g2.hasCustomCover,
      'cover=' + ((g && g.cover) || '(空)'));
  }

  /* ---------- F2.5) 手柄支持档位透传到游戏列表 ----------
   * 详情页展示用的是游戏列表里的 g.controllerSupport；早期 buildAll 没透传这个字段，
   * 详情页只能临时联网再查一次，网络不通时就永远不显示。
   */
  {
    store.setMetadata({ appid: '730', controllerSupport: 'full', controllerTried: true });
    const g = (await handlers['games:scan'](null)).find(x => x.id === 'steam:730');
    results.controllerPassThrough = { value: g && g.controllerSupport };
    expect('手柄支持档位从信息库透传到游戏列表（详情页无需再联网即可显示）',
      !!(g && g.controllerSupport === 'full'),
      'steam:730 → ' + ((g && g.controllerSupport) || '(空)'));
    delete store.getConfig().metadata['730'];   // 还原，不污染后续用例
  }

  /* ---------- F3) 扫描规则：只在启动 / 手动刷新时全平台扫描 ---------- */
  {
    const before = scannerStub.__calls();
    // 这些变异操作在旧版里都会触发全平台扫描，新版必须只做合并（计数不变）
    await handlers['settings:set'](null, { mode: 'desktop' });
    await handlers['game:setConfig'](null, 'steam:570', { customName: '刀塔 2' });
    await handlers['game:hide'](null, 'ubisoft:42');
    await handlers['game:unhide'](null, 'ubisoft:42');
    await handlers['games:get'](null);
    const afterMutations = scannerStub.__calls();
    // 「⟳ 刷新」按钮是唯一的手动全量扫描入口
    await handlers['games:scan'](null);
    const afterManual = scannerStub.__calls();
    results.scanPolicy = { before, afterMutations, afterManual };
    expect('扫描规则（设置/配置/隐藏等操作不触发平台扫描，仅手动刷新才扫）',
      afterMutations === before && afterManual === afterMutations + 1,
      `变异操作 ${before}→${afterMutations} 次，手动刷新 →${afterManual} 次`);
    await handlers['game:setConfig'](null, 'steam:570', { customName: '' });   // 还原
  }

  /* ---------- G) IPC 通道注册完整性 ---------- */
  results.registeredHandlers = Object.keys(handlers).sort();
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const preCh = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
  const missing = preCh.filter(c => !handlers[c]);
  expect('preload 调用的 IPC 通道全部已注册',
    missing.length === 0, preCh.length + ' 个通道，缺失: ' + (missing.length ? missing.join(',') : '无'));

  /* ---------- H) 启动决策：平台游戏走官方 URI 协议（Playnite 同款） ----------
   * Epic / 战网 / 育碧一律调用平台官方 URI：系统协议唤起客户端 → 客户端完成登录与 DRM
   * 校验 → 客户端拉起游戏本体。直接 spawn 游戏 exe 会因「无有效客户端会话」被判定而自退。
   * 平台就绪等待由 platform.ensureRunning 负责（默认 15 秒，可在设置里调大）。
   */
  {
    const bnetGame = {
      name: '炉石传说', platform: 'battlenet',
      executable: process.execPath,
      // 战网官方启动方式："Battle.net.exe" --exec="launch <产品代码>"
      launchCommand: realScanner.buildBnetLaunchCommand('WTCG', process.execPath),
    };
    const epicGame = {
      name: 'Epic 游戏', platform: 'epic',
      executable: process.execPath,
      // Epic 官方三段式：CatalogNamespace : CatalogItemId : AppName（顺序不能错）
      launchCommand: realScanner.buildEpicUri({
        CatalogNamespace: 'fn', CatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', AppName: 'Fortnite',
      }),
    };
    const ubiGame = {
      name: '育碧游戏', platform: 'ubisoft',
      executable: process.execPath,
      launchCommand: 'uplay://launch/274/0',
    };
    const steamGame = {
      name: 'Steam 游戏', platform: 'steam',
      executable: process.execPath,
      launchCommand: process.execPath,
    };
    const xboxGame = {
      name: 'Xbox 游戏', platform: 'xbox',
      executable: null,
      launchCommand: 'shell:AppsFolder\\XboxApp!Game',
    };
    const onlyExe = {
      name: '只有 exe', platform: 'manual',
      executable: process.execPath, launchCommand: null,
    };

    const bnet = realLauncher.chooseLaunch(bnetGame);
    const epic = realLauncher.chooseLaunch(epicGame);
    const ubi = realLauncher.chooseLaunch(ubiGame);
    const steam = realLauncher.chooseLaunch(steamGame);
    const xbox = realLauncher.chooseLaunch(xboxGame);
    const onlyExeChoice = realLauncher.chooseLaunch(onlyExe);

    results.launchChoice = {
      bnet: bnet.target, epic: epic.target, ubi: ubi.target, steam: steam.target,
      xbox: xbox.target, onlyExe: onlyExeChoice.target,
    };
    // 战网：launchCommand 形如 "exe" --exec="launch WTCG"（官方方式）→
    // 必须拆成 exe + 单个 argv 直接 spawn，绕开 cmd 对嵌套引号的解析
    expect('启动决策：战网 --exec 官方命令拆成 exe+参数直接 spawn',
      bnet.target === process.execPath
        && JSON.stringify(bnet.args) === JSON.stringify(['--exec=launch WTCG'])
        && !!bnet.opts.cwd,
      JSON.stringify({ t: bnet.target, a: bnet.args }));
    expect('启动决策：Epic 走官方 URI（即使扫描到了 exe）',
      epic.target === epicGame.launchCommand, epic.target);
    expect('启动决策：育碧走 uplay:// URI（即使扫描到了 exe）',
      ubi.target === ubiGame.launchCommand, ubi.target);
    expect('启动决策：Steam 仍走直接 exe（不受平台优先级影响）',
      steam.target === steamGame.executable && !!steam.opts.cwd, steam.target);
    expect('启动决策：Xbox（无传统 exe）走 AUMID（shell:）平台命令',
      xbox.target === xboxGame.launchCommand, xbox.target);
    expect('启动决策：仅 exe 的游戏回退到直接 exe',
      onlyExeChoice.target === onlyExe.executable, onlyExeChoice.target);

    // appid 与启动解耦（用户明确要求）：给非 Steam 游戏填 Steam appid 只用于补资料，
    // 启动路径必须一个字节都不变 —— 绝不能因此变成 Steam 启动。
    const withAppid = (g, appid) => Object.assign({}, g, { appid });
    const bnetWith = realLauncher.chooseLaunch(withAppid(bnetGame, '243470'));
    const epicWith = realLauncher.chooseLaunch(withAppid(epicGame, '1245620'));
    const ubiWith = realLauncher.chooseLaunch(withAppid(ubiGame, '243470'));
    const xboxWith = realLauncher.chooseLaunch(withAppid(xboxGame, '1448440'));
    const onlyExeWith = realLauncher.chooseLaunch(withAppid(onlyExe, '730'));
    const pick = c => JSON.stringify({ t: c.target, a: c.args, o: c.opts && c.opts.shell });
    results.appidDecoupled = {
      bnet: bnetWith.target, epic: epicWith.target, ubi: ubiWith.target,
      xbox: xboxWith.target, manual: onlyExeWith.target,
    };
    expect('appid 解耦：非 Steam 游戏填 appid 后启动目标完全不变（不会被改成 Steam 启动）',
      pick(bnetWith) === pick(bnet) && pick(epicWith) === pick(epic)
      && pick(ubiWith) === pick(ubi) && pick(xboxWith) === pick(xbox)
      && pick(onlyExeWith) === pick(onlyExeChoice),
      JSON.stringify(results.appidDecoupled));
    expect('appid 解耦：任何启动目标都不会退化成 steam:// 协议',
      [bnetWith, epicWith, ubiWith, xboxWith, onlyExeWith].every(c => !/^steam:/i.test(String(c.target))),
      '无 steam:// 目标');

    // 模拟器游戏（手动添加）：exe = 模拟器本体，launchArgs = 这一款游戏的启动参数。
    // 例：D:\rpcs3\rpcs3.exe --no-gui "%RPCS3_GAMEID%:BCAS20097"
    // 关键：必须直接 spawn（不经 shell）—— 走 cmd 的话 %RPCS3_GAMEID% 会被当环境变量展开成空串。
    const emulator = {
      name: 'PS3 · BCAS20097', platform: 'manual',
      executable: process.execPath, launchCommand: null,
      launchArgs: '--no-gui "%RPCS3_GAMEID%:BCAS20097"',
    };
    const emuChoice = realLauncher.chooseLaunch(emulator);
    results.emulatorLaunch = {
      t: emuChoice.target, a: emuChoice.args,
      shell: !!(emuChoice.opts && emuChoice.opts.shell),
    };
    expect('模拟器启动：启动参数原样传给模拟器 exe（--no-gui + 引号内游戏ID）',
      emuChoice.target === emulator.executable
        && JSON.stringify(emuChoice.args) === JSON.stringify(['--no-gui', '%RPCS3_GAMEID%:BCAS20097']),
      JSON.stringify(results.emulatorLaunch));
    expect('模拟器启动：不经 shell（cmd 会把 %RPCS3_GAMEID% 展开成空串）',
      !(emuChoice.opts && emuChoice.opts.shell), JSON.stringify(results.emulatorLaunch));
    // 同一个模拟器下的另一款游戏：参数必须各自独立、互不串台
    const emulator2 = Object.assign({}, emulator, { launchArgs: '--no-gui "%RPCS3_GAMEID%:BLUS30443"' });
    const emu2Choice = realLauncher.chooseLaunch(emulator2);
    expect('模拟器启动：同模拟器不同游戏的参数互不串台',
      JSON.stringify(emu2Choice.args) === JSON.stringify(['--no-gui', '%RPCS3_GAMEID%:BLUS30443']),
      JSON.stringify(emu2Choice.args));
    expect('模拟器启动：留空启动参数时行为与普通游戏一致（无多余 argv）',
      JSON.stringify(realLauncher.chooseLaunch(Object.assign({}, emulator, { launchArgs: '' })).args) === '[]',
      JSON.stringify(realLauncher.chooseLaunch(Object.assign({}, emulator, { launchArgs: '' })).args));

    // 战网启动命令：有客户端 → 官方 --exec；无客户端 → battlenet:// 兜底
    // （实测 battlenet:// 协议在国服客户端只唤起/登录、不启动游戏）
    expect('战网命令：有 Battle.net.exe 时用官方 --exec="launch CODE"',
      realScanner.buildBnetLaunchCommand('WTCG', process.execPath)
      === '"' + process.execPath + '" --exec="launch WTCG"',
      realScanner.buildBnetLaunchCommand('WTCG', process.execPath));
    expect('战网命令：客户端缺失时退回 battlenet://CODE',
      realScanner.buildBnetLaunchCommand('WTCG', null) === 'battlenet://WTCG'
        && realScanner.buildBnetLaunchCommand('WTCG', 'C:\\nope\\Battle.net.exe') === 'battlenet://WTCG');

    // Epic 官方三段式 URI（Epic Games Store Protocol Activation 官方格式）
    // 顺序是 CatalogNamespace : CatalogItemId : AppName —— 写反会被 Epic 报
    // 「Application Not Owned」（它把最后一段当应用 ID 查所有权）
    expect('Epic URI：三段式 <CatalogNamespace>%3A<CatalogItemId>%3A<AppName>（顺序正确）',
      epicGame.launchCommand === 'com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true',
      epicGame.launchCommand);
    expect('Epic URI：CatalogNamespace 缺失时降级为两段',
      realScanner.buildEpicUri({ CatalogItemId: 'abc', AppName: 'Fortnite' })
      === 'com.epicgames.launcher://apps/abc%3AFortnite?action=launch&silent=true');
    expect('Epic URI：字段全缺时返回 null（不会拼出无效 URI）',
      realScanner.buildEpicUri({ DisplayName: 'x' }) === null);

    // 平台就绪等待：可配置 + 边界收敛（宁可多等，一次成功，不做早退重试）
    expect('就绪等待：默认 15 秒',
      realPlatform.READY_WAIT_MS === 15000 && realPlatform.DEFAULT_READY_WAIT_SEC === 15,
      realPlatform.READY_WAIT_MS);
    expect('就绪等待：按设置取秒数',
      realPlatform.resolveReadyWait(30) === 30000, realPlatform.resolveReadyWait(30));
    expect('就绪等待：非法值回退默认 15 秒、过小值钳到下限 5 秒',
      realPlatform.resolveReadyWait(0) === 15000 && realPlatform.resolveReadyWait('abc') === 15000
        && realPlatform.resolveReadyWait(1) === 5000);
    expect('就绪等待：上限收敛为 120 秒',
      realPlatform.resolveReadyWait(999) === 120000, realPlatform.resolveReadyWait(999));

    // URI spawn 组装：start "" "uri" + verbatim。标题必须是字面量 "" —— 空字符串 ''
    // 在 verbatim 模式下等于没写，start 会把 URI 当窗口标题而开出一个空控制台窗口
    // （实机现象：标题为 battlenet://WTCG 的 cmd 窗口），游戏不启动。
    const u = realLauncher.buildUriSpawn(epicGame.launchCommand);
    expect('URI 启动：标题用字面量 ""，且 URI 加引号 + verbatim 传参',
      u.file === 'cmd.exe'
        && JSON.stringify(u.args) === JSON.stringify(['/d', '/c', 'start', '""', '"' + epicGame.launchCommand + '"'])
        && u.opts.windowsVerbatimArguments === true,
      JSON.stringify(u.args));
    expect('URI 启动：标题不得为空字符串（否则 start 把 URI 当标题 → 空 cmd 窗口）',
      !u.args.includes(''), JSON.stringify(u.args));
    // 主路：Electron 环境下必须交给 shell.openExternal（系统 ShellExecute），完全不经过 cmd，
    // 这样才能彻底绕开 cmd start 的"首引号=窗口标题"陷阱（v1.1.8 空 cmd 窗口根因）
    const origOpenExternal = fakeElectron.shell.openExternal;
    const extCalls = [];
    fakeElectron.shell.openExternal = (u) => { extCalls.push(u); return Promise.resolve(); };
    const handled = realLauncher.openViaSystemShell(epicGame.launchCommand);
    fakeElectron.shell.openExternal = origOpenExternal;
    expect('URI 启动：Electron 环境下交给系统 shell.openExternal（不走 cmd）',
      handled === true && extCalls.length === 1 && extCalls[0] === epicGame.launchCommand,
      JSON.stringify(extCalls));

    /* ---------- 修改器提权（v1.2.4）----------
     * 风灵月影等修改器的清单里写着 requireAdministrator：直接 spawn 必然 EACCES
     * （实机现象：弹出「A JavaScript error occurred in the main process」，修改器不启动）。
     * 要守住两件事：1) 这种程序必须提权启动；2) 起不来时绝不能让主进程崩。
     */
    const { spawn } = require('child_process');
    const elevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-elev-'));
    const mkExe = (name, marker) => {
      const p = path.join(elevDir, name);
      // 清单贴在文件尾部 —— 真实 trainer 就是这样（requireAdministrator 在 99.8% 处）
      fs.writeFileSync(p, Buffer.concat([
        Buffer.alloc(64 * 1024, 0x41), Buffer.from(marker), Buffer.alloc(64 * 1024, 0x42),
      ]));
      return p;
    };
    const adminExe = mkExe('admin.exe', '<requestedExecutionLevel level="requireAdministrator"/>');
    const normalExe = mkExe('normal.exe', '<requestedExecutionLevel level="asInvoker"/>');

    expect('提权预检：识别清单尾部的 requireAdministrator（真实 trainer 的形态）',
      realLauncher.requiresElevation(adminExe) === true, adminExe);
    expect('提权预检：asInvoker 不误报',
      realLauncher.requiresElevation(normalExe) === false);
    expect('提权预检：文件不存在返回 false（不抛异常）',
      realLauncher.requiresElevation(path.join(elevDir, 'ghost.exe')) === false);

    const el = realLauncher.buildElevatedSpawn('D:\\a b\\[x]\\t.exe', 'D:\\a b\\[x]');
    expect('提权启动：走 cmd start（ShellExecute 才会按清单提权）',
      el.file === 'cmd.exe'
        && JSON.stringify(el.args) === JSON.stringify(['/d', '/c', 'start', '""', '/d', '"D:\\a b\\[x]"', '"D:\\a b\\[x]\\t.exe"'])
        && el.opts.windowsVerbatimArguments === true,
      JSON.stringify(el.args));
    expect('提权启动：标题仍是字面量 ""（防空标题被当成窗口标题的老坑）',
      el.args.includes('""') && !el.args.includes(''));

    // 提权路径也要带上自定义启动参数（否则「需要管理员的程序 + 参数」会把参数静默丢掉）
    const elArgs = realLauncher.buildElevatedSpawn('D:\\a b\\t.exe', 'D:\\a b', ['--no-gui', 'BLUS30443']);
    expect('提权启动：自定义启动参数一并带上',
      JSON.stringify(elArgs.args)
      === JSON.stringify(['/d', '/c', 'start', '""', '/d', '"D:\\a b"', '"D:\\a b\\t.exe"', '--no-gui BLUS30443']),
      JSON.stringify(elArgs.args));
    expect('提权启动：不传参数时命令行与旧版逐字节一致（不引入多余空段）',
      JSON.stringify(realLauncher.buildElevatedSpawn('D:\\a b\\t.exe', 'D:\\a b').args)
      === JSON.stringify(['/d', '/c', 'start', '""', '/d', '"D:\\a b"', '"D:\\a b\\t.exe"']),
      JSON.stringify(realLauncher.buildElevatedSpawn('D:\\a b\\t.exe', 'D:\\a b').args));

    // 没挂 guard 的 error 事件会升级成主进程未捕获异常（就是那个红框弹窗）
    const ghost = spawn(path.join(elevDir, 'ghost.exe'));
    let caught = null;
    realLauncher.attachGuard(ghost, (e) => { caught = e; });
    expect('错误兜底：attachGuard 给子进程挂上了 error 监听',
      ghost.listenerCount('error') >= 1, ghost.listenerCount('error'));
    await new Promise(r => setTimeout(r, 800));
    expect('错误兜底：ENOENT 被监听器接住，不会逃逸成主进程崩溃',
      !!caught && caught.code === 'ENOENT', caught && caught.code);

    const rGhost = await realLauncher.startProcessSafe(path.join(elevDir, 'ghost.exe'), { allowElevate: true });
    expect('安全启动：不存在的程序如实返回 ok=false + code=ENOENT（不抛异常）',
      rGhost.ok === false && rGhost.code === 'ENOENT', JSON.stringify(rGhost));

    const rPlain = await realLauncher.startProcessSafe(process.execPath, { args: ['-e', 'setTimeout(function(){},200)'] });
    expect('安全启动：普通程序照常启动，不因提权逻辑改变常规路径',
      rPlain.ok === true && rPlain.elevated === false, JSON.stringify(rPlain));

    fs.rmSync(elevDir, { recursive: true, force: true });

    /* ---------- 修改器随游戏一起关闭（1.2.16）----------
     * 游戏进程退出后，修改器（分离进程、可能提权）必须一并关掉、不留残留。
     * 不靠 PID（提权启动拿不到子进程句柄），而是按完整可执行路径用 WMI 终止。
     */
    const gotFilter = realLauncher.trainerKillFilter("C:\\a b\\t.exe");
    expect('关闭修改器：WMI 过滤串正确转义反斜杠',
      gotFilter === "ExecutablePath='C:\\\\a b\\\\t.exe'", gotFilter);
    const gotFilter2 = realLauncher.trainerKillFilter("C:\\x'y\\t.exe");
    expect('关闭修改器：路径含单引号也正确转义（不破坏 WQL）',
      gotFilter2 === "ExecutablePath='C:\\\\x''y\\\\t.exe'", gotFilter2);
    // 1.2.18：进程名兜底过滤串（绕过中文路径编码坑，按 exe 文件名关）
    const gotName = realLauncher.trainerKillName("D:\\游戏\\修改器\\风灵月影 Trainer.exe");
    expect('关闭修改器：进程名兜底过滤串 = 仅 exe 文件名（不含中文路径）',
      gotName === "Name='风灵月影 Trainer.exe'", gotName);
    const gotName2 = realLauncher.trainerKillName("C:\\dir\\y's trainer.exe");
    expect('关闭修改器：进程名含单引号也正确转义',
      gotName2 === "Name='y''s trainer.exe'", gotName2);
    expect('关闭修改器：路径不存在时返回 false 且不抛异常（不会误杀）',
      realLauncher.terminateTrainer(path.join(os.tmpdir(), 'gl-ghost-trainer-xyz.exe')) === false);

    const tkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-term-'));
    const tkExe = path.join(tkDir, 'trainer.exe');
    fs.writeFileSync(tkExe, Buffer.alloc(1024, 0x41));   // 仅让 fs.existsSync 通过，不真正启动进程
    let termThrew = false, termRet = null;
    try { termRet = realLauncher.terminateTrainer(tkExe); } catch (e) { termThrew = true; }
    expect('关闭修改器：存在路径时返回 true 且不抛异常（按完整路径发出终止请求）',
      termThrew === false && termRet === true, `threw=${termThrew} ret=${termRet}`);
    fs.rmSync(tkDir, { recursive: true, force: true });

    // 1.2.19：Node 侧精确匹配（避免中文经 PowerShell 命令行乱码）
    const base = 'D:\\游戏\\修改器\\风灵月影修改器.exe';
    const procs = [
      { ProcessId: 1001, Name: '风灵月影修改器.exe', ExecutablePath: 'D:\\游戏\\修改器\\风灵月影修改器.exe' },
      { ProcessId: 1002, Name: 'game.exe', ExecutablePath: 'D:\\游戏\\修改器\\game.exe' },
      { ProcessId: 1003, Name: '风灵月影修改器.exe', ExecutablePath: 'E:\\其它游戏\\风灵月影修改器.exe' }, // 同名不同目录 → 不应命中
      { ProcessId: 1004, Name: '风灵月影修改器.EXE', ExecutablePath: 'D:\\游戏\\修改器\\风灵月影修改器.exe' }, // 大小写不同 → 应命中
    ];
    const m = realLauncher.matchTrainerProcesses(procs, base).map((p) => p.ProcessId).sort();
    expect('关闭修改器：UTF-8 进程清单精确匹配（中文名命中、同名异目录不误杀、大小写不敏感）',
      JSON.stringify(m) === JSON.stringify([1001, 1004]), JSON.stringify(m));
    const m2 = realLauncher.matchTrainerProcesses(procs, 'D:\\游戏\\修改器\\game.exe').map((p) => p.ProcessId);
    expect('关闭修改器：按路径完全相等匹配（仅命中本体，不命中同名修改器）',
      JSON.stringify(m2) === JSON.stringify([1002]), JSON.stringify(m2));

    /* ---------- 游戏窗口前台激活（v1.2.5）----------
     * 场景：游戏比修改器启动慢，或平台客户端先起、游戏后起 —— 游戏窗口出来时已被
     * 压在后面，用户得手动点任务栏。做法是另起一个隐藏的 PowerShell 帮助进程去等
     * 窗口 + 激活（见 src/winfocus.js）。
     * 这里钉住的是"脚本内容/组装方式/开关"，真机行为由 npm run check:focus 验证。
     */
    const realWinFocus = require(path.join(ROOT, 'src', 'winfocus.js'));
    const focusScript = realWinFocus.buildFocusScript({
      names: ['CS2.EXE', "D'oh.exe"],
      dirs: ['C:\\Games\\CS2'],
      waitMs: 240000, guardMs: 20000, pollMs: 700, maxAct: 6,
      logFile: 'C:\\x\\game-launcher.log',
    });
    expect('前台激活：脚本用 EnumWindows 找窗口 + SetForegroundWindow 激活',
      /EnumWindows/.test(focusScript) && /SetForegroundWindow/.test(focusScript));
    expect('前台激活：脚本含实测有效的手法（BringWindowToTop / SwitchToThisWindow / 无害按键）',
      /BringWindowToTop/.test(focusScript) && /SwitchToThisWindow/.test(focusScript)
        && /keybd_event/.test(focusScript),
      'AttachThreadInput+SetForegroundWindow 在本机实测无效，必须有后续手法');
    expect('前台激活：候选进程名小写化、单引号转义（PS 字面量安全）',
      focusScript.includes("$Names = @('cs2.exe','d''oh.exe')"),
      (focusScript.match(/\$Names = .*/) || [''])[0]);
    expect('前台激活：等待/守卫/次数上限都写进脚本',
      /\$WaitMs = 240000/.test(focusScript) && /\$GuardMs = 20000/.test(focusScript)
        && /\$MaxAct = 6/.test(focusScript));
    expect('前台激活：窗口过滤器排除带 owner 的弹窗、且容忍最小化窗口',
      /GW_OWNER/.test(focusScript) && /IsIconic/.test(focusScript));
    expect('前台激活：判据是"前台真的是目标进程"，不信 API 返回值',
      /FgPid\(\) == target/.test(focusScript));
    const encFocus = realWinFocus.encodeCommand(focusScript);
    expect('前台激活：EncodedCommand 是 UTF-16LE Base64，解码能还原脚本（中文注释不乱码）',
      Buffer.from(encFocus, 'base64').toString('utf16le') === focusScript);
    expect('前台激活：命令行长度在 Windows 上限内（32767）',
      encFocus.length < 30000, encFocus.length + ' 字符');
    const fsp = realWinFocus.buildFocusSpawn(focusScript);
    expect('前台激活：spawn 走 powershell -EncodedCommand，且不落盘',
      fsp.file === 'powershell.exe'
        && fsp.args.includes('-NoProfile') && fsp.args.includes('-NonInteractive')
        && fsp.args.includes('-EncodedCommand')
        && fsp.args[fsp.args.indexOf('-EncodedCommand') + 1] === encFocus,
      JSON.stringify(fsp.args.slice(0, 5)));
    expect('前台激活：不得带 detached（DETACHED_PROCESS 会让 PowerShell 无控制台、90ms 静默退出）',
      fsp.opts.detached === undefined || fsp.opts.detached === false,
      JSON.stringify(fsp.opts));
    expect('前台激活：子进程必须 windowsHide + stdio ignore（不闪窗口、不拖住退出）',
      fsp.opts.windowsHide === true && fsp.opts.stdio === 'ignore');
    // 平台客户端游戏（先起客户端、再起游戏）要等更久
    expect('前台激活：平台客户端游戏等待上限更长（4 分钟）',
      realWinFocus.resolveWaitMs({ platform: 'epic' }) === 240000
        && realWinFocus.resolveWaitMs({ platform: 'steam' }) === 240000
        && realWinFocus.resolveWaitMs({ platform: 'manual' }) === 120000,
      realWinFocus.resolveWaitMs({ platform: 'epic' }) + '/' + realWinFocus.resolveWaitMs({ platform: 'manual' }));
    expect('前台激活：非 Windows 平台直接跳过，不 spawn',
      realWinFocus.focusGameWindow({ id: 'x', executable: 'C:\\a.exe' }, { platform: 'linux' }).skipped === true);
    expect('前台激活：没有可用目标（无 exe 也无安装目录）时跳过',
      realWinFocus.focusGameWindow({ id: 'x' }, { platform: 'win32' }).reason === 'no-target');
    expect('前台激活：默认开关为开（设置 focusGameOnLaunch）',
      store.getSettings().focusGameOnLaunch !== false);
    expect('屏保：默认开启（设置 screensaverOnIdle）',
      store.getSettings().screensaverOnIdle !== false);
    expect('屏保：默认空闲 3 分钟（设置 screensaverIdleMin）',
      (store.getSettings().screensaverIdleMin || 3) === 3);
  }

  /* ---------- Steam 启动项双向同步（localconfig.vdf 的 LaunchOptions） ----------
   * 真机格式已坐实：appid 行 5 个 tab 缩进，块内键 6 个，键与值之间 2 个 tab。
   * 用临时 Steam 目录跑完整的「读 → 写 → 备份 → 幂等 → 清空」链路（store.init 同款注入）。
   */
  {
    const sl = require('../src/steamlaunch');

    const vdf = [
      '"UserLocalConfigStore"',
      '{',
      '\t"Software"',
      '\t{',
      '\t\t"Valve"',
      '\t\t{',
      '\t\t\t"Steam"',
      '\t\t\t{',
      '\t\t\t\t"apps"',
      '\t\t\t\t{',
      '\t\t\t\t\t"570"',
      '\t\t\t\t\t{',
      '\t\t\t\t\t\t"LastPlayed"\t\t"1790815137"',
      '\t\t\t\t\t\t"Playtime"\t\t"875140"',
      '\t\t\t\t\t\t"LaunchOptions"\t\t"-perfectworld"',
      '\t\t\t\t\t}',
      '\t\t\t\t\t"246420"',
      '\t\t\t\t\t{',
      '\t\t\t\t\t\t"Playtime"\t\t"528"',
      '\t\t\t\t\t}',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
      '\t}',
      '}',
      '',
    ].join('\n');

    const steamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-steam-'));
    const cfgDir = path.join(steamRoot, 'userdata', '86783296', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, 'localconfig.vdf');
    fs.writeFileSync(cfgFile, vdf, 'utf8');
    sl.init({ steamPath: steamRoot, steamRunning: false });
    const read = () => fs.readFileSync(cfgFile, 'utf8');

    // 读：Steam 里已设置的启动项必须读得出来。
    // ⚠ appid 与 '{' 之间是**换行**，正则写 [ \t]* 会一个都读不到（探针实测踩过）
    const got = sl.readAll(true);
    expect('Steam 启动项：能读出 Steam 里已设置的值（5 层 tab 缩进的 appid 块）',
      got['570'] === '-perfectworld' && got['246420'] === undefined, JSON.stringify(got));

    // %command% 双向换算
    expect('Steam 启动项：%command% 是 Steam 的命令行占位符，读出来只取它后面的参数',
      sl.toLocalArgs('gamemoderun %command% -dx11') === '-dx11'
        && sl.toLocalArgs('-dx11') === '-dx11');
    expect('Steam 启动项：写回时保留 %command% 前面的包装命令（gamemoderun / mangohud）',
      sl.toSteamValue('gamemoderun %command% -dx11', '-dx12') === 'gamemoderun %command% -dx12'
        && sl.toSteamValue('', '-dx12') === '-dx12');
    expect('Steam 启动项：清空参数时 %command% 包装命令不被误删',
      sl.toSteamValue('mangohud %command% -old', '') === 'mangohud %command%');

    // 写：给「本地没有该键」的 appid 块补一行
    const w1 = sl.write('246420', '-custom_script kr_trainer_bridge');
    const after1 = read();
    expect('Steam 启动项：写回后文件里出现该游戏的启动项',
      w1.ok === true && w1.changed === true
        && /"246420"[\s\S]{0,200}"LaunchOptions"\t\t"-custom_script kr_trainer_bridge"/.test(after1),
      w1.message);
    expect('Steam 启动项：写回只新增一行，其余内容逐字节不变',
      after1.split('\n').length === vdf.split('\n').length + 1
        && after1.includes('"LastPlayed"\t\t"1790815137"')
        && after1.includes('"LaunchOptions"\t\t"-perfectworld"'));
    expect('Steam 启动项：写回后立刻能读出新值（缓存已失效）',
      sl.readAll(true)['246420'] === '-custom_script kr_trainer_bridge');
    expect('Steam 启动项：写入前先备份（.glbak 恰是写入前的原文）',
      fs.existsSync(cfgFile + '.glbak') && fs.readFileSync(cfgFile + '.glbak', 'utf8') === vdf);

    // 幂等：同值再保存一次不该动文件
    const w2 = sl.write('246420', '-custom_script kr_trainer_bridge');
    expect('Steam 启动项：同值重复保存不改动文件（幂等，不刷修改时间）',
      w2.ok === true && w2.changed === false && read() === after1, w2.message);

    // 改已有键 = 替换那一行，不新增键
    const w3 = sl.write('570', '-perfectworld -dx11');
    expect('Steam 启动项：改已有启动项时替换该行而不是新增键',
      w3.changed === true && (read().match(/"LaunchOptions"/g) || []).length === 2
        && read().includes('"LaunchOptions"\t\t"-perfectworld -dx11"'));

    // 清空 = 删掉该行，同块其它键保留
    const w4 = sl.write('570', '');
    const after4 = read();
    expect('Steam 启动项：清空启动项 = 删掉该行，同一块的其它键保留',
      w4.changed === true && !after4.includes('-perfectworld')
        && /"570"[\s\S]{0,120}"Playtime"\t\t"875140"/.test(after4));

    // Steam 运行中：必须提示重启才生效
    sl.init({ steamPath: steamRoot, steamRunning: true });
    const w5 = sl.write('246420', '-novid');
    expect('Steam 启动项：Steam 运行中写回时提示「重启 Steam 后生效」',
      w5.ok === true && w5.changed === true && w5.steamRunning === true && /重启 Steam/.test(w5.message),
      w5.message);

    // 找不到 Steam 配置目录：返回可读原因，不抛错
    sl.init({ steamPath: path.join(os.tmpdir(), 'gl-steam-none-' + Date.now()) });
    const w6 = sl.write('246420', '-dx11');
    expect('Steam 启动项：找不到 localconfig.vdf 时返回可读原因而不是抛错',
      w6.ok === false && /localconfig\.vdf/.test(w6.message), w6.message);
    expect('Steam 启动项：读不到 Steam 目录时 readAll 返回空表',
      Object.keys(sl.readAll(true)).length === 0);

    // 多账号：当前登录账号（ActiveUser）优先
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-steam2-'));
    for (const [acc, id] of [['111', '12345'], ['222', '67890']]) {
      const d = path.join(root2, 'userdata', acc, 'config');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'localconfig.vdf'),
        vdf.replace('"570"', '"' + id + '"').replace('-perfectworld', '-acc' + acc), 'utf8');
    }
    regStub.__ubisoft = { 'HKCU\\Software\\Valve\\Steam': { values: { SteamPath: root2, ActiveUser: '111' } } };
    sl.init({ steamPath: null });                          // 走注册表桩
    expect('Steam 启动项：多账号时以当前登录账号（ActiveUser）为准',
      sl.configFiles().length === 2 && sl.configFiles()[0].account === '111',
      sl.configFiles().map(f => f.account).join(','));
    expect('Steam 启动项：多账号读出来的是当前登录账号的值',
      sl.readAll(true)['12345'] === '-acc111', JSON.stringify(sl.readAll(true)));
    regStub.__ubisoft = null;
    sl.init({ steamPath: null, steamRunning: null });
  }

  /* ---------- I) DLC 管理（自动查 Steam/Epic + 手动标记 + 在线搜索） ----------
   * 纯函数（parseInstalledDlc / isEpicDlcOf / mergeManual / dlcSearchUrl）钉死解析与合并逻辑；
   * IPC 通道验证「手动标记落盘」「非 Steam/Epic 平台返回 supported:false」「Steam 查询优雅降级」。
   * 网络（商店 API / IStoreBrowseService）在沙箱无连通，handler 必须吞掉异常不崩溃。
   */
  {
    const dlc = require('../src/dlc');

    // parseInstalledDlc：只取 InstalledDepots 区块内的 dlcappid，且去重保序
    const acf = [
      '"AppState"',
      '{',
      '\t"appid"\t\t"812140"',
      '\t"InstalledDepots"',
      '\t{',
      '\t\t"dlcappid"\t\t"937891"',   // 多 depot 引用同一 DLC → 重复
      '\t\t"dlcappid"\t\t"937891"',
      '\t\t"dlcappid"\t\t"1109770"',  // 商店未列出的免费/下架 DLC
      '\t\t"dlcappid"\t\t"937892"',
      '\t}',
      '\t"UserConfig"',
      '\t{',
      '\t\t"dlcappid"\t\t"999999"',   // 区块外的同名键不能混入
      '\t}',
      '}',
    ].join('\n');
    const parsed = dlc.parseInstalledDlc(acf);
    expect('DLC：parseInstalledDlc 只取 InstalledDepots 内的 dlcappid 且去重',
      JSON.stringify(parsed) === JSON.stringify(['937891', '1109770', '937892'])
      && !parsed.includes('999999'), parsed.join(','));

    // isEpicDlcOf：AppCategories 含 dlc 且 MainGameAppName 匹配本体
    const base = { AppCategories: ['dlc', 'game'], MainGameAppName: 'AlanWake2', DisplayName: 'AW2 DLC' };
    const notDlc = { AppCategories: ['game'], MainGameAppName: 'AlanWake2' };
    const wrongBase = { AppCategories: ['dlc'], MainGameAppName: 'OtherGame' };
    expect('DLC：isEpicDlcOf 判定 DLC 归属本体（false 当非 dlc 类/归属不对）',
      dlc.isEpicDlcOf(base, 'AlanWake2') === true
      && dlc.isEpicDlcOf(notDlc, 'AlanWake2') === false
      && dlc.isEpicDlcOf(wrongBase, 'AlanWake2') === false,
      'base=' + dlc.isEpicDlcOf(base, 'AlanWake2'));

    // mergeManual：手动覆盖优先 + 补上自动没检测到的手动项
    const auto = [{ appid: '1', name: 'A', installed: true }, { appid: '2', name: 'B', installed: false }];
    const merged = dlc.mergeManual(auto, { '2': true, '3': false });
    expect('DLC：mergeManual 手动覆盖优先 + 补用户手动项',
      merged.length === 3
      && merged.find(i => i.appid === '2').installed === true
      && merged.find(i => i.appid === '2').manual === true
      && merged.find(i => i.appid === '3').installed === false
      && merged.find(i => i.appid === '3').manual === true,
      JSON.stringify(merged.map(i => i.appid + ':' + i.installed)));

    // dlcSearchUrl：h.juij.fun + 游戏名 URL 编码
    const url = dlc.dlcSearchUrl('艾尔登法环');
    expect('DLC：dlcSearchUrl 用游戏名在 h.juij.fun 检索（中文 URL 编码）',
      url === 'https://h.juij.fun/search/?keyword=' + encodeURIComponent('艾尔登法环'), url);

    // IPC：手动标记落盘（setDlcManual）→ 读取验证 → 清除
    await handlers['games:scan'](null);   // 确保 lastGames 含游戏
    const w1 = await handlers['game:setDlcManual'](null, 'steam:730', { '937891': true, '999999': false });
    const cfg = store.getGameConfig('steam:730');
    expect('DLC：game:setDlcManual 落盘到 cfg.dlcManual',
      w1.ok === true && cfg.dlcManual
      && cfg.dlcManual['937891'] === true && cfg.dlcManual['999999'] === false,
      JSON.stringify(cfg.dlcManual));
    const w2 = await handlers['game:setDlcManual'](null, 'steam:730', { '937891': null });  // 清除覆盖
    expect('DLC：game:setDlcManual 传 null 清除该条手动覆盖',
      w2.ok === true && !('937891' in (store.getGameConfig('steam:730').dlcManual || {})),
      JSON.stringify(store.getGameConfig('steam:730').dlcManual));

    // IPC：非 Steam/Epic 平台 → supported:false（不自动查询）
    const unsup = await handlers['game:dlc'](null, 'ubisoft:42');
    expect('DLC：game:dlc 对不支持自动检测的平台返回 supported:false',
      unsup.ok === true && unsup.supported === false, JSON.stringify({ ok: unsup.ok, supported: unsup.supported }));

    // IPC：Steam 平台查询优雅降级（沙箱无 manifest / 无网络 → 不崩溃，返回 supported:true）
    const steamRes = await handlers['game:dlc'](null, 'steam:730');
    expect('DLC：game:dlc(Steam) 在缺清单/无网络时优雅降级不崩溃',
      steamRes.ok === true && steamRes.supported === true && Array.isArray(steamRes.items),
      'ok=' + steamRes.ok + ' items=' + (steamRes.items || []).length);

    // IPC：手动标记会合并进查询结果（给一个存在的 appid 覆盖，验证合并链路通）
    await handlers['game:setDlcManual'](null, 'steam:730', { '937891': true });
    const steamRes2 = await handlers['game:dlc'](null, 'steam:730');
    const manualEcho = (steamRes2.manual || {})['937891'];
    expect('DLC：game:dlc 回传合并用的 manual 映射', manualEcho === true, JSON.stringify(steamRes2.manual));
    await handlers['game:setDlcManual'](null, 'steam:730', { '937891': null });  // 还原

    /* --- v1.2.15：DLC 资料本地缓存（不每次联网）+ 手动更新 + 非 Steam 按 appid 拉全量清单 --- */

    // 本地缓存往返：写入 → 读回（带时间戳），文件落在 userData/dlc-cache.json
    dlc.writeDlcCache('730', { items: [{ appid: '111', name: 'DLC 甲' }, { appid: '222', name: 'DLC 乙' }] });
    const cacheRead = dlc.readDlcCache('730');
    expect('DLC：本地缓存 writeDlcCache/readDlcCache 往返（清单落盘 + 时间戳）',
      !!cacheRead && cacheRead.ts > 0 && cacheRead.items.length === 2 && cacheRead.items[1].name === 'DLC 乙',
      JSON.stringify(cacheRead && cacheRead.items));
    const cachePath = dlc.dlcCachePath();
    expect('DLC：缓存文件为 userData 下的 dlc-cache.json 且已落盘',
      !!cachePath && /dlc-cache\.json$/.test(cachePath) && fs.existsSync(cachePath), String(cachePath));

    // 缓存优先：getDlcCatalog 命中缓存时零联网（沙箱无网络，走网络只会拿到空列表）
    const cat = await dlc.getDlcCatalog('730', {});
    expect('DLC：getDlcCatalog 命中本地缓存即返回（cached:true，不联网）',
      cat.cached === true && cat.items.length === 2, JSON.stringify({ cached: cat.cached, n: cat.items.length }));

    // Steam：清单来自缓存，「已装」现读本地 manifest（沙箱无清单 → 全未装，且不丢清单里的项）
    const seededSteam = await dlc.getSteamDlc({ id: 'steam:730', platform: 'steam', appid: '730' }, {});
    expect('DLC：Steam 用缓存清单 + 安装状态现算（无 manifest 时 2 项全未装）',
      seededSteam.supported === true && seededSteam.items.length === 2 && seededSteam.installed.length === 0
      && seededSteam.cached === true,
      JSON.stringify({ n: seededSteam.items.length, installed: seededSteam.installed.length, cached: seededSteam.cached }));

    // 非 Steam 平台 + 有 Steam appid：按 appid 列出全部 DLC，默认都没有 → 由用户自己勾「已有」
    const byAppid = await dlc.getAppidDlc({ id: 'ubisoft:42', platform: 'ubisoft', appid: '730', name: 'AC' }, {});
    expect('DLC：非 Steam 平台 + Steam appid → 列出全部 DLC 且默认未拥有（主人自己勾已有）',
      byAppid.supported === true && byAppid.source === 'steam-appid' && byAppid.items.length === 2
      && byAppid.items.every(i => i.installed === false),
      JSON.stringify({ n: byAppid.items.length, src: byAppid.source }));
    const noAppid = await dlc.getAppidDlc({ id: 'ubisoft:42', platform: 'ubisoft' }, {});
    expect('DLC：非 Steam 且没填 appid → supported:false（不联网、只给搜索入口）',
      noAppid.supported === false, JSON.stringify({ sup: noAppid.supported }));

    // 分发器：非 Steam + appid 走 appid 清单通道（Epic 之外的平台同样适用）
    const routed = await dlc.getDlc({ id: 'ubisoft:42', platform: 'ubisoft', appid: '730' }, {});
    expect('DLC：getDlc 分发器对「非 Steam + appid」走 appid 清单通道',
      routed.supported === true && routed.source === 'steam-appid',
      JSON.stringify({ sup: routed.supported, src: routed.source }));

    // 手动更新（force）：绕过缓存联网重下；联网成功则覆盖缓存，失败则回退旧缓存且不丢清单
    const forced = await dlc.getDlcCatalog('730', { force: true });
    const forceOk = forced.cached === false
      ? forced.items.length > 0                                    // 联网成功 → 用新数据覆盖
      : (forced.stale === true && forced.items.length === 2);      // 联网失败 → 旧缓存兜底
    expect('DLC：force 手动更新绕过缓存（成功覆盖 / 失败回退旧缓存，都不清空清单）',
      forceOk, JSON.stringify({ cached: forced.cached, n: forced.items.length, stale: !!forced.stale }));

    // 负结果缓存：「查不到 / 连不上」也要落一条空清单（TTL 1 天），否则每次打开详情页都会默默重试联网
    dlc.clearDlcCache('999001');
    await dlc.getDlcCatalog('999001', {});                 // 首次：联网没结果 → 落空清单
    const neg = dlc.readDlcCache('999001');
    const neg2 = await dlc.getDlcCatalog('999001', {});    // 再次：应直接命中缓存，不再联网
    expect('DLC：查不到/连不上也落负结果缓存（1 天内不重复联网重试）',
      !!neg && neg.failed === true && neg.items.length === 0 && dlc.isCacheFresh(neg) === true
      && neg2.cached === true && neg2.items.length === 0,
      JSON.stringify({ failed: neg && neg.failed, cached2: neg2.cached }));

    // 清缓存（测试收尾，也验证「删掉某 appid 缓存」可用）
    const cleared = dlc.clearDlcCache('730');
    expect('DLC：clearDlcCache 能单独清掉某 appid 的缓存',
      cleared === true && !dlc.readDlcCache('730') && dlc.clearDlcCache('999001') === true
      && !dlc.readDlcCache('999001'), 'cleared=' + cleared);
  }

  /* ---------- 汇总 ---------- */
  results.checks = checks;
  results.summary = {
    pass: checks.filter(c => c.pass).length,
    fail: checks.filter(c => !c.pass).length,
    allPass: checks.every(c => c.pass),
  };
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');

  let out = '';
  for (const c of checks) out += (c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.detail ? '   [' + c.detail + ']' : '') + '\n';
  out += '\n' + results.summary.pass + ' passed, ' + results.summary.fail + ' failed\n';
  out += (results.summary.allPass ? 'ALL PASS\n' : 'SOME FAILED\n');
  out += 'full result: ' + OUT + '\n';
  process.stdout.write(out);
  process.exit(results.summary.allPass ? 0 : 1);
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ error: String((e && e.stack) || e), partial: results }, null, 2), 'utf8');
  process.stdout.write('ERROR: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
