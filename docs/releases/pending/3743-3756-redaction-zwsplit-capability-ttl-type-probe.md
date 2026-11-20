---
issue: 3743
---

# Redaction fill tolerance for the memory scanner, capability/executor TTL recovery, and the vendored-surface type-probe gate

Closes #3743, closes #3756 (collated; the #3743 investigation note suggested two PRs — the collation follows the standing maintainer authorization for multi-issue PRs while the diff stays sectioned per subsystem).

## What changed

- **Memory secret scanner (findSecrets / containsSecret / redactSecrets)** now matches a Cf/DI-deleted condensed view in addition to the raw text (the #3730 two-view pattern, mirrored inline per that precedent): a credential split by an invisible byte (U+200B etc.) is detected and redacted exactly like its plain form, across all 14 pattern families. Per-pattern sequential-priority semantics are preserved (base outputs byte-identical for non-Cf inputs). Because durable-secret rejection decisions change, `REDACTION_POLICY_SALT` and `FINGERPRINT_ALGORITHM_VERSION` bump 3 → 4: existing cohort members surface as "re-run `/swarm memory link`" instead of a false config mismatch (the same remedy as the #1466/#3382 bumps).
- **JWS scanner residuals** (`src/utils/jws-redaction.ts`): a dir-JWE whose IV fails the tokenLike predicate no longer stays fully visible (the IV position is structural); a 13–39-char standard header that strictly decodes to a JSON object is redacted (the 40-char floor stays for non-JSON headers, so benign dotted paths stay visible); glued-composition tails are recovered via candidate enumeration + a header-overreach clamp + a coverage-preserving final normalization. One approved widening: two clamp-adjacent spans may merge across an internal separator dot (coverage never shrinks; same disclosed over-redaction class as the existing `…sig.Snapshot` absorption).
- **Sandbox capability memo TTL**: a degraded win32 PowerShell-fallback capability memo expires after 60 s (env-overridable test knob) instead of pinning for the process lifetime — after a transient runner-probe failure + recovery, policy assessment and `/swarm diagnose` re-derive within a bounded interval, and the executor-mechanism-drift hard block no longer wedges every shell call. A `none`-strength executor is TTL-bounded in `getExecutor` like null/weak (construction-time class; an explicit `disable()` stays permanent by design). `/swarm diagnose` never reports a `none` executor as strong.
- **Shell-audit dash-flag arms** are bounded (`{0,64}` around the keyword, the existing KV-arm convention): a 20,000-dash `git commit -m` audit drops from ~5–7 s to ~25 ms.
- **Vendored-surface type probe is wired into CI**: the ci.yml quality job runs `scripts/check-vendored-surface-probe.ts` (behind the release guard), which compiles `tests/unit/host/v2/vendored-surface-2-3-0.type-probe.ts` with the pinned local TypeScript — including a `--self-test` that breaks `types.ts` and requires the gate to catch it. New C3 source-scan rows reject a `| undefined` widening of `V2JsonValue` and pin `prompt: string` on `V2ExperimentalGenerateApi`. The gate is invoked directly (no package.json alias): package.json is release-please-owned.

## Why

- #3743: two probe-verified siblings of the #3730/#3736 defect family (memory-scanner zw-split gap; capability-probe memoization staying weak after executor recovery) plus the five absorbed redaction-scanner residuals from PR #3742's review rounds.
- #3756: the vendored-surface type probe was executed by no automated gate (verified by three independent reviewers during PR #3741) — its assignability contract rotted silently on every pin refresh.

## Notes for reviewers

- The redaction-policy/fingerprint version bump means cohort configs written before this change re-link on next `/swarm memory link` (legacy v1 classification unchanged).
- The `as never` hook-call cast removal (AC11 of #3756) deliberately rides the #3642 epic, not this change.
