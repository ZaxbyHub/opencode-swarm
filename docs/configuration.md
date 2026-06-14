# Configuration

Swarm supports both global and per-project configuration.

## Config file locations

Global config:

```text
~/.config/opencode/opencode-swarm.json
```

Project config:

```text
.opencode/opencode-swarm.json
```

Project config merges over global config.

## Environment variables

Most behavior is controlled by `opencode-swarm.json`. Environment variables are reserved for credentials, diagnostics, CI bypasses, and advanced backend selection.

| Variable | Used by | Description |
|---|---|---|
| `TAVILY_API_KEY` | General Council web search | Tavily credential used when `council.general.searchApiKey` is unset and `searchProvider` is `tavily`. |
| `BRAVE_SEARCH_API_KEY` | General Council web search | Brave Search credential used when `council.general.searchApiKey` is unset and `searchProvider` is `brave`. |
| `OPENCODE_SWARM_DEBUG=1` | Debug logger | Enables debug-gated log output. Keep disabled for normal use. |
| `DEBUG_SWARM=1` | Startup and hook diagnostics | Enables additional startup, hook, and plan-manager diagnostics. Keep disabled unless debugging plugin behavior. |
| `OPENCODE_SWARM_ID` | Diagnose service | Identifies the active swarm in diagnostic checks; `/swarm diagnose` reports mismatches between this value and local plan state. |
| `SWARM_LANG_BACKEND=legacy` | `test_runner` | Opts out of the dispatch language backend. Dispatch is the default. |
| `SWARM_ALLOW_FULL_SUITE=1` | `test_runner` | Allows `scope: "all"` in the tool. Interactive repo validation should still use shell commands from `TESTING.md`. |
| `SWARM_SKIP_SPEC_GATE=1` | `save_plan` tests/CI | Bypasses the spec gate. Use only for tests or tightly scoped CI fixtures. |
| `SWARM_SKIP_GATE_SELECTION=1` | `save_plan` tests/CI | Bypasses QA-gate selection validation. Use only for tests or tightly scoped CI fixtures. |

## Minimal example

```json
{
  "agents": {
    "coder": { "model": "opencode/minimax-m2.5-free" },
    "reviewer": { "model": "opencode/big-pickle" }
  }
}
```

You only need to define the agents you want to override.

> If `architect` is not set explicitly, it inherits the currently selected OpenCode UI model.

## Per-agent override fields

Each entry under `agents` accepts the following optional fields:

| Field | Type | Description |
|---|---|---|
| `model` | `"<provider>/<model>"` | Model id. **Do not** include a third `/<variant>` segment — see `variant` below. |
| `variant` | `string` | Reasoning-effort variant for models that support it (e.g. `"low"`, `"medium"`, `"high"`, `"max"`, `"xhigh"`, `"thinking"` for `gpt-5.x` / `gpt-5.x-codex`). |
| `temperature` | `0–2` | Sampling temperature override. |
| `disabled` | `boolean` | Skip this agent entirely (it will not be registered). |
| `fallback_models` | `string[]` (max 3) | Models to retry on transient errors (429/503/timeout). |
| `reasoning` | `{ effort?: "low" \| "medium" \| "high" \| "max" }` | Provider-native extended-reasoning block. Forwarded to the OpenCode SDK's `AgentConfig` as-is. See [Why `reasoning` is separate from `variant`](#why-reasoning-and-thinking-are-separate-from-variant) below. |
| `thinking` | `{ type?: "enabled" \| "disabled"; budget_tokens?: number (positive int) }` | Provider-native extended-thinking block. Forwarded to the OpenCode SDK's `AgentConfig` as-is. See [Why `reasoning` is separate from `variant`](#why-reasoning-and-thinking-are-separate-from-variant) below. |

### Why `variant` is its own field

OpenCode's TUI accepts the shorthand `provider/model/variant` (e.g. `grove-openai/gpt-5.3-codex/medium`) in its model picker — the picker rewrites that input through a variant-aware resolver before applying it to the session. The agent loader, by contrast, uses a basic 2-segment parser, so embedding the variant into `model` resolves to a non-existent model id (`gpt-5.3-codex/medium`) and produces `ProviderModelNotFoundError`. Use the `variant` field instead:

```json
{
  "agents": {
    "test_engineer": {
      "model": "grove-openai/gpt-5.3-codex",
      "variant": "medium"
    },
    "designer": {
      "model": "grove-openai/gpt-5.4",
      "variant": "high"
    }
  }
}
```

### Backward compatibility

If you currently have a config like `{ "model": "grove-openai/gpt-5.3-codex/medium" }`, it will still work — the variant is automatically extracted and a deprecation warning is logged.

**Before** (deprecated — produces a warning):

```json
{
  "agents": {
    "coder": {
      "model": "grove-openai/gpt-5.3-codex/medium"
    }
  }
}
```

**After** (recommended — silences the warning):

```json
{
  "agents": {
    "coder": {
      "model": "grove-openai/gpt-5.3-codex",
      "variant": "medium"
    }
  }
}
```

### Why `reasoning` and `thinking` are separate from `variant`

`variant` is the swarm plugin's own reasoning-effort field. It is forwarded to the OpenCode SDK as `variant` (a generic OpenCode hook) and is interpreted by OpenCode's agent loader. `reasoning` and `thinking` are **provider-native** extended-reasoning / extended-thinking blocks (e.g. Anthropic Claude's `reasoning.effort` and `thinking.budget_tokens`). They are passed through to the OpenCode SDK's `AgentConfig` and consumed by the provider's native API. The two mechanisms are independent and can be set on the same agent — users control how their provider interprets each:

```json
{
  "agents": {
    "critic": {
      "model": "anthropic/claude-opus-4-6",
      "variant": "high",
      "reasoning": { "effort": "high" },
      "thinking": { "type": "enabled", "budget_tokens": 10000 }
    }
  }
}
```

Invalid `reasoning.effort` values (anything outside `low | medium | high | max`) and non-positive `thinking.budget_tokens` values will produce a Zod parse error at config load. Unknown fields (typos, future provider-specific options) are stripped by Zod's default behavior — they will not reach the agent factory.

## `default_agent` — selecting which agents are exposed as primary

`default_agent` (top-level, optional `string`) controls which generated agents OpenCode treats as **primary** (selectable as the session's default agent and given `task: allow` permission). All other generated agents become `subagent`s.

| Value | Effect |
|---|---|
| _(omitted)_ | Every architect-role agent is primary. In a legacy single-swarm config that means `architect`. In a multi-swarm config it means `architect` (if a `default` swarm is defined) plus every `*_architect` (`local_architect`, `mega_architect`, `paid_architect`, `modelrelay_architect`, …). This restores v7.0.0 behavior. |
| `"architect"` _(or any other base role)_ | Every generated agent whose canonical base role matches becomes primary. `default_agent: "coder"` exposes `coder` in legacy mode and every `*_coder` in multi-swarm mode. |
| `"local_architect"` _(or any other exact generated name)_ | Only that exact generated agent becomes primary. Useful for pinning a single swarm. |
| Unknown / invalid value | A one-time warning is logged and the resolver falls back to architect-role primaries (or, if all architect roles are disabled, the first generated agent). The plugin never produces zero primaries when at least one agent exists. |

Empty or whitespace-only values are treated as omitted.

> Why this matters: in v7.3.x the schema applied an implicit `.default("architect")`. In a multi-swarm config there is no agent literally named `architect` — they are all prefixed — so every architect was demoted to subagent and OpenCode showed only the native `build`/`plan` agents. The omitted-vs-explicit distinction is now load-bearing; do not re-introduce a schema default.

## `auto_select_architect` — auto-select swarm architect on launch

`auto_select_architect` (top-level, optional `boolean | string`) controls whether OpenCode's built-in `build` and `plan` agents are disabled so the swarm architect is automatically selected as the active agent on launch.

| Value | Effect |
|-------|--------|
| `false` (default) | No auto-select — `build`/`plan` remain enabled; user manually picks the architect |
| `true` | Disable `build` and `plan` so the swarm architect is the only selectable primary agent; emit a warning if multiple architect agents are primary |
| `"<architect_name>"` | Same as `true`, but target a specific architect by its generated name (e.g. `"mega_architect"`) — all other architects are demoted to subagent |

**Behavior details:**
- Only `build` and `plan` are disabled. `general` and `explore` are always preserved.
- If the user has already set `disable: true` on `build` or `plan` in their own config, the plugin respects that override.
- If no architect agent exists in the generated set, a warning is emitted and the option has no effect.
- If the string value does not match a known architect name, a warning is emitted and no demotion is applied.

**Example — enable for any architect:**
```json
{
  "auto_select_architect": true
}
```

**Example — target a specific architect in a multi-swarm config:**
```json
{
  "auto_select_architect": "mega_architect"
}
```

## How to verify the resolved config

Run:

```text
/swarm config
```

## Related commands

```text
/swarm diagnose
/swarm agents
/swarm config
```

## Hook Configuration

### incremental_verify

Runs a type-checking or linting command after the coder agent completes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the hook |
| `command` | `string \| string[] \| null` | `null` | Override auto-detected command. String is split on spaces. Array bypasses splitting for commands with special arguments. |
| `timeoutMs` | number | `30000` | Timeout in milliseconds (1000–300000) |
| `triggerAgents` | string[] | `["coder"]` | Which agent names trigger the hook |

**Auto-detection order**: TypeScript → Go → Rust → Python → C#. Python emits a `SKIPPED` advisory if no command is set.

**Example** — Python mypy configuration:

```json
{
  "incremental_verify": {
    "command": ["python", "-m", "mypy", "--config-file", "mypy.ini"]
  }
}
```

### slop_detector

Detects low-quality code patterns (AI slop) in generated output.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the hook |
| `classThreshold` | number | `3` | Abstraction-bloat threshold (max methods/props per class) |
| `commentStripThreshold` | number | `5` | Comment-strip threshold (max consecutive comment lines) |
| `diffLineThreshold` | number | `200` | Boilerplate-explosion threshold (max lines per diff) |

### Curator

Optional knowledge-base curator that validates agent output against project knowledge.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for Curator |
| `init_enabled` | boolean | `true` | Run Curator at session start |
| `phase_enabled` | boolean | `true` | Run Curator at phase boundaries |
| `max_summary_tokens` | number | `2000` | Max tokens for Curator summary output |
| `min_knowledge_confidence` | number | `0.7` | Minimum confidence threshold for knowledge entries |
| `compliance_report` | boolean | `true` | Include compliance report in phase digest |
| `suppress_warnings` | boolean | `true` | Suppress TUI warnings; emit events only |
| `drift_inject_max_chars` | number | `500` | Max chars for drift report summary injected into architect context |

Curator is optional and disabled by default. When enabled, it writes `.swarm/curator-summary.json` and `.swarm/drift-report-phase-N.json` to track knowledge alignment and drift detection.

### Architectural supervision

Hierarchical summary review (issue #893). Agents emit short structured summaries via the
`summarize_work` tool; these roll up per phase and are reviewed by the
`critic_architecture_supervisor` critic role to catch cross-task contradictions, drift,
and repeated failure loops. The supervisor agent inherits the `critic` model unless you
override `agents.critic_architecture_supervisor.model`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch; enables per-phase summary aggregation |
| `mode` | `advisory` \| `gate` | `advisory` | `advisory` never blocks; `gate` lets `phase_complete` block on a REJECT verdict |
| `run_on` | `phase_complete` | `phase_complete` | When the expensive supervisor runs |
| `summary_model` | string | _(unset)_ | Optional cheap model for an LLM compression pass (deterministic aggregation today) |
| `max_agent_summary_words` | number | `100` | Word cap for per-agent summaries |
| `max_phase_summary_words` | number | `250` | Word cap for the per-phase rollup |
| `allow_concerns_to_complete` | boolean | `true` | Under `gate` mode, whether a CONCERNS verdict still allows completion |
| `persist_knowledge_recommendations` | boolean | `false` | Propose supervisor knowledge recommendations as candidate knowledge |

Disabled by default. When enabled, aggregation writes
`.swarm/evidence/{phase}/phase-architecture-summary.json`; the supervisor (later chunk)
writes `.swarm/evidence/{phase}/architecture-supervisor.json`.

### Design docs (`design_docs`)

Structured, language-agnostic design-doc generation for the project under build
(issue #1080). When enabled, the opt-in `docs_design` agent (a role variant of the
docs agent) is registered, the `/swarm design-docs` command becomes actionable, and
`phase_complete` runs a deterministic, non-blocking design-doc drift check.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch; registers the `docs_design` agent and enables the drift check |
| `out_dir` | string | `docs` | Project-relative output directory for the generated docs |
| `language` | string | _(unset)_ | Optional target language for the `reference/` docs; inferred when unset |

Disabled by default. When enabled, the `docs_design` agent writes
`<out_dir>/{domain,technical-spec,behavior-spec}.md`,
`<out_dir>/reference/{reference-impl,idiom-notes}.md`,
`<out_dir>/reference/traceability.json`, and `<out_dir>/design-changelog.md` into the
target repo; the drift check writes `.swarm/doc-drift-phase-N.json`. See
[Commands → `/swarm design-docs`](commands.md).

### Memory

Optional scoped memory substrate for recall and proposal-only memory writes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable agent access to `swarm_memory_recall` and `swarm_memory_propose` |
| `provider` | string | `"sqlite"` | Memory provider. Supports default `"sqlite"` and legacy/debug `"local-jsonl"` |
| `storageDir` | string | `".swarm/memory"` | Local storage directory under the project root |
| `sqlite.path` | string | `".swarm/memory/memory.db"` | SQLite database path. Must remain inside `.swarm/` |
| `sqlite.busyTimeoutMs` | number | `5000` | SQLite busy timeout in milliseconds |
| `recall.defaultMaxItems` | number | `8` | Default max recalled memories |
| `recall.defaultTokenBudget` | number | `1200` | Default recall prompt-block token budget |
| `recall.minScore` | number | `0.05` | Minimum lexical recall score |
| `recall.injection.enabled` | boolean | `true` | Enable automatic prompt injection when memory is enabled |
| `recall.injection.minScore` | number | `0.25` | Minimum score for automatic injection |
| `recall.injection.requireQuerySignal` | boolean | `true` | Require text, tag, file, symbol, or explicit kind query signal before automatic injection |
| `recall.injection.maxItems` | number | `6` | Maximum memories automatically injected into agent context |
| `recall.injection.tokenBudget` | number | `1000` | Token budget for automatic memory injection |
| `writes.mode` | string | `"propose"` | Normal agents can only create proposals |
| `redaction.rejectDurableSecrets` | boolean | `true` | Reject durable memories that contain likely secrets |
| `maintenance.lowUtilityMaxConfidence` | number | `0.45` | Confidence threshold used by `/swarm memory stale` low-utility reporting |
| `maintenance.lowUtilityMinAgeDays` | number | `30` | Age threshold used by `/swarm memory stale` low-utility reporting |

Memory stores durable state in `.swarm/memory/memory.db` by default. Legacy JSONL files under `.swarm/memory/` are migrated once into SQLite, backed up, and remain available through `memory.provider="local-jsonl"` for legacy/debug mode. Recall is scope-filtered and labels retrieved memory as untrusted background. Proposals do not become durable memory without curator or trusted gateway review. See [Swarm Memory](memory.md).

### PR Monitor

GitHub PR subscription and background polling infrastructure (FR-001). When enabled, the architect can subscribe to GitHub PRs and receive real-time status updates via the AutomationEventBus. Uses the `gh` CLI for all GitHub API calls; requires `gh` to be authenticated (`gh auth login`).

**Auto-subscribe**: when `pr_monitor.enabled: true` is set, PR monitoring is available without an additional feature flag — sessions can subscribe to PRs immediately.

**Durable store**: subscription state is persisted to `.swarm/pr-monitor/subscriptions.jsonl` (append-only JSONL), folded by `correlationId` (sessionID + repoFullName + prNumber). Multiple sessions may independently subscribe to the same PR using a composite key.

**Event types**: all PR events flow through the AutomationEventBus with types:
- `pr.subscribed`, `pr.unsubscribed`, `pr.status.updated`
- `pr.ci.failed`, `pr.ci.passed`
- `pr.new.comment`, `pr.merge.conflict`, `pr.merge.conflict_resolved`
- `pr.merged`, `pr.closed`
- `pr.review.approved`, `pr.review.changes_requested`
- `pr.subscription.expired`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master feature flag — enables PR monitoring |
| `poll_interval_seconds` | number | `60` | Seconds between poll cycles (30–300) |
| `max_subscriptions` | number | `20` | Maximum concurrent PR subscriptions (1–100) |
| `max_prs_per_cycle` | number | `5` | Maximum PRs polled per cycle (1–20) |
| `max_concurrent_pr_polls` | number | `3` | Maximum concurrent PR polls (1–10) |
| `poll_timeout_ms` | number | `30000` | Per-poll timeout in milliseconds (5000–120000) |
| `failure_threshold` | number | `5` | Consecutive failures before circuit breaker trips (1–20) |
| `cooldown_seconds` | number | `30` | Circuit breaker cooldown in seconds (5–600) |
| `max_cooldown_seconds` | number | `300` | Maximum cooldown with exponential backoff in seconds (30–3600) |
| `cleanup_ttl_days` | number | `7` | TTL in days for stale subscription cleanup (1–90) |
| `auto_unsubscribe_on_merge` | boolean | `true` | Automatically unsubscribe when PR is merged |
| `auto_unsubscribe_on_close` | boolean | `true` | Automatically unsubscribe when PR is closed (without merge) |
| `notify_ci_failure` | boolean | `true` | Emit notification on CI failure |
| `notify_new_comments` | boolean | `true` | Emit notification on new comments |
| `notify_merge_conflict` | boolean | `true` | Emit notification on merge conflict detection |
| `auto_pr_feedback` | boolean | `false` | When enabled, injects `[MODE: PR_FEEDBACK pr="URL"]` signal on CI failure and merge conflict events |

**Example** — enable PR Monitor with defaults:

```json
{
  "pr_monitor": {
    "enabled": true
  }
}
```

**Example** — customize polling parameters:

```json
{
  "pr_monitor": {
    "enabled": true,
    "poll_interval_seconds": 30,
    "max_subscriptions": 50,
    "max_concurrent_pr_polls": 5,
    "failure_threshold": 3,
    "auto_unsubscribe_on_merge": true
  }
}
```

**GH CLI wrappers** (`src/git/pr.ts`): the PR monitor infrastructure uses five `gh`-based wrapper functions exported for use by the polling engine:
- `getPRStatus(prNumber, repoFullName, cwd)` — fetches PR state, mergeability, and status check rollup via `gh pr view --json`
- `getPRChecks(prNumber, repoFullName, cwd)` — fetches CI check results via `gh pr checks --json`
- `getPRComments(prNumber, repoFullName, cwd, since?)` — fetches issue and review comments via `gh api` (merged, deduplicated)
- `getMergeState(prNumber, repoFullName, cwd)` — fetches mergeable state and mergeStateStatus via `gh pr view --json`
- `getPRReviewState(prNumber, repoFullName, cwd)` — fetches review decision and pending reviewer count via `gh pr view --json`; returns `ReviewStateResult` (`reviewDecision`, `reviewRequestCount`)

All five wrappers (`getPRStatus`, `getPRChecks`, `getPRComments`, `getMergeState`, `getPRReviewState`) use `_internals.ghExecAsync` — they share the same DI seam pattern (see `gitignore-warning.ts:_internals`). No synchronous `ghExec`-based wrappers are currently exposed for PR monitoring.

**Polling worker** (`src/background/pr-monitor-worker.ts`): `PrMonitorWorker` is a standalone background class with start/stop/dispose lifecycle. It implements **two-phase change detection**:
1. `computeChanges()` — fetches current PR state (status, comments, merge, review) via async gh wrappers, then diffs against the last stored snapshot to produce a list of events and snapshot updates
2. `applyChanges()` — atomically emits events and persists snapshot updates

The worker is **lazily started** on first subscription (gated by `pr_monitor.enabled` + `gh` availability check). It is **cooperative** — each poll cycle is interruptible at 6 guard points via a `CancellationToken`. Plugin wiring in `src/index.ts` registers signal handlers (SIGTERM/SIGINT) and ensures the worker is stopped on shutdown. Stale subscriptions are removed via `sweepStale()` on each cycle.

**Event subscribers** (`src/background/pr-event-subscribers.ts`): three subscribers attach to the AutomationEventBus and deliver PR advisories to subscribed sessions:
- CI failure/passed notifications
- New comment alerts
- Merge conflict detection

### todo_gate

Controls the TODO gate that warns about new high-priority TODO/FIXME/HACK comments introduced during a phase.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the TODO gate |
| `max_high_priority` | number | `0` | Maximum allowed new high-priority TODOs (FIXME/HACK/XXX) before warning. `0` means warn on any occurrence. Set to `-1` to disable the threshold check. |
| `block_on_threshold` | boolean | `false` | If `true`, block phase completion when the threshold is exceeded. If `false`, the gate is advisory only (warns but does not block). |

The TODO gate scans for new `TODO`, `FIXME`, and `HACK` comments introduced in the current phase and compares the count against `max_high_priority`. The count is included in the `todo_scan` field returned by the `check_gate_status` tool.

### skill_propagation

Intelligent skill tracking, scoring, and recommendation system for agent delegations.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable skill propagation tracking |
| `enforce` | boolean | `false` | When `true`, block delegations missing the `SKILLS:` field. Advisory mode (default) only warns. |
| `scoring.threshold` | number | `0.5` | Minimum relevance score for skill recommendations (0.0–1.0) |
| `scoring.max_recommendations` | number | `5` | Maximum number of skill recommendations per delegation |

**What it does:**
- Logs all skill delegations to `.swarm/skill-usage.jsonl` with session-scoped entries
- Scores available skills by relevance based on frequency, compliance, recency, and task diversity
- Provides recommendations when delegating without a `SKILLS:` field
- Auto-populates `.swarm/context.md` with an "Available Skills" section
- Supports explicit routing via `.opencode/skill-routing.yaml` (Phase 2)

**Guardrails:**
- Relevance scoring threshold: 0.5 (skills below this are not recommended)
- Maximum recommendations per delegation: 5
- Scoring budget safeguard: Skipped when session exceeds 500 skill-usage entries
- Graceful degradation: Zero installed skills = zero friction (no warnings, no blocks)

**Example:**

```json
{
  "skill_propagation": {
    "enabled": true,
    "enforce": false,
    "scoring": {
      "threshold": 0.5,
      "max_recommendations": 5
    }
  }
}
```

**Skill routing file** (`.opencode/skill-routing.yaml`):

```yaml
version: 1
routing:
  coder:
    - path: .claude/skills/writing-tests/SKILL.md
      keywords: ["test", "testing", "writing tests"]
    - path: .claude/skills/engineering-conventions/SKILL.md
      keywords: ["engineering", "conventions", "invariants"]
  reviewer:
    - path: .claude/skills/swarm-pr-review/SKILL.md
      keywords: ["review", "security", "audit"]
  test_engineer:
    - path: .claude/skills/running-tests/SKILL.md
      keywords: ["test execution", "test runner", "running tests"]
  sme:
    - path: .claude/skills/research-first/SKILL.md
      keywords: ["research", "documentation", "external sources"]
  docs:
    - path: .claude/skills/quality-docs-manager/SKILL.md
      keywords: ["documentation", "knowledge", "ADRs"]
  designer:
    - path: .claude/skills/frontend-design/SKILL.md
      keywords: ["frontend", "UI", "design"]
```

Routing skills are merged with scored recommendations, with explicitly routed skills receiving a boosted score (0.9) to prioritize them.

## Phase Complete Configuration

Controls phase completion gating and validation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable phase completion validation |
| `required_agents` | string[] | `["coder", "reviewer", "test_engineer"]` | Agents that must be dispatched before a phase can complete |
| `require_docs` | boolean | `true` | Require the docs agent to be dispatched |
| `policy` | `"enforce" \| "warn"` | `"enforce"` | When `"enforce"`: missing agents block phase completion. When `"warn"`: missing agents produce warnings only. |
| `regression_sweep.enforce` | boolean | `false` | If `true`, phase_complete warns when no regression-sweep result is found for any task in the phase. Advisory only — does not block phase completion. |

**Example** — Enable regression sweep enforcement:

```json
{
  "phase_complete": {
    "required_agents": ["coder", "reviewer", "test_engineer"],
    "require_docs": true,
    "policy": "enforce",
    "regression_sweep": {
      "enforce": true
    }
  }
}
```

## Council

Opt-in verification gate that runs five specialized reviewers in parallel before a task advances to `completed`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for the council gate |
| `maxRounds` | number | `3` | Maximum REJECT-retry rounds before architect must escalate to user (1–10) |
| `parallelTimeoutMs` | number | `30000` | Per-member dispatch timeout in milliseconds (5000–120000) |
| `vetoPriority` | boolean | `true` | When `true`, any single REJECT blocks advancement |
| `requireAllMembers` | boolean | `false` | When `true`, reject synthesis if fewer than 5 verdicts provided. Equivalent to `minimumMembers: 5`. |
| `minimumMembers` | number | `3` | Minimum distinct council members required for quorum (1–5). Set to 1 to disable quorum enforcement. `requireAllMembers: true` overrides this to 5 (stricter constraint wins). |
| `escalateOnMaxRounds` | string? | undefined | Reserved for future use — no runtime behavior today |

When `enabled: false`, the council gate is completely inert. When enabled, `submit_council_verdicts` must be called before a task can transition to `completed`. See the [Council guide](council/README.md) for the full workflow.

**Example** — Enable the council gate:

```json
{
  "council": {
    "enabled": true,
    "maxRounds": 3,
    "vetoPriority": true,
    "requireAllMembers": false,
    "minimumMembers": 3
  }
}
```

For a full configuration reference, see the [Full Configuration Reference](../README.md) section in the README (expand the "Full Configuration Reference" details block).

### `council.general` — General Council Mode (advisory)

Distinct from the Work Complete Council above. Where the Work Complete Council is a **verdict-based QA gate** that blocks task completion, the General Council is an **advisory deliberation system**: a fixed three-agent council (`council_generalist`, `council_skeptic`, `council_domain_expert`) reviews a question using an architect-supplied RESEARCH CONTEXT block, with one optional disagreement-targeted reconciliation round. The architect synthesizes the final answer directly using inline output rules.

The three council agents derive their models from the `reviewer`, `critic`, and `sme` swarm config entries respectively (generalist→reviewer, skeptic→critic, domain_expert→SME). They have no tools — for General Council dispatch, the architect runs `web_search` 1–3 times before dispatch and passes the results in. Separately, SME agents may call `web_search` directly for external skill/source research when `council.general.enabled=true` and a Tavily or Brave API key is configured.

Triggered by `/swarm council <question>` (see [Commands](commands.md#swarm-council-question---spec-review)) or offered as an early workflow option in MODE: BRAINSTORM (Phase 1b) when enabled.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for the General Council feature |
| `searchProvider` | `'tavily' \| 'brave'` | `'tavily'` | Web search backend used by the architect's pre-search pass |
| `searchApiKey` | string? | undefined | API key for the chosen provider. Falls back to `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` env vars when unset. |
| `deliberate` | boolean | `true` | When `true`, the architect routes Round 1 disagreements back to disputing agents for a single Round 2 reconciliation |
| `maxSourcesPerMember` | number | `5` | Hard cap on results per `web_search` call (1–20) |

**Deprecated fields** (retained on the strict schema for backward compatibility; ignored at runtime):

| Field | Type | Notes |
|-------|------|-------|
| `members` | array | No longer used — the council is a fixed three-agent set. |
| `presets` | record | No longer used — preset-based member selection has been removed. |
| `moderator` | boolean | No longer used — the architect synthesizes the final answer directly. |
| `moderatorModel` | string? | No longer used — setting this triggers a deferred deprecation warning. |

**Example** — Enable the general council and customize the underlying models via the regular agent config:

```json
{
  "council": {
    "enabled": false,
    "general": {
      "enabled": true,
      "searchProvider": "tavily",
      "searchApiKey": "tvly-xxxxxxxx",
      "deliberate": true,
      "maxSourcesPerMember": 5
    }
  },
  "agents": {
    "reviewer": { "model": "anthropic/claude-opus-4-7" },
    "critic": { "model": "openai/gpt-5" },
    "sme": { "model": "google/gemini-2.5-pro" }
  }
}
```

> ⚠️ **Strict-validation warning.** `CouncilConfigSchema` is `.strict()`. A typo in any `council.general.*` key (e.g. `searchProvder`) causes the *entire* user config to fail Zod validation. The loader (`src/config/loader.ts`) then falls back to **guardrail-only defaults** — silently losing every setting in `opencode-swarm.json`, not just the misspelled field. Validate with `/swarm config` after editing, and watch for the `[opencode-swarm] ⚠️ SECURITY: Falling back to conservative defaults` warning in the console.

> **appendPrompt note.** Council agents (`council_generalist`, `council_skeptic`, `council_domain_expert`) do **not** inherit `appendPrompt` from the underlying agent config entries (`agents.reviewer.appendPrompt`, etc.). Council prompts are fixed and self-contained — they define a specific council persona and must not be contaminated by workflow-role customizations. This omission is intentional. If you need consistent context across all agents including council roles, add it to the council prompts via a custom build rather than via `appendPrompt`.

> **Reduced-council warning.** If `council.general.enabled` is `true` but you have disabled `reviewer`, `critic`, or `sme` in `agents`, the corresponding council role (`council_generalist`, `council_skeptic`, or `council_domain_expert` respectively) will not be registered and a deferred warning will be emitted. Re-enable the base agent or accept a reduced council. This warning is replayed when you run `/swarm diagnose`.

## Skill Improver Consolidation

`skill_improver` can run manually or at safe scheduled cadence points.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enables the skill-improver service and consolidation command. |
| `trigger` | `"manual" \| "scheduled"` | `"manual"` | `scheduled` allows opportunistic startup and phase-complete consolidation. |
| `max_calls_per_day` | number | `10` | Hard daily quota for skill-improver proposal calls. |
| `consolidation_interval_hours` | number | `24` | Minimum hours between scheduled consolidation runs. |
| `consolidation_max_calls_per_run` | number | `1` | Per-run reservation for scheduled consolidation, capped by `max_calls_per_day`. |
| `write_mode` | `"proposal" \| "draft_skills"` | `"proposal"` | Whether consolidation only writes improver proposals or also drafts generated skill proposals. |

Scheduled consolidation is fire-and-forget, validates drafted skills against
matching eval fixtures, and never auto-activates skills. Use `/swarm
consolidate` for an explicit pass.

## External Skills Curation Pipeline

Opt-in pipeline for discovering, quarantining, evaluating, and promoting external skill candidates from configured sources. Candidates are stored under `.swarm/skills/candidates/<uuid>.json`.

**Requires `curation_enabled: true`** to activate. When disabled, all 7 external skill tools return a disabled message.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `curation_enabled` | boolean | `false` | Master switch for the external skill curation pipeline |
| `max_candidates` | number | `500` | Maximum candidates in the quarantine store (1–10000) |
| `max_bytes_per_candidate` | number | `1048576` | Max file size per candidate in bytes (1024–10485760) |
| `eviction_policy` | `"fifo"` | `"fifo"` | Eviction strategy when `max_candidates` is reached |
| `ttl_days` | number | `90` | Candidate TTL in days before automatic eviction (1–3650) |
| `evaluation_enabled` | boolean | `false` | Enable SME evaluation workflow for candidates |
| `sources` | array | `[]` | Discovery source configurations (see DiscoverySource schema) |
| `max_candidates_per_discovery` | number | `50` | Max candidates per discovery run (1–1000) |
| `max_concurrent_fetches` | number | `5` | Max concurrent source fetches (1–20) |
| `fetch_timeout_ms` | number | `30000` | Per-fetch timeout in milliseconds (1000–300000) |

### Discovery sources

Each source in `sources` must match `DiscoverySourceSchema`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"github" \| "url" \| "collection" \| "manual_import"` | Yes | — | Source type |
| `location` | string | Yes | — | Source URL, file path, or identifier |
| `enabled` | boolean | No | `true` | Whether this source is active |
| `trust_level` | `"low" \| "medium" \| "high"` | No | `"low"` | Trust level for gate modulation |

### Available tools

When `curation_enabled: true`, the architect agent gains access to 7 tools:

| Tool | Description |
|------|-------------|
| `external_skill_discover` | Discover external skill candidates from configured sources |
| `external_skill_list` | List candidates in the quarantine store |
| `external_skill_inspect` | Inspect a specific candidate by ID |
| `external_skill_promote` | Promote a validated candidate to an active generated skill |
| `external_skill_reject` | Reject a candidate after evaluation |
| `external_skill_delete` | Delete a candidate from the quarantine store |
| `external_skill_revoke` | Revoke a previously promoted skill |

**Example** — Enable external skill curation with a URL source:

```json
{
  "external_skills": {
    "curation_enabled": true,
    "max_candidates": 500,
    "ttl_days": 90,
    "sources": [
      {
        "type": "url",
        "location": "https://example.com/skills/",
        "enabled": true,
        "trust_level": "medium"
      }
    ]
  }
}
```

### Troubleshooting

**"All tools return disabled message"**
→ Check `external_skills.curation_enabled: true` is set in your config. The pipeline is disabled by default.

**"Discover says source not in configured sources"**
→ The `location` field in your source config must match the URL passed to discover. URLs are validated against configured sources before fetching.

**"Candidate fails validation but content looks safe"**
→ Check the `trust_level` setting. With `low` trust, warning-level findings are promoted to errors. Try `medium` or `high` trust for less strict gating.

**"Promote fails with 'file already exists'"**
→ A skill with the same slug already exists in the target directory. Revoke the existing skill first, or choose a different candidate.

**"Promote fails with 'content hash mismatch'"**
→ The candidate was modified after discovery (TOCTOU detection). Re-discover the candidate to get a fresh evaluation.

**"Revoke fails with 'cannot extract skill slug from history'"**
→ The candidate's promotion history may be corrupted or missing. The revoke tool needs the slug from the original promotion record to locate the SKILL.md file. If the history was tampered with, delete the candidate and manually remove the SKILL.md file.

## Turbo Configuration

Lean Turbo is a lane-planning execution strategy that partitions phase tasks into parallel lanes based on file-scope conflicts, enabling multiple coders to work concurrently on non-conflicting tasks. It composes with all session modes (Turbo, Full-Auto, Balanced).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | `"standard" \| "lean"` | `"standard"` | Execution strategy. `"lean"` enables Lean Turbo lane planning; `"standard"` uses single-coder Turbo. |
| `lean` | object | _(see below)_ | Lean-mode configuration. Only used when `strategy` is `"lean"`. |

### `turbo.lean` — Lean Turbo settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_parallel_coders` | number | `4` | Maximum number of parallel coders in lean mode (1–6). Set to `1` for serial execution. |
| `require_declared_scope` | boolean | `true` | When `true`, all tasks must have a declared file scope to be eligible for parallel lanes. Tasks without scope are serialized. |
| `conflict_policy` | `"serialize" \| "degrade"` | `"serialize"` | How to handle file-scope conflicts between parallel tasks. `"serialize"` queues conflicting tasks; `"degrade"` falls back to standard serial flow. |
| `degrade_on_risk` | boolean | `true` | When `true`, Lean Turbo degrades to serial execution if risk conditions are detected (e.g., protected paths, cross-lane dependencies). |
| `phase_reviewer` | boolean | `true` | Dispatch an additive phase-level reviewer gate at `phase_complete`. This is in addition to per-task Stage B review — it does NOT skip Stage B. |
| `phase_critic` | boolean | `true` | Dispatch an additive phase-level critic gate at `phase_complete`. This is in addition to per-task Stage B review — it does NOT skip Stage B. |
| `integrated_diff_required` | boolean | `true` | Require an integrated diff before accepting changes from a lane. Ensures cross-lane file changes are coherent. |
| `allow_docs_only_without_reviewer` | boolean | `false` | Allow docs-only phases to complete when the reviewer agent is not available. |
| `worktree_isolation` | boolean | `false` | Use git worktree isolation for parallel coders to enable true file-system-level parallelism. |
| `merge_strategy` | `"merge" \| "rebase" \| "cherry-pick"` | `"merge"` | Branch merge strategy after lane worktree completion. Controls how completed lane branches are merged back into the main branch. |
| `worktree_dir` | string | _(none)_ | Optional user-specified worktree directory override. When set, worktrees are created under this path instead of the default `.swarm-worktrees/<sessionId>/<laneId>`. Accepts absolute and relative paths (relative paths are resolved against the project root). |

**Example** — Enable Lean Turbo with worktree isolation and rebase strategy:

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
      "worktree_isolation": true,
      "merge_strategy": "rebase",
      "worktree_dir": ".worktrees"
    }
  }
}
```

See [Modes Guide](modes.md#lean-turbo-lane-planning-engine) for the full Lean Turbo lane planning algorithm and conflict resolution rules.

## Execution Profile

The execution profile (per-plan, set during QA GATE SELECTION or via `save_plan`) controls phase-level execution preferences. Configure interactively via the gate-selection dialogue surfaced in MODE: SPECIFY step 5b, MODE: BRAINSTORM Phase 6, or the MODE: PLAN inline path.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallelization_enabled` | boolean | `false` | Enable parallel task execution within phases (composes with Lean Turbo) |
| `max_concurrent_tasks` | number | `1` | Maximum tasks that may run concurrently when `parallelization_enabled: true` (1–6) |
| `council_parallel` | boolean | `false` | Allow council review phases to run council members in parallel |
| `auto_proceed` | boolean | `false` | Skip the "Ready for Phase N+1?" prompt and advance automatically at phase boundaries |

**Auto-proceed:** When `true`, the swarm advances from one phase to the next without asking for confirmation. The session override (`/swarm auto-proceed on|off`) always takes precedence over the plan default. The architect sees the effective value via an injected `AUTO PROCEED STATUS` banner. The first-boundary nudge offers to enable it once per session when the plan default is `false` and no session override is set.

## QA gates reference

The QA gate profile (per-plan, persisted in the project DB) controls which quality gates fire during a plan's execution. Configure interactively via the gate-selection dialogue surfaced in MODE: SPECIFY step 5b, MODE: BRAINSTORM Phase 6, or the MODE: PLAN inline path. Programmatic configuration via `set_qa_gates` (architect-only) or `/swarm qa-gates enable <gate>...`.

All gates are **ratchet-tighter** — once enabled they cannot be disabled until the profile is reset, and once locked (after critic approval) no changes are accepted at all.

| Gate | Default | Description |
|------|---------|-------------|
| `reviewer` | ON | Code review of coder output |
| `test_engineer` | ON | Test verification of coder output |
| `sme_enabled` | ON | SME consultation during planning / clarification |
| `critic_pre_plan` | ON | Critic review before plan finalization |
| `sast_enabled` | ON | Static security scanning |
| `council_mode` | OFF | Replaces per-task Stage B (reviewer + test_engineer) with full 5-member council per task (recommended for high-impact architecture, public APIs, schema/data mutation, security-sensitive code) |
| `hallucination_guard` | OFF | Mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP; blocks `phase_complete` until evidence is APPROVED |
| `mutation_test` | OFF | Runs mutation testing on source files touched this phase at PHASE-WRAP; FAIL blocks `phase_complete`, WARN is non-blocking |
| `drift_check` | ON | Mandatory per-phase drift verification at PHASE-WRAP; compares implemented changes against spec.md intent; hard-blocks `phase_complete` when spec.md exists and drift evidence is missing or REJECTED; advisory-only when no spec.md exists |
| `phase_council` | OFF | Full 5-member council reviews all work in a phase holistically at `phase_complete` time. Additive to per-task gates. |
| `final_council` | OFF | Full 5-member council (NOT General Council) reviews the entire project at the last phase. Requires approved `.swarm/evidence/final-council.json`. |
