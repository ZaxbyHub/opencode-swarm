/**
 * skill_generate — Compile mature knowledge into a SKILL.md.
 *
 * Modes:
 *   - draft  → writes .swarm/skills/proposals/<slug>.md
 *   - active → writes .opencode/skills/generated/<slug>/SKILL.md and stamps
 *              source knowledge entries with generated_skill_path metadata.
 *
 * Refuses to overwrite a manually edited active SKILL.md unless force=true.
 * Slugs are sanitized; path traversal is rejected at the validator layer.
 */

import { z } from 'zod';
import { generateSkills } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_generate: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Compile mature knowledge entries into a SKILL.md. mode="draft" writes a proposal under .swarm/skills/proposals; mode="active" writes the live skill under .opencode/skills/generated and stamps source entries.',
		args: {
			source_knowledge_ids: z
				.array(z.string())
				.optional()
				.describe(
					'Optional explicit knowledge ids to compile. If omitted, all mature candidates are clustered and emitted.',
				),
			slug: z
				.string()
				.optional()
				.describe(
					'Optional slug for the FIRST cluster. Sanitized; rejected if invalid.',
				),
			mode: z.enum(['draft', 'active']).default('draft'),
			force: z.boolean().optional().default(false),
			evaluate: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'Validate generated skill content against .swarm/skills/evals/<slug> before writing. Default false.',
				),
			min_confidence: z.number().min(0).max(1).optional(),
			min_confirmations: z.number().int().min(1).max(50).optional(),
		},
		execute: async (args: unknown, directory): Promise<string> => {
			const a = (args ?? {}) as {
				mode?: 'draft' | 'active';
				slug?: string;
				source_knowledge_ids?: string[];
				force?: boolean;
				evaluate?: boolean;
				min_confidence?: number;
				min_confirmations?: number;
			};
			const result = await generateSkills({
				directory,
				mode: a.mode ?? 'draft',
				slug: a.slug,
				sourceKnowledgeIds: a.source_knowledge_ids,
				force: a.force ?? false,
				evaluate: a.evaluate ?? false,
				minConfidence: a.min_confidence,
				minConfirmations: a.min_confirmations,
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const _internals: { skill_generate: typeof skill_generate } = {
	skill_generate,
};
