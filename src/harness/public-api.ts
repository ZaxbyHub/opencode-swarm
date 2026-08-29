import type { AgentDefinition } from '../agents/index.js';
import { type HarnessBlueprintV1, parseHarnessBlueprint } from './contracts.js';
import { createAgentFactory, type RuntimeAgentDefinition } from './factory.js';
import { canonicalJson } from './hash.js';
import { applyBlueprintPatch } from './patch.js';
import { validateSourceCandidate } from './source-candidate.js';
import {
	activateHarnessCandidate,
	auditHarnessLedger,
	listHarnessHistory,
	loadHarnessCurrent,
	recordHarnessCandidate,
	recoverHarnessCorruptTail,
	rollbackHarnessVersion,
	saveHarnessVersion,
} from './store.js';

function projectStaticBlueprint(agents: Record<string, AgentDefinition>) {
	const runtimeDefinitions: RuntimeAgentDefinition[] = Object.entries(agents)
		.sort(
			([leftKey, left], [rightKey, right]) =>
				left.name.localeCompare(right.name) || leftKey.localeCompare(rightKey),
		)
		.map(([, agent]) => {
			const config = agent.config as RuntimeAgentDefinition['config'];
			const tools = config.tools
				? Object.fromEntries(
						Object.entries(config.tools).sort(([a], [b]) => a.localeCompare(b)),
					)
				: config.tools;
			return {
				name: agent.name,
				description: agent.description,
				config: {
					...config,
					tools,
					mode: config.mode === 'primary' ? 'primary' : 'subagent',
					temperature: config.temperature ?? 0.1,
					prompt:
						config.prompt ?? `Static runtime definition for ${agent.name}`,
				},
			};
		});
	const registeredToolIds = [
		...new Set(
			runtimeDefinitions.flatMap((definition) =>
				Object.keys(definition.config.tools ?? {}),
			),
		),
	].sort();
	return createAgentFactory({
		runtimeDefinitions,
		registeredToolIds,
	}).projectBlueprint({
		blueprintId: 'static-runtime-shadow',
	});
}

function diffHarnessBlueprints(
	left: HarnessBlueprintV1,
	right: HarnessBlueprintV1,
): {
	changes: Record<string, { before: unknown; after: unknown }>;
	summary: { changeCount: number; changedKeys: string[] };
} {
	const changes: Record<string, { before: unknown; after: unknown }> = {};
	for (const key of [
		...new Set([...Object.keys(left), ...Object.keys(right)]),
	].sort()) {
		if (
			canonicalJson(left[key as keyof HarnessBlueprintV1]) !==
			canonicalJson(right[key as keyof HarnessBlueprintV1])
		) {
			changes[key] = {
				before: left[key as keyof HarnessBlueprintV1],
				after: right[key as keyof HarnessBlueprintV1],
			};
		}
	}
	return {
		changes,
		summary: {
			changeCount: Object.keys(changes).length,
			changedKeys: Object.keys(changes).sort(),
		},
	};
}

/**
 * Callable package namespace for explicit HarnessOpt consumers. Importing it is
 * pure; no filesystem, Git, agent, or activation work occurs until a method is
 * invoked. The live plugin manifest never calls this function during init.
 */
export const harnessMutationV1 = Object.freeze(
	Object.assign(
		function createHarnessMutationApiV1() {
			return harnessMutationV1;
		},
		{
			validateBlueprint: parseHarnessBlueprint,
			projectStaticBlueprint,
			applyPatchSet: applyBlueprintPatch,
			validateSourceCandidate,
			saveCandidate: recordHarnessCandidate,
			saveVersion: saveHarnessVersion,
			activate: activateHarnessCandidate,
			rollback: rollbackHarnessVersion,
			current: loadHarnessCurrent,
			history: listHarnessHistory,
			diff: diffHarnessBlueprints,
			auditLedger: auditHarnessLedger,
			recoverCorruptTail: recoverHarnessCorruptTail,
		},
	),
);
