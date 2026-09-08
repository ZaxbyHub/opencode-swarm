# SQLite and observability compatibility (issue #2487)

The machine-readable contract is
`scripts/issue-2487-compatibility.data.ts`. The enforcing checker reads the
`MIGRATIONS` catalog in `src/db/project-db.ts`, derives the table/version map,
checks every declared row, and independently scans the code-defined legacy
source universe from pre-existing retention ownership and SQLite
migration/legacy descriptions, then requires metadata tags to supply each
source's exact code symbols. That universe currently includes nine paths,
including `.swarm/knowledge-application.jsonl`; deleting a tag leaves its
independently discovered candidate behind and fails the check. A reachable
source cannot be retired or omitted by editing the matrix alone.

## Qualification groups

The matrix deliberately distinguishes schema qualification from row-level
qualification:

| Group | Executable proof |
| --- | --- |
| cross-driver equivalence partitions | Bun writes through seven production API families (project schema, QA profiles, checkpoint receipts, imports, coordination, observability, and plan ledger), closes, and Node reads identical canonical evidence; the qualification repeats the same proof Node→Bun. The checker requires a complete, non-overlapping partition for all 18 tables and each partition runs its mapped focused semantic suites in isolated processes. |
| `observability-production-retention` | Production telemetry emit/listener APIs ingest `MAX_OBSERVABILITY_EVENT_ROWS +` enough events to trigger retention; identity, payload, ordering, relationship, report, and health fields are checked for the exact 50,000 survivors. A bounded 64-character digest covers the complete ordered survivor projection and is compared with the deterministic expected projection; the fixture never prints the 50,000 records. |
| `schema-migration-open-recovery` | Bun/Node production opens run the complete migration catalog; recovery exercises killed-child rollback, explicit transaction rollback, failed migration rollback, and bounded retry. |
| `legacy-import-reachability` | Production legacy telemetry import and report query are exercised; source paths/symbols are checked and the independent reachability scan must register every reachable source. |

All durable rows use the tested always-on policy: `getProjectDb` and
`closeProjectDb` are the recovery operation, while `archiveSqliteSnapshot`
and `getProjectDb` are the rollback/restore operation. If a future row uses a
production read switch instead, the checker requires a real source control and
separate enabled/disabled evidence.

## Running the checks

```text
bun run check:issue-2487-compatibility
bun run repro:2487
bun --smol test ./tests/smoke/issue-2487-qualification.test.ts --timeout 120000
```

`repro:2487` builds temporary Bun and Node production API barrels under the
gitignored `dist-build-test/` directory. Each child uses an explicit working
directory, ignored stdin, bounded output, a 60-second deadline, and best-effort
kill cleanup. Fixtures use isolated temporary project roots only.
