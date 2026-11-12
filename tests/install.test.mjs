// install.mjs 沙盒测试：全部写入临时 --home / APPDATA，不触碰真实 agent 配置。
// 重跑：node --test tests/install.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { restartOutdatedBridges, killPortListener } from '../install.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (args, home, appData) => spawnSync(process.execPath, [path.join(repo, 'install.mjs'), ...args, '--home', home], {
  encoding: 'utf8',
  env: { ...process.env, APPDATA: appData }
});

test('restartOutdatedBridges：旧版本桥被替换，进程与配置均隔离', { skip: process.platform !== 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-restart-home-'));
  const children = [];
  // 先登记清理，断言/启动失败也只结束本测试直接创建的 ChildProcess。
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const net = await import('node:net');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const spawnOwned = (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  const configDir = path.join(home, 'custom-bridge-state');
  spawnOwned(process.execPath, [path.join(repo, 'server', 'bridge.mjs'), '--bridge', '--port', String(port), '--config-dir', configDir], {
    stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  // 同端口另一 IP 上的普通服务也由本测试创建，重启不能误杀它。
  const unrelated = spawnOwned(process.execPath, ['--input-type=module', '-e', `import http from 'node:http'; http.createServer((req, res) => res.end(JSON.stringify({ service: 'unrelated' }))).listen(${port}, '127.0.0.2');`], { stdio: 'ignore' });
  const health = async (host = '127.0.0.1') => {
    try { return await (await fetch('http://' + host + ':' + port + '/health', { signal: AbortSignal.timeout(500) })).json(); } catch { return null; }
  };
  let before;
  for (let i = 0; i < 50 && !(before = await health()); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(before?.service, 'ai-browser-control', '测试桥应启动');
  let other;
  for (let i = 0; i < 50 && !(other = await health('127.0.0.2')); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(other?.service, 'unrelated', '另一个 IP 上的同端口服务应启动');
  const tokenFile = path.join(configDir, 'token');
  const originalToken = fs.readFileSync(tokenFile, 'utf8');
  assert.equal(fs.existsSync(path.join(home, '.zcode', 'ai-browser-control', String(port))), false, '配置只写入显式临时目录');
  const processChecks = [];
  const result = await restartOutdatedBridges({
    candidates: [{ port, host: '127.0.0.1', allowIps: [], pid: children[0].pid }],
    localVersion: '0.0.0-test', home, spawnBridge: spawnOwned,
    run: (...args) => { const checked = spawnSync(...args); processChecks.push(checked); return checked; }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].killed, true, JSON.stringify({ result, processChecks }));
  assert.equal(result[0].was, before.version);
  assert.equal(result[0].now, before.version, JSON.stringify(result));
  assert.equal(children.length, 3);
  assert.equal(result[0].pid, children[2].pid);
  assert.notEqual(children[0].pid, children[2].pid);
  assert.equal((await health())?.version, before.version);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), originalToken, '更新保留原桥显式配置目录与token');
  assert.equal(unrelated.exitCode, null, '同端口不同 IP 的进程保持存活');
  assert.equal((await health('127.0.0.2'))?.service, 'unrelated');
});

test('killPortListener：精确端点、本仓库入口与 PID 身份验证后才终止', () => {
  const port = 17999;
  const bridge = path.join(repo, 'server', 'bridge.mjs');
  const info = { pid: 987654, executable: process.execPath, created: 'test-start', started: '123456', command: `"${process.execPath}" "${bridge}" --bridge --port ${port}` };
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: JSON.stringify(info) };
  };
  assert.equal(killPortListener(port, { platform: 'win32', expectedPid: info.pid, run }), true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].args.at(-1), /LocalAddress -ceq '127\.0\.0\.1'/);
  assert.match(calls[0].args.at(-1), /LocalPort -eq 17999/);
  assert.equal(calls[2].command, 'powershell.exe');
  assert.match(calls[2].args.at(-1), /GetProcessById/);
  assert.match(calls[2].args.at(-1), /\$heldHandle = \$target\.Handle/);
  assert.match(calls[2].args.at(-1), /StartTime[\s\S]+Get-CimInstance[\s\S]+Get-NetTCPConnection[\s\S]+\$target\.Kill\(\)/);

  for (const override of [
    { pid: process.pid }, { pid: 0 }, { executable: bridge },
    { command: `"${process.execPath}" "${path.join(repo, 'server', 'mcp.mjs')}" --bridge --port ${port}` },
    { command: info.command.replace('--bridge', '--status') },
    { command: info.command.replace(String(port), String(port + 1)) },
    { command: info.command + ' --host 0.0.0.0' },
    { command: info.command + ' --port 17653' },
    { command: info.command + ' --eval anything' },
    { created: '' }, { started: '' }
  ]) {
    let terminated = false;
    const fake = (command, args) => { if (args.at(-1).includes('$target.Kill()')) terminated = true; return { status: 0, stdout: JSON.stringify({ ...info, ...override }) }; };
    assert.equal(killPortListener(port, { platform: 'win32', run: fake }), false, JSON.stringify(override));
    assert.equal(terminated, false);
  }
  let probes = 0;
  assert.equal(killPortListener(port, { platform: 'win32', run: () => ({ status: 0, stdout: JSON.stringify({ ...info, created: String(++probes) }) }) }), false, 'PID 创建时间变化时拒绝终止');
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { platform: 'win32', host: '192.0.2.1' }, { platform: 'win32', host: "127.0.0.1';exit" }]) {
    assert.equal(killPortListener(port, { ...options, run: () => assert.fail('拒绝的目标不能查询或终止进程') }), false);
  }
  for (const response of [{ status: 1, stdout: JSON.stringify(info) }, { status: 0, stdout: '{}' }, { status: 0, stdout: 'invalid' }]) {
    assert.equal(killPortListener(port, { platform: 'win32', run: () => response }), false);
  }
  assert.equal(killPortListener(port, { platform: 'win32', expectedPid: info.pid + 1, run }), false);
  let count = 0;
  assert.equal(killPortListener(port, { platform: 'win32', run: () => ++count < 3 ? { status: 0, stdout: JSON.stringify(info) } : { status: 1 } }), false, '终止命令失败不能报告成功');
});

test('restartOutdatedBridges：伪装 health 的非桥服务保持运行且不新起', async t => {
  const { createServer } = await import('node:http');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-unrelated-home-'));
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'ai-browser-control', version: 'old' })); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const result = await restartOutdatedBridges({ candidates: [{ port, host: '127.0.0.1' }], localVersion: 'new', home, spawnBridge: () => assert.fail('非桥服务不应触发新进程') });
  assert.equal(result[0].killed, false);
  assert.match(result[0].now, /无法安全确认/);
  assert.equal((await (await fetch('http://127.0.0.1:' + port + '/health')).json()).version, 'old');
  assert.deepEqual(fs.readdirSync(home), []);
});

test('check 只读预检：输出指引与桥清单，不创建任何配置', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-check-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-check-appdata-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const result = run(['check'], home, appData);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /预检/);
  assert.match(result.stdout, /AGENT-INTEGRATION\.md/);
  assert.match(result.stdout, /ai-browser-/);
  assert.equal(fs.readdirSync(home).length, 0);
  assert.equal(fs.readdirSync(appData).length, 0);
});

test('裸运行和未知目标被拒绝，不做任何写入', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bare-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bare-appdata-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const bare = run([], home, appData);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /不扫描/);
  const unknown = run(['register', 'copilot'], home, appData);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /未知 agent/);
  assert.equal(fs.readdirSync(home).length, 0);
});

test('update 默认不要求旧注册回执，也不重写 agent 配置', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-browser-norm-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-browser-norm-app-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const config = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = '# 用户按接入规范自行配置\nmodel = "user-choice"\n';
  fs.writeFileSync(config, original);
  const result = run(['update', '--skip-pull'], home, appData);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.match(result.stdout, /保留现有 agent 配置/);
  assert.match(result.stdout, /重新加载/);
  assert.equal(fs.existsSync(path.join(home, '.zcode', 'ai-browser-control', 'installed.json')), false);
});

test('bridge add --no-start：自动挑空闲端口并持久化，两次端口不同', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bridge-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bridge-appdata-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const first = run(['bridge', 'add', '--no-start'], home, appData);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /桥实例已登记/);
  const second = run(['bridge', 'add', '--no-start'], home, appData);
  assert.equal(second.status, 0, second.stderr);
  const bridgesFile = path.join(home, '.zcode', 'ai-browser-control', 'bridges.json');
  const bridges = JSON.parse(fs.readFileSync(bridgesFile, 'utf8')).bridges;
  assert.equal(bridges.length, 2);
  assert.notEqual(bridges[0].port, bridges[1].port);
  for (const bridge of bridges) {
    assert.ok(bridge.port >= 17653 && bridge.port < 17713, `端口应在候选范围内：${bridge.port}`);
    assert.equal(fs.existsSync(path.join(home, '.zcode', 'ai-browser-control', String(bridge.port))), false, '--no-start 不应创建运行目录');
  }
});

test('update --refresh-registration：显式按旧回执刷新；--skip-pull 跳过 git', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-update-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-update2-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  assert.equal(run(['register', 'zcode', '--port', '17653'], home, appData).status, 0);
  assert.equal(run(['register', 'codex', '--port', '17653'], home, appData).status, 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'ai-browser-control', 'installed.json'), 'utf8'));
  assert.equal(receipt.entries.length, 2);

  // 模拟"仓库更新后本地副本还是旧的"：清掉已装内容
  const config = path.join(home, '.zcode', 'cli', 'config.json');
  fs.writeFileSync(config, JSON.stringify({ theme: 'light' }));
  fs.rmSync(path.join(home, '.zcode', 'skills', 'ai-browser-control'), { recursive: true, force: true });

  const update = run(['update', '--skip-pull', '--refresh-registration'], home, appData);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /✓ zcode：已刷新/);
  assert.match(update.stdout, /✓ codex：已刷新/);
  const json = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.match(json.mcp.servers['ai-browser-17653'].args[0], /server[\\/]mcp\.mjs$/);
  const skill = path.join(home, '.zcode', 'skills', 'ai-browser-control', 'SKILL.md');
  assert.equal(fs.existsSync(skill), true);
  assert.match(fs.readFileSync(skill, 'utf8'), /直接调用/);
  const reference = path.join(path.dirname(skill), 'references', 'dynamic-lists.md');
  assert.equal(fs.readFileSync(reference, 'utf8'), fs.readFileSync(path.join(repo, 'skills', 'ai-browser-control', 'references', 'dynamic-lists.md'), 'utf8'));
});

test('register zcode：写入用户级 mcp.servers，保留既有设置与其他服务器，备份且幂等', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reg-zcode-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reg-zcode2-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const config = path.join(home, '.zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ theme: 'dark', mcp: { servers: { keep: { type: 'stdio', command: 'x' } } } }));

  const first = run(['register', 'zcode', '--port', '17653'], home, appData);
  assert.equal(first.status, 0, first.stderr);
  const json = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(json.theme, 'dark');
  assert.equal(json.mcp.servers.keep.command, 'x');
  const entry = json.mcp.servers['ai-browser-17653'];
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.enabled, true);
  assert.match(entry.args[0], /server[\\/]mcp\.mjs$/);
  assert.deepEqual(entry.args.slice(1), ['--port', '17653']);
  assert.equal(fs.readdirSync(path.dirname(config)).filter(x => x.startsWith('config.json.bak-')).length, 1);

  const second = run(['register', 'zcode', '--port', '17653'], home, appData);
  assert.equal(second.status, 0);
  const again = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(Object.keys(again.mcp.servers).filter(k => k.startsWith('ai-browser')).length, 1);
  assert.equal(again.theme, 'dark');
  const skill = path.join(home, '.zcode', 'skills', 'ai-browser-control', 'SKILL.md');
  assert.equal(fs.existsSync(skill), true);
  assert.match(fs.readFileSync(skill, 'utf8'), /直接调用/);
});

test('register 点名注册：条目名含端口、args 带 --port、备份且幂等', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reg-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reg-appdata-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });

  const codex = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, '[mcp_servers.other]\ncommand = "C:/other/agent.exe"\nargs = ["serve"]\n');
  const cursor = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursor), { recursive: true });
  fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { keepme: { command: 'x' } } }));
  const claudeCode = path.join(home, '.claude.json');
  fs.writeFileSync(claudeCode, JSON.stringify({ mcpServers: {} }));
  const desktop = path.join(appData, 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, '{}');

  const codexRun = run(['register', 'codex', '--port', '17653'], home, appData);  assert.equal(codexRun.status, 0, codexRun.stderr);
  const toml = fs.readFileSync(codex, 'utf8');
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.ai-browser-17653\]/);
  assert.match(toml, /"--port",\s*"17653"/);
  assert.equal(fs.readdirSync(path.dirname(codex)).filter(x => x.startsWith('config.toml.bak-')).length, 1);
  const agentsMd = path.join(home, '.codex', 'AGENTS.md');
  assert.equal(fs.existsSync(agentsMd), true);
  assert.match(fs.readFileSync(agentsMd, 'utf8'), /直接调用这些工具/);

  const cursorRun = run(['register', 'cursor'], home, appData);
  assert.equal(cursorRun.status, 0, cursorRun.stderr);
  const cursorJson = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  assert.equal(cursorJson.mcpServers.keepme.command, 'x');
  assert.match(cursorJson.mcpServers['ai-browser-17653'].args[0], /server[\\/]mcp\.mjs$/);

  const claudeRun = run(['register', 'claude-code', '--port', '17654', '--no-cli'], home, appData);
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  const claudeJson = JSON.parse(fs.readFileSync(claudeCode, 'utf8'));
  const claudeEntry = claudeJson.mcpServers['ai-browser-17654'];
  assert.match(claudeEntry.args[0], /server[\\/]mcp\.mjs$/);
  assert.equal(claudeEntry.args[1], '--port');
  assert.equal(claudeEntry.args[2], '17654');
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  assert.equal(fs.existsSync(claudeMd), true);
  assert.match(fs.readFileSync(claudeMd, 'utf8'), /browser_snapshot/);
  const cursorHint = run(['register', 'cursor', '--port', '17654'], home, appData);
  assert.equal(cursorHint.status, 0);
  assert.match(cursorHint.stdout, /粘贴到 Cursor 的全局 Rules/);

  const desktopRun = run(['register', 'claude-desktop', '--port', '17654'], home, appData);
  assert.equal(desktopRun.status, 0, desktopRun.stderr);
  const desktopJson = JSON.parse(fs.readFileSync(desktop, 'utf8'));
  assert.match(JSON.stringify(desktopJson.mcpServers['ai-browser-17654'].args), /17654/);

  // 幂等：重复注册不产生重复段落，原有内容保留
  const again = run(['register', 'codex', '--port', '17653'], home, appData);
  assert.equal(again.status, 0);
  const tomlAgain = fs.readFileSync(codex, 'utf8');
  assert.equal(tomlAgain.match(/\[mcp_servers\.ai-browser-17653\]/g).length, 1);
  assert.match(tomlAgain, /\[mcp_servers\.other\]/);
  const agentsAgain = fs.readFileSync(agentsMd, 'utf8');
  assert.equal(agentsAgain.match(/ai-browser-control:start/g).length, 1, '指引幂等更新');
});

test('远程桥注册：条目名含主机、args 带 host/token；缺 token 拒绝；bridge add 持久化 host 与白名单', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-remote-reg-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-remote-reg2-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const cursor = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursor), { recursive: true });
  fs.writeFileSync(cursor, '{}');

  const missing = run(['register', 'cursor', '--port', '17653', '--host', '192.0.2.10'], home, appData);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /token/);

  const ok = run(['register', 'cursor', '--port', '17653', '--host', '192.0.2.10', '--token', 'a'.repeat(64)], home, appData);
  assert.equal(ok.status, 0, ok.stderr);
  const json = JSON.parse(fs.readFileSync(cursor, 'utf8'));
  const entry = json.mcpServers['ai-browser-192-0-2-10-17653'];
  assert.match(entry.args[0], /server[\\/]mcp\.mjs$/);
  assert.deepEqual(entry.args.slice(1), ['--port', '17653', '--host', '192.0.2.10', '--token', 'a'.repeat(64)]);

  const add = run(['bridge', 'add', '--no-start', '--host', '0.0.0.0', '--allow-ip', '10.0.0.2'], home, appData);
  assert.equal(add.status, 0, add.stderr);
  const bridges = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'ai-browser-control', 'bridges.json'), 'utf8')).bridges;
  const entry0 = bridges.find(b => b.host === '0.0.0.0');
  assert.ok(entry0, '应登记 host=0.0.0.0 的桥');
  assert.deepEqual(entry0.allowIps, ['10.0.0.2']);
});
