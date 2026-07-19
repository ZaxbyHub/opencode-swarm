/**
 * Issue #1896 (sub-issue 3): the lean-turbo phase reviewer now fails over to a
 * configured `fallback_models` entry on a transient/quota dispatch error instead
 * of immediately writing a REJECTED verdict (a quota blip previously cascaded
 * into a false phase rejection). This is the representative integration proof for
 * the shared model-fallback wiring; the engine itself
 * (`dispatchWithModelFallback`) and the quota classifier are unit-tested
 * separately.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../../src/agents/index';
import type { PluginConfig } from '../../../../src/config';
import { resetSwarmState } from '../../../../src/state';
import {
	_internals,
	dispatchPhaseReviewer,
} from '../../../../src/turbo/lean/reviewer';

// Seed the default swarm map so the reviewer role has a fallback chain.
function seedReviewerFallback(): void {
	const config = {
		agents: {
			reviewer: {
				model: 'prov/primary-reviewer',
				fallback_models: ['prov/fb1', 'prov/fb2'],
			},
		},
	} as unknown as PluginConfig;
	getAgentConfigs(config);
}

const originalInternals = { ..._internals };

describe('dispatchPhaseReviewer — model failover (#1896)', () => {
	beforeEach(() => {
		resetSwarmState();
		seedReviewerFallback();
		// Stub the fs/parse dependencies so the test is pure.
		_internals.compileReviewPackage = (async () => ({
			phase: 1,
		})) as unknown as typeof _internals.compileReviewPackage;
		_internals.writeReviewerEvidence = async () => '/evidence/reviewer.json';
		_internals.parseReviewerVerdict = () => ({
			verdict: 'APPROVED',
			reason: 'looks good',
		});
	});

	afterEach(() => {
		Object.assign(_internals, originalInternals);
		resetSwarmState();
	});

	test('fails over to a fallback model on a quota dispatch error and recovers', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchReviewerAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			// Primary (registered model, no override) hits quota; fallback succeeds.
			if (!model)
				throw new Error('429 insufficient_quota: usage limit exceeded');
			return 'VERDICT: APPROVED';
		};

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-1',
			{ reviewerAgent: 'reviewer', timeoutMs: 0 },
		);

		// Recovered → APPROVED, NOT the old fail-closed REJECTED.
		expect(result.verdict).toBe('APPROVED');
		// Primary attempted (undefined), then the first fallback.
		expect(calls[0]).toBeUndefined();
		expect(calls[1]).toBe('prov/fb1');
	});

	test('a permanent dispatch error still fails closed (REJECTED) with no failover', async () => {
		const calls: Array<string | undefined> = [];
		_internals.dispatchReviewerAgent = async (
			_dir,
			_pkg,
			_agent,
			_timeout,
			_parent,
			model,
		) => {
			calls.push(model ? `${model.providerID}/${model.modelID}` : undefined);
			throw new Error('401 unauthorized: invalid api key');
		};

		const result = await dispatchPhaseReviewer(
			'/tmp/does-not-matter',
			1,
			'sess-2',
			{ reviewerAgent: 'reviewer', timeoutMs: 0 },
		);

		expect(result.verdict).toBe('REJECTED');
		// Only the primary was attempted — no fallover on a permanent error.
		expect(calls).toEqual([undefined]);
	});
});
