# Advisory headless CI (`swarm ci`)

`swarm ci` runs the gated swarm pipeline's **advisory evaluation** in a clean,
noninteractive environment — a CI runner with no TTY, no OpenCode host, and no
plugin boot. It reads the checked-out repo's `.swarm/` durable state through
the same authoritative readers the live gates use, reports what it found, and
exits with a machine-readable status. It never runs agents, never dispatches
LLMs, and never writes to the repo.

```bash
bunx opencode-swarm ci                 # Markdown report + [SWARM_CI_JSON] block
bunx opencode-swarm ci --json          # machine block only
bunx opencode-swarm ci --timeout-ms 600000
# equivalent inside OpenCode: /swarm ci ... ; registry form: bunx opencode-swarm run ci ...
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | every evaluated gate passed (and at least one gate was evaluated) |
| 1 | any gate violation, a required check with **no data**, corrupt evidence, or nothing to evaluate (missing/unparseable/empty plan) |
| 2 | cancelled (SIGINT/SIGTERM) |
| 3 | deadline exceeded or internal error |

"No data" is never a pass: a task with no recorded gate evidence, or a quality
threshold with no evidence corpus, is reported `no_data` and fails the run —
this is the honest-disposition fix for the vacuous-pass behavior the in-process
`benchmark --ci-gate` exhibits when its live session-state inputs are empty.

## What is evaluated

Composed from the existing authoritative readers (no reimplementation):

- **Plan** — `.swarm/plan.json` projection must exist, parse, and contain tasks
  (`plan_missing` / `plan_corrupt` / `no_tasks` are distinct exit reasons).
- **Plan critic** (`critic_pre_plan`) — the `plan_critic_gate` APPROVED snapshot
  matching the current plan structure.
- **Per-task gates** — for every plan task: the reader-derived required gates
  versus recorded gate evidence, with the workflow state guard (a task counts
  as satisfied only when all required gates are satisfied AND its workflow
  snapshot is terminal-success: `complete` or `closed`). Evidence is tri-state:
  `valid` / `missing` / `corrupt` are reported distinctly (#2470 semantics).
- **Evidence-quality thresholds** — review pass rate (≥70%), test pass rate
  (≥80%), quality-budget deltas (complexity ≤5, public API ≤10, duplication
  ≤5%, test-to-code ≥30%), each `pass` / `fail` / `no_data`. This computation
  is shared with `/swarm benchmark --ci-gate` (one implementation, two callers).

Enabled profile gates that have no durable whole-plan reader (drift check, SME,
councils, mutation) are listed in the report as **not evaluated** — reported,
never silently passed. Live session-state checks (agent error rate, hard-limit
hits) are listed as **not evaluable headless**.

## Machine output

The `[SWARM_CI_JSON]` … `[/SWARM_CI_JSON]` block wraps the pretty-printed
report: `verdict`, `exit_reason`, `gates[]` (name + `pass|fail|no_data|corrupt|error`),
`tasks[]` (task_id, evidence_state, required_gates, missing_gates, workflow_state),
`environment` (`{mode:"advisory", tty, host:"none"}`), `gate_profile`
(`default` when no QA profile is persisted), `effective_gates`, `not_evaluated`,
`not_evaluable`, and per-status `counts`. Consume it from stdout:

```bash
output=$(bunx opencode-swarm ci --json 2>/dev/null); rc=$?
report=$(printf '%s\n' "$output" | sed -n '/^\[SWARM_CI_JSON\]$/,/^\[\/SWARM_CI_JSON\]$/p' | sed '1d;$d')
```

## Read-only guarantees

- The evaluated repo is never modified: file-backed reads are pure, and
  DB-mediated reads (gate profile, plan-critic snapshots — which open the
  SQLite store and would create WAL sidecars) run against a bounded, discarded
  temp **shadow copy** of `.swarm/`. If the shadow exceeds 512 MiB, those rows
  are reported as errors instead of copying unbounded data.
- No gate can be satisfied or bypassed from this path — it only reads and
  reports. The live enforcement points (delegation gate, reviewer/test gates at
  task completion) are unchanged.
- The evaluation spawns no subprocess and needs no `opencode` binary, no
  config, and no TTY (`env -i` clean environments are supported).

## Bounds

Startup and evaluation run under an overall deadline (`--timeout-ms`, default
300000). SIGINT/SIGTERM abort the run (exit 2) and run registered cleanup
exactly once; the run journal is capped at 200 events. Note that POSIX-style
self-signalling is unreliable on Windows (Git Bash in particular), so treat
signal-driven exit 2 there as best-effort; the `--timeout-ms` deadline is the
portable bound.

## Related

- `/swarm benchmark --ci-gate` — the in-process CI threshold gate (plugin
  context; shares the evidence-quality computation with `swarm ci`).
- `/swarm ci-simulate` — pre-merge merge-result worktree simulation.
- `/swarm ci-monitor` — drive an approved PR to green and merged.
