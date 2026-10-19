import {pathToFileURL} from 'node:url';
function unavailable(){throw Object.assign(new Error('Current managed workflow execution is not available; use the reviewed EC-1 native operation controller'),{code:'CURRENT_MANAGED_UNAVAILABLE'});}
export const startOfficialRunnerBroker=unavailable;
export const submitOfficialRunnerRequest=unavailable;
