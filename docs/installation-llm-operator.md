# OpenCode Swarm LLM Operator Guide

**← Back to [Installation Guide](installation.md)** | This is an executable runbook for LLM agents. For human-friendly installation, see the main guide or [platform-specific guide](installation-linux-docker.md).

---

Use this guide when an LLM installs `opencode-swarm` for a user through OpenCode; each step is meant to be executed directly.

## Goal

Install, configure, and validate `opencode-swarm` with all tools enabled:
- `todo_extract`
- `evidence_check`
- `pkg_audit`
- `complexity_hotspots`
- `schema_drift`

## Operating Rules (for the LLM)

- Do not skip verification steps.
- Do not assume paths; confirm they exist.
- Never overwrite user configs without backup.
- If a command fails, stop and report exact error + next fix.

## Inputs Required

Collect these before starting:

```text
OS mode: linux | windows-native | windows-docker
Project path: <absolute path>
OpenCode config path: <absolute path>
Swarm config path: <absolute path>
```

Expected defaults:
- Linux config path: `~/.config/opencode/opencode-swarm.json`
- Native Windows config path: `C:\Users\<user>\.config\opencode\opencode-swarm.json`
- Docker config path in container: `/root/.config/opencode/opencode-swarm.json`

## Procedure A: Native Linux

### Step A1: Preflight

Run:

```bash
node -v
npm -v
bun -v
opencode --version
```

Success criteria:
- all commands return versions

### Step A2: Install plugin

Run:

```bash
bunx opencode-swarm install
```

Fallback:

```bash
npm i -g opencode-swarm
```

### Step A3: Ensure OpenCode plugin config

Target file: `<project>/opencode.json`

Required content:

```json
{
  "plugin": ["opencode-swarm"]
}
```

If file exists:
- merge this entry (do not delete other plugins)

### Step A4: Write swarm config

Target file: `~/.config/opencode/opencode-swarm.json`

Use the user-approved config. If not provided, use this minimum valid config:

```json
{
  "qa_retry_limit": 5,
  "inject_phase_reminders": true,
  "swarms": {
    "mega": {
      "name": "Mega",
      "agents": {
        "architect": { "model": "opencode/gpt-5-nano" },
        "coder": { "model": "minimax-coding-plan/MiniMax-M2.5" },
        "explorer": { "model": "minimax-coding-plan/MiniMax-M2.1" },
        "sme": { "model": "kimi-for-coding/k2p5" },
        "critic": { "model": "zai-coding-plan/glm-5" },
        "reviewer": { "model": "zai-coding-plan/glm-5" },
        "test_engineer": { "model": "minimax-coding-plan/MiniMax-M2.5" },
        "docs": { "model": "zai-coding-plan/glm-4.7-flash" },
        "designer": { "model": "kimi-for-coding/k2p5" }
      }
    }
  },
  "max_iterations": 5
}
```

### Step A5: Verify plugin load

Start OpenCode in the project and run:

```text
/swarm status
/swarm agents
/swarm config
```

Success criteria:
- swarm commands execute without plugin errors

### Step A6: Verify tools

Ask architect:

```text
@mega_architect run todo_extract and complexity_hotspots and summarize outputs
@mega_architect run evidence_check
@mega_architect run pkg_audit ecosystem:auto
@mega_architect run /swarm status
```

If API routes/spec exist, also run:

```text
@mega_architect run schema_drift spec_file:openapi.yaml
```

Success criteria:
- tool calls are recognized and return JSON output
- Background automation is enabled by default (plan_sync: true, evidence_auto_summaries: true)

## Procedure B: Native Windows (PowerShell)

### Step B1: Preflight

Run in PowerShell:

```powershell
node -v
npm -v
bun -v
opencode --version
```

### Step B2: Install plugin

```powershell
bunx opencode-swarm install
```

Fallback:

```powershell
npm i -g opencode-swarm
```

### Step B3: Ensure project plugin config

Target: `<project>\opencode.json`

```json
{
  "plugin": ["opencode-swarm"]
}
```

### Step B4: Ensure swarm config exists

Target: `C:\Users\<user>\.config\opencode\opencode-swarm.json`

Validate file exists and is valid JSON.

### Step B5: Run OpenCode + validate

Run:

```powershell
opencode
```

Then execute:

```text
/swarm status
/swarm config
@mega_architect run todo_extract
@mega_architect run pkg_audit ecosystem:auto
```

## Procedure C: Windows via Docker Desktop

### Step C1: Launch container

Use host paths supplied by user. Example:

```bash
docker run --rm -it \
  -v "C:/dev/my-project:/workspace" \
  -v "C:/Users/<user>/.config/opencode:/root/.config/opencode" \
  -w /workspace \
  node:20-bullseye bash
```

### Step C2: Install runtime + plugin inside container

```bash
npm i -g bun opencode opencode-swarm
```

### Step C3: Ensure `/workspace/opencode.json`

```json
{
  "plugin": ["opencode-swarm"]
}
```

### Step C4: Verify mounted swarm config

Check file exists:

```bash
ls -la /root/.config/opencode
```

Ensure `/root/.config/opencode/opencode-swarm.json` is present.

### Step C5: Run OpenCode + validate

Start:

```bash
opencode
```

Run:

```text
/swarm status
/swarm config
@mega_architect run todo_extract
```

## LLM Completion Checklist

Return PASS only if all are true:

- [ ] Plugin installed
- [ ] `opencode.json` includes `opencode-swarm`
- [ ] swarm config file exists and parses
- [ ] `/swarm status` works
- [ ] `@mega_architect` is callable
- [ ] Tools callable (`todo_extract`, `evidence_check`, `pkg_audit`, `complexity_hotspots`, `schema_drift` when applicable)
- [ ] Background automation enabled by default (`plan_sync: true`, `evidence_auto_summaries: true`)

## Final Output Template (for the LLM)

Use this response format:

```text
Install status: PASS|FAIL
Environment: linux|windows-native|windows-docker
Plugin: opencode-swarm

Checks:
- Plugin install: PASS|FAIL
- OpenCode plugin registration: PASS|FAIL
- Swarm config presence: PASS|FAIL
- /swarm status: PASS|FAIL
- Tools callable: PASS|FAIL
- Background automation defaults: PASS|FAIL

Notes:
- <key findings>

Next action:
- <single best next step if any failure occurred>
```

## Hand-off Prompt You Can Give an LLM

```text
Install and validate opencode-swarm for this project by strictly following docs/installation-llm-operator.md. Do not skip verification. Report PASS/FAIL using the template in that file.
```
