---
issue: 3332
---

## What

- Linux sandbox: the `/lib64` read-only bind is now host-conditional in BOTH
  bwrap arg constructors — the capability probe (`probeLinuxBehavior`) and
  the production executor (`buildBwrapArgs`, including the namespace smoke
  args). On a host without `/lib64` (usr-merged or non-multilib images, e.g.
  Alpine/musl) wraps and capability probes now work instead of failing
  wholesale; on hosts with `/lib64` the arg list is byte-identical to before.
- Sandbox probes: a failure during probe temp setup (mkdtemp ENOSPC/EACCES,
  mkdir EACCES, profile build error) now returns a bounded weak probe result
  with the temp root cleaned up, instead of escaping as an unhandled throw
  that leaked the probe temp root (both the Linux and macOS behavioral
  probes).
- CI tooling: new `scripts/capture-required-check-evidence.ts` — the
  repeatable refresh path for `docs/ci/required-check-evidence.json`
  (`--self-test` offline validation reusing the validator's own evaluator,
  `--dry-run`, `--output <path>`, default write) with a runbook
  (`docs/ci/required-check-evidence-capture.md`) naming the exact commands,
  owner surface, and cadence (re-capture at least every three weeks, before
  each 30-day `MAX_EVIDENCE_AGE_MS` wall; the wall twice blocked every open
  PR's unit matrix until re-attested by hand).

## Why

Closes #3332 (probe/executor `/lib64` tolerance + bounded setup failures)
and closes #3653 AC2 (the 30-day evidence wall had no in-repo regeneration
path). #3647 is verified already fixed on main by PR #3639's bwrap
mount-order change (evidence recorded on the issue; this PR keeps its
regression guard green while editing the same file family).

## Tests

- tests/unit/sandbox/bwrap-executor-lib64-absent.test.ts /
  bwrap-executor-lib64-present.test.ts — production wrap args per host shape
  (module-load deterministic, one leg per file).
- tests/unit/sandbox/capability-probe-lib64.test.ts — probe args per-call
  host-conditional bind.
- tests/unit/sandbox/capability-probe-setup-failure.test.ts — bounded setup
  failures on both platform branches (no throw, weak dimensions, reasons,
  temp-root cleanup; mkdtemp-failure and profile-build legs included).
- tests/unit/scripts/capture-required-check-evidence.test.ts — validator
  -accepted generated artifact, refusal semantics (missing required context,
  local/captured divergence), self-test PASS/FAIL branches.
- Updated bwrap-namespace-smoke.test.ts and linux.test.ts to derive the
  expected `/lib64` bind from host availability (non-circular).

## Known limitation

The capture script's live mode requires `gh` authentication and a local
checkout whose workflow files match the selected capture SHA (the script
refuses on divergence instead of guessing).
