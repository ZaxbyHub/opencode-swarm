/**
 * General Council Mode — architect-only synthesis tool.
 *
 * The architect spawns council_generalist / council_skeptic /
 * council_domain_expert subagents in parallel for Round 1, collects their
 * JSON responses, and calls this tool to synthesize results. If the tool
 * detects disagreements and Round 2 deliberation is configured, the
 * architect re-delegates to disputing members and calls this tool again
 * with both round1Responses and round2Responses populated.
 *
 * Mirrors the convene-council.ts skeleton but explicitly does NOT inherit
 * the QA-council-only constraints:
 *   - agent: enum (replaced with memberId: string — general-council member
 *     IDs are user-configured, not a fixed enum)
 *   - verdicts.min(1).max(5) (replaced with round1Responses.min(1) — no upper
 *     cap; member count is per-config)
 *   - taskId regex (dropped — general council has no taskId)
 *   - readCriteria(workingDir, taskId) (dropped — general council has no
 *     pre-declared criteria store)
 *   - requireAllMembers < 5 check (dropped — not applicable)
 *
 * Evidence path is .swarm/council/general/ (subdirectory; never writes to
 * .swarm/council/ root, where the QA council stores its files).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { pushGeneralCouncilAdvisory } from '../council/general-council-advisory';
import { synthesizeGeneralCouncil } from '../council/general-council-service';
import type {
	GeneralCouncilDeliberationResponse,
	GeneralCouncilMemberResponse,
} from '../council/general-council-types';
import { getAgentSession } from '../state';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const WebSearchResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	snippet: z.string(),
	query: z.string(),
});

const MemberRoleEnum = z.enum([
	'generalist',
	'skeptic',
	'domain_expert',
	'devil_advocate',
	'synthesizer',
]);

const Round1ResponseSchema = z.object({
	memberId: z.string().min(1),
	model: z.string().min(1),
	role: MemberRoleEnum,
	response: z.string(),
	sources: z.array(WebSearchResultSchema).default([]),
	searchQueries: z.array(z.string()).default([]),
	confidence: z.number().min(0).max(1),
	areasOfUncertainty: z.array(z.string()).default([]),
	durationMs: z.number().nonnegative().default(0),
});

const Round2ResponseSchema = Round1ResponseSchema.extend({
	disagreementTopics: z.array(z.string()).default([]),
});

const ArgsSchema = z.object({
	question: z.string().min(1).max(8000),
	mode: z.enum(['general', 'spec_review']).default('general'),
	members: z.array(z.string()).default([]),
	round1Responses: z.array(Round1ResponseSchema).min(1),
	round2Responses: z.array(Round2ResponseSchema).optional(),
	working_directory: z.string().optional(),
});

interface ConveneOk {
	success: true;
	question: string;
	mode: 'general' | 'spec_review';
	roundsCompleted: 1 | 2;
	consensusPoints: string[];
	disagreementsCount: number;
	persistingDisagreements: string[];
	allSourcesCount: number;
	synthesis: string;
	evidencePath: string;
}

interface ConveneFail {
	success: false;
	reason: string;
	message: string;
}

export const convene_general_council: ReturnType<typeof tool> = createSwarmTool(
	{
		description:
			'Synthesize responses from a multi-model General Council. Accepts parallel member ' +
			'responses (Round 1, optionally Round 2), detects disagreements, and returns ' +
			'consensus points, persisting disagreements, and a structured synthesis. ' +
			'Architect-only. Config-gated on council.general.enabled.',
		args: {
			question: z
				.string()
				.min(1)
				.max(8000)
				.describe(
					'The question put to the council, or the spec text to review.',
				),
			mode: z
				.enum(['general', 'spec_review'])
				.optional()
				.describe(
					'"general" for /swarm council; "spec_review" for SPECIFY-COUNCIL-REVIEW gate.',
				),
			members: z
				.array(z.string())
				.optional()
				.describe('Optional list of member IDs convened (for evidence/audit).'),
			round1Responses: z
				.array(
					z.object({
						memberId: z.string().min(1),
						model: z.string().min(1),
						role: z.enum([
							'generalist',
							'skeptic',
							'domain_expert',
							'devil_advocate',
							'synthesizer',
						]),
						response: z.string(),
						sources: z
							.array(
								z.object({
									title: z.string(),
									url: z.string(),
									snippet: z.string(),
									query: z.string(),
								}),
							)
							.optional(),
						searchQueries: z.array(z.string()).optional(),
						confidence: z.number().min(0).max(1),
						areasOfUncertainty: z.array(z.string()).optional(),
						durationMs: z.number().nonnegative().optional(),
					}),
				)
				.describe('Round 1 member responses (one per council member).'),
			round2Responses: z
				.array(
					z.object({
						memberId: z.string().min(1),
						model: z.string().min(1),
						role: z.enum([
							'generalist',
							'skeptic',
							'domain_expert',
							'devil_advocate',
							'synthesizer',
						]),
						response: z.string(),
						sources: z
							.array(
								z.object({
									title: z.string(),
									url: z.string(),
									snippet: z.string(),
									query: z.string(),
								}),
							)
							.optional(),
						searchQueries: z.array(z.string()).optional(),
						confidence: z.number().min(0).max(1),
						areasOfUncertainty: z.array(z.string()).optional(),
						durationMs: z.number().nonnegative().optional(),
						disagreementTopics: z.array(z.string()).optional(),
					}),
				)
				.optional()
				.describe(
					'Round 2 deliberation responses (omit when no deliberation has occurred).',
				),
			working_directory: z
				.string()
				.optional()
				.describe('Project root for config + evidence path resolution.'),
		},
		execute: async (args, directory, ctx) => {
			// ── Validate args ─────────────────────────────────────────────────
			const parsed = ArgsSchema.safeParse(args);
			if (!parsed.success) {
				const fail: ConveneFail = {
					success: false,
					reason: 'invalid_args',
					message: parsed.error.issues
						.map((i) => `${i.path.join('.')}: ${i.message}`)
						.join('; '),
				};
				return JSON.stringify(fail, null, 2);
			}
			const input = parsed.data;

			// ── Resolve working directory ─────────────────────────────────────
			const dirResult = resolveWorkingDirectory(
				input.working_directory,
				directory,
			);
			if (!dirResult.success) {
				const fail: ConveneFail = {
					success: false,
					reason: 'invalid_working_directory',
					message: dirResult.message,
				};
				return JSON.stringify(fail, null, 2);
			}
			const workingDir = dirResult.directory;

			// ── Config gate ───────────────────────────────────────────────────
			const config = loadPluginConfig(workingDir);
			const generalConfig = config.council?.general;
			if (!generalConfig || generalConfig.enabled !== true) {
				const fail: ConveneFail = {
					success: false,
					reason: 'council_general_disabled',
					message:
						'convene_general_council requires council.general.enabled: true in opencode-swarm.json.',
				};
				return JSON.stringify(fail, null, 2);
			}

			// ── Synthesis (pure) ──────────────────────────────────────────────
			const round1 = input.round1Responses as GeneralCouncilMemberResponse[];
			const round2 = (input.round2Responses ??
				[]) as GeneralCouncilDeliberationResponse[];

			const result = synthesizeGeneralCouncil(
				input.question,
				input.mode,
				round1,
				round2,
			);

			// ── Evidence write to .swarm/council/general/ ─────────────────────
			const evidenceDir = path.join(workingDir, '.swarm', 'council', 'general');
			const safeTimestamp = result.timestamp.replace(/[:.]/g, '-');
			const evidenceFile = `${safeTimestamp}-${input.mode}.json`;
			const evidencePath = path.join(evidenceDir, evidenceFile);
			try {
				await fs.promises.mkdir(evidenceDir, { recursive: true });
				await fs.promises.writeFile(
					evidencePath,
					JSON.stringify(result, null, 2),
				);
			} catch (err) {
				// Evidence write is best-effort; surface but do not abort.
				const message = err instanceof Error ? err.message : String(err);
				console.warn(
					`[convene_general_council] Failed to write evidence to ${evidencePath}: ${message}`,
				);
			}

			// ── Advisory push (best-effort) ───────────────────────────────────
			try {
				const sessionID = ctx?.sessionID;
				if (sessionID) {
					const session = getAgentSession(sessionID);
					if (session) {
						pushGeneralCouncilAdvisory(session, result);
					}
				}
			} catch {
				// non-critical
			}

			const ok: ConveneOk = {
				success: true,
				question: input.question,
				mode: input.mode,
				roundsCompleted: round2.length > 0 ? 2 : 1,
				consensusPoints: result.consensusPoints,
				disagreementsCount: result.disagreements.length,
				persistingDisagreements: result.persistingDisagreements,
				allSourcesCount: result.allSources.length,
				synthesis: result.synthesis,
				evidencePath,
			};
			return JSON.stringify(ok, null, 2);
		},
	},
);
