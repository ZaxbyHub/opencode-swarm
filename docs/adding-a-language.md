# Adding a Language

This guide explains how to add first-class language support to opencode-swarm. The plugin's language layer (introduced in v7.x) separates **data** (build/test/lint metadata) from **behavior** (how to detect projects, select test frameworks, extract imports). Adding a language is a small, well-bounded change.

## TL;DR

- A new language with **default behavior**: edit `src/lang/profiles.ts`, add a `LanguageProfile` entry. No backend file needed.
- A new language with **custom behavior** (e.g., a project-specific framework heuristic, custom import-graph extractor): also add a file under `src/lang/backends/<id>.ts` and one import line in `src/lang/backends/index.ts`.

The repo already ships:
- 12 profiles (TypeScript, Python, Rust, Go, Java, Kotlin, C#, C/C++, Swift, Dart, Ruby, PHP) in `src/lang/profiles.ts`.
- 20 tree-sitter parser entries in `src/lang/registry.ts`.
- 3 concrete backends (TypeScript, Python, Go) in `src/lang/backends/`.

## Architecture

Three registries collaborate:

| Registry | File | Purpose | Entries |
|---|---|---|---|
| `LANGUAGE_REGISTRY` | `src/lang/profiles.ts` | High-level language profiles: build commands, test frameworks, linters, audit tooling, SAST rules, prompt constraints, tree-sitter grammar id. | 12 |
| `languageDefinitions` | `src/lang/registry.ts` | Fine-grained tree-sitter parser entries. Intentionally has a different id space (e.g. `.tsx` → `'tsx'`, `.c` → `'c'`) because parsers are grammar-specific while profiles are dispatch-target-specific. | 20 |
| `LANGUAGE_BACKEND_REGISTRY` | `src/lang/registry-backend.ts` | Per-language behavior overrides — `selectTestFramework`, `extractImports`, etc. When no backend is registered for a language id, the default backend (`src/lang/default-backend.ts`) is synthesized from the profile. | 3 |

The dispatch entry point is `pickBackend(dir)` in `src/lang/dispatch.ts` — walks up to the nearest manifest, runs language detection, returns the registered (or defaulted) backend for the dominant language. Bounded LRU cache keyed by manifest content hash.

## Step 1: Add the LanguageProfile

Open `src/lang/profiles.ts` and call `LANGUAGE_REGISTRY.register({...})` with your new language. Schema in `LanguageProfile` interface (top of file). Example:

```ts
LANGUAGE_REGISTRY.register({
  id: 'zig',
  displayName: 'Zig',
  tier: 2,
  extensions: ['.zig'],
  treeSitter: {
    grammarId: 'zig',
    wasmFile: 'tree-sitter-zig.wasm',
    commentNodes: ['line_comment', 'doc_comment'],  // optional but recommended
  },
  build: {
    detectFiles: ['build.zig'],
    commands: [
      { name: 'zig build', detectFile: 'build.zig', cmd: 'zig build', priority: 10 },
    ],
  },
  test: {
    detectFiles: ['build.zig'],
    frameworks: [
      { name: 'zig test', detect: 'build.zig', cmd: 'zig build test', priority: 10 },
    ],
  },
  lint: {
    detectFiles: ['build.zig'],
    linters: [
      { name: 'zig fmt --check', detect: 'build.zig', cmd: 'zig fmt --check .', priority: 10 },
    ],
  },
  audit: { detectFiles: [], command: null, outputFormat: 'json' },
  sast: { nativeRuleSet: null, semgrepSupport: 'none' },
  prompts: {
    coderConstraints: [
      'Use `zig fmt` formatting; line length 120 by default',
      'Prefer comptime over runtime polymorphism',
    ],
    reviewerChecklist: [
      'Verify error-set unions are exhaustive in `try` chains',
      'Check `defer` ordering for cleanup correctness',
    ],
  },
});
```

Constraints enforced by `LanguageRegistry.register()`:
- Profile `id` must be unique (throws if duplicate).
- File extensions must not conflict with another non-`parserOnly` profile (throws if collision). Mark a profile `parserOnly: true` if it should provide tree-sitter parsing without claiming dispatch.

## Step 2: Add the parser registry entry (for tree-sitter)

If your language has a tree-sitter grammar, also add an entry to `src/lang/registry.ts`'s `languageDefinitions` array so `getLanguageForExtension(ext)` returns the parser metadata. Use the same id as the profile when possible:

```ts
{ id: 'zig', extensions: ['.zig'], commentNodes: ['line_comment', 'doc_comment'] },
```

Drop the WASM grammar into `src/lang/grammars/` (filename matches `treeSitter.wasmFile`). The grammars directory is not bundled — it's copied to `dist/lang/grammars/` by `scripts/copy-grammars.ts`, run as part of `bun run build`.

The parity test (`tests/unit/lang/profile-registry-parity.test.ts`) asserts that every shared id between the two registries agrees on `commentNodes`. Update the documented asymmetry list in that file if your language has a profile but no parser (or vice versa).

## Step 3 (optional): Add a backend for custom behavior

Default behavior (`src/lang/default-backend.ts`) covers most languages: highest-priority framework whose detect file exists AND whose binary is on PATH wins. Override only when a language has a non-default heuristic.

Examples:
- **TypeScript backend** (`src/lang/backends/typescript.ts`) overrides `selectTestFramework` to honor `package.json#scripts.test` first, then `devDependencies` — neither is registry-driven.
- **Python backend** (`src/lang/backends/python.ts`) overrides `extractImports` with Python regexes (`import x`, `from x import y`).
- **Go backend** (`src/lang/backends/go.ts`) overrides `extractImports` with Go's single-line + grouped import syntax.

To add a backend:

1. Create `src/lang/backends/<your-id>.ts`. Use `python.ts` as a small template. Export a `build<Id>Backend(): LanguageBackend` factory.
2. In `src/lang/backends/index.ts`, add an `import { build<Id>Backend } from './<your-id>';` and a `LANGUAGE_BACKEND_REGISTRY.register(build<Id>Backend());` line in `registerAllBackends`.

### Backend invariants (enforced at PR time)

The `tests/unit/lang/backend-purity.test.ts` static-analysis test will fail your PR if your backend file:

- Imports from `bun:...` (Invariant 2 — runtime portability; the plugin must run under Node, not just Bun).
- References the global `Bun.*` API.
- Imports `bunSpawn` / `bunSpawnSync` or `node:child_process`'s `spawn` / `spawnSync`. **Backends never spawn.** They return command-arrays only; the single spawn site stays in `src/tools/test-runner.ts` and `src/build/discovery.ts:isCommandAvailable` (which already satisfies Invariant 3).

For binary-availability checks, import `isCommandAvailable` from `../../build/discovery` — that helper's invariant-3 properties (cwd, stdin: 'ignore', timeout, bounded stdio) are validated by `tests/unit/build/discovery.test.ts`.

## Testing your language

Three tests should be added or updated:

1. **Profile parity** — `tests/unit/lang/profile-registry-parity.test.ts` asserts the asymmetry list. If your new language is in both registries (most common case), bump the count assertions and remove your id from `REGISTRY_ONLY_DOCUMENTED` or `PROFILE_ONLY_DOCUMENTED` if it appears there.

2. **Tier profile test** — add an entry to `tests/unit/lang/profiles-tier{1,2,3}.test.ts` matching your language's tier.

3. **Backend behavior** (if you added one) — write tests parallel to `tests/unit/lang/python-go-backends.test.ts` covering every supported import shape, framework heuristic, etc.

The full lang-test suite must pass per-file isolated AND in a single process (cross-file singleton pollution check):

```bash
for f in tests/unit/lang/*.test.ts; do bun --smol test "$f" --timeout 30000; done
bun --smol test tests/unit/lang
```

## Architect prompt placeholders

The architect prompt's `{{PROJECT_LANGUAGE}}`, `{{BUILD_CMD}}`, `{{TEST_CMD}}`, `{{LINT_CMD}}`, and `{{ENTRY_POINTS}}` placeholders are populated at session-init from your profile via `src/agents/project-context.ts:buildProjectContext`. You don't need to add anything for these to work — adding the profile is sufficient.

If your language's `prompts.coderConstraints` or `prompts.reviewerChecklist` are non-empty, they're rendered as bullet lists into `{{CODER_CONSTRAINTS}}` and `{{REVIEWER_CHECKLIST}}` placeholders for any agent prompt that references them.

## Common pitfalls

- **Tree-sitter grammar mismatch** — `treeSitter.grammarId` must match the language constructor name in the WASM (e.g., `tree-sitter-c-sharp.wasm` exports `csharp`, not `c-sharp`). The runtime-wasm-map test (`tests/unit/lang/runtime-wasm-map.test.ts`) catches mismatches.
- **Extension collision** — if another profile already claims your extension, the registry throws at registration time with a clear error. Pick a different extension or mark one profile `parserOnly: true`.
- **Forgotten `commentNodes`** — optional in the type but enforced in the parity test for production profiles. Without it, comment-stripping in ast-diff and syntax-check will not work for your language.
- **Backend importing `bun:...`** — even a `bun:test` import in a backend file will fail backend-purity. Backends are bundled into the Node-target `dist/index.js` and must not have Bun-only dependencies.
- **Unbounded subprocess** — the bait-and-switch error: a hand-written `bunSpawn` call in a backend would silently violate Invariant 3. The purity test rejects it. If you need to probe a binary, use `isCommandAvailable`.

## Roll-out checklist

- [ ] `LANGUAGE_REGISTRY.register({...})` entry added in `src/lang/profiles.ts`.
- [ ] `languageDefinitions` entry added in `src/lang/registry.ts` (if tree-sitter grammar is shipped).
- [ ] WASM grammar in `src/lang/grammars/<filename>.wasm`.
- [ ] (Optional) Backend file in `src/lang/backends/<id>.ts` plus registration line in `src/lang/backends/index.ts`.
- [ ] Tests added/updated: profile-registry-parity, profiles-tier{1,2,3}, backend-behavior (if applicable).
- [ ] Full test pass: `bun --smol test tests/unit/lang` in a single process.
- [ ] Build clean: `bun run build` + `node --input-type=module -e "await import('./dist/index.js')"` returns the v1 plugin shape.
- [ ] Biome clean: `bunx biome ci .`.
- [ ] Typecheck clean: `bun run typecheck`.
