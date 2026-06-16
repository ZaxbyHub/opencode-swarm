Fixes knowledge storage race closeout by carrying the TOCTOU transaction refactor through current `main`, preserving hive archive support, and replacing timing-dependent coverage with a deterministic stale-snapshot regression test.

No migration required.
