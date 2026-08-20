---
type: fix
---

# Reviewer-scope evidence v2: root-correct, size-safe, retryable (issue #2100)

Issue: #2100

## What

- Replaces the v1 reviewer-scope fingerprint contract (bare `null` failures, 1 MiB/file and 4 MiB aggregate identity caps, whole-buffer reads, ambient-root capture) with a typed streaming capture: every regular file is hashed over its COMPLETE bytes in fixed 256 KiB chunks with `fstat` identity checks before/after and a descriptor-first no-follow open (POSIX). Byte caps no longer deny file identity; resource pressure surfaces as the typed retryable `capture_deadline` instead.
- Introduces the versioned `reviewer-task-files-v2` manifest: per-path state, byte count, SHA-256, HEAD, canonical workspace identity, and generation provenance. `auto_review.max_diff_kb` becomes a delivery budget only (inline vs manual per-file modes in the reviewer prompt) and can no longer change which files enter the manifest or the manifest digest. Reviewer Task prompts now carry a bounded `<reviewer_scope_manifest>` block with the exact manifest hash; manual-delivery files must be inspected via read-only tools.
- Binds every capture/equality site to the coder generation's persisted workspace identity (the lane root for worktree-isolated coders), derived from the activated scope binding — never the ambient plugin root. Post-write capture reads from the child session's lane root; background Stage-B ingestion captures from the generation's root and writes verified fingerprints back.
- Adds merge-back verification: a lane generation is only reviewable from the primary checkout after every manifest file (including deletions) matches the lane manifest. Clean merges emit `REVIEWER_SCOPE_MERGEBACK_VERIFIED`; conflicts/deferred merges retain the generation as `mergeback_pending`/`mergeback_mismatch` with typed actionable advisories — never a generic reviewer-stale relabel.
- Makes ready-publication transactional (a generation only becomes `ready` when every observed file has exactly one exact fingerprint) and adds bounded inline retry (3 attempts / 10 s) for typed transient classes (HEAD timeout/race, mutation during streaming, capture deadline). Exhausted retries and permanent capture failures retain the generation and route to typed recovery (`REVIEWER_CAPTURE_RETRY_EXHAUSTED`, `REVIEWER_CAPTURE_FAILED:<code>`, `REVIEWER_CAPTURE_INCOMPLETE`); only a genuine byte change remains `REVIEWER_SCOPE_STALE` and discards.
- Represents truthful no-change: a successful coder with zero guardrail-observed writes and a verified clean `git status` completes as `no_change` (`coder_no_change` transition) — retryable by the architect, creates no review debt, and does not advance reviewer/test/task gates by itself. Zero observed writes over a dirty tree stays `collecting` with a `REVIEWER_SCOPE_UNATTRIBUTED_CHANGE` advisory.
- A binding/task mismatch at coder start now fails closed with typed `REVIEWER_SCOPE_BINDING_MISMATCH` instead of a silent skip.

## Why

With `auto_review` enabled, one ordinary file over 1 MiB (or a set over 4 MiB) permanently wedged reviewer dispatch: the over-cap capture returned `null`, the whole fingerprint batch was silently abandoned, and the generation was destroyed as "stale" — re-running the coder reproduced the identical failure. Worktree-isolated coders were fingerprinted against the primary checkout instead of their lane (correct lane writes recorded as deleted or stale), and transient git HEAD timeouts/races were indistinguishable from genuine evidence invalidity. Four deterministic defect classes made tasks impossible to review.

## Migration

- `auto_review` remains opt-in; no configuration changes are required.
- Reviewer-scope generations are in-memory only; after a plugin update the first reviewer dispatch per task captures a fresh v2 manifest.
- Durable receipts recorded under the v1 description (`reviewer-task-files-v1`) fail closed with a one-time `REVIEW_SCOPE_LEGACY_V1` re-review signal; they are never reinterpreted as v2 passes and no proof is backfilled.
