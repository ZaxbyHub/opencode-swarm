import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
} from '../council/council-round-state';
import { synthesizeFinalCouncilAdvisory } from '../council/council-service';
import type { CouncilMemberVerdict } from '../council/types';
import { withEvidenceLock } from '../evidence/lock.js';
import { validateSwarmPath } from '../hooks/utils';
import { COUNCIL_VERDICT_REWARDS } from '../memory/config';
import { createConfiguredMemoryProvider } from '../memory/gateway';
import { applyCouncilReward } from '../memory/reward-capture';
import { computePlanHash } from '../plan/ledger.js';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import * as logger from '../utils/logger';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
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
	phase: z.number().int().min(1).max(1000),
	projectSummary: z.string().min(1),
	roundNumber: z.number().int().min(1).max(10).optional(),
	verdicts: z.array(VerdictSchema).min(1).max(5),
});

export interface WriteFinalCouncilEvidenceArgs {
	phase: number;
	projectSummary: string;
	roundNumber?: number;
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

function invalidResponse(issues: z.ZodIssue[]): string {
	return JSON.stringify(
		{
			success: false,
			reason: 'invalid arguments',
			errors: issues.map((issue) => ({
				path: issue.path.join('.'),
				message: issue.message,
			})),
		},
		null,
		2,
	);
}

export async function executeWriteFinalCouncilEvidence(
	args: unknown,
	directory: string,
	ctx?: ToolContext,
): Promise<string> {
	const parsed = ArgsSchema.safeParse(args);
	if (!parsed.success) {
		const failure = await recordUnscopedCouncilAttempt(
			directory,
			'final',
			'invalid_arguments',
			args,
			parsed.error.issues.map((issue) => ({
				path: issue.path,
				code: issue.code,
			})),
			ctx?.sessionID,
		);
		return failure ?? invalidResponse(parsed.error.issues);
	}

	const input = parsed.data;
	const config = loadPluginConfig(directory);
	let plan: Awaited<ReturnType<typeof loadPlan>> = null;
	try {
		plan = await loadPlan(directory);
	} catch {
		// The scoped attempt still records a deterministic plan-not-found result.
	}
	const planHash = plan ? computePlanHash(plan) : undefined;
	const planId = plan ? derivePlanId(plan) : undefined;
	const planIdentityHash = plan ? derivePlanIdentityHash(plan) : undefined;
	const membersVoted = [...new Set(input.verdicts.map((v) => v.agent))];
	const membersAbsent = FINAL_COUNCIL_MEMBERS.filter(
		(member) => !membersVoted.includes(member),
	);

	return runCouncilAttempt({
		directory,
		// Final approval is closed only for this exact plan generation. A later
		// plan mutation gets a fresh authoritative round state and can be reviewed.
		scope: { kind: 'final', generation: planHash ?? 'missing-plan' },
		clientRound: input.roundNumber,
		maxRounds: config.council?.maxRounds ?? 3,
		sessionID: ctx?.sessionID,
		request: input,
		verdictCount: input.verdicts.length,
		members: membersVoted,
		probePendingEvidence: async (attemptId, round) =>
			hasFinalEvidenceAttempt(directory, attemptId, round),
		evaluate: async (authoritativeRound) => {
			if (membersVoted.length < FINAL_COUNCIL_MEMBERS.length) {
				return {
					disposition: 'insufficient_quorum',
					response: {
						success: false,
						reason: 'insufficient_quorum',
						message:
							`Final council quorum not met: ${membersVoted.length} of ${FINAL_COUNCIL_MEMBERS.length} required members provided verdicts. ` +
							`Members voted: [${membersVoted.join(', ')}]. ` +
							`Members absent: [${membersAbsent.join(', ')}]. ` +
							'Dispatch the absent council members with project-scoped context and collect their verdicts before calling write_final_council_evidence.',
						membersVoted,
						membersAbsent,
						quorumRequired: FINAL_COUNCIL_MEMBERS.length,
					},
					transition: 'stay',
					gateEffect: 'none',
				};
			}

			const synthesis = synthesizeFinalCouncilAdvisory(
				input.projectSummary.trim(),
				input.verdicts as CouncilMemberVerdict[],
				authoritativeRound,
				config.council,
			);

			if (
				synthesis.overallVerdict === 'CONCERNS' &&
				synthesis.blockingConcernsCount > 0
			) {
				return {
					disposition: 'blocking_concerns_unresolved',
					response: {
						success: false,
						reason: 'blocking_concerns_unresolved',
						overallVerdict: synthesis.overallVerdict,
						blockingConcernsCount: synthesis.blockingConcernsCount,
						requiredFixes: synthesis.requiredFixes,
						unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
						message: `Final council returned CONCERNS with ${synthesis.blockingConcernsCount} HIGH/CRITICAL finding(s) promoted to requiredFixes. These must be resolved before the project can close. Do NOT write evidence or proceed — address every requiredFix and resubmit.`,
					},
					transition: 'advance',
					gateEffect: 'blocked',
					verdict: synthesis.overallVerdict,
					quorumSize: synthesis.quorumSize,
				};
			}

			if (!plan) {
				return {
					disposition: 'plan_not_found',
					response: {
						success: false,
						reason: 'plan_not_found',
						message:
							'Cannot write final council evidence: plan.json not found. The plan must be loaded and available before writing final council evidence.',
						phase: input.phase,
						plan_id: 'unknown',
					},
					transition: 'stay',
					gateEffect: 'none',
				};
			}

			const normalizedVerdict = normalizeFinalVerdict(
				synthesis.overallVerdict,
				synthesis.requiredFixes.length,
			);
			const evidenceEntry = {
				type: 'final-council',
				phase: input.phase,
				plan_id: planId!,
				plan_hash: planHash!,
				plan_identity_hash: planIdentityHash!,
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

			let validatedPath: string;
			try {
				validatedPath = _internals.validateSwarmPath(
					directory,
					path.join('evidence', 'final-council.json'),
				);
			} catch (error) {
				return {
					disposition: 'invalid_evidence_path',
					response: {
						success: false,
						phase: input.phase,
						message:
							error instanceof Error
								? error.message
								: 'Failed to validate path',
					},
					transition: 'stay',
					gateEffect: 'none',
				};
			}

			const evidenceDir = path.dirname(validatedPath);
			const accepted =
				synthesis.overallVerdict === 'APPROVE' ||
				(synthesis.overallVerdict === 'CONCERNS' &&
					synthesis.blockingConcernsCount === 0);

			return {
				disposition: `evaluated_${synthesis.overallVerdict.toLowerCase()}`,
				response: {
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
				transition: accepted ? 'close' : 'advance',
				gateEffect: accepted ? 'allowed' : 'blocked',
				verdict: synthesis.overallVerdict,
				quorumSize: synthesis.quorumSize,
				evidence: {
					reference: synthesis.evidencePath,
					commit: async (attemptId) => {
						await withEvidenceLock(
							directory,
							path.join('evidence', 'final-council.json'),
							'write-final-council-evidence',
							attemptId,
							async () => {
								// Generation locks are intentionally distinct. Re-check the
								// current plan while holding this shared publication lock so an
								// older generation can never overwrite newer final evidence.
								const currentPlan = await loadPlan(directory);
								if (!currentPlan || computePlanHash(currentPlan) !== planHash) {
									throw new Error(
										'final council plan changed before evidence publication',
									);
								}
								await fs.promises.mkdir(evidenceDir, { recursive: true });
								const tempPath = path.join(
									evidenceDir,
									`.final-council.${attemptId}.tmp`,
								);
								try {
									await fs.promises.writeFile(
										tempPath,
										JSON.stringify(
											{
												entries: [
													{
														...evidenceEntry,
														attemptId,
													},
												],
											},
											null,
											2,
										),
										'utf-8',
									);
									await fs.promises.rename(tempPath, validatedPath);
									invalidateCachedArtifact(validatedPath);
								} finally {
									await fs.promises
										.rm(tempPath, { force: true })
										.catch(() => {});
								}
							},
						);
					},
				},
				afterCommit: async () => {
					try {
						const memoryConfig = config.memory;
						if (memoryConfig?.enabled === true && ctx?.sessionID) {
							const provider = createConfiguredMemoryProvider(
								directory,
								memoryConfig,
							);
							try {
								await applyCouncilReward(provider, {
									runId: ctx.sessionID,
									unitId: undefined,
									reward: COUNCIL_VERDICT_REWARDS[synthesis.overallVerdict],
									eta: memoryConfig.qLearning.learningRate,
									initialQValue: memoryConfig.qLearning.initialQValue,
									qLearning: memoryConfig.qLearning,
									timestamp: new Date().toISOString(),
									verdictLabel: synthesis.overallVerdict,
								});
							} finally {
								await provider.close?.();
							}
						}
					} catch (rewardErr) {
						logger.warn(
							`[write-final-council-evidence] final council reward capture failed: ${rewardErr instanceof Error ? rewardErr.message : String(rewardErr)}`,
						);
					}
				},
			};
		},
	});
}

/**
 * Tool definition for write_final_council_evidence.
 */
export const write_final_council_evidence: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Write final council evidence for a completed project. This is not General Council mode and does not use convene_general_council. PREREQUISITE: dispatch critic, reviewer, sme, test_engineer, and explorer as project-scoped Agent tasks, collect their CouncilMemberVerdict JSON, then call this tool to synthesize and persist .swarm/evidence/final-council.json.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.max(1000)
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
			.describe(
				'1-indexed final council round number. Defaults to the current server round.',
			),
		verdicts: z
			.array(VerdictSchema)
			.min(1)
			.max(5)
			.describe(
				'Collected CouncilMemberVerdict objects from critic, reviewer, sme, test_engineer, and explorer.',
			),
	},
	execute: async (args, directory, ctx) =>
		executeWriteFinalCouncilEvidence(args, directory, ctx),
});

function hasFinalEvidenceAttempt(
	directory: string,
	attemptId: string,
	round: number,
): boolean {
	try {
		const evidencePath = validateSwarmPath(
			directory,
			path.join('evidence', 'final-council.json'),
		);
		const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
			entries?: Array<{
				type?: unknown;
				attemptId?: unknown;
				roundNumber?: unknown;
			}>;
		};
		return Boolean(
			parsed.entries?.some(
				(entry) =>
					entry.type === 'final-council' &&
					entry.attemptId === attemptId &&
					entry.roundNumber === round,
			),
		);
	} catch {
		return false;
	}
}

export const _internals = {
	validateSwarmPath,
};
