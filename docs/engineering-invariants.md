# Engineering Invariants — opencode-swarm

> Long-form companion to `AGENTS.md`. `AGENTS.md` is the operational checklist; this document is the rationale, the historical failure map, and the worked examples. **`AGENTS.md` and `docs/engineering-invariants.md` together are the engineering source of truth for the repo.** When other docs conflict, this one wins.

## Why this document exists

### Integrity boundary (issue #1824)

Shell classification is a shared bounded tripwire, never a sandbox. Explicit
required sandbox dimensions fail closed unless behaviorally reported `real`.
Governed evaluation inputs are hashed before and after candidate execution, and
human-required writes consume an exact one-shot session/action/content-bound
approval fact. Turbo never bypasses scope enforcement.

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
- **Invariants established:** Tool addition is incomplete until exported, registered in the plugin block, listed in `TOOL_NAMES` (`src/tools/tool-names.ts`), mapped in `AGENT_TOOL_MAP` or a documented opt-in map, surfaced in help/docs, and covered by parity tests. `/swarm doctor tools` and registration-smoke/plugin-registration-adversarial tests enforce coherence. `test_runner` returns explicit `outcome: 'pass' | 'skip' | 'regression' | 'scope_exceeded' | 'error'` with `MAX_SAFE_TEST_FILES = 50`. *(Historical wording, accurate as of v6.48.0. The hand-maintained surfaces it names were superseded by the compile-checked `TOOL_METADATA` + `TOOL_MANIFEST` pair — see issue #507 and issue #1643 — so the current contract is: a `tool-metadata` entry + a `manifest` handler + a barrel export, with `TOOL_NAMES` / `AGENT_TOOL_MAP` / the plugin object all derived. See AGENTS.md invariant 11 for the authoritative checklist.)*
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
  - Stray `.swarm/` directories without a coexisting project indicator are ignored while the bounded ancestor walk continues
  - Fail-closed on non-ENOENT indicator errors (EPERM, EBUSY → assume indicator present)
  - `realpathSync` for junction/symlink resolution
- **Invariant established:** `validateProjectRoot` prevents unbounded traversal while distinguishing genuine parent projects (`.swarm/` + project indicator) from stray artifacts (`.swarm/` alone). Issue #2127 subsequently strengthened the ambiguous depth-limit case to fail closed; indicator errors also fail closed.
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

### Issue #2127 — Explicit nested project boundaries

- **Symptom:** an outer project's `.swarm/` caused nested Git repositories, linked worktrees, submodules, and intentionally nested OpenCode projects to be rejected as ordinary subdirectories. The rejection was duplicated across the shared resolver, evidence writer, and four tool-level root guards.
- **Root cause:** containment classified project identity from ancestry alone. It never checked whether the selected target directly declared an independent project boundary.
- **Invariant established:** a direct `.git` regular file/directory or direct `.opencode/` directory declares a nested directory to be its own project root. This is a local declaration, not Git-metadata validation: empty or malformed direct `.git` markers opt in. Marker symlinks/junctions and inaccessible/ambiguous target markers never grant an exemption. Ordinary descendants remain rejected. Ambiguous ancestor `.swarm` probes or project indicators and bounded-walk depth exhaustion fail closed.
- **Implementation pattern:** `hasExplicitProjectBoundary` owns marker semantics and uses `lstatSync`; `isStrictPathDescendant` owns platform-correct descendant classification. `validateProjectRoot`, `resolveWorkingDirectory`, `save_plan`, `declare_scope`, `update_task_status`, and `pre_check_batch` must remain in parity. The shared canonical project-root assertion also runs at every low-level plan, scope, evidence, and evaluation mutation sink, including checkpoint/recovery/terminal writers, migration, deletion, retirement, retention/archive, and lock-target creation, so callers cannot bypass the tool-layer guard.
- **Maps to AGENTS.md:** invariants 4 (`.swarm` containment) and 7 (public-path and error-seam regression coverage).

### v6.85.1 — Multiple system messages crashing local models

- **Symptom:** Qwen3.6 / Gemma require exactly one `{ role: 'system' }` message at index 0; the swarm hook appended multiple `output.system` entries, each materialized into a separate system message; local models crashed or silently degraded.
- **Correction (issue #1619) — the mechanism this entry used to claim never ran.** The shipped fix collapsed `output.system` inside `experimental.chat.system.transform` by *reassigning* the property. The OpenCode host invokes each plugin hook as `M(input, output)`, **discards the handler's return value**, and afterwards reads its OWN local array (`LLMRequestPrep.prepare`, host binary offset ~100,587,200: `let l=[…]; trigger(…,{system:l}); …uses l`). A rebind is therefore invisible to the host, so the collapse never executed once. It has now been **removed rather than activated**: the host sets prompt-cache breakpoints on the first two system messages (`nk()`, ~102,133,558), so folding the stable base prompt together with the per-request swarm injections would move the only system breakpoint behind varying content and defeat caching on every request.
- **Where consolidation actually happens: the message layer.** *(Superseded by issue #2526 — see the next entry: the pinned host's converter DROPS `role:'system'` entries from this surface entirely, so consolidation was replaced by carrier materialization; the historical description follows.)* `consolidateSystemMessages` (`src/hooks/messages-transform.ts`) merged every `role: 'system'` message found in `output.messages` into index 0 and stripped the leftovers. It is invoked from the final `experimental.chat.messages.transform` handler in `src/index.ts`. That call site carried the *same* rebind defect (`output.messages = consolidateSystemMessages(output.messages)`; host binary ~100,667,665 triggers with `{messages:C}` and then uses its own `C`) and was equally dead until #1619; it now goes through `consolidateSystemMessagesInPlace`, which mutates the array the host still holds. **Scope of the guarantee:** at most one system-role message *inside the transformed message array*. The host separately prepends its own system entries from `l` (reshaped to at most two), so "exactly one system message at index 0" is not achieved end-to-end and never was.
- **Invariants established:** a property on the `output` object handed to an `experimental.chat.system.transform` or `experimental.chat.messages.transform` handler must be mutated **in place** (`push`, `splice`, `length = 0`, index assignment). Rebinding it is a silent no-op. Do not over-generalize: `chat.params` / `chat.headers` *do* consume the returned object, so rebinding is observable there. Guard: `tests/unit/hooks/chat-transform-rebind-guard.test.ts` source-scans `src/` for `.system` / `.messages` assignments and fails on any un-allowlisted one; `tests/unit/hooks/system-message-consolidation-in-place.test.ts` pins the host-visibility contract and the interaction with the hooks that splice system messages mid-history.
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
- **Invariants established:** default export is `{ id: 'opencode-swarm', server: OpenCodeSwarm }`. CI guard: `bundle-plugin-shape.test.ts` simulates both loader paths. Cache eviction covers the known package-cache layouts (`~/.cache/opencode/packages/opencode-swarm@latest` and the older bare `~/.cache/opencode/packages/opencode-swarm`) plus config/cache `node_modules` layouts. Cache-path safety uses four checks: catastrophic-floor exclusion, depth ≥ 4, recognized leaf, canonical structure.
- **Maps to AGENTS.md:** invariants 2 (runtime portability) and 12 (release/cache hygiene).

### v6.86.14 — Transient errors tripping the circuit breaker

- **Symptom:** a single 429/503/529/timeout would exhaust model fallback and start counting toward `consecutiveErrors`; five total errors → circuit breaker hard stop. Agents could not recover from short outages.
- **Invariants established:** distinguish transient infrastructure/provider errors from agent logic errors. `transientRetryCount` (default budget 5) is independent of `consecutiveErrors` and resets per invocation. Transient retry and model fallback are independent.
- **Maps to AGENTS.md:** invariant 9 (guardrails / retry semantics).

### Issue #1875 — non-transient retry loops + unbound write scope

- **Symptom:** proven parser, command-not-found, sandbox-wrapper, and repeated permanent failures could be retried indefinitely, while a coder delegation with empty, stale, v1, or identity-mismatched scope could reach child-state publication without an exact active authorization binding.
- **Invariant superseded by #2103:** the original invocation-wide irreversible hard stop was safe but over-broad. Circuit authority remains invocation-owned and non-durable, but is now keyed by exact semantic action and failure category. Structured parser/command-unavailable/sandbox failures may open immediately; repeated permanent failures use their category threshold. Only the matching action is blocked, sandbox failure remains fail-closed, and exact read/diagnose/rescope/repair/handoff/abort controls remain reachable. Corrected success clears only that action; external repair uses an audited exact-session/invocation/action reset; late or foreign results cannot clear current state. Classification is source-aware so provider patterns never consume arbitrary shell output. Write-capable coder delegation still requires an exact active v2 scope binding correlated to the current session and Task call; empty scope, v1 fallback, stale plan/task identity, or another session's declaration fails closed with `SCOPE_NOT_DECLARED`, before child state is published.
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
  39-entry `EVENT_CATALOG` (`catalog.ts`) covering every `TelemetryEvent`
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

### Issue #2036 — Retention registry: every durable writer must be registered

- **Symptom class prevented:** retention policy was defined piecemeal across
  ~190 write call sites in ~103 modules; a new durable stream could be added
  with no review surface forcing a retention/owner decision, and full-file
  readers could scale with history with nobody accountable for the bound.
- **Fix applied (PR 08 of the observability sequence):** the complete
  retention and read-amplification registry lives as DATA in
  `scripts/retention-registry.data.ts` (every stream under `.swarm/`
  and the platform-data roots, with writers, readers, limits + scope, read
  bounds, lock/crash/close/reset policy, owner, and a completed disposition).
  `bun run check:retention` (`scripts/check-retention-registry.ts`, a
  hard-fail CI quality step after `check:events`) enumerates every durable
  writing module under `src/` (write APIs, atomic-write helper calls, SQLite
  open/acquire seams) and fails when a writer has no registry row, when an
  exemption goes stale, when a disposition is a placeholder, or when a
  cited repo FILE no longer exists (bare-filename and line-level citation
  accuracy stay ungated, "verified-as-of" pointers — see the registry doc's
  Appendix A). The ratified document is
  `docs/observability-retention-registry.md`; dispositions may only be
  fix-in-issue (sequence window #2029–#2051 or a registered amendment
  issue),
  retain-by-design (citation), or not-a-defect (source proof).
- **Placement invariant:** the registry data deliberately lives under
  `scripts/`, never `src/` — it must never enter the plugin bundle or the
  initialization path (invariants 1 and 2 stay untouched by construction).
  Known limitation: a module mutating a SQLite handle acquired elsewhere is
  invisible; the DB open/acquire seam is the enforced boundary.
- **Maps to AGENTS.md:** invariants 4 (registry covers only `.swarm/` +
  platform roots), 7 (tests use exported collectors with fixture trees, no
  mock.module), 11 (registration-completeness discipline extended from
  tools/events to durable storage), and 12 (release fragment).

### Issue #2031 — Diagnostic FIFO eviction changed receipt and gate correctness

- **Symptom:** retrieval membership and terminal outcomes shared the bounded
  `knowledge-events.jsonl` budget with high-volume operational diagnostics.
  More than 5,000 unrelated observations could evict a live retrieval, make an
  honest receipt fail with `trace_not_found`, starve promotion evidence, and
  remove a critical phase obligation after it had already been displayed.
- **Fix applied:** correctness state now lives in the hash-chained,
  canonical-project-root-only `.swarm/knowledge-receipts-v2.jsonl` journal,
  with a rebuildable snapshot and separate closed-summary archive. The exact
  final displayed membership is committed before exposure; terminal validation
  and commit are one fail-closed cross-process-locked transition; the lock is
  released before best-effort diagnostic and legacy projections. Receipt paths
  derive from the injected project root, reject symlink/junction/reparse
  redirection, and never follow a knowledge link, hive path, cohort store, or
  `process.cwd()`.
- **Lifecycle and cutover:** live membership has no event-count cap. Resolved
  pairs remain protected until durable phase closure plus the bounded
  `knowledge.receipt_close_grace_days` interval (default seven days). Migration
  is lazy first-use work, never plugin initialization work, and imports only
  complete live records from the canonical project's local legacy log.
  Missing, evicted, linked, or malformed legacy membership is the typed
  `legacy_unverifiable` state; counters and diagnostic baselines never infer it.
- **Authority boundary:** `knowledge-events.jsonl`, application logs, promotion
  projections, counters, and canonical observations are diagnostics or
  rebuildable derivatives. Receipt validation, application/phase gates,
  promotion, escalation, feedback, and destructive policy do not consume them
  as authority. A project-local ledger cannot prove cohort-wide destructive
  quorum, so linked diagnostic rows conservatively cannot authorize it.
  Outcome/source normalization remains owned by #2032; V2 preserves current
  typed producer meanings and uses `unknown` only when a source is absent.
- **Maps to AGENTS.md:** invariants 2 (portable journal implementation), 4
  (canonical `.swarm/` containment), 7 (cross-platform crash/concurrency tests),
  8 (restart-safe session separation), 9 (fail-closed transition semantics),
  10 (membership before chat exposure), and 12 (pending release fragment).

### Issue #1994 — post-mortem fabricated an FR-009 precedent; corrective PR closed unmerged

- **Symptom:** a `/swarm finalize` post-mortem claimed FR-009 ("schema permitted
  `pending >= general` multipliers") was "closed correctly" via a "schema `.refine`
  + runtime defensive clamp pattern" that never existed — commit `b7e12d36`
  (canonical; post-rewrite local twin `d82c7172`, merged via #1978) explicitly
  recorded FR-009 as deferred. The corrective PR (#2001) was closed
  unmerged, so every skill disposition it carried (S1/S4/P1/P2) was silently absent
  from `main` while the issue tracker recorded "fixed".
- **Root cause:** post-mortems are LLM-generated narratives that can fabricate
  precedent; their corrections lived only in `.swarm/` runtime state (post-mortem
  archive, spec.md, knowledge entries) and an unmerged PR — none of which future
  sessions read. Treat "What Went Right" sections as claims, not records.
- **Fix surface:** skill-guidance corrections — `placeholder_scan` diff scoping via
  `added_lines` wired into the Stage A callers (execute skill step 5e + architect
  prompt, with the fail-closed omit-from-map fallback), the smallest-justified-scope
  `SCOPE_CONFLICT` rule in swarm-implement (never widen to a plan-inferred
  superset), the plan-freeze-after-approval rule in critic-gate (material change →
  exactly one re-critic), docs-attestation integrity in phase-wrap, and a qa-sweep
  staleness fix (the tool has been diff-aware since `added_lines` landed).
- **FR-009 disposition: DESCOPE.** The runtime 3× idle-poll cap shipped
  hard-coded (`shouldSkipIdlePoll`, merged via PR #1978 from the branch
  integrating the issue-#1691 investigation); the schema-configurable
  multipliers FR-009 guarded were never added (FR-003 configurability remains
  deferred), so there is no `.refine` target. Do not cite FR-009 as a closed
  schema+runtime precedent.
- **Proposed pattern (NOT an established precedent):** for safety-critical
  invariants, schema-level rejection (Zod `.refine`/`superRefine`) is primary and
  authoritative; any runtime fallback must be OBSERVABLE (emit a structured
  advisory/telemetry event naming the rejected or coerced value) and reserved for
  safety-critical invariants only. A silent blanket runtime clamp conceals invalid
  configuration and schema/runtime drift. Adopt only with a concrete case; when
  adopted, cite this entry as its origin.

### Issue #2480 — the SQLite durable-state foundation (Workstream D1)

- **What shipped:** `.swarm/swarm.db` became the durable-state substrate with
  canonical connection identity (`src/db/canonical-project.ts` — one handle
  per canonical project root: realpath-collapsed, case-folded on win32 only),
  single-statement versioned migrations v14–v17 with failed-migration
  recovery (`migration_failures` + `.swarm/db-migration-failure.json` marker
  fallback, retry on next open), per-table durability classes
  (`src/db/durability.ts` — terminal-state tables write at
  `synchronous=FULL`, production-wired through `qa-gate-profile`'s shared
  immediate-transaction helper and every task-checkpoint-receipt writer), a
  group-commit writer (queue → one `BEGIN IMMEDIATE` txn per flush — plain
  `db.transaction()` issues a deferred BEGIN that deadlocks into SQLITE_BUSY
  under two-windows contention), an idempotent one-txn legacy import with
  `.imported` cold-archive rename, `quick_check` in diagnose, a typed
  disk-full/read-only/corrupt error surface, and the first low-risk store
  migrations (insight candidates + both drift-report families) through the
  four documented table patterns. Full policy:
  `docs/sqlite-durable-state.md`.
- **Invariant(s) established:**
  - **Migrations are single-statement.** A partial application can never hide
    inside a multi-statement string split differently across drivers.
  - **Authoritative state never inherits the rebuildable-index durability
    setting:** any transaction touching a `full`-class table runs at
    `synchronous=FULL`.
  - **The store-op seam is the registry boundary for DB-mediated writes** (see
    the #2036 entry): every durable swarm.db mutation goes through a NAMED,
    enumerated store function; raw `Database`-handle usage outside `src/db/**`
    is confined to `RAW_DB_HANDLE_MODULES`; `src/db` foundation writers are
    reverse-staleness checked.
  - **Legacy files are never silently destroyed:** the import renames to
    `.imported` after commit; a non-empty table with the file still present
    (crash-after-commit window, or an older plugin version rewriting it)
    leaves the file inert with a once-per-process warning.
  - **The canonical-key close semantic:** closing the handle invalidates every
    spelling-alias of that root — those aliases were previously silent
    duplicate WAL writers on one file, which was the bug.
  - **Node floor is enforced, not just declared:** the loader probes
    `process.versions.node` on the node fallback and throws the floor
    diagnostic (`engines` declares `node >= 22.13`).
  - **No-bindings `run()` returns a `Changes`-shaped object (#2539):**
    `bun:sqlite`'s `run()` ALWAYS returns `{ changes, lastInsertRowid }`,
    including the no-bindings form; the node adapter's no-param branch
    (which executes via `exec()`, void under `node:sqlite`) rebuilds the
    object from the connection-level counters (`SELECT changes(),
    last_insert_rowid()` — one cached probe statement). Pre-fix it returned
    `undefined`, so `.changes` readers crashed under the Node sidecar
    (`/swarm memory unlink` and populated re-link, via the memory-family
    ATTACH merge). The shape is pinned in `src/db/driver-parity.ts` for
    single-statement DML — the only form production reads; an audit of
    `src/` found exactly two no-bindings return-value readers (the ATTACH
    merge and the `valid_from` backfill), both healed by the adapter fix.
    Two deltas are deliberately NOT pinned because the drivers genuinely
    diverge there: multi-statement strings (bun sums `.changes`, the probe
    reports the last statement) and non-DML statements (bun reports 0, the
    probe keeps the previous DML's count).
- **Maps to AGENTS.md:** invariants 2 (runtime portability — parity contract
  + strict fake), 4 (`.swarm` containment), 7 (driver-parity and
  registry-seam tests), 8 (bounded session state — degradation cooldowns,
  once-per-process warnings), and 11 (registration-completeness extended to
  DB-mediated writes).

### Issue #2526 — Plugin-injected role:'system' messages never reached the model

- **Symptom:** guardrail advisories, knowledge and memory recall, delegation guidance and issue-trace directives were silently absent from the model's input while plugin telemetry recorded them as delivered; a `--trace` turn in which only issue-trace injected failed the host prompt build with `TypeError: undefined is not an object (evaluating 'msg.parts.length')`.
- **Root cause:** the OpenCode host's message→request converter (`toModelMessagesEffect`, pinned @opencode-ai 1.18.3; host repo `anomalyco/opencode` tag `v1.18.3`, commit `127bdb30784d508cc556c71a0f32b508a3061517`, session module `message-v2`, the `toModelMessagesEffect` loop at lines 195-244) branches only on `user` and `assistant` with no `else`, and its `Message` union (`@opencode-ai/sdk` `types.gen.d.ts:128`) has no `system` member — every synthetic `role:'system'` entry the plugin spliced into `experimental.chat.messages.transform` output was discarded before the request was built. The flat `{role, content}` entries issue-trace pushed have no `parts`, and the loop head dereferences `msg.parts.length` unconditionally — hence the TypeError. Delivery predicates asserted presence in the plugin's own output array, so telemetry lied. The sibling `chat.system.transform` surface (plain `string[]`) DOES render (host `llm/request` module, the `system.map` spread), which masked the total loss.
- **Fix:** all plugin injections ride USER-role guidance carriers built by `src/hooks/system-guidance-carrier.ts` (`info.id` prefix `swarm-guidance:<kind>`, role `user`, one text part wrapped in the `<swarm_system_directive>` provenance fence; detection by id prefix, never text). The final structure-mutating transform handler now runs `materializeSystemGuidanceInPlace` — a boundary that converts any remaining system entry to a carrier in place (or drops tool-result-shaped / whitespace-only ones), so the transformed array contains zero system entries: a strictly stronger form of the #608/#628 local-model guarantee. Delivery telemetry gates on `deliveredGuidanceDelta` (non-empty text delta + host-renderable carrier shape). The knowledge-application and skill-propagation transform scans skip carriers so injected directives can never be parsed as architect/reviewer acknowledgements, and `classifyMessage` treats carriers as CRITICAL (never pruned), matching the old system-role exemption.
- **Durable guards:** `tests/helpers/host-contract-v1_18_3.ts` (provenance-headed distillation of the host loop) + `tests/unit/hooks/host-message-role-contract-2526.test.ts` (renders user/assistant only; system never; flat throws; AND a version tripwire asserting the installed `@opencode-ai/plugin` + `@opencode-ai/sdk` equal `1.18.3` — a lockfile bump fails loudly and forces re-verification of the fixture against the new host source); `tests/unit/hooks/system-splice-ratchet-2526.test.ts` (source scan: no `role:'system'` construction outside the role-filter system-string adapter and the materializer); `tests/unit/hooks/host-rendered-guidance-2526.test.ts` (exit gate: real registered plugin chain + pinned host converter — guardrail advisory, knowledge recall, memory recall each render; `--trace` turn completes with the MODE directive).
- **Maps to AGENTS.md:** invariant 10 (chat/system-message hook contracts).

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

For tools that accept a user-supplied `working_directory`, anchor to a project root while recognizing direct nested declarations:

```ts
const resolved = resolveWorkingDirectory(args.working_directory, ctx.directory);
if (!resolved) return { success: false, error: 'working_directory must resolve to project root' };

// Duplicate canonical guards use the same shared policy:
if (
  isStrictPathDescendant(canonicalTarget, canonicalContextRoot) &&
  !hasExplicitProjectBoundary(canonicalTarget)
) {
  return { success: false, error: 'ordinary subdirectories are not project roots' };
}
```

`hasExplicitProjectBoundary` requires a non-empty absolute path and never probes
the process CWD for invalid input. It uses `lstatSync`, so a direct `.git`
file/directory or `.opencode/` directory opts in while marker symlinks and
junctions do not. Do not replace it with `git rev-parse`, gitfile parsing, or a
broader project-indicator heuristic: `.opencode/` is an intentional manual
declaration, and generic files such as `package.json` must not reopen ordinary
subdirectory fragmentation.

**Verification:**

- `grep -rn "process.cwd()" src/tools src/hooks` — every remaining match has a comment justifying it as a documented direct-CLI/test fallback.
- `rg -n "hasExplicitProjectBoundary|isStrictPathDescendant" src` — the two shared helpers are wired through all six root guards, with no local marker policy.
- `tests/unit/utils/project-boundary.test.ts`, `tests/unit/evidence/project-root-boundary-errors.test.ts`, `tests/unit/containment/nested-project-boundary-writers.test.ts`, and `tests/unit/tools/nested-project-boundary-tools.test.ts` — marker/error semantics and actual nested read/write/scan targets.

**Evidence trust boundary:** Runtime JSON under `.swarm/`, including
`.swarm/evidence/{taskId}.json`, is durable audit and recovery state for
cooperative agents running as the same OS user. Evidence writes are atomic and
path-safe, but workspace files are not tamper-proof authorization records: a
process with the same user's filesystem access can replace them. Treat gate
evidence as trustworthy only within that cooperative-agent threat model. Strong
integrity against a same-user adversarial process would require a protected
trust root outside the workspace.

**Session-reset worktree resilience (FR-004):** `.swarm-worktrees/` directories created by parallel lanes must be reconciled on session resume/reset. `provisionWorktree` in `src/worktree/core.ts` implements idempotent provisioning: if a branch exists but is not checked out in any active worktree, it is adopted; if it is active elsewhere, an error is returned. `reset-session.ts` reclaims OWNED worktree lanes in the project-internal `.swarm-worktrees/` base (issue #2527: foreign lanes are never deleted; lanes with uncommitted or live work require `--confirm=<token>`) and orphan branches. The swarm-resume skill (slug `resume` before the #2379 rename) explicitly calls out reconciliation as the first step. This prevents stale worktrees from causing provisioning failures or silent git state corruption when a session resumes after reset.

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

**Settled-task re-open guard (FR-005):** `update_task_status` must not silently re-open a settled task (`completed` / `blocked` / `closed`) to `in_progress`. The tool and manager layers reject ordinary backward transitions; the only exception is the exact-task audited repair transaction with explicit force, reason, transition identity, expected state, and expected generation. The legacy `advanceTaskStateAndPersist` wrapper refuses coder and terminal boundaries so it cannot bypass that transaction.

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
| `src/memory/redaction.ts` | `currentAlgorithmVersion` | #2062 F-012 cohort-fingerprint version gate: simulates a FUTURE bump of `FINGERPRINT_ALGORITHM_VERSION` so the legacy-file gate is testable before a real bump exists. Production code never mutates it. |
| `src/background/pending-delegations.ts` | `_checkpointInternals` (`renameWithRetry`, `renameOnce`, `syncSleep`) | #2034 checkpoint crash-window + Windows rename-retry tests (inject EPERM at the atomic rename boundary) |
| `src/background/delegation-health.ts` | `_healthInternals` (`renameOnce`) | #2034 health-artifact Windows rename-retry tests |
| `src/hooks/init-orphan-recovery.ts` | `recordDelegationRecoveryObservation` | #2034/#1659 durable recovery-observation tests |
| `src/hooks/delegation-gate.ts` | `_internals.beforePrFeedbackScopeConsume` | #2469 declaration-replacement interleave tests (pause between scope classification and locked consumption) |
| `src/hooks/pr-workflow-gate.ts` | `_test_exports.beforePrReviewReentryReservation` | #2469 workflow-lock-held-through-reservation interleave tests |
| `src/hooks/pr-workflow-response-gate.ts` | `_internals.scanDelegationsForRecovery` | #2469 lane-progress-token tests (inject receipt digests / throwing scans) |

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

- Run `bun run check:mock-cleanup` — it enforces Check 2: every `mock.module('node:*', ...)` must spread real exports (e.g., `...realFs`, `...realChildProcess`).
- Run `bun run check:invariants` — Check 3 enforces the `scripts/mock-allowlist.txt` membership, and Check 4 (issue #1666) ratchets the allowlist closed against unapproved growth. Adding a new `mock.module` target requires a matching `# APPROVED-NEW: <normalized-target>` marker line in `scripts/mock-allowlist.txt`; `MOCK_ALLOWLIST_ENFORCE=0` soft-warns for a deliberate growth PR.
- Run the new bounded tests alongside the existing real-git tests; no cross-file pollution.
- New test files must be under 500 lines — `delegation-gate.test.ts` split is the exemplar pattern.
- FR-009 Lean Turbo tests cover: acquire-locks, plan-lanes, review, runner-status, generate-mutants, set-qa-gates, get-qa-gate-profile.
- FR-010/011/012 hook tests (Phase 4): 11 new files covering conflict-resolution, curator-types, delegate-ack-collector, delegate-directive-injection, knowledge-reinforcement, normalize-tool-name, phase-complete-directive-gate, phase-directives, semantic-diff-injection; shared fixtures consolidated in `curator-test-fixtures.ts`.

### Atomic writes and residue quarantine (issue #2035)

**Anti-pattern:** inventing a new temp-file naming grammar per writer; cleanup sweeps that match by substring (`startsWith('.tmp.')`) or delete without eligibility gates.

**Required pattern:**

- Production atomic writes under `.swarm/` go through the canonical helper in `src/utils/atomic-write.ts` (`atomicWriteSwarmFile`/`Sync`): containment, registered `<target>.<hex32>.tmp` grammar, bounded payload, fsync, bounded rename retry, exact own-temp `finally` cleanup, artifact-cache invalidation.
- Every temp grammar — current, canonical, and legacy — is registered in `SWARM_TEMP_GRAMMARS` with producer citations; a bespoke writer may exist only with a documented invariant reason (registry `note` + `WRITER_CLASSIFICATION` entry). The ratchet test in `tests/unit/utils/atomic-write.test.ts` fails the build for any unclassified `.tmp`-constructing source file.
- Residue discovery classifies candidates by exact registered grammars only (case-sensitive); constant-name temps (`X.tmp`, no instance token) are reported but never auto-mutated.
- Mutation of residue is a recoverable MOVE into `.swarm/quarantine/<batch>/` with a manifest (original path, sha256, bytes, mtime, grammar, reason), eligible only when: stale (≥30 min), git-untracked (unknown tracked-state fails closed), non-symlink, no active lock, parsed target present, and unchanged since scan. Automatic destructive deletion is prohibited. Rollback is manifest-verified, idempotent, and collision-safe.
- Close (clean stage + dry-run), `/swarm config doctor`, and diagnose all render from the ONE shared implementation in `src/services/swarm-residue.ts`; the `residue_health` telemetry event carries counts and grammar ids only — never file names, paths, or content.

**Verification:** `bun test tests/unit/utils/atomic-write.test.ts tests/unit/services/swarm-residue.test.ts tests/unit/commands/doctor-residue.test.ts tests/unit/services/diagnose-residue-check.test.ts` plus the issue-named suites (`tests/unit/commands/atomic-writes.test.ts`, `tests/unit/hooks/curator-atomic-write.test.ts`, `tests/unit/commands/close-cleanup.test.ts`, `tests/integration/finalize-clean-preserves-swarm.test.ts`).

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
- **Docs claims:** public numeric QA-gate claims must match `QA_GATE_PIPELINE_STEPS` (`src/config/qa-gate-pipeline.ts`) and the runtime execute protocol; hand-copied prose citations of the dispatch lane batch cap must match `MAX_LANES` (`src/tools/dispatch-lanes.ts`, issue #1645) — including spelled-out forms ("eight lanes") and every pending release fragment under `docs/releases/pending/`.
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
| `tool` | metadata / handler / plugin-object / `TOOL_NAMES` / `AGENT_TOOL_MAP` / barrel-export coherence (issue #1643) | reuses `scripts/check-tool-registration.ts` |
| `command` | `COMMAND_NAME_SET` parity; `subcommandOf` parents exist | `src/commands/registry.ts` |
| `agent` | `ALL_AGENT_NAMES` ↔ `AGENT_TOOL_MAP`; opt-in maps only reference real agents | `src/config/agent-names.ts`, `src/config/constants.ts` |
| `docs-claim` | public numeric QA-gate claims match the docs-visible pipeline registry; hand-copied dispatch lane-cap prose (digits plus the in-tree spelled form ("eight")) matches the exported `MAX_LANES`; pending release fragments are scanned for lane-cap citations | `src/config/qa-gate-pipeline.ts`, `src/tools/dispatch-lanes.ts` |

### Rules

- CI invokes drift-check with `--enforce`, so blocking findings fail the job; GitHub annotations and a sticky PR comment still publish the full report. Local `bun run drift:check` remains soft-warn unless invoked with `--enforce` (or `DRIFT_CHECK_ENFORCE=1`).
- When you add a new skill that exists in **both** `.opencode/skills/` and `.claude/skills/`, classify it in `src/config/skill-mirrors.ts` (`identical` / `divergent` / `adapter` / `opencode-only`), or the check warns until you do.
- Drift compute is sub-second, so CI caches only dependency install (the real cost), not per-file SHA-256 results.
