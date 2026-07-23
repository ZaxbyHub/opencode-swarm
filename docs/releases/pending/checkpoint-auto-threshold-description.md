# Add retention-semantics description to `auto_checkpoint_threshold` schema field

## What changed

- The `auto_checkpoint_threshold` field of `CheckpointConfigSchema` in `src/config/schema.ts` now has an inline comment documenting that it caps the number of retained checkpoints and evicts the oldest when the cap is exceeded.
- This aligns the schema-level documentation with the established behavior already documented in the release notes for the checkpoint retention feature (see `docs/releases/pending/task-completion-commit-frequency.md` lines 9 and 26) and the implementation in `src/tools/checkpoint.ts`.

## Why

The field had no schema-level description, leaving its retention semantics ambiguous to anyone reading the config schema. The code and prior release notes already agreed on the meaning — only the inline documentation was missing. Closes #1660.

## Migration steps

None. This is a documentation-only change; behavior is unchanged.

## Breaking changes

None.

## Known caveats

- The field name `auto_checkpoint_threshold` remains unchanged. A future rename or deprecation alias (e.g. `max_retained_checkpoints`) is possible but is explicitly not part of this change.