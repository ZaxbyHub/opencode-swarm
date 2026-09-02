#!/usr/bin/env node
/**
 * Issue #1873 reproduction + regression harness — SQLite under Node.
 *
 * OpenCode Desktop loads the plugin inside a Node.js Electron `utilityProcess`
 * sidecar. The DB layer used to resolve `bun:sqlite` with no fallback, so under Node
 * every SQLite-backed tool threw `Cannot find module 'bun:sqlite'`. This harness runs
 * the REAL shipped DB + memory code paths under Node (which has no `bun:sqlite`) and
 * asserts they work via the `node:sqlite` adapter (`src/db/sqlite-loader.ts`).
 *
 * Pre-fix: this FAILS at the first `getProjectDb` with `Cannot find module 'bun:sqlite'`.
 * Post-fix: it PASSES — project DB, global DB, and the SQLite memory provider all work.
 *
 * It exercises the full adapter surface against the real driver:
 *   run(sql) / run(sql, params) / query().get / query().all / query().iterate /
 *   transaction() (migrations, compactMaintenance) / inTransaction / close / FTS5.
 * The `node:sqlite`-vs-fake unit coverage lives in `src/db/sqlite-loader.test.ts`.
 *
 * Wired as `bun run repro:1873` (bun builds the entry → node runs this) and as a CI
 * smoke step on Linux/macOS/Windows. Requires a Node with flag-free `node:sqlite`
 * (Node 22.13+; the CI smoke job pins `actions/setup-node` node 22).
 */

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = resolve(
	ROOT,
	'dist-build-test',
	'repro-1873',
	'repro-1873-entry.js',
);

const failures = [];
function check(label, cond, detail = '') {
	if (cond) {
		console.log(`[repro-1873] OK ${label}`);
	} else {
		failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
		console.error(`[repro-1873] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

function makeRecord(mod, { kind, scope, text }) {
	const now = new Date().toISOString();
	return {
		id: mod.createMemoryId({ scope, kind, text }),
		scope,
		kind,
		text,
		tags: [],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: '/repro-1873/fixture.ts' },
		createdAt: now,
		updatedAt: now,
		expiresAt: undefined,
		supersededBy: undefined,
		contentHash: mod.computeMemoryContentHash({ scope, kind, text }),
		metadata: {},
	};
}

async function main() {
	// Sanity: confirm we are really on a runtime WITHOUT bun:sqlite (the bug's
	// trigger). If bun:sqlite resolves, we are under Bun and this harness is moot.
	try {
		createRequire(import.meta.url)('bun:sqlite');
		console.error(
			'[repro-1873] SKIP: bun:sqlite resolved — run this under Node, not Bun.',
		);
		process.exit(2);
	} catch {
		console.log('[repro-1873] confirmed: bun:sqlite is unavailable (Node runtime).');
	}

	let mod;
	try {
		mod = await import(pathToFileURL(ENTRY).href);
	} catch (err) {
		console.error(
			`[repro-1873] FAILED to import ${ENTRY}. Build it first: ` +
				'`bun build scripts/repro-1873-entry.ts --outdir dist-build-test/repro-1873 --target node --format esm`',
			err,
		);
		process.exit(1);
	}

	// Isolate the global DB config dir into a temp dir (getPlatformConfigDir reads
	// HOME / XDG_CONFIG_HOME / LOCALAPPDATA live) so we never touch real user config.
	const cfgHome = mkdtempSync(join(tmpdir(), 'repro1873-cfg-'));
	process.env.HOME = cfgHome;
	process.env.XDG_CONFIG_HOME = cfgHome;
	process.env.LOCALAPPDATA = cfgHome;
	const projDir = mkdtempSync(join(tmpdir(), 'repro1873-proj-'));

	try {
		// ── Project DB: run(sql, params) + query().get + migrations transaction ──
		const db = mod.getProjectDb(projDir);
		db.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['portability', 'node-sqlite-works'],
		);
		const row = db
			.query('SELECT content FROM project_constraints WHERE constraint_type = ?')
			.get('portability');
		check(
			'project DB round-trip under Node',
			row && row.content === 'node-sqlite-works',
			`got ${JSON.stringify(row)}`,
		);

		// Typed-array (Float32Array) BLOB binding — the mechanism the sqlite-vec
		// dense-retrieval path binds embeddings with (memory_items_vec.embedding).
		// Exercised directly here since @sqlite/sqlite-vec is an optional dep not
		// installed in CI, so the vec extension itself is never loaded.
		db.run(
			'CREATE TABLE IF NOT EXISTS _repro_vec (id TEXT PRIMARY KEY, emb BLOB)',
		);
		db.run('INSERT OR REPLACE INTO _repro_vec (id, emb) VALUES (?, ?)', [
			'v1',
			new Float32Array([0.1, 0.2, 0.3]),
		]);
		const vrow = db
			.query('SELECT length(emb) AS len FROM _repro_vec WHERE id = ?')
			.get('v1');
		check(
			'Float32Array binds as a 12-byte BLOB under Node (vec mechanism)',
			vrow && Number(vrow.len) === 12,
			`len=${vrow && vrow.len}`,
		);

		// ── Global DB: separate loader consumer + different migrations ──
		const gdb = mod.getGlobalDb();
		gdb.run(
			"INSERT INTO global_rules (scope, rule_type, content) VALUES ('global', ?, ?)",
			['repro', 'global-node-sqlite-works'],
		);
		const grow = gdb
			.query('SELECT content FROM global_rules WHERE rule_type = ?')
			.get('repro');
		check(
			'global DB round-trip under Node',
			grow && grow.content === 'global-node-sqlite-works',
			`got ${JSON.stringify(grow)}`,
		);

		// ── #2480 foundation block (real node:sqlite driver) ──
		// Canonical identity: separator variants (and on Windows, case
		// variants) of the same root must share ONE handle.
		const canonicalSame =
			mod.canonicalProjectKey(projDir) === mod.canonicalProjectKey(`${projDir}/./`);
		check(
			'#2480 canonical key collapses separator variants',
			canonicalSame,
			`keys: ${mod.canonicalProjectKey(projDir)} vs ${mod.canonicalProjectKey(`${projDir}/./`)}`,
		);
		if (process.platform === 'win32') {
			const caseVariant = projDir.toUpperCase();
			check(
				'#2480 canonical key collapses case variants on win32',
				mod.canonicalProjectKey(projDir) === mod.canonicalProjectKey(caseVariant),
				`keys differ for ${projDir} vs ${caseVariant}`,
			);
		}
		const dbVariant = mod.getProjectDb(`${projDir}/./`);
		check(
			'#2480 canonical cache shares one handle across spellings',
			dbVariant === db,
			'variant spelling produced a different handle',
		);

		// v14-v17 migrations applied (single-statement, both-driver-safe SQL).
		const tables = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('migration_failures', 'insight_candidate', 'phase_report')",
			)
			.all()
			.map((r) => r.name)
			.sort();
		check(
			'#2480 foundation tables exist under Node',
			tables.join(',') === 'insight_candidate,migration_failures,phase_report',
			`got ${tables.join(',')}`,
		);

		// Driver-parity contract suite on the real node:sqlite driver.
		mod.runDriverParityContract(db, { isNodeAdapter: true });
		check(
			'#2480 driver-parity contract suite passes under real node:sqlite',
			true,
			'',
		);

		// Legacy insight-candidates.jsonl import (one-txn + .imported rename).
		writeFileSync(
			join(projDir, '.swarm', 'insight-candidates.jsonl'),
			[
				JSON.stringify({ lesson: 'legacy one', created_at: '2026-01-01T00:00:00.000Z' }),
				JSON.stringify({ lesson: 'legacy two', created_at: '2026-01-02T00:00:00.000Z' }),
				'{not json',
				'',
			].join('\n') + '\n',
			'utf-8',
		);
		// First store use triggers the lazy import: 2 valid rows, 1 corrupt skipped.
		let pending = mod.countPendingInsightCandidatesDb(projDir);
		check('#2480 legacy .jsonl imported (corrupt line skipped)', pending === 2, `pending=${pending}`);
		check(
			'#2480 legacy .jsonl cold-archived .imported',
			existsSync(join(projDir, '.swarm', 'insight-candidates.jsonl.imported')),
			'rename missing',
		);

		// Append via the group-commit writer; consume via the dual-contract txn.
		await mod.appendInsightCandidatesDb(projDir, [
			{ payload: JSON.stringify({ lesson: 'fresh one', created_at: '2026-02-01T00:00:00.000Z' }), createdAt: '2026-02-01T00:00:00.000Z' },
		]);
		pending = mod.countPendingInsightCandidatesDb(projDir);
		check('#2480 append via group-commit writer', pending === 3, `pending=${pending}`);
		const consumed = mod.consumeInsightCandidatesDb(projDir, 2);
		check(
			'#2480 consume takes the OLDEST batch in one txn',
			consumed.length === 2 && JSON.parse(consumed[0]).lesson === 'legacy one',
			`consumed=${consumed.length}, first=${consumed[0] && consumed[0].slice(0, 40)}`,
		);
		pending = mod.countPendingInsightCandidatesDb(projDir);
		check('#2480 consume marked its batch consumed', pending === 1, `pending=${pending}`);

		// Phase-report entity store: upsert + read-back + locator.
		await mod.upsertPhaseReportDb(projDir, 'curator_drift', 3, '{"phase":3,"alignment":"ALIGNED"}');
		await mod.upsertPhaseReportDb(projDir, 'design_doc_drift', 1, '{"verdict":"DOC_FRESH"}');
		const driftRows = mod.readPhaseReportsDb(projDir, 'curator_drift');
		check(
			'#2480 phase_report upsert + ordered read under Node',
			driftRows.length === 1 && driftRows[0].phase === 3 && JSON.parse(driftRows[0].payload).alignment === 'ALIGNED',
			`rows=${driftRows.length}`,
		);
		check(
			'#2480 phase-report locator form',
			mod.phaseReportLocator('curator_drift', 3) === 'swarm.db:phase_report(curator_drift,3)',
			'',
		);

		// quick_check + WAL checkpoint close path.
		const quick = db.query('PRAGMA quick_check').get();
		check('#2480 quick_check ok on the live foundation DB', quick && quick.quick_check === 'ok', JSON.stringify(quick));
		mod.closeGroupCommitWriter(projDir);
		mod.closeProjectDb(projDir);
		const reopened = mod.getProjectDb(projDir);
		check(
			'#2480 close→reopen round trip preserves durable rows',
			reopened.query('SELECT COUNT(*) AS n FROM insight_candidate WHERE consumed_at IS NULL').get().n === 1,
			'',
		);

		check(
			'global DB round-trip under Node',
			grow && grow.content === 'global-node-sqlite-works',
			`got ${JSON.stringify(grow)}`,
		);

		// ── Memory provider: init (FTS5 + iterate) → upsert → list → recall →
		//    delete → compactMaintenance (real transaction removing the row) ──
		const provider = new mod.SQLiteMemoryProvider(projDir);
		await provider.initialize();
		const scope = { type: 'workspace', workspaceId: 'repro-1873-ws' };
		const recA = makeRecord(mod, {
			kind: 'project_fact',
			scope,
			text: 'sqlite node portability fallback fix for electron sidecar',
		});
		const recB = makeRecord(mod, {
			kind: 'project_fact',
			scope,
			text: 'unrelated durable fact about build tooling',
		});
		await provider.upsert(recA);
		await provider.upsert(recB);

		const listed = await provider.list({ scopes: [scope] });
		check(
			'memory list() returns upserted records',
			listed.length === 2,
			`got ${listed.length}`,
		);

		// swarm_memory_recall's core path (the issue's headline tool) under Node.
		const recalled = await provider.recall({
			query: 'sqlite node portability fallback',
			scopes: [scope],
			kinds: ['project_fact'],
			maxItems: 5,
			tokenBudget: 2000,
		});
		check(
			'memory recall() returns the matching record under Node (lexical/FTS path)',
			Array.isArray(recalled) &&
				recalled.length >= 1 &&
				recalled.some((r) => (r.record ? r.record.id : r.id) === recA.id),
			`got ${Array.isArray(recalled) ? `${recalled.length} item(s)` : typeof recalled}`,
		);

		// Soft-delete A, then compact (a real BEGIN/COMMIT that DELETEs + FTS-deletes
		// + inserts an event under node:sqlite).
		await provider.delete(recA.id);
		const compacted = await provider.compactMaintenance({ dryRun: false });
		check(
			'memory compactMaintenance transaction removed the deleted row',
			compacted.removedDeleted >= 1,
			`removedDeleted=${compacted.removedDeleted}`,
		);
		const remaining = await provider.list({ scopes: [scope] });
		check(
			'memory list() reflects post-compaction state',
			remaining.length === 1 && remaining[0].id === recB.id,
			`got ${remaining.map((r) => r.id).join(',')}`,
		);
		provider.close();
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		failures.push(`uncaught: ${msg}`);
		console.error('[repro-1873] uncaught error:', err);
	} finally {
		try {
			mod.closeAllProjectDbs();
		} catch {}
		try {
			mod.closeGlobalDb();
		} catch {}
		rmSync(projDir, { recursive: true, force: true });
		rmSync(cfgHome, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		console.error(
			`\n[repro-1873] FAILED (${failures.length}): issue #1873 SQLite-under-Node is broken.\n  - ` +
				failures.join('\n  - '),
		);
		process.exit(1);
	}
	console.log('\n[repro-1873] PASS — SQLite works under Node via the node:sqlite adapter.');
}

main().catch((err) => {
	console.error('[repro-1873] uncaught:', err);
	process.exit(1);
});
