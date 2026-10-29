# AI 浏览器控制 0.6.0

让任意 AI Agent（Codex、Claude、Cursor 或其他支持 MCP 的助手）控制外部 Edge/Chrome 的指定标签页：读取、点击、填表、按键、导航、截图。命令经本机桥发给浏览器扩展，按 tabId 执行，使用浏览器调试协议输入，不调用桌面鼠标、不切换前台窗口。

## 快速接入（把本节交给 AI Agent 执行即可）

拿到本仓库（`git clone` 或下载 ZIP 解压）后，agent 按下面三步接入，**脚本不扫描、不批量注册，注册目标必须显式指定**：

1. **自查**：在你的 MCP 配置里搜索 `ai-browser-`，已注册则跳过第 2 步。
2. **生成桥实例**（多浏览器/自定义端口时）：`node install.mjs bridge add`——自动挑选空闲端口并持久化、立即启动；输出要填进扩展弹窗的端口号。单浏览器默认场景可跳过（默认端口 17653）。
3. **注册给自己**（写前备份 `.bak-*`、幂等，MCP 条目名为 `ai-browser-<端口>`）：
   `node install.mjs register <codex|claude-code|cursor|claude-desktop> --port <桥端口>`
4. **重启自己**，然后提醒用户完成两步浏览器侧操作（无法代点）：
   - `edge://extensions`（Chrome 为 `chrome://extensions`）→ 开发人员模式 → 加载解压缩的扩展 → 选仓库里的 `extension` 目录；
   - 点浏览器工具栏上的扩展图标——自动配对连接；多桥时把弹窗里的“本机桥端口”改成对应桥的端口（持久化）；建议勾选“自动授权所有网页”。

验收提示词：

> 使用 ai-browser 的 browser_status 检查连接，再 browser_list_tabs 列出我的标签页。只读。

依赖仅需 Node 22+，无 npm install。桥实例管理：`bridge list` 查看健康状态、`bridge remove <端口>` 移除登记。扩展连不上桥时按指数退避重试（2 秒起步、封顶 1 分钟，成功即恢复），不空耗。手动注册片段运行 `node install.mjs check` 可见，或直接用：

```json
{ "mcpServers": { "ai-browser-17653": { "command": "<node 路径>", "args": ["<仓库路径>\\server\\mcp.mjs", "--port", "17653"] } } }
```

### 多浏览器（Edge 一个 + Chrome 一个）

每个浏览器一个桥实例、互不干扰：

```bash
node install.mjs bridge add          # 例：挑中 17653（给 Edge）
node install.mjs bridge add          # 例：挑中 17654（给 Chrome）
node install.mjs register claude-code --port 17653   # 条目 ai-browser-17653 → Edge
node install.mjs register claude-code --port 17654   # 条目 ai-browser-17654 → Chrome
```

Edge 扩展弹窗端口填 17653，Chrome 扩展弹窗端口填 17654（同目录加载到两个浏览器，各自 storage 独立）。agent 里 `ai-browser-17653` 的工具只动 Edge，`ai-browser-17654` 只动 Chrome。同一桥的白名单上限 8 个扩展；不同桥之间完全隔离。

### 跨机器控制（浏览器与 agent 分离，0.5.0）

浏览器在 A 机器、agent 在 B 机器时，桥绑定 A 的网卡并对远程访问强制 token：

```bash
# A 机器（浏览器所在）：生成桥实例，绑定所有网卡，可选限制来源 IP（推荐）
node install.mjs bridge add --host 0.0.0.0 --allow-ip <B机器IP>
# 启动时会打印 token；之后随时可查（含按本机各网卡 IP 生成的即拷即用注册命令）：
node install.mjs bridge token <端口>
# token 也保存在 ~/.zcode/ai-browser-control/<端口>/token（0600）
```

```bash
# B 机器（agent 所在）：注册时必须带 token，缺了会被 401 拒绝
node install.mjs register codex --port <端口> --host <A机器IP> --token <token>
```

安全模型（务必理解后再开远程）：

- **token 是主防线**：非回环来源的每个请求都校验 `Authorization: Bearer <token>`（恒定时间比较）。IP 白名单只是附加限制，源 IP 可被局域网伪冒，不要单独依赖。
- 本机回环（127.0.0.1）豁免 token：扩展与 A 机器本地的 agent 照常一键配对。
- 网页来源依旧被 CORS 预检拦截，`/health` 之外所有远程接口都要 token。
- 桥以 `--host 0.0.0.0` 启动即对整个网络开放控制通道；只在可信局域网使用，不要做端口映射到公网。
- 公共电脑风险自担：那台机器上的人能看到调试提示条与浏览器内容，建议只用只读场景或专门账号。
- 轮换 token：删除实例目录的 `token` 文件并重启桥，随后更新 agent 配置。

测试与真实浏览器验收状态见 `TEST-RESULTS.md`。当前交付为源码仓库；ZCode 插件市场与本仓库独立，见文末说明。

## 组成

- `extension/`：Edge/Chrome MV3 扩展。一键配对；支持手动逐页授权和“自动授权所有网页”开关。
- `server/bridge.mjs`：仅监听 `127.0.0.1:17653` 的本地指令队列，扩展白名单配对。
- `server/mcp.mjs`：零第三方依赖的 MCP stdio 服务，9 个 browser_* 工具，任何 MCP 客户端都能接入。
- `.mcp.json`、`.zcode-plugin/plugin.json`、`skills/`：ZCode 接入配置与操作指引。
- `tests/`、`extension/tests/`：可重跑的协议与扩展测试；`test-page/`：真实浏览器手动验收页。

需要 Node 22+。配置写死了本机路径 `C:\Program Files\nodejs\node.exe`（`.mcp.json` 和两个 .cmd），复制到其他机器时按需调整，无需 npm install。

## 连接（最多两步）

1. **加载扩展**（首次一次）：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选本插件 `extension` 目录 → 固定到工具栏。
2. **连接**：点浏览器工具栏上的扩展图标。它会自动连接本机桥并完成配对，弹窗显示“已连接”即成功。

本机桥不需要手动启动：AI 调用 browser_* 工具时会自动拉起（也可双击 `启动桥接服务.cmd` 前台运行）。没有 token、没有配对码。

### 授权方式（弹窗里二选一）

- **手动模式**（默认）：对想让 AI 控制的页面，在扩展弹窗点“授权当前标签页”，逐页生效。
- **自动授权**：勾选“自动授权所有网页”，AI 即可按需读取和操作任何 HTTP(S) 标签页。开关只能由你在弹窗更改，AI 无法自行打开；控制时浏览器会短暂显示“正在调试此浏览器”提示条，点 × 可立即打断。

安全边界：本机桥只监听 127.0.0.1；网页来源一律拒绝（CORS 预检即被拦截）；扩展首次连接时把自己的 ID 登记进白名单（上限 8 个，重复连接幂等）。它防的是网页和跨源脚本，不防本机进程——这与旧 token 方案的实际强度相同。弹窗“断开”会把本扩展从白名单移除；停止桥接服务后删除 `%USERPROFILE%\.zcode\ai-browser-control\config.json` 可重置白名单。旧版本的 `external-browser-control` 目录和 pairing.json 已废弃，可自行删除。

## 在 ZCode 中安装插件（可选）

ZCode 用户也可以走插件市场（效果与 install.mjs 注册等价，额外带操作指引技能）：

1. 插件市场 → 添加 → 添加插件市场，粘贴市场根目录（本仓库的父目录 `temp\plugins`，内含 `marketplace.json`）。
2. 个人 → **dev-ai-browser-local** → “AI 浏览器控制” → 安装。
3. 新建任务，在插件/技能选择器选 `ai-browser-control`，发送：
   **“使用 AI 浏览器控制，列出浏览器标签页，读取标题包含 Magpie 的页面。只读，不点击、不填写、不导航。”**

其他 MCP 客户端：`install.mjs` 已覆盖 Codex / Claude Code / Claude Desktop / Cursor；不在列表里的客户端，直接以 stdio 注册 `node server/mcp.mjs` 即可，例如 Codex 的 `config.toml`：

```toml
[mcp_servers.ai-browser]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["<仓库路径>\\server\\mcp.mjs"]
```

更新：编辑源码 → 递增版本（`.zcode-plugin/plugin.json`、`marketplace.json`、`extension/manifest.json`）→ 插件市场齿轮 → 市场源刷新 → 插件详情点更新 → 新建任务。扩展代码改动需在 `edge://extensions` 点击扩展的“重新加载”。

## 验证后台控制

双击 `启动验收页面.cmd`，浏览器访问 `http://127.0.0.1:17654/`，开启自动授权（或对该页点授权），然后切到其他标签页，让 AI：

> 用 AI 浏览器控制读取“Magpie 控制验收页”，把“测试输入”替换为 background-ok，点击“记录一次”，再读取快照。不要切换前台窗口，不要导航。

预期：验收页计数为 1、文本为 background-ok，期间当前窗口和鼠标不动。刷新页面可重置。这是隔离本地测试页，不向外部发送数据。

## 工具

| 工具 | 作用 |
|---|---|
| browser_status | 检查桥接与扩展连接 |
| browser_list_tabs | 列出 HTTP/HTTPS 标签页及授权状态 |
| browser_snapshot | 读取已授权页面及元素 ref |
| browser_click | 按最新 ref 点击 |
| browser_fill | 替换文本框内容 |
| browser_press | 在目标标签页按键 |
| browser_navigate | 导航到明确的 HTTP/HTTPS 地址 |
| browser_screenshot | 截取目标网页 |
| browser_release | 释放标签页授权 |

快照会更新 ref；拿到旧 ref 或操作超时后重新读快照，超时不等于失败，不能盲目重复提交。快照只包含可见页面 DOM，不读取 Cookie、localStorage 或历史记录。

## 边界

首版支持主文档普通 DOM；跨域 iframe、封闭 Shadow DOM、canvas、系统文件选择框不支持，也不回退到桌面鼠标。多标签页共享登录与服务端状态，界面不抢焦点不代表业务隔离。浏览器节流、模态弹窗、DevTools 占用 debugger 等情形需真实环境确认。

## 停用与回滚

1. 扩展弹窗“断开”（移除白名单）→ 浏览器扩展页禁用/移除扩展。
2. ZCode 设置 → 插件，禁用/卸载。
3. 停止本机桥：任务管理器结束命令行含 `bridge.mjs --bridge` 的 node 进程，或关闭其窗口。
4. 彻底清除：删除插件目录和 `%USERPROFILE%\.zcode\ai-browser-control\`。

未改浏览器启动参数、未开放远程调试端口、未修改 ZCode 已有配置。
