import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBridge } from '../server/bridge.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT='chrome-extension://'+'a'.repeat(32);
const headers={Origin:EXT,'X-Client-Id':'a'.repeat(32),'Content-Type':'application/json'};

async function clientFixture(t) {
  const area=path.join(root,'temp','qa','reliability-20261113');await fs.mkdir(area,{recursive:true});
  const dir=await fs.mkdtemp(path.join(area,'recovery-integration-'));
  const bridge=createBridge({port:0,configDir:dir,commandTimeout:1500,pollTimeout:1000});
  const port=await bridge.start(),base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[path.join(root,'server/mcp.mjs'),'--port',String(port),'--config-dir',dir],{
    cwd:root,env:{...process.env,HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir},
    windowsHide:true,stdio:['pipe','pipe','pipe']});
  let sequence=0,buffer='',stderr='';const waiting=new Map();
  child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{stderr=(stderr+text).slice(-3000);});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let at;
    while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
      let message;try{message=JSON.parse(line);}catch{continue;}const waiter=waiting.get(message.id);
      if(waiter){waiting.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result);}}
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    child.stdin.end();let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},5000);})]);clearTimeout(timer);
    for(const item of waiting.values()){clearTimeout(item.timer);item.reject(new Error('Fixture shutdown'));}
    await bridge.close();assert(dir.startsWith(area+path.sep));await fs.rm(dir,{recursive:true,force:true});
  });
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('MCP fixture deadline '+method+' '+stderr));},7000);
    waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'recovery-test',version:'1'}});
  const call=(name,args={})=>request('tools/call',{name,arguments:args});
  const post=(route,data)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(data)});
  await post('/pair',{});
  const receive=async(name,args,payload)=>{
    const polling=fetch(base+'/poll',{headers});
    const end=Date.now()+1000;while((await (await fetch(base+'/status')).json()).client!==EXT){assert(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,5));}
    const response=call(name,args);const command=await (await polling).json();
    await post('/result',{id:command.id,...payload});return response;
  };
  return {call,receive};
}

test('real MCP exposes fixed recovery guidance for errors, partial batches and version alignment', {timeout:15000}, async t=>{
  const fixture=await clientFixture(t);
  const status=JSON.parse((await fixture.call('browser_status')).content[0].text);
  assert.equal(status.versionHealth.state,'unknown');
  assert.equal(status.versionHealth.automaticChanges,false);assert.equal(status.versionHealth.pageReadiness,'check-per-page');
  const failure=await fixture.receive('browser_snapshot',{tabId:7,load:'current'},
    {error:{code:'TAB_FROZEN',message:'Frozen fixture',outcome:'not-dispatched',diagnostic:{stage:'preflight',frozen:true}}});
  assert.equal(failure.isError,true);const error=failure.structuredContent.error;
  assert.equal(error.recovery.category,'page-lifecycle');assert.equal(error.recovery.outcome,'not-dispatched');
  assert.equal(error.recovery.automaticReplay,false);assert.match(failure.content[0].text,/处理/);
  const batch=await fixture.receive('browser_batch',{commands:[{method:'snapshot',params:{tabId:7,load:'current'}},{method:'snapshot',params:{tabId:9,load:'current'}}]},
    {result:{results:[{ok:true,result:{title:'Healthy',elements:[]}},{ok:false,error:{code:'COMMAND_TIMEOUT',message:'Timeout fixture',outcome:'unverified',commandId:'fixture-child-1'}}]}});
  const results=JSON.parse(batch.content[0].text);assert.equal(results[0].ok,true);assert.equal(results[0].result.title,'Healthy');
  assert.equal(results[1].error.recovery.category,'outcome-unknown');assert.equal(results[1].error.recovery.automaticReplay,false);
  assert.equal(results[1].error.commandId,'fixture-child-1');
  const emptyTabs=await fixture.receive('browser_list_tabs',{}, {result:[]});
  assert.equal(emptyTabs.isError,undefined);assert.deepEqual(JSON.parse(emptyTabs.content[0].text),[]);
  const tabs=await fixture.receive('browser_list_tabs',{}, {result:[{id:7,title:'Fixture'}]});
  assert.deepEqual(JSON.parse(tabs.content[0].text),[{id:7,title:'Fixture'}]);
});
