import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	_test_exports,
	MAX_PROMPT_CHARS,
} from '../../../src/tools/dispatch-lanes';

const originalInternals = { ..._internals };

afterEach(() => {
	Object.assign(_internals, originalInternals);
});

function applyExplorerFormatSuffix(
	lanes: Parameters<typeof _test_exports.applyExplorerFormatSuffix>[0],
) {
	const result = _test_exports.applyExplorerFormatSuffix(lanes);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.errors.join('; '));
	return result.lanes;
}

describe('applyExplorerFormatSuffix', () => {
	test('appends format suffix to explorer-role lanes', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toContain('inspect runtime');
		expect(result[0].prompt).toContain('[CANDIDATE]');
	});

	test('skips non-explorer lanes', () => {
		_internals.getGeneratedAgentNames = () => [
			'swarm_explorer',
			'swarm_reviewer',
		];
		const lanes = [
			{ id: 'L1', agent: 'swarm_reviewer', prompt: 'review findings' },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe('review findings');
		expect(result[0].prompt).not.toContain('[CANDIDATE]');
	});

	test('a casual [CANDIDATE] mention does not suppress the controller contract', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const originalPrompt = 'inspect with [CANDIDATE] format already';
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: originalPrompt },
		];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).not.toBe(originalPrompt);
		expect(result[0].prompt).toContain('CONTROLLER-BOUND OUTPUT IDENTITY');
		expect(result[0].prompt).toContain('[CLEAN] | lane');
		expect(result[0].prompt).toContain('[CLEAN] | micro_lane');
		expect(result[0].prompt).toContain('for swarm-pr-review:council discovery');
		expect(result[0].prompt).toContain('at least 12 characters');
		expect(result[0].prompt).toMatch(/at least 20\s+characters/);
		expect(result[0].prompt).not.toContain(
			'Fill every CLEAN field with the exact workflow_lane',
		);
	});

	test('applying the controller contract twice is idempotent', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{ id: 'L1', agent: 'swarm_explorer', prompt: 'inspect runtime' },
		];
		const once = applyExplorerFormatSuffix(lanes);
		const twice = applyExplorerFormatSuffix(once);
		expect(twice).toEqual(once);
	});

	test.each([
		{
			mode: 'swarm-pr-review:base',
			expected: 'exact workflow_lane only in the `lane` field',
		},
		{
			mode: 'swarm-pr-review:micro',
			expected: 'exact workflow_lane only in the `micro_lane` field',
		},
	] as const)('binds $mode to its exact row-family field', ({
		mode,
		expected,
	}) => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'L1',
					agent: 'swarm_explorer',
					prompt: 'inspect runtime',
				},
			],
			{ failClosed: true, mode },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		expect(result.lanes[0].prompt).toContain(expected);
	});

	test('appends the controller identity exactly once for a consolidated Tier-M lane', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const lanes = [
			{
				id: 'L1',
				agent: 'swarm_explorer',
				prompt: 'inspect the consolidated review surface',
				workflow_lane: 'auth-identity-secrets',
				owned_workflow_lanes: [
					'auth-identity-secrets',
					'privacy-data-handling',
				],
			},
		];
		const twice = applyExplorerFormatSuffix(applyExplorerFormatSuffix(lanes));

		expect(
			twice[0].prompt.match(/CONTROLLER-BOUND OUTPUT IDENTITY/g),
		).toHaveLength(1);
		expect(twice[0].prompt).toContain(
			'[CLEAN] | lane | coverage_scope | evidence',
		);
		expect(twice[0].prompt).toContain(
			'[CLEAN] | micro_lane | coverage_scope | evidence',
		);
	});

	test('preserves generic dispatch compatibility when appending would exceed MAX_PROMPT_CHARS', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS - 10);
		const lanes = [{ id: 'L1', agent: 'swarm_explorer', prompt: longPrompt }];
		const result = applyExplorerFormatSuffix(lanes);
		expect(result[0].prompt).toBe(longPrompt);
	});

	test('fails closed for PR-workflow enforcement when the suffix would overflow', () => {
		_internals.getGeneratedAgentNames = () => ['swarm_explorer'];
		const result = _test_exports.applyExplorerFormatSuffix(
			[
				{
					id: 'L1',
					agent: 'swarm_explorer',
					prompt: 'x'.repeat(MAX_PROMPT_CHARS - 10),
				},
			],
			{ failClosed: true },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected fail-closed result');
		expect(result.errors.join('; ')).toContain(
			'mandatory explorer output contract',
		);
		expect(result.errors.join('; ').length).toBeLessThan(300);
	});
});
