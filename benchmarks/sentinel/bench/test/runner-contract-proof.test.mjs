import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{sha256}from'../core.mjs';import{collectRunnerContractProof}from'../runner-contract-proof.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/runner-contract-tests');
function fixture(t){fs.mkdirSync(root,{recursive:true});const base=fs.mkdtempSync(path.join(root,'test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const file=path.join(base,'source/agents/codex/.codex/agents/stnl_validation_runner.toml');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'model = "x"\ndeveloper_instructions = "expected"\n');const manifest={sourceRoot:path.join(base,'source')},usage={threadTree:[{threadId:'child',role:'execute_check'}]};return{base,file,manifest,usage,events:[]};}
const row=(cmd,out,{id='read',threadId='child',exitCode=0}={})=>({payload:{method:'item/completed',params:{threadId,turnId:'turn',item:{id,type:'commandExecution',command:cmd,aggregatedOutput:out,exitCode}}}});
test('exact source path and full observed bytes match',t=>{const f=fixture(t);f.events=[row('cat '+f.file,fs.readFileSync(f.file,'utf8'))];assert.equal(collectRunnerContractProof(f).status,'MATCH');});
test('truncated, claim-only, wrong thread and failed reads remain incomplete',t=>{for(const variant of ['short','claim','thread','failed']){const f=fixture(t);f.events=[row(variant==='claim'?'echo '+f.file:'cat '+f.file,variant==='short'?'model':fs.readFileSync(f.file,'utf8'),{threadId:variant==='thread'?'parent':'child',exitCode:variant==='failed'?1:0})];assert.equal(collectRunnerContractProof(f).status,'INCOMPLETE');}});
test('outside contract full read mismatches even model is correct or bytes identical',t=>{for(const same of [false,true]){const f=fixture(t),other=path.join(f.base,'stnl_validation_runner.toml');fs.writeFileSync(other,same?fs.readFileSync(f.file):'other instructions\n');f.events=[row('cat '+other,fs.readFileSync(other,'utf8'))];assert.equal(collectRunnerContractProof(f).status,'MISMATCH');}});
test('tampered output cannot impersonate source bytes',t=>{const f=fixture(t);f.events=[row('cat '+f.file,'invented')];assert.equal(collectRunnerContractProof(f).status,'INCOMPLETE');});
test('segmented external read with matching digest proves mismatch, not full match',t=>{const f=fixture(t),other=path.join(f.base,'stnl_validation_runner.toml'),text='different\ncontract\n';fs.writeFileSync(other,text);f.events=[row("shasum -a 256 "+other+" && sed -n '1,1p' "+other,sha256(text)+'  '+other+'\ndifferent\n')];const r=collectRunnerContractProof(f);assert.equal(r.status,'MISMATCH');assert.equal(r.children[0].evidence[0].byteProof,'exact-range-output-plus-published-file-digest');});
test('no child is not applicable; missing full read is never inferred from correct model',t=>{const f=fixture(t);assert.equal(collectRunnerContractProof(f).status,'INCOMPLETE');f.usage.threadTree=[];assert.equal(collectRunnerContractProof(f).status,'NOT_APPLICABLE');});
function framed(t){const f=fixture(t);f.manifest.workspace=path.join(f.base,'workspace');f.manifest.tmpDir=path.join(f.base,'temp');fs.mkdirSync(f.manifest.workspace);const directory=path.join(f.manifest.tmpDir,'runner.ABC123');fs.mkdirSync(directory,{recursive:true});const copy=path.join(directory,'contract.toml'),bytes=fs.readFileSync(f.file),hash=sha256(bytes),digest=hash+'  '+copy+'\n';fs.writeFileSync(copy,bytes);fs.writeFileSync(path.join(directory,'contract.sha256'),digest);const command=`p=$(mktemp -d "$TMPDIR/runner.XXXXXX"); cat ${f.file} > "$p/contract.toml"; shasum -a 256 "$p/contract.toml" > "$p/contract.sha256"; printf '%s\\n' "$p"; cat "$p/contract.sha256" "$p/contract.toml"`,output=directory+'\n'+digest+bytes.toString();f.events=[row(command,output)];return{...f,copy,directory,output};}
test('closed copy/hash/full read frame proves complete source contract bytes',t=>{const f=framed(t),r=collectRunnerContractProof(f);assert.equal(r.status,'MATCH');assert.equal(r.children[0].evidence[0].byteProof,'framed-full-output-and-confined-copy');});
test('framed copy proof rejects unsafe roots, altered output and unproved command origin',t=>{for(const kind of ['outside','symlink','partial','prefix','hash','echo','tee','extra','source','crosscell']){const f=framed(t),it=f.events[0].payload.params.item;if(kind==='outside')f.manifest.tmpDir=path.join(f.base,'other');if(kind==='crosscell')f.manifest.workspace=path.join(f.base,'other/workspace');if(kind==='symlink'){fs.unlinkSync(f.copy);fs.symlinkSync(f.file,f.copy);}if(kind==='partial')it.aggregatedOutput=f.output.slice(0,-2);if(kind==='prefix')it.aggregatedOutput='untrusted\n'+f.output;if(kind==='hash')it.aggregatedOutput=f.output.replace(sha256(fs.readFileSync(f.file)),'0'.repeat(64));if(kind==='echo')it.command=it.command.replace('cat '+f.file,'echo '+f.file);if(kind==='tee')it.command=it.command.replace('cat '+f.file,'tee '+f.file);if(kind==='extra')it.command+='; echo extra';if(kind==='source')it.command=it.command.replace(f.file,f.file+'.wrong');assert.notEqual(collectRunnerContractProof(f).status,'MATCH',kind);}});

// Sanitized shape from public item/completed events 4051/5386 of
// diagnostic-direct-source-import-01. Only source path, content and IDs vary.
function twoLine(t){const f=fixture(t),text=fs.readFileSync(f.file,'utf8'),body='cat '+f.file+'\nshasum -a 256 '+f.file;f.events=[row("/bin/zsh -lc '"+body+"'",text+sha256(text)+'  '+f.file+'\n')];return{...f,text,body};}
test('observed literal two-line source read plus trailing digest matches exact bytes',t=>{for(const wrapped of [true,false]){const f=twoLine(t);if(!wrapped)f.events[0].payload.params.item.command=f.body;const r=collectRunnerContractProof(f);assert.equal(r.status,'MATCH');assert.equal(r.children[0].evidence[0].byteProof,'full-output-exact-with-trailing-source-digest');}});
test('two-line proof refuses non-template shell and incomplete or unrelated evidence',t=>{
 for(const kind of ['extra','comment','args','different','quote','doublequote','crlf','semicolon','prefix','suffix','nohash','partial','hash','thread','failed','method','symlink','noncanonical','missingfinal','digestpath','backtick','variable','secondfile']){
  const f=twoLine(t),event=f.events[0],it=event.payload.params.item;
  if(kind==='extra')it.command=it.command.replace('\nshasum','\necho injected\nshasum');
  if(kind==='comment')it.command=it.command.replace('\nshasum',' # comment\nshasum');
  if(kind==='args')it.command=it.command.replace('cat ','cat -n ');
  if(kind==='different')it.command=it.command.replace('256 '+f.file,'256 '+f.file+'.other');
  if(kind==='quote')it.command=it.command.replace('cat '+f.file,'cat "'+f.file+'"');
  if(kind==='doublequote')it.command='/bin/zsh -lc "'+f.body+'"';
  if(kind==='crlf')it.command=it.command.replace('\n','\r\n');
  if(kind==='semicolon')it.command=it.command.replace('\n','; echo injected; ');
  if(kind==='prefix')it.aggregatedOutput='prefix\n'+it.aggregatedOutput;
  if(kind==='suffix')it.aggregatedOutput+='extra';
  if(kind==='nohash')it.aggregatedOutput=f.text;
  if(kind==='partial')it.aggregatedOutput=it.aggregatedOutput.slice(1);
  if(kind==='hash')it.aggregatedOutput=it.aggregatedOutput.replace(sha256(f.text),'0'.repeat(64));
  if(kind==='thread')event.payload.params.threadId='parent';
  if(kind==='failed')it.exitCode=1;
  if(kind==='method')event.payload.method='item/started';
  if(kind==='symlink'){const target=f.file+'.real';fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);}
  if(kind==='missingfinal')it.aggregatedOutput=it.aggregatedOutput.slice(0,-1);
  if(kind==='digestpath')it.aggregatedOutput=it.aggregatedOutput.replace('  '+f.file,'  '+f.file+'.other');
  if(kind==='backtick')it.command=it.command.replace('cat ','cat `echo ignored` ');
  if(kind==='variable')it.command=it.command.replaceAll(f.file,'$SOURCE');
  if(kind==='secondfile')it.command=it.command.replace('\nshasum',' /another/file\nshasum');
  if(kind==='noncanonical')it.command=it.command.replaceAll('/agents/codex/','/agents/./codex/');
  assert.notEqual(collectRunnerContractProof(f).status,'MATCH',kind);
 }
});

test('literal compound canonical read plus exact trailing digest matches for both hash commands',t=>{
 for(const hashCommand of ['shasum -a 256','sha256sum'])for(const wrapped of [true,false]){
  const f=fixture(t),text=fs.readFileSync(f.file,'utf8'),cmd='cat '+f.file+' && '+hashCommand+' '+f.file;
  f.events=[row(wrapped?"/bin/zsh -lc '"+cmd+"'":cmd,text+sha256(text)+'  '+f.file+'\n')];
  const r=collectRunnerContractProof(f);
  assert.equal(r.status,'MATCH');
  assert.equal(r.children[0].evidence[0].byteProof,'full-output-exact-with-trailing-source-digest');
 }
});
test('compound proof refuses altered output, wrong source, unrelated child and extra shell',t=>{
 const changes=['other-source','different-digest-path','wrong-hash','short','suffix','extra','nonzero','outside-thread','symlink'];
 for(const variant of changes)for(const hashCommand of ['shasum -a 256','sha256sum']){
  const f=fixture(t),text=fs.readFileSync(f.file,'utf8'),other=path.join(f.base,'stnl_validation_runner.toml');
  fs.writeFileSync(other,text);
  const source=variant==='other-source'?other:f.file, digestPath=variant==='different-digest-path'?other:source;
  const command='cat '+source+' && '+hashCommand+' '+digestPath+(variant==='extra'?' && echo extra':'');
  const hash=variant==='wrong-hash'?'0'.repeat(64):sha256(text);
  const output=(variant==='short'?text.slice(0,-1):text)+hash+'  '+digestPath+'\n'+(variant==='suffix'?'extra\n':'');
  if(variant==='symlink'){fs.unlinkSync(f.file);fs.symlinkSync(other,f.file);}
  f.events=[row("/bin/zsh -lc '"+command+"'",output,{threadId:variant==='outside-thread'?'other':'child',exitCode:variant==='nonzero'?1:0})];
  assert.notEqual(collectRunnerContractProof(f).status,'MATCH',hashCommand+': '+variant);
 }
});

test('observed literal leading digest and semicolon trailing digest prove complete canonical bytes',t=>{
 for(const variant of ['bare','wrapped','quoted','trailing']){
  const f=fixture(t),text=fs.readFileSync(f.file,'utf8'),digest=sha256(text)+'  '+f.file+'\n',body='shasum -a 256 '+f.file+' && cat '+f.file;
  const command={bare:body,wrapped:"/bin/zsh -lc '"+body+"'",quoted:`/bin/zsh -lc "shasum -a 256 '${f.file}' && cat '${f.file}'"`,trailing:"/bin/zsh -lc 'cat "+f.file+"; shasum -a 256 "+f.file+"'"}[variant];
  f.events=[row(command,variant==='trailing'?text+digest:digest+text)];
  const proof=collectRunnerContractProof(f);
  assert.equal(proof.status,'MATCH',variant);
  assert.equal(proof.children[0].evidence[0].byteProof,'full-output-exact-with-'+(variant==='trailing'?'trailing':'leading')+'-source-digest');
 }
});
test('new literal frames reject altered or unproven evidence',t=>{
 for(const variant of ['wrong-sha','wrong-digest-path','wrong-read-path','wrong-checksum-source','truncated','missing-linebreak','extra-output','extra-command','extra-delimiter','failed','other-child','started','symlink','hash-only'])for(const trailing of [false,true]){
  const f=fixture(t),text=fs.readFileSync(f.file,'utf8'),other=f.file+'.other';fs.writeFileSync(other,text);
  const digest=(variant==='wrong-sha'?'0'.repeat(64):sha256(text))+'  '+(variant==='wrong-digest-path'?other:f.file)+(variant==='missing-linebreak'?'':'\n');
  const read='cat '+(variant==='wrong-read-path'?other:f.file),sha='shasum -a 256 '+(variant==='wrong-checksum-source'?other:f.file);
  let body=trailing?read+'; '+sha:sha+' && '+read;
  if(variant==='extra-command')body+='; echo extra';
  if(variant==='extra-delimiter')body=body.replace(trailing?'; ':' && ',trailing?';; ':' && && ');
  if(variant==='hash-only')body=sha;
  let output=trailing?text+digest:digest+text;
  if(variant==='truncated')output=output.slice(1);
  if(variant==='extra-output')output+='extra';
  if(variant==='hash-only')output=digest;
  if(variant==='symlink'){fs.unlinkSync(f.file);fs.symlinkSync(other,f.file);}
  f.events=[row("/bin/zsh -lc '"+body+"'",output,{threadId:variant==='other-child'?'other':'child',exitCode:variant==='failed'?1:0})];
  if(variant==='started')f.events[0].payload.method='item/started';
  assert.notEqual(collectRunnerContractProof(f).status,'MATCH',variant);
 }
});
