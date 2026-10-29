# 验证记录

版本：ai-browser-control 0.5.4（0.3 重命名+一键配对；0.4 多桥端口+退避；0.5 跨机器 token；0.5.4 待机感知）。

## 0.5.4 新增验证

真实环境发现：Edge 会把扩展后台 Service Worker 挂起（实测 7.6 分钟无轮询），期间 browser_status 误报"未连接"、/rpc 直接 503 拒绝。修复并覆盖：

- /status 增加 standby（待机）与 lastSeenAgeMs：待机如实显示，不再误报未连接（90 秒内视为在线）。
- /rpc 待机时挂住请求等待扩展唤醒（默认最长 25 秒）而不是立刻拒绝；唤醒后正常投递；超时给"点扩展图标立即唤醒"的可操作提示；从未连接过仍立即 503 带指引。
- 待机等待测试：251ms 后进入待机，/rpc 等 800ms 得到 504 待机提示；扩展恢复轮询后命令正常投递（22/22 通过）。

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
