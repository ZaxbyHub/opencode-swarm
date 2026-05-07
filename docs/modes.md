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

### Combining Turbo + Full-Auto

Independent. Both can be on simultaneously — Turbo bypasses Stage B gates for qualifying tasks, Full-Auto keeps the architect moving between tasks without prompting you.

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
| Full-Auto | Session | No | User confirmation between interactions | Unattended runs |
| `execution_mode: strict` | Project | Yes | Nothing; adds slop-detector + incremental-verify | Security-critical |
| `execution_mode: balanced` | Project | Yes | Nothing | Default |
| `execution_mode: fast` | Project | Yes | Compaction service | Short sessions |

---

## QA Gate Reference

### `council_mode` (Phase-Level Council)

When enabled, a phase-level council of 5 members (critic, reviewer, sme, test_engineer, explorer) reviews the entire phase's work holistically at `phase_complete` time. Stage B gates (reviewer + test_engineer in parallel) always run per-task — council is additive, never a replacement. Evidence is written to `.swarm/evidence/{phase}/phase-council.json` and validated for verdict, quorum, timestamp, and phase number.

---

## FAQ

**Why is the README's "Strict" mode not a session command?**  
The README table names three safety tiers for readability. In the code, the `execution_mode` config key is the persistent setting (`strict` / `balanced` / `fast`), and `/swarm turbo` is the session-scoped override. There is no `/swarm strict` command.

**Can Turbo break a security review?**  
No. Tier 3 patterns (`auth*`, `crypto*`, `security*.ts`, etc.) always run full review regardless of Turbo. See `src/tools/update-task-status.ts:98-109` for the authoritative list.

**Does Full-Auto bypass the critic?**  
No. Full-Auto v2 *increases* critic involvement: every escalate-class action gets a dedicated read-only critic verification before it executes, and phase boundaries require an APPROVED `full_auto_oversight` evidence record before `phase_complete` will succeed. Reactive intercept verdicts are also mirrored into the v2 evidence pipeline when a durable run is active. See `src/full-auto/oversight.ts` and `src/full-auto/phase-approval.ts` for the dispatch and gate.

**How do I tell what mode is active?**  
`/swarm status` shows session modes. `/swarm config` shows the resolved `execution_mode`.

---

## Related

- [Commands Reference](commands.md) — `/swarm turbo`, `/swarm full-auto`, `/swarm status`
- [Configuration](configuration.md) — `execution_mode`, `full_auto.*`
- [Architecture Deep Dive](architecture.md) — QA gates, Stage B, Tier 3
