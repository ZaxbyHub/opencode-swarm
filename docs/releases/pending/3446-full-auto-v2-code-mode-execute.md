# Fix: Full-Auto is usable on OpenCode 2 — Code Mode wrapper, `swarm_command`, a shell-free critic, and a hook budget that outlasts it

## What changed

Four defects stacked on OpenCode 2; together they paused every Full-Auto run.

1. **Code Mode `execute` wrapper.** OpenCode 2 reaches plugin and MCP tools through one host-owned `execute` tool whose input is a JS program. The classifier had no rule for it, so every plugin tool call was escalated to the critic (and the nested tool again). v2 tool events carry no field proving a tool is host-owned, so a third-party tool that merely shares the name cannot be told apart; the pass-through is therefore **off by default** and opt-in via `full_auto.permission_policy.trust_code_mode_wrapper`. When enabled, the v2 adapter marks any `execute` event carrying a string `code` (a shape check, not provenance; new `src/hooks/code-mode-wrapper.ts`) and the classifier allows a marked call **only when its program is exactly one `tools.<path>(<plain data>)` or `search(<plain data>)` call** (new `src/full-auto/code-mode-program.ts`). The Code Mode sandbox also exposes `fetch` and `Function`, which no hook sees, so any other program — and any unmarked `execute` — still escalates.
2. **`swarm_command`.** It was one of 93 swarm tools that escalate on every call. Its own tool policy is an allowlist of what an *agent* may run, but that list also contains state-changing and process-spawning commands (`auto-proceed`, `guardrail reset`, `attest`, `ci-simulate`, `gate-audit`, `review`, `sdd project`, ...), so it is not a safety classification. Full-Auto now passes without a critic only commands on an explicit read-only set that the tool policy also permits, and never in strict mode (`status`, `show-plan`, `sdd status`/`validate`, `costs`, `evidence`, `memory status`/`pending`/`stale`, ...; 30 keys). The invariant is no change to source, plan or gates, no process spawn and no network egress; some of these refresh bookkeeping under `.swarm/` (`report`, `memory *`), which a test pins by running every key and diffing the tree outside `.swarm/`. `diagnose`, `doctor tools` and `pr status` are excluded from the set because they spawn processes or reach GitHub; every other `/swarm` command still escalates.
3. **The critic wandered (not a sandbox).** The critic was only denied `write`/`edit`/`patch`, so on OpenCode 2 it ran `grep -rl` and `find ~` over the home directory until the oversight deadline cancelled it, producing no verdict. It is now also denied `bash`/`shell` (`src/full-auto/critic-tools.ts`, used by both dispatchers) and the prompt asks for at most 5 tool calls inside the project directory. This is not a bounded critic: `execute` (Code Mode, which reaches plugin tools) remains available to it, and the Code Mode sandbox also exposes `fetch`/`Function`, which no hook sees. A restricted critic Code Mode surface is a follow-up.
4. **Fixed 60 s hook budget.** The v2 adapter cut the whole `tool.execute.before` chain off at 60 s, shorter than the 120 s default oversight deadline, so the host reported `tool.execute.before exceeded budget` while the critic was still working. The budget is now configurable (`full_auto.oversight.hook_timeout_ms`) and, while a Full-Auto run is active, follows `oversight.total_timeout_ms` + 30 s (never below 60 s).

## Why

Measured on OpenCode 2.1.4 with the real oversight prompt: an unbounded critic needs about 106–110 s over 6–8 steps (13–17 s per step on an Opus-class tier) to reach a verdict, so a 120 s deadline fails whenever one step is slow, and the 60 s hook budget fails it outright. All six critic sessions recorded in one project's history ended at exactly the 120 s deadline, mid-investigation.

## Impact

- Full-Auto on OpenCode 2: read-only `/swarm` commands (and, when opted in, single-call Code Mode wrappers) no longer cost a critic round trip; the critic that does run no longer wanders into shell searches; the hook no longer gives up before it finishes.
- OpenCode 1.x: the critic loses `bash`/`shell` (it is told to use read-only tools only); nothing is ever marked as a Code Mode wrapper.
- New optional keys `full_auto.oversight.hook_timeout_ms` and `full_auto.permission_policy.trust_code_mode_wrapper` (default `false`).

## Migration

None required. Raise `full_auto.oversight.total_timeout_ms` (max 300000) if your critic model is slow; the hook budget follows it.
