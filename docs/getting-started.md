# Getting Started with OpenCode Swarm

Get your first swarm task running in under 15 minutes. By the end, you'll have orchestrated a team of AI agents to tackle your first coding task.

---

## Prerequisites

Before you start, verify you have:

- **Bun >=1.0.0** — required by the swarm plugin
  ```bash
  bun --version
  ```
  If missing, install from [bun.sh](https://bun.sh)

- **OpenCode installed and authenticated** — you'll select the architect agent from the OpenCode GUI
  ```bash
  opencode
  ```
  If this opens a web interface, you're ready. If it fails, [install OpenCode](https://opencode.ai).

- **Internet connection** — required for LLM provider API calls (Anthropic, Google, etc.) or free OpenCode Zen tier

- **A project directory to test with** — any small codebase works; even an empty directory is fine for your first run

---

## Step 1 — Install the Swarm Plugin

Run the installer in your terminal:

```bash
bunx opencode-swarm install
```

**Expected output:**

```
✓ Registered opencode-swarm plugin with OpenCode
✓ Created global config: ~/.config/opencode/opencode-swarm.json
✓ Disabled default OpenCode agents (explore, general) to avoid conflicts
✓ Ready to use. Open OpenCode and select an architect agent.
```

**What just happened:**
- The installer registered the swarm plugin with OpenCode
- Two config files were created:
  - **Global:** `~/.config/opencode/opencode-swarm.json` (applies to all projects)
  - **Project-local override (if needed):** `.opencode/opencode-swarm.json` (applies only to this project)

If the command fails:
- **"bunx not found"** — Bun is not installed. Install it from [bun.sh](https://bun.sh), then retry `bunx opencode-swarm install`.
- **"opencode-swarm not found"** — Bun is installed but can't find the package. Try `bun install -g opencode-swarm` first, or if you only have npm available: `npm install -g opencode-swarm && opencode-swarm install`.
- **Permission denied on ~/.config** — Ensure you have write permissions to your home directory.

---

## Step 2 — Verify Installation

Before proceeding, confirm Swarm is loaded. Inside an OpenCode session, run:

```bash
/swarm diagnose
```

You should see a health check report like:

```
## Swarm Health Check

- ✅ **Config Parseability**: Project config is valid JSON (or using defaults)
- ✅ **Grammar WASM Files**: Core runtime + all language grammar files present
- ✅ **Git Repository**: Valid git repository found
- ✅ **Plan Sync**: No plan yet (will be created on first task)

**Result**: ✅ All checks passed
```

If you see ❌ failures, fix them before proceeding. Also check:

```bash
/swarm agents
/swarm config
```

These commands list available agents and show what models they're using. If you see errors, go back to Step 1.

---

## Step 3 — Open Your Project

In your terminal:

```bash
cd /path/to/your/project
opencode
```

The OpenCode GUI will open. You're now ready to select a Swarm architect.

---

## Step 4 — Select the Architect Agent

**On OpenCode desktop (GUI):**
1. Look for an **agent/mode dropdown** in the top toolbar or sidebar (usually labeled "Agent" or "Mode")
2. Click it and look for an option named **`architect`** (or any name starting with "architect")
3. Select it

The dropdown might look like:
```
[Select Agent ▼]
├─ architect         ← Select this
├─ local_architect
├─ Build (default)
└─ Plan (default)
```

**On OpenCode TUI (terminal UI):**
1. Press Ctrl+K or type `/` to open the command palette
2. Search for "architect" or "swarm"
3. Select the architect agent

**Troubleshooting:**
- **Architect dropdown not visible** — Swarm may not be loaded. Go back to Step 2.
- **Only seeing "Build" and "Plan"** — You're not looking at the right dropdown. Look for "Agent Mode" or "Select Agent" specifically.
- **Can't find any architect option** — the installer may have failed. Retry `bunx opencode-swarm install`.

---

## Step 5 — Run Your First Task

Once the architect is selected, type or paste a prompt:

```
Build a simple command-line tool that reads a CSV file and outputs a nicely formatted table to the terminal.
```

Press Enter/Send. **Stop here and watch.**

---

## What Happens Next (8–15 minutes)

The architect will now:

1. **Discover** — scan your codebase structure (framework, dependencies, existing patterns)
2. **Plan** — break your request into phases and tasks
3. **Delegate** — send work to the coder, reviewer, test engineer, etc.
4. **Verify** — run tests, security checks, code review gates
5. **Finalize** — generate a summary and mark tasks complete

You'll see this progress in:

```bash
/swarm status          # Current phase and active task
/swarm show-plan       # The full multi-phase plan
/swarm evidence        # Test results, review findings per task
```

**You don't need to do anything.** The architect runs the other agents automatically. Let it finish.

---

## What Success Looks Like

When the task completes, you should see:

1. **Code files created** — the CSV table tool exists in your project
2. **Tests passing** — `/swarm evidence` shows green checkmarks on syntax, tests, and review gates
3. **A summary** — the architect explains what was built and why

You'll also find a directory called `.swarm/` in your project root:

```
.swarm/
├─ plan.md                    # Multi-phase plan
├─ plan.json                  # Structured plan data
├─ plan-ledger.jsonl          # Durable plan history
├─ evidence/                  # Test, review, security results per task
├─ context.md                 # Cached LLM context between runs
├─ knowledge.jsonl            # Lessons learned (project-scoped; see docs/knowledge.md)
└─ summaries/                 # Output summaries from each phase
```

This is Swarm's persistent state. On your next run, it will resume from where it left off instead of redoing discovery.

---

## Step 5.5 — Autonomous Planning (Optional but Recommended)

Instead of giving the architect a direct implementation request, you can start with a structured planning session using `/swarm brainstorm`. This is useful for larger features where you want the architect to think through design options before writing any code.

```
/swarm brainstorm Build a React web app with email/password auth and a protected dashboard
```

The architect will run a seven-phase planning workflow:

1. **CONTEXT SCAN** — scans your codebase for existing patterns, dependencies, and conventions
2. **DIALOGUE** — asks clarifying questions about requirements it cannot infer
3. **APPROACHES** — proposes 2–3 architectural approaches with tradeoffs
4. **DESIGN SECTIONS** — works through data model, API shape, component structure, and auth flow
5. **SPEC WRITE** — produces a structured implementation spec
6. **SELF-REVIEW** — the architect reviews the spec for completeness and consistency
7. **TRANSITION** — summarizes the plan and waits for your go-ahead

**Important:** After the TRANSITION phase, the architect stops and waits. It will not start implementing automatically. You need to explicitly confirm — for example, type:

```
Looks good. Proceed with implementation.
```

Once you confirm, the architect creates the phased plan in `.swarm/plan.md` and begins delegating work to the coder, reviewer, test engineer, and other agents. From that point, you do not need to give further instructions unless something goes wrong or you want to change direction.

---

## Step 6 — Common First-Run Errors

### "Missing OpenCode authentication"
OpenCode requires an LLM provider API key or a free Zen account. If Swarm can't reach the API:
- Verify your API key is set in OpenCode settings
- Or create a free OpenCode Zen account (no key needed)
- Retry the task

### "OpenCode command not found"
OpenCode is not in your PATH. Either:
- Reinstall OpenCode from [opencode.ai](https://opencode.ai)
- Or add the OpenCode install directory to your PATH

### "Architect not visible in dropdown"
Swarm is not loaded. Retry `bunx opencode-swarm install` and restart OpenCode.

### "First run takes longer than 15 minutes"
Codebase discovery scales with repo size. For large repos (>100K lines), allow 20–30 min on the first run. Subsequent runs are much faster.

### "Second run looks different"
Swarm resumes from `.swarm/plan.md` instead of redoing discovery. This is expected. Run `/swarm reset --confirm` if you want a clean restart.

---

## Step 7 — Next Steps

### Learn the Commands

```bash
/swarm status            # Current swarm state
/swarm show-plan [phase] # View the plan (optionally filtered by phase)
/swarm agents            # List registered agents
/swarm evidence          # Review test and code review results
/swarm reset --confirm   # Clear swarm state and start over
```

See [`docs/commands.md`](commands.md) for all 41 subcommands and their options.

### Configure Models (Optional)

The swarm works with free defaults out of the box. To use your own LLM models:

**Create `.opencode/opencode-swarm.json` in your project:**

```json
{
  "agents": {
    "architect": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "google/gemini-2.5-flash" },
    "reviewer": { "model": "opencode/big-pickle" }
  }
}
```

You only need to specify the agents you want to override. See [`docs/configuration.md`](configuration.md) for the full reference.

### Understand the Modes

Swarm has session-scoped modes you toggle at any time:

| Mode | Speed | Safety | When to Use |
|------|-------|--------|-------------|
| **Balanced** (default) | Medium | High | Everyday development |
| **Turbo** | Fast | Medium | Rapid iteration, skip non-critical checks (Tier-3 files still reviewed) |
| **Full-Auto** | Fast | Depends on critic | Unattended multi-interaction runs |

Project-level `execution_mode` (`strict` / `balanced` / `fast`) is persistent and configured in `.opencode/opencode-swarm.json`. Switch session modes with `/swarm turbo` or `/swarm full-auto`. See [`docs/modes.md`](modes.md).

### Build a Full Web App (End-to-End Example)

For a complete walkthrough of building a React app with authentication using Swarm's autonomous planning workflow, see:

**→ [Example: Building a Web App with Swarm](examples/web-app.md)**

This covers: project setup, running `/swarm brainstorm`, confirming the plan, monitoring agent execution, and reviewing results.

### Explore Advanced Features

- **Knowledge system** — Swarm learns lessons across runs; see [`docs/knowledge.md`](knowledge.md)
- **Evidence and telemetry** — inspect raw test results and system events; see [`docs/evidence-and-telemetry.md`](evidence-and-telemetry.md)
- **Architecture and design** — deep dive into how Swarm works; see [`docs/architecture.md`](architecture.md)

---

## Troubleshooting

### "OpenCode Desktop hangs on the loading screen with the swarm plugin enabled"

Fixed in v7.0.3+. If you see Desktop's loading screen stall indefinitely after
adding `opencode-swarm` to your plugin list, update to the latest published
version (`bunx opencode-swarm update`). The pre-fix sidecar ran a synchronous
workspace scan during plugin init that blocked Desktop's `await server(...)`
forever. The TUI/CLI was unaffected because it tolerates the blocking init.
Issue [#704](https://github.com/zaxbysauce/opencode-swarm/issues/704).

### "I'm stuck or something seems broken"

Run the diagnostic:

```bash
/swarm diagnose
```

This checks plugin registration, agent availability, config validity, and file permissions. Fix any reported issues, then retry your task.

### "Where do I find the swarm project directory?"

It's in your OpenCode project root (wherever you ran `opencode` from):

```bash
ls -la .swarm/
```

### "How do I disable swarm mode?"

Swarm only runs if you explicitly select a Swarm architect. Selecting the default `Build` or `Plan` modes bypasses the plugin entirely.

### "Where can I ask for help?"

See the main project [`README.md`](../README.md) or [`docs/index.md`](index.md) for links to community resources.

---

**You're ready.** Go build something. 🚀
