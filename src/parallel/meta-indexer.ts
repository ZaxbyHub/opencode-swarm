import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../utils/logger.js';

export interface MetaSummaryEntry {
	timestamp: string;
	phase?: number;
	taskId?: string;
	agent?: string;
	summary: string;
	source?: string;
}

const INDEX_FILE = 'summary-index.jsonl';

/**
 * Extract meta.summary from event JSONL files
 */
export function extractMetaSummaries(eventsPath: string): MetaSummaryEntry[] {
	const entries: MetaSummaryEntry[] = [];

	if (!fs.existsSync(eventsPath)) {
		return entries;
	}

	const lines = fs
		.readFileSync(eventsPath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim());

	for (const line of lines) {
		try {
			const event = JSON.parse(line);

			// Check for meta.summary field
			if (event.meta?.summary) {
				entries.push({
					timestamp: event.timestamp || new Date().toISOString(),
					phase: event.phase,
					taskId: event.taskId,
					agent: event.agent || event.meta?.agent,
					summary: event.meta.summary,
					source: eventsPath,
				});
			}

			// Also check direct summary field
			if (event.summary && !event.meta?.summary) {
				entries.push({
					timestamp: event.timestamp || new Date().toISOString(),
					phase: event.phase,
					taskId: event.taskId,
					agent: event.agent,
					summary: event.summary,
					source: eventsPath,
				});
			}
		} catch (error) {
			// Log error for debugging but continue processing
			log(
				`[meta-indexer] Failed to parse line: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries;
}

/**
 * Index meta summaries to external knowledge store
 */
export async function indexMetaSummaries(
	directory: string,
	externalKnowledgeDir?: string,
): Promise<{ indexed: number; path: string }> {
	// Get external knowledge path or use default
	const indexDir = externalKnowledgeDir || path.join(directory, '.swarm');
	const indexPath = path.join(indexDir, INDEX_FILE);

	// Ensure directory exists
	try {
		if (!fs.existsSync(indexDir)) {
			fs.mkdirSync(indexDir, { recursive: true });
		}
	} catch {
		// Invalid path (e.g. path traversal pointing to a file, null bytes) - skip indexing
		return { indexed: 0, path: indexPath };
	}

	// Read existing index
	const existingEntries = new Set<string>();
	if (fs.existsSync(indexPath)) {
		const lines = fs
			.readFileSync(indexPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim());

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				// Use timestamp+summary as unique key
				existingEntries.add(`${entry.timestamp}:${entry.summary}`);
			} catch (error) {
				// Log error but continue processing
				log(
					`[meta-indexer] Failed to parse index entry: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	// Extract from events.jsonl (respect externalKnowledgeDir if provided)
	const eventsDir = externalKnowledgeDir || path.join(directory, '.swarm');
	const eventsPath = path.join(eventsDir, 'events.jsonl');
	const newEntries = extractMetaSummaries(eventsPath);

	// Filter out duplicates
	const uniqueEntries = newEntries.filter((entry) => {
		const key = `${entry.timestamp}:${entry.summary}`;
		return !existingEntries.has(key);
	});

	// Append new entries
	if (uniqueEntries.length > 0) {
		const lines = uniqueEntries.map((e) => JSON.stringify(e)).join('\n');
		fs.appendFileSync(indexPath, `${lines}\n`, 'utf-8');
	}

	return {
		indexed: uniqueEntries.length,
		path: indexPath,
	};
}

/**
 * Query indexed summaries
 */
export function querySummaries(
	directory: string,
	options: {
		phase?: number;
		taskId?: string;
		agent?: string;
		since?: string;
	} = {},
): MetaSummaryEntry[] {
	const indexPath = path.join(directory, '.swarm', INDEX_FILE);

	if (!fs.existsSync(indexPath)) {
		return [];
	}

	const lines = fs
		.readFileSync(indexPath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim());

	const entries: MetaSummaryEntry[] = [];

	for (const line of lines) {
		try {
			const entry: MetaSummaryEntry = JSON.parse(line);

			// Apply filters
			if (options.phase !== undefined && entry.phase !== options.phase) {
				continue;
			}
			if (options.taskId && entry.taskId !== options.taskId) {
				continue;
			}
			if (options.agent && entry.agent !== options.agent) {
				continue;
			}
			if (options.since && entry.timestamp < options.since) {
				continue;
			}

			entries.push(entry);
		} catch {
			// Skip malformed
		}
	}

	return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Get latest summary for a task
 */
export function getLatestTaskSummary(
	directory: string,
	taskId: string,
): MetaSummaryEntry | undefined {
	const summaries = querySummaries(directory, { taskId });
	return summaries.length > 0 ? summaries[summaries.length - 1] : undefined;
}
