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

### v6.86.9 — OpenCode v1 plugin export shape + cache layouts

- **Symptom:** v6.86.8 still didn't load. Second root cause: `readV1Plugin` requires `mod.default` to be an **object** with at least one of `{ id, server, tui }`. The bundle's default export was a bare async function; `readV1Plugin` returned `undefined`, OpenCode fell through to `getLegacyPlugins`, which iterated `Object.values(mod)` and threw `TypeError` on the `deferredWarnings` array re-export — silently dropping the plugin again. Also: the `update` command only cleared two of three known cache layouts.
- **Invariants established:** default export is `{ id: 'opencode-swarm', server: OpenCodeSwarm }`. CI guard: `bundle-plugin-shape.test.ts` simulates both loader paths. Cache-eviction covers all three known layouts (`~/.cache/opencode/packages/opencode-swarm@latest`, `~/.config/opencode/node_modules/opencode-swarm`, `~/.cache/opencode/node_modules/opencode-swarm`). Cache-path safety uses four checks: catastrophic-floor exclusion, depth ≥ 4, recognized leaf, canonical structure.
- **Maps to AGENTS.md:** invariants 2 (runtime portability) and 12 (release/cache hygiene).

### v6.86.14 — Transient errors tripping the circuit breaker

- **Symptom:** a single 429/503/529/timeout would exhaust model fallback and start counting toward `consecutiveErrors`; five total errors → circuit breaker hard stop. Agents could not recover from short outages.
- **Invariants established:** distinguish transient infrastructure/provider errors from agent logic errors. `transientRetryCount` (default budget 5) is independent of `consecutiveErrors` and resets per invocation. Transient retry and model fallback are independent.
- **Maps to AGENTS.md:** invariant 9 (guardrails / retry semantics).

### v7.0.1 — `SWARM_PLAN` relocation + cache eviction completeness

- **Symptom:** runtime artifacts at the project root caused git pollution; OpenCode users on Windows / macOS still couldn't update because lock files (`bun.lock`, `bun.lockb`, `package-lock.json`) prevented re-resolution.
- **Invariants established:** `SWARM_PLAN.{json,md}` lives under `.swarm/`. Lock-file eviction covers all known names with a four-layer safety check. `update` and `install` both perform eviction.
- **Maps to AGENTS.md:** invariants 4 (.swarm/ containment) and 12 (release/cache hygiene).

### v7.0.3 — OpenCode Desktop loading-screen hang (`#704`)

- **Symptom:** plugin init blocked the event loop. JavaScript executes async function bodies synchronously up to the first `await`; the recursive `readdir`/`statSync` walk in `repoGraphHook.init()` ran inline; OpenCode's `await server(...)` never resolved and Desktop displayed a frozen splash screen forever. Aggravating factors: symlink cycles in `findSourceFiles`, late `maxFiles` cap, direct `Bun.*` calls throwing under Node.
- **Invariants established:** plugin init must be fast, bounded, and side-effect minimal. Yield to the event loop before doing any work. Use `queueMicrotask` + a watchdog (`unref`'d 30 s) for deferred init. `withTimeout` (5 s) for snapshot loads. Symlink cycles must be detected with `realpathSync`/`realpath` and a `seenRealPaths` set. `maxFiles` enforced inside the traversal loop. All `Bun.*` calls go through `src/utils/bun-compat.ts`.
- **Maps to AGENTS.md:** invariants 1 (plugin init), 2 (runtime portability), 3 (subprocesses).

### v7.3.3 — Git hygiene runs on the init path without bounds

- **Symptom:** `ensureSwarmGitExcluded` correctly fixed `.swarm/` Git pollution but did so by `await`ing four sequential `git` subprocess calls on the plugin-init critical path with **no** outer `withTimeout` and **no** per-call `timeout` / `stdin: 'ignore'` / `proc.kill()`. On hosts where any one git child fails to exit promptly (Windows antivirus interception, credential helper prompts, NFS-stalled `.git`, Bun-on-Windows stdin pipe semantics) the plugin entry never resolved; OpenCode silently dropped the plugin; users saw "no agents in TUI/GUI" with no error.
- **Invariants established (THIS PR):** every awaited operation on the init path must be bounded by `withTimeout` (or equivalent) AND fail open. Every subprocess on the init path must have explicit `cwd`, `stdin: 'ignore'`, `timeout`, bounded stdout/stderr, and `proc.kill()` in `finally`. The same hardening applies to the secondary defect site `validateDiffScope` even though it is not on the init path. Tests use a file-scoped `_internals` DI seam — not `mock.module` — to avoid Bun's cross-file mock leakage.
- **Maps to AGENTS.md:** invariants 1 (plugin init), 3 (subprocesses), 7 (test writing).

### PR #1356 — `withTimeout`-bounded work is still on the critical path if you `await` it

- **Context:** PR #1356 added an init-time step that materializes up to 20 bundled mode-skill directories into a fresh project so the architect does not hit missing `SKILL.md` files on turn one. The merged form is the **correct** pattern — deferred via `queueMicrotask`, `withTimeout`-bounded, fail-open, missing-only, byte/file-bounded (`src/index.ts` ~line 392). It is cited here as an exemplar, not a regression.
- **The lesson (recorded in the in-code comment at `src/index.ts`, ~line 381):** during development an earlier revision **`await`ed the sync inline** on the `server()`-resolution path. That version was still `withTimeout`-bounded and fail-open, yet the ~20 sequential `fsp.*` calls' real latency on a **cold Windows filesystem pushed `server()` past the `repro-704` T1 deadline** (`TIMING_DEADLINE_MS = 400` in `scripts/repro-704.mjs:42`). It was corrected to `queueMicrotask` deferral before merge; deferred, `server()` resolves in single-digit ms and the copy runs in the background. (No separate broken commit exists — the inline-await form was fixed pre-merge; the authority for this lesson is the in-code comment, not a CI artifact. Exact failing/passing millisecond figures were not recorded.)
- **Root cause of the inline-await misstep:** treating `withTimeout` as if it makes work free. `withTimeout` is `Promise.race` against an (unref'd) timer (`src/utils/timeout.ts`) — it only protects against an *unbounded* await; it does nothing to remove the awaited work's actual latency from the `server()`-resolution path. The repo-graph scan (v7.0.3) established the deferral pattern via `queueMicrotask`; the skill sync now follows it.
- **Invariants established:** **Bounded ≠ free.** Decide await-vs-defer explicitly for every init step:
  - **Defer (`queueMicrotask` + the existing `withTimeout`/`.catch`)** when the work does non-trivial I/O and **nothing downstream in `initializeOpenCodeSwarm` depends on its completion before `server()` resolves**. The deferred task starts on the next microtask tick — before any user turn — so runtime consumers (e.g. the architect reading `SKILL.md` as an LLM tool action) still observe the result; only the *latency* leaves the critical path. This is the `repoGraphHook` precedent (`src/index.ts:323`) and what the merged skill sync does (`src/index.ts:392`).
  - **`await` (still `withTimeout`-bounded + fail-open)** only when the work is genuinely fast (<~50 ms typical) **and** must complete before a later init step — e.g. `ensureSwarmGitExcluded` (`src/index.ts:356`) must run before `.swarm/` artifacts are written.
  - **Cross-platform proof is mandatory.** Linux/macOS `repro-704` passing does **not** prove Windows; cold-FS op latency is several× higher there. The T1 400 ms assertion (`scripts/repro-704.mjs:42`) runs on the Windows runner in the `smoke` matrix (`.github/workflows/ci.yml`); the CI step's summary comment mentions the looser 10 s `BUDGET_MS` (T2/T3), but T1 is the tight bound that catches this class of regression. Green locally is necessary, not sufficient.
- **Maps to AGENTS.md:** invariant 1 (plugin init).

## Invariants — anti-pattern, required pattern, verification

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
// a cold Windows FS; deferring moves the latency off the critical path while the
// work still completes before any user turn / runtime read.
queueMicrotask(() => {
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
init step depends on it; otherwise defer with `queueMicrotask`. `withTimeout`
wraps both — it bounds hangs, it does not erase latency.

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

### 5. Plan durability

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

### 6. test_runner safety (test execution scope)

**Anti-pattern:**

```ts
test_runner({ scope: 'all', allow_full_suite: true });
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

**Verification:**

- Run the new bounded tests alongside the existing real-git tests; no cross-file pollution.

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
