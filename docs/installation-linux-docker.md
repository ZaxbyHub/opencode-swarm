# OpenCode Swarm Installation (Linux, Native Windows, and Docker Desktop)

**← Back to [Installation Guide](installation.md)** | For comprehensive config reference and troubleshooting, see the main installation guide.

---

Full install steps for `opencode-swarm` on:
- Native Linux
- Native Windows (PowerShell)
- Windows via Docker Desktop (Linux container)

## Prerequisites

- OpenCode CLI installed and working
- Node.js 20+ and npm
- Bun (recommended for build/test workflows)
- For Docker path: Docker Desktop with Linux containers enabled

## 1) Native Linux Install

### 1.1 Install plugin package

Use one of these:

```bash
# Option A: Install plugin via OpenCode helper
bunx opencode-swarm install

# Option B: Install package globally
npm i -g opencode-swarm
```

### 1.2 Enable plugin in OpenCode

Create or update your OpenCode config (project-level or user-level):

```json
{
  "plugin": ["opencode-swarm"]
}
```

### 1.3 Create swarm config

Create `~/.config/opencode/opencode-swarm.json`:

```json
{
  "qa_retry_limit": 5,
  "inject_phase_reminders": true,
  "guardrails": {
    "enabled": true,
    "max_tool_calls": 400,
    "max_duration_minutes": 60,
    "profiles": {
      "architect": {
        "max_duration_minutes": 0,
        "max_tool_calls": 0,
        "max_consecutive_errors": 10
      }
    }
  },
  "docs": {
    "enabled": true,
    "doc_patterns": [
      "README.md",
      "CONTRIBUTING.md",
      "docs/**/*.md",
      "docs/**/*.rst",
      "**/CHANGELOG.md"
    ]
  },
  "ui_review": {
    "enabled": true,
    "trigger_paths": [
      "**/pages/**",
      "**/components/**",
      "**/views/**",
      "**/screens/**",
      "**/ui/**",
      "**/layouts/**"
    ],
    "trigger_keywords": [
      "new page",
      "new screen",
      "new component",
      "redesign",
      "layout change",
      "form",
      "modal",
      "dialog",
      "dropdown",
      "sidebar",
      "navbar",
      "dashboard",
      "landing page",
      "signup",
      "login form",
      "settings page",
      "profile page"
    ]
  },
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

### 1.4 Run OpenCode

```bash
opencode
```

### 1.5 Verify plugin and tools

Inside OpenCode:

```text
/swarm status
/swarm agents
/swarm config
```

Then ask architect to use the analysis tools:

```text
@mega_architect run todo_extract and complexity_hotspots for this repo
@mega_architect run evidence_check
```

You should see the tool calls for:
- `todo_extract`
- `evidence_check`
- `pkg_audit`
- `complexity_hotspots`
- `schema_drift`

## 2) Native Windows Install (PowerShell)

### 2.1 Install plugin package

Use one of these in PowerShell:

```powershell
# Option A: Install plugin via OpenCode helper
bunx opencode-swarm install

# Option B: Install package globally
npm i -g opencode-swarm
```

### 2.2 Enable plugin in OpenCode

Create or update `opencode.json` in the target project:

```json
{
  "plugin": ["opencode-swarm"]
}
```

### 2.3 Create swarm config

Create `C:\Users\<you>\.config\opencode\opencode-swarm.json` and add your swarm configuration (same schema as Linux).

### 2.4 Run OpenCode

```powershell
opencode
```

### 2.5 Verify plugin and tools

```text
/swarm status
/swarm agents
/swarm config
@mega_architect run todo_extract and complexity_hotspots for this repo
```

## 3) Windows via Docker Desktop (Linux Container)

This runs OpenCode + plugin inside a Linux container, while your repo stays on Windows.

### 3.1 Prepare folders on Windows

- Project repo (example): `C:\dev\my-project`
- Swarm/OpenCode config folder: `C:\Users\<you>\.config\opencode`

Ensure `opencode-swarm.json` exists in that config folder.

### 3.2 Run container

```bash
docker run --rm -it \
  -v "C:/dev/my-project:/workspace" \
  -v "C:/Users/<you>/.config/opencode:/root/.config/opencode" \
  -w /workspace \
  node:20-bullseye bash
```

Inside the container:

```bash
npm i -g bun opencode opencode-swarm
```

### 3.3 Enable plugin in project config

Create `/workspace/opencode.json`:

```json
{
  "plugin": ["opencode-swarm"]
}
```

### 3.4 Run OpenCode in container

```bash
opencode
```

### 3.5 Verify in container

Run these in OpenCode:

```text
/swarm status
/swarm config
@mega_architect run pkg_audit ecosystem:auto and summarize results
```

## 4) Optional Dockerfile (repeatable local image)

```dockerfile
FROM node:20-bullseye

RUN npm i -g bun opencode opencode-swarm

WORKDIR /workspace
CMD ["bash"]
```

Build and run:

```bash
docker build -t opencode-swarm-local .

docker run --rm -it \
  -v "C:/dev/my-project:/workspace" \
  -v "C:/Users/<you>/.config/opencode:/root/.config/opencode" \
  -w /workspace \
  opencode-swarm-local
```

## 5) Troubleshooting

- `plugin not found`: confirm `opencode.json` has `"opencode-swarm"`
- wrong swarm names: verify `swarms.mega` exists and use `@mega_*` agents
- tools missing: run `/swarm config` and confirm plugin loaded
- no API access: ensure model/provider credentials are available in container env
- Windows mount errors: use forward slashes in Docker volume paths
- PowerShell policy errors: run shell as user with npm global install permissions

## 6) Quick smoke test

Run this sequence in OpenCode:

```text
/swarm status
@mega_architect run todo_extract
@mega_architect run complexity_hotspots days:90 top_n:10
@mega_architect run evidence_check
```

If these run, install/config is complete.
