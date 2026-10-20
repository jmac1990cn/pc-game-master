'use strict';

/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露安全 API。
 * 渲染进程只能调用这些封装好的方法，无法直接访问 Node/Electron 内部。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 扫描并获取全部游戏（已合并本地配置）
  scanGames: () => ipcRenderer.invoke('games:scan'),
  getGames: () => ipcRenderer.invoke('games:get'),
  // 启动游戏（含修改器联动）；args 为「在开始游戏时询问」模式下临时指定的启动参数
  launchGame: (id, args) => ipcRenderer.invoke('game:launch', id, args),
  // 启动过程中的进度推送（如「正在启动 Steam…」）
  onLaunchStatus: (cb) => ipcRenderer.on('launch:status', (e, msg) => cb(msg)),
  // 存档目录：探测候选列表 / 一键打开
  getSaveDirs: (id) => ipcRenderer.invoke('game:saveDirs', id),
  openSaveDir: (id, target) => ipcRenderer.invoke('game:openSaveDir', id, target),
  // 存档位置在线查询（存档资料站均为英文站，用英文名检索）
  searchSaveOnline: (id, engine) => ipcRenderer.invoke('game:searchSaveOnline', id, engine),
  // 写入单个游戏的自定义配置
  setGameConfig: (id, patch) => ipcRenderer.invoke('game:setConfig', id, patch),
  // 手动添加 / 删除游戏
  addManualGame: (game) => ipcRenderer.invoke('game:addManual', game),
  removeGame: (id) => ipcRenderer.invoke('game:remove', id),
  // 文件选择对话框
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectExe: () => ipcRenderer.invoke('dialog:selectExe'),
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // 打开游戏安装目录
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  // 切换窗口全屏（Playnite 风格沉浸模式）
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  // 元数据 / 信息库
  queryMetadata: (appid, force) => ipcRenderer.invoke('metadata:query', appid, force),
  getMetadataLibrary: () => ipcRenderer.invoke('metadata:library'),
  localizeNames: () => ipcRenderer.invoke('metadata:localizeNow'),
  getMetadataStats: () => ipcRenderer.invoke('metadata:stats'),
  searchBackgrounds: (term) => ipcRenderer.invoke('metadata:searchBackgrounds', term),
  // 用默认浏览器打开外部链接
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 文件夹扫描 + 批量添加
  scanFolder: (folder) => ipcRenderer.invoke('folder:scan', folder),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  addGames: (list) => ipcRenderer.invoke('game:addGames', list),
  // 显式设置全屏状态（桌面/全屏模式切换用）
  setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),
  // 隐藏 / 恢复 / 列出隐藏游戏
  hideGame: (id) => ipcRenderer.invoke('game:hide', id),
  unhideGame: (id) => ipcRenderer.invoke('game:unhide', id),
  getHiddenGames: () => ipcRenderer.invoke('game:hiddenList'),
  // DLC 查询与手动标记（opts.force=true 表示绕过本地缓存、联网重新下载 DLC 资料）
  getDlc: (id, opts) => ipcRenderer.invoke('game:dlc', id, opts),
  setDlcManual: (id, map) => ipcRenderer.invoke('game:setDlcManual', id, map),

  // 内存：查询占用 / 手动释放
  getMemoryInfo: () => ipcRenderer.invoke('app:memoryInfo'),
  trimMemory: () => ipcRenderer.invoke('app:trimMemory'),

  // 电源菜单：重启 / 关闭本程序 / 关机（延迟执行）
  restartApp: () => ipcRenderer.invoke('power:restart'),
  quitApp: () => ipcRenderer.invoke('power:quit'),
  shutdown: (seconds) => ipcRenderer.invoke('power:shutdown', seconds),
  cancelShutdown: () => ipcRenderer.invoke('power:cancelShutdown'),

  // 音频输出通道：枚举设备 / 立即切换系统默认设备
  listAudioDevices: () => ipcRenderer.invoke('audio:list'),
  applyAudioDevice: (deviceId) => ipcRenderer.invoke('audio:apply', deviceId),
  // 启动游戏后主进程要求渲染层卸掉图片、以及恢复时重建
  onMemoryTrim: (cb) => ipcRenderer.on('memory:trim', () => cb()),
  onMemoryRestore: (cb) => ipcRenderer.on('memory:restore', () => cb()),
  // 游戏结束后主进程要求渲染层切回大屏模式
  onToBigScreen: (cb) => ipcRenderer.on('window:toBigScreen', () => cb()),
  // 后台中文化完成后推送（游戏名由英文换成中文）
  onGamesUpdated: (cb) => ipcRenderer.on('games:updated', () => cb())
});
