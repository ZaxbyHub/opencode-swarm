# Commands Reference

All `/swarm` subcommands available in the current OpenCode Swarm source tree. The authoritative source is `src/commands/registry.ts`; this page explains the user-facing behavior and calls out deprecated aliases.

Commands are grouped by function. Compound commands (e.g., `/swarm config doctor`) resolve the two-word form first, then fall back to the first token.

---

## Claude Code Command Conflicts

Several swarm subcommands share exact names with Claude Code built-in slash commands.
This is a known source of model confusion — AI agents trained on Claude Code may try
to invoke the CC built-in instead of the swarm subcommand.

All swarm commands must use the full `/swarm <subcommand>` form. Never reference a
conflicting swarm subcommand by its bare name when inside a swarm agent context.

| Swarm Command | Conflicts With | Severity | CC Behavior |
|---|---|---|---|
| `/swarm show-plan` | `/plan` | 🔴 CRITICAL | Enters plan mode — Claude proposes before executing |
| `/swarm reset` | `/reset` | 🔴 CRITICAL | Alias for `/clear` — wipes entire conversation |
| `/swarm checkpoint` | `/checkpoint` | 🔴 CRITICAL | Alias for `/rewind` — restores prior conversation state |
| `/swarm status` | `/status` | 🟠 HIGH | Shows Claude version, model, account info |
| `/swarm agents` | `/agents` | 🟠 HIGH | Manages Claude subagent configurations |
| `/swarm config` | `/config` | 🟠 HIGH | Opens Claude Code settings interface |
| `/swarm export` | `/export` | 🟠 HIGH | Exports conversation as plain text |
| `/swarm config doctor` | `/doctor` | 🟠 HIGH | Diagnoses Claude Code installation |
| `/swarm history` | `/history` | 🟡 MEDIUM | Shows Claude Code session history |

For contributors: Adding a new swarm command that matches a CC built-in requires
updating `src/commands/conflict-registry.ts` with an explicit severity and
disambiguation note. The CI test in `src/commands/conflict-registry.test.ts` will
fail until this is done.

---

## Status and Health

### `/swarm status`

Show current swarm state: active phase, task count, and registered agents.

```text
Phase: 2 [IN PROGRESS]
Tasks: 3/5 complete
Agents: 11 registered
```

### `/swarm diagnose`

Run a health check on `.swarm/` files, plan structure, and evidence completeness. Reports missing files, schema mismatches, and recovery steps.

### `/swarm history`

Show completed phases with status icons.

```text
/swarm history
```

### `/swarm agents`

List all registered agents with their model, temperature, read-only status, and guardrail profile.

---

## Plan Management

### `/swarm show-plan [N]`

Display the full `.swarm/plan.md`. With a phase number, show only that phase.

```text
/swarm show-plan      # full plan
/swarm show-plan 2    # Phase 2 tasks only
```

`/swarm plan [N]` remains available as a deprecated alias.

### `/swarm specify [description]`

Generate or import a feature specification from prose. Writes `.swarm/spec.md` using RFC 2119 keywords (MUST / SHOULD / MAY).

### `/swarm clarify [description]`

Refine an existing `spec.md` by clarifying ambiguous requirements.

### `/swarm analyze`

Compare `spec.md` against `plan.md` to find requirement coverage gaps. Useful before running a phase — identifies requirements not covered by any task.

### `/swarm brainstorm [topic]`

Enter architect BRAINSTORM mode: seven-phase planning workflow for new features needing requirement discovery. Sequence: CONTEXT SCAN → DIALOGUE → APPROACHES → DESIGN → SPEC → SELF-REVIEW → GATE SELECTION → TRANSITION.

### `/swarm council <question> [--spec-review]`

Enter architect MODE: COUNCIL — convene a fixed three-agent General Council (`council_generalist`, `council_skeptic`, `council_domain_expert`) for an advisory deliberation. The architect runs a web-search pre-pass and supplies all agents with a RESEARCH CONTEXT block; agents answer in parallel without individual web access. The architect routes any disagreements back for one targeted Round 2 reconciliation, then synthesizes the final answer directly using inline output rules (no separate moderator pass).

| Flag | Effect |
|------|--------|
| `--spec-review` | Switch to single-pass advisory mode. Used by the `council_general_review` QA gate during MODE: SPECIFY to fold council input into a draft spec — no Round 2 deliberation. |

**Prerequisites:** `council.general.enabled: true` and a configured search API key (Tavily or Brave) in `opencode-swarm.json`. The deprecated `members`, `presets`, `moderator`, and `moderatorModel` fields are accepted for compatibility but ignored at runtime. See [Council guide — General Council Mode](council/README.md#general-council-mode) for setup.

**No-args behavior:** prints a usage string. The command never throws on bad input — unsupported legacy preset arguments and injected `[MODE: ...]` headers are silently dropped.

### `/swarm pr-review <pr-url|owner/repo#N|N> [--council] [instructions...]`

Launch a structured deep PR review using multi-lane parallel analysis with independent confirmation and critic challenge.

| Argument | Description |
|----------|-------------|
| `<pr-url>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/42`) |
| `owner/repo#N` | Shorthand format — resolves owner and repo from the reference |
| `N` | Bare PR number — resolves owner and repo from the git remote `origin` |
| `--council` | Enable adversarial multi-model council review variant |
| `[instructions...]` | Optional free text after the PR reference, forwarded to the reviewer as extra focus (e.g. `/swarm pr-review 155 focus on the auth refactor`) |

**URL sanitization:** Enforces `https`-only scheme, blocks `localhost`/private IPs, strips credentials and query strings, enforces max 2048 characters, rejects non-ASCII hostnames. Unknown `--flags` are rejected with an explicit error; trailing non-flag words become instructions.

**Workflow:**
1. **Intent Reconstruction** — Extract obligations from PR body checkboxes, linked issues, commit scopes, test names, and interface changes
2. **Parallel Explorer Lanes** — 6 lanes: correctness, security, dependencies, docs-vs-intent, tests, performance/architecture
3. **Independent Reviewer Confirmation** — Validate each finding with file:line evidence
4. **Critic Challenge** — Adversarial review of HIGH/CRITICAL findings only
5. **Synthesis** — Obligation assessment, findings table, merge recommendation

The architect checks out the PR branch locally before launching explorers and runs the skill's triggered micro-lanes automatically — you no longer need to ask for these by hand.

**Council variant** (`--council`): After standard review, convene a General Council to evaluate review quality and hunt for blind spots. Council findings are supplementary.

**No-args behavior:** prints a usage string. The command never throws on bad input.

### `/swarm pr-feedback [<pr-url|owner/repo#N|N>] [instructions...]`

Ingest and close **known** PR feedback — review comments, requested changes, CI/check failures, merge conflicts, stale branch state, and pasted notes — verifying every claim against source before fixing. This is distinct from `/swarm pr-review`, which discovers *new* findings; `pr-feedback` closes *existing* feedback without running a fresh broad review.

| Argument | Description |
|----------|-------------|
| `<pr-url>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/42`) |
| `owner/repo#N` | Shorthand format — resolves owner and repo from the reference |
| `N` | Bare PR number — resolves owner and repo from the git remote `origin` |
| `[instructions...]` | Optional free text forwarded to the feedback session |
| _(none)_ | No PR reference — a pasted-feedback session; the architect builds the ledger from the current PR/branch and any pasted notes |

**Command forms:**
- `/swarm pr-feedback 155` — close feedback on PR 155 (a bare number is resolved against the `origin` remote of the command's project directory)
- `/swarm pr-feedback owner/repo#155 also fix the lint errors` — PR + extra instructions
- `/swarm pr-feedback` — pasted-feedback session on the current branch
- `/swarm pr-feedback address the review notes about error handling` — a leading token that is *not* shaped like a PR reference is treated as pasted-feedback instructions

A leading token that **is** shaped like a PR reference (bare number, `owner/repo#N`, or URL) but cannot be resolved — for example a bare number when no `origin` remote is reachable — returns an explicit error rather than silently demoting the intended reference to free-text feedback.

**URL sanitization:** identical to `pr-review` — `https`-only, blocks `localhost`/private IPs, strips credentials/query/fragment, rejects non-ASCII hostnames, and strips injected `[MODE: ...]` headers from instructions.

**Workflow** (`MODE: PR_FEEDBACK`, loads `swarm-pr-feedback/SKILL.md`):
1. **Check out the PR branch locally** — fetch the head ref, verify the working tree is clean, then check it out so verification and fixes run against the PR branch
2. **Build the feedback ledger** — collect every feedback surface (review threads, requested-changes reviews, CI failures, conflicts, stale-branch state, PR-body claims, pasted notes) before editing
3. **Verify each claim** — treat every item as a claim until source evidence proves it; classify as CONFIRMED, DISPROVED, PRE_EXISTING, or NEEDS_USER_DECISION
4. **Fix confirmed items** — patch only confirmed items plus the tests/docs they require; do not run a fresh broad review
5. **Closure ledger** — report status for every item, including disproved ones; GitHub review threads are only resolved when you explicitly instruct it

**No-args behavior:** emits a bare `MODE: PR_FEEDBACK` session. The command never throws on bad input.


### `/swarm deep-dive <scope> [--profile <name>] [--max-explorers <n>] [--json] [--skip-update] [--allow-dirty]`

Read-only codebase audit using parallel explorer waves with independent reviewer verification and sequential critic challenge.

| Alias |
|-------|
| `/swarm deep dive` |

**Command forms:**
- `/swarm deep-dive auth` — standard profile (default)
- `/swarm deep-dive src/security --profile security` — security-focused audit
- `/swarm deep-dive "settings page" --profile full --json` — full audit with machine-readable output
- `/swarm deep dive src/hooks --max-explorers 4` — alias form with reduced parallelism

**Workflow:**
1. **Repo Readiness** — verify clean git state (unless `--allow-dirty`)
2. **Scope Resolution** — import proximity grouping with 8-file cap per mission
3. **Explorer Waves** — parallel explorer lanes covering scope mapping, data flow, runtime behavior, UX, security, testing, performance, and documentation
4. **Reviewer Verification** — always 2 parallel reviewers confirm each finding with file:line evidence
5. **Critic Challenge** — sequential adversarial pass on HIGH/CRITICAL findings only
6. **Final Report** — synthesized findings table with severity, category, and remediation guidance

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--profile <name>` | `standard` | Audit profile: `standard`, `security`, `ux`, `architecture`, `full` |
| `--max-explorers <n>` | `6` | Parallel explorer lanes (range: 1–8) |
| `--json` | — | Emit machine-readable JSON output |
| `--skip-update` | — | Skip OpenCode update check before audit |
| `--allow-dirty` | — | Allow audit on dirty git state (uncommitted changes) |

**Profiles:**

| Profile | Focus areas |
|---------|-------------|
| `standard` | General code quality, correctness, and maintainability |
| `security` | Vulnerability patterns, injection risks, secrets exposure |
| `ux` | User experience, accessibility, API ergonomics |
| `architecture` | System design, coupling, extensibility |
| `full` | All focus areas combined |

**Note:** This is a read-only audit. It does not modify source code, create branches, or write to the codebase.

**No-args behavior:** prints a usage string. The command never throws on bad input.

### `/swarm design-docs <description> [--out <dir>] [--lang <name>] [--update]`

Generate or sync structured, language-agnostic design docs for the project under build (issue #1080). Delegates to the `docs_design` agent (a role variant of the docs agent) via `MODE: DESIGN_DOCS`.

**Requires** `design_docs.enabled: true` in `opencode-swarm.json`.

| Alias |
|-------|
| `/swarm design docs` |

**Command forms:**
- `/swarm design-docs "terminal GitHub PR client"` — generate fresh docs under `docs/`
- `/swarm design-docs auth-service --lang rust` — generate with Rust reference docs
- `/swarm design docs --update --out design` — sync existing docs in `design/`

**Generated layout** (under `<out>`, default `docs/`):

| File | Contents |
|------|----------|
| `domain.md` | 100% language-agnostic entities, fields, and domain invariants (IDs `D-###`) |
| `technical-spec.md` | Language-agnostic architecture, contract shapes, invariants, + traceability table (IDs `S-###`) |
| `behavior-spec.md` | Given/When/Then conformance specs (IDs `B-###`) |
| `reference/reference-impl.md` | All language/framework-specific signatures, code, SQL (IDs `R-###`) |
| `reference/idiom-notes.md` | Reference-implementation idiom examples |
| `reference/traceability.json` | Machine-readable section-ID registry (drift source of truth) |
| `design-changelog.md` | Append-only log of design-doc changes (separate from release notes) |

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--out <dir>` | `docs` | Output directory (project-relative) |
| `--lang <name>` | inferred | Target language for `reference/` docs |
| `--update` | — | Sync existing docs to current code/spec instead of generating fresh |

**Drift sync:** when `design_docs.enabled`, `phase_complete` runs a deterministic, non-blocking design-doc drift check (`.swarm/doc-drift-phase-N.json`) and advises a `docs_design` sync when docs fall behind code/spec. Advisory only — never blocks phase completion.

**No-args behavior:** prints a usage string (unless `--update` is given). The command never throws on bad input.

### `/swarm issue <issue-url|owner/repo#N|N> [--plan] [--trace] [--no-repro]`

Ingest a GitHub issue into the swarm workflow for root-cause localization and resolution spec generation.

| Argument | Description |
|----------|-------------|
| `<issue-url>` | Full GitHub issue URL (e.g., `https://github.com/owner/repo/issues/42`) |
| `owner/repo#N` | Shorthand format — resolves owner and repo from the reference |
| `N` | Bare issue number — resolves owner and repo from the git remote `origin` |
| `--plan` | Transition to plan creation after spec generation |
| `--trace` | Run full fix-and-PR workflow (implies `--plan`) |
| `--no-repro` | Skip reproduction verification step |

**URL sanitization:** Enforces `https`-only scheme, blocks `localhost`/private IPs, strips credentials and query strings, enforces max 2048 characters, rejects non-ASCII hostnames.

**Workflow:**
1. **Intake** — Fetch issue body via GitHub CLI, normalize into structured intake note (observed behavior, expected behavior, repro steps, environment)
2. **Localization** — Build 2–5 root-cause hypotheses with composite scoring (stack-trace 0.4, recency 0.25, call-graph 0.2, test-failure 0.15), validate top-3 in parallel, prune to single root cause
3. **Spec Generation** — Output resolution spec with root cause, fix strategy, FR/SC numbering, Given/When/Then scenarios
4. **Transition** — Based on flags: report spec (`no flags`), create plan (`--plan`), or run full fix workflow (`--trace`)

**Flag interactions:** `--trace` implies `--plan`. Both flags can be combined with `--no-repro`.

**No-args behavior:** prints a usage string. The command never throws on bad input.

**Output signal:** Successful execution emits `[MODE: ISSUE_INGEST issue="<sanitized-url>" plan=true trace=true noRepro=true]` with only the flags that were set.

### `/swarm sync-plan`

Force `plan.md` regeneration from the canonical plan ledger when the markdown projection is stale. This can update `.swarm/plan.md`; it does not edit source files.

### `/swarm preflight`

Run preflight automation checks before starting a phase. Validates plan completeness, evidence requirements, and blockers.

---

## Execution Modes

### `/swarm turbo [on|off|lean|standard|status]`

Toggle Turbo Mode for the current session. Supports two strategies:

- **Standard** — skips non-critical QA gates for faster iteration
- **Lean** — parallel lane execution with per-lane reviewer gates and file-lock conflict detection

Session-scoped; resets on new session.

```text
/swarm turbo              # toggle standard turbo
/swarm turbo on           # enable turbo (uses lean when config strategy is lean, otherwise standard)
/swarm turbo off          # disable turbo
/swarm turbo lean on      # enable Lean Turbo explicitly
/swarm turbo lean off     # disable Lean Turbo
/swarm turbo lean         # toggle Lean Turbo explicitly
/swarm turbo standard on  # force standard turbo
/swarm turbo standard off # disable all turbo modes (standard + lean)
/swarm turbo status       # show detailed status
```

Note: `/swarm turbo lean [on|off]` explicitly controls Lean Turbo regardless of the config `turbo.strategy`. Only `/swarm turbo on` consults the config strategy default.

See [Modes Guide](modes.md) for tradeoffs.

### `/swarm full-auto [on|off]`

Toggle Full-Auto Mode. Enables autonomous execution without confirmation prompts. Session-scoped.

---

## Configuration

### `/swarm config`

Show the current resolved plugin configuration (merged global + project + CLI overrides).

### `/swarm config doctor [--fix] [--restore <id>]`

Run config validation and integrity checks. Alias: `/swarm config-doctor` (hyphenated form for TUI shortcut compatibility).

- `--fix`: auto-repair issues where safe. Creates encrypted backup first.
- `--restore <id>`: revert to a previous backup.

### `/swarm doctor tools`

Run tool registration coherence check. Verifies all tools declared in the registry are available at runtime.

### `/swarm qa-gates [show|enable|override] <gate>...`

View or modify QA gate profile for the current plan.

- `show`: display spec-level, session-override, and effective gates.
- `enable`: persist gate(s) into the locked profile. Architect-only. Rejected after critic approval lock.
- `override`: session-only ratchet-tighter enable.

Valid gates: `reviewer`, `test_engineer`, `council_mode`, `sme_enabled`, `critic_pre_plan`, `hallucination_guard`, `sast_enabled`, `mutation_test`, `drift_check`, `council_general_review`, `final_council`.

**Gate descriptions:**

- `council_mode` — Multi-member phase-level council gate. When enabled, council runs at phase completion for holistic review of the full phase body of work. Stage B (reviewer + test_engineer in parallel) always runs per-task regardless. Council is additive — never replaces Stage B.


- `final_council` - Multi-member project-level council gate. When enabled, the last phase requires approved `.swarm/evidence/final-council.json` from the same five phase-council members (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) rerun at project scope. This is not General Council mode and does not use `convene_general_council`.
---

## Evidence and Telemetry

### `/swarm evidence [taskId]`

Show evidence bundles (review results, test verdicts, security findings) for a task. Without `taskId`, lists all tasks with evidence.

```text
/swarm evidence 2.1
```

### `/swarm evidence summary`

Generate an evidence summary showing completion ratio across all tasks, blockers, and missing evidence. Alias: `/swarm evidence-summary`.

### `/swarm archive [--dry-run]`

Archive old evidence bundles. Two-tier retention: age-based (`max_age_days`, default 90) then count-based (`max_bundles`, default 1000). Use `--dry-run` to preview.

### `/swarm benchmark [--cumulative] [--ci-gate]`

Show performance metrics: tool call rates, delegation chains, evidence pass rates.

- `--cumulative`: aggregate across sessions.
- `--ci-gate`: return non-zero exit if thresholds exceeded (for CI).

### `/swarm retrieve <summary-id>`

Load the full tool output that was previously summarized (IDs like `S1`, `S2`). Use when the summary is insufficient and you need the raw data.

---

## Knowledge System

### `/swarm knowledge`

List knowledge entries in `.swarm/knowledge.jsonl`. Filter by category, confidence, or utility.

### `/swarm knowledge migrate`

One-time migration from legacy `.swarm/context.md` SME cache to `.swarm/knowledge.jsonl`. Idempotent — skips if already migrated.

### `/swarm knowledge quarantine <entry-id> [reason]`

Move a knowledge entry to quarantine. Quarantined entries are excluded from agent queries.

### `/swarm knowledge restore <entry-id>`

Restore a quarantined entry back to active knowledge.

### `/swarm memory`

Show memory storage commands.

### `/swarm memory status`

Show the resolved memory provider, SQLite database path, legacy JSONL file status, and the latest migration report.

### `/swarm memory pending`

Show pending memory proposals and recent rejected proposal reasons.

### `/swarm memory recall-log`

Summarize recall usage by agent role and memory ID. Also shows the most-recalled and never-recalled memories.

### `/swarm memory stale`

List expired scratch memories, deleted tombstones, superseded chains, and low-utility memories.

### `/swarm memory compact`

Dry-run compaction for deleted, superseded, and expired scratch memory records. Pass `--confirm` to apply the cleanup. There is no automatic destructive compaction.

### `/swarm memory evaluate`

Run the golden memory recall fixtures. Use `/swarm memory evaluate --json` for a machine-readable report. Custom fixture directories are available through direct CLI execution.

### `/swarm memory export`

Export current memory records and proposals to `.swarm/memory/export/memories.jsonl` and `.swarm/memory/export/proposals.jsonl`.

### `/swarm memory import`

Import `.swarm/memory/memories.jsonl` and `.swarm/memory/proposals.jsonl` into SQLite. Invalid rows are reported with file and line number.

### `/swarm memory migrate`

Run the one-time legacy JSONL to SQLite migration. Original JSONL files are backed up under `.swarm/memory/backups/`, and the migration is marked in SQLite `schema_migrations`.

### `/swarm promote [--category <cat>] [--from-swarm <id>] <text>`

Manually promote a lesson to hive (cross-project) knowledge. Either pass lesson text directly or reference an existing swarm-level lesson by ID.

### `/swarm curate`

Run knowledge curation and review hive promotion candidates. Identifies evergreen lessons for cross-project reuse.

### `/swarm concurrency <set|status|reset>`

Manage the session-scoped runtime concurrency override for plan execution. This requires an active OpenCode session.

```text
/swarm concurrency set 3
/swarm concurrency set max
/swarm concurrency status
/swarm concurrency reset
```

---

## State and Recovery

### `/swarm reset --confirm`

DELETE active swarm state from `.swarm/`, including `plan.md`, `plan.json`, `SWARM_PLAN.*`, `checkpoints.json`, `context.md`, `events.jsonl`, and `summaries/`. Stops background automation and clears in-memory queues. **Requires `--confirm` — without it, shows a warning and a tip to export first.**

### `/swarm reset-session`

Clear only session state (`.swarm/session/state.json` and related files). Preserves plan, evidence, and knowledge. Use when starting a new model/session but continuing the same project.

### `/swarm checkpoint <save|restore|delete|list> <label>`

Named snapshots of `.swarm/` state.

- `save <label>`: create snapshot.
- `restore <label>`: soft-reset to checkpoint.
- `delete <label>`: remove checkpoint.
- `list`: show all checkpoints.

### `/swarm rollback <phase>`

Restore `.swarm/` to a phase checkpoint (`checkpoints/phase-<N>`). Writes a rollback event to `events.jsonl`. Without a phase argument, lists available checkpoints.

### `/swarm finalize [--prune-branches] [--skill-review]`

Idempotent 4-stage project finalization:
1. **Finalize** — write retrospectives for in-progress phases.
2. **Archive** — timestamped bundle of swarm artifacts and evidence.
3. **Clean** — remove active-state files (see below).
4. **Align** — safe git `ff-only` to `main`.

Reads `.swarm/close-lessons.md` for explicit lessons and runs curation.
When close creates knowledge entries, the summary nudges the user to run `skill_improve` or `skill_generate` to compile mature entries into skills.
Use `--skill-review` to run the quota-bounded `skill_improver` in proposal mode for skills and knowledge; failures are advisory and do not block finalization.

**Cleanup scope:** `knowledge.jsonl` is intentionally preserved across finalize
cycles — cumulative project knowledge survives and is not deleted. Deleted files
include `plan.json`, `plan.md`, `plan-ledger.jsonl`, `events.jsonl`, `handoff.*`,
`escalation-report.md`, `knowledge-rejected.jsonl`, `repo-graph.json`,
`doc-manifest.json`, `dark-matter.md`, `telemetry.jsonl`, `swarm.db` (and
shm/wal variants), and the `evidence/`, `session/`, `scopes/`, `locks/`,
`spec-archive/` directories.

**Hive promotion:** During finalize, lessons in `knowledge.jsonl` are evaluated
against a three-route eligibility gate before promotion to hive:
- **Explicit** — `hive_eligible=true` AND ≥3 distinct phases confirmed
- **Fast-track** — entry tagged `hive-fast-track` (bypasses phase count)
- **Age-based** — entry age ≥ `auto_promote_days` (default 90, configurable via
  `knowledge.auto_promote_days` in your project config)

Entries failing all routes are skipped. The `auto_promote_days` threshold is read
from your project's `knowledge.*` config.

`/swarm close [--prune-branches] [--skill-review]` remains available as a deprecated alias.

---

## Session Handoff

### `/swarm handoff`

Prepare state for a clean model switch. Writes `handoff.md` with full session state snapshot (plan progress, decisions, delegation history) for prepending to the next session.

### `/swarm export`

Export the current plan and context as JSON to stdout. Useful for piping to external tools or debugging.

---

## Retrospectives

### `/swarm write-retro <json>`

Write a retrospective evidence bundle for a completed phase. Required JSON fields: `phase`, `summary`, `task_count`, `task_complexity`, `total_tool_calls`, `coder_revisions`, `reviewer_rejections`, `test_failures`, `security_findings`, `integration_issues`. Optional: `lessons_learned` (max 5), `top_rejection_reasons`, `task_id`, `metadata`.

Output: `.swarm/evidence/retro-{phase}/evidence.json`.

---

## Analysis Tools

### `/swarm dark-matter [--threshold <n>] [--min-commits <n>]`

Detect hidden file couplings via co-change NPMI (Normalized Pointwise Mutual Information) analysis of git history. Finds files that change together but aren't obviously related in code.

### `/swarm simulate [--threshold <n>] [--min-commits <n>]`

Dry-run the dark-matter analysis with configurable thresholds. Does not modify state.

### `/swarm acknowledge-spec-drift`

Acknowledge that the spec has drifted from the plan and suppress further warnings. Use after you've reviewed the drift and accepted it.

---

## Compound Command Resolution

When you type a two-word command like `/swarm config doctor`, Swarm tries the compound key first, then falls back to the single-token key. Aliases with hyphens exist for TUI shortcuts (which split on hyphens):

| Command | Alias |
|---------|-------|
| `/swarm config doctor` | `/swarm config-doctor` |
| `/swarm evidence summary` | `/swarm evidence-summary` |

---

## Command Conflicts

Nine swarm commands share names with Claude Code built-in slash commands. Using the bare CC command instead of `/swarm <command>` has different — sometimes destructive — behavior. Swarm shows a ⚠️ warning in help output for these commands, and a CI gate test (`src/commands/conflict-registry.test.ts`) prevents new CRITICAL conflicts from being added without explicit acknowledgment.

### Conflict Registry

| Swarm Command | CC Built-in | Severity | CC Behavior | Swarm Behavior |
|---|---|---|---|---|
| `/swarm show-plan` | `/plan` | CRITICAL | Enters Claude Code plan mode — Claude proposes all actions before executing | Displays the current `.swarm/plan.md` task list |
| `/swarm reset` | `/reset` | CRITICAL | Alias for `/clear` — wipes the entire conversation context window | Clears `.swarm` state files (requires `--confirm` flag) |
| `/swarm checkpoint` | `/checkpoint` | CRITICAL | Alias for `/rewind` — restores conversation and code to a prior state | Manages named swarm project snapshots (save\|restore\|delete\|list) |
| `/swarm status` | `/status` | HIGH | Shows CC version, model, account, and API connectivity | Shows current swarm state: active phase, task counts, registered agents |
| `/swarm agents` | `/agents` | HIGH | Manages Claude Code subagent configurations and teams | Lists registered swarm plugin agents with model, temperature, and guardrail info |
| `/swarm config` | `/config` | HIGH | Opens Claude Code settings interface | Shows the current resolved opencode-swarm plugin configuration |
| `/swarm export` | `/export` | HIGH | Exports the current CC conversation as plain text to a file | Exports the swarm plan and context as JSON to stdout |
| `/swarm doctor` | `/doctor` | HIGH | Diagnoses the CC installation (version, auth, permissions) | Runs health checks on swarm configuration and state files |
| `/swarm history` | `/history` | MEDIUM | Shows CC session history | Shows completed swarm phases with status icons |

### Severity Levels

| Level | Meaning |
|-------|---------|
| **CRITICAL** | Bare CC invocation causes destructive behavior (context wipe, conversation rewind, plan mode block). Always use `/swarm`. |
| **HIGH** | CC invocation does something unrelated to swarm. Confusing but recoverable. |
| **MEDIUM** | CC invocation does something tangentially related. Low risk of confusion. |

### CI Gate

`src/commands/conflict-registry.test.ts` enforces a hard gate: new CRITICAL conflict entries fail the test suite unless the entry is added to an explicit allow-list array in the test. This prevents accidental CRITICAL conflicts from being merged without review.

---

## CLI Invocation

### Inside an OpenCode session

Type `/swarm <subcommand>` in the chat. All commands in this reference work here.

### Standalone CLI

The standalone binary accepts four top-level commands: `install`, `update`, `uninstall`, and `run`. To invoke a registry command from the shell, prefix it with `run`:

```bash
opencode-swarm run status
opencode-swarm run show-plan 2
opencode-swarm run evidence 2.1
```

Session-scoped commands (`turbo`, `full-auto`) require an active session and only work inside an OpenCode session — invoking them via the standalone CLI will fail.

Both routes share the same registry. See `src/commands/registry.ts` for the raw definitions and `src/cli/index.ts` for the standalone dispatcher.

---

## Related Documentation

- [Getting Started](getting-started.md) — first-run walkthrough
- [Modes Guide](modes.md) — Balanced vs Turbo vs Full-Auto tradeoffs
- [Configuration Reference](configuration.md) — all config keys
- [Knowledge System](knowledge.md) — hive vs swarm knowledge
- [Evidence and Telemetry](evidence-and-telemetry.md) — observability
