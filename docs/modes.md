# Execution Modes

Swarm has two orthogonal mode systems:

- **Session modes** (Turbo, Full-Auto, Epic) — toggled per-session via `/swarm turbo` and `/swarm full-auto`; Epic is opened for the current plan with `/swarm epic start` and stays open until `/swarm epic close` (it needs `epic.mode.enabled: true` in config).
- **Project modes** (`execution_mode`) — set in config; controls hook overhead project-wide.

They compose independently. You can run `execution_mode: "strict"` with Turbo on, or `execution_mode: "balanced"` with Full-Auto on. Epic composes with every `execution_mode` and with Full-Auto, but keeps Turbo off (see [Combining Modes](#combining-modes)).

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

**First-class toggle.** Full-Auto is enabled and disabled at will from the session — no config-level enablement is required:

```text
/swarm full-auto on              # activate (supervised mode by default)
/swarm full-auto on strict       # activate with a mode override for this run
/swarm full-auto off             # disarm and return to interactive operation
/swarm full-auto status          # report the durable run state
/swarm full-auto retry-oversight # bounded infrastructure health probe while paused
/swarm full-auto resume          # resume after the exact pause condition is repaired
/swarm full-auto abort           # terminate the paused run
/swarm full-auto exit            # alias for off/disarm
/swarm full-auto                 # bare toggle
```

While active, the critic reviews escalations, phase boundaries, delegations, and architect questions on your behalf; only an `ESCALATE_TO_HUMAN` verdict (or a pause/terminate condition) hands control back to you. `off` **disarms** the run (durable status `idle`) and returns the session to normal interactive operation; paused/terminated states are reserved for system-initiated halts (denial limits, critic verdicts) and fail-closed-block non-read-only tools until you re-enable. An optional mode after `on` (or a bare mode token) overrides `full_auto.mode` for the run and is what the permission classifier enforces.

Administrators can refuse runtime activation entirely with `full_auto.locked: true`. `locked` ORs across config levels — a repo's project config cannot override a user-level lock — and activation also fails closed when a config file exists but cannot be parsed (an unreadable lock is treated as "unknown", not "unlocked"). `resume` is activation for lock purposes: re-arming a paused run via `/swarm full-auto resume` is refused identically to `on` under a lock or an unreadable config. `off` and `status` always work. Note the difference from the old gate: `enabled: false` used to make the hooks permanent no-ops, while `locked` keeps them armed — a corrupt `.swarm/full-auto-state.json` still fail-closed-blocks non-read-only tools project-wide until restored or deleted (`/swarm full-auto status` reports this as `UNREADABLE`).

The legacy `full_auto.enabled` flag is deprecated as a gate — it no longer arms or disarms anything. The v2 hooks (permission, delegation, input probe, cadence, phase approval) are gated by the durable per-session run state; the legacy reactive intercept is gated by the in-memory session flag (with a deliberate any-session fallback for messages without a session ID).

All tuning still lives in config (every field optional):

```json
{
  "full_auto": {
    "locked": false,
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

> **Defaults note:** `locked` defaults to `false` (runtime toggle available). `permission_policy.protected_paths` has 20 defaults including `.github/workflows`, `.swarm/`, lockfiles, `CHANGELOG.md`, and guardrail paths; the two shown above are the minimal override.

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

### Epic (preview)

Opt-in (`epic.mode.enabled: true`). Binds to the current plan: `/swarm epic start` opens an epic for it (refusing plans too small to benefit), `epic_next_wave` issues each phase as waves of tasks whose declared scopes don't conflict, and every task still runs the full per-task QA pipeline (Stage A and Stage B). In a git project each coder works in an isolated worktree on the epic branch, and `/swarm epic close` squash-lands the work as staged changes. A phase reviewer + critic (`epic_phase_review`) is required before `phase_complete`. See [Epic Mode (preview)](#epic-mode-preview) for the full flow.

### Combining Modes

**Lean Turbo** composes with all session modes except an open epic — it is a lane planning layer, not a mode toggle. It partitions tasks into parallel lanes when `turbo.lean` is configured in config, regardless of whether Turbo or Full-Auto is active.

**Turbo + Full-Auto** are independent. Both can be on simultaneously — Turbo bypasses Stage B gates for qualifying tasks, Full-Auto keeps the architect moving between tasks without prompting you.

**Epic + Turbo / Lean Turbo** do not combine. `/swarm epic start` refuses while Turbo is on (config `turbo_mode`, or any session in this process) or a Lean run is running, and while an epic is open `/swarm turbo` refuses every enabling form (`on`, `lean on`, `standard on`). Epic plans its own waves and never dispatches through the Lean runner. See [Mode comparison](#mode-comparison).

**Epic + Full-Auto** compose. Full-Auto's permission policy and critic escalation still apply to every Epic dispatch (the Epic tools are part of the architect's capability set when Epic is enabled), and `phase_complete` requires both the Full-Auto phase approval and Epic's `epic_phase_readiness` gate.

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
| [Epic Mode](#epic-mode-preview) | Plan (one open epic per project) | Yes, until `/swarm epic close` | Nothing — per-task QA always runs; ready tasks with disjoint scopes run as parallel waves | Large plans with many independent tasks |
| `execution_mode: strict` | Project | Yes | Nothing; adds slop-detector + incremental-verify | Security-critical |
| `execution_mode: balanced` | Project | Yes | Nothing | Default |
| `execution_mode: fast` | Project | Yes | Compaction service | Short sessions |

## v8 Parallel-First Execution (#1674)

v8 flips opencode-swarm's published core execution contract from serial-by-default
to **safe-concurrent-by-default for provably disjoint work**, with serial as the
automatic, gate-enforced fallback.

### How it works
- **New plans default to `parallelization_enabled: true`** (applied at
  `save_plan` time; existing plans are unchanged on upgrade — see the v8 release
  fragment for the migration guard).
- **The execution gate enforces disjointness inline.** On every coder dispatch,
  the delegation gate computes a pairwise file-conflict verdict over the active
  phase's pending tasks (via the same pure helper the `plan_conflict_check` tool
  exposes). Overlapping or unknown declared scopes → `parallelModeActive === false`
  → serial, automatically. No architect discretion required.
- **Worktree isolation is the safety net.** When the gate permits parallel
  dispatch, each coder runs in its own isolated git worktree; merge-back aborts
  preserve the worktree on conflict (`#1657` durable recovery records + orphan-
  cleanup exemption).

### `plan_conflict_check` (advisory tool, #1656)
The architect can call `plan_conflict_check` *before* attempting parallel
dispatch to inspect the conflict matrix and a suggested serialization order. It
is genuinely read-only (writes nothing); the gate independently recomputes the
same verdict at dispatch time. Use it to choose disjoint task groups and
understand why the gate will (or won't) permit parallelism.

### Recovery UX (#1657)
When a lane's merge-back fails, a durable recovery record is written under
`.swarm/recovery/`. `/swarm status` surfaces a "Preserved recovery worktrees"
section, and `cleanupOrphanedBranches` exempts recovery branches (fail-safe on
read error). Records auto-clear when the lane later merges back successfully.

### Under Epic Mode
While an epic is open, the active Epic wave (issued by `epic_next_wave`) replaces this pairwise verdict as the delegation gate's authority, and worktree isolation is required rather than a safety net. See [Dispatch gate: the active wave is the authority](#dispatch-gate-the-active-wave-is-the-authority).

### Opting out
- Per-plan: `execution_profile.parallelization_enabled: false` at `save_plan`.
- Globally: `worktree.policy: disabled` (disables worktree isolation entirely).

---

## QA Gate Reference

### `council_mode` (Per-Task Council)

When enabled, replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Stage A still runs. Requires `council.enabled: true` in config. Evidence is written to `.swarm/evidence/{taskId}.json` under `gates.council` and validated for verdict, quorum, and timestamp.

### `phase_council` (Phase-Level Council)

When enabled, a full 5-member council reviews all work in a phase holistically at `phase_complete` time. Additive to per-task gates. Evidence is written to `.swarm/evidence/{phase}/phase-council.json` and validated for verdict, quorum, timestamp, and phase number.

### `final_council` (Project-Level Final Council)

When enabled, the final phase cannot complete until the architect dispatches the full 5-member council (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) — NOT the General Council — with completed-project context and calls `write_final_council_evidence` with their collected `CouncilMemberVerdict` objects. Evidence is written to `.swarm/evidence/final-council.json` and validated for approved verdict, plan binding, and quorum metadata. This is the full 5-member council (not General Council mode) and does not use `convene_general_council`.
---

## Lean Turbo Lane Planning Engine

Lean Turbo (`src/turbo/lean/`) partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks.

### What Lean Turbo Is

Lean Turbo is a **lane planning execution strategy** — not a mode toggle — that partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks. It composes with all session modes (Turbo, Full-Auto, Balanced); it cannot run while an epic is open (see [Epic Mode](#epic-mode-preview)).

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

// src/turbo/lean/worktree.ts
// provisionWorktree(laneId, branchName, baseBranch, config) → Promise<WorktreeResult>
// removeWorktree(laneId) → Promise<void>
// assertCleanWorkingTree() → void (throws if dirty)
// isCleanWorktree() → Promise<boolean>
// autoCommitDirty(message) → Promise<string> (returns commit hash)
// cleanUntrackedFiles() → Promise<void>

// src/turbo/lean/merge-back.ts
// getMergeStrategy(config) → 'merge' | 'rebase' | 'cherry-pick'
// mergeLaneBranch(laneId, strategy) → Promise<MergeSuccess | MergeFailure | MergeConflict>
// postMergeCleanup(laneId) → Promise<CleanupSuccess | CleanupFailure>
// handleMergeConflict(conflictInfo) → Promise<ConflictHandlingError | null>
// attemptMergeBackFromDirty(laneId, strategy) → Promise<DirtyMergeSuccess | DirtyMergeFailure | DirtyMergePartial>
// cleanupOrphanedBranches() → Promise<OrphanCleanupResult>
// startupOrphanRecovery() → Promise<StartupRecoveryResult>
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
      "worktree_isolation": true
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
| `worktree_isolation` | `true` | Use worktree isolation for parallel coders |

> ⚠️ **Behavior change (FR-107 / SC-121):** `worktree_isolation` now defaults to `true`. Lean Turbo phases provision per-lane worktrees by default. To retain the previous behavior, set `turbo.lean.worktree_isolation: false` explicitly.

> ⚠️ **Behavior change (#2954):** `integrated_diff_required` now defaults to `true` on every path, including projects with no `turbo` config block — a lean phase advance requires the integrated-diff evidence artifact. To retain the previous permissive behavior, set `turbo.lean.integrated_diff_required: false` explicitly in `.opencode/opencode-swarm.json`.

### Tests

111 tests covering: lane partitioning, conflict detection, parent/child path resolution, global file classification, protected path matching, cycle detection, cross-lane dependencies, scope resolution priority, Windows path normalization, and degradation summaries.

---

## Runtime Isolation (FR-201 – FR-206)

Per-lane environment isolation that prevents port collisions, cache contamination, and temp-directory conflicts when Lean Turbo lanes run concurrently.

### What is the Lane Runtime Profile

Each lane can receive a **lane runtime profile** — a set of derived environment variables written to `.swarm/lanes/{laneIndex}.env` (KEY=VAL format) inside the worktree root. Any child process spawned inside the lane can source this file to get lane-specific overrides.

The profile is produced by `computeLaneRuntimeProfile()` (`src/turbo/lean/worktree.ts` and `src/hooks/delegation-gate/worktree-isolation.ts`) from the resolved `runtime_isolation` config.

**Precedence (last write wins):**

1. **Derived PORT** — `PORT = port_base + laneIndex * port_stride` when `port_base` is explicitly set (no default)
2. **env_overrides** — explicit caller values win over derived PORT
3. **cache_redirects** — explicit cache redirect wins (last write wins)

`cache_redirects` keys must be valid env var names; values have `/lane-{laneIndex}` appended as a suffix to the configured base path using **platform-native path separators** (Windows: `\`, POSIX: `/`). The `.swarm/lanes/{n}.env` file itself always uses `KEY=VAL\n` format consumed by cross-platform tools. (e.g. `XDG_CACHE_HOME=/home/user/.cache → /home/user/.cache/lane-1` on POSIX; `TEMP=C:\Users\test\Temp\cache → C:\Users\test\Temp\cache\lane-1` on Windows)

### Default Behavior (Disabled by Default)

`runtime_isolation.enabled` defaults to `false` in both `turbo.lean` and `worktree` config blocks. When disabled, no profile is written and no environment changes are injected — **zero behavior change** for existing setups.

SC-129 / SC-130 encode this off-by-default guarantee: the integration test `cross-process-port-binding.test.ts` verifies that a disabled `runtime_isolation` produces no `PORT` injection.

### When to Enable

Enable `runtime_isolation` when:

- **Parallel lanes run port-binding servers** — each lane gets an isolated `PORT` to prevent collision (SC-122).
- **Integration test suites** need lane-scoped `TEST_DATABASE_URL`, `TMPDIR`, or `XDG_CACHE_HOME`.
- **Dev servers** run per-lane and need isolated temp directories that are auto-cleaned on teardown.
- **Cache isolation** is required — redirect `~/.cache` or similar to per-lane directories.

### Cross-Platform Parity

| Platform | Sandbox mechanism | Soft-fail behavior |
|----------|-----------------|-------------------|
| Linux | `bwrap` (bubblewrap) | If `bwrap` is unavailable, falls back to env var + port injection only |
| macOS | `sandbox-exec` | If `sandbox-exec` is unavailable, falls back to env var + port injection only |
| Windows | Windows native-runner ({mode}: restricted-token / app-container) with `powershell wrapper` fallback | If sandbox preparation fails, falls back to env var + port injection only |

All three platforms **soft-fail** — if the OS-level sandbox envelope cannot be prepared, the lane still starts with env/port isolation only. A lane is never hard-failed due to sandbox unavailability (SC-132).

The executor mechanism is detected at runtime and reported by `/swarm diagnose` under the Sandbox health-check line.

### Common Scenarios

#### Two lanes running port-binding test servers

Lane 0 gets `PORT=41000`, lane 1 gets `PORT=41010` (with `port_base=41000, port_stride=10`). Both test servers start without a collision. `port_base` must be explicitly set — there is no default; if omitted, no `PORT` is injected.

```
// turbo.lean or worktree.runtime_isolation config:
{
  "runtime_isolation": {
    "enabled": true,
    "port_base": 41000,
    "port_stride": 10
  }
}
```

#### Lane-scoped environment variables

Override `TEST_DATABASE_URL`, `TMPDIR`, or `XDG_CACHE_HOME` per lane:

```json
{
  "runtime_isolation": {
    "enabled": true,
    "env_overrides": {
      "TEST_DATABASE_URL": "postgresql://localhost:5432/test_lane_A",
      "TMPDIR": "/lane-tmp/lane-A",
      "XDG_CACHE_HOME": "/lane-cache/lane-A"
    }
  }
}
```

> **Note:** Values are copied verbatim — no `${LANE_INDEX}` template substitution is performed. To get unique values per lane, inject them via the dispatch layer before the lane is provisioned.

#### Lane-scoped cache and temp directories

Redirect cache paths to per-lane directories. The env file (`.swarm/lanes/{laneIndex}.env`) is removed at teardown, but the cache/temp directories referenced by `cache_redirects` are **not automatically deleted** unless they are inside the worktree that gets removed. External paths (e.g. `/lane-cache`) persist after teardown and must be cleaned up by the caller.

```json
{
  "runtime_isolation": {
    "enabled": true,
    "cache_redirects": {
      "XDG_CACHE_HOME": "/lane-cache",
      "TMPDIR": "/lane-tmp"
    }
  }
}
```

### Configuration

```json
{
  "turbo": {
    "strategy": "lean",
    "lean": {
      "runtime_isolation": {
        "enabled": true,
        "port_base": 41000,
        "port_stride": 10,
        "env_overrides": {},
        "cache_redirects": {}
      }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch — off by default for zero behavior change |
| `port_base` | _(none — no PORT injection)_ | Base port for lane 0; each subsequent lane gets `port_base + laneIndex * port_stride`. Must be explicitly set to enable PORT injection. |
| `port_stride` | `1` | Port increment between lanes |
| `env_overrides` | `{}` | Environment variable overrides applied to every lane |
| `cache_redirects` | `{}` | Cache path redirects for lane isolation |

The same fields are also available under `worktree.runtime_isolation` with identical semantics.

### See also

- [Configuration — `runtime_isolation`](configuration.md#turbolean-runtime_isolation--per-lane-runtime-isolation-settings)
- [`/swarm lanes` — Runtime profile state](commands.md#swarm-lanes---runtime-profile-state)

---

## Epic Mode (preview)

> **Status: opt-in, off by default.** Epic Mode needs **both** a config opt-in (`epic.mode.enabled: true` in the top-level `epic` block — no `turbo` block needed; see Configuration below) **and** an epic opened for the current plan with `/swarm epic start`. Without the config opt-in, `/swarm epic start` and `epic_next_wave` refuse with reason `epic-disabled-by-config`; without an open epic `epic_next_wave` refuses with `no-open-epic` (or `epic-orphaned` / `epic-state-unreadable`), and no Epic behaviour runs anywhere else (the wave-only dispatch gate, commit-at-landing, required worktree isolation, residue commits, the Epic phase-readiness gate, the Epic banner). Epic is wired through the `/swarm epic` and `/swarm coupling` commands, the architect-only `epic_next_wave` and `epic_phase_review` tools (granted only when the config gate is on), and the `EPIC_MODE_BANNER`.
>
> **Worktree-isolation interaction:** in a git project every coder of an epic task runs in an isolated git worktree (see [Commits: landing, residue, refs](#commits-landing-residue-refs)); a coder whose merge-back fails leaves its work stranded outside the epic branch. `epic_next_wave` will not close the task's wave (`blocked: merge-failed`) while a merge failure recorded since the wave was issued remains, and completing such a task skips the #2582 auto-checkpoint (with a critical warning) because HEAD does not contain its work; the plan status still advances (the ledger is authoritative) and the failure is surfaced for recovery. The merge-status registry (`.swarm/worktree-merge-status.json`) is keyed by bare task id and shared with `/swarm lanes`, so Epic filters it by epoch: for the wave advance rule the epoch is the wave's issue time, for the checkpoint skip the epic's start. A failure with no timestamp cannot be dated and stays relevant (fail closed). `/swarm epic status` lists recorded failures as blocking, undated, or stale, with the remedy. Not every writer stamps a time (a cancelled/denied task's `task-result` record has none); once the task's work is actually in the main tree, or the record belongs to an earlier plan, clear it with `/swarm epic clear-merge-failure <taskId> --confirm` (without `--confirm` it only previews).

> **Host requirement: OpenCode 1.x (1.18.29+) for now.** Epic dispatches its worktree-isolated coders and its `epic_phase_review` reviewer and critic through the OpenCode SDK client. The OpenCode 2 adapter does not give the plugin that client yet ([v2 hook inventory](host/v2-hook-inventory.md), rows 2 and 17), so on an OpenCode 2 host every Epic coder would be refused (`EPIC_ISOLATION_DEGRADED`) and no phase could pass its review. `/swarm epic start` therefore refuses there up front with `host-unsupported`. The check is capability-based (no client ⇒ refuse), so Epic starts working on OpenCode 2 as soon as the plugin's v2 adapter provides a session-capable client, with no Epic change.

> **Maintainers (human or bot):** the module map, invariants, shared-file seams, persistence map, test map and how-to recipes are in the [Epic maintainer guide](../src/epic/README.md).

### What Epic Mode Is

An **epic** is one plan bound to one spec: the codebase's one-plan-per-feature convention (a `Plan` is bound to a single `.swarm/spec.md` via `specMtime`/`specHash`) means "per epic" and "per plan" are the same thing. Whether a plan is worth running as an epic is decided once, at `/swarm epic start` ([Sizing](#sizing)); from then on Epic runs the plan as concurrent **waves** of visible coder `Task` calls, one wave at a time, phase by phase.

Epic Mode reuses Lean Turbo's conflict predicates, risk lists, and partition preflight by import, and never modifies `src/turbo/lean/`. It does **not** dispatch through Lean Turbo's runner: the architect dispatches each wave itself via opencode's `Task` tool, so each concurrent coder is a visible subagent you can click into.

**An epic at a glance** (each step is detailed below):

1. **Shape** the plan — with Epic enabled, `save_plan` returns `epic_shaping`: whether the plan is worth running as an epic and concrete patches that make it run better ([Plan shaping](#plan-shaping)).
2. **Start** — `/swarm epic start` sizes the plan, opens the epic for it and (git) checks out its epic branch ([Lifecycle](#lifecycle-start-status-close), [Sizing](#sizing)).
3. **Waves** — the architect calls `epic_next_wave` and does exactly what it says: declare scopes, dispatch the wave's coders in one message, run per-task QA, call again ([The `epic_next_wave` flow](#the-epic_next_wave-flow)). The delegation gate admits only the active wave's coders ([Dispatch gate](#dispatch-gate-the-active-wave-is-the-authority)).
4. **Commits** — every coder lands as a commit on the epic branch, other agents' main-tree writes as residue commits, and each closed wave records task refs ([Commits](#commits-landing-residue-refs)).
5. **Phases** — when a phase's waves are done, `epic_phase_review` and `phase_complete` close it ([Phase readiness](#phase-readiness-phase-reviewer--phase-critic)); fixes are new tasks ([Fixing review findings](#fixing-review-findings-fix-tasks)).
6. **Learn** — every wave close teaches the planner (undeclared co-writes, risky files); the epic's learning outlives it in the project prior ([Learning](#learning-across-waves-and-epics)).
7. **Report and close** — `/swarm epic report` shows the epic's scorecard at any time; `/swarm epic close` writes the close report (with the scorecard) and lands the epic branch, by default as a staged squash for you to commit ([Scorecard and report](#scorecard-and-report), [Epic branch and landing](#epic-branch-and-landing)).

### Mode comparison

| | Standard Turbo | Lean Turbo | Epic Mode |
|---|---|---|---|
| Enable | `/swarm turbo on` | `/swarm turbo lean on` | `"epic": { "mode": { "enabled": true } }` + `/swarm epic start` (opens an epic for the current plan; enables neither Turbo nor Lean) |
| Parallelism | None | Lanes (serial chains) dispatched by `lean_turbo_run_phase` | Waves issued by `epic_next_wave`, dispatched by the architect as one `Task` per task, all in one message |
| Decides whether to parallelize | No | No (always lane-plans) | Once, at start (sizing); then every wave holds the ready tasks with disjoint scopes |
| Phase-level gate | See [Turbo](#turbo) | See [Lean Turbo](#lean-turbo-lane-planning-engine) | Gates 1–5 as usual, plus `epic_phase_readiness` (Epic keeps Turbo off — see below) |

Under Epic Mode, per-task Stage A (`pre_check_batch`) and Stage B (reviewer + test_engineer, per the task's tier) are **always** required before `update_task_status(completed)` — for parallel and exclusive waves alike. Epic keeps Turbo off where it can: `/swarm epic start` refuses while config `turbo_mode` is true, while any session in this process has Turbo on, or while a durable Lean run is running; while an epic is open, config `turbo_mode` no longer seeds Turbo into new sessions, a session restored from its snapshot comes back with Turbo off, and `/swarm turbo` refuses to turn Turbo on. Turbo switched on in a *different* OpenCode process is not detectable — do not run Turbo elsewhere on a project with an open epic.

### The `epic_next_wave` flow

The architect follows this flow only when the user asks it to run the plan. The banner (`EPIC_MODE_BANNER`, injected every architect turn while an epic is open) only says *call `epic_next_wave` and do exactly what its `status` says*; every step's procedure travels in the tool's response.

`epic_next_wave` takes no arguments and is **idempotent**: calling it again while a wave runs returns the same wave as `in-progress`. Each call returns one status:

| `status` | Meaning → what the architect does |
|---|---|
| `dispatch` | A new wave was issued: `wave` (`seq`, `phase`, `kind`, `taskIds`, per-task frozen `files`, descriptions) plus `instructions` — one `Task(subagent_type="coder")` per task id, **all in one assistant message**; per task Stage A → Stage B → `update_task_status(completed)`; then call `epic_next_wave` again. Untracked files that belong to no task are reported in `instructions` (they stay uncommitted). |
| `declare-scopes` | Some tasks the next wave would contain have no live `declare_scope` binding: declare each (`tasks[].suggestedFiles` is the plan's `files_touched`), then call again. |
| `in-progress` | The active wave still has unresolved tasks (`waitingOn`). Finish them. |
| `blocked` | `reason` + `message` with the remedy: `task-blocked`, `merge-failed`, `landing-index-dirty` (a coder's landing was not attempted because the primary checkout has staged changes — unstage the named files and re-dispatch the task), `dirty-baseline` (uncommitted changes to **tracked** files outside `.swarm/` before a new wave — manual edits or undeclared writes; coders need a clean baseline), `predecessor-missing` (a dependency that was closed, removed, belongs to a later phase, forms a cycle, or is completed but its commit is not on the epic branch — no task ref, or the ref is no longer reachable from HEAD), `git-failed`, `plan-revised` (an unresolved wave task moved to another phase — the wave is aborted and re-planned; or a task was added to an already-complete phase), `task-reopened` (a task the epic completed in an already-complete phase was reopened), `epic-branch-mismatch`. |
| `phase-ready-for-review` | Every task of the current phase is resolved and its waves are closed: `epic_phase_review(phase)` → retrospective → `phase_complete` → `epic_next_wave`. If the review is not APPROVED, see [Fixing review findings](#fixing-review-findings-fix-tasks). |
| `epic-complete` | Every phase is complete — tell the user to run `/swarm epic close`. |
| `refused` | `no-open-epic`, `epic-orphaned`, `epic-state-unreadable`, `epic-disabled-by-config`. |

**Advance rule.** The active wave closes when every task in it is resolved — plan status `completed` (already gated by `update_task_status`, which requires per-task QA), `closed`, or removed from the plan — and no **completed** task has a worktree merge-back failure recorded since the wave was issued (a closed or removed task's work is not expected to land, so its stranded worktree does not hold the wave). The shared merge-status registry is process-global, so Epic trusts its in-memory records only while it is bound to this project's `.swarm/worktree-merge-status.json`; otherwise only this project's file counts. A blocked task blocks the close (`task-blocked`: fix it or close it). Closing a wave records it in the epic and the same call continues to the next wave, so a result can carry `closedWave` (its resolutions, close HEAD and divergence).

**Phases are iterations.** The current phase is the first phase `phase_complete` has not recorded complete on the epic (phases already finished when the epic started count as complete). `epic_next_wave` never issues a wave of phase N+1 before phase N is complete. The plan's own phase status is not used for this — it turns `complete` as soon as every task completes, before the phase review ran. `phase_complete` records only the epic's **current** phase; completing another phase out of order succeeds for the plan but is not recorded on the epic (a warning names the current phase).

**Wave composition — per-component parallelism.** The Epic component planner (`src/epic/components.ts`) works on the current phase's unresolved, unblocked tasks:

1. **Conflict graph.** Two tasks conflict when their scopes overlap by path (same file, or a directory and a file beneath it) or — with `epic.cochange.enabled` — a threshold-passing co-change pair has one file in each scope. This is **the same predicate** as the wave verdict the dispatch gate recomputes (see [Dispatch gate](#dispatch-gate-the-active-wave-is-the-authority)), so a wave the planner builds is always provably disjoint at dispatch. Scopes are the live declared scope, else `files_touched` (an estimate until declared).
2. **Exclusive tasks** run **alone, before anything else**: a task touching a Lean Turbo global file or protected path, a task with no usable scope, and a task whose declared scope touches a file [learning](#learning-across-waves-and-epics) marked hot. Each is its own component (mode `exclusive`).
3. **Components.** The other tasks are split into connected components of the conflict graph. Each component *C* gets a density *d*<sub>C</sub> = (conflict edges inside *C*) / (pairs of tasks in *C*); *d* = 0 for a single task. A component with *d*<sub>C</sub> > `epic.mode.activation_threshold` (default 0.3) is a **`serial-component`**: a densely coupled cluster — typically a hub file most of its tasks edit — that contributes **at most one task per wave**. Otherwise it is **`parallel`**: its tasks share a wave whenever they do not conflict, so a sparse chain (A–B, B–C, …) is one component whose non-adjacent tasks still run together.
4. **Next wave.** Among the ready tasks (every dependency resolved, cycle-safe topological order from the shared partition preflight): an exclusive task alone (`kind: 'exclusive'`); otherwise greedily, oldest component first (the number of waves since a component last had a task issued, so no component starves) and then topological order, add a task when it conflicts with no chosen task, its `serial-component` has no task in the wave yet, and the wave is below the epic's wave width (`turbo.lean.max_parallel_coders` in a git project, **1** in a non-git project). A wave of one task from a `serial-component` has `kind: 'serial-component'`; any other wave is `parallel`.

**Why a hub file costs one serial cluster, not the whole phase.** If six tasks of a phase edit `src/hub.ts` and six others do not, the six hub tasks form one dense component and run one per wave — but every wave also carries the other ready tasks, so the phase takes about six waves instead of twelve serial steps, and an unrelated cluster elsewhere in the phase is not slowed by the hub at all. Components are recomputed for every wave over the tasks still pending, so a cluster that thins out as its tasks finish can turn `parallel`.

With `epic.cochange.enabled` the wave records the threshold-passing co-change pairs among its files (≤ 256). Every wave also records the phase's components when it was issued (`components`: pending task → component, each component's mode and density, the exclusive reasons, the threshold; capped at 256 tasks, the wave's own tasks always kept) — `/swarm epic status` shows them for the active (or latest) wave. A dependency outside the wave's phase batch counts only when that task is completed **and**, under git, its task ref is an ancestor of HEAD (see [Commits: landing, residue, refs](#commits-landing-residue-refs)) — unless it was completed before the epic started (its phase was finished at start, or its last completion predates the start): `/swarm epic start` refused a dirty tree, so that work is already in HEAD.

**Wave records.** Each wave is written into the epic record with a token-guarded revision CAS: frozen declared scopes per task, `baseHead` (HEAD at issue), issue time, status (`issued` / `closed` / `aborted`), and at close `closeHead`, the merge-failure snapshots observed while it was blocked, and wave-level undeclared files. Each task gets an outcome: resolution (`completed` / `closed` / `removed`) and time, evidence workflow generation, Stage A / Stage B failure counts (**lower bounds** — the evidence keeps only its last three retry outcomes), merge-failure snapshot, declared and undeclared files, reopen count, and the task's commit (`marker`: its newest `swarm(task <id>):` commit for this plan inside the wave — `landing-commit` — else the close HEAD; `repaired` after `--repair-refs`). `/swarm epic status` and the close report show them.

**Divergence** is computed automatically at wave close (the architect no longer records it): a task's actual files are its write attribution unioned across every session of the same project (coder writes are attributed on the coder's child session). Without attribution the git fallback lists files changed since the wave's `baseHead` (committed or not); it is attributed to the task only when the wave had a single task, and otherwise kept as the wave's unattributed undeclared files. A declared directory covers every file beneath it.

### Waves vs. lanes

- A **lane** (Lean Turbo) is a serial chain; lanes run concurrently inside `lean_turbo_run_phase`'s runner.
- A **wave** (Epic) is a set of tasks with mutually non-conflicting scopes (at most one per dense component) whose dependencies are all resolved earlier. Waves run one after another; tasks within a wave run concurrently.
- Both planners share `src/turbo/lean/partition-common.ts` for risk classification, readiness, and cycle-safe topological sort, so they classify the same inputs identically; Epic supplies its own v2-resolved scopes to it explicitly (see [Declared scopes](#declared-scopes)) and builds waves with its component planner.

### Declared scopes

Epic's entry points — `epic_next_wave`, the `/swarm epic start` sizing preview, and `/swarm coupling` — read declared scope **only** from the authoritative v2 scope-binding store that `declare_scope` writes, pinned to the exact plan identity: a binding counts only while it is live (1 h TTL) and was declared against the current plan structure. Completing a phase's last task advances `current_phase`, which changes the structure hash, so each phase starts by declaring its tasks (`epic_next_wave` asks with `declare-scopes`). Legacy v1 `.swarm/scopes/scope-<taskId>.json` files are ignored. Where no live binding exists, the plan's `files_touched` is the planning estimate, but a wave is only issued once each of its tasks has a live binding; the scopes are then frozen into the wave record.

### Dispatch gate: the active wave is the authority

While an epic is open for the current plan, the delegation gate admits a coder **only for a task of the active wave**, and the wave — not the plan's `execution_profile` — decides how it runs. The gate reads the frozen wave record, never the live bindings (which expire after 1 h and follow plan revisions), so a wave that was safe to issue stays safe to dispatch. Each refusal names its remedy:

| Code | When | Remedy |
|---|---|---|
| `EPIC_NO_ACTIVE_WAVE` | No wave is issued (none yet, the last one closed / was aborted, or the phase is in review). | Call `epic_next_wave` and dispatch only the tasks it returns. While a phase is in review the message names the [fix-task path](#fixing-review-findings-fix-tasks): a coder for an already-completed task is never dispatched. |
| `EPIC_TASK_NOT_IN_ACTIVE_WAVE` | The task is not in the active wave. | Dispatch the wave's tasks, finish each (Stage A → Stage B → `update_task_status(completed)`), then call `epic_next_wave`. |
| `EPIC_TASK_UNKNOWN` | The dispatch names no task of the epic's plan. Defensive: the gate's own scope preflight normally refuses such a dispatch first with `SCOPE_NOT_DECLARED`. | Call `epic_next_wave` and use its task ids. |
| `EPIC_WAVE_SCOPE_DRIFT` | The coder's declared scope has a path not contained in the task's scope frozen at issue (containment as the write gates enforce it: a frozen directory covers everything beneath it). | One of: re-declare within the frozen scope (`replace_existing: true`, no `FILE:` line outside it) and dispatch again; finish the task within the frozen scope or close it, and add the extra work as a **new** pending task of the current phase (`save_plan`) for a later wave; or end the epic (`/swarm epic close --abandon`). A frozen scope never grows. |
| `EPIC_BRANCH_MISMATCH` | HEAD is not the epic branch (epic-branch policy). | `git checkout <epic branch>` (commit or stash first). |
| `EPIC_STATE_UNREADABLE` | Epic Mode is enabled by config and the sentinel exists, but the lifecycle row cannot be read or trusted. Coder dispatch fails closed (other Epic seams treat the epic as off). With Epic disabled by config the gate never reads the row: a leftover sentinel or corrupt row is ignored. | `/swarm epic status`, then `/swarm epic close --abandon`. |

An admitted coder runs **isolated** in a git worktree in a git project (see [Required worktree isolation](#commits-landing-residue-refs)) and in the main tree in a non-git one. The wave runs **in parallel** — the Stage A exemption for a *different* in-flight task and a slot cap of the epic's wave width (`maxParallel`, recorded at start) — when the incoming task is one of at least two unresolved wave tasks, the project is a git repository, and the wave's frozen scopes (plus its frozen co-change pairs when co-change was on) are provably disjoint. That verdict is one shared call (`computeParallelVerdict` with the wave's frozen scopes): `epic_next_wave` asserts it before issuing a multi-task wave and the gate repeats it at dispatch, so the two cannot disagree. `parallelization_enabled`, `max_concurrent_tasks` and a session's concurrency override do not apply to epic coders: a multi-task wave can dispatch up to `maxParallel` coders at once even with `parallelization_enabled: false`, and a single-task wave (or the last unresolved task of a wave) runs serially. The slot cap counts every task the session tracks as awaiting Stage A (`coder_delegated`), not only this wave's — a task that was closed or dropped while its coder output never passed Stage A still occupies a slot (and, in a serial wave, blocks with `STAGE_A_REQUIRED`). Remedy: run that task's Stage A (`pre_check_batch`) or repair it with `/swarm recover <taskId>`. The `[PARALLEL EXECUTION PROFILE]` advisory is suppressed while an epic is open.

**Order.** The wave check runs right after the coder's scope preflight and before the plan-critic, Stage A, slot and isolation checks, so an epic refusal is reported before any of them; with no epic open those checks run in exactly the non-Epic order.

**Carve-outs.** A **PR-feedback** coder (authenticated PR-feedback scope, no plan task) is admitted before this check by construction and is never wave-gated — but while a wave is issued it is refused `EPIC_PR_FEEDBACK_SCOPE_OVERLAP` if its declared files overlap any wave task's frozen scope (a running wave coder may be writing them); let the wave close first. Reviewer, test_engineer and other agents are never routed through coder admission. With no epic open the gate is exactly the non-Epic gate (one `existsSync` on the sentinel).

**Stage A attribution in a wave.** `pre_check_batch` takes no task id; upstream credits its result to the session's single `currentTaskId`, which in a wave is whichever coder returned last. While an epic runs a multi-task wave, a gate run is instead credited by its `files` to the one wave task whose frozen scope contains every checked file; with no files, files of several tasks, or no owner it is credited to none and the architect gets an `EPIC STAGE A ATTRIBUTION` advisory naming each task's frozen scope. So run Stage A once per task, with `files` set to that task's files (the wave's dispatch instructions say so). Single-task waves keep the upstream behaviour.

### Commits: landing, residue, refs

In a git project every task's work is **committed on the epic branch before the task completes**, so a rework coder — whose worktree is cut from HEAD — always starts from the first attempt and from the tests written for it, and its own landing never overlaps uncommitted bytes:

- **Required worktree isolation.** A coder for a task of the open epic (admitted by the [dispatch gate](#dispatch-gate-the-active-wave-is-the-authority)) always runs in an isolated git worktree, whatever `parallelization_enabled`, `max_concurrent_tasks` or a session's concurrency override say; an `auto` `worktree.policy` is treated as `required`. When isolation cannot be provided (provisioning failed, the SDK client is unavailable, `worktree.policy` is `"disabled"`), the dispatch is refused with `EPIC_ISOLATION_DEGRADED` — the coder never runs un-isolated in the main tree and the session is not serialized. Remedy: retry once the cause is fixed, or end the epic with `/swarm epic close --abandon`. Non-git epics run serially in the main tree (one task per wave) and are unaffected.
- **Commit at landing.** When the coder returns, its lane lands as a real merge commit (`git merge --no-ff --no-edit --no-verify -m <message>`) on the checked-out branch, with the message `swarm(task <id>): <description>` and a final `Swarm-Plan: <planKey>` trailer, instead of the default unstaged squash. It is a protocol commit on the epic branch and runs non-interactively: closed stdin, `--no-edit`, commit signing off, and repository commit hooks skipped (`--no-verify`, like residue commits) — your hooks and signing apply when you commit the epic's squash at close. A merge that fails (a conflict, a sibling's overlapping change) is rolled back, recorded as a merge-back failure, and holds the wave. When HEAD is not the epic branch the landing is **not** committed (it would land on a foreign branch); `epic_next_wave` then blocks `epic-branch-mismatch`. A landing merge needs a clean index: if the primary checkout has **staged** changes, the landing is not attempted, the lane is preserved, and `epic_next_wave` blocks `landing-index-dirty` (`EPIC_LANDING_INDEX_DIRTY`, naming the staged files — unstage them with `git restore --staged -- <files>`, then re-dispatch the task). A lane recovered later through `/swarm lanes` (a preserved recovery claim) lands through the recovery path's own committed merge (`git merge --no-edit`, its default message), so its task commit is recorded as the wave's close HEAD.
- **Residue commits.** Other agents write in the main tree — the test_engineer writes the task's tests, the docs agent its docs. When such a delegation returns for a task of the open epic — a foreground `Task` or a background delegation (`background_subagents`) — its attributed writes still uncommitted are committed on the epic branch: the files the returning agent's own session recorded as `swarm(task <id>): <agent> residue`, then the rest of the task's attributed writes and frozen scope as `swarm(task <id>): residue` (+ the trailer). A file that another still-running delegation (e.g. the concurrent Stage B test_engineer when the reviewer returns first) has recorded is never swept up: it is committed when its own writer returns, or when the wave closes. A path is attributed to a task when the task declared it **in the current wave** (its frozen scope; scopes are literal files or directories — a declared directory covers everything beneath it, a glob such as `src/**/*.ts` is never expanded), when a session of this project recorded the task writing it, or when the returning agent's own session wrote it. Staging and the commit use **literal** pathspecs (`app/[id].tsx` names exactly that path), the commit is `--only` (anything else in the index stays staged and out of it), a staged rename carries its source deletion, and `.swarm/` is never committed at any depth. Residue commits skip repository hooks (`--no-verify`) and signing, and wait for any worktree landing in progress (one writer of the index at a time). A failed residue commit never breaks the delegation (a critical warning; `epic_next_wave` retries) and restores the index exactly as it was, your own staged changes included. Closing a wave commits any residue still attributed to its tasks first (a failure keeps the wave open: `git-failed`). Declaring each task's test files in its scope keeps this exact. **Do not edit the working tree yourself while an epic wave runs:** an edit inside the scope of a task of the running (or closing) wave can be committed as that task's residue. An edit made after its wave closed is never attributed to a task: a tracked change blocks the next wave (`dirty-baseline`) until you commit or discard it.
- **`update_task_status` performs no git writes** — under any configuration. (The former Epic "Rule 2" commit at completion is gone; the #2582 auto-checkpoint only reads HEAD.)
- **Refs.** The epic keeps `refs/swarm/epics/<epicKey>/base` (the start commit, written at `/swarm epic start`), `…/waves/<seq>` (HEAD when the wave closed) and `…/tasks/<id>` (the task's commit recorded at wave close). The epic record is the source of truth and the refs mirror it: a missing ref is created with the create-only `git update-ref <ref> <sha> ""`, an existing ref is left alone, and a drifted one is compare-and-swapped back. Refs keep the epic's commits reachable (gc roots) and are shared by all linked worktrees. **They are not pushed or cloned by default** (`git push` and `git clone` carry branches and tags only; `git clone --mirror` / `git push --mirror` copy them). `/swarm epic close` records every ref in the close report and then deletes them, unless `epic.retain_refs: true`; `/swarm close` finalization does the same.
- **Predecessor evidence.** A completed dependency outside the wave batch counts only when its task ref exists and is an ancestor of HEAD (`git merge-base --is-ancestor`), or the task was completed before the epic started; a git failure blocks `git-failed` (fail closed). A rebase or amend that rewrote the task's commit makes the dependent `predecessor-missing` (`not-committed`). Note that a plain `git rebase` of the epic branch drops the landing merge commits (and with them the `swarm(task …)` subjects) unless you pass `--rebase-merges`; prefer not to rewrite the epic branch while the epic is open. To recover, run **`/swarm epic status --repair-refs`**, which re-points each completed task whose commit is no longer reachable to its newest `swarm(task <id>):` commit for this plan in the epic's range (else the newest commit touching its declared files) and also adopts the commit of a task completed outside a wave; a task with neither is reported `needs-attention` (commit its work with that subject and trailer, then rerun).
- **Plan-scoped messages.** Task ids repeat across plans, so the trailer carries `planKey = sha256(planIdentityHash + '|' + planEpoch).slice(0, 16)`; the plan epoch is minted per ledger root, so consecutive plans with the same title still differ. Wave close and `--repair-refs` only accept commits whose trailer names the current plan, inside the epic's own commit range, from one bounded `git log` (merge commits included).

### Fixing review findings (fix tasks)

While an epic is open, coders run only through waves, so a phase review that returns NEEDS_REVISION or REJECTED (or a critic that does) is fixed with **new tasks**, never by re-dispatching a coder for a completed task (the gate refuses it with `EPIC_NO_ACTIVE_WAVE`):

1. Add each fix as a new **pending** task of the phase under review with `save_plan` (a description and its `files_touched`; re-approve the plan with the plan critic if your project requires it after a plan change).
2. Call `epic_next_wave`: it returns `declare-scopes` for the new task(s); declare them and call again — it issues a **fix wave** of the same phase (frozen scopes, landing commits, residue, task refs and outcomes exactly as for any wave).
3. Run the fix wave as usual. When it closes, `epic_next_wave` returns `phase-ready-for-review` again: re-run `epic_phase_review(phase)`, then `phase_complete`.

`epic_phase_review`, the `phase_complete` block reasons and `epic_next_wave`'s `phase-ready-for-review` message all name this path. A task completed in an already-**complete** phase that is reopened blocks `task-reopened`: close it, or close it and re-add the remaining work as a new task of the current phase.

### Phase readiness (phase reviewer + phase critic)

While an epic is open for the current plan, `phase_complete` runs the `epic_phase_readiness` gate. It replaces Lean Turbo's `lean_turbo_readiness` gate, which is marked not-applicable under Epic (do not call `lean_turbo_review` / `lean_turbo_critic`).

- **Producer:** `epic_phase_review(phase)` (architect-only). The tool itself dispatches a read-only phase reviewer and, only when it APPROVES, a read-only phase critic through the plugin's review dispatcher (per-role timeout `epic.phase_review.timeout_ms`, default 300 s; a timed-out role is recorded fail-closed as REJECTED and the review is re-run), parses each verdict from the agent's response (missing/ambiguous/failed ⇒ REJECTED), and writes `.swarm/evidence/{phase}/epic-phase-review.json`. Verdicts are never accepted as arguments. It refuses while any phase task is not completed, and (`waves-open`) while any wave `epic_next_wave` issued for the phase is not closed. Each run is recorded on the epic (`reviewRuns`, verdicts).
- **Empty responses (provider refusals):** OpenCode Zen's free tier refuses (HTTP 403, "free tier can only be used from within OpenCode") any request that disables the `bash` tool, and the shared review dispatcher disables `bash` along with every mutating and plugin tool; it reports that refusal, like any provider-side error, as an empty response. `epic_phase_review` therefore retries an **empty** response exactly once, within the same per-role timeout, with the same prompt plus an instruction not to change anything, and with only `bash` re-enabled. Every other tool stays denied, so the retry is still narrower than the standard per-task reviewer and critic agents (which deny only `write`/`edit`/`patch` among the built-ins). Their shell commands pass the guardrails' shell-write checks (unresolvable, inline-eval and deny-listed writes are blocked; the deny list is empty by default), which are not a read-only sandbox. The evidence records `tool_profile: read-only` or `read-only-with-bash`, and the tool's message says when the retry was used. A response with text but no verdict, a timeout or a failed dispatch is never retried, and a second empty response stays a fail-closed REJECTED.
- **Freshness:** the evidence binds to the epic it ran under (its key), the plan id, the status-free plan structure hash, the phase's task ids and statuses, and the content of every phase task's `.swarm/evidence/{taskId}.json`; any change (e.g. rework after review), age over 24 h, or a future-dated timestamp makes it stale — re-run `epic_phase_review`.
- **Block codes:** `EPIC_PHASE_WAVES_OPEN` (a wave of the phase is still open — call `epic_next_wave` until it returns `phase-ready-for-review`; also used, fail closed, when the epic record is unreadable), `EPIC_PHASE_REVIEW_MISSING`, `EPIC_PHASE_REVIEW_INVALID`, `EPIC_PHASE_REVIEWER_NOT_APPROVED`, `EPIC_PHASE_CRITIC_MISSING`, `EPIC_PHASE_CRITIC_NOT_APPROVED`, `EPIC_PHASE_REVIEW_STALE`, `EPIC_PHASE_PLAN_UNREADABLE`; each carries recovery `epic_phase_review({ phase })`. On success `phase_complete` records the phase complete on the epic, which lets `epic_next_wave` move to the next phase.
- **Turbo interaction:** Epic keeps Turbo off (see [Mode comparison](#mode-comparison)), so Gates 1–5 run as usual and this gate adds one cross-task integration review of the concurrently executed waves.

### Lifecycle: start, status, close

An epic is **plan-scoped**: one open epic per project, bound to the current plan's identity (swarm/title) and plan-ledger root. The authority is one row in the project SQLite coordination store (namespace `epic.lifecycle`); `.swarm/epic/epic.json` is a small **sentinel** projection of it. Every Epic hot-path check (the wave dispatch gate, the landing seam, the residue commit, the auto-checkpoint guard, the phase-readiness gate, the Epic banner, the delegation-gate guidance, attribution retention) first asks "does the sentinel exist?" — so a project that never opened an epic pays exactly one `existsSync` and nothing else (no database open, no config read, no write). With the sentinel present the probe reads the row, then the config gate, then the plan identity; it never writes and never caches.

- **`/swarm epic start [--force]`** opens an epic for the current plan. Refusals, in order: `epic-disabled-by-config`; `host-unsupported` (see the host requirement above); `no-plan` / `plan-ledger-unreadable` (including a plan with no ledger or no plan epoch yet — save it with `save_plan` first, so a later save cannot re-root it out from under the epic); `epic-already-open` (the same plan — idempotent, nothing changes) / `epic-open-for-other-plan`; `turbo-active` (config `turbo_mode: true`, any session in the process with Turbo on, or a running durable Lean run — Epic enables neither Turbo nor Lean and never waives per-task QA); `dirty-baseline` (git only: uncommitted changes outside `.swarm/`); `in-flight-coders` (project-wide: tracked worktree coder dispatches, non-terminal background delegations, unsettled coder settlements, preserved/claimed recovery lanes, lanes being provisioned — uncertain stores count as in flight); `not-epic-sized` (see [Sizing](#sizing)); with the epic-branch policy also `detached-head` (HEAD detached, or a branch with no commit yet) and `epic-branch-exists` (`swarm/epic/<epicKey>` is left over from an earlier, abandoned epic of the same plan — delete it with `git branch -D`). Non-git projects may open an epic, but it runs serially (one task per wave). Git epics then switch to their epic branch (see [Epic branch and landing](#epic-branch-and-landing)); if that checkout fails (`branch-create-failed`, with git's error) the row and sentinel are rolled back and nothing is opened.
- **`/swarm epic status [--repair-refs]`** (and bare `/swarm epic`) shows the epic, its sizing at start, its waves (issued / closed / aborted, the active wave), phases (review runs and last verdicts), and recorded divergence; reports an **orphaned** epic — the plan was renamed or replaced (a new ledger root) since start, so Epic behaviour is off for the current plan — with the remedy `/swarm epic close --abandon`; repairs a sentinel that disagrees with the row (stale sentinel removed, missing sentinel restored); lists recorded worktree merge failures; with `--repair-refs` re-adopts task commits a rebase or amend made unreachable (see [Commits: landing, residue, refs](#commits-landing-residue-refs)); and retires legacy Epic v1 per-session state once (v1 rows deleted, `.swarm/epic-state.json` archived to `.imported`; a session that was still "on" gets an advisory to run `/swarm epic start` — nothing is opened automatically).
- **`/swarm epic close [--abandon] [--land squash|merge|none]`** refuses `epic-incomplete` while any task is neither completed nor closed, and refuses an orphaned or unreadable epic, unless `--abandon`. For an epic-branch epic it then runs the landing preflight **before changing anything**: `dirty-worktree` (uncommitted changes outside `.swarm/` — landing switches branches), `epic-branch-missing` (the branch was deleted; finish with `--land none`), `original-branch-missing` (recreate it, e.g. `git branch <original> <baseCommit>`, or use `--abandon`), `detached-head` (HEAD is detached on a commit that is on neither branch, so switching would orphan it). An epic branch with no changes reports `nothing-to-land` and still closes. `--abandon` refuses `coders-live` while a coder settlement is still owned by a running dispatch (the coder would otherwise land its work on the original branch after the epic is gone); let it settle, then re-run. It then marks the row `closing`, writes a close report (`epic-report-v2`, embedding the epic's [scorecard](#scorecard-and-report)) to `.swarm/epic/reports/<epicKey>-<start>.json` and `.swarm/epic-prior/reports/` (the newest 50 kept; `epic-prior/` survives `/swarm close`), lands the epic branch (below), records the landing outcome in the report, deletes the epic's refs (unless `epic.retain_refs`), deletes the row, and finally removes the sentinel only if it still names this epic. An interrupted close resumes on the next `/swarm epic close`. On unreadable lifecycle state, `--abandon` deletes the rows without parsing them.
- **`/swarm close`** closes an open epic as `abandoned-by-swarm-close` before archiving, so its report is archived with `.swarm/epic/` and kept in `.swarm/epic-prior/`. It never lands: with a clean tree it switches back to the original branch, keeps the epic branch, and names it in the close output. **`/swarm reset-session`** leaves the epic alone (it is plan-scoped, not session-scoped).

All lifecycle writes run inside the coordination store's `BEGIN IMMEDIATE` transaction, which serializes concurrent starts and closes across processes: only the start that creates the row writes the sentinel.

### Epic branch and landing

`epic.commit_policy` (git projects) chooses where an epic's commits go. With **`epic-branch`** (the default), `/swarm epic start` runs `git checkout -b swarm/epic/<epicKey>` right after the lifecycle row is created and records the branch only once the checkout succeeded; the original branch and base commit are recorded too. Every task's landing and residue commit then goes to the epic branch, and the original branch does not move until close. If `git checkout -b` reports an error after HEAD already switched (for example a failing `post-checkout` hook) the start proceeds; otherwise it is rolled back and a branch it created at the start commit is removed again. With **`current-branch`** commits stay on the branch that was current at start and close lands nothing (the C1a behaviour). Non-git epics have no branch.

**Branch drift.** Keep the epic branch checked out while the epic is open. If HEAD is on any other branch (or detached), `epic_next_wave` blocks with `epic-branch-mismatch` (`EPIC_BRANCH_MISMATCH`, remedy `git checkout swarm/epic/<epicKey>`), a coder's landing is not committed and a residue commit is skipped (each with a critical warning) rather than committing onto a foreign branch, and `/swarm epic status` shows the mismatch. A git failure while checking counts as a mismatch.

**Landing modes** (`/swarm epic close --land …`):

| Mode | What happens |
|---|---|
| `squash` (default) | `git checkout <original>` then `git merge --squash --no-commit swarm/epic/<epicKey>`: the epic's whole diff is **staged, uncommitted** on the original branch. Review it (`git diff --cached`) and commit it yourself. The epic branch is kept until you have committed — delete it afterwards with `git branch -D swarm/epic/<epicKey>`. |
| `merge` | `git checkout <original>` then `git merge --no-ff --no-edit swarm/epic/<epicKey>` (a merge commit). |
| `none` | `git checkout <original>` only; the epic branch is left as is for you to merge. |

`--abandon` never lands: it switches back to the original branch when the tree is clean (otherwise it stays put and says why) and keeps the epic branch. Landing is non-interactive: git runs with closed stdin, `GIT_EDITOR=true`, `GIT_MERGE_AUTOEDIT=no`, `--no-edit`, and commit signing off for the merge commit; repository hooks (`pre-merge-commit`, `commit-msg`) still run, and a hook that rejects the merge is a landing failure.

**Notes.** Ignored and untracked files follow normal `git checkout` semantics when close switches branches (git refuses to overwrite an untracked file that the other branch tracks); keep `.swarm/` git-ignored (the plugin's `.git/info/exclude` entry does this) so runtime state never takes part in landing. After a squash landing, a later `/swarm close` may offer to discard the still-staged squash as dirty tracked changes — commit it first; if it is discarded it can be recovered from the kept epic branch (`git merge --squash swarm/epic/<epicKey>`).

**Conflict recovery.** A landing that conflicts (or fails) is rolled back — squash with `git reset --merge` (a squash writes no `MERGE_HEAD`, so `git merge --abort` cannot be used), merge with `git merge --abort` — normally leaving you on a clean original branch with the epic branch untouched; if the rollback itself or the switch back fails, the close output says where HEAD actually is and asks you to check `git status`. The close stops with the epic still `closing` (the attempt is recorded and shown by `/swarm epic status`); rerunning `/swarm epic close` resumes. To land by hand: `git merge --squash swarm/epic/<epicKey>` (or `git merge --no-ff …`), resolve, stage/commit, then finish with `/swarm epic close --land none`. Landing is idempotent: a close interrupted after the squash was staged (or after the merge) detects the already-landed state on the next run instead of refusing its own staged changes.

The Epic v1 `/swarm epic on` / `off` toggles were removed. `/swarm turbo epic …` no longer enables anything: it replies with a redirect to `/swarm epic start`, and Turbo-enabling subcommands are refused while an epic is open.

### Sizing

`/swarm epic start` refuses a plan that is not worth running as an epic (reason `not-epic-sized`, with the measured values, the top [plan-shaping](#plan-shaping) suggestions, and "run it in Balanced"). With *T* pending tasks (status not `completed`/`closed`), *coverage* the share of them with a scope (live declared scope, else `files_touched`), and *L* the serial steps of a dry run of the Epic component planner — the planner `epic_next_wave` issues waves with, with the same learned hot files and co-writes (from the project prior), co-change signal and density threshold — over every phase under the epic's wave width (the waves it would issue, assuming each completes, plus one step per task it could never schedule, e.g. a dependency cycle):

*S* = *T* / *L*, *S*<sub>eff</sub> = 1 / ((1 − *c*) + *c* / *S*), where *c* = `coder_fraction` (the share of a task's time parallel coders overlap; QA and architect turns stay serial).

A plan is epic-sized when *T* ≥ `min_tasks` (6), coverage ≥ `min_scope_coverage` (0.8), and *S*<sub>eff</sub> ≥ `min_effective_speedup` (1.25); otherwise the reasons are `too-few-tasks`, `insufficient-scope-coverage`, `insufficient-parallelism`. `--force` opens the epic anyway and records `forced: true` in the epic record and its scorecard. A non-git epic (wave width 1) is never epic-sized, so it needs `--force`.

### Plan shaping

Plan shaping says how a plan could run better as an epic, using the same model as [Sizing](#sizing) — and where it appears it is **advice only**: nothing is changed, and the architect decides whether to apply a suggestion through `save_plan`.

**Where it appears.**

- **`save_plan`** — when `epic.mode.enabled` is true (and no epic is open), the tool result gains `epic_shaping`, computed for the plan as persisted (`plan.json` after the save). With Epic off nothing is computed and the result is unchanged (save_plan reuses the config it already loaded; no extra read, I/O or await). Shaping runs after the plan lock is released and fails open: an error leaves the save successful without `epic_shaping`.
  - A plan that is not epic-sized and that no suggestion fixes gets one line: `{ status: "not-epic-sized", message: "Plan is not epic-sized (<reason>) — run it in Balanced", cochange }`. A plan over the budget (below) gets `{ status: "skipped-budget", message, cochange }`. With a cold co-change cache the message says so.
  - Otherwise the full advisory: `status` (`acceptable` — epic-sized, nothing worth changing; or `improvable`), `epic_sized`, `effective_speedup`, `pending_tasks`, `serial_steps`, `reasons`, `cochange`, up to 5 `suggestions`, `iteration` and `next_step`. Every key of the advisory, suggestions and patches included, is snake_case (`task_ids`, `patch.new_task`, `patch.edits[].task_id`, …). The iteration counter (`.swarm/epic/shaping.json`, keyed by plan identity and plan epoch) counts saves of the same plan; from iteration 3, `next_step` says to accept the plan and proceed instead of reshaping again.
- **`/swarm epic start`** — a `not-epic-sized` refusal shows the top 3 suggestions with their patch, computed from the start's own sizing (no second dry run) and inputs, including fresh co-change data.
- **`/swarm coupling --suggest`** — the whole plan's advisory, read-only (nothing is written).

**Inputs.** Each pending task's estimated scope (live declared scope, else `files_touched`), the learned hot files and co-writes of the project prior, the epic's wave width (`max_parallel_coders` in a git project, 1 otherwise), and co-change when `epic.cochange.enabled`. In `save_plan` co-change comes only from the in-memory cache that `/swarm epic start`, `/swarm coupling` and `epic_next_wave` fill (no git command on a plan save): with a cold cache shaping is path-only and says `cochange: "cold"`.

**Suggestions.** Scope advice first, then the rest ranked by ΔS<sub>eff</sub> — the change in effective speedup when the suggestion's patch is applied to the plan and the dry run is repeated. Every plan-changing suggestion is a **concrete patch**: apply it verbatim (new task(s) added to the phase, each edited task given exactly the edit's complete `files_touched` and `depends`, `removed_task_ids` with `removal_reason`) and the plan is valid (unused `N.M` ids, no dangling dependency, no cycle — a patch that would create one is never offered) and sizes exactly as promised.

| Type | When | Payload |
|---|---|---|
| `declare-scope` | pending tasks without a scope (they always run alone) | `task_ids` |
| `narrow-scope` | a directory scope entry that drives conflicts (it conflicts with every task under it, so it is never extracted) | `entry`, `task_ids` |
| `extract-prerequisite` | a file declared by ≥ 3 tasks that drives ≥ 25 % of the plan's conflict edges or gains ≥ 0.25 × — the fix for a shared registry/barrel/global file or a hot file | `patch`: `new_task` (owns the file; inherits the owners' outside dependencies that do not lead back to an owner) and `edits` (per owner: `remove_files`, `add_depends`, complete `files_touched` and `depends`) |
| `isolate-hot-file` | a learned hot file declared by fewer tasks: the same patch moves it into its own task so the rest of each task stops running alone | `patch` |
| `split-task` | a task joining two conflict clusters (an articulation point): one part per cluster; every task depending on it must depend on all parts | `parts`, `patch`: `new_tasks` + `edits` (the task keeps part 1; dependents gain the new part ids) |
| `merge-tasks` | two small tasks whose scopes overlap with Jaccard ≥ 0.8 and neither depends on the other through a third task; offered at ΔS<sub>eff</sub> ≥ 0 (they serialize anyway; one task saves a QA cycle) | `keep`, `absorb`, `patch`: `removed_task_ids`, `removal_reason`, `edits` (the kept task's union scope and dependencies; every dependent re-pointed) |

**Budget.** Bounded by work, not time: at most 200 pending tasks and 500 distinct scope files; what-ifs for at most the top 10 candidate files (by edges driven plus tasks made exclusive), 3 split and 3 merge candidates; and one deterministic work allowance (units ≈ path comparisons, charged before each dry-run step, for each graph build, edge-driver lookup and pair scan) — about 0.25 s of computation on a laptop, so Epic adds at most ≈ 0.3 s to a `save_plan`. A plan that does not fit is `skipped-budget` (with its sizing when the baseline fit). Because the bound is the budget, there is no timeout verdict. `/swarm epic start` sizes with a larger allowance (≈ 1–2 s); a plan too large or densely coupled to size within it is refused `not-epic-sized` with the unplanned tasks counted as serial and a "too large to size exactly" note (run it in Balanced, or `--force`).

### Scorecard and report

Every epic has a **scorecard** (`src/epic/scorecard.ts`, schema `epic-scorecard-v1`), computed only from what the epic record already holds — no extra bookkeeping, no git, no I/O:

| Group | Fields |
|---|---|
| identity | `epicKey`, `planId`, `outcome` (`open`, `completed`, `abandoned`, `abandoned-by-swarm-close`), `startedAt`, `closedAt`, `forced`, `sizingAtStart` |
| `tasks` | `total` (plan tasks), `completedInEpic` (resolved `completed` through a wave), `adoptedAtStart` (already completed when the epic started), `exclusive` / `serialComponent` (tasks issued alone for those reasons, the open wave included) |
| `waves` | `count` (every issued wave, the open one included; aborted waves excluded), `parallel` (waves with 2+ tasks), `meanWidth`, `maxWidth` |
| `time` | `method: "wave-span-v1"`: `spanMs` = Σ (close − issue) over closed waves; `workMs` = Σ (resolve − wave issue) over the tasks completed in them; `concurrencyFactor` = workMs / spanMs; `interWaveIdleMs` = Σ gaps between one wave's close and the next one's issue |
| `conflicts` | `mergeFailures` (tasks whose worktree merge-back failed while their wave ran), `undeclaredWriteTasks`, `undeclaredFiles` (first 20, sorted) and `undeclaredFilesTotal` |
| `rework` | `tasksWithRework` (evidence generation ≥ 2), `extraGenerations` (Σ generation − 1), `reopened` |
| `gates` | first-pass rates `{ passed, of, rate }` for Stage A and Stage B (completed tasks with no recorded failure) and the phase review (phases whose first review run was approved by reviewer and critic); `boundedHistory: true` |
| `learning` | `priorDigest` (the project prior inherited at start), `topHotFiles` (≤ 10, of the epic's learned state) |

**Read it right.** The concurrency factor is **not a speedup**: a task's issue→resolve time includes queueing behind serialized QA (reviewers and test engineers run one task at a time) and a wave closes only when the architect next calls `epic_next_wave`, so it says how much task time overlapped — never how much faster the epic was than a serial run. The gate rates are **upper bounds**: the failure counts behind them are lower bounds (the evidence workflow keeps its last 3 retry outcomes; a phase keeps its last 20 review verdicts).

**Where it appears.**

- **`/swarm epic report`** — the live scorecard of the open epic: its `time` metrics count closed waves only, while the wave, width and exclusive / serial-component counts include the wave still open; it works with the config gate off or for an orphaned epic, like `status`, and says so.
- **`/swarm epic report last`** / **`/swarm epic report <key>`** — a past epic's scorecard from its close report in `.swarm/epic-prior/reports/` (`last` = newest; `<key>` = a report key `<epicKey>-<start>` or an epic key, newest first). `--format json` prints `{ source, reportKey, notes, scorecard }`. A report is read only when it is `epic-report-v2` and its scorecard validates field by field; otherwise it is reported unreadable (naming the first bad field), never half-rendered.
- **The close report** (`epic-report-v2`) embeds the final scorecard (which carries `forced`, `sizingAtStart` and the inherited prior's digest). `/swarm epic close` prints a one-line summary of it.

**Planner regression harness.** `scripts/lib/epic-sim.ts` replays small fixture plans (`tests/fixtures/epic-bench/*.json`: independent tasks, a hub file, a dependency chain, dense co-change, a dense ring with hidden writes, undeclared co-writes learned over several epics, a "magnet" file written by a new declarer each phase, one explained co-write among independent tasks) through the **real** planners — serial Balanced, the Lean Turbo lane planner, and the Epic component planner with learning — under a fixed, seeded cost model (Lean is executed as its runner does — one coder per lane, the lane's tasks in order; its planner puts every mutually non-conflicting task into the first lane, so Lean shows a serial makespan and no conflicts), and compares makespan, conflicts (concurrent tasks whose true write sets overlap) and rework against `golden.json`. It is a **planner regression harness, not a benchmark of real speed**: real epics have model latency, serialized QA, retries and humans in the loop, none of which it models. It runs as an ordinary unit test (`tests/unit/epic/epic-bench.test.ts`: Epic never slower than Balanced, learning reducing conflicts across epics, each planning signal — co-change, learning, the hot set, density demotion — worse when switched off, no needless serialization, no metric more than 5 % worse than golden); `bun scripts/epic-bench.ts` prints the table and `bun scripts/epic-bench.ts --write-golden` regenerates the golden file (review the diff).

### Slash command

```
/swarm epic start [--force]   # open an epic for the current plan (see refusals above)
/swarm epic close [--abandon] [--land squash|merge|none]  # close it, land the epic branch (default squash: staged, uncommitted), write the report
/swarm epic                   # same as status — the bare form never mutates the epic
/swarm epic status            # epic, waves, phases, divergence, orphan/sentinel repair, merge failures
/swarm epic status --repair-refs  # also re-adopt task commits a rebase/amend made unreachable
/swarm epic report [<key>|last] [--format json]  # the scorecard: live for the open epic, else a past epic's close report
/swarm epic learning          # what the planner learned and uses now: hot files, learned co-writes, settings
/swarm epic prior [show]      # the project prior (.swarm/epic-prior/learning.json)
/swarm epic prior reset [--confirm=<token>]  # clear the project prior: preview + token, then confirm
/swarm epic clear-merge-failure <taskId> [--confirm]  # clear a recorded worktree merge failure blocking an epic wave (preview without --confirm)
```

`close`, `status`, `report`, `learning`, and `prior` work regardless of the config gate. `/swarm epic decide` and `/swarm epic last` were removed with the activation gate (they answer with a pointer to `status`); `/swarm epic calibration` was renamed `/swarm epic learning` (it answers with a pointer). If the lifecycle state is unreadable, `status` says so (Epic behaviour is off, fail closed) and `/swarm epic close --abandon` repairs it.

### Configuration

Epic settings live in the top-level `epic` block; Epic Mode needs no `turbo` block. Minimal opt-in:

```json
{
  "epic": {
    "mode": { "enabled": true },
    "cochange": { "enabled": false, "threshold": 0.6, "min_co_changes": 5 }
  }
}
```

**Legacy path `turbo.epic`.** Configs written before Epic v2 C9 put this block under `turbo.epic`. That path is still accepted, with no removal planned: the loader moves it to top-level `epic` before validation (so it no longer needs `turbo.strategy`). Precedence: in each config file the loader first moves `turbo.epic` into that file's top-level `epic` (per key, the file's own top-level `epic` wins and the legacy block fills in the rest), and then merges the user and project files as usual, with the project winning. The loader logs one warning (`turbo.epic is deprecated — move it to top-level epic`) whenever any file has `turbo.epic`, even when every one of its keys is overridden, and `/swarm config doctor` reports a `legacy-epic-config-path` finding for each such file. The doctor does not fix this automatically: its fix model edits one value in one file and has no move-and-merge. The JSON schema marks `turbo.epic` as `deprecated`, but it still describes `turbo` as requiring `strategy`, so an editor flags a strategy-less legacy `turbo` block that the plugin accepts. Move the block to top-level `epic` to clear it. An invalid `epic` value (wrong type, unknown key) goes through the loader's standard validation recovery, like any other known key: the offending key or section is dropped with a warning and the rest of the config is kept. Keys recovered from a legacy block are labelled `(from turbo.epic)`, and the doctor reports them at their `turbo.epic.*` path. Retired keys (`mode.min_commits_for_signal`, `calibration`) are accepted, stripped and reported under either path. Maintainers: see the [Epic maintainer guide](../src/epic/README.md#config).

| Key | Default | Effect |
|---|---|---|
| `epic.mode.enabled` | `false` | **Master gate for Epic Mode.** Required for `/swarm epic start`, the Epic tools (`epic_next_wave`, `epic_phase_review` — granted to the architect only while it is on), commit-at-landing, required worktree isolation, residue commits, the Epic phase-readiness gate, and the Epic banner. Turning it off makes an open epic inert until it is re-enabled or closed. |
| `epic.mode.activation_threshold` | `0.3` | **Intra-component density threshold** (Epic v2 C5): a conflict component whose density exceeds it is a `serial-component` (one task per wave); see [Wave composition](#the-epic_next_wave-flow). Lower ⇒ more clusters serialize; `1` ⇒ only conflicts themselves keep tasks apart. It no longer means a plan-wide coupling ceiling. |
| `epic.mode.min_commits_for_signal` | — | **Retired** (Epic v2 C5). Accepted and ignored — stripped before validation, read by nothing — with a precise "retired" warning from the loader (once) and a `retired-config-key` finding from `/swarm config doctor`, not an unrecognized-key recovery. Marked `deprecated` in the JSON schema. Remove it. |
| `epic.cochange.enabled` | `false` | **Master gate for the co-change signal** (Capability A). Off ⇒ `epic_next_wave` separates wave members on declared-path conflicts only, and `/swarm coupling` records `cochangeSignal: 'disabled-by-config'`. On ⇒ co-changing tasks are also kept apart and each wave records its in-wave pairs. |
| `epic.cochange.threshold` | `0.6` | NPMI floor (range `[-1, 1]`) for a pair to contribute a co-change conflict. |
| `epic.cochange.min_co_changes` | `5` | Minimum raw co-change count before NPMI is considered. |
| `epic.learning.enabled` | `true` | Master gate for [learning](#learning-across-waves-and-epics). Off ⇒ nothing is learned, read, or written (no import, no posterior, no prior merge). Inert unless `mode.enabled` is also true. |
| `epic.learning.decay_per_epic` | `0.7` | Multiplier applied to the project prior at every epic close that learned something (before the epic's observations are added). |
| `epic.learning.half_life_days` | `60` | Half-life of learned evidence, counted in whole half-lives: stored statistics are scaled by 0.5^floor(days since written / half-life) when read (full weight for a whole half-life). |
| `epic.learning.hot_excess` | `0.25` | A file is hot when its incident rate exceeds the prior mean (0.1) by more than this, with at least one full incident. |
| `epic.calibration` | — | **Retired** (Epic v2 C6): the whole Epic v1 calibration block (`enabled`, `floor_threshold`, `tighten_step`, `loosen_step`, `loosen_window`) is accepted and ignored with a "retired" loader warning and a `retired-config-key` doctor finding; marked `deprecated` in the JSON schema. `calibration.enabled: false` does **not** turn learning off — use `learning.enabled`. Remove it. |
| `epic.sizing.min_tasks` | `6` | Minimum pending tasks for `/swarm epic start` (see [Sizing](#sizing)). |
| `epic.sizing.min_scope_coverage` | `0.8` | Minimum share of pending tasks with a declared scope or `files_touched`. |
| `epic.sizing.min_effective_speedup` | `1.25` | Minimum Amdahl-adjusted speedup *S*<sub>eff</sub>. |
| `epic.sizing.coder_fraction` | `0.6` | Share of a task's time that parallel coders overlap (*c* in *S*<sub>eff</sub>). |
| `epic.retain_refs` | `false` | Keep the epic's refs (`refs/swarm/epics/<epicKey>/…`) after `/swarm epic close` / `/swarm close`. Off ⇒ they are deleted once the close report has recorded their values. |

### Capability A — Co-change-aware Pair Conflict

`src/epic/cochange-conflict.ts` exports `epicPairConflict(scopeA, scopeB, cochangePairs, threshold)` — a pure function that combines Lean Turbo's path-based pair test (`pathsConflict` from `src/turbo/lean/conflicts.ts`) with a git co-change signal sourced from the existing `co_change_analyzer` tool (composed via its `_internals.parseGitLog` + `_internals.buildCoChangeMatrix` primitives), threshold-gated by NPMI and raw co-change count.

The combination is **conservative**: the co-change signal can only escalate a verdict from "no conflict" to "conflict", never downgrade a path-based conflict. The data source (`src/epic/cochange-source.ts`) caches per-project results keyed on `git HEAD`, with FIFO eviction at 10 directories, and falls back to "signal absent" (`[]`) on greenfield repos, non-git directories, or git errors. The signal is only queried when `epic.cochange.enabled` is true; `epic_next_wave` then uses it to keep co-changing tasks out of the same wave.

### Capability B — Coupling KPI + decoupling roadmap

`/swarm coupling` is a **read-only diagnostic** that computes `p` (the share of conflicting task pairs) for the current plan and ranks the modules that drive the most detected conflicts, using Epic's path + co-change conflict predicate.

```
/swarm coupling                                # whole plan, markdown to stdout
/swarm coupling --phase 2                      # scope to phase 2
/swarm coupling --threshold 0.7                # what-if a stricter NPMI floor
/swarm coupling --min-co-changes 10            # what-if a stricter count floor
/swarm coupling --format json                  # machine-readable
/swarm coupling --persist                      # also write .swarm/epic/coupling-report.json
/swarm coupling --suggest                      # also shape the whole plan (see Plan shaping)
```

**Output structure.** A short header (`p = 0.NNN`, X conflicting pairs out of Y), a per-module contention table, a decoupling roadmap (top-5 modules with their share of detected coupling), and a conflicting-task-pairs table with each pair's reason (`path` / `cochange` / `both`). All figures are *estimates*.

**Config-aware.** `/swarm coupling` runs without Epic Mode being on, but it is **not** independent of `epic.cochange.enabled`: with that gate off it computes path-only conflicts and the report states the co-change signal is disabled by config. `--threshold` / `--min-co-changes` only matter when the signal is enabled.

**Persists nothing by default.** With `--persist`, writes `.swarm/epic/coupling-report.json` atomically inside the project root.

### Learning across waves and epics

Epic Mode learns from its own outcomes (Epic v2 C6; `src/epic/learning.ts`). Everything it learns is **planner analysis only** — it adds conflict edges or exclusivity to `epic_next_wave`'s planning, it never authorizes a write, and the dispatch gate keeps checking every coder against the wave's frozen **declared** scopes.

**From which signals.** The per-task outcomes recorded when a wave closes (see **Divergence** in [the flow](#the-epic_next_wave-flow)):

| Signal | Learned as |
|---|---|
| Undeclared write: a task that declared *D* wrote *f* | a **co-write** w(d → f) += 1 for every d ∈ *D*, and an incident (1.0) on *f* |
| Merge-back failure | 0.5 on every declared file (the merge-status registry records no conflict files) |
| Stage B failure | 0.25 per failure on every declared file |
| Rework | 0.25 × min(generation − 1, 4) on every declared file |
| Reopen | 0.5 per reopen on every declared file |
| Every resolved task | an **exposure** (+1) on every declared file |

"Declared file" means a declared entry that is a file: a directory entry (a directory on disk, or an entry covering another path of the same task) is never charged or exposed, so one troubled `src`-scoped task cannot make everything under `src/` hot. A task run again after a reopen is charged only the **delta** of its counters over its earlier outcome (which the record keeps as `previous`).

**What is learned.**

- **Learned scope expansion.** In the conflict graph a task's scope becomes scope\*(t) = scope(t) ∪ { f : Σ<sub>d∈scope(t)</sub> w(d → f) ≥ 1 }: a task declaring `src/a.ts`, whose earlier tasks also wrote `src/b.ts`, conflicts with a task on `src/b.ts` and the two do not share a wave (they form one component; dense ⇒ `serial-component`). The expansion only **adds** path-conflict edges, so the planner stays stricter than the gate's verdict and every multi-task wave it issues is still provably disjoint (co-change coupling keeps using declared scopes).
- **Decaying hot set.** Per file, incidents α and exposures β with a prior mean of 0.1 and strength 2: r = (0.2 + α) / (2 + α + β). **Strongest-co-writer discount:** when a file's strongest learned co-writer m = max<sub>d</sub> w(d → f) is an active expansion edge (m ≥ 1), the hot predicate counts α' = α − m incidents (else α' = α) — writes one declared file keeps explaining are already handled by scope expansion, which keeps that declarer apart from the file's owners, so they do not also serialize everyone declaring the file. A file is **hot** only on *excess* evidence — α' ≥ 1 and r(α', β) − 0.1 > `hot_excess` — and a task whose declared scope lists a hot file (exact normalized path — a directory scope over it does not count) runs alone (exclusive `hot-file`). One undeclared write from one declarer is therefore expansion, not heat; a file written undeclared by two different declarers is hot (α' = 1, r = 0.4), and so is a declared file with a full incident of merge failures, Stage B failures, rework or reopens; clean exposures cool it again (two exposures ⇒ r = 0.24, no longer hot). The planner, sizing, shaping, `/swarm epic learning` and the scorecard all use this one predicate (`epicHotFiles`).
- **Neutral cold start.** With nothing learned there is no hot file and no expansion: a new project plans exactly as without learning.

**Levels.**

- **Epic posterior** — `.swarm/epic/posterior.json`. `/swarm epic start` copies the project prior into it (the epic record keeps the prior's sha256 as `priorDigest`), and every wave close applies that wave's outcomes **once** (idempotent per wave; an update lost to a crash is caught up by the next one). `epic_next_wave` plans with it, so an epic learns from its own earlier waves.
- **Project prior** — `.swarm/epic-prior/learning.json` (schema `epic-learning-v1`; file paths and numbers only). `/swarm epic close` — completed or abandoned, and the `/swarm close` finalization — merges the epic into it once: prior := decay_per_epic × prior ⊕ this epic's observations, then removes the posterior. An epic that learned nothing leaves the prior untouched (no per-epic decay). `/swarm epic status` and the close report show the inherited prior's digest. It lives outside `.swarm/epic/`, so it **survives `/swarm close`**; the close output says "Project prior kept". The start's sizing dry-run plans with it.

**Decay and bounds.** × `decay_per_epic` (0.7) at every epic close that learned something, and age decay in **whole half-lives**: × 0.5^floor(days since the prior was last written / `half_life_days`) — evidence keeps its full weight for a whole half-life, then halves. Entries below 0.05 are dropped and each level keeps at most 2000 file statistics and 2000 co-writes; beyond that the lowest-mass entries are evicted (the weakest, oldest evidence goes first). A single observed co-write therefore keeps expanding scopes until either a later epic that learned something closes (× 0.7 ⇒ below 1) or 60 days pass; it expands again once it is observed again.

**Inspect and reset.** `/swarm epic learning` shows the settings, the source (the open epic's posterior, the project prior, or a neutral start), the hot files with their evidence, and the strongest co-writes. `/swarm epic prior` shows the stored prior (and any Epic v1 import); `/swarm epic prior reset` previews and prints a single-use confirm token (valid 15 minutes, shared two-step destructive-confirm contract), and `/swarm epic prior reset --confirm=<token>` clears it. An unreadable prior is never overwritten: epics plan without learned signals and closes skip the merge until it is reset.

**Epic v1 migration.** The first `/swarm epic start` with learning enabled imports Epic v1's `.swarm/epic/calibration.json` (`hotModuleAdditions` ⇒ α = 2, i.e. hot) and `.swarm/epic/divergence.jsonl` (the latest record per plan and task: declared ⇒ exposures, undeclared ⇒ incidents + co-writes) once into the project prior and records `importedFrom`; it is never repeated, and a `/swarm epic prior reset` (even of an absent prior) also records a marker that suppresses any later import. Nothing writes those v1 files any more: a `/swarm close` before the first v2 `/swarm epic start` archives them away, so nothing is imported; the retention sweep deletes leftovers after 30 days.

### Caveats

- **Preview, opt-in.** Off by default; every Epic behaviour needs the config gate and an open epic for the current plan.
- **One process.** Turbo switched on in a different OpenCode process is not detectable — do not run Turbo elsewhere on a project with an open epic.
- **Do not rewrite the epic branch** while the epic is open: a plain rebase drops the landing merge commits (`--repair-refs` recovers the task refs, see [Commits](#commits-landing-residue-refs)); keep the epic branch checked out.
- **Do not edit the working tree during a wave**: an edit inside the scope of a running wave's task can be committed as its residue; other tracked edits block the next wave (`dirty-baseline`).
- **Numbers are estimates.** Sizing's *S*<sub>eff</sub> and shaping's ΔS<sub>eff</sub> come from a dry run of the planner, the scorecard's concurrency factor is not a speedup, and the planner regression harness simulates — none of them measures real speed.
- **Learning is analysis only** and starts neutral; a file written undeclared by several different declarers (or with other incidents) turns hot and makes its declarers run alone until clean runs cool it (see [Learning](#learning-across-waves-and-epics)).

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

**How is Epic Mode different from Lean Turbo?**  
Lean Turbo skips per-task Stage B for lane tasks and dispatches through its own runner; Epic never skips per-task QA, has the architect dispatch each wave as visible `Task` calls, lets the delegation gate admit only the active wave, and adds a phase reviewer + critic gate, an epic branch with squash landing, and learning across epics. See [Mode comparison](#mode-comparison).

**How do I tell what mode is active?**  
`/swarm status` shows session modes. `/swarm epic status` shows whether an epic is open, its current wave and its landing state. `/swarm config` shows the resolved `execution_mode`.

---

## Signal-Triggered Architect Modes (distinct from session modes)

The session/project modes above control *how* the swarm executes a plan. Separately, certain `/swarm` commands put the architect into a one-shot **signal-triggered workflow mode** by emitting a `[MODE: X ...]` activation signal that loads a dedicated skill on demand: `deep-dive` → `DEEP_DIVE`, `pr-review` → `PR_REVIEW`, `pr-feedback` → `PR_FEEDBACK`, `design-docs` → `DESIGN_DOCS`, `council` → `COUNCIL`, `issue` → `ISSUE_INGEST`, plus the spec-workflow modes (`specify`, `brainstorm`, `clarify`). These are not session modes and do not change `execution_mode`. See [Architecture Deep Dive — Signal-Triggered Modes](architecture.md#signal-triggered-modes-on-demand-skills) and the [Commands Reference](commands.md).

## Related

- [Commands Reference](commands.md) — `/swarm turbo`, `/swarm full-auto`, `/swarm epic`, `/swarm coupling`, `/swarm status`, `/swarm pr-review`, `/swarm pr-feedback`
- [Configuration](configuration.md) — `execution_mode`, `full_auto.*`, `turbo.lean.*`, `epic.*`
- [Architecture Deep Dive](architecture.md) — QA gates, Stage B, Tier 3, signal-triggered modes
