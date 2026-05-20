import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { bunWrite } from '../utils/bun-compat';

/**
 * Summary ID validation regex: S followed by one or more digits
 * Pattern: ^S\d+$
 * Examples: S1, S2, S99, S123
 */
const SUMMARY_ID_REGEX = /^S\d+$/;

/**
 * Validate and sanitize summary ID.
 * Must match regex ^S\d+$ (e.g., S1, S2, S99)
 * Rejects: empty string, null bytes, control characters, path traversal, non-matching patterns
 * @throws Error with descriptive message on failure
 */
export function sanitizeSummaryId(id: string): string {
	// Check for empty string
	if (!id || id.length === 0) {
		throw new Error('Invalid summary ID: empty string');
	}

	// Check for null bytes
	if (/\0/.test(id)) {
		throw new Error('Invalid summary ID: contains null bytes');
	}

	// Check for control characters (char codes < 32)
	for (let i = 0; i < id.length; i++) {
		if (id.charCodeAt(i) < 32) {
			throw new Error('Invalid summary ID: contains control characters');
		}
	}

	// Check for path traversal patterns
	if (id.includes('..') || id.includes('../') || id.includes('..\\')) {
		throw new Error('Invalid summary ID: path traversal detected');
	}

	// Validate against regex
	if (!SUMMARY_ID_REGEX.test(id)) {
		throw new Error(
			`Invalid summary ID: must match pattern ^S\\d+$, got "${id}"`,
		);
	}

	return id;
}

/**
 * Interface for summary storage entry
 */
interface SummaryEntry {
	id: string;
	summaryText: string;
	fullOutput: string;
	timestamp: number;
	originalBytes: number;
}

/**
 * Store a summary entry to .swarm/summaries/{id}.json.
 * Performs atomic write via temp file + rename.
 * @throws Error if summary ID is invalid or size limit would be exceeded
 */
export async function storeSummary(
	directory: string,
	id: string,
	fullOutput: string,
	summaryText: string,
	maxStoredBytes: number,
): Promise<void> {
	// Validate summary ID
	const sanitizedId = sanitizeSummaryId(id);

	// Check size limit against the serialized JSON entry (not just raw input)
	// to ensure the wrapper doesn't push the total beyond maxStoredBytes
	const preCheckEntry: SummaryEntry = {
		id: sanitizedId,
		summaryText,
		fullOutput,
		timestamp: Date.now(),
		originalBytes: Buffer.byteLength(fullOutput, 'utf8'),
	};
	const serializedSize = Buffer.byteLength(
		JSON.stringify(preCheckEntry),
		'utf8',
	);
	if (serializedSize > maxStoredBytes) {
		throw new Error(
			`Summary entry size (${serializedSize} bytes) exceeds maximum (${maxStoredBytes} bytes)`,
		);
	}

	// Construct and validate path
	const relativePath = path.join('summaries', `${sanitizedId}.json`);
	const summaryPath = validateSwarmPath(directory, relativePath);
	const summaryDir = path.dirname(summaryPath);

	// Create summary entry
	const entry: SummaryEntry = {
		id: sanitizedId,
		summaryText,
		fullOutput,
		timestamp: Date.now(),
		originalBytes: Buffer.byteLength(fullOutput, 'utf8'),
	};

	// Serialize to JSON
	const entryJson = JSON.stringify(entry);

	// Create directory (recursive)
	mkdirSync(summaryDir, { recursive: true });

	// Write atomically: temp file + rename
	const tempPath = path.join(
		summaryDir,
		`${sanitizedId}.json.tmp.${Date.now()}.${process.pid}`,
	);
	try {
		await bunWrite(tempPath, entryJson);
		renameSync(tempPath, summaryPath);
	} catch (error) {
		// Clean up temp file on failure
		try {
			rmSync(tempPath, { force: true });
		} catch {}
		throw error;
	}
}

/**
 * Load fullOutput from a summary entry.
 * Returns null if file doesn't exist or validation fails.
 */
export async function loadFullOutput(
	directory: string,
	id: string,
): Promise<string | null> {
	// Validate summary ID
	const sanitizedId = sanitizeSummaryId(id);

	// Construct relative path
	const relativePath = path.join('summaries', `${sanitizedId}.json`);
	validateSwarmPath(directory, relativePath);

	// Read file
	const content = await readSwarmFileAsync(directory, relativePath);
	if (content === null) {
		return null;
	}

	// Parse and extract fullOutput
	try {
		const parsed = JSON.parse(content);
		if (typeof parsed.fullOutput === 'string') {
			return parsed.fullOutput;
		}
		warn(`Summary entry ${sanitizedId} missing valid fullOutput field`);
		return null;
	} catch (error) {
		warn(
			`Summary entry validation failed for ${sanitizedId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * List all summary IDs that have summary entries.
 * Returns sorted array of valid summary IDs.
 * Returns empty array if summaries directory doesn't exist.
 */
export async function listSummaries(directory: string): Promise<string[]> {
	// Validate summaries base directory path
	const summariesBasePath = validateSwarmPath(directory, 'summaries');

	// Check if directory exists
	try {
		statSync(summariesBasePath);
	} catch {
		return [];
	}

	// Read directory entries
	let entries: string[];
	try {
		entries = readdirSync(summariesBasePath);
	} catch {
		return [];
	}

	// Filter to only valid summary ID files (.json)
	const summaryIds: string[] = [];
	for (const entry of entries) {
		// Only process .json files
		if (!entry.endsWith('.json')) {
			continue;
		}

		// Extract ID from filename (remove .json extension)
		const summaryId = entry.slice(0, -5);

		try {
			// Validate as summary ID
			sanitizeSummaryId(summaryId);
			summaryIds.push(summaryId);
		} catch (error) {
			// Only log unexpected errors (not invalid summary ID names)
			if (
				error instanceof Error &&
				!error.message.startsWith('Invalid summary ID')
			) {
				warn(`Error reading summary entry '${entry}': ${error.message}`);
			}
		}
	}

	// Return sorted
	return summaryIds.sort();
}

/**
 * Delete summaries older than retentionDays.
 * Returns array of deleted summary IDs.
 */
export async function cleanupSummaries(
	directory: string,
	retentionDays: number,
): Promise<string[]> {
	const summaryIds = await listSummaries(directory);
	const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

	const deleted: string[] = [];

	for (const id of summaryIds) {
		// Construct and validate path
		const relativePath = path.join('summaries', `${id}.json`);
		const summaryPath = validateSwarmPath(directory, relativePath);

		// Read the summary to check timestamp
		const content = await readSwarmFileAsync(directory, relativePath);
		if (content === null) {
			continue;
		}

		try {
			const parsed = JSON.parse(content);
			const timestamp = parsed.timestamp as number;

			// Delete if older than cutoff
			if (timestamp < cutoffTime) {
				rmSync(summaryPath);
				deleted.push(id);
			}
		} catch (error) {
			warn(
				`Failed to cleanup summary ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return deleted;
}
