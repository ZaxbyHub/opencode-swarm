/**
 * Issue #2042 — bounded PR-monitor subscription checkpoint store:
 * steady-state bounded reads/writes, live-subscription caps, terminal
 * compaction, unaddressed-event retention, long-history bounds, and
 * crash-resume of a half-migrated store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	type PrSubscriptionCheckpoint,
	type PrSubscriptionRecord,
	subscribe,
	sweepStale,
	unsubscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-cp-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
	return dir;
}

function checkpointPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

function readCheckpoint(dir: string): PrSubscriptionCheckpoint {
	return JSON.parse(fs.readFileSync(checkpointPath(dir), 'utf-8'));
}

function writeCheckpoint(dir: string, cp: PrSubscriptionCheckpoint): void {
	fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
}

function activeRecord(
	sessionID: string,
	prNumber: number,
	updatedAt = Date.now(),
): PrSubscriptionRecord {
	return {
		correlationId: `${sessionID}::o/r::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		lastCheckedAt: updatedAt,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: updatedAt,
		updatedAt,
		errorCount: 0,
	};
}

function baseCheckpoint(dir: string): PrSubscriptionCheckpoint {
	return {
		schemaVersion: 1,
		sequence: 1,
		rootPath: path.resolve(dir),
		updatedAt: Date.now(),
		records: {},
		terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
		migration: null,
		maintenance: {
			compactions: 0,
			droppedAuditTransitions: 0,
			corruptLegacyRecords: 0,
			lastCompactedAt: null,
			resets: 0,
		},
	};
}

async function subscribePr(
	dir: string,
	prNumber: number,
	sessionID = 'sess_1',
) {
	return subscribe(dir, {
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
	});
}

describe('pr-subscriptions checkpoint store', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		closeProjectDb(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('steady-state bounded operations', () => {
		test('brand-new store writes only the checkpoint — no legacy file is created', async () => {
			await subscribePr(dir, 1);
			expect(fs.existsSync(checkpointPath(dir))).toBe(true);
			expect(
				fs.existsSync(
					path.join(dir, '.swarm', 'pr-monitor', 'subscriptions.jsonl'),
				),
			).toBe(false);
			const cp = readCheckpoint(dir);
			expect(Object.keys(cp.records)).toHaveLength(1);
			expect(cp.migration).toBeNull();
		});

		test('sequence advances monotonically per persisted write', async () => {
			await subscribePr(dir, 1);
			const seq1 = readCheckpoint(dir).sequence;
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 2 });
			const seq2 = readCheckpoint(dir).sequence;
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 3 });
			const seq3 = readCheckpoint(dir).sequence;
			expect(seq2).toBeGreaterThan(seq1);
			expect(seq3).toBeGreaterThan(seq2);
		});

		test('no-op operations do not rewrite the checkpoint', async () => {
			await subscribePr(dir, 1);
			const before = fs.statSync(checkpointPath(dir)).mtimeMs;
			await updateSnapshot(dir, 'nonexistent::o/r::9', { errorCount: 1 });
			expect(fs.statSync(checkpointPath(dir)).mtimeMs).toBe(before);
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 0 });
			expect(fs.statSync(checkpointPath(dir)).mtimeMs).toBe(before);
		});

		test('duplicate and reordered in-store updates resolve last-write-wins', async () => {
			// Frozen clock: the two updates would otherwise be
			// indistinguishable-by-timestamp across a ms boundary.
			const restore = freezeClock();
			try {
				await subscribePr(dir, 1);
				await updateSnapshot(dir, 'sess_1::o/r::1', {
					mergeableState: 'CLEAN',
					lastCommentId: 'c1',
				});
				await updateSnapshot(dir, 'sess_1::o/r::1', { lastCommentId: 'c2' });
				const cp = readCheckpoint(dir);
				const rec = cp.records['sess_1::o/r::1'];
				expect(rec.lastCommentId).toBe('c2');
				expect(rec.mergeableState).toBe('CLEAN'); // merge preserves untouched fields
			} finally {
				restore();
			}
		});

		test('headRefOid round-trips through updateSnapshot and persists', async () => {
			await subscribePr(dir, 1);
			const updated = await updateSnapshot(dir, 'sess_1::o/r::1', {
				headRefOid: 'abc123def456',
				mergeableState: 'CLEAN',
			});
			expect(updated?.headRefOid).toBe('abc123def456');
			// Survives a restart-equivalent replay of the persisted checkpoint.
			const cp = readCheckpoint(dir);
			expect(cp.records['sess_1::o/r::1'].headRefOid).toBe('abc123def456');
		});
	});

	describe('live-subscription caps', () => {
		test('omitted maxSubscriptions falls back to the store-side safety net (20)', async () => {
			for (let i = 1; i <= 20; i++) {
				await subscribePr(dir, i, `sess_${i}`);
			}
			await expect(subscribePr(dir, 21, 'sess_21')).rejects.toThrow(
				/limit reached: 20\/20/,
			);
		});

		test('explicit maxSubscriptions above the default wins', async () => {
			for (let i = 1; i <= 25; i++) {
				await subscribe(dir, {
					sessionID: `sess_${i}`,
					prNumber: i,
					repoFullName: 'o/r',
					prUrl: `https://github.com/o/r/pull/${i}`,
					maxSubscriptions: 50,
				});
			}
			const cp = readCheckpoint(dir);
			expect(
				Object.values(cp.records).filter((r) => r.status === 'active'),
			).toHaveLength(25);
		});

		test('maxSubscriptions=0 still disables the limit', async () => {
			for (let i = 1; i <= 25; i++) {
				await subscribe(dir, {
					sessionID: `sess_${i}`,
					prNumber: i,
					repoFullName: 'o/r',
					prUrl: `https://github.com/o/r/pull/${i}`,
					maxSubscriptions: 0,
				});
			}
			const cp = readCheckpoint(dir);
			expect(Object.keys(cp.records)).toHaveLength(25);
		});
	});

	describe('terminal compaction', () => {
		test('terminal records compact High→Low into summary counters', async () => {
			// Seed 70 terminal records directly in the checkpoint (high-water 60).
			const cp = baseCheckpoint(dir);
			for (let i = 1; i <= 70; i++) {
				const rec = activeRecord('sess_t', i, Date.now() - 1000);
				rec.status = i % 2 === 0 ? 'removed' : 'expired';
				rec.isWatching = false;
				cp.records[rec.correlationId] = rec;
			}
			writeCheckpoint(dir, cp);

			await subscribePr(dir, 999, 'sess_live');

			const after = readCheckpoint(dir);
			const terminals = Object.values(after.records).filter(
				(r) => r.status !== 'active',
			);
			expect(terminals.length).toBeLessThanOrEqual(
				PR_SUBSCRIPTION_LIMITS.terminalRecordsLow,
			);
			expect(after.maintenance.compactions).toBe(1);
			const dropped =
				70 -
				terminals.filter((r) => r.status === 'removed').length -
				terminals.filter((r) => r.status === 'expired').length;
			expect(
				after.terminalSummary.removed + after.terminalSummary.expired,
			).toBe(dropped);
		});

		test('terminal records older than the age ceiling are summarized regardless of count', async () => {
			const cp = baseCheckpoint(dir);
			const old = activeRecord('sess_old', 1, Date.now() - 40 * 86_400_000);
			old.status = 'expired';
			old.isWatching = false;
			cp.records[old.correlationId] = old;
			writeCheckpoint(dir, cp);

			await subscribePr(dir, 2, 'sess_new');

			const after = readCheckpoint(dir);
			expect(after.records['sess_old::o/r::1']).toBeUndefined();
			expect(after.terminalSummary.expired).toBe(1);
		});

		test('active records with unaddressed events survive compaction (never dropped)', async () => {
			// Named issue-#2042 acceptance case: unaddressed-event actives are
			// retained even when terminal compaction fires around them.
			const cp = baseCheckpoint(dir);
			for (let i = 1; i <= 70; i++) {
				const rec = activeRecord('sess_t', i, Date.now() - 1000);
				rec.status = 'expired';
				rec.isWatching = false;
				cp.records[rec.correlationId] = rec;
			}
			const guarded = activeRecord(
				'sess_guard',
				1,
				Date.now() - 40 * 86_400_000,
			);
			guarded.hasUnaddressedEvents = true;
			cp.records[guarded.correlationId] = guarded;
			writeCheckpoint(dir, cp);

			await subscribePr(dir, 2, 'sess_new');

			const after = readCheckpoint(dir);
			expect(after.records['sess_guard::o/r::1']).toBeDefined();
			expect(after.records['sess_guard::o/r::1'].status).toBe('active');
			expect(after.records['sess_guard::o/r::1'].hasUnaddressedEvents).toBe(
				true,
			);
		});

		test('custom monitor policy (thresholds) survives compaction', async () => {
			await subscribePr(dir, 1);
			await updateSnapshot(dir, 'sess_1::o/r::1', {
				customPollIntervalSeconds: 120,
				customFailureThreshold: 3,
				customCooldownSeconds: 600,
				hasUnaddressedEvents: true,
			});
			// Force a compaction via terminal pressure.
			const cp = readCheckpoint(dir);
			for (let i = 2; i <= 70; i++) {
				const rec = activeRecord('sess_t', i, Date.now() - 1000);
				rec.status = 'removed';
				rec.isWatching = false;
				cp.records[rec.correlationId] = rec;
			}
			writeCheckpoint(dir, cp);
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });

			const after = readCheckpoint(dir);
			const rec = after.records['sess_1::o/r::1'];
			expect(rec.customPollIntervalSeconds).toBe(120);
			expect(rec.customFailureThreshold).toBe(3);
			expect(rec.customCooldownSeconds).toBe(600);
		});

		test('TTL sweep does not drop errorCount/cooldown state on retained actives', async () => {
			await subscribePr(dir, 1);
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 4 });
			// A network-outage-style run of error snapshots, then a sweep that
			// retains the record (unaddressed events set).
			await updateSnapshot(dir, 'sess_1::o/r::1', {
				hasUnaddressedEvents: true,
			});
			await sweepStale(dir, 7);
			const after = readCheckpoint(dir);
			expect(after.records['sess_1::o/r::1'].errorCount).toBe(4);
			expect(after.records['sess_1::o/r::1'].status).toBe('active');
		});
	});

	describe('long-history bounds', () => {
		test('hundreds of poll updates keep the store inside documented bounds', async () => {
			await subscribePr(dir, 1);
			// 300 polls × 2 snapshots/poll = 600 persisted writes. Each op after
			// the subscribe is O(live-set) on disk — the store's size does not
			// grow with update count, which is the mechanism the issue's
			// "arbitrarily long subscriptions" acceptance relies on.
			const POLLS = 300;
			for (let i = 0; i < POLLS; i++) {
				await updateSnapshot(dir, 'sess_1::o/r::1', {
					lastCheckedAt: Date.now(),
					mergeableState: 'clean',
				});
				await updateSnapshot(dir, 'sess_1::o/r::1', {
					errorCount: 0,
					lastCheckedAt: Date.now(),
				});
			}
			const bytes = fs.statSync(checkpointPath(dir)).size;
			expect(bytes).toBeLessThanOrEqual(
				PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes,
			);
			const cp = readCheckpoint(dir);
			// One live record regardless of update count.
			expect(Object.keys(cp.records)).toHaveLength(1);
			// Audit carries transitions only — a subscribe and nothing else here.
			expect(cp.maintenance.compactions).toBe(0);
		}, 30_000);

		test('subscribe/unsubscribe churn keeps terminal records bounded', async () => {
			for (let i = 1; i <= 80; i++) {
				await subscribePr(dir, i, `sess_${i}`);
				await unsubscribe(dir, `sess_${i}::o/r::${i}`);
			}
			const cp = readCheckpoint(dir);
			const terminals = Object.values(cp.records).filter(
				(r) => r.status !== 'active',
			);
			expect(terminals.length).toBeLessThanOrEqual(
				PR_SUBSCRIPTION_LIMITS.terminalRecordsHigh,
			);
			expect(cp.maintenance.compactions).toBeGreaterThan(0);
		}, 30_000);

		test('audit tail crossing the byte high-water rewrites to the bounded shape', async () => {
			await subscribePr(dir, 1);
			await subscribePr(dir, 2, 'sess_2');
			// Craft an over-watermark audit tail (600 lines, > 128 KiB bytes).
			const auditPath = path.join(
				dir,
				'.swarm',
				'pr-monitor',
				'subscriptions.audit.jsonl',
			);
			const filler = 'x'.repeat(256);
			const crafted = Array.from(
				{ length: 600 },
				(_, i) => `{"ts":${i},"seq":1,"kind":"reset","note":"${filler}"}`,
			).join('\n');
			fs.writeFileSync(auditPath, `${crafted}\n`, 'utf-8');
			expect(fs.statSync(auditPath).size).toBeGreaterThan(
				PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh,
			);

			// The next transition append triggers the rewrite.
			await unsubscribe(dir, 'sess_1::o/r::1');

			const after = fs
				.readFileSync(auditPath, 'utf-8')
				.split('\n')
				.filter((l) => l.trim().length > 0);
			expect(after.length).toBeLessThanOrEqual(
				PR_SUBSCRIPTION_LIMITS.auditMaxLinesLow + 1,
			);
			expect(fs.statSync(auditPath).size).toBeLessThanOrEqual(
				PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh,
			);
			const cp = readCheckpoint(dir);
			expect(cp.maintenance.droppedAuditTransitions).toBeGreaterThan(0);
			// Newest entries survive: the unsubscribe transition is retained.
			expect(after.some((l) => l.includes('"kind":"unsubscribe"'))).toBe(true);
		});
	});

	describe('crash-resume of a half-migrated store', () => {
		test('a persisted mid-file cursor resumes and completes without losing records', async () => {
			// Build a legacy log whose byte length we can split at a line boundary.
			const legacyPath = path.join(
				dir,
				'.swarm',
				'pr-monitor',
				'subscriptions.jsonl',
			);
			const now = Date.now();
			const lines: string[] = [];
			for (let i = 1; i <= 6; i++) {
				lines.push(`${JSON.stringify(activeRecord('sess_m', i, now - i))}\n`);
			}
			fs.writeFileSync(legacyPath, lines.join(''), 'utf-8');
			const whole = fs.readFileSync(legacyPath, 'utf-8');
			// Cursor after line 2 (a line boundary).
			const cursor = lines[0].length + lines[1].length;

			const cp = baseCheckpoint(dir);
			// A real mid-migration checkpoint holds the fold of every consumed
			// line — cursor sits after line 2, so records 1 AND 2 are folded.
			cp.records[JSON.parse(lines[0]).correlationId] = JSON.parse(lines[0]);
			cp.records[JSON.parse(lines[1]).correlationId] = JSON.parse(lines[1]);
			cp.migration = {
				scannedBytes: cursor,
				sourceBytes: whole.length,
				sourceMtimeMs: fs.statSync(legacyPath).mtimeMs,
				corruptLines: 0,
				done: false,
				archived: false,
				startedAt: now,
			};
			writeCheckpoint(dir, cp);

			// The next write op resumes from the cursor and completes migration.
			await updateSnapshot(dir, 'sess_m::o/r::6', { errorCount: 7 });

			const after = readCheckpoint(dir);
			expect(after.migration?.done).toBe(true);
			// All six legacy records absorbed (2 prefix via cursor + 4 tail).
			const active = Object.values(after.records).filter(
				(r) => r.status === 'active',
			);
			expect(active).toHaveLength(6);
			expect(after.records['sess_m::o/r::6'].errorCount).toBe(7);
		});
	});
});
