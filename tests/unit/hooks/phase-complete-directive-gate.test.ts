/** V2 exact-pair phase critical gate integration tests. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	commitPhaseClosed,
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	evaluatePhaseCriticalDirectives,
	formatDirectiveBlockMessage,
	recordDirectiveOverrides,
} from '../../../src/hooks/phase-complete-directive-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PHASE = 'Canonical phase description';
const ENTRY = 'critical-rule';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('phase-critical-v2-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

async function display(
	trace_id: string,
	entry_id = ENTRY,
	critical = true,
	session_id = 'session-a',
): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id,
		session_id,
		phase: PHASE,
		entries: [{ entry_id, critical }],
	});
	if (!result.ok) throw new Error(result.detail);
}

async function terminal(
	trace_id: string,
	outcome: 'applied' | 'ignored' | 'n_a' | 'violated' | 'contradicted',
	reason?: string,
): Promise<void> {
	const result = await validateAndCommitTerminalBatch(directory, {
		trace_id,
		session_id: 'session-a',
		items: [{ entry_id: ENTRY, outcome, reason }],
	});
	if (!result.ok || result.rejected.length > 0) {
		throw new Error('terminal fixture failed');
	}
}

describe('evaluatePhaseCriticalDirectives V2 authority', () => {
	it('blocks an unresolved exact pair', async () => {
		await display('trace-open');

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});

		expect(result).toMatchObject({ blocked: true, failedClosed: false });
		expect(result.unresolved).toEqual([
			{ id: ENTRY, trace_id: 'trace-open', reason: 'no_verdict' },
		]);
	});

	it('does not let a terminal on one trace hide the repeated entry on another', async () => {
		await display('trace-closed');
		await display('trace-open');
		await terminal('trace-closed', 'applied');

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});

		expect(result.unresolved).toEqual([
			{ id: ENTRY, trace_id: 'trace-open', reason: 'no_verdict' },
		]);
	});

	it('evaluates only the caller session when two sessions share a phase', async () => {
		await display('trace-session-a');
		await terminal('trace-session-a', 'applied');
		await display('trace-session-b', ENTRY, true, 'session-b');

		const sessionA = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		const sessionB = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-b',
			phaseLabel: PHASE,
		});

		expect(sessionA).toMatchObject({ blocked: false, failedClosed: false });
		expect(sessionB.unresolved).toEqual([
			{ id: ENTRY, trace_id: 'trace-session-b', reason: 'no_verdict' },
		]);
	});

	it('accepts applied and reasoned ignored/n_a terminals', async () => {
		for (const [index, outcome] of ['applied', 'ignored', 'n_a'].entries()) {
			const trace = `trace-${outcome}`;
			await display(trace, `entry-${index}`);
			const committed = await validateAndCommitTerminalBatch(directory, {
				trace_id: trace,
				session_id: 'session-a',
				items: [
					{
						entry_id: `entry-${index}`,
						outcome: outcome as 'applied' | 'ignored' | 'n_a',
						reason: outcome === 'applied' ? undefined : 'explicit rationale',
					},
				],
			});
			if (!committed.ok) throw new Error(committed.detail);
		}

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(result).toMatchObject({ blocked: false, failedClosed: false });
	});

	it('blocks violated and unreasoned neutral terminals', async () => {
		await display('trace-violated');
		await terminal('trace-violated', 'violated', 'reviewer found a defect');
		await display('trace-neutral', 'neutral-entry');
		const neutral = await validateAndCommitTerminalBatch(directory, {
			trace_id: 'trace-neutral',
			session_id: 'session-a',
			items: [{ entry_id: 'neutral-entry', outcome: 'n_a' }],
		});
		if (!neutral.ok) throw new Error(neutral.detail);

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(result.unresolved).toEqual([
			{
				id: ENTRY,
				trace_id: 'trace-violated',
				reason: 'unremediated_violation',
			},
			{ id: 'neutral-entry', trace_id: 'trace-neutral', reason: 'no_verdict' },
		]);
	});

	it('ignores noncritical memberships and filters by the canonical phase label', async () => {
		await display('trace-noncritical', ENTRY, false);
		const other = await commitDisplayedMembership(directory, {
			trace_id: 'trace-other-phase',
			session_id: 'session-a',
			phase: 'Different phase',
			entries: [{ entry_id: ENTRY, critical: true }],
		});
		if (!other.ok) throw new Error(other.detail);

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(result.blocked).toBe(false);
	});

	it('fails closed when authoritative receipt state is corrupt', async () => {
		await display('trace-corrupt');
		writeFileSync(
			path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'corrupt\n',
		);

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(result).toEqual({
			blocked: true,
			unresolved: [],
			overridden: [],
			failedClosed: true,
		});
	});

	it('fails closed when the caller session is absent', async () => {
		await display('trace-missing-session');

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			phaseLabel: PHASE,
		});

		expect(result).toEqual({
			blocked: true,
			unresolved: [],
			overridden: [],
			failedClosed: true,
		});
	});

	it('does not let a force-closed prior lifecycle contaminate a later phase gate', async () => {
		await display('trace-force-closed');
		expect((await commitPhaseClosed(directory, PHASE)).ok).toBe(true);

		const result = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(result).toMatchObject({ blocked: false, failedClosed: false });
	});
});

describe('recordDirectiveOverrides', () => {
	it('persists the authorized transition before the gate accepts it', async () => {
		await display('trace-override');
		await terminal('trace-override', 'violated', 'known violation');

		await recordDirectiveOverrides(
			directory,
			[ENTRY],
			'Architect accepts this known phase risk',
			'session-a',
			PHASE,
		);

		const state = await queryLiveMemberships(directory, {
			phase: PHASE,
			include_terminal: true,
		});
		expect(
			state.ok &&
				state.memberships[0]?.terminal?.authorized_transition?.actor ===
					'phase-override',
		).toBe(true);
		const gate = await evaluatePhaseCriticalDirectives({
			directory,
			sessionId: 'session-a',
			phaseLabel: PHASE,
		});
		expect(gate).toMatchObject({
			blocked: false,
			overridden: [ENTRY],
			failedClosed: false,
		});
	});

	it('requires a written justification', async () => {
		await display('trace-override');
		await expect(
			recordDirectiveOverrides(directory, [ENTRY], ' ', 'session-a', PHASE),
		).rejects.toThrow(/written justification/);
	});

	it('fails closed instead of selecting a target without a caller session', async () => {
		await display('trace-override');

		await expect(
			recordDirectiveOverrides(
				directory,
				[ENTRY],
				'Architect supplies a substantive risk justification',
				undefined,
				PHASE,
			),
		).rejects.toThrow(/exact session and phase identity/);

		const state = await queryLiveMemberships(directory, {
			phase: PHASE,
			session_id: 'session-a',
			include_terminal: true,
		});
		expect(state.ok && state.memberships[0]?.terminal).toBeUndefined();
	});

	it('does not let one session override another session in the same phase', async () => {
		await display('trace-session-b', ENTRY, true, 'session-b');
		const violated = await validateAndCommitTerminalBatch(directory, {
			trace_id: 'trace-session-b',
			session_id: 'session-b',
			items: [
				{ entry_id: ENTRY, outcome: 'violated', reason: 'known violation' },
			],
		});
		if (!violated.ok) throw new Error(violated.detail);

		await expect(
			recordDirectiveOverrides(
				directory,
				['trace-session-b/critical-rule'],
				'Session A cannot accept session B risk',
				'session-a',
				PHASE,
			),
		).rejects.toThrow(/unknown directive override target/);

		const state = await queryLiveMemberships(directory, {
			phase: PHASE,
			session_id: 'session-b',
			include_terminal: true,
		});
		expect(state.ok && state.memberships[0]?.terminal?.outcome).toBe(
			'violated',
		);
		expect(
			state.ok &&
				state.memberships[0]?.terminal?.authorized_transition === undefined,
		).toBe(true);
	});

	it('rejects an unknown override target instead of silently accepting nothing', async () => {
		await display('trace-known');
		await expect(
			recordDirectiveOverrides(
				directory,
				['missing-entry'],
				'Architect supplies a substantive risk justification',
				'session-a',
				PHASE,
			),
		).rejects.toThrow(/unknown directive override target/);
	});
});

describe('formatDirectiveBlockMessage', () => {
	it('renders both the entry and reason', () => {
		const message = formatDirectiveBlockMessage([
			{ id: ENTRY, trace_id: 'trace-a', reason: 'unremediated_violation' },
		]);
		expect(message).toContain(ENTRY);
		expect(message).toContain('trace-a/');
		expect(message).toContain('violated with no subsequent');
	});
});
