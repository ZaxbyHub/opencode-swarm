# Fix: a flaky knowledge-query test was evicting PRs from the merge queue

## What

`tests/unit/tools/knowledge-query.test.ts` → `Applies all valid categories
correctly` rewrote the **same** `.swarm/knowledge.jsonl` on each of ten
iterations and re-read it immediately. On `windows-latest` that raced: the read
returned the previous iteration's content and the assertion failed on
`integration`, the eighth of ten.

The blast radius is what makes it worth a release note rather than a silent test
tweak. The test runs in the `unit` job, which the merge queue executes on every
`merge_group` event — so each occurrence dropped whichever pull request was
queued at the time, regardless of whether that PR had anything to do with
knowledge storage. It evicted PR #2261 and cost a full re-queue cycle.

## Fix

The race is removed rather than suppressed. All ten entries are written **once**,
then the per-category queries run against that single write. No retry, no sleep,
no widened timeout — those would have hidden the race while leaving the window
open.

This loses no coverage: the tool's own category filter already isolates each
entry, so writing them together and querying one at a time exercises exactly what
the per-iteration rewrite did. The test still asserts, per category, both the
matching entry id and the echoed filter line, and the file still reports the same
42 tests.

## Note for future edits

Do not reintroduce a write inside that loop. The file carries an inline comment
saying so, because the failure is invisible on a developer machine — it did not
reproduce locally across five consecutive runs on the same OS that CI failed on,
and only shows up under the timing and filesystem behavior of a loaded CI runner.
