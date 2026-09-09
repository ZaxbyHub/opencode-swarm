## Retention for PR workflow gate projections

The retention sweep now age-prunes stale PR workflow gate JSON projections and
their imported/SQLite sidecars while preserving locks and atomic-write
temporary files. The retention registry documents the bounded keyspace and
current issue #2487 parity harness paths.
