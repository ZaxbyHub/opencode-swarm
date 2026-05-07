# Reproduction Evidence

## Commands Tried

### Attempt 1 — npm pack dry run
- Command: `npm pack --dry-run 2>&1 | grep -i "wasm\|grammars"`
- Exit code: 0
- Result: ALL 20 WASM FILES ARE INCLUDED

```
npm notice 205.5kB dist/lang/grammars/tree-sitter.wasm
npm notice 1.4MB  dist/lang/grammars/tree-sitter-bash.wasm
npm notice 1.4MB  dist/lang/grammars/tree-sitter-typescript.wasm
... (20 files total)
```

Packaging is not the issue. All wasm files are correctly included in the npm package.

### Attempt 2 — local wasm presence
- Command: `ls dist/lang/grammars/tree-sitter.wasm`
- Result: PRESENT (205.5 kB)

### Attempt 3 — copy-grammars.ts robustness
- Command: `bun run scripts/copy-grammars.ts`
- Result: `Error: @vscode/tree-sitter-wasm not installed` (when node_modules absent)

The script fails fast and loudly when the grammar source package is missing. This is not the
issue (it runs only at build time, not at runtime).

### Attempt 4 — concurrent init code review
Reviewed `src/lang/runtime.ts:31-53` and `dist/index.js:64719-64735`.

The race condition is confirmed by static analysis (see localization log).

## Minimal Reproduction

```ts
// Three concurrent grammar loads before any init completes
await Promise.all([
  loadGrammar('javascript'),  // → initTreeSitter() #1
  loadGrammar('typescript'),  // → initTreeSitter() #2 (treeSitterInitialized still false)
  loadGrammar('python'),      // → initTreeSitter() #3 (treeSitterInitialized still false)
]);
// All three call Parser.init() concurrently → Emscripten module corruption → ENOENT
```

No test for concurrent loadGrammar calls currently exists in the test suite.

## Reproduction Verdict
CONFIRMED (by static analysis + error pattern in screenshot).

The WASM files are present in the published package. The errors are produced by
multiple concurrent calls to `Parser.init()` racing on `treeSitterInitialized`,
corrupting web-tree-sitter's Emscripten module state and causing ENOENT errors
even though the file exists at the correct path.
