# Receipt task-arm outcomes now derive from the durable record (#3560)

## What

Task-kind verification receipts (and the evidence-summary bridge that shares
the new `src/evidence/gate-outcome.ts` derivation) no longer hardcode
`outcome:'pass'` for every gate present in the durable task record. A
durable `gates.council` entry now renders its recorded verdict —
`REJECT`→`block`, `CONCERNS`→`pass` with `code:'CONCERNS'` (the task-level
advisory form), `APPROVE`→`pass`, an unrecognized verdict→`error` — while
presence-only gate kinds keep pass-on-presence, honest because their
producers record only on positive settlement and delete the key on failure.
The empty-gates synthesis no longer fabricates a passed gate: it emits
`not_applicable`, or `pass` with `code:'no_mutation_settlement'` when
durable read-only settlement proof exists. `responsible_actor` comes from
the recorded `agent`, `swarm` only as fallback.

Found by the swarm-pr-review round on PR #3557 (executed probes by the
reviewer and an independent critic: a seeded council REJECT previously
rendered `| council | pass | — | swarm |`).

## Compatibility

`format_version` is unchanged (`1.0.0`): receipts emitted before this fix
remain verify-green (verify checks internal consistency, not external
attestation). Such persisted task receipts carry flattened outcomes —
re-emit `/swarm receipt task <id>` to supersede (content-addressed;
newest-8 retention prunes the old files).
