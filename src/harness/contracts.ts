import { z } from 'zod';
import { canonicalHash, contentHashWithout } from './hash.js';

const IdentifierSchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const RelativePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes('\0'), 'path contains a NUL byte')
	.refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value), {
		message: 'path must be project-relative',
	})
	.refine(
		(value) =>
			!value
				.replace(/\\/g, '/')
				.split('/')
				.some((segment) => segment === '..'),
		'path must not traverse outside its root',
	);
const ExpectedFieldHashSchema = z.union([Sha256Schema, z.null()]);
const AgentModeSchema = z.enum(['primary', 'subagent']);
const RiskTierSchema = z.enum(['low', 'medium', 'high']);
const ReasoningEffortSchema = z.enum([
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]);
const PromptRefSchema = z
	.string()
	.regex(
		/^(?:static:[A-Za-z0-9][A-Za-z0-9._-]*|candidate:[A-Za-z0-9][A-Za-z0-9._-]*:[a-f0-9]{64})$/,
	);

export const HarnessIdentifierSchema = IdentifierSchema;
export const HarnessSha256Schema = Sha256Schema;
export const HarnessRelativePathSchema = RelativePathSchema;
export const HarnessRiskTierSchema = RiskTierSchema;

const PromptArtifactProvenanceV1Schema = z
	.object({
		source: z.literal('candidate'),
		origin: z.string().min(1).max(2048),
	})
	.strict();
export type PromptArtifactProvenanceV1 = z.infer<
	typeof PromptArtifactProvenanceV1Schema
>;

export const PromptArtifactV1Schema = z
	.object({
		v: z.literal(1),
		promptId: IdentifierSchema,
		candidateId: IdentifierSchema,
		sha256: Sha256Schema,
		bytes: z.number().int().min(1).max(200_000),
		mediaType: z.literal('text/plain; charset=utf-8'),
		content: z.string().min(1).max(200_000),
		provenance: PromptArtifactProvenanceV1Schema,
	})
	.strict()
	.superRefine((value, ctx) => {
		const expectedHash = computePromptArtifactHash(value);
		if (value.sha256 !== expectedHash) {
			ctx.addIssue({
				code: 'custom',
				path: ['sha256'],
				message: 'prompt artifact sha256 does not match canonical content',
			});
		}
		const expectedBytes = Buffer.byteLength(value.content, 'utf8');
		if (value.bytes !== expectedBytes) {
			ctx.addIssue({
				code: 'custom',
				path: ['bytes'],
				message: 'prompt artifact bytes do not match UTF-8 content length',
			});
		}
	});
export type PromptArtifactV1 = z.infer<typeof PromptArtifactV1Schema>;

export const PromptBindingV1Schema = z
	.object({
		v: z.literal(1),
		promptId: IdentifierSchema,
		ref: PromptRefSchema,
		sha256: Sha256Schema,
	})
	.strict()
	.superRefine((value, ctx) => {
		if (!value.ref.startsWith('candidate:')) return;
		const parts = value.ref.split(':');
		if (parts[2] === value.sha256) return;
		ctx.addIssue({
			code: 'custom',
			path: ['sha256'],
			message:
				'candidate prompt binding sha256 must match the referenced prompt artifact',
		});
	});
export type PromptBindingV1 = z.infer<typeof PromptBindingV1Schema>;

export const ToolSpecV1Schema = z
	.object({
		v: z.literal(1),
		toolId: IdentifierSchema,
		description: z.string().min(1).max(400).optional(),
	})
	.strict();
export type ToolSpecV1 = z.infer<typeof ToolSpecV1Schema>;

const ReasoningConfigSchema = z
	.object({
		effort: ReasoningEffortSchema,
	})
	.strict();

const ThinkingConfigSchema = z
	.object({
		type: z.enum(['enabled', 'disabled']),
		budget_tokens: z.number().int().min(1).max(1_000_000).optional(),
	})
	.strict();

export const AgentBlueprintV1Schema = z
	.object({
		v: z.literal(1),
		agentName: IdentifierSchema,
		description: z.string().min(1).max(400).optional(),
		mode: AgentModeSchema,
		model: z.string().min(1).max(300).optional(),
		variant: z.string().min(1).max(64).optional(),
		reasoning: ReasoningConfigSchema.optional(),
		thinking: ThinkingConfigSchema.optional(),
		temperature: z.number().finite().min(0).max(2),
		prompt: PromptBindingV1Schema,
		tools: z.array(IdentifierSchema).max(256),
		disabledTools: z.array(IdentifierSchema).max(256).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.tools).size !== value.tools.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['tools'],
				message: 'agent blueprint tools must be unique',
			});
		}
		if (
			value.disabledTools &&
			new Set(value.disabledTools).size !== value.disabledTools.length
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['disabledTools'],
				message: 'agent blueprint disabledTools must be unique',
			});
		}
		if (value.disabledTools?.some((toolId) => value.tools.includes(toolId))) {
			ctx.addIssue({
				code: 'custom',
				path: ['disabledTools'],
				message: 'agent blueprint disabledTools must not overlap enabled tools',
			});
		}
	});
export type AgentBlueprintV1 = z.infer<typeof AgentBlueprintV1Schema>;

export const OrchestrationSpecV1Schema = z
	.object({
		v: z.literal(1),
		defaultAgent: IdentifierSchema,
		activation: z.enum(['manual']),
		execution: z.enum(['disabled']),
		multiSwarm: z.boolean(),
	})
	.strict();
export type OrchestrationSpecV1 = z.infer<typeof OrchestrationSpecV1Schema>;

export const HarnessConstraintsV1Schema = z
	.object({
		v: z.literal(1),
		sourceAllowlist: z.array(RelativePathSchema).max(128),
		extraProtectedPaths: z.array(RelativePathSchema).max(128),
		maxPatchBytes: z.number().int().min(1).max(16_777_216),
		maxFiles: z.number().int().min(1).max(1024),
		maxFileBytes: z.number().int().min(1).max(8_388_608),
		maxTotalBytes: z.number().int().min(1).max(67_108_864),
		maxChangedLines: z.number().int().min(1).max(100_000),
		maxVersions: z.number().int().min(1).max(10_000),
		maxReplayRecords: z.number().int().min(1).max(100_000),
		maxOutputBytes: z.number().int().min(1024).max(1_048_576),
	})
	.strict();
export type HarnessConstraintsV1 = z.infer<typeof HarnessConstraintsV1Schema>;

export const DEFAULT_HARNESS_CONSTRAINTS_V1: HarnessConstraintsV1 =
	Object.freeze(
		HarnessConstraintsV1Schema.parse({
			v: 1,
			sourceAllowlist: [],
			extraProtectedPaths: [],
			maxPatchBytes: 1_048_576,
			maxFiles: 64,
			maxFileBytes: 524_288,
			maxTotalBytes: 4_194_304,
			maxChangedLines: 10_000,
			maxVersions: 100,
			maxReplayRecords: 10_000,
			maxOutputBytes: 262_144,
		}),
	);

export const HarnessBlueprintV1Schema = z
	.object({
		v: z.literal(1),
		blueprintId: IdentifierSchema,
		definitionsHash: Sha256Schema,
		tools: z.array(ToolSpecV1Schema).max(512),
		agents: z.array(AgentBlueprintV1Schema).min(1).max(256),
		orchestration: OrchestrationSpecV1Schema,
		constraints: HarnessConstraintsV1Schema,
		contentHash: Sha256Schema,
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			new Set(value.tools.map((tool) => tool.toolId)).size !==
			value.tools.length
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['tools'],
				message: 'tool ids must be unique',
			});
		}
		if (
			new Set(value.agents.map((agent) => agent.agentName)).size !==
			value.agents.length
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['agents'],
				message: 'agent names must be unique',
			});
		}
		if (
			new Set(value.agents.map((agent) => agent.prompt.promptId)).size !==
			value.agents.length
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['agents'],
				message: 'agent prompt ids must be unique',
			});
		}
		const toolIds = new Set(value.tools.map((tool) => tool.toolId));
		for (const [index, agent] of value.agents.entries()) {
			for (const toolId of agent.tools) {
				if (toolIds.has(toolId)) continue;
				ctx.addIssue({
					code: 'custom',
					path: ['agents', index, 'tools'],
					message: 'agent tool ids must resolve to declared tools',
				});
				break;
			}
		}
		if (
			!value.agents.some(
				(agent) => agent.agentName === value.orchestration.defaultAgent,
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['orchestration', 'defaultAgent'],
				message: 'defaultAgent must refer to a declared agent',
			});
		}
		const expected = computeHarnessBlueprintHash(value);
		if (value.contentHash !== expected) {
			ctx.addIssue({
				code: 'custom',
				path: ['contentHash'],
				message:
					'harness blueprint contentHash does not match canonical content',
			});
		}
	});
export type HarnessBlueprintV1 = z.infer<typeof HarnessBlueprintV1Schema>;

export const HarnessCandidateFileV1Schema = z
	.object({
		relativePath: RelativePathSchema,
		oldRelativePath: RelativePathSchema.optional(),
		operation: z
			.enum(['modify', 'add', 'delete', 'rename', 'copy', 'mode'])
			.optional(),
		trackedMode: z.string().regex(/^[0-7]{6}$/),
		afterMode: z
			.string()
			.regex(/^[0-7]{6}$/)
			.optional(),
		beforeSha256: Sha256Schema,
		afterSha256: Sha256Schema,
		bytesBefore: z.number().int().nonnegative(),
		bytesAfter: z.number().int().nonnegative(),
		addedLines: z.number().int().nonnegative(),
		removedLines: z.number().int().nonnegative(),
		changedLines: z.number().int().nonnegative(),
	})
	.strict();
export type HarnessCandidateFileV1 = z.infer<
	typeof HarnessCandidateFileV1Schema
>;

export const HarnessCandidateManifestV1Schema = z
	.object({
		v: z.literal(1),
		candidateId: IdentifierSchema,
		baseSha: GitShaSchema,
		origin: z.string().min(1).max(2048),
		patchSha256: Sha256Schema,
		promptArtifactHashes: z.array(Sha256Schema).max(256),
		manifestHash: Sha256Schema,
		riskTier: RiskTierSchema,
		approvedPaths: z.array(RelativePathSchema).min(1).max(256),
		files: z.array(HarnessCandidateFileV1Schema).min(1).max(1024),
	})
	.strict()
	.superRefine((value, ctx) => {
		const expected = computeHarnessCandidateManifestHash(value);
		if (value.manifestHash !== expected) {
			ctx.addIssue({
				code: 'custom',
				path: ['manifestHash'],
				message: 'candidate manifest hash does not match canonical content',
			});
		}
		if (value.riskTier !== deriveHarnessCandidateRiskTier(value)) {
			ctx.addIssue({
				code: 'custom',
				path: ['riskTier'],
				message: 'candidate riskTier must match the derived manifest risk',
			});
		}
		if (
			new Set(value.promptArtifactHashes).size !==
			value.promptArtifactHashes.length
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['promptArtifactHashes'],
				message: 'candidate prompt artifact hashes must be unique',
			});
		}
	});
export type HarnessCandidateManifestV1 = z.infer<
	typeof HarnessCandidateManifestV1Schema
>;

const FieldPathSchema = z.union([
	z.literal('orchestration'),
	z.literal('constraints'),
	z.string().regex(/^(?:prompts|tools|agents)\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
]);

function extractFieldPathId(
	fieldPath: string,
	collection: 'prompts' | 'tools' | 'agents',
): string | null {
	const prefix = `${collection}/`;
	return fieldPath.startsWith(prefix) ? fieldPath.slice(prefix.length) : null;
}

export const BlueprintPatchOperationV1Schema = z
	.discriminatedUnion('op', [
		z
			.object({
				op: z.literal('upsert_prompt'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: ExpectedFieldHashSchema,
				prompt: PromptArtifactV1Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('remove_prompt'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: Sha256Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('upsert_tool'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: ExpectedFieldHashSchema,
				tool: ToolSpecV1Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('remove_tool'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: Sha256Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('upsert_agent'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: ExpectedFieldHashSchema,
				agent: AgentBlueprintV1Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('remove_agent'),
				fieldPath: FieldPathSchema,
				expectedFieldHash: Sha256Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('replace_orchestration'),
				fieldPath: z.literal('orchestration'),
				expectedFieldHash: Sha256Schema,
				orchestration: OrchestrationSpecV1Schema,
			})
			.strict(),
		z
			.object({
				op: z.literal('replace_constraints'),
				fieldPath: z.literal('constraints'),
				expectedFieldHash: Sha256Schema,
				constraints: HarnessConstraintsV1Schema,
			})
			.strict(),
	])
	.superRefine((value, ctx) => {
		switch (value.op) {
			case 'upsert_prompt': {
				const fieldId = extractFieldPathId(value.fieldPath, 'prompts');
				if (fieldId !== value.prompt.promptId) {
					ctx.addIssue({
						code: 'custom',
						path: fieldId === null ? ['fieldPath'] : ['prompt', 'promptId'],
						message:
							fieldId === null
								? 'upsert_prompt fieldPath must target prompts/<promptId>'
								: 'upsert_prompt promptId must match the target fieldPath',
					});
				}
				return;
			}
			case 'remove_prompt':
				if (extractFieldPathId(value.fieldPath, 'prompts') === null) {
					ctx.addIssue({
						code: 'custom',
						path: ['fieldPath'],
						message: 'remove_prompt fieldPath must target prompts/<promptId>',
					});
				}
				return;
			case 'upsert_tool': {
				const fieldId = extractFieldPathId(value.fieldPath, 'tools');
				if (fieldId !== value.tool.toolId) {
					ctx.addIssue({
						code: 'custom',
						path: fieldId === null ? ['fieldPath'] : ['tool', 'toolId'],
						message:
							fieldId === null
								? 'upsert_tool fieldPath must target tools/<toolId>'
								: 'upsert_tool toolId must match the target fieldPath',
					});
				}
				return;
			}
			case 'remove_tool':
				if (extractFieldPathId(value.fieldPath, 'tools') === null) {
					ctx.addIssue({
						code: 'custom',
						path: ['fieldPath'],
						message: 'remove_tool fieldPath must target tools/<toolId>',
					});
				}
				return;
			case 'upsert_agent': {
				const fieldId = extractFieldPathId(value.fieldPath, 'agents');
				if (fieldId !== value.agent.agentName) {
					ctx.addIssue({
						code: 'custom',
						path: fieldId === null ? ['fieldPath'] : ['agent', 'agentName'],
						message:
							fieldId === null
								? 'upsert_agent fieldPath must target agents/<agentName>'
								: 'upsert_agent agentName must match the target fieldPath',
					});
				}
				return;
			}
			case 'remove_agent':
				if (extractFieldPathId(value.fieldPath, 'agents') === null) {
					ctx.addIssue({
						code: 'custom',
						path: ['fieldPath'],
						message: 'remove_agent fieldPath must target agents/<agentName>',
					});
				}
				return;
			case 'replace_orchestration':
			case 'replace_constraints':
				return;
		}
	});
export type BlueprintPatchOperationV1 = z.infer<
	typeof BlueprintPatchOperationV1Schema
>;

export const BlueprintPatchV1Schema = z
	.object({
		v: z.literal(1),
		patchId: IdentifierSchema,
		expectedBaseHash: Sha256Schema,
		expectedResultHash: Sha256Schema,
		operations: z.array(BlueprintPatchOperationV1Schema).max(256),
	})
	.strict();
export type BlueprintPatchV1 = z.infer<typeof BlueprintPatchV1Schema>;

const PromptArtifactV0Schema = z
	.object({
		v: z.literal(1),
		promptId: IdentifierSchema,
		role: z.enum(['system', 'user']),
		content: z.string().min(1).max(200_000),
		contentHash: Sha256Schema,
	})
	.strict();

const AgentBlueprintV0Schema = z
	.object({
		v: z.literal(1),
		agentName: IdentifierSchema,
		description: z.string().min(1).max(400).optional(),
		mode: AgentModeSchema,
		model: z.string().min(1).max(300).optional(),
		variant: z.string().min(1).max(64).optional(),
		reasoning: ReasoningConfigSchema.optional(),
		thinking: ThinkingConfigSchema.optional(),
		temperature: z.number().finite().min(0).max(2),
		promptId: IdentifierSchema,
		tools: z.array(IdentifierSchema).max(256),
	})
	.strict();

const HarnessBlueprintV0Schema = z
	.object({
		v: z.literal(0),
		id: IdentifierSchema,
		definitionHash: Sha256Schema,
		prompts: z.array(PromptArtifactV0Schema).max(256),
		tools: z.array(ToolSpecV1Schema).max(512),
		agents: z.array(AgentBlueprintV0Schema).min(1).max(256),
		orchestration: OrchestrationSpecV1Schema,
		constraints: HarnessConstraintsV1Schema,
	})
	.strict();

const HarnessCandidateManifestV0Schema = z
	.object({
		v: z.literal(0),
		id: IdentifierSchema,
		baseSha: GitShaSchema,
		origin: z.string().min(1).max(2048),
		patchSha256: Sha256Schema,
		approvedPaths: z.array(RelativePathSchema).min(1).max(256),
		files: z.array(HarnessCandidateFileV1Schema).min(1).max(1024),
	})
	.strict();

const BlueprintPatchV0Schema = z
	.object({
		v: z.literal(0),
		id: IdentifierSchema,
		baseHash: Sha256Schema,
		resultHash: Sha256Schema,
		operations: z.array(BlueprintPatchOperationV1Schema).max(256),
	})
	.strict();

export function computePromptArtifactHash(
	value: Omit<PromptArtifactV1, 'sha256'> | PromptArtifactV1,
): string {
	return contentHashWithout(
		value as PromptArtifactV1 & Record<string, unknown>,
		['sha256'],
	);
}

export function computePromptBindingHash(value: PromptBindingV1): string {
	return canonicalHash(value);
}

export function computeHarnessBlueprintHash(
	value: Omit<HarnessBlueprintV1, 'contentHash'> | HarnessBlueprintV1,
): string {
	return contentHashWithout(
		value as HarnessBlueprintV1 & Record<string, unknown>,
		['contentHash'],
	);
}

export function computeHarnessCandidateManifestHash(
	value:
		| Omit<HarnessCandidateManifestV1, 'manifestHash' | 'riskTier'>
		| HarnessCandidateManifestV1,
): string {
	return contentHashWithout(
		value as HarnessCandidateManifestV1 & Record<string, unknown>,
		['manifestHash', 'riskTier'],
	);
}

export function computeBlueprintPatchHash(value: BlueprintPatchV1): string {
	return contentHashWithout(
		value as BlueprintPatchV1 & Record<string, unknown>,
		[],
	);
}

export function deriveHarnessCandidateFloors(
	value: Pick<HarnessCandidateManifestV1, 'files'>,
): {
	maxFilesFloor: number;
	maxFileBytesFloor: number;
	maxTotalBytesFloor: number;
	maxChangedLinesFloor: number;
} {
	const files = [...value.files];
	return {
		maxFilesFloor: files.length,
		maxFileBytesFloor: Math.max(
			...files.map((file) => Math.max(file.bytesBefore, file.bytesAfter)),
		),
		maxTotalBytesFloor: files.reduce(
			(total, file) => total + Math.max(file.bytesBefore, file.bytesAfter),
			0,
		),
		maxChangedLinesFloor: files.reduce(
			(total, file) => total + file.changedLines,
			0,
		),
	};
}

export function deriveHarnessCandidateRiskTier(
	value: Pick<HarnessCandidateManifestV1, 'files'>,
): z.infer<typeof RiskTierSchema> {
	const floors = deriveHarnessCandidateFloors(value);
	if (
		floors.maxFilesFloor > 10 ||
		floors.maxChangedLinesFloor > 2_000 ||
		floors.maxFileBytesFloor > 262_144 ||
		floors.maxTotalBytesFloor > 1_048_576
	) {
		return 'high';
	}
	if (
		floors.maxFilesFloor > 2 ||
		floors.maxChangedLinesFloor > 200 ||
		floors.maxFileBytesFloor > 65_536 ||
		floors.maxTotalBytesFloor > 262_144
	) {
		return 'medium';
	}
	return 'low';
}

export function parsePromptArtifact(value: unknown): PromptArtifactV1 {
	return PromptArtifactV1Schema.parse(value);
}

export function parseHarnessBlueprint(value: unknown): HarnessBlueprintV1 {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const version = (value as { v?: unknown }).v;
		if (version === 1) return HarnessBlueprintV1Schema.parse(value);
	}
	const v1 = HarnessBlueprintV1Schema.safeParse(value);
	if (v1.success) return v1.data;
	const v0 = HarnessBlueprintV0Schema.parse(value);
	const promptById = new Map(
		v0.prompts.map((prompt) => [prompt.promptId, prompt] as const),
	);
	const migrated = {
		v: 1 as const,
		blueprintId: v0.id,
		definitionsHash: v0.definitionHash,
		tools: v0.tools,
		agents: v0.agents.map((agent) => {
			const prompt = promptById.get(agent.promptId);
			if (!prompt) {
				throw new Error(
					`legacy harness blueprint prompt ${agent.promptId} is missing`,
				);
			}
			return {
				v: 1 as const,
				agentName: agent.agentName,
				description: agent.description,
				mode: agent.mode,
				model: agent.model,
				variant: agent.variant,
				reasoning: agent.reasoning,
				thinking: agent.thinking,
				temperature: agent.temperature,
				prompt: {
					v: 1 as const,
					promptId: agent.promptId,
					ref: `static:${agent.agentName}`,
					sha256: prompt.contentHash,
				},
				tools: agent.tools,
				disabledTools: [],
			};
		}),
		orchestration: v0.orchestration,
		constraints: v0.constraints,
		contentHash: '',
	};
	migrated.contentHash = computeHarnessBlueprintHash(migrated);
	return HarnessBlueprintV1Schema.parse(migrated);
}

export function parseHarnessCandidateManifest(
	value: unknown,
): HarnessCandidateManifestV1 {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const version = (value as { v?: unknown }).v;
		if (version === 1) return HarnessCandidateManifestV1Schema.parse(value);
	}
	const v1 = HarnessCandidateManifestV1Schema.safeParse(value);
	if (v1.success) return v1.data;
	const v0 = HarnessCandidateManifestV0Schema.parse(value);
	const migrated = {
		v: 1 as const,
		candidateId: v0.id,
		baseSha: v0.baseSha,
		origin: v0.origin,
		patchSha256: v0.patchSha256,
		promptArtifactHashes: [],
		approvedPaths: v0.approvedPaths,
		files: v0.files,
		riskTier: deriveHarnessCandidateRiskTier(v0),
		manifestHash: '',
	};
	migrated.manifestHash = computeHarnessCandidateManifestHash(migrated);
	return HarnessCandidateManifestV1Schema.parse(migrated);
}

export function parseBlueprintPatch(value: unknown): BlueprintPatchV1 {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const version = (value as { v?: unknown }).v;
		if (version === 1) return BlueprintPatchV1Schema.parse(value);
	}
	const v1 = BlueprintPatchV1Schema.safeParse(value);
	if (v1.success) return v1.data;
	const v0 = BlueprintPatchV0Schema.parse(value);
	return BlueprintPatchV1Schema.parse({
		v: 1,
		patchId: v0.id,
		expectedBaseHash: v0.baseHash,
		expectedResultHash: v0.resultHash,
		operations: v0.operations,
	});
}
