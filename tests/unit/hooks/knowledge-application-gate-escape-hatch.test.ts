/**
 * Tests for the knowledge-application enforcement gate's deadlock escape
 * hatches (denial-count limit + staleness TTL). Split from
 * knowledge-application-gate.test.ts to stay under the repo's 500-line test
 * file limit (AGENTS.md invariant 7). Regression tests for the specific
 * cross-directive-leak / session-teardown bugs found in PR review live in
 * knowledge-application-gate-escape-hatch-regression.test.ts; FIFO eviction
 * of the underlying counter lives in
 * knowledge-application-gate-denial-fifo.test.ts.
 *
 * Notes:
 *  - The gate consults swarmState.currentCriticalShownIds,
 *    swarmState.knowledgeAckDedup, and swarmState.gateDenialCounts. Tests
 *    prime/clear them between cases.
 *  - In `enforce` mode the gate throws KNOWLEDGE_ENFORCE_GATE_DENY until an
 *    escape hatch fires.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	buildAckDedupKey,
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
} from '../../../src/hooks/knowledge-application';
import { knowledgeApplicationGateBefore } from '../../../src/hooks/knowledge-application-gate';
import { swarmState } from '../../../src/state';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-gate-escape-'));
	swarmState.currentCriticalShownIds.clear();
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

const ID_A = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
/** Fixed reference instant for staleness escape-hatch tests (withFrozenClockAsync). */
const FIXED_NOW = 1_700_000_000_000;

describe('gate escape hatches (KNOWLEDGE_ENFORCE_GATE_DENY deadlock)', () => {
	it('auto-clears after max_gate_denials exceeded (default 5)', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
		};

		// First 5 calls should throw
		for (let i = 0; i < 5; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}

		// 6th call should pass (escape hatch fires)
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
		// no throw
	});

	it('respects custom max_gate_denials from config', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 2,
		};

		// First 2 calls throw
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// 3rd call passes
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('auto-clears stale directives older than gate_staleness_ms', async () => {
		await withFrozenClockAsync(
			async () => {
				const staleTime = FIXED_NOW - 700_000; // 700s ago > 600s default
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A],
					generatedAt: staleTime,
				});
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
				};

				// Should NOT throw — directive is stale
				await knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('respects custom gate_staleness_ms from config', async () => {
		await withFrozenClockAsync(
			async () => {
				const staleTime = FIXED_NOW - 15_000; // 15s ago
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A],
					generatedAt: staleTime,
				});
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
					gate_staleness_ms: 10_000, // 10s staleness
				};

				// Should NOT throw — 15s > 10s
				await knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('still throws when within staleness threshold', async () => {
		await withFrozenClockAsync(
			async () => {
				const recentTime = FIXED_NOW - 1_000; // 1s ago
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A],
					generatedAt: recentTime,
				});
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
				};

				await expect(
					knowledgeApplicationGateBefore(
						tmp,
						{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
						cfg,
					),
				).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('populates knowledgeAckDedup after escape hatch fires', async () => {
		await withFrozenClockAsync(
			async () => {
				const staleTime = FIXED_NOW - 700_000;
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A, ID_B],
					generatedAt: staleTime,
				});
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
				};

				await knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				);

				// Both IDs should now be in the dedup set as 'applied'
				expect(
					swarmState.knowledgeAckDedup.has(
						buildAckDedupKey('s1', ID_A, 'applied'),
					),
				).toBe(true);
				expect(
					swarmState.knowledgeAckDedup.has(
						buildAckDedupKey('s1', ID_B, 'applied'),
					),
				).toBe(true);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('clears currentCriticalShownIds for session after escape hatch', async () => {
		await withFrozenClockAsync(
			async () => {
				const staleTime = FIXED_NOW - 700_000;
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A],
					generatedAt: staleTime,
				});
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
				};

				await knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				);

				expect(swarmState.currentCriticalShownIds.has('s1')).toBe(false);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('writes warning event to events.jsonl on staleness clear', async () => {
		await withFrozenClockAsync(
			async () => {
				const staleTime = FIXED_NOW - 700_000;
				swarmState.currentCriticalShownIds.set('s1', {
					ids: [ID_A],
					generatedAt: staleTime,
				});
				await mkdir(path.join(tmp, '.swarm'), { recursive: true });
				const cfg = {
					...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
					mode: 'enforce' as const,
				};

				await knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				);

				// The audit write is awaited inside knowledgeApplicationGateBefore
				// before it returns, so the event is already durable here — no
				// sleep needed.
				const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
				expect(existsSync(eventsPath)).toBe(true);
				const body = readFileSync(eventsPath, 'utf-8');
				expect(body).toContain('knowledge_application_gate_staleness_clear');
				expect(body).toContain(ID_A);
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	it('writes warning event to events.jsonl on denial limit clear', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 1,
		};

		// First call throws
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// Second call triggers escape
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		// The audit write is awaited inside knowledgeApplicationGateBefore
		// before it returns, so the event is already durable here — no sleep
		// needed.
		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		expect(existsSync(eventsPath)).toBe(true);
		const body = readFileSync(eventsPath, 'utf-8');
		expect(body).toContain('knowledge_application_gate_denial_limit_clear');
	});

	it('denial counter resets after successful ack', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 3,
		};

		// Accumulate 2 denials
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// Simulate successful ack
		swarmState.knowledgeAckDedup.add(buildAckDedupKey('s1', ID_A, 'applied'));

		// This should pass (acked) and clear the counter
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		// Now remove ack and add new critical ID — counter should be fresh
		swarmState.knowledgeAckDedup.clear();
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_B],
			generatedAt: Date.now(),
		});

		// Should need full 3 denials again before escape
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);

		// 4th call passes (escape fires)
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});
});
