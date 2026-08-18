/**
 * Issue #2033 — hive quarantine commit tests (adversarial).
 *
 * Covers: happy path (validated backup, exact removal, sidecar, audit, verify), drift
 * aborts (concurrent append / id changed / id missing / wrong root / version change /
 * token replay), backup-failure injection (no mutation), and duplicate-content distinct
 * ids. All stores live under redirected temp roots (tripwire-safe).
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	resolveHiveDataDir,
	resolveHiveEventsPath,
	resolveHiveKnowledgePath,
} from '../../../src/knowledge/hive-paths.js';
import {
	_internals,
	commitHiveQuarantine,
	previewHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let dataDir: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;
const realCopyFile = _internals.copyFile;

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

function platformHiveSubdir(): string {
	return process.platform === 'win32'
		? path.join('opencode-swarm', 'Data')
		: process.platform === 'darwin'
			? path.join('Library', 'Application Support', 'opencode-swarm')
			: 'opencode-swarm';
}

beforeEach(() => {
	dataDir = canonicalMkdtemp(`hive-quarantine-commit`);
	mkdirSync(path.join(dataDir, platformHiveSubdir()), { recursive: true });
	prevXdg = process.env.XDG_DATA_HOME;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.HOME = dataDir;
	process.env.LOCALAPPDATA = dataDir;
	_internals.copyFile = realCopyFile;
});

afterEach(() => {
	if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdg;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	_internals.copyFile = realCopyFile;
	rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
	_internals.copyFile = realCopyFile;
});

/**
 * Mints an HMAC-signed token exactly as production does (via the module's
 * secret seam). `unkeyed` forges the PRE-HARDENING shape (plain sha256 marker)
 * to prove such tokens are now rejected (PR review CC-1/CC-m5).
 */
async function forgeToken(
	overrides: Record<string, unknown>,
	unkeyed = false,
): Promise<string> {
	const body = JSON.stringify(overrides);
	const secret = await _internals.readQuarantineSecret();
	const marker = unkeyed
		? createHash('sha256').update(body, 'utf-8').digest('hex').slice(0, 32)
		: createHmac('sha256', secret)
				.update(body, 'utf-8')
				.digest('hex')
				.slice(0, 32);
	return `${Buffer.from(body, 'utf-8').toString('base64url')}.${marker}`;
}

describe('hive quarantine commit (issue #2033)', () => {
	test('happy path: backup verified, exact removal, sidecar, audit, post-verify', async () => {
		seedStore([
			hiveEntry(
				'id-keep-0001',
				'Legitimate lesson that must survive quarantine',
			),
			hiveEntry(
				'id-leak-0002',
				'Test lesson for path verification with sufficient length',
			),
		]);
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		const preview = await previewHiveQuarantine(['id-leak-0002']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;

		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(true);
		if (!commit.ok) return;
		expect(commit.result.quarantinedIds).toEqual(['id-leak-0002']);
		expect(commit.result.storeEntriesBefore).toBe(2);
		expect(commit.result.storeEntriesAfter).toBe(1);
		expect(commit.result.verified).toBe(true);

		const after = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		expect(after).toContain('id-keep-0001');
		expect(after).not.toContain('id-leak-0002');

		// Backup: byte-identical copy + manifest with per-id hashes + store fingerprint.
		const backupPath = path.join(
			commit.result.backupDir,
			'shared-learnings.jsonl',
		);
		expect(readFileSync(backupPath, 'utf-8')).toBe(before);
		const manifest = JSON.parse(
			readFileSync(
				path.join(commit.result.backupDir, 'manifest.json'),
				'utf-8',
			),
		);
		expect(manifest.ids).toEqual([
			{
				id: 'id-leak-0002',
				raw_line_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		]);
		expect(manifest.store.entry_count).toBe(2);

		// Sidecar: original entry + quarantine metadata, no active status field.
		const sidecar = readFileSync(
			path.join(resolveHiveDataDir(), 'shared-learnings-quarantined.jsonl'),
			'utf-8',
		);
		expect(sidecar).toContain('id-leak-0002');
		const sidecarEntry = JSON.parse(sidecar.trim());
		expect(sidecarEntry.original_status).toBe('promoted');
		expect(sidecarEntry.status).toBeUndefined();
		expect(sidecarEntry.quarantine_reason).toBeTruthy();

		// Hive audit log: quarantined record with previous status.
		const events = readFileSync(resolveHiveEventsPath(), 'utf-8');
		expect(events).toContain('"type":"quarantined"');
		expect(events).toContain('id-leak-0002');
	});

	test('concurrent append between preview and commit aborts without mutation', async () => {
		seedStore([
			hiveEntry('id-base-0003', 'Base lesson present at preview time'),
		]);
		const preview = await previewHiveQuarantine(['id-base-0003']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		// Concurrent append (another writer won the race).
		const fs = await import('node:fs/promises');
		await fs.appendFile(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-race-0004', 'Concurrent writer appended this entry')}\n`,
		);
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(false);
		if (!commit.ok) expect(commit.code).toBe('store_drift');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(before);
	});

	test('selected entry changed after preview aborts with id_changed', async () => {
		seedStore([
			hiveEntry('id-chg-0005', 'Entry that mutates between preview and commit'),
		]);
		const preview = await previewHiveQuarantine(['id-chg-0005']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		// Curation bumped the confidence.
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry(
				'id-chg-0005',
				'Entry that mutates between preview and commit',
				{
					confidence: 0.5,
				},
			)}\n`,
		);
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(false);
		if (!commit.ok) expect(commit.code).toBe('id_changed');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toContain(
			'id-chg-0005',
		);
	});

	test('selected entry removed after preview aborts with id_missing', async () => {
		seedStore([
			hiveEntry('id-gone-0006', 'Entry deleted between preview and commit'),
			hiveEntry('id-stay-0007', 'Unrelated entry that stays'),
		]);
		const preview = await previewHiveQuarantine(['id-gone-0006']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-stay-0007', 'Unrelated entry that stays')}\n`,
		);
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(false);
		// The selected entry's absence is the precise diagnostic (per-id check first).
		if (!commit.ok) expect(commit.code).toBe('id_missing');
	});

	test('expired token aborts', async () => {
		seedStore([
			hiveEntry('id-exp-0008', 'Expired token must not authorize mutation'),
		]);
		const stale = await forgeToken({
			ids: ['id-exp-0008'],
			rawLineHashes: { 'id-exp-0008': '0'.repeat(64) },
			fileSha256: '0'.repeat(64),
			entryCount: 1,
			pluginVersion: '0.0.0-test',
			issuedAtMs: Date.now() - 30 * 60 * 1000,
		});
		const commit = await commitHiveQuarantine({ token: stale });
		expect(commit.ok).toBe(false);
		if (!commit.ok) expect(commit.code).toBe('token_expired');
	});

	test('wrong platform root: token from store A cannot mutate store B', async () => {
		seedStore([
			hiveEntry('id-wrf-0009', 'Wrong-root token must fail fingerprint check'),
		]);
		const preview = await previewHiveQuarantine(['id-wrf-0009']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		// Redirect to a DIFFERENT root holding a different store.
		const otherDir = canonicalMkdtemp('hive-quarantine-other-');
		mkdirSync(path.join(otherDir, platformHiveSubdir()), {
			recursive: true,
		});
		writeFileSync(
			path.join(otherDir, platformHiveSubdir(), 'shared-learnings.jsonl'),
			`${hiveEntry(
				'id-wrf-0009',
				'Wrong-root token must fail fingerprint check',
				{
					confidence: 0.1,
				},
			)}\n`,
		);
		process.env.XDG_DATA_HOME = otherDir;
		process.env.HOME = otherDir;
		process.env.LOCALAPPDATA = otherDir;
		try {
			const commit = await commitHiveQuarantine({
				token: preview.preview.token,
			});
			expect(commit.ok).toBe(false);
			// With HMAC-bound tokens, a token minted under store A's secret fails
			// decode under store B's secret (invalid_token) — an even earlier
			// abort; the legacy drift checks remain as backstop.
			if (!commit.ok)
				expect(['id_changed', 'store_drift', 'invalid_token']).toContain(
					commit.code,
				);
		} finally {
			process.env.XDG_DATA_HOME = dataDir;
			process.env.HOME = dataDir;
			process.env.LOCALAPPDATA = dataDir;
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	test('backup failure injection aborts without any mutation', async () => {
		seedStore([
			hiveEntry('id-bkf-0010', 'Backup failure must abort the whole commit'),
		]);
		const preview = await previewHiveQuarantine(['id-bkf-0010']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		_internals.copyFile = (async () => {
			throw new Error('ENOSPC: disk full (injected)');
		}) as typeof realCopyFile;
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(false);
		if (!commit.ok) expect(commit.code).toBe('backup_failed');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(before);
		// No sidecar record for an aborted commit.
		const fs = await import('node:fs/promises');
		await expect(
			fs.readFile(
				path.join(resolveHiveDataDir(), 'shared-learnings-quarantined.jsonl'),
				'utf-8',
			),
		).rejects.toThrow();
	});

	test('replayed token after a successful commit aborts', async () => {
		seedStore([hiveEntry('id-rep-0011', 'Replay of a used token must abort')]);
		const preview = await previewHiveQuarantine(['id-rep-0011']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const first = await commitHiveQuarantine({ token: preview.preview.token });
		expect(first.ok).toBe(true);
		const second = await commitHiveQuarantine({ token: preview.preview.token });
		expect(second.ok).toBe(false);
		if (!second.ok)
			expect(['id_missing', 'store_drift']).toContain(second.code);
	});

	test('duplicate-content distinct ids: quarantining one leaves the other', async () => {
		seedStore([
			hiveEntry('id-dcA-0012', 'Same lesson text in two different entries'),
			hiveEntry('id-dcB-0013', 'Same lesson text in two different entries'),
		]);
		const preview = await previewHiveQuarantine(['id-dcA-0012']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(true);
		const after = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		expect(after).toContain('id-dcB-0013');
		expect(after).not.toContain('id-dcA-0012');
	});

	test('version mismatch between preview and commit aborts (version_changed)', async () => {
		seedStore([
			hiveEntry('id-ver-0014', 'Version-bumped plugin must invalidate tokens'),
		]);
		// Frozen clock spanning the await: issuedAtMs is exactly "now", so the TTL
		// gate passes and the version gate is what fires.
		const restore = freezeClock({ fixedNow: 1_780_000_000_000 });
		try {
			const commit = await commitHiveQuarantine({
				token: await forgeToken({
					ids: ['id-ver-0014'],
					rawLineHashes: { 'id-ver-0014': '0'.repeat(64) },
					fileSha256: '0'.repeat(64),
					entryCount: 1,
					pluginVersion: '0.0.0-other-version',
					issuedAtMs: Date.now(),
				}),
			});
			expect(commit.ok).toBe(false);
			if (!commit.ok) expect(commit.code).toBe('version_changed');
		} finally {
			restore();
		}
	});

	test('corrupt lines are dropped by the commit rewrite but preserved in the backup (disclosed behavior)', async () => {
		// Final-critic finding 1: the standing transaction pipeline drops unparseable
		// lines on rewrite. This test PINS the disclosure — the corrupt line leaves the
		// live store but survives byte-exactly in the hash-verified backup copy.
		const validLine = hiveEntry(
			'id-cor2-0015',
			'Valid entry quarantined alongside a corrupt line',
		);
		const corruptLine = '{"id":"id-corrupt-9999","lesson": broken json';
		const fs = await import('node:fs/promises');
		const storePath = resolveHiveKnowledgePath();
		await fs.writeFile(storePath, `${validLine}\n${corruptLine}\n`, 'utf-8');
		const before = await fs.readFile(storePath, 'utf-8');

		const preview = await previewHiveQuarantine(['id-cor2-0015']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(true);
		if (!commit.ok) return;

		const after = await fs.readFile(storePath, 'utf-8');
		expect(after).not.toContain('id-corrupt-9999');
		const backup = await fs.readFile(
			path.join(commit.result.backupDir, 'shared-learnings.jsonl'),
			'utf-8',
		);
		expect(backup).toBe(before);
		expect(backup).toContain('id-corrupt-9999');
	});
});
