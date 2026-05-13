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

### todo_gate

Controls the TODO gate that warns about new high-priority TODO/FIXME/HACK comments introduced during a phase.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the TODO gate |
| `max_high_priority` | number | `0` | Maximum allowed new high-priority TODOs (FIXME/HACK/XXX) before warning. `0` means warn on any occurrence. Set to `-1` to disable the threshold check. |
| `block_on_threshold` | boolean | `false` | If `true`, block phase completion when the threshold is exceeded. If `false`, the gate is advisory only (warns but does not block). |

The TODO gate scans for new `TODO`, `FIXME`, and `HACK` comments introduced in the current phase and compares the count against `max_high_priority`. The count is included in the `todo_scan` field returned by the `check_gate_status` tool.

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

The three agents derive their models from the `reviewer`, `critic`, and `sme` swarm config entries respectively (generalist→reviewer, skeptic→critic, domain_expert→SME). They have no tools — the architect runs `web_search` 1–3 times before dispatch and passes the results in.

Triggered by `/swarm council <question>` (see [Commands](commands.md#swarm-council-question---spec-review)) or by enabling the `council_general_review` QA gate (which runs the council on a draft spec during MODE: SPECIFY).

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

**Example** — Enable Lean Turbo with defaults:

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

See [Modes Guide](modes.md#lean-turbo-lane-planning-engine) for the full Lean Turbo lane planning algorithm and conflict resolution rules.

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
| `council_mode` | OFF | Multi-member Work Complete Council gate (recommended for high-impact architecture, public APIs, schema/data mutation, security-sensitive code) |
| `hallucination_guard` | OFF | Mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP; blocks `phase_complete` until evidence is APPROVED |
| `mutation_test` | OFF | Runs mutation testing on source files touched this phase at PHASE-WRAP; FAIL blocks `phase_complete`, WARN is non-blocking |
| `council_general_review` | OFF | When enabled, MODE: SPECIFY runs `convene_general_council` on the draft spec before the critic-gate; multi-model deliberation folded into the spec. Requires `council.general.enabled: true` and a search API key. |
