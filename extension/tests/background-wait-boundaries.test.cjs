'use strict';
// Completion-boundary regressions, independent of the native timer fixture.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const test=require('node:test'),assert=require('node:assert/strict');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const filename=path.join(__dirname,'background-wait.test.cjs');
const helper=new Module(filename,module); helper.filename=filename; helper.paths=module.paths;
helper._compile(fs.readFileSync(filename,'utf8').split("test('absent condition")[0]+'\nmodule.exports={harness,settle,invoked,unlocked};',filename);
const {harness,settle,invoked,unlocked}=helper.exports;
for(const [name,mutate,code] of [
 ['permission',h=>h.run('autoAuthorize=false'),'permission'],
 ['URL',h=>{h.tab.url+='#changed';},'PAGE_AGENT_DOCUMENT_CHANGED'],
 ['window',h=>{h.tab.windowId=2;},'PAGE_AGENT_DOCUMENT_CHANGED'],
 ['freeze',h=>{h.tab.frozen=true;},'TAB_FROZEN'],
 ['discard',h=>{h.tab.discarded=true;},'TAB_DISCARDED']
]) test('final sleep '+name+' change cannot become a normal condition timeout',async()=>{
 const h=harness();await h.ready();const work=h.exec({timeoutMs:100}).catch(error=>error);await tick();
 assert.equal(invoked(h).length,1);mutate(h);await h.advance();const error=await work;
 if(code==='permission')assert.match(error.message,/授权|释放/);else assert.equal(error.code,code);
 assert.equal(invoked(h).length,1);unlocked(h);
});
test('permission revoked by a completed probe cannot be accepted as matched',async()=>{
 const h=harness();await h.ready();h.hooks.payload=()=>{h.run('autoAuthorize=false');return{matched:true};};
 const error=await h.exec({timeoutMs:0}).catch(error=>error);assert.match(error.message,/授权|释放/);unlocked(h);
});
test('missing native document id refuses a second probe while allowing one immediate observation',async()=>{
 const h=harness();await h.ready();h.hooks.documentId=()=>undefined;
 const error=await settle(h,h.exec()).catch(error=>error);assert.equal(error.code,'PAGE_AGENT_DOCUMENT_CHANGED');assert.equal(invoked(h).length,1);unlocked(h);
 const single=harness();await single.ready();single.hooks.documentId=()=>undefined;
 assert.equal((await single.exec({timeoutMs:0})).matched,false);assert.equal(invoked(single).length,1);unlocked(single);
});
test('a match completing after condition deadline is a normal unmatched timeout',async()=>{
 const h=harness();await h.ready();h.hooks.payload=()=>{h.jump(700);return{matched:true};};
 const result=await h.exec({timeoutMs:500});assert.equal(result.matched,false);assert.equal(result.timedOut,true);assert.equal(result.elapsedMs,700);unlocked(h);
});
test('URL change during helper-file injection blocks the page method in that document',async()=>{
 const h=harness();await h.ready();h.hooks.script=spec=>{if(spec.files){h.tab.url+='#replacement';return[{frameId:0,documentId:'doc-7'}];}};
 const error=await h.exec().catch(error=>error);assert.equal(error.code,'PAGE_AGENT_DOCUMENT_CHANGED');assert.equal(invoked(h).length,0);unlocked(h);
});
test('helper-file injection completing past condition deadline never starts a new page method',async()=>{
 const h=harness();await h.ready();h.hooks.script=spec=>{if(spec.files){h.jump(700);return[{frameId:0,documentId:'doc-7'}];}};
 const result=await h.exec({timeoutMs:500});assert.equal(result.matched,false);assert.equal(result.timedOut,true);assert.equal(invoked(h).length,0);unlocked(h);
});
test('every later helper-file injection pins the first native document id',async()=>{
 const h=harness();await h.ready();await settle(h,h.exec({timeoutMs:250}));
 const injections=h.calls.filter(call=>call.kind==='inject');assert.equal(injections.length,3);
 assert.equal(injections[0].spec.target.documentIds,undefined);
 for(const call of injections.slice(1))assert.deepEqual(Array.from(call.spec.target.documentIds),['doc-7']);unlocked(h);
});
