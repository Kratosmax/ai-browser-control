"""本地 UI 验收：复用已安装的 Python Playwright 和 Edge，不控制用户的浏览器配置。
运行：python tests/browser-ui.py；证据写入 temp/qa/。
"""
import base64
import io
import json
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf-8')
OUT = ROOT / 'temp' / 'qa'
OUT.mkdir(parents=True, exist_ok=True)
BASELINE = 'eb2c5ce384c4d9f5329d7c3770f44e7fa4a04385'
FIXTURE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地交互验收</title>
<style>body{margin:0;height:2500px;font:16px system-ui;background:#f5f7fb;color:#18202c}
header{position:absolute;top:660px;left:80px}h1{font-size:28px}button,input,[contenteditable]{font:inherit;padding:14px 22px;border-radius:10px;border:1px solid #bac8db;background:white}
#a{position:absolute;top:850px;left:180px}#b{position:absolute;top:1080px;left:740px}
input{position:absolute;top:950px;left:180px;width:330px}#editable{position:absolute;top:1140px;left:180px}output{position:absolute;top:1210px;left:180px}</style>
<header><h1>看见每一次操作</h1><p>本地验收 · 光标、点击与输入 · 不向外部发送数据</p></header>
<button id="a" onclick="document.querySelector('output').textContent=++window.count">左侧操作</button>
<button id="b" onclick="document.querySelector('output').textContent=++window.count">右侧操作</button>
<input id="text" aria-label="测试输入" value="原有内容"><div id="editable" contenteditable="true" aria-label="可编辑区域">可编辑内容</div><output>0</output>
<script>window.count=0;window.events=[];for(const el of document.querySelectorAll('input,[contenteditable]'))for(const name of ['input','change'])el.addEventListener(name,e=>events.push({type:e.type,value:el.value??el.textContent}));</script></html>'''

old_files = {name: subprocess.check_output(['git', 'show', f'{BASELINE}:extension/{name}'], cwd=ROOT)
             for name in ['popup.html', 'popup.css', 'popup.js', 'page-agent.js']}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.split('?')[0]
        if name == '/fixture':
            data, mime = FIXTURE.encode(), 'text/html'
        elif name.startswith('/baseline/') and name.rsplit('/', 1)[-1] in old_files:
            key = name.rsplit('/', 1)[-1]
            data, mime = old_files[key], {'html': 'text/html', 'css': 'text/css', 'js': 'text/javascript'}[key.rsplit('.', 1)[-1]]
        elif name.startswith('/extension/'):
            target = (ROOT / name.lstrip('/')).resolve()
            if not target.is_relative_to(ROOT / 'extension') or not target.is_file():
                self.send_error(404)
                return
            data = target.read_bytes()
            mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript'}.get(target.suffix, 'application/octet-stream')
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'
report = {'baseline': BASELINE, 'browser': {}, 'checks': []}


def check(name, evidence):
    report['checks'].append({'name': name, 'evidence': evidence})


def isolated(page, old=False):
    session = page.context.new_cdp_session(page)
    frame = session.send('Page.getFrameTree')['frameTree']['frame']['id']
    context = session.send('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'ai-browser-local-qa'})['executionContextId']

    def js(expression):
        result = session.send('Runtime.evaluate', {'expression': expression, 'contextId': context, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in result:
            raise AssertionError(result['exceptionDetails'])
        return result['result'].get('value')

    js("globalThis.__qaRoots=[];const originalAttach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(o){const root=originalAttach.call(this,o);__qaRoots.push(root);return root;}")
    if old:
        js(old_files['page-agent.js'].decode('utf-8'))
    else:
        for file in ['cursor.js', 'page-agent.js']:
            js((ROOT / 'extension' / file).read_text(encoding='utf-8'))
    return js


POPUP_STUB = '''
window.fixture={bridgeState:'已连接',connected:true,connecting:false,autoAuthorize:false,cdpEnabled:false,screenshotCdpEnabled:true,cursorHideSec:10,cursorTrailSec:5,bridgePort:17653,authorizedTabIds:[7],revokedTabIds:[]};
window.fixtureTab={id:7,title:'Magpie · 模型路由面板',url:'https://magpie.example.test/dashboard'};
window.requests=[];window.failType=null;window.delay=0;
window.chrome={runtime:{getManifest:()=>({version:'0.9.0'}),sendMessage:async m=>{
  requests.push(m);if(delay)await new Promise(r=>setTimeout(r,delay));
  if(m.type===failType)return {error:{message:'测试：本机桥不可达，请检查端口'}};
  if(m.type==='popup_status')return {result:{...fixture}};
  if(m.type==='connect'){fixture.connected=true;fixture.connecting=false;fixture.bridgeState='已连接';}
  if(m.type==='disconnect'){fixture.connected=false;fixture.connecting=false;fixture.bridgeState='已断开';}
  if(m.type==='set_cdp_enabled')fixture.cdpEnabled=m.enabled;
  if(m.type==='set_screenshot_cdp_enabled')fixture.screenshotCdpEnabled=m.enabled;
  if(m.type==='set_auto_authorize')fixture.autoAuthorize=m.enabled;
  if(m.type==='set_cursor_hide')fixture.cursorHideSec=m.seconds;
  if(m.type==='set_cursor_trail')fixture.cursorTrailSec=m.seconds;
  if(m.type==='set_bridge_port')fixture.bridgePort=m.port;
  if(m.type==='release_tab'){fixture.authorizedTabIds=[];fixture.revokedTabIds=[7];}
  if(m.type==='authorize_tab'){fixture.authorizedTabIds=[7];fixture.revokedTabIds=[];}
  return {result:{...fixture}};
}},tabs:{query:async()=>fixtureTab?[fixtureTab]:[]}};
'''


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        report['browser'] = {'version': browser.version, 'channel': 'msedge', 'headless': True, 'isolatedWorld': True}
        context = browser.new_context(viewport={'width': 1100, 'height': 750}, reduced_motion='no-preference')
        page = context.new_page()

        # 对照旧版，验证已在视口内的目标是否被无故滚到相同坐标。
        coordinates = {}
        for old in [True, False]:
            page.goto(BASE + '/fixture')
            page.evaluate('scrollTo(0,600)')
            page.locator('#b').evaluate("e=>e.style.left='180px'")
            js = isolated(page, old)
            agent = '__zcodeTabAgent' if old else '__aiBrowserPageAgent4'
            snap = js(f'{agent}.snapshot()')
            refs = [item['ref'] for item in snap['elements'] if item['tag'] == 'button']
            points = [js(f'{agent}.prepare({json.dumps(ref)})') for ref in refs]
            coordinates['before' if old else 'after'] = {'points': points, 'scrollY': page.evaluate('scrollY')}
        assert abs(coordinates['before']['points'][0]['y'] - coordinates['before']['points'][1]['y']) < 2
        assert abs(coordinates['after']['points'][0]['y'] - coordinates['after']['points'][1]['y']) > 150
        assert coordinates['after']['scrollY'] == 600
        check('视口内定位不再强制居中', coordinates)
        page.locator('#b').evaluate("e=>e.style.left='740px'")

        # 闭合 Shadow DOM + ISOLATED 世界中，用实际帧循环采样，不用返回值冒充视觉验收。
        samples = js('''(async()=>{await __aiBrowserCursor.show({x:210,y:280});let done=false;const samples=[];
          const work=__aiBrowserCursor.show({x:800,y:500}).then(()=>done=true);
          while(!done){await new Promise(requestAnimationFrame);const m=new DOMMatrixReadOnly(getComputedStyle(__qaRoots[0].getElementById('pointer')).transform);samples.push({x:m.m41,y:m.m42,time:performance.now()});}
          await work;return samples;})()''')
        assert len({round(item['x']) for item in samples}) >= 6, samples
        assert abs(samples[-1]['x'] - 800) < 1
        check('真实 Edge 动画中间帧', samples)
        js('__aiBrowserCursor.show({x:235,y:275})')
        stream = page.context.new_cdp_session(page)
        recorded = []
        recording = True

        def on_frame(frame):
            if not recording:
                return
            recorded.append((frame['metadata'].get('timestamp', 0), base64.b64decode(frame['data'])))
            try:
                stream.send('Page.screencastFrameAck', {'sessionId': frame['sessionId']})
            except Exception:
                if recording:
                    raise

        stream.on('Page.screencastFrame', on_frame)
        stream.send('Page.startScreencast', {'format': 'png', 'maxWidth': 1100, 'maxHeight': 750, 'everyNthFrame': 1})
        page.wait_for_timeout(100)
        for point in [{'x': 795, 'y': 505}, {'x': 235, 'y': 275}]:
            js('__aiBrowserCursor.show(' + json.dumps(point) + ').then(()=>__aiBrowserCursor.click(' + json.dumps(point) + '))')
            page.wait_for_timeout(300)
        recording = False
        stream.remove_listener('Page.screencastFrame', on_frame)
        stream.send('Page.stopScreencast')
        stream.detach()
        assert len(recorded) >= 10, '录屏帧不足，不能作为滑动效果证据'
        frames = [Image.open(io.BytesIO(data)).convert('RGB') for _, data in recorded]
        durations = [max(20, min(300, round((recorded[i+1][0]-recorded[i][0])*1000))) for i in range(len(recorded)-1)] + [300]
        frames[0].save(OUT / 'cursor-motion.gif', save_all=True, append_images=frames[1:], duration=durations, loop=0)
        for index, frame in enumerate(frames):
            frame.save(OUT / f'motion-{index:02}.png')
        check('浏览器实际录屏帧', {'frames': len(recorded), 'durationMs': sum(durations)})
        page.screenshot(path=str(OUT / 'cursor-after.png'))

        # 静止后无持续 rAF；默认 10 秒，使用真实计时，包含最后一次点击重置计时。
        js('globalThis.__qaRafCount=0;const oldRaf=requestAnimationFrame;globalThis.requestAnimationFrame=f=>{__qaRafCount++;return oldRaf(f)};')
        js('__aiBrowserCursor.show({x:800,y:500,hideMs:10000}).then(()=>__aiBrowserCursor.click({x:800,y:500,hideMs:10000}))')
        js('globalThis.__idleCount=__qaRafCount')
        page.wait_for_timeout(450)
        assert js('__qaRafCount===__idleCount')
        page.wait_for_timeout(8500)
        assert js("getComputedStyle(__qaRoots[0].getElementById('surface')).opacity") == '1'
        page.wait_for_timeout(1400)
        assert js("getComputedStyle(__qaRoots[0].getElementById('surface')).opacity") == '0'
        check('10 秒停留及静止后停止帧循环', {'visibleAtSeconds': 8.95, 'hiddenAtSeconds': 10.35, 'idleRafCount': js('__qaRafCount')})
        js('__aiBrowserCursor.show({x:200,y:200,hideMs:0})')
        page.wait_for_timeout(220)
        assert js("getComputedStyle(__qaRoots[0].getElementById('surface')).opacity") == '0'
        check('0 秒设置实际生效', True)

        # 轨迹与光标独立计时：光标立即隐藏，移动路径保留5秒。
        js('__aiBrowserCursor.hide();__aiBrowserCursor.show({x:120,y:250,hideMs:0,trailMs:0})')
        js('__aiBrowserCursor.show({x:820,y:520,hideMs:0,trailMs:5000}).then(()=>globalThis.__qaTrailEnd=performance.now())')
        page.wait_for_timeout(220)
        assert js("getComputedStyle(__qaRoots[0].getElementById('surface')).opacity") == '0'
        assert js("__qaRoots[0].querySelectorAll('#trails path').length") == 1
        assert js("__qaRoots[0].querySelector('#trails path').getAttribute('d').split('L').length") >= 6
        page.screenshot(path=str(OUT / 'trail-residual.png'))
        page.wait_for_timeout(max(0, 4500 - js('performance.now()-__qaTrailEnd')))
        assert js("__qaRoots[0].querySelectorAll('#trails path').length") == 1
        page.wait_for_timeout(max(0, 5300 - js('performance.now()-__qaTrailEnd')))
        assert js("__qaRoots[0].querySelectorAll('#trails path').length") == 0
        js('__aiBrowserCursor.show({x:200,y:200,hideMs:0,trailMs:0})')
        assert js("__qaRoots[0].querySelectorAll('#trails path').length") == 0
        check('独立轨迹5秒残留、回收及0秒关闭', {'pointerHiddenImmediately': True, 'trailAt4500ms': True, 'removedAt5300ms': True})

        # 模拟后台可见性仅验证调度分支；实际扩展后台标签另由集成验收覆盖。
        elapsed = js("(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});const start=performance.now();const result=await __aiBrowserCursor.show({x:100,y:120});delete document.visibilityState;return {elapsed:performance.now()-start,result};})()")
        assert elapsed['elapsed'] < 50 and elapsed['result']['animated'] is False
        check('后台分支不等待动画（可见性模拟）', elapsed)

        snap = js('__aiBrowserPageAgent4.snapshot()')
        text_ref = next(item['ref'] for item in snap['elements'] if item['name'] == '测试输入')
        result = js('__aiBrowserPageAgent4.domFill(' + json.dumps({'ref': text_ref, 'text': 'DOM 模式输入成功'}) + ')')
        assert result.get('filled')
        assert page.locator('#text').input_value() == 'DOM 模式输入成功'
        assert {item['type'] for item in page.evaluate('events')} == {'input', 'change'}
        button_ref = next(item['ref'] for item in snap['elements'] if item['name'] == '左侧操作')
        js(f'__aiBrowserPageAgent4.domClick({json.dumps(button_ref)})')
        assert page.locator('output').inner_text() == '1'
        check('真实 DOM 填表/点击及 input/change 事件', page.evaluate('events'))

        page.emulate_media(reduced_motion='reduce')
        reduced = js('__aiBrowserCursor.show({x:800,y:500})')
        assert reduced['animated'] is False
        check('遵守系统减少动态效果偏好', reduced)

        # 长列表中的屏内弹窗：DOM 靠后的关闭按钮不能被快照上限挤掉。
        modal_page = context.new_page()
        modal_page.goto(BASE + '/fixture')
        modal_page.evaluate('''() => {
          document.body.innerHTML = Array.from({length:180}, (_,i) =>
            `<button style="position:absolute;top:${2000+i*35}px">航班 ${i}</button>`).join('') +
            '<div role="dialog" style="position:fixed;inset:0;background:#0008;display:grid;place-items:center"><button onclick="this.parentElement.remove()">我知道了</button></div>';
        }''')
        modal_js = isolated(modal_page)
        modal_snap = modal_js('__aiBrowserPageAgent4.snapshot()')
        close_ref = next(item['ref'] for item in modal_snap['elements'] if item['tag'] == 'button' and item['name'] == '我知道了')
        assert len(modal_snap['elements']) == 150
        assert modal_snap['coverage']['selectionPriority'] == 'viewport-first'
        modal_page.screenshot(path=str(OUT / 'viewport-modal.png'))
        modal_js('__aiBrowserPageAgent4.domClick(' + json.dumps(close_ref) + ')')
        assert modal_page.locator('[role=dialog]').count() == 0
        check('180个离屏控件后仍可定位并关闭屏内弹窗', modal_snap['coverage'])
        modal_page.close()

        # 弹窗：使用真实页面、真实 CSS/JS 和受控扩展 API fixture。
        popup = context.new_page()
        popup.set_viewport_size({'width': 368, 'height': 760})
        popup.add_init_script(POPUP_STUB)
        popup.goto(BASE + '/baseline/popup.html')
        popup.locator('#toggle').wait_for(state='visible')
        popup.locator('body').screenshot(path=str(OUT / 'popup-before.png'), animations='disabled')
        popup.goto(BASE + '/extension/popup.html')
        popup.wait_for_function("document.querySelector('#status-text').textContent==='已连接'")
        popup.locator('body').screenshot(path=str(OUT / 'popup-light.png'), animations='disabled')
        assert popup.locator('#release').is_enabled()
        popup.locator('#release').click()
        popup.wait_for_function("document.querySelector('#tab-badge').textContent==='未授权'")
        popup.locator('#authorize').click()
        popup.wait_for_function("document.querySelector('#tab-badge').textContent==='可控制'")
        assert not popup.locator('#cdp-enabled').is_checked()
        assert popup.locator('#screenshot-cdp').is_checked()
        popup.locator('#cdp-enabled').check()
        popup.wait_for_function('fixture.cdpEnabled===true')
        popup.locator('#cdp-enabled').uncheck()
        popup.wait_for_function("document.querySelector('#mode-description').textContent.includes('DOM')")
        assert popup.evaluate('fixture.cdpEnabled') is False
        assert popup.locator('#screenshot-cdp').is_checked()
        popup.locator('#screenshot-cdp').uncheck()
        popup.wait_for_function('fixture.screenshotCdpEnabled===false')
        assert popup.evaluate('fixture.cdpEnabled') is False
        popup.locator('#screenshot-cdp').check()
        popup.wait_for_function('fixture.screenshotCdpEnabled===true')
        check('DOM 默认输入与独立截图开关', True)
        popup.locator('#toggle').click()
        popup.wait_for_function("document.querySelector('#status-text').textContent==='已断开'")
        popup.locator('#toggle').click()
        popup.wait_for_function("document.querySelector('#status-text').textContent==='已连接'")
        check('弹窗连接/断开、授权/释放、CDP 开关', True)
        popup.locator('summary').click()
        popup.locator('#cursor-hide').fill('')
        count_before = popup.evaluate('requests.length')
        popup.locator('#save-hide').click()
        popup.wait_for_function("document.querySelector('#message').textContent.includes('整数秒')")
        assert not any(item['type'] == 'set_cursor_hide' for item in popup.evaluate(f'requests.slice({count_before})'))
        popup.locator('#cursor-hide').fill('10')
        popup.locator('#save-hide').click()
        popup.wait_for_function("document.querySelector('#message').textContent.includes('结束 10 秒')")
        assert popup.locator('#save-hide').is_enabled()
        assert popup.locator('#cursor-trail').input_value() == '5'
        popup.locator('#cursor-trail').fill('60')
        popup.locator('#save-trail').click()
        popup.wait_for_function("document.querySelector('#message').textContent.includes('结束 60 秒')")
        assert popup.evaluate('fixture.cursorTrailSec') == 60
        assert popup.evaluate('fixture.cursorHideSec') == 10
        popup.locator('#cursor-trail').fill('5')
        popup.locator('#save-trail').click()
        popup.wait_for_function("document.querySelector('#message').textContent.includes('结束 5 秒')")
        check('弹窗轨迹设置独立保存、默认5秒及60秒上限', True)
        popup.locator('#bridge-port').fill('17654')
        popup.evaluate("failType='set_bridge_port'")
        popup.locator('#save-port').click()
        popup.wait_for_function("document.querySelector('#message').classList.contains('error')")
        popup.locator('body').screenshot(path=str(OUT / 'popup-error.png'), animations='disabled')
        popup.evaluate("failType=null;fixtureTab.title='超长标题与路径'.repeat(28);fixtureTab.url='https://very-long-domain-name.example.test/path';fixture.autoAuthorize=true")
        popup.wait_for_timeout(2100)
        assert popup.evaluate('document.documentElement.scrollWidth') <= 368
        popup.locator('body').screenshot(path=str(OUT / 'popup-settings-long.png'), animations='disabled')
        popup.evaluate("fixtureTab={id:7,title:'扩展管理',url:'edge://extensions'}")
        popup.wait_for_timeout(2100)
        assert popup.locator('#authorize').is_disabled()
        popup.locator('body').screenshot(path=str(OUT / 'popup-unsupported.png'), animations='disabled')
        check('空值校验、错误恢复、长标题、系统页禁用', True)
        popup.goto(BASE + '/extension/popup.html')
        popup.emulate_media(color_scheme='dark')
        popup.wait_for_function("document.querySelector('#status-text').textContent==='已连接'")
        popup.locator('body').screenshot(path=str(OUT / 'popup-dark.png'), animations='disabled')
        dark = browser.new_context(viewport={'width': 368, 'height': 760}, device_scale_factor=2)
        high = dark.new_page()
        high.add_init_script(POPUP_STUB)
        high.goto(BASE + '/extension/popup.html')
        high.wait_for_function("document.querySelector('#status-text').textContent==='已连接'")
        assert high.evaluate('document.documentElement.scrollWidth') <= 368
        high.locator('body').screenshot(path=str(OUT / 'popup-2x.png'), animations='disabled')
        check('深色及 200% DPI 排版', True)
        browser.close()

    before = Image.open(OUT / 'popup-before.png').convert('RGB')
    after = Image.open(OUT / 'popup-light.png').convert('RGB')
    compare = Image.new('RGB', (before.width + after.width + 48, max(before.height, after.height) + 48), '#e8ecf2')
    compare.paste(before, (16, 32))
    compare.paste(after, (before.width + 32, 32))
    ImageDraw.Draw(compare).text((16, 10), 'BEFORE', fill='#334155')
    ImageDraw.Draw(compare).text((before.width + 32, 10), 'AFTER', fill='#334155')
    compare.save(OUT / 'popup-comparison.png')
    report['result'] = 'passed'
    print(json.dumps({'result': report['result'], 'checks': [item['name'] for item in report['checks']], 'evidence': str(OUT)}, ensure_ascii=False, indent=2))
except BaseException as error:
    report['result'] = 'failed'
    report['error'] = str(error)
    raise
finally:
    server.shutdown()
    (OUT / 'browser-ui-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
