'use strict';
// 只运行实际 background.js 与其实际 executeScript.func；不访问浏览器或桥。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(pageCode = 'globalThis.__aiBrowserPageAgent8 = { snapshot: () => ({elements:[],text:""}) };', options = {}) {
  const page = vm.createContext({});
  vm.runInContext(pageCode, page);
  const scripts = [];
  const envelopes = [];
  const event = { addListener() {} };
  let timer = 0;
  let context;
  const chrome = {
    storage: { local: { get: async () => ({disconnected:true,autoAuthorize:true}), set: async () => {} }, session: {get:async()=>({}),set:async()=>{}} },
    runtime: {id:'test',getURL:p=>'ext://test/'+p,getManifest:()=>({version:'0.16.0'}),onMessage:event,onInstalled:event,onStartup:event},
    alarms: {create:async()=>{},onAlarm:event},
    tabs: {get:async id=>({id,url:'https://PRIVATE-URL.test/'}),query:async()=>[],onCreated:event,onRemoved:event},
    debugger: {onDetach:event,attach:async()=>{throw new Error('Unexpected CDP');}},
    scripting: {executeScript: async spec => {
      scripts.push(spec);
      if (spec.files) {
        if (options.injectError) throw options.injectError;
        return Object.hasOwn(options,'injected') ? options.injected : [{frameId:0,documentId:'PRIVATE-DOCUMENT',result:undefined}];
      }
      if (options.invokeError) throw options.invokeError;
      if (Object.hasOwn(options,'transport')) return options.transport;
      page.__args = spec.args;
      const result = await vm.runInContext('('+spec.func.toString()+')(...__args)', page);
      // 模拟 Chrome 对回传值执行 JSON 传输，不准测试夹具绕过序列化边界。
      const wire = JSON.parse(JSON.stringify(result));
      envelopes.push(wire);
      return [{frameId:options.frameId ?? 0,documentId:options.documentId ?? 'PRIVATE-DOCUMENT',result:wire}];
    }}
  };
  context = vm.createContext({chrome,URL,AbortController,TextEncoder,
    setTimeout:()=>++timer,clearTimeout:()=>{},fetch:async()=>{throw new Error('Unexpected network');}});
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
  await vm.runInContext('ready',context);
  vm.runInContext('wantDisconnect=false',context);
  return {scripts,envelopes,page,context,
    run:code=>vm.runInContext(code,context),
    call:(operation='snapshot',arg=null)=>{context.rpcOperation=operation;context.rpcArgument=arg;return vm.runInContext("pageAgent(7,rpcOperation,rpcArgument,Object.assign(()=>{}, {diagnostic:{commandId:'rpc-1',method:'snapshot',tabId:7}}))",context);},
    logs:()=>JSON.parse(vm.runInContext('JSON.stringify(diagnosticLog)',context))};
}

async function failure(h, code, operation='snapshot') {
  let caught;
  await assert.rejects(h.call(operation),error=>{caught=error;assert.equal(error.code,code);assert.equal(error.diagnostic.errorCode,code);return true;});
  const logs=h.logs();
  assert(!JSON.stringify(logs).includes('PRIVATE-'));
  assert(!JSON.stringify(caught.diagnostic).includes('PRIVATE-'));
  assert(logs.some(e=>e.event==='page_result'&&e.commandId==='rpc-1'&&e.errorCode===code&&e.outcome==='error'));
  assert(h.scripts.filter(s=>s.func).length<=1,'未知结果不得重放调用');
  return caught;
}

test('真实 async func 返回固定协议与 payload，正常空页面仍成功且每阶段按 commandId 关联', async()=>{
  const h=await harness();
  assert.deepEqual(JSON.parse(JSON.stringify(await h.call())),{elements:[],text:''});
  assert.equal(h.envelopes[0].protocol,'ai-browser-page-rpc-v1');
  assert.equal(h.envelopes[0].ok,true);
  const events=h.logs().filter(e=>e.event==='page_result');
  assert.deepEqual(events.map(e=>e.stage),['inject','invoke','decode','serialize']);
  assert(events.every(e=>e.commandId==='rpc-1'&&e.outcome==='ok'));
  assert.equal(events.at(-1).agentPresent,true);
  assert.equal(events.at(-1).documentChanged,false);
  assert(!JSON.stringify(events).includes('PRIVATE-'));
});

for (const [label,code,script] of [
  ['missing agent','PAGE_AGENT_NOT_READY',''],
  ['missing method','PAGE_AGENT_METHOD_MISSING','globalThis.__aiBrowserPageAgent8={};'],
  ['sync throw','PAGE_AGENT_SYNC_THROW','globalThis.__aiBrowserPageAgent8={snapshot(){throw new TypeError("PRIVATE-SYNC");}};'],
  ['promise reject','PAGE_AGENT_PROMISE_REJECTED','globalThis.__aiBrowserPageAgent8={snapshot(){return Promise.reject(new RangeError("PRIVATE-REJECT"));}};'],
  ['cycle','PAGE_AGENT_SERIALIZE_FAILED','globalThis.__aiBrowserPageAgent8={snapshot(){const v={};v.self=v;return v;}};'],
  ['bigint','PAGE_AGENT_SERIALIZE_FAILED','globalThis.__aiBrowserPageAgent8={snapshot:()=>({value:1n})};'],
  ['throwing toJSON','PAGE_AGENT_SERIALIZE_FAILED','globalThis.__aiBrowserPageAgent8={snapshot:()=>({toJSON(){throw new Error("PRIVATE-SERIALIZE");}})};'],
  ['legacy guarded error','REF_EXPIRED','globalThis.__aiBrowserPageAgent8={snapshot:async()=>({__zcodeError:"PRIVATE-REF",__zcodeCode:"REF_EXPIRED"})};'],
  ['unsafe guarded code','PAGE_ACTION_FAILED','globalThis.__aiBrowserPageAgent8={snapshot:async()=>({__zcodeError:"PRIVATE-REF",__zcodeCode:"PRIVATE-CODE"})};'],
  ['undefined payload','PAGE_AGENT_EMPTY_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>undefined};'],
  ['null payload','PAGE_AGENT_EMPTY_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>null};'],
  ['primitive payload','PAGE_AGENT_INVALID_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>42};'],
  ['array payload','PAGE_AGENT_INVALID_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>[]};'],
  ['function payload','PAGE_AGENT_INVALID_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>()=>42};'],
  ['primitive toJSON','PAGE_AGENT_INVALID_RESULT','globalThis.__aiBrowserPageAgent8={snapshot:()=>({toJSON:()=>42})};'],
]) test('真实 func 分类 '+label,async()=>{
  const h=await harness(script);
  const error=await failure(h,code);
  assert.equal(error.diagnostic.transportKind,'envelope');
  assert.equal(error.diagnostic.agentPresent,label!=='missing agent');
  assert.equal(h.envelopes[0].ok,false);
  if(label==='sync throw') {assert.equal(error.diagnostic.exceptionKind,'TypeError');assert.equal(error.message,'PRIVATE-SYNC');}
  if(label==='promise reject') assert.equal(error.diagnostic.exceptionKind,'RangeError');
});

for(const [label,transport,code,resultKind,transportKind] of [
  ['null',[{result:null}],'PAGE_AGENT_EMPTY_RESULT','null','empty'],
  ['undefined',[{result:undefined}],'PAGE_AGENT_EMPTY_RESULT','undefined','empty'],
  ['missing result',[{}],'PAGE_AGENT_NO_RESULT',undefined,'no-result'],
  ['empty array',[],'PAGE_AGENT_NO_RESULT',undefined,'no-result'],
  ['invalid result item',[null],'PAGE_AGENT_INVALID_RESULT',undefined,'no-result'],
  ['multiple frames',[{result:{}},{result:{}}],'PAGE_AGENT_INVALID_RESULT',undefined,'no-result'],
  ['non-array transport',{},'PAGE_AGENT_INVALID_RESULT','object','no-result'],
  ['array result',[{result:[]}],'PAGE_AGENT_INVALID_RESULT','array','legacy'],
  ['number result',[{result:7}],'PAGE_AGENT_INVALID_RESULT','number','legacy'],
  ['string result',[{result:'PRIVATE-TEXT'}],'PAGE_AGENT_INVALID_RESULT','string','legacy'],
  ['boolean result',[{result:false}],'PAGE_AGENT_INVALID_RESULT','boolean','legacy'],
  ['wrong envelope',[{result:{protocol:'PRIVATE-UNKNOWN',ok:true,payload:{}}}],'PAGE_AGENT_INVALID_RESULT','object','envelope'],
  ['missing payload',[{result:{protocol:'ai-browser-page-rpc-v1',ok:true}}],'PAGE_AGENT_INVALID_RESULT','object','envelope'],
]) test('Chrome 顶层回传区分 '+label,async()=>{
  const h=await harness(undefined,{transport});
  const error=await failure(h,code);
  assert.equal(error.diagnostic.resultKind,resultKind);
  assert.equal(error.diagnostic.transportKind,transportKind);
  assert(!/遮挡|不可见|重新 snapshot/.test(error.message));
});

test('Chrome 执行 error 与 API 拒绝保留正文到工具错误但日志只保留类别',async()=>{
  for(const options of [{transport:[{error:{message:'PRIVATE-CHROME'}}]},{invokeError:new TypeError('PRIVATE-CHROME')},{injectError:new Error('PRIVATE-CHROME')}]){
    const h=await harness(undefined,options);
    const e=await failure(h,'PAGE_AGENT_API_ERROR');
    assert.equal(e.message,'PRIVATE-CHROME');
    assert.equal(e.diagnostic.transportKind,'api-error');
  }
});

test('导航文档不一致与跨 frame 明确报错，不记录不透明 documentId',async()=>{
  const h=await harness(undefined,{documentId:'PRIVATE-NEW-DOCUMENT'});
  const e=await failure(h,'PAGE_AGENT_DOCUMENT_CHANGED');
  assert.equal(e.diagnostic.documentChanged,true);
  assert.equal(h.scripts.filter(s=>s.func).length,1);
  await failure(await harness(undefined,{frameId:1}),'PAGE_AGENT_FRAME_MISMATCH');
});

test('注入空元数据提前停止，不派发 invoke；不支持的方法不注入',async()=>{
  const h=await harness(undefined,{injected:[]});
  await failure(h,'PAGE_AGENT_NO_RESULT');
  assert.equal(h.scripts.length,1);
  const unsupported=await harness();
  await failure(unsupported,'PAGE_AGENT_INVALID_OPERATION','constructor');
  assert.equal(unsupported.scripts.length,0);
});

test('旧 agent8 body shape 与参数保持兼容，不新增任意方法接口',async()=>{
  const h=await harness('globalThis.__aiBrowserPageAgent8=Object.freeze({domFill:async body=>({filled:body.text,ref:body.ref})});');
  assert.deepEqual(JSON.parse(JSON.stringify(await h.call('domFill',{ref:'r1',text:'PRIVATE-INPUT'}))),{filled:'PRIVATE-INPUT',ref:'r1'});
  assert(!JSON.stringify(h.logs()).includes('PRIVATE-'));
  const spec=h.scripts.find(s=>s.func);
  h.page.__args=['constructor',null];
  assert.equal((await vm.runInContext('('+spec.func.toString()+')(...__args)',h.page)).error.code,'PAGE_AGENT_INVALID_OPERATION');
});

test('legacy direct object 可兼容但生产回调始终 envelope',async()=>{
  const h=await harness(undefined,{transport:[{result:{elements:[],text:''}}]});
  assert.deepEqual(await h.call(),{elements:[],text:''});
  assert(h.logs().some(e=>e.transportKind==='legacy'));
});

test('错误 diagnostic 注入任意属性与伪枚举时被剔除',async()=>{
  const transport=[{result:{protocol:'ai-browser-page-rpc-v1',ok:false,error:{code:'PAGE_AGENT_SYNC_THROW',message:'PRIVATE-ERROR'},diagnostic:{stage:'invoke',agentPresent:true,documentChanged:'PRIVATE-DOC',resultKind:'PRIVATE-KIND',exceptionKind:'PRIVATE-CLASS',url:'PRIVATE-URL',text:'PRIVATE-TEXT',payload:{private:'PRIVATE-OBJECT'}}}}];
  const h=await harness(undefined,{transport});
  const e=await failure(h,'PAGE_AGENT_SYNC_THROW');
  assert.equal(e.diagnostic.agentPresent,true);
  assert.equal(e.diagnostic.exceptionKind,undefined);
  assert.equal(e.diagnostic.url,undefined);
});

test('pollLoop error.diagnostic 跟随错误回执，重复 commandId 不重放读写调用',async()=>{
  const h=await harness('globalThis.__aiBrowserPageAgent8={prepare:()=>({x:10,y:10}),showCursor:()=>({shown:true}),domClick(){globalThis.invocations=(globalThis.invocations||0)+1;throw new Error("PRIVATE-CLICK");}};');
  const results=[];
  let polls=0;
  h.context.fetch=async(url,init)=>{
    const route=new URL(url).pathname;
    if(route==='/result') {results.push(JSON.parse(init.body));if(results.length===2) h.run('wantDisconnect=true');}
    const body=route==='/poll' ? {id:'rpc-poll',method:'click',params:{tabId:7,ref:'r1'}} : {};
    if(route==='/poll') polls++;
    return {ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body,body:{cancel:async()=>{}}};
  };
  h.run('paired=true;void pollLoop()');
  for(let i=0;i<8;i++) await tick();
  assert.equal(results.length,2);
  assert.equal(polls,2);
  assert.equal(results[0].error.code,'PAGE_AGENT_SYNC_THROW');
  assert.equal(results[0].error.diagnostic.errorCode,'PAGE_AGENT_SYNC_THROW');
  assert.equal(results[0].error.diagnostic.agentPresent,true);
  assert.equal(results[0].error.message,'PRIVATE-CLICK');
  assert.equal(vm.runInContext('invocations',h.page),1);
  assert(!JSON.stringify(h.logs()).includes('PRIVATE-'));
});

test('有documentId时调用锁定注入文档，原文档消失不重试到新文档', async () => {
  const h = await harness();
  await h.call();
  assert.deepEqual(JSON.parse(JSON.stringify(h.scripts.find(spec => spec.func).target)), { tabId: 7, documentIds: ['PRIVATE-DOCUMENT'] });
  const gone = await harness(undefined, { invokeError: new Error('No document with id PRIVATE-DOCUMENT in tab 7') });
  const error = await failure(gone, 'PAGE_AGENT_DOCUMENT_CHANGED');
  assert.equal(error.diagnostic.documentChanged, true);
  assert.equal(gone.scripts.filter(spec => spec.func).length, 1);
});

test('看似合法的大写敏感错误码不是固定枚举，不能进入回执诊断或日志', async () => {
  const h = await harness('globalThis.__aiBrowserPageAgent8={snapshot:()=>({__zcodeError:"business error",__zcodeCode:"PRIVATE_BILLING_SECRET"})}');
  const error = await failure(h, 'PAGE_ACTION_FAILED');
  assert(!JSON.stringify(error.diagnostic).includes('PRIVATE_BILLING_SECRET'));
  assert(!JSON.stringify(h.logs()).includes('PRIVATE_BILLING_SECRET'));
});

test('批量子项保留同样的安全diagnostic和子命令ID，失败不重放', async () => {
  const h = await harness('globalThis.__aiBrowserPageAgent8={snapshot(){globalThis.calls=(globalThis.calls||0)+1;return null;}}');
  const batch = await h.run("executeBounded({id:'rpc-batch',method:'batch',params:{commands:[{method:'snapshot',params:{tabId:7,load:'current'}}]}})");
  assert.equal(batch.results[0].ok, false);
  assert.equal(batch.results[0].error.code, 'PAGE_AGENT_EMPTY_RESULT');
  assert.equal(batch.results[0].error.commandId, 'rpc-batch-0');
  assert.equal(batch.results[0].error.diagnostic.resultKind, 'null');
  assert.equal(batch.results[0].error.diagnostic.agentPresent, true);
  assert.equal(vm.runInContext('calls', h.page), 1);
  assert(!JSON.stringify(batch.results[0].error.diagnostic).includes('PRIVATE'));
});

test('callback queued past its deadline cannot enter a page write method', async () => {
  const h = await harness('globalThis.calls=0;globalThis.__aiBrowserPageAgent8={domFill(){calls++;return {filled:true}}}');
  h.context.expiredDeadline = Date.now() - 1;
  await assert.rejects(h.run("pageAgent(7,'domFill',{ref:'r1-1',text:'private'},Object.assign(()=>{},{deadline:expiredDeadline,diagnostic:{commandId:'expired-write',method:'fill',tabId:7}}))"), error => error.code === 'PAGE_AGENT_COMMAND_EXPIRED');
  assert.equal(vm.runInContext('calls', h.page), 0);
  assert.equal(h.scripts.filter(spec => spec.func).length, 1);
});

test('delayed wait page callback honors condition budget separately from outer deadline', async () => {
  const h=await harness('globalThis.calls=0;globalThis.__aiBrowserPageAgent8={waitFor(){calls++;return {matched:true}}}');
  await h.call('waitFor',{state:'visible',timeoutMs:0});
  const spec=h.scripts.find(item=>item.func);
  vm.runInContext('calls=0',h.page);
  h.page.__args=['waitFor',{state:'visible',timeoutMs:0},Date.now()+10000,Date.now()-1];
  const response=await vm.runInContext('('+spec.func.toString()+')(...__args)',h.page);
  assert.equal(response.ok,true); assert.equal(response.payload.matched,false); assert.equal(response.payload.timedOut,true);
  assert.equal(vm.runInContext('calls',h.page),0);
});
