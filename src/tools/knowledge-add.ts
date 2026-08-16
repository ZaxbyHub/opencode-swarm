import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import type { PluginConfig } from '../config/schema.js';
import {
	findActiveSwarmNearDuplicate,
	reinforceSwarmKnowledgeEntry,
} from '../hooks/knowledge-reinforcement.js';
import {
	computeContentHash,
	dedupeCapped,
	findNearDuplicate,
	inferTags,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeCategory,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../hooks/knowledge-types.js';
import {
	appendUnactionable,
	validateActionability,
	validateActionableFields,
	validateLesson,
} from '../hooks/knowledge-validator.js';
import { resolveCohortId } from '../knowledge/cohort-identity.js';
import { resolveWorktreeId } from '../knowledge/worktree-identity.js';
import { loadPlan } from '../plan/manager.js';
import { createSwarmTool } from './create-tool.js';

const VALID_CATEGORIES: KnowledgeCategory[] = [
	'process',
	'architecture',
	'tooling',
	'security',
	'testing',
	'debugging',
	'performance',
	'integration',
	'todo',
	'other',
];

/** Cap shared by the tag list and every actionability array (#1821 Lane 0b). */
const KNOWLEDGE_ADD_FIELD_CAP = 20;

/**
 * Merge caller-supplied tags with the tags inferred from the lesson.
 *
 * Caller tags come FIRST so that when the combined list exceeds the cap,
 * truncation drops inferred tags before it drops user intent. `dedupeCapped`
 * is case-insensitive (first casing wins), so an inferred tag the caller
 * already supplied collapses into the caller's casing instead of duplicating.
 *
 * Hoisted to module scope and exposed via `_test_exports` so this call site is
 * observable on its own: the store write boundary normalizes the same fields,
 * which would otherwise mask a regression here (issue #1821 Lane 0b).
 */
function mergeLessonTags(tagsInput: unknown, lesson: string): string[] {
	return dedupeCapped(
		[...(Array.isArray(tagsInput) ? tagsInput : []), ...inferTags(lesson)],
		{ cap: KNOWLEDGE_ADD_FIELD_CAP },
	);
}

/**
 * Normalize one optional v3 actionability array from untrusted tool input.
 *
 * The `undefined` return is load-bearing: `validateActionableFields` and
 * `validateActionability` distinguish an ABSENT field from an empty one, and
 * JSON.stringify drops an `undefined` value so the persisted record keeps that
 * distinction. Only the inner filter+cap is `dedupeCapped` (#1821 Lane 0b).
 */
function strArray(v: unknown): string[] | undefined {
	return Array.isArray(v)
		? dedupeCapped(v, { cap: KNOWLEDGE_ADD_FIELD_CAP })
		: undefined;
}

export const knowledge_add: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
		description:
			'Store a new lesson in the knowledge base for future reference. The lesson will be available for retrieval via knowledge_recall.',
		args: {
			lesson: z
				.string()
				.min(15)
				.max(280)
				.describe('The lesson to store (15-280 characters)'),
			category: z
				.enum(VALID_CATEGORIES)
				.describe('Knowledge category for the lesson'),
			tags: z
				.array(z.string())
				.optional()
				.describe('Optional tags for better searchability'),
			scope: z
				.string()
				.optional()
				.describe('Scope of the lesson (global or stack:<name>)'),
			applies_to_agents: z
				.array(z.string())
				.optional()
				.describe(
					'Agent roles this lesson applies to (e.g. ["coder"]). REQUIRED (or applies_to_tools) for the lesson to become active.',
				),
			applies_to_tools: z
				.array(z.string())
				.optional()
				.describe(
					'Tool names this lesson applies to (e.g. ["edit","bash"]). REQUIRED (or applies_to_agents) for the lesson to become active.',
				),
			required_actions: z
				.array(z.string())
				.optional()
				.describe(
					'Concrete actions to always take. At least one predicate field (required_actions / forbidden_actions / verification_checks) is REQUIRED for the lesson to become active.',
				),
			forbidden_actions: z
				.array(z.string())
				.optional()
				.describe('Concrete actions to never take.'),
			verification_checks: z
				.array(z.string())
				.optional()
				.describe('Checks a reviewer can run to verify compliance.'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let lessonInput: unknown;
			let categoryInput: unknown;
			let tagsInput: unknown;
			let scopeInput: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					lessonInput = obj.lesson;
					categoryInput = obj.category;
					tagsInput = obj.tags;
					scopeInput = obj.scope;
				}
			} catch {
				// Malicious getter threw
			}

			// Validate lesson
			if (typeof lessonInput !== 'string') {
				return JSON.stringify({
					success: false,
					error: 'lesson must be a string',
				});
			}
			const lesson = lessonInput as string;
			if (lesson.length < 15 || lesson.length > 280) {
				return JSON.stringify({
					success: false,
					error: 'lesson must be between 15 and 280 characters',
				});
			}

			// Validate category
			if (typeof categoryInput !== 'string') {
				return JSON.stringify({
					success: false,
					error: 'category must be a string',
				});
			}
			const category = categoryInput as KnowledgeCategory;
			if (!VALID_CATEGORIES.includes(category)) {
				return JSON.stringify({
					success: false,
					error: `category must be one of: ${VALID_CATEGORIES.join(', ')}`,
				});
			}

			// Parse tags (optional) and merge in the tags inferred from the lesson.
			const tags: string[] = mergeLessonTags(tagsInput, lesson);

			// Parse scope (optional, default to 'global')
			const scope =
				typeof scopeInput === 'string' && scopeInput.length > 0
					? scopeInput
					: 'global';

			// Parse optional v3 actionability fields (Change 4). Untrusted input:
			// shape-validated below via validateActionableFields. See the
			// module-scope `strArray` for the load-bearing `undefined` contract.
			const obj =
				args && typeof args === 'object'
					? (args as Record<string, unknown>)
					: {};
			const actionable = {
				applies_to_agents: strArray(obj.applies_to_agents),
				applies_to_tools: strArray(obj.applies_to_tools),
				required_actions: strArray(obj.required_actions),
				forbidden_actions: strArray(obj.forbidden_actions),
				verification_checks: strArray(obj.verification_checks),
			};
			const shape = validateActionableFields(actionable);
			if (!shape.valid) {
				return JSON.stringify({
					success: false,
					error: `invalid actionability fields: ${shape.errors.join('; ')}`,
				});
			}

			// Derive project_name from plan title
			let project_name = '';
			let phase_number = 1;
			try {
				const plan = await loadPlan(directory);
				project_name = plan?.title ?? '';
				if (typeof plan?.current_phase === 'number') {
					phase_number = plan.current_phase;
				}
			} catch {
				// plan load failure must not prevent knowledge storage
			}

			// #1848 §1: stamp producer provenance + revision + content_hash at
			// creation so the cohort-safe curation policy can make ownership
			// decisions. Best-effort: resolveWorktreeId/resolveCohortId are
			// fail-open (return transient/'unknown' on I/O failure); provenance
			// is stamped as null if either fails, which the policy treats as
			// unknown-owner (protected by default — the creator can still act
			// because it just wrote it; the protection applies to OTHER worktrees).
			let producer: SwarmKnowledgeEntry['producer'] = null;
			try {
				const [worktreeId, cohort] = await Promise.all([
					resolveWorktreeId(directory),
					resolveCohortId(directory),
				]);
				producer = {
					cohort_id: cohort.cohortId,
					worktree_id: worktreeId,
				};
			} catch {
				/* fail-open: null producer → unknown-owner (protected by policy) */
			}

			// Construct the entry
			const nowIso = new Date().toISOString();
			const entry: SwarmKnowledgeEntry = {
				id: randomUUID(),
				tier: 'swarm',
				lesson,
				category,
				tags,
				scope,
				confidence: 0.5,
				status: 'candidate',
				confirmed_by: [],
				project_name,
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: KNOWLEDGE_SCHEMA_VERSION,
				producer,
				revision: 1,
				content_hash: computeContentHash(lesson),
				created_at: nowIso,
				updated_at: nowIso,
				auto_generated: false,
				hive_eligible: false,
				...actionable,
			};

			// Load config for validation and dedup threshold
			let config: PluginConfig | undefined;
			let dedupThreshold = 0.6; // default
			try {
				const loaded = loadPluginConfigWithMeta(directory);
				config = loaded.config;
				dedupThreshold = config.knowledge?.dedup_threshold ?? 0.6;

				// Validate lesson if validation_enabled is set in config
				if (config.knowledge?.validation_enabled !== false) {
					const validation = validateLesson(lesson, [], {
						category,
						scope,
						confidence: 0.5,
					});
					if (!validation.valid) {
						return JSON.stringify({
							success: false,
							error: `Validation failed: ${validation.reason}`,
						});
					}
				}
			} catch {
				// Config load failure should not block knowledge storage
			}

			// Layer-5 actionability gate (Change 4): a lesson without >=1 predicate
			// AND >=1 scope tag is quarantined to the unactionable queue (recoverable
			// by the hardening loop) rather than activated. The caller gets a hint
			// so it can immediately retry with the missing fields.
			const actionability = validateActionability(entry);
			if (!actionability.actionable) {
				try {
					await appendUnactionable(
						directory,
						entry,
						actionability.reason ?? 'unactionable',
					);
				} catch {
					// queue write is best-effort; the entry is still withheld
				}
				return JSON.stringify({
					success: false,
					quarantined: true,
					id: entry.id,
					reason: actionability.reason,
					hint: 'Provide at least one of required_actions/forbidden_actions/verification_checks AND at least one of applies_to_agents/applies_to_tools, then retry.',
				});
			}

			// Append or reinforce under the knowledge lock. Near-duplicate matches
			// against active entries are confirmations, not failures.
			try {
				const maxEntries = config?.knowledge?.swarm_max_entries ?? 100;
				let duplicateResponse:
					| {
							id: string;
							reinforced: boolean;
							idempotent: boolean;
							inactive: boolean;
					  }
					| undefined;

				await transactKnowledge<SwarmKnowledgeEntry>(
					resolveSwarmKnowledgePath(directory),
					(existingEntries) => {
						const activeDuplicate = findActiveSwarmNearDuplicate(
							lesson,
							existingEntries,
							dedupThreshold,
						);
						if (activeDuplicate) {
							const result = reinforceSwarmKnowledgeEntry(activeDuplicate, {
								phase_number,
								confirmed_at: new Date().toISOString(),
								project_name,
							});
							duplicateResponse = {
								id: activeDuplicate.id,
								reinforced: result.reinforced,
								idempotent: result.reason === 'already_confirmed_phase',
								inactive: false,
							};
							return result.reinforced ? existingEntries : null;
						}

						const inactiveDuplicate = findNearDuplicate(
							lesson,
							existingEntries,
							dedupThreshold,
						);
						if (inactiveDuplicate) {
							duplicateResponse = {
								id: inactiveDuplicate.id,
								reinforced: false,
								idempotent: false,
								inactive: true,
							};
							return null;
						}

						const updated = [...existingEntries, entry];
						if (updated.length > maxEntries) {
							return updated.slice(updated.length - maxEntries);
						}
						return updated;
					},
				);

				if (duplicateResponse) {
					if (duplicateResponse.inactive) {
						return JSON.stringify({
							success: false,
							id: duplicateResponse.id,
							message: 'near-duplicate of inactive existing entry',
						});
					}

					return JSON.stringify({
						success: true,
						id: duplicateResponse.id,
						reinforced: duplicateResponse.reinforced,
						idempotent: duplicateResponse.idempotent,
						message: duplicateResponse.reinforced
							? 'near-duplicate reinforced existing entry'
							: 'near-duplicate already confirmed for this phase',
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: message,
				});
			}

			return JSON.stringify({
				success: true,
				id: entry.id,
				category,
			});
		},
	});

/**
 * Tier-0 test seam (issue #1821 Lane 0b). These are pure functions with no I/O.
 * They are exported so the call-site normalization can be asserted directly:
 * the store write boundary normalizes the same fields with the same semantics,
 * so an assertion made against a PERSISTED entry cannot distinguish "call site
 * fixed" from "call site reverted".
 */
export const _test_exports = { mergeLessonTags, strArray };
