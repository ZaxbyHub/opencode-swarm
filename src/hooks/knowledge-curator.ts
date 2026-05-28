/** Knowledge curator hook for opencode-swarm v6.17 two-tier knowledge system. */

import {
	appendKnowledge,
	appendRejectedLesson,
	appendRetractionRecord,
	computeConfidence,
	computeOutcomeSignal,
	enforceKnowledgeCap,
	findNearDuplicate,
	inferTags,
	normalize,
	readKnowledge,
	readRetractionRecords,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	RejectedLesson,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { quarantineEntry, validateLesson } from './knowledge-validator.js';
import { readSwarmFileAsync, safeHook } from './utils.js';

// ============================================================================
// Module-level state
// ============================================================================

// Idempotency guard: keyed by sessionID, stores last-seen retro section hash with timestamp
const seenRetroSections = new Map<
	string,
	{ value: string; timestamp: number }
>();

/**
 * Prune entries from seenRetroSections that are older than 24 hours.
 */
function pruneSeenRetroSections(): void {
	const cutoff = Date.now() - 86_400_000; // 24 hours
	for (const [key, entry] of seenRetroSections) {
		if (entry.timestamp < cutoff) {
			seenRetroSections.delete(key);
		}
	}
}

// ============================================================================
// Internal helpers (NOT exported)
// ============================================================================

/**
 * Check if the input is a write operation targeting the swarm plan file.
 */
function isWriteToSwarmPlan(input: unknown): boolean {
	if (typeof input !== 'object' || input === null) return false;

	const record = input as Record<string, unknown>;
	const toolName = record.toolName as string | undefined;

	if (typeof toolName !== 'string') return false;
	if (!['write', 'edit', 'apply_patch'].includes(toolName)) return false;

	// Normalize path separators (Windows uses backslash)
	const rawPath = record.path as string | undefined;
	const rawFile = record.file as string | undefined;
	const pathField =
		typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : undefined;
	const fileField =
		typeof rawFile === 'string' ? rawFile.replace(/\\/g, '/') : undefined;

	if (typeof pathField === 'string' && pathField.includes('.swarm/plan.md')) {
		return true;
	}
	if (typeof fileField === 'string' && fileField.includes('.swarm/plan.md')) {
		return true;
	}

	return false;
}

/**
 * Check if the input is a write operation targeting an evidence file.
 * Exported for testing purposes only.
 */
export function isWriteToEvidenceFile(input: unknown): boolean {
	if (typeof input !== 'object' || input === null) return false;

	const record = input as Record<string, unknown>;
	const toolName = record.toolName as string | undefined;

	if (typeof toolName !== 'string') return false;
	if (!['write', 'edit', 'apply_patch'].includes(toolName)) return false;

	// Normalize path separators (Windows uses backslash)
	const rawPath = record.path as string | undefined;
	const rawFile = record.file as string | undefined;
	const pathField =
		typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : undefined;
	const fileField =
		typeof rawFile === 'string' ? rawFile.replace(/\\/g, '/') : undefined;

	// Block ALL writes to .swarm/evidence/ (any path under evidence dir)
	const evidenceRegex = /\.swarm\/+evidence\/+/i;

	if (typeof pathField === 'string' && evidenceRegex.test(pathField)) {
		return true;
	}
	if (typeof fileField === 'string' && evidenceRegex.test(fileField)) {
		return true;
	}

	return false;
}

/**
 * Extract the "Lessons Learned" retrospective section from plan markdown.
 * Returns the text from that heading line through the next ### or ## heading (exclusive).
 * Returns null if the heading is not found.
 */
function extractRetrospectiveSection(planContent: string): string | null {
	const headingRegex = /^###\s+Lessons\s+Learned$/m;
	const match = headingRegex.exec(planContent);

	if (!match) return null;

	const startIndex = match.index;
	const restOfContent = planContent.slice(startIndex);

	// Skip the heading line itself before searching for the next heading
	const firstNewline = restOfContent.indexOf('\n');
	const contentAfterHeading =
		firstNewline === -1 ? '' : restOfContent.slice(firstNewline + 1);

	// Find the next heading (### or ##) after the "Lessons Learned" section
	const nextHeadingRegex = /^#{1,2}\s+/m;
	const nextMatch = nextHeadingRegex.exec(contentAfterHeading);

	let endIndex: number;
	if (nextMatch) {
		endIndex = startIndex + firstNewline + 1 + nextMatch.index;
	} else {
		endIndex = planContent.length;
	}

	return planContent.slice(startIndex, endIndex).trim();
}

/**
 * Check if the retrospective section has changed since last seen.
 * Uses a simple hash: section.length + ':' + section.slice(0, 100)
 */
function checkRetroChanged(sessionID: string, section: string): boolean {
	const hash = `${section.length}:${section.slice(0, 100)}`;
	const lastSeen = seenRetroSections.get(sessionID);

	if (lastSeen?.value === hash) {
		return false; // no change
	}

	seenRetroSections.set(sessionID, { value: hash, timestamp: Date.now() });
	return true; // changed (or new)
}

/**
 * Extract bullet-point lessons from the retrospective section.
 * Parses lines starting with "- " or "* " (with optional leading whitespace).
 */
function extractLessonsFromRetro(section: string): string[] {
	const lessons: string[] = [];
	const lines = section.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		// Match bullet points: optional whitespace, then - or *, then space, then content
		const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
		if (bulletMatch) {
			const content = bulletMatch[1].trim();
			if (content) {
				lessons.push(content);
			}
		}
	}

	return lessons;
}

/**
 * Separate RETRACT:/BAD RULE: lines from normal lessons.
 * Returns: { retractions: string[], normalLessons: string[] }
 * RETRACT: and BAD RULE: lines are NOT treated as new lessons to store.
 */
function extractRetractionsAndLessons(allLessons: string[]): {
	retractions: string[];
	normalLessons: string[];
} {
	const retractions: string[] = [];
	const normalLessons: string[] = [];
	for (const lesson of allLessons) {
		const upper = lesson.trimStart().toUpperCase();
		if (upper.startsWith('RETRACT:') || upper.startsWith('BAD RULE:')) {
			// Extract the text after the prefix
			const colonIdx = lesson.indexOf(':');
			const text = colonIdx !== -1 ? lesson.slice(colonIdx + 1).trim() : '';
			if (text) retractions.push(text);
		} else {
			normalLessons.push(lesson);
		}
	}
	return { retractions, normalLessons };
}

/**
 * For each retraction text, search knowledge.jsonl for entries whose normalized
 * lesson matches and quarantine them.
 */
async function processRetractions(
	retractions: string[],
	directory: string,
): Promise<void> {
	if (retractions.length === 0) return;

	const swarmEntries =
		(await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(directory),
		)) ?? [];
	const hiveEntries =
		(await readKnowledge<HiveKnowledgeEntry>(resolveHiveKnowledgePath())) ?? [];
	const existingRetractions = await readRetractionRecords(directory);
	const existingSuppressedLessons = new Set(
		existingRetractions
			.map((record) => record.normalized_lesson)
			.filter(
				(value): value is string =>
					typeof value === 'string' && value.length > 0,
			),
	);

	for (const retractionText of retractions) {
		const normalizedRetraction = normalize(retractionText);
		const matchedSwarmIds: string[] = [];
		const matchedHiveIds: string[] = [];

		for (const entry of swarmEntries) {
			const normalizedLesson = normalize(entry.lesson);
			if (normalizedLesson === normalizedRetraction) {
				matchedSwarmIds.push(entry.id);
				await quarantineEntry(
					directory,
					entry.id,
					`Retracted by architect: ${retractionText}`,
					'architect',
				);
				console.info(
					`[knowledge-curator] Quarantined entry ${entry.id}: "${entry.lesson}"`,
				);
			}
		}

		for (const entry of hiveEntries) {
			if (normalize(entry.lesson) === normalizedRetraction) {
				matchedHiveIds.push(entry.id);
			}
		}

		if (!existingSuppressedLessons.has(normalizedRetraction)) {
			await appendRetractionRecord(directory, {
				id: crypto.randomUUID(),
				retracted_lesson: retractionText,
				normalized_lesson: normalizedRetraction,
				recorded_at: new Date().toISOString(),
				reported_by: 'architect',
				matched_swarm_ids: matchedSwarmIds,
				matched_hive_ids: matchedHiveIds,
			});
			existingSuppressedLessons.add(normalizedRetraction);
		}
	}
}

// ============================================================================
// Exported functions
// ============================================================================

/**
 * Curate and store swarm knowledge entries from lessons.
 * @returns Promise resolving to an object with counts of stored, skipped, and rejected lessons.
 */
export async function curateAndStoreSwarm(
	lessons: string[],
	projectName: string,
	phaseInfo: { phase_number: number },
	directory: string,
	config: KnowledgeConfig,
	options?: { skipAutoPromotion?: boolean },
): Promise<{ stored: number; skipped: number; rejected: number }> {
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const existingEntries =
		(await readKnowledge<SwarmKnowledgeEntry>(knowledgePath)) ?? [];

	let stored = 0;
	let skipped = 0;
	let rejected = 0;

	// Tag-to-category mapping (static, hoisted outside loop)
	const categoryByTag = new Map<string, KnowledgeCategory>([
		['process', 'process'],
		['architecture', 'architecture'],
		['tooling', 'tooling'],
		['security', 'security'],
		['testing', 'testing'],
		['debugging', 'debugging'],
		['performance', 'performance'],
		['integration', 'integration'],
		['other', 'other'],
		['todo', 'todo'],
	]);

	for (const lesson of lessons) {
		// Determine category from tags
		const tags = inferTags(lesson);
		let category: KnowledgeCategory = 'process';
		for (const tag of tags) {
			if (categoryByTag.has(tag)) {
				category = categoryByTag.get(tag)!;
				break;
			}
		}

		// Build meta object for validation
		const meta = {
			category,
			scope: 'global',
			confidence: computeConfidence(0, true),
		};

		// Validate the lesson
		const result = validateLesson(
			lesson,
			existingEntries.map((e) => e.lesson),
			meta,
		);

		// If validation failed (severity is 'error'), reject the lesson
		if (result.valid === false || result.severity === 'error') {
			const rejectedLesson: RejectedLesson = {
				id: crypto.randomUUID(),
				lesson,
				rejection_reason: result.reason ?? 'unknown',
				rejected_at: new Date().toISOString(),
				rejection_layer: result.layer ?? 1,
			};
			await appendRejectedLesson(directory, rejectedLesson);
			rejected++;
			continue;
		}

		// Check for near-duplicates
		const duplicate = findNearDuplicate(
			lesson,
			existingEntries,
			config.dedup_threshold,
		);
		if (duplicate) {
			skipped++;
			continue; // skip duplicate
		}

		// Build the new swarm entry
		const entry: SwarmKnowledgeEntry = {
			id: crypto.randomUUID(),
			tier: 'swarm',
			lesson,
			category,
			tags,
			scope: 'global',
			confidence: computeConfidence(1, true), // 1 confirmation, auto_generated=true
			status: 'candidate',
			confirmed_by: [
				{
					phase_number: phaseInfo.phase_number,
					confirmed_at: new Date().toISOString(),
					project_name: projectName,
				},
			],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: config.schema_version,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: projectName,
			auto_generated: true,
		};

		// Append to knowledge store
		await appendKnowledge(knowledgePath, entry);
		stored++;

		// Add to existing entries for subsequent deduplication checks
		existingEntries.push(entry);
	}

	// Enforce swarm_max_entries cap (FIFO: drop oldest when exceeded)
	await enforceKnowledgeCap(knowledgePath, config.swarm_max_entries);

	// Run auto-promotion after processing all lessons. Callers that only want to PROPOSE
	// candidate knowledge (e.g. the architecture supervisor's recommendations) pass
	// skipAutoPromotion to avoid promoting unrelated pre-existing candidates as a side
	// effect of this write (issue #893).
	if (!options?.skipAutoPromotion) {
		await _internals.runAutoPromotion(directory, config);
	}

	return { stored, skipped, rejected };
}

// A track-record signal at or below this (negatives clearly outweighing positives,
// with enough corroborating evidence) blocks auto-promotion regardless of phase
// confirmations or age. Tuned against computeOutcomeSignal's Laplace smoothing so a
// lone ignore/contradiction does not block a well-confirmed entry.
const OUTCOME_PROMOTION_BLOCK = -0.3;

/**
 * Auto-promote swarm entries based on phase confirmations and age.
 */
export async function runAutoPromotion(
	directory: string,
	config: KnowledgeConfig,
): Promise<void> {
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const entries =
		(await readKnowledge<SwarmKnowledgeEntry>(knowledgePath)) ?? [];

	let changed = false;

	for (const entry of entries) {
		// Skip already promoted entries
		if (entry.status === 'promoted') continue;

		// Event-sourced safety gate: a clearly negative track record blocks
		// auto-promotion regardless of phase confirmations or age. Entries with no
		// outcome history (signal 0) are unaffected, preserving prior behavior.
		if (
			computeOutcomeSignal(entry.retrieval_outcomes) <= OUTCOME_PROMOTION_BLOCK
		) {
			continue;
		}

		// Count distinct phase numbers
		const distinctPhases = new Set(
			(entry.confirmed_by ?? []).map((c) => c.phase_number),
		).size;

		// Candidate -> Established: need 3+ distinct phases
		if (entry.status === 'candidate' && distinctPhases >= 3) {
			entry.status = 'established';
			entry.updated_at = new Date().toISOString();
			changed = true;
			continue;
		}

		// Established -> Promoted: need 3+ distinct phases OR age threshold
		if (entry.status === 'established') {
			const createdAt = Date.parse(entry.created_at ?? '');
			const ageMs = Number.isNaN(createdAt) ? 0 : Date.now() - createdAt;
			const ageThresholdMs = config.auto_promote_days * 86400000;

			if (distinctPhases >= 3 || ageMs >= ageThresholdMs) {
				entry.status = 'promoted';
				entry.hive_eligible = true;
				entry.updated_at = new Date().toISOString();
				changed = true;
			}
		}
	}

	// Rewrite if any changes were made
	if (changed) {
		await rewriteKnowledge(knowledgePath, entries);
	}
}

/**
 * Create the knowledge curator hook.
 * Watches for writes to .swarm/plan.md and extracts lessons from the retrospective section.
 */
export function createKnowledgeCuratorHook(
	directory: string,
	config: KnowledgeConfig,
): (input: unknown, output: unknown) => Promise<void> {
	const handler = async (input: unknown, _output: unknown): Promise<void> => {
		// Prune stale entries from seenRetroSections
		pruneSeenRetroSections();

		if (!config.enabled) return;
		if (!isWriteToSwarmPlan(input) && !isWriteToEvidenceFile(input)) return;

		// Extract sessionID from input (best-effort)
		const sessionID =
			((input as Record<string, unknown>)?.sessionID as string | undefined) ??
			'default';

		// Detect which trigger fired
		const isEvidenceTrigger =
			isWriteToEvidenceFile(input) && !isWriteToSwarmPlan(input);

		// Handle evidence file trigger
		if (isEvidenceTrigger) {
			// Extract file path from input
			const record = input as Record<string, unknown>;
			const rawPath = record.path as string | undefined;
			const rawFile = record.file as string | undefined;
			const filePath =
				typeof rawPath === 'string'
					? rawPath.replace(/\\/g, '/')
					: typeof rawFile === 'string'
						? rawFile.replace(/\\/g, '/')
						: null;

			if (!filePath) return;

			// Create idempotency key for evidence: evidence:${sessionID}:${filePath}
			const evidenceKey = `evidence:${sessionID}:${filePath}`;
			const lastSeenEvidence = seenRetroSections.get(evidenceKey);

			// Read and parse the evidence JSON file
			const evidenceContent = await readSwarmFileAsync(
				directory,
				filePath.replace(/^.*\.swarm\//, ''),
			);
			if (!evidenceContent) return;

			let evidenceData: Record<string, unknown>;
			try {
				evidenceData = JSON.parse(evidenceContent);
			} catch {
				return;
			}

			// Extract lessons_learned (handle both formats: { entries: [{ lessons_learned }] } and { lessons_learned })
			let lessons: string[] = [];
			if (
				Array.isArray(evidenceData.entries) &&
				evidenceData.entries.length > 0
			) {
				const firstEntry = evidenceData.entries[0] as Record<string, unknown>;
				if (Array.isArray(firstEntry.lessons_learned)) {
					lessons = firstEntry.lessons_learned as string[];
				}
			} else if (Array.isArray(evidenceData.lessons_learned)) {
				lessons = evidenceData.lessons_learned as string[];
			}

			if (lessons.length === 0) return;

			// Idempotency check for evidence
			const evidenceHash = `${lessons.length}:${lessons.slice(0, 3).join('|')}`;
			if (lastSeenEvidence?.value === evidenceHash) {
				return; // no change
			}
			seenRetroSections.set(evidenceKey, {
				value: evidenceHash,
				timestamp: Date.now(),
			});

			// Extract project name from evidence data
			const projectName = (evidenceData.project_name as string) ?? 'unknown';

			// Extract phase number from evidence data
			const phaseNumber =
				typeof evidenceData.phase_number === 'number'
					? evidenceData.phase_number
					: 1;

			await _internals.curateAndStoreSwarm(
				lessons,
				projectName,
				{ phase_number: phaseNumber },
				directory,
				config,
			);

			return;
		}

		// Handle plan.md trigger (existing behavior)
		const planContent = await readSwarmFileAsync(directory, 'plan.md');
		if (!planContent) return;

		const section = extractRetrospectiveSection(planContent);
		if (!section) return;

		if (!checkRetroChanged(sessionID, section)) return;

		const allLessons = extractLessonsFromRetro(section);
		if (allLessons.length === 0) return;

		// Separate RETRACT:/BAD RULE: lines from normal lessons
		const { retractions, normalLessons } =
			extractRetractionsAndLessons(allLessons);

		// Process retractions: quarantine matching knowledge entries
		await processRetractions(retractions, directory);

		// Only curate non-retraction lessons
		if (normalLessons.length === 0) return;

		// Extract project name from plan content (look for "# <name>" on first line, fallback to 'unknown')
		const projectNameMatch = /^#\s+(.+)$/m.exec(planContent);
		const projectName = projectNameMatch
			? projectNameMatch[1].trim()
			: 'unknown';

		// Extract phase number from plan content (look for "Phase: <N>" header line, fallback to 1)
		const phaseMatch = /^Phase:\s*(\d+)/m.exec(planContent);
		const phaseNumber = phaseMatch ? parseInt(phaseMatch[1], 10) : 1;

		await _internals.curateAndStoreSwarm(
			normalLessons,
			projectName,
			{ phase_number: phaseNumber },
			directory,
			config,
		);
	};

	return safeHook(handler);
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	isWriteToEvidenceFile: typeof isWriteToEvidenceFile;
	curateAndStoreSwarm: typeof curateAndStoreSwarm;
	runAutoPromotion: typeof runAutoPromotion;
	createKnowledgeCuratorHook: typeof createKnowledgeCuratorHook;
} = {
	isWriteToEvidenceFile,
	curateAndStoreSwarm,
	runAutoPromotion,
	createKnowledgeCuratorHook,
};
