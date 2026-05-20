/**
 * Submit Council Verdicts — architect-only tool.
 *
 * Accepts pre-collected parallel verdicts from critic, reviewer, sme,
 * test_engineer, and explorer, then synthesizes them into a veto-aware
 * overall verdict with required fixes and a single unified feedback document.
 *
 * PREREQUISITE: The architect must dispatch each council member as a separate
 * Agent task and collect the resulting CouncilMemberVerdict objects BEFORE
 * calling this tool. This tool performs synthesis only — it does NOT dispatch,
 * invoke, or contact council members.
 *
 * Config-gated (council.enabled must be true) and architect-only via
 * AGENT_TOOL_MAP. Follows the check-gate-status.ts pattern.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { pushCouncilAdvisory } from '../council/council-advisory';
import { writeCouncilEvidence } from '../council/council-evidence-writer';
import { synthesizeCouncilVerdicts } from '../council/council-service';
import { readCriteria } from '../council/criteria-store';
import type { CouncilMemberVerdict } from '../council/types';
import { getAgentSession } from '../state';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

// ============ Internal validation schema ============
// z declares the public args surface for the plugin host.
// We additionally validate with zod for strict runtime safety and clear errors.
const FindingSchema = z.object({
	severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
	category: z.string().min(1),
	location: z.string(),
	detail: z.string(),
	evidence: z.string(),
});

const VerdictSchema = z.object({
	agent: z.enum(['critic', 'reviewer', 'sme', 'test_engineer', 'explorer']),
	verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
	confidence: z.number().min(0).max(1),
	findings: z.array(FindingSchema),
	criteriaAssessed: z.array(z.string()),
	criteriaUnmet: z.array(z.string()),
	durationMs: z.number().nonnegative(),
});

// Task ID pattern matches the canonical STRICT_TASK_ID_PATTERN in src/validation/task-id.ts.
// Leading zeros (e.g., "01.1") are accepted — consistent with the canonical validator.
export const ArgsSchema = z.object({
	taskId: z
		.string()
		.min(1)
		.regex(
			/^\d+\.\d+(\.\d+)*$/,
			'Task ID must be in N.M or N.M.P format (e.g. "1.1")',
		),
	swarmId: z.string().min(1),
	roundNumber: z.number().int().min(1).max(10).default(1),
	verdicts: z.array(VerdictSchema).min(1).max(5),
	working_directory: z.string().optional(),
});

export const submit_council_verdicts: ReturnType<typeof tool> = createSwarmTool(
	{
		description:
			'Submit pre-collected council member verdicts for synthesis. PREREQUISITE — ' +
			'you MUST dispatch each council member (critic, reviewer, sme, test_engineer, ' +
			'explorer) as separate Agent tasks and collect their verdict responses BEFORE ' +
			'calling this tool. This tool performs synthesis only — it does NOT dispatch, ' +
			'invoke, or contact council members. Calling this tool without first ' +
			'collecting real verdicts from dispatched agents constitutes a council bypass. ' +
			'Returns the synthesized verdict, required fixes, and a quorum report showing ' +
			'which members voted and which were absent. Architect-only. Config-gated via ' +
			'council.enabled.',
		args: {
			taskId: z
				.string()
				.min(1)
				.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format')
				.describe('Task ID being evaluated, e.g. "1.1", "1.2.3"'),
			swarmId: z.string().min(1).describe('Swarm identifier, e.g. "mega"'),
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
						confidence: z.number().min(0).max(1),
						findings: z.array(
							z.object({
								severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
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
					'Array of CouncilMemberVerdict objects. Must include between 1 and 5 entries, one per participating member (critic, reviewer, sme, test_engineer, explorer).',
				),
			working_directory: z
				.string()
				.optional()
				.describe(
					'Explicit project root directory. When provided, .swarm/council/ and .swarm/evidence/ are resolved relative to this path instead of the plugin context directory.',
				),
		},
		async execute(
			args: unknown,
			directory: string,
			ctx?: { sessionID?: string },
		): Promise<string> {
			// ── Validate args with zod ─────────────────────────────────────────
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

			// ── Resolve effective working directory ───────────────────────────
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

			// ── Config gate ───────────────────────────────────────────────────
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

			// ── Quorum gate ───────────────────────────────────────────────────
			// requireAllMembers: true wins over minimumMembers. When unset,
			// minimumMembers defaults to 3 — a single-verdict call can no longer
			// synthesize an APPROVE.
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
							`Council quorum not met: ${membersVoted.length} of ${effectiveMinimum} required members provided verdicts. ` +
							`Members voted: [${membersVoted.join(', ')}]. ` +
							`Members absent: [${membersAbsent.join(', ')}]. ` +
							`Dispatch the absent council members as Agent tasks and collect their verdicts before calling submit_council_verdicts.`,
						membersVoted,
						membersAbsent,
						quorumRequired: effectiveMinimum,
					},
					null,
					2,
				);
			}

			// ── Council evaluation ────────────────────────────────────────────
			const criteria = readCriteria(workingDir, input.taskId);
			const verdicts = input.verdicts as CouncilMemberVerdict[];
			const synthesis = synthesizeCouncilVerdicts(
				input.taskId,
				input.swarmId,
				verdicts,
				criteria,
				input.roundNumber,
				config.council,
			);

			// ── Evidence write ────────────────────────────────────────────────
			writeCouncilEvidence(workingDir, synthesis);

			// ── Architect self-echo advisory ──────────────────────────────────
			// When the tool is invoked inside an architect session, push the
			// unified feedback into the session's pending advisory queue so the
			// next messagesTransform surfaces it as an [ADVISORIES] block. This
			// is best-effort: missing sessionID, session not found, or a thrown
			// error all silently skip — the advisory is never critical-path.
			try {
				const sessionID = ctx?.sessionID;
				if (sessionID) {
					const session = getAgentSession(sessionID);
					if (session) {
						pushCouncilAdvisory(session, synthesis);
					}
				}
			} catch {
				// Advisory delivery is non-critical; never propagate.
			}

			return JSON.stringify(
				{
					success: true,
					overallVerdict: synthesis.overallVerdict,
					vetoedBy: synthesis.vetoedBy,
					roundNumber: synthesis.roundNumber,
					allCriteriaMet: synthesis.allCriteriaMet,
					requiredFixesCount: synthesis.requiredFixes.length,
					advisoryFindingsCount: synthesis.advisoryFindings.length,
					unresolvedConflictsCount: synthesis.unresolvedConflicts.length,
					// Quorum report — anti-hallucination signal. If membersAbsent is
					// non-empty, the architect cannot legitimately claim "Council
					// APPROVED unanimously".
					membersVoted,
					membersAbsent,
					quorumSize: membersVoted.length,
					quorumMet: true,
					unifiedFeedbackMd: synthesis.unifiedFeedbackMd,
				},
				null,
				2,
			);
		},
	},
);
