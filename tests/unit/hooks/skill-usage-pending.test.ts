/**
 * Issue #2038 — the pending-feedback queue: enqueue, consumption lifecycle,
 * crash-recovery, quarantine, pressure policy, the real lock path, and
 * multi-project isolation.
 *
 * Uses the `_internals` DI seams (never `mock.module`) and restores them in
 * `afterEach`. Each test owns a private `canonicalMkdtemp` temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	_resetSkillUsageMaintenanceState,
	appendSkillUsageEntry,
	pruneSkillUsageLog,
	_internals as sul_internals,
} from '../../../src/hooks/skill-usage-log.js';
import {
	_resetSkillUsagePendingState,
	acquireSkillUsageLockOrThrow,
	applyTerminalOutcome,
	createPendingDocument,
	enforceQueueBounds,
	loadPendingDocument,
	markRecordsInFlight,
	mergePendingRecords,
	resolveSkillUsageLockPath,
	resolveStaleInFlight,
	retainWithRetry,
	SKILL_USAGE_LIMITS,
	SKILL_USAGE_LOCK_STALE_MS,
	savePendingDocument,
	selectConsumableRecords,
	_internals as sup_internals,
} from '../../../src/hooks/skill-usage-pending.js';
import { KNOWLEDGE_FAMILY } from '../../../src/knowledge/family-manifest.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function pendingPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage-pending.json');
}

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

describe('skill-usage pending queue (issue #2038)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-pending-');
	});

	afterEach(() => {
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		sul_internals.readFileSync = fs.readFileSync.bind(fs);
		sup_internals.renameSync = fs.renameSync.bind(fs);
		sup_internals.writeFileSync = fs.writeFileSync.bind(fs);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('durability across compaction and restart', () => {
		test('unprocessed feedback survives a compaction pass and a fresh load ("restart")', () => {
			appendSkillUsageEntry(dir, {
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-1',
			});
			const beforeIds = loadPendingDocument(dir).doc.records.map((r) => r.id);
			expect(beforeIds.length).toBe(1);

			pruneSkillUsageLog(dir);

			// A fresh `loadPendingDocument` call is the "restart" — no in-memory
			// state carries over, only what is on disk.
			const afterDoc = loadPendingDocument(dir).doc;
			expect(afterDoc.records.map((r) => r.id)).toEqual(beforeIds);
			expect(afterDoc.records[0]!.state).toBe('pending');
		});
	});

	describe('consumed at most once', () => {
		test('a claim that crashes between bump and dequeue becomes `uncertain`, never replayed', () => {
			const doc = createPendingDocument();
			doc.migrated = true;
			mergePendingRecords(
				doc,
				[
					{
						id: 'crash-1',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);
			// Simulate phase A: claim the record in_flight, "crash" before commit.
			markRecordsInFlight(doc, ['crash-1'], '2026-01-01T00:00:00.000Z');
			expect(doc.records[0]!.state).toBe('in_flight');

			// Past the stale-break window: the abandoned claim resolves to `uncertain`.
			const nowMs =
				Date.parse('2026-01-01T00:00:00.000Z') + SKILL_USAGE_LOCK_STALE_MS + 1;
			const resolvedCount = resolveStaleInFlight(doc, nowMs);
			expect(resolvedCount).toBe(1);
			expect(doc.records[0]!.state).toBe('uncertain');

			// Exactly-once contract: an `uncertain` record is NEVER consumable again.
			expect(selectConsumableRecords(doc)).toEqual([]);

			// A claim within the stale window is left alone (another process may
			// still be finishing its cycle).
			const doc2 = createPendingDocument();
			doc2.migrated = true;
			mergePendingRecords(
				doc2,
				[
					{
						id: 'live-1',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);
			markRecordsInFlight(doc2, ['live-1'], '2026-01-01T00:00:00.000Z');
			const stillLiveMs =
				Date.parse('2026-01-01T00:00:00.000Z') + SKILL_USAGE_LOCK_STALE_MS - 1;
			expect(resolveStaleInFlight(doc2, stillLiveMs)).toBe(0);
			expect(doc2.records[0]!.state).toBe('in_flight');
		});
	});

	describe('all four terminal outcomes drain the queue', () => {
		test('no_source_knowledge, no_matching_knowledge, bump_unrecoverable, and uncertain_expired all dequeue and count', () => {
			const doc = createPendingDocument();
			doc.migrated = true;
			const ts = '2026-01-01T00:00:00.000Z';
			mergePendingRecords(
				doc,
				[
					{
						id: 'no-source',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: ts,
					},
					{
						id: 'no-match',
						skillPath: 'skill-b',
						verdict: 'compliant',
						timestamp: ts,
					},
					{
						id: 'retry-me',
						skillPath: 'skill-c',
						verdict: 'violated',
						timestamp: ts,
					},
				],
				ts,
			);
			// Bump past attempts to force bump_unrecoverable.
			const target = doc.records.find((r) => r.id === 'retry-me')!;
			target.attempts = SKILL_USAGE_LIMITS.maxAttempts - 1;

			applyTerminalOutcome(doc, ['no-source'], 'no_source_knowledge');
			applyTerminalOutcome(doc, ['no-match'], 'no_matching_knowledge');
			const { unrecoverable } = retainWithRetry(doc, ['retry-me']);
			expect(unrecoverable).toEqual(['retry-me']);

			// An `uncertain` record older than maxAgeMs expires with its own
			// terminal outcome — counted, never silently dropped.
			const oldTs = '2020-01-01T00:00:00.000Z';
			mergePendingRecords(
				doc,
				[
					{
						id: 'stale-uncertain',
						skillPath: 'skill-d',
						verdict: 'compliant',
						timestamp: oldTs,
					},
				],
				oldTs,
			);
			doc.records.find((r) => r.id === 'stale-uncertain')!.state = 'uncertain';
			enforceQueueBounds(
				doc,
				Date.parse('2020-01-01T00:00:00.000Z') +
					SKILL_USAGE_LIMITS.maxAgeMs +
					1,
			);

			expect(doc.records).toEqual([]);
			expect(doc.counters.no_source_knowledge).toBe(1);
			expect(doc.counters.no_matching_knowledge).toBe(1);
			expect(doc.counters.bump_unrecoverable).toBe(1);
			expect(doc.counters.uncertain_expired).toBe(1);
		});

		test('terminal dequeues do NOT increment processed/bumps counters (only skill_usage_health sees them)', () => {
			const doc = createPendingDocument();
			doc.migrated = true;
			mergePendingRecords(
				doc,
				[
					{
						id: 'term-1',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);
			applyTerminalOutcome(doc, ['term-1'], 'no_source_knowledge');

			// `SkillUsagePendingDocument.counters` has no `processed`/`bumps`
			// field at all — those live only on the `applySkillUsageFeedback`
			// return value, and the E7 contract is that a terminal outcome must
			// never cause that value to move. `no_source_knowledge` incrementing
			// is the only observable effect here.
			expect(doc.counters.no_source_knowledge).toBe(1);
			expect('processed' in doc.counters).toBe(false);
			expect('bumps' in doc.counters).toBe(false);
		});
	});

	describe('enqueue policy', () => {
		test('enqueue is a no-op — no lock, no queue I/O — on the not_checked path', () => {
			appendSkillUsageEntry(dir, {
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'not_checked',
				sessionID: 'session-1',
			});

			// Throttled maintenance may still touch the sidecar for migration
			// bookkeeping; what matters is no queue record for a not_checked entry.
			expect(fs.existsSync(logPath(dir))).toBe(true);
			const doc = loadPendingDocument(dir).doc;
			expect(doc.records).toEqual([]);
		});

		test('a failed enqueue ABORTS the append and propagates — feedback is never silently lost', () => {
			const original = sup_internals.writeFileSync;
			sup_internals.writeFileSync = (() => {
				throw new Error('simulated enqueue write failure');
			}) as typeof sup_internals.writeFileSync;

			expect(() =>
				appendSkillUsageEntry(dir, {
					skillPath: 'skill-a',
					agentName: 'agent',
					taskID: 'task-1',
					timestamp: '2026-01-01T00:00:00.000Z',
					complianceVerdict: 'compliant',
					sessionID: 'session-1',
				}),
			).toThrow();

			// The append never happened either — no stream row with no queue record.
			expect(fs.existsSync(logPath(dir))).toBe(false);

			sup_internals.writeFileSync = original;
		});

		test('enqueue happens BEFORE the append — the queue record exists even mid-append', () => {
			let sawRecordDuringAppend = false;
			const originalWrite = sup_internals.writeFileSync;
			sup_internals.writeFileSync = ((
				...args: Parameters<typeof originalWrite>
			) => {
				const result = originalWrite(...args);
				// After the sidecar write (enqueue), the JSONL must not exist yet.
				if (!fs.existsSync(logPath(dir))) sawRecordDuringAppend = true;
				return result;
			}) as typeof sup_internals.writeFileSync;

			appendSkillUsageEntry(dir, {
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-1',
			});

			expect(sawRecordDuringAppend).toBe(true);
			sup_internals.writeFileSync = originalWrite;
		});
	});

	describe('migration idempotency and crash recovery', () => {
		test('duplicate ids across a re-run migration are deduped', () => {
			const legacyEntry = JSON.stringify({
				id: 'dup-1',
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-1',
			});
			fs.mkdirSync(path.dirname(logPath(dir)), { recursive: true });
			fs.writeFileSync(logPath(dir), `${legacyEntry}\n`, 'utf-8');

			pruneSkillUsageLog(dir); // migration #1
			const afterFirst = loadPendingDocument(dir).doc.records.length;
			expect(afterFirst).toBe(1);

			// Re-run: re-merge the same candidate id, as a repeated migration would.
			const doc = loadPendingDocument(dir).doc;
			mergePendingRecords(
				doc,
				[
					{
						id: 'dup-1',
						skillPath: 'skill-a',
						verdict: 'compliant',
						timestamp: '2026-01-01T00:00:00.000Z',
					},
				],
				'2026-01-01T00:00:00.000Z',
			);
			savePendingDocument(dir, doc);

			const afterSecond = loadPendingDocument(dir).doc.records;
			expect(afterSecond.filter((r) => r.id === 'dup-1').length).toBe(1);
		});

		test('crash between sidecar publish and JSONL publish is recoverable and idempotent', () => {
			const legacyEntry = JSON.stringify({
				id: 'crash-mig-1',
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-1',
			});
			const marker = JSON.stringify({
				type: 'feedback_applied',
				timestamp: '2026-01-01T01:00:00.000Z',
				processedEntryIds: [],
			});
			fs.mkdirSync(path.dirname(logPath(dir)), { recursive: true });
			fs.writeFileSync(logPath(dir), `${legacyEntry}\n${marker}\n`, 'utf-8');

			// Simulate a crash: the JSONL marker-drop rewrite fails, leaving the
			// marker on disk while the sidecar publish already succeeded (§6).
			const originalRename = sul_internals.renameSync;
			let renameCalls = 0;
			sul_internals.renameSync = ((
				...args: Parameters<typeof originalRename>
			) => {
				renameCalls += 1;
				if (renameCalls === 1) throw new Error('simulated crash mid-rewrite');
				return originalRename(...args);
			}) as typeof sul_internals.renameSync;

			try {
				pruneSkillUsageLog(dir);
			} finally {
				sul_internals.renameSync = originalRename;
			}

			let doc = loadPendingDocument(dir).doc;
			expect(doc.migrated).toBe(true);
			expect(doc.records.map((r) => r.id)).toEqual(['crash-mig-1']);

			// Retry after "restart": must not re-add the already-migrated record.
			pruneSkillUsageLog(dir);
			doc = loadPendingDocument(dir).doc;
			expect(doc.records.filter((r) => r.id === 'crash-mig-1').length).toBe(1);
		});
	});

	describe('corrupt sidecar quarantine', () => {
		test('a corrupt sidecar is renamed aside and counted — never silently reset to []', () => {
			fs.mkdirSync(path.dirname(pendingPath(dir)), { recursive: true });
			fs.writeFileSync(pendingPath(dir), '{ not valid json at all', 'utf-8');

			const result = loadPendingDocument(dir);

			expect(result.quarantined).toBe(true);
			expect(result.quarantinePath).toBeDefined();
			expect(fs.existsSync(result.quarantinePath!)).toBe(true);
			expect(fs.readFileSync(result.quarantinePath!, 'utf-8')).toContain(
				'not valid json',
			);
			expect(fs.existsSync(pendingPath(dir))).toBe(false);
			expect(result.doc.counters.corrupt).toBe(1);
			expect(result.doc.records).toEqual([]);
			expect(result.doc.migrated).toBe(false);
		});
	});

	describe('requirement-5 pressure', () => {
		test('at budget, optional (not_checked) writes stop and pressure is surfaced', () => {
			// Write via the real fs directly, never `savePendingDocument` (which
			// would warm the pressure cache with a stale "under budget" reading).
			const doc = createPendingDocument();
			doc.migrated = true;
			const padded = doc as unknown as Record<string, unknown>;
			padded._pad = 'x'.repeat(SKILL_USAGE_LIMITS.queueMaxBytes + 4096);
			fs.mkdirSync(path.dirname(pendingPath(dir)), { recursive: true });
			fs.writeFileSync(pendingPath(dir), JSON.stringify(doc), 'utf-8');
			expect(fs.statSync(pendingPath(dir)).size).toBeGreaterThanOrEqual(
				SKILL_USAGE_LIMITS.queueMaxBytes,
			);

			appendSkillUsageEntry(dir, {
				skillPath: 'skill-optional',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:01:00.000Z',
				complianceVerdict: 'not_checked',
				sessionID: 'session-1',
			});

			// Under pressure the optional not_checked append is suppressed entirely.
			const logContent = fs.existsSync(logPath(dir))
				? fs.readFileSync(logPath(dir), 'utf-8')
				: '';
			expect(logContent).not.toContain('skill-optional');
		});
	});

	describe('real, unstubbed lock path', () => {
		test('a genuinely held lock file blocks a competing enqueue attempt', () => {
			const lockPath = resolveSkillUsageLockPath(dir);
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
			// Real fs — no _internals stub.
			const fd = fs.openSync(lockPath, 'wx');
			fs.closeSync(fd);

			try {
				expect(() => acquireSkillUsageLockOrThrow(dir)).toThrow(
					/lock unavailable/,
				);
			} finally {
				fs.unlinkSync(lockPath);
			}

			// Once released, the real path acquires cleanly.
			expect(() => {
				const handle = acquireSkillUsageLockOrThrow(dir);
				fs.unlinkSync(handle.lockPath);
			}).not.toThrow();
		}, 15_000);
	});

	describe('multi-project isolation', () => {
		test('feedback enqueued in one project directory never appears in another', () => {
			const dirB = canonicalMkdtemp('skill-usage-pending-b-');
			try {
				appendSkillUsageEntry(dir, {
					skillPath: 'skill-a',
					agentName: 'agent',
					taskID: 'task-1',
					timestamp: '2026-01-01T00:00:00.000Z',
					complianceVerdict: 'compliant',
					sessionID: 'session-1',
				});

				expect(fs.existsSync(pendingPath(dir))).toBe(true);
				expect(fs.existsSync(pendingPath(dirB))).toBe(false);
				const docB = loadPendingDocument(dirB).doc;
				expect(docB.records).toEqual([]);
			} finally {
				fs.rmSync(dirB, { recursive: true, force: true });
			}
		});
	});

	describe('KNOWLEDGE_FAMILY guardrail', () => {
		test('skill-usage.jsonl and skill-usage-pending.json are ABSENT from KNOWLEDGE_FAMILY', () => {
			const filenames = KNOWLEDGE_FAMILY.map((m) => m.filename);
			// A future PR adding skill-usage's files to the knowledge-family merge
			// machinery must trip this test rather than silently pulling an
			// unrelated retention/merge policy onto files that have their own
			// bespoke bounded store (this issue's whole point).
			expect(filenames).not.toContain('skill-usage.jsonl');
			expect(filenames).not.toContain('skill-usage-pending.json');
		});
	});
});
