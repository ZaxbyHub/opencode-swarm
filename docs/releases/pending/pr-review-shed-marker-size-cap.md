# PR-review shed-marker size cap

## What changed

- The PR-review collection receipt shed-marker parser now applies the same
  final-line size cap as the footer parser before attempting to parse JSON.
- Added a regression test that proves oversized shed markers are rejected
  without calling `JSON.parse`.

## Why

PR-review transport can receive untrusted assistant text. The shed-marker path
was already schema-validated, but it still parsed oversized final lines before
rejecting them. The new guard makes the parser fail closed consistently with
the footer path.
