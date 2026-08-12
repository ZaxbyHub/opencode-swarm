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

// ─── Shared validation + write pipeline ─────────────────────────────

export interface ApplyKnowledgeOptions {
	tags?: string[];
	scope?: string;
	applies_to_agents?: string[];
	applies_to_tools?: string[];
	required_actions?: string[];
	forbidden_actions?: string[];
	verification_checks?: string[];
	auto_generated?: boolean;
	project_name?: string;
	phase_number?: number;
	confidence?: number;
}

export interface ApplyKnowledgeResult {
	success: boolean;
	entry?: SwarmKnowledgeEntry;
	reason?: string;
	quarantined?: boolean;
	hint?: string;
	duplicateId?: string;
	reinforced?: boolean;
	idempotent?: boolean;
	inactiveDuplicate?: boolean;
}

/**
 * Canonical knowledge_add validation + write pipeline.
 *
 * Shared by the `knowledge_add` tool handler and the `--apply` flag handler
 * in close.ts so both paths run the same validation: lesson length (15-280),
 * actionability quarantine check, near-duplicate detection, provenance/content
 * hash, capacity enforcement, and atomic transactKnowledge write.
 *
 * Returns a structured result so the caller can format the appropriate
 * user-facing message without re-implementing validation logic.
 */
export async function applyKnowledgeEntry(
	directory: string,
	lesson: string,
	category: KnowledgeCategory,
	options: ApplyKnowledgeOptions = {},
): Promise<ApplyKnowledgeResult> {
	// 1. Validate lesson length
	if (lesson.length < 15) {
		return {
			success: false,
			reason: `lesson must be between 15 and 280 characters (got ${lesson.length})`,
		};
	}
	if (lesson.length > 280) {
		return {
			success: false,
			reason: `lesson must be between 15 and 280 characters (got ${lesson.length})`,
		};
	}

	// 2. Validate category
	if (!VALID_CATEGORIES.includes(category)) {
		return {
			success: false,
			reason: `category must be one of: ${VALID_CATEGORIES.join(', ')}`,
		};
	}

	// 3. Parse tags and merge with inferred tags
	const tags = mergeLessonTags(options.tags, lesson);

	// 4. Parse scope
	const scope =
		typeof options.scope === 'string' && options.scope.length > 0
			? options.scope
			: 'global';

	// 5. Parse actionability fields
	const actionable = {
		applies_to_agents: strArray(options.applies_to_agents),
		applies_to_tools: strArray(options.applies_to_tools),
		required_actions: strArray(options.required_actions),
		forbidden_actions: strArray(options.forbidden_actions),
		verification_checks: strArray(options.verification_checks),
	};
	const shape = validateActionableFields(actionable);
	if (!shape.valid) {
		return {
			success: false,
			reason: `invalid actionability fields: ${shape.errors.join('; ')}`,
		};
	}

	// 6. Derive project_name from plan title
	let project_name = options.project_name ?? '';
	let phase_number = options.phase_number ?? 1;
	if (!project_name) {
		try {
			const plan = await loadPlan(directory);
			project_name = plan?.title ?? '';
			if (typeof plan?.current_phase === 'number') {
				phase_number = plan.current_phase;
			}
		} catch {
			// plan load failure must not prevent knowledge storage
		}
	}

	// 7. Provenance + revision + content_hash (fail-open)
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
		/* fail-open: null producer → unknown-owner */
	}

	// 8. Construct the entry
	const nowIso = new Date().toISOString();
	const entry: SwarmKnowledgeEntry = {
		id: randomUUID(),
		tier: 'swarm',
		lesson,
		category,
		tags,
		scope,
		confidence: options.confidence ?? 0.5,
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
		auto_generated: options.auto_generated ?? false,
		hive_eligible: false,
		...actionable,
	};

	// 9. Load config for validation and dedup threshold
	let config: PluginConfig | undefined;
	let dedupThreshold = 0.6;
	try {
		const loaded = loadPluginConfigWithMeta(directory);
		config = loaded.config;
		dedupThreshold = config.knowledge?.dedup_threshold ?? 0.6;

		// Validate lesson if validation_enabled is set
		if (config.knowledge?.validation_enabled !== false) {
			const validation = validateLesson(lesson, [], {
				category,
				scope,
				confidence: entry.confidence,
			});
			if (!validation.valid) {
				return {
					success: false,
					reason: `Validation failed: ${validation.reason}`,
				};
			}
		}
	} catch {
		// Config load failure should not block knowledge storage
	}

	// 10. Actionability quarantine gate
	const actionability = validateActionability(entry);
	if (!actionability.actionable) {
		try {
			await appendUnactionable(
				directory,
				entry,
				actionability.reason ?? 'unactionable',
			);
		} catch {
			// queue write is best-effort
		}
		return {
			success: false,
			quarantined: true,
			entry,
			reason: actionability.reason,
			hint: 'Provide at least one of required_actions/forbidden_actions/verification_checks AND at least one of applies_to_agents/applies_to_tools, then retry.',
		};
	}

	// 11. Near-duplicate check + capacity enforcement + atomic write
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
				return {
					success: false,
					duplicateId: duplicateResponse.id,
					reason: 'near-duplicate of inactive existing entry',
					inactiveDuplicate: true,
				};
			}

			return {
				success: true,
				duplicateId: duplicateResponse.id,
				reinforced: duplicateResponse.reinforced,
				idempotent: duplicateResponse.idempotent,
				reason: duplicateResponse.reinforced
					? 'near-duplicate reinforced existing entry'
					: 'near-duplicate already confirmed for this phase',
			};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return {
			success: false,
			reason: message,
		};
	}

	return { success: true, entry };
}

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

			// Validate lesson is a string
			if (typeof lessonInput !== 'string') {
				return JSON.stringify({
					success: false,
					error: 'lesson must be a string',
				});
			}

			// Validate category is a string
			if (typeof categoryInput !== 'string') {
				return JSON.stringify({
					success: false,
					error: 'category must be a string',
				});
			}

			// Parse optional v3 actionability fields (Change 4). Untrusted input:
			// shape-validated inside applyKnowledgeEntry via validateActionableFields.
			const obj =
				args && typeof args === 'object'
					? (args as Record<string, unknown>)
					: {};

			// Delegate to shared pipeline
			const result = await applyKnowledgeEntry(
				directory,
				lessonInput as string,
				categoryInput as KnowledgeCategory,
				{
					tags: Array.isArray(tagsInput) ? tagsInput : undefined,
					scope:
						typeof scopeInput === 'string' && scopeInput.length > 0
							? scopeInput
							: undefined,
					applies_to_agents: obj.applies_to_agents as string[] | undefined,
					applies_to_tools: obj.applies_to_tools as string[] | undefined,
					required_actions: obj.required_actions as string[] | undefined,
					forbidden_actions: obj.forbidden_actions as string[] | undefined,
					verification_checks: obj.verification_checks as string[] | undefined,
				},
			);

			// Map shared result back to the tool's JSON response shape
			if (!result.success && result.quarantined) {
				return JSON.stringify({
					success: false,
					quarantined: true,
					id: result.entry?.id,
					reason: result.reason,
					hint: result.hint,
				});
			}
			if (!result.success && result.duplicateId && result.inactiveDuplicate) {
				return JSON.stringify({
					success: false,
					id: result.duplicateId,
					message: result.reason,
				});
			}
			if (
				result.success &&
				result.duplicateId &&
				result.reinforced !== undefined
			) {
				return JSON.stringify({
					success: true,
					id: result.duplicateId,
					reinforced: result.reinforced,
					idempotent: result.idempotent,
					message: result.reason,
				});
			}
			if (!result.success) {
				return JSON.stringify({
					success: false,
					error: result.reason,
				});
			}

			return JSON.stringify({
				success: true,
				id: result.entry?.id,
				category: categoryInput as KnowledgeCategory,
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
