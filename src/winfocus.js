'use strict';

/**
 * 游戏窗口前台激活（Windows 专用）。
 *
 * 解决什么问题：
 *   有些游戏启动很慢（平台客户端校验、DRM、加载器、着色器预编译），而修改器是秒起的
 *   —— 用户点「开始游戏」后，先看到的是修改器窗口，游戏窗口几十秒后才出现，
 *   而且出现时已经**被压在后面**，得手动点一下任务栏或 Alt+Tab 才能进游戏。
 *
 * 做法：
 *   启动游戏后拉起一个**独立的隐藏 PowerShell 帮助进程**，它自己循环：
 *     1) 轮询「这游戏跑起来了吗」（进程名 / 安装目录两路信号，与 playtime 同一套推断）；
 *     2) 窗口一出现就把它激活到前台；
 *     3) 随后还有一个守卫窗口（默认 20 秒）——万一又被别的窗口抢走（比如延迟启动的
 *        修改器、平台客户端的提示窗），再拉回来，但最多 4 次，之后不再打扰用户。
 *
 * 为什么用 PowerShell 而不是纯 Node：
 *   EnumWindows / SetForegroundWindow / AttachThreadInput 都是 user32 的 API，
 *   本项目零运行时依赖（没有原生模块），只能借系统自带的 PowerShell 调 Win32。
 *   脚本用 `-EncodedCommand`（UTF-16LE + Base64）整段传入：**不落盘**、不受执行策略
 *   限制、也没有任何引号 / 转义 / 中文编码的坑。
 *
 * 权限说明：目标游戏若是管理员权限运行，普通权限的帮助进程可能激活不了它的窗口
 *   —— 那种情况静默放弃（绝不为了抢焦点去弹 UAC），用户手动点一下即可。
 *
 * ⚠ 实测（本机 Win11，2026-09）——激活手法不是随便挑一个就行：
 *     手法                                        结果
 *     SetForegroundWindow                        失败（返回 False，前台没变）
 *     AttachThreadInput + SetForegroundWindow    失败（网上流传最多的那一招，本机无效）
 *     AttachThreadInput + BringWindowToTop       成功
 *     SwitchToThisWindow(h, true)                成功
 *     先发一次无害的 ALT 键再抢                  成功
 *     临时置顶翻转                               成功
 *   所以 Activate() 做成**阶梯**：逐级换手法，且**以「前台进程真的变成目标进程」为准**
 *   （不能信 API 返回值——实测有返回 False 但其实已经激活、也有返回 True 其实没激活的）。
 */

const { spawn } = require('child_process');
const { log, logPath } = require('./log');
const playtime = require('./playtime');

const DEFAULT_WAIT_MS = 120 * 1000;   // 等窗口出现的最长时间（慢启动的游戏够用）
/**
 * 平台客户端游戏（Steam / Epic / 战网 / 育碧 / Xbox）要等更久：
 * 「先启动平台客户端 → 客户端登录/DRM 校验 → 可能还要更新 → 才轮到自己拉游戏本体」，
 * 用户报的就是这一路（平台先起、游戏后起，也要直接进游戏）。
 */
const PLATFORM_WAIT_MS = 240 * 1000;
const PLATFORM_WAIT_PLATFORMS = ['steam', 'epic', 'battlenet', 'ubisoft', 'xbox'];
const DEFAULT_GUARD_MS = 20 * 1000;   // 激活后的守卫时长：期间被抢走再拉回来
const DEFAULT_POLL_MS = 700;          // 轮询间隔
const DEFAULT_MAX_ACT = 6;            // 单次启动最多激活几次（再抢就认为用户另有打算）
const MAX_NAMES = 40;                 // 传给帮助进程的候选进程名上限
const MAX_ENCODED = 30000;            // Windows 命令行长度上限 32767，留够余量

/** PowerShell 单引号字符串转义：' → '' */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** PowerShell 数组字面量：@('a','b')；空数组写成 @() */
function psArray(list) {
  const items = (list || []).filter(x => x !== null && x !== undefined && String(x) !== '');
  return items.length ? '@(' + items.map(psQuote).join(',') + ')' : '@()';
}

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 生成帮助进程要跑的 PowerShell 脚本（纯函数，便于单测）。
 *
 * @param {{names?:string[], dirs?:string[], waitMs?:number, guardMs?:number,
 *          pollMs?:number, maxAct?:number, logFile?:string|null}} p
 * @returns {string}
 */
function buildFocusScript(p = {}) {
  const names = (p.names || []).map(n => String(n).toLowerCase()).slice(0, MAX_NAMES);
  const dirs = (p.dirs || []).map(d => String(d));
  const waitMs = clampNum(p.waitMs, 1000, 10 * 60 * 1000, DEFAULT_WAIT_MS);
  const guardMs = clampNum(p.guardMs, 0, 5 * 60 * 1000, DEFAULT_GUARD_MS);
  const pollMs = clampNum(p.pollMs, 200, 5000, DEFAULT_POLL_MS);
  const maxAct = clampNum(p.maxAct, 1, 20, DEFAULT_MAX_ACT);
  const logFile = p.logFile || '';

  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '',
    '# Win32：找窗口 + 阶梯式激活（见文件顶部注释里的实测表）',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Threading;',
    '',
    'public static class GlFocus',
    '{',
    '    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);',
    '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
    '    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);',
    '    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint flags);',
    '    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    '    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '',
    '    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '',
    '    const uint GW_OWNER = 4;',
    '    const byte VK_MENU = 0x12;',
    '    const uint KEYEVENTF_KEYUP = 2;',
    '    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_SHOWWINDOW = 0x40;',
    '    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);',
    '    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);',
    '',
    '    public static uint PidOf(IntPtr h)',
    '    {',
    '        uint pid;',
    '        GetWindowThreadProcessId(h, out pid);',
    '        return pid;',
    '    }',
    '',
    '    static uint FgPid() { return PidOf(GetForegroundWindow()); }',
    '',
    '    static bool Attach()',
    '    {',
    '        uint p;',
    '        uint t = GetWindowThreadProcessId(GetForegroundWindow(), out p);',
    '        uint me = GetCurrentThreadId();',
    '        return (t != 0 && t != me) ? AttachThreadInput(me, t, true) : false;',
    '    }',
    '',
    '    static void Detach()',
    '    {',
    '        uint p;',
    '        uint t = GetWindowThreadProcessId(GetForegroundWindow(), out p);',
    '        uint me = GetCurrentThreadId();',
    '        if (t != 0 && t != me) AttachThreadInput(me, t, false);',
    '    }',
    '',
    '    // 属于这些进程的顶层主窗口：可见或最小化、没有 owner（排除弹窗/工具窗）、',
    '    // 且不是小小的 splash（最小化的窗口 rect 是 -32000 那种，尺寸检查跳过）。',
    '    public static List<IntPtr> WindowsOf(HashSet<uint> pids)',
    '    {',
    '        List<IntPtr> list = new List<IntPtr>();',
    '        EnumWindows(delegate(IntPtr h, IntPtr l)',
    '        {',
    '            uint pid;',
    '            GetWindowThreadProcessId(h, out pid);',
    '            if (!pids.Contains(pid)) return true;',
    '            bool iconic = IsIconic(h);',
    '            if (!IsWindowVisible(h) && !iconic) return true;',
    '            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;',
    '            if (!iconic)',
    '            {',
    '                RECT r;',
    '                if (!GetWindowRect(h, out r)) return true;',
    '                if ((r.Right - r.Left) < 200 || (r.Bottom - r.Top) < 150) return true;',
    '            }',
    '            list.Add(h);',
    '            return true;',
    '        }, IntPtr.Zero);',
    '        return list;',
    '    }',
    '',
    '    // 优先「已显示的窗口」里最大的那个；只剩最小化的窗口时，拿它（后面会 SW_RESTORE）',
    '    public static IntPtr Biggest(List<IntPtr> hs)',
    '    {',
    '        IntPtr shown = IntPtr.Zero;',
    '        long shownArea = -1;',
    '        IntPtr iconic = IntPtr.Zero;',
    '        foreach (IntPtr h in hs)',
    '        {',
    '            if (IsIconic(h)) { if (iconic == IntPtr.Zero) iconic = h; continue; }',
    '            RECT r;',
    '            if (!GetWindowRect(h, out r)) continue;',
    '            long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);',
    '            if (a > shownArea) { shownArea = a; shown = h; }',
    '        }',
    '        return shown != IntPtr.Zero ? shown : iconic;',
    '    }',
    '',
    '    // 阶梯式激活。判据是「前台真的变成这个窗口所属进程」——API 返回值不可信（实测两边都骗过）。',
    '    public static bool Activate(IntPtr hWnd, out int step)',
    '    {',
    '        step = 0;',
    '        if (hWnd == IntPtr.Zero) return false;',
    '        uint target = PidOf(hWnd);',
    '        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);        // SW_RESTORE',
    '        if (FgPid() == target) { step = 0; return true; }',
    '',
    '        bool at = Attach();',
    '        SetForegroundWindow(hWnd);',
    '        BringWindowToTop(hWnd);',
    '        if (at) Detach();',
    '        if (FgPid() == target) { step = 1; return true; }',
    '',
    '        // 发一次「只有按下+抬起」的 ALT：本进程成为最后一个输入来源，前台锁定失效',
    '        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);',
    '        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);',
    '        Thread.Sleep(60);',
    '        at = Attach();',
    '        SetForegroundWindow(hWnd);',
    '        BringWindowToTop(hWnd);',
    '        if (at) Detach();',
    '        if (FgPid() == target) { step = 2; return true; }',
    '',
    '        // Alt+Tab 内部用的那套（未正式文档化，但各版本 Windows 都有）',
    '        SwitchToThisWindow(hWnd, true);',
    '        Thread.Sleep(60);',
    '        if (FgPid() == target) { step = 3; return true; }',
    '',
    '        // 最后手段：临时置顶再取消（立刻恢复，不把窗口真的钉在最前面）',
    '        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);',
    '        SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);',
    '        at = Attach();',
    '        SetForegroundWindow(hWnd);',
    '        if (at) Detach();',
    '        step = 4;',
    '        return FgPid() == target;',
    '    }',
    '}',
    "'@",
    '',
    '$Names = ' + psArray(names),
    '$Dirs  = ' + psArray(dirs),
    '$WaitMs = ' + waitMs,
    '$GuardMs = ' + guardMs,
    '$PollMs = ' + pollMs,
    '$MaxAct = ' + maxAct,
    '$LogFile = ' + psQuote(logFile),
    '',
    'function Write-Note([string]$text) {',
    '  if (-not $LogFile) { return }',
    '  try {',
    '    $line = "[" + (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss") + "] [winfocus] " + $text + "`r`n"',
    '    $enc = New-Object System.Text.UTF8Encoding($false)   # 无 BOM，和主进程日志同格式',
    '    [System.IO.File]::AppendAllText($LogFile, $line, $enc)',
    '  } catch { }',
    '}',
    '',
    'function Get-GamePids([int]$cycle) {',
    '  $set = New-Object "System.Collections.Generic.HashSet[uint32]"',
    '  # 进程名便宜、每轮都查；按安装目录核对要读 Path（贵，还会对管理员进程报拒绝访问），节流到每 10 轮一次',
    '  $byPath = ($Dirs.Count -gt 0) -and (($Names.Count -eq 0) -or (($cycle % 10) -eq 1))',
    '  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {',
    '    $hit = $false',
    '    if ($Names.Count -gt 0) {',
    '      if ($Names -contains (([string]$p.ProcessName).ToLower() + ".exe")) { $hit = $true }',
    '    }',
    '    if ((-not $hit) -and $byPath) {',
    '      $pp = $p.Path',
    '      if ($pp) {',
    '        $lp = ([string]$pp).ToLower()',
    '        foreach ($d in $Dirs) { if ($lp.StartsWith($d.ToLower())) { $hit = $true; break } }',
    '      }',
    '    }',
    '    if ($hit) { [void]$set.Add([uint32]$p.Id) }',
    '  }',
    '  return ,$set',
    '}',
    '',
    '$start = Get-Date',
    '$deadline = $start.AddMilliseconds($WaitMs)',
    '$guardEnd = $start',
    '$phase = "wait"',
    '$acts = 0',
    '$actsOk = 0',
    '$cycle = 0',
    '$note = "no-window"',
    '',
    'while ($true) {',
    '  $now = Get-Date',
    '  if (($phase -eq "wait") -and ($now -gt $deadline)) { $note = "no-window"; break }',
    '  if (($phase -eq "guard") -and ($now -gt $guardEnd)) { $note = "guard-done"; break }',
    '  $cycle++',
    '',
    '  $pids = Get-GamePids -cycle $cycle',
    '  if ($pids.Count -eq 0) {',
    '    if ($phase -eq "guard") { $note = "process-gone"; break }',
    '    Start-Sleep -Milliseconds $PollMs',
    '    continue',
    '  }',
    '',
    '  $h = [GlFocus]::Biggest([GlFocus]::WindowsOf($pids))',
    '  if ($h -eq [IntPtr]::Zero) {',
    '    Start-Sleep -Milliseconds $PollMs',
    '    continue',
    '  }',
    '',
    '  $fgPid = [GlFocus]::PidOf([GlFocus]::GetForegroundWindow())',
    '  if ($pids.Contains([uint32]$fgPid)) {',
    '    # 已经是前台了：进入守卫期（游戏还在加载，随时可能被别的窗口压下去）',
    '    if ($phase -eq "wait") {',
    '      $phase = "guard"; $guardEnd = (Get-Date).AddMilliseconds($GuardMs)',
    '      Write-Note ("already-front pid=" + $fgPid + " act=" + $acts)',
    '    }',
    '    Start-Sleep -Milliseconds $PollMs',
    '    continue',
    '  }',
    '',
    '  if ($acts -ge $MaxAct) { $note = "max-activations"; break }',
    '  $step = 0',
    '  $ok = [GlFocus]::Activate($h, [ref]$step)',
    '  $acts++',
    '  if ($ok) { $actsOk++ }',
    '  Write-Note ("activate#" + $acts + " hwnd=" + $h.ToString() + " pid=" + ([GlFocus]::PidOf($h)) + " step=" + $step + " ok=" + $ok + " phase=" + $phase)',
    '  if ($phase -eq "wait") { $phase = "guard"; $guardEnd = (Get-Date).AddMilliseconds($GuardMs) }',
    '  Start-Sleep -Milliseconds $PollMs',
    '}',
    '',
    'Write-Note ($note + " acts=" + $acts + " ok=" + $actsOk + " phase=" + $phase)',
    '',
  ].join('\r\n');
}

/** UTF-16LE + Base64：PowerShell 的 -EncodedCommand 需要这种编码（中文注释也不会乱码） */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 帮助进程的 spawn 组装（导出便于单测） */
function buildFocusSpawn(script) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
           '-EncodedCommand', encodeCommand(script)],
    // ⚠ 千万别给 spawn 加 detached（真机踩过）：那会用 DETACHED_PROCESS 起进程，
    // 那时 PowerShell 没有控制台，**会在 90ms 内静默退出（exit code 0）什么都不做**。
    // 用 windowsHide + stdio ignore + unref 就够了：不闪窗口、不拖住主进程退出。
    opts: { stdio: 'ignore', windowsHide: true },
  };
}

/**
 * 该游戏「跑起来会是什么进程」——直接复用 playtime 的推断（候选名递归 3 层 + 安装目录）。
 * @returns {{names:string[], dirs:string[]}}
 */
function windowTargets(game) {
  let names = [];
  let dirs = [];
  try { names = playtime.candidateNames(game) || []; } catch (e) { names = []; }
  try { dirs = playtime.gameDirs(game) || []; } catch (e) { dirs = []; }
  return { names, dirs };
}

/** 某款游戏该等多久（平台客户端游戏等得更久，见 PLATFORM_WAIT_MS 注释） */
function resolveWaitMs(game) {
  const p = String((game && game.platform) || '').toLowerCase();
  return PLATFORM_WAIT_PLATFORMS.includes(p) ? PLATFORM_WAIT_MS : DEFAULT_WAIT_MS;
}

/**
 * 启动「游戏窗口前台激活」帮助进程。立刻返回，不阻塞启动流程。
 *
 * @param {Object} game 已合并配置的游戏对象
 * @param {{waitMs?:number, guardMs?:number, pollMs?:number, maxAct?:number, platform?:string}} [opts]
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, names:string[], dirs:string[]}}
 */
function focusGameWindow(game, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return { ok: false, skipped: true, reason: 'non-windows', names: [], dirs: [] };
  if (!game) return { ok: false, skipped: true, reason: 'no-game', names: [], dirs: [] };

  const { names, dirs } = windowTargets(game);
  if (!names.length && !dirs.length) {
    return { ok: false, skipped: true, reason: 'no-target', names, dirs };
  }

  const waitMs = opts.waitMs !== undefined ? opts.waitMs : resolveWaitMs(game);
  const script = buildFocusScript({
    names,
    dirs,
    waitMs,
    guardMs: opts.guardMs,
    pollMs: opts.pollMs,
    maxAct: opts.maxAct,
    logFile: logPath(),
  });
  const enc = encodeCommand(script);
  if (enc.length > MAX_ENCODED) {
    // 理论上到不了（候选名上限 40 个）；真到了就放弃，别硬塞一个会被截断的命令行
    log('winfocus', `激活脚本过长（${enc.length}），已跳过`);
    return { ok: false, skipped: true, reason: 'script-too-long', names, dirs };
  }

  try {
    const sp = buildFocusSpawn(script);
    const child = spawn(sp.file, sp.args, sp.opts);
    // 与 launcher 同一条铁律：spawn 失败是 error 事件，没人接就是主进程未捕获异常
    child.on('error', (e) => { try { log('winfocus', '帮助进程启动失败：' + (e && e.message)); } catch (err) {} });
    if (typeof child.unref === 'function') child.unref();
    log('winfocus', `已启动前台激活帮助进程 游戏=${game.id} 平台=${game.platform || '-'} ` +
      `等待上限=${Math.round(waitMs / 1000)}s 候选进程名=${names.length} 目录信号=${dirs.length}`);
    return { ok: true, names, dirs, waitMs };
  } catch (e) {
    log('winfocus', '前台激活启动异常：' + (e && e.message));
    return { ok: false, skipped: true, reason: 'spawn-failed', names, dirs };
  }
}

module.exports = {
  focusGameWindow,
  windowTargets,
  resolveWaitMs,
  buildFocusScript,
  buildFocusSpawn,
  encodeCommand,
  DEFAULT_WAIT_MS,
  PLATFORM_WAIT_MS,
  PLATFORM_WAIT_PLATFORMS,
  DEFAULT_GUARD_MS,
  MAX_ENCODED,
};
