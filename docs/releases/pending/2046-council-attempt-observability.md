---
issue: 2046
title: Council attempts and accepted transitions now emit observability events
---

# Council attempts and accepted transitions now emit observability events

Every task, phase, and final council submission attempt — including blocked,
stale, duplicate, quorum-failed, and policy-rejected outcomes — now emits a
canonical `council_attempt` observability event, and every accepted-projection
move (`advance`/`close`) additionally emits `council_round_transition`
(issue #2046 item 9, the last open gap of the council-observability contract).
Pre-validation failures (invalid arguments, wrong working directory, round-state
uncertainty) emit `council_attempt_unscoped`, mirroring the durable
`unscoped.jsonl` audit stream.

Events join the lifecycle correlation system through the shared envelope fields
(`hostSessionId`, `taskId`, `phaseId`) plus the previously-unused
`councilRoundId` axis, now populated with the server-derived council scope
token — the same identity that keys `.swarm/council/attempts/{token}.jsonl`.
Plan or policy drift therefore opens a new round identity instead of relabeling
old evidence, and a blocked or stale attempt can still never advance a gate.

A review follow-up additionally forbids the `councilRoundId`
correlation axis on `council_attempt_unscoped` in the event catalog:
these submissions genuinely have no round identity, so a forged one is
flagged by relationship validation instead of silently joined, while
the scoped kinds require it — round-identity provenance is
machine-enforced in both directions.

Observability remains strictly non-authoritative: emissions are best-effort,
never throw, fire only after the durable audit append succeeds, and carry only
identifiers, enums, counts, and hashes (privacy class `pseudonymous` — no
member names, no evidence paths, no raw request content). The durable council
round-state store under `.swarm/council/` stays the gate authority. Events ride
the existing bounded `.swarm/telemetry.jsonl` sink (10 MiB rotation) — no new
durable stream, no retention-registry change.

The event catalog grows from 56 to 59 kinds; the new kinds' intended consumer
is the rebuildable index / `/swarm report` work (issue #2048).
