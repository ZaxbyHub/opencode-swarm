/**
 * Unit tests for src/services/injection-budget.ts (FR-002 + #2107 §2).
 *
 * Verifies the pure allocation function that caps combined system-enhancer +
 * knowledge-injector output per turn against a unified budget ceiling, and the
 * per-session/per-turn producer ledger that every model-visible producer
 * claims from or records into.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
	advanceTurnGeneration,
	allocateInjectionBudget,
	beginTurnLedger,
	claimTurnBudget,
	clearTurnLedger,
	getProducerEmission,
	getTurnLedgerSummary,
	type InjectionBudgetAllocation,
	type InjectionBudgetConfig,
	recordProducerEmission,
	recordProducerGrant,
} from '../../../src/services/injection-budget.js';

describe('Unified Injection Budget (FR-002) — pure allocation service', () => {
	const DEFAULT_BUDGET = 4000;

	function allocate(
		systemEnhancerTokens: number,
		knowledgeInjectorChars: number,
		budget = DEFAULT_BUDGET,
	): InjectionBudgetAllocation {
		const config: InjectionBudgetConfig = { totalBudgetTokens: budget };
		return allocateInjectionBudget(
			systemEnhancerTokens,
			knowledgeInjectorChars,
			config,
		);
	}

	describe('AC-004: config key presence', () => {
		it('accepts totalBudgetTokens via InjectionBudgetConfig', () => {
			const config: InjectionBudgetConfig = { totalBudgetTokens: 4000 };
			expect(config.totalBudgetTokens).toBe(4000);
		});
	});

	describe('SC-004: combined demand within budget', () => {
		it('systemEnhancer=3K tokens + knowledgeInjector=2K chars within 4K budget → total ≤ 4K', () => {
			const result = allocate(3000, 2000, 4000);
			expect(result.totalTokens).toBeLessThanOrEqual(4000);
			// Canonical 0.33 tok/char: 2000 chars → Math.ceil(2000 * 0.33) = 660
			expect(result.systemEnhancerTokens).toBe(3000);
			expect(result.knowledgeInjectorTokens).toBe(660);
			expect(result.totalTokens).toBe(3660);
		});
	});

	describe('SC-005: single-component overrun → other gets zero', () => {
		it('systemEnhancer=10K, knowledgeInjector=0, totalBudget=4K → knowledgeInjector allocation = 0', () => {
			const result = allocate(10000, 0, 4000);
			expect(result.systemEnhancerTokens).toBe(4000);
			expect(result.knowledgeInjectorTokens).toBe(0);
			expect(result.totalTokens).toBe(4000);
		});

		it('knowledgeInjector demand alone exceeds budget → systemEnhancer gets 0', () => {
			// 20000 chars * 0.33 ≈ 6600 tokens > 4000 budget
			const result = allocate(0, 20000, 4000);
			expect(result.systemEnhancerTokens).toBe(0);
			expect(result.knowledgeInjectorTokens).toBe(4000);
			expect(result.totalTokens).toBe(4000);
		});
	});

	describe('SC-006: ceiling equals configured value', () => {
		it('when combined demand equals budget, allocations sum to exactly the budget', () => {
			// 3000 tokens + 3030 chars (≈ 1000 tokens) = 4000 total demand = budget
			const result = allocate(3000, 3030, 4000);
			expect(result.totalTokens).toBe(4000);
			expect(result.systemEnhancerTokens).toBe(3000);
			expect(result.knowledgeInjectorTokens).toBe(1000);
		});

		it('proportional split when combined demand exceeds budget but neither alone does', () => {
			// 3000 tokens + 4000 chars (≈ 1320 tokens) = 4320 > 4000
			// Proportional: 3000/4320 * 4000 = 2777 (floor), remainder to knowledge-injector
			const result = allocate(3000, 4000, 4000);
			expect(result.totalTokens).toBe(4000);
			expect(result.systemEnhancerTokens).toBeGreaterThan(0);
			expect(result.knowledgeInjectorTokens).toBeGreaterThan(0);
			expect(result.systemEnhancerTokens + result.knowledgeInjectorTokens).toBe(
				4000,
			);
		});
	});

	describe('edge cases', () => {
		it('zero budget yields zero allocations', () => {
			const result = allocate(3000, 2000, 0);
			expect(result.systemEnhancerTokens).toBe(0);
			expect(result.knowledgeInjectorTokens).toBe(0);
			expect(result.totalTokens).toBe(0);
		});

		it('zero demands yield zero allocations', () => {
			const result = allocate(0, 0, 4000);
			expect(result.systemEnhancerTokens).toBe(0);
			expect(result.knowledgeInjectorTokens).toBe(0);
			expect(result.totalTokens).toBe(0);
		});

		it('negative inputs are clamped to zero', () => {
			const result = allocate(-100, -500, 4000);
			expect(result.systemEnhancerTokens).toBe(0);
			expect(result.knowledgeInjectorTokens).toBe(0);
			expect(result.totalTokens).toBe(0);
		});
	});
});

describe('Per-turn producer ledger (#2107 §2)', () => {
	const SESSION_A = 'session-a';
	const SESSION_B = 'session-b';

	afterEach(() => {
		clearTurnLedger(SESSION_A);
		clearTurnLedger(SESSION_B);
	});

	describe('beginTurnLedger', () => {
		it('initializes a fresh ledger and mints a new generation', () => {
			const gen1 = beginTurnLedger(SESSION_A, 5000, true);
			const gen2 = beginTurnLedger(SESSION_A, 5000, true);
			expect(gen2).toBeGreaterThan(gen1);
			const summary = getTurnLedgerSummary(SESSION_A);
			expect(summary?.totalBudget).toBe(5000);
			expect(summary?.ceilingActive).toBe(true);
			expect(summary?.used).toBe(0);
			expect(summary?.producers).toEqual([]);
		});

		it('reset discards prior-turn claims exactly once per composition', () => {
			beginTurnLedger(SESSION_A, 3000, true);
			claimTurnBudget(SESSION_A, 'memory-recall', 2000, {
				localMaxTokens: 2000,
			});
			// Next request composition: reset, old claims gone.
			beginTurnLedger(SESSION_A, 3000, true);
			const summary = getTurnLedgerSummary(SESSION_A);
			expect(summary?.used).toBe(0);
			expect(summary?.producers).toEqual([]);
		});

		it('creates independent entries for different sessions', () => {
			beginTurnLedger(SESSION_A, 5000, true);
			beginTurnLedger(SESSION_B, 3000, false);
			expect(getTurnLedgerSummary(SESSION_A)?.totalBudget).toBe(5000);
			expect(getTurnLedgerSummary(SESSION_B)?.totalBudget).toBe(3000);
			expect(getTurnLedgerSummary(SESSION_B)?.ceilingActive).toBe(false);
		});
	});

	describe('claimTurnBudget', () => {
		it('grants the full request when the ceiling has room', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			const claim = claimTurnBudget(SESSION_A, 'context-capsule', 2000, {
				localMaxTokens: 2000,
			});
			expect(claim).toEqual({
				granted: 2000,
				ledgerPresent: true,
				ceilingActive: true,
			});
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(2000);
		});

		it('grants only the remaining ceiling when exhausted', () => {
			beginTurnLedger(SESSION_A, 1000, true);
			const claim = claimTurnBudget(SESSION_A, 'context-capsule', 1500, {
				localMaxTokens: 1500,
			});
			expect(claim.granted).toBe(1000);
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(1000);
		});

		it('never grants more than the producer local maximum', () => {
			beginTurnLedger(SESSION_A, 9000, true);
			const claim = claimTurnBudget(SESSION_A, 'memory-recall', 5000, {
				localMaxTokens: 1000,
			});
			expect(claim.granted).toBe(1000);
		});

		it('fails open to the local maximum when no ledger exists (#1617)', () => {
			const claim = claimTurnBudget(
				'no-such-session',
				'context-capsule',
				2500,
				{
					localMaxTokens: 2000,
				},
			);
			expect(claim).toEqual({
				granted: 2000,
				ledgerPresent: false,
				ceilingActive: false,
			});
			expect(getTurnLedgerSummary('no-such-session')).toBeNull();
		});

		it('ceiling inactive: grants the local max without deducting', () => {
			beginTurnLedger(SESSION_A, 1000, false);
			const claim = claimTurnBudget(SESSION_A, 'context-capsule', 2500, {
				localMaxTokens: 2000,
			});
			expect(claim.granted).toBe(2000);
			expect(claim.ceilingActive).toBe(false);
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(0);
		});

		it('sequential claims reconcile: Σgranted ≤ ceiling', () => {
			beginTurnLedger(SESSION_A, 3000, true);
			const r1 = claimTurnBudget(SESSION_A, 'context-capsule', 1000, {
				localMaxTokens: 1000,
			});
			const r2 = claimTurnBudget(SESSION_A, 'memory-recall', 1500, {
				localMaxTokens: 1500,
			});
			const r3 = claimTurnBudget(SESSION_A, 'context-capsule', 2000, {
				localMaxTokens: 2000,
			});
			expect(r1.granted).toBe(1000);
			expect(r2.granted).toBe(1500);
			expect(r3.granted).toBe(500);
			const summary = getTurnLedgerSummary(SESSION_A);
			expect(summary?.used).toBe(3000);
			// requested = granted + truncated reconciliation, per producer
			const capsule = summary?.producers.find(
				(p) => p.producer === 'context-capsule',
			);
			expect(capsule?.requested).toBe(3000);
			expect(capsule?.granted).toBe(1500);
			expect(capsule?.truncated).toBe(0);
		});

		it('concurrent sessions never share claims', () => {
			beginTurnLedger(SESSION_A, 1000, true);
			beginTurnLedger(SESSION_B, 5000, true);
			claimTurnBudget(SESSION_A, 'memory-recall', 900, {
				localMaxTokens: 900,
			});
			const bClaim = claimTurnBudget(SESSION_B, 'memory-recall', 4000, {
				localMaxTokens: 4000,
			});
			expect(bClaim.granted).toBe(4000);
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(900);
		});
	});

	describe('recordProducerGrant', () => {
		it('books a grant and deducts from the ceiling when active', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			recordProducerGrant(SESSION_A, 'system-enhancer', 2500, 2500, 'system');
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(2500);
			const remaining = claimTurnBudget(SESSION_A, 'context-capsule', 2000, {
				localMaxTokens: 2000,
			});
			expect(remaining.granted).toBe(1500);
		});

		it('clamps the deduction so used never exceeds the ceiling', () => {
			beginTurnLedger(SESSION_A, 1000, true);
			recordProducerGrant(SESSION_A, 'system-enhancer', 3000, 3000, 'system');
			const summary = getTurnLedgerSummary(SESSION_A);
			expect(summary?.used).toBe(1000);
		});

		it('records but does not deduct when the ceiling is inactive', () => {
			beginTurnLedger(SESSION_A, 1000, false);
			recordProducerGrant(SESSION_A, 'system-enhancer', 3000, 3000, 'system');
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(0);
		});

		it('no-ops without a ledger (fail-open)', () => {
			expect(() =>
				recordProducerGrant(
					'no-such-session',
					'system-enhancer',
					1,
					1,
					'system',
				),
			).not.toThrow();
		});
	});

	describe('recordProducerEmission / getProducerEmission', () => {
		it('records emitted and truncated amounts with surface', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			recordProducerEmission(
				SESSION_A,
				'knowledge-injector',
				660,
				40,
				'messages',
			);
			const summary = getTurnLedgerSummary(SESSION_A);
			const ki = summary?.producers.find(
				(p) => p.producer === 'knowledge-injector',
			);
			expect(ki?.emitted).toBe(660);
			expect(ki?.truncated).toBe(40);
			expect(ki?.surface).toBe('messages');
			expect(getProducerEmission(SESSION_A, 'knowledge-injector')).toBe(660);
		});

		it('emissions never deduct from the ceiling (fixed/base content)', () => {
			beginTurnLedger(SESSION_A, 1000, true);
			recordProducerEmission(SESSION_A, 'advisory-queue', 800, 0, 'messages');
			expect(getTurnLedgerSummary(SESSION_A)?.used).toBe(0);
		});

		it('returns 0 for unknown session or producer', () => {
			expect(getProducerEmission('no-such-session', 'system-enhancer')).toBe(0);
			beginTurnLedger(SESSION_A, 1000, true);
			expect(getProducerEmission(SESSION_A, 'system-enhancer')).toBe(0);
		});

		it('se knowledge-injector reads system-enhancer emission (demand relay)', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			recordProducerEmission(SESSION_A, 'system-enhancer', 2500, 0, 'system');
			expect(getProducerEmission(SESSION_A, 'system-enhancer')).toBe(2500);
		});
	});

	describe('advanceTurnGeneration / clearTurnLedger', () => {
		it('advance discards the ledger so the next composition starts fresh', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			claimTurnBudget(SESSION_A, 'memory-recall', 2000, {
				localMaxTokens: 2000,
			});
			advanceTurnGeneration(SESSION_A);
			expect(getTurnLedgerSummary(SESSION_A)).toBeNull();
		});

		it('clearTurnLedger is idempotent', () => {
			beginTurnLedger(SESSION_A, 4000, true);
			clearTurnLedger(SESSION_A);
			expect(() => clearTurnLedger(SESSION_A)).not.toThrow();
		});
	});

	describe('bounded session tracking (invariant 8)', () => {
		it('FIFO-evicts past MAX_TRACKED_SESSIONS without throwing', () => {
			// Fill well past the cap; the oldest entries fall out.
			for (let i = 0; i < 300; i++) {
				beginTurnLedger(`flood-session-${i}`, 1000, true);
			}
			const newest = getTurnLedgerSummary('flood-session-299');
			expect(newest?.totalBudget).toBe(1000);
			// The oldest was evicted; claiming against it fails open.
			const claim = claimTurnBudget('flood-session-0', 'memory-recall', 500, {
				localMaxTokens: 500,
			});
			expect(claim.ledgerPresent).toBe(false);
			// Cleanup: clear the flood sessions we created.
			for (let i = 0; i < 300; i++) {
				clearTurnLedger(`flood-session-${i}`);
			}
		});
	});
});
