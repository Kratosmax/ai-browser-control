# 验证记录

## 2026-11-09：0.11.0仓库交付

用户授权将已验收的0.11.0提交并推送现有仓库main。推送前45个源码文件的SHA-256均与已验收交付回执一致，随后仅更新README发布状态和本记录。Node55项、真实Edge UI19项、动态列表7项、扩展→桥→MCP链路及技能格式校验通过；日常TAPD后台打开未获得窗口焦点、菜单与光标保持超过13秒及选项移动均现场验证，未提交业务数据。

本次不创建标签或GitHub Release；日志、截图、浏览器profile和本地包不入库。下方“本地候选/未推送”等为对应阶段历史状态，实际推送提交及远端核验回执保存于temp/qa/v0110/。此前后台脚本注入暂停的具体原因仍未查实，未在本版本中宣称已修复。

## 2026-11-09：0.11.0连续悬停与指定网址后台打开（本地候选）

- 用户反馈悬停后点击光标像从空白位置进入，且停留后隐藏；随后补充“AI打开指定网址会把Edge拉到前台”。已明确后者是AI新开指定网址，不是网站按钮自行window.open。本轮统一0.11.0：保留原17工具，新增browser_open，共18个；插件/扩展/父市场版本同步，尚未推送。
- 旧代码首次光标使用虚构偏移点作为起点；自动隐藏只改变视觉透明度，不派发鼠标离开事件。现场在TAPD以DOM悬停后等待约12.9秒，OP功能优化菜单仍可见，再悬停到选项亦保持可见；未复现“光标淡出必然关闭菜单”，不据此否认用户在其他操作序列中的现象。旧DOM点击也没有同步hovered状态，本轮补齐。
- 首次显示直接位于已知目标；后续沿上次位置衔接，关联菜单内改用直线。DOM悬停事件关闭旧菜单导致页面重排时，光标立即按同一元素的新位置重新对齐，测试断言其位置落在真实触发器中心，避免停在旧坐标的空白处。DOM点击前进入目标悬停状态，再次校验位置并校准视觉端点；不盲点隐藏的旧目标。关联弹层可见时保持光标，菜单隐藏/淡出/移除后解除，恢复原10秒或用户保存的计时；0秒隐藏设置与轨迹独立计时继续生效。
- 保持由相关节点MutationObserver及进入/离开、过渡完成事件更新，不持续运行动画帧循环、不派发定时保活鼠标事件、不修改网站菜单样式。它不保证网站自己的关闭策略永不生效。页面代理6→7，视觉光标使用新代际并清理旧层，可在既有页面热更新；inspect.cursor返回位置、保持与可见状态。
- browser_open使用chrome.tabs.create({active:false,windowId})；可选已有授权tabId选窗口，否则取最近普通窗口；不调用windows.update/create或激活tab，没有窗口则明确拒绝，不自行启动浏览器。返回实际tabId/active、窗口focus前后与授权状态；自动授权关闭时不授予新页权限。仅处理用户指定HTTP(S)网址，不拦截网站按钮弹窗或用户手工操作。
- Node55/55通过：新增后台打开、授权边界、无窗口不创建和非法协议回归，原安装/连接/诊断等通过。真实Edge MV3→桥→MCP：后台新建两页并按新ID读取，旧选中页与窗口focused状态不变、onActivated事件为0；悬停11秒后菜单及光标保持，随后跨容器click按trigger-leave→option-enter→option-click顺序，菜单关闭后解除保持。测试为隔离profile/本地fixture；Windows桌面其他应用的真实前台状态待用户日常链路最终核对，不将headless窗口属性当作所有OS策略保证。
- 真实Edge UI19项通过：首帧无虚构起点、连续移动采样、保持后恢复隐藏、菜单淡出解除、0秒选择和轨迹、深色/200%缩放。动态列表7项回归通过；仓库技能、安装指引与接入规范同步browser_open，避免客户端缺失接口时静默绕路到前台浏览器入口。
- 用户重载扩展并重启宿主后，正式工具目录18项及桥/扩展0.11.0均已确认。日常browser_open后台新开原TAPD列表，回执active=false、windowFocusedBefore=false、windowFocusedAfter=false，紧邻回查原选中标签ID一致；按新tabId读取成功。较晚回查其他窗口标签列表有变化，未将整个测试期间的所有变化归因于插件；新TAPD页仍未选中。
- 日常TAPD后台DOM悬停后，三段等待累计超过13秒，inspect确认关联菜单visible=true、cursor.held=true/visible=true且位置保持在“创建”中心；随后hover“OP功能优化”，菜单仍可见，光标位于该选项中心、未禁用未遮挡。未点击创建类型或提交业务。新增测试标签页保留为后台供用户查看，现场证据temp/qa/v0110/live-verified.json。最初指定来源tabId尝试被同页未完成操作保护拒绝、没有新建；按接口默认窗口策略不指定来源后成功。没有结束MCP管道，未改用户配置、权限或输入模式；此前后台脚本注入暂停原因仍未查实。

证据与回滚：temp/qa/v0110/；本地预览temp/ai-browser-control-0.11.0-local-preview.zip。重跑README的Node命令及三个browser-*.py；最终实际命令/结果与源码哈希另存本地交付回执。未提交、推送、创建标签或Release。

## 2026-11-09：0.10.1仓库交付

用户授权将已验收改动提交并推送现有仓库main；本次提交包含0.9.1连接恢复与有界日志、0.10.0的17工具与技能、0.10.1非标准菜单项定位补丁。推送前源码逐文件SHA-256与已验收交付回执一致，随后仅更新README发布状态及本记录。Node54项、真实Edge扩展链路、UI16项、动态列表7项及技能格式校验通过；日常TAPD悬停、菜单ref、inspect/wait现场验证通过，未提交业务。后台脚本注入暂停原因仍未查实。

temp目录中的日志、截图、浏览器profile、预览包、哈希与回滚证据不入库。下方“本地候选/未推送”等描述是各阶段历史状态；本次不创建标签或GitHub Release。实际远端提交核验回执另存本地交付目录。

## 2026-11-09：0.10.1非标准菜单项定位补丁（本地候选）

- 0.10.0正式17工具加载后，日常TAPD在DOM模式下使用browser_hover成功展开“创建”菜单；snapshot与wait读到“OP功能优化”等选项，截图确认菜单可见，未点击任何创建类型或提交业务。现场随后发现菜单选项未获得ref；只证明悬停展开通过，不声称后续菜单定位已经完整。
- 同次现场第一次后台snapshot在scripting.inject超时11秒，底层注入未返回；截图被同tab未完成操作保护拒绝。用户选中页面后原注入回执返回，累计149406毫秒，后续snapshot成功。日志证明卡在脚本注入且可见后恢复，尚不足以区分浏览器节能冻结、页面生命周期或其他具体原因。未把该情况当作后台能力全部验收成功。
- 0.10.1补充tabindex元素、aria-haspopup+controls/owns关联的可见弹层及menu/listbox中的li和自绘pointer项；快照inPopup标记、popup-then-viewport优先级；inspect返回关联popups可见性和候选项数；wait复用同一候选集。仅在明确弹层范围内扩大自绘元素识别，不把普通页面正文全部视为按钮；真实role保持不变。
- 页面代理5→6，插件/扩展/父市场同步0.10.1；工具数量17及schema不变，不需要再次重启MCP客户端。源码候选识别已通过Node54项、真实Edge扩展链路及7项懒加载回归；新增场景证明无role的li/div可wait、snapshot取得ref、inspect关联及点击本地fixture，180个可见控件下菜单项仍保留。UI回归结果见本阶段交付回执。
- 用户仅重载扩展后，正式browser_status确认桥与扩展均0.10.1；日常TAPD在DOM模式下再次hover“创建”，wait及截图确认菜单展开。9类创建选项全部有ref，触发器inspect返回关联弹层visible=true；“OP功能优化”项inspect确认visible=true、disabled=false、obscured=false、identityChanged=false，按精确name等待成功。仅展开及读取，未点击创建类型或提交表单；不声称业务创建已验收。候选包含li与内部span/图标，共30个ref，不等于30种创建类型。
- 现场原始证据temp/qa/interaction-010/tapd-hover-010.png、tapd-hover-010.json、tapd-injection-timeout.json；0.10.1现场回执temp/qa/interaction-0101/tapd-live-verified.json。真实Edge测试使用独立profile和本地fixture，未提交业务数据。UI16项通过；后台注入暂停的具体原因仍未查实，不能据本次前台成功宣称该边界已修复。

## 2026-11-09：0.10.0菜单、特殊交互与状态能力（本地候选）

- 需求来源：用户在TAPD的“创建”按钮上发现仅click无效，要求补充因插件缺少动作、接口或状态导致AI无法执行的能力。本轮共17个工具：新增hover/focus/drag/select/set_checked/inspect/wait；click支持右键、双击、长按和元素内相对位置，press开放已有ref定位并补组合键。源码、扩展及可选父市场同步0.10.0。
- MCP目录与桥校验统一到server/protocol.mjs，包含有界时长、ref、position、选项数组与等待条件校验；保留原10个方法兼容。快照增加禁用/焦点/勾选/选中/弹层/忙碌等状态，inspect补位置、遮挡、身份变化和原生select选项。wait不更新refs，不以等待超时推断业务动作失败。页面代理代际4→5，新扩展可在旧业务页注入，无需刷新业务页。
- DOM悬停补pointer/mouse enter、over、move、leave，支持JavaScript菜单；不谎称支持CSS :hover。CDP真实交互沿用原cdpEnabled并保留用户选择；独立截图授权不充当交互授权。下拉select和焦点使用DOM语义。浏览器原生菜单/系统弹窗、跨域iframe、canvas内部目标不在支持范围。长按不额外派发click，CDP浏览器释放时仍可能生成click。
- 特殊动作核对目标身份和遮挡；拖拽两个端点需同时可操作，CDP按下前移出旧悬停菜单再重定位，移动回执慢时按实际耗时推进，异常清理释放鼠标/修饰键。结果仍actionDispatched/unverified，幂等勾选和原生选择仅验证控件状态，不声称业务已保存。错误带结构化code。诊断沿用1 MiB×3轮转并覆盖新动作阶段。
- Node54/54通过。覆盖原连接/安装/懒加载身份保护、参数校验新增分支、DOM不偷偷开启CDP、目标ref按键聚焦顺序、CDP按下失败仍释放鼠标及修饰键。真实Edge MV3→临时桥→MCP验证DOM悬停、右键、双击、长按、分裂箭头、焦点组合键、原生单/多选、幂等勾选、状态/等待、HTML5拖放；CDP验证CSS悬停、组合键、后台指针拖拽且选中标签不变。原连接故障和有界诊断回归继续通过。
- 测试中先发现分裂箭头测试坐标落在按钮padding，改为依据真实箭头区域定位；CDP后台每次mouseMoved回执约1秒，固定12段导致11秒超时，已按实际耗时推进；离开CSS悬停菜单引发布局变化被身份/位置校验拒绝，已在按下前重新定位源。保留失败诊断记录，不以放宽超时或停用校验使测试通过。
- 真实Edge UI16项、动态列表7项、仓库技能格式校验均通过。popup-light.png已视觉检查v0.10.0及“CDP真实交互”文案。技能新增references/interactions.md，接入规范、安装器生成指引和README同步；不改用户个人规则或其他客户端配置。
- 日常桥已定向升级0.9.1→0.10.0，MCP进程未结束。扩展及本聊天工具目录尚待用户重载/重连；日常TAPD仅复现过旧DOM点击没有展开菜单，尚未声称新版悬停在该站验收成功。真实功能测试全部使用独立Edge profile和本地fixture，未提交任何业务数据。

证据与回滚：temp/qa/interaction-010/；本地预览temp/ai-browser-control-0.10.0-local-preview.zip。重跑README的Node命令及三个browser-*.py。当前未提交、推送或创建Release。

## 2026-11-09：0.9.1版本与有界诊断日志（本地候选）

- 修正上一阶段运行代码交付仍沿用0.9.0的问题：插件版本源、扩展清单、父目录可选市场条目与README同步0.9.1。README补充运行行为变更交付时递增版本及实际入口核验规则；提交、推送和Release仍按用户授权单独执行，本轮尚未发布。
- 桥日志改为固定元数据JSON事件，记录排队/派发/结果/超时、轮询和HTTP异常；扩展记录worker会话、连接代际、命令ID、具体Chrome/页面代理阶段、耗时、重试间隔和HTTP状态码。数据白名单不含页面地址/标题/正文、输入值、截图、token或原始错误正文。
- 当前bridge.log加.1/.2共三份，每份最多1 MiB，单桥最多3 MiB；启动裁剪旧超大日志，轮转失败跳过追加。所有新桥后台启动入口取消stdout文件重定向，避免绕过限制；主进程仅在终端打印启动文本，非交互启动失败记录固定错误码。
- 扩展环形记录最多128条且少于64 KiB，200毫秒合并存储、底层存储未结束前只有一个写请求；诊断网络补传独立于命令通道，重连自动分批补传。worker重启可能重复上传同一session+seq，按这两个字段识别；记录会滚动覆盖，不保证永久保留或冻结/存储故障时仍可持久化。
- Node51/51通过：新增日志字节轮转/旧大文件收敛/轮转文件故障、诊断来源校验与批次上限/字段白名单、扩展数量和字节双上限/worker恢复、存储永久悬挂不堆积写请求、断网补传及prepare悬挂阶段记录。原连接、安装、版本一致性回归通过。完整输出为temp/qa/diagnostics-091/node-tests.txt。
- 真实Edge MV3→桥→MCP全部通过：同一命令ID关联command_deliver和扩展command_end，phase=prepare、outcome=timeout、实测11016毫秒；桥与实际扩展版本均0.9.1。临时桥停止后弹窗退出绿色，原端口重启后自动连通，断线诊断补传成功。证据temp/qa/diagnostics-091/diagnostics-real-edge.json、browser-extension-results.json。
- 真实Edge UI16项通过，包括实际清单版本显示、断线异常、连接按钮、输入/截图独立开关、动效、深色和200%缩放。截图popup-real-bridge-disconnected.png显示v0.9.1及“连接中断，自动重试中”。测试使用独立profile/本地fixture，未操作用户业务正文或表单。本轮未改懒加载算法，未重复browser-loading.py。
- 日常桥经已有更新器定向替换17653实例，实际health版本0.9.0→0.9.1；未结束MCP进程、未改客户端配置。用户重载扩展后，正式browser_status确认version与extensionVersion均为0.9.1、connected=true、standby=false、pending=0。browser_list_tabs往返成功；磁盘日志包含同一ID的command_deliver/command_result及扩展command_start、tabs.query起止、command_end。配置与token文件哈希未变，现有日志文件均小于1 MiB；证据live-after-reload.json、live-log-check.json。

重跑：README的Node命令、python -X utf8 tests/browser-extension.py、python -X utf8 tests/browser-ui.py。当前改动及回滚包保存在temp/qa/diagnostics-091/，本地预览为temp/ai-browser-control-0.9.1-local-preview.zip；均不进入仓库。

## 2026-11-09：连接假正常与轮询悬挂修复（本地候选）

- 已执行 `git pull --ff-only`，远端和本地基线均为 `8f662fb` / 0.9.0。用户原始截图、03:01至03:07故障窗口的桥日志及修改前源码保存在忽略的 `temp/qa/connection-20261109/`。
- 日志证明03:01:07最后一次poll后，03:04:32 unpair、03:04:33 pair，没有新poll，直到03:07:14才恢复。历史日志未记录被派发的具体命令，不能确认当时是哪一条Chrome API悬挂，也不能归因其他agent抢占。
- 已复现代码缺陷：`execute`无限等待会堵住单个pollLoop，alarm只检查loopPromise是否存在，connect仅重新pair无法恢复；弹窗以paired判连接，且定时refresh错误被吞掉。桥unpair不清旧心跳也会造成短暂假连接。
- 修复：11秒命令等待上限；超时回执与id去重；底层未结束时锁住该tab防止重复动作；派发Chrome动作前后检查连接代际和超时状态，包括页面代理内部授权/注入的异步边界。已发给Chrome的动作仍可能结束，故保持结果不确定；不声称超时等于取消。
- 配对请求去重、旧代际响应隔离、所有传输请求可失效且有硬期限；结果重传前重新配对；弹窗核对桥自身心跳和近期轮询，读取失败显示异常；显式断开只清当前扩展的活动poll/心跳。MCP错误文案区分桥可达与扩展通道不可用。新增桥日志仅含派发id/method。
- Node44/44通过。新增回归覆盖悬挂命令到期继续poll、同id不重放、迟到prepare/注入不写入、pair-only不假连接、断开后旧pair不复活、响应正文不结束仍超时、结果403后重新配对、unpair不影响其他扩展。
- 真实Edge MV3→临时桥→MCP：故意挂起Chrome prepare，手动断开重连后恢复list_tabs；释放旧Promise后页面计数仍0。真实停止临时桥时弹窗退出已连接，原端口桥恢复后自动重连并可list_tabs。`tests/browser-extension.py`整体通过。该测试仅使用独立profile/本地fixture，未操作用户业务页面。
- 真实Edge UI16项通过，包含定时popup_status失败不保留绿色旧状态。截图 `temp/qa/popup-real-bridge-disconnected.png`、`popup-connection-error.png`，结构化结果 `browser-extension-results.json`、`browser-ui-results.json`，本次归档另存connection-20261109目录。
- 独立只读代码审查曾发现pageAgent内部guard遗漏，已修复并补注入迟到回归；最终审查未发现其他阻断项。尚不能验证所有浏览器挂起/系统休眠策略，完全冻结worker事件循环时定时器也无法实时运行；恢复后需重新确认通道。
- 日常桥已由旧PID56428替换为加载本轮源码的PID55672，仍使用127.0.0.1:17653；配置与token文件哈希未变化。用户确认重载扩展后，正式MCP回读connected=true、standby=false、pending=0、心跳距回读3130毫秒；list_tabs命令往返成功，返回5个标签页，未读取业务页正文。当前MCP进程未重启，状态说明文案仍为旧文案，不影响桥端修复生效。

重跑命令：沿用README中的Node、browser-ui.py、browser-extension.py。本阶段未更改页面懒加载算法，未重复browser-loading.py。此阶段曾保留0.9.0，随后已在上方版本与诊断日志阶段更正为0.9.1；未提交、推送或发布这次修复。

## 0.9.0 仓库更新与本机升级（2026-11-05）

用户已授权提交、推送现有GitHub仓库并更新本机。本轮包含此前验收的交互改造、输入/截图独立开关、动态列表能力和仓库分发技能；版本由0.8.1升级为0.9.0。插件清单为服务版本源，扩展清单同步版本，本地父目录市场条目同步0.9.0。未创建标签或GitHub Release。

本机Edge的解压扩展路径、Codex/ZCode的MCP入口均指向本仓库；不是另一份待覆盖的副本。更新程序保留客户端配置，仅拉取源码并重启旧版本桥。扩展运行版本须在用户重载后核对，不能用磁盘版本冒充运行版本。回归结果和推送/更新回执保存于忽略的temp/qa目录；历史未提交状态只描述当时阶段。

0.9.0打包前重跑：Node37/37、browser-ui.py、browser-extension.py、browser-loading.py及技能格式校验均通过。另修复旧ZCode兼容注册只复制SKILL.md而遗漏references的安装缺口；安装/显式注册刷新回归核对参考文件与仓库字节一致。Codex旧兼容指引增加browser_scroll并指向仓库技能，默认update仍不重写客户端配置，需用户显式要求refresh-registration才重放注册。

## 2026-11-05：仓库分发技能的通用动态列表流程

本阶段仅修改仓库分发文档，不改用户个人技能或浏览器运行代码。`skills/ai-browser-control/SKILL.md` 增加动态列表路由，`references/dynamic-lists.md` 描述追加式懒加载、独立容器、虚拟列表、加载更多、分页、无限流、范围/结束证据、跨批去重及按业务身份验证操作。AGENT-INTEGRATION.md 和 README 引用同一份流程。

技能结构校验 `python -X utf8 <skill-creator>/scripts/quick_validate.py skills/ai-browser-control` 通过，frontmatter无BOM，引用路径与插件清单skills入口检查通过，预览包包含新增参考文件，`git diff --check` 通过。按实际能力审查：auto有预算且恢复原位；observed没有ref也不跨调用累计；分页需要逐页确认；相似按钮的expectedContext是包含检查，不能代替唯一身份判断。

场景核对覆盖：商品列表分批追加、固定行数的虚拟表格、订单多页汇总、多个独立滚动区域、无限评论/日志、上下文混入相邻记录、位置排序变化及点击失败。此为规则/能力一致性检查，未另称这些站点都已现场验证；既有真实Edge夹具与携程证据见下文。纯文档修改没有重复运行浏览器测试。

回滚包 `temp/qa/before-general-list-skill.zip`。本轮尚未提交、推送或发布；用户取得该版本后由插件清单skills目录加载上述规范，不能把本地文件修改说成远端用户已经收到。

## 2026-11-05：纠正懒加载遗漏和错误目标验收

### 重开 Codex 后现场复核

新版10个工具及连接恢复，实际携程 tabId=1891451801（后台），DOM输入+独立CDP截图。通过唯一“我知道了”关闭欢迎提示后，快照确认弹窗移除、携程重新查询。未点击任何航班或下单产品。

现场发现上下文提取仍会跨入整个列表，把多班航班号包含进单个按钮的 context。这会削弱 expectedContext 的错配保护，因此不能沿用之前的“保护已完整验收”结论。已限制上下文不跨入含其他独立按钮的非语义容器，并增加普通div卡片回归：各按钮只包含本卡片航班，相邻航班号不匹配。页面代理更新为4，以便仅重载扩展就能在既有页面注入，MCP工具参数未变。

首次回读未取得列表结束证据，没有将当时7个订票按钮的末项认定为最后一班。回滚包 `temp/qa/before-live-context.zip`。

用户仅重载扩展后，代理4现场确认各订票按钮context只含本卡片航班。默认探测使13个订票ref增加至98个；两次从头到尾遍历，末端页面高度均11685，末项均南航CZ3999→CZ8964，后面直接接站点页脚，未见继续/分页按钮。这是当前查询页面末端证据，不是后端全部库存证明；正文与累计观察仍有截断标记，dataCompleteness保持unknown。

现场错配测试：第一班ref传入AQ1723，被expectedContext拒绝；随后回读没有航班展开。按正确身份完成ZH9675展开→AQ1723展开→CZ3999/CZ8964展开→返回第一班，逐次快照核对同一航班号与收起状态、正文产品区；末项及返回第一班另有截图。

末项首次远距离定位返回“目标不在可操作的视口内”，未派发点击，回读确认仍为订票。用正式scroll向上定位到末项后，重新快照取得ref，再次点击成功。该错误已识别，没有按clicked计数误报。远距离prepare首次未进入视口的具体原因尚未查实，不宣称已修复。

证据：`temp/qa/ctrip-live-v4.json`、`ctrip-live-v4-last.png`、`ctrip-live-v4-return.png`。原先错误流程的撤回记录继续保留，本轮现场结果不覆盖它。37项Node、真实Edge UI、懒加载/虚拟列表回归及MV3→桥→MCP集成均通过。

**撤回上轮携程流程“全部完成”的结论。** 当时只确认了已加载末项的展开；没有证明其为用户要求的最后一班。返回成功或多出“收起”按钮也不能证明目标身份正确。原始 `temp/qa/ctrip-replay.json` 与截图保留；复核结论另存 `temp/qa/ctrip-replay-review.json`，不得再据原回执认定任务通过。

本轮行为变化：

- 快照默认有界滚动探测懒加载，累计观察后恢复原滚动位置；最大约8秒/40轮。返回停止原因、截断标志和底部文本，始终保留 `complete=false`，没有把底部暂时稳定当作全量证明。操作后用 `load=current` 回读，另有 `browser_scroll` 支持继续探测。
- ref 绑定按钮及周边卡片身份；滚动、动画后再检查，节点复用成另一业务对象时拒绝点击。同名按钮需 `expectedContext`，例如完整航班号，错配直接拒绝。
- 点击回执明确 `outcome=unverified`；必须回读同一业务身份的展开/跳转结果，不能只数“收起”。接入规范、项目技能和工具描述同步此验收要求。

验证：Node 37/37 通过；真实 Edge UI、MV3→桥→MCP 集成通过。新增 `tests/browser-loading.py` 在真实 Edge 验证650毫秒延迟分批加载6→12→18、固定5个节点的30项虚拟列表、独立滚动容器、弹窗阻塞、无限列表预算停止，以及复用节点/定位滚动期间身份变化的点击拦截。集成测试从 MCP 默认快照开始，在后台加载18项、滚动末尾、拒绝错配航班，再点击 F018 并回读该航班展开，选中标签不变。

重跑：沿用下文三个命令，另执行 `python -X utf8 tests/browser-loading.py`。证据 `temp/qa/lazy-identity-node-tests.txt`、`browser-loading-results.json`、`browser-extension-results.json`、`lazy-last-verified.png`。本阶段回滚包 `temp/qa/before-lazy-identity.zip`，哈希见同名JSON。

边界：滚动稳定、正文长度不变或 DOM 就绪不能证明任意站点业务全量；分页按钮不会自动点击，多个滚动区域不会自动遍历全部。超过预算或观察截断必须继续核对或报告未完成。新增版本尚未在用户日常携程页验收；需重载扩展及重连MCP刷新新增的工具/参数，不能用本地夹具通过替代该验收。

## 2026-11-04：交互改造本地预览

基线为 `eb2c5ce384c4d9f5329d7c3770f44e7fa4a04385`，正式清单仍为 0.8.1；本轮未提交、未推送、未发布。需求来源见 REQUIREMENTS.md，第三方接入见 AGENT-INTEGRATION.md。

### 已完成

| 验证 | 真实结果与证据 |
| --- | --- |
| Node 协议、安装兼容和扩展回归 | 35/35 通过，`temp/qa/viewport-priority-node-result.json`；此前 34 项完整输出保留于 `temp/qa/node-tests.txt` |
| 真实 Edge UI | Edge 156.0.4314.58，独立 headless 配置，ISOLATED 脚本 + closed Shadow DOM；`temp/qa/browser-ui-results.json` |
| 强制居中的反例 | 旧版两个同列目标均定位到 (235,375)，页面 scrollY 从 600 变为 730；新版分别为 (235,275)/(235,505)，scrollY 保持 600。该行为能解释这一类“光标不移动”，不代表所有旧版瞬移都已定位 |
| 动画中间帧 | 真实 Edge 帧采样包含多个不同中间坐标，最终抵达目标；浏览器实际录屏生成 `temp/qa/cursor-motion.gif` |
| 光标停留和性能分支 | 真实计时检查 8.95 秒仍可见、10.35 秒已隐藏；0 秒配置生效；静止不继续请求动画帧；减少动态效果偏好生效 |
| 弹窗 | 连接/断开、授权/释放、CDP 开关、空值校验、错误恢复、长标题、系统页禁用、深色与 200% DPI；截图见 `temp/qa/popup-*.png` |
| 真实扩展全链路 | 独立 Edge MV3 → 临时桥 → MCP stdio；真实 CDP 填表、点击与截图，关闭后 DOM 填表/点击，实际页面计数与文本回读符合预期；`temp/qa/browser-extension-results.json` |
| 后台操作 | 目标标签未选中时操作完成，不切换选中页；本轮约 0.07 秒（一次 snapshot + DOM 点击，环境相关，不是性能承诺） |
| CDP 与释放 | 关闭后解除已有调试器；DOM 模式不重新附加；自动授权下释放有效；用户取消调试后不偷偷重新附加 |
| 隐私与状态 | 截图期间切页会丢弃图片；断开状态跨后台重启保留；默认更新不重写 agent 配置，不依赖旧注册回执 |

旧“隔离世界 + 封闭 Shadow DOM + fixed 定位造成 Edge 渲染限制”的归因未证实。参考扩展也使用这些机制，本轮相同机制下可以采到实际中间帧，因此不沿用旧归因。

### 日常 Edge 追加验收（2026-11-04）

本轮携程重放额外暴露：150 个控件上限会挤掉 DOM 靠后、但屏幕内可见的“我知道了”弹窗按钮。已改为视口内控件优先入选、最终仍按 DOM 顺序输出。Node 回归和真实 Edge 的“180 个离屏按钮 + 屏内弹窗”均验证可定位并关闭弹窗；证据 `temp/qa/viewport-modal.png` 与 `browser-ui-results.json`。使用新页面代理标识，重载扩展后即可在既有页面注入修复，无需刷新业务页面。用户实际重载时也刷新了携程，弹窗已消失，因此该真实弹窗关闭尚未复测；新快照已确认返回 viewport-first。

刷新后重新完成：深圳航空 ZH9675 展开 → 九元航空 AQ1723 展开 → 当前已加载列表末项国航 CA1392 中转组合展开 → 返回第一班并重新展开。逐次快照确认，最终三个“收起”，截图确认第一班在视口内。列表在滚动后曾继续加载和重排，更新 ref 后再次展开末项；这里的“末项”只指当时已加载 DOM，不宣称已取齐所有航班。证据 `temp/qa/ctrip-replay.json`、`ctrip-replay-final.png`。

用户重新加载扩展后，经当前正式 ai-browser MCP 在 `http://127.0.0.1:17654/` 验收，CDP 由用户在弹窗中关闭：

- 页面为 hidden 时，DOM 填写 `background-ok`、点击“记录一次”，回读计数 1、记录文本一致。
- 第一次截图时目标已不再选中，工具明确拒绝后台截图；重新查询标签列表证实目标 active=false，没有为截图切页。
- 用户将 Edge 与聊天并排、保持测试页选中后，快照确认 visibility=visible；DOM 填写 `visible-dom-ok` 并点击，回读计数 2、记录文本一致。
- 用户先点击扩展图标授予真实 activeTab 临时权限后，**无 CDP 当前页截图成功**，无需测试夹具的额外站点权限。
- 证据：`temp/qa/live-edge-acceptance.json`、`temp/qa/live-edge-dom.png`。日常浏览器动画中间帧本次没有录制，最终流畅度由用户直观确认。

### 明确的验收缺口

- 自动化测试使用独立 Edge 配置；用户已在日常 Edge 重载并完成上述功能验收，并在携程演示后明确确认“效果很好”。新增的独立轨迹设置需再次重载后验收。
- 正式清单仅新增 activeTab 临时权限，HTTP(S) 站点权限不扩大。自动化正向截图夹具使用额外 all_urls 权限；日常 Edge 的真实 activeTab 授权截图已独立通过，两者证据分开保留。
- headless Edge 对未选中标签仍可能返回 visibilityState=visible；真实集成按 tab.active=false 避免等待光标动画，可见性隐藏分支另有明确标为模拟的测试。没有声称验证了所有后台节流策略。
- 日常 Edge 的新版携程截图验收见后文：已取得真实后台截图。首轮较晚回查的一次选中变化原因未查实，不能被随后复测通过所抹去。账户及业务画面仅在忽略的本地证据目录保存，不进入源码或预览包。
- 本轮没有在用户 ZCode 新会话中重新接入，也没有执行线上 git 更新、创建标签或发布 Release；配置契约和本地更新逻辑已验证。

### 重跑

```powershell
node --test tests/bridge.test.mjs tests/install.test.mjs extension/tests/mock.test.cjs extension/tests/expired-result.test.cjs
python -X utf8 tests/browser-ui.py
python -X utf8 tests/browser-extension.py
```

Python 验收复用本机已有 Playwright、Pillow 与 Edge，不安装工具副本。UI 对照要求保留基线 Git 历史。所有测试页与测试桥使用临时配置；不控制用户已有页面。

### 独立轨迹与截图/读取边界补充（2026-11-04）

- 新增“更多设置 → 轨迹残留时间”，默认 5 秒、0–60 秒，与光标隐藏时间分开保存。真实 Edge 中验证：光标立即隐藏后轨迹仍存在，4.5 秒仍保留、5.3 秒已回收；0 秒关闭轨迹。
- 每次移动仅维护一条 SVG 路径，最多 64 段，超出时清理最旧路径；结束后由浏览器动画和单次定时器淡出回收，不为残留持续运行 rAF。
- 新增 `coverage` 元信息，明确只读取已加载 DOM，标记正文截断及元素扫描上限，dataCompleteness=unknown。本轮没有实现通用自动滚动、分页、虚拟列表累计收集器。
- 补充真实 Edge CDP 后台截图：目标 tab.active=false，另一标签保持选中；在后台更新目标页背景色后，Page.captureScreenshot 返回的 PNG 像素匹配新颜色 (17,34,51)，截图前后选中标签 ID 不变。证据：`temp/qa/browser-extension-results.json`、`temp/qa/cdp-background-screenshot.png`。
- 已核对本机参考扩展 1.26.1021.11019 的截图代码：存在 Page.captureScreenshot 和内部 CDP 录屏取帧路径。此结论限定到该安装版本；公开文档中的“完整 CDP 访问”是开发调试权限，不能据用户未启用该权限推断内部完全不使用 CDP。
- 资料核对记录：`temp/qa/screenshot-research.json`。Chrome 官方 captureVisibleTab 说明其参数为窗口，限制为当前活动标签；本项目关闭 CDP 时按此能力工作，不为截图偷偷切换标签。
- 当时仅有本地夹具测试；后续用户实际携程截图验收见下文，仍不能据当次成功宣称长期不会检测或拦截。

来源：[Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)、[OpenAI Browser 开发者模式说明](https://learn.chatgpt.com/docs/browser#developer-mode)。

### 输入与截图开关拆分（2026-11-04，替代此前总开关）

- 用户明确选择：输入默认 DOM，允许截图独立使用 CDP，界面明确标注。新安装默认输入 CDP=false、截图 CDP=true；已显式保存的输入值保留，截图选项可单独关闭并持久化。
- 输入关闭不会禁止已独立允许的截图；截图路径只调用 Page.captureScreenshot，完成后解除仅为该次截图新建的调试附加。已有输入用途的调试附加不由截图擅自解除。
- 新增测试验证默认模式、两个开关相互独立、截图只调用捕获命令、临时附加的 attach/detach 成对发生、截图失败或成功均进入 finally 清理。
- 真实 Edge 集成已验证默认 DOM 模式下独立 CDP 截后台页，当前选中标签不变，截图后附加集合为空。弹窗两个开关的状态、交互、长文本、深色和高 DPI 已通过 Playwright 验收。
- 仅关闭独立截图选项时才使用 captureVisibleTab；两项均关闭才是本插件不调用 CDP 的模式。插件用途限制不等于浏览器 chrome.debugger 权限降级。
- 正式工具 browser_list_tabs 返回 inputMode 与 screenshotMode，可用于核对实际运行模式。拆分前回滚点：`temp/qa/before-screenshot-split.zip`。
- 用户已重载拆分后的版本。实际 browser_list_tabs 返回 inputMode=dom、screenshotMode=cdp；真实携程验收如下。

### 用户实际携程后台截图（2026-11-04）

- 用户授权直接验证已打开的携程页面；没有开启 CDP 真实输入，没有点击预订或进入下单。
- 正式 MCP 核对模式为 DOM 输入、独立 CDP 截图。目标初始 active=false，截图返回真实机票列表 PNG，截图后仍可读到 7 个订票按钮，未见验证码、访问受限等可见提示。
- 首轮在较晚回查时发现选中标签从其他页变成携程；用户明确表示没有手动切回。原因尚未查实，保存 `temp/qa/ctrip-cdp-first.json` 与截图，未将其归因于用户、截图或其他扩展。
- 紧邻复测把“读标签 → 截图 → 再读标签”放在同一次执行中，约 221ms。前后目标均 active=false，选中 ID 列表一致；随后再回读仍未选中，航班数据可读。
- 证据：`temp/qa/ctrip-cdp-background.json`、`temp/qa/ctrip-cdp-background.png`。当次独立 CDP 后台截图可用；首轮异常及长期风控兼容性均不因此视为已解决。

下列内容为历史记录，仅描述当时版本。旧“动画放弃”的结论不作为本轮交付状态。

---

版本：ai-browser-control 0.5.4（0.3 重命名+一键配对；0.4 多桥端口+退避；0.5 跨机器 token；0.5.4 待机感知）。

## 0.5.4 新增验证

真实环境发现：Edge 会把扩展后台 Service Worker 挂起（实测 7.6 分钟无轮询），期间 browser_status 误报"未连接"、/rpc 直接 503 拒绝。修复并覆盖：

- /status 增加 standby（待机）与 lastSeenAgeMs：待机如实显示，不再误报未连接（90 秒内视为在线）。
- /rpc 待机时挂住请求等待扩展唤醒（默认最长 25 秒）而不是立刻拒绝；唤醒后正常投递；超时给"点扩展图标立即唤醒"的可操作提示；从未连接过仍立即 503 带指引。
- 待机等待测试：251ms 后进入待机，/rpc 等 800ms 得到 504 待机提示；扩展恢复轮询后命令正常投递（22/22 通过）。

## 0.8.0 真实验证（2026-10-29，携程机票页）

- 动画引擎重写（CSS transition → rAF 逐帧插值）后，反爬站点全流程实测：
  关弹窗 → 展开航班 1 → 展开航班 2 → 依次折叠，6 次点击零失败，光标+拖尾全程平滑滑行
- 截图证据：滑动中光标+蓝色拖尾位于目标处 ✓；末次操作 10 秒（用户配置）后截图光标已淡出 ✓
- 用户肉眼同步确认滑动轨迹与淡出

## 0.8.1 最终状态（2026-11-04）

- 功能全流程在反爬站点（携程）真实验证通过：关弹窗、展开×2、折叠、跳转结算页
- 读取无痕（无提示条无 CDP）验证通过
- 光标动画：尝试 CSS transition / rAF / 弹簧物理 / WAAPI 四种机制，用户 Edge 上均表现为瞬移。
  判断为 Edge 在 content script 隔离世界 + closed shadow DOM + fixed 定位组合下的渲染限制，
  未能进一步定位。功能不受影响（CDP 点击精确到达目标坐标并正常响应）。
- 用户验收结论：功能可用，动画效果放弃

## 0.5.0 新增验证

自动化测试 20 项通过，0 项失败（真实输出 `tests/all-results.txt`；重跑命令同下）。0.5.0 覆盖新增：

- 跨机器防护：绑定 0.0.0.0 后，非回环来源无 token/错 token 均 401，正确 token 放行；本机回环豁免；/health 保持开放。
- 可选 IP 白名单：不在白名单的来源 IP 403，伪造 X-Forwarded-For 头不生效（按 socket 地址判定）。
- token 持久化：实例目录 `token` 文件（0600），64 位十六进制。
- install.mjs：远程注册缺 token 拒绝；带 --host/--token 时条目名 `ai-browser-<主机-端口>`、args 完整；bridge add 持久化 host 与 allowIps。
- 多桥实例白名单隔离（0.4.0 引入，延续覆盖）。

## 0.4.0 及以前

## 已通过

本机 Node v24.20.0。自动化测试 11 项通过，0 项失败，真实输出见 `tests/all-results.txt`。

重跑命令（在 `D:\04_tmp\SFTP\SFTP1\玩具\ai-coding` 目录）：

```powershell
node --test temp/plugins/ai-browser-control/tests/bridge.test.mjs temp/plugins/ai-browser-control/extension/tests/mock.test.cjs temp/plugins/ai-browser-control/extension/tests/expired-result.test.cjs
```

覆盖：

- MCP stdio 初始化（serverInfo ai-browser-control）、9 个工具目录、未知方法和错误响应。
- 本地桥：网页来源 403、无扩展时 /rpc 明确 503、/pair 首连登记（TOFU）、重复配对幂等、多扩展共存、单 poller 互斥 409、/unpair 后恢复拒绝、请求头与来源不一致拒绝。
- 白名单持久化：重启桥后已配对扩展直接可用。
- 配对文件原子写入（继承自 0.1.0 的修复）。
- tabId / ref / 参数白名单 / 导航协议校验。
- 扩展（Chrome API mock）：授权、释放、调试协议方法、按键映射；自动授权按需附加、拒绝非 HTTP 页、可关闭；一键配对、单轮询、25 秒限时、断线重试重新配对、结果重传不重执行；/result 404 丢弃后继续 poll。
- 页面 ref 生命周期、150 元素上限、隐藏元素过滤、密码值不输出（DOM mock）。
- MV3 清单、图标文件、popup 外部脚本、无 token 残留、插件目录/市场/版本一致性。

`server/bridge.mjs`、`server/mcp.mjs`、`extension/background.js`、`extension/page-agent.js`、`extension/popup.js` 的 `node --check` 通过。

### 0.3.0 修复的关键缺陷

- 结果回传读到不存在的 `pending.payload` 字段（重写遗留），导致执行结果永远无法送回桥接。扩展级 mock 测试发现，HTTP 层测试覆盖不到。
- `/rpc` 被放在"仅扩展"检查之后，本地 MCP 请求被 403 拦截。桥接集成测试发现。
- /result 404 需视为过期丢弃，否则扩展轮询被卡死（0.2.x 已修，0.3.0 重写时一度丢失，已恢复并有回归测试）。

上述模拟测试不等于真实 Chrome 扩展调试协议验收。插件配置做了 JSON 与路径检查，没有调用 ZCode 官方 schema validator。

## 0.1.0 时期的浏览器实测（历史）

用 ZCode 内置浏览器访问本地验收页：读取、填写通过；"记录一次"按钮点击超时、Enter 触发后计数仍为 0，未记录为通过，原因未查实。该结果只反映 IAB 通道，与新扩展无关。

## 尚待人工安装后的真实验收

### 2026-10-27 真实 Edge 验收（已通过部分）

- 0.3.x 扩展在真实 Edge 加载、弹窗显示、自动授权开关可用 ✓
- 一键配对真实桥接 ✓（但首测暴露桥的 bug：GET /poll 无 Origin 头被拒，扩展陷入"配对→403"循环；已修复为按白名单校验 X-Client-Id，Origin 存在时才校验一致性）
- 扩展断线自动重连：桥重启后 1 秒内自动恢复 ✓
- bridge_list_tabs：读到真实 Edge 的 8 个标签页，含目标 Magpie 页 ✓
- browser_snapshot：后台读取 Magpie（内网模型路由网关面板）标题、可见文本与交互元素成功，期间未切前台窗口、未动系统鼠标 ✓
- 后台点击链路（2026-10-27 OA 实测）：snapshot 定位"考勤"菜单 → click 展开 → snapshot 取"我的考勤" ref → click 跳转 → snapshot 读到考勤数据（工时/假期/迟到早退统计），URL 变化符合预期 ✓
- 期间发现并修复第 3 个真实环境 bug：页面代理抛错时 Edge 返回 result:null，后台解构崩溃吞掉真实原因；已透传页面错误并有回归用例（12/12 通过）✓

仍待验收：后台 click/fill/press 的真实行为、截图、导航、多 Agent 并用、ZCode 插件市场安装与新任务工具调用。

### 其余待办

- Edge/Chrome 加载 0.3.0 扩展：新名称、图标、弹窗显示与自动连接。
- 一键配对真实桥接；开启自动授权后，保持其他标签页/应用在前台，验证 snapshot、fill、click、press 不改变系统鼠标与当前标签页。
- 截图、导航、撤销调试授权后的错误提示；多 AI Agent 同时接入。
- ZCode 添加市场（dev-ai-browser-local）、安装插件、新任务实际调用工具。
- 读取用户实际打开的 Magpie 页面。

安装与验收步骤见 README.md。当前状态：源码和测试完成；市场待手动添加、插件待安装、真实浏览器试用待验。

## 遗留清理提示

旧版本配置目录 `%USERPROFILE%\.zcode\external-browser-control\`（含已废弃的 pairing.json 和 bridge.log）可自行删除；新版本使用 `%USERPROFILE%\.zcode\ai-browser-control\`。
