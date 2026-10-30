'use strict';

/**
 * 非 C 盘支持校验：验证各平台扫描器在游戏 / 库安装在 D:/E:/F: 等非系统盘时，
 * 仍能正确识别路径（不丢失盘符、不被误判为卸载）。
 *
 * 说明：游戏安装目录的真实路径来自注册表 / 平台清单（本身含盘符），
 * 扫描器只做「拼接 + fs.existsSync 判定是否存在」，理论上与盘符无关。
 * 本脚本用 mock fs.existsSync 的方式，在「本机只有 C: 盘」的沙盒里也能验证
 * 代码对非 C 盘符路径的处理是否正确。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const scanner = require('../src/scanner');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ---------- 1) 路径归一化：保留非 C 盘符、还原 VDF 转义 ----------
check('normalizeLibPath 保留 D: 盘符',
  scanner.normalizeLibPath('D:\\SteamLibrary') === 'D:/SteamLibrary');
check('normalizeLibPath 还原 VDF 转义 E:\\\\Games\\\\Lib',
  scanner.normalizeLibPath('E:\\\\Games\\\\Lib') === 'E:/Games/Lib');

// ---------- 2) Steam 库扫描：解析 libraryfolders.vdf 里的非 C 盘路径 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
const steamPath = path.join(tmp, 'Steam');
fs.mkdirSync(path.join(steamPath, 'steamapps'), { recursive: true });
const vdf = [
  '"LibraryFolders"', '{',
  '"path" "D:\\\\SteamLibrary"',
  '"path" "E:\\\\Games\\\\Steam"',
  '"1" "F:\\\\SteamLib"',
  '}'
].join('\n');
fs.writeFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), vdf);
const libs = scanner.findSteamLibraries(steamPath);
check('Steam 库含 D: 盘', libs.some(l => l.toUpperCase().startsWith('D:')));
check('Steam 库含 E: 盘', libs.some(l => l.toUpperCase().startsWith('E:')));
check('Steam 库含 F: 盘', libs.some(l => l.toUpperCase().startsWith('F:')));

// ---------- 3) Epic EGL v2：非 C 盘 dir 原样保留 + 卸载/deleted 过滤 ----------
const jsonlPath = path.join(tmp, 'installations.jsonl');
fs.writeFileSync(jsonlPath, [
  JSON.stringify({ version: 1, entries: 4 }),
  '',
  JSON.stringify({ installationId: 'i1', dir: 'D:\\Epic Games\\GameA', namespace: 'ns1', itemId: 'item1', artifactId: 'art1', launchExecutable: 'gameA.exe' }),
  JSON.stringify({ installationId: 'i2', dir: 'E:\\Games\\GameB', namespace: 'ns2', itemId: 'item2', artifactId: 'art2', launchExecutable: 'gameB.exe' }),
  JSON.stringify({ installationId: 'i3', dir: 'F:\\Uninstalled', namespace: 'ns3', itemId: 'item3', artifactId: 'art3', launchExecutable: 'x.exe' }),
  JSON.stringify({ installationId: 'i4', dir: 'G:\\Del', namespace: 'ns4', itemId: 'item4', artifactId: 'art4', launchExecutable: 'y.exe', deleted: true })
].join('\n'));

// mock：假定 D:/E: 目录存在；F:/G: 不存在（应被过滤）
const realExists = fs.existsSync;
fs.existsSync = (p) => {
  if (typeof p === 'string' && /^[DE]:[\\/]/i.test(p)) return true;
  return realExists(p);
};
const titleMap = new Map([
  ['ns1:item1', 'Game A'], ['ns2:item2', 'Game B'],
  ['ns3:item3', 'Game C'], ['ns4:item4', 'Game D']
]);
const egames = scanner.parseEglv2Installations(jsonlPath, titleMap);
fs.existsSync = realExists;

check('EGL v2 收录 D: 盘游戏（installPath 保留 D:）',
  egames.some(g => (g.installPath || '').toUpperCase().startsWith('D:')));
check('EGL v2 收录 E: 盘游戏（installPath 保留 E:）',
  egames.some(g => (g.installPath || '').toUpperCase().startsWith('E:')));
check('EGL v2 过滤卸载项（F: 目录不存在）',
  !egames.some(g => (g.installPath || '').toUpperCase().startsWith('F:')));
check('EGL v2 过滤 deleted（G:）',
  !egames.some(g => (g.installPath || '').toUpperCase().startsWith('G:')));

console.log(`\n非 C 盘支持校验：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
