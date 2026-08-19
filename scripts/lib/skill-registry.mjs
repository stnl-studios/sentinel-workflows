export const WORKFLOW_SKILLS = Object.freeze([
  "stnl-execution-closer",
  "stnl-execution-planner",
  "stnl-plan-reviewer",
  "stnl-slice-executor",
  "stnl-slice-quality-manager",
  "stnl-spec-lifecycle-manager",
  "stnl-spec-test-runbook",
  "stnl-task-materializer",
  "stnl-task-reviewer",
]);

export const DOMAIN_SKILLS = Object.freeze([
  "stnl-backend-dotnet",
  "stnl-backend-node-typescript",
  "stnl-database-persistence",
  "stnl-frontend-react-next-angular",
  "stnl-mobile-ios-swift",
  "stnl-security-auth",
  "stnl-testing",
]);

export const WORKFLOW_OPERATIONS = Object.freeze({
  "stnl-execution-planner": Object.freeze(["PLAN", "REPLAN"]),
  "stnl-plan-reviewer": Object.freeze(["REVIEW_PLAN"]),
  "stnl-task-materializer": Object.freeze(["MATERIALIZE_TASKS"]),
  "stnl-task-reviewer": Object.freeze(["REVIEW_TASKS"]),
  "stnl-slice-executor": Object.freeze(["EXECUTE_SLICE", "APPLY_FINDINGS"]),
  "stnl-slice-quality-manager": Object.freeze(["VALIDATE_SLICE"]),
  "stnl-execution-closer": Object.freeze(["CLOSE"]),
  "stnl-spec-test-runbook": Object.freeze(["GENERATE_RUNBOOK"]),
});

export const SKILL_FAMILIES = Object.freeze({
  workflow: WORKFLOW_SKILLS,
  domain: DOMAIN_SKILLS,
});

const FAMILY_BY_SKILL = new Map([
  ...WORKFLOW_SKILLS.map((name) => [name, "workflow"]),
  ...DOMAIN_SKILLS.map((name) => [name, "domain"]),
]);

export function familyForSkill(name) {
  const family = FAMILY_BY_SKILL.get(name);
  if (!family) throw new Error(`unknown canonical skill: ${name}`);
  return family;
}

export function canonicalSkillRelativePath(name) {
  const family = familyForSkill(name);
  const directory = family === "workflow" ? "workflows" : "domains";
  return `skills/${directory}/${name}/SKILL.md`;
}

export function registrySkills() {
  return [...WORKFLOW_SKILLS, ...DOMAIN_SKILLS];
}
