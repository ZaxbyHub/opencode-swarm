# OpenCode Swarm

**Your AI writes the code. Swarm makes sure it actually works.**

https://swarmai.site/

OpenCode Swarm is a plugin for [OpenCode](https://opencode.ai) that turns a single AI coding session into an architect-led team of specialized agents. One agent writes the code. A different agent reviews it. Another writes and runs tests. Another checks security. Nothing ships until every required gate passes.

You do **not** manually switch between Swarm's internal agents during normal use.

You must **explicitly choose a Swarm architect** in the OpenCode GUI before starting. The architect name shown in OpenCode is config-driven — you can define multiple architects with different model assignments in your configuration, and those custom names will appear in the GUI dropdown.

If you use OpenCode's default `Build` / `Plan` options instead of selecting a Swarm architect, the plugin is bypassed entirely.

Once you select a Swarm architect, that architect coordinates the internal pipeline behind the scenes, and all project state is persisted to `.swarm/` so work can resume later.

```bash
npm install -g opencode-swarm
```

* * *

## What Actually Happens

You say:

```text
Build me a JWT auth system.
```

Swarm then:

1. Clarifies only what it cannot infer.
2. Scans the codebase to understand what already exists.
3. Consults domain experts when needed and caches the guidance.
4. Writes a phased implementation plan.
5. Sends that plan through a critic gate before coding starts.
6. Executes one task at a time through the QA pipeline:

   * coder writes code
   * automated checks run
   * reviewer checks correctness
   * test engineer writes and runs tests
   * failures loop back with structured feedback

7. After each phase, docs and retrospectives are updated.

All project state lives in `.swarm/`:

```text
.swarm/
├── plan.md
├── context.md
├── evidence/
└── history/
```

That means Swarm is resumable by design. If you come back later and `.swarm/` already exists, the architect may go straight into **RESUME** or **EXECUTE** instead of replaying the full first-run discovery flow.

---

## Why This Exists

Most AI coding tools let one model write code and then ask that same model whether the code is good. That misses too much.

Swarm separates planning, implementation, review, testing, and documentation into specialized internal roles, and it enforces gated execution instead of letting multiple agents mutate the codebase in parallel.

---

## Quick Start

### 1. Install

```bash
npm install -g opencode-swarm
```

> **Compatibility:** opencode-swarm requires an OpenCode host with the object-shaped plugin API — OpenCode **1.3.4 or newer on the v1 line**, or **any 2.x release**. Hosts older than 1.3.4 call every plugin export as a function and will silently drop the plugin (no Swarm agents appear, and no error is shown).

### 2. Open your project in OpenCode

```bash
opencode
```

### 3. Verify Swarm is loaded

Run these once in a project:

```text
/swarm diagnose
/swarm agents
/swarm config
```

What they tell you:

* `/swarm diagnose` verifies Swarm health and setup
* `/swarm agents` shows the registered internal agents and model assignments
* `/swarm config` shows the resolved configuration currently in effect

### 4. Select a Swarm architect and start

1. **Choose a Swarm architect** in the OpenCode GUI (the exact name depends on your configuration — you can define multiple architects with different model assignments)
2. Then describe what you want to build.

```text
Build a REST API with user registration, login, and JWT auth.
```

You do **not** manually choose `coder`, `reviewer`, `critic`, or other internal agents. The **architect** coordinates them automatically after you select it.

### 5. Understand first run vs later runs

On a brand-new project with no `.swarm/` state, Swarm usually starts by clarifying, discovering, consulting, and planning.

On a project that already has `.swarm/plan.md`, Swarm may resume immediately. That is expected.

Use these commands any time:

```text
/swarm status
/swarm plan
/swarm history
```

### 6. Start over when needed

If you want a completely fresh Swarm run for the current project:

```text
/swarm reset --confirm
```

Use this only when you intentionally want to discard current Swarm state.

### 7. Configure models (optional)

By default, Swarm works with its default model setup. If you want to override agent models, create:

```text
.opencode/opencode-swarm.json
```

Example:

```json
{
  "agents": {
    "coder": { "model": "opencode/minimax-m2.5-free" },
    "reviewer": { "model": "opencode/big-pickle" }
  }
}
```

You only need to specify the agents you want to override.

> Note: if `architect` is not set explicitly, it inherits the current model selected in the OpenCode UI.

## Common First-Run Questions

### "Do I need to select a Swarm architect?"

**Yes.** You must explicitly choose a Swarm architect agent in the OpenCode GUI before starting your session. The architect name shown in OpenCode is config-driven — you can define multiple architects with different model assignments in your configuration.

If you use the default OpenCode `Build` / `Plan` options without selecting a Swarm architect, the plugin is bypassed entirely.

### "Why did the second run start coding immediately?"

Because Swarm persists state in `.swarm/` and resumes from where it left off. Check `/swarm status` or `/swarm plan`.

### "How do I know Swarm is really active?"

Run:

```text
/swarm diagnose
/swarm agents
/swarm config
```

### "How do I force a clean restart?"

Run:

```text
/swarm reset --confirm
```

---

## LLM Provider Guide

Swarm works with any LLM provider supported by OpenCode. Different agents benefit from different models — the architect needs strong reasoning, the coder needs strong code generation, and the reviewer benefits from a model different from the coder (to catch blind spots).

### Free Tier (OpenCode Zen Models)

OpenCode Zen provides free models via the `opencode/` provider prefix. These are excellent starting points and require no API key:

```json
{
  "agents": {
    "coder":        { "model": "opencode/minimax-m2.5-free" },
    "reviewer":     { "model": "opencode/big-pickle" },
    "test_engineer":{ "model": "opencode/gpt-5-nano" },
    "explorer":     { "model": "opencode/trinity-large-preview-free" },
    "sme":          { "model": "opencode/trinity-large-preview-free" },
    "critic":       { "model": "opencode/trinity-large-preview-free" },
    "docs":         { "model": "opencode/trinity-large-preview-free" },
    "designer":     { "model": "opencode/trinity-large-preview-free" }
  }
}
```

> Save this configuration to `.opencode/opencode-swarm.json` in your project root (or `~/.config/opencode/opencode-swarm.json` for global config).

> **Note:** The `architect` key is intentionally omitted — it inherits whatever model you have selected in the OpenCode UI for maximum reasoning quality.

### Paid Providers

For production use, mix providers to maximize quality across writing vs. reviewing:

| Agent | Recommended Model | Why |
|---|---|---|
| `architect` | OpenCode UI selection | Needs strongest reasoning |
| `coder` | `minimax-coding-plan/MiniMax-M2.5` | Fast, accurate code generation |
| `reviewer` | `zai-coding-plan/glm-5` | Different training data from coder |
| `test_engineer` | `minimax-coding-plan/MiniMax-M2.5` | Same strengths as coder |
| `explorer` | `google/gemini-2.5-flash` | Fast read-heavy analysis |
| `sme` | `kimi-for-coding/k2p5` | Strong domain expertise |
| `critic` | `zai-coding-plan/glm-5` | Independent plan review |
| `docs` | `zai-coding-plan/glm-4.7-flash` | Fast, cost-effective documentation generation |
| `designer` | `kimi-for-coding/k2p5` | Strong UI/UX generation capabilities |

### Provider Formats

| Provider | Format | Example |
|---|---|---|
| OpenCode Zen (free) | `opencode/<model>` | `opencode/trinity-large-preview-free` |
| Anthropic | `anthropic/<model>` | `anthropic/claude-opus-4-6` |
| Google | `google/<model>` | `google/gemini-2.5-flash` |
| Z.ai | `zai-coding-plan/<model>` | `zai-coding-plan/glm-5` |
| MiniMax | `minimax-coding-plan/<model>` | `minimax-coding-plan/MiniMax-M2.5` |
| Kimi | `kimi-for-coding/<model>` | `kimi-for-coding/k2p5` |

## Useful Commands

| Command | What It Does |
|---------|-------------|
| `/swarm status` | Where am I? Current phase, task progress |
| `/swarm plan` | Show the full project plan |
| `/swarm diagnose` | Health check for swarm state, including config parsing, grammar files, checkpoint manifest, events stream integrity, and steering directive staleness |
| `/swarm evidence 2.1` | Show review/test results for a specific task |
| `/swarm history` | What's been completed so far |
| `/swarm reset --confirm` | Start over (clears all swarm state) |

---

## The Agents

Swarm has specialized internal agents, but you do **not** manually switch into them during normal use.

The **architect** is the coordinator. It decides when to invoke the other agents and what they should do.

That means the normal user workflow is:

1. open the project in OpenCode
2. describe what you want built or changed
3. let Swarm coordinate the internal pipeline
4. inspect progress with `/swarm status`, `/swarm plan`, and `/swarm evidence`

Agent roles:

| Agent | Role | When It Runs |
|---|---|---|
| `architect` | Coordinates the workflow, writes plans, enforces gates | Always |
| `explorer` | Scans the codebase and gathers context | Before planning, after phase wrap |
| `sme` | Provides domain guidance | During planning / consultation |
| `critic` | Reviews the plan before execution | Before coding starts |
| `coder` | Implements one task at a time | During execution |
| `reviewer` | Reviews correctness and security | After each task |
| `test_engineer` | Writes and runs tests | After each task |
| `designer` | Generates UI scaffolds and design tokens when needed | UI-specific work |
| `docs` | Updates docs to match what was actually built | After each phase |

If you want to see what is active right now, run:

```text
/swarm status
/swarm agents
```

---

## How It Compares

| | OpenCode Swarm | oh-my-opencode | get-shit-done |
|---|:-:|:-:|:-:|
| Multiple specialized agents | ✅ 9 agents | ❌ Prompt config | ❌ Single-agent macros |
| Plan reviewed before coding starts | ✅ | ❌ | ❌ |
| Every task reviewed + tested | ✅ | ❌ | ❌ |
| Different model for review vs. coding | ✅ | ❌ | ❌ |
| Saves state to disk, resumable | ✅ | ❌ | ❌ |
| Security scanning built in | ✅ | ❌ | ❌ |
| Learns from its own mistakes | ✅ (retrospectives) | ❌ | ❌ |

---

<details>
<summary><strong>Full Execution Pipeline (Technical Detail)</strong></summary>

### The Pipeline

Every task goes through this sequence. No exceptions, no overrides.

```
MODE: EXECUTE (per task)
│
├── 5a. @coder implements (ONE task only)
├── 5b. diff + imports (contract + dependency analysis)
├── 5c. syntax_check (parse validation)
├── 5d. placeholder_scan (catches TODOs, stubs, incomplete code)
├── 5e. lint fix → lint check
├── 5f. build_check (does it compile?)
├── 5g. pre_check_batch (4 parallel: lint, secretscan, SAST, quality budget)
├── 5h. @reviewer (correctness pass)
├── 5i. @reviewer (security pass, if security-sensitive files changed)
├── 5j. @test_engineer (verification tests + coverage ≥70%)
├── 5k. @test_engineer (adversarial tests)
├── 5l. ⛔ Pre-commit checklist (all 4 items required, no override)
└── 5m. Task marked complete, evidence written
```

If any step fails, the coder gets structured feedback and retries. After 5 failures on the same task, it escalates to you.

### Architect Workflow Modes

The architect moves through these modes automatically:

| Mode | What It Means |
|---|---|
| `RESUME` | Existing `.swarm/` state was found, so Swarm continues where it left off |
| `CLARIFY` | Swarm asks for missing information it cannot infer |
| `DISCOVER` | Explorer scans the codebase |
| `CONSULT` | SME agents provide domain guidance |
| `PLAN` | Architect writes or updates the phased plan |
| `CRITIC-GATE` | Critic reviews the plan before execution |
| `EXECUTE` | Tasks are implemented one at a time through the QA pipeline |
| `PHASE-WRAP` | A phase closes out, docs are updated, and a retrospective is written |

### Important

A second or later run does **not** necessarily look like a first run.

If `.swarm/plan.md` already exists, the architect may enter `RESUME` and then go directly into `EXECUTE`. That is expected and does **not** mean Swarm stopped using agents.

Use `/swarm status` if you are unsure what Swarm is doing.

Release automation uses release-please and requires conventional commit prefixes such as `fix:` or `feat:` on changes merged to `main`.

</details>

<details>
<summary><strong>Persistent Memory (What's in .swarm/)</strong></summary>

### plan.md: Your Project Roadmap

```markdown
# Project: Auth System
Current Phase: 2

## Phase 1: Foundation [COMPLETE]
- [x] Task 1.1: Create user model [SMALL]
- [x] Task 1.2: Add password hashing [SMALL]
- [x] Task 1.3: Database migrations [MEDIUM]

## Phase 2: Core Auth [IN PROGRESS]
- [x] Task 2.1: Login endpoint [MEDIUM]
- [ ] Task 2.2: JWT generation [MEDIUM] (depends: 2.1) ← CURRENT
  - Acceptance: Returns valid JWT with user claims, 15-minute expiry
  - Attempt 1: REJECTED — missing expiration claim
- [ ] Task 2.3: Token validation middleware [MEDIUM]
```

### context.md: What's Been Decided

```markdown
## Technical Decisions
- bcrypt cost factor: 12
- JWT TTL: 15 minutes; refresh TTL: 7 days

## SME Guidance (cached, never re-asked)
### security (Phase 1)
- Never log tokens or passwords
- Rate-limit login: 5 attempts / 15 min per IP

### api (Phase 1)
- Return 401 for invalid credentials (not 404)
```

### Evidence Bundles

Every completed task writes structured evidence to `.swarm/evidence/`:

| Type | What It Captures |
|------|--------------------|
| review | Verdict, risk level, specific issues |
| test | Pass/fail counts, coverage %, failure messages |
| diff | Files changed, additions/deletions |
| retrospective | Phase metrics, lessons learned (injected into next phase) |

</details>

<details>
<summary><strong>Save Plan Tool: Target Workspace Requirement</strong></summary>

The `save_plan` tool requires an explicit target workspace path. It does **not** fall back to `process.cwd()`.

### Explicit Workspace Requirement

- The `working_directory` parameter must be provided
- Providing no value or relying on implicit directory resolution will result in deterministic failure

### Failure Conditions

| Condition | Behavior |
|-----------|----------|
| Missing (`undefined` / `null`) | Fails with: "Target workspace is required" |
| Empty or whitespace-only | Fails with: "Target workspace cannot be empty or whitespace" |
| Path traversal (`..`) | Fails with: "Target workspace cannot contain path traversal" |

### Usage Contract

When using `save_plan`, always pass a valid `working_directory`:

```typescript
save_plan({
  title: "My Project",
  swarm_id: "mega",
  phases: [{ id: 1, name: "Setup", tasks: [{ id: "1.1", description: "Initialize project" }] }],
  working_directory: "/path/to/project"  // Required - no fallback
})
```

</details>

<details>
<summary><strong>Guardrails and Circuit Breakers</strong></summary>

Every agent runs inside a circuit breaker that kills runaway behavior before it burns your credits.

| Signal | Default Limit | What Happens |
|--------|:---:|-------------|
| Tool calls | 200 | Agent is stopped |
| Duration | 30 min | Agent is stopped |
| Same tool repeated | 10x | Agent is warned, then stopped |
| Consecutive errors | 5 | Agent is stopped |

Limits reset per task. A coder working on Task 2.3 is not penalized for tool calls made during Task 2.2.

#### Architect Self-Coding Block

If the architect writes files directly instead of delegating to the coder, a hard block fires:

| Write count | Behavior |
|:-----------:|----------|
| 1–2 | Warning injected into next architect message |
| ≥ 3 | `Error` thrown with `SELF_CODING_BLOCK` — identifies file paths written and count |

The counter resets only when a coder delegation is dispatched. This is a hard enforcement — not advisory.

Per-agent overrides:

```json
{
  "guardrails": {
    "profiles": {
      "coder": { "max_tool_calls": 500, "max_duration_minutes": 60 },
      "explorer": { "max_tool_calls": 50 }
    }
  }
}
```

</details>

<details>
<summary><strong>Context Budget Guard</strong></summary>

The Context Budget Guard monitors how much context Swarm is injecting into the conversation. It helps prevent context overflow before it becomes a problem.

### Default Behavior

- **Enabled automatically** — No setup required. Swarm starts tracking context usage right away.
- **What it measures** — Only the context that Swarm injects (plan, context, evidence, retrospectives). It does **not** count your chat history or the model's responses.
- **Warning threshold (0.7 ratio)** — When swarm-injected context reaches ~2800 tokens (70% of 4000), the architect receives a one-time advisory warning. This is informational — execution continues normally.
- **Critical threshold (0.9 ratio)** — When context reaches ~3600 tokens (90% of 4000), the architect receives a critical alert with a recommendation to run `/swarm handoff`. This is also one-time only.
- **Non-nagging** — Alerts fire once per session, not repeatedly. You won't be pestered every turn.
- **Who sees warnings** — Only the architect receives these warnings. Other agents are unaware of the budget.

To disable entirely, set `context_budget.enabled: false` in your swarm config.

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `context_budget.enabled` | boolean | `true` | Enable or disable the context budget guard entirely |
| `context_budget.max_injection_tokens` | number | `4000` | Token budget for swarm-injected context per turn. This is NOT the model's context window — it's the swarm plugin's own contribution |
| `context_budget.warn_threshold` | number | `0.7` | Ratio (0.0-1.0) of `max_injection_tokens` that triggers a warning advisory |
| `context_budget.critical_threshold` | number | `0.9` | Ratio (0.0-1.0) of `max_injection_tokens` that triggers a critical alert with handoff recommendation |
| `context_budget.enforce` | boolean | `true` | When true, enforces budget limits and may trigger handoffs |
| `context_budget.prune_target` | number | `0.7` | Ratio (0.0-1.0) of context to preserve when pruning occurs |
| `context_budget.preserve_last_n_turns` | number | `4` | Number of recent turns to preserve when pruning |
| `context_budget.recent_window` | number | `10` | Number of turns to consider as "recent" for scoring |
| `context_budget.tracked_agents` | string[] | `['architect']` | Agents to track for context budget warnings |
| `context_budget.enforce_on_agent_switch` | boolean | `true` | Enforce budget limits when switching agents |
| `context_budget.model_limits` | record | `{ default: 128000 }` | Per-model token limits (model name -> max tokens) |
| `context_budget.tool_output_mask_threshold` | number | `2000` | Threshold for masking tool outputs (chars) |
| `context_budget.scoring.enabled` | boolean | `false` | Enable context scoring/ranking |
| `context_budget.scoring.max_candidates` | number | `100` | Maximum items to score (10-500) |
| `context_budget.scoring.weights` | object | `{ recency: 0.3, ... }` | Scoring weights for priority |
| `context_budget.scoring.decision_decay` | object | `{ mode: 'exponential', half_life_hours: 24 }` | Decision relevance decay |
| `context_budget.scoring.token_ratios` | object | `{ prose: 0.25, code: 0.4, ... }` | Token cost multipliers |

### Example Configurations

**Minimal (disable):**
```json
{
  "context_budget": {
    "enabled": false
  }
}
```

**Default (reference):**
```json
{
  "context_budget": {
    "enabled": true,
    "max_injection_tokens": 4000,
    "warn_threshold": 0.7,
    "critical_threshold": 0.9,
    "enforce": true,
    "prune_target": 0.7,
    "preserve_last_n_turns": 4,
    "recent_window": 10,
    "tracked_agents": ["architect"],
    "enforce_on_agent_switch": true,
    "model_limits": { "default": 128000 },
    "tool_output_mask_threshold": 2000,
    "scoring": {
      "enabled": false,
      "max_candidates": 100,
      "weights": { "recency": 0.3, "relevance": 0.4, "importance": 0.3 },
      "decision_decay": { "mode": "exponential", "half_life_hours": 24 },
      "token_ratios": { "prose": 0.25, "code": 0.4, "json": 0.6, "logs": 0.1 }
    }
  }
}
```

**Aggressive (for long-running sessions):**
```json
{
  "context_budget": {
    "enabled": true,
    "max_injection_tokens": 2000,
    "warn_threshold": 0.5,
    "critical_threshold": 0.75,
    "enforce": true,
    "prune_target": 0.6,
    "preserve_last_n_turns": 2,
    "recent_window": 5,
    "tracked_agents": ["architect"],
    "enforce_on_agent_switch": true,
    "model_limits": { "default": 128000 },
    "tool_output_mask_threshold": 1500,
    "scoring": {
      "enabled": true,
      "max_candidates": 50,
      "weights": { "recency": 0.5, "relevance": 0.3, "importance": 0.2 },
      "decision_decay": { "mode": "linear", "half_life_hours": 12 },
      "token_ratios": { "prose": 0.2, "code": 0.35, "json": 0.5, "logs": 0.05 }
    }
  }
}
```

### What This Does NOT Do

- **Does NOT prune chat history** — Your conversation with the model is untouched
- **Does NOT modify tool outputs** — What tools return is unchanged
- **Does NOT block execution** — The guard is advisory only; it warns but never stops the pipeline
- **Does NOT interact with compaction.auto** — Separate feature with separate configuration
- **Only measures swarm's injected context** — Not the full context window, just what Swarm adds

</details>

<details>
<summary><strong>Quality Gates (Technical Detail)</strong></summary>

### Built-in Tools

| Tool | What It Does |
|------|-------------|
| syntax_check | Tree-sitter validation across 11 languages |
| placeholder_scan | Catches TODOs, FIXMEs, stubs, placeholder text |
| sast_scan | Offline security analysis, 63+ rules, 9 languages |
| sbom_generate | CycloneDX dependency tracking, 8 ecosystems |
| build_check | Runs your project's native build/typecheck |
| quality_budget | Enforces complexity, duplication, and test ratio limits |
| pre_check_batch | Runs lint, secretscan, SAST, and quality budget in parallel (~15s vs ~60s sequential) |
| phase_complete | Enforces phase completion, verifies required agents, requires a valid retrospective evidence bundle, logs events, and resets state |


All tools run locally. No Docker, no network calls, no external APIs.

Optional enhancement: Semgrep (if on PATH).

### Gate Configuration

```json
{
  "gates": {
    "syntax_check": { "enabled": true },
    "placeholder_scan": { "enabled": true },
    "sast_scan": { "enabled": true },
    "quality_budget": {
      "enabled": true,
      "max_complexity_delta": 5,
      "min_test_to_code_ratio": 0.3
    }
  }
}
```

</details>

<details>
<summary><strong>Full Configuration Reference</strong></summary>

Config file location: `~/.config/opencode/opencode-swarm.json` (global) or `.opencode/opencode-swarm.json` (project). Project config merges over global.

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-opus-4-6" },
    "coder": { "model": "minimax-coding-plan/MiniMax-M2.5" },
    "explorer": { "model": "minimax-coding-plan/MiniMax-M2.1" },
    "sme": { "model": "kimi-for-coding/k2p5" },
    "critic": { "model": "zai-coding-plan/glm-5" },
    "reviewer": { "model": "zai-coding-plan/glm-5" },
    "test_engineer": { "model": "minimax-coding-plan/MiniMax-M2.5" },
    "docs": { "model": "zai-coding-plan/glm-4.7-flash" },
    "designer": { "model": "kimi-for-coding/k2p5" }
  },
  "guardrails": {
    "max_tool_calls": 200,
    "max_duration_minutes": 30,
    "profiles": {
      "coder": { "max_tool_calls": 500 }
    }
  },
  "review_passes": {
    "always_security_review": false,
    "security_globs": ["**/*auth*", "**/*crypto*", "**/*session*"]
  },
  "automation": {
    "mode": "manual",
    "capabilities": {
      "plan_sync": true,
      "phase_preflight": false,
      "config_doctor_on_startup": false,
      "config_doctor_autofix": false,
      "evidence_auto_summaries": true,
      "decision_drift_detection": true
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
}
```

### Automation

## Mode Detection (v6.13)

Swarm now explicitly distinguishes five architect modes:

- **`DISCOVER`** — After the explorer finishes scanning the codebase.
- **`PLAN`** — When the architect writes or updates the plan.
- **`EXECUTE`** — During task implementation (the normal pipeline).
- **`PHASE-WRAP`** — After all tasks in a phase are completed, before docs are updated.
- **`UNKNOWN`** — Fallback when the current state does not match any known mode.

Each mode determines which injection blocks are added to the LLM prompt (e.g., plan cursor is injected in `PLAN`, tool output truncation in `EXECUTE`, etc.).

Default mode: `manual`. No background automation — all actions require explicit slash commands.

Modes:

- `manual` — No background automation. All actions via slash commands (default).
- `hybrid` — Background automation for safe operations, manual for sensitive ones.
- `auto` — Full background automation.

Capability defaults:

- `plan_sync`: `true` — Background plan synchronization using `fs.watch` with debounced writes (300ms) and 2-second polling fallback
- `phase_preflight`: `false` — Phase preflight checks before agent execution (opt-in)
- `config_doctor_on_startup`: `false` — Validate configuration on startup
- `config_doctor_autofix`: `false` — Auto-fix for config doctor (opt-in, security-sensitive)
- `evidence_auto_summaries`: `true` — Automatic summaries for evidence bundles
- `decision_drift_detection`: `true` — Detect drift between planned and actual decisions

## Plan Cursor (v6.13)

The `plan_cursor` config compresses the plan that is injected into the LLM context.

```json
{
  "plan_cursor": {
    "enabled": true,
    "max_tokens": 1500,
    "lookahead_tasks": 2
  }
}
```

- **enabled** – When `true` (default) Swarm injects a compact plan cursor instead of the full `plan.md`.
- **max_tokens** – Upper bound on the number of tokens emitted for the cursor (default 1500). The cursor contains the current phase summary, the full current task, and up to `lookahead_tasks` upcoming tasks. Earlier phases are reduced to one‑line summaries.
- **lookahead_tasks** – Number of future tasks to include in full detail (default 2). Set to `0` to show only the current task.

Disabling (`"enabled": false`) falls back to the pre‑v6.13 behavior of injecting the entire plan text.

## Tool Output Truncation (v6.13)

Control the size of tool outputs that are sent back to the LLM.

```json
{
  "tool_output": {
    "truncation_enabled": true,
    "max_lines": 150,
    "per_tool": {
      "diff": 200,
      "symbols": 100
    }
  }
}
```

- **truncation_enabled** – Global switch (default true).
- **max_lines** – Default line limit for any tool output.
- **per_tool** – Overrides `max_lines` for specific tools. The `diff` and `symbols` tools are truncated by default because their outputs can be very large.

When truncation is active, a footer is appended:

```
---
[output truncated to {maxLines} lines – use `tool_output.per_tool.<tool>` to adjust]
```

## Summarization Settings

Control how tool outputs are summarized for LLM context.

```json
{
  "summaries": {
    "threshold_bytes": 102400,
    "exempt_tools": ["retrieve_summary", "task", "read"]
  }
}
```

- **threshold_bytes** – Output size threshold in bytes before summarization is triggered (default 102400 = 100KB).
- **exempt_tools** – Tools whose outputs are never summarized. Defaults to `["retrieve_summary", "task", "read"]` to prevent re-summarization loops.

> **Note:** The `retrieve_summary` tool supports paginated retrieval via `offset` and `limit` parameters to fetch large summarized outputs in chunks.

---

### Disabling Agents

```json
{
  "sme": { "disabled": true },
  "designer": { "disabled": true },
  "test_engineer": { "disabled": true }
}
```

</details>

<details>
<summary><strong>All Slash Commands</strong></summary>

| Command | Description |
|---------|-------------|
| `/swarm status` | Current phase, task progress, agent count |
| `/swarm plan [N]` | Full plan or filtered by phase |
| `/swarm agents` | Registered agents with models and permissions |
| `/swarm history` | Completed phases with status |
| `/swarm config` | Current resolved configuration |
| `/swarm diagnose` | Health check for `.swarm/` files and config |
| `/swarm export` | Export plan and context as portable JSON |
| `/swarm evidence [task]` | Evidence bundles for a task or all tasks |
| `/swarm archive [--dry-run]` | Archive old evidence with retention policy |
| `/swarm benchmark` | Performance benchmarks |
| `/swarm retrieve [id]` | Retrieve auto-summarized tool outputs (supports offset/limit pagination) |
| `/swarm reset --confirm` | Clear swarm state files |
| `/swarm preflight` | Run phase preflight checks |
| `/swarm config doctor [--fix]` | Config validation with optional auto-fix |
| `/swarm sync-plan` | Force plan.md regeneration from plan.json |
| `/swarm specify [description]` | Generate or import a feature specification |
| `/swarm clarify [topic]` | Clarify and refine an existing feature specification |
| `/swarm analyze` | Analyze spec.md vs plan.md for requirement coverage gaps |

</details>

---

## Role-Scoped Tool Filtering

Swarm limits which tools each agent can access based on their role. This prevents agents from using tools that aren't appropriate for their responsibilities, reducing errors and keeping agents focused.

### Default Tool Allocations

| Agent | Tools | Count | Rationale |
|-------|-------|:---:|-----------|
| **architect** | All 21 tools | 21 | Orchestrator needs full visibility |
| **reviewer** | diff, imports, lint, pkg_audit, pre_check_batch, secretscan, symbols, complexity_hotspots, retrieve_summary, extract_code_blocks, test_runner | 11 | Security-focused QA |
| **coder** | diff, imports, lint, symbols, extract_code_blocks, retrieve_summary | 6 | Write-focused, minimal read tools |
| **test_engineer** | test_runner, diff, symbols, extract_code_blocks, retrieve_summary, imports, complexity_hotspots, pkg_audit | 8 | Testing and verification |
| **explorer** | complexity_hotspots, detect_domains, extract_code_blocks, gitingest, imports, retrieve_summary, schema_drift, symbols, todo_extract | 9 | Discovery and analysis |
| **sme** | complexity_hotspots, detect_domains, extract_code_blocks, imports, retrieve_summary, schema_drift, symbols | 7 | Domain expertise research |
| **critic** | complexity_hotspots, detect_domains, imports, retrieve_summary, symbols | 5 | Plan review, minimal toolset |
| **docs** | detect_domains, extract_code_blocks, gitingest, imports, retrieve_summary, schema_drift, symbols, todo_extract | 8 | Documentation synthesis |
| **designer** | extract_code_blocks, retrieve_summary, symbols | 3 | UI-focused, minimal toolset |

### Configuration

Tool filtering is enabled by default. Customize it in your config:

```json
{
  "tool_filter": {
    "enabled": true,
    "overrides": {
      "coder": ["diff", "imports", "lint", "symbols", "test_runner"],
      "reviewer": ["diff", "secretscan", "sast_scan", "symbols"]
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable tool filtering globally |
| `overrides` | Record<string, string[]> | `{}` | Per-agent tool whitelist. Empty array denies all tools. |

### Troubleshooting: Agent Missing a Tool

If an agent reports it doesn't have access to a tool it needs:

1. Check if the tool is in the agent's default allocation (see table above)
2. Add a custom override in your config:

```json
{
  "tool_filter": {
    "overrides": {
      "coder": ["diff", "imports", "lint", "symbols", "extract_code_blocks", "retrieve_summary", "test_runner"]
    }
  }
}
```

3. To completely disable filtering for all agents:

```json
{
  "tool_filter": {
    "enabled": false
  }
}
```

### Available Tools Reference

The following tools can be assigned to agents via overrides:

| Tool | Purpose |
|------|---------|
| `checkpoint` | Save/restore git checkpoints |
| `check_gate_status` | Read-only query of task gate status |
| `complexity_hotspots` | Identify high-risk code areas |
| `detect_domains` | Detect SME domains from text |
| `diff` | Analyze git diffs and changes |
| `evidence_check` | Verify task evidence |
| `extract_code_blocks` | Extract code from markdown |
| `gitingest` | Ingest external repositories |
| `imports` | Analyze import relationships |
| `lint` | Run project linters |
| `pkg_audit` | Security audit of dependencies |
| `pre_check_batch` | Parallel pre-checks (lint, secrets, SAST, quality) |
| `retrieve_summary` | Retrieve summarized tool outputs |
| `schema_drift` | Detect OpenAPI/schema drift |
| `secretscan` | Scan for secrets in code |
| `symbols` | Extract exported symbols |
| `test_runner` | Run project tests |
| `update_task_status` | Mark plan tasks as pending/in_progress/completed/blocked; track phase progress |
| `todo_extract` | Extract TODO/FIXME comments |
| `write_retro` | Document phase retrospectives via the phase_complete workflow; capture lessons learned |
| `phase_complete` | Enforces phase completion, verifies required agents, logs events, resets state |
| `declare_scope` | Pre-declare the file scope for the next coder delegation (architect-only); violations trigger warnings |

---

## Recent Changes

### v6.22 — Curator Background Analysis + Session State Persistence

This release adds the optional Curator system for phase-level intelligence and fixes session snapshot persistence for task workflow states.

- **Curator system**: New optional background analysis system (`curator.enabled = false` by default). After each phase, collects events, checks compliance, and writes drift reports to `.swarm/drift-report-phase-N.json`. Three integration points: init on first phase, phase analysis after each phase, and drift injection into architect context at phase start.
- **Drift reports**: `runCriticDriftCheck` compares planned vs. actual decisions and writes structured drift reports with alignment scores (`ALIGNED` / `MINOR_DRIFT` / `MAJOR_DRIFT` / `OFF_SPEC`). Latest drift summary is prepended to the architect's knowledge context each phase.
- **Issue #81 fix — taskWorkflowStates persistence**: Session snapshots now correctly serialize and restore the per-task state machine. Invalid state values are filtered to `idle` on deserialization. `reconcileTaskStatesFromPlan` seeds task states from `plan.json` on snapshot load (completed → `tests_run`, in-progress → `coder_delegated`).

See the [Curator section](#curator) above for configuration details and the [v6.22 release notes](docs/releases/v6.22.0.md) for the full change list.

### v6.21 — Gate Enforcement Hardening

This release replaces soft advisory warnings with hard runtime blocks and adds structural compliance tooling for all model tiers.

#### Phase 1 — P0 Bug Fixes: Hard Blocks Replace Soft Warnings

- **`qaSkipCount` reset fixed**: The skip-detection counter in `delegation-gate.ts` now resets only when **both** reviewer **and** test_engineer have been seen since the last coder entry — not when either one runs alone.
- **`update_task_status` reviewer gate check**: Accepting `status='completed'` now validates that the reviewer gate is present in the session's `gateLog` for the given task. Missing reviewer returns a structured error naming the absent gate.
- **Architect self-coding hard block**: `architectWriteCount ≥ 3` now throws an `Error` with message `SELF_CODING_BLOCK` (previously a warning only). Counts 1–2 remain advisory warnings. Counter resets on coder delegation.

#### Phase 2 — Per-Task State Machine

Every task now has a tracked workflow state in the session:

| State | Meaning |
|-------|---------|
| `idle` | Task not started |
| `coder_delegated` | Coder has received the delegation |
| `pre_check_passed` | Automated gates (lint, SAST, secrets, quality) passed |
| `reviewer_run` | Reviewer agent has returned a verdict |
| `tests_run` | Test engineer has completed (verification + adversarial) |
| `complete` | `update_task_status` accepted the `completed` transition |

Transitions are forward-only. `advanceTaskState()` throws `INVALID_TASK_STATE_TRANSITION` if an illegal jump is attempted. `getTaskState()` returns `'idle'` for unknown tasks.

`session.lastGateOutcome` records the most recent gate result: `{ gate, taskId, passed, timestamp }`.

#### Phase 3 — State Machine Integration

- `update_task_status` now uses the state machine (not a raw `gateLog.has()` check): `status='completed'` is rejected unless the task is in `'tests_run'` or `'complete'` state.
- `delegation-gate.ts` protocol-violation check additionally verifies that the prior task's state has advanced past `'coder_delegated'` before allowing a new coder delegation.

#### Phase 4 — Context Engineering

- **Progressive task disclosure**: When >5 tasks are visible in the last user message, `delegation-gate.ts` trims to the current task ± a context window. A `[Task window: showing N of M tasks]` comment marks the trim point.
- **Deliberation preamble**: Each architect turn is prefixed with `[Last gate: {tool} {result} for task {taskId}]` sourced from `session.lastGateOutcome`, prompting the architect to identify the single next step.
- **Low-capability model detection**: `LOW_CAPABILITY_MODELS` constant (matches substrings `mini`, `nano`, `small`, `free`) and `isLowCapabilityModel(modelId)` helper added to `constants.ts`.
- **Behavioral guidance markers**: Three `<!-- BEHAVIORAL_GUIDANCE_START --> … <!-- BEHAVIORAL_GUIDANCE_END -->` pairs wrap the BATCHING DETECTION, ARCHITECT CODING BOUNDARIES, and QA gate behavioral sections in the architect prompt.
- **Tier-based prompt trimming**: When `session.activeModel` matches `isLowCapabilityModel()`, the behavioral guidance blocks are stripped from the architect prompt and replaced with `[Enforcement: programmatic gates active]`. Programmatic enforcement substitutes for verbose prompt instructions on smaller models.

#### Phase 5 — Structural Scope Declaration (`declare_scope`)

New architect-only tool and supporting runtime enforcement:

- **`declare_scope` tool**: Pre-declares which files the coder is allowed to modify for a given task. Input: `{ taskId, files, whitelist?, working_directory? }`. Validates task ID format, plan membership, and non-`complete` state. On success, sets `session.declaredCoderScope`. Architect-only.
- **Automatic scope from FILE: directives**: When a coder delegation is detected, `delegation-gate.ts` extracts FILE: directive values and stores them as `session.declaredCoderScope` automatically — no explicit `declare_scope` call required.
- **Scope containment tracking**: `guardrails.ts` appends every file the architect writes to `session.modifiedFilesThisCoderTask`. On coder delegation start, the list resets to `[]`.
- **Violation detection**: After a coder task completes, `toolAfter` compares `modifiedFilesThisCoderTask` against `declaredCoderScope`. If >2 files are outside the declared scope, `session.lastScopeViolation` is set. The next architect message receives a scope violation warning.
- **`isInDeclaredScope(filePath, scopeEntries)`**: Module-level helper using `path.resolve()` + `path.relative()` for proper directory containment (not string matching).

### v6.13.2 — Pipeline Enforcement

This release adds enforcement-layer tooling and self-healing guardrails:

- **`phase_complete` tool**: Verifies all required agents were dispatched before a phase closes; emits events to `.swarm/events.jsonl`; configurable `enforce`/`warn` policy
- **Summarization loop fix**: `exempt_tools` config prevents `retrieve_summary` and `task` outputs from being re-summarized (fixes Issue #8)
- **Same-model adversarial detection**: Warns when coder and reviewer share the same model; `warn`/`gate`/`ignore` policy
- **Architect test guardrail (HF-1b)**: Prevents architect from running full `bun test` suite — must target specific files one at a time
- **Docs**: `docs/swarm-briefing.md` (LLM pipeline briefing), Task Field Reference in `docs/planning.md`

### v6.13.1 — Consolidation & Defaults Fix

- **`consolidateSystemMessages`**: Merges multiple system messages into one at index 0
- **Test isolation helpers**: `createIsolatedTestEnv` and `assertSafeForWrite`
- **Coder self-verify guardrail (HF-1)**: Coder and test_engineer agents blocked from running build/test/lint
- **`/swarm` template fix**: `{{arguments}}` → `$ARGUMENTS`
- **DEFAULT_MODELS update**: `claude-sonnet-4-5` → `claude-sonnet-4-20250514`, `gemini-2.0-flash` → `gemini-2.5-flash`

### v6.13.0 — Context Efficiency

This release focuses on reducing context usage and improving mode-conditional behavior:

- **Role-Scoped Tool Filtering**: Agent tools filtered via AGENT_TOOL_MAP
- **Plan Cursor**: Compressed plan summary under 1,500 tokens
- **Mode Detection**: DISCOVER/PLAN/EXECUTE/PHASE-WRAP/UNKNOWN modes
- **Tool Output Truncation**: diff/symbols outputs truncated with footer
- **ZodError Fixes**: Optional current_phase, 'completed' status support

### v6.12.0 — Anti-Process-Violation Hardening

This release adds runtime detection hooks to catch and warn about architect workflow violations:

- **Self-coding detection**: Warns when the architect writes code directly instead of delegating
- **Partial gate tracking**: Detects when QA gates are skipped
- **Self-fix detection**: Warns when an agent fixes its own gate failure (should delegate to fresh agent)
- **Batch detection**: Catches "implement X and add Y" batching in task requests
- **Zero-delegation detection**: Warns when tasks complete without any coder delegation; supports parsing delegation envelopes from JSON or KEY: VALUE text format for validation.

These hooks are advisory (warnings only) and help maintain workflow discipline during long sessions.

---

## v6.19 Features

### Critic Sounding Board
Before escalating to the user, the Architect consults the critic in SOUNDING_BOARD mode. The critic returns one of four verdicts: UNNECESSARY, REPHRASE, APPROVED, or RESOLVE.

### Escalation Discipline
Three-tier escalation hierarchy ensures systematic problem resolution:
1. **Tier 1**: Self-resolve using existing context
2. **Tier 2**: Critic consultation via sounding board
3. **Tier 3**: User escalation (requires critic APPROVED)

### Retry Circuit Breaker
After 3 coder rejections, the Architect intervenes to simplify the approach rather than adding more logic.

### Intent Reconstruction
The mega-reviewer reconstructs developer intent from task specs and diffs before evaluating changes.

### Complexity-Scaled Review
Changes classified as TRIVIAL, MODERATE, or COMPLEX receive appropriate review depth:
- TRIVIAL → Tier 1 only
- MODERATE → Tiers 1-2
- COMPLEX → All three tiers

### meta.summary Convention
Agents include one-line summaries in state events for downstream consumption by other agents.

---

## Claude Code Adapter

OpenCode Swarm includes a **Claude Code adapter** (`@opencode-swarm/claude-code`) that brings the full architect-centric swarm orchestration system to Claude Code. This adapter provides:

- **9 specialized swarm agents** for Claude Code's Task tool
- **7 lifecycle hooks** that integrate with Claude Code's subprocess hook system
- **Disk-based state bridge** for swarm state persistence across hook invocations
- **Telemetry** via session-scoped events files

### Installation

```bash
npm install -g @opencode-swarm/claude-code
```

Then add to your Claude Code `settings.json`:

```json
{
  "plugins": [
    "/path/to/node_modules/@opencode-swarm/claude-code"
  ]
}
```

### Usage

Once installed, use swarm agents via the Task tool:

```
Use swarm-architect to plan and orchestrate the implementation of [feature].
```

The architect will:
1. Analyze the codebase with swarm-explorer
2. Create a plan in `.swarm/plan.md`
3. Delegate implementation to swarm-coder
4. Run QA gates (swarm-reviewer + swarm-test-engineer)
5. Mark tasks complete

### Available Agents

| Agent | Role |
|------|------|
| swarm-architect | Orchestrator — plans, delegates, runs gates |
| swarm-coder | Implementation — writes code |
| swarm-reviewer | Code review — APPROVED/REJECTED |
| swarm-test-engineer | Test generation + execution |
| swarm-critic | Plan review — APPROVED/NEEDS_REVISION |
| swarm-explorer | Codebase analysis |
| swarm-sme | Domain expertise |
| swarm-docs | Documentation updates |
| swarm-designer | UI/UX scaffolding |

### Lifecycle Hooks

The adapter integrates with Claude Code's 7 lifecycle hooks:

| Hook | Purpose |
|------|---------|
| SessionStart | Initialize swarm state, inject context |
| PreToolUse | Track tool invocations, emit telemetry |
| PostToolUse | Track file modifications |
| UserPromptSubmit | Inject current task context |
| Stop | Emit session-end telemetry |
| SubagentStop | Track delegation completion |
| PreCompact | Log compaction events |

See [`packages/claude-code/README.md`](packages/claude-code/README.md) for full documentation.

---

## Packages

OpenCode Swarm is organized as a monorepo with the following packages:

| Package | Description |
|---------|-------------|
| `opencode-swarm` | Main OpenCode plugin — orchestration + CLI (deprecated, use @opencode-swarm/core) |
| `@opencode-swarm/core` | Core orchestration, parallel execution planning, dependency graph analysis |
| `@opencode-swarm/telemetry` | Event schemas, type guards, and telemetry infrastructure |
| `@opencode-swarm/claude-code` | Claude Code plugin adapter with lifecycle hooks |

> **Note**: The `opencode-swarm` package is deprecated. New installations should use `@opencode-swarm/core` instead.

### Parallel Execution Planning (v7.0)

The `@opencode-swarm/core` package includes the `ExecutionCoordinator` for wave-based parallel task execution:

- **`ExecutionPlan`**: Groups tasks into dependency-ordered waves for parallel execution
- **Serial fallbacks**: Tasks involved in circular dependencies are automatically identified and scheduled serially
- **Conflict detection**: Tracks file modifications across agents for merge conflict resolution

This is a planning scaffold — full parallel dispatch and result merging is targeted for v7.3.

### Telemetry Events (v7.0)

The `@opencode-swarm/telemetry` package provides structured event schemas:

| Event | Description |
|-------|-------------|
| `session_metadata` | Session initialization |
| `delegation_start` / `delegation_end` | Subagent delegation tracking |
| `agent_status` | Agent activity monitoring |
| `token_usage` | LLM token consumption |
| `tool_invocation` | Tool call tracking |
| `gate_evaluation` | QA gate results |
| `file_reservation` | File scope locking |
| `phase_transition` | Phase start/complete |
| `file_touch` | File modifications |
| `state_file_update` | Swarm state writes |
| `parallel_wave_start` / `parallel_wave_end` | Parallel execution wave events |

---

## Testing

6,000+ tests. Unit, integration, adversarial, and smoke. Zero additional test dependencies.

```bash
bun test
```

---

## Design Principles

1. **Plan before code.** The critic approves the plan before a single line is written.
2. **One task at a time.** The coder gets one task and full context. Nothing else.
3. **Review everything immediately.** Correctness, security, tests, adversarial tests. Every task.
4. **Different models catch different bugs.** The coder's blind spot is the reviewer's strength.
5. **Save everything to disk.** Any session, any model, any day, pick up where you left off.
6. **Document failures.** Rejections and retries are recorded. After 5 failures, it escalates to you.

---

## Supported Languages

OpenCode Swarm v6.16+ ships with language profiles for 11 languages across three quality tiers. All tools use graceful degradation — if a binary is not on PATH, the tool skips with a soft warning rather than a hard failure.

| Language | Tier | Syntax | Build | Test | Lint | Audit | SAST |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| TypeScript / JavaScript | 1 | ✅ | ✅ | ✅ | ✅ Biome / ESLint | ✅ npm audit | ✅ Semgrep |
| Python | 1 | ✅ | ✅ | ✅ pytest | ✅ ruff | ✅ pip-audit | ✅ Semgrep |
| Rust | 1 | ✅ | ✅ | ✅ cargo test | ✅ clippy | ✅ cargo audit | ✅ Semgrep |
| Go | 1 | ✅ | ✅ | ✅ go test | ✅ golangci-lint | ✅ govulncheck | ✅ Semgrep |
| Java | 2 | ✅ | ✅ Gradle / Maven | ✅ JUnit | ✅ Checkstyle | — | ✅ Semgrep |
| Kotlin | 2 | ✅ | ✅ Gradle | ✅ JUnit | ✅ ktlint | — | 🔶 Semgrep beta |
| C# / .NET | 2 | ✅ | ✅ dotnet build | ✅ dotnet test | ✅ dotnet format | ✅ dotnet list | ✅ Semgrep |
| C / C++ | 2 | ✅ | ✅ cmake / make | ✅ ctest | ✅ cppcheck | — | 🔶 Semgrep exp. |
| Swift | 2 | ✅ | ✅ swift build | ✅ swift test | ✅ swiftlint | — | 🔶 Semgrep exp. |
| Dart / Flutter | 3 | ✅ | ✅ dart pub | ✅ dart test | ✅ dart analyze | ✅ dart pub outdated | — |
| Ruby | 3 | ✅ | — | ✅ RSpec / minitest | ✅ RuboCop | ✅ bundle-audit | 🔶 Semgrep exp. |

**Tier definitions:**
- **Tier 1** — Full pipeline: all tools integrated and tested end-to-end.
- **Tier 2** — Strong coverage: most tools integrated; some optional (audit, SAST).
- **Tier 3** — Basic coverage: core tools integrated; advanced tooling limited.

> All binaries are optional. Missing tools produce a soft warning and skip — the pipeline never hard-fails on a missing linter or auditor.

---

## Curator

The Curator is an optional background analysis system that runs after each phase. It is **disabled by default** (`curator.enabled = false`) and never blocks execution — all Curator operations are wrapped in try/catch.

### What the Curator Does

- **Init** (`phase-monitor.ts`): On the first phase, initializes a curator summary file at `.swarm/curator-summary.json`.
- **Phase analysis** (`phase-complete.ts`): After each phase completes, collects phase events, checks compliance, and optionally invokes the curator explorer to summarize findings.
- **Knowledge updates** (`phase-complete.ts`): Merges curator findings into the knowledge base up to the configured `max_summary_tokens` cap.
- **Drift injection** (`knowledge-injector.ts`): Prepends the latest drift report summary to the architect's knowledge context at phase start, up to `drift_inject_max_chars` characters.

### Configuration

Add a `curator` block to `.opencode/opencode-swarm.json`:

```json
{
  "curator": {
    "enabled": false,
    "init_enabled": true,
    "phase_enabled": true,
    "max_summary_tokens": 2000,
    "min_knowledge_confidence": 0.7,
    "compliance_report": true,
    "suppress_warnings": true,
    "drift_inject_max_chars": 500
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch. Set to `true` to activate the Curator pipeline. |
| `init_enabled` | `true` | Initialize curator summary on first phase (requires `enabled: true`). |
| `phase_enabled` | `true` | Run phase analysis and knowledge updates after each phase. |
| `max_summary_tokens` | `2000` | Maximum token budget for curator knowledge summaries. |
| `min_knowledge_confidence` | `0.7` | Minimum confidence threshold for curator knowledge entries. |
| `compliance_report` | `true` | Include phase compliance check results in curator summary. |
| `suppress_warnings` | `true` | Suppress non-critical curator warnings from the architect context. |
| `drift_inject_max_chars` | `500` | Maximum characters of drift report text injected into each phase context. |

### Drift Reports

Drift reports are written to `.swarm/drift-report-phase-N.json` after each phase. The `knowledge-injector.ts` hook reads the latest report and prepends a summary to the architect's knowledge context for the next phase, helping the architect stay aware of plan vs. reality divergence.

### Issue #81 Hotfix — taskWorkflowStates Persistence

v6.22 includes a fix for session snapshot persistence of per-task workflow states:

- **`SerializedAgentSession.taskWorkflowStates`**: Task workflow states are now serialized as `Record<string, string>` in session snapshots and deserialized back to a `Map` on load. Invalid state values are filtered out and default to `idle`.
- **`reconcileTaskStatesFromPlan`**: On snapshot load, task states are reconciled against the current plan — tasks marked `completed` in the plan are seeded to `tests_run` state, and `in_progress` tasks are seeded to `coder_delegated` if currently `idle`. This is best-effort and never throws.

See [CHANGELOG.md](CHANGELOG.md) for shipped features.

---

## FAQ

### Do I need to select a Swarm architect?

**Yes.** You must explicitly choose a Swarm architect agent in the OpenCode GUI before starting your session. The architect name shown in OpenCode is config-driven — you can define multiple architects with different model assignments in your configuration.

If you use the default OpenCode `Build` / `Plan` options without selecting a Swarm architect, the plugin is bypassed entirely.

### Why did Swarm start coding immediately on my second run?
Because Swarm resumes from `.swarm/` state when it exists. Check `/swarm status` to see the current mode.

### How do I know which agents and models are active?
Run `/swarm agents` and `/swarm config`.

### How do I start over?
Run `/swarm reset --confirm`.

---

## Documentation

- [Documentation Index](docs/index.md)
- [Getting Started](docs/getting-started.md)
- [Architecture Deep Dive](docs/architecture.md)
- [Design Rationale](docs/design-rationale.md)
- [Installation Guide](docs/installation.md)
- [Linux + Docker Desktop Install Guide](docs/installation-linux-docker.md)
- [LLM Operator Installation Guide](docs/installation-llm-operator.md)
- [Pre-Swarm Planning Guide](docs/planning.md)
- [Swarm Briefing for LLMs](docs/swarm-briefing.md)
- [Configuration](docs/configuration.md)

---

## License

MIT

---

**Stop hoping your agents figure it out. Start shipping code that actually works.**
