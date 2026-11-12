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
OUT = ROOT / 'temp' / 'qa' / 'v0161'
VERSION = json.loads((ROOT / '.zcode-plugin' / 'plugin.json').read_text(encoding='utf-8'))['version']
OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'result': 'running'}
HTML = '''<!doctype html><meta charset="utf-8"><title>任务生命周期验收</title>
<style>body{font:20px system-ui;background:#eef4ff;padding:50px}button,input{font:inherit;padding:12px;margin:12px}</style>
<h1>任务生命周期验收</h1><button onclick="document.querySelector('output').textContent=++window.count">增加计数</button>
<input aria-label="备注" value=""><select aria-label="默认选择"><option>默认</option><option>其他</option></select>
<output>0</output><script>window.count=0;</script>
<form id="key-form"><input type="button" aria-label="普通操作" value="普通操作">
<input type="submit" aria-label="指定提交" value="指定提交" name="action" formaction="/selected"></form>
<script>window.formEvents={clicks:0,submits:0,submitter:null};
document.querySelector('input[type=button]').onclick=()=>formEvents.clicks++;
document.querySelector('form').onsubmit=e=>{e.preventDefault();formEvents.submits++;formEvents.submitter=e.submitter?.name;};</script>'''


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
        assert first['version'] == VERSION
        report['checks'].append({'name': 'MCP启动后无任何工具调用即启动桥', 'passed': True})
        sequence = 0

        def tool(name, args=None, error=False, raw=False):
            global sequence
            sequence += 1
            mcp.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': 'tools/call',
                'params': {'name': name, 'arguments': args or {}}}) + '\n')
            mcp.stdin.flush()
            while True:
                message = json.loads(mcp.stdout.readline())
                if message.get('id') == sequence:
                    result = message['result']
                    break
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
                before_mcp = tool('browser_status')
                restarted = tool('browser_restart')
                after_mcp = tool('browser_status')
                assert restarted['restart'] is True
                assert before_mcp['mcpPid'] != after_mcp['mcpPid']
                assert after_mcp['mcpGeneration'] > before_mcp['mcpGeneration']
                assert after_mcp['mcpVersion'] == VERSION and after_mcp['connected']
                assert len(starts()) == 1, 'MCP重载不替换共享桥'
                report['checks'].append({'name': '同一stdio连接重载MCP，实际worker更换、版本可核对且共享桥/扩展保持连接', 'passed': True})
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

                # 页面缺代理：实际async外层捕获应返回明确code，不再折叠为null或猜遮挡。
                probe = tool('browser_open', {'url': base + '?rpc-probe', 'taskId': 'qa-rpc', 'taskName': 'RPC诊断'})
                worker.evaluate("()=>{globalThis.qaRpcOriginal=chrome.scripting.executeScript;chrome.scripting.executeScript=spec=>qaRpcOriginal(spec.files?{...spec,files:['cursor.js']}:spec)}")
                try:
                    missing_agent = tool('browser_snapshot', {'tabId': probe['tabId'], 'load': 'current'}, error=True)
                    detail = missing_agent['structuredContent']['error']
                    assert detail['code'] == 'PAGE_AGENT_NOT_READY' and detail['diagnostic']['agentPresent'] is False
                    assert detail['diagnostic']['transportKind'] == 'envelope' and detail['commandId']
                finally:
                    worker.evaluate('()=>{chrome.scripting.executeScript=qaRpcOriginal}')
                report['checks'].append({'name': '真实页面缺代理被外层RPC捕获为NOT_READY，命令ID和无敏感诊断经桥/MCP返回', 'passed': True})

                # Chrome顶层异常的真实回传行为：故意在边界外抛错，空null被准确记录且不自动重放。
                worker.evaluate("()=>{globalThis.qaRpcCount=0;chrome.scripting.executeScript=spec=>{if(spec.args?.[0]==='snapshot'){qaRpcCount++;return qaRpcOriginal({...spec,func:()=>{throw new Error('fixture outer failure')}})}return qaRpcOriginal(spec)}}")
                try:
                    null_result = tool('browser_snapshot', {'tabId': probe['tabId'], 'load': 'current'}, error=True)
                    detail = null_result['structuredContent']['error']
                    assert detail['code'] == 'PAGE_AGENT_EMPTY_RESULT' and detail['diagnostic']['resultKind'] == 'null'
                    assert detail['diagnostic']['stage'] == 'decode' and detail['commandId']
                    assert worker.evaluate('qaRpcCount') == 1
                    assert '遮挡' not in detail['message']
                finally:
                    worker.evaluate('()=>{chrome.scripting.executeScript=qaRpcOriginal}')
                assert '任务生命周期验收' in tool('browser_snapshot', {'tabId': probe['tabId'], 'load': 'current'})['title']
                tool('browser_task', {'taskId': 'qa-rpc', 'action': 'finish'})
                report['checks'].append({'name': '真实Chrome顶层异常null被准确报告而非误报遮挡，失败一次不重放，恢复对照正常', 'passed': True})

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

                # DOM Enter激活普通按钮，提交时保留实际submitter。
                one_page = until(lambda: next((page for page in context.pages if page.url == base and page != original and page.evaluate('window.count') == 1), None))
                snap = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current'})
                plain = next(item['ref'] for item in snap['elements'] if item['name'] == '普通操作')
                tool('browser_press', {'tabId': one['tabId'], 'ref': plain, 'key': 'Enter', 'mode': 'dom'})
                events = one_page.evaluate('formEvents')
                assert events['clicks'] == 1 and events['submits'] == 0
                snap = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current'})
                submit = next(item['ref'] for item in snap['elements'] if item['name'] == '指定提交')
                tool('browser_press', {'tabId': one['tabId'], 'ref': submit, 'key': 'Enter', 'mode': 'dom'})
                events = one_page.evaluate('formEvents')
                assert events['submits'] == 1 and events['submitter'] == 'action'
                report['checks'].append({'name': '真实DOM Enter普通按钮不误提交，指定提交按钮身份保持', 'passed': True})

                edited = tool('browser_open', {'url': base + '?edited', 'taskId': 'qa-task', 'taskName': '账单核对'})
                def find_edited():
                    original.wait_for_timeout(50)
                    return next((page for page in context.pages if page.url == base + '?edited'), None)
                edited_page = until(find_edited)
                edited_page.wait_for_selector('input')
                edited_page.evaluate("document.querySelector('input').value='未保存内容'")

                # 未超限时cleanup没有结束授权，不应关闭任何页面。
                under_limit = tool('browser_task', {'taskId': 'qa-task', 'action': 'cleanup'})
                assert under_limit['closed'] == []
                report['checks'].append({'name': '未结束且未超限时cleanup不关闭任务页', 'passed': True})

                # 浏览器导航来源识别连带页，openerTabId仅作诊断；移出分组后交还用户。
                worker.evaluate("()=>{globalThis.qaNavigationTargets=[];chrome.webNavigation.onCreatedNavigationTarget.addListener(event=>qaNavigationTargets.push(event))}")
                edited_page.evaluate("window.open(location.origin + '/child', '_blank')")
                def find_child():
                    tabs = tool('browser_list_tabs')
                    report['childObservation'] = {'tabs': tabs, 'raw': worker.evaluate('chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,openerTabId:x.openerTabId,groupId:x.groupId})))'),
                        'managed': worker.evaluate('[...taskTabs.tabs.values()]'),
                        'navigationTargets': worker.evaluate('qaNavigationTargets')}
                    return next((tab for tab in tabs if tab['url'] == base + 'child' and tab.get('managed')), None)
                child = until(find_child)
                report.pop('childObservation', None)
                assert child['taskId'] == 'qa-task' and child['groupId'] == one['groupId']
                moved = tool('browser_open', {'url': base + '?moved', 'taskId': 'qa-task', 'taskName': '账单核对'})
                worker.evaluate(f"chrome.tabs.ungroup({moved['tabId']})")
                worker.evaluate(f"chrome.tabs.update({edited['tabId']}, {{active: true}})")
                report['checks'].append({'name': '真实导航来源连带页纳入任务分组，移出分组页交还用户', 'passed': True})

                # 大页面：1600个常驻导航项+321个正文按钮，目标不能被首批150截掉。
                one_page.evaluate("""()=>{
                  const root=document.createElement('section');root.id='qa-index';
                  const nav=document.createElement('nav');nav.setAttribute('role','menu');nav.id='qa-permanent-nav';
                  const navToggle=document.createElement('button');navToggle.textContent='常驻导航';navToggle.setAttribute('aria-controls',nav.id);navToggle.setAttribute('aria-expanded','true');
                  for(let i=0;i<1600;i++){const a=document.createElement('a');a.href='#nav'+i;a.textContent='导航'+i;nav.append(a)}
                  const main=document.createElement('main');main.setAttribute('role','main');main.setAttribute('aria-label','分页区域');
                  for(let i=0;i<320;i++){const b=document.createElement('button');b.textContent='正文按钮'+i;main.append(b)}
                  const target=document.createElement('button');target.textContent='下载';target.onclick=()=>window.qaDownloaded=(window.qaDownloaded||0)+1;main.append(target);
                  const menuTrigger=document.createElement('button');menuTrigger.textContent='动作';menuTrigger.setAttribute('aria-haspopup','menu');menuTrigger.setAttribute('aria-controls','qa-aria-menu');
                  const menu=document.createElement('ul');menu.id='qa-aria-menu';menu.setAttribute('role','menu');const item=document.createElement('li');item.setAttribute('role','menuitem');
                  for(const label of ['独立下载','独立删除']){const action=document.createElement('div');action.setAttribute('role','button');action.tabIndex=0;action.textContent=label;item.append(action)}menu.append(item);
                  menu.addEventListener('click',event=>{if(event.target.textContent==='独立下载')window.qaAriaClicked=(window.qaAriaClicked||0)+1});
                  root.append(navToggle,nav,main,menuTrigger,menu);document.body.append(root);
                }""")
                query = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'name': '下载', 'exact': True, 'role': 'button', 'scope': 'main', 'format': 'compact'})
                query_elements = [{**query.get('elementDefaults', {}), **item} for item in query['elements']]
                assert len(query_elements) == 1 and query_elements[0]['name'] == '下载'
                tool('browser_click', {'tabId': one['tabId'], 'ref': query_elements[0]['ref'], 'mode': 'dom'})
                assert one_page.evaluate('qaDownloaded') == 1
                report['checks'].append({'name': '超过150及1600导航不妨碍按名/角色/正文范围查找并实际点击下载，compact保留语义', 'passed': True})
                region = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'name': '分页区域', 'role': 'main', 'exact': True})
                region_ref = region['elements'][0]['ref']
                first_page = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'scopeRef': region_ref, 'role': 'button', 'limit': 150})
                assert first_page['pagination']['total'] == 321 and len(first_page['elements']) == 150
                second_page = tool('browser_snapshot', {'tabId': one['tabId'], 'cursor': first_page['pagination']['nextCursor']})
                assert second_page['pagination']['snapshotId'] == first_page['pagination']['snapshotId']
                first_ref = first_page['elements'][0]['ref']
                assert tool('browser_focus', {'tabId': one['tabId'], 'ref': first_ref})['focused']
                third_page = tool('browser_snapshot', {'tabId': one['tabId'], 'cursor': second_page['pagination']['nextCursor']})
                all_refs = [item['ref'] for batch in [first_page, second_page, third_page] for item in batch['elements']]
                assert len(all_refs) == len(set(all_refs)) == 321 and not third_page['pagination']['hasMore']
                report['checks'].append({'name': '区域ref限定321按钮分三批无重复遗漏，续页后首批ref仍可聚焦', 'passed': True})
                fresh = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'scope': 'main', 'role': 'button'})
                one_page.evaluate("document.querySelector('#qa-index main').append(document.createElement('button'))")
                changed = tool('browser_snapshot', {'tabId': one['tabId'], 'cursor': fresh['pagination']['nextCursor']}, error=True)
                assert changed['structuredContent']['error']['code'] == 'SNAPSHOT_CHANGED'
                nav_query = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'name': '导航0', 'exact': True})
                assert nav_query['elements'] and all(not item['inPopup'] for item in nav_query['elements'])
                aria_query = tool('browser_snapshot', {'tabId': one['tabId'], 'load': 'current', 'name': '独立下载', 'exact': True, 'role': 'button'})
                assert len(aria_query['elements']) == 1 and aria_query['elements'][0]['inPopup']
                tool('browser_click', {'tabId': one['tabId'], 'ref': aria_query['elements'][0]['ref'], 'mode': 'dom'})
                assert one_page.evaluate('qaAriaClicked') == 1
                report['checks'].append({'name': '关联静态导航不误作popup，菜单内两个独立ARIA按钮保留且可实际点击', 'passed': True})
                one_page.evaluate("document.querySelector('#qa-index').remove()")
                report['checks'].append({'name': '分页间候选变化明确拒绝续页，不静默错位或遗漏', 'passed': True})

                # 只结束一个已用完页面，整个账单任务继续。
                completed = tool('browser_open', {'url': base + '?cms-done', 'taskId': 'qa-task', 'taskName': '账单核对'})
                partial = tool('browser_task', {'taskId': 'qa-task', 'action': 'close', 'tabIds': [completed['tabId']]})
                assert partial['closed'] == [completed['tabId']] and partial['closedCount'] == 1
                alive = [tab['id'] for tab in tool('browser_list_tabs')]
                assert completed['tabId'] not in alive and one['tabId'] in alive and two['tabId'] in alive
                assert '任务生命周期验收' in tool('browser_snapshot', {'tabId': two['tabId'], 'load': 'current'})['title']
                report['checks'].append({'name': '按页close实际关闭已完成页，同任务其余页面仍可继续操作', 'passed': True})

                # 模拟旧版创建回执存在、插件归属丢失；证据是本测试持有的真实create回执。
                legacy = worker.evaluate(f"chrome.tabs.create({{url: {json.dumps(base + '?legacy-done')}, active: false}})")
                assert not next(tab for tab in tool('browser_list_tabs') if tab['id'] == legacy['id'])['managed']
                refused = tool('browser_task', {'taskId': 'qa-task', 'action': 'close', 'tabIds': [legacy['id']]})
                assert refused['closedCount'] == 0 and legacy['id'] not in refused['closed']
                adopted = tool('browser_task', {'taskId': 'qa-task', 'taskName': '账单核对', 'action': 'adopt', 'pages': [
                    {'tabId': legacy['id'], 'url': base + '?legacy-done', 'groupId': legacy['groupId'],
                     'evidence': {'kind': 'agent-created', 'reference': '本隔离测试chrome.tabs.create回执tabId=' + str(legacy['id'])}}]})
                current = next(tab for tab in tool('browser_list_tabs') if tab['id'] == legacy['id'])
                assert current['managed'] and current['taskId'] == 'qa-task' and current['groupId'] == one['groupId']
                recovered = tool('browser_task', {'taskId': 'qa-task', 'action': 'close', 'tabIds': [legacy['id']]})
                assert recovered['closed'] == [legacy['id']] and recovered['closedCount'] == 1
                assert legacy['id'] not in [tab['id'] for tab in tool('browser_list_tabs')]
                assert original_id in [tab['id'] for tab in tool('browser_list_tabs')]
                report['checks'].append({'name': '未登记页零关闭不假报成功；真实创建回执补登记后实际关闭，用户原页保留', 'passed': True})

                # finish明确表示操作结束，允许关闭活动/已编辑页；keep交付页保留。
                finished = tool('browser_task', {'taskId': 'qa-task', 'action': 'finish', 'keepTabIds': [one['tabId']]})
                assert two['tabId'] in finished['closed'] and one['tabId'] in finished['remaining']
                assert edited['tabId'] in finished['closed'] and child['id'] in finished['closed']
                assert moved['tabId'] not in finished['closed']
                alive = [tab['id'] for tab in tool('browser_list_tabs')]
                assert original_id in alive and other['tabId'] in alive and moved['tabId'] in alive
                tool('browser_task', {'taskId': 'qa-other', 'action': 'finish'})
                groups = worker.evaluate('chrome.tabGroups.query({})')
                assert not any(group['id'] == other['groupId'] for group in groups)
                report['checks'].append({'name': '结束时清理活动/编辑及连带页，keep保留，用户页/其他任务/移出分组页不关闭', 'passed': True})

                # 直接终止临时桥；期间不调用任何MCP工具，靠日志确认监督器自行恢复。
                os.kill(first['pid'], 15)
                bridge_pids.discard(first['pid'])
                recovered = until(lambda: next((entry for entry in starts() if entry['pid'] != first['pid']), None))
                until(lambda: worker.evaluate('connectionStatus()')['connected'], timeout=20)
                status = tool('browser_status')
                assert status['connected'] and status['extensionVersion'] == VERSION
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
