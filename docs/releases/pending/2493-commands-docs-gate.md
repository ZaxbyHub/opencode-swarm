## Summary

- **Generated commands reference** (#2493, source #1648): `docs/commands.md` is now rendered from `COMMAND_REGISTRY` by `scripts/generate-commands-docs.ts` (`bun run generate:commands-docs --write`), so the per-command reference can no longer drift from the shipped commands — including the live drift where `/swarm turbo` was documented without the `epic` argument.
- **CI drift gate**: `tests/unit/scripts/generate-commands-docs.test.ts` fails the unit shards when the committed page stops matching regeneration (byte-for-byte, CRLF-normalized).
- **Escape hatches documented**: `/swarm abort-pr-workflow` and `/swarm approve-plan-critic` now have a dedicated human-only "Escape Hatches" section explaining what each unlocks and when to use it.
- **Hidden internal aliases**: the 37 mechanical dash-form/legacy aliases (e.g. `config-doctor`, `plan`, `deep dive`) still resolve at runtime but are no longer listed in the docs; each command appears once under its canonical name.
