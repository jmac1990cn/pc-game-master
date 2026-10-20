'use strict';

/* ----------------------------- 状态 ----------------------------- */
const PLATFORM_LABEL = { steam: 'Steam', epic: 'Epic', battlenet: '战网', ubisoft: '育碧', xbox: 'Xbox', manual: '手动' };

let games = [];
let filtered = [];
let selectedIndex = -1;
let currentFilter = 'all';
let searchTerm = '';
let currentMode = 'fullscreen';   // 'fullscreen' 大屏模式 / 'desktop' 桌面模式
let detailId = null;              // 当前详情页对应的游戏 id

/* ----------------------------- DOM ----------------------------- */
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const hero = $('hero');
const emptyEl = $('empty');
const actionbar = $('actionbar');

/* ----------------------------- 初始化 ----------------------------- */
async function init() {
  bindEvents();
  initGamepad();
  initTabs();

  // 启动游戏后主进程会要求卸掉图片、恢复时再重建（内存优化）
  window.api.onMemoryTrim(trimRendererMemory);
  window.api.onMemoryRestore(restoreFromTrim);
  // 游戏结束后主进程要求切回大屏模式（窗口从最小化还原 + 网格重建 + 大屏）
  window.api.onToBigScreen(goBigScreen);
  // 页面不可见（最小化/被游戏盖住）时主动 GC：解码位图由浏览器自动裁剪，这里把堆也压下去
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !trimmed) {
      try { if (window.gc) window.gc(); } catch (e) {}
    }
  });
  // 后台把游戏名换成中文后推送，合并刷新并保持当前选中
  window.api.onGamesUpdated(onGamesUpdated);
  // 启动进度推送（等待平台客户端启动时提示用户，避免以为卡死）
  if (window.api.onLaunchStatus) window.api.onLaunchStatus(msg => showStatus(msg));

  try {
    const s = await window.api.getSettings();
    currentMode = s.mode === 'desktop' ? 'desktop' : 'fullscreen';
  } catch (e) {}
  applyMode();
  window.addEventListener('resize', applyTileSize);
  // 屏保：空闲轮播已安装游戏背景（游戏运行中 / 窗口不可见 / 弹窗打开时自动暂停）
  initScreensaver();
  window.addEventListener('focus', function () { gameRunning = false; });
  await refreshList();
}

/* ----------------------------- 屏保（空闲轮播背景） ----------------------------- */
let screensaverEnabled = true;
let screensaverMin = 3;
let gameRunning = false;   // 游戏启动后到用户回到管家窗口期间为 true，期间不弹屏保

function initScreensaver() {
  window.api.getSettings().then(function (st) {
    screensaverEnabled = st.screensaverOnIdle !== false;
    screensaverMin = st.screensaverIdleMin || 3;
    if (window.Screensaver) {
      window.Screensaver.init({
        enabled: screensaverEnabled,
        idleMin: screensaverMin,
        getGames: function () { return games; },
        isBlocked: function () { return gameRunning || document.hidden || !document.hasFocus(); }
      });
    }
  }).catch(function () {});
}

/** 桌面/全屏模式切换：切换 body class + 显式设置窗口全屏状态 */
function applyMode() {
  const desktop = currentMode === 'desktop';
  document.body.classList.toggle('desktop-mode', desktop);
  if (window.api.setFullscreen) window.api.setFullscreen(!desktop);
  const b = $('modeBtn');
  if (b) b.textContent = desktop ? '📺 大屏模式' : '🗔 桌面模式';
  applyTileSize();
}

/* --------- 卡片尺寸自适应：随窗口大小等比缩放 --------- */
function applyTileSize() {
  if (!grid) return;
  const desktop = document.body.classList.contains('desktop-mode');
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap) || (desktop ? 14 : 20);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const W = grid.clientWidth || window.innerWidth;
  const H = grid.clientHeight || window.innerHeight;

  if (desktop) {
    // 桌面模式（网格）：宽 + 高双重约束，窗口越小卡片越小
    const cols = 5;
    const rows = 2;
    const byW = (W - padX - gap * (cols - 1)) / cols;
    const byH = ((H - padY - gap * (rows - 1)) / rows) * (3 / 4.4);
    const w = Math.max(78, Math.min(byW, byH, 260));
    grid.style.setProperty('--tile-w', Math.round(w) + 'px');
    return;
  }

  // 大屏模式（横向卷轴）：卡片高度由条带高度决定，宽度按 3:4.4 海报比例
  const h = Math.max(96, Math.min((H - padY) * 0.82, 430));
  grid.style.setProperty('--tile-h', Math.round(h) + 'px');
  grid.style.setProperty('--tile-w', Math.round((h * 3) / 4.4) + 'px');
}

/** 当前实际列数（供键盘/手柄上下移动使用） */
function gridCols() {
  if (!grid) return 1;
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap) || 18;
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const tileW = parseFloat(cs.getPropertyValue('--tile-w')) || 200;
  return Math.max(1, Math.floor((grid.clientWidth - padX + gap) / (tileW + gap)));
}

async function toggleMode() {
  currentMode = currentMode === 'desktop' ? 'fullscreen' : 'desktop';
  applyMode();
  try { await window.api.setSettings({ mode: currentMode }); } catch (e) {}
  await refreshList();
}

/**
 * 全量重新扫描：只由「⟳ 刷新」按钮触发（用户明确要求重扫）。
 * 会调用主进程 games:scan → 重新枚举所有平台。
 */
async function rescan() {
  showStatus('正在扫描已安装游戏…');
  games = await window.api.scanGames();
  applyFilter();
  let libCount = 0;
  try { const lib = await window.api.getMetadataLibrary(); libCount = lib.count || 0; } catch (e) {}
  showStatus(`共 ${games.length} 款游戏 · 信息库 ${libCount} 条`);
}

/**
 * 轻量刷新（毫秒级）：从主进程拿合并好的列表，不触发平台扫描。
 * 扫描只在应用启动和「⟳ 刷新」时执行；改设置/改配置/隐藏游戏后用这个同步界面。
 */
async function refreshList() {
  games = await window.api.getGames();
  applyFilter();
}

function applyFilter() {
  const term = searchTerm.trim().toLowerCase();
  filtered = games.filter(g => {
    const okPlatform = currentFilter === 'all' || g.platform === currentFilter;
    // 中文名、英文名、appid 任一命中即可（换成中文名后仍能用英文搜到）
    const okTerm = !term
      || g.name.toLowerCase().includes(term)
      || (g.nameEn || '').toLowerCase().includes(term)
      || (g.appid && String(g.appid).includes(term));
    return okPlatform && okTerm;
  });
  if (selectedIndex >= filtered.length) selectedIndex = filtered.length - 1;
  if (selectedIndex < 0 && filtered.length) selectedIndex = 0;
  renderGrid();
}

/* ----------------------------- 渲染 ----------------------------- */
function renderGrid() {
  grid.innerHTML = '';
  emptyEl.hidden = filtered.length > 0;
  filtered.forEach((g, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (i === selectedIndex ? ' selected' : '');
    tile.dataset.index = i;
    tile.tabIndex = 0;

    const rank = homeRankBadge(i);
    const badge = `<span class="badge">${PLATFORM_LABEL[g.platform] || g.platform}</span>`;
    const trainerDot = g.trainer ? `<span class="trainer-dot" title="已绑定修改器"></span>` : '';
    const customDot = g.hasCustomBg ? `<span class="custom-dot" title="已自定义背景"></span>` : '';

    let media;
    if (g.cover) {
      // loading=lazy + decoding=async：只解码可视区附近的封面，大库时省内存也更快
      media = `<img class="cover" src="${g.cover}" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
               <div class="placeholder" style="display:none">${escapeHtml(firstChar(g.name))}</div>`;
    } else {
      media = `<div class="placeholder">${escapeHtml(firstChar(g.name))}</div>`;
    }

    const pt = formatPlaytime(g.playtimeMinutes);
    const ptLine = pt
      ? `<div class="pt">${escapeHtml(pt)}${g.playtimeSource === 'steam' ? ' · Steam 记录' : ''}</div>`
      : '';

    tile.innerHTML = `${rank}${badge}${trainerDot}${customDot}${media}
      <div class="meta"><div class="name">${escapeHtml(g.name)}</div>${ptLine}</div>`;
    tile.addEventListener('click', () => openDetail(g));
    tile.addEventListener('dblclick', () => launchGame(g.id));
    grid.appendChild(tile);
  });
  updateHero();
  updateActionbar();
  renderSidebar();
  applyTileSize();
}

/** 首页排序标记：第 0 位最近游玩，第 1、2 位近两周常玩，第 3、4 位总时长最多 */
function homeRankBadge(i) {
  const g = filtered[i];
  if (!g) return '';
  if (i === 0 && g.lastPlayed > 0) {
    return `<span class="rank rank-top" title="最近游玩的游戏">最近游玩</span>`;
  }
  if (i > 0 && i < 3 && g.playtime2wks > 0) {
    return `<span class="rank rank-recent" title="近两周游玩时长最多的游戏">近两周常玩</span>`;
  }
  if (i >= 3 && i < 5 && g.playtimeMinutes > 0) {
    return `<span class="rank" title="总游玩时长最多的游戏">最常玩</span>`;
  }
  return '';
}

/** 分钟 -> 可读时长（空字符串表示没有数据） */
function formatPlaytime(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (!m) return '';
  if (m < 60) return `已玩 ${m} 分钟`;
  const h = m / 60;
  if (h < 10) return `已玩 ${h.toFixed(1)} 小时`;
  if (h < 1000) return `已玩 ${Math.round(h)} 小时`;
  return `已玩 ${Math.round(h / 100) / 10} 千小时`;
}

/** 最后游玩时间 -> 相对描述 */
function formatLastPlayed(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return '今天玩过';
  if (days === 1) return '昨天玩过';
  if (days < 30) return `${days} 天前玩过`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前玩过`;
  return `最后游玩 ${new Date(ts).toLocaleDateString()}`;
}

/** 桌面模式左侧游戏列表栏（大屏模式下不渲染，避免白白解码上百张封面） */
function renderSidebar() {
  const el = $('sidebar');
  if (!el) return;
  el.innerHTML = '';
  if (!document.body.classList.contains('desktop-mode')) return;
  filtered.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'sb-row' + (i === selectedIndex ? ' active' : '');
    const cover = g.cover || '';
    const pt = formatPlaytime(g.playtimeMinutes);
    const extra = [PLATFORM_LABEL[g.platform] || g.platform, pt].filter(Boolean).join(' · ');
    row.innerHTML =
      `<div class="sb-cover" style="${cover ? `background-image:url('${cover}')` : ''}"></div>` +
      `<div class="sb-meta"><div class="sb-name">${escapeHtml(g.name)}</div>` +
      `<div class="sb-plat">${escapeHtml(extra)}</div></div>`;
    row.addEventListener('click', () => { select(i); openDetail(g); });
    el.appendChild(row);
  });
}

function select(i) {
  selectedIndex = i;
  [...grid.children].forEach((el, idx) => el.classList.toggle('selected', idx === i));
  updateHero();
  updateActionbar();
  const el = grid.children[i];
  if (!el) return;
  if (document.body.classList.contains('desktop-mode')) {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    // 横向卷轴：把选中卡片滚到视口中央，形成「卷轴」跟随感
    const max = Math.max(0, grid.scrollWidth - grid.clientWidth);
    const target = el.offsetLeft - (grid.clientWidth - el.offsetWidth) / 2;
    grid.scrollTo({ left: Math.max(0, Math.min(target, max)), behavior: 'smooth' });
  }
}

/**
 * 这张图要不要再向主进程要一次：
 *   没有 → 要；是 http(s) 远程链接 → 也要（那是"上次没下载成功"的痕迹，
 *   主进程会按多候选图源重抓并落到本地；已落地或确认没有时会秒回缓存，不会重复联网）。
 */
function needsAssetFetch(url) {
  return !url || /^https?:/i.test(String(url));
}

const bgFetching = new Set();   // 已在补全 heroes 大背景的 appid，避免重复请求
function updateHero() {
  const g = filtered[selectedIndex];
  // 没有背景图时用封面图兜底，避免黑底
  const bg = g ? (g.background || g.cover) : null;
  hero.style.backgroundImage = bg ? `url("${bg}")` : 'none';

  // 选中游戏没有大背景（或只有没落到本地的远程链接）且有 appid：异步补全一次。
  // 远程链接也要重试：那正是"上次没下载成功"的痕迹（主进程会按新逻辑重抓并落地）。
  if (g && needsAssetFetch(g.background) && g.appid && !bgFetching.has(g.appid)) {
    bgFetching.add(g.appid);
    window.api.queryMetadata(g.appid).then(r => {
      if (r && r.ok && r.meta && r.meta.background) {
        g.background = r.meta.background;
        if (filtered[selectedIndex] === g) updateHero();
      }
    }).catch(() => {});
  }
}

function updateActionbar() {
  const g = filtered[selectedIndex];
  if (!g) { actionbar.hidden = true; return; }
  actionbar.hidden = false;
  $('abName').textContent = g.name;
  $('abPlatform').textContent = (PLATFORM_LABEL[g.platform] || g.platform) + (g.trainer ? ' · 已绑定修改器' : '');
  $('abHint').textContent = '↑↓←→ / 左摇杆 选择 · Enter/A 打开详情 · X 管理 · Y 设置 · H 隐藏 · LB·RB 换平台 · Menu 刷新 · F10 切模式 · F11 全屏';
  $('removeBtn').hidden = g.platform !== 'manual';   // 手动游戏：彻底移除
  $('hideBtn').hidden = g.platform === 'manual';     // 平台扫描游戏：隐藏
}

/* ----------------------------- 启动 ----------------------------- */
let pendingLaunchId = null;

async function launchGame(id, overrideArgs) {
  const g = games.find(x => x.id === id) || filtered[selectedIndex];
  if (!g) return;

  // 「在开始游戏时询问」：先弹窗让用户确认/临时修改本次启动参数
  if (overrideArgs === undefined && g.launchArgsMode === 'ask') {
    pendingLaunchId = g.id;
    $('launchArgsGame').textContent = g.name;
    $('launchArgsInput').value = g.launchArgs || '';
    showModal('launchArgsModal');
    setTimeout(() => $('launchArgsInput').focus(), 30);
    return;
  }

  showStatus(`正在启动《${g.name}》…`);
  gameRunning = true;   // 屏保暂停，直到用户回到管家窗口（window focus）
  const r = await window.api.launchGame(g.id, overrideArgs);
  showStatus(r.message);
}

/* ----------------------------- 管理弹窗 ----------------------------- */
let manageId = null;
let currentSteamArgs = '';   // 该游戏在 Steam 侧当前的「启动选项」原文（仅 Steam 平台游戏有）

/** Steam 启动项原文 → 管家侧的启动参数（%command% 是 Steam 的命令行占位符，不能当参数传） */
function steamArgsToLocal(s) {
  const str = String(s || '');
  const i = str.indexOf('%command%');
  return (i < 0 ? str : str.slice(i + '%command%'.length)).trim();
}

/** 刷新「Steam 启动项：…」提示行（对齐输入的 `%command%` 前缀后与输入框比对） */
function renderSteamArgsHint() {
  const el = $('steamArgsHint');
  if (!el) return;
  const row = $('steamSyncRow');
  if (!row || row.hidden) { el.textContent = ''; return; }
  if (!currentSteamArgs) { el.textContent = 'Steam 启动项：未设置'; return; }
  const same = $('launchArgs').value.trim() === steamArgsToLocal(currentSteamArgs);
  el.textContent = 'Steam 启动项：' + currentSteamArgs + (same ? '（与上方一致）' : '');
}

function openManage() {
  const g = filtered[selectedIndex];
  if (!g) return;
  fillManage(g);
}

function fillManage(g) {
  manageId = g.id;
  currentTrainerPath = g.trainer || null;
  $('manageTitle').textContent = `管理 · ${g.name}`;
  $('manageAppid').value = g.appid || '';
  $('manageName').value = g.customName || '';
  const preview = $('manageBgPreview');
  preview.style.backgroundImage = g.background ? `url("${g.background}")` : 'none';
  $('bgPath').textContent = g.customBackgroundPath || (g.hasCustomBg ? '已设置' : '未设置');
  // 自定义封面预览（当前生效的封面 = 自定义 || 信息库/游戏自带）
  const coverPrev = $('manageCoverPreview');
  coverPrev.style.backgroundImage = g.cover ? `url("${g.cover}")` : 'none';
  $('coverPath').textContent = g.customCoverPath || (g.hasCustomCover ? '已设置' : '未设置（使用在线/默认封面）');
  $('trainerPath').textContent = g.trainer || '未设置';
  $('trainerDelay').value = g.trainerDelay || 0;
  // 启动选项
  $('launchArgs').value = g.launchArgs || '';
  $('launchArgsMode').value = g.launchArgsMode === 'ask' ? 'ask' : 'normal';
  $('launchArgsHint').textContent = g.launchArgsMode === 'ask' ? '启动时会弹窗确认' : '';
  // Steam 启动项同步（只有 Steam 平台游戏有 Steam 侧的「启动选项」，其它平台整行隐藏）
  currentSteamArgs = (g.platform === 'steam' && g.appid) ? (g.steamLaunchOptions || '') : '';
  $('steamSyncRow').hidden = !(g.platform === 'steam' && g.appid);
  $('syncSteam').checked = true;
  renderSteamArgsHint();
  // 存档目录
  currentSaveDir = g.saveDir || null;
  $('saveDirPath').textContent = g.saveDir ? g.saveDir : '自动探测';
  // 音频输出通道（按游戏指定；留空则跟随设置里的默认通道）
  $('manageAudioDevice').innerHTML = '<option value="">读取中…</option>';
  loadAudioDevices().then(r => {
    fillAudioSelect($('manageAudioDevice'), g.audioDevice || '', '跟随设置里的默认通道');
    $('manageAudioHint').textContent = (r && r.ok)
      ? (g.audioDevice
        ? `启动时切到「${labelOfAudio(g.audioDevice)}」，游戏结束后切回默认通道`
        : '启动该游戏时切到此通道，游戏进程结束后自动切回默认通道。')
      : '读取音频设备失败（该功能仅支持 Windows）';
  });
  document.querySelector('input[name=order][value="' + (g.launchOrder || 'game-first') + '"]').checked = true;
  showModal('manageModal');
}

/* ----------------------------- 游戏详情页 ----------------------------- */
function openDetail(g) {
  if (!g) return;
  detailId = g.id;
  const bg = g.background || g.cover;
  const poster = g.cover || '';
  $('detailBg').style.backgroundImage = bg ? `url("${bg}")` : 'none';
  const posterEl = $('detailPoster');
  posterEl.style.backgroundImage = poster ? `url("${poster}")` : 'none';
  posterEl.textContent = poster ? '' : escapeHtml(firstChar(g.name));
  $('detailPlatform').textContent = PLATFORM_LABEL[g.platform] || g.platform;
  $('detailTitle').textContent = g.name;
  const tags = [];
  if (g.trainer) tags.push('已绑定修改器');
  if (g.hasCustomBg) tags.push('自定义背景');
  if (g.hasCustomCover) tags.push('自定义封面');
  if (g.appid) tags.push('Steam 资料 #' + g.appid);   // 仅表示资料来自 Steam，不代表用 Steam 启动
  $('detailTags').textContent = tags.join('  ·  ');

  // 游玩时长 / 最后游玩 / 指定音频通道
  const stats = [];
  if (g.playtimeMinutes > 0) {
    stats.push(`<b>${escapeHtml(formatPlaytime(g.playtimeMinutes))}</b>` +
      (g.playtimeSource === 'steam' ? '（Steam 记录）' : '（本地统计）'));
  }
  const lp = formatLastPlayed(g.lastPlayed);
  if (lp) stats.push(escapeHtml(lp));
  if (g.audioDevice) stats.push('已指定音频输出通道');
  const statsEl = $('detailStats');
  statsEl.innerHTML = stats.join('  ·  ');
  statsEl.hidden = stats.length === 0;
  $('detailPath').textContent = g.installPath
    ? '安装目录：' + g.installPath
    : (g.executable ? '可执行：' + g.executable : '');
  $('detailRemove').hidden = g.platform !== 'manual';
  renderControllerSupport(g);
  $('detail').hidden = false;
  focusDetailAction(0);   // 手柄/键盘进入详情页时默认停在「启动游戏」

  // 还没有 heroes 大背景（或只有未落地的远程链接）但有 appid：异步补全，打开就有大图背景。
  // 打开详情页 = 用户明确在看这款游戏，顺手把"上次没下载成功"的图补上（主进程侧有缓存判断，不会重复联网）。
  if (needsAssetFetch(g.background) && g.appid) {
    window.api.queryMetadata(g.appid).then(r => {
      if (r && r.ok && r.meta && r.meta.background && detailId === g.id) {
        $('detailBg').style.backgroundImage = `url("${r.meta.background}")`;
        g.background = r.meta.background;
        updateHero();
      }
    }).catch(() => {});
  }

  // DLC 管理：默认折叠成一个按钮（带已装统计），点开才显示明细；数据优先读本地缓存，不联网
  renderDlc(g);
}

/* ----------------------------- DLC 管理（详情页） -----------------------------
 * 折叠式：默认只显示「🧩 DLC 管理 + 已装统计」一个按钮，点开才看明细，详情页不被长列表撑满。
 * 数据：主进程按平台查（Steam 读本地 manifest ∩ 商店；Epic 扫 .item；非 Steam 有 appid 就按 appid 拉商店全量清单）。
 * 缓存：联网结果落 userData/dlc-cache.json，打开详情页只读缓存（零联网），点「↻ 更新」才联网重下。
 * 勾选 = 手动标记（落 cfg.dlcManual），再次打开时合并显示；非 Steam appid 清单的勾选含义是「已有」。
 */
let dlcOpen = false;   // 折叠状态（会话内记住：展开后切换游戏仍保持展开）
let dlcSeq = 0;        // 请求序号：防止切换游戏后，旧请求把结果写进新游戏的面板

function dlcSearchUrl(name) {
  return 'https://h.juij.fun/search/?keyword=' + encodeURIComponent(name || '');
}

/** 缓存时间的人话描述（「刚刚更新」/「3 小时前更新」） */
function dlcAgeText(ts) {
  if (!ts) return '';
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (min < 1) return '刚刚更新';
  if (min < 60) return min + ' 分钟前更新';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前更新';
  return Math.floor(h / 24) + ' 天前更新';
}

/** 把折叠状态同步到界面（按钮 aria + 明细显隐） */
function applyDlcOpen() {
  const body = $('dlcBody');
  const btn = $('dlcToggle');
  if (!body || !btn) return;
  body.hidden = !dlcOpen;
  btn.setAttribute('aria-expanded', dlcOpen ? 'true' : 'false');
}

/**
 * 渲染 DLC 区块。
 * @param {object} g 游戏对象
 * @param {{force?:boolean}} opts force=手动更新（联网重下并覆盖本地缓存，同时自动展开明细）
 */
async function renderDlc(g, opts) {
  const box = $('detailDlc');
  if (!box) return;
  box.hidden = false;
  const force = !!(opts && opts.force);
  if (force) dlcOpen = true;   // 点更新就展开，让用户直接看到结果
  applyDlcOpen();

  const listEl = $('dlcList');
  const statusEl = $('dlcStatus');
  const sumEl = $('dlcSummary');
  listEl.innerHTML = '';
  sumEl.textContent = '';
  if (!g || !g.id) { statusEl.textContent = ''; return; }

  statusEl.textContent = force ? '正在联网更新 DLC 资料…' : '正在读取 DLC 资料…';
  const seq = ++dlcSeq;
  let data;
  try {
    data = await window.api.getDlc(g.id, force ? { force: true } : undefined);
  } catch (e) {
    if (seq === dlcSeq) statusEl.textContent = 'DLC 查询失败：' + ((e && e.message) || e);
    return;
  }
  if (seq !== dlcSeq) return;   // 已经切到别的游戏了，丢弃这次结果

  if (!data || !data.ok) {
    sumEl.textContent = '查询失败';
    statusEl.textContent = (data && data.message) || 'DLC 查询失败';
    return;
  }
  if (!data.supported) {
    sumEl.textContent = '不支持自动检测';
    statusEl.textContent = (data.note || '该平台不支持自动检测') + '。';
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    sumEl.textContent = '暂无数据';
    statusEl.textContent = data.note || '未检测到该游戏的 DLC';
    return;
  }

  const ownLabel = data.source === 'steam-appid';   // 非 Steam 游戏按 appid 拉清单 → 勾选含义是「已有」
  const word = ownLabel ? '已有' : '已装';
  // 缓存命中才需要标「多久前更新」；刚联网更新本身就是最新的，不必再叠一句「刚刚更新」
  const age = data.cached ? dlcAgeText(data.ts) : '';
  const note = data.note ? ' ' + data.note : '';
  // 勾选后统计（按钮 + 状态行）要一起刷新，否则状态行会停在渲染那一刻的数字
  const refreshCount = () => {
    const n = items.filter(x => x.installed).length;
    sumEl.textContent = `${word} ${n}/${items.length}`;
    statusEl.textContent = `共 ${items.length} 项 · 已标记 ${n} 项（` +
      (data.cached ? '本地缓存' : '刚联网更新') + (age ? ' · ' + age : '') + '）' + note;
  };
  refreshCount();

  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'dlc-item' + (it.installed ? ' installed' : ' missing');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!it.installed;
    cb.addEventListener('change', async () => {
      const before = cb.checked;
      try {
        await window.api.setDlcManual(g.id, { [String(it.appid)]: cb.checked });
        row.classList.toggle('installed', cb.checked);
        row.classList.toggle('missing', !cb.checked);
        const badge = row.querySelector('.dlc-badge');
        if (badge) badge.textContent = cb.checked ? word : (ownLabel ? '未有' : '未装');
        it.installed = cb.checked;
        refreshCount();
      } catch (err) {
        showStatus('保存失败：' + ((err && err.message) || err));
        cb.checked = !before; // 回滚
      }
    });
    const name = document.createElement('span');
    name.className = 'dlc-name';
    name.textContent = it.name || ('DLC #' + it.appid);
    const badge = document.createElement('span');
    badge.className = 'dlc-badge';
    badge.textContent = it.installed ? word : (ownLabel ? '未有' : '未装');
    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(badge);
    listEl.appendChild(row);
  }
}

function closeDetail() {
  $('detail').hidden = true;
  clearDetailFocus();
  // 关掉后立刻松开大背景图的引用，避免整张大图常驻内存
  $('detailBg').style.backgroundImage = 'none';
  dlcSeq++;   // 作废在途的 DLC 请求，避免关页后回写
  detailId = null;
}

/* ----------------------------- 游戏攻略（打开外部浏览器） ----------------------------- */
/* 用中文游戏名在外部站点检索攻略：
 *   text ：Bing 作用域搜索，限定 3DM / 游民星空 / 游侠网 三大图文攻略站
 *   video：B 站视频搜索（全流程攻略）
 *   ai   ：网页版豆包对话首页（无可靠预填参数，打开即让用户提问）
 * 三者 URL 均已实测可用（返回对应站点攻略 / 视频 / 对话页）。
 */
function gameGuideUrl(type, name) {
  if (type === 'text') {
    const q = encodeURIComponent(`${name} 攻略 (site:3dmgame.com OR site:gamersky.com OR site:ali213.net)`);
    return `https://www.bing.com/search?q=${q}`;
  }
  if (type === 'video') {
    return `https://search.bilibili.com/all?keyword=${encodeURIComponent(name + ' 全流程攻略')}`;
  }
  if (type === 'ai') {
    return 'https://www.doubao.com/';
  }
  return null;
}

/** 打开对应类型的攻略检索（type: 'text' | 'video' | 'ai'） */
function openGameGuide(type) {
  const g = games.find(x => x.id === detailId);
  if (!g || !g.name) return;
  const url = gameGuideUrl(type, g.name);
  if (url) window.api.openExternal(url);
}

/* ------------------------- 详情页操作按钮焦点（手柄 / 键盘共用） -------------------------
 * 详情页的「启动游戏 / 管理 / 存档 / 目录 / 隐藏」需要能被手柄选中：
 * 方向键或左摇杆左右在按钮间移动，A（或 Enter）触发当前高亮的那一个。
 * 默认停在第一个「启动游戏」，所以「A 直接启动」的老习惯仍然成立。
 */
let detailFocus = 0;

/** 详情页当前可聚焦的操作按钮（排除 hidden 的「移除」等） */
function detailActionEls() {
  return [...document.querySelectorAll('#detail .detail-actions button')].filter(b => !b.hidden);
}

/** 高亮详情页第 i 个操作按钮（环形循环） */
function focusDetailAction(i) {
  const els = detailActionEls();
  if (!els.length) { detailFocus = 0; return; }
  detailFocus = ((i % els.length) + els.length) % els.length;
  els.forEach((b, idx) => b.classList.toggle('focused', idx === detailFocus));
  const cur = els[detailFocus];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 移动详情页焦点：step 为 +1 / -1 */
function moveDetailFocus(step) { focusDetailAction(detailFocus + step); }

/** 触发当前聚焦的详情页按钮（等价于鼠标点击，复用它原有的处理逻辑） */
function activateDetailAction() {
  const els = detailActionEls();
  const cur = els[detailFocus] || els[0];
  if (cur) cur.click();
}

function clearDetailFocus() {
  document.querySelectorAll('#detail .detail-actions button.focused')
    .forEach(b => b.classList.remove('focused'));
  detailFocus = 0;
}

/**
 * 详情页“手柄支持”展示：仅 Steam 游戏有数据源（Steam 商店 controller_support）。
 * 已知档位直接渲染；未知则先显示“检测中”，再异步补全（随信息库缓存，避免重复联网）。
 * 非 Steam 游戏（战网 / Xbox / Epic / 手动）无数据源，直接隐藏该行。
 */
function renderControllerSupport(g) {
  const el = $('detailController');
  if (!el || !g) { if (el) el.hidden = true; return; }
  const isSteam = /^\d+$/.test(String(g.appid || ''));
  if (!isSteam) { el.hidden = true; return; }
  const labelOf = v => v === 'full' ? '完整手柄支持' : v === 'partial' ? '部分手柄支持' : '不支持手柄';
  const cs = g.controllerSupport;
  if (cs === 'full' || cs === 'partial' || cs === 'none') {
    el.hidden = false;
    el.dataset.level = cs;
    el.innerHTML = `<span class="pad-ico">🎮</span><span class="pad-val">${labelOf(cs)}</span>`;
    return;
  }
  // 未知：先显示“检测中”，再异步补（利用 metadata 缓存，已抓过就不重复联网）
  el.hidden = false;
  el.dataset.level = 'loading';
  el.innerHTML = `<span class="pad-ico">🎮</span><span class="pad-val">手柄支持检测中…</span>`;
  if (detailId === g.id) {
    window.api.queryMetadata(g.appid).then(r => {
      if (!(r && r.ok && r.meta) || detailId !== g.id) return;
      const v = r.meta.controllerSupport;
      g.controllerSupport = v;
      if (v === 'full' || v === 'partial' || v === 'none') {
        el.dataset.level = v;
        el.innerHTML = `<span class="pad-ico">🎮</span><span class="pad-val">${labelOf(v)}</span>`;
      } else {
        el.hidden = true;   // 商店无该字段则隐藏，不误导
      }
    }).catch(() => { el.hidden = true; });
  }
}

/* ----------------------------- 内存优化（渲染层） ----------------------------- */

let trimmed = false;   // 已卸掉图片引用，等待窗口恢复后重建

/** 主进程要求释放：卸掉大图引用（解码后的位图是内存占用大头）。
 *  注意：卡片网格(grid)有意保留——封面是小图，对游戏(GB 级)内存影响极小，
 *  但保留它能让游戏结束后主界面卡片立即可见、无需重新从网络/磁盘加载。真正的大块是
 *  hero 全屏背景 + 管理预览 + 侧栏，这些才卸。 */
function trimRendererMemory() {
  trimmed = true;
  closeDetail();
  hero.style.backgroundImage = 'none';
  const mp = $('manageBgPreview');
  if (mp) mp.style.backgroundImage = 'none';
  const cp = $('manageCoverPreview');
  if (cp) cp.style.backgroundImage = 'none';
  const sb = $('sidebar');
  if (sb) sb.innerHTML = '';
  // grid 保留（见上方说明）：游戏结束恢复时卡片封面直接可见，不重载
  try { if (window.gc) window.gc(); } catch (e) {}
}

/** 窗口从最小化恢复：卡片网格本就保留，只需把 hero 全屏背景重建回来；
 *  仅在网格异常为空时才兜底重建（避免正常情况重新从网络拉封面）。 */
function restoreFromTrim() {
  if (!trimmed) return;
  trimmed = false;
  updateHero();
  if (!grid.children.length) renderGrid();
}

/** 游戏结束后主进程通知切回大屏模式：设大屏 + 恢复 hero 背景 + 持久化。
 *  网格若已存在则直接复用（封面立即可见），不重建以免封面重新加载/闪动。 */
async function goBigScreen() {
  if (currentMode !== 'fullscreen') {
    currentMode = 'fullscreen';
    applyMode();
    try { await window.api.setSettings({ mode: 'fullscreen' }); } catch (e) {}
  }
  updateHero();
  if (!grid.children.length) renderGrid();   // 网格在则复用，避免封面重载
}

/** 后台中文化完成：用新列表刷新界面，保持当前选中的游戏不变 */
async function onGamesUpdated() {
  try {
    const list = await window.api.getGames();
    if (!Array.isArray(list) || !list.length) return;
    const selId = filtered[selectedIndex] ? filtered[selectedIndex].id : null;
    games = list;
    applyFilter();
    if (selId) {
      const i = filtered.findIndex(g => g.id === selId);
      if (i >= 0) select(i);
    }
  } catch (e) {}
}

/** 从详情页进入管理（复用已载入的 game 对象，避免依赖选中态） */
function openManageFromDetail() {
  const g = games.find(x => x.id === detailId);
  closeDetail();
  if (g) fillManage(g);
}

/** 隐藏当前选中的游戏（扫描到的游戏用隐藏） */
async function hideCurrent() {
  const g = filtered[selectedIndex];
  if (!g) return;
  await window.api.hideGame(g.id);
  showStatus(`已隐藏《${g.name}》（可在设置里恢复）`);
  await refreshList();
}

/* ----------------------------- 背景图设置 ----------------------------- */

/** 详情页：选择本地图直接设为背景（主进程会复制到 userData 下） */
async function setBgFromLocal(id, localPath) {
  await window.api.setGameConfig(id, { customBackground: localPath });
}

/** 从 SteamGridDB 选背景图（管理弹窗内调用） */
async function openBgPicker() {
  const id = manageId || detailId;
  const g = games.find(x => x.id === id);
  if (!g) { showStatus('请先打开「管理」再选背景'); return; }
  $('bgPickerTitle').textContent = g.name;
  $('bgGrid').innerHTML = '';
  $('bgPickerHint').textContent = '正在向 SteamGridDB 查询…';
  $('bgPickerOpenWeb').dataset.term = g.name;
  showModal('bgPickerModal');

  const r = await window.api.searchBackgrounds(g.name);
  if (!r.ok) {
    if (r.message === 'no-key') {
      $('bgPickerHint').textContent = '未配置 SteamGridDB API Key（设置里可填），点下方按钮直接打开官网搜索。';
    } else {
      $('bgPickerHint').textContent = r.message || '未找到候选背景图。点下方按钮去官网搜索。';
    }
    return;
  }
  $('bgPickerHint').textContent = `共 ${r.list.length} 张候选，点击任意一张即设为《${g.name}》的背景。`;
  r.list.forEach(item => {
    const div = document.createElement('div');
    div.className = 'bg-cell';
    div.innerHTML = `<img src="${item.url}" loading="lazy" alt="" />
      <div class="bg-meta">${item.width}×${item.height}${item.author ? ' · ' + escapeHtml(item.author) : ''}</div>`;
    div.addEventListener('click', async () => {
      await setBgFromUrl(id, item.url);
      hideModal('bgPickerModal');
      await refreshList();
      refreshManagePreview();
      showStatus('背景已更新');
    });
    $('bgGrid').appendChild(div);
  });
}

/** 重新同步管理弹窗的背景预览与路径（选图/清除后调用） */
function refreshManagePreview() {
  const g = games.find(x => x.id === manageId);
  if (!g) return;
  const preview = $('manageBgPreview');
  preview.style.backgroundImage = g.background ? `url("${g.background}")` : 'none';
  $('bgPath').textContent = g.customBackgroundPath || (g.hasCustomBg ? '已设置' : '未设置');
  // 自定义封面预览（当前生效的封面 = 自定义 || 信息库/游戏自带）
  const coverPrev = $('manageCoverPreview');
  coverPrev.style.backgroundImage = g.cover ? `url("${g.cover}")` : 'none';
  $('coverPath').textContent = g.customCoverPath || (g.hasCustomCover ? '已设置' : '未设置（使用在线/默认封面）');
}

/** 从远程 URL 下载并设为背景（主进程负责下载与复制到游戏资源目录） */
async function setBgFromUrl(id, url) {
  await window.api.setGameConfig(id, { customBackgroundUrl: url });
}

/* ----------------------------- 存档目录 ----------------------------- */

let saveTargetId = null;

/** 一键打开存档目录：只探到一个就直接打开，多个则弹列表选择 */
async function openGameSave(id) {
  if (!id) return;
  const r = await window.api.getSaveDirs(id);
  if (!r || !r.ok) { showStatus((r && r.message) || '探测存档目录失败'); return; }
  const list = r.dirs || [];

  if (list.length === 1) {
    const rr = await window.api.openSaveDir(id, list[0].path);
    showStatus(rr.message || '已打开存档目录');
    return;
  }
  if (list.length > 1) { showSavePicker(id, list); return; }

  // 一个都没探测到：提示可手动指定，或到资料站查一下（用英文名）
  const g = games.find(x => x.id === id);
  saveTargetId = id;
  $('saveGameName').textContent = g ? g.name : '';
  $('saveHint').textContent = '没有自动探测到存档目录。可用下方按钮手动指定一次，之后就能一键直达；也可以到资料站查一下这款游戏的存档路径。';
  refreshSaveSearchHint(id);
  $('saveList').innerHTML = '';
  showModal('saveModal');
}

/** 在存档弹窗里提示「在线查询」将使用的检索词（英文名优先，资料站只认英文） */
function refreshSaveSearchHint(id) {
  const g = games.find(x => x.id === id);
  const term = String((g && (g.nameEn || g.name)) || '').trim();
  $('saveSearchHint').textContent = term
    ? `在线查询将以「${term}」检索（存档资料站均为英文站）：PCGamingWiki 收录各游戏存档路径，网页搜索作为兜底。`
    : '该游戏暂无英文名，在线查询可能不准；可先在「管理」里填 Steam appid 抓取英文名。';
}

/** 存档位置在线查询：在默认浏览器里检索（英文名优先） */
async function searchSaveOnline(id, engine) {
  if (!id) { showStatus('请先选择游戏'); return; }
  const r = await window.api.searchSaveOnline(id, engine);
  if (!r || !r.ok) { showStatus((r && r.message) || '查询失败'); return; }
  showStatus(`已在浏览器打开查询：「${r.term}」`);
}

/** 弹出候选存档目录列表 */
function showSavePicker(id, list) {
  const g = games.find(x => x.id === id);
  saveTargetId = id;
  $('saveGameName').textContent = g ? g.name : '';
  $('saveHint').textContent = `探测到 ${list.length} 个可能的存档位置，点任意一个直接打开：`;
  refreshSaveSearchHint(id);
  const el = $('saveList');
  el.innerHTML = '';
  list.forEach(d => {
    const row = document.createElement('div');
    row.className = 'save-row';
    const when = d.lastModified ? new Date(d.lastModified).toLocaleDateString() : '';
    row.innerHTML =
      `<div class="sv-main"><div class="sv-path">${escapeHtml(d.path)}</div>` +
      `<div class="sv-meta">${escapeHtml(d.source)}${d.entries ? ' · ' + d.entries + ' 项' : ''}${when ? ' · 更新于 ' + when : ''}</div></div>` +
      (d.exists ? '<span class="sv-open">打开</span>' : '<span class="sv-badge">不存在</span>');
    row.addEventListener('click', async () => {
      if (!d.exists) { showStatus('该目录不存在'); return; }
      await window.api.openSaveDir(id, d.path);
      hideModal('saveModal');
      showStatus('已打开存档目录');
    });
    el.appendChild(row);
  });
  showModal('saveModal');
}

async function saveManage() {
  const order = document.querySelector('input[name=order]:checked').value;
  const delay = parseInt($('trainerDelay').value, 10) || 0;
  const patch = { launchOrder: order, trainerDelay: delay, customName: $('manageName').value.trim() };
  if (currentTrainerPath) patch.trainer = currentTrainerPath;
  // 启动选项
  patch.launchArgs = $('launchArgs').value.trim();
  patch.launchArgsMode = $('launchArgsMode').value === 'ask' ? 'ask' : 'normal';
  // Steam 启动项：勾选时由主进程写回 Steam 的 localconfig.vdf（仅 Steam 游戏显示该行）
  patch.syncSteam = !$('steamSyncRow').hidden && $('syncSteam').checked;
  // 存档目录（未指定时存空串，走自动探测）
  patch.saveDir = currentSaveDir || '';
  // 音频输出通道（留空 = 跟随设置里的默认通道）
  patch.audioDevice = $('manageAudioDevice').value || '';
  const r = await window.api.setGameConfig(manageId, patch);
  hideModal('manageModal');
  await refreshList();
  showStatus((r && r.steamSync && r.steamSync.message) || '已保存');
}
let currentTrainerPath = null;
let currentSaveDir = null;

/* 管理弹窗：按 appid 补全名称/封面/背景/徽标（只改资料，不影响启动方式） */
async function queryManageMeta() {
  const appid = $('manageAppid').value.trim();
  if (!/^\d+$/.test(appid)) { showStatus('appid 必须是数字'); return; }
  showStatus('正在查询并补全…');
  // force：用户点一次就必须真的重走一遍（否则库里"上次失败"的记录会被直接早退，看着像没反应）
  const r = await window.api.queryMetadata(appid, true);
  if (!r.ok) { showStatus(r.message || '查询失败'); return; }
  await window.api.setGameConfig(manageId, { appid });
  hideModal('manageModal');
  await refreshList();
  const name = (r.meta && r.meta.name) || appid;
  const missing = r.missing || [];
  if (missing.length) {
    showStatus(`已补全《${name}》，但${missing.join('、')}没拿到：Steam 上该游戏没有这张图，可在下方指定本地图片，或配置 SteamGridDB Key`);
  } else {
    showStatus(`已补全《${name}》的名称/封面/背景/徽标`);
  }
}

/* ----------------------------- 文件夹扫描弹窗 ----------------------------- */
let scanResults = [];
function openScan() {
  scanResults = [];
  $('scanFolderPath').textContent = '';
  $('scanList').innerHTML = '';
  $('scanCount').textContent = '';
  showModal('scanModal');
}
async function runScanFolder() {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  $('scanFolderPath').textContent = folder;
  showStatus('正在扫描文件夹…');
  scanResults = await window.api.scanFolder(folder);
  renderScanList();
}
function renderScanList() {
  const el = $('scanList');
  el.innerHTML = '';
  $('scanCount').textContent = `共找到 ${scanResults.length} 个可执行文件`;
  scanResults.forEach((item, i) => {
    const row = document.createElement('label');
    row.className = 'scan-row';
    row.innerHTML = `<input type="checkbox" data-i="${i}" checked />
      <span class="sr-name">${escapeHtml(item.name)}</span>
      <span class="sr-path">${escapeHtml(item.path)}</span>`;
    el.appendChild(row);
  });
}
async function importScan() {
  const checked = [...$('scanList').querySelectorAll('input:checked')].map(cb => scanResults[+cb.dataset.i]);
  if (!checked.length) { showStatus('请先勾选要添加的游戏'); return; }
  const r = await window.api.addGames(checked.map(c => ({ name: c.name, path: c.path })));
  hideModal('scanModal');
  await refreshList();
  showStatus(`已导入 ${r.count} 款游戏`);
}

/* ----------------------------- 设置弹窗 ----------------------------- */
async function openSettings() {
  const s = await window.api.getSettings();
  $('setSteam').checked = !!s.scanSteam;
  $('setEpic').checked = !!s.scanEpic;
  $('setBNet').checked = !!s.scanBattleNet;
  $('setUbi').checked = !!s.scanUbisoft;
  $('setXbox').checked = s.scanXbox !== false;
  $('setXboxApps').checked = s.scanXboxApps !== false;
  $('setLogin').checked = !!s.openAtLogin;
  $('setGridKey').value = s.steamGridDbKey || '';
  $('setCacheImg').checked = s.cacheImages !== false;
  $('setTrim').checked = s.trimMemory !== false;
  $('setMinimize').checked = s.minimizeOnLaunch !== false;
  $('setRestoreBigScreen').checked = s.restoreBigScreenOnExit !== false;
  $('setFocusGame').checked = s.focusGameOnLaunch !== false;
  $('setScreensaver').checked = s.screensaverOnIdle !== false;
  $('setScreensaverMin').value = String(s.screensaverIdleMin || 3);
  $('setStartPlatform').checked = s.startPlatformFirst !== false;
  $('setPlatformWait').value = String(s.platformReadyWaitSec || 15);
  currentBnetPath = s.battleNetLauncher || null;
  $('bnetPath').textContent = s.battleNetLauncher || '自动探测';
  await refreshHiddenList();
  refreshMemoryInfo();
  refreshMetaInfo();
  refreshAudioSettings();
  showModal('settingsModal');
}

/** 显示当前内存占用（主进程 + 渲染 + GPU） */
async function refreshMemoryInfo() {
  const el = $('memInfo');
  if (!el) return;
  try {
    const m = await window.api.getMemoryInfo();
    el.textContent = `当前占用 ${m.totalMB} MB（主 ${m.mainMB} · 界面 ${m.rendererMB} · GPU ${m.gpuMB}）`;
  } catch (e) {
    el.textContent = '内存占用：读取失败';
  }
}

/** 显示信息库统计（帮用户自查：中文名是否抓到了、网络是否通） */
async function refreshMetaInfo() {
  const el = $('metaInfo');
  if (!el) return;
  try {
    const s = await window.api.getMetadataStats();
    const net = s.network === 'chromium' ? '系统代理' : '直连';
    let msg = `信息库 ${s.records} 条 · 已命名 ${s.named}（中文 ${s.zhName} / 未命名 ${s.unnamed}） · 网络走${net}`;
    const last = s.last || {};
    if (last.at) {
      msg += ` · 上次抓取 更新${last.updated}/共${last.total}`;
      if (last.networkOk === false) msg += ' ⚠ 网络失败';
    }
    el.textContent = msg;
  } catch (e) {
    el.textContent = '信息库：读取失败';
  }
}

/** 设置里渲染已隐藏的游戏，支持一键恢复显示 */
async function refreshHiddenList() {
  const list = await window.api.getHiddenGames();
  const el = $('hiddenList');
  el.innerHTML = '';
  if (!list || !list.length) {
    el.innerHTML = '<div class="hint">暂无隐藏的游戏</div>';
    return;
  }
  list.forEach(h => {
    const row = document.createElement('div');
    row.className = 'hidden-row';
    row.innerHTML = `<span class="hr-name">${escapeHtml(h.name)}</span><button class="hr-restore" data-id="${h.id}">恢复显示</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      await window.api.unhideGame(h.id);
      await refreshHiddenList();
      await refreshList();
    });
    el.appendChild(row);
  });
}

async function saveSettings() {
  await window.api.setSettings({
    scanSteam: $('setSteam').checked,
    scanEpic: $('setEpic').checked,
    scanBattleNet: $('setBNet').checked,
    scanUbisoft: $('setUbi').checked,
    scanXbox: $('setXbox').checked,
    scanXboxApps: $('setXboxApps').checked,
    battleNetLauncher: currentBnetPath || '',
    openAtLogin: $('setLogin').checked,
    steamGridDbKey: $('setGridKey').value.trim(),
    cacheImages: $('setCacheImg').checked,
    trimMemory: $('setTrim').checked,
    minimizeOnLaunch: $('setMinimize').checked,
    restoreBigScreenOnExit: $('setRestoreBigScreen').checked,
    focusGameOnLaunch: $('setFocusGame').checked,
    screensaverOnIdle: $('setScreensaver').checked,
    screensaverIdleMin: Math.min(120, Math.max(1, Number($('setScreensaverMin').value) || 3)),
    startPlatformFirst: $('setStartPlatform').checked,
    platformReadyWaitSec: Math.min(120, Math.max(5, Number($('setPlatformWait').value) || 15)),
    defaultAudioDevice: $('setAudioDevice').value || '',
    switchAudioOnLaunch: $('setSwitchAudio').checked
  });
  screensaverEnabled = $('setScreensaver').checked;
  screensaverMin = Math.min(120, Math.max(1, Number($('setScreensaverMin').value) || 3));
  if (window.Screensaver) window.Screensaver.configure({ enabled: screensaverEnabled, idleMin: screensaverMin });
  hideModal('settingsModal');
  await refreshList();
  // 扫描规则：全平台扫描只在启动时执行。改了扫描开关后，重启（或点 ⟳ 刷新）生效
  showStatus('设置已保存 · 扫描项改动重启后生效（或点 ⟳ 刷新）');
}
let currentBnetPath = null;

/* ----------------------------- 添加弹窗 ----------------------------- */
let addExe = null, addCover = null, addAppid = null, addMeta = null;
function openAdd() {
  addExe = null; addCover = null; addAppid = null; addMeta = null;
  $('addName').value = '';
  $('addExePath').textContent = '';
  $('addCoverPath').textContent = '';
  $('addAppid').value = '';
  $('addLaunchArgs').value = '';   // 模拟器/自定义启动参数，每次打开清空
  $('addPreview').hidden = true;
  showModal('addModal');
}

async function queryAddMeta() {
  const appid = $('addAppid').value.trim();
  if (!/^\d+$/.test(appid)) { showStatus('appid 必须是数字'); return; }
  showStatus('正在查询游戏信息…');
  const r = await window.api.queryMetadata(appid, true);
  if (!r.ok) { showStatus(r.message || '查询失败'); return; }
  addMeta = r.meta; addAppid = appid;
  const missTip = (r.missing && r.missing.length) ? `（${r.missing.join('、')}未找到）` : '';
  if (!addExe) showStatus(`已查到《${r.meta.name || appid}》${missTip}`);
  else showStatus(`已查到《${r.meta.name || appid}》${missTip}，可点击添加`);
  // 预览
  $('addName').value = r.meta.name || $('addName').value;
  $('addPreview').hidden = false;
  $('addPreviewCover').src = r.meta.cover || '';
  $('addPreviewName').textContent = r.meta.name || '(无名)';
  $('addPreviewSrc').textContent = '来源：' + (r.meta.source === 'steamgriddb' ? 'SteamGridDB' : 'Steam CDN');
  if (r.meta.logo) {
    $('addPreviewLogoWrap').hidden = false;
    $('addPreviewLogo').src = r.meta.logo;
  } else {
    $('addPreviewLogoWrap').hidden = true;
  }
}

async function saveAdd() {
  const name = $('addName').value.trim();
  if (!name) { showStatus('请填写游戏名称'); return; }
  if (!addExe) { showStatus('请选择可执行文件'); return; }
  const rec = { name, executable: addExe, cover: addCover || null, launchCommand: null };
  // 启动参数（可选）：模拟器游戏填这款游戏的启动参数，启动时原样传给 exe（等同桌面快捷方式）
  const launchArgs = $('addLaunchArgs').value.trim();
  if (launchArgs) rec.launchArgs = launchArgs;
  if (addAppid) rec.appid = addAppid;   // 写入 appid，列表自动从信息库补全封面/背景/徽标
  await window.api.addManualGame(rec);
  hideModal('addModal');
  await refreshList();
  showStatus(`已添加《${name}》`);
}

/* ----------------------------- 文件选择 ----------------------------- */
async function pickImageInto(targetSetter, labelEl) {
  const p = await window.api.selectImage();
  if (p) { targetSetter(p); labelEl.textContent = p; }
}

/* ----------------------------- 音频输出通道 ----------------------------- */

let audioDevices = [];    // [{ id, name }]
let audioDefaultId = '';  // 当前系统默认播放设备

function labelOfAudio(id) {
  const hit = audioDevices.find(d => d.id === id);
  return hit ? hit.name : (id || '未知设备');
}

/** 读取设备列表（结果缓存在内存，force=true 时重新枚举） */
async function loadAudioDevices(force) {
  if (!force && audioDevices.length) return { ok: true, devices: audioDevices, default: audioDefaultId };
  try {
    const r = await window.api.listAudioDevices();
    if (r && r.ok) {
      audioDevices = r.devices || [];
      audioDefaultId = r.default || '';
    }
    return r || { ok: false, devices: [] };
  } catch (e) {
    return { ok: false, devices: [] };
  }
}

/** 填充音频通道下拉框；空值项代表「跟随默认通道」 */
function fillAudioSelect(sel, currentId, followLabel) {
  if (!sel) return;
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = followLabel || '跟随默认通道';
  sel.appendChild(first);
  audioDevices.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name + (d.id === audioDefaultId ? '（当前系统默认）' : '');
    sel.appendChild(o);
  });
  sel.value = (currentId && audioDevices.some(d => d.id === currentId)) ? currentId : '';
}

/** 设置弹窗里的音频区块：刷新设备、回填默认通道 */
async function refreshAudioSettings() {
  const el = $('audioHint');
  el.textContent = '正在读取音频设备…';
  const r = await loadAudioDevices(true);
  if (!r.ok) {
    $('setAudioDevice').innerHTML = '<option value="">读取失败</option>';
    el.textContent = '读取音频设备失败（该功能仅支持 Windows）';
    return;
  }
  const s = await window.api.getSettings();
  fillAudioSelect($('setAudioDevice'), s.defaultAudioDevice || '', '跟随系统（不改动）');
  $('setSwitchAudio').checked = s.switchAudioOnLaunch !== false;
  el.textContent = audioDevices.length
    ? `共 ${audioDevices.length} 个可用输出设备。当前系统默认：${labelOfAudio(audioDefaultId)}`
    : '没有检测到可用的音频输出设备';
}

/* ----------------------------- 电源菜单 ----------------------------- */

let pendingPower = null;
let shutdownTimer = null;

const POWER_TEXT = {
  restart: { title: '重启 PC Game Master', text: '将重新启动 PC Game Master；配置、已绑定设置与游玩记录都会保留。', confirm: '重启' },
  quit: { title: '关闭 PC Game Master', text: '将退出 PC Game Master。正在运行的游戏不会受影响。', confirm: '关闭' },
  shutdown: { title: '关机', text: '系统将在 10 秒后关机。这 10 秒内可以点底部的「取消关机」撤回。', confirm: '关机' }
};

function togglePowerMenu() {
  const menu = $('powerMenu');
  menu.hidden = !menu.hidden;
  $('powerWrap').classList.toggle('open', !menu.hidden);
}

function closePowerMenu() {
  $('powerMenu').hidden = true;
  $('powerWrap').classList.remove('open');
}

function askPower(action) {
  const cfg = POWER_TEXT[action];
  if (!cfg) return;
  pendingPower = action;
  $('powerTitle').textContent = cfg.title;
  $('powerText').textContent = cfg.text;
  $('powerConfirm').textContent = cfg.confirm;
  showModal('powerModal');
}

async function runPowerAction() {
  const action = pendingPower;
  pendingPower = null;
  hideModal('powerModal');
  if (!action) return;

  if (action === 'restart') { await window.api.restartApp(); return; }
  if (action === 'quit') { await window.api.quitApp(); return; }

  const r = await window.api.shutdown(10);
  if (!r || !r.ok) { showStatus((r && r.message) || '关机指令执行失败'); return; }
  startShutdownCountdown(r.seconds || 10);
}

function startShutdownCountdown(seconds) {
  let left = Math.max(0, seconds | 0);
  const bar = $('shutdownBar');
  const paint = () => { $('shutdownText').textContent = `系统将在 ${left} 秒后关机`; };
  bar.hidden = false;
  paint();
  clearInterval(shutdownTimer);
  shutdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(shutdownTimer);
      shutdownTimer = null;
      $('shutdownText').textContent = '正在关机…';
      return;
    }
    paint();
  }, 1000);
}

async function cancelShutdown() {
  clearInterval(shutdownTimer);
  shutdownTimer = null;
  $('shutdownBar').hidden = true;
  const r = await window.api.cancelShutdown();
  showStatus((r && r.message) || '已取消关机');
}

/* ----------------------------- 弹窗分页（Tabs） -----------------------------
   管理 / 设置这类选项很多的弹窗按用途分页，避免所有选项堆在同一个长页里。
   分页只负责显示切换，字段本身与原来完全一致（读写逻辑不受影响）。 */
const tabMemory = new Map();   // modalId → 上次停留的分页名

/** 取当前打开着的分页弹窗卡片（没有则返回 null） */
function activeTabCard() {
  const modal = [...document.querySelectorAll('.modal')]
    .find(m => !m.hidden && m.querySelector('.modal-card.tabbed'));
  return modal ? modal.querySelector('.modal-card.tabbed') : null;
}

/** 切到某个分页；名字不存在时回退到第一页 */
function activateTab(card, name) {
  if (!card) return;
  const panes = [...card.querySelectorAll('.tab-body > .tab-pane')];
  if (!panes.length) return;
  if (!panes.some(p => p.dataset.pane === name)) name = panes[0].dataset.pane;
  card.querySelectorAll('.tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  panes.forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  const modal = card.closest('.modal');
  if (modal) tabMemory.set(modal.id, name);
}

/** 打开弹窗时恢复到上次停留的分页（首次为第一页），并把内容区滚回顶部 */
function resetTabs(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  const card = modal.querySelector('.modal-card.tabbed');
  if (!card) return;
  activateTab(card, tabMemory.get(modalId) || '');
  const body = card.querySelector('.tab-body');
  if (body) body.scrollTop = 0;
}

/** 按方向切换分页（键盘 ←/→、手柄方向键 / LB·RB 共用） */
function switchTab(dir) {
  const card = activeTabCard();
  if (!card) return false;
  const btns = [...card.querySelectorAll('.tabs .tab-btn')];
  if (!btns.length) return false;
  const cur = btns.findIndex(b => b.classList.contains('active'));
  const next = (cur + dir + btns.length) % btns.length;
  activateTab(card, btns[next].dataset.tab);
  return true;
}

function initTabs() {
  document.querySelectorAll('.modal-card.tabbed').forEach(card => {
    card.querySelectorAll('.tabs .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => activateTab(card, btn.dataset.tab));
      // 键盘：分页条上按 ←/→ 也能切换（焦点在输入框/下拉框时交给控件本身）
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const btns = [...card.querySelectorAll('.tabs .tab-btn')];
        const cur = btns.findIndex(b => b === btn);
        const target = btns[(cur + dir + btns.length) % btns.length];
        if (target) { target.focus(); activateTab(card, target.dataset.tab); }
      });
    });
  });
}

/* ----------------------------- 弹窗通用 ----------------------------- */
function showModal(id) { $(id).hidden = false; resetTabs(id); }
function hideModal(id) { $(id).hidden = true; }

/* ----------------------------- 事件绑定 ----------------------------- */
function bindEvents() {
  // 大屏卷轴：滚轮左右滚动，到端点可循环
  grid.addEventListener('wheel', onGridWheel, { passive: false });

  $('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...$('filters').children].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.platform;
    applyFilter();
  });

  $('search').addEventListener('input', (e) => { searchTerm = e.target.value; applyFilter(); });

  $('rescanBtn').addEventListener('click', rescan);
  $('settingsBtn').addEventListener('click', openSettings);
  $('addBtn').addEventListener('click', openAdd);
  $('scanFolderBtn').addEventListener('click', openScan);

  $('playBtn').addEventListener('click', () => launchGame(filtered[selectedIndex]?.id));
  $('manageBtn').addEventListener('click', openManage);
  $('folderBtn').addEventListener('click', () => {
    const g = filtered[selectedIndex];
    if (g && g.installPath) window.api.openFolder(g.installPath);
    else showStatus('该游戏没有记录安装目录');
  });
  $('hideBtn').addEventListener('click', hideCurrent);
  $('removeBtn').addEventListener('click', async () => {
    const g = filtered[selectedIndex];
    if (!g) return;
    if (g.platform === 'manual') { await window.api.removeGame(g.id); }
    else { await window.api.hideGame(g.id); showStatus(`已隐藏《${g.name}》`); }
    await refreshList();
  });

  // 模式切换
  $('modeBtn').addEventListener('click', toggleMode);

  // 详情页按钮
  $('detailClose').addEventListener('click', closeDetail);
  $('detailPlay').addEventListener('click', () => {
    const g = games.find(x => x.id === detailId);
    if (g) launchGame(g.id);
    closeDetail();
  });
  $('detailManage').addEventListener('click', openManageFromDetail);
  $('detailFolder').addEventListener('click', () => {
    const g = games.find(x => x.id === detailId);
    if (g && g.installPath) window.api.openFolder(g.installPath);
    else showStatus('该游戏没有记录安装目录');
  });
  $('detailHide').addEventListener('click', async () => {
    await window.api.hideGame(detailId);
    closeDetail();
    await refreshList();
    showStatus('已隐藏（可在设置里恢复）');
  });
  $('detailRemove').addEventListener('click', async () => {
    await window.api.removeGame(detailId);
    closeDetail();
    await refreshList();
    showStatus('已移除');
  });
  // 详情页：游戏攻略（打开外部浏览器检索）
  $('detailGuideText').addEventListener('click', () => openGameGuide('text'));
  $('detailGuideVideo').addEventListener('click', () => openGameGuide('video'));
  $('detailGuideAI').addEventListener('click', () => openGameGuide('ai'));
  // 详情页：DLC 折叠开关 + 手动更新（↻ 联网重下 DLC 资料并覆盖本地缓存）
  $('dlcToggle').addEventListener('click', () => {
    dlcOpen = !dlcOpen;
    applyDlcOpen();
  });
  $('dlcRefresh').addEventListener('click', () => {
    const g = games.find(x => x.id === detailId);
    if (g) renderDlc(g, { force: true });
  });
  // 详情页：DLC 在线搜索（用游戏名在 h.juij.fun 检索）
  $('dlcSearchBtn').addEventListener('click', () => {
    const g = games.find(x => x.id === detailId);
    if (!g || !g.name) return;
    window.api.openExternal(dlcSearchUrl(g.name));
  });
  // 详情页：存档目录一键直达（背景相关按钮已移入「管理」）
  // 先关详情再弹窗：详情层 z-index(120) 高于弹窗(100)，否则选择存档目录的窗口会被盖住
  $('detailSave').addEventListener('click', () => { const id = detailId; closeDetail(); openGameSave(id); });
  // 鼠标悬停也同步手柄/键盘焦点，两种操作方式看到的是同一个高亮按钮
  ['detailPlay', 'detailManage', 'detailSave', 'detailFolder', 'detailHide', 'detailRemove'].forEach((bid) => {
    const b = $(bid);
    if (b) b.addEventListener('mouseenter', () => {
      const i = detailActionEls().indexOf(b);
      if (i >= 0) focusDetailAction(i);
    });
  });
  // 管理弹窗：从 SteamGridDB 选背景
  $('manageGridBg').addEventListener('click', () => openBgPicker());
  $('bgPickerOpenWeb').addEventListener('click', () => {
    const term = $('bgPickerOpenWeb').dataset.term || '';
    const url = 'https://www.steamgriddb.com/search/grids?term=' + encodeURIComponent(term);
    window.api.openExternal(url);
  });

  // 管理弹窗
  $('manageSave').addEventListener('click', saveManage);
  // 清除手填显示名（回到自动抓取的中文名 / 原名）
  $('manageNameClear').addEventListener('click', () => { $('manageName').value = ''; showStatus('已清除手填名称，保存后生效'); });
  $('pickBgBtn').addEventListener('click', async () => {
    const p = await window.api.selectImage();
    if (!p) return;
    await window.api.setGameConfig(manageId, { customBackground: p });
    await refreshList();                 // 重新扫描以拿到主进程转好的 file:// 预览地址
    refreshManagePreview();
    showStatus('已设置本地背景');
  });
  $('clearBgBtn').addEventListener('click', async () => {
    await window.api.setGameConfig(manageId, { customBackground: '' });
    await refreshList();
    refreshManagePreview();
    showStatus('已清除自定义背景');
  });
  // 自定义封面：本地图片（主进程拷入资源目录，卡片/详情/主页背景随之生效）
  $('pickCoverBtn').addEventListener('click', async () => {
    const p = await window.api.selectImage();
    if (!p) return;
    await window.api.setGameConfig(manageId, { customCover: p });
    await refreshList();
    refreshManagePreview();
    showStatus('已设置自定义封面');
  });
  $('clearCoverBtn').addEventListener('click', async () => {
    await window.api.setGameConfig(manageId, { customCover: '' });
    await refreshList();
    refreshManagePreview();
    showStatus('已清除自定义封面');
  });

  // 管理弹窗 · 存档目录
  $('manageSaveDir').addEventListener('click', () => openGameSave(manageId));
  $('manageSaveSearch').addEventListener('click', () => searchSaveOnline(manageId, 'pcgamingwiki'));
  $('pickSaveDir').addEventListener('click', async () => {
    const p = await window.api.selectFolder();
    if (!p) return;
    currentSaveDir = p;
    $('saveDirPath').textContent = p;
    await window.api.setGameConfig(manageId, { saveDir: p });
    showStatus('已指定存档目录');
  });
  $('clearSaveDir').addEventListener('click', async () => {
    currentSaveDir = null;
    $('saveDirPath').textContent = '自动探测';
    await window.api.setGameConfig(manageId, { saveDir: '' });
    showStatus('已恢复自动探测存档目录');
  });

  // 管理弹窗 · 启动选项
  $('launchArgsMode').addEventListener('change', () => {
    $('launchArgsHint').textContent = $('launchArgsMode').value === 'ask' ? '启动时会弹窗确认' : '';
  });
  $('argPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.arg) return;
    const arg = b.dataset.arg;
    const cur = $('launchArgs').value.trim();
    if (cur.split(/\s+/).includes(arg)) return;
    $('launchArgs').value = (cur ? cur + ' ' : '') + arg;
    renderSteamArgsHint();
  });
  // 启动选项输入时同步刷新「Steam 启动项」对比提示
  $('launchArgs').addEventListener('input', renderSteamArgsHint);
  // 一键读取 Steam 里已设置的启动项（写入输入框，保存时才落回两边）
  $('pullSteamArgs').addEventListener('click', () => {
    if (!currentSteamArgs) { showStatus('Steam 里没有为这款游戏设置启动选项'); return; }
    $('launchArgs').value = steamArgsToLocal(currentSteamArgs);
    renderSteamArgsHint();
    showStatus('已读取 Steam 启动项，点「保存」后生效');
  });

  // 启动选项确认弹窗（「在开始游戏时询问」）
  $('launchArgsGo').addEventListener('click', async () => {
    const id = pendingLaunchId;
    const args = $('launchArgsInput').value.trim();
    hideModal('launchArgsModal');
    pendingLaunchId = null;
    if (id) await launchGame(id, args);
  });

  // 存档弹窗 · 手动指定目录
  $('savePickManual').addEventListener('click', async () => {
    const p = await window.api.selectFolder();
    if (!p) return;
    const id = saveTargetId;
    if (id) await window.api.setGameConfig(id, { saveDir: p });
    const rr = await window.api.openSaveDir(id, p);
    hideModal('saveModal');
    showStatus(rr && rr.ok ? '已指定并打开存档目录' : ((rr && rr.message) || '打开失败'));
    await refreshList();
    if (id && id === manageId) { currentSaveDir = p; $('saveDirPath').textContent = p; }
  });

  // 存档弹窗 · 在线查询（英文名检索）
  $('saveSearchWiki').addEventListener('click', () => searchSaveOnline(saveTargetId, 'pcgamingwiki'));
  $('saveSearchWeb').addEventListener('click', () => searchSaveOnline(saveTargetId, 'search'));
  $('pickTrainerBtn').addEventListener('click', async () => {
    const p = await window.api.selectExe();
    if (p) { currentTrainerPath = p; $('trainerPath').textContent = p; }
  });

  // 设置弹窗
  $('settingsSave').addEventListener('click', saveSettings);
  $('pickBnetBtn').addEventListener('click', async () => {
    const p = await window.api.selectExe();
    if (p) { currentBnetPath = p; $('bnetPath').textContent = p; }
  });
  $('trimMemoryBtn').addEventListener('click', async () => {
    const m = await window.api.trimMemory();
    showStatus(`已释放内存，当前占用 ${m.totalMB} MB`);
    refreshMemoryInfo();
  });
  // 重新抓取中文名：忽略「已确认」缓存与失败缓存，强制全部重来
  $('localizeBtn').addEventListener('click', async () => {
    const el = $('metaInfo');
    el.textContent = '正在重新抓取中文名…';
    const r = await window.api.localizeNames();
    const net = r.network === 'chromium' ? '系统代理' : '直连';
    let msg = `更新 ${r.updated} / ${r.total} 条（${net}）`;
    if (!r.networkOk) msg += ' · ⚠ 网络请求失败，请检查代理/网络后重试';
    else if (r.updated === 0) msg += ' · 这些游戏 Steam 商店没有中文标题（可在游戏管理里手填显示名）';
    el.textContent = '上次结果：' + msg;
    await refreshList();
    refreshMetaInfo();
  });

  // 添加弹窗
  $('addSave').addEventListener('click', saveAdd);
  $('addQueryBtn').addEventListener('click', queryAddMeta);
  // 添加弹窗 · 启动参数预设（模拟器常用参数一键追加，不覆盖已填内容）
  $('addArgPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.arg) return;
    const arg = b.dataset.arg;
    const cur = $('addLaunchArgs').value.trim();
    if (cur.split(/\s+/).includes(arg)) return;
    $('addLaunchArgs').value = (cur ? cur + ' ' : '') + arg;
  });
  $('pickAddExe').addEventListener('click', async () => {
    const p = await window.api.selectExe();
    if (p) { addExe = p; $('addExePath').textContent = p; }
  });
  $('pickAddCover').addEventListener('click', async () => {
    const p = await window.api.selectImage();
    if (p) { addCover = p; $('addCoverPath').textContent = p; }
  });

  // 文件夹扫描弹窗
  $('pickScanFolder').addEventListener('click', runScanFolder);
  $('scanImport').addEventListener('click', importScan);

  // 管理弹窗：appid 补全
  $('manageQueryBtn').addEventListener('click', queryManageMeta);

  // 关闭按钮
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => b.closest('.modal').hidden = true);
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
  });

  // 电源菜单
  $('powerBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePowerMenu(); });
  $('powerMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-power]');
    if (!b) return;
    closePowerMenu();
    askPower(b.dataset.power);
  });
  document.addEventListener('click', (e) => {
    if (!$('powerWrap').contains(e.target)) closePowerMenu();
  });
  $('powerConfirm').addEventListener('click', runPowerAction);
  $('cancelShutdownBtn').addEventListener('click', cancelShutdown);

  // 音频输出通道
  $('refreshAudioBtn').addEventListener('click', async () => {
    $('audioHint').textContent = '正在重新读取音频设备…';
    await refreshAudioSettings();
    showStatus('音频设备已刷新');
  });
  $('applyAudioBtn').addEventListener('click', async () => {
    const id = $('setAudioDevice').value;
    if (!id) { showStatus('请先选择一个音频输出通道'); return; }
    showStatus('正在切换系统默认音频通道…');
    const r = await window.api.applyAudioDevice(id);
    if (!r || !r.ok) { showStatus((r && r.message) || '切换失败'); return; }
    await loadAudioDevices(true);
    $('setAudioDevice').value = id;
    $('audioHint').textContent = `已切换。当前系统默认：${labelOfAudio(audioDefaultId)}。保存设置后该通道会记为「默认通道」。`;
    showStatus(`系统默认音频已切到「${labelOfAudio(audioDefaultId)}」`);
  });
  $('testAudioBtn').addEventListener('click', async () => {
    const id = $('manageAudioDevice').value;
    if (!id) { showStatus('请先选择一个音频通道（选「跟随设置里的默认通道」无需试听）'); return; }
    showStatus('正在切换音频通道…');
    const r = await window.api.applyAudioDevice(id);
    if (!r || !r.ok) { showStatus((r && r.message) || '切换失败'); return; }
    await loadAudioDevices(true);
    $('manageAudioHint').textContent = `已切到「${labelOfAudio(id)}」（保存后，启动该游戏时会自动切换）`;
    showStatus(`已切换到「${labelOfAudio(id)}」`);
  });

  // 键盘导航（大屏模式核心）
  document.addEventListener('keydown', onKey);
}

/** 网格导航：dx/dy 方向（-1/0/1）。键盘与手柄共用 */
function move(dx, dy) {
  if (!filtered.length) return;
  if (dx === 0 && dy === 0) return;
  const n = filtered.length;

  // 大屏模式：单行横向卷轴，左右循环（到末尾回到开头）
  if (!document.body.classList.contains('desktop-mode')) {
    const cur = selectedIndex < 0 ? 0 : selectedIndex;
    if (dx > 0) select((cur + 1) % n);
    else if (dx < 0) select((cur - 1 + n) % n);
    return;
  }

  // 桌面模式：网格，上下按实际列数移动
  const cols = gridCols();
  if (dx > 0) select(Math.min(n - 1, selectedIndex + 1));
  else if (dx < 0) select(Math.max(0, selectedIndex - 1));
  else if (dy > 0) select(Math.min(n - 1, selectedIndex + cols));
  else if (dy < 0) select(Math.max(0, selectedIndex - cols));
}

/* --------- 大屏卷轴：滚轮横向滚动 + 到端点循环 --------- */
let wheelTimer = null;
function onGridWheel(e) {
  if (document.body.classList.contains('desktop-mode')) return;   // 桌面网格用默认纵向滚动
  if (!filtered.length) return;
  const max = grid.scrollWidth - grid.clientWidth;
  if (max <= 0) return;
  e.preventDefault();
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  let next = grid.scrollLeft + delta;

  // 滚到一端后继续滚动：循环到另一端
  if (next >= max) {
    grid.scrollTo({ left: 0, behavior: 'smooth' });
    select(0);
    return;
  }
  if (next <= 0 && delta < 0) {
    grid.scrollTo({ left: max, behavior: 'smooth' });
    select(filtered.length - 1);
    return;
  }

  grid.scrollTo({ left: next, behavior: 'auto' });                // 跟手滚动
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(selectNearestToCenter, 160);            // 停手后吸附最近卡片
}

/** 滚动停下后，把选中项吸附到视口中央最近的卡片 */
function selectNearestToCenter() {
  if (!grid.children.length) return;
  const center = grid.scrollLeft + grid.clientWidth / 2;
  let best = -1, bestDist = Infinity;
  [...grid.children].forEach((el, i) => {
    const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - center);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  if (best >= 0 && best !== selectedIndex) select(best);
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.hidden = true);
  closePowerMenu();
}

/** 按过滤器顺序循环切换平台筛选（dir: -1 上一项 / 1 下一项） */
function cycleFilter(dir) {
  const order = ['all', 'steam', 'epic', 'battlenet', 'ubisoft', 'xbox', 'manual'];
  let i = order.indexOf(currentFilter);
  i = (i + dir + order.length) % order.length;
  currentFilter = order[i];
  [...$('filters').children].forEach(b => b.classList.toggle('active', b.dataset.platform === currentFilter));
  applyFilter();
}

function toggleFullscreen() {
  if (window.api.toggleFullscreen) window.api.toggleFullscreen();
}

function onKey(e) {
  const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
  const detailOpen = !$('detail').hidden;

  // Esc 优先关掉电源菜单
  if (e.key === 'Escape' && !$('powerMenu').hidden) {
    closePowerMenu();
    e.preventDefault();
    return;
  }

  // 详情页内的按键：方向键选中操作按钮、Enter 触发选中项、Esc/B 关闭、M 管理
  if (detailOpen) {
    if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') { closeDetail(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { moveDetailFocus(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { moveDetailFocus(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { activateDetailAction(); e.preventDefault(); }
    else if (e.key === 'm' || e.key === 'M') { openManageFromDetail(); }
    return;
  }

  if (modalOpen) {
    if (e.key === 'Escape') { closeAllModals(); return; }
    // 弹窗内用 ←/→ 切换分页（焦点在输入框/下拉框时交给控件本身处理）
    const tag = e.target && e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (!typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (switchTab(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
    }
    return;
  }
  if (!filtered.length) return;
  switch (e.key) {
    case 'ArrowRight': move(1, 0); e.preventDefault(); break;
    case 'ArrowLeft': move(-1, 0); e.preventDefault(); break;
    case 'ArrowDown': move(0, 1); e.preventDefault(); break;
    case 'ArrowUp': move(0, -1); e.preventDefault(); break;
    case 'Enter': if (filtered[selectedIndex]) openDetail(filtered[selectedIndex]); break;
    case 'F11': toggleFullscreen(); break;
    case 'F10': toggleMode(); break;
    case 'h': case 'H': hideCurrent(); break;
    case 'm': case 'M': openManage(); break;
    case 'Delete': case 'Backspace': {
      const g = filtered[selectedIndex];
      if (g) {
        if (g.platform === 'manual') window.api.removeGame(g.id).then(rescan);
        else hideCurrent();
      }
      break;
    }
  }
}

/** 手柄导航（标准布局，Xbox 风）：A 启动 / B 关闭 / X 管理 / Y 设置 / LB·RB 切筛选 / Dpad·左摇杆 导航 / Menu 刷新 / View 切全屏 */
function initGamepad() {
  if (!('getGamepads' in navigator)) { showStatus('当前环境不支持手柄 API'); return; }
  const prev = {};
  setInterval(() => {
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      const id = pad.index;
      prev[id] = prev[id] || {};
      const isPressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      // 边沿触发：仅按下瞬间触发一次，避免长按连发
      const hit = (i) => { const n = isPressed(i); const o = prev[id]['b' + i]; prev[id]['b' + i] = n; return n && !o; };
      // 详情页：方向键 / 左摇杆 = 在「启动游戏 / 管理 / 存档 / 目录 / 隐藏」之间选择（不操作底层网格）
      const detailOpen = !$('detail').hidden;
      // 弹窗打开时：方向键 / LB·RB / 左摇杆 切换分页，不再操作底层网格
      const modalOpen = !detailOpen
        && [...document.querySelectorAll('.modal')].some(m => !m.hidden);
      if (detailOpen) {
        if (hit(14) || hit(12)) moveDetailFocus(-1);
        if (hit(15) || hit(13)) moveDetailFocus(1);
      } else if (modalOpen) {
        if (hit(14) || hit(12) || hit(4)) switchTab(-1);
        if (hit(15) || hit(13) || hit(5)) switchTab(1);
      } else {
        // 方向键
        if (hit(12)) move(0, -1);
        if (hit(13)) move(0, 1);
        if (hit(14)) move(-1, 0);
        if (hit(15)) move(1, 0);
      }
      // 左摇杆（带死区）：始终维护边沿状态
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0, dz = 0.6;
      const sL = ax < -dz, sR = ax > dz, sU = ay < -dz, sD = ay > dz;
      if (detailOpen) {
        if ((sL || sU) && !prev[id]._sx) moveDetailFocus(-1);
        if ((sR || sD) && !prev[id]._sx) moveDetailFocus(1);
      } else if (modalOpen) {
        if (sL && !prev[id]._sx) switchTab(-1);
        if (sR && !prev[id]._sx) switchTab(1);
      } else {
        if (sL && !prev[id]._sx) move(-1, 0);
        if (sR && !prev[id]._sx) move(1, 0);
        if (sU && !prev[id]._sy) move(0, -1);
        if (sD && !prev[id]._sy) move(0, 1);
      }
      prev[id]._sx = sL || sR; prev[id]._sy = sU || sD;
      // 动作键
      if (hit(0)) { // A
        if (detailOpen) activateDetailAction();   // 触发当前高亮的按钮（默认「启动游戏」）
        else { const g = filtered[selectedIndex]; if (g) openDetail(g); }
      }
      if (hit(1)) { if (detailOpen) closeDetail(); else closeAllModals(); } // B
      if (hit(2)) { if (detailOpen) openManageFromDetail(); else openManage(); } // X 管理（详情内用 detailId，避免打开错误游戏）
      if (hit(3)) { if (detailOpen) { closeDetail(); openSettings(); } else openSettings(); } // Y 设置（先关详情，避免被遮挡）
      if (!detailOpen) {
        if (hit(4)) cycleFilter(-1);   // LB 上一平台
        if (hit(5)) cycleFilter(1);    // RB 下一平台
        if (hit(9)) refreshList();     // Menu/Start 刷新
        if (hit(8)) toggleFullscreen(); // View 切全屏
      }
    }
  }, 60);
}

/* ----------------------------- 工具 ----------------------------- */
let statusTimer = null;
function showStatus(msg) {
  const el = $('status');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstChar(s) { return (s || '?').trim().charAt(0).toUpperCase(); }

async function pathToUrl(p) {
  // 渲染进程无法直接用 file:// 转义，交给 main 已转好的背景即可；这里仅用于即时预览
  return p;
}

init();
