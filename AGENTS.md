# AGENTS.md — dsh-mol-structure

面向 AI 代理/新协作者的项目说明。本项目是一个 **DeepSeek Harness (dsh) 第三方插件**：
宿主半身（`index.js` + `host/`）在右侧边栏挂载本地 **Mol\***（npm `molstar`，v5）结构查看器、
注册 `mol_*` agent 工具并支持自热重载；浏览器半身（`client.js`）注册右侧边栏页签；
查看器页面（Vite app）既是插件内嵌视图，也可独立运行，并内置
Kato *et al.*, *Nat Commun* 13, 6719 (2022) IscB–ωRNA（PDB **7XHT**）与
Zhang 2020 Cas12i（**6W5C**）共 18 个论文复现面板。

插件制作规范（dsh 源码研读结论，勿再重新摸索）：
- 包声明：`package.json` 里 `dsh.bundle.patch` → `cordis.patch.yml`（一行 `insert`，id `mol-structure`、
  name 为裸包名 `dsh-mol-structure`）；`dsh.client: { platform: 'web', immediately: true, inject: [] }`
  声明浏览器半身，`exports['./client']` 指向 client.js。
- client.js 是手写 ModuleLoader bundle：`window.__ModuleLoader__.load({ id: 'dsh-mol-structure',
  factory: (require) => { … return module.exports } })`，导出 cordis 插件三元组
  `name` / `inject` / `apply(ctx)`；require 可取模块表（react、`@deepseek-ai/dsh-client-ui-slots` 等）。
- 右侧边栏页签 = 两处注册：`ctx.sidebarRightTabs.register({ id, kind, title, guide, keepMounted })`
  （id 必须全局唯一，用包名）+ `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: <同 id> }, BodyComponent))`。Body 组件拿到框架注入的
  `useTabInfo()`。参考 `packages/client/ui-sidebar-browser` 与 `docs/subsystems/sidebar-right.md`。
- **零 `@deepseek-ai/*` 运行时依赖**（duck-typing，同 our-free-model / whale-pet）：工具注册用
  普通对象 `{ name, description, parameters(JSON Schema), output: { schema, render }, execute }`，
  `ctx.tools.register` 不做 instanceof 检查；args 校验自己做（defineTool 的校验不覆盖鸭子类型注册）。
- HTTP 路由：`ctx.inject(['webServer'], …)` 里 `webServer.register({ kind: 'prefix'|'exact', path, handler })`，
  最长前缀分发——插件前缀比内核 `/api` 长，会绕过 connection 鉴权，**必须自建信任围栏**
  （`host/trust.js`：connection 服务 `admit/requestRejection` 优先，缺失时退回结构化围栏）。
- 热重载：内核 HMR 无"立即重载"API，`host/reload.js` 镜像其 partialReload 序列
  （loadCache 清除 → 重导入 → dispose 旧 fibers → 同 config 重注册 → 失败回滚）。

## 项目布局

```
dsh-mol-structure/
├── AGENTS.md                  ← 本文件
├── SOP.md                     ← 标准操作流程（复现任何论文图的完整步骤）
├── README.md                  ← 快速开始 + 插件安装
├── package.json               ← 插件清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml           ← bundle patch：insert 一行挂载宿主半身
├── index.js                   ← 宿主半身入口：apply(ctx, config)，挂路由/工具/热重载
├── client.js                  ← 浏览器半身：手写 ModuleLoader bundle，右侧边栏页签
├── icon.svg                   ← 插件图标（原子标记）
├── index.html + vite.config.js← 查看器页面骨架（base './'，任意前缀下可用）
├── host/                      ← 宿主半身模块（零 @deepseek-ai/* 依赖）
│   ├── panels.js              ← 自定义视图注册表（agent 工具与 /command 共用校验）
│   ├── trust.js               ← 请求信任围栏（connection 桥 + 结构化围栏）
│   ├── push.js                ← SSE 推送枢纽（命令下行 / hello / 心跳注释帧）
│   ├── state.js               ← viewer 真相（liveness/selection）+ 命令配对（submit/resolve/超时）
│   ├── static.js              ← dist/ 静态服务（etag、防穿越、no-cache）
│   ├── tools.js               ← 22 个 mol_* 工具定义 + 结构文件缓存（load token）+ op 白名单
│   ├── reload.js              ← 自热重载（loadCache 清除/重注册/回滚）+ 目录监视
│   └── updater.js             ← 插件内自升级（GitHub 清单 SHA-256 校验/备份/换文件/回滚）
├── src/
│   ├── main.js                ← bootstrap、面板切换、相机、H-bond 线、选择上报、bridge 安装
│   ├── bridge.js              ← 与宿主的桥：SSE 命令下行，status/selection/result 上行
│   │                            （独立运行时自动降级为 no-op）
│   ├── commands.js            ← 命令实现（figure/scene/camera/labels/hbonds/measure/
│   │                            select/query/screenshot…）+ describeElementLoci
│   ├── config.js              ← PAPERS 汇总 + 扁平 FIGURES（含 paperId）
│   ├── papers/iscb.js         ← Paper ①: IscB–ωRNA (7XHT) 全部面板
│   ├── papers/cas12i.js       ← Paper ②: Cas12i (6W5C) 全部面板
│   ├── helpers.js             ← dom/stick/mg/pill/text/marker/num 构造器
│   ├── scenes.js              ← 通用场景构建（groups 渲染）、residueLoci、canonicalLoci
│   └── labels.js              ← HTML overlay 标签系统（3D 锚点投影）
├── scripts/host-smoke.mjs     ← 宿主半身冒烟测试（mock 上下文，无需 dsh）
├── scripts/bridge-e2e.mjs     ← 端到端桥测试（mock harness + 真实浏览器跑全部工具）
├── tools/make_anchors.py      ← 锚点生成器：PAPERS 配置 + argv 选论文
├── tools/capture-panels.mjs   ← Playwright 无头批量截图（自动发现 [data-figures]，
│                                每面板输出 page 版含标签 + canvas 版纯 WebGL）
├── tools/check_panels.py      ← 截图程序化检查（唯一性/前景占比/预期色簇）
├── dist/                      ← vite 产物 + 静态资产（插件静态服务的根，必须随包分发）
│   ├── molstar.css            ← 从 node_modules/molstar/build/viewer/molstar.css 拷贝
│   ├── structures/
│   │   ├── 7xht.cif / 6w5c.cif / 4un3.cif / 4oo8.cif   ← RCSB 结构文件（离线使用）
│   │   └── label-anchors-<paper>.json       ← 生成的锚点（iscb 141 / cas12i 57）
│   └── assets/                ← vite 构建产物（tools/prebuild-clean.mjs 只清这部分）
├── reference/                 ← 论文原文 + pdf-pages/*.png 高清裁剪（视觉对照基准）
└── docs/screenshots/
    ├── final/                 ← 权威成图（npm run capture 生成：18 面板 × page/canvas）
    └── iterations/            ← 校准过程历史截图（含早期 Cas12i 探索，勿作基准）
```

## 桥接协议（宿主 ↔ 查看器页面）

宿主无法直接触达浏览器页面，唯一通道是 SSE 下行 + HTTP 上行：

- 下行：`GET /api/mol-structure/events`（SSE）。`hello` 携带 `{version, gen, appRev}`；
  `command` 事件携带 `{id, op, args}`；`panel` 事件由 client.js 消费（打开侧栏页签）。
- 下行（续）：`panels` 事件携带完整自定义面板清单，查看器据此渲染控制卡的
  「自定义视图」按钮组并镜像到 `ctx.customPanels`（`figure` op 对内置/自定义一视同仁）。
- 上行：`POST /status`（心跳 + figure/structure，同时回传 gen/appRev 供页面自检重载）、
  `POST /selection`（用户点选/选择，250ms 防抖；agent 设定走同一入口，`source` 区分）、
  `POST /command`（**开放接口**：本机任意程序用与 agent 工具相同的命令词汇驱动查看器；
  host ops `panelDefine/panelRemove/load(path)` 在宿主处理，其余转发；`figure` 同时接受
  `figure`/`id` 参数名）、`POST /result`（`{id, ok, result|error}`，配对 state.js 里的 pending 命令，截图数据
  也走这里，上限 64MB）、`GET /state`（宿主真相快照）、`GET /load/<token>`（工具读入的
  结构文件一次性下载）、`POST /reload`（触发热重载）。
- 控制卡（视图控制卡，2026-11 重构）：卡片只含通用控件——「总览/背面/俯视/中心特写/
  自动适配」预设视图（按当前包围球实时计算，任何结构都可用）、「自定义视图」组
  （mol_panel_define 注册/修改）与 Rotate/Export；**论文复现面板默认隐藏**，仅当当前
  结构是 7xht/6w5c（或显示论文面板）时出现。开机**不自动加载任何示例**，状态为 ready。
  ☰ chip 与卡片同在**右下角**：card 固定在 chip 上方（`right:12px; bottom:44px`），
  卡片标题栏右侧带 **×** 关闭按钮（与 chip 同一 collapsed 状态），不再出现“开关在右下、
  面板在左上”的割裂感；不再遮挡 Mol* 原生控件。`mol_load` 后自动适配取景；
  figure 命名跟随实际内容（`<文件名> · 原始结构 / 自定义视图 / <面板标题>（自定义视图）`），
  不再出现内置面板 id。
- 主动注册视图（2026-11）：`mol_load` 成功后宿主自动跑 viewer 的 `interfaces` op（逐链对
  重原子接触统计，默认 <4.5 Å + 极性对 <3.6 Å），并注册 1 个 `auto-overview` + 至多
  `maxViews` 个 `auto-iface-<A><B>` 面板（淡 cartoon + 界面侧链 stick + 极性线 + 热点标签，
  focus 落在最强热点残基），随即 `push.emit('panels')`。**所有外观都是接口参数**，改样式
  不需要改源码：`palette`（链色）、`sideChainColors`（按链覆盖侧链色）、`hbondColor`、
  `closeup`、`maxViews`、`overview`、`labelsPerSide`、`titleTemplate`/`labelTemplate`
  （`{a}{b}{comp}{seq}{contacts}` 占位）、`cutoff`/`polarCutoff`、`baseColor`（load 的
  基础 cartoon 色）。`mol_load` 接受这些参数一次成型；`mol_autoviews` 对**已加载结构**
  重新生成（可 `apply` 指定视图），不重载、不改码。面板本身仍可用 `mol_panel_define`
  /`mol_scene`/`mol_labels`/`mol_hbonds` 的 `color`/`bg`/`color` 逐项覆盖。
  自动面板在下一次生成时先移除再重建。`mol_load` 返回值带 `autoViews`。
- 相机近距离特写：`focus {radius}` 在 scene 构建后会被 Mol* 自动构图覆盖，`applyCamera`
  现于 500/1100 ms 各重设一次（并检查 `ctx.sceneBuilding`）；`focusOn` 走**轨道 zoom 路径**
  （zoom = 1/倍率，0.3 ≈ 3.3× 特写，1.6 默认），包围半径由坐标范围直接计算（Mol* 的
  Loci boundary 对多链结构给过 254 Å 的离谱值）。
- 视角中心（2026-11）：`focus`/`applyView` 会把 target 记为 **pin**；canvas `pointerdown`
  时快照相机状态，**空白点击**（无 loci）时恢复该快照——Mol* 默认的“空点名回结构中心”
  不再毁掉界面特写（e2e 断言 target 漂移 <0.5 Å）。手动改中心：**Shift+点击残基**，
  或卡片「点击定中心」（拾取模式，点一个残基即重设中心且保持缩放），「回到结构中心」回全结构。
  代码钩子：`window.__molApi.setCameraPin/recenterOn/setPickCenter/cameraCenter`。
- 后台渲染：页签不可见时 rAF 冻结，查看器以 1s **同步** `canvas3d.tick(now,
  {isSynchronous:true})` 看门狗维持画布新鲜（`requestDraw` 只设标记、依赖 rAF，隐藏时不会画），
  `mol_screenshot` 截图前同样强制同步渲染一帧——后台页签也能渲染和出图。
  切回前台（visibilitychange→visible）立即 forceDraw 一次；`webglcontextrestored` 时重绘并重载视图。
  卡片「重载视图」按钮：按 `lastRender`（最近一次 figure/scene 请求，bridge 命令与自定义视图
  按钮都会记录）重建当前视图并重设 pin 中心，解决“从后台切回画面空白”——e2e 有断言。
  前后台相机重设定时器必须检查 `ctx.sceneBuilding`（scene 构建期间 setState 会破坏
  状态事务，症状 "reading 'ref'" / "reading 'entry'"）。
- 标注（2026-11 重构）：agent 动态标签（mol_labels，无 `centered` 标记）用**引线样式**——
  锚点 6px 圆点 + 1.5px 细引线 + 外侧紧凑 chip（默认向右上偏移 46/-34px），不压住结构；
  update() 每帧做**碰撞避让**（与已放置 chip 重叠时 dy += 17 下移，最多 14 次，引线角随动）。
  论文面板标签（applyFigure 传 `centered: true`）保持居中渲染，校准构图不变。
  控制卡「标签：开/关」按钮一键隐藏全部标注（`labels.setVisible`）。
  标签只画在 HTML 层，`mol_screenshot` 的 PNG 不含标签；带标签成图用整页截图。
- 查看器页面只有被插件路由服务（pathname 以 `/api/mol-structure/` 开头）时才启用桥；
  `npm run dev` 独立运行时全部 no-op。`appRev`（dist/index.html mtime+size）变化 → 页面
  自动 location.reload()；宿主 gen 变化（热重载完成）→ SSE 断开重连后同样自动重载。

## v0.4 — 文档对齐 + 完整 Mol* 模式（2026-11，对照 molstar.org/docs/v5 全量审计）

- **完整 Mol* 模式**（类似 molstar.org/viewer）：控制卡「完整 Mol*」按钮 / `mol_mode` 工具
  切换。实现是**重启页面**：`localStorage['mol-structure:mode']` 记录选择，`Viewer.create`
  的 `layoutShow*`/`viewportShow*` 旗标按模式取值（full = 左侧控制树 + 序列 + 日志 + 截图/
  动画工具栏）。简洁模式下空白点击仍恢复相机 pin；完整模式尊重 Mol* 原生行为（不拦截）。
  宿主 Settings → `defaultMode`（simple/full，settings.json + bundle config 覆盖）经 hello
  `ui.mode` 下发，仅在用户从未显式选择时生效一次。
- **新增 agent 工具**（viewer ops 同名，全部经 `POST /command` 可用）：
  - `mol_style`（op `style`）：在**当前结构**上叠一层可选表征（chain+seqs 或 comp 配体），
    同 `tag` 替换旧层；focus 选项即相机跟随。
  - `mol_focus`（op `focus`）：Mol* focus manager（ball-and-stick 特写 + 非共价相互作用圈），
    `clear: true` 复位。
  - `mol_align`（op `align`）：Cα 最小二乘叠合（残基按序配对），返回 RMSD + 4×4 矩阵，
    `apply: true` 经 `TransformStructureConformation` 变换场景。
  - `mol_structconn`（op `structconn`）：wwPDB struct_conn 扩展——list/show(id)/clear，
    mmCIF 的沉积相互作用（H-bond/盐桥/二硫/金属配位）。
  - `mol_canvas`（op `canvas`）：`PluginCommands.Canvas3D.SetSettings` 设视口背景色。
  - `mol_state`（op `stateSave`/`stateLoad`）：`plugin.state.data.getSnapshot()/setSnapshot()`
    全状态 JSON 存取（存 `$DSH_HOME/mol-structure/states/`）；恢复后 generic-op structure
    从 hierarchy **懒重绑**（见陷阱 30）。
  - `mol_export`（op `export`）：`CifWriter.createEncoder()` + `encode_mmCIF_categories`
    导出 mmCIF 文本（存 `$DSH_HOME/mol-structure/exports/`）。
  - `mol_mode`（op `mode`）：完整/简洁模式切换（页面重载，op 先回执再 reload）。
- **动作面板**：`mol_panel_define { kind:'action', actions:[{label,op,args},…] }` 注册
  **op 链宏**，渲染在控制卡「自定义操作」行，`mol_figure {id}` / `/command figure` 顺序执行
  其 op 链——agent 可自定义的快捷控件（与「自定义视图」并列）。
- **文件格式**：`mol_load` 支持 cif/mmcif/mcif/bcif(binary)/pdb/ent/pdbqt/pqr/gro/xyz/mol/
  sdf/sd/mol2（`formatFromName` → `plugin.dataFormats` 的 provider id）；`.bcif` 走
  `isBinary: true` 下载。
- **设置**（Settings → General，宿主 settings.json，bundle config 可覆盖）：`controlCard`
  （原有）+ `defaultMode`（simple/full）。client.js 的设置行渲染两组分段控件。

**加一篇新论文的完整步骤**（实测：Cas12i 用了约半天）：SOP.md §8.0。
改 config 的论文模块后必须同步 AGENTS.md/SOP.md 对应表。

## v0.5 — 检查更新 + 插件内自升级（2026-11，参考 dsh-our-free-model 的 updater）

- **更新通道**：`host/updater.js`（PluginUpdater）。更新源固定为
  `Masterchiefm/dsh-mol-structure` 的 `feed/manifest.json`
  （raw main/master + jsDelivr 镜像；可变 ref 先经 GitHub API 钉到完整 commit SHA，
  防止镜像间快照漂移）。清单列全部发布文件（path/size/sha256，≤200 文件、单文件 ≤12MB，
  dist 大包按此放宽）。**无签名验证**（2026-11-05 按用户要求移除）：信任锚是清单内的
  SHA-256 pin + 固定 https 源；`stableStringify` 仅为工具保留。publishedAt 用 ms 数字。
- **升级事务**：download → 校验 → stage → backupPackage（$DSH_HOME/mol-structure/rollback）
  → 原子换文件（`*.dms-new` 同卷 rename + Windows EPERM 重试）→ verifyInstalled →
  activate（selfReload + expectedVersion）→ 失败自动回滚并把 recovery 状态落盘
  （upgrade-state.json + updates.json 历史）；recoveryRequired 时 /reload 会被 409 拒绝。
- **接线**（index.js）：settings `updateCheckHours`（默认 6，0=关；bundle config
  `updateCheck: false` 整体停用，测试用）+ `updateNotifiedFor`（每版本只提醒一次）；
  启动 15s 后首查 + 每小时 tick 判到期；SSE 推 `update` / `upgraded` 事件
  （`mol-structure.pending-upgrade` symbol 让后继代际发完成通知）。
  路由：`GET /update`（状态）、`POST /update/check`、`POST /update/apply`。
- **浏览器半身**（client.js）：设置行新增「自动检查更新」分段（6h/每天/每周/关闭）+
  「检查更新」按钮 + 有新版本时的更新横幅（「立即更新并重载」带确认）。
- **发版**：改码 → bump package.json + index.js version → `npm run build`（改 src/ 时）
  → `npm run manifest`（= `node tools/build-manifest.mjs`，无签名）→ 提交推送
  （含 `feed/manifest.json`）。
  `npm run check` 里的 updater-smoke 会校验 feed/manifest.json 与工作副本一致。

## 已复现面板

**Paper ① — IscB–ωRNA (7XHT, Kato 2022)**，定义在 `src/papers/iscb.js`：

| 面板 | 论文图 | 内容 |
|---|---|---|
| fig1b | Fig. 1b | 三色 ribbon + 5'/3' 圆点标记 |
| fig1c / fig1cBack | Fig. 1c | 域色 surface ±180°，TAM 紫色 surface 高亮 |
| fig2 | Fig. 2 | 蛋白单独 cartoon + 催化残基/PLMP motif stick + HNH 虚线圆 + α/β 二级结构编号（红/蓝，来自沉积 HELIX/SHEET 记录） |
| fig3bA / fig3bB | Fig. 3b | ωRNA 按 stem 七色分区 ±140° |
| fig3c | Fig. 3c | nexus pseudoknot 特写（红色 ribbon + 全原子 stick + 核苷酸标签） |
| fig4a / fig4aBack | Fig. 4a | 蛋白 surface + 全红 ωRNA ribbon + SL/CS/GAH/NPKH/NPKS/LNK/TH1/TH2 红 pill ±180° |
| fig4c | Fig. 4c | seed 区：guide 全原子 stick + BH/RuvC Arg 簇 stick + 核苷酸编号 + H-bond 线 |
| fig4d | Fig. 4d | NPKH 特写：R152/K144/K149/R156/N154 stick + 编号 + H-bond 线 |
| fig4e | Fig. 4e | TAM 识别：TAM duplex 全原子 stick（TAM 碱基紫色）+ TI/WED 读码残基 stick + H-bond 线 |

**Paper ② — Cas12i–crRNA–dsDNA (6W5C, Zhang 2020 NSMB)**，定义在 `src/papers/cas12i.js`：

| 面板 | 论文图 | 内容 |
|---|---|---|
| c1ov / c1ovBack | Fig. 1b/c | 域色 surface（WED 淡紫/REC 灰/PI 黄/RuvC 绿/REC2 深灰/Nuc 粉）+ crRNA 橙 + TS 品红 + NTS 天蓝 ±180° |
| c1d | Fig. 1d/e | cartoon 总览 + WED+α1 / U-rich loop / REC1 α16α17 标注 |
| c2a | Fig. 2a/b | crRNA 5′ 端加工特写：橙色 crRNA stick + WED 残基 stick（R22/H527/H528/W511…）+ U(−19)…A(−23) 编号 |
| c2d | Fig. 2d | PAM duplex 特写：TS 品红/NTS 天蓝/红色 PAM stick + S167/T168/H170/Y171/S482 stick |
| c2f | Fig. 2f | 底物切割特写：天蓝底物 DNA stick + RuvC 绿 / Nuc 粉催化残基 stick（D647/E894*/D1074/L912/R952…） |

论文 Fig. 3（激活，涉及多 PDB 叠合）与 Fig. 4（跨物种 lid 对比）未复现——按 SOP §1
判为超出单结构范围，需要时用 `loadStructureFromUrl` + `plugin.commands` 叠合实现。

## 环境与命令

- 依赖：Node ≥ 20（本机 v24），`npm install`（molstar@5.13.x + vite + playwright）。
- `npm run check` → 三个半身逐文件 `node --check` + 宿主冒烟测试（mock webServer/tools
  上下文跑 apply()，断言路由/工具注册、信任围栏 403/200、状态存取；需要 dist/index.html
  存在，缺失时自动打桩）。
- `npm run build` → `dist/`（vite；插件静态服务的根，**改 src/ 后必须重新 build**）。
- `node scripts/bridge-e2e.mjs` → 端到端桥测试：mock harness 起真 HTTP 服务，无头浏览器
  打开 `/api/mol-structure/viewer/`，通过真实 SSE/HTTP 桥驱动全部 22 个工具（含自定义面板/
  动作面板注册→按钮渲染→外部程序 /command 应用→完整 Mol* 模式切换），含用户点击
  上报与截图落盘（43 项断言；chromium 缺省回退系统 Edge/Chrome）。
- `npm run dev` → http://localhost:5173 （独立查看器；桥自动停用）
- `npm run capture` → 无头浏览器批量截全部面板（需 dev server 在跑；产出
  `docs/screenshots/final/<id>-page.png` 含标签层 + `<id>-canvas.png` 纯 WebGL；
  `PANELS=fig3c SETTLE_MS=12000 npm run capture` 可单 panel/调等待；
  Playwright 优先用已装 chromium，缺省回退系统 Edge/Chrome）。
- `python -I tools/check_panels.py` → 截图自检（陈旧帧/空白渲染/预期色簇缺失）。
- 结构文件从 `dist/structures/` 本地服务（dist 是结构/css 的**唯一副本**，vite dev 由
  中间件直接从 dist 取），运行时**不加载任何远程资源**。
- 热重载开发回路：改 `index.js`/`host/*.js` → `POST /api/mol-structure/reload`（或 bundle
  config `watch: true` 自动触发）→ 插件原位换新代码，SSE 重连、gen+1、查看器页面自动刷新；
  改 `client.js` → 直接替换已安装副本，内核 client-hmr 自动热换浏览器半身；
  改 `src/`（查看器）→ `npm run build`，查看器页面 ≤10s 内经 appRev 自检自动重载。

## 7XHT 链组成（auth 编号）

| 链 | 内容 | auth 范围 | 论文角色 |
|---|---|---|---|
| A | OgeuIscB ΔHNH 蛋白 | 3–496（Δ199–295） | PLMP 3–55 · RuvC-I 56–86 · BH 87–122 · REC 123–164 · RuvC-II 165–194 · RuvC-III 298–370 · WED 371–444 · TI 445–496 |
| B | ωRNA（红） | −16…206 | 233-nt ωRNA，guide 段 G(−17)–C(−1) |
| C | TS 目标 DNA（炭黑） | −11…17 | 49-nt 目标链（有序部分） |
| D | NTS 非目标 DNA（石板灰） | 0…11 | 5′ GAAG = TAM（residues 0–3） |
| A/B | MG 离子 | A:502, B:301 | RuvC 催化位点 Mg²⁺ |

配色（`src/main.js` 中的 `PALETTE`）从论文 Fig.1 采样：PLMP `#5158D8`、RuvC `#3E97DE`、
BH `#2FCC3B`、REC `#C0C0C0`、WED `#EDDE4C`、TI `#DBC79E`、linker `#7B4FD0`、
ωRNA `#CF3A3A`、TS `#222426`、NTS `#4A4E52`、TAM 高亮 `#9B4FD0`（仅表面视图）。

## Mol* v5 API 陷阱清单（全部踩过，勿重复）

1. **`Color.fromHexString('#EDDE4C')` 返回 NaN** —— v5 实现就是 `parseInt(s)`，不吃 `#` 前缀。
   统一用 `Color.fromHexStyle(hex)`（或 `Color(0xRRGGBB)`）。NaN 会静默变成 null 参数 → 全黑渲染。
2. **`MolScriptBuilder.acid(...)` 不存在** —— 原子属性用
   `MS.struct.atomProperty.macromolecular.auth_asym_id()` / `.auth_seq_id()` / `.label_comp_id()`。
3. **比较谓词**：`MS.core.rel` 只有 `eq/neq/lt/lte/gr/gre/inRange`，没有 `lr`。
   范围测试用 `MS.core.rel.inRange([prop, lo, hi])`；集合用 `MS.core.set.has([MS.set(...), prop()])`。
4. **`Camera.getFocus` 的 `dir` 是视线方向（camera→target）**，且内部走
   `Vec3.matchDirection`——该函数根据**当前相机**的方向决定翻转与否，初始相机在对面时会
   把整个 pose 翻到背面。需要确定性的 pose 时**手动构造 snapshot**：
   `{ target, position: target + dir*getTargetDistance(radius/zoom), up, radius }`，
   然后 `camera.setState(snapshot, 0)` + `canvas3d.requestDraw()`。
5. **没有 `canvas3d.requestRender()`** —— 正确方法是 `requestDraw()`。
6. **v5 的 illumination 渲染管线**（默认开启）会让 uniform 配色显得很暗。
   `Viewer.create(el, { illumination: false })` 回到经典渲染。
7. **表征 props 键名**：`{ type, type_params, color, colorParams }`（`color: 'uniform'`、
   `colorParams: { value: Color }`）。注意 `type_params`/`colorParams` 是蛇形命名（与官方示例一致）。
8. **空组件安全**：`tryCreateComponentFromExpression` 对空选区返回 `undefined`，记得判空。
9. **重建场景**：`await plugin.clear(false)` 后重建（当前用于面板切换，也会清掉 measurement 虚线）。
10. **repr 对象**：`SO.Representation3D` 上没有 `props` 字段；params 在
    `cell.transform.params`、运行时主题在 `obj.data.repr.theme`。调试时别读错地方。
11. **`Vec3.fromArray(out, array, offset)` 的 offset 是必填** —— `fromArray(out, arr)` 会用
    `array[NaN]` 填出全 NaN（JSON.stringify 显示为 null）。相机 target 变 NaN 的元凶。
12. **`camera.viewport` 是设备像素**（CSS 尺寸 × pixelScale），且是 `{x,y,width,height}` 对象
    不是数组。HTML overlay 投影要除以 `vp.width / canvas.clientWidth`。
13. **`requestAnimationFrame` 在 pane 不可见时冻结** —— 依赖 rAF 的刷新（如标签重投影）在
    后台标签会失效；用 setTimeout/轮询兜底（见 `src/labels.js`）。
14. **新表征落位后 Mol* 会自动聚焦相机**，覆盖你刚设置的 pose —— close-up 视图要在
    buildScene 之后延迟 0.4s / 0.8s **重设两次**相机（见 `main.js` applyFigure）。
15. **H-bond 虚线**：`plugin.managers.measurement.addDistance(lociA, lociB, …)` 是标准路径；
    Loci 由 `compile(expr)(new QueryContext(structure))` + `StructureSelection.toLociWithCurrentUnits`
    构造。Mol* 线几何**不支持虚线**（论文的 dashed cyan 用青色实线近似）。
16. **WebGL 截图**：`preserveDrawingBuffer` 默认开启，`canvas.toDataURL()` 直接可用；
    canvas 元素在 `plugin.canvas3d.webgl.gl.canvas`（`webgl.canvas` 属性不存在）。
17. **IAB pane 不在前台时 rAF 冻结**：Mol\* 不重绘 → 连续 `toDataURL()` 截到的全是
    同一张陈旧帧（md5 相同即中招），Playwright click 也会因稳定性检查超时
    （改用页面内 `btn.click()`）。**批量出图一律走 `npm run capture`**（无头浏览器
    独立渲染，不受 IAB 前后台影响，且整页截图自带 HTML 标签层）。
18. **面板状态永远停在 `building …`**：面板 onclick 的 Promise 拒绝没人接（现已
    `.catch` 到 `#status`）；头号成因是组颜色键拼错（`C.npks` 之于旧调色板）→
    `Color.fromHexStyle(undefined)` 抛 TypeError。`scenes.js` 的 addRep 现在会
    直接点名缺失颜色的组 id。
19. **`StructureSelection.toLociWithCurrentUnits` 的产物不能直接读属性**：其 elements
    携带查询 union 的 unit 实例，而 indices 是 **canonical unit 的位置**——
    `StructureProperties`（`unit.chainIndex[element]` 等）会索引错误数组，实测 auth_asym_id
    返回整份 CIF 原文。`scenes.js` 的 `canonicalLoci()` 把 unit 换回 `structure.unitMap`
    的正主后一切正常（点击产生的 loci 本来就是 canonical unit，故只有查询路径踩坑）。
20. **`StructureElement` 不在 `element/loci.js`**：从 `molstar/lib/mol-model/structure/
    structure/element.js`（或 `mol-model/structure.js` barrel）导入；`loci.js` 只导出 `Loci`
    命名空间。
21. **Loci 迭代函数叫 `forEachLocation`，不是 `eachLocation`**；签名 `(loci, cb, location?)`，
    回调拿 `StructureElement.Location`。
22. **measurement 管理器在 `plugin.managers.structure.measurement`**，没有顶层
    `plugin.managers.measurement`——旧 addHbonds 的 try/catch 把这条 TypeError 静默吞了，
    fig4c/d/e 的 H-bond 线曾长期没画出来（2026-11 修复，青色像素计数确认 813/367/728 px）。
23. **数据表行数是 `_rowCount`**（`mol-data/db` 的 Table），不是 `count`；链→残基范围用
    `h.residueAtomSegments.index[h.chainAtomSegments.offsets[cI]]` 这套组合（见
    commands.js 的 chains inventory）；残基分子类型在 `model.atomicHierarchy.derived.residue.
    moleculeType`（**不是** `model.atomicDerivedData`）。
24. **`createStructure(model, { name: 'model', params: {} })` 的 `name` 是 model-type 映射参数**
    （'model' | 'assembly' | …），不是标签——传文件名会得到 `Cannot read properties of
    undefined (reading 'type')`。
25. **`ViewportScreenshotHelper` 没有 `setProps`**（v5.13）：只有 `get params()`/`getImageDataUri()`/
    `download()`；分辨率由构造参数决定，别再调 `setProps({ multiFactor })`（导出按钮曾因此坏掉）。
26. **`MS.struct.generator.all()` 是空参**；无水过滤的全原子选择用它即可（cartoon 只画聚合物，
    不用为基座场景挑 residue-test）。
27. **鸭子类型注册的工具，`parameters` 必须是标准 JSON Schema**：`projectToolSchema` 对
    `parameters` **原样透传**（`defineTool` 是在定义期就把 DSL 的内联 `required: true` 归一化成
    父级 `required: [...]` 数组；绕过它就得自己产出最终形态）。0.3.0 曾把内联 `required` 直通模型
    API，DeepSeek 校验直接拒绝整轮请求（`Invalid schema for function 'mol_panel_define': … is not
    of type "string"`）。支持的关键词子集见内核 json-schema.ts：
    `type/properties/required/items/additionalProperties/enum/const` + `description/title`。
    `npm run check` 里的 wire-schema gate 会walk全部工具 schema 拦截回归。
28. **token URL 没有扩展名，格式判断要看文件名**：`ops.load` 曾只测 `url`（`/load/fN`），
    PDB 永远按 mmCIF 解析 → CIF parser 报 "Unexpected token. Expected data_, loop_"，
    随后 state builder 以 `.to(undefined)` 抛 "reading 'ref'"。现按 `name`（mol_load 上报的
    文件名）+ url 双重判断 `.pdb/.ent`。
29. **State builder 只有 `.delete(ref)`，没有 `.remove`；提交用 `builder.commit()`** ——
    `state.update(b)` 不存在（State 只有 `updateTree`）。按 tag 删层/清 measurement 组统一走
    `state.build().delete(ref).commit()`（`StateSelection.findTagInSubtree` 取 ref）。
30. **从 hierarchy 重绑 generic-op structure 必须传 StateObjectCell**（`hierarchy.current
    .structures[i].cell`，有 `.obj`）——传 `cell.obj`（SO 本体）会让 `ctx.structure.obj`
    变成 SO.obj=undefined，requireStructure 的懒重绑形成死循环（症状 "reading 'data'"）。
31. **`applyCamera` 接受两种形态**：顶层 `{yaw, pitch, …}`（mol_camera 工具归一化后的）
    和包装 `{view:{yaw, pitch, …}}`（动作面板/panel spec 直接传）——漏掉后者会在动作链里
    报 "nothing to do"。
32. **透明度（v5）= `repr.setState({ alphaFactor })`**：`addRepresentation` 的
    `type_params:{alpha}`（官方 preset 用法）与顶层 props.alpha 都**不能**可靠生效；
    repr 对象在 SO 的 `data.repr`（不是 `data` 本身，`data.setState` 是 undefined）。
    `src/scenes.js` 的 addRep 两条路都走（type_params + setState），`mol_style` 同。
33. **GUI iframe 可能卡旧 bundle**：改 src/ → build 后 iframe 靠 appRev 自检重载，但
    实测会滞留旧帧（截图字节完全一致即中招）。强制手段：`touch dist/index.html`
    （bump mtime）；最终成图别依赖 GUI iframe——用 `node tools/capture-cas9.mjs`
    这类 mock-harness 无头管线（参考 `scripts/bridge-e2e.mjs` 的 launch 回退链）。
34. **页签隐藏时 WebGL drawing buffer = 0×0**：`viewportScreenshot` 直接报
    "empty textures are not allowed"（或产出 1×1 PNG）。`commands.js screenshot` 已修：
    临时给 `gl.canvas` 一个固定离屏尺寸，finally 里还原。
35. **wwPDB struct_conn（v5）字段名**：`getStructConns` 返回
    `{ id, distance, partner1, partner2 }`，partner = `{ asymId, seqId, authSeqId,
    compId, atomId, insCode, altId }`——没有 `partners[]/residue_id/label_asym_id`。
36. **相机特写三件套必须全链路透传 `target`/`radius`**（2026-11 修过两处丢字段）：
    `host/tools.js` 的 `residueRef()` 只回 `{chain, seq}`——`mol_camera` 的 focus.radius
    曾被静默丢弃；`host/panels.js` 与 `applyCamera`（`src/commands.js`）的 view 曾剥离
    `target`（特写回到全结构中心）。现在 `mol_camera.view.target`、
    `mol_panel_define.view.target`、`focus.radius` 三处均已透传。radius 语义是
    zoom=1/radius（0.3≈3.3× 特写）。特写配方：`mol_camera focus {chain,seq,radius}`
    探坐标 → 面板 `view {…, target}`。
37. **面板标签锚点残基必须存在**：auth 编号有空档（如 6W5C 链 A 无 550），
    锚到缺失残基 `mol_figure` 直接抛 `residue A/550 not found`。注册面板前用
    `mol_select` 探查每个标签锚点。
38. **GPU 显存大头是 IlluminationPass 的空闲分配**（2026-11 修）：Mol* 的
    `IlluminationPass` 即使 `illumination.enabled=false` 也会在
    `setSize()` 里分配 canvas×pixelScale² 的 tracing targets——1400×900 面板
    （pixelScale 2）一次就 ~1.4 GB。该 pass 藏在 Canvas3D 闭包里，唯一入口是
    原型：`src/main.js` 在 `Viewer.create` 之前 patch
    `IlluminationPass.prototype.setSize`，pass 停用时把私有 targets 钉在 1×1
    （drawPass 尺寸保持）。另把 `pixelScale` 默认降到 1.5 并做成宿主设置
    （settings.json `pixelScale`，bundle config 覆盖，经 hello/ui 下发实时
    `canvas3d.setProps`）——显存与截图分辨率随它平方变化。实测同一工作负载
    GPU 纹理+渲染缓冲请求从 ~1.6 GB 降到 ~640 MB。注意：applyPixelScale 不要
    调 `setStatus()`——status 文案是 e2e/桥同步信号，被覆盖会让等待 'ready'
    的逻辑超时（e2e 曾因此整场挂起）。回归工具：`node scripts/mem-probe.mjs`。

## 主动注册视图（agent 政策）

分析任何结构时**必须**把关键视角用 `mol_panel_define` 注册成可回放面板（总览、界面
特写、催化/识别位点、突变候选等），不要只做一次性 `mol_scene`——用户要能在控制卡
一键回放。此要求已写入 README「工具提示词 / 使用参考」的 policy 段，后续 agent
照做。完整参考案例：Cas9 (4UN3) 与 Cas12i (6W5C) 各 6 个面板（surface 半透明 +
核酸 cartoon 统一外观、view 带 target 的特写、突变热点面板），成图分别在
`docs/screenshots/cas9/` 与 `docs/screenshots/cas12/`，README「Case study」两节有图、
机制分析与点突变建议表。

**展示结构前必须先开侧边栏（policy）**：插件无法强制展开 dsh 右侧栏（宿主 UI 状态，
无 API 可碰），`mol_panel` 只能请求切换到「结构视图」页签。因此凡是涉及结构展示/
分析的请求，agent 必须在 `mol_load` 等任何 3D 操作**之前**主动调用 `mol_panel`，
让用户立刻看到画面，而不是只汇报文字结果；右侧栏被用户收起时在回复里提示展开。

## 视角（已校准，勿随意改）

各面板 pose 在 `src/config.js` 的 `FIGURES[id].view`（yaw/pitch 绕世界 Y/X 的轨道角、
roll 绕视轴的屏幕旋转、zoom>1 拉近；`targetKey`+`radius` 用于 close-up 聚焦）。
整体视图：fig1b/1c = (255, 12, 1.15, 135)，背面 = (75, 12, 1.15, -135)。
校准方法与含义见 SOP.md §5。改动后必须按 SOP §6 与论文裁剪图逐项对照
（`reference/pdf-pages/fig2-zoom.png`、`fig3b-zoom.png`、`fig4a-zoom.png`、`fig4cde-zoom.png`）。

## 验证流程（代理自查）

1. `npm run check` → 三半身语法 + 宿主冒烟（无需 dsh，秒级）。
2. `npm run build` 后 `node scripts/bridge-e2e.mjs` → 端到端桥测试（真浏览器驱动全部
   `mol_*` 工具、用户点击上报、截图落盘；~1 分钟）。改动桥协议/命令实现后必跑。
3. 独立面板回归：`npm run dev` 起服务，`npm run capture` +
   `python -I tools/check_panels.py`（自动查陈旧帧/空白/色簇缺失），再与
   `reference/pdf-pages/` 的论文裁剪图逐项目视对照。改 main.js/scenes.js 后至少抽
   `fig1b,fig4c` 两面板（fig4c 验证 H-bond 线仍在）。
4. **装进真 dsh 验证**（手动，桌面端）：安装后重启应用 → 右侧边栏 guide 出现"结构视图"
   卡片 → 点击打开 iframe viewer → 对话里让 agent 调 `mol_panel`/`mol_figure` →
   `POST /api/mol-structure/reload` 后插件不重启即换新代码（SSE 重连、gen+1）→
   在 3D 视图点击残基 → `mol_status` 能读到该次点击。
5. 标签：`.label-layer > div` 数量与可见数应等于 FIGURES[id].labels 长度
   （缺锚点的 spec 会被静默过滤，个别少 1–2 个属正常）；
   `window.__lastLabelError` 应为 null。
6. 页面暴露调试钩子：`window.__viewer` / `__anchorsAll` / `__labels` /
   `__orbitDebug` / `__molApi`（含 `.dispatch(op, args)` 可在页内直接执行桥命令）。

## 约定

- 所有第三方代码本地化：molstar 来自 npm 安装，结构文件与 UI CSS 均放在 `dist/`；
  运行时不依赖 molstar.org / RCSB 网络；插件运行时零 npm 依赖、零 `@deepseek-ai/*` 导入。
- 插件半身分工：宿主语义进 `host/`，查看器语义进 `src/`，`client.js` 只做页签 iframe 与
  panel 打开转发——不要把 Mol* 打进浏览器半身（体量与构建复杂度都不值得）。
- 改配色/域表/面板时只动 `src/config.js`（宿主侧工具枚举自动跟随），并同步更新
  SOP.md 的对应表格；改 `src/` 任何文件后必须 `npm run build`，否则安装副本的 viewer
  不更新（appRev 只指纹 dist/）。
- 改宿主半身版本号时同步 package.json 与 index.js 的 `export const version`。
- `Export PNG ×4` 与 `mol_screenshot` 只导出 WebGL 画面（无 HTML 标签）；
  带标签成图用 `npm run capture` 的 `-page.png` 或整页截图。
  `docs/screenshots/final/` 是权威存档（每面板 page+canvas 两版），
  `iterations/` 是校准历史，勿作对照基准。
- 提交信息用英文祈使句；远端为 `Masterchiefm/dsh-mol-structure`（GitHub）。
