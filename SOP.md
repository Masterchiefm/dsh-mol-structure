# SOP — 用本地 Mol\* 重现论文结构图

标准操作流程（Standard Operating Procedure）。以 **Kato et al., Nat Commun 13, 6719 (2022)
"IscB–ωRNA ribonucleoprotein complex"（PDB 7XHT, Fig. 1b/1c）** 为范例，任何同类
"用 Mol\* 复现论文结构图"任务都按此流程执行。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（vite 7 需要） |
| npm 包 | `molstar@5.x`、`vite`（dev） |
| 浏览器验证 | ZCode browser-use（IAB）或任意 Chromium |
| 论文 | 含目标图的 PDF（本例在 `reference/`） |
| 网络 | 仅初始化时需要（npm install + RCSB 下载），运行时完全离线 |

## 1. 确定要复现的图与数据

1. 读论文正文/图注，锁定目标图的**表现类型**（ribbon / surface / mixture）与**内容要素**。
2. 在 *Data availability* 找 **PDB ID**（本例 7XHT）与 EMDB/PDB DOI。
3. 从图注提取：
   - 结构域边界（残基范围，Fig. 1a 的 linear domain map 是权威来源）；
   - 每条链/结构域的颜色（图注 + 图例；必要时从 PDF 高清裁剪图采样）；
   - 5′/3′ 等标注、特殊高亮（本例：表面视图中的紫色 TAM）。

> 实操：用 PyMuPDF 把目标页渲染成 PNG（150–300 dpi），裁剪出目标图，作为逐项对照的**基准图**。

## 2. 建立项目骨架

```bash
mkdir dsh-mol-structure && cd dsh-mol-structure
npm init -y && npm i molstar && npm i -D vite
# 结构文件本地化（离线运行的关键）
mkdir -p public/structures
curl -sSL -o public/structures/7xht.cif https://files.rcsb.org/download/7XHT.cif
# UI 样式本地化（用预构建 css，避免 sass 工具链）
cp node_modules/molstar/build/viewer/molstar.css public/molstar.css
```

- `index.html`：挂载点 `#app` + 控制 UI；`<link rel="stylesheet" href="./molstar.css">`。
- `vite.config.js`：`base: './'`。
- 包内入口：`import { Viewer } from 'molstar/lib/apps/viewer/app.js'`（不要导入
  `apps/viewer/index.js`，它会把 html/scss 拉进打包）。

## 3. 解析结构文件（确定链与残基范围）

用 Python（`-I` 隔离模式）解析 mmCIF 的 `_atom_site` loop，输出每条链的：
auth_asym_id、成分类型（蛋白/核酸/MG）、残基范围、残基组成。

用途：① 校对论文域边界 ↔ 沉积编号；② 编写选择表达式时用 auth 编号；
③ 识别特殊残基（本例：NTS 链 D 0–3 = GAAG TAM）。

> 本例结论：A=蛋白 3–496（Δ199–295 缺失区），B=ωRNA −16…206，C=TS −11…17，D=NTS 0…11。

## 4. 构建场景（组件 + uniform 配色）

按论文每个着色单元建一个 component，一个 uniform 颜色的 representation：

```js
const AMP = MS.struct.atomProperty.macromolecular;
const domainExpr = (chain, ranges) => MS.struct.generator.atomGroups({
    'chain-test': MS.core.set.has([MS.set(chain), AMP.auth_asym_id()]),
    'residue-test': ranges.length === 1
        ? MS.core.rel.inRange([AMP.auth_seq_id(), ranges[0][0], ranges[0][1]])
        : MS.core.logic.or(ranges.map(([lo, hi]) => MS.core.rel.inRange([AMP.auth_seq_id(), lo, hi]))),
});
const comp = await plugin.builders.structure.tryCreateComponentFromExpression(
    structure, domainExpr('A', [[56, 86]]), 'domain-RuvC', { label: 'RuvC' });
await plugin.builders.structure.representation.addRepresentation(comp, {
    type: 'cartoon', type_params: { quality: 'high' },
    color: 'uniform', colorParams: { value: Color.fromHexStyle('#3E97DE') },
}, { tag: 'repr-domain-RuvC' });
```

数据链路：`builders.data.download → builders.structure.parseTrajectory → createModel → createStructure`。
切换 ribbon/surface：记录 reprType，`await plugin.clear(false)` 后整体重建。
核酸用 cartoon（Mol\* 会画出碱基梯子，接近论文的 ladder 风格）。

## 5. 相机校准（核心工序）

### 5.1 位姿参数化

用一个函数把 (yaw, pitch, zoom, roll) 变成相机快照：

- yaw/pitch：绕世界 Y/X 轴的轨道角，`dir = (sinYaw·cosPitch, sinPitch, cosYaw·cosPitch)`，
  相机位置 = `target + dir·dist`；
- roll：把 up 向量绕 dir 做 Rodrigues 旋转（屏幕旋转）；
- zoom：视野半径 `radius/zoom`（>1 拉近）；
- `dist = camera.getTargetDistance(radius/zoom)`，与 Mol\* 内部聚焦距离公式一致。

### 5.2 为什么不能只用 Camera.getFocus

`getFocus(target, radius, up, dir)` 内部用 `Vec3.matchDirection` 匹配视线方向，而后者
**根据当前相机方向决定是否翻转**——初始相机在目标背面时整个 pose 会翻到对面。
所以本项目手动构造 snapshot（见 `src/main.js` 的 `orbitSnapshot`）。

### 5.3 校准流程（迭代法）

1. 从 (yaw 0, pitch 0) 开始截图；
2. 每次 ±45° 或 ±90° 扫 yaw，找到主要结构域相对位置最接近基准图的象限；
3. 微调 pitch（±5–15°）获取俯/仰视角；
4. 用 roll（±90° 及中间值）调整屏幕构图方向（哪个域在左上/右下）；
5. zoom 1.0–1.2 让结构充满视口；
6. **逐项对照**基准图：每个域的相对方位、异源双链走向、5′/3′ 端位置。

> 本例定稿：fig1b = (255, 12, 1.15, 135)。校准耗时约 8 轮截图。

### 5.4 背面视图（论文中的 180° 旋转）

yaw ±180；roll 取相反符号（从背面看时屏幕方向也镜像）。
本例：fig1cBack = (75, 12, 1.15, -135)。

## 6. 验证清单（对照基准图逐项打勾）

自动化部分（先跑，几分钟出结果）：

- [ ] `npm run capture`：全部面板截到 `docs/screenshots/final/`（page 版含标签 +
      canvas 版），每面板 `#status` 都到过 `ready`（脚本输出无 WARN）
- [ ] `python -I tools/check_panels.py`：无陈旧帧（md5 两两不同）、前景 ≥3%、
      关键面板预期色簇达标（如 fig1b 红 RNA/蓝 PLMP·RuvC/绿 BH、fig1c 紫 TAM、
      fig4a 红 RNA + 灰表面）——新增面板时在脚本 `SIGNATURES` 里补签名
- [ ] 标签：`.label-layer > div` 数 ≈ FIGURES[id].labels 长度（缺锚点的 spec 被
      静默过滤，少 1–2 个正常）；`window.__lastLabelError === null`

目视部分（对照 `reference/pdf-pages/` 基准裁剪图）：

- [ ] 所有组件已创建（状态树无空 repr；`window.__viewer.plugin.state.data.cells` 可查）
- [ ] 颜色饱和度正常（不是全黑——黑=颜色值 NaN，见 AGENTS.md 陷阱 1）
- [ ] 主图（ribbon）：每个域方位与论文一致
- [ ] 核酸梯子风格、TS/NTS 灰度差异可见
- [ ] 特殊高亮（TAM 紫色）仅在 surface 视图
- [ ] 背面视图与论文 180° 视图一致
- [ ] 交互正常（旋转/缩放/悬停）
- [ ] Export PNG ×4 可下载高分辨率图

## 7. 排查表（症状 → 原因 → 修复）

| 症状 | 原因 | 修复 |
|---|---|---|
| 整体渲染黑色 | `Color.fromHexString('#…')` → NaN → 参数 null | 用 `fromHexStyle` |
| 画面整体偏暗 | v5 illumination 渲染管线 | `Viewer.create(…, { illumination: false })` |
| `MS.acid is not a function` | v5 移除了旧快捷方式 | `MS.struct.atomProperty.macromolecular.*` |
| `MS.core.rel.lr is not a function` | 谓词改名 | `inRange([prop, lo, hi])` |
| `requestRender is not a function` | 方法名 | `canvas3d.requestDraw()` |
| 视角随机翻到背面 | `getFocus`+`matchDirection` 依赖当前相机 | 手动构造 snapshot |
| 域组件缺失 | 选区为空（范围/链号写错） | 核对 mmCIF auth 编号；判空 |
| 首帧白屏 >10 s | WebGL/shader 编译 + mmCIF 解析 | 正常现象，等 `#status` |
| 截图超时 | WebGL 重绘慢 | 增加等待/重试 |
| 面板永远停在 `building …` | 组颜色键拼错（如 `C.npks` 不存在）→ `fromHexStyle(undefined)` 抛错，onclick 的 rejection 无人接 | 看 console/`#status`（addRep 会点名组 id）；补调色板键 |
| IAB 里连截多张 PNG 全相同 | pane 不在前台 → rAF 冻结 → 画布不重绘，截到陈旧帧 | 用 `npm run capture`（无头浏览器独立渲染） |
| Playwright click 在 IAB 超时 | rAF 冻结导致元素稳定性检查不过 | 页面内 `btn.click()`（evaluate） |
| 截图时状态还是 `building` | 特写面板（全原子 stick）构建 > 默认 5 s | `SETTLE_MS=12000 npm run capture` 或 `PANELS=<id>` 单独重截 |

## 8. 多面板论文图与发表级标注（Fig. 2–4 的做法）

### 8.0 多论文支持（2026-11 增补，已用 Cas12i 论文实测）

仓库天然支持多篇论文并列：

1. **结构文件**：`public/structures/<pdb>.cif`；
2. **锚点**：在 `tools/make_anchors.py` 的 `PAPERS` 里加一个条目（cif 文件名、
   domains/regions/residues/nums/end_chains，SS 不需要就设 None），然后
   `python -I tools/make_anchors.py <paper>` 生成 `label-anchors-<paper>.json`；
3. **面板**：新建 `src/papers/<paper>.js`，导出 `figures`（每面板 = `{ title,
   scene: { structureUrl, groups }, view, labels, hbonds }`）与 `paper` 元数据；
   在 `src/config.js` 注册；
4. **UI**：`index.html` 加 `<div class="paper-title">…</div>` + `<div class="btn-row"
   data-figures="…">`；
5. anchors JSON 会按论文自动加载（`main.js` 启动时 fetch 所有 `paper.anchorsUrl`）。

实测摩擦点（Cas12i 论文）：
- **链组成要先核实**：解析 mmCIF 的 auth_asym/comp 统计每链类型与范围
  （SOP §3 的脚本逻辑已在 `make_anchors.py` 内置）；
- **论文编号 vs 结构 auth 编号可能错位**（Cas12i 的 PAM 核苷酸论文写 dT(−2*),
  结构里是 auth 1–10 的 T）；标签以**结构 auth 编号**为准，论文编号写进文档对照；
- **stick 组的颜色**要按论文图例给（crRNA 橙 / TS 品红 / NTS 天蓝 / PAM 红），不要一律 element 黑；
- 特写面板若加**半透明 surface 做背景**，stick 会被盖住——用 cartoon 做背景；
- 每个面板必须按 §6 对照论文原图后调 yaw/pitch/roll/radius（特写 radius 通常 24–48 Å）。

### 8.1 标注系统（HTML overlay）

论文图的域名 pill、5′/3′ 圆点、残基名、HNH 虚线圆都是**2D 标注**。用 HTML overlay
实现（`src/labels.js`）：锚点为世界坐标（`tools/make_anchors.py` 从 mmCIF 生成
`label-anchors-<paper>.json`：每个着色单元的原子质心、每链 5′/3′ 端、特写残基质心），
用 `camera.view/projection` 投影到屏幕后放置绝对定位的 div。

关键实现细节（都是踩过的坑）：
- `camera.viewport` 是设备像素且为 `{x,y,width,height}` 对象；投影结果要除以
  `vp.width / canvas.clientWidth`；
- `Vec3.fromArray(out, arr, offset)` 的 offset 必填；
- `requestAnimationFrame` 在后台 pane 冻结 → 同步 update + setTimeout/轮询兜底；
- `setState` 后相机矩阵延迟一帧更新 → 立即 + rAF + 80ms 三重触发。

二级结构编号（IscB Fig. 2 的红 α/蓝 β 数字）不必手数：直接解析沉积文件里的
`_struct_conf`（HELIX）与 `_struct_sheet_range`（SHEET），按域分段编号，
锚点取该段 CA 质心——这是"作者视角"的权威数据。

### 8.2 相互作用特写（IscB Fig. 4c–e / Cas12i Fig. 2d,f）

- **残基 stick**：为每个特写定义 stick 组——选定残基列表的
  `ball-and-stick` 组件；**颜色按论文域色给**（如 RuvC 域残基用绿色、Nuc 用粉色），
  仅当论文用元素配色时才用 `element`；
- **核苷酸编号**：每个标注核苷酸生成一个质心锚点（`num_B-7` 等），HTML 小数字；
- **H-bond 线**：`plugin.managers.measurement.addDistance(lociA, lociB, { customText: ' ',
  visualParams: { visuals: ['lines'], textColor: 青, textSize: 0.01 } })`；
  Loci 用 `compile(expr)(new QueryContext(structure))` + `StructureSelection.toLociWithCurrentUnits`
  从与组件相同的 MS 表达式求值。Mol* 线几何不支持虚线，用青色实线近似；
- **close-up 相机**：`view: { targetKey, yaw, pitch, zoom, radius, roll }` —— target
  直接取锚点（区域质心/关键残基），radius 为视野半径（Å）。**注意**：新表征落位后
  Mol* 会自动聚焦覆盖 pose，需在构建完成后延迟 0.4s/0.8s 重设两次相机；
- **特写背景**：相关域用 `cartoon`（不要不透明 surface，会盖住 stick）。

### 8.3 面板组织

每篇论文一个模块 `src/papers/<paper>.js`（`figures` + `paper` 元数据），
`src/config.js` 汇总为 `PAPERS` 与扁平 `FIGURES`；`scenes.js` 按 `scene.groups`
装配组件（group = `{ chain, kind: 'ranges'|'residues'|'het', ranges/residues/comp,
color, repr }`，见 `src/helpers.js` 的 `dom/stick/mg` 快捷构造）；UI 按 `index.html`
里 `data-figures` 属性分组生成按钮。

## 9. 扩展到其它论文

按 §8.0 的五步走（结构 → 锚点 → 面板模块 → 注册 → UI），实测一次新论文的
工作量：读论文+定域界约半天，配置+校准约半天（Cas12i：8 步内完成 6 个面板）。
其余要点：

1. 多状态/多聚体：追加链组件；必要时用 `assembly` root structure。
2. 密度图（EMD）：`viewer.loadEmdb(emdbId)` 或本地 `.map`（molstar 支持 ccp4/mrc）。
3. 高分辨率出图：**首选 `npm run capture`**（无头浏览器整页截图，含 HTML 标签层，
   另存 canvas-only 版；输出 `docs/screenshots/final/`，Playwright 会自动回退系统
   Edge/Chrome）。`Export PNG ×4`（`viewportScreenshot` helper）与页面内
   `canvas.toDataURL()` 都**只包含 WebGL 画面，不含 HTML 标签层**，且在 IAB 后台
   pane 里会截到陈旧帧（见 §7 排查表）。不依赖 dev server 的替代管线：
   `node tools/capture-cas9.mjs`（mock harness + 真浏览器，按面板定义截
   `docs/screenshots/cas9/`；改面板定义即可复用于任何结构，完整 Cas9 (4UN3)
   案例见 README「Case study」）。

## 10. 参考资料

- Mol\* v5 文档：<https://molstar.org/docs/v5/>（插件实例化：plugin/instance）
- Mol\* Viewer 使用手册：<https://molstar.org/viewer-docs/>
- 论文：<https://doi.org/10.1038/s41467-022-34378-3>；PDB 7XHT；EMD-33586
- 本仓库的踩坑记录：`AGENTS.md`

## 11. dsh 插件化（宿主半身 / 浏览器半身 / 热重载）

本项目自 v0.2.0 起是 DeepSeek Harness 第三方插件（规范研读自 dsh 源码与本机已装的
dsh-our-free-model 热重载实现）：

**三处半身，各管各的**

- 宿主半身 `index.js` + `host/*.js`：cordis 插件（`apply(ctx, config)`，inject 仅
  `webServer`，tools 走嵌套 inject）。挂 `/api/mol-structure` 前缀路由（静态 viewer、
  JSON API、SSE、load token）、注册 12 个 `mol_*` 工具、提供自热重载。**所有请求过
  `host/trust.js` 信任围栏**（插件前缀比内核 `/api` 长，会绕过 connection 鉴权）。
- 浏览器半身 `client.js`：手写 ModuleLoader bundle，注册右侧边栏"结构视图"页签
  （body = iframe）并监听 SSE 的 `panel` 事件（agent 工具 `mol_panel` 触发打开）。
- 查看器页面 `src/`：Vite app。`src/bridge.js` 仅当页面由插件路由服务时启用
  （`/api/mol-structure/` 前缀探测），独立 `npm run dev` 时为 no-op。

**命令桥协议**：agent 工具 → 宿主 `state.submitCommand`（id 配对+超时+取消）→ SSE
`command` 事件 → `src/commands.js` 分发执行 → `POST /result` 回传。用户点选/选择经
`POST /selection` 上报，`mol_status`/`mol_select`（无参）可读；agent 设定的选择标记
`source: "agent"`，用户点击为 `source: "user"`。

**验证顺序**（改任何半身后）：

1. `npm run check`（语法 + 宿主冒烟，秒级）
2. `npm run build` + `node scripts/bridge-e2e.mjs`（真浏览器端到端，17 项断言）
3. 面板回归：`npm run capture PANELS=fig1b,fig4c` + `python -I tools/check_panels.py`
4. 装进真 dsh 手动验证（见 AGENTS.md 验证流程 §4）

**自定义视图与开放接口（v0.3.0）**：

- 旧示例（论文面板按钮区）在内嵌模式下默认收起，右上角 `☰ 面板` 唤出；
  bundle config `controlCard: 'show'|'hide'|'auto'` 覆盖默认行为。
- 自定义标签两条路：① 论文面板走 `public/structures/label-anchors-<paper>.json`
  （tools/make_anchors.py 预计算残基/末端质心，anchorKey 引用）；② 任意结构运行时
  锚定——`mol_labels`/面板 labels 传 `{chain, seq}` 即可，查看器实时算残基质心
  （StructureElement.Loci.getBoundary），无需锚点文件；`{xyz:[x,y,z]}` 直接世界坐标。
- 注册自定义视图：agent 用 `mol_panel_define`（groups + view/focus + labels + hbonds
  + apply），或本机任意程序 `POST /api/mol-structure/command {op:"panelDefine"}`——
  按钮立即出现在查看器控制卡「自定义视图」组，`mol_figure`/`{op:"figure"}` 按普通面板
  应用。定义存宿主内存，热重载后需重新注册。
- 外部程序接口：`POST /command`（viewer ops：figure/figures/scene/camera/labels/
  hbonds/measure/select/query/screenshot/load；host ops：panelDefine/panelRemove），
  未知 op 400 列出词汇；`GET /state`、SSE `hello` 携带 `customPanels`。示例见 README。

**热重载**：`POST /api/mol-structure/reload` 或 bundle config `watch: true`。宿主半身
原位换码（镜像内核 HMR 的 loadCache 清除→重导入→重注册→回滚，`host/reload.js`）；
client.js 直接替换安装副本由内核 client-hmr 热换；查看器改 `src/` 后 `npm run build`，
页面经 appRev 指纹 ≤10s 自检重载。

**安装**：桌面端用应用内插件管理器指向本目录（或手工放真实目录三步，见 README）；
纯 web profile 用 `dsh plugin --profile web add <目录>`。注意 `dist/` 必须先构建并随包分发。

**参考**：dsh 源码 `packages/client/ui-sidebar-browser`（页签注册范本）、
`docs/subsystems/sidebar-right.md`、`packages/boot/plugin-manager`（安装）；
第三方插件先例：dsh-our-free-model（热重载 `src/reload.js`）、dsh-plugin-whale-pet。
