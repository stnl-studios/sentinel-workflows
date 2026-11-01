import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
if(catalog.format!=='sentinel-test-catalog-v1'||!Array.isArray(catalog.files)||!Array.isArray(catalog.excluded))
  throw new Error('invalid scripts/test-catalog.json format');
const listed=[...catalog.files];
if(new Set(listed).size!==listed.length||listed.some((file,index)=>index>0&&listed[index-1]>=file))
  throw new Error('test catalog must contain unique, sorted paths');
const excluded=catalog.excluded;
if(excluded.some(item=>!item||typeof item.file!=='string'||typeof item.reason!=='string'||!item.reason.trim())
  ||new Set(excluded.map(item=>item.file)).size!==excluded.length
  ||excluded.some((item,index)=>index>0&&excluded[index-1].file>=item.file)
  ||listed.some(file=>excluded.some(item=>item.file===file)))
  throw new Error('test catalog exclusions must be unique, sorted, explained, and separate from included files');
const actual=await discover();
const excludedPaths=new Set(excluded.map(item=>item.file));
const missing=actual.filter(file=>!listed.includes(file)&&!excludedPaths.has(file));
const stale=[...listed,...excluded.map(item=>item.file)].filter(file=>!actual.includes(file));
if(missing.length||stale.length) {
  if(missing.length)console.error('Uncatalogued test files (review and add deliberately):\n'+missing.map(file=>'  '+file).join('\n'));
  if(stale.length)console.error('Catalog entries no longer discovered (remove or update deliberately):\n'+stale.map(file=>'  '+file).join('\n'));
  process.exitCode=1;
} else {
  console.log(`Audited test catalog: ${listed.length} runnable files; ${excluded.length} explicit fixture exclusion(s)`);
  for(const item of excluded)console.log(`Excluded fixture: ${item.file} — ${item.reason}`);
  let failures=0;
  let nextIndex=0;
  const worker=async()=>{
    while(nextIndex<listed.length) {
      const file=listed[nextIndex++];
      console.log(`\n=== ${file} ===`);
      const exitCode=file.endsWith('.sh')?(await run('bash',[file])).code:await runTestFile(file);
      if(exitCode!==0) {
        failures++;
        console.error(`FAIL: ${file} exited ${exitCode}`);
      }
    }
  };
  await worker();
  console.log(`\nTest files: ${listed.length}; failures: ${failures}; duration: ${(Number(process.hrtime.bigint()-started)/1_000_000_000).toFixed(1)}s`);
  if(failures)process.exitCode=1;
  console.log('\n=== Structural validation ===');
  const result=await run('bash',['scripts/validate.sh','--structure-only']);
  if(result.code!==0)process.exitCode=1;
  else console.log(`npm test completed in ${(Number(process.hrtime.bigint()-started)/1_000_000_000).toFixed(1)}s`);
}
