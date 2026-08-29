/**
 * Issue #2042 — legacy JSONL → checkpoint migration: v1 back-compat fold,
 * corrupt-but-active-record safety, read-bootstrap convergence, growth during
 * migration, downgrade/recreate handling, archiving, and archive TTL cleanup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getPrSubscriptionHealth,
	listActive,
	lookupByPr,
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_FILE,
	type PrSubscriptionCheckpoint,
	type PrSubscriptionRecord,
	subscribe,
	sweepStale,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-mig-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
	return dir;
}

function legacyPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
}

function checkpointPath(dir: string): string {
	return path.join(
		dir,
		'.swarm',
		'pr-monitor',
		'subscriptions.checkpoint.json',
	);
}

function archivePath(dir: string): string {
	return path.join(dir, '.swarm', 'pr-monitor', 'subscriptions.legacy.jsonl');
}

function record(
	sessionID: string,
	prNumber: number,
	updatedAt: number,
	repo = 'o/r',
): PrSubscriptionRecord {
	return {
		correlationId: `${sessionID}::${repo}::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: repo,
		prUrl: `https://github.com/${repo}/pull/${prNumber}`,
		lastCheckedAt: updatedAt,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: updatedAt,
		updatedAt,
		errorCount: 0,
	};
}

function writeLegacy(dir: string, records: PrSubscriptionRecord[]): void {
	fs.writeFileSync(
		legacyPath(dir),
		records.map((r) => `${JSON.stringify(r)}\n`).join(''),
		'utf-8',
	);
}

describe('pr-subscriptions legacy migration', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('legacy-only fold: v1 log is read with last-line-wins semantics', async () => {
		// Frozen clock: the seeded records' relative timestamps stay stable
		// across the fold (deterministic last-write-wins ordering).
		const restore = freezeClock();
		try {
			const now = Date.now();
			const first = record('sess_1', 1, now - 5000);
			const second = { ...record('sess_1', 1, now), errorCount: 3 };
			writeLegacy(dir, [first, second, record('sess_2', 2, now)]);

			const active = await listActive(dir);
			expect(active).toHaveLength(2);
			const r1 = active.find((r) => r.correlationId === 'sess_1::o/r::1');
			expect(r1?.errorCount).toBe(3); // later line wins
		} finally {
			restore();
		}
	});

	test('read-bootstrap: first listActive persists the checkpoint (read-only installs converge)', async () => {
		const now = Date.now();
		writeLegacy(dir, [record('sess_1', 1, now)]);
		expect(fs.existsSync(checkpointPath(dir))).toBe(false);

		const active = await listActive(dir);
		expect(active).toHaveLength(1);
		// The bootstrap persisted a completed migration.
		expect(fs.existsSync(checkpointPath(dir))).toBe(true);
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.migration?.done).toBe(true);
		expect(cp.rootPath).toBe(path.resolve(dir));
		expect(Object.keys(cp.records)).toHaveLength(1);
		// The legacy file is untouched by the read.
		expect(fs.existsSync(legacyPath(dir))).toBe(true);

		// Subsequent reads come from the checkpoint with no overlay work.
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('checkpoint');
		expect(health.activeCount).toBe(1);
	});

	test('corrupt-but-active-record safety: valid active records are never silently dropped', async () => {
		const now = Date.now();
		const good = record('sess_good', 1, now);
		fs.writeFileSync(
			legacyPath(dir),
			[
				`${JSON.stringify(good)}\n`,
				'{INVALID JSON\n',
				'not-json-at-all\n',
				'\n',
				'{"correlationId":"sess_trunc::o/r::99","sessionID":"sess_trunc","prNumb\n',
				// Identity mismatch: key does not compose from its parts.
				`${JSON.stringify({ ...record('sess_bad', 7, now), correlationId: 'other::key::1' })}\n`,
			].join(''),
			'utf-8',
		);

		const active = await listActive(dir);
		expect(active).toHaveLength(1);
		expect(active[0].sessionID).toBe('sess_good');

		// Corrupt lines are counted, not silent — four here: two malformed, one
		// truncated, one identity-mismatched.
		const health = await getPrSubscriptionHealth(dir);
		expect(health.corruptLegacyRecords).toBe(4);

		// The corrupt count survives migration into the checkpoint.
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.maintenance.corruptLegacyRecords).toBeGreaterThanOrEqual(4);
	});

	test('migration completes on the first write op and archives the stable legacy log', async () => {
		const now = Date.now();
		const recs = [record('sess_1', 1, now), record('sess_2', 2, now - 1)];
		writeLegacy(dir, recs);
		const originalContent = fs.readFileSync(legacyPath(dir), 'utf-8');

		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });

		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.migration?.done).toBe(true);
		expect(cp.migration?.archived).toBe(true);
		expect(cp.records['sess_1::o/r::1'].errorCount).toBe(1);
		expect(cp.records['sess_2::o/r::2']).toBeDefined();
		// The legacy log was archived (not deleted) with bytes intact.
		expect(fs.existsSync(legacyPath(dir))).toBe(false);
		expect(fs.readFileSync(archivePath(dir), 'utf-8')).toBe(originalContent);
	});

	test('archive mtime is stamped fresh so the 7-day TTL counts from creation, not last write', async () => {
		// An IDLE legacy log (last written long ago) must not have its archive
		// instantly past the TTL: renameSync preserves mtime, so the store
		// re-stamps the archive on creation.
		const old = Date.now() - 30 * 86_400_000;
		const stale = record('sess_old', 1, old);
		writeLegacy(dir, [stale]);
		const aged = (Date.now() - 20 * 86_400_000) / 1000;
		fs.utimesSync(legacyPath(dir), aged, aged);

		await updateSnapshot(dir, 'sess_old::o/r::1', { errorCount: 0 });

		expect(fs.existsSync(legacyPath(dir))).toBe(false);
		expect(fs.existsSync(archivePath(dir))).toBe(true);
		const archiveAge = Date.now() - fs.statSync(archivePath(dir)).mtimeMs;
		expect(archiveAge).toBeLessThan(60_000); // freshly stamped
		// And the TTL cleanup must NOT have deleted it in the same op.
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.migration?.archived).toBe(true);
	});

	test('growth during migration: appended tail records are visible and absorbed', async () => {
		const now = Date.now();
		const prefix = record('sess_1', 1, now - 5000);
		writeLegacy(dir, [prefix]);

		// Craft a half-migrated checkpoint: prefix folded, cursor at EOF of the
		// current file — then an external writer appends a NEWER record.
		const cp: PrSubscriptionCheckpoint = {
			schemaVersion: 1,
			sequence: 1,
			rootPath: path.resolve(dir),
			updatedAt: now,
			records: { [prefix.correlationId]: prefix },
			terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
			migration: {
				scannedBytes: fs.statSync(legacyPath(dir)).size,
				sourceBytes: fs.statSync(legacyPath(dir)).size,
				sourceMtimeMs: fs.statSync(legacyPath(dir)).mtimeMs,
				corruptLines: 0,
				done: false,
				archived: false,
				startedAt: now,
			},
			maintenance: {
				compactions: 0,
				droppedAuditTransitions: 0,
				corruptLegacyRecords: 0,
				lastCompactedAt: null,
				resets: 0,
			},
		};
		fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');

		const appended = record('sess_2', 9, now); // NEWER than prefix
		fs.appendFileSync(
			legacyPath(dir),
			`${JSON.stringify(appended)}\n`,
			'utf-8',
		);

		// Read sees checkpoint + pending tail overlay.
		const active = await listActive(dir);
		expect(active).toHaveLength(2);
		expect(active.some((r) => r.correlationId === 'sess_2::o/r::9')).toBe(true);

		// The next write absorbs the tail so later reads need no overlay.
		await updateSnapshot(dir, 'sess_2::o/r::9', { errorCount: 2 });
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('checkpoint');
		expect(health.activeCount).toBe(2);
	});

	test('downgrade path: a recreated legacy file is re-folded (newer and tied appends win)', async () => {
		const now = Date.now();
		writeLegacy(dir, [record('sess_1', 1, now)]);
		// First write op migrates + archives.
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });
		expect(fs.existsSync(archivePath(dir))).toBe(true);

		// A downgraded v1 writer recreates the log with a NEWER snapshot...
		const newer = { ...record('sess_1', 1, now + 60_000), errorCount: 9 };
		fs.writeFileSync(legacyPath(dir), `${JSON.stringify(newer)}\n`, 'utf-8');

		let active = await listActive(dir);
		expect(active[0].errorCount).toBe(9); // greater updatedAt wins

		// ...and with a TIED updatedAt the appended (later-positioned) line wins.
		const tied = { ...record('sess_1', 1, newer.updatedAt), errorCount: 77 };
		fs.writeFileSync(legacyPath(dir), `${JSON.stringify(tied)}\n`, 'utf-8');
		active = await listActive(dir);
		expect(active[0].errorCount).toBe(77);

		// A write op absorbs the recreation and archives it again.
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 5 });
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.migration?.archived).toBe(true);
		expect(cp.records['sess_1::o/r::1'].errorCount).toBe(5);
	});

	test('sweep over a legacy store: expired history reduces to the bounded checkpoint', async () => {
		const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
		const stale = record('sess_1', 1, tenDaysAgo);
		writeLegacy(dir, [stale]);

		const swept = await sweepStale(dir, 7);
		expect(swept).toBe(1);

		const active = await listActive(dir);
		expect(active).toHaveLength(0);
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.records['sess_1::o/r::1'].status).toBe('expired');
		// The legacy file no longer accumulates history.
		expect(cp.migration?.done).toBe(true);
	});

	test('archive TTL cleanup removes the stale legacy archive', async () => {
		writeLegacy(dir, [record('sess_1', 1, Date.now())]);
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 0 });
		expect(fs.existsSync(archivePath(dir))).toBe(true);

		// Age the archive beyond the TTL.
		const old = Date.now() - (PR_SUBSCRIPTION_LIMITS.legacyArchiveTtlMs + 1000);
		fs.utimesSync(archivePath(dir), old / 1000, old / 1000);

		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });
		expect(fs.existsSync(archivePath(dir))).toBe(false);
	});

	test('a changed legacy source whose records lose to the checkpoint stops re-folding after the next write', async () => {
		const now = Date.now();
		writeLegacy(dir, [record('sess_1', 1, now)]);
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });
		// Migration done + archived.
		expect(fs.existsSync(archivePath(dir))).toBe(true);

		// Recreate the legacy file with an OLDER snapshot (loses the merge)
		// and garbage lines — a poisoned source that previously re-folded on
		// every read forever.
		const loser = record('sess_1', 1, now - 60_000);
		fs.writeFileSync(
			legacyPath(dir),
			`${JSON.stringify(loser)}\nGARBAGE\n`,
			'utf-8',
		);

		// The read still folds it (correctness) and the checkpoint wins.
		const active = await listActive(dir);
		expect(active).toHaveLength(1);
		expect(active[0].errorCount).toBe(1);
		let health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('checkpoint+legacy');

		// The next write settles the fingerprint and re-archives the source.
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 2 });
		health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('checkpoint'); // no more re-fold
		expect(fs.existsSync(legacyPath(dir))).toBe(false); // archived again
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.maintenance.corruptLegacyRecords).toBeGreaterThanOrEqual(1);
		expect(active[0].errorCount).toBe(1);
		expect((await listActive(dir))[0].errorCount).toBe(2); // later update visible
	});

	test('lookupByPr resolves through the legacy overlay before migration', async () => {
		writeLegacy(dir, [record('sess_1', 42, Date.now(), 'myorg/myrepo')]);
		const found = await lookupByPr(dir, 'myorg/myrepo', 42);
		expect(found).not.toBeNull();
		expect(found?.sessionID).toBe('sess_1');
		// A read bootstrapped the checkpoint; the record survives it.
		const after = await lookupByPr(dir, 'myorg/myrepo', 42);
		expect(after?.correlationId).toBe('sess_1::myorg/myrepo::42');
	});

	test('an over-ceiling legacy source is refused, never folded, never archived, loudly reported', async () => {
		// Sparse-extend the file past the 64 MiB fold budget — stat.size is the
		// ceiling check's input, and the refusal happens before any read.
		const legacy = legacyPath(dir);
		fs.writeFileSync(legacy, '', 'utf-8');
		fs.truncateSync(legacy, PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes + 1);
		const sizeBefore = fs.statSync(legacy).size;

		// Reads refuse: no fold, empty view, health discloses the condition.
		const active = await listActive(dir);
		expect(active).toHaveLength(0);
		const health = await getPrSubscriptionHealth(dir);
		expect(health.legacyOverLimit).toBe(true);
		expect(health.recoverySource).toBe('legacy-log');

		// Writes proceed from empty checkpoint state; the legacy file is left
		// untouched (archiving unabsorbed data would lose it silently).
		const rec = await subscribe(dir, {
			sessionID: 'sess_new',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});
		expect(rec.status).toBe('active');
		expect(fs.statSync(legacy).size).toBe(sizeBefore);
		expect(fs.existsSync(archivePath(dir))).toBe(false);

		const after = await listActive(dir);
		expect(after).toHaveLength(1);
		const healthAfter = await getPrSubscriptionHealth(dir);
		expect(healthAfter.legacyOverLimit).toBe(true);
		expect(healthAfter.recoverySource).toBe('checkpoint');
	}, 30_000);

	test('a multi-chunk legacy file migrates completely within the finite fold budget', async () => {
		// 300 keys × 8 historical updates each, ~1.1 KB per line → ~2.6 MiB of
		// legacy spanning 3 migration chunks, folding to 300 records (within
		// checkpoint replay capacity; history collapses per correlationId).
		const now = Date.now();
		const filler = 'c'.repeat(800);
		const lines: string[] = [];
		for (let round = 0; round < 8; round++) {
			for (let key = 1; key <= 300; key++) {
				const rec = record(`s${key}`, key, now - (8 - round) * 1000);
				rec.lastCheckRunSet = `${filler}-${round}`;
				rec.errorCount = round;
				lines.push(`${JSON.stringify(rec)}\n`);
			}
		}
		fs.writeFileSync(legacyPath(dir), lines.join(''), 'utf-8');
		expect(fs.statSync(legacyPath(dir)).size).toBeGreaterThan(
			PR_SUBSCRIPTION_LIMITS.migrationChunkBytes * 2,
		);

		await updateSnapshot(dir, 's1::o/r::1', { errorCount: 99 });

		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dir), 'utf-8'),
		);
		expect(cp.migration?.done).toBe(true);
		expect(cp.migration?.scannedBytes).toBe(fs.statSync(archivePath(dir)).size);
		// One record per key — the latest update wins across chunks.
		expect(Object.keys(cp.records)).toHaveLength(300);
		expect(cp.records['s1::o/r::1'].errorCount).toBe(99);
		// Latest historical round for an untouched key survived (round 7).
		expect(cp.records['s300::o/r::300'].errorCount).toBe(7);
		// Restart-equivalent replay: the just-written checkpoint must be
		// accepted by the reader (no capacity/identity rejection).
		const active = await listActive(dir);
		expect(active).toHaveLength(300);
	}, 60_000);

	test('over-capacity legacy state: migration refuses, writes fail loudly, reads stay correct, nothing is lost', async () => {
		// 600 DISTINCT active keys — more than the 512-record checkpoint replay
		// guard. Terminal compaction cannot shrink an all-active folded set.
		const now = Date.now();
		const lines: string[] = [];
		for (let i = 1; i <= 600; i++) {
			lines.push(`${JSON.stringify(record(`s${i}`, i, now - i))}\n`);
		}
		fs.writeFileSync(legacyPath(dir), lines.join(''), 'utf-8');

		// Reads fold the legacy source exactly (v1 semantics) — every active
		// record visible, none silently removed.
		const active = await listActive(dir);
		expect(active).toHaveLength(600);
		const found = await lookupByPr(dir, 'o/r', 600);
		expect(found?.sessionID).toBe('s600');

		// A write refuses to persist unreplayable state: loud capacity error,
		// no checkpoint persisted, legacy file never archived or quarantined.
		await expect(
			updateSnapshot(dir, 's1::o/r::1', { errorCount: 5 }),
		).rejects.toThrow(/over checkpoint capacity/);
		expect(fs.existsSync(checkpointPath(dir))).toBe(false);
		expect(fs.existsSync(archivePath(dir))).toBe(false);
		expect(fs.existsSync(legacyPath(dir))).toBe(true);

		// Reads remain correct after the refused write (restart-equivalent).
		const after = await listActive(dir);
		expect(after).toHaveLength(600);
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('legacy-log');
		expect(health.activeCount).toBe(600);
	}, 60_000);

	test('subscribe into a legacy store: pre-seeded records enforce the limit', async () => {
		// Mirrors the historical maxSubscriptions test path against the new
		// loader: the hand-written legacy record must be visible to subscribe.
		writeLegacy(dir, [record('sess_1', 1, Date.now())]);
		await expect(
			subscribe(dir, {
				sessionID: 'sess_2',
				prNumber: 2,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/2',
				maxSubscriptions: 1,
			}),
		).rejects.toThrow(/limit reached/i);
	});
});
