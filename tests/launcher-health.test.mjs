import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('launcher fingerprint detects disk updates and worker restart cannot hide them', {timeout:15000},async t=>{
  const area=path.join(root,'temp','qa','reliability-20261113');await fs.mkdir(area,{recursive:true});
  const dir=await fs.mkdtemp(path.join(area,'launcher-health-'));
  await fs.mkdir(path.join(dir,'server'));await fs.mkdir(path.join(dir,'.zcode-plugin'));
  const original=await fs.readFile(path.join(root,'server/mcp.mjs'),'utf8');
  const launcher=path.join(dir,'server/mcp.mjs');await fs.writeFile(launcher,original);
  await fs.writeFile(path.join(dir,'.zcode-plugin/plugin.json'),JSON.stringify({version:'0.17.3'}));
  const tools=['browser_status','browser_restart'].map(name=>({name,description:'Fixture',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}));
  await fs.writeFile(path.join(dir,'server/mcp-worker.mjs'),
    'let generation;const tools='+JSON.stringify(tools)+';process.on("message",message=>{'+
    'if(message.type==="start"){generation=message.generation;process.send({type:"ready",version:"0.17.3",pid:process.pid,generation,tools,serverName:"launcher-health-fixture"});}'+
    'else if(message.type==="activate")process.send({type:"activated",pid:process.pid,generation});'+
    'else if(message.type==="call")process.send({type:"result",id:message.id,result:{content:[{type:"text",text:JSON.stringify({mcpVersion:"0.17.3",launcherHealth:{state:"unknown",hostReconnectRequired:null}})}]}});'+
    'else if(message.type==="shutdown")process.exit(0);});');
  const child=spawn(process.execPath,[launcher],{cwd:dir,env:{...process.env,HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));let sequence=0,buffer='',stderr='';const waiting=new Map();
  child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{stderr=(stderr+text).slice(-2000);});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let at;
    while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
      let message;try{message=JSON.parse(line);}catch{continue;}const pending=waiting.get(message.id);
      if(pending){waiting.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.result);}}
  });
  t.after(async()=>{child.stdin.end();let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},5000);})]);clearTimeout(timer);for(const pending of waiting.values())clearTimeout(pending.timer);assert(dir.startsWith(area+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('Launcher fixture response deadline '+stderr));},7000);
    waiting.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const call=name=>request('tools/call',{name,arguments:{}});
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'health',version:'1'}});
  const status=async()=>JSON.parse((await call('browser_status')).content[0].text);
  const current=await status();assert.equal(current.launcherHealth.state,'current');assert.equal(current.launcherHealth.hostReconnectRequired,false);
  assert.equal(current.launcherHealth.automaticChanges,false);assert.equal(current.mcpLauncherPid,child.pid);
  await fs.appendFile(launcher,'\n// Candidate source change in private fixture.\n');
  assert.equal((await status()).launcherHealth.hostReconnectRequired,true);
  const restarted=await call('browser_restart');assert.equal(restarted.structuredContent.scope,'mcp-worker');
  assert.equal(restarted.structuredContent.launcherHealth.state,'outdated');
  const stillOld=await status();assert.equal(stillOld.launcherHealth.hostReconnectRequired,true);assert.equal(stillOld.mcpLauncherPid,child.pid);
  await fs.writeFile(launcher,original);assert.equal((await status()).launcherHealth.state,'current');
});

test('failed startup reports unknown runtime version instead of copying disk metadata',{timeout:12000},async t=>{
 const area=path.join(root,'temp','qa','reliability-20261113');await fs.mkdir(area,{recursive:true});const dir=await fs.mkdtemp(path.join(area,'launcher-unavailable-'));
 await fs.mkdir(path.join(dir,'server'));await fs.mkdir(path.join(dir,'.zcode-plugin'));
 await fs.copyFile(path.join(root,'server/mcp.mjs'),path.join(dir,'server/mcp.mjs'));
 await fs.writeFile(path.join(dir,'.zcode-plugin/plugin.json'),JSON.stringify({version:'9.8.7'}));await fs.writeFile(path.join(dir,'server/mcp-worker.mjs'),'process.exit(0);');
 const child=spawn(process.execPath,[path.join(dir,'server/mcp.mjs')],{cwd:dir,env:{...process.env,HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,TEMP:dir,TMP:dir},windowsHide:true,stdio:['pipe','pipe','ignore']});
 const exited=new Promise(resolve=>child.once('exit',resolve));let buffer='',sequence=0;const waiting=new Map();
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;const message=JSON.parse(line),pending=waiting.get(message.id);if(pending){waiting.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.result);}}});
 t.after(async()=>{child.stdin.end();let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},4000);})]);clearTimeout(timer);for(const pending of waiting.values())clearTimeout(pending.timer);assert(dir.startsWith(area+path.sep));await fs.rm(dir,{recursive:true,force:true});});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('Unavailable-launcher fixture deadline'));},6000);waiting.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const initialized=await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'unknown-version',version:'1'}});
 assert.equal(initialized.serverInfo.version,'unknown');const result=await request('tools/call',{name:'browser_status',arguments:{}}),status=JSON.parse(result.content[0].text);
 assert.equal(status.mcpVersion,null);assert.equal(status.mcpDiskVersion,'9.8.7');assert.equal(status.mcpPid,null);assert.equal(status.mcpState,'unavailable');
});
