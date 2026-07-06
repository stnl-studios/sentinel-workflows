---
name: stnl-security-auth
description: Sensitive-area rules for authentication, authorization, sessions, tokens, secrets, and security-boundary changes.
---

# Security and Authentication

Use only when the approved slice or diff explicitly touches a security boundary. Coder and validator use this skill only under the restricted Sentinel matrix.

## Establish the boundary

- Identify actors, resources, trust boundaries, authentication mechanism, authorization owner, credential/session lifecycle, and failure behavior.
- Follow the project's established security libraries and middleware. Do not invent cryptography or custom token formats.

## Apply

- Enforce authorization server-side at the resource/action boundary; UI visibility is not authorization.
- Default to least privilege and deny when identity, tenant, role, scope, ownership, or policy context is missing.
- Validate redirect/callback targets and untrusted claims. Preserve issuer, audience, signature, expiry, nonce/state, and replay protections required by the mechanism.
- Keep secrets and sensitive tokens out of source, URLs, logs, errors, analytics, and close evidence.
- Preserve secure cookie/session settings, CSRF protection, token rotation/revocation, and rate/abuse controls when applicable.
- Avoid identity or authorization enumeration through distinguishable errors unless the approved contract requires it.

## Evidence

Test permitted and denied paths, missing/expired/invalid identity, tenant/ownership boundaries, and relevant session/token lifecycle behavior. Inspect logs/evidence for secret leakage. State what was tested without including credentials or full tokens.

## Stop

Block for a new auth mechanism/provider, privilege-model change, cryptographic decision, secret migration, public security-contract change, compliance assumption, or undeclared path. These require explicit plan and developer approval.
