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

Project config merges over global config. The project config file is **opt-in** — the installer and plugin startup never create it. Add it manually only when a project needs to override the global config.

Both locations support a `"$schema"` key pointing at the JSON Schema shipped with the
plugin, which gives supporting editors validation and autocomplete for every
configuration key:

```json
{
  "$schema": "https://unpkg.com/opencode-swarm/opencode-swarm.schema.json"
}
```

The URL above is the canonical always-latest form. Config files created by the plugin
(project init, CLI install) write the same URL pinned to the plugin version that authored
the file (e.g. `https://unpkg.com/opencode-swarm@7.158.1/opencode-swarm.schema.json`) so
validation matches the installed version; both forms resolve to the same published file.
To adopt the reference in an existing config, add the `$schema` line shown above as the
first key. `"$schema"` is pure metadata and is ignored at runtime.

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

<!-- opencode-swarm: begin generated top-level-config-keys (regenerate: bun run scripts/generate-config-schema.ts) -->

## Top-level configuration keys

Generated from `PluginConfigSchema` (`src/config/schema.ts`) - do not edit inside the markers. Regenerate with `bun run scripts/generate-config-schema.ts`. See also the topic sections below and the shipped JSON Schema (`opencode-swarm.schema.json`, referenced via `$schema` for editor validation).

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `$schema` | string | — | JSON Schema URL for editor validation/autocomplete of this file (issue #1663). Ignored at runtime; malformed values are ignored too. |
| `config_format_version` | integer | 1 | Config format version for the migration table. Increment when fields are deprecated. Distinct from knowledge.schema_version. |
| `agents` | record<string, object> | — | Per-agent overrides keyed by agent name for the default swarm (e.g. "architect", "coder"). Multi-swarm setups configure agents under swarms.<id>.agents instead. |
| `default_agent` | string | — | Agent set as the primary mode. Omitted: every generated *_architect is primary. Exact generated name (e.g. "local_architect"): only that agent. Base role name (e.g. "coder"): every generated agent with that base role. Unknown strings warn once and fall back to architect primaries. |
| `auto_select_architect` | boolean \| string | — | Auto-select the swarm architect for new sessions instead of OpenCode built-ins. Omitted or false: manual selection (omitted behaves as false). true: enable auto-select and disable built-in build/plan agents. "<architect_name>" (e.g. "mega_architect"): enable targeting one architect in multi-swarm setups. |
| `swarms` | record<string, object> | — | Multiple swarms keyed by swarm ID (no underscores allowed). The first swarm, or one named "default", provides the primary architect. |
| `max_iterations` | number | 5 | Maximum pipeline iterations per task (1-10). |
| `pipeline` | object | — | Pipeline stage/model settings. |
| `phase_complete` | object | — | Phase-completion gate settings. |
| `qa_retry_limit` | number | 3 | Maximum QA retry rounds per task (1-10). |
| `execution_mode` | enum(strict \| balanced \| fast) | "balanced" | Performance mode controlling optional hook execution overhead: "strict", "balanced", or "fast". |
| `inject_phase_reminders` | boolean | true | Inject phase reminder directives during execution. |
| `hooks` | object | — | Hook subsystem toggles and settings. |
| `pr_review_resilience` | object (strict) | — | PR review base-wave staged canary/fanout resilience settings. |
| `pr_review_legacy_transcript_compatibility` | boolean | — | Deprecated migration-only opt-in for transcript-row PR-review base and micro discovery lanes. |
| `gates` | object | — | Quality gate configuration (v6.9 anti-slop features). |
| `context_budget` | object | — | Context budget thresholds. |
| `pricing` | object | — | Token/cost estimation fallback table. Provider-reported cost wins when present; entries only estimate from usage tokens when reports omit cost. |
| `guardrails` | object | — | Loop containment and safety guardrails: tool-call caps, denial tracking, destructive-command blocking, shell audit. |
| `watchdog` | object | — | Scope-guard and delegation-ledger watchdog settings. |
| `self_review` | object | — | Advisory self-review after coder delegation. |
| `auto_review` | object | — | Opt-in execution-diff review by the reviewer model in a fresh ephemeral session at task/phase boundaries. |
| `tool_filter` | object | — | Controls which plugin tools each agent is allowed to use; enforced through host-side per-agent permission denies (issue #2528). enabled: false lifts the plugin-tool allow-list but keeps each role's read-only write-family floor. |
| `authority` | object | — | Per-agent file write authority rules. |
| `plan_cursor` | object | — | Compressed plan summary injection settings. |
| `context_map` | object | — | Context Map (issue #1104, FR-006) — opt-in. |
| `repo_graph` | object | {} | Repository dependency-graph settings (builder excludes, incremental refresh). Nested defaults materialize when the whole section is omitted. |
| `evidence` | object | — | Evidence retention and storage settings. |
| `summaries` | object | — | Summary generation settings. |
| `retention` | object | {} | Retention sweep settings (issue #2483). |
| `review_passes` | object | — | Dual-pass security review settings. |
| `adversarial_detection` | object | — | Same-model adversarial checker detection settings. |
| `adversarial_testing` | object | { … } | Cross-model adversarial testing settings. |
| `integration_analysis` | object | — | Integration analysis settings. |
| `docs` | object | — | Documentation synthesizer (docs agent) settings. |
| `design_docs` | object | — | Structured design-doc generation (issue #1080, docs_design agent) — opt-in. |
| `git` | object | — | Git executable resolution override (issue #2236 hardening). |
| `ui_review` | object | — | UI/UX review (designer agent) settings. |
| `compaction_advisory` | object | — | Compaction advisory settings. |
| `lint` | object | — | Lint gate settings. |
| `secretscan` | object | — | Secret scanning settings. |
| `checkpoint` | object (strict) | — | Checkpoint settings. |
| `apply_patch` | object (strict) | — | Apply-patch opt-in fuzzy matching fallback (issue #1718). |
| `automation` | object | — | Background automation mode and per-feature toggles (v6.7 background-first rollout). |
| `knowledge` | object | — | Two-tier cross-project knowledge base (v6.17). |
| `memory` | object | — | Swarm memory substrate — disabled by default so existing flows are unchanged. |
| `learning` | object | — | Learning subsystem: real-time admission, PRM persistence, dedup sweep (issue #1821). |
| `consensus` | object | — | Consensus mining over completed run evidence (issue #1821). |
| `curator` | object | — | Phase context consolidation and drift detection. |
| `architectural_supervision` | object | — | Hierarchical summary review (issue #893). |
| `knowledge_application` | object | — | Knowledge-application contract (v2): warn or enforce modes, ack tracking. |
| `skillPropagation` | object | — | Skill propagation gate/injection settings. |
| `skill_improver` | object | — | Low-frequency, expensive-model skill improvement loop (issue #629, v2). |
| `harness_evolution` | object (strict) | — | Declarative, non-executing HarnessOpt mutation policy (issue #1825). |
| `spec_writer` | object | — | Spec writer agent (v2) — independent model for .swarm/spec.md authorship. |
| `tool_output` | object | — | Tool output truncation settings (enable/disable, max lines, per-tool overrides). |
| `slop_detector` | object | — | Slop detector settings (v6.29). |
| `todo_gate` | object | — | TODO gate (v6.32): warn or block on new high-priority TODOs (FIXME/HACK/XXX). |
| `incremental_verify` | object | — | Incremental verification settings (v6.29). |
| `compaction_service` | object | — | Compaction service settings (v6.29). |
| `prm` | object | — | PRM (Process Remediation Manager) settings. |
| `council` | object (strict) | — | Work Complete Council — parallel four-member verification gate, off by default. |
| `parallelization` | object | — | Parallelization (PR 1 dark foundation) — disabled by default; no production code path branches on enabled=true yet. |
| `worktree` | object | — | Worktree isolation policy for parallel coder dispatch lanes (general surface; Lean Turbo keeps its legacy per-mode fields). |
| `turbo` | object | — | Turbo execution strategy block (Phase 1). Absent means current behavior unchanged. |
| `turbo_mode` | boolean | false | Bypass reviewer/test gates for rapid iteration (v6.40). |
| `quiet` | boolean | true | Suppress non-critical startup warnings (default true keeps the TUI clean). Set false to restore verbose warnings for debugging. |
| `version_check` | boolean | true | Background staleness check against npm, throttled to once per 24h (issue #675). Set false to fully disable the network call. |
| `full_auto` | object | { … } | Full-auto autonomous orchestration with critic oversight: permission policy, denial accounting, oversight cadence triggers (v2 preserves v1 fields so existing configs load unchanged). |
| `pr_monitor` | object (strict) | — | GitHub PR subscription and polling (FR-001) — disabled by default; opt-in for real-time PR status updates. |
| `external_skills` | object | — | External skills: candidate model, discovery, and quarantine store (FR-001) — all subsystems opt-in. |
| `skills` | object | — | Opt-in gate for the 7 skill_* management tools (FR-004). Default false: the tools are host-denied for every agent except skill_improver (genuinely unreachable, not merely unlisted — issue #2528). |
| `skill_opt` | object (strict) | — | Governed skill optimizer (issue #1822). Disabled by default; /swarm skill-opt run requires enabled: true. All other subcommands are proposal-only/read-only by default. |

Sections marked `(strict)` reject unknown nested keys at config load time - a typo there makes the loader fall back to safe defaults with a startup warning. All other sections silently ignore unknown nested keys.

<!-- opencode-swarm: end generated top-level-config-keys -->

## Pricing fallback estimates

Provider-reported cost metadata wins when it is available. When a provider returns token usage but no cost, Swarm can estimate delegation cost from an optional top-level `pricing.models` table:

```json
{
  "pricing": {
    "currency": "USD",
    "version": "2026-08-29",
    "effective_at": "2026-08-29T00:00:00.000Z",
    "billing_basis": "token",
    "reported_cost_currency": { "provider": "USD" },
    "models": {
      "provider/custom-model": {
        "input_per_million": 1,
        "output_per_million": 2,
        "reasoning_per_million": 3,
        "cache_per_million": 0.5
      }
    }
  }
}
```

| Field | Required | Description |
|---|---:|---|
| `input_per_million` | yes | USD per 1M input tokens |
| `output_per_million` | yes | USD per 1M output tokens |
| `reasoning_per_million` | no | USD per 1M reasoning tokens; defaults to output pricing when omitted |
| `cache_per_million` | no | USD per 1M cache-read tokens; defaults to input pricing when omitted |

Table provenance is optional and bounded: `currency` is currently `USD`, `version` identifies the price table, `effective_at` is an ISO timestamp, and `billing_basis` is `token`, `request`, or `subscription`. Provider-reported amounts have unknown currency unless `reported_cost_currency` explicitly declares that provider as USD; unknown or conflicting currency remains evidence-inconclusive and is never treated as zero.

Missing usage or missing pricing degrades to `cost_source: "unavailable"` in telemetry and `/swarm costs`.

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

## Per-agent tool permissions (issue #2528)

The host only reads an agent's `tools` map for agents authored in a
configuration file — for plugin-injected agents (all 21+ swarm agents) that
field was dropped before the host ever saw it, so every per-agent tool deny the
plugin advertised was inert (audit finding HOST-1: 2,388 intended denies, 0
enforced at the pinned host `@opencode-ai/plugin` 1.18.3). The plugin therefore
enforces its per-agent boundaries through each agent's `permission` block — the
one field the host copies for plugin-injected agents and evaluates with
`Permission.disabled` when building each request:

- Every plugin tool that is not in an agent's effective allow-list
  (`tool_filter.overrides` → role map → feature-gated merges) carries an
  explicit `deny`. Host built-ins (`read`, `grep`, `glob`, `list`, `bash`,
  `task`, …), MCP tools, and unknown future tools are deliberately NOT managed
  here — they keep the host's defaults, and your own top-level
  `permission` config in `opencode.json` keeps working for them.
- Read-only roles (reviewer, critic, explorer, sme, researcher, curators)
  additionally deny the write family (`edit`, which the host evaluates as
  `edit`/`write`/`apply_patch`, plus `patch`). This floor is enforced even
  with `tool_filter.enabled: false` — it is each role's contract, not part of
  the filterable surface.
- Primary (architect) agents keep `task: "allow"` as the last entry of their
  block so delegation always wins under the host's last-match evaluation.
- Denied tools are removed from the agent's request by the host, so the model
  never sees their schema — the per-turn token cost of the full 129-tool
  surface is no longer paid by every role.

The FR-004 `skills.enabled: false` gate is now genuine unreachability: all 7
`skill_*` tools are host-denied for every agent except `skill_improver` (the
designed specialist, gated by `skill_improver.enabled`), even when a
`tool_filter` override names them.

Per-agent tool-schema *trimming* beyond this is not possible at this host
version: the host's `tool.definition` hook receives only a tool id and can
neither vary a definition per agent nor remove a tool. Permission denies and a
smaller registered tool set are the only levers on per-turn tool cost.

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

### full_auto

Full-Auto v2 — opencode-swarm's autonomy control plane. Reduces approval friction by deterministically allowing safe operations and routing ambiguous or high-risk operations through a `critic_oversight` review pass before they execute. As of the first-class toggle, runtime activation is decoupled from config enablement: a user activates Full-Auto per session via `/swarm full-auto on [mode]`, and `/swarm full-auto off` disarms (returns to normal interactive operation).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | **Deprecated as a gate.** Retained for backward compatibility with v1 configs. When `true`, fires the legacy init-time critic-model advisory; does NOT arm or disarm the v2 hooks. Use `locked` for a hard-off. |
| `locked` | boolean | `false` | Administrative hard-off. When `true`, `/swarm full-auto on` is refused at runtime (with an explicit error). `off` and `status` still work. The lock ORs across config levels: a repo-controlled project config cannot override a user-level `locked: true`. |
| `mode` | `assisted` \| `supervised` \| `strict` | `supervised` | Determines the classifier's escalation profile. `assisted` consults the critic only on deterministic policy escalations. `supervised` (default) routes risky/high-impact actions through the critic. `strict` routes ALL plan mutations through the critic. |
| `critic_model` | string | _(unset)_ | Optional override for the critic's model. Defaults to `agents.critic.model`. When both this and `agents.architect.model` are explicitly set to the same string, an advisory warns that independent judgment is weakened. |
| `max_interactions_per_phase` | number | `50` | Hard cap on architect interactions per phase. |
| `deadlock_threshold` | number | `3` | Consecutive `escalate_critic` verdicts before the run is paused. |
| `escalation_mode` | `pause` \| `terminate` | `pause` | What to do when denial or deadlock thresholds are hit. |
| `denials.max_consecutive` | number | `3` | Pause after N consecutive denials. |
| `denials.max_total` | number | `20` | Pause after N total denials in the session. |
| `protected_paths` | string[] | `['.git', '.github/workflows', '.opencode', '.swarm', 'package.json', 'package-lock.json']` | Paths the Full-Auto agent is forbidden from writing. `.opencode` is in the default list to prevent the agent from editing the plugin config that governs it. |
| `oversight.max_dispatch_retries` | number | `2` | Same-operation retry cap for transient critic infrastructure failures. |
| `oversight.max_consecutive_dispatch_failures` | number | `3` | Consecutive infrastructure failures before Full-Auto terminates to manual control. |
| `oversight.total_timeout_ms` | number | `120000` | Total wall-clock budget (1,000–300,000 ms) shared by critic session creation, prompt, retry/fallback, backoff, parse, and cleanup. |
| `oversight.cleanup_timeout_ms` | number | `2000` | Short cleanup bound (100–10,000 ms) that cannot extend the total oversight deadline. |

**Fail-closed semantics:**
- Activation refuses if a config file exists but cannot be loaded (corrupt JSON, oversized, permission error) — `locked` is treated as "unknown", not "false".
- A `paused` or `terminated` run blocks non-read-only work but keeps narrowly parsed diagnosis, oversight probe, repair, handoff, abort, resume, and exit controls reachable. `/swarm full-auto retry-oversight` is an infrastructure health probe only; it cannot clear a policy, containment, sandbox, or action circuit.
- A corrupt `.swarm/full-auto-state.json` fail-closed-blocks non-read-only tools project-wide; `/swarm full-auto status` reports this as `UNREADABLE` with the restore instructions.

**Example — refuse runtime activation entirely:**
```json
{
  "full_auto": {
    "locked": true
  }
}
```

**Example — change default mode to strict for all sessions:**
```json
{
  "full_auto": {
    "mode": "strict"
  }
}
```

### auto_review

Automatic review of a harness-constructed Git diff by the registered reviewer agent in a fresh, read-only ephemeral session. The reviewer model is resolved independently from the worker model, and eligible findings can be checked by the separate `critic_finding_validator` before they influence a gate.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | v7: `false`; v8+: `true` only with the approved burn-in pin | Master switch. An explicit user value always wins. |
| `trigger` | `"task_completion" \| "phase_boundary" \| "both"` | `"phase_boundary"` | Run after `update_task_status` → `completed`, from `phase_complete`, or at both boundaries. |
| `timeout_ms` | number | `300000` | Task-completion reviewer timeout (10s–30min). Also supplies `final_review.timeout_ms` only when that nested field is absent. |
| `max_diff_kb` | number | `256` | Task-completion diff cap (16–2048 KiB). Also supplies `final_review.max_diff_bytes` only when that nested field is absent. |
| `min_confidence` | number | `0.7` | Findings below this 0–1 threshold remain in receipts but are demoted to effective severity `info`. |
| `structured_findings` | boolean | `true` | Request the bounded structured findings block. Required when `final_review.mode` is `"gate"`. |
| `validate_findings` | boolean | `false` | Independently validate anchored, effective HIGH/CRITICAL findings in one fresh-context validator batch. Gate mode performs this validation even when this field is `false`. |
| `validation_model` | string or `null` | `null` | Validator model override. `null` resolves the registered `critic_finding_validator` model. |
| `validation_timeout_ms` | number | `120000` | Bound for the independent validator dispatch (10s–30min). |
| `final_review.on_phase_complete` | boolean | `true` | Run the whole-diff engine at non-final phase boundaries. |
| `final_review.on_plan_complete` | boolean | `true` | Run the whole-diff engine when the last durable plan phase completes. |
| `final_review.model` | string or `null` | `null` | Whole-diff reviewer model override. `null` resolves the registered reviewer model and fallbacks. |
| `final_review.mode` | `"advisory" \| "gate"` | `"advisory"` | Advisory injects findings without blocking. Gate enforces complete, current, persisted review and validation evidence. |
| `final_review.max_diff_bytes` | number | `262144` | Whole-diff cap (16 KiB–2 MiB), unless inherited from an explicitly provided `max_diff_kb`. |
| `final_review.timeout_ms` | number | `300000` | Whole-diff reviewer timeout, unless inherited from an explicitly provided top-level `timeout_ms`. |

Behavior:

- Task-completion review is fire-and-forget, session-keyed, and protected by a 60-second cooldown. It reviews tracked and safe untracked working-tree content without delaying the triggering tool call.
- Phase/plan review runs in the `phase_complete` body so the exact scope hash can be handed to an evidence-only gate. Default and phase scopes use a harness-computed merge base plus tracked and safe untracked working-tree content.
- The shared engine measures the replacement system prompt plus the fully rendered review prompt and forwards that exact byte allowance under a hard 3 MiB ceiling. This keeps every documented 16 KiB–2 MiB review scope dispatchable, including quote-heavy path inventories whose JSON rendering expands beyond their raw Git output size.
- When diff text reaches its cap, the collector adds a separately bounded NUL-safe changed-file inventory to durable scope evidence and the scope hash. If rendering every escaped path would cross the 3 MiB request ceiling, only the prompt inventory is shortened; its included, total, and omitted counts are explicit, the prompt/result mark that inventory incomplete, and durable evidence retains the collector's full bounded list. Automatic and manual results always label the review as an incomplete subset; a no-findings result never implies whole-diff coverage. The engine fails before dispatch only when the diff plus fixed review metadata cannot fit even after every fallback name is omitted.
- Structured findings receive stable SHA-256 IDs, are deduplicated, and must anchor to current-side changed lines. Unanchored, out-of-scope, or low-confidence findings remain durable caveats but cannot block.
- `critic_finding_validator` returns exactly one `CONFIRMED`, `DISPROVED`, or `UNVERIFIED` disposition for every eligible finding. Only anchored, effective HIGH/CRITICAL findings independently marked `CONFIRMED` block.
- Advisory mode records and injects ranked results but never blocks. Gate mode fails closed for truncated/incomplete scope, non-structured output, incomplete validation, missing required receipt/evidence, stale scope or policy, or confirmed blockers. A clean scope is valid with current clean evidence and does not need a finding receipt.
- Review receipts live under `.swarm/review-receipts/`; phase evidence lives at `.swarm/evidence/<phase>/auto-review.json`; task-completion events are appended to `.swarm/events.jsonl`. Fresh phase evidence is reused only when the HEAD, scope hash, and policy match.
- Lean Turbo keeps its existing phase reviewer. The generic advisory pass is skipped while Lean Turbo owns that phase; explicit gate mode still runs and cannot be turbo-bypassed.

Default resolution is presence-sensitive:

1. An explicit `auto_review.enabled` value always wins.
2. If `enabled` is absent, all v7 releases resolve it to `false`.
3. A v8+ release resolves it to `true` only when `AUTO_REVIEW_V8_BURN_IN_DECISION` is approved and pins `docs/benchmarks/auto-review-v8-cost-baseline.json` with its exact SHA-256. The committed baseline covers 30 fixed canonical-main diffs and is pinned as `b4e981d4d87e3de80f6d7dd4ae782b08159d385019c4d8b0d300c0443f1984ce`.
4. Explicit nested `final_review.timeout_ms` and `final_review.max_diff_bytes` win over legacy top-level fields. If a nested field is absent, explicitly supplied `timeout_ms` or `max_diff_kb` is inherited. Otherwise the nested defaults apply.

When `auto_review.enabled` is `true`, every returning reviewer Task delegation has its legacy verdict and structured findings parsed and persisted when unambiguous, independently of which automatic trigger is selected. Version-7 installations with auto-review disabled keep their legacy reviewer prompts and do not parse or persist structured Stage-B receipts.

#### Reviewer-scope evidence contract (v2 manifest)

Reviewer evidence is bound to an exact, versioned manifest — `reviewer-task-files-v2` — built from the coder generation's guardrail-observed writes:

- **Exact manifest identity.** Every file contributes its complete byte count and SHA-256, computed by a bounded-memory streaming capture (fixed 256 KiB chunks, `fstat` identity checks before and after, descriptor-first open with no-follow on POSIX). There are no per-file or aggregate byte caps on file identity: a file of any size is either fingerprinted exactly or the capture fails typed. A partial, sampled, or capped digest can never compare equal.
- **Automatic vs manual delivery.** `max_diff_kb` is a *delivery* budget only. Files whose bytes fit the budget are marked `inline` in the reviewer prompt manifest block; the rest are marked `manual` and the reviewer is instructed to inspect them through read-only tools against the recorded SHA-256. The budget never changes which files enter the manifest and never changes the manifest digest. The reviewer Task prompt receives a bounded `<reviewer_scope_manifest>` block carrying the manifest hash, HEAD, workspace identity, and per-file state; receipts persist that exact hash.
- **Root correctness.** The coder generation persists the canonical workspace identity (lane root for worktree-isolated coders, primary root otherwise) at dispatch time, and every capture/equality site reads from that root. Lane generations become reviewable from the primary checkout only after merge-back verification confirms the primary bytes match the lane manifest (`REVIEWER_SCOPE_MERGEBACK_VERIFIED` advisory). A merge conflict or deferred merge retains the generation in a typed `mergeback_pending` state — it is never relabeled as a generic reviewer-stale error.
- **Retry behavior.** Transient capture classes — HEAD timeout, HEAD movement during capture, file mutation during streaming, capture deadline — get a bounded inline retry (3 attempts / 10 s). Exhausted retries throw a typed `REVIEWER_CAPTURE_RETRY_EXHAUSTED` and RETAIN the generation for an architect retry or explicit manual review; infrastructure failure never discards evidence. A genuine byte change after the coder's post-write capture is `REVIEWER_SCOPE_STALE` and discards the generation — retry can never turn a real change into equality. Permanent classes (symlink/reparse, non-regular, unreadable, outside-workspace, workspace mismatch) are typed `REVIEWER_CAPTURE_FAILED:<code>` with an `ACTION[architect]` recovery step.
- **No-change semantics.** A successful coder with zero guardrail-observed writes AND a verified clean `git status` completes the generation as `no_change` (`coder_no_change` transition): no reviewer pass is owed, no review debt is created, and reviewer/test/task gates do not advance from it. The architect may re-dispatch the coder if changes were intended. Zero observed writes with a dirty tree stays `collecting` with an actionable `REVIEWER_SCOPE_UNATTRIBUTED_CHANGE` advisory (changes escaped guardrail observation).
- **Legacy v1 receipts.** Receipts recorded before the v2 manifest (description `reviewer-task-files-v1`) can never satisfy a v2 rebuild: every scope this build constructs carries the v2 description, and the receipt's content-hash comparison fails closed on any v1-shaped scope. No v1 evidence is reinterpreted or backfilled and no v1 scope object is ever constructed.
- **Retention bounds.** Unclaimed reviewer-scope generations sweep at the 2-hour idle TTL, EXCEPT the actionable merge-back states (`mergeback_pending` / `mergeback_mismatch`), which are retained until merge-back settles, same-task supersession replaces them, or the 256-generation capacity evicts them.
- **Capture latency bound.** Capture is synchronous on the tool-after hook: worst-case stall is the 10 s batch deadline plus one 256 KiB chunk read per attempt (self-terminating via the typed `capture_deadline`); a 100 MiB file hashes in ~0.1 s on a warm cache. A lane left with stale untracked files from a prior run can surface `REVIEWER_SCOPE_UNATTRIBUTED_CHANGE` for a coder that wrote nothing — inspect the lane before re-dispatching.

```json
{
  "auto_review": {
    "enabled": true,
    "trigger": "both",
    "min_confidence": 0.7,
    "validate_findings": true,
    "final_review": {
      "mode": "advisory",
      "on_phase_complete": true,
      "on_plan_complete": true
    }
  },
  "agents": {
    "reviewer": {
      "model": "anthropic/claude-sonnet-4-6",
      "fallback_models": ["opencode/big-pickle"]
    },
    "critic_finding_validator": {
      "model": "opencode/big-pickle"
    }
  }
}
```

At the pinned v8 advisory policy, the deterministic baseline models one reviewer call and no validator call per phase. Across its 30 fixed diffs, estimated reviewer input was 1,380 tokens minimum, 2,438 p50, 50,480 p95, and 88,121 maximum, with an 800-token output budget requested by the reviewer contract. It deliberately leaves USD cost null because a source-only benchmark has neither provider-reported usage nor runtime pricing. Runtime `delegation_end` telemetry and `/swarm costs [--json]` are authoritative for observed token and cost usage.

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
| `enabled` | boolean | `true` | Master switch for Curator |
| `init_enabled` | boolean | `true` | Run Curator at session start |
| `phase_enabled` | boolean | `true` | Run Curator at phase boundaries |
| `postmortem_enabled` | boolean | `true` | Run postmortem curator analysis during closeout |
| `max_summary_tokens` | number | `2000` | Max tokens for Curator summary output |
| `min_knowledge_confidence` | number | `0.7` | Minimum confidence threshold for knowledge entries |
| `compliance_report` | boolean | `true` | Include compliance report in phase digest |
| `suppress_warnings` | boolean | `true` | Suppress TUI warnings; emit events only |
| `drift_inject_max_chars` | number | `500` | Max chars for drift report summary injected into architect context |
| `llm_timeout_ms` | number | `300000` | Timeout for Curator init and phase LLM calls |
| `skill_generation_enabled` | boolean | `true` | Enable curator-generated skill candidate output |
| `skill_generation_mode` | `draft` \| `active` | `draft` | Controls whether skill candidates are drafted or promoted as active skills |
| `min_skill_confidence` | number | `0.7` | Minimum confidence for generated skill candidates |
| `min_skill_confirmations` | number | `2` | Minimum confirmations before skill promotion |

Curator is enabled by default. Set `curator.enabled = false` to disable it. When enabled, it writes `.swarm/curator-summary.json` and `.swarm/drift-report-phase-N.json` to track knowledge alignment and drift detection. Curator uses directory-level knowledge locking for cross-file updates; this favors simple atomic consistency over per-file parallelism.

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

### Git (`git`)

Hardening for git-executable resolution (issue #2236). Optional override for
the git binary the plugin invokes, ahead of the built-in platform/PATH
candidate list (`src/utils/git-executable.ts`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `binary` | string | _(unset)_ | Absolute path to the git executable to try first. **User-level config only** — see below. Non-empty-string-validated at load; usability (absolute path, exists, output matches `git version <n>.<n>`) is checked by the resolver itself — an unusable value is skipped with a warning, never fatal |

> **`git.binary` is ignored in a project config.** This key is honored **only**
> from the user-level config (`<config dir>/opencode/opencode-swarm.json`) and
> the `OPENCODE_SWARM_GIT_BINARY` environment variable. A value set in a
> repository's `.opencode/opencode-swarm.json` is **dropped with a warning**
> and never used.
>
> The reason is that `git.binary` selects the executable the plugin spawns for
> every git command it runs, while the project config file lives *inside the
> repository* — so a repository could ship both a config naming a shim and the
> shim itself, and the shim would then run with your privileges the moment you
> opened the repo (CWE-427). If you need a per-machine git, set it in your user
> config or the environment variable; there is no per-repository form of this
> option.

The environment variable `OPENCODE_SWARM_GIT_BINARY` always takes precedence
over `git.binary` when set — it is the escape hatch a blocked user can set
without editing a config file. When neither is set, or the configured value
is unusable, the resolver falls through its built-in candidate list
(platform-specific absolute paths, then every `git` match on `PATH`, then the
bare `git` name as a last resort) — see `describeGitResolution()` for a
diagnostic of the most recent probe cycle.

A candidate is accepted only if `<candidate> --version` exits 0 **and** prints
git's own `git version <major>.<minor>…` line. A program that exits 0 while
printing anything else is rejected, so an arbitrary executable cannot be
mistaken for git — this applies to the environment variable and every
automatically discovered candidate too, not just the config value.

### GitHub CLI (`gh`)

Related hardening (issue #2476): the gh executable the plugin invokes for
`gh`-backed features (`pr.ts`, `gh_evidence`, pr-monitor status) is resolved
by `src/utils/gh-executable.ts` with the same candidate discipline as git:
platform absolute locations first, then every `gh` match on `PATH` (accepted
only if `<candidate> --version` exits 0 and prints gh's own
`gh version <major>.<minor>…` line), then the bare `gh` name as a terminal
fallback.

There is deliberately **no `gh.binary` config key** — the only override is the
environment variable:

| Env var | Description |
|---------|-------------|
| `OPENCODE_SWARM_GH_BINARY` | Absolute path to the gh executable to try first. An unusable value (relative, missing, or failing the version probe) is skipped with a warning and the resolver falls through its built-in candidate list — it never breaks gh availability. |

Like `OPENCODE_SWARM_GIT_BINARY`, this is a user/machine-level escape hatch; no
repository-supplied value can ever name a gh candidate. See
`describeGhResolution()` for a diagnostic of the most recent probe cycle.

### Memory

Optional scoped memory substrate for recall and proposal-only memory writes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable agent access to `swarm_memory_recall`, `swarm_memory_propose`, and `swarm_memory_outcome` |
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
| `reflection.enabled` | boolean | `false` | When `memory.enabled=true`, regenerate `.swarm/reflections/lessons.{md,json}` and allow bounded system-prompt reflection injection |
| `reflection.halfLifeDays` | number | `30` | Half-life used for signed outcome decay |
| `writes.mode` | string | `"propose"` | Normal agents can only create proposals |
| `redaction.rejectDurableSecrets` | boolean | `true` | Reject durable memories that contain likely secrets |
| `redaction.detectPii` | boolean | `false` | Run the PII detector over durable memory text at the write boundary and attach a types/score summary to proposals (issue #1466) |
| `redaction.piiDetector` | `"regex" \| "ner"` | `"regex"` | PII detector implementation: `regex` (dependency-free) or `ner` (requires the optional `@xenova/transformers` peer dependency; typed error when absent) |
| `redaction.rejectDurablePii` | boolean | `false` | Reject durable memory proposals whose PII score exceeds `piiThreshold`; rejections are logged to the memory audit log (SQLite provider) as `pii_rejected` (types/score only, never matched text) |
| `redaction.piiThreshold` | number | `0.7` | PII score threshold (max finding confidence) above which durable memories are rejected. Exclusive: a finding rejects only when its score is strictly GREATER; must be < 1 (scores never reach 1, so 1 would silently disable rejection and is rejected at parse) |
| `maintenance.lowUtilityMaxConfidence` | number | `0.45` | Confidence threshold used by `/swarm memory stale` low-utility reporting |
| `maintenance.lowUtilityMinAgeDays` | number | `30` | Age threshold used by `/swarm memory stale` low-utility reporting |

Memory stores durable state in `.swarm/memory/memory.db` by default. Legacy JSONL files under `.swarm/memory/` are migrated once into SQLite, backed up, and remain available through `memory.provider="local-jsonl"` for legacy/debug mode. Recall is scope-filtered and labels retrieved memory as untrusted background. Proposals do not become durable memory without curator or trusted gateway review. Reflection remains off unless both `memory.enabled` and `memory.reflection.enabled` are true. See [Swarm Memory](memory.md).

### PR Monitor

GitHub PR subscription and background polling infrastructure (FR-001). When enabled, the architect can subscribe to GitHub PRs and receive real-time status updates via the AutomationEventBus. Uses the `gh` CLI for all GitHub API calls; requires `gh` to be authenticated (`gh auth login`).

**Auto-subscribe**: when `pr_monitor.enabled: true` is set, PR monitoring is available without an additional feature flag — sessions can subscribe to PRs immediately via `/swarm pr subscribe`. In addition, when `auto_subscribe_on_pr_create` (default `true`) is set, a successful `gh pr create` run through the bash tool automatically subscribes the current session to the created PR — no manual command needed.

**Durable store**: subscription state is persisted to a bounded, crash-safe checkpoint at `.swarm/pr-monitor/subscriptions.checkpoint.json` (latest record per `correlationId` = sessionID + repoFullName + prNumber), with a bounded transition-audit tail at `.swarm/pr-monitor/subscriptions.audit.jsonl` (issue #2042). Reads are bounded by the live set — never by history. Pre-#2042 append-only `subscriptions.jsonl` logs migrate in crash-resumable 1 MiB chunks with an 8 MiB mutation budget plus at most one valid-record boundary (64 KiB); oversized corrupt lines are discarded incrementally, a larger in-budget source returns a retryable migration-in-progress error after the cursor is persisted, and sources above the 64 MiB admission ceiling refuse mutations before checkpoint publication and surface a repair hint. The cursor carries a bounded pre-migration baseline so a replaced legacy generation can restart cleanly without retaining stale folded records or dropping native subscriptions that existed before migration began. Archive replacement keeps the prior archive in a bounded rollback slot until the new candidate is verified and installed. Multiple sessions may independently subscribe to the same PR using a composite key. `/swarm pr status` surfaces storage health (checkpoint age, counts, bytes/pressure, corrupt/dropped counters, recovery resets, recovery source). A copied or moved store rebinds only after quarantining the foreign checkpoint and any co-copied legacy log to bounded slots; if quarantine cannot complete, the mutation fails closed and the existing state is preserved.

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
| `notify_merge_conflict` | boolean | `true` | Emit notification on merge conflict detection and resolution (`pr.merge.conflict` + `pr.merge.conflict_resolved`) |
| `notify_review_activity` | boolean | `true` | Emit notification on review state changes (`pr.review.changes_requested` + `pr.review.approved`) |
| `notify_merged` | boolean | `true` | Emit notification when the PR is merged (terminal event) |
| `notify_closed` | boolean | `true` | Emit notification when the PR is closed without merge (terminal event) |
| `notify_ci_success` | boolean | `false` | Emit notification when CI recovers / all checks pass (quiet by default) |
| `auto_pr_feedback` | boolean | `false` | When enabled, CI failure and merge-conflict events mechanically establish PR_FEEDBACK before routing fix work. Events arriving during PR_REVIEW or after a PR_FEEDBACK inventory freezes are durably queued and delivered mode-neutrally for a later round; they never override the active controller. |
| `event_delivery` | string | `"prompt"` | `"prompt"` wakes the subscribed session with a structured `<pr-activity>` message via the SDK session prompt; `"advisory"` is the legacy passive channel (session advisories surface on the next model turn) |
| `auto_subscribe_on_pr_create` | boolean | `true` | Automatically subscribe the session to a PR created via `gh pr create` in a bash tool call |

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

**GH CLI wrappers** (`src/git/pr.ts`): since the #1660/#2471 poll consolidation, each per-PR poll issues exactly two `gh` spawns — one `gh pr view --json` snapshot (`getPRPollSnapshot`, returning status, merge state, review decision, and the full issue-comment list in a single payload) plus one `gh api repos/N/pulls/M/comments` call (`getPRReviewComments`) for inline review comments, which have no `gh pr view --json` equivalent. The five pre-consolidation wrappers (`getPRStatus`, `getPRChecks`, `getPRComments`, `getMergeState`, `getPRReviewState`) were removed; callers consume `PRPollSnapshot` instead.

Both remaining wrappers use `_internals.ghExecAsync` — they share the same DI seam pattern (see `gitignore-warning.ts:_internals`). No synchronous `ghExec`-based wrappers are currently exposed for PR monitoring.

**Polling worker** (`src/background/pr-monitor-worker.ts`): `PrMonitorWorker` is a standalone background class with start/stop/dispose lifecycle. It implements **two-phase change detection**:
1. `computeChanges()` — fetches current PR state (status, comments, merge, review) via async gh wrappers, then diffs against the last stored snapshot to produce a list of events and snapshot updates
2. `applyChanges()` — atomically emits events and persists snapshot updates

The worker is **lazily started** on first subscription (gated by `pr_monitor.enabled`). It is **timeout-guarded** — each per-PR poll races a `poll_timeout_ms` deadline, and `isTimedOut` closures guard every state mutation so late results never clobber the snapshot after a timeout. Plugin wiring in `src/index.ts` registers a `process.on('exit')` cleanup handler that stops the worker and unregisters event subscribers/delivery on shutdown. Stale subscriptions are removed via `sweepStale()` on each cycle.

**Event subscribers** (`src/background/pr-event-subscribers.ts`): subscribers attach to the AutomationEventBus for all nine gated event types (`pr.ci.failed`, `pr.ci.passed`, `pr.new.comment`, `pr.merge.conflict`, `pr.merge.conflict_resolved`, `pr.review.changes_requested`, `pr.review.approved`, `pr.merged`, `pr.closed`) and deliver each event to every subscribed session. Delivery chooses one channel per event+session (at-least-once: a wake accepted after the acceptance timeout can duplicate onto the advisory channel; duplicates share a dedup token):
- **Wake delivery** (`event_delivery: "prompt"`, default — `src/background/pr-event-delivery.ts`): the subscribed session is woken with a structured `<pr-activity>` message via the SDK session prompt, so idle sessions act on events immediately. Per-session queues are bounded (20 events, drop-oldest) with FIFO session eviction; events arriving while the session is busy are coalesced into one wake message flushed on `session.idle`. On wake failure the event falls back to the advisory push.
- **Advisory delivery** (`event_delivery: "advisory"`, legacy): events queue as session-scoped advisories with dedup tokens and surface on the session's next model turn.

After a successful delivery the subscription's `hasUnaddressedEvents` flag is cleared, so delivered events no longer exempt the subscription from the TTL sweep indefinitely.

### pr_review_resilience

Controls staged canary/fanout resilience for Profile A `PR_REVIEW` base waves.
**Disabled by default** (issue #2381): the legacy single-wave base dispatch is
the default path at every depth tier while the #2380 PR-review repair program is
incomplete. When explicitly enabled, depth tiers M and L must run each base
attempt as a singleton canary batch followed by a fanout batch for the remaining
unresolved obligations. Attempt 0 plus at most two retry attempts are allowed.
Tier S always keeps the legacy single-wave base dispatch.

The resilience circuit (issue #2382) counts only durable, typed terminal
provider failures: a lane settled as an error with a structured provider
classification. Observer deadlines, missing host clients, parser rejections,
policy gates, filesystem/Git errors, cancellations, and presumed-stale
observations never open, reopen, or close it. The threshold counts distinct
failed lanes per provider class — never owned dimensions, never repeated
collections of the same lane. An opened circuit blocks only new resilience
retry dispatch; collect, diagnose, cancel, abort, gap reporting, and disabling
this config block all remain available. After `circuit_open_duration_ms` the
circuit admits exactly one recovery canary probe: a typed provider failure
reopens it with a fresh interval, a success closes it and clears the evidence,
and an inconclusive outcome restarts the cooldown without changing any state.
Circuits that were persisted by older, unversioned plugin builds migrate once
to a closed, non-blocking record whose historical evidence is waterlined. The
current `enabled` value is always authoritative: flipping it to `false`
disarms an already-admitted workflow immediately (the persisted circuit stays
on disk for audit only), and re-enabling later starts from a clean closed
generation that cannot resurrect pre-disable evidence. Residual caveat: if the
process crashes in the instant between the config flip and the next dispatch,
the disable marker write can be lost; the circuit is inert the whole time
resilience stays disabled, and after a later re-enable an already-open
circuit recovers through the normal probe cycle instead of receiving the
clean reset.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable staged canary/fanout base-wave resilience for Profile A PR review. The default `false` uses the legacy one-wave base dispatch; set `true` to opt in. |
| `canary_probe_ms` | number | `300000` | Milliseconds to wait before probing whether an unresolved canary lane is still live (1–3600000). |
| `status_probe_timeout_ms` | number | `2000` | Deadline for the bounded status probe that decides whether a canary is still live before admitting a later retry (1–60000). |
| `correlated_failure_threshold` | number | `2` | Number of distinct terminal provider-failed lanes of the same provider class that opens the resilience circuit and blocks further staged attempts (2–8). One consolidated lane counts once regardless of how many dimensions it owns, and repeated collections of one lane count once. |
| `max_retry_attempts_after_initial` | number | `2` | Maximum retry attempts after attempt 0. The controller therefore allows attempts 0, 1, and 2 by default (0–2). |
| `circuit_open_duration_ms` | number | `60000` | How long an opened resilience circuit stays open before it admits exactly one recovery canary probe (1000–1800000). Applies to the initial open and to every provider-failure reopen. |

**Example** — opt in to staged canary/fanout resilience (off by default):

```json
{
  "pr_review_resilience": {
    "enabled": true
  }
}
```

**Example** — the default: staged canary/fanout off, legacy one-wave base dispatch:

```json
{
  "pr_review_resilience": {
    "enabled": false
  }
}
```

### pr_review_legacy_transcript_compatibility

Controls the deprecated transcript-row fallback for Profile A `PR_REVIEW`
base and micro discovery lanes.

Default: `false`. When omitted or `false`, newly dispatched Profile A
discovery lanes are structured-only: they must settle through exactly one
`submit_pr_review_result` receipt, and later prose, truncation, or transcript
incompleteness cannot replace that receipt. The legacy `[CANDIDATE]` and
`[CLEAN]` transcript rows remain a migration-only compatibility path.

Enable this only to collect legacy in-flight lanes or to interoperate with an
older host during the migration window. The compatibility decision is snapped
into each dispatched lane, so toggling the config later does not silently widen
or strand an already-running review. A present-but-invalid structured result
still fails closed and never falls back to transcript parsing.

Profiles B/C are unchanged by this setting: without the Profile A controller,
their lane transcripts remain the native exchange surface.

Structured submissions persist background-delegation schema v4 records. Before
downgrading to a binary without schema v4 support, drain active structured
reviews or apply a compatible migration/reader. An older lenient reader skips
the entire unknown v4 record, so the lane appears absent and later mutations
become no-ops; strict recovery rejects the store as incompatible and fails
closed. Neither outcome preserves an active structured review.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pr_review_legacy_transcript_compatibility` | boolean | `false` | Opt in to the deprecated transcript-row fallback for Profile A PR-review base/micro discovery lanes during migration. |

**Example** — temporarily enable the legacy transcript fallback:

```json
{
  "pr_review_legacy_transcript_compatibility": true
}
```

### todo_gate

Controls the TODO gate that warns about new high-priority TODO/FIXME/HACK comments introduced during a phase.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the TODO gate |
| `max_high_priority` | number | `0` | Maximum allowed new high-priority TODOs (FIXME/HACK/XXX) before warning. `0` means warn on any occurrence. Set to `-1` to disable the threshold check. |
| `block_on_threshold` | boolean | `false` | If `true`, block phase completion when the threshold is exceeded. If `false`, the gate is advisory only (warns but does not block). |

The TODO gate scans for new `TODO`, `FIXME`, and `HACK` comments introduced in the current phase and compares the count against `max_high_priority`. The count is included in the `todo_scan` field returned by the `check_gate_status` tool.

### skillPropagation

Intelligent skill tracking, scoring, and recommendation system for agent delegations.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable automatic discovery, scoring, warnings, recommendations, and injection. Explicit `SKILLS:` integrity remains enforced. |
| `enforce` | boolean | `false` | When `true`, block delegations missing the `SKILLS:` field. Advisory mode (default) only warns. |
| `audiences` | string[] | `[]` | Project/domain tags accepted in addition to `swarm-plugin` (maximum 16 lowercase tokens, 64 characters each). Reserved `swarm-plugin` and `runner:*` values are rejected. |

**What it does:**
- Logs all skill delegations to `.swarm/skill-usage.jsonl` with session-scoped entries
- Scores available skills by relevance based on frequency, compliance, recency, and task diversity
- Provides recommendations when delegating without a `SKILLS:` field
- Auto-populates `.swarm/context.md` with an "Available Skills" section
- Supports explicit routing via `.opencode/skill-routing.yaml` (Phase 2)
- Filters tagged skills by project/domain audience and the active `runner:opencode` dimension

**Guardrails:**
- Relevance scoring threshold: 0.5 (skills below this are not recommended)
- Maximum recommendations per delegation: 5
- Scoring budget safeguard: Skipped when session exceeds 500 skill-usage entries
- Graceful degradation: Zero installed skills = zero friction (no warnings, no blocks)
- Explicit `SKILLS:` references must resolve to a readable, in-project SKILL.md with valid frontmatter and a matching audience even when automatic propagation is disabled

**Example:**

```json
{
  "skillPropagation": {
    "enabled": true,
    "enforce": false,
    "audiences": ["ragappv3"]
  }
}
```

Skill frontmatter may declare one domain or a bounded list of domain and runner constraints:

```yaml
audience: ragappv3
# or
audience: [ragappv3, runner:opencode]
```

Domain values use OR semantics with other domain values; `runner:*` values use OR semantics with other runner values; the two dimensions are ANDed. Thus `[ragappv3, runner:claude]` does not match an OpenCode runner even when the project accepts `ragappv3`. An absent audience remains unscoped/match-all for backward compatibility; an explicitly empty or malformed audience fails closed.

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

## Guardrails — loop containment (`guardrails`)

Two escalation ladders bound the failure modes where an agent keeps burning
turns without making progress (issue #2063). Both are per-session, in-memory,
and additive to the existing `guardrails` block — omit them and the defaults
below apply.

### Gate-denial escalation

Every fail-closed `tool.execute.before` hook (guardrails authority, scope
guard, delegation gate, PR-workflow obligations, Full-Auto) blocks a tool call
by throwing. Nothing previously counted how many times the *same* denial was
re-triggered, so an agent could re-issue an identical rejected dispatch
indefinitely. Denials are now classified by the leading code token of the error
message (`ACCEPTANCE_FIELD_REQUIRED`, `SCOPE_NOT_DECLARED`, …) and counted per
session, tool, and code.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gate_denial_warn_threshold` | number (≥ 1) | `3` | Consecutive same-cause denials before "do NOT retry the same dispatch" guidance is appended to the denial text the agent reads. |
| `gate_denial_stop_threshold` | number (≥ 1) | `5` | Consecutive same-cause denials before the denial additionally carries a hard STOP directive, an advisory is queued, and a `gate_denial_loop` telemetry event is emitted. |

The agent prompts separately instruct stopping after **2** failed self-recovery
attempts for the same error code — deliberately stricter than this mechanical
3/5 ladder, which is the backstop for an agent that ignores its prompt.

Guidance is **appended only** — the original message, and therefore the leading
code token, is preserved byte-for-byte, and the error still propagates so the
tool call is still rejected. User cancellations (`AbortError`) are excluded
entirely: they neither count toward a streak nor clear one.

A streak is tracked per (session, tool, dispatch target, cause) and resets only
when the chain lets *that* tool through *for that dispatch target* — so a
successful `Task` to `explorer` does not clear an in-progress denial loop
against `coder`. Denials whose message carries no recognizable leading code
token are pooled under a single `UNCLASSIFIED` bucket; that bucket can still
reach `gate_denial_warn_threshold`, but never the STOP rung, because repeats
there are not evidence of one repeating cause.

### Execution-stall ladder

Bounds a session that is armed for execution (a subagent dispatch was attempted,
or a task moved to `in_progress`) but keeps making tool calls that produce no
progress event.

An episode disarms — resetting every counter — on **either** of two conditions:

- **Idleness**: `execution_stall_episode_minutes` with no tool calls at all.
  Idleness, not elapsed time since arming, so a long slow stall still reaches
  the hard rung.
- **No open task**: the plan carries no task with status `in_progress`. Checked
  right after a status update settles a task, and again on the periodic
  workspace probe so an out-of-band plan change is picked up too. This is what
  keeps a session that finishes its execution phase and moves on to commit, CI,
  and reporting work from being denied. A missing or unreadable plan is *not*
  treated as "no open task" — only a plan that parses and has zero `in_progress`
  tasks disarms.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `execution_stall_warn_calls` | number (≥ 1) | `30` | Non-progress tool calls in an armed episode before a strong advisory fires. |
| `execution_stall_stop_calls` | number (≥ 1) | `60` | Non-progress tool calls before read/glob/grep/bash are hard-denied. Delegation, `update_task_status`, plan/status/query tools, and advisory surfacing always remain allowed. |
| `execution_stall_episode_minutes` | number (≥ 1) | `30` | Minutes of complete tool inactivity after which the episode disarms and all counters reset. The no-open-task disarm above is unconditional and not configurable. |

**Example** — tighter denial containment, looser stall budget:

```json
{
  "guardrails": {
    "gate_denial_warn_threshold": 2,
    "gate_denial_stop_threshold": 3,
    "execution_stall_warn_calls": 50,
    "execution_stall_stop_calls": 100
  }
}
```

### Sandbox enforcement requirements (`guardrails.sandbox`)

`guardrails.sandbox` makes containment requirements explicit. The default
`advisory` mode preserves existing fail-open behavior and records a one-time
warning plus audit event when containment is unavailable. `required` mode
blocks a shell command before mutation or execution unless every requested
dimension is reported `real` by the capability probe.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `advisory` | `required` fails closed; `advisory` warns and audits. |
| `require_filesystem` | `false` | Require real filesystem containment. |
| `require_network` | `false` | Require real network containment. |
| `require_process` | `false` | Require real process containment. |
| `network_mode` | `off` | Requested network posture (`off` or `on`). |
| `network_allowlist` | `[]` | Bounded network allowlist used for capability identity. |
| `writable_roots` | `[]` | Additional bounded writable roots used for capability identity. |

The status surface reports filesystem, network, process, and effective
strength separately as `real`, `weak`, or `none`. Linux reports missing
seccomp explicitly; macOS does not claim network/process containment; Windows
fallbacks remain weak/none unless independently verified.

### macOS sandbox activation (`guardrails.sandbox_macos_enabled`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sandbox_macos_enabled` | boolean | `false` | Enables `sandbox-exec` containment for bash/shell tool calls on macOS. |

Issue #2236 (RC2) found that the macOS sandbox availability probe invoked
`sandbox-exec --version` — a flag that does not exist in `sandbox-exec(8)`'s
BSD-getopt argument grammar. The invalid flag made the probe fail on **every**
macOS host, so `MacOSSandboxExecutor` has never actually activated in
production; bash/shell commands ran unsandboxed with only tool-layer
enforcement, silently. The probe is now corrected (gates on exit code 0 only,
never on stdout/stderr content) and shares its SBPL profile shape with the
production profile, so probe success reliably implies the production
profile's primitives parse.

That correction alone is not sufficient to turn the sandbox on by default.
The production profile's last-match-wins primitive ordering
(`src/sandbox/macos/sandbox-exec-executor.ts`, see the `buildSandboxProfile`
doc comment) is reasoned from documented SBPL semantics but has not been
empirically re-verified against a real macOS host's `sandbox-exec` from this
project's Windows/Linux development environments. If that ordering is wrong,
every declared scope write would be denied and bash would break for macOS
users — strictly worse than today's fail-open (unsandboxed) behavior.

`sandbox_macos_enabled` therefore defaults to `false`. When `false`,
`getExecutor()` behaves exactly as it did before the probe fix: it resolves
to `null`, and every consumer (`applySandboxExecution`, `/swarm diagnose`)
reports the same "executor not available, running unsandboxed" state as
before. Set it to `true` only after verifying the production SBPL profile on
a real macOS host — for example, confirming that a command targeting an
in-scope path succeeds and a command targeting an out-of-scope path is denied
under a real `sandbox-exec -f <profile>` invocation.

When enabled on macOS, `applySandboxExecution` also applies the DYLD
injection-variable hardening declared by
`MacOSSandboxExecutor.getEnvOverrides()` — unsetting `DYLD_INSERT_LIBRARIES`,
`DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, and `DYLD_ROOT_PATH`, and pinning
`PATH` to the base-OS bin directories — baked into the wrapped command via
SBPL `(setenv)`/`(unsetenv)` primitives. This wiring is macOS-only: Windows
and Linux `getEnvOverrides()` implementations remain unwired in this release
(Windows strong mode's `PATH: null` would be a separate, riskier behavior
change applied to real commands for the first time).

```json
{
  "guardrails": {
    "sandbox_macos_enabled": true
  }
}
```

## PRM

Controls the Process Remediation Manager (PRM) — the subagent-session trajectory
monitor that detects stuck-loop patterns (repetition, ping-pong delegation,
scope drift, test-fix cycling, context thrash) and escalates course-correction
guidance to the agent before a hard stop.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for PRM trajectory monitoring. When `false`, no trajectory entries are recorded and no patterns are detected. |
| `pattern_thresholds.repetition_loop` | number (≥ 1) | `2` | Occurrences before a "same agent, same file, same action within N steps" loop is flagged. |
| `pattern_thresholds.ping_pong` | number (≥ 1) | `2` | Occurrences before an alternating A→B→A delegation pattern targeting the same file is flagged. |
| `pattern_thresholds.expansion_drift` | number (≥ 1) | `3` | Occurrences before successive plans whose unique-target scope grows by more than 50% are flagged. |
| `pattern_thresholds.stuck_on_test` | number (≥ 1) | `3` | Occurrences before an edit → test-fail → edit-same-file cycle is flagged. |
| `pattern_thresholds.context_thrash` | number (≥ 1) | `10` | Consecutive steps before a monotonically increasing unique-target set (no plateaus) is flagged. Raised from `3` in #2134: three consecutive new targets is indistinguishable from an agent simply reading three files. |
| `escalation_enabled` | boolean | `true` | Enable the count-based escalation ladder (advisory → hard stop) once a pattern's threshold is met repeatedly. |
| `max_trajectory_lines` | number (≥ 10, ≤ 10000) | `1000` | Maximum trajectory entries retained per session before older entries are evicted. Upper bound caps the emergent per-project trajectory footprint (#2041). |
| `detection_timeout_ms` | number (≥ 10) | `100` | Bounded time budget for a single pattern-detection pass; detection is skipped (fail-open) if it would exceed this. |

**Example** — tighten the repetition-loop and ping-pong thresholds:

```json
{
  "prm": {
    "enabled": true,
    "pattern_thresholds": {
      "repetition_loop": 1,
      "ping_pong": 1
    }
  }
}
```

### How the escalation ladder counts (issue #2134)

A strike is recorded per **occurrence**, not per detection. Detectors re-emit the
same ongoing episode on every tool call with a growing end step — a coder reading
one more file extends its single `context_thrash` run — so PRM keeps a per-session
ledger of the episodes that have already struck. A match earns a strike only when
it is a **new episode**, or when the episode it belongs to has grown by another
full `pattern_thresholds` worth of occurrences since it last struck. A single tool
call can never advance the ladder by more than one rung.

Strikes are also counted per **behaviour**, not per pattern type. A pattern that
names a single target — `repetition_loop`, `ping_pong`, `stuck_on_test` — gets its
own 1→2→3 ladder for that target, so repeating yourself once each on three
different files is three level-1 advisories rather than a hard stop; reaching the
hard stop takes three strikes against *the same* target. Patterns that report a
growing set of targets (`context_thrash`, `expansion_drift`) keep one ladder for
the pattern, because a per-target ladder would restart on every tool call and they
could never escalate at all.

An agent that genuinely keeps going still reaches the hard stop, because the
growth rung keeps firing. At default thresholds an unbroken `repetition_loop`
strikes at 2, 4 and 6 occurrences; a `context_thrash` run strikes at 10, 20 and 30
consecutive brand-new targets with no revisits. What can no longer happen is a
hard stop earned by making tool calls rather than by repeating the behaviour.

### Clearing a stuck escalation

PRM escalation state is per session and entirely in memory — it is never written
to `.swarm/session/state.json`, and a rehydrated session always starts at level 0.
Two things clear it:

- **A new delegation with a declared scope.** When a Task dispatch claims a coder
  scope binding, the child session's PRM state is reset, so a coder never inherits
  a previous delegation's escalation level or an armed hard-stop token. A dispatch
  that never declares a scope (`SCOPE_NOT_DECLARED`) does not reach that reset.
- **`/swarm reset-session`.** Clears escalation counts, both hard-stop tokens, the
  trajectory cursor, and the episode ledger for every tracked agent session, while
  preserving the plan, evidence, and knowledge stores.

```bash
/swarm reset-session
```

To disable the ladder entirely while leaving pattern detection and its telemetry
in place, set `prm.escalation_enabled` to `false`; to turn PRM off altogether, set
`prm.enabled` to `false`.

## Phase Complete Configuration

Controls phase completion gating and validation.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable phase completion validation |
| `required_agents` | string[] | `["coder", "reviewer", "test_engineer"]` | Agents that must be dispatched before a phase can complete |
| `require_docs` | boolean | `true` | Require a successful docs-agent completion. This belongs to `phase_complete`, not the QA gate profile. Successful participation is persisted against the exact plan structure and phase so it survives session restart. |
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

When required participation is missing, `phase_complete` returns `recovery_guidance`: dispatch the named role and retry. Docs proof is stored in the bounded `.swarm/evidence/phase-participation.json` projection; its policy digest is audit provenance, while proof validity is bound to the exact plan structure, phase, role, workspace identity, and successful completion. If docs was added only by `require_docs`, set `phase_complete.require_docs` to `false` only when documentation is genuinely unnecessary. `policy: "warn"` weakens enforcement for every missing role; it does not create participation proof. A readable corrupt docs-participation projection is quarantined on a genuine re-dispatch, while unreadable, oversized, or quarantine-capacity failures require operator repair.

## Repo Graph Configuration (`repo_graph`)

Controls the persistent repository dependency graph, its bounded freshness
probe, and automatic incremental refresh behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch. When `false`, no startup or write-trigger maintenance runs, `repo_map` returns a disabled notice, and graph context is not injected. The tool remains registered. |
| `init_refresh` | boolean | `true` | Probe the persisted fingerprint on session start and refresh only detected drift. Set to `false` to retain the legacy full rebuild on every session start. |
| `refresh_cap` | integer (0-500) | `50` | Maximum complete drift set that a `repo_map` read may refresh incrementally. `0` disables read-time auto-refresh. Startup also uses this value in its incremental-versus-full-build cutover. |
| `walk_budget_ms` | integer (1000-60000) | `5000` | Wall-clock budget for graph and freshness walks. An incomplete freshness walk is `inconclusive` and never authorizes refresh or deletion. |
| `max_files` | integer (100-100000) | `10000` | Source-file cap for graph and freshness walks. Hitting the cap is conservative and produces an incomplete result. |
| `exclude_dirs` | string[] | `[]` | Extra directory **names** to skip when scanning the workspace, in addition to the built-in defaults. |
| `storage` | `'json' \| 'indexed'` | `'json'` | Storage mode for the persisted graph. `'json'` keeps the single `.swarm/repo-graph.json` document as the sole store. `'indexed'` additionally maintains a derived `.swarm/repo-memory.sqlite` index that accelerates bounded neighbourhood lookups. See "Storage modes" below. |

The graph scanner already skips common generated directories by default:
`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`,
`.cache`, `vendor`, `.svn`, `.hg`, and `.svelte-kit`. Use `exclude_dirs` to add
your own (for example a custom generated-code or fixtures directory).

Matching is by directory **basename at any depth** — the same mechanism the
built-in defaults use — so `".svelte-kit"` skips every `.svelte-kit` directory
in the workspace. Entries are directory names, **not** glob or path patterns.
The exclude also applies to write-triggered incremental updates, so files under
an excluded directory are never (re-)added to the graph.

Changing the exclusion policy invalidates the prior fingerprint and causes a
configured startup rebuild. Changes to `package.json`, `Cargo.toml`,
`pyproject.toml`, or `go.mod` also require a full rebuild because those
manifests affect inferred package boundaries rather than a single source node.

The freshness sidecar at `.swarm/repo-graph.fingerprint.json` records file size
and modification time for source files and package manifests. This is a bounded
`readdir` plus `stat` walk; it does not read or hash file contents. A change that
preserves both size and filesystem mtime is outside the probe's detection model.
Probe results are cached per normalized workspace for up to 30 seconds with
bounded LRU eviction.

`clean` means the current walk matches the persisted fingerprint. `drifted`
means a complete walk found additions, metadata changes, or removals.
`no-fingerprint` triggers a startup rebuild. `inconclusive` means a budget, cap,
or filesystem error prevented complete observation; existing query answers are
served with freshness marked unknown, and no refresh or deletion is attempted.
Coder/reviewer graph context follows the same rule: inconclusive results remain
available as freshness-unknown, while uncertified graphs and complete drift
above `refresh_cap` are suppressed.

**Example** — exclude a generated-code directory and a docs build dir:

```json
{
  "repo_graph": {
    "enabled": true,
    "init_refresh": true,
    "refresh_cap": 30,
    "walk_budget_ms": 8000,
    "max_files": 25000,
    "exclude_dirs": ["generated", "site"]
  }
}
```

> Note: even without configuring `exclude_dirs`, a single unparseable or
> minified file can no longer abort the whole graph build — such files are
> skipped individually (issue #1448).

### Storage modes

`repo_graph.storage` selects how the persisted graph is stored on disk
(issue #1534):

- **`'json'` (default).** The graph lives solely in `.swarm/repo-graph.json`.
  Behavior is unchanged from prior releases.
- **`'indexed'`.** In addition to `.swarm/repo-graph.json`, a derived
  `.swarm/repo-memory.sqlite` index is maintained. `.swarm/repo-graph.json`
  is **always written and remains authoritative in both modes** — the index
  is never a second source of truth, only a read-side accelerator built from
  it.

> **Enabling `indexed` does not build the index immediately.** The index is
> created by the next graph save (for example `repo_map action="build"`, a
> session-start rebuild, or a write-triggered incremental update). There is
> deliberately no build-on-read path, because that would put a full JSON parse
> plus a full index build on the synchronous system-prompt path. Until the next
> save, reads transparently use the JSON path — nothing fails, it is simply not
> yet accelerated.

What the index accelerates: bounded neighbourhood lookups that today require
parsing the full JSON document — the coder localization block and reviewer
blast-radius block (which query a small set of changed files' dependents and
dependencies), and memory-reflection anchor resolution on repositories whose
`repo-graph.json` exceeds the 16 MB bounded-read budget the reflection
service enforces. On a fresh-parse turn, indexed lookups avoid reading and
parsing the entire document.

Fail-safe behavior: a missing, corrupt, or stale index (for example after a
`storage` mode flip back to `'json'`, or after manual deletion) is detected
and the affected read silently falls back to the JSON path — it never
surfaces an error to the caller. Deleting `.swarm/repo-memory.sqlite` (and
any `-wal`/`-shm` sidecars) by hand is always safe; it is rebuilt on the next
graph save.

Honest performance tradeoff — this is not a blanket speedup:

- On repositories where `repo-graph.json` is large, and on turns that call
  only one of the graph-consuming blocks, indexed mode is a clear win: it
  avoids a full JSON parse.
- On a turn where **multiple** injection blocks run against the same
  directory right after a graph change (a full-graph in-memory cache miss),
  indexed mode costs slightly **more** than JSON mode. The first block takes
  the cheaper subgraph branch instead of warming the full-graph cache for the
  document, so a later whole-graph consumer in the same turn still pays a
  full parse — on top of the subgraph query the first block already did.
  Single-block turns, and turns after the full-graph cache is already warm,
  are unaffected by this.

## Evidence Retention Configuration

Controls evidence bundle archival for `/swarm finalize` and `/swarm archive`. The two commands use different defaults: finalize uses tighter retention (30 days / 10 bundles) to keep only recent evidence; archive targets long-term retention (90 days / 1000 bundles) for periodic cleanup.

| Field | Type | Default (finalize) | Default (archive) | Range | Description |
|-------|------|:---:|:---:|:---:|---|
| `enabled` | boolean | `true` | `true` | — | Master switch |
| `max_age_days` | number | **30** | 90 | 1–365 | Age threshold for archiving |
| `max_bundles` | number | **10** | 1000 | 10–10000 | Count cap |
| `auto_archive` | boolean | `false` | `false` | — | Future gate (config-only) |
| `cache_max_bytes` | number | _unset_ | _unset_ | 512 B–50 MiB | Optional byte cap for the web_search/web_fetch documents cache (issue #1184). When unset, the cache is append-only. |
| `cache_max_records` | number | _unset_ | _unset_ | 10–100 000 | Optional record-count cap for the same documents cache. |

> **Note:** `/swarm finalize` applies tighter retention (30 days / 10 bundles) by default to keep only recent evidence for the current project. `/swarm archive` targets long-term retention (90 days / 1000 bundles). Both are configurable via `evidence.max_age_days` and `evidence.max_bundles` in your project config.

### Documents cache retention (issue #1184)

The web_search / web_fetch evidence cache (`.swarm/evidence-cache/documents.jsonl`)
is **append-only by default**. Set `evidence.cache_max_bytes` and/or
`evidence.cache_max_records` to opt in to bounded retention — both `/swarm archive`
and `/swarm finalize` will then prune oldest cache rows (by `capturedAt`) until
the surviving file is within the configured cap(s). When neither cap is set, the
cache grows without bound exactly as before. See
[docs/evidence-and-telemetry.md](evidence-and-telemetry.md#documents-cache-retention-issue-1184)
for the full bounded-prune contract (atomic rewrite, corrupt-row handling,
read cap, append-vs-rewrite race tradeoff).

**Example** — Tighten finalize retention:

```json
{
  "evidence": {
    "max_age_days": 14,
    "max_bundles": 5
  }
}
```

## Council

Opt-in verification gate that runs five specialized reviewers in parallel before a task advances to `completed`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for the council gate |
| `maxRounds` | number | `3` | Maximum REJECT-retry rounds before architect must escalate to user (1–10) |
| `parallelTimeoutMs` | number | `30000` | **DEPRECATED — inert.** No runtime consumer exists and no timeout is enforced; accepted only for parse compatibility. Config doctor warns when it is explicitly set. Remove the key — dispatch timeouts are governed by the agent host. Scheduled for removal. |
| `vetoPriority` | boolean | `true` | When `true`, any single REJECT blocks advancement |
| `requireAllMembers` | boolean | `false` | When `true`, reject synthesis if fewer than 5 verdicts provided. Equivalent to `minimumMembers: 5`. (Task/phase councils only.) |
| `minimumMembers` | number | `3` | Minimum distinct council members required for quorum (1–5) at the **task/phase** level. Set to 1 to disable quorum enforcement. `requireAllMembers: true` overrides this to 5 (stricter constraint wins). The **final** council is governed separately by `finalCompletionPolicy`. |
| `escalateOnMaxRounds` | string? | undefined | **Inert.** Declared for escalation, but no handler/webhook execution exists or runs (#1650). Config doctor warns when it is set. Max-rounds exhaustion instead emits a durable structured event (`.swarm/council/events/max-rounds-exhaustion.jsonl`) and a user escalation message; the run stays fail-closed. Wiring real outbound escalation requires a separate security review. |
| `finalCompletionPolicy` | object | `{ "mode": "all_required" }` | Final-council completion policy. `all_required` (default) preserves the exact legacy requirement: all five canonical roles, five distinct members, zero absentees. `quorum` is an explicit, bounded weakening requiring `minimumMembers` (3–5) distinct canonical members — unknown, duplicate, and cross-swarm identities never count, and config doctor visibly flags quorum mode as weaker. Member names may be exact canonical roles or multi-swarm prefixed names (e.g. `local_critic`). The normalized policy participates in the council policy digest, so any change invalidates previously accepted final-council evidence. |
| `freshnessMaxAgeHours` | number | `24` | Maximum age in hours (1–720) for phase-council, architecture-supervisor, and final-council evidence. One shared evaluator and one captured preflight clock govern all three gates; future/invalid timestamps and evidence predating the phase retrospective fail closed. Part of the council policy digest. |

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

Triggered by `/swarm council <question>` (see [Commands](commands.md#swarm-council-question---spec-review)) or offered as an early workflow option in MODE: BRAINSTORM (Phase 1b) and MODE: PLAN before `save_plan` when enabled.

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

## Real-Time Learning Nudges

Architect sessions can receive a cadence-bounded learning nudge while work is
still in progress. The nudge asks the architect to capture durable procedural
lessons with `knowledge_add` when the lesson is obvious, and to leave
evidence-level review to the existing curator phase/postmortem path when the
signal depends on repeated outcomes or generated-skill health. It does not
auto-activate skills.

```jsonc
{
  "knowledge": {
    "realtime_learning_nudge": {
      "enabled": true,
      "first_after_tool_calls": 10,
      "repeat_after_tool_calls": 25
    },
    "receipt_close_grace_days": 7
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `knowledge.realtime_learning_nudge.enabled` | boolean | `true` | Enables the architect-only in-session learning nudge when knowledge is enabled. |
| `knowledge.realtime_learning_nudge.first_after_tool_calls` | number | `10` | First total session tool-call count that can trigger the nudge. |
| `knowledge.realtime_learning_nudge.repeat_after_tool_calls` | number | `25` | Minimum additional tool calls before the same session can be nudged again. |
| `knowledge.receipt_close_grace_days` | integer | `7` | Retains resolved V2 receipt membership for this many days after durable phase closure before archival/compaction eligibility. Accepts `0`-`3650`; live or unresolved membership is never age-evicted. |
| `knowledge.promotion_require_actionable` | boolean | `true` | Enforces the actionability floor on **every** hive-promotion path — automatic promotion, `/swarm promote <text>`, and `/swarm promote --from-swarm <id>`. A lesson is promotable only if it carries at least one predicate (`required_actions`, `forbidden_actions`, `verification_checks`) **and** at least one scope (`applies_to_tools`, `applies_to_agents`). See [the promote command](./commands.md#swarm-promote---category-cat---from-swarm-id-actionability-flags-text) for the flags that supply them. |

Receipt authority is stored only under the canonical project's `.swarm/`
directory. It is not redirected by knowledge links, hive configuration, or a
cohort label. `knowledge-events.jsonl` remains a bounded diagnostic projection;
its presence, absence, or eviction never changes a receipt or gate decision.
Receipt migration runs lazily on the first V2 operation, not during plugin
initialization, and incomplete legacy membership remains typed
`legacy_unverifiable` rather than being inferred.

> **`knowledge.promotion_require_actionable` is default-ON and is a behavior change (issue #1821).** Before
> this, a lesson could reach hive knowledge as un-actionable prose that no agent could act on. Now such a
> lesson is **blocked** rather than silently promoted, and that applies to entries which previously
> auto-promoted. `--force --reason "<why>"` still overrides and records a durable audited override naming the
> failed gate; set this key to `false` to restore the previous behavior wholesale.

> **Superseded by real-time admission (issue #1821).** When
> `learning.realtime_admission.enabled` is `true` (the default) the nudge is suppressed, because the
> admission loop below does the same job for real — it validates and admits candidates instead of asking the
> model to remember to. Set `learning.realtime_admission.supersede_nudge` to `false` to keep both, or disable
> `learning.realtime_admission` to fall back to the nudge alone.

## Learning Data Plane

The learning data plane turns in-session observations into durable knowledge under explicit budgets, and
mines accumulated evidence into improvement proposals. It never activates a skill or edits an active
artifact on its own.

Note this is the **top-level `learning` block**, which is unrelated to `memory.learning` (the memory
subsystem's Q-learning tuning).

```jsonc
{
  "learning": {
    "realtime_admission": { "enabled": true, "max_queue_size": 50, "max_drain_wall_time_ms": 10000 },
    "prm_persistence": { "enabled": true, "min_support": 3, "cooldown_ms": 900000 },
    "dedup_sweep": { "enabled": true, "max_comparisons": 2000, "max_merges_per_sweep": 10 }
  },
  "consensus": { "enabled": true, "default_min_support": 3, "default_min_successful_runs": 2 }
}
```

### `learning.realtime_admission`

Admits knowledge candidates while the session is still running, so a lesson captured early can be retrieved
by a later delegation. Every field is a hard cap; the phase-boundary curator remains the durable backstop, so
disabling this loses nothing but timeliness.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable mid-session admission. |
| `max_queue_size` | number | `50` | Per-session candidate queue cap (drop-oldest). |
| `min_drain` / `max_drain` | number | `1` / `10` | Bounds on the adaptive drain batch size. |
| `drain_depth_factor` / `drain_velocity_factor` | number | `0.5` / `0.25` | How queue depth and arrival velocity scale the batch. |
| `max_llm_calls_per_session` | number | `20` | Cap on validation model calls per session. |
| `max_tokens_per_session` | number | `50000` | Token budget per session. |
| `max_concurrent_admissions` | number | `2` | Concurrency limit. |
| `max_retries_per_candidate` | number | `1` | Retries before a candidate is requeued. |
| `per_candidate_llm_timeout_ms` | number | `60000` | Per-candidate bound on cancellable model work. |
| `max_drain_wall_time_ms` | number | `10000` | Total wall-clock budget for one drain. |
| `supersede_nudge` | boolean | `true` | Suppress the prompt-only nudge while this loop is active. |

### `learning.prm_persistence`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Persist repeated PRM patterns as knowledge. |
| `min_support` | number | `3` | Distinct occurrences required before a pattern is persisted. |
| `cooldown_ms` | number | `900000` | Per-pattern cooldown after a persist. |

### `learning.dedup_sweep`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Merge active near-duplicate knowledge entries at curator phase boundaries. |
| `max_comparisons` | number | `2000` | Upper bound on pairwise comparisons per sweep. |
| `max_merges_per_sweep` | number | `10` | Upper bound on merges applied per sweep. |

### Cross-producer recommendation dedup

Three mechanisms propose learning recommendations — the curator sweep, the skill improver's
macro-reflector, and the consensus miner. They share one dedup memory so a lesson one of them has
already emitted is not emitted again. There is nothing to configure; the behaviour is always on and
always fails open (an unreadable or unwritable ledger emits everything, which is the pre-dedup
behaviour).

| Property | Value |
|----------|-------|
| Location | `learning/recommendation-ledger.jsonl` under the resolved knowledge store — `<project>/.swarm/` normally, the shared cohort store when the worktree is linked. Survives `/swarm close` and `/swarm reset`, like `knowledge.jsonl` |
| Identity | Normalized recommendation text plus its scope keys — deliberately independent of which mechanism produced it, and of the target it names |
| Retention | 500 entries, oldest-first eviction, applied on a whole-file rewrite at every append; each entry capped at 4 KB. Eviction is by position, not by producer, so one mechanism's append can evict another's oldest entries |
| Provenance | Each entry carries a `LearningProvenanceV1` record (mechanism, source knowledge/task/evidence/run/model refs, write origin) |
| Visibility | `/swarm consolidate` prints `Duplicate recommendations suppressed`; `consensus_mine` returns a `recommendation_ledger` block whose `duplicate_recommendation_count` counts keys the ledger had already seen — including this miner's own earlier emissions, not only other producers' (see [Reading `duplicate_recommendation_count`](./consensus-mining.md#reading-duplicate_recommendation_count), and [Response shape](./consensus-mining.md#response-shape) for every field it returns) — and whose `degraded: true` says the fail-open path was taken and **nothing** was recorded; curator suppressions land in its `skipped` tally and the debug log |

Matching is **exact** over normalized text, so two mechanisms suppress each other only when they emit
the same sentence. The improver and the miner build statements from fixed templates while the curator
emits free-form lessons, so in practice this mostly deduplicates each mechanism against its own
earlier runs; treat cross-mechanism suppression as a bonus rather than the common case.

Because retention is bounded, a recommendation older than the most recent 500 emissions can surface
again. Retention is also independent of `knowledge.swarm_max_entries` (default 100), so a lesson the
knowledge store has already evicted can still be suppressed until its ledger entry ages out.

A generated motif or workflow proposal removed from `.swarm/skills/proposals/` is **not** regenerated
— the ledger has already recorded it. This matters most on the automated path: a full-auto or
post-mortem `REJECT` deletes the proposal, which now retires that motif until its ledger entry ages
out. Knowledge-derived skill drafts are not routed through the ledger and are unaffected.

### `consensus`

Governs the `consensus_mine` tool. It mutates none of the evidence it reads, writes no knowledge entry,
and admits no durable memory record — but it is not write-minimal: besides its own immutable report it
prunes its own older reports, rewrites the shared dedup ledger, leaves a lock sentinel per report id,
and (when `memory.enabled`) mirrors each proposal into a pending memory proposal. See
[What a mining run writes](./consensus-mining.md#what-a-mining-run-writes) for the complete list,
[Finding the reports](./consensus-mining.md#finding-the-reports) for how to read what it produced, and
[Response shape](./consensus-mining.md#response-shape) for what the tool returns.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable consensus mining. |
| `default_min_support` | number | `3` | Minimum distinct supporting runs. |
| `default_min_successful_runs` | number | `2` | Minimum successful runs. |
| `default_max_evidence_items` | number | `50` | Cap on evidence items loaded per mine. |
| `max_excerpt_chars` | number | `500` | Per-excerpt length bound (excerpts are also secret-redacted). |
| `llm_summarization_enabled` | boolean | `true` | Allow optional statement summarization after the deterministic pass. When on and an OpenCode client is wired, a mine issues up to **20** `session.create` + `session.prompt` calls. |
| `llm_timeout_ms` | number | `60000` | Bound on summarization calls. |
| `report_retention` | number | `50` | Reports retained under `.swarm/evolution/consensus/`. Pruning runs after **every** mine, so at the default the steady state of a long-lived project is that each run deletes the oldest report. `0` **disables** pruning (retain everything) rather than deleting everything; the tool then reports `retention.pruning_enabled: false` and omits `retention.retained` and `retention.corrupt`. |

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

## Governed Skill Optimizer

`skill_opt` governs the `/swarm skill-opt` command family (issue #1822 —
SkillOpt 3/7): a manually-activated optimizer that drives one allowlisted
`SKILL.md` candidate at a time through deterministic draft → static smoke →
evaluation-substrate validation (`split:'test'`) → manual approval → atomic
activation (or rollback). See `docs/skill-optimizer.md` for the full
architecture.

Disabled by default. `/swarm skill-opt run` requires `enabled: true` AND
`--confirm`; `approve`/`activate`/`reject`/`rollback` are human-only. The
config is consulted only inside command handlers — never on the plugin init
path.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master opt-in for executing optimization rounds. `plan`/`status`/`diff`/`history` are always available (read-only / proposal-only). |
| `max_rounds` | number | `5` | Hard cap on draft/smoke retries before a validation (the held-out test set is single-use, so a single `run` performs at most one validation). |
| `max_candidates_per_round` | number | `3` | Max candidates drafted per round. (Forward-compatible; one candidate is drafted per round in v1.) |
| `max_validations_per_round` | number | `1` | Max validation runs per round (held-out test consumptions). |
| `max_round_time_ms` | number | `3600000` | Forwarded as a per-task validation timeout in v1 (no wall-clock round timer enforced yet). |
| `max_tokens_per_round` | number | `50000` | Soft token spend budget for LLM drafting across a round. (Forward-compatible; not yet enforced in v1.) |
| `max_rejections` | number | `5` | Max consecutive rejections before a multi-validation controller stops. (Forward-compatible in v1 — single validation per run.) |
| `max_inconclusive_rounds` | number | `2` | Max consecutive inconclusive results before a multi-validation controller stops. (Forward-compatible in v1.) |
| `max_transient_retries` | number | `5` | Max transient-infra retries before an infra failure becomes inconclusive. |
| `convergence_non_improvements` | number | `3` | K consecutive draft/smoke non-progress results before the controller stops. |
| `max_changed_lines` | number | `200` | Trust region: max changed lines in a candidate `SKILL.md`. |
| `max_changed_bytes` | number | `20000` | Trust region: max changed bytes in a candidate `SKILL.md`. |
| `max_changed_sections` | number | `6` | Trust region: max distinct frontmatter/body sections changed. |
| `deadband` | number | `0` | Promotion policy deadband forwarded to the evaluation substrate (`PromotionPolicyV1.deadband`). |
| `retirement_min_age_days` | number | `60` | Wall-clock retirement: minimum age (days) before a never-used skill is eligible for archival retirement. Real usage signal is still required; this is a floor. |

## Declarative Harness Evolution

`harness_evolution` configures the bounded, non-executing HarnessOpt mutation
surface. It does not run during plugin initialization, generate candidates,
apply source patches, or activate a candidate automatically. Blueprint and
candidate commands are read-only; activation and rollback are package-API
operations guarded by exact, one-shot `/swarm approve-write` facts.

Source candidates are inert manifests. Their patches are validated against the
current Git commit, project containment, the explicit source allowlist, the
shared protected-path policy, text-only limits, and configured size caps. The
runtime never applies or evaluates the stored patch.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source_allowlist` | string[] | `[]` | Project-relative prefixes eligible for inert source candidates. Empty means source candidates are denied. |
| `extra_protected_paths` | string[] | `[]` | Additional project-relative prefixes denied even when allowlisted. Built-in protected paths always remain denied. |
| `max_patch_bytes` | number | `1048576` | Maximum UTF-8 patch size. |
| `max_files` | number | `64` | Maximum files represented by one candidate. |
| `max_file_bytes` | number | `524288` | Maximum before/after size of an individual text file. |
| `max_total_bytes` | number | `4194304` | Maximum aggregate candidate output size. |
| `max_changed_lines` | number | `10000` | Maximum aggregate added plus removed lines. |
| `max_versions` | number | `100` | Maximum active-history projection size; rollback ancestry remains durable. |
| `max_inactive_candidates` | number | `32` | Maximum additional inactive candidate records retained on disk after compaction. Candidates referenced by retained versions are always kept, and the newest inactive candidate is always retained as the activation handoff even when this is `0`. |
| `max_replay_records` | number | `10000` | Maximum ledger records replayed by one operation. Replay exhaustion fails closed. |
| `max_output_bytes` | number | `262144` | Maximum command output size. |

Durable state lives under `.swarm/evolution/harness/`. The segmented,
hash-chained ledger is authoritative; `current.json` is only a derived
projection and read commands never repair it implicitly. Once the store has to
compact, it rewrites the active ledger to a single authenticated snapshot under
the ledger generation pointer, prunes inactive candidate directories not named
by that snapshot, and leaves version-linked candidates available for rollback.

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
| `worktree_isolation` | boolean | `true` | Use git worktree isolation for parallel coders to enable true file-system-level parallelism. When `true`, each lane gets its own worktree. |
| `merge_strategy` | `"merge" \| "rebase" \| "cherry-pick"` | `"merge"` | Branch merge strategy after lane worktree completion. Controls how completed lane branches are merged back into the main branch. |
| `worktree_dir` | string | _(none)_ | Optional user-specified worktree directory override. When set, worktrees are created under this path instead of the default `.swarm-worktrees/<sessionId>/<laneId>`. Accepts absolute and relative paths (relative paths are resolved against the project root). |
| `deps_strategy` | `"skip" \| "copy" \| "link"` | `"skip"` | How to handle `node_modules` when provisioning a lane worktree. `"skip"` (default) does not copy dependencies — the lane runs without access to host packages. `"copy"` uses `cpSync` to duplicate `node_modules`. `"link"` creates symlinks/junctions. Only applies when `worktree_isolation: true`. See `worktree` config section for per-lane overrides. |
| `runtime_isolation` | object | _(see below)_ | Per-lane environment isolation configuration. Controls port allocation, environment variable overrides, and cache redirection for sandboxed lane execution. |

#### `turbo.lean.runtime_isolation` — Per-lane runtime isolation settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable per-lane runtime isolation. When enabled, each lane receives isolated port allocations and optional environment overrides. **Off by default — zero behavior change when omitted.** |
| `port_base` | number | _(none — no PORT injection)_ | Base port number for lane-specific port allocations. Each lane gets `port_base + laneIndex * port_stride`. Must be explicitly set to enable PORT injection. |
| `port_stride` | number | `1` | Port increment between consecutive lanes. |
| `env_overrides` | `Record<string, string>` | `{}` | Environment variable overrides applied to each lane's execution environment. Keys are variable names; values are the override values. Values are copied verbatim — no template substitution. |
| `cache_redirects` | `Record<string, string>` | `{}` | Cache directory redirects for lane isolation. Keys must be valid env var names (e.g. `XDG_CACHE_HOME`, `TMPDIR`); values are redirected base paths. Useful for sandboxing cache access per lane. (The implementation appends `/lane-{laneIndex}` to each value as a per-lane suffix.) |

**Cross-platform sandbox mechanism:**

| Platform | Sandbox | Soft-fail |
|----------|---------|-----------|
| Linux | `bubblewrap` | Falls back to env+port only if `bwrap` is unavailable |
| macOS | `sandbox-exec` | Falls back to env+port only if `sandbox-exec` is unavailable |
| Windows | `native-runner/{mode}` with `PowerShell wrapper` fallback | Falls back to env+port only if sandbox preparation fails |

A lane **never hard-fails** due to sandbox unavailability — env var and port injection always work regardless of whether the OS-level sandbox envelope was successfully prepared (SC-132).

**When to enable:** parallel coders running port-binding test servers, integration suites that need per-lane database or cache isolation, or dev servers requiring isolated temp directories.

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

### `worktree` — Worktree Isolation Settings

Extended worktree isolation configuration. These settings apply to all worktree operations regardless of the `turbo.strategy` setting.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `policy` | `"auto" \| "required" \| "disabled"` | `"auto"` | Worktree isolation policy. `"auto"` uses isolated worktrees for eligible parallel coders and blocks additional parallel dispatches if isolation cannot be prepared. `"required"` always requires isolation and blocks if it cannot be prepared. `"disabled"` preserves shared-tree behavior (no worktree isolation). |
| `merge_strategy` | `"merge" \| "rebase" \| "cherry-pick"` | `"merge"` | Branch merge strategy after lane worktree completion. |
| `worktree_dir` | string | _(none)_ | Optional user-specified worktree directory override. When set, worktrees are created under this path instead of the default `.swarm-worktrees/<sessionId>/<laneId>`. |
| `deps_strategy` | `"skip" \| "copy" \| "link"` | `"skip"` | How to handle `node_modules` when provisioning a lane worktree. `"skip"` (default) does not copy — the lane runs without host packages. `"copy"` uses `cpSync` to duplicate `node_modules`. `"link"` creates symlinks (POSIX) or junctions (Windows). |
| `lane_permissions` | `"scoped_allow" \| "deny" \| "off"` | `"scoped_allow"` | Permission policy for OpenCode instances running **inside** a worktree lane. See below. Has no effect outside a lane — ordinary sessions are never modified by this setting. |
| `serialization_release_after_dispatches` | number | `5` | Release a serialized session after this many successful dispatches have completed and merged back from that session. Only applies when serialization mode is active. |
| `serialization_release_after_ms` | number | `60000` | Release a serialized session after this many milliseconds have elapsed since the session was first serialized (even if zero dispatches have succeeded). Acts as a TTL ceiling on serialized sessions. |
| `session_create_timeout_ms` | number | `30000` | Client-side budget (ms) for the lane child `session.create` call in worktree-isolated dispatches (and the recovery-lane equivalent). Integer, 1000–120,000. Raised from the old hardcoded 5000 default: on hosts where a fresh lane’s child-session init legitimately exceeds 5 s, every dispatch used to fail at the deadline and leak the late-accepted child session, which locked the lane’s `swarm.db` (issue #2599). Deadline errors name this knob. |

**`deps_strategy` behavior:**

| Value | Behavior | Use case |
|-------|----------|----------|
| `"skip"` (default) | No `node_modules` copy. Lane has no access to host packages. | Lightweight tasks with no external dependencies, or tasks that bundle dependencies. |
| `"copy"` | `cpSync` duplicates the entire `node_modules` directory. | Tasks that require exact package versions and cannot tolerate symlink issues. |
| `"link"` | Creates symlinks (POSIX) or directory junctions (Windows). | Projects with many packages where copying is slow; requires filesystem support for symlinks. |

> **Advisory for `deps_strategy: "skip"`:** When a task's gates include test/build commands and the lane was provisioned with `deps_strategy: "skip"`, the system emits a `WORKTREE_DEPS_SKIP` advisory suggesting to set `deps_strategy` to `"copy"` or `"link"` if the task requires host dependencies.

#### `worktree.lane_permissions` — Permission policy inside a lane

OpenCode partitions **all** permission state by directory. A worktree lane runs in its own OpenCode instance, so it starts with an empty `approved` list — every prior "Allow always" is forgotten — and a private pending-prompt map. Because no TUI is attached to a lane instance, an `external_directory` prompt raised there can never be answered, and the lane blocks indefinitely.

This setting decides how that is resolved. It applies **only** inside a swarm worktree lane; every other session is left exactly as it is today.

| Value | Behavior |
|-------|----------|
| `"scoped_allow"` (default) | Pre-grant `external_directory` access to a justified allowlist and deny everything else outright, so no request can be left pending. See the allowlist below. |
| `"deny"` | Emit no allowlist — only the catch-all deny. Anything you have explicitly allowed in `permission.external_directory` still applies (your configuration is merged last and always wins), so this denies everything the plugin would otherwise have granted rather than literally every request. Still resolves rather than hanging. |
| `"off"` | Apply no lane-specific rules. **This restores the hanging behavior described above** — an unanswerable prompt inside a lane will block that lane until the server is restarted. Provided only as an escape hatch. |

Under `"scoped_allow"` the allowlist is:

- the parent project the lane is a git worktree of, and the lane itself;
- both OpenCode config directories — the XDG one (`~/.config/opencode`) and, when set, the `OPENCODE_CONFIG_DIR` override. OpenCode reads config from both, but does **not** base-allow either to an agent, so granting them is a deliberate widening (see the note below);
- OpenCode's own temp directory (`<os-temp>/opencode`), and on Windows only the shortened-worktree lane root (`<os-temp>/swwt`) used by the path-budget fallback;
- OpenCode's plan storage (`<data>/plans`), which the host natively allows to its built-in `plan` agent;
- the skill roots OpenCode itself scans, mirroring its `{skill,skills}` glob (see the table below);
- any directories listed in your `skills.paths` config, resolved the same way OpenCode resolves them (`~/` expands to your home directory, relative paths anchor to the lane);
- **only if you configure `skills.urls`**, the URL-skill cache root `$XDG_CACHE_HOME/opencode/skills` (default `~/.cache/opencode/skills`). With no `skills.urls` set, nothing under the cache is granted — see the note below.

> **These are WRITE grants too.** OpenCode's `external_directory` permission has no read/write split, so every allowlist entry also permits writes. The list is deliberately narrow for that reason: the whole OS temp directory is **not** granted (only the two subtrees above), and neither are the opencode-swarm plugin cache/install locations — a lane writing to its own installed plugin would be executed in-process by the host on the next load. OpenCode's data directory is not granted either — only the `plans` subdirectory is, so session storage and the primary `auth.json` stay outside the grant. The user-level `~/.opencode` tree is deliberately **not** granted for the same reason: OpenCode's GitLab OAuth helper stores credentials at `~/.opencode/auth.json` when `XDG_DATA_HOME` is unset (the default on Windows and macOS). Its skill subdirectories (`~/.opencode/skill` and `~/.opencode/skills`) are granted individually instead. If a lane genuinely needs more of `~/.opencode`, add an explicit `permission.external_directory` allow — but be aware of what else lives there.

Explicit configuration mostly wins: any `permission.external_directory` entry you set in `opencode.json` is merged **after** the generated rules, so your own `allow` and `deny` entries override both the allowlist and the catch-all deny.

> **Known residual — a hand-made worktree at the exact lane path.** A worktree you create yourself at literally `<parent>/.swarm-worktrees/ses_<letters-and-digits>/<id>` is treated as a lane even on your own branch, and will get the scoped rules. This is accepted rather than fixed: it takes a deliberately lane-shaped directory name to reach, and the same leniency is what keeps a real lane recognised after you check out a different branch inside it. Use a directory name outside that shape, or set `worktree.lane_permissions: "off"`.

> **Known narrowing — `references` directories.** OpenCode base-allows any directory listed in your top-level `references` config for every agent, but the plugin cannot resolve those paths from the config hook, so they are **not** re-granted inside a lane and a lane will be denied access to them. If you use `references`, add each directory explicitly: `{ "permission": { "external_directory": { "/path/to/reference/*": "allow" } } }`. The other families OpenCode base-allows for an agent — its own temp directory and the tool-output directory — are preserved inside a lane, as are the skill roots enumerated in the table below. The OpenCode config directories are granted as well; that one is a deliberate widening rather than a restoration, since OpenCode does not base-allow them to an agent. The user-level `~/.opencode` tree is **not** granted (only its skill subdirectories are) — see the write-grant note above.

#### Skill roots reachable from a lane

OpenCode discovers skills with two globs: `skills/**/SKILL.md` under `.claude` and `.agents` (plural only), and `{skill,skills}/**/SKILL.md` under each of its config directories (either spelling). The allowlist mirrors both, so every layout OpenCode supports stays reachable. Measured effective actions inside a lane under `scoped_allow`:

| Skill layout | Action in a lane |
|---|---|
| `~/.claude/skills/<skill>` | allow |
| `~/.agents/skills/<skill>` | allow |
| `~/.opencode/skills/<skill>` | allow |
| `~/.opencode/skill/<skill>` | allow |
| `<xdg-config>/opencode/skill/<skill>` | allow |
| `<project>/.claude/skills/<skill>` | allow |
| `<project>/.agents/skills/<skill>` | allow |
| `<project>/.opencode/{skill,skills}/<skill>` | allow |
| `$XDG_CACHE_HOME/opencode/skills/<skill>` (URL-sourced) | allow |
| `~/.opencode` (the tree itself) | **deny** |
| `$XDG_CACHE_HOME/opencode` (the cache parent) | **deny** |

> **`skills.urls` are covered — conditionally, and as a superset.** OpenCode pulls URL-sourced skills into `$XDG_CACHE_HOME/opencode/skills` (default `~/.cache/opencode/skills`) and adds each pulled skill's directory to the set it base-allows every agent, so a lane needs that root to read them. The grant is made **only when your config actually declares `skills.urls`** — otherwise nothing under the cache is base-allowed to an ordinary session either, and granting it would make a lane *more* permissive than a normal session.
>
> Note this is a **superset** of what OpenCode base-allows: the host allows each individual pulled directory, whereas the plugin grants the whole root (a rule pattern's `*` spans path separators). Because `external_directory` grants writes as well as reads, and OpenCode skips downloading a file whose destination already exists, a lane with this grant could pre-place content at a deterministic cache path that a later, different session would then load as skill instructions. That risk is accepted only when you have opted into `skills.urls`; set `worktree.lane_permissions: "deny"` if you would rather a lane never reach the cache.
>
> Only that subdirectory is granted — **not** the cache parent `$XDG_CACHE_HOME/opencode`, which contains `bin/`, a directory OpenCode executes from; granting the parent would place executable code inside a lane's write grant.

> **Exception — `"ask"` becomes `"deny"` inside a lane.** A lane instance has no TUI attached, so an `ask` there is not a third policy choice; nothing can ever answer it, and the lane blocks forever. Any `external_directory` `"ask"` you configure — top level or per agent, string shorthand or pattern map — is therefore applied as `"deny"` inside a lane only, and the affected patterns are named in the advisory and in the `.swarm/events.jsonl` record. Use an explicit `"allow"` or `"deny"` to control the behavior, or `worktree.lane_permissions: "off"` if you really want the prompting (and hanging) restored. Outside a lane, `"ask"` is untouched.

A denial cannot carry a message — a permission rule holds an action, not text. So when lane scoping activates, the plugin emits one advisory (visible via `/swarm diagnose`) and appends a `lane_permissions` record to `.swarm/events.jsonl` naming the lane, the parent project, the full allowlist with justifications, and the remedy below.

**To widen the allowlist**, add the directory to `opencode.json`:

```json
{
  "permission": {
    "external_directory": {
      "/absolute/path/to/dir/*": "allow"
    }
  }
}
```

**Example** — deny all external directory access inside lanes:

```json
{
  "worktree": {
    "lane_permissions": "deny"
  }
}
```

#### `worktree.runtime_isolation` — Per-lane runtime isolation settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable per-lane runtime isolation. **Off by default — zero behavior change when omitted.** |
| `port_base` | number | _(none — no PORT injection)_ | Base port number for lane-specific port allocations. Each lane gets `port_base + laneIndex * port_stride`. Must be explicitly set to enable PORT injection. |
| `port_stride` | number | `1` | Port increment between consecutive lanes. |
| `env_overrides` | `Record<string, string>` | `{}` | Environment variable overrides applied to each lane's execution environment. Keys are variable names; values are the override values. Values are copied verbatim — no template substitution. |
| `cache_redirects` | `Record<string, string>` | `{}` | Cache directory redirects for lane isolation. Keys must be valid env var names (e.g. `XDG_CACHE_HOME`, `TMPDIR`); values are redirected base paths. Useful for sandboxing cache access per lane. (The implementation appends `/lane-{laneIndex}` to each value as a per-lane suffix.) |

**Cross-platform sandbox mechanism:**

| Platform | Sandbox | Soft-fail |
|----------|---------|-----------|
| Linux | `bwrap` (bubblewrap) | Falls back to env+port only if `bwrap` is unavailable |
| macOS | `sandbox-exec` | Falls back to env+port only if `sandbox-exec` is unavailable |
| Windows | `native-runner/{mode}` with `powershell wrapper` fallback | Falls back to env+port only if sandbox preparation fails |

Same cross-platform behavior as `turbo.lean.runtime_isolation` — a lane never hard-fails due to sandbox unavailability.

**Example** — Configure worktree isolation with `deps_strategy: "copy"` and faster serialization release:

```json
{
  "worktree": {
    "policy": "auto",
    "deps_strategy": "copy",
    "serialization_release_after_dispatches": 3,
    "serialization_release_after_ms": 30000
  }
}
```

See [Modes Guide](modes.md#lean-turbo-lane-planning-engine) for the full Lean Turbo lane planning algorithm and conflict resolution rules.

## Execution Profile

The execution profile controls plan-scoped execution preferences. MODE: PLAN drafts the task graph, freezes the exact `swarm_id` plus plan title, asks the unified QA/parallelism/commit/auto-proceed question, calls `set_qa_gates` against that identity before the first `save_plan`, then saves the full profile with the same identity. SPECIFY, BRAINSTORM, and issue ingestion defer these choices because they do not yet have final task scopes. If an upgraded plan reports that its QA profile is not exact-bound, recover by rerunning `set_qa_gates` with the same `swarm_id`, the same `plan_title`, and `adopt_legacy_binding_only: true`; this exact-binds the existing profile without mutating gates or the lock.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallelization_enabled` | boolean | `false` (schema) / `true` (new plans, v8) | Enable parallel task execution within phases (composes with Lean Turbo). **v8 (#1674):** new plans created via `save_plan` default to `true`; the execution gate enforces serial automatically when the active phase's pending tasks are not provably file-disjoint. Existing plans are unchanged on upgrade. Opt out per-plan with `parallelization_enabled: false`. |
| `max_concurrent_tasks` | number | `10` | Maximum tasks that may run concurrently when `parallelization_enabled: true` (1–64) |
| `council_parallel` | boolean | `true` | Allow council review phases to run council members in parallel |
| `auto_proceed` | boolean | `false` | Skip the "Ready for Phase N+1?" prompt and advance automatically at phase boundaries |
| `commit_after_each_completed_task` | boolean | `false` | Create an advisory, idempotent checkpoint after a task completes and all pre-commit gates pass |

**Auto-proceed:** When `true`, the swarm advances from one phase to the next without asking for confirmation. The session override (`/swarm auto-proceed on|off`) always takes precedence over the plan default. The architect sees the effective value via an injected `AUTO PROCEED STATUS` banner. The first-boundary nudge offers to enable it once per session when the plan default is `false` and no session override is set.

### `turbo.epic` — Epic Mode settings

Epic Mode is an optional execution mode that augments Lean Turbo with autonomous, coupling-aware lane planning. With these keys at their defaults, no Epic-mode code runs and behavior is identical to Lean Turbo alone. See [Epic Mode](modes.md#epic-mode-preview) for the design.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cochange.enabled` | boolean | `false` | Master gate for the co-change conflict signal. With this off, the module is dormant and no Epic-mode code runs in any flow. |
| `cochange.threshold` | number | `0.6` | NPMI floor (range `[-1, 1]`) for a file pair to be treated as historically co-changing. Stricter than `co_change_analyzer`'s discovery default (`0.5`). |
| `cochange.min_co_changes` | number | `5` | Minimum raw co-change count required before NPMI is considered, to suppress small-sample noise. Stricter than the analyzer's discovery default (`3`). |

`turbo.epic` is independent of `turbo.strategy` — the keys are accepted under both `"standard"` and `"lean"` strategies. The block is purely additive; omitting it leaves Lean Turbo, Turbo, and Full-Auto behavior unchanged.

**Example** — Enable the co-change signal with conservative defaults:

```json
{
  "turbo": {
    "strategy": "lean",
    "lean": { "max_parallel_coders": 4 },
    "epic": {
      "cochange": {
        "enabled": true,
        "threshold": 0.6,
        "min_co_changes": 5
      }
    }
  }
}
```

### `turbo.epic.mode` — Epic Mode activation gate (Capability C, preview)

Epic Mode auto-decides per plan whether to invoke Lean Turbo's parallel planner or fall back to serial, based on the coupling coefficient `p`. See [Epic Mode (preview)](modes.md#capability-c--activation-gate-and-the-epic-mode-itself) for the design.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode.enabled` | boolean | `false` | Master gate for Epic Mode activation. When off, no Epic-mode runtime code runs. |
| `mode.activation_threshold` | number | `0.3` | Plan-wide `p` ceiling. Plans with `p ≤ activation_threshold` are eligible for parallel promotion; plans above are forced serial. |
| `mode.min_commits_for_signal` | number | `20` | Greenfield rule. A co-change history with fewer than this many commits is treated as too sparse — promotion is blocked regardless of `p`. |

**Example** — Enable Epic Mode with a strict threshold and dense-history requirement:

```json
{
  "turbo": {
    "strategy": "lean",
    "epic": {
      "mode": {
        "enabled": true,
        "activation_threshold": 0.2,
        "min_commits_for_signal": 50
      },
      "cochange": { "enabled": true }
    }
  }
}
```

## QA gates reference

The QA gate profile (per-plan, persisted in the project DB) controls which quality gates fire during a plan's execution. MODE: PLAN configures it through `set_qa_gates` using the frozen `swarm_id` and `plan_title` before the first plan save, eliminating any dependency on transient context files. Existing-plan administration remains available through `/swarm qa-gates enable <gate>...`. Upgraded legacy rows stay fail-closed until they are exact-bound; the supported recovery is `set_qa_gates({ swarm_id, plan_title, adopt_legacy_binding_only: true })`, which binds the current plan identity without changing gates or the lock.

All gates are **ratchet-tighter** — once enabled they cannot be disabled until the profile is reset, and once locked (after critic approval) no changes are accepted at all.

> **Not a YAML config key.** Every gate below — including `critic_pre_plan` — is a
> per-plan SQLite profile field, configured via the gate-selection dialogue or
> `set_qa_gates` / `/swarm qa-gates`, **not** a key under `config.qa_gates` in your
> OpenCode configuration file (`qa_gates` there is the unrelated guardrails config
> holding `required_tools` and `require_reviewer_test_engineer`). Writing
> `qa_gates.critic_pre_plan` in YAML has no effect; use `set_qa_gates` instead.

`test_engineer` is exempted for a coder task only when both its immutable
declared scope and the observed Git changes are non-empty, contain exact
case-sensitive `.md` final extensions, and the observed paths remain within
the declaration. Missing Git provenance, mixed files, scope mismatches, legacy
background records, and any non-`.md` path keep the full gate. `reviewer` and
`council_mode` behavior are unchanged.

| Gate | Default | Description |
|------|---------|-------------|
| `reviewer` | ON | Code review of coder output |
| `test_engineer` | ON | Test verification of coder output; automatically exempted only for proven exact `.md`-only tasks |
| `sme_enabled` | ON | SME consultation during planning / clarification |
| `critic_pre_plan` | ON | Critic review before plan finalization |
| `sast_enabled` | ON | Static security scanning |
| `council_mode` | OFF | Replaces per-task Stage B (reviewer + test_engineer) with full 5-member council per task (recommended for high-impact architecture, public APIs, schema/data mutation, security-sensitive code) |
| `hallucination_guard` | OFF | Mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP; blocks `phase_complete` until evidence is APPROVED |
| `mutation_test` | OFF | Runs mutation testing on source files touched this phase at PHASE-WRAP; FAIL blocks `phase_complete`, WARN is non-blocking |
| `drift_check` | ON | Mandatory per-phase drift verification at PHASE-WRAP; compares implemented changes against effective spec intent; hard-blocks `phase_complete` when an effective spec exists and drift evidence is missing or REJECTED; advisory-only when no effective spec exists |
| `phase_council` | OFF | Full 5-member council reviews all work in a phase holistically at `phase_complete` time. Additive to per-task gates. |
| `final_council` | OFF | Full 5-member council (NOT General Council) reviews the entire project at the last phase. Requires approved `.swarm/evidence/final-council.json`. |
