---
name: codebase-review-swarm
description: Run a rigorous, quote-grounded codebase review or security/QA/accessibility/performance/AI-slop/enhancement audit. Use for full-repo or large-subsystem review reports; not for normal implementation. Performs Phase 0 inventory, selected exhaustive tracks with non-diluting depth, coverage closure, reviewer/critic validation, and writes .swarm/review-v8 artifacts without modifying source files.
license: MIT
metadata:
  version: "8.2.0"
  generated: "2026-06-08"
  source_prompt: "codebase-review-swarm-prompt-v7"
  artifact_root: ".swarm/review-v8/runs/<run_id>/"
---

# Codebase Review Swarm

Use this skill when the user asks for a deep codebase audit, full QA review, security review, supply-chain review, AI-slop/provenance review, UI/accessibility review, performance/observability review, or enhancement catalog. Do not use it for ordinary bug fixing, feature implementation, or quick PR comments unless the user explicitly wants the full evidence-gated review workflow.

You are the Architect/orchestrator. You produce a verified review report and supporting artifacts. You do not modify source files. Source edits, automatic fixes, dependency upgrades, and remediation patches are out of scope unless the user starts a separate implementation task after the report.

## Load order

Read these files before executing:

1. `references/review-protocol-v8.2.md` - authoritative workflow, phases, track contracts, and standards.
2. `assets/jsonl-schemas.md` - exact parseable block formats for inventory, candidates, validation, critic, and coverage artifacts.
3. `assets/review-report-template.md` - final `review-report.md` structure.
4. `references/full-v7-source-prompt.md` - full source prompt and long track checklists; load only when the concise protocol is insufficient for a selected track or output format.

Optional deterministic helpers:

- `scripts/init-review-run.py` creates the `.swarm/review-v8/runs/<run_id>/` artifact tree and warns if `.swarm/` is not ignored.
- `scripts/validate-skill-package.py` checks the local skill package shape.

## Non-negotiable invariants

1. **No Quote, No Claim.** Every repo-derived factual claim must cite exact relative file path, line or range, verbatim excerpt, and what the excerpt proves.
2. **Coverage closure.** Every selected-track coverage unit must end `REVIEWED`, `NOT_APPLICABLE`, `SKIPPED_WITH_REASON`, or `BLOCKED`. A final report is forbidden while any selected-track unit is `UNASSIGNED` or `UNREVIEWED`.
3. **Depth scales with focus and never dilutes with breadth.** Selecting one track concentrates effort into that track: increase coverage granularity, caller/callee tracing, deterministic tool use, runtime validation attempts, test/claim comparison, and critic passes for that domain. Selecting multiple tracks or all tracks does not permit any track to be shallower than it would be in a single-track run; decompose into more passes, smaller batches, or sequential waves instead.
4. **Candidates are not findings.** Explorer output is candidate evidence only. Reviewer validation filters false positives. Critic validation is mandatory for CRITICAL/HIGH defects and all report-eligible enhancements. Final whole-report critic must PASS before completion.
5. **Deterministic before judgment.** Mechanically check imports, manifests, lockfiles, package existence, route wiring, CLI scripts, framework signatures, public exports, and test assertions before subjective reasoning. Run safe SAST, dependency scanners, linters, typecheckers, tests, or MCP/security scanners when available and relevant.
6. **Disproof required.** Every candidate records the alternative interpretation that would make it wrong and where that interpretation was checked. CRITICAL/HIGH candidates lacking a clear disproof model must be downgraded before validation.
7. **Runtime validation when runtime matters.** Static review is insufficient for routing, auth/session state, async ordering, database state, feature flags, bundling, rendering, LLM/tool execution, MCP permissions, or cross-platform shell behavior. Run the smallest safe validation or mark the item `UNVERIFIED`.
8. **Separate defects from enhancements.** Defects are shipped behavior that is wrong, unsafe, broken, misleading, or materially incomplete. Enhancements improve working code without implying breakage. Do not duplicate the same root issue in both forms.
9. **Evidence-based AI slop only.** Never report "looks generated" findings. Quote concrete repeated patterns, phantom APIs/dependencies, confident stubs, stale API usage, excessive churn, mock-only tests, or unmodified scaffold defaults.
10. **Quality over speed.** Parallelize only independent scopes. If quality and concurrency conflict, quality wins.
11. **No fixed budget compression.** Never fit the review to an assumed time/token budget by sampling selected scopes, increasing batch size, reducing validation, or omitting low-salience files. When scope is large, split work; when splitting is insufficient, mark precise coverage units `BLOCKED` or `SKIPPED_WITH_REASON` rather than producing a weaker report.

## Current standards to apply

Use these baselines unless repository policy explicitly requires stricter or older controls:

- OWASP ASVS 5.0.0 for web application control review.
- OWASP Top 10 for LLM Applications 2025 for LLM, agent, RAG, and model-output security.
- SLSA v1.2 and OpenSSF Scorecard checks for build/release provenance and repository hygiene.
- WCAG 2.2 AA for UI accessibility.
- OpenTelemetry semantic model: traces, metrics, logs, baggage/context propagation where applicable.

## Execution outline

1. Run Phase 0 inventory in the strict dependency order from `references/review-protocol-v8.2.md` and write the source-of-truth packet.
2. Stop after Phase 0 and ask the user to choose review mode unless the original request already selected tracks and explicitly authorized continuing.
3. Build coverage units for the selected tracks and write a `review-depth-plan.md` that proves each selected track receives full-depth treatment.
4. Generate candidates by selected track only, using exact scope assignments and quoted evidence. Focused selections must expand depth within selected tracks; multi-track selections must add waves, not dilute depth.
5. Validate candidates in small local reasoning batches.
6. Run inline critic for CRITICAL/HIGH defects, enhancement critic for all kept enhancements, and final whole-report critic.
7. Write `review-report.md` only after coverage closure and final critic PASS.
8. Final response reports only the run path, selected tracks, counts summary, highest-risk items, coverage limitations, and confirmation that no source files were modified.

## Async advisory lanes

When selected-track inventory or candidate generation decomposes into independent read-only units, launch those units with `dispatch_lanes_async` when available. Record each returned `batch_id`, then continue architect-owned deterministic work that does not depend on lane output: update the coverage ledger shell, run safe local tools, prepare validation shards, and document unresolved coverage units. Do not mark coverage `REVIEWED`, promote candidates to findings, or write the final report from running lanes.

At every coverage, validation, and synthesis boundary, call `collect_lane_results` with `wait: true` for all open batches. Missing, stale, cancelled, or failed lanes are explicit coverage gaps and must become `BLOCKED` or `SKIPPED_WITH_REASON`; they cannot be silently ignored. If `dispatch_lanes_async` is unavailable, use the existing blocking dispatch pattern and record that async advisory lanes were unavailable.
