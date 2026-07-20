# Loader recovery metadata exposure + Turbo disclosure expansion

Closes #1690.

## What changed

Implements FR-001, FR-002, FR-003, FR-004 from the deferred work tracked in #1690.

### FR-001 — Loader recovery metadata exposure

`loadPluginConfigWithMeta` and `loadPluginConfigWithMetaAsync` now expose the recovery decision to programmatic callers:

```ts
interface RecoveryInfo {
  recovery: "none" | "stripped_keys" | "user_only" | "guardrails_defaults";
  removedKeys: string[]; // dotted key paths dropped during recovery
  warnings: string[];     // per-recovery advisory messages
}
```

- `parseConfigWithFallback` threads `stripUnrecognizedKeys`'s `removed[]` through the loader's existing retry chain.
- Bug fix at `loader.ts:626-640` and `loader.ts:753-770`: both sync and async paths now return `recovery: "guardrails_defaults"` with the SECURITY warning when `loadedFromFile && configHadErrors`.
- `src/config/index.ts` `_internals.loadPluginConfigWithMeta` returns the new fields.
- 17 regression tests at `tests/unit/config/loader.metadata.test.ts` cover SC-001.1 through SC-001.7 (gates/council/checkpoint/pr_monitor/turbo.epic per-section), SC-001.5 backward-compat, async parity.

### FR-002 — Turbo mode disclosure expansion

Four standard turbo enable messages + the Lean Turbo variant now enumerate:

- **Bypassed:** Stage B (reviewer + test_engineer) for Tier 0–2 tasks + phase_complete Gates 1–5 (completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council) via the orchestrator short-circuit.
- **Still enforced:** Stage A, Tier 3 Stage B, Gate 5b (architecture-supervisor), Gate 6 (final-council), Gate 7 (full-auto).

`TURBO_MODE_BANNER` at `src/config/constants.ts:602` tightened to match. Registry help text at `src/commands/registry.ts:1235-1239` updated.

### FR-003 — QA-gate dialogue consolidation

- `references/qa-gate-gates-body.md` — canonical source for the 11-gate body + 3 shared sub-items (parallel coder, commit frequency, auto_proceed).
- `scripts/sync-qa-gate-skills.ts` — Bun script that inlines the canonical body into the 6 mirror SKILL.md files via `<!-- BEGIN QA_GATE_BODY -->` / `<!-- END QA_GATE_BODY -->` markers. Idempotent, byte-identity-enforced.
- `package.json` — `skills:sync` script wired.
- 12 sync tests at `tests/unit/skills/qa-gate-body-sync.test.ts` verify markers present, mirror byte-identity, canonical body reachable, sync idempotent.
- `src/agents/architect.ts` — removed dead `{{QA_GATE_DIALOGUE_*}}` placeholder substitution at lines 1727-1743. `buildQaGateSelectionDialogue` retained as test-only oracle with JSDoc.

### FR-004 — Doctor fast-path + surgical command-return surfacing

`src/commands/doctor.ts` uses `loadPluginConfigWithMeta`; surfaces a `## Config Recovery` section listing recovery type + removed keys + warnings when `meta.recovery !== 'none'`. 4 tests at `tests/unit/commands/doctor-command-recovery.test.ts` cover SC-004.1, SC-004.2, SC-004.3.

## Why

Issue #1690 had two core complaints: silent recovery (no user-visible signal when config was wiped) and turbo's bypass scope was undocumented. FR-001 surfaces the recovery. FR-002 makes turbo's bypass explicit. FR-003 unifies the QA-gate selection dialogue. FR-004 gives doctor the data to surface the recovery.

## How to use

Nothing changes for end-users. `/swarm config doctor` now prints a `## Config Recovery` section when a fallback recovery occurred. `/swarm turbo on` messages enumerate which gates are bypassed.

Programmatic consumers (commands, hooks) can now use:
```ts
const meta = _internals.loadPluginConfigWithMeta(directory);
if (meta.recovery !== "none") {
  // surface meta.removedKeys + meta.warnings to user
}
```

## Migration

No migration required. The new fields are additive on `loadPluginConfigWithMeta` and `loadPluginConfigWithMetaAsync`; existing callers that destructure only `config` continue to work.

## Known caveats (follow-ups tracked in #1900)

1. **Architectural**: Three hand-maintained copies of the merge→parse sequence in `loader.ts`. Drift risk — fix in a follow-up by refactoring to a single shared core with fs I/O as the only sync/async difference.
2. **`full_auto.locked` OR-merge missing in async path**: defensive config feature is bypassable via async init. Resolved as side-effect of follow-up #1.
3. **`gates` section pre-Zod sanitization strips silently**: `gates.*` typos don't surface in `recovery` metadata. Currently visible via doctor's raw re-read fallback (`collectRawGatesConfigFindings`). Follow-up: surface gates strip in recovery metadata.
4. **No explicit sync/async parity test**: drift is caught only by humans. Follow-up: add `loader.metadata.parity.test.ts` asserting deep-equal metadata for the same fixture.

These are non-blocking for the PR but flagged in the phase_council and final_council advisory notes.