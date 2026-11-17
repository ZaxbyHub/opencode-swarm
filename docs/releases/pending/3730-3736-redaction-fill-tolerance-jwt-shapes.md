---
issue: 3730, 3736
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
  n-part JWE absorption (never across an adjacent eyJ header; the empty
  encrypted-key dir-JWE is covered when its IV segment passes the token-like
  check — spec-length IVs of 16+ chars), unsigned 2-segment tokens with any
  ≥1-char payload (e30/bnVsbA/Ingi), standard-base64 `+ / =` dotted headers
  whose standard-alphabet header is 40+ chars (bare, `key=` assignment, and
  `=`/`==`-padded placements), `_eyJ` underscore boundaries, and ≥1-char
  signatures.
- Known bounds (documented residuals, tracked for a follow-up): an empty-key
  JWE whose IV segment fails the token-like check (the segment lacks the
  uppercase/mixed-case/digit or length-16 composition the heuristic requires
  — e.g. an all-lowercase or all-digit IV shorter than 16 chars, or any IV
  shorter than 8 chars) stays fully visible (pre-existing — base is
  byte-identical); a standard-alphabet token whose header is 13-39 chars
  (e.g. the canonical 36-char HS256 header with `+`/`/`/`=` later segments)
  is not covered by the 40+ generic arm and can stay visible (real JWTs are
  base64url, so reach is limited); a dot-glued standard-base64 token directly
  after an eyJ token can keep its final segments visible (the absorption loop
  stops and the overlapping generic span is dropped); a mixed-case ≥8-char
  English tail directly appended to a token absorbs; an all-lowercase
  <16-char ciphertext tail stays visible; the generic arm can over-redact a
  benign dotted identifier whose first run is 40+ chars of `[A-Za-z0-9+/]`
  followed by 20+/10+ char segments (and `/swarm close` re-applies current
  policy when re-archiving shell-audit lines, so such identifiers logged
  under the previous policy may be redacted in the archived copy).
- Closes #3736 claim 2: every failed/unavailable win32 runner-probe result is
  now TTL-bounded (`runnerProbeFailureTtlMs()`, env
  `SWARM_SANDBOX_RUNNER_PROBE_FAILURE_TTL_MS`, default 60 s, mirroring
  `executorFailureTtlMs()`) so installing or replacing the runner binary is
  recoverable, and `getExecutor()` re-creates a WEAK executor after the
  executor TTL instead of pinning the PowerShell fallback for the process
  lifetime. Recovery bound: ≤ probe TTL + executor TTL + next-caller delay
  (both default 60 s) — this bounded recovery covers the weak-executor path;
  a `strength === 'none'` executor and the capability-probe/assessment
  memoization still pin as before (pre-existing; tracked). The #2475
  downgrade warnings are now bounded per attempt/reconstruction while broken
  (one warn per failed probe attempt plus one per weak-executor
  reconstruction; the two TTLs are independently configurable and other
  callers may probe between reconstructions, so the combined cadence is the
  sum of those two bounded rates — the bounded re-probe cadence IS the
  recovery mechanism) instead of once per process.
- Glued compositions (`sk-abc-<JWT>`) now select the leftmost-longest family
  span at BOTH sites (disclosed behavior change: the old shell pre-pass
  labeled them jwt; the new span is strictly more redaction).
- Same-class siblings outside this change's surfaces (probe-verified /
  source-traced, recorded for follow-up #3743): the memory-storage secret
  scanner (`src/memory/redaction.ts` findSecrets) has the zw-split gap; the
  capability-probe/assessment memoization layer
  (src/sandbox/capability-probe.ts:927-968) can stay weak after executor
  recovery.

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
