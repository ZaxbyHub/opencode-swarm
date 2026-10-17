# Acceptance auto-injection: test coverage and docs precision

## Summary

- Pins four behaviors of `hooks.auto_inject_acceptance` found by a post-merge mutation pass over #3369: an injection from an unregistered session queues no advisory, a rejected no-text-field dispatch is left with exactly its original keys, the advisory carries the `acceptance_field_empty` reason, and an empty header that only the cross-field join can see is rejected and left untouched.
- `docs/configuration.md` now states precisely when the strict rejection stands (the injection cannot be applied to the field the validator inspected), instead of only "no field can carry the block".

## Known caveats

- No runtime behavior changes. The last pinned case is the current behavior; the field-joining criterion in #3381 will revisit it.
