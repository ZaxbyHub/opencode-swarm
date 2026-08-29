/**
 * #1617 / #2107 §2: memory recall claims its allocation from the shared
 * per-turn injection ledger and feeds the GRANTED amount into the greedy
 * packer (gateway.recall's tokenBudget); with no ledger it fails open to the
 * configured `recall.injection.tokenBudget`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import { createMemoryLifecycleHooks } from '../../../src/memory/injector';
import type { RecallBundle } from '../../../src/memory/types';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget';

const SESSION_ID = 'memory-ledger-session';
/** Fixed timestamp — the clock is irrelevant here and the test-clock gate
 * requires determinism in diff-touched tests (issue #1782). */
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

function makeMessages(): MessageWithParts[] {
	return [
		{
			info: { role: 'system', sessionID: SESSION_ID },
			parts: [{ type: 'text', text: 'base' }],
		},
		{
			info: { role: 'user', agent: 'coder', sessionID: SESSION_ID },
			parts: [{ type: 'text', text: 'implement the widget parser now' }],
		},
	] as unknown as MessageWithParts[];
}

function makeBundle(): RecallBundle {
	return {
		id: 'bundle-1',
		query: 'widget parser',
		generatedAt: FIXED_NOW,
		tokenEstimate: 120,
		items: [
			{
				score: 0.9,
				record: {
					id: 'mem-1',
					kind: 'fact',
					scope: { type: 'session' },
					confidence: 0.9,
					text: 'prefer tabs in this repo',
					source: { type: 'manual' },
					createdAt: FIXED_NOW,
					updatedAt: FIXED_NOW,
				},
			},
		],
	};
}

function makeHooks(captured: { tokenBudget?: number; bundle: RecallBundle }) {
	return createMemoryLifecycleHooks({
		directory: '/fake/dir',
		config: {
			enabled: true,
			recall: {
				enabled: true,
				injection: { enabled: true, tokenBudget: 1000 },
			},
		} as never,
		createGateway: () => ({
			isEnabled: () => true,
			deriveAllowedScopes: () => [{ type: 'session' }],
			recall: async (input: { tokenBudget?: number }) => {
				captured.tokenBudget = input.tokenBudget;
				return captured.bundle;
			},
			propose: async () => ({ proposals: [] }),
		}),
		appendRunLog: async () => {},
	});
}

beforeEach(() => {
	clearTurnLedger(SESSION_ID);
});

afterEach(() => {
	clearTurnLedger(SESSION_ID);
});

describe('memory recall — shared-ledger claims (#1617, #2107 §2)', () => {
	test('no ledger: fails open to the configured tokenBudget', async () => {
		const captured = { bundle: makeBundle() };
		const hooks = makeHooks(captured);
		const messages = makeMessages();
		await hooks.messagesTransform({}, { messages });

		expect(captured.tokenBudget).toBe(1000);
		// The recall block still landed in the fresh surface (no suppression).
		expect(
			messages.some((m) => m.info?.role === 'system' && m !== messages[0]),
		).toBe(true);
		// No phantom accounting without a ledger.
		expect(getTurnLedgerSummary(SESSION_ID)).toBeNull();
	});

	test('ledger with ceiling active: feeds the GRANTED amount into the packer', async () => {
		beginTurnLedger(SESSION_ID, 1500, true);
		const { claimTurnBudget } = await import(
			'../../../src/services/injection-budget'
		);
		// A prior producer consumed 1200 of the 1500-token ceiling.
		claimTurnBudget(SESSION_ID, 'context-capsule', 1200, {
			localMaxTokens: 1200,
		});

		const captured = { bundle: makeBundle() };
		const hooks = makeHooks(captured);
		const messages = makeMessages();
		await hooks.messagesTransform({}, { messages });

		// Remaining ceiling 300; granted = min(1000 requested, 1000 local, 300 remaining).
		expect(captured.tokenBudget).toBe(300);
	});

	test('ledger ceiling inactive (default config): grants the local budget', async () => {
		beginTurnLedger(SESSION_ID, 4000, false);
		const captured = { bundle: makeBundle() };
		const hooks = makeHooks(captured);
		await hooks.messagesTransform({}, { messages: makeMessages() });
		expect(captured.tokenBudget).toBe(1000);
	});

	test('records its emission as a messages-surface producer', async () => {
		beginTurnLedger(SESSION_ID, 4000, false);
		const captured = { bundle: makeBundle() };
		const hooks = makeHooks(captured);
		const messages = makeMessages();
		await hooks.messagesTransform({}, { messages });

		const producer = getTurnLedgerSummary(SESSION_ID)?.producers.find(
			(p) => p.producer === 'memory-recall',
		);
		expect(producer).toBeDefined();
		expect(producer?.surface).toBe('messages');
		expect(producer?.emitted).toBe(captured.bundle.tokenEstimate);
		expect(producer?.granted).toBe(1000);
	});
});
