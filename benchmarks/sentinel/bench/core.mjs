import { validateCaseOverrides } from './case-profile.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const digest = value => sha256(JSON.stringify(value));
export function safeId(value){if(typeof value!=='string'||! /^[a-z0-9][a-z0-9-]{0,95}$/.test(value))throw Error('invalid identifier');return value;}
/** Resolve every existing ancestor, including symlinks; never permit lexical-only confinement. */
export function confined(root,target){
 const base=fs.realpathSync.native(root),absolute=path.resolve(base,target);
 if(absolute!==base&&!absolute.startsWith(base+path.sep))throw Error('path escapes owned root');
 let current=base;for(const part of path.relative(base,absolute).split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(stat.isSymbolicLink())throw Error('symlink in owned path');
 }return absolute;
}
export function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.new';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
export function writeOnce(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function treeHashes(root,{exclude=[]}={}){if(fs.lstatSync(root).isSymbolicLink())throw Error('symlink immutable root');const out={};function walk(dir,rel=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const key=rel?rel+'/'+entry.name:entry.name;if(exclude.includes(key))continue;const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('symlink in immutable tree: '+key);if(entry.isDirectory())walk(file,key);else if(entry.isFile())out[key]=sha256(fs.readFileSync(file));else throw Error('unsupported immutable tree entry: '+key);}}walk(root);return out;}
export class Ledger{
 constructor(file){this.file=file;this.rows=[];if(fs.existsSync(file)){const data=fs.readFileSync(file,'utf8');if(data&&!data.endsWith('\n'))throw Error('truncated ledger requires diagnostic recovery');for(const line of data.trim().split('\n').filter(Boolean)){const row=JSON.parse(line);const {hash,...body}=row;if(body.sequence!==this.rows.length||body.previousHash!==(this.rows.at(-1)?.hash??null)||digest(body)!==hash)throw Error('ledger integrity failure');this.rows.push(row);}}}
 append(type,payload){const body={sequence:this.rows.length,previousHash:this.rows.at(-1)?.hash??null,at:new Date().toISOString(),type,payload};const row={...body,hash:digest(body)};fs.mkdirSync(path.dirname(this.file),{recursive:true});const fd=fs.openSync(this.file,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.rows.push(row);return row;}
}
export function acquireLock(directory){
 fs.mkdirSync(directory,{recursive:true});if(fs.lstatSync(directory).isSymbolicLink())throw Error('symlink lock directory');const file=confined(directory,'.lock');
 const owner={pid:process.pid,id:randomUUID(),created:new Date().toISOString()};writeOnce(file,owner);
 const identity=fs.lstatSync(file);let released=false;
 return()=>{if(released)return;const currentStat=fs.lstatSync(file);if(currentStat.isSymbolicLink()||currentStat.dev!==identity.dev||currentStat.ino!==identity.ino)throw Error('lock identity lost');const current=JSON.parse(fs.readFileSync(file));if(current.id!==owner.id)throw Error('lock ownership lost');fs.unlinkSync(file);released=true;};
}
export function validateProfile(p){
 if(!p||p.schemaVersion!==1)throw Error('profile schemaVersion must be 1');safeId(p.id);
 if(!path.isAbsolute(p.cli)||!p.cliVersion||!p.sentinelRevision)throw Error('explicit CLI/version/Sentinel revision required');
 validateCaseOverrides(p);
 for(const k of ['campaignMs','caseMs','turnMs','maxTurns','maxNoProgress','maxReportedTokens'])if(!Number.isSafeInteger(p.limits?.[k])||p.limits[k]<=0)throw Error('invalid limit '+k);
 if(p.limits.maxCampaignReportedTokens!==undefined&&(!Number.isSafeInteger(p.limits.maxCampaignReportedTokens)||p.limits.maxCampaignReportedTokens<=0))throw Error('invalid limit maxCampaignReportedTokens');
 if(p.limits.turnMs>p.limits.caseMs||p.limits.caseMs>p.limits.campaignMs)throw Error('inconsistent deadlines');
 if(!Number.isSafeInteger(p.repetitions)||p.repetitions<1||!Number.isSafeInteger(p.concurrency)||p.concurrency<1||p.concurrency>3)throw Error('invalid repetition/concurrency');return p;
}
export function budgetDecision({now=Date.now(),campaignDeadline,caseDeadline,turns,unchanged,reportedTokens},limits){if(![now,campaignDeadline,caseDeadline,turns,unchanged,reportedTokens,limits?.maxTurns,limits?.maxNoProgress,limits?.maxReportedTokens].every(Number.isFinite))return 'INVALID_BUDGET_STATE';if(now>=Math.min(campaignDeadline,caseDeadline))return 'DEADLINE';if(turns>=limits.maxTurns)return 'TURN_LIMIT';if(unchanged>=limits.maxNoProgress)return 'NO_PROGRESS';if(reportedTokens>=limits.maxReportedTokens)return 'OBSERVED_TOKEN_LIMIT';return 'ALLOW';}
/** Admission and task success deliberately separate: valid failed tasks remain official measurements. */
export function classifyMeasurement({mode,qualificationMatches,harnessValid,outcome,closed,oracle}){return{measurement:mode==='official'&&qualificationMatches&&harnessValid?'official':'diagnostic',taskPassed:outcome==='PASS'&&closed===true&&oracle==='PASS'};}
export function resumeDecision({pending,providerStatus,authoritySettled,identityMatches,proofMatches}){if(!pending)return 'CONTINUE';if(!identityMatches||!proofMatches)return 'BLOCKED';if(providerStatus==='inProgress')return 'OBSERVE_ONLY';if(providerStatus==='completed'&&authoritySettled)return 'SETTLE_NO_REPLAY';return 'BLOCKED';}
