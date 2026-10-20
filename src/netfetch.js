'use strict';

/**
 * 主进程统一 HTTP 客户端。
 *
 * 为什么不用 Node 原生 fetch？
 *   原生 fetch（undici）**不会使用 Windows 系统代理 / PAC**，也不读系统证书库。
 *   在本机需要代理才能访问 Steam / SteamGridDB 的网络环境下，主进程请求会全部失败
 *   （表现为：界面封面能显示——渲染进程走 Chromium 系统代理；但游戏名一直英文、
 *    图片缓存目录 images/ 全空——主进程直连全部超时）。
 *
 * 所以统一改走 Electron 的 `net.fetch`：它使用 Chromium 网络栈，
 * 与渲染进程同源（系统代理、PAC、证书、TLS 指纹一致）。仅在 net 不可用时退回原生 fetch。
 */

const fs = require('fs');
const path = require('path');

let net = null;
try {
  // 仅在 Electron 主进程可用；纯 Node 环境（自测脚本）会走到 catch
  net = require('electron').net || null;
} catch (e) {
  net = null;
}

/** 当前是否走 Chromium 网络栈（true 时会自动使用系统代理） */
function usingChromiumStack() {
  return !!(net && typeof net.fetch === 'function');
}

/** 底层请求：优先 net.fetch，失败退回原生 fetch */
async function request(url, init = {}) {
  if (usingChromiumStack()) {
    try {
      return await net.fetch(url, init);
    } catch (e) {
      // net.fetch 对少数场景（如非 http(s)、被 session 拦截）可能抛错，退回原生
    }
  }
  return await fetch(url, init);
}

/**
 * 取 JSON（带超时 + 轻量重试）。
 * @param {string} url
 * @param {{headers?:Object, timeout?:number, tries?:number}} opts
 */
async function getJson(url, opts = {}) {
  const { headers = {}, timeout = 15000, tries = 2 } = opts;
  let lastErr = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await request(url, { headers, signal: ctrl.signal });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '无响应'));
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    if (i < Math.max(1, tries) - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error('请求失败');
}

/**
 * 下载文件到本地，并把「失败原因」区分开（多候选图源的关键依赖）。
 *
 * 为什么必须区分：
 *   Steam CDN 上有些 appid 压根没有某张图（服务器明确回 404）——这是**确定结论**，
 *   换下一个候选即可，并且可以记下"已试过"；
 *   而连不上/超时是**暂态**——绝不能记下"已试过"，否则网络恢复后永远补不上。
 *
 * @returns {Promise<{ok:boolean, status:(number|null), network:boolean}>}
 *   ok=true   已写入 dest
 *   network=true 表示"没连上"（不是服务器说没有）
 */
/**
 * 按文件头猜真实图片格式。
 * 图床会用 .jpg 后缀返回 WebP/PNG（SteamGridDB 的 hero、部分商店图都这样），
 * 而 Chromium 加载 file:// 图片是按**扩展名**判类型的 —— 名不副实就会显示破图，
 * 用户看到的就是"明明下载了却没图"。所以落盘后按真实格式改名。
 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return '.png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  if (buf.slice(0, 2).toString('ascii') === 'BM') return '.bmp';
  return null;
}

async function downloadDetail(url, dest, opts = {}) {
  const timeout = opts.timeout || 30000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await request(url, { signal: ctrl.signal });
    if (!res) return { ok: false, status: null, network: true };
    if (!res.ok) return { ok: false, status: res.status, network: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, status: res.status, network: false };
    fs.writeFileSync(dest, buf);

    // 按真实格式修正扩展名（返回值里带上最终路径，调用方必须用它）
    let out = dest;
    const ext = sniffImageExt(buf);
    const cur = path.extname(dest).toLowerCase();
    if (ext && cur !== ext) {
      const fixed = dest.slice(0, dest.length - cur.length) + ext;
      try {
        if (fs.existsSync(fixed)) fs.unlinkSync(fixed);
        fs.renameSync(dest, fixed);
        out = fixed;
      } catch (e) { out = dest; }
    }
    return { ok: true, status: res.status, network: false, path: out };
  } catch (e) {
    return { ok: false, status: null, network: true };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 下载文件到本地。成功返回 true（文件非空才算成功）。
 * @param {string} url
 * @param {string} dest 目标文件绝对路径
 */
async function downloadTo(url, dest, opts = {}) {
  const r = await downloadDetail(url, dest, opts);
  return !!r.ok;
}

/**
 * 只探活不落盘（cacheImages 关闭时用）：拿到响应头即断开，省流量。
 * 同样区分「服务器说没有」与「没连上」。
 * @returns {Promise<{ok:boolean, network:boolean}>}
 */
async function probeDetail(url, opts = {}) {
  const timeout = opts.timeout || 8000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await request(url, { signal: ctrl.signal, headers: { Range: 'bytes=0-0' } });
    if (!res) return { ok: false, network: true };
    // 立刻掐掉响应体，不要为了探活把整张图读下来
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) {}
    if (!res.ok) return { ok: false, network: false };
    const len = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    return { ok: len === null || len === undefined || Number(len) > 0, network: false };
  } catch (e) {
    return { ok: false, network: true };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { request, getJson, downloadTo, downloadDetail, probeDetail, usingChromiumStack };
