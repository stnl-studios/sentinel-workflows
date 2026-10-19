#!/usr/bin/env node
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {preparePlanCandidate,assertPreparationCandidate} from './prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from './serialize-plan-paths.mjs';
import {installCurrentInitial} from './install-current-initial.mjs';
export async function publishPreparationCandidate({specPath,candidateExecutionRoot,reviewDecision=null,checkpoint=null}) {
 const owned=await assertPreparationCandidate(candidateExecutionRoot,specPath);
 if(owned.marker.source!==null||owned.marker.expectedActivationId!==null)throw Object.assign(new Error('Current replacement-set publication is not available; Initial cannot replace execution'),{code:'REPLAN_REQUIRED'});
 await preparePlanCandidate({candidateExecutionRoot:owned.root});
 const prepared=await serializePlanPathClaims({specPath,candidateExecutionRoot:owned.root});
 if(reviewDecision===null)return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,authority:prepared.authority,publication:'not-started'};
 // The v3 review schema is validated by the existing Initial producer. A former
 // reviewDecision object is not an equivalent authority and cannot activate it.
 const publication=await installCurrentInitial({specPath,preparationRoot:owned.root,review:reviewDecision,checkpoint});
 return {...publication,candidateExecutionRoot:owned.root,preparationDisposition:'diagnostic',preparationCleanup:'not-supported; retain this positively owned reviewed source without replaying publication'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=process.argv.slice(2);if(![4,6].includes(a.length)||a[0]!=='--spec-path'||a[2]!=='--candidate-execution-root'||a.length===6&&a[4]!=='--review-decision-file')throw new Error('Usage: publish-task-candidate.mjs --spec-path SPEC --candidate-execution-root ROOT [--review-decision-file FILE]');const reviewDecision=a.length===6?JSON.parse(await fs.readFile(a[5],'utf8')):null;process.stdout.write(JSON.stringify(await publishPreparationCandidate({specPath:a[1],candidateExecutionRoot:a[3],reviewDecision}))+'\n');}
