import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {confined,safeId,treeHashes,digest,writeOnce,validateProfile,acquireLock,sha256} from './core.mjs';
function command(cmd,args,cwd,env,deadline=Infinity){if(Date.now()>=deadline)throw Error('PREPARATION_DEADLINE');if(cmd==='git'){env=Object.fromEntries(Object.entries(env??process.env).filter(([k])=>!k.startsWith('GIT_')));Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'});args=['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args];}const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8',timeout:Math.max(1,Math.min(60000,deadline-Date.now())),maxBuffer:4*1024*1024});if(r.error||r.status!==0)throw Error(`${cmd} failed: ${r.error?.message??r.stderr}`);return r.stdout;}
/** Verify the exported bytes against real Git objects, not a caller-provided label. */
export function verifySourceSnapshot({source,repository,revision,deadline=Infinity}){
 if(!/^[a-f0-9]{40}$/.test(revision))throw Error('full SHA-1 source revision required');
 const commit=command('git',['rev-parse','--verify',revision+'^{commit}'],repository,process.env,deadline).trim();
 if(commit!==revision)throw Error('source revision mismatch');
 const tree=command('git',['rev-parse',revision+'^{tree}'],repository,process.env,deadline).trim();
 const entries=command('git',['ls-tree','-rz','--full-tree',revision],repository,process.env,deadline).split('\0').filter(Boolean);
 const actual=treeHashes(source),expected=[];
 for(const entry of entries){const match=/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);if(!match)throw Error('source tree contains unsupported entry');const [,mode,objectId,name]=match;const file=confined(source,name);const bytes=fs.readFileSync(file);const blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');if(blob!==objectId)throw Error('source blob mismatch: '+name);if(Boolean(fs.statSync(file).mode&0o111)!==(mode==='100755'))throw Error('source executable mode mismatch: '+name);expected.push(name);}
 if(JSON.stringify(Object.keys(actual).sort())!==JSON.stringify(expected.sort()))throw Error('source snapshot file-set mismatch');
 return{revision:commit,tree,files:expected.length,sha256TreeDigest:digest(actual),proof:'git-tree-and-blob-verification'};
}
export function configureRunner(home,role){const file=confined(home,'.codex/agents/stnl_validation_runner.toml');let text=fs.readFileSync(file,'utf8');if(!/^model = /m.test(text)||!/^model_reasoning_effort = /m.test(text))throw Error('runner contract missing configuration');text=text.replace(/^model = .*$/m,'model = '+JSON.stringify(role.model)).replace(/^model_reasoning_effort = .*$/m,'model_reasoning_effort = '+JSON.stringify(role.effort));fs.writeFileSync(file,text);return digest(text);}
export async function prepareCase({base,campaignId,caseId,repetition,profile,requestedProfile=profile,requirements,trajectory={minSlices:1},deadline=Infinity,engineRoot=null,sourceRoot=null,sourceRepository=path.resolve(base,'../..'),authFile=path.join(process.env.HOME,'.codex/auth.json')}){
 engineRoot=confined(base,engineRoot??'bench');
 validateProfile(profile);validateProfile(requestedProfile);safeId(campaignId);safeId(caseId);if(!Number.isSafeInteger(repetition)||repetition<1)throw Error('invalid repetition');
 if(typeof requirements!=='string'||!requirements.trim())throw Error('requirements required');
 const run=confined(base,`work/campaigns/${campaignId}/${caseId}-${repetition}`),evidence=confined(base,`evidence/campaigns/${campaignId}/${caseId}-${repetition}`);
 const lockRoot=confined(base,`temp/preparation-locks/${campaignId}-${caseId}-${repetition}`);const release=acquireLock(lockRoot);
 let created=false,stage='identity';const startedAt=Date.now();const checkDeadline=()=>{if(Date.now()>=deadline)throw Error('PREPARATION_DEADLINE');};
 try{
 checkDeadline();if(fs.existsSync(run)||fs.existsSync(evidence))throw Error('case identity already used');
 fs.mkdirSync(evidence,{recursive:true});created=true;writeOnce(path.join(evidence,'effective-case-profile.json'),{caseId,requestedProfile,requestedProfileDigest:digest(requestedProfile),profile,profileDigest:digest(profile)});fs.mkdirSync(run,{recursive:true});
 const workspace=path.join(run,'workspace'),home=path.join(run,'home'),tmpDir=path.join(run,'temp');fs.mkdirSync(tmpDir,{recursive:true});fs.mkdirSync(home,{recursive:true});
 checkDeadline();stage='source-proof';const source=confined(base,sourceRoot??'source');const sourceProof=verifySourceSnapshot({source,repository:sourceRepository,revision:profile.sentinelRevision,deadline});
 checkDeadline();stage='fixture';
 const fixture=confined(base,'fixtures/todo');const fixtureHashes=treeHashes(fixture);fs.cpSync(fixture,workspace,{recursive:true});if(digest(treeHashes(workspace))!==digest(fixtureHashes))throw Error('fixture changed during copy');fs.writeFileSync(path.join(workspace,'OS.md'),requirements);fs.writeFileSync(path.join(workspace,'.gitignore'),'/tmp/sentinel/\n/.benchmark-temp/\n');
 fs.writeFileSync(path.join(workspace,'AGENTS.md'),`# Isolated Sentinel benchmark\nUse real installed Sentinel controls. This workspace is the only writable project. No network, global installation, push, Runbook or standalone Code Review. Test fixtures must use unique fs.mkdtemp directories under os.tmpdir() (TMPDIR is the isolated case temp directory outside this product workspace but inside benchmark-temp). Clean up only those owned fixtures. Do not place test fixtures in .benchmark-temp, src, test or product directories, and do not include runtime scratch directories in product scope. tmp/sentinel is reserved for official Sentinel controls. No RECONCILE. The coordinator is delegated to approve plans; do not self-approve. Preserve native child receipts.\n`);
 const env={...process.env,TMPDIR:tmpDir};delete env.NODE_TEST_CONTEXT;command('git',['init','-q'],workspace,env,deadline);command('git',['add','.'],workspace,env,deadline);command('git',['-c','user.name=Sentinel benchmark','-c','user.email=benchmark@localhost','commit','-qm','Independent immutable baseline'],workspace,env,deadline);
 command('git',['check-ignore','tmp/sentinel/probe','.benchmark-temp/probe'],workspace,env,deadline);
 checkDeadline();stage='install';const installer=await import(pathToFileURL(confined(source,'scripts/sentinel-install.mjs')).href);const plan=await installer.buildInstallPlan({repositoryRoot:source,home,targets:['codex']});for(const operation of plan.operations)confined(home,operation.destination);await installer.applyInstallPlan(plan);
 const runnerContractPath=confined(source,'agents/codex/.codex/agents/stnl_validation_runner.toml');const runnerContract={path:runnerContractPath,sha256:sha256(fs.readFileSync(runnerContractPath)),sourceRevision:profile.sentinelRevision,selection:'immutable-candidate-distribution-not-personal-installation'};writeOnce(path.join(evidence,'runner-contract-source.json'),runnerContract);
 const codexHome=path.join(home,'.codex');fs.writeFileSync(path.join(codexHome,'config.toml'),`cli_auth_credentials_store = "file"\n[features]\nmulti_agent = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
 // Same authenticated account, no credential bytes copied into artifacts or logs.
 checkDeadline();stage='authentication-link';if(!fs.existsSync(authFile))throw Error('existing Codex authentication unavailable');fs.symlinkSync(authFile,path.join(codexHome,'auth.json'));
 configureRunner(home,profile.roles.execute_check);
 checkDeadline();stage='cli-version';const version=command(profile.cli,['--version'],workspace,{...env,CODEX_HOME:codexHome},deadline).trim();if(version!==`codex-cli ${profile.cliVersion}`)throw Error('CLI version drift: '+version);
 checkDeadline();stage='baseline';const baseline=spawnSync(process.execPath,['--test','--test-reporter=tap'],{cwd:workspace,env,encoding:'utf8',timeout:Math.max(1,Math.min(60000,deadline-Date.now())),maxBuffer:4*1024*1024});fs.writeFileSync(path.join(evidence,'baseline-tests.txt'),(baseline.stdout??'')+(baseline.stderr??''));if(baseline.error||baseline.status!==0)throw Error('baseline failed: '+(baseline.error?.message??baseline.signal??baseline.status));
 checkDeadline();stage='manifest';if(digest(treeHashes(source))!==sourceProof.sha256TreeDigest)throw Error('source changed during preparation');const installed={skills:treeHashes(path.join(codexHome,'skills')),agents:treeHashes(path.join(codexHome,'agents'))};
 const manifest={schemaVersion:1,environment:{node:process.version,platform:process.platform,arch:process.arch},preparation:{startedAt,finishedAt:Date.now(),durationMs:Date.now()-startedAt},campaignId,caseId,repetition,trajectory,workspace,home,codexHome,tmpDir,evidence,fixtureHashes,fixtureDigest:digest(fixtureHashes),sentinelRevision:profile.sentinelRevision,sourceRoot:source,engineRoot,runnerContract,sourceProof,installed,installedDigest:digest(installed),profile,profileDigest:digest(profile),requestedProfile,requestedProfileDigest:digest(requestedProfile),cliVersion:version,initialCommit:command('git',['rev-parse','HEAD'],workspace,env,deadline).trim()};writeOnce(path.join(evidence,'manifest.json'),manifest);return manifest;
 }catch(error){if(created)writeOnce(path.join(evidence,'preparation-diagnostic.json'),{schemaVersion:1,status:'PREPARATION_FAILED',measurement:'diagnostic',stage,campaignId,caseId,repetition,error:String(error.message),preserved:true});throw error;}finally{release();}
}
