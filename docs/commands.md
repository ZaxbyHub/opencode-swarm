<!-- GENERATED FILE: docs/commands.md is fully generated from COMMAND_REGISTRY (src/commands/registry.ts) by scripts/generate-commands-docs.ts. Do not hand-edit. Regenerate with: bun run scripts/generate-commands-docs.ts --write -->

# Commands Reference

All `/swarm` subcommands available in the current OpenCode Swarm source tree. The authoritative source is `src/commands/registry.ts`; this page is generated from that registry, so the reference below cannot drift from the shipped commands. Edit the registry, then regenerate with `bun run scripts/generate-commands-docs.ts --write`.

Commands are grouped by function (core, agent, config, diagnostics, utility). Compound commands (e.g., `/swarm config doctor`) resolve the two-word form first, then fall back to the first token. Additional deprecated compatibility aliases (dash-form TUI shortcuts and legacy names) still resolve to their canonical command with a deprecation warning but are intentionally not documented individually.

First-class MODE commands are repo-agnostic. The npm package ships the built-in OpenCode mode skills and materializes private runtime copies under `.swarm/bundled-skills/` before emitting a MODE signal. Native project skill roots (`.opencode/skills/`, `.claude/skills/`, and `.agents/skills/`) remain project-owned and are never overwritten.

## Running commands

- **Inside an OpenCode session:** type `/swarm <subcommand>` in the chat. Session-scoped commands (`turbo`, `full-auto`) require an active session and only work here.
- **Standalone CLI:** `opencode-swarm run <subcommand>` (e.g. `opencode-swarm run status`, `opencode-swarm run show-plan 2`). Both routes share the same registry; see `src/cli/index.ts` for the standalone dispatcher.

## Claude Code Command Conflicts

Several swarm subcommands share exact names with Claude Code built-in slash commands. This is a known source of model confusion — AI agents trained on Claude Code may try to invoke the CC built-in instead of the swarm subcommand. All swarm commands must use the full `/swarm <subcommand>` form; never reference a conflicting swarm subcommand by its bare name inside a swarm agent context.

| Swarm Command | Conflicts With | Severity | CC Behavior |
|---|---|---|---|
| `/swarm show-plan` | `/plan` | CRITICAL | Enters Claude Code plan mode — Claude proposes all actions before executing them |
| `/swarm reset` | `/reset` | CRITICAL | Alias for /clear — wipes the entire conversation context window |
| `/swarm checkpoint` | `/checkpoint` | CRITICAL | Alias for /rewind — restores conversation and code to a prior state |
| `/swarm status` | `/status` | HIGH | Shows Claude Code version, active model, account, and API connectivity |
| `/swarm agents` | `/agents` | HIGH | Manages Claude Code subagent configurations and teams |
| `/swarm config` | `/config` | HIGH | Opens Claude Code settings interface (alias: /settings) |
| `/swarm export` | `/export` | HIGH | Exports the current Claude Code conversation as plain text to a file |
| `/swarm doctor` | `/doctor` | HIGH | Diagnoses the Claude Code installation (version, auth, permissions) |
| `/swarm history` | `/history` | MEDIUM | Shows Claude Code session history |

For contributors: adding a new swarm command that matches a CC built-in requires updating `src/commands/conflict-registry.ts` with an explicit severity and disambiguation note; the CI gate test in `src/commands/conflict-registry.test.ts` fails until this is done.

## Escape Hatches

Two human-only restricted commands exist as escape hatches for wedged mechanical gates. They are documented here — not buried in a category group — because you need them exactly when a workflow is stuck. Both append an audit event to `.swarm/events.jsonl`.

### `/swarm abort-pr-workflow`

Clear a stuck PR_REVIEW/PR_FEEDBACK mechanical gate and stop the auto-resume loop [mode] [reason]

**Args:** `[PR_REVIEW|PR_FEEDBACK] [reason...]`

**Human-only restricted command.** An agent cannot run this command itself through `swarm_command` (`toolPolicy: 'restricted'`); when the situation above applies, the agent asks you to run it in chat (or uses its dedicated tool path).

Human-only escape hatch for an unrecoverable PR_REVIEW or PR_FEEDBACK mechanical gate. When the architect cannot reach complete_pr_workflow — for example a compound `git fetch && git checkout` was rejected as read-only shell syntax, the PR head cannot be fetched, or the working tree is on the wrong branch — running this clears the durable gate state for the current session and stops the auto-resume loop without depending on the trapped model. The agent itself cannot run this command; it must call the abort_pr_workflow tool (or ask you to run this command). Both paths funnel into the same fail-closed abortPrWorkflow hook, which refuses while the workflow is armed for publication or while PR workflow lanes are still in flight. Issue #2108 adds the two audited exits from an armed publication window: the invalidate_pr_feedback_publication tool (change approved content — every approval of the generation is superseded and the full ladder re-runs) and the abort_pr_workflow tool kind "cancel-publication" with cancel_publication: true and a reason (terminal no-publish cancellation; never grants push authority). A plain recovery or force abort never clears an armed window. This human-only force path has exactly one exception to the lane refusal (issue #2251): when the ONLY lanes still blocking are ones past the 30-minute staleness horizon that the liveness probe reports as still running — a lane nothing will ever settle on a schedule — it clears the gate anyway, names exactly which lanes it overrode, and finalizes their delegation records so the session can start a new PR workflow. Those sessions are NOT stopped and their output is NOT collected. A lane with a fresh updatedAt still blocks even under force, and any delegation record that still keeps the session blocked is named in the warning. When checkout preparation preserved a stash, the result instructs the caller to run prepare_pr_workflow_checkout operation=restore after the clear. An audit event is appended to .swarm/events.jsonl.

### `/swarm approve-plan-critic`

Record a MANUAL plan-critic approval to unblock the critic_pre_plan execution gate [reason...]

**Args:** `[reason...]`

**Human-only restricted command.** An agent cannot run this command itself through `swarm_command` (`toolPolicy: 'restricted'`); when the situation above applies, the agent asks you to run it in chat (or uses its dedicated tool path).

Human-only escape hatch for the ratchet-tighter critic_pre_plan execution gate (issue #2012). When the critic already returned APPROVED but the mechanical snapshot recorder failed to persist it (verdict-format mismatch, dispatch-signal miss, or a plan.json read race), an enabled critic_pre_plan gate blocks coder delegation. Running this records a manual plan_critic_gate approval snapshot so the gate unblocks, with a distinct method: "manual_override" audit marker. The agent itself cannot run this command; it must call the approve_plan_critic tool (or ask you to run this command). Both paths funnel into the same forceRecordPlanCriticApproval hook, which requires an active architect session. An audit event is appended to .swarm/events.jsonl. Prefer re-running MODE: CRITIC-GATE first; use this only as an escape hatch when a legitimate APPROVED was lost.

## Core

### `/swarm status`

Show current swarm state (plus background-work health when hooks.background_subagents is enabled)

**Claude Code conflict:** name clash with `/status` — always use the full `/swarm status` form.

### `/swarm show-plan`

Show current plan (optionally filter by phase number)

**Args:** `[phase-number]`

### `/swarm agents`

List registered agents

**Claude Code conflict:** name clash with `/agents` — always use the full `/swarm agents` form.

### `/swarm help`

Show help for swarm commands

**Args:** `[command]`

Without argument, shows full command listing. With argument, shows detailed help for a specific command.

### `/swarm finalize`

Use /swarm finalize to finalize the swarm project and archive evidence

**Args:** `--prune-branches, --skill-review, --dry-run`

Idempotent 4-stage terminal finalization: (1) finalize writes retrospectives for in-progress phases, (2) archive creates timestamped bundle of swarm artifacts and evidence, (3) clean removes active-state files for a clean slate, (4) align performs aggressive git reset --hard to the default remote branch, discarding uncommitted changes and gitignored build artifacts (user-created untracked files are preserved); falls back to a cautious reset that preserves uncommitted changes when the aggressive path cannot proceed. WARNING: alignment discards local changes and gitignored files. Resets agent sessions, delegation chains, and active-agent mappings. Reads .swarm/close-lessons.md for explicit lessons and runs curation. Cleanup: knowledge.jsonl is preserved; plan.json, plan.md, events.jsonl, handoff.*, run-memory.jsonl, and summaries/ are removed. Use --skill-review to run the quota-bounded skill_improver in proposal mode. Use --dry-run to preview what finalize would archive, clean, and align without taking the lock or changing anything.

### `/swarm post-mortem`

Run the post-mortem agent: project-end synthesis, queue triage, and final curation pass

**Args:** `--force, --scope session|project`

Reads .swarm/ evidence (knowledge entries, events, curator digests, proposals, retrospectives, drift reports) and produces a post-mortem report at .swarm/post-mortem-{planId}.md. Idempotent: re-runs skip if report exists unless --force is passed. Use --scope session to limit knowledge event aggregation to the current session; project scope is the default.

### `/swarm handoff`

Prepare state for clean model switch (new session)

Generates handoff.md with full session state snapshot, including plan progress, recent decisions, and agent delegation history. Prepended to the next session prompt for seamless model switches.

## Agent

### `/swarm analyze`

Analyze spec.md vs plan.md for requirement coverage gaps

### `/swarm clarify`

Clarify and refine an existing feature specification

**Args:** `[description-text]`

### `/swarm specify`

Generate or import a feature specification [description]

**Args:** `[description-text]`

### `/swarm brainstorm`

Enter architect MODE: BRAINSTORM — structured seven-phase planning workflow [topic]

**Args:** `[topic-text]`

Triggers the architect to run the brainstorm workflow: CONTEXT SCAN, single-question DIALOGUE, APPROACHES, DESIGN SECTIONS, SPEC WRITE + SELF-REVIEW, QA GATE SELECTION, TRANSITION. Use for new plans where requirements need to be drawn out before writing spec.md / plan.md.

### `/swarm loop`

Enter architect MODE: LOOP — compound-engineering loop: brainstorm → plan → build → review → improve, iterating until done [objective]

**Args:** `<objective> [--max-cycles 1..5] [--autonomy checkpoint|auto] [--depth standard|exhaustive] [--resume]`

Triggers the architect to run the compound-engineering loop defined in .swarm/bundled-skills/loop/SKILL.md: BRAINSTORM (requirements) → PLAN (+ critic gate) → BUILD (execute) → REVIEW (independent reviewer + critic on the diff, report-only) → IMPROVE (phase-wrap retrospective + compounding learning capture), then evaluate stop conditions and loop for another improvement cycle if the objective is unmet and budget remains. Generator and reviewer/critic run in separate contexts; failing assertions must be fixed at the root cause, never weakened, mocked, or skipped. Defense-in-depth stop conditions: objective met, --max-cycles budget (default 3), no-progress/plateau, oscillation, unrecoverable error, or explicit user stop. --autonomy auto (default) runs unattended with hard stops still enforced; --autonomy checkpoint pauses at phase gates for user approval. --depth exhaustive widens exploration. --resume continues an existing loop run from durable .swarm/loop/ state. Distinct from full-auto (a critic gate that intercepts phase completions and high-risk actions for review — it never plans, delegates, or executes; the architect retains all delegation duty) and turbo (parallel lanes within a phase): loop is a user-initiated, gated, compounding workflow.

### `/swarm council`

Enter architect MODE: COUNCIL — multi-model deliberation [question] [--spec-review]

**Args:** `<question> [--spec-review]`

Triggers the architect to convene a three-agent General Council: Generalist (reviewer model), Skeptic (critic model), and Domain Expert (SME model). The architect first runs 1–3 targeted web searches and passes a compiled RESEARCH CONTEXT to all three agents before dispatching them in parallel. Agents deliberate using the NSED peer-review protocol (Round 1 independent analysis, Round 2 MAINTAIN/CONCEDE/NUANCE for disagreements). The architect synthesizes the final answer directly from convene_general_council output. --spec-review switches to single-pass advisory mode for spec review. Requires council.general.enabled: true and a search API key in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project .opencode/opencode-swarm.json overrides.

### `/swarm pr-review`

Launch deep PR review with multi-lane analysis [url] [--council]

**Args:** `<pr-url|owner/repo#N|N> [--council]`

Launches a structured PR review: preserves dirty state, verifies and binds an exact detached PR head, reconstructs PR intent via obligation extraction cascade, computes a depth tier (S/M/L) from the bound merge-base diff, launches the base explorer wave through dispatch_lanes_async (all 6 review dimensions covered on every PR — six singleton lanes at tier L, consolidated owned_workflow_lanes partitions at tiers S/M) while the architect keeps doing non-dependent work, and polls collect_lane_results incrementally. It evaluates an exact 11-row repository-agnostic risk-family ledger, records applicable rows as MATCHED and concretely inapplicable rows as provenance-free NOT_TRIGGERED, always keeps unclassified-risk MATCHED, and dispatches micro work only for MATCHED families (dedicated lanes at tier L, consolidated sweeps at S/M). It then validates findings through independent reviewer confirmation, applies critic challenge to HIGH/CRITICAL findings, and synthesizes only after matched coverage is closed. Failed obligations retry through the same structured async mode and exact PR head; blocking or direct-Task dispatch is not provenance-equivalent, so unclosed matched coverage leaves the review BLOCKED rather than degraded. --council variant fires adversarial multi-model review. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolves against origin remote).

### `/swarm pr-feedback`

Ingest and close known PR feedback (review comments, CI failures, conflicts) [pr] [instructions]

**Args:** `[url|owner/repo#N|N] [instructions...]`

Triggers MODE: PR_FEEDBACK — ingests existing pull-request feedback (review threads, requested changes, CI/check failures, merge conflicts, stale branch state, pasted notes), verifies every claim against source, clusters related problems, fixes confirmed items, validates the branch, and reports closure status for every ledger item. Distinct from /swarm pr-review, which discovers new findings. The PR reference is optional: with none, the architect builds the ledger from the current PR/branch; text after the reference is forwarded as extra instructions. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin).

### `/swarm ci-monitor`

Drive an already-reviewed, approved PR to green and merged (monitor CI, fix, merge) [pr]

**Args:** `<pr-url|owner/repo#N|N>`

Triggers MODE: CI_MONITOR — takes an already human-reviewed, approved PR, exhaustively researches every CI failure, fixes it end-to-end, iterates until all required checks are green (max 5 fix cycles), then merges via `gh pr merge` with no merge-strategy flag. Invoke only after human review is complete; the skill re-verifies reviewDecision: APPROVED and mergeable state before doing anything destructive. Distinct from /swarm pr-subscribe, which passively watches a PR without a merge terminal. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin).

### `/swarm pr subscribe`

Subscribe the current session to PR state-change notifications

**Args:** `<pr-url|owner/repo#N|N>`

Subscribes the current session to PR state-change events for the specified PR. When pr_monitor.enabled is true, the background polling worker detects CI failures, new comments, review state changes (changes requested / approved), merge conflicts and conflict resolutions, and merge/close events — each gated by its pr_monitor notify_* config flag (notify_ci_success defaults to false). Delivery follows pr_monitor.event_delivery: "prompt" (default) wakes the subscribed session with a structured <pr-activity> message; "advisory" queues session-scoped advisories with dedup tokens for the next turn. Subscriptions are idempotent, capped by pr_monitor.max_subscriptions, and agent-callable. Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin). Requires pr_monitor.enabled: true in config.

### `/swarm pr unsubscribe`

Unsubscribe the current session from PR state-change notifications

**Args:** `<pr-url|owner/repo#N|N>`

Unsubscribes the current session from PR state-change events for the specified PR. Removes the active subscription record (idempotent; agent-callable). Supports full GitHub URL, owner/repo#N shorthand, or bare PR number (resolved against origin).

### `/swarm pr status`

Show PR monitor subscription status for the current session

Displays all active PR subscriptions for the current session. Shows PR URL, last checked time, watching status, and error count per subscription. Also shows total active subscriptions across all sessions.

### `/swarm ci-simulate`

Create a temporary merge-result worktree and run CI before merge queue entry

**Args:** `[pr-ref] [--base <ref>]`

Creates a detached temporary worktree under the OS temp dir (swarm-ci-simulate) from the base — an explicit validated --base <ref> when given (stacked/release-branch PRs), otherwise the detected default remote branch (origin/HEAD, init.defaultBranch, origin/main, origin/master, verified to exist) — merges the given PR ref (or the current ref), runs fixed local CI gates (typecheck, lint, build, test), then removes the worktree non-force and prunes metadata. Worktree removal is fail-closed: a blocked or dirty worktree is surfaced, never force-deleted. Intended as a pre-queue merge_group simulation helper.

### `/swarm deep-dive`

Launch deep codebase audit with parallel explorer waves, dual reviewers, and critic challenge [scope]

**Args:** `<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]`

Runs a read-only deep audit of the specified scope using parallel explorer waves (8-file cap per mission, ~3500 line guardrail), always 2 parallel reviewers for verification, and sequential critic challenge on HIGH/CRITICAL findings. Profiles select explorer lanes: standard (5 lanes), security, ux, architecture, full (all 8 lanes). Emits a structured findings report without mutating source code.

### `/swarm deep-research`

Launch a multi-source, fact-checked deep research pass and synthesize a cited report [question]

**Args:** `<question> [--depth standard|exhaustive] [--max-researchers 1..6] [--rounds 1..4] [--brief]`

Runs the orchestrator-worker deep-research protocol: the architect decomposes the question into subtopics, gathers evidence with web_search and web_fetch across up to N iterative rounds, dispatches parallel sme synthesis workers, verifies every claim against cited sources with dual reviewers, challenges high-stakes claims with the critic, and presents a cited report in chat. Read-only — does not mutate source code, delegate to coder, or call declare_scope. Requires council.general.enabled and a search API key.

### `/swarm codebase-review`

Launch codebase-review-swarm for a quote-grounded full-repo or large-subsystem audit

**Args:** `[scope] [--mode phase0|complete|defect|security|correctness|testing|ui|performance|ai-slop|enhancements|custom] [--tracks <list>] [--continue <run-id>] [--json] [--skip-update] [--allow-dirty]`

Runs the codebase-review-swarm workflow: Phase 0 inventory, selected-track depth planning, non-diluting review passes, coverage closure, reviewer validation, critic challenge, and .swarm/review-v8 artifacts. Materializes the bundled skill package if missing, then emits a MODE signal; the architect workflow must not mutate source files.

### `/swarm design-docs`

Generate or sync language-agnostic design docs (domain, technical-spec, behavior-spec, reference/) for the project under build [description]

**Args:** `<description> [--out <dir>] [--lang <name>] [--update]`

Triggers the architect to enter MODE: DESIGN_DOCS — delegates to the docs_design agent to author/sync docs/domain.md, docs/technical-spec.md, docs/behavior-spec.md, and docs/reference/* (plus reference/traceability.json and design-changelog.md). Normative docs are 100% language-agnostic; all framework-specific material is quarantined under reference/. --update syncs existing docs to current code/spec instead of generating fresh. Requires design_docs.enabled: true.

### `/swarm issue`

Ingest a GitHub issue into the swarm workflow [url] [--plan] [--trace] [--no-repro]

**Args:** `<issue-url|owner/repo#N|N> [--plan] [--trace] [--no-repro]`

Triggers the architect to enter MODE: ISSUE_INGEST — ingests a GitHub issue, restructures it into a normalized intake note, localizes root cause through hypothesis-driven tracing, and outputs a resolution spec. --plan transitions to plan creation after spec generation. --trace runs the fix workflow end-to-end (implies --plan); compose commit-pr to publish. --no-repro skips the reproduction step. Supports full GitHub URL, owner/repo#N shorthand, or bare issue number (resolves against origin remote).

## Config

### `/swarm config`

Show current resolved configuration

**Claude Code conflict:** name clash with `/config` — always use the full `/swarm config` form.

#### `/swarm config doctor`

Run config doctor checks

### `/swarm sync-plan`

Ensure plan.json and plan.md are synced

### `/swarm qa-gates`

View or modify QA gate profile for the current plan [enable|override <gate>...]

**Args:** `[show|enable|override] <gate>...`

show: display spec-level, session-override, and effective QA gates for the current plan. enable: persist gate(s) into the locked-once profile (architect; rejected after critic approval lock). override: session-only ratchet-tighter enable. Valid gates: reviewer, test_engineer, council_mode, sme_enabled, critic_pre_plan, hallucination_guard, sast_enabled, mutation_test, phase_council, drift_check, final_council.

### `/swarm auto-proceed`

Toggle or set auto-proceed override for the active session

**Args:** `[on|off]`

Without argument, toggles auto-proceed mode. With "on" or "off", sets the state explicitly.

## Diagnostics

### `/swarm acknowledge-spec-drift`

Acknowledge that the spec has drifted from the plan and suppress further warnings

### `/swarm context-map stats`

Show aggregated context-capsule telemetry stats

### `/swarm doctor tools`

Run tool registration coherence check

### `/swarm diagnose`

Run health check on swarm state

### `/swarm guardrail explain`

Dry-run: show what the guardrails would do to a command or write target (executes nothing)

### `/swarm guardrail reset`

Reset one exact active invocation/action circuit after repair

### `/swarm guardrail-log`

Read the guardrail decision log (use --blocks-only for blocks)

### `/swarm preflight`

Run preflight automation checks

### `/swarm lanes`

List active, awaiting-merge, and conflicted worktree lanes

### `/swarm benchmark`

Show performance metrics [--cumulative] [--ci-gate] [--max-cost-usd <n>] [--gate-audit-run <id>]

**Args:** `--cumulative, --ci-gate, --max-cost-usd <n>, --gate-audit-run <id>`

Exit codes (#2493 review F-14): with --ci-gate, the process exits 0 only when every quality check passes and 1 on any failure, budget breach, or missing evidence — CI-safe by construction. Without --ci-gate the command is informational and always exits 0.

### `/swarm gate-audit`

Run the bounded Tier-1 reviewer/test/SAST/mutation/quality gate matrix

**Args:** `--model <id>, --swarm <id>, --gates <csv>, --tasks <csv>, --runs <n>, --max-concurrency <n>, --max-retries <n>, --max-time-ms <n>, --max-cost-usd <n>, --seed <value>, --run-id <id>, --json`

Runs immutable curated defects only in disposable copies, records unavailable data honestly, and writes versioned results below .swarm/evidence/gate-audit/. Container tasks are unsupported until a safe array-form runner exists.

### `/swarm gate-stats`

Show offline per-model gate catch, false-reject, retry, cost, and reviewer fallback statistics

**Args:** `--json, --min-samples <n>`

### `/swarm review`

Run the independent review model against a selected Git diff

**Args:** `--base <ref>, --range <from..to|from...to>, --working-tree, --json`

Collects one bounded canonical diff, dispatches the configured reviewer in a fresh read-only session, optionally validates eligible HIGH/CRITICAL findings when configured or required by gate mode, and persists the receipt and evidence. With no selector, reviews the default merge-base plus working-tree scope.

### `/swarm costs`

Show per-agent and per-task token/cost telemetry [--json]

**Args:** `--json`

### `/swarm report`

Report swarm observability events from the SQLite query authority [--task <id>] [--session <id>] [--trace <id>] [--run <batchId>] [--since <ISO-8601>] [--json]

**Args:** `--task <id>, --session <id>, --trace <id>, --run <batchId>, --since <ISO-8601>, --json`

Bounded, deterministic query over the observability events store in .swarm/swarm.db (the first run performs a bounded, idempotent legacy-import into the local sink). --run filters the lane/dispatch batch axis (workflow.batchId). Unmatched delegation begins are disclosed, never fabricated into ends. --json emits a schemaVersion-tagged block.

### `/swarm learning`

Show learning metrics and violation trends

**Args:** `--json, --phase <N>`

Computes aggregate learning metrics from knowledge events: violation-rate trends, directive application rates, escalation frequency, per-entry ROI, and never-applied entries. Surfaces a learning summary for the curator digest.

### `/swarm coupling`

Measure plan coupling (p) and rank modules driving conflicts (Epic mode preview)

**Args:** `--phase <n>, --threshold <-1..1>, --min-co-changes <n>, --format markdown|json, --persist`

Computes the coupling coefficient p = (conflicting task pairs) / (total task pairs) over the current plan, using Epic mode's combined path + co-change conflict signal. Surfaces per-module contention and a ranked decoupling roadmap. Read-only: runs independent of `turbo.epic.cochange.enabled` so it can be used as a what-if diagnostic before opting into the runtime signal.

### `/swarm epic`

Toggle Epic Mode (autonomous coupling-aware parallel activation) and inspect its decisions

**Args:** `on | off | status | decide | last | calibration`

Epic Mode is an additive overlay that composes Lean Turbo. When on, the architect follows the transparent decide-then-dispatch wave flow: declare_scope (per pending task) → epic_decide_phase → epic_plan_waves → for each wave in order, dispatch one Task per taskId in the wave, ALL in one assistant message (each concurrent coder appears as a visible subagent the user can click into) → epic_record_divergence. epic_decide_phase computes the plan-wide coupling coefficient p and gates parallel promotion on p + a hot-module check + a greenfield rule. epic_plan_waves partitions promoted phases into ordered concurrent groups (waves) that respect dependency order and scope disjointness. Subcommands: on, off, status, decide (read-only what-if), last (most recent decision from durable evidence log), calibration (Capability D state: learned threshold + hot modules + recent divergent tasks). Bare /swarm epic shows status. Decision rationale persists to .swarm/evidence/epic-promotions.jsonl after every epic_decide_phase invocation.

### `/swarm dark-matter`

Detect hidden file couplings via co-change NPMI analysis

**Args:** `--threshold <number>, --min-commits <number>`

### `/swarm simulate`

Dry-run hidden coupling analysis with configurable thresholds

**Args:** `--threshold <number>, --min-commits <number>`

## Utility

### `/swarm blueprint validate`

Validate a declarative harness blueprint or atomic blueprint patch

**Args:** `<project-relative-json>`

### `/swarm blueprint current`

Show the ledger-derived current harness blueprint projection

### `/swarm blueprint history`

Show bounded hash-verified harness version history

**Args:** `[--limit <1..100>]`

### `/swarm blueprint diff`

Compare two stored harness blueprint versions

**Args:** `<from-version> <to-version>`

### `/swarm blueprint export`

Export a canonical stored harness blueprint

**Args:** `[version]`

### `/swarm harness candidate validate`

Validate an inert harness candidate manifest

**Args:** `<project-relative-json>`

### `/swarm harness candidate show`

Show bounded harness candidate metadata without raw patch content

**Args:** `<candidate-id>`

### `/swarm harness candidate diff`

Show candidate file and blueprint-change metadata without raw patch content

**Args:** `<candidate-id>`

### `/swarm approve-write`

Issue a one-shot session/action/candidate/hash-bound write approval

**Args:** `<target-session-id> skill_improve <candidate-id> <candidate-content-hash> [--generation <n>] [--allowed-path-digest <sha256>]`

### `/swarm history`

Show completed phases summary

**Claude Code conflict:** name clash with `/history` — always use the full `/swarm history` form.

### `/swarm skill-opt`

Governed single-skill optimizer (issue #1822). Proposes, validates, and activates one allowlisted SKILL.md candidate at a time with durable lifecycle, serial control, and manual approval.

**Args:** `plan|run|status|diff|approve|reject|rollback|history <slug> [candidateId] [--json] [--confirm] [--expected-content-hash <hash>] [--models <csv>] [--dry-run]`

Disabled/proposal-only by default. `run` requires skill_opt.enabled=true AND --confirm (consumes a held-out test set). approve/activate/reject/rollback are human-only and require --expected-content-hash to refuse a stale base. Stores append-only lifecycle under .swarm/evolution/skills/<slug>/<candidateId>/.

#### `/swarm skill-opt plan`

Propose an optimization round (dry-run; no mutation, no validation)

**Args:** `<slug> [--json] [--models <csv>]`

#### `/swarm skill-opt run`

Execute the optimization loop (draft→smoke→validate; held-out set is single-use so at most one validation per run). Requires skill_opt.enabled=true and --confirm.

**Args:** `<slug> --confirm [--json] [--models <csv>]`

#### `/swarm skill-opt status`

Show the current candidate lifecycle state

**Args:** `<slug> <candidateId> [--json]`

#### `/swarm skill-opt diff`

Show baseline-vs-candidate diff summary for a candidate

**Args:** `<slug> <candidateId> [--json]`

#### `/swarm skill-opt approve`

Activate a pending candidate (human-only; requires --expected-content-hash)

**Args:** `<slug> <candidateId> --expected-content-hash <hash> [--json]`

#### `/swarm skill-opt reject`

Record a rejection for a candidate (no active-skill mutation)

**Args:** `<slug> <candidateId> [--json]`

#### `/swarm skill-opt rollback`

Restore the pre-activation snapshot (appends a rolled_back event)

**Args:** `<slug> <candidateId> [--json]`

#### `/swarm skill-opt history`

Show the append-only lifecycle event log for a candidate

**Args:** `<slug> <candidateId> [--json]`

### `/swarm export`

Export plan and context as JSON

Exports the current plan and context as JSON to stdout. Useful for piping to external tools or debugging swarm state.

**Claude Code conflict:** name clash with `/export` — always use the full `/swarm export` form.

### `/swarm evidence`

Show evidence bundles [taskId]

**Args:** `<taskId>`

Displays review results, test verdicts, and other evidence bundles for the given task ID (e.g., "2.1").

#### `/swarm evidence summary`

Generate evidence summary with completion ratio and blockers

Generates a summary showing completion ratio across all tasks, lists blockers, and identifies missing evidence.

### `/swarm archive`

Archive old evidence bundles [--dry-run]

**Args:** `--dry-run`

Archives evidence bundles older than max_age_days (config, default 90) or beyond max_bundles cap (config, default 1000). --dry-run previews which bundles would be archived without deleting them. Applies two-tier retention: age-based first, then count-based on oldest remaining.

### `/swarm curate`

Run knowledge curation and hive promotion review

### `/swarm consolidate`

Run quota-bounded skill-improver consolidation and stage skill proposals

**Args:** `--force, --respect-interval, --evaluate`

Runs the same consolidation pass used by scheduled skill_improver trigger points: queue hardening, skill-improver proposal writing, and optional draft-skill generation. It never auto-activates skills. Use --respect-interval to obey the configured cadence instead of forcing a run.

### `/swarm concurrency`

Manage runtime concurrency override for plan execution [set|status|reset]

**Args:** `set <N|preset>, status, reset`

Sets, queries, or clears a session-scoped concurrency override for max_concurrent_tasks during plan execution.
When set, the override takes precedence over the plan's locked execution_profile.max_concurrent_tasks.
The override is session-scoped — it does not modify the plan and is cleared on session reset.

Subcommands:
  concurrency set <N>          — Set session concurrency to N (1-64)
  concurrency set <preset>      — Set to preset: min (1), medium (3), max (8)
  concurrency status            — Show effective concurrency (override, plan baseline, operational effective)
  concurrency reset             — Clear the session concurrency override

Session-scoped — resets on new session.

### `/swarm sdd`

Manage OpenSpec-compatible SDD artifacts and effective spec projection

**Args:** `status|validate|project [--json] [--change <id>] [--dry-run]`

Parent command for spec-driven development artifacts. Use sdd status to inspect .swarm/spec.md plus openspec/ artifacts, sdd validate to validate OpenSpec-compatible deltas, and sdd project to materialize the effective spec into .swarm/spec.md for planning.

#### `/swarm sdd status`

Show OpenSpec-compatible SDD status and effective spec source

**Args:** `[--json]`

#### `/swarm sdd validate`

Validate OpenSpec-compatible artifacts and effective spec projection

**Args:** `[--json] [--change <id>]`

#### `/swarm sdd project`

Materialize the OpenSpec-compatible effective spec into .swarm/spec.md

**Args:** `[--dry-run] [--overwrite] [--json] [--change <id>]`

### `/swarm link`

Tie this worktree to a shared swarm knowledge store [name]

**Args:** `[<name> | status]`

Links the current worktree to a shared knowledge store so multiple swarms working on the same project (e.g. separate git worktrees) pool their lessons instead of each keeping an isolated .swarm/knowledge.jsonl. With no name, ties all worktrees of the same repo via the project hash; with a name, ties any worktrees/repos that use the same name. Existing local lessons are merged (deduped) into the shared store. Use `/swarm link status` to inspect.

#### `/swarm link status`

Show whether this worktree shares knowledge via a link

### `/swarm unlink`

Stop sharing swarm knowledge for this worktree [--no-copy]

**Args:** `[--no-copy]`

Unlinks the current worktree from its shared knowledge store and returns it to a local .swarm/knowledge.jsonl. By default the shared lessons are copied back into the local store (deduped) so nothing is lost; pass --no-copy to skip the copy-back.

### `/swarm promote`

Manually promote lesson to hive knowledge (policy-gated; --force --reason overrides with audit)

**Args:** `--category <category>, --from-swarm <lesson-id>, --applies-to-tools <a,b>, --applies-to-agents <a,b>, --required-actions <a,b>, --forbidden-actions <a,b>, --verification-checks <a,b>, --force --reason <why>, <lesson-text>`

Promotes a lesson to hive knowledge directly (--category) or via an existing swarm lesson (--from-swarm), in one cross-process policy transaction (#1847). A policy failure blocks promotion unless --force --reason "<why>" is given (audited); an entry id alone is not authorization. Requires direct text or --from-swarm. An actionability floor (#1821) needs at least one predicate flag and one scope flag (see args), unless knowledge.promotion_require_actionable=false.

### `/swarm reset`

Clear swarm state files [--confirm]

**Args:** `--confirm (required)`

DELETES plan.md, plan.json, context.md, events.jsonl, run-memory.jsonl, and summaries/ from .swarm/. Stops background automation and clears in-memory queues. SAFETY: requires --confirm flag — without it, displays a warning and tips to export first. Before deleting, auto-backs up the state it removes to .swarm/reset-backups/<timestamp>/ (newest 5 kept) so it can be restored by copying the files back.

**Claude Code conflict:** name clash with `/reset` — always use the full `/swarm reset` form.

### `/swarm reset-session`

Clear session state while preserving plan, evidence, and knowledge

Deletes only .swarm/session/state.json and other session files. Clears in-memory agent sessions, delegation chains, and active-agent mappings. Preserves plan, evidence, and knowledge. Also releases this session's pending knowledge-gate obligations (#2398) and recovers stale coder settlements so dispatches cannot wedge on CODER_DISPATCH_IN_PROGRESS (#2268). Auto-backs up removed files to .swarm/reset-backups/ (newest 5 kept).

### `/swarm recover`

Recover wedged coder settlements [task_id] [--force]

**Args:** `[task_id] [--force]`

Settles stale coder-settlement WALs in .swarm/coder-settlements/ — the CODER_DISPATCH_IN_PROGRESS wedge where a dispatch's completion never fired (issue #2268). Safe mode recovers settlements whose owner process is gone. --force also releases ownership keys held by this process: use only when no dispatch is genuinely running (a late completion then reports CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT, safe to ignore). Never interrupts another live OpenCode process. Also repairs tasks wedged at coder_delegated with unattributed green pre_check evidence — the post-reset TASK_WORKFLOW_STAGE_A_REQUIRED wedge — by writing the missing stage_a_passed transition directly (audit events land in .swarm/events.jsonl); pass [task_id] to scope both phases to one task. Human-only.

### `/swarm rollback`

Restore swarm state or project files to a checkpoint

**Args:** `<phase-number|label|list-number>`

Restores legacy .swarm/ phase checkpoints from checkpoints/phase-<N> when present. Otherwise restores named git checkpoints from .swarm/checkpoints.json by label or list number. Writes rollback event to events.jsonl. Without an argument, lists available checkpoints.

### `/swarm retrieve`

Retrieve full output from a summary <id>

**Args:** `<summary-id>`

Loads the full tool output that was previously summarized (referenced by IDs like S1, S2). Use when you need the complete output instead of the truncated summary.

### `/swarm turbo`

Toggle Turbo Mode strategy for the active session [on|off|lean|standard|epic|status]

**Args:** `on, off, lean, standard, epic, status`

Toggles Turbo Mode for the current session. Supports three strategies:

**Standard turbo** — Bypassed: Stage B (reviewer + test_engineer) for Tier 0-2 tasks; phase_complete Gates 1-5 (completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council). Still enforced: Stage A (lint, imports, pre_check_batch); Tier 3 Stage B; Gate 5b (architecture-supervisor); Gate 6 (final-council); Gate 7 (full-auto).
**Lean turbo** — parallel lane execution with per-lane reviewer gates and file-lock conflict detection. Bypassed: Stage B (reviewer + test_engineer) for Tier 0-2 tasks; phase_complete Gates 1-5 (completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council). Still enforced: Stage A (lint, imports, pre_check_batch); Tier 3 Stage B; Gate 5b (architecture-supervisor); Gate 6 (final-council); Gate 7 (full-auto).
**Epic** — additive overlay above Lean Turbo. Auto-decides per-plan parallel-vs-serial via the coupling coefficient `p` and three gates (p-threshold, hot-module, greenfield). When `/swarm turbo epic on` is selected, Lean Turbo is also enabled — Epic dispatches Lean Turbo when it promotes.

Subcommands:
  turbo on           — enable turbo (uses lean when config turbo.strategy is "lean", otherwise standard)
  turbo off          — disable all turbo modes
  turbo lean on      — enable Lean Turbo explicitly
  turbo lean off     — disable Lean Turbo
  turbo lean         — toggle Lean Turbo on/off
  turbo standard on  — force standard turbo (disables lean even if config says lean)
  turbo standard off — disable all turbo modes (standard + lean)
  turbo epic on      — enable Lean Turbo + Epic Mode together (autonomous decision)
  turbo epic off     — disable both Lean Turbo and Epic Mode
  turbo epic         — toggle Epic Mode (+ Lean Turbo) on/off
  turbo status       — show detailed status including active strategy and lanes

Session-scoped — resets on new session. `/swarm epic` remains as the epic-only toggle that does not also flip Lean Turbo session state.

### `/swarm full-auto`

Control Full-Auto Mode for the active session [on [mode]|off|exit|status|retry-oversight|resume|abort]

**Args:** `on [assisted|supervised|strict], off|exit, status, retry-oversight, resume, abort`

First-class toggle for Full-Auto Mode — a critic gate reviewing escalations on your behalf (the architect still plans and delegates; full-auto never executes tasks itself). No config-level enablement is required: "on" activates immediately (unless full_auto.locked is true in config), "off" disarms the run and returns the session to normal interactive operation, "status" reports the durable run state. An optional mode after "on" overrides full_auto.mode for this run: assisted (critic consulted only on policy escalations), supervised (default — risky/high-impact actions reviewed by the critic), strict (ALL plan mutations reviewed by the critic). While active, the critic answers architect questions and reviews phase boundaries, delegations, and risky actions on your behalf; only ESCALATE_TO_HUMAN verdicts halt the run for your input. `retry-oversight` performs a transport-only health probe for an infrastructure/deadline pause and never replays the denied action. `resume` requires a recent successful matching probe and no active recovery blockers. `abort` terminates the durable run immediately. The run state is durable (.swarm/full-auto-state.json) and survives restarts; toggle with no argument flips the current state.

### `/swarm write-retro`

Write a retrospective evidence bundle for a completed phase <json>

**Args:** `<json: {phase, summary, task_count, task_complexity, ...}>`

Writes retrospective evidence bundle to .swarm/evidence/retro-{phase}/evidence.json. Required JSON: phase, summary, task_count, task_complexity, total_tool_calls, coder_revisions, reviewer_rejections, test_failures, security_findings, integration_issues. Optional: lessons_learned (max 5), top_rejection_reasons, task_id, metadata.

### `/swarm knowledge`

List knowledge entries

#### `/swarm knowledge migrate`

Migrate knowledge entries to the current format

**Args:** `<directory>`

One-time migration from .swarm/context.md SME cache to .swarm/knowledge.jsonl. Skips if sentinel file .swarm/.knowledge-migrated exists, if context.md is absent, or if context.md is empty. Reports entries migrated, dropped (validation/dedup), and total processed.

#### `/swarm knowledge quarantine`

Move a knowledge entry to quarantine <id> [reason]

**Args:** `<entry-id> [reason]`

Moves a knowledge entry to quarantine with optional reason string (defaults to "Quarantined via /swarm knowledge quarantine command"). Validates entry ID format (1-64 alphanumeric/hyphen/underscore). Quarantined entries are excluded from knowledge queries.

#### `/swarm knowledge restore`

Restore a quarantined or archived knowledge entry <id>

**Args:** `<entry-id>`

Restores a quarantined or archived knowledge entry back to the active knowledge store by ID. Dispatches by current status: an 'archived' entry is restored to its pre-archive status; a 'quarantined' entry is restored from the quarantine sidecar. Validates entry ID format (1-64 alphanumeric/hyphen/underscore).

#### `/swarm knowledge hive-quarantine`

Human-only exact-ID quarantine of hive-store entries with backup and rollback

**Args:** `<preview|commit|rollback|status> ...`

Issue #2033 operator maintenance for the machine-global hive knowledge store. `preview <id>[,<id>...]` shows exact candidate IDs with per-line hashes, provenance, status, and a store fingerprint, and issues a short-lived confirmation token. `commit --token <t> [--reason <text>]` writes and hash-verifies a complete backup plus manifest BEFORE any mutation (outside the hive lock), then re-verifies the live store against that backup inside one fast transaction (any drift — concurrent append, entry change, version bump, or duplicate-id ambiguity — aborts with no mutation and cleans up the orphaned backup), moving EXACTLY the selected entries to shared-learnings-quarantined.jsonl, with counts verified afterwards and an honestly-reported automatic restore on failure. `rollback --token <token12> | --latest` restores the exact original bytes idempotently. Selection is exact-ID only — never by text, substring, cohort, age, or blacklist, and never in bulk. Human-only: refused for agents via swarm_command, chat fallback, and the shell guardrail.

#### `/swarm knowledge unactionable`

List unactionable knowledge entries pending hardening

Lists entries from .swarm/knowledge-unactionable.jsonl that failed the actionability gate. Shows pending entries (awaiting next hardening pass) and retire candidates (hardening failed). Use `/swarm knowledge retry-hardening` to reset retire candidates.

#### `/swarm knowledge retry-hardening`

Reset retire candidates for re-hardening [id]

**Args:** `[entry-id]`

Resets the retire_candidate flag on unactionable entries so the next scheduled hardening pass re-attempts LLM enrichment. Without arguments, resets all retire candidates. With an ID prefix, resets only the matching entry.

### `/swarm memory`

Show Swarm memory commands

#### `/swarm memory status`

Show Swarm memory provider, JSONL, and migration status

#### `/swarm memory pending`

Show pending Swarm memory proposals and rejection reasons

**Args:** `--limit <n>`

#### `/swarm memory recall-log`

Summarize Swarm memory recall usage

**Args:** `--limit <n>`

#### `/swarm memory value-log`

Show Swarm memory Q-value and reward updates

**Args:** `--limit <n>`

#### `/swarm memory compact`

Compact deleted, superseded, and expired scratch memories

**Args:** `--confirm`

#### `/swarm memory stale`

List stale and low-utility Swarm memories

**Args:** `--limit <n>`

#### `/swarm memory export`

Export current Swarm memory to JSONL files

#### `/swarm memory evaluate`

Run golden Swarm memory recall evaluation fixtures

**Args:** `--json, --fixtures <directory>`

#### `/swarm memory audit-verify`

Verify the memory audit-log hash chain (tamper detection)

**Args:** `--json`

#### `/swarm memory import`

Import legacy JSONL memory into SQLite

#### `/swarm memory migrate`

Run the one-time legacy JSONL to SQLite migration

#### `/swarm memory consolidation-log`

Summarize recent memory consolidation passes and metrics

**Args:** `--limit <n>`

#### `/swarm memory link`

Share this worktree memory across linked sibling worktrees via the cohort identity (requires memory.link.enabled). Independently opt-in from /swarm link.

**Args:** `[name]`

#### `/swarm memory link status`

Show whether this worktree shares memory via a cohort link

#### `/swarm memory unlink`

Stop sharing memory; copies the cohort memory family back to local .swarm/memory/. The cohort store is never deleted.

**Args:** `[--no-copy]`

### `/swarm checkpoint`

Manage project checkpoints [save|restore|delete|list] <label>

**Args:** `<save|restore|delete|list> <label>`

save: creates named git checkpoint. restore: hard-resets tracked files to the checkpoint. delete: removes named checkpoint metadata. list: shows all checkpoints with timestamps. All subcommands require a label except list.

**Claude Code conflict:** name clash with `/checkpoint` — always use the full `/swarm checkpoint` form.

<!-- end of generated commands reference -->
