# Defaults Governance — the governed v8 defaults-flip inventory

> Owner: issue #2504 (Workstream F PR 12 of 21), consolidating source EPIC #1677.
> Frame: every v8 default flip must cite production evidence; migration and
> rollback are documented and tested; a conservative preset restores the
> pre-flip (v7) defaults exactly.

This document is the inventory required by #2504: one entry per governed
default change, each with its evidence citations, one-line kill switch, and
rollback, plus the dispositions for the three previously-unowned K3 UX
candidates and the explicitly non-flipped families.

**Release-frame honesty:** the supported-host qualification matrix (#2586) is
still open. The enabled-feature evidence it has published so far (e.g. the R10
dispatch-protection integer/wall-clock budgets) was produced on Windows only,
and its own contract states one platform's fixture does not certify another.
Nothing in this inventory claims Windows/macOS/Linux or Node/Bun qualification
beyond what each cited source actually ran. The default-path completion
evidence from #2585 was produced on a real OpenCode host across three live
runs; see that issue for scope.

## Flip inventory

### 1. `auto_review.enabled` — FLIPPED (v8 release-gated)

- **v7 default:** `false` (opt-in). **v8 default:** `true` (advisory mode) —
  resolves automatically on the first 8.x release when the config does not set
  the key explicitly.
- **Mechanism:** `AUTO_REVIEW_V8_BURN_IN_DECISION` (approved, pins
  `docs/benchmarks/auto-review-v8-cost-baseline.json` at SHA-256
  `b4e981d4…84ce`) + `autoReviewEnabledByRelease` (package major ≥ 8 gate) in
  `src/config/schema.ts`.
- **Production evidence:** #2585 live-host proof (PR #2691: three live
  OpenCode-host runs at one revision with a machine verifier; frozen fixtures
  at `tests/fixtures/pr-review/frozen-limits.json`); #2586 partial
  supported-host evidence (Windows-only R10 cells); published quality
  decisions #2490 (memory-recall regression gate + held-out corpus), #2491
  (review-routing vocabulary, shipped v7.166.4), #2503 (HarnessOpt capstone
  manifest contract). Cost baseline:
  `docs/benchmarks/auto-review-v8-cost-baseline.json` (30 canonical-main
  diffs; min 1,380 / p50 2,438 / p95 50,480 / max 88,121 input tokens;
  800-token output budget; `v8_default_per_phase: "1 reviewer + 0
  validator"`).
- **Kill switch (one line):** `"auto_review": { "enabled": false }`.
- **Rollback:** set the kill switch above (explicit user values always win),
  or set `"preset": "conservative"` to restore every v7 default at once. Whole-
  config rollback: `/swarm config doctor --fix` backs up to
  `.swarm/config-backup-<timestamp>.json` and `/swarm config doctor` documents
  the restore path.

### 2. `execution_profile.parallelization_enabled` (new plans) — FLIPPED (v7.132.0)

- **v7 pre-flip default:** `false` (serial). **Current default:** `true` for
  NEW plans only (v7.132.0, #1674 via PR #1966), with the delegation gate
  enforcing serial automatically whenever the pending tasks are not provably
  file-disjoint. Existing plans are unchanged on upgrade; the plan schema
  default itself stays `false`.
- **Production evidence:** #1674 / PR #1966 (`docs/releases/v7.132.0.md`) —
  gate-enforced serial fallback plus the `plan_conflict_check` advisory tool
  and durable merge-back recovery shipped in the same release.
- **Kill switch (one line):** `execution_profile.parallelization_enabled:
  false` on the plan (per-plan), or `"preset": "conservative"` to make NEW
  plans serial again. While an epic is open (Epic Mode), the epic's wave, not
  `parallelization_enabled`, decides coder concurrency; close or abandon the
  epic (`/swarm epic close`) to return to profile-governed dispatch.
- **Rollback:** as above; conservative preset coverage tested in
  `tests/unit/config/conservative-preset.test.ts`.

## K3 UX candidate dispositions

- **`auto_select_architect` posture (K3 UX-3) — NO schema flip.** F1 (#2493)
  ships the designed posture: the installer writes `auto_select_architect:
  true` for FRESH installs only (`src/cli/index.ts`), the schema default stays
  omitted/`false`, and a one-time advisory fires when a session starts on a
  non-architect agent. Flipping the schema default would silently disable the
  host's built-in build/plan agents for every existing user who never set the
  key — a behavior change with no exit evidence, and against F1's "never fight
  the user configuration silently" invariant. Disposition: keep the
  install-layer activation exactly as shipped.
- **Always-visible startup health banner (K3 UX-6) — DEFERRED, no flip.** No
  exit evidence exists for an always-visible banner. Recurring cost: every
  chat-visible line must ride a user-role guidance carrier
  (`src/hooks/system-guidance-carrier.ts`) because the pinned host discards
  `role: 'system'` entries in `messages.transform` (AGENTS.md invariant 10),
  and carrier content is counted against the bounded injection/turn budget
  (#2107, "Unify context pressure, injection budgets, and summary
  continuity"). Existing health surfaces (startup config doctor when enabled,
  model preflight warnings, `/swarm doctor`, the automation-status artifact)
  remain the supported channels. A future banner needs its own evidence-gated
  flip entry here.
- **Free-tier model default resolution against the live catalog (K3 UX-7) — NO
  default change.** The asked-for behavior already ships: `DEFAULT_MODELS` /
  `DEFAULT_AGENT_CONFIGS` pin free-tier models with multi-level fallback chains
  (`src/config/constants.ts`), and `runModelPreflight`
  (`src/services/model-preflight.ts`) resolves every enabled agent's effective
  model against the live provider catalog at startup (fail-open) and inside
  `/swarm doctor`, warning on unresolved selections. There is no proposed
  model default change to govern.

## Non-goals (not flipped without their own exit evidence)

Per #2504: "Do not default-enable experimental resilience, autonomy, remote
export, training capture, or sandbox behavior without their own exit
evidence."

- **Experimental resilience:** `pr_review_resilience.enabled` stays `false`
  (staged canary/fanout; no exit evidence).
- **Autonomy:** `full_auto.enabled` stays `false`; `automation.mode` stays
  `"manual"`.
- **Remote export:** `observability.export.enabled` stays `false` (local
  operation is fully independent of the exporter).
- **Training capture:** consent-gated via `/swarm dataset` commands; no config
  default to flip.
- **Sandbox:** `guardrails.sandbox_macos_enabled` stays optional/absent (the
  SBPL profile is explicitly not re-verified against a real macOS host from
  this repository's dev environments); sandbox mode stays `advisory`.

### Also not flipped (disqualifying evidence)

- `parallelization.enabled` (config-level): dark foundation — no production
  code path branches on it yet (`src/config/schema.ts`).
- `memory.*` / `context_map.enabled`: #2490 shipped a memory-recall regression
  gate, but its own release (`docs/releases/v7.148.0.md`) records that the
  graph-memory acceptance criteria were not met — no burn-in evidence to
  promote (#1677 allows these flips "only if their burn-in evidence is
  published").
- `architectural_supervision.enabled`: no published evidence.
- `epic.mode.enabled` (Epic Mode, preview) and `epic.cochange.enabled`: both
  stay `false` (opt-in); the conservative preset does not touch them.

## Conservative preset

`"preset": "conservative"` (top-level config key, #2504) restores the pre-flip
v7 defaults for every flipped surface: `auto_review.enabled: false` and serial
new plans. It is applied as the lowest-precedence layer in config resolution,
so an explicit user key always wins over the preset. `"preset": "default"` or
an absent preset applies the governed v8 defaults. See
`docs/configuration.md` (`preset`) and `tests/unit/config/conservative-preset.test.ts`.

## Migration, warnings, and acknowledgment

`/swarm config doctor` surfaces pending v8 default changes as `defaults-flip`
findings (info severity) while `config_format_version < 3`, naming the change,
the kill switch, and the conservative preset. Running
`/swarm config doctor --fix` acknowledges them by stamping
`config_format_version: 3` (idempotent; passive scans never write). The
Compatibility Matrix (behavior by config vintage and preset) lives in
`docs/installation.md`.

## Cost-delta statement

At the v8 default posture the advisory auto-review adds one reviewer dispatch
and no validator per phase (`v8_default_per_phase` in the pinned cost
baseline: min 1,380 / p50 2,438 / p95 50,480 / max 88,121 input tokens per
diff, 800-token output budget). Parallel-first new plans run concurrent coders
only for provably file-disjoint work, bounded by the plan's
`max_concurrent_tasks`. Users who need the v7 cost profile set
`"preset": "conservative"`.
