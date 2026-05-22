---
name: engineering-conventions
description: >
  Guidelines and non-negotiable engineering invariants for modifying opencode-swarm.
  Load before architecture, plugin initialization, subprocess, tool registration, plan
  durability, .swarm storage, runtime portability, session/global state, guardrails/retry,
  chat/system message hooks, or release/cache changes. Authoritative source: AGENTS.md
  at the repo root and docs/engineering-invariants.md.
---

# Engineering Conventions for opencode-swarm

**Authoritative source:** [`AGENTS.md`](../../../AGENTS.md) at the repo root and [`docs/engineering-invariants.md`](../../../docs/engineering-invariants.md). This skill is a pointer + summary so the OpenCode agent loads the right invariants before touching dangerous areas. **Read `AGENTS.md` first.** When this skill conflicts with `AGENTS.md`, `AGENTS.md` wins.

## When to load this skill

Load this skill **before** beginning implementation work that touches any of:

- `src/index.ts` (plugin entry / `initializeOpenCodeSwarm`)
- `src/hooks/*` (any hook that may run during init or QA review)
- `src/tools/*` (tool registration, working-directory anchoring, test_runner)
- `src/utils/bun-compat.ts` (subprocess shim — every spawn in the repo eventually flows through here)
- `src/utils/timeout.ts` (the `withTimeout` primitive used by every bounded init step)
- `src/utils/gitignore-warning.ts` (Git hygiene; runs on plugin init path)
- `package.json`, build configuration, `dist/`, plugin export shape
- Plan ledger / projection / checkpoint code (`src/plan/*`, `.swarm/plan-*`)
- Session / guardrails / runtime state (`src/state.ts`, `src/hooks/guardrails.ts`)
- Tests involving subprocesses, plugin startup, `mock.module`, or temp directories

If you are not sure whether you are touching one of these, you are touching one of these.

## Highest-risk invariants (the ones that have already shipped regressions)

The full list of 12 invariants is in `AGENTS.md`. The four that have caused the most recent production regressions:

1. **Plugin initialization is bounded and fail-open.** Every awaited operation on the plugin-init path must be wrapped in `withTimeout(...)` and degrade non-fatally on timeout. Issue #704 (v7.0.3) and the v7.3.3 git-hygiene regression both stem from violating this. The OpenCode plugin host silently drops a plugin whose entry never resolves; users see "no agents in TUI / GUI" with no error.
2. **Subprocesses are bounded, non-interactive, and killable.** Every `bunSpawn(['<bin>', ...])` call must pass `cwd`, `stdin: 'ignore'` (unless intentionally interactive), `timeout: <ms>`, bounded stdio, and call `proc.kill()` in a `finally`. An outer `withTimeout` is not enough — it lets the awaiter proceed but does not abort the child. The Node path (`bun-compat.ts`) must also set `windowsHide: true` to prevent console flash on Windows. If using `Promise.race` with `setTimeout`, capture the timer handle and `clearTimeout` after the race resolves to avoid dangling kill() calls on dead processes.
3. **Runtime portability — Node-ESM-loadable + v1 plugin shape.** No top-level `bun:` imports in `dist/index.js`. Default export is `{ id, server }`. All `Bun.*` calls go through `src/utils/bun-compat.ts`. v6.86.8 / v6.86.9 are the cautionary tales.
4. **Test mock isolation.** `mock.module(...)` leaks across files in Bun's shared test-runner process. Prefer, in order: (a) `_test_exports` for pure function testing with zero mocks, (b) `_internals` dependency-injection seam for within-module mocking (see `src/utils/gitignore-warning.ts:_internals` and `src/hooks/diff-scope.ts:_internals`), (c) `mock.module` only when unavoidable. Restore in `afterEach`. The writing-tests skill covers all three tiers in detail; load it before modifying tests.

## Cross-link: writing tests

For test changes, also load [`.opencode/skills/writing-tests/SKILL.md`](../writing-tests/SKILL.md). It covers `bun:test` API, mock isolation rules, CI per-file isolation, and cross-platform anti-patterns.

## Hard warning: do NOT use broad `test_runner` for repo validation

The OpenCode `test_runner` tool is for **targeted agent validation** with explicit `files: [...]` or small targeted scopes. It is not the way to validate the full repo from inside an OpenCode session. In this repo:

- `MAX_SAFE_TEST_FILES = 50` (`src/tools/test-runner.ts:26`). Resolutions exceeding this return `outcome: 'scope_exceeded'` with a SKIP. Do not lean on this — broad scopes can stall or kill OpenCode before that guard fires.
- For repo validation, run the shell commands in `contributing.md` / `TESTING.md` directly (per-file isolation loops + tier orchestration).
- `scope: 'all'` is reserved for CI / maintainer environments and is unavailable in agent sessions — never attempt it; use the per-file shell loops. Default to `files: [...]` instead.

## The invariant-audit gate (PR-time)

Every PR that touches a relevant area must include an `## Invariant audit` section in its description. The format is in `AGENTS.md` ("Invariant audit required in PRs"). The `commit-pr` skill enforces this gate before push/PR — load it before committing.

If you cannot prove a touched invariant from source and test output, **do not push**.
