import { z } from 'zod';
import {
	computeHarnessBlueprintHash,
	computePromptArtifactHash,
	DEFAULT_HARNESS_CONSTRAINTS_V1,
	type HarnessBlueprintV1,
	type HarnessConstraintsV1,
	type PromptArtifactV1,
	type PromptBindingV1,
	parseHarnessBlueprint,
	type ToolSpecV1,
} from './contracts.js';
import { canonicalHash, sha256 } from './hash.js';
import { loadHarnessPromptArtifact } from './store.js';

const RuntimeToolsSchema = z.record(z.string(), z.boolean()).optional();

const RuntimeAgentConfigSchema = z
	.object({
		mode: z.enum(['primary', 'subagent']),
		model: z.string().min(1).max(300).optional(),
		variant: z.string().min(1).max(64).optional(),
		reasoning: z
			.object({
				effort: z.enum([
					'none',
					'minimal',
					'low',
					'medium',
					'high',
					'xhigh',
					'max',
					'ultra',
				]),
			})
			.strict()
			.optional(),
		thinking: z
			.object({
				type: z.enum(['enabled', 'disabled']),
				budget_tokens: z.number().int().min(1).max(1_000_000).optional(),
			})
			.strict()
			.optional(),
		temperature: z.number().finite().min(0).max(2),
		prompt: z.string().min(1).max(200_000),
		tools: RuntimeToolsSchema,
	})
	.strict();

const RuntimeAgentDefinitionSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(160)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
		description: z.string().min(1).max(400).optional(),
		config: RuntimeAgentConfigSchema,
		harnessPromptProvenance: z
			.object({
				source: z.enum(['static', 'candidate']),
				promptId: z.string().min(1).max(160),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				candidateId: z.string().min(1).max(160).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type RuntimeAgentDefinition = z.infer<
	typeof RuntimeAgentDefinitionSchema
>;

function dedupeOrdered(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function promptBindingForRuntime(
	agent: RuntimeAgentDefinition,
): PromptBindingV1 {
	return {
		v: 1,
		promptId: `${agent.name}.prompt`,
		ref: `static:${agent.name}`,
		sha256: sha256(agent.config.prompt),
	};
}

function inferMultiSwarm(agentNames: readonly string[]): boolean {
	return agentNames.some((agentName) => agentName.includes('_'));
}

function toolIdsFromRuntime(agent: RuntimeAgentDefinition): string[] {
	return Object.entries(agent.config.tools ?? {})
		.filter(([, enabled]) => enabled === true)
		.map(([toolId]) => toolId)
		.sort();
}

function disabledToolIdsFromRuntime(agent: RuntimeAgentDefinition): string[] {
	return Object.entries(agent.config.tools ?? {})
		.filter(([, enabled]) => enabled === false)
		.map(([toolId]) => toolId)
		.sort();
}

function resolveStaticPrompt(
	agentName: string,
	binding: PromptBindingV1,
	definitionsByName: Map<string, RuntimeAgentDefinition>,
): string {
	const baseline = definitionsByName.get(agentName);
	if (!baseline) {
		throw new Error(
			`runtime definition ${agentName} is absent from the supplied factory inventory`,
		);
	}
	if (binding.ref !== `static:${agentName}`) {
		throw new Error(
			`static prompt binding ${binding.ref} does not match agent ${agentName}`,
		);
	}
	const actualHash = sha256(baseline.config.prompt);
	if (actualHash !== binding.sha256) {
		throw new Error(
			`static prompt binding hash mismatch for ${agentName}: expected ${binding.sha256}, received ${actualHash}`,
		);
	}
	return baseline.config.prompt;
}

function resolveCandidatePrompt(
	directory: string | undefined,
	binding: PromptBindingV1,
): PromptArtifactV1 {
	if (!directory) {
		throw new Error(
			`candidate prompt binding ${binding.ref} requires a project root`,
		);
	}
	const parts = binding.ref.split(':');
	const candidateId = parts[1]!;
	const artifactHash = parts[2]!;
	const artifact = _factoryInternals.loadHarnessPromptArtifact(
		directory,
		candidateId,
		artifactHash,
	);
	if (!artifact) {
		throw new Error(`candidate prompt artifact ${binding.ref} was not found`);
	}
	if (
		artifact.promptId !== binding.promptId ||
		artifact.candidateId !== candidateId ||
		artifact.sha256 !== binding.sha256
	) {
		throw new Error(
			`candidate prompt artifact ${binding.ref} does not match its binding`,
		);
	}
	const recomputedHash = computePromptArtifactHash(artifact);
	if (recomputedHash !== artifact.sha256) {
		throw new Error(
			`candidate prompt artifact ${binding.ref} content hash mismatch`,
		);
	}
	return artifact;
}

export function computeRuntimeDefinitionsHash(
	runtimeDefinitions: readonly RuntimeAgentDefinition[],
): string {
	return canonicalHash(runtimeDefinitions);
}

export function createToolFactory(registeredToolIds: readonly string[]) {
	const uniqueRegistered = dedupeOrdered(registeredToolIds);
	if (uniqueRegistered.length !== registeredToolIds.length) {
		throw new Error('registered tool ids must not contain duplicates');
	}
	const registered = new Set(uniqueRegistered);
	return {
		projectTools(toolIds: readonly string[]): ToolSpecV1[] {
			const unique = dedupeOrdered(toolIds);
			for (const toolId of unique) {
				if (registered.has(toolId)) continue;
				throw new Error(
					`tool ${toolId} is not present in the supplied registered tool ids`,
				);
			}
			return unique.map((toolId) => ({ v: 1 as const, toolId }));
		},
		materializeTools(tools: readonly ToolSpecV1[]): string[] {
			return tools.map((tool) => {
				if (registered.has(tool.toolId)) return tool.toolId;
				throw new Error(
					`tool ${tool.toolId} is not present in the supplied registered tool ids`,
				);
			});
		},
	};
}

export function createAgentFactory(options: {
	runtimeDefinitions: readonly RuntimeAgentDefinition[];
	registeredToolIds: readonly string[];
	defaultConstraints?: HarnessConstraintsV1;
}) {
	const runtimeDefinitions = options.runtimeDefinitions.map((definition) =>
		RuntimeAgentDefinitionSchema.parse(definition),
	);
	const definitionsHash = computeRuntimeDefinitionsHash(runtimeDefinitions);
	const definitionsByName = new Map(
		runtimeDefinitions.map(
			(definition) => [definition.name, definition] as const,
		),
	);
	const toolFactory = createToolFactory(options.registeredToolIds);

	return {
		definitionsHash,
		projectBlueprint(args: {
			blueprintId: string;
			agentNames?: readonly string[];
			defaultAgent?: string;
			constraints?: HarnessConstraintsV1;
		}): HarnessBlueprintV1 {
			const selected = (
				args.agentNames?.length
					? args.agentNames.map((name) => {
							const definition = definitionsByName.get(name);
							if (definition) return definition;
							throw new Error(`runtime definition ${name} was not supplied`);
						})
					: runtimeDefinitions
			).map((definition) => RuntimeAgentDefinitionSchema.parse(definition));
			const agents = selected.map((definition) => ({
				v: 1 as const,
				agentName: definition.name,
				description: definition.description,
				mode: definition.config.mode,
				model: definition.config.model,
				variant: definition.config.variant,
				reasoning: definition.config.reasoning,
				thinking: definition.config.thinking,
				temperature: definition.config.temperature,
				prompt: promptBindingForRuntime(definition),
				tools: toolFactory.materializeTools(
					toolFactory.projectTools(toolIdsFromRuntime(definition)),
				),
				disabledTools: disabledToolIdsFromRuntime(definition),
			}));
			const tools = toolFactory.projectTools(
				selected.flatMap((definition) => toolIdsFromRuntime(definition)),
			);
			const defaultAgent =
				args.defaultAgent ??
				agents.find((agent) => agent.mode === 'primary')?.agentName ??
				agents[0]?.agentName;
			if (!defaultAgent) {
				throw new Error(
					'cannot create a harness blueprint without agent definitions',
				);
			}
			const blueprint = {
				v: 1 as const,
				blueprintId: args.blueprintId,
				definitionsHash,
				tools,
				agents,
				orchestration: {
					v: 1 as const,
					defaultAgent,
					activation: 'manual' as const,
					execution: 'disabled' as const,
					multiSwarm: inferMultiSwarm(agents.map((agent) => agent.agentName)),
				},
				constraints:
					args.constraints ??
					options.defaultConstraints ??
					DEFAULT_HARNESS_CONSTRAINTS_V1,
				contentHash: '',
			};
			blueprint.contentHash = computeHarnessBlueprintHash(blueprint);
			return parseHarnessBlueprint(blueprint);
		},
		materializeBlueprint(
			blueprint: HarnessBlueprintV1,
			options: { directory?: string } = {},
		): RuntimeAgentDefinition[] {
			const parsed = parseHarnessBlueprint(blueprint);
			if (parsed.definitionsHash !== definitionsHash) {
				throw new Error(
					`blueprint definitions hash mismatch: expected ${definitionsHash}, received ${parsed.definitionsHash}`,
				);
			}
			return parsed.agents.map((agent) => {
				const baseline = definitionsByName.get(agent.agentName);
				if (!baseline) {
					throw new Error(
						`runtime definition ${agent.agentName} is absent from the supplied factory inventory`,
					);
				}
				const candidatePrompt = agent.prompt.ref.startsWith('candidate:')
					? resolveCandidatePrompt(options.directory, agent.prompt)
					: null;
				const promptText =
					candidatePrompt?.content ??
					resolveStaticPrompt(agent.agentName, agent.prompt, definitionsByName);
				const toolIds = toolFactory.materializeTools(
					agent.tools.map((toolId) => ({ v: 1 as const, toolId })),
				);
				const disabledToolIds = [...(agent.disabledTools ?? [])];
				const disabledTools = Object.fromEntries(
					disabledToolIds.map((toolId) => [toolId, false] as const),
				);
				return RuntimeAgentDefinitionSchema.parse({
					name: agent.agentName,
					description: agent.description ?? baseline.description,
					config: {
						mode: agent.mode,
						model: agent.model,
						variant: agent.variant,
						reasoning: agent.reasoning,
						thinking: agent.thinking,
						temperature: agent.temperature,
						prompt: promptText,
						tools: {
							...disabledTools,
							...Object.fromEntries(
								toolIds.map((toolId) => [toolId, true] as const),
							),
						},
					},
					harnessPromptProvenance: candidatePrompt
						? {
								source: 'candidate' as const,
								promptId: candidatePrompt.promptId,
								sha256: candidatePrompt.sha256,
								candidateId: candidatePrompt.candidateId,
							}
						: {
								source: 'static' as const,
								promptId: agent.prompt.promptId,
								sha256: agent.prompt.sha256,
							},
				});
			});
		},
	};
}

export const _factoryInternals: {
	loadHarnessPromptArtifact: typeof loadHarnessPromptArtifact;
} = {
	loadHarnessPromptArtifact: loadHarnessPromptArtifact,
};
