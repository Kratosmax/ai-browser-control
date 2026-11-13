"""Independent custom-control QA: original page agent in isolated real Edge worlds.
Only local mechanism fixtures, no live-site DOM claim, user profile, bridge or settings.
Run: python -B tests/browser-custom-controls.py --source f3ab65b --label baseline
     python -B tests/browser-custom-controls.py --source current --label final
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp' / 'qa' / 'calendar-20261113'
AGENT = '__aiBrowserPageAgent8'
FIXTURE = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Custom-control mechanism fixture</title>
<style>body{font:16px system-ui;margin:24px;background:#f6f8fc;color:#172235}input,button{font:inherit;padding:8px}input{width:230px}
#popup{position:absolute;top:155px;left:24px;background:white;box-shadow:0 4px 22px #2335;padding:14px;z-index:20}
table{border-spacing:8px}td{padding:0;border:1px solid #ccd4e0;text-align:center}td>div{padding:14px 20px}td.pointer{cursor:pointer}td.hover-only:hover{cursor:pointer}
#select-popup{position:absolute;top:145px;left:400px;background:white;padding:12px;z-index:20}#select-popup>div{cursor:pointer;padding:14px;border:1px solid #ccc}
#ordinary{margin-top:400px}#ordinary td{padding:8px}#status{display:block;margin:16px 0;color:#175b38}</style>
<h1>Roleless calendar / custom-select fixture</h1><p>Local mechanism test · native td/div/span · real delegated listeners</p>
<input id="month-input" readonly placeholder="请选择月份"><output id="status">not selected</output>
<div id="popup" hidden><table><tbody id="months"></tbody></table></div>
<div id="select-popup"><div data-value="alpha"><span>第一项</span></div><div data-value="beta"><span>第二项</span></div></div>
<div id="ordinary"><div id="static-text">普通静态文本</div><table><tbody><tr><td title="2026-10"><div><span>静态10月</span></div></td></tr></tbody></table></div>
<script>
const mode=new URLSearchParams(location.search).get('case')||'delegated';window.fixtureEvents=[];
const input=document.getElementById('month-input'), popup=document.getElementById('popup');
for(let row=0;row<3;row++){const tr=document.createElement('tr');for(let col=1;col<=4;col++){
 const m=row*4+col,td=document.createElement('td');td.title='2026-'+String(m).padStart(2,'0');td.dataset.month=String(m);
 td.className=mode==='default-cursor'?'':mode==='hover-cursor'?'hover-only':'pointer';td.innerHTML='<div><span>'+m+'月</span></div>';tr.append(td)}document.getElementById('months').append(tr)}
input.addEventListener('click',()=>{popup.hidden=false;fixtureEvents.push({type:'open'})});
function choose(event){const td=event.target.closest('td[data-month]');if(!td||!popup.contains(td))return;
 fixtureEvents.push({type:event.type,month:td.dataset.month,target:event.target.tagName,trusted:event.isTrusted});
 if(td.closest('[inert],[aria-disabled="true"]'))return;input.value='2026-'+String(td.dataset.month).padStart(2,'0');
 document.getElementById('status').textContent='selected '+input.value;popup.hidden=true;}
// These are actual browser listeners, including a framework-style per-cell addEventListener.
if(mode==='framework')for(const td of popup.querySelectorAll('td'))td.addEventListener('click',choose);
else popup.addEventListener('click',choose);
document.getElementById('select-popup').addEventListener('click',event=>{const item=event.target.closest('[data-value]');if(item){document.getElementById('status').textContent='selected '+item.dataset.value;fixtureEvents.push({type:'select',value:item.dataset.value})}});
const oct=popup.querySelector('[data-month="10"]');
if(mode==='aria-disabled')oct.setAttribute('aria-disabled','true');
if(mode==='inert')oct.setAttribute('inert','');
if(mode==='hidden')oct.style.display='none';
if(mode==='offscreen')popup.style.top='1800px';
if(mode==='duplicates')for(let n=0;n<2;n++){const button=document.createElement('button');button.textContent='10月';document.getElementById('ordinary').append(button)}
if(mode==='long')for(let n=0;n<1600;n++){const button=document.createElement('button');button.textContent='Earlier '+n;document.body.insertBefore(button,popup)}
if(mode==='pagination'){const main=document.createElement('main');for(let n=0;n<155;n++){const item=document.createElement('div');item.style.cursor='pointer';item.textContent='Choice '+n;main.append(item)}document.body.append(main);const out=document.createElement('div');out.textContent='Choice outside';out.style.cursor='pointer';document.body.append(out)}
if(mode==='inline'){const item=document.createElement('div');item.textContent='点击项';item.setAttribute('onclick',"document.getElementById('status').textContent='inline selected'");document.body.append(item)}
if(mode.startsWith('form-shadow-')){const form=document.createElement('form');form.id='shadow-form';form.setAttribute('onclick','void 0');form.setAttribute('role','grid');form.setAttribute('aria-label','Native named form');const field=document.createElement('input');field.name=mode.slice('form-shadow-'.length);field.type='password';field.value='PRIVATE-NATIVE-FORM';field.setAttribute('aria-label','Named probe');form.append(field);const button=document.createElement('button');button.textContent='Continue';form.append(button);document.body.append(form)}
if(mode==='drag-identity'){window.nativeDrops=0;const from=document.createElement('div');from.id='drag-source';from.draggable=true;from.textContent='Drag source';from.style.cssText='padding:20px;border:1px solid #333';const to=document.createElement('div');to.id='drag-target';to.setAttribute('role','button');to.textContent='Drop target';to.style.cssText='padding:20px;border:1px solid #333;margin:20px';from.addEventListener('pointerdown',()=>{from.textContent='Changed source'});to.addEventListener('drop',()=>{nativeDrops++});document.body.append(from,to)}
if(mode==='hover-transition'){const owner=document.createElement('button');owner.id='hover-owner';owner.textContent='Hover owner';owner.setAttribute('aria-haspopup','menu');owner.setAttribute('aria-expanded','true');owner.setAttribute('aria-controls','fixture-menu');const menu=document.createElement('div');menu.id='fixture-menu';menu.setAttribute('role','menu');menu.style.cssText='position:absolute;left:650px;top:120px;background:white;padding:10px';const item=document.createElement('button');item.textContent='Menu option';menu.append(item);document.body.append(owner,menu)}
</script></html>'''


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='current', help='current or git revision')
    parser.add_argument('--label', default='final')
    args = parser.parse_args()
    if not args.label.replace('-', '').isalnum():
        parser.error('label must be alphanumeric or hyphens')
    OUT.mkdir(parents=True, exist_ok=True)
    source = ((ROOT / 'extension' / 'page-agent.js').read_text(encoding='utf-8') if args.source == 'current'
              else subprocess.check_output(['git', 'show', f'{args.source}:extension/page-agent.js'], cwd=ROOT).decode('utf-8'))
    (OUT / f'qa-{args.label}-page-agent.js').write_text(source, encoding='utf-8')
    report = {'source': args.source, 'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
              'scope': 'isolated real Edge, original page agent, local mechanism fixtures; not exact live DOM proof', 'checks': []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(FIXTURE.encode('utf-8'))

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = OUT / f'qa-{args.label}-edge-profile'
    if profile.exists():
        raise RuntimeError(f'Profile already exists; choose a fresh --label: {profile}')
    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True,
                viewport={'width': 1150, 'height': 850}, reduced_motion='reduce')
            report['browser'] = context.browser.version
            try:
                for case in ['delegated', 'framework', 'default-cursor', 'hover-cursor', 'select', 'inline', 'duplicates', 'static', 'ordinary-td',
                             'aria-disabled', 'inert', 'hidden', 'offscreen', 'long', 'pagination',
                             'form-shadow-getAttribute', 'form-shadow-hasAttribute', 'form-shadow-matches', 'form-shadow-querySelectorAll',
                             'form-shadow-contains', 'form-shadow-closest', 'form-shadow-getClientRects',
                             'form-shadow-action', 'form-shadow-method', 'form-shadow-target', 'drag-identity', 'hover-transition']:
                    page = context.new_page()
                    page_errors=[]
                    page.on('pageerror',lambda error: page_errors.append(str(error)))
                    record = {'name': case, 'status': 'running'}
                    report['checks'].append(record)
                    try:
                        page.goto(f'http://127.0.0.1:{server.server_port}/fixture?case={case}')
                        session = context.new_cdp_session(page)
                        frame = session.send('Page.getFrameTree')['frameTree']['frame']['id']
                        world = session.send('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'qa-custom-controls'})['executionContextId']

                        def js(expression):
                            result = session.send('Runtime.evaluate', {'expression': expression, 'contextId': world,
                                'awaitPromise': True, 'returnByValue': True})
                            assert 'exceptionDetails' not in result, result
                            return result['result'].get('value')

                        js(source)

                        def call(method, value):
                            return js(f'{AGENT}.{method}({json.dumps(value, ensure_ascii=False)})')

                        def ok(value):
                            assert not value.get('__zcodeError'), value
                            return value

                        def query(**kwargs):
                            return ok(call('snapshot', {'load': 'current', **kwargs}))

                        def click(item):
                            point = ok(call('prepare', {'ref': item['ref'], 'action': 'click', 'expectedContext': item['context']}))
                            result = ok(call('pointerClick', {'ref': item['ref'], 'point': point}))
                            assert result.get('actionDispatched'), result
                            return point

                        initial = query(name='请选择月份', exact=True)
                        assert len(initial['elements']) == 1, initial
                        click(initial['elements'][0])
                        assert page.locator('#popup').is_visible(), 'input click must open fixture calendar'
                        record['mechanism'] = page.locator('#popup [data-month="10"]').evaluate('''td=>({tag:td.tagName,title:td.title,cursor:getComputedStyle(td).cursor,
                            childCursor:getComputedStyle(td.querySelector('span')).cursor,role:td.getAttribute('role'),monthCells:td.closest('table').querySelectorAll('td').length})''')

                        if case in ['static', 'ordinary-td', 'hidden']:
                            name = {'static': '普通静态文本', 'ordinary-td': '静态10月', 'hidden': '10月'}[case]
                            if case in ['static', 'ordinary-td']:
                                selector = '#static-text' if case == 'static' else '#ordinary td'
                                record['negativeMechanism'] = page.locator(selector).evaluate(
                                    'element=>({tag:element.tagName,cursor:getComputedStyle(element).cursor,inlineHandler:element.hasAttribute("onclick"),propertyHandler:typeof element.onclick==="function"})')
                                assert record['negativeMechanism']['cursor'] != 'pointer'
                                assert not record['negativeMechanism']['inlineHandler'] and not record['negativeMechanism']['propertyHandler']
                            result = query(name=name, exact=True)
                            record['snapshot'] = result
                            if case == 'ordinary-td':
                                assert len(result['elements']) == 1, result
                                cell = result['elements'][0]
                                assert cell['tag'] == 'td' and cell['role'] == 'generic' and cell['candidateKind'] == 'native-cell' and not cell['inPopup'], cell
                            else:
                                assert result['elements'] == [], result
                        elif case.startswith('form-shadow-'):
                            prop=case[len('form-shadow-'):]
                            record['nativeNamedPropertyType']=js('typeof document.getElementById("shadow-form")['+json.dumps(prop)+']')
                            assert record['nativeNamedPropertyType']=='object', record
                            result=query(name='Named probe',exact=True)
                            assert len(result['elements'])==1, result
                            assert 'PRIVATE-NATIVE-FORM' not in json.dumps(result), result
                            state=ok(call('inspect',result['elements'][0]['ref']))
                            assert not state['identityChanged'], state
                            record['snapshot']=result
                            form_result=query(name='Native named form',exact=True)
                            assert len(form_result['elements'])==1,form_result
                            record['formInspect']=ok(call('inspect',form_result['elements'][0]['ref']))
                            assert not record['formInspect']['identityChanged']
                            assert 'PRIVATE-NATIVE-FORM' not in json.dumps(record)
                        elif case == 'hover-transition':
                            result=query(name='Hover owner',exact=True)
                            assert len(result['elements'])==1,result
                            js('globalThis.__qaNativeErrors=[];addEventListener("error",event=>__qaNativeErrors.push(event.message));')
                            ok(call('holdHover',{'ref':result['elements'][0]['ref']}))
                            js('document.getElementById("hover-owner").dispatchEvent(new Event("transitionend",{bubbles:true}));document.getElementById("fixture-menu").dispatchEvent(new Event("animationend",{bubbles:true}));')
                            assert js('__qaNativeErrors')==[]
                        elif case == 'drag-identity':
                            all_targets=query(scope='viewport')
                            source_ref=next(item['ref'] for item in all_targets['elements'] if item['name']=='Drag source')
                            target_ref=next(item['ref'] for item in all_targets['elements'] if item['name']=='Drop target')
                            from_point=ok(call('prepare',{'ref':source_ref,'action':'drag'}))
                            to_point=ok(call('prepare',{'ref':target_ref,'action':'drag'}))
                            blocked=call('domDrag',{'fromRef':source_ref,'toRef':target_ref,'from':from_point,'to':to_point,'durationMs':10})
                            assert blocked.get('__zcodeCode')=='TARGET_CHANGED',blocked
                            assert page.evaluate('nativeDrops')==0
                            record['blocked']=blocked
                        elif case == 'pagination':
                            result = query(name='Choice ', scope='main')
                            assert result['pagination']['total'] == 155, result
                            assert len(result['elements']) == 150, result
                            refs = [item['ref'] for item in result['elements']]
                            result = ok(call('snapshot', {'cursor': result['pagination']['nextCursor'], 'load': 'current'}))
                            refs.extend(item['ref'] for item in result['elements'])
                            assert len(result['elements']) == 5 and not result['pagination']['hasMore'], result
                            assert len(set(refs)) == 155 and all(item['name'] != 'Choice outside' for item in result['elements'])
                            record['uniqueRefs'] = len(set(refs))
                        elif case == 'duplicates':
                            result = query(name='10月', exact=True)
                            record['snapshot'] = result
                            assert len(result['elements']) == 3, result
                            assert sum(item['role'] == 'button' for item in result['elements']) == 2, result
                            assert len({item['ref'] for item in result['elements']}) == 3
                        else:
                            name = '第二项' if case == 'select' else '点击项' if case == 'inline' else '10月'
                            if case == 'offscreen':
                                assert query(name=name, exact=True, scope='viewport')['elements'] == []
                            result = query(name=name, exact=True)
                            record['snapshot'] = result
                            assert len(result['elements']) == 1, result
                            item = result['elements'][0]
                            assert item['role'] == 'generic' and item['tag'] in ['td', 'div', 'span'], item
                            state = ok(call('inspect', item['ref']))
                            record['inspect'] = state
                            assert state['visible'] and state['tag'] == item['tag'] and state['role'] == item['role'], state
                            if case in ['aria-disabled', 'inert']:
                                assert state['disabled'], state
                                prepared = call('prepare', item['ref'])
                                assert prepared.get('__zcodeCode') == 'ELEMENT_DISABLED', prepared
                                # Even a caller-supplied real center cannot bypass resolve's disabled check.
                                rect = state['rect']
                                blocked = call('pointerClick', {'ref': item['ref'], 'point': {'x': rect['x'] + rect['width']/2, 'y': rect['y'] + rect['height']/2}})
                                assert blocked.get('__zcodeCode') == 'ELEMENT_DISABLED', blocked
                                assert page.locator('#month-input').input_value() == ''
                                record['blocked'] = [prepared, blocked]
                            else:
                                point = click(item)
                                record['point'] = point
                                expected = 'selected beta' if case == 'select' else 'inline selected' if case == 'inline' else 'selected 2026-10'
                                assert page.locator('#status').inner_text() == expected
                                if case not in ['select', 'inline']:
                                    assert page.locator('#month-input').input_value() == '2026-10'
                                record['events'] = page.evaluate('fixtureEvents')
                        page.wait_for_timeout(20)
                        assert not page_errors,page_errors
                        record['status'] = 'pass'
                    except Exception as error:
                        record['status'] = 'fail'
                        record['error'] = str(error)
                        record['traceback'] = traceback.format_exc()
                    finally:
                        screenshot = OUT / f'qa-{args.label}-{case}.png'
                        page.screenshot(path=str(screenshot))
                        record['screenshot'] = str(screenshot.relative_to(ROOT))
                        page.close()
                        print(f"{record['status'].upper()}: {case}", flush=True)
            finally:
                context.close()
    finally:
        server.shutdown()
        report['passed'] = sum(item['status'] == 'pass' for item in report['checks'])
        report['failed'] = sum(item['status'] == 'fail' for item in report['checks'])
        report['result'] = 'pass' if report['failed'] == 0 else 'fail'
        (OUT / f'qa-{args.label}-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        # Only this run's resolved, unique profile is removed, after closing the context.
        assert profile.resolve().parent == OUT.resolve() and profile.name == f'qa-{args.label}-edge-profile'
        if profile.exists():
            shutil.rmtree(profile)
    print(json.dumps({'source': args.source, 'passed': report['passed'], 'failed': report['failed'], 'report': f'qa-{args.label}-report.json'}))
    return 1 if report['failed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
