---
name: stnl-security-auth
description: Sensitive-area authentication and authorization guardrail for identity, permissions, sessions, tokens, tenant boundaries, secrets, abuse controls, and evidence.
---

# Security and Authentication

Use only when the approved slice or changed code explicitly touches a security boundary. Preserve the project's established security libraries, middleware, identity model, and authorization ownership. Do not invent cryptography, token formats, or privilege models.

## Establish the boundary

- Identify actors, protected resources/actions, trust boundaries, authentication mechanism, authorization owner, tenant/organization boundary, credential/session lifecycle, and expected failure behavior.
- Determine which values originate from trusted server identity versus client input. Authentication proves identity; it does not by itself prove permission.
- Reuse established policies, guards, middleware, claims mapping, session/token storage, secret loading, and audit patterns.

## Apply

- Enforce authorization server-side at the resource/action boundary. UI visibility or possession of an identifier is not authorization.
- Default to deny when required identity, tenant, role, scope, ownership, policy, or resource context is missing or invalid.
- Do not trust actor/user/tenant/company/organization identifiers supplied by the client when authenticated server context owns that identity.
- Prevent horizontal and vertical privilege escalation; verify resource ownership/tenant isolation for both reads and writes.
- Validate redirects/callback targets and untrusted claims. Preserve issuer, audience, signature, expiry, nonce/state, PKCE, replay, rotation, and revocation protections required by the mechanism in use.
- Keep secrets, credentials, full tokens, sensitive session values, and security-sensitive payloads out of source, URLs, logs, errors, analytics, test evidence, and generated artifacts.
- Preserve secure session/cookie settings, CSRF defenses, rate/abuse controls, and credential recovery rules when applicable.
- Avoid security enumeration through distinguishable responses unless the approved contract explicitly requires the distinction.
- Never weaken validation, authorization, transport, secret handling, or audit just to make a test or integration pass.

## Quality smells

Reject or correct material instances of:

- authorization performed only in UI/client code;
- client-supplied identity treated as trusted ownership/tenant context;
- permission checks scattered or duplicated inconsistently around a resource;
- broad admin/role shortcuts that exceed the approved privilege model;
- tokens/secrets logged or returned in errors;
- custom crypto/token/session logic replacing established mechanisms without an approved design;
- fail-open behavior on missing/invalid identity or policy data;
- missing denied-path tests around a changed protected action.

## Evidence

- Test permitted and denied paths, missing/invalid/expired identity, and relevant tenant/ownership/scope boundaries.
- Exercise lifecycle behavior such as rotation, revocation, logout, replay, callback, CSRF, or expiry only when touched by the change.
- Inspect logs/evidence for secret leakage. Report what was tested without including credentials or full tokens.
- A successful authenticated request does not prove authorization. Include at least the relevant denied boundary when authorization changes.

## Stop

Return to the Sentinel contract for a new auth provider/mechanism, privilege-model or tenant-model change, cryptographic decision, secret migration, new credential lifecycle, public security-contract change, compliance assumption, or undeclared path.

Completion requires explicit trust and permission boundaries plus negative evidence. Working authentication is not a pass when authorization, tenant isolation, secret handling, or lifecycle protections regress.
