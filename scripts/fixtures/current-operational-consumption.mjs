import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export {currentImage} from './current-native-seed.mjs';
const raw=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// Mechanical image writer for compositor tests; not official publication proof.
export async function installSuccessor(image,previousActivation,composed) {
  const snapshot=JSON.parse(composed.files.get('approved-preparation.json'));
  const activationId=randomUUID();
  const activation={format:'stnl-execution-activation-v2',activationId,
    sequence:previousActivation.sequence+1,previousActivationId:previousActivation.activationId,
    preparationRevision:snapshot.preparationRevision,
    requirementsAuthority:previousActivation.requirementsAuthority,
    normativeSha256:snapshot.normativeSha256,
    approvedSnapshotSha256:raw(composed.files.get('approved-preparation.json')),
    artifacts:[...composed.files].map(([name,bytes])=>({path:name,sha256:raw(bytes)}))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),activeAttempt:null,
    lastAttempt:{operationAttemptId:composed.transition.operationAttemptId,
      deliveryId:composed.transition.deliveryId,slice:composed.transition.slice,
      operation:'VALIDATE_SLICE',terminalActivationId:activationId,outcome:'recorded'}};
  await fs.rm(image.f.execution,{recursive:true,force:true});
  await fs.mkdir(image.f.execution,{recursive:true});
  for(const [name,bytes] of composed.files) {
    const destination=path.join(image.f.execution,name);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,bytes);
  }
  await fs.writeFile(path.join(image.f.execution,'activation.json'),JSON.stringify(activation)+'\n');
  return activation;
}
