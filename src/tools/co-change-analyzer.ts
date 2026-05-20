import * as child_process from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

/** Lazy-bind so mock.module can intercept at call time (#330). */
function getExecFileAsync() {
	return promisify(child_process.execFile);
}

export interface CoChangeEntry {
	fileA: string;
	fileB: string;
	coChangeCount: number;
	npmi: number;
	lift: number;
	hasStaticEdge: boolean;
	totalCommits: number;
	commitsA: number;
	commitsB: number;
}

export interface DarkMatterOptions {
	minCommits?: number;
	minCoChanges?: number;
	npmiThreshold?: number;
	maxCommitsToAnalyze?: number;
}

/**
 * Parses git log to extract commit -> files mapping.
 * Returns empty Map on timeout or error.
 */
export async function parseGitLog(
	directory: string,
	maxCommits: number,
): Promise<Map<string, Set<string>>> {
	// SECURITY: directory is passed from opencode session context (trusted).
	// Do not pass untrusted user input directly.
	const commitMap = new Map<string, Set<string>>();

	try {
		const { stdout } = await getExecFileAsync()(
			'git',
			[
				'log',
				'--name-only',
				'--pretty=format:COMMIT:%H',
				'--no-merges',
				`-n${maxCommits}`,
			],
			{ cwd: directory, timeout: 10_000 },
		);

		let currentCommit: string | null = null;

		for (const line of stdout.split('\n')) {
			if (line.startsWith('COMMIT:')) {
				currentCommit = line.slice(7);
				if (currentCommit && !commitMap.has(currentCommit)) {
					commitMap.set(currentCommit, new Set<string>());
				}
			} else if (currentCommit && line.trim()) {
				const filePath = line.trim();
				// Filter out unwanted paths
				if (
					filePath.startsWith('.swarm/') ||
					filePath.startsWith('node_modules/') ||
					filePath === ''
				) {
					continue;
				}
				commitMap.get(currentCommit)!.add(filePath);
			}
		}
	} catch {
		// Return empty Map on any error (timeout, exec error, etc.)
		return new Map();
	}

	return commitMap;
}

/**
 * Builds co-change matrix from commit -> files mapping.
 */
export function buildCoChangeMatrix(
	commitMap: Map<string, Set<string>>,
): Map<string, CoChangeEntry> {
	const matrix = new Map<string, CoChangeEntry>();
	const fileCommitCount = new Map<string, number>();

	// Count co-changes
	for (const files of commitMap.values()) {
		const fileArray = Array.from(files).sort();

		// Update individual file commit counts
		for (const file of fileArray) {
			fileCommitCount.set(file, (fileCommitCount.get(file) || 0) + 1);
		}

		// Process all pairs
		for (let i = 0; i < fileArray.length; i++) {
			for (let j = i + 1; j < fileArray.length; j++) {
				const fileA = fileArray[i];
				const fileB = fileArray[j];

				// Create canonical key (lexicographically sorted)
				const [key, a, b] =
					fileA < fileB
						? [`${fileA}::${fileB}`, fileA, fileB]
						: [`${fileB}::${fileA}`, fileB, fileA];

				const existing = matrix.get(key);
				if (existing) {
					existing.coChangeCount++;
				} else {
					matrix.set(key, {
						fileA: a,
						fileB: b,
						coChangeCount: 1,
						npmi: 0,
						lift: 0,
						hasStaticEdge: false,
						totalCommits: 0,
						commitsA: 0,
						commitsB: 0,
					});
				}
			}
		}
	}

	const totalCommits = commitMap.size;

	// Compute NPMI and lift for each pair
	for (const entry of matrix.values()) {
		// Skip if too few co-changes
		if (entry.coChangeCount < 3) {
			continue;
		}

		const pAB = entry.coChangeCount / totalCommits;
		const pA = (fileCommitCount.get(entry.fileA) || 0) / totalCommits;
		const pB = (fileCommitCount.get(entry.fileB) || 0) / totalCommits;

		entry.commitsA = fileCommitCount.get(entry.fileA) || 0;
		entry.commitsB = fileCommitCount.get(entry.fileB) || 0;
		entry.totalCommits = totalCommits;

		// Compute lift
		if (pA > 0 && pB > 0) {
			entry.lift = pAB / (pA * pB);
		}

		// Compute NPMI
		if (pAB > 0) {
			const logPAB = Math.log(pAB);
			const negLogPAB = -logPAB;

			if (negLogPAB > 0) {
				const numerator = logPAB - Math.log(pA * pB);
				entry.npmi = numerator / negLogPAB;
				// Clamp to [-1, 1]
				entry.npmi = Math.max(-1, Math.min(1, entry.npmi));
			} else {
				// pAB = 1.0
				entry.npmi = 1.0;
			}
		}
	}

	return matrix;
}

/**
 * Recursively scans directory for source files.
 */
async function scanSourceFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	const skipDirs = new Set(['node_modules', '.swarm', 'dist', 'build']);

	try {
		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name)) {
					continue;
				}
				const subFiles = await scanSourceFiles(fullPath);
				results.push(...subFiles);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name);
				if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
					results.push(fullPath);
				}
			}
		}
	} catch {
		// Skip on error
	}

	return results;
}

/**
 * Detects static import edges between files.
 */
export async function getStaticEdges(directory: string): Promise<Set<string>> {
	const edges = new Set<string>();

	const sourceFiles = await scanSourceFiles(directory);

	for (const sourceFile of sourceFiles) {
		try {
			const content = await readFile(sourceFile, 'utf-8');
			const importRegex =
				/(?:import|require)\s*(?:\(?\s*['"`]|.*?from\s+['"`])([^'"`]+)['"`]/g;

			for (
				let match = importRegex.exec(content);
				match !== null;
				match = importRegex.exec(content)
			) {
				const importPath = match[1].trim();

				// Skip node_modules imports
				if (!importPath.startsWith('.')) {
					continue;
				}

				try {
					const sourceDir = path.dirname(sourceFile);
					const resolvedPath = path.resolve(sourceDir, importPath);

					// Try various extensions
					const extensions = [
						'',
						'.ts',
						'.tsx',
						'.js',
						'.jsx',
						'.mjs',
						'/index.ts',
						'/index.js',
					];
					let targetFile: string | null = null;

					for (const ext of extensions) {
						const testPath = resolvedPath + ext;
						try {
							const testStat = await stat(testPath);
							if (testStat.isFile()) {
								targetFile = testPath;
								break;
							}
						} catch {
							// Continue to next extension
						}
					}

					if (!targetFile) {
						continue;
					}

					// Make paths relative to directory (normalize Windows separators)
					const relSource = path
						.relative(directory, sourceFile)
						.replace(/\\/g, '/');
					const relTarget = path
						.relative(directory, targetFile)
						.replace(/\\/g, '/');

					// Create canonical edge key (lexicographically sorted)
					const [key] =
						relSource < relTarget
							? [`${relSource}::${relTarget}`, relSource, relTarget]
							: [`${relTarget}::${relSource}`, relTarget, relSource];

					edges.add(key);
				} catch {
					// Skip on resolution error
				}
			}
		} catch {
			// Skip on read error
		}
	}

	return edges;
}

/**
 * Checks if a file pair is a test↔implementation pair.
 */
function isTestImplementationPair(fileA: string, fileB: string): boolean {
	const testPatterns = ['.test.ts', '.test.js', '.spec.ts', '.spec.js'];

	const getBaseName = (filePath: string): string => {
		const base = path.basename(filePath);
		for (const pattern of testPatterns) {
			if (base.endsWith(pattern)) {
				return base.slice(0, -pattern.length);
			}
		}
		return base.replace(/\.(ts|js|tsx|jsx|mjs)$/, '');
	};

	const baseA = getBaseName(fileA);
	const baseB = getBaseName(fileB);

	return (
		baseA === baseB &&
		baseA !== path.basename(fileA) &&
		baseA !== path.basename(fileB)
	);
}

/**
 * Checks if two files in the same directory share a prefix.
 */
function hasSharedPrefix(fileA: string, fileB: string): boolean {
	const dirA = path.dirname(fileA);
	const dirB = path.dirname(fileB);

	if (dirA !== dirB) {
		return false;
	}

	const baseA = path.basename(fileA).replace(/\.(ts|js|tsx|jsx|mjs)$/, '');
	const baseB = path.basename(fileB).replace(/\.(ts|js|tsx|jsx|mjs)$/, '');

	// Check if one is prefix of other
	if (baseA.startsWith(baseB) || baseB.startsWith(baseA)) {
		return true;
	}

	// Check first segment when split by - or _
	const splitA = baseA.split(/-|_/);
	const splitB = baseB.split(/-|_/);

	if (splitA.length > 0 && splitB.length > 0 && splitA[0] === splitB[0]) {
		return true;
	}

	return false;
}

/**
 * Main entry point: detects dark matter (hidden couplings).
 */
export async function detectDarkMatter(
	directory: string,
	options?: DarkMatterOptions,
): Promise<CoChangeEntry[]> {
	const minCommits = options?.minCommits ?? 20;
	const minCoChanges = options?.minCoChanges ?? 3;
	const npmiThreshold = options?.npmiThreshold ?? 0.5;
	const maxCommitsToAnalyze = options?.maxCommitsToAnalyze ?? 500;

	// Check total commits
	try {
		const { stdout } = await getExecFileAsync()(
			'git',
			['rev-list', '--count', 'HEAD'],
			{
				cwd: directory,
				timeout: 10_000,
			},
		);
		const totalCommitCount = parseInt(stdout.trim(), 10);

		if (Number.isNaN(totalCommitCount) || totalCommitCount < minCommits) {
			return [];
		}
	} catch {
		return [];
	}

	// Parse git log and build matrix
	const commitMap = await _internals.parseGitLog(
		directory,
		maxCommitsToAnalyze,
	);
	const matrix = _internals.buildCoChangeMatrix(commitMap);

	// Get static edges
	const staticEdges = await _internals.getStaticEdges(directory);

	// Filter and annotate entries
	const results: CoChangeEntry[] = [];

	for (const entry of matrix.values()) {
		const key = `${entry.fileA}::${entry.fileB}`;
		entry.hasStaticEdge = staticEdges.has(key);

		// Apply filters (ordered by computational cost: count check first)
		if (entry.coChangeCount < minCoChanges) continue;
		if (entry.npmi < npmiThreshold) continue;
		if (entry.hasStaticEdge) continue;
		if (isTestImplementationPair(entry.fileA, entry.fileB)) continue;
		if (hasSharedPrefix(entry.fileA, entry.fileB)) continue;

		results.push(entry);
	}

	// Sort by NPMI descending and return top 20
	results.sort((a, b) => b.npmi - a.npmi);
	return results.slice(0, 20);
}

/**
 * Converts dark matter findings to knowledge entries.
 */
export function darkMatterToKnowledgeEntries(
	pairs: CoChangeEntry[],
	projectName: string,
): SwarmKnowledgeEntry[] {
	const entries: SwarmKnowledgeEntry[] = [];
	const now = new Date().toISOString();

	for (const pair of pairs.slice(0, 10)) {
		const baseA = path.basename(pair.fileA);
		const baseB = path.basename(pair.fileB);

		let lesson = `Files ${pair.fileA} and ${pair.fileB} co-change with NPMI=${pair.npmi.toFixed(3)} but have no import relationship. This hidden coupling suggests a shared architectural concern — changes to one likely require changes to the other.`;

		// Truncate if too long
		if (lesson.length > 280) {
			lesson = `Files ${baseA} and ${baseB} co-change with NPMI=${pair.npmi.toFixed(3)} but have no import relationship. This hidden coupling suggests a shared architectural concern — changes to one likely require changes to the other.`;
		}

		// Further truncate if still too long
		if (lesson.length > 280) {
			lesson = `Files ${baseA} and ${baseB} co-change frequently (NPMI=${pair.npmi.toFixed(3)}) without import relationship. This hidden coupling suggests a shared architectural concern.`;
		}

		// Ultimate fallback for extremely long basenames
		if (lesson.length > 280) {
			lesson = `Hidden coupling: ${baseA.slice(0, 50)}... ↔ ${baseB.slice(0, 50)}... (NPMI=${pair.npmi.toFixed(3)})`;
		}

		const confidence = Math.min(
			0.3 + 0.2 * Math.min(pair.coChangeCount / 10, 1),
			0.5,
		);

		entries.push({
			id: randomUUID(),
			tier: 'swarm',
			lesson,
			category: 'architecture',
			tags: ['hidden-coupling', 'co-change', 'dark-matter'],
			scope: 'global',
			confidence,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: now,
			updated_at: now,
			auto_generated: true,
			project_name: projectName,
		});
	}

	return entries;
}

/**
 * Formats dark matter findings as markdown output.
 */
export function formatDarkMatterOutput(pairs: CoChangeEntry[]): string {
	if (pairs.length === 0) {
		return `## Dark Matter: Hidden Couplings

No hidden couplings detected. Either the repository has fewer than 20 commits, or all frequently co-changing files have explicit import relationships.`;
	}

	const rows = pairs
		.map(
			(p) =>
				`| ${p.fileA} | ${p.fileB} | ${p.npmi.toFixed(3)} | ${p.coChangeCount} | ${p.lift.toFixed(2)} |`,
		)
		.join('\n');

	return `## Dark Matter: Hidden Couplings

Found ${pairs.length} file pairs that frequently co-change but have no import relationship:

| File A | File B | NPMI | Co-Changes | Lift |
|--------|--------|------|------------|------|
${rows}

These pairs likely share an architectural concern invisible to static analysis.
Consider adding explicit documentation or extracting the shared concern.`;
}

// ============ Tool Definition ============
export const co_change_analyzer: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Detects hidden couplings (dark matter) by analyzing git history to find file pairs that frequently co-change but have no import relationship. Useful for identifying architectural concerns that are not explicitly documented.',
	args: {
		min_commits: z
			.number()
			.optional()
			.describe('Minimum commit count to analyze (default: 20)'),
		min_co_changes: z
			.number()
			.optional()
			.describe('Minimum co-change count to consider (default: 3)'),
		threshold: z
			.number()
			.optional()
			.describe('NPMI threshold for filtering (default: 0.5)'),
		max_commits: z
			.number()
			.optional()
			.describe('Maximum commits to analyze (default: 500)'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Safe args extraction
		let minCommits: number | undefined;
		let minCoChanges: number | undefined;
		let npmiThreshold: number | undefined;
		let maxCommitsToAnalyze: number | undefined;
		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				minCommits =
					typeof obj.min_commits === 'number' ? obj.min_commits : undefined;
				minCoChanges =
					typeof obj.min_co_changes === 'number'
						? obj.min_co_changes
						: undefined;
				npmiThreshold =
					typeof obj.threshold === 'number' ? obj.threshold : undefined;
				maxCommitsToAnalyze =
					typeof obj.max_commits === 'number' ? obj.max_commits : undefined;
			}
		} catch {
			// Malicious getter threw
		}

		const options: DarkMatterOptions = {
			minCommits,
			minCoChanges,
			npmiThreshold,
			maxCommitsToAnalyze,
		};

		const pairs = await _internals.detectDarkMatter(directory, options);
		return _internals.formatDarkMatterOutput(pairs);
	},
});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	parseGitLog: typeof parseGitLog;
	buildCoChangeMatrix: typeof buildCoChangeMatrix;
	getStaticEdges: typeof getStaticEdges;
	detectDarkMatter: typeof detectDarkMatter;
	darkMatterToKnowledgeEntries: typeof darkMatterToKnowledgeEntries;
	formatDarkMatterOutput: typeof formatDarkMatterOutput;
} = {
	parseGitLog,
	buildCoChangeMatrix,
	getStaticEdges,
	detectDarkMatter,
	darkMatterToKnowledgeEntries,
	formatDarkMatterOutput,
} as const;
