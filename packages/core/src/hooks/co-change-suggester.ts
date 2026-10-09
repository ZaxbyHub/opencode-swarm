/**
 * Co-Change Suggester Hook
 *
 * Analyzes file modifications and suggests co-change partners based on
 * historical co-change data from .swarm/co-change.json. This hook fires
 * after file-write tools complete and logs suggestions when co-change
 * partners are detected.
 */

import { log } from '../utils';
import { bunFile } from '../utils/bun-compat';
import { safeHook, validateSwarmPath } from './utils';

/**
 * Represents a single co-change entry from the JSON file
 */
export interface CoChangeJsonEntry {
	/** First file in the co-change pair */
	fileA: string;
	/** Second file in the co-change pair */
	fileB: string;
	/** Number of times these files were changed together */
	coChangeCount: number;
	/** Normalized Pointwise Mutual Information score (0-1) */
	npmi: number;
}

/**
 * Root structure of the co-change JSON file
 */
export interface CoChangeJson {
	/** File format version */
	version: string;
	/** ISO timestamp when the file was generated */
	generated: string;
	/** Array of co-change entries */
	entries: CoChangeJsonEntry[];
}

/**
 * Normalizes file path slashes for consistent comparison
 * @param filePath - The file path to normalize
 * @returns Normalized path with forward slashes
 */
function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

/**
 * Reads and parses the .swarm/co-change.json file
 * @param directory - The project directory containing .swarm folder
 * @returns Parsed CoChangeJson or null if not found/invalid
 */
export async function readCoChangeJson(
	directory: string,
): Promise<CoChangeJson | null> {
	try {
		const filePath = validateSwarmPath(directory, 'co-change.json');
		const content = await bunFile(filePath).text();
		const data = JSON.parse(content) as CoChangeJson;

		// Validate basic structure
		if (
			!data ||
			typeof data.version !== 'string' ||
			!Array.isArray(data.entries)
		) {
			return null;
		}

		// Deduplicate entries by creating a Set of normalized key pairs
		// This ensures we don't suggest the same pair multiple times
		const seen = new Set<string>();
		const dedupedEntries: CoChangeJsonEntry[] = [];

		for (const entry of data.entries) {
			// Skip invalid entries
			if (
				typeof entry.fileA !== 'string' ||
				typeof entry.fileB !== 'string' ||
				typeof entry.coChangeCount !== 'number' ||
				typeof entry.npmi !== 'number'
			) {
				continue;
			}

			// Create a normalized key for deduplication (alphabetical order)
			const normalizedA = normalizePath(entry.fileA);
			const normalizedB = normalizePath(entry.fileB);
			const key = [normalizedA, normalizedB].sort().join('|');

			if (!seen.has(key)) {
				seen.add(key);
				dedupedEntries.push(entry);
			}
		}

		return {
			...data,
			entries: dedupedEntries,
		};
	} catch {
		return null;
	}
}

/**
 * Finds co-change partners for a given file
 * @param entries - Array of co-change entries to search
 * @param filePath - The file path to find partners for
 * @returns Array of entries where the file appears as fileA or fileB
 */
export function getCoChangePartnersForFile(
	entries: CoChangeJsonEntry[],
	filePath: string,
): CoChangeJsonEntry[] {
	const normalizedTarget = normalizePath(filePath);

	return entries.filter((entry) => {
		const normalizedA = normalizePath(entry.fileA);
		const normalizedB = normalizePath(entry.fileB);
		return normalizedA === normalizedTarget || normalizedB === normalizedTarget;
	});
}

/**
 * Creates the co-change suggester hook
 * @param directory - The project directory containing .swarm folder
 * @returns A hook function that analyzes file writes for co-change suggestions
 */
export function createCoChangeSuggesterHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	/**
	 * Hook that fires after file-write tools complete
	 * Checks for co-change partners and logs suggestions
	 */
	const hook = async (input: unknown, _output: unknown): Promise<void> => {
		const record = input as Record<string, unknown>;
		const toolName = typeof record.tool === 'string' ? record.tool : '';

		// Only fire on file-write tools
		if (
			!['write', 'edit', 'apply_patch', 'patch', 'create_file'].includes(
				toolName,
			)
		) {
			return;
		}

		// Extract file path from input (try multiple field names)
		const toolInput = record.input as Record<string, unknown> | undefined;
		const filePath = (toolInput?.filePath ??
			toolInput?.file_path ??
			toolInput?.path) as string | undefined;
		if (!filePath) {
			return;
		}

		// Read co-change data
		const coChangeData = await readCoChangeJson(directory);
		if (!coChangeData) {
			return;
		}

		// Find co-change partners
		const partners = getCoChangePartnersForFile(coChangeData.entries, filePath);
		// Deduplication is already handled in readCoChangeJson, so we don't need
		// to check again here - each partner entry represents a unique file pair
		if (partners.length === 0) {
			return;
		}

		// Log suggestion - architect will see this in output
		const partnerList = partners
			.slice(0, 3) // Limit to top 3
			.map((e) => {
				const normalizedFilePath = normalizePath(filePath);
				const partner =
					normalizePath(e.fileA) === normalizedFilePath ? e.fileB : e.fileA;
				return `${partner} (co-change: ${e.coChangeCount}x, npmi: ${e.npmi.toFixed(2)})`;
			})
			.join(', ');

		log(
			`[CO-CHANGE] Files frequently modified with ${filePath}: ${partnerList}`,
		);
	};

	// Wrap in safeHook for fire-and-forget error suppression
	return safeHook(hook);
}
