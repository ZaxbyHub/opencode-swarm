/**
 * write_architecture_supervisor_evidence — persists the architecture-supervisor critic's
 * verdict for a phase (issue #893, Chunk C). The architect dispatches
 * critic_architecture_supervisor, collects its structured JSON verdict, then calls this
 * tool to write the raw sidecar that the phase-complete gate (Chunk D) reads.
 *
 * Mirrors write_drift_evidence / submit_phase_council_verdicts: the tool persists only —
 * it does not contact the supervisor.
 */

import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	KnowledgeConfigSchema,
	SkillImproverConfigSchema,
} from '../config/schema';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator';
import { generateSkills } from '../services/skill-generator';
import {
	type ArchitectureSupervisorReport,
	SUMMARY_SCHEMA_VERSION,
} from '../summaries/schema';
import { writeSupervisorReport } from '../summaries/store';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const FindingSchema = z.object({
	severity: z.enum(['low', 'medium', 'high', 'critical']),
	category: z.string().min(1),
	agents: z.array(z.string().min(1)).default([]),
	tasks: z.array(z.string().min(1)).default([]),
	evidence_refs: z.array(z.string().min(1)).default([]),
	description: z.string().min(1),
	recommendation: z.string().default(''),
});

const KnowledgeRecommendationSchema = z.object({
	lesson: z.string().min(1),
	target_agents: z.array(z.string().min(1)).default([]),
	confidence: z.number().min(0).max(1).default(0.5),
	evidence_refs: z.array(z.string().min(1)).default([]),
});

const ArgsSchema = z.object({
	phase: z.number().int().min(0).max(999),
	verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
	findings: z.array(FindingSchema).default([]),
	knowledge_recommendations: z.array(KnowledgeRecommendationSchema).default([]),
	working_directory: z.string().optional(),
});

export const write_architecture_supervisor_evidence: ReturnType<typeof tool> =
	createSwarmTool({
		description:
			'Persist the architecture supervisor verdict for a phase. PREREQUISITE: dispatch ' +
			'critic_architecture_supervisor as an Agent task with the phase + agent summaries, ' +
			'collect its strict-JSON verdict (verdict/findings/knowledge_recommendations), then ' +
			'call this tool with those values. Writes .swarm/evidence/{phase}/' +
			'architecture-supervisor.json. This tool persists only — it does not contact the ' +
			'supervisor. Architect-only; config-gated via architectural_supervision.enabled.',
		args: {
			phase: z
				.number()
				.int()
				.min(0)
				.max(999)
				.describe('Phase number being reviewed.'),
			verdict: z
				.enum(['APPROVE', 'CONCERNS', 'REJECT'])
				.describe('Supervisor verdict.'),
			findings: z
				.array(FindingSchema)
				.optional()
				.describe('System-level findings from the supervisor.'),
			knowledge_recommendations: z
				.array(KnowledgeRecommendationSchema)
				.optional()
				.describe('Durable lessons proposed by the supervisor.'),
			working_directory: z.string().optional(),
		},
		execute: async (rawArgs: unknown, directory: string): Promise<string> => {
			const parsed = ArgsSchema.safeParse(rawArgs);
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
			const args = parsed.data;
			const dirResult = resolveWorkingDirectory(
				args.working_directory,
				directory,
			);
			if (!dirResult.success) {
				return JSON.stringify(
					{ success: false, reason: dirResult.message },
					null,
					2,
				);
			}

			const report: ArchitectureSupervisorReport = {
				schema_version: SUMMARY_SCHEMA_VERSION,
				phase: args.phase,
				verdict: args.verdict,
				findings: args.findings,
				knowledge_recommendations: args.knowledge_recommendations,
				created_at: new Date().toISOString(),
			};

			const evidencePath = writeSupervisorReport(dirResult.directory, report);

			// Propose-only knowledge feedback (issue #893, Chunk E): when enabled, route the
			// supervisor's knowledge recommendations into the swarm knowledge store as
			// candidates — WITHOUT auto-promotion, so this never promotes unrelated
			// pre-existing candidates as a side effect.
			let knowledgeProposed = 0;
			let knowledgeQuarantined = 0;
			try {
				const config = loadPluginConfig(dirResult.directory);
				if (
					config.architectural_supervision?.persist_knowledge_recommendations &&
					args.knowledge_recommendations.length > 0
				) {
					const knowledgeConfig = KnowledgeConfigSchema.parse(
						config.knowledge ?? {},
					);
					const lessons = args.knowledge_recommendations.map((r) => r.lesson);
					// Change 4 (Task 4.2): proposals must pass the Layer-5 actionability
					// gate. Provide the curator LLM delegate to enrich prose lessons with
					// v3 fields; lessons that cannot be enriched are quarantined to the
					// unactionable queue (recoverable by the hardening loop), not stored.
					const skillImproverCfg = SkillImproverConfigSchema.parse(
						config.skill_improver ?? {},
					);
					const result = await curateAndStoreSwarm(
						lessons,
						path.basename(dirResult.directory),
						{ phase_number: args.phase },
						dirResult.directory,
						knowledgeConfig,
						{
							skipAutoPromotion: true,
							llmDelegate: createCuratorLLMDelegate(
								dirResult.directory,
								'phase',
							),
							enrichmentQuota: {
								maxCalls: skillImproverCfg.max_calls_per_day,
								window: skillImproverCfg.quota_window,
							},
						},
					);
					knowledgeProposed = result.stored;
					knowledgeQuarantined = result.quarantined;
				}
			} catch {
				// knowledge feedback is best-effort; never fail the evidence write
			}

			// Skill-draft feedback (issue #893, Chunk E): a repeated failure loop is a
			// strong signal that a durable skill is missing. When the supervisor reports a
			// failure_loop finding and feedback is enabled, attempt a DRAFT skill-generation
			// pass (proposals only, never active). No-ops when no mature cluster exists.
			// NOTE: the failure_loop finding is only the TRIGGER — generateSkills clusters
			// all mature candidate knowledge, so a produced draft may not correspond 1:1 to
			// the specific loop. That looseness is acceptable here: drafts are reviewed by a
			// human before activation, and crystallizing any mature lesson is the goal.
			let skillsProposed = 0;
			try {
				const config = loadPluginConfig(dirResult.directory);
				const hasFailureLoop = args.findings.some(
					(f) => f.category === 'failure_loop',
				);
				if (
					config.architectural_supervision?.persist_knowledge_recommendations &&
					hasFailureLoop
				) {
					const result = await generateSkills({
						directory: dirResult.directory,
						mode: 'draft',
					});
					skillsProposed = result.written.length;
				}
			} catch {
				// skill-draft generation is best-effort; never fail the evidence write
			}

			return JSON.stringify(
				{
					success: true,
					phase: args.phase,
					verdict: args.verdict,
					findings_count: args.findings.length,
					knowledge_proposed: knowledgeProposed,
					knowledge_quarantined: knowledgeQuarantined,
					skills_proposed: skillsProposed,
					evidence_path: evidencePath,
				},
				null,
				2,
			);
		},
	});
