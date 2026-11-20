import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BASE, CASES, verifyCase } from '../scenarios.mjs';
// These miniature implementations are oracle calibration fixtures, never benchmark/model results.
const methods = `
  async rename(id,title){const normalized=validateId(id);const nextTitle=validateTitle(title);const rows=await this.store.read();const index=rows.findIndex(x=>x.id===normalized);if(index<0)throw Error('missing id');const result={...rows[index],title:nextTitle};const next=[...rows];next[index]=result;await this.store.write(next);return result;}
  async list(options={}){if(options===null||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['status','query'].includes(k)))throw Error('options');const {status='all',query=''}=options;if(!['all','pending','completed'].includes(status)||typeof query!=='string')throw Error('filter');const rows=await this.store.read();return rows.filter(x=>(status==='all'||x.completed===(status==='completed')) && x.title.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>a.id-b.id);}
  async importTodos(doc){if(doc===null||typeof doc!=='object'||Array.isArray(doc)||Object.keys(doc).length!==1||!Array.isArray(doc.todos))throw Error('document');const batch=doc.todos.map(x=>{if(x===null||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['title','completed'].includes(k))||(Object.hasOwn(x,'completed')&&typeof x.completed!=='boolean'))throw Error('item');return {title:validateTitle(x.title),completed:x.completed??false};});if(batch.length===0)return [];const rows=await this.store.read();let id=rows.reduce((n,x)=>Math.max(n,x.id),0);const result=batch.map(x=>({id:++id,...x}));await this.store.write([...rows,...result]);return result;}
`;
const cli=`#!/usr/bin/env node
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {TodoService} from './todo-service.mjs';
import {TodoStore} from './todo-store.mjs';
export async function runCli(argv,io={}){const out=io.stdout??process.stdout,err=io.stderr??process.stderr;const usage=()=>{err.write('usage: todo\\n');return 2;};if(argv[0]!=='--store'||!argv[1])return usage();const service=new TodoService(new TodoStore(argv[1]));const [command,...args]=argv.slice(2);try{let result;if(command==='add'&&args.length)result=await service.add(args.join(' '));else if(command==='complete'&&args.length===1)result=await service.complete(args[0]);else if(command==='rename'&&args.length>=2)result=await service.rename(args[0],args.slice(1).join(' '));else if(command==='import'&&args.length===1)result=await service.importTodos(JSON.parse(await fs.readFile(args[0],'utf8')));else if(command==='list'){const opts={};for(let i=0;i<args.length;i+=2){const key={'--status':'status','--query':'query'}[args[i]];if(!key||Object.hasOwn(opts,key)||args[i+1]===undefined||args[i+1].startsWith('--'))return usage();opts[key]=args[i+1];}for(const row of await service.list(opts))out.write(JSON.stringify(row)+'\\n');return 0;}else return usage();out.write(JSON.stringify(result)+'\\n');return 0;}catch(e){err.write('error: '+e.message+'\\n');return 1;}}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)process.exitCode=await runCli(process.argv.slice(2));
`;
async function fixture(t,good=false,mutate=x=>x){await fs.mkdir(path.join(BASE,'temp'),{recursive:true});const dir=await fs.mkdtemp(path.join(BASE,'temp','scenario-calibration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const work=path.join(dir,'work');await fs.cp(path.join(BASE,'fixtures/todo'),work,{recursive:true});if(good){let service=await fs.readFile(path.join(work,'src/todo-service.mjs'),'utf8');service=service.slice(0,service.lastIndexOf('}'))+mutate(methods)+'\n}\n';await fs.writeFile(path.join(work,'src/todo-service.mjs'),service);await fs.writeFile(path.join(work,'src/cli.mjs'),cli);}return{work,dir};}
for(const c of CASES){
 test(`${c.id}: original baseline fails new contract, frozen regression passes`,async t=>{const {work,dir}=await fixture(t);const r=await verifyCase({caseId:c.id,workspace:work,evidenceDir:path.join(dir,'evidence')});assert.equal(r.status,'FAIL');assert.equal(r.checks.find(c=>c.name==='frozen baseline regression').status,'PASS');assert.equal(r.checks.find(c=>c.name==='independent acceptance').status,'FAIL');});
 test(`${c.id}: calibrated implementation passes and evidence cannot overwrite`,async t=>{const {work,dir}=await fixture(t,true);const args={caseId:c.id,workspace:work,evidenceDir:path.join(dir,'evidence')};const r=await verifyCase(args);assert.equal(r.status,'PASS',JSON.stringify(r.checks));await assert.rejects(()=>verifyCase(args),/exist/i);});
}
for(const [caseId,name,mutate]of [
 ['rename','drops write',s=>s.replace('await this.store.write(next);','')],
 ['query','uses OR instead of AND',s=>s.replace(" && x.title.toLowerCase()"," || x.title.toLowerCase()")],
 ['query','does not sort',s=>s.replace('.sort((a,b)=>a.id-b.id)','')],
 ['import','writes each row separately',s=>s.replace('await this.store.write([...rows,...result]);','for(const row of result)await this.store.write([...rows,row]);')],
 ['import','accepts extra fields',s=>s.replace("Object.keys(x).some(k=>!['title','completed'].includes(k))",'false')],
 ['rename','exits without testing',s=>s.replace('async rename(id,title){','async rename(id,title){process.exit(0);')],
 ['rename','loops forever',s=>s.replace('async rename(id,title){','async rename(id,title){while(true){};')],
 ['rename','never settles',s=>s.replace('async rename(id,title){','async rename(id,title){return new Promise(()=>{});')],
])test(`${caseId}: oracle rejects mutant ${name}`,async t=>{const{work,dir}=await fixture(t,true,mutate);const r=await verifyCase({caseId,workspace:work,evidenceDir:path.join(dir,'evidence')});assert.equal(r.status,'FAIL');assert.equal(r.checks.find(c=>c.name==='independent acceptance').status,'FAIL');});
test('reject source symlink and overlapping evidence without modifying source',async t=>{const{work,dir}=await fixture(t);await assert.rejects(()=>verifyCase({caseId:'rename',workspace:work,evidenceDir:path.join(work,'out')}),/disjoint/);await fs.rename(path.join(work,'src/validation.mjs'),path.join(dir,'validation.mjs'));await fs.symlink(path.join(dir,'validation.mjs'),path.join(work,'src/validation.mjs'));const r=await verifyCase({caseId:'rename',workspace:work,evidenceDir:path.join(dir,'evidence')});assert.equal(r.status,'FAIL');assert.match(r.checks[0].error,/symlink/);});

test('oracle and regression manifest are read from selected engine snapshot',async t=>{
 const {work,dir}=await fixture(t,true),engineRoot=path.join(dir,'engine');
 await fs.cp(path.join(BASE,'bench/cases'),path.join(engineRoot,'cases'),{recursive:true});
 await fs.writeFile(path.join(engineRoot,'cases/oracle.test.mjs'),'throw Error("SNAPSHOT_ORACLE_SELECTED");');
 const r=await verifyCase({caseId:'rename',workspace:work,evidenceDir:path.join(dir,'oracle-evidence'),engineRoot});
 assert.equal(r.engineRoot,engineRoot);assert.match(r.checks.find(x=>x.name==='independent acceptance').error,/SNAPSHOT_ORACLE_SELECTED/);
 await fs.writeFile(path.join(engineRoot,'cases/baseline-hashes.json'),'{}');
 const second=await verifyCase({caseId:'rename',workspace:work,evidenceDir:path.join(dir,'manifest-evidence'),engineRoot});
 assert.match(second.checks[0].error,/regression fingerprint/);
});
