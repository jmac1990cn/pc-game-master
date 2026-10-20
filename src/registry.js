'use strict';

/**
 * Windows 注册表读取辅助。
 * 通过 shell 调用 `reg query` 解析输出，避免引入原生模块，兼容性最好。
 * 在 Windows 上 `reg` 为内置命令；非 Windows（如开发机为 macOS/Linux）调用会失败，
 * 此时所有读取返回空，扫描器会据此返回空列表，不影响手动添加游戏。
 */

const { spawnSync } = require('child_process');
const path = require('path');

function regExists() {
  // 粗略判断是否 Windows 环境
  return process.platform === 'win32';
}

/** 展开根键缩写（HKLM→HKEY_LOCAL_MACHINE 等）并去掉尾部分隔符，便于做前缀比较 */
function normalizeKeyPath(p) {
  return String(p || '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .replace(/^HKLM(\\|$)/i, 'HKEY_LOCAL_MACHINE$1')
    .replace(/^HKCU(\\|$)/i, 'HKEY_CURRENT_USER$1')
    .replace(/^HKCR(\\|$)/i, 'HKEY_CLASSES_ROOT$1')
    .replace(/^HKU(\\|$)/i, 'HKEY_USERS$1')
    .replace(/^HKCC(\\|$)/i, 'HKEY_CURRENT_CONFIG$1');
}

/**
 * 执行 `reg query KEY [/v VALUE] [/s]` 并返回结构化结果。
 * @returns {{subkeys:string[], values:Object<string,string>}}
 */
function queryReg(key, { value = null, recursive = false } = {}) {
  if (!regExists()) return { subkeys: [], values: {} };

  const args = ['query', key];
  if (value) args.push('/v', value);
  if (recursive) args.push('/s');

  let out = '';
  try {
    // reg.exe 输出用的是 OEM 代码页（中文系统为 GBK/936），按 UTF-8 解码会得到乱码。
    // 先按 buffer 拿原始字节，再用 GBK 解码：ASCII 兼容，中文可读。
    const r = spawnSync('reg', args, {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return { subkeys: [], values: {} };
    out = new TextDecoder('gbk').decode(r.stdout);
  } catch (e) {
    return { subkeys: [], values: {} };
  }

  return parseRegOutput(out, key);
}

/**
 * 解析 `reg query` 的文本输出（纯函数，抽出来便于单测——不依赖真实注册表）。
 * @param {string} out 已按 GBK 解码后的原始输出
 * @param {string} key 被查询的键（用于识别「自身表头」与「后代子键」）
 * @returns {{subkeys:string[], values:Object<string,string>}}
 */
function parseRegOutput(out, key) {
  const result = { subkeys: [], values: {} };
  const lines = String(out || '').split(/\r?\n/);
  const root = normalizeKeyPath(key);
  for (const raw of lines) {
    const line = raw.replace(/\0/g, '').trimEnd();
    if (!line.trim()) continue;
    const content = line.trim();

    // 键路径行。reg.exe 有两种输出习惯：
    //   1) 被查询的键自身 → 输一行完整路径，作为「值列表」的表头；
    //   2) 子键 → Win11 起同样输出完整路径（旧系统/旧版本是缩进的裸键名，见下方分支）。
    // 早期实现把所有 HKEY_ 行都当表头跳过，于是 Win11 上子键列表恒为空
    //（育碧 Installs、战网 LaunchOptions、卸载表都因此扫不到东西）。
    if (/^HKEY_/i.test(content)) {
      const p = normalizeKeyPath(content);
      if (p === root) continue;                 // 自身表头，跳过
      if (p.startsWith(root + '\\')) {          // 后代路径 → 取直接子键名
        const rel = p.slice(root.length + 1).split('\\')[0];
        if (rel) result.subkeys.push(rel);
      }
      continue;
    }

    // 子键（旧格式）：缩进且只有一个 token（没有 REG_ 类型），且不是 (Default)
    const parts = content.split(/\s{2,}|\t/).filter(Boolean);
    if (parts.length === 1 && !/^REG_/i.test(parts[0])) {
      if (parts[0] !== '(Default)' && parts[0] !== '(默认)') {
        result.subkeys.push(parts[0]);
      }
      continue;
    }

    // 值：name  REG_TYPE  data
    const m = content.match(/^(.*?)\s{2,}(REG_\w+)\s+(.*)$/);
    if (m) {
      const name = m[1].trim();
      let data = m[3].trim();
      // 去掉字符串可能的引号
      if (data.startsWith('"') && data.endsWith('"')) data = data.slice(1, -1);
      result.values[name] = data;
    }
  }
  return result;
}

/**
 * 递归查询某个键下所有子键的指定值，一次 spawn 拿全表。
 * 返回 { 子键名: 值 }；子键没有该值时不出现。
 *
 * 为什么不用「listRegSubKeys + 循环 readRegValue」：
 * 卸载表有 300+ 子键，逐键查询要 spawn reg.exe 上千次，每次 30-80ms，
 * 同步执行会阻塞主进程分钟级（窗口都要等它）。递归查询一次只 spawn 一次。
 */
function queryRegValuesRecursive(key, valueName) {
  const out = {};
  if (!regExists()) return out;

  const args = ['query', key, '/s', '/v', valueName];
  try {
    const r = spawnSync('reg', args, {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return out;
    const text = new TextDecoder('gbk').decode(r.stdout);

    let currentLeaf = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\0/g, '').trimEnd();
      const t = line.trim();
      if (!t) continue;
      if (/^HKEY_/i.test(t)) {
        // 键路径行：最后一段即子键名
        currentLeaf = t.split('\\').pop() || null;
        continue;
      }
      if (/End of search/i.test(t)) break;
      const m = t.match(/^(.*?)\s{2,}(REG_\w+)\s+(.*)$/);
      if (m && currentLeaf) {
        const name = m[1].trim();
        if (name.toLowerCase() === String(valueName).toLowerCase()) {
          let data = m[3].trim();
          if (data.startsWith('"') && data.endsWith('"')) data = data.slice(1, -1);
          out[currentLeaf] = data;
        }
      }
    }
  } catch (e) {
    /* 查询失败返回空 */
  }
  return out;
}

/** 读取某个键下的单个值，不存在返回 null */
function readRegValue(key, valueName) {
  const r = queryReg(key, { value: valueName });
  return r.values[valueName] !== undefined ? r.values[valueName] : null;
}

/** 枚举某个键下的所有子键名 */
function listRegSubKeys(key) {
  return queryReg(key).subkeys;
}

/** 将注册表里可能带图标索引的 DisplayIcon 解析为干净 exe 路径，如 "C:\x\y.exe,0" -> "C:\x\y.exe" */
function cleanExeFromIcon(icon) {
  if (!icon) return null;
  let p = icon.trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  // 去掉 ",0" 图标索引后缀
  const comma = p.lastIndexOf(',');
  if (comma > 0 && /,\s*-?\d+\s*$/.test(p)) {
    p = p.slice(0, comma);
  }
  // 去掉可能的引号残留
  p = p.replace(/^"|"$/g, '').trim();
  if (p.toLowerCase().endsWith('.exe')) {
    return path.normalize(p);
  }
  return null;
}

module.exports = {
  regExists,
  normalizeKeyPath,
  parseRegOutput,      // 导出便于单测：Win11 子键输出格式是「重复游戏/漏扫」的高发点
  queryReg,
  queryRegValuesRecursive,
  readRegValue,
  listRegSubKeys,
  cleanExeFromIcon
};
