import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	_internals,
	commitApplicationOutcomeBatch,
	commitDisplayedMembership,
	commitEmptyRetrieval,
	commitPhaseClosed,
	ensureLegacyCutover,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { _internals as observationInternals } from '../../../src/hooks/knowledge-receipt-observability.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];
const originalNowMs = _internals.nowMs;
const originalWriteSnapshot = _internals.writeSnapshot;
const originalEmit = observationInternals.emit;

function project(): string {
	const fixture = createSafeTestDir('receipt-feedback-');
	cleanups.push(fixture.cleanup);
	writeFileSync(join(fixture.dir, '.git'), 'gitdir: fixture');
	return fixture.dir;
}

afterEach(() => {
	_internals.nowMs = originalNowMs;
	_internals.writeSnapshot = originalWriteSnapshot;
	observationInternals.emit = originalEmit;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('knowledge receipt feedback regressions', () => {
	test('uses the injected clock for authoritative record timestamps', async () => {
		const directory = project();
		const fixedNow = Date.parse('2026-08-14T12:00:00.000Z');
		_internals.nowMs = () => fixedNow;

		const committed = await commitDisplayedMembership(directory, {
			trace_id: 'trace-clock',
			session_id: 'session-clock',
			entries: [{ entry_id: 'entry-clock', critical: true }],
		});
		expect(committed.ok).toBe(true);

		const records = readFileSync(
			join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'utf8',
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { timestamp: string });
		expect(
			records.every((row) => row.timestamp === '2026-08-14T12:00:00.000Z'),
		).toBe(true);
	});

	test('authoritative reads do not rewrite the rebuildable snapshot', async () => {
		const directory = project();
		await commitDisplayedMembership(directory, {
			trace_id: 'trace-read',
			session_id: 'session-read',
			entries: [{ entry_id: 'entry-read', critical: false }],
		});
		let snapshotWrites = 0;
		_internals.writeSnapshot = async (...args) => {
			snapshotWrites += 1;
			return originalWriteSnapshot(...args);
		};

		const queried = await queryLiveMemberships(directory);
		expect(queried.ok).toBe(true);
		expect(snapshotWrites).toBe(0);
	});

	test('rejects caller event IDs that collide with any authority namespace', async () => {
		const directory = project();
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: 'trace-collision',
			session_id: 'session-collision',
			phase: 'phase-collision',
			entries: [
				{ entry_id: 'entry-one', critical: true },
				{ entry_id: 'entry-two', critical: true },
				{ entry_id: 'entry-three', critical: true },
			],
		});
		if (!displayed.ok) throw new Error(displayed.detail);

		const application = await commitApplicationOutcomeBatch(directory, {
			trace_id: 'trace-collision',
			session_id: 'session-collision',
			items: [{ entry_id: 'entry-one', outcome: 'applied' }],
		});
		if (!application.ok) throw new Error(application.detail);
		const empty = await commitEmptyRetrieval(directory, {
			trace_id: 'trace-empty',
			session_id: 'session-collision',
		});
		if (!empty.ok) throw new Error(empty.detail);
		const closed = await commitPhaseClosed(
			directory,
			'phase-collision',
			'session-collision',
		);
		if (!closed.ok) throw new Error(closed.detail);

		for (const eventId of [
			displayed.event_id,
			application.committed[0].marker_event_id,
			empty.event_id,
			empty.terminal_event_id,
			closed.event_id,
		]) {
			const result = await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-collision',
				session_id: 'session-collision',
				items: [
					{ entry_id: 'entry-two', outcome: 'ignored', event_id: eventId },
				],
			});
			if (!result.ok) throw new Error(result.detail);
			expect(result.rejected).toEqual([
				{ entry_id: 'entry-two', reason: 'event_id_conflict' },
			]);
		}

		const duplicateBatchId = 'caller-event-shared-in-one-batch';
		const duplicateBatch = await validateAndCommitTerminalBatch(directory, {
			trace_id: 'trace-collision',
			session_id: 'session-collision',
			items: [
				{
					entry_id: 'entry-two',
					outcome: 'ignored',
					event_id: duplicateBatchId,
				},
				{
					entry_id: 'entry-three',
					outcome: 'ignored',
					event_id: duplicateBatchId,
				},
			],
		});
		if (!duplicateBatch.ok) throw new Error(duplicateBatch.detail);
		expect(duplicateBatch.accepted).toEqual([
			expect.objectContaining({
				entry_id: 'entry-two',
				event_id: duplicateBatchId,
			}),
		]);
		expect(duplicateBatch.rejected).toEqual([
			{ entry_id: 'entry-three', reason: 'event_id_conflict' },
		]);
	});

	test('compacts elapsed grace only on a later mutation and observes the checkpoint', async () => {
		const directory = project();
		const base = Date.parse('2026-08-01T00:00:00.000Z');
		const observed: Array<Record<string, unknown>> = [];
		observationInternals.emit = ((_event, data) => {
			observed.push(data);
		}) as typeof observationInternals.emit;
		_internals.nowMs = () => base;
		await commitDisplayedMembership(directory, {
			trace_id: 'trace-lazy',
			session_id: 'session-lazy',
			phase: 'phase-lazy',
			grace_days: 1,
			entries: [{ entry_id: 'entry-lazy', critical: false }],
		});
		await validateAndCommitTerminalBatch(directory, {
			trace_id: 'trace-lazy',
			session_id: 'session-lazy',
			items: [{ entry_id: 'entry-lazy', outcome: 'ignored' }],
		});
		await commitPhaseClosed(directory, 'phase-lazy', 'session-lazy');

		_internals.nowMs = () => base + 2 * 86_400_000;
		expect((await queryLiveMemberships(directory)).ok).toBe(true);
		await ensureLegacyCutover(directory, 1);
		const live = await queryLiveMemberships(directory);
		if (!live.ok) throw new Error(live.detail);
		expect(live.memberships).toEqual([]);
		expect(observed.map((entry) => entry.transition)).toContain('checkpoint');
		const historical = await queryHistoricalOutcomes(directory, ['entry-lazy']);
		if (!historical.ok) throw new Error(historical.detail);
		expect(historical.memberships).toHaveLength(1);
	});
});
