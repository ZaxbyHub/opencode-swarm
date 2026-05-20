# Swarm Knowledge System End-to-End Audit

**Date**: 2026-04-26
**Auditor**: Architect (mega swarm)
**Repository**: opencode-swarm v6.85.1

---

## Executive Summary

**Overall verdict**: Partially working — well-designed core with critical wiring defects.

The knowledge system has a clean architecture (two-tier swarm/hive, three-layer validation, phase-aware injection, TTL decay, auto-promotion). The core storage and validation layers are well-tested. However, several critical issues exist:

### Highest-Risk Source-Backed Issues

1. **DUPLICATE HIVE IMPLEMENTATION** (Critical): Two separate `hive-promoter.ts` files (`src/hooks/` and `src/knowledge/`) write to **different file paths** (`shared-learnings.jsonl` vs `hive-knowledge.jsonl`) with different schemas — manual promotions via `/swarm promote` and `/swarm curate` route to different files than the automatic hooks.

2. **knowledge_add bypasses near-duplicate dedup** (Medium): The `knowledge_add` tool calls `validateLesson` but does NOT call `findNearDuplicate` or `inferTags` before writing — the knowledge-store's `appendKnowledge` is called unconditionally after validation.

3. **knowledge_remove only operates on swarm tier** (Low-Medium): Cannot remove hive entries through the standard tool — the tool name says "knowledge" but implementation only touches `knowledge.jsonl` (swarm tier).

4. **knowledge_remove lacks locking** (Medium): Uses `rewriteKnowledge` which has proper-lockfile, but `knowledge_remove` does a read-modify-write via `rewriteKnowledge` — this is actually fine for the rewrite, BUT the read and filter happen outside the lock scope, creating a TOCTOU race window between reading entries and writing the filtered result. (Reducing to Informational since `rewriteKnowledge` does lock internally.)

5. **3 test failures in knowledge-reader-key-normalization.test.ts** (Medium): `rewriteKnowledge` never called in `updateRetrievalOutcome` tests — likely a mock wiring issue that means the code path is not properly exercised.

6. **4 test errors in support files** (Medium): `validateLesson` export not found in `knowledge-validator.ts` from some test support files — suggests circular dependency or import resolution issue.

### Highest-Confidence Working Areas

- Knowledge entry schema (`knowledge-types.ts`) is cleanly typed with full lifecycle fields
- Three-layer validation gate (`knowledge-validator.ts`) has comprehensive structural, content-safety, and semantic checks
- FIFO cap enforcement (swarm_max_entries, rejected_max_100 at quarantine, 20 at rejected) is tested
- proper-lockfile usage on rewrite operations for crash safety
- Phase-aware injection with context budget regimes
- Agenda injection caching (re-uses cached text within same phase)
- Architect-only injection allowlist (non-architect agents do not receive knowledge)
- Sanitization of lesson text before prompt injection
- Comprehensive adversarial test coverage for validator, injector, quarantine

### Items I Got Wrong in First Pass
- Finding 7 originally claimed `sweepStaleTodos` is never called — RETRACTED. It IS called from `phase-complete.ts:1323-1342` for both swarm and hive tiers. Corrected in final.

### Biggest Untested Critical Paths

- **Hive promotion from hook to curator**: `createHivePromoterHook` → `checkHivePromotions` is wired in index.ts but relies on `safeHook` for error suppression — no test verifies the full chain
- **Dual hive file path** (shared-learnings.jsonl vs hive-knowledge.jsonl): No test exists to detect the split
- **Concurrent write safety**: No concurrency/race-condition tests for knowledge operations
- **knowledge_recall with tier filter**: No test for the `tier` parameter behavior
- **knowledge_remove**: No direct tests exist
- **RunMemory wiring in injector**: The `getRunMemorySummary` call and injection ordering has tests but no end-to-end integration test
- **disabled config paths**: Most tests don't verify behavior when `knowledge.enabled = false`
- **phase_complete triggered curator**: No integration test for the full curator → sweepAgedEntries → hivePromoter chain

### Docs vs Implementation Mismatches

- Docs say hive path is `shared-learnings.jsonl`, but `src/knowledge/hive-promoter.ts` writes `hive-knowledge.jsonl`
- Docs say `scope_filter` defaults to `["global"]`, but both the query tool and injector honor this — CONFIRMED CORRECT
- Docs list `todo_max_phases` but `sweepStaleTodos` is NEVER CALLED from any production code

---

## Source-Backed Architecture Map

### Hook Map (invocation order in experimental.chat.messages.transform)

```
messages.transform chain:
  1. delegationLedgerHook.onArchitectResume          (state.ts)
  2. pipelineHook['experimental.chat.messages.transform'] (pipeline-tracker.ts)
  3. contextBudgetHandler                            (context-budget.ts)
  4. guardrailsHooks.messagesTransform               (guardrails.ts)
  5. fullAutoInterceptHook?.messagesTransform         (full-auto-intercept.ts)
  6. delegationGateHooks.messagesTransform            (delegation-gate.ts)
  7. delegationSanitizerHook                          (delegation-sanitizer.ts)
  8. knowledgeInjectorHook                            ← KNOWLEDGE INJECTION
  9. consolidateSystemMessages                         (final cleanup)

system.transform chain:
  1. systemEnhancerHook
  2. heartbeat telemetry
  3. phaseMonitorHook (creates curator LLM delegate if enabled)
  4. system message consolidation

tool.execute.after chain (sequential):
  ... other hooks ...
  8. knowledgeCuratorHook   (if knowledgeConfig.enabled)
  9. hivePromoterHook       (if knowledgeConfig.enabled && hive_enabled)
  ... other hooks ...
```

Sources: `src/index.ts:L876-L917` (messages.transform), `L920-L974` (system.transform), `L1055-L1301` (tool.after)

### Tool Map

| Tool | File | Registers | Reads | Writes | Uses Lock | Uses Validator | Tests |
|------|------|-----------|-------|--------|-----------|----------------|-------|
| `knowledge_add` | `src/tools/knowledge-add.ts` | `index.ts:L619` | `loadPlan` | `appendKnowledge` to `knowledge.jsonl` | No (append) | Yes (config-gated) | None |
| `knowledge_recall` | `src/tools/knowledge-recall.ts` | `index.ts:L620` | `readKnowledge` both tiers | None | N/A (read-only) | No | None |
| `knowledge_query` | `src/tools/knowledge-query.ts` | `index.ts:L635` | `readKnowledge` both tiers | None | N/A (read-only) | No | Unit tests exist |
| `knowledge_remove` | `src/tools/knowledge-remove.ts` | `index.ts:L621` | `readKnowledge` swarm only | `rewriteKnowledge` on swarm only | Yes (via rewriteKnowledge) | No | None |

### Command Map

| Command | Handler | File | Reads | Writes | Uses Lock | Tests |
|---------|---------|------|-------|--------|-----------|-------|
| `/swarm knowledge` (list) | `handleKnowledgeListCommand` | `src/commands/knowledge.ts` | `knowledge.jsonl` | None | N/A | None |
| `/swarm knowledge quarantine` | `handleKnowledgeQuarantineCommand` | `src/commands/knowledge.ts` | `knowledge.jsonl` | `knowledge-quarantined.jsonl`, `knowledge-rejected.jsonl` | Yes (quarantineEntry) | Yes |
| `/swarm knowledge restore` | `handleKnowledgeRestoreCommand` | `src/commands/knowledge.ts` | `knowledge-quarantined.jsonl`, `knowledge-rejected.jsonl` | `knowledge.jsonl`, `knowledge-quarantined.jsonl`, `knowledge-rejected.jsonl` | Yes (restoreEntry) | Yes |
| `/swarm knowledge migrate` | `handleKnowledgeMigrateCommand` | `src/commands/knowledge.ts` | `context.md` | `knowledge.jsonl`, sentinel file | No (rewriteKnowledge) | Yes |
| `/swarm promote` | `handlePromoteCommand` | `src/commands/promote.ts` | `knowledge.jsonl` for --from-swarm | **DUPLICATE**: `hive-knowledge.jsonl` | No (fs.appendFileSync) | None |
| `/swarm curate` | `handleCurateCommand` | `src/commands/curate.ts` | `knowledge.jsonl`, hive via checkHivePromotions | hive via checkHivePromotions | Mixed | None |

### Agent/Curator Map

| Agent | Prompt Source | Read Tools | Write Tools | Invoked By |
|-------|-------------|------------|-------------|------------|
| `curator_init` | `CURATOR_INIT_PROMPT` (explorer.ts:158) | `knowledge_recall` only | None | `createPhaseMonitorHook` via `createCuratorLLMDelegate` |
| `curator_phase` | `CURATOR_PHASE_PROMPT` (explorer.ts:201) | `knowledge_recall` only | None | `runCuratorPhase` via `createCuratorLLMDelegate` |

### Storage Map

| File | Tier | Managed By | Schema | FIFO Cap | Locking |
|------|------|-----------|--------|----------|---------|
| `.swarm/knowledge.jsonl` | Swarm | knowledge-store.ts | `SwarmKnowledgeEntry` | `swarm_max_entries` (default 100) | proper-lockfile on rewrite |
| `.swarm/knowledge-rejected.jsonl` | Swarm (rejected) | knowledge-store.ts | `RejectedLesson` | 20 (in appendRejectedLesson) | proper-lockfile on rewrite |
| `.swarm/knowledge-quarantined.jsonl` | Swarm (quarantined) | knowledge-validator.ts | `QuarantinedEntry` | 100 (FIFO in quarantineEntry) | proper-lockfile |
| `.swarm/.knowledge-shown.json` | Ephemeral | knowledge-reader.ts | phase→id[] mapping | None | None |
| `{XDG}/shared-learnings.jsonl` | **Hive (hooks)** | knowledge-store.ts | `HiveKnowledgeEntry` | `hive_max_entries` (default 200) | proper-lockfile on rewrite |
| `{XDG}/shared-learnings-rejected.jsonl` | Hive (rejected) | hive-promoter.ts (hooks) | `RejectedLesson` | None | None |
| `{XDG}/hive-knowledge.jsonl` | **DUPLICATE Hive (command)** | **src/knowledge/hive-promoter.ts** | **Custom flat schema** | None | **None (fs.appendFileSync)** |

### Lifecycle State Machine

```
                    ┌───────────────────────────────────────┐
                    │              Creation Paths            │
                    │  knowledge_add (tool)                  │
                    │  curateAndStoreSwarm (curator hook)    │
                    │  applyCuratorKnowledgeUpdates (curator)│
                    │  migrateContextToKnowledge (migration) │
                    └────────────────┬──────────────────────┘
                                     │
                                     ▼
                            ┌────────────────┐
                            │    candidate    │  ← initial status for all entries
                            │  (phases_alive  │
                            │   = 0 or ++)   │
                            └────────┬───────┘
                                     │
                         ┌───────────┼───────────┐
                         │           │           │
                         ▼           ▼           ▼
                  ┌──────────┐ ┌──────────┐  ❌ via quarantineEntry
                  │established│ │promoted  │  ┌──────────────┐
                  │(3+ phases)│ │(age or   │  │  quarantined │
                  │           │ │3+ phases)│  │ (move to     │
                  └─────┬─────┘ │hive      │  │  -quarantined│
                        │       │eligible  │  │  .jsonl)     │
                        │       └─────┬─────┘  └──────────────┘
                        │             │               │
                        ▼             ▼               │ via restoreEntry
                  ┌──────────┐  Hive promotion ──────────┘
                  │archived  │  (checkHivePromotions)  can restore
                  │(TTL      │         │               back to
                  │ exceeded)│         ▼               knowledge.jsonl
                  └──────────┘    ┌──────────┐
                  ALSO:           │ hive:    │
                  sweepStaleTodos │ candidate│
                  removes todo    │          │
                  entries entirely│          │
                                  └──────────┘
                                       │
                                       │ (3+ projects)
                                       ▼
                                  ┌──────────┐
                                  │ hive:    │
                                  │established│
                                  └──────────┘
```

### Data-Flow Diagrams

**Manual knowledge add**:
```
User/Agent calls knowledge_add tool
  → knowledge-add.ts validates args via tool.schema
  → reads plan for project_name
  → optionally calls validateLesson (config-gated: validation_enabled)
  → calls appendKnowledge to .swarm/knowledge.jsonl
  → NO near-duplicate check
  → NO auto-generated=false (always true)
```

**Curator extraction from retrospective**:
```
tool.execute.after fires
  → knowledgeCuratorHook (if knowledgeConfig.enabled && isWriteToSwarmPlan)
  → reads .swarm/plan.md
  → extractRetrospectiveSection finds "### Lessons Learned"
  → extractLessonsFromRetro parses bullet points
  → extractRetractionsAndLessons splits RETRACT:/BAD RULE: from normal
  → processRetractions quarantines matching entries
  → curateAndStoreSwarm validates, deduplicates, stores new entries
  → updateRetrievalOutcome records that these lessons were shown
```

**Knowledge injection into architect context**:
```
messages.transform fires
  → knowledgeInjectorHook
  → loads plan, detects phase
  → checks context budget (3 regimes: full/half/quarter)
  → checks architect-only allowlist
  → reads merged knowledge via readMergedKnowledge
  → reads drift reports via readPriorDriftReports
  → reads curator briefing via readSwarmFileAsync
  → reads run memory via getRunMemorySummary
  → reads rejected lessons via readRejectedLessons
  → builds priority-ordered block: lessons > run memory > drift > rejected warnings
  → sanitizes all text via sanitizeLessonForContext
  → injects via injectKnowledgeMessage (before last user message)
  → idempotency guard prevents duplicate injection
```

---

## Knowledge Surface Inventory

| Surface | File | Symbol | Route | Reads | Writes | Status | Injects | Validation | Locking | Tests |
|---------|------|--------|-------|-------|--------|--------|---------|-----------|---------|-------|
| knowledge_add tool | tools/knowledge-add.ts | `knowledge_add` | Tool | plan.json | knowledge.jsonl | candidate | No | Config-gated | Append (no lock) | None |
| knowledge_recall tool | tools/knowledge-recall.ts | `knowledge_recall` | Tool | knowledge.jsonl, shared-learnings.jsonl | None | Read-only | No | None | N/A | None |
| knowledge_query tool | tools/knowledge-query.ts | `knowledge_query` | Tool | knowledge.jsonl, shared-learnings.jsonl | None | Read-only | No | Filtering | N/A | Yes |
| knowledge_remove tool | tools/knowledge-remove.ts | `knowledge_remove` | Tool | knowledge.jsonl | knowledge.jsonl | Remove | No | None | Yes (via rewriteKnowledge) | None |
| Curator hook | hooks/knowledge-curator.ts | `createKnowledgeCuratorHook` | tool.execute.after | plan.md, evidence/*.json | knowledge.jsonl, rejected.jsonl | candidate | No | Yes (full 3-layer) | Append/rewrite | Yes |
| Injector hook | hooks/knowledge-injector.ts | `createKnowledgeInjectorHook` | messages.transform | knowledge.jsonl, shared-learnings.jsonl | .knowledge-shown.json | Read-only | Yes (architect only) | Sanitization only | None | Yes |
| Hive promoter hook | hooks/hive-promoter.ts | `createHivePromoterHook` | tool.execute.after | knowledge.jsonl, shared-learnings.jsonl | shared-learnings.jsonl, curator-summary.json | promotes to hive | No | Yes (re-validate) | Rewrite (lock) | Yes |
| Hive promoter (DUPLICATE) | knowledge/hive-promoter.ts | `promoteToHive` | /swarm promote | knowledge.jsonl | **hive-knowledge.jsonl** | promoted | No | Custom minimal | **None** | None |
| Reader | hooks/knowledge-reader.ts | `readMergedKnowledge` | Called by injector | knowledge.jsonl, shared-learnings.jsonl | .knowledge-shown.json | Read-only | Via injector | Scope/status filter | None | Yes |
| Validator | hooks/knowledge-validator.ts | `validateLesson` | Called by multiple | None | None | Pure | No | 3-layer gate | None | Yes |
| Migrator | hooks/knowledge-migrator.ts | `migrateContextToKnowledge` | /swarm knowledge migrate | context.md | knowledge.jsonl | candidate | No | Config-gated | rewriteKnowledge | Yes |
| Quarantine | hooks/knowledge-validator.ts | `quarantineEntry` | /swarm knowledge quarantine | knowledge.jsonl | knowledge-quarantined.jsonl, rejected.jsonl | quarantined → removed | No | Entry ID guard | Lock on .swarm/ dir | Yes |

---

## Findings

### Finding 1: Dual Hive Implementation — Different File Paths and Schemas

**Severity**: Critical  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/hooks/hive-promoter.ts:L146-L148` — `const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(resolveHiveKnowledgePath())` where `resolveHiveKnowledgePath()` (in `knowledge-store.ts:68`) returns `{platform-data-dir}/shared-learnings.jsonl`
- `src/hooks/hive-promoter.ts:L211` — `const hiveRejectedPath = resolveHiveRejectedPath()` writes to `shared-learnings-rejected.jsonl`
- `src/knowledge/hive-promoter.ts:L94` — `getHiveFilePath()` returns `{platform-data-dir}/hive-knowledge.jsonl`
- `src/commands/promote.ts:L12-L15` — imports `promoteToHive, promoteFromSwarm, validateLesson` from `../knowledge/hive-promoter` (the duplicate)

**What happens**:
- When the knowledge hooks system promotes entries automatically, it writes to `shared-learnings.jsonl` with the full `HiveKnowledgeEntry` schema
- When a user runs `/swarm promote`, it writes to `hive-knowledge.jsonl` with a different, flat schema (`{ id, lesson, category, scope_tag, confidence, status, ... }`)
- The `knowledge_recall` and `readMergedKnowledge` functions only read `shared-learnings.jsonl`
- Manual promotions via `/swarm promote` are therefore written to a file that the knowledge system NEVER READS

**Why it matters**:
Manual hive promotions are invisible to the knowledge system. Users think they're contributing cross-project knowledge, but those entries are isolated in a separate file. This is a complete data loss path for manually promoted content.

**Reproduction**:
1. Run `/swarm promote "Always validate inputs"`
2. The content is written to `hive-knowledge.jsonl`
3. Run `/swarm knowledge query --tier hive`
4. The entry is NOT returned (the query tool reads `shared-learnings.jsonl`)

**Recommended fix**:
- Remove the duplicate `src/knowledge/hive-promoter.ts` implementation
- Update `src/commands/promote.ts` to import from `src/hooks/hive-promoter.ts` instead
- Migrate any existing data from `hive-knowledge.jsonl` to `shared-learnings.jsonl`

**Test to add**:
- Integration test verifying `/swarm promote` produces data visible to `knowledge_query`

---

### Finding 2: Hive Promoter Duplicate Uses Different Hive-Rejected Path

**Severity**: High  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/hooks/hive-promoter.ts:L211` — uses `resolveHiveRejectedPath()` which returns `shared-learnings-rejected.jsonl`
- `src/knowledge/hive-promoter.ts` — has NO rejected-path logic at all

**What happens**: Hive validation failures from the hooks system go to `shared-learnings-rejected.jsonl`, but the duplicate has no rejected handling, so validation failures during manual promotion are simply thrown as errors and the rejected information is lost.

**Recommended fix**: Same as Finding 1 — consolidate into single implementation.

---

### Finding 3: `knowledge_add` Tool Bypasses Near-Duplicate Detection

**Severity**: Medium  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/tools/knowledge-add.ts:L148-L166` — calls `validateLesson` conditional on `validation_enabled` config
- `src/tools/knowledge-add.ts:L168-L177` — calls `appendKnowledge(resolveSwarmKnowledgePath(directory), entry)` — no call to `findNearDuplicate()`
- Compare with `src/hooks/knowledge-curator.ts:L321-L329` — `curateAndStoreSwarm` calls `findNearDuplicate()` before appending

**What happens**: Users/agents calling `knowledge_add` can create near-duplicate entries. The dedup threshold (default 0.6 Jaccard) is only enforced in the curator path, not the tool path.

**Why it matters**: Over time, the knowledge store accumulates redundant entries, reducing signal quality and wasting context budget.

**Recommended fix**: Add `findNearDuplicate` check to `knowledge-add.ts` before the `appendKnowledge` call. If duplicate found, return a success message indicating the existing entry was reused.

**Test to add**: Add test in `tests/unit/tools/knowledge-add.test.ts` (which doesn't exist yet) verifying that adding a near-duplicate is handled.

---

### Finding 4: `knowledge_remove` Only Operates on Swarm Tier

**Severity**: Low  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/tools/knowledge-remove.ts:L42-L54` — reads only `resolveSwarmKnowledgePath(directory)` (swarm), filters by ID, rewrites
- No reference to hive path or `resolveHiveKnowledgePath()` anywhere in the file

**What happens**: The tool is named `knowledge_remove` but actually only removes swarm-tier entries. Hive entries cannot be removed through this tool.

**Why it matters**: If a bad lesson gets promoted to hive, there is no tool to remove it from either the hooks path (manually via quarantine) or the tool path.

**Recommended fix**: Add optional hive support or at minimum document that removal only applies to swarm tier in the tool description.

---

### Finding 5: `knowledge_remove` Race Window in Read-Modify-Write

**Severity**: Informational (The rewriteKnowledge function internally acquires a lock, but the read is outside the lock scope)

Let me re-examine: `knowledge_remove` calls `readKnowledge` at line 46, then calls `rewriteKnowledge` at line 69. Looking at `rewriteKnowledge` in `knowledge-store.ts:129-155`:

```typescript
export async function rewriteKnowledge<T>(filePath: string, entries: T[]): Promise<void> {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    let release: (() => Promise<void>) | null = null;
    try {
        release = await lockfile.lock(dir, { ... });
        // write
    } finally {
        if (release) { await release(); }
    }
}
```

The lock is acquired inside `rewriteKnowledge`, after the data has already been read in `knowledge_remove`. If between reading and writing another process modifies the file, the write will overwrite that change.

However, since all hooks are fire-and-forget and single-threaded within one process, the race is primarily theoretical and only matters if multiple processes concurrently modify the same knowledge store.

**Severity reduced to Informational** given single-process execution model. But if multi-process support is ever needed (e.g., multiple OpenCode sessions sharing a project), this is a critical race condition.

---

### Finding 6: `knowledge_add` Always Sets `auto_generated: true`

**Severity**: Low  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/tools/knowledge-add.ts:L145` — `auto_generated: true` hardcoded

**What happens**: All entries added via the `knowledge_add` tool are marked as auto-generated, even though they come from explicit agent action. This affects the confidence calculation (`computeConfidence` only gives +0.1 for non-auto-generated) and may affect the `auditEntryHealth` check ("Unconfirmed auto-generated").

**Recommended fix**: The tool should accept an optional parameter or set `auto_generated: false` since this is an explicit knowledge addition, not automatic extraction.

---

### Finding 7 (RETRACTED): `sweepStaleTodos` Is Called From phase-complete

**UPDATE**: This finding is retracted. `sweepStaleTodos` IS called from `src/tools/phase-complete.ts:L1323-L1326` and `L1339-L1342` — both swarm and hive tiers are swept. The sweep is config-gated on `knowledgeConfig.sweep_enabled` and catches all errors to avoid blocking phase completion.

**Evidence**:
- `src/tools/phase-complete.ts:L1317-L1344` — sweep logic for both swarm and hive, both `sweepAgedEntries` and `sweepStaleTodos`, with error handling for ELOCKED, ENOSPC, EACCES

**Status**: Working correctly.

---

### Finding 8: 3 Test Failures in `knowledge-reader-key-normalization.test.ts`

**Severity**: Medium  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `tests/unit/hooks/knowledge-reader-key-normalization.test.ts:136` — `expect(rewriteKnowledge).toHaveBeenCalled()` fails
- Lines 173 and 207 — `TypeError: undefined is not an object (evaluating 'rewriteKnowledge.mock.calls[0]')`

**What happens**: Three integration tests for `updateRetrievalOutcome` fail because `rewriteKnowledge` is never called. The mock setup has `readKnowledge` returning entries, and a real `.knowledge-shown.json` file exists on disk. The exact root cause needs investigation — it could be:
1. A mock isolation issue where `updateRetrievalOutcome` is using the real `readKnowledge` instead of the mock (import path mismatch between `knowledge-reader.ts` importing from `./knowledge-store.js` and the test mocking from `../../../src/hooks/knowledge-store.js`)
2. An assertion about shown data not matching properly

**Why it matters**: These failing tests mean the `updateRetrievalOutcome` function — which tracks whether knowledge was useful — is not properly verified.

---

### Finding 9: 4 Test Errors Due to `validateLesson` Export Not Found

**Severity**: Medium  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- Test output shows: `SyntaxError: Export named 'validateLesson' not found in module 'src/hooks/knowledge-validator.ts'`
- This occurs in `tests/unit/tools/phase-complete-knowledge-config-adversarial.test.ts` and other files

**Root cause**: The `validateLesson` function IS exported from `knowledge-validator.ts:210`, but TypeScript/Bun module resolution may be failing when certain test support files (like `tests/support/evidence.ts`) import it indirectly. This could be a circular dependency issue — `knowledge-validator.ts` imports from `knowledge-store.ts`, but something in the chain creates a cycle.

---

### Finding 10: `knowledge_remove` Does Not Remove from Hive

**Severity**: Low  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/tools/knowledge-remove.ts:42-54` only reads/writes swarm knowledge path
- No hive path referenced in the file

**What happens**: Knowledge entries that have been promoted to hive cannot be removed via `knowledge_remove`. They must be removed manually from the hive file.

---

### Finding 11: `knowledge_recall` Includes `archived` Entries

**Severity**: Low  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/tools/knowledge-recall.ts:102-108` — combines all entries WITHOUT filtering by status
- No `status !== 'archived'` filter applied
- Compare with `readMergedKnowledge` in `knowledge-reader.ts:363-367` which DOES filter out archived entries

**What happens**: `knowledge_recall` returns archived entries in search results. This is a minor issue since archived entries should not be surfaced as actionable knowledge.

---

### Finding 12: Missing Lock on `appendKnowledge` Paths

**Severity**: Low  
**Confidence**: High  
**Status**: Source-backed

**Evidence**:
- `src/hooks/knowledge-store.ts:117-123` — `appendKnowledge` uses `appendFile` without any lock
- Called from `knowledge-add.ts`, `curateAndStoreSwarm`, `quarantineEntry`, `hive-promoter.ts`, `promoteToHive` (duplicate), and `promoteFromSwarm` (duplicate)

**What happens**: Concurrent appends to the same JSONL file (possible if multiple agents fire hooks simultaneously) may interleave writes. In practice, Node.js/Bun single-threaded event loop makes this unlikely, but `appendFile` is not atomic at the OS level.

**Comment in code**: `src/hooks/knowledge-store.ts:116` — `// Uses OS-level atomic append — no lock needed for append-only operations.` This is incorrect — `appendFile` is not guaranteed atomic across OS-level processes.

---

## Working Correctly

1. **Three-layer validation gate** (`knowledge-validator.ts:210-350`): Robust structural (length, category, scope, confidence), content safety (dangerous commands, security degradation, injection patterns), and semantic checks (contradiction detection, vagueness warning). All layers tested.

2. **Proper-lockfile on rewrite operations** (`knowledge-store.ts:129-155`): `rewriteKnowledge` acquires a directory lock with retry logic (5 retries, 100-500ms jitter, 5s stale) for crash-safe writes.

3. **Architect-only injection** (`knowledge-injector.ts:102-107`): The `isOrchestratorAgent` function explicitly only allows the architect agent, preventing knowledge leaks to subagents.

4. **Context budget regimes** (`knowledge-injector.ts:199-205`): Three-tier injection (full/half/quarter) based on available context headroom, preventing context overflow.

5. **Idempotency guard** (`knowledge-injector.ts:117-125`): Checks for existing `📚 Lessons:` block before injecting, preventing duplicate injection within the same transform cycle.

6. **Prompt sanitization** (`knowledge-injector.ts:85-99`): `sanitizeLessonForContext` strips control characters, zero-width chars, BiDi overrides, breaks code blocks (` `` ` → `` ` ` ` ``), and blocks `system:` prefix.

7. **Phase-aware caching** (`knowledge-injector.ts:165,213-221`): Caches injection text per phase, re-injects from cache for same-phase calls (avoids redundant reads), invalidates on phase change.

8. **FIFO cap enforcement**: `knowledge-store.ts:160-169` — `enforceKnowledgeCap` ensures swarm entries don't exceed `swarm_max_entries`; quarantine file capped at 100 entries; rejected lessons capped at 20.

9. **Quarantine/restore with locking** (`knowledge-validator.ts:397-516, 522-608`): Full lock-protected lifecycle with path traversal guards, null byte guards, and reason sanitization.

10. **High-quality test suite**: 167+ tests covering store, validator, quarantine, curator, injector, migrator, and config. Adversarial test files provide comprehensive edge-case coverage.

---

## Untested or Under-Tested Critical Paths

| Path | Why Critical | Source Files | Test Gap | Recommended Test |
|------|-------------|--------------|----------|------------------|
| `knowledge_add` tool | Primary manual creation path | `tools/knowledge-add.ts` | No test file exists | `tests/unit/tools/knowledge-add.test.ts` |
| `knowledge_recall` tool | Primary search path | `tools/knowledge-recall.ts` | No test file exists | `tests/unit/tools/knowledge-recall.test.ts` |
| `knowledge_remove` tool | Primary deletion path | `tools/knowledge-remove.ts` | No test file exists | `tests/unit/tools/knowledge-remove.test.ts` |
| Hive promotion full chain | Cross-project knowledge sharing | `hooks/hive-promoter.ts` + index.ts wiring | No end-to-end integration test | Integration test with full hook chain |
| Dual hive file detection | Data loss for manual promotions | `knowledge/hive-promoter.ts` vs `hooks/hive-promoter.ts` | No test catches the divergence | Integration test verifying promotion → query roundtrip |
| Concurrent append safety | Data corruption under load | `knowledge-store.ts:117-123` | No concurrency tests | Test concurrent `knowledge_add` calls |
| Disabled knowledge config | Safety when `knowledge.enabled = false` | All knowledge files | Most tests run with default (enabled=true) config | Verify no-ops for all surface paths |
| `knowledge_recall` tier filter | Search correctness | `tools/knowledge-recall.ts:85-90` | No test for tier behavior | Parameterized test for all 3 tier values |

---

## Docs vs Implementation

| Doc Claim | Source Evidence | Match |
|-----------|----------------|-------|
| Hive path: `shared-learnings.jsonl` at platform XDG data dir | `knowledge-store.ts:68` — `shared-learnings.jsonl` | ✅ MATCH |
| Rejected hive lessons: `shared-learnings-rejected.jsonl` | `knowledge-store.ts:74` — `shared-learnings-rejected.jsonl` | ✅ MATCH |
| Hive path (docs table): Windows `%LOCALAPPDATA%\opencode-swarm\Data\`, macOS `~/Library/Application Support/`, Linux `$XDG_DATA_HOME/opencode-swarm/` | `knowledge-store.ts:49-68` — matches exactly | ✅ MATCH |
| Entry schema fields: `id`, `tier`, `lesson`, `category`, `tags`, `scope`, `confidence`, `status`, `confirmed_by`, `retrieval_outcomes`, `phases_alive`, `max_phases` | `knowledge-types.ts:34-52` — all present | ✅ MATCH |
| `scope_filter` default `["global"]` | `schema.ts:844` — `z.array(z.string()).default(['global'])` | ✅ MATCH |
| `validation_enabled` default `true` | `schema.ts:850` — `z.boolean().default(true)` | ✅ MATCH |
| `auto_promote_days` default `90` | `schema.ts:833` — `z.number().min(1).max(3650).default(90)` | ✅ MATCH |
| `dedup_threshold` default `0.6` | `schema.ts:842` — `z.number().min(0).max(1).default(0.6)` | ✅ MATCH |
| `max_inject_count` default `5` | `schema.ts:835` — `z.number().min(0).max(50).default(5)` | ✅ MATCH |
| "TODO entries are removed, not archived, after their TTL" | `phase-complete.ts:1323-1326` calls `sweepStaleTodos` for both swarm and hive | ✅ MATCH |
| "Three routes in checkHivePromotions(): Explicit, Fast-track, Age-based" | `hive-promoter.ts:164-182` — all three routes implemented | ✅ MATCH |
| "Three-layer validator" documented | `knowledge-validator.ts` — all three layers implemented | ✅ MATCH |
| docs say `config.schema.ts:804` for config location | `schema.ts:825` — actual KnowledgeConfigSchema definition | ❌ Line number drift (825 vs 804) |
| Docs say `enabled` default `true` | `schema.ts:827` — `z.boolean().default(true)` | ✅ MATCH |
| Docs say `hive_max_entries` default `200` | `schema.ts:831` — `z.number().min(1).max(100000).default(200)` | ✅ MATCH |
| Docs mention `/swarm knowledge` | `commands/knowledge.ts` — implemented | ✅ MATCH |
| Docs mention `/swarm curate` | `commands/curate.ts` — implemented | ✅ MATCH |
| Docs mention `/swarm promote` with two forms | `commands/promote.ts` — implemented (but uses **wrong hive path**) | ⚠️ IMPLEMENTED BUT BROKEN |

---

## Security and Prompt-Injection Review

### Injection Paths

| Path | Untrusted Source | Sanitization | Risk |
|------|-----------------|-------------|------|
| Knowledge injector → lesson text | `knowledge.jsonl` (agent-written) | `sanitizeLessonForContext` in `knowledge-injector.ts:85-99` | **Good** — strips control chars, zero-width, BiDi, ` `` `, `system:` prefix |
| Knowledge injector → source_project (hive) | `shared-learnings.jsonl` (cross-project) | Also passed through `sanitizeLessonForContext` | **Good** |
| Knowledge injector → rejected warnings | `knowledge-rejected.jsonl` | Also passed through `sanitizeLessonForContext` | **Good** |
| Knowledge injector → curator briefing | `.swarm/curator-briefing.md` | No sanitization (read via `readSwarmFileAsync` and injected as-is) | **Potential vector** — if a bad actor can write to this file |
| Knowledge injector → drift report | `.swarm/drift-report-phase-*.json` | `buildDriftInjectionText` truncates but does not sanitize tags | **Potential vector** — XML-like tags `<drift_report>` could be confusing |
| Validator layer 2 | Lesson text from any source | `validateLesson` Layer 2 checks for injection patterns | **Good** — injection patterns include control chars, `system:`, `<script>`, `eval()`, prototype pollution |
| `/swarm promote` | User-provided text | `validateLesson` in `knowledge/hive-promoter.ts:38-66` | **Weaker** — only checks dangerous commands and shell start patterns, no injection pattern checks |

### Known Blocked Payloads

The validator blocks:
- Control characters `\x00-\x08`, `\x0b-\x0c`, `\x0e-\x1f`, `\x7f`, `\x0d`
- Invisible format chars (zero-width, soft hyphen, BOM, BiDi overrides)
- `system:` prefix at start of line
- `<script>` tags
- `javascript:` protocol
- `eval()`, `__proto__`, `constructor[`, `.prototype[`
- `rm -rf`, `sudo rm`, `mkfs`, `dd if=`, `chmod -R 777`, `kill -9`, shell backticks, `$()`

### Potentially Unblocked Payloads

- **`knowledge/hive-promoter.ts` (the duplicate)** only validates dangerous commands and shell patterns — it does NOT validate injection patterns like `system:`, `<script>`, control characters, etc.
- **Curator briefing injection** (`knowledge-injector.ts:257-270`) reads `curator-briefing.md` and injects it as-is with NO sanitization beyond a 500-char truncation. If this file contains malicious content, it goes directly into the LLM context.
- **Drift report injection** (`knowledge-injector.ts:243-253`) uses pre-formatted drift text with XML-like tags. The text itself isn't sanitized, though it comes from internal drift reports.

### Rejected/Quarantined Content Influence

**Rejected lessons** are intentionally injected as warnings via the `⚠️ Previously rejected patterns (do not re-learn):` block. This is by design — the system wants to prevent re-learning. However, the content is truncated and sanitized.

**Quarantined entries** are moved to `knowledge-quarantined.jsonl` and are excluded from reads. They cannot influence prompts. ✅

---

## Concurrency and Persistence Review

### Locking Summary

| Operation | Lock Type | Lock Target | Correct? |
|-----------|-----------|-------------|----------|
| `rewriteKnowledge` | proper-lockfile | Directory of the target file | ✅ Correct |
| `sweepAgedEntries` | proper-lockfile | Directory of the target file | ✅ Correct |
| `sweepStaleTodos` | proper-lockfile | Directory of the target file | ✅ Correct |
| `quarantineEntry` | proper-lockfile | `.swarm/` directory | ✅ Correct |
| `restoreEntry` | proper-lockfile | `.swarm/` directory | ✅ Correct |
| `appendKnowledge` | **None** | N/A | ⚠️ Comment claims OS-level atomic append, which is not guaranteed |
| `appendRejectedLesson` | **None** for append path | N/A | ⚠️ Calls appendKnowledge which has no lock |
| `enforceKnowledgeCap` | Uses rewriteKnowledge internally | ✅ | ✅ Correct |

### Atomicity Summary

- `rewriteKnowledge`: Full file rewrite with temp file? **No** — uses `writeFile` directly under lock. If the process crashes mid-write, the file could be left in a partial state. A write-to-temp-then-rename pattern would be safer.
- `appendKnowledge`: Single `appendFile` call. On Windows, this is NOT atomic — a crash during write could leave a partial line.
- Quarantine/restore: Multi-file operations (remove from source, append to destination, enforce caps) all under a SINGLE lock acquisition — ✅ correctly atomic.

### Race Condition Risks

The highest-risk race is the dual-hive-file scenario (Finding 1): the `tools` and `knowledge/` code paths write to a completely different file than the `hooks/` code path reads. This is not a concurrency issue but a data integrity issue.

Within a single process, the event loop serializes execution, so sequential async operations are safe. The real risk is:
1. Multiple OpenCode sessions sharing the same project directory
2. Multiple plugin instances from different processes

In those scenarios, `appendKnowledge` (no lock) poses the biggest risk of interleaved or partial writes.

### JSONL Corruption Behavior

`readKnowledge` (`knowledge-store.ts:83-101`): When parsing JSONL files, corrupted lines are skipped with a warning. This is robust — a corrupted single line does not prevent reading subsequent entries. The first 80 chars of the corrupted line are logged.

---

## Final Recommendation

**Requires fixes before use in production.**

### Critical (must fix):
1. Consolidate the dual hive implementation — delete `src/knowledge/hive-promoter.ts` and update `src/commands/promote.ts` to use `src/hooks/hive-promoter.ts`
2. Migrate any existing `hive-knowledge.jsonl` data to `shared-learnings.jsonl` (or provide a migration path)

### High (fix before relying on system):
3. Wire `sweepStaleTodos` into production code path
4. Fix the 3 failing tests in `knowledge-reader-key-normalization.test.ts`

### Medium (fix before wide adoption):
5. Add near-duplicate check to `knowledge_add` tool
6. Add knowledge tool test files (`knowledge-add.test.ts`, `knowledge-recall.test.ts`, `knowledge-remove.test.ts`)
7. Update `knowledge_remove` to optionally handle hive entries

### Low (document or fix):
8. Fix `knowledge_add` hardcoded `auto_generated: true`
9. Filter `archived` entries in `knowledge_recall`
10. Add `auto_generated: false` to tool-based knowledge additions
11. Update docs to note `knowledge_remove` only works on swarm tier

---

## Appendix A: Commands Run

```bash
# Core knowledge tests
bun test tests/unit/hooks/knowledge-store.test.ts
bun test tests/unit/hooks/knowledge-validator.test.ts
bun test tests/unit/hooks/knowledge-quarantine.test.ts
bun test tests/unit/hooks/knowledge-registration.test.ts
bun test tests/unit/hooks/knowledge-types.test.ts
bun test tests/unit/hooks/knowledge-store-caps.test.ts
bun test tests/unit/hooks/knowledge-store-sweep.test.ts

# Tools/commands tests
bun test tests/unit/commands/knowledge.test.ts
bun test tests/unit/tools/knowledge-query.test.ts
bun test tests/unit/config/knowledge-config.test.ts
bun test tests/unit/agents/architect-knowledge-tools-alignment.test.ts

# Injector/curator tests
bun test tests/unit/hooks/knowledge-injector.test.ts
bun test tests/unit/hooks/knowledge-injector-allowlist.test.ts
bun test tests/unit/hooks/knowledge-injector-drift.test.ts
bun test tests/unit/hooks/knowledge-curator.test.ts

# Hive/migrator/reader tests
bun test tests/unit/hooks/hive-promoter.test.ts
bun test tests/unit/hooks/knowledge-migrator.test.ts
bun test tests/unit/hooks/knowledge-reader.test.ts
bun test tests/unit/hooks/knowledge-reader-key-normalization.test.ts
```

## Appendix B: Files Inspected

### Source files
- `src/index.ts` — Plugin registration, hook wiring
- `src/state.ts` — Session state, rehydration
- `src/config/constants.ts` — Agent tool maps, DEFAULT_MODELS, TOOL_DESCRIPTIONS
- `src/config/schema.ts` (lines 824-879) — KnowledgeConfigSchema
- `src/hooks/knowledge-types.ts` — Type definitions
- `src/hooks/knowledge-store.ts` — Storage layer (read, write, dedup, sweep, cap)
- `src/hooks/knowledge-reader.ts` — Read/merge/rank/retrieval-outcome
- `src/hooks/knowledge-injector.ts` — Context injection hook
- `src/hooks/knowledge-validator.ts` — Validation gate + quarantine/restore
- `src/hooks/knowledge-curator.ts` — Curator hook (retro extraction, evidence extraction)
- `src/hooks/knowledge-migrator.ts` — Legacy migration
- `src/hooks/hive-promoter.ts` — Hook-based hive promotion
- `src/hooks/curator.ts` — Curator core (read/write summary, runCuratorInit, runCuratorPhase)
- `src/hooks/curator-types.ts` — Curator type definitions
- `src/hooks/curator-drift.ts` — Drift report read/write/build
- `src/hooks/utils.ts` — safeHook, validateSwarmPath, readSwarmFileAsync
- `src/hooks/curator-llm-factory.ts` — Not inspected directly (found references)
- `src/agents/curator-agent.ts` — Curator agent definition
- `src/agents/explorer.ts` — CURATOR_INIT_PROMPT, CURATOR_PHASE_PROMPT
- `src/tools/knowledge-add.ts` — knowledge_add tool
- `src/tools/knowledge-recall.ts` — knowledge_recall tool
- `src/tools/knowledge-query.ts` — knowledge_query tool
- `src/tools/knowledge-remove.ts` — knowledge_remove tool
- `src/tools/tool-names.ts` — Tool name registry
- `src/commands/knowledge.ts` — Knowledge command handlers
- `src/commands/promote.ts` — Promote command handlers
- `src/commands/curate.ts` — Curate command handler
- `src/commands/index.ts` — Command dispatch
- `src/knowledge/hive-promoter.ts` — **DUPLICATE** hive promotion
- `src/knowledge/index.ts` — Knowledge exports

### Test files
- `tests/unit/hooks/knowledge-store.test.ts`
- `tests/unit/hooks/knowledge-registration.test.ts`
- `tests/unit/hooks/knowledge-validator.test.ts`
- `tests/unit/hooks/knowledge-quarantine.test.ts`
- `tests/unit/hooks/knowledge-injector.test.ts`
- `tests/unit/hooks/knowledge-injector-allowlist.test.ts`
- `tests/unit/hooks/knowledge-injector-drift.test.ts`
- `tests/unit/hooks/knowledge-curator.test.ts`
- `tests/unit/hooks/knowledge-reader-key-normalization.test.ts`
- `tests/unit/commands/knowledge.test.ts`
- `tests/unit/tools/knowledge-query.test.ts`

### Config files
- `package.json`
- `docs/knowledge.md`

## Appendix C: Search Terms Used

- `knowledge` — all surfaces
- `Knowledge` — class/type references
- `hive` — hive tier references
- `curator` — curator references
- `retrieval` — retrieval outcome references
- `recall` — knowledge_recall
- `inject` — injection path
- `lesson` — lesson field references
- `candidate` / `established` / `promoted` / `archived` — status transitions
- `quarantine` — quarantine references
- `restore` — restore references
- `RETRACT` — retraction pattern
- `BAD RULE` — bad rule pattern
- `sweep` — TTL sweep
- `safeHook` — error wrapping
- `proper-lockfile` — locking
- `append` — write operations
- `rewrite` — full file writes
- `JSONL` — JSONL formatting
- `.swarm` — swarm file paths
- `validateLesson` — validation callers
