import {
  DOMAIN_SKILLS,
  WORKFLOW_SKILLS,
} from "./skill-registry.mjs";

const DOMAIN_SET = new Set(DOMAIN_SKILLS);
const WORKFLOW_SET = new Set(WORKFLOW_SKILLS);

const RULES = Object.freeze({
  dotnet: /(?:\.NET\b|\bdotnet\b|\bC#\b|\bcsharp\b|ASP\.NET\s*Core|EntityFrameworkCore)/iu,
  node: /(?:\bNode(?:\.js)?\b|\bTypeScript\b|\bNestJS\b|\bExpress\b|\bFastify\b).{0,60}\b(?:backend|API|service|server|worker)\b|\b(?:backend|API|service|server|worker)\b.{0,60}(?:\bNode(?:\.js)?\b|\bTypeScript\b|\bNestJS\b|\bExpress\b|\bFastify\b)/iu,
  persistence: /(?:\bSQL\b|\bORM\b|\bquery(?:ing|ies)?\b|\bdatabase\b|\bpersistence\b|\bN\+1\b|\bindex(?:es)?\b|\bmigrations?\b|\bschema evolution\b|\btransactions?\b|\blocking\b|\bdata access\b|\bcache(?:s|d)?\s+(?:at|on|for)\s+the\s+persistence\s+boundary)/iu,
  frontend: /(?:\bReact\b|\bNext\.js\b|\bAngular\b|\bfrontend\b|\bfront-end\b|\bUI\b)/iu,
  ios: /(?:\bSwift\b|\biOS\b|\bUIKit\b|\bSwiftUI\b)/iu,
  security: /(?:\bauthentication\b|\bauthorization\b|\bidentity\b|\bpermissions?\b|\bclaims?\b|\broles?\b|\btenant boundaries?\b|\bsecurity boundaries?\b)/iu,
  testing: /(?:\btest design\b|\btest strategy\b|\btesting strategy\b|\btest architecture\b|\bcontract testing\b|\bproperty-based testing\b|\bmutation testing\b|\bvalidation strategy\b|\bquality coverage\b)/iu,
});

const DOMAIN_BY_KEY = Object.freeze({
  dotnet: "stnl-backend-dotnet",
  node: "stnl-backend-node-typescript",
  persistence: "stnl-database-persistence",
  frontend: "stnl-frontend-react-next-angular",
  ios: "stnl-mobile-ios-swift",
  security: "stnl-security-auth",
  testing: "stnl-testing",
});

function scopeText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return [input.title, input.description, input.scope, input.requirements, ...(input.files ?? [])]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function matches(text, key) {
  return RULES[key].test(text);
}

function firstPrimary(text) {
  for (const key of ["dotnet", "node", "frontend", "ios", "testing", "persistence", "security"]) {
    if (matches(text, key)) return DOMAIN_BY_KEY[key];
  }
  return null;
}

export function selectDomainSkills(input) {
  const text = scopeText(input);
  const primaryDomainSkill = firstPrimary(text);
  const specializedDomainSkills = [];
  for (const key of ["persistence", "security", "testing"]) {
    const name = DOMAIN_BY_KEY[key];
    if (name !== primaryDomainSkill && matches(text, key)) specializedDomainSkills.push(name);
  }
  return Object.freeze({ primaryDomainSkill, specializedDomainSkills: Object.freeze(specializedDomainSkills) });
}

export function routeSkills({ workflowSkill, ...scope }) {
  if (!WORKFLOW_SET.has(workflowSkill)) throw new Error(`unknown workflow skill: ${workflowSkill}`);
  const selection = selectDomainSkills(scope);
  for (const name of [selection.primaryDomainSkill, ...selection.specializedDomainSkills].filter(Boolean)) {
    if (!DOMAIN_SET.has(name)) throw new Error(`routing produced an unregistered domain skill: ${name}`);
  }
  return Object.freeze({ workflowSkill, ...selection });
}
