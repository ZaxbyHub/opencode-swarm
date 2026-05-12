# Execution Modes

Swarm has two orthogonal mode systems:

- **Session modes** (Turbo, Full-Auto) — toggled per-session via `/swarm turbo` and `/swarm full-auto`.
- **Project modes** (`execution_mode`) — set in config; controls hook overhead project-wide.

They compose independently. You can run `execution_mode: "strict"` with Turbo on, or `execution_mode: "balanced"` with Full-Auto on.

---

## Session Modes

### Balanced (default)

All QA gates run normally. Every task passes through reviewer + test_engineer before the architect marks it complete. This is the default when no session mode is set.

### Turbo

Skips Stage B (reviewer + test_engineer) for low-risk tasks. The task still goes through automated gates (syntax, placeholder, SAST), just not human-level review.

**Turbo does NOT skip Tier 3 files.** Security-sensitive paths always run full review, even when Turbo is on:

- `architect*.ts`, `delegation*.ts`, `guardrails*.ts`, `adversarial*.ts`, `sanitiz*.ts`
- `auth*`, `permission*`, `crypto*`, `secret*`, `security*.ts`

This list is enforced at `src/tools/update-task-status.ts:98-109`. You cannot turn it off.

**When to use:** rapid iteration on non-critical code — UI tweaks, documentation, internal refactors.

**Toggle:**

```bash
/swarm turbo on
/swarm turbo off
/swarm turbo          # toggle
```

Session-scoped. Resets when you start a new session.

### Full-Auto

Full-Auto is opencode-swarm's autonomy control plane. It reduces approval friction by deterministically allowing safe operations and routing ambiguous or high-risk operations through the read-only `critic_oversight` agent before they execute. Unlike Turbo (which bypasses Stage B for non-Tier-3 files), Full-Auto adds a *new* decision layer on top of every existing guardrail.

**Config-gated.** You cannot enable Full-Auto via `/swarm full-auto on` alone. It requires:

```json
{
  "full_auto": {
    "enabled": true,
    "mode": "supervised",
    "fail_closed": true,
    "max_interactions_per_phase": 50,
    "deadlock_threshold": 3,
    "escalation_mode": "pause",
    "permission_policy": {
      "enabled": true,
      "trusted_roots": ["."],
      "trusted_domains": [],
      "protected_paths": [".git", "package.json"],
      "allow_defaults": true
    },
    "denials": {
      "max_consecutive": 3,
      "max_total": 20,
      "on_limit": "pause"
    },
    "oversight": {
      "on_plan_change": true,
      "on_task_completion": false,
      "on_phase_boundary": true,
      "on_high_risk_action": true,
      "on_subagent_return_warning": true,
      "every_tool_calls": 25,
      "every_architect_turns": 5,
      "every_minutes": 20
    }
  }
}
```

> **Defaults note:** `enabled` defaults to `false` — the example above shows an explicit enable. `permission_policy.protected_paths` has 20 defaults including `.github/workflows`, `.swarm/`, lockfiles, `CHANGELOG.md`, and guardrail paths; the two shown above are the minimal override.

#### Modes

- `assisted` — least invasive. The deterministic policy still runs, but
  task completion does not require critic verification.
- `supervised` (default) — the deterministic policy + critic escalation for
  ambiguous/high-risk actions. Phase boundaries always require critic approval.
- `strict` — like supervised, but every task completion also requires critic
  verification.

#### Permission policy

The deterministic classifier handles obvious cases without an LLM call:

- **Allow** — read-only swarm and search tools, evidence/status reads,
  in-scope writes by coder, plan/evidence pathless tools.
- **Deny** — writes outside the project root, writes outside declared coder
  scope, direct writes to `.git`, exfiltration-like network actions,
  destructive shell, production deploys/migrations/force-push, permission
  grants, secret access, attempts to disable Full-Auto.
- **Escalate to critic** — package.json / lockfile changes, plugin/build
  config touches, guardrail/delegation/plan-ledger/evidence/tool-registry
  changes, shell commands not in the deterministic safe set, web/network
  fetches to non-trusted domains, dependency mutations, Task delegations,
  `phase_complete`, `update_task_status(completed)` (strict mode), tool
  output injection followed by a risky action, repeated denials, plan
  mutation after approval.
- **Escalate to human** — irreversible external operations, production
  infrastructure changes, or critic verdicts of `ESCALATE_TO_HUMAN`.

#### Deny-and-continue behavior

A denial is returned to the agent as a structured error so it can choose a
safer path (declare scope, switch to a read-only verification, ask for
approval). Denials accumulate against two thresholds:

- `denials.max_consecutive` (default 3) — pause when N consecutive denials
  occur without an allowed action in between.
- `denials.max_total` (default 20) — pause when the cumulative session
  denial count is reached.

`denials.on_limit` controls whether the run is paused or terminated.

#### Prompt-injection scanner

Tool output from `web_search`, `webfetch`, `fetch`, `doc_extract`, `doc_scan`,
`gitingest`, `extract_code_blocks`, `retrieve_summary`, `search`, `read`, and
`view` is inspected for instruction-override, system-role-override,
credential-request, exfiltration, guardrail-disable, and curl-pipe-shell
patterns. Detections write a `full_auto_input_warning` event and stash a
warning on the session. The next risky action (shell, network, secret-read)
escalates to the critic instead of using the deterministic policy.

#### Subagent outbound and return checks

- **Outbound** — Task delegation requires a registered subagent, declared
  scope (for coder), and triggers an advisory if the prompt mentions a
  protected path.
- **Return** — The result text is scanned for skipped tests, tool timeouts,
  scope changes, "instructions from external content", missing evidence,
  and out-of-scope file generation. Severe categories pause the run.

#### Critic escalation triggers

A critic dispatch happens for: tool actions classified as escalate, plan
mutation after approval, `phase_complete`, task completion (strict),
subagent-return warnings, periodic cadence (every N tool calls / architect
turns / minutes), and on near-limit consecutive denials.

#### Phase approval gate

When Full-Auto v2 is active, `phase_complete` requires an APPROVED
`full_auto_oversight` evidence record at
`.swarm/evidence/{phase}/full-auto-*.json`. Stale (>24h), missing, or
non-APPROVED records block. Turbo does NOT bypass this gate.

#### Fail-closed behavior

When `fail_closed: true` (default), the permission/oversight layer pauses
the run on any of: missing `opencodeClient`, critic dispatch failure,
unparseable critic response, severe subagent return warning, denial
threshold reached.

#### Recovery

Paused or terminated runs are durable in `.swarm/full-auto-state.json`. To
resume:

```bash
/swarm full-auto on    # creates a fresh running record for the session
```

Inspect the file to see `pauseReason` / `terminateReason` and the denial
history. Address the underlying cause before re-enabling.

#### Legacy v1 fields

`max_interactions_per_phase`, `deadlock_threshold`, `escalation_mode`, and
`critic_model` continue to control the reactive intercept that fires on
architect text patterns. v1 and v2 layers run together — v2 verdicts are
also mirrored from v1 dispatches when a durable run exists.

**When to use:** long-running phases you want to run unattended. Pair with
Balanced or Strict `execution_mode` for safety.

### Combining Modes

**Lean Turbo** composes with all session modes — it is a lane planning layer, not a mode toggle. It partitions tasks into parallel lanes when `turbo.lean` is configured in config, regardless of whether Turbo or Full-Auto is active.

**Turbo + Full-Auto** are independent. Both can be on simultaneously — Turbo bypasses Stage B gates for qualifying tasks, Full-Auto keeps the architect moving between tasks without prompting you.

---

## Project Modes (`execution_mode`)

Set in your project config (`.opencode/opencode-swarm.json`):

```json
{
  "execution_mode": "balanced"
}
```

Persistent. Controls hook overhead at session init.

### `strict`

Enables slop-detector and incremental-verify hooks. Maximum safety for security-sensitive projects or production deploys. Higher latency per message due to added validation passes.

### `balanced` (default)

Standard hooks. Appropriate for most projects.

### `fast`

Skips the compaction service. Use when you're hitting context pressure on short sessions and willing to trade summary fidelity for speed.

---

## Mode Summary

| Mode | Scope | Persistent | Skips | When |
|------|-------|:---:|------|------|
| Balanced (session) | Session | No | Nothing | Default |
| Turbo | Session | No | Stage B for non-Tier-3 | Rapid iteration |
| Lean Turbo | Session | Config | Parallel lanes for non-conflicting tasks | Multi-task phases |
| Full-Auto | Session | No | User confirmation between interactions | Unattended runs |
| `execution_mode: strict` | Project | Yes | Nothing; adds slop-detector + incremental-verify | Security-critical |
| `execution_mode: balanced` | Project | Yes | Nothing | Default |
| `execution_mode: fast` | Project | Yes | Compaction service | Short sessions |

---

## QA Gate Reference

### `council_mode` (Phase-Level Council)

When enabled, a phase-level council of 5 members (critic, reviewer, sme, test_engineer, explorer) reviews the entire phase's work holistically at `phase_complete` time. Stage B gates always run per-task; when standard `parallelization` is enabled, all applicable Stage B gates are dispatched together, including conditional adversarial `test_engineer`. Council is additive, never a replacement. Evidence is written to `.swarm/evidence/{phase}/phase-council.json` and validated for verdict, quorum, timestamp, and phase number.

### `final_council` (Project-Level Final Council)

When enabled, the final phase cannot complete until the architect dispatches the same 5 council members used by phase council (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) with completed-project context and calls `write_final_council_evidence` with their collected `CouncilMemberVerdict` objects. Evidence is written to `.swarm/evidence/final-council.json` and validated for approved verdict, plan binding, and quorum metadata. This is not General Council mode and does not use `convene_general_council`.
---

## Lean Turbo Lane Planning Engine

Lean Turbo (`src/turbo/lean/`) partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks.

### What Lean Turbo Is

Lean Turbo is a **lane planning execution strategy** — not a mode toggle — that partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks. It composes with all session modes (Turbo, Full-Auto, Balanced).

Key characteristics:
- **Lane planning layer** — Lean Turbo runs on top of existing session modes; it does not replace them
- **Parallel coder execution** — multiple coders dispatched simultaneously, each working in their own declared-scope lane
- **File-conflict partitioning** — tasks assigned to lanes based on declared scopes and file conflict analysis
- **Config-driven** — enabled via `turbo.strategy: "lean"` in config; `/swarm turbo lean on` activates it for the session
- **Stage B model** — lane tasks skip per-task Stage B (reviewer + test_engineer); quality is enforced at phase-end via phase reviewer and critic gates. Degraded and serialized tasks retain full Stage B.

### Comparison with Standard Turbo

| Aspect | Standard Turbo | Lean Turbo |
|--------|---------------|------------|
| Stage B | Skipped for non-Tier-3 files | Skipped for lane tasks; phase-end reviewer/critic as quality gate. Degraded/serialized tasks retain full Stage B |
| Coder execution | Single coder | Multiple coders in parallel lanes |
| Activation | `/swarm turbo on` (session toggle) | `turbo.strategy: "lean"` in config + `/swarm turbo lean on` |
| Scope handling | No scope analysis | Partitioned by file-conflict analysis |
| Degradation | N/A (single flow) | Degraded tasks fall back to standard serial flow |
| Full-Auto composition | Independent | Subject to Full-Auto permission policy; Full-Auto paused/terminated blocks lean runner |
| Tier 3 patterns | Respected | Respected |

### Composition with Full-Auto v2

Lean Turbo composes with Full-Auto v2 when both are active:

- **Lane dispatch** is subject to Full-Auto permission policy — coders must pass the deterministic classifier or get critic escalation before receiving work
- **Full-Auto paused/terminated** blocks the Lean Turbo runner — it will not dispatch new lanes until Full-Auto is resumed
- **Full-Auto phase approval** is required before `phase_complete` even when Lean Turbo evidence exists — the `full_auto_oversight` gate at `.swarm/evidence/{phase}/full-auto-*.json` must be APPROVED
- Both can be active simultaneously — Lean Turbo handles task parallelization while Full-Auto handles permission/escalation decisions

### Architecture

```
planLeanTurboLanes(directory, phaseNumber, plan, config, scopes?)
    ├── 1. Task extraction        → filter completed tasks
    ├── 2. Scope resolution      → declared scopes → scope files → files_touched fallback
    ├── 3. Risk classification    → global / protected / no-scope / invalid-scope / normal
    ├── 4. Topological sort      → Kahn's algorithm with fail-closed cycle handling
    └── 5. Lane assignment        → greedy conflict-free parallelization (max_parallel_coders lanes)
```

### Conflict Detection Rules

Two tasks conflict if they touch:

- **Same file** — identical paths
- **Parent/child directories** — e.g., `src/auth/` vs `src/auth/login.ts`
- **Global files** — `package.json`, lockfiles, barrel files (`src/index.ts`), build config — always degraded
- **Protected paths** — paths containing `auth`, `crypto`, `secret`, `security`, `.env`, etc. — degraded or serialized based on `degrade_on_risk`

### Risk Classification (`src/turbo/lean/risk.ts`)

| Category | Trigger | Policy |
|---|---|---|
| `global` | Touches a global file | Always degraded → `balanced` mode |
| `protected` | Touches a protected path | `degrade_on_risk` → degraded; else serialized |
| `invalid-scope` | Scope contains `..` traversal | Serialized |
| `no-scope` | `require_declared_scope: true` + no declared scope | Serialized |
| `normal` | Regular scoped files | Parallelized across lanes |

### Lane Assignment Algorithm

1. **Wave-based dependency ordering** — tasks are grouped into dependency waves; a task's dependencies must complete before it enters the queue
2. **Cross-lane dependency tracking** — if a task depends on another in a different lane, it is serialized until that dependency completes
3. **File claim tracking** — each lane tracks claimed files; a task with any claim conflict is degraded or serialized
4. **Cycle detection** — Kahn's algorithm detects dependency cycles; all tasks in a cycle are fail-closed to serialized

### Path Normalization

All paths are normalized to POSIX-style (forward slashes, no trailing slash, `.` segments collapsed) before conflict detection. Windows paths are lowercased for consistent cross-platform comparison.

### Key Types

```typescript
// src/turbo/lean/planner.ts
interface LeanTurboLanePlan {
  phase: number;
  planId: string;
  lanes: LeanTurboLane[];         // Parallel coder lanes
  degradedTasks: LeanTurboDegradedTask[]; // Tasks degraded to balanced
  serializedTasks: string[];       // Tasks forced sequential
  degradationSummary?: string;      // Human-readable when all degraded
  counters: LeanTurboCounters;
  crossLaneDependencies: Record<string, string[]>; // dep taskId → [other lane taskIds]
}

// src/turbo/lean/conflicts.ts
// DEFAULT_GLOBAL_FILES — 27 global files (package.json, lockfiles, barrels, build config)
// DEFAULT_PROTECTED_PATTERNS — 19 protected path patterns (auth, crypto, secret, .env, etc.)
// normalizePath(filePath) → POSIX path
// pathsConflict(path1, path2) → boolean (same file or parent/child)
// isGlobalFile(normalizedPath) → boolean
// isProtectedPath(normalizedPath) → boolean
// readTaskScopes(directory, taskId) → string[] | null (reads .swarm/scopes/scope-{taskId}.json)
```

### Commands

Lean Turbo is controlled via `/swarm turbo lean`:

```
/swarm turbo lean on      # enable Lean Turbo explicitly
/swarm turbo lean off     # disable Lean Turbo
/swarm turbo lean         # toggle Lean Turbo on/off
/swarm turbo status       # show detailed status including active lanes and degraded tasks
/swarm turbo on           # follows turbo.strategy config (lean when config says lean, otherwise standard)
/swarm turbo standard on  # force standard turbo (disables lean even if config says lean)
```

`/swarm turbo status` displays:
- Whether Lean Turbo is active and configured
- Number of active lanes and tasks per lane
- Degraded tasks with reasons (global file, protected path, no scope, invalid scope)
- `degradation_summary` when all tasks degraded

### Evidence and Phase Reviewer/Critic Requirements

Lane evidence is written to `.swarm/evidence/{phase}/lean-turbo/` per lane:
- Each lane writes its own evidence file (`lane-{n}.json`)
- Contains task IDs, assigned files, lane status, and completion state

Phase-level evidence is written to `.swarm/evidence/{phase}/lean-turbo-phase.json`:
- Aggregates all lane outcomes
- Contains lane completion status and cross-lane dependency resolution
- Used by phase gates to verify lane completion

**Phase reviewer and phase critic** — when configured via `turbo.lean.phase_reviewer` and `turbo.lean.phase_critic`:

- **Phase reviewer** — dispatched with combined phase diff; read-only verification that all lane tasks are complete and consistent
- **Phase critic** — dispatched with boundary review; read-only verification of lane phase boundaries and cross-lane dependencies
- Both are **required** at `phase_complete` when configured — absence blocks the phase gate
- These serve as the holistic quality gate for lane tasks (which skip per-task Stage B). Degraded and serialized tasks still get individual Stage B.

### Recovery from Paused/Blocked

Paused or terminated Lean Turbo runs are durable in `.swarm/turbo-state.json`. To resume:

```bash
/swarm turbo lean on    # creates a fresh running record for the session
```

Inspect the file to see:
- `pauseReason` / `status` — why the run is paused or terminated
- `degradedTasks` — tasks that fell back to serial flow
- Denial history if Full-Auto integration is active

**Degraded tasks** — when Lean Turbo cannot place a task in a parallel lane, it falls back to standard serial flow:
- Degradation reasons: global file conflict, protected path, unknown scope, invalid scope
- Degraded tasks do **NOT** get Lean Turbo lane bypass — they run full Stage B gates (reviewer + test_engineer)
- `degradation_summary` shown in status when all tasks degraded

**Full-Auto blocking** — Full-Auto state can block the Lean Turbo runner:
- Full-Auto paused or terminated prevents new lane dispatches
- Check `/swarm full-auto status` to diagnose
- Resume Full-Auto first with `/swarm full-auto on`, then re-enable Lean Turbo if needed

### Configuration

Lean Turbo is configured via `turbo` and `turbo.lean` in `.opencode/opencode-swarm.json`:

```json
{
  "turbo": {
    "strategy": "lean",
    "lean": {
      "max_parallel_coders": 4,
      "require_declared_scope": true,
      "conflict_policy": "serialize",
      "degrade_on_risk": true,
      "phase_reviewer": true,
      "phase_critic": true,
      "integrated_diff_required": true,
      "allow_docs_only_without_reviewer": false,
      "worktree_isolation": false
    }
  }
}
```

| Key | Default | Effect |
|---|---|---|
| `strategy` | `"standard"` | `"lean"` enables Lean Turbo lane planning; `"standard"` uses single-coder Turbo |
| `max_parallel_coders` | `4` | Maximum concurrent coder lanes (1–6) |
| `require_declared_scope` | `true` | Fail-closed on tasks without declared scope |
| `conflict_policy` | `"serialize"` | `"serialize"` → sequential for conflicting tasks; `"degrade"` → switch to balanced |
| `degrade_on_risk` | `true` | Protected-path tasks degraded to balanced (`true`) or serialized (`false`) |
| `phase_reviewer` | `true` | Dispatch phase reviewer at `phase_complete` (read-only diff verification) |
| `phase_critic` | `true` | Dispatch phase critic at `phase_complete` (read-only boundary review) |
| `integrated_diff_required` | `true` | Require integrated diff for lane evidence |
| `allow_docs_only_without_reviewer` | `false` | Allow docs-only phases when reviewer is not available |
| `worktree_isolation` | `false` | Use worktree isolation for parallel coders |

### Tests

111 tests covering: lane partitioning, conflict detection, parent/child path resolution, global file classification, protected path matching, cycle detection, cross-lane dependencies, scope resolution priority, Windows path normalization, and degradation summaries.

---

## FAQ

**Why is the README's "Strict" mode not a session command?**  
The README table names three safety tiers for readability. In the code, the `execution_mode` config key is the persistent setting (`strict` / `balanced` / `fast`), and `/swarm turbo` is the session-scoped override. There is no `/swarm strict` command.

**Can Turbo break a security review?**  
No. Tier 3 patterns (`auth*`, `crypto*`, `security*.ts`, etc.) always run full review regardless of Turbo. See `src/tools/update-task-status.ts:98-109` for the authoritative list.

**Does Full-Auto bypass the critic?**  
No. Full-Auto v2 *increases* critic involvement: every escalate-class action gets a dedicated read-only critic verification before it executes, and phase boundaries require an APPROVED `full_auto_oversight` evidence record before `phase_complete` will succeed. Reactive intercept verdicts are also mirrored into the v2 evidence pipeline when a durable run is active. See `src/full-auto/oversight.ts` and `src/full-auto/phase-approval.ts` for the dispatch and gate.

**How does Lean Turbo avoid file conflicts?**  
The lane planner (`src/turbo/lean/planner.ts`) uses five conflict rules: exact-file match, parent/child directory containment, global file classification (package.json, barrels, lockfiles), protected path detection (auth, crypto, .env), and cross-lane dependency tracking. Tasks that can't be placed in a parallel lane are either serialized or degraded to balanced mode based on config. See the [Lean Turbo section](#lean-turbo-lane-planning-engine) for the full algorithm.

**How do I tell what mode is active?**  
`/swarm status` shows session modes. `/swarm config` shows the resolved `execution_mode`.

---

## Related

- [Commands Reference](commands.md) — `/swarm turbo`, `/swarm full-auto`, `/swarm status`
- [Configuration](configuration.md) — `execution_mode`, `full_auto.*`, `turbo.lean.*`
- [Architecture Deep Dive](architecture.md) — QA gates, Stage B, Tier 3
