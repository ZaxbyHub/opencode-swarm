# Epic Mode (preview): activation gate and `/swarm epic`

## What changed

- Epic Mode is now a usable, opt-in execution mode (Capability C). When
  enabled per session, the architect calls `epic_decide_phase(phase)` —
  instead of `lean_turbo_run_phase(phase)` — to decide a phase. The
  tool computes the plan-wide coupling coefficient `p`, gates promotion
  on three independent checks (p-threshold, hot-module, greenfield),
  appends the decision to the evidence log, and returns a verdict: on
  **promote** the architect calls `epic_plan_waves(phase)` and dispatches
  each wave via the visible `Task` tool; on **demote** it falls back to
  the standard per-task serial path.
- New module surface in `src/turbo/epic/`:
  - `state.ts` — durable per-session state at `.swarm/epic-state.json`
    (atomic `tmp + rename`, per-directory fail-closed marker, mirrors
    the lean-turbo state shape *without* sharing its file).
  - `activation.ts` — the pure `decideEpicActivation(tasks, pairs,
    commitsObserved, options)` function. Returns
    `{ decision: 'promote' | 'demote', p, rationale, blockingReasons }`.
  - `promotion-evidence.ts` — append-only JSONL writer for
    `.swarm/evidence/epic-promotions.jsonl`. Read-tolerant of partial
    trailing-line writes.
- New architect-facing tool `epic_decide_phase` (`src/tools/epic-run-phase.ts`)
  that wires the above together: verify mode active, load plan, resolve
  task scopes, run the calibration loop, compute the verdict, append
  evidence, and record the session decision — WITHOUT dispatching (the
  architect dispatches via `epic_plan_waves` + `Task`). The legacy
  unified `epic_run_phase` function that dispatched into `LeanTurboRunner`
  directly is retained for composition/tests but is deprecated and not
  registered for the architect.
- New slash command `/swarm epic` with subcommands `on / off / status /
  decide`. Bare `/swarm epic` toggles. `decide` is a read-only what-if
  that runs the decision and prints the rationale without dispatching
  or writing evidence.
- New `turbo.epic.mode.*` config block (defaults: `enabled: false`,
  `activation_threshold: 0.3`, `min_commits_for_signal: 20`). Added
  to the existing `EpicConfigSchema`.
- New tool registered the project's standard way: a `TOOL_METADATA` entry in
  `src/tools/tool-metadata.ts` plus a `TOOL_MANIFEST` handler in
  `src/tools/manifest.ts` (both compile-checked) and an export in the
  `src/tools/index.ts` barrel; the plugin object, `TOOL_NAMES`, and
  `AGENT_TOOL_MAP` derive automatically.
- 73 new tests covering the durable state (atomic write, fail-closed,
  enable/disable round-trip, decision recording), the activation logic
  across the three gates (each gate individually + combined-failure +
  edge cases), the promotion-evidence writer (append, read, malformed
  line tolerance, error path), the tool integration (failure modes,
  demotion path, promotion path, per-plan decision aggregation), the
  slash command (session validation, on/off/toggle, status, decide,
  empty-string subcommand handling, state-unreadable status), the
  unified `/swarm turbo epic on/off/toggle` subcommand, and the
  `EPIC_MODE_BANNER` content + `hasActiveEpicMode` per-session
  / global lookup.

## Auto-dispatch (M3.5)

Enabling Epic Mode via `/swarm epic on` or `/swarm turbo epic on` sets
the in-memory `session.epicModeActive` flag (mirrored from the durable
`.swarm/epic-state.json`). The system-enhancer hook
(`src/hooks/system-enhancer.ts`) detects the flag on every architect
turn and injects an `EPIC_MODE_BANNER` into the architect's prompt,
instructing it to use the `epic_decide_phase` → `epic_plan_waves` →
`Task` flow instead of `lean_turbo_run_phase` for phase execution.

This wiring follows the same pattern Lean Turbo, Turbo Mode, and
Full-Auto already use for their banners. The additive edits required:
`src/state.ts` (new `epicModeActive` session field +
`hasActiveEpicMode` helper), `src/hooks/system-enhancer.ts` (new
import + two banner-injection sites), `src/config/constants.ts` (new
`EPIC_MODE_BANNER` constant). No existing banner / hook / session-state
behavior is modified.

## Why

Capabilities A and B gave us a measured coupling signal and a way to
see it. Capability C is what turns those measurements into a
decision: per plan, *should* this work be parallel at all? The brief's
"default serial, promote on proof" rule (§4.2) becomes operational —
parallel execution requires positive evidence on every gate, not just
absence of failure.

## Migration steps

None. With `turbo.epic.mode.enabled` left at its default (`false`), no
Epic-mode runtime code runs. The `epic_decide_phase` tool registers as a
normal tool but is never invoked unless Epic Mode is enabled and the
architect explicitly calls it. Existing modes (Lean Turbo, Turbo,
Full-Auto, standard serial) behave exactly as before.

## Breaking changes

- None. All schema additions are optional fields with safe defaults.
  All registry / TOOL_NAMES additions are purely additive.

## Known caveats

- **No new degradation tier.** When Epic Mode promotes, individual
  task degradation inside each phase is still handled by Lean Turbo's
  existing per-task logic — unchanged. Epic Mode never adds new
  per-task decisions.
- **Defaults are reasoned estimates, not measured optima.** The
  `activation_threshold: 0.3` and `min_commits_for_signal: 20` defaults
  flow from the brief's "conservative" framing; they have not been
  tuned against production outcomes.
- **No telemetry-fed learning yet.** The evidence file is an audit
  trail, not a feedback loop. Outcome-based self-calibration is M4's
  scope; M3 does not consume the evidence it writes.
