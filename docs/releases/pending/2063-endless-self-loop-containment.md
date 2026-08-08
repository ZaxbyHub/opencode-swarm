# Endless Self-Loop Containment (#2063)

## What

Closes two reinforcing defects that let an architect or subagent session spin
indefinitely without making progress: gate errors that misdirected recovery
into nonexistent plugin-source paths, and loop containment that was absent for
the architect session and broken for subagent (PRM) sessions.

Gate errors are now self-sufficient:
- `ACCEPTANCE_FIELD_REQUIRED` and `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` no
  longer point at `src/agents/...` paths that do not exist in an installed
  plugin. The coverage-mismatch error now embeds the expected requirement body
  (raw, line-break-preserving, capped) directly in the error text, so an agent
  can paste-and-fix without ever needing to read plugin source.
- Fourteen shipped skills' provenance headers and several instructional
  "see src/…" pointers were reworded to inline, runtime-valid guidance.

New containment machinery (architect session):
- **Gate-denial escalation ladder** (`gate_denial_warn_threshold`,
  `gate_denial_stop_threshold`): repeated denials with the same cause and tool
  now escalate from a "do not retry" warning to a hard STOP directive plus a
  `gate_denial_loop` telemetry event — escalating guidance the agent receives on
  every further attempt, not a mechanical block. Streaks are
  tracked per dispatch target, so a successful `Task` to one subagent does not
  reset an in-progress denial loop against a different one. Denials whose
  message carries no recognizable gate code still warn but never reach the hard
  STOP rung, since that bucket can mix unrelated causes.
- **Execution-stall detector** (`execution_stall_warn_calls`,
  `execution_stall_stop_calls`, `execution_stall_episode_minutes`): an episode
  arms when a subagent dispatch is attempted or a task moves to
  `in_progress`, and a run of non-progress tool calls in that episode now
  escalates to a strong advisory and then a hard denial of read/glob/grep/bash
  (delegation and status tooling always remain allowed). An episode ends either
  after `execution_stall_episode_minutes` of complete tool inactivity **or** as
  soon as the plan has no `in_progress` task left — so a session that closes out
  its last task and moves on to commit, CI, and reporting work is never denied.
- **New hard-denial error codes** (user-visible, leading tokens):
  `SWARM_INTERNALS_OFF_LIMITS` — denies reading the plugin's own installed
  package as a "fix" for a gate error (best-effort, path-resolution-based; does
  not apply inside the opencode-swarm repo itself) — and `EXECUTION_STALL` —
  the hard rung of the execution-stall ladder described above.
- **Runaway-output medium band**: the existing >4000-char runaway-turn
  detector now also counts medium-length (≥200 char), no-tool-call turns
  toward the same counter, but only while an execution-stall episode is armed,
  and with a computable per-session user-message reset (keyed on message id,
  never index) so ordinary conversation is never penalized.
- **No-op detector two-stage ladder**: a second, stronger advisory now fires
  at 2× the existing no-op threshold ("stop investigating; report BLOCKED to
  the user"), latched independently of the first-stage advisory and reset on
  any write or dispatch.

Subagent (PRM) session fixes:
- PRM advisory guidance (`[prm: ...]`) is now delivered to non-architect
  (subagent) sessions, not just the architect, with the same byte-bounded
  backstop.
- Fixed a PRM hard-stop delivery bug where the injected `[HARD STOP]` marker
  could be silently dropped for subagent sessions; hard-stop denial and
  `[HARD STOP]` injection are now two independent one-shot tokens so neither
  consumer disarms the other.

## Why

Two defects reinforced each other into endless self-loops: gate errors sent
agents hunting for nonexistent `src/` files inside an installed plugin package
(there is nothing to find), and no mechanism existed to detect or stop a
session that kept retrying the same denied action or burning tool calls
without progress. Subagent sessions additionally never received PRM's course-
correction guidance at all, and PRM's hard-stop signal could be delivered to
the wrong consumer or dropped.

## Migration

No breaking changes. All new behavior is additive and configurable under the
existing `guardrails` block (`gate_denial_*`, `execution_stall_*`) with
conservative defaults (3/5 denial escalation, 30/60 stall calls, 30-minute
episode lapse). No public API, CLI, or persistence-schema changes.

## Caveats

- The execution-stall detector and internals guard are both best-effort: a
  model cannot be forced to stop generating, and evasive shell forms (`cd`
  chains, wrapper CLIs) can evade the internals guard. Durable coverage for
  evasive spelunking comes from the execution-stall ladder and an
  anti-spelunking prompt-level rule, not the guard alone.
- A CI ratchet (`scripts/check-runtime-src-refs.ts`) now guards against new
  runtime-surfaced `src/...` references in thrown errors, advisories, agent
  prompts, and shipped skills, so this class of misdirection cannot silently
  regress.

Closes: #2063
