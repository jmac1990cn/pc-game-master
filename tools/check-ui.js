'use strict';
/**
 * 前端一致性检查（无需启动 Electron）
 *
 *  1. app.js 里 $('xxx') 引用的 id，是否都存在于 index.html
 *  2. 关键新增按钮是否都绑定了事件
 *  3. preload.js 里 invoke 的 IPC 通道，是否都在 main.js 注册
 *
 * 用法： npm run check:ui      有缺失时以非 0 退出
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('renderer/index.html');
const js = read('renderer/app.js');
const main = read('src/main.js');
const preload = read('src/preload.js');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));

const missing = [...jsIds].filter(id => !htmlIds.has(id)).sort();
const unused = [...htmlIds].filter(id => !jsIds.has(id)).sort();

const lines = [];
lines.push('HTML id 数量: ' + htmlIds.size);
lines.push('JS 引用 id 数量: ' + jsIds.size);
lines.push('JS 引用但 HTML 不存在 (必须为空): ' + (missing.length ? missing.join(', ') : '无 ✔'));
lines.push('HTML 有但 JS 未直接引用 (可能用 querySelector，仅供参考): ' + (unused.length ? unused.join(', ') : '无'));

// 关键交互元素必须有事件绑定
const mustBind = ['powerBtn', 'powerMenu', 'powerConfirm', 'cancelShutdownBtn',
  'refreshAudioBtn', 'applyAudioBtn', 'testAudioBtn',
  // 详情页五个操作按钮：手柄/键盘要靠 click() 复用它们的处理逻辑，绑定不能掉
  'detailPlay', 'detailManage', 'detailSave', 'detailFolder', 'detailHide',
  // 详情页游戏攻略三个按钮：打开外部浏览器，绑定不能掉
  'detailGuideText', 'detailGuideVideo', 'detailGuideAI',
  // 详情页 DLC 管理：折叠开关 + 手动更新 + 在线搜索，绑定不能掉
  'dlcToggle', 'dlcSearchBtn', 'dlcRefresh',
  // 管理弹窗 · 一键读取 Steam 启动项
  'pullSteamArgs'];
let bindFail = 0;
lines.push('');
lines.push('关键按钮事件绑定:');
mustBind.forEach(id => {
  const bound = new RegExp(`\\$\\('${id}'\\)\\.addEventListener`).test(js);
  if (!bound) bindFail++;
  lines.push('  ' + (bound ? 'OK  ' : 'MISS') + '  ' + id);
});

// 详情页手柄/键盘焦点：函数 + 两处调用点（手柄分支 / 键盘分支）必须齐全
const css = read('renderer/style.css');
const focusReqs = [
  ['focusDetailAction 定义', /function focusDetailAction\s*\(/],
  ['moveDetailFocus 定义', /function moveDetailFocus\s*\(/],
  ['activateDetailAction 定义', /function activateDetailAction\s*\(/],
  ['clearDetailFocus 定义', /function clearDetailFocus\s*\(/],
  ['详情页手柄方向键移动焦点', /moveDetailFocus\(-1\)[\s\S]{0,80}moveDetailFocus\(1\)/],
  ['详情页手柄 A 触发焦点按钮', /if \(detailOpen\) activateDetailAction\(\)/],
  ['详情页键盘方向键移动焦点', /e\.key === 'ArrowRight'[\s\S]{0,80}moveDetailFocus\(1\)/],
  ['详情页键盘 Enter 触发焦点按钮', /'Enter'\)\s*\{\s*activateDetailAction\(\)/],
  ['.focused 高亮样式', /\.detail-actions button\.focused\s*\{/],
];
let focusFail = 0;
lines.push('');
lines.push('详情页手柄/键盘焦点:');
focusReqs.forEach(([name, re]) => {
  const ok = re.test(name.includes('.focused') ? css : js);
  if (!ok) focusFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// IPC 通道对齐
const mainCh = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
const preCh = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
const badCh = preCh.filter(c => !mainCh.has(c));
lines.push('');
lines.push('main 注册 IPC 通道: ' + mainCh.size + ' 个');
lines.push('preload 调用 IPC 通道: ' + preCh.length + ' 个；main 未注册: ' + (badCh.length ? badCh.join(', ') : '无 ✔'));

// 游戏结束恢复大屏：主进程 restoreAfterGame + preload onToBigScreen + 渲染层 goBigScreen
const srcReqs = [
  ['主进程 restoreAfterGame 定义', main, /function\s+restoreAfterGame\s*\(/],
  ['onEnd 调用 restoreAfterGame', main, /restoreAfterGame\(\);/],
  ['preload 暴露 onToBigScreen', preload, /onToBigScreen:\s*\(cb\)/],
  ['渲染层 goBigScreen 定义', js, /function\s+goBigScreen\s*\(/],
  ['渲染层注册 onToBigScreen', js, /window\.api\.onToBigScreen\(goBigScreen\)/],
  ['游戏结束恢复：网格已保留则不复用重建(避免封面重载)', js, /!grid\.children\.length\)\s*renderGrid\(\)/],
];
let srcFail = 0;
lines.push('');
lines.push('游戏结束恢复大屏:');
srcReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) srcFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// 设置开关读写一致（index.html 有 id；app.js 打开设置时读取、保存时写回）
const cfgIds = ['setTrim', 'setMinimize', 'setRestoreBigScreen', 'setStartPlatform', 'setSwitchAudio', 'setFocusGame', 'setScreensaver'];
const htmlSrc = read('renderer/index.html');
let cfgFail = 0;
lines.push('');
lines.push('设置开关读写一致:');
cfgIds.forEach(id => {
  const inHtml = new RegExp('id="' + id + '"').test(htmlSrc);
  const readBack = new RegExp("\\$\\('" + id + "'\\)\\.checked =").test(js);
  const write = new RegExp("\\$\\('" + id + "'\\)\\.checked,?").test(js);
  const ok = inHtml && readBack && write;
  if (!ok) cfgFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + id +
    (inHtml ? '' : ' [html 无此 id]') + (readBack ? '' : ' [未读取]') + (write ? '' : ' [未保存]'));
});

// 弹窗分页（管理 / 设置）：每个弹窗 ≥3 个分页、tab 与 pane 一一对应，
// 且所有表单字段都必须落在某个 .tab-pane 里（防止选项又堆回同一页）
function cardOf(modalId) {
  const i = html.indexOf('id="' + modalId + '"');
  if (i < 0) return '';
  const j = html.indexOf('<div class="modal"', i + 10);   // 下一个弹窗即边界
  return html.slice(i, j > i ? j : html.length);
}
let tabFail = 0;
lines.push('');
lines.push('弹窗分页（管理 / 设置）:');
[['manageModal', 4], ['settingsModal', 5]].forEach(([id, min]) => {
  const card = cardOf(id);
  const tabs = [...card.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  const panes = [...card.matchAll(/data-pane="([^"]+)"/g)].map(m => m[1]);
  const paired = tabs.length === panes.length && tabs.every(t => panes.includes(t));
  const enough = tabs.length >= min;
  // 第一个 data-pane 之前的片段（标题 + 分页条）里不该再出现表单字段
  const noFieldOutside = !/class="field/.test(card.split(/data-pane="/)[0]);
  const ok = paired && enough && noFieldOutside;
  if (!ok) tabFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + id + ' 分页 [' + tabs.join(' / ') + ']'
    + (paired ? '' : ' [tab 与 pane 不匹配]')
    + (enough ? '' : ' [分页少于 ' + min + ' 个]')
    + (noFieldOutside ? '' : ' [有字段落在分页之外]'));
});

// 桌面模式布局（v1.2.6）：
//  - 网格定高 + 隐式 auto 行，一旦内容超出容器高度，行轨道会被压到「塞进容器」，
//    而卡片仍按 3:4.4 撑高 → 溢出自己的行、与下一行叠在一起（封面堆叠，游戏越多越明显）。
//    修法：显式 grid-auto-rows: min-content，让行高跟随卡片内容。
//  - 顶栏必须单行：窗口变窄时筛选条若折行会把顶栏撑成好几层（默认 1280 宽即 2 行）。
const layoutReqs = [
  ['桌面网格 grid-auto-rows 按内容走（防封面堆叠）', css, /\.desktop-mode\s+\.grid\s*\{[^}]*grid-auto-rows:\s*min-content/],
  ['顶栏单行不换行（防筛选折行撑高）', css, /\.topbar\s*\{[^}]*flex-wrap:\s*nowrap/],
  ['筛选条不换行 + 横向滚动', css, /\.filters\s*\{[^}]*flex-wrap:\s*nowrap[\s\S]{0,120}?overflow-x:\s*auto/],
  ['筛选按钮不被压缩', css, /\.filters\s+button\s*\{[^}]*flex:\s*0\s+0\s+auto/],
  ['搜索框可收缩（不再固定 260px 挤爆顶栏）', css, /\.search-wrap\s*\{[^}]*min-width:\s*120px/],
];
let layoutFail = 0;
lines.push('');
lines.push('桌面模式布局:');
layoutReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) layoutFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// 平台游戏启动链路（Playnite 同款：官方 URI 协议 + 就绪等待；不做早退重试）
const launchReqs = [
  ['launcher 平台客户端集合 PLATFORM_CLIENT_GAMES', read('src/launcher.js'), /PLATFORM_CLIENT_GAMES\s*=/],
  ['launcher 平台游戏优先走官方 URI', read('src/launcher.js'), /PLATFORM_CLIENT_GAMES\.includes\(game\.platform\)/],
  ['scanner Epic 三段式 URI buildEpicUri', read('src/scanner.js'), /function\s+buildEpicUri\s*\(/],
  ['scanner Epic URI 顺序 = 命名空间:Cid:AppName', read('src/scanner.js'), /\[m && m\.CatalogNamespace, m && m\.CatalogItemId, m && m\.AppName\]/],
  ['scanner Epic URI 用 %3A 连接三段', read('src/scanner.js'), /parts\.join\('%3A'\)/],
  ['scanner 战网官方命令 --exec="launch CODE"', read('src/scanner.js'), /function\s+buildBnetLaunchCommand\s*\(/],
  ['scanner 战网启动命令用 buildBnetLaunchCommand', read('src/scanner.js'), /launchCommand: buildBnetLaunchCommand\(code, launcher\)/],
  ['launcher 战网 --exec 识别 quotedCmd', read('src/launcher.js'), /const quotedCmd = /],
  ['launcher 战网 --exec 参数交给 splitQuotedArgs', read('src/launcher.js'), /args: splitQuotedArgs\(quotedCmd\[2\]\)/],
  ['platform 就绪等待可配置 resolveReadyWait', read('src/platform.js'), /function\s+resolveReadyWait\s*\(/],
  ['platform 默认就绪等待 15 秒', read('src/platform.js'), /DEFAULT_READY_WAIT_SEC = 15/],
  ['主进程启动流程调用 launchGame', main, /launcher\.launchGame\(game, overrideArgs\)/],
  // URI 启动：首选 Electron shell.openExternal（不经过 cmd），cmd 兜底时标题必须是字面量 ""
  ['launcher URI 首选 openViaSystemShell', read('src/launcher.js'), /if\s*\(openViaSystemShell\(target\)\)\s*return/],
  ['launcher openViaSystemShell 调 shell.openExternal', read('src/launcher.js'), /shell\.openExternal\(target\)/],
  ['launcher cmd 兜底标题用字面量 "" （防空 cmd 窗口）', read('src/launcher.js'), /args:\s*\['\/d',\s*'\/c',\s*'start',\s*'""',/],
  // 修改器提权（v1.2.4）：清单要求管理员权限的程序直接 spawn 一律 EACCES，
  // 且 spawn 失败的 error 事件没人接就是主进程未捕获异常（红框弹窗 + 崩溃）
  ['launcher 子进程错误兜底 attachGuard', read('src/launcher.js'), /function\s+attachGuard\s*\(/],
  ['launcher spawn 一律经 attachGuard（错误不逃逸）', read('src/launcher.js'), /return attachGuard\(spawn\(target, args, opts\)\)/],
  ['launcher 提权预检 requiresElevation', read('src/launcher.js'), /function\s+requiresElevation\s*\(/],
  ['launcher 提权命令 buildElevatedSpawn（cmd start）', read('src/launcher.js'), /function\s+buildElevatedSpawn\s*\(/],
  ['launcher 启动走 startProcessSafe', read('src/launcher.js'), /startProcessSafe\(choice\.target/],
  ['launcher 修改器启动允许提权', read('src/launcher.js'), /allowElevate:\s*true,\s*\/\/\s*风灵月影/],
  ['主进程启动流程 await launchGame（等真实结果）', main, /await launcher\.launchGame\(game, overrideArgs\)/],
  ['主进程全局未捕获异常兜底', main, /process\.on\('uncaughtException'/],
  // 游戏窗口前台激活（v1.2.5）：游戏启动慢 / 平台客户端先起时，窗口出现后自动抢到前台
  ['winfocus 用 EnumWindows 找窗口 + SetForegroundWindow 激活', read('src/winfocus.js'), /EnumWindows[\s\S]{0,2000}SetForegroundWindow/],
  ['winfocus 激活是阶梯式的（单一手法在本机实测无效）', read('src/winfocus.js'), /BringWindowToTop[\s\S]{0,400}SwitchToThisWindow/],
  ['winfocus 用 -EncodedCommand 传脚本（不落盘、不踩执行策略）', read('src/winfocus.js'), /'-EncodedCommand'/],
  ['winfocus 不以返回值断言成功（按前台进程核对）', read('src/winfocus.js'), /FgPid\(\) == target/],
  ['winfocus 平台客户端游戏等更久', read('src/winfocus.js'), /PLATFORM_WAIT_PLATFORMS = \['steam', 'epic', 'battlenet', 'ubisoft', 'xbox'\]/],
  ['主进程启动成功后调用 focusGameWindow', main, /winfocus\.focusGameWindow\(game\)/],
  ['主进程前台激活受设置开关控制', main, /focusGameOnLaunch !== false/],
];
let launchFail = 0;
lines.push('');
lines.push('平台游戏启动链路:');
launchReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) launchFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// 音频通道联动（v1.2.1）：切到桌面 / 系统改默认都不该把游戏指定的通道带走，
// 只有「游戏确实退出」才还原；还原目标不再是一次性变量。
const audioReqs = [
  ['playtime 进程匹配纯函数 matchRunning', read('src/playtime.js'), /function\s+matchRunning\s*\(/],
  ['playtime 候选进程名递归深度 SCAN_MAX_DEPTH', read('src/playtime.js'), /SCAN_MAX_DEPTH/],
  ['playtime 安装目录核对不再被「见过进程」门控', read('src/playtime.js'), /deep \|\| !nameKnown \|\| !sess\.seen/],
  ['playtime 退出需二次确认 EXIT_CONFIRM_MS', read('src/playtime.js'), /EXIT_CONFIRM_MS/],
  ['playtime 启动宽限期 6 分钟', read('src/playtime.js'), /START_GRACE_MS = 6/],
  ['playtime 无法识别时不做副作用 undetectable', read('src/playtime.js'), /'undetectable'/],
  ['playtime 游戏在跑后切更密轮询加速恢复 POLL_MS_ACTIVE', read('src/playtime.js'), /const nextPoll = sess\.seen \? POLL_MS_ACTIVE : POLL_MS/],
  ['主进程音频会话状态 audioSession', main, /let audioSession = null/],
  ['主进程游戏中音频守护 startAudioGuard', main, /function\s+startAudioGuard\s*\(/],
  ['主进程还原前先停守护', main, /stopAudioGuard\(\);\s*\r?\n\s*if \(!audioSession\)/],
  ['主进程 superseded 不动音频', main, /rec\.reason === 'superseded'/],
  ['主进程未确认启动只还音频不弹窗', main, /never-started/],
  ['主进程退出前还原音频', main, /audioSession\.restoreTo/],
  ['诊断日志 log 模块', read('src/log.js'), /function\s+log\s*\(/],
];
let audioFail = 0;
lines.push('');
lines.push('音频通道联动:');
audioReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) audioFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// appid 补资料链路（v1.2.2）：多候选图源 + 失败可重试 + 只补资料不影响启动
const metaSrc = read('src/metadata.js');
const netSrc = read('src/netfetch.js');
const metaReqs = [
  ['metadata 封面候选 coverCandidates', metaSrc, /function\s+coverCandidates\s*\(/],
  ['metadata 封面竖版优先、横版垫底', metaSrc, /library_600x900_2x\.jpg[\s\S]{0,600}capsule_616x353\.jpg', true/],
  ['metadata 背景候选 library_hero → page_bg_raw', metaSrc, /library_hero\.jpg[\s\S]{0,400}page_bg_raw\.jpg/],
  ['metadata 徽标候选 logo.png（不配 Key 也能拿到）', metaSrc, /logo\.png/],
  ['metadata 资源重抓判定 needsAssetRetry', metaSrc, /function\s+needsAssetRetry\s*\(/],
  ['metadata 双图床 CDN_BASES（cloudflare + akamai）', metaSrc, /CDN_BASES = \[CDN, CDN_AKAMAI\]/],
  ['metadata 连不上有预算、不会一条条等超时', metaSrc, /NET_ERROR_BUDGET/],
  ['metadata 早退前先判断资源是否要重抓', metaSrc, /needsAssetRetry\(existing, \{ cacheImages \}\)/],
  ['主进程后台全量预取本地图（needsLocalImage 选缺图、不再仅 LIMIT 3）', main, /function\s+needsLocalImage\s*\(/],
  ['合并阶段只渲染本地图、绝不把远程 URL 交给 <img>', main, /isLocalPath\(g\.cover\)\s*\?\s*toLocalUrl\(g\.cover\)\s*:\s*null/],
  ['渲染层对未落地的远程图也会再要一次', js, /function\s+needsAssetFetch\s*\(/],
  ['metadata 中文名走美区、国区兜底', metaSrc, /NAME_SOURCES[\s\S]{0,160}cc: 'us'[\s\S]{0,400}NAME_EXTRA/],
  ['netfetch 区分「没连上」与「服务器说没有」', netSrc, /async function downloadDetail\s*\(/],
  ['netfetch 按真实格式修正图片扩展名（防 .jpg 实为 WebP 破图）', netSrc, /function sniffImageExt\s*\(/],
  ['metadata 复用同一次商店请求取官方图片地址', metaSrc, /async function fetchStoreDetails\s*\(/],
  ['metadata 候选链接受商店官方地址（headerImage/storeBackground/screenshot）', metaSrc, /extra\.storeBackground[\s\S]{0,200}extra\.screenshot/],
  ['主进程回传 missing 缺失清单', main, /const missing = \[\];[\s\S]{0,240}missing\.push\('封面'\)/],
  ['渲染层查询并补全强制重抓（否则会命中缓存早退）', js, /queryMetadata\(appid, true\)/],
  ['管理弹窗 appid 说明写明不影响启动方式', html, /不影响启动方式/],
  ['添加弹窗 appid 说明写明不影响启动方式', html, /不影响启动方式[\s\S]{0,400}addAppid/],
];
let metaFail = 0;
lines.push('');
lines.push('appid 补资料链路:');
metaReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) metaFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});
// 反向断言：启动决策模块绝不读 appid、也不拼 steam:// （appid 只影响资料，不影响启动）。
// 注：launcher 注释里 UWP 的 "!<AppId>" 不算，故只查属性访问 .appid 与 rungameid 协议。
const launcherSrc = read('src/launcher.js');
const launcherNoAppid = !/\.appid\b/i.test(launcherSrc) && !/rungameid/i.test(launcherSrc);
if (!launcherNoAppid) metaFail++;
lines.push('  ' + (launcherNoAppid ? 'OK  ' : 'MISS') + '  launcher 启动决策不读 appid / 不拼 steam://');

// 早退重试已整体移除（v1.1.8 改为「宁可多等，一次成功」）
const removedReqs = [
  ['主进程已移除 watchEarlyExit', main, /watchEarlyExit/],
  ['launcher 已移除 shouldAutoRetry', read('src/launcher.js'), /shouldAutoRetry/],
  ['playtime 已移除 isGameRunning', read('src/playtime.js'), /isGameRunning/],
  ['设置已移除 autoRetryOnEarlyExit', read('renderer/app.js'), /autoRetryOnEarlyExit/],
  ['主进程已移除一次性 audioRestoreTo', main, /audioRestoreTo/],
  // 激活帮助进程绝不能用 detached 起（DETACHED_PROCESS → PowerShell 无控制台，90ms 静默退出）
  ['winfocus 不得使用 detached 起帮助进程', read('src/winfocus.js'), /detached:\s*true/],
];
lines.push('');
lines.push('早退重试已移除:');
removedReqs.forEach(([name, src, re]) => {
  const ok = !re.test(src);
  if (!ok) launchFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

process.stdout.write(lines.join('\n') + '\n');

// 屏保（v1.2.7）：空闲轮播已安装游戏背景。关注「元素 / 脚本 / 读写 / 暂停条件」不要丢。
const screenReqs = [
  ['屏保遮罩元素 #screensaver 存在', html, /id="screensaver"/],
  ['屏保脚本 screensaver.js 已引入', html, /<script src="screensaver\.js"><\/script>/],
  ['屏保遮罩默认隐藏、显示用 .show', css, /#screensaver\s*\{[^}]*visibility:\s*hidden/],
  ['屏保显示态 #screensaver.show 可见', css, /#screensaver\.show\s*\{[^}]*visibility:\s*visible/],
  ['屏保两层交叉淡入 .ss-layer.front', css, /\.ss-layer\.front\s*\{\s*opacity:\s*1/],
  ['屏保空闲分钟数输入框 setScreensaverMin 存在', html, /id="setScreensaverMin"/],
  ['设置读取空闲分钟数 .value =', js, /\$\('setScreensaverMin'\)\.value =/],
  ['设置保存空闲分钟数 .value', js, /\$\('setScreensaverMin'\)\.value/],
  ['渲染层初始化屏保 initScreensaver', js, /function\s+initScreensaver\s*\(/],
  ['屏保注入真实游戏列表 getGames', js, /getGames:\s*function\s*\(\)\s*\{\s*return games;/],
  ['屏保暂停条件含游戏运行中', js, /isBlocked:\s*function\s*\(\)\s*\{\s*return gameRunning/],
  ['屏保暂停条件含弹窗打开（isModalOpen 兜底）', read('renderer/screensaver.js'), /return baseBlocked\(\) \|\| isModalOpen\(\)/],
  ['启动游戏时置 gameRunning=true（暂停屏保）', js, /gameRunning = true;/],
  ['屏保模块可被 configure 实时开关', read('renderer/screensaver.js'), /function\s+configure\s*\(patch\)/],
  ['屏保模块 buildList 取 background 优先', read('renderer/screensaver.js'), /g\.background \|\| g\.cover/],
];
let screenFail = 0;
lines.push('');
lines.push('屏保（空闲轮播背景）:');
screenReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) screenFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

process.stdout.write(lines.join('\n') + '\n');

// 游戏攻略（v1.2.8）：详情页内置三个按钮，打开外部浏览器检索攻略
const guideReqs = [
  ['攻略按钮 图文攻略 #detailGuideText', html, /id="detailGuideText"/],
  ['攻略按钮 视频攻略 #detailGuideVideo', html, /id="detailGuideVideo"/],
  ['攻略按钮 豆包答疑 #detailGuideAI', html, /id="detailGuideAI"/],
  ['图文攻略作用域搜索 3DM', js, /site:3dmgame\.com/],
  ['图文攻略作用域搜索 游民星空', js, /site:gamersky\.com/],
  ['图文攻略作用域搜索 游侠网', js, /site:ali213\.net/],
  ['视频攻略走 B 站搜索', js, /search\.bilibili\.com\/all\?keyword=/],
  ['豆包答疑走网页版 doubao.com', js, /https:\/\/www\.doubao\.com\//],
  ['openGameGuide 定义', js, /function\s+openGameGuide\s*\(/],
  ['攻略按钮用 window.api.openExternal 打开浏览器', js, /window\.api\.openExternal\(url\)/],
];
let guideFail = 0;
lines.push('');
lines.push('游戏攻略（打开外部浏览器）:');
guideReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) guideFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// DLC 管理（v1.2.15）：折叠成一个按钮（点开才看明细）+ DLC 资料本地缓存 + 手动更新键 + 在线搜索
const dlc = read('src/dlc.js');
const dlcReqs = [
  ['详情页 DLC 区块 #detailDlc', html, /id="detailDlc"/],
  ['DLC 折叠按钮 #dlcToggle（整合在一个按钮里）', html, /id="dlcToggle"/],
  ['DLC 明细容器 #dlcBody 默认折叠', html, /id="dlcBody"\s+hidden/],
  ['DLC 按钮上的已装统计 #dlcSummary', html, /id="dlcSummary"/],
  ['DLC 列表容器 #dlcList', html, /id="dlcList"/],
  ['DLC 状态位 #dlcStatus', html, /id="dlcStatus"/],
  ['DLC 在线搜索按钮 #dlcSearchBtn', html, /id="dlcSearchBtn"/],
  ['DLC 手动更新按钮 #dlcRefresh', html, /id="dlcRefresh"/],
  ['折叠样式 .detail-dlc-body 显式压制 hidden', css, /\.detail-dlc-body\[hidden\]\s*\{\s*display:\s*none/],
  ['DLC 在线搜索域名 h.juij.fun', js, /h\.juij\.fun\/search\/\?keyword=/],
  ['dlcSearchUrl 用 encodeURIComponent 编码游戏名', js, /function\s+dlcSearchUrl\s*\(/],
  ['renderDlc 定义', js, /function\s+renderDlc\s*\(/],
  ['折叠状态同步 applyDlcOpen', js, /function\s+applyDlcOpen\s*\(/],
  ['openDetail 调用 renderDlc', js, /renderDlc\(g\)/],
  ['↻ 更新走 force 联网重下（绕过缓存）', js, /renderDlc\(g,\s*\{\s*force:\s*true\s*\}\)/],
  ['缓存时间人话化 dlcAgeText', js, /function\s+dlcAgeText\s*\(/],
  ['DLC 勾选经 window.api.setDlcManual 落盘', js, /window\.api\.setDlcManual\(g\.id/],
  ['preload 暴露 getDlc（透传 opts/force）', preload, /getDlc:\s*\(id,\s*opts\)\s*=>\s*ipcRenderer\.invoke\('game:dlc',\s*id,\s*opts\)/],
  ['preload 暴露 setDlcManual', preload, /setDlcManual:\s*\(id, map\)\s*=>\s*ipcRenderer\.invoke\('game:setDlcManual'/],
  ['dlc.js 读 appmanifest 已装 DLC（纯函数）', dlc, /function\s+parseInstalledDlc\s*\(/],
  ['dlc.js 判断 Epic DLC 归属本体', dlc, /function\s+isEpicDlcOf\s*\(/],
  ['dlc.js 合并手动覆盖 mergeManual', dlc, /function\s+mergeManual\s*\(/],
  ['dlc.js 平台分发 getDlc', dlc, /function\s+getDlc\s*\(/],
  ['DLC 资料本地保存 dlc-cache.json', dlc, /dlc-cache\.json/],
  ['dlc.js 读缓存 readDlcCache', dlc, /function\s+readDlcCache\s*\(/],
  ['dlc.js 写缓存 writeDlcCache', dlc, /function\s+writeDlcCache\s*\(/],
  ['dlc.js 清单缓存优先 getDlcCatalog（force 才联网）', dlc, /function\s+getDlcCatalog\s*\(/],
  ['dlc.js 非 Steam 平台按 appid 拉全量 DLC', dlc, /function\s+getAppidDlc\s*\(/],
  ['dlc.js 非 Steam+appid 也进分发器', dlc, /if\s*\(gameAppid\(game\)\)\s*return\s*await\s+getAppidDlc/],
  ['main 注册 game:dlc 且接收 opts(force)', main, /ipcMain\.handle\('game:dlc',\s*async\s*\(e,\s*id,\s*opts\)/],
  ['main 注册 game:setDlcManual', main, /ipcMain\.handle\('game:setDlcManual'/],
  ['main 回传缓存标识 cached/ts', main, /cached:\s*!!raw\.cached/],
  ['store 提供 dlcManual 读写（setGameConfig 合并）', read('src/store.js'), /function\s+setGameConfig\s*\(/],
];
let dlcFail = 0;
lines.push('');
lines.push('DLC 管理（折叠按钮 + 本地缓存 + 手动更新 + 非 Steam appid 清单）:');
dlcReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) dlcFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

process.stdout.write(lines.join('\n') + '\n');

// 首页五席排序（v1.2.11）：①最后游玩 ②③近两周时长Top2 ④⑤总时长Top2，且同一款不重复占位。
// 数据源：Steam localconfig.vdf 的 Playtime2wks（零联网）+ 本地 14 天会话窗口（非 Steam）。
const homeReqs = [
  ['playtime 解析 vdf 的 Playtime2wks（近两周时长）', read('src/playtime.js'), /Playtime2wks/],
  ['playtime 输出 minutes2wks 字段', read('src/playtime.js'), /minutes2wks/],
  ['store 定义 14 天窗口 RECENT_WINDOW_MS', read('src/store.js'), /RECENT_WINDOW_MS/],
  ['store 提供 getRecentMs（近两周本地时长）', read('src/store.js'), /function\s+getRecentMs\s*\(/],
  ['store 导出 getRecentMs', read('src/store.js'), /getRecentMs,/],
  ['store 会话数组按窗口裁剪', read('src/store.js'), /sessions\s*=\s*\(Array\.isArray\(cur\.sessions\)/],
  ['main 计算 playtime2wks（Steam 优先，本地兜底）', main, /platformRecentMinutes\s*=\s*steamPt\s*\?\s*\(steamPt\.minutes2wks/],
  ['main 游戏对象带 playtime2wks', main, /playtime2wks,\s*\/\/ 近两周游玩时长/],
  ['applyHomeOrder 近两周按 playtime2wks 排序', main, /b\.playtime2wks\s*-\s*a\.playtime2wks/],
  ['applyHomeOrder 总时长按 playtimeMinutes 排序', main, /b\.playtimeMinutes\s*-\s*a\.playtimeMinutes/],
  ['applyHomeOrder 近两周候选去重（pickedIds 门控）', main, /!pickedIds\.has\(g\.id\)\s*&&\s*g\.playtime2wks\s*>\s*0/],
  ['applyHomeOrder 总时长候选去重（pickedIds 门控）', main, /!pickedIds\.has\(g\.id\)\s*&&\s*g\.playtimeMinutes\s*>\s*0/],
  ['前端角标「近两周常玩」', js, /近两周常玩/],
  ['前端第 1、2 位角标读 playtime2wks', js, /i\s*<\s*3\s*&&\s*g\.playtime2wks\s*>\s*0/],
  ['前端第 3、4 位角标读 playtimeMinutes', js, /i\s*>=\s*3\s*&&\s*i\s*<\s*5\s*&&\s*g\.playtimeMinutes\s*>\s*0/],
  ['近两周角标样式 .rank.rank-recent', css, /\.rank\.rank-recent\s*\{/],
];
// 反向断言：旧的「1、2 位按总时长标最常玩」实现不许复活
const homeRemoved = [
  ['前端已不再把 1、2 位按总时长标最常玩（旧实现）', js, /i\s*>\s*0\s*&&\s*i\s*<\s*3\s*&&\s*g\.playtimeMinutes\s*>\s*0/],
];
let homeFail = 0;
lines.push('');
lines.push('首页五席排序（最后游玩 / 近两周Top2 / 总时长Top2）:');
homeReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) homeFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});
homeRemoved.forEach(([name, src, re]) => {
  const ok = !re.test(src);
  if (!ok) homeFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// 模拟器游戏（v1.2.12）：手动添加弹窗可填「启动参数」，exe = 模拟器本体，
// 参数原样传给模拟器（等同桌面快捷方式）。例：rpcs3.exe --no-gui "%RPCS3_GAMEID%:BCAS20097"
const emuReqs = [
  ['添加弹窗有启动参数输入框 #addLaunchArgs', html, /id="addLaunchArgs"/],
  ['添加弹窗启动参数输入框在 #addModal 内（#addModal → 输入框 → #addSave）',
    html, /id="addModal"[\s\S]{0,4000}id="addLaunchArgs"[\s\S]{0,6000}id="addSave"/],
  ['添加弹窗启动参数说明点明模拟器用法', html, /可执行文件选模拟器本体/],
  ['添加弹窗启动参数提示含 RPCS3 示例', html, /%RPCS3_GAMEID%/],
  ['添加弹窗参数预设行 #addArgPresets', html, /id="addArgPresets"/],
  ['openAdd 清空添加弹窗启动参数', js, /\$\('addLaunchArgs'\)\.value = ''/],
  ['saveAdd 读取启动参数并写入 rec.launchArgs',
    js, /const launchArgs = \$\('addLaunchArgs'\)\.value\.trim\(\)[\s\S]{0,160}rec\.launchArgs = launchArgs/],
  ['添加弹窗参数预设点击追加', js, /\$\('addArgPresets'\)\.addEventListener\('click'/],
  ['主进程合并 launchArgs 时兼容手动游戏记录', main, /launchArgs: cfg\.launchArgs \|\| g\.launchArgs \|\| steamlaunch\.toLocalArgs\(steamArgs\)/],
  ['game:addManual 默认字段含 launchArgs', main, /launchCommand: null, launchArgs: null, installPath: null/],
  ['chooseLaunch「有 exe」分支把 args 放在顶层（否则被静默丢弃）',
    read('src/launcher.js'), /opts:\s*\{\s*cwd:\s*path\.dirname\(game\.executable\)\s*\},\s*args\s*\}/],
  ['提权启动命令会带上自定义参数', read('src/launcher.js'), /buildElevatedSpawn\(target,\s*cwd,\s*extraArgs\)/],
  ['startProcessSafe 提权时把 args 传下去', read('src/launcher.js'), /spawnElevated\(target,\s*cwd,\s*args\)/],
];
// 反向断言：合并 launchArgs 不许退回「只读 cfg.launchArgs」——那会把手动添加时填的参数吞掉
const emuRemoved = [
  ['buildAll 不再只读 cfg.launchArgs（会吞掉手动填的启动参数）', main, /launchArgs: cfg\.launchArgs \|\| '',/],
  // 反向断言：「有 exe」分支不许把 args 塞进 opts（launchGame 读顶层 choice.args，塞 opts 等于丢参数）
  ['chooseLaunch「有 exe」分支不再把 args 塞进 opts', read('src/launcher.js'), /opts:\s*\{[^}]*\bargs\b/],
];
let emuFail = 0;
lines.push('');
lines.push('模拟器游戏（手动添加启动参数）:');
emuReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) emuFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});
emuRemoved.forEach(([name, src, re]) => {
  const ok = !re.test(src);
  if (!ok) emuFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

// Steam 启动项双向同步（v1.2.13）：管理弹窗的「启动选项」与 Steam 自带的启动项互通。
// 读 = localconfig.vdf 的 apps/<appid>/LaunchOptions；写 = 保存时写回同一文件（先备份）。
const slSrc = read('src/steamlaunch.js');
const steamReqs = [
  ['管理弹窗有 Steam 启动项同步行 #steamSyncRow', html, /id="steamSyncRow"/],
  ['同步行在「启动选项」输入框之后（同在启动分页内）',
    html, /id="launchArgs"[\s\S]{0,1400}id="steamSyncRow"/],
  ['同步行有写入开关 #syncSteam 且默认勾选', html, /id="syncSteam"[^>]*checked/],
  ['同步行有一键读取按钮 #pullSteamArgs', html, /id="pullSteamArgs"/],
  ['同步行有 Steam 侧状态提示 #steamArgsHint', html, /id="steamArgsHint"/],
  ['同步行说明点明「Steam 需重启才能读到新值」', html, /Steam 需重启才能读到新值/],
  ['管理弹窗按平台显隐同步行（仅 Steam 平台游戏）',
    js, /\$\('steamSyncRow'\)\.hidden = !\(g\.platform === 'steam' && g\.appid\)/],
  ['管理弹窗回填 Steam 侧启动项原文',
    js, /currentSteamArgs = \(g\.platform === 'steam' && g\.appid\) \? \(g\.steamLaunchOptions \|\| ''\)/],
  ['渲染层剥离 %command% 占位符（steamArgsToLocal）',
    js, /function steamArgsToLocal[\s\S]{0,240}%command%/],
  ['保存时把 syncSteam 一起提交',
    js, /patch\.syncSteam = !\$\('steamSyncRow'\)\.hidden && \$\('syncSteam'\)\.checked/],
  ['保存后展示 Steam 同步结果', js, /r\.steamSync && r\.steamSync\.message/],
  ['一键读取按钮把 Steam 值填进输入框',
    js, /\$\('pullSteamArgs'\)\.addEventListener\('click'[\s\S]{0,320}steamArgsToLocal\(currentSteamArgs\)/],
  ['主进程读取 Steam 启动项（steamlaunch.readAll）', main, /steamlaunch\.readAll\(\)/],
  ['buildAll 带出 Steam 侧启动项原文（供界面显示/一键读取）', main, /steamLaunchOptions: steamArgs/],
  ['保存时写回 Steam 启动项（steamlaunch.write）', main, /steamSync = steamlaunch\.write\(/],
  ['写回仅限 Steam 平台游戏（非 Steam 平台的 appid 只补资料）',
    main, /game\.platform === 'steam'\)\s*\{[\s\S]{0,200}steamlaunch\.write\(/],
  ['syncSteam 只是界面控制字段、不落进配置文件', main, /delete next\.syncSteam/],
  ['steamlaunch 读写的是 Steam 的 localconfig.vdf', slSrc, /localconfig\.vdf/],
  ['steamlaunch 写入前先备份（.glbak）', slSrc, /copyFileSync\(target\.file, backup\)/],
  ['steamlaunch 写回时经 toSteamValue 处理 %command%', slSrc, /const next = toSteamValue\(cur, val\)/],
  ['steamlaunch appid 块用 \\s* 匹配（appid 与 { 之间是换行，[ \\t]* 会全读不到）',
    slSrc, /"\(\\d\{2,8\}\)"\\s\*\\\{/],
];
// 反向断言：两个真实踩过/易踩的坑不许复活
const steamRemoved = [
  ['buildAll 不直接把 Steam 原文当启动参数（%command% 会被塞给游戏 exe）',
    main, /launchArgs: cfg\.launchArgs \|\| g\.launchArgs \|\| steamArgs,/],
  ['steamlaunch 不用 [ \\t]* 匹配 appid 块（读不到任何启动项）',
    slSrc, /"\(\\d\{2,8\}\)"\[ \\t\]\*\\\{/],
];
let steamFail = 0;
lines.push('');
lines.push('Steam 启动项双向同步:');
steamReqs.forEach(([name, src, re]) => {
  const ok = re.test(src);
  if (!ok) steamFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});
steamRemoved.forEach(([name, src, re]) => {
  const ok = !re.test(src);
  if (!ok) steamFail++;
  lines.push('  ' + (ok ? 'OK  ' : 'MISS') + '  ' + name);
});

process.stdout.write(lines.join('\n') + '\n');

const fail = missing.length > 0 || bindFail > 0 || badCh.length > 0 || focusFail > 0
  || srcFail > 0 || cfgFail > 0 || tabFail > 0 || layoutFail > 0
  || launchFail > 0 || audioFail > 0 || metaFail > 0 || screenFail > 0 || guideFail > 0
  || homeFail > 0 || emuFail > 0 || steamFail > 0 || dlcFail > 0;
process.stdout.write('\n' + (fail ? 'CHECK FAILED' : 'ALL OK') + '\n');
process.exit(fail ? 1 : 0);
