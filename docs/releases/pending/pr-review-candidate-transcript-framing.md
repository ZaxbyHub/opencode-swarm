# Accept PR-review candidates after transcript progress text

## What

PR-review candidate parsing now locates the first explicit `[CANDIDATE]`
protocol marker in a stored async-lane transcript instead of treating an
earlier pipe-delimited progress message as the candidate header. The parser and
controller coverage gate share the same framing rule for base and micro-lane
candidate rows and CLEAN attestations.

## Why

Async lane artifacts preserve all assistant text turns. A harmless progress
turn containing a pipe could therefore precede a valid canonical candidate
section and cause both trust boundaries to reject otherwise valid discovery
evidence, leading to unnecessary retries and blocked PR-review completion.

## Migration

No migration is required. Explorer output should still use one exact canonical
`[CANDIDATE]` header followed by candidate or CLEAN rows.

## Caveats

The first marker-bearing candidate line remains authoritative. Malformed
headers and marker-prefixed data rows without a canonical header still fail
closed, even if a later valid header appears.
