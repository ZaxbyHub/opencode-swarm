/** Exact membership identity regressions for denial-count escape state. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_KNOWLEDGE_APPLICATION_CONFIG } from '../../../src/hooks/knowledge-application.js';
import { knowledgeApplicationGateBefore } from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { resetSwarmState, swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('application-denial-v2-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	resetSwarmState();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	resetSwarmState();
});

async function display(trace_id: string): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id,
		session_id: 'session-a',
		exposure_kind: 'architect_directive',
		entries: [{ entry_id: ENTRY, critical: true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

const input = {
	tool: 'save_plan',
	agent: 'architect',
	sessionID: 'session-a',
};

const config = {
	...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	mode: 'enforce' as const,
	max_gate_denials: 2,
};

describe('application gate exact-pair denial identity', () => {
	it('re-displaying the same exact pair does not reset its denial count', async () => {
		await display('trace-same');
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow();
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow();

		await display('trace-same');
		await knowledgeApplicationGateBefore(directory, input, config);

		expect(swarmState.gateDenialCounts.has('session-a')).toBe(false);
	});

	it('a new trace for the same entry starts a fresh denial identity', async () => {
		await display('trace-old');
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow();
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow();

		const closed = await ledgerInternals.commitApplicationMarkerBatch(
			directory,
			{
				trace_id: 'trace-old',
				session_id: 'session-a',
				items: [{ entry_id: ENTRY, outcome: 'applied' }],
			},
		);
		if (!closed.ok) throw new Error(closed.detail);
		await display('trace-new');

		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow(/trace-new/);
	});

	it('session teardown clears denial counts', async () => {
		await display('trace-reset');
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow();
		expect(swarmState.gateDenialCounts.has('session-a')).toBe(true);

		resetSwarmState();

		expect(swarmState.gateDenialCounts.has('session-a')).toBe(false);
	});
});
