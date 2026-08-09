# Background completion-observer reviewer receipt fixes

## What changed

- **Scope lifecycle**: The background coder's reviewer scope generation is now
  marked `ready` inside the ingestion success path rather than before evidence
  recording, preventing a premature ready state when evidence ingestion fails
  and allowing correct retries.
- **Receipt persistence**: `collectReviewerReceiptFromTranscript` now receives
  the caller's `reviewerReceiptOptions` validation config and uses the parent
  session ID instead of the subagent session ID, fixing reviewer receipt
  collection for background subagent completions.
- **Scope claim cleanup**: After successful reviewer terminal ingestion, the
  claimed scope generation is now discarded so `getReviewerScopeGenerationForCoderCall`
  returns `null` for a fully consumed lifecycle, matching the expected contract.
- **Test coverage**: The three regression tests in
  `completion-observer-reviewer-receipt.test.ts` now pass, covering the
  duplicate-event ingestion path, the coder→reviewer scope lifecycle, and
  error/stale cleanup.

## Why

The background subagent delegation graduation (issue #1676) rewrote
`completion-observer.ts` and `stage-b-gates.ts` but the reviewer receipt
collection path had several gaps: receipts were never written because
validation options weren't propagated, the scope was marked ready before
evidence could fail, and claimed reviewer scope generations were never
cleaned up after successful terminal processing.

## Migration

No migration is required.
