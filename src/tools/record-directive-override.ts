import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { extractCurrentPhaseFromPlan } from '../hooks/extractors.js';
import { recordDirectiveOverrides } from '../hooks/phase-complete-directive-gate.js';
import { loadPlan } from '../plan/manager.js';
import { createSwarmTool } from './create-tool.js';

export interface RecordDirectiveOverrideArgs {
	directive_ids: string[];
	justification: string;
	phase: number;
}

export const recordDirectiveOverrideInternals = {
	loadPlan,
	recordDirectiveOverrides,
};

export async function executeRecordDirectiveOverride(
	args: RecordDirectiveOverrideArgs,
	directory: string,
	ctx?: Pick<ToolContext, 'sessionID' | 'agent'>,
): Promise<Record<string, unknown>> {
	if (!ctx?.sessionID?.trim()) {
		return {
			success: false,
			code: 'DIRECTIVE_OVERRIDE_SESSION_REQUIRED',
			message: 'An exact session identity is required to record an override.',
		};
	}
	if (stripKnownSwarmPrefix(ctx.agent ?? '').toLowerCase() !== 'architect') {
		return {
			success: false,
			code: 'DIRECTIVE_OVERRIDE_ARCHITECT_ONLY',
			message: 'Only the architect may record a critical-directive override.',
		};
	}

	const plan = await recordDirectiveOverrideInternals.loadPlan(directory);
	const requestedPhase = plan?.phases.find(
		(candidate) => candidate.id === args.phase,
	);
	if (!plan || !requestedPhase || plan.current_phase !== args.phase) {
		return {
			success: false,
			code: 'DIRECTIVE_OVERRIDE_PHASE_MISMATCH',
			message: `Phase ${args.phase} is not the current authoritative plan phase.`,
		};
	}
	const phaseLabel =
		extractCurrentPhaseFromPlan(plan) ?? `Phase ${plan.current_phase}`;
	await recordDirectiveOverrideInternals.recordDirectiveOverrides(
		directory,
		[...new Set(args.directive_ids)],
		args.justification,
		ctx.sessionID,
		phaseLabel,
	);
	return {
		success: true,
		code: 'DIRECTIVE_OVERRIDE_RECORDED',
		phase: args.phase,
		directive_ids: [...new Set(args.directive_ids)],
		message:
			'Recorded the audited override. Retry phase_complete so every gate is re-evaluated from a fresh snapshot.',
	};
}

export const record_directive_override: ToolDefinition = createSwarmTool({
	description:
		'Architect-only audited override for identified critical-directive violations. Requires exact current phase/session identity and substantive justification; it cannot repair or bypass unreadable authority.',
	args: {
		directive_ids: z.array(z.string().min(1).max(256)).min(1).max(64),
		justification: z.string().trim().min(10).max(2000),
		phase: z.number().int().min(1).max(9999),
	},
	execute: async (args, directory, ctx) =>
		JSON.stringify(
			await executeRecordDirectiveOverride(
				args as unknown as RecordDirectiveOverrideArgs,
				directory,
				ctx,
			),
			null,
			2,
		),
});
