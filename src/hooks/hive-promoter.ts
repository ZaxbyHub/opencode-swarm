/**
 * Hive promoter for opencode-swarm v6.17 two-tier knowledge system.
 *
 * #1847 (transactional hive promotion): every hive write is routed through ONE
 * global cross-process transaction (`transactHiveStore` in `./hive-transaction`).
 * The transaction holds the hive directory lock across read → normalize →
 * eligibility → canonical-cohort counting → dedup/merge → append/update →
 * source confirmation → cap → staged audit → atomic persist. No caller reads
 * the hive, makes a promotion decision, and later calls a separate unlocked
 * write API.
 *
 * Canonical project identity (#1846): cross-project confirmations key on the
 * canonical `cohort_id` from `resolveCohortId`, not the worktree `project_name`.
 * Sibling worktrees and remote aliases of one repository count as one project.
 *
 * Lineage (#1847 §3): promoted entries retain source entry id, source cohort,
 * promotion event id, and actor. Manual promotion that fails policy proceeds
 * only with an explicit `--force` override that records a durable audit entry;
 * an exact entry id alone is never authorization to bypass policy.
 *
 * This module is NOT imported on the plugin-init path (invariant 1): promotion
 * runs only on the lazy `/swarm promote`, close, curate, and postmortem paths.
 */

import path from 'node:path';
import { appendCuratorRecommendation, readCuratorSummary } from './curator.js';
import {
	evaluatePromotionPolicy,
	describeEligibilityRoute,
	failedGateNames,
} from './hive-policy.js';
import {
	type HiveAuditEntry,
	type HiveMutationOutcome,
	transactHiveStore,
} from './hive-transaction.js';
import { resolveCohortId } from '../knowledge/cohort-identity.js';
import {
	findNearDuplicate,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	wordBigrams,
	jaccardBigram,
} from './knowledge-store.js';
import type {
	CohortIdentity,
} from '../knowledge/cohort-identity.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	ProjectConfirmationRecord,
	PromotionActor,
	PromotionEvidenceRecord,
	PromotionLineage,
	RejectedLesson,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus, KNOWLEDGE_SCHEMA_VERSION } from './knowledge-types.js';
import { validateLesson } from './knowledge-validator.js';
import { safeHook } from './utils.js';
import { KnowledgeConfigSchema } from '../config/schema.js';

/** Carry a swarm entry's actionable-directive metadata onto a promoted hive
 *  entry (Phase 4 review, MEDIUM finding). Dropping these fields on promotion
 *  would strip predicates/scope from cross-project knowledge. */
function carryActionableFields(
	source: SwarmKnowledgeEntry,
): Partial<HiveKnowledgeEntry> {
	const out: Partial<HiveKnowledgeEntry> = {};
	if (source.triggers?.length) out.triggers = [...source.triggers];
	if (source.required_actions?.length)
		out.required_actions = [...source.required_actions];
	if (source.forbidden_actions?.length)
		out.forbidden_actions = [...source.forbidden_actions];
	if (source.verification_checks?.length)
		out.verification_checks = [...source.verification_checks];
	if (source.verification_predicate)
		out.verification_predicate = source.verification_predicate;
	if (source.applies_to_agents?.length)
		out.applies_to_agents = [...source.applies_to_agents];
	if (source.applies_to_tools?.length)
		out.applies_to_tools = [...source.applies_to_tools];
	if (source.directive_priority)
		out.directive_priority = source.directive_priority;
	return out;
}

/** Hive promotion summary for curator state. */
export interface HivePromotionSummary {
	timestamp: string;
	new_promotions: number;
	encounters_incremented: number;
	advancements: number;
	total_hive_entries: number;
	/** #1847: per-entry policy diagnostics for operator visibility. */
	diagnostics?: string[];
}

/**
 * Check whether a swarm entry is eligible for hive promotion via the historical
 * 3 routes. Kept as a thin wrapper delegating to the canonical policy route
 * description (M1 fix, #1847) so existing test consumers
 * (`hive-promoter-inactive.test.ts`, `close.test.ts` mock) keep working.
 *
 * This is ONE of the gates inside {@link evaluatePromotionPolicy}; it is not
 * the whole policy. New callers should use `evaluatePromotionPolicy`.
 */
export function isHiveEligible(
	entry: SwarmKnowledgeEntry,
	autoPromoteDays: number,
): boolean {
	return describeEligibilityRoute(entry, autoPromoteDays).passed;
}

/**
 * Count distinct projects/cohort identities in a hive entry's confirmed_by.
 *
 * #1847: dedup by canonical `cohort_id` (sibling worktrees + remote aliases of
 * one repo count as one project). Legacy records written before #1847 lack
 * `cohort_id`; for those, fall back to `project_name` — but two records sharing
 * a `cohort_id` are NEVER counted as distinct. This means AC3 ("sibling
 * worktrees count as one project") is enforced for confirmations written from
 * this PR forward; legacy confirmations remain `project_name`-keyed and are NOT
 * retroactively re-counted (consistent with the no-broad-rewrite non-goal).
 */
export function countDistinctProjects(
	confirmedBy: ProjectConfirmationRecord[],
): number {
	const cohortIds = new Set<string>();
	const legacyProjectNames = new Set<string>();
	for (const record of confirmedBy) {
		if (typeof record.cohort_id === 'string' && record.cohort_id.length > 0) {
			cohortIds.add(record.cohort_id);
		} else {
			// Legacy record without cohort_id — fall back to project_name.
			legacyProjectNames.add(record.project_name);
		}
	}
	return cohortIds.size + legacyProjectNames.size;
}

/** Check if a project/cohort confirmation already exists. Prefers cohort_id. */
function hasProjectConfirmation(
	hiveEntry: HiveKnowledgeEntry,
	projectName: string,
	cohortId?: string,
): boolean {
	return hiveEntry.confirmed_by.some((record) => {
		if (cohortId && record.cohort_id) {
			return record.cohort_id === cohortId;
		}
		return record.project_name === projectName;
	});
}

/** Calculate the new encounter score after a confirmation (weighted scoring). */
function calculateEncounterScore(
	currentScore: number,
	isSameProject: boolean,
	config: KnowledgeConfig,
): number {
	const weight = isSameProject
		? config.same_project_weight
		: config.cross_project_weight;
	const increment = config.encounter_increment * weight;
	const newScore = currentScore + increment;
	return Math.min(
		Math.max(newScore, config.min_encounter_score),
		config.max_encounter_score,
	);
}

/** Is the source cohort the same as the hive entry's origin cohort? */
function isSameOrigin(
	hiveEntry: HiveKnowledgeEntry,
	sourceCohortId: string,
): boolean {
	// Prefer lineage source_cohort_id; fall back to comparing the first
	// confirmation's cohort_id; lastly compare source_project as a legacy guard.
	if (hiveEntry.lineage?.source_cohort_id) {
		return hiveEntry.lineage.source_cohort_id === sourceCohortId;
	}
	const firstWithCohort = hiveEntry.confirmed_by.find((c) => c.cohort_id);
	if (firstWithCohort) {
		return firstWithCohort.cohort_id === sourceCohortId;
	}
	return false;
}

/** Build a PromotionLineage block for a newly promoted hive entry. */
function buildLineage(args: {
	actor: PromotionActor;
	sourceEntryId?: string;
	sourceCohortId?: string;
	promotionEventId: string;
	reason?: string;
	overrideFailedGates?: string[];
}): PromotionLineage {
	return {
		actor: args.actor,
		source_entry_id: args.sourceEntryId,
		source_cohort_id: args.sourceCohortId,
		promotion_event_id: args.promotionEventId,
		reason: args.reason,
		override_failed_gates: args.overrideFailedGates,
	};
}

/**
 * Main promotion logic: checks swarm entries and promotes eligible ones to hive
 * inside ONE cross-process transaction. Also updates existing hive entries with
 * new canonical-cohort confirmations. Returns a summary for curator state.
 *
 * `directory` is required (#1847) to resolve the canonical cohort identity
 * (#1846) for cross-project distinctness.
 *
 * @note The 'hive-fast-track' tag is privileged — it bypasses the 3-phase
 *   confirmation requirement inside the eligibility_route gate. It should only
 *   be set by authorized tooling (inferTags() never produces it automatically).
 */
export async function checkHivePromotions(
	swarmEntries: SwarmKnowledgeEntry[],
	config: KnowledgeConfig,
	directory: string,
): Promise<HivePromotionSummary> {
	const empty: HivePromotionSummary = {
		timestamp: new Date().toISOString(),
		new_promotions: 0,
		encounters_incremented: 0,
		advancements: 0,
		total_hive_entries: 0,
	};

	if (config.hive_enabled === false) {
		return empty;
	}

	// Resolve the source cohort ONCE, OUTSIDE the transaction. resolveCohortId
	// may issue up to 2 sequential git subprocess calls (~3s worst case); doing
	// this under the directory lock would risk exceeding the 5s stale window.
	// It never throws (path fallback always succeeds).
	const sourceCohort = await _internals.resolveCohortId(directory);

	// Validated terminal-application evidence is empty until #1849 produces real
	// receipts. Loaded outside the lock. Legacy swarm entries get NO synthetic
	// credit — an empty list simply does not add to the count.
	const evidence = await _internals.loadPromotionEvidence(swarmEntries);

	const diagnostics: string[] = [];

	const result = await _internals.transactHiveStore<
		{ newPromotions: number; encounters: number; advancements: number; total: number }
	>(async (ctx) => {
		let newPromotions = 0;
		let encounters = 0;
		let advancements = 0;
		const audit: HiveAuditEntry[] = [];
		const rejects: RejectedLesson[] = [];
		const entries = [...ctx.entries];

		// Precompute hive + swarm bigrams ONCE so the dedup loop is O(n) instead
		// of O(n²) (findNearDuplicate recomputes hive bigrams per call). This
		// keeps the held-lock closure fast enough to stay well under the 5s stale
		// window even for 1000+ entries (#1847 MAJOR-2 / B1).
		const hiveBigrams = entries.map((e) =>
			typeof e.lesson === 'string' ? wordBigrams(e.lesson) : new Set<string>(),
		);
		// Track bigrams of entries added within this run so same-run double-
		// promotion of near-duplicate lessons is also prevented.
		const addedBigrams: Set<string>[] = [];
		const isDuplicateOfAny = (
			lessonBigram: Set<string>,
			threshold: number,
		): boolean => {
			for (const hb of hiveBigrams) {
				if (jaccardBigram(lessonBigram, hb) >= threshold) return true;
			}
			for (const ab of addedBigrams) {
				if (jaccardBigram(lessonBigram, ab) >= threshold) return true;
			}
			return false;
		};

		// 1. New promotions: eligible swarm entries → lineage-bearing hive entries.
		for (const swarmEntry of swarmEntries) {
			// Defensive: skip entries whose lesson is not a usable string. The
			// validator normally rejects these, but a malformed/adversarial entry
			// must never reach the entry-construction / audit-staging code (which
			// assumes a string lesson).
			if (
				typeof swarmEntry.lesson !== 'string' ||
				swarmEntry.lesson.length === 0
			) {
				continue;
			}

			// Dedup against the CURRENT (locked) hive entries (precomputed bigrams).
			const swarmBigram = wordBigrams(swarmEntry.lesson);
			if (isDuplicateOfAny(swarmBigram, config.dedup_threshold)) {
				continue;
			}

			const decision = evaluatePromotionPolicy({
				entry: swarmEntry,
				config,
				evidence: evidence[swarmEntry.id] ?? [],
			});
			if (!decision.eligible) {
				diagnostics.push(
					`skip promote '${swarmEntry.lesson.slice(0, 40)}…': ${decision.reason}`,
				);
				continue;
			}

			// Re-validate before promotion.
			const validationResult = _internals.validateLesson(
				swarmEntry.lesson,
				entries.map((e) => e.lesson),
				{
					category: swarmEntry.category,
					scope: swarmEntry.scope,
					confidence: swarmEntry.confidence,
				},
			);

			if (validationResult.severity === 'error') {
				rejects.push({
					id: crypto.randomUUID(),
					lesson: swarmEntry.lesson,
					rejection_reason:
						validationResult.reason || 'validation failed for hive promotion',
					rejected_at: new Date().toISOString(),
					rejection_layer: validationResult.layer || 2,
				});
				continue;
			}

			const promotionEventId = crypto.randomUUID();
			const newHiveEntry: HiveKnowledgeEntry = {
				id: crypto.randomUUID(),
				tier: 'hive',
				lesson: swarmEntry.lesson,
				category: swarmEntry.category,
				tags: swarmEntry.tags,
				scope: swarmEntry.scope,
				confidence: 0.5, // starts at 0.5 in hive
				status: 'candidate', // ALWAYS candidate on entry
				confirmed_by: [], // empty — no project confirmations yet
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: config.schema_version || KNOWLEDGE_SCHEMA_VERSION,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				source_project: swarmEntry.project_name,
				encounter_score: config.initial_encounter_score,
				lineage: buildLineage({
					actor: 'auto',
					sourceEntryId: swarmEntry.id,
					sourceCohortId: sourceCohort.cohortId,
					promotionEventId,
				}),
				...carryActionableFields(swarmEntry),
			};

			entries.push(newHiveEntry);
			addedBigrams.push(swarmBigram);
			newPromotions++;
			audit.push(
				stagePromotionAudit({
					entryId: newHiveEntry.id,
					lesson: newHiveEntry.lesson,
					actor: 'auto',
					sourceEntryId: swarmEntry.id,
					sourceCohortId: sourceCohort.cohortId,
					promotionEventId,
				}),
			);
		}

		// 2. Existing hive entries: add cross-cohort confirmations.
		// Precompute swarm bigrams once so this loop is O(hive × swarm) without
		// recomputing swarm bigrams per hive entry (keeps the closure fast —
		// #1847 MAJOR-2).
		const activeSwarm = swarmEntries.filter((e) => isActiveStatus(e.status));
		const activeSwarmBigrams = activeSwarm.map((e) =>
			typeof e.lesson === 'string' ? wordBigrams(e.lesson) : new Set<string>(),
		);
		for (const hiveEntry of entries) {
			// Find a near-duplicate swarm entry using precomputed bigrams.
			const hiveBigram =
				typeof hiveEntry.lesson === 'string'
					? wordBigrams(hiveEntry.lesson)
					: new Set<string>();
			let nearDuplicate: SwarmKnowledgeEntry | undefined;
			for (let i = 0; i < activeSwarm.length; i++) {
				if (jaccardBigram(hiveBigram, activeSwarmBigrams[i]) >= config.dedup_threshold) {
					nearDuplicate = activeSwarm[i];
					break;
				}
			}
			if (!nearDuplicate) continue;

			// Do not self-confirm: if this hive entry was just promoted from this
			// very swarm entry in this run, its origin cohort is already implied
			// and should not double-count as a cross-project confirmation. A
			// freshly promoted entry starts with empty confirmed_by and gains
			// confirmations only from OTHER cohorts on subsequent runs.
			if (
				hiveEntry.lineage?.source_entry_id &&
				hiveEntry.lineage.source_entry_id === nearDuplicate.id
			) {
				continue;
			}

			const sameProject = isSameOrigin(hiveEntry, sourceCohort.cohortId);
			if (
				hasProjectConfirmation(
					hiveEntry,
					nearDuplicate.project_name,
					sourceCohort.cohortId,
				)
			) {
				continue;
			}

			const newConfirmation: ProjectConfirmationRecord = {
				project_name: nearDuplicate.project_name,
				cohort_id: sourceCohort.cohortId,
				confirmed_at: new Date().toISOString(),
			};
			hiveEntry.confirmed_by.push(newConfirmation);

			const currentScore = hiveEntry.encounter_score ?? 1.0;
			hiveEntry.encounter_score = calculateEncounterScore(
				currentScore,
				sameProject,
				config,
			);
			encounters++;
			hiveEntry.updated_at = new Date().toISOString();

			if (
				hiveEntry.status === 'candidate' &&
				countDistinctProjects(hiveEntry.confirmed_by) >= 3
			) {
				hiveEntry.status = 'established';
				advancements++;
			}
		}

		const modified =
			newPromotions > 0 || encounters > 0 || advancements > 0;
		// Rejects must be persisted even when nothing else changed — otherwise a
		// batch where every eligible entry failed validation would silently drop
		// the rejection records. Committing rewrites the hive (unchanged content,
		// an atomic no-op write) and appends the staged rejects under the lock.
		if (!modified && rejects.length === 0) {
			return {
				kind: 'noop',
				return: { newPromotions, encounters, advancements, total: entries.length },
			};
		}

		return {
			kind: 'commit',
			entries,
			maxEntries: config.hive_max_entries,
			rejects: rejects.length > 0 ? rejects : undefined,
			audit: audit.length > 0 ? audit : undefined,
			return: { newPromotions, encounters, advancements, total: entries.length },
		};
	});

	return {
		timestamp: new Date().toISOString(),
		new_promotions: result.return.newPromotions,
		encounters_incremented: result.return.encounters,
		advancements: result.return.advancements,
		total_hive_entries: result.return.total,
		diagnostics: [...diagnostics, ...result.diagnostics],
	};
}

/** Build a staged promotion audit line (pre-serialized JSON). */
function stagePromotionAudit(args: {
	entryId: string;
	lesson: string;
	actor: PromotionActor;
	sourceEntryId?: string;
	sourceCohortId?: string;
	promotionEventId: string;
	reason?: string;
	overrideFailedGates?: string[];
}): HiveAuditEntry {
	// Audit-only knowledge event tombstone (AC9 visibility). Shape mirrors the
	// ArchivedEvent family but is a distinct promotion marker. Stored under the
	// hive events log via the transaction's staged audit append.
	const event = {
		type: 'promotion',
		schema_version: 1,
		event_id: args.promotionEventId,
		timestamp: new Date().toISOString(),
		entry_id: args.entryId,
		actor: args.actor,
		reason: args.reason,
		source_entry_id: args.sourceEntryId,
		source_cohort_id: args.sourceCohortId,
		override_failed_gates: args.overrideFailedGates,
		lesson_excerpt: args.lesson.slice(0, 80),
	};
	return { line: JSON.stringify(event) };
}

export const _internals = {
	readSwarmEntries: (directory: string) =>
		readKnowledge<SwarmKnowledgeEntry>(resolveSwarmKnowledgePath(directory)),
	checkHivePromotions,
	readCuratorSummary,
	appendCuratorRecommendation,
	// #1847 DI seams (invariant 7) — tests inject these rather than mock.module.
	resolveCohortId,
	transactHiveStore,
	validateLesson,
	/** Loads validated terminal-application evidence per swarm entry id. Empty
	 *  until #1849 produces real receipts (conservative: no synthetic credit). */
	loadPromotionEvidence: async (
		_swarmEntries: SwarmKnowledgeEntry[],
	): Promise<Record<string, PromotionEvidenceRecord[]>> => ({}),
	/** Loads the default KnowledgeConfig (schema defaults) for manual promotion
	 *  paths when the command did not load one. */
	loadDefaultKnowledgeConfig: () => KnowledgeConfigSchema.parse({}),
};

/**
 * Create a hook that promotes swarm entries to the hive.
 * The hook fires unconditionally - the caller decides when to invoke it.
 */
export function createHivePromoterHook(
	directory: string,
	config: KnowledgeConfig,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (_input: unknown, _output: unknown): Promise<void> => {
		const swarmEntries = await _internals.readSwarmEntries(directory);

		const promotionSummary = await _internals.checkHivePromotions(
			swarmEntries,
			config,
			directory,
		);

		// Read first even on a no-op: this is the one-time migration path for
		// legacy bloated curator summaries when a project is reopened.
		const curatorSummary = await _internals.readCuratorSummary(directory);
		if (!curatorSummary) return;

		const hasActivity =
			promotionSummary.new_promotions > 0 ||
			promotionSummary.encounters_incremented > 0 ||
			promotionSummary.advancements > 0;
		if (!hasActivity) return;

		await _internals.appendCuratorRecommendation(directory, {
			action: 'promote',
			lesson: `Hive promotion: ${promotionSummary.new_promotions} new, ${promotionSummary.encounters_incremented} encounters, ${promotionSummary.advancements} advancements, ${promotionSummary.total_hive_entries} total entries`,
			reason: JSON.stringify({
				timestamp: promotionSummary.timestamp,
				new_promotions: promotionSummary.new_promotions,
				encounters_incremented: promotionSummary.encounters_incremented,
				advancements: promotionSummary.advancements,
				total_hive_entries: promotionSummary.total_hive_entries,
			}),
		});
	};

	return safeHook(hook);
}

/** Options for manual promotion (override semantics, #1847 §4). */
export interface ManualPromotionOptions {
	force?: boolean;
	reason?: string;
}

/**
 * Promote a lesson directly to the hive (manual promotion).
 *
 * Runs the one policy evaluator. On a policy FAIL:
 *   - without `force` → returns a diagnostic string listing the failed gates
 *     (does NOT promote);
 *   - with `force` + `reason` → promotes and writes a durable override audit
 *     record (actor='manual-override', failed gates recorded) inside the
 *     transaction.
 * On a policy PASS → promotes with actor='manual'.
 *
 * An exact entry id / direct text alone is NEVER authorization to bypass policy.
 */
export async function promoteToHive(
	directory: string,
	lesson: string,
	category?: string,
	options?: ManualPromotionOptions,
	config?: KnowledgeConfig,
): Promise<string> {
	const trimmedLesson = lesson.trim();
	const sourceCohort = await _internals.resolveCohortId(directory);
	// Use the real project config so manual promotion honors the same
	// application-evidence / cohort thresholds as automatic promotion (AC9).
	// Default to schema defaults when the command did not load one.
	const policyConfig =
		config ?? _internals.loadDefaultKnowledgeConfig();

	const result = await _internals.transactHiveStore<string>(async (ctx) => {
		// Dedup against the locked entries.
		if (findNearDuplicate(trimmedLesson, ctx.entries, policyConfig.dedup_threshold)) {
			return { kind: 'noop' as const, return: `Lesson already exists in hive (near-duplicate).` };
		}

		// Validate before writing (throws on error severity — propagate).
		const validationResult = _internals.validateLesson(
			trimmedLesson,
			ctx.entries.map((e) => e.lesson),
			{
				category: (category as KnowledgeCategory) || 'process',
				scope: 'global',
				confidence: 1.0,
			},
		);
		if (validationResult.severity === 'error') {
			return {
				kind: 'noop' as const,
				return: `Lesson rejected by validator: ${validationResult.reason}`,
			};
		}

		// Evaluate the one policy. The direct-text path has no swarm entry, so
		// we synthesize a minimal stand-in for the policy gates that read swarm
		// fields. Manual direct promotion is intentionally allowed to pass the
		// eligibility_route gate (a human is explicitly authoring it); the
		// active_status + confidence_floor + application gates still apply.
		const swarmStandIn: SwarmKnowledgeEntry = {
			id: 'manual-direct',
			tier: 'swarm',
			lesson: trimmedLesson,
			category: (category as KnowledgeCategory) || 'process',
			tags: ['hive-fast-track'], // route 2: explicit manual promotion
			scope: 'global',
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: path.basename(directory) || 'unknown',
		};
		const decision = evaluatePromotionPolicy({
			entry: swarmStandIn,
			config: policyConfig,
			evidence: [],
		});

		const force = options?.force === true;
		const reason = options?.reason?.trim();

		let actor: PromotionActor;
		let overrideFailedGates: string[] | undefined;
		if (decision.eligible) {
			actor = 'manual';
		} else if (force && reason && reason.length > 0) {
			actor = 'manual-override';
			overrideFailedGates = failedGateNames(decision);
		} else {
			// Policy failed and no valid override → block, return diagnostics.
			return {
				kind: 'noop' as const,
				return: `Promotion blocked by policy: ${decision.reason}. Use --force --reason "<why>" to record an audited override.`,
			};
		}

		const promotionEventId = crypto.randomUUID();
		const newHiveEntry: HiveKnowledgeEntry = {
			id: crypto.randomUUID(),
			tier: 'hive',
			lesson: trimmedLesson,
			category: (category as KnowledgeCategory) || 'process',
			tags: [],
			scope: 'global',
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: path.basename(directory) || 'unknown',
			encounter_score: 1.0,
			lineage: buildLineage({
				actor,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
		};

		const entries = [...ctx.entries, newHiveEntry];
		const audit = [
			stagePromotionAudit({
				entryId: newHiveEntry.id,
				lesson: newHiveEntry.lesson,
				actor,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
		];

		return {
			kind: 'commit' as const,
			entries,
			audit,
			return: `Promoted to hive: "${trimmedLesson.slice(0, 50)}${trimmedLesson.length > 50 ? '...' : ''}" (confidence: 1.0, source: manual${actor === 'manual-override' ? '-override' : ''})`,
		};
	});

	// The promotion audit is already staged inside the transaction (the durable
	// override record). No extra post-transaction event is needed — emitting one
	// here would re-enter the directory lock's file (deadlock risk) and the
	// ReceiptEvent 'override' shape requires receipt-only fields we do not have.

	return result.return;
}

/**
 * Promote a lesson from swarm knowledge to hive.
 *
 * Snapshots the swarm read OUTSIDE the hive transaction (the swarm store is
 * read-only here — no two-phase locking needed). Then runs the one policy
 * evaluator + override semantics inside the hive transaction.
 */
export async function promoteFromSwarm(
	directory: string,
	lessonId: string,
	options?: ManualPromotionOptions,
	config?: KnowledgeConfig,
): Promise<string> {
	// Snapshot the swarm entry outside the hive transaction.
	const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(
		resolveSwarmKnowledgePath(directory),
	);
	const swarmEntry = swarmEntries.find((e) => e.id === lessonId);
	if (!swarmEntry) {
		throw new Error(`Lesson ${lessonId} not found in .swarm/knowledge.jsonl`);
	}

	const sourceCohort = await _internals.resolveCohortId(directory);
	// Use the real project config so manual promotion honors the same policy
	// thresholds as automatic promotion (AC9). Default to schema defaults.
	const policyConfig =
		config ?? _internals.loadDefaultKnowledgeConfig();

	const result = await _internals.transactHiveStore<string>(async (ctx) => {
		if (findNearDuplicate(swarmEntry.lesson, ctx.entries, policyConfig.dedup_threshold)) {
			return { kind: 'noop' as const, return: `Lesson already exists in hive (near-duplicate).` };
		}

		const validationResult = _internals.validateLesson(
			swarmEntry.lesson,
			ctx.entries.map((e) => e.lesson),
			{
				category: swarmEntry.category,
				scope: swarmEntry.scope,
				confidence: swarmEntry.confidence,
			},
		);
		if (validationResult.severity === 'error') {
			return {
				kind: 'noop' as const,
				return: `Lesson rejected by validator: ${validationResult.reason}`,
			};
		}

		// One policy evaluator (M1: same gates as auto promotion). An exact id
		// alone is NEVER authorization to bypass policy.
		const decision = evaluatePromotionPolicy({
			entry: swarmEntry,
			config: policyConfig,
			evidence: [],
		});

		const force = options?.force === true;
		const reason = options?.reason?.trim();

		let actor: PromotionActor;
		let overrideFailedGates: string[] | undefined;
		if (decision.eligible) {
			actor = 'manual';
		} else if (force && reason && reason.length > 0) {
			actor = 'manual-override';
			overrideFailedGates = failedGateNames(decision);
		} else {
			return {
				kind: 'noop' as const,
				return: `Promotion blocked by policy: ${decision.reason}. Use --force --reason "<why>" to record an audited override.`,
			};
		}

		const promotionEventId = crypto.randomUUID();
		const newHiveEntry: HiveKnowledgeEntry = {
			id: crypto.randomUUID(),
			tier: 'hive',
			lesson: swarmEntry.lesson,
			category: swarmEntry.category,
			tags: swarmEntry.tags,
			scope: swarmEntry.scope,
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: swarmEntry.schema_version || KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: swarmEntry.project_name,
			encounter_score: 1.0,
			lineage: buildLineage({
				actor,
				sourceEntryId: swarmEntry.id,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
			...carryActionableFields(swarmEntry),
		};

		const entries = [...ctx.entries, newHiveEntry];
		const audit = [
			stagePromotionAudit({
				entryId: newHiveEntry.id,
				lesson: newHiveEntry.lesson,
				actor,
				sourceEntryId: swarmEntry.id,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
		];

		return {
			kind: 'commit' as const,
			entries,
			audit,
			return: `Promoted lesson ${lessonId} from swarm to hive: "${swarmEntry.lesson.slice(0, 50)}${swarmEntry.lesson.length > 50 ? '...' : ''}"`,
		};
	});

	return result.return;
}

// Resolve hive knowledge path re-exported for any external consumer that still
// imports it from this module (historical surface).
export { resolveHiveKnowledgePath } from './knowledge-store.js';
