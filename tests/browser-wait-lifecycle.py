"""Isolated Edge regression for worker-owned browser_wait polling.
Run: python -B tests/browser-wait-lifecycle.py [--baseline] [--headful].
Baseline executable extension sources are pinned to fd2a402, independently of core edits.
No Playwright, page auto-attach, user browser, default bridge or production settings.
Native API forwarding gates make the post-probe freeze deterministic; raw browser CDP
attaches the inactive fixture only for explicit lifecycle setup, then detaches.
All runtime artifacts are private qa-* directories under the wait investigation folder.
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
OUT = ROOT / 'temp/qa/wait-20261113-1740'
PIN = 'fd2a402177e57acf3651a8be012d5f5b54ba4539'
HTML = b'<!doctype html><meta charset="utf-8"><title>Wait lifecycle fixture</title><h1>Wait lifecycle fixture</h1><button>Healthy control</button><button id="later" disabled>Later condition</button><input aria-label="Note" value="unchanged">'


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
    run = Path(tempfile.mkdtemp(prefix='qa-baseline-' if '--baseline' in sys.argv else 'qa-updated-', dir=OUT))
    report = {'result': 'running', 'checks': [], 'artifactDirectory': str(run),
              'limitations': ['Forced freeze in fresh-profile Edge; natural freeze cause/prevention not tested.',
                              'Worker-only native API forwarding counters/gates; no Playwright or page auto-attach.',
                              'Forced lifecycle and API result hold do not establish natural freeze or CPU-hang causes.',
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
        baseline = '--baseline' in sys.argv
        report['baselinePin'] = PIN if baseline else None
        if baseline:
            for file in extension.iterdir():
                if file.suffix in ['.js', '.json']:
                    file.write_bytes(subprocess.check_output(['git', 'show', PIN + ':extension/' + file.name], cwd=ROOT))
        report['executedExtensionSHA256'] = {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                                             for file in extension.iterdir() if file.suffix in ['.js', '.json']}
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        report['extensionVersion'] = manifest['version']
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        # Route startup to the private bridge before ORIGINAL background.js runs.
        # The storage read barrier avoids even an initial request to the default bridge.
        bootstrap = r'''
globalThis.qaCalls=[];globalThis.qaGateAfterWait=false;globalThis.qaGateArmed=false;globalThis.qaGateReady=false;
globalThis.qaHoldNextWait=false;globalThis.qaHoldReady=false;
globalThis.qaNativeGet=chrome.tabs.get.bind(chrome.tabs);
chrome.tabs.get=(id,...rest)=>{
 if(qaGateArmed && id===globalThis.qaTarget){qaGateArmed=false;qaGateReady=true;return new Promise(resolve=>{globalThis.qaReleaseGet=()=>{qaGateReady=false;resolve(qaNativeGet(id,...rest))}})}
 return qaNativeGet(id,...rest)
};
const qaScript=chrome.scripting.executeScript.bind(chrome.scripting);
chrome.scripting.executeScript=spec=>{
 const entry={kind:'script',tabId:spec.target.tabId,files:!!spec.files,operation:spec.args?.[0]||'control',params:spec.args?.[1],at:Date.now()};qaCalls.push(entry);
 const native=qaScript(spec);return native.then(async result=>{
  entry.nativeSettled=Date.now();entry.result=result.map(x=>({frameId:x.frameId,documentId:x.documentId,result:x.result}));
  if(entry.operation==='waitFor' && qaGateAfterWait){qaGateAfterWait=false;qaGateArmed=true}
  if(entry.operation==='waitFor' && qaHoldNextWait){qaHoldNextWait=false;qaHoldReady=true;await new Promise(resolve=>{globalThis.qaReleaseHold=()=>{qaHoldReady=false;resolve()}})}
  entry.settled=Date.now();return result
 },error=>{entry.settled=Date.now();entry.error=String(error);throw error})
};
const qaAttach=chrome.debugger.attach.bind(chrome.debugger);
chrome.debugger.attach=(...args)=>{qaCalls.push({kind:'debugger.attach',at:Date.now()});return qaAttach(...args)};
const qaUpdate=chrome.tabs.update.bind(chrome.tabs);
chrome.tabs.update=(id,props,...rest)=>{qaCalls.push({kind:'tabs.update',tabId:id,keys:Object.keys(props),at:Date.now()});return qaUpdate(id,props,...rest)};
'''
        bootstrap += f'const qaInit=chrome.storage.local.set({{bridgePort:{port},autoAuthorize:true,disconnected:true,cdpEnabled:false,screenshotCdpEnabled:false,lifecycleWakeEnabled:false}});'
        bootstrap += 'const qaGet=chrome.storage.local.get.bind(chrome.storage.local);chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};importScripts("background.js");'
        (extension / 'qa-bootstrap.js').write_text(bootstrap, encoding='utf-8')
        check('Pinned baseline or current copied extension sources recorded before launch', bool(report['executedExtensionSHA256']))
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
              actual_status['connected'] is True and actual_status['extensionVersion'] == manifest['version'], status=actual_status)
        state = lambda tab_id: js('qaNativeGet(' + str(tab_id) + ').then(t=>({id:t.id,url:t.url,active:t.active,frozen:t.frozen,discarded:t.discarded,autoDiscardable:t.autoDiscardable,status:t.status}))')
        active = lambda: js('chrome.tabs.query({active:true}).then(ts=>ts.map(t=>t.id))')
        original_active = active()
        tab_id = js('chrome.tabs.create({url:' + json.dumps(base + '/wait') + ',active:false}).then(t=>t.id)')
        until(lambda: state(tab_id)['status'] == 'complete', label='fixture complete')
        target = next(t for t in cdp.call('Target.getTargets')['targetInfos'] if t['url'] == base + '/wait')
        js('globalThis.qaTarget=' + str(tab_id))
        locks = lambda: js('({running:[...runningTabs],operations:[...runningOperations].map(([id,o])=>({id,timedOut:o.timedOut,phase:o.check.phase})),queues:[...tabQueues.keys()]})')
        clear = lambda: not any(locks().values())
        calls = lambda: js('qaCalls')
        waits = lambda: [c for c in calls() if c.get('operation') == 'waitFor']
        def data(response):
            assert not response.get('isError'), response
            return json.loads(response['content'][0]['text'])
        def error(response):
            return response.get('structuredContent', {}).get('error', {})
        def control(expression):
            return js('qaScript({target:{tabId:' + str(tab_id) + '},world:"MAIN",injectImmediately:true,func:()=>{' + expression + '}})')
        def lifecycle(value):
            page = cdp.attach(target['targetId']); cdp.page_sessions.add(page)
            try:
                cdp.call('Page.setWebLifecycleState', {'state': value}, page)
            finally:
                cdp.call('Target.detachFromTarget', {'sessionId': page}); cdp.page_sessions.remove(page)
        def start_wait(params):
            output = queue.Queue()
            def invoke():
                try:
                    output.put(('ok', mcp.tool('browser_wait', {'tabId': tab_id, **params}, timeout=17)))
                except BaseException:
                    output.put(('error', traceback.format_exc()))
            thread = threading.Thread(target=invoke, daemon=True); thread.start()
            return output, thread
        def finish_wait(pending):
            output, thread = pending
            kind, result = output.get(timeout=18); thread.join(timeout=2)
            assert kind == 'ok', result
            assert not thread.is_alive(), 'MCP waiter thread leaked'
            return result
        report['initialFixtureState'] = state(tab_id)
        check('Private fixture is inactive healthy and lifecycle recovery disabled',
              not state(tab_id)['active'] and not state(tab_id)['frozen']
              and js('lifecycleWakeEnabled') is False)
        if baseline:
            # Forward the page's native timer unchanged, recording only waitFor's 100ms
            # scheduling. This proves the ORIGINAL function entered its await loop;
            # native API dispatch alone would not establish page execution.
            report['limitations'].append('Baseline-only isolated-world timer forwarding records original waitFor entry; timer and agent implementations are not replaced.')
            isolated = lambda expression: js('qaScript({target:{tabId:' + str(tab_id) + '},world:"ISOLATED",injectImmediately:true,func:()=>{' + expression + '}})')
            isolated("globalThis.qaWaitTimerScheduled=0;globalThis.qaOriginalTimer=globalThis.setTimeout;globalThis.setTimeout=function(fn,delay,...args){if(delay===100 && /waitFor/.test(new Error().stack)){globalThis.qaWaitTimerScheduled++;globalThis.qaLastWaitTimerAt=Date.now()}return globalThis.qaOriginalTimer.call(this,fn,delay,...args)};return true")
            pending = start_wait({'name': 'UCLOUD', 'timeoutMs': 5000})
            until(lambda: waits(), label='original waitFor dispatched')
            timer_entry = until(lambda: isolated("return {scheduled:globalThis.qaWaitTimerScheduled,lastAt:globalThis.qaLastWaitTimerAt}")[0].get('result'), label='original wait timer instrumentation')
            until(lambda: isolated("return globalThis.qaWaitTimerScheduled")[0].get('result', 0) >= 1,
                  label='ORIGINAL waitFor entered actual page timer loop')
            timer_entry = isolated("return {scheduled:globalThis.qaWaitTimerScheduled,lastAt:globalThis.qaLastWaitTimerAt}")[0]['result']
            check('Original native wait entered actual page timer loop and remains pending before freeze',
                  timer_entry['scheduled'] >= 1 and len(waits()) == 1 and 'settled' not in waits()[0], pageTimerEntry=timer_entry)
            lifecycle('frozen')
            frozen = until(lambda: state(tab_id) if state(tab_id).get('frozen') is True else None,
                           label='native frozen after page detach')
            check('Baseline freezes during original running wait with all page sessions detached',
                  frozen['frozen'] is True and not cdp.page_sessions, nativeState=frozen)
            response, elapsed = finish_wait(pending)
            held = waits()[0]
            held_age = js('Date.now()-qaCalls.find(c=>c.operation==="waitFor").at')
            before_thaw = locks()
            check('Original page promise outlives 5000ms and outer command times out while busy is retained',
                  error(response).get('code') == 'COMMAND_TIMEOUT' and elapsed >= 10.8
                  and held_age > 10000 and 'settled' not in held and before_thaw['running'] == [tab_id]
                  and before_thaw['operations'][0]['timedOut'] is True,
                  response=response, elapsedSeconds=elapsed, rawPromiseAgeMs=held_age, locks=before_thaw, nativeWait=held)
            lifecycle('active')
            until(lambda: waits()[0].get('settled'), label='original native wait raw settlement after thaw')
            until(clear, label='baseline locks release only after original raw settlement')
            isolated("globalThis.setTimeout=globalThis.qaOriginalTimer;return globalThis.qaWaitTimerScheduled")
            check('Private thaw resumes and settles original exactly once without replay',
                  len(waits()) == 1 and waits()[0].get('settled') is not None and clear(), originalWait=waits()[0], locks=locks())
            fresh, _ = mcp.tool('browser_wait', {'tabId': tab_id, 'name': 'Healthy control', 'timeoutMs': 0})
            check('Fresh safe check succeeds after private baseline thaw', data(fresh)['matched'] is True)
        else:
            offset = len(waits())
            response, elapsed = mcp.tool('browser_wait', {'tabId': tab_id, 'name': 'Absent fixture', 'timeoutMs': 700})
            result = data(response)
            check('Absent condition returns matched false around requested 700ms via full MCP',
                  result['matched'] is False and result['timedOut'] is True and .65 <= elapsed < 2
                  and 650 <= result['elapsedMs'] < 1800 and clear(), result=result, elapsedSeconds=elapsed)
            probes = waits()[offset:]
            check('Every completed page wait is immediate with no native page wait left queued',
                  len(probes) >= 2 and all(c['params']['timeoutMs'] == 0 and c.get('settled') for c in probes), probes=probes)
            control("setTimeout(()=>document.getElementById('later').disabled=false,450);return true")
            response, elapsed = mcp.tool('browser_wait', {'tabId': tab_id, 'name': 'Later condition', 'state': 'enabled', 'timeoutMs': 2000})
            result = data(response)
            check('Later condition matches before deadline through full MCP', result['matched'] is True and .3 < elapsed < 1.8, result=result, elapsedSeconds=elapsed)
            snapshot, _ = mcp.tool('browser_snapshot', {'tabId': tab_id, 'load': 'current', 'name': 'Healthy control'})
            snap = data(snapshot)
            elements = snap.get('elements', [])
            ref = next(element['ref'] for element in elements if element.get('name') == 'Healthy control')
            offset_calls = len(calls())
            response, elapsed = mcp.tool('browser_wait', {'tabId': tab_id, 'ref': ref, 'state': 'visible', 'timeoutMs': 500})
            after_calls = calls()[offset_calls:]
            check('Ref wait keeps existing reference without rebuilding snapshot', data(response)['matched'] is True
                  and all(c.get('operation') != 'snapshot' for c in after_calls)
                  and all(c['params']['ref'] == ref for c in after_calls if c.get('operation') == 'waitFor'), calls=after_calls, ref=ref)
            inspected, _ = mcp.tool('browser_inspect', {'tabId': tab_id, 'ref': ref})
            check('Original target ref remains usable after waiting', not inspected.get('isError'), response=inspected)
            offset = len(waits()); offset_calls = len(calls())
            js('qaGateAfterWait=true;qaGateReady=false')
            pending = start_wait({'name': 'UCLOUD', 'timeoutMs': 5000})
            until(lambda: js('qaGateReady'), label='native tabs.get gate after completed first probe')
            check('Freeze setup gate follows exactly one completed immediate probe', len(waits()[offset:]) == 1 and waits()[offset].get('settled') is not None,
                  firstProbe=waits()[offset])
            lifecycle('frozen')
            frozen = until(lambda: state(tab_id) if state(tab_id).get('frozen') is True else None, label='native frozen after detach')
            release_at = time.monotonic(); js('qaReleaseGet()')
            response, elapsed = finish_wait(pending); release_elapsed = time.monotonic() - release_at
            result_error = error(response); after_calls = calls()[offset_calls:]
            check('Freeze after first probe promptly returns TAB_FROZEN unverified with no new page script',
                  result_error.get('code') == 'TAB_FROZEN' and result_error.get('outcome') == 'unverified'
                  and result_error.get('diagnostic', {}).get('frozen') is True and release_elapsed < 1.5
                  and len(waits()[offset:]) == 1 and len([c for c in after_calls if c['kind'] == 'script']) == 2
                  and not cdp.page_sessions and clear(), response=response, elapsedSeconds=elapsed,
                  elapsedAfterNativeGateRelease=release_elapsed, nativeState=frozen, locks=locks(), calls=after_calls)
            check('Frozen result leaves no outstanding native page wait', all(c.get('settled') for c in waits()), nativeWaits=waits()[offset:])
            lifecycle('active'); until(lambda: not state(tab_id)['frozen'], label='private thaw control')
            response, _ = mcp.tool('browser_wait', {'tabId': tab_id, 'name': 'Healthy control', 'timeoutMs': 0})
            check('Fresh safe check succeeds after private updated thaw', data(response)['matched'] is True and clear())
            offset = len(waits()); offset_calls = len(calls())
            js('qaGateAfterWait=true;qaGateReady=false')
            pending = start_wait({'name': 'Absent fixture', 'timeoutMs': 5000})
            until(lambda: js('qaGateReady'), label='same-document navigation control gate')
            control("history.replaceState({},'',location.pathname+'#changed');return location.href")
            js('qaReleaseGet()'); response, _ = finish_wait(pending)
            check('Same-document URL navigation rejects before another page invocation',
                  error(response).get('code') == 'PAGE_AGENT_DOCUMENT_CHANGED' and len(waits()[offset:]) == 1
                  and len([c for c in calls()[offset_calls:] if c['kind'] == 'script']) == 2 and clear(), response=response, locks=locks())
            offset = len(waits()); js('qaHoldNextWait=true;qaHoldReady=false')
            pending = start_wait({'name': 'Absent fixture', 'timeoutMs': 500})
            until(lambda: js('qaHoldReady'), label='actual native probe result forwarding hold')
            response, elapsed = finish_wait(pending)
            held_locks = locks()
            check('Withheld native API result reaches outer timeout and retains busy lock',
                  error(response).get('code') == 'COMMAND_TIMEOUT' and held_locks['running'] == [tab_id]
                  and held_locks['operations'][0]['timedOut'] is True, response=response, elapsedSeconds=elapsed, locks=held_locks)
            busy, _ = mcp.tool('browser_wait', {'tabId': tab_id, 'name': 'Healthy control', 'timeoutMs': 0})
            check('Hanging probe refuses fresh request without overlap', error(busy).get('code') == 'TAB_BUSY'
                  and error(busy).get('outcome') == 'not-dispatched' and len(waits()[offset:]) == 1, response=busy)
            js('qaReleaseHold()'); until(clear, label='held native forwarding raw settlement')
            check('Original held probe settles once and releases lock without replay', len(waits()[offset:]) == 1 and waits()[offset].get('settled') is not None and clear(), nativeWait=waits()[offset])
        check('Private active tab and fixture business input preserved', active() == original_active
              and control("return document.querySelector('input').value")[0]['result'] == 'unchanged', activeBefore=original_active, activeAfter=active())
        check('No production debugger, tab activation, navigation or reload API used',
              all(c['kind'] == 'script' for c in calls()), apiCalls=calls())
        report['finalLocks'] = locks()
        report['finalFixtureState'] = state(tab_id)
        report['nativeAPICalls'] = calls()
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