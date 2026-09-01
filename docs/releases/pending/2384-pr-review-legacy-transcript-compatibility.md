# Structured PR-review lane results

## What changed

- Added the child-bound `submit_pr_review_result` tool for Profile A base and
  micro discovery lanes. Receipts are bound to the exact workflow instance,
  revision, base/head pair, dispatch digest, child, lane ownership, and
  generation, then persisted atomically with exactly-once replay semantics.
- Structured `CLEAN`, `FINDINGS`, and `INCOMPLETE` envelopes now take precedence
  over transcript text, so prose, truncation, and malformed transcript rows
  cannot corrupt a successfully submitted result.
- Preserve an accepted receipt across the child's ordinary completion event,
  and keep `INCOMPLETE` lanes unresolved instead of crediting them as covered.
- Added `pr_review_legacy_transcript_compatibility` as an explicit migration
  opt-in. It defaults to `false`; newly dispatched lanes fail closed when their
  required structured receipt is absent.
- Updated tool registration, architect prompts, the bundled PR-review skill,
  configuration documentation, persistence recovery/compaction, and tests.

## Why

Issue #2384 showed that ordinary reviewer prose could be interpreted as a
malformed legacy row and invalidate an otherwise clean review. Moving the
machine contract out of transcript text makes lane settlement deterministic and
independent of provider rendering or transcript transport limits.

## Migration and compatibility

No action is required for new Profile A reviews. Temporarily set
`pr_review_legacy_transcript_compatibility: true` only while draining older
in-flight lanes or interoperating with an older host, then remove it. Profiles B
and C are unchanged.

Structured receipts upgrade affected background-delegation records to schema
version 4. Downgrading to a binary that cannot read schema v4 requires first
draining those reviews or using a compatible migration/reader. A lenient older
reader skips the unknown record; strict recovery rejects the incompatible store.

## Breaking changes and caveats

There is no configuration-breaking change. The optional host-native structured
transport boundary is present but remains unused on hosts that do not advertise
support; the child tool is the supported baseline path.
