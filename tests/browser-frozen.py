"""Native frozen-tab regression: isolated Edge -> original extension -> private bridge -> stdio MCP.

Run with python -B tests/browser-frozen.py [--headful]. Requires websocket-client.
Raw browser-target CDP never auto-attaches pages. Only the inactive fixture page is
briefly attached to freeze it, then detached BEFORE native tabs.get verification.
All runtime writes stay under temp/qa/frozen-20261112-1831/preflight-*.
No production lifecycle recovery, user profile, default bridge, or global settings.
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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/qa/frozen-20261112-1831'
HTML = b'<!doctype html><meta charset="utf-8"><title>Frozen preflight fixture</title><h1>Frozen preflight fixture</h1><button>Healthy control</button><input aria-label="Note" value="unchanged">'


def until(fn, timeout=8, label='condition'):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = fn()
        if result:
            return result
        time.sleep(.04)
    raise AssertionError('Timed out waiting for ' + label)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        result = sock.getsockname()[1]
    return free_port() if result == 17653 else result


class CDP:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=8)
        self.sequence = 0
        self.page_sessions = set()

    def call(self, method, params=None, session=None):
        self.sequence += 1
        request = {'id': self.sequence, 'method': method, 'params': params or {}}
        if session:
            request['sessionId'] = session
        self.ws.send(json.dumps(request))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') == self.sequence:
                assert 'error' not in message, message
                return message.get('result', {})

    def attach(self, target_id):
        return self.call('Target.attachToTarget', {'targetId': target_id, 'flatten': True})['sessionId']

    def evaluate(self, session, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True,
                                               'returnByValue': True}, session)
        assert 'exceptionDetails' not in result, result
        return result.get('result', {}).get('value')

    def freeze(self, target_id):
        session = self.attach(target_id)
        self.page_sessions.add(session)
        try:
            self.call('Page.setWebLifecycleState', {'state': 'frozen'}, session)
        finally:
            self.call('Target.detachFromTarget', {'sessionId': session})
            self.page_sessions.remove(session)


class MCP:
    def __init__(self, port, config, env, stderr):
        self.process = subprocess.Popen(
            ['node', 'server/mcp.mjs', '--port', str(port), '--config-dir', str(config)],
            cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
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
        while True:
            remaining = start + timeout - time.monotonic()
            assert remaining > 0, 'MCP response deadline: ' + name
            message = self.messages.get(timeout=remaining)
            assert not message.get('eof') and 'readerError' not in message, message
            if message.get('id') == self.sequence:
                break
        assert 'error' not in message, message
        result = message['result']
        elapsed = time.monotonic() - start
        self.calls.append({'name': name, 'requestId': self.sequence,
                           'elapsedSeconds': round(elapsed, 4), 'response': result})
        return result, elapsed

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                kill_tree(self.process.pid)
                self.process.wait(timeout=5)
        self.reader.join(timeout=3)
        assert not self.reader.is_alive(), 'MCP reader leaked'
        self.process.stdout.close()


def kill_tree(pid):
    result = subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                            capture_output=True, text=True, timeout=8,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    return {'pid': pid, 'exitCode': result.returncode}


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='preflight-run-', dir=OUT))
    report = {'result': 'running', 'checks': [], 'artifactDirectory': str(run),
              'limitations': ['Forced freeze in fresh-profile Edge; natural freeze cause/prevention not tested.',
                              'Worker-only forwarding API counters; no page API interception or Playwright.',
                              'CDP lifecycle is test setup only. No production recovery opt-in.']}
    mcp = cdp = edge = bridge = None
    handles = []
    server = None
    cleanup_errors = []

    def check(name, condition, **evidence):
        report['checks'].append({'name': name, 'passed': bool(condition), **evidence})
        assert condition, report['checks'][-1]
        print('PASS ' + name, flush=True)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(HTML)))
            self.end_headers()
            self.wfile.write(HTML)

        def log_message(self, *_):
            pass

    try:
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        for child in ['tmp', 'home/AppData/Roaming', 'home/AppData/Local', 'config']:
            (run / child).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'TEMP': str(run / 'tmp'), 'TMP': str(run / 'tmp'),
               'HOME': str(run / 'home'), 'USERPROFILE': str(run / 'home'),
               'APPDATA': str(run / 'home/AppData/Roaming'),
               'LOCALAPPDATA': str(run / 'home/AppData/Local'), 'PYTHONDONTWRITEBYTECODE': '1'}
        port = free_port()
        debugport = free_port()
        while debugport in [port, server.server_port]:
            debugport = free_port()
        report['ports'] = {'bridge': port, 'debug': debugport, 'fixture': server.server_port}
        sources = ['extension/background.js', 'extension/tasks.js', 'extension/cursor.js',
                   'extension/page-agent.js', 'server/bridge.mjs', 'server/diagnostics.mjs',
                   'server/mcp.mjs', 'server/mcp-worker.mjs']
        report['sourceSHA256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources}
        report['gitHead'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        extension = run / 'extension'
        shutil.copytree(ROOT / 'extension', extension, ignore=shutil.ignore_patterns('tests'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        report['extensionVersion'] = manifest['version']
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        # Route startup to the private bridge before ORIGINAL background.js runs.
        # The storage read barrier avoids even an initial request to the default bridge.
        bootstrap = (
            'globalThis.qaCalls=[];'
            'const qaScript=chrome.scripting.executeScript.bind(chrome.scripting);'
            'chrome.scripting.executeScript=spec=>{qaCalls.push({kind:"script",tabId:spec.target.tabId,files:!!spec.files,at:Date.now()});return qaScript(spec)};'
            'const qaAttach=chrome.debugger.attach.bind(chrome.debugger);'
            'chrome.debugger.attach=(...args)=>{qaCalls.push({kind:"debugger.attach",at:Date.now()});return qaAttach(...args)};'
            'const qaUpdate=chrome.tabs.update.bind(chrome.tabs);'
            'chrome.tabs.update=(id,props,...rest)=>{qaCalls.push({kind:"tabs.update",tabId:id,keys:Object.keys(props),at:Date.now()});return qaUpdate(id,props,...rest)};'
            f'const qaInit=chrome.storage.local.set({{bridgePort:{port},autoAuthorize:true,disconnected:true,cdpEnabled:false,screenshotCdpEnabled:false}});'
            'const qaGet=chrome.storage.local.get.bind(chrome.storage.local);'
            'chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};'
            "importScripts('background.js');")
        (extension / 'qa-bootstrap.js').write_text(bootstrap, encoding='utf-8')
        check('Original extension executable sources copied unchanged', all(
            (ROOT / name).read_bytes() == (extension / Path(name).name).read_bytes()
            for name in sources if name.startswith('extension/')))
        bridge_err = (run / 'bridge-stderr.log').open('w', encoding='utf-8'); handles.append(bridge_err)
        bridge = subprocess.Popen(['node', 'server/bridge.mjs', '--bridge', '--port', str(port),
                                   '--config-dir', str(run / 'config')], cwd=ROOT, env=env,
                                  stdout=bridge_err, stderr=bridge_err, creationflags=subprocess.CREATE_NO_WINDOW)
        def status():
            try:
                return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/status', timeout=1))
            except (OSError, ValueError):
                return None
        until(status, label='private bridge startup')
        mcp_err = (run / 'mcp-stderr.log').open('w', encoding='utf-8'); handles.append(mcp_err)
        mcp = MCP(port, run / 'config', env, mcp_err)
        edge_err = (run / 'edge-stderr.log').open('w', encoding='utf-8'); handles.append(edge_err)
        exe = os.environ.get('FROZEN_TEST_EDGE', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
        args = [exe, *([] if '--headful' in sys.argv else ['--headless=new']),
                '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
                '--remote-debugging-port=' + str(debugport), '--user-data-dir=' + str(run / 'profile'),
                '--disable-extensions-except=' + str(extension), '--load-extension=' + str(extension), base + '/anchor']
        edge = subprocess.Popen(args, env=env, stdout=edge_err, stderr=edge_err)
        report['pids'] = {'edge': edge.pid, 'bridge': bridge.pid, 'mcpLauncher': mcp.process.pid}
        def version():
            try:
                return json.load(urllib.request.urlopen(f'http://127.0.0.1:{debugport}/json/version', timeout=1))
            except (OSError, ValueError):
                return None
        browser_version = until(version, label='private Edge debugging endpoint')
        report['browser'] = browser_version['Browser']
        cdp = CDP(browser_version['webSocketDebuggerUrl'])
        def worker():
            return next((t for t in cdp.call('Target.getTargets')['targetInfos']
                         if t['type'] == 'service_worker' and t['url'].endswith('/qa-bootstrap.js')), None)
        worker_target = until(worker, label='private extension worker')
        sid = cdp.attach(worker_target['targetId'])
        cdp.call('Runtime.enable', {}, sid)
        js = lambda expression: cdp.evaluate(sid, expression)
        until(lambda: js('typeof handlePopup === "function"'), label='production extension startup')
        js('ready.then(()=>handlePopup({type:"connect"}))')
        until(lambda: (status() or {}).get('connected'), label='private extension connection')
        result, _ = mcp.tool('browser_status')
        actual_status = json.loads(result['content'][0]['text'])
        check('Production stdio MCP bridge extension versions connected',
              actual_status['extensionVersion'] == actual_status['mcpVersion'] == manifest['version'], status=actual_status)
        state = lambda tab_id: js('chrome.tabs.get(' + str(tab_id) + ').then(t=>({id:t.id,active:t.active,frozen:t.frozen,discarded:t.discarded,autoDiscardable:t.autoDiscardable,status:t.status}))')
        active = lambda: js('chrome.tabs.query({active:true}).then(ts=>ts.map(t=>t.id))')
        original_active = active()
        ids = {name: js('chrome.tabs.create({url:' + json.dumps(base + '/' + name) + ',active:false}).then(t=>t.id)')
               for name in ['frozen', 'healthy', 'discarded']}
        for tab_id in ids.values():
            until(lambda: state(tab_id)['status'] == 'complete', label='fixture complete')
        target = next(t for t in cdp.call('Target.getTargets')['targetInfos'] if t['url'] == base + '/frozen')
        auto_before = {name: state(tab_id)['autoDiscardable'] for name, tab_id in ids.items()}
        cdp.freeze(target['targetId'])
        frozen = until(lambda: state(ids['frozen']) if state(ids['frozen']).get('frozen') is True else None,
                       label='native frozen true after page detach')
        check('Native inactive frozen true verified with no page session attached',
              frozen['frozen'] is True and not frozen['active'] and not frozen['discarded'] and not cdp.page_sessions,
              nativeState=frozen, pageSessions=list(cdp.page_sessions))
        baseline = js('({calls:qaCalls.length,running:[...runningTabs],operations:[...runningOperations.keys()],queues:[...tabQueues.keys()],attached:[...attached]})')
        result, elapsed = mcp.tool('browser_snapshot', {'tabId': ids['frozen'], 'load': 'current'})
        error = result.get('structuredContent', {}).get('error', {})
        check('Known frozen snapshot returns TAB_FROZEN not-dispatched preflight under 2 seconds',
              result.get('isError') is True and error.get('code') == 'TAB_FROZEN'
              and error.get('outcome') == 'not-dispatched' and error.get('diagnostic', {}).get('stage') == 'preflight'
              and error['diagnostic'].get('frozen') is True and elapsed < 2, error=error, elapsedSeconds=round(elapsed, 4))
        after = js('({calls:qaCalls.length,running:[...runningTabs],operations:[...runningOperations.keys()],queues:[...tabQueues.keys()],attached:[...attached]})')
        check('Frozen refusal executes zero scripts and leaves no operation or queue locks', baseline == after,
              before=baseline, after=after)
        check('Frozen refusal preserves original active tab and native frozen state',
              active() == original_active and state(ids['frozen'])['frozen'] is True,
              activeBefore=original_active, activeAfter=active())
        for order in [['frozen', 'healthy'], ['healthy', 'frozen']]:
            start_calls = js('qaCalls.length')
            response, batch_elapsed = mcp.tool('browser_batch', {'commands': [
                {'method': 'snapshot', 'params': {'tabId': ids[name], 'load': 'current'}} for name in order]})
            items = json.loads(response['content'][0]['text'])
            bad, good = items[order.index('frozen')], items[order.index('healthy')]
            calls = js('qaCalls.slice(' + str(start_calls) + ')')
            check('Mixed batch preserves healthy snapshot with order ' + '/'.join(order),
                  not response.get('isError') and not bad['ok'] and bad['error']['code'] == 'TAB_FROZEN'
                  and bad['error']['outcome'] == 'not-dispatched' and bad['error']['diagnostic']['stage'] == 'preflight'
                  and good['ok'] and good['result']['title'] == 'Frozen preflight fixture'
                  and all(c.get('tabId') != ids['frozen'] for c in calls) and batch_elapsed < 2,
                  results=items, calls=calls, elapsedSeconds=round(batch_elapsed, 4))
        listing, _ = mcp.tool('browser_list_tabs')
        tabs = json.loads(listing['content'][0]['text'])
        check('MCP listing retains frozen lifecycle without unfinished operation',
              any(t['id'] == ids['frozen'] and t.get('frozen') is True and 'operation' not in t for t in tabs),
              target=next(t for t in tabs if t['id'] == ids['frozen']))
        # Optional real discard distinction; no reload or activation by production.
        discarded_native = js('chrome.tabs.discard(' + str(ids['discarded']) + ').then(t=>({id:t.id,discarded:t.discarded}))')
        report['discardNativeReturn'] = discarded_native
        ids['discarded'] = discarded_native['id']
        discarded = until(lambda: state(ids['discarded']) if state(ids['discarded']).get('discarded') is True else None,
                          label='native discarded state')
        start_calls = js('qaCalls.length')
        response, discard_elapsed = mcp.tool('browser_snapshot', {'tabId': ids['discarded'], 'load': 'current'})
        discard_error = response.get('structuredContent', {}).get('error', {})
        check('Native discarded tab returns distinct TAB_DISCARDED without injection or reload',
              discard_error.get('code') == 'TAB_DISCARDED' and discard_error.get('outcome') == 'not-dispatched'
              and discard_error.get('diagnostic', {}).get('discarded') is True
              and js('qaCalls.length') == start_calls and state(ids['discarded'])['discarded'] is True,
              nativeState=discarded, error=discard_error, elapsedSeconds=round(discard_elapsed, 4))
        check('All refusals and mixed reads preserve selection, debugger and discard eligibility',
              active() == original_active and js('attached.size') == 0
              and not js('qaCalls.some(c=>c.kind==="debugger.attach" || (c.kind==="tabs.update" && c.keys.includes("autoDiscardable")))')
              and all(state(tab_id)['autoDiscardable'] == auto_before[name] for name, tab_id in ids.items()),
              active=active(), autoDiscardableBefore=auto_before, calls=js('qaCalls'))
        # Explicit CONTROL activation only in this private profile, never production recovery.
        js('chrome.tabs.update(' + str(ids['frozen']) + ',{active:true})')
        thawed = until(lambda: state(ids['frozen']) if state(ids['frozen']).get('frozen') is False else None,
                       label='native frozen false after isolated activation')
        check('Explicit isolated activation thaws before a new request', thawed['frozen'] is False, nativeState=thawed)
        response, thaw_elapsed = mcp.tool('browser_snapshot', {'tabId': ids['frozen'], 'load': 'current'})
        snapshot = json.loads(response['content'][0]['text'])
        check('Fresh snapshot after confirmed thaw succeeds', not response.get('isError')
              and snapshot.get('title') == 'Frozen preflight fixture', elapsedSeconds=round(thaw_elapsed, 4), snapshot=snapshot)
        final = js('({running:[...runningTabs],operations:[...runningOperations.keys()],queues:[...tabQueues.keys()],attached:[...attached],calls:qaCalls})')
        check('Final operations and locks clear with no extension debugger or eligibility mutations',
              all(not final[key] for key in ['running', 'operations', 'queues', 'attached'])
              and not any(c['kind'] == 'debugger.attach' or (c['kind'] == 'tabs.update' and 'autoDiscardable' in c['keys']) for c in final['calls']),
              final=final)
        js('chrome.tabs.update(' + str(original_active[0]) + ',{active:true})')
        check('Private original selection restored after control', active() == original_active)
        check('Production source hashes unchanged throughout regression', report['sourceSHA256'] == {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources})
        report['result'] = 'passed'
    except BaseException:
        report['result'] = 'failed'
        report['error'] = traceback.format_exc()
        print(report['error'], flush=True)
    finally:
        if mcp:
            report['mcpCalls'] = mcp.calls
            try:
                mcp.close()
            except BaseException as error:
                cleanup_errors.append('MCP: ' + repr(error))
        if cdp:
            try:
                cdp.call('Browser.close')
            except (OSError, websocket.WebSocketException):
                pass
            except BaseException as error:
                cleanup_errors.append('Browser.close: ' + repr(error))
            cdp.ws.close()
        for name, process in [('edge', edge), ('bridge', bridge)]:
            if process:
                try:
                    if name == 'bridge' and process.poll() is None:
                        report.setdefault('cleanup', []).append(kill_tree(process.pid))
                    process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    report.setdefault('cleanup', []).append(kill_tree(process.pid))
                    process.wait(timeout=5)
                except BaseException as error:
                    cleanup_errors.append(name + ': ' + repr(error))
        if server:
            server.shutdown()
            server.server_close()
        for handle in handles:
            handle.close()
        report['cleanupErrors'] = cleanup_errors
        if cleanup_errors:
            report['result'] = 'failed'
        report['passedCount'] = sum(c['passed'] for c in report['checks'])
        (run / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('REPORT ' + str(run / 'results.json'), flush=True)
        print('RESULT ' + report['result'] + ' checks=' + str(report['passedCount']), flush=True)
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
