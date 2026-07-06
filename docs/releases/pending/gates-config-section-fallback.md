Fixes gates config parsing so partial or typoed `gates` blocks no longer wipe the entire user configuration.

- Partial `gates` configs now receive defaults for omitted gate sections instead of failing full config validation.
- Invalid or unknown `gates` subsections are ignored with a warning while the rest of the user's valid config remains active.
- `/swarm config doctor` now reports invalid or typoed raw `gates` entries so users can find and repair the ignored section.

No migration is required.
