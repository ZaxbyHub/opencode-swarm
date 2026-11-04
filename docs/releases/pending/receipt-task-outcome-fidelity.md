# Receipt task-arm outcomes now derive from the durable record (#3560)

## What

Task-kind verification receipts (and the evidence-summary bridge that shares
the `src/evidence/gate-outcome.ts` derivation) no longer hardcode
`outcome:'pass'` for every gate present in the durable task record. A
durable `gates.council` entry now renders its recorded verdict —
`REJECT`→`block`, `CONCERNS`→`pass` with `code:'CONCERNS'` (the task-level
advisory form), `APPROVE`→`pass` with `code:'APPROVE'`, and a present
verdict that is not a recognized string — including a non-string value —
→`error`, so a malformed or future-vocabulary verdict can never attest a
pass. Presence-only gate kinds keep pass-on-presence, honest because their
producers record only on positive settlement and delete the key on failure.
The empty-gates synthesis no longer fabricates a passed gate: it emits
`not_applicable`, or `pass` with `code:'no_mutation_settlement'` only when
the platform's canonical `isDurableNoMutationSettlement` predicate holds
(authoritative generation-0 idle/complete workflow with a bound proof) — a
marker merely retained through a blocked transition does not qualify.
`responsible_actor` comes from the recorded `agent`, `swarm` only as
fallback. The bridge reports the RECORDED verdict (`rejected`/`approved`/
`warn`/`fail`/`pass` with the token in the summary and `durable_verdict`
metadata), and every dynamic cell of the rendered receipt Markdown is
escaped so durable bytes cannot forge a table row absent from the
hash-bound receipt.json.

Receipt rows attest the RECORDED verdict only: council quorum adequacy,
identity-digest validity, and workflow freshness remain the domain of the
task-completion gate and the state-rehydration path — a record the platform
would refuse still renders as its recorded verdict (disclosed; tracked for
the first authenticity-gating consumer).

Found by the swarm-pr-review round on PR #3557 (executed probes by the
reviewer and an independent critic: a seeded council REJECT previously
rendered `| council | pass | — | swarm |`), refined by the review round on
PR #3561 itself (non-string verdict fail-open, stale settlement synthesis,
Markdown row-injection, bridge verdict collapse).

## Compatibility

`format_version` is unchanged (`1.0.0`): receipts emitted before this fix
remain verify-green (verify checks internal consistency, not external
attestation). Such persisted task receipts carry flattened outcomes —
re-emit `/swarm receipt task <id>` to supersede (content-addressed;
newest-8 retention prunes the old files).
