import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCatalog} from './lib/test-catalog.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const catalogPath=path.join(root,'scripts/test-catalog.json');
const started=process.hrtime.bigint();

async function walk(directory) {
  const entries=await fs.readdir(directory,{withFileTypes:true});
  const files=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const name=path.join(directory,entry.name);
    if(entry.isDirectory())files.push(...await walk(name));
    else if(entry.isFile())files.push(name);
  }
  return files;
}

async function discover() {
  const paths=[];
  for(const entry of await fs.readdir(path.join(root,'scripts'),{withFileTypes:true})) {
    if(entry.isFile()&&/^test-.*\.mjs$/u.test(entry.name))paths.push(path.join('scripts',entry.name));
    if(entry.isFile()&&/^test-.*\.sh$/u.test(entry.name))paths.push(path.join('scripts',entry.name));
  }
  for(const file of await walk(path.join(root,'scripts')))
    if(file.endsWith('.test.mjs')&&path.relative(path.join(root,'scripts'),file).includes(path.sep))
      paths.push(path.relative(root,file));
  for(const base of ['skills/workflows','benchmarks/sentinel-todo/seed/test']) {
    for(const file of await walk(path.join(root,base)))
      if(file.endsWith('.test.mjs')&&file.includes(`${path.sep}runtime${path.sep}test${path.sep}`)
        || file.endsWith('.test.mjs')&&base==='benchmarks/sentinel-todo/seed/test')paths.push(path.relative(root,file));
  }
  return [...new Set(paths)].sort();
}

function run(command,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit',env:process.env});
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code:code??1,signal}));
  });
}

async function runTestFile(file) {
  if(file!=='scripts/test-native-benchmark-integration.mjs')
    return (await run(process.execPath,[file])).code;

  // This integration suite dynamically imports runtimes from many distinct
  // temporary source checkouts. Node's ESM cache retains each checkout until
  // exit, so run coherent scenario groups in fresh processes rather than
  // raising the heap limit. Every group matches complete top-level tests.
  const groups=[
    ['preparation and recovery','normal manager .*\\/(?:usage-|interrupt-|findings-|premature-|automatic-|pre-verification-|test-coverage-|plan-redelivery(?:-|:))'],
    ['formal and review recovery','normal manager .*\\/(?:formal-|execute-|review-)'],
    ['auxiliary recovery','normal manager .*\\/aux-'],
    ['empty normal-manager variants','normal manager (?:fresh/null|author-continuity/null)'],
    ['remaining integration scenarios','invocation provenance|offline collection|normal entry retains bounded|literal manager entry|focal resume preserves|normal entry blocks|public case finalizer|FULL operational checkpoint|FULL stops sibling'],
  ];
  let exitCode=0;
  for(const [label,pattern] of groups) {
    console.log(`\n--- ${file}: ${label} ---`);
    const result=await run(process.execPath,['--test',`--test-name-pattern=${pattern}`,file]);
    if(result.code!==0)exitCode=result.code;
  }
  return exitCode;
}

const catalog=JSON.parse(await fs.readFile(catalogPath,'utf8'));
let audited;
try { audited=validateCatalog(catalog,await discover()); }
catch(error) { console.error(error.message); process.exitCode=1; }
if(audited) {
  const {listed,excluded,delegations}=audited;
  const results=[];
  const record=result=>{results.push(result);console.log('[test-result] '+JSON.stringify(result));};
  const execute=async(file,operation)=>{
    const began=process.hrtime.bigint();
    let exitCode=1,error;
    try { exitCode=await operation(); }
    catch(cause) { error=cause.message;console.error(cause); }
    const result={file,status:exitCode===0?'passed':'failed',exitCode,durationSeconds:Number(process.hrtime.bigint()-began)/1e9,...(error?{error}:{})};
    record(result);
    if(exitCode!==0)process.exitCode=1;
    return result;
  };
  console.log(`Audited test catalog: ${listed.length} runnable files; ${delegations.length} tested delegation(s); ${excluded.length} explicit fixture exclusion(s)`);
  for(const item of excluded) {
    console.log(`Excluded fixture: ${item.file} — ${item.reason}`);
    record({file:item.file,status:'excluded-fixture',durationSeconds:0,reason:item.reason});
  }
  // Sequential by design: large benchmark scenarios import independent runtime
  // trees. Do not trade duplicate removal for uncontrolled memory/concurrency.
  for(const file of listed) {
    console.log(`\n=== ${file} ===`);
    await execute(file,()=>file.endsWith('.sh')?run('bash',[file]).then(result=>result.code):runTestFile(file));
  }
  for(const item of delegations) {
    const passed=[item.target,item.coveredBy].every(file=>results.some(result=>result.file===file&&result.status==='passed'));
    record({file:item.file,status:passed?'passed-delegation':'failed-delegation',exitCode:passed?0:1,durationSeconds:0,target:item.target,coveredBy:item.coveredBy,reason:item.reason});
    if(!passed)process.exitCode=1;
  }
  console.log('\n=== Structural validation ===');
  await execute('scripts/validate.sh --structure-only',()=>run('bash',['scripts/validate.sh','--structure-only']).then(result=>result.code));
  const report={format:'sentinel-test-report-v1',status:process.exitCode?'failed':'passed',durationSeconds:Number(process.hrtime.bigint()-started)/1e9,results};
  if(process.env.SENTINEL_TEST_REPORT)await fs.writeFile(process.env.SENTINEL_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  const failures=results.filter(result=>result.status.startsWith('failed')).length;
  console.log(`\nTest files: ${listed.length}; tested delegations: ${delegations.length}; failures: ${failures}; duration: ${report.durationSeconds.toFixed(1)}s`);
}
