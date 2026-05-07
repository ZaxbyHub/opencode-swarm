# Critic Review

## Verdict
NEEDS_REVISION (→ APPROVE after addressing two required revisions below)

## Evidence Sufficiency
Root cause is plausibly confirmed by code evidence. The race window in `initTreeSitter()` is
mechanistically provable: the boolean flag is only set after `await TreeSitterParser.init()`
resolves; any concurrent callers that enter before resolution each call `Parser.init()`
independently. Packaging was verified by `npm pack --dry-run`. The claim that concurrent
Emscripten inits corrupt module state lacks a citation to web-tree-sitter source, but the
fix is correct regardless — serializing init is safe even if the library happened to be
idempotent. Evidence sufficiency is adequate for planning.

## Plan Correctness
The promise-memoization pattern is the correct fix for the race. One correctness gap:

**Stale rejected promise (blocker)**: Under the proposed fix, if `TreeSitterParser.init()`
throws, `treeSitterInitPromise` permanently holds the rejected promise. Every subsequent
caller immediately receives the same rejection — no retry is possible without calling
`clearParserCache()` explicitly. The current boolean flag allows retry (it stays `false` on
failure). The fix must null-out `treeSitterInitPromise` inside a `.catch()` re-throw so
callers get a fresh attempt after a transient failure:

```ts
treeSitterInitPromise = (async () => { /* init logic */ })()
  .catch(err => {
    treeSitterInitPromise = null;
    throw err;
  });
```

## Unwired Functionality
- **`dist/index.js`**: Contains the unfixed bundled code at lines 64719-64735. The build
  step (`bun run build`) must be run after the fix; however this is already enforced by
  `prepublishOnly: "bun run build"`. Not a gap in the plan, just requires a rebuild.
- **`isGrammarAvailable()`**: Does NOT call `initTreeSitter()` — confirmed. Not affected.
- **`diagnose-service.ts`**: Does NOT call `initTreeSitter()` — confirmed. Not affected.

## Edge Cases
1. **Stale rejected promise** (addressed as required revision above).
2. **`clearParserCache()` called during in-flight init**: The in-flight awaiter retains
   its reference to the old promise and completes normally; next caller gets fresh init.
   Acceptable behavior, not a regression.
3. **Per-language concurrent `loadGrammar()` cache race**: Two concurrent calls for the
   SAME language both cache-missing will both call `Language.load()` and both write to
   `parserCache`. The second silently orphans the first parser. Low severity (no crash,
   just wasted memory). Not the reported bug. Correctly out of scope.
4. **Windows locateFile backslash paths (RULED OUT)**: `path.join(grammarsDir, scriptName)`
   produces backslash paths on Windows. However `isFileURI` at bundle line 63069 checks
   `filename.startsWith("file://")` — a native Windows path (`C:\...`) does not match,
   so `fs.readFileSync` receives the native backslash path directly. Node.js on Windows
   accepts both separators. This is NOT a contributing cause.

## Test Gaps
1. **Missing concurrent-init regression test** (blocker): No existing test calls
   `loadGrammar()` concurrently via `Promise.all`. A test for the fixed behavior must be
   added as part of this fix.
2. **Missing init-failure retry test** (recommended): No test verifies that after a failed
   init (simulated), `clearParserCache()` allows a successful retry.
3. **No dist sync gate**: Tests import from `src/`, not `dist/`. No CI check enforces
   dist is in sync. Not a blocker for this fix, but a known gap.

## Scope Risk
Tight scope. No public API changes, no config changes, no migration. `clearParserCache()`
signature is unchanged. Risk is low.

## Required Revisions
- **Required**: Add `.catch(err => { treeSitterInitPromise = null; throw err; })` to the
  promise so transient failures allow retry instead of caching the rejection permanently.
- **Required**: Add a concurrent-init regression test calling
  `Promise.all([loadGrammar('javascript'), loadGrammar('python'), loadGrammar('typescript')])`
  and asserting all three resolve without error.
- **Recommended**: Add a test for clearParserCache() resetting a previously-rejected init
  promise (simulate failure, call clearParserCache(), verify fresh init attempt works).
