import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	commitDisplayedMembership,
	commitPhaseClosed,
	ensureLegacyCutover,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	recordPhaseCloseIntent,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { receiptRecordHash } from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';
import { freezeClock } from '../../helpers/test-clock.js';

const cleanups: Array<() => void> = [];
const originalWriteSnapshot = _internals.writeSnapshot;
const originalAtomicWrite = _internals.atomicWriteFsynced;
const originalMaxArchiveRecords = _internals.maxArchiveRecords;
const originalMaxArchiveBytes = _internals.maxArchiveBytes;
const FIXED_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';
let restoreClock: (() => void) | undefined;

afterEach(() => {
	restoreClock?.();
	restoreClock = undefined;
	_internals.writeSnapshot = originalWriteSnapshot;
	_internals.atomicWriteFsynced = originalAtomicWrite;
	_internals.maxArchiveRecords = originalMaxArchiveRecords;
	_internals.maxArchiveBytes = originalMaxArchiveBytes;
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

function journalPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl');
}

describe('knowledge receipt ledger durability regressions', () => {
	test('keeps a journal commit successful when the rebuildable snapshot write fails', async () => {
		const directory = project('receipt-snapshot-nonauthority-');
		// Previous code returned store_unavailable after the membership journal row
		// was durable, causing callers to suppress a now-authoritative exposure.
		_internals.writeSnapshot = async () => {
			throw new Error('injected derived snapshot failure');
		};
		const committed = await commitDisplayedMembership(directory, {
			trace_id: 'trace-snapshot',
			session_id: 'session-snapshot',
			entries: [{ entry_id: 'entry-snapshot', critical: true }],
		});
		expect(committed.ok).toBe(true);

		_internals.writeSnapshot = originalWriteSnapshot;
		const live = unwrap(await queryLiveMemberships(directory));
		expect(live.memberships.map((item) => item.entry_id)).toEqual([
			'entry-snapshot',
		]);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2.snapshot.json'),
			),
		).toBe(false);
	});

	test('reloads multiple terminalized traces without poisoning the strict schema', async () => {
		const directory = project('receipt-multi-trace-reload-');
		for (const traceId of ['trace-one', 'trace-two']) {
			unwrap(
				await commitDisplayedMembership(directory, {
					trace_id: traceId,
					session_id: 'session-multi',
					// `delegate` was emitted by the short-lived pre-schema producer. Before
					// normalization it wrote a row that failed strict reload on the next trace.
					exposure_kind:
						traceId === 'trace-one'
							? ('delegate' as 'delegate_directive')
							: 'delegate_directive',
					entries: [{ entry_id: 'shared-entry', critical: false }],
				}),
			);
			unwrap(
				await validateAndCommitTerminalBatch(directory, {
					trace_id: traceId,
					session_id: 'session-multi',
					items: [{ entry_id: 'shared-entry', outcome: 'applied' }],
				}),
			);
		}
		const history = unwrap(
			await queryHistoricalOutcomes(directory, ['shared-entry']),
		);
		expect(history.memberships.map((item) => item.trace_id).sort()).toEqual([
			'trace-one',
			'trace-two',
		]);
	});

	test('makes phase lifecycle retries idempotent without resetting grace timestamps', async () => {
		const directory = project('receipt-phase-idempotent-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-phase',
				session_id: 'session-phase',
				phase: 'phase-idempotent',
				entries: [{ entry_id: 'entry-phase', critical: true }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-phase',
				session_id: 'session-phase',
				items: [{ entry_id: 'entry-phase', outcome: 'applied' }],
			}),
		);
		const intent = unwrap(
			await recordPhaseCloseIntent(directory, 'phase-idempotent'),
		);
		const intentRetry = unwrap(
			await recordPhaseCloseIntent(directory, 'phase-idempotent'),
		);
		const closed = unwrap(
			await commitPhaseClosed(directory, 'phase-idempotent'),
		);
		const firstTimestamp = unwrap(await queryLiveMemberships(directory))
			.memberships[0]?.phase_closed_at;
		const closedRetry = unwrap(
			await commitPhaseClosed(directory, 'phase-idempotent'),
		);
		const secondTimestamp = unwrap(await queryLiveMemberships(directory))
			.memberships[0]?.phase_closed_at;

		expect(intentRetry.event_id).toBe(intent.event_id);
		expect(closedRetry.event_id).toBe(closed.event_id);
		expect(secondTimestamp).toBe(firstTimestamp);
		const kinds = fs
			.readFileSync(journalPath(directory), 'utf8')
			.trim()
			.split('\n')
			.map((line) => (JSON.parse(line) as { kind: string }).kind);
		expect(kinds.filter((kind) => kind === 'phase_close_intent')).toHaveLength(
			1,
		);
		expect(kinds.filter((kind) => kind === 'phase_closed')).toHaveLength(1);
	});

	test('types an evicted pre-cutover trace uncertain even after V2 activity starts', async () => {
		restoreClock = freezeClock({
			fixedNow: FIXED_NOW_MS,
			isoNow: FIXED_NOW_ISO,
		});
		const directory = project('receipt-legacy-evicted-');
		fs.mkdirSync(path.join(directory, '.swarm'));
		fs.writeFileSync(
			path.join(directory, '.swarm', 'knowledge-events.jsonl'),
			`${JSON.stringify({
				type: 'applied',
				trace_id: 'evicted-trace',
				knowledge_id: 'evicted-entry',
				session_id: 'legacy-session',
				event_id: 'legacy-terminal',
				timestamp: new Date().toISOString(),
			})}\n`,
		);
		unwrap(await ensureLegacyCutover(directory));
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'v2-trace',
				session_id: 'v2-session',
				entries: [{ entry_id: 'v2-entry', critical: false }],
			}),
		);
		const result = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'evicted-trace',
				session_id: 'legacy-session',
				items: [{ entry_id: 'evicted-entry', outcome: 'applied' }],
			}),
		);
		expect(result.rejected[0]?.reason).toBe('legacy_unverifiable');
	});

	test('drains the explicit imported trace registry after archival', async () => {
		restoreClock = freezeClock({
			fixedNow: FIXED_NOW_MS,
			isoNow: FIXED_NOW_ISO,
		});
		const directory = project('receipt-legacy-drain-');
		fs.mkdirSync(path.join(directory, '.swarm'));
		const timestamp = new Date().toISOString();
		const events = [
			{
				type: 'retrieved',
				trace_id: 'legacy-live',
				session_id: 'legacy-session',
				phase: 'legacy-phase',
				result_ids: ['legacy-entry'],
				event_id: 'legacy-membership',
				timestamp,
				retrieval_mode: 'manual',
			},
			{
				type: 'applied',
				trace_id: 'legacy-live',
				knowledge_id: 'legacy-entry',
				session_id: 'legacy-session',
				event_id: 'legacy-terminal',
				timestamp,
				source: 'reviewer',
			},
		];
		fs.writeFileSync(
			path.join(directory, '.swarm', 'knowledge-events.jsonl'),
			`${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
		);
		unwrap(await ensureLegacyCutover(directory, 0));
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'knowledge-receipts-v2.snapshot.json'),
					'utf8',
				),
			).legacy_trace_registry,
		).toEqual(['legacy-live']);
		unwrap(await commitPhaseClosed(directory, 'legacy-phase'));
		const snapshot = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2.snapshot.json'),
				'utf8',
			),
		) as { legacy_trace_registry: string[] };
		expect(snapshot.legacy_trace_registry).toEqual([]);
		expect(
			unwrap(await queryHistoricalOutcomes(directory, ['legacy-entry']))
				.memberships,
		).toHaveLength(1);
	});

	test('retains overflow authority live instead of dropping old archive summaries', async () => {
		const directory = project('receipt-archive-cap-');
		_internals.maxArchiveRecords = 1;
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-cap',
				session_id: 'session-cap',
				phase: 'phase-cap',
				grace_days: 0,
				entries: [
					{ entry_id: 'entry-one', critical: false },
					{ entry_id: 'entry-two', critical: false },
				],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-cap',
				session_id: 'session-cap',
				items: [
					{ entry_id: 'entry-one', outcome: 'applied' },
					{ entry_id: 'entry-two', outcome: 'applied' },
				],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'phase-cap'));
		expect(
			unwrap(await queryLiveMemberships(directory)).memberships,
		).toHaveLength(1);
		expect(
			unwrap(await queryHistoricalOutcomes(directory)).memberships,
		).toHaveLength(2);
		const archiveLines = fs
			.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2-archive.jsonl'),
				'utf8',
			)
			.trim()
			.split('\n');
		expect(archiveLines).toHaveLength(1);
	});

	test('recovers an archive-first checkpoint crash without duplicate history', async () => {
		const directory = project('receipt-archive-crash-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-crash',
				session_id: 'session-crash',
				phase: 'phase-crash',
				grace_days: 0,
				entries: [{ entry_id: 'entry-crash', critical: false }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-crash',
				session_id: 'session-crash',
				items: [{ entry_id: 'entry-crash', outcome: 'applied' }],
			}),
		);
		let archiveWritten = false;
		_internals.atomicWriteFsynced = async (target, content) => {
			if (target.endsWith('knowledge-receipts-v2-archive.jsonl')) {
				archiveWritten = true;
			}
			if (archiveWritten && target.endsWith('knowledge-receipts-v2.jsonl')) {
				throw new Error('injected checkpoint crash');
			}
			await originalAtomicWrite(target, content);
		};
		const close = await commitPhaseClosed(directory, 'phase-crash');
		expect(close.ok).toBe(false);
		expect(archiveWritten).toBe(true);

		_internals.atomicWriteFsynced = originalAtomicWrite;
		const history = unwrap(
			await queryHistoricalOutcomes(directory, ['entry-crash']),
		);
		expect(history.memberships).toHaveLength(1);
		expect(history.memberships[0]?.terminal?.outcome).toBe('applied');
	});

	test('serializes compaction racing a late terminal without losing either pair', async () => {
		const directory = project('receipt-compaction-terminal-race-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-race',
				session_id: 'session-race',
				phase: 'phase-race',
				grace_days: 0,
				entries: [
					{ entry_id: 'entry-ready', critical: false },
					{ entry_id: 'entry-late', critical: false },
				],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-race',
				session_id: 'session-race',
				items: [{ entry_id: 'entry-ready', outcome: 'applied' }],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'phase-race'));
		const [terminal] = await Promise.all([
			validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-race',
				session_id: 'session-race',
				items: [{ entry_id: 'entry-late', outcome: 'applied' }],
			}),
			queryHistoricalOutcomes(directory),
		]);
		expect(terminal.ok).toBe(true);
		const history = unwrap(await queryHistoricalOutcomes(directory));
		expect(history.memberships.map((item) => item.entry_id).sort()).toEqual([
			'entry-late',
			'entry-ready',
		]);
		unwrap(await ensureLegacyCutover(directory, 1));
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
	});

	test('rejects arbitrary nested predicate state before it reaches any artifact', async () => {
		const directory = project('receipt-schema-private-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-private',
				session_id: 'session-private',
				entries: [{ entry_id: 'entry-private', critical: false }],
			}),
		);
		const result = await validateAndCommitTerminalBatch(directory, {
			trace_id: 'trace-private',
			session_id: 'session-private',
			items: [
				{
					entry_id: 'entry-private',
					outcome: 'violated',
					predicate_check: {
						predicate: 'test -f file',
						result: 'fail',
						detail: 'missing',
						nonTransientCircuit: { stopped: true },
					},
				},
			],
		} as Parameters<typeof validateAndCommitTerminalBatch>[1]);
		expect(result.ok).toBe(false);
		for (const file of fs.readdirSync(path.join(directory, '.swarm'))) {
			const artifact = path.join(directory, '.swarm', file);
			if (!fs.statSync(artifact).isFile()) continue;
			expect(fs.readFileSync(artifact, 'utf8')).not.toContain(
				'nonTransientCircuit',
			);
		}
	});

	test('fails closed when a hash-valid journal row contains an unknown nested field', async () => {
		restoreClock = freezeClock({
			fixedNow: FIXED_NOW_MS,
			isoNow: FIXED_NOW_ISO,
		});
		const directory = project('receipt-schema-poison-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-poison',
				session_id: 'session-poison',
				entries: [{ entry_id: 'entry-poison', critical: false }],
			}),
		);
		const rows = fs
			.readFileSync(journalPath(directory), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const tail = rows.at(-1) as { seq: number; hash: string };
		const withoutHash = {
			schema_version: 2,
			cutover_version: 1,
			seq: tail.seq + 1,
			prev_hash: tail.hash,
			event_id: 'poison-event',
			timestamp: new Date().toISOString(),
			kind: 'terminal_committed',
			payload: {
				transitions: [
					{
						trace_id: 'trace-poison',
						entry_id: 'entry-poison',
						terminal: {
							outcome: 'violated',
							source: 'reviewer',
							event_id: 'poison-terminal',
							committed_at: new Date().toISOString(),
							predicate_check: {
								predicate: 'test',
								result: 'fail',
								detail: 'bad',
								evidence: { secret: true },
							},
						},
					},
				],
			},
		};
		fs.appendFileSync(
			journalPath(directory),
			`${JSON.stringify({
				...withoutHash,
				hash: receiptRecordHash(withoutHash),
			})}\n`,
		);
		const result = await queryLiveMemberships(directory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected corrupt store');
		expect(result.code).toBe('store_corrupt');
	});
});
