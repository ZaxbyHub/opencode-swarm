# Restore PR review and feedback execution end to end

## What changed

- PR-review re-entry admission now performs a read-only authorization check first
  and reserves the one-shot record only after the exact direct Task passes the
  delegation boundary. Plan-backed sessions require an explicit task identity;
  plan-free taskless sessions wait for durable rehydration and remain standalone
  only.
- Auto-resume progress observation now accounts for durable lane and receipt
  transitions, skips scans during wake cooldown, and treats recovery-scan
  failures as uncertainty rather than killing the wake.
- Authorization persistence is capped at the schema bound while retaining all
  live records before consumed replay evidence. Child status and structured
  receipt paths retain exact session, correlation, and parent-chain binding.
- PR-review base and micro children can now settle from their authenticated
  delegation alone. The controller renders batch/lane provenance into each
  child prompt for observability, but the tool resolves the authoritative IDs
  from the child session and rejects invented or missing durable provenance.
- Structured receipts now retain the workflow instance and post-admission
  revision captured by each child dispatch. Later trigger-ledger and validation
  writes no longer invalidate settled base evidence, so all eleven matched
  micro families can run in multiple bounded batches and still reach COMPLETE.
- The PR-review skill now distinguishes controller tools from the child-only
  structured settlement tool, preventing a real Profile A runtime from being
  misclassified as the procedural fallback.

## Why

These changes close the workflow-blocking settlement gap as well as follow-up
review findings around authorization races, taskless re-entry attribution,
wake-brake reliability, bounded persistence, and truthful child-to-parent
workflow status.

## Migration

No storage migration is required. Existing persisted records remain readable.
For safety, a still-live base or micro child launched by an older build without
the immutable workflow binding must be re-dispatched before it can publish a
new structured receipt. A consumed one-shot authorization or PR-feedback
declaration is not reclaimed; issue a fresh declaration or authorization before
retrying a new dispatch.
