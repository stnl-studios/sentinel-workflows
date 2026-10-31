#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {inspectExecutionState,preflightExecutionOperation} from './execution-state.mjs';
export async function main(args=process.argv.slice(2)) {
 try {
  if(args.length===1){process.stdout.write(JSON.stringify(await inspectExecutionState(args[0]))+'\n');return 0;}
  if(args.length===3&&args[1]==='--handoff-after'){process.stdout.write(JSON.stringify(await inspectExecutionState(args[0]))+'\n');return 0;}
  if(args.length>=2&&args.length<=3&&!args[1].startsWith('--')){process.stdout.write(JSON.stringify(await preflightExecutionOperation(args[0],args[1],args[2]??null))+'\n');return 0;}
  process.stderr.write('Usage: validate-execution-state.mjs SPEC_PATH [OPERATION [SLICE] | --handoff-after OPERATION]. Use execution-current-operation.mjs with its official handle for current admission and recovery.\n');return 2;
 }catch(error){process.stderr.write(JSON.stringify({code:error.code??'INVALID_CURRENT_IMAGE',reason:error.message})+'\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
