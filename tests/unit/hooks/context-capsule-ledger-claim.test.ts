/**
 * #1617 / #2107 §2: the context capsule claims its allocation from the shared
 * per-turn injection ledger and feeds the GRANTED amount into the capsule
 * packer; with no ledger it fails open to its local max.
 *
 * Uses the same _internals DI seam pattern as context-capsule-inject.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	createContextCapsuleInjectHook,
} from '../../../src/hooks/context-capsule-inject.js';
import { estimateTokens } from '../../../src/hooks/utils.js';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget.js';
import type { CapsuleDelegationReason } from '../../../src/types/context-capsule.js';

const SESSION_ID = 'capsule-ledger-session';

const CAPSULE_CONTENT = '[Context Capsule] summaries and read policies.';

const mockCapsuleResult = {
	capsule: {
		content: CAPSULE_CONTENT,
		delegation_reason: 'new_task' as CapsuleDelegationReason,
	},
	metadata: {
		token_estimate: 42,
		cache_hits: 0,
		cache_misses: 1,
		stale_entries: 0,
		recommended_reads: [],
		skipped_reads: [],
		success: true,
	},
};

const savedInternals = { ..._internals };

beforeEach(() => {
	Object.assign(_internals, savedInternals);
	_internals.buildCapsule = mock(() => mockCapsuleResult);
	_internals.getActiveAgent = mock(() => 'mega_coder');
	_internals.getCurrentTaskId = mock(() => 'task-1');
	_internals.readScopeFile = mock(() => ['src/foo.ts']);
	_internals.recordTelemetry = mock(() => {});
	_internals.saveCapsule = mock(() => {});
	clearTurnLedger(SESSION_ID);
});

afterEach(() => {
	Object.assign(_internals, savedInternals);
	clearTurnLedger(SESSION_ID);
});

async function runTransform(config: Record<string, unknown>) {
	const hook = createContextCapsuleInjectHook(
		config as Parameters<typeof createContextCapsuleInjectHook>[0],
		'/fake/dir',
	);
	const transform = hook['experimental.chat.system.transform'] as (
		input: { sessionID?: string },
		output: { system: string[] },
	) => Promise<void>;
	const output = { system: [] as string[] };
	await transform({ sessionID: SESSION_ID }, output);
	return output;
}

function buildCapsuleArgs(): Record<string, unknown> | undefined {
	const calls = (_internals.buildCapsule as ReturnType<typeof mock>).mock.calls;
	return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

describe('context capsule — shared-ledger claims (#1617, #2107 §2)', () => {
	test('no ledger: fails open to the configured local max', async () => {
		await runTransform({
			context_map: { enabled: true, max_capsule_tokens: 1500 },
		});
		expect(buildCapsuleArgs()?.max_capsule_tokens).toBe(1500);
		// No ledger → nothing recorded (fail-open is observable only via the
		// hook's debug log, not phantom accounting).
		expect(getTurnLedgerSummary(SESSION_ID)).toBeNull();
	});

	test('ledger with ceiling active: feeds the GRANTED amount into the packer', async () => {
		beginTurnLedger(SESSION_ID, 2000, true);
		// Another producer already consumed 1600 of the 2000-token ceiling.
		const summary = getTurnLedgerSummary(SESSION_ID);
		expect(summary?.used).toBe(0);
		// Claim first via a prior producer to constrain the remaining budget.
		const { claimTurnBudget } = await import(
			'../../../src/services/injection-budget.js'
		);
		claimTurnBudget(SESSION_ID, 'memory-recall', 1600, {
			localMaxTokens: 1600,
		});

		await runTransform({
			context_map: { enabled: true, max_capsule_tokens: 1500 },
		});
		// Remaining ceiling is 400; granted = min(1500 requested, 1500 local, 400 remaining).
		expect(buildCapsuleArgs()?.max_capsule_tokens).toBe(400);
	});

	test('ledger ceiling inactive (default config): grants the local max', async () => {
		beginTurnLedger(SESSION_ID, 4000, false);
		await runTransform({
			context_map: { enabled: true, max_capsule_tokens: 1500 },
		});
		expect(buildCapsuleArgs()?.max_capsule_tokens).toBe(1500);
	});

	test('records its emission as a system-surface producer', async () => {
		beginTurnLedger(SESSION_ID, 4000, false);
		await runTransform({ context_map: { enabled: true } });
		const producer = getTurnLedgerSummary(SESSION_ID)?.producers.find(
			(p) => p.producer === 'context-capsule',
		);
		expect(producer).toBeDefined();
		expect(producer?.surface).toBe('system');
		// The local default (2000) is the requested amount...
		expect(producer?.requested).toBe(2000);
		// ...and the emitted tokens are the canonical estimate of the pushed
		// content (never double-counted: the messages measurement never sees
		// output.system bytes).
		expect(producer?.emitted).toBe(estimateTokens(CAPSULE_CONTENT));
	});
});
