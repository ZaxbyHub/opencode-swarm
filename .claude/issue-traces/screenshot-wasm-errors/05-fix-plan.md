# Fix Plan

## Issue
Multiple concurrent `loadGrammar()` calls all invoke `TreeSitterParser.init()` simultaneously
because `initTreeSitter()` guards with a boolean flag that is only set AFTER the async init
completes. This produces ENOENT WASM errors on the user's Windows machine.

## Root Cause
`src/lang/runtime.ts:initTreeSitter` — boolean flag guard is not concurrent-safe.

## Candidate Fixes

| Candidate | Approach | Files | Pros | Cons | Verdict |
|---|---|---|---|---|---|
| A | Replace `treeSitterInitialized: boolean` with `treeSitterInitPromise: Promise<void> \| null`; all concurrent callers return/await the same promise | `src/lang/runtime.ts` | Canonical async singleton; zero overhead after first call; preserves all existing behavior; minimal diff | None | **selected** |
| B | Add a `treeSitterInitializing: boolean` second flag to block concurrent callers; spin-poll | `src/lang/runtime.ts` | Simple mental model | Busy-wait is wasteful; not idiomatic JS; doesn't actually block — would need real semaphore | rejected |
| C | Use a Mutex from a library (e.g. `async-mutex`) | `src/lang/runtime.ts`, `package.json` | Battle-tested | New runtime dependency for a 5-line fix; over-engineered | rejected |
| D | Serialize all grammar loads through a queue | `src/lang/runtime.ts` | Eliminates all concurrency in loadGrammar | Unnecessarily serializes unrelated grammar loads after init completes; hurts performance | rejected |

## Selected Fix

Replace the `treeSitterInitialized: boolean` module-level variable with
`treeSitterInitPromise: Promise<void> | null`. On the first call, create the promise and
store it. All subsequent concurrent callers return the same stored promise. This is the
idiomatic JavaScript singleton-init pattern.

**Before** (`src/lang/runtime.ts:25-53`):
```ts
let treeSitterInitialized = false;

async function initTreeSitter(): Promise<void> {
	if (treeSitterInitialized) {
		return;
	}
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const isSource = thisDir.replace(/\\/g, '/').endsWith('/src/lang');
	if (isSource) {
		await TreeSitterParser.init();
	} else {
		const grammarsDir = getGrammarsDirAbsolute();
		await TreeSitterParser.init({
			locateFile(scriptName: string) {
				return path.join(grammarsDir, scriptName);
			},
		});
	}
	treeSitterInitialized = true;
}
```

**After** (critic revision applied — null-out on failure to allow retry):
```ts
let treeSitterInitPromise: Promise<void> | null = null;

async function initTreeSitter(): Promise<void> {
	if (!treeSitterInitPromise) {
		treeSitterInitPromise = (async () => {
			const thisDir = path.dirname(fileURLToPath(import.meta.url));
			const isSource = thisDir.replace(/\\/g, '/').endsWith('/src/lang');
			if (isSource) {
				await TreeSitterParser.init();
			} else {
				const grammarsDir = getGrammarsDirAbsolute();
				await TreeSitterParser.init({
					locateFile(scriptName: string) {
						return path.join(grammarsDir, scriptName);
					},
				});
			}
		})().catch((err) => {
			treeSitterInitPromise = null; // allow retry after transient failure
			throw err;
		});
	}
	return treeSitterInitPromise;
}
```

`clearParserCache()` (line 229) also resets `treeSitterInitialized = false`. It must instead
reset `treeSitterInitPromise = null` to keep the reset behaviour for tests:

```ts
export function clearParserCache(): void {
	parserCache.clear();
	initializedLanguages.clear();
	treeSitterInitPromise = null;  // was: treeSitterInitialized = false
}
```

Also remove the now-unused `treeSitterInitialized` variable and the export 
`getInitializedLanguages()` does NOT rely on it, so no further changes needed there.

## Files Expected to Change
- `src/lang/runtime.ts` — replace `treeSitterInitialized` flag with promise memoization

## Impact Analysis
- **Callers/importers**: `loadGrammar()` and `isGrammarAvailable()` (both in runtime.ts);
  `loadGrammar` is imported in `src/lang/registry.ts`, `src/tools/syntax-check.ts`,
  `src/diff/ast-diff.ts`; no caller is affected by the internal init change.
- **Tests/fixtures**: `clearParserCache()` is called in test teardown — it still resets
  init state. Tests that check `loadGrammar` behavior are unchanged.
- **Config/docs**: No config surfaces affected.
- **API/UI/CLI**: No public API change. `clearParserCache` signature unchanged.
- **Persistence/migrations**: None.
- **Security/privacy**: No change.
- **Concurrency/idempotency**: Fix IS the concurrency correction — parallel `loadGrammar`
  calls now safely share one init.

## Edge Cases
- **Init failure + retry**: If `TreeSitterParser.init()` throws, the stored promise rejects.
  Subsequent callers will get the same rejected promise (no retry). This is correct behavior:
  a missing wasm file should fail loudly, not silently retry forever.
- **`clearParserCache()` during in-flight init**: Resetting `treeSitterInitPromise = null`
  while an init is still awaited by a caller is a test-only scenario. The in-flight awaiter
  will still resolve against the old promise; the next caller after `clearParserCache()`
  will get a new init. Acceptable.
- **Dev mode (`isSource = true`)**: Unchanged behavior. Branch still correctly calls
  `TreeSitterParser.init()` without a locateFile callback.

## Test Plan
1. **New concurrent-init regression test** (required by critic) in `tests/unit/lang/runtime-security.test.ts`:
   - After `clearParserCache()`, call `Promise.all([loadGrammar('javascript'), loadGrammar('python'), loadGrammar('typescript')])`.
     Assert all three resolve without error. This directly tests the race-condition fix.
2. **New retry-after-failure test** (recommended by critic): Simulate a failed init by calling
   `clearParserCache()` and mocking `Parser.init` to throw once, then resolving on second call.
   Assert that the second `loadGrammar()` attempt succeeds (or at minimum attempts a fresh init).
3. **Existing tests**: Run full `bun test tests/unit/lang/` suite; all must pass without change.
4. **Type check**: `bun run typecheck`.
5. **Build**: `bun run build` (verifies bundle compiles correctly with the new variable type).

## Unwired Functionality Checklist
- [x] Entry point reaches new/changed logic — `loadGrammar()` calls `initTreeSitter()`
- [x] All callers use updated contract correctly — init is now transparent/internal
- [x] Error path is observable — rejected promise propagates to `loadGrammar()` caller
- [x] No new branch lacks tests — concurrent test added in test plan
- [x] Comments match actual behavior — existing comment "Track if tree-sitter has been initialized" will be updated

## Risk and Rollback
- Risk: Very low. The change is a 3-line logic swap preserving identical behavior for the
  serial case, while fixing the concurrent case. No external dependencies changed.
- Rollback: Revert `src/lang/runtime.ts` to previous state.

## Critic Status
- Critic verdict: NEEDS_REVISION → resolved
- Required revisions applied:
  1. Added `.catch(err => { treeSitterInitPromise = null; throw err; })` to allow retry after failure
  2. Added concurrent-init regression test to test plan (Promise.all with 3 grammars)
  3. Confirmed Windows backslash concern is NOT a real issue: `isFileURI` at bundle:63069
     checks `filename.startsWith("file://")` — native Windows backslash paths do NOT match,
     so `fs.readFileSync` receives the correct Windows path. Ruled out.
  4. Build step already enforced by `prepublishOnly: "bun run build"` — not a gap.
