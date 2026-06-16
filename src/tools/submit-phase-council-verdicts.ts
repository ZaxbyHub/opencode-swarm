import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { synthesizePhaseCouncilAdvisory } from '../council/council-service';
import type { CouncilFinding, CouncilMemberVerdict } from '../council/types';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const VerdictSchema = z.object({
	agent: z.enum(['critic', 'reviewer', 'sme', 'test_engineer', 'explorer']),
	verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
	verdictRound: z.number().int().min(1).max(10).optional(),
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
			'Submit pre-collected council member verdicts for PHASE-LEVEL synthesis. ' +
			'PREREQUISITE — you MUST dispatch each council member (critic, reviewer, sme, ' +
			'test_engineer, explorer) as separate Agent tasks with PHASE-SCOPED context and ' +
			'collect their verdict responses BEFORE calling this tool. This tool performs ' +
			'synthesis only — it does NOT dispatch, invoke, or contact council members. ' +
			'Writes .swarm/evidence/{phase}/phase-council.json which is required by ' +
			'phase_complete Gate 5 when phase_council is enabled. ' +
			'Architect-only. Config-gated via council.enabled.',
		args: {
			phaseNumber: z
				.number()
				.int()
				.min(1)
				.describe('Phase number being reviewed (e.g. 1, 2, 3)'),
			swarmId: z.string().min(1).describe('Swarm identifier, e.g. "mega"'),
			phaseSummary: z
				.string()
				.min(1)
				.describe('2–4 sentence summary of what the phase accomplished'),
			roundNumber: z
				.number()
				.int()
				.min(1)
				.max(10)
				.optional()
				.describe('1-indexed round number. Defaults to 1.'),
			verdicts: z
				.array(
					z.object({
						agent: z.enum([
							'critic',
							'reviewer',
							'sme',
							'test_engineer',
							'explorer',
						]),
						verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
						verdictRound: z.number().int().min(1).max(10).optional(),
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
						durationMs: z.number(),
					}),
				)
				.min(1)
				.max(5)
				.describe(
					'Collected CouncilMemberVerdict objects from all dispatched council members',
				),
			working_directory: z
				.string()
				.optional()
				.describe('Working directory where the plan is located'),
			provenanceAgentName: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Agent name that produced this evidence (optional provenance)',
				),
			provenanceSessionId: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Session ID of the agent that produced this evidence (optional provenance)',
				),
		},
		async execute(args: unknown, directory: string): Promise<string> {
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

			const dirResult = resolveWorkingDirectory(
				input.working_directory,
				directory,
			);
			if (!dirResult.success) {
				return JSON.stringify(
					{ success: false, reason: dirResult.message },
					null,
					2,
				);
			}
			const workingDir = dirResult.directory;

			const config = loadPluginConfig(workingDir);
			if (!config.council?.enabled) {
				return JSON.stringify(
					{
						success: false,
						reason:
							'council feature is disabled — set council.enabled: true in .opencode/opencode-swarm.json to enable',
					},
					null,
					2,
				);
			}

			const effectiveMinimum = config.council?.requireAllMembers
				? 5
				: (config.council?.minimumMembers ?? 3);
			const ALL_MEMBERS = [
				'critic',
				'reviewer',
				'sme',
				'test_engineer',
				'explorer',
			] as const;
			const distinctMembers = new Set<(typeof ALL_MEMBERS)[number]>(
				input.verdicts.map((v) => v.agent),
			);
			const membersVoted = [...distinctMembers];
			const membersAbsent = ALL_MEMBERS.filter((m) => !distinctMembers.has(m));

			if (membersVoted.length < effectiveMinimum) {
				return JSON.stringify(
					{
						success: false,
						reason: 'insufficient_quorum',
						message:
							`Phase council quorum not met: ${membersVoted.length} of ${effectiveMinimum} required members provided verdicts. ` +
							`Members voted: [${membersVoted.join(', ')}]. ` +
							`Members absent: [${membersAbsent.join(', ')}]. ` +
							`Dispatch the absent council members with phase-scoped context and collect their verdicts before calling submit_phase_council_verdicts.`,
						membersVoted,
						membersAbsent,
						quorumRequired: effectiveMinimum,
					},
					null,
					2,
				);
			}

			const staleVerdicts =
				(input.roundNumber ?? 1) > 1
					? input.verdicts.filter(
							(v) => (v.verdictRound ?? 1) < (input.roundNumber ?? 1),
						)
					: [];
			if (staleVerdicts.length > 0) {
				return JSON.stringify(
					{
						success: false,
						reason: 'stale_verdict_detected',
						message:
							`Round ${input.roundNumber ?? 1} requires fresh verdicts. ` +
							'One or more submitted verdicts are from an older round.',
						staleVerdicts: staleVerdicts.map((v) => ({
							agent: v.agent,
							verdictRound: v.verdictRound,
						})),
					},
					null,
					2,
				);
			}

			const synthesis = synthesizePhaseCouncilAdvisory(
				input.phaseNumber,
				input.phaseSummary,
				input.verdicts as CouncilMemberVerdict[],
				input.roundNumber ?? 1,
				config.council,
				workingDir,
			);
			const existingMutationGapFinding = input.verdicts.some((verdict) =>
				verdict.findings.some((finding) => finding.category === 'mutation_gap'),
			);
			const mutationGapFinding = existingMutationGapFinding
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

			// ── Blocking concerns gate ────────────────────────────────────────────────────────────
			// Block whenever blockingConcernsCount > 0 regardless of overall verdict:
			// HIGH/CRITICAL mutation gap findings are injected above and can exist
			// even on an APPROVE verdict — evidence must not be written in that case.
			if (synthesis.blockingConcernsCount > 0) {
				return JSON.stringify(
					{
						success: false,
						reason: 'blocking_concerns_unresolved',
						overallVerdict: synthesis.overallVerdict,
						blockingConcernsCount: synthesis.blockingConcernsCount,
						requiredFixes: synthesis.requiredFixes,
						unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
						message: `Phase council returned CONCERNS with ${synthesis.blockingConcernsCount} HIGH/CRITICAL finding(s) promoted to requiredFixes. These must be resolved before the phase can complete. Do NOT write evidence or proceed — address every requiredFix and resubmit.`,
					},
					null,
					2,
				);
			}

			// Capture provenance from args
			const provenance =
				input.provenanceAgentName || input.provenanceSessionId
					? {
							agent_name: input.provenanceAgentName,
							session_id: input.provenanceSessionId,
							captured_at: new Date().toISOString(),
						}
					: undefined;

			writePhaseCouncilEvidence(workingDir, synthesis, provenance);

			return JSON.stringify(
				{
					success: true,
					overallVerdict: synthesis.overallVerdict,
					vetoedBy: synthesis.vetoedBy,
					roundNumber: synthesis.roundNumber,
					allCriteriaMet: synthesis.allCriteriaMet,
					requiredFixesCount: synthesis.requiredFixes?.length ?? 0,
					advisoryFindingsCount: synthesis.advisoryFindings?.length ?? 0,
					unresolvedConflictsCount: synthesis.unresolvedConflicts?.length ?? 0,
					advisoryNotes: synthesis.advisoryNotes ?? [],
					mutationGapEmitted: mutationGapFinding !== null,
					membersVoted,
					membersAbsent,
					quorumSize: membersVoted.length,
					quorumMet: true,
					evidencePath: synthesis.evidencePath,
					unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
				},
				null,
				2,
			);
		},
	});

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
	try {
		const raw = readFileSync(mutationGatePath, 'utf-8');
		const parsed = JSON.parse(raw) as {
			entries?: Array<{
				type?: string;
				verdict?: string;
			}>;
		};
		const gateEntry = (parsed.entries ?? []).find(
			(entry) => entry?.type === 'mutation-gate',
		);
		if (!gateEntry) {
			return {
				severity: 'HIGH',
				category: 'mutation_gap',
				location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
				detail:
					'Mutation gate evidence is missing a mutation-gate entry for this phase.',
				evidence:
					'Expected entries[].type="mutation-gate" with verdict in mutation-gate.json.',
			};
		}
		if (gateEntry.verdict === 'skip') {
			return {
				severity: 'MEDIUM',
				category: 'mutation_gap',
				location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
				detail:
					'Mutation testing was skipped for this phase; coverage is unverified.',
				evidence:
					'mutation-gate.json recorded verdict="skip". Run mutation_test and write_mutation_evidence.',
			};
		}
		if (gateEntry.verdict === 'warn') {
			return {
				severity: 'LOW',
				category: 'mutation_gap',
				location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
				detail:
					'Mutation gate reported WARN; mutation coverage may be insufficient.',
				evidence:
					'mutation-gate.json recorded verdict="warn" indicating below-pass mutation quality.',
			};
		}
		if (gateEntry.verdict === 'fail') {
			return {
				severity: 'HIGH',
				category: 'mutation_gap',
				location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
				detail:
					'Mutation gate reported FAIL; mutation testing quality is below the required threshold.',
				evidence:
					'mutation-gate.json recorded verdict="fail" indicating insufficient mutation kill rate.',
			};
		}
		return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				severity: 'HIGH',
				category: 'mutation_gap',
				location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
				detail:
					'Mutation gate evidence file is missing for this phase, so mutation coverage cannot be verified.',
				evidence:
					'No .swarm/evidence/{phase}/mutation-gate.json was found at council synthesis time.',
			};
		}
		return {
			severity: 'MEDIUM',
			category: 'mutation_gap',
			location: `.swarm/evidence/${phaseNumber}/mutation-gate.json`,
			detail:
				'Mutation gate evidence could not be read, so mutation coverage cannot be verified.',
			evidence: error instanceof Error ? error.message : String(error),
		};
	}
}

function writePhaseCouncilEvidence(
	workingDir: string,
	synthesis: {
		phaseNumber: number;
		timestamp: string;
		overallVerdict: 'APPROVE' | 'CONCERNS' | 'REJECT';
		quorumSize: number;
		phaseSummary?: string;
		requiredFixes: CouncilFinding[];
		advisoryNotes: string[];
		advisoryFindings: CouncilFinding[];
		roundNumber: number;
		allCriteriaMet: boolean;
	},
	provenance?: {
		agent_name?: string;
		session_id?: string;
		captured_at?: string;
	},
): void {
	const evidenceDir = path.join(
		workingDir,
		'.swarm',
		'evidence',
		String(synthesis.phaseNumber),
	);
	mkdirSync(evidenceDir, { recursive: true });
	const evidenceFile = path.join(evidenceDir, 'phase-council.json');
	const evidenceBundle = {
		entries: [
			{
				type: 'phase-council',
				phase_number: synthesis.phaseNumber,
				scope: 'phase',
				timestamp: synthesis.timestamp,
				verdict: synthesis.overallVerdict,
				quorumSize: synthesis.quorumSize,
				phaseSummary: synthesis.phaseSummary ?? '',
				requiredFixes: synthesis.requiredFixes.map((finding) => ({
					severity: finding.severity,
					category: finding.category,
					location: finding.location,
					detail: finding.detail,
					evidence: finding.evidence,
				})),
				advisoryNotes: synthesis.advisoryNotes,
				advisoryFindings: synthesis.advisoryFindings.map((finding) => ({
					severity: finding.severity,
					category: finding.category,
					location: finding.location,
					detail: finding.detail,
					evidence: finding.evidence,
				})),
				roundNumber: synthesis.roundNumber,
				allCriteriaMet: synthesis.allCriteriaMet,
				...(provenance ? { provenance } : {}),
			},
		],
	};

	const tempFile = `${evidenceFile}.tmp-${Date.now()}`;
	try {
		writeFileSync(tempFile, JSON.stringify(evidenceBundle, null, 2), 'utf-8');
		renameSync(tempFile, evidenceFile);
	} finally {
		if (existsSync(tempFile)) {
			unlinkSync(tempFile);
		}
	}
}

function addMutationGapFindingToSynthesis(
	synthesis: {
		requiredFixes: CouncilFinding[];
		advisoryFindings: CouncilFinding[];
		unifiedFeedbackMd: string;
	},
	finding: CouncilFinding,
): void {
	if (
		finding.severity === 'CRITICAL' ||
		finding.severity === 'HIGH' ||
		finding.severity === 'MEDIUM'
	) {
		synthesis.requiredFixes.push(finding);
	} else {
		synthesis.advisoryFindings.push(finding);
	}
	synthesis.unifiedFeedbackMd += formatMutationGapFeedback(finding);
}

function formatMutationGapFeedback(finding: CouncilFinding): string {
	return `\n\n### Mutation Coverage Gap\n- **[${finding.severity}]** \`${finding.location}\` (${finding.category}) — ${finding.detail}\n  _Evidence:_ ${finding.evidence}`;
}
