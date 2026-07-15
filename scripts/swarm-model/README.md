# Swarm Model Config Tool

Interactive CLI tool for configuring swarm agent LLM models. Reads available providers and models from the OpenCode configuration and lets you swap models and temperatures for any agent.

## Features

- **Reads all available providers** from `~/.config/opencode/opencode.json` (not just the ones currently in use)
- **Two implementations**: Node.js (cross-platform) and PowerShell (Windows)
- **Backup before every change** — creates a `.bak` file, with timestamps if `.bak` already exists
- **Auto-creates config** if `opencode-swarm.json` doesn't exist yet
- **Preserves `fallback_models`** exactly as-is, only modifies `model` and `temperature`
- **Loop mode** — after modifying one agent, choose to modify another or exit
- **Quit option** at every selection step (press the last number in any list)

## Quick Start

### Node.js version (recommended, cross-platform)

```bash
# List all agents
node scripts/swarm-model/src/cli.js list

# Interactive mode
node scripts/swarm-model/src/cli.js

# Specify custom config paths
node scripts/swarm-model/src/cli.js \
  --swarm-config ~/.config/opencode/opencode-swarm.json \
  --opencode-config ~/.config/opencode/opencode.json

# Help
node scripts/swarm-model/src/cli.js help
```

### PowerShell version (Windows only)

```powershell
# List all agents
.\scripts\swarm-model.ps1 list

# Interactive mode
.\scripts\swarm-model.ps1

# Help
.\scripts\swarm-model.ps1 help
```

## Interactive Flow

```
=== Swarm Model Config Tool ===
Detected 6 providers (agnes, geminiproxy, opencode-go, opencode-zen, sensenova, wolfai)

Step 1: Select Agent to Configure
------------------------------------------------------------
  [1] architect | opencode-go/deepseek-v4-pro | temp=0.1
  [2] coder | opencode-go/deepseek-v4-flash | temp=0.2
  ...
  [18] test_engineer | opencode-go/minimax-m2.5 | temp=0.2
  [19] [quit/退出]

Please select (1-19):
```

1. **Select Agent** — pick the agent to configure
2. **Select Provider** — choose from all providers in `opencode.json` (e.g., `wolfai`, `agnes`, `geminiproxy`, etc.)
3. **Select Model** — choose a model under that provider
4. **Set Temperature** — optional, defaults to current value
5. **Confirm** — press Enter (default Y) or type `n` to cancel
6. **Continue or Quit** — modify another agent or exit

## Provider Sources

The tool reads providers from two places:

| Source | Path | Purpose |
|--------|------|---------|
| **OpenCode config** | `~/.config/opencode/opencode.json` | All available providers and models |
| **Swarm config** | `~/.config/opencode/opencode-swarm.json` | Current agent assignments (used for backup) |

Available providers in the current config:

| Provider | Models |
|----------|--------|
| `agnes` | agnes-1.5-flash, agnes-2.0-flash, agnes-image-2.0-flash, agnes-image-2.1-flash, agnes-video-v2.0 |
| `geminiproxy` | gemini-2.0-flash-001, gemini-2.5-flash, gemini-2.5-pro, gemini-3.1-pro-preview, gemini-3.5-flash, gemma-4-31b-it |
| `opencode-go` | hy3-preview, kimi-k2.5, kimi-k2.6, minimax-m2.5, qwen3.7-max |
| `opencode-zen` | deepseek-v4-flash-free, mimo-v2.5-free, nemotron-3-ultra-free, north-mini-code-free |
| `sensenova` | deepseek-v4-flash, glm-5.2, sensenova-6.7-flash-lite, sensenova-u1-fast |
| `wolfai` | claude-opus-4-5-20251101-thinking, claude-sonnet-4-5-20250929, gemini-3-flash-preview, gemini-3-pro-preview, glm-4.7, glm-5, gpt-5.2, gpt-5.2-codex, gpt-5.2-codex-high, gpt-5.3-codex, gpt-5.3-codex-high, grok-code-fast-1, kimi-k2-0905, kimi-k2.5, minimax-m2.1, minimax-m2.5 |

## Backup Behavior

Before every write, the current config is backed up:

```
opencode-swarm.json.bak              # First backup
opencode-swarm.json.20260714170500.bak  # Subsequent backups (timestamped)
```

Timestamps are in `YYYYMMDD-HHMMSS` format. Old backups are never overwritten.

## Temperature Guide

| Range | Behavior | Recommended Agents |
|-------|----------|-------------------|
| 0.0 – 0.3 | Deterministic, consistent | `coder`, `reviewer`, `critic*` |
| 0.3 – 0.7 | Balanced | `sme`, `docs` |
| 0.7 – 2.0 | Creative, varied | `explorer`, `designer` |

## Notes

- **Restart required** after modifying — changes only take effect on the next opencode/swarm session
- **Cross-platform** — the Node.js version works on Windows, macOS, and Linux
- **Windows-only** — the PowerShell version requires Windows PowerShell 5.1+
- **Custom provider/model** — if a provider or model is not in the list, you can type it manually
