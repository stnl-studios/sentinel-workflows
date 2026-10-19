// Capability boundary only; no previous-format context or adapter.
function unavailable(){throw Object.assign(new Error('Current managed workflow execution is not available; use the reviewed EC-1 native operation controller'),{code:'CURRENT_MANAGED_UNAVAILABLE'});}
export const createManagedSliceContext=unavailable;
