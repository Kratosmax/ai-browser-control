# RELIABILITY — 固定可靠性验收入口与矩阵

本文件定义固定可靠性验收入口、状态切换矩阵、故障类别和安全处理步骤。运行器只编排隔离验证，不操作真实业务页或修改用户配置。通过报告证明的是列出的场景与代码状态，不是零缺陷、所有网站或所有浏览器的保证。

每次报告记录当前产品版本、Git提交、分支和工作树状态、实际测试清单及输出；查不到的字段保留未知，不把失败查询当成干净树。历史基线和修复证据见TEST-RESULTS.md，本入口不硬编码测试数量。

## 1. 验收入口

```powershell
node scripts/check-reliability.mjs            # --unit（默认）：全部源码单元测试
node scripts/check-reliability.mjs --native   # 固定审计过的原生允许清单
node scripts/check-reliability.mjs --all      # unit + native
node scripts/check-reliability.mjs --all --list    # 只打印计划
node scripts/check-reliability.mjs --all --dry-run # 计划 + native 前置探测，不执行测试
```

零运行时依赖，Node 22+（低于 22 明确退出 6）。所有子进程用 argv 数组直接 spawn（不经 shell）；stdio 指向日志文件描述符，不使用可能悬挂的管道。超时清理在 Windows 上用 `taskkill /PID <pid> /T /F` 只终止本运行器启动的子树。

### 退出码（显式状态，不静默跳过）

| 码 | 含义 |
| --- | --- |
| 0 | 全部通过 |
| 2 | 参数错误（未知/重复/互斥/位置参数） |
| 3 | native 前置缺失（python3 / websocket / playwright / Edge）；明确失败并列出缺口，绝不装东西、绝不静默跳过 |
| 4 | 存在测试失败（退出码非 0） |
| 5 | 崩溃、单文件超时或阶段期限耗尽（未跑完的部分标记 `skipped-stage-deadline`） |
| 6 | 运行器内部错误（目录不可读、发现 0 个测试、Node 版本不足） |
| 130 | 被中断（SIGINT/SIGTERM；停止后续项并写部分报告） |

优先级：中断 > 前置缺失 > 崩溃/超时 > 失败 > 通过。任何"没真正跑完"的状态都不可能映射为 0。

### 报告（人类 + 机器双产物）

每次非 `--list` 运行写入 `temp/qa/reliability/<本地时间戳>/`：

- `report.json` — 机器可读（schema `ai-browser-reliability-report/1`）。钉住：provenance.productVersion、commit、分支、dirty 状态与变更清单（git 不可用时降级为 warning 而非伪造）、node 版本/平台/argv/PID、**精确测试清单**（每项含 command/args/status/exitCode/signal/durationMs/日志路径）、native 允许清单原样、前置探测明细、期限配置。
- `summary.txt` — 同步的人类可读摘要（控制台也打印逐项 `[unit n/N] PASS/FAIL/…`）。
- `stage/logs/<阶段>-<序号>-<名称>.log` — 每个测试的完整 stdout+stderr。
- `captures/*.log` — git/前置探测的捕获输出。

## 2. 单元发现契约（动态，不硬编码）

只读两个固定目录的**第一层**文件：`tests/*.test.mjs` 与 `extension/tests/*.test.cjs`。`temp/`、归档、历史夹具天然不在扫描范围（非递归 + 固定目录）。并行开发中的新文件（A: `extension/tests/reliability-background.test.cjs`、B: `extension/tests/reliability-page.test.cjs`、C: `tests/reliability-server.test.mjs`、Lead: `tests/recovery-policy.test.mjs`、`tests/recovery-integration.test.mjs`、D: `tests/reliability-runner.test.mjs`）落地即被发现，**数量与清单都不写死**；测试文件数以每次实际发现结果为准。新增测试只需放入这两个目录，无需登记。

任一必需测试目录不可读、或合计发现0个测试 → 退出6，不允许漏掉一半或空跑仍判通过。

## 3. native 固定允许清单与隔离审计

`--native` 只执行以下四个脚本（固定参数，写死在 `NATIVE_ALLOWLIST`）。审计结论来自通读各脚本的隔离护栏：

| 脚本 | 固定参数 | 隔离护栏（脚本内证据） | 依赖 |
| --- | --- | --- | --- |
| `tests/browser-frozen.py` | 无（默认 headless） | 私有桥随机端口且显式避开 17653（`free_port`）；临时 profile/家目录/TEMP 全部重定向到运行目录（`temp/qa/frozen-20261112-1831` 下）；stdio MCP；无用户 profile、无默认桥、无全局设置 | python3、websocket-client、Edge（`FROZEN_TEST_EDGE` 可覆盖） |
| `tests/browser-lifecycle-wake.py` | 无（默认 headless） | 同上模式（`temp/qa/wake-20261112-1904`；`LIFECYCLE_TEST_EDGE` 覆盖）；仅复用 frozen 的传输/进程助手 | python3、websocket-client、Node、Edge |
| `tests/browser-custom-controls.py` | `--source current --label reliability` | 仅本机机制夹具 + 127.0.0.1 随机端口 HTTP；Playwright `channel='msedge'` headless 持久 profile 在 `temp/qa/calendar-20261113/qa-reliability-edge-profile`（结束时自删）；不涉及桥/MCP/用户 profile；`--source current` 直接读工作树，不依赖 git 历史 | python3、playwright、Edge |
| `tests/browser-wait-lifecycle.py` | 无（**不带 `--baseline`**，即"当前源码模式"，前缀 `qa-updated-`） | 私有桥随机端口避开 17653；`TEMP/TMP/HOME/USERPROFILE/APPDATA/LOCALAPPDATA` 全重定向；扩展源码先复制进运行目录并以 bootstrap 存储屏障避免对默认桥的初始请求（`temp/qa/wait-20261113-1740`） | python3、websocket-client、Edge（`FROZEN_TEST_EDGE` 覆盖） |

四个脚本都以 `raise SystemExit(main())` 结束，0/1 退出码可被运行器直接透传。其余 Python 项（browser-ui / browser-extension / browser-loading / browser-lifecycle / browser-timeout）**不在允许清单**：它们各有额外基线/下载/对照需求，继续按 README 由 Lead 手工执行。

前置探测（只探测、不安装）：python3（win32 先 `python` 后 `py -3`，其余先 `python3`）、`websocket-client`、`playwright`（`importlib.util.find_spec`）、Edge（env 覆盖优先，其次常见安装路径）。任一缺失 → 退出 3 并逐项打印 `[MISSING]` 明细。`Pillow` 只有 browser-ui.py 需要，不在本清单前置内。

## 4. 可靠性矩阵（区域 → 现有测试 → 观察限制 → 发布门禁）

单元测试为 VM/隔离进程级；native 四项为真实 Edge + 私有桥级。门栏列给出发布前必须绿的项目。

| 区域 | 单元测试 | native | 观察到的限制 | 门禁 |
| --- | --- | --- | --- | --- |
| 页面生命周期（冻结/丢弃/后台唤醒） | `extension/tests/lifecycle-wake.test.cjs`、`background-wait*.test.cjs`（挂起计时/期限边界）、`batch-timeout.test.cjs`（批次内 frozen/discard 透传） | `browser-frozen.py`（preflight 拒绝 TAB_FROZEN/TAB_DISCARDED）、`browser-lifecycle-wake.py`（一次有界唤醒+核对+清理）、`browser-wait-lifecycle.py`（worker 持有轮询期间的冻结门） | 强制冻结 ≠ 自然冻结成因；唤醒仅 Edge157 真实验收过；冻结抢在原生调用中仍可能需维护（README 0.17.2 节） | unit 全绿 + 三个 native 脚本 exit 0 |
| 权限/授权 | `tests/bridge.test.mjs`（来源白名单/伪造 client-id 拒绝）、`extension/tests/page-interactions.test.cjs`、`mock.test.cjs` | （允许清单内无专门权限项；授权边界由上述单元 + frozen/wake 脚本内的授权检查覆盖） | 后台派发与已覆盖的原生结果接受检查授权/用途代次；已进入页面的异步RPC不能承诺即时撤销，activeTab语义不在VM内 | unit 全绿 |
| 身份与引用（ref 过期/快照漂移/分页/同名/自绘控件） | `extension/tests/expired-result.test.cjs`、`snapshot-query.test.cjs`、`page-rpc.test.cjs`、`reliability-page.test.cjs`、`custom-controls.test.cjs` | `browser-custom-controls.py`（真实 Edge 中 candidateKind/expectedContext/禁用阻断/分页唯一 ref） | 已加载 DOM ≠ 业务全量；旧轮游标/漂移返回 SNAPSHOT_CHANGED/STALE_CURSOR 后须重读，不重放动作 | unit 全绿 + custom-controls exit 0 |
| 批次与迟到结果（部分成功/迟到回传/重传） | `extension/tests/batch-timeout.test.cjs`（部分结果保留+超时诊断）、`expired-result.test.cjs`（迟到响应不覆盖新连接）、`task-recovery.test.cjs`、`tests/reliability-server.test.mjs`（畸形回传信封/桥侧拒收）、`tests/recovery-policy.test.mjs` + `recovery-integration.test.mjs`（恢复指引） | （桥/扩展层已由私有桥 native 项间接行使） | 批次非事务；单页失败不重放；桥 pending=0 ≠ 页空闲 | unit 全绿 |
| 命令超时/结果不确定 | `tests/bridge.test.mjs`、`browser-timeout` 系列（VM 侧对应单测） | （`browser-timeout.py` 不在允许清单，归 Lead 手工） | 11 秒命令期限后结果"不确定"：先回读，不重放、不清锁（README 连接异常排查节） | unit 全绿 |
| MCP/worker/桥恢复与版本对齐 | `tests/supervisor.test.mjs`、`mcp-restart.test.mjs`、`diagnostics.test.mjs`、`recovery-policy*.mjs`、`install.test.mjs` | （冻结、唤醒、等待三项真实使用私有桥与stdioMCP；自绘控件项直接调用隔离世界原代理，不覆盖MCP） | 重载/监督只恢复传输，绝不重放命令；版本对齐不证明页面空闲（recovery-policy 注释） | unit 全绿 |
| 运行器自身 | `tests/reliability-runner.test.mjs`（22 项：参数/发现/前置/超时/失败透传/退出码/CLI 冒烟） | — | 见 §6 限制 | runner 测试属于 unit，随套件全绿 |

## 5. 故障类别与安全处置

口径以当前代码为准（`server/recovery-policy.mjs` 的 `recoveryForError`，2026-11-13 读自工作树），本文不新增任何业务批准规则，只映射测试与验收视角：

| 类别（recovery-policy category） | 代表错误码（当前代码） | 安全处置要点 | 相关测试 |
| --- | --- | --- | --- |
| 无匹配/歧义目标（`target-state`、`ambiguous-target`） | `ELEMENT_NOT_VISIBLE`、`ELEMENT_DISABLED`、`ELEMENT_OBSCURED`、`AMBIGUOUS_TARGET`、`TARGET_OUTSIDE_VIEWPORT` | inspect/截图核对后补上下文重发**新**请求；空结果是正常语义，不当插件故障 | snapshot-query、custom-controls（.py+ .cjs）、reliability-page |
| 引用/身份漂移（`target-changed`） | `REF_EXPIRED`、`STALE_REF`、`STALE_CURSOR`、`SNAPSHOT_CHANGED`、`TARGET_CHANGED`、`PAGE_AGENT_DOCUMENT_CHANGED` | 重新读取取新引用，核对同一业务对象；**不重放刚才的动作** | expired-result、page-rpc、reliability-page、custom-controls.py |
| 授权缺口（`permission`） | `UNAUTHORIZED`、`PAGE_NOT_AUTHORIZED`、`CDP_DISABLED` | 用户处理授权/独立开关；agent 不扩权、不改设置 | bridge（来源白名单）、page-interactions、mock |
| 冻结/丢弃（`page-lifecycle`） | `TAB_FROZEN`、`TAB_DISCARDED` | 确认生命周期与旧操作状态；仅走已授权恢复入口；不自动切页/刷新/重放 | lifecycle-wake.test.cjs、browser-frozen.py、browser-lifecycle-wake.py |
| 运行中/结果未知（`operation-running`、`outcome-unknown`、`connection`） | `TAB_BUSY`、`COMMAND_TIMEOUT`、`CONNECTION_INVALIDATED`、`COMMAND_NOT_DISPATCHED` | 本次未派发≠旧操作失败；等底层实际结束；保留 commandId/阶段/operation 证据；不清锁、不重放 | batch-timeout、background-wait*、browser-wait-lifecycle.py |
| 内部/能力不可用（`capability-fault`、`page-wake`、`maintenance-window`） | `PAGE_AGENT_*` 系列、`PAGE_ACTION_FAILED`、`PAGE_WAKE_FAILED/TIMEOUT`、`MCP_BUSY`、`MCP_RESTARTING`、`MCP_WORKER_*`、`BRIDGE_TRANSPORT_ERROR` 等 | 保留首错+版本+阶段，停止依赖该能力的步骤并交接维护；不盲目刷新/重载/重放 | mcp-restart、supervisor、diagnostics、reliability-server、lifecycle-wake |

**总原则（baseline.json 不变量）**：授权双侧检查；原始目标/文档身份钉住；条件/命令预算外不发新方法；部分批次结果保留；原生工作所有权到实际结算；临时调试附加只由其创建者清理；冻结/权限/目标/内部故障类别保持区分；不重放动作、不改未批准设置；未知结果显式安全处置而非猜测。

## 6. 运行时故障检测与处理指引

0.17.3工作进程返回的浏览器工具错误和失败批次项追加`recovery`：固定category/action/instruction、maintenanceRequired、保守outcome及automaticReplay=false。它是下一步建议，不是新的业务授权或自动恢复操作；若结果未知，先核对实际状态，不能因引用过期、页面解冻或重连成功就重放原动作。普通matched=false不生成内部故障。

`browser_status.versionHealth`只判断MCP/桥/扩展与已知磁盘版本是否对齐，返回aligned/mismatch/unknown及固定nextActions；连接、pending=0或版本对齐都不证明页面空闲。`launcherHealth`用启动时启动器源码指纹与当前磁盘比较，hostReconnectRequired为true/false/null；旧启动器无法提供信息时保持unknown。browser_restart只替换worker，启动器本体有更新时需要宿主MCP断开重连，不能把worker新版本冒充整个MCP已加载。

需要维护交接时保留首错、commandId、phase、各层实际版本与现有operation；不采集Cookie、输入正文、HTML或业务截图到公开报告。不自动更改权限、CDP用途、登录、页面或系统设置。

## 7. 覆盖限制与历史失败

1. 集成期间恢复指引尚未接线时，Lead的recovery-integration测试曾失败；运行器正确返回4，接线后的真实私有MCP检查已通过。历史失败保留，不冒充当前开放问题，也不归给其它实现者。
2. dry-run仅验证计划和前置条件；正式验收使用--all并读取完整报告。通过的VM用例不是原生验证，原生套件数量/浏览器版本以本次报告与TEST-RESULTS.md为准。
3. custom-controls固定label为reliability。若存在前次崩溃的测试profile，先核实其归属、对应进程已结束及证据已保留，只清理那个测试目录；不删除用户浏览器profile，不盲目更换控制入口。
4. Windows超时只清理本运行器启动的子树；非Windows孙进程清理仍依赖脚本finally。强制冻结不证明用户自然冻结的策略，所有浏览器/网站/影子DOM/跨源框架未在此保证。
5. git无法取得时提交和工作树状态保持未知；git状态查询失败绝不写成干净树。产品版本从项目清单单独读取，不用runnerVersion替代产品版本。
6. 单元与原生阶段有明确期限；未执行、被中断、崩溃、超时或缺必需目录/依赖不能视为完成通过。--dry-run的成功只针对计划和前置，不代表用例通过。
7. 错误分类以server/recovery-policy.mjs为准。已经进入页面的异步函数、已经派发的原生调用不能保证即时撤销或回滚；后续后台步骤会核对授权，旧结果仍可能未知。
8. 发布运行开始后冻结源与测试代码；若改变执行逻辑，应另建验收报告，不用先前结果认证后来代码。最终安装/已加载状态仍须分别核对。

## 8. 正式完整验收序列

```powershell
node scripts/check-reliability.mjs --all --dry-run   # 计划 + 前置探测（应 exit 0）
node scripts/check-reliability.mjs --all             # 完整门禁（unit + native 四项）
# 报告与逐项日志在 temp/qa/reliability/<时间戳>/；退出码即门禁结论
```

历史 Python 项（ui/extension/loading/lifecycle/timeout）与真实业务页面验收不在本入口范围，按 README 由 Lead 决定是否另行执行。
