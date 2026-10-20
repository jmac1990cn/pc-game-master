'use strict';
/**
 * 游玩会话监视回归测试（真机、约 30 秒）。
 *
 * 钉住的行为：会话监视必须「进程还在跑 → 绝不结算；进程真的没了 → 才结算」。
 * 为什么单独测：v1.2.0 及以前，进程名推断不到的游戏（CS2 的主程序在
 * …\game\bin\win64\ 三层深处）会被判成「已退出」——后果是系统音频被切回默认，
 * 且最小化的管家窗口被弹回桌面，把全屏游戏顶到桌面。测试用一个改名后的
 * node.exe 冒充游戏主程序（fakegame.exe），避免和本脚本自身的 node.exe 撞名。
 *
 * 用法： npm run check:session
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const playtime = require('../src/playtime');

const TIMEOUT_SEC = 90;
const KILL_AFTER_SEEN_MS = 2000;    // 见到进程后再让它跑 2 秒就杀掉

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-fakesession-'));
const exe = path.join(dir, 'fakegame.exe');
fs.copyFileSync(process.execPath, exe);
// 顺带造一个深层目录，验证候选进程名的递归扫描不会漏
fs.mkdirSync(path.join(dir, 'game', 'bin', 'win64'), { recursive: true });

const game = { id: 'test:fakegame', name: '假游戏', platform: 'manual', executable: exe, installPath: dir };
const names = playtime.candidateNames(game);

const child = spawn(exe, ['-e', 'setTimeout(function(){},300000)'], { stdio: 'ignore' });
let childAlive = true;
let killScheduled = false;
const killChild = () => {
  if (!childAlive) return;
  childAlive = false;
  try { child.kill(); } catch (e) {}
};

const cleanup = () => {
  killChild();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
};

const t0 = Date.now();
let record = null;
playtime.beginSession(game, { onEnd: (rec) => { record = rec; } });

const iv = setInterval(() => {
  const el = Math.round((Date.now() - t0) / 1000);
  const st = playtime.getActiveSession();

  if (record) {
    clearInterval(iv);
    cleanup();
    const midSeen = record.seen === true;
    const ok = midSeen && record.reason === 'exited' && record.counted === false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  见到进程后进程消失才结算 ` +
      `[reason=${record.reason} seen=${record.seen} via=${record.via} 用时=${Math.round(record.ms / 1000)}s]`);
    console.log(`  ${names.includes('fakegame.exe') ? 'PASS' : 'FAIL'}  候选进程名含主程序 ` +
      `[${names.join(',') || '(空)'}]`);
    console.log(`  ${midSeen ? 'PASS' : 'FAIL'}  会话中途不只被判定一次（未在运行中误结算）`);
    console.log('\n' + (ok && names.includes('fakegame.exe') ? 'SESSION CHECK OK' : 'SESSION CHECK FAILED'));
    process.exit(ok && names.includes('fakegame.exe') ? 0 : 1);
  }

  if (st && st.seen && !killScheduled) {
    // 见到了：让它再跑一会儿，验证「运行中不结算」
    killScheduled = true;
    console.log(`  [${el}s] 已识别到游戏进程，${KILL_AFTER_SEEN_MS / 1000} 秒后结束该进程…`);
    setTimeout(killChild, KILL_AFTER_SEEN_MS);
  } else if (el % 5 === 0) {
    console.log(`  [${el}s] ${st && st.seen ? '进程已结束，等待结算…' : '等待识别游戏进程…'}`);
  }

  if (el > TIMEOUT_SEC) {
    clearInterval(iv);
    cleanup();
    console.log('\n  FAIL  超时未结算（seen=' + (st && st.seen) + '）');
    console.log('\nSESSION CHECK FAILED');
    process.exit(1);
  }
}, 1000);
