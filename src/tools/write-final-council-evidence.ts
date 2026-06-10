/**
 * Write final council evidence for the project-scoped final council gate.
 *
 * The final council is not General Council mode. It accepts the same
 * five-member CouncilMemberVerdict objects used by phase council, synthesized
 * at completed-project scope.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { synthesizeFinalCouncilAdvisory } from '../council/council-service';
import type { CouncilAgent, CouncilMemberVerdict } from '../council/types';
import { validateSwarmPath } from '../hooks/utils';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import { createSwarmTool } from './create-tool';

const FINAL_COUNCIL_MEMBERS = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

const VerdictSchema = z.object({
	agent: z.enum(FINAL_COUNCIL_MEMBERS),
	verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
	confidence: z.number().min(0).max(1),
	findings: z.array(
		z.object({
			severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
			category: z.string().min(1),
			location: z.string(),
			detail: z.string(),
			evidence: z.string(),
		}),
	),
	criteriaAssessed: z.array(z.string()),
	criteriaUnmet: z.array(z.string()),
	durationMs: z.number().nonnegative(),
});

export const ArgsSchema = z.object({
	phase: z.number().int().min(1),
	projectSummary: z.string().min(1),
	roundNumber: z.number().int().min(1).max(10).optional(),
	verdicts: z.array(VerdictSchema).min(1).max(5),
});

/**
 * Arguments for the write_final_council_evidence tool.
 */
export interface WriteFinalCouncilEvidenceArgs {
	/** The phase number for the final council verdict */
	phase: number;
	/** Summary of the completed project being reviewed */
	projectSummary: string;
	/** 1-indexed final council round number */
	roundNumber?: number;
	/** Collected verdicts from critic, reviewer, sme, test_engineer, explorer */
	verdicts: CouncilMemberVerdict[];
}

function normalizeFinalVerdict(
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT',
	requiredFixesCount: number,
) {
	if (verdict === 'APPROVE') {
		return 'approved';
	}
	if (verdict === 'REJECT') {
		return 'rejected';
	}
	return requiredFixesCount > 0 ? 'rejected' : 'concerns';
}

/**
 * Execute the write_final_council_evidence tool.
 * Validates input, synthesizes project-scoped council evidence, and writes it.
 */
export async function executeWriteFinalCouncilEvidence(
	args: unknown,
	directory: string,
): Promise<string> {
	const parsed = ArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify(
			{
				success: false,
				reason: 'invalid arguments',
				errors: parsed.error.issues.map((i) => ({
					path: i.path.join('.'),
					message: i.message,
				})),
			},
			null,
			2,
		);
	}
	const input = parsed.data;

	const config = loadPluginConfig(directory);
	const requiredMembers = FINAL_COUNCIL_MEMBERS.length;
	const distinctMembers = new Set<CouncilAgent>(
		input.verdicts.map((v) => v.agent),
	);
	const membersVoted = [...distinctMembers];
	const membersAbsent = FINAL_COUNCIL_MEMBERS.filter(
		(m) => !distinctMembers.has(m),
	);

	if (membersVoted.length < requiredMembers) {
		return JSON.stringify(
			{
				success: false,
				reason: 'insufficient_quorum',
				message:
					`Final council quorum not met: ${membersVoted.length} of ${requiredMembers} required members provided verdicts. ` +
					`Members voted: [${membersVoted.join(', ')}]. ` +
					`Members absent: [${membersAbsent.join(', ')}]. ` +
					`Dispatch the absent council members with project-scoped context and collect their verdicts before calling write_final_council_evidence.`,
				membersVoted,
				membersAbsent,
				quorumRequired: requiredMembers,
			},
			null,
			2,
		);
	}

	const synthesis = synthesizeFinalCouncilAdvisory(
		input.projectSummary.trim(),
		input.verdicts as CouncilMemberVerdict[],
		input.roundNumber ?? 1,
		config.council,
	);

	// ── Blocking concerns gate ────────────────────────────────────────
	if (
		synthesis.overallVerdict === 'CONCERNS' &&
		synthesis.blockingConcernsCount > 0
	) {
		return JSON.stringify(
			{
				success: false,
				reason: 'blocking_concerns_unresolved',
				overallVerdict: synthesis.overallVerdict,
				blockingConcernsCount: synthesis.blockingConcernsCount,
				requiredFixes: synthesis.requiredFixes,
				unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
				message: `Final council returned CONCERNS with ${synthesis.blockingConcernsCount} HIGH/CRITICAL finding(s) promoted to requiredFixes. These must be resolved before the project can close. Do NOT write evidence or proceed — address every requiredFix and resubmit.`,
			},
			null,
			2,
		);
	}

	const plan = await loadPlan(directory);
	const planId = plan ? derivePlanId(plan) : 'unknown';
	const normalizedVerdict = normalizeFinalVerdict(
		synthesis.overallVerdict,
		synthesis.requiredFixes.length,
	);

	const evidenceEntry = {
		type: 'final-council',
		phase: input.phase,
		plan_id: planId,
		verdict: normalizedVerdict,
		rawCouncilVerdict: synthesis.overallVerdict,
		quorumSize: synthesis.quorumSize,
		membersVoted,
		membersAbsent,
		requiredFixes: synthesis.requiredFixes,
		advisoryFindings: synthesis.advisoryFindings,
		advisoryNotes: synthesis.advisoryNotes,
		unresolvedConflicts: synthesis.unresolvedConflicts,
		roundNumber: synthesis.roundNumber,
		allCriteriaMet: synthesis.allCriteriaMet,
		memberVerdicts: synthesis.memberVerdicts,
		unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
		projectSummary: synthesis.projectSummary,
		timestamp: synthesis.timestamp,
	};

	const filename = 'final-council.json';
	const relativePath = path.join('evidence', filename);
	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, relativePath);
	} catch (error) {
		return JSON.stringify(
			{
				success: false,
				phase: input.phase,
				message:
					error instanceof Error ? error.message : 'Failed to validate path',
			},
			null,
			2,
		);
	}

	const evidenceContent = {
		entries: [evidenceEntry],
	};
	const evidenceDir = path.dirname(validatedPath);

	try {
		await fs.promises.mkdir(evidenceDir, { recursive: true });
		const tempPath = path.join(evidenceDir, `.${filename}.tmp`);
		await fs.promises.writeFile(
			tempPath,
			JSON.stringify(evidenceContent, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tempPath, validatedPath);

		return JSON.stringify(
			{
				success: true,
				phase: input.phase,
				overallVerdict: synthesis.overallVerdict,
				verdict: normalizedVerdict,
				vetoedBy: synthesis.vetoedBy,
				roundNumber: synthesis.roundNumber,
				allCriteriaMet: synthesis.allCriteriaMet,
				requiredFixesCount: synthesis.requiredFixes.length,
				advisoryFindingsCount: synthesis.advisoryFindings.length,
				unresolvedConflictsCount: synthesis.unresolvedConflicts.length,
				advisoryNotes: synthesis.advisoryNotes,
				membersVoted,
				membersAbsent,
				quorumSize: synthesis.quorumSize,
				quorumMet: true,
				evidencePath: synthesis.evidencePath,
				unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
				message:
					'Final council evidence written to .swarm/evidence/final-council.json',
			},
			null,
			2,
		);
	} catch (error) {
		return JSON.stringify(
			{
				success: false,
				phase: input.phase,
				message: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		);
	}
}

/**
 * Tool definition for write_final_council_evidence.
 */
export const write_final_council_evidence: ToolDefinition = createSwarmTool({
	description:
		'Write final council evidence for a completed project. This is not General Council mode and does not use convene_general_council. PREREQUISITE: dispatch critic, reviewer, sme, test_engineer, and explorer as project-scoped Agent tasks, collect their CouncilMemberVerdict JSON, then call this tool to synthesize and persist .swarm/evidence/final-council.json.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.describe('The final phase number for the project being reviewed'),
		projectSummary: z
			.string()
			.min(1)
			.describe('Summary of the completed project and total work reviewed'),
		roundNumber: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe('1-indexed final council round number. Defaults to 1.'),
		verdicts: z
			.array(VerdictSchema)
			.min(1)
			.max(5)
			.describe(
				'Collected CouncilMemberVerdict objects from critic, reviewer, sme, test_engineer, and explorer.',
			),
	},
	execute: async (args, directory) => {
		const parsed = ArgsSchema.safeParse(args);
		if (!parsed.success) {
			return JSON.stringify(
				{
					success: false,
					reason: 'invalid arguments',
					errors: parsed.error.issues.map((i) => ({
						path: i.path.join('.'),
						message: i.message,
					})),
				},
				null,
				2,
			);
		}
		return await executeWriteFinalCouncilEvidence(
			parsed.data as WriteFinalCouncilEvidenceArgs,
			directory,
		);
	},
});
