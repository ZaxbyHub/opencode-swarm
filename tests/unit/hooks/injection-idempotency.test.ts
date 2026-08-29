/**
 * #2107 §7 (safe idempotency): dedup ONLY when the identical sentinel/content
 * is present in the CURRENT composed surface for the same turn. Never suppress
 * by prior-turn hash; a fresh next-turn surface still receives the block;
 * compaction advances the accounting generation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _test_exports as kiExports } from '../../../src/hooks/knowledge-injector';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import {
	advanceTurnGeneration,
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget';

const SESSION = 'idempotency-session';

function freshSurface(): MessageWithParts[] {
	return [
		{
			info: { role: 'user', sessionID: SESSION },
			parts: [{ type: 'text', text: 'continue the work' }],
		},
	] as unknown as MessageWithParts[];
}

beforeEach(() => {
	clearTurnLedger(SESSION);
});

afterEach(() => {
	clearTurnLedger(SESSION);
});

describe('safe idempotency (#2107 §7)', () => {
	test('calling the producer twice against the SAME surface yields one block', () => {
		const messages = freshSurface();
		const output = { messages };
		kiExports.injectKnowledgeMessage(output, 'lesson A');
		kiExports.injectKnowledgeMessage(output, 'lesson A again');
		const injected = messages.filter(
			(m) =>
				m.info?.role === 'system' &&
				m.parts?.some((p) => p.text?.includes(kiExports.INJECTION_SENTINEL)),
		);
		expect(injected).toHaveLength(1);
	});

	test('a FRESH next-turn surface still receives the block (no prior-turn suppression)', () => {
		const first = { messages: freshSurface() };
		kiExports.injectKnowledgeMessage(first, 'lesson A');
		expect(first.messages).toHaveLength(2);

		// Next turn: a brand-new message array — the sentinel is absent, so the
		// required context MUST be re-injected. This is exactly the #1619
		// behavior #2107 mandates: cross-turn suppression is forbidden.
		const second = { messages: freshSurface() };
		kiExports.injectKnowledgeMessage(second, 'lesson A');
		expect(second.messages).toHaveLength(2);
		const injected = second.messages.find((m) => m.info?.role === 'system');
		expect(injected?.parts?.[0]).toMatchObject({
			type: 'text',
		});
		expect(String((injected?.parts?.[0] as { text?: string })?.text)).toContain(
			'lesson A',
		);
	});

	test('changed context receives changed content (cache re-emits, never skips)', () => {
		const surface = { messages: freshSurface() };
		kiExports.injectKnowledgeMessage(surface, 'lesson A');
		kiExports.injectKnowledgeMessage(surface, 'lesson B');
		// Same surface keeps ONE block (the first); a changed context on a fresh
		// surface carries the changed content.
		const next = { messages: freshSurface() };
		kiExports.injectKnowledgeMessage(next, 'lesson B');
		const text = next.messages.find((m) => m.info?.role === 'system')
			?.parts?.[0] as { text?: string };
		expect(text?.text).toContain('lesson B');
	});

	test('after compaction the accounting generation advances', () => {
		const gen1 = beginTurnLedger(SESSION, 4000, true);
		expect(getTurnLedgerSummary(SESSION)?.generation).toBe(gen1);
		// session.compacting wrapper advances the generation: the old ledger is
		// discarded so the next composition cannot ride stale claims.
		advanceTurnGeneration(SESSION);
		expect(getTurnLedgerSummary(SESSION)).toBeNull();
		const gen2 = beginTurnLedger(SESSION, 4000, true);
		expect(gen2).toBeGreaterThan(gen1);
	});
});
