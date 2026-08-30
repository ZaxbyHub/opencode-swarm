import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	computeHarnessBlueprintHash,
	computePromptArtifactHash,
} from '../../../src/harness/contracts.js';
import {
	_factoryInternals,
	computeRuntimeDefinitionsHash,
	createAgentFactory,
	createToolFactory,
	type RuntimeAgentDefinition,
} from '../../../src/harness/factory.js';

function runtimeDefinitions(): RuntimeAgentDefinition[] {
	return [
		{
			name: 'architect',
			description: 'Architect',
			config: {
				mode: 'primary',
				temperature: 0.1,
				prompt: 'You are the architect.',
				tools: { diff: true, swarm_command: true, shell: false },
			},
		},
		{
			name: 'coder',
			description: 'Coder',
			config: {
				mode: 'subagent',
				model: 'gpt-5.5',
				temperature: 0.2,
				prompt: 'You are the coder.',
				tools: { diff: true, shell: false },
			},
		},
		{
			name: 'local_architect',
			description: '[Local] Architect',
			config: {
				mode: 'primary',
				temperature: 0.1,
				prompt: 'You are the local architect.',
				tools: { diff: true, swarm_command: true, shell: false },
			},
		},
	];
}

describe('harness factories', () => {
	const realLoadHarnessPromptArtifact =
		_factoryInternals.loadHarnessPromptArtifact;

	afterEach(() => {
		_factoryInternals.loadHarnessPromptArtifact = realLoadHarnessPromptArtifact;
	});

	test('rejects unknown and duplicate tool inventory instead of filtering it', () => {
		const factory = createToolFactory(['diff', 'swarm_command']);
		expect(() =>
			factory.projectTools(['diff', 'ghost_tool', 'swarm_command']),
		).toThrow('registered');
		expect(() => createToolFactory(['diff', 'diff'])).toThrow('duplicates');
		expect(factory.materializeTools([{ v: 1, toolId: 'diff' }])).toEqual([
			'diff',
		]);
		expect(() =>
			factory.materializeTools([{ v: 1, toolId: 'ghost_tool' }]),
		).toThrow('registered');
	});

	test('projects exact supplied runtime definitions into a blueprint and materializes them back', () => {
		const factory = createAgentFactory({
			runtimeDefinitions: runtimeDefinitions(),
			registeredToolIds: ['diff', 'swarm_command'],
		});
		const blueprint = factory.projectBlueprint({
			blueprintId: 'bp-1',
			agentNames: ['architect', 'local_architect'],
			defaultAgent: 'local_architect',
		});

		expect(blueprint.definitionsHash).toBe(factory.definitionsHash);
		expect(blueprint.orchestration.defaultAgent).toBe('local_architect');
		expect(blueprint.orchestration.multiSwarm).toBe(true);
		expect(
			blueprint.agents.map((agent) => `${agent.agentName}:${agent.mode}`),
		).toEqual(['architect:primary', 'local_architect:primary']);
		expect(blueprint.agents[0]?.prompt.ref).toBe('static:architect');
		expect(blueprint.tools.map((tool) => tool.toolId)).toEqual([
			'diff',
			'swarm_command',
		]);

		const materialized = factory.materializeBlueprint(blueprint);
		expect(materialized.map((agent) => agent.name)).toEqual([
			'architect',
			'local_architect',
		]);
		expect(materialized[0]?.config.prompt).toBe('You are the architect.');
		expect(materialized[1]?.config.mode).toBe('primary');
		expect(materialized[0]?.config.tools).toEqual({
			diff: true,
			swarm_command: true,
			shell: false,
		});
		expect(materialized[1]?.config.tools).toEqual({
			diff: true,
			swarm_command: true,
			shell: false,
		});
	});

	test('preserves explicit disabled tool flags in the blueprint contract', () => {
		const factory = createAgentFactory({
			runtimeDefinitions: runtimeDefinitions(),
			registeredToolIds: ['diff', 'swarm_command'],
		});
		const blueprint = factory.projectBlueprint({
			blueprintId: 'bp-disabled-tools',
			agentNames: ['architect'],
		});

		expect(blueprint.agents[0]?.tools).toEqual(['diff', 'swarm_command']);
		expect(blueprint.agents[0]?.disabledTools).toEqual(['shell']);
		expect(factory.materializeBlueprint(blueprint)[0]?.config.tools).toEqual({
			diff: true,
			swarm_command: true,
			shell: false,
		});
	});

	test('loads a candidate prompt artifact exactly once and binds content plus provenance from that same read', () => {
		const factory = createAgentFactory({
			runtimeDefinitions: [
				{
					name: 'architect',
					description: 'Architect',
					config: {
						mode: 'primary',
						temperature: 0.1,
						prompt: 'Static prompt',
						tools: { diff: true, shell: false },
					},
				},
			],
			registeredToolIds: ['diff'],
		});
		const promptContent = 'Candidate prompt v1';
		const artifactBase = {
			v: 1 as const,
			promptId: 'architect.prompt',
			candidateId: 'candidate-1',
			bytes: Buffer.byteLength(promptContent, 'utf8'),
			mediaType: 'text/plain; charset=utf-8' as const,
			content: promptContent,
			provenance: {
				source: 'candidate' as const,
				origin: 'issue-1825',
			},
		};
		const artifact = {
			...artifactBase,
			sha256: computePromptArtifactHash(artifactBase),
		};
		let loadCount = 0;
		_factoryInternals.loadHarnessPromptArtifact = (() => {
			loadCount += 1;
			return structuredClone(artifact);
		}) as typeof _factoryInternals.loadHarnessPromptArtifact;

		const blueprint = factory.projectBlueprint({
			blueprintId: 'bp-candidate-prompt',
			agentNames: ['architect'],
		});
		blueprint.agents[0] = {
			...blueprint.agents[0]!,
			prompt: {
				v: 1,
				promptId: artifact.promptId,
				ref: `candidate:${artifact.candidateId}:${artifact.sha256}`,
				sha256: artifact.sha256,
			},
		};
		blueprint.contentHash = computeHarnessBlueprintHash({
			...blueprint,
			contentHash: '',
		});

		const [materialized] = factory.materializeBlueprint(blueprint, {
			directory: process.cwd(),
		});
		expect(loadCount).toBe(1);
		expect(materialized?.config.prompt).toBe(promptContent);
		expect(materialized?.harnessPromptProvenance).toEqual({
			source: 'candidate',
			promptId: artifact.promptId,
			sha256: artifact.sha256,
			candidateId: artifact.candidateId,
		});
	});

	test('rejects stale blueprint definitions hashes and direct createAgents coupling', () => {
		const factory = createAgentFactory({
			runtimeDefinitions: runtimeDefinitions(),
			registeredToolIds: ['diff', 'swarm_command'],
		});
		const blueprint = factory.projectBlueprint({
			blueprintId: 'bp-stale',
			agentNames: ['architect'],
		});
		expect(() =>
			factory.materializeBlueprint({
				...blueprint,
				definitionsHash: '0'.repeat(64),
				contentHash: computeHarnessBlueprintHash({
					...blueprint,
					definitionsHash: '0'.repeat(64),
					contentHash: '',
				}),
			}),
		).toThrow('definitions hash');

		for (const relativePath of [
			'src/harness/contracts.ts',
			'src/harness/hash.ts',
			'src/harness/patch.ts',
			'src/harness/factory.ts',
		]) {
			const content = readFileSync(path.resolve(relativePath), 'utf8');
			expect(content).not.toContain('createAgents(');
			expect(content).not.toContain("from '../agents");
		}
	});
});
