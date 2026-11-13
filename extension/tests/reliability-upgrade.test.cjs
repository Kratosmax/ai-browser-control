'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const test=require('node:test'),assert=require('node:assert/strict');
const filename=path.join(__dirname,'snapshot-query.test.cjs');
const harnessSource=fs.readFileSync(filename,'utf8').split('\nconst snapshot =')[0];
function legacyHarness(){
  const legacy="Object.defineProperty(globalThis,'__aiBrowserPageAgent9',{value:Object.freeze({snapshot:async()=>({legacy:true}),hideCursor:()=>{}}),configurable:false,writable:false});";
  const module=new Module(filename);module.filename=filename;module.paths=require.main?.paths||[];
  module._compile(harnessSource.replace(/const pageSource = [^;]+;/,'const pageSource = '+JSON.stringify(legacy)+';')+'\nmodule.exports=pageHarness;',filename);
  return module.exports();
}
test('new page agent coexists with immutable legacy9 and never adopts its references',async()=>{
  const h=legacyHarness(),old=h.context.__aiBrowserPageAgent9;
  h.node('button',{},'Stable target');vm.runInContext('Date.now=()=>1700000000000',h.context);
  const source=fs.readFileSync(path.join(__dirname,'../page-agent.js'),'utf8');vm.runInContext(source,h.context);
  const next=h.context.__aiBrowserPageAgent10;assert(next&&next!==old);assert.equal(h.context.__aiBrowserPageAgent9,old);
  assert.equal(h.context.__aiBrowserPageAgent8,next);assert.equal((await old.snapshot()).legacy,true);
  const first=await next.snapshot({load:'current'});assert.equal(first.__zcodeError,undefined);
  const item=first.elements[0];assert.equal(Number(item.ref.slice(1).split('-')[0])%100,10);
  assert.equal((await next.prepare('r1700000000001-1')).__zcodeCode,'STALE_REF');
  vm.runInContext(source,h.context);assert.equal(h.context.__aiBrowserPageAgent10,next);
  assert.equal((await next.prepare(item.ref)).target.name,'Stable target');
  const second=await next.snapshot({load:'current'});assert.notEqual(second.elements[0].ref,item.ref);
  assert.equal(Number(second.elements[0].ref.slice(1).split('-')[0])%100,10);
});

test('native named form property cannot shadow an attribute method or leak password value',async()=>{
 const safeSource=harnessSource.replace('const actual = element.getAttribute(name);','const actual = Element.prototype.getAttribute.call(element,name);');
 const fixture=new Module(filename);fixture.filename=filename;fixture.paths=require.main?.paths||[];
 fixture._compile(safeSource+'\nmodule.exports=pageHarness;',filename);
 const h=fixture.exports();const form=h.node('form');const field=h.node('input',{name:'getAttribute','aria-label':'Named field'},'',form);
 field.type='password';field.value='PRIVATE-NAMED-FORM';field.form=form;form.getAttribute=field;
 const snapshot=await h.agent.snapshot({load:'current'});assert.equal(snapshot.__zcodeError,undefined);
 const item=snapshot.elements.find(element=>element.name==='Named field');assert(item);
 const inspected=await h.agent.inspect(item.ref);assert.equal(inspected.identityChanged,false);
 assert(!JSON.stringify({snapshot,inspected}).includes('PRIVATE-NAMED-FORM'));
});
