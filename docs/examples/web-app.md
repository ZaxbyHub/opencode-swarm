# Building a React Web App with Authentication

This tutorial walks through building a React + TypeScript web app with email/password authentication using OpenCode Swarm's autonomous planning workflow. By the end you'll have used `/swarm brainstorm` to design the feature, confirmed the plan, and watched the swarm execute it.

---

## Prerequisites

You need four things before you start:

- **Bun >=1.0.0**
  ```bash
  bun --version
  ```
  If missing, install from [bun.sh](https://bun.sh).

- **OpenCode installed and working**
  ```bash
  opencode --version
  ```
  If missing, install from [opencode.ai](https://opencode.ai).

- **OpenCode Swarm plugin installed**
  ```bash
  bunx opencode-swarm install
  ```
  This registers the plugin, disables conflicting default agents, and creates your global config at `~/.config/opencode/opencode-swarm.json`. You only need to do this once per machine.

- **An empty project directory**
  ```bash
  mkdir react-auth-app && cd react-auth-app
  ```

---

## Step 1 — Scaffold the React Project

Create a Vite + React + TypeScript project:

```bash
bun create vite . --template react-ts
bun install
```

Expected output:

```
Scaffolding project in /home/you/react-auth-app...

Done. Now run:

  bun install
  bun run dev
```

Verify it builds:

```bash
bun run build
```

You should see a `dist/` folder with no errors. The project is now ready for Swarm to work with.

---

## Step 2 — Open OpenCode

From inside the project directory:

```bash
opencode
```

The OpenCode GUI will open with your project loaded. Swarm has already been registered globally, so all 11 agents are available.

---

## Step 3 — Select the Architect Agent

Before typing anything, you need to select the Swarm architect from the agent dropdown. **Do not use the default Build or Plan modes** — those bypass the Swarm plugin entirely.

In the OpenCode GUI:

1. Click the **agent/mode dropdown** in the top toolbar (usually labeled "Agent" or "Mode").
2. Select **`architect`**.

The dropdown should look similar to:

```
[Select Agent ▼]
├─ architect         ← select this
├─ local_architect
├─ Build (default)
└─ Plan (default)
```

Once the architect is selected, the `/swarm` commands become active and Swarm will route all work through its pipeline.

> **Why does this matter?** Selecting `Build` or `Plan` sends your prompt directly to OpenCode's built-in handler. The Swarm plugin never runs. You must be on an architect agent for any `/swarm` command to have effect.

---

## Step 4 — Start the Planning Session

With the architect selected, type:

```
/swarm brainstorm Build a React web app with email/password authentication and a protected dashboard route
```

Press Enter. The architect begins a seven-phase planning workflow. You do not need to do anything yet — just watch.

---

## Step 5 — What Happens During Brainstorm

The architect works through these phases sequentially. You'll see each phase name appear as it starts.

### CONTEXT SCAN

The architect reads your project files to understand what already exists: `package.json`, `vite.config.ts`, `tsconfig.json`, existing source files, and any installed dependencies. For this new project it will note that React 18 + TypeScript + Vite are the base stack and that no auth library is yet installed.

```
[CONTEXT SCAN] Reading project structure...
  Detected: React 18.3, TypeScript 5.6, Vite 6.0
  Auth libraries: none found
  Routing: none found
  State management: none found
  Test framework: none found
```

### DIALOGUE

The architect asks only what it cannot infer. For a React auth app on a fresh Vite scaffold it typically asks:

```
A few questions before I design the spec:

1. Backend: do you have an existing API server, or should I include a
   lightweight Express/Hono backend as part of this plan?

2. Session strategy: JWT stored in localStorage, HttpOnly cookie, or
   no preference (I'll choose the more secure default)?

3. Protected route behavior: should unauthenticated users be redirected
   to /login, or shown an inline error?

4. Testing: do you want the test engineer to cover the auth flow with
   integration tests, unit tests, or both?
```

Answer only what you have strong opinions about. If you have no preference, say so and the architect will choose a sensible default. For example:

```
1. Include a minimal Express backend — I want the full stack in one repo.
2. No preference on session strategy, use the secure default.
3. Redirect to /login.
4. Both unit and integration tests.
```

The architect will not ask again for anything you have answered or that it can infer from the codebase.

### APPROACHES

The architect proposes 2–3 architectural options with explicit tradeoffs. For a React auth app this typically looks like:

```
Three approaches for review:

A) React + Vite frontend / Express backend / JWT in HttpOnly cookie
   Pros: secure by default, works well with SSR later
   Cons: requires CORS setup, slightly more backend boilerplate

B) React + Vite / Express / JWT in localStorage
   Pros: simpler fetch calls, no cookie config
   Cons: XSS-accessible token — not recommended for production

C) React + Vite / Hono (edge-compatible) / HttpOnly cookie
   Pros: lighter than Express, compatible with Cloudflare Workers later
   Cons: less documentation for beginners

Recommendation: Option A unless you have a specific deployment target.
```

You can reply with a preference or stay silent and let the architect continue.

### DESIGN SECTIONS

The architect works through four design areas in sequence:

- **Data model** — `User` entity fields, password hashing strategy (bcrypt), token shape
- **API shape** — `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- **Component structure** — `LoginForm`, `RegisterForm`, `ProtectedRoute`, `Dashboard`, `AuthProvider` context
- **Auth flow** — token lifecycle, redirect logic, how the `AuthProvider` hydrates on page load

This phase produces no code. It is pure design reasoning written as structured notes.

### SPEC WRITE

The architect converts the design notes into a formal spec at `.swarm/spec.md`. The spec uses RFC 2119 keywords (MUST, SHOULD, MAY) to make requirements unambiguous for the coder and test engineer:

```
## Auth Requirements

- The backend MUST hash passwords using bcrypt with a cost factor >= 12.
- The login endpoint MUST return a Set-Cookie header with HttpOnly, Secure,
  and SameSite=Strict attributes.
- The frontend MUST redirect unauthenticated users accessing /dashboard to /login.
- The RegisterForm component MUST display inline field-level validation errors
  before submitting to the API.
```

### SELF-REVIEW

The architect re-reads the spec and checks it against the design notes. It looks for gaps, contradictions, and requirements that cannot be tested. Any issues are corrected before the plan is written. You will see a brief summary:

```
[SELF-REVIEW] Checking spec completeness...
  Issue found: no acceptance criteria for token expiry behavior — added.
  Issue found: logout endpoint behavior on invalid cookie not specified — added.
  No contradictions found.
  Spec ready.
```

### TRANSITION

The architect summarizes the full plan and then **stops**. It will not start implementing automatically. You will see something like:

```
[TRANSITION] Planning complete.

Proposed plan: 4 phases, 14 tasks.

Phase 1 — Backend foundation (4 tasks)
  src/server/index.ts          — Express app entry point
  src/server/db.ts             — SQLite setup and User schema
  src/server/auth/register.ts  — Registration handler
  src/server/auth/login.ts     — Login handler with bcrypt verify

Phase 2 — Auth middleware and session (3 tasks)
  src/server/middleware/auth.ts  — JWT validation middleware
  src/server/auth/logout.ts      — Cookie clear handler
  src/server/auth/me.ts          — Current-user endpoint

Phase 3 — Frontend auth (4 tasks)
  src/client/context/AuthProvider.tsx  — Auth state context
  src/client/components/LoginForm.tsx  — Login form with validation
  src/client/components/RegisterForm.tsx — Register form with validation
  src/client/components/ProtectedRoute.tsx — Route guard

Phase 4 — Dashboard and routing (3 tasks)
  src/client/App.tsx           — Router setup with protected routes
  src/client/pages/Dashboard.tsx — Protected dashboard page
  src/client/pages/Login.tsx   — Login page wrapper

Full spec written to .swarm/spec.md.
Awaiting your confirmation to begin implementation.
```

**The architect will not proceed until you reply.** This is the only required human interaction in the entire workflow.

---

## Step 6 — Confirm the Plan

Read the transition summary. If it looks right, type:

```
Looks good. Proceed.
```

You can also give targeted feedback before confirming:

```
Move the SQLite setup to a separate phase so I can swap it for Postgres later.
Looks good otherwise. Proceed.
```

The architect will apply any last adjustments, write `.swarm/plan.md`, and immediately begin executing Phase 1.

> **If you do not confirm**, the architect remains idle. The session saves to `.swarm/` automatically. The next time you open OpenCode in this directory, Swarm resumes from the TRANSITION checkpoint — you do not need to re-run `/swarm brainstorm`.

---

## Step 7 — Autonomous Execution

After confirmation, the architect runs the entire plan without further input. Here is what happens for each task:

1. **Architect** reads the task from `plan.md`, resolves its declared file path, and delegates to the **coder**.
2. **Coder** writes or modifies exactly the declared file. Scope enforcement flags any writes outside the declared path.
3. **Incremental verify** runs automatically (TypeScript type-check for `.ts`/`.tsx` files).
4. **Reviewer** checks the code for correctness, security, and adherence to the spec.
5. **Test engineer** writes tests for the task and runs them. If they fail, the failure is fed back to the coder with structured context.
6. **Architect** runs a regression sweep after each phase completes.
7. After all phases, the **docs agent** updates documentation and the architect writes a phase retrospective.

You will see activity in the OpenCode chat window as each agent completes its work. Nothing in the pipeline requires a reply from you unless a genuine ambiguity arises that the agents cannot resolve from the spec and codebase — which is rare for a well-specified plan.

For a 14-task plan like this one, expect 25–45 minutes on first run.

---

## Step 8 — Monitor Progress

While execution runs, these commands give you visibility:

**Check the current phase and active task:**

```
/swarm status
```

```
Phase: 2 [IN PROGRESS]
Active task: src/server/middleware/auth.ts — JWT validation middleware
Tasks: 5/14 complete
Agents: 11 registered
```

**View the full plan and per-task status:**

```
/swarm show-plan
```

```
Phase 1 — Backend foundation [COMPLETE]
  [x] src/server/index.ts
  [x] src/server/db.ts
  [x] src/server/auth/register.ts
  [x] src/server/auth/login.ts

Phase 2 — Auth middleware and session [IN PROGRESS]
  [x] src/server/middleware/auth.ts
  [ ] src/server/auth/logout.ts
  [ ] src/server/auth/me.ts
...
```

**View per-task evidence (test results, review findings):**

```
/swarm evidence
```

```
src/server/auth/register.ts
  pre_check:  PASS — tsc clean, no lint errors
  reviewer:   APPROVED — bcrypt cost factor 12, input validated
  tests:      PASS — 3/3 (register success, duplicate email, missing fields)

src/server/auth/login.ts
  pre_check:  PASS
  reviewer:   APPROVED
  tests:      PASS — 4/4
```

**List all registered agents:**

```
/swarm agents
```

You can run these commands at any time during execution without interrupting the pipeline.

---

## Step 9 — What You Get When It Finishes

When the architect marks the final phase complete, your project will contain:

**Source files:**

```
src/
├─ server/
│   ├─ index.ts
│   ├─ db.ts
│   └─ auth/
│       ├─ register.ts
│       ├─ login.ts
│       ├─ logout.ts
│       └─ me.ts
│   └─ middleware/
│       └─ auth.ts
└─ client/
    ├─ App.tsx
    ├─ context/
    │   └─ AuthProvider.tsx
    ├─ components/
    │   ├─ LoginForm.tsx
    │   ├─ RegisterForm.tsx
    │   └─ ProtectedRoute.tsx
    └─ pages/
        ├─ Dashboard.tsx
        └─ Login.tsx
```

**Swarm state directory:**

```
.swarm/
├─ plan.md              # Full phased plan with final task statuses
├─ plan.json            # Structured plan data (machine-readable)
├─ plan-ledger.jsonl    # Durable append-only plan history
├─ spec.md              # The implementation spec from brainstorm
├─ evidence/            # Per-task test results, reviewer findings, gate logs
├─ context.md           # Cached architect context between runs
├─ knowledge.jsonl      # Project-scoped lessons learned across runs
└─ summaries/           # Phase retrospective summaries
```

The `.swarm/` directory is Swarm's persistent state. Commit it to version control if you want teammates to resume from the same point.

---

## Common Questions

**Do I need to be in Plan mode in OpenCode?**

No. "Plan mode" in OpenCode is a built-in OpenCode feature that has nothing to do with Swarm. If you select Plan mode, Swarm is bypassed entirely. Select the **Architect agent** from the agent dropdown. That is the only thing that activates Swarm.

**Will Swarm read my project's `.claude/skills/`?**

No. `.claude/skills/` is Claude Code's skill system, not OpenCode's. OpenCode Swarm does not read it. Swarm reads your project's source code, `package.json`, and other config files automatically during CONTEXT SCAN. If you want to give Swarm custom instructions — for example, to prefer a specific library or enforce a naming convention — put them in your project config at `.opencode/opencode-swarm.json` under the relevant agent's `instructions` field.

**Do I need to run `/swarm show-plan` manually?**

No. `/swarm brainstorm` generates and writes the plan automatically. Running `/swarm show-plan` after the fact is just a way to read the plan that was already written. You would only write a plan manually if you wanted to skip brainstorm entirely and hand-author `.swarm/plan.md`.

**How autonomous is it really?**

Fully autonomous after your confirmation at TRANSITION. The only time the architect asks for input during brainstorm is in the DIALOGUE phase, and only for things it genuinely cannot infer from your codebase and prompt. Once you type "Proceed", you do not need to give any further instructions unless the plan itself needs to change. The coder, reviewer, test engineer, critic, and other agents all run without prompting.

**Where is my project-local config?**

Project-local config lives at `.opencode/opencode-swarm.json` (not `.swarm/`). Create this file to override models, add agent instructions, or tune guardrails for this specific project. It merges over the global config at `~/.config/opencode/opencode-swarm.json`. After your first OpenCode startup in the project, a `.swarm/config.example.json` file is auto-generated as a commented model reference — it does not affect runtime behavior but shows every available option.

**What if I close OpenCode mid-run?**

Swarm saves all state to `.swarm/` continuously. When you reopen OpenCode in the same directory and select the architect agent, it detects `.swarm/plan.md` and resumes from where it left off. You do not need to re-run brainstorm or re-confirm the plan.

**What if a task fails repeatedly?**

The coder receives structured failure feedback from the reviewer and test engineer and retries automatically. If the loop does not resolve, the architect escalates to the critic agent. In rare cases the architect will surface a question to you — this appears as a normal chat message describing what it is stuck on. You can reply directly or use `/swarm evidence` to see exactly which gate is failing and why.

---

## Quick Reference

```
/swarm brainstorm <topic>   Start the seven-phase planning workflow
/swarm status               Current phase, active task, task count
/swarm show-plan [N]        Full plan, or only phase N
/swarm evidence             Per-task test results and review findings
/swarm agents               List all registered agents and their models
/swarm config               Show resolved config (global + project merged)
/swarm diagnose             Health check — run this if something seems wrong
/swarm history              Completed phases with status icons
```

For all 41 subcommands and their options, see [`docs/commands.md`](../commands.md).
