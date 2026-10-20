'use strict';

/**
 * 启动器：根据平台启动游戏，并按配置联动启动修改器。
 *  - Epic / 育碧：走平台官方 URI（com.epicgames.launcher://、uplay://），由客户端完成登录 / DRM 校验后拉起游戏
 *  - 战网：走官方命令行 `"Battle.net.exe" --exec="launch <代码>"`（Playnite 同款；battlenet:// 协议在部分环境
 *    只唤起客户端不启动游戏），无客户端时才退回 battlenet:// 协议
 *  - 其余平台：有 executable 直接 spawn exe（工作目录设为 exe 所在目录），否则用 launchCommand 兜底
 *  - trainer：可先于游戏或晚于游戏启动，支持延迟毫秒
 *
 * ⚠ 两件事必须守住（都是真机踩出来的）：
 *  1. **每个子进程都要挂 error 监听**：spawn 失败会异步发 `error` 事件，没人接就升级成
 *     主进程未捕获异常 → 管家直接弹错误框崩掉。见 attachGuard / startProcessSafe。
 *  2. **需要管理员权限的程序必须提权启动**：清单里写 requireAdministrator 的 exe
 *     （风灵月影等修改器基本都是）用 CreateProcess 直接 spawn 一律 EACCES，
 *     得交给 ShellExecute（`start`）让 Windows 弹 UAC。见 requiresElevation / buildElevatedSpawn。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');

function isUri(s) {
  return typeof s === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

/**
 * 解析启动参数串：按空白拆分，但保留双引号内的内容。
 *   -novid -windowed "D:\My Dir\x"  →  ['-novid', '-windowed', 'D:\\My Dir\\x']
 */
function parseArgs(str) {
  if (!str || typeof str !== 'string') return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return out.filter(s => s !== '');
}

/** 把参数拼成命令行片段（用于 shell 方式启动） */
function argsToShellString(args) {
  return (args || [])
    .map(a => (/[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a))
    .join(' ');
}

/**
 * 平台启动命令的参数切分：优先识别 --flag="..." 形式（如战网 --exec="launch wtcg"），
 * 去掉内层引号后作为「一个」argv 传给 spawn（Node 会自动给含空格的参数加引号，
 * 目标进程 argv 收到 --exec=launch wtcg，与官方快捷方式等价）。
 * 其余情况回退到 parseArgs。
 */
function splitQuotedArgs(rest) {
  if (typeof rest !== 'string') return [];
  const m = /^(--[a-z][a-z0-9-]*)\s*=\s*"([^"]*)"\s*(.*)$/i.exec(rest.trim());
  if (m) return [m[1] + '=' + m[2]].concat(parseArgs(m[3]));
  return parseArgs(rest);
}

/**
 * URI 启动的 spawn 组装（导出便于单测）。
 * 最终命令行：cmd.exe /d /c start "" "scheme://..."
 *
 * ⚠ 关键点（v1.1.9 修复）：
 *  - 标题占位必须写成**字面量 `""`**，不能传空字符串 ''。
 *    windowsVerbatimArguments 会原样拼接参数，空字符串等于什么都没加，
 *    cmd 收到 `start  "scheme://..."`（只有一段带引号）→ start 把这段引号
 *    当成**窗口标题**，于是开出一个标题为 URI 的空控制台窗口，游戏不启动。
 *    （实机现象：弹出标题 battlenet://WTCG 的 cmd 窗口停在提示符）
 *  - URI 用引号包住，防 & 被 cmd 当成命令分隔符截断（Epic 的 &silent=true）
 *  - windowsVerbatimArguments 让 Node 不对参数做引号转义；否则内层引号被转义成 \"，
 *    cmd 收到 \"uri\" 畸形参数，start 静默失败（v1.1.4 现象）
 */
function buildUriSpawn(target) {
  return {
    file: 'cmd.exe',
    args: ['/d', '/c', 'start', '""', '"' + target + '"'],
    opts: { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }
  };
}

/**
 * 用系统 shell 打开 URI / shell 目标（首选路径，不经过 cmd）。
 * Electron 主进程中 shell.openExternal 走 Windows ShellExecute，
 * 由系统按注册的协议处理器唤起客户端 —— 没有 cmd 引号解析问题，最稳。
 * 非 Electron 环境（单测 / 纯 node）返回 false，调用方退回 buildUriSpawn。
 * @returns {boolean} 是否已交给系统 shell 处理
 */
function openViaSystemShell(target) {
  try {
    const electron = require('electron');
    const shell = electron && electron.shell;
    if (shell && typeof shell.openExternal === 'function') {
      const p = shell.openExternal(target);
      if (p && typeof p.catch === 'function') {
        // 系统 shell 拒绝打开（协议未注册等）→ 自动退回 cmd start 兜底
        p.catch(() => {
          try {
            const u = buildUriSpawn(target);
            spawn(u.file, u.args, u.opts);
          } catch (e) { /* 兜底也失败：放弃 */ }
        });
      }
      return true;
    }
  } catch (e) { /* 非 Electron 环境：走 cmd 兜底 */ }
  return false;
}

/**
 * 给子进程挂一个错误监听器。
 *
 * ⚠ 必须挂：spawn 失败（EACCES / ENOENT / EPERM…）不是同步抛异常，而是以 `error`
 * 事件异步发出；**没有任何监听器的 error 事件会被 Node 升级成未捕获异常**，
 * 在 Electron 主进程里就是那个红色「A JavaScript error occurred in the main process」
 * 对话框，然后整个管家崩掉。
 * （实机案例：修改器清单要求管理员权限 → spawn EACCES → 弹窗、修改器没起来。）
 *
 * @param {import('child_process').ChildProcess} child
 * @param {(err:Error)=>void} [onError] 额外处理（调用方需要知道失败原因时传）
 */
function attachGuard(child, onError) {
  if (!child || typeof child.on !== 'function') return child;
  child.on('error', (e) => {
    try { if (typeof onError === 'function') onError(e); } catch (err) { /* 忽略 */ }
  });
  return child;
}

/** 这些错误码意味着「系统不让普通权限启动它」→ 值得改用提权方式再试一次 */
const ELEVATION_CODES = ['EACCES', 'EPERM', 'UNKNOWN'];

/**
 * 预检：这个 exe 的清单里是否写着 requireAdministrator（必须提权）。
 *
 * 直接 spawn 这类程序，CreateProcess 会返回 ERROR_ELEVATION_REQUIRED，
 * libuv 把它翻译成 EACCES —— 所以「修改器明明在、就是起不来」多半是它。
 *
 * 清单在 PE 的 .rsrc 段里，可能贴在文件开头，也可能贴在**结尾**
 * （实测风灵月影的 trainer：requireAdministrator 在文件的 99.8% 处），
 * 还可能夹在中段 —— 所以：小文件（≤16MB，修改器都在这个量级）整个读，
 * 大文件（游戏本体可能上百 MB）只读头尾各 1MB，够用且不吃 I/O。
 * 万一漏判也不会出事：运行时还有 EACCES → 提权重试兜底。
 *
 * @returns {boolean} true = 需要管理员权限
 */
function requiresElevation(exePath) {
  const FULL_LIMIT = 16 * 1024 * 1024;
  const CHUNK = 1024 * 1024;
  let fd = null;
  try {
    const st = fs.statSync(exePath);
    if (!st.isFile() || !st.size) return false;

    // 用 latin1 读：清单是 ASCII，避免 UTF-8 解码把二进制搞乱
    if (st.size <= FULL_LIMIT) {
      return /requireAdministrator/.test(fs.readFileSync(exePath).toString('latin1'));
    }

    fd = fs.openSync(exePath, 'r');
    const parts = [];
    const head = Buffer.alloc(CHUNK);
    fs.readSync(fd, head, 0, CHUNK, 0);
    parts.push(head);
    const tail = Buffer.alloc(CHUNK);
    fs.readSync(fd, tail, 0, CHUNK, st.size - CHUNK);
    parts.push(tail);
    return /requireAdministrator/.test(Buffer.concat(parts).toString('latin1'));
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
  }
}

/**
 * 提权启动的 spawn 组装（导出便于单测）。
 * 最终命令行：cmd.exe /d /c start "" [/d "cwd"] "exe"
 *
 * 为什么用 `start`：`start` 走 ShellExecute，Windows 会按清单里声明的等级
 * 弹出 UAC 提权确认 —— 跟您在资源管理器里双击这个程序完全一样。
 * 直接 spawn（CreateProcess）不会提权，只会得到 EACCES。
 *
 * ⚠ 标题占位仍必须是字面量 `""`（同 buildUriSpawn，见上面的注释）：
 * windowsVerbatimArguments 会原样拼接，空字符串等于没写，`start` 会把
 * 第一段带引号的参数当成窗口标题。
 */
function buildElevatedSpawn(target, cwd, extraArgs) {
  const args = ['/d', '/c', 'start', '""'];
  if (cwd) args.push('/d', '"' + cwd + '"');   // start 的工作目录开关（不是 cmd 的 /d）
  args.push('"' + target + '"');
  // 自定义启动参数也要带上，否则「需要提权的程序 + 自定义参数」会把参数静默丢掉。
  // ⚠ 这条路经过 cmd，参数里的 %VAR% 会被 cmd 展开；普通游戏/模拟器走的是直接 spawn
  //   （不经 cmd），不受影响。需要管理员的程序基本用不到 %VAR% 形式的参数。
  const tail = argsToShellString(extraArgs || []);
  if (tail) args.push(tail);
  return {
    file: 'cmd.exe',
    args,
    opts: { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }
  };
}

/** 以「请求提权」的方式启动（会弹 UAC；用户在 UAC 上点「否」则不会启动） */
function spawnElevated(target, cwd, extraArgs) {
  try {
    const u = buildElevatedSpawn(target, cwd, extraArgs);
    attachGuard(spawn(u.file, u.args, u.opts));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 启动一个进程并等它的最终结果（'spawn' 或 'error'），永不抛、永不让错误逃逸 */
function trySpawn(target, { cwd = null, shell = false, args = [] } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = startProcess(target, { cwd, shell, args });
    } catch (e) {
      return resolve({ ok: false, code: e.code || null, message: e.message });
    }
    if (!child) return resolve({ ok: true, code: null, message: '已交由系统打开' });

    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    child.on('spawn', () => done({ ok: true, code: null, message: '已启动' }));
    child.on('error', (e) => done({ ok: false, code: e.code || null, message: e.message }));
    const t = setTimeout(() => done({ ok: true, code: null, message: '已启动' }), 4000);
    if (t.unref) t.unref();
  });
}

/**
 * 启动进程（带错误兜底与可选的提权回退）。
 *
 * @param {string} target exe 路径 / 命令行 / URI
 * @param {{cwd?:string, shell?:boolean, args?:string[], allowElevate?:boolean}} opts
 *   allowElevate=true 时：目标清单要求管理员权限（或启动被系统拒绝）会自动改走
 *   ShellExecute 提权启动（弹 UAC）。游戏本体与修改器都开这个 —— 需要提权才能跑的
 *   程序不这么做就永远起不来。
 * @returns {Promise<{ok:boolean, elevated:boolean, code:string|null, message:string}>}
 */
async function startProcessSafe(target, opts = {}) {
  const { cwd = null, shell = false, args = [], allowElevate = false } = opts;

  // 预检命中：不去做那次注定失败的 spawn，直接提权（UAC 弹窗来得更快、提示更准）
  if (allowElevate && requiresElevation(target)) {
    const e = spawnElevated(target, cwd, args);
    return e.ok
      ? { ok: true, elevated: true, code: null, message: '该程序需要管理员权限，已改以管理员身份启动（若系统弹出 UAC 确认，请点「是」）' }
      : { ok: false, elevated: false, code: null, message: '提权启动失败：' + e.message };
  }

  const r = await trySpawn(target, { cwd, shell, args });
  if (r.ok) return { ok: true, elevated: false, code: null, message: r.message };

  // 运行时兜底：清单预检没覆盖到（大小写/加壳/杀软拦截）也能救回来
  if (allowElevate && ELEVATION_CODES.includes(r.code)) {
    const e = spawnElevated(target, cwd, args);
    return e.ok
      ? { ok: true, elevated: true, code: r.code, message: '直接被系统拒绝（需要管理员权限），已改以管理员身份启动（若系统弹出 UAC 确认，请点「是」）' }
      : { ok: false, elevated: false, code: r.code, message: '提权启动失败：' + e.message };
  }

  return { ok: false, elevated: false, code: r.code, message: r.message };
}

function startProcess(target, { cwd = null, shell = false, args = [] } = {}) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: false };
  if (cwd) opts.cwd = cwd;
  if (shell) opts.shell = true;

  // UWP / Store 游戏：shell:AppsFolder\<包族名>!<AppId>，交给 explorer 打开
  if (typeof target === 'string' && /^shell:/i.test(target)) {
    return attachGuard(spawn('explorer.exe', [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }));
  }

  // URI：首选系统 shell（Electron shell.openExternal → ShellExecute），
  // 由系统按注册的协议处理器唤起客户端，完全不经过 cmd，无引号解析坑。
  // 兜底：cmd /d /c start "" "uri"（注意标题是字面量 ""，见 buildUriSpawn 注释）
  if (isUri(target)) {
    if (openViaSystemShell(target)) return null;
    const u = buildUriSpawn(target);
    return attachGuard(spawn(u.file, u.args, u.opts));
  }

  // 普通命令行字符串：把参数拼在后面一起交给 shell
  if (shell) {
    const line = args.length ? `${target} ${argsToShellString(args)}` : target;
    return attachGuard(spawn(line, { ...opts, shell: true }));
  }

  return attachGuard(spawn(target, args, opts));
}

/**
 * 修改器随游戏一起关闭（用户明确要求：游戏结束后修改器不要残留）。
 *
 * 难点：修改器是「分离进程」—— 提权的（风灵月影等）走 `cmd /d /c start "" "trainer"`
 * 拉起、直接 spawn 又带 `detached:true`，主进程手里**没有**可靠的子进程句柄，
 * 而且还会被杀软/提权打断。所以不靠 PID 追踪，而是游戏结束时扫进程再终止。
 *
 * ⚠ 中文编码坑（1.2.18→1.2.19 根因修正）：修改器多为中文名/中文路径（如「风灵月影修改器.exe」、
 * 放在中文目录里）。若把含中文的 WQL 过滤串（`ExecutablePath='…中文…'` 或 `Name='…中文…'`）
 * 经 `powershell -Command` 传给 WMI，会按系统 OEM 代码页（GBK）编码，中文乱码 → 匹配不到 → 关不掉。
 * 所以 1.2.19 起彻底**不让中文进 PowerShell 命令行**：
 *   1) PowerShell 只做「导出全部进程为 UTF-8 JSON 文件」（命令本身全是 ASCII，无编码问题）；
 *   2) Node 侧按 UTF-8 精确匹配（路径完全相等 / 同名且同目录），中文零失真；
 *   3) 用数字 PID 调 `taskkill /F /PID` 关闭——PID 是数字，与编码无关，稳。
 * 这样中文名、中文路径的修改器都能稳定关掉。
 *
 * 精确性：匹配规则 = `ExecutablePath` 完全相等（大小写不敏感），或
 * `Name` 相等 且 所在目录相等——避免误杀别的游戏的同名修改器。
 * 失败时只记日志、不抛异常、不影响其它收尾。
 */

/** 拼 WMI 过滤串（纯函数，便于单测；1.2.19 起仅作单测/日志用，运行时不走命令行过滤以免中文乱码）。 */
function trainerKillFilter(exePath) {
  const esc = String(exePath).replace(/\\/g, '\\\\').replace(/'/g, "''");
  return `ExecutablePath='${esc}'`;
}

/** 按进程名（exe 文件名）拼 WMI 过滤串（纯函数，便于单测；同上，运行时已不依赖命令行过滤）。 */
function trainerKillName(exePath) {
  const name = path.basename(String(exePath));
  const esc = name.replace(/'/g, "''");
  return `Name='${esc}'`;
}

/**
 * 在进程清单里挑出「属于该修改器」的进程（纯函数，便于单测）。
 * 匹配规则（全部大小写不敏感）：
 *   - ExecutablePath 完全等于 trainerPath；或
 *   - Name 等于 trainerPath 的 basename 且 所在目录 等于 trainerPath 的目录
 * 第二条避免误杀别的游戏里同名但不同目录的修改器。
 * @param {Array<{ProcessId:number,Name:string,ExecutablePath:string}>} procs
 * @param {string} trainerPath 修改器 exe 完整路径
 * @returns {Array} 命中的进程对象
 */
function matchTrainerProcesses(procs, trainerPath) {
  const name = path.basename(trainerPath).toLowerCase();
  const target = trainerPath.toLowerCase();
  const dir = path.dirname(trainerPath).toLowerCase();
  return (procs || []).filter((p) => {
    if (!p || !p.ProcessId) return false;
    const pe = (p.ExecutablePath || '').toLowerCase();
    const pn = (p.Name || '').toLowerCase();
    const pdir = pe ? path.dirname(pe).toLowerCase() : '';
    return pe === target || (pn === name && pdir === dir);
  });
}

/**
 * 请求关闭某个修改器（1.2.19 起：UTF-8 进程清单 + Node 侧精确匹配 + PID 关闭）。
 * fire-and-forget：只发出列举/关闭请求即返回，不阻塞「游戏结束」的收尾流程。
 * @param {string} trainerPath 修改器 exe 的完整路径（游戏配置里的 game.trainer）
 * @returns {boolean} true=已发出请求；false=路径无效/文件不存在，未发出
 */
function terminateTrainer(trainerPath) {
  if (!trainerPath || typeof trainerPath !== 'string') return false;
  if (!fs.existsSync(trainerPath)) {
    log('trainer', `联动修改器路径不存在，跳过关闭：${trainerPath}`);
    return false;
  }
  // 1) 让 PowerShell 把全部进程导出成 UTF-8 JSON 文件（命令本身是纯 ASCII，无中文编码问题）
  const tmp = path.join(os.tmpdir(), `gl-trainer-procs-${process.pid}-${Date.now()}.json`)
    .replace(/'/g, "''"); // 极少见含单引号时避免破坏 PS 字符串
  const ps =
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `Get-CimInstance Win32_Process|Select-Object ProcessId,Name,ExecutablePath|` +
    `ConvertTo-Json -Compress|Out-File -FilePath "${tmp}" -Encoding utf8`;
  const dump = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps,
  ], { windowsHide: true, stdio: 'ignore' });
  attachGuard(dump, (e) => log('trainer', `列举进程失败（${trainerPath}）：${e.message}`));

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略：文件可能还没生成 */ }
  };

  dump.on('close', () => {
    let procs = [];
    try {
      const txt = fs.readFileSync(tmp, 'utf8');
      const parsed = JSON.parse(txt);
      procs = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      log('trainer', `读取进程清单失败（${trainerPath}）：${e.message}`);
      finish();
      return;
    }
    // 2) Node 侧按 UTF-8 精确匹配（中文名/中文路径都不失真）
    const matched = matchTrainerProcesses(procs, trainerPath);
    if (!matched.length) {
      log('trainer', `未找到匹配的修改器进程（${trainerPath}）`);
      finish();
      return;
    }
    // 3) 用数字 PID 关闭（与编码无关）：taskkill /F /PID 关不掉时才记日志
    let killed = 0;
    matched.forEach((p) => {
      const k = spawn('taskkill.exe', ['/F', '/PID', String(p.ProcessId)], {
        windowsHide: true, stdio: 'ignore',
      });
      attachGuard(k, () => {});
      k.on('exit', (c) => { if (c === 0) killed++; });
    });
    log('trainer', `已请求关闭 ${matched.length} 个修改器进程（${trainerPath}；命中 ${killed} 个）`);
    finish();
  });
  log('trainer', `游戏结束，关闭联动修改器：${trainerPath}`);
  return true;
}

/**
 * @param {Object} game 已合并配置的游戏对象
 *  需要字段：executable, launchCommand, name,
 *            trainer, launchOrder('game-first'|'trainer-first'), trainerDelay(ms),
 *            launchArgs(自定义启动参数，字符串)
 * @param {string} [overrideArgs] 临时覆盖启动参数（「在开始游戏时询问」模式下用户现场输入）
 * @returns {{ok:boolean, message:string}}
 */
/**
 * 纯函数：决定「启动什么、用什么方式」。导出便于单测。
 *
 * v1.1.6 起回到直接 exe 启动（v1.1.4/1.1.5 的平台命令方式在实机上表现为"只启动平台不启动游戏"）：
 *   有 exe → 直接 spawn exe；平台客户端的拉起与会话就绪等待由 platform.ensureRunning 负责
 *   （进程出现后至少等 10 秒再放行）。launchCommand 仅在无 exe 时兜底。
 */
function chooseLaunch(game, overrideArgs) {
  const rawArgs = overrideArgs !== undefined ? overrideArgs : game.launchArgs;
  const args = parseArgs(rawArgs);
  const hasExe = !!(game.executable && fs.existsSync(game.executable));
  const isPlatformCmd = typeof game.launchCommand === 'string' && game.launchCommand.length > 0;
  const isShell = isPlatformCmd && /^shell:/i.test(game.launchCommand);

  // 1) Epic / 战网 / 育碧：一律走平台官方 URI（Playnite 同款做法）——
  //    调用系统协议唤起客户端，由客户端完成登录校验与 DRM 校验后再拉起游戏，
  //    兼容 DLC / 云存档 / 成就 / 反作弊。直接 spawn 游戏 exe 会因缺少客户端会话
  //    被判定为「无有效会话」，表现为启动后自退（Epic）或自退后无后续（战网）。
  if (isPlatformCmd && PLATFORM_CLIENT_GAMES.includes(game.platform)) {
    // 形如 "C:\Program Files (x86)\Battle.net\Battle.net.exe" --exec="launch WTCG"
    // （战网官方启动方式）：拆成 exe + 单个 argv 直接 spawn，绕开 cmd 对嵌套引号的解析。
    // 经 shell 解析后 argv 就是 `--exec=launch WTCG`（含空格的一个参数）。
    const quotedCmd = /^"([^"]+)"\s+(.+)$/.exec(game.launchCommand);
    if (quotedCmd && fs.existsSync(quotedCmd[1])) {
      return {
        target: quotedCmd[1],
        opts: { cwd: path.dirname(quotedCmd[1]) },
        args: splitQuotedArgs(quotedCmd[2])
      };
    }
    // 其余是 URI：Epic（com.epicgames.launcher://…）、育碧（uplay://…）、
    // 以及找不到客户端时的战网兜底（battlenet://CODE）→ 交给系统协议处理器
    return { target: game.launchCommand, opts: { shell: true }, args: [] };
  }
  // 2) Xbox 等 UWP：无传统 exe，走 AUMID（shell:AppsFolder\...）交给 explorer
  if (!hasExe && isShell) {
    return { target: game.launchCommand, opts: { shell: true }, args: [] };
  }
  // 3) 其余平台（Steam / 手动 / 模拟器游戏 / GOG…）：有 exe 直接 spawn exe
  //    ⚠ args 必须挂在**顶层**（与上面两条分支一致）：launchGame 取的是 choice.args，
  //    塞进 opts 会被 Object.assign({}, opts, {args: choice.args}) 覆盖成 undefined，
  //    自定义启动参数（含模拟器参数）就被静默丢弃了 —— v1.2.12 修复。
  if (hasExe) {
    return { target: game.executable, opts: { cwd: path.dirname(game.executable) }, args };
  }
  if (isPlatformCmd) {
    // 兜底：形如 "C:\...\Battle.net.exe" --exec="launch wtcg" 拆成 exe+args 直接 spawn；
    // 其余（URI 等）走 shell。可带自定义参数。
    const quoted = /^"([^"]+)"\s+(.+)$/.exec(game.launchCommand);
    if (quoted && fs.existsSync(quoted[1])) {
      return { target: quoted[1], opts: { cwd: path.dirname(quoted[1]) }, args: splitQuotedArgs(quoted[2]) };
    }
    return { target: game.launchCommand, opts: { shell: true }, args };
  }
  return { target: null, opts: null, args: [] };
}

/**
 * 依赖平台客户端登录/DRM 的游戏平台（Playnite 同款启动方式）。
 * 这些平台的游戏一律走官方 URI 协议，由客户端完成校验后拉起游戏本体。
 */
const PLATFORM_CLIENT_GAMES = ['epic', 'battlenet', 'ubisoft'];

/**
 * 启动游戏（+ 按配置联动修改器）。
 *
 * v1.2.4 起改为 async：启动结果要**等真实结果**（spawn 成功 / 失败），
 * 否则「修改器需要管理员权限」这类失败会被当成成功报给界面，错误还会逃逸崩主进程。
 */
async function launchGame(game, overrideArgs) {
  const trainer = game.trainer || null;
  const order = game.launchOrder || 'game-first';
  const delay = Math.max(0, Number(game.trainerDelay) || 0);

  const launchMain = async () => {
    let choice;
    try {
      choice = chooseLaunch(game, overrideArgs);
    } catch (e) {
      return { ok: false, message: `启动《${game.name}》失败：${e.message}` };
    }
    if (!choice.target) {
      return { ok: false, message: `无法启动《${game.name}》：未找到可执行文件且无可用的平台启动命令。` };
    }
    const r = await startProcessSafe(choice.target, Object.assign({}, choice.opts, {
      args: choice.args,
      allowElevate: true,   // 少数游戏本体也要求管理员权限（如部分带反作弊的单机）
    }));
    if (!r.ok) return { ok: false, message: `启动《${game.name}》失败：${r.message}` };
    const tip = choice.args.length ? `（参数：${choice.args.join(' ')}）` : '';
    return { ok: true, message: `已启动《${game.name}》${tip}`, elevated: r.elevated };
  };

  const launchTrainer = async () => {
    if (!trainer) return { ok: true, message: '（无修改器）', elevated: false };
    if (!fs.existsSync(trainer)) {
      return { ok: false, message: `修改器不存在：${trainer}`, elevated: false };
    }
    const r = await startProcessSafe(trainer, {
      cwd: path.dirname(trainer),
      allowElevate: true,   // 风灵月影等 trainer 普遍要求管理员权限
    });
    if (r.ok) return { ok: true, message: r.elevated ? '已以管理员身份启动修改器' : '已启动修改器', elevated: !!r.elevated };
  };

  if (!trainer) return launchMain();

  if (order === 'trainer-first') {
    const t = await launchTrainer();
    if (!t.ok) return t;
    setTimeout(() => { launchMain().catch(() => {}); }, delay || 500);
    const tip = t.elevated ? '（以管理员身份，若弹出 UAC 请点「是」）' : '';
    return { ok: true, elevated: t.elevated, message: `已先启动修改器${tip}，稍后启动《${game.name}》` };
  }

  const g = await launchMain();
  if (!g.ok) return g;
  if (delay > 0) {
    setTimeout(() => { launchTrainer().catch(() => {}); }, delay);
    return { ok: true, message: `已启动《${game.name}》，${Math.round(delay / 1000)} 秒后联动启动修改器` };
  }
  const t = await launchTrainer();
  if (!t.ok) {
    // 游戏已经在跑了，修改器失败只提示、不当作启动失败
    return { ok: true, message: `${g.message}；${t.message}`, elevated: false };
  }
  const tip = t.elevated ? '，修改器已以管理员身份启动（若弹出 UAC 请点「是」）' : '，并联动启动修改器';
  return { ok: true, elevated: t.elevated, message: `${g.message}${tip}` };
}

module.exports = {
  launchGame, parseArgs, chooseLaunch, buildUriSpawn, openViaSystemShell,
  isUri, splitQuotedArgs, PLATFORM_CLIENT_GAMES,
  // 提权相关（v1.2.4）：需要管理员权限的程序（多数修改器）必须走 ShellExecute 提权
  requiresElevation, buildElevatedSpawn, startProcessSafe, attachGuard, ELEVATION_CODES,
  // 修改器随游戏一起关闭（1.2.16/1.2.18/1.2.19）：游戏进程退出时按 UTF-8 进程清单 + 精确匹配 + PID 关闭
  terminateTrainer, matchTrainerProcesses, trainerKillFilter, trainerKillName,
};
