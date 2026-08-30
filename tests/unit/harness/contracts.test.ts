import { describe, expect, test } from 'bun:test';
import {
	AgentBlueprintV1Schema,
	computeHarnessBlueprintHash,
	computeHarnessCandidateManifestHash,
	computePromptArtifactHash,
	deriveHarnessCandidateFloors,
	deriveHarnessCandidateRiskTier,
	HarnessBlueprintV1Schema,
	HarnessCandidateManifestV1Schema,
	HarnessConstraintsV1Schema,
	OrchestrationSpecV1Schema,
	PromptArtifactV1Schema,
	parseBlueprintPatch,
	parseHarnessBlueprint,
	parseHarnessCandidateManifest,
	ToolSpecV1Schema,
} from '../../../src/harness/contracts.js';
import { canonicalHash, canonicalJson } from '../../../src/harness/hash.js';

function prompt(content: string) {
	const base = {
		v: 1 as const,
		promptId: 'architect.prompt',
		candidateId: 'candidate-1',
		bytes: Buffer.byteLength(content, 'utf8'),
		mediaType: 'text/plain; charset=utf-8' as const,
		content,
		provenance: {
			source: 'candidate' as const,
			origin: 'issue-1825',
		},
	};
	return {
		...base,
		sha256: computePromptArtifactHash(base),
	};
}

function legacyPrompt(content: string) {
	return {
		v: 1 as const,
		promptId: 'architect.prompt',
		role: 'system' as const,
		content,
		contentHash: canonicalHash({
			v: 1,
			promptId: 'architect.prompt',
			role: 'system',
			content,
		}),
	};
}

describe('harness canonical hashing', () => {
	test('stabilizes key order, normalizes -0, and rejects non-finite values', () => {
		expect(canonicalJson({ z: -0, a: { y: 2, x: 1 } })).toBe(
			'{"a":{"x":1,"y":2},"z":0}',
		);
		expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
		expect(() => canonicalJson({ value: Number.NaN })).toThrow('non-finite');
		expect(() => canonicalJson(undefined)).toThrow('top-level undefined');
	});
});

describe('harness contracts', () => {
	test('accept bounded v1 schemas and reject unknown keys', () => {
		const promptArtifact = prompt('You are the architect.');
		expect(PromptArtifactV1Schema.parse(promptArtifact).promptId).toBe(
			'architect.prompt',
		);
		expect(ToolSpecV1Schema.parse({ v: 1, toolId: 'diff' }).toolId).toBe(
			'diff',
		);
		expect(
			AgentBlueprintV1Schema.parse({
				v: 1,
				agentName: 'architect',
				description: 'Primary agent',
				mode: 'primary',
				temperature: 0.1,
				prompt: {
					v: 1,
					promptId: promptArtifact.promptId,
					ref: 'candidate:candidate-1:'.concat(promptArtifact.sha256),
					sha256: promptArtifact.sha256,
				},
				tools: ['diff', 'swarm_command'],
				disabledTools: ['shell'],
			}).agentName,
		).toBe('architect');
		expect(
			AgentBlueprintV1Schema.safeParse({
				v: 1,
				agentName: 'architect',
				mode: 'primary',
				temperature: 0.1,
				prompt: {
					v: 1,
					promptId: promptArtifact.promptId,
					ref: 'candidate:candidate-1:'.concat(promptArtifact.sha256),
					sha256: promptArtifact.sha256,
				},
				tools: ['diff'],
				disabledTools: ['diff'],
			}).success,
		).toBe(false);
		expect(
			OrchestrationSpecV1Schema.parse({
				v: 1,
				defaultAgent: 'architect',
				activation: 'manual',
				execution: 'disabled',
				multiSwarm: false,
			}).defaultAgent,
		).toBe('architect');
		expect(
			HarnessConstraintsV1Schema.parse({
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
			}).maxFiles,
		).toBe(64);

		expect(() =>
			ToolSpecV1Schema.parse({ v: 1, toolId: 'diff', extra: true }),
		).toThrow();
		expect(
			HarnessConstraintsV1Schema.safeParse({
				v: 1,
				sourceAllowlist: ['../src'],
				extraProtectedPaths: [],
				maxPatchBytes: 1,
				maxFiles: 1,
				maxFileBytes: 1,
				maxTotalBytes: 1,
				maxChangedLines: 1,
				maxVersions: 1,
				maxReplayRecords: 1,
				maxOutputBytes: 1024,
			}).success,
		).toBe(false);
	});

	test('migrates v0 harness blueprints into strict v1 with content hashes', () => {
		const migrated = parseHarnessBlueprint({
			v: 0,
			id: 'bp-1',
			definitionHash: 'a'.repeat(64),
			prompts: [legacyPrompt('You are the architect.')],
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

		expect(migrated.v).toBe(1);
		expect(migrated.blueprintId).toBe('bp-1');
		expect(migrated.definitionsHash).toBe('a'.repeat(64));
		expect(migrated.agents[0]?.prompt.ref).toBe('static:architect');
		expect(migrated.agents[0]?.disabledTools).toEqual([]);
		expect(HarnessBlueprintV1Schema.parse(migrated).contentHash).toBe(
			computeHarnessBlueprintHash(migrated),
		);
	});

	test('migrates v0 candidate manifests and derives resource floors from file stats', () => {
		const migrated = parseHarnessCandidateManifest({
			v: 0,
			id: 'candidate-1',
			baseSha: 'b'.repeat(40),
			origin: 'issue-1825',
			patchSha256: 'c'.repeat(64),
			approvedPaths: ['src/agents/demo.ts'],
			files: [
				{
					relativePath: 'src/agents/demo.ts',
					trackedMode: '100644',
					beforeSha256: 'd'.repeat(64),
					afterSha256: 'e'.repeat(64),
					bytesBefore: 120,
					bytesAfter: 180,
					addedLines: 4,
					removedLines: 2,
					changedLines: 6,
				},
			],
		});

		expect(HarnessCandidateManifestV1Schema.parse(migrated).candidateId).toBe(
			'candidate-1',
		);
		expect(migrated.promptArtifactHashes).toEqual([]);
		expect(migrated.riskTier).toBe('low');
		expect(deriveHarnessCandidateFloors(migrated)).toEqual({
			maxFilesFloor: 1,
			maxFileBytesFloor: 180,
			maxTotalBytesFloor: 180,
			maxChangedLinesFloor: 6,
		});
	});

	test('rejects duplicate file relative paths in candidate manifests', () => {
		const manifestBase = {
			v: 1 as const,
			candidateId: 'candidate-duplicate-paths',
			baseSha: 'b'.repeat(40),
			origin: 'issue-1825',
			patchSha256: 'c'.repeat(64),
			approvedPaths: ['src/agents/demo.ts', 'src/agents/demo.ts'],
			promptArtifactHashes: [],
			files: [
				{
					relativePath: 'src/agents/demo.ts',
					trackedMode: '100644',
					beforeSha256: 'd'.repeat(64),
					afterSha256: 'e'.repeat(64),
					bytesBefore: 120,
					bytesAfter: 180,
					addedLines: 4,
					removedLines: 2,
					changedLines: 6,
				},
				{
					relativePath: 'src/agents/demo.ts',
					trackedMode: '100644',
					beforeSha256: 'f'.repeat(64),
					afterSha256: '0'.repeat(64),
					bytesBefore: 90,
					bytesAfter: 95,
					addedLines: 1,
					removedLines: 0,
					changedLines: 1,
				},
			],
		};
		const manifest = {
			...manifestBase,
			manifestHash: computeHarnessCandidateManifestHash(manifestBase),
			riskTier: deriveHarnessCandidateRiskTier(manifestBase),
		};
		expect(() => parseHarnessCandidateManifest(manifest)).toThrow(
			'relative paths must be unique',
		);
	});

	test('rejects duplicate prompt ids while migrating v0 harness blueprints', () => {
		expect(() =>
			parseHarnessBlueprint({
				v: 0,
				id: 'bp-duplicate-prompts',
				definitionHash: 'a'.repeat(64),
				prompts: [
					legacyPrompt('You are the architect.'),
					legacyPrompt('You are the reviewer.'),
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
			}),
		).toThrow('ambiguous duplicate promptId');
	});

	test('enforces patch target kinds and payload ids during parse and migration', () => {
		const migrated = parseBlueprintPatch({
			v: 0,
			id: 'patch-1',
			baseHash: 'a'.repeat(64),
			resultHash: 'b'.repeat(64),
			operations: [
				{
					op: 'upsert_tool',
					fieldPath: 'tools/diff',
					expectedFieldHash: null,
					tool: { v: 1, toolId: 'diff' },
				},
			],
		});
		expect(migrated.patchId).toBe('patch-1');

		expect(() =>
			parseBlueprintPatch({
				v: 1,
				patchId: 'patch-bad-kind',
				expectedBaseHash: 'a'.repeat(64),
				expectedResultHash: 'b'.repeat(64),
				operations: [
					{
						op: 'remove_tool',
						fieldPath: 'prompts/architect.prompt',
						expectedFieldHash: 'c'.repeat(64),
					},
				],
			}),
		).toThrow('remove_tool fieldPath must target tools/<toolId>');

		expect(() =>
			parseBlueprintPatch({
				v: 1,
				patchId: 'patch-bad-id',
				expectedBaseHash: 'a'.repeat(64),
				expectedResultHash: 'b'.repeat(64),
				operations: [
					{
						op: 'upsert_agent',
						fieldPath: 'agents/reviewer',
						expectedFieldHash: null,
						agent: {
							v: 1,
							agentName: 'architect',
							mode: 'primary',
							temperature: 0.1,
							prompt: {
								v: 1,
								promptId: 'architect.prompt',
								ref: 'static:architect',
								sha256: 'd'.repeat(64),
							},
							tools: ['diff'],
						},
					},
				],
			}),
		).toThrow('upsert_agent agentName must match the target fieldPath');

		expect(() =>
			parseBlueprintPatch({
				v: 1,
				patchId: 'patch-remove-prompt',
				expectedBaseHash: 'a'.repeat(64),
				expectedResultHash: 'b'.repeat(64),
				operations: [
					{
						op: 'remove_prompt',
						fieldPath: 'prompts/architect.prompt',
						expectedFieldHash: 'c'.repeat(64),
					},
				],
			}),
		).toThrow();
	});
});
