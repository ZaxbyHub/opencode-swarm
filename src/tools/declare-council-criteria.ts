/**
 * Work Complete Council — pre-declaration tool.
 *
 * Lets the architect declare acceptance criteria at plan time, before the
 * coder starts work. Criteria are persisted to .swarm/council/{safeId}.json
 * and later read back during council evaluation (submit_council_verdicts) so that
 * reviewers assess a stable, pre-committed contract rather than whatever
 * criteria happen to be invented at review time.
 *
 * Config-gated (council.enabled must be true) and architect-only via
 * AGENT_TOOL_MAP. Follows the convene-council.ts pattern.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { readCriteria, writeCriteria } from '../council/criteria-store';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

// ============ Internal validation schema ============
// z declares the public args surface for the plugin host.
// We additionally validate with zod for strict runtime safety and clear errors.
const CriteriaItemSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(20)
		.regex(/^C\d+$/, 'Criterion id must match C\\d+ (e.g. "C1", "C12")'),
	description: z.string().min(10).max(500),
	mandatory: z.boolean(),
});

// Task ID pattern matches the canonical STRICT_TASK_ID_PATTERN in src/validation/task-id.ts.
// Leading zeros (e.g., "01.1") are accepted — consistent with the canonical validator.
const ArgsSchema = z.object({
	taskId: z
		.string()
		.min(1)
		.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format'),
	criteria: z.array(CriteriaItemSchema).min(1).max(20),
	working_directory: z.string().optional(),
});

export const declare_council_criteria: ReturnType<typeof tool> =
	createSwarmTool({
		description:
			'Pre-declare acceptance criteria for a task before the coder starts work. ' +
			'Criteria are persisted under .swarm/council/ and read back during council ' +
			'evaluation so reviewers assess a stable, pre-committed contract. ' +
			'Architect-only. Config-gated via council.enabled.',
		args: {
			taskId: z
				.string()
				.min(1)
				.regex(/^\d+\.\d+(\.\d+)*$/, 'Task ID must be in N.M or N.M.P format')
				.describe(
					'Task ID for which criteria are declared, e.g. "1.1", "1.2.3"',
				),
			criteria: z
				.array(
					z.object({
						id: z
							.string()
							.min(1)
							.max(20)
							.regex(/^C\d+$/, 'Criterion id must match C\\d+')
							.describe('Criterion identifier, e.g. "C1", "C12"'),
						description: z
							.string()
							.min(10)
							.max(500)
							.describe('Human-readable description of the criterion'),
						mandatory: z
							.boolean()
							.describe(
								'Whether the criterion is mandatory. Mandatory criteria block APPROVE when unmet.',
							),
					}),
				)
				.min(1)
				.max(20)
				.describe(
					'Array of acceptance criteria items. Must contain between 1 and 20 entries with unique ids.',
				),
			working_directory: z
				.string()
				.optional()
				.describe(
					'Explicit project root directory. When provided, .swarm/council/ is resolved relative to this path instead of the plugin context directory.',
				),
		},
		async execute(args: unknown, directory: string): Promise<string> {
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

			// ── Duplicate-id check (defense in depth beyond zod) ──────────────
			const ids = input.criteria.map((c) => c.id);
			const idSet = new Set(ids);
			if (idSet.size < ids.length) {
				const seen = new Set<string>();
				const duplicates: string[] = [];
				for (const id of ids) {
					if (seen.has(id) && !duplicates.includes(id)) {
						duplicates.push(id);
					}
					seen.add(id);
				}
				return JSON.stringify(
					{
						success: false,
						reason: 'duplicate criterion ids',
						errors: duplicates,
					},
					null,
					2,
				);
			}

			// ── Idempotent overwrite detection ────────────────────────────────
			const existing = readCriteria(workingDir, input.taskId);
			const replaced = existing !== null;

			// ── Persist ───────────────────────────────────────────────────────
			writeCriteria(workingDir, input.taskId, input.criteria);

			return JSON.stringify(
				{
					success: true,
					taskId: input.taskId,
					criteriaCount: input.criteria.length,
					mandatoryCount: input.criteria.filter((c) => c.mandatory).length,
					declaredAt: new Date().toISOString(),
					replaced,
				},
				null,
				2,
			);
		},
	});
