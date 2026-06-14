/**
 * Phase 1 PR Monitor infrastructure — durable JSONL subscription store tests.
 * Tests: subscribe, unsubscribe, listActive, lookupByPr, updateSnapshot, sweepStale.
 * Uses real temp directories with real file I/O (same pattern as pending-delegations.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildCorrelationId,
	listActive,
	lookupByPr,
	PR_SUBSCRIPTIONS_FILE,
	type PrSubscriptionRecord,
	subscribe,
	sweepStale,
	unsubscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pr-sub-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'pr-monitor'), { recursive: true });
	return real;
}

describe('pr-subscriptions store', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('buildCorrelationId', () => {
		test('composes sessionID, repoFullName, prNumber correctly', () => {
			const id = buildCorrelationId('session_abc', 'owner/repo', 42);
			expect(id).toBe('session_abc::owner/repo::42');
		});

		test('handles repo names with hyphens and dots', () => {
			const id = buildCorrelationId('s1', 'my-org.my-org/repo-name', 1);
			expect(id).toBe('s1::my-org.my-org/repo-name::1');
		});
	});

	describe('subscribe', () => {
		test('subscribes to a PR and reads it back', async () => {
			const record = await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 123,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/123',
			});
			expect(record.status).toBe('active');
			expect(record.sessionID).toBe('sess_1');
			expect(record.prNumber).toBe(123);
			expect(record.repoFullName).toBe('owner/repo');
			expect(record.prUrl).toBe('https://github.com/owner/repo/pull/123');
			expect(record.isWatching).toBe(true);
			expect(record.hasUnaddressedEvents).toBe(false);
			expect(record.errorCount).toBe(0);
			expect(record.correlationId).toBe('sess_1::owner/repo::123');

			// File exists under .swarm/pr-monitor/
			const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			expect(fs.existsSync(filePath)).toBe(true);
		});

		test('subscribe is idempotent — same correlationId returns existing record', async () => {
			const first = await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 123,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/123',
			});
			const second = await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 123,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/123',
			});
			expect(first.correlationId).toBe(second.correlationId);
			expect(first.createdAt).toBe(second.createdAt); // same record
		});

		test('different sessions get different correlationIds', async () => {
			const r1 = await subscribe(dir, {
				sessionID: 'sess_a',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const r2 = await subscribe(dir, {
				sessionID: 'sess_b',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			expect(r1.correlationId).not.toBe(r2.correlationId);
			expect(r1.sessionID).toBe('sess_a');
			expect(r2.sessionID).toBe('sess_b');
		});

		test('subscribe with maxSubscriptions enforces limit', async () => {
			// Pre-seed one active subscription record directly to the JSONL file.
			// subscribe() runs readAllRecords inside withEvidenceLock, so the
			// record must be visible on disk before subscribe() reads it.
			const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			const now = Date.now();
			const existingRecord = {
				correlationId: 'sess_1::o/r::1',
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				lastCheckedAt: now,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: now,
				updatedAt: now,
				errorCount: 0,
			};
			fs.writeFileSync(
				filePath,
				`${JSON.stringify(existingRecord)}\n`,
				'utf-8',
			);

			// Now subscribe with maxSubscriptions: 1 — should throw because
			// there is already 1 active subscription on disk.
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

		test('subscribe with maxSubscriptions=0 does not enforce limit', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				maxSubscriptions: 0,
			});
			// Should not throw
			await subscribe(dir, {
				sessionID: 'sess_2',
				prNumber: 2,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/2',
				maxSubscriptions: 0,
			});
		});

		test('subscribe rejects invalid repoFullName with three segments', async () => {
			await expect(
				subscribe(dir, {
					sessionID: 'sess_1',
					prNumber: 1,
					repoFullName: 'owner/repo/extra',
					prUrl: 'https://github.com/owner/repo/pull/1',
				}),
			).rejects.toThrow(/Invalid subscription record/);
		});

		test('subscribe rejects invalid prUrl that is not a GitHub URL', async () => {
			await expect(
				subscribe(dir, {
					sessionID: 'sess_1',
					prNumber: 1,
					repoFullName: 'owner/repo',
					prUrl: 'not-a-url',
				}),
			).rejects.toThrow(/Invalid subscription record/);
		});

		test('subscribe rejects malformed prUrl with wrong domain', async () => {
			await expect(
				subscribe(dir, {
					sessionID: 'sess_1',
					prNumber: 1,
					repoFullName: 'owner/repo',
					prUrl: 'https://gitlab.com/owner/repo/pull/1',
				}),
			).rejects.toThrow(/Invalid subscription record/);
		});

		test('valid inputs still produce an active record', async () => {
			const record = await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 42,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/42',
			});
			expect(record.status).toBe('active');
			expect(record.repoFullName).toBe('owner/repo');
			expect(record.prUrl).toBe('https://github.com/owner/repo/pull/42');
		});
	});

	describe('unsubscribe', () => {
		test('unsubscribes an active subscription', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 100,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/100',
			});
			const removed = await unsubscribe(dir, 'sess_1::o/r::100');
			expect(removed).not.toBeNull();
			expect(removed!.status).toBe('removed');
			expect(removed!.isWatching).toBe(false);
		});

		test('unsubscribe returns null for non-existent correlationId', async () => {
			const result = await unsubscribe(dir, 'nonexistent::o/r::999');
			expect(result).toBeNull();
		});

		test('unsubscribe returns null for empty correlationId', async () => {
			const result = await unsubscribe(dir, '');
			expect(result).toBeNull();
		});

		test('unsubscribing same correlationId twice is idempotent', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const first = await unsubscribe(dir, 'sess_1::o/r::1');
			const second = await unsubscribe(dir, 'sess_1::o/r::1');
			expect(first).not.toBeNull();
			expect(second).toBeNull(); // Already removed
		});
	});

	describe('listActive', () => {
		test('returns empty list when no subscriptions', async () => {
			const result = await listActive(dir);
			expect(result).toEqual([]);
		});

		test('returns only active subscriptions', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			await subscribe(dir, {
				sessionID: 'sess_2',
				prNumber: 2,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/2',
			});

			// Unsubscribe one
			await unsubscribe(dir, 'sess_1::o/r::1');

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].prNumber).toBe(2);
		});

		test('folds multiple snapshots to latest per correlationId', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			// Update snapshot
			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 3 });
			// Subscribe a different PR
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 2,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/2',
			});

			const active = await listActive(dir);
			expect(active).toHaveLength(2);
			// sess_1::o/r::1 should have errorCount: 3
			const r1 = active.find((r) => r.prNumber === 1);
			expect(r1?.errorCount).toBe(3);
		});
	});

	describe('lookupByPr', () => {
		test('returns subscription for matching PR', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 42,
				repoFullName: 'myorg/myrepo',
				prUrl: 'https://github.com/myorg/myrepo/pull/42',
			});
			const found = await lookupByPr(dir, 'myorg/myrepo', 42);
			expect(found).not.toBeNull();
			expect(found!.sessionID).toBe('sess_1');
		});

		test('returns null for non-existent PR', async () => {
			const result = await lookupByPr(dir, 'o/r', 999);
			expect(result).toBeNull();
		});

		test('returns null for mismatched repo', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
			});
			const result = await lookupByPr(dir, 'other/repo', 1);
			expect(result).toBeNull();
		});
	});

	describe('updateSnapshot', () => {
		test('updates fields on existing subscription', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const updated = await updateSnapshot(dir, 'sess_1::o/r::1', {
				errorCount: 5,
				lastCommentId: 'abc123',
			});
			expect(updated).not.toBeNull();
			expect(updated!.errorCount).toBe(5);
			expect(updated!.lastCommentId).toBe('abc123');
		});

		test('updateSnapshot preserves identity fields', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const before = await lookupByPr(dir, 'o/r', 1);
			const createdAt = before!.createdAt;
			const updated = await updateSnapshot(dir, 'sess_1::o/r::1', {
				errorCount: 1,
			});
			expect(updated!.createdAt).toBe(createdAt); // preserved
			expect(updated!.correlationId).toBe('sess_1::o/r::1'); // never mutated
			expect(updated!.sessionID).toBe('sess_1'); // preserved
		});

		test('updateSnapshot rejects empty correlationId', async () => {
			const result = await updateSnapshot(dir, '', { errorCount: 1 });
			expect(result).toBeNull();
		});

		test('updateSnapshot returns null for non-existent subscription', async () => {
			const result = await updateSnapshot(dir, 'nonexistent::o/r::1', {
				errorCount: 1,
			});
			expect(result).toBeNull();
		});
	});

	describe('sweepStale', () => {
		// Helper: directly write a backdated record to the JSONL file for sweep testing.
		// PR_SUBSCRIPTIONS_FILE = 'pr-monitor/subscriptions.jsonl', and the dir is already
		// at .swarm/pr-monitor/ (via makeTempProject), so we join with PR_SUBSCRIPTIONS_FILE directly.
		function writeBackdatedRecord(
			record: PrSubscriptionRecord,
			updatedAtMs: number,
		): void {
			// ensureSwarmDir creates dir/.swarm/pr-monitor/; PR_SUBSCRIPTIONS_FILE is 'pr-monitor/subscriptions.jsonl'
			// so the full path is dir/.swarm/pr-monitor/subscriptions.jsonl
			const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			const backdated: PrSubscriptionRecord = {
				...record,
				updatedAt: updatedAtMs,
			};
			fs.appendFileSync(filePath, `${JSON.stringify(backdated)}\n`, 'utf-8');
		}

		test('sweepStale with ttlDays=0 returns 0', async () => {
			const result = await sweepStale(dir, 0);
			expect(result).toBe(0);
		});

		test('sweepStale with negative ttlDays returns 0', async () => {
			const result = await sweepStale(dir, -1);
			expect(result).toBe(0);
		});

		test('sweeps merged/closed PRs regardless of age', async () => {
			// Write a fresh (recent) record that is in the merged set
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			// Sweep with PR in merged set — should expire even though recent
			const mergedSet = new Set(['o/r::1']);
			const swept = await sweepStale(
				dir,
				999 /* ttlDays - not used */,
				mergedSet,
			);
			expect(swept).toBe(1);

			// Verify it's expired
			const active = await listActive(dir);
			expect(active).toHaveLength(0);
		});

		test('sweeps stale subscriptions with no unaddressed events', async () => {
			// Write a backdated active record directly (updatedAt 10 days ago)
			const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
			const baseRecord: PrSubscriptionRecord = {
				correlationId: 'sess_1::o/r::1',
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				lastCheckedAt: tenDaysAgo,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: tenDaysAgo,
				updatedAt: tenDaysAgo,
				errorCount: 0,
			};
			writeBackdatedRecord(baseRecord, tenDaysAgo);

			// Sweep with 7-day TTL
			const swept = await sweepStale(dir, 7);
			expect(swept).toBe(1);

			const active = await listActive(dir);
			expect(active).toHaveLength(0);
		});

		test('does NOT sweep stale subscriptions with unaddressed events', async () => {
			// Write a backdated record with hasUnaddressedEvents: true
			const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
			const baseRecord: PrSubscriptionRecord = {
				correlationId: 'sess_1::o/r::1',
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				lastCheckedAt: tenDaysAgo,
				isWatching: true,
				hasUnaddressedEvents: true, // protected
				status: 'active',
				createdAt: tenDaysAgo,
				updatedAt: tenDaysAgo,
				errorCount: 0,
			};
			writeBackdatedRecord(baseRecord, tenDaysAgo);

			const swept = await sweepStale(dir, 7);
			expect(swept).toBe(0); // Not swept

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
		});

		test('sweeps only active subscriptions (not already removed/expired)', async () => {
			// Write an already-removed record
			const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
			const removedRecord: PrSubscriptionRecord = {
				correlationId: 'sess_1::o/r::1',
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				lastCheckedAt: tenDaysAgo,
				isWatching: false,
				hasUnaddressedEvents: false,
				status: 'removed', // already removed
				createdAt: tenDaysAgo,
				updatedAt: tenDaysAgo,
				errorCount: 0,
			};
			writeBackdatedRecord(removedRecord, tenDaysAgo);

			const swept = await sweepStale(dir, 7);
			expect(swept).toBe(0);
		});
	});

	describe('JSONL corruption resilience', () => {
		test('listActive skips malformed/partial JSONL lines and returns valid records', async () => {
			await subscribe(dir, {
				sessionID: 'sess_good',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});

			const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			fs.appendFileSync(filePath, '{INVALID JSON\n', 'utf-8');
			fs.appendFileSync(filePath, 'not-json-at-all\n', 'utf-8');
			fs.appendFileSync(filePath, '\n', 'utf-8');

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].sessionID).toBe('sess_good');
			expect(active[0].prNumber).toBe(1);
		});

		test('listActive handles truncated JSON object gracefully', async () => {
			await subscribe(dir, {
				sessionID: 'sess_ok',
				prNumber: 42,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/42',
			});

			const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			fs.appendFileSync(
				filePath,
				'{"correlationId":"sess_trunc::o/r::99","sessionID":"sess_trunc","prNumb\n',
				'utf-8',
			);

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].prNumber).toBe(42);
		});
	});
});
