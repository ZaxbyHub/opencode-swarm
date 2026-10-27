---
issue: 3275
issue: 3357
issue: 3397
issue: 3382
---

# PR-review verdict-row pipeline integrity

## What changed

- **Quarantine escape closed (#3357, completing #3275 RC2):** a verdict row that ARRIVED over its marker's legal arity was tail-merged down to exactly the legal count, so the #3310 arity-keyed quarantine never saw it — the Stage-B/echoed-format row entered the exact-set count with an unassigned id and voided every valid sibling row. Rows are now quarantined on their RAW arrival arity when they required tail-merge AND name an unassigned id (`rawFieldCount` is surfaced by the parser; `indexVerdictRows` takes the assigned-id set). The spoofing floor is unchanged and exact: a row that arrived at EXACTLY the legal arity naming an unassigned id still voids the lane — that is the forged-row class; over-arrival is by construction non-format-conformant and cannot authenticate.
- **Quarantine is now visible on the durable receipt (#3357 AC2):** a verdict lane whose artifact contained quarantined strays settles with a `legacy-verdict-row-quarantine` recovery entry (bounded id + raw arity in the reason) on the same durable surface as `legacy-verdict-row-recovery`, in BOTH the TypeScript union and the persisted `WorkflowLaneRecoverySchema`. Previously a quarantine-influenced settle produced a receipt byte-identical to a clean settle.
- **Host-aborted lanes are never typed (#3397 RC-03):** a verdict lane the host aborted after producing partial text previously flowed to validation failure and was stamped `workflowLaneFailureClass: 'verdict_contract'`, making a host cancellation admissible typed-dead evidence once the retry budget expired — contradicting the shipped "aborted terminals never typed" contract. Both stamp sites (the ordinary `!ok` leg and the transport-validation throw catch) now skip the stamp when `terminalError.kind === 'aborted'`. Such lanes settle as classless `error` terminals and BLOCK typed-dead admission by design (classless owners are rejected before the budget arm in `verdict-settlement.ts`) — the operator remedy is re-dispatch, and the disclosed-INCOMPLETE path names the blocked item.
- **Embedded credentials are redacted (#3382):** the collision-safe credential patterns match embedded substrings — the fixed-length families (bare AWS access key id, Google API key, the labeled AWS-secret value arm, the context arm's AKIA anchor) and the separator-prefixed token families whose prefixes cannot collide with ordinary text (GitHub PAT `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, GitLab `glpat-`/`glptt-`, Slack `xox[abprs]-`). Anchors are deliberately KEPT where the short alnum-only prefix collides with benign text (OpenAI `sk-` matches inside "task-"/"disk-", Stripe `sk_`/`rk_` inside "risk_live_…", JWT `eyJ` inside base64 blobs), and the context arm's 40-char secret value keeps its word boundaries (a bare 40-char window inside a longer filler run is indistinguishable from noise). Detected embedded shapes are redacted instead of passing byte-identical through `redactSecrets`/`containsSecret` into verdict-row diagnostics, telemetry, receipts, and analysis output (the verdict-row id sentinel path yields `(redacted)`).
- **Sequential-replacement masking fixed (pre-existing, found by this work):** `redactSecrets` applies patterns sequentially, and the bare AWS access-key arm ran BEFORE the AWS-secret context arm, replacing the `AKIA…` anchor and leaving the 40-char context secret un-redacted even in the exact-40 shape (the existing test asserted detection only, not redaction). The AWS-secret arms now run first; the count and all other families are unchanged.

## Why

A single Stage-B grammar row with pipes in its summary could void an entire reviewer lane (the #3275 deadlock shape), a host abort could launder into typed-dead settlement evidence, and an embedded credential could ride a verdict-row id past redaction into operator-visible surfaces. All four are the same defect class: a decision keyed on a weaker discriminator than the grammar requires.

## Migration / operator actions

- `REDACTION_POLICY_SALT` 2→3 and `FINGERPRINT_ALGORITHM_VERSION` 2→3: detection semantics changed for unchanged config, so memory cohort members must re-run `/swarm memory link` after upgrading (legacy cohort files surface as a re-link instruction, not a config-mismatch error).
- Memory durable-secret rejection is strictly tighter: content embedding fixed-length credential shapes is now rejected/redacted where it previously passed.

## Residual disclosures (#3397 item 2 — the fragment that previously overstated)

The typed-terminal vocabulary shipped by #3388 carries these accuracy residuals, disclosed here per the issue's fix-or-disclose rule (one was fixed in code, see the PR body ledger): ghost-owner BLOCKED wording can overstate owner intent for never-launched lanes (RC-01); `output_length`/`transcript_incomplete` provider terminals are typed `resource` as an evidence grade, not an exact cause (RC-04/14/40); an internal fault inside validation is typed `verdict_contract` because the lane's contract check did fail — with this change an ABORTED lane is never typed, which is the authenticity boundary (RC-41); pre-widening records parse as classless by intentional legacy tolerance (RC-19/36); coherence entries can outlive an interrupted settlement pass, cosmetic only (RC-09); the BLOCKED attempts sentence and the verdictAttempts projection render uncapped per-item lists (RC-11/12/22); the council-dispatch behavior change from #3388 is hereby disclosed (RC-13); stale retry-advice wording was removed by #3388 and any reappearance is a new defect (RC-16); latent schema-versioning gaps remain a tracked design debt for future persisted kinds (RC-15/17); test-quality gaps around exhaustion boundaries and projection pins remain (RC-25/26/28), and the five dispatch-lanes suites' temp-cleanup debt is untouched (RC-38). RC-20 (verdictAttempts missing from `docs/architecture.md`) is fixed in this PR. `operator_cancelled` exclusion remains a recorded product decision awaiting maintainer confirmation.

## Known limitation

Quarantine evidence in `analysis.actual` still renders arities only (`quarantinedArities`) on the FAILURE path; the success path now carries the full bounded entries on the receipt surface.
