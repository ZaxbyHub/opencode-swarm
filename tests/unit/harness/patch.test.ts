import { describe, expect, test } from 'bun:test';
import {
	computeHarnessBlueprintHash,
	computePromptArtifactHash,
	computePromptBindingHash,
	parseHarnessBlueprint,
} from '../../../src/harness/contracts.js';
import {
	applyBlueprintPatch,
	deriveBlueprintPatchRiskTier,
} from '../../../src/harness/patch.js';

function blueprint() {
	const promptBase = {
		v: 1 as const,
		promptId: 'architect.prompt',
		role: 'system' as const,
		content: 'You are the architect.',
	};
	return parseHarnessBlueprint({
		v: 0,
		id: 'bp-1',
		definitionHash: 'a'.repeat(64),
		prompts: [
			{
				...promptBase,
				contentHash: computePromptArtifactHash(promptBase),
			},
		],
		tools: [{ v: 1, toolId: 'diff' }],
		agents: [
			{
				v: 1,
				agentName: 'architect',
				description: 'Primary agent',
				mode: 'primary',
				temperature: 0.1,
				promptId: 'architect.prompt',
				tools: ['diff'],
			},
		],
		orchestration: {
			v: 1,
			defaultAgent: 'architect',
			activation: 'manual',
			execution: 'disabled',
			multiSwarm: false,
		},
		constraints: {
			v: 1,
			sourceAllowlist: ['src/agents'],
			extraProtectedPaths: [],
			maxPatchBytes: 1_048_576,
			maxFiles: 64,
			maxFileBytes: 524_288,
			maxTotalBytes: 4_194_304,
			maxChangedLines: 10_000,
			maxVersions: 100,
			maxReplayRecords: 10_000,
			maxOutputBytes: 262_144,
		},
	});
}

describe('harness blueprint patching', () => {
	test('applies atomic typed operations without mutating the input', () => {
		const base = blueprint();
		const before = structuredClone(base);
		const updatedPromptBase = {
			v: 1 as const,
			promptId: 'architect.prompt',
			candidateId: 'candidate-updated',
			bytes: Buffer.byteLength('You are the updated architect.', 'utf8'),
			mediaType: 'text/plain; charset=utf-8' as const,
			content: 'You are the updated architect.',
			provenance: {
				source: 'candidate' as const,
				origin: 'issue-1825',
			},
		};
		const candidate = {
			...base,
			agents: [
				{
					...base.agents[0]!,
					prompt: {
						v: 1 as const,
						promptId: 'architect.prompt',
						ref: `candidate:candidate-updated:${computePromptArtifactHash(updatedPromptBase)}`,
						sha256: computePromptArtifactHash(updatedPromptBase),
					},
				},
			],
			tools: [
				...base.tools,
				{
					v: 1 as const,
					toolId: 'swarm_command',
				},
			],
			contentHash: '',
		};
		candidate.contentHash = computeHarnessBlueprintHash(candidate);
		const result = applyBlueprintPatch(base, {
			v: 1,
			patchId: 'patch-1',
			expectedBaseHash: base.contentHash,
			expectedResultHash: candidate.contentHash,
			operations: [
				{
					op: 'upsert_prompt',
					fieldPath: 'prompts/architect.prompt',
					expectedFieldHash: computePromptBindingHash(base.agents[0]!.prompt),
					prompt: {
						...updatedPromptBase,
						sha256: computePromptArtifactHash(updatedPromptBase),
					},
				},
				{
					op: 'upsert_tool',
					fieldPath: 'tools/swarm_command',
					expectedFieldHash: null,
					tool: candidate.tools[1]!,
				},
			],
		});

		expect(base).toEqual(before);
		expect(result.agents[0]?.prompt.ref).toContain(
			'candidate:candidate-updated:',
		);
		expect(result.tools.map((tool) => tool.toolId)).toEqual([
			'diff',
			'swarm_command',
		]);
		expect(result.contentHash).toBe(candidate.contentHash);
	});

	test('rejects stale base hashes, stale field hashes, and mismatched result hashes', () => {
		const base = blueprint();
		expect(() =>
			applyBlueprintPatch(base, {
				v: 1,
				patchId: 'patch-stale-base',
				expectedBaseHash: '0'.repeat(64),
				expectedResultHash: base.contentHash,
				operations: [],
			}),
		).toThrow('expected base hash');

		expect(() =>
			applyBlueprintPatch(base, {
				v: 1,
				patchId: 'patch-stale-field',
				expectedBaseHash: base.contentHash,
				expectedResultHash: base.contentHash,
				operations: [
					{
						op: 'remove_tool',
						fieldPath: 'tools/diff',
						expectedFieldHash: '1'.repeat(64),
					},
				],
			}),
		).toThrow('expected field hash');

		expect(() =>
			applyBlueprintPatch(base, {
				v: 1,
				patchId: 'patch-bad-result',
				expectedBaseHash: base.contentHash,
				expectedResultHash: '2'.repeat(64),
				operations: [],
			}),
		).toThrow('expected result hash');
	});

	test('rejects cross-target operations', () => {
		const base = blueprint();

		expect(() =>
			applyBlueprintPatch(base, {
				v: 1,
				patchId: 'patch-cross-target',
				expectedBaseHash: base.contentHash,
				expectedResultHash: base.contentHash,
				operations: [
					{
						op: 'upsert_tool',
						fieldPath: 'tools/diff',
						expectedFieldHash: 'a'.repeat(64),
						tool: { v: 1, toolId: 'other' },
					},
				],
			}),
		).toThrow('target fieldPath');
	});

	test('derives conservative risk from the touched fields', () => {
		expect(
			deriveBlueprintPatchRiskTier([
				{
					op: 'upsert_prompt',
					fieldPath: 'prompts/architect.prompt',
					expectedFieldHash: null,
					prompt: {
						v: 1,
						promptId: 'architect.prompt',
						candidateId: 'candidate-risk',
						bytes: Buffer.byteLength('Prompt', 'utf8'),
						mediaType: 'text/plain; charset=utf-8',
						content: 'Prompt',
						provenance: {
							source: 'candidate',
							origin: 'issue-1825',
						},
						sha256: 'f'.repeat(64),
					},
				},
			]),
		).toBe('low');

		expect(
			deriveBlueprintPatchRiskTier([
				{
					op: 'replace_constraints',
					fieldPath: 'constraints',
					expectedFieldHash: 'a'.repeat(64),
					constraints: blueprint().constraints,
				},
			]),
		).toBe('high');
	});
});
