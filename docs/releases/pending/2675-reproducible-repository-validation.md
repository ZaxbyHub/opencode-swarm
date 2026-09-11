# Reproducible, bounded repository validation

- Added the shared `bun run validate:repo` entry point for full and diff-mode
  validation with explicit runtime, argv, timeout, output, and terminal-status
  evidence.
- CI unit execution now consumes the same validation authority across six
  round-robin unit shards with stable per-shard reports; merge-group integration
  execution uses that authority sequentially with per-file isolation and no
  integration sharding.
- Documented the ten supported validation surfaces and clarified that the
  historical `659/3,389` count is unconfirmed without retained raw provenance.
