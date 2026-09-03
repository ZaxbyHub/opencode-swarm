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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
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
	// #2539: the memory-link cohort store resolves under the data dir
	// (LOCALAPPDATA on win32 / XDG_DATA_HOME on linux) — redirect it too so the
	// link/unlink scenario never touches real user directories.
	process.env.XDG_DATA_HOME = cfgHome;
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
		// ── #2480 stale-writer self-heal under the REAL node:sqlite driver ──
		// The pre-fix bug: /swarm close evicted the DB handle without closing
		// the cached group-commit writer, so post-close writes failed against
		// the dead handle ("database is not open" under node:sqlite). The
		// writer must rebind and complete the batch transparently.
		await mod.appendInsightCandidatesDb(projDir, [
			{
				payload: JSON.stringify({ lesson: 'stale-before-close' }),
				createdAt: '2026-01-01T00:00:00.000Z',
			},
		]);
		mod.closeProjectDb(projDir); // NOTE: writer intentionally NOT closed
		await mod.appendInsightCandidatesDb(projDir, [
			{
				payload: JSON.stringify({ lesson: 'stale-after-close' }),
				createdAt: '2026-01-02T00:00:00.000Z',
			},
		]);
		const staleWriterRows = mod
			.getProjectDb(projDir)
			.query(
				"SELECT COUNT(*) AS n FROM insight_candidate WHERE payload LIKE '%stale-before-close%' OR payload LIKE '%stale-after-close%'",
			)
			.get().n;
		check(
			'#2480 stale-writer self-heal under real node:sqlite (post-close write lands)',
			staleWriterRows === 2,
			`rows=${staleWriterRows}`,
		);

		mod.closeGroupCommitWriter(projDir);
		mod.closeProjectDb(projDir);
		const reopened = mod.getProjectDb(projDir);
		check(
			'#2480 close→reopen round trip preserves durable rows',
			reopened.query('SELECT COUNT(*) AS n FROM insight_candidate WHERE consumed_at IS NULL').get().n === 3, // 1 original + 2 stale-writer rows
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
		mod.clearPool();

		// ── #2539: /swarm memory link → unlink → re-link through the REGISTERED
		//    command path (executeSwarmCommand → COMMAND_REGISTRY) under the real
		//    node:sqlite driver. Pre-fix, the first ATTACH merge crashed with
		//    `Cannot read properties of undefined (reading 'changes')` because the
		//    adapter's no-bindings run() returned undefined where bun:sqlite
		//    returns a Changes object. ──
		const memLinkDir = mkdtempSync(join(tmpdir(), 'repro1873-memlink-'));
		try {
			mkdirSync(join(memLinkDir, '.opencode'), { recursive: true });
			writeFileSync(
				join(memLinkDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					memory: { enabled: true, link: { enabled: true } },
				}),
				'utf-8',
			);
			const scope2539 = { type: 'workspace', workspaceId: 'repro-2539-ws' };
			const runCmd = (tokens) =>
				mod.executeSwarmCommand({
					directory: memLinkDir,
					tokens,
					agents: {},
					sessionID: 'repro-2539',
				});

			// Seed two records into the LOCAL store (pre-link).
			const seed2539 = new mod.SQLiteMemoryProvider(memLinkDir);
			await seed2539.initialize();
			const recA2539 = makeRecord(mod, {
				kind: 'project_fact',
				scope: scope2539,
				text: '2539 seed record A for link unlink relink',
			});
			const recB2539 = makeRecord(mod, {
				kind: 'project_fact',
				scope: scope2539,
				text: '2539 seed record B for link unlink relink',
			});
			await seed2539.upsert(recA2539);
			await seed2539.upsert(recB2539);
			seed2539.close();
			mod.clearPool();

			const link1 = await runCmd(['memory', 'link', 'repro-2539-cohort']);
			check(
				'#2539 memory link via registered command path',
				// Exact success prefix from handleMemoryLinkCommand (review tf-04):
				// "Linked" alone would also match failure text that merely
				// mentions the word.
				link1.text.startsWith(
					'🔗 Linked this worktree\'s memory to shared cohort store "repro-2539-cohort"',
				) && !link1.text.includes('❌'),
				link1.text.slice(0, 160),
			);

			// The cohort store must resolve under the ISOLATED cfg home — never
			// the real user data dir. cfgHome only contains what this harness
			// wrote, so the walk is tiny.
			const cohortDbs = [];
			(function walk2539(dir) {
				for (const ent of readdirSync(dir, { withFileTypes: true })) {
					const p = join(dir, ent.name);
					if (ent.isDirectory()) walk2539(p);
					else if (ent.name === 'memory.db' && p.includes('repro-2539-cohort')) {
						cohortDbs.push(p);
					}
				}
			})(cfgHome);
			check(
				'#2539 cohort store resolves under the isolated config home',
				cohortDbs.length === 1,
				`found: ${cohortDbs.join(', ')}`,
			);

			// Seed a third record AFTER link — the provider follows the link
			// pointer, so it lands in the COHORT and the next merge has exactly
			// one new row for the local store to absorb (non-zero .changes).
			const cohortSeed = new mod.SQLiteMemoryProvider(memLinkDir);
			await cohortSeed.initialize();
			const recC2539 = makeRecord(mod, {
				kind: 'project_fact',
				scope: scope2539,
				text: '2539 seed record C added while linked',
			});
			await cohortSeed.upsert(recC2539);
			cohortSeed.close();
			mod.clearPool();

			// stageSqliteDb COPIES (never moves) the source DB, so the local
			// memory.db must still exist here — proving the unlink destination is
			// NON-EMPTY and the ATTACH-merge branch (the pre-fix crash path) is
			// the one taken, not the empty-destination rename.
			check(
				'#2539 local memory.db survived link (unlink destination is non-empty)',
				existsSync(join(memLinkDir, '.swarm', 'memory', 'memory.db')),
				'local memory.db missing — scenario no longer exercises the ATTACH merge',
			);

			const unlink1 = await runCmd(['memory', 'unlink']);
			check(
				'#2539 memory unlink via registered command path (ATTACH merge, non-empty local destination)',
				// Exact success prefix from handleMemoryUnlinkCommand (review tf-04).
				unlink1.text.startsWith('🔓 Unlinked memory.') &&
					!unlink1.text.includes('❌'),
				unlink1.text.slice(0, 200),
			);

			// Re-link: unlink never deletes the cohort store, so this merge also
			// takes the ATTACH branch with both sides non-empty.
			const link2 = await runCmd(['memory', 'link', 'repro-2539-cohort']);
			check(
				'#2539 memory re-link via registered command path (populated cohort)',
				link2.text.startsWith(
					'🔗 Linked this worktree\'s memory to shared cohort store "repro-2539-cohort"',
				) && !link2.text.includes('❌'),
				link2.text.slice(0, 200),
			);

			const verify2539 = new mod.SQLiteMemoryProvider(memLinkDir);
			await verify2539.initialize();
			const listed2539 = await verify2539.list({ scopes: [scope2539] });
			verify2539.close();
			mod.clearPool();
			const ids2539 = [recA2539.id, recB2539.id, recC2539.id];
			check(
				'#2539 all three records survive the link→unlink→re-link round trip',
				listed2539.length === 3 &&
					ids2539.every((id) => listed2539.some((r) => r.id === id)),
				`got ${listed2539.length}: ${listed2539.map((r) => r.id).join(',')}`,
			);

			// Review tf-05/mt-02: exercise the EMPTY-LOCAL unlink (the rename
			// branch) under the real node driver — the F-22 shape, which
			// previously only ran under Bun. The rename branch never reads
			// `.changes`, so this proves the registered command path also
			// succeeds when the local destination has no memory.db at all.
			rmSync(join(memLinkDir, '.swarm', 'memory', 'memory.db'), {
				force: true,
			});
			for (const suffix of ['-wal', '-shm']) {
				rmSync(join(memLinkDir, '.swarm', 'memory', `memory.db${suffix}`), {
					force: true,
				});
			}
			mod.clearPool();
			check(
				'#2539 empty-local precondition (local memory.db removed)',
				!existsSync(join(memLinkDir, '.swarm', 'memory', 'memory.db')),
				'local memory.db still present',
			);
			const unlink2 = await runCmd(['memory', 'unlink']);
			check(
				'#2539 empty-local unlink via registered command path (rename branch under node)',
				unlink2.text.startsWith('🔓 Unlinked memory.') &&
					!unlink2.text.includes('❌'),
				unlink2.text.slice(0, 200),
			);
			const verifyEmpty2539 = new mod.SQLiteMemoryProvider(memLinkDir);
			await verifyEmpty2539.initialize();
			const listedEmpty2539 = await verifyEmpty2539.list({
				scopes: [scope2539],
			});
			verifyEmpty2539.close();
			mod.clearPool();
			check(
				'#2539 empty-local unlink restored all three records from the cohort',
				listedEmpty2539.length === 3 &&
					ids2539.every((id) =>
						listedEmpty2539.some((r) => r.id === id),
					),
				`got ${listedEmpty2539.length}`,
			);
		} finally {
			rmSync(memLinkDir, { recursive: true, force: true });
		}
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
