import { describe, expect, it } from 'bun:test';
import { harnessMutationV1 } from '../../../src/index.js';

describe('public harness mutation API', () => {
	it('exports a callable, explicit, non-executing namespace', () => {
		expect(typeof harnessMutationV1).toBe('function');
		expect(harnessMutationV1()).toBe(harnessMutationV1);
		expect(Object.isFrozen(harnessMutationV1)).toBe(true);
		expect(Object.keys(harnessMutationV1).sort()).toEqual([
			'activate',
			'applyPatchSet',
			'auditLedger',
			'current',
			'diff',
			'history',
			'projectStaticBlueprint',
			'recoverCorruptTail',
			'rollback',
			'saveCandidate',
			'saveVersion',
			'validateBlueprint',
			'validateSourceCandidate',
		]);
		expect(typeof harnessMutationV1.validateBlueprint).toBe('function');
		expect(typeof harnessMutationV1.saveCandidate).toBe('function');
		expect(typeof harnessMutationV1.saveVersion).toBe('function');
		expect(typeof harnessMutationV1.activate).toBe('function');
		expect(typeof harnessMutationV1.auditLedger).toBe('function');
		expect(typeof harnessMutationV1.recoverCorruptTail).toBe('function');
		expect('parseBlueprint' in harnessMutationV1).toBe(false);
		expect('recordCandidate' in harnessMutationV1).toBe(false);
		expect('activateCandidate' in harnessMutationV1).toBe(false);
	});

	it('projects static agents deterministically regardless of insertion order', () => {
		const agent = (name: string, toolIds: string[]) => ({
			name,
			description: `${name} agent`,
			config: {
				mode: 'subagent' as const,
				prompt: `${name} prompt`,
				tools: Object.fromEntries(toolIds.map((toolId) => [toolId, true])),
			},
		});
		const first = harnessMutationV1.projectStaticBlueprint({
			alpha: agent('alpha', ['z-tool', 'a-tool']),
			beta: agent('beta', ['b-tool']),
		});
		const second = harnessMutationV1.projectStaticBlueprint({
			beta: agent('beta', ['b-tool']),
			alpha: agent('alpha', ['a-tool', 'z-tool']),
		});
		expect(second).toEqual(first);
	});
});
