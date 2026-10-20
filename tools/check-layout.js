'use strict';
/**
 * 桌面模式布局回归（真实 Electron 渲染，纯 CSS 正则挡不住布局回归）
 *
 * 断言（都是真机踩过的坑，见 skill）：
 *  1. 桌面网格「封面堆叠」不复发：行间距必须 ≥ 卡片高（用 offsetTop，避开选中卡的 scale 干扰）
 *  2. 卡片保持 3:4.4 竖版比例（网格塌缩时卡片会变形）
 *  3. 顶栏始终单行：窗口变窄时筛选条横向滚动，而不是折行把顶栏撑成多层
 *  4. 游戏多到装不下时，网格可纵向滚动（鼠标滚轮向下）
 *
 * 用法： npm run check:layout
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
// 真实 index.html：去掉 app.js（无 window.api 会报错），CSS 内联（data: URL 加载不到相对路径）
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8')
  .replace(/<script[^>]*src="app\.js"[^>]*><\/script>/g, '')
  .replace(/<link[^>]*style\.css[^>]*>/, '<style>' + css + '</style>');

/** 在页面里：填充 N 个卡片、按应用的 applyTileSize 公式定卡宽、量测 */
const measure = (N) => `(function(){
  document.body.classList.add('desktop-mode');
  const grid = document.getElementById('grid');
  let s = '';
  for (let i=0;i<${N};i++) s += '<div class="tile'+(i===0?' selected':'')+'"><img class="cover" src="" alt=""/><span class="badge">Steam</span><div class="meta"><div class="name">游戏 '+i+'</div></div></div>';
  grid.innerHTML = s;
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap)||14;
  const padX = (parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);
  const padY = (parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
  const W = grid.clientWidth, H = grid.clientHeight;
  const byW = (W-padX-gap*4)/5;
  const byH = ((H-padY-gap)/2)*(3/4.4);
  const w = Math.max(78, Math.min(byW, byH, 260));
  grid.style.setProperty('--tile-w', Math.round(w)+'px');
  const items=[...grid.children].map(e=>({w:e.offsetWidth,h:e.offsetHeight,top:e.offsetTop}));
  const tops=[...new Set(items.map(i=>i.top))].sort((a,b)=>a-b);
  let minGap=Infinity; for(let i=1;i<tops.length;i++) minGap=Math.min(minGap,tops[i]-tops[i-1]);
  const tb=document.querySelector('.topbar').getBoundingClientRect();
  const fl=document.querySelector('.filters').getBoundingClientRect();
  const t=items[0];
  return { w:t.w, h:t.h, rows:tops.length, rowGap:minGap,
    ratio:+(t.h/t.w/4.4*3).toFixed(3),
    overlap: minGap < t.h - 2,
    canScroll: grid.scrollHeight > grid.clientHeight + 2,
    topbarH: Math.round(tb.height), filtersH: Math.round(fl.height) };
})()`;

const SIZES = [[1280, 720], [1280, 800], [1100, 720], [960, 540], [1600, 900]];
const COUNTS = [8, 40, 90];
const RATIO_TOL = 0.03;     // 3:4.4 比例允许的偏差
const FILTERS_MAX = 46;     // 筛选条单行的高度上限（约 35px；折行会 >60）

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let fail = 0, total = 0;
  const fail_lines = [];
  for (const [w, h] of SIZES) {
    const win = new BrowserWindow({ width: w, height: h, show: false, backgroundColor: '#0b0e14' });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 300));
    for (const n of COUNTS) {
      const m = await win.webContents.executeJavaScript(measure(n));
      const oneRow = m.filtersH <= FILTERS_MAX;
      const ratioOk = Math.abs(m.ratio - 1) <= RATIO_TOL;
      // 90 个游戏在任何窗口下都装不下，必须可滚
      const scrollOk = n < 40 ? true : m.canScroll;
      const ok = !m.overlap && ratioOk && oneRow && scrollOk;
      total++;
      if (!ok) {
        fail++;
        fail_lines.push(`  ${w}x${h} n=${n}: 重叠=${m.overlap} 比例=${m.ratio} 筛选单行=${oneRow}(h=${m.filtersH}) 可滚=${m.canScroll}`);
      }
      console.log(`  ${w}x${h} n=${n}  卡=${m.w}x${m.h} 行=${m.rows} 行间距=${m.rowGap} 比例=${m.ratio} 顶栏=${m.topbarH} 筛选=${m.filtersH} 可滚=${m.canScroll}  -> ${ok ? 'OK' : 'FAIL'}`);
    }
    win.destroy();
  }
  console.log('');
  if (fail) {
    console.log('布局回归明细:');
    fail_lines.forEach(l => console.log(l));
  }
  console.log(`${total - fail}/${total} 项布局断言通过`);
  console.log(fail ? 'CHECK FAILED' : 'ALL OK');
  app.quit();
  process.exitCode = fail ? 1 : 0;
});
