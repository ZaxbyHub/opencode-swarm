# Memory Phase 6: privacy hardening + observability (issue #1466)

Closes #1466.

## Privacy

- **Expanded secret redaction (DD-05):** GitLab (`glpat-`/`glptt-`), Slack
  (`xox[abprs]-`), JWT, Stripe (`sk_live_`/`rk_live_`), Google (`AIza...`),
  OpenSSH private key blocks, and AWS secret access keys were already
  covered by prior FR-08 work; this release adds the AKIA-context heuristic
  (a 40-char base64 secret on the same line as, within 200 chars after, an
  AWS access key id) and JSON-style `SecretAccessKey` labels.
- **`env_secret` URL fix (DD-06, previously landed):** bare `?key=...` URL
  parameters are not redacted; at least one uppercase `PREFIX_` segment is
  required.
- **PII detection (NEW, opt-in):** `memory.redaction.detectPii`,
  `memory.redaction.piiDetector` (`regex` default | `ner` via the optional
  `@xenova/transformers` peer dependency), `memory.redaction.rejectDurablePii`,
  and `memory.redaction.piiThreshold` (default 0.7). Rejections are logged
  to the audit log as `pii_rejected` with types/score only — never matched
  text. All defaults preserve pre-#1466 behavior (no detection).

## Observability

- **Provenance columns (migration v12):** `memory_items` gains
  `source_task_id`, `agent_role`, `embedding_model_version`, `valid_from`,
  and `supersedes_reason`, populated on new writes and backfilled with safe
  defaults.
- **Audit-log hash chain (migration v13):** `memory_events` rows chain via
  `prev_hash` (SHA-256 of the full previous row) with the head mirrored in
  `_meta`. New command `/swarm memory audit-verify [--json]` detects
  tampered rows, deletions, rogue inserts, and last-row edits.
- **Sentinel hardening (DD-14):** recall-injection detection is anchored on
  the unforgeable `bundle_` marker (write-banned in memory text) instead of
  a forgeable substring, closing the stored-memory recall-suppression forge.
- **`--fixtures` traversal defense (DD-24):** `/swarm memory evaluate
  --fixtures` now enforces realpath containment (symlinks cannot escape the
  project/bundled roots; case-insensitive on Windows).

## CI

- New `memory-recall-regression` job and `bun run check:memory-recall`:
  runs the golden recall evaluation twice (determinism gate) and fails when
  `precision@k` drops more than 0.05 below the pinned baseline
  (`tests/fixtures/memory-recall-baseline.json`). Making it a REQUIRED
  check is a maintainer branch-protection action.

## Upgrade notes

- Cohort fingerprint algorithm version bumped 1→2 (the redaction policy
  version changed for unchanged config). Existing linked cohorts open with
  a warning advising `/swarm memory link` to refresh the fingerprint —
  memory is never stranded.
- Optional NER: install `@xenova/transformers` yourself to use
  `memory.redaction.piiDetector: "ner"`. It is declared as an optional peer
  dependency and never installed by default; opting in without installing
  fails closed with a typed, actionable error.
