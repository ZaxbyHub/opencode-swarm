# Make phase completion evidence-first and recoverable

## What changed

- `phase_complete` now evaluates every applicable phase gate into a versioned,
  deterministic report before taking the plan lock. It repeats that read-only
  preflight under the lock and commits only when the plan, configuration,
  evidence snapshot, and report are unchanged and passing.
- Added architect recovery tools for corrupt task-gate evidence and the
  authoritative knowledge-receipt ledger. Repairs preserve bounded immutable
  quarantine records and leave the affected task or phase/session blocked until
  fresh verification is recorded.
- Final-review evidence now carries a complete content-addressed manifest. The
  gate remains valid across unrelated `HEAD` movement but invalidates on any
  reviewed-byte, file-set, selector, policy, or plan-requirement change.
- Critical-directive failures expose typed recovery actions. Explicit overrides
  are recorded through a separate architect-only tool and cannot bypass missing,
  corrupt, or uncertain receipt authority.
- Retrospectives require an explicit `pass` or `fail` verdict, and a failing
  retrospective blocks phase completion. Knowledge gate releases are durable
  nonterminal transitions; they no longer masquerade as applied outcomes.

## Why

A phase boundary could stop at the first blocker, perform work while checking a
gate, accept stale review identity tied to `HEAD`, or direct the architect to a
recovery action that did not exist. Corrupt evidence also had no supported path
back to a known fail-closed state. The new protocol makes the complete decision
observable before mutation and makes every advertised recovery path executable.

## Migration

No manual migration is required. Legacy task evidence remains readable, but a
repair installs a fresh generation and requires the relevant gates to run again.
Legacy final-review evidence must be regenerated with `run_phase_review` before
gate-mode completion. Existing callers of `write_retro` must now supply an
explicit verdict.
