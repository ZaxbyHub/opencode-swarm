---
issue: 2958
---

## Memory link/unlink keeps the newer version of a record instead of the pre-link version

`/swarm memory link` and `/swarm memory unlink` no longer silently keep the
destination store's OLDER version when both stores hold the same record id. The
family migration now compares recency before merging: a strictly newer source
row for a shared id wins (appended for JSONL members — the file stays
append-only; a guarded `ON CONFLICT … DO UPDATE … WHERE excluded.updated_at >
memory_items.updated_at` upsert for the SQLite `memory_items` table when both
sides carry the same schema — stores whose `memory_items` shapes differ keep
the pre-existing per-table skip degradation), a destination-newer or equal row
keeps today's skip, and a JSONL collision with no usable recency signal keeps
destination-wins but is now reported instead of silent. The SQLite
`memory_proposals` table (whose `created_at` is the proposal's original
creation time and never advances) keeps `INSERT OR IGNORE` with its collided
ids reported as unresolved; the event/usage tables (unique random ids) keep
`INSERT OR IGNORE` silently.

Deleted-on-destination records that a newer live source row would resurrect are
detected and reported: the migration result gains a per-member audit
(`resurrectedIds`, `supersededCount`, `unresolvedCollisions`) and both commands
print bounded audit lines (ids capped at 5 per line) when resurrections,
supersessions, or unresolved collisions occurred — including on unlink, whose
migration result was previously discarded entirely, and superseded records now
count in the migrated-totals line. A newer destination tombstone still
suppresses resurrection. The destination-lock admission engine (invariant
Check 8, issue #2577) is unchanged and stays green.
