# Redaction-coverage cluster: persisted boundaries, scanner parity, and contention classification (#3893, #3915)

Collated fix for #3915 (follow-up from PR #3905) and #3893 (follow-up from PR #3882) — the redaction-coverage defect class. Trace: `.agents/issue-traces/3893-3915-redaction-coverage/` (issue-tracer, 14 frozen acceptance checks).

## Council evidence writers redact model free text (#3915 AC1–AC3)

The final-council evidence writer, the phase-council verdict writer, and the task-level council evidence writer serialized model-authored free text into `.swarm/evidence/**` verbatim (zero redaction references in their write paths — they predated the #3844 persisted-boundary census). They now compose `redactEvidenceText`/the deep variant at the write boundary (the `write-hallucination-evidence` pattern): persisted artifacts are redacted; tool responses keep raw prose for the calling agent.

## Training capture composes the `redactSecrets` floor (#3915 AC4, AC9)

`redactTrainingContent` ran its URL/KV/quoted-JSON/scheme/bare arms only, so PEM private-key blocks, Stripe live keys, GitLab tokens (the persisted-store floor families) and fill-split family credentials (`gh\u200Bp_…`, `sk-a\u200Bnt-…`, `AK\u200CIA…`) passed through UNREDACTED into the training vault. The floor is now composed after the bare pass, and the extended condensed-fill view re-links split tokens (matching-only; output bytes for benign text unchanged). `TRAINING_REDACTION_VERSION` 2→3. Downgrade effect (see `docs/training-vault-remediation.md`): a v3 consent file reads as absent under the previous v2 reader — capture stops until consent is re-granted — and v3 records are kept on disk but version-quarantined by the older reader (deletion remains only the documented downgrade hazard).

## Plan-commit contention reports the retryable class on all three paths (#3915 AC5)

A losing `phase_complete` caller under real contention was refused by the critical-directive gate's fail-closed path (`blocked`/`DIRECTIVE_GATE_FAILED_CLOSED`) because the gate's 500 ms knowledge-receipt-ledger lock read collides with the concurrent winner's commit-phase writes — ~40 lines before the plan-lock branch that owns the correct classification. All three response paths (initial preflight, locked-region preflight, commit re-run) now classify receipt-lock timeouts as `incomplete`/`PHASE_COMMIT_LOCKED` with a top-level retry recovery; genuine gate failures (corrupt/missing) keep the fail-closed class.

## Evidence KV bounds and composite JWT tails (#3915 AC6–AC8)

The shared JWS scanner's interior-`=` branch included the query separator in its span, so a composite `?token=<JWT>.<short-lowercase-tail>` lost its `=` and stranded the tail on the evidence path; the span now starts at the base64 run. A ≥65-char placeholder label ended the KV value at its bracket, leaving a following credential tail; stepped value consumption now takes the tail. ~300k-character values silently declined the regex match and persisted whole; a bounded pre-scan now redacts oversized values directly.

## Memory scanner reaches JWS parity; fill classes extended (#3893 AC1–AC2)

The memory secret scanner never ran the JWS scanner, so dir-JWEs, unsigned JWTs, and `e30`-payload tokens leaked from durable memory while the shell path redacted them; `findRedactableTokenSpans` is now unioned into `findSecrets` (raw + condensed views). The fill class set (previously `Cf|Default_Ignorable` at both the memory and shell sites — two literals in memory, now one shared source) is extended with combining marks (`Mn`) and the Braille blank (U+2800), so credentials split by U+0301 or U+2800 re-link at both sites. `REDACTION_POLICY_SALT` 4→5 and `FINGERPRINT_ALGORITHM_VERSION` 4→5 (precedent ebc6a0168): cohort fingerprints and policy versions deliberately shift across this change — members on opposite sides fail closed at link time by design (#1850) and re-link on fresh fingerprints.

## Sandbox capability probe: spawn errors are transient (#3893 AC3)

A win32 `cmd.exe` spawn error returned a `disabled` result memoized for the process lifetime (no TTL — the degraded-fallback TTL only covers ENABLED results, and the transient-slot marker did not match spawn errors). Spawn-error results now carry the `probe spawn failed:` marker and route to the transient slot: `detect()` re-probes on later calls while the visible capability stays fail-closed `disabled`.

## Shell arm coverage and quote-aware dash values (#3893 AC4–AC5)

The shell/display bare-token sweep gains the stripe (`sk_live_`/`rk_live_`), GitLab (`glpat-`), npm (`npm_`), Hugging Face (`hf_`), and xAI (`xai-`) families (both sites in lockstep, parity corpus extended). `redactDashFlags`'s raw-text keyword pre-check no longer loses fill-split flag names, and space-form quoted values (`--password "first second"`) redact whole instead of leaving `second"` behind — the display mirror gains the same treatment. The PEM arms are replaced with bounded-work, whole-secret scans (an END-delimited arm with a bounded gap plus a maximal key-material-run fallback for BEGIN-without-END), removing the unbounded lazy scan and the never-redacted BEGIN-only case.

## Known bounds

- The letter-glued `BearereyJ…` composition is a disclosed SHARED residual (the shell scanner misses it at both sites; memory parity is preserved, not widened, by this change).
- Braille fill tolerance covers U+2800 only (the invisible blank); other Braille patterns are visible glyphs.
- The display site's documented visible-separator residual (`sanitizeFailureEvidenceDisplay`) is unchanged.

## Verification

14 frozen acceptance checks (C1–C14) red-at-base → green-at-head; published-argv suites extended; the fixed-point, adversarial, and parity corpora re-run. Trace artifacts and per-check transcripts live in the issue-tracer trace directory.
