/** V2-authoritative deadlock escape-hatch tests. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	buildAckDedupKey,
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
} from '../../../src/hooks/knowledge-application.js';
import { knowledgeApplicationGateBefore } from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('application-escape-v2-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
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

describe('knowledge application V2 escape hatches', () => {
	it('commits the exact pair before denial-limit bypass and audits it', async () => {
		await display('trace-denials');
		const config = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 2,
		};

		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await knowledgeApplicationGateBefore(directory, input, config);

		const state = await queryLiveMemberships(directory, {
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		expect(state.memberships[0]?.gate_release).toMatchObject({
			source: 'application_gate_denial_limit_release',
			membership_event_id: state.memberships[0]?.membership_event_id,
		});
		expect(state.memberships[0]?.application_marker).toBeUndefined();
		expect(state.memberships[0]?.terminal).toBeUndefined();
		expect(
			readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8'),
		).toContain('knowledge_application_gate_denial_limit_clear');
	});

	it('staleness bypass closes every trace pair for a repeated entry', async () => {
		await display('trace-one');
		await display('trace-two');
		swarmState.currentCriticalShownIds.set('session-a', {
			ids: [ENTRY],
			generatedAt: Date.now(),
		});

		await knowledgeApplicationGateBefore(directory, input, {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce',
			gate_staleness_ms: -1,
		});

		const state = await queryLiveMemberships(directory, {
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		expect(
			state.memberships.every(
				(item) =>
					item.gate_release?.source === 'application_gate_staleness_release' &&
					item.application_marker === undefined &&
					item.terminal === undefined,
			),
		).toBe(true);
		expect(
			swarmState.knowledgeAckDedup.has(
				buildAckDedupKey('session-a', ENTRY, 'applied'),
			),
		).toBe(false);
		expect(swarmState.currentCriticalShownIds.has('session-a')).toBe(false);
		expect(
			readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8'),
		).toContain('knowledge_application_gate_staleness_clear');
	});

	it('does not bypass a fresh membership inside the threshold', async () => {
		await display('trace-fresh');

		await expect(
			knowledgeApplicationGateBefore(directory, input, {
				...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
				mode: 'enforce',
				gate_staleness_ms: 60_000,
			}),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
	});

	it('clears denial state after an authoritative marker arrives', async () => {
		await display('trace-terminal');
		const config = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
		};
		await expect(
			knowledgeApplicationGateBefore(directory, input, config),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		expect(swarmState.gateDenialCounts.has('session-a')).toBe(true);

		const terminal = await ledgerInternals.commitApplicationMarkerBatch(
			directory,
			{
				trace_id: 'trace-terminal',
				session_id: 'session-a',
				items: [{ entry_id: ENTRY, outcome: 'applied' }],
			},
		);
		if (!terminal.ok) throw new Error(terminal.detail);
		await knowledgeApplicationGateBefore(directory, input, config);

		expect(swarmState.gateDenialCounts.has('session-a')).toBe(false);
	});
});
