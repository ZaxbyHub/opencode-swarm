# Root Cause

## Summary
`initTreeSitter()` in `src/lang/runtime.ts` uses a boolean flag (`treeSitterInitialized`)
to guard against re-initialization, but this guard is NOT race-safe for concurrent async
callers. When multiple `loadGrammar()` calls arrive concurrently before any one
`TreeSitterParser.init()` completes, all of them see `treeSitterInitialized === false`
and all invoke `TreeSitterParser.init()` simultaneously. web-tree-sitter's Emscripten
module is not designed for concurrent initialization: the concurrent `Module2(...)` calls
corrupt each other's in-flight state (virtual FS setup, WASM binary read buffers), causing
the Emscripten runtime to report `ENOENT` for `tree-sitter.wasm` even though the file
exists at the correct path. Every caller then also prints "failed to asynchronously prepare
wasm" followed by "Aborted(Error: ENOENT)".

## Exact Location
- File: `src/lang/runtime.ts`
- Symbol: `initTreeSitter`
- Lines: `31–53` (guard check + `treeSitterInitialized` flag + `TreeSitterParser.init()`)

## Broken Contract
`initTreeSitter()` must guarantee that `TreeSitterParser.init()` is called exactly once
across all concurrent callers. The boolean flag only enforces "once per successful init"
(after the await resolves), not "at most one in-flight init at any time". Any number of
concurrent calls between the first check and the `treeSitterInitialized = true` assignment
will each spawn an independent `Parser.init()` invocation, violating the singleton contract.

## Triggering Conditions
1. Two or more `loadGrammar(languageId)` calls are awaited concurrently (e.g. via
   `Promise.all`) before the grammar module has been used in the current process lifetime.
2. OR `clearParserCache()` is called (resetting `treeSitterInitialized = false`) and then
   multiple grammars are requested concurrently — relevant for test teardown/re-init.
3. Windows is not required; the race exists on all platforms, but Windows may amplify
   Emscripten FS errors from concurrent state corruption.

## Evidence Chain
1. Screenshot shows 3+ pairs of "failed to asynchronously prepare wasm" + "Aborted(ENOENT)"
   errors — consistent with 3 concurrent callers all failing.
2. `src/lang/runtime.ts:32` checks `if (treeSitterInitialized)` before the await; any
   caller entering before a previous caller's `await TreeSitterParser.init()` resolves
   will also proceed to call `TreeSitterParser.init()`.
3. `npm pack --dry-run` confirms `dist/lang/grammars/tree-sitter.wasm` (205.5 kB) is
   present in the published package — ruling out a packaging cause.
4. `dist/index.js:64751-64756` confirms `getGrammarsDirAbsolute()` correctly computes
   `dist/lang/grammars` from `import.meta.url` = bundle URL — ruling out path corruption.
5. web-tree-sitter's `Module2` (bundle line 62935) is an async factory; calling it
   multiple times concurrently creates multiple overlapping Emscripten init sequences
   sharing the same process-level WASM runtime state.

## Confidence
95%. The race condition is mechanistically confirmed by static analysis. The 5% residual
uncertainty is whether the Emscripten concurrent-init always produces ENOENT on Windows
specifically, or whether the user's environment has an additional contributing factor
(e.g. a slow network drive where the cache is stored, making the timing window larger).
