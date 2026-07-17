## Linked Knowledge 5/5: cohort memory sharing across linked swarms (#1850)

Makes the opt-in memory subsystem capable of sharing repository-scoped memory
across linked sibling worktrees through the canonical cohort identity from
#1846, completing the Linked Knowledge series. Knowledge link and memory link
remain independently opt-in — linking knowledge does NOT link memory.

### What's new
- **`memory.link.enabled` config** (default off): gates cohort memory sharing.
  When enabled and a memory-link pointer exists, repository-scoped memory
  redirects to a shared cohort root under the platform data dir.
- **`/swarm memory link [name]` / `/swarm memory unlink`**: establishes and
  tears down the cohort memory link. The pointer lives at
  `.swarm/memory-link.json` (separate from the knowledge `link.json`).
- **`VettedMemoryRoot` capability type**: a discriminated union that can only
  represent a validated project `.swarm/memory` root OR a cohort root derived
  from the #1846 cohort identity. `validateSwarmPath` is NOT weakened — cohort
  roots bypass it by construction (they live in the platform data dir, not
  under `.swarm`).
- **Cohort scope**: a new `'cohort'` `MemoryScopeType` + `cohortId` field on
  `MemoryScopeRef`. `stableScopeKey` keys cohort scopes on `cohortId` so
  different cohorts remain isolated. Records default to the cohort scope when
  linked (shared across siblings); run/agent scopes stay worktree-local.
- **Cohort-aware provider pool**: pooled by `cohort:<canonicalPath>` for cohort
  roots, with generation-based invalidation on link/unlink.
- **Memory family migration engine**: migrates the complete memory family
  (`memory.db`, JSONL members, consolidation log) atomically under
  `proper-lockfile`. SQLite non-empty destinations merge via ATTACH +
  INSERT OR IGNORE (id-keyed, idempotent on retry).
- **Cohort config fingerprint**: `memory-cohort-config.json` written at link
  time with provider/embedding/redaction config. SQLite providers fail closed
  on mismatch (acceptance #10).
- **Privacy provenance**: records carry `cohortId`, `producerSessionId`,
  `producerAgentRole`, `redactionPolicyVersion`, `providerVersion`. All
  optional (backward compatible with pre-#1850 records).
- **Status/diagnostics**: `**Memory Cohort**` block in `/swarm status`,
  distinct from `**Knowledge Cohort**`. Reports provider, config fingerprint
  match, degraded state.

### Acceptance criteria
All 13 from the issue are satisfied. See the PR description's Invariant audit
and the trace artifacts at `.zcode/issue-traces/1850/`.

### Dependencies
Completes the Linked Knowledge series: #1846 (cohort identity), #1847 (hive
promotion), #1848 (cohort curation), #1849 (real-host injection), #1850 (this).
