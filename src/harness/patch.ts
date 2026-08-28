import {
	type AgentBlueprintV1,
	type BlueprintPatchOperationV1,
	BlueprintPatchV1Schema,
	computeHarnessBlueprintHash,
	computePromptBindingHash,
	type HarnessBlueprintV1,
	type HarnessConstraintsV1,
	type OrchestrationSpecV1,
	type PromptBindingV1,
	parseHarnessBlueprint,
	type ToolSpecV1,
} from './contracts.js';
import { canonicalHash } from './hash.js';

function clone<T>(value: T): T {
	return structuredClone(value);
}

function replaceByKey<T>(
	items: readonly T[],
	matcher: (item: T) => boolean,
	value: T,
): T[] {
	const index = items.findIndex(matcher);
	if (index < 0) return [...items, value];
	const next = [...items];
	next[index] = value;
	return next;
}

function removeByKey<T>(
	items: readonly T[],
	matcher: (item: T) => boolean,
): T[] {
	const index = items.findIndex(matcher);
	if (index < 0) return [...items];
	return [...items.slice(0, index), ...items.slice(index + 1)];
}

function requireFieldPathId(
	fieldPath: string,
	collection: 'prompts' | 'tools' | 'agents',
): string {
	const prefix = `${collection}/`;
	if (fieldPath.startsWith(prefix)) return fieldPath.slice(prefix.length);
	throw new Error(
		`patch fieldPath ${fieldPath} does not target ${collection}/<id>`,
	);
}

function assertMatchingFieldPathId(
	fieldPath: string,
	collection: 'prompts' | 'tools' | 'agents',
	payloadId: string,
): string {
	const fieldId = requireFieldPathId(fieldPath, collection);
	if (fieldId === payloadId) return fieldId;
	throw new Error(
		`patch fieldPath ${fieldPath} does not match ${collection} payload id ${payloadId}`,
	);
}

function removeExistingByKey<T>(
	items: readonly T[],
	matcher: (item: T) => boolean,
	missingMessage: string,
): T[] {
	const next = removeByKey(items, matcher);
	if (next.length !== items.length) return next;
	throw new Error(missingMessage);
}

function findPromptBinding(
	blueprint: HarnessBlueprintV1,
	promptId: string,
): PromptBindingV1 | null {
	return (
		blueprint.agents.find((agent) => agent.prompt.promptId === promptId)
			?.prompt ?? null
	);
}

function resolveFieldValue(
	blueprint: HarnessBlueprintV1,
	fieldPath: string,
): unknown {
	if (fieldPath === 'orchestration') return blueprint.orchestration;
	if (fieldPath === 'constraints') return blueprint.constraints;
	if (fieldPath.startsWith('prompts/')) {
		return findPromptBinding(blueprint, fieldPath.slice('prompts/'.length));
	}
	if (fieldPath.startsWith('tools/')) {
		const toolId = fieldPath.slice('tools/'.length);
		return blueprint.tools.find((tool) => tool.toolId === toolId) ?? null;
	}
	if (fieldPath.startsWith('agents/')) {
		const agentName = fieldPath.slice('agents/'.length);
		return (
			blueprint.agents.find((agent) => agent.agentName === agentName) ?? null
		);
	}
	return null;
}

function resolveFieldHash(
	blueprint: HarnessBlueprintV1,
	fieldPath: string,
): string | null {
	const value = resolveFieldValue(blueprint, fieldPath);
	if (value === null || value === undefined) return null;
	if (fieldPath.startsWith('prompts/')) {
		return computePromptBindingHash(value as PromptBindingV1);
	}
	return canonicalHash(value);
}

function assertExpectedFieldHash(
	blueprint: HarnessBlueprintV1,
	fieldPath: string,
	expectedFieldHash: string | null,
): void {
	const actual = resolveFieldHash(blueprint, fieldPath);
	if (actual === expectedFieldHash) return;
	throw new Error(
		`patch expected field hash mismatch for ${fieldPath}: expected ${expectedFieldHash ?? 'null'}, received ${actual ?? 'null'}`,
	);
}

function replacePromptBinding(
	blueprint: HarnessBlueprintV1,
	promptId: string,
	prompt: BlueprintPatchOperationV1 & { op: 'upsert_prompt' },
): HarnessBlueprintV1 {
	const existing = findPromptBinding(blueprint, promptId);
	if (!existing) {
		throw new Error(`patch prompt target missing for prompts/${promptId}`);
	}
	const nextBinding: PromptBindingV1 = {
		v: 1,
		promptId: prompt.prompt.promptId,
		ref: `candidate:${prompt.prompt.candidateId}:${prompt.prompt.sha256}`,
		sha256: prompt.prompt.sha256,
	};
	return {
		...blueprint,
		agents: blueprint.agents.map((agent) =>
			agent.prompt.promptId === promptId
				? {
						...agent,
						prompt: nextBinding,
					}
				: agent,
		),
	};
}

function applyOperation(
	blueprint: HarnessBlueprintV1,
	operation: BlueprintPatchOperationV1,
): HarnessBlueprintV1 {
	assertExpectedFieldHash(
		blueprint,
		operation.fieldPath,
		operation.expectedFieldHash,
	);
	switch (operation.op) {
		case 'upsert_prompt':
			assertMatchingFieldPathId(
				operation.fieldPath,
				'prompts',
				operation.prompt.promptId,
			);
			return replacePromptBinding(
				blueprint,
				operation.prompt.promptId,
				operation,
			);
		case 'remove_prompt': {
			const promptId = requireFieldPathId(operation.fieldPath, 'prompts');
			if (findPromptBinding(blueprint, promptId)) {
				throw new Error(`cannot remove referenced prompt binding ${promptId}`);
			}
			throw new Error(`patch remove target missing for ${operation.fieldPath}`);
		}
		case 'upsert_tool':
			assertMatchingFieldPathId(
				operation.fieldPath,
				'tools',
				operation.tool.toolId,
			);
			return {
				...blueprint,
				tools: replaceByKey(
					blueprint.tools,
					(tool) =>
						tool.toolId === requireFieldPathId(operation.fieldPath, 'tools'),
					clone(operation.tool) satisfies ToolSpecV1,
				),
			};
		case 'remove_tool':
			requireFieldPathId(operation.fieldPath, 'tools');
			return {
				...blueprint,
				tools: removeExistingByKey(
					blueprint.tools,
					(tool) =>
						tool.toolId === requireFieldPathId(operation.fieldPath, 'tools'),
					`patch remove target missing for ${operation.fieldPath}`,
				),
			};
		case 'upsert_agent':
			assertMatchingFieldPathId(
				operation.fieldPath,
				'agents',
				operation.agent.agentName,
			);
			return {
				...blueprint,
				agents: replaceByKey(
					blueprint.agents,
					(agent) =>
						agent.agentName ===
						requireFieldPathId(operation.fieldPath, 'agents'),
					clone(operation.agent) satisfies AgentBlueprintV1,
				),
			};
		case 'remove_agent':
			requireFieldPathId(operation.fieldPath, 'agents');
			return {
				...blueprint,
				agents: removeExistingByKey(
					blueprint.agents,
					(agent) =>
						agent.agentName ===
						requireFieldPathId(operation.fieldPath, 'agents'),
					`patch remove target missing for ${operation.fieldPath}`,
				),
			};
		case 'replace_orchestration':
			return {
				...blueprint,
				orchestration: clone(
					operation.orchestration,
				) satisfies OrchestrationSpecV1,
			};
		case 'replace_constraints':
			return {
				...blueprint,
				constraints: clone(
					operation.constraints,
				) satisfies HarnessConstraintsV1,
			};
	}
}

export function deriveBlueprintPatchRiskTier(
	operations: readonly BlueprintPatchOperationV1[],
): 'low' | 'medium' | 'high' {
	if (
		operations.some(
			(operation) =>
				operation.op === 'replace_constraints' ||
				operation.op === 'replace_orchestration' ||
				operation.op === 'remove_agent',
		)
	) {
		return 'high';
	}
	if (
		operations.some(
			(operation) =>
				operation.op === 'upsert_agent' ||
				operation.op === 'remove_tool' ||
				operation.op === 'upsert_tool' ||
				operation.op === 'remove_prompt',
		)
	) {
		return 'medium';
	}
	return 'low';
}

export function applyBlueprintPatch(
	base: HarnessBlueprintV1,
	patch: unknown,
): HarnessBlueprintV1 {
	const parsedBase = parseHarnessBlueprint(base);
	const parsedPatch = BlueprintPatchV1Schema.parse(patch);
	if (parsedBase.contentHash !== parsedPatch.expectedBaseHash) {
		throw new Error(
			`patch expected base hash mismatch: expected ${parsedPatch.expectedBaseHash}, received ${parsedBase.contentHash}`,
		);
	}
	let next = clone(parsedBase);
	for (const operation of parsedPatch.operations) {
		next = applyOperation(next, operation);
	}
	const withHash = { ...next, contentHash: '' };
	withHash.contentHash = computeHarnessBlueprintHash(withHash);
	if (withHash.contentHash !== parsedPatch.expectedResultHash) {
		throw new Error(
			`patch expected result hash mismatch: expected ${parsedPatch.expectedResultHash}, received ${withHash.contentHash}`,
		);
	}
	return parseHarnessBlueprint(withHash);
}
