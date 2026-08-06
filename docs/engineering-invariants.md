# Engineering Invariants — opencode-swarm

> Long-form companion to `AGENTS.md`. `AGENTS.md` is the operational checklist; this document is the rationale, the historical failure map, and the worked examples. **`AGENTS.md` and `docs/engineering-invariants.md` together are the engineering source of truth for the repo.** When other docs conflict, this one wins.

## Why this document exists

opencode-swarm is an OpenCode plugin that ships as a single ESM bundle and runs across at least:

- Windows 11, macOS, Linux
- OpenCode TUI, OpenCode Desktop / GUI sidecar
- Bun-hosted plugin contexts and Node-hosted plugin contexts (the OpenCode plugin source explicitly handles `typeof Bun === 'undefined'`)
- Hosts with intermittent connectivity, antivirus interception, sandboxed exec, network home directories, and stale plugin caches

Every cross-platform regression we have shipped has a common shape: an assumption that worked on one host (usually macOS or Linux) silently broke on another. This document captures every such failure we have already paid for and the specific invariants that prevent the next instance.

The intent is not to be exhaustive about software engineering; it is to be exhaustive about **this repository's specific footguns**.

## Historical failure map

Each entry below points at a release note in `docs/releases/` and the invariant(s) it establishes.

### v6.48.0 — Tool registration gaps + ambiguous test_runner outcomes

- **Symptom:** six tools (`syntax_check`, `placeholder_scan`, `quality_budget`, `sast_scan`, `sbom_generate`, `build_check`) listed in tool-name and agent maps but absent from the plugin `tool: {}` block. Agents calling them got "tool not found." `test_runner` returned ambiguous error signals on zero-files and too-many-files paths, causing the architect to retry-loop.
- **Invariants established:** Tool addition is incomplete until exported, registered in the plugin block, listed in `TOOL_NAMES` (`src/tools/tool-names.ts`), mapped in `AGENT_TOOL_MAP` or a documented opt-in map, surfaced in help/docs, and covered by parity tests. `/swarm doctor tools` and registration-smoke/plugin-registration-adversarial tests enforce coherence. `test_runner` returns explicit `outcome: 'pass' | 'skip' | 'regression' | 'scope_exceeded' | 'error'` with `MAX_SAFE_TEST_FILES = 50`.
- **Maps to AGENTS.md:** invariants 6 (test_runner safety) and 11 (tool registration coherence).

### v6.80.2 — Cross-session global state, empty checkpoint commits

- **Symptom:** module-level `recentToolCalls` array shared across all sessions; spiral detection fired with `taskId='unknown'` and produced 2–XX empty `checkpoint: spiral-unknown-xxxx` commits.
- **Invariants established:** session-scoped behavior must be keyed by `sessionID`. Module-level global state needs explicit eviction (`MAX_TRACKED_SESSIONS = 500`, FIFO). Repeated safety/advisory behavior needs cooldowns (60 s for spiral detection). Fallback labels must be informative (`session-${sessionId.slice(0,12)}`).
- **Maps to AGENTS.md:** invariant 8 (session and global state).

### v6.82.2 — `.swarm/` created in subdirectories

- **Symptom:** despite v6.71.1 hardening, agents still produced `.swarm/` under project subdirectories because `save_plan` and `resolveWorkingDirectory` only validated path traversal and existence, not project-root anchoring.
- **Invariants established:** every `working_directory` argument must resolve to the project root. The shared helper enforces this for all six callers (`save_plan`, `completion_verify`, `check-gate-status`, `convene-council`, `declare-council-criteria`, `phase-complete`, `test-runner`). `process.cwd()` fallbacks must be removed from runtime metrics paths and replaced with explicit `ctx.directory` propagation.
- **Maps to AGENTS.md:** invariant 4 (working directory and `.swarm/` containment).

### Issue #922 Phase 1 — `validateProjectRoot` depth-bounded walk with project indicators

- **Symptom:** `validateProjectRoot` in `src/evidence/manager.ts` performed an unbounded parent-directory walk with no depth limit, risking unbounded filesystem traversal on deep directory trees.
- **Fix applied:**
  - Added `MAX_DEPTH = 20` constant bounding the parent walk
  - Added `PROJECT_INDICATORS` array (11 items): `package.json`, `.git`, `.opencode`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`, `CMakeLists.txt`
  - Stray `.swarm/` directories without a coexisting project indicator are ignored (fail-open at depth limit)
  - Fail-closed on non-ENOENT indicator errors (EPERM, EBUSY → assume indicator present)
  - `realpathSync` for junction/symlink resolution
- **Invariant established:** `validateProjectRoot` prevents unbounded traversal while distinguishing genuine parent projects (`.swarm/` + project indicator) from stray artifacts (`.swarm/` alone). Depth limit is fail-open; indicator errors are fail-closed.
- **Maps to AGENTS.md:** invariant 4 (working directory and `.swarm/` containment).

### Issue #922 Phase 2 — Extended `.swarm/` containment to remaining tools

- **Symptom:** five tools (`test-impact`, `mutation-test`, `diff-summary`, `update-task-status`, `declare-scope`) still contained `process.cwd()` fallbacks or lacked subdirectory containment guards, allowing `.swarm/` creation in subdirectories when those tools were invoked from non-project-root contexts.
- **Fix applied:**
  - `update-task-status` — added subdirectory containment guard with `realpathSync` canonicalization; removed any `process.cwd()` fallback
  - `declare-scope` — removed `process.cwd()` fallback; throws explicit error when directory cannot be resolved to project root
  - `mutation-test` + `diff-summary` — `resolveWorkingDirectory` replaces triple-fallback chains
  - `test-impact` — `resolveWorkingDirectory` at tool entry; absolute-path guards in `analyzer.ts` and `history-store.ts`
- **Invariant established:** all tools that may write runtime state under `.swarm/` must route through `resolveWorkingDirectory` (not `process.cwd()`) and enforce project-root anchoring. `realpathSync` canonicalization is required on platforms where symlinks may cause apparent project-root mismatch.
- **Maps to AGENTS.md:** invariant 4 (working directory and `.swarm/` containment).

### v6.85.1 — Multiple system messages crashing local models

- **Symptom:** Qwen3.6 / Gemma require exactly one `{ role: 'system' }` message at index 0; the swarm hook appended multiple `output.system` entries, each materialized into a separate system message; local models crashed or silently degraded.
- **Invariants established:** after swarm augmentation, collapse `output.system` to a single entry inside `experimental.chat.system.transform` (the only point that runs after swarm injection but before OpenCode materialization). Cloud models that accept multiple system messages are unaffected because the collapse is only triggered when length > 1.
- **Maps to AGENTS.md:** invariant 10 (chat/system message contract).

### v6.86.8 — `bun:sqlite` top-level import broke Node ESM hosts

- **Symptom:** the published `dist/index.js` contained a top-level `import { Database } from "bun:sqlite"`. Node's ESM resolver throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` before any plugin code runs; OpenCode silently dropped the plugin (sidebar entry, zero agents).
- **Invariants established:** the main bundle is built with `--target node`. SQLite (and any other Bun-only module) is loaded lazily via `createRequire(import.meta.url)('bun:sqlite')` at call time. CI guards: `bundle-portability.test.ts` (no top-level `bun:` imports) and `bundle-node-load.test.ts` (`node --input-type=module -e "await import('./dist/index.js')"`).
- **Maps to AGENTS.md:** invariant 2 (runtime portability).

### Issue #1873 — lazy `bun:sqlite` require had no Node fallback (Electron sidecar)

- **Symptom:** the v6.86.8 fix moved SQLite resolution to a lazy `createRequire(import.meta.url)('bun:sqlite')`, which cleared the top-level-import guard but still assumed a Bun runtime *at call time*. OpenCode Desktop loads the plugin in a **Node.js** Electron `utilityProcess` sidecar, where `bun:sqlite` does not exist — so every SQLite-backed tool (`swarm_memory_recall`, the QA-gate tools, `get_approved_plan`) threw `Cannot find module 'bun:sqlite'`. Three duplicated `loadDatabaseCtor()` helpers each had the same no-fallback require.
- **Fix applied:** a single runtime-portable loader `src/db/sqlite-loader.ts`. It returns native `bun:sqlite` under Bun (byte-identical), and under Node wraps `node:sqlite`'s `DatabaseSync` in an adapter presenting the exact `bun:sqlite` `Database` subset the code uses (`run`, `query→{get,all,iterate}`, `transaction` (BEGIN/COMMIT/ROLLBACK + SAVEPOINT nesting, returns the callback value), `inTransaction`→`isTransaction`, `loadExtension`, `close`); if neither driver resolves it throws one combined diagnostic. The three call sites now import it. **Sub-bug:** `node:sqlite` is stricter than `bun:sqlite` — it rejects a bound parameter when the SQL has no placeholder (`SQLITE_RANGE`), which broke three memory-provider meta lookups that hard-coded a key literal while passing a redundant param; those were parameterized (`WHERE key = ?`).
- **Invariants established:** all `bun:`-scheme *runtime* module resolution routes through a single Node-fallback-providing loader; `import type` (erased) is the only other permitted `bun:` reference in source. Guards: `bundle-portability.test.ts` (source scan for un-fenced `bun:` runtime resolution + a bundle `bun:sqlite`↔`node:sqlite` pairing check) and `scripts/repro-1873.mjs` (merge-queue-gated CI `smoke` job, drives the real DB + memory provider under Node via `actions/setup-node`). Keep every query's parameter count exactly equal to its placeholder count.
- **Maps to AGENTS.md:** invariant 2 (runtime portability); test guards under invariant 7.

### v6.86.9 — OpenCode v1 plugin export shape + cache layouts

- **Symptom:** v6.86.8 still didn't load. Second root cause: `readV1Plugin` requires `mod.default` to be an **object** with at least one of `{ id, server, tui }`. The bundle's default export was a bare async function; `readV1Plugin` returned `undefined`, OpenCode fell through to `getLegacyPlugins`, which iterated `Object.values(mod)` and threw `TypeError` on the `deferredWarnings` array re-export — silently dropping the plugin again. Also: the `update` command only cleared two of three known cache layouts.
- **Invariants established:** default export is `{ id: 'opencode-swarm', server: OpenCodeSwarm }`. CI guard: `bundle-plugin-shape.test.ts` simulates both loader paths. Cache-eviction covers all three known layouts (`~/.cache/opencode/packages/opencode-swarm@latest`, `~/.config/opencode/node_modules/opencode-swarm`, `~/.cache/opencode/node_modules/opencode-swarm`). Cache-path safety uses four checks: catastrophic-floor exclusion, depth ≥ 4, recognized leaf, canonical structure.
- **Maps to AGENTS.md:** invariants 2 (runtime portability) and 12 (release/cache hygiene).

### v6.86.14 — Transient errors tripping the circuit breaker

- **Symptom:** a single 429/503/529/timeout would exhaust model fallback and start counting toward `consecutiveErrors`; five total errors → circuit breaker hard stop. Agents could not recover from short outages.
- **Invariants established:** distinguish transient infrastructure/provider errors from agent logic errors. `transientRetryCount` (default budget 5) is independent of `consecutiveErrors` and resets per invocation. Transient retry and model fallback are independent.
- **Maps to AGENTS.md:** invariant 9 (guardrails / retry semantics).

### Issue #1875 — non-transient retry loops + unbound write scope

- **Symptom:** proven parser, command-not-found, sandbox-wrapper, and repeated permanent failures could be retried indefinitely, while a coder delegation with empty, stale, v1, or identity-mismatched scope could reach child-state publication without an exact active authorization binding.
- **Invariants established:** non-transient circuit state is owned by the active agent invocation and never persisted. `shell_parse_error`, `command_not_found`, and `sandbox_wrapper_failure` hard-stop on the first classified failure; only `general_permanent` uses the three-consecutive-same-category threshold. Successful, neutral, degraded, or transient outcomes may clear an open streak but never a hard stop. The false-to-true transition emits `telemetry.loopDetected` and exactly one `NON-TRANSIENT STOP` advisory; after that transition, agents must stop tool calls and report the blocker until a verified new invocation or session reset. Write-capable coder delegation requires an exact active v2 scope binding correlated to the current session and Task call; empty scope, v1 fallback, stale plan/task identity, or another session's declaration fails closed with `SCOPE_NOT_DECLARED`, before child state is published.
- **Maps to AGENTS.md:** invariants 5 (plan durability), 8 (session state), and 9 (guardrails / retry semantics).

### v7.0.1 — `SWARM_PLAN` relocation + cache eviction completeness

- **Symptom:** runtime artifacts at the project root caused git pollution; OpenCode users on Windows / macOS still couldn't update because lock files (`bun.lock`, `bun.lockb`, `package-lock.json`) prevented re-resolution.
- **Invariants established:** `SWARM_PLAN.{json,md}` lives under `.swarm/`. Lock-file eviction covers all known names with a four-layer safety check. `update` and `install` both perform eviction.
- **Maps to AGENTS.md:** invariants 4 (.swarm/ containment) and 12 (release/cache hygiene).

### v7.0.3 — OpenCode Desktop loading-screen hang (`#704`)

- **Symptom:** plugin init blocked the event loop. JavaScript executes async function bodies synchronously up to the first `await`; the recursive `readdir`/`statSync` walk in `repoGraphHook.init()` ran inline; OpenCode's `await server(...)` never resolved and Desktop displayed a frozen splash screen forever. Aggravating factors: symlink cycles in `findSourceFiles`, late `maxFiles` cap, direct `Bun.*` calls throwing under Node.
- **Invariants established:** plugin init must be fast, bounded, and side-effect minimal. Yield to the event loop before doing any work. Register detached init work in the wrapper-owned post-resolution task queue and retain a watchdog (`unref`'d 30 s) for repo-graph startup. `withTimeout` (5 s) protects snapshot loads. Symlink cycles must be detected with `realpathSync`/`realpath` and a `seenRealPaths` set. `maxFiles` is enforced inside the traversal loop. All `Bun.*` calls go through `src/utils/bun-compat.ts`.
- **Maps to AGENTS.md:** invariants 1 (plugin init), 2 (runtime portability), 3 (subprocesses).

### Issue #1231 Phase 3 — Structural debt: delegation-gate split + Lean Turbo behavioral tests

- **Symptom:** `delegation-gate.test.ts` (2835 lines) was a monolithic test file that caused mock isolation issues, slow CI runs, and made parallel lane execution (FR-009) untestable due to missing DI seams.
- **Fix applied:**
  - Split `delegation-gate.test.ts` into 45 focused files (all <500 lines, FR-006 SC-006.1)
  - Created `tests/unit/commands/sync-plan.test.ts` (10 tests, FR-007)
  - Parameterized `tests/unit/agents/sme.test.ts` (24 tests, 75% parameterized, FR-008)
  - Created 7 Lean Turbo behavioral test files for FR-009 (100 tests total)
- **Invariants established:** test files must stay under 500 lines; monolithic files must be split by behavioral aspect; Lean Turbo requires DI seams (`src/parallel/file-locks.ts:_internals`) for testability.
- **Maps to AGENTS.md:** invariant 7 (test writing).

### Issue #1231 Phase 4 — vitest→bun:test + hook coverage completion

- **Symptom:** vitest remained in 50+ test files across 11 directories despite AGENTS.md requiring `bun:test`; 9 previously untested hooks lacked test coverage (FR-010/011/012).
- **Fix applied:**
  - Converted 50+ files from vitest to bun:test across 11 directories (cli, services, session, evidence, commands, build, lang, scripts, config, knowledge, context-map, hooks, tools)
  - Created 11 new test files for 9 previously untested hooks: `conflict-resolution`, `curator-types` (3 files), `delegate-ack-collector`, `delegate-directive-injection` (2 files + fixtures), `knowledge-reinforcement`, `normalize-tool-name`, `phase-complete-directive-gate`, `phase-directives`, `semantic-diff-injection`
  - Consolidated knowledge-curator tests with shared fixture `curator-test-fixtures.ts`
  - Replaced `jest.fn()` with `mock()` in 7 files
  - Fixed `RankedEntry` broken import path
  - Rewrote `check-mock-cleanup.test.ts` to TypeScript for cross-platform compatibility
  - Fixed delegation-gate task isolation
- **Invariants established:** all tests use `bun:test` exclusively; `mock.module` calls must spread real exports; test files stay under 500 lines; fixture files consolidate shared setup.
- **Maps to AGENTS.md:** invariant 7 (test writing).

### v7.3.3 — Git hygiene runs on the init path without bounds

- **Symptom:** `ensureSwarmGitExcluded` correctly fixed `.swarm/` Git pollution but did so by `await`ing four sequential `git` subprocess calls on the plugin-init critical path with **no** outer `withTimeout` and **no** per-call `timeout` / `stdin: 'ignore'` / `proc.kill()`. On hosts where any one git child fails to exit promptly (Windows antivirus interception, credential helper prompts, NFS-stalled `.git`, Bun-on-Windows stdin pipe semantics) the plugin entry never resolved; OpenCode silently dropped the plugin; users saw "no agents in TUI/GUI" with no error.
- **Invariants established (THIS PR):** every awaited operation on the init path must be bounded by `withTimeout` (or equivalent) AND fail open. Every subprocess on the init path must have explicit `cwd`, `stdin: 'ignore'`, `timeout`, bounded stdout/stderr, and `proc.kill()` in `finally`. The same hardening applies to the secondary defect site `validateDiffScope` even though it is not on the init path. Tests use a file-scoped `_internals` DI seam — not `mock.module` — to avoid Bun's cross-file mock leakage.
- **Maps to AGENTS.md:** invariants 1 (plugin init), 3 (subprocesses), 7 (test writing).

### PR #1356 — `withTimeout`-bounded work is still on the critical path if you `await` it

- **Context:** PR #1356 added an init-time step that materializes allowlisted bundled mode-skill directories into a fresh project so the architect does not hit missing `SKILL.md` files on turn one. The current form is the **correct** pattern — registered in the wrapper-owned post-resolution task queue, `withTimeout`-bounded, fail-open, content-aware with atomic replacement, byte/file-bounded, and confined to `.swarm/bundled-skills` (`src/index.ts`). It is cited here as an exemplar, not a regression.
- **The lesson (recorded in the in-code comment near the bundled-skill registration in `src/index.ts`):** during development an earlier revision **`await`ed the sync inline** on the `server()`-resolution path. That version was still `withTimeout`-bounded and fail-open, yet the ~20 sequential `fsp.*` calls' real latency on a **cold Windows filesystem pushed `server()` past the `repro-704` T1 deadline** (`TIMING_DEADLINE_MS = 400` in `scripts/repro-704.mjs:42`). It was first corrected to `queueMicrotask` deferral before merge, then hardened after PR #1920's merge-queue smoke failure showed that a microtask scheduled inside an async initializer can start during that initializer's later awaits. The wrapper now starts the work from an unref'd timer only after `initializeOpenCodeSwarm` resolves. (No separate broken commit exists for the inline-await form — it was fixed pre-merge; the authority for that lesson is the in-code comment, not a CI artifact. Exact failing/passing millisecond figures were not recorded.)
- **Root cause of the inline-await and microtask missteps:** treating `withTimeout` as if it makes work free, then treating `queueMicrotask` as if it waits for the enclosing async function. `withTimeout` is `Promise.race` against an (unref'd) timer (`src/utils/timeout.ts`) — it only protects against an *unbounded* await; it does nothing to remove awaited work's actual latency. A microtask runs at the next await boundary, so it can still overlap unresolved initialization. The wrapper-owned post-resolution task queue removes both hazards.
- **Invariants established:** **Bounded ≠ free.** Decide await-vs-defer explicitly for every init step:
  - **Defer via the wrapper-owned post-resolution task queue** when the work does non-trivial I/O and **nothing downstream in `initializeOpenCodeSwarm` depends on its completion before `server()` resolves**. Do not use `queueMicrotask` inside the initializer: a later `await` lets that microtask run while `server()` remains unresolved. The wrapper schedules registered tasks from an unref'd timer after the initializer resolves, before any realistic user turn. This is the `repoGraphHook` precedent and what bundled-skill sync follows.
  - **`await` (still `withTimeout`-bounded + fail-open)** only when the work is genuinely fast (<~50 ms typical) **and** must complete before a later init step — e.g. `ensureSwarmGitExcluded` (`src/index.ts:356`) must run before `.swarm/` artifacts are written.
  - **Cross-platform proof is mandatory.** Linux/macOS `repro-704` passing does **not** prove Windows; cold-FS op latency is several× higher there. The T1 400 ms assertion (`scripts/repro-704.mjs:42`) runs on the Windows runner in the `smoke` matrix (`.github/workflows/ci.yml`); the CI step's summary comment mentions the looser 10 s `BUDGET_MS` (T2/T3), but T1 is the tight bound that catches this class of regression. Green locally is necessary, not sufficient.
- **Maps to AGENTS.md:** invariant 1 (plugin init).

### Issue #2029 — No canonical observability event contract; a type-system bypass reached production

- **Symptom:** every observability producer independently invented its record
  shape, discriminator key, clock representation, and correlation-ID set, with
  no shared definition of what an observation is. `.swarm/events.jsonl` is
  written under **two different discriminator keys within a single file**
  (`src/context/role-filter.ts:147` and `src/tools/phase-complete.ts:1571` write `event:`; `src/hooks/curator.ts:1755` and `src/hooks/full-auto-intercept.ts:269` write `type:`; `src/hooks/curator.ts:1185` comments on the split). Eight of ten named legacy stores carry no schema version at all.
  `background-delegations.jsonl` stores epoch-ms numbers while every other
  inventoried store uses ISO-8601 strings, with no shared clock definition
  bridging them. Separately, and more sharply: `agent_conflict_detected` was
  emitted in production via `'agent_conflict_detected' as
  Parameters<typeof emit>[0]` — a force-cast past the `TelemetryEvent` union
  (`src/hooks/conflict-resolution.ts:67-70`) — so a new event kind entered the
  stream with zero registration, and the type system did not catch it because
  the cast defeated it by construction.
- **Fix applied:** a new `src/observability/` module (no filesystem, network,
  subprocess, or OTel SDK dependency) defining: a canonical zod-typed
  `ObservabilityEvent` envelope (`envelope.ts`) with a stable identity, an
  explicit occurred/observed clock pair, W3C-compatible trace context, and
  thirteen optional (never synthesized) workflow correlation IDs; a
  33-entry `EVENT_CATALOG` (`catalog.ts`) covering every `TelemetryEvent`
  member plus the previously-uncatalogued `agent_conflict_detected`, each
  entry naming a real producer `file:line`, a live consumer or a
  `futureOwnerIssue`, a privacy class, a retention owner, and a doc anchor;
  `relationships.ts` validating required/forbidden workflow IDs and
  parent/link shape without ever throwing; a legacy adapter (`legacy.ts`)
  that projects the untyped payload `emit()` already receives onto the
  contract while preserving unknown fields, recording `unknown ≠ 0`, and
  never synthesizing a missing correlation ID. The force-cast at
  `conflict-resolution.ts:67-70` is removed in favor of a plain typed
  `emit(...)` call, with `agent_conflict_detected` added to both
  `TelemetryEvent` and the catalog. `src/telemetry.ts:emit()` now builds a
  canonical event and derives the written `.swarm/telemetry.jsonl` line from
  it as a documented lossy projection (`toLegacyTelemetryLine`) — output is
  byte-identical to before this change, verified against a checked-in golden
  corpus captured from the unmodified tree at `e50386b9`. **One documented
  exception:** a payload carrying an own *accessor* (getter) property is read
  more than once on the new path (`extractWorkflowIds`, `extractOutcome` and
  the adapter's shallow key scan all read own keys before the spread), whereas
  the old inline construction read each key exactly once at spread time. For a
  side-effecting or counter-style getter the emitted value therefore differs.
  No `emit()` call site in the repo passes an own accessor property (prototype
  getters are unaffected — they are not own-enumerable and never reached the
  spread on either path), so this is not reachable today; it is recorded
  because the byte-preservation guarantee is otherwise stated absolutely.
  A blocking CI check (`scripts/check-event-contract.ts`, `bun run
  check:events`) fails on catalog↔union drift, an incomplete catalog entry,
  an unowned empty consumer list, or a metric label outside the bounded
  allowlist. The envelope's non-legacy fields (`eventId`, `trace`, `lineage`,
  `provenance`, `policy`, `writerSequence`, `relationshipViolations`) are
  **currently discarded** after the legacy line is written — documented as
  the honesty clause in `docs/observability-event-contract.md` §2, with a
  named future consumer (#2047). This PR does not add a new sink, an OTLp
  network path, a SQLite query index, or replace any authoritative
  plan/scope/evidence/knowledge-receipt/background-ownership/council state —
  those are owned by the remaining PRs in the #2029–#2051 sequence.
- **Invariant(s) established:** every telemetry event kind must have a
  catalog entry with a real producer `file:line`, a consumer or a named
  future-owner issue, a privacy class, a doc anchor, and a test — an event
  kind with no catalog entry, or a catalog entry with an empty consumer list
  and no owner, is a contract violation caught by CI, not a shrug. A cast
  that bypasses `TelemetryEvent` (or, going forward, `EVENT_CATALOG`) to
  reach `emit()` is a contract violation of the same class regardless of
  whether it currently type-checks. An ID a producer does not genuinely hold
  stays `undefined` — never `''`, never synthesized to make a join succeed —
  and a field a legacy record does not version stays `null` (unknown), never
  defaulted to `0`.
- **Maps to AGENTS.md:** invariants 1 (plugin init — `initObservability`
  performs zero I/O and never throws on the init path), 2 (runtime
  portability — `node:crypto`/`zod` only, no `bun:` anywhere in the module),
  7 (test writing — the golden-corpus emit-line-parity test and the
  catalog-contract test), and 11 (tool/registration coherence — the same
  registry-completeness discipline `check-tool-registration.ts` enforces for
  tools now applies to event kinds via `check-event-contract.ts`).

## Invariants — anti-pattern, required pattern, verification

### Skill ownership and audience routing

- **Native roots are project-owned by the bundled-protocol installer.** Plugin-shipped protocols are never materialized into `.opencode/skills`, `.claude/skills`, or `.agents/skills`; they live under the Git-excluded `.swarm/bundled-skills/<slug>/` runtime root, so a repository may use the same slug without data loss or native skill-name collision. This does not change the separate, user-authorized generated-skill workflow, which promotes reviewed project skills into `.opencode/skills/generated/`.
- **MODE dispatch is explicit.** Architect MODE stubs and bundled cross-protocol references resolve the private runtime copy through the shared bundled-skill path helper. Generic skill propagation continues to discover project-owned roots only.
- **Audience metadata is bounded.** Static skills declare a top-level `audience`; parser input remains capped by the existing 16 KiB frontmatter read and audience values are additionally capped at 16 tokens of 64 characters. Absent means legacy match-all; explicit invalid metadata fails closed.
- **Dimensions are conjunctive.** Domain tags are ORed with domain tags, runner tags are ORed with runner tags, and domain/runner dimensions are ANDed. Repository audiences come from explicit `skillPropagation.audiences`, never arbitrary swarm names.
- **Explicit loads are integrity-checked.** An architect-provided `SKILLS:` path must be a readable, valid, contained SKILL.md whose audience matches. This mandatory validation remains active when optional propagation recommendations are disabled. `SKILLS_USED_BY_CODER` is provenance only and cannot authorize a load.

**Verification:** bundled sync coexistence/concurrency tests, audience parser/config tests, explicit-route and companion-route tests, MODE/dependency path audits, package smoke, `repro-704`, and Node ESM import.

### 1. Plugin initialization

**Anti-pattern (the v7.3.3 regression):**

```ts
// src/index.ts inside initializeOpenCodeSwarm
await ensureSwarmGitExcluded(ctx.directory, { quiet: config.quiet });
//   ^^^^ no withTimeout — if this never resolves, no agents are registered
```

**Required pattern:**

```ts
import { withTimeout } from './utils/timeout';
import {
  ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
  ensureSwarmGitExcluded,
} from './utils/gitignore-warning';

await withTimeout(
  ensureSwarmGitExcluded(ctx.directory, { quiet: config.quiet }),
  ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
  new Error(
    `ensureSwarmGitExcluded exceeded ${ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS}ms budget; continuing without git-hygiene check`,
  ),
).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log('ensureSwarmGitExcluded timed out or failed (non-fatal)', { error: msg });
});
```

`await` is correct *here* because the exclude write must finish before `.swarm/`
artifacts are created and the git calls are fast (<~50 ms). It is **wrong** for
I/O-heavy work with no such ordering dependency — see below.

**Required pattern (deferred — when nothing downstream needs the result before `server()` resolves):**

```ts
// src/index.ts inside initializeOpenCodeSwarm — see the repoGraphHook precedent.
// `withTimeout` only bounds a HANG; an awaited copy of 20 skill dirs still adds
// its real latency to server(). An inline-await revision of this sync (corrected
// before PR #1356 merged) pushed server() past the 400ms repro-704 T1 deadline on
// a cold Windows FS; deferring moves the latency off the critical path. Runtime
// consumers normally observe the completed task, and command paths retain their
// own backstops, but promise reactions are not ordered behind the timer.
postResolutionTasks.push(() => {
  void withTimeout(
    syncBundledProjectSkillsIfMissingAsync(ctx.directory, PACKAGE_ROOT, config.quiet),
    SYNC_BUNDLED_SKILLS_TIMEOUT_MS,
    new Error('skill sync exceeded budget; command-path sync remains a backstop'),
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log('bundled skill materialization timed out or failed (non-fatal)', { error: msg });
  });
});
```

**Decision rule:** `await` init work only when it is fast (<~50 ms) *and* a later
init step depends on it; otherwise register it in the wrapper-owned
post-resolution task queue. Do not use an initializer-local `queueMicrotask` as
a substitute. `withTimeout` wraps both paths — it bounds hangs, it does not erase
latency.

**Verification:**

- `bun run build` then `node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"` exits 0.
- `node scripts/repro-704.mjs` passes on every supported platform — T1 asserts `server()` resolves within `TIMING_DEADLINE_MS = 400` (`scripts/repro-704.mjs:42`). **Linux/macOS green does not prove Windows**; the `smoke` job runs `repro-704` on the Windows runner, where cold-FS op latency is several× higher — exactly the gap that caught an inline-await revision of the bundled-skill sync during PR #1356's development before it was deferred.
- A regression test (or dedicated harness) exercises the failing-environmental-call path and asserts plugin init still resolves bounded.

### 2. Runtime portability

**Anti-pattern (the v6.86.8 regression):**

```ts
// src/db/project-db.ts at module top level
import { Database } from 'bun:sqlite';
// ESM hoists this — Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME before any plugin code runs.
```

**Required pattern:**

```ts
import { createRequire } from 'node:module';

let _Database: typeof import('bun:sqlite').Database | undefined;
function getDatabase() {
  if (!_Database) {
    const req = createRequire(import.meta.url);
    _Database = req('bun:sqlite').Database;
  }
  return _Database;
}
```

**Verification:**

- `tests/unit/build/bundle-portability.test.ts` scans `dist/index.js` for top-level `bun:` imports.
- `tests/unit/build/bundle-node-load.test.ts` spawns `node --input-type=module` to load the bundle.
- `tests/unit/build/bundle-plugin-shape.test.ts` simulates `readV1Plugin` and `getLegacyPlugins`.

### 3. Subprocesses

**Anti-pattern (the v7.3.3 spawn shape):**

```ts
const proc = bunSpawn(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
  stdout: 'pipe',
  stderr: 'pipe',
});
const [exit, out] = await Promise.all([proc.exited, proc.stdout.text()]);
// ^ no timeout, no stdin: 'ignore', no kill in finally
```

**Required pattern:**

```ts
const proc = bunSpawn(['git', '-C', dir, 'rev-parse', '--show-toplevel'], {
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
});
let exit: number;
let out: string;
try {
  [exit, out] = await Promise.all([proc.exited, proc.stdout.text()]);
} finally {
  try { proc.kill(); } catch { /* already exited */ }
}
```

**Verification:**

- `grep -n "bunSpawn\\|spawn(\\|spawnSync(" src/<changed>/*.ts` — every match has `timeout`, `stdin: 'ignore'` (unless intentionally interactive), `cwd` or `git -C <directory>`, and a `kill()` in the cleanup path.
- A test mocks the spawn function (via the file-scoped `_internals` seam, not `mock.module`) to never resolve and asserts the call returns within bounded time.

### 4. Working directory and `.swarm/` containment

**Anti-pattern:**

```ts
// metrics-collector.ts
const root = process.cwd();
fs.mkdirSync(path.join(root, '.swarm', 'metrics'), { recursive: true });
```

**Required pattern:**

```ts
export const collectMetricsTool = createSwarmTool({
  // ...
  execute: async (args, directory /* injected from ctx.directory */) => {
    const root = directory; // never process.cwd()
    fs.mkdirSync(path.join(root, '.swarm', 'metrics'), { recursive: true });
  },
});
```

For tools that accept a user-supplied `working_directory`, anchor to project root:

```ts
const resolved = resolveWorkingDirectory(args.working_directory, ctx.directory);
if (!resolved) return { success: false, error: 'working_directory must resolve to project root' };
```

**Verification:**

- `grep -rn "process.cwd()" src/tools src/hooks` — every remaining match has a comment justifying it as a documented direct-CLI/test fallback.

**Evidence trust boundary:** Runtime JSON under `.swarm/`, including
`.swarm/evidence/{taskId}.json`, is durable audit and recovery state for
cooperative agents running as the same OS user. Evidence writes are atomic and
path-safe, but workspace files are not tamper-proof authorization records: a
process with the same user's filesystem access can replace them. Treat gate
evidence as trustworthy only within that cooperative-agent threat model. Strong
integrity against a same-user adversarial process would require a protected
trust root outside the workspace.

**Session-reset worktree resilience (FR-004):** `.swarm-worktrees/` directories created by parallel lanes must be reconciled on session resume/reset. `provisionWorktree` in `src/worktree/core.ts` implements idempotent provisioning: if a branch exists but is not checked out in any active worktree, it is adopted; if it is active elsewhere, an error is returned. `reset-session.ts` wipes `.swarm-worktrees/` and orphan branches. The resume skill explicitly calls out reconciliation as the first step. This prevents stale worktrees from causing provisioning failures or silent git state corruption when a session resumes after reset.

**Anti-pattern:**

```ts
// directly write JSON to plan.json bypassing the ledger
fs.writeFileSync('.swarm/plan.json', JSON.stringify(newPlan));
```

**Required pattern:**

```ts
appendLedgerEvent({ type: 'plan-updated', payload: { ... } });
// the ledger replay produces plan.json + plan.md as projections
```

**Verification:**

- `tests/unit/plan/*.test.ts` — replay round-trip + projection tests.
- `docs/plan-durability.md` is updated when the schema changes.

**Settled-task re-open guard (FR-005):** `update_task_status` (and the automated delegation path via `advanceTaskStateAndPersist`) must not silently re-open a settled task (`completed` / `blocked` / `closed`) to `in_progress`. `src/plan/manager.ts` implements a three-layer guard: the tool layer (`src/tools/update-task-status.ts`), the manager layer (`updateTaskStatus`), and the automated path all check the current task state before allowing `in_progress` transitions. An explicit `force: true` option permits manual repair. This prevents a session restart from silently overwriting completed work with a fresh `in_progress` state.

### 6. test_runner safety

**Anti-pattern:**

```ts
test_runner({ scope: 'all' }); // blocked unless SWARM_ALLOW_FULL_SUITE=1 is set
// or: scope: 'graph' on a 10k-file repo without explicit files
```

**Required pattern (interactive validation):**

```bash
# from contributing.md / TESTING.md
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
bun --smol test tests/unit/cli tests/unit/commands tests/unit/config --timeout 120000
```

**Required pattern (targeted agent validation via test_runner):**

```ts
test_runner({ files: ['tests/unit/foo.test.ts'] });
```

**Verification:**

- For repo validation, do not invoke `test_runner` at all in this repo. Use shell.
- For agent validation, the call must use `files: [...]` or a small targeted scope; `MAX_SAFE_TEST_FILES = 50` will SKIP otherwise (this is fail-safe, not a guarantee — do not lean on it).

### 7. Test writing

**Anti-pattern (cross-file mock leak):**

```ts
// in tests/foo-bounded.test.ts
await mock.module('../src/utils/bun-compat', () => ({ bunSpawn: stub }));
// leaks into every other test file in the same Bun process
```

**Anti-pattern (node:* mock without spread):**

```ts
// in tests/foo.test.ts
mock.module('node:fs', () => ({
  readFileSync: mockFn, // missing ...realFs spread — pollutes other tests
}));
```

**Required pattern (file-scoped DI seam):**

```ts
// in src/utils/gitignore-warning.ts
import { bunSpawn } from './bun-compat';
export const _internals: { bunSpawn: typeof bunSpawn } = { bunSpawn };
// production code calls `_internals.bunSpawn(...)`

// in tests/foo-bounded.test.ts
import { _internals } from '../src/utils/gitignore-warning';
const real = _internals.bunSpawn;
afterEach(() => { _internals.bunSpawn = real; });
test('...', () => {
  _internals.bunSpawn = stub as unknown as typeof real;
  // assertions
});
```

**Required pattern (spread-real-exports for node:\* mocks):**

```ts
// in tests/foo.test.ts
import * as realFs from 'node:fs';
const mockReadFileSync = mock(() => '');
mock.module('node:fs', () => ({
  ...realFs,                    // mandatory — preserves all other exports
  readFileSync: mockReadFileSync, // override only what you need
}));
```

**Current `_internals` seams (Phase 2 additions in bold, Phase 3 additions in *italic*, Phase 4 additions in **double-italic**):**

| Module | Exposed for testing | Use case |
|---|---|---|
| `src/utils/gitignore-warning.ts` | `bunSpawn` | bounded subprocess tests |
| `src/hooks/diff-scope.ts` | `bunSpawn` | diff-scope bounded tests |
| `src/hooks/knowledge-migrator.ts` | `writeSentinel`, `mkdir`, `writeFile`, `existsSync`, `readFileSync`, `readFile` | FR-005 evidence-spoofing tests |
| **`src/evidence/manager.ts`** | **`validateEvidence`** | FR-005 evidence integrity tests |
| `src/hooks/guardrails/index.ts` | guardrail hook internals | FR-004 adversarial tests |
| `src/hooks/curator.ts` | curator internals | curator phase tests |
| *`src/hooks/guardrails/index.ts`* | *guardrail internals* | *FR-009 Lean Turbo behavioral tests* |
| *`src/parallel/file-locks.ts`* | *acquireLaneLocks, releaseLaneLocks* | *FR-009 acquire-locks behavioral tests* |
| **`src/hooks/delegate-ack-collector.ts`** | **delegate ack internals** | **FR-011 delegate-ack-collector hook tests** |
| **`src/hooks/delegate-directive-injection.ts`** | **delegate directive injection internals** | **FR-011 delegate-directive-injection hook tests** |
| **`src/hooks/knowledge-reinforcement.ts`** | **knowledge-reinforcement internals** | **FR-011 knowledge-reinforcement hook tests** |
| **`src/utils/bun-compat.ts`** | **`mergeEnvForChild`** | **FR-202 spawn env-override helper** |
| **`src/sandbox/executor.ts`** | **`isValidEnvKey`** | **FR-203 sandbox key validation** |
| **`src/worktree/core.ts`** | **`removeLaneProfileFromDisk`, `writeLaneProfileToDisk`** | **FR-201 + FR-205 lane profile materialization + teardown** |
| `src/services/recommendation-ledger.ts` | `now`, `transactFile`, `readLedgerStrict`, `resolveRecommendationLedgerPath` | #1821 AC21 dedup-ledger clock + fail-open path tests |
| `src/services/trajectory-cluster.ts` | `now`, `checkRecommendations`, `recordEmittedRecommendations` | #1821 AC21 motif-emission dedup tests |

**Delegation-gate split pattern (FR-006 SC-006.1):**

`tests/unit/agents/delegation-gate.test.ts` (2835 lines) was split into 45 focused files, each under 500 lines:

```
tests/unit/agents/delegation-gate/
  delegation-gate-authority.test.ts        # primary agent authority
  delegation-gate-session-keying.test.ts   # sessionID-based isolation
  delegation-gate-cooldown.test.ts        # spiral-detection cooldown
  delegation-gate-circuit-breaker.test.ts # consecutiveErrors accounting
  ... (41 more focused files)
```

Split criteria: one behavioral aspect per file, shared test utilities extracted to `tests/unit/agents/delegation-gate/_fixtures.ts`.

**Verification:**

- Run `scripts/check-mock-cleanup.sh` — it enforces Check 2: every `mock.module('node:*', ...)` must spread real exports (e.g., `...realFs`, `...realChildProcess`).
- Run `scripts/check-invariants.sh` — Check 3 enforces the `scripts/mock-allowlist.txt` membership, and Check 4 (issue #1666) ratchets the allowlist closed against unapproved growth. Adding a new `mock.module` target requires a matching `# APPROVED-NEW: <normalized-target>` marker line in `scripts/mock-allowlist.txt`; `MOCK_ALLOWLIST_ENFORCE=0` soft-warns for a deliberate growth PR.
- Run the new bounded tests alongside the existing real-git tests; no cross-file pollution.
- New test files must be under 500 lines — `delegation-gate.test.ts` split is the exemplar pattern.
- FR-009 Lean Turbo tests cover: acquire-locks, plan-lanes, review, runner-status, generate-mutants, set-qa-gates, get-qa-gate-profile.
- FR-010/011/012 hook tests (Phase 4): 11 new files covering conflict-resolution, curator-types, delegate-ack-collector, delegate-directive-injection, knowledge-reinforcement, normalize-tool-name, phase-complete-directive-gate, phase-directives, semantic-diff-injection; shared fixtures consolidated in `curator-test-fixtures.ts`.

## PR checklist (pasteable into PR descriptions)

```markdown
## Invariant audit
- 1 (plugin init):       <touched/not touched — evidence>
- 2 (runtime portability): <touched/not touched — evidence>
- 3 (subprocesses):       <touched/not touched — evidence>
- 4 (.swarm containment): <touched/not touched — evidence>
- 5 (plan durability):    <touched/not touched — evidence>
- 6 (test_runner safety): <touched/not touched — evidence>
- 7 (test writing):       <touched/not touched — evidence>
- 8 (session state):      <touched/not touched — evidence>
- 9 (guardrails/retry):   <touched/not touched — evidence>
- 10 (chat/system msg):   <touched/not touched — evidence>
- 11 (tool registration): <touched/not touched — evidence>
- 12 (release/cache):     <touched/not touched — evidence>

## Startup-path validation (only if invariants 1, 2, or 3 are touched)
- [ ] `bun run build`
- [ ] `node scripts/repro-704.mjs`
- [ ] `node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"`

## Subprocess audit (only if invariant 3 is touched)
- [ ] `grep -n "bunSpawn\\|spawn(\\|spawnSync(" <changed-files>` listed and accounted for
- [ ] every matched call passes `cwd`, `stdin: 'ignore'`, `timeout`, bounded stdio, `kill()` in finally

## Tool registration coherence (only if invariant 11 is touched)
- [ ] `bun --smol test tests/unit/config --timeout 60000` passed
- [ ] `/swarm doctor tools` (or its test equivalent) passed
```

## Drift detection across parallel surfaces (issue #1497)

### Why this exists

The repo maintains several "canonical source + mirror" and "source + registry" surfaces that must stay in sync but are edited independently:

- **Skills:** `.opencode/skills/<name>/SKILL.md` (operative, loaded by the OpenCode plugin / architect MODE stubs) and `.claude/skills/<name>/SKILL.md` (Claude-side), plus `.agents/` adapter shims.
- **Bundled skills:** `BUNDLED_PROJECT_SKILLS` (`src/config/bundled-skills.ts`), `package.json#files`, and the `package-smoke` allowlist must all match each other **and** the actual `.opencode/skills/` directory.
- **Docs claims:** public numeric QA-gate claims must match `QA_GATE_PIPELINE_STEPS` (`src/config/qa-gate-pipeline.ts`) and the runtime execute protocol.
- **Tools / commands / agents:** implementation, registries, and per-agent maps (invariant 11).

Two failures motivated the automated check:

- **PR #1480 / #1497:** the `.opencode/skills/commit-pr` mirror silently went stale vs the canonical `.claude` version; manual SHA-256 verification caught it only in round-2 review and does not scale.
- **Issue #1496:** four skills (`writing-tests`, `running-tests`, `engineering-conventions`, `commit-pr`) existed under `.opencode/skills/` but were missing from `BUNDLED_PROJECT_SKILLS` and `package.json#files`, so they never synced to user projects or shipped — because nothing checked the lists against the filesystem.

### How it works

`scripts/drift-check.ts` (run by `.github/workflows/drift-check.yml` on every PR and on `push: main`, or locally via `bun run drift:check`) imports the real modules and compares runtime values rather than grepping source, so it does not produce textual false positives. Detectors:

| Category | What it checks | Source of truth |
|---|---|---|
| `skill-mirror` | `.opencode`↔`.claude` byte identity / divergence / adapter / opencode-only; declared extra identical paths such as `.agents`; unclassified both-tree pairs | `src/config/skill-mirrors.ts` (shared with `tests/unit/skills/skill-mirrors.test.ts`) |
| `bundled-skill` | `.opencode/skills/` ⊆ `BUNDLED_PROJECT_SKILLS`; no phantom entries; `package.json#files` coverage | `src/config/bundled-skills.ts`, `package.json` |
| `skill-audience` | tracked static skills declare valid top-level audience metadata; generated lifecycle skills are excluded | static skill frontmatter parsed by `src/hooks/skill-scoring.ts` |
| `tool` | metadata / handler / plugin-object / `TOOL_NAMES` / `AGENT_TOOL_MAP` coherence | reuses `scripts/check-tool-registration.ts` |
| `command` | `COMMAND_NAME_SET` parity; `subcommandOf` parents exist | `src/commands/registry.ts` |
| `agent` | `ALL_AGENT_NAMES` ↔ `AGENT_TOOL_MAP`; opt-in maps only reference real agents | `src/config/agent-names.ts`, `src/config/constants.ts` |
| `docs-claim` | public numeric QA-gate claims match the docs-visible pipeline registry | `src/config/qa-gate-pipeline.ts` |

### Rules

- It is **soft-warn by default**: GitHub annotations + a sticky PR comment, non-blocking. Set the repo variable `DRIFT_CHECK_ENFORCE=1` for hard-fail.
- When you add a new skill that exists in **both** `.opencode/skills/` and `.claude/skills/`, classify it in `src/config/skill-mirrors.ts` (`identical` / `divergent` / `adapter` / `opencode-only`), or the check warns until you do.
- Drift compute is sub-second, so CI caches only dependency install (the real cost), not per-file SHA-256 results.
