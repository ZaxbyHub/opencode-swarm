# Record the opencode-ensemble adoption ADR and its review checklist (issue #2505)

## What

- Workstream G (parallel execution and ensemble operations) now has its G1 decision record:
  **ADR 0002** (`docs/decisions/0002-opencode-ensemble-adoption.md`) verifies and records the
  upstream `opencode-ensemble` license and provenance from primary sources — MIT with the exact
  copyright line, no NOTICE file, only `@opencode-ai/*` runtime dependencies (both MIT, already
  ours), and pinned commit `eaf9e84a6e872e6af9ad8bb5a8fd274ce926a878` — and decides
  **reimplement, do not port** for all five ensemble capabilities (watchdog,
  breaker/rate-limit, merge safety, purge pattern, dashboard), adopting upstream ideas and
  defaults with credit instead (stall-parameter surface and re-nudge suppression for #2506,
  token-bucket 10/sec + 0-disables for #2507, squash-merge-unstaged settlement shape and the
  two-step preview/confirm-token purge design for #2508, and the inline TS-string dashboard
  asset architecture for #2509).
- The ADR records the G2–G5 port gate (#2506, #2507, #2508, #2509 may not merge ported upstream
  code, strings, or UI assets before it) and the port obligation that outlives it: any future
  port must pin the exact upstream commit, carry a `ported-from: opencode-ensemble` provenance
  header in every ported file, and add `THIRD_PARTY_NOTICES.md` with the upstream MIT notice.
- A new executable ADR review checklist, `tests/unit/docs/ensemble-adr-2505.test.ts`, keeps the
  record honest: it pins the license facts, the pinned SHA, the five per-capability decision
  rows, the gate's four issue references, and the marker/notice symmetry (no port markers in
  `src/` while no notice file ships; a marker without `THIRD_PARTY_NOTICES.md` fails the suite).
  No runtime code changed: `src/` is untouched and no third-party notice ships because nothing
  is ported.

## Why

Issue #2505 requires the license/provenance verification, the per-capability decisions, and the
G2–G5 gate to be recorded in `docs/` before any of the four implementation slots may merge
ported upstream material ("No code port before license verification. Ideas are fine; code
requires compliance."). The license was verified independently of the repository owner's stated
risk acceptance, so the decision rests on primary-source evidence: MIT removes license risk
entirely, and engineering fit — our lane/settlement substrate, existing versioned circuit
machinery, and the AGENTS.md invariants that upstream's init-path server start, unbounded git
subprocesses, fail-open overlap check, and unauthenticated dashboard would each violate — is
what makes reimplementation-first the right call.
