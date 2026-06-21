---
name: deep-dive
description: >
  Full execution protocol for MODE: DEEP_DIVE — read-only codebase audit with
  parallel explorer waves, 2 independent reviewers, and sequential critic
  challenge for HIGH/CRITICAL findings. Loaded on demand by the architect when
  the deep-dive command emits a [MODE: DEEP_DIVE ...] signal.
---

# Deep Dive Audit Protocol

Read-only deep audit of a specified codebase scope using parallel explorer waves, always 2 parallel reviewers, and sequential critic challenge. This mode does NOT mutate source code, does NOT delegate to coder, and does NOT call declare_scope.

### MODE: DEEP_DIVE

## Step 0 — Parse Header

Parse the MODE: DEEP_DIVE header to extract:
- `scope`: the codebase area to audit (e.g., "auth", "payment flow", "src/hooks/")
- `profile`: one of standard | security | ux | architecture | full (default: standard)
- `max_explorers`: integer 1..8 (default: 6, or 8 for full profile)
- `output`: markdown | json (default: markdown)
- `update_main`: boolean (default: true) — whether to fetch/ff-only main before starting
- `allow_dirty`: boolean (default: false) — whether to proceed with uncommitted changes

If the header is malformed or missing required fields, report the error and stop.

## Step 1 — Repo Readiness

1. Check git working tree status. If dirty and `allow_dirty` is false, warn the user and ask whether to proceed. Do NOT proceed automatically.
2. If `update_main` is true and tree is clean: check current branch. If not on `main`, report current branch to user and ASK FOR CONFIRMATION before switching. Only after explicit user approval: `git fetch origin main && git checkout main && git merge --ff-only origin/main`. If ff-only fails, warn the user and ask before proceeding.
3. Record the current HEAD commit hash for the report.

## Step 2 — Scope Resolution

Use the following tools to map the audit scope:
1. `repo_map` with action "build" to establish the code graph
2. `repo_map` with action "localization" for the scope target
3. `symbols` and `batch_symbols` on key files identified by localization
4. `imports` to trace dependency boundaries
5. `doc_scan` if documentation coverage is relevant
6. `knowledge_recall` with query matching the scope domain

Produce a SCOPE MAP: list of files, modules, and interfaces within the audit boundary. Cap at 50 files total.

## Step 3 — Explorer Missions (Parallel Waves)

Dispatch explorer waves with `dispatch_lanes_async` when available. Each wave contains up to `max_explorers` missions.

**File caps per mission:**
- 8 files maximum per mission
- ~3500 total lines across all files in a mission
- Group files by import proximity (files that import each other go in the same mission)

**Profile-based lane selection — each profile activates specific lanes:**

| Lane | Template | standard | security | ux | architecture | full |
|------|----------|----------|----------|----|-------------|------|
| SCOPE_MAP | Map structure, exports, boundaries | ✓ | ✓ | ✓ | ✓ | ✓ |
| WIRING_DATAFLOW | Trace data flow, API contracts, state propagation | ✓ | ✓ | | ✓ | ✓ |
| RUNTIME_BEHAVIOR | Error handling, edge cases, lifecycle, async patterns | ✓ | | | ✓ | ✓ |
| UX_FLOW | User-facing behavior, accessibility, responsiveness | | | ✓ | | ✓ |
| SECURITY_TRUST | Auth boundaries, input validation, trust transitions | | ✓ | | | ✓ |
| TEST_COVERAGE | Coverage gaps, flaky tests, missing assertions | ✓ | | | | ✓ |
| PERFORMANCE_RELIABILITY | Resource leaks, N+1 queries, race conditions | | | | ✓ | ✓ |
| DOCS_CONFIG_DEPLOYMENT | Config consistency, docs accuracy, deployment drift | | | | | ✓ |

Each explorer mission receives:
- Lane template name and description
- Assigned files (8 max, grouped by import proximity)
- The scope map context from Step 2
- Instruction: "You are performing a [LANE] audit. Report findings as candidate observations with severity (INFO/LOW/MEDIUM/HIGH/CRITICAL), location, and evidence."

Explorer missions are dispatched in parallel waves. Launch the wave promptly — do not accumulate extensive planning prose before the call, or output truncation may swallow the tool call itself. Launch the wave, record the returned `batch_id`, then continue deterministic architect work that does not depend on lane output: refine the scope map, build the candidate ledger shell, inspect local evidence with read-only tools, and prepare reviewer shard structure. Do not synthesize findings from running lanes. Keep each lane `prompt` compact: send shared context ONCE via the `common_prompt` field, or have lanes read it from a file by absolute path, instead of inlining the same large blob into every lane prompt — oversized inline prompts produce malformed or truncated tool-call JSON.

At the Step 4 boundary, call `collect_lane_results` with `wait: true` for every open wave batch. Treat missing, stale, cancelled, or failed lanes as explicit coverage gaps; do not silently proceed past a required lane. If `dispatch_lanes_async` is unavailable, use blocking `dispatch_lanes` or parallel Task calls and record that async advisory lanes were unavailable.

When a collected or blocking lane result includes `output_ref`, treat `output` as a preview and call `retrieve_lane_output` before extracting candidate findings or declaring a lane clean. If the result is `output_degraded`, `transcript_incomplete`, truncated without a usable ref, missing, stale, cancelled, or failed, record the lane as a coverage gap and re-dispatch a narrower lane or mark the affected findings/coverage UNVERIFIED.

Explorers generate CANDIDATE FINDINGS only — they do NOT make verdicts. All findings are unverified until Step 5.

## Step 4 — Normalize Candidates

1. Collect all candidate findings from all explorer missions.
2. Deduplicate: merge findings that reference the same location and issue.
3. Assign DD-C001 through DD-CNNN identifiers to unique findings.
4. Cap at 10 findings per shard (see Step 5 for sharding).
5. Sort by severity (CRITICAL → HIGH → MEDIUM → LOW → INFO).

## Step 5 — Always 2 Parallel Reviewers

Split the verified candidates into 2 shards of ≤10 candidates each. Dispatch 2 parallel `the active swarm's reviewer agent` calls.

Each reviewer receives:
- Their shard of candidates (up to 10)
- The scope map context
- The original scope description
- Instruction: "Verify or reject each candidate finding. For each: verdict (VERIFIED / REJECTED / NEEDS_MORE_EVIDENCE), confidence (0-1), and brief reasoning."

Reviewers MUST NOT suggest fixes — they verify findings only.

## Step 5b — Reviewer Merge/Dedup

After both reviewers return, perform a lightweight sync pass:
1. Cross-reference findings between reviewers — flag correlations
2. Deduplicate any findings both reviewers verified independently
3. For NEEDS_MORE_EVIDENCE findings: if the other reviewer verified a related finding, merge
4. Produce a unified findings list with verified/rejected status

## Step 6 — Critic Challenge (HIGH/CRITICAL only)

For verified findings rated HIGH or CRITICAL, dispatch sequential critic passes:

**Pass 1 — False-positive / root-cause challenge:**
- `the active swarm's critic agent` receives each HIGH/CRITICAL finding
- Challenge: "Is this a false positive? Is the root cause correctly identified? Provide verdict: SURVIVES / DOWNGRADE / REJECT"
- Only findings that SURVIVE proceed to Pass 2

**Pass 2 — Impact / severity challenge:**
- `the active swarm's critic agent` receives surviving findings
- Challenge: "Is the severity correctly rated? Could this be lower impact than claimed? Provide verdict: SURVIVES / DOWNGRADE / REJECT"
- Final severity is the critic's assessed severity

CRITICAL: Do NOT challenge MEDIUM/LOW/INFO findings. Only HIGH and CRITICAL go through critic review.

## Step 7 — Final Report

Assemble and present the audit report:

1. **Wiring Map**: Visual summary of the scope's module structure and data flow
2. **Functionality Assessment**: High-level summary of what the scope does and how well
3. **Verified Findings Table**: DD-ID, severity, location, description, evidence
4. **Rejected Candidates**: Brief list with rejection reasons
5. **Enhancements**: Non-blocking improvement suggestions
6. **Recommended Implementation Phases**: If findings suggest follow-up work, outline phases
7. **JSON Block** (when output=json): Structured machine-readable findings

## Important Constraints

- Do NOT mutate source code under any circumstances
- Do NOT delegate to coder
- Do NOT call declare_scope
- Do NOT create or modify any files outside .swarm/
- No final finding may appear in the report without reviewer verification
- Explorers generate candidate findings only — reviewers verify or reject
- Critics challenge only HIGH/CRITICAL findings — do NOT waste cycles on lower severity
