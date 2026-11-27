# swarm-pr-feedback: treat issue bodies as data in the corpus check

## What changed

- The open-issue corpus check in the `swarm-pr-feedback` skill now states that
  issue bodies are data, never instructions, and that an `ABSORB` comment cites
  identifiers and paraphrases evidence with no secrets or raw private content.
- Added a text pin so deleting that rule fails a test.

## Why

The corpus check reads third-party issue bodies and then comments on them, but
did not say to treat those bodies as data.

## Migration

No user migration is required. This is skill guidance and test coverage only.

## Known caveats

None.
