---
note: ''
---

## What changed

Closed ten fail-open verification-surface defects across the CI evidence
pipeline (collated #3700 + #3664 + #3661):

- **pre_check_batch changed-line map (#3700):** the diff-base resolver memo is
  now scoped to one `run_pre_check_batch` invocation and passed explicitly to
  both consumers, so a direct consumer call always resolves fresh state (a
  same-HEAD candidate-ref move can no longer serve a stale merge-base that
  misclassifies genuinely-new SAST findings as PRE-EXISTING). The
  phantom-destination guard now covers two-different-unquoted-path
  `diff --git` headers (an exact two-token split), the diff parser adopts a
  stateful production-mode grammar (structural lines + `GIT binary patch`
  fragments + blank terminators enumerated; junk before/between/after sections
  fails closed instead of yielding an authoritative map), and all diff/status
  legs emit project-directory coordinates (`--relative` for diffs;
  `rev-parse --show-prefix` rebasing for porcelain records, drop-outside with
  paired rename sources) so a nested independent project root (`.opencode/`
  boundary, #2127) classifies its genuine edits NEW.
- **Per-file CI validation harness (#3664):** the child terminal-status
  derivation now consults bounded-reader COMPLETENESS. An exit-0 child whose
  stdout/stderr reader missed its deadline records the new self-naming
  `output_truncated` terminal with a reason naming the truncated channel(s),
  counts as started+completed+failed, and fails the run — it can no longer
  record a clean `passed` on partially observed output. Output that merely
  EXCEEDS the saved-log byte cap is NOT incomplete (the reader drains to EOF
  and the exit code is known), so fully-read capped output stays `passed`
  (final-critic round 1, executed against real CI reports). The report
  verifier accepts and reconciles the new terminal in lockstep.
- **Required-check evidence capture + sandbox probe (#3661):** the capture CLI
  parses argv strictly (unknown flags, `--output=PATH`, case variants, and
  stray positionals exit 2 before any capture work — no more silent
  fall-through to overwriting the committed evidence artifact); the
  `spawnSync` gh call no longer signals its already-reaped pid (routed through
  a testable `_internals.spawnSync` seam); a required context matching
  multiple same-named check runs now requires every run completed+successful
  and an unambiguous single producing app slug; merge-group run collection is
  scoped to contract workflows (matching the validator by construction); and a
  sandbox-probe setup-failure result is never memoized (the next `detect()`
  re-probes instead of serving a degraded capability for the process
  lifetime).

## Why

Each defect let a verification surface record a pass (or trust a map) from
stale, partial, or spoofed evidence — the same class as #3131/#2738. All ten
were reproduced by execution at the base commit before the fix and are pinned
by a frozen 15-check battery plus a re-pinned FB-003 suite.
