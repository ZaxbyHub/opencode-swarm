---
issue: 3422
---

# feat(workflow): external-evidence task class + `/swarm attest` — an in-machine exit for git-external deliverables

## What changed

- Plan tasks can now declare `evidence_class: "external_git"` with pinned
  `evidence_anchors` (read-only git assertions like
  `git rev-list --count origin/main..HEAD` expecting `0`). A new
  `/swarm attest <task_id>` command runs the anchors as bounded no-shell
  spawns and records a durable external-evidence bundle; completion is then
  admissible for that task WITHOUT any coder settlement ever existing — the
  in-machine exit for tasks whose deliverable is a commit/push or other
  git-external operation (previously permanently wedged: "Task N has no
  exact-task QA evidence" with `/swarm recover` a no-op).
- `save_plan` now warns when a commit/push-shaped task has an empty scope and
  no external declaration, naming both remedies (declare `external_git` +
  attest, or run it as a thin coder dispatch).
- `/swarm recover` distinguishes "no coder dispatch or settlement evidence was
  found" from a stuck settlement and lists concrete next steps (attest,
  manual close, thin-coder re-plan).
- Fail-closed by construction: undeclared tasks keep the byte-identical
  completion refusal; anchors admit only positively-known read-only git
  subcommands/flags (unknown flags, global options, `--output=`,
  `--show-signature`, `ext::` URLs, `status`/`ls-remote` all refuse); output
  beyond the evidence storage bound refuses instead of truncating; a
  declaration change revokes stale proofs (fresh attest required), while
  terminal evidence is preserved for audit.
- Plan hashes include the new optional fields (legacy plans hash
  byte-identically); `check_gate_status` and the plan/checkpoint markdown
  projections render the declaration.
