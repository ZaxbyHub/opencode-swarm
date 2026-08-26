# Commands Reference

All `/swarm` subcommands available in the current OpenCode Swarm source tree. The authoritative source is `src/commands/registry.ts`; this page explains the user-facing behavior and calls out deprecated aliases.

Commands are grouped by function. Compound commands (e.g., `/swarm config doctor`) resolve the two-word form first, then fall back to the first token.

First-class MODE commands are repo-agnostic. The npm package ships the built-in OpenCode mode skills and materializes private runtime copies under `.swarm/bundled-skills/` before emitting a MODE signal. Native project skill roots (`.opencode/skills/`, `.claude/skills/`, and `.agents/skills/`) remain project-owned and are never overwritten.

---

## Claude Code Command Conflicts

Several swarm subcommands share exact names with Claude Code built-in slash commands.
This is a known source of model confusion â€” AI agents trained on Claude Code may try
to invoke the CC built-in instead of the swarm subcommand.

All swarm commands must use the full `/swarm <subcommand>` form. Never reference a
conflicting swarm subcommand by its bare name when inside a swarm agent context.

| Swarm Command | Conflicts With | Severity | CC Behavior |
|---|---|---|---|
| `/swarm show-plan` | `/plan` | ðŸ”´ CRITICAL | Enters plan mode â€” Claude proposes before executing |
| `/swarm reset` | `/reset` | ðŸ”´ CRITICAL | Alias for `/clear` â€” wipes entire conversation |
| `/swarm checkpoint` | `/checkpoint` | ðŸ”´ CRITICAL | Alias for `/rewind` â€” restores prior conversation state |
| `/swarm status` | `/status` | ðŸŸ  HIGH | Shows Claude version, model, account info |
| `/swarm agents` | `/agents` | ðŸŸ  HIGH | Manages Claude subagent configurations |
| `/swarm config` | `/config` | ðŸŸ  HIGH | Opens Claude Code settings interface |
| `/swarm export` | `/export` | ðŸŸ  HIGH | Exports conversation as plain text |
| `/swarm config doctor` | `/doctor` | ðŸŸ  HIGH | Diagnoses Claude Code installation |
| `/swarm history` | `/history` | ðŸŸ¡ MEDIUM | Shows Claude Code session history |

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

When `hooks.background_subagents` is enabled (default `false`), status additionally renders a
**Background Work** section: delegation counts by status (pending, running,
completed-unconsumed, consumed, stale, cancelled, error, ingestion_error), active coder
reservations with their generation and lease state (active / expired / protected-legacy), the
durable maintenance summary (last ok, last failure, last lock contention), and a
`Source: validated recovery (bounded scan)` provenance label. Corrupt or over-bound stores
render a `⚠ State uncertain: …` line instead of partially-trusted counts. Disabled
configurations see no section and schedule no maintenance.

### `/swarm learning [--json] [--phase N] [--timeout-ms N]`

Show aggregate learning metrics computed from `.swarm/knowledge-events.jsonl` and the knowledge store:

- **Violation trends** â€” per-directive violation rates over 7-day and 30-day windows with trend direction (improving/worsening/stable)
- **Application rates by priority** â€” how often directives are applied when shown, grouped by priority level
- **Escalation activity** â€” auto-escalation frequency over recent windows
- **Entry ROI** â€” per-entry applied/shown/succeeded/failed counts with ROI classification (high/medium/low/unused)
- **Never-applied entries** â€” directives that have never been applied despite being alive for multiple phases
- **Time to first application** â€” median/min/max days from directive creation to first application

A 3-line learning summary is automatically injected into the curator phase digest after each phase.

| Flag | Effect |
|------|--------|
| `--json` | Output metrics as structured JSON in a `[LEARNING_JSON]...[/LEARNING_JSON]` envelope |
| `--phase N` | Set the current phase number for never-applied threshold calculations |
| `--timeout-ms N` | Bound metrics computation time; defaults to 30000 ms |

### `/swarm diagnose`

Run a health check on `.swarm/` files, plan structure, and evidence completeness. Reports missing files, schema mismatches, and recovery steps.

A **Sandbox** health-check line is also reported, showing the detected executor mechanism (bubblewrap / sandbox-exec / native-runner/{mode} with PowerShell wrapper fallback / none), availability, and whether commands are actually being sandboxed (sandboxing / silent pass-through / none). This is advisory only — absence of a sandbox executor never causes a hard failure.

### `/swarm history`

Show completed phases with status icons.

```text
/swarm history
```

### `/swarm agents`

List all registered agents with their model, temperature, read-only status, and guardrail profile.

---

## Guardrails

### `/swarm guardrail explain [--agent <role>] [--scope <path>] [--write <path>...] [--] <command>`

Dry-run guardrail decisions for a shell command or write target — reports what the guardrail system **would** do without executing anything. Agent-callable via `swarm_command`.

**Shell mode** (default — pass a command string after any flags):

```text
/swarm guardrail explain rm -rf node_modules/
/swarm guardrail explain --agent reviewer git push --force origin main
```

Returns: decision (`allow`/`block`), firing rule, resolved scope, and detected write categories.

**Write mode** (`--write`, repeatable — inspect individual file/directory targets):

```text
/swarm guardrail explain --write src/hooks/guardrails.ts --write .swarm/plan.json
```

Returns per-target: decision, firing rule, resolved scope, and zone classification.

**Flags:**

| Flag | Effect |
|------|--------|
| `--agent <role>` | Simulate decisions as if issued by a different agent role (e.g., `reviewer`, `test_engineer`) |
| `--scope <path>` | Simulate decisions scoped to a specific working directory |
| `--write <path>` | Inspect a write target instead of a shell command (repeatable for multiple targets) |
| `--` | Explicit flag terminator — required when `<command>` starts with `--` |

Output is fully advisory and redacted. No side effects, no writes, no process execution.

### `/swarm guardrail-log [--blocks-only]`

Read and print the unified guardrail decision log (`.swarm/session/shell-audit.jsonl`) most-recent-first. Agent-callable via `swarm_command`.

```text
/swarm guardrail-log
/swarm guardrail-log --blocks-only
```

**`--blocks-only`** limits output to block decisions only (`file_write`, `scope_violation`, `destructive_block`). Legacy shell command entries and sandbox wrap/skip entries are excluded.

**Output characteristics:**

- Entries sorted most-recent-first
- Commands and paths are redacted
- Missing log file → friendly message: "No guardrail decisions recorded yet."
- On-demand only — no hot-path cost; reads the log only when invoked

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

Compare `spec.md` against `plan.md` to find requirement coverage gaps. Useful before running a phase â€” identifies requirements not covered by any task.

### `/swarm sdd ...`

Inspect and project OpenSpec-compatible and Spec-Kit spec-driven development artifacts into the Swarm planning contract. `.swarm/spec.md` remains the preferred source when it exists. If it is absent, Swarm builds an effective spec from checked-in `openspec/specs/**/spec.md` and active `openspec/changes/*/specs/**/spec.md` files (or from Spec-Kit `specs/<feature>/spec.md` files when `.specify/` is present). The projected `.swarm/spec.md` includes a scaffold `## Success Criteria` section with placeholder `SC-###` identifiers and `[NEEDS CLARIFICATION]` markers — fill these in with concrete success criteria before planning.

```text
/swarm sdd status             # show .swarm/spec.md plus SDD artifact status
/swarm sdd status --json      # machine-readable status
/swarm sdd validate           # validate the effective spec projection
/swarm sdd validate --change add-login
/swarm sdd project --dry-run  # preview .swarm/spec.md materialization
/swarm sdd project            # write .swarm/spec.md (first projection)
/swarm sdd project --overwrite # overwrite existing .swarm/spec.md (requires --overwrite)
/swarm sdd project --source speckit --feature 001-my-feature  # Spec-Kit projection
```

`openspec/changes/*/tasks.md` is proposal input only. Execution state still lives in `.swarm/plan-ledger.jsonl`; never hand-edit `.swarm/plan.json` or `.swarm/plan.md`.

### `/swarm brainstorm [topic]`

Enter architect BRAINSTORM mode: seven-phase planning workflow for new features needing requirement discovery. Sequence: CONTEXT SCAN â†’ DIALOGUE â†’ APPROACHES â†’ DESIGN â†’ SPEC â†’ SELF-REVIEW â†’ GATE SELECTION â†’ TRANSITION.

### `/swarm council <question> [--spec-review]`

Enter architect MODE: COUNCIL â€” convene a fixed three-agent General Council (`council_generalist`, `council_skeptic`, `council_domain_expert`) for an advisory deliberation. The architect runs a web-search pre-pass and supplies all agents with a RESEARCH CONTEXT block; agents answer in parallel without individual web access. The architect routes any disagreements back for one targeted Round 2 reconciliation, then synthesizes the final answer directly using inline output rules (no separate moderator pass).

When enabled in config, the same General Council advisory flow is also offered by BRAINSTORM before spec writing and by PLAN before `save_plan`, so current council input can inform plan writing before critic review.

| Flag | Effect |
|------|--------|
| `--spec-review` | Switch to single-pass advisory mode. Can be invoked manually to fold council input into a draft spec â€” no Round 2 deliberation. |

**Prerequisites:** `council.general.enabled: true` and a configured search API key (Tavily or Brave) in `opencode-swarm.json`. The deprecated `members`, `presets`, `moderator`, and `moderatorModel` fields are accepted for compatibility but ignored at runtime. See [Council guide â€” General Council Mode](council/README.md#general-council-mode) for setup.

**No-args behavior:** prints a usage string. The command never throws on bad input â€” unsupported legacy preset arguments and injected `[MODE: ...]` headers are silently dropped.

### `/swarm pr-review <pr-url|owner/repo#N|N> [--council] [instructions...]`

Launch a structured deep PR review using multi-lane parallel analysis with independent confirmation and critic challenge.

| Argument | Description |
|----------|-------------|
| `<pr-url>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/42`) |
| `owner/repo#N` | Shorthand format â€” resolves owner and repo from the reference |
| `N` | Bare PR number â€” resolves owner and repo from the git remote `origin` |
| `--council` | Enable adversarial multi-model council review variant |
| `[instructions...]` | Optional free text after the PR reference, forwarded to the reviewer as extra focus (e.g. `/swarm pr-review 155 focus on the auth refactor`) |

**URL sanitization:** Enforces `https`-only scheme, blocks `localhost`/private IPs, strips credentials and query strings, enforces max 2048 characters, rejects non-ASCII hostnames. Unknown `--flags` are rejected with an explicit error; trailing non-flag words become instructions.

**Workflow:**
0. **Phase 0A: Existing Signal Ingestion** - Capture PR comments, review summaries, requested changes, bot findings, CI/check failures, merge conflicts, stale branch state, PR body claims, linked issues, and commit messages in the initial evidence ledger before the explorer lanes run
1. **Intent Reconstruction** â€” Extract obligations from PR body checkboxes, linked issues, commit scopes, test names, and interface changes
2. **Parallel Explorer Lanes** â€” all 6 fixed base lanes launched through deterministic `dispatch_lanes_async` while the architect continues non-dependent PR inspection, then incrementally polled and joined with `collect_lane_results`: correctness, security, dependencies, docs-vs-intent, tests, performance/architecture
3. **Independent Reviewer Confirmation** â€” Validate each finding with file:line evidence
4. **Critic Challenge** â€” Adversarial review of HIGH/CRITICAL findings only
5. **Synthesis** â€” Obligation assessment, findings table, merge recommendation

The architect preserves any dirty tracked and untracked state with `prepare_pr_workflow_checkout`, records the original checkout identity, verifies the authoritative full PR head, and switches to that exact commit in detached mode before binding and launching explorers. It ingests the existing feedback surfaces into the initial ledger and evaluates all 11 repository-agnostic risk families as an exact ledger: applicable rows are `MATCHED`, concrete absence evidence records inapplicable rows as provenance-free `NOT_TRIGGERED`, and `unclassified-risk` always remains `MATCHED`. Only the `MATCHED` set is dispatched; the controller-computed depth tier (S/M/L from the bound diff) decides whether it uses dedicated micro-lanes (tier L) or consolidated sweep lanes with per-family attestation (S/M). OpenCode uses `dispatch_lanes_async` plus `collect_lane_results` for read-only lane fan-out so local models do not need to emit background Agent calls by hand; while lanes run or collect, the architect keeps doing non-dependent work and only blocks with `wait: true` when no independent work remains. Blocking dispatch and direct Task calls are not provenance-equivalent for this workflow; if structured lanes cannot close matched coverage, the review is BLOCKED and surfaced to the user rather than degraded. Lane results expose bounded `output` previews plus `output_ref` for full artifact retrieval; the review protocol retrieves `output_ref` before candidate extraction or routing. After completion or abort clears the gate, `prepare_pr_workflow_checkout` with `operation: "restore"` returns to the recorded branch/HEAD and reapplies the exact preserved stash before the architect returns to the user. When the review ends with actionable findings, it writes a handoff artifact under `.swarm/pr-review/<run_id>/` and stops to ask whether to continue into `/swarm pr-feedback`.

**Council variant** (`--council`): After standard review, convene a General Council to evaluate review quality and hunt for blind spots. Council findings are supplementary.

**No-args behavior:** prints a usage string. The command never throws on bad input.

### `/swarm pr-feedback [<pr-url|owner/repo#N|N>] [instructions...]`

Ingest and close **known** PR feedback â€” review comments, requested changes, CI/check failures, merge conflicts, stale branch state, and pasted notes â€” verifying every claim against source before fixing. This is distinct from `/swarm pr-review`, which discovers *new* findings; `pr-feedback` closes *existing* feedback without running a fresh broad review.

| Argument | Description |
|----------|-------------|
| `<pr-url>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/42`) |
| `owner/repo#N` | Shorthand format â€” resolves owner and repo from the reference |
| `N` | Bare PR number â€” resolves owner and repo from the git remote `origin` |
| `[instructions...]` | Optional free text forwarded to the feedback session |
| _(none)_ | No PR reference â€” a pasted-feedback session; the architect builds the ledger from the current PR/branch and any pasted notes |

**Command forms:**
- `/swarm pr-feedback 155` â€” close feedback on PR 155 (a bare number is resolved against the `origin` remote of the command's project directory)
- `/swarm pr-feedback owner/repo#155 also fix the lint errors` â€” PR + extra instructions
- `/swarm pr-feedback owner/repo#155 continue from .swarm/pr-review/pr-155-20260619203000/feedback-handoff.json` - atomically continue a terminal controller-backed review into feedback
- `/swarm pr-feedback` â€” pasted-feedback session on the current branch
- `/swarm pr-feedback address the review notes about error handling` â€” a leading token that is *not* shaped like a PR reference is treated as pasted-feedback instructions

A leading token that **is** shaped like a PR reference (bare number, `owner/repo#N`, or URL) but cannot be resolved â€” for example a bare number when no `origin` remote is reachable â€” returns an explicit error rather than silently demoting the intended reference to free-text feedback.

**URL sanitization:** identical to `pr-review` â€” `https`-only, blocks `localhost`/private IPs, strips credentials/query/fragment, rejects non-ASCII hostnames, and strips injected `[MODE: ...]` headers from instructions.

**Workflow** (`MODE: PR_FEEDBACK`, loads `swarm-pr-feedback/SKILL.md`):
1. **Attach the exact PR head locally** — activate the gate, use `prepare_pr_workflow_checkout` to preserve dirty tracked and untracked state plus the original checkout identity, fetch and verify the authoritative full head SHA, and check it out. A detached exact-head checkout is a valid Profile-A intake state only: the first bind must promote exactly one safe local tracked branch or remote-tracking ref at that SHA before verification or fixes; zero/ambiguous candidates, a mismatched upstream, dirty state, or a linked-worktree-owned branch fails closed. After terminal completion or abort, run the same tool with `operation: "restore"` to return to the original checkout and reapply the preserved stash
2. **Build the feedback ledger** — collect every feedback surface (review threads, requested-changes reviews, CI failures, conflicts, stale-branch state, PR-body claims, pasted notes, and any `swarm-pr-review` handoff artifact) before editing
3. **Verify each claim** — treat every item as a claim until source evidence proves it; classify as `CONFIRMED`, `PARTIAL`, `DISPROVED`, `PRE_EXISTING`, `NEEDS_MORE_EVIDENCE`, or `NEEDS_USER_DECISION`
4. **Fix confirmed items** — patch only confirmed items plus the tests/docs they require, preserve prior review IDs/provenance from the handoff artifact, and do not run a fresh broad review
5. **Mandatory gates** â€” Stage A always runs exact `git diff --check` and a targeted reproduction/regression plus every concrete workspace/category/source build, typecheck, and lint/format obligation mechanically discovered from the repository; Stage B (independent `reviewer` + `test_engineer`) must then pass on the current diff, followed by the separate reviewer + critic closeout gate. No fix lands and no closure ledger row is marked FIXED until all three gates pass
6. **Closure ledger** â€” report status for every item, including disproved ones; GitHub review threads are only resolved when you explicitly instruct it

**No-args behavior:** emits a bare `MODE: PR_FEEDBACK` session. The exact
`continue from .swarm/pr-review/<run_id>/feedback-handoff.json` form is
mechanically validated and rejects malformed, tampered, or nonterminal
handoffs; other free-text input remains ordinary feedback instructions.

### `/swarm ci-monitor <pr-url|owner/repo#N|N>`

Drive an already human-reviewed, approved PR to green and merged: monitors CI, exhaustively researches and fixes every failure, iterates until all required checks are green (max 5 fix cycles), then merges. Only invoke after human review is complete — the skill re-verifies `reviewDecision: APPROVED` and mergeable state before doing anything destructive. This is the terminal closeout hop for a PR that just needs to get green and merge; distinct from `/swarm pr-subscribe`, which passively watches a PR without a merge terminal.

| Argument | Description |
|----------|-------------|
| `<pr-url>` | Full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/42`) |
| `owner/repo#N` | Shorthand format — resolves owner and repo from the reference |
| `N` | Bare PR number — resolves owner and repo from the git remote `origin` |

**URL sanitization:** identical to `pr-review`/`pr-feedback` — `https`-only, blocks `localhost`/private IPs, strips credentials/query/fragment, rejects non-ASCII hostnames.

**No trailing instructions:** unlike `pr-review`/`pr-feedback`, this command accepts only the PR reference. Any text after it is rejected with an explicit error rather than forwarded — this mode performs a merge and has no review/feedback instructions to act on.

**Workflow** (`MODE: CI_MONITOR`, loads `swarm-ci-monitor/SKILL.md`):
1. **Pre-flight gates** — user named the PR explicitly, `reviewDecision: APPROVED`, and `mergeable: MERGEABLE` with an acceptable `mergeStateStatus`
2. **Monitor → fix loop** (max 5 iterations) — fetch check runs, classify failures, fix, push, wait for the new run
3. **Pre-merge staleness re-check** — re-verify checks, mergeable state, and review approval immediately before every merge attempt
4. **Merge** — `gh pr merge` with no merge-strategy flag, then confirm via the local git object DB (not just the GitHub API response)

**No-args behavior:** prints a usage string. The command never throws on bad input.

### `/swarm deep-dive <scope> [--profile <name>] [--max-explorers <n>] [--json] [--skip-update] [--allow-dirty]`

Read-only codebase audit using parallel explorer waves with independent reviewer verification and sequential critic challenge.

| Alias |
|-------|
| `/swarm deep dive` |

**Command forms:**
- `/swarm deep-dive auth` â€” standard profile (default)
- `/swarm deep-dive src/security --profile security` â€” security-focused audit
- `/swarm deep-dive "settings page" --profile full --json` â€” full audit with machine-readable output
- `/swarm deep dive src/hooks --max-explorers 4` â€” alias form with reduced parallelism

**Workflow:**
1. **Repo Readiness** â€” verify clean git state (unless `--allow-dirty`)
2. **Scope Resolution** â€” import proximity grouping with 8-file cap per mission
3. **Explorer Waves** â€” parallel explorer lanes covering scope mapping, data flow, runtime behavior, UX, security, testing, performance, and documentation
4. **Reviewer Verification** â€” always 2 parallel reviewers confirm each finding with file:line evidence
5. **Critic Challenge** â€” sequential adversarial pass on HIGH/CRITICAL findings only
6. **Final Report** â€” synthesized findings table with severity, category, and remediation guidance

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--profile <name>` | `standard` | Audit profile: `standard`, `security`, `ux`, `architecture`, `full` |
| `--max-explorers <n>` | `6` | Parallel explorer lanes (range: 1â€“8) |
| `--json` | â€” | Emit machine-readable JSON output |
| `--skip-update` | â€” | Skip OpenCode update check before audit |
| `--allow-dirty` | â€” | Allow audit on dirty git state (uncommitted changes) |

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

### `/swarm codebase-review [scope] [--mode <name>] [--tracks <list>] [--continue <run-id>] [--json] [--skip-update] [--allow-dirty]`

Launch the `codebase-review-swarm` skill for a quote-grounded full-repo or large-subsystem audit. This command is repo-agnostic: the plugin ships the skill package, materializes it into `.swarm/bundled-skills/codebase-review-swarm/`, emits a `MODE: CODEBASE_REVIEW` signal in the current project, and then the architect loads the private runtime copy. A repository may define its own native `codebase-review-swarm` skill without collision.

| Alias |
|-------|
| `/swarm codebase review` |

**Command forms:**
- `/swarm codebase-review` - run Phase 0 inventory at repository root, then stop for review-mode selection
- `/swarm codebase-review src/auth --mode security` - run the security-focused review workflow for a subsystem
- `/swarm codebase review "frontend accessibility" --mode ui --json` - alias form with JSON-compatible report blocks
- `/swarm codebase-review --mode custom --tracks "security,testing"` - preselect a custom track set

**Workflow:**
1. **Phase 0 Inventory** - capture repository context, manifests, public surfaces, trust boundaries, tests, UI, AI surfaces, and claims
2. **Review Mode Gate** - stop for user track selection unless the command already preselected tracks and continuing is explicitly authorized
3. **Review Depth Plan** - prove selected tracks receive non-diluted depth
4. **Candidate Generation** - produce quote-grounded candidates only for selected tracks
5. **Reviewer and Critic Validation** - validate candidates, challenge high-risk findings and enhancements
6. **Final Report** - write `.swarm/review-v8/runs/<run_id>/review-report.md` after coverage closure and final critic PASS

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--mode <name>` | `phase0` | Review mode: `phase0`, `complete`, `defect`, `security`, `correctness`, `testing`, `ui`, `performance`, `ai-slop`, `enhancements`, or `custom` |
| `--tracks <list>` | empty | Custom selected tracks or notes for the workflow |
| `--continue <run-id>` | empty | Continue an existing `.swarm/review-v8` run |
| `--json` | markdown | Request JSON-compatible report blocks |
| `--skip-update` | false | Skip the repo update-to-main preflight |
| `--allow-dirty` | false | Allow review to proceed with a dirty git worktree |

**Note:** This is a read-only review workflow. It may write review artifacts under `.swarm/review-v8/`, but it must not mutate source files, create branches, or delegate to coder.

**No-args behavior:** runs Phase 0 inventory for `repository root` and stops for review-mode selection unless the user already selected tracks.

### `/swarm design-docs <description> [--out <dir>] [--lang <name>] [--update]`

Generate or sync structured, language-agnostic design docs for the project under build (issue #1080). Delegates to the `docs_design` agent (a role variant of the docs agent) via `MODE: DESIGN_DOCS`.

**Requires** `design_docs.enabled: true` in `opencode-swarm.json`.

| Alias |
|-------|
| `/swarm design docs` |

**Command forms:**
- `/swarm design-docs "terminal GitHub PR client"` â€” generate fresh docs under `docs/`
- `/swarm design-docs auth-service --lang rust` â€” generate with Rust reference docs
- `/swarm design docs --update --out design` â€” sync existing docs in `design/`

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
| `--update` | â€” | Sync existing docs to current code/spec instead of generating fresh |

**Drift sync:** when `design_docs.enabled`, `phase_complete` runs a deterministic, non-blocking design-doc drift check (`.swarm/doc-drift-phase-N.json`) and advises a `docs_design` sync when docs fall behind code/spec. Advisory only â€” never blocks phase completion.

**No-args behavior:** prints a usage string (unless `--update` is given). The command never throws on bad input.

### `/swarm issue <issue-url|owner/repo#N|N> [--plan] [--trace] [--no-repro]`

Ingest a GitHub issue into the swarm workflow for root-cause localization and resolution spec generation.

| Argument | Description |
|----------|-------------|
| `<issue-url>` | Full GitHub issue URL (e.g., `https://github.com/owner/repo/issues/42`) |
| `owner/repo#N` | Shorthand format â€” resolves owner and repo from the reference |
| `N` | Bare issue number â€” resolves owner and repo from the git remote `origin` |
| `--plan` | Transition to plan creation after spec generation |
| `--trace` | Run the fix workflow end-to-end (implies `--plan`); compose commit-pr to publish |
| `--no-repro` | Skip reproduction verification step |

**URL sanitization:** Enforces `https`-only scheme, blocks `localhost`/private IPs, strips credentials and query strings, enforces max 2048 characters, rejects non-ASCII hostnames.

**Workflow:**
1. **Intake** â€” Fetch issue body via GitHub CLI, normalize into structured intake note (observed behavior, expected behavior, repro steps, environment)
2. **Localization** â€” Build 2â€“5 root-cause hypotheses with composite scoring (stack-trace 0.4, recency 0.25, call-graph 0.2, test-failure 0.15), validate top-3 in parallel, prune to single root cause
3. **Spec Generation** â€” Output resolution spec with root cause, fix strategy, FR/SC numbering, Given/When/Then scenarios
4. **Transition** â€” Based on flags: report spec (`no flags`), create plan (`--plan`), or run the fix workflow end-to-end (compose commit-pr to publish) (`--trace`)

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

- **Standard** â€” skips non-critical QA gates for faster iteration
- **Lean** â€” parallel lane execution with per-lane reviewer gates and file-lock conflict detection

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

### `/swarm loop <objective> [--max-cycles 1..5] [--autonomy checkpoint|auto] [--depth standard|exhaustive] [--resume]`

Run a compound-engineering loop: brainstorm â†’ plan â†’ build â†’ review â†’ improve, iterating until the objective is met or a budget stop condition fires. Each cycle captures learnings so the next is cheaper.

```text
/swarm loop "add rate limiting to the public API"
/swarm loop "harden auth session handling" --depth exhaustive --max-cycles 2
/swarm loop "migrate config loader" --autonomy checkpoint
/swarm loop --resume
```

**Flags:**

| Flag | Values | Default | Effect |
|------|--------|---------|--------|
| `--max-cycles` | `1`â€“`5` | `3` | Outer improvement cycles before budget stop |
| `--autonomy` | `checkpoint`, `auto` | `auto` | `auto` runs unattended with hard stops still enforced; `checkpoint` pauses at phase gates |
| `--depth` | `standard`, `exhaustive` | `standard` | `exhaustive` widens exploration in brainstorm/review phases |
| `--resume` | _(boolean)_ | `false` | Resume the most recent unfinished loop run from `.swarm/loop/<run-id>/state.json` |

**Phases per cycle:** BRAINSTORM (cycle 1) or refinement (cycle 2+) â†’ PLAN (with critic gate) â†’ BUILD (execute) â†’ REVIEW (independent reviewer + separate critic, report-only) â†’ IMPROVE (phase-wrap + learning-capture).

**Stop conditions (defense-in-depth):** objective met, `--max-cycles` budget exhausted, plateau (no meaningful diff), oscillation (reverting prior changes), unrecoverable error, explicit user stop.

**State directory:** `.swarm/loop/<run-id>/` â€” contains `state.json` (loop control: cycle counter, phase, gate outcomes, learnings) and `learnings/` (captured per-cycle knowledge). Implementation progress is derived from git and the plan ledger, not conversation memory.

### `/swarm full-auto [on|off]`

Toggle Full-Auto Mode. A critic gate: the `critic_oversight` agent reviews phase completions, escalations, and high-risk actions in your place; the architect still plans and delegates every task itself. Session-scoped.

### `/swarm auto-proceed [on|off]`

Toggle auto-proceed for phase transitions. When enabled, the swarm skips the "Ready for Phase N+1?" confirmation prompt and advances automatically. Session-scoped â€” resets to the plan's `execution_profile.auto_proceed` default on new sessions.

The effective value is shown to the architect via an injected `AUTO PROCEED STATUS` banner at every phase boundary.

```text
/swarm auto-proceed on    # enable auto-proceed for this session
/swarm auto-proceed off   # disable auto-proceed for this session
```

**Resolution order:** Session override always wins over the plan default. If no session override is set, the plan's `execution_profile.auto_proceed` (default `false`) is used.

**First-boundary nudge:** When auto-proceed is `false` and no session override is set, the architect offers to enable it once per session at the first phase boundary.

**Architect-only:** Only the architect session can call this command. Subagents receive an error.

---

## Configuration

### `/swarm config`

Show the current resolved plugin configuration (merged global + project + CLI overrides).

### `/swarm config doctor [--fix] [--restore <id>] [--quarantine-residue] [--rollback-residue-quarantine[=<batch>]]`

Run config validation and integrity checks. Alias: `/swarm config-doctor` (hyphenated form for TUI shortcut compatibility).

The doctor validates all 62+ top-level schema keys with type checks (string, boolean, number, object). Unknown keys produce warnings with Levenshtein-based typo suggestions. Swarms configuration is hardened: empty `swarms` emits an INFO finding, and path-traversal characters in swarm IDs (`..`, `/`, `\`, `\0`) emit HIGH/ERROR findings. Deprecated config fields (`skill_improver.model`, `skill_improver.fallback_models`, `spec_writer.model`, `spec_writer.fallback_models`) emit INFO findings with migration guidance.

- `--fix`: auto-repair issues where safe. Creates encrypted backup first. When auto-fixable issues are found, the doctor applies fixes and re-runs to confirm resolution.
- `--restore <id>`: revert to a previous backup.
- `--quarantine-residue`: MOVE verified stale atomic-write temp files (registered grammars only; ≥30 min old, git-untracked, unlocked, non-symlink) into a manifest-backed `.swarm/quarantine/<batch>/` directory with sha256 checksums. Nothing is ever deleted; `/swarm finalize --dry-run` previews the same inventory.
- `--rollback-residue-quarantine[=<batch>]`: restore a quarantine batch (default: latest). Idempotent and collision-safe — differing originals are never overwritten.

**Atomic-write residue (issue #2035):** without any flag, the doctor appends a read-only `## Atomic-write Residue` section when residue is found: per-grammar counts, bytes, ages, tracked/lock/symlink signals, and the proposed action per file — all derived from the same shared inventory the close clean stage and close dry-run use.

**Last-run summary:** When run without `--fix`, the command displays a summary of the previous run (if available) showing the timestamp, total findings count, and auto-fixable count before the current findings.

**Startup auto-fix advisory:** On plugin initialization, if `automation.capabilities.config_doctor_on_startup` is enabled, the config doctor runs automatically. If auto-fixable issues are found and `config_doctor_autofix` capability is not enabled, a chat-visible advisory is emitted suggesting `/swarm config doctor --fix`. When autofix is enabled and fixes are applied, a confirmation advisory is shown.

> **Agent vs. human context:** The `--fix` flag is accepted for human-initiated chat commands. For agent-initiated commands, the `tool-policy` layer blocks `--fix` â€” auto-fixing config from agent context is a privileged operation requiring explicit user initiation.

### `/swarm doctor tools`

Run tool registration coherence check. Verifies all tools declared in the registry are available at runtime.

### `/swarm qa-gates [show|enable|override] <gate>...`

View or modify QA gate profile for the current plan.

- `show`: display spec-level, session-override, and effective gates.
- `enable`: persist gate(s) into the locked profile. Architect-only. Rejected after critic approval lock.
- `override`: session-only ratchet-tighter enable.

Valid gates: `reviewer`, `test_engineer`, `council_mode`, `sme_enabled`, `critic_pre_plan`, `hallucination_guard`, `sast_enabled`, `mutation_test`, `drift_check`, `phase_council`, `final_council`.

**Gate descriptions:**

- `council_mode` â€” Per-task council gate. When enabled, replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Stage A still runs. Requires `council.enabled: true` in config.

- `phase_council` â€” Phase-level council gate. When enabled, a full 5-member council reviews all work in a phase holistically at `phase_complete` time. Additive to per-task gates.

- `final_council` â€” Project-level council gate. When enabled, the last phase requires approved `.swarm/evidence/final-council.json` from the full 5-member council (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) â€” NOT the General Council â€” rerun at project scope. Does not use `convene_general_council`.
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

Archive old evidence bundles. Two-tier retention: age-based (`max_age_days`, default 90) then count-based (`max_bundles`, default 1000). When `evidence.cache_max_bytes` or `evidence.cache_max_records` is configured, the command also prunes the `web_search` / `web_fetch` documents cache (`.swarm/evidence-cache/documents.jsonl`); the report then includes a "Documents cache" section. Use `--dry-run` to preview.

### `/swarm benchmark [--cumulative] [--ci-gate] [--max-cost-usd <n>] [--gate-audit-run <id>]`

Show performance metrics: tool call rates, delegation chains, evidence pass rates, and cumulative cost signals.

- `--cumulative`: aggregate across sessions.
- `--ci-gate`: return non-zero exit if thresholds exceeded (for CI).
- `--max-cost-usd <n>`: with `--ci-gate`, fail the benchmark when cumulative telemetry cost exceeds the threshold.
- `--gate-audit-run <id>`: include a stored gate-audit result. With `--ci-gate`, the audit must be complete; its run-scoped exact joins must be sufficient and free of corrupt, malformed, ambiguous, or unjoined truth; every joined Tier-1 regression must be caught; and no joined clean control may be rejected. Cell-provided labels never substitute for ground truth.

### `/swarm gate-audit [options]`

Run the bounded Tier-1 defect and clean-control matrix across reviewer, test-engineer, offline SAST, mutation, and quality gates. The packed corpus contains six canonical mutation-class fixtures and six independently curated Tier-1 defects, each with a green baseline. Each cell runs in a disposable copy, has explicit concurrency/retry/time/cost ceilings, and writes an immutable result below `.swarm/evidence/gate-audit/<run-id>/`.

Use `--model`, `--swarm`, `--gates`, `--tasks`, `--runs`, `--max-concurrency`, `--max-retries`, `--max-time-ms`, `--max-cost-usd`, `--seed`, `--run-id`, and `--json` to bound and identify a run. `--swarm <id>` selects prefixed reviewer/test-engineer agents when multiple swarms are registered. If a cost ceiling is requested while a provider does not report cost, the run is inconclusive rather than silently treating the cost as zero.

### `/swarm gate-stats [--json] [--min-samples <n>]`

Aggregate stored audit cells by model and gate using exact run/task/candidate/model/gate/repetition ground-truth joins. Reports catch and clean-control false-rejection rates with Wilson confidence intervals, malformed/ambiguous/unjoined history, retries, unavailable cost, infrastructure failures, and reviewer-gate fallback versus genuine evidence telemetry. See [Evaluation Substrate](evaluation-substrate.md).

### `/swarm review [--base <ref> | --range <from..to|from...to> | --working-tree] [--json]`

Run the same bounded, read-only whole-diff engine used by automatic phase review. The command creates a fresh reviewer session, parses structured findings, independently validates eligible anchored HIGH/CRITICAL findings when configured (or required by gate mode), and persists both the review receipt and evidence.

- No selector: review the merge base of the resolved default branch through the current tracked working tree, plus safe untracked text files.
- `--base <ref>`: compute the merge base of `<ref>` and `HEAD`, then include current tracked and safe untracked working-tree changes.
- `--range <from..to>` or `--range <from...to>`: review that exact committed-only Git range; uncommitted and untracked changes are excluded.
- `--working-tree`: review tracked changes from `HEAD` plus safe untracked text files.
- `--json`: return the bounded structured result inside `[SWARM_REVIEW_JSON]` markers.

Exactly one selector is accepted. Refs are validated before they reach Git, all Git calls are bounded and non-interactive, and unsafe, binary, symlink/reparse, unreadable, or oversized untracked files are represented as explicit scope caveats. The human output includes scope completeness/hash, validation state, model calls, observed cost data, receipt/evidence paths, and severity-ranked findings.

This is a local diff-review command. Use `/swarm pr-review` for the formal multi-lane pull-request review workflow.

### `/swarm costs [--json]`

Show per-agent, per-task, per-gate, and per-retry-loop token and cost totals from `.swarm/telemetry.jsonl`.

- Reported provider costs are used when present.
- Estimated costs require `pricing.models` entries in config.
- Existing telemetry without token/cost fields is counted with `cost_source: "unavailable"`.
- `--json`: return the raw summary inside a `[COSTS_JSON]` block.

### `/swarm retrieve <summary-id>`

Load the full tool output that was previously summarized (IDs like `S1`, `S2`). Use when the summary is insufficient and you need the raw data.

Dispatch lane output uses separate opaque `output_ref` values returned by
`dispatch_lanes`, `dispatch_lanes_async`, and `collect_lane_results`. Agents with
access use `retrieve_lane_output` to page through those full lane artifacts; `/swarm
retrieve` remains for summary IDs only.

---

## Knowledge System

### `/swarm knowledge`

List knowledge entries in `.swarm/knowledge.jsonl`. Filter by category, confidence, or utility.

### `/swarm knowledge migrate`

One-time migration from legacy `.swarm/context.md` SME cache to `.swarm/knowledge.jsonl`. Idempotent â€” skips if already migrated.

### `/swarm knowledge quarantine <entry-id> [reason]`

Move a knowledge entry to quarantine. Quarantined entries are excluded from agent queries.

### `/swarm knowledge restore <entry-id>`

Restore a quarantined or archived entry back to active knowledge. Dispatches by current status: an `archived` entry is restored to its pre-archive status; a `quarantined` entry is restored from the quarantine sidecar.

### `/swarm memory`

Show memory storage commands.

### `/swarm memory status`

Show the resolved memory provider, SQLite database path, legacy JSONL file status, and the latest migration report.

### `/swarm memory pending`

Show pending memory proposals, recent rejected proposal reasons, and promotion candidates (session memories eligible for promotion to durable storage under the recall learning loop).

### `/swarm memory recall-log`

Summarize recall usage by agent role and memory ID. Also shows the most-recalled and never-recalled memories.

### `/swarm memory value-log`

Show recent memory Q-values, reward outcomes, suppression candidates, and promotion candidates.

### `/swarm memory stale`

List expired scratch memories, deleted tombstones, superseded chains, low-utility memories, and low-Q-value memories (suppression candidates under the recall learning loop).

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

### `/swarm promote [--category <cat>] [--from-swarm <id>] [actionability flags] <text>`

Manually promote a lesson to hive (cross-project) knowledge. Either pass lesson text directly or reference an existing swarm-level lesson by ID.

Promotion is policy-gated. Since #1821 the policy includes an **actionability floor**, enforced by default: a lesson is only promotable if it carries at least one *predicate* and at least one *scope*. Pass them with these comma-separated flags (they may also be repeated):

| Flag | Kind |
| --- | --- |
| `--required-actions <a,b>` | predicate |
| `--forbidden-actions <a,b>` | predicate |
| `--verification-checks <a,b>` | predicate |
| `--applies-to-tools <a,b>` | scope |
| `--applies-to-agents <a,b>` | scope |

A lesson that fails the floor is blocked rather than silently promoted as un-actionable advice. `--force --reason "<why>"` still overrides and records a durable audited override listing the failed gates. To disable the floor entirely, set `knowledge.promotion_require_actionable = false`.

### `/swarm curate`

Run knowledge curation and review hive promotion candidates. Identifies evergreen lessons for cross-project reuse. When invoked from an active session, this also runs an on-demand `CURATOR_PHASE` pass, applies returned knowledge recommendations through the existing curator update gate, and reports applied/skipped counts.

### `/swarm post-mortem [--force] [--scope session|project]`

Run the curator post-mortem agent over recorded `.swarm/` evidence and write `.swarm/post-mortem-{planId}.md`. The report includes the improvement agenda, final curation pass, proposal queue triage, drift summary, and an architect-facing summary.

By default the command is project-scoped. Use `--scope session` to limit knowledge event aggregation to the active session; use `--force` to regenerate an existing report for the same plan ID.

### `/swarm consolidate [--force] [--respect-interval] [--evaluate]`

Run quota-bounded skill-improver consolidation. This drains the same bounded
skill/knowledge maintenance passes used by scheduled consolidation, writes a
skill-improver proposal, and may draft generated skill proposals when
`skill_improver.write_mode` is `draft_skills`. It never auto-activates skills.

By default the command forces a run while still respecting
`skill_improver.enabled` and daily quota. Use `--respect-interval` to obey
`skill_improver.consolidation_interval_hours`; use `--evaluate` to validate any
drafted skills against `.swarm/skills/evals/<slug>/*.json` before writing them.

### `/swarm concurrency <set|status|reset>`

Manage the session-scoped runtime concurrency override for plan execution. This requires an active OpenCode session.

```text
/swarm concurrency set 3
/swarm concurrency set max
/swarm concurrency status
/swarm concurrency reset
```

---

### `/swarm lanes [--json]`

Show the current worktree lane state: active lanes (running), awaiting-merge lanes (completed but not yet merged back), and conflicted lanes (merge failures).

```text
/swarm lanes
```

**Output (human-readable):**
```
## active (1)
  - lane-1 task=1.1 branch=swarm-lane/session-abc/lane-1
    worktree=<project-root>/.swarm-worktrees/session-abc/lane-1

## awaiting-merge (1)
  - lane-2 task=1.2 branch=swarm-lane/session-def/lane-2 [partial @ commit]
    worktree=<project-root>/.swarm-worktrees/session-def/lane-2
    hint: Merge-back in progress; check `/swarm status` for the latest.

## conflicted (1)
  - lane-3 task=1.3 branch=swarm-lane/session-ghi/lane-3
    worktree=<project-root>/.swarm-worktrees/session-ghi/lane-3
    hint: Partial merge preserved at <project-root>/.swarm-worktrees/session-ghi/lane-3. Stage and commit, then re-run merge.

Total: 3 lanes
```

**Output (`--json`):**
```json
{
  "lanes": [
    {
      "state": "active",
      "laneId": "lane-1",
      "branch": "swarm-lane/session-abc/lane-1",
      "worktreePath": "<project-root>/.swarm-worktrees/session-abc/lane-1",
      "taskId": "1.1",
      "planTaskId": "1.1.1",
      "parentSessionID": "session-abc",
      "mergeStrategy": "rebase",
      "recoveryHint": ""
    },
    {
      "state": "awaiting-merge",
      "laneId": "lane-2",
      "branch": "swarm-lane/session-def/lane-2",
      "worktreePath": "<project-root>/.swarm-worktrees/session-def/lane-2",
      "taskId": "1.2",
      "planTaskId": "1.2.1",
      "parentSessionID": "session-def",
      "mergeStrategy": "merge",
      "recoveryHint": "Merge-back in progress; check `/swarm status` for the latest."
    },
    {
      "state": "conflicted",
      "laneId": "lane-3",
      "branch": "swarm-lane/session-ghi/lane-3",
      "worktreePath": "<project-root>/.swarm-worktrees/session-ghi/lane-3",
      "taskId": "1.3",
      "parentSessionID": "",
      "mergeStrategy": "merge",
      "mergeOutcome": {
        "outcome": "partial",
        "stage": "commit",
        "message": "merge-back committed with conflicts"
      },
      "recoveryHint": "Partial merge preserved at <project-root>/.swarm-worktrees/session-ghi/lane-3. Stage and commit, then re-run merge."
    }
  ],
  "totalCount": 3
}
```

**Lane lifecycle:**

| State | Meaning |
|-------|---------|
| Active | Lane is currently running with an active session |
| Awaiting merge | Lane work is complete but the branch has not yet been merged back into the main branch |
| Conflicted | Merge-back was attempted but encountered conflicts; the worktree and branch are preserved for recovery |

#### Runtime profile state

When `runtime_isolation` is enabled (FR-201), each active lane has a **lane runtime profile** — a set of derived environment variables written to `.swarm/lanes/{laneIndex}.env` (KEY=VAL format) in the worktree root. Any child process spawned inside the lane can source this file to get lane-specific overrides. Only selected git spawns consume the file via `readLaneEnvFileFromDiskSync`; callers must explicitly read it and pass the values to spawn calls via `envOverrides`.

The profile contains:

- `PORT` — derived from `port_base + laneIndex * port_stride`
- `env_overrides` — custom variable overrides from the config
- `cache_redirects` — redirected cache paths (e.g. `XDG_CACHE_HOME`)

When `runtime_isolation.enabled` is `false` (the default), no profile is written and no environment changes are injected — zero behavior change for existing setups.

The `/swarm diagnose` command reports the detected sandbox mechanism (Linux: `bubblewrap`; macOS: `sandbox-exec`; Windows: `native-runner/{mode}` with `powershell wrapper` fallback) and whether sandboxing is actually active or silently degraded to env+port only.

See [Runtime Isolation](modes.md#runtime-isolation-fr-201--fr-206) for the full description, cross-platform parity notes, and configuration examples.

See [Recovery Runbook](troubleshooting/recovery-guide.md) for manual recovery steps when lanes are stuck in conflicted state.

---

## State and Recovery

### `/swarm reset --confirm`

DELETE active swarm state from `.swarm/`, including `plan.md`, `plan.json`, `SWARM_PLAN.*`, `checkpoints.json`, `context.md`, `events.jsonl`, `run-memory.jsonl`, and `summaries/`. Stops background automation and clears in-memory queues. **Requires `--confirm` â€” without it, shows a warning.** Before deleting, the state it removes is auto-backed up to `.swarm/reset-backups/<timestamp>/` (newest 5 kept); restore by copying the files back into `.swarm/`.

### `/swarm reset-session`

Clear only session state (`.swarm/session/state.json` and related files). Preserves plan, evidence, and knowledge. Use when starting a new model/session but continuing the same project. Also recovers stale coder settlements (issue #2268): a `DISPATCHED` settlement WAL left behind by a dispatch whose completion never arrived is settled here, so future coder dispatches cannot stay wedged with `CODER_DISPATCH_IN_PROGRESS`. Before deleting, the session state is auto-backed up to `.swarm/reset-backups/<timestamp>/` (newest 5 kept).

### `/swarm recover [task_id] [--force]`

Settle stale coder-settlement WALs in `.swarm/coder-settlements/` — the `CODER_DISPATCH_IN_PROGRESS` / `CODER_SETTLEMENT_IN_PROGRESS` wedge class where a dispatch completed but its settlement never fired (host killed mid-dispatch, cancelled Task, gate denial; issue #2268). Safe mode recovers settlements whose owning process is gone. `--force` additionally releases ownership keys still held by this process — only use it when no coder dispatch is genuinely still running; a still-running dispatch's late completion will then report `CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT` (safe to ignore, the settlement is already durably recovered). Never interrupts a dispatch owned by another live OpenCode process. Human-only: agents self-heal dead-owner settlements via `update_task_status`. `/swarm diagnose` reports non-terminal settlements with the exact remediation.

### `/swarm checkpoint <save|restore|delete|list> <label>`

Named git checkpoints for project files.

- `save <label>`: create checkpoint.
- `restore <label>`: hard-reset tracked project files to checkpoint.
- `delete <label>`: remove checkpoint.
- `list`: show all checkpoints.

### `/swarm rollback <phase|label|number>`

Restore legacy `.swarm/` phase checkpoints (`checkpoints/phase-<N>`) when present. Otherwise restore named git checkpoints from `.swarm/checkpoints.json` by label or list number. Writes a rollback event to `events.jsonl`. Without an argument, lists available checkpoints.

### `/swarm finalize [--prune-branches] [--skill-review] [--dry-run]`

Idempotent 4-stage project finalization:
1. **Finalize** â€” write retrospectives for in-progress phases.
2. **Archive** â€” timestamped bundle of swarm artifacts and evidence.
3. **Clean** â€” remove active-state files (see below).
4. **Align** â€” aggressive alignment to the default remote branch via `git reset --hard` plus `git clean -fd`, discarding uncommitted changes and untracked files; falls back to a cautious reset that preserves uncommitted changes when the aggressive path cannot proceed.

Reads `.swarm/close-lessons.md` for explicit lessons and runs curation.
Finalize also runs the curator post-mortem when curator postmortems are enabled; existing reports are reused unless regeneration is forced through `/swarm post-mortem --force`.
When close creates knowledge entries, the summary nudges the user to run `skill_improve` or `skill_generate` to compile mature entries into skills.
Use `--skill-review` to run the quota-bounded `skill_improver` in proposal mode for skills and knowledge; failures are advisory and do not block finalization.
Use `--force` to label the run as a forced closure and adjust the retrospective wording; finalize does not otherwise gate on in-progress phases (there is no active-work guard to bypass).
Use `--dry-run` to preview what finalize would archive, clean, and align — it takes no lock and changes nothing.

**Cleanup scope:** `knowledge.jsonl` is intentionally preserved across finalize
cycles â€” cumulative project knowledge survives and is not deleted. Deleted files
include `plan.json`, `plan.md`, `plan-ledger.jsonl`, `events.jsonl`, `handoff.*`,
`escalation-report.md`, `knowledge-rejected.jsonl`, `run-memory.jsonl`,
`repo-graph.json`,
`doc-manifest.json`, `dark-matter.md`, `telemetry.jsonl`, `swarm.db`, generated
`post-mortem-*.md` reports, `drift-report-phase-*.json`, and the `evidence/`,
`session/`, `scopes/`, `spec-archive/` directories. The SQLite WAL sidecars
`swarm.db-shm`/`swarm.db-wal` are intentionally preserved (transient internals
SQLite recreates on next open); `locks/` is not cleaned (per-run locks are
managed via proper-lockfile).

**Hive promotion:** During finalize, lessons in `knowledge.jsonl` are evaluated
against a three-route eligibility gate before promotion to hive:
- **Explicit** â€” `hive_eligible=true` AND â‰¥3 distinct phases confirmed
- **Fast-track** â€” entry tagged `hive-fast-track` (bypasses phase count)
- **Age-based** â€” entry age â‰¥ `auto_promote_days` (default 90, configurable via
  `knowledge.auto_promote_days` in your project config)

Entries failing all routes are skipped. The `auto_promote_days` threshold is read
from your project's `knowledge.*` config.

`/swarm close [--prune-branches] [--skill-review] [--dry-run]` remains available as a deprecated alias.

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

| Command | Alias | Notes |
|---------|-------|-------|
| `/swarm config doctor` | `/swarm config-doctor` | |
| `/swarm evidence summary` | `/swarm evidence-summary` | |
| `/swarm pr subscribe` | `/swarm pr-subscribe` | TUI shim (deprecated). Agent-callable via `swarm_command`: subscriptions are idempotent and capped by `pr_monitor.max_subscriptions`, so the agent may subscribe itself (e.g. right after creating a PR). |
| `/swarm pr unsubscribe` | `/swarm pr-unsubscribe` | TUI shim (deprecated). Agent-callable via `swarm_command`. |
| `/swarm pr status` | `/swarm pr-status` | TUI shim (deprecated). In a session (TUI/chat) it is session-scoped; the `bunx opencode-swarm run pr status` CLI has no session context and lists all sessions. |
| `/swarm sdd status` | `/swarm sdd-status` | TUI shim (deprecated) |
| `/swarm sdd validate` | `/swarm sdd-validate` | TUI shim (deprecated) |
| `/swarm sdd project` | `/swarm sdd-project` | TUI shim (deprecated) |
| `/swarm memory status` | `/swarm memory-status` | TUI shim (deprecated) |
| `/swarm memory export` | `/swarm memory-export` | TUI shim (deprecated) |
| `/swarm memory import` | `/swarm memory-import` | TUI shim (deprecated) |
| `/swarm memory migrate` | `/swarm memory-migrate` | TUI shim (deprecated) |

---

## Command Conflicts

Nine swarm commands share names with Claude Code built-in slash commands. Using the bare CC command instead of `/swarm <command>` has different â€” sometimes destructive â€” behavior. Swarm shows a âš ï¸ warning in help output for these commands, and a CI gate test (`src/commands/conflict-registry.test.ts`) prevents new CRITICAL conflicts from being added without explicit acknowledgment.

### Conflict Registry

| Swarm Command | CC Built-in | Severity | CC Behavior | Swarm Behavior |
|---|---|---|---|---|
| `/swarm show-plan` | `/plan` | CRITICAL | Enters Claude Code plan mode â€” Claude proposes all actions before executing | Displays the current `.swarm/plan.md` task list |
| `/swarm reset` | `/reset` | CRITICAL | Alias for `/clear` â€” wipes the entire conversation context window | Clears `.swarm` state files (requires `--confirm` flag) |
| `/swarm checkpoint` | `/checkpoint` | CRITICAL | Alias for `/rewind` â€” restores conversation and code to a prior state | Manages named swarm project snapshots (save\|restore\|delete\|list) |
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

Session-scoped commands (`turbo`, `full-auto`) require an active session and only work inside an OpenCode session â€” invoking them via the standalone CLI will fail.

Both routes share the same registry. See `src/commands/registry.ts` for the raw definitions and `src/cli/index.ts` for the standalone dispatcher.

---

## Related Documentation

- [Getting Started](getting-started.md) â€” first-run walkthrough
- [Modes Guide](modes.md) â€” Balanced vs Turbo vs Full-Auto tradeoffs
- [Configuration Reference](configuration.md) â€” all config keys
- [Knowledge System](knowledge.md) â€” hive vs swarm knowledge
- [Evidence and Telemetry](evidence-and-telemetry.md) â€” observability
