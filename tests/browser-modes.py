"""Ordinary/incognito routing in real Edge through the MCP and HTTP bridge.

Run with python -B tests/browser-modes.py on Windows. Only a fresh Edge profile,
localhost fixture and private bridge are used. Fixture setup controls the browser
settings of this profile to exercise the native incognito permission boundary.
"""
import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/qa/browser-modes'
helpers = runpy.run_path(str(Path(__file__).with_name('browser-wait-lifecycle.py')))
CDP, MCP, free_port, kill_tree, until = (helpers[name] for name in ('CDP', 'MCP', 'free_port', 'kill_tree', 'until'))


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        page = b'<!doctype html><meta charset="utf-8"><title>Browser mode fixture</title><h1>Browser mode fixture</h1><button>Test control</button>'
        if self.path == '/iframe-root':
            page += (f'<iframe src="/same-frame"></iframe>'
                     f'<iframe src="http://localhost:{self.server.server_port}/foreign-frame"></iframe>'
                     '<iframe srcdoc="&lt;em&gt;Inline fixture&lt;/em&gt;"></iframe><iframe></iframe>').encode()
        elif self.path == '/same-frame':
            page = b'<h1>Same-origin fixture text</h1><button>Same-origin fixture control</button>'
        elif self.path == '/foreign-frame':
            page = '<meta charset="utf-8"><h1>账户总览</h1><button>月账单</button>'.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, *_):
        pass


def url_json(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='qa-', dir=OUT))
    report = {'result': 'failed', 'checks': []}
    mcp = cdp = edge = bridge = fixture = None
    cleanup_errors = []
    logs = []

    def log(name):
        handle = (run / (name + '.log')).open('w', encoding='utf-8')
        logs.append(handle)
        return handle

    def check(name, condition, **evidence):
        entry = {'name': name, 'passed': bool(condition), **evidence}
        report['checks'].append(entry)
        assert condition, entry
        print('PASS ' + name, flush=True)

    def call(method, **arguments):
        return mcp.tool('browser_' + method, arguments)[0]

    def success(method, **arguments):
        response = call(method, **arguments)
        assert not response.get('isError'), response
        return json.loads(response['content'][0]['text'])

    def error(method, code, **arguments):
        response = call(method, **arguments)
        actual = response.get('structuredContent', {}).get('error', {})
        assert response.get('isError') and actual.get('code') == code, response
        assert actual.get('outcome') == 'not-dispatched', response
        return actual

    try:
        fixture = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{fixture.server_port}'
        for name in ('tmp', 'home/AppData/Roaming', 'home/AppData/Local', 'config'):
            (run / name).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'TEMP': str(run / 'tmp'), 'TMP': str(run / 'tmp'),
               'HOME': str(run / 'home'), 'USERPROFILE': str(run / 'home'),
               'APPDATA': str(run / 'home/AppData/Roaming'), 'LOCALAPPDATA': str(run / 'home/AppData/Local')}
        port, debug_port = free_port(), free_port()
        while debug_port in (port, fixture.server_port):
            debug_port = free_port()
        copy = run / 'extension'
        shutil.copytree(ROOT / 'extension', copy, ignore=shutil.ignore_patterns('tests'))
        report['sourceSHA256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (
            'extension/background.js', 'extension/tasks.js', 'server/bridge.mjs', 'server/protocol.mjs', 'server/mcp-worker.mjs')}
        manifest = json.loads((copy / 'manifest.json').read_text(encoding='utf-8'))
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (copy / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        # The startup read barrier keeps even initial extension traffic on the private bridge.
        bootstrap = ('const qaInit=chrome.storage.local.set(' + json.dumps({
            'bridgePort': port, 'autoAuthorize': True, 'disconnected': True, 'cdpEnabled': False,
            'screenshotCdpEnabled': False, 'lifecycleWakeEnabled': False}) + ');'
            'const qaGet=chrome.storage.local.get.bind(chrome.storage.local);'
            'chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};'
            'importScripts("background.js");')
        (copy / 'qa-bootstrap.js').write_text(bootstrap, encoding='utf-8')
        other = run / 'fixture-extension'
        other.mkdir()
        (other / 'manifest.json').write_text(json.dumps({
            'manifest_version': 3, 'name': 'Restricted page fixture', 'version': '1.0',
            'background': {'service_worker': 'qa-foreign.js'},
            'web_accessible_resources': [{'resources': ['page.html'], 'matches': ['http://127.0.0.1/*']}]
        }), encoding='utf-8')
        (other / 'qa-foreign.js').write_text('chrome.runtime.onInstalled.addListener(() => {});', encoding='utf-8')
        (other / 'page.html').write_text('<title>Foreign extension fixture</title>', encoding='utf-8')
        bridge_log = log('bridge')
        bridge = subprocess.Popen(['node', 'server/bridge.mjs', '--bridge', '--port', str(port),
                                   '--config-dir', str(run / 'config')], cwd=ROOT, env=env,
                                  stdout=bridge_log, stderr=bridge_log, creationflags=subprocess.CREATE_NO_WINDOW)
        status = lambda: url_json(f'http://127.0.0.1:{port}/status')
        until(status, label='private bridge startup')
        mcp = MCP(port, run / 'config', env, log('mcp'))
        executable = os.environ.get('FROZEN_TEST_EDGE', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
        edge_log = log('edge')
        edge = subprocess.Popen([executable, '--headless=new', '--no-first-run', '--no-default-browser-check',
                                 '--remote-allow-origins=*', '--remote-debugging-port=' + str(debug_port),
                                 '--user-data-dir=' + str(run / 'profile'), '--disable-extensions-except=' + str(copy) + ',' + str(other),
                                 '--load-extension=' + str(copy) + ',' + str(other), base + '/regular'], env=env,
                                stdout=edge_log, stderr=edge_log)
        version = until(lambda: url_json(f'http://127.0.0.1:{debug_port}/json/version'), label='private Edge startup')
        report['browser'] = version['Browser']
        cdp = CDP(version['webSocketDebuggerUrl'])

        def worker(previous_id=None):
            return next((target for target in cdp.call('Target.getTargets')['targetInfos']
                         if target['type'] == 'service_worker' and target['url'].endswith('/qa-bootstrap.js')
                         and target['targetId'] != previous_id), None)

        def connect_worker(previous_id=None):
            target = until(lambda: worker(previous_id), label='fixture extension worker')
            session = cdp.attach(target['targetId'])
            cdp.call('Runtime.enable', {}, session)
            js = lambda expression: cdp.evaluate(session, expression)
            until(lambda: js('typeof handlePopup === "function"'), label='extension startup')
            js('ready.then(()=>handlePopup({type:"connect"}))')
            until(lambda: (status() or {}).get('browserModeProtocol') == 1, label='fixture extension mode protocol')
            return target, js

        target, js = connect_worker()
        extension_id = target['url'].split('/')[2]
        permission = lambda: js('chrome.extension.isAllowedIncognitoAccess()')
        check('New profile starts with incognito access disabled', permission() is False)
        mcp_status = success('status')
        check('Real MCP, bridge and extension agree on new version and mode support',
              mcp_status.get('mcpVersion') == mcp_status.get('version') == mcp_status.get('extensionVersion') == manifest['version']
              and mcp_status.get('browserModeProtocol') == 1, status=mcp_status)
        regular = next(tab for tab in success('list_tabs') if tab['url'] == base + '/regular')
        check('Default list reports ordinary page and actual mode', regular['browserMode'] == 'regular' and regular['incognito'] is False)
        check('Disabled incognito permission keeps the private list empty', success('list_tabs', browserMode='incognito') == [])
        error('open', 'NO_BROWSER_WINDOW', url=base+'/blocked', taskId='mode-fixture', taskName='Mode fixture', browserMode='incognito')
        check('Explicit private open with access disabled never opens an ordinary fallback',
              all(tab['url'] != base+'/blocked' for tab in success('list_tabs')))

        # Set the native extension preference in this fresh test profile only.
        details = cdp.call('Target.createTarget', {'url': 'edge://extensions/'})['targetId']
        settings = cdp.attach(details)
        settings_js = lambda expression: cdp.evaluate(settings, expression)
        until(lambda: settings_js('typeof chrome?.developerPrivate?.updateExtensionConfiguration === "function"'),
              label='native extension settings page')
        result = settings_js('new Promise(resolve => chrome.developerPrivate.updateExtensionConfiguration('
                             + json.dumps({'extensionId': extension_id, 'incognitoAccess': True})
                             + ', () => resolve(chrome.runtime.lastError?.message || "updated")))')
        assert result == 'updated', result
        target, js = connect_worker(target['targetId'])
        check('Native incognito permission changed in the private profile', permission() is True)
        cdp.call('Target.closeTarget', {'targetId': details})
        private = js('chrome.windows.create({url:' + json.dumps(base + '/private') +
                     ',incognito:true,focused:true}).then(async w=>({id:w.id,tab:(await chrome.tabs.query({windowId:w.id}))[0]}))')
        private_id = private['tab']['id']
        until(lambda: js(f'chrome.tabs.get({private_id}).then(t=>t.status==="complete")'), label='private fixture loaded')
        check('Browser reports a real focused incognito normal-type window',
              js('chrome.windows.getLastFocused({windowTypes:["normal"]}).then(w=>({id:w.id,incognito:w.incognito,type:w.type}))')
              == {'id': private['id'], 'incognito': True, 'type': 'normal'})
        regular_list = success('list_tabs')
        private_list = success('list_tabs', browserMode='incognito')
        check('Discovery separates both modes and marks each row',
              regular['id'] in [tab['id'] for tab in regular_list] and all(tab['incognito'] is False and tab['browserMode'] == 'regular' for tab in regular_list)
              and private_id in [tab['id'] for tab in private_list] and all(tab['incognito'] is True and tab['browserMode'] == 'incognito' for tab in private_list),
              regular=regular_list, incognito=private_list)

        open_args = {'url': base+'/child', 'taskId': 'mode-fixture', 'taskName': 'Mode fixture'}
        mode_regular = success('open', **open_args)
        mode_private = success('open', **open_args, browserMode='incognito')
        info = lambda id: js(f'chrome.tabs.get({id}).then(t=>({{incognito:t.incognito,windowId:t.windowId,active:t.active}}))')
        check('Default open finds ordinary window even with an incognito window focused',
              mode_regular['browserMode'] == 'regular' and mode_regular['incognito'] is False
              and info(mode_regular['tabId']) == {'incognito': False, 'windowId': mode_regular['windowId'], 'active': False})
        check('Explicit incognito open uses the correct window without activating the new tab',
              mode_private['browserMode'] == 'incognito' and mode_private['incognito'] is True
              and info(mode_private['tabId']) == {'incognito': True, 'windowId': private['id'], 'active': False})
        error('open', 'BROWSER_MODE_MISMATCH', **open_args, tabId=private_id)
        error('snapshot', 'BROWSER_MODE_MISMATCH', tabId=private_id, load='current')
        error('navigate', 'BROWSER_MODE_MISMATCH', tabId=private_id, url=base+'/blocked')
        check('Ordinary calls cannot open via or operate on an explicitly named private tab ID',
              js(f'chrome.tabs.get({private_id}).then(t=>t.url)') == base+'/private')
        check('Explicit private read works through normal page authorization',
              success('snapshot', tabId=private_id, load='current', browserMode='incognito')['title'] == 'Browser mode fixture')
        batched = success('batch', commands=[
            {'method': 'snapshot', 'params': {'tabId': regular['id'], 'load': 'current'}},
            {'method': 'snapshot', 'params': {'tabId': private_id, 'load': 'current'}}])
        check('A private tab without opt-in fails independently in a mixed batch',
              batched[0]['ok'] and not batched[1]['ok'] and batched[1]['error']['code'] == 'BROWSER_MODE_MISMATCH')
        task = {'taskId': 'mode-fixture'}
        regular_task = success('task', **task, action='list')['tabs']
        private_task = success('task', **task, action='list', browserMode='incognito')['tabs']
        check('Using one task ID still keeps native task listings separate',
              [tab['id'] for tab in regular_task] == [mode_regular['tabId']]
              and [tab['id'] for tab in private_task] == [mode_private['tabId']])
        finished = success('task', **task, action='finish')
        check('Ordinary task finish only closes the ordinary managed tab',
              finished['closed'] == [mode_regular['tabId']] and info(mode_private['tabId'])['incognito'] is True)
        last_focused = js('chrome.windows.getLastFocused().then(w=>w.id)')
        check('Mode operations preserve the focused incognito window', last_focused == private['id'])
        # Verify ordinary HTTP routing in the same isolated profile and through stdio MCP.
        pane = {'taskId': 'target-fixture', 'taskName': 'Target fixture'}
        root_tab = success('open', url=base + '/iframe-root', **pane)['tabId']
        wait_loaded = lambda tab: until(lambda: js(f'chrome.tabs.get({tab}).then(t=>t.status==="complete")'), label='test tab load')
        wait_loaded(root_tab)
        root = success('snapshot', tabId=root_tab, load='current', format='compact')
        frames = root['frameList']
        foreign = next(item for item in frames if item.get('crossOrigin') is True)
        check('Snapshot preserves count and same-origin text, and identifies the cross-origin iframe',
              root['frames'] == len(frames) == 4 and '[iframe]' in root['text']
              and 'Same-origin fixture text' in root['text'] and '账户总览' not in root['text']
              and foreign['origin'] == f'http://localhost:{fixture.server_port}'
              and foreign['src'].endswith('/foreign-frame')
              and {item['kind'] for item in frames} == {'src', 'srcdoc', 'noSrc'})
        child = success('open', url=foreign['src'], **pane)['tabId']
        wait_loaded(child)
        child_page = success('snapshot', tabId=child, load='current', name='月账单', exact=True)
        check('Opening the fixture iframe src separately exposes a normal actionable ref',
              '账户总览' in child_page['text'] and len(child_page['elements']) == 1 and child_page['elements'][0]['ref'].startswith('r'))
        success('focus', tabId=child, ref=child_page['elements'][0]['ref'])
        other_target = until(lambda: next((t for t in cdp.call('Target.getTargets')['targetInfos']
            if t['type'] == 'service_worker' and t['url'].endswith('/qa-foreign.js')), None), label='other fixture extension')
        other_url = other_target['url'].removesuffix('qa-foreign.js') + 'page.html'
        js(f'chrome.tabs.update({root_tab}, {{url:{json.dumps(other_url)}}})')
        until(lambda: js(f'chrome.tabs.get({root_tab}).then(t=>t.url==={json.dumps(other_url)}&&t.status==="complete")'), label='foreign extension commit')
        listing = success('task', taskId=pane['taskId'], action='list')['tabs']
        listed = next(tab for tab in listing if tab['id'] == root_tab)
        check('Browser task reports committed browser URL separately from the registration key',
              listed['url'] == other_url and listed['key'] == 'url:' + base + '/iframe-root')
        js('ready.then(()=>handlePopup({type:"set_screenshot_cdp_enabled",enabled:true}))')
        for method, params in [('snapshot', {'load': 'current'}), ('screenshot', {})]:
            blocked = error(method, 'UNSUPPORTED_TAB_URL', tabId=root_tab, **params)
            check(f'{method} stops at preflight on a different extension page',
                  blocked['diagnostic']['phase'] == 'tabs.get' and blocked['diagnostic']['stage'] == 'preflight'
                  and blocked['recovery']['maintenanceRequired'] is False)
        check('Explicit authorized navigation recovers the same tab to HTTP',
              success('navigate', tabId=root_tab, url=base + '/regular')['navigated'] is True)
        wait_loaded(root_tab)
        check('Snapshot works again on the recovered tab', success('snapshot', tabId=root_tab, load='current')['title'] == 'Browser mode fixture')
        # Remove regular windows only in this fresh test profile, to verify the converse absence.
        js('chrome.windows.getAll().then(ws=>Promise.all(ws.filter(w=>!w.incognito).map(w=>chrome.windows.remove(w.id))))')
        error('open', 'NO_BROWSER_WINDOW', **open_args)
        check('With only incognito windows, default open returns no ordinary window',
              success('list_tabs') == [] and private_id in [tab['id'] for tab in success('list_tabs', browserMode='incognito')])
        report['result'] = 'passed'
    except Exception:
        report['error'] = traceback.format_exc()
        print(report['error'], flush=True)
    finally:
        if mcp:
            report['mcpCalls'] = mcp.calls
            try:
                mcp.close()
            except Exception as exc:
                cleanup_errors.append('MCP: ' + repr(exc))
        if cdp:
            try:
                cdp.call('Browser.close')
            except (OSError, websocket.WebSocketException):
                pass
            finally:
                cdp.ws.close()
        for name, process in [('Edge', edge), ('bridge', bridge)]:
            if process and process.poll() is None:
                try:
                    if name == 'bridge':
                        kill_tree(process.pid)
                    process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    try:
                        kill_tree(process.pid)
                        process.wait(timeout=5)
                    except Exception as exc:
                        cleanup_errors.append(name + ': ' + repr(exc))
        if fixture:
            fixture.shutdown()
            fixture.server_close()
        for handle in logs:
            handle.close()
        if cleanup_errors:
            report['result'] = 'failed'
        report['cleanupErrors'] = cleanup_errors
        report_path = run / 'results.json'
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(f'REPORT {report_path}', flush=True)
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
