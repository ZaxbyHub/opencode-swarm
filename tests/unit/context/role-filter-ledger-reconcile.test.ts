/**
 * #2107 §3 (final-critic round 2): the role filter runs AFTER the
 * system-enhancer in the system.transform chain and removes `[FOR: role]`
 * system fragments for a nonmatching active agent. Those strings were already
 * recorded as system-enhancer ledger emissions; without reconciliation the
 * final accounting would count bytes the model never sees. The filter now
 * deducts the removed strings' canonical estimate from the system-enhancer
 * producer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createRoleFilterSystemHook } from '../../../src/context/role-filter';
import { estimateTokens } from '../../../src/hooks/utils';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
	recordProducerEmission,
} from '../../../src/services/injection-budget';

const SESSION = 'role-filter-reconcile-session';

describe('role-filter system hook — ledger reconciliation (#2107 §3)', () => {
	afterEach(() => {
		clearTurnLedger(SESSION);
	});

	test('deducts removed [FOR:] strings from the system-enhancer emission', async () => {
		beginTurnLedger(SESSION, 4000, false);
		const removed = '[FOR: architect] hidden budget warning';
		const kept = '[FOR: coder] visible';
		// Simulate the SE having recorded everything it pushed this turn.
		recordProducerEmission(
			SESSION,
			'system-enhancer',
			estimateTokens(removed) +
				estimateTokens(kept) +
				estimateTokens('untagged'),
			0,
			'system',
		);
		const before = getTurnLedgerSummary(SESSION)?.producers.find(
			(p) => p.producer === 'system-enhancer',
		)?.emitted;

		const hook = createRoleFilterSystemHook(() => 'coder');
		const transform = hook['experimental.chat.system.transform'];
		const output = { system: ['untagged', removed, kept] };
		await transform({ sessionID: SESSION }, output);

		expect(output.system).toEqual(['untagged', kept]);
		const after = getTurnLedgerSummary(SESSION)?.producers.find(
			(p) => p.producer === 'system-enhancer',
		)?.emitted;
		expect(after).toBe((before ?? 0) - estimateTokens(removed));
	});

	test('no removal → no deduction', async () => {
		beginTurnLedger(SESSION, 4000, false);
		recordProducerEmission(SESSION, 'system-enhancer', 500, 0, 'system');

		const hook = createRoleFilterSystemHook(() => 'coder');
		const transform = hook['experimental.chat.system.transform'];
		const output = { system: ['untagged', '[FOR: coder] visible'] };
		await transform({ sessionID: SESSION }, output);

		expect(
			getTurnLedgerSummary(SESSION)?.producers.find(
				(p) => p.producer === 'system-enhancer',
			)?.emitted,
		).toBe(500);
	});

	test('no ledger / no sessionID → filtering still works, never throws', async () => {
		const hook = createRoleFilterSystemHook(() => 'coder');
		const transform = hook['experimental.chat.system.transform'];
		const output = { system: ['[FOR: architect] x', '[FOR: coder] y'] };
		await expect(
			transform({ sessionID: 'no-ledger-session' }, output),
		).resolves.toBeUndefined();
		expect(output.system).toEqual(['[FOR: coder] y']);
		await expect(
			transform({}, { system: ['[FOR: architect] x'] }),
		).resolves.toBeUndefined();
	});
});
