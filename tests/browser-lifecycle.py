"""真实Edge + 原样扩展 + MCP：任务分组/复用/清理、多页并行、模式降级、无工具调用的桥恢复。
只使用临时profile、临时home、临时桥和本地夹具，不操作用户浏览器或配置。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa' / 'v0120'
OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'result': 'running'}
HTML = '''<!doctype html><meta charset="utf-8"><title>任务生命周期验收</title>
<style>body{font:20px system-ui;background:#eef4ff;padding:50px}button,input{font:inherit;padding:12px;margin:12px}</style>
<h1>任务生命周期验收</h1><button onclick="document.querySelector('output').textContent=++window.count">增加计数</button>
<input aria-label="备注" value=""><select aria-label="默认选择"><option>默认</option><option>其他</option></select>
<output>0</output><script>window.count=0;</script>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(HTML.encode())
    def log_message(self, *_):
        pass


def until(fn, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('等待条件超时')


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/'
mcp = None
bridge_pids = set()
try:
    with tempfile.TemporaryDirectory(prefix='browser-lifecycle-') as temp:
        folder = Path(temp)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        bridge_dir = folder / '.zcode' / 'ai-browser-control' / str(port)
        log = bridge_dir / 'bridge.log'

        def starts():
            if not log.exists():
                return []
            records = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]
            found = [record for record in records if record['event'] == 'bridge_start']
            bridge_pids.update(record['pid'] for record in found)
            return found

        mcp = subprocess.Popen(['node', 'server/mcp.mjs', '--port', str(port)], cwd=ROOT,
            env={**os.environ, 'USERPROFILE': temp, 'HOME': temp},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
        first = until(starts)[0]
        assert first['version'] == '0.12.0'
        report['checks'].append({'name': 'MCP启动后无任何工具调用即启动桥', 'passed': True})
        sequence = 0

        def tool(name, args=None, error=False, raw=False):
            global sequence
            sequence += 1
            mcp.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': 'tools/call',
                'params': {'name': name, 'arguments': args or {}}}) + '\n')
            mcp.stdin.flush()
            result = json.loads(mcp.stdout.readline())['result']
            if result.get('isError'):
                assert error, result
                return result
            if raw:
                return result
            return json.loads(result['content'][0]['text'])

        extension = folder / 'extension'
        shutil.copytree(ROOT / 'extension', extension, ignore=shutil.ignore_patterns('tests'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (extension / 'qa-bootstrap.js').write_text(
            f"const qaInit=chrome.storage.local.set({{bridgePort:{port},autoAuthorize:true,disconnected:true}});"
            "const qaGet=chrome.storage.local.get.bind(chrome.storage.local);"
            "chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};importScripts('background.js');", encoding='utf-8')

        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(str(folder / 'profile'), channel='msedge', headless=True,
                viewport={'width': 1100, 'height': 800}, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'],
                ignore_default_args=['--disable-extensions'])
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate("async()=>{for(let i=0;i<100&&typeof handlePopup!=='function';i++)await new Promise(r=>setTimeout(r,25));}")
                original = context.pages[0]
                original.goto(base)
                worker.evaluate("handlePopup({type:'connect'})")
                until(lambda: tool('browser_status')['connected'])
                original_id = next(tab['id'] for tab in tool('browser_list_tabs') if tab['url'] == base)
                active_before = worker.evaluate('chrome.tabs.query({active:true}).then(t=>t.map(x=>x.id))')
                one = tool('browser_open', {'url': base, 'taskId': 'qa-task', 'taskName': '账单核对'})
                two = tool('browser_open', {'url': base + '?second', 'taskId': 'qa-task', 'taskName': '账单核对'})
                other = tool('browser_open', {'url': base, 'taskId': 'qa-other', 'taskName': '另一个任务'})
                assert one['tabId'] != original_id and one['groupId'] == two['groupId'] != other['groupId']
                assert worker.evaluate(f'chrome.tabGroups.get({one["groupId"]})')['title'] == '账单核对'
                assert tool('browser_open', {'url': base, 'taskId': 'qa-task', 'taskName': '账单核对'})['tabId'] == one['tabId']
                assert worker.evaluate('chrome.tabs.query({active:true}).then(t=>t.map(x=>x.id))') == active_before
                report['checks'].append({'name': '真实任务分组、任务隔离、只复用插件同任务页，不激活或复用用户页', 'passed': True})

                # 将两个快照都挂在实际Chrome API前，只有均已进入才一起放行，排除串行伪并发。
                worker.evaluate("""()=>{globalThis.qaOriginal=chrome.scripting.executeScript;globalThis.qaStarted=[];let pending=[];
                  chrome.scripting.executeScript=spec=>spec.args?.[0]==='snapshot'?new Promise((resolve,reject)=>{
                    qaStarted.push(spec.target.tabId);pending.push(()=>qaOriginal(spec).then(resolve,reject));
                    if(pending.length===2)pending.forEach(run=>run());
                  }):qaOriginal(spec)}""")
                batch = tool('browser_batch', {'commands': [
                    {'method': 'snapshot', 'params': {'tabId': one['tabId'], 'load': 'current'}},
                    {'method': 'snapshot', 'params': {'tabId': two['tabId'], 'load': 'current'}}]})
                assert len(worker.evaluate('qaStarted')) == 2 and all(item['ok'] for item in batch)
                worker.evaluate('()=>{chrome.scripting.executeScript=qaOriginal}')
                report['checks'].append({'name': '真实MCP批次两个页面同时进入注入阶段并独立返回结果', 'passed': True})
                images = tool('browser_batch', {'commands': [
                    {'method': 'screenshot', 'params': {'tabId': one['tabId']}},
                    {'method': 'screenshot', 'params': {'tabId': two['tabId']}}]}, raw=True)
                assert sum(item['type'] == 'image' for item in images['content']) == 2
                import base64
                (OUT / 'managed-page.png').write_bytes(base64.b64decode(images['content'][1]['data']))
                assert worker.evaluate('attached.size') == 0
                report['checks'].append({'name': '后台双页并行截图，MCP返回两张原生图片且临时调试器已解除', 'passed': True})

                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:true})")
                snap = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current'})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '增加计数')
                worker.evaluate("()=>{globalThis.qaAttach=chrome.debugger.attach;chrome.debugger.attach=async()=>{throw new Error('test restriction')}}")
                result = tool('browser_click', {'tabId': one['tabId'], 'ref': button})
                assert result['mode'] == 'dom' and result['fallbackReason'] == 'CDP_ATTACH_FAILED'
                assert '1' in tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current'})['text']
                assert worker.evaluate('cdpEnabled') is True
                worker.evaluate('()=>{chrome.debugger.attach=qaAttach}')
                snap = tool('browser_snapshot', {'tabId': two['tabId'], 'load': 'current'})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '增加计数')
                result = tool('browser_click', {'tabId': two['tabId'], 'ref': button, 'mode': 'dom'})
                assert result['mode'] == 'dom' and worker.evaluate('cdpEnabled') is True
                report['checks'].append({'name': '真实DOM点击验证附加失败安全降级与单次DOM覆盖，不更改用户CDP开关', 'passed': True})

                edited = tool('browser_open', {'url': base + '?edited', 'taskId': 'qa-task', 'taskName': '账单核对'})
                def find_edited():
                    original.wait_for_timeout(50)
                    return next((page for page in context.pages if page.url == base + '?edited'), None)
                edited_page = until(find_edited)
                edited_page.wait_for_selector('input')
                edited_page.evaluate("document.querySelector('input').value='未保存内容'")

                # 保留一个交付页；整组结束只关本任务其余页，原页及其他任务不受影响。
                finished = tool('browser_task', {'taskId': 'qa-task', 'action': 'finish', 'keepTabIds': [one['tabId']]})
                assert two['tabId'] in finished['closed'] and one['tabId'] in finished['remaining']
                assert any(item['tabId'] == edited['tabId'] and item['reason'] == 'form-state' for item in finished['skipped'])
                alive = [tab['id'] for tab in tool('browser_list_tabs')]
                assert original_id in alive and other['tabId'] in alive
                tool('browser_task', {'taskId': 'qa-other', 'action': 'finish'})
                groups = worker.evaluate('chrome.tabGroups.query({})')
                assert not any(group['id'] == other['groupId'] for group in groups)
                report['checks'].append({'name': '批量清理、keep与未保存表单保护、空任务组自动销毁，用户页和其他任务页不误关', 'passed': True})

                # 直接终止临时桥；期间不调用任何MCP工具，靠日志确认监督器自行恢复。
                os.kill(first['pid'], 15)
                bridge_pids.discard(first['pid'])
                recovered = until(lambda: next((entry for entry in starts() if entry['pid'] != first['pid']), None))
                until(lambda: worker.evaluate('connectionStatus()')['connected'], timeout=20)
                status = tool('browser_status')
                assert status['connected'] and status['extensionVersion'] == '0.12.0'
                assert any(tab['id'] == original_id for tab in tool('browser_list_tabs'))
                report['checks'].append({'name': '强制终止桥后无需工具调用或手动启动，监督器拉起新PID且真实扩展接回', 'passed': True,
                    'oldPid': first['pid'], 'newPid': recovered['pid']})
                report['status'] = status
                worker.evaluate("handlePopup({type:'disconnect'})")
                # 保存诊断元数据，无网页内容或凭据。
                shutil.copy2(log, OUT / 'lifecycle-bridge.log')
            finally:
                context.close()
        mcp.stdin.close()
        mcp.wait(timeout=8)
        # 宿主关闭停止监督，不应再次启动桥；共享桥本身不由宿主退出杀死。
        last_pid = starts()[-1]['pid']
        os.kill(last_pid, 15)
        bridge_pids.discard(last_pid)
        time.sleep(5.2)
        assert len(starts()) == 2
        report['checks'].append({'name': 'MCP退出停止监督，不遗留重启循环', 'passed': True})
        report['result'] = 'passed'
except BaseException as error:
    report['result'] = 'failed'
    report['error'] = str(error)
    raise
finally:
    if mcp and mcp.poll() is None:
        mcp.terminate()
        mcp.wait(timeout=5)
    for pid in bridge_pids:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
    server.shutdown()
    (OUT / 'browser-lifecycle-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
