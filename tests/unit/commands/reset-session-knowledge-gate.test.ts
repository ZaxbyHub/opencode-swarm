/** /swarm reset-session must release pending knowledge gate obligations (#2398).
 *
 * Before #2398 the command cleared no knowledge-application gate state: the
 * receipt ledger kept the session's pending architect-directive obligations
 * and the in-memory denial counters survived, so the operator's documented
 * reset was not an escape from an enforce-mode lockout.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../../src/commands/reset-session.js';
import { DEFAULT_KNOWLEDGE_APPLICATION_CONFIG } from '../../../src/hooks/knowledge-application.js';
import { knowledgeApplicationGateBefore } from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY = 'eeeeeeee-eeee-4eee-9eee-eeeeeeeeeeee';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('reset-session-gate-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

async function display(
	trace_id: string,
	session_id = 'session-a',
): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id,
		session_id,
		exposure_kind: 'architect_directive',
		entries: [{ entry_id: ENTRY, critical: true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

async function gateDenies(session_id = 'session-a'): Promise<boolean> {
	try {
		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'save_plan', agent: 'architect', sessionID: session_id },
			{ ...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG, mode: 'enforce' as const },
		);
		return false;
	} catch {
		return true;
	}
}

describe('/swarm reset-session knowledge gate escape (#2398)', () => {
	it('releases the invoking session obligations, preserves other sessions, and clears in-memory gate state', async () => {
		await display('trace-blocked');
		await display('trace-other', 'session-b');
		expect(await gateDenies()).toBe(true);
		swarmState.currentCriticalShownIds.set('session-a', {
			ids: [ENTRY],
			// Fixed instant instead of the wall clock: this is a plain fixture
			// value, and the test-clock lint (issue #1782) blocks raw clock
			// reads in test files that do not adopt freezeClock.
			generatedAt: 1_700_000_000_000,
		});

		const summary = await handleResetSessionCommand(directory, [], 'session-a');

		expect(summary).toContain('Released 1 pending knowledge gate obligation');
		expect(swarmState.gateDenialCounts.size).toBe(0);
		expect(swarmState.currentCriticalShownIds.size).toBe(0);

		const state = await queryLiveMemberships(directory, {
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		const blocked = state.memberships.find(
			(membership) => membership.trace_id === 'trace-blocked',
		);
		const other = state.memberships.find(
			(membership) => membership.trace_id === 'trace-other',
		);
		expect(blocked?.gate_release?.source).toBe(
			'application_gate_session_reset_release',
		);
		// Only the invoking session is released — the operator reset is not a
		// project-wide obligation wipe.
		expect(other?.gate_release).toBeUndefined();

		expect(await gateDenies()).toBe(false);
		expect(await gateDenies('session-b')).toBe(true);

		expect(
			readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8'),
		).toContain('knowledge_application_gate_session_reset_clear');
	});

	it('leaves acknowledged markers untouched', async () => {
		await display('trace-acked');
		const marked = await ledgerInternals.commitApplicationMarkerBatch(
			directory,
			{
				trace_id: 'trace-acked',
				session_id: 'session-a',
				items: [
					{ entry_id: ENTRY, outcome: 'applied', source: 'architect_marker' },
				],
			},
		);
		if (!marked.ok) throw new Error(marked.detail);

		const summary = await handleResetSessionCommand(directory, [], 'session-a');

		expect(summary).toContain('No pending knowledge gate obligations');
		const state = await queryLiveMemberships(directory, {
			session_id: 'session-a',
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		expect(state.memberships[0]?.gate_release).toBeUndefined();
		expect(state.memberships[0]?.application_marker?.outcome).toBe('applied');
	});

	it('warns and still completes when invoked without session context', async () => {
		const summary = await handleResetSessionCommand(directory, []);

		expect(summary).toContain('no session context on this invocation');
		expect(summary).toContain('Session state cleared');
	});

	it('completes fail-open when the receipt ledger is corrupt', async () => {
		await display('trace-corrupt');
		writeFileSync(
			path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'not-json\n',
		);

		const summary = await handleResetSessionCommand(directory, [], 'session-a');

		expect(summary).toContain('⚠️ Knowledge gate state not cleared');
		expect(summary).toContain('Session state cleared');
	});
});
