# PR workflow lanes: a lane-liveness watchdog with one settlement horizon and typed conditions

Issue #2242 gave PR-lane settlement a 30-minute staleness horizon; #2251 added
the fail-open liveness probe and probe retention, so a lane the host
affirmatively reports as `busy`/`retry` is spared instead of presumed stale.
What remained missing was everything *above* that floor: a lane that kept
answering "busy" past every deadline could retain forever, a slow-but-alive
provider was indistinguishable from a dead child in the disclosure surface,
and there was no way to notice a lane that had gone quiet mid-flight without
killing it.

## What changed

The gate (`src/hooks/pr-workflow-gate.ts`) gained a lane-liveness watchdog
(`src/hooks/lane-liveness-watchdog.ts`) behind a **default-off** config block.
When enabled it does exactly two things on the existing settlement path:

- **Execution deadline.** A `busy` lane past the effective horizon becomes an
  `execution_deadline`: the watchdog overrides probe retention for it (that
  retention is exactly what could keep a genuinely-over-deadline lane alive
  forever), aborts its session best-effort with its own bounded one-attempt
  abort, and settles it with its real outcome. A `retry` lane is never
  deadlined — provider latency owns its own bounded retry, and a deadline
  must not invent child failure for it.
- **Stall escalation.** Lanes a settlement still considers open are evaluated
  for *advisory* stall: a `busy`/`retry` lane whose observed activity in the
  last `stall_threshold_ms` window missed BOTH the step threshold and the
  estimated-token threshold is escalated — disclosed, never settled or
  aborted. The operator response (inspect the transcript, or the human-only
  force abort) owns the terminal decision.

With the watchdog disabled (the default, and the shape of every pre-#2506
two-argument call), settlement is byte-identical to the substrate: age-only
partitioning, the fail-open probe, probe retention, and the human-only force
exit all unchanged. The disabled path runs no extra status calls and writes
no watchdog events.

## Config surface

New top-level `lane_liveness_watchdog` (strict object, issue #2506):

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Arms the watchdog. |
| `timeout_ms` | `1800000` | The single effective PR-lane settlement horizon when enabled (0–86400000). |
| `stall_threshold_ms` | `300000` | Stall-detection activity window (0–86400000). |
| `stall_min_steps` | `5` | Transcript steps in the window that count as progress (0–10000). |
| `stall_token_threshold` | `200` | Estimated tokens in the window that count as progress (0–1000000). |

Each numeric knob disables its own feature at `0` — `timeout_ms: 0` restores
the reachability-floor horizon, and any zero among the three stall knobs
disables stall escalation while leaving the deadline armed.

The parameter surface (timeoutMs 30 min, stallThresholdMs 5 min,
stallMinSteps 5, stallTokenThreshold 200, 0-disables) and the
re-nudge-suppression idea (never re-escalate a lane that has had no activity
since the last escalation) are adopted from opencode-ensemble with credit,
per ADR 0002 (`docs/decisions/0002-opencode-ensemble-adoption.md`): the
capability decision there is REIMPLEMENT. No upstream code, strings, or
assets are ported — upstream's watchdog is member/worktree-centric and
drives the host client directly, while this one is pure policy over this
repository's own settlement substrate and evidence gates.

## The single-horizon rule

There is exactly ONE effective PR-lane settlement horizon, resolved up front
by `resolveEffectivePrLaneHorizonMs`. An enabled watchdog with
`timeout_ms > 0` owns it; no config, `enabled: false`, or `timeout_ms: 0`
falls back to the 30-minute reachability floor
(`DEFAULT_STALE_DELEGATION_TIMEOUT_MS`), which must never disappear — it is
the guarantee that abort and completion cannot be permanently blocked by a
lane whose backing process died. If `hooks.background_pending_timeout_minutes`
disagrees with the effective horizon, the disagreement is *disclosed*
(`conflictDisclosed` on the horizon resolution consumed by the gate) but
never resolved into a second horizon: the effective horizon remains the one
settlement authority, and the background-pending sweep never becomes a
competing deadline for PR lanes.

## Typed conditions

`classifyLaneLivenessCondition` keeps five liveness conditions
distinguishable, with the frozen precedence `completed_failure` >
`observer_deadline` > `provider_retry_in_flight` > `execution_deadline` >
`idle_failed_child`:

- `observer_deadline` — the caller's collection wait budget expired while the session is live or unknown. Says nothing about the child; never a terminal transition.
- `provider_retry_in_flight` — the host reports the session in `retry`: provider latency with its own bounded retry owner.
- `completed_failure` — the ledger already holds a terminal error: the lane completed, with a real (failed) outcome.
- `idle_failed_child` — an open record whose session is idle or absent below the horizon: the child failed without a terminal write.
- `execution_deadline` — the lane exceeded the effective horizon: aborted best-effort and settled with its real outcome.

A temporarily slow provider or an expired observation budget is therefore
never reported as child failure.

## Stall escalation and durable dedup

Escalation and progression observations are disclosed as
`pr_workflow_lane_watchdog` events in `.swarm/events.jsonl`, carrying the
typed condition, the effective horizon and its source, the lane ids (bounded
to 10), and the stall thresholds. Re-escalation is deduped per lane against
the last escalation *durably* — derived from the existing bounded event log,
not a module-level map, so the dedup survives `resetTrackedStateCache()`
and forks no second durable state file. "Activity since the last
escalation" is falsifiable from disk alone: a progressing lane writes an
`escalated: false` + `activityObserved: true` observation record, and that
record (or the live reader's `lastActivityAtMs`) is what re-arms a
suppressed lane for its next stall. Events older than the 7-day retention
window fold into the manifest header, after which a stale escalation no
longer suppresses a fresh one.

Token counts in the stall surface are transcript-derived **estimates** — the
host API exposes no provider-true per-session token counts — and a lane
whose transcript cannot be read reads as zero activity: the conservative
direction (escalate, then let the operator inspect).

## OBSERVABILITY-1/-2 rebaseline

Issue #2506's summary references an audit document,
`docs/audits/swarm-plugin-review-2026-09.md`; that file is **absent from the
repository**, so the OBSERVABILITY-1/-2 claims were rebaselined against
current production source instead:

- The audit's blanket "transient retry/fallback has no producer" claim is
  **false as stated**. `dispatchWithModelFallback`
  (`src/utils/model-dispatch-fallback.ts`) is a production retry/fallback
  engine with nine production call sites: `src/evaluation/model-dispatcher.ts:208`,
  `src/hooks/curator-llm-factory.ts:247`,
  `src/hooks/skill-improver-llm-factory.ts:164`,
  `src/mutation/generator.ts:150`, `src/tools/dispatch-lanes.ts:3461` and
  `:4060`, `src/turbo/lean/integration.ts:742`,
  `src/turbo/lean/reviewer.ts:595`, and `src/turbo/lean/runner.ts:1461`.
- What IS true, and what the rebaseline pins: the persistent counters
  `transientRetryCount` and `model_fallback_index` have **no production
  incrementer** — the retry/fallback engine produces the behavior but never
  feeds the durable counters, so the observability gap is real once the
  "no producer" claim is corrected to "no counter incrementer".

This section is the executable rebaseline record; the frozen check
(`observability-rebaseline.sh`) verifies both source facts and this
fragment's presence every run.

## Breaking changes

None. The config block is new, strict, and default-off; the disabled path is
byte-identical to the pre-#2506 substrate, no signature changed, and no new
durable state file exists (watchdog disclosures ride the existing
`.swarm/events.jsonl` log).

Found while resolving issue #2506.
