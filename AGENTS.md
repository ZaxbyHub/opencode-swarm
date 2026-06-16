# AGENTS.md — Engineering contract for opencode-swarm

> **This file is the root engineering contract for opencode-swarm. It applies to every contributor — human, Claude Code, OpenCode agent, or other automated tool. Read it fully before making any code change. It is intentionally short and operational; the long-form rationale and historical failure map live in `docs/engineering-invariants.md`.**

## Required reading order

| When you are about to do… | Read these (in order) |
| --- | --- |
| Any code change | `AGENTS.md` (this file) → `docs/engineering-invariants.md` (skim, deep-dive on touched invariants) |
| Write or modify any test file | this file → `.opencode/skills/writing-tests/SKILL.md` (or `.claude/skills/writing-tests/SKILL.md` for Claude) |
| Commit / push / open a PR | this file → `.claude/skills/commit-pr/SKILL.md` |
| Swarm-mode Claude work | this file → `CLAUDE.md` → `.claude/session/swarm-mode.md` (when present) |
| Architecture / plugin init / subprocess / tool-registration / plan-durability / .swarm storage / runtime-portability change | this file → `docs/engineering-invariants.md` → `.opencode/skills/engineering-conventions/SKILL.md` (or `.claude/skills/engineering-conventions/SKILL.md`) |

`AGENTS.md` and `docs/engineering-invariants.md` together are the single source of truth for repository invariants. When `CLAUDE.md`, `contributing.md`, `TESTING.md`, or any skill conflicts with this file, **this file wins**; that skill or doc is out of date and must be reconciled.

## Prime directive

Preserve the runtime contracts that keep the plugin **loadable, portable, bounded, recoverable, and safe** across Windows, macOS, Linux, GUI, TUI, Bun, and Node-hosted plugin contexts.

A plugin that loads on macOS but hangs Desktop Windows is a regression. A change that passes locally on one platform but corrupts state on another is a regression. Default to "what could go wrong on the host I am not testing on?"

## Non-negotiable invariants

Every PR that touches a relevant area must list which of these invariants it touched and how it verified them. See "Invariant audit required in PRs" below.

### 1. Plugin initialization is fast, bounded, fail-open, side-effect-minimal

- Plugin registration must complete in bounded time on every supported platform. The OpenCode plugin host silently drops a plugin whose entry never resolves; users see "no agents in TUI/GUI" with no error.
- **No unbounded** filesystem scans, Git commands, network calls, package-manager calls, cache repair, repo-graph construction, or large JSON repair before returning the plugin manifest.
- Any init-path environmental work must be wrapped in `withTimeout(...)` (or equivalent), log non-fatally, and continue. Compare `loadSnapshot(...)` in `src/index.ts` (already wrapped) and `ensureSwarmGitExcluded(...)` (post-fix wrapped).
- **Bounded is not free.** `withTimeout` only prevents an *unbounded* hang — the awaited work's latency still counts toward the cross-platform `repro-704` init deadline (~400 ms). If init-path work does non-trivial I/O and nothing downstream depends on its completion before `server()` resolves, **defer it via `queueMicrotask`** (the `repoGraphHook` precedent in `src/index.ts`) instead of `await`ing it. Only `await` init work that is genuinely fast (<~50 ms) **and** must complete before a later init step (e.g. `ensureSwarmGitExcluded` before `.swarm/` writes). Linux `repro-704` passing does **not** prove Windows; cold-FS latency is several× higher and the deadline is enforced on every platform in CI.
- Any init-path subprocess must use **explicit `cwd`**, **`stdin: 'ignore'`** (unless intentionally interactive), **`timeout`**, **bounded or ignored stdout/stderr**, and a **best-effort `proc.kill()` in `finally`**.
- GUI and TUI must still receive the plugin manifest even if optional startup work fails.
- Reference prior failures: v7.0.3 (`#704` repo-graph Desktop hang), v7.3.3 (`#732` Git-hygiene startup regression — the proximate cause of this AGENTS.md). PR #1356 is the **`queueMicrotask` exemplar**: its merged bundled-skill sync is deferred off the `server()`-resolution path; an inline-`await` revision was corrected pre-merge after it pushed `server()` past the Windows `repro-704` T1 deadline (see the in-code comment at `src/index.ts` ~line 381 and the "Bounded is not free" bullet above).

### 2. Runtime portability — Node-ESM-loadable + OpenCode v1 plugin shape

- The main plugin bundle (`dist/index.js`) must remain Node-ESM-loadable. **No top-level `bun:` imports** (see v6.86.8 / `bundle-portability.test.ts`).
- **No direct `Bun.*` calls** outside `src/utils/bun-compat.ts`. CLI-only modules that intentionally `--target bun` are the only exception.
- The default export must remain the v1 plugin object shape `{ id, server }` (see v6.86.9 / `bundle-plugin-shape.test.ts`).
- Any change touching `src/index.ts`, package exports, `package.json#main`, `bun build` config, or plugin entry shape must run the bundle-portability and plugin-shape tests AND `node --input-type=module -e "await import('./dist/index.js')"`.
- `dist/` is **generated build output and is not committed** (#1047). Do not stage it. CI builds it (`unit`, `package-check`, `smoke` run `bun run build`) and `package-check` validates the packed npm tarball; release/publish builds from source.

### 3. Subprocesses — bounded, non-interactive, killable, portable

- **Array-form spawn only.** No shell-string commands unless the use case is independently justified and quoted.
- Set `cwd` explicitly, OR for Git CLI calls use an explicit `git -C <directory>` argument. Do not rely on inherited process cwd.
- `stdin: 'ignore'` unless the spawn is intentionally interactive. A never-closed stdin pipe under Bun on Windows can block the child from exiting (see v7.3.3 fix).
- `timeout: <ms>` is required for git, package managers, test runners, language tooling, and any external binary. There is no platform on which "git is always fast" is a safe assumption.
- Consume, bound, or ignore stdout/stderr. Never leave a piped stream unattended on a long-running child.
- Best-effort `proc.kill()` in `finally`. An outer `withTimeout` alone is not enough — it lets the awaiter proceed but does not abort the child.
- Windows is first-class. Handle `.cmd` extensions for npm/bun binaries, PATH differences, and the fact that `child_process.spawn('bin', ...)` does not behave identically to `cmd.exe`.

### 4. Working directory and `.swarm/` containment

- Runtime state lives **only** under the project root `.swarm/` directory. Tools must use `ctx.directory` injected via `createSwarmTool` (`src/tools/create-tool.ts`).
- `process.cwd()` is an explicitly documented **direct-CLI / test fallback only**. Do not introduce new `process.cwd()` callers in tools or hooks.
- User-supplied `working_directory` must resolve to the project root, never a subdirectory. See v6.82.2 (`#577`): `save_plan` and the shared `resolveWorkingDirectory` helper anchor inputs.
- No tool may create `.swarm/` under `src/`, `tests/`, `packages/*`, or any arbitrary `cwd`. New-directory checks must be explicit.
- `.swarm/` must not become Git pollution. The `ensureSwarmGitExcluded` flow (v7.3.3) keeps the project's `.git/info/exclude` honest; do not bypass it.
- **Exception — version-controlled deliverables:** documentation the docs agent authors into the project repo is *output*, not runtime state. The `docs` agent already writes README/CHANGELOG; the `docs_design` agent (issue #1080, opt-in) writes design docs under `design_docs.out_dir` (default `docs/`). These are intentionally committed and are exempt from `.swarm/` containment. Their *runtime drift signal* (`.swarm/doc-drift-phase-N.json`) stays under `.swarm/`.

### 5. Plan durability — ledger is authoritative

- `.swarm/plan-ledger.jsonl` is the authoritative source of plan state. `.swarm/plan.json` and `.swarm/plan.md` are derived projections.
- `SWARM_PLAN.{json,md}` files are checkpoint / export artifacts, scoped to `.swarm/` (v7.0.1 / `#583`).
- Do not hand-edit `plan.md` as a source of truth. Do not write to `plan.json` outside the ledger replay path.
- Any plan-schema or status-shape change must update **all six** of: ledger replay, projection, checkpoint import/export, `get_approved_plan`, tests, and docs (`docs/plan-durability.md`).

### 6. Test execution — do not use broad `test_runner` for repo validation

- Do not use the OpenCode `test_runner` tool with `scope: 'all'` or broad `'graph'` / `'impact'` scope for **whole-repo validation**. `scope: 'all'` requires `allow_full_suite: true` and is intended for opt-in CI mirrors, not interactive use.
- `MAX_SAFE_TEST_FILES = 50` (`src/tools/test-runner.ts`). Resolutions exceeding this return `outcome: 'scope_exceeded'` with a SKIP instruction; broad scopes can stall or kill OpenCode.
- For repo validation, prefer **shell commands** (the per-file isolation loops in `contributing.md` / `TESTING.md`).
- For targeted agent validation, use `test_runner` with explicit `files: [...]` or small targeted scopes.

### 7. Test writing — bun:test, mock isolation, DI over `mock.module`

- All tests use `bun:test` only. No Jest, Vitest, etc. Bun's vitest-compat layer has known isolation bugs.
- Load the writing-tests skill (`.opencode/skills/writing-tests/SKILL.md` or `.claude/skills/writing-tests/SKILL.md`) before modifying tests.
- `mock.module(...)` leaks across test files in Bun's shared test-runner process. Spread the real module when mocking, or — preferred — use **dependency injection** via a small `_internals` seam (see `src/utils/gitignore-warning.ts:_internals` and `src/hooks/diff-scope.ts:_internals` introduced by the v7.3.4 fix). Restore the seam in `afterEach`.
- Use `os.tmpdir()` + `path.join(...)` for temp paths. No hardcoded `/tmp` or `C:\` strings.
- `mkdtempSync` must be wrapped in `realpathSync` if the result is `chdir`'d on macOS.

### 8. Session and global state — keyed and bounded

- Anything session-scoped must be keyed by `sessionID` (see v6.80.2 `recentToolCallsBySession` and `lastSpiralTimestampBySession` fixes).
- Module-level global state must have an explicit eviction strategy (`MAX_TRACKED_SESSIONS`, FIFO eviction).
- Add cooldowns for repeated safety/advisory behavior (e.g. spiral-detection 60 s cooldown).
- No cross-session pollution. Global arrays and maps that mix session data are bugs.

### 9. Guardrails / retry semantics

- Distinguish transient infrastructure / provider errors (HTTP 429 / 503 / 529, timeouts, "temporarily unavailable") from real agent-logic failures (see v6.86.14).
- Transient errors use bounded retry (`max_transient_retries`, default 5) **before** counting toward `consecutiveErrors` / circuit-breaker accounting.
- `transientRetryCount` resets per invocation. Do not persist it across invocations.
- Transient retry and model fallback are independent — neither subsumes the other.

### 10. Chat / system-message hook contracts

- Preserve OpenCode's expected message shape end-to-end. Multiple `output.system` entries are materialized into multiple `{ role: 'system' }` messages.
- After swarm augmentation, collapse to a single system message (see v6.85.1 / `#608`). Local models (Qwen3.6, Gemma) require exactly one system message at index 0.
- Do not emit diagnostic noise into chat-visible streams. Use the debug-gated logger (`src/utils/log.ts`) unless the message is an operational or security warning that must always be visible.

### 11. Tool registration + agent-map coherence

- A tool addition is **incomplete** until: (a) export from `src/tools/index.ts`, (b) registration in the plugin `tool: {}` block in `src/index.ts`, (c) entry in `TOOL_NAMES` (`src/tools/tool-names.ts`) and the relevant agent tool map (`AGENT_TOOL_MAP` or an opt-in map in `src/config/constants.ts`), (d) help/documentation surfaces, (e) tests covering the new entry.
- Run `tests/unit/config/*.test.ts` and `/swarm doctor tools` after any tool, agent-map, command, or help change. See v6.48.0.
- Parity assertions across sibling map entries are intentional. If a parity test fails, mirror the change to siblings (most common) or update the invariant test if the design intent has actually changed.
- **Opt-in tool maps**: Some tools are intentionally gated behind feature flags and use separate opt-in maps (e.g., `MEMORY_AGENT_TOOL_MAP` for memory tools when `memory.enabled === true`). These tools must still be exported, registered in the plugin, and have `TOOL_NAMES` entries, but are merged into agent configs conditionally at build time. Opt-in maps must be validated by tests that verify: (a) tools do NOT appear when the feature is disabled, (b) tools DO appear when the feature is enabled, (c) the merged tool set is correct for each agent role. See the memory-tool merge path in `src/agents/index.ts` and `tests/unit/agents/memory-tool-gating.test.ts` for the current pattern.
- **Agent registration changes must test both legacy unprefixed AND multi-swarm prefixed agent names.** v7.3.x regression: a schema default on `default_agent` ("architect") combined with strict equality demoted every `*_architect` to subagent in multi-swarm configs, so OpenCode showed the plugin as loaded but no swarm architect agents appeared. Tests that only used legacy unprefixed `architect` missed the bug entirely. Any change to primary/subagent selection, `default_agent`, or `getAgentConfigs` MUST include a multi-swarm `swarms: { local: ..., mega: ... }` test that asserts at least one prefixed agent is `mode: 'primary'`.

### 12. Release / cache hygiene

- A plugin fix is incomplete if users stay pinned to a stale OpenCode plugin cache. Install / update / cache changes must cover **all known cache layouts**, including the macOS / Windows variants documented in v6.86.9 (Layout 1 `~/.cache/opencode/packages/opencode-swarm@latest`, Layout 2 `~/.config/opencode/node_modules/opencode-swarm`, Layout 3 `~/.cache/opencode/node_modules/opencode-swarm`).
- Cache-deletion code must use `isSafeCachePath` four-layer defense (depth, basename whitelist, recognized parent, canonical structure).
- **Never hand-edit** `package.json#version`, `CHANGELOG.md`, or `.release-please-manifest.json`. release-please owns those.
- Every user-visible PR ships a `docs/releases/pending/<unique-slug>.md` fragment (mandatory — see `contributing.md`). Do NOT compute a next version or create `docs/releases/vX.Y.Z.md`; release-please owns the version, and `scripts/release-notes-fragments.mjs` aggregates pending fragments into the release PR / GitHub Release body. The aggregated text is the only narrative future users will see.

## Invariant audit required in PRs

Every PR that touches a relevant area must include a `## Invariant audit` section in its description (see `.claude/skills/commit-pr/SKILL.md`). The required format is:

```
## Invariant audit
- 1 (plugin init):       touched / not touched — <evidence>
- 2 (runtime portability): touched / not touched — <evidence>
- 3 (subprocesses):       touched / not touched — <evidence>
- 4 (.swarm containment): touched / not touched — <evidence>
- 5 (plan durability):    touched / not touched — <evidence>
- 6 (test_runner safety): touched / not touched — <evidence>
- 7 (test writing):       touched / not touched — <evidence>
- 8 (session state):      touched / not touched — <evidence>
- 9 (guardrails/retry):   touched / not touched — <evidence>
- 10 (chat/system msg):   touched / not touched — <evidence>
- 11 (tool registration): touched / not touched — <evidence>
- 12 (release/cache):     touched / not touched — <evidence>
```

For every "touched" entry, the evidence must be a concrete artifact: a command run with its output, a test that proves the invariant, a grep showing no remaining anti-patterns, or a quoted spec citation. "Looks fine" is not evidence.

If you cannot prove a touched invariant from source and test output, **do not push**.

## When in doubt

- Ask, don't guess. The patterns in this file are the result of prior outages — every one has a release note in `docs/releases/`.
- Prefer the smallest patch that closes the issue without unwired functionality, untested branches, or hidden regressions.
- Defense in depth is cheap; an unbounded await is not.
