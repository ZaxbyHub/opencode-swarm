---
name: pre-phase-briefing
description: >
  Full execution protocol for MODE: PRE-PHASE BRIEFING -- phase-start context assembly, evidence review, and task readiness checks.
---

# Pre Phase Briefing Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: PRE-PHASE BRIEFING (Required Before Starting Any Phase)

Before creating or resuming any plan, you MUST read the previous phase's retrospective.

**Phase 2+ (continuing a multi-phase project):**
1. Check `.swarm/evidence/retro-{N-1}/evidence.json` for the previous phase's retrospective
2. If it exists: read and internalize `lessons_learned` and `top_rejection_reasons`
3. If it does NOT exist: note this as a process gap, but proceed
4. Print a briefing acknowledgment:
```
→ BRIEFING: Read Phase {N-1} retrospective.
Key lessons: {list 1-3 most relevant lessons}
Applying to Phase {N}: {one sentence on how you'll apply them}
```

**Phase 1 (starting any new project):**
1. Scan `.swarm/evidence/` for any `retro-*` bundles from prior projects
2. If found: review the 1-3 most recent retrospectives for relevant lessons
3. Pay special attention to `user_directives` — these carry across projects
4. Print a briefing acknowledgment:
```
→ BRIEFING: Reviewed {N} historical retrospectives from this workspace.
Relevant lessons: {list applicable lessons}
User directives carried forward: {list any persistent directives}
```
   OR if no historical retros exist:
```
→ BRIEFING: No historical retrospectives found. Starting fresh.
```

This briefing is a HARD REQUIREMENT for ALL phases. Skipping it is a process violation.

### CODEBASE REALITY CHECK (Required Before Speccing or Planning)

Before any spec generation, plan creation, or plan ingestion begins, the Architect must dispatch the Explorer agent in targeted, scoped chunks — one per logical area of the codebase referenced by the work (e.g., per module, per hook, per config surface). Each chunk must be explored with full depth rather than a broad surface pass.

For each scoped chunk, Explorer must determine:
- Does this file/module/function already exist?
- If it exists, what is its current state? Does it already implement any part of what the plan or spec describes?
- Is the plan's or user's assumption about the current state accurate? Flag any discrepancy between what is expected and what actually exists.
- Has any portion of this work already been applied (partially or fully) in a prior session or commit?

Explorer outputs a CODEBASE REALITY REPORT before any other agent proceeds. The report must list every referenced item with one of:
  NOT STARTED | PARTIALLY DONE | ALREADY COMPLETE | ASSUMPTION INCORRECT

Format:
  REALITY CHECK: [N] references verified, [M] discrepancies found.
    ✓ src/hooks/incremental-verify.ts — exists, line 69 confirmed Bun.spawn
    ✗ src/services/status-service.ts — ASSUMPTION INCORRECT: compactionCount is no longer hardcoded (fixed in v6.29.1)
    ✓ src/config/evidence-schema.ts — confirmed phase_number min(1)

No implementation agent (coder, reviewer, test-engineer) may begin until this report is finalized.

This check fires automatically in:
- MODE: SPECIFY — before explorer dispatch for context (step 2)
- MODE: PLAN — before plan generation or validation
- EXTERNAL PLAN IMPORT PATH — before parsing the provided plan

GREENFIELD EXEMPTION: If the work is purely greenfield (new project, no existing codebase references), skip this check.
