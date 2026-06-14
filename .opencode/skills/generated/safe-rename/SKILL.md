---
name: safe-rename
description: >
  Workflow for safely renaming symbols (functions, types, classes, interfaces,
  constants, variables) across a codebase. Uses repo_map, batch_symbols, and
  build_check to ensure every consumer is updated and nothing breaks.
effort: small
generated_from_knowledge: []
source_knowledge_ids: []
generated_at: 2026-06-14T16:50:00Z
confidence: 0.5
status: active
version: 2
skill_origin: generated
provenance_note: >
  Original source knowledge IDs could not be recovered from the knowledge base.
  Metadata backfilled manually; body content preserved from the prior active revision.
---

# Safe Rename Skill

Guides a systematic, tool-augmented workflow for renaming exported symbols across
a codebase without silently breaking consumers, tests, or downstream builds.

## When to Use

- Renaming an **exported** function, class, interface, type alias, constant, or
  enum across the codebase.
- Renaming a **file** that is imported by other modules (requires updating all
  import paths).
- Any rename where the old symbol name appears in more than one file.

Do NOT use for:
- Local-only renames (a variable scoped to a single function body) — use your
  editor's rename refactoring directly.
- Renaming a symbol that has zero consumers — just edit the definition.

## Required Tools

| Tool | Purpose |
|------|---------|
| `repo_map` (action: `importers`) | Find every file that imports from the target file |
| `repo_map` (action: `blast_radius`) | Find transitive dependents for high-risk renames |
| `symbols` | List the full exported API surface of the target file |
| `batch_symbols` | Bulk symbol extraction across multiple affected files |
| `search` | Find literal occurrences of the old symbol name across the codebase |
| `suggest_patch` | Preview changes before applying (dry-run) |
| `apply_patch` | Apply rename patches to consumer files |
| `edit` | Fallback for one-at-a-time rename edits when apply_patch is not suitable |
| `build_check` (mode: `typecheck`) | Verify the rename does not break compilation |
| `test_runner` | Run tests on affected files after rename |

## Workflow

### Step 1 — Identify the target

1. Determine the **file** that exports the symbol and the **symbol name** to
   rename.
2. If renaming a file itself, note the old path and the new path.

### Step 2 — Discover consumers

1. Run `repo_map` with action `importers` and `file` set to the target file path.
   This returns every file that imports from the target, with line numbers and
   import metadata.
2. If the rename is high-risk (the symbol is widely used or part of a core
   utility), also run `repo_map` with action `blast_radius` to understand
   transitive dependents.

### Step 3 — Understand the API surface

1. Run `symbols` on the target file (with `exported_only: true`) to see every
   exported symbol. This helps confirm the exact name, signature, and whether
   the symbol is re-exported.
2. Run `batch_symbols` on the consumer files identified in Step 2 to understand
   how they import and use the symbol.

### Step 4 — Assess impact

1. Read each consumer file identified in Step 2 to understand **usage patterns**:
   - Direct named imports: `import { OldName } from './target'`
   - Namespace imports: `import * as ns from './target'` then `ns.OldName`
   - Default imports or re-exports
   - Dynamic access: `obj['OldName']` (see Limitations)
2. Count the total number of files and occurrences to gauge rename scope.

### Step 5 — Execute the rename

1. **Rename the definition** in the source file first using `edit`.
2. **Update each consumer file one at a time** using `apply_patch`:
   - Use `suggest_patch` to preview the rename changes for the consumer file,
     then apply the patch with `apply_patch`.
   - Replace the old symbol name with the new name in import statements.
   - Replace the old symbol name with the new name in usage sites within
     that file.
   - Do NOT batch all edits into a single call — apply one file at a time so
     each change is independently verifiable.
3. If renaming a file (not just a symbol), update all import paths in consumer
   files to reflect the new file path.
4. If the symbol is re-exported from an index/barrel file, update the re-export
   as well.

### Step 6 — Dry-run verification (MANDATORY)

Before considering the rename complete:

1. Use `suggest_patch` to preview any remaining rename changes before applying
   with `apply_patch`, ensuring the patch set is correct.
2. Run `build_check` with `mode: "typecheck"` and `scope: "changed"`.
   - If this fails, review the output for remaining references to the old name
     or type mismatches introduced by the rename.
   - Fix any issues found and re-run the typecheck.
3. Run `build_check` with `mode: "both"` if the project uses a build step
   (compilation + typecheck).

### Step 7 — Post-rename verification

1. Run `test_runner` with `scope: "impact"` or `scope: "graph"` on the changed
   files to verify no tests break.
2. Run `search` for the **old symbol name** across the entire codebase to
   confirm zero remaining references (excluding comments, changelogs, and
   docs/releases/ history fragments).
3. If any references remain, determine whether they are:
   - Stale references that need updating — fix them.
   - Intentional (e.g., migration aliases, backward-compat shims) — document
     why they remain.
   - Documentation/history — leave as-is.

## Limitations

This workflow has the following known gaps:

### No alias resolution

`repo_map importers` and `search` find imports by file path, but they do not
resolve renamed imports:

```typescript
import { X as Y } from './target'; // Y is an alias for X
```

If you rename `X` to `Z`, the search will not find the `Y` alias. You must
manually check for aliased imports by searching for `{ X as` patterns.

### No type-awareness (structural typing)

This workflow is text-based, not AST-based. In TypeScript, structural typing means
a variable typed as `{ name: string }` satisfies any interface with that shape,
regardless of the interface name. Renaming the interface name does not require
updating these structural usages, but the workflow may flag them as "missed
references" in Step 7.

### Dynamic references

References via string literals, reflection, or computed property access are
invisible to static search:

```typescript
obj['oldName']           // string-based property access
Reflect.get(target, 'oldName') // reflection
```

If the renamed symbol is accessed dynamically anywhere, those references will
not be found by `search` or `repo_map`. Use grep for the string form of the old
name to catch these cases.

### Re-exports and barrel files

If a symbol is re-exported through an index file (`export { X } from './X'`),
the re-export line and all downstream consumers of the re-export must also be
updated. The `repo_map blast_radius` action helps here, but you must manually
verify re-export chains.

### Non-code references

The old symbol name may appear in:
- Configuration files (JSON, YAML, TOML)
- CLI argument parsers
- Stringified identifiers in database records
- External API contracts or documentation

These are outside the scope of this workflow but should be considered for
high-impact renames.

## Checklist

Before marking a rename complete, verify every item:

- [ ] Definition renamed in source file
- [ ] All import statements updated across consumers
- [ ] All usage sites updated across consumers
- [ ] Re-exports updated (if applicable)
- [ ] Import paths updated (if renaming a file)
- [ ] `build_check` typecheck passes with no errors
- [ ] Tests pass for all affected files
- [ ] `search` for old name returns zero stale code references
- [ ] Limitations reviewed and exceptions documented (if any)
