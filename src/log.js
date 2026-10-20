'use strict';

/**
 * 极简诊断日志（仅主进程）。
 *
 * 为什么需要：启动 / 进程探测 / 音频联动这类「时序型」问题在界面上看不出来，
 * 只表现为「音频莫名其妙被切回去了」。留一份落盘日志，出问题能直接看到
 * 到底是哪一步在动系统默认输出。
 *
 * 落盘位置：<userData>/logs/pc-game-master.log（超过 512KB 滚成 .1，只留一份历史）
 * 任何异常都吞掉——日志失败绝不允许影响主流程。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

let dir = null;
let resolved = false;

function baseDir() {
  if (resolved) return dir;
  resolved = true;
  try {
    const { app } = require('electron');
    dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    dir = null;
  }
  return dir;
}

function logPath() {
  const d = baseDir();
  return d ? path.join(d, 'pc-game-master.log') : null;
}

/** 追加一行日志：log('audio', '...') */
function log(tag, msg) {
  const file = logPath();
  if (!file) return;
  try {
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch (e) { /* 文件不存在 / 改名失败都无所谓 */ }
    const text = msg === undefined || msg === null ? '' : String(msg);
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${tag}] ${text}\n`, 'utf8');
  } catch (e) { /* 忽略 */ }
}

module.exports = { log, logPath };
