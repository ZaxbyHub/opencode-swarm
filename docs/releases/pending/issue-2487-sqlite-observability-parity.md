# SQLite observability compatibility qualification

- Added an enforcing compatibility/reachability registry for `swarm.db` and
  named legacy streams, including independent schema/table and production
  source checks.
- Added bounded three-OS qualification coverage for Bun/Node close/reopen
  through seven production store-family APIs, with machine-mapped focused
  semantic suites, recovery, archive restore, full ordered retention-survivor
  hashing, and
  retention-registry-owned legacy reachability (including knowledge
  application records).

Migration steps: none. The qualification check is merge-group gated and keeps
legacy recovery inputs reachable until an independently measured retirement
proof exists.

Known caveat: the qualification runner writes only isolated temporary fixture
databases; it never reads or mutates a user project database.
