"""Real isolated Edge -> extension -> private bridge -> stdio MCP timeout regression.

Run: python -B tests/browser-timeout.py
Only writes this test's real-edge-* QA children. No user profile/config or default port.
The worker-only gate delays delivery of REAL executeScript file-injection promises;
it is deterministic fault injection, not evidence of the production incident's cause.
The loading probe uses the unwrapped native API and a real parser-blocking resource.
"""
import hashlib
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa' / 'timeout-20261112-1728'
HTML = b'''<!doctype html><meta charset="utf-8"><title>Timeout fixture</title>
<h1>Timeout fixture</h1><input aria-label="Note" value="unchanged">
<button onclick="window.clicks++">Count</button><script>window.clicks=0</script>'''
GATE_SCRIPT = """() => {
  globalThis.qaNative = chrome.scripting.executeScript.bind(chrome.scripting);
  globalThis.qaGates = new Map();
  globalThis.qaStats = {};
  globalThis.qaEvents = [];
  globalThis.qaRelease = id => {
    const gate = qaGates.get(id);
    if (!gate || gate.released) throw new Error('Missing or duplicate gate');
    gate.released = true;
    gate.resolve();
  };
  chrome.scripting.executeScript = spec => {
    const id = spec.target.tabId;
    const stats = qaStats[id] ||= {files:0,nativeSettled:0,callbacks:0,rpcs:[]};
    if (!spec.files) {
      stats.rpcs.push(spec.args?.[0] || 'other');
      return qaNative(spec);
    }
    stats.files++;
    qaEvents.push({tabId:id,kind:'native-start',time:Date.now()});
    const native = qaNative(spec);
    const gate = qaGates.get(id);
    // Always call native executeScript once; gate only delivery to production await.
    return native.then(async result => {
      stats.nativeSettled++;
      qaEvents.push({tabId:id,kind:'native-settled',time:Date.now()});
      if (gate) await gate.promise;
      stats.callbacks++;
      qaEvents.push({tabId:id,kind:'callback',time:Date.now()});
      return result;
    });
  };
  globalThis.qaGate = id => {
    if (qaGates.has(id)) throw new Error('Gate already installed');
    let resolve;
    const promise = new Promise(r => {resolve=r});
    qaGates.set(id,{promise,resolve,released:false});
  };
}"""


def until(fn, timeout=8, label='condition'):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.04)
    raise AssertionError('Timed out waiting for ' + label)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class MCP:
    """A reader thread may block in readline; callers only use bounded queue waits.

    Closing/killing the tracked process tree closes stdout; the reader is joined.
    stderr goes to a file, so a full stderr pipe cannot deadlock the child.
    """
    def __init__(self, port, env, stderr):
        self.process = subprocess.Popen(
            ['node', 'server/mcp.mjs', '--port', str(port)], cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
        self.messages = queue.Queue()
        self.sequence = 0
        self.calls = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except BaseException as error:
            self.messages.put({'readerError': repr(error)})
        finally:
            self.messages.put({'eof': True})

    def tool(self, name, args=None, timeout=16):
        self.sequence += 1
        request = {'jsonrpc': '2.0', 'id': self.sequence, 'method': 'tools/call',
                   'params': {'name': name, 'arguments': args or {}}}
        start = time.monotonic()
        self.process.stdin.write(json.dumps(request) + '\n')
        self.process.stdin.flush()
        deadline = start + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f'MCP response deadline: {name}')
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(f'MCP response deadline: {name}') from error
            assert not message.get('eof') and 'readerError' not in message, message
            if message.get('id') == self.sequence:
                break
        assert 'error' not in message, message
        result = message['result']
        elapsed = time.monotonic() - start
        self.calls.append({'name': name, 'requestId': self.sequence,
                           'elapsedSeconds': round(elapsed, 3), 'response': result})
        assert not result.get('isError'), result
        return json.loads(result['content'][0]['text']), elapsed

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=6)
            except (OSError, subprocess.TimeoutExpired):
                kill_tree(self.process.pid)
                self.process.wait(timeout=5)
        self.reader.join(timeout=3)
        assert not self.reader.is_alive(), 'MCP stdout reader leaked'
        self.process.stdout.close()


def kill_tree(pid):
    # Only PIDs launched by this test or recorded in its private bridge log.
    result = subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                            capture_output=True, text=True, timeout=8,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    return {'pid': pid, 'exitCode': result.returncode,
            'output': (result.stdout + result.stderr).strip()}


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='real-edge-', dir=OUT))
    report = {'result': 'running', 'checks': [], 'artifactDirectory': str(run),
              'limitations': ['Gated native promise delivery is controlled fault injection, not proof of incident root cause.',
                              'Headless fresh-profile Edge; no user browser, login, or frozen-document coverage.']}
    started = time.monotonic()
    mcp = None
    context = None
    bridge_pids = set()
    release = threading.Event()
    requested = threading.Event()
    previous_env = os.environ.copy()
    bridge_log = None
    stderr = None

    def check(name, condition, **evidence):
        entry = {'name': name, 'passed': bool(condition), **evidence}
        report['checks'].append(entry)
        assert condition, entry
        print('PASS ' + name, flush=True)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/hold.js':
                requested.set()
                if not release.wait(20):
                    self.send_error(504)
                    return
                payload = b'window.slowResourceReleased=true'
                content_type = 'text/javascript'
            else:
                payload = HTML + (b'<script src="/hold.js"></script>' if self.path == '/loading' else b'')
                content_type = 'text/html; charset=utf-8'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base = f'http://127.0.0.1:{server.server_port}'

    def bridge_records():
        if bridge_log is None or not bridge_log.exists():
            return []
        records = []
        for line in bridge_log.read_text(encoding='utf-8').splitlines():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # A concurrent append can leave the final line incomplete.
        bridge_pids.update(r['pid'] for r in records if r.get('event') == 'bridge_start')
        return records

    try:
        home = run / 'home'
        for child in ['AppData/Roaming', 'AppData/Local', 'tmp']:
            (home / child).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home),
               'APPDATA': str(home / 'AppData/Roaming'),
               'LOCALAPPDATA': str(home / 'AppData/Local'),
               'TEMP': str(home / 'tmp'), 'TMP': str(home / 'tmp'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        os.environ.update(env)
        port = free_port()
        while port in [17653, server.server_port]:
            port = free_port()
        bridge_log = home / '.zcode' / 'ai-browser-control' / str(port) / 'bridge.log'
        report['ports'] = {'bridge': port, 'fixture': server.server_port}
        report['version'] = json.loads((ROOT / '.zcode-plugin/plugin.json').read_text(encoding='utf-8'))['version']
        source_paths = ['extension/background.js', 'server/bridge.mjs', 'server/mcp-worker.mjs']
        report['sourceSHA256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_paths}
        extension = run / 'extension'
        shutil.copytree(ROOT / 'extension', extension, ignore=shutil.ignore_patterns('tests'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (extension / 'qa-bootstrap.js').write_text(
            f"const qaInit=chrome.storage.local.set({{bridgePort:{port},autoAuthorize:true,disconnected:true}});"
            "const qaGet=chrome.storage.local.get.bind(chrome.storage.local);"
            "chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};importScripts('background.js');",
            encoding='utf-8')
        stderr = (run / 'mcp-stderr.log').open('w', encoding='utf-8')
        mcp = MCP(port, env, stderr)
        until(lambda: any(r.get('event') == 'bridge_start' for r in bridge_records()), label='private bridge startup')
        report['mcpLauncherPid'] = mcp.process.pid
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(run / 'profile'), channel='msedge', headless=True,
                viewport={'width': 1000, 'height': 700}, env=env,
                args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
                      '--no-first-run', '--no-default-browser-check'],
                ignore_default_args=['--disable-extensions'], timeout=20000)
            try:
                context.set_default_timeout(7000)
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=10000)
                until(lambda: worker.evaluate("typeof handlePopup==='function'"), label='extension startup')
                original = context.pages[0]
                original.goto(base + '/anchor')
                worker.evaluate("handlePopup({type:'connect'})")
                status = until(lambda: (lambda x: x if x['connected'] else None)(mcp.tool('browser_status')[0]), label='MCP extension connection')
                report['browserVersion'] = context.browser.version
                check('Real stdio MCP, private bridge and Edge extension connected',
                      status['extensionVersion'] == report['version'] == status['mcpVersion'],
                      mcpVersion=status['mcpVersion'], extensionVersion=status['extensionVersion'])
                active_before = worker.evaluate('chrome.tabs.query({active:true}).then(t=>t.map(x=>x.id))')

                # Native baseline: omitted injectImmediately defaults false. No API wrapper here.
                loading = context.new_page()
                loading.goto(base + '/loading', wait_until='commit', timeout=7000)
                until(requested.is_set, label='real slow resource request')
                loading_id = worker.evaluate("async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id", base + '/loading')
                # Make the original anchor active inside this isolated browser before probing.
                worker.evaluate('id=>chrome.tabs.update(id,{active:true})', active_before[0])
                loading_active = worker.evaluate('chrome.tabs.query({active:true}).then(t=>t.map(x=>x.id))')
                worker.evaluate("""id=>{
                  globalThis.qaBaseline={started:Date.now(),done:false};
                  chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:()=>document.readyState})
                    .then(result=>Object.assign(qaBaseline,{done:true,result,ended:Date.now()}),
                          error=>Object.assign(qaBaseline,{done:true,error:String(error)}));
                }""", loading_id)
                loading.wait_for_timeout(850)
                baseline_before = worker.evaluate('qaBaseline')
                check('Native default injection remains blocked by unreleased parser resource',
                      not baseline_before['done'] and not release.is_set(), baseline=baseline_before)
                loading_start = time.monotonic()
                snapshot, elapsed = mcp.tool('browser_snapshot', {'tabId': loading_id, 'load': 'current'}, timeout=7)
                check('Production immediate snapshot current succeeds before server release',
                      snapshot['title'] == 'Timeout fixture' and not release.is_set() and elapsed < 5,
                      elapsedSeconds=round(time.monotonic() - loading_start, 3),
                      baselineStillPending=not worker.evaluate('qaBaseline.done'))
                check('Loading snapshot keeps the target inactive and active tabs unchanged',
                      worker.evaluate('chrome.tabs.query({active:true}).then(t=>t.map(x=>x.id))') == loading_active
                      and not worker.evaluate('id=>chrome.tabs.get(id).then(t=>t.active)', loading_id))
                release.set()
                loading.wait_for_load_state('load', timeout=7000)
                baseline_after = until(lambda: worker.evaluate('qaBaseline') if worker.evaluate('qaBaseline.done') else None,
                                       label='native default injection after release')
                check('Native default injection settles successfully only after resource release',
                      'error' not in baseline_after and bool(baseline_after.get('result')), baseline=baseline_after)

                ids = {}
                pages = {}
                refs = {}
                for name in ['fast', 'snapshot', 'fill', 'click']:
                    with context.expect_page(timeout=7000) as created:
                        tab = worker.evaluate('url=>chrome.tabs.create({url,active:false})', base + '/' + name)
                    ids[name] = tab['id']
                    pages[name] = created.value
                    pages[name].wait_for_url(base + '/' + name, wait_until='load', timeout=7000)
                    snap, _ = mcp.tool('browser_snapshot', {'tabId': tab['id'], 'load': 'current'})
                    refs[name] = {element.get('role'): element['ref'] for element in snap['elements'] if element.get('role') in ['textbox', 'button']}
                check('Valid real snapshot refs prepared for fill and click',
                      'textbox' in refs['fill'] and 'button' in refs['click'])
                worker.evaluate(GATE_SCRIPT)
                for name in ['snapshot', 'fill', 'click']:
                    worker.evaluate('qaGate', ids[name])
                commands = [
                    {'method': 'snapshot', 'params': {'tabId': ids['fast'], 'load': 'current'}},
                    {'method': 'snapshot', 'params': {'tabId': ids['snapshot'], 'load': 'current'}},
                    {'method': 'fill', 'params': {'tabId': ids['fill'], 'ref': refs['fill']['textbox'], 'text': 'MUST NOT RUN'}},
                    {'method': 'click', 'params': {'tabId': ids['click'], 'ref': refs['click']['button']}}]
                first, first_elapsed = mcp.tool('browser_batch', {'commands': commands})
                check('Fast sibling survives three independently timed-out children without outer timeout',
                      len(first) == 4 and first[0]['ok'] and first[0]['result']['title'] == 'Timeout fixture'
                      and all(not item['ok'] and item['error']['code'] == 'COMMAND_TIMEOUT' for item in first[1:]),
                      elapsedSeconds=round(first_elapsed, 3))
                parent_id = first[1]['error']['commandId'].rsplit('-', 1)[0]
                check('Child timeouts expose scripting.inject phase, child commandId and native 11s deadline',
                      all(item['error']['commandId'] == f'{parent_id}-{index}'
                          and item['error']['diagnostic']['phase'] == 'scripting.inject'
                          and 10900 <= item['error']['diagnostic']['durationMs'] < 14000
                          for index, item in enumerate(first[1:], 1)) and 10.8 <= first_elapsed < 14,
                      errors=[item['error'] for item in first[1:]])
                stats_first = worker.evaluate('qaStats')
                check('Gates hold real native completion callbacks, with no snapshot/fill/click RPC',
                      all(stats_first[str(ids[name])]['files'] == 1
                          and stats_first[str(ids[name])]['nativeSettled'] == 1
                          and stats_first[str(ids[name])]['callbacks'] == 0
                          and stats_first[str(ids[name])]['rpcs'] == [] for name in ['snapshot', 'fill', 'click']),
                      stats=stats_first)
                busy_listing, _ = mcp.tool('browser_list_tabs')
                check('Expired native injections retain runningTabs and timed-out operation metadata',
                      all(next(t for t in busy_listing if t['id'] == ids[name])['operation']['timedOut']
                          and next(t for t in busy_listing if t['id'] == ids[name])['operation']['phase'] == 'scripting.inject'
                          for name in ['snapshot', 'fill', 'click'])
                      and set(worker.evaluate('[...runningTabs]')) == {ids[name] for name in ['snapshot', 'fill', 'click']})

                # Reuse the still-gated prior snapshot as incident busy; only one new 11s hang.
                worker.evaluate('qaGate', ids['fast'])
                second, second_elapsed = mcp.tool('browser_batch', {'commands': [
                    {'method': 'snapshot', 'params': {'tabId': ids['snapshot'], 'load': 'current'}},
                    {'method': 'snapshot', 'params': {'tabId': ids['fast'], 'load': 'current'}}]})
                check('Incident batch retains TAB_BUSY and fresh COMMAND_TIMEOUT together',
                      len(second) == 2 and not second[0]['ok'] and not second[1]['ok']
                      and second[0]['error']['code'] == 'TAB_BUSY'
                      and second[0]['error']['outcome'] == 'not-dispatched'
                      and second[1]['error']['code'] == 'COMMAND_TIMEOUT'
                      and second[1]['error']['diagnostic']['phase'] == 'scripting.inject'
                      and second[0]['error']['commandId'].endswith('-0')
                      and second[1]['error']['commandId'] == second[0]['error']['commandId'][:-1] + '1',
                      elapsedSeconds=round(second_elapsed, 3), results=second)
                check('Busy child never reinjects and all four unfinished native operations stay locked',
                      worker.evaluate('id=>qaStats[id].files', ids['snapshot']) == 1
                      and set(worker.evaluate('[...runningTabs]')) == set(ids.values()))
                before_release = worker.evaluate('qaStats')
                pending = set(ids.values())
                for name in ['snapshot', 'fill', 'click', 'fast']:
                    worker.evaluate('qaRelease', ids[name])
                    pending.remove(ids[name])
                    until(lambda: not worker.evaluate('id=>runningTabs.has(id)', ids[name]), label='late native cleanup ' + name)
                    check('Gate release cleans only its settled tab: ' + name,
                          set(worker.evaluate('[...runningTabs]')) == pending
                          and worker.evaluate('id=>qaStats[id].callbacks', ids[name]) == before_release[str(ids[name])]['callbacks'] + 1
                          and worker.evaluate('id=>qaStats[id].rpcs', ids[name]) == before_release[str(ids[name])]['rpcs'])
                pages['fast'].wait_for_timeout(250)
                final_stats = worker.evaluate('qaStats')
                check('Expired injection never invokes snapshot/fill/click and never replays native injection',
                      all(final_stats[str(tab_id)]['files'] == before_release[str(tab_id)]['files']
                          and final_stats[str(tab_id)]['rpcs'] == before_release[str(tab_id)]['rpcs'] for tab_id in ids.values())
                      and all(pages[name].locator('input').input_value() == 'unchanged'
                              and pages[name].evaluate('window.clicks') == 0 for name in ids)
                      and worker.evaluate('runningTabs.size===0 && runningOperations.size===0'), stats=final_stats)
                report['gateEvents'] = worker.evaluate('qaEvents')
                worker.evaluate('()=>{chrome.scripting.executeScript=qaNative}')
                recovery, _ = mcp.tool('browser_snapshot', {'tabId': ids['snapshot'], 'load': 'current'})
                check('Explicit fresh snapshot succeeds after native gates settle', recovery['title'] == 'Timeout fixture')
                worker.evaluate("handlePopup({type:'disconnect'})")
            finally:
                context.close()
                context = None
        report['result'] = 'passed'
    except BaseException as error:
        report['result'] = 'failed'
        report['error'] = repr(error)
        report['traceback'] = traceback.format_exc()
    finally:
        release.set()
        cleanup_errors = []
        if context is not None:
            try:
                context.close()
            except BaseException as error:
                cleanup_errors.append('Edge: ' + repr(error))
        bridge_records()
        if mcp is not None:
            report['calls'] = mcp.calls
            try:
                mcp.close()
            except BaseException as error:
                cleanup_errors.append('MCP: ' + repr(error))
                kill_tree(mcp.process.pid)
        bridge_records()
        report['bridgePids'] = sorted(bridge_pids)
        report['bridgeCleanup'] = [kill_tree(pid) for pid in sorted(bridge_pids)]
        # The bridge is detached from MCP by design; confirm its private listener closed.
        if 'port' in locals():
            def listener_closed():
                with socket.socket() as sock:
                    sock.settimeout(.2)
                    return sock.connect_ex(('127.0.0.1', port)) != 0
            try:
                until(listener_closed, timeout=3, label='private bridge shutdown')
            except AssertionError as error:
                cleanup_errors.append(str(error))
        if stderr:
            stderr.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        os.environ.clear()
        os.environ.update(previous_env)
        report['cleanupErrors'] = cleanup_errors
        if cleanup_errors:
            report['result'] = 'failed'
        report['elapsedSeconds'] = round(time.monotonic() - started, 3)
        report['passedCount'] = sum(item['passed'] for item in report['checks'])
        report['checkCount'] = len(report['checks'])
        result_path = run / 'results.json'
        result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: report[key] for key in ['result', 'passedCount', 'checkCount', 'elapsedSeconds', 'cleanupErrors']}, ensure_ascii=False), flush=True)
        print('Results: ' + str(result_path), flush=True)
        if report.get('traceback'):
            print(report['traceback'], file=sys.stderr)
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
