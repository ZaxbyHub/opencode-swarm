# Localization Log

## Active Hypotheses

### H1: Missing wasm files in published package
- Status: RULED_OUT
- Suspected: `package.json` `files` field omits dist/lang/grammars
- Evidence for: user sees ENOENT for the wasm file
- Evidence against: `npm pack --dry-run` confirms ALL 20 wasm files are included; 
  `.gitignore` does not exclude `dist/lang/grammars/`; no `.npmignore`
- Verdict: DISPROVED

### H2: Corrupted path construction (`getGrammarsDirAbsolute` returns `.d.ts` paths)
- Status: RULED_OUT
- Suspected: `import.meta.url` resolves to a `.d.ts` file, not `dist/index.js`
- Evidence for: screenshot shows paths like `registry.d.ts\lang\grammars\tree-sitter.wasm`
- Evidence against:
  1. Only two JS files exist in dist/ (`dist/index.js`, `dist/cli/index.js`);
     no individual JS files alongside `.d.ts` files
  2. In the bundle, `import.meta.url` is fixed to the bundle file's URL
  3. `getGrammarsDirAbsolute()` at bundle lines 64751-64756 is identical to source
     and correctly computes `dist/lang/grammars` when called from `dist/index.js`
  4. The "corrupted paths" in the screenshot are a UI display artifact: OpenCode's
     left panel shows `.d.ts` file diffs with `+16`/`+13` line-count badges at the
     same y-position as the terminal error text in the right panel; the actual ENOENT
     path in every error is `dist\lang\grammars\tree-sitter.wasm`
- Verdict: DISPROVED

### H3: Race condition — concurrent `Parser.init()` calls
- Status: CONFIRMED
- Suspected file: `src/lang/runtime.ts:31-53`
- Evidence for:
  1. `treeSitterInitialized` starts `false`; multiple concurrent `loadGrammar()` calls
     all check it before any one completes → all call `TreeSitterParser.init()` simultaneously
  2. web-tree-sitter's Emscripten module is not designed for concurrent initialization;
     concurrent `Module2(...)` invocations corrupt each other's shared state
  3. Three separate error pairs in screenshot (consistent with 3 concurrent callers)
  4. `treeSitterInitialized = true` is only reached AFTER `await TreeSitterParser.init()`
     completes; if init fails, the flag is never set, and every subsequent call retries
  5. ENOENT in Emscripten context: when two module init sequences race, one may half-set
     up the virtual FS state that the other then finds corrupted/absent
  6. No existing test covers concurrent `loadGrammar()` calls
- Evidence against: none found
- Verdict: CONFIRMED — root cause of all screenshot errors

## Files Read
- `src/lang/runtime.ts` — full file; lines 31-53 = `initTreeSitter()`, lines 111-123 = 
  `getGrammarsDirAbsolute()`, lines 134-184 = `loadGrammar()`
- `dist/index.js:62930-62990` — web-tree-sitter Emscripten module bootstrap
- `dist/index.js:63163-63166` — tree-sitter.wasm locateFile default
- `dist/index.js:64719-64756` — bundled `initTreeSitter()` and `getGrammarsDirAbsolute()`
- `package.json` — `files`, `scripts`, `prepublishOnly`
- `tsconfig.json` — `rootDir=src`, `outDir=dist`, `emitDeclarationOnly=true`
- `.gitignore` — no exclusion of `dist/` or `dist/lang/grammars/`
- `scripts/repro-704.mjs` — existing regression harness (not related to this bug)
- `tests/unit/lang/runtime-security.test.ts` — existing init/cache tests

## Searches Run
- `grep -n "treeSitterInitialized\|initTreeSitter" src/lang/runtime.ts` — confirmed flag pattern
- `find dist -name "*.wasm"` — 20 files, all present
- `find dist -name "*.js"` — only 2 bundles: `dist/index.js`, `dist/cli/index.js`
- `npm pack --dry-run | grep wasm` — all 20 wasm files in package
- `grep -n "import.meta.url\|new URL\|locateFile" dist/index.js` — confirmed correct path in bundle

## Ruled-Out Paths
- Missing wasm files (packaging): disproved by npm pack
- Windows path separator bug: `getGrammarsDirAbsolute()` uses `.replace(/\\/g, '/')` 
  before suffix checks; Windows paths correctly handled
- Bun bundler import.meta.url issue: bundle uses `import.meta.url` normally; Node.js 
  evaluates it as the bundle file's URL
- CLI vs main bundle confusion: both produce correct `dist/lang/grammars` path
  (CLI uses `..` traversal from `/cli/` which works correctly)
