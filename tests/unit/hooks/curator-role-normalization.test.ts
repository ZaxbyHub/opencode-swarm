/**
 * Tests for the v2 curator role normalization (Phase F′ remediation):
 * uses the repository's canonical resolver `getCanonicalAgentRole` instead
 * of the hard-coded (mega|paid|local|lowtier|modelrelay)_ prefix list.
 *
 * The internal helper `normalizeAgentName` is not exported, but it is
 * exercised through `_internals.normalizeAgentName` if available; otherwise
 * we exercise it via filterPhaseEvents → checkCompliance → normalizeAgentName.
 * Here we exercise the canonical resolver directly to lock the contract,
 * plus a small end-to-end check that arbitrary swarm IDs round-trip.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { getCanonicalAgentRole } from '../../../src/config/schema';
import { _internals as curatorInternals } from '../../../src/hooks/curator';
import { swarmState } from '../../../src/state';

beforeEach(() => {
	mock.restore();
	swarmState.generatedAgentNames = [];
});
afterEach(() => {
	swarmState.generatedAgentNames = [];
	mock.restore();
});

describe('normalizeAgentName via canonical resolver', () => {
	it('arbitrary swarm prefixes normalize when registry is populated', () => {
		swarmState.generatedAgentNames = [
			'banana_coder',
			'acme-prod_reviewer',
			'customer123_test_engineer',
			'paid_architect',
		];
		expect(curatorInternals.normalizeAgentName('banana_coder')).toBe('coder');
		expect(curatorInternals.normalizeAgentName('acme-prod_reviewer')).toBe(
			'reviewer',
		);
		expect(
			curatorInternals.normalizeAgentName('customer123_test_engineer'),
		).toBe('test_engineer');
		expect(curatorInternals.normalizeAgentName('paid_architect')).toBe(
			'architect',
		);
	});

	it('does not normalize arbitrary prose like "not_an_architect" to architect', () => {
		// Registry is empty — resolver falls back to suffix-match against
		// ALL_AGENT_NAMES. The CANONICAL resolver behaviour: "not_an_architect"
		// is allowed to map to architect by the legacy stripKnownSwarmPrefix
		// fallback when registry is undefined. Test the registry-aware path.
		swarmState.generatedAgentNames = ['banana_coder', 'paid_architect'];
		// not_an_architect is NOT in the registry — must NOT collapse to
		// architect even though it suffix-matches.
		expect(curatorInternals.normalizeAgentName('not_an_architect')).not.toBe(
			'architect',
		);
	});

	it('preserves compound canonical roles', () => {
		swarmState.generatedAgentNames = [
			'critic_oversight',
			'curator_phase',
			'skill_improver',
			'spec_writer',
		];
		expect(curatorInternals.normalizeAgentName('critic_oversight')).toBe(
			'critic_oversight',
		);
		expect(curatorInternals.normalizeAgentName('curator_phase')).toBe(
			'curator_phase',
		);
		expect(curatorInternals.normalizeAgentName('skill_improver')).toBe(
			'skill_improver',
		);
		expect(curatorInternals.normalizeAgentName('spec_writer')).toBe(
			'spec_writer',
		);
	});

	it('init-time race: empty registry falls back to permissive resolver (no regression vs v1)', () => {
		swarmState.generatedAgentNames = [];
		// Empty registry → undefined registry passed to the resolver →
		// permissive suffix scan against ALL_AGENT_NAMES. This is the
		// fallback path that preserves today's behaviour while the registry
		// is being populated.
		expect(curatorInternals.normalizeAgentName('paid_architect')).toBe(
			'architect',
		);
	});
});

describe('getCanonicalAgentRole contract', () => {
	it('returns the input unchanged when not in registry and registry is provided', () => {
		expect(
			getCanonicalAgentRole('paid_architect', ['only_one_real_agent']),
		).toBe('paid_architect');
	});
});
