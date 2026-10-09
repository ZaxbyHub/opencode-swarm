import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { getCurrentPhase, isPhaseInWrapWindow } from '../config/plan-schema.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { extractPhaseLabelFromPlan } from '../hooks/extractors.js';
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
	// At PHASE-WRAP the phase's last task has already advanced the cursor
	// (#2532), and phase_complete hands this tool out as the recovery for that
	// phase, so the phase being wrapped is accepted as well as the cursor.
	if (
		!plan ||
		!requestedPhase ||
		(getCurrentPhase(plan) !== args.phase &&
			!isPhaseInWrapWindow(plan, args.phase))
	) {
		return {
			success: false,
			code: 'DIRECTIVE_OVERRIDE_PHASE_MISMATCH',
			message: `Phase ${args.phase} is neither the current plan phase nor the phase being wrapped.`,
		};
	}
	const phaseLabel =
		extractPhaseLabelFromPlan(plan, args.phase) ?? `Phase ${args.phase}`;
	await recordDirectiveOverrideInternals.recordDirectiveOverrides(
		directory,
		[...new Set(args.directive_ids)],
		args.justification,
		ctx.sessionID,
		phaseLabel,
		// #2947: pass the validated numeric phase id so the override finds and
		// commits against its target even when the recomposed label skews.
		args.phase,
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
		'Architect-only audited override for identified critical-directive violations. Requires the current phase (or the phase being wrapped, whose last task already advanced the cursor), the session identity and substantive justification; it cannot repair or bypass unreadable authority.',
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
