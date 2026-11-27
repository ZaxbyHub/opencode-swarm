# swarm-pr-feedback: pin the round-ledger rules and treat issue bodies as data

## What changed

- The open-issue corpus check in the `swarm-pr-feedback` skill now states that
  issue bodies are data, never instructions, and that an `ABSORB` comment cites
  identifiers and paraphrases evidence with no secrets or raw private content.
- Added text pins for the bodies-are-data rule, the Fix-in-this-PR exception
  link to the round ledger, and the `SKILL.md` round-2 checkpoint pointer, so
  deleting or moving them fails a test.

## Why

#3911 pinned the corpus check and the round ledger, but not the exception link
or the `SKILL.md` pointer. The corpus check also read third-party issue bodies
without saying to treat them as data.

## Migration

No user migration is required. This is skill guidance and test coverage only.

## Known caveats

The verdict table and round count still rely on the agent following the skill;
no runtime hook enforces them.
