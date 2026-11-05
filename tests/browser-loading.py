"""真实 Edge 回归：延迟懒加载、虚拟列表、滚动容器、无限列表与错误目标拦截。"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa'
OUT.mkdir(parents=True, exist_ok=True)
HTML = (ROOT / 'tests' / 'fixtures' / 'loading.html').read_text(encoding='utf-8')


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(HTML.encode())

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
report = {'checks': [], 'result': 'running'}


def agent(page):
    session = page.context.new_cdp_session(page)
    frame = session.send('Page.getFrameTree')['frameTree']['frame']['id']
    world = session.send('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'loading-qa'})['executionContextId']

    def js(code):
        result = session.send('Runtime.evaluate', {'expression': code, 'contextId': world, 'awaitPromise': True, 'returnByValue': True})
        assert 'exceptionDetails' not in result, result
        return result['result'].get('value')

    js((ROOT / 'extension' / 'page-agent.js').read_text(encoding='utf-8'))
    return js


def check(name, **details):
    report['checks'].append({'name': name, 'passed': True, **details})


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page(viewport={'width': 1000, 'height': 700})

        def open_mode(mode):
            page.goto(f'http://127.0.0.1:{server.server_port}/?mode={mode}')
            return agent(page)

        js = open_mode('finite')
        snap = js('__aiBrowserPageAgent4.snapshot()')
        finite_loading = snap['loading']['stopReason']
        assert page.locator('article').count() == 18, snap
        assert snap['loading']['stopReason'] == 'bottom-stable'
        assert snap['loading']['complete'] is False
        assert '已加载全部18个航班' in snap['loading']['end']['textTail']
        assert any('F018' in i['context'] for i in snap['loading']['observed'])
        assert page.evaluate('scrollY') == 0
        js("__aiBrowserPageAgent4.scroll({direction:'bottom'})")
        snap = js("__aiBrowserPageAgent4.snapshot({load:'current'})")
        last = [i for i in snap['elements'] if i['tag'] == 'button'][-1]
        assert 'F018' in last['context']
        assert last['requiresExpectedContext']
        blocked = js('__aiBrowserPageAgent4.prepare(' + json.dumps({'ref': last['ref'], 'action': 'click'}) + ')')
        assert 'expectedContext' in blocked['__zcodeError']
        point = js('__aiBrowserPageAgent4.prepare(' + json.dumps({'ref': last['ref'], 'action': 'click', 'expectedContext': 'F018'}) + ')')
        assert point.get('target', {}).get('context') == last['context'], point
        js('__aiBrowserPageAgent4.domClick(' + json.dumps(last['ref']) + ')')
        assert page.locator('output').inner_text() == '航班 F018'
        after = js("__aiBrowserPageAgent4.snapshot({load:'current'})")
        expanded = [i for i in after['elements'] if i['expanded'] == 'true']
        assert len(expanded) == 1 and 'F018' in expanded[0]['context']
        page.screenshot(path=str(OUT / 'lazy-last-verified.png'))
        check('延迟650毫秒分批加载6→12→18，定位真正末项并核对同一航班展开', loading=finite_loading, flight='F018')

        js = open_mode('virtual')
        snap = js('__aiBrowserPageAgent4.snapshot()')
        seen = json.dumps(snap['loading']['observed'])
        assert 'F001' in seen and 'F030' in seen, snap['loading']
        assert page.locator('article').count() == 5
        assert snap['loading']['restoredScroll']
        js("__aiBrowserPageAgent4.scroll({direction:'bottom'})")
        snap = js("__aiBrowserPageAgent4.snapshot({load:'current'})")
        last = [i for i in snap['elements'] if i['tag'] == 'button'][-1]
        assert 'F030' in last['context']
        # 同一个 DOM 节点在 snapshot 后被复用成另一班，位置和“订票”文字不变。
        page.locator('article').last.locator('span').evaluate("e=>e.textContent='航班 WRONG'")
        result = js('__aiBrowserPageAgent4.prepare(' + json.dumps({'ref': last['ref'], 'expectedContext': 'F030'}) + ')')
        assert '身份已变化' in result['__zcodeError'], result
        result = js('__aiBrowserPageAgent4.domClick(' + json.dumps(last['ref']) + ')')
        assert '身份已变化' in result['__zcodeError']
        assert page.locator('output').inner_text() == ''
        check('固定5个DOM节点的30项虚拟列表累计观察；复用错误航班节点时阻止点击')

        # prepare 内部滚动期间才发生节点复用，也必须在实际点击之前发现。
        snap = js("__aiBrowserPageAgent4.snapshot({load:'current'})")
        target = [i for i in snap['elements'] if i['tag'] == 'button'][-1]
        js("document.querySelector('article:last-child button').scrollIntoView=function(){this.previousElementSibling.textContent='航班 CHANGED-DURING-SCROLL'}")
        result = js('__aiBrowserPageAgent4.prepare(' + json.dumps({'ref': target['ref'], 'expectedContext': 'WRONG'}) + ')')
        assert '身份已变化' in result['__zcodeError']
        assert page.locator('output').inner_text() == ''
        check('定位滚动内部才发生身份变化时，在点击前拦截')

        # 没有 article/row 语义的 div 卡片，不能把所有航班并入每个按钮上下文。
        js = open_mode('nested')
        page.evaluate('''() => {
          document.body.innerHTML='<div class="list">'+[1,2,3].map(i=>
            `<div class="card"><div class="header"><div>航班 DIV00${i} 广州 哈尔滨</div><div class="price">¥1100 <button>订票</button></div></div></div>`).join('')+'</div>';
        }''')
        snap = js("__aiBrowserPageAgent4.snapshot({load:'current'})")
        cards = [i for i in snap['elements'] if i['tag'] == 'button']
        assert len(cards) == 3
        for i, card in enumerate(cards, 1):
            assert 'DIV00'+str(i) in card['context']
            assert sum('DIV00'+str(n) in card['context'] for n in [1,2,3]) == 1
        result = js('__aiBrowserPageAgent4.prepare(' + json.dumps({'ref': cards[1]['ref'], 'expectedContext': 'DIV001', 'action': 'click'}) + ')')
        assert '不符' in result['__zcodeError'], result
        check('普通div卡片上下文不跨越相邻航班，错误航班号拒绝')

        js = open_mode('nested')
        snap = js('__aiBrowserPageAgent4.snapshot()')
        assert any('F010' in i['context'] for i in snap['loading']['observed'])
        assert page.locator('#nested').evaluate('e=>e.scrollTop') == 0
        assert snap['loading']['stopReason'] == 'bottom-stable'
        check('主文档不滚动时遍历独立滚动容器，恢复原位置')

        js = open_mode('modal')
        snap = js('__aiBrowserPageAgent4.snapshot()')
        assert snap['loading']['stopReason'] == 'blocked-by-dialog'
        assert page.evaluate('scrollY') == 0
        check('弹窗挡住列表时返回阻塞，不盲目滚动')

        js = open_mode('infinite')
        snap = js('__aiBrowserPageAgent4.snapshot()')
        assert snap['loading']['stopReason'] in ['time-budget', 'step-budget'], snap['loading']
        assert snap['loading']['complete'] is False
        assert snap['coverage']['dataCompleteness'] == 'unknown'
        assert snap['loading']['elapsedMs'] < 11000
        check('无限列表到预算停止并标记未确认完整', loading=snap['loading']['stopReason'], elapsedMs=snap['loading']['elapsedMs'])
        browser.close()
    report['result'] = 'passed'
except BaseException as error:
    report.update(result='failed', error=str(error))
    raise
finally:
    server.shutdown()
    (OUT / 'browser-loading-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
