---
type: feature
issue: 2501
---

# Spec-Kit v2: multi-feature projection with feature-scoped ids + opt-in tasks.md check-off

## What changed

`/swarm sdd project` now projects **all** detected Spec-Kit features into one effective
`.swarm/spec.md` when several exist — a **behavior change** from v1, which hard-errored and
demanded `--feature`. Selecting one feature (`--feature <id>`, or single-feature
auto-detect) keeps the v1 bare-`FR-###` output byte-for-byte; `--feature all` is an
explicit alias for the new multi-feature default (project command only).

**Feature-scoped ids.** In multi-feature projections requirement ids are
`<featureId>/FR-###` (e.g. `001-login/FR-001`), because Spec-Kit restarts `FR-001` in every
feature — the only form that keeps two features' `FR-001` distinct through drift scoring
and requirement coverage. A flat renumbering was rejected: drift reports would cite ids the
user's source does not contain (traceability disconnect). Plans may cite either the full
namespaced id or the natural bare `FR-###`: drift scoring treats a bare reference as
covering every feature's same-numbered requirement (never a false MAJOR_DRIFT on a
multi-feature project), while namespaced references stay feature-precise. `requirement
coverage` (save-plan), the requirement-coverage tool, and `SpecRequirementSchema` accept
both forms; OpenSpec and native-spec behavior is unchanged.

**Round-trip tasks.md check-off (opt-in, OFF by default).** Enable `speckit_checkoff.enabled`
in the plugin config and, when Swarm completes a plan task, mapped Spec-Kit tasks are
checked off in the source `tasks.md` (`- [ ]` → `- [x]`). Projection captures a check-off
ledger (`.swarm/speckit-checkoff-ledger.json`) mapping each `T###` to its requirement refs —
explicit `FR-###` references on the task line, plus the story-index mapping (`[US n]` maps
to the feature's n-th requirement). The ledger stores only task ids, requirement refs, and
task-line snapshots that already exist in the user's tasks.md (no plan text is persisted).
Safety semantics: byte parity (only the checkbox bytes change, line endings preserved),
concurrent-edit reconcile (a user edit between read and write survives), user-reopen
respect (a hand-reopened task is reported and never re-checked), stale-ledger refusal (a
regenerated/renumbered tasks.md blocks writes until the next `/swarm sdd project`), atomic
writes under a cross-process lock, per-feature result rows, and explicit unmatched
reporting. Native and OpenSpec sources are untouched (no ledger → no-op).

## How to use

```
/swarm sdd project                        # all features (namespaced ids when >1)
/swarm sdd project --feature 001-login    # one feature (v1 bare-id output)
/swarm sdd project --feature all          # explicit multi-feature alias
```

```json
{ "speckit_checkoff": { "enabled": true } }
```

See docs/planning.md (Spec-Kit SDD support) for the full id-identity model and check-off
safety contract.
