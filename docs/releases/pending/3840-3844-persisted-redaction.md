---
issue: 3840, 3844, 3701
---

# Persisted-redaction widening: training vault bare-token families, read-compatible versioning, and evidence/forge boundary redaction

## Summary

Two security gaps closed in one delivery. First, the training-content redactor
(`src/training/redact.ts`) gains the bare well-known credential VALUE families
(anthropic, openrouter, openai, github, aws, slack, google, groq, jwt, base64
with the mixed-class guard, azure `AccountKey=`) mirrored from the shell site,
plus the shared JWS scanner (`src/utils/jws-redaction.ts`) whose spans win over
overlapping bare arms — a bare provider token in prose no longer reaches the
persisted training vault. The redaction version moves to 2 with a READ-COMPATIBLE
contract: the vault record schema accepts every version 1..2 (pre-v2 records
stay valid, exportable, and — because the expiry sweep now RETAINS
version-only-quarantined lines while purging only expired/malformed/other-invalid
ones — survive rewrites; the physical byte quota is preflight-exact and counts
every retained byte). The consent surface treats `redaction_version` as
informational redactor provenance (the authorization terms are unchanged by a
redactor bump, so older consents stay valid); the export manifest reports a
guaranteed-minimum redaction version over the retained set. Second, the review
and forge evidence boundaries gain a shared superset redactor
(`src/security/evidence-redaction.ts`: `redactSecrets` ∪ display bare families ∪
URL-credential stripping ∪ the shared JWS scanner) applied BEFORE durable writes
and outputs: auto-review evidence, review receipts, the forge event queue (every
rewrite path), the agent wake message, the subscriber advisory construction
point, the PR-feedback loop terminal reasons, the gh-evidence tool result, the
published PR-review submission body, the findings/handoff artifacts (with a
salted HMAC raw-replay identity sidecar preserving exact-replay semantics after
redaction), finding-policy synthesis, and the post-abort partial export.

## Semantics decisions (pending final ratification, non-destructive defaults)

- Consent compatibility: tolerant-read (v1 consents valid under the v2
  redactor; provenance semantics documented in the consent preview and
  docs/commands.md).
- Export manifest: guaranteed-minimum redaction version over the retained
  post-filter post-dedup set; empty exports stamp the running version.
- Already-stored v1 content: document-and-retain with a truthful remediation
  runbook (docs/training-vault-remediation.md: already-stored v1,
  append-triggered sweep with no timer guarantee, exports + copy-outside
  before withdrawal, credential ROTATION as the real remedy, downgrade
  procedure).

## Safe downgrade (vault)

A downgrade after v2 records exist reinstates the old literal reader and the
old sweep-on-rewrite behavior: v2 records would quarantine `schema_invalid`
and then be physically deleted at the next 256-append sweep. The safe
procedure: **export the vault, copy the export outside plugin control
(withdrawal revokes plugin-side exports with REVOKED.json markers), withdraw
consent, withdraw-purge the vault content, then downgrade** — or **accept the
loss** and let the next sweep delete the v2 records. Replay-identity sidecar
files are inert under downgrade and can be deleted at will. Full runbook:
docs/training-vault-remediation.md.

## Known bounds

- The training redactor still does NOT mirror the display site's Cf/DI
  condensed-view sweep (two-view fill-tolerance) — same bound as pre-#3882 at
  the memory site; the family corpus and JWS scanner are mirrored, the
  condensed-view machinery is not.
- Legacy pre-fix queue events, receipts, and review artifacts on disk keep
  their historical bytes (future-write redaction only; operator remediation
  = delete stale `.swarm` artifacts if desired).
- `redactSecrets`' family set remains the persisted-store floor at its 12
  existing consumer sites; the new superset redactor is applied at the
  #3844-named boundaries, not retroactively across every store.

## Round-5 hardening (plan-critic convergence)

- The pr-review handoff replay identity is now CLAIM-ONCE
  (`.swarm/pr-review/<runId>/replay-identity.handoff.claim`, create-only
  `wx`): a concurrent losing writer can no longer overwrite the winner's
  fingerprint and then validate its own raw summary against it — a foreign
  claim with different raw content is refused before any artifact bytes.
- Retained version-only-quarantined vault lines no longer consume the append
  quota's maxRecords (matching the read-side status accounting); malformed
  lines still charge it.
- The per-project quarantine journal-dedup cache is bounded (16 projects,
  FIFO eviction with journal rehydration) per the bounded-global-state
  invariant.
- Executor-level pins now cover the handoff/claim race, both comparators'
  missing/corrupt fail-closed legs, the token-bearing severity-only
  committed replay through the sidecar, post-claim sidecar-write failure,
  and same-family different-secret conflicts. The claim/sidecar residue a
  failed artifact create leaves behind is IDENTITY-RESERVING, not inert: an
  identical-raw retry succeeds through it, a different-raw retry conflicts
  (the claim is immutable for the run's life — a possibly-committed
  identity is never silently taken over); operator recovery for an
  abandoned run is archiving/deleting `.swarm/pr-review/<runId>/`.
