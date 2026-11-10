"""真实 Edge MV3 扩展 + 临时桥 + MCP stdio 集成验收。
仅使用临时浏览器配置及本地测试页面；不接触用户的桥、标签页或授权配置。
"""
import base64
from concurrent.futures import ThreadPoolExecutor
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
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa'
OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'result': 'running'}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'test-page'), **kwargs)

    def do_GET(self):
        if self.path.startswith('/interactions'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write((ROOT / 'tests' / 'fixtures' / 'interactions.html').read_bytes())
        elif self.path.startswith('/lazy'):
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

        # 本文件验证手动桥重启；自动监督在browser-lifecycle.py独立验证。
        mcp = subprocess.Popen(['node', 'server/mcp.mjs', '--host', 'localhost', '--port', str(port)], cwd=ROOT,
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
                shutil.copy2(folder / 'bridge' / 'bridge.log', OUT / 'integration-failure-bridge.log')
                if name == 'browser_drag':
                    (OUT / 'integration-failure-extension.json').write_text(json.dumps(worker.evaluate('diagnosticLog'), ensure_ascii=False, indent=2), encoding='utf-8')
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
                active_before_open = [t['id'] for t in worker.evaluate('chrome.tabs.query({active:true})')]
                focus_before_open = {w['id']: w['focused'] for w in worker.evaluate('chrome.windows.getAll()')}
                worker.evaluate("()=>{globalThis.qaTabActivations=[];chrome.tabs.onActivated.addListener(info=>qaTabActivations.push(info.tabId))}")
                opened = tool('browser_open', {'url': base + '?background-open=1', 'tabId': tab_id, 'taskId': 'background-test', 'taskName': '后台打开验收'})
                assert opened['active'] is False and opened['requestedActive'] is False
                assert opened['windowFocusedBefore'] == focus_before_open[opened['windowId']]
                assert opened['windowFocusedAfter'] == focus_before_open[opened['windowId']]
                assert worker.evaluate(f'chrome.tabs.get({opened["tabId"]})')['active'] is False
                assert [t['id'] for t in worker.evaluate('chrome.tabs.query({active:true})')] == active_before_open
                assert {w['id']: w['focused'] for w in worker.evaluate('chrome.windows.getAll()')} == focus_before_open
                assert worker.evaluate('qaTabActivations') == []
                assert 'Magpie' in tool('browser_snapshot', {'tabId': opened['tabId'], 'load': 'current'})['title']
                opened_default = tool('browser_open', {'url': base + '?background-open=2', 'taskId': 'background-test', 'taskName': '后台打开验收'})
                assert opened_default['windowId'] == opened['windowId'] and opened_default['active'] is False
                assert worker.evaluate('qaTabActivations') == []
                worker.evaluate(f'chrome.tabs.remove([{opened["tabId"]},{opened_default["tabId"]}])')
                report['checks'].append({'name': '指定网址后台分组，20工具链路读取成功，原选中页与窗口focused状态不变且无onActivated事件', 'passed': True})
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
                tool('browser_navigate', {'tabId': tab_id, 'url': base + 'interactions'})
                page.wait_for_url('**/interactions')

                def pick(name, role=None):
                    current = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                    matches = [e for e in current['elements'] if e['name'] == name and (role is None or e['role'] == role)]
                    assert len(matches) == 1, (name, matches)
                    return matches[0]['ref']

                hover = tool('browser_hover', {'tabId': tab_id, 'ref': pick('悬停菜单')})
                assert hover['outcome'] == 'unverified' and hover['cssHover'] is False
                assert tool('browser_wait', {'tabId': tab_id, 'name': '悬停选项', 'role': 'menuitem', 'timeoutMs': 1000})['matched']
                assert page.locator('#hovermenu').is_visible()
                portal_trigger = pick('跨容器悬停菜单')
                portal_hover = tool('browser_hover', {'tabId': tab_id, 'ref': portal_trigger})
                assert portal_hover['cursorHeld']
                before_menu_click = tool('browser_inspect', {'tabId': tab_id, 'ref': portal_trigger})
                assert abs(before_menu_click['cursor']['position']['x'] - (before_menu_click['rect']['x'] + before_menu_click['rect']['width'] / 2)) < 2
                assert abs(before_menu_click['cursor']['position']['y'] - (before_menu_click['rect']['y'] + before_menu_click['rect']['height'] / 2)) < 2
                page.wait_for_timeout(11050)
                after_idle = tool('browser_inspect', {'tabId': tab_id, 'ref': portal_trigger})
                assert page.locator('#portalMenu').is_visible()
                assert after_idle['cursor']['held'] and after_idle['cursor']['visible']
                assert after_idle['cursor']['position'] == before_menu_click['cursor']['position']
                page.screenshot(path=str(OUT / 'hover-menu-held-after-11s.png'))
                portal_option = pick('跨容器选项', 'menuitem')
                tool('browser_click', {'tabId': tab_id, 'ref': portal_option})
                assert page.locator('#result').inner_text() == '跨容器选择成功'
                assert page.evaluate('menuEvents')[-3:] == ['trigger-leave', 'option-enter', 'option-click']
                portal_after = tool('browser_inspect', {'tabId': tab_id, 'ref': portal_option})
                assert portal_after['cursor']['held'] is False
                report['checks'].append({'name': '悬停菜单与光标停留11秒不消失；跨容器点击前DOM悬停进入选项，关闭后解除保持', 'passed': True})
                tool('browser_hover', {'tabId': tab_id, 'ref': pick('无语义菜单')})
                assert tool('browser_wait', {'tabId': tab_id, 'name': '普通列表菜单项', 'timeoutMs': 1000})['matched']
                page.evaluate("""()=>{let noise=document.createElement('div');noise.id='noise';noise.innerHTML=Array(180).fill('<button style="position:fixed;left:1098px;top:798px;width:1px;height:1px;padding:0;margin:0">干扰按钮</button>').join('');document.body.prepend(noise)}""")
                plain_snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                assert plain_snap['coverage']['selectionPriority'] == 'popup-then-viewport'
                plain_item = next(e for e in plain_snap['elements'] if e['name'] == '普通列表菜单项')
                assert plain_item['inPopup'] and plain_item['tag'] == 'li'
                assert any(e['name'] == '自绘菜单项' and e['inPopup'] for e in plain_snap['elements'])
                tool('browser_click', {'tabId': tab_id, 'ref': plain_item['ref']})
                assert page.locator('#result').inner_text() == '普通列表菜单项'
                page.evaluate("document.getElementById('noise').remove()")
                tool('browser_hover', {'tabId': tab_id, 'ref': pick('无语义菜单')})
                controlled = tool('browser_inspect', {'tabId': tab_id, 'ref': pick('无语义菜单')})
                assert controlled['popups'][0]['visible'] and controlled['popups'][0]['itemCount'] >= 3
                page.evaluate("document.getElementById('plainmenu').hidden=true")
                report['checks'].append({'name': '关联弹层无role的li/div菜单项可wait/snapshot/inspect/click，180个可见控件下优先保留菜单项', 'passed': True})
                tool('browser_hover', {'tabId': tab_id, 'ref': pick('CSS菜单')})
                assert page.locator('.cssmenu').is_hidden(), 'DOM不能伪装支持CSS hover'
                assert tool('browser_wait', {'tabId': tab_id, 'text': '不存在的菜单', 'timeoutMs': 100})['timedOut']
                tool('browser_click', {'tabId': tab_id, 'ref': pick('右键菜单'), 'button': 'right'})
                assert page.locator('#result').inner_text() == '右键已展开'
                tool('browser_click', {'tabId': tab_id, 'ref': pick('双击菜单'), 'clickCount': 2})
                assert page.locator('#result').inner_text() == '双击已展开'
                tool('browser_click', {'tabId': tab_id, 'ref': pick('长按菜单'), 'holdMs': 250})
                assert page.locator('#result').inner_text() == '长按已展开'
                assert page.evaluate('counts.holdClick') == 0
                tool('browser_focus', {'tabId': tab_id, 'ref': pick('键盘菜单')})
                assert page.locator('#key').evaluate('(e)=>e===document.activeElement')
                tool('browser_press', {'tabId': tab_id, 'ref': pick('键盘菜单'), 'key': 'Alt+ArrowDown'})
                assert page.locator('#keymenu').is_visible()
                tool('browser_press', {'tabId': tab_id, 'ref': pick('焦点下一项'), 'key': 'Shift+Tab'})
                assert page.locator('#key').evaluate('(e)=>e===document.activeElement')
                tool('browser_click', {'tabId': tab_id, 'ref': pick('分裂创建'), 'position': {'x': .85, 'y': .5}})
                assert page.locator('#splitmenu').is_visible() and page.evaluate('counts.main') == 0
                options = tool('browser_inspect', {'tabId': tab_id, 'ref': pick('原生选择')})
                assert any(o['value'] == 'b' for o in options['options'])
                assert tool('browser_select', {'tabId': tab_id, 'ref': pick('原生选择'), 'values': ['b']})['verified']
                assert page.locator('#select').input_value() == 'b'
                assert tool('browser_select', {'tabId': tab_id, 'ref': pick('原生多选'), 'values': ['a', 'b']})['verified']
                assert page.locator('#multi').evaluate('(e)=>[...e.selectedOptions].length') == 2
                assert tool('browser_set_checked', {'tabId': tab_id, 'ref': pick('勾选控件'), 'checked': True})['verified']
                assert tool('browser_set_checked', {'tabId': tab_id, 'ref': pick('勾选控件'), 'checked': True})['changed'] is False
                assert page.locator('#check').is_checked() and page.evaluate('counts.check') == 1
                assert tool('browser_set_checked', {'tabId': tab_id, 'ref': pick('自绘开关'), 'checked': True})['verified']
                blocked = tool('browser_inspect', {'tabId': tab_id, 'ref': pick('禁用按钮')})
                assert blocked['disabled'] and blocked['busy']
                assert tool('browser_inspect', {'tabId': tab_id, 'ref': pick('被遮挡按钮')})['obscured']
                denied = tool('browser_click', {'tabId': tab_id, 'ref': pick('被遮挡按钮')}, allow_error=True)
                assert '遮挡' in denied['error']
                snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                drag_refs = {e['name']: e['ref'] for e in snap['elements']}
                tool('browser_drag', {'tabId': tab_id, 'fromRef': drag_refs['HTML拖动源'], 'toRef': drag_refs['放置区域']})
                assert page.evaluate('counts.drop') == 1
                report['checks'].append({'name': 'DOM悬停/右键/双击/长按/分裂箭头/焦点组合键/原生选择/幂等勾选/状态等待/HTML5拖放真实副作用', 'passed': True})

                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:true})")
                tool('browser_hover', {'tabId': tab_id, 'ref': pick('CSS菜单')})
                assert page.locator('.cssmenu').is_visible()
                tool('browser_press', {'tabId': tab_id, 'ref': pick('键盘菜单'), 'key': 'Alt+ArrowDown'})
                snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                drag_refs = {e['name']: e['ref'] for e in snap['elements']}
                tool('browser_drag', {'tabId': tab_id, 'fromRef': drag_refs['指针拖动源'], 'toRef': drag_refs['指针放置区域']})
                assert page.evaluate('counts.pointerDrop') == 1
                active_after = [tab['id'] for tab in worker.evaluate('chrome.tabs.query({active:true})')]
                assert [tab['id'] for tab in selected] == active_after
                worker.evaluate("handlePopup({type:'set_cdp_enabled',enabled:false})")
                report['checks'].append({'name': 'CDP真实CSS悬停/修饰键/指针拖拽，后台选中标签不变', 'passed': True})
                # 模拟真实Chrome API Promise悬挂：不会阻塞worker事件循环，仍可打开弹窗/重连。
                tool('browser_navigate', {'tabId': tab_id, 'url': base})
                page.wait_for_url(base)
                page.locator('#count').wait_for()
                snap = tool('browser_snapshot', {'tabId': tab_id, 'load': 'current'})
                button = next(item['ref'] for item in snap['elements'] if item['name'] == '记录一次')
                worker.evaluate("""() => {
                  globalThis.qaScriptOriginal=chrome.scripting.executeScript;
                  chrome.scripting.executeScript=spec=>spec.args?.[0]==='prepare'&&!globalThis.qaHungEntered
                    ?new Promise(done=>{globalThis.qaHungEntered=true;globalThis.qaResume=()=>done(qaScriptOriginal(spec))})
                    :qaScriptOriginal(spec);
                }""")
                with ThreadPoolExecutor(max_workers=1) as pool:
                    hung = pool.submit(tool, 'browser_click', {'tabId': tab_id, 'ref': button}, True)
                    worker.evaluate("async()=>{for(let i=0;i<100&&!globalThis.qaHungEntered;i++)await new Promise(r=>setTimeout(r,20));if(!qaHungEntered)throw new Error('未进入悬挂fixture')}")
                    worker.evaluate("handlePopup({type:'disconnect'})")
                    assert worker.evaluate("handlePopup({type:'popup_status'})")['connected'] is False
                    worker.evaluate("handlePopup({type:'connect'})")
                    failed = hung.result(timeout=20)
                    assert 'error' in failed
                assert next(tab for tab in tool('browser_list_tabs') if tab['id'] == tab_id)
                worker.evaluate('qaResume()')
                page.wait_for_timeout(200)
                assert page.locator('#count').inner_text() == '0', '迟到定位不能继续点击'
                assert worker.evaluate("handlePopup({type:'popup_status'})")['connected'] is True
                worker.evaluate('() => { chrome.scripting.executeScript=qaScriptOriginal; }')
                report['checks'].append({'name': '真实Chrome API悬挂后手动重连恢复poll，迟到prepare不点击', 'passed': True})
                diagnostics = worker.evaluate("""async()=>{
                  flushDiagnostics();
                  for(let i=0;i<10&&diagnosticSending;i++)await diagnosticSending;
                  await new Promise(r=>setTimeout(r,250));
                  return (await chrome.storage.local.get('diagnosticLog')).diagnosticLog;
                }""")
                timeout = next(e for e in reversed(diagnostics) if e['event'] == 'command_end' and e.get('phase') == 'prepare' and e.get('outcome') == 'timeout')
                lines = []
                for suffix in ['', '.1', '.2']:
                    log = folder / 'bridge' / ('bridge.log' + suffix)
                    if log.exists():
                        assert log.stat().st_size <= 1024 * 1024
                        lines.extend(json.loads(line) for line in log.read_text(encoding='utf-8').splitlines())
                assert any(e['event'] == 'command_deliver' and e['id'] == timeout['commandId'] for e in lines)
                assert any(e['event'] == 'extension_event' and e['diagnostic'].get('commandId') == timeout['commandId'] and e['diagnostic'].get('outcome') == 'timeout' for e in lines)
                status = tool('browser_status')
                assert status['version'] == manifest['version'] == status['extensionVersion'] == '0.12.0'
                assert len(diagnostics) <= 128 and len(json.dumps(diagnostics)) <= 65536
                (OUT / 'diagnostics-real-edge.json').write_text(json.dumps({'status': status, 'timeout': timeout, 'events': lines}, ensure_ascii=False, indent=2), encoding='utf-8')
                report['checks'].append({'name': '真实Edge诊断跨命令ID关联派发/悬挂prepare/超时、存储有界、桥与扩展版本0.12.0一致', 'passed': True})

                # 停止临时桥模拟网络中断；独立弹窗必须变为异常/正在连接，并自动恢复。
                popup = context.new_page()
                popup.goto(f"chrome-extension://{worker.url.split('/')[2]}/popup.html")
                expect(popup.locator('#status-text')).to_have_text('已连接', timeout=10000)
                bridge.communicate(timeout=5)
                expect(popup.locator('#status-text')).not_to_have_text('已连接', timeout=10000)
                popup.screenshot(path=str(OUT / 'popup-real-bridge-disconnected.png'))
                restart_script = script.replace('port:0,', f'port:{port},')
                bridge = subprocess.Popen(['node', '--input-type=module', '-e', restart_script, str(folder / 'bridge')], cwd=ROOT,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
                assert json.loads(bridge.stdout.readline())['port'] == port
                expect(popup.locator('#status-text')).to_have_text('已连接', timeout=25000)
                assert next(tab for tab in tool('browser_list_tabs') if tab['id'] == tab_id)
                worker.evaluate("async()=>{flushDiagnostics();for(let i=0;i<10&&diagnosticSending;i++)await diagnosticSending}")
                recovered_log = (folder / 'bridge' / 'bridge.log').read_text(encoding='utf-8')
                assert 'transport_error' in recovered_log or 'status_failed' in recovered_log
                popup.close()
                report['checks'].append({'name': '真实桥中断弹窗不再假连接，同端口桥重启自动恢复及MCP列页', 'passed': True})
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
