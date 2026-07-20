# Delegation gate: `task_id` collision + diagnostics + gated-agent advisory (#1914)

Fixes the delegation gate rejecting valid coder Task dispatches on newer OpenCode runtimes,
the zero-diagnostic `SCOPE_NOT_DECLARED` error that forced the architect into a guess loop
and then a self-coding fallback (bypassing the coder→reviewer→test_engineer QA pipeline),
and a folded-in defect where `agents.designer` (and `docs_design`, `council_*`) config was
silently inert without its enabling flag.

## Changes

- **`resolveDelegatedPlanTaskId` fall-through (HIGH):** When the explicit `task_id`/`taskId`
  arg is non-plan-shaped (e.g. a runtime-injected session id `ses_…`, or any non-`N.M`
  value), the resolver now falls through to `TASK:` line / prompt-text extraction instead
  of fail-closing. Plan-task-shaped values still win over prompt text (PR #961's "explicit
  id takes precedence" intent preserved for that case). The guard is general — not
  `ses_`-prefix-specific — so future runtime session-id shapes don't silently re-break
  dispatches. Background: the `task_id` arg name is generic and overloaded by newer
  OpenCode runtimes (and by the plugin's own `worktree-isolation.ts:836` pre-create step)
  to carry a child session id, not a plan-task id.

- **`prepareCoderScope` cause-specific diagnostics (HIGH):** The single bundled
  `SCOPE_NOT_DECLARED` error (which merged plan-missing / task-id-unresolved / scope-empty
  with zero diagnostics) is split into cause-specific throws. New helper
  `describeCoderScopeFailure(args, planTaskIds)` reports the explicit-field shape, TASK:
  line detection, candidate lists (for ambiguity), and known plan task ids — so the
  architect can self-correct in one turn instead of guessing.

- **Membership gate (HIGH):** `prepareCoderScope` now explicitly rejects plan-task-shaped-
  but-unknown ids (`task_id: "9.9"` for a plan with only `"1.1"`). Closes a latent hole
  where `"9.9" + FILE: src/foo.ts` would produce a valid binding for a non-existent task
  because `createScopeBinding` only validates `isStrictTaskId`, not plan membership.

- **Behavior change — `resolveEvidenceTaskId` (MEDIUM):** Reviewer/test_engineer dispatches
  carrying `task_id: "ses_…"` now text-extract the TASK: id for evidence attribution
  instead of falling through to session state. This is an improvement (correct parallel-
  dispatch attribution, #970 machinery) but is a behavior change.

- **Gated-agent config advisory (MEDIUM):** When `agents.designer` (or `agents.docs_design`,
  or any `agents.council_*`) is configured but the enabling flag (`ui_review.enabled`,
  `design_docs.enabled`, `council.general.enabled`) is OFF, a formation-time advisory now
  fires naming the missing flag. Previously the configured entry was silently inert — the
  user's model/temperature/fallback_models overrides were dropped without warning. Advisory
  is deduped across swarms within a single `createAgents` call. Skipped when the agent is
  also explicitly `disabled: true`.

## Provenance

- Defects 1+2 reported by @DarkJoney in #1896; root-caused from those screenshots + source
  trace on `main@bead6a5`.
- Defect 3 (folded-in gated-agent advisory) from the same #1896 dispatch path; the user
  explicitly asked for the designer at formation and got no warning.
- PR #961 bypass-guard reverted for the non-plan-shaped case only (justified in
  `.zcode/issue-traces/1914/05-fix-plan.md` §Provenance); the corresponding test was
  rewritten to assert the new fall-through behavior.
