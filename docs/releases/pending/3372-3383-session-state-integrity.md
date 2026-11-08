# Session-State Integrity: Pairing Identity Ownership + Phase-Monitor Sessionless Guard

## What changed

- **Instruction-pairing no longer re-stamps session identity** (`src/memory/instruction-pairing.ts`,
  #3372): the measurement composer `makeMessages` performed an unconditional
  `swarmState.activeAgent.set(sessionId, 'architect')` on every invocation, and both cleanup paths
  (`runTaskPairing`, `verifyCacheInvalidation`) unconditionally DELETED the entry — a session whose
  recorded primary owner (#3320) was `build`/`plan` presented as `architect` in the LIVE shared
  identity map for the whole measurement window, and any pre-existing identity for those synthetic
  ids was destroyed (the ids on this path are the harness's own synthetic pairing sessions). The
  composer now never writes an entry that already exists (the literal #3372 contract: existing
  identity stays untouched during AND after measurement), creates one only when absent — resolving
  through `getPrimaryOwner(sessionId) ?? ORCHESTRATOR_NAME`, so ownerless synthetic pairing sessions
  keep today's `architect` stamp bit-for-bit — and both cleanup paths release into a REFCOUNTED hold/release registry: the
  FIRST concurrent holder captures the ORIGINAL prior state and only the LAST holder to finish
  restores it — per-run capture and stamped-value tokens both restored another invocation's
  temporary entry under concurrent same-id runs (two reviewer-executed counterexamples); the
  asymmetric L6 concurrent leg (fast minimal run vs slow record-heavy run on the same ids) pins
  zero residue, and the per-run re-capture mutant is killed 10/10 by it. A direct-binding
  `_internals` seam exposes the production composer for deterministic lifecycle tests.
- **Phase-monitor no longer does session-keyed work on sessionless system-transform calls**
  (`src/hooks/phase-monitor.ts`, #3383): the hook ran `loadPlan` (which itself materializes
  `.swarm/plan.md` and review receipts), invoked the curator delegate factory with
  `sessionId === undefined`, ran curator init, and wrote `.swarm/curator-briefing.md` on calls with
  no `sessionID` (title/summary/agent-generation surfaces). A falsy early-return guard
  (`if (!sessionId) return;`, mirroring the #3320 system-enhancer precedent — empty-string and null
  IDs are sessionless too) now precedes `loadPlan`. Session-bound behavior is unchanged.
- Existing suites that pinned the sessionless behavior
  (`tests/unit/hooks/phase-monitor-curator.test.ts`, `tests/unit/hooks/phase-monitor.test.ts`,
  `tests/integration/phase-preflight-auto.test.ts`) were re-pinned with explicit session IDs,
  preserving their original curator/phase-transition coverage instead of flipping expectations.
- New suites pin the contracts: frozen `instruction-pairing-identity`,
  `phase-monitor-sessionless-guard`, the knowledge-enabled sessionless journey case, plus
  supplementary lifecycle legs (pre-existing-entry preservation incl. the prior-value≠owner
  delegation shape, the distinct `pairing-invalidation` session, the L5a source-shape anchor, the
  L5b public during-run sampler with a poller-works control — the sole behavioral closer of the
  wrapper-divergence path — and the L6 asymmetric concurrent zero-residue leg) and a
  falsy-session-ID leg.

## Why

Both defects are the same family — surfaces that mutate or consume session-scoped state without
owning the session — violating the #3320 ownership contract. #3372 was filed by the #3320 trace as
the known same-class writer left open; #3383 is the one remaining composed `system.transform`
producer with session-keyed side effects and no sessionless guard (the #3320 sessionless fixtures
booted with knowledge disabled, so the producer was never exercised sessionlessly).

## Verification

- Frozen acceptance checks C1-C3 (checkpoint e53bbe1e, anchor published on both issues): all
  RED at base e8223e308, GREEN at the fix head (replay via `repro/replay-all.sh`).
- Supplementary lifecycle (8 legs) and falsy (2 legs) suites: DISCRIMINATING legs RED at base,
  GREEN at head; PRESERVING legs GREEN both ends (L6 is GREEN at base AND head — base deletes
  unconditionally — its discriminator is the M7 per-run re-capture mutant, killed 10/10).
- Re-pinned suites green: phase-monitor 7/7, phase-monitor-curator 17/17, phase-preflight-auto
  53/53; sibling suites green (instruction-pairing 6/6, memory command suites).
- `bun run typecheck` clean; pinned `@biomejs/biome@2.3.14 ci` clean on all touched files.
