# Council review identity, final completion policy, centralized freshness, and honest inert config

Guardrail remediation 7/12 (issue #2102).

## What changed

- **One canonical council review identity** now binds every task, phase, and
  final council review: a status-stable hash over every review-relevant plan
  field, the readable + collision-resistant plan identity, a canonical
  council policy digest, the council level/scope, and a schema/cutover
  version. Writers, the `#2085` authoritative round store, evidence files,
  and completion gates all compute it from one shared implementation
  (`src/council/council-review-identity.ts`).
- **Normal progress no longer invalidates a completed review.** The final
  council previously re-bound to the status-sensitive ledger plan hash, so
  any `update_task_status` after approval forced a full five-member
  re-dispatch (and could spuriously abort publication mid-commit). The
  review hash excludes pure execution progress (statuses, current-phase
  pointer, transient blocked reason, spec timestamps); any review-relevant
  plan change still opens a fresh authoritative round.
- **Authoritative rounds are identity-keyed and versioned.** Round-state
  records and the append-only attempt audit moved to schema version 2 with
  an identity digest validated against the scope. Legacy v1 files remain on
  disk, auditable, and are never read or rewritten; a plan/policy change
  opens a fresh generation while status-only transitions retain the accepted
  round. All `#2085` guarantees (server-owned rounds, append-before-return
  auditing, idempotency, crash recovery, fail-closed parsing) are preserved.
- **Explicit final completion policy** (`council.finalCompletionPolicy`).
  Default/missing = `all_required` and preserves the exact legacy
  five-role/five-distinct/zero-absentee requirement. `quorum` is an explicit,
  bounded weakening (`minimumMembers` 3–5) counting only distinct canonical
  roles — unknown, duplicate, and cross-swarm identities never count, and
  multi-swarm prefixed names (e.g. `local_critic`) resolve to canonical
  roles. Config doctor visibly flags quorum mode as weaker than the default.
  The normalized policy participates in the policy digest, so changing it
  invalidates prior evidence.
- **Centralized freshness** (`council.freshnessMaxAgeHours`, default 24,
  bounded 1–720): one evaluator and one captured preflight clock now govern
  the phase council, architecture supervisor, and final council gates.
  Invalid/future timestamps fail closed, and phase-council evidence must now
  also postdate the phase retrospective (the final council already did).
- **`council.parallelTimeoutMs` is honestly deprecated.** It never had a
  runtime consumer; the docs no longer claim an active timeout, the field is
  marked deprecated (parse compatibility preserved), and config doctor warns
  only when it is explicitly set. No cosmetic timer was added.
- **`council.escalateOnMaxRounds` is visibly inert (#1650).** Config doctor
  warns when it is explicitly set that no handler/webhook execution exists.
  Max-rounds exhaustion now emits a durable structured event
  (`.swarm/council/events/max-rounds-exhaustion.jsonl`) plus an explicit
  escalation message in the tool response; the handler string is redacted
  from all persistence and no outbound call of any kind is made.
- **Bounded structured General Council claims (#1650).** Member responses may
  carry an optional bounded `claims` array (subject, statement, typed stance,
  confidence, evidence refs). The disagreement detector consumes claims
  first, detecting contrary positions written without any marker phrase,
  while the phrase/Jaccard fallback is retained whenever claims are absent,
  invalid, or malformed — and marker-based disagreements are never dropped.

## Upgrade notes

- Council evidence written before this change carries no identity proof and
  is not backfilled: the phase/final completion gates and the session
  rehydration fast path fail closed until one fresh council run per affected
  scope completes (legacy round/attempt files stay on disk, auditable).
- Task-status progress after an approved final council no longer forces a
  re-review; review-relevant plan edits and council policy changes still do.

## Closes

- Closes #1650 (structured claims with fallback preserved + visible inert
  `escalateOnMaxRounds` warning both landed).
