/** Knowledge query tool for architect-level access to swarm and hive knowledge.
 * Provides filtered, formatted text output for knowledge retrieval.
 */

import { existsSync } from 'node:fs';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import {
	normalize,
	readKnowledge,
	readRetractionRecords,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 10;
const MAX_LESSON_LENGTH = 200; // Truncate lesson if longer than this

// Valid categories for filtering
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

// Valid statuses for filtering
const VALID_STATUSES = [
	'candidate',
	'established',
	'promoted',
	'archived',
] as const;
const DEFAULT_QUERY_STATUSES = new Set(['established', 'promoted']);

// Valid tiers for filtering
const VALID_TIERS = ['swarm', 'hive', 'all'] as const;

// ============================================================================
// Types
// ============================================================================

type TierInput = (typeof VALID_TIERS)[number];
type StatusInput = (typeof VALID_STATUSES)[number];

// ============================================================================
// Validation Functions
// ============================================================================

function validateTierInput(tier: unknown): TierInput | null {
	if (typeof tier !== 'string') return null;
	const normalized = tier.toLowerCase().trim();
	if (VALID_TIERS.includes(normalized as TierInput)) {
		return normalized as TierInput;
	}
	return null;
}

function validateStatusInput(status: unknown): StatusInput | null {
	if (typeof status !== 'string') return null;
	const normalized = status.toLowerCase().trim();
	if (VALID_STATUSES.includes(normalized as StatusInput)) {
		return normalized as StatusInput;
	}
	return null;
}

function validateCategoryInput(category: unknown): KnowledgeCategory | null {
	if (typeof category !== 'string') return null;
	const normalized = category.toLowerCase().trim();
	if (VALID_CATEGORIES.includes(normalized as KnowledgeCategory)) {
		return normalized as KnowledgeCategory;
	}
	return null;
}

function validateMinScore(score: unknown): number | null {
	if (typeof score === 'number' && !Number.isNaN(score)) {
		return Math.max(0, Math.min(1, score));
	}
	if (typeof score === 'string') {
		const parsed = Number.parseFloat(score);
		if (!Number.isNaN(parsed)) {
			return Math.max(0, Math.min(1, parsed));
		}
	}
	return null;
}

function validateLimit(limit: unknown): number {
	if (typeof limit === 'number' && !Number.isNaN(limit) && limit > 0) {
		return Math.min(limit, 100); // Cap at 100
	}
	if (typeof limit === 'string') {
		const parsed = Number.parseInt(limit, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			return Math.min(parsed, 100);
		}
	}
	return DEFAULT_LIMIT;
}

// ============================================================================
// Data Reading Functions
// ============================================================================

async function readSwarmKnowledge(
	directory: string,
): Promise<SwarmKnowledgeEntry[]> {
	const swarmPath = resolveSwarmKnowledgePath(directory);
	if (!existsSync(swarmPath)) {
		return [];
	}
	return readKnowledge<SwarmKnowledgeEntry>(swarmPath);
}

async function readHiveKnowledge(): Promise<HiveKnowledgeEntry[]> {
	const hivePath = resolveHiveKnowledgePath();
	if (!existsSync(hivePath)) {
		return [];
	}
	return readKnowledge<HiveKnowledgeEntry>(hivePath);
}

// ============================================================================
// Filtering Functions
// ============================================================================

interface FilterOptions {
	status?: StatusInput;
	category?: KnowledgeCategory;
	minScore?: number;
}

function filterSwarmEntries(
	entries: SwarmKnowledgeEntry[],
	filters: FilterOptions,
	suppressedLessons: Set<string>,
	scopeFilter?: string[],
): SwarmKnowledgeEntry[] {
	return entries.filter((entry) => {
		if (filters.status) {
			if (entry.status !== filters.status) {
				return false;
			}
		} else if (!DEFAULT_QUERY_STATUSES.has(entry.status)) {
			return false;
		}
		if (filters.category && entry.category !== filters.category) {
			return false;
		}
		if (filters.minScore !== undefined && entry.confidence < filters.minScore) {
			return false;
		}
		// Apply scope_filter (same logic as knowledge-reader.ts)
		if (scopeFilter && scopeFilter.length > 0) {
			const entryScope = entry.scope ?? 'global';
			if (!scopeFilter.some((pattern) => entryScope === pattern)) {
				return false;
			}
		}
		if (suppressedLessons.has(normalize(entry.lesson))) {
			return false;
		}
		return true;
	});
}

function filterHiveEntries(
	entries: HiveKnowledgeEntry[],
	filters: FilterOptions,
	suppressedLessons: Set<string>,
): HiveKnowledgeEntry[] {
	return entries.filter((entry) => {
		if (filters.status) {
			if (entry.status !== filters.status) {
				return false;
			}
		} else if (!DEFAULT_QUERY_STATUSES.has(entry.status)) {
			return false;
		}
		if (filters.category && entry.category !== filters.category) {
			return false;
		}
		if (filters.minScore !== undefined && entry.confidence < filters.minScore) {
			return false;
		}
		if (suppressedLessons.has(normalize(entry.lesson))) {
			return false;
		}
		return true;
	});
}

// ============================================================================
// Formatting Functions
// ============================================================================

function truncateLesson(lesson: string, maxLength: number): string {
	if (lesson.length <= maxLength) {
		return lesson;
	}
	return `${lesson.slice(0, maxLength - 3)}...`;
}

function formatSwarmEntry(entry: SwarmKnowledgeEntry): string {
	const lines: string[] = [];
	lines.push(`[${entry.tier.toUpperCase()}] ${entry.id}`);
	lines.push(`  Lesson: ${truncateLesson(entry.lesson, MAX_LESSON_LENGTH)}`);
	lines.push(`  Category: ${entry.category}`);
	lines.push(`  Status: ${entry.status}`);
	lines.push(`  Confidence: ${entry.confidence.toFixed(2)}`);
	lines.push(`  Confirmed by: ${entry.confirmed_by.length} phase(s)`);
	lines.push(`  Project: ${entry.project_name}`);
	return lines.join('\n');
}

function formatHiveEntry(entry: HiveKnowledgeEntry): string {
	const lines: string[] = [];
	lines.push(`[${entry.tier.toUpperCase()}] ${entry.id}`);
	lines.push(`  Lesson: ${truncateLesson(entry.lesson, MAX_LESSON_LENGTH)}`);
	lines.push(`  Category: ${entry.category}`);
	lines.push(`  Status: ${entry.status}`);
	lines.push(`  Confidence: ${entry.confidence.toFixed(2)}`);
	lines.push(
		`  Encounter Score: ${entry.encounter_score?.toFixed(2) ?? 'N/A'}`,
	);
	lines.push(`  Source Project: ${entry.source_project}`);
	lines.push(`  Confirmed by: ${entry.confirmed_by.length} project(s)`);
	return lines.join('\n');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const knowledge_query: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Query swarm knowledge (project-level) or hive knowledge (cross-project) with optional filters. Returns human-readable formatted text output. Use tier "all" to query both swarm and hive knowledge.',
	args: {
		tier: z
			.string()
			.optional()
			.describe(
				"Knowledge tier to query: 'swarm', 'hive', or 'all' (default: 'all')",
			),
		status: z
			.string()
			.optional()
			.describe(
				"Filter by status: 'candidate', 'established', 'promoted', or 'archived'",
			),
		category: z
			.string()
			.optional()
			.describe(
				"Filter by category: 'process', 'architecture', 'tooling', 'security', 'testing', 'debugging', 'performance', 'integration', 'todo', or 'other'",
			),
		min_score: z
			.number()
			.optional()
			.describe('Minimum confidence score filter (0.0-1.0)'),
		limit: z
			.number()
			.optional()
			.describe(
				`Maximum number of results to return (default: ${DEFAULT_LIMIT}, max: 100)`,
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let tierInput: unknown;
		let statusInput: unknown;
		let categoryInput: unknown;
		let minScoreInput: unknown;
		let limitInput: unknown;

		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				tierInput = obj.tier;
				statusInput = obj.status;
				categoryInput = obj.category;
				minScoreInput = obj.min_score;
				limitInput = obj.limit;
			}
		} catch {
			// Malicious getter threw
		}

		// Validate inputs
		const tier = validateTierInput(tierInput) ?? 'all';
		const status = validateStatusInput(statusInput) ?? null;
		const category = validateCategoryInput(categoryInput) ?? null;
		const minScore = validateMinScore(minScoreInput) ?? null;
		const limit = validateLimit(limitInput);

		const filters: FilterOptions = {
			status: status ?? undefined,
			category: category ?? undefined,
			minScore: minScore ?? undefined,
		};
		const retractionRecords = await readRetractionRecords(directory);
		const suppressedLessons = new Set(
			retractionRecords
				.map((record) => record.normalized_lesson)
				.filter(
					(value): value is string =>
						typeof value === 'string' && value.length > 0,
				),
		);

		// Collect results
		const results: {
			entry: SwarmKnowledgeEntry | HiveKnowledgeEntry;
			tier: 'swarm' | 'hive';
		}[] = [];

		// Read scope_filter from config (same as knowledge-reader.ts)
		let scopeFilter: string[] | undefined;
		try {
			const { config } = loadPluginConfigWithMeta(directory);
			scopeFilter = config.knowledge?.scope_filter;
		} catch {
			// Config load failure — skip scope filtering
		}

		// Read swarm knowledge if requested
		if (tier === 'swarm' || tier === 'all') {
			const swarmEntries = await readSwarmKnowledge(directory);
			const filtered = filterSwarmEntries(
				swarmEntries,
				filters,
				suppressedLessons,
				scopeFilter,
			);
			for (const entry of filtered) {
				results.push({ entry, tier: 'swarm' });
			}
		}

		// Read hive knowledge if requested
		if (tier === 'hive' || tier === 'all') {
			const hiveEntries = await readHiveKnowledge();
			const filtered = filterHiveEntries(
				hiveEntries,
				filters,
				suppressedLessons,
			);
			for (const entry of filtered) {
				results.push({ entry, tier: 'hive' });
			}
		}

		// Apply limit
		const limitedResults = results.slice(0, limit);

		// Format output as text
		if (limitedResults.length === 0) {
			const tierDesc = tier === 'all' ? 'swarm or hive' : tier;
			const filterParts: string[] = [];
			if (status) filterParts.push(`status=${status}`);
			if (category) filterParts.push(`category=${category}`);
			if (minScore !== null) filterParts.push(`min_score=${minScore}`);
			const filterDesc =
				filterParts.length > 0
					? ` with filters: ${filterParts.join(', ')}`
					: '';
			return `No knowledge entries found for tier '${tierDesc}'${filterDesc}.`;
		}

		// Build output
		const outputLines: string[] = [];
		outputLines.push(
			`=== Knowledge Query Results (${limitedResults.length} of ${results.length} shown) ===`,
		);
		outputLines.push('');

		for (const { entry, tier: entryTier } of limitedResults) {
			if (entryTier === 'hive') {
				outputLines.push(formatHiveEntry(entry as HiveKnowledgeEntry));
			} else {
				outputLines.push(formatSwarmEntry(entry as SwarmKnowledgeEntry));
			}
			outputLines.push('');
		}

		// Add summary
		outputLines.push(`---`);
		outputLines.push(
			`Total matched: ${results.length} | Tier: ${tier} | Limit: ${limit}`,
		);
		if (status) outputLines.push(`Status filter: ${status}`);
		if (category) outputLines.push(`Category filter: ${category}`);
		if (minScore !== null) outputLines.push(`Min score filter: ${minScore}`);

		return outputLines.join('\n');
	},
});

// Test seam — exported for direct unit testing only
export const _test_exports = {
	formatHiveEntry,
};
