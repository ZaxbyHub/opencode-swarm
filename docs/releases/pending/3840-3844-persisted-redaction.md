---
issue: 3840, 3844, 3701, 3899
---

# Persisted-redaction widening: training vault bare-token families, read-compatible versioning, and evidence/forge boundary redaction

## Summary

Two security gaps closed in one delivery. First, the training-content redactor
(`src/training/redact.ts`) gains the bare well-known credential VALUE families
(anthropic, openrouter, openai, github, aws, slack, google, groq, jwt, base64
with the mixed-class guard, azure `AccountKey=`) mirrored from the shell site,
plus the shared JWS scanner (`src/utils/jws-redaction.ts`). The scanner spans
and the bare arms are collected together and MERGED into disjoint ranges, so an
overlapping arm can neither strand a tail nor drop a head. A bare provider
token of one of those families, in prose, no longer reaches the persisted
training vault. The redaction version moves to 2 with a READ-COMPATIBLE
contract: the vault record schema accepts every version 1..2 (pre-v2 records
stay valid, exportable, and — because the expiry sweep now RETAINS
version-only-quarantined lines while purging only expired/malformed/other-invalid
ones — survive rewrites; the physical byte quota is preflight-exact and counts
every retained byte). The consent surface treats `redaction_version` as
informational redactor provenance (the authorization terms are unchanged by a
redactor bump, so older consents stay valid); the export manifest reports the
SOURCE redaction versions represented by the included records SEPARATELY from
the floor every emitted record was verified at, every exported record is
re-redacted by the running redactor (the AT-REST bytes stay as they are until
the user elects migration), and an export that cannot safely redact a record
publishes nothing. Second, the review and forge evidence boundaries gain a
shared superset redactor (`src/security/evidence-redaction.ts`: `redactSecrets`
∪ display bare families ∪ credential-placement shapes ∪ URL-credential
stripping ∪ the shared JWS scanner) applied BEFORE durable writes and outputs:
auto-review evidence, review receipts, the forge event queue (every rewrite
path), the agent wake message, the subscriber advisory construction point, the
PR-feedback loop terminal reasons, the gh-evidence tool result, the published
PR-review submission body, the findings/handoff artifacts (with a salted HMAC
raw-replay identity sidecar preserving exact-replay semantics after redaction),
finding-policy synthesis, and the post-abort partial export.

## Semantics decisions (owner-ratified 2026-11-22)

- Consent compatibility: tolerant-read (v1 consents stay valid under the v2
  redactor and capture continues; provenance semantics documented in the
  consent preview and docs/commands.md). The redaction version is
  informational provenance, NOT a consent-terms boundary — the terms
  (purpose, content classes, quotas, retention, expiry) are the authorization
  surface.
- Export manifest: the SOURCE redaction versions represented by the included
  records are reported separately from the floor every emitted record was
  verified at (the running redactor, because every exported record is
  re-redacted on output). Empty exports carry the running version.
- Already-stored v1 content: document-and-retain with a truthful remediation
  runbook (docs/training-vault-remediation.md: already-stored v1,
  append-triggered sweep with no timer guarantee, exports + copy-outside
  before withdrawal, credential ROTATION as the real remedy, downgrade
  procedure). The EXPORT path re-redacts legacy records on output; the
  at-rest record is never rewritten unless the user opts into migration.

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
- The training redactor still does NOT compose the `redactSecrets` floor, so
  a PEM private-key block and the Stripe (`sk_live_`/`rk_live_`) and GitLab
  (`glpat-`) families are still stored verbatim by the TRAINING path (the
  evidence path redacts them). Pre-existing; tracked by the follow-up issue
  filed with this PR.
- The training capture bound (4096 characters) is applied BEFORE the
  redaction, so a credential that STRADDLES the bound leaves its prefix in
  the vault (the token itself never does — the prefix is shorter than every
  arm's minimum, so it is not usable). The order is deliberate: bounding
  after the redaction would let a placeholder outgrow the bound and collapse
  two different captures onto one record id.
- Two persisted-evidence sinks are still outside the #3844 boundary set: the
  council evidence writers (`src/tools/write-final-council-evidence.ts`,
  `src/tools/submit-phase-council-verdicts.ts`) and the task-level council
  evidence writer (`src/council/council-evidence-writer.ts`). They persist
  model-authored free text raw. Pre-existing; tracked by the follow-up issue
  filed with this PR, and the PR body's coverage claim is narrowed to the
  enumerated boundary set.
- Legacy pre-fix queue events, receipts, and review artifacts on disk keep
  their historical bytes (future-write redaction only; operator remediation
  = delete stale `.swarm` artifacts if desired).
- `redactSecrets`' family set remains the persisted-store floor at its 12
  existing consumer sites; the new superset redactor is applied at the
  #3844-named boundaries, not retroactively across every store.

## Round-5 hardening (plan-critic convergence)

- The pr-review handoff replay identity is now CLAIM-ONCE
  (`.swarm/pr-review/<runId>/replay-identity.handoff.claim`): a concurrent
  losing writer can no longer overwrite the winner's fingerprint and then
  validate its own raw summary against it — a foreign claim with different
  raw content is refused before any artifact bytes. The salt and the claim
  are published create-only via a temp+fsync+link publication, so the final
  path never exists in a partial state and an interrupted write leaves no
  corrupt artifact behind (a bare create-only open did).
- Retained version-only-quarantined vault lines no longer consume the append
  quota's maxRecords (matching the read-side status accounting); malformed
  lines still charge it. Only a record from a STRICTLY NEWER redactor is a
  version-only spare — a sub-minimum version is invalid state and keeps the
  historical purge-on-sweep class.
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

## Round-7 hardening (the Stage B sweep of the full diff)

- The AWS secret CONTEXT arm now runs BEFORE the bare AKIA arm on the
  evidence path: the bare arm used to consume the access-key id first, so
  `redactSecrets`' context arm could never fire and the 40-character AWS
  secret next to the id survived raw. The anchor and the interposed prose
  are kept (unlike the memory site's whole-span replacement).
- The gh_evidence run METADATA (`runHtmlUrl`, `runHeadBranch`, ...) is
  redacted like `data` is — the metadata fields are copied from the raw
  parsed object, so a token in the run URL was a second leak path.
- The replay-identity rollback now distinguishes an ABSENT sidecar (nothing
  to restore) from an UNREADABLE one (fail closed), and a failed rollback
  WRITE discards the sidecar so no stale identity can make the next
  identical retry look like an exact replay.

## Fold-in: the remaining persisted-evidence boundaries (owner-directed, closes #3899)

By owner decision at the plan's ratification gate the six census-deferred
sites joined this PR instead of the filed follow-up: completion-verify's
persisted blocked-task fields (parsed from model-authored plan text), the
drift/hallucination/mutation evidence summaries (including the drift
critic-approval snapshot metadata), the core-events writer's free-text
carriers (detail/message/summary/reason/description redacted by default,
authority keys computed on the original event so at-most-once semantics are
unchanged), and the gate-evidence passthrough extras (redacted at the
single persist boundary; the declared structural fields pass verbatim).
A shared redactEvidenceDeep helper carries the recursive form.
