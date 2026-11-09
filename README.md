# AI 浏览器控制

让支持 MCP 的 AI 助手按标签页读取和操作真实 Edge / Chrome。后台操作不切换标签页、不移动系统鼠标。

当前源码版本：0.11.0。新增指定网址后台打开接口，并修正悬停菜单的光标保持和连续点击衔接；包含此前菜单识别、连接恢复及有界日志。通过仓库更新获取，未创建对应 GitHub Release。

## 开始使用

需要 Node.js 22+、Edge / Chrome 120+。运行时零第三方依赖，无需 npm install。

1. 下载或克隆本仓库，放到稳定的目录。
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），启用开发人员模式，加载仓库内的 `extension` 目录。
3. 让 AI 按 [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md) 接入自己的 MCP 配置。规范包含通用协议、ZCode 配置和验收步骤，不需要运行注册脚本。
4. 重启 AI 会话，调用 `browser_status`。本机桥会按需启动，默认端口 17653。
5. 在浏览器中点扩展图标连接，授权当前页；也可由用户打开“自动授权所有网页”。

只读验收提示词：

> 使用 ai-browser 的 browser_status 检查连接，再用 browser_list_tabs 列出标签页。只读，不点击、不填写、不导航。

扩展弹窗只有一个连接/断开按钮；“CDP 真实交互”和“允许截图使用 CDP”独立可见。端口、光标与轨迹停留时间位于“更多设置”。用户主动断开后，扩展后台重启也不会自动连接。

## 输入与截图独立设置

| 设置 | 默认 | 开启时 | 关闭时 |
| --- | --- | --- | --- |
| CDP 真实交互 | 关闭 | 浏览器真实输入协议 | DOM 点击、原生 value setter、input/change 及有限按键行为 |
| 允许截图使用 CDP | 开启 | 按 tabId 截当前或后台页；完成后解除仅为截图新建的调试附加 | captureVisibleTab，仅当前选中页，需用户点击扩展图标取得 activeTab 临时权限 |

读取始终走隔离脚本，导航走 tabs.update，两者不需要 CDP。默认 DOM 输入与独立 CDP 截图可以同时使用。已有用户显式保存的输入选择保留；新增截图选项默认允许，用户可单独关闭。

关闭输入 CDP 后会解除已有调试附加，DOM 输入失败不会自动启用真实输入协议。截图单独获准时仍可按需附加；仅为截图附加的调试器会在完成后解除。两项都关闭才是本插件完全不调用 CDP 的模式。

这只限制插件调用的用途，浏览器授予的 chrome.debugger 权限不会变成低权限或只读权限。网站可能忽略 DOM 非可信事件，应回读确认；DOM 按键不保证所有站点的默认快捷键都生效。

临时截图授权是浏览器的 activeTab 权限：切换到新站点后可能需要重新点击扩展图标。项目保持原有 HTTP(S) 站点权限，不为截图增加文件页访问权。

读取不使用 CDP，不意味着网站无法识别扩展或一定能够访问。登录、验证码、跨域隔离和网站自身策略仍然生效；不绕过访问控制。

## 光标和反馈

- 使用白色指针、蓝色柔光、短弧线移动与点击涟漪；图形和动画代码为本项目独立实现。
- 目标在视口内时不强制滚到中央。移动完成后重新验证目标位置和遮挡，再执行点击。
- 可见页面移动约 160–320ms；隐藏页面直接定位，不等待装饰动画。
- 默认在最后一次操作结束 10 秒后淡出，可设 0–60 秒。
- 关联的悬停菜单可见期间保持光标；菜单关闭后恢复隐藏计时。首次显示直接出现在目标，后续从上次位置衔接，菜单内使用直线路径。0秒隐藏选择仍生效，轨迹时间独立。保持只影响视觉反馈，不修改网站菜单样式或阻止网站自行关闭。
- 移动经过的蓝色轨迹独立保留，默认 5 秒、可设 0–60 秒；0 为关闭。光标先隐藏也不会提前清掉轨迹。高频连续操作最多保留 64 段，超出时回收最旧一段。
- 静止后停止帧循环；遵守系统“减少动态效果”设置。

实际渲染截图、连续帧、性能分支和限制见 [TEST-RESULTS.md](TEST-RESULTS.md)。

## 工具

| 工具 | 用途 |
| --- | --- |
| browser_status | 桥与扩展连接状态 |
| browser_list_tabs | HTTP(S) 标签页、授权状态及 inputMode/screenshotMode |
| browser_snapshot | 默认滚动探测懒加载；返回当前正文、ref 与累计观察。load=current 仅回读 |
| browser_scroll | 主文档或指定容器向上/下、顶部/底部滚动；不点击、不切页 |
| browser_click | 按 ref 点击 |
| browser_hover / browser_focus | 悬停或取得页面内焦点 |
| browser_drag | 按源与目标ref拖拽 |
| browser_select / browser_set_checked | 原生select选择、幂等勾选状态 |
| browser_inspect / browser_wait | 读取元素状态、有条件等待 |
| browser_fill | 替换文本框或 contenteditable 内容 |
| browser_press | 在目标标签页发送支持的按键 |
| browser_navigate | 导航到明确的 HTTP(S) 地址 |
| browser_screenshot | 按独立截图开关选择 CDP 或当前页截图 |
| browser_release | 释放此页，自动授权模式下也生效 |
| browser_open | 把指定HTTP(S)网址在已有窗口中新建为后台标签页，不激活窗口 |

每次快照刷新 ref。动作后重新读取快照确认；超时不等于失败，不直接重复提交、支付或发送。快照不读取 Cookie、localStorage 或浏览历史，也不输出密码框的值。

0.10.0提供17个工具。click支持button=right、clickCount=2、holdMs和position相对位置；press支持ref聚焦和Shift+Tab、Alt+ArrowDown/Up、Shift+F10、Control+Enter。快照增加disabled/focused/checked/selected/hasPopup/controls/busy，inspect可读遮挡、位置和原生select选项；wait最长5秒。DOM悬停不支持纯CSS :hover，CDP真实交互沿用原开关并保留保存值。完整流程与边界见[特殊交互与状态](skills/ai-browser-control/references/interactions.md)。

0.10.1把tabindex控件，以及由aria-haspopup+controls/owns关联或具备menu/listbox角色的可见弹层内列表项、自绘指针项纳入定位。快照标记inPopup并优先保留这些选项；没有标准role的选项仍按真实角色返回，不虚构menuitem。inspect触发器可见关联popups状态和候选项数。此为DOM候选识别，不等于所有列表项都必然绑定了点击处理器。

0.11.0共18个工具。AI要新开用户指定网址时用browser_open(url)，可选已有授权tabId确定所属窗口；不传则用最近普通窗口。创建固定active=false，不调用窗口激活或新建窗口；没有窗口则报错，需用户手动打开。回执包含新tabId、实际active、窗口focus前后状态和授权状态，后续按新tabId读取；自动授权关闭时不擅自授权新页。browser_navigate仍用于已有页。网页按钮自行window.open或用户手动新建页面不由此接口改写。

当前范围：主文档普通 DOM、同源 iframe 正文；跨域 iframe、封闭 Shadow DOM、canvas 内部控件和系统文件选择框不支持。动态页面内容尚未出现时稍后重新读取，不把短文档当成错误。

### 已加载内容不等于全部数据

`browser_snapshot` 返回 `coverage`：说明只读取当前已加载 DOM、正文是否超过 12000 字符、交互元素扫描是否达到 150 个的上限。达到上限时优先保留视口内控件（`selectionPriority=viewport-first`），以免长列表挤掉弹窗按钮；保留的元素仍按 DOM 顺序输出。`dataCompleteness` 为 `unknown`；浏览器的 document.readyState=complete 也不表示业务列表全部加载。

默认 `load=auto` 会滚动探测懒加载并恢复原滚动位置，最多约8秒/40轮；`loading` 返回停止原因、累计观察、底部文本及截断标记。主文档不滚动时尝试最大的独立滚动容器。历史观察不带 ref，不能直接点击；虚拟列表须先滚动再获取新 ref。`bottom-stable` 只表示暂时稳定，`complete=false`；定位“最后一项”仍须核对站点总数/可靠结束标志和分页状态，不能换成“当前已加载末项”。没有取齐时继续 `browser_scroll` 或报告未完成。

同名按钮点击须传 `expectedContext`（例如航班号）。快照会给出 `context`，ref 同时绑定节点和当时的业务上下文；滚动或动画期间被复用、改名或替换时拒绝点击。`clicked=true` 仅表示派发事件，回执 `outcome=unverified`；随后用 `browser_snapshot(load=current)` 核对同一对象的身份和展开/跳转结果，不能只数“收起”按钮。

当前没有通用的“自动滚动直到抓全”收集器。需要全量结果时，必须按具体页面滚动或翻页、等待新增内容、逐批读取并累计去重。虚拟列表会移除旧行，不能只在滚到底后读取一次。无限列表、分页和嵌套滚动容器也不能靠“高度暂时不变”判定完整。未取得总条数或可靠结束标志时，报告已读数量及未完成原因，不声称抓全。

### 后台截图与 CDP

允许截图使用 CDP 时，按 tabId 发给 Page.captureScreenshot，支持目标页未选中，不调用激活标签页或聚焦窗口；已在独立真实 Edge 中验证截图前后选中标签不变。关闭“CDP 真实交互”不影响这项能力。只有关闭截图 CDP 才改用 captureVisibleTab，该 API 仅支持窗口当前选中的标签页。[Chrome 官方 API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)

截图由浏览器生成，不需要网站提供截图接口；这不构成反爬保证。本轮已在用户打开的携程后台页成功截图，回读仍有航班与订票按钮，未见可见验证提示。紧邻复测前台标签不变；首轮较晚回查出现过一次选中变化，原因未查实，详见 TEST-RESULTS.md。这些结果不证明站点长期不会识别、限流或触发验证。

## 多浏览器与跨机器

每个浏览器使用独立桥端口。扩展的端口配置保存在各浏览器自己的存储中：

```powershell
node install.mjs bridge add
node install.mjs bridge list
node install.mjs bridge remove <端口>
```

`bridge add` 挑选空闲端口并启动；`remove` 只移除登记，不结束进程。同一桥同时只有一个扩展轮询连接，白名单最多 8 个扩展来源。

跨机器时，在浏览器所在机器启动：

```powershell
node install.mjs bridge add --host 0.0.0.0 --allow-ip <AI机器IP>
node install.mjs bridge token <端口>
```

然后按接入规范把远程主机、端口和 token 写到 AI 的 MCP 参数。非回环请求必须携带 Bearer token；IP 白名单为额外限制。本机回环免 token，扩展仍连接本机桥。

只用于可信网络，不将桥转发到公网。当前传输为 HTTP，token 不提供传输加密。token 文件位于 `~/.zcode/ai-browser-control/<端口>/token`；不要提交到仓库或写入公共日志。删除 token 并重启桥可轮换凭据。

网页 Origin 被拒绝；扩展首次连接登记自身来源。这条边界不隔离本机进程。

## 连接异常排查

弹窗“已连接”需同时核对配对状态、近期轮询和桥返回的本扩展心跳；仅配对成功不表示命令通道可用。状态读取失败会显示连接异常，不能继续沿用绿色旧状态。连接按钮发起请求后先显示确认通道，真正可用由状态回读决定。

浏览器命令最多等待11秒，超时报告“结果不确定”并恢复轮询，不自动重放原动作。Chrome已接收的操作无法保证取消；原操作仍未结束时，同一标签页的新操作会被拒绝，其他标签页可继续使用。先回读结果，不重复提交、支付或删除。仍无法恢复该页时，可重新加载扩展后再读取状态，不把超时当作操作未发生。

网络异常会自动重试，用户主动“断开”则保持断开。手动重连会使旧请求失效，迟到的响应不能覆盖新连接；桥端断开同时清除当前扩展的心跳。`browser_status` 的心跳陈旧只证明通道未响应，不能单凭它判断是其他agent抢占或浏览器后台挂起。

诊断日志位于 `%USERPROFILE%\.zcode\ai-browser-control\<端口>\bridge.log`，新记录为逐行 JSON；升级保留的旧日志尾部仍为旧格式。当前文件和 `.1`、`.2` 两份历史每份最多1 MiB，单桥合计最多3 MiB；超限自动轮转，启动时也会裁剪旧版超大日志。轮转失败会跳过写入，不回退到无限追加。桥的后台启动入口不再把 stdout 长期重定向到日志，以免绕过大小限制。

日志记录配对/断开、轮询、重试间隔、命令排队/派发/结果/超时，以及扩展的授权查询、脚本注入、prepare、DOM/CDP执行等阶段和耗时。用桥记录的 `id` 与 `extension_event.diagnostic.commandId` 关联；扩展事件另带 `session`、`seq`、`epoch` 和版本，以区分后台重启、重连和补传。桥接收时间在外层 `time`，扩展原事件时间为内层毫秒时间戳。不记录页面URL、标题、正文、截图、输入值、token或原始错误正文；只保留固定错误类别和HTTP状态码。

扩展在 `chrome.storage.local.diagnosticLog` 中保留最近最多128条且少于64 KiB的元数据，200毫秒合并存储，最多一个存储请求在途；桥恢复后自动分批补传。补传不阻塞命令通道。worker重启可能重传已有事件，按session+seq识别重复；旧记录会被新记录覆盖，日志不是无限期审计。完全冻结worker或浏览器存储故障时无法保证持久化。

`browser_status` 返回桥的实际 `version` 和最近收到的 `extensionVersion`；未收到新版诊断时扩展版本为null，不能把磁盘清单版本当作已加载版本。扩展弹窗页脚显示浏览器实际加载的版本。版本源为 `.zcode-plugin/plugin.json`，扩展清单与可选市场条目必须同步，Node回归检查清单一致性。

## 更新

Windows 可双击仓库内的 **更新插件.cmd**；其他环境运行：

```powershell
node install.mjs update
```

它尝试 `git pull --ff-only`、检查并重启旧版本桥；失败会返回非零退出码。默认不重写任何第三方 agent 配置，也不要求先执行 register。ZIP 安装请先用新源码替换目录，再运行更新命令。第三方 agent 接入方式以规范为准。

浏览器加载的解压缩扩展无法靠拉取源码自动生效：更新后在扩展管理页点“重新加载”，刷新被控制网页；MCP 说明变化时重启 AI 会话。脚本会如实提示这一步，不宣称整个浏览器已经更新。

旧脚本注册入口仅兼容已有用户。确需按旧回执重放注册时，显式运行：

```powershell
node install.mjs update --refresh-registration
```

## 本地运行、测试与预览

本项目是原生 JavaScript 扩展 + Node 服务，不需要编译或打包运行时。可直接加载 `extension`，双击“启动桥接服务.cmd”或运行：

```powershell
node server/bridge.mjs --bridge
node test-page/serve.mjs
```

测试页为 `http://127.0.0.1:17654/`，只写入页面内存。若 17654 已用于其他桥，先停用对应测试服务或换一个独立测试入口，不覆盖现有服务。

自动化回归：

```powershell
node --test tests/bridge.test.mjs tests/install.test.mjs tests/diagnostics.test.mjs tests/protocol.test.mjs extension/tests/mock.test.cjs extension/tests/expired-result.test.cjs
python -X utf8 tests/browser-ui.py
python -X utf8 tests/browser-extension.py
python -X utf8 tests/browser-loading.py
```

Python 项仅供开发验收，依赖测试机已有 Python Playwright、Pillow 和 Edge；不属于运行时依赖，不自动安装或复制全局工具。UI 对照测试还需要 Git 历史中的基线提交（见 REQUIREMENTS.md）；纯 ZIP 没有该历史时无法生成旧版对照。它们使用独立临时浏览器配置和测试桥，不控制用户的标签页。证据输出到 `temp/qa/`。无 CDP 截图正向夹具的额外权限与正式清单不同，具体限制在测试记录中明确列出。

本地预览包放在 `temp/ai-browser-control-local-preview.zip`；这是源码预览，不是正式 Release。解压后可加载其中的 `extension` 目录，不包含 Node 或浏览器副本。

## 给后续 AI

先读 [REQUIREMENTS.md](REQUIREMENTS.md)，用户原话决定范围；再看 [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md) 和最新测试记录。不要把历史 agent 的推断升级为用户需求。

随插件分发的浏览器操作规范在 [skills/ai-browser-control/SKILL.md](skills/ai-browser-control/SKILL.md)。跨站点的懒加载、虚拟列表、分页、列表结束判断及动作验收见 [动态列表流程](skills/ai-browser-control/references/dynamic-lists.md)；接入 agent 应读取该文件，不依赖当前聊天或某台机器的本地规则。

主要入口：

- `server/mcp.mjs`：MCP stdio；`server/protocol.mjs`：18个工具与共用参数校验；`server/bridge.mjs`：指令队列、来源校验、远程 token。
- `extension/background.js`：授权、CDP/DOM 路由、结果重传。
- `extension/page-agent.js`：DOM 快照、ref、定位与 DOM 操作；`extension/cursor.js`：光标与动效。
- `extension/popup.*`：弹窗；`install.mjs`：桥管理、更新及旧注册兼容。

版本源为 `.zcode-plugin/plugin.json`，MCP/桥从该文件读取版本；扩展清单同步版本并由测试核对。交付运行行为变更时必须递增版本：兼容修复用patch，新增完整能力用minor；未推送的本地候选也要有新版本，不能沿用旧版本掩盖运行差异。一起核对源码清单、可选市场条目、预览包、桥实际版本和扩展加载版本，未启用的部分明确标记。修改 UI 必须检查真实渲染；本地预览不能当成用户实际安装入口已经更新。提交、推送、标签和 Release 按用户授权执行。不要提交 token、个人配置、浏览器 profile 或测试截图里的业务数据。

## 停用与回滚

1. 扩展弹窗点“断开”，在浏览器扩展页停用或移除。
2. 从所用 agent 配置中移除对应 MCP 条目，保留其他配置。
3. 停止命令行含 `server/bridge.mjs --bridge` 的对应进程。
4. 配置、token 和日志位于 `~/.zcode/ai-browser-control/`；扩展设置位于浏览器自己的扩展存储。

本轮源码回滚点在 REQUIREMENTS.md 中，回滚仅针对本轮 diff。不会重置浏览器登录态、用户配置或其他项目文件。
