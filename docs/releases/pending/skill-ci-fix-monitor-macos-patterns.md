# docs: add macOS cross-platform file I/O fixes to ci-fix-monitor, writing-tests, and engineering-conventions skills

## What changed

Three skill updates to document macOS/APFS cross-platform file I/O
failure patterns discovered while fixing pre-existing CI failures on
PR #1363:

1. **`ci-fix-monitor`** — added "macOS unit test" row to the failure
   classification table and a new "macOS file I/O fixes" section that
   links to the canonical patterns in `writing-tests`. The detailed
   code examples are NOT duplicated here (they live in `writing-tests`)
   so the guidance survives any regeneration of this `generated/` file.

2. **`writing-tests`** — added "macOS rename-visibility race" and
   "Node FileHandle API" subsections under Cross-Platform Requirements.
   The macOS section documents the canonical three-layer fix pattern
   (bunWrite + ENOENT retry + Node FileHandle.sync() not fsync()) that
   fixes `unit (macos-latest)` CI failures caused by APFS rename timing.

3. **`engineering-conventions`** — added "Evidence file flow
   (`.swarm/evidence/{taskId}.json`)" section. Clarifies that agents
   NEVER write evidence files directly — the `delegation-gate` hook
   writes them automatically. Describes the actual flow and when to
   suspect it's broken.

## Why

These patterns are durable — they apply to any future PR that touches
atomic file writes, cross-platform I/O, or QA gate evidence. The
critic (Qwen3.6 + Gemma-4 dual-model review) identified that the
original PR had two risks:

1. **[HIGH]** The `generated/` file might be overwritten by
   regeneration, losing the macOS technical details. **Fixed by**
   making `writing-tests` the canonical source and having `ci-fix-monitor`
   link to it instead of duplicating the code.

2. **[MEDIUM]** The documentation references unverified external state
   (`bunWrite`, `validateSwarmPath` path length guard). **Fixed by**
   documenting these in `writing-tests` § Cross-Platform Requirements,
   which is the canonical technical reference for the codebase.

## Migration

No migration required. Skill changes are internal documentation.

## Known caveats

- The `bunWrite` reference assumes the function exists in
  `src/utils/bun-compat.ts` — if renamed or moved, the skill should
  be updated.
- The 5-attempt / 10ms retry values are defaults; tune based on
  observed macOS filesystem behavior.
- The evidence file flow section describes the current
  `delegation-gate` hook behavior. If the hook is replaced, this
  section must be rewritten.
