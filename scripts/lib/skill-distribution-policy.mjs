import {
  LIFECYCLE_DISTRIBUTION_POLICY,
  REFINEMENT_DISTRIBUTION_POLICY,
  ROADMAP_DISTRIBUTION_POLICY,
  RUNBOOK_DISTRIBUTION_POLICY,
} from "./check-distributable-skill.mjs";

export const SENTINEL_DISTRIBUTION_POLICY_VERSION = "sentinel-production-v1";

const EXECUTION_RUNTIME_POLICY = Object.freeze({
  allowedRuntimeExtensions: Object.freeze([".mjs"]),
  requiredEntrypoints: Object.freeze([
    "execution-state.mjs",
    "validate-execution-state.mjs",
  ]),
});

const VALIDATION_RUNTIME_POLICY = Object.freeze({
  ...EXECUTION_RUNTIME_POLICY,
  requiredEntrypoints: Object.freeze([
    ...EXECUTION_RUNTIME_POLICY.requiredEntrypoints,
    "run-validation-session.mjs",
  ]),
});

export const DISTRIBUTABLE_SKILL_POLICIES = Object.freeze({
  "stnl-execution-closer": EXECUTION_RUNTIME_POLICY,
  "stnl-execution-planner": EXECUTION_RUNTIME_POLICY,
  "stnl-plan-reviewer": EXECUTION_RUNTIME_POLICY,
  "stnl-requirements-refiner": REFINEMENT_DISTRIBUTION_POLICY,
  "stnl-slice-executor": VALIDATION_RUNTIME_POLICY,
  "stnl-slice-quality-manager": VALIDATION_RUNTIME_POLICY,
  "stnl-spec-lifecycle-manager": LIFECYCLE_DISTRIBUTION_POLICY,
  "stnl-spec-roadmap": ROADMAP_DISTRIBUTION_POLICY,
  "stnl-spec-test-runbook": RUNBOOK_DISTRIBUTION_POLICY,
  "stnl-task-materializer": EXECUTION_RUNTIME_POLICY,
  "stnl-task-reviewer": EXECUTION_RUNTIME_POLICY,
});

const REFERENCE_DECISIONS = Object.freeze({
  "stnl-execution-closer": Object.freeze({
    production: Object.freeze(["execution-record-schema.md"]),
    development: Object.freeze([]),
  }),
  "stnl-execution-planner": Object.freeze({
    production: Object.freeze(["workspace.md"]),
    development: Object.freeze([]),
  }),
  "stnl-plan-reviewer": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-requirements-refiner": Object.freeze({
    production: Object.freeze(["refinement-model.md"]),
    development: Object.freeze([]),
  }),
  "stnl-slice-executor": Object.freeze({
    production: Object.freeze(["execution-record-schema.md"]),
    development: Object.freeze([]),
  }),
  "stnl-slice-quality-manager": Object.freeze({
    production: Object.freeze(["execution-record-schema.md", "validation-base.md"]),
    development: Object.freeze([]),
  }),
  "stnl-spec-lifecycle-manager": Object.freeze({
    production: Object.freeze([
      "canonical-ids.md",
      "close-policy.md",
      "modes.md",
      "question-policy.md",
      "readiness-gates.md",
      "spec-schema.md",
      "spec-workspace.md",
    ]),
    development: Object.freeze(["eval-guidance.md", "token-economy.md"]),
  }),
  "stnl-spec-roadmap": Object.freeze({
    production: Object.freeze(["roadmap-model.md"]),
    development: Object.freeze([]),
  }),
  "stnl-spec-test-runbook": Object.freeze({
    production: Object.freeze(["runbook-manifest.md"]),
    development: Object.freeze([]),
  }),
  "stnl-task-materializer": Object.freeze({
    production: Object.freeze(["execution-record-schema.md"]),
    development: Object.freeze([]),
  }),
  "stnl-task-reviewer": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-backend-dotnet": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-backend-node-typescript": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-database-persistence": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-frontend-react-next-angular": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-mobile-ios-swift": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-security-auth": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
  "stnl-testing": Object.freeze({ production: Object.freeze([]), development: Object.freeze([]) }),
});

export const DEVELOPMENT_ONLY_SKILL_TOP_LEVEL = Object.freeze([
  "README.md",
  "evals",
  "examples",
  "maintenance",
]);

export function referenceDecisionsForSkill(skillName) {
  const decision = REFERENCE_DECISIONS[skillName];
  if (!decision) throw new Error(`missing reference distribution classification for canonical skill: ${skillName}`);
  return decision;
}

export function distributablePolicyForSkill(skillName) {
  return DISTRIBUTABLE_SKILL_POLICIES[skillName] ?? Object.freeze({});
}
