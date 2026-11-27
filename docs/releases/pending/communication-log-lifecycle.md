# `fix(swarm)`: the communication debug log trims itself — closed incidents are pruned programmatically, unclear ones need an audited AI decision

## Summary

- The consumer-anchored policy (the project AGENTS.md "Swarm-Communication-Debug" section and the log's own header) says resolved incident entries are REMOVED — the fix, validation, and production proof live in the upstream PR and its release fragments. Until now that policy was executed by hand or by the consumer's watchdog agent re-structuring the file: closed entries lingered for days, manually removed entries came back after restructures, and every cleanup was a manual chore fighting the very mechanism that was supposed to keep the log lean.
- The policy is now programmatic, with exactly the split it needs:
  - **Auto-prune** (no AI decision): a `## Vorfall` incident whose `Status:` line says GESCHLOSSEN/closed AND whose closure is DURABLY provable — every task id named on its `Task-ID:` line has workflow evidence at terminal `complete` — is removed by the session-close maintenance pass (the same listed trigger that already sweeps background delegations). The durable evidence, not the prose, decides.
  - **AI-release** (the new `prune_communication_log` tool, architect-only, audited): everything else — a closed entry whose task is not provably complete (or that names no task), or an entry without a Status line — is never auto-removed. The tool's no-argument mode reports the AI-release worklist (with per-entry reasons); with `entry_headline` + `reason` it removes exactly one entry and audits the decision to the core events log.
  - **Never touched**: open incidents (the log's live worklist), the header, the format section, and the open-points section.
- Every removal — automatic or AI-released — appends a `communication_log_pruned` core event (headline, task ids, cause, and for AI releases the reason and actor session), so the trimming itself is auditable. The pass is fail-open, bounded (1 MB read cap), idempotent, and guarded by an mtime memo (bounded, evicted per the session-state invariant) so the session-close cadence does not re-parse unchanged files.

## User-facing changes

- A swarm that runs for days no longer accumulates resolved incidents in `.swarm/swarm_communication_debug.md`: provably-closed entries disappear on their own within one session-close maintenance tick, and the architect can list and release the unclear remainder with one audited tool call instead of hand-editing the log.
- Open incidents and the structural sections are guaranteed untouched — the automatic pass cannot remove an entry whose closure it cannot prove from durable evidence.

## Migration notes

None. The log format is unchanged (the parser reads the existing conventions: `## Vorfall` sections, `Task-ID:` and `Status:` lines); projects without the log are a no-op. New tool: `prune_communication_log` (architect agent; worklist report without arguments, audited removal with `entry_headline` + `reason`).

## Discovery context

Found in the consumer-project loop (2026-11-26/27): the 2.16 and 2.17 incident entries were removed by hand per policy, re-added by the consumer watchdog's log restructures, removed again — and the 2.17 closure entry lingered until the next manual pass. The user's direction: what the log policy says must be wired programmatically — prune automatically whatever is provable, gate only the unclear remainder behind an AI decision. Pinned by `tests/unit/maintenance/communication-log.test.ts` (16 tests: parser classification, the durable-closure auto-prune with structure preservation + audit, the not-durably-complete/no-task-id/no-status AI worklist, open-entry refusal, ambiguity and not-found handling, mtime memo, write-failure fail-open, and the tool's worklist/reason/session gates) and the blind-spot registry entry in `tests/helpers/swarm-write-cache-scan.ts` (the seam-indirected log write is not an evidence artifact).
