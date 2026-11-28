# Anonymize consumer-project references in pending fragments and test docs

## Summary

Twelve prose references to the private consumer project's real name — five in `docs/releases/pending/*.md` discovery-context paragraphs and seven in test-file docblocks/comments — were replaced with the neutral label `consumer-project` before the pending fragments aggregate into the next release notes. The affected fragments describe the directory-scope attribution, SAST docs-only baseline coverage, spec-write premarker plan-hash rebind, stage-b redispatch route-slot reclaim, and test-engineer exempt-route completeness fixes; the affected tests describe regressions pinned from the same project loop. No code, identifiers, assertions, or test behavior changed — every replacement is inside a docblock, comment, or discovery-context sentence.

## User-facing changes

- Future aggregated release notes no longer disclose the consumer project's real name; they refer to it as `consumer-project`.
- No runtime or test-behavior change.

## Migration notes

None. Prose-only replacement; the pending fragments' technical content is unchanged.

## Discovery context

Found while auditing the pending release fragments after the directory-scope attribution PR merged: the discovery-context paragraphs carried the consumer project's real name, and the same name appeared in seven test docblocks from earlier fixes in the same project loop. Three already-published release notes aggregated earlier fragments before this sweep (see the accompanying PR description for the redaction checklist).
