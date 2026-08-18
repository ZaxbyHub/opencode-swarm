/**
 * PR #2200 review-feedback hardening tests (swarm-pr-feedback closure).
 *
 * Covers: HMAC-bound tokens (CC-1/CC-5-forgery), duplicate-id-in-store refusal
 * (CC-8), tampered-manifest shape validation (PRR-007), realpath/symlink backup
 * escape with a FULLY VALID forged manifest+store (CC-4/CC-5), honest
 * compensation reporting (PRR-008/CC-6), prototype-key id safety through the
 * shared transaction write path (CC-9), orphaned-backup cleanup on abort
 * (CC-m3), and boundary ids (PRR-028 bundle).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
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
import { transactHiveStore } from '../../../src/hooks/hive-transaction.js';
import {
	resolveHiveDataDir,
	resolveHiveKnowledgePath,
} from '../../../src/knowledge/hive-paths.js';
import {
	_internals,
	commitHiveQuarantine,
	previewHiveQuarantine,
	rollbackHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let dataDir: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;

function platformHiveSubdir(): string {
	return process.platform === 'win32'
		? path.join('opencode-swarm', 'Data')
		: process.platform === 'darwin'
			? path.join('Library', 'Application Support', 'opencode-swarm')
			: 'opencode-swarm';
}

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
		source_project: 'hardening-project',
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

beforeEach(() => {
	dataDir = canonicalMkdtemp('hive-quarantine-hardening-');
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

describe('hive quarantine hardening (PR #2200 feedback)', () => {
	test('CC-1/CC-m5: a correctly-computed UNKEYED (forged) token is rejected', async () => {
		seedStore([
			hiveEntry('id-forg-0001', 'Forged token must never pass the commit gate'),
		]);
		// Ensure the per-install secret exists (created by any preview).
		await previewHiveQuarantine(['id-forg-0001']);
		const secret = await _internals.readQuarantineSecret();
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		// The attacker computes every payload field correctly from public store
		// data — but signs with the OLD unkeyed sha256 marker.
		const raw = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		const body = JSON.stringify({
			ids: ['id-forg-0001'],
			rawLineHashes: {
				'id-forg-0001': createHash('sha256')
					.update(`${raw.split('\n')[0]}\n`)
					.digest('hex'),
			},
			fileSha256: createHash('sha256').update(raw).digest('hex'),
			entryCount: 1,
			pluginVersion: JSON.parse(readFileSync('package.json', 'utf-8')).version,
			issuedAtMs: Date.now(),
		});
		const forged = `${Buffer.from(body).toString('base64url')}.${createHash(
			'sha256',
		)
			.update(body)
			.digest('hex')
			.slice(0, 32)}`;
		// Freeze the clock: the forged payload embeds Date.now(), and the
		// commit-side TTL check must see the same frozen instant (FR-011).
		const restore = freezeClock();
		let commit: Awaited<ReturnType<typeof commitHiveQuarantine>>;
		try {
			commit = await commitHiveQuarantine({ token: forged });
		} finally {
			restore();
		}
		expect(commit.ok).toBe(false);
		if (!commit.ok) expect(commit.code).toBe('invalid_token');
		// Store untouched.
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(raw);
	});

	test('CC-8: duplicate-id-in-store is refused at preview as ambiguous', async () => {
		seedStore([
			hiveEntry(
				'id-dup-0002',
				'Duplicate physical lines make identity ambiguous',
			),
			hiveEntry(
				'id-dup-0002',
				'Duplicate physical lines make identity ambiguous',
				{
					confidence: 0.1,
				},
			),
			hiveEntry('id-ok-0003', 'Unrelated entry remains selectable'),
		]);
		const result = await previewHiveQuarantine(['id-dup-0002']);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('duplicate_id_in_store');
			expect(result.error).toContain('id-dup-0002');
		}
		// The unambiguous id still works.
		const ok = await previewHiveQuarantine(['id-ok-0003']);
		expect(ok.ok).toBe(true);
	});

	test('PRR-007: tampered manifest shapes abort as backup_corrupt, never raw throws', async () => {
		seedStore([
			hiveEntry('id-tam-0004', 'Tampered manifest must abort structurally'),
		]);
		const backupDir = await commitIds(['id-tam-0004']);
		const manifestPath = path.join(backupDir, 'manifest.json');
		for (const tamper of [
			'{"ids": "not-an-array"}',
			'{"store": null}',
			'not json at all',
		]) {
			writeFileSync(manifestPath, tamper);
			const rollback = await rollbackHiveQuarantine({ ref: 'latest' });
			expect(rollback.ok).toBe(false);
			if (!rollback.ok) expect(rollback.code).toBe('backup_corrupt');
		}
	});

	test('CC-4/CC-5: symlinked backup dir with a FULLY VALID forged manifest+store is refused', async () => {
		// Build a self-consistent forged backup OUTSIDE the backups root: its
		// manifest hashes match its own store bytes, so hash validation alone
		// would pass — only the realpath containment can refuse it.
		seedStore([
			hiveEntry('id-sym-0005', 'Real entry that must remain untouched'),
		]);
		const outsideDir = canonicalMkdtemp('forged-backup-');
		try {
			const forgedLine = hiveEntry(
				'id-forged-evil',
				'Forged lesson merged in through a symlink escape',
			);
			const forgedStore = `${forgedLine}\n`;
			writeFileSync(
				path.join(outsideDir, 'shared-learnings.jsonl'),
				forgedStore,
			);
			const manifest = {
				schema_version: 1,
				plugin_version: 'x',
				token: 'x',
				token12: 'deadbeeefdec',
				issued_at: '2026-01-01T00:00:00.000Z',
				committed_at: '2026-01-01T00:00:00.000Z',
				reason: 'forged',
				ids: [
					{
						id: 'id-forged-evil',
						raw_line_sha256: createHash('sha256')
							.update(`${forgedLine}\n`)
							.digest('hex'),
					},
				],
				store: {
					entry_count: 1,
					file_sha256: createHash('sha256').update(forgedStore).digest('hex'),
				},
			};
			writeFileSync(
				path.join(outsideDir, 'manifest.json'),
				`${JSON.stringify(manifest, null, 2)}\n`,
			);
			const backupsRoot = path.join(resolveHiveDataDir(), 'quarantine-backups');
			mkdirSync(backupsRoot, { recursive: true });
			const linkName = '2099-01-01T00-00-00-000Z-deadbeeefdec';
			const linkPath = path.join(backupsRoot, linkName);
			try {
				symlinkSync(
					outsideDir,
					linkPath,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
			} catch {
				console.info(
					'[hardening] symlink unavailable on this host — realpath defense tested via shape only',
				);
				return;
			}
			const before = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
			const rollback = await rollbackHiveQuarantine({ ref: 'deadbeeefdec' });
			expect(rollback.ok).toBe(false);
			if (!rollback.ok) {
				expect(rollback.code).toBe('backup_corrupt');
				expect(rollback.error).toContain('symlink/reparse');
			}
			// The forged entry must NOT have been merged into the real store.
			expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toBe(before);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	test('PRR-008/CC-6: a FAILED automatic restore is reported as failed, never as success', async () => {
		seedStore([hiveEntry('id-hon-0006', 'Honest compensation reporting test')]);
		const preview = await previewHiveQuarantine(['id-hon-0006']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;

		// Force the post-commit count check to fire (simulate a concurrent
		// appender) while ALSO making the restore fail (tamper the manifest
		// after the commit transaction completes but before verification).
		const realTransact = _internals.transactHiveStore;
		(
			_internals as {
				transactHiveStore: typeof transactHiveStore;
			}
		).transactHiveStore = (async (mutate: never) => {
			const result = await realTransact(mutate as never);
			// Concurrent appender lands between lock release and verification.
			const fs = await import('node:fs/promises');
			await fs.appendFile(
				resolveHiveKnowledgePath(),
				`${hiveEntry('id-conc-0007', 'Concurrent append during verify window')}\n`,
			);
			// Tamper the manifest so the automatic restore aborts {ok:false}.
			const backupsRoot = path.join(resolveHiveDataDir(), 'quarantine-backups');
			const dir = readdirSync(backupsRoot)[0];
			writeFileSync(
				path.join(backupsRoot, dir, 'manifest.json'),
				'{"ids": "tampered"}',
			);
			return result;
		}) as typeof transactHiveStore;
		try {
			const commit = await commitHiveQuarantine({
				token: preview.preview.token,
			});
			expect(commit.ok).toBe(false);
			if (!commit.ok) {
				expect(commit.code).toBe('store_drift');
				expect(commit.error).toContain('automatic restore FAILED');
				expect(commit.error).toContain('rollback --token');
				expect(commit.error).not.toContain(
					'the backup was restored automatically',
				);
			}
		} finally {
			_internals.transactHiveStore = realTransact;
		}
	});

	test('CC-9: prototype-key ids survive the shared transaction write path byte-exactly', async () => {
		// The shared write path (any transactHiveStore caller — promotion,
		// curation) must not corrupt a legacy '__proto__'-id line when a caller
		// supplies raw line overrides via a Map.
		const protoLine = JSON.stringify({
			id: '__proto__',
			tier: 'hive',
			lesson: 'Legacy prototype-key entry preserved byte-exactly',
			category: 'process',
			tags: [],
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
		});
		seedStore([protoLine, hiveEntry('id-norm-0008', 'Normal sibling entry')]);
		const overrides = new Map<string, string>([['__proto__', protoLine]]);
		const txn = await transactHiveStore<null>(async (ctx) => ({
			kind: 'commit',
			entries: ctx.entries,
			rawLineOverrides: overrides,
			return: null,
		}));
		expect(txn.committed).toBe(true);
		const after = readFileSync(resolveHiveKnowledgePath(), 'utf-8');
		expect(after).toContain(protoLine);
		expect(after).not.toContain('[object Object]');
	});

	test('CC-9: preview/commit reject prototype-key ids outright', async () => {
		seedStore([hiveEntry('__proto__', 'Prototype id entry selectable? Never')]);
		for (const bad of ['__proto__', 'constructor', 'prototype']) {
			const result = await previewHiveQuarantine([bad]);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe('invalid_ids');
		}
	});

	test('CC-m3: a drift abort after backup creation cleans up the orphaned backup dir', async () => {
		seedStore([hiveEntry('id-orph-0009', 'Orphaned backup must be cleaned')]);
		const preview = await previewHiveQuarantine(['id-orph-0009']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		// Drift AFTER the backup is created but caught under the lock: wrap the
		// transaction seam so the concurrent append lands between backup creation
		// and the locked re-verification.
		const realTransact = _internals.transactHiveStore;
		(
			_internals as { transactHiveStore: typeof transactHiveStore }
		).transactHiveStore = (async (mutate: never) => {
			const fs = await import('node:fs/promises');
			await fs.appendFile(
				resolveHiveKnowledgePath(),
				`${hiveEntry('id-race-0010', 'Concurrent append under the lock window')}\n`,
			);
			return realTransact(mutate as never);
		}) as typeof transactHiveStore;
		let commit: { ok: boolean } = { ok: true };
		try {
			commit = await commitHiveQuarantine({ token: preview.preview.token });
		} finally {
			_internals.transactHiveStore = realTransact;
		}
		expect(commit.ok).toBe(false);
		const backupsRoot = path.join(resolveHiveDataDir(), 'quarantine-backups');
		const leftovers = readdirSync(backupsRoot).filter(
			(n) => !n.startsWith('.'),
		);
		expect(leftovers).toEqual([]);
	});

	test('PRR-028 bundle: MAX_IDS boundary (200 ok / 201 too_many_ids) and id length 64/65', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 201; i++) {
			lines.push(
				hiveEntry(
					`id-bnd-${String(i).padStart(4, '0')}`,
					`Boundary lesson ${i}`,
				),
			);
		}
		seedStore(lines);
		const atCap = await previewHiveQuarantine(
			lines.slice(0, 200).map((_, i) => `id-bnd-${String(i).padStart(4, '0')}`),
		);
		expect(atCap.ok).toBe(true);
		const overCap = await previewHiveQuarantine(
			lines.map((_, i) => `id-bnd-${String(i).padStart(4, '0')}`),
		);
		expect(overCap.ok).toBe(false);
		if (!overCap.ok) expect(overCap.code).toBe('too_many_ids');

		const len64 = 'a'.repeat(64);
		const len65 = 'a'.repeat(65);
		seedStore([hiveEntry(len64, 'Sixty-four character id is the maximum')]);
		const ok64 = await previewHiveQuarantine([len64]);
		expect(ok64.ok).toBe(true);
		const bad65 = await previewHiveQuarantine([len65]);
		expect(bad65.ok).toBe(false);
		if (!bad65.ok) expect(bad65.code).toBe('invalid_ids');
	});
});
