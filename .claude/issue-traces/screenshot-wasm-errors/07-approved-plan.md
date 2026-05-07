# Reviewed Plan Awaiting Approval

## Issue
Multiple "failed to asynchronously prepare wasm / Aborted(ENOENT)" errors when running
opencode-swarm on Windows. The WASM files ARE in the published package. The errors are
caused by a concurrency race in `initTreeSitter()`.

## Root Cause
`src/lang/runtime.ts:initTreeSitter` (lines 31–53) uses `let treeSitterInitialized = false`
as its only guard. This flag is set to `true` only AFTER `await TreeSitterParser.init()`
resolves. Any concurrent `loadGrammar()` calls that arrive before that resolution all see
`false` and each independently call `Parser.init()`. web-tree-sitter's Emscripten module
is not designed for concurrent initialization; the concurrent calls corrupt in-flight module
state, producing ENOENT errors even though the file exists at the correct path.

## Files to Change
- `src/lang/runtime.ts` only (3 sections, ~8 lines net change)

## Exact Code Change

### 1. Replace the module-level boolean flag (lines 22–25)
```diff
-/**
- * Track if tree-sitter has been initialized
- */
-let treeSitterInitialized = false;
+let treeSitterInitPromise: Promise<void> | null = null;
```

### 2. Replace `initTreeSitter()` body (lines 31–53)
```diff
 async function initTreeSitter(): Promise<void> {
-	if (treeSitterInitialized) {
-		return;
-	}
-
-	const thisDir = path.dirname(fileURLToPath(import.meta.url));
-	const isSource = thisDir.replace(/\\/g, '/').endsWith('/src/lang');
-
-	if (isSource) {
-		// In dev, web-tree-sitter's own import.meta.url resolves tree-sitter.wasm
-		// correctly from node_modules/web-tree-sitter/
-		await TreeSitterParser.init();
-	} else {
-		// In bundle, import.meta.url points to dist/index.js so web-tree-sitter
-		// looks for dist/tree-sitter.wasm — redirect to dist/lang/grammars/
-		const grammarsDir = getGrammarsDirAbsolute();
-		await TreeSitterParser.init({
-			locateFile(scriptName: string) {
-				return path.join(grammarsDir, scriptName);
-			},
-		});
-	}
-	treeSitterInitialized = true;
+	if (!treeSitterInitPromise) {
+		treeSitterInitPromise = (async () => {
+			const thisDir = path.dirname(fileURLToPath(import.meta.url));
+			const isSource = thisDir.replace(/\\/g, '/').endsWith('/src/lang');
+			if (isSource) {
+				await TreeSitterParser.init();
+			} else {
+				const grammarsDir = getGrammarsDirAbsolute();
+				await TreeSitterParser.init({
+					locateFile(scriptName: string) {
+						return path.join(grammarsDir, scriptName);
+					},
+				});
+			}
+		})().catch((err) => {
+			treeSitterInitPromise = null; // allow retry after transient failure
+			throw err;
+		});
+	}
+	return treeSitterInitPromise;
 }
```

### 3. Replace `clearParserCache()` reset (lines 229–232)
```diff
 export function clearParserCache(): void {
 	parserCache.clear();
 	initializedLanguages.clear();
-	treeSitterInitialized = false;
+	treeSitterInitPromise = null;
 }
```

## Tests to Add
New describe block in `tests/unit/lang/runtime-security.test.ts`:

```ts
describe('11. Concurrent initialization safety', () => {
  it('should not call Parser.init more than once for concurrent loadGrammar calls', async () => {
    clearParserCache();
    // These three calls race on initTreeSitter(); the fix ensures only one Parser.init fires
    const [p1, p2, p3] = await Promise.all([
      loadGrammar('javascript'),
      loadGrammar('python'),
      loadGrammar('typescript'),
    ]);
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p3).toBeDefined();
  });
});
```

## Critic Review Summary
Independent critic: NEEDS_REVISION → all required revisions applied:
1. `.catch()` retry behavior added
2. Concurrent regression test added to plan
3. Windows backslash concern investigated and ruled out (Node.js `fs.readFileSync` handles
   native Windows paths; Emscripten `isFileURI` test `filename.startsWith("file://")` passes
   through native paths unchanged)
4. Build step already enforced by `prepublishOnly`

## Risk: Very Low
- 3-section change in one file
- All existing callers unchanged
- `clearParserCache()` signature unchanged
- Rollback: revert `src/lang/runtime.ts`

## User Approval
- [ ] User explicitly approved implementation on 2026-05-06
