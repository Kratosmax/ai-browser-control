// install.mjs 沙盒测试：全部写入临时 --home / APPDATA，不触碰真实 agent 配置。
// 重跑：node --test tests/install.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { restartOutdatedBridges, killPortListener } from '../install.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (args, home, appData) => spawnSync(process.execPath, [path.join(repo, 'install.mjs'), ...args, '--home', home], {
  encoding: 'utf8',
  env: { ...process.env, APPDATA: appData }
});

test('restartOutdatedBridges：旧版本桥被替换为当前版本进程', async (t) => {
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const portFree = (port) => new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
  let port = 17990;
  while (port < 18020 && !(await portFree(port))) port++;
  assert.ok(port < 18020, '找到空闲测试端口');

  // 用当前代码启动一个"运行中的桥"进程
  const logDir = path.join(os.tmpdir(), 'zcode-restart-' + String(port));
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'bridge.log'), 'a');
  const child = spawn(process.execPath, [path.join(repo, 'server', 'bridge.mjs'), '--bridge', '--port', String(port)], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  const health = async () => { try { return await (await fetch('http://127.0.0.1:' + port + '/health')).json(); } catch { return null; } };
  let h = null;
  for (let i = 0; i < 30 && !(h = await health()); i++) await new Promise(r => setTimeout(r, 200));
  assert.ok(h, '测试桥应启动');

  const pluginVersion = JSON.parse(fs.readFileSync(path.join(repo, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
  const result = await restartOutdatedBridges({ candidates: [{ port, host: '127.0.0.1', allowIps: [] }], localVersion: '0.0.0-test' });
  assert.equal(result.length, 1);
  assert.equal(result[0].was, h.version);
  await new Promise(r => setTimeout(r, 500));
  const after = await health();
  assert.equal(after?.version, pluginVersion, '重启后应为当前版本');

  killPortListener(port);
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.zcode', 'ai-browser-control', String(port)), { recursive: true, force: true });
});

test('check 只读预检：输出指引与桥清单，不创建任何配置', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-check-home-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-check-appdata-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(appData, { recursive: true, force: true }); });
  const result = run(['check'], home, appData);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /预检/);
  assert.match(result.stdout, /register codex/);
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

test('update：按回执重放注册并刷新技能，--skip-pull 跳过 git', (t) => {
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

  const update = run(['update', '--skip-pull'], home, appData);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /✓ zcode：已刷新/);
  assert.match(update.stdout, /✓ codex：已刷新/);
  const json = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.match(json.mcp.servers['ai-browser-17653'].args[0], /server[\\/]mcp\.mjs$/);
  const skill = path.join(home, '.zcode', 'skills', 'ai-browser-control', 'SKILL.md');
  assert.equal(fs.existsSync(skill), true);
  assert.match(fs.readFileSync(skill, 'utf8'), /直接调用/);
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
