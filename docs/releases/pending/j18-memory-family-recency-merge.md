---
issue: 2958
---

## Memory link/unlink keeps the newer version of a record instead of the pre-link version

`/swarm memory link` and `/swarm memory unlink` no longer silently keep the
destination store's OLDER version when both stores hold the same record id. The
family migration now compares recency before merging: a strictly newer source
row for a shared id wins (appended for JSONL members — the file stays
append-only; a guarded `ON CONFLICT … DO UPDATE … WHERE excluded.updated_at >
memory_items.updated_at` upsert for the SQLite `memory_items` table), a
destination-newer or equal row keeps today's skip, and a collision with no
usable recency signal keeps destination-wins but is now reported instead of
silent. Tables with no version recency signal (notably `memory_proposals`,
whose `created_at` is the proposal's original creation time and never advances)
keep `INSERT OR IGNORE` with their collided ids reported as unresolved.

Deleted-on-destination records that a newer live source row would resurrect are
detected and reported: the migration result gains a per-member audit
(`resurrectedIds`, `supersededCount`, `unresolvedCollisions`) and both commands
print one bounded line (ids capped at 5) when resurrections or unresolved
collisions occurred — including on unlink, whose migration result was
previously discarded entirely. A newer destination tombstone still suppresses
resurrection. The destination-lock admission engine (invariant Check 8,
issue #2577) is unchanged and stays green.
