'use strict';
/**
 * 屏保模块（纯浏览器脚本，无 node 依赖，便于真实渲染层回归测试）
 *
 * 行为：
 *  - 用户在 idleMin 分钟（默认 3）内无任何操作（鼠标移动/点击/按键/滚轮/触摸/窗口聚焦），
 *    自动把窗口切成一个全屏遮罩，轮播「已安装游戏」的背景图（background 优先，缺则用 cover）。
 *  - 任意输入立即退出屏保并重新计时。
 *  - 游戏运行中 / 窗口不可见 / 有弹窗打开时暂停计时（不会在用户看游戏或调设置时弹出屏保）。
 *  - 若没有任何背景图，仍显示一个纯色遮罩 + 提示，移动鼠标即退出。
 *
 * 调用方（app.js）通过 Screensaver.init({...}) 注入真实数据，并通过 configure() 实时改开关。
 */
(function () {
  let enabled = false;
  let idleMin = 3;
  let cfg = {
    getGames: function () { return []; },
    isBlocked: function () { return false; },
  };

  let overlay = null, layerA = null, layerB = null, nameEl = null, clockEl = null;
  let idleTimer = null, rotTimer = null, clockTimer = null;
  let active = false;
  let idx = 0;            // 下一个要展示的图片下标
  let front = 0;          // 当前前台图层（0=A，1=B）
  let list = [];          // 轮播列表：[{url, name}]
  const ROTATE_MS = 5000; // 每张图停留时长

  /** 取轮播列表：background 优先，其次 cover */
  function buildList() {
    const games = cfg.getGames() || [];
    const out = [];
    for (const g of games) {
      const url = g.background || g.cover;
      if (url) out.push({ url: url, name: g.name || '' });
    }
    return out;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function updateClock() {
    if (!clockEl) return;
    const d = new Date();
    clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 把下一张图画到后台图层，交叉淡入 */
  function paint() {
    if (!list.length) {
      overlay.classList.add('no-img');
      return;
    }
    overlay.classList.remove('no-img');
    const cur = front ? layerA : layerB;   // 当前前台
    const next = front ? layerB : layerA;  // 即将切到前台
    next.style.backgroundImage = 'url("' + list[idx].url + '")';
    next.classList.add('front');
    cur.classList.remove('front');
    if (nameEl) nameEl.textContent = list[idx].name || '';
    front = front ? 0 : 1;
    idx = (idx + 1) % list.length;
  }

  function show() {
    if (active) return;
    if (cfg.isBlocked()) { schedule(); return; }
    list = buildList();
    active = true;
    idx = 0; front = 0;
    layerA.classList.remove('front');
    layerB.classList.remove('front');
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    paint();
    rotTimer = setInterval(paint, ROTATE_MS);
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
  }

  function hide() {
    if (!active) return;
    active = false;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    if (rotTimer) { clearInterval(rotTimer); rotTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    schedule();
  }

  function onActivity() {
    if (active) hide();
    lastActivity = Date.now();
    schedule();
  }

  let lastActivity = Date.now();
  function schedule() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!enabled) return;
    // 被暂停（游戏运行 / 窗口不可见 / 弹窗打开）时不启动计时；等回到活动态再计
    if (cfg.isBlocked()) return;
    const ms = Math.max(1000, idleMin * 60000);
    idleTimer = setTimeout(function () {
      if (cfg.isBlocked()) { schedule(); return; }
      show();
    }, ms);
  }

  function isModalOpen() {
    const modals = document.querySelectorAll('.modal');
    for (let i = 0; i < modals.length; i++) {
      if (!modals[i].hidden) return true;
    }
    return false;
  }

  function ensureDom() {
    if (overlay) return;
    overlay = document.getElementById('screensaver');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'screensaver';
      document.body.appendChild(overlay);
    }
    overlay.setAttribute('aria-hidden', 'true');
    layerA = overlay.querySelector('.ss-layer[data-layer="0"]');
    layerB = overlay.querySelector('.ss-layer[data-layer="1"]');
    if (!layerA || !layerB) {
      overlay.innerHTML =
        '<div class="ss-layer" data-layer="0"></div>' +
        '<div class="ss-layer" data-layer="1"></div>' +
        '<div class="ss-info"><div class="ss-name"></div><div class="ss-clock"></div></div>' +
        '<div class="ss-hint">移动鼠标或按任意键退出屏保</div>' +
        '<div class="ss-empty">暂无游戏背景图</div>';
      layerA = overlay.querySelector('.ss-layer[data-layer="0"]');
      layerB = overlay.querySelector('.ss-layer[data-layer="1"]');
    }
    nameEl = overlay.querySelector('.ss-name');
    clockEl = overlay.querySelector('.ss-clock');
  }

  function init(opts) {
    cfg = Object.assign({}, cfg, opts || {});
    enabled = opts && opts.enabled !== false;
    idleMin = (opts && opts.idleMin) || 3;
    ensureDom();
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, onActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onActivity);
    window.addEventListener('focus', onActivity);
    // isBlocked 默认也包含「弹窗打开」判定，避免屏保盖住设置/管理弹窗
    const baseBlocked = cfg.isBlocked;
    cfg.isBlocked = function () { return baseBlocked() || isModalOpen(); };
    schedule();
  }

  function configure(patch) {
    if (!patch) return;
    if ('enabled' in patch) enabled = patch.enabled;
    if ('idleMin' in patch) idleMin = patch.idleMin;
    schedule();
  }

  window.Screensaver = {
    init: init,
    configure: configure,
    hide: hide,
    show: show,
    isActive: function () { return active; },
    _list: buildList,           // 仅供测试
    _layerUrls: function () {
      return [layerA.style.backgroundImage, layerB.style.backgroundImage];
    }
  };
})();
