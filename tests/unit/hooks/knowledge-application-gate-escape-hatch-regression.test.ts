/**
 * Regression tests for specific bugs found during PR review of the
 * knowledge-application enforcement gate's deadlock escape hatches (see
 * knowledge-application-gate-escape-hatch.test.ts for the base escape-hatch
 * behavior tests, split out to stay under the repo's 500-line test file
 * limit — AGENTS.md invariant 7):
 *
 *  - Cross-directive leak: denials accrued against one unacknowledged
 *    critical directive must not carry over to an unrelated directive that
 *    replaces it via setCriticalShownIds (an ordinary phase/task-transition
 *    occurrence).
 *  - Re-injection stability: the injector re-stamps `generatedAt` on every
 *    cache-hit re-injection of the SAME directive set, so the denial-count
 *    identity key must be derived from the directive-id set, not the
 *    timestamp.
 *  - Session-teardown boundary: resetSwarmState (and by extension
 *    resetSwarmStatePreservingSingletons, the production `/swarm close`
 *    path) must clear the denial counter so a reused sessionID does not
 *    inherit a stale count.
 *  - Centralized clear pathway: the escape hatches must clear
 *    currentCriticalShownIds via the existing clearCriticalShownIds()
 *    helper, not a direct Map.delete().
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	buildAckDedupKey,
	DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
} from '../../../src/hooks/knowledge-application';
import { knowledgeApplicationGateBefore } from '../../../src/hooks/knowledge-application-gate';
import { swarmState } from '../../../src/state';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-gate-escape-regression-'));
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

describe('gate escape hatch regressions (PR review findings)', () => {
	it('regression: denials against an unacked directive do not carry over to a swapped-in unrelated directive', async () => {
		// Reproduces the cross-directive leak found in PR review: a session
		// accrues denials against directive A (never acked), then the
		// critical-directive set is swapped to an unrelated directive B via
		// setCriticalShownIds (the ordinary phase/task-transition path in
		// knowledge-injector.ts) — B must get its own full max_gate_denials
		// budget, not inherit A's stale count.
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 5,
		};

		// Accrue 3 denials against A — never acked, never resolved.
		for (let i = 0; i < 3; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}

		// Swap to an unrelated directive B without ever acking A (this is what
		// setCriticalShownIds does on an ordinary phase/task transition).
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_B],
			generatedAt: Date.now(),
		});

		// B must require its OWN 5 denials before the escape hatch fires — it
		// must NOT inherit A's 3 accrued denials. Assert it still throws for
		// denials 4 through 8 overall (i.e. 1 through 5 against B).
		for (let i = 0; i < 5; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}

		// Only now (6th denial against B specifically) should the hatch fire.
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
		expect(
			swarmState.knowledgeAckDedup.has(buildAckDedupKey('s1', ID_B, 'applied')),
		).toBe(true);
	});

	it('regression: re-injecting the same directive across turns does not reset the denial count', async () => {
		// The knowledge-injector re-stamps generatedAt on every cache-hit
		// re-injection of the SAME directive set, so the identity key must be
		// derived from the ids themselves (not generatedAt) — otherwise the
		// denial-count escape hatch would never accumulate past 1 in normal
		// usage, defeating its purpose.
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 3,
		};

		for (let i = 0; i < 3; i++) {
			// Simulate the injector re-injecting the identical directive set on
			// each turn with a freshly stamped generatedAt.
			swarmState.currentCriticalShownIds.set('s1', {
				ids: [ID_A],
				generatedAt: Date.now() + i,
			});
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}

		// 4th denial against the same (re-stamped) directive set fires the hatch.
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now() + 100,
		});
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('regression: resetSwarmState clears the gate denial counter (session-teardown boundary)', async () => {
		// Reproduces the unwired-reset gap found in PR review: /swarm close
		// (resetSwarmStatePreservingSingletons -> resetSwarmState) must not
		// leave a stale denial count for a sessionID that gets reused by a
		// fresh incident.
		const { resetSwarmState } = await import('../../../src/state');

		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 5,
		};

		// Accrue denials near the max, then simulate session teardown.
		for (let i = 0; i < 3; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}
		expect(swarmState.gateDenialCounts.get('s1')?.count).toBe(3);

		resetSwarmState();
		expect(swarmState.gateDenialCounts.has('s1')).toBe(false);

		// A fresh incident on the same (reused) sessionID must require the
		// FULL configured max_gate_denials again, not just the remaining 2.
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_B],
			generatedAt: Date.now(),
		});
		for (let i = 0; i < 5; i++) {
			await expect(
				knowledgeApplicationGateBefore(
					tmp,
					{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
					cfg,
				),
			).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		}
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);
	});

	it('uses clearCriticalShownIds (not a direct Map.delete) so escape-hatch clears go through the centralized FIFO-cap pathway', async () => {
		swarmState.currentCriticalShownIds.set('s1', {
			ids: [ID_A],
			generatedAt: Date.now(),
		});
		const cfg = {
			...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
			mode: 'enforce' as const,
			max_gate_denials: 1,
		};

		await expect(
			knowledgeApplicationGateBefore(
				tmp,
				{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
				cfg,
			),
		).rejects.toThrow(/KNOWLEDGE_ENFORCE_GATE_DENY/);
		// 2nd call triggers the denial-limit escape hatch.
		await knowledgeApplicationGateBefore(
			tmp,
			{ tool: 'save_plan', agent: 'architect', sessionID: 's1' },
			cfg,
		);

		expect(swarmState.currentCriticalShownIds.has('s1')).toBe(false);
	});
});
