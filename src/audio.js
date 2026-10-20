'use strict';

/**
 * 音频输出通道管理（Windows）。
 *
 * 两个能力：
 *   1) 枚举「可用的播放设备」——用 COM 的 IMMDeviceEnumerator 拿到真实端点 ID，
 *      再用注册表 MMDevices\Audio\Render 里的属性取友好名（如「扬声器 (Realtek Audio)」）。
 *   2) 切换系统默认播放设备——用 IPolicyConfig::SetDefaultEndpoint（多媒体/通信/控制台三个角色一起设）。
 *
 * 为什么用 PowerShell + 内联 C#？
 *   Windows 没有公开的「按应用指定输出设备」稳定接口（1803+ 的 IAudioPolicyConfigFactory 属未公开 API），
 *   而「把系统默认输出切走、游戏结束再切回来」既可靠又不依赖第三方组件。
 *   内联 C# 由 PowerShell 的 Add-Type 在运行时编译，不需要随包分发原生模块。
 *
 * 实现细节：脚本以 -EncodedCommand（UTF-16LE Base64）传入，彻底规避中文路径 / 控制台代码页的编码问题；
 * 结果由脚本写成 UTF-8 JSON 文件，再由本模块读回。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/* ------------------------------------------------------------------ C# 内核 */
/* 注意：这段 C# 会被塞进 PowerShell 的 here-string 再编译，注释一律用英文，
   避免 PowerShell 5.1 按 ANSI 读取导致中文注释串行、编译失败。 */
const CS_CORE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class GameAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int stgmAccess, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
        [PreserveSig] int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
        [PreserveSig] int ResetDeviceFormat(string pszDeviceName);
        [PreserveSig] int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
        [PreserveSig] int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
        [PreserveSig] int GetShareMode(string pszDeviceName, IntPtr pMode);
        [PreserveSig] int SetShareMode(string pszDeviceName, IntPtr mode);
        [PreserveSig] int GetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
        [PreserveSig] int SetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
        [PreserveSig] int SetDefaultEndpoint(string pszDeviceName, int role);
        [PreserveSig] int SetEndpointVisibility(string pszDeviceName, bool bVisible);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    private class CPolicyConfigClient { }

    private static IMMDeviceEnumerator Enumerator()
    {
        return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    }

    // Current default render endpoint id (eRender = 0, eMultimedia = 1)
    public static string GetDefaultId()
    {
        try
        {
            IMMDevice dev;
            int hr = Enumerator().GetDefaultAudioEndpoint(0, 1, out dev);
            if (hr != 0 || dev == null) return null;
            string id;
            if (dev.GetId(out id) != 0) return null;
            return id;
        }
        catch { return null; }
    }

    // All active render endpoints (DEVICE_STATE_ACTIVE = 1)
    public static string[] ListActiveIds()
    {
        var list = new List<string>();
        try
        {
            IMMDeviceCollection col;
            int hr = Enumerator().EnumAudioEndpoints(0, 1, out col);
            if (hr != 0 || col == null) return list.ToArray();
            int count;
            if (col.GetCount(out count) != 0) return list.ToArray();
            for (int i = 0; i < count; i++)
            {
                IMMDevice d;
                if (col.Item(i, out d) != 0 || d == null) continue;
                string id;
                if (d.GetId(out id) == 0 && !string.IsNullOrEmpty(id)) list.Add(id);
            }
        }
        catch { }
        return list.ToArray();
    }

    // Switch system default render endpoint for all three roles
    public static bool SetDefaultId(string deviceId)
    {
        try
        {
            var pc = (IPolicyConfig)(new CPolicyConfigClient());
            bool ok = true;
            for (int role = 0; role < 3; role++)
            {
                if (pc.SetDefaultEndpoint(deviceId, role) != 0) ok = false;
            }
            return ok;
        }
        catch { return false; }
    }
}
`;

/* ------------------------------------------------------------------ 工具 */

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 把 PowerShell 脚本以 -EncodedCommand 方式执行，返回脚本写出的 JSON（失败返回 null） */
function runPs(body) {
  if (!IS_WIN) return null;
  const outFile = path.join(os.tmpdir(), `gl-audio-${process.pid}-${Date.now()}.json`);
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$outFile = ' + psQuote(outFile),
    "$src = @'" + '\n' + CS_CORE + '\n' + "'@",
    'try {',
    '  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop | Out-Null',
    '} catch {',
    "  [IO.File]::WriteAllText($outFile, '{\"ok\":false,\"error\":\"addtype\"}', [Text.Encoding]::UTF8)",
    '  exit 1',
    '}',
    body,
  ].join('\n');

  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 25000,
    });
    if (!fs.existsSync(outFile)) return null;
    const txt = fs.readFileSync(outFile, 'utf8');
    return JSON.parse(txt.replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(outFile); } catch (e) {}
  }
}

const PS_LIST = `
$def = [GameAudio]::GetDefaultId()
$names = @{}
foreach ($k in (Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render' -ErrorAction SilentlyContinue)) {
  $props = Get-ItemProperty -Path (Join-Path $k.PSPath 'Properties') -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  $n = $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  $d = $props.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
  if (-not $n) { continue }
  if ($d -and $d -ne $n) { $names[$k.PSChildName] = "$n ($d)" } else { $names[$k.PSChildName] = "$n" }
}
$items = @()
foreach ($id in [GameAudio]::ListActiveIds()) {
  $guid = ($id -split '\\.')[-1]
  if ($names.ContainsKey($guid)) { $label = $names[$guid] } else { $label = $guid }
  $items += [pscustomobject]@{ id = $id; name = $label }
}
$json = [pscustomobject]@{ ok = $true; 'default' = $def; devices = $items } | ConvertTo-Json -Depth 5 -Compress
[IO.File]::WriteAllText($outFile, $json, [Text.Encoding]::UTF8)
`;

function psSet(deviceId) {
  return [
    '$ok = [GameAudio]::SetDefaultId(' + psQuote(deviceId) + ')',
    '$now = [GameAudio]::GetDefaultId()',
    '$json = [pscustomobject]@{ ok = $ok; \'default\' = $now } | ConvertTo-Json -Compress',
    '[IO.File]::WriteAllText($outFile, $json, [Text.Encoding]::UTF8)',
  ].join('\n');
}

/* ------------------------------------------------------------------ 对外 API */

let cache = { at: 0, data: null };
const CACHE_TTL = 30 * 1000;

/**
 * 列出可用播放设备。
 * @returns {Promise<{ok:boolean, default:string|null, devices:{id:string,name:string}[], error?:string}>}
 */
async function listDevices(opts = {}) {
  if (!IS_WIN) return { ok: false, default: null, devices: [], error: 'unsupported-platform' };
  const now = Date.now();
  if (!opts.force && cache.data && now - cache.at < CACHE_TTL) return cache.data;

  const r = runPs(PS_LIST);
  if (!r || !r.ok) return { ok: false, default: null, devices: [], error: 'enum-failed' };

  const devices = Array.isArray(r.devices) ? r.devices : (r.devices ? [r.devices] : []);
  const data = {
    ok: true,
    default: r['default'] || null,
    devices: devices.filter(d => d && d.id).map(d => ({ id: d.id, name: d.name || d.id })),
  };
  cache = { at: now, data };
  return data;
}

/** 取当前系统默认播放设备 ID（读缓存，不触发枚举） */
function getCachedDefaultId() {
  return cache.data ? cache.data.default : null;
}

/**
 * 切换系统默认播放设备。
 * @param {string} deviceId 端点 ID（形如 {0.0.0.00000000}.{guid}）
 */
async function setDefault(deviceId, opts = {}) {
  if (!IS_WIN || !deviceId) return { ok: false, message: '未指定音频设备' };
  const r = runPs(psSet(deviceId));
  if (!r) return { ok: false, message: '切换失败（PowerShell 未返回结果）' };
  if (!r.ok) return { ok: false, message: '切换失败（设备可能已断开）' };
  // 结果可能被系统延迟生效，稍后刷新缓存
  const d = await listDevices({ force: true });
  return { ok: true, current: (d && d.default) || r['default'] || null };
}

/** 设备 ID -> 显示名（用于状态提示） */
function labelOf(deviceId) {
  if (!deviceId || !cache.data) return deviceId || '';
  const hit = cache.data.devices.find(d => d.id === deviceId);
  return hit ? hit.name : deviceId;
}

function invalidate() {
  cache = { at: 0, data: null };
}

module.exports = { listDevices, setDefault, getCachedDefaultId, labelOf, invalidate, isSupported: () => IS_WIN };
