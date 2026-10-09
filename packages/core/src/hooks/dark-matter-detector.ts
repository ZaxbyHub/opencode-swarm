/**
 * Dark Matter Detector Hook
 *
 * This hook reads `.swarm/dark-matter.md` — a markdown file that lists
 * unresolved coupling gaps. When unconsumed items exist in this file,
 * the hook logs a reminder hint to the user.
 */

import { log } from '../utils';
import { bunFile } from '../utils/bun-compat';
import { safeHook, validateSwarmPath } from './utils';

/**
 * Parses dark matter gaps from markdown content
 *
 * @param content - The markdown content to parse
 * @returns Object containing arrays of unresolved and resolved gap descriptions
 */
export function parseDarkMatterGaps(content: string): {
	unresolved: string[];
	resolved: string[];
} {
	const unresolved: string[] = [];
	const resolved: string[] = [];

	const lines = content.split('\n');
	for (const line of lines) {
		// Match unresolved items: "- [ ] description"
		const unresolvedMatch = line.match(/^-\s+\[\s*\]\s*(.+)$/);
		if (unresolvedMatch) {
			unresolved.push(unresolvedMatch[1].trim());
			continue;
		}

		// Match resolved items: "- [x] description"
		const resolvedMatch = line.match(/^-\s+\[x\]\s*(.+)$/i);
		if (resolvedMatch) {
			resolved.push(resolvedMatch[1].trim());
		}
	}

	return { unresolved, resolved };
}

/**
 * Reads and parses the dark matter gaps file
 *
 * @param directory - The project directory containing .swarm folder
 * @returns Object with unresolved and resolved gaps, or null if file not found/empty
 */
export async function readDarkMatterMd(
	directory: string,
): Promise<{ unresolved: string[]; resolved: string[] } | null> {
	const filePath = validateSwarmPath(directory, 'dark-matter.md');

	const file = bunFile(filePath);

	try {
		const content = await file.text();

		// Return null if file is empty or only whitespace
		if (!content || !content.trim()) {
			return null;
		}

		return parseDarkMatterGaps(content);
	} catch {
		// File doesn't exist or read error - return null
		return null;
	}
}

/**
 * Creates the dark matter detector hook
 *
 * This hook fires on `toolAfter` and checks for unresolved coupling gaps
 * in `.swarm/dark-matter.md`. It logs a reminder hint when gaps exist,
 * with rate-limiting to avoid excessive file I/O.
 *
 * @param directory - The project directory containing .swarm folder
 * @returns Hook function that checks for unresolved dark matter gaps
 */
export function createDarkMatterDetectorHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	/**
	 * Instance-scoped counter for rate-limiting hook executions
	 */
	let callCount = 0;

	async function hook(_input: unknown, _output: unknown): Promise<void> {
		// Rate-limit: only check every 10 tool calls to avoid excessive file I/O
		callCount++;

		if (callCount % 10 !== 0) {
			return;
		}

		const gaps = await readDarkMatterMd(directory);

		// If file doesn't exist or has no unresolved gaps, do nothing
		if (!gaps || gaps.unresolved.length === 0) {
			return;
		}

		const count = gaps.unresolved.length;

		// Log the main reminder message
		log(
			`[DARK-MATTER] ${count} unresolved coupling gap(s) in .swarm/dark-matter.md. Run /swarm dark-matter to review.`,
		);

		// Log up to 3 individual gaps, plus a "and N more" suffix for large lists
		const displayGaps = gaps.unresolved.slice(0, 3);
		for (const description of displayGaps) {
			log(`  - ${description}`);
		}
		if (count > 3) {
			log(`  - ... and ${count - 3} more`);
		}
	}

	return safeHook(hook);
}
