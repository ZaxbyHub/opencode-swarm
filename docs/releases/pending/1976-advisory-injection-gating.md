# Advisory-injection gating: gate the ~70 ungated producer sites + structural fixes

## What

Closes #1976. The advisory-injection subsystem (the shared
`session.pendingAdvisoryMessages` queue drained into the architect's
`[ADVISORIES]` block each turn) had ~70 producer sites that pushed directly
onto a bare `string[]` with no shared gate, no length cap, and no eviction.
Re-firing triggers (per-tool-call, per-Task-call, per-poll, on retry) stacked
near-identical or byte-identical advisories that the drain rendered verbatim
— the same failure mode that produced the PR_REVIEW banner flood (55.3% of
non-blank lines in a real transcript). This change closes the defect **class**
(structural prevention) plus seven specific structural defects.

### Layer A — defect-class root (every producer now gated)
- New shared helper `src/utils/advisory-queue.ts` `pushAdvisory(session,
  message, opts?)`: skips empty, dedupes (by caller-supplied `dedupeKey` or
  default full-normalized-text), caps queue length at 25 keep-latest. All ~70
  producer sites across 16 files now route through it (mechanical codemod).
- Drain-level byte budget (`src/hooks/guardrails/messages-transform.ts`,
  architect branch only): caps the rendered `[ADVISORIES]` block at 6000 bytes
  keep-latest with a disclosure note. The non-architect branch is untouched
  (issue A2 — intentional discard of non-transient subagent advisories).
- Lint ratchet `scripts/check-no-raw-advisory-push.sh` (Check 5 in
  `check-invariants.sh`): forbids `pendingAdvisoryMessages.push(...)` (incl.
  optional-chaining `?.push` and non-null-assertion `!.push` forms) outside the
  helper, so the class cannot silently regress.

### Layer B — structural fixes
- **B1 PRM** (`src/prm/index.ts`): per-tool-call re-injection suppressed via
  `prm:${pattern}:${level}` dedupeKey (within-turn) + a cross-turn
  `prmInjectedAdvisoryKeys` Set (across drains). Escalation counting, telemetry,
  and the level-3 hard stop run unconditionally — only the INJECTION is gated.
- **B2 dead PRM escalation queue**: removed the write-only `correctionsPending`
  queue + `getPendingCorrections` (0 prod callers) + `clearPendingCorrections`.
  Behavior-neutral (escalation level derives from pattern counts independently).
- **B3 delegation-gate** (`src/hooks/delegation-gate.ts`): the "only push once"
  `break` was per-invocation only; a new `completionGateWarnedForTask` Set
  (snapshot round-tripped) suppresses re-injecting the identical directive on
  every subsequent Task call while a task stays stuck in `tests_run`.
- **B4 worktree-isolation**: loose `includes('test')` (matched 'latest'/'attest')
  → word-boundary regex `/\btests?\b/` (and build/lint/check).
- **B5 phase-complete**: vacuous `if (curationResult)` gate → substance gate;
  content-free `'Phase analysis complete'` digest placeholder now skips the
  push; hardcoded "auto-activated no skills" suffix computed from
  `autoApply.approved`; redundant drift-advisory pair folded (the
  `critic_drift_verifier` nudge moved into the surviving message) with a
  same-run guard that preserves the stale-prior-report path.
- **B6 runaway-output** (`messages-transform.ts`): the dedupe predicate searched
  `'runaway output'` but the pushed text said `'high-output responses'` — the
  guard never matched. Removed; push routes through the helper which dedupes
  correctly.
- **B7 nontransient classifier** (`nontransient-circuit.ts`): the fatal
  categories (`command_not_found`, `shell_parse_error`, `sandbox_wrapper_failure`)
  are now classified only for shell tools. A non-shell tool (e.g. a CI-log
  inspector) whose stdout quotes "command not found" while exiting non-zero for
  an unrelated reason no longer false-positive hard-stops the circuit; it falls
  through to a non-fatal `failure`. Real shell command-not-found still hard-stops.
- **B8 pr-event-subscribers**: the dedup token lacked per-event identity, so N
  comments on a PR collapsed to 1 advisory. New shared `buildPrEventToken`
  (used by all three paths: handlePrEvent, formatAdvisory, wake-channel) adds
  `@author:content-hash` for content events (comments/reviews); state events
  keep the per-PR token.
- **B9 invariant-8 eviction**: the 5+1 session/call-keyed module-level maps
  (`toolCallsSinceLastWrite`, `noOpWarningIssued`, `consecutiveNoToolTurns`,
  `storedInputArgs`, `ledgerBySession` + per-session entry cap,
  `droppedEntryCounts`) now have FIFO caps (500 sessions / 2000 call-entries /
  200 ledger entries per session with a "...and K earlier calls omitted"
  disclosure in the DELEGATION SUMMARY).
- **B10 test fixture** (`tests/unit/hooks/gate-tracking.test.ts`): 3 tests never
  set `currentTaskId`, so the lookup key resolved to `:unknown` and they passed
  via the no-gateLog fallback for the wrong reason. Now set correctly +
  strengthened with absence assertions for present gates.

## Why
Ungated, unbounded, re-firing advisory injection is the defect class behind the
PR_REVIEW banner flood and a class of TUI-pollution regressions. A per-producer
gate is the durable fix; the shared helper + lint ratchet make reintroducing the
class structurally prevented rather than vigilance-dependent.

## Migration / breaking changes
None. The advisory queue, drain, and all producer semantics are preserved; only
duplicate/unbounded re-injection is suppressed. The PRM injected advisory now
carries a `[prm:pattern:level]` tag prefix (display-only). The classifier change
means non-shell tools quoting fatal shell signatures no longer hard-stop (they
are still recorded as non-fatal failures).

## Known caveats
- The helper's within-turn dedupe cannot suppress cross-turn re-injection on its
  own (the drain clears the queue each turn); the hottest cross-turn repeaters
  (PRM, delegation-gate) carry their own session-scoped suppressors (B1/B3).
- A1/A2/A3 (no-op counter reset; drain blank/exact-dup hygiene; orphan-recovery
  emptiness gate) are out of scope per the issue (fixed separately). The
  non-architect drain clear at `messages-transform.ts` is intentionally
  preserved.
