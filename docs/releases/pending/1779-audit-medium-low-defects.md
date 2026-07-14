## Audit 2026-07-09 MEDIUM-HIGH / MEDIUM / LOW defect sweep (#1779)

Resolves the reviewer-validated MEDIUM-HIGH, MEDIUM, and LOW/test-debt defects from the 2026-07-09 full-repo audit. Every item was re-verified live at HEAD before fixing; items already remediated since the audit base were skipped.

### What changed
- **MH1 — `pkg_audit` auto mode false-clean:** `auto` aggregation now carries an explicit per-ecosystem `incomplete` flag (set only on genuine non-completion: tool-missing/timeout/parse-error/unexpected-exit) plus `notes`/`ecosystemsIncomplete`, and reports `clean` only when `findings===0 && !anyIncomplete`. Benign notes (e.g. dart "outdated packages") no longer flip `clean`.
- **M1 — plan-ledger silent rollback:** on a mid-ledger corruption the replay now threads a `truncated` flag out and refuses to overwrite `plan.json` with prefix-only state (preserving durable post-poison `task_status_changed` events); the canonical ledger is never destructively rewritten; quarantine writes a unique non-overwriting side file and salvages parseable events; `append`/`init`/`rebuild` fsync before rename. The orphan `replayWithIntegrity` engine was folded into `replayFromLedger` and removed.
- **M2 — SQLite `withTransaction` atomicity:** rewritten to use manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` and correctly await the (async) callback, so read-compute-write is genuinely atomic and rolls back on throw.
- **M14 — SQLite init handle leak:** `doInitialize` now closes and nulls the handle (and resets `initialized`) on any post-open failure so a retry re-opens cleanly instead of leaking or wedging the provider.
- **M4 — `gitingest` full-auto gating:** reclassified from READ_ONLY to a NETWORK tool so full-auto escalates it to critic review instead of auto-approving.
- **M5/M6 — CLI destructive-delete safety:** `uninstall --clean` deletes are now guarded (`isSafePromptsDir`, `isSafePluginConfigPath`) and every guarded delete canonicalizes via `realpath` before validating and deleting the same path.
- **M9 — unbounded session maps:** `_heartbeatTimers` and `recentToolCallsBySession` are now FIFO-capped at `MAX_TRACKED_SESSIONS`.
- **M10 — learned-content sanitization:** all learned-content injected into the system message is sanitized at injection time; directive-action fields and the dark-matter (co-change) writer now run content-safety validation.
- **M11 — decision-drift false positives:** contradiction detection is now negation-aware (single polarity per decision), so two agreeing "do not use X" decisions are no longer flagged.
- **M12 — prompt placeholder leak guard:** each agent's final prompt is validated free of unresolved `{{KEY}}` placeholders (a hard check for built-in prompts; warn-only and fail-open for user-authored custom prompts so a literal `{{KEY}}` in prose can never abort plugin init); the dead `renderPrompt` helper was removed.
- **M13 — skill-mirror safety drift:** the `engineering-conventions` divergent pair now carries the same safety sections in both trees, and `drift:check` enforces safety-heading parity for divergent pairs.
- **M15 — delegation acceptance criteria:** an optional structured `specCriteria` (FR/SC/acceptance) field flows from the architect coder-delegation template to the coder INPUT FORMAT, and the previously-dead `validateDelegationEnvelope` is wired advisory-only (never blocking).
- **Docs (M7/M8/L5):** corrected the `skillPropagation` config key + fields, the Context Budget Guard behavior, the lockfile retry policy, and the language-profile count (12 → 13, JavaScript is a full profile).
- **Test-debt (L1–L4):** un-skipped stale-comment full-auto-permission tests, fixed a temp-dir leak, deleted dead `src/graph/*` and a dead sandbox re-export shim, and single-sourced `redactShellCommand` to the home-path-redacting copy.

### Migration
No migration required. One behavior change: under full-auto, `gitingest` now escalates to critic review instead of auto-approving (M4).

### Caveats
- M6's realpath canonicalization closes the final-component symlink swap but not an intermediate-directory swap (a residual, string-API-bound TOCTOU).
