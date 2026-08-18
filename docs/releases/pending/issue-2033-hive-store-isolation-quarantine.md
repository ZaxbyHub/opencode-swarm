---
issue: 2033
---

## Isolated hive stores and added exact-ID quarantine with rollback

### Test/production store boundary is now enforced

- A fail-closed **production-store tripwire** now guards every `bun test` run
  (`tests/preload/prod-store-tripwire.ts`, registered in `bunfig.toml [test] preload`).
  It captures the real machine-global knowledge-store paths before any test loads and
  throws on content reads and all mutations against them — node:fs/node:fs/promises
  guards (spread-real) plus a `Bun.write` wrap, with `atomicWriteFile`'s final
  `renameSync` as a backstop. Metadata reads (`readdir`/`stat`/`existsSync`) and `mkdir`
  are intentionally unguarded (documented). A global preload `afterEach` re-arms the
  guards after every test and a global `afterAll` verifies the real stores are
  unchanged after every suite, and `mock.restore()` semantics are pinned by a test so
  a future runtime change cannot silently disarm the tripwire. Hermetic suites are
  unaffected.
- Fixed the test files that still resolved REAL platform roots on Windows
  (`LOCALAPPDATA`-first branch): the `#1850` memory suites (`storage-root`,
  `gateway-cohort-integration`, `diagnostics-no-leakage`), `knowledge-injector-events`
  (whose `linked-worktree` pointer wrote real link-store event files as recently as
  2026-08-15), and `knowledge-escalator-near-dup` (whose hive reads were silently
  machine-dependent). Env restores now use delete-if-undefined semantics.
- Store-writing suites assert `verifyRealStoresUnchanged()` in `afterAll`, and a
  source-traced regression test reproduces the historical PR-#1847 fixture-leak class
  (real-path hive writes before redirection existed) and proves the tripwire blocks it.

### Human-only exact-ID hive quarantine

New `/swarm knowledge hive-quarantine` command with layered agent gates (`swarm_command`
+ chat-fallback refusals; a shell guardrail that blocks direct, quoted, path-qualified,
AND shell-variable-indirected CLI invocations; a CLI-side refusal of human-only commands
from non-interactive shells; and an HMAC-signed confirmation token keyed to a
per-install secret so tokens cannot be minted from public store contents). No
`--yes`/`--force` flag exists; the layers are defense-in-depth plus honest audit —
not a tamper-proof boundary against the machine's own user):

- `preview <id>[,<id>…]` — read-only snapshot of exact IDs with per-line sha256,
  provenance, status, and a store fingerprint; issues a 15-minute confirmation token
  bound to preview + store + plugin version.
- `commit --token <t> [--reason …]` — a validated backup + manifest written and
  hash-verified BEFORE any mutation, then one fast `transactHiveStore` transaction that
  re-verifies the live file hash against the backup under lock (any drift — concurrent
  append, entry change, version bump, duplicate-id ambiguity — aborts with no mutation;
  aborts clean up the orphaned backup dir), moving exactly the selected entries to
  `shared-learnings-quarantined.jsonl` with audit records in
  `shared-knowledge-events.jsonl`, then post-commit count/hash verification whose
  automatic backup restore reports its outcome honestly (never a blanket "restored"
  claim).
- `rollback --token <t12> | --latest` — idempotent, byte-exact restore of the selected
  ids from the manifest; collision (id re-promoted with different content) aborts with
  no mutation. Two standing-transaction disclosures apply to everything except the
  selected ids: unselected entries may be re-serialized by the store's
  normalize-on-write pipeline, and unparseable (corrupt) lines are dropped by commit AND rollback
  rewrites — they survive only in the hash-verified backup copy.
- `status` — read-only backup listing.

Selection is exact-ID only — never by text, substring, cohort, age, or blacklist, and
never in bulk. Quarantined entries disappear from recall/query by construction; the hive
audit log keeps `quarantined`/`rollback` records.

### Observability

New metadata-only `knowledge_maintenance` telemetry event (bounded phase/abort codes,
counts, hash/token prefixes; no lesson text, no paths) for every preview/commit/verify/
rollback phase. Catalog now 42 kinds; `bun run check:events` enforces the contract.
