import { afterEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	commitApplicationOutcomeBatch,
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

function project(): string {
	const directory = canonicalMkdtemp('receipt-app-outcome-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	directories.push(directory);
	return directory;
}

async function display(
	directory: string,
	traceId = 'trace-app',
): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id: traceId,
		session_id: 'session-app',
		entries: [{ entry_id: 'entry-app', critical: true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('atomically commits marker and terminal with stable authoritative ids', async () => {
	const directory = project();
	await display(directory);
	const first = await commitApplicationOutcomeBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [
			{
				entry_id: 'entry-app',
				outcome: 'ignored',
				source: 'architect_marker',
				reason: 'not relevant here',
			},
		],
	});
	if (!first.ok) throw new Error(first.detail);
	expect(first.committed).toHaveLength(1);
	const committed = first.committed[0];
	const state = await queryLiveMemberships(directory, {
		include_terminal: true,
	});
	if (!state.ok) throw new Error(state.detail);
	expect(state.memberships[0]?.application_marker).toMatchObject({
		outcome: 'ignored',
		reason: 'not relevant here',
		event_id: committed.marker_event_id,
	});
	expect(state.memberships[0]?.terminal).toMatchObject({
		outcome: 'ignored',
		reason: 'not relevant here',
		event_id: committed.terminal_event_id,
	});

	const retry = await commitApplicationOutcomeBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'ignored' }],
	});
	if (!retry.ok) throw new Error(retry.detail);
	expect(retry.idempotent).toEqual([committed]);
});

test('does not leave a marker behind when terminal validation rejects', async () => {
	const directory = project();
	await display(directory);
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'applied' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);

	const conflict = await commitApplicationOutcomeBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'ignored' }],
	});
	if (!conflict.ok) throw new Error(conflict.detail);
	expect(conflict.rejected).toEqual([
		{ entry_id: 'entry-app', reason: 'duplicate_conflicting_terminal' },
	]);
	const state = await queryLiveMemberships(directory, {
		include_terminal: true,
	});
	if (!state.ok) throw new Error(state.detail);
	expect(state.memberships[0]?.application_marker).toBeUndefined();
	expect(state.memberships[0]?.terminal?.outcome).toBe('applied');
});

test('repairs a legacy marker-only pair without replacing its marker', async () => {
	const directory = project();
	await display(directory);
	const marker = await ledgerInternals.commitApplicationMarkerBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [
			{
				entry_id: 'entry-app',
				outcome: 'n_a',
				reason: 'different subsystem',
			},
		],
	});
	if (!marker.ok) throw new Error(marker.detail);
	const markerEventId = marker.committed[0]?.event_id;

	const repaired = await commitApplicationOutcomeBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'n_a' }],
	});
	if (!repaired.ok) throw new Error(repaired.detail);
	expect(repaired.committed[0]?.marker_event_id).toBe(markerEventId);
	const state = await queryLiveMemberships(directory, {
		include_terminal: true,
	});
	if (!state.ok) throw new Error(state.detail);
	expect(state.memberships[0]?.application_marker?.event_id).toBe(
		markerEventId,
	);
	expect(state.memberships[0]?.terminal?.outcome).toBe('n_a');
});

test('authorized remediation compares both the prior event and prior outcome', async () => {
	const directory = project();
	await display(directory);
	const violated = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'violated' }],
	});
	if (!violated.ok) throw new Error(violated.detail);
	const priorEventId = violated.accepted[0]?.event_id ?? '';

	const staleOutcome = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'applied' }],
		authorization: {
			actor: 'reviewer-remediation',
			reason: 'reviewer_verified_remediation',
			expected_event_id: priorEventId,
			expected_outcome: 'applied',
		},
	});
	if (!staleOutcome.ok) throw new Error(staleOutcome.detail);
	expect(staleOutcome.rejected[0]?.reason).toBe(
		'duplicate_conflicting_terminal',
	);

	const remediated = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-app',
		session_id: 'session-app',
		items: [{ entry_id: 'entry-app', outcome: 'applied' }],
		authorization: {
			actor: 'reviewer-remediation',
			reason: 'reviewer_verified_remediation',
			expected_event_id: priorEventId,
			expected_outcome: 'violated',
		},
	});
	if (!remediated.ok) throw new Error(remediated.detail);
	expect(remediated.accepted).toHaveLength(1);
	const state = await queryLiveMemberships(directory, {
		include_terminal: true,
	});
	if (!state.ok) throw new Error(state.detail);
	expect(state.memberships[0]?.terminal?.authorized_transition).toMatchObject({
		actor: 'reviewer-remediation',
		previous_event_id: priorEventId,
		previous_outcome: 'violated',
	});
});
