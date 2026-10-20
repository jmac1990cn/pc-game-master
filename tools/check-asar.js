'use strict';
/**
 * 打包后校验：`dist/win-unpacked/resources/app.asar` 与源码是否完全一致。
 *
 * 为什么需要：`npm run build` 成功 ≠ 改动进了包（漏文件、拿到旧的 asar、
 * 忘了重启监视进程都可能）。这里把 `src/**` `renderer/**` `package.json`
 * 逐个文件与磁盘源码比对字节，并核对包内版本号。
 *
 * 用法： npm run build && npm run check:asar
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
// @electron/asar 的 exports 字段不暴露 lib/asar.js 子路径，必须按绝对路径 require
const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));

if (!fs.existsSync(ASAR)) {
  console.log('未找到 ' + ASAR + '\n请先 npm run build');
  process.exit(1);
}

/* 收集磁盘上真正会进包的文件 */
const targets = [];
const walk = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) walk(r);
    else targets.push(r);
  }
};
walk('src');
walk('renderer');
targets.push('package.json');

/** 包内路径在不同 asar 版本里可能是 / 或 \ 分隔，两种都试一遍 */
function readPacked(rel) {
  for (const v of [rel, rel.split('/').join('\\')]) {
    try { return asar.extractFile(ASAR, v); } catch (e) { /* 试下一种写法 */ }
  }
  return null;
}

let diff = 0, missing = 0;
for (const rel of targets) {
  if (rel === 'package.json') continue;   // electron-builder 会重写包内 package.json，只比对版本号
  const packed = readPacked(rel);
  if (!packed) {
    missing++;
    console.log('  MISS  ' + rel + '（包里没有）');
    continue;
  }
  const local = fs.readFileSync(path.join(ROOT, rel));
  if (!packed.equals(local)) {
    diff++;
    console.log('  DIFF  ' + rel + '（包内与源码不一致：' + packed.length + ' vs ' + local.length + ' 字节）');
  }
}

const localPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packedPkg = JSON.parse(readPacked('package.json').toString('utf8'));
const verOk = localPkg.version === packedPkg.version;

console.log('比对文件数: ' + (targets.length - 1) + '（src/ + renderer/，package.json 只比对版本号）');
console.log('包内版本: ' + packedPkg.version + '；源码版本: ' + localPkg.version + (verOk ? ' ✔' : ' ✘'));
const fail = diff > 0 || missing > 0 || !verOk;
console.log('\n' + (fail ? 'ASAR CHECK FAILED（不一致 ' + diff + '，缺失 ' + missing + '）' : 'ASAR CHECK OK：包内容与源码一致'));
process.exit(fail ? 1 : 0);
