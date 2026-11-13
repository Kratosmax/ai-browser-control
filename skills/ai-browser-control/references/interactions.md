# 特殊交互、菜单与状态

先检查当前工具目录与browser_status的bridgeMethods，再从browser_list_tabs读取实际输入模式和capabilities。新工具不存在时报告客户端目录需要重连，不自行包装MCP/HTTP、不切换桌面控制；桥支持不代表已加载扩展也支持。

插件首次出现连接/注入/空回传/内部运行时或超时不可用时，按[故障交接](failure-reporting.md)立即停止并报告，下列正常页面回读步骤不得用于反复试错；维护者另获明确排障授权后才继续诊断。

## 菜单触发

1. snapshot(load=current)定位触发器，查看hasPopup、expanded、disabled、focused、checked、controls；必要时inspect读取遮挡、位置、select选项和身份是否变化。同名按钮传expectedContext，出现多个嵌套同名节点时结合tag/role/截图定位，不能靠上下文相同就认定唯一。
2. 依据页面证据选择触发方式：hover；click(button=right)；click(clickCount=2)；click(holdMs=500)；focus后press(Alt+ArrowDown/Space/Enter/Shift+F10)。不要把失败点击不断重试成其他动作。
3. hover的durationMs默认300、最多2000。异步菜单用wait(name=精确名称,role=menuitem,state=visible)或wait(text=已知菜单文字)，最长5000毫秒；matched=false只表示条件没满足，不能推断动作未发生。
4. 菜单出现后snapshot(load=current)获取菜单项新ref，核对目标后点击。多级菜单对每级分别hover→wait→snapshot；不要在菜单展开后使用load=auto滚动底层列表。
5. 所有动作actionDispatched仅代表派发，outcome=unverified需独立回读。展开菜单不授权创建、提交或删除；业务写入仍需用户明确授权。

分裂按钮优先定位独立箭头ref。箭头未单独暴露时依据截图/inspect位置使用click.position={x:0..1,y:0..1}，相对整个元素边框；不能假定所有按钮的0.95处都有箭头。插件校验ref身份和遮挡，但不会替agent理解子区域的业务含义。

0.10.1识别tabindex及明确关联弹层中的li、自绘指针项，标记inPopup，优先保留菜单候选项；inspect触发器的popups可核对关联弹层是否可见及候选项数。部分菜单项没有role=menuitem，应依据实际快照用精确name等待，不凭外观猜role。文字出现但仍无ref时，先用精确name且不猜role做load=current定位；异步/动画用一次有界wait(name=...,state=visible)后重新snapshot，不能只凭正文有字或刚展开就确认可操作。仍无ref才报告定位缺口，不能把展开菜单当作整个业务流程已可执行。

0.17.1补充原生td/th内容引用，以及有onclick处理器/属性或指针样式证据的自绘div/span/li等候选。candidateKind区分native-cell、custom-control、semantic，保留真实tag/role；native-cell不等于按钮、inPopup=false不代表不能选择。普通数据表格单元格也可能有内容ref，点击仍须有用户意图、目标上下文和独立验收。名称重复的generic/单元格需expectedContext；月份优先用context中的2026-10等标题核对年份，不能只按“10月”的第一个结果。

长按不额外补发click；CDP由浏览器处理按下/释放，浏览器本身仍可能生成click。不能承诺长按没有业务副作用，需先确认目标和用户授权。

0.11.0在关联菜单可见时保持视觉光标，并从上一次位置衔接后续移动；DOM点击前先把悬停状态转移到选项。inspect.cursor可回读position/held/visible。视觉保持不派发定时鼠标事件，不阻止网站自己的关闭策略；菜单已关闭时重新hover触发器、wait、snapshot获取新ref，不能点击旧位置或重放结果未知的业务操作。

## 控件、状态与等待

- focus只取得页面内焦点，不移动系统焦点；press可传ref及expectedContext，避免键盘送给错误控件。支持Shift+Tab、Alt+ArrowDown/Up、Shift+F10、Control+Enter以及原有键；Enter/Control+Enter可能提交。
- 原生select先inspect读取value选项，再select(values=[...])；多选可传多个值。已达到目标状态则不重复派发。自绘下拉框仍走菜单流程，不用select冒充支持。
- set_checked对checkbox/radio/ARIA switch等按目标布尔状态幂等操作；已符合时changed=false。原生radio不能单独取消。verified只确认读取到的控件状态，不代表业务已保存；自绘组件延迟更新仍需wait/snapshot回读。
- inspect可读不可见/禁用节点和identityChanged；出现身份变化时重新snapshot，不操作旧ref。快照每批最多150个ref，可用目标查询和cursor分页；编号变化按对应错误流程处理。
- wait可用ref或text或精确name+role，ref不与其他条件混用。ref等待不刷新快照；等待隐藏时移除或不可见可匹配，节点复用成另一身份则报错。wait不自动滚动；name可能重复，返回count不是唯一性证明。
- 拖拽必须核对fromRef/toRef各自业务身份，两个目标同时在同一主文档视口。DOM支持合成指针与HTML5 DataTransfer；CDP为真实指针拖动，不保证任意HTML5组件。动作结束会释放按键；结果未知先回读，不自动重放。

## 加载、白色覆盖与透明区域

只读检查必须对应当前tabId、URL和时刻。正文有筛选文字而无ref，可能是加载、透明/隐藏祖先或候选识别缺口；截图白色/发白只证明当时外观，不能直接断言插件遮罩、网站权限或永久不可用。工具正常时先对已知控件用一次有界wait/inspect后重新snapshot并核对截图，不能移除遮罩、修改CSS/pointerEvents或反复重建页面。普通未匹配与插件不可用按故障规则区分。

inspect追加style、最多6层ancestors、hitTarget和hitTest.status，辅助检查opacity/filter/visibility/pointerEvents与采样命中；这些是当前只读证据，不改变页面。hitTest不是tested或hit为null时，obscured=false不能单独证明可点；容器中心命中自己的某个子节点也不能证明每个筛选控件都未遮挡。检查具体控件并保留最新快照引用。页面恢复后更新结论，不沿用旧截图继续要求用户接管；别把另一个临时页的正常状态当成原业务页恢复。

## DOM/CDP边界

“CDP真实交互”沿用已有cdpEnabled设置，默认关闭；agent不得自动开启。DOM悬停派发pointer/mouse enter、over、move及离开事件，适合JavaScript菜单；不设置CSS :hover，不产生可信事件。蓝色光标只是反馈。CSS hover或拒绝非可信事件的网站需用户开启CDP后再测，截图CDP授权不能代替交互CDP授权。

0.12.0支持click/hover/drag/set_checked/fill/press的mode=auto/dom/cdp。auto仅在附加失败且未派发输入时自动降级DOM；执行阶段失败不重放。网站对CDP的限制需要现场证据，不能从单一异常推断；可用mode=dom解除附加后执行已确认尚未发生的动作。遮挡、同名目标或状态矛盾先截图再决定是否向用户求助，具体边界见[任务与验收](tasks-and-verification.md)。

不支持浏览器原生右键菜单、系统文件选择、跨域iframe内部控件、canvas内部目标与系统拖放。页面自绘菜单可snapshot读取。原生菜单出现后不要把DOM读取不到误当菜单未打开，也不要擅自换桌面控制。

错误包含结构化code，例如STALE_REF、TARGET_CHANGED、ELEMENT_DISABLED、ELEMENT_OBSCURED、TARGET_OUTSIDE_VIEWPORT、COMMAND_TIMEOUT、INVALID_ARGUMENTS；不能从单一错误码推断网站全部不可操作。长按/拖拽/修饰键有释放清理，已发给浏览器的动作仍不能保证取消。
