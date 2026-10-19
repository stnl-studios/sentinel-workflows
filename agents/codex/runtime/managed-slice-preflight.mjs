import {pathToFileURL} from 'node:url';
function unavailable(){throw Object.assign(new Error('Current managed workflow execution is not available; use the reviewed EC-1 native operation controller'),{code:'CURRENT_MANAGED_UNAVAILABLE'});}
export const assertManagedSliceFreshness=unavailable;
export const main=unavailable;
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){try{main();}catch(error){process.stderr.write(error.code+': '+error.message+'\n');process.exitCode=1;}}
