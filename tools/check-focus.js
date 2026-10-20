'use strict';
/**
 * 游戏窗口前台激活 · 真机回归测试（约 30 秒，会短暂弹出游戏窗口并最小化一次）
 *
 * 为什么要真机跑：这个功能的成败完全取决于 Windows 的「前台窗口锁定」行为，
 * 而且**不同手法在这台机器上的效果不一样**（实测：单用 SetForegroundWindow 和
 * AttachThreadInput 都无效，BringWindowToTop + Attach 才通）。纯静态断言测不出来。
 *
 * 设计（不依赖任何第三方"诱饵"程序，本沙箱里 notepad/calc 都建不出可枚举窗口）：
 *   本测试用「把游戏窗口自己最小化」来制造"被压在后面"的状态，逼 helper 真的去拉。
 *
 *   编排：
 *   T+0.0  起"慢启动游戏"（Electron 窗口，focus:false，~5s 后才出现）
 *   T+0.4  起待测帮助进程 helperA（目标 electron，wait 40s，guard 15s，maxAct 6）
 *   T+~5   游戏窗口出现 → 测试把它最小化（制造 behind）→ helperA 必须把它拉回前台
 *   验证1   helperA 等到慢游戏、且确实激活过一次（activate#1 ok=True），前台=游戏
 *   验证2   再把游戏最小化 → 验证守卫期把游戏拉回前台（轮询前台状态回到游戏）
 *
 * ⚠ 被激活的窗口必须用 windowsHide:false 起：windowsHide 会给子进程的 STARTUPINFO
 *   塞 SW_HIDE，应用自己的第一次 ShowWindow 会被系统忽略 → 窗口永远 hidden（踩过）。
 *
 * 用法： npm run check:focus
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const wf = require('../src/winfocus');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WAIT_WINDOW_MS = 4000;          // 断言阈值：helper 至少要等这么久才激活（证明它在"等"慢游戏）
const GAME_APPEAR_MS = 6000;           // 模拟"慢启动游戏"：窗口延迟多久才出现（> 阈值，确保 wait 被测到）
const GAME_TITLE = 'GLTEST-GAME';

const checks = [];
const expect = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-focus-check-'));
const logFile = path.join(tmp, 'focus.log');
const gameMain = path.join(tmp, 'game-main.js');
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(gameMain, [
  "const { app, BrowserWindow } = require('electron');",
  'app.on("window-all-closed", () => {});',
  'setTimeout(() => {',
  '  const w = new BrowserWindow({ width: 700, height: 460, title: ' + JSON.stringify(GAME_TITLE) +
    ', focus: false, show: true });',
  '  w.loadURL("data:text/html,<h1>' + GAME_TITLE + '</h1>");',
  '}, ' + GAME_APPEAR_MS + ');',
  '',
].join('\n'), 'utf8');

/** 当前前台：标题|进程名|pid */
function foreground() {
  const ps = [
    "$sig = @'",
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class FgProbe {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $sig',
    '$h = [FgProbe]::GetForegroundWindow()',
    '$sb = New-Object System.Text.StringBuilder 512',
    '[void][FgProbe]::GetWindowText($h, $sb, 512)',
    '$p = 0; [void][FgProbe]::GetWindowThreadProcessId($h, [ref]$p)',
    '$n = ""; try { $n = (Get-Process -Id $p).ProcessName } catch {}',
    '$sb.ToString() + "|" + $n + "|pid=" + $p',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').trim();
}

/** 把 pid 的 GLTEST-GAME 窗口最小化（制造"被压在后面"的状态，逼 helper 去拉） */
function pushBehind(pid) {
  const ps = [
    '$code = @\'',
    'using System; using System.Runtime.InteropServices;',
    'public static class Pb {',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc c, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $code',
    '$target = ' + pid,
    '$found = $false',
    '[Pb]::EnumWindows({ param($h,$l)',
    '  $p=0; [void][Pb]::GetWindowThreadProcessId($h,[ref]$p)',
    '  if ($p -eq $target) { [void][Pb]::ShowWindow($h, 6); $found = $true }', // 6 = SW_MINIMIZE
    '  return $true',
    '}, [IntPtr]::Zero)',
    '$found',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return /true/i.test(r.stdout || '');
}

function spawnHelper(opt) {
  const script = wf.buildFocusScript(Object.assign({ logFile }, opt));
  const sp = wf.buildFocusSpawn(script);
  const child = spawn(sp.file, sp.args, sp.opts);   // 与生产代码同一套 opts
  child.on('error', (e) => console.log('  （帮助进程启动失败：' + e.message + '）'));
  return child;
}

/** 从日志里取「包含某正则的整行」（含行首时间戳），便于后续解析延迟 */
function firstMatch(re) {
  const m = readLog().match(new RegExp('^.*' + re.source, 'm'));
  return m ? m[0] : null;
}
/** 本地时间字符串 'yyyy-MM-ddTHH:mm:ss' -> 自 1970 的毫秒（按本地分量构造，避开时区解析歧义） */
function toLocalMs(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

const T0 = Date.now();
const rel = (ms) => Math.round(ms / 1000);
const fgIsGame = (fg) => /GLTEST-GAME/.test(fg);

(async () => {
  if (process.platform !== 'win32') { console.log('  跳过：非 Windows'); return; }

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const game = spawn(ELECTRON, [gameMain], { stdio: 'ignore', env, windowsHide: false });
  await sleep(400);

  const helperStart = Date.now();
  const helperA = spawnHelper({ names: ['electron.exe'], waitMs: 40000, guardMs: 15000, pollMs: 500, maxAct: 6 });

  // 等游戏窗口真正出现（标题可见）
  let up = false;
  for (let i = 0; i < 40; i++) {
    if (fgIsGame(foreground()) || readLog().includes('pid=' + game.pid)) { up = true; break; }
    await sleep(500);
  }
  expect('游戏窗口已出现（可被枚举）', up, up ? 'ok' : '超时未出现');
  if (!up) { cleanup(game, helperA); return; }

  // 1) 制造 behind：把游戏窗口最小化 → helperA 必须把它拉回前台
  pushBehind(game.pid);
  await sleep(600);
  const acted = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const line = firstMatch(new RegExp('activate#1 hwnd=\\d+ pid=' + game.pid + ' step=\\d+ ok=True'));
      if (line) return line;
      await sleep(200);
    }
    return null;
  })();
  let delayOk = false, delayMs = -1;
  if (acted) {
    const tsLine = acted.match(/^\[([\d\-:T]+)\]/);
    const actMs = tsLine ? toLocalMs(tsLine[1]) : NaN;
    delayMs = actMs - helperStart;
    delayOk = delayMs >= WAIT_WINDOW_MS;   // 等到慢游戏出现后才激活（不是一启动就瞎抢）
  }
  expect('等到慢游戏出现后才激活、且确实拉了一次（核心能力）',
    !!acted && delayOk, acted ? `激活行="${acted}" 延迟≈${rel(delayMs)}s` : '20s 内没激活');
  const fgAfterAct = foreground();
  expect('激活后前台 = 游戏窗口', fgIsGame(fgAfterAct), fgAfterAct);

  // 2) 守卫期：再把游戏最小化（模拟被延迟弹出的修改器/平台提示窗抢走），helperA 应拉回
  pushBehind(game.pid);
  let back = false;
  for (let i = 0; i < 30; i++) {           // 轮询前台状态，最多 15s
    if (fgIsGame(foreground())) { back = true; break; }
    await sleep(500);
  }
  expect('守卫期把被抢走的游戏窗口拉回前台', back, back ? '已拉回' : '15s 内没拉回（末态：' + foreground() + '）');

  const log = readLog();
  console.log('  （帮助进程日志：\n' + log.trim().split(/\r?\n/).map(l => '    ' + l).join('\n') + '\n  ）');

  cleanup(game, helperA);
})().catch(e => {
  console.log('ERROR: ' + ((e && e.stack) || e));
  process.exit(1);
});

function cleanup(game, helperA) {
  for (const c of [game, helperA]) { try { c.kill(); } catch (e) {} }
  spawnSync('taskkill', ['/PID', String(game.pid), '/T', '/F'], { windowsHide: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const fail = checks.filter(c => !c.pass).length;
  console.log('\n' + (checks.length - fail) + ' passed, ' + fail + ' failed（总耗时 ' + rel(Date.now() - T0) + 's）');
  console.log(fail ? 'SOME FAILED' : 'ALL PASS');
  process.exit(fail ? 1 : 0);
}
