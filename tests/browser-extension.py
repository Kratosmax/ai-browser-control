"""真实 Edge MV3 扩展 + 临时桥 + MCP stdio 集成验收。
仅使用临时浏览器配置及本地测试页面；不接触用户的桥、标签页或授权配置。
"""
import base64
import io
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa'
OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'result': 'running'}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'test-page'), **kwargs)

    def do_GET(self):
        if self.path.startswith('/lazy'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write((ROOT / 'tests' / 'fixtures' / 'loading.html').read_bytes())
        else:
            super().do_GET()

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/'
bridge = mcp = None
try:
    with tempfile.TemporaryDirectory(prefix='ai-browser-integration-') as temp:
        folder = Path(temp)
        # 仅测试 bootstrap 配置临时端口；扩展的实际源码保持原样。
        script = "import {createBridge} from './server/bridge.mjs';const bridge=createBridge({port:0,configDir:process.argv[1]});const port=await bridge.start();console.log(JSON.stringify({port}));process.stdin.resume();process.stdin.on('end',async()=>{await bridge.close();process.exit(0)});"
        bridge = subprocess.Popen(['node', '--input-type=module', '-e', script, str(folder / 'bridge')], cwd=ROOT,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
        port = json.loads(bridge.stdout.readline())['port']
        extension = folder / 'extension'
        shutil.copytree(ROOT / 'extension', extension, ignore=shutil.ignore_patterns('tests'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        manifest['background']['service_worker'] = 'qa-bootstrap.js'
        (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (extension / 'qa-bootstrap.js').write_text(
            f"const qaInit=chrome.storage.local.set({{bridgePort:{port},autoAuthorize:true,disconnected:true}});"
            "const qaGet=chrome.storage.local.get.bind(chrome.storage.local);"
            "chrome.storage.local.get=async(...args)=>{await qaInit;return qaGet(...args)};importScripts('background.js');", encoding='utf-8')

        mcp = subprocess.Popen(['node', 'server/mcp.mjs', '--port', str(port)], cwd=ROOT,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
        sequence = 0

        def tool(name, args=None, allow_error=False):
            global sequence
            sequence += 1
            mcp.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': 'tools/call', 'params': {'name': name, 'arguments': args or {}}}) + '\n')
            mcp.stdin.flush()
            result = json.loads(mcp.stdout.readline())['result']
            if result.get('isError'):
                if allow_error:
                    return {'error': result['content'][0]['text']}
                raise AssertionError(result)
            if result['content'][0]['type'] == 'image':
                return result['content'][0]
            return json.loads(result['content'][0]['text'])

        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(str(folder / 'profile'), channel='msedge', headless=True,
                viewport={'width': 1100, 'height': 800}, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate("async()=>{for(let i=0;i<100&&typeof handlePopup!=='function';i++)await new Promise(r=>setTimeout(r,25));if(typeof handlePopup!=='function')throw new Error('扩展后台未加载')}" )
                assert worker.evaluate("handlePopup({type:'popup_status'})")['connected'] is False
                assert worker.evaluate("handlePopup({type:'popup_status'})")['cdpEnabled'] is False
                assert worker.evaluate("handlePopup({type:'popup_status'})")['screenshotCdpEnabled'] is True
                page = context.pages[0]
                page.goto(base)
                page.bring_to_front()
                worker.evaluate("handlePopup({type:'connect'})")
                page.wait_for_timeout(150)
                tabs = tool('browser_list_tabs')
                target = next(tab for tab in tabs if tab['url'] == base)
                tab_id = target['id']
                assert target['authorized']
                snap = tool('browser_snapshot', {'tabId': tab_id})
                assert 'Magpie' in snap['title']
                assert snap['coverage']['scope'] == 'loaded-dom'
                assert snap['coverage']['dataCompleteness'] == 'unknown'
                assert worker.evaluate('attached.size') == 0, '读取不得附加调试器'
                report['checks'].append({'name': 'MCP → 桥 → MV3 → 隔离世界读取', 'passed': True})
                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:true})")
                field = next(item['ref'] for item in snap['elements'] if item['name'] == '测试输入')
                assert tool('browser_fill', {'tabId': tab_id, 'ref': field, 'text': 'cdp-ok'})['mode'] == 'cdp'
                snap = tool('browser_snapshot', {'tabId': tab_id})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '记录一次')
                tool('browser_click', {'tabId': tab_id, 'ref': button})
                assert page.locator('#count').inner_text() == '1'
                assert page.locator('#saved').inner_text() == 'cdp-ok'
                assert tool('browser_screenshot', {'tabId': tab_id})['mimeType'] == 'image/png'
                report['checks'].append({'name': 'CDP 填表、点击、截图真实副作用', 'passed': True})
                foreground = context.new_page()
                foreground.goto(base + '?cdp-foreground')
                foreground.bring_to_front()
                active_before_capture = worker.evaluate('chrome.tabs.query({active:true})')
                assert not worker.evaluate(f'chrome.tabs.get({tab_id})')['active']
                # 隐藏目标页更新颜色后再截图，用像素证明不是旧画面。
                page.evaluate("document.body.style.backgroundColor='#112233'")
                background_image = tool('browser_screenshot', {'tabId': tab_id})
                png = base64.b64decode(background_image['data'])
                assert png.startswith(b'\x89PNG\r\n\x1a\n')
                assert Image.open(io.BytesIO(png)).convert('RGB').getpixel((10, 10)) == (17, 34, 51)
                (OUT / 'cdp-background-screenshot.png').write_bytes(png)
                active_after_capture = worker.evaluate('chrome.tabs.query({active:true})')
                assert [tab['id'] for tab in active_before_capture] == [tab['id'] for tab in active_after_capture]
                report['checks'].append({'name': 'CDP 截图真正未选中的后台页，不切换前台标签', 'passed': True, 'freshPixelsVerified': True})
                page.bring_to_front()
                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:false})")
                assert worker.evaluate('attached.size') == 0
                assert worker.evaluate('chrome.debugger.getTargets()').__class__ is list
                snap = tool('browser_snapshot', {'tabId': tab_id})
                field = next(item['ref'] for item in snap['elements'] if item['name'] == '测试输入')
                assert tool('browser_fill', {'tabId': tab_id, 'ref': field, 'text': 'dom-ok'})['mode'] == 'dom'
                snap = tool('browser_snapshot', {'tabId': tab_id})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '记录一次')
                assert tool('browser_click', {'tabId': tab_id, 'ref': button})['mode'] == 'dom'
                assert page.locator('#count').inner_text() == '2'
                assert page.locator('#saved').inner_text() == 'dom-ok'
                assert worker.evaluate('attached.size') == 0
                report['checks'].append({'name': '关闭 CDP 后解除调试器，DOM 填表与点击', 'passed': True})
                foreground.bring_to_front()
                selected_before = worker.evaluate('chrome.tabs.query({active:true})')
                assert tool('browser_screenshot', {'tabId': tab_id})['mimeType'] == 'image/png'
                assert worker.evaluate('attached.size') == 0
                selected_after = worker.evaluate('chrome.tabs.query({active:true})')
                assert [tab['id'] for tab in selected_before] == [tab['id'] for tab in selected_after]
                mode = next(tab for tab in tool('browser_list_tabs') if tab['id'] == tab_id)
                assert mode['inputMode'] == 'dom' and mode['screenshotMode'] == 'cdp'
                report['checks'].append({'name': 'DOM 输入模式下独立 CDP 后台截图，完成后解除临时调试器', 'passed': True})
                worker.evaluate("handlePopup({type:'set_screenshot_cdp_enabled',enabled:false})")
                page.bring_to_front()
                image = tool('browser_screenshot', {'tabId': tab_id}, allow_error=True)
                if 'error' in image:
                    assert '点击扩展图标' in image['error']
                    report['checks'].append({'name': '未获得 activeTab 临时授权时明确拒绝截图', 'passed': True, 'message': image['error']})
                else:
                    assert image['mimeType'] == 'image/png'
                    report['checks'].append({'name': '无 CDP 当前页截图', 'passed': True})
                other = context.new_page()
                other.goto(base + '?foreground')
                other.bring_to_front()
                active_before = worker.evaluate('chrome.tabs.query({active:true})')
                refused = tool('browser_screenshot', {'tabId': tab_id}, allow_error=True)
                assert '当前选中' in refused.get('error', '')
                started = time.perf_counter()
                snap = tool('browser_snapshot', {'tabId': tab_id})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '记录一次')
                tool('browser_click', {'tabId': tab_id, 'ref': button})
                elapsed = time.perf_counter() - started
                assert page.locator('#count').inner_text() == '3'
                active_after = worker.evaluate('chrome.tabs.query({active:true})')
                assert [tab['id'] for tab in active_before] == [tab['id'] for tab in active_after]
                report['checks'].append({'name': '后台 DOM 操作不切页，截图拒绝', 'passed': True, 'elapsedSeconds': elapsed,
                                         'visibility': worker.evaluate(f"chrome.scripting.executeScript({{target:{{tabId:{tab_id}}},func:()=>document.visibilityState}})")})
                # 新能力必须经正式 MCP 参数校验及实际扩展执行，不能只测页面函数。
                tool('browser_navigate', {'tabId': tab_id, 'url': base + 'lazy?mode=finite'})
                page.wait_for_url('**/lazy?mode=finite')
                page.locator('article').first.wait_for()
                selected = worker.evaluate('chrome.tabs.query({active:true})')
                loaded = tool('browser_snapshot', {'tabId': tab_id})
                assert page.locator('article').count() == 18
                assert loaded['loading']['stopReason'] == 'bottom-stable'
                assert '已加载全部18个航班' in loaded['loading']['end']['textTail']
                assert any('F018' in item['context'] for item in loaded['loading']['observed'])
                assert page.evaluate('scrollY') == 0
                tool('browser_scroll', {'tabId': tab_id, 'direction': 'bottom'})
                snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                last = [item for item in snap['elements'] if item['tag'] == 'button'][-1]
                assert 'F018' in last['context']
                rejected = tool('browser_click', {'tabId': tab_id, 'ref': last['ref'], 'expectedContext': 'F001'}, allow_error=True)
                assert '不符' in rejected['error']
                assert page.locator('output').inner_text() == ''
                clicked = tool('browser_click', {'tabId': tab_id, 'ref': last['ref'], 'expectedContext': 'F018'})
                assert clicked['outcome'] == 'unverified' and 'F018' in clicked['target']['context']
                assert page.locator('output').inner_text() == '航班 F018'
                snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                expanded = [item for item in snap['elements'] if item['expanded'] == 'true']
                assert len(expanded) == 1 and 'F018' in expanded[0]['context']
                assert [tab['id'] for tab in selected] == [tab['id'] for tab in worker.evaluate('chrome.tabs.query({active:true})')]
                report['checks'].append({'name': 'MCP默认懒加载到18项；后台滚动、上下文错配拒绝、正确末项点击及同航班展开回读', 'passed': True})
                tool('browser_release', {'tabId': tab_id})
                assert '已释放' in tool('browser_snapshot', {'tabId': tab_id}, allow_error=True)['error']
                report['checks'].append({'name': '自动授权下释放仍生效', 'passed': True})
                worker.evaluate("handlePopup({type:'disconnect'})")
                assert worker.evaluate("chrome.storage.local.get('disconnected')")['disconnected'] is True
            finally:
                context.close()
            # 正向验证 captureVisibleTab 的实际执行。仅该临时夹具赋予 all_urls；
            # 正式清单保持 HTTP(S) + activeTab，不借测试扩大产品权限。
            manifest['host_permissions'] = ['<all_urls>']
            (extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            context = p.chromium.launch_persistent_context(str(folder / 'screenshot-profile'), channel='msedge', headless=True,
                args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'], ignore_default_args=['--disable-extensions'])
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate("async()=>{for(let i=0;i<100&&typeof handlePopup!=='function';i++)await new Promise(r=>setTimeout(r,25))}")
                page = context.pages[0]
                page.goto(base)
                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:false})")
                worker.evaluate("handlePopup({type:'set_screenshot_cdp_enabled',enabled:false})")
                worker.evaluate("handlePopup({type:'connect'})")
                page.wait_for_timeout(150)
                target = next(tab for tab in tool('browser_list_tabs') if tab['url'] == base)
                capture = tool('browser_screenshot', {'tabId': target['id']})
                assert capture['mimeType'] == 'image/png'
                assert worker.evaluate('attached.size') == 0
                report['checks'].append({'name': 'captureVisibleTab 实际截图（仅正向夹具授予 all_urls）', 'passed': True,
                    'limitation': '本自动化夹具不模拟用户授予 activeTab；日常 Edge 的真实授权验收独立保存在 live-edge-acceptance.json。'})
                worker.evaluate("handlePopup({type:'disconnect'})")
            finally:
                context.close()
        report['result'] = 'passed' if all(item['passed'] for item in report['checks']) else 'needs-fix'
except BaseException as error:
    report['result'] = 'failed'
    report['error'] = str(error)
    raise
finally:
    server.shutdown()
    for process in [mcp, bridge]:
        if process:
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
    (OUT / 'browser-extension-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
