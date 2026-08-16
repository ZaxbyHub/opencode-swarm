/** V2-authoritative knowledge application gate integration tests. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	buildAckDedupKey,
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	resolveApplicationLogPath,
} from '../../../src/hooks/knowledge-application.js';
import {
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
let directory: string;

beforeEach(() => {
	mock.restore();
	directory = canonicalMkdtemp('application-gate-v2-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	mock.restore();
});

async function display(
	trace_id: string,
	entry_id = ENTRY,
	session_id = 'session-a',
): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id,
		session_id,
		exposure_kind: 'architect_directive',
		phase: 'Canonical phase',
		entries: [{ entry_id, critical: true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

async function terminal(
	trace_id: string,
	entry_id = ENTRY,
	session_id = 'session-a',
): Promise<void> {
	const result = await validateAndCommitTerminalBatch(directory, {
		trace_id,
		session_id,
		items: [{ entry_id, outcome: 'applied', source: 'knowledge_receipt' }],
	});
	if (!result.ok || result.rejected.length > 0) {
		throw new Error('terminal fixture failed');
	}
}

async function marker(
	trace_id: string,
	entry_id = ENTRY,
	session_id = 'session-a',
): Promise<void> {
	const result = await ledgerInternals.commitApplicationMarkerBatch(directory, {
		trace_id,
		session_id,
		items: [{ entry_id, outcome: 'applied', source: 'test-marker' }],
	});
	if (!result.ok || result.rejected.length > 0) {
		throw new Error('marker fixture failed');
	}
}

function architectMessage(text: string, agent = 'architect'): MessageWithParts {
	return {
		info: { role: 'assistant', agent },
		parts: [{ type: 'text', text }],
	};
}

const enforce = {
	...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	mode: 'enforce' as const,
};

describe('knowledgeApplicationGateBefore V2 authority', () => {
	it('blocks an exact pending critical pair and identifies its trace', async () => {
		await display('trace-pending');

		await expect(
			knowledgeApplicationGateBefore(
				directory,
				{ tool: 'save_plan', agent: 'architect', sessionID: 'session-a' },
				enforce,
			),
		).rejects.toThrow(new RegExp(`trace-pending/${ENTRY}`));
	});

	it('denial message lists every accepted marker form including KNOWLEDGE_N_A (#2032 PRR-015)', async () => {
		await display('trace-deny-text');
		const denial = await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'save_plan', agent: 'architect', sessionID: 'session-a' },
			enforce,
		).catch((err: unknown): string =>
			err instanceof Error ? err.message : String(err),
		);
		expect(denial).toContain('KNOWLEDGE_ENFORCE_GATE_DENY');
		// O-5's visible surface: the architect under denial is told the neutral
		// N_A form exists (with its reason requirement) alongside the others.
		expect(denial).toContain('KNOWLEDGE_APPLIED:<trace_id>:<entry_id>');
		expect(denial).toContain('KNOWLEDGE_N_A:<trace_id>:<entry_id>');
		expect(denial).toContain('(does not apply; neutral)');
		expect(denial).toContain('KNOWLEDGE_IGNORED:<trace_id>:<entry_id>');
		expect(denial).toContain('KNOWLEDGE_VIOLATED:<trace_id>:<entry_id>');
	});

	it('does not let one trace terminal hide the same entry on another trace', async () => {
		await display('trace-closed');
		await display('trace-open');
		await terminal('trace-closed');

		await expect(
			knowledgeApplicationGateBefore(
				directory,
				{ tool: 'Task', agent: 'paid_architect', sessionID: 'session-a' },
				enforce,
			),
		).rejects.toThrow(new RegExp(`trace-open/${ENTRY}`));
	});

	it('does not let a knowledge_receipt terminal satisfy the architect marker gate', async () => {
		await display('trace-terminal');
		await terminal('trace-terminal');
		await expect(
			knowledgeApplicationGateBefore(
				directory,
				{ tool: 'phase_complete', agent: 'architect', sessionID: 'session-a' },
				enforce,
			),
		).rejects.toThrow(/trace-terminal/);
		await marker('trace-terminal');

		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'phase_complete', agent: 'architect', sessionID: 'session-a' },
			enforce,
		);
	});

	it('isolates memberships by session', async () => {
		await display('other-session-trace', ENTRY, 'session-b');

		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'save_plan', agent: 'architect', sessionID: 'session-a' },
			enforce,
		);
	});

	it('fails closed when receipt authority is corrupt', async () => {
		await display('trace-corrupt');
		writeFileSync(
			path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'not-json\n',
		);

		await expect(
			knowledgeApplicationGateBefore(
				directory,
				{ tool: 'save_plan', agent: 'architect', sessionID: 'session-a' },
				enforce,
			),
		).rejects.toThrow(/receipt authority unavailable/);
	});

	it('warn mode writes both exact pairs and compatibility ids', async () => {
		await display('trace-warn');

		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'save_plan', agent: 'architect', sessionID: 'session-a' },
			{ ...enforce, mode: 'warn' },
		);
		await Bun.sleep(25);

		const body = readFileSync(
			path.join(directory, '.swarm', 'events.jsonl'),
			'utf8',
		);
		expect(body).toContain(`trace-warn/${ENTRY}`);
		expect(body).toContain('unacknowledged_critical_ids');
	});

	it('fails closed on a missing session contract in enforce mode', async () => {
		await expect(
			knowledgeApplicationGateBefore(
				directory,
				{ tool: 'save_plan', agent: 'architect' },
				enforce,
			),
		).rejects.toThrow(/missing sessionID/);
	});
});

describe('knowledgeApplicationTransformScan V2 authority', () => {
	it('atomically commits one exact pair without affecting its sibling trace', async () => {
		await display('trace-one');
		await display('trace-two');
		const output = {
			messages: [architectMessage(`KNOWLEDGE_APPLIED:trace-one:${ENTRY}`)],
		};

		await knowledgeApplicationTransformScan(directory, output, 'session-a');

		const state = await queryLiveMemberships(directory, {
			session_id: 'session-a',
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		const acknowledged = state.memberships.find(
			(item) => item.trace_id === 'trace-one',
		);
		const sibling = state.memberships.find(
			(item) => item.trace_id === 'trace-two',
		);
		expect(acknowledged?.application_marker?.outcome).toBe('applied');
		expect(acknowledged?.terminal?.outcome).toBe('applied');
		expect(sibling?.application_marker).toBeUndefined();
		expect(sibling?.terminal).toBeUndefined();
		expect(
			swarmState.knowledgeAckDedup.has(
				buildAckDedupKey(
					'session-a',
					JSON.stringify(['trace-one', ENTRY]),
					'applied',
				),
			),
		).toBe(true);
		const diagnostics = readFileSync(
			resolveApplicationLogPath(directory),
			'utf8',
		)
			.trim()
			.split('\n');
		expect(diagnostics).toHaveLength(1);
	});

	it('is idempotent and does not duplicate the diagnostic', async () => {
		await display('trace-idempotent');
		const output = {
			messages: [
				architectMessage(`KNOWLEDGE_APPLIED:trace-idempotent:${ENTRY}`),
			],
		};

		await knowledgeApplicationTransformScan(directory, output, 'session-a');
		await knowledgeApplicationTransformScan(directory, output, 'session-a');

		expect(
			readFileSync(resolveApplicationLogPath(directory), 'utf8')
				.trim()
				.split('\n'),
		).toHaveLength(1);
	});

	it.each([
		['IGNORED', 'ignored', 'not relevant to this plan'],
		['N_A', 'n_a', 'different subsystem'],
	] as const)('propagates %s reasons to both authoritative projections', async (verb, outcome, reason) => {
		const traceId = `trace-${outcome}`;
		await display(traceId);
		await knowledgeApplicationTransformScan(
			directory,
			{
				messages: [
					architectMessage(
						`KNOWLEDGE_${verb}:${traceId}:${ENTRY} reason=${reason}`,
					),
				],
			},
			'session-a',
		);
		const state = await queryLiveMemberships(directory, {
			session_id: 'session-a',
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		expect(state.memberships[0]?.application_marker).toMatchObject({
			outcome,
			reason,
		});
		expect(state.memberships[0]?.terminal).toMatchObject({ outcome, reason });
	});

	it('does not dedup or diagnose when authority is unavailable', async () => {
		await display('trace-corrupt');
		writeFileSync(
			path.join(directory, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'not-json\n',
		);

		await knowledgeApplicationTransformScan(
			directory,
			{
				messages: [
					architectMessage(`KNOWLEDGE_APPLIED:trace-corrupt:${ENTRY}`),
				],
			},
			'session-a',
		);

		expect(swarmState.knowledgeAckDedup.size).toBe(0);
		expect(existsSync(resolveApplicationLogPath(directory))).toBe(false);
	});

	it('ignores non-architect messages', async () => {
		await display('trace-coder');
		await knowledgeApplicationTransformScan(
			directory,
			{
				messages: [
					architectMessage(`KNOWLEDGE_APPLIED:trace-coder:${ENTRY}`, 'coder'),
				],
			},
			'session-a',
		);
		expect(existsSync(resolveApplicationLogPath(directory))).toBe(false);
	});
});
