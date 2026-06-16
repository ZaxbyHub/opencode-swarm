# Knowledge confirmation reinforcement

## What changed

- Near-duplicate swarm knowledge entries now reinforce the active matched entry instead of dropping the signal.
- `knowledge_add` reports reinforced duplicates as successful idempotent outcomes and returns the matched entry id.
- Curator curation results now include a `reinforced` count, and phase completion/advisor evidence surfaces that count.
- A new phase confirmation resets `phases_alive` to `0` and recomputes confidence from distinct phase confirmations.

## Why

Repeatedly learning the same lesson in different phases is the strongest signal that a lesson is durable. Before this fix, duplicate detection discarded that signal, so entries could not naturally reach the confirmation counts required for established/promoted status, hive eligibility, or skill maturity gates.

## Migration steps

None. Existing entries continue to load normally. Future near-duplicate encounters add missing phase confirmations to active entries.

## Known caveats

- Repeating a lesson within the same phase is intentionally a no-op so one phase cannot inflate confirmation counts.
- Archived or quarantined entries are not revived by duplicate reinforcement.
