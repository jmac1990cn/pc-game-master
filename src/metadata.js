'use strict';

/**
 * 游戏基本信息库：根据 Steam appid 抓取元数据并缓存到本地。
 *  - 游戏名（中文优先）：Steam 商店 API（store.steampowered.com/api/appdetails，cc=cn&l=schinese）
 *  - 封面 / 背景 / 徽标：SteamGridDB API（需免费 Key）；无 Key 时退化为 Steam CDN 直链
 *  - 图片缓存：开启 cacheImages 时下载到 userData/images/{appid}/，离线可用
 *
 * 该模块运行在主进程（Node 18+，内置 fetch）。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const netfetch = require('./netfetch');

const TIMEOUT_MS = 15000;
const CDN_IMG_TIMEOUT_MS = 15000;   // 单张 CDN 图片的下载超时（多候选逐个试，别让一条卡死整个流程）
const NET_ERROR_BUDGET = 2;         // 同一张图连续"连不上"达到这个次数就不再试了（当作网络不通）
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const CDN_AKAMAI = 'https://cdn.akamai.steamstatic.com/steam/apps';   // 同一批图的镜像域名（国内连通性互补）
const STORE_API = 'https://store.steampowered.com/api/appdetails';
const META_V = 2;   // 信息库记录格式版本（升到 2：区分 SGDB 抓取成功/失败，并保留英文名）
/**
 * 资源抓取逻辑版本。升版会让旧记录重走一遍候选图源。
 *   v3：单一直链 → 多候选（竖版优先 / 双图床）
 *   v4：候选链里加入**商店 API 直给的官方图片地址**（header_image / storepagebackground / 截图）
 * 与 META_V 分开：格式没变、只是抓取策略变好，同样需要重抓一次。
 */
const ASSET_V = 4;

/* ----------------------------- 网络辅助 -----------------------------
 * 统一走 netfetch（Chromium 网络栈），这样才能自动使用系统代理 ——
 * 否则在需要代理访问 Steam 的网络下，主进程请求会全部失败：
 * 表现就是「游戏名一直是英文、图片缓存目录全空」。
 */

function fetchJson(url, headers = {}) {
  return netfetch.getJson(url, { headers, timeout: TIMEOUT_MS, tries: 2 });
}

async function downloadImage(url, destPath, timeoutMs) {
  return netfetch.downloadDetail(url, destPath, { timeout: timeoutMs || 30000 });
}

/* ----------------------------- 图片候选图源 -----------------------------
 * 实机教训：**Steam CDN 的图片路径不是每个 appid 都有**。
 * 育碧版《看门狗》（appid 243470）就没有 library_600x900_2x.jpg，
 * 而代码只试了这一条 → 下载失败 → 记录里只剩一个远程链接，
 * 界面上表现为「输入 appid 后什么都没补上」，再点一次还因为缓存早退。
 *
 * 所以每类图都给一串候选：竖版封面 → 横版兜底，多个 CDN 域名都试一遍；
 * 逐个校验，第一个成功的才用，全失败才认输（并如实告诉用户缺什么）。
 */

/**
 * 图床基址（导出便于单测）。两个域名镜像同一批图：
 * 国内网络对 cloudflare / akamai 的连通性时好时坏，两条腿走路。
 */
const CDN_BASES = [CDN, CDN_AKAMAI];

/** 每个「图名」在多个图床上各生成一条候选，同名的两个域名相邻（一个被墙也不会耗尽预算） */
function buildCandidates(appid, entries) {
  const id = String(appid);
  const out = [];
  for (const [name, fallback] of entries) {
    for (const base of CDN_BASES) out.push({ url: `${base}/${id}/${name}`, fallback: !!fallback });
  }
  return out;
}

/**
 * 竖版封面（卡片用）优先，横版（capsule / header）垫底。
 * 实测：老游戏（如 appid 243470《看门狗》）在各图床上都**没有** library_600x900 系列，
 * 只有 capsule_616x353 / header —— 只试竖版就会"什么都补不上"。
 * @param {Object} [extra] 商店 API 直给的官方地址 { storeBackground, headerImage, screenshot }
 *   实测分辨率（appid 243470）：capsule 616x353 / 商店大图 1438x808 / 头图 460x215。
 *   按"裁成竖版后还剩多少清晰度"排序：capsule → 商店大图 → 官方头图（可能是中文 logo 版）→ 截图。
 */
function coverCandidates(appid, extra = {}) {
  return [].concat(
    buildCandidates(appid, [
      ['library_600x900_2x.jpg', false],
      ['library_600x900.jpg', false],
      ['capsule_616x353.jpg', true],
    ]),
    // 商店 API 直给的官方图：老游戏没有 library_* 资源时，这几条是唯一来源
    extra.storeBackground ? [{ url: extra.storeBackground, fallback: true }] : [],
    extra.headerImage ? [{ url: extra.headerImage, fallback: true }] : [],
    extra.screenshot ? [{ url: extra.screenshot, fallback: true }] : [],
    buildCandidates(appid, [['header.jpg', true]])
  );
}

/**
 * 详情页大背景。
 * @param {Object} [extra] 商店 API 直给的官方地址 { storeBackground, screenshot }
 *   storeBackground = storepagebackground/app/<id>：几乎每个 appid 都有，横版大图；
 *   screenshot      = 1920x1080 截图：连商店大图都没有时的最后手段
 */
function backgroundCandidates(appid, extra = {}) {
  return [].concat(
    buildCandidates(appid, [['library_hero.jpg', false]]),
    extra.storeBackground ? [{ url: extra.storeBackground, fallback: false }] : [],
    extra.screenshot ? [{ url: extra.screenshot, fallback: false }] : [],
    buildCandidates(appid, [
      ['page_bg_raw.jpg', false],
      ['capsule_616x353.jpg', true],
      ['header.jpg', true],
    ])
  );
}

/** 徽标（透明 PNG）：不配 SteamGridDB Key 也能拿到 */
function logoCandidates(appid) {
  return buildCandidates(appid, [
    ['logo.png', false],
    ['logo_2x.png', false],
  ]);
}

/** 某类图的候选列表（导出便于单测：顺序与完整性是这段逻辑的核心） */
function assetCandidates(appid, kind, extra = {}) {
  if (kind === 'cover') return coverCandidates(appid, extra);
  if (kind === 'background') return backgroundCandidates(appid, extra);
  if (kind === 'logo') return logoCandidates(appid, extra);
  return [];
}

/** 本地缓存文件名（同一 appid 只留一份，重抓即覆盖） */
function assetFileName(kind, url) {
  if (kind === 'logo') return /\.png(\?|$)/i.test(url) ? 'logo.png' : 'logo.jpg';
  return kind + '.jpg';
}

/** 是否本地路径（本地缓存 vs 远程链接） */
function isLocalFile(p) {
  return typeof p === 'string' && (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/'));
}

/** 是否远程链接 */
function isRemoteUrl(p) {
  return typeof p === 'string' && /^https?:/i.test(p);
}

/**
 * 记录是否需要重抓资源（导出便于单测）。
 * 触发条件（任一）：
 *   - 资源抓取策略升版（ASSET_V 变化）→ 一次性重抓全部旧记录
 *   - 开了图片本地缓存，但库里存的是远程链接且还没试过新逻辑 → 再试一次
 *   - 背景既没有、也没试过 → 老逻辑的兜底条件
 * @param {Object} md 信息库记录
 * @param {{cacheImages:boolean}} opts
 */
function needsAssetRetry(md, opts = {}) {
  if (!md) return true;
  if (md.assetV !== ASSET_V) return true;
  // 还没拿过商店官方图片地址，且正好缺图 → 再试一次（拿到 detailV 后自然不再重试，不会死循环）
  if (md.detailV !== DETAIL_V && (!md.cover || !md.background)) return true;
  if (opts.cacheImages) {
    if (isRemoteUrl(md.cover) && !md.coverTried) return true;
    if (isRemoteUrl(md.background) && !md.bgTried) return true;
    if (isRemoteUrl(md.logo) && !md.logoTried) return true;
  }
  if (!md.background && !md.bgTried) return true;
  return false;
}

/**
 * 取一张图：本地缓存 → SteamGridDB 原图 → Steam CDN 多候选。
 *
 * 「试过」的判定很关键：服务器明确回 404 才算试过（可以记下来，别每次启动都重来）；
 * 连不上属于暂态，不记，下次照样重试。
 *
 * @returns {Promise<{url:(string|null), local:(string|null), fallback:boolean, tried:boolean}>}
 */
async function resolveAsset(appid, kind, opts = {}) {
  const { dir = null, remote = null, existing = null, force = false, extra = {} } = opts;
  const cap = (url, local, fallback, tried) => ({ url, local: local || null, fallback: !!fallback, tried: tried !== false });

  // 1) 已有本地缓存 → 直接用（force + 上次是横版兜底封面时，允许升级成竖版）
  const cached = isLocalFile(existing) && fs.existsSync(existing) ? existing : null;
  const wantUpgrade = !!force && !!opts.existingFallback;
  if (cached && !wantUpgrade) return cap(cached, cached, opts.existingFallback, true);

  // 2) SteamGridDB 原图（配了 Key 才有）：尽量落地，落不了就退回远程链接
  if (remote) {
    if (dir) {
      const p = path.join(dir, assetFileName(kind, remote));
      const r = await downloadImage(remote, p);
      if (r.ok) return cap(r.path || p, r.path || p, false, true);
      if (r.network && !cached) return cap(remote, null, false, false);
    }
    return cap(remote, null, false, true);
  }

  // 3) Steam CDN 兜底：多候选逐个试
  //    404 很便宜（百毫秒），连不上很贵（要等超时）——所以给「连不上」设预算，超了就收手
  let netErrors = 0;
  let sawResponse = false;
  for (const cand of assetCandidates(appid, kind, extra)) {
    if (dir) {
      const dest = path.join(dir, assetFileName(kind, cand.url));
      const r = await downloadImage(cand.url, dest, CDN_IMG_TIMEOUT_MS);
      // 用 r.path：下载器会按真实图片格式修正扩展名（.jpg 后缀返回 WebP 的情况）
      if (r.ok) return cap(r.path || dest, r.path || dest, cand.fallback, true);
      if (r.network) {
        netErrors++;
        if (netErrors >= NET_ERROR_BUDGET) break;
      } else { sawResponse = true; }
    } else {
      const r = await netfetch.probeDetail(cand.url);
      if (r.ok) return cap(cand.url, null, cand.fallback, true);
      if (r.network) {
        netErrors++;
        if (netErrors >= NET_ERROR_BUDGET) break;
      } else { sawResponse = true; }
    }
  }

  // 只要有一台主机明确答复过（404），就说明"Steam 上确实没这张图"→ 认输并记住，别每次启动都重来。
  // 一次答复都没有（全连不上）属于暂态：保留原值、不记"试过"，下次自动重试。
  if (sawResponse) return cap(null, null, false, true);
  return cap(isRemoteUrl(existing) ? existing : null, null, false, false);
}

/* ----------------------------- Steam 商店（中文名） ----------------------------- */

/** 名字里是否含中日文字符（用于判断商店是否真的给了本地化标题） */
function hasCJK(s) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(s || ''));
}

/**
 * 按指定语言批量取商店标题。
 * 必须区分两件事：
 *   - 请求成功但商店没有该语言标题（返回英文名）→ 属于"已确认"，标记 nameTried 不再重试；
 *   - 请求失败（网络/HTTP 错误）→ 绝不能标记，否则网络恢复后也永远补不上中文名。
 *
 * @returns {Promise<{names: Map<string,string>, ok: boolean}>} ok=false 表示整批请求失败
 */
async function fetchNames(appids, lang, cc) {
  const names = new Map();
  try {
    const url = `${STORE_API}?appids=${appids.join(',')}&cc=${cc}&l=${lang}&filters=basic`;
    const data = await fetchJson(url);
    if (!data) return { names, ok: false };
    for (const id of appids) {
      const entry = data[id] || data[String(id)];
      if (entry && entry.success && entry.data && entry.data.name) {
        names.set(String(id), entry.data.name);
      }
    }
    return { names, ok: true };
  } catch (e) {
    return { names, ok: false };   // 网络失败：不标记 nameTried，下次扫描继续重试
  }
}

/**
 * 名称查询用的 (语言, 地区) 组合（导出便于单测）。
 *
 * 为什么中文请求用 `cc=us` 而不是 `cc=cn`：
 *   国区（cc=cn）对**未发行/已下架**的条目会直接返回 success:false，
 *   拿不到标题（实机例子：育碧版《看门狗》appid 243470，cc=cn 无结果、英文名却有）。
 *   美区 + 中文语言（cc=us&l=schinese）能稳定拿到该 app 的中文标题。
 *   国区仍作为兜底再问一次——个别条目只在国区有中文标题。
 */
const NAME_SOURCES = [
  { lang: 'schinese', cc: 'us' },
  { lang: 'english', cc: 'us' }
];
const NAME_EXTRA = { lang: 'schinese', cc: 'cn' };

/** 取单个 appid 的名字（中文优先，同时保留英文名） */
async function fetchSteamName(appid) {
  const id = String(appid);
  const ids = [id];
  const [zh, en] = await Promise.all([
    fetchNames(ids, NAME_SOURCES[0].lang, NAME_SOURCES[0].cc),
    fetchNames(ids, NAME_SOURCES[1].lang, NAME_SOURCES[1].cc)
  ]);
  let zhName = zh.names.get(id) || '';
  let storeOk = zh.ok || en.ok;

  // 主请求没拿到中日文标题 → 再补一次国区（部分老游戏/国区专属条目只在国区有中文标题）
  if (!hasCJK(zhName)) {
    const cn = await fetchNames(ids, NAME_EXTRA.lang, NAME_EXTRA.cc);
    const cnName = cn.names.get(id) || '';
    if (hasCJK(cnName)) zhName = cnName;
    storeOk = storeOk || cn.ok;
  }

  const enName = en.names.get(id) || '';
  const name = zhName || enName;
  if (!name) return null;
  return {
    name,
    nameEn: enName || (hasCJK(zhName) ? '' : zhName),
    headerImage: null,
    // 商店给了明确答复才算确认；纯网络失败要留待下次重试
    storeOk
  };
}

/** 手柄支持抓取逻辑版本：升版会强制重抓旧缓存（旧版用了 filters=basic，值恒为空） */
const CTRL_V = 2;
/**
 * 商店详情抓取版本。v2 起：同一次请求顺带取回**官方图片地址**
 * （header_image / background_raw / screenshots），不再额外联网。
 */
const DETAIL_V = 2;

/**
 * 抓取单个 Steam appid 的商店详情：手柄支持档位 + 官方图片地址。
 *
 * 注意：这里【不能】带 `filters=basic` —— 商店 API 的 basic 过滤会把
 * `controller_support`、`header_image`、`background_raw`、`screenshots` 等字段裁掉。
 * 走完整 appdetails 响应，一次请求把下面这些东西全拿到手（不额外联网）：
 *   - 手柄支持档位：controller_support，缺失时用 categories 兜底（28=完全，18=部分）
 *   - header_image  ：官方头图，可能是 header_schinese.jpg（带中文 logo）
 *   - background_raw：商店页大图（storepagebackground/app/<id>），几乎每个 appid 都有
 *   - screenshots[0]：1920x1080 截图，连商店大图都没有时的兜底背景
 *
 * @returns {Promise<{netFailed?:boolean, none?:boolean, controllerSupport?:string|null,
 *                    headerImage?:string|null, storeBackground?:string|null, screenshot?:string|null}>}
 *   netFailed=true → 网络失败 / 响应异常：什么都别缓存，下次重试
 *   none=true      → 商店明确没有这个 appid（success:false）
 */
function buildControllerSupportUrl(appid) {
  // cc 用 us：国区对未发行/已下架条目直接 success:false（同上文 NAME_SOURCES 的原因），
  // 而手柄支持档位与地区无关，用美区能稳定拿到。
  return `${STORE_API}?appids=${appid}&cc=us&l=schinese`;
}

async function fetchStoreDetails(appid) {
  let data;
  try {
    data = await fetchJson(buildControllerSupportUrl(appid));
  } catch (e) {
    return { netFailed: true };
  }
  if (!data) return { netFailed: true };
  const entry = data[appid] || data[String(appid)];
  if (!entry) return { netFailed: true };
  if (entry.success !== true || !entry.data) return { none: true };   // 商店明确说没有这个 appid
  const d = entry.data;
  const shots = Array.isArray(d.screenshots) ? d.screenshots : [];
  const firstShot = shots.find(s => s && s.path_full);
  return {
    controllerSupport: pickControllerSupport(d),        // 'full' | 'partial' | 'none' | null
    headerImage: d.header_image || null,
    storeBackground: d.background_raw || d.background || null,
    screenshot: firstShot ? firstShot.path_full : null,
  };
}

/**
 * 从 appdetails 的 data 里挑出手柄支持档位（纯函数，便于单测）。
 * @returns {'full'|'partial'|'none'|null}
 */
function pickControllerSupport(d) {
  if (!d) return null;
  const cs = d.controller_support;
  if (cs === 'full' || cs === 'partial' || cs === 'none') return cs;
  // 兜底：个别条目只在 categories 里体现手柄支持
  const ids = Array.isArray(d.categories) ? d.categories.map(c => c && c.id) : [];
  if (ids.includes(28)) return 'full';     // Full controller support
  if (ids.includes(18)) return 'partial';  // Partial Controller Support
  return null;
}

/* 旧的 fetchControllerSupport 已并入 fetchStoreDetails（同一次请求顺带取回官方图片地址） */

/* ----------------------------- 游戏名批量本地化（中文优先） ----------------------------- */

const NAME_CHUNK = 12;   // 一次请求最多带多少个 appid（appdetails 支持逗号分隔批量）

/**
 * 把若干游戏的名称本地化为中文并写回信息库。
 * 只更新 name / nameEn / nameTried，绝不覆盖已有的 cover / background / logo。
 *
 * @param {Array<{appid:string|number, name?:string}>} entries 游戏列表（name 为当前英文名，用于填充 nameEn）
 * @param {{force?:boolean}} opts force=true 时忽略 nameTried 重抓（设置里的「重新抓取中文名」）
 * @returns {Promise<{updated:number, missing:string[], networkOk:boolean, total:number}>}
 */
async function localizeNames(entries, opts = {}) {
  const force = !!opts.force;
  const todo = (entries || [])
    .map(e => ({ appid: String((e && e.appid) || '').trim(), fallback: (e && e.name) || '' }))
    .filter(e => /^\d+$/.test(e.appid))
    // 已经确认过名字的跳过（nameTried 标记）
    .filter(e => {
      if (force) return true;
      const md = store.getMetadata(e.appid);
      return !(md && md.nameTried);
    });

  const updated = [];
  const missing = [];
  let networkOk = true;
  if (!todo.length) return { updated: 0, missing, networkOk, total: 0 };

  for (let i = 0; i < todo.length; i += NAME_CHUNK) {
    const chunk = todo.slice(i, i + NAME_CHUNK);
    const ids = chunk.map(c => c.appid);
    // 中英各拉一次：只有拿到英文名，换成中文后按英文仍能搜到
    const [zh, en] = await Promise.all([
      fetchNames(ids, NAME_SOURCES[0].lang, NAME_SOURCES[0].cc),
      fetchNames(ids, NAME_SOURCES[1].lang, NAME_SOURCES[1].cc)
    ]);
    const zhNames = zh.names;
    let batchOk = zh.ok || en.ok;

    // 整批都没有中文标题 → 补一次国区请求（老游戏/国区专属条目只在国区有中文标题）
    if (batchOk && !ids.some(id => hasCJK(zhNames.get(id)))) {
      const cn = await fetchNames(ids, NAME_EXTRA.lang, NAME_EXTRA.cc);
      if (cn.ok) {
        cn.names.forEach((v, k) => zhNames.set(k, v));
        batchOk = true;
      }
    }
    if (!batchOk) networkOk = false;

    for (const item of chunk) {
      const zhName = zhNames.get(item.appid) || '';
      const enName = en.names.get(item.appid) || '';
      const name = zhName || enName;
      if (!name || !batchOk) { missing.push(item.appid); continue; }

      const md = store.getMetadata(item.appid) ||
        { appid: item.appid, cover: null, background: null, logo: null, source: 'unknown' };
      store.setMetadata(Object.assign({}, md, {
        name,
        nameEn: enName || md.nameEn || (hasCJK(zhName) ? '' : zhName) || item.fallback || '',
        // 只有商店给了明确答复才标记；否则下次扫描继续尝试补中文名
        nameTried: batchOk
      }));
      updated.push(item.appid);
    }
  }
  return { updated: updated.length, missing, networkOk, total: todo.length };
}

/* ----------------------------- SteamGridDB（封面/背景/徽标） ----------------------------- */

function pickUrl(resp) {
  return resp && resp.data && resp.data.length ? resp.data[0].url : null;
}

/** 从 heroes 列表中挑分辨率最高的一张作为大背景（heroes 尺寸参差） */
function pickBestHero(resp) {
  if (!resp || !resp.data || !resp.data.length) return null;
  const arr = resp.data.filter(it => it.url);
  if (!arr.length) return null;
  arr.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  return arr[0].url;
}

async function fetchSteamGrid(appid, key) {
  const headers = { Authorization: `Bearer ${key}` };
  try {
    const g = await fetchJson(`https://www.steamgriddb.com/api/v2/steam/${appid}`, headers);
    const gridId = g && g.data && g.data.id;
    if (!gridId) return null;
    const [grids, heroes, logos] = await Promise.all([
      fetchJson(`https://www.steamgriddb.com/api/v2/games/${gridId}/grids?dimensions=600x900&types=static&nsfw=false&mimes=image/jpeg,image/png`, headers),
      fetchJson(`https://www.steamgriddb.com/api/v2/games/${gridId}/heroes?nsfw=false`, headers),
      fetchJson(`https://www.steamgriddb.com/api/v2/games/${gridId}/logos?nsfw=false`, headers)
    ]);
    return {
      cover: pickUrl(grids),
      background: pickBestHero(heroes),
      logo: pickUrl(logos)
    };
  } catch (e) {
    return null;
  }
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 抓取并写入信息库。已存在且非 force 时直接返回缓存。
 * @returns {Object|null} 元数据记录（含本地路径或远程 URL）
 */
async function fetchAndStore(appid, opts = {}) {
  appid = String(appid).trim();
  if (!/^\d+$/.test(appid)) throw new Error('appid 必须是数字');

  const settings = store.getSettings();
  const cacheImages = settings.cacheImages !== false;
  const key = (settings.steamGridDbKey || '').trim();

  const existing = store.getMetadata(appid);
  if (existing && !opts.force) {
    // 记录格式版本：旧记录（没配 Key 时抓的，只有 CDN 直链、没有徽标）自动升级重抓一次
    const upgradeOldRecord = !!key && existing.metaV !== META_V;
    // 手柄抓取逻辑升版：旧缓存用 filters=basic 抓的，controllerSupport 恒为空，必须重抓一次
    const needsController = existing.controllerV !== CTRL_V;
    // 图片：单一直链时代抓失败的记录（库里只有远程链接、本地没图）要按新候选逻辑重抓一次。
    // 这正是「输入 appid 补全不了、再点一次还是没反应」的根因——以前这里直接早退返回缓存。
    const needsAssets = needsAssetRetry(existing, { cacheImages });
    // 都齐了才早退；否则往下走，缺什么补什么
    if (!upgradeOldRecord && !needsController && !needsAssets) return existing;
  }

  const meta = Object.assign(
    { appid, name: '', nameEn: '', cover: null, background: null, logo: null, source: 'unknown' },
    existing || {},
    existing
      ? { name: existing.name || '', nameEn: existing.nameEn || '', headerImage: existing.headerImage || null }
      : {}
  );

  // 1) 游戏名（中文优先）
  const nm = await fetchSteamName(appid);
  if (nm) {
    meta.name = nm.name;
    meta.nameEn = nm.nameEn || meta.nameEn || '';
    meta.headerImage = nm.headerImage || meta.headerImage || null;
    // 商店给了明确答复才标记「已确认」；纯网络失败不标记，下次仍会重试补中文名
    if (nm.storeOk) meta.nameTried = true;
  }

  // 1.5) 商店详情：手柄支持档位 + **官方图片地址**（同一次请求，不额外联网）
  //      图片地址给下面的候选链用（老游戏没有 library_* 资源时全靠它兜住）
  const details = await fetchStoreDetails(appid);
  if (!details.netFailed && !details.none) {
    // 商店给了答复（含「确实没有手柄信息」= null）才落缓存；纯网络失败不标记，下次重试
    meta.controllerSupport = details.controllerSupport;
    meta.controllerTried = true;
    meta.controllerV = CTRL_V;
    meta.detailV = DETAIL_V;
  }

  // 2) 图片：SteamGridDB 优先（heroes 大背景），否则走 Steam CDN 多候选兜底
  //    统一放在 userData 下的资源目录（assets/<id>），不写入游戏安装目录；
  //    未指定 assetDir 时回退到 userData/images/<appid>/（信息库按 appid 组织，多游戏可共享同一份）
  let sg = null;
  if (key) sg = await fetchSteamGrid(appid, key);
  const sgOk = !!(sg && (sg.cover || sg.background || sg.logo));
  // 区分「SGDB 成功 / SGDB 配了但失败 / 根本没配 Key」，便于下次判断要不要升级重抓
  meta.source = sgOk ? 'steamgriddb' : (key ? 'steamgriddb-failed' : 'steam-cdn');

  const dir = cacheImages
    ? (opts.assetDir || path.join(store.imagesDir(), appid))
    : null;
  if (dir) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 建不出来就只能存远程链接 */ }
  }

  // 商店 API 直给的官方地址：作为候选链里"最可靠的一环"（商店有页面就一定有图）
  const extra = {
    headerImage: details.headerImage || null,
    storeBackground: details.storeBackground || null,
    screenshot: details.screenshot || null,
  };

  const assets = {};
  for (const kind of ['cover', 'background', 'logo']) {
    assets[kind] = await resolveAsset(appid, kind, {
      dir,
      remote: (sg && sg[kind]) || null,
      existing: existing ? existing[kind] : null,
      existingFallback: kind === 'cover' && !!(existing && existing.coverFallback),
      force: !!opts.force,
      extra,
    });
  }
  meta.cover = assets.cover.url;
  meta.background = assets.background.url;
  meta.logo = assets.logo.url;
  meta.coverFallback = !!assets.cover.fallback;   // 用了横版兜底封面（有竖版时会自动升级）
  // 只有「服务器明确答复过」才记「已试过」，纯网络失败留待下次重试
  meta.coverTried = assets.cover.tried;
  meta.bgTried = assets.background.tried;
  meta.logoTried = assets.logo.tried;
  // 三类图都试过了才升版（半途网络失败不升，下次继续补）
  if (assets.cover.tried && assets.background.tried && assets.logo.tried) meta.assetV = ASSET_V;

  meta.updatedAt = new Date().toISOString();
  meta.metaV = META_V;
  store.setMetadata(meta);
  return meta;
}

/* ----------------------------- 背景图候选列表 ----------------------------- */

/**
 * 按游戏名搜索 SteamGridDB，返回候选 hero 背景图 URL 列表。
 * @param {string} term 游戏名或 appid
 * @param {string} key SteamGridDB API Key
 * @returns {Promise<Array<{id:number,url:string,width:number,height:number,author:string}>>}
 */
async function searchBackgrounds(term, key) {
  const headers = { Authorization: `Bearer ${key}` };
  try {
    // 1) 搜索游戏，取第一个匹配
    const search = await fetchJson(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(term)}`,
      headers
    );
    if (!search || !search.data || !search.data.length) return [];
    const gameId = search.data[0].id;

    // 2) 拉该游戏的 heroes（横版大背景图）
    const heroes = await fetchJson(
      `https://www.steamgriddb.com/api/v2/games/${gameId}/heroes?nsfw=false`,
      headers
    );
    if (!heroes || !heroes.data) return [];
    return heroes.data
      .filter(it => it.url)
      .map(it => ({
        id: it.id,
        url: it.url,
        width: it.width || 0,
        height: it.height || 0,
        author: it.author && it.author.name ? it.author.name : ''
      }));
  } catch (e) {
    return [];
  }
}

/** 按 appid 批量把名字换成中文（中文优先，结果写入信息库） */
module.exports = {
  fetchAndStore,
  searchBackgrounds,
  localizeNames,
  buildControllerSupportUrl,   // 导出便于单测：确认没有带 filters=basic
  pickControllerSupport,       // 导出便于单测：controller_support / categories 两种来源
  // 以下为纯函数/纯常量，导出便于单测（资源候选图源与重抓判定是这次修复的核心）
  assetCandidates,
  assetFileName,
  needsAssetRetry,
  isLocalFile,
  isRemoteUrl,
  NAME_SOURCES,
  NAME_EXTRA,
  ASSET_V,
  DETAIL_V,
  META_V,
};
