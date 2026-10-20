'use strict';
/**
 * DLC 区块 UI 回归（真实 Electron 渲染，纯正则断言挡不住的交互/样式回归）
 *
 * 覆盖（v1.2.15 用户明确要求的三点）：
 *  1. 「整合在一个按钮里」：默认折叠 → 点按钮才展开明细，再点收起；
 *     并且真的量 `getComputedStyle(#dlcBody).display` —— 明细容器是 `display:flex`，
 *     如果忘了 `.detail-dlc-body[hidden]{display:none}`，hidden 属性会被顶掉、折叠失效。
 *  2. 「资料本地保存，不要每次查询，有手动更新按钮」：缓存命中时状态行标「本地缓存 + x 小时前更新」，
 *     点「↻ 更新」必须带 `{force:true}` 发起联网重下，并自动展开让用户看到结果。
 *  3. 「非 Steam 游戏有 appid 就列全部 DLC，主人自己选已有」：source=steam-appid 时徽标用「已有/未有」，
 *     勾选后统计即时更新；「🔍 在线搜索 DLC」用游戏名（URL 编码）打开 h.juij.fun。
 *
 * 做法：加载真实 index.html（去掉真 app.js，CSS 内联，data: URL 载不到相对路径），
 * 注入桩 window.api + 真实 app.js 源码，再直接驱动 renderDlc / 按钮点击。
 * 用法： npm run check:dlc      失败以非 0 退出
 */

// 必须跑在 Electron 主进程里；普通 node 启动时自动用 Electron 重新拉起自己
if (process.type !== 'browser') {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = require('electron');
  const r = require('child_process').spawnSync(exe, [__filename], { stdio: 'inherit', env });
  process.exit(r.status || 0);
}

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const cssSrc = fs.readFileSync(path.join(ROOT, 'renderer/style.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const ssSrc = fs.readFileSync(path.join(ROOT, 'renderer/screensaver.js'), 'utf8');

/* 桩 window.api：记录 DLC 相关调用，其余方法一律返回 ok 的空对象（init 里调到的都要能跑） */
const STUB = `<script>
(function () {
  window.__calls = { getDlc: [], setDlcManual: [], openExternal: [] };
  window.__dlcPayload = null;
  var real = {
    getDlc: function (id, opts) { window.__calls.getDlc.push({ id: id, opts: opts || null }); return Promise.resolve(window.__dlcPayload); },
    setDlcManual: function (id, map) { window.__calls.setDlcManual.push({ id: id, map: map }); return Promise.resolve({ ok: true }); },
    openExternal: function (u) { window.__calls.openExternal.push(u); return Promise.resolve({ ok: true }); },
    getGames: function () { return Promise.resolve([]); },
    getSettings: function () { return Promise.resolve({}); }
  };
  window.api = new Proxy(real, {
    get: function (t, k) {
      if (k in t) return t[k];
      return function () { return Promise.resolve({ ok: true, games: [], items: [], settings: {} }); };
    }
  });
})();
</script>`;

/* 把被测函数与状态注入出口挂到 window（app.js 是脚本作用域，外部拿不到内部函数） */
const EXPORT = `
;window.__dlcTest = {
  renderDlc: renderDlc,
  applyDlcOpen: applyDlcOpen,
  state: function (gs, id) { games = gs; detailId = id; selectedIndex = 0; }
};`;

const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8')
  .replace(/<script[^>]*src="screensaver\.js"[^>]*><\/script>/g, '<script>' + ssSrc + '</script>')
  .replace(/<script[^>]*src="app\.js"[^>]*><\/script>/g, STUB + '<script>' + appSrc + EXPORT + '</script>')
  .replace(/<link[^>]*style\.css[^>]*>/, '<style>' + cssSrc + '</style>');

/* 页面里跑：驱动交互并断言，返回 JSON 结果 */
const DRIVE = `(async function () {
  const out = [];
  const $ = (id) => document.getElementById(id);
  const ok = (name, cond, detail) => out.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const T = window.__dlcTest;

  /* ---- 1) 默认折叠 + 缓存命中（不该为了看详情去联网） ---- */
  const g = { id: 'steam:812140', name: '艾尔登法环', platform: 'steam', appid: '812140' };
  T.state([g], g.id);
  window.__dlcPayload = {
    ok: true, platform: 'steam', supported: true, source: 'steam',
    items: [{ appid: '1', name: 'DLC 甲', installed: true },
            { appid: '2', name: 'DLC 乙', installed: false },
            { appid: '3', name: 'DLC 丙', installed: false }],
    note: '', cached: true, ts: Date.now() - 3600 * 1000
  };
  await T.renderDlc(g);
  ok('DLC 整合成一个按钮：默认折叠，明细不占版面',
    $('dlcBody').hidden === true && $('dlcToggle').getAttribute('aria-expanded') === 'false',
    'hidden=' + $('dlcBody').hidden);
  ok('按钮上直接给出已装统计', $('dlcSummary').textContent === '已装 1/3', $('dlcSummary').textContent);
  ok('明细已渲染 3 行可勾选 DLC', $('dlcList').querySelectorAll('.dlc-item').length === 3,
    $('dlcList').querySelectorAll('.dlc-item').length);
  ok('缓存命中时标注「本地缓存 + x 小时前更新」',
    /本地缓存/.test($('dlcStatus').textContent) && /1 小时前更新/.test($('dlcStatus').textContent),
    $('dlcStatus').textContent);
  ok('已装/未装徽标正确',
    ($('dlcList').querySelector('.dlc-item.installed .dlc-badge') || {}).textContent === '已装'
    && ($('dlcList').querySelector('.dlc-item.missing .dlc-badge') || {}).textContent === '未装');
  ok('getDlc 首次调用不带 force（读缓存，不联网）',
    window.__calls.getDlc.length === 1 && !window.__calls.getDlc[0].opts,
    JSON.stringify(window.__calls.getDlc[0] && window.__calls.getDlc[0].opts));

  /* ---- 2) 点按钮才展开 / 再点收起（并量 display，守住 flex 顶掉 hidden 的坑） ---- */
  $('dlcToggle').click();
  ok('点按钮后明细展开（display 不是 none）',
    $('dlcBody').hidden === false && getComputedStyle($('dlcBody')).display !== 'none',
    getComputedStyle($('dlcBody')).display);
  $('dlcToggle').click();
  ok('再点一次收起（hidden + display:none 真生效）',
    $('dlcBody').hidden === true && getComputedStyle($('dlcBody')).display === 'none',
    getComputedStyle($('dlcBody')).display);

  /* ---- 3) 勾选落盘（手动标记） ---- */
  $('dlcList').querySelector('.dlc-item.missing input').click();
  await wait(60);
  const sm = window.__calls.setDlcManual[window.__calls.setDlcManual.length - 1];
  ok('勾选走 setDlcManual 落盘并即时更新统计',
    !!sm && sm.map['2'] === true && $('dlcSummary').textContent === '已装 2/3',
    JSON.stringify(sm && sm.map) + ' sum=' + $('dlcSummary').textContent);

  /* ---- 4) 手动更新：force 联网重下 + 自动展开 ---- */
  window.__dlcPayload = {
    ok: true, platform: 'steam', supported: true, source: 'steam',
    items: [{ appid: '1', name: 'DLC 甲', installed: true },
            { appid: '2', name: 'DLC 乙', installed: true },
            { appid: '3', name: 'DLC 丙', installed: false },
            { appid: '4', name: 'DLC 丁', installed: false }],
    note: '', cached: false, ts: Date.now()
  };
  $('dlcRefresh').click();
  await wait(80);
  const fr = window.__calls.getDlc[window.__calls.getDlc.length - 1];
  ok('手动更新带 force=true（绕过缓存，联网重下）',
    !!fr && fr.opts && fr.opts.force === true, JSON.stringify(fr && fr.opts));
  ok('更新后自动展开并提示「刚联网更新」、清单变为 4 项',
    $('dlcBody').hidden === false && /刚联网更新/.test($('dlcStatus').textContent)
    && $('dlcList').querySelectorAll('.dlc-item').length === 4,
    $('dlcStatus').textContent);

  /* ---- 5) 非 Steam 平台 + Steam appid：列全部 DLC，主人自己勾「已有」 ---- */
  const g2 = { id: 'ubisoft:42', name: '刺客信条', platform: 'ubisoft', appid: '812140' };
  T.state([g2], g2.id);
  window.__dlcPayload = {
    ok: true, platform: 'ubisoft', supported: true, source: 'steam-appid', appid: '812140',
    items: [{ appid: '9', name: '季票', installed: false }, { appid: '10', name: 'DLC 丁', installed: false }],
    note: '按 Steam appid 812140 列出全部 DLC，请勾选你已拥有的项', cached: true, ts: Date.now()
  };
  await T.renderDlc(g2);
  ok('非 Steam + appid：列出全部 DLC 且徽标为「未有」（默认都没有）',
    $('dlcSummary').textContent === '已有 0/2'
    && ($('dlcList').querySelector('.dlc-badge') || {}).textContent === '未有',
    $('dlcSummary').textContent);
  $('dlcList').querySelector('.dlc-item input').click();
  await wait(60);
  ok('勾选后徽标变「已有」、按钮统计与状态行同步更新（主人自己选已有）',
    ($('dlcList').querySelector('.dlc-badge') || {}).textContent === '已有'
    && $('dlcSummary').textContent === '已有 1/2'
    && /已标记 1 项/.test($('dlcStatus').textContent),
    $('dlcSummary').textContent + ' | ' + $('dlcStatus').textContent);

  /* ---- 6) 在线搜索：用游戏名（URL 编码）打开 h.juij.fun ---- */
  $('dlcSearchBtn').click();
  await wait(50);
  const urls = window.__calls.openExternal;
  const want = 'https://h.juij.fun/search/?keyword=' + encodeURIComponent('刺客信条');
  ok('在线搜索用游戏名（URL 编码）打开 h.juij.fun',
    urls[urls.length - 1] === want, urls[urls.length - 1]);

  return JSON.stringify(out);
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900 });
  let res;
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    res = await win.webContents.executeJavaScript(DRIVE, true);
  } catch (e) {
    process.stdout.write('ERROR: ' + ((e && e.stack) || e) + '\n');
    app.exit(1);
    return;
  }

  const checks = JSON.parse(res);
  let out = 'DLC 区块 UI 回归（真实 Electron 渲染）:\n';
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail++;
    out += '  ' + (c.pass ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '   [' + c.detail + ']' : '') + '\n';
  }

  // 顺带产出「展开 / 折叠」两态截图 → tools/preview/（人工核对用，也是交付给用户看的图）
  try {
    const PREVIEW = path.join(ROOT, 'tools', 'preview');
    fs.mkdirSync(PREVIEW, { recursive: true });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const STAGE = `(function () {
      document.getElementById('detail').hidden = false;
      document.getElementById('detailBg').style.background = 'linear-gradient(135deg,#1b2436 0%,#0b1018 55%,#2a1d33 100%)';
      const t = (id, s) => { const e = document.getElementById(id); if (e) e.textContent = s; };
      t('detailPlatform', 'Ubisoft · 已安装');
      t('detailTitle', '刺客信条：奥德赛（DLC 管理示例）');
      t('detailTags', 'Steam appid 812140 · 按 appid 拉取全部 DLC，勾选自己已拥有的');
      t('detailStats', '本示例为演示图，数据来自回归用例');
      const b = document.querySelector('.detail-body'); if (b) b.scrollTop = b.scrollHeight;
      return true;
    })()`;
    await win.webContents.executeJavaScript(STAGE, true);
    await wait(300);
    // 展开态（当前已是展开：上面 force 更新时自动展开了）
    fs.writeFileSync(path.join(PREVIEW, 'dlc-expanded.png'), (await win.capturePage()).toPNG());
    // 折叠态
    await win.webContents.executeJavaScript("document.getElementById('dlcToggle').click(); true", true);
    await wait(300);
    fs.writeFileSync(path.join(PREVIEW, 'dlc-collapsed.png'), (await win.capturePage()).toPNG());
    out += '\n截图：tools/preview/dlc-expanded.png（展开）· tools/preview/dlc-collapsed.png（折叠）\n';
  } catch (e) {
    out += '\n截图失败（不影响断言）：' + ((e && e.message) || e) + '\n';
  }

  out += '\n' + (checks.length - fail) + ' passed, ' + fail + ' failed\n' + (fail ? 'SOME FAILED\n' : 'ALL PASS\n');
  process.stdout.write(out);
  app.exit(fail ? 1 : 0);
}).catch(e => {
  process.stdout.write('ERROR: ' + ((e && e.stack) || e) + '\n');
  app.exit(1);
});
