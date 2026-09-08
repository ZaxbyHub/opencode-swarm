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

## Gated GitHub Action publisher (#2498)

The repository also ships a Linux-only composite Action for consumers that
want a labeled issue or an explicit dispatch to drive a bounded Swarm run and
open one pull request only after the independent gates pass. The public
contract is [the root `action.yml`](../action.yml); a default-off two-job
caller is provided in
[`examples/github-action/swarm-publish-gated.yml`](../examples/github-action/swarm-publish-gated.yml).
The example is intentionally outside `.github/workflows/`: copy it into a
consumer repository, replace both `REPLACE_WITH_40_CHAR_COMMIT_SHA` sentinels
with the exact immutable commit SHA of the Action release you reviewed, and
configure it before enabling it. The sentinel is deliberately not a runnable
Action ref, so an unedited copy fails closed.

### Authority boundary

The caller has two separate jobs and two separate credential domains:

- **prepare** has `contents: read` and `issues: read`, checks out with
  `persist-credentials: false`, verifies a labeled trigger's actor has
  write-level repository permission, resolves the issue from the canonical
  `https://github.com/OWNER/REPOSITORY/issues/NUMBER` URL, and passes issue
  text as fenced untrusted data. It must not receive a publication token. It
  runs the issue → spec → plan → implementation → review → tests → `swarm ci`
  pipeline, requires the configured issue-tracer identity and complete stage
  evidence, scans the proposed publication surfaces (including binary patch
  content), and uploads a repository/issue/delivery/base SHA-bound artifact.
- **publish** starts from a fresh non-persisting checkout and has only
  `contents: write` and `pull-requests: write`. It is attached to a protected
  GitHub Environment with required reviewers. A denial or timeout leaves the
  run paused and cannot publish. After approval, the Action verifies the
  artifact and base binding, rejects live-default-branch drift, applies the
  patch without running repository code, disables repository hooks for the
  commit, and performs a create-only non-force branch claim before creating or
  reusing the pull request. Existing branches are reused only after the exact
  bound patch/tree is verified; the publisher never force-updates an existing
  branch.

The prepare job has no write-capable credential, and the publish token is
passed only to the publish Action invocation. `.git`, `.swarm/`, credentials,
trace transcripts, unsafe paths, and secret-bearing summaries are excluded
from the publication artifact. Fork or repository-mismatched requests fail
closed before any publication side effect.

### Setup, inputs, and outputs

Before enabling the copied caller, preinstall the required Node, Bun, and
OpenCode versions on the consumer runner and bind the `opencode-swarm` Action
to the exact reviewed ref. Set repository variables `SWARM_NODE_VERSION`
(including the `v` prefix printed by `node --version`), `SWARM_BUN_VERSION`,
`SWARM_OPENCODE_VERSION`, `SWARM_PLUGIN_REF` (a 40-character reviewed commit
SHA matching the Action ref), and `SWARM_ISSUE_TRACE` (the expected
issue-tracer identity) to those exact values. The
prepare job compares the installed Node, Bun, and OpenCode versions with the
first three variables and fails closed if they differ; `SWARM_PLUGIN_REF` is
passed to both Action phases as the binding for the Action/plugin source, and
the composite Action compares it with GitHub's resolved `github.action_ref`
before starting the runner. The prepare step then verifies the pinned Bun,
changes to `$GITHUB_ACTION_PATH`, and runs bounded 600-second
`bun install --frozen-lockfile` and `bun run build` commands. It requires a
regular, non-symlink `dist/cli/index.js` from that Action directory before the
runner starts. The committed `bun.lock` is authoritative: the bootstrap does
not resolve floating dependency versions, but it does require registry network
access and write access to the extracted Action directory; install, build,
offline, or timeout failures block publication. The
workflow does not silently install floating packages or refs. Configure the
fixed `swarm-publish` Environment with required reviewers; the workflow
deliberately does not expose an Environment name as a dispatch input. Keep the
Action `uses:` ref immutable and update it only through a reviewed change.

The Action accepts `mode: prepare|publish`, repository and issue identity,
canonical issue URL, delivery ID plus run ID/attempt, live base branch and
base SHA, issue title/body, trigger label/labeler, model and agent selection,
bounded `deadline-ms` and `max-attempts`, toolchain/plugin pins, expected
issue-trace identity, artifact path, optional `provider-env`, and (publish
only) `publication-token`. `provider-env` is a comma-separated declaration of
provider environment-variable names from the Action's documented allowlist
(for example `OPENAI_API_KEY`); the caller supplies those values through the
step/job environment. The values are copied only into the OpenCode provider
child during prepare. The Action's dependency install/build, Git, CI CLI,
artifact, and publish paths receive a sanitized environment, and the names
are never accepted as arbitrary shell syntax. Omit `provider-env` when the
selected OpenCode setup does not require caller-supplied provider credentials.
It exposes
`status`, `pr-url`, `pr-number`, `evidence-path`, and the stable `run-key`.
Issue fields are data, not instructions; the runtime fences them before the
agent phase.

Every prepare failure, nonzero `swarm ci` result, cancellation, timeout,
oversight denial, stale base, malformed/tampered artifact, or secret-scan
finding blocks publication. Transient prepare failures are retried only within
the total deadline and before workspace mutation. Duplicate deliveries use a
stable repository/issue identity and converge on one deterministic branch and
pull request; a losing publisher never force-updates the winner's branch.

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
