# Issue-tracer 3.0.0 (gate-driven workflow)

Issue-tracer v3 introduces a normative gate table, acceptance-check-driven validation, a red checkpoint manifest, and a human-enforced merge gate. These changes make issue-trace artifacts durable, verifiable, and auditable end-to-end.

## Changes

- **Gate table (Phase 0-5.1):** Normative table mapping each phase to required artifacts, validator command, and exit condition. Phase names standardized to 0, 1, 2, 2.5, 3, 4, 4.2, 4.5, 4.6, 5, 5.1. Replaces narrative descriptions with machine-checkable gates.

- **Issue validation (Phase 1):** Classification enum (VALID/AMBIGUOUS/ALREADY_FIXED/NOT_A_BUG/FEATURE) with explicit evidence requirements. Related-problems sweep to catch duplicates and subsumption. ALREADY_FIXED proof: GREEN on current main, RED at reported commit or merge-base.

- **Typed acceptance checks (Phase 2.5):** Table with four classes (DISCRIMINATING/PRESERVING/NEW-SURFACE/NON-EXECUTABLE). Each row specifies expected pre-fix and post-fix verdict (RED/GREEN/ERROR). Manifest and checkpoint verification ensure checks are not weakened after the red checkpoint.

- **Red checkpoint manifest:** Append-only record of acceptance-check state at the phase boundary between Phase 2.5 (checks defined and validated RED) and Phase 4 (checks passing GREEN). Checkpoint includes blob hash, file mode, check id, argv, expect regex, and base SHA. Amendments recorded with reason (CHECK_WRONG/FORMAT_ONLY/AC_CHANGED_BY_USER) so drift is auditable.

- **Scripts trace-check.sh and repro-check.sh:** trace-check.sh validates ledger state.md and artifact presence; repro-check.sh runs a check in isolation on a base commit and reviewed commit, captures logs with 2 MiB truncation, and prints a block for pasting into the trace. Both are model-agnostic and exit-code-clean for CI integration.

- **Branch-freshness and clean-worktree rules (Phase 0):** fetch-failed::reason recorded with user-override quoting. Handshake detects adapter shim staleness (MATCH/SHIM/STALE/ABSENT). Trace rejected if worktree is dirty (excluding .agents/issue-traces/).

- **Human-enforced merge gate (Phase 5.1):** PR is published but not merged until Phase 5.1 completes. 10b-merge-approval.md records user approval (verbatim), PR head SHA, and final critic reviewed-commit. merge state is AWAITING_USER_APPROVAL, APPROVED:<sha>, or MERGED. No autonomous push-to-merge.

- **Model-agnostic adapters:** Two thin shims (.claude/skills/issue-tracer/SKILL.md and .agents/skills/issue-tracer/SKILL.md, each <60 lines) reference the canonical v3 protocol at .opencode/skills/issue-tracer/SKILL.md via fixed substring. Adapters do not repeat phases or gate definitions.

- **Sibling docs updated:** .claude/skills/editing-skills/SKILL.md notes issue-tracer as an adapter entry; .opencode/skills/durable-session-state/SKILL.md paths updated to .agents/issue-traces/; src/config/skill-mirrors.ts adapter comment revised and issue-tracer reason string updated.

- **Removal of tracked trace dirs:** git rm -r --cached on four existing .claude/issue-traces directories (now gitignored; existing traces preserved locally).

## User-facing changes

Issue-tracing workflow is now auditable and gate-driven. Agents present a reviewed plan and wait for explicit approval before production edits. No PRs merge without recorded user approval.

## Migration notes

Existing trace directories (.claude/issue-traces/*) remain in the working tree but are no longer tracked. New traces initialize under .agents/issue-traces/ with v3 schema. Protocol endpoint remains `.opencode/skills/issue-tracer/SKILL.md`.
