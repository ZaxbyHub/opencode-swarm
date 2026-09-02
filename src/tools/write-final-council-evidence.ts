import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	computeCouncilReviewHash,
	computeCouncilReviewIdentity,
	councilIdentityEvidenceFields,
	resolveCouncilMemberRole,
	resolveFinalCompletionPolicy,
} from '../council/council-review-identity';
import {
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
} from '../council/council-round-state';
import { synthesizeFinalCouncilAdvisory } from '../council/council-service';
import type { CouncilMemberVerdict } from '../council/types';
import { COUNCIL_MEMBER_ROLES } from '../council/types';
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

const FINAL_COUNCIL_MEMBERS = COUNCIL_MEMBER_ROLES;

const VerdictSchema = z.object({
	// Accepts exact canonical roles and multi-swarm prefixed names
	// (e.g. `local_critic`); unresolvable names never count toward quorum.
	agent: z.string().min(1).max(64),
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

/**
 * Resolve submitted verdict agents to canonical council roles. Unknown
 * names are excluded (never count); duplicate identities collapse to the
 * first occurrence (deterministic). Returns the canonicalized verdicts,
 * the distinct canonical roles that voted, and diagnostics.
 */
function resolveFinalCouncilVerdicts(
	verdicts: Array<{ agent: string } & Record<string, unknown>>,
): {
	resolved: CouncilMemberVerdict[];
	distinctRoles: string[];
	unknownAgents: string[];
	duplicateAgents: string[];
} {
	const resolved: CouncilMemberVerdict[] = [];
	const distinctRoles: string[] = [];
	const unknownAgents: string[] = [];
	const duplicateAgents: string[] = [];
	for (const verdict of verdicts) {
		const role = resolveCouncilMemberRole(verdict.agent);
		if (!role) {
			if (!unknownAgents.includes(verdict.agent)) {
				unknownAgents.push(verdict.agent);
			}
			continue;
		}
		if (distinctRoles.includes(role)) {
			if (!duplicateAgents.includes(verdict.agent)) {
				duplicateAgents.push(verdict.agent);
			}
			continue;
		}
		distinctRoles.push(role);
		resolved.push({
			...(verdict as unknown as CouncilMemberVerdict),
			agent: role,
		});
	}
	return { resolved, distinctRoles, unknownAgents, duplicateAgents };
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
	const reviewHash = plan ? computeCouncilReviewHash(plan) : null;
	const identity = computeCouncilReviewIdentity({
		level: 'final',
		scope: { kind: 'final', final: true },
		plan,
		config: config.council,
	});
	const completionPolicy = resolveFinalCompletionPolicy(config.council);
	const { resolved, distinctRoles, unknownAgents, duplicateAgents } =
		resolveFinalCouncilVerdicts(input.verdicts);
	const membersVoted = distinctRoles;
	const membersAbsent = FINAL_COUNCIL_MEMBERS.filter(
		(member) => !distinctRoles.includes(member),
	);
	const requiredMembers =
		completionPolicy.mode === 'quorum'
			? completionPolicy.minimumMembers
			: FINAL_COUNCIL_MEMBERS.length;

	return runCouncilAttempt({
		directory,
		// Final approval is closed only for this exact review identity (the
		// status-stable review hash + council policy digest). A later
		// review-relevant plan/policy change gets a fresh authoritative round
		// and can be reviewed; ordinary status-only progress does not.
		scope: { kind: 'final', identityDigest: identity.identityDigest },
		clientRound: input.roundNumber,
		maxRounds: config.council?.maxRounds ?? 3,
		sessionID: ctx?.sessionID,
		escalationConfigured: config.council?.escalateOnMaxRounds !== undefined,
		request: input,
		verdictCount: input.verdicts.length,
		members: [...new Set(input.verdicts.map((v) => v.agent))].slice(0, 5),
		probePendingEvidence: async (attemptId, round) =>
			hasFinalEvidenceAttempt(directory, attemptId, round),
		evaluate: async (authoritativeRound) => {
			if (membersVoted.length < requiredMembers) {
				return {
					disposition: 'insufficient_quorum',
					response: {
						success: false,
						reason: 'insufficient_quorum',
						message:
							`Final council quorum not met: ${membersVoted.length} of ${requiredMembers} required distinct canonical members provided verdicts ` +
							`(policy: ${completionPolicy.mode}${completionPolicy.mode === 'quorum' ? `, minimumMembers: ${completionPolicy.minimumMembers}` : ''}). ` +
							`Members voted: [${membersVoted.join(', ')}]. ` +
							`Members absent: [${membersAbsent.join(', ')}].` +
							(unknownAgents.length > 0
								? ` Unknown identities (never counted): [${unknownAgents.join(', ')}].`
								: '') +
							(duplicateAgents.length > 0
								? ` Duplicate identities (collapsed): [${duplicateAgents.join(', ')}].`
								: '') +
							' Dispatch the absent council members with project-scoped context and collect their verdicts before calling write_final_council_evidence.',
						membersVoted,
						membersAbsent,
						quorumRequired: requiredMembers,
						completionPolicy,
						...(unknownAgents.length > 0 ? { unknownAgents } : {}),
						...(duplicateAgents.length > 0 ? { duplicateAgents } : {}),
					},
					transition: 'stay',
					gateEffect: 'none',
				};
			}

			const synthesis = synthesizeFinalCouncilAdvisory(
				input.projectSummary.trim(),
				resolved,
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
				// Status-sensitive ledger hash, recorded for audit only. The
				// completion gate binds to identity_digest/review_hash/policy_digest
				// (below) so ordinary task-status progress cannot invalidate the
				// review; the gate must never enforce equality on plan_hash.
				plan_hash: planHash!,
				plan_identity_hash: planIdentityHash!,
				...councilIdentityEvidenceFields(identity),
				// Audit-only human-readable mirrors of what the policy_digest
				// already binds cryptographically: the gate re-derives the
				// completion policy and freshness window from the CURRENT config
				// and compares policy_digest byte-for-byte — it never reads these
				// two fields. They make the evidence self-describing for incident
				// reconstruction (same convention as plan_hash above).
				final_completion_policy: completionPolicy,
				freshness_max_age_hours: config.council?.freshnessMaxAgeHours ?? 24,
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
					completionPolicy,
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
								// The comparison uses the status-stable review hash: a
								// concurrent task-status change is legitimate progress, not a
								// plan mutation (issue #2102).
								const currentPlan = await loadPlan(directory);
								if (
									!currentPlan ||
									computeCouncilReviewHash(currentPlan) !== reviewHash
								) {
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
		'Write final council evidence for a completed project. This is not General Council mode and does not use convene_general_council. PREREQUISITE: dispatch critic, reviewer, sme, test_engineer, and explorer as project-scoped Agent tasks, collect their CouncilMemberVerdict JSON, then call this tool to synthesize and persist .swarm/evidence/final-council.json. Quorum follows council.finalCompletionPolicy: default requires all five canonical roles with zero absentees; an explicit quorum policy accepts a bounded minimum of distinct canonical members. Member names may be exact canonical roles or multi-swarm prefixed names (e.g. local_critic); unknown and duplicate identities never count.',
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
				'Collected CouncilMemberVerdict objects from critic, reviewer, sme, test_engineer, and explorer (canonical or multi-swarm prefixed names).',
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
