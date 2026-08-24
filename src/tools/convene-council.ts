/** Submit pre-collected task council verdicts with durable server-owned rounds. */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { pushCouncilAdvisory } from '../council/council-advisory';
import {
	hasCouncilEvidenceAttempt,
	writeCouncilEvidence,
} from '../council/council-evidence-writer';
import { computeCouncilReviewIdentity } from '../council/council-review-identity';
import {
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
} from '../council/council-round-state';
import { synthesizeCouncilVerdicts } from '../council/council-service';
import { readCriteria } from '../council/criteria-store';
import type { CouncilMemberVerdict } from '../council/types';
import { COUNCIL_MEMBER_ROLES } from '../council/types';
import { loadPlan } from '../plan/manager.js';
import { getAgentSession } from '../state';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const ALL_MEMBERS = COUNCIL_MEMBER_ROLES;

const FindingSchema = z.object({
	severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
	category: z.string().min(1),
	location: z.string(),
	detail: z.string(),
	evidence: z.string(),
});

const VerdictSchema = z.object({
	agent: z.enum(ALL_MEMBERS),
	verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
	confidence: z.number().min(0).max(1),
	findings: z.array(FindingSchema),
	criteriaAssessed: z.array(z.string()),
	criteriaUnmet: z.array(z.string()),
	durationMs: z.number().nonnegative(),
});

export const ArgsSchema = z.object({
	taskId: z
		.string()
		.min(1)
		.regex(
			/^\d+\.\d+(\.\d+)*$/,
			'Task ID must be in N.M or N.M.P format (e.g. "1.1")',
		),
	swarmId: z.string().min(1),
	roundNumber: z.number().int().min(1).max(10).optional(),
	verdicts: z.array(VerdictSchema).min(1).max(5),
	working_directory: z.string().optional(),
});

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

export const submit_council_verdicts: ReturnType<typeof tool> = createSwarmTool(
	{
		description:
			'Submit pre-collected council member verdicts for synthesis. PREREQUISITE — ' +
			'dispatch critic, reviewer, sme, test_engineer, and explorer as separate Agent tasks, ' +
			'then submit their real verdicts here. The server owns the current council round; ' +
			'roundNumber is only an optional expectation. Architect-only and config-gated.',
		args: {
			taskId: ArgsSchema.shape.taskId.describe('Task ID, e.g. "1.1"'),
			swarmId: ArgsSchema.shape.swarmId.describe(
				'Swarm identifier, e.g. "mega"',
			),
			roundNumber: ArgsSchema.shape.roundNumber.describe(
				'Optional expected server round. Omit to use the authoritative current round.',
			),
			verdicts: ArgsSchema.shape.verdicts.describe(
				'Collected CouncilMemberVerdict objects from dispatched council members.',
			),
			working_directory: ArgsSchema.shape.working_directory.describe(
				'Explicit project root directory.',
			),
		},
		async execute(
			args: unknown,
			directory: string,
			ctx?: { sessionID?: string },
		): Promise<string> {
			const parsed = ArgsSchema.safeParse(args);
			if (!parsed.success) {
				const failure = await recordUnscopedCouncilAttempt(
					directory,
					'task',
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
			const resolved = resolveWorkingDirectory(
				input.working_directory,
				directory,
			);
			if (!resolved.success) {
				const failure = await recordUnscopedCouncilAttempt(
					directory,
					'task',
					'invalid_working_directory',
					input,
					[],
					ctx?.sessionID,
				);
				return (
					failure ??
					JSON.stringify({ success: false, reason: resolved.message }, null, 2)
				);
			}

			const workingDir = resolved.directory;
			const config = loadPluginConfig(workingDir);
			const councilConfig = config.council;
			let plan: Awaited<ReturnType<typeof loadPlan>> = null;
			try {
				plan = await loadPlan(workingDir);
			} catch {
				// A missing plan yields an identity with null plan fields; the
				// rehydration consumer (which loads the plan) fails closed against it.
			}
			const identity = computeCouncilReviewIdentity({
				level: 'task',
				scope: { kind: 'task', taskId: input.taskId },
				plan,
				config: councilConfig,
			});
			const distinctMembers = new Set(
				input.verdicts.map((verdict) => verdict.agent),
			);
			const membersVoted = [...distinctMembers];
			const membersAbsent = ALL_MEMBERS.filter(
				(member) => !distinctMembers.has(member),
			);
			const session = ctx?.sessionID
				? getAgentSession(ctx.sessionID)
				: undefined;
			const councilWorkflowGeneration =
				session?.taskCouncilWorkflowGeneration?.get(input.taskId);

			return runCouncilAttempt({
				directory: workingDir,
				scope: {
					kind: 'task',
					taskId: input.taskId,
					identityDigest: identity.identityDigest,
				},
				clientRound: input.roundNumber,
				maxRounds: councilConfig?.maxRounds ?? 3,
				sessionID: ctx?.sessionID,
				escalationConfigured: councilConfig?.escalateOnMaxRounds !== undefined,
				request: input,
				verdictCount: input.verdicts.length,
				members: membersVoted,
				probePendingEvidence: async (attemptId, round) =>
					hasCouncilEvidenceAttempt(workingDir, input.taskId, attemptId, round),
				evaluate: async (authoritativeRound) => {
					if (!councilConfig?.enabled) {
						return {
							disposition: 'council_disabled',
							response: {
								success: false,
								reason:
									'council feature is disabled — set council.enabled: true in .opencode/opencode-swarm.json to enable',
							},
							transition: 'stay',
							gateEffect: 'none',
						};
					}

					const effectiveMinimum = councilConfig.requireAllMembers
						? 5
						: (councilConfig.minimumMembers ?? 3);
					const requirementKey = `${input.taskId}:${authoritativeRound}`;
					if (session && !session.pendingCouncilRequirements) {
						session.pendingCouncilRequirements = new Map();
					}
					const required =
						session?.pendingCouncilRequirements?.get(requirementKey);
					const stillMissingMembers = required
						? [...required].filter((member) => !distinctMembers.has(member))
						: [];
					if (stillMissingMembers.length > 0) {
						return {
							disposition: 'cherry_pick_detected',
							response: {
								success: false,
								reason: 'cherry_pick_detected',
								message:
									`Incomplete re-dispatch: ${stillMissingMembers.join(', ')} ` +
									'were required from the previous insufficient_quorum response but are still absent. Dispatch ALL absent members in one parallel batch.',
								stillMissingMembers,
								membersProvided: membersVoted,
							},
							transition: 'stay',
							gateEffect: 'none',
						};
					}
					if (membersVoted.length < effectiveMinimum) {
						session?.pendingCouncilRequirements?.set(
							requirementKey,
							new Set(membersAbsent),
						);
						return {
							disposition: 'insufficient_quorum',
							response: {
								success: false,
								reason: 'insufficient_quorum',
								message:
									`Council quorum not met: ${membersVoted.length} of ${effectiveMinimum} required members provided verdicts. ` +
									`Members voted: [${membersVoted.join(', ')}]. Members absent: [${membersAbsent.join(', ')}]. ` +
									'Dispatch the absent council members before resubmitting.',
								membersVoted,
								membersAbsent,
								quorumRequired: effectiveMinimum,
							},
							transition: 'stay',
							gateEffect: 'none',
						};
					}

					const synthesis = synthesizeCouncilVerdicts(
						input.taskId,
						input.swarmId,
						input.verdicts as CouncilMemberVerdict[],
						readCriteria(workingDir, input.taskId),
						authoritativeRound,
						councilConfig,
					);
					const dissenters = synthesis.memberVerdicts
						.filter(
							(verdict) =>
								verdict.verdict === 'CONCERNS' || verdict.verdict === 'REJECT',
						)
						.map((verdict) => verdict.agent);
					const updateRequirements = (
						transition: 'advance' | 'close',
					): void => {
						if (!session?.pendingCouncilRequirements) return;
						session.pendingCouncilRequirements.delete(requirementKey);
						if (transition === 'advance' && dissenters.length > 0) {
							const nextRequiredRound = Math.min(
								authoritativeRound + 1,
								Math.max(authoritativeRound, councilConfig.maxRounds),
							);
							session.pendingCouncilRequirements.set(
								`${input.taskId}:${nextRequiredRound}`,
								new Set(dissenters),
							);
						}
					};

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
								message: `Council returned CONCERNS with ${synthesis.blockingConcernsCount} blocking finding(s). Address every requiredFix and resubmit.`,
							},
							transition: 'advance',
							gateEffect: 'blocked',
							verdict: synthesis.overallVerdict,
							quorumSize: membersVoted.length,
							afterCommit: () => updateRequirements('advance'),
						};
					}

					const transition =
						synthesis.overallVerdict === 'REJECT' ? 'advance' : 'close';
					return {
						disposition: `evaluated_${synthesis.overallVerdict.toLowerCase()}`,
						response: {
							success: true,
							overallVerdict: synthesis.overallVerdict,
							vetoedBy: synthesis.vetoedBy,
							roundNumber: synthesis.roundNumber,
							allCriteriaMet: synthesis.allCriteriaMet,
							requiredFixesCount: synthesis.requiredFixes.length,
							advisoryFindingsCount: synthesis.advisoryFindings.length,
							unresolvedConflictsCount: synthesis.unresolvedConflicts.length,
							membersVoted,
							membersAbsent,
							quorumSize: membersVoted.length,
							quorumMet: true,
							unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
						},
						transition,
						gateEffect: transition === 'close' ? 'allowed' : 'blocked',
						verdict: synthesis.overallVerdict,
						quorumSize: membersVoted.length,
						evidence: {
							reference: `.swarm/evidence/${input.taskId}.json`,
							commit: async (attemptId) => {
								if (councilWorkflowGeneration === undefined) {
									throw new Error(
										`TASK_COUNCIL_GENERATION_REQUIRED: dispatch council members for task ${input.taskId} before submitting their verdicts`,
									);
								}
								await writeCouncilEvidence(
									workingDir,
									synthesis,
									attemptId,
									councilWorkflowGeneration,
									identity,
								);
							},
						},
						afterCommit: async () => {
							updateRequirements(transition);
							try {
								if (ctx?.sessionID && session)
									pushCouncilAdvisory(session, synthesis);
							} catch {
								// Advisory delivery is non-critical.
							}
						},
					};
				},
			});
		},
	},
);
