---
name: safe-extraction
description: >
  Apply when extracting code from a large monolith file into submodules. Covers barrel re-exports,
  _internals DI seam proxy patterns, CI invariant allowlist updates, and cross-file test verification.
  Prevents CI failures, broken imports, and test regressions from code extraction.
effort: medium
generated_from_knowledge: []
source_knowledge_ids: ['c276dc6e-dc46-4390-a616-46321324a5df']
generated_at: 2026-06-14T16:50:00Z
confidence: 0.8
status: active
version: 3
skill_origin: generated
provenance_note: >
  Source knowledge ID backfilled from a new swarm knowledge entry capturing this skill's core lesson.
  Metadata and body preserved; version bumped to reflect provenance update.
---

# Safe Extraction Protocol

Follow every step in order. Do not skip steps.

## When to use this skill

- A source file exceeds team-agreed size thresholds (this repo uses <2000 lines per file per FR-005) and needs splitting
- A subsystem (destructive-command, worktree-isolation, etc.) is being extracted to its own file
- Code is being moved from one module to another without changing behavior

**Benefit:** Prevents the three most common extraction failure modes:
1. CI invariant check failures (new file paths not in allowlists)
2. Broken _internals DI seams (test mocks stop working)
3. Cross-file test regressions (other test files that consume the module)

## Step 0 — Pre-extraction audit

Before moving ANY code, inventory every path-scoped artifact that references the source file:

### 0a. CI invariant scripts
```bash
grep -rn "<source-file-path>" scripts/ .github/workflows/
```
Check:
- `LEGACY_EXEMPTS` arrays (e.g., `check-invariants.sh`)
- Path-scoped lint/scan configurations
- GitHub Actions path filters

### 0b. Mock allowlists
```bash
grep -rn "<source-file-path>" scripts/mock-allowlist.txt
```

### 0c. Test file inventory
```bash
grep -rln "from.*<source-module>" src/ tests/ --include="*.test.ts"
grep -rln "vi.spyOn.*<source-module>" src/ tests/ --include="*.test.ts"
grep -rln "_internals.*<source-module>" src/ tests/ --include="*.test.ts"
```
Record EVERY test file that imports or spies on the source module. These must all pass after extraction.

Prefer the `imports` tool or `repo_map` action for comprehensive consumer discovery. Grep catches direct string matches but misses `require()` imports, dynamic `import()`, and re-exports through intermediate modules. Use grep as a secondary cross-check.

### 0d. Import graph
```
Use the imports tool or repo_map to find all consumers of exports from the source file.
```

## Step 1 — Create the extracted module

1. Move the code block(s) to the new file(s)
2. Move all supporting types, constants, and helper functions used exclusively by the extracted code
3. Add necessary imports to the new file (from external dependencies)

## Step 2 — Create barrel re-export (if preserving public API)

If consumers import from the original path, keep the original file as a barrel:

```typescript
// src/hooks/guardrails.ts (barrel — preserves import path)
// Use EXPLICIT named exports, not `export *`, to avoid naming conflicts
// when multiple submodules export symbols with the same name.
export {
  _internals,
  createGuardrailsHooks,
  enforceSpecDriftGate,
} from './guardrails/index';
export {
  buildEffectiveRules,
  checkFileAuthority,
  getGlobMatcher,
} from './guardrails/file-authority';
export {
  createToolBeforeHandler,
  normalizeToolInput,
} from './guardrails/tool-before';
// etc.
```

**Verify:** `bun run build` succeeds. All existing imports still resolve.

## Step 3 — Handle _internals DI seams

If the source module exports `_internals` for test injection:

### 3a. Direct functions stay in source _internals
Functions that remain in the source file stay as direct entries:
```typescript
export const _internals = {
  resolveEvidenceTaskId,      // still in this file
  loadPlanJsonOnly,           // still in this file
  // ...
};
```

### 3b. Extracted functions need getter/setter proxies
Functions moved to the extracted module need proxy entries so test mocks propagate:
```typescript
import { _internals as _extractedInternals } from './extracted-module';

export const _internals = {
  resolveEvidenceTaskId,      // direct
  get extractedFn() {
    return _extractedInternals.extractedFn;    // proxy to extracted module
  },
  set extractedFn(v) {
    _extractedInternals.extractedFn = v;       // allow test injection
  },
};
```

The extracted module must ALSO export its own `_internals`:
```typescript
// extracted-module.ts
export const _internals = {
  extractedFn,
  otherExtractedFn,
};
```

**Type annotation:** Always include an explicit type annotation on `_internals` objects to override `as const` readonly inference. Without it, `as const` makes properties `readonly` and test injection (`_internals.fn = mockFn`) fails at compile time:
```typescript
// GOOD — explicit type annotation allows mutation
export const _internals: {
  extractedFn: typeof extractedFn;
  otherFn: typeof otherFn;
} = {
  extractedFn,
  otherFn,
};
```

**CRITICAL:** The extracted module's own production code must call mockable functions through `_internals.fn(...)`, NOT through the direct function reference. If `extractedFn` internally calls `otherExtractedFn`, it must use `_internals.otherExtractedFn()` — otherwise test mocks set on `_internals` won't intercept the internal call. This is the same pattern the parent module follows.

**Verify:** Run ALL test files from Step 0c — not just the one explicitly in scope.

### 3c. Alternative: Factory parameter pattern (no _internals proxy needed)

When splitting a factory function into handler files (NOT extracting a subsystem with its own _internals), the getter/setter proxy is unnecessary. Instead:

1. Handler files export factory functions that receive dependencies as parameters
2. The orchestrator file calls these factories, passing closure-scoped config
3. The barrel re-exports only the top-level orchestrator API

```typescript
// guardrails/tool-before.ts — handler file
export function createToolBeforeHandler(cfg: Config, deps: Deps) {
  // Receives all dependencies as parameters — no _internals needed
  return function toolBefore(input: ToolInput) {
    /* handler logic using cfg and deps */
  };
}

// guardrails/index.ts — orchestrator
export function createGuardrailsHooks(config: PluginConfig) {
  const cfg = resolveConfig(config);
  return {
    toolBefore: createToolBeforeHandler(cfg, deps),
    // ...
  };
}
```

Use this pattern when:
- Splitting a large factory function into handler files
- The submodules don't have their own mockable functions
- All dependencies can be passed as closure parameters

Use the _internals proxy pattern (3b) when:
- Extracting a subsystem that tests mock independently
- The source module exports `_internals` for test injection
- Mockable functions are moving to the extracted module

## Step 4 — Update CI invariant scripts

For EVERY path-scoped artifact found in Step 0a, add the new file paths:

```bash
# Example: check-invariants.sh
LEGACY_EXEMPTS=(
  "src/hooks/guardrails.ts"                    # original (still exists as barrel)
  "src/hooks/guardrails/file-authority.ts"     # NEW
  "src/hooks/guardrails/helpers.ts"            # NEW
  "src/hooks/guardrails/index.ts"              # NEW
)
```

**Verify:** Run the invariant check script locally if possible (bash on Windows may require WSL).

## Step 4.5 — Re-capture SAST baseline

File-path moves alter SAST finding fingerprints, making pre-existing findings appear new. After extraction:

1. Run `sast_scan` with `capture_baseline: true` and the current phase number
2. Compare against the previous baseline to identify findings that moved (same rule, different file path)
3. Merge the updated baseline so pre-existing findings don't fail the gate

**Verify:** SAST scan on the new file paths shows only genuinely new findings, not relocated pre-existing ones.

## Step 5 — Update documentation

Update any doc references that point to the old monolith for functions that moved:

```bash
grep -rn "<source-file-path>" docs/ *.md
```

Fix references to point to the new submodule location.

## Step 6 — Verification checklist

- [ ] `bun run build` succeeds
- [ ] `bun run typecheck` succeeds (zero new type errors)
- [ ] `biome ci .` passes
- [ ] ALL test files from Step 0c pass (not just the one in scope)
- [ ] CI invariant scripts updated for new paths
- [ ] Documentation references updated
- [ ] No runtime behavior changes (pure extraction)

## Common mistakes

| Mistake | Why it fails |
|---------|-------------|
| Forgetting to update LEGACY_EXEMPTS | CI `quality` job fails on `process.cwd()` check for new file paths |
| Only testing the explicit test file | Cross-file regressions in OTHER consuming test files go undetected |
| Not creating getter/setter proxies for _internals | Test mocks on the parent module don't propagate to extracted functions |
| Moving helper functions without updating/re-exporting all consumers | Import errors in unrelated files that depended on the helper |
| Updating docs to reference new paths but missing some | Stale doc references confuse future readers |

## Relationship to other skills

- **safe-rename**: Use when renaming symbols across the codebase. Use **safe-extraction** when moving code to new files.
- **mock-to-internals-migration**: Use when converting test files from mock.module/vi.spyOn to _internals DI seam. May be needed as part of extraction if the source module's _internals changes.
- **subprocess-safety**: Relevant if the extracted code calls spawn/spawnSync — ensure the _internals proxy preserves timeout/kill semantics.
