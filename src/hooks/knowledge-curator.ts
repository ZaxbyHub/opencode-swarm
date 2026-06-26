/** Knowledge curator hook for opencode-swarm v6.17 two-tier knowledge system. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { reserveQuota } from '../services/skill-improver-quota.js';
import { rebuildSynonymMap } from '../services/synonym-map.js';
import { warn } from '../utils/logger.js';
import type { CuratorLLMDelegate } from './curator.js';
import {
	effectiveRetrievalOutcomes,
	readKnowledgeCounterRollups,
} from './knowledge-events.js';
import {
	findActiveSwarmNearDuplicate,
	reinforceSwarmKnowledgeEntry,
} from './knowledge-reinforcement.js';
import {
	appendRejectedLesson,
	appendRetractionRecord,
	computeConfidence,
	computeOutcomeSignal,
	enforceKnowledgeCap,
	inferTags,
	normalize,
	readKnowledge,
	readRetractionRecords,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
	transactFile,
	transactKnowledge,
} from './knowledge-store.js';
import type {
	ActionableDirectiveFields,
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	RejectedLesson,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import {
	appendUnactionable,
	quarantineEntry,
	validateActionability,
	validateActionableFields,
	validateLesson,
} from './knowledge-validator.js';
import {
	type InsightCandidate,
	resolveInsightCandidatesPath,
} from './micro-reflector.js';
import { readSwarmFileAsync, safeHook } from './utils.js';

// ============================================================================
// Module-level state
// ============================================================================

// Idempotency guard: keyed by sessionID (and by `evidence:<sessionID>:<path>`),
// stores last-seen retro section hash with timestamp.
const seenRetroSections = new Map<
	string,
	{ value: string; timestamp: number }
>();

// AGENTS.md §8: module-level state must have an explicit eviction strategy, not
// only time-based pruning. A burst of distinct sessions inside the 24h window
// would otherwise grow this map without bound. Cap the entry count and evict the
// oldest-timestamp entries (LRU-by-recency) once the cap is exceeded.
const MAX_TRACKED_RETRO_SECTIONS = 500;

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

/**
 * Bound seenRetroSections to MAX_TRACKED_RETRO_SECTIONS entries, evicting the
 * oldest-timestamp entries first. Called after every insert so the map can never
 * exceed the cap regardless of how many distinct sessions appear within the
 * 24-hour prune window.
 */
function capSeenRetroSections(): void {
	const overflow = seenRetroSections.size - MAX_TRACKED_RETRO_SECTIONS;
	if (overflow <= 0) return;
	// Sort keys by ascending timestamp (oldest first) and drop the overflow.
	const byAge = Array.from(seenRetroSections.entries()).sort(
		(a, b) => a[1].timestamp - b[1].timestamp,
	);
	for (let i = 0; i < overflow; i++) {
		seenRetroSections.delete(byAge[i][0]);
	}
}

/** Record a seen-section hash and enforce the size cap in one step. */
function recordSeenRetroSection(
	key: string,
	value: string,
	timestamp: number,
): void {
	seenRetroSections.set(key, { value, timestamp });
	capSeenRetroSections();
}

function hashContent(content: string): string {
	return createHash('sha1').update(content).digest('hex');
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
	if (!['write', 'edit', 'apply_patch', 'swarm_apply_patch'].includes(toolName))
		return false;

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
	if (!['write', 'edit', 'apply_patch', 'swarm_apply_patch'].includes(toolName))
		return false;

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
 */
function checkRetroChanged(sessionID: string, section: string): boolean {
	const hash = hashContent(section);
	const lastSeen = seenRetroSections.get(sessionID);

	if (lastSeen?.value === hash) {
		return false; // no change
	}

	recordSeenRetroSection(sessionID, hash, Date.now());
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

// ============================================================================
// v3 Actionability Enrichment (Change 4, Task 4.2)
// ============================================================================

/** Fields the enrichment LLM may emit. verification_predicate is intentionally
 *  NOT accepted from auto-enrichment: predicates execute subprocesses, and
 *  LLM-authored executables from an automated loop are not trusted. Predicates
 *  enter via curated/skill-improver paths instead. */
const ENRICHMENT_ALLOWED_FIELDS = [
	'triggers',
	'required_actions',
	'forbidden_actions',
	'verification_checks',
	'applies_to_agents',
	'applies_to_tools',
	'directive_priority',
] as const;

/** Build the v3-schema enrichment prompt for a single prose lesson. */
export function buildV3EnrichmentPrompt(
	lesson: string,
	category: string,
	tags: string[],
): string {
	return [
		'Convert this prose lesson into an actionable knowledge directive.',
		'Output ONLY a single JSON object — no code fences, no commentary.',
		'',
		'MANDATORY fields (the directive is rejected without them):',
		'- At least ONE scope field non-empty:',
		'  "applies_to_agents": string[] — roles from: architect, coder, reviewer, test_engineer, sme, docs, designer, critic, curator',
		'  "applies_to_tools": string[] — tool names from: edit, write, patch, bash, read, grep, glob',
		'- At least ONE predicate field non-empty:',
		'  "forbidden_actions": string[] — concrete actions to never take',
		'  "required_actions": string[] — concrete actions to always take',
		'  "verification_checks": string[] — checks a reviewer can run',
		'',
		'OPTIONAL fields:',
		'  "triggers": string[] — short phrases that should surface this lesson',
		'  "directive_priority": "low" | "medium" | "high" | "critical"',
		'',
		'Example output:',
		'{"applies_to_agents":["coder"],"forbidden_actions":["use async iterators in hot paths"],"required_actions":["use a plain for loop in hot paths"],"triggers":["hot path","async iterator"],"directive_priority":"high"}',
		'',
		`LESSON: ${lesson}`,
		`CATEGORY: ${category}`,
		`TAGS: ${tags.join(', ')}`,
	].join('\n');
}

/** Build the v3-schema enrichment prompt for a batch of prose lessons. */
function buildV3BatchEnrichmentPrompt(
	lessons: EnrichmentLessonInput[],
): string {
	const lessonLines = lessons
		.map(
			(item, idx) =>
				`${idx + 1}. LESSON: ${item.lesson}\n   CATEGORY: ${item.category}\n   TAGS: ${item.tags.join(', ')}`,
		)
		.join('\n');
	return [
		'Convert each prose lesson below into an actionable knowledge directive.',
		'Output ONLY a JSON array (no code fences, no commentary).',
		`The array length MUST be exactly ${lessons.length}.`,
		'Each array element at position i maps to lesson i (1-indexed above).',
		'',
		'For EACH element, mandatory requirements:',
		'- At least ONE scope field non-empty:',
		'  "applies_to_agents": string[] — roles from: architect, coder, reviewer, test_engineer, sme, docs, designer, critic, curator',
		'  "applies_to_tools": string[] — tool names from: edit, write, patch, bash, read, grep, glob',
		'- At least ONE predicate field non-empty:',
		'  "forbidden_actions": string[] | "required_actions": string[] | "verification_checks": string[]',
		'',
		'Optional per element:',
		'"triggers": string[], "directive_priority": "low" | "medium" | "high" | "critical"',
		'',
		'Example array:',
		'[{"applies_to_agents":["coder"],"required_actions":["run focused tests before commit"],"directive_priority":"high"}]',
		'',
		'LESSONS:',
		lessonLines,
	].join('\n');
}

/**
 * Parse + validate an enrichment response. Returns the sanitized fields when
 * the output is shape-valid AND actionable, otherwise the list of missing
 * requirements (for the RETRY follow-up). Untrusted-input hardened: only
 * allowlisted fields are copied, then shape-validated by
 * validateActionableFields (length caps, name patterns, injection checks).
 */
export function parseV3EnrichmentResponse(
	text: string,
): { fields: ActionableDirectiveFields } | { missing: string[] } {
	if (!text || typeof text !== 'string') {
		return { missing: ['valid JSON object'] };
	}
	// Extract the first {...} block (the model may wrap it in prose or fences).
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) return { missing: ['valid JSON object'] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return { missing: ['valid JSON object'] };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { missing: ['valid JSON object'] };
	}
	const raw = parsed as Record<string, unknown>;
	const fields: ActionableDirectiveFields = {};
	for (const key of ENRICHMENT_ALLOWED_FIELDS) {
		if (raw[key] !== undefined) {
			(fields as Record<string, unknown>)[key] = raw[key];
		}
	}
	const shape = validateActionableFields(fields);
	if (!shape.valid) return { missing: shape.errors };
	const actionability = validateActionability(fields);
	if (!actionability.actionable) {
		const missing: string[] = [];
		if (
			actionability.reason === 'missing_predicate' ||
			actionability.reason === 'missing_predicate_and_scope'
		) {
			missing.push(
				'a non-empty predicate field (forbidden_actions, required_actions, or verification_checks)',
			);
		}
		if (
			actionability.reason === 'missing_scope' ||
			actionability.reason === 'missing_predicate_and_scope'
		) {
			missing.push(
				'a non-empty scope field (applies_to_agents or applies_to_tools)',
			);
		}
		return { missing };
	}
	return { fields };
}

function parseV3BatchEnrichmentResponse(
	text: string,
	expectedLength: number,
): { fields: Array<ActionableDirectiveFields | null>; missing: string[] } {
	const empty = Array.from({ length: expectedLength }, () => null);
	if (!text || typeof text !== 'string') {
		return { fields: empty, missing: ['valid JSON array'] };
	}
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start < 0 || end <= start) {
		return { fields: empty, missing: ['valid JSON array'] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return { fields: empty, missing: ['valid JSON array'] };
	}
	if (!Array.isArray(parsed)) {
		return { fields: empty, missing: ['valid JSON array'] };
	}
	const fields = Array.from(
		{ length: expectedLength },
		() => null as ActionableDirectiveFields | null,
	);
	const missing: string[] = [];
	for (let i = 0; i < expectedLength; i++) {
		const item = parsed[i];
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			missing.push(`item ${i + 1}: valid JSON object`);
			continue;
		}
		const raw = item as Record<string, unknown>;
		const candidate: ActionableDirectiveFields = {};
		for (const key of ENRICHMENT_ALLOWED_FIELDS) {
			if (raw[key] !== undefined) {
				(candidate as Record<string, unknown>)[key] = raw[key];
			}
		}
		const shape = validateActionableFields(candidate);
		if (!shape.valid) {
			missing.push(`item ${i + 1}: ${shape.errors.join('; ')}`);
			continue;
		}
		const actionability = validateActionability(candidate);
		if (!actionability.actionable) {
			const expected: string[] = [];
			if (
				actionability.reason === 'missing_predicate' ||
				actionability.reason === 'missing_predicate_and_scope'
			) {
				expected.push(
					'a non-empty predicate field (forbidden_actions, required_actions, or verification_checks)',
				);
			}
			if (
				actionability.reason === 'missing_scope' ||
				actionability.reason === 'missing_predicate_and_scope'
			) {
				expected.push(
					'a non-empty scope field (applies_to_agents or applies_to_tools)',
				);
			}
			missing.push(`item ${i + 1}: ${expected.join('; ')}`);
			continue;
		}
		fields[i] = candidate;
	}
	if (parsed.length < expectedLength) {
		missing.push(`expected ${expectedLength} items but got ${parsed.length}`);
	} else if (parsed.length > expectedLength) {
		warn(
			`[knowledge-curator] parseV3BatchEnrichmentResponse received ${parsed.length} items but expected ${expectedLength}; extras will be discarded`,
		);
		missing.push(
			`got ${parsed.length} items but only first ${expectedLength} will be used; extras discarded`,
		);
	}
	return { fields, missing };
}

/**
 * Batch-enrich plain-prose lessons via the curator LLM with bounded retry.
 *
 * Behavior notes:
 * - Each batch attempt reserves 1 quota slot via `reserveQuota(scope: 'knowledge-enrichment')`.
 *   If the reservation is denied (quota exhausted), the inner attempt loop breaks and
 *   remaining batches also produce all-null results; the caller quarantines those lessons.
 * - Retry preserves already-resolved items: `best[i]` is only updated if it was null.
 *   This prevents a worse-quality retry from overwriting a good first-attempt result.
 * - Retry prompts explicitly instruct the LLM to preserve resolved items.
 * - The batch loop is sequential (no parallel batches) to keep quota accounting deterministic.
 */
async function enrichLessonsToV3Batched(params: {
	directory: string;
	llmDelegate: CuratorLLMDelegate;
	lessons: EnrichmentLessonInput[];
	quota?: EnrichmentQuotaOptions;
	batchSize?: number;
}): Promise<Array<ActionableDirectiveFields | null>> {
	const quota = params.quota ?? { maxCalls: 10, window: 'utc' as const };
	const out = Array.from(
		{ length: params.lessons.length },
		() => null as ActionableDirectiveFields | null,
	);
	const batchSize = params.batchSize ?? ENRICHMENT_BATCH_SIZE;
	for (let start = 0; start < params.lessons.length; start += batchSize) {
		const batch = params.lessons.slice(start, start + batchSize);
		const prompt = buildV3BatchEnrichmentPrompt(batch);
		let userInput = prompt;
		let best = Array.from(
			{ length: batch.length },
			() => null as ActionableDirectiveFields | null,
		);
		let retryHint = '';
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const reservation = await reserveQuota(params.directory, {
					nCalls: 1,
					maxCalls: quota.maxCalls,
					window: quota.window,
					scope: 'knowledge-enrichment',
				});
				if (!reservation.allowed) break;
				const response = await params.llmDelegate(
					'',
					userInput,
					AbortSignal.timeout(ENRICHMENT_LLM_TIMEOUT_MS),
				);
				const parsed = parseV3BatchEnrichmentResponse(response, batch.length);
				best = best.map((current, idx) => current ?? parsed.fields[idx]);
				const unresolved = best
					.map((fields, idx) => ({ fields, idx }))
					.filter((item) => item.fields === null)
					.map((item) => item.idx + 1);
				if (unresolved.length === 0) break;
				retryHint = parsed.missing.join('; ');
				const resolvedList = best
					.map((fields, idx) => ({ fields, idx }))
					.filter((item) => item.fields !== null)
					.map((item) => item.idx + 1);
				const preserveClause =
					resolvedList.length > 0
						? `Preserve the already-valid entries for items ${resolvedList.join(', ')} exactly as you returned them previously. `
						: '';
				userInput = `${prompt}\n\nRETRY: your last output still missed valid directives for items ${unresolved.join(
					', ',
				)}. ${retryHint} ${preserveClause}Return a full JSON array with valid entries for every item.`;
			} catch (err) {
				warn(
					`[knowledge-curator] v3 batch enrichment attempt ${attempt + 1} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
		for (let i = 0; i < best.length; i++) {
			out[start + i] = best[i];
		}
	}
	return out;
}

/** Per-call timeout for enrichment LLM calls (small, targeted prompts). */
const ENRICHMENT_LLM_TIMEOUT_MS = 60_000;
/** Max lessons enriched per LLM call (batch mode). */
export const ENRICHMENT_BATCH_SIZE = 6;

export interface EnrichmentQuotaOptions {
	maxCalls: number;
	window: 'utc' | 'local';
}

interface EnrichmentLessonInput {
	lesson: string;
	category: string;
	tags: string[];
}

/**
 * Enrich one prose lesson with v3 actionability fields via the curator LLM.
 * One retry on schema failure (with a RETRY message naming the missing
 * fields). Quota-gated per call via the dedicated knowledge-enrichment quota.
 * Returns null when
 * enrichment is unavailable (quota exhausted) or fails twice — the caller
 * quarantines the entry. Never throws.
 */
export async function enrichLessonToV3(params: {
	directory: string;
	llmDelegate: CuratorLLMDelegate;
	lesson: string;
	category: string;
	tags: string[];
	quota?: EnrichmentQuotaOptions;
}): Promise<ActionableDirectiveFields | null> {
	const quota = params.quota ?? { maxCalls: 10, window: 'utc' as const };
	const prompt = buildV3EnrichmentPrompt(
		params.lesson,
		params.category,
		params.tags,
	);
	let userInput = prompt;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const reservation = await reserveQuota(params.directory, {
				nCalls: 1,
				maxCalls: quota.maxCalls,
				window: quota.window,
				scope: 'knowledge-enrichment',
			});
			if (!reservation.allowed) return null;
			const response = await params.llmDelegate(
				'',
				userInput,
				AbortSignal.timeout(ENRICHMENT_LLM_TIMEOUT_MS),
			);
			const result = parseV3EnrichmentResponse(response);
			if ('fields' in result) return result.fields;
			userInput = `${prompt}\n\nRETRY: your last output was missing ${result.missing.join(
				'; ',
			)}; produce valid JSON with all required fields.`;
		} catch (err) {
			warn(
				`[knowledge-curator] v3 enrichment attempt ${attempt + 1} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			// LLM/transport error: do not retry on a second transport failure path —
			// the loop's second iteration is the single retry budget either way.
		}
	}
	return null;
}

/** Append a curator_skipped audit line to `.swarm/events.jsonl` (best-effort). */
async function appendCuratorSkippedEvent(
	directory: string,
	record: { entry_id: string; lesson: string; reason: string },
): Promise<void> {
	try {
		const filePath = path.join(directory, '.swarm', 'events.jsonl');
		await mkdir(path.dirname(filePath), { recursive: true });
		await appendFile(
			filePath,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				event: 'curator_skipped',
				entry_id: record.entry_id,
				lesson: record.lesson.slice(0, 200),
				reason: record.reason,
			})}\n`,
			'utf-8',
		);
	} catch {
		// audit log is best-effort; never break curation
	}
}

// ============================================================================
// Meso reflector — micro-reflection insight consumption (Change 6, Task 5.2)
// ============================================================================

/** Max insight candidates folded into the store per phase boundary. */
export const MESO_INSIGHT_BATCH_LIMIT = 20;

const KNOWLEDGE_CATEGORIES: ReadonlySet<string> = new Set<KnowledgeCategory>([
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
]);

function readInsightJsonl(content: string): InsightCandidate[] {
	const out: InsightCandidate[] = [];
	for (const line of content.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as InsightCandidate);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}

/**
 * Atomically consume up to `batchLimit` insight candidates from
 * `.swarm/insight-candidates.jsonl`, writing back the unconsumed tail under the
 * same lock so concurrent micro-reflection appends are never lost. Fail-open.
 */
export async function consumeInsightCandidates(
	directory: string,
	batchLimit = MESO_INSIGHT_BATCH_LIMIT,
): Promise<InsightCandidate[]> {
	try {
		const filePath = resolveInsightCandidatesPath(directory);
		if (!existsSync(filePath)) return [];
		const consumed: InsightCandidate[] = [];
		await transactFile<InsightCandidate[]>(
			filePath,
			async (p) => readInsightJsonl(await readFile(p, 'utf-8').catch(() => '')),
			async (p, data) => {
				// transactFile already mkdir'd the directory under the lock.
				const body =
					data.length === 0
						? ''
						: `${data.map((c) => JSON.stringify(c)).join('\n')}\n`;
				await writeFile(p, body, 'utf-8');
			},
			(all) => {
				if (all.length === 0) return null;
				const batch = all.slice(0, batchLimit);
				consumed.push(...batch);
				return all.slice(batch.length); // unconsumed tail (possibly empty)
			},
		);
		return consumed;
	} catch {
		return [];
	}
}

/** Build a SwarmKnowledgeEntry from an already-v3-actionable insight candidate. */
export function insightCandidateToEntry(
	cand: InsightCandidate,
	projectName: string,
	phaseNumber: number,
	config: KnowledgeConfig,
): SwarmKnowledgeEntry {
	const now = new Date().toISOString();
	const category = (
		typeof cand.category === 'string' && KNOWLEDGE_CATEGORIES.has(cand.category)
			? cand.category
			: 'process'
	) as KnowledgeCategory;
	return {
		id: crypto.randomUUID(),
		tier: 'swarm',
		lesson: cand.lesson.slice(0, 280),
		category,
		tags: Array.isArray(cand.tags) ? cand.tags.slice(0, 20) : [],
		scope: 'global',
		confidence: computeConfidence(1, true),
		status: 'candidate',
		confirmed_by: [
			{
				phase_number: phaseNumber,
				confirmed_at: now,
				project_name: projectName,
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: config.schema_version,
		created_at: now,
		updated_at: now,
		project_name: projectName,
		auto_generated: true,
		applies_to_agents: cand.applies_to_agents,
		applies_to_tools: cand.applies_to_tools,
		required_actions: cand.required_actions,
		forbidden_actions: cand.forbidden_actions,
		verification_checks: cand.verification_checks,
		triggers: cand.triggers,
		directive_priority: cand.directive_priority,
		source_knowledge_ids: cand.source?.task_id
			? [`task:${cand.source.task_id}`]
			: undefined,
	};
}

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
	options?: {
		skipAutoPromotion?: boolean;
		/**
		 * Change 4 (Task 4.2): LLM delegate used to enrich plain-prose lessons
		 * with v3 actionability fields before the Layer-5 gate. When absent,
		 * non-actionable lessons go straight to the unactionable queue.
		 */
		llmDelegate?: CuratorLLMDelegate;
		/** Quota knobs for enrichment calls (defaults: 10/day, utc window). */
		enrichmentQuota?: EnrichmentQuotaOptions;
	},
): Promise<{
	stored: number;
	reinforced: number;
	skipped: number;
	rejected: number;
	quarantined: number;
}> {
	const knowledgePath = resolveSwarmKnowledgePath(directory);

	// Unlocked snapshot read for validation purposes only.
	// Dedup against the final on-disk state happens atomically inside
	// transactKnowledge below (CF-2 prevention).
	const snapshot =
		(await readKnowledge<SwarmKnowledgeEntry>(knowledgePath)) ?? [];

	let skipped = 0;
	let rejected = 0;
	let quarantined = 0;

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

	// Pre-compute new entries using the snapshot for validation and initial dedup.
	// The in-progress accumulator (snapshotPlusNew) prevents intra-batch duplicates.
	const snapshotPlusNew: SwarmKnowledgeEntry[] = [...snapshot];
	const toAdd: SwarmKnowledgeEntry[] = [];
	const pendingReinforcementIds = new Set<string>();
	const pendingBatchEnrichment: Array<{
		entry: SwarmKnowledgeEntry;
		lesson: string;
		category: string;
		tags: string[];
	}> = [];

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

		// Validate the lesson if validation_enabled is set in config
		if (config.validation_enabled !== false) {
			const result = validateLesson(
				lesson,
				snapshotPlusNew.map((e) => e.lesson),
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
				await appendRejectedLesson(
					directory,
					rejectedLesson,
					config.rejected_max_entries,
				);
				rejected++;
				continue;
			}
		}

		// Check for near-duplicates against snapshot + already-planned new entries
		const duplicate = findActiveSwarmNearDuplicate(
			lesson,
			snapshotPlusNew,
			config.dedup_threshold,
		);
		if (duplicate) {
			pendingReinforcementIds.add(duplicate.id);
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

		// Layer 5 — Mandatory v3 actionability (Change 4). No new entry reaches the
		// active store without >=1 machine-checkable predicate AND >=1 scope tag.
		// Plain-prose lessons are enriched via the curator LLM (one retry); entries
		// that still fail are quarantined to the unactionable queue (recoverable by
		// the skill-improver hardening loop), never activated.
		const actionability = validateActionability(entry);
		if (!actionability.actionable && options?.llmDelegate) {
			pendingBatchEnrichment.push({ entry, lesson, category, tags });
			continue;
		}
		if (!actionability.actionable) {
			quarantined++;
			try {
				await appendUnactionable(
					directory,
					entry,
					actionability.reason ?? 'unactionable',
				);
			} catch {
				// queue write is best-effort; the entry is still withheld from active
			}
			await appendCuratorSkippedEvent(directory, {
				entry_id: entry.id,
				lesson,
				reason: actionability.reason ?? 'unactionable',
			});
			continue;
		}

		toAdd.push(entry);
		// Track in accumulator so subsequent lessons in this batch see it for dedup.
		snapshotPlusNew.push(entry);
	}

	if (pendingBatchEnrichment.length > 0 && options?.llmDelegate) {
		const enrichedBatch = await enrichLessonsToV3Batched({
			directory,
			llmDelegate: options.llmDelegate,
			lessons: pendingBatchEnrichment.map((item) => ({
				lesson: item.lesson,
				category: item.category,
				tags: item.tags,
			})),
			quota: options.enrichmentQuota,
			batchSize: config.enrichment?.batch_size,
		});
		for (let i = 0; i < pendingBatchEnrichment.length; i++) {
			const pending = pendingBatchEnrichment[i];
			const enriched = enrichedBatch[i];
			if (enriched) {
				Object.assign(pending.entry, enriched);
			}
			const actionability = validateActionability(pending.entry);
			if (!actionability.actionable) {
				quarantined++;
				try {
					await appendUnactionable(
						directory,
						pending.entry,
						actionability.reason ?? 'unactionable',
					);
				} catch {
					// queue write is best-effort; the entry is still withheld from active
				}
				await appendCuratorSkippedEvent(directory, {
					entry_id: pending.entry.id,
					lesson: pending.lesson,
					reason: actionability.reason ?? 'unactionable',
				});
				continue;
			}
			toAdd.push(pending.entry);
			snapshotPlusNew.push(pending.entry);
		}
	}

	// Meso reflector (Change 6, Task 5.2): fold in micro-reflection insight
	// candidates. They are already v3-actionable, so they skip enrichment and go
	// straight through the actionability gate + dedup against the retro lessons
	// and the existing store. This EXPANDS the curator's inputs without lowering
	// its output floor. Consumed atomically so concurrent micro-appends survive.
	try {
		const insights = await consumeInsightCandidates(directory);
		for (const cand of insights) {
			const entry = insightCandidateToEntry(
				cand,
				projectName,
				phaseInfo.phase_number,
				config,
			);
			// Defense-in-depth (Phase 5 review): the insight-candidates queue is an
			// on-disk file that could be tampered between the micro-reflector's write
			// and this read, so re-apply BOTH gates the micro-reflector applied at
			// write time — shape (validateActionableFields: length caps, name
			// patterns, injection/control-char checks) AND presence
			// (validateActionability). insightCandidateToEntry already copies only an
			// explicit field allowlist (verification_predicate is never carried), so
			// these two checks fully reconstruct the original gate.
			const shape = validateActionableFields({
				applies_to_agents: entry.applies_to_agents,
				applies_to_tools: entry.applies_to_tools,
				required_actions: entry.required_actions,
				forbidden_actions: entry.forbidden_actions,
				verification_checks: entry.verification_checks,
				triggers: entry.triggers,
				directive_priority: entry.directive_priority,
			});
			if (!shape.valid || !validateActionability(entry).actionable) {
				quarantined++;
				try {
					await appendUnactionable(directory, entry, 'insight_unactionable');
				} catch {
					// best-effort
				}
				continue;
			}
			const duplicate = findActiveSwarmNearDuplicate(
				entry.lesson,
				snapshotPlusNew,
				config.dedup_threshold,
			);
			if (duplicate) {
				pendingReinforcementIds.add(duplicate.id);
				skipped++;
				continue;
			}
			toAdd.push(entry);
			snapshotPlusNew.push(entry);
		}
	} catch {
		// insight consumption is best-effort; never break curation
	}

	// Atomically append new entries under lock (CF-2: dedup at commit time against
	// fresh disk state prevents two concurrent curator calls from both appending the
	// same lesson).
	let stored = 0;
	let reinforced = 0;
	if (toAdd.length > 0 || pendingReinforcementIds.size > 0) {
		await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (current) => {
			let changed = false;

			for (const id of pendingReinforcementIds) {
				const existing = current.find((entry) => entry.id === id);
				if (!existing) continue;
				const result = reinforceSwarmKnowledgeEntry(existing, {
					phase_number: phaseInfo.phase_number,
					confirmed_at: new Date().toISOString(),
					project_name: projectName,
				});
				if (result.reinforced) {
					reinforced++;
					changed = true;
				}
			}

			const trulyNew: SwarmKnowledgeEntry[] = [];
			for (const entry of toAdd) {
				const duplicate = findActiveSwarmNearDuplicate(
					entry.lesson,
					current,
					config.dedup_threshold,
				);
				if (duplicate) {
					skipped++;
					const result = reinforceSwarmKnowledgeEntry(duplicate, {
						phase_number: phaseInfo.phase_number,
						confirmed_at: new Date().toISOString(),
						project_name: projectName,
					});
					if (result.reinforced) {
						reinforced++;
						changed = true;
					}
					continue;
				}
				trulyNew.push(entry);
			}

			if (trulyNew.length > 0) {
				current.push(...trulyNew);
				stored = trulyNew.length;
				changed = true;
			}

			return changed ? current : null;
		});
	}

	// Enforce swarm_max_entries cap (FIFO: drop oldest when exceeded)
	await enforceKnowledgeCap(knowledgePath, config.swarm_max_entries);

	// Change 5 / Task 6.2: refresh the tag co-occurrence synonym map from the
	// post-write corpus so retrieval can expand queries along learned synonyms.
	// Only when the corpus actually changed (something stored) — a no-op curation
	// run leaves the tag distribution untouched. Best-effort: a failure here must
	// never break curation, and the retrieval read path degrades to no-expansion
	// when the map is absent. The map is bounded by synonym_map_max_pairs.
	if (stored > 0) {
		try {
			const corpus =
				(await readKnowledge<SwarmKnowledgeEntry>(knowledgePath)) ?? [];
			await rebuildSynonymMap(
				directory,
				corpus.map((e) => ({
					triggers: e.triggers,
					tags: e.tags,
					applies_to_tools: e.applies_to_tools,
					applies_to_agents: e.applies_to_agents,
				})),
				config.retrieval?.synonym_map_max_pairs,
			);
		} catch {
			// synonym map refresh is best-effort; never break curation
		}
	}

	// Run auto-promotion after processing all lessons. Callers that only want to PROPOSE
	// candidate knowledge (e.g. the architecture supervisor's recommendations) pass
	// skipAutoPromotion to avoid promoting unrelated pre-existing candidates as a side
	// effect of this write (issue #893).
	if (!options?.skipAutoPromotion) {
		await _internals.runAutoPromotion(directory, config);
	}

	return { stored, reinforced, skipped, rejected, quarantined };
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
	const counterRollups = await readKnowledgeCounterRollups(directory);

	let changed = false;

	for (const entry of entries) {
		// Skip already promoted entries
		if (entry.status === 'promoted') continue;

		// Event-sourced safety gate: a clearly negative track record blocks
		// auto-promotion regardless of phase confirmations or age. Entries with no
		// outcome history (signal 0) are unaffected, preserving prior behavior.
		if (
			computeOutcomeSignal(
				effectiveRetrievalOutcomes(
					entry.retrieval_outcomes,
					counterRollups.get(entry.id),
				),
			) <= OUTCOME_PROMOTION_BLOCK
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
export interface KnowledgeCuratorHookOptions {
	llmDelegateFactory?: (sessionID: string) => CuratorLLMDelegate | undefined;
	enrichmentQuota?: EnrichmentQuotaOptions;
}

export function createKnowledgeCuratorHook(
	directory: string,
	config: KnowledgeConfig,
	options: KnowledgeCuratorHookOptions = {},
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
			const evidenceHash = hashContent(JSON.stringify(lessons));
			if (lastSeenEvidence?.value === evidenceHash) {
				return; // no change
			}
			recordSeenRetroSection(evidenceKey, evidenceHash, Date.now());

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
				{
					llmDelegate: options.llmDelegateFactory?.(sessionID),
					enrichmentQuota: options.enrichmentQuota,
				},
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
			{
				llmDelegate: options.llmDelegateFactory?.(sessionID),
				enrichmentQuota: options.enrichmentQuota,
			},
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
	seenRetroSections: typeof seenRetroSections;
	recordSeenRetroSection: typeof recordSeenRetroSection;
	hashContent: typeof hashContent;
	capSeenRetroSections: typeof capSeenRetroSections;
	MAX_TRACKED_RETRO_SECTIONS: number;
} = {
	isWriteToEvidenceFile,
	curateAndStoreSwarm,
	runAutoPromotion,
	createKnowledgeCuratorHook,
	seenRetroSections,
	recordSeenRetroSection,
	hashContent,
	capSeenRetroSections,
	MAX_TRACKED_RETRO_SECTIONS,
};
