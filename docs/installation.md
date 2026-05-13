# Installation Guide

## Choose Your Path

**I want to install on my machine** (macOS, Linux, Windows, or Docker)  
→ See [Installation: Linux, Windows, and Docker](installation-linux-docker.md)

**I am an LLM or automation tool installing for a user**  
→ See [Installation: LLM Operator Guide](installation-llm-operator.md) (executable runbook)

**I want the full reference** (configuration, troubleshooting, all options)  
→ Continue below

---

## Quick Start

### 1. Add to OpenCode

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-swarm"]
}
```

Or install via CLI:

```bash
bunx opencode-swarm install
```

### 2. Configure Models

Create `~/.config/opencode/opencode-swarm.json`:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "google/gemini-2.5-flash" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "sme": { "model": "google/gemini-2.5-flash" },
    "reviewer": { "model": "google/gemini-2.5-flash" },
    "critic": { "model": "google/gemini-2.5-flash" },
    "test_engineer": { "model": "google/gemini-2.5-flash" },
    "docs": { "model": "google/gemini-2.5-flash" },
    "designer": { "model": "google/gemini-2.5-flash" }
  }
}
```

### 3. Start OpenCode

```bash
opencode
```

### 4. Select a Swarm Architect

> **Required:** You must select a Swarm architect from the agent/mode dropdown in the OpenCode GUI before starting. Using the default `Build` or `Plan` modes bypasses the Swarm plugin entirely.

In the OpenCode GUI, open the agent/mode selector and choose the architect that matches your config (e.g., `architect`, or a prefixed name like `local_architect` if you defined multiple swarms). The exact names shown in the dropdown come from your configuration.

You do **not** manually switch between the other internal agents (`coder`, `reviewer`, `critic`, etc.) — the architect coordinates them automatically.

### 5. Test It

```
Build me a simple REST API with a health-check endpoint.
```

You should see:
1. Architect checking for `.swarm/plan.md`
2. Explorer scanning the codebase
3. SMEs providing domain guidance
4. A phased plan being created

---

## Configuration Reference

### Model Assignment

Each agent can use a different model:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "google/gemini-2.5-flash" }
  }
}
```

### Disable Agents

```json
{
  "agents": {
    "critic": { "disabled": true }
  }
}
```

### Temperature

Adjust creativity/determinism per agent:

```json
{
  "agents": {
    "architect": { "model": "...", "temperature": 0.1 },
    "coder": { "model": "...", "temperature": 0.2 }
  }
}
```

---

## Multiple Swarms

Run multiple independent swarms with different model configurations.

### Basic Multi-Swarm Setup

```json
{
  "swarms": {
    "cloud": {
      "name": "Cloud",
      "agents": {
        "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
        "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
        "sme": { "model": "google/gemini-2.5-flash" },
        "reviewer": { "model": "openai/gpt-4o" },
        "critic": { "model": "openai/gpt-4o" }
      }
    },
    "local": {
      "name": "Local",
      "agents": {
        "architect": { "model": "ollama/qwen2.5:32b" },
        "coder": { "model": "ollama/qwen2.5:32b" },
        "sme": { "model": "ollama/qwen2.5:14b" },
        "reviewer": { "model": "ollama/qwen2.5:14b" },
        "critic": { "model": "ollama/qwen2.5:14b" }
      }
    }
  }
}
```

### How It Works

1. **First swarm is default**: The first swarm (or one named "default") creates standard agent names (`architect`, `coder`, etc.)

2. **Additional swarms are prefixed**: Other swarms prefix all agents with the swarm ID:
   - `local_architect`
   - `local_coder`
   - `local_sme`
   - etc.

3. **Each architect knows its agents**: The `local_architect` prompt is automatically updated to reference `local_explorer`, `local_coder`, etc.

4. **Display names in UI**: The `name` field (e.g., "Local") appears in descriptions.

### Example: Three-Tier Configuration

```json
{
  "swarms": {
    "premium": {
      "name": "Premium (Cloud)",
      "agents": {
        "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
        "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
        "sme": { "model": "anthropic/claude-sonnet-4-20250514" },
        "reviewer": { "model": "openai/gpt-4o" },
        "critic": { "model": "openai/gpt-4o" }
      }
    },
    "balanced": {
      "name": "Balanced",
      "agents": {
        "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
        "coder": { "model": "google/gemini-2.5-flash" },
        "sme": { "model": "google/gemini-2.5-flash" },
        "reviewer": { "model": "google/gemini-2.5-flash" },
        "critic": { "model": "google/gemini-2.5-flash" }
      }
    },
    "local": {
      "name": "Local (Offline)",
      "agents": {
        "architect": { "model": "ollama/qwen2.5:32b" },
        "coder": { "model": "ollama/qwen2.5:32b" },
        "sme": { "model": "ollama/qwen2.5:14b" },
        "reviewer": { "model": "ollama/qwen2.5:14b" },
        "critic": { "model": "ollama/qwen2.5:14b" }
      }
    }
  }
}
```

This creates:
- `architect` (Premium)
- `balanced_architect` (Balanced)
- `local_architect` (Local)

### Swarm-Specific Overrides

Each swarm supports the same configuration options as the legacy `agents` block:

```json
{
  "swarms": {
    "local": {
      "name": "Local",
      "agents": {
        "architect": { "model": "ollama/qwen2.5:32b" },
        "sme": { "model": "ollama/qwen2.5:14b" },
        "reviewer": { "model": "ollama/qwen2.5:14b" },
        "critic": { "disabled": true }
      }
    }
  }
}
```

### Legacy Compatibility

If you don't use `swarms`, the legacy `agents` config still works:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" }
  }
}
```

This creates a single swarm with standard agent names.

Lower (0.0-0.2) = more deterministic, better for code
Higher (0.5-0.8) = more creative, better for brainstorming

---

## Recommended Configurations

### Budget-Conscious

Use expensive models only where it matters:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "google/gemini-2.5-flash" },
    "sme": { "model": "google/gemini-2.5-flash" },
    "reviewer": { "model": "google/gemini-2.5-flash" },
    "critic": { "model": "google/gemini-2.5-flash" },
    "test_engineer": { "model": "google/gemini-2.5-flash" },
    "docs": { "model": "google/gemini-2.5-flash" },
    "designer": { "model": "google/gemini-2.5-flash" }
  }
}
```

### Maximum Diversity

Different vendors catch different bugs:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "google/gemini-2.5-flash" },
    "sme": { "model": "google/gemini-2.5-flash" },
    "reviewer": { "model": "openai/gpt-4o" },
    "critic": { "model": "google/gemini-2.5-flash" },
    "test_engineer": { "model": "openai/gpt-4o-mini" },
    "docs": { "model": "google/gemini-2.5-flash" },
    "designer": { "model": "google/gemini-2.5-flash" }
  }
}
```

### Local + Cloud Hybrid

Use local models for high-volume agents:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "ollama/qwen2.5:14b" },
    "sme": { "model": "ollama/qwen2.5:14b" },
    "reviewer": { "model": "ollama/qwen2.5:14b" },
    "critic": { "model": "ollama/qwen2.5:14b" },
    "test_engineer": { "model": "ollama/qwen2.5:14b" },
    "docs": { "model": "ollama/qwen2.5:14b" },
    "designer": { "model": "ollama/qwen2.5:14b" }
  }
}
```

### All-Claude (Enterprise)

Single vendor, premium quality:

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explorer": { "model": "anthropic/claude-haiku" },
    "sme": { "model": "anthropic/claude-haiku" },
    "reviewer": { "model": "anthropic/claude-sonnet-4-20250514" },
    "critic": { "model": "anthropic/claude-sonnet-4-20250514" },
    "test_engineer": { "model": "anthropic/claude-haiku" },
    "docs": { "model": "anthropic/claude-haiku" },
    "designer": { "model": "anthropic/claude-haiku" }
  }
}
```

---

## Custom Prompts

Override or extend agent prompts.

### Directory

Place custom prompts in:
```
~/.config/opencode/opencode-swarm/
```

### Replace Entire Prompt

Create `{agent}.md`:
```
~/.config/opencode/opencode-swarm/architect.md
```

### Append to Default

Create `{agent}_append.md`:
```
~/.config/opencode/opencode-swarm/architect_append.md
```

### Example: Add Custom Guidelines

`~/.config/opencode/opencode-swarm/architect_append.md`:
```markdown
## Additional Project Guidelines

- All code must be HIPAA compliant
- Use PowerShell 7+ syntax only
- Include verbose logging with -Verbose support
- Follow company naming conventions: Verb-CompanyNoun
```

---

## Project Files

Swarm creates a `.swarm/` directory in your project:

```
.swarm/
├── plan.md        # Legacy phased roadmap (migrated to plan.json)
├── plan.json      # Machine-readable plan with Zod-validated schema
├── context.md     # Project knowledge, SME cache
├── evidence/      # Per-task execution evidence bundles
└── history/       # Archived phase summaries
```

### Should I Commit These?

**Yes.** These files are:
- Human-readable documentation
- Useful for onboarding
- Part of project history

Add to `.gitignore` if you prefer not to track:
```
.swarm/
```

---

## Resuming Projects

Swarm automatically resumes projects:

1. Architect checks for `.swarm/plan.md`
2. If found, reads current phase and task
3. Continues from where it left off

To start fresh:
```bash
rm -rf .swarm/
```

Or use the slash command:
```
/swarm reset --confirm
```

---

## Troubleshooting

### Agents Not Loading

1. Verify plugin in `opencode.json`
2. Check config JSON syntax
3. Restart OpenCode

### Wrong Model Used

1. Check for typos in model names
2. Verify agent-specific overrides in config
3. Check swarm-level vs top-level config precedence

### SMEs Not Being Called

1. Check if domain is disabled
2. Verify Explorer is detecting relevant domains
3. Check context.md for cached guidance (may be skipping)

### Plan Not Created

1. Ensure Architect has write permissions
2. Check for `.swarm/` directory creation
3. Review Architect output for errors

### Tasks Failing Repeatedly

1. Check plan.md for attempt history
2. Review rejection reasons
3. Consider re-scoping task
4. May need clearer acceptance criteria

---

## Hooks Configuration

Control which hooks are active:

```json
{
  "hooks": {
    "system_enhancer": true,
    "compaction": true,
    "agent_activity": true,
    "delegation_tracker": false,
    "agent_awareness_max_chars": 300
  }
},
"knowledge": {
  "enabled": true,
  "swarm_max_entries": 100,
  "hive_max_entries": 1000,
  "auto_promote_days": 30,
  "max_inject_count": 5,
  "dedup_threshold": 0.6,
  "scope_filter": ["global"],
  "hive_enabled": true,
  "rejected_max_entries": 200,
  "validation_enabled": true,
  "evergreen_confidence": 0.8,
  "evergreen_utility": 0.5,
  "low_utility_threshold": 0.2,
  "min_retrievals_for_utility": 3,
  "schema_version": "v6.17"
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `system_enhancer` | boolean | `true` | Inject current phase, task, and decisions into agent system prompts |
| `compaction` | boolean | `true` | Enrich session compaction with plan.md and context.md data; injects optimization hints when stored tool outputs exist in `.swarm/summaries/` |
| `agent_activity` | boolean | `true` | Track tool usage per agent, flush activity summary to context.md |
| `delegation_tracker` | boolean | `false` | Log delegation chains in chat.message hook (diagnostic, opt-in) |
| `agent_awareness_max_chars` | number | `300` | Max characters for cross-agent context injection in system prompts |

---

## Context Budget Configuration

Context budget controls (full schema in `src/config/schema.ts`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable token budget tracking and warnings |
| `warn_threshold` | number | `0.7` | Inject warning message at this percentage of token limit |
| `critical_threshold` | number | `0.9` | Inject critical warning at this percentage of token limit |
| `model_limits` | object | `{ "default": 128000 }` | Token limits per model. Use `"default"` as fallback. |
| `max_injection_tokens` | number | `4000` | Maximum tokens for system prompt injection. Priority‑ordered: phase → task → decisions → agent context |
| `tracked_agents` | string[] | `["architect"]` | List of agents whose messages count toward the budget |
| `enforce` | boolean | `true` | When `true` the system will abort or truncate messages that exceed the critical threshold |
| `prune_target` | number | `0.7` | Target token usage after pruning (as a fraction of the model limit) |
| `preserve_last_n_turns` | number | `4` | Number of recent message turns to keep intact during pruning |
| `recent_window` | number | `10` | How many recent turns are considered for priority‑based pruning |
| `enforce_on_agent_switch` | boolean | `true` | Enforce a hard context reset when the active agent changes (e.g., from `explorer` to `coder`) |
| `tool_output_mask_threshold` | number | `2000` | Minimum token count at which tool output is masked/truncated to stay within the budget |

```json
{
  "context_budget": {
    "enabled": true,
    "warn_threshold": 0.7,
    "critical_threshold": 0.9,
    "model_limits": {
      "default": 128000,
      "anthropic/claude-sonnet-4-20250514": 200000
    },
    "tracked_agents": ["architect"],
    "enforce": true,
    "prune_target": 0.7,
    "preserve_last_n_turns": 4,
    "recent_window": 10,
    "enforce_on_agent_switch": true,
    "tool_output_mask_threshold": 2000
  }
}
```

Monitor and warn about context window usage:

```json
{
  "context_budget": {
    "enabled": true,
    "warn_threshold": 0.7,
    "critical_threshold": 0.9,
    "model_limits": {
      "default": 128000,
      "anthropic/claude-sonnet-4-20250514": 200000
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable token budget tracking and warnings |
| `warn_threshold` | number | `0.7` | Inject warning message at this percentage of token limit |
| `critical_threshold` | number | `0.9` | Inject critical warning at this percentage of token limit |
| `model_limits` | object | `{ "default": 128000 }` | Token limits per model. Use `"default"` as fallback. |
| `max_injection_tokens` | number | `4000` | Maximum tokens for system prompt injection. Priority-ordered: phase → task → decisions → agent context |

### How It Works

1. On each message transform, total tokens are estimated across all message parts
2. Token estimation uses a conservative ratio: `chars × 0.33`
3. When usage exceeds `warn_threshold`: `[CONTEXT WARNING: ~N% used. Consider summarizing to .swarm/context.md]`
4. When usage exceeds `critical_threshold`: `[CONTEXT CRITICAL: ~N% used. Offload details immediately]`

---

## Evidence Configuration

Configure evidence bundle retention:

```json
{
  "evidence": {
    "enabled": true,
    "max_age_days": 90,
    "max_bundles": 1000,
    "auto_archive": false
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable evidence bundle persistence |
| `max_age_days` | number | `90` | Archive evidence older than N days |
| `max_bundles` | number | `1000` | Maximum evidence bundles before auto-archive |
| `auto_archive` | boolean | `false` | Enable automatic archiving of old evidence |

---

## Guardrails Configuration

Control agent execution limits:

```json
{
  "guardrails": {
    "enabled": true,
    "max_tool_calls": 200,
    "max_duration_minutes": 30,
    "max_repetitions": 10,
    "max_consecutive_errors": 5,
    "warning_threshold": 0.5,
    "qa_gates": {
      "required_tools": ["diff", "syntax_check", "placeholder_scan", "lint", "pre_check_batch"],
      "require_reviewer_test_engineer": true
    },
    "profiles": {
      "coder": { "max_tool_calls": 300, "max_duration_minutes": 60 },
      "explorer": { "max_tool_calls": 100, "max_duration_minutes": 10 }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable guardrail limits for all agents |
| `max_tool_calls` | number | `200` | Maximum tool calls per agent task |
| `max_duration_minutes` | number | `30` | Maximum minutes per agent task |
| `max_repetitions` | number | `10` | Maximum repetitions of similar tool calls |
| `max_consecutive_errors` | number | `5` | Maximum consecutive tool errors before circuit break |
| `warning_threshold` | number | `0.5` | Inject warning at this percentage of any limit |
| `profiles` | object | — | Per-agent overrides. Keys are agent names, values override base settings. |
| `qa_gates.required_tools` | string[] | `diff,syntax_check,placeholder_scan,lint,pre_check_batch` | Tool gates that must be observed before task completion to avoid partial QA warning. |
| `qa_gates.require_reviewer_test_engineer` | boolean | `true` | Require reviewer/test_engineer delegation evidence in the active phase for QA completion. |

**Default behavior (important):** `qa_gates` is optional. If you omit `guardrails.qa_gates`, opencode-swarm preserves the existing full QA-gate behavior (`diff`, `syntax_check`, `placeholder_scan`, `lint`, `pre_check_batch`) and still requires reviewer/test_engineer delegation evidence. Configure `qa_gates` only when you intentionally want to customize these enforcement rules.

**How to enable/configure (for requested custom behavior):**

- QA gates are already active by default when `guardrails.enabled` is `true` (default).
- To explicitly configure them, add a `guardrails.qa_gates` block in `.opencode/opencode-swarm.json`:

```jsonc
{
  "guardrails": {
    "enabled": true,
    "qa_gates": {
      "required_tools": ["diff", "syntax_check", "placeholder_scan", "lint", "pre_check_batch"],
      "require_reviewer_test_engineer": true
    }
  }
}
```

**Architect is exempt/unlimited by default:** The architect agent has no guardrail limits by default (0 = unlimited). The system uses a 10-second stale delegation window to prevent the architect from inheriting subagent limits during rapid delegation transitions. To override, add a `profiles.architect` entry:

```jsonc
{
  "guardrails": {
    "profiles": {
      "architect": { "max_tool_calls": 500, "max_duration_minutes": 60 }
    }
  }
}
```

---

## Review Passes Configuration

Control the dual-pass security review behavior introduced in v6.0.0:

```jsonc
{
  "review_passes": {
    "always_security_review": false,
    "security_globs": [
      "**/*auth*", "**/*crypto*",
      "**/*session*", "**/*token*",
      "**/*middleware*", "**/*api*",
      "**/*security*"
    ]
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `always_security_review` | boolean | `false` | When `true`, run a security-only review pass on every task regardless of file path. When `false`, only trigger on files matching `security_globs`. |
| `security_globs` | string[] | 7 patterns | Glob patterns for security-sensitive files. When a changed file matches any pattern, the architect triggers an automatic security-only reviewer pass after the general review. |

The security review pass uses **OWASP Top 10 2021** categories as its review framework. It runs as a separate reviewer delegation that reuses the same reviewer agent with security-only framing.

---

## Integration Analysis Configuration

Control whether contract change detection triggers automatic impact analysis:

```jsonc
{
  "integration_analysis": {
    "enabled": true
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | When `true`, the architect runs the `diff` tool after each coder task. If contract changes are detected (exported functions, interfaces, type definitions), the explorer is delegated to run impact analysis across dependent files before review begins. |

### What Counts as a Contract Change

The `diff` tool flags these patterns as contract changes:
- `export function`, `export const`, `export class`, `export interface`, `export type`
- `export default`
- `export { ... }` (re-exports)

When contract changes are detected, the explorer analyzes:
- Which files import the changed exports
- Whether the changes are additive (safe) or breaking (signature changes, removals)
- Downstream impact on dependent modules

---

## Automation Configuration (v6.8)

Control background-first automation and feature flags:

```jsonc
{
  "automation": {
    "mode": "manual",
    "capabilities": {
      "plan_sync": true,
      "phase_preflight": false,
      "config_doctor_on_startup": false,
      "config_doctor_autofix": false,
      "evidence_auto_summaries": true,
      "decision_drift_detection": false
    }
  }
}
```

| `mode` | string | `"manual"` | Automation mode: `"manual"` (no background automation), `"hybrid"` (safe ops only), `"auto"` (full automation). **Default: `manual`** for backward compatibility. |
| `plan_sync` | boolean | `true` | Enable automatic plan synchronization. When enabled, Swarm regenerates plan.md from canonical plan.json when they're out of sync. Safe - read-only operation. **Default changed to `true` in v6.8**. |
| `phase_preflight` | boolean | `false` | Enable phase-boundary preflight checks before agent execution. Validates plan completeness, evidence requirements, and blockers. Returns actionable findings. |
| `evidence_auto_summaries` | boolean | `true` | Generate automatic evidence summaries for long-running tasks. Aggregates evidence per task and phase, producing machine-readable JSON and human-readable markdown. **Default changed to `true` in v6.8**. |
| `decision_drift_detection` | boolean | `false` | Detect drift between planned and actual decisions. Caches decisions from `## Decisions` section in context.md, identifies stale decisions and contradictions. |

### How Automation Modes Work

#### Manual (Default)

No background automation. All actions require explicit slash commands:
- `/swarm preflight` - Run preflight checks manually
- `/swarm config doctor` - Validate config manually
- `/swarm sync-plan` - Sync plan.md from plan.json manually

Choose manual when you want full control over background operations.

#### Hybrid

Background automation for safe operations:
- Config Doctor runs on startup with auto-fix (if enabled)
- Evidence summaries generated automatically
- Plan sync happens in background

Manual triggers for sensitive operations:
- Preflight checks run via slash command
- Any manual overrides via `/swarm` commands

Choose hybrid when you want safe-ops automation but manual approval for sensitive changes.

#### Auto

Full background automation (target state):
- All automation features run automatically
- Preflight checks on phase boundaries
- Config Doctor on startup
- Evidence summaries generated automatically
- Plan sync in background

Pick auto once you've tested the individual capabilities and want full throughput.

### Feature Flag Safety

Every automation capability is default-off:

- Start with `mode: "manual"` and all capabilities `false`
- Enable features as you test them
- Never enable everything at once
- Revert to manual mode if something goes wrong

#### Config Doctor security

- Defaults to scan-only mode (`autoFix: false`)
- Only runs auto-fix when explicitly enabled via `config_doctor_autofix: true`
- Creates encrypted backups in `.swarm/` before applying fixes
- Supports restore via `/swarm config doctor --restore <backup-id>`

### GUI Visibility

When automation is enabled, Swarm writes status to `.swarm/automation-status.json`:

```json
{
  "timestamp": 1234567890,
  "mode": "manual",
  "enabled": false,
  "currentPhase": 2,
  "lastTrigger": null,
  "pendingActions": 0,
  "lastOutcome": null,
  "capabilities": {
    "plan_sync": false,
    "phase_preflight": false,
    "config_doctor_on_startup": false,
    "config_doctor_autofix": false,
    "evidence_auto_summaries": false,
    "decision_drift_detection": false
  }
}
```

GUI can read this file to show automation status, current phase, and pending actions.

### Slash Commands for Automation

| Command | Function | Use Case |
|---------|----------|----------|
| `/swarm preflight` | Run preflight checks on current plan | Validate before starting phase |
| `/swarm config doctor [--fix] [--restore <id>]` | Config Doctor with optional auto-fix and restore | Fix configuration issues |
| `/swarm sync-plan` | Force plan.md regeneration from plan.json | Sync plan files |

All automation commands:
- Non-blocking (fire and forget for background operations)
- Async execution (don't block OpenCode UI)
- Log results to console
- Store artifacts in `.swarm/`

---

## Quality Gates Configuration (v6.9.0)

Six automated gates enforce code quality before human review. All gates run locally without Docker or network dependencies.

### Basic Configuration

Enable all gates with defaults:

```json
{
  "gates": {
    "syntax_check": { "enabled": true },
    "placeholder_scan": { "enabled": true },
    "sast_scan": { "enabled": true },
    "sbom_generate": { "enabled": true },
    "build_check": { "enabled": true },
    "quality_budget": { "enabled": true }
  }
}
```

### Gate Reference

| Gate | Description | Default | Fail Action |
|------|-------------|---------|-------------|
| `syntax_check` | Tree-sitter parse validation (20 languages) | `true` | Block review |
| `placeholder_scan` | Detect TODO/FIXME/stub implementations | `true` | Block review |
| `sast_scan` | Static security analysis (63+ rules) | `true` | Block review |
| `sbom_generate` | Generate CycloneDX SBOM | `true` | Continue (informational) |
| `build_check` | Build/typecheck verification | `true` | Block review |
| `quality_budget` | Enforce maintainability thresholds | `true` | Block review |

### Per-Gate Configuration

#### syntax_check

```json
{
  "gates": {
    "syntax_check": {
      "enabled": true
    }
  }
}
```

Supports TypeScript, JavaScript, Python, Rust, Go, Java, C/C++, Ruby, PHP, and C# via Tree-sitter grammars.

#### placeholder_scan

```json
{
  "gates": {
    "placeholder_scan": {
      "enabled": true,
      "patterns": ["TODO", "FIXME", "XXX", "HACK"],
      "block_on_empty_functions": true
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `patterns` | string[] | `["TODO", "FIXME", "XXX", "HACK"]` | Comment patterns to detect |
| `block_on_empty_functions` | boolean | `true` | Fail on empty function bodies |

#### sast_scan

```json
{
  "gates": {
    "sast_scan": {
      "enabled": true,
      "severity_threshold": "high",
      "use_semgrep_if_available": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `severity_threshold` | string | `"high"` | Minimum severity to fail (`critical`, `high`, `medium`, `low`) |
| `use_semgrep_if_available` | boolean | `false` | Use Semgrep Tier B rules if on PATH |

**Local-Only Guarantee**: Built-in 63-rule engine runs without network. Semgrep is optional enhancement only.

#### sbom_generate

```json
{
  "gates": {
    "sbom_generate": {
      "enabled": true,
      "output_format": "cyclonedx-json",
      "include_dev_dependencies": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `output_format` | string | `"cyclonedx-json"` | SBOM format (CycloneDX JSON) |
| `include_dev_dependencies` | boolean | `false` | Include dev/test dependencies |

**Supported ecosystems**: npm, Python (pip/Pipfile/poetry), Rust (Cargo), Go, Java (Maven/Gradle), Ruby (Bundler), PHP (Composer), C# (NuGet)

#### build_check

```json
{
  "gates": {
    "build_check": {
      "enabled": true,
      "commands": {
        "typescript": ["npm", "run", "build"],
        "python": ["python", "-m", "py_compile"]
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `commands` | object | Auto-detected | Per-language build commands |

Auto-detected commands by ecosystem:
- TypeScript: `npm run build` or `tsc --noEmit`
- Rust: `cargo build` or `cargo check`
- Go: `go build`
- Java: `mvn compile` or `gradle build`
- Python: `python -m py_compile`

#### quality_budget

```json
{
  "gates": {
    "quality_budget": {
      "enabled": true,
      "max_complexity_delta": 5,
      "max_public_api_delta": 10,
      "max_duplication_ratio": 0.05,
      "min_test_to_code_ratio": 0.3
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max_complexity_delta` | number | `5` | Max cyclomatic complexity increase per task |
| `max_public_api_delta` | number | `10` | Max new public API surface per task |
| `max_duplication_ratio` | number | `0.05` | Max code duplication ratio (5%) |
| `min_test_to_code_ratio` | number | `0.3` | Minimum test-to-code ratio (30%) |

**Budget Enforcement**:
- Exceeding any budget fails the gate
- Architect can override per-task with explicit decision
- Violations logged to context.md for tracking

### Complete Configuration Example

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "minimax-coding-plan/MiniMax-M2.5" }
  },
  "gates": {
    "syntax_check": {
      "enabled": true
    },
    "placeholder_scan": {
      "enabled": true,
      "patterns": ["TODO", "FIXME", "XXX", "HACK", "NOTE"],
      "block_on_empty_functions": true
    },
    "sast_scan": {
      "enabled": true,
      "severity_threshold": "high",
      "use_semgrep_if_available": true
    },
    "sbom_generate": {
      "enabled": true,
      "include_dev_dependencies": false
    },
    "build_check": {
      "enabled": true
    },
    "quality_budget": {
      "enabled": true,
      "max_complexity_delta": 3,
      "max_public_api_delta": 5,
      "max_duplication_ratio": 0.03,
      "min_test_to_code_ratio": 0.4
    }
  },
  "guardrails": {
    "max_tool_calls": 200
  }
}
```

### Disabling Gates

To disable specific gates:

```json
{
  "gates": {
    "sbom_generate": { "enabled": false },
    "quality_budget": { "enabled": false }
  }
}
```

Or disable all gates:

```json
{
  "gates": {
    "syntax_check": { "enabled": false },
    "placeholder_scan": { "enabled": false },
    "sast_scan": { "enabled": false },
    "sbom_generate": { "enabled": false },
    "build_check": { "enabled": false },
    "quality_budget": { "enabled": false }
  }
}
```

### Local-Only Guarantee

Quality gates run entirely on your machine: no Docker, no network calls, no external APIs, no cloud services.

Optional enhancement: Semgrep CLI (if already on PATH, not required).

---

## Slash Commands

Twelve commands are available under `/swarm`:

### `/swarm status`

Shows current swarm state:
- Current phase and phase status
- Task progress (completed / total) in current phase
- Number of registered agents

```
Phase: 2 [IN PROGRESS]
Tasks: 3/5 complete
Agents: 9 registered
```

### `/swarm plan`

Displays the full `.swarm/plan.md` content.

### `/swarm plan N`

Displays only Phase N from the plan. Example:

```
/swarm plan 2
```

Shows the Phase 2 section including all tasks, dependencies, and status.

### `/swarm agents`

Lists all registered agents with their configuration including guardrail profiles:

```
| Agent          | Model                        | Temp | Read-Only | Guardrails        |
|----------------|------------------------------|------|-----------|-------------------|
| architect      | anthropic/claude-sonnet-4-20250514   | 0.1  | No        | max_tools: 200    |
| explorer       | google/gemini-2.5-flash      | 0.1  | Yes       | max_tools: 200    |
| coder          | anthropic/claude-sonnet-4-20250514   | 0.2  | No        | max_tools: 200    |
| ...            | ...                          | ...  | ...       | ...               |
```

### `/swarm history`

View completed phases with status icons.

### `/swarm config`

View current resolved plugin configuration.

### `/swarm diagnose`

Health check for `.swarm/` files, plan structure, and evidence completeness.

### `/swarm export`

Export plan and context as portable JSON.

### `/swarm reset --confirm`

Clear swarm state files. Requires `--confirm` flag as a safety gate.

### `/swarm evidence [task]`

View evidence bundles for a specific task, or list all tasks with evidence when no task ID is provided.

### `/swarm archive [--dry-run]`

Archive old evidence bundles based on the retention policy. Use `--dry-run` to preview what would be archived.

### `/swarm benchmark`

Run performance benchmarks and display metrics. Tracks tool call rates, delegation chains, and evidence-derived pass rates.

### `/swarm retrieve [id]`

Retrieve the full content behind a summary ID (like `S1`, `S2`) when the summary alone is insufficient.
