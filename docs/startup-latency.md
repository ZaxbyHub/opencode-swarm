# Startup and First-Use Latency Contract

> Issue #2670. The contract that keeps startup performance claims honest: every
> interval is measured and reported separately, optional work has bounded
> outcomes, and readiness warnings/configuration churn are never confused with
> latency.

## Stage definitions

The plugin (`src/observability/startup-contract.ts`) measures and emits each
stage SEPARATELY as single-line `STARTUP-CONTRACT <json>` rows on stdout, only
under `OPENCODE_SWARM_DEBUG=1`. With the env var unset, ZERO contract rows
appear (a debug-off probe asserts this in every harness run).

| Stage | Row | Definition |
| --- | --- | --- |
| Import | `{"stage":"init","importMs":N,...}` | `performance.now()` at the end of `src/index.ts` module evaluation — milliseconds since `performance.timeOrigin` (process start). Note: the harness child's externally-measured import timer additionally includes its own `node:perf_hooks` import and preload; the two values are intentionally not expected to be identical. |
| Server | `{"stage":"init","serverMs":N,...}` | `server()` entry → resolution, measured by the plugin wrapper in `src/index.ts`. |
| First turn | `{"stage":"first_turn","ms":N}` | Time from server resolution until the FIRST `experimental.chat.messages.transform` invocation settles (success or rejection), once per process. |
| First tool | `{"stage":"first_tool","tool":"<name>","ms":N}` | Time from server resolution until the FIRST tool execute settles (success or rejection — an errored first call is still a first use), once per process, labeled with the tool name. |
| Readiness | `{"stage":"queue_settled","tasks":N,"completed":N,"failed":N,"ms":N,"advisories":N}` | The wrapper-owned post-resolution queue has fully drained: every scheduled optional task settled. `ms` is measured from drain scheduling. Optional work NEVER gates manifest delivery. |
| Optional task outcome | `{"stage":"optional_task","task":"<name>","outcome":"completed"\|"failed","ms":N}` | Per-task outcome row; `ms` is the task's own duration, measured from its start in the drain macrotask (all tasks start in the same macrotask, so this equals duration-from-drain-start in production). `failed` rows carry a bounded `error` string (≤200 chars, single line, no stack, no paths). Tasks whose function has no name are labeled `anonymous`. A task appended to the queue after a settle still gets its outcome row (bounded late-task behavior) but does not re-open the window. |

## Budgets (hard upper bounds)

| Interval | Budget |
| --- | --- |
| import | ≤ 8000 ms |
| server (matrix cells) | ≤ 4000 ms |
| first turn | ≤ 8000 ms |
| first tool | ≤ 8000 ms |
| queue settle (readiness) | ≤ 45000 ms |
| optional-task failure diagnostic | ≤ 200 chars, no stack |

The budgets sit deliberately far above the tight repro-704 control
(`scripts/repro-704.mjs`, `TIMING_DEADLINE_MS = 400` for `server()` resolution
on a 500-file cold workspace) — that control remains authoritative for the
init-path deadline it has always covered; this contract measures the complete
first-use journey.

## Warm/cold methodology

- **Cold** means a fresh `node` child process per repetition, a fresh
  `mkdtempSync` workspace (`src/a.ts` + `src/b.ts`, with or without a `git`
  repository initialized and committed), and a fresh isolated
  `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` so no user config leaks in.
- **Warm** is not asserted anywhere: repetition exists to show a distribution,
  not to claim a best case. Each cell runs multiple repetitions and the report
  carries min/median/max with outliers retained.
- Budget enforcement in CI uses the **minimum across the repetitions of a
  cell**: a single cold-runner transient (AV indexing, scheduler noise) cannot
  block the merge queue, while the distribution — including the outlier — is
  printed and retained. Never rewrite architecture from one timing sample.
- The child drives the real host journey: import of the built bundle,
  `server(ctx)`, a real `experimental.chat.messages.transform` invocation, the
  first registered tool's real `execute`, then a bounded wait (45 s) for the
  plugin's own `queue_settled` marker. The child never calls `process.exit`;
  a leaked plugin handle hangs it into the outer spawn timeout (that is the
  leak check). A clean process exit alone is NOT accepted as evidence — the
  manifest (tool/agent counts) and every marker row are asserted.

## Interpretation rules

- **A Linux pass does not establish a Windows cold-filesystem claim.** Cold
  Windows runners with antivirus/indexing routinely add 100–500 ms per init
  I/O step (see `src/index.ts` init comments). The CI matrix runs the harness
  on ubuntu/macos/windows precisely because the cells are not interchangeable;
  a cell that was not exercised in a given run is reported as unmeasured —
  never claimed.
- **Readiness warnings are separate from server latency.** The
  `queue_settled.advisories` field counts advisories routed through
  `addDeferredWarning` during the startup window only (server entry → queue
  settle; the window never re-opens). The harness additionally records
  readiness-warning LINES from the debug stream as a separate column. Neither
  is part of any interval.
- **Configuration churn is a harness-side column, not latency.** The harness
  snapshots the workspace before/after each run: the count of
  `.swarm/config-backup-*.json` files and any write to
  `.opencode/opencode-swarm.json`. A healthy startup produces zero new
  backups; the degraded cells prove the pre-existing backup survives and no
  new one appears even when the optional status writer fails (the #2669
  contained classes).
- **Optional work is never a gate.** Manifest delivery, tool registration, and
  the default startup path do not depend on any optional task. A failing
  optional task produces a bounded `failed` outcome row and nothing else.
- Filesystem type is not portably detectable from Node on every platform; the
  report carries `fsType: null` with a note rather than a guess.

## Running the harness

```bash
bun run repro:2670            # full distribution report (default 3 reps/cell)
bun run repro:2670 -- --ci    # budget matrix (min-of-reps policy)
node scripts/repro-2670.mjs --expect-report   # report-contract validation
node scripts/repro-2670.mjs --churn-fixture   # degraded-cell negative paths
```

Env: `REPRO_2670_REPS` (repetitions per cell), `REPRO_2670_SKIP_BUILD=1`
(reuse an existing `dist/index.js`), `REPRO_2670_NODE_MODULES` (junction
source when running from a worktree without `node_modules`).

CI: the smoke job (merge-group gated, ubuntu/macos/windows, Node 22) runs
`node scripts/repro-2670.mjs --ci` with `REPRO_2670_REPS=2` next to
`scripts/repro-704.mjs`. Unit-level deterministic coverage lives in
`tests/unit/observability/startup-contract-2670.test.ts` and
`tests/unit/index-startup-contract-outcomes-2670.test.ts` (including the
structural assertion that no optional task runs before manifest delivery).

## Diagnosing slow startup with the contract

1. Run with `OPENCODE_SWARM_DEBUG=1` and collect the `STARTUP-CONTRACT` rows.
2. High `serverMs` with low `importMs`: init-path I/O (config load, snapshot,
   git-exclude) — compare against the repro-704 control.
3. High `importMs`: module-graph cost of the bundle — check bundle size and
   recent import growth.
4. High `first_turn_ms`/`first_tool_ms` with low `serverMs`: cold caches in
   the chat-transform chain or tool warm-up, not an init regression.
5. High `queue_settled.ms`: one optional task is slow — find the matching
   `optional_task` row by duration; `failed` rows carry the bounded reason.
6. Elevated `advisories`: read the readiness-warning lines before tuning
   latency — they are a different problem class.
