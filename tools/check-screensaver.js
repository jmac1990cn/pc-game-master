'use strict';
/**
 * 屏保回归（真实 Electron 渲染，跑真实 screensaver.js 逻辑）
 *
 * 断言：
 *  1. 空闲达到阈值（测试里用 0.6s）后，屏保自动出现（#screensaver.show + isActive）
 *  2. 任意输入（mousemove）立即退出屏保，并重新计时
 *  3. 退出后再次空闲，屏保会再次出现（计时没坏）
 *  4. 轮播会推进：停留 5s 后，前台图层切到「下一张」背景图
 *
 * 用 data: 页面把真实 style.css + 真实 screensaver.js 一起加载（无需跑整个 app，
 * 因为没有 window.api 也能驱动屏保逻辑），游戏列表用 3 张不同颜色的 1x1 png 顶替。
 *
 * 用法： npm run check:screensaver
 */
const fs = require('fs');
const path = require('path');

// 必须跑在 Electron 主进程里；普通 node 启动时自动用 Electron 重新拉起自己
if (process.type !== 'browser') {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = require('electron');
  const r = require('child_process').spawnSync(exe, [__filename], { stdio: 'inherit', env });
  process.exit(r.status || 0);
}

const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'renderer/style.css'), 'utf8');
const screensaverJs = fs.readFileSync(path.join(ROOT, 'renderer/screensaver.js'), 'utf8');

// 3 张不同颜色 1x1 png（仅用于比对 url 字符串，像素不重要）
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const GREEN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGDgPwAADgABMEm7pQAAAABJRU5ErkJggg==';
const BLUE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGD4fwAADwABMEm7pQAAAABJRU5ErkJggg==';

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>`
  + `<body><div id="grid"></div>`
  + `<script>${screensaverJs}</script>`
  + `<script>window.__FAKE=[{name:'A',background:'${RED}'},{name:'B',background:'${GREEN}'},{name:'C',cover:'${BLUE}'}];`
  + `window.Screensaver.init({enabled:true,idleMin:0.01,getGames:function(){return window.__FAKE;},isBlocked:function(){return false;}});`
  + `window.__ready=true;</script>`
  + `</body></html>`;

const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(page);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(win, expr, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await win.webContents.executeJavaScript(expr)) return true;
    await sleep(100);
  }
  return false;
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, backgroundColor: '#0b0e14' });
  await win.loadURL(dataUrl);
  const ready = await waitFor(win, 'window.__ready === true', 5000);
  if (!ready) { console.log('屏保脚本未就绪'); app.quit(); process.exitCode = 1; return; }

  const results = [];
  // 1) 空闲后出现
  const appeared = await waitFor(win, 'window.Screensaver.isActive()', 3000);
  results.push(['空闲 0.6s 后屏保自动出现', appeared]);

  // 2) 任意输入退出，并重新计时
  let front1 = null;
  if (appeared) {
    front1 = await win.webContents.executeJavaScript(
      "document.querySelector('#screensaver .ss-layer.front').style.backgroundImage");
    await win.webContents.executeJavaScript("window.dispatchEvent(new MouseEvent('mousemove'))");
  }
  const dismissed = await waitFor(win, '!window.Screensaver.isActive()', 1500);
  results.push(['鼠标移动立即退出屏保', dismissed]);

  // 3) 退出后再次空闲，屏保会再次出现
  const appeared2 = await waitFor(win, 'window.Screensaver.isActive()', 3000);
  results.push(['退出后再次空闲屏保重现（计时未坏）', appeared2]);

  // 4) 轮播推进：停留 5s 后前台图层切到下一张
  let rotated = false, front2 = null;
  if (appeared2) {
    await sleep(5400);
    front2 = await win.webContents.executeJavaScript(
      "document.querySelector('#screensaver .ss-layer.front').style.backgroundImage");
    rotated = front1 && front2 && front1 !== front2;
  }
  results.push(['轮播推进（前台图层切到下一张背景）', rotated]);

  let fail = 0;
  results.forEach(([name, ok]) => { if (!ok) fail++; console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + name); });
  console.log('');
  console.log(`${results.length - fail}/${results.length} 项屏保断言通过`);
  console.log(fail ? 'CHECK FAILED' : 'ALL OK');
  app.quit();
  process.exitCode = fail ? 1 : 0;
});
