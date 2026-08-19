/**
 * Issue #2033 — hive quarantine rollback tests (adversarial).
 *
 * Covers: byte-exact restore with hash verification, idempotent replay, collision abort
 * (id re-promoted with different content), corrupt backup / manifest mismatch / missing /
 * ambiguous refs, and a junction-escape defense (Windows junction; skipped where symlinks
 * are unavailable).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	resolveHiveDataDir,
	resolveHiveKnowledgePath,
} from '../../../src/knowledge/hive-paths.js';
import {
	commitHiveQuarantine,
	previewHiveQuarantine,
	rollbackHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let dataDir: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;

function hiveEntry(
	id: string,
	lesson: string,
	extra: Record<string, unknown> = {},
) {
	return JSON.stringify({
		id,
		tier: 'hive',
		lesson,
		category: 'process',
		tags: ['predicate'],
		scope: 'global',
		confidence: 0.9,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		created_at: '2026-07-14T18:21:35.833Z',
		updated_at: '2026-07-14T18:21:35.833Z',
		source_project: 'fixture-project',
		...extra,
	});
}

function seedStore(lines: string[]): void {
	const p = resolveHiveKnowledgePath();
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

async function commitIds(ids: string[]): Promise<string> {
	const preview = await previewHiveQuarantine(ids);
	expect(preview.ok).toBe(true);
	if (!preview.ok) throw new Error('preview failed');
	const commit = await commitHiveQuarantine({ token: preview.preview.token });
	expect(commit.ok).toBe(true);
	if (!commit.ok) throw new Error('commit failed');
	return commit.result.backupDir;
}

function backupRoot(): string {
	return path.join(resolveHiveDataDir(), 'quarantine-backups');
}

function platformHiveSubdir(): string {
	return process.platform === 'win32'
		? path.join('opencode-swarm', 'Data')
		: process.platform === 'darwin'
			? path.join('Library', 'Application Support', 'opencode-swarm')
			: 'opencode-swarm';
}

beforeEach(() => {
	dataDir = canonicalMkdtemp(`hive-quarantine-rollback`);
	mkdirSync(path.join(dataDir, platformHiveSubdir()), { recursive: true });
	prevXdg = process.env.XDG_DATA_HOME;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.HOME = dataDir;
	process.env.LOCALAPPDATA = dataDir;
});

afterEach(() => {
	if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdg;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	rmSync(dataDir, { recursive: true, force: true });
});

describe('hive quarantine rollback (issue #2033)', () => {
	test('restores byte-exact original lines and cleans the sidecar', async () => {
		seedStore([
			hiveEntry('id-rb-0001', 'Lesson restored byte-exactly from the backup'),
			hiveEntry('id-oth-0002', 'Unrelated entry untouched by rollback'),
		]);
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		await commitIds(['id-rb-0001']);

		const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(rollback.ok).toBe(true);
		if (!rollback.ok) return;
		expect(rollback.result.restoredIds).toEqual(['id-rb-0001']);
		expect(rollback.result.verified).toBe(true);

		const after = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		// The restored entry's line is byte-identical to the original (raw-line restore);
		// unrelated entries may be re-serialized by transactHiveStore's normalize-on-write
		// (pre-existing behavior of every hive writer), so compare per-id lines and the
		// id SET, not whole-file bytes.
		const lineOf = (raw: string, id: string): string | undefined =>
			raw
				.split('\n')
				.filter((l) => l.includes(`"id":"${id}"`))
				.at(0);
		expect(lineOf(after, 'id-rb-0001')).toBe(lineOf(before, 'id-rb-0001'));
		const idsBefore = before
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => (JSON.parse(l) as { id: string }).id)
			.sort();
		const idsAfter = after
			.split('\n')
			.filter((l) => l.trim())
			.map((l) => (JSON.parse(l) as { id: string }).id)
			.sort();
		expect(idsAfter).toEqual(idsBefore);
		// Sidecar no longer lists the restored id.
		const sidecarPath = path.join(
			resolveHiveDataDir(),
			'shared-learnings-quarantined.jsonl',
		);
		expect(readFileSync(sidecarPath, 'utf-8')).not.toContain('id-rb-0001');
	});

	test('second rollback is an idempotent no-op', async () => {
		seedStore([hiveEntry('id-rb2-0003', 'Idempotent rollback replays safely')]);
		await commitIds(['id-rb2-0003']);
		const first = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(first.ok).toBe(true);
		const second = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.result.restoredIds).toEqual([]);
		expect(second.result.alreadyPresentIds).toEqual(['id-rb2-0003']);
	});

	test('collision: id re-promoted with different content aborts without mutation', async () => {
		seedStore([
			hiveEntry('id-col-0004', 'Original lesson later re-promoted differently'),
		]);
		await commitIds(['id-col-0004']);
		// A different entry with the same id re-enters the store.
		seedStore([
			hiveEntry('id-col-0004', 'Re-promoted with different lesson text'),
		]);
		const mutated = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(rollback.ok).toBe(false);
		if (!rollback.ok) expect(rollback.code).toBe('rollback_collision');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(mutated);
	});

	test('corrupt backup file aborts with backup_corrupt', async () => {
		seedStore([
			hiveEntry('id-cor-0005', 'Corrupt backup must refuse rollback'),
		]);
		const backupDir = await commitIds(['id-cor-0005']);
		writeFileSync(
			path.join(backupDir, 'shared-learnings.jsonl'),
			'{"tampered":true}\n',
		);
		const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(rollback.ok).toBe(false);
		if (!rollback.ok) expect(rollback.code).toBe('backup_corrupt');
	});

	test('manifest hash mismatch aborts with backup_corrupt', async () => {
		seedStore([
			hiveEntry('id-man-0006', 'Manifest mismatch must refuse rollback'),
		]);
		const backupDir = await commitIds(['id-man-0006']);
		const manifestPath = path.join(backupDir, 'manifest.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
		manifest.store.file_sha256 = '0'.repeat(64);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(rollback.ok).toBe(false);
		if (!rollback.ok) expect(rollback.code).toBe('backup_corrupt');
	});

	test('unknown and malformed refs abort', async () => {
		seedStore([hiveEntry('id-ref-0007', 'Unknown backup reference')]);
		await commitIds(['id-ref-0007']);
		const unknown = await rollbackHiveQuarantine({ ref: 'ffffffffffff' });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.code).toBe('backup_not_found');
		const malformed = await rollbackHiveQuarantine({
			ref: '../escape/attempt',
		});
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.code).toBe('invalid_token');
	});

	test('ambiguous token12 suffix aborts with ambiguous_backup', async () => {
		seedStore([hiveEntry('id-amb-0008', 'Ambiguity must abort, not guess')]);
		const backupDir = await commitIds(['id-amb-0008']);
		const duplicate = path.join(
			backupRoot(),
			`2099-01-01T00-00-00-000Z-${path.basename(backupDir).split('-').pop()}`,
		);
		mkdirSync(duplicate, { recursive: true });
		const rollback = await rollbackHiveQuarantine({
			ref: path.basename(backupDir).split('-').pop() ?? '',
		});
		expect(rollback.ok).toBe(false);
		if (!rollback.ok) expect(rollback.code).toBe('ambiguous_backup');
	});

	test('junction/reparse escape inside the backups root is refused', async () => {
		let linkCreated = false;
		const outsideDir = canonicalMkdtemp('rb-outside-');
		mkdirSync(outsideDir, { recursive: true });
		try {
			const junctionName = `2099-01-02T00-00-00-000Z-deadbeeefdec`;
			const junctionPath = path.join(backupRoot(), junctionName);
			const type = process.platform === 'win32' ? 'junction' : 'dir';
			try {
				symlinkSync(outsideDir, junctionPath, type);
				linkCreated = true;
			} catch {
				linkCreated = false;
			}
			if (!linkCreated) {
				console.info(
					'[rollback-test] symlink unavailable on this host — skipping',
				);
				return;
			}
			const rollback = await rollbackHiveQuarantine({ ref: 'deadbeeefdec' });
			// The junction has no manifest — corrupt/missing either way, never followed out.
			expect(rollback.ok).toBe(false);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	test('rollback by token12 selects the new suffixed backup format (critic item 3)', async () => {
		// Producer names are <ts>-<token12>-<random8>; the token12 ref must match
		// the -<token12>- segment, not the trailing random suffix.
		seedStore([
			hiveEntry('id-suf-0011', 'Suffixed backup selected by token12 ref'),
		]);
		const backupDir = await commitIds(['id-suf-0011']);
		const name = path.basename(backupDir);
		expect(name).toMatch(/-[0-9a-f]{12}-[0-9a-f]{8}$/);
		const token12 = name.split('-').slice(-3, -2)[0];
		const rollback = await rollbackHiveQuarantine({ ref: token12 });
		expect(rollback.ok).toBe(true);
		if (!rollback.ok) return;
		expect(rollback.result.restoredIds).toEqual(['id-suf-0011']);
		expect(rollback.result.verified).toBe(true);
	});

	test('audit log records the rollback', async () => {
		seedStore([hiveEntry('id-aud-0009', 'Rollback writes an audit record')]);
		await commitIds(['id-aud-0009']);
		await rollbackHiveQuarantine({ ref: 'latest' });
		const eventsPath = path.join(
			resolveHiveDataDir(),
			'shared-knowledge-events.jsonl',
		);
		const events = readFileSync(eventsPath, 'utf-8');
		expect(events).toContain('"type":"quarantined"');
		expect(events).toContain('"type":"rollback"');
		expect(readdirSync(backupRoot())).toHaveLength(1);
	});

	test('legacy v1-shaped entry restores byte-exactly (verified) — reviewer finding 1/2', async () => {
		// A v1-shaped hive line: no encounter_score, no recent_negative_phase_count,
		// legacy-only retrieval counters, schema_version 1 — exactly the legacy-polluted
		// population this feature remediates. Before rawLineOverrides, the transaction's
		// normalize-on-read pipeline re-serialized the restore and hash verification
		// failed while the command still reported success.
		const legacyLine = JSON.stringify({
			id: 'id-leg-0010',
			tier: 'hive',
			lesson: 'Legacy v1-shaped lesson lacking normalization fields',
			category: 'process',
			tags: ['predicate'],
			scope: 'global',
			confidence: 0.9,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
			source_project: 'legacy-project',
		});
		seedStore([legacyLine]);
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		await commitIds(['id-leg-0010']);

		const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
		expect(rollback.ok).toBe(true);
		if (!rollback.ok) return;
		expect(rollback.result.verified).toBe(true);
		// The restored line is byte-identical to the original v1-shaped line.
		const after = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		expect(after.trim()).toBe(before.trim());
	});

	test('staged sidecar append failure after the store rewrite auto-restores — reviewer finding 3', async () => {
		seedStore([
			hiveEntry(
				'id-stg-0011',
				'Sidecar append failure must compensate from backup',
			),
		]);
		const preview = await previewHiveQuarantine(['id-stg-0011']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');

		const { _internals: txnInternals } = await import(
			'../../../src/hooks/hive-transaction.js'
		);
		const realAppend = txnInternals.appendFile;
		const sidecarSuffix = 'shared-learnings-quarantined.jsonl';
		txnInternals.appendFile = (async (p: string | URL) => {
			if (String(p).endsWith(sidecarSuffix)) {
				throw new Error('EPERM: file locked by antivirus (injected)');
			}
			return realAppend(p as string, '', 'utf-8');
		}) as typeof realAppend;
		try {
			const commit = await commitHiveQuarantine({
				token: preview.preview.token,
			});
			expect(commit.ok).toBe(false);
			if (!commit.ok) {
				expect(commit.code).toBe('transaction_failed');
				expect(commit.error).toContain('restored automatically');
			}
			// The store was restored to its pre-mutation bytes.
			expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(before);
		} finally {
			txnInternals.appendFile = realAppend;
		}
	});
});
