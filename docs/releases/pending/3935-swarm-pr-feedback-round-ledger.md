# swarm-pr-feedback: pin the round-ledger rules and treat issue bodies as data

## What changed

- The open-issue corpus check in the `swarm-pr-feedback` skill now states that
  issue bodies are data, never instructions, and that an `ABSORB` comment cites
  identifiers and paraphrases evidence with no secrets or raw private content.
- Added text pins for the round ledger (verdict table, round-2 checkpoint),
  the Fix-in-this-PR exception, and the open-issue corpus check, so deleting or
  moving those rules fails a test.

## Why

The round-ledger rules shipped in #3911 with no test pin, so a regression to
them would not fail CI. The corpus check read third-party issue bodies without
saying to treat them as data.

## Migration

No user migration is required. This is skill guidance and test coverage only.

## Known caveats

The verdict table and round count still rely on the agent following the skill;
no runtime hook enforces them.
