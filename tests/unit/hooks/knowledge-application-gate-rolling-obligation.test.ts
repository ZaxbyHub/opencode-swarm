/** Rolling-obligation regressions for the knowledge application gate (#2398).
 *
 * The injector re-surfaces the same knowledge entry under a fresh trace_id on
 * every message-driven retrieval cache miss, and an acknowledgment closes only
 * the exact (trace_id, entry_id) pair it names. Before #2398 the gate treated
 * each re-display as a brand-new obligation and keyed its denial budget by the
 * volatile pair set, so a compliant architect could be denied indefinitely.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_KNOWLEDGE_APPLICATION_CONFIG } from '../../../src/hooks/knowledge-application.js';
import {
	knowledgeApplicationGateBefore,
	knowledgeApplicationTransformScan,
} from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitDisplayedMembership,
	_internals as ledgerInternals,
	queryLiveMemberships,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ENTRY = 'cccccccc-cccc-4ccc-9ccc-cccccccccccc';
const ENTRY_TWO = 'dddddddd-dddd-4ddd-9ddd-dddddddddddd';
let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('application-rolling-');
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
	options: {
		entry_id?: string;
		session_id?: string;
	} = {},
): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id,
		session_id: options.session_id ?? 'session-a',
		exposure_kind: 'architect_directive',
		entries: [{ entry_id: options.entry_id ?? ENTRY, critical: true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

async function marker(
	trace_id: string,
	source: string,
	entry_id = ENTRY,
	session_id = 'session-a',
): Promise<void> {
	const result = await ledgerInternals.commitApplicationMarkerBatch(directory, {
		trace_id,
		session_id,
		items: [{ entry_id, outcome: 'applied', source }],
	});
	if (!result.ok || result.rejected.length > 0) {
		throw new Error('marker fixture failed');
	}
}

/** Acknowledge via the REAL scanner path, exactly like the architect's chat. */
async function architectAck(
	trace_id: string,
	entry_id = ENTRY,
	session_id = 'session-a',
): Promise<void> {
	const message: MessageWithParts = {
		info: { role: 'assistant', agent: 'architect' },
		parts: [
			{
				type: 'text',
				text: `KNOWLEDGE_N_A:${trace_id}:${entry_id} reason=not applicable to this step`,
			},
		],
	};
	await knowledgeApplicationTransformScan(
		directory,
		{ messages: [message] },
		session_id,
	);
}

function gateCall(
	configOverrides: Record<string, unknown> = {},
	session_id = 'session-a',
): Promise<void> {
	return knowledgeApplicationGateBefore(
		directory,
		{ tool: 'save_plan', agent: 'architect', sessionID: session_id },
		{
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			...configOverrides,
		},
	);
}

describe('knowledge application gate rolling obligations (#2398)', () => {
	it('a valid acknowledgment discharges a re-armed fresh trace of the same entry', async () => {
		await display('trace-one');
		await expect(gateCall()).rejects.toThrow(/trace-one/);

		await architectAck('trace-one');
		// The injector's next message-driven cache miss re-surfaces the same
		// entry under a fresh trace. The prior buggy behavior denied this call
		// naming trace-two even though the entry was just acknowledged.
		await display('trace-two');

		await gateCall();
	});

	it('the denial budget continues across trace rotation of the same entry', async () => {
		const config = { max_gate_denials: 3 };
		await display('trace-one');
		await expect(gateCall(config)).rejects.toThrow(/trace-one/);
		await display('trace-two');
		// Before #2398 the rotated pair set reset the count to 1; the budget
		// must instead continue against the stable entry-id set.
		await expect(gateCall(config)).rejects.toThrow(/trace-two/);
		await display('trace-three');
		await expect(gateCall(config)).rejects.toThrow(/trace-three/);

		// Fourth denial exceeds max_gate_denials=3: escape hatch fires and the
		// action is allowed through with every pending pair released.
		await gateCall(config);

		const state = await queryLiveMemberships(directory, {
			session_id: 'session-a',
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		expect(
			state.memberships.every(
				(membership) =>
					membership.gate_release?.source ===
					'application_gate_denial_limit_release',
			),
		).toBe(true);
		expect(swarmState.gateDenialCounts.has('session-a')).toBe(false);
		expect(
			readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8'),
		).toContain('knowledge_application_gate_denial_limit_clear');
	});

	it('a staleness release does not reset the denial budget for the same entry', async () => {
		await display('trace-old');
		// First denial under the default staleness window: trace-old is fresh,
		// so this is a plain denial (count 1) with no release.
		await expect(gateCall()).rejects.toThrow(/trace-old/);
		expect(swarmState.gateDenialCounts.get('session-a')?.count).toBe(1);

		await Bun.sleep(600);
		await display('trace-fresh');

		// trace-old is now >500ms old (stale → released); trace-fresh is a
		// fresh re-arm of the same entry and stays pending. The denial must
		// continue the budget at 2 — before #2398 the staleness release reset
		// the counter to 1.
		await expect(gateCall({ gate_staleness_ms: 500 })).rejects.toThrow(
			/trace-fresh/,
		);
		expect(swarmState.gateDenialCounts.get('session-a')?.count).toBe(2);

		const state = await queryLiveMemberships(directory, {
			session_id: 'session-a',
			include_terminal: true,
		});
		if (!state.ok) throw new Error(state.detail);
		const released = state.memberships.find(
			(membership) => membership.trace_id === 'trace-old',
		);
		expect(released?.gate_release?.source).toBe(
			'application_gate_staleness_release',
		);
	});

	it('an application marker from another session does not discharge this session', async () => {
		await display('trace-mine');
		await display('trace-theirs', { session_id: 'session-b' });
		await marker('trace-theirs', 'architect_marker', ENTRY, 'session-b');

		await expect(gateCall()).rejects.toThrow(/trace-mine/);
	});

	it('a marker with a non-architect source does not discharge a re-armed trace', async () => {
		await display('trace-one');
		await marker('trace-one', 'delegate');
		await display('trace-two');

		await expect(gateCall()).rejects.toThrow(/trace-two/);
	});

	it('an acknowledgment naming an already-released trace does not discharge a fresh trace', async () => {
		await display('trace-stale');
		// Staleness escape releases the pending pair.
		await gateCall({ gate_staleness_ms: -1 });
		// The architect then acks the released trace — the scanner correctly
		// commits nothing for a released membership, so no marker exists and a
		// fresh trace of the entry must still be acknowledged.
		await architectAck('trace-stale');
		await display('trace-new');

		await expect(gateCall()).rejects.toThrow(/trace-new/);
	});

	it('a partial acknowledgment resets the budget for the remaining directive set', async () => {
		const config = { max_gate_denials: 5 };
		await display('trace-e1', { entry_id: ENTRY });
		await display('trace-e2', { entry_id: ENTRY_TWO });
		await expect(gateCall(config)).rejects.toThrow(/trace-e1/);
		expect(swarmState.gateDenialCounts.get('session-a')?.count).toBe(1);

		await architectAck('trace-e1', ENTRY);

		// Discharging ENTRY leaves {ENTRY_TWO} pending — a genuinely different
		// directive set gets a fresh budget by design (the budget is pressure
		// on the CURRENT obligation set, not a session-lifetime total).
		await expect(gateCall(config)).rejects.toThrow(/trace-e2/);
		expect(swarmState.gateDenialCounts.get('session-a')?.count).toBe(1);
	});
});
