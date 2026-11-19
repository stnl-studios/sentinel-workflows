/** Pure case configuration resolution. Availability and full campaign validation belong to preflight/core. */
export const PROFILE_CASE_IDS = Object.freeze(['rename', 'query', 'import']);
const STAGES = ['INIT','READINESS','PLAN','REVIEW_PLAN','EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE','CLOSE'];
const REQUIRED = ['coordinator','plan_approver','plan_review','execute_check','formal_validate'];
const EFFORTS = ['none','minimal','low','medium','high','xhigh','max','ultra'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype,null].includes(Object.getPrototypeOf(x));
function rolesValid(roles, { required = false, strict = false } = {}) {
 if (!record(roles) || (required && REQUIRED.some(r => !Object.hasOwn(roles,r)))) throw Error('required roles missing or invalid roles');
 for (const [name, config] of Object.entries(roles)) {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || !record(config) || typeof config.model !== 'string' || !config.model.trim() || !EFFORTS.includes(config.effort)) throw Error('invalid role '+name);
  if (strict && (Object.keys(config).length !== 2 || !Object.hasOwn(config,'model') || !Object.hasOwn(config,'effort'))) throw Error('override role requires only complete model + effort: '+name);
 }
}
export function validateRoleConfiguration(profile) {
 rolesValid(profile?.roles,{required:true});
 const policy = profile.contextPolicy ?? 'stage';
 if (!['stage','persistent'].includes(policy)) throw Error('invalid contextPolicy');
 if (profile.stageRoles !== undefined) {
  if (!record(profile.stageRoles)) throw Error('invalid stageRoles');
  for (const [stage,role] of Object.entries(profile.stageRoles)) {
   if (!STAGES.includes(stage) || typeof role !== 'string' || !Object.hasOwn(profile.roles,role) || role === 'plan_approver') throw Error('invalid stage role '+stage);
   if (policy === 'persistent' && role !== 'coordinator') throw Error('persistent context cannot switch role');
  }
 }
 return profile;
}
function merged(profile, override) {
 const {caseOverrides, ...global} = profile;
 return structuredClone({...global, roles:{...profile.roles,...override?.roles}, stageRoles:{...profile.stageRoles,...override?.stageRoles}, limits:{...profile.limits,...override?.limits}});
}
export function validateCaseOverrides(profile) {
 validateRoleConfiguration(profile);
 if (profile.caseOverrides === undefined) return profile;
 if (!record(profile.caseOverrides)) throw Error('invalid caseOverrides');
 for (const [id,override] of Object.entries(profile.caseOverrides)) {
  if (!PROFILE_CASE_IDS.includes(id)) throw Error('unknown case override '+id);
  if (!record(override) || Object.keys(override).some(k=>!['roles','stageRoles','limits'].includes(k))) throw Error('only roles/stageRoles/limits may be overridden: '+id);
  if (Object.hasOwn(override,'roles')) rolesValid(override.roles,{strict:true});
  if (Object.hasOwn(override,'stageRoles') && !record(override.stageRoles)) throw Error('invalid override stageRoles');
  if (Object.hasOwn(override,'limits')) {
   const limits=override.limits;
   if (!record(limits) || Object.keys(limits).length!==1 || !Object.hasOwn(limits,'maxReportedTokens')) throw Error('override limits requires only maxReportedTokens: '+id);
   if (!Number.isSafeInteger(limits.maxReportedTokens) || limits.maxReportedTokens<=0) throw Error('invalid override maxReportedTokens: '+id);
   const campaignLimit=profile.limits?.maxCampaignReportedTokens;
   if (campaignLimit!==undefined && (!Number.isSafeInteger(campaignLimit) || campaignLimit<=0 || limits.maxReportedTokens>campaignLimit)) throw Error('override maxReportedTokens exceeds or has invalid campaign limit: '+id);
  }
  validateRoleConfiguration(merged(profile,override));
 }
 return profile;
}
export function resolveCaseProfile(profile,caseId) {
 if (!PROFILE_CASE_IDS.includes(caseId)) throw Error('unknown case '+caseId);
 validateCaseOverrides(profile);
 return merged(profile,profile.caseOverrides?.[caseId]);
}
/** Shared preflight/certificate bindings; case qualification prevents role collisions. */
export function effectiveRoleBindings(profile) {
 validateCaseOverrides(profile);
 const cases = profile.suiteCases ?? PROFILE_CASE_IDS;
 if (!Array.isArray(cases) || !cases.length || new Set(cases).size !== cases.length || cases.some(id=>!PROFILE_CASE_IDS.includes(id))) throw Error('invalid suiteCases');
 if (profile.caseOverrides === undefined) return Object.entries(profile.roles).map(([role,{model,effort}])=>({role,model,effort}));
 return cases.flatMap(caseId=>Object.entries(resolveCaseProfile(profile,caseId).roles).map(([logicalRole,{model,effort}])=>({role:caseId+'__'+logicalRole,caseId,logicalRole,model,effort})));
}
