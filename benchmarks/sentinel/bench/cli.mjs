#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compareFromInput} from './compare-command.mjs';
import {resumeCampaignCase} from './resume-command.mjs';
import {BASE,runCampaign} from './campaign.mjs';
import {validateProfile,safeId} from './core.mjs';
import {effectiveRunProfile,prepareOfficialAdmission,qualifyFromInput} from './admission.mjs';
export function parseCli(argv){
 const [command,...args]=argv, options={};
 const allowed={ 'validate-profile':['--profile'], run:['--profile','--id','--cases','--repetitions','--mode','--qualification'], status:['--id'], report:['--id'], resume:['--id','--case'], qualify:['--id','--input'], compare:['--id','--input'] };
 if(!allowed[command])throw Error('Usage: validate-profile | run --id ID | status/report --id ID. Default diagnostic. Official requires verified qualification and zero-model target preflight. qualify/compare --id ID --input evidence/input.json.');
 for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!allowed[command].includes(key))throw Error('unknown option '+key);if(value===undefined||value.startsWith('--')||Object.hasOwn(options,key))throw Error('expected unique --option value');options[key]=value;}
 if(options['--mode']&&!['diagnostic','official'].includes(options['--mode']))throw Error('invalid mode');
 if(command==='run'&&options['--mode']==='official'&&!options['--qualification'])throw Error('official mode requires --qualification');
 if(command==='run'&&options['--mode']!=='official'&&options['--qualification'])throw Error('--qualification requires --mode official');
 if(['qualify','compare'].includes(command)&&!options['--input'])throw Error(command+' requires --input');
 if(command!=='validate-profile')safeId(options['--id']);if(command==='resume')safeId(options['--case']);
 if(options['--repetitions']!==undefined&&(!/^[1-9][0-9]*$/.test(options['--repetitions'])||!Number.isSafeInteger(Number(options['--repetitions']))))throw Error('invalid repetitions');
 return {command,options};
}
export async function main(argv){
 const {command,options}=parseCli(argv);
 if(command==='compare'){const result=compareFromInput({base:BASE,id:options['--id'],inputFile:options['--input']});console.log(JSON.stringify(result,null,2));if(result.status!=='COMPARABLE')process.exitCode=1;return;}
 if(command==='qualify'){const result=await qualifyFromInput({base:BASE,id:options['--id'],inputFile:options['--input']});console.log(JSON.stringify(result,null,2));if(result.status!=='QUALIFIED')process.exitCode=1;return;}
 if(command==='resume'){console.log(JSON.stringify(await resumeCampaignCase({base:BASE,id:options['--id'],cell:options['--case']}),null,2));return;}
 if(command==='status'||command==='report'){console.log(fs.readFileSync(path.join(BASE,'evidence/campaigns',options['--id'],command==='report'?'report.md':'summary.json'),'utf8'));return;}
 const profile=validateProfile(JSON.parse(fs.readFileSync(options['--profile']??path.join(BASE,'bench/profiles/default.json'))));
 if(command==='validate-profile')console.log(JSON.stringify({status:'PASS',profile}));
 else {
  const effective=effectiveRunProfile(profile,{caseIds:options['--cases']?.split(','),repetitions:options['--repetitions']?Number(options['--repetitions']):undefined});
  const admission=options['--mode']==='official'?await prepareOfficialAdmission({base:BASE,id:options['--id'],profile:effective,qualificationFile:options['--qualification']}):null;
  console.log(JSON.stringify(await runCampaign({id:options['--id'],profile:effective,caseIds:effective.suiteCases,repetitions:effective.repetitions,admission}),null,2));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main(process.argv.slice(2));
