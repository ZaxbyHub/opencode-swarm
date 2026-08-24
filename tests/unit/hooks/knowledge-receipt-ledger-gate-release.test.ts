import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	commitDisplayedMembership,
	commitGateReleaseBatch,
	commitPhaseClosed,
	compactKnowledgeReceiptLedger,
	_internals as ledgerInternals,
	queryHistoricalOutcomes,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('knowledge receipt ledger gate releases', () => {
	let directory: string;
	let realNow: typeof ledgerInternals.nowMs;

	beforeEach(() => {
		directory = canonicalMkdtemp('receipt-gate-release-');
		writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
		realNow = ledgerInternals.nowMs;
	});

	afterEach(() => {
		ledgerInternals.nowMs = realNow;
		rmSync(directory, { recursive: true, force: true });
	});

	test('same membership release is idempotent and keeps the original event id', async () => {
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: 'trace-release',
			session_id: 'session-release',
			phase: 'phase-release',
			entries: [{ entry_id: 'entry-release', critical: true }],
		});
		if (!displayed.ok) throw new Error(displayed.detail);

		const first = await commitGateReleaseBatch(directory, {
			trace_id: 'trace-release',
			session_id: 'session-release',
			items: [
				{
					entry_id: 'entry-release',
					source: 'application_gate_staleness_release',
					reason: 'stale',
				},
			],
		});
		if (!first.ok) throw new Error(first.detail);
		expect(first.committed).toHaveLength(1);

		const retry = await commitGateReleaseBatch(directory, {
			trace_id: 'trace-release',
			session_id: 'session-release',
			items: [
				{
					entry_id: 'entry-release',
					source: 'application_gate_staleness_release',
					reason: 'stale',
				},
			],
		});
		if (!retry.ok) throw new Error(retry.detail);
		expect(retry.idempotent).toEqual([
			{
				entry_id: 'entry-release',
				event_id: first.committed[0]?.event_id,
			},
		]);
	});

	test('release survives compaction and archive queries without becoming terminal history', async () => {
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: 'trace-archive',
			session_id: 'session-archive',
			phase: 'phase-archive',
			entries: [{ entry_id: 'entry-archive', critical: true }],
			grace_days: 0,
		});
		if (!displayed.ok) throw new Error(displayed.detail);

		const released = await commitGateReleaseBatch(directory, {
			trace_id: 'trace-archive',
			session_id: 'session-archive',
			grace_days: 0,
			items: [
				{
					entry_id: 'entry-archive',
					source: 'application_gate_denial_limit_release',
					reason: 'denials exceeded',
				},
			],
		});
		if (!released.ok) throw new Error(released.detail);

		await commitPhaseClosed(
			directory,
			'phase-archive',
			'session-archive',
			undefined,
		);
		ledgerInternals.nowMs = () => Date.parse('2030-01-01T00:00:00.000Z');
		const compacted = await compactKnowledgeReceiptLedger(directory);
		if (!compacted.ok) throw new Error(compacted.detail);

		const live = await queryLiveMemberships(directory, {
			include_terminal: true,
		});
		if (!live.ok) throw new Error(live.detail);
		expect(live.memberships).toHaveLength(0);

		const history = await queryHistoricalOutcomes(directory, ['entry-archive']);
		if (!history.ok) throw new Error(history.detail);
		expect(history.memberships).toHaveLength(1);
		expect(history.memberships[0]?.gate_release).toMatchObject({
			source: 'application_gate_denial_limit_release',
			membership_event_id: displayed.memberships[0]?.membership_event_id,
		});
		expect(history.memberships[0]?.terminal).toBeUndefined();
		expect(history.memberships[0]?.application_marker).toBeUndefined();
	});
});
