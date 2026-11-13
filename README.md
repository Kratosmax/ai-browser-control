# AI 浏览器控制

让支持 MCP 的 AI 助手按标签页读取和操作真实 Edge / Chrome。后台操作不切换标签页、不移动系统鼠标。

当前版本：0.17.3。系统性加固原生清理锁、权限代次、截图回传、DOM/表单身份与拖拽阶段校验，以及RPC畸形结果和启动器超时结算。新增固定可靠性验收入口、机器可读故障处理指引、版本与启动器加载状态检查。通过表示列明场景已验证，不代表所有网站无缺陷；不自动重放业务或更改用户权限。本仓库提供源码，不另设此版本的 GitHub Release。

本版更新了MCP启动器：在宿主MCP管理中断开并重连，再到浏览器扩展管理页重载扩展，使本版全部生效。browser_restart仅重载worker；launcherHealth未知或过期时不能声称启动器已更新。无需为此刷新业务网页，新的Agent10与旧代理并存并要求重新snapshot取新引用。

## 开始使用

需要 Node.js 22+、Edge / Chrome 120+。运行时零第三方依赖，无需 npm install。

1. 下载或克隆本仓库，放到稳定的目录。
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），启用开发人员模式，加载仓库内的 `extension` 目录。
3. 让 AI 按 [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md) 接入自己的 MCP 配置。规范包含通用协议、ZCode 配置和验收步骤，不需要运行注册脚本。
4. 在客户端MCP管理中连接服务，调用 `browser_status`。新建聊天未必会重启客户端共用的MCP进程。本地MCP启动即检查并拉起桥，默认端口17653；存活期间每5秒检查，失败退避至最多60秒，恢复后归零。扩展按自身退避周期接回，不需要额外工具调用。
5. 在浏览器中点扩展图标连接，授权当前页；也可由用户打开“自动授权所有网页”。

只读验收提示词：

> 使用 ai-browser 的 browser_status 检查连接，再用 browser_list_tabs 列出标签页。只读，不点击、不填写、不导航。

扩展弹窗只有一个连接/断开按钮；“CDP 真实交互”“允许截图使用 CDP”和“后台唤醒冻结页”三个用途独立可见。端口、光标与轨迹停留时间位于“更多设置”。用户主动断开后，扩展后台重启也不会自动连接。

## 输入、截图与后台唤醒独立设置

| 设置 | 默认 | 开启时 | 关闭时 |
| --- | --- | --- | --- |
| CDP 真实交互 | 关闭 | 浏览器真实输入协议 | DOM 点击、原生 value setter、input/change 及有限按键行为 |
| 允许截图使用 CDP | 开启 | 按 tabId 截当前或后台页；完成后解除仅为截图新建的调试附加 | captureVisibleTab，仅当前选中页，需用户点击扩展图标取得 activeTab 临时权限 |
| 后台唤醒冻结页 | 关闭 | 新读取的冻结页临时唤醒、核对并清理后继续DOM读取；不切页 | 已知冻结页立即返回TAB_FROZEN |

DOM内容读取仍走隔离脚本，导航走tabs.update。仅当独立后台唤醒开关开启且原生frozen=true时，新snapshot/inspect/wait请求允许先临时使用CDP生命周期active，随后继续DOM读取；正常页不附加，截图/输入权限不能替代此开关。默认 DOM 输入与独立 CDP 截图可以同时使用。已有用户显式保存的输入选择保留；新增截图选项默认允许，用户可单独关闭。

关闭输入 CDP 后会解除已有调试附加，DOM 输入失败不会自动启用真实输入协议。截图单独获准时仍可按需附加；仅为截图附加的调试器会在完成后解除。三个用途都关闭才是本插件完全不调用CDP的模式。

这只限制插件调用的用途，浏览器授予的 chrome.debugger 权限不会变成低权限或只读权限。网站可能忽略 DOM 非可信事件，应回读确认；DOM 按键不保证所有站点的默认快捷键都生效。

输入工具支持`mode=auto/dom/cdp`：auto遵守全局开关，CDP附加失败且尚未派发输入时自动降级DOM，同页后续auto沿用DOM；dom可单次解除附加后操作，不改用户开关。cdp仍须用户已开启真实交互。执行阶段失败或结果未知不自动重放，先截图/回读确认。网站出现错误页不能直接归因CDP，也不自动刷新或绕过验证码。新导航后清除该页的自动降级记录。

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
| browser_status | MCP、桥与扩展的实际版本和连接状态 |
| browser_restart | 重载本MCP工作进程以加载磁盘新版，保持stdio连接；在途操作拒绝，不重放动作 |
| browser_list_tabs | HTTP(S) 标签页、授权状态及 inputMode/screenshotMode |
| browser_snapshot | 默认滚动探测懒加载；返回当前正文、ref 与累计观察。load=current 仅回读 |
| browser_scroll | 主文档或指定容器向上/下、顶部/底部滚动；不点击、不切页 |
| browser_click | 按 ref 点击 |
| browser_hover / browser_focus | 悬停或取得页面内焦点 |
| browser_drag | 按源与目标ref拖拽 |
| browser_select / browser_set_checked | 原生select选择、幂等勾选状态 |
| browser_inspect / browser_wait | 读取元素状态、有条件等待 |
| browser_fill | 替换文本框或 contenteditable 内容 |
| browser_task | 查看、保留、整理或结束本任务创建的页面 |
| browser_batch | 最多4个不同页面的独立操作并行，截图以原生图片返回 |
| browser_press | 在目标标签页发送支持的按键 |
| browser_navigate | 导航到明确的 HTTP(S) 地址 |
| browser_screenshot | 按独立截图开关选择 CDP 或当前页截图 |
| browser_release | 释放此页，自动授权模式下也生效 |
| browser_open | 把指定HTTP(S)网址在已有窗口中新建为后台标签页，不激活窗口 |

每次快照刷新 ref。动作后重新读取快照确认；超时不等于失败，不直接重复提交、支付或发送。快照不读取 Cookie、localStorage 或浏览历史，也不输出密码框的值。单结果和批次统一按UTF-8限制10MiB，超过时返回RESULT_TOO_LARGE小错误；桥拒绝无效结果时返回RESULT_REJECTED并恢复取新命令，不重放页面动作。

0.10.0提供17个工具。click支持button=right、clickCount=2、holdMs和position相对位置；press支持ref聚焦和Shift+Tab、Alt+ArrowDown/Up、Shift+F10、Control+Enter。快照增加disabled/focused/checked/selected/hasPopup/controls/busy，inspect可读遮挡、位置和原生select选项；wait最长5秒。DOM悬停不支持纯CSS :hover，CDP真实交互沿用原开关并保留保存值。完整流程与边界见[特殊交互与状态](skills/ai-browser-control/references/interactions.md)。

0.10.1把tabindex控件，以及由aria-haspopup+controls/owns关联或具备menu/listbox角色的可见弹层内列表项、自绘指针项纳入定位。快照标记inPopup并优先保留这些选项；没有标准role的选项仍按真实角色返回，不虚构menuitem。inspect触发器可见关联popups状态和候选项数。此为DOM候选识别，不等于所有列表项都必然绑定了点击处理器。

0.12.0共20个工具。AI要新开网址时用browser_open(url,taskId,taskName)，可选已有授权tabId确定所属窗口；不传则用最近普通窗口。创建固定active=false，不调用窗口激活或新建窗口；没有窗口则报错。回执包含tabId、reused、taskId/groupId、active、窗口focus前后状态和授权状态；自动授权关闭时不擅自授权新页。browser_navigate仍用于用户指定的已有页。网页按钮自行window.open或用户手动新建页面不由此接口改写。

### 任务页面与多页工作

每项工作使用唯一taskId和简短taskName，任务名显示在浏览器标签组。默认只复用本任务、同窗口、完整URL相同的插件页面；显式reuseKey可导航复用同源同类页，reuse=false用于需要并排保留的对照页。不会默认复用或清理用户原有页面。tabGroups用于这些任务组，webNavigation仅用新页面创建事件核验连带页来源，不保存浏览历史。

taskId和taskName为open必填参数；升级后客户端必须重连读取新目录，旧open(url)定义不可继续使用。

归属记录使用storage.session，worker重启可恢复，浏览器会话结束后清空；用户移出原分组的页面交还用户。由已管理AI页派生且浏览器导航来源链可核验的连带页面也纳入任务归属和分组。用户原始页不自动追认；旧版无归属页若有真实AI创建回执，可通过显式adopt逐页补登记，调用方创建证据标为agent-attested而不是插件独立证明。

清理须同时满足三项：AI创建或连带创建；当前仍在目标任务分组；agent已评估操作结束，或页面数量超限。某些页面对应操作已结束、总任务还在继续时，用browser_task(action=close,tabIds=[...])只关闭指定管理页；整个任务结束才finish。cleanup用于超过12页时整理。满足三项时允许关闭活动、有声、固定或有未保存输入的页面，不再将这些状态当成禁止清理条件。显式keep的交付页继续保留，正在执行命令的页面本轮跳过。keep页可先unkeep再按页close。adopt需要taskName和pages，每项明确tabId、精确url、当前groupId和evidence:{kind,reference}；reference应指向真实AI创建/连带创建回执，无证据不得登记。回执closed仅列独立核验已消失的页，closedCount=0必须说明实际关闭0页，不能称清理完成；浏览器自身的关闭限制不绕过。任务名称与结束信号仍由agent传入，插件不按空闲时间猜测任务结束。

browser_batch一次最多4个不同tabId，支持快照、截图及交互，返回逐项结果；同页依赖步骤继续顺序执行，批次不是事务，失败不重放业务操作。每项独立保留成功/超时/忙碌结果，超时含commandId及安全phase/lifecycle诊断；list_tabs中的operation保留未结束命令及timedOut状态，桥pending=0不代表该页空闲。注入文件和页面调用使用injectImmediately读取已存在DOM，不等待document_idle，不激活页面或绕过冻结/权限。遇到DOM歧义、遮挡或状态冲突时，技能要求先截图/inspect复查，再判断是否确实需要用户处理。详见[任务、并行与验收](skills/ai-browser-control/references/tasks-and-verification.md)。

### 自绘控件与原生单元格

0.17.1返回candidateKind：semantic为原有语义候选，custom-control为有点击处理器或指针样式证据的自绘项，native-cell为原生td/th内容。角色仍按DOM实际属性返回，没有role的月份单元格为generic，不伪造成button或option。普通静态表格单元格也可读取并定位，但不是已证实的按钮；操作依赖用户意图、上下文与回读。普通无标记静态正文不会因此全部获得ref。未暴露语义/处理器/样式的委托事件div仍可能无法识别，不保证所有框架控件。

重复名称的generic/单元格必须传expectedContext；月份title中的年份会补入context。选择同一动作的嵌套表示时收敛被动包装，独立onclick及原生/ARIA动作仍保留。同轮分页保持ref稳定，相关候选变化拒绝续页；150仍只限制每批返回量。inspect增加固定样式、最多6层祖先、采样命中节点与hitTest.status，不读HTML/框架内部对象，不修改样式/遮罩。Agent10可与不可覆盖的旧Agent9/8并存，新后台优先10，升级后重新snapshot；表单/控件类型、提交归属和目标、ARIA关联等动作语义变化会令旧引用失效。原生命名表单控件遮住DOM方法时采用原型回退，不序列化密码或DOM节点。

### 有界条件等待

browser_wait的timeoutMs为0至5000毫秒条件预算。0.17.2在扩展后台进行100毫秒间隔轮询，每次页面waitFor只做timeoutMs=0的即时观察；页面不驻留等待计时器。timeoutMs=0仍做一次观察；缺少目标正常返回matched=false/timedOut=true，不代表工具故障。请求截止后不再启动新探测，已排队到页面的回调也检查单独条件期限，不接受预算外才完成的匹配。

轮询绑定初始URL/窗口/原生documentId，后续注入锁定原文档；缺失文档标识时不进行多轮等待。返回前仍检查当前权限和已知冻结/丢弃状态，等待不刷新snapshot或ref；最后一次观察后的同URL重载等变化不能仅靠tabs.get追溯，正常超时不是当前页面或业务结果的验证。已派发的原生API/同步页面扫描无法被条件时钟强制中止，仍有11秒总期限和底层真正结束前的页锁保护；冻结抢在原生调用中发生仍可能需要维护，不能承诺所有wait都绝对5秒返回。

### 冻结页面

浏览器报告frozen=true时，页面无法执行任务；injectImmediately只避免document_idle等待，不能解除冻结。0.16.3在文件注入前与页面方法调用前检查原生状态：新操作返回TAB_FROZEN/TAB_DISCARDED、stage=preflight及准确的not-dispatched/unverified；已占用页仍优先TAB_BUSY，不清锁、不重放。list_tabs可读取autoDiscardable，但它只代表自动丢弃资格，不是解冻参数，插件不修改它。

0.17.0新增用户单独授权的后台唤醒用途。扩展重载后由用户开启“后台唤醒冻结页”；默认关闭，agent不能通过普通页面内容或工具参数开启。每条新读取最多一次唤醒，只发送Page.setWebLifecycleState(state=active)，最多三轮有界原生确认；恢复失败不改用切页/刷新或其它CDP命令。唤醒依赖浏览器提供原生frozen状态并支持此生命周期命令，缺失字段保持未知；当前真实验收为Edge157。临时连接解除后仍须核对原URL/窗口、非丢弃及frozen===false，成功结果含lifecycleWake.attempted/verified。唤醒阶段继续检查独立代次与页面授权，关闭时阻止后续步骤并清理自己创建的连接；原生API挂起仍受11秒命令期限和底层锁保护，不声称能取消已派发调用。

旧operation未结束时仍优先TAB_BUSY，开关不清锁、不重放；用户唤醒或加载补丁后也须确认原操作结束，再发起新读取。填表、点击、滚动、导航和丢弃页不借此开关自动恢复。正常页及后台空闲期间不周期性唤醒，不永久挂调试器，不改autoDiscardable或浏览器节能策略。冻结页恢复不等于业务完成；自然冻结触发原因和所有浏览器兼容性不在此保证内。

### MCP重载

更新后先同步客户端实际使用的插件目录和单独安装的skill副本，再调用`browser_status`。`mcpVersion`是实际MCP工作进程版本，`restartRequired`表示磁盘版本变化待重载；原`version`仍是桥版本，`extensionVersion`是浏览器已加载扩展版本，三者分别核验。

agent调用`browser_restart({})`即可替换MCP工作进程，stdio启动器保持宿主连接，新工作进程就绪后返回before/after实际版本与PID，并通知客户端刷新工具目录。有在途操作时返回MCP_BUSY，重载中拒绝新动作，候选启动失败保留旧工作进程；任何动作都不重放。该工具不替换共享桥、不重载浏览器扩展、不改变用户授权。

首次从不含本接口的旧MCP升级，需要在客户端MCP管理里重连一次以启动新版启动器。以后工作进程更新可用本接口；启动器本身的更新或客户端不刷新工具目录仍需宿主重连，不能声称旧进程能自行获得一个尚不存在的接口。

### 桥自动恢复

本地MCP监督桥的可达性；启动预热、定期检查和工具调用共用单进程启动门禁。不同MCP共享同一端口的健康桥，启动竞争时只有一个进程可监听。远端桥不会被本机代启动，也不创建Windows服务、计划任务或Node副本。MCP退出后停止监督，共享桥不被连带关闭；所有宿主均退出时不承诺继续保活。监督只恢复传输，绝不重放已派发的浏览器命令。

当前范围：主文档普通 DOM、同源 iframe 正文；跨域 iframe、封闭 Shadow DOM、canvas 内部控件和系统文件选择框不支持。动态页面内容尚未出现时稍后重新读取，不把短文档当成错误。

### 已加载内容不等于全部数据

`browser_snapshot`每次最多返回150个匹配元素，而非页面操作总上限。找已知按钮可直接传`load=current,name="下载",role="button",exact=true`；name默认包含匹配，context可补充账单/行身份。scope=main/dialog/viewport限定正文、对话框或视口，scopeRef限定最近快照容器。查询遍历当前已加载候选，不受第一批150限制。

需要遍历时用pagination.nextCursor继续，续页只带tabId/cursor及可选format/load=current；同轮编号保留，全部读取后hasMore=false。相关候选增删、重排、身份或可见性变化会返回SNAPSHOT_CHANGED，需重新快照；旧轮游标STALE_CURSOR不能继续。新建无cursor快照会使上一轮ref失效。150是分页大小，pagination.total是本轮已加载匹配候选数量，均不等于业务数据总量。

`coverage`仍提示已加载DOM、正文12000字符截断与业务完整性unknown；候选区域分页不代替网站自身的加载更多/虚拟列表滚动。常驻导航和原生select不因role=menu/listbox就优先当弹层，嵌套同一动作项去重但不同按钮保留。

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

同目录supervisor.log记录MCP监督失败与恢复，固定单份最多1 MiB，不按进程PID增加文件。多个MCP的监督诊断共享该有界文件，竞争写入失败允许跳过；以桥启动日志和实际状态交叉核对。

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

## 插件故障的交接

业务agent遇到连接、注入、页面RPC空回传或运行时故障时，首次立即停止相关业务并报告，不反复换参数、重载或自行改设置。按随附技能的[故障交接](skills/ai-browser-control/references/failure-reporting.md)保留首次错误/code、命令编号、tabId、实际版本、最后阶段、现有证据与未完成事项；没有跨会话通信能力就给出可转交报告，不声称已自动通知维护者。普通无匹配或过期ref等按明确错误语义处理，不能把所有空页面当插件故障。

页面错误回执中的diagnostic只含固定类型、阶段、计数和布尔元数据；null/undefined、无result、顶层执行失败、代理缺失和序列化失败分别标识。日志不保存页面正文/输入/URL/截图/原始异常文本，原始业务回传内容不因排障落盘。注入API返回不等于文件完成执行，截图成功不等于DOM读取成功。维护者需依证据复现，恢复和已确认根因分别说明。

## 本地运行、测试与预览

本项目是原生 JavaScript 扩展 + Node 服务，不需要编译或打包运行时。可直接加载 `extension`，双击“启动桥接服务.cmd”或运行：

```powershell
node server/bridge.mjs --bridge
node test-page/serve.mjs
```

测试页为 `http://127.0.0.1:17654/`，只写入页面内存。若 17654 已用于其他桥，先停用对应测试服务或换一个独立测试入口，不覆盖现有服务。

固定发布验收（详见[可靠性矩阵与故障处理](RELIABILITY.md)）：

```powershell
node scripts/check-reliability.mjs --all --dry-run
node scripts/check-reliability.mjs --all
```

默认不带参数或--unit运行全部源码单元文件；--native运行4个已审计的私有Edge套件。前置缺失、漏测目录、崩溃、超时、失败或中断均不能判成完成通过；输出精确清单、产品版本、Git状态和阶段日志。dry-run只验证计划/前置，不是用例通过。新增源码测试自动发现，不把temp历史夹具算进发布测试。

单独调试的既有回归命令：

```powershell
node --test tests/bridge.test.mjs tests/install.test.mjs tests/diagnostics.test.mjs tests/protocol.test.mjs tests/supervisor.test.mjs extension/tests/mock.test.cjs extension/tests/expired-result.test.cjs extension/tests/tasks.test.cjs extension/tests/page-interactions.test.cjs extension/tests/task-recovery.test.cjs extension/tests/snapshot-query.test.cjs extension/tests/page-rpc.test.cjs extension/tests/batch-timeout.test.cjs extension/tests/lifecycle-wake.test.cjs extension/tests/custom-controls.test.cjs extension/tests/background-wait.test.cjs extension/tests/background-wait-boundaries.test.cjs tests/mcp-restart.test.mjs tests/snapshot-format.test.mjs
python -X utf8 tests/browser-ui.py
python -X utf8 tests/browser-extension.py
python -X utf8 tests/browser-loading.py
python -X utf8 tests/browser-lifecycle.py
python -X utf8 tests/browser-timeout.py
python -B tests/browser-frozen.py
python -B tests/browser-lifecycle-wake.py
python -B tests/browser-custom-controls.py --source current --label local-check
python -B tests/browser-wait-lifecycle.py
```

Python 项仅供开发验收，依赖测试机已有 Python Playwright、Pillow 和 Edge；browser-frozen.py、browser-lifecycle-wake.py和browser-wait-lifecycle.py另需已有websocket-client以便只连接私有测试浏览器、不自动附加页面。不属于运行时依赖，不自动安装或复制全局工具。UI 对照测试还需要 Git 历史中的基线提交（见 REQUIREMENTS.md）；纯 ZIP 没有该历史时无法生成旧版对照。它们使用独立临时浏览器配置和测试桥，不控制用户的标签页。证据输出到 `temp/qa/`。无 CDP 截图正向夹具的额外权限与正式清单不同，具体限制在测试记录中明确列出。

本地预览包放在 `temp/ai-browser-control-local-preview.zip`；这是源码预览，不是正式 Release。解压后可加载其中的 `extension` 目录，不包含 Node 或浏览器副本。

## 故障结果与版本检查

工作进程返回的浏览器错误及失败批次项含recovery分类、固定下一步、maintenanceRequired、保守outcome和automaticReplay=false；文字宿主也能看到处理建议。引用/身份变化、页面状态、生命周期、旧操作运行中与内部回传异常分开处理。它不是新的业务授权；未知结果先核对并保留首错，不盲目重载或重放。启动器管理/JSONRPC层错误可能仅有稳定code/outcome，缺少recovery不代表正常，仍按对应错误和现场状态处理。

browser_status.versionHealth给出MCP/桥/扩展与已知磁盘目标的aligned/mismatch/unknown及固定nextActions，不能以版本对齐/connected/pending=0代替页面可用性。launcherHealth独立核对启动器实际加载代码；hostReconnectRequired为true/false/null，旧宿主无法提供信息时保留unknown。无已加载worker时mcpVersion=null、initialize版本unknown，磁盘版本只列于mcpDiskVersion。

## 给后续 AI

先读 [REQUIREMENTS.md](REQUIREMENTS.md)，用户原话决定范围；再看 [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md)、[固定可靠性矩阵](RELIABILITY.md)和最新测试记录。不要把历史 agent 的推断升级为用户需求。

随插件分发的浏览器操作规范在 [skills/ai-browser-control/SKILL.md](skills/ai-browser-control/SKILL.md)。跨站点的懒加载、虚拟列表、分页、列表结束判断及动作验收见 [动态列表流程](skills/ai-browser-control/references/dynamic-lists.md)；接入 agent 应读取该文件，不依赖当前聊天或某台机器的本地规则。

主要入口：

- `server/mcp.mjs`：MCP stdio；`server/supervisor.mjs`：本地桥监督；`server/protocol.mjs`：21个工具与共用参数校验；`server/bridge.mjs`：指令队列、来源校验、远程 token。
- `extension/background.js`：授权、CDP/DOM 路由、跨页批次、结果重传；`extension/tasks.js`：会话级任务页面归属、复用与清理。
- `extension/page-agent.js`：DOM 快照、ref、定位与 DOM 操作；`extension/cursor.js`：光标与动效。
- `extension/popup.*`：弹窗；`install.mjs`：桥管理、更新及旧注册兼容。

版本源为 `.zcode-plugin/plugin.json`，MCP/桥从该文件读取版本；扩展清单同步版本并由测试核对。交付运行行为变更时必须递增版本：兼容修复用patch，新增完整能力用minor；未推送的本地候选也要有新版本，不能沿用旧版本掩盖运行差异。一起核对源码清单、可选市场条目、预览包、桥实际版本和扩展加载版本，未启用的部分明确标记。修改 UI 必须检查真实渲染；本地预览不能当成用户实际安装入口已经更新。提交、推送、标签和 Release 按用户授权执行。不要提交 token、个人配置、浏览器 profile 或测试截图里的业务数据。

## 停用与回滚

1. 扩展弹窗点“断开”，在浏览器扩展页停用或移除。
2. 从所用 agent 配置中移除对应 MCP 条目，保留其他配置。
3. 停止命令行含 `server/bridge.mjs --bridge` 的对应进程。
4. 配置、token 和日志位于 `~/.zcode/ai-browser-control/`；扩展设置位于浏览器自己的扩展存储。

本轮源码回滚点在 REQUIREMENTS.md 中，回滚仅针对本轮 diff。不会重置浏览器登录态、用户配置或其他项目文件。
