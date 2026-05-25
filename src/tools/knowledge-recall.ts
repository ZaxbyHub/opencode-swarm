import { z } from 'zod';
import {
	jaccardBigram,
	normalize,
	readKnowledge,
	readRetractionRecords,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	wordBigrams,
} from '../hooks/knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

interface ScoredEntry {
	id: string;
	confidence: number;
	category: string;
	lesson: string;
	score: number;
}

interface KnowledgeRecallResult {
	results: ScoredEntry[];
	total: number;
}

const NORMAL_RETRIEVAL_STATUSES = new Set(['established', 'promoted']);

export const knowledge_recall: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Search the knowledge base for relevant past decisions, patterns, and lessons learned. Returns ranked results by semantic similarity.',
		args: {
			query: z.string().min(3).describe('Natural language search query'),
			top_n: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe('Maximum results to return (default: 5)'),
			tier: z
				.enum(['all', 'swarm', 'hive'])
				.optional()
				.describe("Knowledge tier to search (default: 'all')"),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let queryInput: unknown;
			let topNInput: unknown;
			let tierInput: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					queryInput = obj.query;
					topNInput = obj.top_n;
					tierInput = obj.tier;
				}
			} catch {
				// Malicious getter threw
			}

			// Validate query
			if (typeof queryInput !== 'string' || queryInput.length < 3) {
				return JSON.stringify({
					results: [],
					total: 0,
					error: 'query must be a string with at least 3 characters',
				});
			}

			// Parse top_n with default
			let topN = 5;
			if (topNInput !== undefined) {
				if (typeof topNInput === 'number' && Number.isInteger(topNInput)) {
					topN = Math.max(1, Math.min(20, topNInput));
				}
			}

			// Parse tier with default
			let tier: 'all' | 'swarm' | 'hive' = 'all';
			if (tierInput !== undefined && typeof tierInput === 'string') {
				if (tierInput === 'swarm' || tierInput === 'hive') {
					tier = tierInput;
				}
			}

			// Step 1: Read all entries from swarm and hive knowledge files
			const swarmPath = resolveSwarmKnowledgePath(directory);
			const hivePath = resolveHiveKnowledgePath();

			const [swarmEntries, hiveEntries] = await Promise.all([
				readKnowledge<SwarmKnowledgeEntry>(swarmPath),
				readKnowledge<HiveKnowledgeEntry>(hivePath),
			]);

			// Step 2: Combine into single array based on tier filter
			let entries: (SwarmKnowledgeEntry | HiveKnowledgeEntry)[] = [];
			if (tier === 'all' || tier === 'swarm') {
				entries = entries.concat(swarmEntries);
			}
			if (tier === 'all' || tier === 'hive') {
				entries = entries.concat(hiveEntries);
			}

			// Step 3: Filter out entries that are not mature enough for normal recall.
			const retractions = await readRetractionRecords(directory);
			const suppressedLessons = new Set(
				retractions
					.map((record) => record.normalized_lesson)
					.filter(
						(value): value is string =>
							typeof value === 'string' && value.length > 0,
					),
			);
			entries = entries.filter(
				(entry) =>
					NORMAL_RETRIEVAL_STATUSES.has(entry.status) &&
					!suppressedLessons.has(normalize(entry.lesson)),
			);

			// Step 3b: Empty store check
			if (entries.length === 0) {
				const result: KnowledgeRecallResult = { results: [], total: 0 };
				return JSON.stringify(result);
			}

			// Step 4: Normalize query and generate bigrams
			const normalizedQuery = normalize(queryInput);
			const queryBigrams = wordBigrams(normalizedQuery);

			// Step 5-6: Score each entry
			const scoredEntries: ScoredEntry[] = entries.map((entry) => {
				const entryText = `${entry.lesson} ${entry.tags.join(' ')} ${entry.category}`;
				const entryBigrams = wordBigrams(entryText);

				const textScore = jaccardBigram(queryBigrams, entryBigrams);

				const boost =
					entry.status === 'established'
						? 0.1
						: entry.status === 'promoted'
							? 0.05
							: 0;
				const finalScore = textScore + boost;

				return {
					id: entry.id,
					confidence: entry.confidence,
					category: entry.category,
					lesson: entry.lesson,
					score: finalScore,
				};
			});

			// Step 7: Sort by score descending
			scoredEntries.sort((a, b) => b.score - a.score);

			// Step 8: Return top N results
			const topResults = scoredEntries.slice(0, topN);
			const result: KnowledgeRecallResult = {
				results: topResults,
				total: topResults.length,
			};

			return JSON.stringify(result);
		},
	});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	knowledge_recall: typeof knowledge_recall;
} = {
	knowledge_recall,
} as const;
