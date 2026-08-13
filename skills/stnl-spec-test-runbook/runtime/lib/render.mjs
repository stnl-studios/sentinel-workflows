import { createHash } from "node:crypto";

import { canonicalJson } from "./core.mjs";

const CRITICALITY_ORDER = ["critical", "high", "medium", "low"];

const MESSAGES = {
  "en-US": {
    documentTitle: "Test Runbook",
    product: "Sentinel test runbook",
    validation: "validation",
    skip: "Skip to runbook content",
    audience: "Audience",
    environment: "Environment",
    locale: "Locale",
    depth: "Depth",
    scope: "Scope",
    selection: "Selection",
    completeScope: "Complete scope",
    notDetermined: "Not determined",
    status: "Status",
    mode: "Mode",
    operational: "Operational",
    presentation: "Presentation",
    overallStatus: "Overall local status",
    progress: "Progress",
    scenariosComplete: "scenarios complete",
    tools: "Navigation and filters",
    toolsHint: "Open runbook tools",
    contents: "Contents",
    scenarioIndex: "Scenario index",
    runbookSections: "Runbook sections",
    findScenarios: "Find scenarios",
    search: "Search",
    searchPlaceholder: "ID, title, origin, or step…",
    allStatuses: "All statuses",
    testType: "Test type",
    allTypes: "All types",
    criticality: "Criticality",
    allCriticalities: "All criticalities",
    scenariosVisible: "{visible} of {total} scenarios visible",
    noMatches: "No scenarios match the active filters.",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    rememberState: "Remember status and notes on this device",
    stateBoundary: "Off by default. Browser-local state is never repository evidence.",
    resetState: "Reset local state",
    context: "Run context",
    executionStates: "Execution states",
    attentionNow: "Attention now",
    noAttention: "No critical, failed, or blocked scenario is currently recorded.",
    currentScenario: "Current scenario",
    overview: "Overview",
    setup: "Setup",
    testData: "Test data",
    coverage: "Coverage",
    scenarios: "Scenarios",
    risksGaps: "Risks & gaps",
    sources: "Sources",
    helpers: "Helpers",
    atAGlance: "At a glance",
    validationOverview: "Validation overview",
    inExplicitScope: "in explicit scope",
    critical: "Critical",
    highestAttention: "highest attention",
    blockedInitially: "Blocked initially",
    generatedBaseline: "generated baseline",
    coverageRecords: "Coverage records",
    deterministicClassifications: "deterministic classifications",
    coverageProfile: "Coverage profile",
    requestedTestTypes: "Requested test types",
    presentationSummary: "Presentation focus",
    presentationSummaryText: "Showing coverage, risks, and scenarios that are critical, failed, or blocked.",
    beforeExecution: "Before execution",
    environmentSetup: "Environment and setup",
    noSetup: "No setup instruction could be determined from current evidence.",
    preparation: "Preparation",
    noDataPreparation: "No data preparation was determined.",
    traceability: "Traceability",
    coverageMatrix: "Coverage matrix",
    noPercentages: "No inferred percentages",
    noCoverage: "No deterministic coverage denominator was available.",
    source: "Source",
    rationale: "Rationale",
    operationalSequence: "Operational sequence",
    testScenarios: "Test scenarios",
    stableOrder: "Generated order is stable",
    decisionSurface: "Decision surface",
    risksKnownGaps: "Risks, known issues, and gaps",
    risks: "Risks",
    knownIssues: "Known issues",
    informationGaps: "Information gaps",
    globalCleanup: "Global cleanup",
    noRisk: "No sourced risk was recorded.",
    noKnownIssue: "No sourced known issue was recorded.",
    noGap: "No material information gap was recorded.",
    noCleanup: "No global cleanup was determined.",
    optionalSupport: "Optional support",
    helperArtifacts: "Helper artifacts",
    path: "Path",
    purpose: "Purpose",
    cleanup: "Cleanup",
    manualOrNA: "Manual or not applicable",
    helperBoundary: "Helpers are subordinate to this HTML and exist only when explicitly requested, necessary, and validated.",
    provenance: "Provenance",
    sourcesUsed: "Sources used",
    sourceBoundary: "Source paths are relative. The runbook is a human testing projection; Sentinel requirements, tasks, and validation artifacts remain authoritative.",
    offline: "Offline, self-contained runbook",
    fingerprint: "Content fingerprint",
    backToTop: "Back to top",
    why: "Why this test exists",
    preconditions: "Preconditions",
    inputs: "Inputs",
    name: "Name",
    valueInstruction: "Value or instruction",
    sensitiveInput: "Provide securely at execution time; no value is embedded.",
    executionSteps: "Execution steps",
    step: "Step",
    action: "Action",
    expectedResult: "Expected result",
    evidence: "Evidence",
    evidenceExpected: "Evidence expected",
    approvalCriteria: "Approval criteria",
    relatedRegressions: "Related regressions",
    sourceNotes: "Source notes",
    scenarioTypes: "Types",
    collapseDetails: "Collapse details",
    expandDetails: "Expand details",
    executionStatus: "Execution status",
    localNotesRegion: "Local execution notes for",
    localOnly: "Local convenience only.",
    localOnlyDetail: "Notes and status below are browser-local and are not Sentinel validation evidence.",
    executionNotes: "Execution notes",
    executionNotesPlaceholder: "Observed result, blockers, or references",
    evidenceReferences: "Evidence references",
    evidencePlaceholder: "Screenshot filename, video reference, request ID, log ID, or database record ID",
    previousScenario: "Previous scenario",
    nextScenario: "Next scenario",
    reuse: "Reuse",
    currentMode: "Current mode",
    resetConfirm: "Reset local status and notes for this runbook?",
    inProgress: "In progress / not run",
    semanticLegend: "Status legend",
    nextAction: "Next action",
    nextRecommended: "Next recommended",
    openScenario: "Open scenario",
    allComplete: "Run complete",
    allCompleteDetail: "Every scenario is passed or skipped. Review evidence before closing the session.",
    recommendationFailed: "Review the first failed scenario in canonical order.",
    recommendationBlocked: "Resolve the first blocked scenario in canonical order.",
    recommendationPriority: "Run the highest-priority unexecuted scenario.",
    recommendationCanonical: "Continue with the next unexecuted scenario in canonical order.",
    scenarioFocus: "Scenario focus",
    scenarioPosition: "Scenario {current} of {total}",
    focusedScenario: "Focused scenario",
    supportingDetails: "Setup, inputs, and supporting details",
    beforeYouRun: "Before you run",
    blockerReason: "Blocker",
    unblockNeeded: "Needed to unblock",
    recordBlocker: "Record the blocking reason in the execution notes below.",
    recordUnblock: "Record the dependency or action needed to unblock this scenario.",
    expected: "Expected",
    observed: "Observed",
    recordObserved: "Record the observed result in the execution notes below.",
    result: "Result",
    setResult: "Set local scenario result",
    markNotRun: "Mark not run",
    resultHint: "Choose a result after checking the expected outcome and required evidence.",
    focusScenario: "Focus scenario",
    referencesAndContext: "Reference material",
    statuses: { not_run: "Not run", passed: "Passed", failed: "Failed", blocked: "Blocked", skipped: "Skipped" },
    statusIcons: { not_run: "○", passed: "✓", failed: "×", blocked: "!", skipped: "—" },
    labels: {
      covered: "Covered", partial: "Partial", no_scenario: "No Scenario", not_manually_testable: "Not Manually Testable",
      out_of_scope: "Out Of Scope", blocked: "Blocked", critical: "Critical", high: "High", medium: "Medium", low: "Low",
      functional_qa: "Functional QA", technical_qa: "Technical QA", stakeholder: "Stakeholder", mixed: "Mixed",
      developer: "Developer", product_owner: "Product Owner", analyst: "Analyst", business_user: "Business User",
      smoke: "Smoke", functional: "Functional", integration: "Integration", acceptance: "Acceptance", negative: "Negative", regression: "Regression",
      concise: "Concise", detailed: "Detailed", guided: "Guided", existing_data: "Existing Data", fixture: "Fixture", factory: "Factory",
      seed: "Seed", manual: "Manual", api: "API", sql: "SQL", helper_script: "Helper Script", not_determined: "Not Determined",
      reused: "Reused", required: "Required", not_needed: "Not Needed", requirement: "Requirement", acceptance_criterion: "Acceptance Criterion",
      task: "Task", risk: "Risk", slice: "Slice", screenshot: "Screenshot", video: "Video", request_response: "Request Response",
      logs: "Logs", generated_ids: "Generated IDs", database_result: "Database Result", visual_result: "Visual Result", status_http: "Status HTTP",
      events: "Events", message_to_user: "Message To User", global_plan: "Global Plan", approved_plan: "Approved Plan",
      global_progress: "Global Progress", execution_evidence: "Execution Evidence", spec_index: "SPEC Index", acceptance_criteria: "Acceptance Criteria",
      requirements: "Requirements", risks: "Risks", existing_fixture: "Existing Fixture", configuration: "Configuration", documentation: "Documentation",
      TASK: "Task", SLICE: "Slice", MULTI_SLICE: "Multi-slice", EXECUTION: "Execution", SPEC: "SPEC", CUSTOM: "Custom",
      decision_required: "Decision Required", not_executable: "Not Executable",
    },
  },
  "pt-BR": {
    documentTitle: "Runbook de testes",
    product: "Runbook de testes Sentinel",
    validation: "Validação",
    skip: "Ir para o conteúdo do runbook",
    audience: "Público",
    environment: "Ambiente",
    locale: "Idioma",
    depth: "Profundidade",
    scope: "Escopo",
    selection: "Seleção",
    completeScope: "Escopo completo",
    notDetermined: "Não determinado",
    status: "Status",
    mode: "Modo",
    operational: "Operacional",
    presentation: "Apresentação",
    overallStatus: "Status geral local",
    progress: "Progresso",
    scenariosComplete: "cenários concluídos",
    tools: "Navegação e filtros",
    toolsHint: "Abrir ferramentas do runbook",
    contents: "Conteúdo",
    scenarioIndex: "Índice de cenários",
    runbookSections: "Seções do runbook",
    findScenarios: "Localizar cenários",
    search: "Buscar",
    searchPlaceholder: "ID, título, origem ou passo…",
    allStatuses: "Todos os status",
    testType: "Tipo de teste",
    allTypes: "Todos os tipos",
    criticality: "Criticidade",
    allCriticalities: "Todas as criticidades",
    scenariosVisible: "{visible} de {total} cenários visíveis",
    noMatches: "Nenhum cenário corresponde aos filtros ativos.",
    expandAll: "Expandir todos",
    collapseAll: "Recolher todos",
    rememberState: "Lembrar status e notas neste dispositivo",
    stateBoundary: "Desativado por padrão. O estado local do navegador nunca é evidência do repositório.",
    resetState: "Redefinir estado local",
    context: "Contexto da execução",
    executionStates: "Estados da execução",
    attentionNow: "Atenção agora",
    noAttention: "Nenhum cenário crítico, reprovado ou bloqueado está registrado no momento.",
    currentScenario: "Cenário atual",
    overview: "Visão geral",
    setup: "Preparação",
    testData: "Dados de teste",
    coverage: "Cobertura",
    scenarios: "Cenários",
    risksGaps: "Riscos e lacunas",
    sources: "Fontes",
    helpers: "Auxiliares",
    atAGlance: "Resumo",
    validationOverview: "Visão geral da validação",
    inExplicitScope: "no escopo explícito",
    critical: "Críticos",
    highestAttention: "maior atenção",
    blockedInitially: "Bloqueados inicialmente",
    generatedBaseline: "linha de base gerada",
    coverageRecords: "Registros de cobertura",
    deterministicClassifications: "classificações determinísticas",
    coverageProfile: "Perfil de cobertura",
    requestedTestTypes: "Tipos de teste solicitados",
    presentationSummary: "Foco da apresentação",
    presentationSummaryText: "Exibindo cobertura, riscos e cenários críticos, reprovados ou bloqueados.",
    beforeExecution: "Antes da execução",
    environmentSetup: "Ambiente e preparação",
    noSetup: "Nenhuma instrução de preparação pôde ser determinada pelas evidências atuais.",
    preparation: "Preparação",
    noDataPreparation: "Nenhuma preparação de dados foi determinada.",
    traceability: "Rastreabilidade",
    coverageMatrix: "Matriz de cobertura",
    noPercentages: "Sem percentuais inferidos",
    noCoverage: "Nenhum denominador determinístico de cobertura estava disponível.",
    source: "Fonte",
    rationale: "Justificativa",
    operationalSequence: "Sequência operacional",
    testScenarios: "Cenários de teste",
    stableOrder: "A ordem gerada é estável",
    decisionSurface: "Pontos de decisão",
    risksKnownGaps: "Riscos, problemas conhecidos e lacunas",
    risks: "Riscos",
    knownIssues: "Problemas conhecidos",
    informationGaps: "Lacunas de informação",
    globalCleanup: "Limpeza global",
    noRisk: "Nenhum risco com fonte foi registrado.",
    noKnownIssue: "Nenhum problema conhecido com fonte foi registrado.",
    noGap: "Nenhuma lacuna material de informação foi registrada.",
    noCleanup: "Nenhuma limpeza global foi determinada.",
    optionalSupport: "Suporte opcional",
    helperArtifacts: "Artefatos auxiliares",
    path: "Caminho",
    purpose: "Finalidade",
    cleanup: "Limpeza",
    manualOrNA: "Manual ou não aplicável",
    helperBoundary: "Os auxiliares são subordinados a este HTML e só existem quando solicitados explicitamente, necessários e validados.",
    provenance: "Proveniência",
    sourcesUsed: "Fontes utilizadas",
    sourceBoundary: "Os caminhos das fontes são relativos. O runbook é uma projeção para testes humanos; requisitos, tarefas e artefatos de validação Sentinel permanecem autoritativos.",
    offline: "Runbook offline e autocontido",
    fingerprint: "Fingerprint do conteúdo",
    backToTop: "Voltar ao topo",
    why: "Por que este teste existe",
    preconditions: "Pré-condições",
    inputs: "Entradas",
    name: "Nome",
    valueInstruction: "Valor ou instrução",
    sensitiveInput: "Forneça com segurança no momento da execução; nenhum valor está incorporado.",
    executionSteps: "Passos de execução",
    step: "Passo",
    action: "Ação",
    expectedResult: "Resultado esperado",
    evidence: "Evidência",
    evidenceExpected: "Evidência esperada",
    approvalCriteria: "Critérios de aprovação",
    relatedRegressions: "Regressões relacionadas",
    sourceNotes: "Notas das fontes",
    scenarioTypes: "Tipos",
    collapseDetails: "Recolher detalhes",
    expandDetails: "Expandir detalhes",
    executionStatus: "Status da execução",
    localNotesRegion: "Notas locais da execução de",
    localOnly: "Apenas conveniência local.",
    localOnlyDetail: "As notas e o status abaixo são locais do navegador e não são evidência de validação Sentinel.",
    executionNotes: "Notas da execução",
    executionNotesPlaceholder: "Resultado observado, bloqueios ou referências",
    evidenceReferences: "Referências de evidência",
    evidencePlaceholder: "Arquivo de screenshot, referência de vídeo, ID da requisição, log ou registro do banco",
    previousScenario: "Cenário anterior",
    nextScenario: "Próximo cenário",
    reuse: "Reutilizar",
    currentMode: "Modo atual",
    resetConfirm: "Redefinir o status local e as notas deste runbook?",
    inProgress: "Em andamento / não executado",
    semanticLegend: "Legenda de status",
    nextAction: "Próxima ação",
    nextRecommended: "Próximo recomendado",
    openScenario: "Abrir cenário",
    allComplete: "Execução concluída",
    allCompleteDetail: "Todos os cenários estão aprovados ou ignorados. Revise as evidências antes de encerrar a sessão.",
    recommendationFailed: "Revise o primeiro cenário reprovado na ordem canônica.",
    recommendationBlocked: "Resolva o primeiro cenário bloqueado na ordem canônica.",
    recommendationPriority: "Execute o cenário não executado de maior prioridade.",
    recommendationCanonical: "Continue com o próximo cenário não executado na ordem canônica.",
    scenarioFocus: "Foco do cenário",
    scenarioPosition: "Cenário {current} de {total}",
    focusedScenario: "Cenário em foco",
    supportingDetails: "Preparação, entradas e detalhes de apoio",
    beforeYouRun: "Antes de executar",
    blockerReason: "Bloqueio",
    unblockNeeded: "Necessário para desbloquear",
    recordBlocker: "Registre o motivo do bloqueio nas notas da execução abaixo.",
    recordUnblock: "Registre a dependência ou ação necessária para desbloquear este cenário.",
    expected: "Esperado",
    observed: "Observado",
    recordObserved: "Registre o resultado observado nas notas da execução abaixo.",
    result: "Resultado",
    setResult: "Definir resultado local do cenário",
    markNotRun: "Marcar como não executado",
    resultHint: "Escolha um resultado após conferir o resultado esperado e a evidência necessária.",
    focusScenario: "Focar cenário",
    referencesAndContext: "Material de referência",
    statuses: { not_run: "Não executado", passed: "Aprovado", failed: "Reprovado", blocked: "Bloqueado", skipped: "Ignorado" },
    statusIcons: { not_run: "○", passed: "✓", failed: "×", blocked: "!", skipped: "—" },
    labels: {
      covered: "Coberto", partial: "Parcial", no_scenario: "Sem cenário", not_manually_testable: "Não testável manualmente",
      out_of_scope: "Fora do escopo", blocked: "Bloqueado", critical: "Crítica", high: "Alta", medium: "Média", low: "Baixa",
      functional_qa: "QA funcional", technical_qa: "QA técnico", stakeholder: "Parte interessada", mixed: "Misto",
      developer: "Desenvolvedor", product_owner: "Responsável de produto", analyst: "Analista", business_user: "Usuário de negócio",
      smoke: "Smoke", functional: "Funcional", integration: "Integração", acceptance: "Aceitação", negative: "Negativo", regression: "Regressão",
      concise: "Concisa", detailed: "Detalhada", guided: "Guiada", existing_data: "Dados existentes", fixture: "Fixture", factory: "Factory",
      seed: "Seed", manual: "Manual", api: "API", sql: "SQL", helper_script: "Script auxiliar", not_determined: "Não determinado",
      reused: "Reutilizado", required: "Necessário", not_needed: "Desnecessário", requirement: "Requisito", acceptance_criterion: "Critério de aceitação",
      task: "Tarefa", risk: "Risco", slice: "Slice", screenshot: "Captura de tela", video: "Vídeo", request_response: "Requisição e resposta",
      logs: "Logs", generated_ids: "IDs gerados", database_result: "Resultado no banco de dados", visual_result: "Resultado visual", status_http: "Status HTTP",
      events: "Eventos", message_to_user: "Mensagem ao usuário", global_plan: "Plano global", approved_plan: "Plano aprovado",
      global_progress: "Progresso global", execution_evidence: "Evidência de execução", spec_index: "Índice da SPEC", acceptance_criteria: "Critérios de aceitação",
      requirements: "Requisitos", risks: "Riscos", existing_fixture: "Fixture existente", configuration: "Configuração", documentation: "Documentação",
      TASK: "Task", SLICE: "Slice", MULTI_SLICE: "Vários slices", EXECUTION: "Execução", SPEC: "SPEC", CUSTOM: "Personalizado",
      decision_required: "Decisão necessária", not_executable: "Não executável",
    },
  },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function genericLabel(value) {
  const acronyms = new Map([
    ["Api", "API"], ["Http", "HTTP"], ["Id", "ID"], ["Ids", "IDs"],
    ["Qa", "QA"], ["Sql", "SQL"], ["Ui", "UI"], ["Utc", "UTC"],
  ]);
  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase())
    .replace(/\b(?:Api|Http|Ids?|Qa|Sql|Ui|Utc)\b/gu, (term) => acronyms.get(term));
}

function uiLabel(value, messages) {
  return messages.labels[value] ?? genericLabel(value);
}

function list(values, empty) {
  if (values.length === 0) return `<p class="empty-state">${escapeHtml(empty)}</p>`;
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function detailList(items, empty, messages) {
  if (items.length === 0) return `<p class="empty-state">${escapeHtml(empty)}</p>`;
  return `<ul class="detail-list">${items.map((item) => `<li><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>${item.kind === undefined ? "" : `<span class="tag">${escapeHtml(uiLabel(item.kind, messages))}</span>`}</li>`).join("")}</ul>`;
}

function scenarioSection(title, values, empty, className = "presentation-secondary") {
  if (values.length === 0) return "";
  return `<section class="scenario-subsection ${className}"><h4>${escapeHtml(title)}</h4>${list(values, empty)}</section>`;
}

function originList(origins, messages) {
  return origins.map((origin) => `<li><span class="origin-kind">${escapeHtml(uiLabel(origin.kind, messages))}</span><code>${escapeHtml(origin.ref)}</code>${origin.label === undefined ? "" : `<span>${escapeHtml(origin.label)}</span>`}</li>`).join("");
}

function inputList(inputs, messages) {
  if (inputs.length === 0) return "";
  return `<section class="scenario-subsection presentation-secondary"><h4>${messages.inputs}</h4><dl class="input-list">${inputs.map((input) => `<div><dt><code>${escapeHtml(input.name)}</code></dt><dd>${input.sensitive ? messages.sensitiveInput : escapeHtml(input.value)}</dd></div>`).join("")}</dl></section>`;
}

function steps(scenario, messages) {
  return `<section class="scenario-subsection steps-section"><h4>${messages.executionSteps}</h4><ol class="steps">${scenario.steps.map((step, index) => `<li><div class="step-index"><span class="visually-hidden">${messages.step} </span>${String(index + 1).padStart(2, "0")}</div><div class="step-action"><p class="step-label">${messages.action}</p><p>${escapeHtml(step.action)}</p></div><div class="step-expected"><p class="step-label">${messages.expectedResult}</p><p>${escapeHtml(step.expected)}</p>${step.evidence.length === 0 ? "" : `<div class="step-evidence"><span>${messages.evidence}</span><ul class="inline-list">${step.evidence.map((entry) => `<li>${escapeHtml(uiLabel(entry, messages))}</li>`).join("")}</ul></div>`}</div></li>`).join("")}</ol></section>`;
}

function statusBadge(status, messages) {
  return `<span class="status-badge status-${status}" data-status-badge><span data-status-icon aria-hidden="true">${messages.statusIcons[status]}</span><span data-status-label>${messages.statuses[status]}</span></span>`;
}

function statusLegend(messages, scenarios, className = "") {
  return `<ul class="status-legend ${className}" aria-label="${messages.semanticLegend}">${Object.entries(messages.statuses).map(([status, text]) => `<li class="legend-${status}"><span aria-hidden="true">${messages.statusIcons[status]}</span><span>${text}</span><strong data-count-status="${status}">${scenarios.filter((scenario) => scenario.initial_status === status).length}</strong></li>`).join("")}</ul>`;
}

function nextRecommended(scenarios) {
  const first = (predicate) => scenarios.find(predicate);
  return first((scenario) => scenario.initial_status === "failed")
    ?? first((scenario) => scenario.initial_status === "blocked" && scenario.preparation.length > 0)
    ?? first((scenario) => scenario.initial_status === "not_run" && ["critical", "high"].includes(scenario.criticality))
    ?? first((scenario) => scenario.initial_status === "not_run")
    ?? first((scenario) => scenario.initial_status === "blocked")
    ?? null;
}

function recommendationReason(scenario, messages) {
  if (scenario === null) return messages.allCompleteDetail;
  if (scenario.initial_status === "failed") return messages.recommendationFailed;
  if (scenario.initial_status === "blocked") return messages.recommendationBlocked;
  if (["critical", "high"].includes(scenario.criticality)) return messages.recommendationPriority;
  return messages.recommendationCanonical;
}

function scenarioRow(scenario, typeKeys, messages, index, total) {
  const blocker = scenario.initial_status === "blocked" ? (scenario.known_issues[0] ?? scenario.preconditions[0]) : undefined;
  return `<li data-scenario-row="${scenario.id}" data-status="${scenario.initial_status}" data-criticality="${scenario.criticality}" data-type-keys="${typeKeys.join(" ")}"><a href="#${scenario.id}" data-scenario-link><span class="row-status">${statusBadge(scenario.initial_status, messages)}</span><code>${scenario.id}</code><span class="row-title">${escapeHtml(scenario.title)}</span><span class="criticality criticality-${scenario.criticality}">${escapeHtml(uiLabel(scenario.criticality, messages))}</span><span class="row-type">${escapeHtml(uiLabel(scenario.types[0], messages))}</span><span class="row-position">${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span>${blocker === undefined ? "" : `<small class="row-attention"><span aria-hidden="true">!</span>${escapeHtml(blocker)}</small>`}</a></li>`;
}

function scenarioCard(scenario, typeKeys, messages, previous, next, index, total) {
  const statusOptions = Object.entries(messages.statuses).map(([value, text]) => `<option value="${value}"${value === scenario.initial_status ? " selected" : ""}>${text}</option>`).join("");
  const types = scenario.types.map((type) => `<li>${escapeHtml(uiLabel(type, messages))}</li>`).join("");
  const expected = scenario.steps.at(-1).expected;
  const initiallyBlocked = scenario.initial_status === "blocked";
  const blocker = initiallyBlocked ? scenario.known_issues[0] ?? messages.recordBlocker : messages.recordBlocker;
  const unblock = initiallyBlocked ? scenario.preparation[0] ?? messages.recordUnblock : messages.recordUnblock;
  return `<article class="scenario" id="${scenario.id}" data-scenario-id="${scenario.id}" data-scenario-title="${escapeHtml(scenario.title)}" data-scenario-objective="${escapeHtml(scenario.objective)}" data-scenario-type="${escapeHtml(uiLabel(scenario.types[0], messages))}" data-status="${scenario.initial_status}" data-initial-status="${scenario.initial_status}" data-criticality="${scenario.criticality}" data-criticality-label="${escapeHtml(uiLabel(scenario.criticality, messages))}" data-type-keys="${typeKeys.join(" ")}" data-actionable-blocked="${String(initiallyBlocked && scenario.preparation.length > 0)}">
  <div class="scenario-lead">
  <header class="scenario-header">
    <div class="scenario-intro"><div class="eyebrow"><span data-scenario-position>${messages.scenarioPosition.replace("{current}", String(index + 1).padStart(2, "0")).replace("{total}", String(total).padStart(2, "0"))}</span><code>${scenario.id}</code><span>${escapeHtml(scenario.domain)}</span></div><h3>${escapeHtml(scenario.title)}</h3><p>${escapeHtml(scenario.objective)}</p><div class="scenario-type-line"><span>${messages.scenarioTypes}</span><ul class="inline-list">${types}</ul></div></div>
    <div class="scenario-badges">${statusBadge(scenario.initial_status, messages)}<span class="criticality criticality-${scenario.criticality}"><span aria-hidden="true">◆</span>${escapeHtml(uiLabel(scenario.criticality, messages))}</span></div>
  </header>
  <p class="status-print">${messages.executionStatus}: <strong data-status-print>${messages.statuses[scenario.initial_status]}</strong></p>
  <section class="status-context failed-context" aria-live="polite"><div><span>${messages.expected}</span><strong>${escapeHtml(expected)}</strong></div><div><span>${messages.observed}</span><strong data-observed-value>${messages.recordObserved}</strong></div></section>
  <section class="status-context blocked-context" aria-live="polite"><div><span>${messages.blockerReason}</span><strong data-blocker-value>${escapeHtml(blocker)}</strong></div><div><span>${messages.unblockNeeded}</span><strong data-unblock-value>${escapeHtml(unblock)}</strong></div></section>
  </div>
  <div class="scenario-body" id="${scenario.id}-body">
    <div class="scenario-columns scenario-foundation">
      <section class="scenario-subsection"><h4>${messages.beforeYouRun}</h4>${list(scenario.preconditions, messages.notDetermined)}</section>
      <section class="scenario-subsection environment-line"><h4>${messages.environment}</h4><p>${escapeHtml(scenario.environment ?? messages.notDetermined)}</p></section>
    </div>
    ${steps(scenario, messages)}
    <div class="scenario-columns evidence-result">
      <section class="scenario-subsection"><h4>${messages.evidenceExpected}</h4><ul class="inline-list evidence-list">${scenario.evidence.map((entry) => `<li>${escapeHtml(uiLabel(entry, messages))}</li>`).join("")}</ul></section>
      ${scenarioSection(messages.approvalCriteria, scenario.approval_criteria, messages.notDetermined, "")}
    </div>
    <section class="execution-capture operational-only" aria-label="${messages.localNotesRegion} ${scenario.id}">
      <div class="local-only-callout"><strong>${messages.localOnly}</strong> ${messages.localOnlyDetail}</div>
      <label>${messages.executionNotes}<textarea rows="4" data-notes placeholder="${messages.executionNotesPlaceholder}"></textarea></label>
      <p class="print-value" data-notes-print></p>
      <label>${messages.evidenceReferences}<textarea rows="3" data-evidence-notes placeholder="${messages.evidencePlaceholder}"></textarea></label>
      <p class="print-value" data-evidence-print></p>
    </section>
    <section class="result-controls operational-only" aria-label="${messages.setResult} ${scenario.id}"><div><p class="section-kicker">${messages.result}</p><h4>${messages.setResult}</h4><p>${messages.resultHint}</p></div><div class="result-buttons">${["passed", "failed", "blocked", "skipped"].map((status) => `<button type="button" class="result-button result-${status}" data-result="${status}" aria-pressed="${String(scenario.initial_status === status)}"><span aria-hidden="true">${messages.statusIcons[status]}</span>${messages.statuses[status]}</button>`).join("")}<button type="button" class="result-button result-not_run" data-result="not_run" aria-pressed="${String(scenario.initial_status === "not_run")}"><span aria-hidden="true">${messages.statusIcons.not_run}</span>${messages.markNotRun}</button></div><select hidden tabindex="-1" aria-hidden="true" data-scenario-status>${statusOptions}</select></section>
    <details class="support-details presentation-secondary"><summary>${messages.supportingDetails}</summary><div class="support-content">
      <section class="scenario-subsection traceability"><h4>${messages.traceability}</h4><ul class="origin-list">${originList(scenario.origins, messages)}</ul></section>
      ${scenarioSection(messages.preparation, scenario.preparation, messages.notDetermined)}
      ${inputList(scenario.inputs, messages)}
      <div class="scenario-columns scenario-details">${scenarioSection(messages.cleanup, scenario.cleanup, messages.notDetermined)}${scenarioSection(messages.relatedRegressions, scenario.regressions, messages.notDetermined)}${scenarioSection(messages.risks, scenario.risks, messages.notDetermined, "")}${scenarioSection(messages.knownIssues, scenario.known_issues, messages.notDetermined, "")}${scenarioSection(messages.sourceNotes, scenario.notes, messages.notDetermined)}</div>
    </div></details>
    <nav class="scenario-pager operational-only" aria-label="${messages.scenarioIndex}">${previous === undefined ? "<span></span>" : `<a href="#${previous.id}" data-scenario-link><small>${messages.previousScenario}</small><strong>${previous.id}</strong></a>`}${next === undefined ? "" : `<a href="#${next.id}" data-scenario-link><small>${messages.nextScenario}</small><strong>${next.id}</strong></a>`}</nav>
  </div>
</article>`;
}

function coverageTable(items, messages) {
  if (items.length === 0) return `<p class="empty-state">${messages.noCoverage}</p>`;
  return `<div class="table-scroll"><table class="coverage-table"><thead><tr><th>${messages.source}</th><th>${messages.coverage}</th><th>${messages.scenarios}</th><th>${messages.rationale}</th></tr></thead><tbody>${items.map((item) => `<tr><th scope="row"><code>${escapeHtml(item.source_id)}</code><span>${escapeHtml(item.title)}</span></th><td data-label="${messages.coverage}"><span class="coverage-status coverage-${item.status}">${escapeHtml(uiLabel(item.status, messages))}</span></td><td data-label="${messages.scenarios}">${item.scenario_ids.length === 0 ? "—" : item.scenario_ids.map((id) => `<a href="#${id}" data-scenario-link>${id}</a>`).join(", ")}</td><td data-label="${messages.rationale}">${escapeHtml(item.rationale)}</td></tr>`).join("")}</tbody></table></div>`;
}

function sourceList(sources, messages) {
  return `<ul class="source-list">${sources.map((source) => `<li><code>${escapeHtml(source.path)}</code><span>${escapeHtml(uiLabel(source.role, messages))}</span>${source.ids.length === 0 ? "" : `<small>${source.ids.map((id) => escapeHtml(id)).join(", ")}</small>`}</li>`).join("")}</ul>`;
}

function preparationList(items, messages) {
  if (items.length === 0) return `<p class="empty-state">${messages.noDataPreparation}</p>`;
  return `<ul class="detail-list preparation-list">${items.map((item) => `<li><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.instructions)}</p>${item.source === undefined ? "" : `<p><strong>${messages.reuse}:</strong> <code>${escapeHtml(item.source)}</code></p>`}</div><div class="card-topline"><span class="tag">${escapeHtml(uiLabel(item.method, messages))}</span><span class="tag tag-${item.status}">${escapeHtml(uiLabel(item.status, messages))}</span></div></li>`).join("")}</ul>`;
}

function helperTable(items, messages) {
  if (items.length === 0) return "";
  return `<section id="helpers" class="content-section presentation-hide"><div class="section-heading"><div><span class="section-kicker">${messages.optionalSupport}</span><h2>${messages.helperArtifacts}</h2></div></div><div class="table-scroll"><table><thead><tr><th>${messages.path}</th><th>${messages.purpose}</th><th>${messages.cleanup}</th></tr></thead><tbody>${items.map((item) => `<tr><th scope="row"><code>${escapeHtml(item.path)}</code></th><td>${escapeHtml(item.purpose)}</td><td>${item.cleanup === undefined ? messages.manualOrNA : `<code>${escapeHtml(item.cleanup)}</code>`}</td></tr>`).join("")}</tbody></table></div><p class="section-note">${messages.helperBoundary}</p></section>`;
}

function clientMessages(messages, locale) {
  return {
    locale,
    statuses: messages.statuses,
    statusIcons: messages.statusIcons,
    visible: messages.scenariosVisible,
    notes: messages.executionNotes,
    evidence: messages.evidenceReferences,
    resetConfirm: messages.resetConfirm,
    recommendationFailed: messages.recommendationFailed,
    recommendationBlocked: messages.recommendationBlocked,
    recommendationPriority: messages.recommendationPriority,
    recommendationCanonical: messages.recommendationCanonical,
    allComplete: messages.allComplete,
    allCompleteDetail: messages.allCompleteDetail,
    recordObserved: messages.recordObserved,
    recordBlocker: messages.recordBlocker,
    recordUnblock: messages.recordUnblock,
  };
}

export function renderRunbook(manifest) {
  const locale = manifest.configuration.locale;
  const messages = MESSAGES[locale];
  if (messages === undefined) throw new Error(`unsupported runbook locale: ${String(locale)}`);
  const criticalCount = manifest.scenarios.filter((scenario) => scenario.criticality === "critical").length;
  const blockedCount = manifest.scenarios.filter((scenario) => scenario.initial_status === "blocked").length;
  const types = [...new Set(manifest.scenarios.flatMap((scenario) => scenario.types))].sort();
  const typeKey = new Map(types.map((type, index) => [type, `type-${index}`]));
  const scenarioRows = manifest.scenarios.map((scenario, index) => scenarioRow(
    scenario,
    scenario.types.map((type) => typeKey.get(type)),
    messages,
    index,
    manifest.scenarios.length,
  )).join("");
  const scenarioHtml = manifest.scenarios.map((scenario, index) => scenarioCard(
    scenario,
    scenario.types.map((type) => typeKey.get(type)),
    messages,
    manifest.scenarios[index - 1],
    manifest.scenarios[index + 1],
    index,
    manifest.scenarios.length,
  )).join("\n");
  const scopeSelection = Object.keys(manifest.scope.selection).length === 0 ? messages.completeScope : canonicalJson(manifest.scope.selection);
  const navigation = [
    ["overview", messages.overview], ["next-action", messages.nextAction], ["scenarios", messages.scenarios],
    ["setup", messages.setup], ["data", messages.testData], ["coverage", messages.coverage], ["risks", messages.risksGaps], ["sources", messages.sources],
  ];
  if (manifest.helper_artifacts.length !== 0) navigation.splice(7, 0, ["helpers", messages.helpers]);
  const initialComplete = manifest.scenarios.filter((scenario) => ["passed", "skipped"].includes(scenario.initial_status)).length;
  const initiallyFailed = manifest.scenarios.some((scenario) => scenario.initial_status === "failed");
  const initiallyPassed = manifest.scenarios.length > 0 && manifest.scenarios.every((scenario) => ["passed", "skipped"].includes(scenario.initial_status));
  const initialOverallKey = initiallyFailed
    ? "failed"
    : blockedCount > 0
      ? "blocked"
      : initiallyPassed
        ? "passed"
        : "not_run";
  const initialOverall = messages.statuses[initialOverallKey];
  const recommended = nextRecommended(manifest.scenarios);
  const recommendedReason = recommendationReason(recommended, messages);
  const ui = JSON.stringify(clientMessages(messages, locale));

  const compose = (fingerprint) => `<!doctype html>
<!-- stnl-spec-test-runbook:v1 fingerprint:${fingerprint} -->
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(manifest.title)} · ${messages.documentTitle}</title>
  <style>${STYLES}</style>
</head>
<body data-view="operational">
  <a class="skip-link" href="#main-content">${messages.skip}</a>
  <header class="hero" id="overview">
    <div class="hero-inner">
      <div class="hero-copy"><div class="product-mark"><span class="mark" aria-hidden="true">S</span><span>${messages.product}</span></div><p class="hero-kicker">${escapeHtml(uiLabel(manifest.scope.kind, messages))} · ${messages.validation}</p><h1>${escapeHtml(manifest.title)}</h1><p class="hero-summary">${escapeHtml(manifest.summary)}</p></div>
      <div class="hero-outcome" aria-live="polite"><span class="hero-outcome-label">${messages.overallStatus}</span><strong class="overall-value status-${initialOverallKey}" data-overall-status>${initialOverall}</strong><div class="hero-progress"><progress max="${manifest.scenarios.length}" value="${initialComplete}" data-progress-bar aria-label="${messages.progress}"></progress><span><b data-progress>${initialComplete}/${manifest.scenarios.length}</b> ${messages.scenariosComplete}</span></div></div>
      <dl class="hero-meta"><div><dt>${messages.scope}</dt><dd>${escapeHtml(uiLabel(manifest.scope.kind, messages))}</dd></div><div><dt>${messages.environment}</dt><dd>${escapeHtml(manifest.configuration.environment ?? messages.notDetermined)}</dd></div><div><dt>${messages.locale}</dt><dd><code>${locale}</code></dd></div><div><dt>${messages.selection}</dt><dd><code>${escapeHtml(scopeSelection)}</code></dd></div></dl>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="${messages.tools}" data-open="false">
      <button type="button" class="sidebar-toggle" aria-expanded="false" aria-controls="sidebar-body"><span>${messages.tools}</span><span aria-hidden="true">☰</span></button>
      <div class="sidebar-body" id="sidebar-body">
        <nav aria-label="${messages.runbookSections}" class="section-nav"><p class="sidebar-label">${messages.contents}</p><ul>${navigation.map(([id, text]) => `<li><a href="#${escapeHtml(id)}" data-section-link>${escapeHtml(text)}</a></li>`).join("")}</ul></nav>
        <div class="filter-panel operational-only">
          <p class="sidebar-label">${messages.findScenarios}</p>
          <label for="scenario-search">${messages.search}</label><input id="scenario-search" type="search" placeholder="${messages.searchPlaceholder}" autocomplete="off">
          <div class="filter-grid"><label>${messages.status}<select id="status-filter"><option value="">${messages.allStatuses}</option>${Object.entries(messages.statuses).map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}</select></label>
          <label>${messages.testType}<select id="type-filter"><option value="">${messages.allTypes}</option>${types.map((type) => `<option value="${typeKey.get(type)}">${escapeHtml(uiLabel(type, messages))}</option>`).join("")}</select></label>
          <label>${messages.criticality}<select id="criticality-filter"><option value="">${messages.allCriticalities}</option>${CRITICALITY_ORDER.map((entry) => `<option value="${entry}">${escapeHtml(uiLabel(entry, messages))}</option>`).join("")}</select></label></div>
          <p class="results sidebar-results" aria-hidden="true">${messages.scenariosVisible.replace("{visible}", manifest.scenarios.length).replace("{total}", manifest.scenarios.length)}</p>
          <div class="button-row"><button type="button" class="quiet-button" id="expand-all">${messages.expandAll}</button><button type="button" class="quiet-button" id="collapse-all">${messages.collapseAll}</button></div>
        </div>
        <div class="local-panel operational-only">
          <label class="check-label"><input id="persist-state" type="checkbox"> <span>${messages.rememberState}</span></label>
          <p>${messages.stateBoundary}</p>
          <button type="button" class="danger-button" id="reset-state">${messages.resetState}</button>
        </div>
      </div>
    </aside>
    <button type="button" class="drawer-scrim" data-drawer-scrim aria-label="${messages.collapseDetails}" tabindex="-1"></button>
    <main id="main-content" tabindex="-1">
      <div class="view-switch" role="group" aria-label="${messages.mode}">
        <span>${messages.mode}</span><button type="button" class="view-button active" data-view-button="operational" aria-pressed="true">${messages.operational}</button>${manifest.configuration.presentation ? `<button type="button" class="view-button" data-view-button="presentation" aria-pressed="false">${messages.presentation}</button>` : ""}
      </div>
      <section id="next-action" class="next-action" data-next-action data-next-action-id="${recommended?.id ?? ""}"><div class="next-symbol" aria-hidden="true">→</div><div class="next-copy"><span class="section-kicker">${messages.nextRecommended}</span><div class="next-title"><code data-next-id>${recommended?.id ?? "✓"}</code><h2 data-next-title>${recommended === null ? messages.allComplete : escapeHtml(recommended.title)}</h2></div><p data-next-objective>${recommended === null ? messages.allCompleteDetail : escapeHtml(recommended.objective)}</p><p class="next-reason" data-next-reason>${recommendedReason}</p></div><div class="next-meta"><span class="criticality criticality-${recommended?.criticality ?? "low"}" data-next-criticality>${recommended === null ? messages.statuses.passed : escapeHtml(uiLabel(recommended.criticality, messages))}</span><span data-next-type>${recommended === null ? "" : escapeHtml(uiLabel(recommended.types[0], messages))}</span><a class="primary-action" href="#${recommended?.id ?? "scenarios"}" data-next-link data-scenario-link>${messages.openScenario}<span aria-hidden="true">→</span></a></div></section>
      <section id="summary" class="content-section overview-section">
        <div class="section-heading"><div><span class="section-kicker">${messages.atAGlance}</span><h2>${messages.validationOverview}</h2></div><p class="overall-status">${messages.overallStatus}: <strong id="overall-status" class="status-text-${initialOverallKey}">${initialOverall}</strong></p></div>
        <div class="presentation-only presentation-callout"><strong>${messages.presentationSummary}</strong><span>${messages.presentationSummaryText}</span></div>
        <div class="summary-flow"><div class="progress-reading"><strong data-progress>${initialComplete}/${manifest.scenarios.length}</strong><span>${messages.scenariosComplete}</span><progress max="${manifest.scenarios.length}" value="${initialComplete}" data-progress-bar aria-label="${messages.progress}"></progress></div>${statusLegend(messages, manifest.scenarios)}<dl class="summary-facts"><div><dt>${messages.critical}</dt><dd>${criticalCount}</dd></div><div><dt>${messages.coverageRecords}</dt><dd>${manifest.coverage.length}</dd></div><div><dt>${messages.testType}</dt><dd>${manifest.configuration.test_types.map((entry) => escapeHtml(uiLabel(entry, messages))).join(", ")}</dd></div></dl></div>
      </section>
      <section id="scenarios" class="scenarios-section"><div class="section-heading"><div><span class="section-kicker">${messages.operationalSequence}</span><h2>${messages.testScenarios}</h2></div><p>${messages.stableOrder}</p></div><div class="scenario-workbench"><nav class="scenario-directory" aria-label="${messages.scenarioIndex}"><div class="directory-heading"><span>${messages.scenarioIndex}</span><strong id="filter-results" aria-live="polite">${messages.scenariosVisible.replace("{visible}", manifest.scenarios.length).replace("{total}", manifest.scenarios.length)}</strong></div><p id="no-scenarios" class="empty-state" hidden>${messages.noMatches}</p><ol>${scenarioRows}</ol></nav><div class="scenario-focus" aria-label="${messages.focusedScenario}"><span class="focus-label">${messages.scenarioFocus}</span><div class="scenario-list">${scenarioHtml}</div></div></div></section>
      <div class="reference-deck" aria-label="${messages.referencesAndContext}">
        <details id="setup" class="reference-section presentation-hide"><summary><span><small>${messages.beforeExecution}</small>${messages.environmentSetup}</span><span aria-hidden="true">＋</span></summary><div class="reference-content">${detailList(manifest.setup, messages.noSetup, messages)}</div></details>
        <details id="data" class="reference-section presentation-hide"><summary><span><small>${messages.preparation}</small>${messages.testData}</span><span aria-hidden="true">＋</span></summary><div class="reference-content">${preparationList(manifest.data_preparation, messages)}</div></details>
        <details id="coverage" class="reference-section presentation-essential"><summary><span><small>${messages.traceability}</small>${messages.coverageMatrix}</span><span aria-hidden="true">＋</span></summary><div class="reference-content"><p class="section-note">${messages.noPercentages}</p>${coverageTable(manifest.coverage, messages)}</div></details>
        <details id="risks" class="reference-section presentation-essential"><summary><span><small>${messages.decisionSurface}</small>${messages.risksKnownGaps}</span><span aria-hidden="true">＋</span></summary><div class="reference-content risk-grid"><div><h3>${messages.risks}</h3>${detailList(manifest.risks, messages.noRisk, messages)}</div><div><h3>${messages.knownIssues}</h3>${detailList(manifest.known_issues, messages.noKnownIssue, messages)}</div><div><h3>${messages.informationGaps}</h3>${detailList(manifest.gaps, messages.noGap, messages)}</div><div><h3>${messages.globalCleanup}</h3>${detailList(manifest.cleanup, messages.noCleanup, messages)}</div></div></details>
      </div>
      ${helperTable(manifest.helper_artifacts, messages)}
      <details id="sources" class="reference-section presentation-hide"><summary><span><small>${messages.provenance}</small>${messages.sourcesUsed}</span><span aria-hidden="true">＋</span></summary><div class="reference-content">${sourceList(manifest.sources, messages)}<p class="section-note">${messages.sourceBoundary}</p></div></details>
    </main>
  </div>
  <footer><p>${messages.offline} · ${messages.fingerprint} <code>${fingerprint.slice(0, 12)}</code></p><a href="#overview">${messages.backToTop}</a></footer>
  <script>${clientScript(ui).replaceAll("__FINGERPRINT__", fingerprint)}</script>
</body>
</html>
`;
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  const html = compose(fingerprint);
  return { html, fingerprint };
}

const STYLES = String.raw`
main{min-width:0}
body[data-view="presentation"] .operational-only{display:none}
@media(max-width:1179px){.sidebar[data-open="true"]{z-index:52;border-color:transparent;background:transparent;pointer-events:none}.sidebar[data-open="true"] .sidebar-toggle{visibility:hidden}.sidebar[data-open="true"] .sidebar-body{pointer-events:auto}}
:root{--ink:#1d1d1f;--muted:#6e6e73;--subtle:#8a8a8e;--paper:#fff;--canvas:#f5f5f7;--line:#d9d9de;--line-soft:#ececef;--blue:#0066cc;--blue-soft:#eef6ff;--green:#18794e;--green-soft:#eaf7ef;--red:#c9272c;--red-soft:#fff0f0;--amber:#9a5b00;--amber-soft:#fff6e5;--purple:#7357a6;--purple-soft:#f5f0ff;--focus:#005fcc;--radius:14px;--reading:88rem}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;overflow-x:clip;color:var(--ink);background:var(--paper);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.47;-webkit-font-smoothing:antialiased}a{color:var(--blue);text-underline-offset:3px}button,input,select,textarea{font:inherit}button,input,select,textarea,a,summary{outline-offset:3px}:focus-visible{outline:3px solid var(--focus)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;overflow-wrap:anywhere}.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.skip-link{position:fixed;z-index:100;top:8px;left:8px;transform:translateY(-160%);padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:#fff;color:#000}.skip-link:focus{transform:none}
.hero{border-bottom:1px solid var(--line-soft);background:#fff}.hero-inner{width:min(100%,1540px);margin:auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,.34fr);grid-template-areas:"copy outcome" "meta outcome";gap:12px clamp(28px,4vw,64px);padding:24px clamp(24px,4vw,64px) 20px}.hero-copy{grid-area:copy;min-width:0}.product-mark{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.69rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--ink);color:#fff;font-weight:750}.hero-kicker,.section-kicker{margin:10px 0 3px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-size:.67rem;font-weight:750}.hero h1{max-width:900px;margin:0;font-size:clamp(1.65rem,2.5vw,2.65rem);line-height:1.08;letter-spacing:-.035em;overflow-wrap:anywhere}.hero-summary{max-width:820px;margin:7px 0 0;color:var(--muted);font-size:.92rem}.hero-outcome{grid-area:outcome;align-self:center;padding-left:24px;border-left:1px solid var(--line)}.hero-outcome-label{display:block;color:var(--muted);font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em}.overall-value{display:inline-flex;align-items:center;margin-top:4px;padding:4px 9px;border-radius:999px;font-size:1rem}.hero-progress{margin-top:14px}.hero-progress progress,.progress-reading progress{display:block;width:100%;height:5px;border:0;border-radius:99px;overflow:hidden;background:var(--line-soft);accent-color:var(--blue)}progress::-webkit-progress-bar{background:var(--line-soft)}progress::-webkit-progress-value{background:var(--blue)}progress::-moz-progress-bar{background:var(--blue)}.hero-progress span{display:block;margin-top:6px;color:var(--muted);font-size:.73rem}.hero-progress b{color:var(--ink)}.hero-meta{grid-area:meta;display:flex;align-items:start;gap:0;margin:0;min-width:0}.hero-meta div{min-width:0;padding:0 16px;border-left:1px solid var(--line)}.hero-meta div:first-child{padding-left:0;border-left:0}.hero-meta dt{color:var(--subtle);font-size:.61rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase}.hero-meta dd{max-width:360px;margin:2px 0 0;color:#444446;font-size:.75rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.layout{width:min(100%,1540px);margin:auto;display:grid;grid-template-columns:12.5rem minmax(0,var(--reading));justify-content:center;align-items:start;gap:clamp(24px,3vw,48px);padding:20px clamp(24px,4vw,64px) 48px}.sidebar{position:sticky;z-index:30;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;padding:8px 18px 16px 0;border-right:1px solid var(--line-soft)}.sidebar-toggle,.drawer-scrim{display:none}.sidebar-body{display:grid;gap:18px}.sidebar-label{margin:0 0 7px;color:var(--subtle);font-size:.62rem;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.section-nav ul{list-style:none;margin:0;padding:0}.section-nav a{display:block;padding:6px 0;color:#4b4b4e;font-size:.78rem;text-decoration:none}.section-nav a:hover,.section-nav a[aria-current="location"]{color:var(--blue)}.filter-panel,.local-panel{padding-top:16px;border-top:1px solid var(--line-soft)}.filter-panel>label,.filter-grid label,.local-panel>label{display:block;margin:8px 0 4px;font-size:.72rem;font-weight:650}.filter-panel input,.filter-panel select,textarea{width:100%;min-height:40px;border:1px solid #b8b8bd;border-radius:9px;background:#fff;color:var(--ink);padding:7px 9px}.filter-grid{display:grid;gap:2px}.results,.local-panel p{color:var(--muted);font-size:.7rem}.sidebar-results{display:none}.button-row{display:flex;gap:6px;flex-wrap:wrap}.quiet-button,.danger-button,.view-button,.sidebar-toggle{min-height:38px;border:1px solid #b8b8bd;border-radius:9px;background:#fff;color:var(--ink);padding:7px 10px;cursor:pointer}.quiet-button:hover,.view-button:hover,.sidebar-toggle:hover{border-color:var(--blue);color:var(--blue)}.danger-button{border-color:#e0a4a6;color:var(--red)}.check-label{display:flex!important;gap:8px;align-items:flex-start}.check-label input{width:17px;height:17px;margin:2px 0 0;flex:0 0 auto}
.view-switch{display:flex;align-items:center;justify-content:flex-end;gap:5px;width:max-content;max-width:100%;margin:0 0 13px auto;padding:3px;border-radius:10px;background:var(--canvas)}.view-switch>span{margin:0 5px;color:var(--muted);font-size:.69rem;font-weight:650}.view-button{min-height:34px;border:0;background:transparent;font-size:.73rem}.view-button.active{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.13)}
.content-section{scroll-margin-top:24px;padding:8px 0 26px;border-bottom:1px solid var(--line)}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:16px}.section-heading h2{margin:2px 0 0;font-size:clamp(1.25rem,1.7vw,1.62rem);letter-spacing:-.025em}.section-heading p{margin:0;color:var(--muted);font-size:.74rem}.section-kicker{margin:0}.overall-status{white-space:nowrap}.status-text-passed{color:var(--green)}.status-text-failed{color:var(--red)}.status-text-blocked{color:var(--amber)}.status-text-not_run,.status-text-skipped{color:var(--muted)}.presentation-only{display:none}.presentation-callout{margin-bottom:16px;padding:10px 0;border-bottom:1px solid var(--line-soft)}.presentation-callout strong,.presentation-callout span{display:block}.presentation-callout span{color:var(--muted);font-size:.8rem}
.summary-flow{display:grid;grid-template-columns:minmax(150px,.35fr) minmax(420px,1fr);gap:18px 32px;align-items:center}.progress-reading strong{display:block;font-size:2.35rem;line-height:1;letter-spacing:-.05em}.progress-reading span{display:block;margin:3px 0 10px;color:var(--muted);font-size:.75rem}.status-legend{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.status-legend li{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:5px;min-width:0;color:var(--muted);font-size:.71rem}.status-legend li>span:first-child{display:grid;place-items:center;width:17px;height:17px;border:1px solid currentColor;border-radius:50%;font-weight:800}.status-legend strong{color:var(--ink)}.legend-passed{color:var(--green)!important}.legend-failed{color:var(--red)!important}.legend-blocked{color:var(--amber)!important}.legend-not_run,.legend-skipped{color:var(--muted)!important}.summary-facts{grid-column:1/-1;display:flex;gap:0;margin:0;padding-top:14px;border-top:1px solid var(--line-soft)}.summary-facts div{padding:0 18px;border-left:1px solid var(--line-soft)}.summary-facts div:first-child{padding-left:0;border-left:0}.summary-facts div:last-child{min-width:0;flex:1}.summary-facts dt{color:var(--subtle);font-size:.61rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em}.summary-facts dd{margin:2px 0 0;color:#444446;font-size:.76rem;overflow-wrap:anywhere}
.next-action{scroll-margin-top:24px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:18px;margin:24px 0 38px;padding:18px 20px;border:1px solid #b8d8fa;border-radius:var(--radius);background:var(--blue-soft)}.next-symbol{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:var(--blue);color:#fff;font-size:1.25rem}.next-copy{min-width:0}.next-title{display:flex;align-items:baseline;gap:9px}.next-title h2{margin:0;font-size:1.14rem;letter-spacing:-.015em;overflow-wrap:anywhere}.next-title code{color:var(--blue);font-weight:750}.next-copy>p{margin:4px 0 0;color:#3f4c59;font-size:.8rem}.next-copy .next-reason{color:var(--blue);font-weight:650}.next-meta{display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap;max-width:320px;color:var(--muted);font-size:.72rem}.primary-action{display:inline-flex;align-items:center;gap:7px;min-height:42px;padding:9px 13px;border-radius:10px;background:var(--blue);color:#fff;font-weight:700;text-decoration:none}
.scenarios-section{scroll-margin-top:24px;margin-bottom:34px}.scenario-workbench{display:grid;grid-template-columns:minmax(250px,.34fr) minmax(0,1fr);align-items:start;gap:30px}.scenario-directory{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;border-top:1px solid var(--line)}.directory-heading{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;gap:8px;padding:10px 0 8px;background:#fff;color:var(--subtle);font-size:.62rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.directory-heading strong{font-weight:600;letter-spacing:0;text-transform:none}.scenario-directory ol{list-style:none;margin:0;padding:0}.scenario-directory li{border-bottom:1px solid var(--line-soft)}.scenario-directory a{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:7px;padding:11px 7px;color:var(--ink);text-decoration:none}.scenario-directory a:hover{background:var(--canvas)}.scenario-directory li.is-focused a{box-shadow:inset 3px 0 var(--blue);background:var(--blue-soft)}.scenario-directory code{font-size:.67rem;font-weight:750}.row-status .status-badge{width:22px;height:22px;justify-content:center;padding:0;border-radius:50%}.row-status [data-status-label]{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.row-title{min-width:0;font-size:.77rem;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-type,.row-position{display:none}.row-attention{grid-column:3/-1;display:flex;gap:5px;color:var(--amber);font-size:.66rem;line-height:1.3}.row-attention span{font-weight:800}.scenario-directory .criticality{padding:2px 5px;font-size:.6rem}.scenario-focus{min-width:0}.focus-label{display:block;margin-bottom:7px;color:var(--subtle);font-size:.62rem;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.scenario-list{min-width:0}.js .scenario-list .scenario:not(.is-focused){display:none}.scenario{scroll-margin-top:24px;min-width:0}.scenario[hidden]{display:none}.scenario-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;padding:0 0 19px;border-bottom:1px solid var(--line)}.scenario-intro{min-width:0}.scenario-header h3{margin:7px 0 6px;font-size:clamp(1.45rem,2.3vw,2.05rem);line-height:1.12;letter-spacing:-.035em;overflow-wrap:anywhere}.scenario-header p{max-width:780px;margin:0;color:#4b4b4e;font-size:.91rem;overflow-wrap:anywhere}.eyebrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:.69rem;font-weight:650}.eyebrow code{color:var(--blue);font-weight:750}.scenario-type-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;color:var(--muted);font-size:.68rem}.scenario-badges{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:230px}.tag,.coverage-status,.criticality,.status-badge{display:inline-flex;align-items:center;gap:5px;width:max-content;max-width:100%;border-radius:999px;padding:4px 8px;font-size:.67rem;font-weight:750}.status-not_run{background:#eeeeF0;color:#56565a}.status-passed{background:var(--green-soft);color:var(--green)}.status-failed{background:var(--red-soft);color:var(--red)}.status-blocked{background:var(--amber-soft);color:var(--amber)}.status-skipped{background:#eeeeF0;color:#56565a}.criticality-critical{background:var(--red-soft);color:var(--red)}.criticality-high{color:var(--red);border:1px solid #efb7b9}.criticality-medium{color:var(--amber);border:1px solid #e7c889}.criticality-low{color:var(--muted);border:1px solid var(--line)}.scenario-body{min-width:0}.status-print{display:none}.status-context{display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin-top:18px;border-radius:11px;overflow:hidden}.status-context div{padding:12px 14px}.status-context div+div{border-left:1px solid currentColor}.status-context span,.status-context strong{display:block}.status-context span{margin-bottom:3px;font-size:.62rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.status-context strong{font-size:.84rem}.scenario[data-status="failed"] .failed-context{display:grid;background:var(--red-soft);color:var(--red)}.scenario[data-status="blocked"] .blocked-context{display:grid;background:var(--amber-soft);color:var(--amber)}
.scenario-subsection{min-width:0;margin-top:21px}.scenario-subsection h4{margin:0 0 8px;color:var(--muted);font-size:.67rem;text-transform:uppercase;letter-spacing:.08em}.scenario-subsection p,.scenario-subsection ul{margin-top:0;overflow-wrap:anywhere}.scenario-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.scenario-foundation{padding-bottom:18px;border-bottom:1px solid var(--line-soft)}.scenario-foundation ul{padding-left:20px}.environment-line p{font-weight:600}.steps-section{margin-top:25px}.steps{list-style:none;margin:0;padding:0}.steps>li{min-width:0;display:grid;grid-template-columns:48px minmax(0,1fr) minmax(250px,.85fr);gap:18px;padding:18px 0;border-bottom:1px solid var(--line-soft)}.steps>li:first-child{border-top:1px solid var(--line-soft)}.step-index{color:var(--subtle);font-size:1.05rem;font-weight:650;letter-spacing:-.03em}.step-action,.step-expected{min-width:0}.step-action p,.step-expected p{margin:0;overflow-wrap:anywhere}.step-action>p:last-child{font-weight:600}.step-expected{padding-left:16px;border-left:2px solid var(--line)}.step-label{margin:0 0 5px!important;color:var(--muted);font-size:.62rem;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.step-evidence{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;color:var(--muted);font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.inline-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.inline-list li{max-width:100%;padding:3px 7px;border-radius:999px;background:#f0f0f2;color:#505054;font-size:.69rem;font-weight:550;overflow-wrap:anywhere}.evidence-list li{background:#f0f0f2;color:#505054}.evidence-result{padding-bottom:4px}.execution-capture{margin-top:23px;padding-top:19px;border-top:1px solid var(--line)}.execution-capture label{display:block;margin-top:11px;font-size:.73rem;font-weight:700}.execution-capture textarea{display:block;margin-top:5px;resize:vertical}.local-only-callout{color:var(--muted);font-size:.74rem}.local-only-callout strong{color:var(--ink)}.print-value{display:none}.result-controls{display:grid;grid-template-columns:minmax(190px,.35fr) minmax(0,1fr);align-items:end;gap:22px;margin-top:24px;padding:19px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.result-controls h4{margin:2px 0 4px;font-size:1rem}.result-controls p{margin:0;color:var(--muted);font-size:.72rem}.result-buttons{display:grid;grid-template-columns:repeat(4,minmax(92px,1fr));gap:7px}.result-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font-size:.73rem;font-weight:700;cursor:pointer}.result-button[aria-pressed="true"]{box-shadow:inset 0 0 0 2px currentColor}.result-passed{color:var(--green)}.result-failed{color:var(--red)}.result-blocked{color:var(--amber)}.result-skipped,.result-not_run{color:var(--muted)}.result-not_run{grid-column:1/-1;justify-self:end;min-height:34px;border:0}.support-details{margin-top:18px}.support-details summary{padding:10px 0;color:var(--blue);font-size:.76rem;font-weight:650;cursor:pointer}.support-content{padding:0 0 8px 18px;border-left:1px solid var(--line)}.origin-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.origin-list li{min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 7px;border-radius:999px;background:var(--purple-soft);color:var(--purple);font-size:.68rem;overflow-wrap:anywhere}.origin-kind{font-size:.58rem;font-weight:750;text-transform:uppercase}.input-list{margin:0}.input-list>div{display:grid;grid-template-columns:minmax(110px,.3fr) minmax(0,1fr);gap:12px;padding:8px 0;border-bottom:1px solid var(--line-soft)}.input-list dt,.input-list dd{margin:0}.input-list dd{font-size:.8rem}.scenario-details{gap:14px 28px}.scenario-pager{display:flex;justify-content:space-between;gap:12px;margin-top:18px}.scenario-pager a{display:flex;flex-direction:column;min-width:110px;padding:8px 0;text-decoration:none}.scenario-pager a:last-child{text-align:right}.scenario-pager small{color:var(--muted)}
.reference-deck{margin-top:20px;border-top:1px solid var(--line)}.reference-section{scroll-margin-top:24px;border-bottom:1px solid var(--line)}.reference-section>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 2px;cursor:pointer;font-size:.91rem;font-weight:650;list-style:none}.reference-section>summary::-webkit-details-marker{display:none}.reference-section>summary small{display:block;margin-bottom:1px;color:var(--subtle);font-size:.58rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.reference-section[open]>summary>span:last-child{transform:rotate(45deg)}.reference-content{padding:0 2px 20px}.detail-list,.source-list{list-style:none;margin:0;padding:0}.detail-list>li{display:flex;align-items:start;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--line-soft)}.detail-list>li:last-child{border-bottom:0}.detail-list p{margin:3px 0 0;color:#4b4b4e;font-size:.8rem}.tag{background:#f0f0f2;color:#55555a}.tag-reused,.tag-not_needed{background:var(--green-soft);color:var(--green)}.tag-required{background:var(--blue-soft);color:var(--blue)}.tag-blocked{background:var(--amber-soft);color:var(--amber)}.card-topline{display:flex;gap:6px;flex-wrap:wrap}.table-scroll{max-width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:9px}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:10px 11px;border-bottom:1px solid var(--line-soft);text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{color:var(--muted);font-size:.63rem;letter-spacing:.06em;text-transform:uppercase}tbody tr:last-child>*{border-bottom:0}tbody th span{display:block;margin-top:3px;font-weight:500;color:var(--muted)}.coverage-table{min-width:680px}.coverage-status{white-space:nowrap}.coverage-covered{background:var(--green-soft);color:var(--green)}.coverage-partial{background:var(--amber-soft);color:var(--amber)}.coverage-no_scenario,.coverage-blocked{background:var(--red-soft);color:var(--red)}.coverage-not_manually_testable{background:var(--purple-soft);color:var(--purple)}.coverage-out_of_scope{background:#efeff1;color:#5f5f64}.risk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 30px}.risk-grid>div{min-width:0}.risk-grid h3{font-size:.86rem}.source-list li{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:.75rem}.source-list code{min-width:0;overflow-wrap:anywhere}.source-list span,.source-list small,.section-note{color:var(--muted)}.section-note{margin:0 0 12px;font-size:.72rem}.empty-state{margin:0;color:var(--muted);font-style:italic}
footer{display:flex;justify-content:space-between;gap:20px;width:min(100%,1540px);margin:0 auto;padding:0 clamp(24px,4vw,64px) 28px;color:var(--muted);font-size:.7rem}footer p{margin:0}
body[data-view="presentation"] .presentation-secondary,body[data-view="presentation"] .execution-capture,body[data-view="presentation"] .next-action{display:none}body[data-view="presentation"] .presentation-hide{display:none}body[data-view="presentation"] .presentation-only{display:block}body[data-view="presentation"] .sidebar,body[data-view="presentation"] .drawer-scrim{display:none}body[data-view="presentation"] .layout{grid-template-columns:minmax(0,var(--reading));padding-top:18px}body[data-view="presentation"] .scenario-workbench{grid-template-columns:minmax(230px,.3fr) minmax(0,1fr)}body[data-view="presentation"] .scenario-directory li:not(.presentation-relevant){display:none}body[data-view="presentation"] .result-controls{display:none}body[data-view="presentation"] .presentation-essential>summary{pointer-events:none}body[data-view="presentation"] .presentation-essential>.reference-content{display:block}body[data-view="presentation"] .content-section{padding-top:0}
@media(min-width:1800px){.hero-inner,.layout,footer{width:min(100%,1760px)}.layout{grid-template-columns:13.5rem minmax(0,96rem);gap:56px}.scenario-workbench{grid-template-columns:minmax(310px,.34fr) minmax(0,1fr);gap:42px}.row-type,.row-position{display:block}.scenario-directory a{grid-template-columns:auto auto minmax(0,1fr) auto auto}.row-position{color:var(--subtle);font-size:.61rem}.row-type{grid-column:3;color:var(--muted);font-size:.64rem}.row-attention{grid-column:3/-1}}
@media(max-width:1179px){html{scroll-padding-top:66px}.hero-inner{padding-left:24px;padding-right:24px}.layout{display:block;padding:0 24px 40px}.sidebar{position:sticky;z-index:40;top:0;max-height:none;margin:0 -24px 14px;padding:8px 24px;border-right:0;border-bottom:1px solid var(--line);overflow:visible;background:#fff}.sidebar-toggle{display:flex;width:100%;align-items:center;justify-content:space-between;border:0;padding:4px 0}.js .sidebar-body{display:none}.js .sidebar[data-open="true"] .sidebar-body{position:fixed;z-index:52;top:0;bottom:0;left:0;display:block;width:min(390px,86vw);overflow:auto;padding:22px 24px;background:#fff;box-shadow:16px 0 45px rgba(0,0,0,.18)}.js .sidebar[data-open="true"] .section-nav,.js .sidebar[data-open="true"] .filter-panel,.js .sidebar[data-open="true"] .local-panel{margin-bottom:22px}.drawer-scrim{position:fixed;z-index:51;inset:0;border:0;background:rgba(0,0,0,.28)}.sidebar[data-open="true"]+.drawer-scrim{display:block}.content-section,.next-action,.scenarios-section,.reference-section,.scenario{scroll-margin-top:66px}.scenario-directory{top:66px;max-height:calc(100vh - 82px)}.view-switch{margin-top:0}.summary-flow{grid-template-columns:minmax(140px,.28fr) minmax(0,1fr)}body[data-view="presentation"] .layout{padding-top:16px}}
@media(max-width:760px){.hero-inner{grid-template-columns:1fr;grid-template-areas:"copy" "outcome" "meta";gap:14px;padding:19px 16px 15px}.hero h1{font-size:clamp(1.55rem,7vw,2.05rem)}.hero-summary{font-size:.83rem}.hero-outcome{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,.7fr);gap:4px 18px;padding:11px 0 0;border-left:0;border-top:1px solid var(--line-soft)}.hero-outcome-label{grid-column:1}.overall-value{grid-column:1;align-self:start;width:max-content}.hero-progress{grid-column:2;grid-row:1/3;margin:3px 0 0}.hero-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 0}.hero-meta div{padding:0 10px}.hero-meta div:nth-child(odd){padding-left:0;border-left:0}.hero-meta dd{font-size:.7rem}.layout{padding:0 14px 32px}.sidebar{margin:0 -14px 12px;padding:7px 14px}.view-switch{margin-bottom:10px}.content-section{padding-bottom:20px}.section-heading{align-items:flex-start;flex-direction:column;gap:5px;margin-bottom:13px}.overall-status{white-space:normal}.summary-flow{grid-template-columns:1fr;gap:18px}.status-legend{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px}.summary-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.summary-facts div,.summary-facts div:first-child{padding:0;border:0}.summary-facts div:last-child{grid-column:1/-1}.next-action{grid-template-columns:auto minmax(0,1fr);gap:12px;margin:19px 0 30px;padding:15px}.next-symbol{width:36px;height:36px}.next-meta{grid-column:1/-1;justify-content:flex-start;max-width:none;padding-left:48px}.scenario-workbench,body[data-view="presentation"] .scenario-workbench{grid-template-columns:1fr;gap:22px}.scenario-directory{position:static;max-height:290px;border-bottom:1px solid var(--line);overflow:auto}.directory-heading{position:sticky}.scenario-header{grid-template-columns:1fr;gap:11px}.scenario-badges{justify-content:flex-start;max-width:none}.scenario-header h3{font-size:1.55rem}.status-context{grid-template-columns:1fr}.status-context div+div{border-top:1px solid currentColor;border-left:0}.scenario-columns{grid-template-columns:1fr;gap:8px}.steps>li{grid-template-columns:38px minmax(0,1fr);gap:10px}.step-expected{grid-column:2;padding:10px 0 0;border-top:1px solid var(--line-soft);border-left:0}.result-controls{grid-template-columns:1fr;gap:14px}.result-buttons{grid-template-columns:repeat(2,minmax(0,1fr))}.result-not_run{grid-column:1/-1}.support-content{padding-left:11px}.input-list>div{grid-template-columns:1fr;gap:3px}.risk-grid{grid-template-columns:1fr}.source-list li{grid-template-columns:1fr;gap:3px}.reference-section>summary{padding:14px 1px}footer{padding:0 14px 24px;flex-direction:column;gap:5px}}
@media(max-width:420px){.product-mark{font-size:.62rem}.hero-meta{grid-template-columns:1fr 1fr}.hero-outcome{grid-template-columns:1fr}.hero-progress{grid-column:1;grid-row:auto;width:100%;margin-top:6px}.view-switch{width:100%;justify-content:center}.view-button{flex:1}.next-title{display:block}.next-meta{padding-left:0}.primary-action{width:100%;justify-content:center}.scenario-directory a{grid-template-columns:auto auto minmax(0,1fr)}.scenario-directory .criticality{grid-column:3;width:max-content}.row-attention{grid-column:3}.steps>li{grid-template-columns:1fr}.step-index,.step-action,.step-expected{grid-column:1}.result-buttons{grid-template-columns:1fr 1fr}.result-button{min-width:0}.scenario-pager a{min-width:0;flex:1}.status-legend{grid-template-columns:1fr 1fr}.detail-list>li{display:block}.detail-list .tag,.detail-list .card-topline{margin-top:8px}.table-scroll{border:0;overflow:visible}.coverage-table{min-width:0}.coverage-table thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.coverage-table,.coverage-table tbody,.coverage-table tr,.coverage-table th,.coverage-table td{display:block;width:100%}.coverage-table tr{padding:8px 0;border-bottom:1px solid var(--line)}.coverage-table th,.coverage-table td{padding:5px 0;border:0}.coverage-table td::before{content:attr(data-label);display:block;color:var(--muted);font-size:.59rem;font-weight:700;text-transform:uppercase}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
@media print{@page{margin:11mm}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}html{font-size:9pt;scroll-padding:0}body{overflow:visible;background:#fff;color:#000;line-height:1.38}.hero{border-bottom:1px solid #555}.hero-inner{display:grid;grid-template-columns:1fr .36fr;grid-template-areas:"copy outcome" "meta outcome";gap:3mm 8mm;width:100%;padding:0 0 5mm}.hero h1{font-size:19pt}.hero-summary{color:#222}.hero-outcome{padding-left:5mm}.hero-meta{flex-wrap:wrap}.layout{display:block;width:100%;max-width:none;padding:0}.sidebar,.drawer-scrim,.view-switch,.operational-only,.skip-link,footer,.scenario-directory,.focus-label,.next-action{display:none!important}main{width:100%;max-width:none}.presentation-hide{display:block!important}.presentation-only{display:none!important}.content-section{padding:4mm 0;border-bottom:1px solid #aaa}.summary-flow{grid-template-columns:.3fr 1fr}.status-legend{gap:3mm}.scenario-workbench{display:block}.scenario-list .scenario,.js .scenario-list .scenario:not(.is-focused),body[data-view="presentation"] .scenario-list .scenario{display:block!important}.scenario{break-inside:auto;margin:0 0 7mm;padding-top:4mm;border-top:1px solid #777}.scenario-lead{break-inside:avoid-page;page-break-inside:avoid}.scenario-header{break-inside:avoid;break-after:avoid}.scenario-body{display:block!important}.status-print,.print-value{display:block}.print-value:empty{display:none}.status-context{break-inside:avoid}.presentation-secondary,.support-details,body[data-view="presentation"] .presentation-secondary{display:block!important}.support-details[open] .support-content,.support-details>.support-content{display:block!important}.support-details summary{display:none}.execution-capture{border-top:1px solid #aaa}.local-only-callout,textarea{display:none!important}.steps>li{grid-template-columns:8mm 1fr 1fr;break-inside:avoid}.step-expected{grid-column:auto}.scenario-pager{display:none}.reference-deck{break-before:page}.reference-section,.reference-section.presentation-hide{display:block!important}.reference-section>summary{display:block;padding:4mm 0 2mm;font-size:11pt}.reference-section>summary>span:last-child{display:none}.reference-section>.reference-content,body[data-view="presentation"] .reference-section>.reference-content{display:block!important;padding-bottom:4mm}.detail-list>li,.source-list li{break-inside:avoid}.table-scroll{overflow:visible;border-color:#888}table,.coverage-table{display:table!important;min-width:0;table-layout:auto}thead{display:table-header-group}.coverage-table tbody{display:table-row-group!important}.coverage-table tr{display:table-row!important;break-inside:avoid}.coverage-table th,.coverage-table td{display:table-cell!important}.coverage-table td::before{display:none}tr{break-inside:avoid}th,td{padding:4px;overflow-wrap:anywhere}.risk-grid{grid-template-columns:1fr 1fr}h2,h3,h4,.scenario-subsection h4,.section-heading,.reference-section>summary{break-inside:avoid;break-after:avoid}p,li{orphans:3;widows:3}a{color:#000;text-decoration:none}}
@media print{.execution-capture.has-content{display:block!important}.execution-capture label,.execution-capture:not(.has-content){display:none!important}}
`;

function clientScript(uiJson) {
  return String.raw`
(()=>{"use strict";document.documentElement.classList.add("js");const fingerprint="__FINGERPRINT__";const ui=${uiJson};const storageKey="stnl-runbook:v1:"+fingerprint;const settingsKey=storageKey+":settings";const cards=[...document.querySelectorAll("[data-scenario-id]")];const cardById=new Map(cards.map(card=>[card.dataset.scenarioId,card]));const rows=[...document.querySelectorAll("[data-scenario-row]")];const rowById=new Map(rows.map(row=>[row.dataset.scenarioRow,row]));const search=document.getElementById("scenario-search");const statusFilter=document.getElementById("status-filter");const typeFilter=document.getElementById("type-filter");const criticalityFilter=document.getElementById("criticality-filter");const results=document.getElementById("filter-results");const noScenarios=document.getElementById("no-scenarios");const persist=document.getElementById("persist-state");const sidebar=document.querySelector(".sidebar");const sidebarToggle=document.querySelector(".sidebar-toggle");const drawerScrim=document.querySelector("[data-drawer-scrim]");const nextAction=document.querySelector("[data-next-action]");const statusLabels=ui.statuses;let focusedCard=null;function safeGet(key){try{return localStorage.getItem(key)}catch{return null}}function safeSet(key,value){try{localStorage.setItem(key,value)}catch{}}function safeRemove(key){try{localStorage.removeItem(key)}catch{}}function setBadge(badge,status){if(!badge)return;badge.className="status-badge status-"+status;badge.querySelector("[data-status-icon]").textContent=ui.statusIcons[status];badge.querySelector("[data-status-label]").textContent=statusLabels[status]}function updateRow(card,status){const row=rowById.get(card.dataset.scenarioId);if(!row)return;row.dataset.status=status;setBadge(row.querySelector("[data-status-badge]"),status)}function updateCard(card,status){card.dataset.status=status;setBadge(card.querySelector(".scenario-badges [data-status-badge]"),status);card.querySelector("[data-status-print]").textContent=statusLabels[status];card.querySelectorAll("[data-result]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.result===status)));updateRow(card,status)}function save(){if(!persist.checked)return;const state={version:1,fingerprint,scenarios:{}};for(const card of cards){state.scenarios[card.dataset.scenarioId]={status:card.querySelector("[data-scenario-status]").value,notes:card.querySelector("[data-notes]").value,evidence:card.querySelector("[data-evidence-notes]").value}}safeSet(storageKey,JSON.stringify(state))}function load(){const raw=safeGet(storageKey);if(!raw)return;try{const state=JSON.parse(raw);if(state.version!==1||state.fingerprint!==fingerprint||!state.scenarios)return;for(const card of cards){const value=state.scenarios[card.dataset.scenarioId];if(!value||!Object.hasOwn(statusLabels,value.status))continue;card.querySelector("[data-scenario-status]").value=value.status;card.querySelector("[data-notes]").value=typeof value.notes==="string"?value.notes:"";card.querySelector("[data-evidence-notes]").value=typeof value.evidence==="string"?value.evidence:"";updateCard(card,value.status);syncPrint(card)}}catch{safeRemove(storageKey)}}function syncPrint(card){const notes=card.querySelector("[data-notes]").value;const evidence=card.querySelector("[data-evidence-notes]").value;card.querySelector("[data-notes-print]").textContent=notes?ui.notes+": "+notes:"";card.querySelector("[data-evidence-print]").textContent=evidence?ui.evidence+": "+evidence:"";card.querySelector("[data-observed-value]").textContent=notes||ui.recordObserved;if(card.dataset.initialStatus!=="blocked"){card.querySelector("[data-blocker-value]").textContent=notes||ui.recordBlocker;card.querySelector("[data-unblock-value]").textContent=ui.recordUnblock}card.querySelector(".execution-capture").classList.toggle("has-content",Boolean(notes||evidence))}function chooseRecommended(){const first=predicate=>cards.find(predicate);return first(card=>card.dataset.status==="failed")||first(card=>card.dataset.status==="blocked"&&card.dataset.actionableBlocked==="true")||first(card=>card.dataset.status==="not_run"&&(card.dataset.criticality==="critical"||card.dataset.criticality==="high"))||first(card=>card.dataset.status==="not_run")||first(card=>card.dataset.status==="blocked")||null}function recommendationReason(card){if(!card)return ui.allCompleteDetail;if(card.dataset.status==="failed")return ui.recommendationFailed;if(card.dataset.status==="blocked")return ui.recommendationBlocked;if(card.dataset.criticality==="critical"||card.dataset.criticality==="high")return ui.recommendationPriority;return ui.recommendationCanonical}function refreshRecommendation(){const card=chooseRecommended();nextAction.dataset.nextActionId=card?card.dataset.scenarioId:"";nextAction.querySelector("[data-next-id]").textContent=card?card.dataset.scenarioId:"✓";nextAction.querySelector("[data-next-title]").textContent=card?card.dataset.scenarioTitle:ui.allComplete;nextAction.querySelector("[data-next-objective]").textContent=card?card.dataset.scenarioObjective:ui.allCompleteDetail;nextAction.querySelector("[data-next-reason]").textContent=recommendationReason(card);const criticality=nextAction.querySelector("[data-next-criticality]");criticality.hidden=!card;criticality.textContent=card?card.dataset.criticalityLabel:"";criticality.className="criticality criticality-"+(card?card.dataset.criticality:"low");nextAction.querySelector("[data-next-type]").textContent=card?card.dataset.scenarioType:"";nextAction.querySelector("[data-next-link]").href=card?"#"+card.dataset.scenarioId:"#scenarios";return card}function refreshPresentationRelevant(){for(const card of cards){const relevant=card.dataset.criticality==="critical"||card.dataset.status==="failed"||card.dataset.status==="blocked";rowById.get(card.dataset.scenarioId)?.classList.toggle("presentation-relevant",relevant)}}function counts(){for(const status of Object.keys(statusLabels)){const count=cards.filter(card=>card.dataset.status===status).length;document.querySelectorAll('[data-count-status="'+status+'"]').forEach(node=>{node.textContent=String(count)})}const failed=cards.some(card=>card.dataset.status==="failed");const blocked=cards.some(card=>card.dataset.status==="blocked");const passed=cards.length>0&&cards.every(card=>card.dataset.status==="passed"||card.dataset.status==="skipped");const overallKey=failed?"failed":blocked?"blocked":passed?"passed":"not_run";const overall=statusLabels[overallKey];const overview=document.getElementById("overall-status");overview.textContent=overall;overview.className="status-text-"+overallKey;document.querySelectorAll("[data-overall-status]").forEach(node=>{node.textContent=overall;if(node.classList.contains("overall-value"))node.className="overall-value status-"+overallKey});const complete=cards.filter(card=>card.dataset.status==="passed"||card.dataset.status==="skipped").length;document.querySelectorAll("[data-progress]").forEach(node=>{node.textContent=complete+"/"+cards.length});document.querySelectorAll("[data-progress-bar]").forEach(node=>{node.value=complete});refreshPresentationRelevant();return refreshRecommendation()}function focusCard(card,scroll){if(!card)return;focusedCard=card;for(const item of cards)item.classList.toggle("is-focused",item===card);for(const row of rows){const active=row.dataset.scenarioRow===card.dataset.scenarioId;row.classList.toggle("is-focused",active);const link=row.querySelector("[data-scenario-link]");if(active)link.setAttribute("aria-current","step");else link.removeAttribute("aria-current")}if(scroll)card.scrollIntoView({block:"start"});try{history.replaceState(null,"","#"+card.dataset.scenarioId)}catch{}}function applyFilters(){const query=search.value.trim().toLocaleLowerCase(ui.locale);let visible=0;let firstVisible=null;for(const row of rows){const card=cardById.get(row.dataset.scenarioRow);const types=row.dataset.typeKeys.split(" ");const haystack=(row.textContent+" "+card.textContent).toLocaleLowerCase(ui.locale);const matches=(!query||haystack.includes(query))&&(!statusFilter.value||row.dataset.status===statusFilter.value)&&(!typeFilter.value||types.includes(typeFilter.value))&&(!criticalityFilter.value||row.dataset.criticality===criticalityFilter.value);row.hidden=!matches;if(matches){visible++;firstVisible??=card}}const text=ui.visible.replace("{visible}",visible).replace("{total}",cards.length);results.textContent=text;document.querySelectorAll(".sidebar-results").forEach(node=>{node.textContent=text});noScenarios.hidden=visible!==0;if(focusedCard&&rowById.get(focusedCard.dataset.scenarioId)?.hidden&&firstVisible)focusCard(firstVisible,false);counts()}function closeTools(returnFocus=false){sidebar.dataset.open="false";sidebarToggle.setAttribute("aria-expanded","false");if(returnFocus)sidebarToggle.focus()}for(const control of [search,statusFilter,typeFilter,criticalityFilter])control.addEventListener("input",applyFilters);for(const card of cards){const status=card.querySelector("[data-scenario-status]");status.addEventListener("change",()=>{updateCard(card,status.value);applyFilters();save()});card.querySelectorAll("[data-result]").forEach(button=>button.addEventListener("click",()=>{status.value=button.dataset.result;updateCard(card,status.value);applyFilters();save()}));for(const input of [card.querySelector("[data-notes]"),card.querySelector("[data-evidence-notes]")])input.addEventListener("input",()=>{syncPrint(card);save()})}document.getElementById("expand-all").addEventListener("click",()=>document.querySelectorAll("details.support-details,details.reference-section").forEach(details=>{details.open=true}));document.getElementById("collapse-all").addEventListener("click",()=>document.querySelectorAll("details.support-details,details.reference-section").forEach(details=>{details.open=false}));sidebarToggle.addEventListener("click",()=>{const open=sidebar.dataset.open!=="true";sidebar.dataset.open=String(open);sidebarToggle.setAttribute("aria-expanded",String(open))});drawerScrim.addEventListener("click",()=>closeTools(false));sidebar.addEventListener("click",event=>{if(event.target.closest("a")&&matchMedia("(max-width:1179px)").matches)closeTools(false)});document.addEventListener("keydown",event=>{if(event.key==="Escape"&&sidebar.dataset.open==="true")closeTools(true)});document.querySelectorAll("[data-scenario-link]").forEach(link=>link.addEventListener("click",event=>{const id=link.getAttribute("href")?.slice(1);const card=cardById.get(id);if(!card)return;event.preventDefault();focusCard(card,true);closeTools(false)}));for(const button of document.querySelectorAll("[data-view-button]"))button.addEventListener("click",()=>{document.body.dataset.view=button.dataset.viewButton;document.querySelectorAll("[data-view-button]").forEach(item=>{const active=item===button;item.classList.toggle("active",active);item.setAttribute("aria-pressed",String(active))});if(button.dataset.viewButton==="presentation"){search.value="";statusFilter.value="";typeFilter.value="";criticalityFilter.value="";noScenarios.hidden=true;for(const row of rows)row.hidden=false;const recommended=refreshRecommendation();if(recommended)focusCard(recommended,false);const visible=rows.filter(row=>row.classList.contains("presentation-relevant")&&!row.hidden).length;results.textContent=ui.visible.replace("{visible}",visible).replace("{total}",cards.length)}else applyFilters()});persist.checked=safeGet(settingsKey)==="enabled";if(persist.checked)load();persist.addEventListener("change",()=>{if(persist.checked){safeSet(settingsKey,"enabled");save()}else{safeRemove(settingsKey);safeRemove(storageKey)}});document.getElementById("reset-state").addEventListener("click",()=>{if(!window.confirm(ui.resetConfirm))return;safeRemove(settingsKey);safeRemove(storageKey);persist.checked=false;for(const card of cards){const status=card.querySelector("[data-scenario-status]");status.value=card.dataset.initialStatus;card.querySelector("[data-notes]").value="";card.querySelector("[data-evidence-notes]").value="";updateCard(card,status.value);syncPrint(card)}applyFilters()});let printDetails=[];addEventListener("beforeprint",()=>{printDetails=[...document.querySelectorAll("details:not([open])")];for(const details of printDetails)details.open=true});addEventListener("afterprint",()=>{for(const details of printDetails)details.open=false;printDetails=[]});for(const card of cards)syncPrint(card);applyFilters();const hashCard=cardById.get(location.hash.slice(1));focusCard(hashCard||chooseRecommended()||cards[0],false)})();
`;
}
