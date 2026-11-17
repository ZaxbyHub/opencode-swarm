---
issue: 3730
---

# Redaction fill-tolerance and five JWT shapes at both redaction sites; win32 probe/weak-executor TTL

## What

- Closes #3730: the shell-audit redaction site (`redactShellCommand`) gains the
  display site's Cf/DI condensed-union bare-token sweep — a zero-width byte
  (e.g. U+200B, U+070F, U+1160, U+FE0F) inside ANY bare credential token (jwt,
  sk-, ghp_, AKIA, xoxb-, AIza, gsk_, …) can no longer split it past redaction.
  Benign text keeps its invisible bytes byte-identical (condensation exists
  only in the matching view).
- Closes #3736 claim 1: the shared JWS scanner (`src/utils/jws-redaction.ts`)
  is widened at BOTH redaction sites for five previously-leaking shapes —
  n-part JWE absorption (never across an adjacent eyJ header, incl. the empty
  encrypted-key dir-JWE), unsigned 2-segment tokens with any ≥1-char payload
  (e30/bnVsbA/Ingi), standard-base64 `+ / =` dotted headers (bare, `key=`
  assignment, and `=`/`==`-padded placements), `_eyJ` underscore boundaries,
  and ≥1-char signatures. Disclosed residuals (documented in code and pinned
  by tests): a mixed-case ≥8-char English tail directly appended to a token
  absorbs; an all-lowercase <16-char ciphertext tail stays visible.
- Closes #3736 claim 2: every failed/unavailable win32 runner-probe result is
  now TTL-bounded (`runnerProbeFailureTtlMs()`, env
  `SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS`, default 60 s, mirroring
  `executorFailureTtlMs()`) so installing or replacing the runner binary is
  recoverable, and `getExecutor()` re-creates a WEAK executor after the
  executor TTL instead of pinning the PowerShell fallback for the process
  lifetime. Recovery bound: ≤ probe TTL + executor TTL + next-caller delay
  (both default 60 s). The #2475 downgrade warnings now fire at most once per
  TTL window while broken (the bounded re-probe cadence IS the recovery
  mechanism) instead of once per process.
- Glued compositions (`sk-abc-<JWT>`) now select the leftmost-longest family
  span at BOTH sites (disclosed behavior change: the old shell pre-pass
  labeled them jwt; the new span is strictly more redaction).
- Known bounds disclosed: the memory-storage secret scanner
  (`src/memory/redaction.ts` findSecrets) has the same zw-split gap
  (probe-verified) and the capability-probe/assessment memoization layer
  (src/sandbox/capability-probe.ts:927-968) can stay weak after executor
  recovery — both are same-class siblings outside the two failure-evidence
  redaction sites this change owns and are recorded for a follow-up issue.

## Why

Bare credential tokens split by invisible bytes, and five real JWT-family
shapes, survived in cleartext in shell-audit and failure-evidence output
(#3730/#3736, independently reproduced at base: 8/9 probe fixtures leaked);
and one transient win32 probe failure permanently downgraded every sandbox
execution of the process to the weak PowerShell wrapper.

## Verification

- Five frozen acceptance checks (checkpoint manifest, anchor published
  pre-implementation on both issues): C1 RED→GREEN, C2 GREEN→GREEN, C3/C4
  ERROR→GREEN, C5 GREEN→GREEN; full replay 5/5 PASS at the implementation
  commit (logs in the issue-tracer trace).
- 9 named mutation probes killed (condensed-pass delete, Cf-alternative drop,
  absorption delete + absorb-across-header, D4 pass delete, signature-bound
  restore, probe TTL→permanent, weak→Infinity, AccountKey omission).
- Battery: tsc 0 errors; biome ci full tree green; the 12-suite redaction
  corpus, the 63-file guardrails-shell glob, and the sandbox suites
  (capability-probe, executor, runner-client families) green per-file; one
  3716 signature-boundary pin re-derived per the critic-approved plan (the
  {10,} signature bound the issue removes).
