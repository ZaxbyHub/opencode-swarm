# session.idle no longer revokes delegated coder scopes; superseded ingestion rounds consume as stale

## What changed

Background coder rounds no longer lose their write authorization mid-task when they go idle:

- **Idle is not terminal for scope ownership.** Previously, a `session.idle` lifecycle event ran the same session teardown as `session.deleted`: every scope binding the session owned was cleared (in-memory and durable) and the session's `currentTaskId` was nulled. A coder child that ends its turn while a background shell (or any deferred work) is still in flight goes idle mid-task and wakes on the completion notification — its next write was then refused with `SCOPE_NOT_DECLARED` ("task unknown"), and the round could never re-authorize. Only true removal events (`session.deleted` / `session.removed`) revoke scope ownership now. Abandoned bindings stay bounded by the existing 60-minute scope-binding TTL, the dispatch lifecycle, and `endAgentSession` (close / lean runner). The v2 host adapter already refused to map live `busy`/`retry` statuses to `session.idle` for the same defect class (#3022); this closes the genuine-idle gap on the consumer side.
- **A re-dispatch no longer burns its predecessor's ingestion budget.** Starting a reviewer scope generation for a new coder call of the same task supersedes (deletes) the older unclaimed generation. A completion whose generation was superseded this way can never reconstruct its scope handoff, so every ingestion retry failed identically until the redrive budget was exhausted — and the exhaustion advisory's "re-dispatch" advice armed the same fate for the successor round, producing a re-dispatch cascade. Such completions are now consumed as a terminal-negative `stale` outcome on the first failed apply instead of retrying.
- **Retryable ingestion commits persist their failure reason.** The durable record previously carried only the attempt counter, so a deterministic ingestion failure was undiagnosable from the store (the reason existed solely in process-local return values). The bounded reason now rides the same atomic write as the retryable flip, is preserved across later claims, and is dropped on the consumed flip.

## Why

Field diagnosis of a stuck background coder task (2026-11-28): five dispatch rounds, two consumed cleanly, two exhausted their ingestion budget against deterministic failures, one stranded; the coder-side write refusals and the ingestion cascade traced back to the idle teardown and the generation supersession described above.
