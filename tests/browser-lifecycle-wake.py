"""Independent lifecycle-wake integration: fresh Edge -> original extension -> private bridge -> stdio MCP.

Run: python -B tests/browser-lifecycle-wake.py [--headful]
Requires websocket-client, Node, and Edge (override with LIFECYCLE_TEST_EDGE).
Only harness helpers are reused from browser-frozen.py. No Playwright or page autoattach:
the raw browser-target CDP session attaches a page solely to freeze it and detaches
BEFORE native chrome.tabs.get verification. All runtime writes remain inside
 temp/qa/wake-20261112-1904/browser-run-*; no real profile/default bridge/settings.
"""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Read-only reuse of transport/process helpers, never the prior test's main or OUT.
_helpers = runpy.run_path(str(Path(__file__).with_name('browser-frozen.py')))
CDP, MCP = _helpers['CDP'], _helpers['MCP']
until, free_port, kill_tree = (_helpers[name] for name in ('until', 'free_port', 'kill_tree'))
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/qa/wake-20261112-1904'
HTML = b'<!doctype html><meta charset="utf-8"><title>Lifecycle wake fixture</title><h1>Lifecycle wake fixture</h1><button>Healthy control</button><input aria-label="Note" value="unchanged">'


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='browser-run-', dir=OUT))
    report = {'result': 'running', 'checks': [], 'artifactDirectory': str(run), 'limitations': [
        'Forced native freeze in fresh Edge; natural freeze cause and prevention are outside scope.',
        'Forwarding worker API traces only; page code and production executable sources are unchanged.',
        'Hung/revoked raw promises and borrowed input attachment are covered by VM unit tests.']}
    mcp = cdp = edge = bridge = server = None
    handles, cleanup_errors = [], []

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
               'APPDATA': str(run / 'home/AppData/Roaming'), 'LOCALAPPDATA': str(run / 'home/AppData/Local'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        port, debugport = free_port(), free_port()
        while debugport in [port, server.server_port]:
            debugport = free_port()
        report['ports'] = {'bridge': port, 'debug': debugport, 'fixture': server.server_port}
        sources = ['extension/background.js', 'extension/tasks.js', 'extension/cursor.js', 'extension/page-agent.js',
                   'server/bridge.mjs', 'server/diagnostics.mjs', 'server/mcp.mjs', 'server/mcp-worker.mjs']
        report['sourceSHA256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources}
        report['gitHead'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        extension = run / 'extension'
        shutil.copytree(ROOT / 'extension', extension, ignore=shutil.ignore_patterns('tests'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        report['extensionVersion'] = manifest['version']
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        # Storage barrier prevents even initial default-port access. Seed ONCE so actual
        # extension reload tests persistence rather than silently reseeding the answer.
        bootstrap = (
            'globalThis.qaCalls=[];'
            'const qaGet=chrome.storage.local.get.bind(chrome.storage.local);'
            f'const qaInit=qaGet("qaWakeSeeded").then(v=>v.qaWakeSeeded?undefined:chrome.storage.local.set({{qaWakeSeeded:true,bridgePort:{port},autoAuthorize:true,disconnected:true,cdpEnabled:false,screenshotCdpEnabled:false,lifecycleWakeEnabled:false}}));'
            'chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};'
            'const qaTrace=(owner,key,kind,details)=>{const original=owner[key].bind(owner);owner[key]=(...args)=>{const entry={kind,at:Date.now(),...details(args)};qaCalls.push(entry);return original(...args).then(value=>{if(kind==="get")entry.native={id:value.id,frozen:value.frozen,discarded:value.discarded,url:value.url};if(kind==="script")entry.documents=value.map(v=>({frameId:v.frameId,documentId:v.documentId}));return value})}};'
            'qaTrace(chrome.tabs,"get","get",a=>({tabId:a[0]}));'
            'qaTrace(chrome.scripting,"executeScript","script",a=>({tabId:a[0].target.tabId,files:!!a[0].files,documentIds:a[0].target.documentIds}));'
            'qaTrace(chrome.debugger,"attach","attach",a=>({tabId:a[0].tabId}));'
            'qaTrace(chrome.debugger,"detach","detach",a=>({tabId:a[0].tabId}));'
            'qaTrace(chrome.debugger,"sendCommand","cdp",a=>({tabId:a[0].tabId,method:a[1],params:a[2]}));'
            'qaTrace(chrome.tabs,"update","tabs.update",a=>({tabId:a[0],props:a[1]}));'
            'qaTrace(chrome.tabs,"reload","tabs.reload",a=>({tabId:a[0]}));'
            'qaTrace(chrome.windows,"update","windows.update",a=>({windowId:a[0],props:a[1]}));'
            'importScripts("background.js");')
        (extension / 'qa-bootstrap.js').write_text(bootstrap, encoding='utf-8')
        check('Original extension executable sources copied unchanged', all(
            (ROOT / name).read_bytes() == (extension / Path(name).name).read_bytes()
            for name in sources if name.startswith('extension/')))
        def log(name):
            handle = (run / (name + '-stderr.log')).open('w', encoding='utf-8')
            handles.append(handle)
            return handle
        bridge_log = log('bridge')
        bridge = subprocess.Popen(['node', 'server/bridge.mjs', '--bridge', '--port', str(port), '--config-dir', str(run / 'config')],
                                  cwd=ROOT, env=env, stdout=bridge_log, stderr=bridge_log, creationflags=subprocess.CREATE_NO_WINDOW)
        def fetch_json(url):
            try:
                return json.load(urllib.request.urlopen(url, timeout=1))
            except (OSError, ValueError):
                return None
        status = lambda: fetch_json(f'http://127.0.0.1:{port}/status')
        until(status, label='private bridge startup')
        mcp = MCP(port, run / 'config', env, log('mcp'))
        exe = os.environ.get('LIFECYCLE_TEST_EDGE', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
        args = [exe, *([] if '--headful' in sys.argv else ['--headless=new']), '--no-first-run', '--no-default-browser-check',
                '--remote-allow-origins=*', '--remote-debugging-port=' + str(debugport), '--user-data-dir=' + str(run / 'profile'),
                '--disable-extensions-except=' + str(extension), '--load-extension=' + str(extension), base + '/anchor']
        edge_log = log('edge')
        edge = subprocess.Popen(args, env=env, stdout=edge_log, stderr=edge_log)
        report['pids'] = {'edge': edge.pid, 'bridge': bridge.pid, 'mcpLauncher': mcp.process.pid}
        version = until(lambda: fetch_json(f'http://127.0.0.1:{debugport}/json/version'), label='private Edge debugging endpoint')
        report['browser'] = version['Browser']
        cdp = CDP(version['webSocketDebuggerUrl'])
        def worker(exclude=None):
            return next((t for t in cdp.call('Target.getTargets')['targetInfos'] if t['type'] == 'service_worker'
                         and t['url'].endswith('/qa-bootstrap.js') and t['targetId'] != exclude), None)
        worker_target = until(worker, label='private extension worker')
        sid = cdp.attach(worker_target['targetId'])
        cdp.call('Runtime.enable', {}, sid)
        def js(expression):
            return cdp.evaluate(sid, expression)
        until(lambda: js('typeof handlePopup === "function"'), label='production extension startup')
        js('ready.then(()=>handlePopup({type:"connect"}))')
        until(lambda: (status() or {}).get('connected'), label='private extension connection')
        def popup(kind, **fields):
            return js('handlePopup(' + json.dumps({'type': kind, **fields}) + ')')
        def tool(name, args=None):
            response, elapsed = mcp.tool(name, args)
            text = response['content'][0]['text']
            if response.get('isError'):
                payload = response.get('structuredContent', {'text': text})
            else:
                payload = json.loads(text)
            return response, payload, elapsed
        def state(tab_id):
            return js('chrome.tabs.get(' + str(tab_id) + ').then(t=>({id:t.id,active:t.active,frozen:t.frozen,discarded:t.discarded,autoDiscardable:t.autoDiscardable,status:t.status,url:t.url}))')
        active = lambda: js('chrome.tabs.query({active:true}).then(ts=>ts.map(t=>t.id))')
        original_active = active()
        settings = popup('popup_status')
        check('Fresh storage lifecycle false with input and screenshot false', settings.get('lifecycleWakeEnabled') is False
              and settings['cdpEnabled'] is False and settings['screenshotCdpEnabled'] is False, settings=settings)
        listing_response, listing, _ = tool('browser_list_tabs')
        check('Real MCP list reports lifecycle permission false', not listing_response.get('isError') and listing
              and all(t.get('lifecycleWakeEnabled') is False for t in listing), tabs=listing)
        ids = {name: js('chrome.tabs.create({url:' + json.dumps(base + '/' + name) + ',active:false}).then(t=>t.id)')
               for name in ['frozen-a', 'frozen-b', 'healthy', 'discarded']}
        for tab_id in ids.values():
            until(lambda: state(tab_id)['status'] == 'complete', label='fixture complete')
        auto_before = {name: state(tab_id)['autoDiscardable'] for name, tab_id in ids.items()}
        def freeze(name):
            target = next(t for t in cdp.call('Target.getTargets')['targetInfos'] if t['url'] == base + '/' + name)
            cdp.freeze(target['targetId'])
            def native_frozen():
                current = state(ids[name])
                return current if current.get('frozen') is True else None
            native = until(native_frozen, label='native frozen true after raw page detach')
            check('Genuine inactive native freeze ' + name, native['frozen'] is True and not native['active']
                  and not native['discarded'] and not cdp.page_sessions, native=native)
        def calls_since(index):
            return js('qaCalls.slice(' + str(index) + ')')
        def verify_wake_trace(calls, tab_id):
            scoped = [c for c in calls if c.get('tabId') == tab_id]
            commands = [c for c in scoped if c['kind'] == 'cdp']
            scripts = [c for c in scoped if c['kind'] == 'script']
            check('Exactly one lifecycle active command with owned cleanup tab ' + str(tab_id), len(commands) == 1
                  and commands[0]['method'] == 'Page.setWebLifecycleState' and commands[0]['params'] == {'state': 'active'}
                  and sum(c['kind'] == 'attach' for c in scoped) == 1 and sum(c['kind'] == 'detach' for c in scoped) == 1, calls=scoped)
            wake_at = next(i for i, c in enumerate(scoped) if c['kind'] == 'cdp')
            script_at = next(i for i, c in enumerate(scoped) if c['kind'] == 'script')
            check('Native thaw confirmed before matching-document page work tab ' + str(tab_id), len(scripts) == 2
                  and wake_at < script_at and any(c['kind'] == 'get' and c.get('native', {}).get('frozen') is False
                  for c in scoped[wake_at + 1:script_at]) and scripts[1].get('documentIds') == [scripts[0]['documents'][0]['documentId']], calls=scoped)
        freeze('frozen-a')
        start = js('qaCalls.length')
        response, _, elapsed = tool('browser_snapshot', {'tabId': ids['frozen-a'], 'load': 'current'})
        error = response.get('structuredContent', {}).get('error', {})
        check('Disabled lifecycle obeys TAB_FROZEN preflight without page/CDP work', error.get('code') == 'TAB_FROZEN'
              and error.get('outcome') == 'not-dispatched' and error.get('diagnostic', {}).get('stage') == 'preflight'
              and not any(c['kind'] in ['attach', 'cdp', 'script'] for c in calls_since(start)) and elapsed < 2, error=error, elapsed=elapsed)
        changed = popup('set_lifecycle_wake_enabled', enabled=True)
        saved = js('chrome.storage.local.get(["lifecycleWakeEnabled","cdpEnabled","screenshotCdpEnabled"])')
        check('Independent setter persists lifecycle true while both other CDP flags stay false', changed.get('lifecycleWakeEnabled') is True
              and saved == {'lifecycleWakeEnabled': True, 'cdpEnabled': False, 'screenshotCdpEnabled': False}, saved=saved)
        start = js('qaCalls.length')
        response, snapshot, elapsed = tool('browser_snapshot', {'tabId': ids['frozen-a'], 'load': 'current'})
        check('Real MCP fresh snapshot thaws with verified metadata', not response.get('isError')
              and snapshot.get('title') == 'Lifecycle wake fixture' and snapshot.get('lifecycleWake') == {'attempted': True, 'verified': True}
              and state(ids['frozen-a']).get('frozen') is False and elapsed < 11, snapshot=snapshot, elapsed=elapsed)
        verify_wake_trace(calls_since(start), ids['frozen-a'])
        button_ref = next(e['ref'] for e in snapshot['elements'] if e.get('role') == 'button' and e.get('name') == 'Healthy control')
        for method, params in [('inspect', {'ref': button_ref}), ('wait', {'name': 'Healthy control', 'role': 'button', 'timeoutMs': 5000})]:
            freeze('frozen-a')
            start = js('qaCalls.length')
            response, payload, _ = tool('browser_' + method, {'tabId': ids['frozen-a'], **params})
            check('Real MCP fresh ' + method + ' automatically thaws', not response.get('isError') and state(ids['frozen-a']).get('frozen') is False, payload=payload)
            if method == 'wait':
                assert payload.get('matched') is True, payload
            verify_wake_trace(calls_since(start), ids['frozen-a'])
        start = js('qaCalls.length')
        response, _, _ = tool('browser_snapshot', {'tabId': ids['frozen-a'], 'load': 'current'})
        check('Already-thawed fresh read causes no second wake', not response.get('isError') and not any(c['kind'] in ['attach', 'cdp', 'detach'] for c in calls_since(start)))
        for name in ['frozen-a', 'frozen-b']:
            freeze(name)
        start = js('qaCalls.length')
        response, items, _ = tool('browser_batch', {'commands': [{'method': 'snapshot', 'params': {'tabId': ids[name], 'load': 'current'}} for name in ['frozen-a', 'frozen-b']]})
        check('Real two-page frozen batch retains both verified results', not response.get('isError') and len(items) == 2
              and all(item['ok'] and item['result'].get('lifecycleWake') == {'attempted': True, 'verified': True} for item in items), results=items)
        batch_calls = calls_since(start)
        for name in ['frozen-a', 'frozen-b']:
            verify_wake_trace(batch_calls, ids[name])
        discarded = js('chrome.tabs.discard(' + str(ids['discarded']) + ').then(t=>({id:t.id,discarded:t.discarded}))')
        ids['discarded'] = discarded['id']
        until(lambda: state(ids['discarded']).get('discarded') is True, label='native discarded')
        start = js('qaCalls.length')
        response, _, _ = tool('browser_snapshot', {'tabId': ids['discarded'], 'load': 'current'})
        error = response.get('structuredContent', {}).get('error', {})
        check('Enabled lifecycle never wakes discarded page', error.get('code') == 'TAB_DISCARDED'
              and error.get('outcome') == 'not-dispatched' and not any(c['kind'] in ['attach', 'cdp', 'script'] for c in calls_since(start))
              and state(ids['discarded'])['discarded'] is True, error=error)
        final_calls = js('qaCalls')
        check('All production operations preserve active selection and discard eligibility', active() == original_active
              and not any(c['kind'] in ['tabs.update', 'tabs.reload', 'windows.update'] for c in final_calls)
              and all(state(tab_id)['autoDiscardable'] == auto_before[name] for name, tab_id in ids.items()), activeBefore=original_active, activeAfter=active())
        check('Production operation and attachment locks clear', js('runningTabs.size===0 && runningOperations.size===0 && tabQueues.size===0 && attached.size===0'))
        report['beforeReloadCalls'] = final_calls
        # Reload the private extension, preserving its real storage, then attach ONLY its new worker.
        old_worker = worker_target['targetId']
        js('setTimeout(()=>chrome.runtime.reload(),50); true')
        worker_target = until(lambda: worker(old_worker), timeout=12, label='reloaded private extension worker')
        sid = cdp.attach(worker_target['targetId'])
        cdp.call('Runtime.enable', {}, sid)
        until(lambda: js('typeof handlePopup === "function"'), label='reloaded production startup')
        settings = popup('popup_status')
        check('Actual extension reload preserves independent lifecycle true setting', settings.get('lifecycleWakeEnabled') is True
              and settings['cdpEnabled'] is False and settings['screenshotCdpEnabled'] is False, settings=settings)
        popup('set_lifecycle_wake_enabled', enabled=False)
        check('Disable persists false after reload', js('chrome.storage.local.get("lifecycleWakeEnabled").then(v=>v.lifecycleWakeEnabled)') is False)
        freeze('frozen-a')
        start = js('qaCalls.length')
        response, _, _ = tool('browser_snapshot', {'tabId': ids['frozen-a'], 'load': 'current'})
        check('Revoked lifecycle returns to frozen preflight on fresh command', response.get('structuredContent', {}).get('error', {}).get('code') == 'TAB_FROZEN'
              and not any(c['kind'] in ['attach', 'cdp', 'script'] for c in calls_since(start)))
        report['afterReloadCalls'] = js('qaCalls')
        check('Production sources unchanged during isolated regression', report['sourceSHA256'] == {
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
            except (OSError, _helpers['websocket'].WebSocketException):
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
