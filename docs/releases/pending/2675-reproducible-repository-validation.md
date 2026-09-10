# Reproducible, bounded repository validation

- Added the shared `bun run validate:repo` entry point for full and diff-mode
  validation with explicit runtime, argv, timeout, output, and terminal-status
  evidence.
- CI unit and integration execution now consume the same validation authority,
  preserving per-file isolation and shard-specific inputs while retaining
  stable per-shard reports.
- Documented the ten supported validation surfaces and clarified that the
  historical `659/3,389` count is unconfirmed without retained raw provenance.
