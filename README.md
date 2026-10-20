# PC Game Master

Windows 本地游戏管理前端。把 Steam / Epic / 战网 / 育碧 / Xbox 各平台的游戏聚合成一个大屏启动台，
支持自定义封面背景、游戏名中文化、修改器联动启动、存档目录探测、游玩时长统计、音频输出通道切换、启动后自动释放内存。

> 本工程由 `PC Game Master-1.0.0-setup.exe` 安装包中提取还原（Electron 应用的 `app.asar` 源码未做混淆），
> 源码完整可用，可直接在源码上继续迭代功能。当前版本 **1.0.0**（本软件即原「游戏管家」，自 1.0.0 起改名为 PC Game Master）。

## 技术栈

| 项 | 值 |
| --- | --- |
| 运行时 | Electron 31.7.7（Chromium 126 / Node 20） |
| 前端 | 原生 HTML + CSS + JS，无框架、无构建步骤 |
| 打包 | electron-builder（NSIS 安装器，x64） |
| 运行时依赖 | 无（`dependencies` 为空，只用 Electron 内置能力） |

## 目录结构

```
游戏管家-dev/
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
│  ├─ playtime.js           游玩时长统计（Steam localconfig.vdf + 本地进程计时）
│  └─ audio.js              音频输出设备枚举与系统默认设备切换
├─ renderer/                渲染进程（界面）
│  ├─ index.html            页面结构 + 全部弹窗
│  ├─ style.css             主题样式
│  ├─ app.js                界面逻辑
│  └─ assets/icon.ico|png   应用图标
├─ tools/
│  ├─ make-icon.py          图标生成脚本（Steam 风格圆盘手柄，输出多尺寸 ico）
│  ├─ smoke-test.js         主进程冒烟测试（无窗口跑真实 IPC 逻辑，见下）
│  └─ check-ui.js           前端一致性检查（id / 事件绑定 / IPC 通道对齐）
├─ build/icon.ico           打包用图标（由 make-icon.py 生成）
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
npm run check:dlc    # DLC 区块 UI 回归（真实 Electron 渲染，折叠/缓存/更新/非 Steam appid）
npm run shot:ui      # 把「管理 / 设置」的每个分页各截一张图 → tools/preview/
npm run icon         # 重新生成图标（需要 Pillow）
npm run build        # 出 NSIS 安装包 → dist/PC Game Master-1.0.0-setup.exe
npm run build:portable   # 出免安装单文件版
```

国内网络若下载 Electron 慢，可先设镜像再安装：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install
```

## 自动化验证

改完代码不必每次真开应用，两个脚本能覆盖绝大多数回归：

**`npm run smoke`** —— 主进程冒烟测试。用 `Module._load` 拦截 `require('electron')`，
并让 `app.whenReady()` 永不 resolve（不建窗口、不跑后台网络），然后直接调用已注册的 IPC handler
验证真实业务逻辑：VDF 解析、游玩时长合并、首页排序（含无数据退化）、音频设备枚举、
电源 IPC、设置与按游戏音频通道持久化、preload ↔ main 的 IPC 通道对齐。

> 注意：因为 `whenReady` 不 resolve，`main.js` 里的 `store.init(app)` 不会执行，
> 测试里手动补了一次，否则所有配置写入都会失败。
> 沙箱/受限环境会拦截 Node 调用 `reg.exe` / `tasklist`，因此脚本桩掉了 `registry.js` 与 `scanner.js`。
> 完整结果落在 `<系统临时目录>/gl-smoke-result.json`。

**`npm run check:ui`** —— 扫 `index.html` 与 `app.js`：`$('id')` 引用的元素是否都存在、
关键按钮是否都绑了事件、`preload.js` 里 `invoke` 的通道是否都在 `main.js` 注册。有缺失则以非 0 退出。
其中一项专门盯弹窗分页：`manageModal` / `settingsModal` 必须各有 ≥4 个分页、`data-tab` 与
`data-pane` 一一对应，且**所有表单字段都必须落在某个分页里**（防止选项又堆回同一个长页）。

**`npm run shot:ui`** —— 分页视觉回归：把 `index.html` 里的分页弹窗单独渲染成 PNG，
每个分页一张，落到 `tools/preview/`（已 gitignore）。用于人工核对
「标题与分页条固定、只有内容区滚动、底部保存始终可见」。纯 CSS 改动看不出问题时值得跑一次。

**`npm run check:session`** —— 游玩会话监视的真机回归测试（约 30 秒，默认不在 `verify` 里）。
用一个改名后的 `node.exe` 冒充游戏主程序，验证「进程还在跑 → 绝不结算；进程真的没了 → 才结算」。
这条链路一旦判断错，后果就是音频被切回默认、窗口被弹回桌面（见下面「音频输出通道」）。

**`npm run check:layout`** —— 桌面模式布局回归（真实 Electron 渲染，约 10 秒）。
用真实 `index.html` + `style.css` 造出 N 个封面卡片，跨 5 种窗口尺寸 × 3 种游戏数量断言：
**卡片不堆叠**（行间距 ≥ 卡片高）、**卡片保持 3:4.4 比例**、**顶栏恒为单行**、**内容超屏时可纵向滚动**。
纯 CSS 的正则断言挡不住这类布局回归（改个属性就可能复现），所以这条必须有。
「封面堆叠」的根因与修法见下面「桌面模式」一节。

**`npm run check:dlc`** —— DLC 区块 UI 回归（真实 Electron 渲染，约 3 秒）。
加载真实 `index.html` + `style.css` + 真实 `app.js`（桩 `window.api`），驱动点击断言 14 项：
**默认折叠 → 点按钮才展开明细**（并实际量 `#dlcBody` 的 `display`，防止 `display:flex` 顶掉 `hidden` 让折叠失效）、
按钮上「已装 x/y」统计、缓存命中标「本地缓存 · x 小时前更新」、首次查询不带 `force`（不联网）、
**「↻ 更新」必须带 `force:true`**、非 Steam + appid 场景徽标为「已有/未有」、勾选落盘即时更新统计、在线搜索链接正确。

**`npm run check:focus`** —— 游戏窗口前台激活的真机回归（约 20 秒，会短暂弹出窗口）：
验证「等到慢游戏出现后才激活、激活后前台=游戏、守卫期把被抢走的游戏拉回前台」。

**`npm run check:asar`** —— 打包后校验：`dist/win-unpacked/resources/app.asar` 里的
`src/**`、`renderer/**` 与磁盘源码逐字节比对，并核对包内版本号。
构建成功 ≠ 改动进包了（漏文件、复用旧 asar 都可能），所以 `npm run build` 之后强烈建议跑一次。

**`npm run icon`** —— 重新生成图标。会输出 `build/icon.ico`（7 档：16~256）、`icon.png`，
以及 `icon-sizes.png` 对照条。**验收图标一定要看这条对照条**，只看大图容易误判小尺寸下的辨识度。

## 已有功能清单

**游戏库**
- 自动扫描：Steam、Epic、战网（国服/国际可指定路径）、育碧 Connect、Xbox / Game Pass（含 MSIX 包，以 `MicrosoftGame.config` 判定，避免混入非游戏）
- **扫描时机：只在应用启动（重启）时全平台扫描一次**。之后的改设置、改配置、隐藏、
  添加游戏、中文化完成等操作只做毫秒级的「合并刷新」，不再触碰注册表 / 磁盘 / Appx。
  「⟳ 刷新」按钮是唯一的手动全量扫描入口；改扫描开关后重启（或点 ⟳）生效
- Steam 库归一化：自动合并「注册表 SteamPath」与 `libraryfolders.vdf` 里同一目录的不同写法（双反斜杠 vs 正斜杠）
- Xbox 双形态去重：同一款游戏同时存在于 `XboxGames` 目录与 WindowsApps MSIX 包时，按名称归一化（去标点/空格/大小写）只保留一张卡
- 战网双来源扫描：老客户端的 `LaunchOptions` 注册表 + **卸载表**（国服/新版客户端不写前者，
  卸载表条目如 `Uninstall\Hearthstone → DisplayName=炉石传说` 也能识别，自动映射回战网产品码）
- 扫描结果按 id 去重（手动添加与自动扫描撞同一 id 也只保留一份）
- 手动添加、按文件夹批量扫描导入、隐藏 / 删除游戏
- 启动参数支持「预设」与「启动时询问」两种模式；**手动添加弹窗里也可以直接填**（见下）；
  **Steam 游戏还能与 Steam 自带的启动项双向同步**（见下）

**模拟器游戏（1.2.12）**
- 手动添加时多了「启动参数」输入框，**模拟器游戏**就靠它接入：
  - 「可执行文件」选**模拟器本体**（如 `D:\rpcs3\rpcs3.exe`），「启动参数」填**这一款游戏**的参数
  - 例（RPCS3 / PS3）：`--no-gui "%RPCS3_GAMEID%:BCAS20097"` —— 效果等同桌面上那个快捷方式，启动即直接进游戏
  - 同理适用于 Yuzu / Ryujinx（`-f "<游戏路径>"`）、PCSX2、Dolphin、DuckStation 等任何「模拟器 + 游戏文件 / 游戏ID」的用法
- 参数**原样**传给模拟器（直接 `spawn`，**不经 cmd**），所以 `%RPCS3_GAMEID%` 这类占位符不会被 shell 展开成空串
- 同一个模拟器下的多款游戏各存各的参数，互不干扰；游玩时长按「启动的是哪一款」记账，不会串台
- 顺带修掉一个更早就埋下的坑：**「有 exe 直接启动」这条路径原本会把自定义启动参数静默丢掉**
  （`chooseLaunch` 把 `args` 塞进了 `opts`，而 `launchGame` 取的是顶层 `choice.args`），
  提权启动（`cmd start`）那条路同样没带参数；两处一并修好，普通游戏的「启动选项」才真正生效

**Steam 启动项双向同步（1.2.13）**
- 管理弹窗「启动」分页的**启动选项**与 Steam 自带的启动项互通了（这一块只对 Steam 游戏显示）：
  - **读**：打开管理弹窗即显示 Steam 里当前的值（`Steam 启动项：…`）；
    点「⇩ 读取 Steam 启动项」可一键把 Steam 侧的值填进输入框
  - **写**：勾上「保存时同时写入 Steam 自带的「启动选项」」再保存，参数会写进
    `userdata\<账号>\config\localconfig.vdf` 的 `apps\<appid>\LaunchOptions` ——
    也就是 Steam 里「属性 → 启动选项」那一栏
- 写入**只动 `LaunchOptions` 这一行**，文件其余内容逐字节保留；写入前自动备份
  `localconfig.vdf.glbak`（同目录，写坏了可手工恢复）；同值重复保存不写盘（幂等）
- **Steam 正在运行时会提示「重启 Steam 后生效」**：Steam 退出时会用内存里的状态回写这个文件，
  运行期间写进去的启动项可能被覆盖 —— 要立刻生效就先退出 Steam 再点保存
- 清空输入框后保存 = 同时清掉 Steam 侧的启动项（删掉那一行）
- `%command%` 语义已处理：Steam 启动项形如 `gamemoderun %command% -dx11` 时，管家只取
  `%command%` 后面的参数（占位符不是参数，不能塞给游戏 exe）；写回时保留 `gamemoderun` 这类包装命令
- 多账号：读的时候以当前登录账号（注册表 `ActiveUser`）为准，写也是写到这个账号的配置里

**DLC 管理（1.2.15）**
- 详情页只显示一个「🧩 DLC 管理」按钮（带「已装 x/y」统计），**点开才展开明细列表**，不点不占版面
- 自动按平台查询该游戏的 DLC 情况：
  - **Steam**：读本地 `appmanifest_<appid>.acf` 的 `InstalledDepots.dlcappid`（已装信号）
    ∩ 商店 API 的 `data.dlc` 全量清单（未装清单），再用 `IStoreBrowseService` 批量取中文名；
    **不在商店清单里的 dlcappid**（免费 / 已下架）也按「已安装」显示，不会漏报
  - **Epic**：扫 `C:\ProgramData\Epic\...\Manifests\*.item`，DLC 是独立 `.item` 文件，
    `AppCategories` 含 `"dlc"` 且 `MainGameAppName` 等于本体 `AppName` 即视为该游戏的 DLC
  - **非 Steam 平台但填了 Steam appid**（Epic / 战网 / 育碧 / Xbox / 手动游戏）：按该 appid 拉取商店的
    **全部 DLC 清单**，默认都没有，由主人自己勾选已拥有的那几项（勾选徽标显示「已有 / 未有」）
  - **既没 appid 也不是 Steam/Epic**：不支持自动检测，提示去「管理」里填 appid，或直接用在线搜索核对
- **DLC 资料本地保存，不每次联网**：联网拿到的清单 + 中文名按 appid 落盘到
  `userData/dlc-cache.json`，之后打开详情页只读缓存（零联网）；点「↻ 更新」才联网重下并覆盖缓存；
  超过 7 天会自动更新一次；联网失败时**保留上次缓存**（不会被清空），更新失败的提示会写在状态行
- **手动标记**：明细里每行可勾选，勾选即覆盖自动检测结果并落盘（存到该游戏配置的 `dlcManual`），
  下次打开自动合并显示；取消勾选可回到自动检测
- **在线搜索**：点「🔍 在线搜索 DLC」用游戏名在 `https://h.juij.fun/search/?keyword=<游戏名>`
  检索（游戏名经 URL 编码），在新浏览器标签打开
- **回归测试**：`npm run check:dlc`（真实 Electron 渲染，14 项：折叠显隐 / 缓存文案 / force 更新 /
  非 Steam appid 徽标 / 勾选落盘 / 搜索链接），逻辑层另有 `npm run smoke` 的 DLC 用例（缓存往返、force 兜底、appid 通道）

**内存占用**
- 单实例锁：重复启动只是把已有窗口带回前台，不会开第二个实例翻倍内存
- V8 堆上限 512MB + 暴露 `global.gc()`：启动游戏后主动回收；封面 `loading=lazy` +
  卡片 `content-visibility:auto`，视口外的卡片不参与渲染、不常驻解码位图
- 启动游戏后自动释放内存（卸图片 / 清会话缓存 / GC，可在设置关闭）并最小化窗口
- 最小化 / 隐藏到后台：自动清会话缓存 + GC，只保留必要资源；页面不可见时渲染层也主动 GC

**展示**
- 大屏沉浸模式 / 桌面模式双切换
- 自定义封面、大背景、徽标；支持本地图片或 SteamGridDB 在线选图（需自填免费 API Key）
- **自定义封面入口在游戏「管理」弹窗**：本地图片拷入资源目录持久化，卡片/详情页/主页背景立即生效；
  战网 / 育碧等无 appid 的游戏拿不到在线封面，用这里指定；可一键清除恢复默认
- 后台自动把英文游戏名换成中文，并补全缺失图片（网络恢复后自动重试，不会把失败结果永久缓存）
- 游戏详情页「手柄支持」标识：完整 / 部分 / 不支持，取自 Steam 商店 controller_support 字段并随信息库缓存；非 Steam 游戏无数据源则不显示

**Steam appid 补资料（1.2.2 修）**
- **appid 只影响资料**（中文名 / 封面 / 背景 / 徽标 / 手柄支持档位），**绝不影响启动方式**：
  Epic / 战网 / 育碧 / Xbox / 手动添加的游戏填了 appid 之后，仍走各自的官方启动路径，
  不会被改成 Steam 启动（启动只看 `executable` / `launchCommand` / `platform`，见 `launcher.chooseLaunch`）
- **多候选图源**，逐个校验、第一个成功才采用（原先只试一条直链，老游戏必然补不上）：
  - 封面：`library_600x900_2x` → `library_600x900` → `capsule_616x353` → 商店大图 → 官方头图 → 截图 → `header`
  - 背景：`library_hero` → 商店大图(`storepagebackground`) → 1080p 截图 → `page_bg_raw` → 横版兜底
  - 徽标：CDN `logo.png` / `logo_2x.png`（**不配 SteamGridDB Key 也能拿到**）
  - 两个 CDN 域名（cloudflare / akamai）都试；实测老游戏只有横版图时会退化为横版裁切，并在界面如实说明
- **同一次商店请求多拿三样东西**：手柄支持档位 + 官方图片地址（`header_image` / `background_raw` / `screenshots`），不额外联网
- **失败会重试而不是永久跳过**：区分「服务器明确回 404（确实没有，记住不再问）」与「连不上（暂态，下次再试）」；
  旧版留下的"库里只有远程链接、本地没图"的记录会在下次启动后台自动重抓一次
- **中文名走美区**（`cc=us&l=schinese`）再补国区：国区对未发行/已下架条目直接 `success:false`，
  拿不到中文标题（实例：育碧版《看门狗》appid 243470）
- **按真实格式修正图片扩展名**：图床会用 `.jpg` 后缀返回 WebP/PNG，名不副实会让 Chromium 显示破图，
  落盘后按文件头改名（`.webp` / `.png`）
- 查询结果如实回报缺什么（`missing`）：拿不到的会提示「Steam 上没有这张图，可指定本地图片或配置 SteamGridDB Key」，而不是一律弹「已补全」

**弹窗分页（1.2.3）**
- 「管理」与「设置」选项太多，改为**按用途分页**，一次只看一类，不再全部堆在一个长页里
  - 管理：**资料**（appid / 显示名称）· **图片**（封面 / 背景，封面预览与说明并排）· **启动**（音频通道 / 修改器 / 启动顺序 / 延迟 / 启动参数）· **存档**
  - 设置：**常规**（开机自启 / 启动后释放内存 / 最小化 / 恢复大屏 / 内存占用）· **平台与扫描**（平台先行 / 就绪等待 / 战网路径 / 6 项扫描开关）· **音频**（默认通道 / 按游戏切换）· **资料**（SteamGridDB Key / 图片本地缓存 / 信息库统计）· **已隐藏**
- 交互：标题与分页条固定、只有内容区滚动、底部「保存」始终可见；分页会**记住上次停留的位置**
- 分页可用**键盘 ←/→**、**手柄方向键 / LB·RB / 左摇杆**切换（弹窗打开时不再误操作底层网格）
- 字段 id、读写逻辑、IPC 通道全部不变，`check:ui` 里新增「字段必须落在某个分页内」的断言防止回退

**启动**
- 启动前检测平台客户端，未运行则先拉起平台，再**等客户端就绪**（默认 15 秒，设置里可调 5~120 秒）后启动游戏 —— 「宁可多等，一次成功」，不做启动失败后的自动重试
- **平台游戏走平台官方启动方式**，由客户端接管启动（Playnite 同款）：
  - Epic → `com.epicgames.launcher://apps/<CatalogNamespace>%3A<CatalogItemId>%3A<AppName>?action=launch&silent=true`（三段式，`%3A` 是编码后的冒号）。**顺序必须是 命名空间 : Cid : AppName**；写反（AppName 在前）会被 Epic 报 `Application Not Owned`，报错里那串就是命名空间
  - 战网 → `"<Battle.net.exe>" --exec="launch <产品代码>"`（`WTCG`=炉石、`WoW`=魔兽、`D3`=暗黑3、`Pro`=守望、`S2`=星际2…）。`battlenet://<代码>` 协议在国服客户端只唤起/登录、**不启动游戏**，故仅作找不到客户端时的兜底
  - 育碧 → `uplay://launch/<id>/0`
  流程是「唤起/调用客户端 → 客户端完成登录与 DRM 校验 → 客户端拉起游戏本体」，兼容 DLC / 云存档 / 成就 / 反作弊；直接 spawn 游戏 exe 会被判定为「无有效会话」而启动后自退，故不再使用
- **战网的 `--exec` 命令拆开直接 spawn**（`Battle.net.exe` + 单个 argv `--exec=launch WTCG`），不过 cmd，避免嵌套引号解析
- **URI 由系统 shell 打开**：优先用 Electron `shell.openExternal`（走 Windows ShellExecute，不经过 cmd）；仅在不支持时退回 `cmd /d /c start "" "<uri>"` —— 注意标题占位必须是**字面量 `""`**，若写成空字符串，`start` 会把 URI 当成窗口标题，只弹出一个空控制台窗口而游戏不启动
- 修改器联动启动，可设启动顺序与延迟
- **游戏结束修改器一起关**（1.2.16 起）：游戏进程退出（含被新游戏顶替）时，按修改器的完整可执行路径用
  WMI 终止它，不留残留进程。精确对应本游戏的修改器，不会误杀其它同名修改器。
- **管家回归普通权限 + 原生自启（1.2.21）**：v1.2.17–1.2.20 曾默认管理员（`requireAdministrator`）+ 装进 Program Files，
  想靠高权限关被 UAC 提权的修改器；但 `requireAdministrator` 清单会让登录自启弹 UAC / 被静默拦，表现为「无法开机自启动」，
  改用任务计划程序（`/RL HIGHEST`）仍不够稳。应你的要求，1.2.21 **回归普通权限（`asInvoker`）+ 用户级安装**，
  开机自启用回 Electron 原生 `app.setLoginItemSettings`（写 HKCU Run 登录项，登录时静默拉起、不弹 UAC——最朴素最可靠），
  启动时会顺手 `schtasks /Delete GameLauncherAutoStart /F` 清掉残留的旧任务计划任务（`src/autostart.js` 模块已删除）。
  代价：游戏结束自动关修改器时，若修改器被 UAC 提权成管理员，普通权限管家关不掉（IL 隔离），这种你手动关一下即可；
  普通权限运行的修改器仍会被 1.2.19 的 UTF-8 + `taskkill /PID` 方案自动关掉。
- **需要管理员权限的程序会自动提权**（1.2.4）：不少修改器（风灵月影等）的清单里写着 `requireAdministrator`，
  直接 `spawn` 会被系统拒绝（EACCES / `ERROR_ELEVATION_REQUIRED`），表现为「修改器根本起不来」。
  现在会先读 exe 清单预检，命中就改走 `cmd /d /c start "" /d "<cwd>" "<exe>"`（ShellExecute 路径），
  由 Windows 按清单提权 —— 跟双击该程序完全等价；运行中被系统拒绝（EACCES/EPERM）也会自动重试这条路。
  游戏本体同样如此（少数带反作弊的单机也要求管理员）
- **任何 spawn 失败都不再崩主进程**（1.2.4）：`spawn` 失败是以 `error` **事件**异步抛出的，
  没有监听器就会被 Node 升级成未捕获异常 —— 在 Electron 里就是红色「A JavaScript error occurred in
  the main process」弹窗，管家直接不可用。现在每个子进程都挂 `attachGuard`，另有一层全局
  `uncaughtException` 兜底（记日志 + 界面提示），启动失败只会如实告诉用户原因
- 启动后按设置释放内存（卸图片、清会话缓存、强制 GC）并最小化窗口，把资源让给游戏
- **游戏窗口出现后自动切到最前端**（1.2.5，设置「常规」里可关）：游戏启动往往比修改器慢，
  平台客户端游戏还要先过登录 / DRM / 更新，等游戏窗口终于出现时已经被压在后面，得手动点任务栏
  - 启动游戏后另起一个**隐藏的帮助进程**去等：普通游戏最多等 2 分钟，平台客户端游戏（Steam/Epic/战网/育碧/Xbox）**最多 4 分钟**
  - 窗口一出现就激活，随后 20 秒**守卫期**内若被别的窗口（延迟启动的修改器、平台提示窗）抢走，会自动拉回来（最多 6 次）
  - 只激活、**不把游戏窗口强制置顶霸屏**（置顶会盖住任务栏，想切出去看攻略都切不了）
  - 实现细节与踩坑见 `src/winfocus.js`：脚本用 `-EncodedCommand` 整段传入（不落盘、不受执行策略影响），
    激活做成**阶梯式**（`AttachThreadInput + SetForegroundWindow` 在本机实测无效，要靠 `BringWindowToTop` /
    `SwitchToThisWindow` / 无害 ALT 按键兜底），且**以「前台进程真的变成目标进程」判定成功**（API 返回值会骗人）
  - 真机回归测试：`npm run check:focus`（约 20 秒，会短暂弹出两个窗口）
- 游戏进程结束后：窗口自动从最小化恢复、渲染层重建封面网格，并切回大屏模式（设置「游戏结束后恢复大屏模式」可关）
  - 「结束」的判定要经过 4 秒后的二次确认，避免一次采样抖动就把还在跑的游戏当成退出（1.2.1）
  - 从没确认到游戏进程时（大概率是启动失败）只还原音频，**不弹窗口** —— 弹窗会把全屏游戏顶到桌面

**桌面模式（1.2.6 修复）**
- 桌面模式（窗口化 + 左侧列表 + 主区网格）在**窗口较窄或游戏较多**时，主区的封面卡片会互相**堆叠**，鼠标滚轮也滚不动
  - 根因：桌面网格是「定高网格 + 隐式 `auto` 行」。一旦内容超出窗口高度，浏览器会把行轨道**压缩到刚好塞进容器**，
    而卡片仍按 3:4.4 比例算出的高度撑开 → 卡片溢出自己的行、与下一行叠在一起。游戏 ≤10 款（正好两行）时看不出来，
    越多越明显（40 款时行高被压到 57px，而卡片有 320px）
  - 修法：显式 `grid-auto-rows: min-content`，让行高跟随卡片内容（见 `renderer/style.css` 里 `.desktop-mode .grid`）。
    修好后游戏多时可用**鼠标滚轮正常向下滚动**浏览
  - 顶栏改为**单行不换行**：以前窗口变窄（≤1280，默认窗口就是 1280）时 7 个平台筛选按钮会折成 2~4 行，
    把顶栏撑到 100~190px 高、非常难看；现在筛选条改为横向滚动（滚动条隐藏）+ 搜索框可收缩，
    顶栏在所有窗口宽度下都保持一行高

**屏保（1.2.7 新增）**
- 空闲一段时间后自动启动屏保：**轮播已安装游戏的背景图**（封面/背景优先用信息库缓存的本地图）。
  默认空闲 **3 分钟**触发，设置「常规」里可关、可调分钟数（1~120）。
- 触发即把窗口切成一个全屏遮罩，图片**交叉淡入**轮播（每张停留 5 秒），左下角显示游戏名 + 当前时间，
  右下角提示「移动鼠标或按任意键退出屏保」。
- 任意鼠标移动 / 点击 / 按键 / 滚轮 / 触摸立即退出并重新计时。
- 以下情况**暂停计时**，不会弹出屏保：游戏正在运行（`gameRunning` 期间窗口通常已最小化）、
  窗口不可见（被游戏盖住 / 最小化）、有设置 / 管理弹窗打开。
- 没有任何背景图时仍显示一个纯色遮罩 + 提示，移动即退出。
- 实现：独立模块 `renderer/screensaver.js`（无 node 依赖，便于真实渲染层回归），`app.js` 通过
  `Screensaver.init({ getGames, isBlocked, enabled, idleMin })` 注入真实数据，设置保存时 `Screensaver.configure` 实时改开关。
  真实逻辑回归见 `npm run check:screensaver`（4 项：空闲出现 / 移动退出 / 退出后再现 / 轮播推进）。

**图片资源本地化（1.2.10 优化，离线可用）**
- 此前封面/背景默认走 Steam CDN 远程地址，只有「手动补全过 appid 资料」的游戏才有本地缓存；其余几十款游戏在游戏结束重建 / 列表刷新时会几十张重新联网加载，表现为「主界面出来了但图一张张慢慢刷」。
- 改为**扫描即落地、渲染永远走本地**：
  - **后台全量预取**：`enrichInBackground` 不再只处理 3 款 stale，而是遍历所有有 appid 的游戏，凡「本地还缺图」（信息库为 null，或封面/背景不是本地路径——含老数据卡在 Steam CDN 远程链接）的一律后台联网抓取一次，落到 `userData/assets/<gameId>/`（封面 cover.jpg / 背景 background.jpg）。串行 + 150ms 间隔，不挡界面；抓完统一推送 `games:updated`，刚落地的本地图即时替换占位 / 远程图。
  - **合并阶段本地优先**：主进程把游戏信息发给渲染层时，`cover/background/logo` 只接受本地路径（`file://`），远程 URL 一律不交给 `<img>`（宁可先显示「游戏名首字」占位，也不联网）。这样游戏结束重建 / 列表刷新时渲染层只认本地图，彻底不再重新联网加载。
  - `cacheImages` 设置默认开启；关闭后退回「纯远程」行为（不预取）。
- 效果：首次联网把图片抓到本地后，**之后所有界面（含游戏结束重建、列表刷新、屏保轮播）全程离线**，封面/背景/徽标不再消耗网络。已抓过的图标记 `assetV`，下次启动自动跳过、不重复联网。
- 验证：`npm run check:ui` 含「needsLocalImage 全量预取」「合并阶段只渲染本地图」反向断言。

**游戏结束后主界面恢复加速（1.2.9 优化）**
- 此前游戏退出后，主界面从最小化恢复、切回大屏要等约 7~14 秒（轮询间隔 10s + 退出二次确认 4s）。
- 改为**双速率轮询**：启动前置期仍低频轮询（10s，不打扰平台客户端登录），一旦确认游戏进程在跑就把轮询间隔收紧到 3s；退出二次确认从 4s 缩到 2s。
- 游戏退出后主界面恢复的最坏延迟降到约 5 秒、平均约 2.5 秒（提速约 3 倍）。游戏运行期间只跑轻量 `tasklist`，开销可忽略；仍保持「双路信号（进程名 + 安装目录）都 miss 才结算」，不增加误把全屏游戏弹回桌面的风险。
- 真机回归：`npm run check:session`（验证提速后游戏运行期间不会误结算）。

**游戏结束后封面/背景图填充加速（1.2.9 优化）**
- 此前「启动游戏后释放内存」会把整张卡片网格 `grid.innerHTML=''` 清空，游戏结束恢复时 `renderGrid()` 重建——封面默认是 Steam CDN 远程地址，几十张同时重新走网络加载，表现为「主界面出来了但图片一张张慢慢刷」。
- 改为**trim 时保留卡片网格**：只卸掉真正占内存的 hero 全屏大背景 + 管理预览 + 侧栏；卡片封面是小图，对游戏（GB 级）内存影响极小，但留着能让游戏结束恢复时卡片立即可见、不必重载。恢复时只重设 hero 背景、复用已保留的网格（仅网格异常为空才兜底重建）。
- 效果：游戏结束回主界面，封面图**基本秒出**（浏览器已缓存/已解码的位图直接复用），不再一张张从网络拉。内存释放重点仍在 hero 大图（最大块），「释放内存」诉求不受影响。

**游戏攻略（1.2.8 新增）**
- 游戏详情页新增一组「游戏攻略」按钮，点击即用**中文游戏名**打开外部浏览器检索攻略（不影响已启动的游戏）：
  - **📖 图文攻略**：Bing 作用域搜索，限定 3DM / 游民星空 / 游侠网 三大图文攻略站（`site:3dmgame.com OR site:gamersky.com OR site:ali213.net`），一个标签页看遍三站攻略
  - **🎬 视频攻略**：B 站视频搜索（`search.bilibili.com/all?keyword=<游戏名> 全流程攻略`），直达全流程视频
  - **🤖 豆包答疑**：打开网页版豆包（`doubao.com`）对话首页，直接问游戏相关问题（豆包网页版无可靠预填参数，打开即提问）
- 三者 URL 均已实测可返回对应站点的攻略 / 视频 / 对话页；通过 `window.api.openExternal` 调用系统默认浏览器打开。

**存档**
- 自动探测候选存档目录（Steam 云存档 / 我的文档 / AppData / 安装目录），一键打开
- 中文名游戏用英文名去 PCGamingWiki / 搜索引擎在线查存档位置

**游玩时长（1.1.0 新增 / 1.2.11 排序升级）**
- 平台数据优先：解析 Steam 客户端的 `localconfig.vdf`，读出每款游戏的累计时长、近两周时长与最后游玩时间
  （`Playtime` / `Playtime2wks` / `LastPlayed`），跨机器、跨重装都准确
- 本地计时兜底：Epic / 战网 / 育碧 / Xbox 没有可离线读取的时长，改为启动游戏后监视进程，
  进程退出时把本次时长按「会话」累加到本地记录（不足 1 分钟不计），并保留近 14 天窗口用于「近两周常玩」
- 首页排序（5 个席位，同一款游戏不重复占位）：
  第 1 位＝**最后游玩**的游戏；第 2、3 位＝**近两周游玩时长最多**的两款；
  第 4、5 位＝**总游玩时长最多**的两款；其余保持字母序。
  没有任何游玩记录时退化为纯字母序，不会出现莫名顺序
- 卡片/侧栏/详情页都会显示时长，前五名分别带「最近游玩 / 近两周常玩 / 最常玩」标记

**电源菜单（1.1.0 新增）**
- 主界面右上角电源按钮：重启 PC Game Master / 关闭 PC Game Master / 关机
- 关机走系统 `shutdown /s /t 10`，延迟 10 秒执行，期间底部显示倒计时并支持「取消关机」
- 重启与关闭都会先落盘配置；正在运行的游戏不受影响

**音频输出通道（1.1.0 新增，1.2.1 修稳定性）**
- 设置里可选「默认音频输出通道」，并支持一键把系统默认播放设备切过去
- 游戏「管理」里可为单款游戏指定启动音频通道，支持「试听切换」当场验证
- 启动该游戏时自动把系统默认输出切到指定设备，**游戏进程退出后自动切回默认通道**
- **游戏运行期间通道是「粘」的（1.2.1）**：切到桌面、浏览器、系统自己重设默认设备都不会
  把它带走；万一漂走了，守护会在一分钟内切回来（单次会话最多纠正 3 次，之后视为用户有意手动改动）
- **只有「游戏确实退出」才还原默认通道**（1.2.1 修的坑）：旧版把「进程探测没命中」直接当成退出，
  于是 CS2 这类主程序藏在 `…\game\bin\win64\` 深处的游戏，会在开玩几十秒后被误判退出 ——
  表现就是「切到桌面时音频被改回默认」「之后正常退出也不再还原」。现在：候选进程名按目录递归
  3 层推断、安装目录路径核对独立生效、判定退出前要 4 秒后再确认一次；
  从没确认到进程时只还原音频、**不弹窗口**（弹窗会把全屏游戏顶到桌面）
- 技术实现：`IMMDeviceEnumerator` 枚举播放端点 + `IPolicyConfig::SetDefaultEndpoint` 切换，
  由 PowerShell 内联 C# 运行时编译，**不引入任何原生模块或第三方依赖**
- 音频/会话的每一步决策都写进 `%APPDATA%\PC Game Master\logs\pc-game-master.log`，出问题先看这个文件

## 用户数据位置

```
%APPDATA%\PC Game Master\
├─ config.json     设置（含默认音频通道）、游戏配置（含按游戏音频通道）、信息库、
│                  本地游玩时长（playtime）、隐藏列表
├─ assets\<游戏id>\  缓存的封面 / 背景 / 徽标
├─ backgrounds\  images\
└─ logs\pc-game-master.log   诊断日志（会话开始/结束原因、音频切换与守护动作）
```

> Electron 的 userData 取 `productName`，所以这里叫「PC Game Master」（不是包内目录 `pc-game-master`）。
> 卸载重装不会丢配置（打包配置已设 `deleteAppDataOnUninstall: false`）。

## 1.1.0 vs 1.0.0 修复要点

- **重复游戏**：`libraryfolders.vdf` 用 `D:\\...` 双反斜杠、注册表 `SteamPath` 返回 `d:/...` 正斜杠，
  老版本的 `Set` 去重视为两条路径，导致同一库被扫两遍，所有 Steam 游戏出现两份。
  修复点 `src/scanner.js#findSteamLibraries()` 用 `path.resolve` 归一化后再判断，
  `src/main.js#buildAll()` 再加一道按 id 去重兜底。冒烟测试新增两条回归用例。
- **store.init 静默写失败**：补 `mkdirSync -Force userData`，目录缺失时也能持久化。
- **扫描规则（1.1.0 后期）**：全平台扫描收敛为「启动时一次 + ⟳ 手动刷新」，
  其余操作只合并缓存结果——老版本里保存一次设置就重扫全部平台（约 1-2 秒注册表查询）。
- **内存优化（1.1.0 后期）**：单实例锁、V8 堆上限、卡片 `content-visibility`、
  最小化/后台自动清缓存与 GC、启动预热完成后释放临时缓存。
