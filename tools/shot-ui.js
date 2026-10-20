'use strict';
/**
 * 弹窗分页视觉回归（无需启动应用主体）
 *
 * 把 index.html 里带分页的弹窗（管理 / 设置）单独渲染成 PNG，
 * 每个分页各一张，落到 tools/preview/ 里人工比对：
 *   标题与分页条固定、只有内容区滚动、底部「保存」始终可见。
 *
 * 用法： npm run shot:ui      → 截图落到 tools/preview/
 */
const fs = require('fs');
const path = require('path');

// 需要真的跑在 Electron 主进程里。若用普通 node 启动（或环境里有 ELECTRON_RUN_AS_NODE），
// 自动清掉那个变量并以 Electron 重新拉起自己一次。
if (process.type !== 'browser') {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = require('electron');          // node 环境下返回 electron 可执行文件路径
  const r = require('child_process').spawnSync(exe, [__filename], { stdio: 'inherit', env });
  process.exit(r.status || 0);
}

const { app, BrowserWindow } = require('electron');

// 无 GPU / 远程会话 / 沙箱环境里 Chromium 的 GPU 进程会直接崩（0xC0000005 → "GPU process isn't usable"），
// 截图工具根本不需要 GPU：关掉它并让 GPU 逻辑跑在浏览器进程内，纯软件渲染即可出图。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'preview');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

function block(startMark, endMark) {
  const i = html.indexOf(startMark);
  const j = html.indexOf(endMark, i + 1);
  return html.slice(i, j);
}

/** 生成只含指定弹窗、指定分页高亮的预览页 */
function preview(modalHtml, pane, out) {
  let s = modalHtml;
  if (pane) {
    s = s.replace(/class="tab-btn active"/g, 'class="tab-btn"');
    s = s.replace(new RegExp('class="tab-btn" (data-tab="' + pane + '")'), 'class="tab-btn active" $1');
    s = s.replace(/class="tab-pane active"/g, 'class="tab-pane"');
    s = s.replace(new RegExp('class="tab-pane" (data-pane="' + pane + '")'), 'class="tab-pane active" $1');
  }
  const body = s
    .replace(' hidden data-page-node-id', ' data-page-node-id')
    // Steam 启动项同步行默认 hidden（运行时只有 Steam 平台游戏才显示）：
    // 截图要看它的版式，顺便填一段真实文案，免得截出来是个空行
    .replace('id="steamSyncRow" hidden', 'id="steamSyncRow"')
    .replace('<span class="hint" id="steamArgsHint"></span>',
      '<span class="hint" id="steamArgsHint">Steam 启动项：-custom_script kr_trainer_bridge（与上方一致）</span>');
  fs.writeFileSync(out, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
    + '<link rel="stylesheet" href="../../renderer/style.css"></head><body>'
    + body
    // 分页内容比窗口高时，默认视角只看到顶部（标题/分页条/底部按钮是固定的，不受影响）。
    // 滚到内容底部再拍，新加的字段（如 Steam 启动项同步）才会出现在图里。
    + '<script>addEventListener("load",function(){var b=document.querySelector(".tab-body");'
    + 'if(b)b.scrollTop=b.scrollHeight;});</script>'
    + '</body></html>');
}

/** 取某个弹窗里的全部分页名 */
function panesOf(modalHtml) {
  return [...modalHtml.matchAll(/data-pane="([^"]+)"/g)].map(m => m[1]);
}

const manage = block('<!-- 管理弹窗 -->', '<!-- 设置弹窗 -->');
const settings = block('<!-- 设置弹窗 -->', '<!-- 添加弹窗 -->');
// 添加弹窗：非分页弹窗，整块截一张（手动添加 / 模拟器启动参数就在这）
const add = block('<!-- 添加弹窗 -->', '<!-- 从 SteamGridDB 选背景图弹窗 -->');

// 关掉一个窗口后不能让 Electron 自动退出（否则后续图片加载必然失败）
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cases = [];
  for (const pane of panesOf(manage)) cases.push([manage, pane, `manage-${pane}.png`]);
  for (const pane of panesOf(settings)) cases.push([settings, pane, `settings-${pane}.png`]);
  cases.push([add, null, 'add-modal.png']);   // 添加弹窗没有分页，整块一张

  let n = 0;
  for (const [src, pane, out] of cases) {
    const tmp = path.join(OUT, '_tmp' + (n++) + '.html');
    preview(src, pane, tmp);
    const w = new BrowserWindow({ width: 1000, height: 820, show: false, backgroundColor: '#0b0e14' });
    await w.loadFile(tmp);
    await new Promise(r => setTimeout(r, 400));
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, out), img.toPNG());
    console.log('shot -> tools/preview/' + out);
    w.destroy();
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  console.log(cases.length + ' 张分页截图已生成');
  app.quit();
});
