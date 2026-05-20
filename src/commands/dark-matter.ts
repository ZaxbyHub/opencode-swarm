import path from 'node:path';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type { DarkMatterOptions } from '../tools/co-change-analyzer.js';
import {
	_internals as coChangeAnalyzer,
	darkMatterToKnowledgeEntries,
	formatDarkMatterOutput,
} from '../tools/co-change-analyzer.js';

/**
 * Handles /swarm dark-matter command.
 * Detects hidden couplings (files that co-change without explicit import relationships).
 */
export async function handleDarkMatterCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Parse optional --threshold and --min-commits flags
	const options: DarkMatterOptions = {};

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--threshold' && args[i + 1]) {
			const val = parseFloat(args[i + 1]);
			if (!Number.isNaN(val) && val >= 0 && val <= 1) {
				options.npmiThreshold = val;
			}
			i++;
		} else if (args[i] === '--min-commits' && args[i + 1]) {
			const val = parseInt(args[i + 1], 10);
			if (!Number.isNaN(val) && val > 0) {
				options.minCommits = val;
			}
			i++;
		}
	}

	let pairs: Awaited<ReturnType<typeof coChangeAnalyzer.detectDarkMatter>>;
	try {
		pairs = await coChangeAnalyzer.detectDarkMatter(directory, options);
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		return `## Dark Matter Analysis Failed\n\nError analyzing git history: ${errMsg}\n\nEnsure this is a git repository with commit history.`;
	}
	const output = formatDarkMatterOutput(pairs);

	// Persist dark matter findings as swarm knowledge entries
	if (pairs.length > 0) {
		try {
			const projectName = path.basename(path.resolve(directory));
			const entries = darkMatterToKnowledgeEntries(pairs, projectName);
			if (entries.length > 0) {
				const knowledgePath = resolveSwarmKnowledgePath(directory);
				for (const entry of entries) {
					await appendKnowledge(knowledgePath, entry);
				}
				return `${output}\n\n[${entries.length} dark matter finding(s) saved to .swarm/knowledge.jsonl]`;
			}
		} catch (err) {
			console.warn('dark-matter: failed to save knowledge entries:', err);
			return output;
		}
	}

	return output;
}
