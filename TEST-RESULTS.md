# 验证记录

## 2026-11-12：0.17.0独立后台唤醒冻结页

- 用户明确授权新增独立用途。弹窗新增“后台唤醒冻结页”，lifecycleWakeEnabled默认false、独立持久化和撤销代次；不由截图/输入开关、网页内容或普通MCP参数开启。新snapshot/inspect/wait且frozen=true、无旧挂起调用、未进入过页面方法时，每命令最多一次；仅发送Page.setWebLifecycleState(state=active)，有界确认原生状态后解除本次新建附加，继续DOM读取。既有输入附加只借用不解除，旧busy锁优先，晚回执不重放；写入、滚动、导航、丢弃页与后台空闲告警不主动唤醒。
- 独立审查重现临时解除附加后目标URL/窗口变化或frozen字段消失仍被视为成功的缺口。已补最终严格原生检查及stage=wake错误封装，wakeVerified只在清理与最终核对后置true；新增6个后置变化/撤销反例均通过。独立复核42项通过，最终审查记录本地保留。
- 最终完整Node **304/304通过**，包括42项生命周期授权矩阵/代次/挂起与迟到清理/借用连接/同文档/旧busy/重冻结/边界身份测试；无失败、跳过或取消。最终核心修复后的真实Edge完整stdioMCP→私有桥→原扩展 **33/33通过**，实际frozen=true、仅active生命周期命令、原生状态先于同documentIds页面调用、双页批次、全部锁及自己附加清理、无激活/导航/自动丢弃修改、扩展真实重载后设置保持均核验。
- 原生弹窗另有 **7项通过**：缺省关闭、可访问标签、三用途不联动、开关持久化与600px视口可触达/无横向截断；浅/深色截图已实际查看。验证全用临时浏览器/目录/独立端口，不触及用户业务页或OP。核心最终验证后仅改正3条过时注释，不改变执行逻辑。默认安装不自动启用此用途，磁盘同步、扩展实际版本及用户开关状态必须分别说明。


## 2026-11-12：0.16.3已知冻结页预检与原生生命周期复现

- 只读保全新交接与日志，0.16.2批次c318c864-939f-42a6-9c34-8f106d0e7e48的一项导航完成、两项在native frozen=true时注入超时，挂起操作和逐项结果被如实保留；业务17条进度与明确3笔合计211.77元归属不改变，本维护不执行OP/分配/导出。
- 新DOM调用在文件注入前及页面方法调用前，严格按浏览器已知frozen===true/discarded===true返回TAB_FROZEN/TAB_DISCARDED与stage=preflight；未进入页面方法时not-dispatched，较早步骤已进入时保持unverified。混批正常页照常返回；旧busy页不清锁。单调用桥/MCP与批次均保留dispatch outcome。list_tabs仅报告可选autoDiscardable而不改变它。
- Edge157.0.4341.46隔离原生复现，在后台目标真正frozen=true且断开整条浏览器CDP连接12秒后，默认及立即文件注入仍挂起；原生激活后原Promise各执行一次，同documentId，分别约12332/12349ms。tabs.update(frozen)被原生拒绝；autoDiscardable true→false不解冻；仅附加调试器不解冻，显式Page.setWebLifecycleState(active)可后台解冻。后者仅隔离机制对照，不构成对实际浏览器使用该用途的授权，也不证明持续防冻结。自然冻结的具体Edge触发策略未查实。
- 完整Node **262/262通过**，包含已知冻结/丢弃零注入、健康兄弟、注入后冻结、先前步骤保持unknown、outcome透传及原所有超时/重载/清理回归。新增真实Edge原生完整链路 **16/16通过**：实际native frozen=true后已解绑页面调试器，MCP→私有桥→原扩展立即拒绝且零注入/零新锁，双顺序混批保留健康页，实际丢弃页有区别错误，隔离原生激活并确认解冻后新快照成功；未附加扩展调试器或修改autoDiscardable。独立离线复核40项通过（含4个额外反例）；真实链路复跑修正原生discard返回新tabId的夹具问题，最终源码哈希全程未变。维护证据仅本地temp/qa/frozen-20261112-1831/，未将真实浏览器profile或日志提交仓库。


## 2026-11-12：0.16.2批次超时逐项回执与立即注入

- 只读保全原故障交接及桥日志。原批次b672454f-2a88-4b84-aa99-a84dd91d2ae7实际发生于17:06:44–55（UTC+08:00）：分账页此前16:58的文件注入未结束，本次子项0立即busy；云监控页子项1停在scripting.inject并于11秒超时。父批次先超时而吞掉两项结果。日志持续轮询，不把缓冲上报延迟当成派发延迟；bridge0.16.0不是已证实根因。
- 批次父层不再抢同样11秒期限，子项各自有界并按输入顺序回传，统一COMMAND_TIMEOUT/CONNECTION_INVALIDATED；TAB_BUSY表示本次未派发。保留底层工作真正结束前的页锁，不清锁重放。list_tabs补浏览器已知status/frozen/discarded及未结束operation的commandId/phase/durationMs/timedOut；错误诊断仅接受固定阶段、布尔页面状态和耗时。桥自身504与无page诊断的MCP文字也保留命令ID。
- 文件注入与同文档调用显式injectImmediately，避免默认等待document_idle；页面回调携带绝对期限，期限后尚未开始的方法拒绝执行，不能声称可取消已进入的异步页面方法。原文档绑定、不自动CDP/激活/刷新与不重放边界保留。
- 独立Edge157隔离慢资源探针对照：默认注入在资源释放前不回传，立即注入返回readyState=loading；资源释放后默认才返回interactive。该机制可复现，但不证明原阿里云页为什么注入悬挂；active页冻结探针未建立有效冻结条件，不作为现场冻结结论。证据仅本地temp/qa/timeout-20261112-1728/。
- 完整Node回归 **256/256通过**，无失败或跳过。新增生产executeBounded(batch)超时、正常兄弟保留、原故障busy+timeout、全部超时、迟到注入不写入、回调入场期限、生命周期字段缺失、隐私过滤、桥504和MCP纯文本命令ID回归。独立真实Edge专项 **18/18通过**：真实stdio/MCP/私有桥/临时扩展验证两批各约11.047秒逐项回执、同页忙碌、迟到回执逐页清锁与零写入/零重放；原生慢资源对照中生产快照0.063秒返回且目标保持后台。独立代码审查未发现阻断问题，另离线97项通过并校验诊断枚举一致；真实Edge临时进程/监听均已清理。模型均请求magpie-responses/yzcodex/gpt-6.1-sol/high，执行型号/推理强度未独立核实；证据及各代理结果本地留存。


## 2026-11-12：0.16.1源码交付与主动批量规则

- 本次提交汇总此前已验收的0.13.0至0.16.1改动：任务页按页结束与补登记、MCP工作进程重载、目标查询/区域读取/稳定分页、页面RPC诊断及首次故障交接。下方“未推送”等为对应阶段的历史状态；本次仅同步现有仓库源码，不创建标签或GitHub Release。
- 主skill消除“一次执行一个动作”的跨页歧义，每轮检查是否有至少两页已就绪且互不影响的步骤；符合时优先browser_batch，每批最多4页，不等凑满。同页依赖、共享状态修改与能力限制仍按顺序或正式单工具处理，批量不扩大业务授权；一页未就绪不拖住其它独立页。源skill、实际插件与用户独立skill对应文件hash一致，UTF-8无BOM；现有协议5项测试通过。
- 本次提交前重新运行完整Node回归248/248通过，无失败或跳过；此前真实Edge生命周期20项、原扩展18项通过。本次仅增加规则及工具说明，未改变浏览器执行逻辑。磁盘同步、GitHub源码同步与运行中加载分开判断；原业务空回传根因仍未确认，不以源码交付声称账票业务恢复。

## 2026-11-12：0.16.1页面RPC空回传与首次故障交接

- 用户提供15:02:20火山/抖店读取失败现场。原始诊断3JSON+manifest已只读读取，未修改业务证据。维护会话仅对原火山tab1891454153执行一次load=current/name=下载/role=button只读复核，旧错误仍可复现；事前MCP/桥/扩展均0.16.0、授权正常，未下载/开票/提交或重载现场。
- 独立最小MV3+临时Edge157.0.4341.46+loopback完成37个真实executeScript探针：sync/async throw、Promise.reject、files顶层异常都可能API resolve/result:null无error；普通Promise及真实page-agent8 snapshot current/auto正常。导航缺代理、不兼容truthy代理、不可序列化顶层值均可同形失败。证实旧错误解释与观测不足，但现场具体底层触发原因仍未确定，不把导航/遮挡/网站/登录/Promise推成事实。证据temp/task19-execute-script/probe.py/report.json，维护报告temp/qa/v0161/incident-report.md。
- 真正执行的func改显式async/try/await固定RPC信封，捕获lookup/缺方法/sync throw/rejection/序列化失败；注入API返回只记录元数据，不假称代理ready。空null/undefined、无result/空数组、错误shape、document/frame不一致分别分类。Chrome提供documentId时调用绑定注入文档，文档消失不向新文档重试。兼容agent8和原方法参数，不改变CDP设置，不自动重放读写动作。
- page_result按commandId关联，日志仅固定类型、阶段、计数、布尔一致性和异常类别；桥与MCP透传安全diagnostic/commandId，纯text宿主同样可见固定诊断。独立审查指出仅用大写正则过滤errorCode可能写入合法字符敏感串，已改固定已知集合；批量子项原丢诊断，已补安全diagnostic和子ID，并有反例。
- 浏览器skill新增failure-reporting.md：业务agent首次发现插件不可用即停止业务并先通知，再一次性报告首错、实际版本、tabId/命令ID、已知阶段、未证实原因、证据路径和业务待办；只复用现有证据，必要时至多各一次status/list，不换参数/入口重试，不先要求重载碰运气，不假称自动跨会话通知。正常结构化空DOM/无匹配/STALE_REF/SNAPSHOT_CHANGED等按各自文档处理。明确维护排障授权例外，不妨碍本维护会话保全现场后隔离诊断。修正主skill和其他参考中“故障后继续回读”的局部冲突。
- 首轮完整Node245/245通过；补诊断隐私/批量反例后最终全量 **248/248通过**。真实Edge生命周期 **20/20通过**，原扩展端到端 **18/18通过**，包含实际Chrome边界异常null的解码、缺代理明确NOT_READY、错误code+诊断+命令ID经真实桥/MCP回传、一次失败不重放、恢复对照成功。独立审查结果、最终Node及原扩展回归结果和安装hash另记录在temp/qa/v0161/。
- 0.16.1是诊断与防护修复，不宣称现场账票已恢复/已下载，或历史根因已确定。实际安装插件目录、用户独立skill须同步核验；浏览器仍加载0.16.0时明确尚未生效，不擅自通过重载破坏故障现场。未提交推送或Release。

## 2026-11-11：0.16.0目标查找、区域读取与稳定分页

- 用户认可150应限制每批返回量而非全页可操作元素总数。snapshot新增name/role/context/exact目标过滤，scope=all/main/dialog/viewport或scopeRef容器；查询扫描当前已加载候选而非仅前150。role和名称精确匹配区分同名控件，业务上下文与原动作身份守卫保留。默认full与已有compact输出均保留。
- pagination包含snapshotId/offset/limit/total/hasMore/nextCursor。一个最新轮次完整候选缓存，150仅单批上限；续页不探测加载、不改变筛选、不刷新generation，同轮前批refs继续有效。续页重新比对匹配节点顺序/身份/可见性等，变化SNAPSHOT_CHANGED；新快照/导航使旧cursor失效。total和hasMore仅针对当前已加载匹配候选，不能当成网站业务全量。
- 常驻nav/menu、普通select/listbox不自动作为弹出菜单高优先级，关联trigger或浮动定位等证据用于popup。嵌套同一动作li/button/span收敛，独立同名按钮仍分别保留；main/dialog等区域ref保留，区域名称来自显式标签而不把整段后代正文作为名称。page-agent升级8，与background及相关直接注入测试同步。
- 独立snapshot-query.test.cjs首批30/30通过，独立审查后补至 **34/34通过**，含1600候选末端offscreen查找、11页无重漏、跨页refs、区域/容器、节点替换/复用/增删重排/隐藏变化、无关装饰变化、导航/旧游标、菜单和密码。旧mock覆盖从elementScanLimited=true变为全候选扫描false并检查pagination.hasMore，未以抬高输出上限绕过。
- 全量Node **204/204通过**，包含原评审修复、MCP重载、部分清理、compact输出和新查询。真实Edge生命周期 **18/18通过**，1600常驻导航+321正文按钮中按名/角色/main找到下载并真实点击，正文321按钮分三批无重复遗漏，第二批后首批ref仍可聚焦，候选变化明确拒绝续页。原扩展端到端 **18/18**、动态列表 **7/7**通过。全部使用临时profile/本地夹具，未操作用户业务页面。
- 独立审核发现两处菜单边界：无haspopup的关联静态导航仍被晋升popup，及菜单wrapper内独立ARIA按钮被折叠；已分别增加静态导航证据约束、独立动作role识别，并补反例确认。独立审查以原反例复验两处补丁通过，未留已证实阻断问题；最终回归结果和安装文件hash另存temp/qa/v0160/。实际插件与独立skill同步、运行中版本回读分开记录，浏览器扩展重载和MCP重载不混同；未提交推送或Release。

## 2026-11-11：0.15.0任务内按页结束与旧AI页补登记

- 用户截图指出agent把账单总任务未结束误解为所有页面都应保留，且managed=false导致已完成CMS页面无法清理，最后没有实际关闭却汇报完成。本轮按该实际场景增加task close/unkeep/adopt，不增加工具数量；保持原有AI创建/连带创建、当前目标分组、操作结束或超限三条件。
- close+tabIds表示只结束指定页面对应操作，整任务继续。只关所选当前同任务同组管理页，keep/busy/other-task/not-managed/outside-task-group明确skipped；unkeep显式解除指定页保留，不能改变其他页。finish仍用于整个任务结束。
- adopt+taskName+pages逐页提交精确tabId/url/groupId以及evidence:{kind,reference}。调用方须有真实AI创建回执/会话创建记录；插件保存provenance:agent-attested并保留引用，不声称可独立验证聊天历史。没有证据不认领，不能从标题/managed=false推断AI创建。已有其他任务或非目标组不强抢，不追认同组未提交页面；明确未分组旧AI页可放入同窗任务组，await前后复核URL和组。
- tabs.remove完成后还须独立get明确不存在或query核验不存在才进入closed。页面仍存在/核验失败返回close-not-confirmed并保留归属，closedCount=0必须报告实际关闭0页，禁止写清理完成。skill补充“部分操作结束不等于整任务结束”的处理流程及零关闭汇报规则。
- 独立新增task-recovery.test.cjs **25/25通过**：部分关闭、参数边界、keep/unkeep、跨任务/组/未知页、浏览器remove未生效、核验传输失败、query确认、创建证据缺失/精确身份/声明持久化、await期间URL/group变化。另补自动/显式登记双向竞态以及后续页取消时已登记证据仍跨worker保留的回归；真实Edge生命周期 **14/14通过**，包含同任务单页实际消失且其他页可继续读；旧页未登记时0关闭，真实测试create回执补登记后实际关闭，用户原始页不受影响。全部使用临时profile、目录和本地夹具，未操作截图里的实际CMS/账单页。
- 全量Node **164/164通过**，无跳过；实现、独立测试、独立审查的模型请求/代理ID记录见temp/qa/v0150/dispatch.json，工具回执仅给ID所以执行型号未独立核实。实际安装副本与用户独立skill同步后逐文件hash核验，运行中扩展版本另外读取，不把磁盘同步当成已加载。

## 2026-11-10：0.14.0 agent发起MCP工作进程重载

- 新增browser_restart({})，共21个工具。MCP入口改为稳定stdio launcher与fork IPC工作进程；原host/port/token/config-dir传给worker，凭据不输出。重载只影响本MCPworker，不重启共享桥或浏览器、不改授权、不重放动作。
- 候选start/ready后还须activate/activated确认才切换。启动/激活失败保留原worker，成功返回before/after的mcpVersion/mcpPid/mcpGeneration，并发标准tools/list_changed通知。存在在途tools/call时MCP_BUSY拒绝，重载期间新业务MCP_RESTARTING拒绝，不排队。无worker时父连接和恢复管理工具仍可用。
- browser_status分别报告MCP实际版本、磁盘版本和restartRequired；原version及extensionVersion仍表示桥和浏览器扩展，不能混为同一版本。首次旧式MCP尚无新工具，需要在宿主MCP管理里重连一次加载launcher；工作进程以后可用工具重载，launcher自身更新仍需宿主重启。
- 独立审查发现EOF原统一等待9秒会截断已接受的10.5秒合法响应；已改为取消尚未切换候选，按业务40秒调用期限加终止余量drain，再退出。worker先注册stop/disconnect监听再动态加载产品依赖，导入挂起时父退出也能收敛；恢复前确认失联残留worker退出。
- tests/mcp-restart.test.mjs使用真实stdio协议、独立临时运行时副本/配置和随机端口fake桥，9项通过：连接持续/换PID/目录通知、版本及传递依赖schema刷新、失败保留旧worker后修复重试、busy不重放、候选屏障期拒绝、严格空参、候选加载时EOF收敛、正常EOF收敛、慢回执不丢。实现作者另有17组隔离mock自验；关键EOF修正另安排独立复核。
- 全量Node **133/133通过**；真实Edge生命周期 **12/12通过**，新增同stdio重载后worker代次2、实际MCP0.14.0且共享桥未替换/扩展仍连接，并继续完成读取、并行、截图、清理及桥监督回归。新测试输出在temp/qa/v0140/browser-lifecycle-results.json。不操作用户真实网页。
- 实际交付核验包含temp/plugins/ai-browser-control安装副本、用户.zcode/skills/ai-browser-control独立skill；文件同步与运行中加载分别记录，首次bootstrap的旧进程不假称已自动变为新launcher。未推送或创建Release。

## 2026-11-10：0.13.0评审修复与清理规则调整（本地候选）

- 基线a77775c，开始时工作区干净。本聊天用户明确清理三条件：AI自己创建或连带创建、当前仍在目标任务分组、agent已评估操作结束或数量超限；满足三项时允许误关。因此原评审第2/4/5项按新口径处理，其余9项修复，保留原始评审证据。显式keep和正在执行命令的页面仍保留；复用保持原有使用/编辑保护。
- cleanup仅超过12页时回收到限制，finish为agent明确结束信号。删除前再核对session记录身份与实际group；分组失败、移出组、用户原始页及其他任务不关闭。连带页依据webNavigation.onCreatedNavigationTarget的sourceTabId/tabId认领，仅在来源归属、同窗与分组可核验时纳入。新增webNavigation权限仅用于创建来源事件，不记录浏览历史。
- 真实Edge发现后台window.open的openerTabId可错误指向活动用户原始页，因此弃用tabs.onCreated/opener认领。改用导航事件后，同一真实场景正确关联AI来源页并归组，结束清理不触及用户原始页。Node覆盖多级来源、worker唤醒恢复、错误opener、跨窗/未知来源/移出组/分组失败/删除前归属交还等边界。
- revokedTabIds保存于storage.session，释放和用户取消调试跨worker恢复；输入/截图各有CDP设置generation，附加完成及派发前重核，迟到附加解除。单结果与批次按UTF-8字节限制10MiB，超大结果转换小错误，终态4xx不无限重传，不重放浏览器动作。
- 桥以显式租约和命令recipient绑定扩展；poll间隙不交出所有权，unpair/租约切换取消相应队列，其他扩展不能冒领或接走旧命令。默认HTTP期限30秒覆盖25秒待机窗口；已派发后超时报告unverified/勿重复提交，仅尚未派发时提示唤醒后再试。MCP/子桥可传--config-dir，握手测试完全使用临时实例目录和随机端口。
- DOM特殊点击在按下、处理器、等待和释放后重核业务身份/可交互状态，身份变化后不发送click/contextmenu/dblclick。Enter区分普通input按钮和提交按钮，保留原生submitter及覆盖属性；文本隐式提交尊重默认按钮与禁用状态。
- 更新器核验精确本地端点、Node路径、本仓库桥入口、PID创建信息并持有进程句柄后终止，不按端口批量杀进程；保留桥显式配置目录与token。无法证明进程归属则拒绝自动替换，非Windows同样安全拒绝。安装测试只写临时home/configDir，清理自己持有的进程与创建的目录。
- Node全量 **123/123通过**，无跳过。真实Edge生命周期 **11项通过**，包含DOM Enter实际激活/submitter、新清理边界、真实连带归属、后台截图/并行、桥崩溃监督恢复与MCP退出停止监督。安装集成验证同端口127.0.0.2普通服务在桥替换后存活，显式配置token保留。全部运行在临时profile、home/目录和本地夹具，不操作用户浏览器。
- 原扩展端到端回归 **18/18通过**，含真实DOM/CDP输入/截图、菜单/拖拽/懒加载、诊断、桥重启恢复、释放授权及迟到动作不重放。首轮在手动重连阶段遇到旧断言假设：unpair现立即取消RPC，旧请求返回不等于底层悬挂操作已越过11秒期限；已改为等待桥真实poll通道恢复（有界15秒），继续检查迟到prepare不点击。不是以放宽业务结果断言代替验证。
- 服务端/DOM、扩展/安装、最终导航来源分别由未参与实现的审查者只读复核。服务端复核补正“待机后已派发超时仍提示重试”的遗留分支；最终导航来源审查9/9相关测试通过，未报告遗留阻断问题。git diff --check通过。当前仅本地源码0.13.0，未推送、发布或替换用户加载中的扩展/MCP；生效需重载扩展（接受新增webNavigation权限）、刷新受控页并重连MCP。

证据：temp/qa/v0130/browser-lifecycle-results.json；原扩展回归输出为temp/qa/browser-extension-results.json。旧版本记录如下保留为历史。

## 2026-11-10：0.12.0桥恢复、任务页面与多页操作

- 开始前`git pull --ff-only`显示已是最新，基线362ce46，工作区干净。源码/扩展/本地父市场同步0.12.0，共20个工具。新增tabGroups权限用于任务分组，未增加网页来源权限，未安装系统服务、计划任务或工具副本。
- 本地MCP启动预热桥并每5秒检查，失败指数退避至60秒，成功归零；工具调用共用启动门禁。只恢复传输，不重放浏览器命令；远端桥不代启动，MCP退出停止监督。supervisor.log固定单份有界，不按PID累积文件。
- open必填taskId/taskName，按任务与窗口分组；默认仅复用本任务插件页的同一完整URL，显式reuseKey支持同源同类页导航。用户原始页不自动复用/清理，移出分组交还用户；storage.session在worker重启间保留归属，在浏览器会话结束后清空。12页阈值先合并重复页，仍超限则拒绝继续膨胀。任务完成由agent显式finish；keep、活动/固定/有声、忙碌、修改/表单状态不安全及无法核验的页跳过，返回实际closed/skipped/remaining。旧版无归属页不追认。
- batch最多4个不同tabId真正并行；同页步骤仍顺序，逐项保留错误，不是事务。多页截图以多个MCP image返回；总结果过大时保留其他项，并提示超大图片单独请求。
- 输入mode=auto/dom/cdp遵守用户开关；CDP附加失败且尚未输入时自动回退DOM并在本页沿用。执行阶段失败不自动重放。单次DOM可解除附加但不改变全局设置；不自动刷新/绕过站点限制。弹窗文案改为“优先CDP，允许按页使用DOM”。技能要求DOM有歧义先截图/inspect，事实核验与业务授权分开。
- Node **65/65**通过，覆盖监督启动/退避/停止、任务隔离/持久化/复用/去重/阈值/保护、批次并行/单项失败、CDP安全降级与不重放，以及原安装/连接/诊断/协议回归。技能格式校验与git diff --check通过。
- Playwright真实Edge **8项新生命周期链路**通过：无工具调用时启动桥；真实标签组名称/归属隔离；两个快照同时进入Chrome注入阶段（双入口齐备后才放行，排除串行）；双页后台截图返回两张原生图且附加清除；模拟附加被拒绝后真实DOM计数恰好增加一次；keep与未保存表单保护/空组销毁；强制终止临时桥且不调用任何MCP工具，监督器自行拉起新PID，真实扩展接回；MCP退出后不再重启桥。
- 原真实扩展→桥→MCP **18项**、UI **19项**、动态列表 **7项**通过；包含CDP真实填表/点击、DOM菜单和悬停衔接、过期动作不重放、断线UI恢复、深色/200%DPI及懒加载业务身份回归。实际检查了本地截图。headless窗口属性与API事件不能代替日常桌面所有前台策略保证，既有后台行为的日常验证沿用0.11.0记录。
- 测试只使用临时profile、本地夹具和临时桥。新生命周期测试另隔离USERPROFILE，不修改用户桥、浏览器页面、授权或CDP开关。首轮Node有两项fetch报bad port，未留到具体分配端口；独立复跑与最终完整65项通过，初始输出留存。新生命周期夹具首次过早读取新页Page对象，补等待导航完成后通过。

重跑命令见README。证据与源码基线包：temp/qa/v0120/；预览包temp/ai-browser-control-0.12.0-local-preview.zip。日志、截图、profile、包体均不入Git。新版源码验收不等于用户扩展及当前MCP目录已重载；实际桥升级与推送状态另记delivery.json/push-receipt.json，不创建标签或GitHub Release。

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
