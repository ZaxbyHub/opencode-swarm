---
name: phase-wrap
description: >
  Full execution protocol for MODE: PHASE-WRAP -- phase boundary evidence, drift and hallucination gates, retrospectives, phase completion, and final council.
---

# Phase Wrap Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: PHASE-WRAP
1. {{AGENT_PREFIX}}explorer - Rescan
2. {{AGENT_PREFIX}}docs - Update documentation for all changes in this phase. Provide:
   - Complete list of files changed during this phase
   - Summary of what was added/modified/removed
   - List of doc files that may need updating (README.md, CONTRIBUTING.md, docs/)
3. Update context.md
4. Write retrospective evidence: use the evidence manager (write_retro) to record phase, total_tool_calls, coder_revisions, reviewer_rejections, test_failures, security_findings, integration_issues, task_count, task_complexity, top_rejection_reasons, lessons_learned to .swarm/evidence/. Reset Phase Metrics in context.md to 0.
4.5. Run `evidence_check` to verify all completed tasks have required evidence (review + test). If gaps found, note in retrospective lessons_learned. Optionally run `pkg_audit` if dependencies were modified during this phase. Optionally run `schema_drift` if API routes were modified during this phase.
5. Run `sbom_generate` with scope='changed' to capture post-implementation dependency snapshot (saved to `.swarm/evidence/sbom/`). This is a non-blocking step - always proceeds to summary.
5.5. **Drift verification**: Conditional on .swarm/spec.md existence — if spec.md does not exist, skip silently and proceed to step 5.55. If spec.md exists, delegate to {{AGENT_PREFIX}}critic_drift_verifier with DRIFT-CHECK context:
   - Provide: phase number being completed, completed task IDs and their descriptions
   - Include evidence path (.swarm/evidence/) for the critic to read implementation artifacts
   The critic reads every target file, verifies described changes exist against the spec, and returns per-task verdicts: ALIGNED, MINOR_DRIFT, MAJOR_DRIFT, or OFF_SPEC.
   If the critic returns anything other than ALIGNED on any task, surface the drift results as a warning to the user before proceeding.
   After the delegation returns, YOU (the architect) call the `write_drift_evidence` tool to write the drift evidence artifact (phase, verdict from critic, summary). The critic does NOT write files — it is read-only. Only then proceed to step 5.55. phase_complete will also run its own deterministic pre-check (completion-verify) and block if tasks are obviously incomplete.
5.55. **Hallucination verification (conditional on QA gate)**: Check whether `hallucination_guard` is enabled in the effective QA gate profile for this plan (visible via `get_qa_gate_profile`). If disabled, skip silently and proceed to step 5.6.
   If `hallucination_guard` is enabled, delegate to {{AGENT_PREFIX}}critic_hallucination_verifier with HALLUCINATION-CHECK context:
   - Provide: phase number being completed, completed task IDs, every file touched this phase
   - Include evidence path (.swarm/evidence/) so the verifier can read implementation artifacts
   The verifier reads every changed file cold, cross-references every named API against its real source or package manifest, and returns per-artifact verdicts across four axes: API existence, signature accuracy, doc/spec claim support, citation integrity.
   If the verifier returns NEEDS_REVISION: STOP — do NOT call phase_complete.
   Fix the hallucinations (remove fabricated APIs, correct signatures, repair broken citations), then re-delegate until APPROVED.
   After the delegation returns APPROVED, YOU (the architect) call the `write_hallucination_evidence` tool to write the evidence artifact (phase, verdict, summary). The critic does NOT write files — it is read-only.
   NOTE: This step is enforced by the plugin. If `hallucination_guard` is enabled and `.swarm/evidence/{phase}/hallucination-guard.json` is missing or has a non-APPROVED verdict, phase_complete will be BLOCKED.
   PROFILE LOCK NOTE: If the QA gate profile is already locked (drift verification has approved the plan) and `hallucination_guard` was not elected during the initial QA GATE SELECTION, this step is skipped — report the skip to the user. A new plan cycle is required to enable the gate.
5.56. **Mutation gate (conditional on QA gate)**: Check whether `mutation_test` is enabled in the effective QA gate profile for this plan (visible via `get_qa_gate_profile`). If disabled or turbo mode is active, skip silently and proceed to step 5.6.
   If `mutation_test` is enabled:
   1. Call `generate_mutants` with the list of source files touched this phase to produce mutation patches.
   2. If `generate_mutants` returns a SKIP verdict (LLM unavailable), call `write_mutation_evidence` with verdict SKIP and proceed — SKIP does not block.
   3. Otherwise, call `mutation_test` with the generated patches, the source files, and the test command for this project.
   4. Call `write_mutation_evidence` with the phase number, verdict (PASS/WARN/FAIL), killRate, adjustedKillRate, and summary from the mutation_test result.
   5. If verdict is FAIL: STOP — do NOT call phase_complete. Provide the testImprovementPrompt from mutation_test to the coder to improve test coverage, then re-run from step 1.
   6. If verdict is WARN: non-blocking — proceed to step 5.6 with a warning to the user.
   7. If verdict is PASS: proceed to step 5.6.
   NOTE: This step is enforced by the plugin. If `mutation_test` is enabled and `.swarm/evidence/{phase}/mutation-gate.json` is missing or has a 'fail' verdict, phase_complete will be BLOCKED.
5.6. **Mandatory gate evidence**: Before calling phase_complete, ensure:
   - `.swarm/evidence/{phase}/completion-verify.json` exists (written automatically by the completion-verify gate)
   - `.swarm/evidence/{phase}/drift-verifier.json` exists with verdict 'approved' (written by YOU via the `write_drift_evidence` tool after the critic_drift_verifier returns its verdict in step 5.5) — required when .swarm/spec.md exists
   - `.swarm/evidence/{phase}/hallucination-guard.json` exists with verdict 'approved' (written by YOU via the `write_hallucination_evidence` tool after the critic_hallucination_verifier returns its verdict in step 5.55) — ONLY required when `hallucination_guard` is enabled in the QA gate profile
   - `.swarm/evidence/{phase}/mutation-gate.json` exists with verdict 'pass' or 'warn' (written by YOU via the `write_mutation_evidence` tool after step 5.56) — ONLY required when `mutation_test` is enabled in the QA gate profile
   If any required file is missing, run the missing gate first. Turbo mode skips all gates automatically.
   NOTE: Steps 5.5, 5.55, and 5.56 are enforced by runtime hooks. If `hallucination_guard` is enabled and you skip the critic_hallucination_verifier delegation (or fail to call `write_hallucination_evidence`), phase_complete will be BLOCKED by the plugin. Similarly, if `mutation_test` is enabled and you skip step 5.56 (or fail to call `write_mutation_evidence`), phase_complete will be BLOCKED. These are not suggestions — they are hard enforcement mechanisms.
5.7. **Final Council (conditional on QA gate - last phase only)**: Check whether `final_council` is enabled in the effective QA gate profile (visible via `get_qa_gate_profile`). If disabled, skip silently and proceed to step 6.
   If enabled AND this is the LAST phase in the plan (all other phases have status 'complete' and no more phases remain):
   1. Build a PROJECT DOSSIER from the completed plan, all phase summaries, changed-file summaries, and all relevant evidence artifacts. This is a completed-project review, not General Council mode.
   2. Dispatch `{{AGENT_PREFIX}}critic`, `{{AGENT_PREFIX}}reviewer`, `{{AGENT_PREFIX}}sme`, `{{AGENT_PREFIX}}test_engineer`, and `{{AGENT_PREFIX}}explorer` in PARALLEL with project-scoped context. Each member must review the entire completed body of work and return a `CouncilMemberVerdict` JSON object using `agent`, `verdict` (APPROVE|CONCERNS|REJECT), `confidence`, `findings[]`, `criteriaAssessed[]`, `criteriaUnmet[]`, and `durationMs`.
   3. Collect the five returned verdict objects. Do NOT fabricate, infer, or substitute verdicts. If a member does not return valid JSON, re-dispatch that member.
   4. Call `write_final_council_evidence` with `phase`, `projectSummary`, `roundNumber`, and the collected `verdicts` array. This writes `.swarm/evidence/final-council.json` with plan binding, member verdicts, and quorum metadata.
   5. Do NOT call `convene_general_council`, do NOT dispatch `council_generalist`, `council_skeptic`, or `council_domain_expert`, and do NOT require `council.general.enabled` for this gate. `final_council` is the same five-member phase council rerun at project scope.
   6. Do NOT call `phase_complete` or `/swarm close` until `.swarm/evidence/final-council.json` exists with an approved, plan-bound, quorumed final-council verdict. When `final_council` is enabled, `phase_complete` will block until that evidence exists.
   If enabled but NOT the last phase, skip silently - final council only runs once, after all phases.
6. Summarize to user
7. Ask: "Ready for Phase [N+1]?"

CATASTROPHIC VIOLATION CHECK — ask yourself at EVERY phase boundary (MODE: PHASE-WRAP):
"Have I delegated to {{AGENT_PREFIX}}reviewer at least once this phase?"
If the answer is NO: you have a catastrophic process violation.
STOP. Do not proceed to the next phase. Inform the user:
"⛔ PROCESS VIOLATION: Phase [N] completed with zero {{AGENT_PREFIX}}reviewer delegations.
All code changes in this phase are unreviewed. Recommend retrospective review before proceeding."
This is not optional. Zero {{AGENT_PREFIX}}reviewer calls in a phase is always a violation.
There is no project where code ships without review.

### Blockers
Mark [BLOCKED] in plan.md, skip to next unblocked task, inform user.
