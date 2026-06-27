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
2. **Subprocesses are bounded, non-interactive, and killable.** Every `bunSpawn(['<bin>', ...])` call must pass `cwd`, `stdin: 'ignore'` (unless intentionally interactive), `timeout: <ms>`, bounded stdio, and call `proc.kill()` in a `finally`. An outer `withTimeout` is not enough — it lets the awaiter proceed but does not abort the child.
3. **Runtime portability — Node-ESM-loadable + v1 plugin shape.** No top-level `bun:` imports in `dist/index.js`. Default export is `{ id, server }`. All `Bun.*` calls go through `src/utils/bun-compat.ts`. v6.86.8 / v6.86.9 are the cautionary tales.
4. **Test mock isolation.** `mock.module(...)` leaks across files in Bun's shared test-runner process. Prefer, in order: (a) `_test_exports` for pure function testing with zero mocks, (b) `_internals` dependency-injection seam for within-module mocking (see `src/utils/gitignore-warning.ts:_internals` and `src/hooks/diff-scope.ts:_internals`), (c) `mock.module` only when unavoidable. Restore in `afterEach`. The writing-tests skill covers all three tiers in detail; load it before modifying tests.

## Cross-link: writing tests

For test changes, also load [`.opencode/skills/writing-tests/SKILL.md`](../writing-tests/SKILL.md). It covers `bun:test` API, mock isolation rules, CI per-file isolation, and cross-platform anti-patterns.

## Hard warning: do NOT use broad `test_runner` for repo validation

The OpenCode `test_runner` tool is for **targeted agent validation** with explicit `files: [...]` or small targeted scopes. It is not the way to validate the full repo from inside an OpenCode session. In this repo:

- `MAX_SAFE_TEST_FILES = 50` (`src/tools/test-runner.ts`). Resolutions exceeding this return `outcome: 'scope_exceeded'` with a SKIP. Do not lean on this — broad scopes can stall or kill OpenCode before that guard fires.
- For repo validation, run the shell commands in `contributing.md` / `TESTING.md` directly (per-file isolation loops + tier orchestration).
- `scope: 'all'` requires `allow_full_suite: true` and is intended for opt-in CI mirrors only. Default to `files: [...]` instead.

## The invariant-audit gate (PR-time)

Every PR that touches a relevant area must include an `## Invariant audit` section in its description. The format is in `AGENTS.md` ("Invariant audit required in PRs"). The `commit-pr` skill enforces this gate before push/PR — load it before committing.

If you cannot prove a touched invariant from source and test output, **do not push**.

## Init-path-safe imports (invariant 1 deep-dive)

The most expensive invariant-1 violations come from **transitive import chains** that silently load heavy modules (WASM, tree-sitter) at plugin init time. A single `import { X } from '../../lang'` in a tool-time module can transitively load `runtime.ts` → `web-tree-sitter` (heavy WASM), spiking init latency well past the repro-704 T1 deadline (observed during issue #1471 development).

### The lang barrel trap

`src/lang/index.ts` re-exports from `./runtime`, which statically imports `web-tree-sitter`. Importing **anything** from the barrel (`from '../../lang'`) transitively loads WASM at module-eval time.

**Wrong:** `import { LANGUAGE_REGISTRY } from '../../lang'` — loads runtime → web-tree-sitter.
**Right:** `import { LANGUAGE_REGISTRY } from '../../lang/profiles'` — loads only profiles (string data, no WASM).

### Type-only vs value imports

- `import type { Query } from 'web-tree-sitter'` — **safe** (erased at compile time, no module load).
- `import { Query } from 'web-tree-sitter'` — **unsafe** on the init path (loads the WASM module).
- For value dependencies on heavy modules in init-reachable code, use dynamic `import()` inside an async function (deferred to first call, not module load).

### The `--external` build flag

Dynamic `import('web-tree-sitter')` only defers loading at runtime if `--external web-tree-sitter` is set in the bun build config. Without it, bun bundles web-tree-sitter inline and the dynamic import resolves from the bundle (no deferral). Check `package.json` build scripts for the flag.

### Verification checklist

For any import-chain change touching `src/lang/`, `runtime`, or `web-tree-sitter`:
1. Trace the transitive chain from `src/index.ts` to verify no heavy module loads at init.
2. Rebuild dist: `bun run build` (stale dist gives false regressions).
3. Run `node scripts/repro-704.mjs` — T1 must be under 400ms.
4. Run `bun --smol test tests/unit/lang/symbol-graph-init-purity.test.ts` — init-path purity tests must pass.

## Tool version parity (local vs CI)

**Tool versions must match CI.** When `package.json` pins a tool version (e.g., `@biomejs/biome@2.3.14`, `@biomejs/biome@^2`, or any other versioned dev dependency), invoke it **with the pinned version** during local validation. Unversioned `bunx biome` resolves to a different version than the CI gate uses, and a CI-blocking failure can be invisible to local pre-commit validation.

Examples:
- Pinned biome: `bunx @biomejs/biome@<version> ci .` (substitute `<version>` from `package.json`).
- Unversioned `bunx biome ci .` resolves to whatever Bun's `bunx` registry returns at run time — historically 0.3.x vs the pinned 2.x.

The `commit-pr` skill Tier 1 - quality section pins the biome command to the package.json version; this is the canonical pattern for any tool where local and CI versions could diverge. Apply the same discipline to ESLint, Prettier, TypeScript, and any other versioned dev dependency.

**Why this matters:** PR #1503 (telemetry rotation fix) had a biome 2.3.14 `organizeImports` failure on the `./telemetry` import block that was invisible to local `bunx biome` (which resolved to 0.3.3 with no equivalent rule). The reviewer caught it from CI logs, not local validation. Pin tool versions to close the local/CI parity gap.

## Skill mirror contract

The cross-tree skill mirror contract is the authoritative registry at `src/config/skill-mirrors.ts`. If your PR modifies `.opencode/skills/<X>/SKILL.md` or `.claude/skills/<X>/SKILL.md`, consult that file to determine the contract kind for skill `<X>`:

- **`identical`:** `.opencode` and `.claude` SKILL.md must be byte-identical (the `canonical` field records which side wins when they drift). Update both trees byte-for-byte in the same commit. Verify with `bun run drift:check`. PR #1512 (lane-dispatch) introduced drift in council/deep-dive by only updating `.opencode` — a contract violation.
- **`divergent`:** both must exist but content intentionally differs per runtime. Examples: `engineering-conventions` is divergent (different frontmatter, different conventions per Claude Code vs OpenCode); `writing-tests` is divergent pending maintainer confirmation (#1497).
- **`opencode-only`:** `.opencode` exists; no `.claude` mirror expected. Examples: `loop` (would shadow Claude Code's built-in `/loop`), `running-tests` (OpenCode-runtime guidance).
- **Adapter shim pattern:** for architect MODE skills like `swarm-pr-review` and `swarm-pr-feedback`, the `.claude` and `.agents` files are thin adapter shims that delegate to the canonical `.opencode` file via `expectedCanonicalRef`. When updating these, the canonical content goes in `.opencode`; the adapter shim typically needs no change unless the cross-tree delegation interface changes.

**If your PR modifies a `.opencode/skills/<X>/SKILL.md` file:** check `src/config/skill-mirrors.ts` for the contract, then run `bun run drift:check` locally before pushing. Mirror drift is currently a soft-warn (`DRIFT_CHECK_ENFORCE=1` would make it hard-fail). The drift-check CI job surfaces drift as an issue comment, not a blocking check — but a drift between canonical and mirror means Claude Code agents reading the mirror get stale instructions.
