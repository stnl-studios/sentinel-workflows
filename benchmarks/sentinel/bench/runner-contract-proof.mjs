import fs from 'node:fs';
import path from 'node:path';
import {confined,sha256} from './core.mjs';
const NAME='stnl_validation_runner.toml';
const ROLES=new Set(['execute_check','formal_validate']);
function canonicalFile(file){if(!path.isAbsolute(file))throw Error('absolute path required');const normalized=path.normalize(file);let current=path.parse(normalized).root;for(const part of normalized.slice(current.length).split(path.sep)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('symlink path');}return normalized;}
function reads(command,source){
 // Observed literal frames only: canonical source repeated exactly, no shell
 // expansion, unobserved quoting, extra commands or arguments.
 if(typeof source==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(source)){
  const leading='shasum -a 256 '+source+' && cat '+source;
  const quotedLeading=`/bin/zsh -lc "shasum -a 256 '${source}' && cat '${source}'"`;
  if(command===leading||command==="/bin/zsh -lc '"+leading+"'"||command===quotedLeading)return[{file:source,kind:'digest-full'}];
  if(command==="/bin/zsh -lc 'cat "+source+"; shasum -a 256 "+source+"'")return[{file:source,kind:'full-digest'}];
  const frames=['\nshasum -a 256 ',' && shasum -a 256 ',' && sha256sum '];
  for(const separator of frames){
   const body='cat '+source+separator+source;
   if(command===body||command==="/bin/zsh -lc '"+body+"'")return[{file:source,kind:'full-digest'}];
  }
 }
 // Only literal cat /path and sed -n 'N,Mp' /path. No inferred reads from comments,
 // hashes alone, variable expansion, redirects or dynamically constructed commands.
 if(typeof command!=='string'||/[\r\n]/.test(command))return[];
 let s=command;
 const shell=/^\/bin\/(?:zsh|bash|sh) -lc (["'])(.*)\1$/.exec(s);
 if(shell)s=shell[2];
 return s.split(/\s*(?:&&|;)\s*/).flatMap(piece=>{
  let m=/^cat\s+["']?(\/[^\s"'\x60$;<>|]+\/stnl_validation_runner\.toml)["']?$/.exec(piece.trim());
  if(m)return[{file:m[1],kind:'full'}];
  m=/^sed -n ['"](\d+),(\d+)p['"] ["']?(\/[^\s"'\x60$;<>|]+\/stnl_validation_runner\.toml)["']?$/.exec(piece.trim());
  return m?[{file:m[3],kind:'range',start:Number(m[1]),end:Number(m[2])}]:[];
 });
}
function framedCopyRead(item,manifest,source,bytes){
 if(item.exitCode!==0||typeof item.aggregatedOutput!=='string')return null;
 const output=Buffer.from(item.aggregatedOutput),first=output.indexOf(10),second=output.indexOf(10,first+1);if(first<1||second<0)return null;
 const directory=output.subarray(0,first).toString(),copy=path.join(directory,'contract.toml'),hash=sha256(bytes);
 if(output.subarray(first+1,second).toString()!==hash+'  '+copy||!output.subarray(second+1).equals(bytes))return null;
 try{
  if(typeof manifest.tmpDir!=='string'||!path.isAbsolute(manifest.tmpDir)||directory.split('/').includes('..')||manifest.tmpDir.split('/').includes('..'))return null;
  if(typeof manifest.workspace!=='string'||manifest.tmpDir!==path.join(path.dirname(manifest.workspace),'temp'))return null;
  const temp=canonicalFile(manifest.tmpDir);if(directory!==path.resolve(directory)||path.dirname(directory)!==temp)return null;
  if(canonicalFile(copy)!==copy||!fs.readFileSync(copy).equals(bytes))return null;
  if(fs.readFileSync(canonicalFile(path.join(directory,'contract.sha256')),'utf8')!==hash+'  '+copy+'\n')return null;
 }catch{return null;}
 let cmd=item.command;if(typeof cmd!=='string'||/[\r\n]/.test(cmd))return null;
 const shell=/^\/bin\/(?:zsh|bash|sh) -lc (['"])(.*)\1$/.exec(cmd);if(shell)cmd=shell[2];
 const parts=cmd.split(';').map(x=>x.trim()),firstPart=parts[0]?.match(/^p=\$\(mktemp -d "\$TMPDIR\/([A-Za-z0-9_-]+)\.XXXXXX"\)$/);
 // Closed templates only. The second printf spelling is the observed transport
 // rendering of the same directory-print step; no arbitrary shell is evaluated.
 const printfForms=[`printf '%s\\n' "$p"`,"printf '\"'%s\\\\n' \\\"\"'$p\""];
 const sourceLiteral=/^\/[^\s'"$`;|&<>\\]+$/.test(source)?source:null;
 const commandProven=parts.length===5&&firstPart&&new RegExp('^'+firstPart[1]+'\\.[A-Za-z0-9]{6}$').test(path.basename(directory))&&sourceLiteral&&parts[1]==='cat '+source+' > "$p/contract.toml"'&&parts[2]==='shasum -a 256 "$p/contract.toml" > "$p/contract.sha256"'&&printfForms.includes(parts[3])&&parts[4]==='cat "$p/contract.sha256" "$p/contract.toml"';
 return{commandProven:Boolean(commandProven),copyPath:copy,copySha256:hash,prefixBytes:second+1,outputBytes:output.length,byteProof:'framed-full-output-and-confined-copy',matchesSourceBytes:true,matchesSourcePath:Boolean(commandProven)};
}
function selectedRows(events){if(Array.isArray(events))return events;if(typeof events==='string')return fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);return[];}
/** Public completed command evidence only. No reasoning/auth/session text is read. */
export function collectRunnerContractProof({manifest,usage,events}={}){
 const children=(usage?.threadTree??[]).filter(t=>ROLES.has(t.role));
 const report={schemaVersion:1,status:'INCOMPLETE',source:null,children:[],limitations:[
  'MATCH proves observed full contract read bytes and canonical source path, not semantic obedience or automatic agent configuration loading.',
  'Only public completed commandExecution with exact thread IDs is accepted. Missing/opaque/truncated/forwarded-without-child-ID evidence remains INCOMPLETE.',
  'Segmented reads cannot prove MATCH. Outside-path mismatch requires independently byte-verified output, not a model path claim.',
  'No child means NOT_APPLICABLE, not proof that the required check ran.'
 ]};
 let source,bytes;
 try{source=confined(manifest.sourceRoot,'agents/codex/.codex/agents/'+NAME);bytes=fs.readFileSync(source);report.source={path:source,sha256:sha256(bytes),bytes:bytes.length};}
 catch(e){report.error='SOURCE_CONTRACT_UNAVAILABLE';return report;}
 if(!children.length){report.status='NOT_APPLICABLE';return report;}
 const rows=selectedRows(events);
 for(const child of children){
  const result={threadId:child.threadId,role:child.role,status:'INCOMPLETE',evidence:[],gaps:[]};const seen=new Set();
  for(let index=0;index<rows.length;index++){
   const row=rows[index],p=row.payload?.params,item=p?.item;
   if(row.payload?.method!=='item/completed'||p.threadId!==child.threadId||item?.type!=='commandExecution'||seen.has(item.id))continue;
   seen.add(item.id);
   const framed=framedCopyRead(item,manifest,source,bytes);
   if(framed){const proof={eventLine:index+1,itemId:item.id,threadId:p.threadId,turnId:p.turnId??null,path:source,exitCode:item.exitCode,outputSha256:sha256(item.aggregatedOutput),...framed};if(framed.commandProven){result.evidence.push(proof);if(result.status!=='MISMATCH')result.status='MATCH';continue;}result.gaps.push({code:'FRAMED_CONTENT_ONLY_ORIGIN_UNPROVEN',...proof});}
   const candidates=reads(item.command,source);if(!candidates.length)continue;
   for(const read of candidates){
    const evidence={eventLine:index+1,itemId:item.id,threadId:p.threadId,turnId:p.turnId??null,path:read.file,readKind:read.kind,exitCode:item.exitCode??null,outputSha256:sha256(String(item.aggregatedOutput??''))};
    if(item.exitCode!==0||typeof item.aggregatedOutput!=='string'){result.gaps.push({code:'READ_NOT_SUCCESSFUL',...evidence});continue;}
    let actualFile,actual;try{actualFile=canonicalFile(read.file);actual=fs.readFileSync(actualFile);}catch{result.gaps.push({code:'READ_PATH_UNVERIFIABLE',...evidence});continue;}
    const output=item.aggregatedOutput,hash=sha256(actual),samePath=actualFile===source;
    evidence.observedFileSha256=hash;
    const digest=Buffer.from(hash+'  '+actualFile+'\n');
    const frame=read.kind==='full-digest'?[actual,digest]:read.kind==='digest-full'?[digest,actual]:null;
    const exactFrame=frame&&read.file===actualFile&&samePath&&Buffer.from(output).equals(Buffer.concat(frame));
    if((read.kind==='full'&&output===actual.toString('utf8'))||exactFrame){
     evidence.byteProof=read.kind==='digest-full'?'full-output-exact-with-leading-source-digest':read.kind==='full-digest'?'full-output-exact-with-trailing-source-digest':'full-output-exact';
     evidence.matchesSourceBytes=hash===report.source.sha256;
     evidence.matchesSourcePath=samePath;
     result.evidence.push(evidence);
     if(!samePath||hash!==report.source.sha256)result.status='MISMATCH';
     else if(result.status!=='MISMATCH')result.status='MATCH';
     continue;
    }
    if(read.kind==='range'&&read.start>=1&&read.end>=read.start){
     const lines=actual.toString('utf8').match(/[^\n]*\n|[^\n]+$/g)??[];
     const fragment=lines.slice(read.start-1,read.end).join('');
     // Only exact suffix preceded by exact standard sha256/wc rows from this file.
     const prefix=fragment&&output.endsWith(fragment)?output.slice(0,-fragment.length):null;
     const allowed=[hash+'  '+actualFile, String(actual.length)+' '+actualFile,String(lines.length)+' '+actualFile];
     const prefixLines=prefix===null?null:prefix.split('\n').filter(Boolean).map(x=>x.trim());
     const digestSeen=rows.some(e=>e.payload?.method==='item/completed'&&e.payload?.params?.threadId===child.threadId&&e.payload.params.item?.type==='commandExecution'&&e.payload.params.item.exitCode===0&&String(e.payload.params.item.command).includes('shasum -a 256 '+actualFile)&&String(e.payload.params.item.aggregatedOutput).split('\n').some(line=>line.trim()===hash+'  '+actualFile));
     if(fragment&&prefixLines&&prefixLines.every(line=>allowed.includes(line))&&digestSeen&&!samePath&&hash!==report.source.sha256){
      evidence.byteProof='exact-range-output-plus-published-file-digest';evidence.range=[read.start,read.end];evidence.matchesSourcePath=false;evidence.matchesSourceBytes=false;result.evidence.push(evidence);result.status='MISMATCH';continue;
     }
    }
    result.gaps.push({code:'FULL_READ_BYTES_NOT_PROVEN',...evidence});
   }
  }
  if(result.status==='MATCH'&&result.gaps.some(g=>g.path&&g.path!==source))result.status='INCOMPLETE';
  if(!result.evidence.length)result.gaps.push({code:'NO_PROVEN_CONTRACT_READ'});
  report.children.push(result);
 }
 report.status=report.children.some(c=>c.status==='MISMATCH')?'MISMATCH':report.children.every(c=>c.status==='MATCH')?'MATCH':'INCOMPLETE';
 return report;
}
