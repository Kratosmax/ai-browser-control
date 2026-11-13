import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultRunCapture,discoverUnitTests,collectProvenance,main,computeExit,classifyChildResult,EXIT_CODES,RunnerError} from '../scripts/check-reliability.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t){const area=path.join(root,'temp','qa','reliability-20261113');await fs.mkdir(area,{recursive:true});const dir=await fs.mkdtemp(path.join(area,'gate-boundary-'));t.after(async()=>{assert(dir.startsWith(area+path.sep));await fs.rm(dir,{recursive:true,force:true});});return dir;}
test('capture timeout is enforced on actual child process, not just recorded as an option',{timeout:12000},async t=>{
 const dir=await fixture(t);const result=await defaultRunCapture(process.execPath,['-e','setTimeout(()=>{},350)'],{timeoutMs:25,cwd:dir,logPath:path.join(dir,'capture.log')});
 assert.equal(result.status,'timeout');assert.equal(result.timedOut,true);
});
test('one unreadable mandatory test directory cannot yield a partial green gate',async t=>{
 const dir=await fixture(t);await fs.mkdir(path.join(dir,'tests'));await fs.writeFile(path.join(dir,'tests','one.test.mjs'),'import test from "node:test";test("one",()=>{});');
 await assert.rejects(discoverUnitTests(dir),RunnerError);
 const result=await main({argv:['--unit'],rootDir:dir,log:()=>{},errLog:()=>{}});assert.equal(result.exitCode,EXIT_CODES.INTERNAL);assert.notEqual(result.report?.result,'pass');
});
test('failed git status remains unknown while actual product version is pinned',async t=>{
 const dir=await fixture(t);await fs.mkdir(path.join(dir,'.zcode-plugin'));await fs.writeFile(path.join(dir,'.zcode-plugin','plugin.json'),JSON.stringify({version:'0.17.3'}));
 const result=await collectProvenance(dir,{runCapture:async(command,args)=>args[0]==='status'?{status:'timeout',exitCode:null,output:''}:{status:'exited',exitCode:0,output:args.includes('HEAD')&&!args.includes('--abbrev-ref')?'a'.repeat(40)+'\n':'main\n'}});
 assert.equal(result.productVersion,'0.17.3');assert.equal(result.dirty,null);assert(result.warnings.some(text=>text.includes('工作树')));assert.equal(result.gitAvailable,true);
});
test('planned or skipped execution cannot accidentally become a green completed gate',()=>{
 assert.equal(computeExit({stages:[{tests:[{status:'skipped-stage-deadline'}]}]}),EXIT_CODES.CRASH_OR_TIMEOUT);
 assert.equal(computeExit({stages:[{tests:[{status:'skipped-interrupted'}]}]}),EXIT_CODES.INTERRUPTED);
 assert.equal(computeExit({dryRun:false,stages:[{status:'planned'}]}),EXIT_CODES.INTERNAL);
 assert.equal(computeExit({dryRun:true,stages:[{status:'planned'}]}),EXIT_CODES.PASS);
 assert.equal(classifyChildResult({status:'exited',exitCode:0,signal:'SIGTERM'}),'crash');
});
