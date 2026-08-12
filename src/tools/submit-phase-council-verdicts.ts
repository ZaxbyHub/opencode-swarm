import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ToolContext, tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
} from '../council/council-round-state';
import { synthesizePhaseCouncilAdvisory } from '../council/council-service';
import type {
	CouncilFinding,
	CouncilMemberVerdict,
	PhaseCouncilSynthesis,
} from '../council/types';
import { COUNCIL_VERDICT_REWARDS } from '../memory/config';
import { createConfiguredMemoryProvider } from '../memory/gateway';
import {
	applyCouncilReward,
	truncateObjectForJson,
} from '../memory/reward-capture';
import * as logger from '../utils/logger';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const ALL_MEMBERS = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

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
	phaseNumber: z.number().int().min(1),
	swarmId: z.string().min(1),
	phaseSummary: z.string().min(1),
	roundNumber: z.number().int().min(1).max(10).optional(),
	verdicts: z.array(VerdictSchema).min(1).max(5),
	working_directory: z.string().optional(),
	provenanceAgentName: z.string().min(1).optional(),
	provenanceSessionId: z.string().min(1).optional(),
});

export const submit_phase_council_verdicts: ReturnType<typeof tool> =
	createSwarmTool({
		description:
			'Submit pre-collected phase council verdicts. The server owns the current ' +
			'round; roundNumber is only an optional expectation. Writes phase-council ' +
			'evidence after durable attempt-state preflight. Architect-only and config-gated.',
		args: {
			phaseNumber: ArgsSchema.shape.phaseNumber.describe(
				'Phase number being reviewed',
			),
			swarmId: ArgsSchema.shape.swarmId.describe('Swarm identifier'),
			phaseSummary: ArgsSchema.shape.phaseSummary.describe('Phase summary'),
			roundNumber: ArgsSchema.shape.roundNumber.describe(
				'Optional expected server round. Omit to use the authoritative round.',
			),
			verdicts: ArgsSchema.shape.verdicts.describe('Collected member verdicts'),
			working_directory: ArgsSchema.shape.working_directory.describe(
				'Explicit project root directory',
			),
			provenanceAgentName: ArgsSchema.shape.provenanceAgentName.describe(
				'Optional evidence producer name',
			),
			provenanceSessionId: ArgsSchema.shape.provenanceSessionId.describe(
				'Optional evidence producer session',
			),
		},
		async execute(
			args: unknown,
			directory: string,
			ctx?: ToolContext,
		): Promise<string> {
			const parsed = ArgsSchema.safeParse(args);
			if (!parsed.success) {
				const failure = await recordUnscopedCouncilAttempt(
					directory,
					'phase',
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
					'phase',
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
			const distinctMembers = new Set(
				input.verdicts.map((verdict) => verdict.agent),
			);
			const membersVoted = [...distinctMembers];
			const membersAbsent = ALL_MEMBERS.filter(
				(member) => !distinctMembers.has(member),
			);

			return runCouncilAttempt({
				directory: workingDir,
				scope: { kind: 'phase', phaseNumber: input.phaseNumber },
				clientRound: input.roundNumber,
				maxRounds: councilConfig?.maxRounds ?? 3,
				sessionID: ctx?.sessionID,
				request: input,
				verdictCount: input.verdicts.length,
				members: membersVoted,
				probePendingEvidence: async (attemptId, round) =>
					hasPhaseEvidenceAttempt(
						workingDir,
						input.phaseNumber,
						attemptId,
						round,
					),
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
					if (membersVoted.length < effectiveMinimum) {
						return {
							disposition: 'insufficient_quorum',
							response: {
								success: false,
								reason: 'insufficient_quorum',
								message:
									`Phase council quorum not met: ${membersVoted.length} of ${effectiveMinimum}. ` +
									`Members absent: [${membersAbsent.join(', ')}].`,
								membersVoted,
								membersAbsent,
								quorumRequired: effectiveMinimum,
							},
							transition: 'stay',
							gateEffect: 'none',
						};
					}

					const synthesis = synthesizePhaseCouncilAdvisory(
						input.phaseNumber,
						input.phaseSummary,
						input.verdicts as CouncilMemberVerdict[],
						authoritativeRound,
						councilConfig,
						workingDir,
					);
					const hasMutationFinding = input.verdicts.some((verdict) =>
						verdict.findings.some(
							(finding) => finding.category === 'mutation_gap',
						),
					);
					const mutationGapFinding = hasMutationFinding
						? null
						: getPhaseMutationGapFinding(input.phaseNumber, workingDir);
					if (mutationGapFinding) {
						addMutationGapFindingToSynthesis(synthesis, mutationGapFinding);
						if (
							mutationGapFinding.severity === 'CRITICAL' ||
							mutationGapFinding.severity === 'HIGH'
						) {
							synthesis.blockingConcernsCount++;
						}
					}

					if (synthesis.blockingConcernsCount > 0) {
						return {
							disposition: 'blocking_concerns_unresolved',
							response: {
								success: false,
								reason: 'blocking_concerns_unresolved',
								overallVerdict: synthesis.overallVerdict,
								blockingConcernsCount: synthesis.blockingConcernsCount,
								requiredFixes: synthesis.requiredFixes,
								unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
								message:
									'Address every requiredFix and resubmit the phase council.',
							},
							transition: 'advance',
							gateEffect: 'blocked',
							verdict: synthesis.overallVerdict,
							quorumSize: membersVoted.length,
						};
					}

					const provenance =
						input.provenanceAgentName || input.provenanceSessionId
							? {
									agent_name: input.provenanceAgentName,
									session_id: input.provenanceSessionId,
									captured_at: new Date().toISOString(),
								}
							: undefined;
					const concernsAllowed =
						councilConfig.phaseConcernsAllowComplete ?? true;
					const transition =
						synthesis.overallVerdict === 'APPROVE' ||
						(synthesis.overallVerdict === 'CONCERNS' && concernsAllowed)
							? 'close'
							: 'advance';
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
							advisoryNotes: synthesis.advisoryNotes,
							mutationGapEmitted: mutationGapFinding !== null,
							membersVoted,
							membersAbsent,
							quorumSize: membersVoted.length,
							quorumMet: true,
							evidencePath: synthesis.evidencePath,
							unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
						},
						transition,
						gateEffect: transition === 'close' ? 'allowed' : 'blocked',
						verdict: synthesis.overallVerdict,
						quorumSize: membersVoted.length,
						evidence: {
							reference: synthesis.evidencePath,
							commit: async (attemptId) =>
								writePhaseCouncilEvidence(
									workingDir,
									synthesis,
									provenance,
									attemptId,
								),
						},
						afterCommit: async () =>
							applyPhaseCouncilReward(workingDir, synthesis, config, ctx),
					};
				},
			});
		},
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

async function applyPhaseCouncilReward(
	workingDir: string,
	synthesis: PhaseCouncilSynthesis,
	config: ReturnType<typeof loadPluginConfig>,
	ctx?: ToolContext,
): Promise<void> {
	try {
		const memoryConfig = config.memory;
		if (memoryConfig?.enabled !== true || !ctx?.sessionID) return;
		const provider = createConfiguredMemoryProvider(workingDir, memoryConfig);
		try {
			const summary = {
				scope: 'phase',
				phaseNumber: synthesis.phaseNumber,
				overallVerdict: synthesis.overallVerdict,
				allCriteriaMet: synthesis.allCriteriaMet,
				requiredFixesCount: synthesis.requiredFixes.length,
				roundNumber: synthesis.roundNumber,
				quorumSize: synthesis.quorumSize,
			};
			let verdictSynthesisJson = JSON.stringify(summary);
			const cap = memoryConfig.qLearning.verdictPayloadCapBytes;
			if (
				typeof cap === 'number' &&
				cap > 0 &&
				verdictSynthesisJson.length > cap
			) {
				verdictSynthesisJson = JSON.stringify(
					truncateObjectForJson(summary, cap),
				);
			}
			await applyCouncilReward(provider, {
				runId: ctx.sessionID,
				unitId: undefined,
				reward: COUNCIL_VERDICT_REWARDS[synthesis.overallVerdict],
				eta: memoryConfig.qLearning.learningRate,
				initialQValue: memoryConfig.qLearning.initialQValue,
				qLearning: memoryConfig.qLearning,
				verdictSynthesisJson,
				timestamp: new Date().toISOString(),
				verdictLabel: synthesis.overallVerdict,
			});
		} finally {
			await provider.close?.();
		}
	} catch (error) {
		logger.warn(
			`[submit-phase-council-verdicts] phase council reward capture failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function phaseEvidencePath(workingDir: string, phaseNumber: number): string {
	return path.join(
		workingDir,
		'.swarm',
		'evidence',
		String(phaseNumber),
		'phase-council.json',
	);
}

function hasPhaseEvidenceAttempt(
	workingDir: string,
	phaseNumber: number,
	attemptId: string,
	round: number,
): boolean {
	try {
		const parsed = JSON.parse(
			readFileSync(phaseEvidencePath(workingDir, phaseNumber), 'utf8'),
		) as {
			entries?: Array<{
				type?: unknown;
				attemptId?: unknown;
				roundNumber?: unknown;
			}>;
		};
		return Boolean(
			parsed.entries?.some(
				(entry) =>
					entry.type === 'phase-council' &&
					entry.attemptId === attemptId &&
					entry.roundNumber === round,
			),
		);
	} catch {
		return false;
	}
}

async function writePhaseCouncilEvidence(
	workingDir: string,
	synthesis: PhaseCouncilSynthesis,
	provenance:
		| { agent_name?: string; session_id?: string; captured_at?: string }
		| undefined,
	attemptId: string,
): Promise<void> {
	const evidenceFile = phaseEvidencePath(workingDir, synthesis.phaseNumber);
	mkdirSync(path.dirname(evidenceFile), { recursive: true });
	const content = {
		entries: [
			{
				type: 'phase-council',
				phase_number: synthesis.phaseNumber,
				scope: 'phase',
				timestamp: synthesis.timestamp,
				verdict: synthesis.overallVerdict,
				quorumSize: synthesis.quorumSize,
				phaseSummary: synthesis.phaseSummary ?? '',
				requiredFixes: synthesis.requiredFixes,
				advisoryNotes: synthesis.advisoryNotes,
				advisoryFindings: synthesis.advisoryFindings,
				roundNumber: synthesis.roundNumber,
				allCriteriaMet: synthesis.allCriteriaMet,
				attemptId,
				...(provenance ? { provenance } : {}),
			},
		],
	};
	const tempFile = `${evidenceFile}.tmp-${Date.now()}`;
	try {
		writeFileSync(tempFile, JSON.stringify(content, null, 2), 'utf8');
		renameSync(tempFile, evidenceFile);
		invalidateCachedArtifact(evidenceFile);
	} finally {
		if (existsSync(tempFile)) unlinkSync(tempFile);
	}
}

function getPhaseMutationGapFinding(
	phaseNumber: number,
	workingDir: string,
): CouncilFinding | null {
	const mutationGatePath = path.join(
		workingDir,
		'.swarm',
		'evidence',
		String(phaseNumber),
		'mutation-gate.json',
	);
	const mutationGateLocation = `.swarm/evidence/${phaseNumber}/mutation-gate.json`;
	try {
		const parsed = JSON.parse(readFileSync(mutationGatePath, 'utf8')) as {
			entries?: Array<{ type?: string; verdict?: string }>;
		};
		const entry = parsed.entries?.find(
			(candidate) => candidate.type === 'mutation-gate',
		);
		if (!entry) {
			return mutationFinding(
				'HIGH',
				mutationGateLocation,
				'Mutation gate evidence is missing a mutation-gate entry.',
			);
		}
		if (entry.verdict === 'skip') {
			return mutationFinding(
				'MEDIUM',
				mutationGateLocation,
				'Mutation testing was skipped.',
			);
		}
		if (entry.verdict === 'warn') {
			return mutationFinding(
				'LOW',
				mutationGateLocation,
				'Mutation gate reported WARN.',
			);
		}
		if (entry.verdict === 'fail') {
			return mutationFinding(
				'HIGH',
				mutationGateLocation,
				'Mutation gate reported FAIL.',
			);
		}
		return null;
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
		return mutationFinding(
			missing ? 'HIGH' : 'MEDIUM',
			mutationGateLocation,
			missing
				? 'Mutation gate evidence is missing.'
				: 'Mutation gate evidence could not be read.',
			error instanceof Error ? error.message : String(error),
		);
	}
}

function mutationFinding(
	severity: CouncilFinding['severity'],
	location: string,
	detail: string,
	evidence = detail,
): CouncilFinding {
	return { severity, category: 'mutation_gap', location, detail, evidence };
}

function addMutationGapFindingToSynthesis(
	synthesis: PhaseCouncilSynthesis,
	finding: CouncilFinding,
): void {
	if (['CRITICAL', 'HIGH', 'MEDIUM'].includes(finding.severity)) {
		synthesis.requiredFixes.push(finding);
	} else {
		synthesis.advisoryFindings.push(finding);
	}
	synthesis.unifiedFeedbackMd += `\n\n### Mutation Coverage Gap\n- **[${finding.severity}]** \`${finding.location}\` (${finding.category}) — ${finding.detail}\n  _Evidence:_ ${finding.evidence}`;
}
