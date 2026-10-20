# PC Game Master

Windows 游戏管理前端。把 Steam / Epic / 战网 / 育碧 Connect / Xbox（Game Pass）各平台的游戏聚合成一个大屏启动台，支持自定义封面背景、游戏名中文化、修改器联动启动、存档目录探测、游玩时长统计、音频输出通道切换、空闲屏保与游戏攻略一键检索。

> 当前版本 **1.0.0**，基于 Electron 构建，MIT 协议开源。

## 主要功能

**游戏库聚合**
- 自动扫描：Steam、Epic、战网（国服 / 国际可指定路径）、育碧 Connect、Xbox / Game Pass（含 MSIX 包，以 `MicrosoftGame.config` 判定，避免混入非游戏）
- 扫描时机：只在应用启动（或点「⟳ 刷新」）时全平台扫描一次，其余操作只做毫秒级「合并刷新」，不再触碰注册表 / 磁盘 / Appx
- Steam 库归一化：自动合并注册表 `SteamPath` 与 `libraryfolders.vdf` 里同一目录的不同写法（双反斜杠 vs 正斜杠）
- Xbox 双形态去重：同一款游戏同时存在于 `XboxGames` 目录与 WindowsApps MSIX 包时，按名称归一化只保留一张卡
- 战网双来源扫描：老客户端 `LaunchOptions` 注册表 + 卸载表（国服 / 新版客户端不写前者，卸载表条目也能识别并自动映射回战网产品码）
- 扫描结果按 id 去重；支持手动添加、按文件夹批量导入、隐藏 / 删除游戏
- 启动参数支持「预设」与「启动时询问」两种模式；模拟器游戏通过「可执行文件 = 模拟器本体 + 启动参数 = 这一款游戏的参数」接入（RPCS3 / Yuzu / Ryujinx / PCSX2 / Dolphin / DuckStation 等）

**启动与平台客户端**
- 启动前检测平台客户端，未运行则先拉起，再等客户端就绪（默认 15 秒，可调 5~120 秒）后启动游戏 —— 宁可多等，一次成功
- 平台游戏走平台官方启动方式，由客户端接管启动（兼容 DLC / 云存档 / 成就 / 反作弊）：
  - Epic → `com.epicgames.launcher://apps/<Namespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true`
  - 战网 → `Battle.net.exe --exec="launch <产品代码>"`（`WTCG`=炉石、`WoW`=魔兽、`D3`=暗黑3、`Pro`=守望、`S2`=星际2…）
  - 育碧 → `uplay://launch/<id>/0`
- 修改器联动启动，可设启动顺序与延迟；**游戏进程退出（含被新游戏顶替）时按完整路径精确关闭对应修改器**，不留残留
- 需要管理员权限的程序（部分修改器 / 反作弊单机）会自动提权，跟双击该程序等价
- 任何子进程 spawn 失败都不再崩溃主进程（全局 `uncaughtException` 兜底，只如实告知原因）
- 游戏窗口出现后自动切到最前端（设置可关），守卫视窗期内被抢走会自动拉回；只激活、不强制置顶霸屏

**Steam 启动项双向同步**
- 管理弹窗「启动」分页的启动选项与 Steam 自带启动项互通：可读（显示 Steam 当前值 / 一键读取）、可写（写入 `localconfig.vdf` 的 `apps\<appid>\LaunchOptions`）
- 写入只动 `LaunchOptions` 这一行，文件其余内容逐字节保留；写入前自动备份；同值重复保存不写盘
- `%command%` 语义已处理：只取占位符后的参数，写回时保留 `gamemoderun` 这类包装命令

**DLC 管理**
- 详情页只显示一个「🧩 DLC 管理」按钮（带「已装 x/y」统计），点开才展开明细列表
- 按平台自动查询：Steam 读本地 `appmanifest` + 商店 API 中文名；Epic 扫 Manifests；非 Steam 但填了 appid 的按 appid 拉全量清单由用户勾选；不在商店清单里的 dlcappid 也按「已安装」显示
- DLC 资料本地缓存（`dlc-cache.json`），零联网打开详情页；可手动标记、可点「↻ 更新」联网刷新、可在线搜索核对

**展示与自定义**
- 大屏沉浸模式 / 桌面模式双切换
- 自定义封面、大背景、徽标：本地图片或 SteamGridDB 在线选图（需自填免费 API Key）
- 后台自动把英文游戏名换成中文，并补全缺失图片（网络恢复后自动重试，不永久缓存失败）
- 游戏详情页「手柄支持」标识（完整 / 部分 / 不支持），取自 Steam 商店字段并随信息库缓存

**图片资源本地化（离线可用）**
- 扫描即落地、渲染永远走本地：后台串行预取所有缺图游戏，落到 `userData/assets/<gameId>/`；合并阶段只接受 `file://` 本地路径
- 首次联网抓图后，之后所有界面（含游戏结束重建、列表刷新、屏保轮播）全程离线，封面 / 背景 / 徽标不再消耗网络

**音频输出通道**
- 设置里可选「默认音频输出通道」，支持一键把系统默认设备切过去
- 单款游戏可指定启动音频通道，支持「试听切换」当场验证
- 启动游戏时自动切到指定设备，**游戏退出后自动切回默认通道**
- 游戏运行期间通道是「粘」的：切到桌面 / 浏览器 / 系统重设都不会带走，万一漂走守护会在一分钟内切回
- 只有「游戏确实退出」才还原默认通道（双重信号 + 4 秒二次确认，避免误判把全屏游戏弹回桌面）
- 技术实现：`IMMDeviceEnumerator` 枚举播放端点 + `IPolicyConfig::SetDefaultEndpoint` 切换，由 PowerShell 内联 C# 运行时编译，不引入任何原生模块

**游玩时长**
- 平台数据优先：解析 Steam `localconfig.vdf` 读出累计 / 近两周时长与最后游玩时间，跨机器跨重装准确
- 本地计时兜底：Epic / 战网 / 育碧 / Xbox 启动后监视进程，退出时按会话累加（不足 1 分钟不计），保留近 14 天窗口
- 首页排序（5 席位，同款不重复占位）：最后游玩 → 近两周最多两款 → 总时长最多两款；无记录时退化为字母序

**内存优化**
- 单实例锁：重复启动只是把已有窗口带回前台
- V8 堆上限 512MB + 暴露 `global.gc()`；封面 `loading=lazy` + 卡片 `content-visibility:auto`
- 启动游戏后自动释放内存（卸大图 / 清会话缓存 / GC）并最小化窗口；游戏结束恢复时保留卡片网格、封面基本秒出

**屏保**
- 空闲（默认 3 分钟，可调 1~120）后全屏遮罩轮播已安装游戏背景图，交叉淡入，任意操作立即退出
- 游戏运行中 / 窗口不可见 / 有弹窗打开时暂停计时

**游戏攻略**
- 详情页一组按钮，用中文游戏名打开外部检索：图文攻略（Bing 限定 3DM / 游民星空 / 游侠网）、B 站视频攻略、豆包答疑

**存档**
- 自动探测候选存档目录（Steam 云存档 / 我的文档 / AppData / 安装目录），一键打开
- 中文名游戏用英文名去 PCGamingWiki / 搜索引擎在线查存档位置

**电源菜单**
- 主界面右上角电源按钮：重启 / 关闭 PC Game Master / 关机（关机延迟 10 秒，支持取消）

## 支持平台

| 平台 | 扫描 | 官方启动 | 时长来源 |
| --- | --- | --- | --- |
| Steam | ✅ | 直接 / Steam 协议 | localconfig.vdf |
| Epic | ✅ | 启动协议 | 本地计时 |
| 战网（国服 / 国际） | ✅ | `--exec=launch` | 本地计时 |
| 育碧 Connect | ✅ | `uplay://` | 本地计时 |
| Xbox / Game Pass | ✅ | 系统调用 | 本地计时 |
| 模拟器游戏 | 手动添加 | 模拟器 + 参数 | 本地计时 |

## 技术栈

| 项 | 值 |
| --- | --- |
| 运行时 | Electron 31.7.7（Chromium 126 / Node 20） |
| 前端 | 原生 HTML + CSS + JS，无框架、无构建步骤 |
| 打包 | electron-builder（NSIS 安装器，x64） |
| 运行时依赖 | 无（`dependencies` 为空，只用 Electron 内置能力） |

## 安装与下载

从 GitHub Releases 下载最新安装包 `PC Game Master-<version>-setup.exe`，双击按向导安装即可（用户级安装，不写 Program Files，开机自启不弹 UAC）。

## 目录结构

```
pc-game-master/
├─ src/                     主进程（Node 侧）
│  ├─ main.js               Electron 入口：窗口、IPC 路由、后台任务编排
│  ├─ preload.js            contextBridge 安全桥（渲染层唯一可用 API）
│  ├─ store.js              本地配置持久化（userData/config.json）
│  ├─ scanner.js            各平台游戏扫描与识别
│  ├─ launcher.js           启动游戏 / 修改器联动
│  ├─ platform.js           平台客户端检测与预启动
│  ├─ metadata.js           游戏信息库（中文名 / 封面 / 背景 / 徽标）
│  ├─ netfetch.js           网络抓取（走 Chromium 栈，自动继承系统代理）
│  ├─ savedir.js            存档目录自动探测
│  ├─ registry.js           注册表读取
│  ├─ playtime.js           游玩时长统计
│  ├─ audio.js              音频输出设备枚举与系统默认设备切换
│  └─ winfocus.js           游戏窗口前台激活
├─ renderer/                渲染进程（界面）
│  ├─ index.html            页面结构 + 全部弹窗
│  ├─ style.css             主题样式
│  ├─ app.js                界面逻辑
│  ├─ screensaver.js        屏保轮播
│  └─ assets/icon.ico|png   应用图标
├─ tools/
│  ├─ make-icon.py          图标生成脚本（Steam 风格圆盘手柄，输出多尺寸 ico）
│  ├─ smoke-test.js         主进程冒烟测试（无窗口跑真实 IPC 逻辑）
│  ├─ check-ui.js           前端一致性检查
│  ├─ check-session.js      游玩会话监视真机回归
│  ├─ check-layout.js       桌面模式布局回归
│  ├─ check-dlc.js          DLC 区块 UI 回归
│  ├─ check-focus.js        游戏窗口前台激活真机回归
│  ├─ check-screensaver.js  屏保逻辑回归
│  └─ check-asar.js         打包后源码逐字节校验
├─ build/icon.ico           打包用图标
├─ .github/workflows/        GitHub Actions 自动构建发布
└─ package.json             依赖 + electron-builder 打包配置
```

## 开发与打包

```bash
npm install          # 首次：安装 electron / electron-builder
npm start            # 以源码方式运行（开发调试）
npm run verify       # 一次性跑完下面三项检查（推荐改完代码就执行）
npm run check        # 对所有 JS 做语法校验
npm run check:ui     # 前端一致性：id 引用、按钮绑定、IPC 通道是否对齐
npm run smoke        # 主进程冒烟测试（不需要开窗口）
npm run build        # 出 NSIS 安装包 → dist/PC Game Master-<version>-setup.exe
npm run build:portable   # 出免安装单文件版
```

国内网络若下载 Electron 慢，可先设镜像再安装：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install
```

## 自动化验证

改完代码不必每次真开应用，以下脚本覆盖绝大多数回归：

**`npm run smoke`** —— 主进程冒烟测试。用 `Module._load` 拦截 `require('electron')` 并让 `app.whenReady()` 永不 resolve（不建窗口、不跑后台网络），直接调用已注册的 IPC handler 验证真实业务逻辑：VDF 解析、游玩时长合并、首页排序（含无数据退化）、音频设备枚举、电源 IPC、设置与按游戏音频通道持久化、preload ↔ main 的 IPC 通道对齐。沙箱环境会拦截 `reg.exe` / `tasklist`，脚本桩掉 `registry.js` 与 `scanner.js`。结果落在 `<系统临时目录>/gl-smoke-result.json`。

**`npm run check:ui`** —— 扫 `index.html` 与 `app.js`：`$('id')` 引用的元素是否都存在、关键按钮是否都绑了事件、`preload.js` 里 `invoke` 的通道是否都在 `main.js` 注册。其中一项专门盯弹窗分页：`manageModal` / `settingsModal` 必须各有 ≥4 个分页、`data-tab` 与 `data-pane` 一一对应，且所有表单字段都必须落在某个分页里。

**`npm run check:session`** —— 游玩会话监视真机回归（约 30 秒）：用一个改名后的 `node.exe` 冒充游戏主程序，验证「进程还在跑 → 绝不结算；进程真的没了 → 才结算」。

**`npm run check:layout`** —— 桌面模式布局回归（真实 Electron 渲染，约 10 秒）：造 N 个封面卡片，跨 5 种窗口尺寸 × 3 种游戏数量断言卡片不堆叠、保持 3:4.4 比例、顶栏恒为单行、内容超屏可纵向滚动。

**`npm run check:dlc`** —— DLC 区块 UI 回归（真实 Electron 渲染，约 3 秒）：驱动点击断言 14 项，含默认折叠、缓存文案、`↻ 更新` 带 `force`、`非 Steam appid` 徽标、勾选落盘、在线搜索链接。

**`npm run check:focus`** —— 游戏窗口前台激活真机回归（约 20 秒，会短暂弹窗）。

**`npm run check:screensaver`** —— 屏保逻辑回归（4 项：空闲出现 / 移动退出 / 退出后再现 / 轮播推进）。

**`npm run check:asar`** —— 打包后校验：`dist/win-unpacked/resources/app.asar` 里的 `src/**`、`renderer/**` 与磁盘源码逐字节比对，并核对包内版本号。构建成功 ≠ 改动进包了，所以 `npm run build` 之后强烈建议跑一次。

## 用户数据位置

```
%APPDATA%\PC Game Master\
├─ config.json     设置（含默认音频通道）、游戏配置（含按游戏音频通道）、信息库、
│                  本地游玩时长（playtime）、隐藏列表
├─ assets\<游戏id>\  缓存的封面 / 背景 / 徽标
├─ backgrounds\  images\
└─ logs\pc-game-master.log   诊断日志（会话开始/结束原因、音频切换与守护动作）
```

> Electron 的 userData 取 `productName`，所以这里叫「PC Game Master」。卸载重装不会丢配置（打包配置已设 `deleteAppDataOnUninstall: false`）。音频 / 会话的每一步决策都写进 `logs\pc-game-master.log`，出问题先看这个文件。

## 许可证

[MIT](LICENSE) © 2026 王总 (GH Wang)
