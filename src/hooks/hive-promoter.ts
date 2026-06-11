/** Hive promoter hook for opencode-swarm v6.17 two-tier knowledge system. */

import path from 'node:path';
import { readCuratorSummary, writeCuratorSummary } from './curator.js';
import type { CuratorSummary } from './curator-types.js';
import {
	appendKnowledge,
	enforceKnowledgeCap,
	findNearDuplicate,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	ProjectConfirmationRecord,
	RejectedLesson,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';

/** Carry a swarm entry's actionable-directive metadata onto a promoted hive
 *  entry (Phase 4 review, MEDIUM finding). Dropping these fields on promotion
 *  would strip predicates/scope from cross-project knowledge, so hive copies
 *  of post-Change-4 entries would no longer be machine-checkable. */
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

import { validateLesson } from './knowledge-validator.js';
import { safeHook } from './utils.js';

/** Hive promotion summary for curator state */
export interface HivePromotionSummary {
	timestamp: string;
	new_promotions: number;
	encounters_incremented: number;
	advancements: number;
	total_hive_entries: number;
}

/**
 * Check if a swarm entry already exists in the hive (near-duplicate).
 * Uses findNearDuplicate with the configured threshold.
 */
function isAlreadyInHive(
	entry: SwarmKnowledgeEntry,
	hiveEntries: HiveKnowledgeEntry[],
	threshold: number,
): boolean {
	return findNearDuplicate(entry.lesson, hiveEntries, threshold) !== undefined;
}

/**
 * Check whether a swarm knowledge entry is eligible for hive promotion.
 * Three routes to eligibility:
 *   Route 1: hive_eligible flag + 3+ distinct phases
 *   Route 2: 'hive-fast-track' tag
 *   Route 3: age exceeds auto_promote_days threshold
 *
 * @param entry - The swarm knowledge entry to check
 * @param autoPromoteDays - Number of days before age-based promotion kicks in
 * @returns true if the entry is eligible for hive promotion
 */
export function isHiveEligible(
	entry: SwarmKnowledgeEntry,
	autoPromoteDays: number,
): boolean {
	// Route 1: hive_eligible flag + 3+ distinct phases
	const phaseNumbers = new Set<number>();
	for (const record of entry.confirmed_by ?? []) {
		if (record && typeof record.phase_number === 'number') {
			phaseNumbers.add(record.phase_number);
		}
	}
	if (entry.hive_eligible === true && phaseNumbers.size >= 3) {
		return true;
	}

	// Route 2: fast-track tag bypasses count requirement
	if ((entry.tags ?? []).includes('hive-fast-track')) {
		return true;
	}

	// Route 3: age-based promotion
	const createdMs = Date.parse(entry.created_at);
	const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0;
	const ageThresholdMs = autoPromoteDays * 86400000;
	if (ageMs >= ageThresholdMs) {
		return true;
	}

	return false;
}

/**
 * Count distinct project names in a hive entry's confirmed_by array.
 */
function countDistinctProjects(
	confirmedBy: ProjectConfirmationRecord[],
): number {
	const projectNames = new Set<string>();
	for (const record of confirmedBy) {
		projectNames.add(record.project_name);
	}
	return projectNames.size;
}

/**
 * Check if a project confirmation already exists in the hive entry's confirmed_by.
 */
function hasProjectConfirmation(
	hiveEntry: HiveKnowledgeEntry,
	projectName: string,
): boolean {
	return hiveEntry.confirmed_by.some(
		(record) => record.project_name === projectName,
	);
}

/**
 * Calculate the new encounter score after a confirmation.
 * Uses weighted scoring: same-project encounters count more slowly than cross-project.
 * Enforces min/max bounds from config.
 */
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

/**
 * Main promotion logic: checks swarm entries and promotes eligible ones to hive.
 * Also updates existing hive entries with new project confirmations.
 * Returns a summary of the promotion activity for curator state.
 *
 * @note The 'hive-fast-track' tag is treated as privileged — it bypasses the
 *   3-phase confirmation requirement. It should only be set by authorized tooling
 *   (inferTags() never produces it automatically).
 */
export async function checkHivePromotions(
	swarmEntries: SwarmKnowledgeEntry[],
	config: KnowledgeConfig,
): Promise<HivePromotionSummary> {
	// Track promotion counts
	let newPromotions = 0;
	let encountersIncremented = 0;
	let advancements = 0;

	// Route 1: Early exit if hive is disabled
	if (config.hive_enabled === false) {
		return {
			timestamp: new Date().toISOString(),
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		};
	}

	// Read existing hive entries
	const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(
		resolveHiveKnowledgePath(),
	);

	// NOTE: New hive entries are appended immediately (no lock); existing-entry updates
	// use rewriteKnowledge (with lock). This mixed pattern is safe under single-writer
	// assumptions (hooks are fire-and-forget, safeHook prevents concurrent calls).

	// Process each swarm entry for promotion
	for (const swarmEntry of swarmEntries) {
		// Check if already in hive (skip near-duplicates)
		if (isAlreadyInHive(swarmEntry, hiveEntries, config.dedup_threshold)) {
			continue;
		}

		// Determine promotion eligibility via shared helper
		if (!isHiveEligible(swarmEntry, config.auto_promote_days)) {
			continue;
		}

		// Re-validate before promotion
		const validationResult = validateLesson(
			swarmEntry.lesson,
			hiveEntries.map((e) => e.lesson),
			{
				category: swarmEntry.category,
				scope: swarmEntry.scope,
				confidence: swarmEntry.confidence,
			},
		);

		// If validation fails with error severity, reject to hive-rejected
		if (validationResult.severity === 'error') {
			const rejectedLesson: RejectedLesson = {
				id: crypto.randomUUID(),
				lesson: swarmEntry.lesson,
				rejection_reason:
					validationResult.reason || 'validation failed for hive promotion',
				rejected_at: new Date().toISOString(),
				rejection_layer: validationResult.layer || 2,
			};

			// Append to hive rejected lessons using correct path
			const hiveRejectedPath = resolveHiveRejectedPath();
			await appendKnowledge(hiveRejectedPath, rejectedLesson);

			continue;
		}

		// Build new hive entry
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
			schema_version: config.schema_version,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: swarmEntry.project_name,
			encounter_score: config.initial_encounter_score, // starts at configured initial value (default 1.0)
			...carryActionableFields(swarmEntry),
		};

		// Append to hive
		await appendKnowledge(resolveHiveKnowledgePath(), newHiveEntry);

		// Track new promotion
		newPromotions++;

		// Add the new entry to local array for subsequent processing
		hiveEntries.push(newHiveEntry);
	}

	// After promotions, update hive entry confirmations for near-duplicates
	// from different projects
	let hiveModified = false;

	for (const hiveEntry of hiveEntries) {
		// Find near-duplicate swarm entries from different projects
		const nearDuplicate = findNearDuplicate(
			hiveEntry.lesson,
			swarmEntries,
			config.dedup_threshold,
		);

		if (!nearDuplicate) {
			continue;
		}

		// Determine if this is a same-project or cross-project encounter
		const isSameProject =
			nearDuplicate.project_name === hiveEntry.source_project;

		// Skip if already confirmed by this project (same-run double-count prevention)
		if (hasProjectConfirmation(hiveEntry, nearDuplicate.project_name)) {
			continue;
		}

		// Add project confirmation
		const newConfirmation: ProjectConfirmationRecord = {
			project_name: nearDuplicate.project_name,
			confirmed_at: new Date().toISOString(),
		};

		hiveEntry.confirmed_by.push(newConfirmation);

		// Update encounter score with weighted scoring
		// Use backward compatibility: default to 1.0 for older entries without encounter_score
		const currentScore = hiveEntry.encounter_score ?? 1.0;
		hiveEntry.encounter_score = calculateEncounterScore(
			currentScore,
			isSameProject,
			config,
		);

		// Track encounter increment
		encountersIncremented++;

		hiveEntry.updated_at = new Date().toISOString();

		// Advance status from candidate to established if 3+ distinct projects
		if (
			hiveEntry.status === 'candidate' &&
			countDistinctProjects(hiveEntry.confirmed_by) >= 3
		) {
			hiveEntry.status = 'established';
			// Track advancement
			advancements++;
		}

		hiveModified = true;
	}

	// Rewrite hive file if any entries were modified
	if (hiveModified) {
		await rewriteKnowledge(resolveHiveKnowledgePath(), hiveEntries);
	}

	// Enforce hive_max_entries cap (FIFO: drop oldest when exceeded)
	if (newPromotions > 0 || hiveModified) {
		await enforceKnowledgeCap(
			resolveHiveKnowledgePath(),
			config.hive_max_entries,
		);
	}

	// Return the promotion summary for curator state
	return {
		timestamp: new Date().toISOString(),
		new_promotions: newPromotions,
		encounters_incremented: encountersIncremented,
		advancements: advancements,
		total_hive_entries: hiveEntries.length,
	};
}

/**
 * Create a hook that promotes swarm entries to the hive.
 * The hook fires unconditionally - the caller decides when to invoke it.
 */
export function createHivePromoterHook(
	directory: string,
	config: KnowledgeConfig,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (_input: unknown, _output: unknown): Promise<void> => {
		// Read swarm entries from the project directory
		const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(directory),
		);

		// Run promotion logic and get summary
		const promotionSummary = await checkHivePromotions(swarmEntries, config);

		// Integrate with existing curator summary state
		const curatorSummary = await readCuratorSummary(directory);

		if (curatorSummary) {
			// Defensive: ensure knowledge_recommendations is a valid array
			const existingRecommendations = Array.isArray(
				curatorSummary.knowledge_recommendations,
			)
				? curatorSummary.knowledge_recommendations
				: [];

			// Add hive promotion summary as a knowledge recommendation
			const recommendation = {
				action: 'promote' as const,
				lesson: `Hive promotion: ${promotionSummary.new_promotions} new, ${promotionSummary.encounters_incremented} encounters, ${promotionSummary.advancements} advancements, ${promotionSummary.total_hive_entries} total entries`,
				reason: JSON.stringify({
					timestamp: promotionSummary.timestamp,
					new_promotions: promotionSummary.new_promotions,
					encounters_incremented: promotionSummary.encounters_incremented,
					advancements: promotionSummary.advancements,
					total_hive_entries: promotionSummary.total_hive_entries,
				}),
			};

			const updatedSummary: CuratorSummary = {
				...curatorSummary,
				knowledge_recommendations: [...existingRecommendations, recommendation],
				last_updated: new Date().toISOString(),
			};

			await writeCuratorSummary(directory, updatedSummary);
		}
	};

	// Wrap in safeHook for fire-and-forget error suppression
	return safeHook(hook);
}

/**
 * Promote a lesson directly to the hive (manual promotion).
 * @param directory - Project directory
 * @param lesson - The lesson text to promote
 * @param category - Optional category (defaults to 'process')
 * @returns Confirmation message
 */
export async function promoteToHive(
	directory: string,
	lesson: string,
	category?: string,
): Promise<string> {
	const trimmedLesson = lesson.trim();

	// Read existing hive entries for deduplication
	const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(
		resolveHiveKnowledgePath(),
	);

	// Validate before writing
	const validationResult = validateLesson(
		trimmedLesson,
		hiveEntries.map((e) => e.lesson),
		{
			category: (category as KnowledgeCategory) || 'process',
			scope: 'global',
			confidence: 1.0,
		},
	);

	if (validationResult.severity === 'error') {
		throw new Error(`Lesson rejected by validator: ${validationResult.reason}`);
	}

	// Check for near-duplicate
	if (findNearDuplicate(trimmedLesson, hiveEntries, 0.6)) {
		return `Lesson already exists in hive (near-duplicate).`;
	}

	// Build hive entry
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
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		source_project: path.basename(directory) || 'unknown',
		encounter_score: 1.0, // manual promotions start at 1.0
	};

	// Append to hive
	await appendKnowledge(resolveHiveKnowledgePath(), newHiveEntry);

	return `Promoted to hive: "${trimmedLesson.slice(0, 50)}${trimmedLesson.length > 50 ? '...' : ''}" (confidence: 1.0, source: manual)`;
}

/**
 * Promote a lesson from swarm knowledge to hive.
 * @param directory - Project directory
 * @param lessonId - The ID of the lesson to promote from swarm
 * @returns Confirmation message
 */
export async function promoteFromSwarm(
	directory: string,
	lessonId: string,
): Promise<string> {
	// Read swarm entries
	const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(
		resolveSwarmKnowledgePath(directory),
	);

	// Find the lesson
	const swarmEntry = swarmEntries.find((e) => e.id === lessonId);
	if (!swarmEntry) {
		throw new Error(`Lesson ${lessonId} not found in .swarm/knowledge.jsonl`);
	}

	// Read existing hive entries
	const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(
		resolveHiveKnowledgePath(),
	);

	// Validate before writing
	const validationResult = validateLesson(
		swarmEntry.lesson,
		hiveEntries.map((e) => e.lesson),
		{
			category: swarmEntry.category,
			scope: swarmEntry.scope,
			confidence: swarmEntry.confidence,
		},
	);

	if (validationResult.severity === 'error') {
		throw new Error(`Lesson rejected by validator: ${validationResult.reason}`);
	}

	// Check for near-duplicate
	if (findNearDuplicate(swarmEntry.lesson, hiveEntries, 0.6)) {
		return `Lesson already exists in hive (near-duplicate).`;
	}

	// Build hive entry from swarm entry
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
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		source_project: swarmEntry.project_name,
		encounter_score: 1.0, // promotions from swarm start at 1.0
		...carryActionableFields(swarmEntry),
	};

	// Append to hive
	await appendKnowledge(resolveHiveKnowledgePath(), newHiveEntry);

	return `Promoted lesson ${lessonId} from swarm to hive: "${swarmEntry.lesson.slice(0, 50)}${swarmEntry.lesson.length > 50 ? '...' : ''}"`;
}
