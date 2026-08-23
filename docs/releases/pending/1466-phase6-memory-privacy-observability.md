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
  and `memory.redaction.piiThreshold` (default 0.7, exclusive, must be < 1).
  Rejections are logged to the audit log (SQLite provider) as `pii_rejected`
  with types/score only — never matched text — under a non-content-derived
  target id. The same checks cover outcome `correction` free text. Regex
  detection normalizes text (NFKC + invisible-character stripping) before
  matching, closing fullwidth-digit and zero-width-character evasion. NER
  parsing matches the real `@xenova/transformers` 2.17.x token-classification
  output (flat BIO-tagged tokens, grouped consumer-side), and concurrent
  first calls share one model load. All defaults preserve pre-#1466 behavior
  (no detection).

## Observability

- **Provenance columns (migration v12):** `memory_items` gains
  `source_task_id`, `agent_role`, `embedding_model_version`, `valid_from`,
  and `supersedes_reason`, populated on new writes and backfilled with safe
  defaults. The sqlite `record_json` payload deliberately omits the new
  fields (they live in the columns), so records written by this version
  remain loadable by the previous version.
- **Audit-log hash chain (migration v13):** `memory_events` rows chain via
  `prev_hash` (SHA-256 of the full previous row) with the head mirrored in
  `_meta`; the tail is read inside the insert transaction, so concurrent
  providers on one database cannot fork the chain. New command
  `/swarm memory audit-verify [--json]` detects tampered rows, deletions,
  rogue inserts, and last-row edits. Scope: the chain detects tampering by
  anything WITHOUT database write access (an attacker who can write the DB
  file can recompute it — PKI signing is out of scope for v1 per #1466);
  rows written by an older binary after this migration report as a
  persistent divergence until the database runs the new version only.
  `memory_events` rows (including `pii_rejected` metadata, which never
  contains matched text) are retained indefinitely for now; bounded
  retention is owned by issue #2036.
- **Sentinel hardening (DD-14):** recall-injection detection is anchored on
  the unforgeable `bundle_` marker (write-banned in memory text AND outcome
  correction text) instead of a forgeable substring, closing the
  stored-memory recall-suppression forge.
- **`--fixtures` traversal defense (DD-24):** `/swarm memory evaluate
  `--fixtures` now enforces realpath containment (symlinks/junctions cannot
  escape the project/bundled roots; case-insensitive on Windows) and runs
  the evaluation against the verified canonical path.

## Fixes en route (PR feedback)

- Scratch-memory proposals no longer spuriously reject when two clock reads
  straddle a millisecond (`expiresAt - createdAt` could land 1 ms over the
  7-day limit); both timestamps derive from a single clock snapshot.
- A failed `pii_rejected` audit write no longer masks the typed
  privacy-rejection error; `MemoryPiiDetectorError` is now part of the
  `MemoryValidationError` family so tool-layer callers see one contract.
- The sqlite provider sets `busy_timeout` as the FIRST statement after
  open, closing an unguarded SQLITE_BUSY window for concurrent connections
  (e.g. `/swarm memory audit-verify` alongside a live provider).

## CI

- New `memory-recall-regression` job and `bun run check:memory-recall`:
  runs the golden recall evaluation twice (determinism gate) and fails when
  `precision@k` drops more than 0.05 below the pinned baseline
  (`tests/fixtures/memory-recall-baseline.json`), when the pipeline
  identity (`embedding_model_version`) no longer matches the pinned
  baseline, or when the fixture set shrinks below the pinned count. Making
  it a REQUIRED check is a maintainer branch-protection action.
- `src/memory/` joins the platform-sensitive path list, so memory-only PRs
  run the 3-OS unit matrix on pull requests (not only in the merge queue).

## Upgrade notes

- Cohort fingerprint algorithm version bumped 1→2 (the redaction policy
  version changed for unchanged config). Existing linked cohorts open with
  a warning advising `/swarm memory link` to refresh the fingerprint —
  memory is never stranded.
- Optional NER: install `@xenova/transformers` yourself to use
  `memory.redaction.piiDetector: "ner"`. It is declared as an optional peer
  dependency and never installed by default; opting in without installing
  fails closed with a typed, actionable error.
