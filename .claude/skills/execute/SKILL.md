---
name: execute
description: >
  Full execution protocol for MODE: EXECUTE -- task execution, coder retry handling, QA gates, completion evidence, and per-task closure.
---

# Execute Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: EXECUTE
For each task (respecting dependencies):

RETRY PROTOCOL — when returning to coder after any gate failure:
1. Provide structured rejection: "GATE FAILED: [gate name] | REASON: [details] | REQUIRED FIX: [specific action required]"
2. Re-enter at step 5b (the active swarm's coder agent) with full failure context
3. Resume execution at the failed step (do not restart from 5a)
   Exception: if coder modified files outside the original task scope, restart from step 5c
4. Gates already PASSED may be skipped on retry if their input files are unchanged
5. Print "Resuming at step [5X] after coder retry [N/configured QA retry limit]" before re-executing

GATE FAILURE RESPONSE RULES — when ANY gate returns a failure:
You MUST return to the active swarm's coder agent. You MUST NOT fix the code yourself.

WRONG responses to gate failure:
✗ Editing the file yourself to fix the syntax error
✗ Running a tool to auto-fix and moving on without coder
✗ "Installing" or "configuring" tools to work around the failure
✗ Treating the failure as an environment issue and proceeding
✗ Deciding the failure is a false positive and skipping the gate

RIGHT response to gate failure:
✓ Print "GATE FAILED: [gate name] | REASON: [details]"
✓ BEFORE the retry delegation: call `declare_scope` with the file list the retry will touch. Re-declare even if the files are identical to the original task — retry scope persists per-call, not per-task. See Rule 1a.
✓ Delegate to the active swarm's coder agent with:
TASK: Fix [gate name] failure
FILE: [affected file(s)]
INPUT: [exact error output from the gate]
CONSTRAINT: Fix ONLY the reported issue, do not modify other code
✓ After coder returns, re-run the failed gate from the step that failed
✓ Print "Coder attempt [N/configured QA retry limit] on task [X.Y]"

The ONLY exception: lint tool in fix mode (step 5g) auto-corrects by design.
All other gates: failure → return to coder. No self-fixes. No workarounds.

5a. **UI DESIGN GATE** (conditional — Rule 9): If task matches UI trigger → the active swarm's designer agent produces scaffold → pass scaffold to coder as INPUT. If no match → skip.

→ After step 5a (or immediately if no UI task applies): Call update_task_status with status in_progress for the current task. Then proceed to step 5b.

5a-bis. **DARK MATTER CO-CHANGE DETECTION**: After declaring scope but BEFORE finalizing the task file list, call knowledge_recall with query hidden-coupling primaryFile where primaryFile is the first file in the task's FILE list. Extract primaryFile from the task's FILE list (first file = primary). If results found, add those files to the task's AFFECTS scope with a BLAST RADIUS note. If no results or knowledge_recall unavailable, proceed gracefully without adding files. This is advisory — the architect may exclude files from scope if they are unrelated to the current task. Delegate to the active swarm's coder agent only after scope is declared.

5b-PRE (required): Call `declare_scope({ taskId, files })` with the EXACT file list for this task — including any co-change files surfaced by 5a-bis. Skipping this call will cause every coder write to be BLOCKED by scope-guard. No `declare_scope` → no 5b delegation. See Rule 1a.
    5b-BASE (required, once per task): Call `sast_scan` with `{ capture_baseline: true, phase: <N>, changed_files: <files from 5b-PRE> }` where `<N>` is the current phase number (extract from current task ID: task "3.2" → phase 3, task "1.5" → phase 1). The tool maintains `.swarm/evidence/{phase}/sast-baseline.json` as a phase-scoped, incrementally merged baseline of pre-existing SAST findings. Calling twice for the same files is safe (idempotent merge). Do NOT re-capture mid-task.
    → REQUIRED: Print "sast-baseline: [WRITTEN — N fingerprints | MERGED — N fingerprints | SKIPPED — gate disabled | ERROR — details]"
    → Subsequent `pre_check_batch` calls with `phase: <N>` will automatically diff against this baseline — only NEW findings (not in baseline) drive the fail verdict.
5b. the active swarm's coder agent - Implement (if designer scaffold produced, include it as INPUT).
5b-bis. **CODER OUTPUT VERIFICATION**: After the coder reports completion, do NOT accept the self-report alone. Run `diff` (step 5c) and inspect at least one of the modified files yourself to confirm the change exists. The coder may report DONE without having produced any diff. A 30-second read of the changed file(s) catches this failure mode. This is NOT a separate explorer dispatch — the existing `diff` tool at step 5c is the verification mechanism; the key discipline is checking that `diff` returns actual changes before proceeding, rather than forwarding the coder's self-report to the next gate.
5c. Run `diff` tool. If `hasContractChanges` → the active swarm's explorer agent integration analysis. If COMPATIBILITY SIGNALS=INCOMPATIBLE or MIGRATION_SURFACE=yes → coder retry. If COMPATIBILITY SIGNALS=COMPATIBLE and MIGRATION_SURFACE=no → proceed.
    → REQUIRED: Print "diff: [PASS | CONTRACT CHANGE — details]"
    5d. Run `syntax_check` tool. SYNTACTIC ERRORS → return to coder. NO ERRORS → proceed to placeholder_scan.
    → REQUIRED: Print "syntaxcheck: [PASS | FAIL — N errors]"
    5e. Run `placeholder_scan` tool. PLACEHOLDER FINDINGS → return to coder. NO FINDINGS → proceed to imports.
    → REQUIRED: Print "placeholderscan: [PASS | FAIL — N findings]"
    5f. Run `imports` tool for dependency audit. ISSUES → return to coder.
    → REQUIRED: Print "imports: [PASS | ISSUES — details]"
    5g. Run `lint` tool with fix mode for auto-fixes. If issues remain → run `lint` tool with check mode. FAIL → return to coder.
    → REQUIRED: Print "lint: [PASS | FAIL — details]"
    5h. Run `build_check` tool. BUILD FAILS → return to coder. SUCCESS → proceed to pre_check_batch.
    → REQUIRED: Print "buildcheck: [PASS | FAIL | SKIPPED — no toolchain]"
    5i. Run `pre_check_batch` tool with `phase: <N>` (same phase number used in 5b-BASE) → runs four verification tools in parallel (max 4 concurrent):
    - lint:check (code quality verification)
    - secretscan (secret detection)
    - sast_scan (static security analysis — diffs against phase baseline when phase provided)
    - quality_budget (maintainability metrics)
    → Returns { gates_passed, lint, secretscan, sast_scan, quality_budget, total_duration_ms }
    → sast_scan result may include { new_findings, pre_existing_findings, baseline_used } when baseline diff is active.
    → If ALL FOUR tools have ran === false (lint.ran === false && secretscan.ran === false && sast_scan.ran === false && quality_budget.ran === false):
        → This is a SKIP - no tools actually ran. Print "pre_check_batch: SKIP — all tools ran===false (no files to check or tools not available)" and proceed to the active swarm's reviewer agent.
    → Else if gates_passed === false: read individual tool results, identify which tool(s) failed, return structured rejection to the active swarm's coder agent with specific tool failures. Do NOT call the active swarm's reviewer agent.
    → If gates_passed === true AND sast_preexisting_findings is present: proceed to the active swarm's reviewer agent. Include the pre-existing SAST findings in the reviewer delegation context with instruction: "SAST TRIAGE REQUIRED: The following SAST findings existed before this task began (from phase baseline or unchanged lines). Verify these are acceptable pre-existing conditions and do not interact with the new changes." Do NOT return to coder for pre-existing findings.
    → If gates_passed === true (no sast_preexisting_findings): proceed to the active swarm's reviewer agent.
    → REQUIRED: Print "pre_check_batch: [PASS — all gates passed | PASS — pre-existing SAST findings (N findings, reviewer triage) | FAIL — [gate]: [details]]"

⚠️ pre_check_batch SCOPE BOUNDARY:
pre_check_batch runs FOUR automated tools: lint:check, secretscan, sast_scan, quality_budget.
pre_check_batch does NOT run and does NOT replace:
- the active swarm's reviewer agent (logic review, correctness, edge cases, maintainability)
- the active swarm's reviewer agent security-only pass (OWASP evaluation, auth/crypto review)
- the active swarm's test_engineer agent verification tests (functional correctness)
- the active swarm's test_engineer agent adversarial tests (attack vectors, boundary violations)
- diff tool (contract change detection)
- placeholder_scan (TODO/stub detection)
- imports (dependency audit)
gates_passed: true means "automated static checks passed."
It does NOT mean "code is reviewed." It does NOT mean "code is tested."
After pre_check_batch passes, you MUST STILL delegate to the active swarm's reviewer agent.
Treating pre_check_batch as a substitute for the active swarm's reviewer agent is a PROCESS VIOLATION.

    5j-COUNCIL (when council_mode is ON — replaces steps 5j through 5l):
    When `council_mode` is enabled in the QA gate profile, Stage B (steps 5j-5l: reviewer + test_engineer) is REPLACED by the full 5-member council per task.

    After Stage A (pre_check_batch) passes:
    1. Ensure `declare_council_criteria` was called for this task (prerequisite).
    2. Dispatch all 5 council members (critic, reviewer, sme, test_engineer, explorer) in PARALLEL with task-scoped context.
    3. Collect all 5 verdict objects. Do NOT fabricate or substitute verdicts.
    4. Call `submit_council_verdicts` with the collected verdicts.
    5. Act on the verdict: APPROVE → task passes. CONCERNS with `success: false` + `reason: 'blocking_concerns_unresolved'` → HIGH/CRITICAL findings are blocking, no evidence written, return to coder with requiredFixes and re-council after fixes. CONCERNS with `success: true` → only MEDIUM/LOW advisory findings, task passes. REJECT → return to coder with requiredFixes.

    When `council_mode` is OFF, the standard Stage B flow (steps 5j-5l: reviewer + test_engineer) runs as normal.

    5j. the active swarm's reviewer agent - General review. REJECTED before the configured QA retry limit → coder retry. REJECTED at the configured QA retry limit → escalate.
    → REQUIRED: Print "reviewer: [APPROVED | REJECTED — reason]"
    5k. Security gate: if change matches TIER 3 criteria OR content contains SECURITY_KEYWORDS OR secretscan has ANY findings OR sast_scan has ANY findings at or above threshold → MUST delegate the active swarm's reviewer agent security-only review. REJECTED before the configured QA retry limit → coder retry. REJECTED at the configured QA retry limit → escalate to user.
    → REQUIRED: Print "security-reviewer: [TRIGGERED | NOT TRIGGERED — reason]"
    → If TRIGGERED: Print "security-reviewer: [APPROVED | REJECTED — reason]"
    5l. the active swarm's test_engineer agent - Verification tests. FAIL → coder retry from 5g.
    → REQUIRED: Print "testengineer-verification: [PASS N/N | FAIL — details]"
    5l-bis. REGRESSION SWEEP (automatic after test_engineer-verification PASS):
    Run test_runner with { scope: "graph", files: [<all source files changed by coder in this task>] }.
    scope:"graph" traces imports to discover test files beyond the task's own tests that may be affected by this change.
    
    Outcomes (based on test_runner result.outcome field):
    - outcome: "pass" → All tests passed. Print "regression-sweep: PASS [N additional tests, M files]"
    - outcome: "regression" → Tests ran but some failed. Print "regression-sweep: FAIL — REGRESSION DETECTED in [files]. The failing tests are CORRECT — fix the source code, not the tests." Return to coder with retry from 5g.
    - outcome: "skip" → No test files resolved (nothing to run). Print "regression-sweep: SKIPPED — no related tests beyond task scope"
    - outcome: "scope_exceeded" → Too many files for graph scope. Print "regression-sweep: SKIPPED — broad scope, no related tests beyond task scope"
    - outcome: "error" → Tool error (timeout, no framework, etc.). Print "regression-sweep: SKIPPED — test_runner error" and continue pipeline.
    
    IMPORTANT: The regression sweep runs test_runner DIRECTLY (architect calls the tool). Do NOT delegate to test_engineer for this — the test_engineer's EXECUTION BOUNDARY restricts it to its own test files. The architect has unrestricted test_runner access.
    → REQUIRED: Print "regression-sweep: [PASS | FAIL — REGRESSION DETECTED | SKIPPED — no related tests | SKIPPED — broad scope | SKIPPED — test_runner error]"

    5l-ter. TEST DRIFT CHECK (conditional): Run this step if the change involves any drift-prone area:
    - Command/CLI behavior changed (shell command wrappers, CLI interfaces)
    - Parsing or routing logic changed (argument parsing, route matching, file resolution)
    - User-visible output changed (formatted output, error messages, JSON response structure)
    - Public contracts or schemas changed (API types, tool argument schemas, return types)
    - Assertion-heavy areas where output strings are tested (command/help output tests, error message tests)
    - Helper behavior or lifecycle semantics changed (state machines, lifecycle hooks, initialization)
    
    If NOT triggered: Print "test-drift: NOT TRIGGERED — no drift-prone change detected"
    If TRIGGERED:
    - Use grep/search to find test files that cover the affected functionality
    - Run those tests via test_runner with scope:"convention" on the related test files
    - If any FAIL → print "test-drift: DRIFT DETECTED in [N] tests" and escalate to reviewer/test_engineer
    - If all PASS → print "test-drift: [N] related tests verified"
    - If no related tests found → print "test-drift: NO RELATED TESTS FOUND" (not a failure)
    → REQUIRED: Print "test-drift: [TRIGGERED | NOT TRIGGERED — reason]" and "[DRIFT DETECTED in N tests | N related tests verified | NO RELATED TESTS FOUND | NOT TRIGGERED]"

    5n. TODO SCAN (advisory): Call todo_extract with paths=[list of files changed in this task]. If any results have priority HIGH → print "todo-scan: WARN — N high-priority TODOs in changed files: [list of TODO texts]". If no high-priority results → print "todo-scan: CLEAN". This is advisory only and does NOT block the pipeline.
    → REQUIRED: Print "todo-scan: [WARN — N high-priority TODOs | CLEAN]"

    5m. ADVERSARIAL TEST STEP (config-specific): Use the rendered adversarial-test instruction from the MODE: EXECUTE architect stub. If the stub omits step 5m, skip this step.
    5n. COVERAGE CHECK: If the active swarm's test_engineer agent reports coverage < 70% → delegate the active swarm's test_engineer agent for an additional test pass targeting uncovered paths. This is a soft guideline; use judgment for trivial tasks.

PRE-COMMIT RULE — Before ANY commit or push:
  You MUST answer YES to ALL of the following:
  [ ] Did the active swarm's reviewer agent run and return APPROVED? (not "I reviewed it" — the agent must have run)
  [ ] Did the active swarm's test_engineer agent run and return PASS? (not "the code looks correct" — the agent must have run)
  [ ] Did pre_check_batch run with gates_passed true?
  [ ] Did the diff step run?
  [ ] Did regression-sweep run (or SKIP with no related tests or test_runner error)?
  [ ] Did test-drift check run (or NOT TRIGGERED)?

  If ANY box is unchecked: DO NOT COMMIT. Return to step 5b.
  There is no override. A commit without a completed QA gate is a workflow violation.

## ROLE-BOUNDARY CHANGE VALIDATION (mandatory for prompt changes)
When a task modifies agent prompts (especially explorer, reviewer, critic, or any agent involved in the mapper/validator/challenge hierarchy), add an explicit test validation step:
- If new prompt contract tests exist (e.g., explorer-role-boundary.test.ts, explorer-consumer-contract.test.ts): Run them via test_runner
- If no specific tests exist for the changed prompt: Run test_runner with scope "convention" on the changed file
- Verify the new tests pass before completing the task

This step supplements (not replaces) the existing regression-sweep and test-drift checks. It exists to catch prompt contract regressions that automated gates might miss.

5o. ⛔ TASK COMPLETION GATE — You MUST print this checklist with filled values before marking ✓ in .swarm/plan.md:
  [TOOL] diff: PASS / SKIP — value: ___
  [TOOL] syntax_check: PASS — value: ___
  [TOOL] placeholder_scan: PASS — value: ___
  [TOOL] imports: PASS — value: ___
  [TOOL] lint: PASS — value: ___
  [TOOL] build_check: PASS / SKIPPED — value: ___
  [TOOL] pre_check_batch: PASS (lint:check ✓ secretscan ✓ sast_scan ✓ quality_budget ✓) — value: ___
  [GATE] reviewer: APPROVED — value: ___
  [GATE] reuse_re_verification: VERIFIED / SKIPPED / DUPLICATION_DETECTED — value: ___
  [GATE] security-reviewer: APPROVED / SKIPPED — value: ___
  [GATE] test_engineer-verification: PASS — value: ___
  [GATE] regression-sweep: PASS / SKIPPED — value: ___
  [GATE] test-drift: TRIGGERED / NOT TRIGGERED — value: ___
  [GATE] test_engineer-adversarial: use the rendered checklist entry from the MODE: EXECUTE architect stub
  [GATE] coverage: ≥70% / soft-skip — value: ___

  You MUST NOT mark a task complete without printing this checklist with filled values.
  You MUST NOT fill "PASS" or "APPROVED" for a gate you did not actually run — that is fabrication.
  Any blank "value: ___" field = gate was not run = task is NOT complete.
  Filling this checklist from memory ("I think I ran it") is INVALID. Each value must come from actual tool/agent output in this session.

    5p. Call update_task_status with status "completed".
    5q. OPTIONAL TASK-COMPLETION COMMIT POLICY: read `.swarm/context.md`.
        - If `## Task Completion Commit Policy` contains `commit_after_each_completed_task: true`, immediately call:
          `checkpoint save task-<task-id>-complete`
        - If the section is absent or false, skip this step.
        - This optional commit policy NEVER bypasses PRE-COMMIT RULE checks above.
        - If checkpoint save fails with "duplicate label", the task was already checkpointed from a prior completion or retry. Silently skip — the existing checkpoint is valid.
    5r. Proceed to next task.

## Dispatch-lanes empty-output fallback

This fallback applies only to a settled, blocking `dispatch_lanes` result with empty output (0 chars, `output_digest` matching SHA-256 of empty string `e3b0c442...b855`). It does **not** apply to `dispatch_lanes_async` rows that are still pending/running, an early `collect_lane_results` poll, or an async result whose full text is available through `retrieve_lane_output`.

For read-only advisory lanes, do **not** jump straight to Task. First re-collect async lanes with `collect_lane_results` (`wait: true` when no independent work remains) and inspect any `output_ref` with `retrieve_lane_output`. If a settled blocking `dispatch_lanes` lane is genuinely empty, prefer retrying the same agent through `dispatch_lanes_async` when promptAsync is available. Use the **Task tool** (`Task(subagent_type=..., prompt=...)`) only as a last-resort equivalent dispatch mechanism after the lane tools are unavailable or have produced a confirmed empty settled result; record the same agent, same prompt, same scope, and which dispatch mechanism succeeded.

If the Task tool also returns empty, **then** escalate to substitute review (4-member council without the broken agent) or surface to the user. Never fabricate or substitute a verdict for the missing agent.

## Post-coder write verification

After **any** coder delegation, verify the change actually landed by reading back at least one changed file (grep for a key line that should be present). Coder large or full-file writes can **silently fail** — the tool call appears in the response text but the file remains unchanged, and the coder reports DONE without realizing the write didn't execute.

For large or full-file changes, instruct the coder to use **targeted EDIT operations**, not full-file WRITE — targeted edits are more reliable for substantial changes. If a file appears unchanged after the coder reports DONE, re-delegate with explicit "use targeted EDIT operations, not a full-file WRITE" and verify the readback.
