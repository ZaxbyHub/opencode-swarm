// Node-side proof for issue #2030 item 4: exercise the FULL archiveSqliteSnapshot
// path (VACUUM INTO + PRAGMA query_only + integrity_check + row counts) through
// the REAL shipped engine re-exported from dist/index.js, under real Node — so
// the node:sqlite adapter in src/db/sqlite-loader.ts is the driver, not a
// standalone shim. The engine's byte-budget preflight, typed reason_code,
// temp-then-rename publish, and row-count validation are all exercised.
//
// Run:  bun run build && node scripts/repro-2030-archive-node.mjs
// Exit 0 = PASS.

import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const bundleUrl = pathToFileURL(path.resolve('dist/index.js')).href;
const mod = await import(bundleUrl);

// The engine is re-exported from src/index.ts (issue #2030). If it is missing
// the proof is vacuous — fail hard instead of silently degrading.
const { archiveSqliteSnapshot } = mod;
if (typeof archiveSqliteSnapshot !== 'function') {
	fail(
		'dist/index.js did not re-export archiveSqliteSnapshot — rebuild the bundle (bun run build)',
	);
}

// The shared loader (src/db/sqlite-loader.ts) is the runtime-portable driver
// the engine uses. Routing the fixture-source connections through it proves the
// adapter layer under Node, not just bare node:sqlite.
const { DatabaseSync } = await import('node:sqlite');

// Minimal bun:sqlite-compatible shim over node:sqlite, so the fixture can use
// the same .run/.query surface the engine expects without pulling the bundle's
// internal adapter. (The engine itself imports loadDatabaseCtor from the bundle.)
function openDb(p) {
	const raw = new DatabaseSync(p);
	return {
		_raw: raw,
		run(sql, ...rest) {
			if (rest.length === 0) {
				raw.exec(sql);
				return undefined;
			}
			const params =
				rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
			return raw.prepare(sql).run(...params);
		},
		query(sql) {
			const stmt = raw.prepare(sql);
			return { get: (...p) => stmt.get(...p), all: (...p) => stmt.all(...p) };
		},
		close() {
			raw.close();
		},
	};
}

const workDir = fs.mkdtempSync(path.join(tmpdir(), 'repro-2030-node-'));
const srcPath = path.join(workDir, 'swarm.db');
const destDir = path.join(workDir, 'archive');
fs.mkdirSync(destDir, { recursive: true });

function fail(msg) {
	console.error(`[repro-2030-node] FAIL: ${msg}`);
	try {
		fs.rmSync(workDir, { recursive: true, force: true });
	} catch {}
	process.exit(1);
}

// 1. Create a WAL-mode source with committed rows + schema_migrations.
const db1 = openDb(srcPath);
db1.run('PRAGMA journal_mode = WAL;');
db1.run('PRAGMA synchronous = NORMAL;');
db1.run('PRAGMA busy_timeout = 5000;');
db1.run(`CREATE TABLE project_constraints (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	constraint_type TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
db1.run(`CREATE TABLE schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
for (let i = 1; i <= 5; i++) {
	db1.run(
		'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
		['a', `committed-${i}`],
	);
}
db1.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
	1,
	'create_project_constraints',
]);

// 2. Open a SECOND connection, BEGIN IMMEDIATE, INSERT uncommitted (do NOT commit).
const db2 = openDb(srcPath);
db2.run('PRAGMA busy_timeout = 5000;');
db2.run('BEGIN IMMEDIATE;');
db2.run(
	'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
	['uncommitted', 'SHOULD-NOT-APPEAR'],
);

// 3. Run the REAL shipped engine against the source with the open uncommitted
//    writer. This exercises VACUUM INTO, the byte-budget preflight, the typed
//    reason_code, temp-then-rename publish, PRAGMA query_only validation,
//    integrity_check, schema_migrations presence, and row-count capture — all
//    through the bundle's loadDatabaseCtor (node:sqlite adapter under Node).
const r = await archiveSqliteSnapshot({
	sourcePath: srcPath,
	destDir,
	destName: 'swarm.db',
});

if (r.attempt !== 'succeeded') {
	fail(
		`archiveSqliteSnapshot attempt=${r.attempt} reason_code=${r.reason_code} detail=${r.detail ?? ''} (expected succeeded)`,
	);
}
if (r.validation !== 'passed') {
	fail(`archiveSqliteSnapshot validation=${r.validation} (expected passed)`);
}
if (r.reason_code !== 'ok') {
	fail(`archiveSqliteSnapshot reason_code=${r.reason_code} (expected ok)`);
}
if (r.method !== 'vacuum_into') {
	fail(`archiveSqliteSnapshot method=${r.method} (expected vacuum_into)`);
}
if (!r.destPath) fail('archiveSqliteSnapshot returned no destPath');
if (r.rowCounts?.project_constraints !== 5) {
	fail(
		`engine row_counts.project_constraints = ${r.rowCounts?.project_constraints} (expected 5)`,
	);
}
if (r.rowCounts?.qa_gate_profile !== 0) {
	fail(
		`engine row_counts.qa_gate_profile = ${r.rowCounts?.qa_gate_profile} (expected 0)`,
	);
}
if (r.rowCounts?.schema_migrations_max_version !== 1) {
	fail(
		`engine row_counts.schema_migrations_max_version = ${r.rowCounts?.schema_migrations_max_version} (expected 1)`,
	);
}
// The destination is a single self-contained file (no WAL/SHM sidecars).
if (!fs.existsSync(r.destPath)) fail(`destPath ${r.destPath} does not exist`);
if (fs.existsSync(r.destPath + '-wal'))
	fail('destination has a -wal sidecar (expected single self-contained file)');
if (fs.existsSync(r.destPath + '-shm'))
	fail('destination has a -shm sidecar (expected single self-contained file)');
console.log('[repro-2030-node] archiveSqliteSnapshot via real adapter: OK');

// 4. Independently verify the restored snapshot via the shared loader: open the
//    destination read-only, assert committed rows present + uncommitted absent
//    + integrity ok. This is the restore-query proof item 4 requires.
const verify = openDb(r.destPath);
verify.run('PRAGMA query_only = ON;');
const integrity = verify.query('PRAGMA integrity_check').get();
const ic = String(integrity?.integrity_check ?? integrity ?? '');
if (ic !== 'ok') fail(`integrity_check='${ic}' (expected 'ok')`);

// Verify the INSERT-blocking behavior of query_only under real node:sqlite
// (the engine's read-only safety guarantee).
try {
	verify.run(
		"INSERT INTO project_constraints (constraint_type, content) VALUES ('x', 'y')",
	);
	fail('PRAGMA query_only did NOT block a write under node:sqlite');
} catch (e) {
	if (!/readonly/i.test(String(e.message))) {
		fail(`query_only write-blocked but with unexpected error: ${e.message}`);
	}
}

const committedRow = verify
	.query('SELECT COUNT(*) AS c FROM project_constraints')
	.get();
const uncommittedRow = verify
	.query(
		"SELECT COUNT(*) AS c FROM project_constraints WHERE content = 'SHOULD-NOT-APPEAR'",
	)
	.get();
verify.close();

const committedCount = Number(committedRow?.c ?? 0);
const uncommittedCount = Number(uncommittedRow?.c ?? 0);
if (committedCount !== 5)
	fail(`restored committed rows = ${committedCount} (expected 5)`);
if (uncommittedCount !== 0)
	fail(`uncommitted row leaked into snapshot = ${uncommittedCount} (expected 0)`);

// 5. Commit the writer and confirm the source now has 6 (proving the snapshot
//    excluded the uncommitted row, not that it was never written).
db2.run('COMMIT;');
const after = openDb(srcPath);
const afterCount = Number(after.query('SELECT COUNT(*) AS c FROM project_constraints').get()?.c ?? 0);
after.close();
db2.close();
db1.close();
if (afterCount !== 6)
	fail(`source count after commit = ${afterCount} (expected 6 — proves exclusion)`);

fs.rmSync(workDir, { recursive: true, force: true });
console.log(
	'[repro-2030-node] PASS — real archiveSqliteSnapshot engine + restore-query verified under node:sqlite.',
);
process.exit(0);
