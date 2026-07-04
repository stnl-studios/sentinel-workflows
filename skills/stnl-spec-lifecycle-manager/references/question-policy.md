# File Purpose Header

```yaml
purpose: Define when and how the skill asks, resolves, and blocks on questions.
load_when: INIT or RESUME encounters ambiguity, or PLANNING checks open questions.
do_not_load_when: The spec has no ambiguity and no open questions.
contains: Crucial question rules, bypass rules, question statuses, and blocking policy.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the ambiguity policy changes.
```

# Question Policy

Open questions are canonical artifacts using `Q-001+`.

## Core rule

No spec may advance to `ready` while any open question remains.

External execution agents cannot bypass open questions. Any bypass must happen inside the spec before execution.

## When to ask

Ask crucial questions when missing information affects:

- business behavior;
- user permissions;
- API or data contract;
- state transitions;
- integration behavior;
- security;
- migrations;
- irreversible architecture choices;
- slice boundaries;
- acceptance criteria;
- constraints;
- risk posture.

## When not to ask

Do not ask when:

- the gap is minor and safely captured as out of scope;
- the spec can proceed after adding a constraint;
- the missing detail belongs to implementation discovery and does not change the feature contract;
- the user has already provided enough signal.

When proceeding without asking, record the assumption only if it is durable and material. Otherwise keep the spec concise.

## Question fields

Recommended structure:

```yaml
id: Q-###
status: open | resolved | bypassed | dropped
question: <the smallest decision needed>
why_it_matters: <business, technical, risk, or scope impact>
blocks: [SL-###, AC-###]
resolution: <empty until resolved>
resolved_by: user | decision | scope_change | constraint
linked_decision: D-### | null
```

## Bypass rules

A user may bypass a question only inside the spec by one of these mechanisms:

- answering it;
- creating a durable `D-###` decision;
- adding or changing a `C-###` constraint;
- changing scope or out-of-scope;
- dropping the affected slice;
- explicitly marking the question as `bypassed` with rationale.

Do not allow an implementation agent to continue by assuming the answer during execution.

## Question phrasing

Questions should be short, specific, and decision-oriented.

Good:

```markdown
### Q-001 — Should expired invitations remain visible to admins?

id: Q-001
status: open
question: Should expired invitations remain visible to admins after expiration?
why_it_matters: Determines API filtering behavior and acceptance criteria.
blocks: [AC-002, SL-001]
```

Bad:

```markdown
### Q-001 — How should invitations work?
```

## Resolved questions

During the living lifecycle, resolved questions may remain if they explain important decisions. During `CLOSE`, remove resolved questions unless their resolution remains important for long-term maintenance.
